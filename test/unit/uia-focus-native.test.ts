/** Process-free contracts for the real focus experiment; these checks provide no Windows/native evidence. */
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { types } from "node:util";
import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { nativeFocusEnvironment, nativeFocusObservation, sameNativeFocusTarget } from "../fixtures/uia-focus-contract";

const native = fs.readFileSync("test/integration/uia-electron-focus-native.test.ts", "utf8");
const target = { pid: 42, runtimeId: "PRIVATE runtime", automationId: "focus-link", controlType: "Hyperlink", hasKeyboardFocus: true };
it("uses the unchanged packaged runtime/PID/ID/type guard for every valid focus identity boundary", () => {
  const source = fs.readFileSync("test/integration/windows-node-packaged-product.test.ts", "utf8");
  const begin = source.indexOf("function sameNode("), end = source.indexOf("\nfunction subtree", begin); expect(begin >= 0 && end > begin).toBe(true);
  const module = { exports: undefined as unknown as (a: object, b: object) => boolean };
  runInNewContext(transformSync(source.slice(begin, end) + "\nmodule.exports = sameNode;", { loader: "ts", format: "cjs", target: "node22" }).code, { module });
  for (const change of [{}, { runtimeId: "PRIVATE other" }, { runtimeId: "" }, { pid: 0 }, { pid: 43 }, { automationId: "PRIVATE other" }, { controlType: "Document" }]) {
    const node = { ...target, ...change }; expect(sameNativeFocusTarget(node, target)).toBe(module.exports(node, target));
    expect(nativeFocusObservation({ hwnd: 99, element: node }, target, 99).matched).toBe(module.exports(node, target));
  }
  expect(nativeFocusObservation({ hwnd: 100, element: target }, target, 99).matched).toBe(false);
  expect(nativeFocusObservation({ hwnd: 99, element: { ...target, hasKeyboardFocus: false } }, target, 99).matched).toBe(false);
});
it("reproduces the closed wrong-child59 and exact255 masks without retaining identities", () => {
  const wrong = nativeFocusObservation({ hwnd: 99, element: { ...target, runtimeId: "PRIVATE other", automationId: "PRIVATE other", controlType: "Document" } }, target, 99);
  expect(wrong).toEqual({ focus: 11, identity: 59, matched: false }); expect(JSON.stringify(wrong)).not.toContain("PRIVATE");
  expect(nativeFocusObservation({ hwnd: 99, element: target }, target, 99)).toEqual({ focus: 15, identity: 255, matched: true });
});
it("reads no proxy/getter traps while projecting unknown focus data", () => {
  let reads = 0; const trap = () => { reads++; throw new Error("PRIVATE"); }, hostile = new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap });
  expect(nativeFocusObservation(hostile, hostile, 99)).toEqual({ focus: 0, identity: 0, matched: false });
  expect(nativeFocusObservation({ get element() { return trap(); } }, target, 99).matched).toBe(false); expect(reads).toBe(0);
});
it("inherits only real OS bootstrap variables and fixes its own isolated profile/temp without credentials or injection", () => {
  const base = { SystemRoot: "C:\\Windows", Path: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\synthetic", EMBER_UIA_FOCUS_PROFILE: "PRIVATE", tMp: "PRIVATE",
    cOpIlOt_GiThUb_ToKeN: "PRIVATE", Gh_ToKeN: "PRIVATE", GitHub_Token: "PRIVATE", NoDe_OpTiOnS: "PRIVATE", electron_Disable_Sandbox: "PRIVATE", ELECTRON_RUN_AS_NODE: "PRIVATE", Ember_Copilot_Runtime: "PRIVATE" };
  const old = { ...base }, env = nativeFocusEnvironment(base, "C:\\fixture\\profile", "C:\\fixture\\temporary");
  expect(env).toEqual({ SystemRoot: base.SystemRoot, Path: base.Path, USERPROFILE: base.USERPROFILE, EMBER_UIA_FOCUS_PROFILE: "C:\\fixture\\profile", TMPDIR: "C:\\fixture\\temporary", TMP: "C:\\fixture\\temporary", TEMP: "C:\\fixture\\temporary" });
  expect(base).toEqual(old); expect(JSON.stringify(env)).not.toContain("PRIVATE");
});
it.each([1, 2, 3])("the actual mode%i treatment checks its required live foreground immediately before its sole activation", async mode => {
  const begin = native.indexOf("        phase = 5;"), end = native.indexOf("        phase = 6;", begin); expect(begin > 0 && end > begin).toBe(true);
  const failure = new Error("Existing native treatment boundary refused."), module = { exports: undefined as unknown as (mode: number, native: object, guard: () => void, foreground: () => Promise<void>) => Promise<void> };
  runInNewContext(transformSync(`module.exports=async(mode,native,guard,foreground)=>{let phase;const first={hwnd:99},other={hwnd:100};${native.slice(begin, end)}};`, { loader: "ts", format: "cjs", target: "node22" }).code,
    { module, refusal: () => failure });
  for (const changed of [false, true]) {
    const calls: string[] = [], expected = mode === 3 ? 99 : 100;
    const result = module.exports(mode, { activeWindow() { calls.push("read-foreground"); return changed ? 101 : expected; }, activate() { calls.push("activate-once"); } },
      () => { calls.push("guard"); }, async () => { calls.push("observe-barrier"); });
    if (changed) { await expect(result).rejects.toBe(failure); expect(calls).not.toContain("activate-once"); }
    else { await result; expect(calls.filter(value => value === "activate-once")).toHaveLength(mode === 3 ? 0 : 1); expect(calls.includes("observe-barrier")).toBe(mode === 2); }
  }
});
it("the actual bridge error observation is owned early, rejection-handled and sticky after readiness", async () => {
  const begin = native.indexOf("    const bridgeError = new Promise"), end = native.indexOf("    const poll =", begin); expect(begin > 0 && end > begin).toBe(true);
  const originalCurrent = native.match(/ {2}const current = \(\) => \{[^\n]+\};/)![0];
  const module = { exports: undefined as unknown as (ui: object) => { error: Promise<never>; current(): void; broken(): boolean } }, failure = new Error("Existing bridge failure.");
  runInNewContext(transformSync(`module.exports=ui=>{let phase=2,retired=false,bridgeBroken=false;${originalCurrent}${native.slice(begin, end)}return{error:bridgeError,current,broken:()=>bridgeBroken};};`, { loader: "ts", format: "cjs", target: "node22" }).code,
    { module, refusal: () => failure });
  const child = new EventEmitter(), result = module.exports({ child }); expect(child.listenerCount("error")).toBe(1); result.current();
  expect(await Promise.race([Promise.resolve("ready"), result.error])).toBe("ready");
  child.emit("error", new Error("PRIVATE native spawn")); await expect(result.error).rejects.toBe(failure);
  expect(result.broken()).toBe(true); expect(() => result.current()).toThrow(failure);
});

