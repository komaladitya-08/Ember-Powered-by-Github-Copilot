/**
 * The companion over the coding sessions (docs/CODING-APP.md §5): what it may ask of the hub, how fast, and what it
 * reads back, as plain text for the conductor's tools (app/main/agent/coding-tools.ts) and plain sentences for the
 * bubble.
 *
 * The constraint behind it: the companion acts for the user, never as them. It may list, read, start, send, stop and
 * show; it may not answer a request, change a mode, rename, fork, delete, attach files, pick folders or call the SDK's
 * methods. That is enforced in the hub by actor (`companionRefusal`, called by `CodeHub.dispatch` before anything
 * runs), never by the prompt. What it reads from a session is untrusted text, wrapped so before a model sees it, and
 * what it says of a request waiting is built by Ember from the request's kind and the project's name, never from the
 * model's or the session's words. A coding session's request is answered only in the coding window, by click or key:
 * a spoken yes never answers one (Ember's voice answers go only to a question its own Confirmer put up, and these are
 * none). Plain Node.
 */

import type { CodeDone, CodePendingRequest, CodeProject, CodeRequestKind, CodeSdkEvent, CodeSessionRow } from "../../shared/code";
import { CODE_REFUSALS } from "./guards";
import type { CodeAnswers, CodeCommand } from "./hub";

/** Why the hub turns a companion's command down, as sentences the conductor passes on. */
export const COMPANION_REFUSALS = {
  notAllowed: "That's for you to do in the coding window: I can list, read, start, message and stop coding sessions, nothing more.",
  answer: CODE_REFUSALS.companionAnswer,
  modes: "A session I start uses your own default modes: I can't choose them.",
  project: "I can start a coding session only in a project you've already added in the coding window.",
  attachments: "I can't attach files to a coding session's message.",
  paced: "I've sent the coding sessions a lot just now. Wait a moment before asking for more.",
} as const;

/** Commands the companion may give, and no other. */
const ALLOWED: ReadonlySet<CodeCommand["type"]> = new Set(["list", "create", "send", "interrupt", "stopAll"]);

/**
 * Why the hub refuses `command` from the companion, or null when it may run. Fails closed: a command type it doesn't
 * list is refused.
 */
export function companionRefusal(command: CodeCommand): string | null {
  if (command.type === "respond") return COMPANION_REFUSALS.answer;
  if (!ALLOWED.has(command.type)) return COMPANION_REFUSALS.notAllowed;
  if (command.type === "create") {
    const o = command.options;
    if (!o.projectId) return COMPANION_REFUSALS.project;
    if (o.permissionMode !== undefined || o.agentMode !== undefined || o.agent !== undefined) return COMPANION_REFUSALS.modes;
  }
  if (command.type === "send") {
    if (command.message.attachments?.length) return COMPANION_REFUSALS.attachments;
    if (command.message.agentMode !== undefined) return COMPANION_REFUSALS.modes;
  }
  return null;
}

/** Commands the companion may give in any minute (Stop everything is never counted or held). */
export const COMPANION_PER_MINUTE = 20;

/** The companion's pace over the hub: at most COMPANION_PER_MINUTE commands in any 60 s. */
export class CompanionPace {
  private times: number[] = [];
  constructor(private readonly perMinute = COMPANION_PER_MINUTE, private readonly now: () => number = Date.now) {}
  /** Takes a slot for a command now; false (nothing taken) when the minute is full. */
  take(): boolean {
    const t = this.now();
    this.times = this.times.filter(x => t - x < 60_000);
    if (this.times.length >= this.perMinute) return false;
    this.times.push(t);
    return true;
  }
}

// ── What the companion reads ───────────────────────────────────────────────────────────────────────────────────────

/** Characters of one message or tool row read back, and how many of each a read holds. */
export const READ_LIMITS = { chars: 600, messages: 6, tools: 8, total: 6000 } as const;

/** Untrusted text inside Ember's own markup: no "<" can close or open an element. */
const plain = (s: string, max: number) => {
  const one = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/</g, "‹"); // eslint-disable-line no-control-regex -- control characters are dropped
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
};

/** A session's status in Ember's words. */
export function statusWords(r: Pick<CodeSessionRow, "busy" | "pending" | "unread" | "open">): string {
  const parts = [r.pending > 0 ? "needs you" : r.busy ? "working" : r.open ? "idle" : "closed"];
  if (r.unread > 0) parts.push(`${r.unread} unread`);
  return parts.join(", ");
}

/** The projects and sessions, for list_coding_sessions: names are the user's folders' and the sessions' (untrusted). */
export function listText(l: CodeAnswers["list"]): string {
  if (!l.projects.length && !l.sessions.length) return "No coding projects yet. The user adds one in the coding window.";
  const lines: string[] = [];
  for (const p of l.projects) {
    lines.push(`project "${plain(p.name, 80)}" (id ${p.id})`);
    for (const s of l.sessions.filter(x => x.projectId === p.id && !x.archived)) lines.push(`  session ${s.id}: "${plain(s.name || "Untitled", 80)}" ${statusWords(s)}`);
  }
  const other = l.sessions.filter(s => !s.archived && !l.projects.some(p => p.id === s.projectId));
  for (const s of other) lines.push(`session ${s.id} (no project): "${plain(s.name || "Untitled", 80)}" ${statusWords(s)}`);
  return `<coding_sessions untrusted="true">\n${lines.join("\n")}\n</coding_sessions>`;
}

