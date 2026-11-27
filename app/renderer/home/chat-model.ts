/**
 * Home's native chats as a view model: the sessions main lists, and for each its transcript (the person's messages,
 * Copilot's streamed words, its reasoning, tool rows, permission cards and its own questions), built only from the
 * `ChatEvent`s main pushes (app/shared/chat.ts) and from what Home itself sent. Nothing here decides anything: a card
 * holds exactly the SDK's `choices` and becomes a record of what the SDK says was decided and by whom. Pure (no DOM,
 * no IPC), so it is unit-tested (test/unit/home-chat-model.test.ts); every change returns a new state.
 */
import type { ChatAgentMode, ChatAssisted, ChatDecider, ChatDecisionKind, ChatEvent, ChatPermissionMode, ChatPermissionView, ChatSessionRow } from "../../shared/chat";

/** How a tool row is drawn: a command with its output, a file edit with its diff, a fetch with its address, or by name. */
export type ChatToolShape = "shell" | "edit" | "fetch" | "other";

export interface ChatToolRow {
  kind: "tool";
  key: string;
  toolCallId: string;
  tool: string;
  title?: string;
  shape: ChatToolShape;
  command?: string;
  path?: string;
  url?: string;
  /** The command's output as it streamed (its last CHAT_OUTPUT_KEEP characters), then the result where none streamed. */
  output: string;
  /** Output from the start was dropped to keep the row bounded. */
  outputCut: boolean;
  progress?: string;
  state: "running" | "done" | "failed";
  exitCode?: number;
  approvedBy?: ChatDecider;
  /** The tool's own failure text (shown as its output, never as Ember's sentence). */
  error?: string;
  /** The files it changed, as the SDK listed them. */
  edits: string[];
}

export interface ChatCardRow {
  kind: "permission";
  key: string;
  requestId: string;
  toolCallId?: string;
  request: ChatPermissionView;
  choices: ChatDecisionKind[];
  managed: boolean;
  assisted?: ChatAssisted;
  sandboxBypass?: string;
  truncated: boolean;
  /** waiting: its buttons are up; sending: a decision is on its way to main; resolved: a record. */
  state: "waiting" | "sending" | "resolved";
  /** What the person chose here (the record names it), and the SDK's own result once it came. */
  chosen?: ChatDecisionKind;
  outcome?: { decision: string; by: ChatDecider };
  /** Main's plain sentence when a decision didn't go through. */
  problem?: string;
}

export interface ChatQuestionRow {
  kind: "question";
  key: string;
  requestId: string;
  question: string;
  choices?: string[];
  allowFreeform: boolean;
  state: "waiting" | "sending" | "answered" | "withdrawn";
  answer?: string;
  problem?: string;
}

export type ChatRow =
  | { kind: "you"; key: string; text: string; problem?: string }
  | { kind: "reply"; key: string; messageId: string; text: string; streaming: boolean }
  | { kind: "reasoning"; key: string; reasoningId: string; text: string }
  | ChatToolRow
  | ChatCardRow
  | ChatQuestionRow
  | { kind: "problem"; key: string; text: string }
  | { kind: "stopped"; key: string };

/** A mode change that wasn't applied: which was asked for and which is in force. */
export interface ChatModeNote { requested: string; mode: string }

export interface ChatSessionView {
  row: ChatSessionRow;
  rows: ChatRow[];
  /** Diffs a write request carried, by its tool call, so the edit's row can show what changed once the card is a record. */
  diffs: Record<string, string>;
  /** The latest refused mode change of each picker (cleared by the next one that applies). */
  notes: { permission?: ChatModeNote; agent?: ChatModeNote };
  /** Opened again this run: its earlier messages are Copilot's, not shown here. */
  resumed: boolean;
}

export interface ChatState {
  sessions: Readonly<Record<string, ChatSessionView>>;
  /** Main's order: this run's sessions, then the kept ones. */
  order: readonly string[];
  shown: string | null;
}

export const NO_CHATS: ChatState = { sessions: {}, order: [], shown: null };