function ownedChild() {
  const first = native.indexOf("function startOwned("), last = native.indexOf("\nit.skipIf", first); expect(first >= 0 && last > first).toBe(true);
  const child = Object.assign(new EventEmitter(), { stdin: new EventEmitter(), stdout: new EventEmitter(), stderr: new EventEmitter() });
  const module = { exports: undefined as unknown as (exe: string, app: string, env: object) => { process: typeof child; ready: Promise<boolean>; closed: Promise<{ code: number | null; signal: string | null }>; startup(): Readonly<{ appReady: number; appExit: number; appError: number; appStage: number }> } };
  const calls: unknown[][] = [];
  runInNewContext(transformSync(native.slice(first, last) + "\nmodule.exports = startOwned;", { loader: "ts", format: "cjs", target: "node22" }).code,
    { module, Buffer, types, spawn: (...args: unknown[]) => { calls.push(args); return child; } });
  const owned = module.exports("fixed-electron.exe", "/fixed-bench", { FIXED: "yes" });
  return { child, owned, calls };
}
it("captures the spawned owner and close listeners before any ready or startup failure can arrive", async () => {
  const f = ownedChild(); expect(f.owned.process).toBe(f.child); expect(f.child.listenerCount("close")).toBe(1); expect(f.child.listenerCount("error")).toBe(1);
  expect(f.calls).toEqual([["fixed-electron.exe", ["/fixed-bench"], { env: { FIXED: "yes" }, stdio: ["pipe", "pipe", "pipe"], windowsHide: false }]]);
  f.child.emit("error", new Error("PRIVATE startup")); f.child.emit("close", 1, null);
  await expect(f.owned.ready).resolves.toBe(false); await expect(f.owned.closed).resolves.toEqual({ code: 1, signal: null });
});
it.each(["positive", "negative", "oversized", "early-exit"])("the real startup reader keeps only the fixed sandbox-ready result for %s", async kind => {
  const f = ownedChild();
  if (kind === "positive") { f.child.stdout.emit("data", Buffer.from("EMBER_UIA_FOCUS_READY_V1:")); f.child.stdout.emit("data", Buffer.from("1\n")); }
  if (kind === "negative") f.child.stdout.emit("data", Buffer.from("EMBER_UIA_FOCUS_READY_V1:0\n"));
  if (kind === "oversized") f.child.stdout.emit("data", Buffer.alloc(64 * 1024 + 1, 65));
  if (kind === "early-exit") f.child.emit("exit", 1, null);
  await expect(f.owned.ready).resolves.toBe(kind === "positive"); f.child.emit("close", 0, null); await f.owned.closed;
});

