/**
 * The native chat session as main and Home both name it: a Copilot SDK session working in a folder of the user's
 * with the SDK's own tools and the SDK's own permission system (owner decision: "GitHub Copilot SDK first"). Its
 * modes are the SDK's (`permissions.setMode`: manual, assisted, allow-all; `mode.set`: interactive, plan, autopilot)
 * and the decisions a permission request may be answered with are the SDK's own kinds, never a vocabulary of Ember's:
 * Home shows them and main hands the chosen one back unchanged (app/main/agent/chat-permission.ts). Everything here
 * is plain, serialisable data, so a renderer imports it type-only. Pure and renderer-safe.
 */

/** The SDK's permission modes (`session.rpc.permissions.setMode`). */
export const CHAT_PERMISSION_MODES = ["manual", "assisted", "allow-all"] as const;
export type ChatPermissionMode = (typeof CHAT_PERMISSION_MODES)[number];

/** The SDK's agent modes (`session.rpc.mode.set`), independent of the permission mode. */
export const CHAT_AGENT_MODES = ["interactive", "plan", "autopilot"] as const;
export type ChatAgentMode = (typeof CHAT_AGENT_MODES)[number];

/**
 * The SDK's decisions a person may choose for a permission request, as the runtime names them. Which of them a request
 * offers is `ChatPermissionRequested.choices`; main builds the rest of the decision (the session approval's commands,
 * the URL's domain) from the request itself.
 */
export const CHAT_DECISIONS = [
  "approve-once", "approve-for-session", "approve-read-only-for-session", "approve-for-location", "approve-permanently", "reject",
] as const;
export type ChatDecisionKind = (typeof CHAT_DECISIONS)[number];

/** A person's answer to a permission request: one of the request's choices, and for a rejection what the model is told. */
export interface ChatDecision {
  kind: ChatDecisionKind;
  /** With "reject" only: the person's words to the model (at most CHAT_LIMITS.feedback characters). */
  feedback?: string;
}

/**
 * Who decided a permission request: the person, the SDK's assisted-approval judge (its recommendation was "approve"),
 * the SDK itself (its rules, a session approval, allow-all, a hook), or Ember's Stop (which rejects what is pending).
 */
export type ChatDecider = "user" | "judge" | "sdk" | "allow-all" | "stop";

/** The SDK's assisted-approval judge's note on a request (only in assisted mode). */
export interface ChatAssisted {
  recommendation: "approve" | "requireApproval" | "excluded" | "error";
  reason?: string;
  model?: string;
}

/** What a permission request is about, by the SDK's kind of request: its display fields only. */
export type ChatPermissionView =
  | { kind: "shell"; command: string; intention: string; commands: { identifier: string; readOnly: boolean }[]; paths: string[]; urls: string[]; writesFiles: boolean; warning?: string }
  | { kind: "write"; file: string; intention: string; diff: string }
  | { kind: "read"; path: string; intention: string }
  | { kind: "url"; url: string; intention: string }
  | { kind: "mcp"; server: string; tool: string; title: string; readOnly: boolean; args?: string }
  | { kind: "memory"; fact: string; subject?: string; action?: string }
  | { kind: "custom-tool"; tool: string; description: string; args?: string }
  | { kind: "hook"; tool: string; message?: string }
  | { kind: "other"; sdkKind: string };

/** The fields every event carries: the chat session it belongs to. */
interface ChatEventBase { session: string }

/** A permission request waiting for a person, with the SDK decisions this request may be answered with. */
export interface ChatPermissionRequested extends ChatEventBase {
  type: "permission-requested";
  requestId: string;
  toolCallId?: string;
  request: ChatPermissionView;
  /** Managed policy (the organisation's) requires an explicit decision: only approve-once and reject are offered. */
  managed: boolean;
  /** The tool asked to run outside the SDK's sandbox (which Ember never allows: allowBypass is false). */
  sandboxBypass?: string;
  choices: ChatDecisionKind[];
  assisted?: ChatAssisted;
  /** Some text was longer than Ember passes to a page and was cut (CHAT_LIMITS). */
  truncated: boolean;
}

