/** Holds system speech until neural playback drains and an explicitly local voice is available. */
import { bestVoice, type VoiceInfo } from "./voices";

/** Injectable boundary: the renderer owns speechSynthesis and its voiceschanged event. */
export interface LocalSpeechDeps<V extends VoiceInfo> {
  voices(): V[];
  busy(): boolean;
  speak(text: string, voice: V): void;
  unavailable(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

/** Never submits an utterance with an unrestricted default voice; cancelled words cannot revive on voiceschanged. */
export class LocalSpeech<V extends VoiceInfo> {
  private pending: string[] = [];
  private timer: unknown = null;
  constructor(private d: LocalSpeechDeps<V>, private lang: string) {}

  enqueue(text: string): void { this.pending.push(text); this.drain(); }

  /** Called after neural audio ends and whenever the operating system's voice list changes. */
  drain(): void {
    if (!this.pending.length || this.d.busy()) return;
    const voice = bestVoice(this.d.voices(), this.lang);
    if (!voice) {
      if (this.timer === null) this.timer = this.d.setTimer(() => {
        this.timer = null;
        this.pending = [];
        this.d.unavailable();
      }, 3000);
      return;
    }
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
    const pending = this.pending;
    this.pending = [];
    for (const text of pending) this.d.speak(text, voice);
  }

  cancel(): void {
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
    this.pending = [];
  }
}
