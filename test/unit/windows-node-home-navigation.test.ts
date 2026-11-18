/** Exercise the packaged driver's actual navigation boundary without issuing native input. */
import fs from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { expect, it } from "vitest";

type Selector = (node: { automationId?: string; name?: string }) => boolean;
interface HomePort {
  home: number;
  revealHomeControl(select: Selector, enabled?: boolean, backwards?: boolean): Promise<unknown>;
  fill(window: number, select: Selector, value: string): Promise<void>;
  click(window: number, select: Selector): Promise<void>;
}
const source = fs.readFileSync(new URL("../integration/windows-node-packaged-product.test.ts", import.meta.url), "utf8");
const start = source.indexOf("  async send(request: string): Promise<void> {");
const end = source.indexOf("\n  private async command", start);
expect(start).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(start);
const body = source.slice(start, end).slice(source.slice(start, end).indexOf("{") + 1).trim().replace(/\}$/, "");
const send = runInNewContext("(async function(request) {" + body + "})", {
  id: (value: string): Selector => node => node.automationId === value,
}) as (this: HomePort, request: string) => Promise<void>;

it("reveals the offscreen Sessions request with guarded reverse navigation before the existing fill and Send", async () => {
  const calls: string[] = []; let accessible = false;
  const port: HomePort = {
    home: 73,
    async revealHomeControl(select, enabled, backwards) {
      expect(select({ automationId: "project-sessions-request" })).toBe(true);
      expect(select({ automationId: "project-coding-choose" })).toBe(false);
      expect(enabled).toBe(true); expect(backwards).toBe(true);
      calls.push("reveal"); accessible = true;
    },
    async fill(window, select, value) {
      if (!accessible) throw new Error("The offscreen Sessions group has no discoverable request descendant.");
      expect(window).toBe(73); expect(select({ automationId: "project-sessions-request" })).toBe(true);
      expect(value).toBe("Use only the newly chosen private copy."); calls.push("fill");
    },
    async click(window, select) {
      expect(window).toBe(73); expect(select({ automationId: "project-sessions-send" })).toBe(true); calls.push("send");
    },
  };
  await send.call(port, "Use only the newly chosen private copy.");
  expect(calls).toEqual(["reveal", "fill", "send"]);
});

it("preserves a guarded navigation refusal without filling or submitting a request", async () => {
  const calls: string[] = [], refusal = new Error("The Home foreground or current-run guard refused.");
  const port: HomePort = {
    home: 73,
    async revealHomeControl() { calls.push("reveal"); throw refusal; },
    async fill() { calls.push("fill"); },
    async click() { calls.push("send"); },
  };
  await expect(send.call(port, "A synthetic public request.")).rejects.toBe(refusal);
  expect(calls).toEqual(["reveal"]);
});

function actualMethod(prefix: string, next: string, parameters: string, globals: Record<string, unknown> = {}) {
  const begin = source.indexOf(prefix), end = source.indexOf(next, begin);
  expect(begin).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(begin);
  const method = source.slice(begin, end), body = method.slice(method.indexOf("{") + 1).trim().replace(/\}$/, "");
  const compiled = transformSync("module.exports = async function(" + parameters + ") {" + body + "};", { loader: "ts", format: "cjs", target: "node22" }).code;
  const module = { exports: undefined as unknown as (this: unknown, ...args: unknown[]) => Promise<unknown> };
  runInNewContext(compiled, { module, expect, id: (value: string): Selector => node => node.automationId === value,
    named: (value: string): Selector => node => node.name === value, titleOf: (value: string) => value, ...globals });
  return module.exports;
}

it("waits for the session to end, then reveals the Coding group and the exact result before the actual review click and bounded read", async () => {
  const review = actualMethod("  private async review(", "\n  private assertExport", "goal, counts");
  const calls: string[] = []; let stage = 0;
  const port = {
    home: 73, phase: 0,
    // A result exists only once its session has ended: the wait for Home's Ready comes before the Tab search.
    async idle() { expect(port.phase).toBe(7); calls.push("idle"); },
    async pane(value: string) { expect(value).toBe("Projects"); calls.push("projects"); },
    async revealHomeControl(select: Selector, enabled?: boolean) {
      if (!stage) { expect(select({ automationId: "project-coding" })).toBe(true); expect(enabled).toBe(false); calls.push("group"); }
      else { expect(select({ name: "Review result: Public review" })).toBe(true); calls.push("result"); }
      stage++;
    },
    async click(window: number, select: Selector) {
      if (stage !== 2) throw new Error("The Projects pane has not exposed the result control.");
      expect(window).toBe(73); expect(select({ name: "Review result: Public review" })).toBe(true); calls.push("click");
    },
    async homeText(select: Selector) { expect(select({ automationId: "project-coding-review" })).toBe(true); calls.push("read"); return "Checks: 2 run"; },
    async until(read: () => Promise<string>, accept: (value: string) => boolean, timeout: number) { expect(timeout).toBe(45_000); const value = await read(); expect(accept(value)).toBe(true); return value; },
  };
  expect(await review.call(port, "Public review", "Checks: 2 run")).toBe("Checks: 2 run");
  expect(port.phase).toBe(7); expect(calls).toEqual(["idle", "projects", "group", "result", "click", "read"]);
});

