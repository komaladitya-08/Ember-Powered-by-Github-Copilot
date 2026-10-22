/**
 * How the macOS AX provider reads and acts, over AxApi: one batched attribute read per element (NODE_ATTRS, never
 * AXValue) turned into the host's RawNode facts; AXValue read with a second call only for the roles that carry one,
 * and never for a secure text field; action names read only where the host lists them; children read by range; and
 * the walk of a window within its budgets: at most three round trips per element (so a 300-control Chromium page fits
 * the host's 1.5 s read), the deadline checked before every call, and elements that don't show marked offscreen by
 * clipping them to the window and every scroll area around them (AX has no "showing" state, and what doesn't show is
 * never listed: hidden text is a prompt-injection channel). An app that answers kAXErrorCannotComplete (it didn't
 * answer within the messaging timeout) is remembered as busy for 5 s, during which every call for it fails at once,
 * as the Python sidecar remembers a hung app; other apps keep answering.
 *
 * Roles are never mapped here (roles.ts's axRole does it, from the platform role and these facts); this module only
 * says which AX roles carry a value, hold children worth walking, or take which action. Pure over AxApi: every
 * function is unit-tested on Linux against a fake tree.
 */

import { ProviderError, type PerformOp, type ProviderErrorCode, type RawNode, type Rect, type TextInfo } from "../provider";
import { INTERACTIVE_ROLES, LAZY_ACTION_ROLES, TEXT_ROLES, axRole, childContext, type RoleContext } from "../roles";
import { AX_ERROR, axErrorName } from "../../main/platform/darwin/ax";
import { isAxError, type AxApi, type AxError, type AxRef, type AxValue } from "./ax-darwin-api";

/**
 * The attributes read for every element, in one AXUIElementCopyMultipleAttributeValues round trip: never AXValue, nor
 * anything else that tells of a field's contents (its length, its selection), since the role that says whether it is
 * a secure field comes in the same answer.
 */
export const NODE_ATTRS: readonly string[] = [
  "AXRole", "AXSubrole", "AXTitle", "AXDescription", "AXHelp", "AXPlaceholderValue", "AXEnabled", "AXFocused",
  "AXSelected", "AXExpanded", "AXDisclosing", "AXPosition", "AXSize", "AXTitleUIElement", "AXMinValue", "AXMaxValue",
  "AXValueIncrement", "AXModal", "AXHidden", "AXMenuItemMarkChar", "AXRowCount", "AXColumnCount", "AXRowIndexRange",
  "AXColumnIndexRange", "AXIdentifier",
];
/** The attributes read for a top-level window (one round trip each). */
export const WINDOW_ATTRS: readonly string[] = ["AXRole", "AXSubrole", "AXTitle", "AXPosition", "AXSize", "AXModal", "AXMain", "AXMinimized"];
/** What a hit test reads of each element of its chain: its facts and its parent, in the same round trip. */
export const CHAIN_ATTRS: readonly string[] = [...NODE_ATTRS, "AXParent"];

/** The messaging timeout (design C13) in milliseconds: how long one call may take before the app counts as busy. */
export const AX_TIMEOUT_MS = 800;
/** How long an app that didn't answer is left alone (every call for it fails as busy at once meanwhile). */
export const BUSY_MS = 5000;
/** Round trips a walk spends on one element at most: its batch, its children, and its value or its actions. */
export const MAX_TRIPS = 3;
/** Characters of a value, a name or a text a read keeps (RawNode.value is cut there). */
export const TEXT_MAX = 2000;
/** Children of one element a walk reads at most (as the Python sidecar's MAX_CHILDREN): more is cut "nodes". */
export const MAX_CHILDREN = 200;
/** Levels a hit test climbs from the element at the point to its window. */
export const CHAIN_MAX = 40;
/** Steps a range is moved by AXIncrement/AXDecrement at most when its value can't be set. */
const RANGE_STEPS = 100;

/** What every call says when Ember lacks the Accessibility permission. */
export const NEEDS_PERMISSION = "Ember needs the Accessibility permission (System Settings › Privacy & Security › Accessibility).";

/** Roles whose AXValue says something Ember uses (their text, state or number): read with a second call. */
export const VALUE_ROLES: ReadonlySet<string> = new Set([
  "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXPopUpButton", "AXCheckBox", "AXRadioButton", "AXSlider",
  "AXIncrementor", "AXStepper", "AXStaticText", "AXCell", "AXDisclosureTriangle", "AXProgressIndicator", "AXLevelIndicator",
  "AXRelevanceIndicator", "AXDateField", "AXTimeField",
]);
/**
 * Roles whose children a walk doesn't read: their contents is their value (a text field, a text area, a label) or
 * nothing Ember lists (a slider's thumb, a scroll bar's arrows, a stepper's buttons).
 */
export const LEAF_ROLES: ReadonlySet<string> = new Set([
  "AXStaticText", "AXTextField", "AXTextArea", "AXSearchField", "AXImage", "AXSlider", "AXIncrementor", "AXStepper",
  "AXCheckBox", "AXRadioButton", "AXProgressIndicator", "AXBusyIndicator", "AXLevelIndicator", "AXRelevanceIndicator",
  "AXValueIndicator", "AXSplitter", "AXColorWell", "AXDisclosureTriangle", "AXScrollBar", "AXSecureTextField",
]);
/** Fields whose AXValue is their text, which Ember may set (never a secure one). */
const ENTRY_ROLES: ReadonlySet<string> = new Set(["AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXDateField", "AXTimeField"]);
/** Controls that hold a number Ember may set (setRange). */
const RANGE_ROLES: ReadonlySet<string> = new Set(["AXSlider", "AXIncrementor", "AXStepper"]);
/** Indicators whose numeric AXValue is a level to read, never set. */
const LEVEL_ROLES: ReadonlySet<string> = new Set(["AXProgressIndicator", "AXLevelIndicator", "AXRelevanceIndicator"]);
/** Controls whose AXPress does what they are for, where their action names weren't read. */
const PRESS_ROLES: ReadonlySet<string> = new Set(["AXButton", "AXMenuButton", "AXLink", "AXMenuItem", "AXMenuBarItem", "AXColorWell"]);
/** Drop-downs whose menu opens with AXShowMenu (or AXPress): their "expand". */
const MENU_OPENERS: ReadonlySet<string> = new Set(["AXPopUpButton", "AXComboBox"]);
/** Containers that choose among their children (the host looks for a row's list among these). */
const CHOOSER_ROLES: ReadonlySet<string> = new Set(["AXList", "AXTable", "AXOutline", "AXGrid"]);
/**
 * Roles that take the keyboard when they say AXFocused (static text, images and groups often say it too, but setting
 * it does nothing there; a row's list takes the keyboard, not the row).
 */
