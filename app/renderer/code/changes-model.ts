/**
 * The Changes tab's logic, with no DOM: the SDK's `workspaces.diff` result read into files with their counts, line
 * comments and the one message they become, the rewind points, preview and outcome of `history.*`, and the prompts the
 * git buttons send. The SDK's results are `unknown` here (main passes them through as they are, bounded) and are
 * narrowed field by field, so a shape the SDK changes shows as nothing rather than as a broken panel. Paths are only
 * ever shown and quoted, never acted on: a review is sent as text, with no attachment built from a path
 * (docs/CODING-APP.md "Guards"). Tested in test/unit/code-changes-model.test.ts.
 */
import { diffRows, type DiffRow } from "../shared/diff-rows";
import type { CodeState } from "./store";

/** The diff's three modes, as `WorkspacesDiffRequest.mode` names them. */
export type DiffMode = "session" | "unstaged" | "branch";
export const DIFF_MODES: readonly DiffMode[] = ["session", "unstaged", "branch"];

/** Why the SDK couldn't answer from the session's own file tracking (`HistoryRewindUnavailableReason`). */
export type Unavailable = "file-change-tracking-disabled" | "session-busy" | "unsupported-remote-session" | "other";

export type FileStatus = "added" | "modified" | "deleted" | "renamed" | "other";

/** One changed file, as the tab lists it. */
export interface DiffFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  diff: string;
  /** The SDK left the diff out: it was over its per-file limit. */
  truncated: boolean;
  added: number;
  removed: number;
}

/** A diff, read. */
export interface DiffView {
  requested: DiffMode;
  /** The mode the SDK answered in (it falls back to "unstaged"). */
  mode: DiffMode;
  fallback: boolean;
  baseBranch?: string;
  unavailable?: Unavailable;
  files: DiffFile[];
  added: number;
  removed: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (o: Record<string, unknown>, k: string): string | undefined => (typeof o[k] === "string" ? o[k] as string : undefined);
const num = (o: Record<string, unknown>, k: string): number => (typeof o[k] === "number" && Number.isFinite(o[k]) ? Math.max(0, o[k] as number) : 0);
const asMode = (v: unknown, d: DiffMode): DiffMode => (DIFF_MODES.includes(v as DiffMode) ? v as DiffMode : d);

/** The SDK's reason, kept to the ones Ember has words for. */
export function unavailableOf(v: unknown): Unavailable | undefined {
  if (v === undefined || v === null) return undefined;
  return v === "file-change-tracking-disabled" || v === "session-busy" || v === "unsupported-remote-session" ? v : "other";
}

/** `WorkspaceDiffResult` read; null when it isn't one. Files keep the SDK's order (by path, as it sends them). */
export function diffFrom(value: unknown, requested: DiffMode): DiffView | null {
  if (!isObj(value) || !Array.isArray(value.changes)) return null;
  const files: DiffFile[] = [];
  for (const c of value.changes) {
    if (!isObj(c)) continue;
    const path = str(c, "path");
    if (!path) continue;
    const diff = str(c, "diff") ?? "";
    const counted = diffRows(diff, 0);
    const t = str(c, "changeType");
    const oldPath = str(c, "oldPath");
    files.push({
      path, ...(oldPath && oldPath !== path ? { oldPath } : {}),
      status: t === "added" || t === "modified" || t === "deleted" || t === "renamed" ? t : "other",
      diff, truncated: c.isTruncated === true,
      added: counted.added, removed: counted.removed,
    });
  }
  const base = str(value, "baseBranch");
  const unavailable = unavailableOf(value.unavailableReason);
  return {
    requested: asMode(value.requestedMode, requested), mode: asMode(value.mode, requested), fallback: value.isFallback === true,
    ...(base ? { baseBranch: base } : {}), ...(unavailable ? { unavailable } : {}),
    files, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0),
  };
}

/** A path as the tab shows it: relative to the session's folder when it is inside it, else as the SDK gave it. */
export function shownPath(path: string, folder: string | undefined): string {
  if (!folder) return path;
  const f = folder.replace(/[\\/]+$/, "");
  if (path.startsWith(`${f}/`) || path.startsWith(`${f}\\`)) return path.slice(f.length + 1);
  return path;
}

// ───── Line comments ─────

/** A row of a file's diff that a comment can be on (an added, removed or unchanged line). */
export const commentable = (r: DiffRow): boolean => r.kind === "add" || r.kind === "del" || r.kind === "ctx";

/** Where a comment is: the file, the lines on each side, and those lines as they read, with their signs. */
export interface LineRange {
  file: string;
  /** Lines of the new version (added and unchanged lines). */
  newLines?: [number, number];
  /** Removed lines, by their number in the old version (only removed lines: unchanged ones are on the new side). */
  oldLines?: [number, number];
  /** The lines quoted, each with "+", "-" or " " before it. */
  quoted: string[];
}