/** The most rows a transcript keeps (older ones go first), and the most output a tool row keeps. */
export const CHAT_ROWS_KEEP = 400;
export const CHAT_OUTPUT_KEEP = 40_000;

const SHELL_TOOLS = new Set(["bash", "shell", "powershell", "pwsh", "run_in_terminal", "sh", "cmd"]);
const EDIT_TOOLS = new Set(["edit", "create", "write", "str_replace_editor", "str_replace", "apply_patch", "write_file", "edit_file"]);
const FETCH_TOOLS = new Set(["web_fetch", "fetch", "fetch_url"]);

/** A tool's arguments as the SDK sent them (a JSON string, capped): the fields a row shows, or nothing. */
export function toolArgs(args: string | undefined): { command?: string; path?: string; url?: string } {
  if (!args) return {};
  let parsed: unknown;
  try { parsed = JSON.parse(args); } catch { return {}; /* cut or not JSON: the row shows the tool by name */ }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const o = parsed as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const command = str(o.command), path = str(o.path) ?? str(o.file_path) ?? str(o.filePath), url = str(o.url);
  return { ...(command ? { command } : {}), ...(path ? { path } : {}), ...(url ? { url } : {}) };
}

/** How a tool is drawn, by its name and then by what it was given. */
export function toolShape(tool: string, a: { command?: string; path?: string; url?: string }): ChatToolShape {
  const t = tool.toLowerCase();
  if (SHELL_TOOLS.has(t)) return "shell";
  if (EDIT_TOOLS.has(t)) return "edit";
  if (FETCH_TOOLS.has(t)) return "fetch";
  if (a.command) return "shell";
  if (a.url) return "fetch";
  return "other";
}

/** A session row for an event about a session main hasn't listed yet (the next list fills it in). */
function placeholder(id: string): ChatSessionRow {
  return { id, name: "", folder: "", permissionMode: "manual", agentMode: "interactive", busy: false, pending: 0, open: true };
}

const blank = (row: ChatSessionRow): ChatSessionView => ({ row, rows: [], diffs: {}, notes: {}, resumed: false });

/** Requests waiting for the person in `v` (cards still up). */
export function pendingOf(v: ChatSessionView): number {
  return v.rows.filter(r => r.kind === "permission" && r.state !== "resolved").length;
}

/** The view of `id` with `fn` applied (a session not yet known is made from a placeholder row). */
function withSession(s: ChatState, id: string, fn: (v: ChatSessionView) => ChatSessionView): ChatState {
  const was = s.sessions[id] ?? blank(placeholder(id));
  const next = fn(was);
  const row = { ...next.row, pending: pendingOf(next) };
  return {
    ...s,
    sessions: { ...s.sessions, [id]: { ...next, row } },
    order: s.order.includes(id) ? s.order : [id, ...s.order],
  };
}

const keep = (rows: ChatRow[]) => (rows.length > CHAT_ROWS_KEEP ? rows.slice(rows.length - CHAT_ROWS_KEEP) : rows);

/** `rows` with the last row matching `pred` replaced by `fn` of it (or unchanged when none matches). */
function update<R extends ChatRow>(rows: ChatRow[], pred: (r: ChatRow) => r is R, fn: (r: R) => ChatRow): ChatRow[] {
  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i];
    if (pred(r)) { const out = rows.slice(); out[i] = fn(r); return out; }
  }
  return rows;
}

const isReply = (id: string) => (r: ChatRow): r is Extract<ChatRow, { kind: "reply" }> => r.kind === "reply" && r.messageId === id;
const isReasoning = (id: string) => (r: ChatRow): r is Extract<ChatRow, { kind: "reasoning" }> => r.kind === "reasoning" && r.reasoningId === id;
const isTool = (id: string) => (r: ChatRow): r is ChatToolRow => r.kind === "tool" && r.toolCallId === id;
const isCard = (id: string) => (r: ChatRow): r is ChatCardRow => r.kind === "permission" && r.requestId === id;
const isQuestion = (id: string) => (r: ChatRow): r is ChatQuestionRow => r.kind === "question" && r.requestId === id;

