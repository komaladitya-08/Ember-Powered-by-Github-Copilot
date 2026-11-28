/**
 * One open coding session (docs/CODING-APP.md §2 "SessionRuntime"): an SDK session in the full Copilot mode, every
 * one of its events passed on as it is (redacted and bounded, events.ts) with a per-session `seq`, the facts a row
 * shows (busy, model, modes, name) read from those events, and the pending-request table (pending.ts) for every kind
 * of request that blocks it, each answered once and cleared for every window with who answered.
 *
 * What it keeps beside the SDK, because the SDK has nothing for it: the organisation's policy as `managedSettings`
 * and as a cap on the permission modes (chat-policy.ts); the sandbox where this computer has one (Ember's data, the
 * install and the policy denied to the tools, outbound network allowed where the sandbox can give it), checked with
 * `sandbox.getEnforcementStatus`, and where it has none the session runs without one and says so (`sandbox: "off"`);
 * a pre-tool hook that refuses any tool whose arguments name Ember's data (the only guard where there is no sandbox),
 * and every tool after Stop until the next message; the vault's values out of tool results (onPostToolUse); repository
 * file hooks only inside the sandbox (without it they would run unconfined: probed on runtime 1.0.97). Departs from
 * the chat path, which refused to start without a sandbox: intended (docs/CODING-APP.md §3).
 *
 * Requests: permission requests are left pending by the SDK's handler (`no-result`) and answered by id
 * (`permissions.handlePendingPermissionRequest`); the model's question, leaving plan mode and an auto-mode switch are
 * declared to the runtime by handlers (it offers `ask_user` and `exit_plan_mode` only then) but answered by id through
 * `ui.handlePending*`, which the runtime takes over the handler's pending reply (probed); an elicitation and an MCP
 * sign-in are answered through the SDK's own handlers; session limits and sampling through `ui.handlePending*`.
 * Plain Node: the client is injected.
 */

import path from "node:path";
import type { CopilotClient, CopilotSession, PermissionRequestedData, ProviderConfig, SessionConfig, SessionEvent } from "@github/copilot-sdk";
import type { CodeActor, CodeAgentMode, CodeAttachment, CodeEventEnvelope, CodePendingRequest, CodePermissionMode, CodeRequestKind, CodeSdkEvent } from "../../shared/code";
import { CODE_LIMITS } from "../../shared/code";
import { JUDGE_CONTEXT, STOPPED_DECISION, judgeApproves, wireApproval } from "../agent/chat-permission";
import type { ChatPolicy } from "../agent/chat-policy";
import type { ModelRedactor } from "../agent/redacting-client";
import { boundData, boundEvent, eventRedactor, type EventLog, type TextRedact } from "./events";
import { CODE_REFUSALS, reachesEmberData, type SessionPlace } from "./guards";
import { AnswerRefused, COMPLETION_EVENTS, NotOffered, PendingTable, REQUEST_EVENTS, answerCall, codeChoices, stoppedAnswer, type PendingEntry, type RequestChange } from "./pending";

/** A session can't do that now; its message is a plain sentence for the person. */
export class CodeUnavailable extends Error {}

/** How the session reaches the model: the conversation's sign-in, or a provider of the user's or the organisation's. */
export interface CodeAccess {
  gitHubToken?: string;
  provider?: ProviderConfig;
  model?: string;
}

/** The sandbox a session runs in. */
export type CodeSandbox = "on" | "no-network" | "off";

