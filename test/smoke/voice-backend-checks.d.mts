/** Observations from the actual speech utility process, including every ready/audio message. */
export interface SpeechBackendRun {
  unavailable?: string; readyCount: number; audioChunks: number; audioSeconds: number; rtf?: number;
  voice?: { voice?: string; backend?: string };
}
/** Throws if native Kitten or native-only refusal is not proved by the process observations. */
export function defaultSpeechBackend(run: SpeechBackendRun, native: boolean): void;
