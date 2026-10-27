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
  it("says it can tell the user from the speakers only while the voice process hears the speakers' stream (review #252)", async () => {
    const { v } = service();
    expect(v.rejectsSpeakers).toBe(false);
    await v.setWanted(true);
    const [proc] = electron.procs;
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
    // A minute of listening later, a new failure starts the backoff over.
    await vi.advanceTimersByTimeAsync(61_000);
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
