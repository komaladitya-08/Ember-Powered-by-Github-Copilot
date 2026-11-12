/**
 * What the handle says in its live region, which a screen reader reads once per change: pure, so it is unit-tested
 * (handle-mic.test.ts, handle-live.test.ts). The pill says only news about the microphone; the no-compositor card, where
 * nothing else speaks for Ember, also says the status line, the bubble's words and, in a region of its own, a task's end.
 */

import { announcement, wholeReadNews, type BubbleView } from "@ember/bubble";
import type { MicState } from "../../shared/voice";
import { micAnnouncement } from "../../shared/mic";
import type { EmberState, TaskCard } from "../../shared/overlay";
import { taskAnnouncement } from "../home/tasks-copy";

/**
 * States the microphone passes through on its way somewhere (starting to listen, fetching the speech models): no news
 * themselves, and what was said before them isn't news again after them. So a problem that comes back at each of
 * Ember's retries (error, starting, error…) is said once, and again only once listening has worked in between.
 */
const PASSING: ReadonlySet<MicState> = new Set(["starting", "downloading"]);

/** A task's states once it has ended: news once, on the card (taskNews). */
const ENDED: ReadonlySet<TaskCard["status"]> = new Set(["done", "failed", "stopped"]);

/**
 * The microphone opens or is open for a request (a wake's window, a conversation's, Listen once's) or for Voice Match's
 * phrases: a screen reader would say a line through the speakers into what Ember hears (design-system.md "Screen
 * readers"), so the card holds a task's end meanwhile, as Home holds its own (holdTaskNews).
 */
export function micOpen(s: Pick<EmberState, "mic" | "micLearning">): boolean {
  return s.mic === "active" || s.mic === "starting" || s.micLearning === true;
}

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
   * (wholeReadNews compares the two), the last question said (its number, words and view, kept through any bubble with
   * nothing to say) and whether the bubble's words are in the region.
   */
  private announced = "";
  private announcedView: BubbleView | null = null;
  private asked: { n: number; text: string; view: BubbleView } | null = null;
  private inRegion = false;
  /** Each task's state as last said (or first seen): its end is news once. */
  private tasksSaid = new Map<string, TaskCard["status"]>();
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
   * with nothing to say, or none), so the page empties its region. A question is known by its number (`question`): each
   * new one is said, in the words of the one before too (kept from it, every command question of a task after the first
   * went unsaid: accessibility-c8-1), and the same one shown again after a cover ("Listening…") or a hide isn't, but for
   * the news that its whole text has all been shown (wholeReadNews). Anything else is said when its words differ from
   * the last said, and as the overlay's bubble does, a bubble with nothing to say ("Thinking…") forgets them.
   */
  bubble(view: BubbleView, question: number | null, speaker = "Ember"): string | null {
    const gone = (): string | null => { if (!this.inRegion) return null; this.inRegion = false; return ""; };
    // Hidden: what was said is kept (shown again, it isn't news), but its words leave the region.
    if (!view.visible) return gone();
    const text = announcement(view, speaker);
    const was = this.asked;
    let said: string;
    if (question !== null && text) {
      const same = was?.n === question;
      if (same && text === was.text) { this.announced = text; this.announcedView = view; return null; }
      said = same ? wholeReadNews(was.view, view) ?? text : text;
      this.asked = { n: question, text, view };
    } else {
      if (text === this.announced) return null;
      said = wholeReadNews(this.announcedView, view) ?? text;
    }
    this.announced = text;
    this.announcedView = view;
    if (!said) return gone();
    this.inRegion = true;
    return said;
  }

  /**
   * What the card says of tasks that ended since it last said ("Print two lines: Done"), in Home's words for a task's
   * change (taskAnnouncement), or null. Without it a task that worked in the corner ended in silence on the card, with
   * Home closed (accessibility-c8-2). One it first sees is no news. `held` (micOpen): nothing is said, and what a task
   * comes to meanwhile is said once it is let go.
   */
  taskNews(tasks: readonly TaskCard[], held: boolean): string | null {
    const said: string[] = [];
    for (const t of tasks) {
      const before = this.tasksSaid.get(t.id);
      if (held && before !== undefined) continue;
      if (before !== undefined && before !== t.status && ENDED.has(t.status)) said.push(taskAnnouncement(t.title, t.status, t.unanswered === true));
      this.tasksSaid.set(t.id, t.status);
    }
    // A card that has gone is forgotten (its id is never used again).
    for (const id of [...this.tasksSaid.keys()]) if (!tasks.some(t => t.id === id)) this.tasksSaid.delete(id);
    return said.length ? said.join(". ") : null;
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
