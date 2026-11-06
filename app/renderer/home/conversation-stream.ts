/**
 * The row of Ember's answer while it is still being written (pure, so it is unit-tested: home-conversation-stream.test.ts).
 * Home shows it as one row that grows in place; the transcript's finished answer settles it, so an answer is never
 * there twice. An answer stopped short (Stop, a problem) is kept by the host as a `stopped` transcript entry, so a reopened
 * Home shows it too; the row only bridges until that entry arrives. Answers are told apart by `id` (it only grows): once
 * an answer ended, a late word of it is ignored, and a forgotten or new conversation clears everything.
 */
import type { Said } from "./conversation-view";

/** What main tells Home (host.ts AnswerStream). */
export interface StreamEvent { id: number; text: string; state: "streaming" | "done" | "interrupted" }

/** An answer being written, or stopped short while it is still the last thing said. */
export interface StreamRow { id: number; text: string; phase: "streaming" | "interrupted"; t: string; base: number; embers: number }
export interface StreamState { row: StreamRow | null; closed: number }

export const NO_STREAM: StreamState = { row: null, closed: 0 };

/** Words shown after an answer that stopped short. */
export const STOPPED_NOTE = "Stopped before it finished";

const emberCount = (entries: readonly Said[]) => entries.filter(e => e.who === "ember").length;
const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/** Whether `entry` is this partial answer, finished or committed by main. */
function isSame(partial: string, entryText: string): boolean {
  const a = squash(partial), b = squash(entryText);
  return !!a && (b.startsWith(a) || a.startsWith(b));
}

/** An event from main, with the messages now in the conversation. */
export function streamEvent(s: StreamState, e: StreamEvent, entries: readonly Said[], now: string): StreamState {
  if (e.id <= s.closed) return s;
  if (e.state === "done") return { ...s, row: s.row?.id === e.id || !s.row ? null : s.row, closed: e.id };
  const row = s.row && s.row.id === e.id ? s.row : null;
  if (e.state === "interrupted") {
    if (!e.text.trim()) return { ...s, row: row ? null : s.row, closed: e.id };
    // (The stopped entry is already in the transcript: nothing to bridge.)
    // (A reopened Home gets the snapshot first: with no row of ours, a stopped entry with these words anywhere is it.)
    if (entries.slice(row?.base ?? 0).some(x => x.who === "ember" && (row || x.stopped) && isSame(e.text, x.text))) return { ...s, row: null, closed: e.id };
    const base = row?.base ?? entries.length;
    return { ...s, row: { id: e.id, text: e.text, phase: "interrupted", t: row?.t ?? now, base, embers: row?.embers ?? emberCount(entries) }, closed: e.id };
  }
  return { ...s, row: { id: e.id, text: e.text, phase: "streaming", t: row?.t ?? now, base: row?.base ?? entries.length, embers: row?.embers ?? emberCount(entries) } };
}

/** The conversation changed: an answer (finished, or the stopped entry) that came settles its row; none, it stays. */
export function streamEntries(s: StreamState, entries: readonly Said[]): StreamState {
  if (!entries.length) return { row: null, closed: Math.max(s.closed, s.row?.id ?? 0) };
  const row = s.row;
  if (!row) return s;
  if (row.phase === "streaming") {
    return entries.slice(row.base).some(e => e.who === "ember") && emberCount(entries) > row.embers ? { row: null, closed: row.id } : s;
  }
  return entries.slice(row.base).some(e => e.who === "ember" && isSame(row.text, e.text)) ? { row: null, closed: row.id } : s;
}
