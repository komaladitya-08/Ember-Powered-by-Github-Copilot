/**
 * The Changes tab's words: pure, in sentence case and British spelling, curly double quotes round names, "…" on what
 * opens something. Never the SDK's own text: a reason or an outcome is put in Ember's sentence here, and main's
 * refusals (already sentences) follow Ember's lead. Pinned in test/unit/code-changes-copy.test.ts.
 */
import type { ChangeKind, DiffMode, FileStatus, RewindDone, RewindMode, Unavailable } from "./changes-model";

const n = (k: number) => k.toLocaleString("en-GB");
const plural = (k: number, one: string, many: string) => `${n(k)} ${k === 1 ? one : many}`;

export const MODE_LABEL = "Show";
export const MODE_NAMES: Readonly<Record<DiffMode, string>> = { session: "This session", unstaged: "Uncommitted", branch: "Against the branch" };
export const IGNORE_WHITESPACE = "Ignore whitespace";
export const REFRESH = "Refresh";
export const REFRESHING = "Reading the changes…";
export const FILES_HEADING = "Files";

/** The line above the files: how many changed, and by how much. */
export function changesSummary(files: number, added: number, removed: number): string {
  if (!files) return "";
  return `${plural(files, "file", "files")} changed: ${plural(added, "line", "lines")} added, ${n(removed)} removed.`;
}

/** Nothing to show, by mode. */
export function noChanges(mode: DiffMode, base?: string): string {
  if (mode === "session") return "Copilot hasn't changed any files in this session yet.";
  if (mode === "unstaged") return "There are no uncommitted changes.";
  return base ? `Nothing differs from “${base}”.` : "Nothing differs from the default branch.";
}

/** Why the session's own changes can't be read (the SDK's `unavailableReason`). */
export function unavailableWords(r: Unavailable): string {
  switch (r) {
    case "file-change-tracking-disabled": return "This session didn't track its file changes from its first turn, so its own changes and rewinding files aren't available.";
    case "session-busy": return "Copilot is still working, so the session's changes can't be read yet. They show again when the turn ends.";
    case "unsupported-remote-session": return "This session runs on another computer, where its file changes aren't tracked.";
    case "other": return "The session's file changes aren't available.";
  }
}

/** Said when the SDK answered in another mode than the one asked for. */
export function fallbackWords(asked: DiffMode, shown: DiffMode, reason?: Unavailable): string {
  const why = asked === "branch" ? "Ember couldn't compare with the branch." : reason ? unavailableWords(reason) : "The session's own changes aren't available.";
  return `${why} Showing ${MODE_NAMES[shown].toLocaleLowerCase("en-GB")} changes instead.`;
}
export function againstBase(base: string): string { return `Compared with “${base}”.`; }

/** A refusal or failure to read, in Ember's words, with main's sentence after. */
export function readFailed(what: "changes" | "rewind", reason: string): string {
  return `${what === "changes" ? "Ember couldn't read the changes." : "Ember couldn't read the rewind points."} ${reason}`.trim();
}

export const STATUS_WORDS: Readonly<Record<FileStatus, string>> = { added: "Added", modified: "Changed", deleted: "Deleted", renamed: "Renamed", other: "Changed" };
/** A file's row, for a screen reader: its path, what happened to it, and its counts. */
export function fileLabel(path: string, status: FileStatus, added: number, removed: number, oldPath?: string): string {
  const was = oldPath ? `, from ${oldPath}` : "";
  return `${path}: ${STATUS_WORDS[status].toLocaleLowerCase("en-GB")}${was}, ${plural(added, "line", "lines")} added, ${n(removed)} removed`;
}
export function counts(added: number, removed: number): string { return `+${n(added)} −${n(removed)}`; }
export function renamedFrom(oldPath: string): string { return `Renamed from ${oldPath}`; }
export const DIFF_TRUNCATED = "This file's diff is too large to show here.";
export const DIFF_EMPTY = "No lines changed in this file.";
export function diffLinesLabel(path: string): string { return `Lines of ${path}. Use the arrow keys to move, Shift with them to choose a range, and Enter to comment.`; }
/** A line as a screen reader hears it. */
export function lineLabel(kind: "add" | "del" | "ctx", no: number | undefined, text: string): string {
  const what = kind === "add" ? "Added" : kind === "del" ? "Removed" : "Unchanged";
  return `${what}${no !== undefined ? `, line ${n(no)}` : ""}: ${text || "blank"}`;
}

// ───── Line comments and the review ─────
export function commentOn(lines: string): string { return `Comment on ${lines}…`; }
export function commentFormTitle(path: string, lines: string): string { return `Comment on ${path}, ${lines}`; }
export const COMMENT_LABEL = "Comment";
export const COMMENT_ADD = "Add to review";
export const COMMENT_SAVE = "Save";
export const CANCEL = "Cancel";
export const COMMENT_EDIT = "Edit";
export const COMMENT_REMOVE = "Remove";
export const COMMENT_EMPTY = "Write a comment first.";
export const REVIEW_HEADING = "Review";
export function reviewCount(k: number): string { return plural(k, "comment", "comments"); }
export const REVIEW_SEND = "Send to Copilot";
export const REVIEW_HINT = "Sends every comment as one message, with its file, its lines and the lines quoted.";
export const REVIEW_QUEUED_HINT = "Copilot is working: the review waits in the queue until the turn ends.";
export const REVIEW_FULL = "A review holds 50 comments. Send these first.";
export function commentWhere(path: string, lines: string): string { return `${path}, ${lines}`; }
export function editLabel(path: string, lines: string): string { return `Edit the comment on ${path}, ${lines}`; }
export function removeLabel(path: string, lines: string): string { return `Remove the comment on ${path}, ${lines}`; }
export const REVIEW_SENT = "Review sent to Copilot.";
export const REVIEW_QUEUED = "Review queued: Copilot reads it when the turn ends.";
export function sendFailed(reason: string): string { return `The review wasn't sent. ${reason}`.trim(); }

