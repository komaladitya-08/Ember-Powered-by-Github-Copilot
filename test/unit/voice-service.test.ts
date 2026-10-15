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
  const windows: { title: string; webContents: { send: ReturnType<typeof vi.fn>; postMessage: ReturnType<typeof vi.fn> }; destroyed: boolean }[] = [];
  class BrowserWindow {
    title: string;
    webContents = { send: vi.fn(), postMessage: vi.fn() };
    destroyed = false;
    constructor(o: { title: string }) { this.title = o.title; windows.push(this); }
    loadFile() { return Promise.resolve(); }
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

import { VoiceService } from "../../app/main/voice";
import { VOICE, type MicState } from "../../app/shared/voice";
import { VOICE_MODELS, modelsReady } from "../../app/voice/models";
import type { VoiceEvent } from "../../app/voice/engine";
import type { Logger } from "../../app/main/logger";

const log: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => log, file: "" };
let root: string;
let services: VoiceService[] = [];

/** A models folder that verifies (or an empty one). */
function modelsRoot(ready: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-voice-"));
  if (ready) for (const m of VOICE_MODELS) { fs.mkdirSync(path.join(dir, m.target)); fs.writeFileSync(path.join(dir, `.${m.target}.ok`), `${m.sha256}\n`); }
  return dir;
}

function service(ready = true) {
  root = modelsRoot(ready);
  const states: { s: MicState; detail?: string }[] = [];
  const events: VoiceEvent[] = [];
  const v = new VoiceService({ log, modelsRoot: root, monitor: false, onEvent: e => events.push(e), onState: (s, detail) => states.push({ s, detail }) });
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
    proc.emit("message", { type: "utterance", text: "Turn on night light.", ms: 120 });
    speaking(mic, false);
    expect(posted(proc, "follow-up")).toEqual([]);
    expect(events).toEqual([]);
    vi.advanceTimersByTime(1100);
    proc.emit("message", { type: "utterance", text: "Make the text bigger.", ms: 120 });
    expect(events).toEqual([{ type: "utterance", text: "Make the text bigger.", ms: 120 }]);
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
    expect(speech.webContents.send).toHaveBeenCalledWith(VOICE.speak, "Hello.");
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
    expect(states.at(-1)).toEqual({ s: "needs-models", detail: "Couldn't download the speech models: net::ERR_PROXY_CONNECTION_FAILED" });
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
});
