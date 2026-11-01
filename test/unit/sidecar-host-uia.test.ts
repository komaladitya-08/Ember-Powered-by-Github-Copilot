import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn as realSpawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  BACKOFF_MS, POLICY_DETAIL, UiaProvider, bridgeEnv, codeOf, fromBridgeNode, fromBridgeWindow, powershellPath, rectOf, uiaScript,
  type BridgeNode,
} from "../../app/sidecar-host/providers/uia";
import { ProviderError, ownerPid } from "../../app/sidecar-host/provider";
import { TEST_SWITCHES, hostLaunch } from "../../app/sidecar-host/launch";

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

  it("calls a field or document editable where it takes the keyboard, alike in a snapshot and a look at one element", () => {
    const doc = { h: 1, controlType: "Document", isKeyboardFocusable: true, patterns: { text: true } as BridgeNode["patterns"] };
    expect(fromBridgeNode(doc).editable).toBe(true);
    // (A snapshot doesn't read LegacyIAccessible: what it says can't make the two disagree.)
    expect(fromBridgeNode({ ...doc, patterns: { text: true, legacy: { state: 0x40 } } }).editable).toBe(true);
    expect(fromBridgeNode({ ...doc, isEnabled: false }).editable).toBeUndefined();
    expect(fromBridgeNode({ ...doc, isKeyboardFocusable: false }).editable).toBeUndefined();
    expect(fromBridgeNode({ ...doc, controlType: "Text" }).editable).toBeUndefined();
  });

  it("has no position for an empty or infinite rectangle, and no key without a RuntimeId", () => {
    expect(rectOf({ x: Infinity, y: 0, width: 1, height: 1 })).toBeNull();
    expect(rectOf({ x: 0, y: 0, width: -1, height: 1 })).toBeNull();
    expect(rectOf(null)).toBeNull();
    expect(fromBridgeNode({ h: 1 }).key).toBe("");
    expect(fromBridgeNode({ h: 1, gone: true }).gone).toBe(true);
  });

  it("names windows by their HWND and their program without .exe", () => {
    expect(fromBridgeWindow({ h: 3, hwnd: 0x1a2b, pid: 9, processName: "Notepad.EXE", name: "Untitled - Notepad", className: "Notepad", controlType: "Window", windowState: "Minimized", focused: true })).toEqual({
      handle: 3, key: String(0x1a2b), pid: 9, app: "Notepad", title: "Untitled - Notepad", platformRole: "Window", bounds: null, active: true, offscreen: true, className: "Notepad", native: 0x1a2b,
    });
    expect(fromBridgeWindow({ h: 4, pid: 9, isModal: true, busy: true })).toMatchObject({ key: "uia-9-4", modal: true, busy: true, platformRole: "Window" });
    expect(fromBridgeWindow({ h: 5, hwnd: 6, pid: 9, patterns: { window: { modal: true } } })).toMatchObject({ handle: 5, modal: true });
    // A handle with the high bit set is negative in the bridge's JSON and unsigned everywhere else (keyboardFocus).
    const high = fromBridgeNode({ h: 1, hwnd: -2147483648, controlType: "Edit" });
    expect(high.native).toBe(0x80000000);
    expect(fromBridgeWindow({ h: 3, hwnd: -2147483648, pid: 9 })).toMatchObject({ native: 0x80000000, key: "2147483648" });
  });

  it("maps the bridge's error codes onto the host's", () => {
    expect(["busy", "gone", "denied", "bad_request", "failed"].map(c => codeOf(c, "x"))).toEqual(["busy", "gone", "denied", "failed", "failed"]);
    expect(codeOf("failed", "unsupported:toggle")).toBe("unsupported");
  });
});

