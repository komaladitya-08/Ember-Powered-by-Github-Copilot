/** Normal Windows input and existing UIA transport for the separate packaged WSL proof. No app/debug/IPC seam. */
import type { openWin32Input } from "../../app/main/platform/win32/input";
import type { RawNode, UiaBridge, UiaWindow } from "../integration/uia-client";

type Input = NonNullable<ReturnType<typeof openWin32Input>>;
export type WslUiSelector = (node: RawNode) => boolean;
type SnapshotGuard = (nodes: readonly RawNode[]) => void;
export const wslUiId = (id: string): WslUiSelector => node => node.automationId === id;
export const wslUiName = (name: string): WslUiSelector => node => node.name === name;
export function sameWslUiNode(left: RawNode, right: RawNode): boolean {
  return !!left.runtimeId && Number.isSafeInteger(left.pid) && left.pid! > 0 && left.runtimeId === right.runtimeId && left.pid === right.pid &&
    left.automationId === right.automationId && left.controlType === right.controlType;
}
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export interface WslUiPorts {
  bridge: Pick<UiaBridge, "call" | "request">;
  input: Input;
  pid: number;
  current(): void;
  deadline: number;
  refuse(): Error;
}

/** Fresh focus/identity/foreground guards are repeated before ordinary input; uncertainty never becomes a retry. */
export class WslPackagedUi {
  /** Last reached operation only, never evidence that an action succeeded. */
  operation = 0;
  /** How far the last `text` read got: 1 finding the control, 2 its text, 3 that text's own limits, 4 its children's read, 5 that read's limits, 0 done. */
  textStage = 0;
  /** Why the last window read was refused: 1 the bridge's own error, 2 cut short, 3 a whole read that listed nothing; 0 it was not. */
  readRefusal = 0;
  /** The bridge's last refusal of a control's text: 1 busy, 2 gone, 3 failed, 4 denied, 5 another, 6 no answer; 0 none. */
  textError = 0;
  constructor(private readonly p: WslUiPorts) {}
  private fail(): never { throw this.p.refuse(); }
  private current(): void { this.p.current(); if (Date.now() >= this.p.deadline) this.fail(); }
  async until<T>(read: () => Promise<T>, accepts: (value: T) => boolean, ms = 30_000): Promise<T> {
    const end = Math.min(this.p.deadline, Date.now() + ms);
    while (Date.now() < end) {
      this.current(); const value = await read(); this.current();
      const accepted = accepts(value); this.current(); if (accepted) return value;
      await pause(150);
    }
    this.fail();
  }
  async windows(): Promise<UiaWindow[]> {
    this.operation = 1; this.current();
    const answer = await this.p.bridge.request("topWindows", { pid: this.p.pid, deadlineMs: 3000 }, 5000); this.current();
    if (answer.error?.code === "busy" || answer.error?.code === "gone") return [];
    if (answer.error) this.fail();
    return (answer.result as { windows: UiaWindow[] }).windows.filter(window => window.pid === this.p.pid && !window.busy && !window.skipped);
  }
  /** `values`: also read each non-password control's own value (a closed list's choice is only its combo's value). */
  async nodes(hwnd: number, values = false, opening = false): Promise<RawNode[]> {
    this.operation = 2; this.readRefusal = 0; this.current();
    const answer = await this.p.bridge.request("snapshot", { hwnd, values, maxNodes: 2000, maxChildren: 500, deadlineMs: 3000 }, 5000); this.current();
    if (answer.error?.code === "busy" || answer.error?.code === "gone") return [];
    if (answer.error) { this.readRefusal = 1; this.fail(); }
    const result = answer.result as { nodes: RawNode[]; busy: boolean; truncated: boolean; cut: string[] };
    if (result.busy) return [];
    // A read the bridge stopped just short of its deadline (cut by "time" alone) is the same slow app as a busy one,
    // answered a moment earlier: nothing was read whole, so nothing is used. Any other cut (nodes, depth, offscreen)
    // is refused.
    if (result.cut.length === 1 && result.cut[0] === "time") return [];
    if (result.truncated || result.cut.length) { this.readRefusal = 2; this.fail(); }
    // `opening`: a window that has only just opened lists nothing until its page has loaded, as a busy one does.
    if (!result.nodes.length) { if (opening) return []; this.readRefusal = 3; this.fail(); }
    return result.nodes;
  }
  async node(hwnd: number, select: WslUiSelector, enabled = true): Promise<RawNode> {
    const value = await this.until(async () => (await this.nodes(hwnd)).find(node => select(node) && (!enabled || node.isEnabled === true)), value => !!value);
    return value!;
  }
  async text(hwnd: number, select: WslUiSelector): Promise<string> {
    this.operation = 3; this.textError = 0; this.textStage = 1; const node = await this.node(hwnd, select, false); if (node.isPassword) this.fail(); this.textStage = 2;
    // A control that does not answer in time is busy, and one redrawn since it was listed is gone, as a window's read
    // allows for both: found again and read again, within the caller's own limit. Any other refusal of the text stands.
    let result: { text?: string; secret?: boolean; truncated?: boolean } | undefined, target = node;
    for (const end = Math.min(this.p.deadline, Date.now() + 10_000); ;) {
      // No answer at all inside the client's 5 s is the same slow app, seen from this side: the bridge answers busy at
      // 2.5 s when it can, and a runner busy starting WSL can keep even that from arriving.
      const answer = await this.p.bridge.request("textInfo", { handle: target.h, maxChars: 32_000, deadlineMs: 2500 }, 5000).catch(() => null); this.current();
      if (answer && !answer.error) { result = answer.result as typeof result; break; }
      const code = answer?.error?.code; this.textError = !answer ? 6 : code === "busy" ? 1 : code === "gone" ? 2 : code === "failed" ? 3 : code === "denied" ? 4 : 5;
      if (this.textError >= 3 && this.textError <= 5 || Date.now() >= end) this.fail();
      await pause(150); target = await this.node(hwnd, select, false); if (target.isPassword) this.fail();
    }
    if (!result) this.fail();
    this.textStage = 3; if (result.secret || result.truncated || result.text && result.text.length > 32_000) this.fail(); if (result.text) { this.textStage = 0; return result.text; }
    this.textStage = 4;
    const snapshot = await this.p.bridge.call<{ nodes: RawNode[]; busy: boolean; truncated: boolean; cut: string[] }>("snapshot", { handle: target.h, values: false, maxNodes: 500, maxChildren: 500, deadlineMs: 2500 }, 5000); this.current();
    this.textStage = 5; if (snapshot.busy || snapshot.truncated || snapshot.cut.length) this.fail();
    const blocked = new Set<number>(), text: string[] = [];
    for (const [index, child] of snapshot.nodes.entries()) {
      if (child.isPassword || blocked.has(child.parent ?? -1)) { blocked.add(index); continue; }
      if (child.controlType === "Text" && child.name) text.push(child.name);
    }
    const joined = text.join("\n"); if (joined.length > 32_000) this.fail();
    this.textStage = 0; return joined || node.name || "";
  }
  private foreground(hwnd: number): void {
    this.current(); if (this.p.input.blockedReason?.(hwnd) || this.p.input.activeWindow() !== hwnd) this.fail();
  }
  async focus(hwnd: number, node: RawNode, guard?: SnapshotGuard, values = false): Promise<RawNode> {
    this.operation = 4; this.current(); if (this.p.input.blockedReason?.(hwnd)) this.fail(); this.p.input.activate(hwnd);
    // Activation may return before Windows raises the HWND. Verify foreground and exact focus in one budget.
    const focusDeadline = Date.now() + 10_000;
    let performed = false;
    await this.until(async () => {
      if (!performed) {
        if (this.p.input.blockedReason?.(hwnd)) this.fail();
        if (this.p.input.activeWindow() !== hwnd) return null;
        if (Date.now() >= focusDeadline) this.fail();
        performed = true;
        await this.p.bridge.call("perform", { handle: node.h, op: "focus", deadlineMs: 2500 }, 5000); this.current();
      }
      if (Date.now() >= focusDeadline) this.fail();
      const result = await this.p.bridge.call<{ element: RawNode | null; hwnd: number | null }>("focused", { values: false, deadlineMs: 2500 }, 5000);
      if (Date.now() >= focusDeadline) this.fail();
      return result;
    }, result => result !== null && result.hwnd === hwnd && !!result.element && sameWslUiNode(result.element, node) && result.element.hasKeyboardFocus === true, focusDeadline - Date.now());
    const nodes = await this.nodes(hwnd, values);
    guard?.(nodes);
    const fresh = nodes.find(value => sameWslUiNode(value, node)); this.foreground(hwnd);
    if (!fresh || fresh.isEnabled !== true || fresh.isOffscreen || !fresh.bounds || fresh.bounds.width <= 0 || fresh.bounds.height <= 0) this.fail();
    return fresh;
  }
  key(hwnd: number, name: string): void {
    this.operation = 5; this.foreground(hwnd); const symbol = this.p.input.keysymOf(name); if (!symbol) this.fail();
    try { if (!this.p.input.keysym(symbol, true)) this.fail(); }
    finally { this.p.input.keysym(symbol, false); this.p.input.releaseAll(); }
  }
  chord(hwnd: number, modifier: string, key: string): void {
    this.operation = 6; this.foreground(hwnd); const symbol = this.p.input.keysymOf(modifier); if (!symbol) this.fail();
    try { if (!this.p.input.keysym(symbol, true)) this.fail(); this.key(hwnd, key); }
    finally { this.p.input.keysym(symbol, false); this.p.input.releaseAll(); }
  }
  async click(hwnd: number, select: WslUiSelector, guard?: SnapshotGuard): Promise<void> {
    const node = await this.focus(hwnd, await this.node(hwnd, select), guard), box = node.bounds!; if (!select(node)) this.fail();
    this.operation = 7;
    try {
      this.foreground(hwnd); this.p.input.move(box.x + Math.floor(box.width / 2), box.y + Math.floor(box.height / 2));
      this.foreground(hwnd); this.p.input.button(1, true);
    } finally { this.p.input.button(1, false); this.p.input.releaseAll(); }
  }
  async press(hwnd: number, select: WslUiSelector, guard?: SnapshotGuard, values = false): Promise<void> {
    const fresh = await this.focus(hwnd, await this.node(hwnd, select), guard, values);
    if (!select(fresh) || (guard && fresh.hasKeyboardFocus !== true)) this.fail();
    this.key(hwnd, "Return");
  }
  async fill(hwnd: number, select: WslUiSelector, value: string, password = false): Promise<void> {
    const node = await this.focus(hwnd, await this.node(hwnd, select)); if (!select(node) || !!node.isPassword !== password) this.fail();
    this.operation = 8;
    try {
      this.chord(hwnd, "Control_L", "a");
      this.type(hwnd, value);
      this.key(hwnd, "Tab");
    } finally { this.p.input.releaseAll(); }
  }
  /** Native folder dialogs use the same per-character foreground/borrow checks as a Home field. */
  type(hwnd: number, value: string): void {
    this.operation = 8; if (!this.p.input.textKey) this.fail();
    try { for (const character of value) { this.foreground(hwnd); if (!this.p.input.textKey(character, true) || !this.p.input.textKey(character, false)) this.fail(); } }
    finally { this.p.input.releaseAll(); }
  }
  /** Tab reveals an offscreen DOM control through normal focus scrolling; it never toggles or submits. */
  async reveal(hwnd: number, anchor: WslUiSelector, select: WslUiSelector, backwards = false, enabled = true): Promise<RawNode> {
    this.operation = 9; const visible = (await this.nodes(hwnd)).find(node => select(node) && !node.isOffscreen && (!enabled || node.isEnabled));
    if (visible) return visible;
    await this.focus(hwnd, await this.node(hwnd, anchor));
    for (let index = 0; index < 12; index++) {
      if (backwards) this.chord(hwnd, "Shift_L", "Tab"); else this.key(hwnd, "Tab");
      const found = (await this.nodes(hwnd)).find(node => select(node) && !node.isOffscreen && (!enabled || node.isEnabled));
      if (found) return found;
    }
    this.fail();
  }
  async toggle(hwnd: number, select: WslUiSelector, value: "On" | "Off"): Promise<void> {
    const before = await this.node(hwnd, select, false);
    if (before.patterns.toggle !== "On" && before.patterns.toggle !== "Off") this.fail();
    if (before.patterns.toggle !== value) await this.click(hwnd, select);
    await this.until(async () => (await this.node(hwnd, select, false)).patterns.toggle, actual => actual === value);
  }
}