it.each(["clean", "app-failed", "app-unknown", "bridge-unknown", "bridge-error", "input-failed", "earlier-failure"])("actual teardown deletes only after fully observed clean owners, with %s", async kind => {
  const begin = native.indexOf("    retired = true;"), end = native.indexOf("\n  }\n  phase = failed", begin); expect(begin >= 0 && end > begin).toBe(true);
  const body = native.slice(begin, end), trace: string[] = [];
  const process = { stdin: { end(value: string) { expect(value).toBe("quit\n"); trace.push("quit"); } }, exitCode: kind === "app-unknown" ? null : kind === "app-failed" ? 1 : 0, signalCode: null, kill() { trace.push("kill-app"); } };
  const fault = Promise.reject(new Error("PRIVATE close")); void fault.catch(() => undefined);
  const ports = { owned: { process, closed: kind === "app-unknown" ? fault : Promise.resolve({ code: kind === "app-failed" ? 1 : 0, signal: null }) },
    bridge: { async close() { trace.push("close-bridge"); if (kind === "bridge-unknown") throw new Error("PRIVATE bridge"); return { code: 0 }; }, closed: Promise.resolve(), kill() { trace.push("kill-bridge"); } },
    input: { releaseAll() { trace.push("release"); if (kind === "input-failed") throw new Error("PRIVATE input"); }, close() { trace.push("close-input"); } } };
  const module = { exports: undefined as unknown as (ports: object, earlier: boolean) => Promise<{ retired: boolean; cleanup: boolean; failed: boolean; firstFailure: number }> };
  const code = `module.exports = async (ports, earlier) => { let phase=7, retired=false, bridgeBroken=${kind === "bridge-error"}, failed=earlier, firstFailure=earlier?4:0, cleanup; const root="fixed-root", work=Promise.resolve(); const {owned,bridge,input}=ports; const bounded=async p=>p; const fail=()=>{if(!failed)firstFailure=phase;failed=true;}; ${body} return {retired,cleanup,failed,firstFailure}; };`;
  runInNewContext(transformSync(code, { loader: "ts", format: "cjs", target: "node22" }).code, { module, fs: { rmSync(root: string) { expect(root).toBe("fixed-root"); trace.push("delete"); } } });
  const result = await module.exports(ports, kind === "earlier-failure");
  expect(result.retired).toBe(true); expect(trace.includes("delete")).toBe(kind === "clean"); expect(result.failed).toBe(kind !== "clean");
  if (kind === "earlier-failure") expect(result.firstFailure).toBe(4);
});

