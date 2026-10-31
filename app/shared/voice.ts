/** Voice: channel names and types shared by main, the mic window and the voice process. */

export const VOICE = {
  port: "voice:port",
  status: "voice:mic-status",
  speak: "voice:speak",
  hush: "voice:hush",
  speaking: "voice:speaking",
  /** The speaking page found that a reply was heard (true) or that no voice spoke (false). */
  speech: "voice:speech",
} as const;

/** "error": Ember may not use the microphone (not retried); "lost": there's no sound from it (it went away, isn't there yet, or is busy), and the page is trying again. */
export type MicStatus = { state: "capturing"; device: string; rate: number; context: string } | { state: "error"; message: string } | { state: "lost"; message: string };

export interface MicApi {
  status(s: MicStatus): void;
  speaking(on: boolean): void;
  /** A reply started (true), or none did: the computer has no voice (false). Sent only when it changes. */
  speech(ok: boolean): void;
  onSpeak(fn: (text: string) => void): void;
  onHush(fn: () => void): void;
}

/** What the user sees about the microphone. */
export type MicState = "off" | "needs-models" | "downloading" | "starting" | "waiting" | "active" | "muted" | "error";
