/**
 * VoiceService (main process) with a stand-in for Electron: the follow-up waits for Ember to stop
 * speaking, the kill switch's cancel, the download's states, muting, and speaking with listening off.
 */

import fs, { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- hoisted above the imports
  const { EventEmitter: Emitter } = require("node:events") as typeof import("node:events");
  const procs: (InstanceType<typeof Emitter> & { postMessage: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; stderr: null })[] = [];
  const windows: { title: string; webContents: InstanceType<typeof Emitter> & { send: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }; destroyed: boolean; url: string }[] = [];
  class BrowserWindow {
    title: string;
    url = "";
    webContents = Object.assign(new Emitter(), { send: vi.fn(), postMessage: vi.fn() });
    destroyed = false;
    constructor(o: { title: string }) { this.title = o.title; windows.push(this); }
    loadURL(url: string) { this.url = url; return Promise.resolve(); }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; }
  }
  return {
    procs, windows,
    app: { isPackaged: false },
    ipcMain: new Emitter(),
    net: { fetch: vi.fn() },
    session: { defaultSession: {} },
    BrowserWindow,
    MessageChannelMain: class { port1 = {}; port2 = {}; },
    utilityProcess: {
      fork: () => {
        const p = Object.assign(new Emitter(), { postMessage: vi.fn(), kill: vi.fn(), stderr: null });
        procs.push(p);
        return p;
      },
    },
  };
});
vi.mock("electron", () => electron);

import { VoiceGate } from "../../app/voice/match";
import { LISTEN_CUT_BY_QUESTION, LISTEN_ONCE_ANNOUNCED, VoiceService, cutByQuestion, heldByQuestion, listenOnceInSettings, questionHoldsListen, type VoiceOptions } from "../../app/main/voice";
import { VOICE, type MicState } from "../../app/shared/voice";
import { micBadge } from "../../app/shared/mic";
import crypto from "node:crypto";
import { CLEAR_SPEECH, NATURAL_VOICE, SUPERTONIC_VOICE, VOICE_MODELS, modelReady, modelsReady, type ModelId } from "../../app/voice/models";
import { calledByName, withoutAnnounced, type VoiceEvent } from "../../app/voice/engine";
import type { Logger } from "../../app/main/logger";

const log: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => log, file: "" };
let root: string;
let services: VoiceService[] = [];

/** A models folder that verifies (or an empty one), or one with only the models `ready` names. */
function modelsRoot(ready: boolean | readonly ModelId[]): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-voice-"));
  const ids = ready === true ? VOICE_MODELS.map(m => m.id) : ready === false ? [] : ready;
  for (const m of VOICE_MODELS) if (ids.includes(m.id)) { fs.mkdirSync(path.join(dir, m.target)); fs.writeFileSync(path.join(dir, `.${m.target}.ok`), `${m.sha256}\n`); }
  return dir;
}
const LISTENING: ModelId[] = ["kws", "vad", "asr"];
const markers = (dir: string) => fs.readdirSync(dir).filter(f => f.endsWith(".ok")).sort();
const markerOf = (id: ModelId) => `.${VOICE_MODELS.find(m => m.id === id)!.target}.ok`;

function service(ready: boolean | readonly ModelId[] = true, o: Partial<Pick<VoiceOptions, "neuralVoice" | "naturalVoice" | "naturalModel" | "naturalSupported" | "native" | "downloader" | "voiceprint" | "log" | "onNatural" | "onSample" | "testMicWav" | "onEvent" | "screenReaderOn">> & { onEnrol?: (e: unknown) => void } = {}) {
  root = modelsRoot(ready);
  const states: { s: MicState; detail?: string }[] = [];
  const events: VoiceEvent[] = [];
  // Neural synthesis is native-only; ASR still defaults to WebAssembly unless explicitly overridden.
  const v = new VoiceService({ log, modelsRoot: root, monitor: false, onEvent: e => events.push(e), onState: (s, detail) => states.push({ s, detail }), native: o.neuralVoice === true, ...o } as VoiceOptions);
  services.push(v);
  return { v, states, events };
}

const posted = (p: { postMessage: ReturnType<typeof vi.fn> }, type: string) => p.postMessage.mock.calls.map(c => c[0] as { type: string }).filter(m => m.type === type);
const flush = () => new Promise<void>(r => setImmediate(r));
/** Speaking events, as the mic (or speech) window sends them. */
const speaking = (win: { webContents: { send: ReturnType<typeof vi.fn> } }, on: boolean) => {
  const generation = win.webContents.send.mock.calls.filter(c => c[0] === VOICE.hush).at(-1)?.[1] ?? 0;
  electron.ipcMain.emit(VOICE.speaking, { sender: win.webContents }, on, generation);
};
const captured = (context = "running") => {
  const mic = electron.windows.findLast(w => w.title === "Ember microphone")!;
  electron.ipcMain.emit(VOICE.status, { sender: mic.webContents }, { state: "capturing", device: "Test microphone", rate: 16000, context });
  return mic;
};

beforeEach(() => { electron.app.isPackaged = false; electron.procs.length = 0; electron.windows.length = 0; electron.ipcMain.removeAllListeners(); electron.net.fetch.mockReset(); services = []; });
afterEach(() => { vi.useRealTimers(); for (const s of services) s.stop(); fs.rmSync(root, { recursive: true, force: true }); });

