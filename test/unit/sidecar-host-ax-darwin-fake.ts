/**
 * A pretend macOS accessibility API (AxApi) for the AX provider's tests: apps of elements described as plain objects,
 * answering as AX does where the provider relies on it. Every reference handed out is counted (copies are new
 * references to the same element, CFRetain adds one to the same reference), so a leak or a double release fails the
 * test; every call is logged with the element and the pid it went to, so a test can count round trips per element and
 * prove a pid was never asked anything; a clock moves on with every round trip, for the deadline. Elements can be
 * busy (kAXErrorCannotComplete for the whole call or one slot), go away, collide on CFHash, or answer kCFNull.
 */

import { AX_ERROR } from "../../app/main/platform/darwin/ax";
import type { Rect } from "../../app/sidecar-host/provider";
import { NO_VALUE, axError, type AxApi, type AxError, type AxRef, type AxValue, type AxWindowEntry } from "../../app/sidecar-host/providers/ax-darwin-api";

/** An element as a test describes it, in AX's own words. */
export interface ElSpec {
  role: string;
  subrole?: string;
  title?: string;
  description?: string;
  help?: string;
  placeholder?: string;
  /** AXValue. */
  value?: string | number | boolean;
  enabled?: boolean;
  focused?: boolean;
  selected?: boolean;
  expanded?: boolean;
  disclosing?: boolean;
  hidden?: boolean;
  modal?: boolean;
  main?: boolean;
  minimized?: boolean;
  frame?: Rect | null;
  min?: number;
  max?: number;
  step?: number;
  /** How far AXIncrement/AXDecrement move it (default its step, else 1), whatever AXValueIncrement says. */
  stepBy?: number;
  mark?: string;
  /** The `id` of the element that labels it (AXTitleUIElement). */
  titleElement?: string;
  actions?: string[];
  settable?: string[];
  children?: ElSpec[];
  /** A table's or outline's rows that show (AXVisibleRows: indices into children); absent: the attribute isn't there. */
  visibleRows?: number[];
  /** A list's children that show (AXVisibleChildren). */
  visibleChildren?: number[];
  /** A window's CGWindowID (its window-list entry, and what _AXUIElementGetWindow answers unless `noWindowId`). */
  windowId?: number;
  /** _AXUIElementGetWindow fails for this window (the provider must match it by frame or title). */
  noWindowId?: boolean;
  /** The window list's kCGWindowName for it ("" without Screen Recording). */
  cgTitle?: string;
  /** What a test calls it, to find it. */
  id?: string;
  /** CFHash as hex (to make two elements collide). */
  hash?: string;
  /** Every call about it answers this AXError (CannotComplete: busy; InvalidUIElement: gone). */
  fail?: number;
  /** Calls of one kind ("attrs", "perform"…) about it answer this AXError instead. */
  failOn?: Record<string, number>;
  /** Single slots of its batch that answer an AXError instead (`null`: kCFNull, as "no value"). */
  slots?: Record<string, number | null>;
}

/** An app as a test describes it. */
export interface AppSpec {
  pid: number;
  /** kCGWindowOwnerName. */
  owner: string;
  windows: ElSpec[];
  /** Every call to this app answers CannotComplete (a hung app). */
  hung?: boolean;
  /** The element with the keyboard (AXFocusedUIElement), by id. */
  focusedId?: string;
}

/** One live element. */
export class El {
  readonly uid: number;
  spec: ElSpec;
  parent: El | null;
  children: El[];
  readonly pid: number;
  /** The app element itself (role AXApplication). */
  readonly isApp: boolean;

  constructor(spec: ElSpec, parent: El | null, pid: number, uid: () => number, isApp = false) {
    this.uid = uid();
    this.spec = spec;
    this.parent = parent;
    this.pid = pid;
    this.isApp = isApp;
    this.children = (spec.children ?? []).map(c => new El(c, this, pid, uid));
  }

  find(test: (e: El) => boolean): El | undefined {
    if (test(this)) return this;
    for (const c of this.children) {
      const f = c.find(test);
      if (f) return f;
    }
    return undefined;
  }
}

/** A logged call: what, about which element (its uid; 0 for none) and in which app. */
export interface Call { op: string; uid: number; pid: number; name?: string }

const inside = (r: Rect | null | undefined, x: number, y: number) => !!r && x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height;

