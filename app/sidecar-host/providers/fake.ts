/**
 * An in-memory desktop for the sidecar host's tests: windows of elements described as plain objects (or JSON, for a
 * test that runs the built host as its own process: EMBER_AX_FAKE_DESKTOP), behaving as a platform's accessibility
 * does where the host relies on it. A snapshot is pre-order with the bridge's caps and cut reasons, leaves out
 * elements that are off screen with no bounds, lists what shows before what doesn't, and reads nothing inside an
 * offscreen element (but a combo box's drop-down); every look is live (a test changes an element between calls); actions
 * change the elements (a toggle flips, a select selects alone in a single-choice list, a value is set) and are logged;
 * an element can be slow (its app "busy"), go away, or open a modal dialog when invoked. Every call hands out a new
 * handle, as a naive bridge would, so tests see the host give them all back. Never used outside tests and development
 * (providers/index.ts).
 */

import fs from "node:fs";
import {
  ProviderError, type AxProvider, type Handle, type PerformOp, type ProviderHealth, type RawNode, type RawWindow, type Rect,
  type Snapshot, type SnapshotOptions, type TextInfo,
} from "../provider";

/** What happens when an element is invoked (JSON-friendly; a test may give a function instead). */
export type FakeEffect =
  | "remove"            // the element goes away (an OK button closing its own dialog closes the window it is in)
  | "closeWindow"       // its window closes
  | { dialog: FakeElementSpec } // a modal dialog of the same app opens (and the call doesn't come back in time)
  | { hangMs: number }; // the app doesn't answer for this long (the call fails as busy)

/** An element as a test describes it (platform words: UI Automation's unless the desktop is built with "ax"). */
export interface FakeElementSpec {
  role: string;
  name?: string;
  subrole?: string;
  className?: string;
  framework?: string;
  bounds?: Rect | null;
  enabled?: boolean;
  focusable?: boolean;
  focused?: boolean;
  offscreen?: boolean;
  password?: boolean;
  editable?: boolean;
  multiLine?: boolean;
  toggle?: "on" | "off" | "mixed";
  expanded?: boolean | null;
  selected?: boolean;
  modal?: boolean;
  /** Its value (a field's text, a combo box's choice). */
  value?: string;
  /** Its whole text (textInfo), where it is longer than or other than its value. */
  text?: string;
  selectionText?: string;
  /** Where the caret is in its text, and whether that is its end. */
  caret?: number;
  caretAtEnd?: boolean;
  range?: { value: number; min: number; max: number; step?: number; readOnly?: boolean };
  /** It chooses among its children. */
  selection?: { multiple: boolean };
  /**
   * An item of a classic Win32 list box (behind .NET's UI Automation proxy): giving it the keyboard selects it too,
   * telling its app nothing (LB_SETCURSEL without LBN_SELCHANGE: no log line), so only its Select is heard.
   */
  focusSelects?: boolean;
  actions?: string[];
  labelledBy?: string;
  help?: string;
  placeholder?: string;
  /** Its own native window (a Win32 child window: an edit box, a document's own window). */
  native?: number;
  /**
   * Its app says it has its keyboard while another app's window has it (macOS: the app's AXFocusedUIElement while
   * Ember's ask box has the keyboard): what focusedKey answers.
   */
  appFocus?: boolean;
  /** Every call about it takes this long (an app that is slow to answer). */
  slowMs?: number;
  /** What invoking it does (besides logging it). */
  onInvoke?: FakeEffect | ((el: FakeElement, desktop: FakeProvider) => void);
  children?: FakeElementSpec[];
}

/** A top-level window as a test describes it. */
export interface FakeWindowSpec extends FakeElementSpec {
  pid: number;
  app: string;
  /** Its native id (and so its key on the wire). */
  native?: number;
  active?: boolean;
  /** Its app doesn't answer: the window list says so, and every call about it is busy. */
  busy?: boolean;
}

/** One live element of the fake desktop. */
export class FakeElement {
  readonly uid: number;
  spec: FakeElementSpec;
  parent: FakeElement | null;
  children: FakeElement[] = [];
  gone = false;

  constructor(spec: FakeElementSpec, parent: FakeElement | null, uid: () => number) {
    this.uid = uid();
    this.spec = { ...spec, children: undefined };
    this.parent = parent;
    for (const c of spec.children ?? []) this.children.push(new FakeElement(c, this, uid));
  }

