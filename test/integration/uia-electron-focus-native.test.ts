/**
 * Real Electron + native UIA focus-order experiment, one strict case per Windows image. No product build required.
 * usage: EMBER_UIA_FOCUS_NATIVE_TEST=1 node scripts/run-integration.mjs test/integration/uia-electron-focus-native.test.ts
 * A passing six-condition experiment is negative evidence for an activation-order cause, never a product repair.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { types } from "node:util";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { expect, it } from "vitest";
import { openWin32Input } from "../../app/main/platform/win32/input";
import { bridgeEnv, UiaBridge, type RawNode, type UiaWindow } from "./uia-client";
import { nativeFocusEnvironment, nativeFocusObservation, sameNativeFocusTarget } from "../fixtures/uia-focus-contract";
import { createNativeFocusControl, type NativeFocusControl } from "../fixtures/native-focus-control";

const retainedFocusOwners = new Set<object>();

const required = process.env.EMBER_UIA_FOCUS_NATIVE_TEST === "1";
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function refusal(phase: number): Error { const error = new Error("Windows UIA focus primitive refused (phase " + phase + ")."); error.stack = "Error: " + error.message; return error; }
function ordinary(file: string): boolean { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1; }
// appReady:0pending/1sandbox-ready/2fixed-negative/3other-ready-frame/4stream-bound/5early-error/6early-exit.
// appExit:0unobserved/1zero/2nonzero/3signal-or-unknown; appError:existing error event0/1.
// appStage:1profile-check/2profile-set/3menu/4screen/5windows/6load/7show/8metrics/9sandbox-evaluated.
// bridgeReady:0pending/1resolved/2rejected; bridgeStage is the existing bounded stderr cache0..30.
// A last observed boundary is never a claim about the cause or success of that operation.
// loadCode:0unobserved/1aborted/2file-missing/3access-denied/4invalid-URL/5failed/6other-negative/7unknown.
// quit:0unobserved/1control-disconnect/2authenticated-quit/3all-windows-closed/4existing-catch; fixtureFlags below are observations only.
interface StartupApp { appReady: number; appExit: number; appError: number; appStage: number; loadCode: number; quit: number }
/** Cached startup facts only; neither their values nor an observer fault can change readiness or cleanup. */
function focusStartupObservation(app: unknown, bridgeReady: unknown, bridgeStage: unknown, phase: unknown, fixtureFlags: unknown) {
  const own = (key: string) => {
    if (!app || typeof app !== "object" || types.isProxy(app)) return undefined;
    const property = Object.getOwnPropertyDescriptor(app, key); return property && Object.hasOwn(property, "value") ? property.value : undefined;
  };
  const bounded = (value: unknown, maximum: number) => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum ? value : 0;
  return Object.freeze({ schema: 1, phase: bounded(phase, 8), appReady: bounded(own("appReady"), 6), appExit: bounded(own("appExit"), 3),
    appError: bounded(own("appError"), 1), appStage: bounded(own("appStage"), 9), bridgeReady: bounded(bridgeReady, 2), bridgeStage: bounded(bridgeStage, 30),
    loadCode: bounded(own("loadCode"), 7), quit: bounded(own("quit"), 4), fixtureFlags: bounded(fixtureFlags, 7) });
}
// Last boundary entered: 1 guard/activate, 2 foreground wait, 3 snapshot/select, 4 perform, 5 focused poll.
interface PrimeObservation { schema: 1; window: 1 | 2; stage: 1 | 2 | 3 | 4 | 5; target: number; focus: number; identity: number; foreground: number }
/** Bits 1 runtime, 2 PID, 4 control type, 8 focusable, 16 onscreen, 32 positive bounds. Absent facts leave bits clear. */
function focusPrimeTarget(node: unknown): number {
  const own = (value: unknown, key: string) => {
    if (!value || typeof value !== "object" || types.isProxy(value)) return undefined;
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property && Object.hasOwn(property, "value") ? property.value : undefined;
  };
  const runtime = own(node, "runtimeId"), pid = own(node, "pid"), controlType = own(node, "controlType"), bounds = own(node, "bounds");
  const width = own(bounds, "width"), height = own(bounds, "height");
  return (typeof runtime === "string" && runtime ? 1 : 0) | (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0 ? 2 : 0)
    | (typeof controlType === "string" && controlType ? 4 : 0) | (own(node, "isKeyboardFocusable") === true ? 8 : 0)
    | (own(node, "isOffscreen") === false ? 16 : 0)
    | (typeof width === "number" && Number.isFinite(width) && width > 0 && typeof height === "number" && Number.isFinite(height) && height > 0 ? 32 : 0);
}
/** Fixed checkout files only: bits1HTML/2package/4main each observed ordinary, single-link, small and canonical. No admission authority. */
function fixtureCustody(directory: string): number {
  let flags = 0;
  for (const [index, name] of ["index.html", "package.json", "main.cjs"].entries()) { try {
    const file = path.join(directory, name), stat = fs.lstatSync(file, { bigint: true });
    if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1n && stat.size > 0n && stat.size <= 16_384n &&
        fs.realpathSync.native(file).toLowerCase() === path.resolve(file).toLowerCase()) flags |= 1 << index;
  } catch { /* Unknown custody is not an instruction to skip, repair or relaunch. */ } }
  return flags;
}
interface OwnedChild { process: ChildProcessByStdio<null, Readable, Readable>; closed: Promise<{ code: number | null; signal: NodeJS.Signals | null }>; ready: Promise<boolean>; startup(): Readonly<StartupApp> }
function startOwned(executable: string, app: string, env: NodeJS.ProcessEnv, control: NativeFocusControl): OwnedChild {
  const process = spawn(executable, [app], { env: { ...env, EMBER_UIA_FOCUS_CONTROL: control.address, EMBER_UIA_FOCUS_NONCE: control.nonce }, stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
  const startup: StartupApp = { appReady: 0, appExit: 0, appError: 0, appStage: 0, loadCode: 0, quit: 0 };
  // Capture the owned process and close observation synchronously, before startup can fail or any await occurs.
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => process.once("close", (code, signal) => resolve({ code, signal })));
  let stageBuffer = "", stageBytes = 0, stageInvalid = false;
  process.stderr.on("data", (chunk: Buffer) => { try {
    if (stageInvalid) return;
    if (types.isProxy(chunk) || !Buffer.isBuffer(chunk) || Object.getPrototypeOf(chunk) !== Buffer.prototype ||
        ["length", "byteLength", "byteOffset", "buffer", "toString", "utf8Slice"].some(name => Object.getOwnPropertyDescriptor(chunk, name))) { stageInvalid = true; startup.appStage = 0; stageBuffer = ""; return; }
    stageBytes += chunk.length;
    if (stageBytes > 64 * 1024) { stageInvalid = true; startup.appStage = 0; stageBuffer = ""; return; }
    stageBuffer += Buffer.prototype.toString.call(chunk, "utf8");
    const lines = stageBuffer.split("\n"); stageBuffer = lines.pop() ?? "";
    for (const line of lines) if (line.includes("EMBER_UIA_FOCUS_STARTUP")) {
      const match = /^EMBER_UIA_FOCUS_STARTUP_V1:([1-9])\r?$/.exec(line);
      if (!match) { stageInvalid = true; startup.appStage = 0; stageBuffer = ""; return; }
      startup.appStage = Number(match[1]);
    }
    if (stageBuffer.length > 512) { stageInvalid = true; startup.appStage = 0; stageBuffer = ""; }
  } catch { stageInvalid = true; startup.appStage = 0; stageBuffer = ""; } });
  const ready = new Promise<boolean>(resolve => {
    let buffer = "", bytes = 0, settled = false;
    let loadSeen = false, loadInvalid = false;
    const finish = (value: boolean) => { if (!settled) { settled = true; buffer = ""; resolve(value); } };
    process.once("error", () => { startup.appError = 1; if (!settled) startup.appReady = 5; finish(false); });
    process.once("exit", (code, signal) => { startup.appExit = signal !== null && signal !== undefined ? 3 : code === 0 ? 1 : Number.isSafeInteger(code) ? 2 : 3; if (!settled) startup.appReady = 6; finish(false); });
    process.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length; if (bytes > 64 * 1024) { if (!settled) startup.appReady = 4; finish(false); return; }
      if (settled) return; buffer += chunk.toString("utf8");
      const lines = buffer.split("\n"); buffer = lines.pop() ?? "";
      for (const line of lines) {
        try { if (line.startsWith("EMBER_UIA_FOCUS_LOAD_V1:")) {
          const match = /^EMBER_UIA_FOCUS_LOAD_V1:([0-7]):([0-4])$/.exec(line);
          if (!match || loadInvalid || loadSeen && (startup.loadCode !== Number(match[1]) || startup.quit !== Number(match[2]))) {
            loadInvalid = true; startup.loadCode = 0; startup.quit = 0;
          } else { loadSeen = true; startup.loadCode = Number(match[1]); startup.quit = Number(match[2]); }
        } } catch { loadInvalid = true; startup.loadCode = 0; startup.quit = 0; }
        if (line === "EMBER_UIA_FOCUS_READY_V1:1") { if (!settled) startup.appReady = 1; finish(true); }
        else if (line.startsWith("EMBER_UIA_FOCUS_READY_V1:")) { if (!settled) startup.appReady = line === "EMBER_UIA_FOCUS_READY_V1:0" ? 2 : 3; finish(false); }
      }
      if (buffer.length > 512) { if (!settled) startup.appReady = 4; finish(false); }
    });
  });
  control.bindChild(process.pid);
  return { process, closed, ready: Promise.all([ready, control.authenticated]).then(([value]) => value, () => false), startup: () => Object.freeze({ ...startup }) };
}