/** Maps an AX attribute of an element to its value as the API converts it (references made by `ref`). */
function attributeOf(e: El, name: string, ref: (e: El) => AxRef, fake: FakeAx): AxValue | AxError {
  const s = e.spec;
  const has = <T>(v: T | undefined): T | AxError => (v === undefined ? NO_VALUE : v);
  switch (name) {
    case "AXRole": return e.isApp ? "AXApplication" : s.role;
    case "AXSubrole": return has(s.subrole);
    case "AXTitle": return has(s.title);
    case "AXDescription": return has(s.description);
    case "AXHelp": return has(s.help);
    case "AXPlaceholderValue": return has(s.placeholder);
    case "AXValue": return has(s.value);
    case "AXEnabled": return has(s.enabled);
    case "AXFocused": return has(s.focused);
    case "AXSelected": return has(s.selected);
    case "AXExpanded": return has(s.expanded);
    case "AXDisclosing": return has(s.disclosing);
    case "AXHidden": return has(s.hidden);
    case "AXModal": return has(s.modal);
    case "AXMain": return has(s.main);
    case "AXMinimized": return has(s.minimized);
    case "AXMinValue": return has(s.min);
    case "AXMaxValue": return has(s.max);
    case "AXValueIncrement": return has(s.step);
    case "AXMenuItemMarkChar": return has(s.mark);
    case "AXPosition": return s.frame ? { type: "point", x: s.frame.x, y: s.frame.y } : NO_VALUE;
    case "AXSize": return s.frame ? { type: "size", width: s.frame.width, height: s.frame.height } : NO_VALUE;
    case "AXNumberOfCharacters": return typeof s.value === "string" ? s.value.length : NO_VALUE;
    case "AXSelectedText": return typeof s.value === "string" ? "" : NO_VALUE;
    case "AXSelectedTextRange": return typeof s.value === "string" ? { type: "range", location: s.value.length, length: 0 } : NO_VALUE;
    case "AXTitleUIElement": {
      const t = s.titleElement ? fake.byId(s.titleElement) : undefined;
      return t ? ref(t) : NO_VALUE;
    }
    case "AXParent": return e.parent ? ref(e.parent) : fake.appOf(e.pid) ? ref(fake.appOf(e.pid)!) : NO_VALUE;
    case "AXWindow": {
      let w: El | null = e;
      while (w?.parent && !w.parent.isApp) w = w.parent;
      return w && w.spec.role === "AXWindow" ? ref(w) : NO_VALUE;
    }
    case "AXChildren": case "AXWindows": return e.children.map(ref);
    case "AXFocusedUIElement": {
      const app = fake.apps.find(a => a.pid === e.pid);
      const f = app?.focusedId ? fake.byId(app.focusedId) : undefined;
      return f ? ref(f) : NO_VALUE;
    }
    case "AXFocusedApplication": return fake.frontmost !== null && fake.appOf(fake.frontmost) ? ref(fake.appOf(fake.frontmost)!) : NO_VALUE;
    default: return axError(AX_ERROR.attributeUnsupported);
  }
}

/** The pretend API (see the module comment). */
export class FakeAx implements AxApi {
  apps: AppSpec[];
  /** The apps' elements (role AXApplication), by pid. */
  private appEls = new Map<number, El>();
  private system: El;
  private refs = new Map<AxRef, { el: El; count: number }>();
  private next = 0x1000n;
  private nextUid = 1;
  readonly calls: Call[] = [];
  /** Sets and performs, in order (as "set AXValue=…" / "perform AXPress" with the element's id or role). */
  readonly done: string[] = [];
  trustedAnswer = true;
  frontmost: number | null = null;
  /** Milliseconds every round trip takes on the fake clock. */
  cost = 1;
  clock = 1_000_000;
  /** On-screen windows beyond the apps' own (system windows, Ember's own…). */
  extraWindows: AxWindowEntry[] = [];
  displayList: Rect[] = [{ x: 0, y: 0, width: 1440, height: 900 }];
  /** References the provider got and hasn't given back are counted here; the API's own (app elements) aren't. */
  private own = new Set<AxRef>();

  constructor(apps: AppSpec[]) {
    this.apps = apps;
    const uid = () => this.nextUid++;
    this.system = new El({ role: "AXSystemWide" }, null, 0, uid);
    for (const a of apps) {
      const app = new El({ role: "AXApplication", children: a.windows }, null, a.pid, uid, true);
      for (const w of app.children) w.parent = app;
      this.appEls.set(a.pid, app);
    }
    this.frontmost = apps[0]?.pid ?? null;
  }

  /** The fake clock (pass it to the provider as `now`). */
  now = (): number => this.clock;

  /** An app's element. */
  appOf(pid: number): El | undefined {
    return this.appEls.get(pid);
  }

  /** The element called `id`, in any app. */
  byId(id: string): El | undefined {
    for (const app of this.appEls.values()) {
      const f = app.find(e => e.spec.id === id);
      if (f) return f;
    }
    return undefined;
  }

