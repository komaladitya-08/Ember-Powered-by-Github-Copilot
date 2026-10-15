/** Voice: channel names and types shared by main, the mic window and the voice process. */

export const VOICE = {
  port: "voice:port",
  status: "voice:mic-status",
  speak: "voice:speak",
  hush: "voice:hush",
  speaking: "voice:speaking",
} as const;

/** "error": the microphone couldn't be opened at all; "lost": it worked, went away, and the page is trying again. */
export type MicStatus = { state: "capturing"; device: string; rate: number; context: string } | { state: "error"; message: string } | { state: "lost"; message: string };

export interface MicApi {
  status(s: MicStatus): void;
  speaking(on: boolean): void;
  onSpeak(fn: (text: string) => void): void;
  onHush(fn: () => void): void;
}

/** What the user sees about the microphone. */
export type MicState = "off" | "needs-models" | "downloading" | "starting" | "waiting" | "active" | "muted" | "error";