export interface SessionRuntimeOptions {
  client: CopilotClient;
  /** The session's id: a new one (create) or a kept one (resume). */
  id: string;
  resume: boolean;
  /** The folder it works in (the project's, or its worktree): an absolute, resolved directory. */
  folder: string;
  /** Ember's own paths, resolved (protectedPath): denied to the tools. */
  denied: readonly string[];
  /** Where paths are judged (the OS, the home and Ember's paths) for the pre-tool hook. */
  place: SessionPlace["place"];
  /** The SDK's own state for this session (`<COPILOT_HOME>/session-state/<id>`): its own, though the rest of COPILOT_HOME is Ember's. */
  stateDir: string;
  policy: ChatPolicy;
  access: CodeAccess;
  /** The numbered events of this session for the run (kept across a close and an open again). */
  log: EventLog;
  /** Model, effort, agent and modes to start with (create; on resume the kept modes). */
  start?: { model?: string; reasoningEffort?: string; agent?: string; name?: string; permissionMode?: CodePermissionMode; agentMode?: CodeAgentMode };
  redact?: ModelRedactor;
  onEnvelope(envelope: CodeEventEnvelope): void;
  onRequest(change: RequestChange): void;
  /** A fact a row shows changed (busy, model, modes, name, pending). */
  onFacts(): void;
  /** A request was decided (for the audit): its kind, the decision's kind, and who. */
  onDecided?(d: { kind: CodeRequestKind; decision: string; by: CodeActor | "sdk" }): void;
  /** A history page reader (`sessions.readPersistedEvents`), injected for tests. */
  readHistory?: (sessionId: string) => Promise<SessionEvent[]>;
}

/** How little each permission mode asks: manual asks most, allow-all nothing. */
const LOOSENESS: Readonly<Record<CodePermissionMode, number>> = { manual: 0, assisted: 1, "allow-all": 2 };

/** Events of the persisted history read at most when a session opens (in pages). */
const HISTORY_MAX = 100_000;
const HISTORY_PAGE = 1_000;

/** Reads a kept session's whole history from the SDK's own log, without opening it. */
export async function readPersistedHistory(client: CopilotClient, sessionId: string, max = HISTORY_MAX): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await client.rpc.sessions.readPersistedEvents({ sessionId, max: HISTORY_PAGE, ...(cursor ? { cursor } : {}) });
    out.push(...(page.events as SessionEvent[]));
    if (!page.hasMore || out.length >= max || page.cursor === cursor) break;
    cursor = page.cursor;
  }
  return out;
}

/** The session-state folder of a session under the runtime's home. */
export const sessionStateDir = (runtimeHome: string, sessionId: string): string => path.join(runtimeHome, "session-state", sessionId);

export class SessionRuntime {
  readonly id: string;
  readonly folder: string;
  name = "";
  model?: string;
  permissionMode: CodePermissionMode = "manual";
  agentMode: CodeAgentMode = "interactive";
  busy = false;
  sandbox: CodeSandbox = "off";
  closed = false;
  /** Stop was pulled: until the next message nothing is approved and no tool starts. */
  private halted = false;
  private readonly pending = new PendingTable();
  /** Who answered each request Ember answered, until the SDK's completion arrives. */
  private readonly answeredBy = new Map<string, CodeActor | "sdk">();
  /** The SDK's elicitation handlers waiting for their request's id (the handler runs just before the event). */
  private readonly elicitWaiting: { resolve: (v: unknown) => void }[] = [];
  private readonly handlers = new Map<string, (v: unknown) => void>();
  /** Handlers that only declare a capability (the model's question, leaving plan mode, an auto-mode switch), by kind, oldest first. */
  private readonly declared: Record<"user-input" | "exit-plan-mode" | "auto-mode-switch", ((v: unknown) => void)[]> = { "user-input": [], "exit-plan-mode": [], "auto-mode-switch": [] };
  private readonly redact: TextRedact;
  private locationKey?: string;
  private hooksOn = false;
  /** Whether the sandbox gives the tools outbound network (the host's `network` capability). */
  private network = false;
  private session!: CopilotSession;

  private constructor(private readonly o: SessionRuntimeOptions) {
    this.id = o.id;
    this.folder = o.folder;
    this.redact = eventRedactor(o.redact);
  }

