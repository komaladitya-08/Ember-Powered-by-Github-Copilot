/**
 * Whether Ember's speech is heard at all (review #101): Chromium's speechSynthesis says nothing when the computer has no
 * voice (Linux without speech-dispatcher and a voice module, Windows or macOS without one); the utterance just never
 * starts. Each reply is watched: no start within the wait, or the synthesiser's own failure, tells main "no voice"; a
 * reply that starts (even late) tells it speech works again. A reply cut off by the next one or by a stop says nothing.
 * Pure (timers injected), so it is unit-tested; the mic page wires it to speechSynthesis.
 */

export interface SpeechWatchDeps {
  /** How long a reply may take to start before it counts as unheard (ms). */
  timeoutMs: number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  /** Speech works (true) or no voice spoke (false): told only when that changes. */
  report(ok: boolean): void;
}

/** What the page tells the watch about one reply. */
export interface WatchedUtterance {
  started(): void;
  /** The utterance's error event (SpeechSynthesisErrorEvent.error). */
  failed(error: string): void;
  /** Hushed or replaced by Ember itself. */
  cancelled(): void;
}

/** Errors that mean Ember cut the reply off itself, not that no voice could speak. */
const CUT_OFF = new Set(["interrupted", "canceled"]);

export function speechWatch(d: SpeechWatchDeps): { utterance(): WatchedUtterance } {
  let last: boolean | null = null;
  const tell = (ok: boolean) => {
    if (ok === last) return;
    last = ok;
    d.report(ok);
  };
  return {
    utterance(): WatchedUtterance {
      let settled = false;
      const timer = d.setTimer(() => { settled = true; tell(false); }, d.timeoutMs);
      const settle = (ok: boolean | null) => {
        d.clearTimer(timer);
        if (settled) return;
        settled = true;
        if (ok !== null) tell(ok);
      };
      return {
        // A late start still counts: the voice was only slow (a cold speech-dispatcher).
        started: () => { d.clearTimer(timer); settled = true; tell(true); },
        failed: error => settle(CUT_OFF.has(error) ? null : false),
        cancelled: () => settle(null),
      };
    },
  };
}
