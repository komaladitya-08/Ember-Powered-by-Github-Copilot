/**
 * The row of Ember's answer while it is still being written (pure, so it is unit-tested: home-conversation-stream.test.ts).
 * Home shows it as one row that grows in place; the transcript entry that holds that answer (finished, or stopped short
 * and kept by the host as a `stopped` entry) settles it. The two are matched by identity: main puts the stream's `id` on
 * that entry as `answerId`. Never by position or by words, so a reminder, a problem, an earlier answer in a late snapshot
 * or the 60-message trim cannot settle or duplicate it. An answer with no entry (it ended with `done`, or was blank) is
 * settled by `done`. Once an answer ended, a late word of it is ignored (ids only grow); a forgotten or new conversation
 * clears everything.
 */
import type { Said } from "./conversation-view";

/** What main tells Home (host.ts AnswerStream). */
export interface StreamEvent { id: number; text: string; state: "streaming" | "done" | "interrupted" }

/** An answer being written, or stopped short while its stopped entry has not arrived. */
export interface StreamRow { id: number; text: string; phase: "streaming" | "interrupted"; t: string }
export interface StreamState { row: StreamRow | null; closed: number }

export const NO_STREAM: StreamState = { row: null, closed: 0 };

/** Words shown after an answer that stopped short. */
export const STOPPED_NOTE = "Stopped before it finished";

const held = (entries: readonly Said[], id: number) => entries.some(e => e.who === "ember" && e.answerId === id);

/** An event from main, with the messages now in the conversation. */
export function streamEvent(s: StreamState, e: StreamEvent, entries: readonly Said[], now: string): StreamState {
  if (e.id <= s.closed) return s;
  const row = s.row && s.row.id === e.id ? s.row : null;
  if (e.state === "done") return { row: s.row?.id === e.id ? null : s.row, closed: e.id };
  if (e.state === "interrupted") {
    // (Its stopped entry is in the transcript already, or the words are blank: nothing to bridge.)
    if (!e.text.trim() || held(entries, e.id)) return { row: row ? null : s.row, closed: e.id };
    return { row: { id: e.id, text: e.text, phase: "interrupted", t: row?.t ?? now }, closed: e.id };
  }
  if (held(entries, e.id)) return { row: row ? null : s.row, closed: e.id };
  return { ...s, row: { id: e.id, text: e.text, phase: "streaming", t: row?.t ?? now } };
}

/** The conversation changed: the entry that holds the row's answer settles it; anything else leaves it. */
export function streamEntries(s: StreamState, entries: readonly Said[]): StreamState {
  if (!entries.length) return { row: null, closed: Math.max(s.closed, s.row?.id ?? 0) };
  const row = s.row;
  return row && held(entries, row.id) ? { row: null, closed: row.id } : s;
}
