/** Holds system speech until neural playback drains and an explicitly local voice is available. */
import { bestVoice, type VoiceInfo } from "./voices";

/** Injectable boundary: the renderer owns speechSynthesis and its voiceschanged event. */
export interface LocalSpeechDeps<V extends VoiceInfo> {
  voices(): V[];
  busy(): boolean;
  /** `lang`: a reply in another language, said in that language. */
  speak(text: string, voice: V, lang?: string): void;
  unavailable(): void;
  /** Words were given up on after the wait for a voice (what waits behind them can go on). */
  dropped?(): void;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
}

/** Never submits an utterance with an unrestricted default voice; cancelled words cannot revive on voiceschanged. */
export class LocalSpeech<V extends VoiceInfo> {
  private pending: { text: string; lang?: string }[] = [];
  private timer: unknown = null;
  constructor(private d: LocalSpeechDeps<V>, private lang: string) {}

  /** `lang`: a reply in another language (voice-speaking-11), said only by a local voice for it. */
  enqueue(text: string, lang?: string): void { this.pending.push({ text, ...(lang ? { lang } : {}) }); this.drain(); }

  /** Called after neural audio ends and whenever the operating system's voice list changes. */
  drain(): void {
    if (!this.pending.length || this.d.busy()) return;
    const voices = this.d.voices();
    const voice = bestVoice(voices, this.lang);
    // Words in another language wait only for the voices to load: with none for that language, they aren't said (the
    // bubble shows them), and that isn't speech failing, also on a computer with no voices at all (voice-speaking-r1).
    if (!voices.length || (!voice && this.pending.some(p => !p.lang))) {
      if (this.timer === null) this.timer = this.d.setTimer(() => {
        this.timer = null;
        const failed = this.pending.some(p => !p.lang);
        this.pending = [];
        if (failed) this.d.unavailable();
        this.d.dropped?.();
      }, 3000);
      return;
    }
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
    const pending = this.pending;
    this.pending = [];
    for (const p of pending) {
      const v = p.lang ? bestVoice(voices, p.lang) : voice;
      if (v) this.d.speak(p.text, v, p.lang);
    }
  }

  /** Whether words still wait here: for Ember's own voice to end, or for the system's voices to load. */
  get waiting(): boolean { return this.pending.length > 0; }

  cancel(): void {
    if (this.timer !== null) this.d.clearTimer(this.timer);
    this.timer = null;
    this.pending = [];
  }
}