// ───── Git, through Copilot ─────
export const GIT_HEADING = "Git";
export const GIT_HINT = "These ask Copilot to do it: each sends a message, and Copilot asks before it runs anything, as for any command.";
export const COMMIT = "Commit…";
export const PUSH = "Push";
export const PULL_REQUEST = "Open a pull request…";
export const COMMIT_MESSAGE = "Commit message";
export const COMMIT_MESSAGE_HINT = "Leave it empty and Copilot writes one.";
export const COMMIT_SEND = "Ask Copilot to commit";
export const PR_TITLE = "Title (optional)";
export const PR_NOTES = "Notes for the description (optional)";
export const PR_SEND = "Ask Copilot to open it";
export const GIT_SENT = "Asked Copilot.";
export const GIT_QUEUED = "Queued for Copilot: it reads it when the turn ends.";

// ───── Rewind ─────
export const REWIND_HEADING = "Rewind";
export const REWIND_HINT = "Go back to before one of your messages. That message and everything after it leave the conversation.";
export const REWIND_NONE = "There's nothing to rewind to yet.";
export const REWIND_TO = "Rewind to here…";
export function rewindToLabel(when: string, message: string): string { return `Rewind to before your message of ${when}: ${message}`; }
/** When a point was, as people say it: the time today, else the day and the time. */
export function pointTime(at: number, now = Date.now()): string {
  if (!Number.isFinite(at)) return "";
  const d = new Date(at), today = new Date(now);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toDateString() === today.toDateString() ? time : `${d.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time}`;
}
export function pointChanges(files: number, added: number, removed: number): string {
  return files ? `${plural(files, "file", "files")} changed from here on, ${counts(added, removed)}` : "No files changed from here on";
}
export const POINT_AUTOPILOT = "Autopilot carried on here";
export const PREVIEWING = "Checking what would change…";
export function previewFiles(k: number): string { return k ? `Rewinding files restores ${plural(k, "file", "files")}:` : "No files would be restored."; }
export const CHANGE_WORDS: Readonly<Record<ChangeKind, string>> = { created: "Removed again (Copilot made it)", deleted: "Brought back (Copilot deleted it)", modified: "Put back as it was", other: "Put back as it was" };
export const MODE_CHOICE = "What to rewind";
export const REWIND_MODES: Readonly<Record<RewindMode, string>> = { conversation: "Conversation only", "conversation-and-files": "Conversation and files" };
export const REWIND_MODE_HINTS: Readonly<Record<RewindMode, string>> = {
  conversation: "Files stay as they are now.",
  "conversation-and-files": "Files Copilot changed go back to how they were, unless you've changed them since.",
};
export const NO_FILE_RESTORE = "Files can't be put back from this point.";
export const COMMANDS_NOT_UNDONE = "Commands Copilot already ran are not undone: anything they changed outside the files it tracked, such as installed packages, a commit or a push, stays.";
export const REWIND_CONFIRM = "Rewind";
export const REWIND_BUSY = "Stop the turn first: Ember can't rewind while Copilot is working.";
export const REWINDING = "Rewinding…";
export function rewindDone(r: RewindDone): string {
  const files = r.restored.length ? ` ${plural(r.restored.length, "file was", "files were")} put back.` : "";
  const k = r.skipped.length;
  const skipped = k ? ` ${plural(k, "file was", "files were")} left as ${k === 1 ? "it is" : "they are"}: you changed ${k === 1 ? "it" : "them"} since, or Copilot didn't keep how ${k === 1 ? "it was" : "they were"}.` : "";
  switch (r.outcome) {
    case "success": return `Rewound.${files}${skipped}`;
    case "checkpoint-cleanup-failed":
    case "snapshot-prune-failed": return `Rewound.${files}${skipped} Ember couldn't tidy away everything the session kept after that point; it does no harm.`;
    case "session-busy": return REWIND_BUSY;
    case "file-change-tracking-disabled": return unavailableWords("file-change-tracking-disabled");
    case "unsupported-remote-session": return unavailableWords("unsupported-remote-session");
    case "files-rolled-back": return "Nothing was rewound: putting the files back failed, so they were left as they were, and so was the conversation.";
    case "rollback-incomplete": return "Rewinding failed part way, and some files may not be as they were. Check the changes before you go on.";
    case "truncation-failed": return "The conversation couldn't be rewound. Nothing changed.";
    case "other": return "Ember couldn't tell whether the rewind happened. Check the conversation and the changes.";
  }
}
export function rewindFailed(reason: string): string { return `Nothing was rewound. ${reason}`.trim(); }
/** Why there is nothing to rewind to (the SDK's `unavailableReason` on the rewind points or a preview). */
export function unavailableRewind(r: Unavailable): string {
  switch (r) {
    case "session-busy": return REWIND_BUSY;
    case "file-change-tracking-disabled": return "This session didn't track its file changes from its first turn, so it can't be rewound here.";
    case "unsupported-remote-session": return "This session runs on another computer, so it can't be rewound here.";
    case "other": return "Rewinding isn't available for this session.";
  }
}
export function previewFailed(reason: string): string { return `Ember couldn't check what rewinding would change. ${reason}`.trim(); }
/** Why a message the tab sent didn't go: main's sentence is on the message itself, in the transcript. */
export const NOT_SENT_WHY = "The transcript shows why.";
export function gitFailed(reason: string): string { return `That wasn't sent to Copilot. ${reason}`.trim(); }
