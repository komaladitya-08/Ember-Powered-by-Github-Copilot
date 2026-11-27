/**
 * The contract between main and the coding window (docs/CODING-APP.md): Ember as a coding agent on the GitHub
 * Copilot SDK. Main owns every SDK session; the window sees ids and plain data only.
 *
 * The constraint behind its shape: the SDK has about 145 event types and 500 RPC methods, and it changes faster
 * than Ember. So main does not translate them into types of its own, which is how features get lost. It passes
 * each SDK event through as it is (redacted and bounded), numbered per session so a window can catch up, and it
 * lets the window call the SDK's RPC methods by name through one allow-list (`CODE_RPC`). What a transcript, a
 * plan or a diff looks like is decided by pure reducers in the renderer, from those events.
 *
 * Nothing here imports the SDK: its payloads are `unknown` and are narrowed where they are read.
 */

/** Who asked for a command: the person at the window, the optional companion acting for them, or Ember itself. */
export type CodeActor = "user" | "companion" | "system";

/** The SDK's permission modes, as they are. */
export type CodePermissionMode = "manual" | "assisted" | "allow-all";
/** The SDK's agent modes, as they are. */
export type CodeAgentMode = "interactive" | "plan" | "autopilot";

/** Where a session's files are: the folder itself, or a git worktree Ember made for the session. */
export type CodeIsolation = "folder" | "worktree";

/** One SDK event, as the runtime sent it. `data` is the SDK's own payload for `type`. */
export interface CodeSdkEvent {
  id: string;
  parentId?: string | null;
  timestamp: string;
  type: string;
  data: unknown;
  /** The sub-agent this event belongs to, when not the main agent. */
  agentId?: string;
  /** True for events the SDK does not keep: they are never replayed. */
  ephemeral?: boolean;
  /** Set by main when it cut long strings in `data` to fit CODE_LIMITS.eventData (each cut string ends "…"). */
  truncated?: boolean;
}

/** An event on its way to a window. `seq` counts up by one per session; a gap means: attach again. */
export interface CodeEventEnvelope {
  sessionId: string;
  seq: number;
  event: CodeSdkEvent;
}

/** What blocks a session until somebody answers it. The names follow the SDK's `*.requested` events. */
export type CodeRequestKind =
  | "permission"
  | "user-input"
  | "elicitation"
  | "exit-plan-mode"
  | "auto-mode-switch"
  | "session-limits"
  | "mcp-oauth"
  | "sampling";

/** A request still waiting for its answer. Replayed to a window that attaches. */
export interface CodePendingRequest {
  sessionId: string;
  requestId: string;
  kind: CodeRequestKind;
  /** The SDK's `data` of the `*.requested` event, redacted and bounded. */
  data: unknown;
  /** For a permission request: the decisions the SDK accepts for it, in the order to show them. */
  choices?: readonly string[];
  openedAt: number;
}

/** An answer to a pending request. `payload` is the SDK's own result shape for that kind. */
export interface CodeRequestAnswer {
  sessionId: string;
  requestId: string;
  kind: CodeRequestKind;
  payload: unknown;
}

/** A project: a folder (usually a repository) that sessions are grouped under. */
export interface CodeProject {
  id: string;
  /** The folder, as main resolved it. Shown, never used by the window as a path to act on. */
  folder: string;
  name: string;
  gitRoot?: string;
  repository?: string;
  branch?: string;
}

/** A session's row in the list: what Ember's index and the SDK's metadata say about it. */
export interface CodeSessionRow {
  id: string;
  projectId: string;
  name: string;
  folder: string;
  isolation: CodeIsolation;
  /** The worktree's branch, when `isolation` is "worktree". */
  branch?: string;
  permissionMode: CodePermissionMode;
  agentMode: CodeAgentMode;
  model?: string;
  /** Open in the runtime now (false: kept on disk, opens when attached). */
  open: boolean;
  busy: boolean;
  /** Requests waiting for an answer. */
  pending: number;
  /** Events since the window last looked. */
  unread: number;
  pinned: boolean;
  archived: boolean;
  /** The session this one was forked from or started by, if any. */
  parentId?: string;
  /**
   * The SDK's sandbox for this session's tools: "on" (with outbound network), "no-network" (on, but this computer's
   * sandbox has no network for commands) or "off" (this computer has no sandbox: the tools run without one). Absent
   * until the session has been opened in this run.
   */
  sandbox?: "on" | "no-network" | "off";
  /** Who started it. */
  createdBy: CodeActor;
  createdAt: number;
  updatedAt: number;
}

/** A file, folder, selection or image sent with a message. Paths come only from main's own pickers and lists. */
export type CodeAttachment =
  | { type: "file"; path: string; displayName?: string }
  | { type: "directory"; path: string; displayName?: string }
  | { type: "selection"; filePath: string; displayName: string; text?: string;
      selection?: { start: { line: number; character: number }; end: { line: number; character: number } } }
  | { type: "blob"; data: string; mimeType: string; displayName?: string };