  /** Opens the session (made new, or kept and opened again with its pending work); throws CodeUnavailable or the SDK's error. */
  static async open(o: SessionRuntimeOptions): Promise<SessionRuntime> {
    const owner = new SessionRuntime(o);
    const support = await o.client.rpc.sandbox.getHostSupport().catch(() => ({ supported: false, capabilities: [] as { name: string; supported: boolean }[] }));
    const has = (name: string) => support.capabilities.some(c => c.name === name && c.supported);
    const sandboxable = support.supported && has("shell") && has("denied_paths");
    // The kept history first, before the session opens (and emits), so its events keep their order.
    const asked = new Map<string, Record<string, unknown>>();
    if (o.resume) {
      const kept = await (o.readHistory ?? (id => readPersistedHistory(o.client, id)))(o.id).catch(() => [] as SessionEvent[]);
      for (const e of kept) {
        owner.ingest(e, false);
        // The permission requests the history leaves open, as the runtime sent them (their choices are built from these).
        const d = (e.data ?? {}) as Record<string, unknown>;
        if (e.type === "permission.requested" && typeof d.requestId === "string") asked.set(d.requestId, d);
        else if (e.type === "permission.completed" && typeof d.requestId === "string") asked.delete(d.requestId);
      }
    }
    const config = owner.config();
    owner.session = o.resume
      ? await o.client.resumeSession(o.id, { ...config, continuePendingWork: true })
      : await o.client.createSession({ ...config, sessionId: o.id, ...(o.start?.name ? { name: o.start.name.slice(0, CODE_LIMITS.name) } : {}) });
    try {
      if (sandboxable) {
        const network = has("network");
        owner.network = network;
        const applied = await owner.session.rpc.options.update({ sandboxConfig: owner.sandboxConfig(o.denied) });
        if (!applied.success) throw new CodeUnavailable("Copilot couldn't turn on the sandbox that keeps Ember's data safe.");
        const status = await owner.session.rpc.sandbox.getEnforcementStatus();
        if (status.blocked) throw new CodeUnavailable("Copilot's sandbox is blocked for this session, so it won't run.");
        owner.sandbox = network ? "on" : "no-network";
        await owner.trustChanged();
      }
      // Restrict first, then the mode chosen (capped by the organisation).
      await owner.applyPermissionMode("manual");
      const wanted = o.start?.permissionMode ?? "manual";
      if (wanted !== "manual") await owner.setPermissionMode(wanted);
      if (o.start?.agentMode && o.start.agentMode !== "interactive") await owner.setAgentMode(o.start.agentMode);
      else owner.agentMode = await owner.session.rpc.mode.get();
      owner.name = ((await owner.session.rpc.name.get().catch(() => ({ name: "" }))).name ?? "").slice(0, CODE_LIMITS.name);
      owner.locationKey = (await owner.session.rpc.permissions.locations.resolve({ workingDirectory: o.folder }).catch(() => null))?.locationKey;
      const current = await owner.session.rpc.model.getCurrent().catch(() => null) as { modelId?: unknown } | null;
      if (typeof current?.modelId === "string") owner.model = current.modelId.slice(0, 200);
      // A permission request left waiting when the runtime last stopped: `continuePendingWork` doesn't emit it again
      // (runtime 1.0.97), but the runtime still takes its answer by id, so it is waiting here too.
      if (o.resume) await owner.recoverPending(asked);
      owner.o.onFacts();
      return owner;
    } catch (err) {
      await owner.close().catch(() => undefined);
      throw err;
    }
  }

  /** The sandbox Ember sets: on, no bypass, `denied` denied to the tools, outbound network where the host gives it. */
  private sandboxConfig(denied: readonly string[]) {
    return { enabled: true, allowBypass: false, userPolicy: { filesystem: { deniedPaths: [...denied] }, network: { allowOutbound: this.network } } };
  }

  /**
   * Sets the paths the sandbox denies again (another session's state folder appeared beside this one's: state.ts),
   * for the commands the tools start from now on; false when the sandbox didn't take it (the hub then closes the
   * session: fail closed). A session without a sandbox has nothing to set (its pre-tool hook judges every path).
   */
  async restrict(denied: readonly string[]): Promise<boolean> {
    if (this.closed || this.sandbox === "off") return true;
    const applied = await this.session.rpc.options.update({ sandboxConfig: this.sandboxConfig(denied) }).catch(() => ({ success: false }));
    return applied.success;
  }