const FOCUSABLE_ROLES: ReadonlySet<string> = new Set([
  "AXTextField", "AXTextArea", "AXSearchField", "AXComboBox", "AXPopUpButton", "AXButton", "AXMenuButton", "AXCheckBox",
  "AXRadioButton", "AXSlider", "AXIncrementor", "AXStepper", "AXList", "AXTable", "AXOutline", "AXGrid", "AXLink", "AXWebArea",
  "AXTabGroup", "AXDisclosureTriangle", "AXColorWell", "AXDateField", "AXTimeField",
]);
/** Where a table's or a list's children come from, in order: the rows that show, then all of them. */
const CHILDREN_OF: Readonly<Record<string, readonly string[]>> = {
  AXTable: ["AXVisibleRows", "AXChildren"],
  AXOutline: ["AXVisibleRows", "AXChildren"],
  AXList: ["AXVisibleChildren", "AXChildren"],
};

/** A note for the host's log: events and counts, never screen text. */
export type Note = (event: string, fields?: Record<string, unknown>) => void;

/** One element's facts from its batch (see NODE_ATTRS); element references in it are owned (release them). */
export interface Facts {
  role: string;
  subrole: string;
  /**
   * AXSubrole couldn't be read (its slot failed, rather than being absent): a text field's may be a secure field's, so
   * it is taken as one (isSecure).
   */
  subroleUnknown?: boolean;
  title: string;
  description: string;
  help: string;
  placeholder: string;
  enabled?: boolean;
  focused?: boolean;
  /** It says AXFocused at all (true or false): it may take the keyboard. */
  hasFocused: boolean;
  selected?: boolean;
  expanded?: boolean;
  disclosing?: boolean;
  frame: Rect | null;
  /** AXTitleUIElement (owned), the element that labels it. */
  titleElement: AxRef | null;
  min?: number;
  max?: number;
  step?: number;
  modal?: boolean;
  hidden: boolean;
  /** AXMenuItemMarkChar: a menu item's check mark. */
  mark: string;
  rows?: number;
  columns?: number;
  rowIndex?: number;
  columnIndex?: number;
  /** AXParent (owned), when it was asked for (a hit test's chain). */
  parent: AxRef | null;
  /** Windows: AXMain and AXMinimized. */
  main?: boolean;
  minimized?: boolean;
}

/** What may be set on an element, as asked of it (element() and perform(), where one element is involved). */
export interface Settable { value?: boolean; focused?: boolean; selected?: boolean; expanded?: boolean; disclosing?: boolean }

/** The facts of a node the host gets, before the provider gives it a handle, a key and its place in an answer. */
export type NodeBody = Omit<RawNode, "handle" | "key" | "parent" | "depth">;

const str = (v: AxValue | AxError | undefined): string => (typeof v === "string" ? v : "");
const bool = (v: AxValue | AxError | undefined): boolean | undefined =>
  typeof v === "boolean" ? v : typeof v === "number" && Number.isFinite(v) ? v !== 0 : undefined;
const num = (v: AxValue | AxError | undefined): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const isRef = (v: AxValue | AxError | undefined): v is AxRef => typeof v === "bigint";

/** Releases every element reference in a value (arrays included). */
export function releaseValue(api: Pick<AxApi, "release">, v: AxValue | AxError | undefined): void {
  if (typeof v === "bigint") api.release(v);
  else if (Array.isArray(v)) for (const x of v) releaseValue(api, x);
}

/**
 * Is this a secure text field (whose value is never read, set or reported)? A text field whose subrole couldn't be
 * read counts as one: fail closed.
 */
export const isSecure = (f: Pick<Facts, "role" | "subrole" | "subroleUnknown">): boolean =>
  f.subrole === "AXSecureTextField" || f.role === "AXSecureTextField" || (f.subroleUnknown === true && f.role === "AXTextField");

/**
 * Did an AXSubrole slot fail rather than say "absent" (NoValue, AttributeUnsupported, kCFNull)? Then whether it is a
 * secure field can't be told (see Facts.subroleUnknown).
 */
export const unreadSubrole = (v: AxValue | AxError | undefined): boolean =>
  v !== undefined && typeof v !== "string" && !(isAxError(v) && errorCode(v.axError) !== "failed");

/** A toggle: a check box, a disclosure triangle, or a button that says it toggles or switches. */
const isToggle = (f: Pick<Facts, "role" | "subrole">): boolean =>
  f.role === "AXCheckBox" || f.role === "AXDisclosureTriangle" || (f.role === "AXButton" && (f.subrole === "AXToggle" || f.subrole === "AXSwitch"));

/** Does a walk read this element's AXValue? Only for value roles, never for a secure field. */
export const readsValue = (f: Pick<Facts, "role" | "subrole" | "subroleUnknown">): boolean => VALUE_ROLES.has(f.role) && !isSecure(f);

/** The rectangle of AXPosition and AXSize, or null when either is missing. */
function frameOf(pos: AxValue | AxError | undefined, size: AxValue | AxError | undefined): Rect | null {
  if (typeof pos !== "object" || typeof size !== "object" || Array.isArray(pos) || Array.isArray(size) || isAxError(pos) || isAxError(size)) return null;
  if (pos.type !== "point" || size.type !== "size") return null;
  return { x: pos.x, y: pos.y, width: size.width, height: size.height };
}