  /** The window it is in. */
  get window(): FakeElement {
    return this.parent ? this.parent.window : this;
  }

  /** Finds the first element (itself included) called `name`, of `role` where given. */
  find(name: string, role?: string): FakeElement | undefined {
    if ((this.spec.name ?? "") === name && (!role || this.spec.role === role)) return this;
    for (const c of this.children) {
      const f = c.find(name, role);
      if (f) return f;
    }
    return undefined;
  }

  /** Adds a child (a test changing the window). */
  add(spec: FakeElementSpec, uid: () => number): FakeElement {
    const el = new FakeElement(spec, this, uid);
    this.children.push(el);
    return el;
  }
}

/** A line of the fake desktop's log: what was done to which element. */
export interface FakeLogLine { op: string; name: string; role: string; value?: unknown }

export interface FakeOptions {
  /** The role words its elements use (default UI Automation's). */
  vocabulary?: "uia" | "ax";
  /** A file every logged action is appended to, one JSON line each (for a test reading another process's log). */
  logFile?: string;
  /** Answer busy when a call about one element takes longer than this (the bridge's deadline). */
  deadlineMs?: number;
  /** start() fails with this message (a bridge that can't run). */
  failStart?: string;
  /** Hit tests are app by app (AX's), not of the whole screen (UI Automation's): see elementsAt. */
  appHitTest?: boolean;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const inside = (b: Rect | null | undefined, x: number, y: number) => !!b && b.x <= x && x < b.x + b.width && b.y <= y && y < b.y + b.height;
const empty = (b: Rect | null | undefined) => !b || b.width <= 0 || b.height <= 0;
/** The UI Automation bridge's long level (PROTOCOL.md, snapshot): past this many children with theirs... */
const LONG_LEVEL = 400;
/** ...only this many of the offscreen children are listed, the rest cut "offscreen". */
const LISTED_OFFSCREEN = 50;

/** The fake desktop as an AxProvider. */
export class FakeProvider implements AxProvider {
  readonly kind = "fake" as const;
  readonly vocabulary: "uia" | "ax";
  generation = 1;
  windows: FakeElement[] = [];
  readonly log: FakeLogLine[] = [];
  /** Handles given back (all of them, in order). */
  readonly released: Handle[] = [];
  started = 0;
  /** start() calls, whether they worked or not. */
  startsTried = 0;
  /** The pid of every elementsAt call (undefined where none was given): the app a hit test was scoped to. */
  readonly hitPids: (number | undefined)[] = [];
  stopped = false;
  private handles = new Map<Handle, FakeElement>();
  private nextHandle = 1;
  private nextUid = 1;
  private uid = () => this.nextUid++;

  constructor(windows: FakeWindowSpec[] = [], private o: FakeOptions = {}) {
    this.vocabulary = o.vocabulary ?? "uia";
    for (const w of windows) this.open(w);
  }

  /** Opens a window (in front of the others). */
  open(spec: FakeWindowSpec): FakeElement {
    const w = new FakeElement({ ...spec, native: spec.native ?? 0x10000 + this.windows.length * 16 } as FakeWindowSpec, null, this.uid);
    this.windows.unshift(w);
    return w;
  }

  /** The window titled `title`. */
  window(title: string): FakeElement {
    const w = this.windows.find(x => (x.spec.name ?? "") === title && !x.gone);
    if (!w) throw new Error(`no window "${title}"`);
    return w;
  }

  /** The element called `name` (of `role`) in any open window. */
  el(name: string, role?: string): FakeElement {
    for (const w of this.windows) {
      const f = w.gone ? undefined : w.find(name, role);
      if (f) return f;
    }
    throw new Error(`no element "${name}"`);
  }

  /** Adds an element to `parent` (a test changing a window). */
  add(parent: FakeElement, spec: FakeElementSpec): FakeElement {
    return parent.add(spec, this.uid);
  }

  /** Removes an element (and what it holds). */
  remove(el: FakeElement): void {
    el.gone = true;
    if (el.parent) el.parent.children = el.parent.children.filter(c => c !== el);
    else this.windows = this.windows.filter(w => w !== el);
  }

  /** The provider "restarted": handles from before mean nothing. */
  restart(): void {
    this.generation++;
    this.handles.clear();
  }

  /** Handles given out and not given back. */
  get live(): number {
    return this.handles.size;
  }