function startupProjection(app: unknown, bridgeReady: unknown, bridgeStage: unknown, phase: unknown) {
  const begin = native.indexOf("function focusStartupObservation("), end = native.indexOf("interface OwnedChild", begin);
  expect(begin > 0 && end > begin).toBe(true);
  const module = { exports: undefined as unknown as (app: unknown, ready: unknown, stage: unknown, phase: unknown) => Record<string, number> };
  runInNewContext(transformSync(native.slice(begin, end) + "\nmodule.exports = focusStartupObservation;", { loader: "ts", format: "cjs", target: "node22" }).code, { module, types });
  return module.exports(app, bridgeReady, bridgeStage, phase);
}
it.each(["positive", "negative", "malformed", "overflow", "error", "exit"] as const)("distinguishes existing application ready outcomes without another launch (%s)", async kind => {
  const f = ownedChild();
  if (kind === "positive") f.child.stdout.emit("data", Buffer.from("EMBER_UIA_FOCUS_READY_V1:1\n"));
  if (kind === "negative") f.child.stdout.emit("data", Buffer.from("EMBER_UIA_FOCUS_READY_V1:0\n"));
  if (kind === "malformed") f.child.stdout.emit("data", Buffer.from("EMBER_UIA_FOCUS_READY_V1:PRIVATE\n"));
  if (kind === "overflow") f.child.stdout.emit("data", Buffer.alloc(64 * 1024 + 1));
  if (kind === "error") f.child.emit("error", new Error("PRIVATE startup"));
  if (kind === "exit") f.child.emit("exit", 71, null);
  expect(f.calls).toHaveLength(1); await expect(f.owned.ready).resolves.toBe(kind === "positive");
  expect(f.owned.startup().appReady).toBe(["positive", "negative", "malformed", "overflow", "error", "exit"].indexOf(kind) + 1);
  expect(f.owned.startup().appError).toBe(kind === "error" ? 1 : 0); expect(f.owned.startup().appExit).toBe(kind === "exit" ? 2 : 0);
  expect(JSON.stringify(f.owned.startup())).not.toContain("PRIVATE");
});
it("keeps a positive application ready result sticky while separately observing later exit", async () => {
  const f = ownedChild(); f.child.stdout.emit("data", Buffer.from("EMBER_UIA_FOCUS_READY_V1:1\n")); await f.owned.ready;
  const before = f.owned.startup(); f.child.emit("exit", 0, null);
  expect(f.owned.startup()).toEqual({ appReady: 1, appExit: 1, appError: 0, appStage: 0 }); expect(before.appExit).toBe(0); expect(Object.isFrozen(before)).toBe(true);
});
it.each(["split", "malformed", "overflow", "proxy", "accessor"] as const)("the existing stderr listener caches only fixed complete startup stages (%s)", kind => {
  const f = ownedChild(); let reads = 0;
  f.child.stderr.emit("data", Buffer.from("PRIVATE ignored line\nEMBER_UIA_FOCUS_STARTUP_V1:1\n"));
  if (kind === "split") { f.child.stderr.emit("data", Buffer.from("EMBER_UIA_FOCUS_STARTUP_V1:")); f.child.stderr.emit("data", Buffer.from("6\n")); }
  if (kind === "malformed") f.child.stderr.emit("data", Buffer.from("EMBER_UIA_FOCUS_STARTUP_V1:10\n"));
  if (kind === "overflow") f.child.stderr.emit("data", Buffer.alloc(64 * 1024 + 1));
  if (kind === "proxy") f.child.stderr.emit("data", new Proxy(Buffer.from("PRIVATE"), { get() { reads++; throw new Error("PRIVATE"); }, getOwnPropertyDescriptor() { reads++; throw new Error("PRIVATE"); } }));
  if (kind === "accessor") { const chunk = Buffer.from("PRIVATE"); Object.defineProperty(chunk, "toString", { get() { reads++; throw new Error("PRIVATE"); } }); f.child.stderr.emit("data", chunk); }
  expect(reads).toBe(0); expect(f.owned.startup().appStage).toBe(kind === "split" ? 6 : 0);
  // A failed observation cannot suppress the original readiness protocol.
  f.child.stdout.emit("data", Buffer.from("EMBER_UIA_FOCUS_READY_V1:1\n")); expect(f.owned.startup().appReady).toBe(1);
});
it("does not read private getters or proxy traps when freezing startup provenance", () => {
  let reads = 0; const trap = () => { reads++; throw new Error("PRIVATE"); };
  for (const app of [new Proxy({}, { get: trap, getOwnPropertyDescriptor: trap }), { get appReady() { return trap(); } }]) {
    expect(startupProjection(app, "PRIVATE", Infinity, -1)).toEqual({ schema: 1, phase: 0, appReady: 0, appExit: 0, appError: 0, appStage: 0, bridgeReady: 0, bridgeStage: 0 });
  }
  expect(reads).toBe(0); const maximum = startupProjection({ appReady: 6, appExit: 3, appError: 1, appStage: 9 }, 2, 30, 8);
  expect(Object.isFrozen(maximum)).toBe(true); expect(Buffer.byteLength(JSON.stringify(maximum))).toBeLessThanOrEqual(256);
});
it("observes the original bridge promise without replacing its resolution or rejection", async () => {
  const line = native.match(/ {4}void ui\.ready\.then\([^\n]+\);/)![0]; expect(line).toBeDefined();
  const module = { exports: undefined as unknown as (ui: { ready: Promise<unknown> }) => () => number };
  runInNewContext("module.exports=ui=>{let bridgeReady=0;" + line + "return()=>bridgeReady;};", { module });
  for (const fails of [false, true]) {
    const error = new Error("PRIVATE bridge"), ready = fails ? Promise.reject(error) : Promise.resolve("original ready");
    const observed = module.exports({ ready });
    if (fails) await expect(ready).rejects.toBe(error); else await expect(ready).resolves.toBe("original ready");
    expect(observed()).toBe(fails ? 2 : 1);
  }
  expect(native).toContain('await bounded(Promise.all([Promise.race([ui.ready, bridgeError]), application.ready]), 30_000).then(([, sandboxed]) => { current(); if (!sandboxed) throw refusal(phase); });');
});
it.each([false, true])("captures startup once at the original failure before teardown even when projection output faults=%s", outputFault => {
  const begin = native.indexOf("  const fail = () => {"), end = native.indexOf("  const current =", begin); expect(begin > 0 && end > begin).toBe(true);
  let appReady = 0, appStage = 6, reads = 0; const frames: unknown[][] = [];
  const module = { exports: undefined as unknown as (ports: object) => { fail(): void; later(): void; state(): object } };
  runInNewContext(transformSync("module.exports=ports=>{let phase=2,failed=false,firstFailure=0,bridgeReady=1;const {owned,bridge}=ports;" + native.slice(begin, end) + "return{fail,later(){phase=8},state:()=>({failed,firstFailure})};};", { loader: "ts", format: "cjs", target: "node22" }).code,
    { module, focusStartupObservation: startupProjection, console: { info(...args: unknown[]) { if (outputFault) throw new Error("PRIVATE output fault"); frames.push(args); } } });
  const driver = module.exports({ owned: { startup() { reads++; return { appReady, appExit: 0, appError: 0, appStage }; } }, bridge: { startupStage: 30 } });
  driver.fail(); appReady = 1; appStage = 9; driver.later(); driver.fail();
  expect(driver.state()).toEqual({ failed: true, firstFailure: 2 }); expect(reads).toBe(1); expect(frames).toHaveLength(outputFault ? 0 : 1);
  if (!outputFault) expect(JSON.parse(frames[0][1] as string)).toEqual({ schema: 1, phase: 2, appReady: 0, appExit: 0, appError: 0, appStage: 6, bridgeReady: 1, bridgeStage: 30 });
});