describe("the Supertonic voice", () => {
  it("is loaded by name, from its own folder, when it is the optional voice wanted", async () => {
    const { v } = service(true, { neuralVoice: true, naturalVoice: true, naturalModel: "supertonic", native: true, downloader: vi.fn() });
    fs.mkdirSync(path.join(root, SUPERTONIC_VOICE.target));
    fs.writeFileSync(path.join(root, `.${SUPERTONIC_VOICE.target}.ok`), `${SUPERTONIC_VOICE.sha256}\n`);
    v.speak("Hello.");
    expect(posted(electron.procs[0], "init")[0]).toMatchObject({ natural: path.join(root, SUPERTONIC_VOICE.target), naturalVoice: "supertonic" });
    expect(v.naturalStatus.model).toBe("supertonic");
  });

  it("isn't taken for Kokoro's download", () => {
    expect(SUPERTONIC_VOICE.target).not.toBe(NATURAL_VOICE.target);
    expect(SUPERTONIC_VOICE.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(VOICE_MODELS.map(m => m.id)).not.toContain("supertonic");
  });
});

describe("Hear me more clearly", () => {
  const inPlace = () => {
    fs.mkdirSync(path.join(root, CLEAR_SPEECH.target));
    fs.writeFileSync(path.join(root, `.${CLEAR_SPEECH.target}.ok`), `${CLEAR_SPEECH.sha256}\n`);
  };

  it("starts listening again with the clearer model, and without it once turned off", async () => {
    const { v } = service(true, { native: true, downloader: vi.fn() });
    inPlace();
    await v.setWanted(true);
    const [first] = electron.procs;
    expect((posted(first, "init")[0] as unknown as { models: { clear?: string } }).models.clear).toBeUndefined();
    first.emit("message", { type: "ready", loadMs: 20 });
    v.setClearHearing(true);
    expect(v.clearStatus.state).toBe("starting");
    expect(first.kill).toHaveBeenCalled();
    await flush();
    const second = electron.procs[1];
    expect((posted(second, "init")[0] as unknown as { models: { clear?: string } }).models.clear).toBe(path.join(root, CLEAR_SPEECH.target));
    second.emit("message", { type: "ready", loadMs: 20, backend: { backend: "native", detail: "", provider: "cpu", threads: 2, tried: [], clear: true } });
    expect(v.clearStatus.state).toBe("on");
    v.setClearHearing(false);
    expect(v.clearStatus.state).toBe("off");
    await flush();
    expect((posted(electron.procs[2], "init")[0] as unknown as { models: { clear?: string } }).models.clear).toBeUndefined();
  });

  it("starts listening again without it when turned off while the voice process was loading it (PR 181)", async () => {
    const { v } = service(true, { native: true, downloader: vi.fn() });
    inPlace();
    v.setClearHearing(true);
    await v.setWanted(true);
    const [first] = electron.procs;
    expect((posted(first, "init")[0] as unknown as { models: { clear?: string } }).models.clear).toBeDefined();
    v.setClearHearing(false);
    expect(first.kill).not.toHaveBeenCalled();
    first.emit("message", { type: "ready", loadMs: 20, backend: { backend: "native", detail: "", provider: "cpu", threads: 2, tried: [], clear: true } });
    expect(first.kill).toHaveBeenCalled();
    await flush();
    expect((posted(electron.procs[1], "init")[0] as unknown as { models: { clear?: string } }).models.clear).toBeUndefined();
    expect(v.clearStatus.state).toBe("off");
  });

  it("downloads again when turned back on while a cancelled download cleans up, but not after a failure (PR 181)", async () => {
    const settle: ((err?: Error) => void)[] = [];
    const downloader = vi.fn(() => new Promise<void>((resolve, reject) => { settle.push(err => err ? reject(err) : resolve()); }));
    const { v } = service(true, { native: true, downloader });
    v.setClearHearing(true);
    await flush();
    expect(downloader).toHaveBeenCalledTimes(1);
    v.setClearHearing(false);
    v.setClearHearing(true);
    expect(downloader).toHaveBeenCalledTimes(1);
    settle[0](new Error("aborted"));
    await flush();
    expect(v.clearStatus.state).toBe("downloading");
    await flush();
    expect(downloader).toHaveBeenCalledTimes(2);
    settle[1](new Error("The network dropped."));
    await flush();
    await flush();
    expect(v.clearStatus.state).toBe("failed");
    expect(downloader).toHaveBeenCalledTimes(2);
  });

  it("says so, and keeps listening, where the clearer model wouldn't load", async () => {
    const { v } = service(true, { native: true, downloader: vi.fn() });
    inPlace();
    v.setClearHearing(true);
    await v.setWanted(true);
    electron.procs[0].emit("message", { type: "ready", loadMs: 20, backend: { backend: "native", detail: "", provider: "cpu", threads: 2, tried: [] } });
    expect(v.clearStatus.state).toBe("wont-load");
    expect(electron.procs[0].kill).not.toHaveBeenCalled();
  });

  it("says how it stands once as each voice process is ready, never \"Starting…\" between (voice-listening-c4-1)", async () => {
    // Each ready set "starting" and then what checkClear found: the line under the switch changed twice as a Listen once
    // with wake listening off opened its window, and a screen reader said it over the request.
    const seen: string[] = [];
    const { v } = service(true, { native: false, onNatural: () => { seen.push(v.clearStatus.state); } });
    v.setClearHearing(true);
    expect(v.clearStatus.state).toBe("needs-native");
    v.listenOnce();
    const [temporary] = electron.procs;
    seen.length = 0;
    temporary.emit("message", { type: "ready", loadMs: 20 });
    expect(seen).not.toContain("starting");
    expect(v.clearStatus.state).toBe("needs-native");
  });

  it("fetches nothing where speech doesn't run natively", () => {
    const downloader = vi.fn();
    const { v } = service(true, { native: false, downloader });
    v.setClearHearing(true);
    expect(v.clearStatus.state).toBe("needs-native");
    expect(downloader).not.toHaveBeenCalled();
  });

  it("downloads only once it is turned on, and says what went wrong", async () => {
    const downloader = vi.fn(async () => { throw new Error("no network"); });
    const { v } = service(true, { native: true, downloader: downloader as never });
    await flush();
    expect(downloader).not.toHaveBeenCalled();
    v.setClearHearing(true);
    expect(v.clearStatus).toEqual({ state: "downloading", percent: 0 });
    await vi.waitFor(() => expect(v.clearStatus.state).toBe("failed"), { timeout: 20_000 });
  }, 30_000);
});

describe("VoiceService", () => {
  it("requires both a running capture and the recogniser before Listen once can arm", async () => {
    const { v } = service();
    expect(electron.procs).toHaveLength(0);
    await v.setWanted(true);
    const [proc] = electron.procs;
    captured();
    expect(v.listenOnce()).toBe(false);
    proc.emit("message", { type: "ready", loadMs: 20 });
    captured("suspended");
    expect(v.listenOnce()).toBe(false);
    captured();
    expect(v.listenOnceStatus.phase).toBe("ready");
    expect(v.listenOnce()).toBe(true);
    expect(v.listenOnce()).toBe(false);
    expect(posted(proc, "listen-once")).toEqual([{ type: "listen-once", generation: expect.any(Number), from: expect.any(Number), ms: 8000 }]);
    expect(v.listenOnceStatus.phase).toBe("starting");
  });

  it("opens temporary capture after recogniser readiness and closes it before dispatching one accepted request", async () => {
    let current: (() => boolean) | undefined;
    const onEvent = vi.fn((event: VoiceEvent) => { if (event.type === "utterance") current = v.listenOnceStillCurrent(); });
    const { v } = service(true, { onEvent });
    expect(v.listenOnceStatus.phase).toBe("ready");
    expect(electron.windows).toHaveLength(0);
    expect(v.listenOnce()).toBe(true);
    await flush();
    const [proc] = electron.procs;
    const [mic] = electron.windows;
    expect(posted(proc, "init")[0]).toMatchObject({ manualOnly: true, monitor: false });
    expect(mic.webContents.postMessage).not.toHaveBeenCalled();
    proc.emit("message", { type: "ready", loadMs: 20 });
    expect(mic.webContents.postMessage).toHaveBeenCalledOnce();
    expect(posted(proc, "listen-once")).toHaveLength(0);
    captured();
    const generation = (posted(proc, "listen-once")[0] as { type: string; generation: number }).generation;
    proc.emit("message", { type: "wake", keyword: "hey_ember", generation });
    expect(onEvent).not.toHaveBeenCalled();
    expect(v.enrol()).toBe(false);
    proc.emit("message", { type: "listening", window: "manual", on: false, reason: "done", generation });
    expect(mic.destroyed).toBe(true);
    expect(proc.kill).not.toHaveBeenCalled();
    onEvent.mockClear();
    const request = { type: "utterance", window: "manual", text: "One request.", ms: 0, generation };
    proc.emit("message", request);
    proc.emit("message", request);
    expect(onEvent).toHaveBeenCalledOnce();
    expect(mic.destroyed).toBe(true);
    expect(proc.kill).toHaveBeenCalled();
    expect(v.micState).toBe("off");
    expect(current?.()).toBe(true);
    v.cancelListening();
    expect(current?.()).toBe(false);
    v.followUp();
    expect(posted(proc, "follow-up")).toHaveLength(0);
  });

  it.each(["cancel", "mute", "lock", "permission", "device", "wake setting", "startup timeout"] as const)(
    "retires temporary capture without reopening it on %s", async reason => {
      const { v } = service();
      vi.useFakeTimers();
      expect(v.listenOnce()).toBe(true);
      await Promise.resolve();
      const [proc] = electron.procs;
      const [mic] = electron.windows;
      if (reason === "cancel") v.cancelListenOnce();
      if (reason === "mute") v.setMuted(true);
      if (reason === "lock") v.setLocked(true);
      if (reason === "permission" || reason === "device") electron.ipcMain.emit(VOICE.status, { sender: mic.webContents }, { state: reason === "permission" ? "error" : "lost", message: "NotAllowedError" });
      if (reason === "wake setting") await v.setWanted(false);
      if (reason === "startup timeout") vi.advanceTimersByTime(30_000);
      proc.emit("message", { type: "ready", loadMs: 20 });
      vi.advanceTimersByTime(60_000);
      expect(mic.destroyed).toBe(true);
      expect(proc.kill).toHaveBeenCalled();
      expect(electron.procs).toHaveLength(1);
      expect(posted(proc, "listen-once")).toHaveLength(0);
    },
  );

  it("lets Listen once stop Ember talking first, then listen once it has stopped (the keyboard's way to cut in; voice-listening-7)", async () => {
    const { v } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 20 });
    const mic = captured();
    v.speak("Here is a long answer, read out sentence by sentence.");
    speaking(mic, true);
    expect(v.listenOnceStatus).toEqual({ phase: "ready", detail: "Stops Ember talking, then listens for one request." });
    const hushes = mic.webContents.send.mock.calls.filter(c => c[0] === VOICE.hush).length;
    expect(v.listenOnce()).toBe(true);
    // Hushed at once; nothing heard until the page says Ember's voice has stopped (its own words aren't the request).
    expect(mic.webContents.send.mock.calls.filter(c => c[0] === VOICE.hush).length).toBe(hushes + 1);
    expect(posted(proc, "listen-once")).toHaveLength(0);
    expect(v.listenOnceStatus.phase).toBe("starting");
    speaking(mic, false);
    expect(posted(proc, "listen-once")).toHaveLength(1);
    // Main stops an answer on its way first, as a wake does; a question still has to be answered first.
    const main = readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8");
    expect(main).not.toMatch(/Wait for Ember['’]s answer to finish\./);
    expect(main).toContain(`const answer = agent?.answerOpen && now.phase === "ready" ? { ...now, detail: "Stops Ember's answer, then listens for one request." } : now;`);
    expect(main).toMatch(/listenOnceStatus\(source\)\.phase === "ready"\) \{\s*\/\/[^\n]*\n\s*if \(agent\?\.answerOpen\) agent\.interruptAnswer\(\);/);
    expect(main).toContain(`if (questionHoldsListen(!!confirmer?.waiting, manualCall?.source === source ? voice?.listenOnceStatus : undefined)) return heldByQuestion(voice?.micState);`);
  });

  it("doesn't tell screen readers to answer the question first while a conversation waits for that answer (voice-listening-v4-1)", () => {
    // A conversation stays open while a question waits, so it can be answered by voice: "Answer Ember's question
    // first." said then went through the speakers into it, as a request or as another voice, after which Voice Match
    // took no spoken answer to the question.
    expect(heldByQuestion("active")).toEqual({ phase: "blocked", detail: "Answer Ember's question first.", reason: "listening" });
    // Outside a window it is said as before: the microphone is listening for the name, or off.
    for (const mic of ["waiting", "off", "muted", "starting", "error", undefined] as const) expect(heldByQuestion(mic), String(mic)).toEqual({ phase: "blocked", detail: "Answer Ember's question first." });
  });

  it("keeps Cancel listening for a Listen once under way when a task asks a question, and holds back a new one (companion-r1)", async () => {
    // Pressed in Ask, then a question came before the request was said: the microphone still listens, so its control
    // still says Cancel listening (it turned into a dimmed Listen once that took no press).
    for (const phase of ["starting", "listening", "checking"] as const) expect(questionHoldsListen(true, { phase, detail: "" }), phase).toBe(false);
    // Nothing under way from that control (or the other control's, which isn't passed): a question holds it back.
    expect(questionHoldsListen(true, undefined)).toBe(true);
    expect(questionHoldsListen(true, { phase: "ready", detail: "" })).toBe(true);
    expect(questionHoldsListen(true, { phase: "blocked", detail: "The microphone is muted." })).toBe(true);
    expect(questionHoldsListen(false, undefined)).toBe(false);
    // Main asks the voice only for the control whose listen it is, before the question holds it back.
    const main = readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8");
    const at = (t: string) => main.indexOf(t);
    const other = `if (manualCall && source !== manualCall.source) return { ...blocked("Ember is already listening."), reason: "listening" };`;
    expect(at(other)).toBeGreaterThan(0);
    expect(at(other)).toBeLessThan(at("if (questionHoldsListen("));
  });

  it("says a question ended the request it was hearing, on that control only, while the question is up (companion-r2-2)", () => {
    // A question that comes while Listen once hears a request ends it (main's questionChanged cancels it): the control
    // whose listen it was says so, not just "Answer Ember's question first.", so nobody talks on to a closed microphone.
    for (const phase of ["starting", "listening", "checking"] as const) expect(cutByQuestion("ask", { phase, detail: "" }), phase).toBe("ask");
    expect(cutByQuestion("home", { phase: "listening", detail: "" })).toBe("home");
    expect(cutByQuestion("ask", { phase: "ready", detail: "" })).toBeNull();
    expect(cutByQuestion(undefined, { phase: "listening", detail: "" })).toBeNull();
    expect(LISTEN_CUT_BY_QUESTION).toBe("I stopped listening to ask you something. Answer it, then ask again.");
    const main = readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8");
    const qc = main.slice(main.indexOf("const questionChanged = "));
    const body = qc.slice(0, qc.indexOf("\n  };"));
    // Taken before anything else in it (before the listen is cancelled), and forgotten once no question is up.
    expect(body.indexOf("listenCutFor = q ? listenCutFor ?? cutByQuestion(manualCall?.source, voice?.listenOnceStatus) : null;")).toBeGreaterThan(0);
    expect(body.indexOf("listenCutFor = q ?")).toBeLessThan(body.indexOf("syncListenOnce();"));
    expect(body.indexOf("listenCutFor = q ?")).toBeLessThan(body.indexOf("voice?.cancelListenOnce();"));
    expect(main.indexOf("if (confirmer?.waiting && listenCutFor === source) return blocked(LISTEN_CUT_BY_QUESTION);")).toBeLessThan(main.indexOf("if (questionHoldsListen("));
  });

  it("says which microphone it hears through while it captures, and nothing once it doesn't (voice-listening-v2)", async () => {
    const { v } = service();
    expect(v.micLabel).toBeNull();
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 20 });
    const mic = captured();
    expect(v.micLabel).toBe("Test microphone");
    electron.ipcMain.emit(VOICE.status, { sender: mic.webContents }, { state: "capturing", device: `  ${"Headset ".repeat(30)}`, rate: 16000, context: "running" });
    expect(v.micLabel).toHaveLength(80);
    electron.ipcMain.emit(VOICE.status, { sender: mic.webContents }, { state: "capturing", device: "", rate: 16000, context: "running" });
    expect(v.micLabel).toBeNull();
    v.setMuted(true);
    expect(v.micLabel).toBeNull();
  });

  it("says what to do next when a temporary Listen once's voice process stops (voice-listening-8)", async () => {
    const { v } = service();
    expect(v.listenOnce()).toBe(true);
    await Promise.resolve();
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 20 });
    proc.emit("exit", 1);
    expect(v.listenOnceStatus).toEqual({ phase: "ready", detail: "The voice process stopped. Try again." });
  });

  it("points Listen once in Settings to the download and the voice line there, not to Settings itself (accessibility-visual-9, voice-listening-8)", async () => {
    const none = service(false);
    expect(none.v.listenOnceStatus).toEqual({ phase: "blocked", detail: "Download speech models in Settings first.", reason: "needs-models" });
    expect(listenOnceInSettings(none.v.listenOnceStatus)).toEqual({ phase: "blocked", detail: "Download the speech models below first.", reason: "needs-models" });
    const broken = service();
    await broken.v.setWanted(true);
    const [proc] = electron.procs.slice(-1);
    proc.emit("message", { type: "error", message: "Something broke." });
    expect(broken.v.listenOnceStatus.reason).toBe("voice-error");
    expect(listenOnceInSettings(broken.v.listenOnceStatus).detail).toBe("Check the microphone and the voice status above.");
    // Anything else reads the same in Ask and in Settings.
    const ready = { phase: "ready", detail: "Request heard." } as const;
    expect(listenOnceInSettings(ready)).toBe(ready);
    expect(readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8")).toContain('return source === "home" ? listenOnceInSettings(heard) : heard;');
  });

  it("keeps a manual request until Voice Match finishes, then accepts it only once", async () => {
    const { v, events } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 20 });
    captured();
    v.listenOnce();
    const generation = (posted(proc, "listen-once")[0] as { generation?: number }).generation;
    const send = (e: VoiceEvent) => proc.emit("message", { ...e, generation });
    const gate = new VoiceGate(() => ({ print: async () => Float32Array.of(1, 0) }), send, () => undefined);
    gate.setOwner(Float32Array.of(1, 0));
    send({ type: "listening", on: true, reason: "manual", window: "manual" });
    const request = { type: "utterance", text: "One request.", ms: 0, window: "manual" } as const;
    gate.event(request, new Float32Array(16_000).fill(0.1));
    send({ type: "listening", on: false, reason: "done", window: "manual" });
    expect(v.listenOnceStatus.phase).toBe("checking");
    expect(events.filter(e => e.type === "utterance")).toEqual([]);
    await flush();
    send(request);
    expect(events.filter(e => e.type === "utterance")).toEqual([{ ...request, verified: true }]);
    expect(v.listenOnceStatus).toEqual({ phase: "ready", detail: "Request heard." });
  });

  it("waits for a request still being spoken at Listen once's 8 s deadline, and says it was heard (voice-listening-1)", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { v, events } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 20 });
    captured();
    v.listenOnce();
    const generation = (posted(proc, "listen-once")[0] as { generation?: number }).generation;
    const send = (e: VoiceEvent) => proc.emit("message", { ...e, generation });
    send({ type: "listening", on: true, reason: "manual", window: "manual" });
    // The request began at 7 s and ran to 17 s (the engine caps it at 20 s from the press, MANUAL_MAX_MS).
    vi.advanceTimersByTime(19_000);
    expect(v.listenOnceStatus.phase).toBe("listening");
    const request = { type: "utterance", text: "Open the calendar and show me next Tuesday afternoon.", ms: 0, window: "manual" } as const;
    send(request);
    expect(events.filter(e => e.type === "utterance")).toEqual([request]);
    expect(v.listenOnceStatus).toEqual({ phase: "ready", detail: "Request heard." });
    // The voice process going quiet is still caught, past the engine's own limit.
    v.listenOnce();
    vi.advanceTimersByTime(23_001);
    expect(v.listenOnceStatus).toEqual({ phase: "ready", detail: "Listening timed out. Try again." });
  });

  it("says Listen once is listening, never “Hearing you”, while it waits for a request, and says nothing new once speech starts (voice-listening-c2-2)", async () => {
    const { v, states } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 20 });
    captured();
    v.listenOnce();
    const generation = (posted(proc, "listen-once")[0] as { generation?: number }).generation;
    states.length = 0;
    proc.emit("message", { generation, type: "listening", on: true, reason: "manual", window: "manual" });
    expect(states).toEqual([{ s: "active", detail: "Listening…" }]);
    // (A change on the voice line as the user starts would be a screen reader's words over theirs: voice-listening-c2-1.)
    proc.emit("message", { generation, type: "speech", on: true });
    expect(states).toEqual([{ s: "active", detail: "Listening…" }]);
    proc.emit("message", { generation, type: "listening", on: false, reason: "timeout", window: "manual" });
    expect(states.at(-1)).toEqual({ s: "waiting", detail: undefined });
    // The handle's badge says so too, in every window: it listens, and hears the user only once they speak.
    expect(micBadge("active")!.label).toBe("Listening");
  });

  it.each(["heard", "checked", "timeout", "cancel"] as const)("never says it listens for “Ember” as a Listen once with wake listening off opens or ends (%s; voice-listening-r3-1)", async end => {
    // "Listening for “Ember” through …" was up for a moment as the window opened and as it closed, though Ember wasn't
    // listening for its name, and a screen reader said it over the microphone as the request began.
    const { v, states } = service();
    expect(v.listenOnce()).toBe(true);
    await flush();
    const proc = electron.procs.at(-1)!;
    proc.emit("message", { type: "ready", loadMs: 20 });
    captured();
    const generation = (posted(proc, "listen-once")[0] as { generation?: number }).generation;
    const request = { generation, type: "utterance", window: "manual", text: "One request.", ms: 0 };
    proc.emit("message", { generation, type: "listening", on: true, reason: "manual", window: "manual" });
    if (end === "heard") proc.emit("message", request);
    if (end === "checked") {
      // Voice Match checks it after the window: the microphone is closed meanwhile, and it is still this request's.
      proc.emit("message", { generation, type: "listening", on: false, reason: "done", window: "manual" });
      expect(states.at(-1)).toEqual({ s: "active", detail: "Listening…" });
      proc.emit("message", request);
    }
    if (end === "timeout") proc.emit("message", { generation, type: "listening", on: false, reason: "timeout", window: "manual" });
    if (end === "cancel") v.cancelListenOnce();
    expect(states.map(s => s.s)).toEqual(["starting", "active", "off"]);
    expect(v.listenOnceStatus.phase).toBe("ready");
  });

  it("goes straight from a wake's window into its conversation, and says Listen once is blocked by it as a line screen readers aren't told (voice-listening-c3-1)", async () => {
    // Both lines went "Listening for “Ember”" (and "Stops Ember's answer…") and back in the same millisecond as the
    // conversation opened, and a screen reader saying "Ember is already listening." was heard as the next request.
    const lines: string[] = [];
    const { v, states } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 20 });
    captured();
    const generation = (posted(proc, "init")[0] as { generation?: number }).generation;
    const send = (e: VoiceEvent) => { proc.emit("message", { ...e, generation }); lines.push(v.listenOnceStatus.detail); };
    states.length = 0;
    send({ type: "wake", keyword: "hey_ember" });
    send({ type: "listening", on: true, reason: "wake", window: "wake" });
    expect(v.listenOnceStatus).toEqual({ phase: "blocked", detail: "Ember is already listening.", reason: "listening" });
    send({ type: "utterance", text: "Turn on night light.", ms: 0, window: "wake" });
    send({ type: "listening", on: false, reason: "done", window: "wake", next: "conversation" });
    send({ type: "listening", on: true, reason: "conversation", window: "conversation" });
    expect(states.map(s => s.s)).not.toContain("waiting");
    expect(new Set(lines.slice(1))).toEqual(new Set(["Ember is already listening."]));
    // The conversation over: listening for “Ember” again, and Listen once can be used.
    send({ type: "listening", on: false, reason: "timeout", window: "conversation" });
    expect(states.at(-1)!.s).toBe("waiting");
    expect(v.listenOnceStatus.phase).toBe("ready");
    // A window that opens no conversation (conversations off) ends as before.
    send({ type: "wake", keyword: "hey_ember" });
    send({ type: "listening", on: true, reason: "wake", window: "wake" });
    send({ type: "listening", on: false, reason: "done", window: "wake" });
    expect(states.at(-1)!.s).toBe("waiting");
    // Main marks the other control's Listen once under way the same way.
    const main = readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8");
    expect(main).toContain(`if (manualCall && source !== manualCall.source) return { ...blocked("Ember is already listening."), reason: "listening" };`);
  });

  it("says a follow-up's or a conversation's window is listening, and “Hearing you” only after a wake, where the user has just spoken (voice-listening-r3-2)", async () => {
    // "Hearing you…" was up for up to 30 s after every answer though nobody spoke, while the handle's badge said "Listening".
    const { v, states } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 20 });
    captured();
    const generation = (posted(proc, "init")[0] as { generation?: number }).generation;
    for (const window of ["follow-up", "conversation"] as const) {
      proc.emit("message", { generation, type: "listening", on: true, reason: window, window });
      expect(states.at(-1), window).toEqual({ s: "active", detail: "Listening…" });
      proc.emit("message", { generation, type: "listening", on: false, reason: "timeout", window });
      expect(states.at(-1), window).toEqual({ s: "waiting", detail: undefined });
    }
    proc.emit("message", { generation, type: "listening", on: true, reason: "wake", window: "wake" });
    expect(states.at(-1)).toEqual({ s: "active", detail: undefined });
    expect(readFileSync(path.resolve("app/renderer/home/main.ts"), "utf8")).toContain('active: "Hearing you…"');
    expect(micBadge("active")!.label).toBe("Listening");
  });

  it("tells the voice process what a screen reader will say as Listen once opens, only while one runs (voice-listening-c2-1)", async () => {
    for (const reader of [true, false]) {
      const { v } = service(true, { screenReaderOn: () => reader });
      await v.setWanted(true);
      const [proc] = electron.procs.slice(-1);
      proc.emit("message", { type: "ready", loadMs: 20 });
      captured();
      const starting = v.listenOnceStatus.detail;
      v.listenOnce();
      const posted0 = posted(proc, "listen-once")[0] as { announced?: string[]; generation?: number };
      proc.emit("message", { generation: posted0.generation, type: "listening", on: true, reason: "manual", window: "manual" });
      if (!reader) { expect(posted0.announced).toBeUndefined(); continue; }
      // (With what the voice line said while Ember listened for its name, with the microphone's name: voice-listening-r3-1.)
      expect(posted0.announced).toEqual([...LISTEN_ONCE_ANNOUNCED, "Listening for “Ember” through Test microphone"]);
      // As the recognizer wrote a screen reader saying them before the request, on the real models.
      expect(withoutAnnounced("Listening for ember. Listening for one request. Listening. And turn on Do Not Disturb 2.", posted0.announced!)).toBe("And turn on Do Not Disturb 2.");
      expect(withoutAnnounced("Listening for ember, listening for one request, listening, and turn on do not disturb to.", posted0.announced!)).toBe("And turn on do not disturb to.");
      expect(withoutAnnounced("Listening for Amber through test microphone. Listening for one request. What's on my calendar?", posted0.announced!)).toBe("What's on my calendar?");
      expect(withoutAnnounced("Listening for ember. Listening for one request. Listening.", posted0.announced!)).toBe("");
      // Each is what a window says then: the status line, the voice line, and the button's new name.
      expect(starting).not.toBe("Listening for one request…");
      expect(LISTEN_ONCE_ANNOUNCED).toContain(v.listenOnceStatus.detail);
      expect(LISTEN_ONCE_ANNOUNCED).toContain("Listening…");
      expect(LISTEN_ONCE_ANNOUNCED).toContain("Starting to listen…");
      const button = readFileSync(path.resolve("app/renderer/shared/listen-once.ts"), "utf8");
      expect(button).toContain('const label = listening(status) ? "Cancel listening" : "Listen once";');
      expect(button).toContain('pending.on ? "Checking the microphone…" : "Cancelling…"');
      expect(LISTEN_ONCE_ANNOUNCED).toContain("Checking the microphone…");
      expect(readFileSync(path.resolve("app/renderer/home/main.ts"), "utf8")).toContain('starting: "Starting…"');
      expect(LISTEN_ONCE_ANNOUNCED).toContain("Listening for “Ember”");
      expect(readFileSync(path.resolve("app/renderer/home/main.ts"), "utf8")).toContain('waiting: "Listening for “Ember”"');
      expect(readFileSync(path.resolve("app/renderer/home/copy.ts"), "utf8")).toContain("? `${text} through ${micLabel}` : text;");
      v.stop();
    }
  });

  it("says the microphone sends only silence, not “No request heard”, when Listen once heard only zeros (voice-listening-4)", async () => {
    const { v } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 20 });
    captured();
    for (const silent of [true, false]) {
      v.listenOnce();
      const generation = (posted(proc, "listen-once").at(-1) as { generation?: number }).generation;
      proc.emit("message", { generation, type: "listening", on: true, reason: "manual", window: "manual" });
      if (silent) proc.emit("message", { type: "silent", on: true, manual: true });
      proc.emit("message", { generation, type: "listening", on: false, reason: "timeout", window: "manual" });
      expect(v.listenOnceStatus.detail).toBe(silent ? "The microphone is sending only silence. Check that the right microphone is chosen, and not muted, in the sound settings." : "No request heard. Try again.");
      // Only that window says so: listening for “Ember” carries on as it was.
      expect(v.micState).toBe("waiting");
    }
  });

  it("says it heard talking it couldn't tell was a request, not that it heard none, when Listen once ends on such talk (voice-listening-r2-1, voice-listening-1)", async () => {
    // A request begun at once and still being said 12 s after the press was thrown away with "No request heard. Try
    // again.", though the user had been speaking the whole time.
    const { v } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 20 });
    captured();
    for (const doubt of [true, false]) {
      v.listenOnce();
      const generation = (posted(proc, "listen-once").at(-1) as { generation?: number }).generation;
      proc.emit("message", { generation, type: "listening", on: true, reason: "manual", window: "manual" });
      proc.emit("message", { generation, type: "listening", on: false, reason: "timeout", window: "manual", ...(doubt ? { doubt: true } : {}) });
      expect(v.listenOnceStatus.detail).toBe(doubt ? "I heard talking but couldn't tell it was a request. Wait a moment after pressing Listen once, then speak." : "No request heard. Try again.");
    }
  });

  it("words that doubt for Settings without \"I\" or the name, and keeps the first person in Ask (voice-listening-v4-3, voice-listening-r4-3)", () => {
    // Ember isn't "I" in Settings. Said as the window ends, into the wake word's microphone, a line with the name in it
    // was heard as a request.
    const ask = { phase: "ready", detail: "I heard talking but couldn't tell it was a request. Wait a moment after pressing Listen once, then speak." } as const;
    const home = listenOnceInSettings(ask);
    expect(home).toEqual({ phase: "ready", detail: "There was talking, but it wasn't clear it was a request. Wait a moment after pressing Listen once, then speak." });
    expect(home.detail).not.toMatch(/\bEmber\b|\bI\b/);
    expect(listenOnceInSettings({ phase: "ready", detail: "No request heard. Try again." }).detail).toBe("No request heard. Try again.");
  });

  it("ends Listen once, in Settings and in Ask, with no line that wakes Ember when a screen reader says it into the wake word's microphone (voice-listening-r4-3)", async () => {
    // "There was talking, but Ember couldn't tell it was a request…", said as the window ended with wake listening back
    // on, woke Ember in 6 of 40 real-model placements: the check hears from the spotted name on, and "Ember couldn't
    // tell it was a request…" starts with it. No tail of a line that ends a window may call Ember by name.
    const { v } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 20 });
    captured();
    const ends: string[] = [];
    for (const end of [{ reason: "timeout", doubt: true }, { reason: "timeout" }, { reason: "rejected" }, { reason: "cancel" }]) {
      v.listenOnce();
      const generation = (posted(proc, "listen-once").at(-1) as { generation?: number }).generation;
      proc.emit("message", { generation, type: "listening", on: true, reason: "manual", window: "manual" });
      proc.emit("message", { generation, type: "listening", on: false, window: "manual", ...end });
      ends.push(v.listenOnceStatus.detail, listenOnceInSettings(v.listenOnceStatus).detail);
    }
    expect(ends).toContain("I heard talking but couldn't tell it was a request. Wait a moment after pressing Listen once, then speak.");
    for (const line of ends) {
      const words = line.split(/\s+/);
      for (let i = 0; i < words.length; i++) expect(calledByName(words.slice(i).join(" ")), `${line} (from “${words[i]}”)`).toBe(false);
    }
  });

  it.each(["cancel", "stop", "mute", "lock", "device", "expiry"])("revokes manual verification on %s", async why => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { v, events } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 20 });
    const mic = captured();
    v.listenOnce();
    const stillCurrent = v.listenOnceStillCurrent();
    const generation = (posted(proc, "listen-once")[0] as { generation?: number }).generation;
    proc.emit("message", { generation, type: "listening", on: true, reason: "manual", window: "manual" });
    proc.emit("message", { generation, type: "listening", on: false, reason: "done", window: "manual" });
    expect(stillCurrent()).toBe(true);
    if (why === "cancel") v.cancelListenOnce();
    if (why === "stop") v.cancelListening();
    if (why === "mute") { v.setMuted(true); v.setMuted(false); }
    if (why === "lock") { v.setLocked(true); v.setLocked(false); }
    if (why === "device") electron.ipcMain.emit(VOICE.status, { sender: mic.webContents }, { state: "paused" });
    if (why === "expiry") vi.advanceTimersByTime(11_000);
    proc.emit("message", { generation, type: "utterance", window: "manual", text: "Late request.", ms: 0, verified: true });
    expect(events.some(e => e.type === "utterance")).toBe(false);
    expect(stillCurrent()).toBe(false);
    expect(v.listenOnceStatus.phase).not.toBe("checking");
  });

  it.each(["cancel", "stop", "speak", "none"])("handles %s after recognition while the Ask context is pending", async why => {
    const { v, events } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 20 });
    captured();
    expect(v.listenOnce()).toBe(true);
    const generation = (posted(proc, "listen-once")[0] as { generation?: number }).generation;
    const stillCurrent = v.listenOnceStillCurrent();
    const request = { type: "utterance", window: "manual", text: "One request.", ms: 0 } as const;
    proc.emit("message", { ...request, generation });
    expect(events).toContainEqual(request);
    expect(v.listenOnceStatus.phase).toBe("ready");

    let finishRead!: (context: string) => void;
    const pendingContext = new Promise<string>(resolve => { finishRead = resolve; });
    const submit = vi.fn();
    const dispatch = pendingContext.then(context => { if (stillCurrent()) submit(request.text, context); });
    // A competing turn, an approval prompt, and suspend cancel only the manual request.
    if (why === "cancel") v.cancelListenOnce();
    if (why === "stop") v.cancelListening();
    if (why === "speak") v.speak("A background task finished.");
    const context = "The desktop view before Ask opened";
    finishRead(context);
    await dispatch;
    if (why === "cancel" || why === "stop") expect(submit).not.toHaveBeenCalled();
    else expect(submit).toHaveBeenCalledExactlyOnceWith(request.text, context);
    expect(posted(proc, "cancel")).toHaveLength(why === "stop" ? 1 : 0);
  });

  it.each([[false, true, "1"], [false, false, null], [true, true, null]] as const)("sets raw WAV capture only for a synthetic mic in development (packaged %s, WAV %s)", async (packaged, testMicWav, value) => {
    electron.app.isPackaged = packaged;
    const { v } = service(true, { testMicWav });
    await v.setWanted(true);
    const mic = electron.windows.find(w => w.title === "Ember microphone")!;
    expect(new URL(mic.url).searchParams.get("testMicWav")).toBe(value);
  });

  it("says it can tell the user from the speakers only while the voice process hears the speakers' stream (review #252)", async () => {
    const { v } = service();
    expect(v.rejectsSpeakers).toBe(false);
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 900 });
    expect(v.rejectsSpeakers).toBe(false);
    proc.emit("message", { type: "monitor", on: true });
    expect(v.rejectsSpeakers).toBe(true);
    proc.emit("message", { type: "monitor", on: false, reason: "parec stopped (exit 1)" });
    expect(v.rejectsSpeakers).toBe(false);
    proc.emit("message", { type: "monitor", on: true });
    v.stop();
    expect(v.rejectsSpeakers).toBe(false);
  });

  it("opens the follow-up window only after Ember has finished speaking its answer", async () => {
    const { v } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    const mic = electron.windows.find(w => w.title === "Ember microphone")!;
    expect(posted(proc, "init")[0]).toMatchObject({ dev: true }); // development build: the audio dump may be used
    v.speak("Night Light is on.");
    v.followUp(8000);
    expect(posted(proc, "follow-up")).toEqual([]);
    speaking(mic, true);
    expect(posted(proc, "self-speaking")).toEqual([{ type: "self-speaking", on: true }]);
    expect(posted(proc, "follow-up")).toEqual([]);
    speaking(mic, false);
    expect(posted(proc, "follow-up")).toEqual([{ type: "follow-up", ms: 8000 }]);
  });

  it("tells the follow-up window that the answer asked something", async () => {
    const { v } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    v.followUp(8000, { afterQuestion: true });
    expect(posted(proc, "follow-up")).toEqual([{ type: "follow-up", ms: 8000, afterQuestion: true }]);
    v.followUp(8000);
    expect(posted(proc, "follow-up").at(-1)).toEqual({ type: "follow-up", ms: 8000 });
  });

  it("does not open an old answer's waiting follow-up after speech is interrupted (review turn ownership)", async () => {
    vi.useFakeTimers();
    const { v } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    const mic = electron.windows.find(w => w.title === "Ember microphone")!;
    v.speak("The old answer.");
    speaking(mic, true);
    v.followUp(8000, { afterQuestion: true });
    v.hush();
    speaking(mic, false);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(posted(proc, "follow-up")).toEqual([]);
    v.followUp(8000);
    expect(posted(proc, "follow-up")).toEqual([{ type: "follow-up", ms: 8000 }]);
  });

  it("ignores an old playback's delayed end before and after new playback starts (review turn ownership)", async () => {
    const { v } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    const mic = electron.windows.find(w => w.title === "Ember microphone")!;
    v.speak("Old answer.");
    speaking(mic, true);
    const oldGeneration = mic.webContents.send.mock.calls.filter(c => c[0] === VOICE.hush).at(-1)?.[1] ?? 0;
    v.hush();
    v.speak("New answer.");
    v.followUp(8000);
    electron.ipcMain.emit(VOICE.speaking, { sender: mic.webContents }, false, oldGeneration);
    expect(posted(proc, "follow-up")).toEqual([]);
    speaking(mic, false); // The current hush acknowledges quiet before new synthesis has started.
    expect(posted(proc, "follow-up")).toEqual([]);
    speaking(mic, true);
    electron.ipcMain.emit(VOICE.speaking, { sender: mic.webContents }, false, oldGeneration);
    expect(posted(proc, "follow-up")).toEqual([]);
    speaking(mic, false);
    expect(posted(proc, "follow-up")).toEqual([{ type: "follow-up", ms: 8000 }]);
  });

  it("times only the current hush acknowledged by the original speaking page", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const info = vi.fn();
    const { v } = service(true, { log: { ...log, info } });
    const measurements = () => info.mock.calls.filter(([message]) => message === "voice.hush_ack");
    v.speak("The speech-only window is still speaking.");
    await flush();
    const speaker = electron.windows.find(w => w.title === "Ember speech")!;
    speaking(speaker, true);
    await v.setWanted(true);
    const mic = electron.windows.find(w => w.title === "Ember microphone")!;

    v.hush();
    await flush();
    const firstHush = speaker.webContents.send.mock.calls.filter(([channel]) => channel === VOICE.hush).at(-1)?.[1];
    speaking(mic, false);
    expect(measurements()).toEqual([]);
    vi.advanceTimersByTime(12);
    v.hush();
    await flush();
    electron.ipcMain.emit(VOICE.speaking, { sender: speaker.webContents }, false, firstHush);
    speaking(mic, false);
    expect(measurements()).toEqual([]);

    vi.advanceTimersByTime(8);
    speaking(speaker, false);
    speaking(speaker, false);
    expect(measurements()).toEqual([["voice.hush_ack", { page: "speaker", ms: 20 }]]);
  });

  it("discards a lost playback page's hush and leaves idle hushes untimed", async () => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const info = vi.fn();
    const { v } = service(true, { log: { ...log, info } });
    const measurements = () => info.mock.calls.filter(([message]) => message === "voice.hush_ack");
    await v.setWanted(true);
    const oldMic = electron.windows.find(w => w.title === "Ember microphone")!;
    speaking(oldMic, true);
    v.hush();
    v.setMuted(true);
    speaking(oldMic, false);
    vi.advanceTimersByTime(500);
    v.setMuted(false);
    await flush();
    const mic = electron.windows.findLast(w => w.title === "Ember microphone")!;
    v.hush();
    speaking(mic, false);
    expect(measurements()).toEqual([]);

    speaking(mic, true);
    v.hush();
    vi.advanceTimersByTime(7);
    speaking(mic, false);
    expect(measurements()).toEqual([["voice.hush_ack", { page: "mic", ms: 7 }]]);
  });

  it("drops a pending hush measurement when the speech-only renderer crashes", async () => {
    const info = vi.fn();
    const { v } = service(true, { log: { ...log, info } });
    v.speak("A reply from the speech-only window.");
    await flush();
    const speaker = electron.windows.find(w => w.title === "Ember speech")!;
    speaking(speaker, true);
    v.hush();
    await flush();
    speaker.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    speaking(speaker, false);
    expect(info.mock.calls.filter(([message]) => message === "voice.hush_ack")).toEqual([]);
  });

  it("doesn't wait for speech that never starts (no voices installed)", async () => {
    vi.useFakeTimers();
    const { v } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    v.speak("Night Light is on.");
    v.followUp(8000);
    vi.advanceTimersByTime(2900);
    expect(posted(proc, "follow-up")).toEqual([]);
    vi.advanceTimersByTime(200);
    expect(posted(proc, "follow-up")).toEqual([{ type: "follow-up", ms: 8000 }]);
  });

  it("cancel (the kill switch) stops listening, drops a waiting follow-up and a request already on its way", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { v, events } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    const mic = electron.windows.find(w => w.title === "Ember microphone")!;
    v.speak("Done.");
    speaking(mic, true);
    v.followUp(8000);
    v.cancelListening();
    expect(posted(proc, "cancel")).toHaveLength(1);
    proc.emit("message", { generation: 0, type: "utterance", text: "Turn on night light.", ms: 120, window: "wake" });
    speaking(mic, false);
    expect(posted(proc, "follow-up")).toEqual([]);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1100);
    proc.emit("message", { generation: 0, type: "utterance", text: "Late cancelled request.", ms: 120, window: "wake", verified: true });
    proc.emit("message", { generation: 0, type: "wake", keyword: "hey ember" });
    expect(events).toEqual([]);
    proc.emit("message", { generation: 1, type: "utterance", text: "Make the text bigger.", ms: 120, window: "wake" });
    expect(events).toEqual([{ type: "utterance", text: "Make the text bigger.", ms: 120, window: "wake" }]);
  });

  it("does not resurrect a stopped verified request when inference finishes after the old grace period (SR-1)", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    const { v, events } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    let resolve!: (p: Float32Array) => void;
    const gate = new VoiceGate(() => ({ print: () => new Promise(r => { resolve = r; }) }),
      e => proc.emit("message", { ...e, generation: 0 }), () => undefined);
    gate.setOwner(Float32Array.of(1, 0));
    gate.event({ type: "utterance", text: "Open the calendar.", ms: 0, window: "wake" }, new Float32Array(16_000).fill(0.1));
    gate.event({ type: "stop" }, null);
    v.cancelListening();
    vi.advanceTimersByTime(1100);
    resolve(Float32Array.of(1, 0));
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(events).toEqual([{ type: "stop" }]);
  });

  it("revokes queued IPC and learning samples on identity changes but keeps adaptation in the same generation (SR-2)", async () => {
    const onSample = vi.fn();
    const { v, events } = service(true, { onSample });
    await v.setWanted(true);
    const [proc] = electron.procs;
    v.setVoiceprint(null);
    proc.emit("message", { generation: 0, type: "utterance", text: "Old owner.", ms: 0, window: "wake", verified: true });
    proc.emit("message", { generation: 0, type: "voice-sample", utterance: 1 });
    expect(events).toEqual([]);
    expect(onSample).not.toHaveBeenCalled();
    v.setVoiceprint(null, true);
    expect(posted(proc, "voiceprint").map(m => (m as { type: string; generation: number }).generation)).toEqual([1, 1]);
    proc.emit("message", { generation: 1, type: "utterance", text: "New request.", ms: 0, window: "wake" });
    expect(events).toHaveLength(1);
  });

  it("keeps duplicate enrolment idempotent so cancelling it still permits a fresh request", async () => {
    const { v, events } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 10 });
    expect(v.enrol()).toBe(true);
    expect(v.enrol()).toBe(true);
    expect(posted(proc, "enrol")).toEqual([{ type: "enrol", generation: 1 }]);
    v.cancelEnrol();
    proc.emit("message", { type: "utterance", text: "Fresh request.", ms: 0, window: "wake", generation: 1 });
    expect(events).toEqual([{ type: "utterance", text: "Fresh request.", ms: 0, window: "wake" }]);
  });

  it("tells the voice process a screen reader reads the prompts aloud as teaching starts, and says Listen once waits for it in a line screen readers aren't told (voice-listening-r4-1)", async () => {
    // "Finish teaching Ember your voice first." was said through the speakers as teaching began, into its microphone.
    let reader = true;
    const { v } = service(true, { screenReaderOn: () => reader });
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 10 });
    captured();
    expect(v.enrol()).toBe(true);
    expect(posted(proc, "enrol")).toEqual([{ type: "enrol", generation: 1, reader: true }]);
    expect(v.listenOnceStatus).toEqual({ phase: "blocked", detail: "Finish teaching Ember your voice first.", reason: "listening" });
    v.cancelEnrol();
    reader = false;
    expect(v.enrol()).toBe(true);
    expect(posted(proc, "enrol").at(-1)).toEqual({ type: "enrol", generation: 2 });
    v.cancelEnrol();
  });

  it("kills a voice process stopped before it had started, once it starts (Electron's kill() does nothing until then) (review #256)", async () => {
    const { v } = service();
    await v.setWanted(true);
    const [early] = electron.procs; // no pid yet: not spawned
    v.setMuted(true); // a mute double-press, within the spawn's latency
    expect(early.kill).toHaveBeenCalledTimes(1);
    early.emit("spawn");
    expect(early.kill).toHaveBeenCalledTimes(2);
    // One already running is killed once, as before.
    v.setMuted(false);
    await flush();
    const running = Object.assign(electron.procs[1], { pid: 4242 });
    v.setMuted(true);
    running.emit("spawn");
    expect(running.kill).toHaveBeenCalledTimes(1);
  });

  it("knows whether it can tell its own voice from the user's: listening, with the speakers' stream on (review #251)", async () => {
    const { v } = service();
    expect(v.rejectsSpeakers).toBe(false); // not listening
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 900 });
    expect(v.rejectsSpeakers).toBe(false); // no speakers' stream (Windows, macOS, Linux without parec)
    proc.emit("message", { type: "monitor", on: true });
    expect(v.rejectsSpeakers).toBe(true);
    proc.emit("message", { type: "monitor", on: false, reason: "parec stopped (exit 1)" });
    expect(v.rejectsSpeakers).toBe(false);
    proc.emit("message", { type: "monitor", on: true });
    v.setMuted(true);
    expect(v.rejectsSpeakers).toBe(false);
  });

  it("never says the wake or stop phrase while it listens without the speakers' stream (its own voice would trigger them) (review #251)", async () => {
    const { v } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    const mic = electron.windows.find(w => w.title === "Ember microphone")!;
    proc.emit("message", { type: "ready", loadMs: 900 });
    v.speak("Say 'Ember, stop' to cancel.");
    expect(mic.webContents.send).toHaveBeenLastCalledWith(VOICE.speak, { text: "Say the stop phrase to cancel." });
    proc.emit("message", { type: "monitor", on: true });
    v.speak("Say 'Ember, stop' to cancel.");
    expect(mic.webContents.send).toHaveBeenLastCalledWith(VOICE.speak, { text: "Say 'Ember, stop' to cancel." });
  });

  it("stops listening and speaking while the screen is locked, and listens again once it's unlocked (review #81)", async () => {
    const { v, states } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    const mic = electron.windows.find(w => w.title === "Ember microphone")!;
    proc.emit("message", { type: "ready", loadMs: 900 });
    v.setLocked(true);
    expect(mic.webContents.send).toHaveBeenCalledWith(VOICE.hush, expect.any(Number));
    expect(proc.kill).toHaveBeenCalled();
    expect(mic.destroyed).toBe(true);
    expect(states.at(-1)).toEqual({ s: "off", detail: "Not listening while the screen is locked." });
    v.setMuted(false); // nothing starts while it's locked
    await v.setWanted(true);
    await flush();
    expect(electron.procs).toHaveLength(1);
    v.setLocked(false);
    await flush();
    expect(electron.procs).toHaveLength(2);
    // Locked and unlocked while listening is off: nothing starts.
    await v.setWanted(false);
    v.setLocked(true);
    v.setLocked(false);
    await flush();
    expect(electron.procs).toHaveLength(2);
    expect(states.at(-1)?.s).toBe("off");
  });

  it("ignores a replaced voice process", async () => {
    const { v, states, events } = service();
    await v.setWanted(true);
    const [old] = electron.procs;
    v.setMuted(true);
    v.setMuted(false);
    await flush();
    expect(electron.procs).toHaveLength(2);
    const n = states.length;
    old.emit("message", { type: "listening", on: true, reason: "wake", window: "wake" });
    old.emit("message", { type: "error", message: "boom" });
    expect(states).toHaveLength(n);
    expect(events).toEqual([]);
  });

  it("says it's muted when listening is turned on while muted", async () => {
    const { v, states } = service();
    v.setMuted(true);
    await v.setWanted(true);
    expect(states.at(-1)).toEqual({ s: "muted", detail: undefined });
    expect(electron.procs).toHaveLength(0);
  });

  it("speaks replies with listening off, from a window that never opens the microphone", async () => {
    const { v } = service();
    v.speak("Hello.");
    await flush();
    const speech = electron.windows.find(w => w.title === "Ember speech")!;
    expect(speech.webContents.send).toHaveBeenCalledWith(VOICE.speak, { text: "Hello." });
    expect(speech.webContents.postMessage).not.toHaveBeenCalled(); // no audio port: no microphone
    expect(v.allowsMedia(speech.webContents as unknown as Electron.WebContents, ["audio"])).toBe(false);
    v.speak("Again.");
    await flush();
    expect(electron.windows).toHaveLength(1);
    v.hush();
    await flush();
    expect(speech.webContents.send).toHaveBeenCalledWith(VOICE.hush, expect.any(Number));
  });

  it("drops speech queued while the speech-only window still loads (the kill switch, voice audit V1)", async () => {
    const { v } = service();
    v.speak("A long answer.");
    v.hush(); // the window hasn't loaded yet
    await flush();
    const speech = electron.windows.find(w => w.title === "Ember speech")!;
    expect(speech.webContents.send.mock.calls.map(c => c[0])).toEqual([VOICE.hush]);
  });

  it("ends Ember's speaking when the page it spoke from goes: the meter stops and the wake word counts again (UI audit 4, voice audit V2)", async () => {
    const levels: unknown[] = [];
    const selfSpeaking: boolean[] = [];
    root = modelsRoot(true);
    const v = new VoiceService({ log, modelsRoot: root, monitor: false, onEvent: () => {}, onState: () => {}, native: false,
      onLevel: l => levels.push(l), onSelfSpeaking: on => selfSpeaking.push(on) } as VoiceOptions);
    services.push(v);
    await v.setWanted(true);
    const [proc] = electron.procs;
    const mic = electron.windows.find(w => w.title === "Ember microphone")!;
    proc.emit("message", { type: "ready", loadMs: 900 });
    speaking(mic, true);
    v.followUp(8000);
    expect(posted(proc, "follow-up")).toEqual([]);
    v.setMuted(true);
    expect(mic.destroyed).toBe(true);
    expect(levels).toContainEqual({ voice: null });
    expect(levels).toContainEqual({ mic: null });
    expect(selfSpeaking).toEqual([true, false]);
    expect(posted(proc, "self-speaking").at(-1)).toEqual({ type: "self-speaking", on: false });
    // The speech-only window too (listening off while it spoke, then locked).
    v.setMuted(false);
    await flush();
    await v.setWanted(false);
    v.speak("Hello.");
    await flush();
    const speech = electron.windows.filter(w => w.title === "Ember speech").at(-1)!;
    speaking(speech, true);
    levels.length = 0;
    v.setLocked(true);
    expect(levels).toContainEqual({ voice: null });
    expect(selfSpeaking.at(-1)).toBe(false);
  });

  it("dates Ember's next speech after its page went mid-speech, so its own words never answer a question (#127's echo guard)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const { v } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 900 });
    speaking(electron.windows.find(w => w.title === "Ember microphone")!, true);
    v.setMuted(true); // the mic page goes while Ember speaks
    v.setMuted(false);
    await vi.advanceTimersByTimeAsync(10);
    vi.setSystemTime(2_000_000);
    const heardFrom = Date.now();
    vi.setSystemTime(2_000_500);
    const mic = electron.windows.filter(w => w.title === "Ember microphone").at(-1)!;
    speaking(mic, true);
    speaking(mic, false);
    expect(v.selfSpokeSince(heardFrom)).toBe(true);
  });

  it("goes back from 'Downloading…' with the reason when the download fails, leaving nothing behind", async () => {
    const { v, states } = service(false);
    await v.setWanted(true);
    expect(states.at(-1)?.s).toBe("needs-models");
    electron.net.fetch.mockRejectedValue(new Error("net::ERR_PROXY_CONNECTION_FAILED"));
    await expect(v.downloadModels(() => undefined)).rejects.toThrow(/ERR_PROXY/);
    expect(states.map(s => s.s)).toContain("downloading");
    expect(states.at(-1)).toEqual({ s: "needs-models", detail: "Couldn't download the speech models. This computer can't reach the download site (github.com) right now. Check the network or proxy, then try again." });
    expect(v.micState).toBe("needs-models");
    expect(fs.readdirSync(root)).toEqual([]);
  });

  for (const how of ["Cancel", "listening off"] as const) {
    it(`stops the speech models' download on ${how}, back to needing them, saying it was cancelled (voice-listening-6)`, async () => {
      const { v, states } = service(false);
      await v.setWanted(true);
      let aborted = false;
      electron.net.fetch.mockImplementation((_url: string, init: { signal: AbortSignal }) => new Promise((_, reject) => init.signal.addEventListener("abort", () => { aborted = true; reject(new Error("aborted")); })));
      const done = v.downloadModels(() => undefined);
      const failed = expect(done).rejects.toThrow(/cancelled/);
      expect(v.isDownloading).toBe(true);
      if (how === "Cancel") v.cancelDownload(); else await v.setWanted(false);
      await failed;
      expect(aborted).toBe(true);
      expect(v.isDownloading).toBe(false);
      expect(states.at(-1)).toEqual(how === "Cancel" ? { s: "needs-models", detail: "Download cancelled." } : { s: "off", detail: "Download cancelled." });
      expect(modelsReady(root)).toBe(false);
      expect(fs.readdirSync(root).filter(f => f.startsWith(".download-"))).toEqual([]);
    });
  }

  it("gives up on a download that stalls", async () => {
    vi.useFakeTimers();
    const { v, states } = service(false);
    electron.net.fetch.mockImplementation((_url: string, init: { signal: AbortSignal }) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
    const done = v.downloadModels(() => undefined);
    const failed = expect(done).rejects.toThrow(/nothing arrived for 30 seconds/);
    await vi.advanceTimersByTimeAsync(30_000);
    await failed;
    expect(states.at(-1)?.s).toBe("off"); // listening wasn't on
    expect(modelsReady(root)).toBe(false);
  });
});

