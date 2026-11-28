/**
 * The words of Customise › Storage and of a session's export and handoff (docs/CODING-APP.md §8). Pure, sentence case,
 * British spelling. Pinned in test/unit/code-storage.test.ts.
 */

export const STORAGE_SECTION = "Storage";
export const SIZES = "Sessions on this computer";
export const SIZES_EMPTY = "No sessions are kept on this computer.";
export const PRUNE = "Delete old sessions";
export const PRUNE_LEAD = "Deletes sessions you haven't used for a while, with their history and any worktree Ember made for them. Open and pinned sessions are kept.";
export const PRUNE_DAYS = "Not used for (days)";
export const PRUNE_DAYS_HINT = "A whole number of days, from 1 to 3650.";
export const PRUNE_FIND = "Find old sessions";
export const PRUNE_NONE = "No sessions are that old.";

/** A size in bytes, as people say it. */
export function bytesWords(n: number): string {
  if (n < 1024) return `${n} bytes`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v >= 10 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}
const sessions = (n: number) => (n === 1 ? "1 session" : `${n} sessions`);
export function pruneFound(n: number, size: string): string { return `${sessions(n)} not used for that long, taking ${size}:`; }
export function pruneYes(n: number): string { return `Delete ${sessions(n)}`; }
export function pruneQuestion(n: number, size: string): string { return `Delete ${sessions(n)} and ${n === 1 ? "its" : "their"} history (${size})? This can't be undone.`; }
export function pruneDeleted(n: number, size: string): string { return `Deleted ${sessions(n)}, freeing ${size}.`; }

export const EXPORT_ACTION = "Export this session…";
export const EXPORTED = "Saved the session's transcript.";
export const HANDOFF_ACTION = "New session from this one's summary";
export const HANDOFF_WORKING = "Summarising this session…";
/** The draft a handoff leaves in the new session's message box: Ember's line, then Copilot's summary, to send or edit. */
export function handoffDraft(summary: string): string { return `Carry on from this summary of an earlier session:\n\n${summary.trim()}`; }