const bench = fs.readFileSync("test/fixtures/uia-focus-app/main.cjs", "utf8");
const oldBench = bench.replace(/\n\/\/ Fixed bench boundaries only;[^\n]*\nfunction startup\(stage\) \{[^\n]*\}\n/, "").replace(/^ *startup\([1-9]\);\n/gm, "");
it("preserves the entire original readiness/conditions operation block and teardown/summary bytes", () => {
  const begin = native.indexOf("    const poll ="), end = native.indexOf("    work = body();", begin), cleanup = native.indexOf("    retired = true;");
  expect(begin > 0 && end > begin && cleanup > end).toBe(true);
  expect(createHash("sha256").update(native.slice(begin, end)).digest("hex")).toBe("35f8d1eddc313eb36150027f8a103fb3507ff415feb58c57e14d63171e28c15c");
  expect(createHash("sha256").update(native.slice(cleanup)).digest("hex")).toBe("8295218fccb1f61b337a10b2ef64be3d5d2fc162e5e6d562749bf64c8c4eed3c");
});
it("recovers the whole original synthetic app by removing only the fixed observer helper and nine marker calls", () => {
  expect(createHash("sha256").update(oldBench).digest("hex")).toBe("31e7d5aa484c95a8ec95f0c54d7877db6bde5495bcd08e662bab488bc418b75a");
  expect(bench.match(/^ *startup\([1-9]\);$/gm)).toHaveLength(9);
  expect(native).toContain('bridgeEnv(env, { EMBER_UIA_CACHE: path.join(root, "bridge-cache"), EMBER_UIA_STARTUP_OBSERVE: "1" })');
});
it.each(["normal", "load-fault", "metrics-fault", "observer-fault"] as const)("the actual synthetic app retains its original actions and ready result with %s", async mode => {
  const run = async (source: string) => {
    const calls: string[] = [], stdout: string[] = [], stderr: string[] = []; let completion = Promise.resolve(); let next = 0;
    class Window {
      pid = ++next; webContents = { getOSProcessId: () => this.pid };
      constructor() { calls.push("create"); }
      async loadFile() { calls.push("load"); if (mode === "load-fault") throw new Error("PRIVATE load"); }
      setTitle() { calls.push("title"); } show() { calls.push("show"); }
    }
    const app = { setPath() { calls.push("profile"); }, on() {}, quit() { calls.push("quit"); },
      whenReady() { return { then(fn: () => Promise<void>) { completion = Promise.resolve().then(fn); return completion; } }; },
      getAppMetrics() { calls.push("metrics"); if (mode === "metrics-fault") throw new Error("PRIVATE metrics"); return [{ pid: 1, sandboxed: true }, { pid: 2, sandboxed: true }]; } };
    const line = { on() { return line; } };
    runInNewContext(source, { __dirname: "/fixed-bench", process: { env: { EMBER_UIA_FOCUS_PROFILE: "/fixed-profile" }, stdin: {}, exit() { throw new Error("Unexpected exit"); },
      stdout: { write(value: string) { stdout.push(value); } }, stderr: { write(value: string) { if (mode === "observer-fault") throw new Error("PRIVATE stderr"); stderr.push(value); } } },
      require(name: string) { if (name === "node:path") return { isAbsolute: () => true, join: (...parts: string[]) => parts.join("/") };
        if (name === "node:readline") return { createInterface: () => line };
        return { app, BrowserWindow: Window, Menu: { setApplicationMenu() { calls.push("menu"); } }, screen: { getPrimaryDisplay() { calls.push("screen"); return { workArea: { x: 0, y: 0, width: 1200 } }; } } }; } });
    await completion.catch(() => undefined); return { calls, stdout, stderr };
  };
  const old = await run(oldBench), current = await run(bench); expect(current.calls).toEqual(old.calls); expect(current.stdout).toEqual(old.stdout);
  expect(current.stdout).toEqual(["EMBER_UIA_FOCUS_READY_V1:" + (mode === "load-fault" || mode === "metrics-fault" ? "0" : "1") + "\n"]);
  const stage = mode === "load-fault" ? 6 : mode === "metrics-fault" ? 8 : 9;
  if (mode !== "observer-fault") expect(current.stderr.at(-1)).toBe("EMBER_UIA_FOCUS_STARTUP_V1:" + stage + "\n");
});
