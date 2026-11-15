/** A project session backed by the Copilot runtime's own coding tools. */
import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { defineTool, type CopilotClient, type CopilotSession, type PermissionHandler, type ProviderConfig, type SessionConfig, type SessionEvent } from "@github/copilot-sdk";
import { z } from "zod";
import type { ModeInForce } from "../../shared/approvals";
import type { PreToolUseHookInput } from "./session-config";
import { CodingCompletion } from "./coding-completion";

export interface CodingSessionOptions {
  client: CopilotClient;
  workspace: string;
  /** Absolute paths containing Ember's private data, executable, and policy state. */
  protectedPaths: string[];
  model?: string;
  provider?: ProviderConfig;
  /** GitHub auth is sent to this session by RPC, never added to the runtime's inherited environment. */
  gitHubToken?: string;
  mode: ModeInForce;
  /** Only true when no user or organisation rule requires an explicit decision. */
  canAllowAll?: boolean;
  permission: PermissionHandler;
  /** Inspect every native tool call before it runs. Return a denial reason or null; it cannot grant permissions. */
  preToolUse: (input: PreToolUseHookInput) => string | null | Promise<string | null>;
  onUserInputRequest?: SessionConfig["onUserInputRequest"];
  onEvent?: (event: SessionEvent) => void;
  signal?: AbortSignal;
  /** The caller must bind a saved session id to this exact workspace before resuming it. */
  resumeId?: string;
  /** Keep the SDK session on close so the caller can resume it later. */
  retain?: boolean;
  /** A coding-first mixed task needs an explicit, standalone completion before a desktop handoff. */
  requireCompletion?: boolean;
}

export interface CodingModeStatus {
  requested: ModeInForce;
  permissionMode: "manual" | "assisted" | "allow-all";
  warning?: string;
}

/** Validate a project folder; this is a working directory, not a filesystem sandbox. */
export async function codingWorkspace(folder: string): Promise<string> {
  if (!path.isAbsolute(folder)) throw new Error("Choose an absolute project folder.");
  const resolved = await fs.realpath(folder);
  if (!(await fs.stat(resolved)).isDirectory()) throw new Error("Choose a project folder.");
  return resolved;
}

/** A stopped or mode-changing run cannot grant a pending SDK permission. */
export class CodingSession {
  readonly sessionId: string;
  readonly workspace: string;
  private stopped = false;
  private closed = false;
  private running = false;
  private generation = 0;
  private modeReady = false;
  private nativeAuto = false;
  private sandboxWarning: string | undefined;
  private complete: Extract<SessionEvent, { type: "session.task_complete" }>["data"] | null = null;
  private completion: CodingCompletion | null = null;
  private currentRun: AbortController | null = null;
  private abortPending: Promise<void> | null = null;
  private abortFailure: Error | null = null;
  private modeQueue: Promise<void> = Promise.resolve();
  private readonly off: () => void;
  modeStatus: CodingModeStatus = { requested: "asking", permissionMode: "manual" };

  private constructor(private readonly session: CopilotSession, private readonly client: CopilotClient, private readonly retain: boolean, workspace: string, private readonly notify?: (event: SessionEvent) => void) {
    this.workspace = workspace;
    this.sessionId = session.sessionId;
    this.off = session.on(event => {
      if (this.closed || this.stopped || !this.running) return;
      this.completion?.event(event);
      if (event.type === "session.task_complete" && !event.agentId) this.complete = event.data;
      this.notify?.(event);
    });
  }

