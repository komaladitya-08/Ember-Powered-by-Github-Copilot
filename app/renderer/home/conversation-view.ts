/**
 * Which of the conversation's messages Home shows, and how the shown rows change when a new list comes (pure, so it is
 * unit-tested: home-conversation.test.ts). The conversation is part of the page, not a box that scrolls inside it (UI
 * audit #1): its latest CONVERSATION_SHOWN messages, or all of them once the user asked for the earlier ones. Main keeps
 * at most 60 entries, so the oldest drop off the front as new ones come: rows are matched by what they are (time, who
 * and words), never by their index, so a new message is added in place and the rows above it stay where they are (a
 * screen reader keeps its place).
 */

/**
 * Messages shown until "Show earlier messages" is pressed: the latest few, so the composer and Task activity below them
 * stay within reach (thirty put the composer about 4,200 px down a 640 px window, sixty Tab stops in: home-v2).
 */
export const CONVERSATION_SHOWN = 6;

/** A message as the list compares it. */
export interface Said { t: string; who: string; text: string; truncated?: boolean; stopped?: true; answerId?: number }

const same = (a: Said, b: Said) => a.t === b.t && a.who === b.who && a.text === b.text && !!a.truncated === !!b.truncated && !!a.stopped === !!b.stopped;

/**
 * The messages shown: the latest CONVERSATION_SHOWN, or every one once the earlier ones were asked for. `keep`: a message
 * shown now that holds the keyboard focus (its Copy or Edit), shown still with all after it though newer ones came, so
 * the focus and a screen reader's place don't drop to the page (home-c1-2: with six shown, every exchange after the third).
 */
export function conversationShown<T extends Said>(entries: readonly T[], all: boolean, keep?: Said): T[] {
  if (all) return [...entries];
  const from = Math.max(0, entries.length - CONVERSATION_SHOWN);
  let k = -1;
  if (keep) for (let i = entries.length - 1; i >= 0 && k < 0; i--) if (same(entries[i], keep)) k = i;
  return entries.slice(k >= 0 && k < from ? k : from);
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