/** Output appended, kept to its last CHAT_OUTPUT_KEEP characters. */
function appended(row: ChatToolRow, text: string): ChatToolRow {
  const all = row.output + text;
  return all.length > CHAT_OUTPUT_KEEP ? { ...row, output: all.slice(all.length - CHAT_OUTPUT_KEEP), outputCut: true } : { ...row, output: all };
}

/** Main's list: each session's row as main says it stands, transcripts kept. */
export function chatList(s: ChatState, rows: readonly ChatSessionRow[]): ChatState {
  const sessions: Record<string, ChatSessionView> = {};
  for (const r of rows) {
    const was = s.sessions[r.id];
    const v = was ? { ...was, row: { ...r } } : blank({ ...r });
    sessions[r.id] = { ...v, row: { ...v.row, pending: Math.max(r.pending, pendingOf(v)) } };
  }
  // A session this page heard of but main's list left out is kept while its transcript holds something (its row may be
  // on its way); one with nothing in it goes.
  for (const [id, v] of Object.entries(s.sessions)) if (!sessions[id] && v.rows.length) sessions[id] = v;
  const order = [...rows.map(r => r.id), ...Object.keys(sessions).filter(id => !rows.some(r => r.id === id))];
  const shown = s.shown && sessions[s.shown] ? s.shown : null;
  return { sessions, order, shown };
}

/** A session made or opened again (create's or resume's row), shown. */
export function chatOpened(s: ChatState, row: ChatSessionRow, resumed = false): ChatState {
  const next = withSession(s, row.id, v => ({ ...v, row: { ...row }, resumed: resumed || v.resumed }));
  return { ...next, shown: row.id };
}

/** Which session is shown. */
export function chatShow(s: ChatState, id: string | null): ChatState {
  return { ...s, shown: id && s.sessions[id] ? id : null };
}

/** The person sent `text` from Home (shown at once, as their row; the turn is under way). */
export function chatSent(s: ChatState, id: string, text: string, key: string): ChatState {
  return withSession(s, id, v => ({ ...v, row: { ...v.row, busy: true }, rows: keep([...v.rows, { kind: "you", key, text }]) }));
}

/** A message that didn't go: its row says why (main's sentence) and the turn isn't under way. */
export function chatSendFailed(s: ChatState, id: string, key: string, why: string): ChatState {
  return withSession(s, id, v => ({
    ...v, row: { ...v.row, busy: false },
    rows: update(v.rows, (r): r is Extract<ChatRow, { kind: "you" }> => r.kind === "you" && r.key === key, r => ({ ...r, problem: why })),
  }));
}

/** A decision on its way to main. */
export function chatDeciding(s: ChatState, id: string, requestId: string, chosen: ChatDecisionKind): ChatState {
  return withSession(s, id, v => ({ ...v, rows: update(v.rows, isCard(requestId), r => (r.state === "resolved" ? r : { ...r, state: "sending", chosen, problem: undefined })) }));
}

/** A decision main refused: the card's buttons are up again, with main's sentence. */
export function chatDecideFailed(s: ChatState, id: string, requestId: string, why: string): ChatState {
  return withSession(s, id, v => ({ ...v, rows: update(v.rows, isCard(requestId), r => (r.state === "resolved" ? r : { ...r, state: "waiting", chosen: undefined, problem: why })) }));
}

/** An answer to the model's question on its way. */
export function chatAnswering(s: ChatState, id: string, requestId: string, answer: string): ChatState {
  return withSession(s, id, v => ({ ...v, rows: update(v.rows, isQuestion(requestId), r => (r.state === "waiting" ? { ...r, state: "sending", answer, problem: undefined } : r)) }));
}