  static async create(o: CodingSessionOptions): Promise<CodingSession> {
    const workspace = await codingWorkspace(o.workspace);
    o.signal?.throwIfAborted();
    if (typeof o.preToolUse !== "function") throw new Error("Coding requires a tool safety guard.");
    if (o.provider && o.gitHubToken) throw new Error("A coding session cannot use both a provider and a GitHub token.");
    if (!o.protectedPaths.length || o.protectedPaths.some(p => !path.isAbsolute(p))) throw new Error("Coding requires the paths of Ember's protected data.");
    const protectedPaths = [...new Set((await Promise.all(o.protectedPaths.map(protectedPath))).flat())];
    const support = await abortable(o.client.rpc.sandbox.getHostSupport(), o.signal);
    const has = (name: string) => support.capabilities.some(c => c.name === name && c.supported);
    if (!support.supported || !has("shell") || !has("denied_paths")) {
      throw new Error("Coding requires a supported Copilot sandbox that can protect Ember's data.");
    }
    const network = has("network");
    // The SDK handlers close over the owner, which only exists after createSession settles.
    // eslint-disable-next-line prefer-const
    let owner: CodingSession | undefined;
    const id = o.resumeId ?? `ember-coding-${crypto.randomUUID()}`;
    const finishSchema = z.object({ success: z.boolean(), summary: z.string().trim().min(1).max(2000) });
    const finishTool = defineTool("finish_coding", {
      description: "Report whether the coding part of the user's mixed task succeeded. Call it alone after all tools finish. If any part is incomplete or a step failed, set success to false and explain what remains.",
      parameters: finishSchema, skipPermission: true, defer: "never",
      handler: (raw, invocation) => {
        const parsed = finishSchema.safeParse(raw);
        if (!parsed.success || !owner?.running || owner.stopped || !owner.completion?.finish(invocation?.toolCallId, parsed.data.success, parsed.data.summary)) {
          return "The result was not accepted. Call finish_coding alone, after all work has finished, with a valid success and summary.";
        }
        return "Coding result recorded.";
      },
    });
    const config: SessionConfig = {
      sessionId: id,
      ...(o.model ? { model: o.model } : {}), ...(o.provider ? { provider: o.provider } : {}), ...(o.gitHubToken ? { gitHubToken: o.gitHubToken } : {}),
      workingDirectory: workspace, streaming: true, enableSessionTelemetry: false,
      // Do not implicitly load project-configured integrations; only the runtime's built-in tools are offered.
      enableConfigDiscovery: false, availableTools: o.requireCompletion ? ["builtin:*", "custom:finish_coding"] : ["builtin:*"], infiniteSessions: { enabled: true },
      ...(o.requireCompletion ? {
        tools: [finishTool],
        systemMessage: { mode: "append" as const, content: "This coding task is the first part of a larger user request. When all coding work is finished, call finish_coding alone with success true only if the requested coding part is complete. Otherwise use success false and say what remains. Do not call other tools after finish_coding. In Autopilot, call task_complete after finish_coding." },
      } : {}),
      hooks: { onPreToolUse: async input => {
        const generation = owner?.generation;
        if (!owner || owner.closed || owner.stopped || !owner.running) return { permissionDecision: "deny", permissionDecisionReason: "The coding task is no longer running." };
        let denial: string | null;
        try { denial = await o.preToolUse(input); }
        catch { owner.completion?.deny(); return { permissionDecision: "deny", permissionDecisionReason: "The coding tool safety check failed." }; }
        if (owner.closed || owner.stopped || !owner.running || generation !== owner.generation) return { permissionDecision: "deny", permissionDecisionReason: "The coding task or mode changed." };
        if (denial) owner.completion?.deny();
        return denial ? { permissionDecision: "deny", permissionDecisionReason: denial } : undefined;
      } },
      onPermissionRequest: async (request, invocation) => {
        const generation = owner?.generation;
        if (!owner || owner.closed || owner.stopped || !owner.running) return { kind: "reject", feedback: "The task is no longer running." };
        let result: Awaited<ReturnType<PermissionHandler>>;
        try { result = await o.permission(request, invocation); }
        catch (error) { owner.completion?.deny(); throw error; }
        if (owner.closed || owner.stopped || !owner.running || generation !== owner.generation) return { kind: "reject", feedback: "The task or approval mode changed." };
        if (result.kind !== "approved" && result.kind !== "attributed") owner.completion?.deny();
        if (result.kind === "attributed" && result.result.kind !== "approved") owner.completion?.deny();
        // Runtime 1.0.97 accepts the SDK's documented `approved` for custom tools, but its built-in tools expect
        // `approve-once`. Keep this compatibility shim at the boundary until the bundled SDK/runtime agree.
        if (request.kind !== "custom-tool" && result.kind === "approved") return { kind: "approve-once" } as unknown as typeof result;
        return result;
      },
      ...(o.onUserInputRequest ? { onUserInputRequest: async (request, invocation) => {
        const generation = owner?.generation;
        if (!owner || owner.closed || owner.stopped || !owner.running) throw new Error("The task is no longer running.");
        const result = await o.onUserInputRequest!(request, invocation);
        if (owner.closed || owner.stopped || !owner.running || generation !== owner.generation) throw new Error("The task or mode changed.");
        return result;
      } } : {}),
    };
    const making = o.resumeId ? o.client.resumeSession(o.resumeId, { ...config, continuePendingWork: false }) : o.client.createSession(config);
    // Stop while creation is in flight: a late session must not be left running.
    let session: CopilotSession;
    try {
      session = await abortable(making, o.signal);
    } catch (err) {
      const drop = () => { if (!o.resumeId) void o.client.deleteSession(id).catch(() => undefined); };
      drop();
      void making.then(s => { void s.disconnect().catch(() => undefined); drop(); }, () => undefined);
      throw err;
    }
    owner = new CodingSession(session, o.client, o.retain === true, workspace, o.onEvent);
    if (o.requireCompletion) owner.completion = new CodingCompletion();
    try {
      o.signal?.throwIfAborted();
      const sandbox = await session.rpc.options.update({ sandboxConfig: {
        enabled: true, allowBypass: false,
        userPolicy: { filesystem: { deniedPaths: protectedPaths }, network: { allowOutbound: network } },
      } });
      if (!sandbox.success) throw new Error("Copilot could not enable the coding sandbox.");
      if (!network) owner.sandboxWarning = "This computer's coding sandbox cannot access the network.";
      await owner.setMode(o.mode, o.canAllowAll === true);
      o.signal?.throwIfAborted();
      return owner;
    } catch (err) {
      await owner.close();
      throw err;
    }
  }