  /** The element called `id` (throws when there is none). */
  el(id: string): El {
    const f = this.byId(id);
    if (!f) throw new Error(`no element "${id}"`);
    return f;
  }

  /** References handed out and not given back. */
  get outstanding(): number {
    let n = 0;
    for (const [ref, r] of this.refs) if (!this.own.has(ref)) n += r.count;
    return n;
  }

  /** Round trips made about one element. */
  callsAbout(id: string): Call[] {
    const uid = this.el(id).uid;
    return this.calls.filter(c => c.uid === uid);
  }

  /** Every pid any call went to. */
  get pidsAsked(): Set<number> {
    return new Set(this.calls.filter(c => c.pid > 0).map(c => c.pid));
  }

  /** Removes an element (a test changing the app). */
  remove(id: string): void {
    const e = this.el(id);
    if (e.parent) e.parent.children = e.parent.children.filter(c => c !== e);
    e.spec = { ...e.spec, fail: AX_ERROR.invalidUIElement };
  }

  /** A new reference to an element (+1, the caller's). */
  ref = (e: El): AxRef => {
    const r = (this.next += 0x10n);
    this.refs.set(r, { el: e, count: 1 });
    return r;
  };

  private get(ref: AxRef): El {
    const r = this.refs.get(ref);
    if (!r || r.count <= 0) throw new Error(`use of a released or unknown reference ${ref}`);
    return r.el;
  }

  /** Logs a round trip about `e` and moves the clock; an app that is hung or an element that fails answers its error. */
  private trip(op: string, e: El, name?: string): number | null {
    this.calls.push({ op, uid: e.uid, pid: e.pid, ...(name ? { name } : {}) });
    this.clock += this.cost;
    if (this.apps.find(a => a.pid === e.pid)?.hung) return AX_ERROR.cannotComplete;
    return e.spec.failOn?.[op] ?? e.spec.fail ?? null;
  }

  trusted(): boolean {
    return this.trustedAnswer;
  }

  systemWide(): AxRef {
    const r = this.ref(this.system);
    this.own.add(r);
    return r;
  }

  private appRefs = new Map<number, AxRef>();
  app(pid: number): AxRef | null {
    this.calls.push({ op: "app", uid: 0, pid });
    const kept = this.appRefs.get(pid);
    if (kept) return kept;
    const e = this.appEls.get(pid);
    if (!e) return null;
    const r = this.ref(e);
    this.own.add(r);
    this.appRefs.set(pid, r);
    return r;
  }

  attrs(el: AxRef, names: readonly string[]): Map<string, AxValue | AxError> | AxError {
    const e = this.get(el);
    const fail = this.trip("attrs", e);
    if (fail !== null) return axError(fail);
    return new Map(names.map(n => {
      const slot = e.spec.slots?.[n];
      if (slot === null) return [n, NO_VALUE]; // kCFNull, converted as the real API converts it
      if (slot !== undefined) return [n, axError(slot)];
      return [n, attributeOf(e, n, this.ref, this)];
    }));
  }

  attr(el: AxRef, name: string, max = 2000): AxValue | AxError {
    const e = this.get(el);
    const fail = this.trip("attr", e, name);
    if (fail !== null) return axError(fail);
    const v = attributeOf(e, name, this.ref, this);
    return typeof v === "string" ? v.slice(0, max) : v;
  }

  count(el: AxRef, name: string): number | AxError {
    const e = this.get(el);
    const fail = this.trip("count", e, name);
    if (fail !== null) return axError(fail);
    return name === "AXChildren" ? e.children.length : axError(AX_ERROR.attributeUnsupported);
  }

  range(el: AxRef, name: string, index: number, max: number): AxRef[] | AxError {
    const e = this.get(el);
    const fail = this.trip("range", e, name);
    if (fail !== null) return axError(fail);
    let list: El[];
    if (name === "AXChildren") list = e.children;
    else if (name === "AXVisibleRows" && e.spec.visibleRows) list = e.spec.visibleRows.map(i => e.children[i]!).filter(Boolean);
    else if (name === "AXVisibleChildren" && e.spec.visibleChildren) list = e.spec.visibleChildren.map(i => e.children[i]!).filter(Boolean);
    else return axError(AX_ERROR.attributeUnsupported);
    return list.slice(index, index + max).map(this.ref);
  }

  settable(el: AxRef, name: string): boolean | AxError {
    const e = this.get(el);
    const fail = this.trip("settable", e, name);
    if (fail !== null) return axError(fail);
    return !!e.spec.settable?.includes(name);
  }

