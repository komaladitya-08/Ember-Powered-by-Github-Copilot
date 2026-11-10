/**
 * Which of the conversation's messages Home shows, and how the shown rows change when a new list comes (pure, so it is
 * unit-tested: home-conversation.test.ts). The conversation is part of the page, not a box that scrolls inside it (UI
 * audit #1): its latest CONVERSATION_SHOWN messages, or all of them once the user asked for the earlier ones. Main keeps
 * at most 60 entries, so the oldest drop off the front as new ones come: rows are matched by what they are (time, who
 * and words), never by their index, so a new message is added in place and the rows above it stay where they are (a
 * screen reader keeps its place). The composer's words a Stop gave back above an edit are followed here through each
 * change the person makes, so Cancel edit tells them from the request being edited by where they were typed.
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

/**
 * The messages of `after` that came since `before`: those after the newest message of `before` still in it (main adds at
 * the end, drops the oldest past 60, and may restate its last Problem line in place). All of them when none is.
 */
export function conversationAdded<T extends Said>(before: readonly Said[], after: readonly T[]): T[] {
  for (let i = before.length - 1; i >= 0; i--) {
    const b = before[i];
    for (let j = after.length - 1; j >= 0; j--) if (after[j].t === b.t && after[j].who === b.who && after[j].text === b.text) return after.slice(j + 1);
  }
  return [...after];
}

/**
 * The composer's messages still without a line of their own once `added` came (home-v4-1): main writes a request's
 * line once it goes to the model, or is answered or refused, so each new line of yours takes off the oldest message
 * with its words. What is left when a Stop comes never went (home-r3-1, home-v4-2).
 */
export function stillUnsent<T extends { text: string }>(unsent: readonly T[], added: readonly Said[]): T[] {
  const left = [...unsent];
  for (const e of added) {
    if (e.who !== "you") continue;
    const i = left.findIndex(u => u.text.trim() === e.text);
    if (i >= 0) left.splice(i, 1);
  }
  return left;
}

/**
 * Words a Stop gave back above a request being edited (home-r4-1), followed through the person's changes to the
 * composer's field (home-w5-1): `given`, each message as it came, in the field's order, to tell whether the person
 * changed any; `ends`, where each of them ends in `field`, the field as last seen (after a second Edit, each of those
 * still there: home-w5-3). What is between one end and the next is that message as the person left it (blank once
 * they deleted it), and what is after the last end is the request being edited.
 */
export interface GivenBack { given: string[]; ends: number[]; field: string }

/** A blank line, or a run of them: what parts the messages from each other and from the request under them. */
const BREAK = /\n(?:[^\S\n]*\n)+/g;

/**
 * `g` once the person changed the field to `now` (home-w5-1): where each message ends moves with the change itself, so
 * what was typed into the request stays the request's and what was typed into a message the message's, never guessed
 * from the words afterwards. `caret`, where it is after a typed or pasted change, places the change where it was made
 * when the same letters repeat around it. A change under an end leaves it; one wholly above it moves it by its size; one
 * that ends at it (typed at the end of the message's own line) joins the message up to a blank line, and what follows a
 * blank line is under it; one across it leaves the message what is before the change, or up to the matching blank line
 * where the new text has one. A message deleted, line and all, stays deleted: typed where it was is what's under it
 * (home-w5-2).
 */
export function givenBackFollow(g: GivenBack, now: string, caret?: number): GivenBack {
  const was = g.field;
  if (was === now) return g;
  const most = Math.min(was.length, now.length);
  let s = 0;
  while (s < most && was[was.length - 1 - s] === now[now.length - 1 - s]) s++;
  // What follows the caret is what the change left alone (pressing Enter beside a line break: the change ends there).
  if (caret !== undefined && caret >= 0 && caret <= now.length && now.length - caret < s) s = now.length - caret;
  let p = 0;
  while (p < most - s && was[p] === now[p]) p++;
  const wasEnd = was.length - s, nowEnd = now.length - s;
  // The changed text, with any line breaks the message ended in before it: a blank line there ends the message.
  const q = now.slice(0, p).trimEnd().length;
  const breaks = [...now.slice(q, nowEnd).matchAll(BREAK)].map(m => q + (m.index ?? 0));
  const ends: number[] = [];
  g.ends.forEach((at, i) => {
    const from = i ? g.ends[i - 1] : 0;
    let end: number;
    if (p > at) end = at;
    else if (wasEnd < at) end = at + nowEnd - wasEnd;
    else if (wasEnd === at) {
      // Typed at its end: the message's own, while its line is there (its words, or the blank line under them).
      const line = was.slice(from, at).trim() !== "" || /^\n[^\S\n]*\n/.test(was.slice(at));
      end = line ? breaks[0] ?? nowEnd : p;
    } else end = breaks.length ? breaks[Math.min(was.slice(q, at).match(BREAK)?.length ?? 0, breaks.length - 1)] : p;
    ends.push(Math.min(Math.max(end, ends.at(-1) ?? 0), now.length));
  });
  return { given: g.given, ends, field: now };
}

/**
 * `words`, a Stop's messages given back above `field`'s request being edited (home-r4-1), with `g`, those given back
 * earlier and still in it as `g.field` held them before the new ones went above (null: none, or none left).
 */
export function givenBackAbove(g: GivenBack | null, words: readonly string[], field: string): GivenBack {
  const ends: number[] = [];
  for (const w of words) ends.push(ends.length ? ends[ends.length - 1] + 2 + w.length : w.length);
  if (!g) return { given: [...words], ends, field };
  const by = field.length - g.field.length;
  return { given: [...words, ...g.given], ends: [...ends, ...g.ends.map(e => e + by)], field };
}

/**
 * `g` with `request` in place of the request under it: Edit on another earlier request while they are above the one
 * being edited (home-w5-3). The messages still there stay above it as the person left them, still words given back, so
 * Cancel edit counts and names them and judges them with the draft from before Edit; null when none is left.
 */
export function givenBackOver(g: GivenBack, request: string): GivenBack | null {
  const top = g.field.slice(0, g.ends.at(-1));
  const text = top.trim(), lead = top.length - top.trimStart().length;
  if (!text) return null;
  const ends = g.ends.filter((end, i) => g.field.slice(i ? g.ends[i - 1] : 0, end).trim()).map(end => Math.min(Math.max(end - lead, 0), text.length));
  return { given: g.given, ends, field: `${text}\n\n${request}` };
}

/**
 * What Cancel edit keeps of the words given back (home-v5-1, home-w5-1, home-w5-2): what is above the request being
 * edited as the person left it, trimmed ("" once they deleted every message), never a word of that request; how many of
 * the messages are still there; and whether they changed the words of any of those (each left is one that came, in
 * order, or it was changed: so a message deleted from a field filled again at once isn't taken for a changed one).
 */
export function givenBackKept(g: GivenBack): { text: string; messages: number; changed: boolean } {
  const left = g.ends.map((end, i) => g.field.slice(i ? g.ends[i - 1] : 0, end).trim()).filter(Boolean);
  let next = 0;
  const changed = !left.every(t => { while (next < g.given.length && g.given[next] !== t) next++; return next++ < g.given.length; });
  return { text: left.length ? g.field.slice(0, g.ends.at(-1)).trim() : "", messages: left.length, changed };
}

/** "Show 1 earlier message", "Show 12 earlier messages"; null when none is hidden. */
export function earlierLabel(hidden: number): string | null {
  return hidden > 0 ? (hidden === 1 ? "Show 1 earlier message" : `Show ${hidden} earlier messages`) : null;
}
