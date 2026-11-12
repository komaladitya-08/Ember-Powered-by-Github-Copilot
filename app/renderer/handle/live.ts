/**
 * What the handle says in its live region, which a screen reader reads once per change: pure, so it is unit-tested
 * (handle-mic.test.ts, handle-live.test.ts). The pill says only news about the microphone; the no-compositor card, where
 * nothing else speaks for Ember, also says the status line and the bubble's words.
 */

import { announcement, wholeReadNews, type BubbleView } from "@ember/bubble";
import type { MicState } from "../../shared/voice";
import { micAnnouncement } from "../../shared/mic";

/**
 * States the microphone passes through on its way somewhere (starting to listen, fetching the speech models): no news
 * themselves, and what was said before them isn't news again after them. So a problem that comes back at each of
 * Ember's retries (error, starting, error…) is said once, and again only once listening has worked in between.
 */
const PASSING: ReadonlySet<MicState> = new Set(["starting", "downloading"]);

/** The question a bubble's buttons answer (their "q<n>:" ids, the Confirmer's number), or null for none. */
export function questionOf(actions: readonly { id: string }[]): number | null {
  for (const a of actions) {
    const m = /^q([1-9]\d{0,8}):/.exec(a.id);
    if (m) return Number(m[1]);
  }
  return null;
}

export class HandleLive {
  /**
   * The bubble's announcement last said on the card ("" once a bubble with nothing to say showed), what it said that from
   * (wholeReadNews compares the two), the question it was (its number, or null) and whether its words are in the region.
   */
  private announced = "";
  private announcedView: BubbleView | null = null;
  private question: number | null = null;
  private inRegion = false;
  /** The status line last said. */
  private announcedStatus = "";
  /** Whether a microphone state came before: the first one is only what it was, no news. */
  private seenMic = false;
  /** The microphone state last settled in (never a passing one): a change to one the user must know about is said once. */
  private settledMic: MicState | undefined | null = null;
  /** The microphone's news last said, until the status line next changes (main often puts the same words there). */
  private micSaid: string | null = null;

  /**
   * What the card says of the bubble with this update (no compositor: nothing else speaks for Ember): finished answers,
   * questions and problems, once (`announcement`); null for nothing new; "" when the words it said have gone (a bubble
   * with nothing to say, or none), so the page empties its region. As the overlay's bubble does, a bubble with nothing to
   * say ("Thanks! Carrying on.", "Thinking…") forgets what was said, so the next question in the same words is said
   * again, and so is another question (`question`, its number) after no bubble at all: kept from the one before, every
   * command question of a task after the first went unsaid (accessibility-c8-1). The same question shown again after a
   * hide isn't said again, and the same question with its whole text now all shown says only that news (wholeReadNews).
   */
  bubble(view: BubbleView, question: number | null, speaker = "Ember"): string | null {
    const gone = (): string | null => { if (!this.inRegion) return null; this.inRegion = false; return ""; };
    // Hidden: what was said is kept (shown again, it isn't news), but its words leave the region.
    if (!view.visible) return gone();
    const text = announcement(view, speaker);
    const fresh = question !== null && question !== this.question;
    this.question = question;
    if (!fresh && text === this.announced) return null;
    // Another question in the same words is said whole, never as the news that its text was read.
    const said = fresh ? text : wholeReadNews(this.announcedView, view) ?? text;
    this.announced = text;
    this.announcedView = view;
    if (!said) return gone();
    this.inRegion = true;
    return said;
  }

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
   * What the card says with this update besides the bubble's words: the status line when it changed ("Using your mouse:
   * move it to take over", "I only caught the first part…"), which the card shows even under a bubble, and the
   * microphone's news; the same words only once.
   */
  news(status: string | null, micNews: string | null): string[] {
    const parts: string[] = [];
    if ((status ?? "") !== this.announcedStatus) {
      this.announcedStatus = status ?? "";
      // Muting by the shortcut or the menu: the microphone's news said "Microphone off", then the status line says it
      // too. Once is enough.
      if (status && status !== this.micSaid) parts.push(status);
      this.micSaid = null;
    }
    // And the other way round: the status line already says it.
    if (micNews && micNews !== this.announcedStatus) { parts.push(micNews); this.micSaid = micNews; }
    return parts;
  }
}
