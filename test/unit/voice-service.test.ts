/**
 * VoiceService (main process) with a stand-in for Electron: the follow-up waits for Ember to stop
 * speaking, the kill switch's cancel, the download's states, muting, and speaking with listening off.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- hoisted above the imports
  const { EventEmitter: Emitter } = require("node:events") as typeof import("node:events");
  const procs: (InstanceType<typeof Emitter> & { postMessage: ReturnType<typeof vi.fn>; kill: ReturnType<typeof vi.fn>; stderr: null })[] = [];
  const windows: { title: string; webContents: InstanceType<typeof Emitter> & { send: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }; destroyed: boolean }[] = [];
  class BrowserWindow {
    title: string;
    webContents = Object.assign(new Emitter(), { send: vi.fn(), postMessage: vi.fn() });
    destroyed = false;
    constructor(o: { title: string }) { this.title = o.title; windows.push(this); }
    loadURL() { return Promise.resolve(); }
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

import { VoiceService, type VoiceOptions } from "../../app/main/voice";
import { VOICE, type MicState } from "../../app/shared/voice";
import crypto from "node:crypto";
import { NATURAL_VOICE, VOICE_MODELS, modelReady, modelsReady, type ModelId } from "../../app/voice/models";
import type { VoiceEvent } from "../../app/voice/engine";
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

function service(ready: boolean | readonly ModelId[] = true, o: Partial<Pick<VoiceOptions, "neuralVoice" | "naturalVoice" | "native" | "downloader" | "voiceprint" | "log">> & { onEnrol?: (e: unknown) => void } = {}) {
  root = modelsRoot(ready);
  const states: { s: MicState; detail?: string }[] = [];
  const events: VoiceEvent[] = [];
  // Speech runs on WebAssembly unless a test says otherwise (on Windows and macOS the service would default to the addon).
  const v = new VoiceService({ log, modelsRoot: root, monitor: false, onEvent: e => events.push(e), onState: (s, detail) => states.push({ s, detail }), native: false, ...o } as VoiceOptions);
  services.push(v);
  return { v, states, events };
}

const posted = (p: { postMessage: ReturnType<typeof vi.fn> }, type: string) => p.postMessage.mock.calls.map(c => c[0] as { type: string }).filter(m => m.type === type);
const flush = () => new Promise<void>(r => setImmediate(r));
/** Speaking events, as the mic (or speech) window sends them. */
const speaking = (win: { webContents: object }, on: boolean) => electron.ipcMain.emit(VOICE.speaking, { sender: win.webContents }, on);

beforeEach(() => { electron.procs.length = 0; electron.windows.length = 0; electron.ipcMain.removeAllListeners(); electron.net.fetch.mockReset(); services = []; });
afterEach(() => { vi.useRealTimers(); for (const s of services) s.stop(); fs.rmSync(root, { recursive: true, force: true }); });