  actions(el: AxRef): string[] | AxError {
    const e = this.get(el);
    const fail = this.trip("actions", e);
    if (fail !== null) return axError(fail);
    return [...(e.spec.actions ?? [])];
  }

  set(el: AxRef, name: string, v: AxValue): AxError | null {
    const e = this.get(el);
    const fail = this.trip("set", e, name);
    this.done.push(`set ${name}=${typeof v === "bigint" ? "element" : JSON.stringify(v)} on ${e.spec.id ?? e.spec.role}`);
    if (fail !== null) return axError(fail);
    if (e.isApp) return name === "AXManualAccessibility" && e.spec.settable?.includes(name) ? null : axError(AX_ERROR.attributeUnsupported);
    if (!e.spec.settable?.includes(name)) return axError(AX_ERROR.attributeUnsupported);
    const s = e.spec;
    if (name === "AXValue") s.value = v as string | number;
    else if (name === "AXSelected") {
      if (v === true && e.parent) for (const c of e.parent.children) if (c !== e && c.spec.selected !== undefined) c.spec.selected = false;
      s.selected = v as boolean;
    } else if (name === "AXFocused") s.focused = v as boolean;
    else if (name === "AXExpanded") s.expanded = v as boolean;
    else if (name === "AXDisclosing") s.disclosing = v as boolean;
    return null;
  }

  perform(el: AxRef, action: string): AxError | null {
    const e = this.get(el);
    const fail = this.trip("perform", e, action);
    this.done.push(`perform ${action} on ${e.spec.id ?? e.spec.role}`);
    if (fail !== null) return axError(fail);
    const s = e.spec;
    if (!s.actions?.includes(action)) return axError(AX_ERROR.actionUnsupported);
    if (action === "AXPress" && (s.role === "AXCheckBox" || s.role === "AXDisclosureTriangle")) s.value = s.value === 1 ? 0 : 1;
    if (action === "AXPress" && s.role === "AXRadioButton" && e.parent) {
      for (const c of e.parent.children) if (c.spec.role === "AXRadioButton") c.spec.value = c === e ? 1 : 0;
    }
    if ((action === "AXIncrement" || action === "AXDecrement") && typeof s.value === "number") {
      const step = s.stepBy ?? s.step ?? 1;
      s.value = Math.min(s.max ?? Infinity, Math.max(s.min ?? -Infinity, s.value + (action === "AXIncrement" ? step : -step)));
    }
    return null;
  }

  at(x: number, y: number, pid?: number): AxRef | AxError {
    this.clock += this.cost;
    // App-scoped, only that app is asked; system-wide, the app whose window is at the point (front first) is.
    const apps = pid === undefined
      ? [...this.appEls.values()].filter(a => a.children.some(w => !w.spec.minimized && inside(w.spec.frame, x, y))).slice(0, 1)
      : [this.appEls.get(pid)].filter((a): a is El => !!a);
    this.calls.push({ op: "at", uid: 0, pid: pid ?? apps[0]?.pid ?? 0, ...(pid === undefined ? { name: "system-wide" } : {}) });
    for (const app of apps) {
      if (this.apps.find(a => a.pid === app.pid)?.hung) return axError(AX_ERROR.cannotComplete);
      for (const w of app.children) {
        if (w.spec.minimized || !inside(w.spec.frame, x, y)) continue;
        let cur = w;
        for (;;) {
          const here = cur.children.filter(c => !c.spec.hidden && inside(c.spec.frame, x, y));
          if (!here.length) break;
          cur = here[here.length - 1]!;
        }
        return this.ref(cur);
      }
    }
    return axError(AX_ERROR.noValue);
  }

  textRange(el: AxRef, location: number, length: number): string | AxError {
    const e = this.get(el);
    const fail = this.trip("textRange", e);
    if (fail !== null) return axError(fail);
    return typeof e.spec.value === "string" ? e.spec.value.slice(location, location + length) : axError(AX_ERROR.noValue);
  }

  pid(el: AxRef): number {
    return this.get(el).pid;
  }

  windowId(win: AxRef): number {
    const e = this.get(win);
    this.trip("windowId", e);
    return e.spec.noWindowId ? 0 : e.spec.windowId ?? 0;
  }

  hash(el: AxRef): string {
    const e = this.get(el);
    return e.spec.hash ?? (BigInt(e.pid) * 0x100000000n + BigInt(e.uid) + 0xf000000000000000n).toString(16);
  }

  same(a: AxRef, b: AxRef): boolean {
    return this.get(a) === this.get(b);
  }

  retain(el: AxRef): AxRef {
    this.get(el);
    this.refs.get(el)!.count++;
    return el;
  }