/** The location of a CFRange attribute (a cell's row or column). */
function locationOf(v: AxValue | AxError | undefined): number | undefined {
  return typeof v === "object" && !Array.isArray(v) && !isAxError(v) && v.type === "range" && Number.isFinite(v.location) ? v.location : undefined;
}

/**
 * The facts of a batch. The element references in it are taken: AXTitleUIElement and AXParent are kept in the facts
 * (the caller's to release), any other is released here.
 */
export function factsOf(api: Pick<AxApi, "release">, m: ReadonlyMap<string, AxValue | AxError>): Facts {
  const get = (k: string) => m.get(k);
  const keep = (k: string): AxRef | null => {
    const v = get(k);
    return isRef(v) ? v : null;
  };
  // Only a single element is kept from the two element attributes; anything else holding references goes back.
  for (const [k, v] of m) if (!((k === "AXTitleUIElement" || k === "AXParent") && isRef(v))) releaseValue(api, v);
  const f: Facts = {
    role: str(get("AXRole")),
    subrole: str(get("AXSubrole")),
    ...(unreadSubrole(get("AXSubrole")) ? { subroleUnknown: true } : {}),
    title: str(get("AXTitle")),
    description: str(get("AXDescription")),
    help: str(get("AXHelp")),
    placeholder: str(get("AXPlaceholderValue")),
    hasFocused: typeof get("AXFocused") === "boolean" || typeof get("AXFocused") === "number",
    frame: frameOf(get("AXPosition"), get("AXSize")),
    titleElement: keep("AXTitleUIElement"),
    hidden: bool(get("AXHidden")) === true,
    mark: str(get("AXMenuItemMarkChar")),
    parent: keep("AXParent"),
  };
  const set = <K extends keyof Facts>(k: K, v: Facts[K] | undefined) => { if (v !== undefined) f[k] = v; };
  set("enabled", bool(get("AXEnabled")));
  set("focused", bool(get("AXFocused")));
  set("selected", bool(get("AXSelected")));
  set("expanded", bool(get("AXExpanded")));
  set("disclosing", bool(get("AXDisclosing")));
  set("min", num(get("AXMinValue")));
  set("max", num(get("AXMaxValue")));
  set("step", num(get("AXValueIncrement")));
  set("modal", bool(get("AXModal")));
  set("rows", num(get("AXRowCount")));
  set("columns", num(get("AXColumnCount")));
  set("rowIndex", locationOf(get("AXRowIndexRange")));
  set("columnIndex", locationOf(get("AXColumnIndexRange")));
  set("main", bool(get("AXMain")));
  set("minimized", bool(get("AXMinimized")));
  return f;
}

/** Lets go of the references a facts object holds. */
export function releaseFacts(api: Pick<AxApi, "release">, f: Facts): void {
  if (f.titleElement) api.release(f.titleElement);
  if (f.parent) api.release(f.parent);
  f.titleElement = null;
  f.parent = null;
}

/**
 * An AXError as the host's error code, or null for "the attribute isn't there" (kAXErrorNoValue). The mapping of
 * design §5.3: CannotComplete busy, InvalidUIElement gone, APIDisabled denied, the three "unsupported" errors
 * unsupported, anything else failed.
 */
export function errorCode(code: number): ProviderErrorCode | null {
  switch (code) {
    case AX_ERROR.cannotComplete: return "busy";
    case AX_ERROR.invalidUIElement: return "gone";
    case AX_ERROR.apiDisabled: return "denied";
    case AX_ERROR.attributeUnsupported: case AX_ERROR.actionUnsupported: case AX_ERROR.notImplemented: return "unsupported";
    case AX_ERROR.noValue: return null;
    default: return "failed";
  }
}

/** Errors that end what a call was doing whatever it was (the app, the element or the permission). */
const FATAL: ReadonlySet<ProviderErrorCode> = new Set(["busy", "gone", "denied"]);

/** Apps that didn't answer in time, each left alone for BUSY_MS. */
export class BusyApps {
  private until = new Map<number, number>();

  constructor(private now: () => number = Date.now, readonly ms = BUSY_MS) {}

  /** Is app `pid` still left alone? */
  isBusy(pid: number): boolean {
    const t = this.until.get(pid);
    if (t === undefined) return false;
    if (this.now() < t) return true;
    this.until.delete(pid);
    return false;
  }

  /** App `pid` didn't answer: leave it alone for a while. */
  mark(pid: number): void {
    this.until.set(pid, this.now() + this.ms);
  }
}

/** The error for an app that is (still) busy. */
export const busyError = (pid: number): ProviderError => new ProviderError("busy", `the app (pid ${pid}) didn't answer in time`);

/**
 * The calls made for one app in one request: each AX error mapped (design §5.3), a CannotComplete remembered as busy,
 * and every round trip counted. Constructed for a pid that is busy, it fails at once.
 */
export class AxSession {
  /** Round trips made so far. */
  calls = 0;

  constructor(readonly api: AxApi, readonly pid: number, readonly busy: BusyApps, private readonly note: Note = () => undefined) {
    if (busy.isBusy(pid)) throw busyError(pid);
  }

  /**
   * Fails for an AX error: busy (the app is remembered as busy, unless `remember` is false), gone, denied, unsupported
   * or failed, with words the host can pass on.
   */
  raise(code: number, what: string, remember = true): never {
    const c = errorCode(code) ?? "unsupported";
    if (c === "busy") {
      if (remember) {
        this.busy.mark(this.pid);
        this.note("ax.busy", { pid: this.pid });
      }
      throw new ProviderError("busy", `the app (pid ${this.pid}) didn't answer in time`);
    }
    if (c === "gone") throw new ProviderError("gone", "the element isn't there any more");
    if (c === "denied") throw new ProviderError("denied", NEEDS_PERMISSION);
    if (c === "unsupported") throw new ProviderError("unsupported", `unsupported: ${what}`);
    throw new ProviderError("failed", `the app couldn't ${what} (${axErrorName(code)})`);
  }

