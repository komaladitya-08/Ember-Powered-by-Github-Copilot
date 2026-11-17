/** Process-free ownership and failed-wait controls for the synthetic native comparison; no Windows proof. */
import fs from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { expect, it, vi } from "vitest";
import { startCommandsRenderer } from "../fixtures/commands-renderer-native-driver";
import { sameNativeFocusTarget } from "../fixtures/uia-focus-contract";

const launch = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: launch.spawn }));
const source = fs.readFileSync("test/integration/commands-renderer-native.test.ts", "utf8");
const sample = (sequence = 1) => ({ schema: 1, sequence, card: 2, dom: 15, geometry: 255, reported: 7, arm: 2, assets: 7, lifecycle: 255 });
const line = (value: unknown) => Buffer.from("EMBER_COMMANDS_RENDERER_SAMPLE_V1:" + JSON.stringify(value) + "\n");
function child() {
  const process = Object.assign(new EventEmitter(), { pid: 41, stdin: null, stdout: new EventEmitter(), stderr: new EventEmitter() });
  let broken = false;
  const control = { address: "fixed-pipe", nonce: "fixed-nonce", listening: Promise.resolve(), authenticated: Promise.resolve(),
    bindChild: (pid: number | undefined) => expect(pid).toBe(41), broken: () => broken, sample() {}, sampledSequence: () => 0, quit: async () => {}, close: async () => {} };
  launch.spawn.mockReset().mockReturnValue(process);
  return { process, control, failControl: () => { broken = true; }, owner: startCommandsRenderer("fixed-electron.exe", "/owned/app", { FIXED: "yes" }, control) };
}
function ready(f: ReturnType<typeof child>) { f.process.stdout.emit("data", Buffer.from("EMBER_COMMANDS_RENDERER_READY_V1:1\n")); }