  /** The SDK session's config: full Copilot mode, the session's folder, Ember's policy, hooks and handlers. */
  private config(): SessionConfig {
    const o = this.o;
    const s = o.start ?? {};
    const own: SessionPlace = { place: o.place, cwd: o.folder, own: [o.stateDir] };
    return {
      ...(s.model ?? o.access.model ? { model: s.model ?? o.access.model } : {}),
      ...(s.reasoningEffort ? { reasoningEffort: s.reasoningEffort as SessionConfig["reasoningEffort"] } : {}),
      ...(s.agent ? { agent: s.agent } : {}),
      ...(o.access.provider ? { provider: o.access.provider } : o.access.gitHubToken ? { gitHubToken: o.access.gitHubToken } : {}),
      workingDirectory: o.folder, streaming: true, enableSessionTelemetry: false,
      // Full Copilot mode, as the Copilot CLI runs it (docs/CODING-APP.md §2 "Full Copilot mode").
      enableFileChangeTracking: true, enableSkills: true, memory: { enabled: true }, enableOnDemandInstructionDiscovery: true,
      enableHostGitOperations: true, enableSessionStore: true, infiniteSessions: { enabled: true },
      // A repository's own hooks run commands: off until the sandbox is on and the user trusts the folder (trustChanged).
      enableFileHooks: false,
      ...(o.policy.managedSettings.permissions ? { managedSettings: o.policy.managedSettings } : {}),
      onEvent: e => this.ingest(e, true),
      // Answered by id from the event (respond): the handler has none to give, so the request stays pending.
      onPermissionRequest: () => ({ kind: "no-result" }),
      onUserInputRequest: () => this.declare("user-input") as never,
      onExitPlanModeRequest: () => this.declare("exit-plan-mode") as never,
      onAutoModeSwitchRequest: () => this.declare("auto-mode-switch") as never,
      onElicitationRequest: () => new Promise(resolve => { this.elicitWaiting.push({ resolve: resolve as (v: unknown) => void }); }) as never,
      onMcpAuthRequest: request => new Promise(resolve => { this.handlers.set(request.requestId, resolve as (v: unknown) => void); }) as never,
      hooks: {
        onPreToolUse: input => {
          if (this.halted || this.closed) return { permissionDecision: "deny", permissionDecisionReason: "The person stopped this session." };
          if (reachesEmberData(input.toolArgs, own) !== false) return { permissionDecision: "deny", permissionDecisionReason: CODE_REFUSALS.emberToolPath };
          return undefined;
        },
        // A tool's result that holds a value the vault filled reaches the model without it.
        onPostToolUse: input => {
          const r = o.redact;
          return r?.active && r.holds(input.toolResult) ? { modifiedResult: r.deep(input.toolResult) } : undefined;
        },
      },
    };
  }

  /**
   * Turns the folder's own hooks (`.github/hooks`) on once the user trusts the folder (`permissions.folderTrust`), and
   * only in the sandbox: they run commands of the repository's, which without it would reach Ember's data (probed on
   * runtime 1.0.97: sandboxed, they are denied it). The runtime loads them on the next message.
   */
  async trustChanged(): Promise<void> {
    if (this.closed || this.hooksOn || this.sandbox === "off") return;
    const trust = await this.session.rpc.permissions.folderTrust.isTrusted({ path: this.folder }).catch(() => ({ trusted: false }));
    if (!trust.trusted) return;
    const on = await this.session.rpc.options.update({ enableFileHooks: true }).catch(() => ({ success: false }));
    this.hooksOn = on.success;
  }

  /** Opens the permission requests the runtime still holds open after a resume (`permissions.pendingRequests`). */
  private async recoverPending(asked: ReadonlyMap<string, Record<string, unknown>>): Promise<void> {
    const open = await this.session.rpc.permissions.pendingRequests().catch(() => ({ items: [] as { requestId: string }[] }));
    for (const item of open.items ?? []) {
      if (typeof item.requestId !== "string" || this.pending.get(item.requestId)) continue;
      const data = asked.get(item.requestId);
      // Only a request whose own event the history holds: its choices and its answer are built from that event.
      if (data && (data.permissionRequest as { kind?: unknown } | undefined)?.kind) this.openEntry("permission", item.requestId, data);
    }
  }

  /** A handler that only declares a capability: it settles when the request is over (its answer went by id). */
  private declare(kind: keyof SessionRuntime["declared"]): Promise<unknown> {
    if (this.halted || this.closed) return Promise.reject(new Error("The person stopped this session."));
    return new Promise(resolve => { this.declared[kind].push(resolve); });
  }