  /**
   * One batched read of `names` (its values the caller's: release the references in them). A slot fails as the whole
   * call would: a busy app's partial answer (CannotComplete in any slot) is busy, an element that went away is gone.
   */
  batch(el: AxRef, names: readonly string[], max = TEXT_MAX): Map<string, AxValue | AxError> {
    this.calls++;
    const m = this.api.attrs(el, names, max);
    if (isAxError(m)) this.raise(m.axError, "read an element");
    for (const v of m.values()) {
      if (!isAxError(v)) continue;
      const c = errorCode(v.axError);
      if (c && FATAL.has(c)) {
        for (const x of m.values()) releaseValue(this.api, x);
        this.raise(v.axError, "read an element");
      }
    }
    return m;
  }

  /** The facts of an element: one batched read (`names`: NODE_ATTRS, or CHAIN_ATTRS for a hit test's chain). */
  facts(el: AxRef, names: readonly string[] = NODE_ATTRS): Facts {
    return factsOf(this.api, this.batch(el, names));
  }

  /** A single attribute (undefined: absent, unsupported or unreadable); busy, gone and denied throw. */
  attr(el: AxRef, name: string, max = TEXT_MAX): AxValue | undefined {
    this.calls++;
    const v = this.api.attr(el, name, max);
    if (!isAxError(v)) return v;
    const c = errorCode(v.axError);
    if (c && FATAL.has(c)) this.raise(v.axError, `read ${name}`);
    return undefined;
  }

  /**
   * An element's value as a read keeps it: AXValue; for a text area (a document) its length first, and past TEXT_MAX
   * characters its first TEXT_MAX through AXStringForRange, which doesn't copy a whole document over (a 1 MB text
   * would outlast the messaging timeout and make the app look busy). Never called for a secure field.
   */
  value(el: AxRef, f: Facts): AxValue | undefined {
    if (isSecure(f)) return undefined;
    if (f.role === "AXTextArea") {
      const chars = num(this.attr(el, "AXNumberOfCharacters"));
      if (chars !== undefined && chars > TEXT_MAX) return this.textRange(el, 0, TEXT_MAX);
    }
    const v = this.attr(el, "AXValue", TEXT_MAX);
    // A value that is an element (an odd app's) is nothing Ember reads.
    if (typeof v === "bigint" || Array.isArray(v)) {
      releaseValue(this.api, v);
      return undefined;
    }
    return v;
  }

  /**
   * Up to `max` children from the first of `names` the element has (null: it has none of them). Each attribute tried
   * is a round trip; `budget` caps how many are tried.
   */
  children(el: AxRef, names: readonly string[], max: number, budget = names.length): { kids: AxRef[]; tries: number } {
    let tries = 0;
    for (const name of names.slice(0, Math.max(1, budget))) {
      tries++;
      this.calls++;
      const r = this.api.range(el, name, 0, max);
      if (!isAxError(r)) return { kids: r, tries };
      const c = errorCode(r.axError);
      if (c && FATAL.has(c)) this.raise(r.axError, `read ${name}`);
    }
    return { kids: [], tries };
  }

  /** AXUIElementCopyActionNames ([] where it has none or can't say). */
  actions(el: AxRef): string[] {
    this.calls++;
    const r = this.api.actions(el);
    if (!isAxError(r)) return r;
    const c = errorCode(r.axError);
    if (c && FATAL.has(c)) this.raise(r.axError, "list its actions");
    return [];
  }

  /** May attribute `name` be set? (false where it can't say) */
  settable(el: AxRef, name: string): boolean {
    this.calls++;
    const r = this.api.settable(el, name);
    if (!isAxError(r)) return r;
    const c = errorCode(r.axError);
    if (c && FATAL.has(c)) this.raise(r.axError, `ask about ${name}`);
    return false;
  }

  /** Sets an attribute; every error throws (a perform's busy isn't remembered: see doPerform). */
  set(el: AxRef, name: string, v: AxValue, what: string): void {
    this.calls++;
    const e = this.api.set(el, name, v);
    if (e) this.raise(e.axError, what, false);
  }

  /** Does an action; every error throws (busy not remembered: an action that opens a modal dialog waits for it). */
  perform(el: AxRef, action: string, what: string): void {
    this.calls++;
    const e = this.api.perform(el, action);
    if (e) this.raise(e.axError, what, false);
  }

  /** `length` characters of an element's text from `location` (undefined: it can't say). */
  textRange(el: AxRef, location: number, length: number): string | undefined {
    this.calls++;
    const t = this.api.textRange(el, location, length);
    if (!isAxError(t)) return t;
    const c = errorCode(t.axError);
    if (c && FATAL.has(c)) this.raise(t.axError, "read its text");
    return undefined;
  }
}

/** Do the spans [a0, a1) and [b0, b1) overlap? A span with no length overlaps where it lies inside the other. */
const spans = (a0: number, a1: number, b0: number, b1: number) => (a1 > a0 ? a0 < b1 && a1 > b0 : a0 >= b0 && a0 <= b1);

/** Does `r` overlap `clip`? Nothing overlaps a clip with no area (a scroll area scrolled to nothing). */
export function overlaps(r: Rect, clip: Rect): boolean {
  if (clip.width <= 0 || clip.height <= 0) return false;
  return spans(r.x, r.x + r.width, clip.x, clip.x + clip.width) && spans(r.y, r.y + r.height, clip.y, clip.y + clip.height);
}

/** The overlap of two rectangles (`a` alone where `b` is null). */
export function intersect(a: Rect | null, b: Rect | null): Rect | null {
  if (!a) return b;
  if (!b) return a;
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.width, b.x + b.width), y1 = Math.min(a.y + a.height, b.y + b.height);
  return { x, y, width: Math.max(0, x1 - x), height: Math.max(0, y1 - y) };
}

/** Is an element with this frame hidden by `clip` (its window and scroll areas) or by AXHidden? */
export const clippedOut = (f: Pick<Facts, "frame" | "hidden">, clip: Rect | null): boolean =>
  f.hidden || (!!f.frame && !!clip && !overlaps(f.frame, clip));

