/** Log fields used by the Electron voice smoke's assertions. */
export interface VoiceLog {
  msg: string;
  source?: string;
  window?: string;
  on?: boolean;
  seconds?: number;
  type?: string;
}
/** The index of the app-wide kill switch pulled by this voice stop; throws when it is missing. */
export function voiceStop(log: VoiceLog[], stopAt: number): number;
/** Verify all spoken turns and their reopened follow-up windows, with just one wake. */
export function voiceConversation(log: VoiceLog[], windows: string[], system?: boolean): { request: number; on: number; audio: number | null; off: number; followUp: number }[];
/** Requires actual renderer system-speech start/completion and no neural ready/audio events. */
export function voiceSystemSpeech(log: VoiceLog[], from?: number): { on: number; off: number };