  /** Requests waiting now. */
  requests(): CodePendingRequest[] { return this.pending.list(); }
  get waiting(): number { return this.pending.size; }

  /** One SDK event: numbered and passed on, with the facts and the pending table kept from it. */
  private ingest(e: SessionEvent, live: boolean): void {
    if (this.closed && live) return;
    const event = boundEvent(e as unknown as Parameters<typeof boundEvent>[0], this.redact);
    const envelope = this.o.log.add(event);
    if (live) this.observe(e);
    if (envelope) this.o.onEnvelope(envelope);
  }

  /** What an event says of the facts and the requests. */
  private observe(e: SessionEvent): void {
    const data = (e.data ?? {}) as Record<string, unknown>;
    const opens = REQUEST_EVENTS[e.type];
    if (opens) { this.opened(opens, data); return; }
    const ends = COMPLETION_EVENTS[e.type];
    if (ends) { this.completed(ends, data); return; }
    let changed = true;
    switch (e.type) {
      case "user.message": case "assistant.turn_start": this.busy = true; break;
      case "session.idle": this.busy = false; break;
      case "session.mode_changed": if (typeof data.newMode === "string") this.agentMode = data.newMode as CodeAgentMode; break;
      case "session.permissions_changed": if (typeof data.mode === "string") this.permissionMode = data.mode as CodePermissionMode; break;
      case "session.model_change": if (typeof data.newModel === "string") this.model = data.newModel.slice(0, 200); break;
      case "session.start": case "session.resume": if (typeof data.selectedModel === "string") this.model = data.selectedModel.slice(0, 200); break;
      case "session.title_changed": if (typeof data.title === "string" && !this.name) this.name = data.title.slice(0, CODE_LIMITS.name); break;
      default: changed = false;
    }
    if (changed) this.o.onFacts();
  }

  private opened(kind: CodeRequestKind, data: Record<string, unknown>): void {
    const requestId = typeof data.requestId === "string" ? data.requestId : null;
    if (!requestId) return;
    if (kind === "elicitation") {
      const waiting = this.elicitWaiting.shift();
      if (waiting) this.handlers.set(requestId, waiting.resolve);
    }
    if (kind === "permission") {
      const d = data as unknown as PermissionRequestedData;
      // The SDK's own hook decided it; its completion says how.
      if (d.resolvedByHook) return;
      if (this.halted || this.closed) { void this.rpcAnswer(requestId, "permission", { method: "permissions.handlePendingPermissionRequest", params: { requestId, result: STOPPED_DECISION } }, "system").catch(() => undefined); return; }
      if (this.permissionMode === "assisted" && judgeApproves(d)) {
        void this.rpcAnswer(requestId, "permission", { method: "permissions.handlePendingPermissionRequest", params: { requestId, result: wireApproval(d.permissionRequest), decisionContext: JUDGE_CONTEXT } }, "sdk")
          .catch(() => this.openEntry(kind, requestId, data));
        return;
      }
    }
    this.openEntry(kind, requestId, data);
  }

  private openEntry(kind: CodeRequestKind, requestId: string, data: Record<string, unknown>): void {
    const choices = kind === "permission" ? codeChoices((data as unknown as PermissionRequestedData).permissionRequest, { standing: this.o.policy.standing, ...(this.locationKey ? { locationKey: this.locationKey } : {}) }) : undefined;
    const view: CodePendingRequest = { sessionId: this.id, requestId, kind, data: boundData(data, this.redact).data, ...(choices ? { choices } : {}), openedAt: Date.now() };
    this.pending.open({ view, raw: data });
    this.o.onRequest(view);
    this.o.onFacts();
  }