/** The range rows `a` to `b` (either order) of `rows` cover; null when none of them can take a comment. */
export function rangeOf(file: string, rows: readonly DiffRow[], a: number, b: number): LineRange | null {
  const lo = Math.max(0, Math.min(a, b)), hi = Math.min(rows.length - 1, Math.max(a, b));
  const picked = rows.slice(lo, hi + 1).filter(commentable);
  if (!picked.length) return null;
  const span = (ns: number[]): [number, number] | undefined => (ns.length ? [Math.min(...ns), Math.max(...ns)] : undefined);
  const newLines = span(picked.filter(r => r.kind !== "del" && r.newNo !== undefined).map(r => r.newNo!));
  const oldLines = span(picked.filter(r => r.kind === "del" && r.oldNo !== undefined).map(r => r.oldNo!));
  return { file, ...(newLines ? { newLines } : {}), ...(oldLines ? { oldLines } : {}), quoted: picked.map(r => `${r.kind === "add" ? "+" : r.kind === "del" ? "-" : " "}${r.text}`) };
}

/** A comment in the Review strip. */
export interface ReviewComment extends LineRange { id: string; text: string }

/** The most comments one review holds, and the characters of one comment. */
export const REVIEW_MAX = 50;
export const COMMENT_MAX = 4_000;
/** Lines quoted per comment in the message (the rest are counted). */
export const QUOTE_MAX = 40;

export function addComment(list: readonly ReviewComment[], c: ReviewComment): ReviewComment[] {
  const text = c.text.trim().slice(0, COMMENT_MAX);
  if (!text || list.length >= REVIEW_MAX) return list.slice();
  return [...list, { ...c, text }];
}
export function editComment(list: readonly ReviewComment[], id: string, text: string): ReviewComment[] {
  const t = text.trim().slice(0, COMMENT_MAX);
  return t ? list.map(c => (c.id === id ? { ...c, text: t } : c)) : list.filter(c => c.id !== id);
}
export function removeComment(list: readonly ReviewComment[], id: string): ReviewComment[] { return list.filter(c => c.id !== id); }

/** Lines in words ("lines 41–43", "line 7"). */
export function linesWords(r: Pick<LineRange, "newLines" | "oldLines">): string {
  const one = ([a, b]: [number, number], kind: string) => (a === b ? `${kind}line ${a}` : `${kind}lines ${a}–${b}`);
  const parts = [r.newLines ? one(r.newLines, "") : "", r.oldLines ? one(r.oldLines, "removed ") : ""].filter(Boolean);
  return parts.join(" and ");
}

/**
 * The review as one message to Copilot: what it is, then each comment with its file, its lines (new numbering, and
 * removed lines by the old), the lines quoted in a fenced block, and the comment. Quoted lines are the diff's own text.
 */
export function reviewPrompt(list: readonly ReviewComment[], mode: DiffMode): string {
  const of = mode === "session" ? "the changes made in this session" : mode === "unstaged" ? "the uncommitted changes" : "the changes against the base branch";
  const head = `Please address my review comments on ${of}. Each comment names a file, the lines it is about (line numbers are the new version's; removed lines use the old version's numbers) and quotes those lines from the diff. Change the code where a comment asks for it, and tell me what you changed.`;
  const blocks = list.map((c, i) => {
    const quoted = c.quoted.slice(0, QUOTE_MAX);
    const more = c.quoted.length - quoted.length;
    const fence = quoted.some(l => l.includes("```")) ? "````" : "```";
    return [
      `${i + 1}. ${c.file}, ${linesWords(c)}`,
      `${fence}diff`, ...quoted, ...(more > 0 ? [`… ${more} more ${more === 1 ? "line" : "lines"}`] : []), fence,
      `Comment: ${c.text}`,
    ].join("\n");
  });
  return [head, ...blocks].join("\n\n");
}

// ───── Rewind ─────

export interface RewindPoint {
  eventId: string;
  message: string;
  /** Milliseconds, or NaN when the SDK's timestamp doesn't read. */
  at: number;
  canRestoreFiles: boolean;
  fileCount: number;
  added: number;
  removed: number;
  turnChangedFiles: boolean;
  autopilot: boolean;
}
export interface RewindList { tracking: boolean; unavailable?: Unavailable; points: RewindPoint[] }

/** `HistoryListRewindPointsResult` read, newest first (the SDK sends them oldest first). */
export function rewindPointsFrom(value: unknown): RewindList | null {
  if (!isObj(value)) return null;
  const points: RewindPoint[] = [];
  for (const p of Array.isArray(value.points) ? value.points : []) {
    if (!isObj(p) || !str(p, "eventId")) continue;
    points.push({
      eventId: str(p, "eventId")!, message: str(p, "userMessage") ?? "", at: Date.parse(str(p, "timestamp") ?? ""),
      canRestoreFiles: p.canRestoreFiles === true, fileCount: num(p, "fileCount"), added: num(p, "linesAdded"), removed: num(p, "linesRemoved"),
      turnChangedFiles: p.turnChangedFiles === true, autopilot: p.isAutopilotContinuation === true,
    });
  }
  const unavailable = unavailableOf(value.unavailableReason);
  return { tracking: value.fileChangeTrackingEnabled === true, ...(unavailable ? { unavailable } : {}), points: points.reverse() };
}