it("reveals the Coding group and Export again after the actual idle helper returns to Projects", async () => {
  const exportReview = actualMethod("  private async exportReview(", "\n  async repair", "cumulative");
  const calls: string[] = []; let stage = 0;
  const port = {
    home: 73, exported: "C:\\public-review-export", model: { requests: [] },
    async idle() { calls.push("idle"); stage = 0; },
    async revealHomeControl(select: Selector, enabled?: boolean) {
      expect(select({ automationId: stage ? "project-coding-export" : "project-coding" })).toBe(true);
      if (!stage) expect(enabled).toBe(false);
      calls.push(stage++ ? "export" : "group");
    },
    async click(window: number, select: Selector) {
      if (stage !== 2) throw new Error("The Projects pane has not exposed Export.");
      expect(window).toBe(73); expect(select({ automationId: "project-coding-export" })).toBe(true); calls.push("click");
    },
    async folder(title: string, destination: string) { expect(title).toBe("Export coding review"); expect(destination).toBe("C:\\public-review-export"); calls.push("folder"); },
    async accessibleText(accept: (value: string) => boolean) { expect(accept("Exported the coding review")).toBe(true); calls.push("receipt"); },
    assertExport(cumulative: boolean) { expect(cumulative).toBe(true); calls.push("files"); },
  };
  await exportReview.call(port, true);
  expect(calls).toEqual(["idle", "group", "export", "click", "folder", "receipt", "files"]); expect(port.model.requests).toEqual([]);
});

it("reveals the newly opened Continue request before the real repair sequence fills or submits it", async () => {
  const begin = source.indexOf('    await this.click(this.home, id("project-coding-continue"));'), end = source.indexOf(' await this.decide(', begin);
  expect(begin).toBeGreaterThanOrEqual(0); expect(end).toBeGreaterThan(begin);
  const execute = runInNewContext("(async function() {" + source.slice(begin, end) + "})", {
    id: (value: string): Selector => node => node.automationId === value, WINDOWS_NODE_CONTINUATION: { request: "A separately typed new request." },
  }) as (this: HomePort) => Promise<void>;
  const calls: string[] = []; let visible = false;
  const port: HomePort = {
    home: 73,
    async click(window, select) { expect(window).toBe(73); calls.push(select({ automationId: "project-coding-continue" }) ? "open" : "submit"); },
    async revealHomeControl(select) { expect(select({ automationId: "project-coding-continue-request" })).toBe(true); visible = true; calls.push("reveal"); },
    async fill(window, select, request) {
      if (!visible) throw new Error("Continue opened its request below the viewport.");
      expect(window).toBe(73); expect(select({ automationId: "project-coding-continue-request" })).toBe(true); expect(request).toBe("A separately typed new request."); calls.push("fill");
    },
  };
  await execute.call(port); expect(calls).toEqual(["open", "reveal", "fill", "submit"]);
});

it("keeps the actual field-exit Tab and waits for a fresh owned departure before returning", async () => {
  const fill = actualMethod("  private async fill(", "\n  private async homeText", "hwnd, select, value, password = false", { refusal: () => new Error("The controlled field guard refused.") });
  const field = { pid: 7, runtimeId: "field-one", automationId: "project-sessions-request", isPassword: false }, calls: string[] = [], accepted: boolean[] = [];
  const next = { pid: 7, runtimeId: "send-one", automationId: "project-sessions-send", hasKeyboardFocus: true };
  const observations = [
    { hwnd: 73, element: { ...field, hasKeyboardFocus: true } },
    { hwnd: 73, element: { ...next, runtimeId: "field-one" } },
    { hwnd: 73, element: { ...next, automationId: field.automationId } },
    { hwnd: 73, element: { ...next, pid: 8 } },
    { hwnd: 74, element: next },
    { hwnd: 73, element: { ...next, hasKeyboardFocus: false } },
    { hwnd: 73, element: { ...next, runtimeId: "" } },
    { hwnd: 73, element: next },
  ];
  let reads = 0;
  const port = {
    phase: 5, async node() { return field; }, async focus(_hwnd: number, node: unknown) { expect(node).toBe(field); calls.push("focus"); return field; },
    current() { calls.push("current"); }, chord(modifier: string, key: string) { expect([modifier, key]).toEqual(["Control_L", "a"]); calls.push("select"); },
    type(value: string) { expect(value).toBe("A new original request."); calls.push("type"); }, pressKey(key: string) { expect(key).toBe("Tab"); calls.push("tab"); },
    input: { blockedReason: () => null, activeWindow: () => 73, releaseAll() { calls.push("release"); } },
    bridge: { async call(method: string, options: unknown, bound: number) { expect(method).toBe("focused"); expect(options).toEqual({ values: false, deadlineMs: 2500 }); expect(bound).toBe(5000); return observations[reads++]; } },
    async until(read: () => Promise<unknown>, accepts: (value: unknown) => boolean, bound: number) {
      expect(bound).toBe(10_000);
      for (let index = 0; index < observations.length; index++) { const value = await read(), yes = accepts(value); accepted.push(yes); if (yes) return value; }
      throw new Error("No exact owned departure was observed.");
    },
  };
  await fill.call(port, 73, () => true, "A new original request.");
  expect(accepted).toEqual([false, false, false, false, false, false, false, true]); expect(reads).toBe(8);
  expect(calls.slice(0, 4)).toEqual(["focus", "select", "type", "tab"]); expect(calls.at(-1)).toBe("release");
});

