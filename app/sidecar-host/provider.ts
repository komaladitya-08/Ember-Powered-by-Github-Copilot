/**
 * The contract between Ember's accessibility sidecar host (app/sidecar-host) and the platform below it: Windows UI
 * Automation through the C# bridge (providers/uia.ts), macOS AX (a later provider), or an in-memory desktop for tests
 * (providers/fake.ts). A provider reports raw platform facts and does raw platform actions; every protocol rule (ids,
 * secrets, labels, the AT-SPI vocabulary, budgets, verification and wording) lives in the host, so all platforms answer
 * Ember alike. It is coarse on purpose: a read of a window is one snapshot, not hundreds of calls, because a call to
 * the Windows bridge is a round trip to another process and AX calls block until the app answers.
 *
 * Units: what the platform reports, never scaled (Windows: physical pixels; macOS: points). Handles are numbers the
 * provider gives out and takes back (`release`); they mean nothing after the provider restarts (`generation`).
 */

/** A rectangle in the platform's screen units. */
export interface Rect { x: number; y: number; width: number; height: number }

/** An element or window as the provider names it for later calls (Windows: the bridge's handle table). */
export type Handle = number;

/** What went wrong in a provider call: the host turns each into the protocol's wording. */
export type ProviderErrorCode = "busy" | "gone" | "denied" | "failed" | "unsupported";

/**
 * A provider call that couldn't be done: `busy` (the app didn't answer in time; it may still be doing it), `gone` (the
 * element or window isn't there any more), `denied` (the platform refused: a password field's value), `unsupported`
 * (the element has no such pattern or action), `failed` (anything else; the message says what).
 */
export class ProviderError extends Error {
  constructor(readonly code: ProviderErrorCode, message: string) {
    super(message);
    this.name = "ProviderError";
  }
}

/** Is this a provider error with one of `codes`? */
export const isProviderError = (err: unknown, ...codes: ProviderErrorCode[]): err is ProviderError =>
  err instanceof ProviderError && (!codes.length || codes.includes(err.code));

/** A top-level window as the platform lists it. */
export interface RawWindow {
  /** For snapshot(); released by the host when it is done with it. */
  handle: Handle;
  /**
   * Names this window for as long as it is open, whatever its title: the protocol's window `path` (Windows: the HWND
   * in decimal; macOS: the CGWindowID).
   */
  key: string;
  pid: number;
  /** The app's name (Windows: its program's file name without ".exe"; macOS: its localized name). */
  app: string;
  title: string;
  /** The platform's own role ("Window", "Pane", "Menu" on Windows; "AXWindow" on macOS). */
  platformRole: string;
  platformSubrole?: string;
  /** Windows: the window class ("#32770", "Credential Dialog Xaml Host"). */
  className?: string;
  bounds: Rect | null;
  modal?: boolean;
  /** The window the user is in (it, or something in it, has the keyboard). */
  active?: boolean;
  /** Minimised, cloaked or otherwise not on screen. */
  offscreen?: boolean;
  /** Its app didn't answer in time: what is known of it may be partial (it is listed as last seen). */
  busy?: boolean;
  /** The native window id (HWND, CGWindowID), when there is one. */
  native?: number;
}

/**
 * One element as a snapshot, a look or a hit test reports it. Optional facts are left out when the platform doesn't
 * say (an element that can't be enabled or disabled has no `enabled`). Never the value of a password field.
 */
