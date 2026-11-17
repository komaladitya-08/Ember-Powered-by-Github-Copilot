/**
 * One real Windows Electron/UIA comparison of two synthetic Commands cards. No product, model or command authority.
 * usage: EMBER_COMMANDS_RENDERER_NATIVE_TEST=1 node scripts/run-integration.mjs test/integration/commands-renderer-native.test.ts
 * A passing control is negative evidence for this synthetic reproduction, never proof of a packaged-product repair.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { openWin32Input } from "../../app/main/platform/win32/input";
import { bridgeEnv, UiaBridge, type RawNode, type UiaWindow } from "./uia-client";
import { nativeFocusEnvironment, nativeFocusObservation, sameNativeFocusTarget } from "../fixtures/uia-focus-contract";
import { startCommandsRenderer, type OwnedCommandsRenderer } from "../fixtures/commands-renderer-native-driver";
import type { CommandsRendererSample } from "../fixtures/commands-renderer-native-contract";
import { createNativeCommandsControl, type NativeCommandsControl } from "../fixtures/native-commands-control";

const retainedCommandsOwners = new Set<object>();

const required = process.env.EMBER_COMMANDS_RENDERER_NATIVE_TEST === "1";
const argv = ["--preserve-symlinks", "--preserve-symlinks-main", "--experimental-test-isolation=none", "--test", "test.cjs"];
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
function refusal(phase: number): Error { const error = new Error("Windows Commands renderer refused (phase " + phase + ")."); error.stack = "Error: " + error.message; return error; }
function ordinary(file: string): boolean { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1; }
/** Only the same fixed synthetic renderer state on both sides can bracket a native exposure comparison. */
function stableSamples(before: CommandsRendererSample, after: CommandsRendererSample, card: number): boolean {
  return before.card === card && after.card === card && after.sequence === before.sequence + 1
    && (["dom", "geometry", "reported", "assets", "lifecycle"] as const).every(key => before[key] === after[key]);
}
/** Current admitted snapshot only: Allow present1/enabled2/disabled4/onscreen8, Not now enabled16. */
function allowFlags(nodes: readonly RawNode[]): number {
  let flags = 0;
  for (const node of nodes) {
    if (node.controlType !== "Button") continue;
    if (node.name === "Allow") flags |= 1 | (node.isEnabled === true ? 2 : node.isEnabled === false ? 4 : 0) | (node.isOffscreen === false ? 8 : 0);
    else if (node.name === "Not now" && node.isEnabled === true) flags |= 16;
  }
  return flags;
}
function uniqueMatch<T>(values: readonly T[], predicate: (value: T) => boolean, phase: number): T | undefined {
  const matches = values.filter(predicate);
  if (matches.length > 1) throw refusal(phase);
  return matches[0];
}
function currentReadout(values: readonly RawNode[], phase: number, retiredRuntime?: string): RawNode | undefined {
  return uniqueMatch(values, value => value.automationId === "ask-cmd" && typeof value.runtimeId === "string"
    && !!value.runtimeId && value.runtimeId !== retiredRuntime, phase);
}