/** The clip what is inside an element shows within: its window's frame, narrowed by every scroll area. */
export const clipInside = (f: Pick<Facts, "role" | "frame">, clip: Rect | null, depth: number): Rect | null =>
  depth === 0 || f.role === "AXScrollArea" ? intersect(clip, f.frame) : clip;

/**
 * The host's action words for an element: from its action names where they were read (`names`), else what its role
 * implies; and from what may be set (`settable` asked in element()/perform(); assumed from the role while walking).
 */
export function actionsOf(f: Facts, names: readonly string[] | null, settable: Settable | null): string[] {
  const out = new Set<string>();
  const has = (a: string) => !!names?.includes(a);
  const role = f.role;
  const toggle = isToggle(f);
  const press = names ? has("AXPress") : PRESS_ROLES.has(role) || toggle || role === "AXRadioButton";
  if (press) out.add(toggle ? "toggle" : role === "AXRadioButton" ? "select" : MENU_OPENERS.has(role) ? "expand" : "invoke");
  if (role === "AXMenuItem" && (names ? has("AXPick") || has("AXPress") : true)) out.add("select");
  if (MENU_OPENERS.has(role) && (names ? has("AXShowMenu") || has("AXPress") : true)) out.add("expand");
  if (f.selected !== undefined && role !== "AXRadioButton" && role !== "AXMenuItem" && role !== "AXWindow" && (settable ? settable.selected : true)) {
    out.add("select").add("addToSelection").add("removeFromSelection");
  }
  const expandable = settable ? !!(settable.expanded || settable.disclosing)
    : (f.expanded !== undefined && MENU_OPENERS.has(role)) || (f.disclosing !== undefined && role === "AXRow");
  if (expandable) out.add("expand").add("collapse");
  if (ENTRY_ROLES.has(role) && !isSecure(f) && (settable ? settable.value : true)) out.add("setValue");
  if (RANGE_ROLES.has(role) && (settable ? settable.value || has("AXIncrement") || has("AXDecrement") : true)) out.add("setRange");
  if (f.hasFocused && (settable ? settable.focused : FOCUSABLE_ROLES.has(role))) out.add("focus");
  if (has("AXScrollToVisible")) out.add("scrollIntoView");
  return [...out];
}

/** Does a walk read this element's action names (the host lists actions for its role, and it carries no value)? */
export function readsActions(atspiRole: string): boolean {
  return INTERACTIVE_ROLES.has(atspiRole) && !LAZY_ACTION_ROLES.has(atspiRole) && !TEXT_ROLES.has(atspiRole);
}

/**
 * The host's facts of an element (see RawNode): its name (AXTitle, else AXDescription, else a label's text), its
 * states, its frame, and from its value its text (cut to TEXT_MAX; never a secure field's), its state or its number.
 */
export function nodeOf(f: Facts, value: AxValue | undefined, actions: string[], settable: Settable | null = null): NodeBody {
  const secure = isSecure(f);
  const text = typeof value === "string" && !secure ? value.slice(0, TEXT_MAX) : undefined;
  const n: NodeBody = {
    platformRole: f.role || "AXUnknown",
    name: (f.title || f.description || (f.role === "AXStaticText" ? text ?? "" : "")).slice(0, TEXT_MAX),
    bounds: f.frame,
    actions,
  };
  const set = <K extends keyof NodeBody>(k: K, v: NodeBody[K] | undefined) => { if (v !== undefined) n[k] = v; };
  set("platformSubrole", f.subrole || undefined);
  set("help", f.help || undefined);
  set("placeholder", f.placeholder || undefined);
  set("enabled", f.enabled);
  // A window's AXFocused says it is the key window, which Ember tells by `active` instead.
  if (f.role !== "AXWindow") set("focused", f.focused);
  if (f.hidden) n.offscreen = true;
  set("modal", f.modal);
  if (secure) {
    n.password = true;
  } else if (text !== undefined && f.role !== "AXCheckBox" && f.role !== "AXRadioButton") {
    n.value = text;
  }
  if (ENTRY_ROLES.has(f.role)) {
    n.editable = secure || (settable ? !!settable.value : true);
    // Its text wasn't read with it (the budget ran out): textInfo can read it.
    if (!secure && text === undefined) n.hasText = true;
  }
  if (f.role === "AXTextArea") n.multiLine = true;
  const focusable = f.hasFocused && (settable ? !!settable.focused : FOCUSABLE_ROLES.has(f.role));
  if (focusable) n.focusable = true;
  const number = typeof value === "number" ? value : typeof value === "boolean" ? Number(value) : undefined;
  if (number !== undefined && Number.isFinite(number)) {
    if (isToggle(f)) n.toggle = number === 1 ? "on" : number === 2 ? "mixed" : "off";
    else if (f.role === "AXRadioButton") n.selected = number === 1;
    else if ((RANGE_ROLES.has(f.role) || LEVEL_ROLES.has(f.role)) && f.min !== undefined && f.max !== undefined) {
      const readOnly = LEVEL_ROLES.has(f.role) || (settable ? !actions.includes("setRange") : false);
      n.range = { value: number, min: f.min, max: f.max, ...(f.step !== undefined && f.step > 0 ? { step: f.step } : {}), ...(readOnly ? { readOnly: true } : {}) };
    }
  }
  if (f.selected !== undefined && f.role !== "AXRadioButton") n.selected = f.selected;
  const expanded = f.expanded ?? f.disclosing;
  if (expanded !== undefined) n.expanded = expanded;
  if (f.role === "AXMenuItem" && f.mark.trim()) n.toggle = "on";
  if (CHOOSER_ROLES.has(f.role)) n.selection = { multiple: false };
  if (f.rows !== undefined && f.columns !== undefined) n.grid = { rows: f.rows, columns: f.columns };
  if (f.rowIndex !== undefined && f.columnIndex !== undefined) n.cell = { row: f.rowIndex, column: f.columnIndex };
  return n;
}