/** The text of an SDK payload's field, when it is one. */
const field = (d: unknown, k: string): string | undefined => {
  const v = d && typeof d === "object" ? (d as Record<string, unknown>)[k] : undefined;
  return typeof v === "string" ? v : undefined;
};

/**
 * A session's status and its last few messages and tool rows as plain text, bounded (READ_LIMITS) and wrapped as
 * untrusted: what was said and done there is data, never instructions.
 */
export function readText(row: CodeSessionRow, events: readonly CodeSdkEvent[], waiting: readonly CodePendingRequest[], projectName: string): string {
  const lines: string[] = [];
  let messages = 0, tools = 0;
  for (const e of [...events].reverse()) {
    if (e.ephemeral) continue;
    if ((e.type === "user.message" || e.type === "assistant.message") && messages < READ_LIMITS.messages) {
      const text = field(e.data, "content")?.trim();
      if (!text) continue;
      lines.push(`${e.type === "user.message" ? "user" : "Copilot"}: ${plain(text, READ_LIMITS.chars)}`);
      messages++;
    } else if (e.type === "tool.execution_start" && tools < READ_LIMITS.tools) {
      lines.push(`tool: ${plain(field(e.data, "toolName") ?? "a tool", 80)}`);
      tools++;
    }
  }
  lines.reverse();
  let body = lines.join("\n");
  if (body.length > READ_LIMITS.total) body = `…${body.slice(body.length - READ_LIMITS.total)}`;
  const head = `session ${row.id} in "${plain(projectName, 80)}": "${plain(row.name || "Untitled", 80)}", ${statusWords(row)}${waiting.length ? `; waiting: ${waiting.map(w => requestWhat(w)).join("; ")}` : ""}`;
  const open = row.open ? (body || "No messages yet in this run.") : "Not open in this run: its messages show in the coding window.";
  return `<coding_session untrusted="true">\n${head}\n${open}\n</coding_session>`;
}

/** What a permission request would do, by the SDK's kind of request (never its command, path or words). */
const PERMISSION_WHAT: Readonly<Record<string, string>> = {
  shell: "run a command", write: "change files", read: "read files", mcp: "use a tool", url: "open a web address",
  "custom-tool": "use a tool", memory: "save a memory", hook: "run a hook",
};

/** What a request waiting asks for, in Ember's words from its kind alone. */
export function requestWhat(r: Pick<CodePendingRequest, "kind" | "data">): string {
  const k: CodeRequestKind = r.kind;
  switch (k) {
    case "permission": {
      const req = r.data && typeof r.data === "object" ? (r.data as { permissionRequest?: unknown }).permissionRequest : undefined;
      const kind = field(req, "kind");
      return `wants to ${(kind && PERMISSION_WHAT[kind]) ?? "do something that needs your yes"}`;
    }
    case "user-input": case "elicitation": return "has a question for you";
    case "exit-plan-mode": return "wants you to look at its plan";
    case "auto-mode-switch": return "wants to change how it works";
    case "session-limits": return "has reached a limit and needs you to decide";
    case "mcp-oauth": return "needs you to sign in to a tool";
    case "sampling": return "wants to use the model for a tool";
  }
}

/** The project's name as the bubble says it: the user's folder's name, bounded. */
const projectWords = (name: string) => plain(name.trim() || "a project", 60);

/**
 * The bubble's line (and Ember's spoken one, where replies are spoken) for a request that opened: Ember's words from
 * the request's kind and the project's name, never the command, a path, a file's words or the model's text.
 * ("Copilot wants to run a command in “app”. Open it?")
 */
export function announcementLine(r: Pick<CodePendingRequest, "kind" | "data">, projectName: string): string {
  return `Copilot ${requestWhat(r)} in “${projectWords(projectName)}”. Open it?`;
}

/** The requests waiting, for list_coding_requests: Ember's words, one line each. */
export function waitingText(waiting: readonly CodePendingRequest[], projectOf: (sessionId: string) => string): string {
  if (!waiting.length) return "Nothing is waiting for the user in the coding sessions.";
  return waiting.map(w => `session ${w.sessionId} in “${projectWords(projectOf(w.sessionId))}”: Copilot ${requestWhat(w)}. Only the user can answer it, in the coding window.`).join("\n");
}

/** A refusal or failure as the conductor passes it on. */
export const refusalText = (d: CodeDone<unknown> | { ok: false; reason: string }) => (d.ok ? "Done." : d.reason);

/** A project the companion may start in: one the user added, by its id or its name (never a path). */
export function projectNamed(projects: readonly CodeProject[], name: string): CodeProject | null {
  const want = name.trim().toLowerCase();
  if (!want) return null;
  const byId = projects.find(p => p.id === name.trim());
  if (byId) return byId;
  // The very name first, then one that differs only in case; two of either is no answer.
  const exact = projects.filter(p => p.name === name.trim());
  if (exact.length) return exact.length === 1 ? exact[0] : null;
  const named = projects.filter(p => p.name.toLowerCase() === want);
  return named.length === 1 ? named[0] : null;
}