it("captures one fixed launch, the owned close, startup errors and all streams before readiness", async () => {
  const f = child();
  expect(launch.spawn).toHaveBeenCalledExactlyOnceWith("fixed-electron.exe", ["/owned/app"], { env: { FIXED: "yes", EMBER_COMMANDS_RENDERER_CONTROL: "fixed-pipe", EMBER_COMMANDS_RENDERER_NONCE: "fixed-nonce" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
  expect(f.owner.process).toBe(f.process); expect(f.process.listenerCount("close")).toBe(1); expect(f.process.listenerCount("error")).toBe(1);
  f.process.emit("error", new Error("PRIVATE spawn")); f.process.emit("close", 1, null);
  await expect(f.owner.ready).resolves.toBe(false); await expect(f.owner.closed).resolves.toEqual({ code: 1, signal: null });
  expect(f.owner.broken()).toBe(true); expect(f.owner.startup()).toEqual({ appReady: 5, appExit: 0, appError: 1, appStage: 0, loadCode: 0, quit: 0 });
  expect(JSON.stringify(f.owner.startup())).not.toContain("PRIVATE");
});
it("keeps split positive readiness and only consecutive closed numeric samples", async () => {
  const f = child(); f.process.stdout.emit("data", Buffer.from("EMBER_COMMANDS_RENDERER_READY_V1:")); f.process.stdout.emit("data", Buffer.from("1\n"));
  await expect(f.owner.ready).resolves.toBe(true);
  f.process.stdout.emit("data", line(sample())); expect(f.owner.sample()).toEqual(sample()); expect(Object.isFrozen(f.owner.sample())).toBe(true);
  f.process.stdout.emit("data", line(sample(2))); expect(f.owner.sample()?.sequence).toBe(2); expect(f.owner.broken()).toBe(false);
});
it.each(["negative", "unknown", "overflow", "early-exit"] as const)("classifies %s startup without a ready success", async kind => {
  const f = child();
  if (kind === "negative") f.process.stdout.emit("data", Buffer.from("EMBER_COMMANDS_RENDERER_READY_V1:0\n"));
  if (kind === "unknown") f.process.stdout.emit("data", Buffer.from("EMBER_COMMANDS_RENDERER_READY_V1:PRIVATE\n"));
  if (kind === "overflow") f.process.stdout.emit("data", Buffer.alloc(64 * 1024 + 1));
  if (kind === "early-exit") f.process.emit("exit", 0, null);
  await expect(f.owner.ready).resolves.toBe(false);
  expect(f.owner.startup().appReady).toBe({ negative: 2, unknown: 3, overflow: 4, "early-exit": 6 }[kind]);
});
it.each(["before-ready", "wrong-sequence", "duplicate", "malformed", "extra-key", "out-of-domain", "oversized", "unknown-prefix"])("refuses %s sample input without replacing the last accepted observation", kind => {
  const f = child(); if (kind !== "before-ready") ready(f);
  if (kind === "duplicate") f.process.stdout.emit("data", line(sample()));
  const previous = f.owner.sample();
  if (kind === "malformed") f.process.stdout.emit("data", Buffer.from("EMBER_COMMANDS_RENDERER_SAMPLE_V1:{PRIVATE\n"));
  else if (kind === "oversized") f.process.stdout.emit("data", Buffer.from("EMBER_COMMANDS_RENDERER_SAMPLE_V1:" + "x".repeat(257) + "\n"));
  else if (kind === "unknown-prefix") f.process.stdout.emit("data", Buffer.from("EMBER_COMMANDS_RENDERER_UNKNOWN_V1:1\n"));
  else f.process.stdout.emit("data", line(kind === "wrong-sequence" ? sample(2) : kind === "extra-key" ? { ...sample(), private: "PRIVATE" } : kind === "out-of-domain" ? { ...sample(), arm: 3 } : sample()));
  expect(f.owner.broken()).toBe(true); expect(f.owner.sample()).toBe(previous);
});
it("observes only bounded fixed startup stages and keeps post-ready errors sticky", async () => {
  const f = child();
  f.process.stderr.emit("data", Buffer.from("PRIVATE ordinary Electron stderr\nEMBER_COMMANDS_RENDERER_STARTUP_V1:"));
  f.process.stderr.emit("data", Buffer.from("9\n")); expect(f.owner.startup().appStage).toBe(9);
  ready(f); await expect(f.owner.ready).resolves.toBe(true);
  f.process.emit("error", new Error("PRIVATE late error"));
  expect(f.owner.broken()).toBe(true); expect(f.owner.startup()).toMatchObject({ appReady: 1, appError: 1 });
  f.process.stderr.emit("data", Buffer.from("EMBER_COMMANDS_RENDERER_STARTUP_V1:PRIVATE\n")); expect(f.owner.startup().appStage).toBe(0);
  expect(JSON.stringify(f.owner.startup())).not.toContain("PRIVATE");
});
it("retains an owned control failure after positive readiness instead of silently issuing another request", async () => {
  const f = child(); ready(f); await expect(f.owner.ready).resolves.toBe(true);
  f.failControl(); expect(f.owner.broken()).toBe(true);
});
it("caches the fixed load/quit marker before negative readiness without changing its outcome", async () => {
  const f = child(); f.process.stdout.emit("data", Buffer.from("EMBER_COMMANDS_RENDERER_LOAD_V1:1:1\nEMBER_COMMANDS_RENDERER_READY_V1:0\n"));
  await expect(f.owner.ready).resolves.toBe(false); expect(f.owner.startup()).toMatchObject({ appReady: 2, loadCode: 1, quit: 1 });
  expect(f.owner.broken()).toBe(false);
});
it("maps conflicting or malformed passive load observations to unknown while preserving positive readiness", async () => {
  const f = child(); ready(f); f.process.stdout.emit("data", Buffer.from("EMBER_COMMANDS_RENDERER_LOAD_V1:1:1\nEMBER_COMMANDS_RENDERER_LOAD_V1:2:4\n"));
  expect(f.owner.startup()).toMatchObject({ appReady: 1, loadCode: 7, quit: 0 });
  f.process.stdout.emit("data", Buffer.from("EMBER_COMMANDS_RENDERER_LOAD_V1:PRIVATE\n"));
  await expect(f.owner.ready).resolves.toBe(true); expect(f.owner.broken()).toBe(false); expect(JSON.stringify(f.owner.startup())).not.toContain("PRIVATE");
  const unknown = child(); ready(unknown);
  unknown.process.stdout.emit("data", Buffer.from("EMBER_COMMANDS_RENDERER_LOAD_V1:0:0\nEMBER_COMMANDS_RENDERER_LOAD_V1:2:4\n"));
  expect(unknown.owner.startup()).toMatchObject({ loadCode: 7, quit: 0 }); expect(unknown.owner.broken()).toBe(false);
});

const commandsReadout = (runtimeId: string, h: number) => ({ automationId: "ask-cmd", controlType: "Edit", pid: 41, runtimeId, h });
const readoutHelpers = source.slice(source.indexOf("function stableSamples("), source.indexOf("\nit.skipIf"));
const refusal = (phase: number) => new Error("Refused phase " + phase);
it("the actual startup path uses the admitted owned HWND and then the initial runtime identity", async () => {
  const begin = source.indexOf("      const window = await poll("), end = source.indexOf("      phase = 5;", begin);
  expect(begin > 0 && end > begin).toBe(true);
  const calls: [string, number][] = [], module = { exports: undefined as unknown as () => Promise<void> };
  runInNewContext(transformSync(readoutHelpers + `\nmodule.exports=async()=>{let phase=3;const app={process:{pid:41}};
    const bridge={call:async(op,args)=>{calls.push([op,args.pid]);return{windows};}};
    const nodes=async hwnd=>{calls.push(["snapshot",hwnd]);return snapshot;};
    const poll=async(read,accept,ms)=>{calls.push(["wait",ms]);const value=await read();if(!accept(value))throw refusal(phase);return value;};
    const focus=async(hwnd,node)=>{calls.push(["focusHwnd",hwnd],["focusHandle",node.h]);};
    ${source.slice(begin, end)}};`, { loader: "ts", format: "cjs", target: "node22" }).code, {
    module, calls, refusal,
    windows: [{ pid: 42, hwnd: 11 }, { pid: 41, hwnd: 12, busy: true }, { pid: 41, hwnd: 13 }].map(window => ({ ...window, name: "Ember commands renderer bench" })),
    snapshot: [commandsReadout("", 1), commandsReadout("initial", 2)],
  });
  await expect(module.exports()).resolves.toBeUndefined();
  expect(calls).toEqual([["wait", 20_000], ["topWindows", 41], ["wait", 30_000], ["snapshot", 13], ["focusHwnd", 13], ["focusHandle", 2]]);
});
it.each(["fresh-only", "old-first", "fresh-first", "old-only", "two-fresh", "duplicate-fresh"] as const)(
  "the actual second-card path selects and reads only one fresh identity (%s)", async kind => {
    const old = commandsReadout("old", 1), fresh = commandsReadout("fresh", 2), other = commandsReadout("other", 3);
    const snapshots = { "fresh-only": [fresh], "old-first": [old, fresh], "fresh-first": [fresh, old],
      "old-only": [old], "two-fresh": [fresh, other], "duplicate-fresh": [fresh, fresh] };
    const begin = source.indexOf("      phase = 6;"), end = source.indexOf("      phase = 7;", begin);
    expect(begin > 0 && end > begin).toBe(true);
    const calls: [string, unknown][] = [], module = { exports: undefined as unknown as () => Promise<void> };
    runInNewContext(transformSync(readoutHelpers + `\nmodule.exports=async()=>{let phase=0;const hwnd=99, argv=["fixed"];
      const nodes=async()=>snapshot, current=()=>{};
      const poll=async(read,accept,ms)=>{calls.push(["wait",ms]);const value=await read();if(!accept(value))throw refusal(phase);return value;};
      const focus=async(_hwnd,node)=>{calls.push(["focus",node.h]);return{node:{...node,h:node.h+100}};};
      const bridge={call:async(op,args)=>{calls.push([op,args.handle]);return{text:"Node arguments: "+JSON.stringify(argv)};}};
      ${source.slice(begin, end)}};`, { loader: "ts", format: "cjs", target: "node22" }).code,
    { module, snapshot: snapshots[kind], display: old, calls, refusal });
    if (kind === "old-only" || kind === "two-fresh" || kind === "duplicate-fresh") {
      await expect(module.exports()).rejects.toThrow("Refused phase 6");
      expect(calls).toEqual([["wait", 45_000]]);
    } else {
      await expect(module.exports()).resolves.toBeUndefined();
      expect(calls).toEqual([["wait", 45_000], ["focus", 2], ["textInfo", 102]]);
    }
  },
);

function terminalComparison(enabled: boolean, terminalRuntime = "fresh") {
  const begin = source.indexOf("      phase = 7;"), end = source.indexOf("\n    };", begin);
  expect(begin > 0 && end > begin).toBe(true);
  const module = { exports: undefined as unknown as () => Promise<{ failures: number; frames: unknown[][]; calls: string[] }> };
  runInNewContext(transformSync(readoutHelpers + `\nmodule.exports=async()=>{let phase=0,failures=0,sequence=0;const frames=[],calls=[];
    const secondFocus={observation:{focus:15,identity:255}};
    const fail=()=>{calls.push("failure");failures++;};
    const poll=async(_read,_accept,ms)=>{calls.push("original-wait:"+ms);${enabled ? "return [];" : "throw new Error('Existing timeout.');"}};
    const sample=async()=>{calls.push("passive-dom");return{schema:1,sequence:++sequence,card:2,dom:15,geometry:255,reported:7,arm:2,assets:7,lifecycle:255};};
    const nodes=async()=>{calls.push("passive-uia");return[terminalReadout,{controlType:"Button",name:"Allow",isEnabled:true,isOffscreen:false},{controlType:"Button",name:"Not now",isEnabled:true}];};
    const emit=(...values)=>frames.push(values);const hwnd=99;${source.slice(begin, end)}return{failures,frames,calls};};`,
  { loader: "ts", format: "cjs", target: "node22" }).code,
    { module, display: commandsReadout("old", 1), second: commandsReadout("fresh", 2), terminalReadout: commandsReadout(terminalRuntime, 3), refusal, sameNativeFocusTarget });
  return module.exports();
}
it("preserves a failed original 30s wait even when every later passive observation becomes positive", async () => {
  const result = await terminalComparison(false);
  expect(result.failures).toBe(2); expect(result.frames).toHaveLength(1); expect(result.frames[0].at(-1)).toBe(false);
  expect(result.calls).toEqual(["original-wait:30000", "failure", "passive-dom", "passive-uia", "passive-dom", "failure"]);
});
it("keeps the positive original wait control and the stable genuine second-card comparison", async () => {
  const result = await terminalComparison(true);
  expect(result.failures).toBe(0); expect(result.frames[0].at(-1)).toBe(true);
  expect(result.calls).toEqual(["original-wait:30000", "passive-dom", "passive-uia", "passive-dom"]);
});
it("refuses a replaced native readout even when both passive DOM samples remain positive", async () => {
  const result = await terminalComparison(true, "replacement");
  expect(result.failures).toBe(1); expect(result.frames[0].at(-1)).toBe(false);
});
it("keeps native identity, ownership, bounded focus and the absent second click in the actual leaf", () => {
  expect(source).toContain("sameNativeFocusTarget(value, target)"); expect(source).toContain("nativeFocusObservation(value, target, hwnd).matched, 10_000");
  expect(source).toContain("input.activeWindow() !== hwnd"); expect(source).toContain("!fresh || fresh.isOffscreen || !fresh.bounds");
  expect(source).toContain("}, 240_000)"); expect(source).toContain("await bounded(work, 170_000)");
  expect(source.match(/input\.button\(1, (?:true|false)\)/g)).toEqual(["input.button(1, true)", "input.button(1, false)"]);
  expect(source.match(/\(allowFlags\(values\) & 2\) !== 0, 30_000/g)).toHaveLength(2);
  const begin = source.indexOf("      phase = 7;"), end = source.indexOf("\n    };", begin);
  expect(begin > 0 && end > begin).toBe(true); expect(source.slice(begin, end)).not.toMatch(/input\.|focus\(|perform/);
  expect(source).not.toMatch(/executeJavaScript|_electron|fuses|--no-sandbox["']\s*[,\]]/);
});
it("uses the staged app's actual fixed window title and dedicated profile contract", () => {
  const app = fs.readFileSync("test/fixtures/commands-renderer-native-app/main.cjs", "utf8");
  const title = /window\.setTitle\("([^"\n]+)"\)/.exec(app)?.[1]; expect(title).toBeTruthy();
  expect(source).toContain("window.name === " + JSON.stringify(title));
  expect(source).toContain("EMBER_COMMANDS_RENDERER_PROFILE: profile"); expect(app).toContain("process.env.EMBER_COMMANDS_RENDERER_PROFILE");
  expect(source).toContain('stage.app !== path.join(root, "application", "app")');
});
it("the actual current-owner fence refuses every observed early exit before further native reads or input", () => {
  const current = source.match(/^ {2}const current = \(\) => \{[^\n]+\};/m)?.[0]; expect(current).toBeTruthy();
  for (const appExit of [0, 1, 2, 3]) {
    const context = { retired: false, bridgeBroken: false, application: { broken: () => false, startup: () => ({ appExit }) }, phase: 1, refusal: () => new Error("Existing owner fence.") };
    const invoke = runInNewContext(current + "\ncurrent;", context) as () => void;
    if (appExit) expect(invoke).toThrow("Existing owner fence."); else expect(invoke).not.toThrow();
  }
});
it.each(["clean", "app-failure", "bridge-failure", "control-failure", "app-broken", "prior-failure", "input-failure"])("the actual cleanup retains every uncertain owner for %s", async kind => {
  const begin = source.indexOf("\n  finally {\n    retired = true;"), end = source.indexOf("\n  phase = failed ?", begin); expect(begin > 0 && end > begin).toBe(true);
  const cleanup = source.slice(begin, end).replace(/^\n {2}finally \{\n/, "").replace(/\n {2}\}$/, "");
  const module = { exports: undefined as unknown as (kind: string) => Promise<{ cleanup: boolean; failed: boolean; removed: number; retired: boolean }> };
  runInNewContext(transformSync(`module.exports=async(kind)=>{let retired=false,phase=7,failed=kind==='prior-failure',cleanup,removed=0;
    const root='/owned',work=Promise.resolve(),ownership={},retainedCommandsOwners=new Set([ownership]),fail=()=>{failed=true;},bounded=async promise=>promise;
    const control={quit:async()=>{},close:async()=>{if(kind==='control-failure')throw new Error('Fixed control failure.');}};
    const application={process:{exitCode:null,signalCode:null,kill(){}},closed:Promise.resolve({code:kind==='app-failure'?1:0,signal:null}),broken:()=>kind==='app-broken'};
    const ui={close:async()=>({code:kind==='bridge-failure'?1:0}),closed:Promise.resolve(),kill(){}};
    const bridgeBroken=false,native={releaseAll(){if(kind==='input-failure')throw new Error('Existing input close failure.');},close(){}};
    const fs={rmSync(){removed++;}};${cleanup}return{cleanup,failed,removed,retired};};`,
  { loader: "ts", format: "cjs", target: "node22" }).code, { module });
  const result = await module.exports(kind);
  expect(result.retired).toBe(true); expect(result.removed).toBe(kind === "clean" ? 1 : 0); expect(result.failed).toBe(kind !== "clean");
});