/** One element a walk read: its reference (owned), its facts for the host, and where it sits. */
export interface Walked {
  ref: AxRef;
  node: NodeBody;
  parent: number;
  depth: number;
  /** Child indices from the window (the index-path key). */
  path: number[];
  /** The clip it was judged against (its window and scroll areas). */
  clip: Rect | null;
  /** Round trips spent on it. */
  trips: number;
}

/** A walk's budgets (the host's SnapshotOptions), and its clock for the tests. */
export interface WalkOptions {
  maxDepth: number;
  maxNodes: number;
  deadlineMs: number;
  /** Children of one element read at most (MAX_CHILDREN). */
  maxChildren?: number;
  now?: () => number;
}

/** What a walk read, pre-order, and what it left out (see Snapshot). */
export interface WalkResult { nodes: Walked[]; truncated: boolean; cut: string[]; busy: boolean }

/**
 * Walks a window (`root`, borrowed) pre-order within the budgets (see the module comment). The walk stops, cut
 * "time", once `deadlineMs - AX_TIMEOUT_MS` has passed (checked before every round trip after the window's own, so one
 * stalled call can't overshoot); "nodes" past `maxNodes` or an element's MAX_CHILDREN; "depth" where something lies
 * below `maxDepth`. An app that stops answering partway gives what was read with `busy`; the window itself not
 * answering throws. An element that went away while it was read is left out with what it holds.
 */
export function walk(s: AxSession, root: AxRef, o: WalkOptions): WalkResult {
  const now = o.now ?? Date.now;
  const limit = now() + Math.max(0, o.deadlineMs - AX_TIMEOUT_MS);
  const maxChildren = o.maxChildren ?? MAX_CHILDREN;
  const nodes: Walked[] = [];
  const titles = new Map<number, AxRef>();
  const cut = new Set<string>();
  let busy = false, stop = false;
  const late = (): boolean => {
    if (stop) return true;
    if (now() < limit) return false;
    cut.add("time");
    stop = true;
    return true;
  };

  const visit = (ref: AxRef, parent: number, depth: number, path: number[], clip: Rect | null, ctx: RoleContext): void => {
    const first = nodes.length === 0 && parent < 0;
    if (!first && late()) { s.api.release(ref); return; }
    if (!first && nodes.length >= o.maxNodes) {
      // A sibling's subtree took the room left: what is after it waits for the next read.
      cut.add("nodes");
      stop = true;
      s.api.release(ref);
      return;
    }
    let f: Facts;
    try {
      f = s.facts(ref);
    } catch (err) {
      s.api.release(ref);
      if (first) throw err;
      if (err instanceof ProviderError && err.code === "busy") { busy = true; stop = true; return; }
      if (err instanceof ProviderError && err.code === "denied") throw err;
      return; // gone (or unreadable) while it was read: left out, with what it holds
    }
    let trips = 1;
    let value: AxValue | undefined;
    const provisional = nodeOf(f, undefined, []);
    const role = axRole({ ...provisional, handle: 0, key: "", parent, depth }, ctx);
    // What doesn't show is dropped by the host with all it holds: its value and actions aren't asked for.
    const off = !first && clippedOut(f, clip);
    try {
      if (!off && readsValue(f) && !late()) {
        const before = s.calls;
        value = s.value(ref, f);
        trips += s.calls - before;
      }
    } catch (err) {
      releaseFacts(s.api, f);
      s.api.release(ref);
      if (err instanceof ProviderError && err.code === "busy") { busy = true; stop = true; return; }
      if (err instanceof ProviderError && err.code === "denied") throw err;
      return;
    }
    const index = nodes.length;
    const node = nodeOf(f, value, []);
    if (off) node.offscreen = true;
    nodes.push({ ref, node, parent, depth, path, clip, trips });
    if (f.titleElement) { titles.set(index, f.titleElement); f.titleElement = null; }
    releaseFacts(s.api, f);
    const ctxInside = childContext(ctx, { ...node, handle: 0, key: "", parent, depth }, role);
    if (!off && !LEAF_ROLES.has(f.role) && !stop) {
      if (nodes.length >= o.maxNodes) {
        cut.add("nodes");
        stop = true;
      } else if (!late()) {
        const deep = depth >= o.maxDepth;
        const want = deep ? 1 : Math.min(maxChildren, o.maxNodes - nodes.length) + 1;
        const names = CHILDREN_OF[f.role] ?? ["AXChildren"];
        let got: { kids: AxRef[]; tries: number } | null = null;
        try {
          got = s.children(ref, names, want, MAX_TRIPS - trips);
        } catch (err) {
          if (err instanceof ProviderError && err.code === "busy") { busy = true; stop = true; }
          else if (err instanceof ProviderError && err.code === "denied") throw err;
        }
        if (got) {
          nodes[index].trips = trips += got.tries;
          let kids = got.kids;
          if (deep) {
            if (kids.length) cut.add("depth");
            for (const k of kids) s.api.release(k);
            kids = [];
          } else if (kids.length >= want) {
            cut.add("nodes");
            for (const k of kids.slice(want - 1)) s.api.release(k);
            kids = kids.slice(0, want - 1);
          }
          const inner = clipInside(f, clip, depth);
          for (let i = 0; i < kids.length; i++) {
            if (stop) { s.api.release(kids[i]!); continue; }
            try {
              visit(kids[i]!, index, depth + 1, [...path, i], inner, ctxInside);
            } catch (err) {
              // Refused partway (the permission went): the children not visited yet go back too.
              for (const rest of kids.slice(i + 1)) s.api.release(rest);
              throw err;
            }
          }
        }
      }
    }
    // Its actions, where the host lists them and the budget allows; else what its role implies.
    let names: string[] | null = null;
    if (!off && readsActions(role) && trips < MAX_TRIPS && !late()) {
      try {
        names = s.actions(ref);
        nodes[index].trips = ++trips;
      } catch (err) {
        if (err instanceof ProviderError && err.code === "busy") { busy = true; stop = true; }
        else if (err instanceof ProviderError && err.code === "denied") throw err;
      }
    }
    node.actions = actionsOf(f, names, null);
    // No frame of its own: it shows only through what shows inside it.
    if (!first && !off && !f.frame && !nodes.some((n, j) => j > index && n.parent === index && !n.node.offscreen)) node.offscreen = true;
  };

  try {
    visit(s.api.retain(root), -1, 0, [], null, { depth: 0, inWeb: false, inTerminal: false, parentRole: "" });
    resolveLabels(s, nodes, titles, late);
  } catch (err) {
    for (const n of nodes) s.api.release(n.ref);
    for (const t of titles.values()) s.api.release(t);
    throw err;
  }
  return { nodes, truncated: cut.size > 0, cut: [...cut], busy };
}