/** Main took the answer (no event follows one: this is its record), or refused it with a sentence. */
export function chatAnswered(s: ChatState, id: string, requestId: string, why?: string): ChatState {
  return withSession(s, id, v => ({
    ...v,
    rows: update(v.rows, isQuestion(requestId), r => (r.state !== "sending" ? r : why ? { ...r, state: "waiting", answer: undefined, problem: why } : { ...r, state: "answered" })),
  }));
}

/** What setting a mode did (main's ChatModeResult): the mode in force, and a note when it isn't the one asked for. */
export function chatModeSet(s: ChatState, id: string, picker: "permission" | "agent", r: { requested: string; mode: string; applied: boolean }): ChatState {
  return withSession(s, id, v => ({
    ...v,
    row: picker === "permission" ? { ...v.row, permissionMode: r.mode as ChatPermissionMode } : { ...v.row, agentMode: r.mode as ChatAgentMode },
    notes: { ...v.notes, [picker]: r.applied ? undefined : { requested: r.requested, mode: r.mode } },
  }));
}

/** A problem in place (main's `{ok:false, why}` for something with no row of its own). */
export function chatProblem(s: ChatState, id: string, text: string, key: string): ChatState {
  return withSession(s, id, v => ({ ...v, rows: keep([...v.rows, { kind: "problem", key, text }]) }));
}

/** One of main's events. `key` names a row this event starts (unique for the page). */
export function chatEvent(s: ChatState, e: ChatEvent, key: string): ChatState {
  if (!s.sessions[e.session] && e.type === "idle") return s;
  return withSession(s, e.session, v => sessionEvent(v, e, key));
}