  release(el: AxRef): void {
    const r = this.refs.get(el);
    if (!r || r.count <= 0) throw new Error(`release of a released or unknown reference ${el}`);
    r.count--;
  }

  onScreenWindows(): AxWindowEntry[] {
    const out: AxWindowEntry[] = [];
    for (const a of this.apps) {
      for (const w of this.appEls.get(a.pid)!.children) {
        const s = w.spec;
        if (s.minimized || !s.frame || !s.windowId) continue;
        out.push({ id: s.windowId, pid: a.pid, owner: a.owner, title: s.cgTitle ?? "", bounds: { ...s.frame }, layer: 0, alpha: 1 });
      }
    }
    return [...this.extraWindows, ...out];
  }

  displays(): Rect[] {
    return this.displayList.map(d => ({ ...d }));
  }
}

/**
 * A stand-in for the macOS bench (test/fixtures/mac_bench.js) as AX describes an AppKit window: a Name field labelled
 * by the static text beside it, a secure Password field, a Remember me check box, a Theme pop-up, a Volume slider, a
 * Notes text area, a 200-row table in a scroll area (12 rows showing), and a Save button.
 */
export function benchApp(pid = 4300, windowId = 9001): AppSpec {
  const at = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
  const rows: ElSpec[] = Array.from({ length: 200 }, (_, i) => ({
    role: "AXRow", subrole: "AXTableRow", id: `row${i + 1}`, selected: false, settable: ["AXSelected"],
    frame: at(120, 400 + i * 20, 200, 20),
    // A cell-based NSTableView's cell is a text field that has its words only as its value (macos-15, CI run 120).
    children: [{ role: "AXTextField", value: `Row ${i + 1}`, frame: at(122, 400 + i * 20, 196, 20) }],
  }));
  return {
    pid, owner: "osascript", focusedId: "name",
    windows: [{
      role: "AXWindow", subrole: "AXStandardWindow", title: "Ember Bench (macOS)", frame: at(100, 100, 480, 600), main: true,
      focused: true, windowId, id: "window",
      children: [
        { role: "AXButton", subrole: "AXCloseButton", frame: at(108, 104, 14, 14), actions: ["AXPress"] },
        { role: "AXStaticText", value: "Name", id: "nameLabel", frame: at(120, 140, 80, 20) },
        { role: "AXTextField", description: "Name", titleElement: "nameLabel", id: "name", value: "", frame: at(210, 136, 240, 24),
          enabled: true, focused: true, settable: ["AXValue", "AXFocused"], actions: ["AXConfirm", "AXShowMenu"] },
        { role: "AXStaticText", value: "Password", id: "passwordLabel", frame: at(120, 176, 80, 20) },
        { role: "AXTextField", subrole: "AXSecureTextField", description: "Password", titleElement: "passwordLabel", id: "password",
          value: "hunter2", frame: at(210, 172, 240, 24), enabled: true, focused: false, settable: ["AXValue", "AXFocused"] },
        { role: "AXCheckBox", title: "Remember me", id: "remember", value: 0, frame: at(210, 208, 160, 22), enabled: true, focused: false,
          settable: ["AXFocused"], actions: ["AXPress"] },
        { role: "AXPopUpButton", description: "Theme", id: "theme", value: "Light", frame: at(210, 240, 160, 26), enabled: true,
          focused: false, settable: ["AXFocused"], actions: ["AXPress", "AXShowMenu"] },
        { role: "AXSlider", description: "Volume", id: "volume", value: 50, min: 0, max: 100, frame: at(210, 280, 200, 24), enabled: true,
          focused: false, settable: ["AXValue", "AXFocused"], actions: ["AXIncrement", "AXDecrement"] },
        { role: "AXScrollArea", id: "notesScroll", frame: at(210, 316, 240, 60), children: [
          { role: "AXTextArea", description: "Notes", id: "notes", value: "First line\nSecond line", frame: at(210, 316, 240, 60),
            enabled: true, focused: false, settable: ["AXValue", "AXFocused"] },
        ] },
        { role: "AXScrollArea", id: "listScroll", frame: at(120, 400, 200, 240), children: [
          { role: "AXTable", description: "Rows", id: "list", frame: at(120, 400, 200, 4000), focused: false, settable: ["AXFocused"],
            visibleRows: Array.from({ length: 12 }, (_, i) => i), children: rows },
        ] },
        { role: "AXButton", title: "Save", id: "save", frame: at(340, 660, 90, 30), enabled: true, focused: false, settable: ["AXFocused"],
          actions: ["AXPress"] },
      ],
    }],
  };
}
