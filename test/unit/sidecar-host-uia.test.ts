import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as realSpawn } from "node:child_process";
import {
  UiaProvider, bridgeEnv, codeOf, fromBridgeNode, fromBridgeWindow, powershellPath, rectOf, uiaScript, type BridgeNode,
} from "../../app/sidecar-host/providers/uia";
import { ProviderError } from "../../app/sidecar-host/provider";
import { hostLaunch } from "../../app/sidecar-host/launch";

describe("the bridge's elements as the host's", () => {
  it("turns UI Automation patterns into the host's facts and action words", () => {
    const b: BridgeNode = {
      h: 7, parent: 2, depth: 3, controlType: "CheckBox", name: "Remember me", className: "Button", frameworkId: "WinForm", pid: 40,
      runtimeId: "42.1234.5", hwnd: 0, isEnabled: true, isOffscreen: false, hasKeyboardFocus: true, isKeyboardFocusable: true,
      bounds: { x: 1, y: 2, width: 30, height: 40 }, labeledBy: "Login", helpText: "tip",
      patterns: { toggle: "On", legacy: { defaultAction: "Uncheck", state: 0x10 }, scrollItem: true },
    };
    expect(fromBridgeNode(b)).toEqual({
      handle: 7, key: "40:42.1234.5", parent: 2, depth: 3, platformRole: "CheckBox", name: "Remember me", bounds: { x: 1, y: 2, width: 30, height: 40 },
      actions: ["toggle", "focus", "legacy", "scrollIntoView"], className: "Button", framework: "WinForm", pid: 40, labelledBy: "Login", help: "tip",
      enabled: true, focused: true, focusable: true, offscreen: false, toggle: "on",
    });
  });

  it("reads expand, selection, value and range patterns, and never carries a password field's value", () => {
    const n = fromBridgeNode({ h: 1, controlType: "ComboBox", patterns: { expand: "Collapsed", selection: { multiple: false }, value: { value: "Dark", readOnly: true } } });
    expect(n).toMatchObject({ expanded: false, selection: { multiple: false }, value: "Dark", actions: ["expand", "collapse"] });
    expect(n.editable).toBeUndefined();
    expect(fromBridgeNode({ h: 1, controlType: "TreeItem", patterns: { expand: "LeafNode", selectionItem: { selected: true } } })).toMatchObject({ expanded: null, selected: true, actions: ["select", "addToSelection", "removeFromSelection"] });
    const pw = fromBridgeNode({ h: 1, controlType: "Edit", isPassword: true, patterns: { value: { value: "hunter2", readOnly: false } } });
    expect(pw).toMatchObject({ password: true, editable: true, actions: ["setValue"] });
    expect(pw.value).toBeUndefined();
    expect(fromBridgeNode({ h: 1, controlType: "Slider", patterns: { range: { value: 5, min: 0, max: 10, smallChange: 1 } } }).range).toEqual({ value: 5, min: 0, max: 10, step: 1 });
    expect(fromBridgeNode({ h: 1, controlType: "Slider", patterns: { range: { value: NaN, min: 0, max: 10 } } }).range).toBeUndefined();
  });

  it("calls a document editable where its text can be typed into, not where MSAA says it is read-only", () => {
    expect(fromBridgeNode({ h: 1, controlType: "Document", patterns: { text: true } }).editable).toBe(true);
    expect(fromBridgeNode({ h: 1, controlType: "Document", patterns: { text: true, legacy: { state: 0x40 } } }).editable).toBeUndefined();
    expect(fromBridgeNode({ h: 1, controlType: "Document", isEnabled: false, patterns: { text: true } }).editable).toBeUndefined();
    expect(fromBridgeNode({ h: 1, controlType: "Text", patterns: { text: true } }).editable).toBeUndefined();
  });

  it("has no position for an empty or infinite rectangle, and no key without a RuntimeId", () => {
    expect(rectOf({ x: Infinity, y: 0, width: 1, height: 1 })).toBeNull();
    expect(rectOf({ x: 0, y: 0, width: -1, height: 1 })).toBeNull();
    expect(rectOf(null)).toBeNull();
    expect(fromBridgeNode({ h: 1 }).key).toBe("");
    expect(fromBridgeNode({ h: 1, gone: true }).gone).toBe(true);
  });

  it("names windows by their HWND and their program without .exe", () => {
    expect(fromBridgeWindow({ handle: 3, hwnd: 0x1a2b, pid: 9, processName: "Notepad.EXE", name: "Untitled - Notepad", className: "Notepad", controlType: "Window", windowState: "Minimized", focused: true })).toEqual({
      handle: 3, key: String(0x1a2b), pid: 9, app: "Notepad", title: "Untitled - Notepad", platformRole: "Window", bounds: null, active: true, offscreen: true, className: "Notepad", native: 0x1a2b,
    });
    expect(fromBridgeWindow({ handle: 4, pid: 9, isModal: true, busy: true })).toMatchObject({ key: "uia-9-4", modal: true, busy: true, platformRole: "Window" });
  });

  it("maps the bridge's error codes onto the host's", () => {
    expect(["busy", "gone", "denied", "bad_request", "failed"].map(c => codeOf(c, "x"))).toEqual(["busy", "gone", "denied", "failed", "failed"]);
    expect(codeOf("failed", "unsupported:toggle")).toBe("unsupported");
  });
});

