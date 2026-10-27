/**
 * What the handle says in its live region, which a screen reader reads once per change: pure, so it is unit-tested
 * (handle-mic.test.ts). The pill says only news about the microphone; the no-compositor card, where nothing else
 * speaks for Ember, also says the bubble's words and the status line.
 */

import { announcement } from "@ember/bubble";
import type { BubbleState } from "../../shared/overlay";
import type { MicState } from "../../shared/voice";
import { micAnnouncement } from "../../shared/mic";

/**
 * States the microphone passes through on its way somewhere (starting to listen, fetching the speech models): no news
 * themselves, and what was said before them isn't news again after them. So a problem that comes back at each of
 * Ember's retries (error, starting, error…) is said once, and again only once listening has worked in between.
 */
const PASSING: ReadonlySet<MicState> = new Set(["starting", "downloading"]);

export class HandleLive {
  /** The bubble's words last said: what was said while the card showed nothing new isn't repeated when it shows again. */
  private announced = "";
  /** The status line last said. */
  private announcedStatus = "";
  /** Whether a microphone state came before: the first one is only what it was, no news. */
  private seenMic = false;
  /** The microphone state last settled in (never a passing one): a change to one the user must know about is said once. */
  private settledMic: MicState | undefined | null = null;
  /** The microphone's news last said, until the status line next changes (main often puts the same words there). */
  private micSaid: string | null = null;

  constructor(private readonly name: string) {}

  /** What to say about the microphone with this update (a change to a problem, voice not set up, muted), or null. */
  micNews(mic: MicState | undefined): string | null {
    const first = !this.seenMic;
    this.seenMic = true;
    if (mic && PASSING.has(mic)) return null;
    const was = this.settledMic;
    this.settledMic = mic;
    return first || mic === was ? null : micAnnouncement(mic);
  }

  /**
   * The card's live text for this update, or null when nothing new is said: the bubble's words, the status line ("Using
   * your mouse: move it to take over", "I only caught the first part…"), which the card shows even under a bubble, and
   * news about the microphone. All at once go out together (one live update).
   */
  card(b: BubbleState, status: string | null, micNews: string | null): string | null {
    const parts: string[] = [];
    if (b.visible) {
      const text = announcement({ visible: true, mood: b.mood, title: b.title, thought: b.thought, streaming: b.streaming }, this.name);
      if (text && text !== this.announced) { this.announced = text; parts.push(text); }
    }
    if ((status ?? "") !== this.announcedStatus) {
      this.announcedStatus = status ?? "";
      // Muting by the shortcut or the menu: the microphone's news said "Microphone off", then the status line says it
      // too. Once is enough.
      if (status && status !== this.micSaid) parts.push(status);
      this.micSaid = null;
    }
    // And the other way round: the status line already says it.
    if (micNews && micNews !== this.announcedStatus) { parts.push(micNews); this.micSaid = micNews; }
    return parts.length ? parts.join(" ") : null;
  }
}