  async start(): Promise<void> {
    this.startsTried++;
    if (this.o.failStart) throw new Error(this.o.failStart);
    this.started++;
  }

  async accessibility(): Promise<boolean | null> {
    return true;
  }

  health(): ProviderHealth {
    if (this.o.failStart) return { ok: this.startsTried ? false : null, ...(this.startsTried ? { detail: this.o.failStart } : {}) };
    return { ok: this.started > 0 ? true : null };
  }

  async topWindows(): Promise<RawWindow[]> {
    return this.windows.filter(w => !w.gone).map(w => {
      const s = w.spec as FakeWindowSpec;
      const busy = !!s.busy;
      return {
        handle: this.handle(w), key: String(s.native), pid: s.pid, app: s.app, title: busy ? "" : s.name ?? "",
        platformRole: s.role, platformSubrole: s.subrole, className: s.className, bounds: s.bounds ?? null, modal: s.modal,
        active: !!s.active, offscreen: s.offscreen, native: s.native, ...(busy ? { busy } : {}),
      };
    });
  }

  async snapshot(h: Handle, o: SnapshotOptions): Promise<Snapshot> {
    const w = this.get(h);
    this.ensureAnswering(w);
    const nodes: RawNode[] = [];
    const cut: string[] = [];
    const until = Date.now() + o.deadlineMs;
    let busy = false;
    const cutShort = (why: string) => { if (!cut.includes(why)) cut.push(why); };
    // As the bridge walks (PROTOCOL.md, snapshot): what shows first, nothing inside an offscreen element (but a combo
    // box's closed drop-down), and an offscreen element left out past maxNodes, or past a long level's first 50 (UI
    // Automation's only), is cut "offscreen", not "nodes".
    const visit = async (el: FakeElement, parent: number, depth: number, inCombo: boolean): Promise<boolean> => {
      if (el.spec.offscreen && empty(el.spec.bounds)) return true; // the bridge leaves these out, with what they hold
      const offscreen = depth > 0 && !!el.spec.offscreen;
      if (depth > o.maxDepth) { cutShort("depth"); return true; }
      if (nodes.length >= o.maxNodes) {
        if (offscreen) { cutShort("offscreen"); return true; }
        cutShort("nodes");
        return false;
      }
      if (Date.now() >= until) { cutShort("time"); return false; }
      if (el.spec.slowMs) {
        const left = Math.max(0, until - Date.now());
        await sleep(Math.min(el.spec.slowMs, left));
        if (this.o.deadlineMs !== undefined && el.spec.slowMs > this.o.deadlineMs) { busy = true; return false; }
        // An element that outlasts the deadline ends the walk there, as the bridge's does. Not left to the next
        // element's clock check: Windows timers can wake a millisecond before Date.now() reaches `until`.
        if (el.spec.slowMs >= left) { cutShort("time"); return false; }
      }
      const index = nodes.length;
      nodes.push(this.raw(el, parent, depth));
      const combo = inCombo || el.spec.role === "ComboBox" || el.spec.role === "AXComboBox";
      if (offscreen && !combo) return true;
      let hidden = el.children.filter(c => c.spec.offscreen);
      if (this.vocabulary === "uia" && !combo && el.children.reduce((n, c) => n + 1 + c.children.length, 0) > LONG_LEVEL) {
        const listed = hidden.filter(c => !empty(c.spec.bounds));
        if (listed.length > LISTED_OFFSCREEN) { hidden = listed.slice(0, LISTED_OFFSCREEN); cutShort("offscreen"); }
      }
      const kids = [...el.children.filter(c => !c.spec.offscreen), ...hidden];
      for (const c of kids) if (!await visit(c, index, depth + 1, combo)) return false;
      return true;
    };
    await visit(w, -1, 0, false);
    return { nodes, truncated: cut.length > 0, cut, ...(busy ? { busy } : {}) };
  }

  async element(h: Handle): Promise<RawNode | null> {
    const el = this.handles.get(h);
    if (!el || el.gone || !this.attached(el)) return null;
    this.ensureAnswering(el);
    await this.slow(el);
    return this.raw(el, -1, this.depthOf(el));
  }