function sessionEvent(v: ChatSessionView, e: ChatEvent, key: string): ChatSessionView {
  switch (e.type) {
    case "text-delta": {
      if (v.rows.some(isReply(e.messageId))) return { ...v, rows: update(v.rows, isReply(e.messageId), r => ({ ...r, text: r.text + e.text })) };
      return { ...v, rows: keep([...v.rows, { kind: "reply", key, messageId: e.messageId, text: e.text, streaming: true }]) };
    }
    case "message": {
      // The whole message settles its streamed row; one with no words (a turn of tool calls only) adds nothing.
      if (v.rows.some(isReply(e.messageId))) return { ...v, rows: update(v.rows, isReply(e.messageId), r => ({ ...r, text: e.text || r.text, streaming: false })) };
      if (!e.text.trim()) return v;
      return { ...v, rows: keep([...v.rows, { kind: "reply", key, messageId: e.messageId, text: e.text, streaming: false }]) };
    }
    case "reasoning-delta": {
      if (v.rows.some(isReasoning(e.reasoningId))) return { ...v, rows: update(v.rows, isReasoning(e.reasoningId), r => ({ ...r, text: r.text + e.text })) };
      return { ...v, rows: keep([...v.rows, { kind: "reasoning", key, reasoningId: e.reasoningId, text: e.text }]) };
    }
    case "tool-start": {
      const a = toolArgs(e.args);
      const row: ChatToolRow = {
        kind: "tool", key, toolCallId: e.toolCallId, tool: e.tool, ...(e.title ? { title: e.title } : {}), shape: toolShape(e.tool, a), ...a,
        output: "", outputCut: false, state: "running", edits: [],
      };
      if (v.rows.some(isTool(e.toolCallId))) return { ...v, rows: update(v.rows, isTool(e.toolCallId), r => ({ ...row, key: r.key, output: r.output, outputCut: r.outputCut })) };
      return { ...v, rows: keep([...v.rows, row]) };
    }
    case "tool-progress": return { ...v, rows: update(v.rows, isTool(e.toolCallId), r => ({ ...r, progress: e.message })) };
    case "tool-output": return { ...v, rows: update(v.rows, isTool(e.toolCallId), r => appended(r, e.text)) };
    case "tool-complete": {
      const done = (r: ChatToolRow): ChatToolRow => {
        // A result is the command's output where none streamed (the SDK's shell sends both).
        const withResult = !r.output && e.result ? appended(r, e.result) : r;
        return {
          ...withResult, state: e.success ? "done" : "failed", approvedBy: e.approvedBy, edits: e.fileEdits.map(f => f.path),
          ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}), ...(e.error ? { error: e.error } : {}), progress: undefined,
          ...(!r.path && e.fileEdits.length === 1 ? { path: e.fileEdits[0].path } : {}),
          ...(r.shape === "other" && e.fileEdits.length ? { shape: "edit" as const } : {}),
        };
      };
      if (v.rows.some(isTool(e.toolCallId))) return { ...v, rows: update(v.rows, isTool(e.toolCallId), done) };
      const started: ChatToolRow = { kind: "tool", key, toolCallId: e.toolCallId, tool: e.tool, shape: toolShape(e.tool, {}), output: "", outputCut: false, state: "running", edits: [] };
      return { ...v, rows: keep([...v.rows, done(started)]) };
    }
    case "permission-requested": {
      if (v.rows.some(isCard(e.requestId))) return v;
      const card: ChatCardRow = {
        kind: "permission", key, requestId: e.requestId, ...(e.toolCallId ? { toolCallId: e.toolCallId } : {}), request: e.request,
        choices: [...e.choices], managed: e.managed, ...(e.assisted ? { assisted: e.assisted } : {}),
        ...(e.sandboxBypass !== undefined ? { sandboxBypass: e.sandboxBypass } : {}), truncated: e.truncated, state: "waiting",
      };
      const diffs = e.request.kind === "write" && e.toolCallId && e.request.diff ? { ...v.diffs, [e.toolCallId]: e.request.diff } : v.diffs;
      return { ...v, diffs, rows: keep([...v.rows, card]) };
    }
    case "permission-resolved": {
      // A request the SDK's judge decided never reached Home as a card: its record stands on its own. What the SDK's own
      // rules or allow-all let through is said on the tool's row instead (`approvedBy`), so the chat isn't a list of them.
      if (!v.rows.some(isCard(e.requestId))) {
        if (e.by !== "judge") return v;
        return { ...v, rows: keep([...v.rows, { kind: "permission", key, requestId: e.requestId, request: { kind: "other", sdkKind: e.kind }, choices: [], managed: false, truncated: false, state: "resolved", outcome: { decision: e.decision, by: e.by } }]) };
      }
      return { ...v, rows: update(v.rows, isCard(e.requestId), r => ({ ...r, state: "resolved", outcome: { decision: e.decision, by: e.by }, problem: undefined })) };
    }
    case "user-input-requested":
      if (v.rows.some(isQuestion(e.requestId))) return v;
      return { ...v, rows: keep([...v.rows, { kind: "question", key, requestId: e.requestId, question: e.question, ...(e.choices ? { choices: [...e.choices] } : {}), allowFreeform: e.allowFreeform, state: "waiting" }]) };
    case "mode-changed": return { ...v, row: { ...v.row, permissionMode: e.permissionMode, agentMode: e.agentMode } };
    case "title-changed": return { ...v, row: { ...v.row, name: e.title } };
    case "idle": {
      // The turn ended: streamed words settle, and a question still up was withdrawn with it (Stop withdraws them).
      const rows = v.rows.map(r => (r.kind === "reply" && r.streaming ? { ...r, streaming: false }
        : r.kind === "question" && (r.state === "waiting" || r.state === "sending") && e.aborted ? { ...r, state: "withdrawn" as const } : r));
      return { ...v, row: { ...v.row, busy: false }, rows: e.aborted ? keep([...rows, { kind: "stopped", key }]) : rows };
    }
    case "error": return { ...v, rows: keep([...v.rows, { kind: "problem", key, text: e.message }]) };
    default: return v;
  }
}

/** The diff an edit row shows: the one its write request carried. */
export function diffFor(v: ChatSessionView, row: ChatToolRow): string | undefined {
  return v.diffs[row.toolCallId];
}

/** The sessions as the list shows them, in main's order. */
export function chatRowsInOrder(s: ChatState): ChatSessionRow[] {
  return s.order.map(id => s.sessions[id]?.row).filter((r): r is ChatSessionRow => !!r);
}