/** Everything a chat session tells Home, in order (CHAT_IPC.event). */
export type ChatEvent =
  | (ChatEventBase & { type: "text-delta"; messageId: string; text: string; parentToolCallId?: string })
  | (ChatEventBase & { type: "message"; messageId: string; text: string; parentToolCallId?: string })
  | (ChatEventBase & { type: "reasoning-delta"; reasoningId: string; text: string })
  | (ChatEventBase & { type: "tool-start"; toolCallId: string; tool: string; title?: string; args?: string; parentToolCallId?: string })
  | (ChatEventBase & { type: "tool-progress"; toolCallId: string; message: string })
  | (ChatEventBase & { type: "tool-output"; toolCallId: string; text: string; stream?: string })
  | (ChatEventBase & {
    type: "tool-complete"; toolCallId: string; tool: string; success: boolean; result?: string; error?: string; exitCode?: number;
    fileEdits: { path: string; kind: string }[];
    /** Who let the call run: a person, the judge, the SDK's own rules, allow-all (no request was raised). */
    approvedBy: ChatDecider;
  })
  | ChatPermissionRequested
  /** `kind`: the SDK's kind of request; `decision`: the SDK's result kind (approved, approved-for-session, denied-…, cancelled). */
  | (ChatEventBase & { type: "permission-resolved"; requestId: string; kind: string; decision: string; by: ChatDecider })
  | (ChatEventBase & { type: "user-input-requested"; requestId: string; question: string; choices?: string[]; allowFreeform: boolean })
  | (ChatEventBase & { type: "mode-changed"; permissionMode: ChatPermissionMode; agentMode: ChatAgentMode })
  | (ChatEventBase & { type: "title-changed"; title: string })
  | (ChatEventBase & { type: "idle"; aborted: boolean })
  /** `message`: one plain sentence (friendlyError), never the SDK's own text. */
  | (ChatEventBase & { type: "error"; message: string });

/** One chat session as Home lists it. */
export interface ChatSessionRow {
  id: string;
  name: string;
  folder: string;
  permissionMode: ChatPermissionMode;
  agentMode: ChatAgentMode;
  /** A turn is under way. */
  busy: boolean;
  /** Permission requests waiting for a person. */
  pending: number;
  /** Open in this run (false: kept from an earlier run, resumable). */
  open: boolean;
}

/** The answer to a request of Home's: done, or why not in one plain sentence. */
export type ChatDone<T = undefined> = { ok: true; value: T } | { ok: false; why: string };

/** What setting a mode did: the mode the SDK says is in force now, which may not be the one asked for. */
export interface ChatModeResult<M extends string> { requested: M; mode: M; applied: boolean }

/** The most main takes from Home, and passes to it, of each kind of text. */
export const CHAT_LIMITS = {
  /** A message to the model. */
  prompt: 100_000,
  /** A session's friendly name (the SDK's own limit). */
  name: 100,
  /** A rejection's words to the model. */
  feedback: 2_000,
  /** An answer to the model's question. */
  answer: 10_000,
  /** An id main made (a session's, a request's). */
  id: 200,
  /** A diff shown for a write. */
  diff: 200_000,
  /** Any other text in an event. */
  text: 20_000,
} as const;


/** What the settings window's preload exposes (over CHAT_IPC in app/shared/ipc.ts) as `window.emberChat`. */
export interface EmberChatApi {
  list(): Promise<ChatDone<ChatSessionRow[]>>;
  create(name?: string): Promise<ChatDone<ChatSessionRow | null>>;
  resume(id: string): Promise<ChatDone<ChatSessionRow>>;
  send(id: string, text: string): Promise<ChatDone>;
  decide(id: string, requestId: string, decision: ChatDecision): Promise<ChatDone>;
  answer(id: string, requestId: string, answer: string, wasFreeform: boolean): Promise<ChatDone>;
  setPermissionMode(id: string, mode: ChatPermissionMode): Promise<ChatDone<ChatModeResult<ChatPermissionMode>>>;
  setAgentMode(id: string, mode: ChatAgentMode): Promise<ChatDone<ChatModeResult<ChatAgentMode>>>;
  stop(id: string): Promise<ChatDone>;
  onEvent(fn: (event: ChatEvent) => void): () => void;
}