/** What starting a session takes. The folder is chosen in main's picker or is a known project's. */
export interface CodeCreate {
  /** A known project, or omit it to pick a folder. */
  projectId?: string;
  isolation?: CodeIsolation;
  /** For a worktree: the branch to start from (default: the folder's current branch). */
  baseBranch?: string;
  model?: string;
  reasoningEffort?: string;
  permissionMode?: CodePermissionMode;
  agentMode?: CodeAgentMode;
  /** A custom or built-in agent to start as. */
  agent?: string;
  name?: string;
}

/** A message to a session. */
export interface CodeSend {
  sessionId: string;
  prompt: string;
  attachments?: CodeAttachment[];
  /** While a turn runs: wait in the queue, or steer the turn now. */
  mode?: "enqueue" | "immediate";
  agentMode?: CodeAgentMode | "shell";
}

/** What a window gets when it attaches: everything since `sinceSeq`, or the whole kept history. */
export interface CodeAttached {
  row: CodeSessionRow;
  /** The events after `sinceSeq`, in order. With no `sinceSeq`, the session's kept history. */
  events: CodeEventEnvelope[];
  pending: CodePendingRequest[];
  /** The last `seq` sent for this session. */
  seq: number;
  /**
   * True when `events` is the session's whole kept history rather than what followed `sinceSeq` (no `sinceSeq`, or
   * one this run no longer holds): drop what was shown and draw it again. Its seqs may skip numbers, since ephemeral
   * events (deltas, request events) aren't kept by the SDK.
   */
  reset?: boolean;
}

/** Why a command did nothing, as a sentence a person can read (never raw SDK text). */
export interface CodeRefusal { ok: false; reason: string; code?: string }
export type CodeDone<T = void> = (T extends void ? { ok: true } : { ok: true; value: T }) | CodeRefusal;

/** A call to one of the SDK's RPC methods, by its dotted name (`CODE_RPC` lists the ones a window may call). */
export interface CodeRpcCall {
  /** "client": `client.rpc.*`; "session": `session.rpc.*` of `sessionId`. */
  scope: "client" | "session";
  sessionId?: string;
  method: string;
  params?: unknown;
}

/**
 * The SDK RPC methods a window may call, by scope. A prefix ending in ".*" allows the namespace. Main checks
 * every call against this list, bounds its params, and applies its own guards on top (docs/CODING-APP.md
 * "Guards"): a mode the organisation forbids, turning the sandbox off, or a path outside what main offered are
 * refused whatever this list says. Turn control, requests and session lifecycle are not here: they have their own
 * commands, so Stop, the audit log and the pending table always see them.
 */
export const CODE_RPC = {
  client: [
    "models.*", "tools.list", "commands.list", "account.getQuota", "account.getCurrentAuth",
    "mcp.config.*", "mcp.discover", "mcp.planInstall", "mcp.prepareInstall", "mcp.applyInstall",
    "mcp.planUninstall", "mcp.applyUninstall", "mcp.installations.*",
    "skills.*", "plugins.*", "agents.*", "instructions.*", "extensions.discover", "hooks.discover",
    "catalog.*", "connectors.*", "sandbox.getHostSupport", "managedSettings.read", "managedSettings.schema",
    "sessions.getSizes", "user.settings.get",
  ],
  session: [
    "model.*", "mode.get", "name.*", "plan.*", "workspaces.*", "autopilotObjective.getState",
    "completions.*", "instructions.*", "customizations.reload", "agent.*", "tasks.*", "fleet.start",
    "skills.*", "mcp.*", "connectors.*", "plugins.*", "extensions.*", "tools.getBuiltinDescriptors",
    "tools.getCurrentMetadata", "tools.updateSubagentSettings", "commands.*", "ui.ephemeralQuery",
    "permissions.getMode", "permissions.pendingRequests", "permissions.modifyRules",
    "permissions.resetSessionApprovals", "permissions.paths.*", "permissions.locations.*",
    "permissions.folderTrust.*", "managedSettings.get", "metadata.*", "contentExclusion.checkPaths",
    "shell.*", "history.*", "queue.*", "usage.getMetrics", "quota.*", "limitPrediction.predict",
    "schedule.*", "sandbox.getEnforcementStatus", "sandbox.getCredentialSuggestions",
    "providers.*", "workflow.*", "canvas.*", "visibility.get",
  ],
} as const;

/** Whether `method` is on the allow-list for `scope`. Pure, so the window and main agree. */
export function codeRpcAllowed(scope: "client" | "session", method: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*){0,3}$/.test(method)) return false;
  return CODE_RPC[scope].some((entry) =>
    entry.endsWith(".*") ? method.startsWith(entry.slice(0, -1)) : method === entry);
}

