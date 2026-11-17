/** Normal Windows input and existing UIA transport for the separate packaged WSL proof. No app/debug/IPC seam. */
import type { openWin32Input } from "../../app/main/platform/win32/input";
import type { RawNode, UiaBridge, UiaWindow } from "../integration/uia-client";

type Input = NonNullable<ReturnType<typeof openWin32Input>>;
export type WslUiSelector = (node: RawNode) => boolean;
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
  async nodes(hwnd: number): Promise<RawNode[]> {
    this.operation = 2; this.current();
    const answer = await this.p.bridge.request("snapshot", { hwnd, values: false, maxNodes: 2000, maxChildren: 500, deadlineMs: 3000 }, 5000); this.current();
    if (answer.error?.code === "busy" || answer.error?.code === "gone") return [];
    if (answer.error) this.fail();
    const result = answer.result as { nodes: RawNode[]; busy: boolean; truncated: boolean; cut: string[] };
    if (result.busy) return [];
    if (result.truncated || result.cut.length || !result.nodes.length) this.fail();
    return result.nodes;
  }
  async node(hwnd: number, select: WslUiSelector, enabled = true): Promise<RawNode> {
    const value = await this.until(async () => (await this.nodes(hwnd)).find(node => select(node) && (!enabled || node.isEnabled === true)), value => !!value);
    return value!;
  }
  async text(hwnd: number, select: WslUiSelector): Promise<string> {
    this.operation = 3; const node = await this.node(hwnd, select, false); if (node.isPassword) this.fail();
    const result = await this.p.bridge.call<{ text?: string; secret?: boolean; truncated?: boolean }>("textInfo", { handle: node.h, maxChars: 32_000, deadlineMs: 2500 }, 5000); this.current();
    if (result.secret || result.truncated || result.text && result.text.length > 32_000) this.fail(); if (result.text) return result.text;
    const snapshot = await this.p.bridge.call<{ nodes: RawNode[]; busy: boolean; truncated: boolean; cut: string[] }>("snapshot", { handle: node.h, values: false, maxNodes: 500, maxChildren: 500, deadlineMs: 2500 }, 5000); this.current();
    if (snapshot.busy || snapshot.truncated || snapshot.cut.length) this.fail();
    const blocked = new Set<number>(), text: string[] = [];
    for (const [index, child] of snapshot.nodes.entries()) {
      if (child.isPassword || blocked.has(child.parent ?? -1)) { blocked.add(index); continue; }
      if (child.controlType === "Text" && child.name) text.push(child.name);
    }
    const joined = text.join("\n"); if (joined.length > 32_000) this.fail();
    return joined || node.name || "";
  }
  private foreground(hwnd: number): void {
    this.current(); if (this.p.input.blockedReason?.(hwnd) || this.p.input.activeWindow() !== hwnd) this.fail();
  }
  async focus(hwnd: number, node: RawNode): Promise<RawNode> {
    this.operation = 4; this.current(); if (this.p.input.blockedReason?.(hwnd)) this.fail(); this.p.input.activate(hwnd);
    await this.p.bridge.call("perform", { handle: node.h, op: "focus", deadlineMs: 2500 }, 5000); this.current();
    await this.until(() => this.p.bridge.call<{ element: RawNode | null; hwnd: number | null }>("focused", { values: false, deadlineMs: 2500 }, 5000),
      result => result.hwnd === hwnd && !!result.element && sameWslUiNode(result.element, node) && result.element.hasKeyboardFocus === true, 10_000);
    const fresh = (await this.nodes(hwnd)).find(value => sameWslUiNode(value, node)); this.foreground(hwnd);
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
  async click(hwnd: number, select: WslUiSelector): Promise<void> {
    const node = await this.focus(hwnd, await this.node(hwnd, select)), box = node.bounds!; if (!select(node)) this.fail();
    this.operation = 7;
    try {
      this.foreground(hwnd); this.p.input.move(box.x + Math.floor(box.width / 2), box.y + Math.floor(box.height / 2));
      this.foreground(hwnd); this.p.input.button(1, true);
    } finally { this.p.input.button(1, false); this.p.input.releaseAll(); }
  }
  async press(hwnd: number, select: WslUiSelector): Promise<void> {
    const fresh = await this.focus(hwnd, await this.node(hwnd, select)); if (!select(fresh)) this.fail(); this.key(hwnd, "Return");
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