describe("starting the bridge", () => {
  it("runs Windows PowerShell 5.1 by its full path, never one on PATH, without PSModulePath", () => {
    expect(powershellPath({ SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(powershellPath({})).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    const env = bridgeEnv({ PSModulePath: "C:\\evil", psmodulepath: "x", EMBER_UIA_CACHE: "C:\\cache", PATH: "p" });
    expect(env).toEqual({ EMBER_UIA_CACHE: "C:\\cache", PATH: "p" });
  });

  it("finds its script where Ember says, else beside the host in a development tree or a packaged Ember", () => {
    expect(uiaScript({ EMBER_UIA_SCRIPT: "/x/ember_uia.ps1" }, "/a/dist/app/ax-sidecar.cjs")).toBe("/x/ember_uia.ps1");
    expect(uiaScript({}, "/repo/dist/app/ax-sidecar.cjs", () => true)).toBe(path.resolve("/repo/sidecar/uia/ember_uia.ps1"));
    const packaged = path.resolve("/opt/ember/resources/sidecar/uia/ember_uia.ps1");
    expect(uiaScript({}, "/opt/ember/resources/app/dist/app/ax-sidecar.cjs", p => p === packaged)).toBe(packaged);
  });

  it("gives Ember the host's launch: its own binary in node mode, no console window, a long first request on Windows", () => {
    const l = hostLaunch({ execPath: "C:\\Ember\\Ember.exe", host: "C:\\Ember\\resources\\app\\dist\\app\\ax-sidecar.cjs", uiaScript: "C:\\s.ps1", uiaCache: "C:\\c", env: { PATH: "p", EMBER_AX_PROVIDER: "fake" }, platform: "win32", packaged: true });
    expect(l).toEqual({ command: "C:\\Ember\\Ember.exe", args: ["C:\\Ember\\resources\\app\\dist\\app\\ax-sidecar.cjs"], env: { PATH: "p", ELECTRON_RUN_AS_NODE: "1", EMBER_UIA_SCRIPT: "C:\\s.ps1", EMBER_UIA_CACHE: "C:\\c" }, firstRequestMs: 20_000, windowsHide: true });
    expect(hostLaunch({ execPath: "e", host: "h", env: { EMBER_AX_PROVIDER: "fake" }, platform: "darwin", packaged: false }).env.EMBER_AX_PROVIDER).toBe("fake");
  });
});

/** A stand-in for the C# bridge, run by node: its ready line, then answers by id (some late, some never). */
const BRIDGE = `
const fs = require("node:fs");
const readline = require("node:readline");
const log = process.env.FAKE_BRIDGE_LOG;
const send = m => process.stdout.write(JSON.stringify(m) + "\\n");
if (log) fs.appendFileSync(log, JSON.stringify({ start: true, argv: process.argv.slice(2), psmodulepath: process.env.PSModulePath ?? null, cache: process.env.EMBER_UIA_CACHE ?? null }) + "\\n");
if (process.env.FAKE_BRIDGE_FATAL) { send({ fatal: process.env.FAKE_BRIDGE_FATAL }); process.exit(1); }
process.stdout.write("Windows PowerShell noise before the ready line\\n");
setTimeout(() => send({ ready: true, version: 1, dpi: "per-monitor-v2" }), Number(process.env.FAKE_BRIDGE_READY_MS || 0));
readline.createInterface({ input: process.stdin }).on("line", line => {
  const req = JSON.parse(line);
  if (log) fs.appendFileSync(log, line + "\\n");
  const ok = (result, ms = 0) => setTimeout(() => send({ id: req.id, result }), ms);
  const fail = (code, message) => send({ id: req.id, error: { code, message } });
  const p = req.params || {};
  switch (req.method) {
    case "topWindows": return ok([{ handle: 1, hwnd: 4660, pid: 77, processName: "notepad.exe", name: "Untitled - Notepad", className: "Notepad", controlType: "Window", bounds: { x: 0, y: 0, width: 800, height: 600 }, focused: true }]);
    case "snapshot": return ok({ nodes: [{ h: 1, parent: -1, depth: 0, controlType: "Window", name: "Untitled - Notepad", runtimeId: "42.4660", pid: 77 }, { h: 2, parent: 0, depth: 1, controlType: "Document", name: "Text editor", runtimeId: "42.9.1", pid: 77, patterns: { text: true } }], truncated: true, cut: ["nodes"] });
    case "element":
      if (p.handle === 99) return fail("gone", "ElementNotAvailableException");
      if (p.handle === 98) return fail("busy", "the app didn't answer in time");
      if (p.handle === 13) return; // never answered: a stuck bridge
      return ok({ h: p.handle, controlType: "Button", name: "Element " + p.handle }, p.handle === 5 ? 200 : 0);
    case "elementsAt": return ok({ chain: [{ h: 1, controlType: "Window" }, { h: 3, controlType: "Button", name: "Save" }] });
    case "focused": return ok({ element: { h: 4, controlType: "Edit", hasKeyboardFocus: true }, window: 1 });
    case "children": return ok([{ h: 8, controlType: "ListItem", name: "a" }]);
    case "perform":
      if (p.op === "toggle") return fail("failed", "unsupported:toggle");
      if (p.op === "setValue" && p.handle === 66) return fail("denied", "password field");
      return ok({ ok: true });
    case "textInfo": return ok(p.handle === 66 ? { secret: true } : { text: "hello", selection: "ell", caretAtEnd: false });
    case "release": return ok({});
    case "exit": process.exit(3);
  }
});
`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-uia-test-"));
const bridge = path.join(dir, "fake_bridge.cjs");
fs.writeFileSync(bridge, BRIDGE);

const providers: UiaProvider[] = [];
afterEach(() => { for (const p of providers.splice(0)) p.stop(); });

function provider(env: NodeJS.ProcessEnv = {}, more: Partial<ConstructorParameters<typeof UiaProvider>[0]> = {}) {
  const log = path.join(dir, `log-${Math.random().toString(36).slice(2)}.jsonl`);
  const spawned: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  // Every start is recorded, then the stand-in runs instead of Windows PowerShell.
  const spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
    spawned.push({ command, args, options });
    return realSpawn(process.execPath, [bridge, ...args], options as never);
  }) as never;
  const p = new UiaProvider({ script: "C:\\Ember\\sidecar\\uia\\ember_uia.ps1", env: { ...process.env, FAKE_BRIDGE_LOG: log, ...env }, spawn, deadlineMs: 100, graceMs: 300, retryMs: 500, startMs: 3000, ...more });
  providers.push(p);
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim().split("\n").map(l => JSON.parse(l)) : []);
  return { p, spawned, lines };
}
const failure = (x: Promise<unknown>) => x.then(() => "resolved", (e: Error) => `${e instanceof ProviderError ? e.code : "error"}: ${e.message}`);