it.skipIf(!required)("compares one native focus per fixed Electron target and activation condition without relaxing identity", async () => {
  let phase = 1, failed = false, firstFailure = 0, retired = false, bridgeBroken = false, root: string | undefined;
  let owned: OwnedChild | undefined, bridge: UiaBridge | undefined, input: ReturnType<typeof openWin32Input> = null, work: Promise<void> | undefined;
  let control: NativeFocusControl | undefined;
  const ownership: { root?: string; application?: OwnedChild; bridge?: UiaBridge; input?: ReturnType<typeof openWin32Input>; control?: NativeFocusControl; work?: Promise<void> } = {};
  retainedFocusOwners.add(ownership);
  let completed = 0, matchedMask = 0, cleanup: boolean, bridgeReady = 0, fixtureFlags = 0;
  let primeObservation: PrimeObservation | undefined;
  const fail = () => {
    if (!failed) {
      firstFailure = phase;
      try {
        if (phase === 4 && primeObservation) {
          const fixed = Object.freeze({ ...primeObservation });
          console.info("Windows UIA focus prime", JSON.stringify(fixed));
        }
      } catch { /* Preserve the original failure. */ }
      let app: unknown, stage: unknown;
      try { app = owned?.startup(); } catch { /* Unknown cached application startup. */ }
      try { stage = bridge?.startupStage; } catch { /* Unknown cached bridge startup. */ }
      try { console.info("Windows UIA focus startup", JSON.stringify(focusStartupObservation(app, bridgeReady, stage, phase, fixtureFlags))); } catch { /* Preserve the original failure. */ }
    }
    failed = true;
  };
  const current = () => { if (retired || bridgeBroken || control?.broken() || (owned?.startup().appExit ?? 0) !== 0) throw refusal(phase); };
  const bounded = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(refusal(phase)), ms); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    expect(process.platform).toBe("win32"); expect(process.arch).toBe("x64");
    const repository = fs.realpathSync.native(process.cwd()), load = createRequire(import.meta.url), pkg = load.resolve("electron/package.json");
    expect(path.resolve(pkg).toLowerCase()).toBe(path.join(repository, "node_modules/electron/package.json").toLowerCase());
    const installed = JSON.parse(fs.readFileSync(pkg, "utf8")), declared = JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8"));
    expect(installed.version).toBe(declared.devDependencies.electron); expect(fs.readFileSync(path.join(path.dirname(pkg), "path.txt"), "utf8")).toBe("electron.exe");
    const executable = path.join(path.dirname(pkg), "dist/electron.exe"); expect(ordinary(executable)).toBe(true);
    const temporary = fs.realpathSync.native(os.tmpdir()), parent = path.basename(temporary).startsWith("ember-run-") ? path.dirname(temporary) : temporary;
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, "ember-native-focus-order-")));
    ownership.root = root;
    const profile = path.join(root, "profile"), scratch = path.join(root, "temporary"); fs.mkdirSync(profile); fs.mkdirSync(scratch);
    const env = nativeFocusEnvironment(process.env, profile, scratch);
    input = openWin32Input(); ownership.input = input; expect(input).not.toBeNull();
    fixtureFlags = fixtureCustody(path.join(repository, "test/fixtures/uia-focus-app"));
    phase = 2;
    control = createNativeFocusControl(root); ownership.control = control;
    await bounded(control.listening, 5000);
    owned = startOwned(executable, path.join(repository, "test/fixtures/uia-focus-app"), env, control); ownership.application = owned;
    expect(owned.process.spawnargs.some(arg => arg === "--no-sandbox" || arg === "--disable-sandbox" || arg.startsWith("--inspect"))).toBe(false);
    bridge = new UiaBridge(path.join(repository, "sidecar/uia/ember_uia.ps1"), bridgeEnv(env, { EMBER_UIA_CACHE: path.join(root, "bridge-cache"), EMBER_UIA_STARTUP_OBSERVE: "1" }));
    ownership.bridge = bridge;
    const application = owned, ui = bridge, native = input!;
    void ui.ready.then(() => { bridgeReady = 1; }, () => { bridgeReady = 2; });
    const bridgeError = new Promise<never>((_resolve, reject) => { ui.child.once("error", () => { bridgeBroken = true; reject(refusal(phase)); }); });
    void bridgeError.catch(() => undefined);
    const poll = async <T>(read: () => Promise<T>, accept: (value: T) => boolean, ms: number): Promise<T> => {
      const end = Date.now() + ms;
      while (Date.now() < end) { current(); const value = await read(); current(); if (accept(value)) return value; await sleep(150); }
      throw refusal(phase);
    };
    const guard = (hwnd: number) => { current(); if (native.blockedReason?.(hwnd)) throw refusal(phase); };
    const foreground = async (hwnd: number) => {
      await poll(async () => {
        guard(hwnd); const value = native.activeWindow();
        if (primeObservation?.stage === 2) primeObservation.foreground = value === hwnd ? 1 : 0;
        return value;
      }, value => value === hwnd, 5000);
    };
    const snapshot = async (hwnd: number) => {
      guard(hwnd); const result = await ui.call<{ nodes: RawNode[]; busy: boolean; truncated: boolean; cut: string[] }>("snapshot", { hwnd, values: false, maxNodes: 2000, maxChildren: 500, deadlineMs: 3000 }, 5000); current();
      if (result.busy || result.truncated || result.cut.length || !result.nodes.length) throw refusal(phase); return result.nodes;
    };
    const select = (nodes: RawNode[], id: string) => {
      const node = nodes.find(value => value.automationId === id);
      if (primeObservation?.stage === 3) {
        try { primeObservation.target = focusPrimeTarget(node); } catch { /* Unknown cached target. */ }
      }
      if (!node || !node.runtimeId || typeof node.runtimeId !== "string" || !Number.isSafeInteger(node.pid) || node.pid! <= 0 || !node.controlType || node.isKeyboardFocusable !== true || node.isOffscreen !== false || !node.bounds || node.bounds.width <= 0 || node.bounds.height <= 0) throw refusal(phase);
      return node;
    };
    const focusOnce = async (hwnd: number, node: RawNode) => { guard(hwnd); expect(await ui.call("perform", { handle: node.h, op: "focus", deadlineMs: 2500 }, 5000)).toEqual({ ok: true }); current(); };
    const focusSample = async (hwnd: number, target: RawNode) => {
      guard(hwnd); const result = await ui.call("focused", { values: false, deadlineMs: 2500 }, 5000); guard(hwnd);
      const sample = { ...nativeFocusObservation(result, target, hwnd), foreground: native.activeWindow() === hwnd ? 1 : 0 };
      if (primeObservation?.stage === 5) {
        primeObservation.focus = sample.focus;
        primeObservation.identity = sample.identity;
        primeObservation.foreground = sample.foreground;
      }
      return sample;
    };
    const prime = async (hwnd: number, window: 1 | 2) => {
      const observation: PrimeObservation = { schema: 1, window, stage: 1, target: 0, focus: 0, identity: 0, foreground: 0 };
      primeObservation = observation;
      guard(hwnd); native.activate(hwnd);
      observation.stage = 2;
      await foreground(hwnd);
      observation.stage = 3;
      const old = select(await snapshot(hwnd), "prior-input");
      observation.stage = 4;
      await focusOnce(hwnd, old);
      observation.stage = 5;
      observation.foreground = 0;
      await poll(() => focusSample(hwnd, old), sample => sample.matched && sample.foreground === 1, 10_000);
      primeObservation = undefined;
    };
    const body = async () => {
      await bounded(Promise.all([Promise.race([ui.ready, bridgeError]), application.ready]), 30_000).then(([, sandboxed]) => { current(); if (!sandboxed) throw refusal(phase); });
      phase = 3;
      const windows = await poll(() => ui.call<{ windows: UiaWindow[] }>("topWindows", { pid: application.process.pid, deadlineMs: 3000 }, 5000),
        result => ["A", "B"].every(letter => result.windows.some(window => window.pid === application.process.pid && !window.busy && !window.skipped && window.name === "Ember native focus " + letter)), 20_000);
      const first = windows.windows.find(window => window.name === "Ember native focus A")!, other = windows.windows.find(window => window.name === "Ember native focus B")!;
      // Predetermined conditions, never a retry of a failed focus. Each target receives exactly one SetFocus per mode.
      for (const mode of [1, 2, 3]) for (const target of [1, 2]) {
        phase = 4; await prime(first.hwnd, 1); if (mode !== 3) await prime(other.hwnd, 2);
        const node = select(await snapshot(first.hwnd), target === 1 ? "focus-link" : "ask-cmd");
        phase = 5; if (mode !== 3) { guard(first.hwnd); if (native.activeWindow() !== other.hwnd) throw refusal(phase); native.activate(first.hwnd); if (mode === 2) await foreground(first.hwnd); }
        else if (native.activeWindow() !== first.hwnd) throw refusal(phase);
        phase = 6; await focusOnce(first.hwnd, node);
        phase = 7; let sample = { focus: 0, identity: 0, matched: false, foreground: 0 };
        const end = Date.now() + 10_000;
        while (Date.now() < end) { sample = await focusSample(first.hwnd, node); if (sample.matched && sample.foreground === 1) break; current(); await sleep(150); }
        let matched = sample.matched && sample.foreground === 1;
        if (matched) {
          const fresh = (await snapshot(first.hwnd)).find(value => sameNativeFocusTarget(value, node));
          matched = !!fresh && fresh.isOffscreen === false && !!fresh.bounds && fresh.bounds.width > 0 && fresh.bounds.height > 0 && native.activeWindow() === first.hwnd;
        }
        const index = completed++; if (matched) matchedMask |= 1 << index; else fail();
        console.info("Windows UIA focus condition", JSON.stringify({ schema: 1, mode, target, matched: matched ? 1 : 0, focus: sample.focus, identity: sample.identity, foreground: sample.foreground, performed: 1 }));
      }
    };
    work = body(); ownership.work = work; await bounded(work, 180_000);
  } catch { fail(); }
  finally {
    retired = true;
    phase = 8;
    try { if (work) await bounded(work.catch(() => undefined), 10_000); } catch { fail(); }
    let appClean = false, bridgeClean = false, controlClean = false;
    if (owned) {
      try {
        if (control) {
          const [, exit] = await bounded(Promise.all([control.quit(), owned.closed]), 10_000);
          appClean = exit.code === 0 && exit.signal === null;
        }
      } catch { /* Retain uncertain owner/profile. */ }
      if (!appClean && owned.process.exitCode === null && owned.process.signalCode === null) { try { owned.process.kill(); } catch { fail(); } }
    }
    if (control) { try { await bounded(control.close(), 10_000); controlClean = true; } catch { fail(); } }
    if (bridge) {
      try { const exit = await bounded(bridge.close(), 10_000); await bounded(bridge.closed, 5000); bridgeClean = exit.code === 0; } catch { try { bridge.kill(); } catch { fail(); } }
    }
    try { input?.releaseAll(); input?.close(); } catch { fail(); }
    cleanup = appClean && bridgeClean && controlClean && !bridgeBroken && !control?.broken();
    if (!cleanup) fail();
    if (!failed && cleanup && root) { try { fs.rmSync(root, { recursive: true, force: false }); retainedFocusOwners.delete(ownership); } catch { fail(); } }
  }
  phase = failed ? firstFailure : 8;
  console.info("Windows UIA focus summary", JSON.stringify({ schema: 1, completed, matchedMask, negative: !failed && completed === 6 && matchedMask === 63 && cleanup ? 1 : 0, phase }));
  if (failed || completed !== 6 || matchedMask !== 63) throw refusal(phase);
}, 240_000);