describe("VoiceService keeps listening going", () => {
  const micWindow = () => electron.windows.filter(w => w.title === "Ember microphone").at(-1)!;
  const micStatus = (status: object) => electron.ipcMain.emit(VOICE.status, { sender: micWindow().webContents }, status);

  it("starts again after the voice process stops: 1 s, 5 s, then every 30 s, saying so meanwhile", async () => {
    vi.useFakeTimers();
    const { v, states } = service();
    await v.setWanted(true);
    for (const [n, wait] of [[1, 1000], [2, 5000], [3, 30_000], [4, 30_000]]) {
      electron.procs[n - 1].emit("exit", 1);
      expect(states.at(-1)).toEqual({ s: "error", detail: `The voice process stopped. Trying again in ${wait / 1000} s…` });
      expect(micWindow().destroyed).toBe(true);
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(electron.procs).toHaveLength(n);
      await vi.advanceTimersByTimeAsync(1);
      expect(electron.procs).toHaveLength(n + 1);
    }
    electron.procs[4].emit("message", { type: "ready", loadMs: 900 });
    expect(states.at(-1)).toEqual({ s: "waiting", detail: undefined });
    // A minute of listening later (the process says it's alive every second), a new failure starts the backoff over.
    for (let i = 0; i < 61; i++) { await vi.advanceTimersByTimeAsync(1000); electron.procs[4].emit("message", { type: "alive" }); }
    electron.procs[4].emit("exit", 1);
    expect(states.at(-1)?.detail).toMatch(/Trying again in 1 s/);
  });

  it("starts again when the microphone page crashes", async () => {
    vi.useFakeTimers();
    const { v, states } = service();
    await v.setWanted(true);
    const mic = micWindow();
    mic.webContents.emit("render-process-gone", {}, { reason: "crashed" });
    expect(electron.procs[0].kill).toHaveBeenCalled();
    expect(states.at(-1)?.detail).toBe("The microphone page stopped. Trying again in 1 s…");
    await vi.advanceTimersByTimeAsync(1000);
    expect(electron.procs).toHaveLength(2);
    expect(micWindow()).not.toBe(mic);
  });

  it("starts again when no sound arrives, unless the mic page is getting the microphone back", async () => {
    vi.useFakeTimers();
    const { v, states } = service();
    await v.setWanted(true);
    electron.procs[0].emit("message", { type: "ready", loadMs: 900 });
    micStatus({ state: "lost", message: "The microphone was disconnected." });
    expect(states.at(-1)).toEqual({ s: "error", detail: "The microphone was disconnected. Trying again…" });
    electron.procs[0].emit("message", { type: "stalled", ms: 3100 });
    expect(electron.procs[0].kill).not.toHaveBeenCalled();
    micStatus({ state: "capturing", device: "USB Headset", rate: 16000, context: "running" });
    expect(states.at(-1)).toEqual({ s: "waiting", detail: undefined });
    electron.procs[0].emit("message", { type: "stalled", ms: 3100 });
    expect(electron.procs[0].kill).toHaveBeenCalled();
    expect(states.at(-1)?.detail).toBe("No sound is arriving from the microphone. Trying again in 1 s…");
    await vi.advanceTimersByTimeAsync(1000);
    expect(electron.procs).toHaveLength(2);
  });

  it("keeps the mic page while it waits for a microphone that isn't there yet (no headset, PulseAudio late at login)", async () => {
    vi.useFakeTimers();
    const { v, states } = service();
    await v.setWanted(true);
    electron.procs[0].emit("message", { type: "ready", loadMs: 900 });
    micStatus({ state: "lost", message: "NotFoundError: Requested device not found" });
    expect(states.at(-1)).toEqual({ s: "error", detail: "No microphone was found. Trying again…" });
    electron.procs[0].emit("message", { type: "stalled", ms: 10_100 }); // no frames, of course
    expect(electron.procs[0].kill).not.toHaveBeenCalled();
    expect(micWindow().destroyed).toBe(false);
    micStatus({ state: "capturing", device: "USB Headset", rate: 16000, context: "running" });
    expect(states.at(-1)).toEqual({ s: "waiting", detail: undefined });
  });

  it("doesn't start again once listening was turned off (or muted)", async () => {
    vi.useFakeTimers();
    const { v, states } = service();
    await v.setWanted(true);
    electron.procs[0].emit("exit", 1);
    await v.setWanted(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(electron.procs).toHaveLength(1);
    expect(states.at(-1)?.s).toBe("off");
    await v.setWanted(true); // on again: at once, not after the backoff
    expect(electron.procs).toHaveLength(2);
    electron.procs[1].emit("exit", 1);
    v.setMuted(true);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(electron.procs).toHaveLength(2);
    expect(states.at(-1)?.s).toBe("muted");
  });

  it("logs the recognizers' failures on some audio and keeps listening (review #253)", async () => {
    const { v, states, events } = service();
    const warn = vi.spyOn(log, "warn");
    try {
      await v.setWanted(true);
      electron.procs[0].emit("message", { type: "ready", loadMs: 900 });
      electron.procs[0].emit("message", { type: "engine-error", message: "the speech recognizer failed (92691224)", count: 1 });
      expect(warn).toHaveBeenCalledWith("voice.engine_error", { message: "the speech recognizer failed (92691224)", count: 1 });
      expect(events).toEqual([]);
      expect(states.at(-1)).toEqual({ s: "waiting", detail: undefined });
      expect(electron.procs[0].kill).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("starts the voice process again when its recognizers are broken (they kept failing), with the backoff (review #253)", async () => {
    vi.useFakeTimers();
    const { v, states } = service();
    await v.setWanted(true);
    electron.procs[0].emit("message", { type: "ready", loadMs: 900 });
    electron.procs[0].emit("message", { type: "engine-broken", message: "the speech recognizer failed (93407216)" });
    expect(electron.procs[0].kill).toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ s: "error", detail: "The speech recognizer kept failing. Trying again in 1 s…" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(electron.procs).toHaveLength(2);
    electron.procs[1].emit("message", { type: "ready", loadMs: 900 });
    electron.procs[1].emit("message", { type: "engine-broken", message: "the speech recognizer failed (93407216)" });
    expect(states.at(-1)).toEqual({ s: "error", detail: "The speech recognizer kept failing. Trying again in 5 s…" });
  });

  it("starts again when the voice process stops saying it's alive (frozen, or suspended by security software) (review #257)", async () => {
    vi.useFakeTimers();
    const { v, states } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 900 });
    // Alive every second: listening goes on.
    for (let i = 0; i < 60; i++) { await vi.advanceTimersByTimeAsync(1000); proc.emit("message", { type: "alive" }); }
    expect(proc.kill).not.toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ s: "waiting", detail: undefined });
    // Then nothing: after 15 s it's taken for stuck.
    await vi.advanceTimersByTimeAsync(14_000);
    expect(proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(proc.kill).toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ s: "error", detail: "The voice process stopped responding. Trying again in 1 s…" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(electron.procs).toHaveLength(2);
  });

  it("doesn't take its own sleep for a frozen voice process (the computer slept) (review #257)", async () => {
    vi.useFakeTimers();
    const { v } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 900 });
    await vi.advanceTimersByTimeAsync(1000);
    vi.setSystemTime(Date.now() + 120_000); // main's timers didn't run meanwhile either
    await vi.advanceTimersByTimeAsync(1000);
    proc.emit("message", { type: "alive" });
    await vi.advanceTimersByTimeAsync(5000);
    proc.emit("message", { type: "alive" });
    expect(proc.kill).not.toHaveBeenCalled();
  });

  it("says when the microphone sends only silence (muted, or the wrong input), and keeps listening for it to come back (review #255)", async () => {
    const { v, states } = service();
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 900 });
    proc.emit("message", { type: "silent", on: true });
    expect(states.at(-1)).toEqual({ s: "error", detail: "The microphone is sending only silence. Check that the right microphone is chosen, and not muted, in the sound settings." });
    expect(proc.kill).not.toHaveBeenCalled();
    proc.emit("message", { type: "silent", on: false });
    expect(states.at(-1)).toEqual({ s: "waiting", detail: undefined });
  });

  it("a model folder that won't load is forgotten, and the download is offered again (review #254)", async () => {
    vi.useFakeTimers();
    const { v, states } = service();
    await v.setWanted(true);
    expect(v.modelsReady).toBe(true);
    electron.procs[0].emit("message", { type: "error", message: "The speech models couldn't be loaded.", models: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(electron.procs).toHaveLength(1);
    expect(electron.procs[0].kill).toHaveBeenCalled();
    expect(states.at(-1)).toEqual({ s: "needs-models", detail: "The speech models look damaged. Download them again." });
    expect(v.modelsReady).toBe(false); // so settings shows the download button
    // Which one wasn't said: those listening loads are forgotten; Ember's voice and Voice Match stay.
    expect(markers(root)).toEqual([markerOf("tts"), markerOf("speaker")].sort());
    expect(v.missingModels.map(m => m.id)).toEqual(LISTENING);
  });

  it("forgets only the model that wouldn't load, so the download fetches just that one (review #254)", async () => {
    const { v, states } = service();
    await v.setWanted(true);
    electron.procs[0].emit("message", { type: "error", message: "The speech recognition model couldn't be loaded.", models: true, model: "asr" });
    expect(states.at(-1)).toEqual({ s: "needs-models", detail: "The speech models look damaged. Download them again." });
    expect(v.missingModels.map(m => m.id)).toEqual(["asr"]);
    expect(markers(root)).not.toContain(markerOf("asr"));
    expect(markers(root)).toHaveLength(VOICE_MODELS.length - 1);
  });

  it("takes just the damaged model from the user's folder when one that came with Ember won't load (review #254)", async () => {
    vi.useFakeTimers();
    const bundled = modelsRoot(true);
    root = modelsRoot(["kws"]); // the user's own copy of the wake word, downloaded earlier
    const v = new VoiceService({ log, modelsRoot: bundled, bundled: { userRoot: root }, monitor: false, onEvent: () => undefined, onState: () => undefined });
    services.push(v);
    try {
      await v.setWanted(true);
      electron.procs[0].emit("message", { type: "error", message: "The wake word model couldn't be loaded.", models: true, model: "kws" });
      await vi.advanceTimersByTimeAsync(0);
      expect(electron.procs).toHaveLength(2);
      const { models } = posted(electron.procs[1], "init")[0] as unknown as { models: Record<ModelId, string> };
      expect(models.kws.startsWith(root)).toBe(true);
      for (const id of ["vad", "asr", "tts", "speaker"] as ModelId[]) expect(models[id].startsWith(bundled)).toBe(true);
      expect(markers(bundled)).toHaveLength(VOICE_MODELS.length); // never changed
    } finally {
      fs.rmSync(bundled, { recursive: true, force: true });
    }
  });

  it("never changes models that came with Ember when they turn out damaged: the download goes to the user's own folder (review #254)", async () => {
    vi.useFakeTimers();
    const bundled = modelsRoot(true);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-voice-user-"));
    const userRoot = path.join(root, "models"); // not there yet, as before a first download
    const states: { s: MicState; detail?: string }[] = [];
    const v = new VoiceService({ log, modelsRoot: bundled, bundled: { userRoot }, monitor: false, onEvent: () => undefined, onState: (s, detail) => states.push({ s, detail }) });
    services.push(v);
    try {
      await v.setWanted(true);
      electron.procs[0].emit("message", { type: "error", message: "The speech models couldn't be loaded.", models: true });
      expect(fs.readdirSync(bundled).filter(f => f.endsWith(".ok"))).toHaveLength(VOICE_MODELS.length); // its markers stay
      expect(states.at(-1)).toEqual({ s: "needs-models", detail: "The speech models look damaged. Download them again." });
      expect(v.modelsReady).toBe(false); // so settings shows the download button
      electron.net.fetch.mockRejectedValue(new Error("net::ERR_INTERNET_DISCONNECTED"));
      await expect(v.downloadModels(() => undefined)).rejects.toThrow();
      expect(fs.existsSync(userRoot)).toBe(true); // the download went there, not into the app
      expect(fs.readdirSync(bundled).filter(f => !f.endsWith(".ok")).sort()).toEqual(VOICE_MODELS.map(m => m.target).sort());
    } finally {
      fs.rmSync(bundled, { recursive: true, force: true });
    }
  });

  it("uses models already in the user's own folder when the ones that came with Ember are damaged (review #254)", async () => {
    vi.useFakeTimers();
    const bundled = modelsRoot(true);
    root = modelsRoot(true); // downloaded earlier
    const states: { s: MicState; detail?: string }[] = [];
    const v = new VoiceService({ log, modelsRoot: bundled, bundled: { userRoot: root }, monitor: false, onEvent: () => undefined, onState: (s, detail) => states.push({ s, detail }) });
    services.push(v);
    try {
      await v.setWanted(true);
      electron.procs[0].emit("message", { type: "error", message: "The speech models couldn't be loaded.", models: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(electron.procs).toHaveLength(2);
      expect(posted(electron.procs[1], "init")[0]).toMatchObject({ models: { kws: expect.stringContaining(root) } });
      // Those fail too: they are the user's own, so they're forgotten.
      electron.procs[1].emit("message", { type: "error", message: "The speech models couldn't be loaded.", models: true });
      expect(states.at(-1)).toEqual({ s: "needs-models", detail: "The speech models look damaged. Download them again." });
      expect(modelsReady(root)).toBe(false);
      expect(modelsReady(bundled)).toBe(true);
    } finally {
      fs.rmSync(bundled, { recursive: true, force: true });
    }
  });

  it("a model that won't load is an error to show, not a restart loop", async () => {
    vi.useFakeTimers();
    const { v, states } = service();
    await v.setWanted(true);
    electron.procs[0].emit("message", { type: "error", message: "Invalid model file" });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(electron.procs).toHaveLength(1);
    expect(states.at(-1)).toEqual({ s: "error", detail: "Invalid model file" });
  });
});

describe("the echo check (scripts/voice/echo-check.mjs)", () => {
  it("counts the speech onsets main really logs, and deletes the room's recording when interrupted (voice audit V3)", () => {
    const read = (f: string) => fs.readFileSync(new URL(`../../${f}`, import.meta.url), "utf8");
    expect(read("app/main/main.ts")).toContain('log.info("voice.speech_heard", { on: e.on });');
    const check = read("scripts/voice/echo-check.mjs");
    expect(check).toContain('e.msg === "voice.speech_heard" && e.on === true');
    expect(check).toContain('process.once("SIGINT", onInterrupt);');
  });
});

describe("a failed download, in plain words", () => {
  it.each([
    ["net::ERR_CERT_AUTHORITY_INVALID", /can't verify the download site's certificate.*ask IT/],
    ["self signed certificate in certificate chain", /can't verify the download site's certificate/],
    ["net::ERR_PROXY_CONNECTION_FAILED", /can't reach the download site/],
    ["net::ERR_INTERNET_DISCONNECTED", /can't reach the download site/],
    ["nothing arrived for 30 seconds (check the network or proxy)", /can't reach the download site/],
    ["download failed: HTTP 503", /can't reach the download site/],
    ["download failed: HTTP 407", /proxy asked for a sign-in/],
    ["download failed: HTTP 403", /refused the request/],
    ["ENOSPC: no space left on device, write", /enough free disk space for the speech models \(about \d+ MB\)/],
    ["Command failed: tar -xjf x.tar.bz2\ntar: Cannot write: No space left on device", /enough free disk space/],
    ["EACCES: permission denied, open '/x'", /permission denied/],
    ["Moonshine: checksum mismatch (got 0123456789ab…). The download was not used.", /arrived damaged or changed/],
  ])("%s", async (raw, plain) => {
    const { downloadHelp } = await import("../../app/main/voice");
    expect(downloadHelp(raw)).toMatch(plain);
    expect(downloadHelp(raw)).not.toMatch(/net::|ERR_|ENOSPC|EACCES/);
  });
});

describe("the speech-only window", () => {
  const speechWindow = () => electron.windows.find(w => w.title === "Ember speech")!;

  it("goes when listening starts (the mic window speaks from then on)", async () => {
    const { v } = service();
    v.speak("Night Light is on.");
    await flush();
    await v.setWanted(true);
    expect(speechWindow().destroyed).toBe(true);
  });

  it("finishes what it's saying first", async () => {
    const { v } = service();
    v.speak("Here is a long answer.");
    await flush();
    speaking(speechWindow(), true);
    await v.setWanted(true);
    expect(speechWindow().destroyed).toBe(false);
    speaking(speechWindow(), false);
    expect(speechWindow().destroyed).toBe(true);
  });

  it("closes once it has said nothing for a minute with listening off, and comes back for the next reply", async () => {
    vi.useFakeTimers();
    const { v } = service();
    v.speak("Night Light is on.");
    const first = speechWindow();
    await Promise.resolve(); // A real page receives its generation before it can report playback.
    speaking(first, true);
    vi.advanceTimersByTime(90_000);
    expect(first.destroyed).toBe(false); // still speaking
    speaking(first, false);
    vi.advanceTimersByTime(59_000);
    expect(first.destroyed).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(first.destroyed).toBe(true);
    v.speak("Dark mode is on.");
    const next = electron.windows.filter(w => w.title === "Ember speech").at(-1)!;
    expect(next).not.toBe(first);
    expect(next.destroyed).toBe(false);
  });

  it("stays while a reply is still being sent to it", async () => {
    vi.useFakeTimers();
    const { v } = service();
    v.speak("A long answer.");
    vi.advanceTimersByTime(50_000);
    v.speak("Its next sentence.", { append: true });
    vi.advanceTimersByTime(50_000);
    expect(speechWindow().destroyed).toBe(false);
  });
});

describe("speech models", () => {
  it("aren't ready when a marker was written for another pin", () => {
    const dir = modelsRoot(true);
    try {
      expect(modelsReady(dir)).toBe(true);
      fs.writeFileSync(path.join(dir, `.${VOICE_MODELS[0].target}.ok`), "0".repeat(64) + "\n");
      expect(modelsReady(dir)).toBe(false);
      fs.writeFileSync(path.join(dir, `.${VOICE_MODELS[0].target}.ok`), "");
      expect(modelsReady(dir)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("Ember's own voice", () => {
    const audio = (id: number, remaining = "") => ({ type: "audio", id, samples: new Float32Array(4), rate: 22_050, remaining });

    it("drops already queued and late old-account synthesis after erasure hush, including after new playback starts", async () => {
      const { v } = service(true, { neuralVoice: true });
      v.speak("An old account’s queued answer.");
      await flush();
      const tts = electron.procs[0];
      const speaker = electron.windows.find(w => w.title === "Ember speech")!;
      tts.emit("message", { type: "ready", loadMs: 900, rate: 22_050 });
      tts.emit("message", audio(1));
      await flush();
      expect(speaker.webContents.send).toHaveBeenCalledWith(VOICE.audio, expect.objectContaining({ id: 1 }));
      v.hush(); // Main's sign-out/account-erasure reset owns this cancellation.
      await flush();
      expect(speaker.webContents.send).toHaveBeenCalledWith(VOICE.hush, expect.any(Number));
      speaker.webContents.send.mockClear();
      tts.emit("message", audio(1));
      tts.emit("message", { type: "done", id: 1 });
      await flush();
      expect(speaker.webContents.send).not.toHaveBeenCalledWith(VOICE.audio, expect.anything());
      v.speak("The new account’s answer.");
      tts.emit("message", audio(1));
      tts.emit("message", audio(2));
      await flush();
      const played = speaker.webContents.send.mock.calls.filter(([channel]) => channel === VOICE.audio);
      expect(played).toHaveLength(1);
      expect(played[0][1]).toMatchObject({ id: 2 });
    });

    it("keeps follow-up listening closed between appended neural replies (review same-generation speech gap)", async () => {
      vi.useFakeTimers();
      const { v } = service(true, { neuralVoice: true });
      await v.setWanted(true);
      const [proc] = electron.procs;
      const mic = electron.windows.find(w => w.title === "Ember microphone")!;
      v.speak("First sentence.");
      const tts = electron.procs[1];
      tts.emit("message", { type: "ready", loadMs: 900, rate: 22_050 });
      tts.emit("message", audio(1));
      tts.emit("message", { type: "done", id: 1 });
      speaking(mic, true);
      v.speak("Second sentence.", { append: true });
      v.followUp(8000);
      speaking(mic, false);
      await vi.advanceTimersByTimeAsync(4000); // Longer than the old start grace, while synthesis still owns the reply.
      expect(posted(proc, "follow-up")).toEqual([]);
      tts.emit("message", audio(2));
      tts.emit("message", { type: "done", id: 2 });
      expect(posted(proc, "follow-up")).toEqual([]);
      speaking(mic, true);
      speaking(mic, false);
      expect(posted(proc, "follow-up")).toEqual([{ type: "follow-up", ms: 8000 }]);
    });

    it.each(["before", "after"])("releases a waiting follow-up when appended synthesis fails %s playback drains and no fallback voice starts (review same-generation speech gap)", async when => {
      vi.useFakeTimers();
      const { v } = service(true, { neuralVoice: true });
      await v.setWanted(true);
      const [proc] = electron.procs;
      const mic = electron.windows.find(w => w.title === "Ember microphone")!;
      v.speak("First sentence.");
      const tts = electron.procs[1];
      tts.emit("message", { type: "ready", loadMs: 900, rate: 22_050 });
      tts.emit("message", audio(1));
      tts.emit("message", { type: "done", id: 1 });
      speaking(mic, true);
      v.speak("Second sentence.", { append: true });
      v.followUp(8000);
      if (when === "before") {
        tts.emit("message", { type: "failed", id: 2, message: "failed" });
        speaking(mic, true); // The old playback's heartbeat cannot stand for the fallback starting.
      }
      speaking(mic, false);
      expect(posted(proc, "follow-up")).toEqual([]);
      if (when === "after") tts.emit("message", { type: "failed", id: 2, message: "failed" });
      await vi.advanceTimersByTimeAsync(3001);
      expect(posted(proc, "follow-up")).toEqual([{ type: "follow-up", ms: 8000 }]);
      expect(mic.webContents.send).toHaveBeenCalledWith(VOICE.speak, { text: "Second sentence.", append: true });
    });

    it("says replies in it once its model is in: numbered, chunk by chunk, to the page that plays them", async () => {
      const { v } = service(true, { neuralVoice: true });
      v.speak("Night Light is on.");
      await flush();
      const [tts] = electron.procs;
      expect(posted(tts, "init")).toHaveLength(1);
      expect(posted(tts, "say")).toEqual([{ type: "say", id: 1, text: "Night Light is on." }]);
      const speech = electron.windows.find(w => w.title === "Ember speech")!;
      expect(speech.webContents.send).not.toHaveBeenCalledWith(VOICE.speak, expect.anything());
      tts.emit("message", { type: "ready", loadMs: 900, rate: 22_050 });
      tts.emit("message", audio(1));
      tts.emit("message", { type: "done", id: 1 });
      await flush();
      expect(speech.webContents.send).toHaveBeenCalledWith(VOICE.audio, expect.objectContaining({ id: 1, rate: 22_050 }));
      expect(speech.webContents.send).toHaveBeenCalledWith(VOICE.audioDone, 1);
    });

    it("releases an idle voice, then loads it again without counting the release as a failure", async () => {
      vi.useFakeTimers();
      const { v } = service(true, { neuralVoice: true });
      v.warmVoice();
      const [first] = electron.procs;
      first.emit("message", { type: "ready", loadMs: 900, rate: 22_050 });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(first.kill).toHaveBeenCalledOnce();
      first.emit("exit", 0);
      first.emit("message", audio(1));
      v.speak("Hello again.");
      expect(electron.procs).toHaveLength(2);
      expect(posted(electron.procs[1], "say")).toEqual([{ type: "say", id: 1, text: "Hello again." }]);
    });

    it("retains queued synthesis past the idle interval, resetting it after each streamed sentence and wake", async () => {
      vi.useFakeTimers();
      const { v } = service(true, { neuralVoice: true });
      v.speak("First sentence.");
      const [tts] = electron.procs;
      tts.emit("message", { type: "ready", loadMs: 900, rate: 22_050 });
      await vi.advanceTimersByTimeAsync(120_001);
      expect(tts.kill).not.toHaveBeenCalled();
      tts.emit("message", { type: "done", id: 1 });
      await vi.advanceTimersByTimeAsync(119_000);
      v.speak("Next sentence.", { append: true });
      await vi.advanceTimersByTimeAsync(2000);
      expect(tts.kill).not.toHaveBeenCalled();
      tts.emit("message", { type: "done", id: 2 });
      await vi.advanceTimersByTimeAsync(119_000);
      v.warmVoice();
      await vi.advanceTimersByTimeAsync(119_000);
      expect(tts.kill).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(tts.kill).toHaveBeenCalledOnce();
    });

    it("releases a cancelled synthesis after the idle interval, ignoring late audio", async () => {
      vi.useFakeTimers();
      const { v } = service(true, { neuralVoice: true });
      v.speak("Cancelled reply.");
      const [tts] = electron.procs;
      tts.emit("message", { type: "ready", loadMs: 900, rate: 22_050 });
      v.hush();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(tts.kill).toHaveBeenCalledOnce();
      tts.emit("message", audio(1));
      expect(electron.windows[0].webContents.send.mock.calls.filter(c => c[0] === VOICE.audio)).toEqual([]);
    });

    it("says replies at the speaking speed chosen, in Ember's voice and the system's, and names the voice next to speak (voice-speaking-7)", async () => {
      const { v } = service(true, { neuralVoice: true });
      expect(v.nextVoice).toBe("kitten");
      v.speak("As made.");
      v.setRate(1.15);
      v.speak("A little faster.");
      expect(posted(electron.procs[0], "say")).toEqual([{ type: "say", id: 1, text: "As made." }, { type: "say", id: 2, text: "A little faster.", speed: 1.15 }]);
      v.speak("Это быстрее.");
      await flush();
      const speech = electron.windows.find(w => w.title === "Ember speech")!;
      expect(speech.webContents.send).toHaveBeenCalledWith(VOICE.speak, { text: "Это быстрее.", lang: "ru", rate: 1.15 });
      const system = service(true, { neuralVoice: false });
      expect(system.v.nextVoice).toBe("system");
    });

    it("says a reply in another language with the system's voice for it, never in Kitten, which reads only English (voice-speaking-11)", async () => {
      const { v } = service(true, { neuralVoice: true });
      v.speak("我已经打开了设置。");
      await flush();
      expect(electron.procs).toHaveLength(0);
      const speech = electron.windows.find(w => w.title === "Ember speech")!;
      expect(speech.webContents.send).toHaveBeenCalledWith(VOICE.speak, { text: "我已经打开了设置。", lang: "zh" });
      v.speak("Night Light is on.");
      expect(posted(electron.procs[0], "say")).toEqual([{ type: "say", id: 1, text: "Night Light is on." }]);
    });

    it("says each piece of an answer in the answer's language, never judging one piece on its own (voice-speaking-r1)", async () => {
      const { v } = service(true, { neuralVoice: true });
      v.speak("Here are three films you might like:", { lang: null });
      v.speak("1. La La Land.", { append: true, lang: null });
      await flush();
      expect(posted(electron.procs[0], "say").map(m => (m as { text?: string }).text)).toEqual(["Here are three films you might like:", "1. La La Land."]);
      const speech = electron.windows.find(w => w.title === "Ember speech")!;
      expect(speech.webContents.send).not.toHaveBeenCalledWith(VOICE.speak, expect.anything());
      // Speech that isn't an answer's is still judged whole.
      v.speak("Playing La Vie en Rose.");
      expect(posted(electron.procs[0], "say").at(-1)).toEqual(expect.objectContaining({ text: "Playing La Vie en Rose." }));
    });

    it("says another language's words only after the pieces Ember's own voice is still making, never ahead of them (voice-speaking-r1)", async () => {
      const { v } = service(true, { neuralVoice: true });
      v.speak("Claro.", { lang: null });
      await flush();
      const speech = electron.windows.find(w => w.title === "Ember speech")!;
      v.speak("Aquí tienes los archivos que pediste.", { append: true, lang: "es" });
      await flush();
      expect(speech.webContents.send).not.toHaveBeenCalledWith(VOICE.speak, expect.anything());
      electron.procs[0].emit("message", { type: "ready", loadMs: 900, rate: 22_050 });
      electron.procs[0].emit("message", { type: "audio", id: 1, samples: new Float32Array(4), rate: 22_050, remaining: "" });
      await flush();
      expect(speech.webContents.send).not.toHaveBeenCalledWith(VOICE.speak, expect.anything());
      electron.procs[0].emit("message", { type: "done", id: 1 });
      await flush();
      const sent = speech.webContents.send.mock.calls.map(c => c[0]);
      expect(sent.lastIndexOf(VOICE.audioDone)).toBeLessThan(sent.lastIndexOf(VOICE.speak));
      expect(speech.webContents.send).toHaveBeenLastCalledWith(VOICE.speak, { text: "Aquí tienes los archivos que pediste.", append: true, lang: "es" });
      // A hush drops what was waiting.
      v.speak("Vale.", { lang: null });
      v.speak("Hasta luego, y gracias por todo.", { append: true, lang: "es" });
      v.hush();
      electron.procs[0].emit("message", { type: "done", id: 2 });
      await flush();
      expect(speech.webContents.send).not.toHaveBeenCalledWith(VOICE.speak, expect.objectContaining({ text: "Hasta luego, y gracias por todo." }));
    });

    it("loads the voice and its speak-only page when a request is likely, once, and lets them go when idle (voice-speaking-1)", async () => {
      vi.useFakeTimers();
      const { v } = service(true, { neuralVoice: true });
      v.warmSpeech();
      v.warmSpeech();
      expect(electron.procs).toHaveLength(1);
      expect(posted(electron.procs[0], "init")).toHaveLength(1);
      expect(electron.windows.filter(w => w.title === "Ember speech")).toHaveLength(1);
      electron.procs[0].emit("message", { type: "ready", loadMs: 900, rate: 22_050 });
      // The reply then starts in the voice already loaded.
      v.speak("Night Light is on.");
      expect(electron.procs).toHaveLength(1);
      expect(posted(electron.procs[0], "say")).toEqual([{ type: "say", id: 1, text: "Night Light is on." }]);
      electron.procs[0].emit("message", { type: "done", id: 1 });
      await vi.advanceTimersByTimeAsync(120_000);
      expect(electron.procs[0].kill).toHaveBeenCalledOnce();
    });

    it("loads nothing while the screen is locked, and only the page where Ember's own voice isn't in (voice-speaking-1)", () => {
      const locked = service(true, { neuralVoice: true });
      locked.v.setLocked(true);
      locked.v.warmSpeech();
      expect(electron.procs).toHaveLength(0);
      expect(electron.windows.filter(w => w.title === "Ember speech")).toHaveLength(0);
      const system = service(true, { neuralVoice: false });
      system.v.warmSpeech();
      expect(electron.procs).toHaveLength(0);
      expect(electron.windows.filter(w => w.title === "Ember speech")).toHaveLength(1);
    });

    it("stops an unspawned speech process once it starts, with no idle timer left behind", async () => {
      vi.useFakeTimers();
      const { v } = service(true, { neuralVoice: true });
      v.warmVoice();
      const [tts] = electron.procs;
      v.stop();
      expect(tts.kill).toHaveBeenCalledOnce();
      tts.emit("spawn");
      expect(tts.kill).toHaveBeenCalledTimes(2);
      tts.emit("message", { type: "ready", loadMs: 900, rate: 22_050 });
      await vi.advanceTimersByTimeAsync(240_000);
      expect(tts.kill).toHaveBeenCalledTimes(2);
      expect(electron.procs).toHaveLength(1);
    });

    it("drops what was on its way once hushed, and a new reply cuts the old one off (the next sentence of one doesn't)", async () => {
      const { v } = service(true, { neuralVoice: true });
      v.speak("A long answer.");
      const [tts] = electron.procs;
      v.speak("Its next sentence.", { append: true });
      expect(posted(tts, "hush")).toEqual([]);
      v.speak("A new answer.");
      expect(posted(tts, "hush")).toEqual([{ type: "hush", id: 2 }]);
      tts.emit("message", audio(1));
      tts.emit("message", audio(3));
      await flush();
      const speech = electron.windows.find(w => w.title === "Ember speech")!;
      const sent = speech.webContents.send.mock.calls.filter(c => c[0] === VOICE.audio).map(c => (c[1] as { id: number }).id);
      expect(sent).toEqual([3]);
    });

    it("hushes delivered audio and retires queued completion callbacks (voice audit V1)", async () => {
      const { v } = service(true, { neuralVoice: true });
      v.speak("A long answer.");
      const [tts] = electron.procs;
      tts.emit("message", audio(1));
      await flush();
      v.hush();
      await flush();
      const speech = electron.windows.find(w => w.title === "Ember speech")!;
      expect(speech.webContents.send.mock.calls.map(c => c[0])).toEqual([VOICE.hush, VOICE.audio, VOICE.hush]);
    });

    it("lets the system's voice say what it hadn't, when it can't load, and from then on", async () => {
      const { v } = service(true, { neuralVoice: true });
      v.speak("Hello.");
      const [tts] = electron.procs;
      tts.emit("message", { type: "error", message: "Ember's voice couldn't be loaded." });
      await flush();
      const speech = electron.windows.find(w => w.title === "Ember speech")!;
      expect(speech.webContents.send).toHaveBeenCalledWith(VOICE.speak, { text: "Hello.", append: true });
      v.speak("Again.");
      await flush();
      expect(speech.webContents.send).toHaveBeenLastCalledWith(VOICE.speak, { text: "Again." });
      expect(electron.procs).toHaveLength(1);
    });

    it.each(["failed", "exit"])("recovers the ungenerated suffix and queued reply after %s, without replaying PCM", async failure => {
      const { v } = service(true, { neuralVoice: true });
      v.speak("The first sentence. The second sentence.");
      v.speak("Another reply.", { append: true });
      const [tts] = electron.procs;
      tts.emit("message", { type: "ready", loadMs: 900, rate: 22_050 });
      tts.emit("message", audio(1, "The second sentence."));
      if (failure === "exit") tts.emit("exit", 1);
      else tts.emit("message", { type: "failed", id: 1, message: "failed" });
      // A retired process must not reintroduce audio, even if a queued event arrives late.
      tts.emit("message", audio(2));
      v.speak("A later sentence.", { append: true });
      await flush();
      const sent = electron.windows[0].webContents.send.mock.calls;
      expect(sent.filter(c => c[0] === VOICE.audio)).toHaveLength(1);
      expect(sent.filter(c => c[0] === VOICE.speak).map(c => c[1])).toEqual([
        { text: "The second sentence.", append: true },
        { text: "Another reply.", append: true },
        { text: "A later sentence.", append: true },
      ]);
      expect(sent.filter(c => c[0] === VOICE.audioDone).map(c => c[1])).toEqual([1, 2]);
      expect(electron.procs).toHaveLength(1);
    });

    it("recovers a pre-audio synthesis failure instead of silently dropping the reply", async () => {
      const { v } = service(true, { neuralVoice: true });
      v.speak("Hello.");
      electron.procs[0].emit("message", { type: "failed", id: 1, message: "failed" });
      await flush();
      expect(electron.windows[0].webContents.send).toHaveBeenCalledWith(VOICE.speak, { text: "Hello.", append: true });
    });

    it("does not recover a cancelled or replaced reply on late failure", async () => {
      const { v } = service(true, { neuralVoice: true });
      v.speak("Old reply.");
      const [tts] = electron.procs;
      v.hush();
      v.speak("New reply.");
      tts.emit("message", { type: "failed", id: 1, message: "failed" });
      tts.emit("message", audio(2));
      tts.emit("message", { type: "done", id: 2 });
      await flush();
      expect(electron.windows[0].webContents.send.mock.calls.filter(c => c[0] === VOICE.speak)).toEqual([]);
      expect(tts.kill).not.toHaveBeenCalled();
    });

    it("uses the system's voice while its model isn't there", async () => {
      const { v } = service(false, { neuralVoice: true });
      v.speak("Hello.");
      await flush();
      expect(electron.procs).toHaveLength(0);
      const speech = electron.windows.find(w => w.title === "Ember speech")!;
      expect(speech.webContents.send).toHaveBeenCalledWith(VOICE.speak, { text: "Hello." });
    });
  });

  describe("Voice Match", () => {
    it("starts the voice process with the owner's voiceprint, passes enrolment through, and switches the voiceprint", async () => {
      const progress: unknown[] = [];
      const { v } = service(true, { voiceprint: () => "PRINT", onEnrol: e => progress.push(e) });
      expect(v.enrol()).toBe(false); // not listening yet: nothing to learn the voice through
      await v.setWanted(true);
      const [proc] = electron.procs;
      expect(posted(proc, "init")[0]).toMatchObject({ voiceprint: "PRINT" });
      expect(v.enrol()).toBe(false); // not ready yet
      proc.emit("message", { type: "ready", loadMs: 900 });
      expect(v.enrol()).toBe(true);
      expect(posted(proc, "enrol")).toEqual([{ type: "enrol", generation: 1 }]);
      proc.emit("message", { type: "enrol", state: "heard", got: 1, of: 4 });
      expect(progress).toEqual([{ type: "enrol", state: "heard", got: 1, of: 4 }]);
      v.cancelEnrol();
      expect(posted(proc, "enrol-cancel")).toHaveLength(1);
      v.setVoiceprint(null);
      expect(posted(proc, "voiceprint")).toMatchObject([{ type: "voiceprint", print: null, refresh: false, generation: expect.any(Number) }]);
    });

    /** Listening, ready, and teaching under way with a phrase heard. */
    async function teaching() {
      const progress: { type: string; state: string; got: number; of: number; why?: string }[] = [];
      const made = service(true, { voiceprint: () => null, onEnrol: e => progress.push(e as (typeof progress)[number]) });
      await made.v.setWanted(true);
      const proc = electron.procs.at(-1)!;
      proc.emit("message", { type: "ready", loadMs: 10 });
      expect(made.v.enrol()).toBe(true);
      proc.emit("message", { type: "enrol", state: "heard", got: 1, of: 4 });
      return { ...made, proc, progress };
    }

    for (const how of ["mute", "lock", "listening off", "exit", "Hear me more clearly"] as const) {
      it(`tells settings the teaching ended when Ember stops listening (${how}), so it doesn't go on asking for phrases (voice-listening-2)`, async () => {
        const { v, proc, progress } = await teaching();
        if (how === "mute") v.setMuted(true);
        else if (how === "lock") v.setLocked(true);
        else if (how === "listening off") await v.setWanted(false);
        else if (how === "exit") proc.emit("exit", 1);
        else { (v as unknown as { clearLoaded: boolean }).clearLoaded = true; v.setClearHearing(true); v.setClearHearing(false); }
        expect(progress.at(-1)).toEqual({ type: "enrol", state: "cancelled", got: 1, of: 4, why: "interrupted" });
        expect(progress.filter(p => p.state === "cancelled")).toHaveLength(1);
        expect(v.isEnrolling).toBe(false);
        expect(v.listenOnceStatus.detail).not.toBe("Finish teaching Ember your voice first.");
      });
    }

    it("stops the teaching with everything else when the kill switch stops listening (voice-listening-v1)", async () => {
      const { v, proc } = await teaching();
      v.cancelListening();
      expect(posted(proc, "enrol-cancel")).toEqual([{ type: "enrol-cancel", why: "stopped" }]);
      expect(v.isEnrolling).toBe(false);
    });

    it("says on the voice line that only “Ember, stop” is heard while it learns a voice, and stops saying so after (voice-listening-v1)", async () => {
      const { v, proc, states } = await teaching();
      expect(states.at(-1)).toEqual({ s: "waiting", detail: "Learning your voice. Until that's done, Ember hears only “Ember, stop”." });
      expect(v.isEnrolling).toBe(true);
      proc.emit("message", { type: "enrol", state: "cancelled", got: 1, of: 4, why: "timeout" });
      expect(states.at(-1)).toEqual({ s: "waiting", detail: undefined });
      expect(v.isEnrolling).toBe(false);
    });

    it("says so too when teaching starts while a conversation is listening, and the window it ends says it stopped (voice-listening-r2)", async () => {
      const { v, states } = service(true, { voiceprint: () => null });
      await v.setWanted(true);
      const proc = electron.procs.at(-1)!;
      proc.emit("message", { type: "ready", loadMs: 10 });
      proc.emit("message", { type: "listening", on: true, reason: "conversation", window: "conversation", generation: 0 });
      expect(states.at(-1)).toMatchObject({ s: "active" });
      expect(v.enrol()).toBe(true);
      expect(states.at(-1)).toEqual({ s: "waiting", detail: "Learning your voice. Until that's done, Ember hears only “Ember, stop”." });
      // The voice process ends that window at once (engine.cancel()), and says so.
      const { generation } = posted(proc, "enrol")[0] as { type: string; generation?: number };
      proc.emit("message", { type: "listening", on: false, reason: "stop", window: "conversation", generation });
      expect(states.at(-1)).toEqual({ s: "waiting", detail: "Learning your voice. Until that's done, Ember hears only “Ember, stop”." });
    });
  });

  describe("the native build (Windows and macOS)", () => {
    /** A logger that keeps what it was told. */
    const recording = () => {
      const lines: { level: string; event: string; data?: Record<string, unknown> }[] = [];
      const rec = (level: string) => (event: string, data?: Record<string, unknown>) => { lines.push({ level, event, data }); };
      const l = { debug: rec("debug"), info: rec("info"), warn: rec("warn"), error: rec("error"), child: () => l, file: "" } as unknown as Logger;
      return { log: l, lines };
    };
    const kitten = (over: Record<string, unknown> = {}) => ({ voice: "kitten", backend: "native", detail: "sherpa-onnx 1.13.8", provider: "cpu", threads: 2, tried: [{ provider: "cpu" }], rtf: 0.05, ...over });

    it("logs which build and provider the voice process runs on", async () => {
      const { log: l, lines } = recording();
      const { v } = service(true, { native: true, log: l });
      await v.setWanted(true);
      const backend = { backend: "native", detail: "sherpa-onnx 1.13.8 (11afbd00), onnxruntime 1.28.2", provider: "coreml", threads: 2, tried: [{ provider: "coreml", ms: 31 }, { provider: "cpu", ms: 48 }] };
      electron.procs[0].emit("message", { type: "ready", loadMs: 900, backend });
      expect(lines.find(x => x.event === "voice.ready")?.data).toEqual({ loadMs: 900, ...backend });
      expect(lines.some(x => x.event === "voice.model_wasm_fallback")).toBe(false);
    });

    it("warns when a model the native build couldn't make runs on WebAssembly (PR #130 review)", async () => {
      const { log: l, lines } = recording();
      const { v } = service(true, { native: true, log: l });
      await v.setWanted(true);
      const backend = { backend: "native", detail: "sherpa-onnx 1.13.8 (C API); on WebAssembly: wake word model", provider: "cpu", threads: 2, tried: [{ provider: "cpu" }], wasmModels: ["wake word model"] };
      electron.procs[0].emit("message", { type: "ready", loadMs: 900, backend });
      expect(lines.find(x => x.event === "voice.model_wasm_fallback")).toMatchObject({ level: "warn", data: { models: ["wake word model"] } });
    });

    it("starts a voice process that died loading natively again at once on WebAssembly, and only once", async () => {
      const { log: l, lines } = recording();
      const { v, states } = service(true, { native: true, log: l });
      await v.setWanted(true);
      expect(posted(electron.procs[0], "init")[0]).not.toHaveProperty("wasm");
      electron.procs[0].emit("exit", 134);
      await flush();
      expect(electron.procs).toHaveLength(2);
      expect(posted(electron.procs[1], "init")[0]).toMatchObject({ wasm: true });
      expect(lines.some(x => x.event === "voice.native_failed")).toBe(true);
      expect(states.map(x => x.s)).not.toContain("error");
      // WebAssembly dying too is an ordinary failure: the backoff, saying so.
      electron.procs[1].emit("exit", 1);
      expect(states.at(-1)).toMatchObject({ s: "error", detail: expect.stringMatching(/^The voice process stopped\. Trying again in 1 s/) });
    });

    it("keeps a voice process that died after it was ready on the native build (the backoff starts it again)", async () => {
      vi.useFakeTimers();
      const { v } = service(true, { native: true });
      await v.setWanted(true);
      electron.procs[0].emit("message", { type: "ready", loadMs: 900 });
      electron.procs[0].emit("exit", 1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(posted(electron.procs[1], "init")[0]).not.toHaveProperty("wasm");
    });

    it("doesn't try WebAssembly first where there is no native build (Linux): a voice process that dies is just restarted", async () => {
      const { v } = service(true, { native: false });
      await v.setWanted(true);
      electron.procs[0].emit("exit", 134);
      await flush();
      expect(electron.procs).toHaveLength(1);
    });

    it("retires an initial native Kitten crash to the system voice without retrying neural WASM", async () => {
      const { v } = service(true, { neuralVoice: true, native: true });
      v.speak("Night Light is on.");
      const [tts] = electron.procs;
      expect(posted(tts, "init")[0]).not.toHaveProperty("wasm");
      tts.emit("exit", 134); await flush();
      expect(electron.procs).toHaveLength(1);
      expect(v.naturalStatus).toEqual({ state: "wont-load", model: "kitten", voice: "system" });
      const speech = electron.windows.find(w => w.title === "Ember speech")!;
      expect(speech.webContents.send).toHaveBeenCalledWith(VOICE.speak, { text: "Night Light is on.", append: true });
    });

    it("tells Hear Ember which voice it was heard in only once the sample starts, and when none spoke it (voice-speaking-r3)", async () => {
      vi.useFakeTimers();
      const { v } = service(true, { neuralVoice: true, native: true });
      let heard: unknown = "waiting";
      void v.sample("This is how I sound.").then(r => { heard = r; });
      await vi.advanceTimersByTimeAsync(2000);
      // Kitten is still loading: nothing has been heard, so nothing is named yet.
      expect(heard).toBe("waiting");
      electron.procs[0].emit("message", { type: "ready", loadMs: 1800, rate: 22_050, voice: kitten() });
      electron.procs[0].emit("message", { type: "audio", id: 1, samples: new Float32Array(4), rate: 22_050, remaining: "" });
      await vi.advanceTimersByTimeAsync(10);
      expect(heard).toBe("waiting");
      const speech = electron.windows.find(w => w.title === "Ember speech")!;
      speaking(speech, true);
      await vi.advanceTimersByTimeAsync(0);
      expect(heard).toBe("kitten");
      // Kitten too slow, and no voice at all: the line says none spoke, not that Kitten did.
      const slow = service(true, { neuralVoice: true, native: true });
      let none: unknown = "waiting";
      void slow.v.sample("This is how I sound.").then(r => { none = r; });
      electron.procs.at(-1)!.emit("message", { type: "error", message: "too slow here: 0.81 of real time", reason: "slow" });
      await vi.advanceTimersByTimeAsync(11_000);
      expect(none).toBe("waiting");
      await vi.advanceTimersByTimeAsync(2000);
      expect(none).toBeNull();
      // Cut off by other speech before it started: neither named nor failed.
      let cut: unknown = "waiting";
      void v.sample("This is how I sound.").then(r => { cut = r; });
      v.speak("Your reminder is due.");
      await vi.advanceTimersByTimeAsync(0);
      expect(cut).toBe("stopped");
    });

    it("says Kitten stopped working when it fails after it spoke, and brings it back on Try again (voice-speaking-6)", async () => {
      const { v } = service(true, { neuralVoice: true, native: true });
      v.speak("Night Light is on.");
      electron.procs[0].emit("message", { type: "ready", loadMs: 900, rate: 22_050, voice: kitten() });
      electron.procs[0].emit("message", { type: "failed", id: 1, message: "Synthesis failed" });
      await flush();
      expect(v.naturalStatus).toEqual({ state: "wont-load", model: "kitten", voice: "system", stopped: true });
      v.retryNaturalVoice();
      expect(v.naturalStatus).toEqual({ state: "checking", model: "kitten", voice: "system" });
      expect(electron.procs).toHaveLength(2);
      electron.procs[1].emit("message", { type: "ready", loadMs: 900, rate: 22_050, voice: kitten() });
      expect(v.naturalStatus).toEqual({ state: "on", model: "kitten", voice: "kitten" });
      // The next reply is said in Kitten again, not the system voice.
      v.speak("Back in Kitten.");
      expect(posted(electron.procs[1], "say")).toEqual([expect.objectContaining({ text: "Back in Kitten." })]);
    });

    it("times Kitten again on Try again after a busy moment made it too slow (voice-speaking-6)", async () => {
      const { v } = service(true, { neuralVoice: true, native: true });
      v.speak("A reply.");
      electron.procs[0].emit("message", { type: "error", message: "too slow here: 0.81 of real time", reason: "slow" });
      await flush();
      expect(v.naturalStatus).toEqual({ state: "too-slow", model: "kitten", voice: "system" });
      v.retryNaturalVoice();
      expect(electron.procs).toHaveLength(2);
      electron.procs[1].emit("message", { type: "ready", loadMs: 900, rate: 22_050, voice: kitten() });
      expect(v.naturalStatus).toEqual({ state: "on", model: "kitten", voice: "kitten" });
    });

    it("times Kitten again by itself, once, at a request a while after a busy moment made it too slow (voice-speaking-6)", async () => {
      vi.useFakeTimers();
      const { v } = service(true, { neuralVoice: true, native: true });
      v.speak("A reply.");
      electron.procs[0].emit("message", { type: "error", message: "too slow here: 0.81 of real time", reason: "slow" });
      await vi.advanceTimersByTimeAsync(0);
      expect(v.naturalStatus).toEqual({ state: "too-slow", model: "kitten", voice: "system" });
      // Straight after, the system voice goes on.
      v.warmSpeech();
      expect(electron.procs).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      v.warmSpeech();
      expect(electron.procs).toHaveLength(2);
      expect(v.naturalStatus).toEqual({ state: "checking", model: "kitten", voice: "system" });
      electron.procs[1].emit("message", { type: "ready", loadMs: 900, rate: 22_050, voice: kitten() });
      expect(v.naturalStatus).toEqual({ state: "on", model: "kitten", voice: "kitten" });
      v.speak("Back in Kitten.");
      expect(posted(electron.procs[1], "say")).toEqual([expect.objectContaining({ text: "Back in Kitten." })]);
      // Too slow again: once a session, then Try again in Settings is the way.
      electron.procs[1].emit("message", { type: "error", message: "too slow here: 0.9 of real time", reason: "slow" });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      v.warmSpeech();
      expect(electron.procs).toHaveLength(2);
      expect(v.naturalStatus).toEqual({ state: "too-slow", model: "kitten", voice: "system" });
    });

    it("never times Kitten again by itself when it couldn't load at all (voice-speaking-6)", async () => {
      vi.useFakeTimers();
      const { v } = service(true, { neuralVoice: true, native: true });
      v.speak("A reply.");
      electron.procs[0].emit("exit", 1);
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      v.warmSpeech();
      expect(electron.procs).toHaveLength(1);
    });

    it("logs which voice speaks, on which build, how fast", async () => {
      const { log: l, lines } = recording();
      const { v } = service(true, { neuralVoice: true, native: true, log: l });
      v.speak("Hello.");
      electron.procs[0].emit("message", { type: "ready", loadMs: 1200, rate: 22_050, voice: kitten({ rtf: 0.08 }) });
      expect(lines.find(x => x.event === "voice.tts_ready")?.data).toMatchObject({ loadMs: 1200, rate: 22_050, voice: "kitten", backend: "native", provider: "cpu", threads: 2, rtf: 0.08 });
    });

    it("fetches the natural voice in the background where the Kitten voice shows the computer is fast enough, once", async () => {
      const urls: string[] = [];
      const { log: l, lines } = recording();
      const downloader = vi.fn(async (url: string) => { urls.push(url); throw new Error("HTTP 503"); });
      const { v } = service(true, { neuralVoice: true, naturalVoice: true, native: true, downloader, log: l });
      v.speak("Hello.");
      electron.procs[0].emit("message", { type: "ready", loadMs: 1200, rate: 22_050, voice: kitten({ rtf: 0.05 }) });
      await vi.waitFor(() => expect(lines.some(x => x.event === "voice.natural_download_failed")).toBe(true));
      expect(urls).toEqual([NATURAL_VOICE.url]);
      // Failed: not tried again this session.
      electron.procs[0].emit("message", { type: "ready", loadMs: 1200, rate: 22_050, voice: kitten({ rtf: 0.05 }) });
      await flush();
      expect(urls).toHaveLength(1);
    });

    it("doesn't fetch optional Kokoro when unavailable, on WebAssembly, or when not explicitly wanted", async () => {
      for (const options of [{ naturalVoice: true, naturalSupported: false, native: true }, { naturalVoice: true, native: false }, { naturalVoice: false, native: true }]) {
        electron.procs.length = 0;
        const downloader = vi.fn(async () => undefined);
        const { v } = service(true, { neuralVoice: true, ...options, downloader });
        v.speak("Hello.");
        electron.procs[0]?.emit("message", { type: "ready", loadMs: 1000, rate: 24_000, voice: kitten() });
        await flush(); expect(downloader).not.toHaveBeenCalled();
        v.stop(); fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("follows the setting: turned on, the speech process starts again with the natural voice once it has nothing to say; turned off, without it", async () => {
      const { v } = service(true, { neuralVoice: true, naturalVoice: false, native: true, downloader: vi.fn() });
      fs.mkdirSync(path.join(root, NATURAL_VOICE.target));
      fs.writeFileSync(path.join(root, `.${NATURAL_VOICE.target}.ok`), `${NATURAL_VOICE.sha256}\n`);
      v.speak("Hello.");
      const [first] = electron.procs;
      expect(posted(first, "init")[0]).toMatchObject({ natural: null });
      v.setNaturalVoice(true);
      expect(first.kill).not.toHaveBeenCalled(); // "Hello." is still being said
      first.emit("message", { type: "done", id: 1 });
      expect(first.kill).toHaveBeenCalled();
      v.speak("Again.");
      expect(posted(electron.procs[1], "init")[0]).toMatchObject({ natural: path.join(root, NATURAL_VOICE.target) });
      electron.procs[1].emit("message", { type: "done", id: 2 });
      v.setNaturalVoice(false);
      v.speak("Once more.");
      expect(posted(electron.procs[2], "init")[0]).toMatchObject({ natural: null });
    });

    it("lets the natural voice speak once it is in, unless it turned out too slow here", async () => {
      const { v } = service(true, { neuralVoice: true, naturalVoice: true, native: true, downloader: vi.fn() });
      fs.mkdirSync(path.join(root, NATURAL_VOICE.target));
      fs.writeFileSync(path.join(root, `.${NATURAL_VOICE.target}.ok`), `${NATURAL_VOICE.sha256}\n`);
      v.speak("Hello.");
      const [tts] = electron.procs;
      expect(posted(tts, "init")[0]).toMatchObject({ natural: path.join(root, NATURAL_VOICE.target) });
      tts.emit("message", { type: "ready", loadMs: 3000, rate: 22_050, voice: kitten({ natural: "too slow here: 0.9 of real time (at most 0.5)" }) });
      // A process failure retires neural speech for this session, keeping fallback sentences together.
      tts.emit("exit", 1);
      v.speak("Again.");
      await flush();
      expect(electron.procs).toHaveLength(1);
      expect(electron.windows[0].webContents.send).toHaveBeenLastCalledWith(VOICE.speak, { text: "Again." });
    });

    describe("Kitten baseline and explicit optional Kokoro", () => {
      const withKokoro = () => {
        fs.mkdirSync(path.join(root, NATURAL_VOICE.target));
        fs.writeFileSync(path.join(root, `.${NATURAL_VOICE.target}.ok`), `${NATURAL_VOICE.sha256}\n`);
      };

      it("uses Kitten with the former toggle off, without a separate optional download", () => {
        const downloader = vi.fn();
        const { v } = service(true, { neuralVoice: true, naturalVoice: false, native: true, downloader });
        expect(v.naturalStatus).toEqual({ state: "later", model: "kitten", voice: "system" });
        v.speak("Baseline reply.");
        const [tts] = electron.procs;
        expect(posted(tts, "init")[0]).toMatchObject({ model: path.join(root, VOICE_MODELS.find(m => m.id === "tts")!.target), natural: null });
        expect(posted(tts, "init")[0]).not.toHaveProperty("naturalModel");
        tts.emit("message", { type: "ready", loadMs: 1000, rate: 24_000, voice: kitten() });
        expect(v.naturalStatus).toEqual({ state: "on", model: "kitten", voice: "kitten" });
        v.setNaturalModel("kitten");
        v.setNaturalVoice(false);
        expect(downloader).not.toHaveBeenCalled();
        expect(tts.kill).not.toHaveBeenCalled();
      });

      it("doesn't accept an old Piper cache as Kitten, and exposes the explicit base download route", async () => {
        const downloader = vi.fn();
        const { v } = service(LISTENING, { neuralVoice: true, native: true, downloader });
        fs.mkdirSync(path.join(root, "vits-piper-en_US-libritts_r-medium"));
        fs.writeFileSync(path.join(root, ".vits-piper-en_US-libritts_r-medium.ok"), "old-piper-hash\n");
        expect(v.modelsReady).toBe(true);
        expect(v.missingModels.map(m => m.id)).toContain("tts");
        expect(v.naturalStatus).toEqual({ state: "needs-voice", model: "kitten", voice: "system" });
        v.speak("Use a local system voice until the user downloads Kitten.");
        await flush();
        expect(electron.procs).toHaveLength(0);
        expect(downloader).not.toHaveBeenCalled();
        expect(electron.windows[0].webContents.send).toHaveBeenCalledWith(VOICE.speak, { text: "Use a local system voice until the user downloads Kitten." });
      });

      it("keeps a working explicitly selected Kokoro cache usable while the new Kitten baseline is missing", () => {
        const downloader = vi.fn();
        const { v } = service(LISTENING, { neuralVoice: true, naturalVoice: true, naturalModel: "kokoro", native: true, downloader });
        withKokoro();
        v.speak("The selected installed voice.");
        expect(posted(electron.procs[0], "init")[0]).toMatchObject({ natural: path.join(root, NATURAL_VOICE.target) });
        electron.procs[0].emit("message", { type: "ready", loadMs: 1000, rate: 24_000, voice: kitten({ voice: "kokoro" }) });
        expect(v.naturalStatus).toEqual({ state: "on", model: "kokoro", voice: "kokoro" });
        expect(downloader).not.toHaveBeenCalled();
        expect(v.missingModels.map(m => m.id)).toContain("tts");
      });

      it("never loads or downloads unsupported saved Kokoro, while baseline Kitten remains usable", () => {
        const downloader = vi.fn();
        const { v } = service(true, { neuralVoice: true, naturalVoice: true, naturalModel: "kokoro", naturalSupported: false, native: true, downloader });
        withKokoro();
        v.speak("Supported baseline reply.");
        expect(posted(electron.procs[0], "init")[0]).toMatchObject({ natural: null });
        electron.procs[0].emit("message", { type: "ready", loadMs: 1000, rate: 24_000, voice: kitten() });
        v.retryNaturalVoice();
        expect(v.naturalStatus).toEqual({ state: "needs-native", model: "kokoro", voice: "kitten" });
        expect(downloader).not.toHaveBeenCalled();
      });

      it("cancels optional transfer and ignores its late progress/failure after choosing baseline Kitten", async () => {
        let rejectOld!: (error: Error) => void, report!: (bytes: number) => void;
        let signal: AbortSignal | undefined;
        const downloader = vi.fn((_url: string, _dest: string, progress: (bytes: number) => void, abort?: AbortSignal) => {
          signal = abort; report = progress; return new Promise<void>((_resolve, reject) => { rejectOld = reject; });
        });
        const { v } = service(true, { neuralVoice: true, naturalVoice: true, native: true, downloader });
        v.warmVoice();
        electron.procs[0].emit("message", { type: "ready", loadMs: 1000, rate: 24_000, voice: kitten() });
        await vi.waitFor(() => expect(signal).toBeDefined());
        v.setNaturalModel("kitten");
        expect(signal?.aborted).toBe(true);
        report(NATURAL_VOICE.bytes / 2); rejectOld(new Error("HTTP 503"));
        await flush();
        expect(v.naturalStatus).toEqual({ state: "on", model: "kitten", voice: "kitten" });
        expect(downloader.mock.calls.map(c => c[0])).toEqual([NATURAL_VOICE.url]);
      });

      it("cancels the optional transfer on shutdown and never resurrects synthesis", async () => {
        let rejectDownload!: (error: Error) => void, signal: AbortSignal | undefined;
        const downloader = vi.fn((_url: string, _dest: string, _progress: (bytes: number) => void, abort?: AbortSignal) => {
          signal = abort; return new Promise<void>((_resolve, reject) => { rejectDownload = reject; });
        });
        const { v } = service(true, { neuralVoice: true, naturalVoice: true, native: true, downloader });
        v.warmVoice();
        electron.procs[0].emit("message", { type: "ready", loadMs: 1000, rate: 24_000, voice: kitten() });
        await vi.waitFor(() => expect(signal).toBeDefined());
        v.stop(); rejectDownload(new Error("HTTP 503")); await flush();
        expect(signal?.aborted).toBe(true);
        expect(electron.procs).toHaveLength(1);
        expect(v.naturalStatus).toEqual({ state: "off", model: "kitten", voice: "system" });
      });

      it("serializes rapid Kokoro reselection until the cancelled transfer's shared staging cleanup finishes", async () => {
        let rejectOld!: (error: Error) => void, rejectReplacement!: (error: Error) => void;
        let oldSignal: AbortSignal | undefined, replacementPath = "";
        const downloader = vi.fn((_url: string, dest: string, _progress: (bytes: number) => void, signal?: AbortSignal) => {
          if (!oldSignal) {
            oldSignal = signal; fs.writeFileSync(dest, "old transfer");
            return new Promise<void>((_resolve, reject) => { rejectOld = reject; });
          }
          replacementPath = dest; fs.writeFileSync(dest, "replacement transfer");
          return new Promise<void>((_resolve, reject) => { rejectReplacement = reject; });
        });
        const { v } = service(true, { neuralVoice: true, naturalVoice: true, native: true, downloader });
        v.warmVoice();
        electron.procs[0].emit("message", { type: "ready", loadMs: 1000, rate: 24_000, voice: kitten() });
        await vi.waitFor(() => expect(oldSignal).toBeDefined());
        v.setNaturalModel("kitten"); v.setNaturalVoice(true);
        expect(oldSignal?.aborted).toBe(true);
        expect(downloader).toHaveBeenCalledTimes(1);
        expect(v.naturalStatus).toMatchObject({ state: "checking", model: "kokoro", voice: "kitten" });
        rejectOld(new Error("Cancelled old transfer"));
        await vi.waitFor(() => expect(downloader).toHaveBeenCalledTimes(2));
        await flush();
        expect(fs.readFileSync(replacementPath, "utf8")).toBe("replacement transfer");
        rejectReplacement(new Error("HTTP 503"));
        await vi.waitFor(() => expect(v.naturalStatus).toMatchObject({ state: "failed", model: "kokoro", voice: "kitten" }));
      });

      it("fetches only explicit Kokoro, shows its own progress/failure and supports retry", async () => {
        const seen: { state: string }[] = [];
        const downloader = vi.fn(async (_url: string, _dest: string, progress: (bytes: number) => void) => { progress(NATURAL_VOICE.bytes / 2); throw new Error("HTTP 503"); });
        const { v } = service(true, { neuralVoice: true, native: true, downloader, onNatural: status => seen.push(status) });
        v.speak("First baseline reply.");
        electron.procs[0].emit("message", { type: "ready", loadMs: 1000, rate: 24_000, voice: kitten() });
        seen.length = 0;
        v.setNaturalVoice(true);
        await vi.waitFor(() => expect(v.naturalStatus.state).toBe("failed"));
        expect(seen.map(status => status.state)).toEqual(["downloading", "downloading", "failed"]);
        expect(v.naturalStatus).toMatchObject({ model: "kokoro", voice: "kitten", detail: expect.stringMatching(/can.t reach the download site/) });
        expect(downloader.mock.calls[0][0]).toBe(NATURAL_VOICE.url);
        v.retryNaturalVoice();
        await vi.waitFor(() => expect(downloader).toHaveBeenCalledTimes(2));
      });

      it("switches from Kokoro to baseline only after its pending reply, with no extra baseline fetch", () => {
        const downloader = vi.fn();
        const { v } = service(true, { neuralVoice: true, naturalVoice: true, native: true, downloader });
        withKokoro();
        v.speak("A pending optional reply.");
        const first = electron.procs[0];
        first.emit("message", { type: "ready", loadMs: 1000, rate: 24_000, voice: kitten({ voice: "kokoro" }) });
        v.setNaturalModel("kitten");
        expect(first.kill).not.toHaveBeenCalled();
        first.emit("message", { type: "done", id: 1 });
        expect(first.kill).toHaveBeenCalledOnce();
        expect(posted(electron.procs[1], "init")[0]).toMatchObject({ natural: null });
        electron.procs[1].emit("message", { type: "ready", loadMs: 1000, rate: 24_000, voice: kitten() });
        expect(v.naturalStatus).toEqual({ state: "on", model: "kitten", voice: "kitten" });
        expect(downloader).not.toHaveBeenCalled();
      });

      it.each(["failed", "exit"] as const)("recovers optional Kokoro's suffix after %s with Kitten, then only the still-missing suffix with system speech", async how => {
        const seen: unknown[] = [];
        const { v } = service(true, { neuralVoice: true, naturalVoice: true, native: true, onNatural: value => seen.push(value) });
        withKokoro();
        v.speak("Generated sentence. Remaining sentence.");
        const kokoro = electron.procs[0];
        kokoro.emit("message", { type: "ready", loadMs: 1000, rate: 24_000, voice: kitten({ voice: "kokoro" }) });
        kokoro.emit("message", { type: "audio", id: 1, samples: new Float32Array(4), rate: 24_000, remaining: "Remaining sentence." });
        if (how === "failed") kokoro.emit("message", { type: "failed", id: 1, message: "Kokoro failed." });
        else kokoro.emit("exit", 134);
        const baseline = electron.procs[1];
        expect(posted(baseline, "init")[0]).toMatchObject({ natural: null });
        expect(posted(baseline, "say")).toEqual([{ type: "say", id: 2, text: "Remaining sentence." }]);
        baseline.emit("message", { type: "ready", loadMs: 1000, rate: 24_000, voice: kitten() });
        expect(v.naturalStatus).toEqual({ state: "wont-load", model: "kokoro", voice: "kitten" });
        expect(seen).toContainEqual({ state: "wont-load", model: "kokoro", voice: "kitten" });
        baseline.emit("message", { type: "audio", id: 2, samples: new Float32Array(4), rate: 24_000, remaining: "Still missing." });
        baseline.emit("message", { type: "failed", id: 2, message: "Kitten failed too." });
        await flush();
        const speaker = electron.windows.find(w => w.title === "Ember speech")!;
        expect(speaker.webContents.send.mock.calls.filter(c => c[0] === VOICE.speak).map(c => c[1])).toEqual([{ text: "Still missing.", append: true }]);
        expect(v.naturalStatus).toEqual({ state: "wont-load", model: "kokoro", voice: "system" });
      });

      it("hushes pending fallback synthesis and ignores late audio from both retired voices", async () => {
        const { v } = service(true, { neuralVoice: true, naturalVoice: true, native: true });
        withKokoro();
        v.speak("Private queued optional speech.");
        const kokoro = electron.procs[0];
        kokoro.emit("message", { type: "ready", loadMs: 1000, rate: 24_000, voice: kitten({ voice: "kokoro" }) });
        kokoro.emit("message", { type: "failed", id: 1, message: "Kokoro failed" });
        const baseline = electron.procs[1];
        v.hush(); await flush();
        const speaker = electron.windows.find(w => w.title === "Ember speech")!;
        speaker.webContents.send.mockClear();
        for (const [proc, id] of [[kokoro, 1], [baseline, 2]] as const) {
          proc.emit("message", { type: "audio", id, samples: new Float32Array(4), rate: 24_000, remaining: "Private late suffix." });
          proc.emit("message", { type: "failed", id, message: "Late failure" });
        }
        await flush();
        expect(speaker.webContents.send).not.toHaveBeenCalledWith(VOICE.audio, expect.anything());
        expect(speaker.webContents.send).not.toHaveBeenCalledWith(VOICE.speak, expect.anything());
      });

      it("keeps ASR available on forced WASM while baseline neural speech uses the system voice", async () => {
        const before = process.env.EMBER_VOICE_BACKEND;
        process.env.EMBER_VOICE_BACKEND = "wasm";
        try {
          const { v } = service(true, { neuralVoice: true, native: true });
          await v.setWanted(true);
          expect(electron.procs).toHaveLength(1); // ASR still starts.
          v.speak("System speech while ASR uses WASM."); await flush();
          expect(electron.procs).toHaveLength(1); // No neural speech process or WASM TTS retry.
          expect(v.naturalStatus).toEqual({ state: "needs-native", model: "kitten", voice: "system" });
          expect(electron.windows[0].webContents.send).toHaveBeenCalledWith(VOICE.speak, { text: "System speech while ASR uses WASM." });
        } finally {
          if (before === undefined) delete process.env.EMBER_VOICE_BACKEND;
          else process.env.EMBER_VOICE_BACKEND = before;
        }
      });

      it.each([["slow", "too-slow"], ["load", "wont-load"], ["native", "needs-native"]] as const)("reports default Kitten %s failure and uses system speech without neural WASM", async (reason, state) => {
        const { v } = service(true, { neuralVoice: true, native: true });
        v.speak("A local fallback reply.");
        electron.procs[0].emit("message", { type: "error", message: "Kitten unavailable", reason });
        await flush();
        expect(electron.procs).toHaveLength(1);
        expect(v.naturalStatus).toEqual({ state, model: "kitten", voice: "system" });
        expect(electron.windows[0].webContents.send).toHaveBeenCalledWith(VOICE.speak, { text: "A local fallback reply.", append: true });
      });

      it("defers an optional choice while locked, then reports its explicit download rather than a silent toggle", async () => {
        const { v } = service(true, { neuralVoice: true, native: true, downloader: vi.fn(async () => { throw new Error("HTTP 503"); }) });
        v.setLocked(true); v.setNaturalVoice(true);
        expect(electron.procs).toHaveLength(0);
        expect(v.naturalStatus).toMatchObject({ state: "later", model: "kokoro" });
        v.setLocked(false);
        expect(v.naturalStatus).toMatchObject({ state: "checking" });
        electron.procs[0].emit("message", { type: "ready", loadMs: 1000, rate: 24_000, voice: kitten() });
        await vi.waitFor(() => expect(v.naturalStatus).toMatchObject({ state: "failed", model: "kokoro", voice: "kitten" }));
      });
    });
  });
});

describe("VoiceService with only some of the models", () => {
  it("listens with only the wake word, voice activity and speech recognition; the download offers just the rest", async () => {
    const { v, states } = service(LISTENING);
    expect(v.modelsReady).toBe(true);
    expect(v.missingModels.map(m => m.id)).toEqual(["tts", "speaker"]);
    await v.setWanted(true);
    expect(electron.procs).toHaveLength(1);
    expect(states.at(-1)?.s).toBe("starting");
  });

  it("doesn't listen without one of listening's own models, whatever else is in", async () => {
    for (const gone of LISTENING) {
      const { v, states } = service(VOICE_MODELS.map(m => m.id).filter(id => id !== gone));
      await v.setWanted(true);
      expect(states.at(-1)?.s).toBe("needs-models");
      expect(v.missingModels.map(m => m.id)).toEqual([gone]);
      fs.rmSync(root, { recursive: true, force: true });
    }
    expect(electron.procs).toHaveLength(0);
  });

  it("speaks in Ember's voice when its model is in though Voice Match's isn't", async () => {
    const { v } = service([...LISTENING, "tts"], { neuralVoice: true });
    v.speak("Hello.");
    await flush();
    expect(electron.procs).toHaveLength(1);
    expect(posted(electron.procs[0], "init")[0]).toMatchObject({ model: expect.stringContaining(root) });
  });

  it("speaks in the system's voice when Ember's voice is missing, and still listens", async () => {
    const { v } = service([...LISTENING, "speaker"], { neuralVoice: true });
    await v.setWanted(true);
    const [proc] = electron.procs;
    proc.emit("message", { type: "ready", loadMs: 900 });
    v.speak("Hello.");
    await flush();
    expect(electron.procs).toHaveLength(1); // no voice process for Ember's voice
    const mic = electron.windows.find(w => w.title === "Ember microphone")!;
    expect(mic.webContents.send).toHaveBeenCalledWith(VOICE.speak, { text: "Hello." });
  });

  it("turns Voice Match off, rather than making Ember deaf, while a kept voiceprint's model is missing", async () => {
    const { v } = service([...LISTENING, "tts"], { voiceprint: () => "PRINT" });
    expect(v.matchReady).toBe(false);
    await v.setWanted(true);
    const [proc] = electron.procs;
    expect(posted(proc, "init")[0]).toMatchObject({ voiceprint: null });
    proc.emit("message", { type: "ready", loadMs: 900 });
    expect(v.enrol()).toBe(false); // nothing to make a voiceprint with
    v.setVoiceprint("PRINT");
    expect(posted(proc, "voiceprint")).toMatchObject([{ type: "voiceprint", print: null, refresh: false, generation: expect.any(Number) }]);
  });

  it("fetches Voice Match's model alone into the user's folder, from a bundled folder without it, while listening carries on", async () => {
    const bundled = modelsRoot([...LISTENING, "tts"]);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-voice-user-"));
    const userRoot = path.join(root, "models");
    const speaker = VOICE_MODELS.find(m => m.id === "speaker")!;
    const real = speaker.sha256;
    const content = Buffer.from("a voiceprint model");
    speaker.sha256 = crypto.createHash("sha256").update(content).digest("hex");
    const states: { s: MicState; detail?: string }[] = [];
    const changed = vi.fn();
    const v = new VoiceService({ log, modelsRoot: bundled, bundled: { userRoot }, monitor: false, voiceprint: () => "PRINT", onModels: changed, onEvent: () => undefined, onState: (s, detail) => states.push({ s, detail }) });
    services.push(v);
    try {
      await v.setWanted(true);
      const [proc] = electron.procs;
      expect(posted(proc, "init")[0]).toMatchObject({ voiceprint: null, models: { kws: expect.stringContaining(bundled), speaker: expect.stringContaining(userRoot) } });
      proc.emit("message", { type: "ready", loadMs: 900 });
      expect(v.missingModels.map(m => m.id)).toEqual(["speaker"]);
      electron.net.fetch.mockResolvedValue(new Response(content));
      const progress: number[][] = [];
      const done = v.downloadModels((d, t) => progress.push([d, t]));
      expect(v.isDownloading).toBe(true);
      expect(changed).toHaveBeenCalled(); // settings hears it started
      await done;
      expect(electron.net.fetch.mock.calls.map(c => c[0])).toEqual([speaker.url]);
      expect(progress.at(-1)).toEqual([speaker.bytes, speaker.bytes]);
      expect(states.map(s => s.s)).not.toContain("downloading"); // listening went on
      expect(modelReady(userRoot, "speaker")).toBe(true);
      expect(markers(bundled)).toHaveLength(4); // nothing written into what came with Ember
      expect(v.matchReady).toBe(true);
      expect(posted(proc, "voiceprint")).toMatchObject([{ type: "voiceprint", print: "PRINT", refresh: false, generation: expect.any(Number) }]); // Voice Match is back on
      expect(v.enrol()).toBe(true);
    } finally {
      speaker.sha256 = real;
      fs.rmSync(bundled, { recursive: true, force: true });
    }
  });

  it("keeps listening when the download of a missing optional model fails, saying why", async () => {
    const { v, states } = service(LISTENING);
    await v.setWanted(true);
    electron.procs[0].emit("message", { type: "ready", loadMs: 900 });
    electron.net.fetch.mockRejectedValue(new Error("net::ERR_INTERNET_DISCONNECTED"));
    await expect(v.downloadModels(() => undefined)).rejects.toThrow();
    expect(electron.net.fetch.mock.calls[0][0]).toBe(VOICE_MODELS.find(m => m.id === "tts")!.url);
    expect(states.at(-1)).toMatchObject({ s: "waiting", detail: expect.stringMatching(/^Couldn't download the speech models/) });
    expect(electron.procs[0].kill).not.toHaveBeenCalled();
  });
});