  /** A mode switch cancels an in-flight run before changing native permissions. */
  setMode(mode: ModeInForce, canAllowAll = false): Promise<CodingModeStatus> {
    if (this.closed) throw new Error("This coding session is closed.");
    this.modeReady = false;
    const cancelling = this.stop();
    // A prior mode transition may be waiting; attach rejection handling while this request is queued.
    void cancelling.catch(() => undefined);
    const generation = this.generation;
    const result = this.modeQueue.then(async () => {
      await cancelling;
      if (this.closed || generation !== this.generation) throw new Error("The coding task or mode changed.");
      return this.applyMode(mode, canAllowAll, generation);
    });
    this.modeQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async applyMode(mode: ModeInForce, canAllowAll: boolean, generation: number): Promise<CodingModeStatus> {
    this.stopped = false;
    // Restrict first, including when moving from allow-all; do not start another run on a partial transition.
    const manual = await this.session.rpc.permissions.setMode({ mode: "manual" });
    if (!manual.success || manual.mode !== "manual") throw new Error("Copilot could not set the permission mode.");
    const auto = mode === "autopilot";
    const changed = await this.session.rpc.mode.set({ mode: auto ? "autopilot" : "interactive" });
    if (changed.modeApplied === false || changed.deferImplementation || await this.session.rpc.mode.get() !== (auto ? "autopilot" : "interactive")) {
      throw new Error("Copilot could not set the agent mode.");
    }
    const options = await this.session.rpc.options.update({ askUserDisabled: auto, continueOnAutoMode: auto });
    if (!options.success) throw new Error("Copilot could not update the agent options.");
    let permissionMode: CodingModeStatus["permissionMode"] = "manual";
    let warning: string | undefined;
    const wanted = mode === "assisted" ? "assisted" : auto && canAllowAll ? "allow-all" : "manual";
    if (this.closed || generation !== this.generation) throw new Error("The coding task or mode changed.");
    if (wanted !== "manual") {
      const result = await this.session.rpc.permissions.setMode({ mode: wanted });
      if (result.success && result.mode === wanted) permissionMode = wanted;
      else {
        const fallback = await this.session.rpc.permissions.setMode({ mode: "manual" });
        if (!fallback.success || fallback.mode !== "manual") throw new Error("Copilot could not set the permission mode.");
        warning = `${wanted === "assisted" ? "Assisted review" : "Automatic approval"} is unavailable for this session; permission requests need a decision.`;
      }
    }
    if (this.closed || generation !== this.generation) throw new Error("The coding task or mode changed.");
    this.nativeAuto = auto;
    const note = [warning, this.sandboxWarning].filter(Boolean).join(" ");
    this.modeStatus = { requested: mode, permissionMode, ...(note ? { warning: note } : {}) };
    this.modeReady = true;
    return this.modeStatus;
  }

  async run(prompt: string, signal?: AbortSignal): Promise<string> {
    if (this.closed || !this.modeReady) throw new Error("The coding session is not ready.");
    if (this.abortPending) await this.abortPending;
    if (this.closed || !this.modeReady) throw new Error("The coding session is not ready.");
    if (this.running) throw new Error("A coding task is already running.");
    if (!prompt.trim()) throw new Error("Enter a request.");
    signal?.throwIfAborted();
    this.stopped = false;
    this.running = true;
    this.complete = null;
    if (this.completion) this.completion = new CodingCompletion();
    const local = new AbortController();
    this.currentRun = local;
    const abort = () => { void this.stop().catch(() => undefined); };
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (this.nativeAuto) return await this.runAutopilot(prompt, local.signal);
      const reply = await abortable(this.session.sendAndWait({ prompt }, 30 * 60_000), local.signal);
      if (this.stopped || signal?.aborted) throw new Error("The coding task stopped.");
      return reply?.data.content ?? "";
    } catch (err) {
      // SDK sendAndWait timeouts do not stop the runtime: never leave a failed task executing in the background.
      await this.stop();
      throw err;
    } finally {
      signal?.removeEventListener("abort", abort);
      this.currentRun = null;
      this.running = false;
    }
  }