  private completed(kind: CodeRequestKind, data: Record<string, unknown>): void {
    const requestId = typeof data.requestId === "string" ? data.requestId : null;
    if (kind === "user-input" || kind === "exit-plan-mode" || kind === "auto-mode-switch") {
      // The handler that declared it settles, with what was answered (the runtime already has it).
      const settle = this.declared[kind].shift();
      settle?.(kind === "user-input" ? { answer: String(data.answer ?? ""), wasFreeform: data.wasFreeform === true } : kind === "exit-plan-mode" ? { approved: data.approved === true } : (data.response ?? "no"));
    }
    if (!requestId) return;
    const by = this.answeredBy.get(requestId) ?? "sdk";
    this.answeredBy.delete(requestId);
    this.handlers.delete(requestId);
    const had = this.pending.take(requestId);
    if (kind === "permission") {
      const result = (data.result as { kind?: unknown } | undefined)?.kind;
      this.o.onDecided?.({ kind, decision: typeof result === "string" ? result.slice(0, 64) : "unknown", by });
    }
    if (had) {
      this.o.onRequest({ resolved: requestId, sessionId: this.id, by });
      this.o.onFacts();
    }
  }

  /**
   * Answers a pending request once, with the SDK's own shape for its kind (pending.ts `answerCall`). Throws
   * CodeUnavailable with a sentence where it isn't waiting, the answer isn't one it takes, or Stop holds.
   */
  async respond(requestId: string, kind: CodeRequestKind, payload: unknown, by: CodeActor): Promise<void> {
    const entry = this.pending.get(requestId);
    if (!entry || entry.view.kind !== kind) throw new CodeUnavailable(CODE_REFUSALS.request);
    const call = (() => {
      try { return answerCall(entry, payload, { standing: this.o.policy.standing, allowAll: this.o.policy.permissionModes.includes("allow-all"), ...(this.locationKey ? { locationKey: this.locationKey } : {}) }); }
      catch (err) { throw new CodeUnavailable(err instanceof AnswerRefused || err instanceof NotOffered ? err.message : CODE_REFUSALS.badArgs); }
    })();
    // Nothing is approved after Stop: only what refuses still goes through.
    if (this.halted && !refuses(call)) throw new CodeUnavailable(CODE_REFUSALS.stopped);
    // Answered once: from here no other answer finds it.
    this.pending.take(requestId);
    try {
      if (call.via === "handler") {
        const settle = this.handlers.get(requestId);
        this.answeredBy.set(requestId, by);
        if (settle) { this.handlers.delete(requestId); settle(call.value); }
        else if (call.kind === "elicitation") await this.rpcAnswer(requestId, kind, { method: "ui.handlePendingElicitation", params: { requestId, result: call.value } }, by);
        else await this.rpcAnswer(requestId, kind, { method: "mcp.oauth.handlePendingRequest", params: { requestId, result: call.value } }, by);
      } else {
        await this.rpcAnswer(requestId, kind, { method: call.method, params: call.params }, by);
      }
    } catch (err) {
      if (err instanceof CodeUnavailable) {
        // The runtime turned the answer down: the request is over, for every window.
        this.o.onRequest({ resolved: requestId, sessionId: this.id, by: "sdk" });
        this.o.onFacts();
      } else {
        // The answer didn't reach the runtime: the request is still waiting.
        this.answeredBy.delete(requestId);
        this.pending.open(entry);
      }
      throw err;
    }
    this.o.onRequest({ resolved: requestId, sessionId: this.id, by });
    this.o.onFacts();
  }

  /** Sends an answer by id through a session RPC; a refusal by the runtime ends the request (it is no longer waiting). */
  private async rpcAnswer(requestId: string, kind: CodeRequestKind, call: { method: string; params: unknown }, by: CodeActor | "sdk"): Promise<void> {
    this.answeredBy.set(requestId, by);
    const fn = rpcFn(this.session.rpc, call.method);
    if (!fn) throw new CodeUnavailable(CODE_REFUSALS.request);
    const sent = await fn(call.params) as { success?: unknown } | undefined;
    if (sent && sent.success === false) {
      this.pending.take(requestId);
      if (kind !== "permission" || by !== "system") throw new CodeUnavailable("Copilot didn't take that answer. The request may have ended.");
    }
  }

