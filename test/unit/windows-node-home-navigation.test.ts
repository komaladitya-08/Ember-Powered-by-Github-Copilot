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

it("reveals the Coding group then the exact result before the actual review click and bounded read", async () => {
  const review = actualMethod("  private async review(", "\n  private assertExport", "goal, counts");
  const calls: string[] = []; let stage = 0;
  const port = {
    home: 73, phase: 0,
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
  expect(port.phase).toBe(7); expect(calls).toEqual(["projects", "group", "result", "click", "read"]);
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
