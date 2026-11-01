/** Voice: channel names and types shared by main, the mic window and the voice process. */

export const VOICE = {
  port: "voice:port",
  status: "voice:mic-status",
  speak: "voice:speak",
  hush: "voice:hush",
  speaking: "voice:speaking",
  /** The speaking page found that a reply was heard (true) or that no voice spoke (false). */
  speech: "voice:speech",
  /** A chunk of Ember's own (neural) voice to play (SpeechAudio), and the end of a reply's chunks (its id). */
  audio: "voice:audio",
  audioDone: "voice:audio-done",
} as const;

/** What the system's voice is to say; `append`: after what it is saying (the next sentence of a streamed answer), not instead. */
export interface SpeakRequest {
  text: string;
  append?: boolean;
}

/** One chunk of a reply in Ember's own voice: mono samples at `rate` Hz, for reply `id` (main numbers them). */
export interface SpeechAudio {
  id: number;
  samples: Float32Array;
  rate: number;
}

/** "error": Ember may not use the microphone (not retried); "lost": there's no sound from it (it went away, isn't there yet, or is busy), and the page is trying again. */
export type MicStatus = { state: "capturing"; device: string; rate: number; context: string } | { state: "error"; message: string } | { state: "lost"; message: string };

export interface MicApi {
  status(s: MicStatus): void;
  speaking(on: boolean): void;
  /** A reply started (true), or none did: the computer has no voice (false). Sent only when it changes. */
  speech(ok: boolean): void;
  onSpeak(fn: (r: SpeakRequest) => void): void;
  onHush(fn: () => void): void;
  onAudio(fn: (a: SpeechAudio) => void): void;
  onAudioDone(fn: (id: number) => void): void;
}

/** What the user sees about the microphone. */
export type MicState = "off" | "needs-models" | "downloading" | "starting" | "waiting" | "active" | "muted" | "error";