  /** Sends a message; a turn after Stop begins afresh. Returns the SDK's message id. */
  async send(m: { prompt: string; attachments?: CodeAttachment[]; mode?: "enqueue" | "immediate"; agentMode?: CodeAgentMode | "shell" }): Promise<string> {
    if (this.closed) throw new CodeUnavailable(CODE_REFUSALS.closed);
    if (!m.prompt.trim() && !m.attachments?.length) throw new CodeUnavailable(CODE_REFUSALS.prompt);
    this.halted = false;
    this.busy = true;
    this.o.onFacts();
    try {
      return await this.session.send({ prompt: m.prompt, ...(m.attachments?.length ? { attachments: m.attachments } : {}), ...(m.mode ? { mode: m.mode } : {}), ...(m.agentMode ? { agentMode: m.agentMode } : {}) });
    } catch (err) { this.busy = false; this.o.onFacts(); throw err; }
  }

  /** Stops the turn: `keepBackground` keeps background agents and shells running (interruptMainTurn). */
  async interrupt(keepBackground: boolean): Promise<void> {
    if (this.closed) throw new CodeUnavailable(CODE_REFUSALS.closed);
    if (keepBackground) await this.session.rpc.interruptMainTurn({});
    else await this.session.abort();
  }

  /** Sets the SDK's permission mode within the organisation's cap; returns the mode in force after. */
  async setPermissionMode(mode: CodePermissionMode): Promise<CodePermissionMode> {
    if (this.closed) throw new CodeUnavailable(CODE_REFUSALS.closed);
    if (!this.o.policy.permissionModes.includes(mode)) return this.permissionMode;
    return this.applyPermissionMode(mode);
  }

  private async applyPermissionMode(mode: CodePermissionMode): Promise<CodePermissionMode> {
    const result = await this.session.rpc.permissions.setMode({ mode });
    // A refused change leaves the old mode in force (runtime 1.0.97): one that asks less than the one asked for falls back to manual.
    if (!result.success && LOOSENESS[result.mode] > LOOSENESS[mode]) await this.session.rpc.permissions.setMode({ mode: "manual" });
    this.permissionMode = (await this.session.rpc.permissions.getMode()).mode;
    this.o.onFacts();
    return this.permissionMode;
  }

  /** Sets the SDK's agent mode; returns the mode in force after. */
  async setAgentMode(mode: CodeAgentMode): Promise<CodeAgentMode> {
    if (this.closed) throw new CodeUnavailable(CODE_REFUSALS.closed);
    await this.session.rpc.mode.set({ mode });
    this.agentMode = await this.session.rpc.mode.get();
    this.o.onFacts();
    return this.agentMode;
  }

  /** Names the session (the SDK's own name). */
  async rename(name: string): Promise<void> {
    if (this.closed) throw new CodeUnavailable(CODE_REFUSALS.closed);
    const n = name.trim().slice(0, CODE_LIMITS.name);
    await this.session.rpc.name.set({ name: n });
    this.name = n;
    this.o.onFacts();
  }

  /** A session RPC method by its dotted name (the hub has checked it against the allow-list and the guards). */
  async rpc(method: string, params: unknown): Promise<unknown> {
    if (this.closed) throw new CodeUnavailable(CODE_REFUSALS.closed);
    const fn = rpcFn(this.session.rpc, method);
    if (!fn) throw new CodeUnavailable(CODE_REFUSALS.rpcNotAllowed);
    return fn(params);
  }

  /** The SDK session's own events (the kept history, as the SDK has it). */
  history(): Promise<SessionEvent[]> {
    return this.o.readHistory ? this.o.readHistory(this.id) : readPersistedHistory(this.o.client, this.id);
  }

  /** A redacted, bounded copy of an SDK event, as windows get them (for history read again). */
  bounded(e: SessionEvent): CodeSdkEvent { return boundEvent(e as unknown as Parameters<typeof boundEvent>[0], this.redact); }

  /**
   * Stop: nothing more is approved and no tool starts until the next message; every pending request is refused (a
   * permission rejected, a plan not approved, a sign-in cancelled), the turn aborted and background agents cancelled,
   * all at once. The model's own question has no refusal: the abort ends it, and it is cleared here.
   */
  stop(): Promise<void> {
    this.halted = true;
    const work: Promise<unknown>[] = [];
    for (const entry of this.pending.all()) work.push(this.refuseOnStop(entry).catch(() => undefined));
    if (!this.closed && this.session) {
      work.push(this.session.abort().catch(() => undefined));
      work.push(this.session.rpc.cancelAllBackgroundAgents().catch(() => undefined));
    }
    return Promise.all(work).then(() => undefined);
  }