it.each(["retired", "blocked", "foreign-before", "foreign-after"])("refuses %s after accepted Tab without refocusing or typing another field", async kind => {
  const refused = new Error("The controlled field guard refused."), fill = actualMethod("  private async fill(", "\n  private async homeText", "hwnd, select, value, password = false", { refusal: () => refused });
  const field = { pid: 7, runtimeId: "field-one", automationId: "project-sessions-request", isPassword: false }, calls: string[] = [];
  let tab = false, read = false;
  const port = {
    phase: 5, async node() { return field; }, async focus() { calls.push("focus"); return field; },
    current() { if (tab && kind === "retired") throw refused; }, chord() {}, type() { calls.push("type"); }, pressKey() { tab = true; calls.push("tab"); },
    input: { blockedReason: () => tab && kind === "blocked" ? "protected" : null,
      activeWindow: () => kind === "foreign-before" || kind === "foreign-after" && read ? 74 : 73, releaseAll() { calls.push("release"); } },
    bridge: { async call() { read = true; calls.push("read"); return { hwnd: 73, element: { pid: 7, runtimeId: "send-one", automationId: "project-sessions-send", hasKeyboardFocus: true } }; } },
    async until(read: () => Promise<unknown>, accepts: (value: unknown) => boolean) { const value = await read(); if (!accepts(value)) throw refused; return value; },
  };
  await expect(fill.call(port, 73, () => true, "Public request.")).rejects.toBe(refused);
  expect(calls.filter(value => value === "focus")).toHaveLength(1); expect(calls.filter(value => value === "type")).toHaveLength(1);
  expect(calls.includes("read")).toBe(kind === "foreign-after"); expect(calls.at(-1)).toBe("release");
});

it("retains the actual secret-field mismatch refusal before any input or departure observation", async () => {
  const refused = new Error("The controlled secret-field guard refused."), fill = actualMethod("  private async fill(", "\n  private async homeText", "hwnd, select, value, password = false", { refusal: () => refused });
  const calls: string[] = [], port = { phase: 5, async node() { return { isPassword: true }; }, async focus() { calls.push("focus"); return { isPassword: true }; },
    chord() { calls.push("select"); }, type() { calls.push("type"); }, pressKey() { calls.push("tab"); }, until() { calls.push("read"); }, input: { releaseAll() { calls.push("release"); } } };
  await expect(fill.call(port, 73, () => true, "Not a secret.")).rejects.toBe(refused); expect(calls).toEqual(["focus"]);
});

it.each([{ name: "Save", automationId: "", password: true }, { name: "Advanced", automationId: undefined, password: false }])("observes a legitimate unnamed $name runtime departure without granting the following action", async endpoint => {
  const fill = actualMethod("  private async fill(", "\n  private async homeText", "hwnd, select, value, password = false", { refusal: () => new Error("The controlled field guard refused.") });
  const field = { pid: 7, runtimeId: "field-one", automationId: endpoint.password ? "byok-key" : "byok-worker", isPassword: endpoint.password };
  const calls: string[] = [], port = {
    phase: 4, async node() { return field; }, async focus() { calls.push("field-focus"); return field; }, current() {}, chord() {}, type() {}, pressKey(key: string) { expect(key).toBe("Tab"); calls.push("tab"); },
    input: { blockedReason: () => null, activeWindow: () => 73, releaseAll() { calls.push("release"); } },
    bridge: { async call(method: string) { expect(method).toBe("focused"); calls.push("observe"); return { hwnd: 73, element: { pid: 7, runtimeId: "unnamed-next", automationId: endpoint.automationId, name: endpoint.name, hasKeyboardFocus: true } }; } },
    async until(read: () => Promise<unknown>, accepts: (value: unknown) => boolean, bound: number) { expect(bound).toBe(10_000); const value = await read(); expect(accepts(value)).toBe(true); return value; },
  };
  await fill.call(port, 73, () => true, "Fixed synthetic input.", endpoint.password);
  // This is departure only. No next-control action or identity exemption exists in fill().
  expect(calls).toEqual(["field-focus", "tab", "observe", "release"]);
});