export interface RawNode {
  handle: Handle;
  /**
   * Names the element across provider restarts for as long as it lives in its app (Windows: "<pid>:<RuntimeId>"): the
   * host remembers secret fields by it, and Ember hands those keys to every new host process.
   */
  key: string;
  /** In a snapshot: the index of its parent in the same answer (-1 for the window itself). */
  parent: number;
  /** In a snapshot: how deep below the window it is (0: the window). */
  depth: number;
  /** The platform's role: a UIA ControlType without "ControlType." ("Button", "Edit"), or an AX role ("AXButton"). */
  platformRole: string;
  /** macOS: the AX subrole ("AXSecureTextField"); Windows: the localized control type ("heading", in English only). */
  platformSubrole?: string;
  /** Windows: the class name ("Edit", "ToggleSwitch", "ConsoleWindowClass"). */
  className?: string;
  /** Windows: the UI framework ("Win32", "WinForm", "WPF", "XAML", "Chrome", "Gecko"). */
  framework?: string;
  pid?: number;
  name: string;
  /** The name of the element that labels it (UIA LabeledBy, AX AXTitleUIElement). */
  labelledBy?: string;
  /** Its help text (UIA HelpText, where Chromium puts a field's placeholder). */
  help?: string;
  /** Its placeholder (AX AXPlaceholderValue). */
  placeholder?: string;
  bounds: Rect | null;
  enabled?: boolean;
  focused?: boolean;
  focusable?: boolean;
  /** Not on screen: scrolled out of view, hidden, in a closed menu. Never listed, nor anything in it. */
  offscreen?: boolean;
  /** A password field: its value is never read. */
  password?: boolean;
  /** Its text can be typed into or set (UIA: a writable ValuePattern, or editable text; AX: AXValue settable). */
  editable?: boolean;
  /** More than one line of text (an AX text area; a multi-line edit where the platform says so). */
  multiLine?: boolean;
  /** A check box's or toggle's state. */
  toggle?: "on" | "off" | "mixed";
  /** Expandable: true when expanded, false when collapsed; null for a leaf that can't expand. */
  expanded?: boolean | null;
  /** Selected among its container's items (a list's row, a tab, a radio button). */
  selected?: boolean;
  /** A window or dialog that must be answered first. */
  modal?: boolean;
  /** Its text value (UIA ValuePattern, AX AXValue as text), cut to 2000 characters by the provider; never a password's. */
  value?: string;
  /** Has text that `textInfo` can read (UIA TextPattern, AX AXValue of a text area) beyond `value`. */
  hasText?: boolean;
  /** A number it holds and can be set to (UIA RangeValue, AX slider). */
  range?: { value: number; min: number; max: number; step?: number; readOnly?: boolean };
  /** It chooses among its children (UIA SelectionPattern, AX AXSelectedChildren). */
  selection?: { multiple: boolean };
  /**
   * What can be done to it, in the host's words: invoke, toggle, select, expand, collapse, setValue, setRange, focus,
   * legacy (UIA's LegacyIAccessible default action: the app's own verb, which may be done on an ancestor), scrollIntoView.
   */
  actions?: string[];
  grid?: { rows: number; columns: number };
  cell?: { row: number; column: number };
  native?: number;
  /** The element went away while it was being read (UIA ElementNotAvailable). */
  gone?: boolean;
}

/** How much a snapshot may take: its depth, its node count, and its time. */
export interface SnapshotOptions { maxDepth: number; maxNodes: number; deadlineMs: number }

/**
 * A window's elements, pre-order, `nodes[0]` the window itself (none when it is gone). `truncated` with `cut`: what
 * was left out ("nodes": past maxNodes; "depth": deeper than maxDepth; "time": past the deadline). `busy`: the app
 * stopped answering partway. A provider may leave out elements that are off screen with no bounds, with all they hold.
 */
export interface Snapshot { nodes: RawNode[]; truncated: boolean; cut: string[]; busy?: boolean }

/** Text read from an element: none of it for a password field (`secret`). `caretAtEnd`: the caret is after the last character. */
export interface TextInfo { text?: string; selection?: string; caretAtEnd?: boolean; secret?: boolean }

/** What `perform` can be asked to do (see RawNode.actions). */
export type PerformOp = "invoke" | "toggle" | "select" | "addToSelection" | "removeFromSelection" | "expand" | "collapse"
  | "setValue" | "setRange" | "focus" | "legacy" | "scrollIntoView";

/**
 * A platform's accessibility. Every call may throw a ProviderError; anything else thrown counts as "failed". Calls are
 * made one request at a time by the host, but a provider must answer each within its own deadline even when an app
 * hangs (a hung app's calls fail with "busy" at once while it stays hung; other apps keep answering).
 */
export interface AxProvider {
  /** Which platform this is ("fake": tests). */
  readonly kind: "uia" | "ax" | "fake";
  /** Which role vocabulary its nodes use (roles.ts maps each to AT-SPI's). */
  readonly vocabulary: "uia" | "ax";
  /** Goes up whenever the provider restarted: handles from an earlier generation name nothing. */
  readonly generation: number;
  /** Ready to answer (Windows: the bridge started and said it is ready). Called before every request; cheap once started. */
  start(): Promise<void>;
  /** Whether accessibility is on for Ember (macOS: the Accessibility permission), or null when that can't be told. */
  accessibility(): Promise<boolean | null>;
  /** The top-level windows, front to back where the platform says. */
  topWindows(): Promise<RawWindow[]>;
  snapshot(window: Handle, o: SnapshotOptions): Promise<Snapshot>;
  /** The element as it is now (null: gone). */
  element(h: Handle): Promise<RawNode | null>;
  /** What is at a screen point: its top-level window first, down to the deepest element there. */
  elementsAt(x: number, y: number): Promise<RawNode[]>;
  /** The element with the keyboard, and its top-level window. */
  focused(): Promise<{ element: RawNode | null; window: Handle | null }>;
  /** Its first `max` children as they are now (offscreen ones too: a closed drop-down's options). */
  children(h: Handle, max: number): Promise<RawNode[]>;
  perform(h: Handle, op: PerformOp, value?: unknown): Promise<void>;
  textInfo(h: Handle, maxChars: number): Promise<TextInfo>;
  /** These handles won't be used again. */
  release(hs: Handle[]): void;
  /** Stops for good (the host is exiting). */
  stop(): void;
}