  private async refuseOnStop(entry: PendingEntry): Promise<void> {
    const { requestId, kind } = entry.view;
    this.pending.take(requestId);
    try {
      if (kind === "permission") await this.rpcAnswer(requestId, kind, { method: "permissions.handlePendingPermissionRequest", params: { requestId, result: STOPPED_DECISION } }, "system");
      else if (kind !== "user-input") {
        const call = answerCall(entry, stoppedAnswer(kind), { standing: false, allowAll: false });
        const settle = this.handlers.get(requestId);
        if (call.via === "handler" && settle) { this.handlers.delete(requestId); this.answeredBy.set(requestId, "system"); settle(call.value); }
        else if (call.via === "rpc") await this.rpcAnswer(requestId, kind, { method: call.method, params: call.params }, "system");
      }
    } finally {
      this.o.onRequest({ resolved: requestId, sessionId: this.id, by: "system" });
      this.o.onFacts();
    }
  }

  /** Stops and lets the session go; what the runtime keeps on disk stays, so it can be opened again. */
  async close(): Promise<void> {
    if (this.closed) return;
    let failure: unknown;
    try { await this.stop(); } catch (err) { failure = err; }
    this.closed = true;
    this.busy = false;
    for (const list of Object.values(this.declared)) for (const settle of list.splice(0)) settle(undefined);
    for (const w of this.elicitWaiting.splice(0)) w.resolve({ action: "cancel" });
    for (const settle of this.handlers.values()) settle({ kind: "cancelled" });
    this.handlers.clear();
    for (const e of this.pending.all()) this.o.onRequest({ resolved: e.view.requestId, sessionId: this.id, by: "system" });
    this.pending.clear();
    try { await this.session?.disconnect(); } catch (err) { failure ??= err; }
    this.o.onFacts();
    if (failure) throw failure;
  }
}

/** Whether an answer only refuses (what Stop still lets through). */
function refuses(call: ReturnType<typeof answerCall>): boolean {
  switch (call.via) {
    case "handler": return call.kind === "elicitation" ? call.value.action !== "accept" : call.value.kind === "cancelled";
    case "rpc":
      switch (call.method) {
        case "permissions.handlePendingPermissionRequest": return call.params.result.kind === "reject";
        case "ui.handlePendingExitPlanMode": return !call.params.response.approved;
        case "ui.handlePendingAutoModeSwitch": return call.params.response === "no";
        case "ui.handlePendingSessionLimitsExhausted": return call.params.response.action === "cancel";
        case "ui.handlePendingSampling": return call.params.response === undefined;
        default: return false;
      }
  }
}

/** Names that are an object's own machinery, never an RPC namespace or method. */
const FORBIDDEN_PARTS = new Set(["constructor", "prototype", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf", "propertyIsEnumerable", "toLocaleString", "call", "apply", "bind"]);

/** The function at a dotted path of an RPC object, bound to its namespace; undefined where there is none. */
export function rpcFn(root: unknown, method: string): ((params: unknown) => Promise<unknown>) | undefined {
  if (!/^[A-Za-z][A-Za-z0-9]*(\.[A-Za-z][A-Za-z0-9]*){0,3}$/.test(method)) return undefined;
  const parts = method.split(".");
  if (parts.some(p => FORBIDDEN_PARTS.has(p))) return undefined;
  let holder: unknown = root;
  for (const p of parts.slice(0, -1)) {
    if (!holder || (typeof holder !== "object" && typeof holder !== "function") || !Object.hasOwn(holder as object, p) && !(p in (holder as object))) return undefined;
    holder = (holder as Record<string, unknown>)[p];
  }
  const last = parts[parts.length - 1];
  if (!holder || (typeof holder !== "object" && typeof holder !== "function")) return undefined;
  const fn = (holder as Record<string, unknown>)[last];
  if (typeof fn !== "function") return undefined;
  return (params: unknown) => Promise.resolve((fn as (p: unknown) => unknown).call(holder, params));
}
