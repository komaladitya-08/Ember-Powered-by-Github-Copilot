/**
 * "No voice speaks Ember's replies" from end to end (review #101), as behaviour rather than source text: the speaking
 * page (renderer/mic/main.ts) run against a stand-in speechSynthesis tells main what it found, and VoiceService passes
 * it on from Ember's own pages only. speech-watch.ts's decisions are tested in onboarding.test.ts.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- hoisted above the imports
  const { EventEmitter: Emitter } = require("node:events") as typeof import("node:events");
  const windows: { title: string; webContents: InstanceType<typeof Emitter> & { send: ReturnType<typeof vi.fn> } }[] = [];
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
    windows,
    app: { isPackaged: false },
    ipcMain: new Emitter(),
    net: { fetch: vi.fn() },
    session: { defaultSession: {} },
    BrowserWindow,
    MessageChannelMain: class { port1 = {}; port2 = {}; },
    utilityProcess: { fork: () => Object.assign(new Emitter(), { postMessage: vi.fn(), kill: vi.fn(), stderr: null }) },
  };
});
vi.mock("electron", () => electron);

import { VoiceService } from "../../app/main/voice";
import { VOICE, type MicApi } from "../../app/shared/voice";
import type { Logger } from "../../app/main/logger";

const log: Logger = { debug() {}, info() {}, warn() {}, error() {}, child: () => log, file: "" };
let root: string;

beforeEach(() => { electron.windows.length = 0; electron.ipcMain.removeAllListeners(); root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-speech-")); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); fs.rmSync(root, { recursive: true, force: true }); });

describe("VoiceService and the speaking page's finding (review #101)", () => {
  it("tells main what Ember's own speaking page found, and nothing another page says", async () => {
    const heard: boolean[] = [];
    const v = new VoiceService({ log, modelsRoot: root, monitor: false, onEvent: () => undefined, onState: () => undefined, onSpeech: ok => heard.push(ok) });
    // Listening is off: a reply is spoken by a page that only speaks.
    v.speak("Night Light is on.");
    const speech = electron.windows.find(w => w.title === "Ember speech")!;
    expect(speech).toBeDefined();
    electron.ipcMain.emit(VOICE.speech, { sender: speech.webContents }, false);
    electron.ipcMain.emit(VOICE.speech, { sender: { not: "Ember's" } }, true);
    // Only a real true counts as heard.
    electron.ipcMain.emit(VOICE.speech, { sender: speech.webContents }, "yes");
    electron.ipcMain.emit(VOICE.speech, { sender: speech.webContents }, true);
    expect(heard).toEqual([false, false, true]);
    v.stop();
  });
});

describe("the speaking page (review #101)", () => {
  /** A stand-in for the browser's speechSynthesis: utterances are kept, and the test starts or fails them. */
  class Utterance {
    lang = "";
    rate = 1;
    onstart: (() => void) | null = null;
    onend: (() => void) | null = null;
    onerror: ((e: { error: string }) => void) | null = null;
    constructor(public text: string) {}
  }

  it("tells main that no voice speaks, that one does again, and nothing for a reply too long", async () => {
    vi.useFakeTimers();
    const spoken: Utterance[] = [];
    let onSpeak: (text: string) => void = () => undefined;
    const api: MicApi = { status: vi.fn(), speaking: vi.fn(), speech: vi.fn(), onSpeak: fn => { onSpeak = fn; }, onHush: () => undefined };
    vi.stubGlobal("window", { emberMic: api, addEventListener: () => undefined });
    vi.stubGlobal("SpeechSynthesisUtterance", Utterance);
    vi.stubGlobal("speechSynthesis", { speak: (u: Utterance) => spoken.push(u), cancel: () => undefined });
    vi.resetModules();
    await import("../../app/renderer/mic/main");

    // No voice: the reply never starts.
    onSpeak("Night Light is on.");
    vi.advanceTimersByTime(7900);
    expect(api.speech).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(api.speech).toHaveBeenLastCalledWith(false);
    // A voice was added: the next reply starts.
    onSpeak("Done.");
    spoken[1].onstart?.();
    expect(api.speech).toHaveBeenLastCalledWith(true);
    // One reply too long for the synthesiser says nothing about the voice, then or 8 s later.
    onSpeak("A very long answer.");
    spoken[2].onerror?.({ error: "text-too-long" });
    vi.advanceTimersByTime(9000);
    expect(api.speech).toHaveBeenCalledTimes(2);
    // The synthesiser saying it has no voice does.
    onSpeak("Again.");
    spoken[3].onerror?.({ error: "voice-unavailable" });
    expect(api.speech).toHaveBeenLastCalledWith(false);
    expect(api.speech).toHaveBeenCalledTimes(3);
  });
});
