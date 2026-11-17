/** Process-free contracts for the real focus experiment; these checks provide no Windows/native evidence. */
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
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
  const module = { exports: undefined as unknown as (exe: string, app: string, env: object) => { process: typeof child; ready: Promise<boolean>; closed: Promise<{ code: number | null; signal: string | null }> } };
  const calls: unknown[][] = [];
  runInNewContext(transformSync(native.slice(first, last) + "\nmodule.exports = startOwned;", { loader: "ts", format: "cjs", target: "node22" }).code,
    { module, spawn: (...args: unknown[]) => { calls.push(args); return child; } });
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