/**
 * Names each labelled element after its AXTitleUIElement: from the element as the walk read it (no round trip; the
 * label is usually a sibling), else with one read of the label itself where the element's budget allows.
 */
function resolveLabels(s: AxSession, nodes: Walked[], titles: Map<number, AxRef>, late: () => boolean): void {
  if (!titles.size) return;
  const byHash = new Map<string, number[]>();
  nodes.forEach((n, i) => {
    const h = s.api.hash(n.ref);
    byHash.set(h, [...byHash.get(h) ?? [], i]);
  });
  for (const [i, t] of titles) {
    try {
      const at = (byHash.get(s.api.hash(t)) ?? []).find(j => s.api.same(nodes[j].ref, t));
      let label = at !== undefined ? nodes[at].node.name || nodes[at].node.value || "" : "";
      if (at === undefined && nodes[i].trips < MAX_TRIPS && !late()) {
        nodes[i].trips++;
        label = labelOf(s, t);
      }
      if (label.trim()) nodes[i].node.labelledBy = label.slice(0, TEXT_MAX);
    } finally {
      s.api.release(t);
    }
  }
  titles.clear();
}

/**
 * What a label element says (its AXTitle, else its AXValue), or "" when it can't be read. Its role comes in the same
 * round trip: should an app name a secure field as another's label, that field's value is never reported.
 */
function labelOf(s: AxSession, label: AxRef): string {
  try {
    const m = s.batch(label, ["AXRole", "AXSubrole", "AXTitle", "AXValue"]);
    const secure = isSecure({ role: str(m.get("AXRole")), subrole: str(m.get("AXSubrole")), subroleUnknown: unreadSubrole(m.get("AXSubrole")) });
    const said = str(m.get("AXTitle")) || (secure ? "" : str(m.get("AXValue")));
    for (const v of m.values()) releaseValue(s.api, v);
    return said;
  } catch {
    return ""; // the label couldn't be read: the element keeps its own name
  }
}

/** One element read on its own (element(), and each child or chain element): its facts and its value. */
export interface Read { facts: Facts; value: AxValue | undefined }

/** Reads one element's batch and (for a value role) its value; `names` CHAIN_ATTRS where its parent is wanted too. */
export function readOne(s: AxSession, el: AxRef, names: readonly string[] = NODE_ATTRS): Read {
  const facts = s.facts(el, names);
  try {
    return { facts, value: readsValue(facts) ? s.value(el, facts) : undefined };
  } catch (err) {
    releaseFacts(s.api, facts);
    throw err;
  }
}

/** What may be set on an element, asked only where its role and facts make it matter. */
export function settableOf(s: AxSession, el: AxRef, f: Facts): Settable {
  const out: Settable = {};
  if ((ENTRY_ROLES.has(f.role) && !isSecure(f)) || RANGE_ROLES.has(f.role)) out.value = s.settable(el, "AXValue");
  if (f.hasFocused && FOCUSABLE_ROLES.has(f.role)) out.focused = s.settable(el, "AXFocused");
  if (f.selected !== undefined && f.role !== "AXRadioButton" && f.role !== "AXMenuItem") out.selected = s.settable(el, "AXSelected");
  if (f.expanded !== undefined) out.expanded = s.settable(el, "AXExpanded");
  if (f.disclosing !== undefined) out.disclosing = s.settable(el, "AXDisclosing");
  return out;
}

/**
 * An element as element() reports it: its facts, value, action names, what may be set and its label, all asked of it
 * now. The facts come back without references (AXParent isn't asked; the label is read and let go).
 */
export function lookAt(s: AxSession, el: AxRef): { facts: Facts; node: NodeBody } {
  const { facts, value } = readOne(s, el);
  try {
    const names = s.actions(el);
    const settable = settableOf(s, el, facts);
    const node = nodeOf(facts, value, actionsOf(facts, names, settable), settable);
    if (facts.titleElement) {
      const label = labelOf(s, facts.titleElement);
      if (label.trim()) node.labelledBy = label.slice(0, TEXT_MAX);
    }
    return { facts, node };
  } finally {
    releaseFacts(s.api, facts);
  }
}

/**
 * Reads a child or a chain element for the host: no action names (what its facts imply), no settable questions, no
 * label. With CHAIN_ATTRS its AXParent stays in the facts (the caller's to release); nothing else is held.
 */
export function glance(s: AxSession, el: AxRef, names: readonly string[] = NODE_ATTRS): { facts: Facts; node: NodeBody } {
  const { facts, value } = readOne(s, el, names);
  if (facts.titleElement) s.api.release(facts.titleElement);
  facts.titleElement = null;
  return { facts, node: nodeOf(facts, value, actionsOf(facts, null, null)) };
}

/**
 * What a text field or text area holds, for textInfo: nothing of a secure field (`secret`); else its text (up to
 * `maxChars`, through AXStringForRange where it is longer than that), its selected text and where its caret is.
 */