  /**
   * Whatever window is on top at the point, as UI Automation hit-tests; with `appHitTest`, within app `pid`'s windows
   * where it is given, as AX does.
   */
  async elementsAt(x: number, y: number, pid?: number): Promise<RawNode[]> {
    this.hitPids.push(pid);
    const scoped = this.o.appHitTest && pid !== undefined;
    const w = this.windows.find(win => !win.gone && !win.spec.offscreen && inside(win.spec.bounds, x, y)
      && (!scoped || (win.spec as FakeWindowSpec).pid === pid));
    if (!w) return [];
    this.ensureAnswering(w);
    const chain = [w];
    let cur = w;
    for (;;) {
      const here = cur.children.filter(c => !c.spec.offscreen && inside(c.spec.bounds, x, y));
      if (!here.length) break;
      cur = here[here.length - 1];
      chain.push(cur);
    }
    return chain.map((el, i) => this.raw(el, i - 1, i));
  }

  async focused(): Promise<{ element: RawNode | null; window: Handle | null }> {
    for (const w of this.windows) {
      const f = this.findIn(w, e => !!e.spec.focused);
      if (f) return { element: this.raw(f, -1, this.depthOf(f)), window: this.handle(w) };
    }
    return { element: null, window: null };
  }

  /** The element app `pid` says has its keyboard (`appFocus`), as a macOS app keeps it while another app has it. */
  async focusedKey(pid: number): Promise<string | null> {
    for (const w of this.windows) {
      if ((w.spec as FakeWindowSpec).pid !== pid) continue;
      this.ensureAnswering(w);
      const f = this.findIn(w, e => !!e.spec.appFocus);
      if (f) return `${pid}:${f.uid}`; // its key, as raw() gives it
    }
    return null;
  }

  async children(h: Handle, max: number): Promise<RawNode[]> {
    const el = this.get(h);
    this.ensureAnswering(el);
    await this.slow(el);
    const depth = this.depthOf(el) + 1;
    return el.children.slice(0, Math.max(0, max)).map(c => this.raw(c, -1, depth));
  }

  async perform(h: Handle, op: PerformOp, value?: unknown): Promise<void> {
    const el = this.get(h);
    this.ensureAnswering(el);
    await this.slow(el);
    const s = el.spec;
    const can = (a: string) => !!s.actions?.includes(a);
    const need = (a: string) => { if (!can(a)) throw new ProviderError("failed", `unsupported:${op}`); };
    switch (op) {
      case "invoke": case "legacy": {
        need(op);
        this.record(op, el);
        const effect = s.onInvoke;
        if (typeof effect === "function") effect(el, this);
        else if (effect === "remove") this.remove(el);
        else if (effect === "closeWindow") this.remove(el.window);
        else if (effect && "dialog" in effect) {
          const owner = el.window.spec as FakeWindowSpec;
          for (const w of this.windows) (w.spec as FakeWindowSpec).active = false;
          this.open({ ...effect.dialog, pid: owner.pid, app: owner.app, modal: true, active: true } as FakeWindowSpec);
          // A modal dialog's own loop runs inside the call: it doesn't come back in time.
          throw new ProviderError("busy", "the call didn't come back in time");
        } else if (effect && "hangMs" in effect) {
          await sleep(effect.hangMs);
          throw new ProviderError("busy", "the call didn't come back in time");
        }
        return;
      }
      case "toggle":
        need("toggle");
        s.toggle = s.toggle === "on" ? "off" : "on";
        this.record(op, el, s.toggle);
        return;
      case "select": case "addToSelection": {
        need("select");
        const list = el.parent;
        // UI Automation's Select on what a single-choice list has selected already does nothing (and tells nobody).
        if (op === "select" && s.selected && !list?.spec.selection?.multiple) return;
        if (op === "select" && list) for (const c of list.children) if (c !== el) c.spec.selected = false;
        s.selected = true;
        // A combo box with a value (an editable one) shows the option chosen in it.
        const combo = list?.spec.role === "ComboBox" ? list : list?.parent?.spec.role === "ComboBox" ? list.parent : null;
        if (combo && combo.spec.value !== undefined) combo.spec.value = s.name ?? "";
        this.record(op, el);
        return;
      }
      case "removeFromSelection":
        need("select");
        s.selected = false;
        this.record(op, el);
        return;
      case "expand": case "collapse":
        if (!can("expand") && !can("collapse")) throw new ProviderError("failed", `unsupported:${op}`);
        s.expanded = op === "expand";
        this.record(op, el);
        return;
      case "setValue":
        if (s.password) throw new ProviderError("denied", "a password field's value isn't set");
        need("setValue");
        s.value = String(value);
        s.text = undefined;
        this.record(op, el, String(value).length);
        return;
      case "setRange":
        need("setRange");
        s.range = { ...s.range!, value: Number(value) };
        this.record(op, el, Number(value));
        return;
      case "focus":
        need("focus");
        for (const w of this.windows) this.findIn(w, e => { e.spec.focused = false; return false; });
        s.focused = true;
        if (s.focusSelects && el.parent) {
          for (const c of el.parent.children) c.spec.selected = c === el;
        }
        this.record(op, el);
        return;
      case "scrollIntoView":
        this.record(op, el);
        return;
    }
  }

