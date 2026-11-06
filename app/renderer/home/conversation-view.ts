/**
 * Which of the conversation's messages Home shows, and how the shown rows change when a new list comes (pure, so it is
 * unit-tested: home-conversation.test.ts). The conversation is part of the page, not a box that scrolls inside it (UI
 * audit #1): its latest CONVERSATION_SHOWN messages, or all of them once the user asked for the earlier ones. Main keeps
 * at most 60 entries, so the oldest drop off the front as new ones come: rows are matched by what they are (time, who
 * and words), never by their index, so a new message is added in place and the rows above it stay where they are (a
 * screen reader keeps its place).
 */

/** Messages shown until "Show earlier messages" is pressed. */
export const CONVERSATION_SHOWN = 30;

/** A message as the list compares it. */
export interface Said { t: string; who: string; text: string; truncated?: boolean; stopped?: true }

const same = (a: Said, b: Said) => a.t === b.t && a.who === b.who && a.text === b.text && !!a.truncated === !!b.truncated && !!a.stopped === !!b.stopped;

/** The messages shown: the latest CONVERSATION_SHOWN, or every one once the earlier ones were asked for. */
export function conversationShown<T extends Said>(entries: readonly T[], all: boolean): T[] {
  return all ? [...entries] : entries.slice(-CONVERSATION_SHOWN);
}

/**
 * How the rows on the page become `after`: rows to take off the top and messages to add at the end. What stays is the
 * longest run of the same messages in the same order (none, after signing out: every row goes and the new ones come).
 */
export function conversationChange<T extends Said>(before: readonly T[], after: readonly T[]): { drop: number; add: T[] } {
  for (let drop = 0; drop <= before.length; drop++) {
    const kept = before.length - drop;
    if (kept > after.length) continue;
    let ok = true;
    for (let i = 0; i < kept && ok; i++) ok = same(before[drop + i], after[i]);
    if (ok) return { drop, add: after.slice(kept) };
  }
  return { drop: before.length, add: [...after] };
}

/** "Show 1 earlier message", "Show 12 earlier messages"; null when none is hidden. */
export function earlierLabel(hidden: number): string | null {
  return hidden > 0 ? (hidden === 1 ? "Show 1 earlier message" : `Show ${hidden} earlier messages`) : null;
}