export function textOf(s: AxSession, el: AxRef, maxChars: number): TextInfo {
  // The role first, on its own: nothing of a secure field's contents (its length, its selection) is asked for.
  const kind = s.batch(el, ["AXRole", "AXSubrole"]);
  const role = str(kind.get("AXRole")), subrole = str(kind.get("AXSubrole")), subroleUnknown = unreadSubrole(kind.get("AXSubrole"));
  for (const v of kind.values()) releaseValue(s.api, v);
  if (isSecure({ role, subrole, subroleUnknown })) return { secret: true };
  const m = s.batch(el, ["AXNumberOfCharacters", "AXSelectedText", "AXSelectedTextRange"]);
  const chars = num(m.get("AXNumberOfCharacters"));
  const selected = m.get("AXSelectedText"), range = m.get("AXSelectedTextRange");
  for (const v of m.values()) releaseValue(s.api, v);
  const max = Math.max(1, Math.floor(maxChars));
  const out: TextInfo = {};
  let text: string | undefined;
  if (chars !== undefined && chars > max) {
    text = s.textRange(el, 0, max);
    if (text !== undefined) out.truncated = true;
  }
  if (text === undefined) {
    const v = s.attr(el, "AXValue", max + 1);
    if (typeof v === "string") {
      text = v.slice(0, max);
      if (v.length > max) out.truncated = true;
    } else releaseValue(s.api, v);
  }
  if (text !== undefined) out.text = text;
  if (typeof selected === "string" && selected) out.selection = selected.slice(0, TEXT_MAX);
  if (typeof range === "object" && !Array.isArray(range) && !isAxError(range) && range.type === "range") {
    out.caret = Math.max(0, range.location);
    const count = chars ?? (text !== undefined && !out.truncated ? text.length : undefined);
    if (count !== undefined) out.caretAtEnd = range.location >= count;
  }
  return out;
}

/**
 * Does `op` on an element (design §5.3): invoke and toggle press it; select sets AXSelected where it may be set, else
 * picks a menu item or presses a radio button or tab; expand and collapse set AXExpanded or AXDisclosing, else a
 * drop-down's menu is shown; setValue sets a field's text (never a secure field's: denied); setRange sets a number,
 * else steps it with AXIncrement/AXDecrement; focus sets AXFocused; scrollIntoView scrolls to it; UI Automation's
 * "legacy" action has no AX counterpart. Never AXRaise or AXFrontmost: an action never brings a window to the front.
 */
export function doPerform(s: AxSession, el: AxRef, f: Facts, op: PerformOp, value?: unknown): void {
  /** Does the first of `actions` the element has (an action it doesn't have answers kAXErrorActionUnsupported). */
  const first = (actions: string[], what: string) => {
    for (let i = 0; i < actions.length; i++) {
      try {
        s.perform(el, actions[i]!, what);
        return;
      } catch (err) {
        if (i === actions.length - 1 || !(err instanceof ProviderError) || err.code !== "unsupported") throw err;
      }
    }
  };
  switch (op) {
    case "invoke":
      first(["AXPress", "AXPick"], "press it");
      return;
    case "toggle":
      s.perform(el, "AXPress", "press it");
      return;
    case "select": case "addToSelection":
      if (f.selected !== undefined && s.settable(el, "AXSelected")) {
        s.set(el, "AXSelected", true, "select it");
        return;
      }
      if (op === "addToSelection") s.raise(AX_ERROR.attributeUnsupported, "add it to the selection");
      first(f.role === "AXMenuItem" ? ["AXPick", "AXPress"] : ["AXPress"], "select it");
      return;
    case "removeFromSelection":
      if (f.selected === undefined || !s.settable(el, "AXSelected")) s.raise(AX_ERROR.attributeUnsupported, "unselect it");
      s.set(el, "AXSelected", false, "unselect it");
      return;
    case "expand": case "collapse": {
      const open = op === "expand";
      if (f.expanded !== undefined && s.settable(el, "AXExpanded")) { s.set(el, "AXExpanded", open, `${op} it`); return; }
      if (f.disclosing !== undefined && s.settable(el, "AXDisclosing")) { s.set(el, "AXDisclosing", open, `${op} it`); return; }
      if (open && MENU_OPENERS.has(f.role)) {
        first(["AXShowMenu", "AXPress"], "open its menu");
        return;
      }
      s.raise(AX_ERROR.attributeUnsupported, `${op} it`);
      return;
    }
    case "setValue":
      if (isSecure(f)) throw new ProviderError("denied", "a password field's value isn't set");
      s.set(el, "AXValue", String(value ?? ""), "set its text");
      return;
    case "setRange": {
      // A secure field's value is never written, whatever the request says it holds (nor read, as stepping would).
      if (isSecure(f)) throw new ProviderError("denied", "a password field's value isn't set");
      const target = Number(value);
      if (!Number.isFinite(target)) throw new ProviderError("failed", "not a number");
      if (s.settable(el, "AXValue")) { s.set(el, "AXValue", target, "set its value"); return; }
      stepTo(s, el, target, f.step);
      return;
    }
    case "focus":
      s.set(el, "AXFocused", true, "give it the keyboard");
      return;
    case "scrollIntoView":
      s.perform(el, "AXScrollToVisible", "scroll to it");
      return;
    default:
      s.raise(AX_ERROR.actionUnsupported, op);
  }
}

/**
 * Moves a range that can't be set toward `target` with AXIncrement/AXDecrement, stopping at the closest step (within
 * half a step of it where the step is known; else one step past it, and back when that was further).
 */
function stepTo(s: AxSession, el: AxRef, target: number, step?: number): void {
  const acts = s.actions(el);
  if (!acts.includes("AXIncrement") && !acts.includes("AXDecrement")) s.raise(AX_ERROR.attributeUnsupported, "set its value");
  const read = (): number | undefined => num(s.attr(el, "AXValue"));
  let cur = read();
  if (cur === undefined) s.raise(AX_ERROR.noValue, "read its value");
  for (let i = 0; i < RANGE_STEPS && cur !== target; i++) {
    if (step !== undefined && step > 0 && Math.abs(target - cur!) <= step / 2) return;
    const up = cur! < target;
    s.perform(el, up ? "AXIncrement" : "AXDecrement", "step its value");
    const next = read();
    if (next === undefined || next === cur) return; // at its end, or it doesn't move
    if ((up && next > target) || (!up && next < target)) {
      // Past it: the closer of the two steps stays.
      if (Math.abs(next - target) > Math.abs(cur! - target)) s.perform(el, up ? "AXDecrement" : "AXIncrement", "step its value");
      return;
    }
    cur = next;
  }
}