describe("starting the bridge", () => {
  it("runs Windows PowerShell 5.1 by its full path, never one on PATH, with PSModulePath set to its own modules only (departure 3)", () => {
    expect(powershellPath({ SystemRoot: "D:\\Win" })).toBe("D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(powershellPath({ SYSTEMROOT: "E:\\W" })).toBe("E:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(powershellPath({ windir: "F:\\X" })).toBe("F:\\X\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(powershellPath({})).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    // Every case of it goes (Windows' environment is case-insensitive), and one is set: deleting it would make 5.1
    // rebuild a default with the user's Documents in it.
    const env = bridgeEnv({ PSModulePath: "C:\\evil", psmodulepath: "x", PSMODULEPATH: "y", EMBER_UIA_CACHE: "C:\\cache", PATH: "p", SystemRoot: "D:\\Win", __PSLockdownPolicy: "4" });
    expect(env).toEqual({
      EMBER_UIA_CACHE: "C:\\cache", PATH: "p", SystemRoot: "D:\\Win", __PSLockdownPolicy: "4",
      PSModulePath: "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\Modules",
    });
    expect(bridgeEnv({ systemroot: "E:\\W" }).PSModulePath).toBe("E:\\W\\System32\\WindowsPowerShell\\v1.0\\Modules");
    expect(bridgeEnv({}).PSModulePath).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules");
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

  it("starts the macOS host as a utility process of Ember's, never Ember's binary in node mode (review #177)", () => {
    const fork = () => { throw new Error("not called here"); };
    const host = "/Applications/Ember.app/Contents/Resources/app/dist/app/ax-sidecar.cjs";
    const l = hostLaunch({ execPath: "/Applications/Ember.app/Contents/MacOS/Ember", host, env: { PATH: "p", ELECTRON_RUN_AS_NODE: "1", Electron_Run_As_Node: "1", EMBER_AX_PROVIDER: "fake" }, platform: "darwin", packaged: true, fork });
    expect(l).toEqual({ command: "/Applications/Ember.app/Contents/MacOS/Ember", args: [host], env: { PATH: "p" }, firstRequestMs: 10_000, utility: { fork, serviceName: "Ember accessibility" } });
    // A packaged Ember on macOS has no other way to start it: without the fork, no launch at all (fail closed).
    expect(() => hostLaunch({ execPath: "e", host, env: {}, platform: "darwin", packaged: true })).toThrow(/utility process/);
    // Only the tests start it otherwise, with a real Node as execPath: spawned, still without node mode's variable.
    expect(hostLaunch({ execPath: "/usr/local/bin/node", host, env: { ELECTRON_RUN_AS_NODE: "1" }, platform: "darwin", packaged: false }))
      .toEqual({ command: "/usr/local/bin/node", args: [host], env: {}, firstRequestMs: 10_000, windowsHide: true });
  });

  it("names the test-only switches it drops from a packaged host, whatever their case", () => {
    expect(TEST_SWITCHES).toEqual(["EMBER_AX_PROVIDER", "EMBER_AX_FAKE_DESKTOP", "EMBER_AX_FAKE_LOG"]);
    const env = { Ember_AX_Provider: "fake", EMBER_AX_FAKE_DESKTOP: "d.json", ember_ax_fake_log: "l", EMBER_LOG_LEVEL: "debug" };
    expect(hostLaunch({ execPath: "e", host: "h", env, platform: "win32", packaged: true }).env).toEqual({ EMBER_LOG_LEVEL: "debug", ELECTRON_RUN_AS_NODE: "1" });
    expect(hostLaunch({ execPath: "e", host: "h", env, platform: "win32", packaged: false }).env).toMatchObject(env);
  });

  it("knows Ember's own process from EMBER_OWNER_PID, else from the parent it is given", () => {
    expect(ownerPid({ EMBER_OWNER_PID: "4321" }, 77)).toBe(4321);
    expect(ownerPid({ EMBER_OWNER_PID: " 12 " })).toBe(12);
    expect(ownerPid({}, 77)).toBe(77);
    expect(ownerPid({ EMBER_OWNER_PID: "Ember" }, 77)).toBe(77);
    expect(ownerPid({})).toBeUndefined();
    expect(ownerPid({ EMBER_OWNER_PID: "0" }, 0)).toBeUndefined();
  });
});

/** A stand-in for the C# bridge, run by node: its ready line, then answers by id (some late, some never). */
const BRIDGE = `
const fs = require("node:fs");
const readline = require("node:readline");
const log = process.env.FAKE_BRIDGE_LOG;
const send = m => process.stdout.write(JSON.stringify(m) + "\\n");
if (log) fs.appendFileSync(log, JSON.stringify({ start: true, argv: process.argv.slice(2), psmodulepath: process.env.PSModulePath ?? null, cache: process.env.EMBER_UIA_CACHE ?? null }) + "\\n");
// PowerShell refusing the script for an execution policy: no line on stdout, the reason on stderr, exit code 1.
if (process.env.FAKE_BRIDGE_POLICY) {
  process.stderr.write("File C:\\\\Ember\\\\ember_uia.ps1 cannot be loaded because running scripts is disabled on this system. For more information, see about_Execution_Policies at https:/go.microsoft.com/fwlink/?LinkID=135170.\\n    + CategoryInfo          : SecurityError: (:) [], PSSecurityException\\n    + FullyQualifiedErrorId : UnauthorizedAccess\\n", () => process.exit(1));
  return;
}
if (process.env.FAKE_BRIDGE_EXIT) { process.stderr.write("something else went wrong\\n", () => process.exit(Number(process.env.FAKE_BRIDGE_EXIT))); return; }
if (process.env.FAKE_BRIDGE_FATAL) {
  process.stdout.write(JSON.stringify({ fatal: process.env.FAKE_BRIDGE_FATAL, ...(process.env.FAKE_BRIDGE_LANGUAGE ? { languageMode: process.env.FAKE_BRIDGE_LANGUAGE } : {}) }) + "\\n", () => process.exit(1));
  return;
}
process.stdout.write("Windows PowerShell noise before the ready line\\n");
const processDpi = process.env.FAKE_BRIDGE_PROCESS_DPI ? { processDpi: process.env.FAKE_BRIDGE_PROCESS_DPI } : {};
setTimeout(() => send({ ready: true, version: 1, dpi: "per-monitor-v2", ...processDpi }), Number(process.env.FAKE_BRIDGE_READY_MS || 0));
readline.createInterface({ input: process.stdin }).on("line", line => {
  const req = JSON.parse(line);
  if (log) fs.appendFileSync(log, line + "\\n");
  const ok = (result, ms = 0) => setTimeout(() => send({ id: req.id, result }), ms);
  const fail = (code, message) => send({ id: req.id, error: { code, message } });
  const p = req.params || {};
  switch (req.method) {
    case "topWindows": return ok({ windows: [
      { h: 1, hwnd: 4660, pid: 77, processName: "notepad", name: "Untitled - Notepad", className: "Notepad", controlType: "Window", bounds: { x: 0, y: 0, width: 800, height: 600 }, focused: true, z: 0, patterns: { window: { modal: false, state: "Normal" } } },
      { hwnd: 4661, pid: 78, processName: "hung", name: "Not Responding", className: "Hung", bounds: { x: 10, y: 10, width: 100, height: 100 }, busy: true, z: 1 },
    ] });
    case "snapshot":
      if (p.handle === 2) return ok({ nodes: [{ h: 9, parent: -1, depth: 0, controlType: "Pane", childrenFailed: true }], truncated: false, cut: [], busy: false });
      return ok({ nodes: [{ h: 1, parent: -1, depth: 0, controlType: "Window", name: "Untitled - Notepad", runtimeId: "42.4660", pid: 77 }, { h: 2, parent: 0, depth: 1, controlType: "Document", name: "Text editor", runtimeId: "42.9.1", pid: 77, patterns: { text: true } }], truncated: true, cut: ["nodes"] });
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
    case "textInfo": return ok(p.handle === 66 ? { secret: true } : { source: "text", text: "hello", truncated: true, selection: "ell", caret: 1, selectionLength: 3, caretAtEnd: false });
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

/**
 * The host's environment with each override replacing every inherited spelling of its name. Windows names are
 * case-insensitive and the provider takes the first match, so an inherited SYSTEMROOT=C:\WINDOWS (as some
 * Windows 11 installs have it) would otherwise win over a test's SystemRoot.
 */
function hostEnv(overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const names = new Set(Object.keys(overrides).map(k => k.toLowerCase()));
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => !names.has(k.toLowerCase())));
  return { ...inherited, ...overrides };
}

function provider(env: NodeJS.ProcessEnv = {}, more: Partial<ConstructorParameters<typeof UiaProvider>[0]> = {}) {
  const log = path.join(dir, `log-${Math.random().toString(36).slice(2)}.jsonl`);
  const spawned: { command: string; args: string[]; options: Record<string, unknown> }[] = [];
  // Every start is recorded, then the stand-in runs instead of Windows PowerShell.
  const spawn = ((command: string, args: string[], options: Record<string, unknown>) => {
    spawned.push({ command, args, options });
    return realSpawn(process.execPath, [bridge, ...args], options as never);
  }) as never;
  const p = new UiaProvider({ script: "C:\\Ember\\sidecar\\uia\\ember_uia.ps1", env: hostEnv({ FAKE_BRIDGE_LOG: log, ...env }), spawn, deadlineMs: 100, graceMs: 300, backoffMs: [500], startMs: 3000, ...more });
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
    expect(lines()[0]).toMatchObject({ start: true, psmodulepath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules", cache: "C:\\cache" });
    expect(p.dpi).toBe("per-monitor-v2");
  });

  it("says how it is without starting: not yet, then up with the DPI awareness its ready line gave", async () => {
    const { p, spawned } = provider({ FAKE_BRIDGE_PROCESS_DPI: "per-monitor" });
    expect(p.health()).toEqual({ ok: null });
    expect(spawned).toHaveLength(0);
    await p.start();
    expect(p.health()).toEqual({ ok: true, dpi: "per-monitor-v2", processDpi: "per-monitor" });
  });

  it("says once when its threads' and its process's DPI awareness differ (uia.dpi_mixed), not for per-monitor v1 and v2", async () => {
    const notes: [string, Record<string, unknown> | undefined][] = [];
    const note = (event: string, fields?: Record<string, unknown>) => { notes.push([event, fields]); };
    const mixed = provider({ FAKE_BRIDGE_PROCESS_DPI: "system" }, { note });
    await mixed.p.start();
    (mixed.p as unknown as { call(m: string): Promise<unknown> }).call("exit").catch(() => undefined);
    for (const end = Date.now() + 5000; mixed.p.health().ok === true && Date.now() < end;) await new Promise(r => setTimeout(r, 20));
    await mixed.p.start();
    expect(mixed.spawned).toHaveLength(2);
    expect(notes.filter(([e]) => e === "uia.dpi_mixed")).toEqual([["uia.dpi_mixed", { dpi: "per-monitor-v2", processDpi: "system" }]]);
    expect(mixed.p.health()).toMatchObject({ ok: true, dpi: "per-monitor-v2", processDpi: "system" });
    notes.length = 0;
    const same = provider({ FAKE_BRIDGE_PROCESS_DPI: "per-monitor" }, { note });
    await same.p.start();
    expect(notes.map(([e]) => e)).not.toContain("uia.dpi_mixed");
  });

  it("waits for the ready line, skipping what PowerShell prints before it", async () => {
    const { p } = provider({ FAKE_BRIDGE_READY_MS: "300" });
    const t0 = Date.now();
    await p.start();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    const windows = await p.topWindows();
    expect(windows[0]).toMatchObject({ handle: 1, key: "4660", app: "notepad", title: "Untitled - Notepad", active: true });
    // A busy app's window comes from Win32 alone, with no handle.
    expect(windows[1]).toMatchObject({ handle: 0, key: "4661", busy: true, title: "Not Responding" });
  });

  it("lets a slow first start go on in the background instead of starting it again, and keeps later requests short", async () => {
    const { p, spawned } = provider({ FAKE_BRIDGE_READY_MS: "900" }, { startMs: 300 });
    let t0 = Date.now();
    expect(await failure(p.start())).toMatch(/still starting/);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    // Later requests waited in the host's queue meanwhile, out of their time in Ember: they are answered at once.
    t0 = Date.now();
    expect(await failure(p.start())).toMatch(/still starting/);
    expect(Date.now() - t0).toBeLessThan(100);
    // Its ready line comes in the end (900 ms after node started it: later on a loaded machine), and no second bridge.
    for (const end = Date.now() + 5000; p.health().ok !== true && Date.now() < end;) await new Promise(r => setTimeout(r, 50));
    await p.start();
    expect(spawned).toHaveLength(1);
    expect(p.generation).toBe(1);
  });

  it("says why it couldn't start, and doesn't try again at once", async () => {
    const { p, spawned } = provider({ FAKE_BRIDGE_FATAL: "Add-Type: error CS1002" });
    expect(await failure(p.start())).toBe("error: the accessibility bridge could not start (Add-Type: error CS1002)");
    expect(p.health()).toEqual({ ok: false, detail: "Add-Type: error CS1002" });
    expect(await failure(p.start())).toMatch(/could not start/);
    expect(spawned).toHaveLength(1);
    await new Promise(r => setTimeout(r, 600));
    await failure(p.start());
    expect(spawned).toHaveLength(2);
  });

  it("backs off further after each failed start in a row: 5 s, 30 s, 2 min, then every 10 min (W4)", async () => {
    expect(BACKOFF_MS).toEqual([5_000, 30_000, 120_000, 600_000]);
    const { p, spawned } = provider({ FAKE_BRIDGE_EXIT: "3" }, { backoffMs: [300, 2000] });
    const failed = async (n: number) => {
      expect(await failure(p.start())).toBe("error: the accessibility bridge stopped (exit code 3)");
      expect(spawned).toHaveLength(n);
    };
    await failed(1);
    expect(p.health()).toEqual({ ok: false, detail: "Windows PowerShell stopped before the bridge was ready (exit code 3)" });
    await failed(1);
    await new Promise(r => setTimeout(r, 400));
    await failed(2);
    // The second wait is longer: not yet after the first's.
    await new Promise(r => setTimeout(r, 400));
    await failed(2);
    await new Promise(r => setTimeout(r, 1700));
    await failed(3);
    // The last wait goes on for every later failure.
    await new Promise(r => setTimeout(r, 400));
    await failed(3);
  }, 15_000);

  it("never starts again in this host's life after a fatal line in Constrained Language mode, and says why for good (W4)", async () => {
    const { p, spawned } = provider({ FAKE_BRIDGE_FATAL: "Cannot add type. Definition of new types is not supported in this language mode.", FAKE_BRIDGE_LANGUAGE: "ConstrainedLanguage" }, { backoffMs: [50] });
    const why = "error: the accessibility bridge could not start (Cannot add type. Definition of new types is not supported in this language mode.)";
    expect(await failure(p.start())).toBe(why);
    await new Promise(r => setTimeout(r, 200));
    const t0 = Date.now();
    expect(await failure(p.start())).toBe(why);
    expect(Date.now() - t0).toBeLessThan(50);
    expect(spawned).toHaveLength(1);
    expect(p.health()).toEqual({ ok: false, detail: "Cannot add type. Definition of new types is not supported in this language mode.", languageMode: "ConstrainedLanguage" });
  });

  it("tells PowerShell refusing the script for an execution policy, and starts again at once only when its mark is gone (W2)", async () => {
    let marked = true;
    const looked: string[] = [];
    const notes: string[] = [];
    const { p, spawned } = provider({ FAKE_BRIDGE_POLICY: "1" }, {
      backoffMs: [60_000],
      streamExists: (file, stream) => { looked.push(`${file}:${stream}`); return marked; },
      note: (event, fields) => { notes.push(JSON.stringify([event, fields])); },
    });
    expect(await failure(p.start())).toBe(`error: the accessibility bridge could not start: ${POLICY_DETAIL}`);
    expect(p.health()).toEqual({ ok: false, detail: "PowerShell refused to run the bridge (execution policy)" });
    expect(looked).toEqual(["C:\\Ember\\sidecar\\uia\\ember_uia.ps1:Zone.Identifier"]);
    // Still marked: not started again (the back-off is a minute here); one look a request.
    expect(await failure(p.start())).toMatch(/execution policy/);
    expect(spawned).toHaveLength(1);
    expect(looked).toHaveLength(2);
    // The user unblocked it: started again at once.
    marked = false;
    expect(await failure(p.start())).toMatch(/execution policy/);
    expect(spawned).toHaveLength(2);
    // Refused again with no mark now (an administrator's policy): only the back-off starts it again.
    expect(await failure(p.start())).toMatch(/execution policy/);
    expect(spawned).toHaveLength(2);
    // PowerShell's words never reach the log.
    expect(notes.join("\n")).not.toMatch(/cannot be loaded|PSSecurityException|Execution_Policies/);
  });

  it("reads a fatal line or a refusal that arrives after Node reports the bridge's exit (W4)", async () => {
    /** A bridge process whose exit is reported before what it wrote has been read: its stderr's end, then its stdout. */
    const exitsFirst = (stdout: string, stderr: string) => {
      const child = Object.assign(new EventEmitter(), {
        stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null as number | null, signalCode: null, kill: () => true,
      });
      setTimeout(() => {
        child.exitCode = 1;
        child.emit("exit", 1, null);
        child.stderr.end(stderr);
        setTimeout(() => child.stdout.end(stdout), 50);
      }, 20);
      return child;
    };
    const fatal = JSON.stringify({ fatal: "Cannot add type.", languageMode: "ConstrainedLanguage" }) + "\n";
    const constrained = new UiaProvider({ script: "C:\\e.ps1", spawn: (() => exitsFirst(fatal, "")) as never, backoffMs: [0] });
    expect(await failure(constrained.start())).toBe("error: the accessibility bridge could not start (Cannot add type.)");
    expect(constrained.health()).toEqual({ ok: false, detail: "Cannot add type.", languageMode: "ConstrainedLanguage" });
    // Constrained Language mode: never again, even with no back-off at all.
    expect(await failure(constrained.start())).toMatch(/could not start \(Cannot add type\.\)/);
    const refusal = "File C:\\e.ps1 cannot be loaded. For more information, see about_Execution_Policies.\n";
    const policy = new UiaProvider({ script: "C:\\e.ps1", spawn: (() => exitsFirst("", refusal)) as never, streamExists: () => false });
    expect(await failure(policy.start())).toBe(`error: the accessibility bridge could not start: ${POLICY_DETAIL}`);
  });

  it("isn't taken for an execution-policy refusal when the bridge wrote a line first", async () => {
    const { p } = provider({ FAKE_BRIDGE_FATAL: "File cannot be loaded: execution policy" });
    await failure(p.start());
    expect(p.health()).toEqual({ ok: false, detail: "File cannot be loaded: execution policy" });
  });

  it("sends Ember's own pid as skipPids with the window list and hit tests only, never anything else into it (W14)", async () => {
    const { p, lines } = provider({}, { skipPids: [4242, 4242, 0] });
    await p.topWindows();
    await p.elementsAt(5, 6, 4242);
    await p.element(2);
    await p.children(1, 4);
    const sent = lines().filter(l => l.method);
    expect(sent.map(l => [l.method, l.params.skipPids ?? null])).toEqual([["topWindows", [4242]], ["elementsAt", [4242]], ["element", null], ["children", null]]);
    const none = provider();
    await none.p.topWindows();
    expect(none.lines().filter(l => l.method)[0].params).not.toHaveProperty("skipPids");
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
    // Children that couldn't be read leave the read incomplete.
    expect(await p.snapshot(2, { maxDepth: 1, maxNodes: 10, deadlineMs: 500 })).toMatchObject({ truncated: true, cut: ["nodes"] });
    await p.element(2);
    const reqs = lines().filter(l => l.method && l.method !== "snapshot" || l.params?.handle === 1);
    expect(reqs[0]).toMatchObject({ method: "snapshot", params: { handle: 1, maxDepth: 65, maxNodes: 1600, maxChildren: 200, values: true, legacy: false, deadlineMs: 4000 } });
    expect(reqs[1]).toMatchObject({ method: "element", params: { handle: 2, values: true, legacy: true, deadlineMs: 100 } });
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
    expect(await p.textInfo(2, 2000)).toEqual({ text: "hello", truncated: true, selection: "ell", caret: 1, caretAtEnd: false });
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
    // The new bridge numbers its handles from 1 again: one from before is gone, never the new bridge's element 2.
    expect(await p.element(2)).toBeNull();
    expect(await failure(p.perform(2, "invoke"))).toMatch(/^gone: /);
    expect(spawned).toHaveLength(2);
    expect(p.generation).toBe(2);
    const [w] = await p.topWindows();
    expect(w.handle).not.toBe(1);
    expect((await p.element(w.handle))?.name).toBe("Element 1");
  });

  it("never sends a handle from before a restart, even within the request it happened in", async () => {
    const { p, lines } = provider();
    const [old] = await p.topWindows();
    expect(old.handle).toBe(1);
    (p as unknown as { call(m: string): Promise<unknown> }).call("exit").catch(() => undefined);
    await new Promise(r => setTimeout(r, 300));
    const [now] = await p.topWindows();
    expect(p.generation).toBe(2);
    expect(await failure(p.perform(old.handle, "invoke"))).toMatch(/^gone: /);
    expect(await failure(p.textInfo(old.handle, 10))).toMatch(/^gone: /);
    expect(await p.children(old.handle, 4).then(() => "listed", (e: ProviderError) => e.code)).toBe("gone");
    p.release([old.handle, now.handle]);
    await p.element(now.handle);
    // Only the new bridge's own number went to it, and only for its own handle.
    const sent = lines().filter(l => l.method === "perform" || l.method === "release" || l.method === "textInfo" || l.method === "children");
    expect(sent.map(l => [l.method, l.params.handles ?? l.params.handle])).toEqual([["release", [1]]]);
  });

  it("fails what was waiting when the bridge exits, and starts it again on the next request", async () => {
    const { p, spawned } = provider();
    await p.start();
    const waiting = failure(p.element(5));
    p.perform(1, "invoke").catch(() => undefined); // answered or failed, depending on which comes first
    (p as unknown as { call(m: string): Promise<unknown> }).call("exit").catch(() => undefined);
    expect(await waiting).toMatch(/^failed: the accessibility bridge stopped/);
    const [w] = await p.topWindows();
    expect((await p.element(w.handle))?.name).toBe("Element 1");
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