  async textInfo(h: Handle, maxChars: number): Promise<TextInfo> {
    const el = this.get(h);
    this.ensureAnswering(el);
    await this.slow(el);
    const s = el.spec;
    if (s.password) return { secret: true };
    const text = s.text ?? s.value;
    return {
      ...(text !== undefined ? { text: text.slice(0, maxChars) } : {}),
      ...(s.selectionText ? { selection: s.selectionText } : {}),
      ...(s.caret !== undefined ? { caret: s.caret } : {}),
      ...(s.caretAtEnd !== undefined ? { caretAtEnd: s.caretAtEnd } : {}),
    };
  }

  release(hs: Handle[]): void {
    for (const h of hs) {
      this.handles.delete(h);
      this.released.push(h);
    }
  }

  stop(): void {
    this.stopped = true;
  }

  private record(op: string, el: FakeElement, value?: unknown): void {
    const line: FakeLogLine = { op, name: el.spec.name ?? "", role: el.spec.role, ...(value !== undefined ? { value } : {}) };
    this.log.push(line);
    if (this.o.logFile) fs.appendFileSync(this.o.logFile, JSON.stringify(line) + "\n");
  }

  private handle(el: FakeElement): Handle {
    const h = this.nextHandle++;
    this.handles.set(h, el);
    return h;
  }

  private get(h: Handle): FakeElement {
    const el = this.handles.get(h);
    if (!el || el.gone || !this.attached(el)) throw new ProviderError("gone", "the element isn't there any more");
    return el;
  }

  /** Is it still in an open window (not inside something removed)? */
  private attached(el: FakeElement): boolean {
    for (let e: FakeElement | null = el; e; e = e.parent) if (e.gone) return false;
    return this.windows.includes(el.window);
  }

  private ensureAnswering(el: FakeElement): void {
    if ((el.window.spec as FakeWindowSpec).busy) throw new ProviderError("busy", "its app is busy");
  }

  private async slow(el: FakeElement): Promise<void> {
    const ms = el.spec.slowMs;
    if (!ms) return;
    if (this.o.deadlineMs !== undefined && ms > this.o.deadlineMs) {
      await sleep(this.o.deadlineMs);
      throw new ProviderError("busy", "its app didn't answer in time");
    }
    await sleep(ms);
  }

  private depthOf(el: FakeElement): number {
    let d = 0;
    for (let e = el.parent; e; e = e.parent) d++;
    return d;
  }

  private findIn(el: FakeElement, test: (e: FakeElement) => boolean): FakeElement | undefined {
    if (test(el)) return el;
    for (const c of el.children) {
      const f = this.findIn(c, test);
      if (f) return f;
    }
    return undefined;
  }