/** Sizes main enforces on what a window sends and on what it passes through. */
export const CODE_LIMITS = {
  /** Characters of one prompt. */
  prompt: 200_000,
  /** Attachments on one message. */
  attachments: 50,
  /** Bytes of one image attachment, before base64. */
  blob: 10 * 1024 * 1024,
  /** Bytes of the JSON of one RPC call's params, or of one answer's payload. */
  params: 256 * 1024,
  /** Bytes of the JSON of one event's data sent to a window; longer strings in it are cut, and marked cut. */
  eventData: 512 * 1024,
  /** Events kept in memory per open session for a window to catch up; older ones come from the SDK's log. */
  replay: 5_000,
  /** Characters of a session's name. */
  name: 120,
} as const;

/** IPC channels of the coding window. Every handler checks its sender and validates its arguments. */
export const CODE_IPC = {
  /** () => { projects: CodeProject[]; sessions: CodeSessionRow[] } */
  list: "code:list",
  /** () => CodeDone<CodeProject>: main's folder picker, then the project it is. */
  addProject: "code:add-project",
  /** (projectId) => CodeDone */
  removeProject: "code:remove-project",
  /** (CodeCreate) => CodeDone<CodeSessionRow> */
  create: "code:create",
  /** (sessionId, sinceSeq?) => CodeDone<CodeAttached> */
  attach: "code:attach",
  /** (sessionId) => void: this window stops getting the session's events (the session keeps running). */
  detach: "code:detach",
  /** (CodeSend) => CodeDone<{ messageId: string }> */
  send: "code:send",
  /** (sessionId, { keepBackground?: boolean }) => CodeDone: stop the turn. */
  interrupt: "code:interrupt",
  /** () => void: Stop everything. Always accepted. */
  stopAll: "code:stop-all",
  /** (CodeRequestAnswer) => CodeDone */
  respond: "code:respond",
  /** (sessionId, CodePermissionMode) => CodeDone<{ mode: CodePermissionMode }>: the mode in force after. */
  setPermissionMode: "code:set-permission-mode",
  /** (sessionId, CodeAgentMode) => CodeDone<{ mode: CodeAgentMode }> */
  setAgentMode: "code:set-agent-mode",
  /** (sessionId, { name?, pinned?, archived? }) => CodeDone<CodeSessionRow> */
  update: "code:update",
  /** (sessionId, { toEventId?, name? }) => CodeDone<CodeSessionRow> */
  fork: "code:fork",
  /** (sessionId) => CodeDone: delete the session, its history and, if Ember made one, its worktree. */
  remove: "code:remove",
  /** (sessionId) => CodeDone<CodeAttachment[]>: main's file picker, rooted at the session's folder. */
  pickAttachments: "code:pick-attachments",
  /** (CodeRpcCall) => CodeDone<unknown> */
  rpc: "code:rpc",
  /** main → window: CodeEventEnvelope */
  event: "code:event",
  /** main → window: CodeSessionRow (a row changed) or { removed: sessionId } */
  row: "code:row",
  /** main → window: CodePendingRequest opened, or { resolved: requestId, sessionId, by: CodeActor | "sdk" } */
  request: "code:request",
} as const;

/** The API the coding window's preload exposes as `window.emberCode`. */
export interface EmberCodeApi {
  list(): Promise<{ projects: CodeProject[]; sessions: CodeSessionRow[] }>;
  addProject(): Promise<CodeDone<CodeProject>>;
  removeProject(projectId: string): Promise<CodeDone>;
  create(options: CodeCreate): Promise<CodeDone<CodeSessionRow>>;
  attach(sessionId: string, sinceSeq?: number): Promise<CodeDone<CodeAttached>>;
  detach(sessionId: string): void;
  send(message: CodeSend): Promise<CodeDone<{ messageId: string }>>;
  interrupt(sessionId: string, options?: { keepBackground?: boolean }): Promise<CodeDone>;
  stopAll(): void;
  respond(answer: CodeRequestAnswer): Promise<CodeDone>;
  setPermissionMode(sessionId: string, mode: CodePermissionMode): Promise<CodeDone<{ mode: CodePermissionMode }>>;
  setAgentMode(sessionId: string, mode: CodeAgentMode): Promise<CodeDone<{ mode: CodeAgentMode }>>;
  update(sessionId: string, change: { name?: string; pinned?: boolean; archived?: boolean }): Promise<CodeDone<CodeSessionRow>>;
  fork(sessionId: string, options?: { toEventId?: string; name?: string }): Promise<CodeDone<CodeSessionRow>>;
  remove(sessionId: string): Promise<CodeDone>;
  pickAttachments(sessionId: string): Promise<CodeDone<CodeAttachment[]>>;
  rpc(call: CodeRpcCall): Promise<CodeDone<unknown>>;
  onEvent(listener: (envelope: CodeEventEnvelope) => void): () => void;
  onRow(listener: (change: CodeSessionRow | { removed: string }) => void): () => void;
  onRequest(listener: (change: CodePendingRequest | { resolved: string; sessionId: string; by: CodeActor | "sdk" }) => void): () => void;
}