it.skipIf(!required)("compares the authentic Commands renderer's measured second card with native UIA after the fixed failed run lifecycle", async () => {
  let phase = 1, failed = false, firstFailure = 0, retired = false, bridgeBroken = false, bridgeReady = 0, root: string | undefined;
  let application: OwnedCommandsRenderer | undefined, ui: UiaBridge | undefined, native: ReturnType<typeof openWin32Input> = null, work: Promise<void> | undefined;
  let control: NativeCommandsControl | undefined;
  const ownership: { root?: string; application?: OwnedCommandsRenderer; ui?: UiaBridge; native?: ReturnType<typeof openWin32Input>; control?: NativeCommandsControl; stage?: Promise<unknown>; work?: Promise<void>; closing?: Promise<void> } = {};
  retainedCommandsOwners.add(ownership);
  let completed = 0, matchedMask = 0, cleanup: boolean;
  const fail = () => {
    if (!failed) {
      firstFailure = phase;
      try {
        const app = application?.startup();
        console.info("Windows Commands renderer startup", JSON.stringify({ schema: 1, phase,
          appReady: app?.appReady ?? 0, appExit: app?.appExit ?? 0, appError: app?.appError ?? 0, appStage: app?.appStage ?? 0,
          bridgeReady, bridgeStage: ui?.startupStage ?? 0, loadCode: app?.loadCode ?? 0, quit: app?.quit ?? 0 }));
      } catch { /* A passive startup observation cannot replace the original failure. */ }
    }
    failed = true;
  };
  const current = () => { if (retired || bridgeBroken || application?.broken() || (application?.startup().appExit ?? 0) !== 0) throw refusal(phase); };
  const bounded = async <T>(promise: Promise<T>, ms: number): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([promise, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(refusal(phase)), ms); })]); }
    finally { clearTimeout(timer); }
  };
  try {
    expect(process.platform).toBe("win32"); expect(process.arch).toBe("x64");
    const repository = fs.realpathSync.native(process.cwd()), load = createRequire(import.meta.url), pkg = load.resolve("electron/package.json");
    expect(path.resolve(pkg).toLowerCase()).toBe(path.join(repository, "node_modules/electron/package.json").toLowerCase());
    expect(JSON.parse(fs.readFileSync(pkg, "utf8")).version).toBe(JSON.parse(fs.readFileSync(path.join(repository, "package.json"), "utf8")).devDependencies.electron);
    expect(fs.readFileSync(path.join(path.dirname(pkg), "path.txt"), "utf8")).toBe("electron.exe");
    const executable = path.join(path.dirname(pkg), "dist/electron.exe"); expect(ordinary(executable)).toBe(true);
    const temporary = fs.realpathSync.native(os.tmpdir()), parent = path.basename(temporary).startsWith("ember-run-") ? path.dirname(temporary) : temporary;
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, "ember-native-command-renderer-")));
    ownership.root = root;
    const profile = path.join(root, "profile"), scratch = path.join(root, "temporary"), check = path.join(root, "check"), staging = path.join(root, "application");
    for (const folder of [profile, scratch, check, staging]) fs.mkdirSync(folder);
    const env = { ...nativeFocusEnvironment(process.env, profile, scratch), EMBER_COMMANDS_RENDERER_PROFILE: profile, EMBER_COMMANDS_RENDERER_NATIVE_TEST: "1" };
    // Known public test source only; the observed synchronous exit owns and drains this one bounded Node child.
    fs.writeFileSync(path.join(check, "test.cjs"), "const {test}=require('node:test');const assert=require('node:assert/strict');test('sum',()=>assert.equal(1 + 1, 3));\n");
    const checked = spawnSync(process.execPath, argv, { cwd: check, env, stdio: ["ignore", "pipe", "pipe"], encoding: "buffer", maxBuffer: 64 * 1024, timeout: 5000, windowsHide: true });
    if (checked.error || checked.status !== 1 || checked.signal || !Buffer.isBuffer(checked.stdout) || !Buffer.isBuffer(checked.stderr)) throw refusal(phase);
    const tap = Buffer.concat([checked.stdout, checked.stderr]);
    if (!tap.length || tap.length > 64 * 1024 || !tap.includes(Buffer.from("ERR_ASSERTION"))) throw refusal(phase);
    phase = 2;
    const stagingWork = (async () => {
      const { stageCommandsRenderer } = await import("../fixtures/commands-renderer-native-build.mjs");
      return stageCommandsRenderer({ repository, stage: staging, tap });
    })(); ownership.stage = stagingWork;
    const stage = await bounded(stagingWork, 20_000);
    if (stage.assetsVerified !== true || stage.app !== path.join(root, "application", "app") || ![8, 9].includes(stage.rendererSources)) throw refusal(phase);
    native = openWin32Input(); ownership.native = native; if (!native) throw refusal(phase);
    control = createNativeCommandsControl(root); ownership.control = control;
    await bounded(control.listening, 5000);
    application = startCommandsRenderer(executable, stage.app, env, control); ownership.application = application;
    expect(application.process.spawnargs.some(arg => arg === "--no-sandbox" || arg === "--disable-sandbox" || arg.startsWith("--inspect"))).toBe(false);
    ui = new UiaBridge(path.join(repository, "sidecar/uia/ember_uia.ps1"), bridgeEnv(env, { EMBER_UIA_CACHE: path.join(root, "bridge-cache"), EMBER_UIA_STARTUP_OBSERVE: "1" }));
    ownership.ui = ui;
    const app = application, bridge = ui, input = native;
    void bridge.ready.then(() => { bridgeReady = 1; }, () => { bridgeReady = 2; });
    const bridgeError = new Promise<never>((_resolve, reject) => { bridge.child.once("error", () => { bridgeBroken = true; reject(refusal(phase)); }); });
    void bridgeError.catch(() => undefined);
    const poll = async <T>(read: () => Promise<T>, accept: (value: T) => boolean, ms: number): Promise<T> => {
      const end = Date.now() + ms;
      while (Date.now() < end) { current(); const value = await read(); current(); if (accept(value)) return value; await sleep(150); }
      throw refusal(phase);
    };
    const guard = (hwnd: number) => { current(); if (input.blockedReason?.(hwnd)) throw refusal(phase); };
    const nodes = async (hwnd: number): Promise<RawNode[]> => {
      guard(hwnd); const answer = await bridge.request("snapshot", { hwnd, values: false, maxNodes: 2000, maxChildren: 500, deadlineMs: 3000 }, 5000); current();
      if (answer.error?.code === "busy" || answer.error?.code === "gone") return [];
      if (answer.error) throw refusal(phase);
      const result = answer.result as { nodes: RawNode[]; busy: boolean; truncated: boolean; cut: string[] };
      if (result.busy) return [];
      if (result.truncated || result.cut.length || !result.nodes.length) throw refusal(phase);
      return result.nodes;
    };
    const focus = async (hwnd: number, target: RawNode) => {
      if (!sameNativeFocusTarget(target, target) || !target.controlType || !Number.isSafeInteger(target.h) || target.h <= 0) throw refusal(phase);
      guard(hwnd); input.activate(hwnd);
      expect(await bridge.call("perform", { handle: target.h, op: "focus", deadlineMs: 2500 }, 5000)).toEqual({ ok: true }); current();
      const result = await poll(() => bridge.call("focused", { values: false, deadlineMs: 2500 }, 5000), value => nativeFocusObservation(value, target, hwnd).matched, 10_000);
      const fresh = uniqueMatch(await nodes(hwnd), value => sameNativeFocusTarget(value, target), phase);
      if (!fresh || fresh.isOffscreen || !fresh.bounds || fresh.bounds.width <= 0 || fresh.bounds.height <= 0 || input.activeWindow() !== hwnd) throw refusal(phase);
      return { node: fresh, observation: nativeFocusObservation(result, target, hwnd) };
    };
    const sample = async (): Promise<Readonly<CommandsRendererSample>> => {
      current(); const sequence = (app.sample()?.sequence ?? 0) + 1;
      if (sequence > 16) throw refusal(phase);
      app.control.sample(sequence);
      const value = await poll(async () => app.sample(), latest => !!latest && latest.sequence === sequence && app.control.sampledSequence() === sequence, 5000);
      return value!;
    };
    const emit = (card: number, value: CommandsRendererSample, uia: number, focused: { focus: number; identity: number }, stable: boolean, matched: boolean) => {
      completed++; if (matched) matchedMask |= 1 << (card - 1);
      console.info("Windows Commands renderer observation", JSON.stringify({ schema: 1, card, sequence: value.sequence, dom: value.dom, geometry: value.geometry,
        reported: value.reported, arm: value.arm, assets: value.assets, lifecycle: value.lifecycle, uia, focus: focused.focus, identity: focused.identity,
        stable: stable ? 1 : 0, matched: matched ? 1 : 0 }));
    };
    const body = async () => {
      phase = 3;
      await bounded(Promise.all([Promise.race([bridge.ready, bridgeError]), app.ready]), 30_000).then(([, ready]) => { current(); if (!ready) throw refusal(phase); });
      const window = await poll(async () => {
        const { windows } = await bridge.call<{ windows: UiaWindow[] }>("topWindows", { pid: app.process.pid, deadlineMs: 3000 }, 5000);
        return uniqueMatch(windows, window => window.pid === app.process.pid && !window.busy && !window.skipped
          && window.name === "Ember commands renderer bench" && Number.isSafeInteger(window.hwnd) && window.hwnd > 0, phase);
      }, value => !!value, 20_000);
      const hwnd = window!.hwnd;
      phase = 4;
      const display = (await poll(async () => currentReadout(await nodes(hwnd), phase), value => !!value, 30_000))!;
      const firstFocus = await focus(hwnd, display);
      phase = 5;
      const firstNodes = await poll(() => nodes(hwnd), values => (allowFlags(values) & 2) !== 0, 30_000);
      const before = await sample(), firstSample = await sample(), firstStable = stableSamples(before, firstSample, 1);
      const firstMatched = firstStable && firstSample.dom === 15 && firstSample.geometry === 255 && firstSample.reported === 7 && firstSample.assets === 7 && allowFlags(firstNodes) === 27;
      emit(1, firstSample, allowFlags(firstNodes), firstFocus.observation, firstStable, firstMatched);
      if (!firstMatched) { fail(); throw refusal(phase); }
      const allow = uniqueMatch(firstNodes, value => value.controlType === "Button" && value.name === "Allow" && value.isEnabled === true, phase);
      if (!allow) throw refusal(phase);
      const click = await focus(hwnd, allow), bounds = click.node.bounds!;
      current(); guard(hwnd); input.move(bounds.x + Math.floor(bounds.width / 2), bounds.y + Math.floor(bounds.height / 2));
      try { input.button(1, true); } finally { input.button(1, false); input.releaseAll(); }
      phase = 6;
      const second = (await poll(async () => currentReadout(await nodes(hwnd), phase, display.runtimeId), value => !!value, 45_000))!;
      const secondFocus = await focus(hwnd, second);
      const text = await bridge.call<{ text?: string; secret?: boolean; truncated?: boolean }>("textInfo", { handle: secondFocus.node.h, maxChars: 32_000, deadlineMs: 2500 }, 5000); current();
      if (text.secret || text.truncated || text.text !== "Node arguments: " + JSON.stringify(argv)) throw refusal(phase);
      phase = 7;
      let enabled = true;
      try { await poll(() => nodes(hwnd), values => (allowFlags(values) & 2) !== 0, 30_000); }
      catch { enabled = false; fail(); }
      // Passive terminal comparison only. A failed original wait stays failed even if these later samples change.
      const left = await sample(), terminal = await nodes(hwnd), right = await sample(), stable = stableSamples(left, right, 2);
      const matched = enabled && stable && sameNativeFocusTarget(currentReadout(terminal, phase, display.runtimeId), second)
        && right.dom === 15 && right.geometry === 255 && right.reported === 7 && right.assets === 7 && right.lifecycle === 255 && allowFlags(terminal) === 27;
      emit(2, right, allowFlags(terminal), secondFocus.observation, stable, matched);
      if (!matched) fail();
    };
    // Leave room inside the 240s case for the bounded Node input, staging and observed owner cleanup.
    work = body(); ownership.work = work; await bounded(work, 170_000);
  } catch { fail(); }
  finally {
    retired = true; phase = 8;
    try { if (work) await bounded(work.catch(() => undefined), 10_000); } catch { fail(); }
    let appClean = false, bridgeClean = false, controlClean = false;
    const closeControl = async () => {
      if (control) { try { await control.quit(); } finally { await control.close(); } }
    };
    const closing = closeControl(); ownership.closing = closing; void closing.catch(() => undefined);
    if (application) {
      try { const [, exit] = await bounded(Promise.all([closing, application.closed]), 10_000); appClean = exit.code === 0 && exit.signal === null; controlClean = !!control; } catch { /* Retain uncertain synthetic owner. */ }
      if (!appClean && application.process.exitCode === null && application.process.signalCode === null) { try { application.process.kill(); } catch { fail(); } }
    }
    else { try { await bounded(closing, 10_000); } catch { fail(); } }
    if (ui) { try { const exit = await bounded(ui.close(), 10_000); await bounded(ui.closed, 5000); bridgeClean = exit.code === 0; } catch { try { ui.kill(); } catch { fail(); } } }
    try { native?.releaseAll(); native?.close(); } catch { fail(); }
    cleanup = appClean && bridgeClean && controlClean && !bridgeBroken && !application?.broken();
    if (!cleanup) fail();
    if (!failed && cleanup && root) { try { fs.rmSync(root, { recursive: true, force: false }); retainedCommandsOwners.delete(ownership); } catch { fail(); } }
  }
  phase = failed ? firstFailure : 8;
  console.info("Windows Commands renderer summary", JSON.stringify({ schema: 1, completed, matchedMask, negative: !failed && completed === 2 && matchedMask === 3 && cleanup ? 1 : 0, cleanup: cleanup ? 1 : 0, phase }));
  if (failed || completed !== 2 || matchedMask !== 3) throw refusal(phase);
}, 240_000);