  /** Only a clean explicit result may authorize the next part of a mixed task. */
  handoffResult(): { success: boolean; summary: string } | null {
    return this.stopped || this.closed || this.running ? null : this.completion?.result() ?? null;
  }

  /** SDK sendAndWait intentionally ignores Autopilot idle events. Wait for root completion and then idle ourselves. */
  private async runAutopilot(prompt: string, signal: AbortSignal): Promise<string> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let remove: () => void = () => undefined;
    const complete = new Promise<string>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("The coding task timed out.")), 30 * 60_000);
      timer.unref?.();
      remove = this.session.on(event => {
        if (event.agentId) return;
        if (event.type === "session.error") reject(new Error("Copilot could not finish the coding task."));
        if (event.type === "session.idle" && this.complete) {
          if (this.complete.success === false || (this.completion && (this.complete.success !== true || (this.complete.outcome !== undefined && this.complete.outcome !== "completed")))) reject(new Error(this.complete.summary || "Copilot could not complete the coding task."));
          else resolve(this.complete.summary || "Task complete.");
        }
      });
    });
    try {
      const [, result] = await Promise.all([this.session.send({ prompt }), abortable(complete, signal)]);
      if (this.stopped || signal.aborted) throw new Error("The coding task stopped.");
      return result;
    } finally {
      remove();
      if (timer) clearTimeout(timer);
    }
  }

  async stop(): Promise<void> {
    const alreadyStopped = this.stopped;
    this.stopped = true;
    this.generation++;
    this.currentRun?.abort();
    if (this.running && !alreadyStopped && !this.abortPending) {
      this.abortPending = this.session.abort().catch(() => {
        this.abortFailure = new Error("Copilot did not confirm the coding task stopped.");
        this.modeReady = false;
        throw this.abortFailure;
      }).finally(() => { this.abortPending = null; });
    }
    if (this.abortPending) await this.abortPending;
    if (this.abortFailure) throw this.abortFailure;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.modeReady = false;
    let failure: unknown;
    try { await this.stop(); } catch (err) { failure = err; }
    await this.modeQueue;
    this.off();
    try { await this.session.disconnect(); }
    catch (err) { failure ??= err; }
    try { if (!this.retain) await this.client.deleteSession(this.sessionId); }
    catch (err) { failure ??= err; }
    if (failure) throw failure;
  }
}

/** Include the lexical path and the real path of any existing ancestor to cover ordinary symlink aliases. */
async function protectedPath(input: string): Promise<string[]> {
  const absolute = path.resolve(input);
  let current = absolute;
  const tail: string[] = [];
  for (;;) {
    try { return [absolute, path.join(await fs.realpath(current), ...tail.reverse())]; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      tail.push(path.basename(current));
      current = parent;
    }
  }
}

function abortable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return work;
  return new Promise((resolve, reject) => {
    const stop = () => { cleanup(); reject(new Error("The coding task stopped.")); };
    const cleanup = () => signal.removeEventListener("abort", stop);
    if (signal.aborted) { void work.catch(() => undefined); stop(); return; }
    signal.addEventListener("abort", stop, { once: true });
    work.then(value => { cleanup(); resolve(value); }, err => { cleanup(); reject(err); });
  });
}