  private raw(el: FakeElement, parent: number, depth: number): RawNode {
    const s = el.spec;
    const pid = (el.window.spec as FakeWindowSpec).pid;
    const n: RawNode = {
      handle: this.handle(el), key: `${pid}:${el.uid}`, parent, depth, platformRole: s.role, name: s.name ?? "",
      bounds: s.bounds === undefined ? null : s.bounds, pid,
    };
    const copy = ["subrole", "className", "framework", "labelledBy", "help", "placeholder", "enabled", "focusable", "focused",
      "offscreen", "password", "editable", "multiLine", "toggle", "expanded", "selected", "modal", "range", "selection", "actions"] as const;
    for (const k of copy) if (s[k] !== undefined) (n as unknown as Record<string, unknown>)[k === "subrole" ? "platformSubrole" : k] = s[k];
    if (s.value !== undefined && !s.password) n.value = s.value.slice(0, 2000);
    if (s.text !== undefined && !s.password) n.hasText = true;
    if (s.native !== undefined) n.native = s.native;
    return n;
  }
}

/**
 * The fake desktop used where none is given: a stand-in for Ember's WinForms bench (test/fixtures/win_bench.ps1), the
 * same controls the Windows end-to-end test works with, named as UI Automation names them there: each label says what
 * its control's accessible name says ("Theme" the label and "Theme" the drop-down, told apart only by role), and the
 * drop-down list (DropDownList) has no Value pattern, so what it has chosen is read from its options.
 */
export function benchDesktop(pid = 4242): FakeWindowSpec[] {
  const at = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });
  const text = ["focus"];
  return [{
    role: "Window", name: "Ember Bench (Windows)", pid, app: "powershell", className: "WindowsForms10.Window.8.app.0.1",
    framework: "WinForm", bounds: at(100, 100, 480, 420), active: true, native: 0x2a0b2,
    children: [
      { role: "TitleBar", name: "Ember Bench (Windows)", bounds: at(108, 101, 464, 30) },
      { role: "Text", name: "Name", bounds: at(120, 150, 80, 20) },
      { role: "Edit", name: "Name", bounds: at(210, 146, 240, 26), value: "", editable: true, focusable: true, actions: ["setValue", ...text] },
      { role: "Text", name: "Password", bounds: at(120, 190, 80, 20) },
      { role: "Edit", name: "Password", bounds: at(210, 186, 240, 26), password: true, editable: true, focusable: true, actions: ["setValue", ...text] },
      { role: "CheckBox", name: "Remember me", bounds: at(210, 226, 160, 24), toggle: "off", focusable: true, actions: ["toggle", "focus"] },
      { role: "Text", name: "Theme", bounds: at(120, 266, 80, 20) },
      {
        role: "ComboBox", name: "Theme", bounds: at(210, 262, 160, 26), expanded: false, selection: { multiple: false },
        focusable: true, actions: ["expand", "collapse", "focus"], children: [
          { role: "List", name: "Theme", bounds: null, offscreen: true, selection: { multiple: false }, children: ["Light", "Dark", "System"].map((name, i) => ({
            role: "ListItem", name, bounds: null, offscreen: true, selected: i === 0, actions: ["select", "scrollIntoView"],
          })) },
          { role: "Button", name: "Open", bounds: at(350, 264, 18, 22), actions: ["invoke"] },
        ],
      },
      { role: "Text", name: "Volume", bounds: at(120, 306, 80, 20) },
      { role: "Slider", name: "Volume", bounds: at(210, 302, 200, 30), range: { value: 50, min: 0, max: 100, step: 1 }, focusable: true, actions: ["setRange", "focus"] },
      { role: "Text", name: "Fruit", bounds: at(120, 342, 80, 20) },
      {
        role: "List", name: "Fruit", bounds: at(420, 150, 140, 80), selection: { multiple: false }, focusable: true, actions: ["focus"],
        children: ["Apple", "Banana", "Cherry"].map((name, i) => ({
          role: "ListItem", name, bounds: at(422, 152 + i * 20, 136, 20), selected: false, focusSelects: true, actions: ["select", "focus", "scrollIntoView"],
        })),
      },
      { role: "Button", name: "Save", bounds: at(210, 350, 90, 30), focusable: true, actions: ["invoke", "focus"] },
      {
        role: "Button", name: "Open dialog", bounds: at(310, 350, 120, 30), focusable: true, actions: ["invoke", "focus"],
        onInvoke: { dialog: {
          role: "Window", name: "Saved?", className: "#32770", bounds: at(220, 220, 260, 140), children: [
            { role: "Text", name: "Saved?", bounds: at(240, 250, 100, 20) },
            { role: "Button", name: "OK", bounds: at(380, 320, 80, 26), actions: ["invoke", "focus"], onInvoke: "closeWindow" },
          ],
        } },
      },
    ],
  }];
}

/** A fake desktop read from JSON (EMBER_AX_FAKE_DESKTOP: a file of FakeWindowSpec[]), or the bench without one. */
export function fakeFromEnv(env: NodeJS.ProcessEnv): FakeProvider {
  const file = env.EMBER_AX_FAKE_DESKTOP;
  const windows = file ? JSON.parse(fs.readFileSync(file, "utf8")) as FakeWindowSpec[] : benchDesktop();
  return new FakeProvider(windows, { logFile: env.EMBER_AX_FAKE_LOG || undefined, deadlineMs: 800 });
}
