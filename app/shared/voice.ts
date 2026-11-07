/** Voice: channel names and types shared by main, the mic window and the voice process. */

import type { SoundLevel } from "./level";

export const VOICE = {
  port: "voice:port",
  status: "voice:mic-status",
  speak: "voice:speak",
  hush: "voice:hush",
  /** Ember's voice drops, or comes back: speech was heard over it, and may be the user cutting in (engine.ts). */
  duck: "voice:duck",
  /** Main to the mic page: a conversation opened or closed, so watch whether other sound plays (output-watch.ts), or stop. */
  outputWatch: "voice:output-watch",
  /** The mic page to main: other sound is playing, or no longer. */
  outputBusy: "voice:output-busy",
  speaking: "voice:speaking",
  /** The speaking page found that a reply was heard (true) or that no voice spoke (false). */
  speech: "voice:speech",
  /** A chunk of Ember's own (neural) voice to play (SpeechAudio), and the end of a reply's chunks (its id). */
  audio: "voice:audio",
  audioDone: "voice:audio-done",
  /** The speaking page scheduled a chunk of Ember's own voice to play (SpeechPlayed): said in the log. */
  played: "voice:played",
  /** The page's sound level for Ember's presence (app/shared/level.ts SoundLevel): never audio, at most 20 a second. */
  level: "voice:level",
  /** Main tells the mic page to send the microphone's level (true while Ember hears a request) or to stop. */
  levelOn: "voice:level-on",
} as const;

/** What the system's voice is to say; `append`: after what it is saying (the next sentence of a streamed answer), not instead. */
export interface SpeakRequest {
  text: string;
  append?: boolean;
  /** A reply in another language (speechLanguage): said only by a local voice for it, never by Kitten. */
  lang?: string;
  /** The speaking speed setting (0.8 to 1.4), when it isn't 1. */
  rate?: number;
}

/** One chunk of a reply in Ember's own voice: mono samples at `rate` Hz, for reply `id` (main numbers them). */
export interface SpeechAudio {
  id: number;
  samples: Float32Array;
  rate: number;
}

/** A chunk of reply `id` that the speaking page scheduled to play, and how long it lasts (s). */
export interface SpeechPlayed {
  id: number;
  seconds: number;
}

/** Capture time of the first sample, so Listen once cannot use audio queued before activation. */
export interface MicFrame { samples: ArrayBuffer; capturedAt: number }

/** "error": Ember may not use the microphone (not retried); "lost": there's no sound from it (it went away, isn't there yet, or is busy), and the page is trying again. */
export type MicStatus = { state: "capturing"; device: string; rate: number; context: string } | { state: "paused" } | { state: "error"; message: string } | { state: "lost"; message: string };

export interface MicApi {
  status(s: MicStatus): void;
  speaking(on: boolean, generation: number): void;
  /** A reply started (true), or none did: the computer has no voice (false). Sent only when it changes. */
  speech(ok: boolean): void;
  onSpeak(fn: (r: SpeakRequest) => void): void;
  onDuck(fn: (on: boolean) => void): void;
  onOutputWatch(fn: (on: boolean) => void): void;
  outputBusy(on: boolean): void;
  onHush(fn: (generation: number) => void): void;
  onAudio(fn: (a: SpeechAudio) => void): void;
  onAudioDone(fn: (id: number) => void): void;
  /** A chunk of Ember's own voice was scheduled to play (said in main's log). */
  played(p: SpeechPlayed): void;
  /** The sound's level in steps (app/shared/level.ts): the microphone's while main asked for it, Ember's voice while it plays. */
  level(l: SoundLevel): void;
  /** Main asks for the microphone's level (true: Ember hears a request) or says to stop sending it. */
  onLevelOn(fn: (on: boolean) => void): void;
}

/** What the user sees about the microphone. */
export type MicState = "off" | "needs-models" | "downloading" | "starting" | "waiting" | "active" | "muted" | "error";
