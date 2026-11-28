/**
 * A native Copilot chat session (owner decision: "GitHub Copilot SDK first"): the SDK's own tools as they are
 * (`builtin:*`) working in a real folder of the user's, with the SDK's own permission system, its permission modes
 * (manual, assisted, allow-all) and agent modes (interactive, plan, autopilot), and its permission requests shown to a
 * person and answered with the SDK's own decisions, unchanged (chat-permission.ts). Ember's classifier, PolicyEngine
 * and Confirmer are not in this path. What Ember keeps, because the SDK has nothing for it: its own data out of the
 * tools' reach (the SDK's sandbox with `deniedPaths`; a computer without that sandbox gets no chat session), the
 * organisation's policy as `managedSettings` (chat-policy.ts), the vault's values kept from the model, and Stop:
 * `stop()` aborts the turn, cancels background agents and rejects whatever waits, and no tool starts until the next
 * message. Modelled on CodingSession, without its coding-only parts. Plain Node: the client is injected.
 */

import crypto from "node:crypto";
import path from "node:path";
import type { CopilotClient, CopilotSession, PermissionRequestedData, ProviderConfig, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import { CHAT_LIMITS, type ChatAgentMode, type ChatDecider, type ChatDecision, type ChatEvent, type ChatModeResult, type ChatPermissionMode } from "../../shared/chat";
import { codingWorkspace, protectedPath } from "./coding-session";
import { JUDGE_CONTEXT, STOPPED_DECISION, judgeApproves, permissionRequested, runtimeDecision, type PermissionDecision } from "./chat-permission";
import type { ChatPolicy } from "./chat-policy";
import type { ModelRedactor } from "./redacting-client";
import { friendlyError, type ServiceKind } from "./presenter";

/** Every chat session's id starts so, which is how kept sessions are told from the runtime's others. */
export const CHAT_ID_PREFIX = "ember-chat-";

/** A chat session can't be made here; its message is a plain sentence for the person. */
export class ChatUnavailable extends Error {}

export interface ChatSessionOptions {
  client: CopilotClient;
  /** The user's folder: the session's working directory (an absolute path to a directory). */
  folder: string;
  /** Absolute paths of Ember's own data, install and policy: the tools never reach them. */
  protectedPaths: readonly string[];
  policy: ChatPolicy;
  model?: string;
  provider?: ProviderConfig;
  /** The GitHub sign-in, sent with this session only, never in the runtime's environment. */
  gitHubToken?: string;
  /** Which model service it is, for the words of its errors (friendlyError). */
  service?: ServiceKind;
  /** A friendly name (`session.rpc.name.set`). */
  name?: string;
  /** Open a kept session again (its id starts with CHAT_ID_PREFIX). */
  resumeId?: string;
  /** The vault's redactor: a tool's result holding a filled value reaches the model without it. */
  redact?: ModelRedactor;
  onEvent: (event: ChatEvent) => void;
}

/** A pending request, as Ember keeps it until it is answered. */
interface Pending { data: PermissionRequestedData }

/** A question of the model's waiting for the person. */
interface Asking { resolve: (answer: { answer: string; wasFreeform: boolean }) => void; reject: (err: Error) => void; choices?: string[]; allowFreeform: boolean }

/** `text` capped for a page. */
const cap = (text: unknown, max: number = CHAT_LIMITS.text): string => {
  const s = typeof text === "string" ? text : text === undefined || text === null ? "" : JSON.stringify(text) ?? "";
  return s.length > max ? s.slice(0, max) : s;
};

/** How little each permission mode asks: manual asks most, allow-all nothing. */
const LOOSENESS: Readonly<Record<ChatPermissionMode, number>> = { manual: 0, assisted: 1, "allow-all": 2 };

/** Who decided a request, by the SDK's word for it (`permission.completed`'s `decisionSource`). */
function deciderOf(source: unknown): ChatDecider {
  if (source === "assisted_approval") return "judge";
  if (source === "human_response") return "user";
  return "sdk";
}

export class ChatSession {
  readonly id: string;
  readonly folder: string;
  name: string;
  permissionMode: ChatPermissionMode = "manual";
  agentMode: ChatAgentMode = "interactive";
  busy = false;
  /** Stop was pulled: until the next message no request is approved and no tool starts. */
  private halted = false;
  private closed = false;
  private readonly pending = new Map<string, Pending>();
  private readonly asking = new Map<string, Asking>();
  /** Who decided each request Ember answered, by request id, until its `permission.completed` arrives. */
  private readonly decided = new Map<string, ChatDecider>();
  /** Who approved each tool call, by tool call id, for its completion's record. */
  private readonly approvedBy = new Map<string, ChatDecider>();
  private readonly tools = new Map<string, string>();
  /** The SDK's kind of each request seen, by request id, for its resolution. */
  private readonly kinds = new Map<string, string>();
  private off: () => void = () => undefined;
  private session!: CopilotSession;

  private constructor(id: string, folder: string, name: string, private readonly o: ChatSessionOptions) {
    this.id = id;
    this.folder = folder;
    this.name = name;
  }

  /** Makes (or, with `resumeId`, opens again) a session; throws ChatUnavailable for what the person can be told. */
  static async open(o: ChatSessionOptions): Promise<ChatSession> {
    if (o.resumeId !== undefined && !o.resumeId.startsWith(CHAT_ID_PREFIX)) throw new ChatUnavailable("That chat isn't one of Ember's.");
    let folder: string;
    try { folder = await codingWorkspace(o.folder); } catch { throw new ChatUnavailable("Choose a folder that exists."); }
    if (!o.protectedPaths.length || o.protectedPaths.some(p => !path.isAbsolute(p))) throw new ChatUnavailable("Ember couldn't tell where its own data is, so it won't start a chat.");
    const denied = [...new Set((await Promise.all(o.protectedPaths.map(protectedPath))).flat())];
    if (denied.some(p => folder === p || folder.startsWith(p.endsWith(path.sep) ? p : p + path.sep))) throw new ChatUnavailable("That folder holds Ember's own data. Choose another.");
    const support = await o.client.rpc.sandbox.getHostSupport();
    const has = (name: string) => support.capabilities.some(c => c.name === name && c.supported);
    if (!support.supported || !has("shell") || !has("denied_paths")) {
      throw new ChatUnavailable("This computer can't keep Copilot's tools away from Ember's own data, so chats are off here.");
    }
    const id = o.resumeId ?? `${CHAT_ID_PREFIX}${crypto.randomUUID()}`;
    const name = (o.name ?? "").trim().slice(0, CHAT_LIMITS.name);
    const owner = new ChatSession(id, folder, name, o);
    const config: SessionConfig = {
      sessionId: id,
      ...(o.model ? { model: o.model } : {}), ...(o.provider ? { provider: o.provider } : {}), ...(o.gitHubToken ? { gitHubToken: o.gitHubToken } : {}),
      workingDirectory: folder, streaming: true, enableSessionTelemetry: false,
      // The runtime's own tools, all of them, as they are. Project-configured integrations aren't loaded implicitly;
      // custom tools and MCP servers come later, each by name.
      enableConfigDiscovery: false, availableTools: ["builtin:*"], infiniteSessions: { enabled: true },
      ...(o.policy.managedSettings.permissions ? { managedSettings: o.policy.managedSettings } : {}),
      // Requests are answered from the `permission.requested` event by its id (owner.onRequest): the SDK's handler
      // has none to give, so it leaves the request pending.
      onPermissionRequest: () => ({ kind: "no-result" }),
      onUserInputRequest: request => owner.ask(request),
      hooks: {
        onPreToolUse: () => (owner.halted || owner.closed ? { permissionDecision: "deny", permissionDecisionReason: "The person stopped this session." } : undefined),
        // A tool's result that holds a value the vault filled reaches the model without it (failures can't be
        // rewritten, which is why a chat isn't started or sent to after a fill: ChatSessions).
        onPostToolUse: input => {
          const r = o.redact;
          return r?.active && r.holds(input.toolResult) ? { modifiedResult: r.deep(input.toolResult) } : undefined;
        },
      },
    };
    owner.session = o.resumeId ? await o.client.resumeSession(o.resumeId, { ...config, continuePendingWork: false }) : await o.client.createSession(config);
    owner.off = owner.session.on(event => owner.onEvent(event));
    try {
      const sandbox = await owner.session.rpc.options.update({ sandboxConfig: {
        enabled: true, allowBypass: false,
        userPolicy: { filesystem: { deniedPaths: denied }, network: { allowOutbound: has("network") } },
      } });
      if (!sandbox.success) throw new ChatUnavailable("Copilot couldn't turn on the sandbox that keeps Ember's data safe.");
      // Restrict first: a session opened again starts in manual whatever it was left in.
      const manual = await owner.session.rpc.permissions.setMode({ mode: "manual" });
      if (!manual.success || manual.mode !== "manual") throw new ChatUnavailable("Copilot couldn't set the permission mode.");
      owner.agentMode = await owner.session.rpc.mode.get();
      if (name) await owner.session.rpc.name.set({ name });
      else owner.name = (await owner.session.rpc.name.get()).name ?? "";
      return owner;
    } catch (err) {
      await owner.close().catch(() => undefined);
      throw err;
    }
  }

  /** Requests waiting for a person. */
  get waiting(): number { return this.pending.size; }

  /** Sends a message; a turn after Stop begins afresh. */
  async send(text: string): Promise<void> {
    if (this.closed) throw new ChatUnavailable("This chat is closed.");
    if (!text.trim()) throw new ChatUnavailable("Type a message first.");
    this.halted = false;
    this.busy = true;
    try { await this.session.send({ prompt: text }); }
    catch (err) { this.busy = false; throw err; }
  }

  /** A person's decision on a pending request: the exact SDK result it becomes is sent, and the request is done. */
  async decide(requestId: string, decision: ChatDecision): Promise<void> {
    const p = this.pending.get(requestId);
    if (!p) throw new ChatUnavailable("That request isn't waiting any more.");
    const result = runtimeDecision(p.data.permissionRequest, decision, { standing: this.o.policy.standing });
    // Nothing is approved after Stop: only a rejection still goes through.
    if (this.halted && result.kind !== "reject") throw new ChatUnavailable("This chat was stopped.");
    await this.answerRequest(requestId, result, "user");
  }

  /** A person's answer to the model's question. */
  answer(requestId: string, answer: string, wasFreeform: boolean): void {
    const q = this.asking.get(requestId);
    if (!q) throw new ChatUnavailable("That question isn't waiting any more.");
    if (wasFreeform ? !q.allowFreeform : !q.choices?.includes(answer)) throw new ChatUnavailable("That answer isn't one the question takes.");
    this.asking.delete(requestId);
    q.resolve({ answer, wasFreeform });
  }

  /** Sets the SDK's permission mode; the result is the mode the SDK says is in force (assisted may fall back to manual). */
  async setPermissionMode(mode: ChatPermissionMode): Promise<ChatModeResult<ChatPermissionMode>> {
    if (this.closed) throw new ChatUnavailable("This chat is closed.");
    // The organisation's cap holds here too, whatever the runtime would do with the request.
    if (!this.o.policy.permissionModes.includes(mode)) return { requested: mode, mode: this.permissionMode, applied: false };
    const result = await this.session.rpc.permissions.setMode({ mode });
    // A refused change leaves the old mode in force (runtime 1.0.97): asking for assisted from allow-all must never
    // leave allow-all, so a mode that asks less than the one asked for falls back to manual.
    if (!result.success && LOOSENESS[result.mode] > LOOSENESS[mode]) await this.session.rpc.permissions.setMode({ mode: "manual" });
    this.permissionMode = (await this.session.rpc.permissions.getMode()).mode;
    this.modeChanged();
    return { requested: mode, mode: this.permissionMode, applied: result.success && this.permissionMode === mode };
  }

  /** Sets the SDK's agent mode, apart from the permission mode; the result is the mode the SDK says is in force. */
  async setAgentMode(mode: ChatAgentMode): Promise<ChatModeResult<ChatAgentMode>> {
    if (this.closed) throw new ChatUnavailable("This chat is closed.");
    const result = await this.session.rpc.mode.set({ mode });
    this.agentMode = await this.session.rpc.mode.get();
    this.modeChanged();
    return { requested: mode, mode: this.agentMode, applied: result.modeApplied !== false && this.agentMode === mode };
  }

  /**
   * Stop: nothing more is approved and no tool starts until the next message; every pending request is rejected,
   * every question of the model's withdrawn, the turn aborted and background agents cancelled, all at once.
   */
  stop(): Promise<void> {
    this.halted = true;
    for (const [id, q] of this.asking) { this.asking.delete(id); q.reject(new Error("The person stopped this session.")); }
    const work: Promise<unknown>[] = [];
    for (const id of [...this.pending.keys()]) work.push(this.answerRequest(id, STOPPED_DECISION, "stop").catch(() => undefined));
    if (!this.closed) {
      work.push(this.session.abort());
      work.push(this.session.rpc.cancelAllBackgroundAgents());
    }
    return Promise.all(work).then(() => undefined);
  }

  /** Stops and lets go of the session; what the runtime keeps on disk stays, so it can be opened again. */
  async close(): Promise<void> {
    if (this.closed) return;
    let failure: unknown;
    try { await this.stop(); } catch (err) { failure = err; }
    this.closed = true;
    this.off();
    try { await this.session?.disconnect(); } catch (err) { failure ??= err; }
    if (failure) throw failure;
  }

  private async answerRequest(requestId: string, result: PermissionDecision, by: ChatDecider): Promise<void> {
    const p = this.pending.get(requestId);
    this.pending.delete(requestId);
    this.decided.set(requestId, by);
    const call = p?.data.permissionRequest.toolCallId;
    if (call && result.kind !== "reject") this.approvedBy.set(call, by);
    const sent = await this.session.rpc.permissions.handlePendingPermissionRequest(
      by === "judge" ? { requestId, result, decisionContext: JUDGE_CONTEXT } : { requestId, result });
    if (!sent.success && by !== "stop") throw new ChatUnavailable("Copilot didn't take that answer. The request may have ended.");
  }

  private async ask(request: { question: string; choices?: string[]; allowFreeform?: boolean }): Promise<{ answer: string; wasFreeform: boolean }> {
    if (this.halted || this.closed) throw new Error("The person stopped this session.");
    const requestId = crypto.randomUUID();
    const allowFreeform = request.allowFreeform !== false;
    const choices = Array.isArray(request.choices) ? request.choices.slice(0, 50).map(c => cap(c, 1000)) : undefined;
    const answer = new Promise<{ answer: string; wasFreeform: boolean }>((resolve, reject) => this.asking.set(requestId, { resolve, reject, ...(choices ? { choices } : {}), allowFreeform }));
    this.emit({ type: "user-input-requested", requestId, question: cap(request.question), ...(choices ? { choices } : {}), allowFreeform });
    return answer;
  }

  private onRequest(data: PermissionRequestedData): void {
    // The SDK's own hook decided it; its completion says how.
    this.kinds.set(data.requestId, String(data.permissionRequest.kind).slice(0, 64));
    if (data.resolvedByHook) return;
    this.pending.set(data.requestId, { data });
    if (this.halted || this.closed) { void this.answerRequest(data.requestId, STOPPED_DECISION, "stop").catch(() => undefined); return; }
    if (this.permissionMode === "assisted" && judgeApproves(data)) {
      void this.answerRequest(data.requestId, { kind: data.permissionRequest.kind === "custom-tool" ? "approved" : "approve-once" }, "judge")
        .catch(() => { this.emit(permissionRequested(this.id, data, { standing: this.o.policy.standing })); });
      return;
    }
    this.emit(permissionRequested(this.id, data, { standing: this.o.policy.standing }));
  }

  private modeChanged(): void {
    this.emit({ type: "mode-changed", permissionMode: this.permissionMode, agentMode: this.agentMode });
  }

  private emit(event: DistributiveOmit<ChatEvent, "session">): void {
    try { this.o.onEvent({ ...event, session: this.id } as ChatEvent); } catch { /* a listener's failure isn't the session's */ }
  }

  private onEvent(e: SessionEvent): void {
    if (this.closed) return;
    switch (e.type) {
      case "permission.requested": this.onRequest(e.data as PermissionRequestedData); return;
      case "permission.completed": {
        const by = this.decided.get(e.data.requestId) ?? deciderOf(e.data.decisionSource);
        this.decided.delete(e.data.requestId);
        this.pending.delete(e.data.requestId);
        const call = e.data.toolCallId;
        if (call && !this.approvedBy.has(call) && /^approved/.test(e.data.result.kind)) this.approvedBy.set(call, by);
        const kind = this.kinds.get(e.data.requestId) ?? "unknown";
        this.kinds.delete(e.data.requestId);
        this.emit({ type: "permission-resolved", requestId: e.data.requestId, kind, decision: e.data.result.kind, by });
        return;
      }
      case "tool.execution_start":
        this.tools.set(e.data.toolCallId, e.data.toolName);
        this.emit({ type: "tool-start", toolCallId: e.data.toolCallId, tool: cap(e.data.toolName, 200), ...(e.data.toolTitle ? { title: cap(e.data.toolTitle, 500) } : {}),
          ...(e.data.arguments !== undefined ? { args: cap(e.data.arguments) } : {}), ...(e.data.parentToolCallId ? { parentToolCallId: e.data.parentToolCallId } : {}) });
        return;
      case "tool.execution_progress": this.emit({ type: "tool-progress", toolCallId: e.data.toolCallId, message: cap(e.data.progressMessage) }); return;
      case "tool.shell_output": this.emit({ type: "tool-output", toolCallId: e.data.toolCallId, text: cap(e.data.text), ...(e.data.stream ? { stream: e.data.stream } : {}) }); return;
      case "tool.execution_complete": {
        const tool = this.tools.get(e.data.toolCallId) ?? "unknown";
        this.tools.delete(e.data.toolCallId);
        const by = this.approvedBy.get(e.data.toolCallId) ?? (this.permissionMode === "allow-all" ? "allow-all" : "sdk");
        this.approvedBy.delete(e.data.toolCallId);
        this.emit({ type: "tool-complete", toolCallId: e.data.toolCallId, tool: cap(tool, 200), approvedBy: by, success: e.data.success,
          ...(e.data.result ? { result: cap(e.data.result.content) } : {}), ...(e.data.error ? { error: cap(e.data.error.message) } : {}),
          ...(e.data.shellExecution ? { exitCode: e.data.shellExecution.exitCode } : {}),
          fileEdits: (e.data.fileEdits ?? []).slice(0, 200).map(f => ({ path: cap(f.path, 4096), kind: cap(f.kind, 32) })) });
        return;
      }
      case "session.idle":
        this.busy = false;
        this.emit({ type: "idle", aborted: e.data.aborted === true });
        return;
      case "session.error": this.emit({ type: "error", message: friendlyError(String(e.data.message ?? ""), e.data.errorType, { provider: this.o.service ?? false }) }); return;
      case "session.mode_changed":
        this.agentMode = e.data.newMode;
        this.modeChanged();
        return;
      case "session.title_changed": this.emit({ type: "title-changed", title: cap(e.data.title, 500) }); return;
      default: break;
    }
    // A sub-agent's words are its own; the chat shows the main agent's.
    if (e.agentId) return;
    if (e.type === "assistant.message_delta") this.emit({ type: "text-delta", messageId: e.data.messageId, text: cap(e.data.deltaContent), ...(e.data.parentToolCallId ? { parentToolCallId: e.data.parentToolCallId } : {}) });
    else if (e.type === "assistant.message") this.emit({ type: "message", messageId: e.data.messageId, text: cap(e.data.content, CHAT_LIMITS.prompt), ...(e.data.parentToolCallId ? { parentToolCallId: e.data.parentToolCallId } : {}) });
    else if (e.type === "assistant.reasoning_delta") this.emit({ type: "reasoning-delta", reasoningId: e.data.reasoningId, text: cap(e.data.deltaContent) });
  }
}

/** Omit that keeps a union a union. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
