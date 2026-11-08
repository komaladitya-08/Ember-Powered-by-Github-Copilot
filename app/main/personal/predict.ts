/**
 * What the user might say next (docs/ASSISTANT.md "Personalisation"): two or three short requests that usually follow
 * what just happened ("Close it" after Ember opened something, "Read it out" after an answer it didn't say aloud,
 * "Do the same for the next one" after a task on one item), from the last request and reply, the task's outcome, the
 * time of day, this session's requests and, with memory in force, the names the user told Ember to remember. Shown as
 * chips under the bubble and in the Ask box, marked as Ember's suggestions: choosing one is the same as typing it, so
 * the usual policy applies and nothing runs on a guess.
 *
 * Local rules only, no model: nothing leaves the computer to make them. Never anything risky (send, delete, pay…:
 * policy's own words) unless the user's own last words were about it.
 */

/** What the predictions are made from. */
export interface PredictInput {
  /** The user's last request, in their own words (typed or heard). */
  lastRequest: string;
  /**
   * `lastRequest` is the user's own words (typed, or heard where Ember can tell the speakers from the user). False for
   * one heard where it can't tell, or a suggestion the user chose: that request is Ember's or the room's, and never
   * authorises a risky suggestion ("Send it to Priya" after a heard "Send it to Alice"). Absent counts as not own.
   */
  lastRequestOwn?: boolean;
  /** Ember's reply to it (plain text), "" while none came. */
  lastReply: string;
  /** The reply was spoken aloud. */
  spoken: boolean;
  /** A task the request started, when one did, and how it went. */
  task?: { status: "done" | "failed" | "stopped" | "running"; app?: string } | null;
  /**
   * This session's requests, oldest first (in memory only), without any heard where Ember can't tell the user from its
   * speakers or chosen from a suggestion (PersonalVoice keeps those out).
   */
  history: readonly string[];
  /** The hour now (0–23). */
  hour: number;
  /** People's names from memory's `user` facts, while memory is in force (empty otherwise). */
  people: readonly string[];
}

/**
 * A suggestion: its words, as the user would say them. `follows`: it answers or follows the reply it was made for
 * ("Yes, please" to its offer, "Close it", "Read it out"), so it means something only while that reply shows
 * (askSuggestions, companion-c2-2); without it, it stands on its own (a request said twice, the time of day's).
 */
export interface Suggestion { text: string; follows?: true }

/** At most this many (the bubble's row holds three short ones). */
export const MAX_SUGGESTIONS = 3;
/** A suggestion longer than this (characters) isn't shown: a chip is a short request. */
const MAX_CHARS = 32;

const said = (s: string) => s.toLowerCase().replace(/[’]/g, "'");

/** The predictions for `p`, best first. `risky` says whether words are about something risky (policy's isRiskyLabel). */
export function predictNext(p: PredictInput, risky: (words: string) => boolean): Suggestion[] {
  const out: string[] = [];
  /** The ones built from the last request itself (only those may be risky, when it was: "Send it to Priya"). */
  const fromRequest = new Set<string>();
  /** The ones that follow the last reply (Suggestion.follows). */
  const following = new Set<string>();
  const add = (t: string, own = false, follows = false) => {
    if (!t || t.length > MAX_CHARS || out.some(o => o.toLowerCase() === t.toLowerCase())) return;
    out.push(t);
    if (own) fromRequest.add(t);
    if (follows) following.add(t);
  };
  const req = said(p.lastRequest), reply = said(p.lastReply);
  const asked = /\?\s*$/.test(p.lastReply.trim());

  // Ember asked something: the two plain answers.
  if (asked) { add("Yes, please", false, true); add("No, thanks", false, true); }
  // Something was opened or shown: closing it is the usual next step.
  if (/\b(open|show|launch|start|bring up|pull up)\b/.test(req) && (!p.task || p.task.status === "done")) add("Close it", false, true);
  // Turned something on: off again later.
  const on = /\bturn (?:on|up) (?:the )?([a-z][a-z ]{1,20}?)(?:[.!?]|$)/.exec(req) ?? /\bturn (?:the )?([a-z][a-z ]{1,20}?) on\b/.exec(req);
  if (on) add(`Turn ${on[1].trim()} off`);
  // A task on one item (the first email, this file, the next page…): the same again.
  if (p.task?.status === "done" && /\b(this|the first|the top|the last|the next|that) (one|email|mail|message|file|page|row|item|document|photo|tab|line)\b/.test(req)) add("Do the same for the next one", false, true);
  // A failed task: why, in a word.
  if (p.task?.status === "failed") add("What went wrong?", false, true);
  // An answer with something to it that wasn't said aloud.
  if (!p.spoken && p.lastReply.trim().length > 60 && !asked) add("Read it out", false, true);
  // Sending, only after the user's own words were about sending: to someone they told Ember about.
  const own = p.lastRequestOwn === true;
  if (own && /\b(send|email|mail|message|forward|share)\b/.test(req) && risky(p.lastRequest)) {
    const who = p.people.find(n => !req.includes(said(n)) && /^[\p{Lu}]/u.test(n));
    if (who) add(`Send it to ${who}`, true, true);
  }
  // Said twice this session: likely again.
  const counts = new Map<string, { n: number; text: string }>();
  for (const h of p.history) {
    // A risky request is never repeated on a guess, whatever was asked last.
    if (risky(h)) continue;
    const k = said(h).trim().replace(/[.!?]+$/, "");
    if (k.length < 4 || k === req.trim().replace(/[.!?]+$/, "")) continue;
    const c = counts.get(k) ?? { n: 0, text: h.trim().replace(/[.!?]+$/, "") };
    c.n++;
    counts.set(k, c);
  }
  for (const c of [...counts.values()].filter(c => c.n >= 2).sort((a, b) => b.n - a.n)) add(c.text.charAt(0).toUpperCase() + c.text.slice(1));
  // Nothing better: what this time of day usually brings.
  if (out.length < 2) {
    if (p.hour >= 5 && p.hour < 11) add("What's on today?");
    else if (p.hour >= 17 && p.hour < 23) add("Turn on night light");
    if (!reply.includes("remind")) add("Remind me in an hour");
  }
  // Never a risky step, but one built from the user's own risky request just now.
  const userRisky = own && risky(p.lastRequest);
  return out.filter(t => !risky(t) || (userRisky && fromRequest.has(t))).slice(0, MAX_SUGGESTIONS).map(text => (following.has(text) ? { text, follows: true } : { text }));
}

/**
 * How long the follow-up window stays open after a spoken reply (ms): VoiceService's usual 8 s, and 12 s when Ember
 * asked something (it expects an answer, as the microphone's consent text says).
 */
export function followUpMs(p: Pick<PredictInput, "lastReply">): number {
  return /\?\s*$/.test(p.lastReply.trim()) ? 12_000 : 8000;
}