export type ChangeKind = "created" | "deleted" | "modified" | "other";
export interface RewindPreview { available: boolean; reason?: Unavailable; files: { path: string; change: ChangeKind; added: number; removed: number }[] }

/** `HistoryPreviewRewindResult` read. */
export function previewFrom(value: unknown): RewindPreview | null {
  if (!isObj(value)) return null;
  const files: RewindPreview["files"] = [];
  for (const f of Array.isArray(value.files) ? value.files : []) {
    if (!isObj(f) || !str(f, "path")) continue;
    const c = str(f, "changeType");
    files.push({ path: str(f, "path")!, change: c === "created" || c === "deleted" || c === "modified" ? c : "other", added: num(f, "linesAdded"), removed: num(f, "linesRemoved") });
  }
  const reason = unavailableOf(value.reason);
  return { available: value.available === true, ...(reason && value.available !== true ? { reason } : {}), files };
}

export type RewindMode = "conversation" | "conversation-and-files";
export type RewindOutcome = "success" | "session-busy" | "file-change-tracking-disabled" | "unsupported-remote-session" | "files-rolled-back"
  | "rollback-incomplete" | "truncation-failed" | "checkpoint-cleanup-failed" | "snapshot-prune-failed" | "other";
export interface RewindDone { outcome: RewindOutcome; restored: string[]; skipped: { path: string; reason: "user-modified" | "skipped-capture" | "other" }[] }

const OUTCOMES: readonly RewindOutcome[] = ["success", "session-busy", "file-change-tracking-disabled", "unsupported-remote-session", "files-rolled-back", "rollback-incomplete", "truncation-failed", "checkpoint-cleanup-failed", "snapshot-prune-failed"];

/** `HistoryRewindResult` read (its `error` is the SDK's own text and is never shown). */
export function rewindResultFrom(value: unknown): RewindDone {
  if (!isObj(value)) return { outcome: "other", restored: [], skipped: [] };
  const outcome = OUTCOMES.includes(value.outcome as RewindOutcome) ? value.outcome as RewindOutcome : "other";
  const restored = (Array.isArray(value.restoredFiles) ? value.restoredFiles : []).filter((p): p is string => typeof p === "string");
  const skipped = (Array.isArray(value.skippedFiles) ? value.skippedFiles : []).filter(isObj).filter(s => !!str(s, "path"))
    .map(s => ({ path: str(s, "path")!, reason: s.reason === "user-modified" || s.reason === "skipped-capture" ? s.reason as "user-modified" | "skipped-capture" : "other" as const }));
  return { outcome, restored, skipped };
}

/** Whether the conversation was cut (the window then attaches again): every outcome but the unavailable ones and a failed cut. */
export function historyChanged(r: RewindDone): boolean {
  return r.outcome === "success" || r.outcome === "checkpoint-cleanup-failed" || r.outcome === "snapshot-prune-failed";
}

/**
 * The state with `sessionId`'s transcript marked to be drawn again from the whole kept history, as the store does for
 * `session.snapshot_rewind`: so a rewind redraws even when that event is slow to come.
 */
export function wantRebuild(s: CodeState, sessionId: string): CodeState {
  const t = s.transcripts[sessionId];
  if (!t) return s;
  return { ...s, transcripts: { ...s.transcripts, [sessionId]: { ...t, stale: true, rebuild: true } }, resync: s.resync.includes(sessionId) ? s.resync : [...s.resync, sessionId] };
}

/** Whether a turn is under way in the session (main's row or the transcript says so). */
export function busyIn(s: CodeState, sessionId: string): boolean {
  return !!(s.transcripts[sessionId]?.busy || s.sessions.byId[sessionId]?.busy);
}

// ───── Git, through Copilot ─────

/** What "Commit…" sends: with the person's message, or asking Copilot to write one. */
export function commitPrompt(message: string): string {
  const m = message.trim();
  return m
    ? `Please commit the current changes in this repository with this commit message:\n\n${m}\n\nStage what belongs in the commit first, and leave out anything that shouldn't be committed (build output, secrets). Don't push.`
    : "Please commit the current changes in this repository. Stage what belongs in the commit, leave out anything that shouldn't be committed (build output, secrets), and write a clear commit message that says what changed and why. Don't push.";
}
export const PUSH_PROMPT = "Please push the current branch to its remote. If it has no upstream yet, set one. Don't force-push.";
/** What "Open a pull request…" sends: with the person's title and notes, if they gave any. */
export function pullRequestPrompt(title: string, notes: string): string {
  const t = title.trim(), n = notes.trim();
  return [
    "Please open a pull request for the current branch: push it first if it isn't on the remote, then open the pull request against the default branch.",
    t ? `Use this title: ${t}` : "Write a short title that says what it changes.",
    n ? `Use these notes in its description:\n\n${n}` : "Write a description that says what changed, why, and how it was tested.",
    "Tell me its address when it's open.",
  ].join("\n\n");
}