describe("VoiceService", () => {
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
    proc.emit("message", { type: "utterance", text: "Turn on night light.", ms: 120, window: "wake" });
    speaking(mic, false);
    expect(posted(proc, "follow-up")).toEqual([]);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1100);
    proc.emit("message", { type: "utterance", text: "Make the text bigger.", ms: 120, window: "wake" });
    expect(events).toEqual([{ type: "utterance", text: "Make the text bigger.", ms: 120, window: "wake" }]);
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
    expect(mic.webContents.send).toHaveBeenCalledWith(VOICE.hush);
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
    expect(speech.webContents.send).toHaveBeenCalledWith(VOICE.hush);
  });

  it("goes back from 'Downloading…' with the reason when the download fails, leaving nothing behind", async () => {
    const { v, states } = service(false);
    await v.setWanted(true);
    expect(states.at(-1)?.s).toBe("needs-models");
    electron.net.fetch.mockRejectedValue(new Error("net::ERR_PROXY_CONNECTION_FAILED"));
    await expect(v.downloadModels(() => undefined)).rejects.toThrow(/ERR_PROXY/);
    expect(states.map(s => s.s)).toContain("downloading");
    expect(states.at(-1)).toEqual({ s: "needs-models", detail: "Couldn't download the speech models. Ember can't reach the download site (github.com) right now. Check the network or proxy, then try again." });
    expect(v.micState).toBe("needs-models");
    expect(fs.readdirSync(root)).toEqual([]);
  });

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
    const audio = (id: number) => ({ type: "audio", id, samples: new Float32Array(4), rate: 22_050 });

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
      expect(posted(proc, "enrol")).toEqual([{ type: "enrol" }]);
      proc.emit("message", { type: "enrol", state: "heard", got: 1, of: 4 });
      expect(progress).toEqual([{ type: "enrol", state: "heard", got: 1, of: 4 }]);
      v.cancelEnrol();
      expect(posted(proc, "enrol-cancel")).toHaveLength(1);
      v.setVoiceprint(null);
      expect(posted(proc, "voiceprint")).toEqual([{ type: "voiceprint", print: null }]);
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
    const piper = (over: Record<string, unknown> = {}) => ({ voice: "piper", backend: "native", detail: "sherpa-onnx 1.13.8", provider: "cpu", threads: 2, tried: [{ provider: "cpu" }], rtf: 0.05, ...over });

    it("logs which build and provider the voice process runs on", async () => {
      const { log: l, lines } = recording();
      const { v } = service(true, { native: true, log: l });
      await v.setWanted(true);
      const backend = { backend: "native", detail: "sherpa-onnx 1.13.8 (11afbd00), onnxruntime 1.28.2", provider: "coreml", threads: 2, tried: [{ provider: "coreml", ms: 31 }, { provider: "cpu", ms: 48 }] };
      electron.procs[0].emit("message", { type: "ready", loadMs: 900, backend });
      expect(lines.find(x => x.event === "voice.ready")?.data).toEqual({ loadMs: 900, ...backend });
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

    it("starts Ember's voice again on WebAssembly when it dies loading natively, with what it had to say", async () => {
      const { v } = service(true, { neuralVoice: true, native: true });
      v.speak("Night Light is on.");
      const [tts] = electron.procs;
      expect(posted(tts, "init")[0]).not.toHaveProperty("wasm");
      tts.emit("exit", 134);
      expect(electron.procs).toHaveLength(2);
      expect(posted(electron.procs[1], "init")[0]).toMatchObject({ wasm: true });
      expect(posted(electron.procs[1], "say")).toEqual([{ type: "say", id: 1, text: "Night Light is on." }]);
      // Not a failure of the voice: the system's voice wasn't asked.
      const speech = electron.windows.find(w => w.title === "Ember speech")!;
      expect(speech.webContents.send).not.toHaveBeenCalledWith(VOICE.speak, expect.anything());
    });

    it("logs which voice speaks, on which build, how fast", async () => {
      const { log: l, lines } = recording();
      const { v } = service(true, { neuralVoice: true, native: true, log: l });
      v.speak("Hello.");
      electron.procs[0].emit("message", { type: "ready", loadMs: 1200, rate: 22_050, voice: piper({ rtf: 0.08 }) });
      expect(lines.find(x => x.event === "voice.tts_ready")?.data).toMatchObject({ loadMs: 1200, rate: 22_050, voice: "piper", backend: "native", provider: "cpu", threads: 2, rtf: 0.08 });
    });

    it("fetches the natural voice in the background where the Piper voice shows the computer is fast enough, once", async () => {
      const urls: string[] = [];
      const { log: l, lines } = recording();
      const downloader = vi.fn(async (url: string) => { urls.push(url); throw new Error("HTTP 503"); });
      const { v } = service(true, { neuralVoice: true, naturalVoice: true, native: true, downloader, log: l });
      v.speak("Hello.");
      electron.procs[0].emit("message", { type: "ready", loadMs: 1200, rate: 22_050, voice: piper({ rtf: 0.05 }) });
      await vi.waitFor(() => expect(lines.some(x => x.event === "voice.natural_download_failed")).toBe(true));
      expect(urls).toEqual([NATURAL_VOICE.url]);
      // Failed: not tried again this session.
      electron.procs[0].emit("message", { type: "ready", loadMs: 1200, rate: 22_050, voice: piper({ rtf: 0.05 }) });
      await flush();
      expect(urls).toHaveLength(1);
    });

    it("doesn't fetch it where the Piper voice is too slow for it, on WebAssembly, or when not wanted", async () => {
      for (const [voice, naturalVoice] of [[piper({ rtf: 0.2 }), true], [piper({ backend: "wasm", rtf: undefined }), true], [piper(), false]] as const) {
        electron.procs.length = 0;
        const downloader = vi.fn(async () => undefined);
        const { v } = service(true, { neuralVoice: true, naturalVoice, native: true, downloader });
        v.speak("Hello.");
        electron.procs[0].emit("message", { type: "ready", loadMs: 1200, rate: 22_050, voice });
        await flush();
        expect(downloader).not.toHaveBeenCalled();
        v.stop();
        fs.rmSync(root, { recursive: true, force: true });
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
      tts.emit("message", { type: "ready", loadMs: 3000, rate: 22_050, voice: piper({ natural: "too slow here: 0.9 of real time (at most 0.5)" }) });
      // Started again (it stopped), it isn't offered the natural voice this session.
      tts.emit("exit", 1);
      v.speak("Again.");
      expect(posted(electron.procs[1], "init")[0]).toMatchObject({ natural: null });
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
    expect(posted(proc, "voiceprint")).toEqual([{ type: "voiceprint", print: null }]);
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
      expect(posted(proc, "voiceprint")).toEqual([{ type: "voiceprint", print: "PRINT" }]); // Voice Match is back on
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