describe("the bridge client", () => {
  it("starts Windows PowerShell hidden, with the bridge script, a clean environment and the cache", async () => {
    const { p, spawned, lines } = provider({ PSModulePath: "C:\\Users\\me\\Modules", EMBER_UIA_CACHE: "C:\\cache", SystemRoot: "C:\\Windows" });
    await p.start();
    expect(spawned).toHaveLength(1);
    expect(spawned[0].command).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(spawned[0].args).toEqual(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "C:\\Ember\\sidecar\\uia\\ember_uia.ps1"]);
    expect(spawned[0].options.windowsHide).toBe(true);
    expect(lines()[0]).toMatchObject({ start: true, psmodulepath: null, cache: "C:\\cache" });
    expect(p.dpi).toBe("per-monitor-v2");
  });

  it("waits for the ready line, skipping what PowerShell prints before it", async () => {
    const { p } = provider({ FAKE_BRIDGE_READY_MS: "300" });
    const t0 = Date.now();
    await p.start();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect((await p.topWindows())[0]).toMatchObject({ key: "4660", app: "notepad", title: "Untitled - Notepad", active: true });
  });

  it("lets a slow first start go on in the background instead of starting it again", async () => {
    const { p, spawned } = provider({ FAKE_BRIDGE_READY_MS: "600" }, { startMs: 150 });
    expect(await failure(p.start())).toMatch(/still starting/);
    await new Promise(r => setTimeout(r, 700));
    await p.start();
    expect(spawned).toHaveLength(1);
    expect(p.generation).toBe(1);
  });

  it("says why it couldn't start, and doesn't try again at once", async () => {
    const { p, spawned } = provider({ FAKE_BRIDGE_FATAL: "Add-Type: error CS1002" });
    expect(await failure(p.start())).toBe("error: the accessibility bridge could not start (Add-Type: error CS1002)");
    expect(await failure(p.start())).toMatch(/could not start/);
    expect(spawned).toHaveLength(1);
    await new Promise(r => setTimeout(r, 600));
    await failure(p.start());
    expect(spawned).toHaveLength(2);
  });

  it("matches answers by id, in whatever order they come", async () => {
    const { p } = provider();
    const [slow, quick] = await Promise.all([p.element(5), p.element(6)]);
    expect([slow?.name, quick?.name]).toEqual(["Element 5", "Element 6"]);
  });

  it("gives every request its deadline, and the snapshot the read's (four seconds at most)", async () => {
    const { p, lines } = provider();
    const snap = await p.snapshot(1, { maxDepth: 65, maxNodes: 1600, deadlineMs: 9000 });
    expect(snap).toMatchObject({ truncated: true, cut: ["nodes"] });
    expect(snap.nodes.map(n => [n.platformRole, n.key, n.hasText ?? false])).toEqual([["Window", "77:42.4660", false], ["Document", "77:42.9.1", true]]);
    await p.element(2);
    const reqs = lines().filter(l => l.method);
    expect(reqs[0]).toMatchObject({ method: "snapshot", params: { handle: 1, maxDepth: 65, maxNodes: 1600, deadlineMs: 4000 } });
    expect(reqs[1]).toMatchObject({ method: "element", params: { handle: 2, deadlineMs: 100 } });
  });

  it("answers gone as null, and busy, denied and unsupported as the host's errors", async () => {
    const { p } = provider();
    expect(await p.element(99)).toBeNull();
    expect(await failure(p.element(98))).toBe("busy: the app didn't answer in time");
    expect(await failure(p.perform(3, "toggle"))).toBe("unsupported: unsupported:toggle");
    expect(await failure(p.perform(66, "setValue", "x"))).toBe("denied: password field");
    await p.perform(3, "invoke");
  });

  it("reads hit tests, focus, children and text in the host's shapes", async () => {
    const { p, lines } = provider();
    expect((await p.elementsAt(10.4, 20.6)).map(n => n.name)).toEqual(["", "Save"]);
    expect(await p.focused()).toMatchObject({ element: { platformRole: "Edit", focused: true }, window: 1 });
    expect((await p.children(1, 16)).map(n => n.name)).toEqual(["a"]);
    expect(await p.textInfo(2, 2000)).toEqual({ text: "hello", selection: "ell", caretAtEnd: false });
    expect(await p.textInfo(66, 2000)).toEqual({ secret: true });
    await p.perform(3, "legacy");
    expect(lines().filter(l => l.method).map(l => l.params.op ?? l.params.x)).toContain("legacyDefaultAction");
    expect(lines().find(l => l.method === "elementsAt").params).toMatchObject({ x: 10, y: 21 });
  });

  it("gives handles back in one request nobody waits for", async () => {
    const { p, lines } = provider();
    await p.start();
    p.release([4, 5, 6]);
    p.release([]);
    await p.element(1);
    expect(lines().filter(l => l.method === "release").map(l => l.params.handles)).toEqual([[4, 5, 6]]);
  });

  it("gives up on a bridge that stops answering, and starts a new one (its handles from before mean nothing)", async () => {
    const { p, spawned } = provider();
    await p.start();
    const t0 = Date.now();
    expect(await failure(p.element(13))).toMatch(/^busy: /);
    expect(Date.now() - t0).toBeLessThan(1500);
    expect((await p.element(2))?.name).toBe("Element 2");
    expect(spawned).toHaveLength(2);
    expect(p.generation).toBe(2);
  });

  it("fails what was waiting when the bridge exits, and starts it again on the next request", async () => {
    const { p, spawned } = provider();
    await p.start();
    const waiting = failure(p.element(5));
    p.perform(1, "invoke").catch(() => undefined); // answered or failed, depending on which comes first
    (p as unknown as { call(m: string): Promise<unknown> }).call("exit").catch(() => undefined);
    expect(await waiting).toMatch(/^failed: the accessibility bridge stopped/);
    expect((await p.element(2))?.name).toBe("Element 2");
    expect(spawned).toHaveLength(2);
  });

  it("stops the bridge for good when the host exits", async () => {
    const { p, spawned } = provider();
    await p.start();
    const child = (p as unknown as { bridge: { child: { exitCode: number | null; signalCode: string | null; once(e: string, f: () => void): void } } }).bridge.child;
    const exited = new Promise<void>(r => child.once("exit", r));
    p.stop();
    await exited;
    expect(await failure(p.start())).toMatch(/stopped/);
    expect(spawned).toHaveLength(1);
  });
});
