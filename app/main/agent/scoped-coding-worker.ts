/** A trusted custom-tool controller, isolated command copy and review export under one TaskManager lifetime. */
import type { ProviderConfig } from "@github/copilot-sdk";
import type { CodingResultSummary } from "../../shared/project-coding";
import type { CommandService, RunnerFacts, ShellId } from "../commands/types";
import { runCommandTool, type CommandFlowContext, type CommandConsentSource, type CommandTargetGuard } from "../commands/flow";
import { CustomCodingController, CodingControllerCleanupError, type CodingControllerResult, type CustomCodingControllerOptions } from "./custom-coding-controller";
import { ScopedCodingFiles } from "./scoped-coding-files";
import type { CodingCommandWorkspace, CodingReviewWorkspace, CodingWorkspaceReview, CodingPlatformAdapter, CodingFileBroker } from "./coding-platform";
import { IsolatedCodingCommandRunner } from "./isolated-coding-command-runner";
import type { PrivateControllerRuntimeInput } from "./private-controller-runtime";
import type { TaskSpec, WorkerResult } from "./worker";
import { handoffContext } from "./handoff-context";
import { CodingPrivacyCleanupError } from "./coding-privacy-scanner";

export interface ScopedCodingChecks { ran: number; passed: number; failed: number }
interface ScopedCodingWorkerBaseOptions {
  runtime: PrivateControllerRuntimeInput;
  model?: string | null;
  provider?: ProviderConfig;
  current(): boolean;
  reviewBase: string;
  /** The registry owns a separate captured account/project capability, including rejection and artifact cleanup. */
  publish(output: CodingWorkspaceReview, status: "done" | "failed" | "stopped", checks: ScopedCodingChecks): Promise<CodingResultSummary>;
  progress(text: string): void;
  beforeStart(): Promise<void>;
  onRetiring?(): void;
  onInvalidated?(): void;
  clarify?: CustomCodingControllerOptions["clarify"];
}
export interface ScopedCodingWorkerOptions extends ScopedCodingWorkerBaseOptions {
  mode?: "commands";
  /** Host-selected source, private paths and owner binding. No model-supplied path reaches this factory. */
  createWorkspace(signal: AbortSignal, admit: () => boolean): Promise<CodingCommandWorkspace>;
  /** Host-selected platform implementation; omission keeps the existing Linux backend/file facts. */
  platform?: CodingPlatformAdapter;
  commandService: CommandService;
  /** Called once. Its original words, refusals, taint, policy and mutable flow state survive every command. */
  commandContext(service: CommandService, signal: AbortSignal): CommandFlowContext;
}
export interface FileOnlyScopedCodingWorkerOptions extends ScopedCodingWorkerBaseOptions {
  mode: "files-only";
  createWorkspace(signal: AbortSignal, admit: () => boolean): Promise<CodingReviewWorkspace>;
  platform: Pick<CodingPlatformAdapter, "files">;
  commandService?: never;
  commandContext?: never;
}
export type CodingWorkerOptions = ScopedCodingWorkerOptions | FileOnlyScopedCodingWorkerOptions;

/** Copy the existing service's live policy/capabilities, while replacing every executable runner entry point. */
function isolatedService(source: CommandService, runner: IsolatedCodingCommandRunner, shells: readonly ShellId[]): CommandService {
  const service: CommandService & Partial<CommandConsentSource & CommandTargetGuard> = {
    binding: structuredClone(source.binding), runner, window: source.window, shells: () => [...shells],
    capability: () => source.capability(), consented: () => source.consented(), userAskEvery: () => source.userAskEvery(), mode: () => source.mode(),
  };
  const extra = source as CommandService & Partial<CommandConsentSource & CommandTargetGuard>;
  if (extra.consentPanel) service.consentPanel = extra.consentPanel.bind(source);
  if (extra.othersNamed) service.othersNamed = extra.othersNamed.bind(source);
  if (extra.placesNamed) service.placesNamed = extra.placesNamed.bind(source);
  return service;
}

export class ScopedCodingWorker {
  private readonly lifetime = new AbortController();
  private workspace: CodingReviewWorkspace | null = null;
  private controller: CustomCodingController | null = null;
  private runner: IsolatedCodingCommandRunner | null = null;
  private files: CodingFileBroker | null = null;
  private runPromise: Promise<WorkerResult> | null = null;
  private disposing: Promise<void> | null = null;
  private stopProofs: Promise<void>[] = [];
  private watch: ReturnType<typeof setInterval> | null = null;
  private retired = false;
  private invalid = false;
  private commandFailed = false;
  private commandStopped = false;
  private cleanupFailed = false;
  private completed = false;
  private settled = false;
  private finishDisposed!: (ok: boolean) => void;
  readonly disposed = new Promise<boolean>(resolve => { this.finishDisposed = resolve; });

  constructor(private readonly spec: TaskSpec, private readonly o: CodingWorkerOptions) {}
  get sessionId(): null { return null; }
  async steer(): Promise<boolean> { return false; }
  /** Read after dispose; independent of whether the completed work may hand off successfully. */
  cleanupComplete(): boolean { return this.settled && !this.cleanupFailed; }
  handoffSafe(): boolean {
    if (!this.current()) this.completed = false;
    return this.completed && this.settled && !this.cleanupFailed;
  }

  private current = (): boolean => {
    try { return !this.lifetime.signal.aborted && !this.invalid && this.o.current() === true; } catch { return false; }
  };
  private requireCurrent(): void {
    if (!this.current()) throw new Error("The coding task is no longer current.");
  }
  private retiring(): void {
    if (this.retired) return;
    this.retired = true;
    try { this.o.onRetiring?.(); } catch { this.cleanupFailed = true; }
  }
  /** Host invalidation is synchronous; the watcher is only a second check for missed notifications. */
  invalidate(): void {
    if (!this.invalid) { this.invalid = true; try { this.o.onInvalidated?.(); } catch { this.cleanupFailed = true; } }
    this.stop();
  }
  /** Stops task admission immediately, while recording the asynchronous proof which disposal must await. */
  stop(): void {
    this.completed = false;
    this.retiring();
    this.lifetime.abort();
    if (this.workspace) {
      const proof = this.workspace.stop(); this.stopProofs.push(proof); void proof.catch(() => undefined);
    }
    if (this.runner) { const proof = this.runner.stopAll("killswitch"); this.stopProofs.push(proof); void proof.catch(() => undefined); }
    void this.controller?.stop().catch(() => undefined);
  }

  run(signal: AbortSignal): Promise<WorkerResult> {
    if (this.runPromise) return Promise.resolve({ success: false, summary: "This coding task has already run." });
    if (this.disposing) return Promise.resolve({ success: false, stopped: true, summary: "Stopped." });
    this.runPromise = this.perform(signal);
    return this.runPromise;
  }

  private async perform(signal: AbortSignal): Promise<WorkerResult> {
    const stop = () => this.stop();
    signal.addEventListener("abort", stop, { once: true });
    let result: CodingControllerResult = { success: false, summary: "The coding task could not be completed safely." };
    let published = false, pipelineFailed = false;
    try {
      if (signal.aborted) this.stop();
      this.requireCurrent();
      if (this.o.mode !== undefined && this.o.mode !== "commands" && this.o.mode !== "files-only") throw new Error("The coding capability is invalid.");
      if (this.o.mode === "files-only" && (this.o.commandService !== undefined || this.o.commandContext !== undefined || typeof this.o.platform?.files !== "function")) throw new Error("The coding capability is invalid.");
      // Capture execution authority before startup can wait. A later caller mutation cannot upgrade this task.
      const commands = this.o.mode === "files-only" ? null : { service: this.o.commandService, context: this.o.commandContext,
        facts: this.o.platform?.facts.bind(this.o.platform), createWorkspace: this.o.createWorkspace.bind(this.o) };
      const files = this.o.platform?.files.bind(this.o.platform);
      const createWorkspace = this.o.createWorkspace.bind(this.o);
      this.watch = setInterval(() => { if (!this.current() && !this.lifetime.signal.aborted) this.invalidate(); }, 100);
      this.watch.unref?.();
      await this.o.beforeStart(); this.requireCurrent();
      let commandWorkspace: CodingCommandWorkspace | null = null;
      this.workspace = commands === null ? await createWorkspace(this.lifetime.signal, this.current)
        : commandWorkspace = await commands.createWorkspace(this.lifetime.signal, this.current);
      if (!this.current()) { this.stop(); this.requireCurrent(); }
      const controller = { runtime: this.o.runtime, ...(this.o.model ? { model: this.o.model } : {}),
        ...(this.o.provider ? { provider: this.o.provider } : {}),
        current: this.current, signal: this.lifetime.signal, progress: this.o.progress, clarify: this.o.clarify,
        files: async (controllerSignal: AbortSignal) => {
          this.requireCurrent();
          const signal = AbortSignal.any([controllerSignal, this.lifetime.signal]);
          this.files = files ? await files(this.workspace!, signal) : await ScopedCodingFiles.create({ workspace: this.workspace!, signal });
          this.requireCurrent(); return this.files;
        },
        finishCheck: () => this.workspace!.files(async () => this.current() && (commands === null ? this.runner === null : this.runner !== null && this.runner.running === 0)),
      };
      if (commands === null) this.controller = await CustomCodingController.start({ ...controller, mode: "files-only" });
      else {
        if (!commandWorkspace) throw new Error("The coding command workspace is unavailable.");
        const original = commands.service;
        if (original.binding.id !== "local" || original.binding.kind !== "local") throw new Error("Coding requires the local command service.");
        const hostFacts = await original.runner.facts(); this.requireCurrent();
        const facts: RunnerFacts = commands.facts?.(commandWorkspace, hostFacts) ?? { ...hostFacts, os: "linux", home: "/state", shells: ["bash"], shellPaths: { bash: "/usr/bin/bash" }, script: null, pty: false, extraPath: [] };
        if (!facts.shells.length || facts.shells.some(shell => !["bash", "sh", "zsh", "powershell"].includes(shell))) throw new Error("The coding platform has no supported command shell.");
        this.runner = new IsolatedCodingCommandRunner({ workspace: commandWorkspace, facts, signal: this.lifetime.signal,
          current: this.current, inspect: (paths, cwd) => this.files ? this.files.inspect(paths, cwd) : Promise.resolve(paths.map(() => ({ exists: null, real: null }))) });
        const service = isolatedService(original, this.runner, facts.shells), context = commands.context(service, this.lifetime.signal);
        context.state.cwd = this.workspace.executionRoot;
        this.controller = await CustomCodingController.start({ ...controller, commands: { target: service.binding.label, shells: facts.shells },
        runCommand: async (args, tool) => {
          this.requireCurrent();
          const combined = AbortSignal.any([context.signal, tool.signal, this.lifetime.signal]);
          const sequence = this.runner!.sequence;
          const output = await runCommandTool(args, { ...context, service, signal: combined,
            isOver: () => combined.aborted || !this.current() || context.isOver(),
            confirmer: { ...context.confirmer, ask: (question, askSignal) => tool.waiting(() => context.confirmer.ask(question,
              askSignal ? AbortSignal.any([combined, askSignal]) : combined)) },
          });
          const exits = this.runner!.exitsAfter(sequence);
          const observed = exits.length === 1 ? exits[0] : null;
          if (observed && observed.exit.ended === "exit" && typeof observed.exit.code === "number" && !observed.exit.outputCut && !observed.exit.endLost && /^[0-9a-f]{64}$/.test(observed.checkKey)) {
            return { result: output, success: observed.exit.code === 0, check: { key: observed.checkKey, passed: observed.exit.code === 0 } };
          }
          this.commandFailed = true;
          this.commandStopped = !!observed && ["stopped-user", "stopped-task", "killswitch"].includes(observed.exit.ended);
          this.stop();
          return { result: output, success: false };
        },
        });
      }
      this.requireCurrent();
      result = await this.controller.run(this.spec.goal + handoffContext(this.spec.handoffSummary), this.lifetime.signal);
    } catch (error) {
      pipelineFailed = true;
      if (error instanceof CodingControllerCleanupError || error instanceof CodingPrivacyCleanupError) this.cleanupFailed = true;
      if (this.invalid) result = { success: false, stopped: true, summary: "The coding context changed, so I stopped this task." };
      else if (signal.aborted || (this.lifetime.signal.aborted && !this.commandFailed)) result = { success: false, stopped: true, summary: "Stopped." };
      else if (this.commandFailed) result = { success: false, summary: "A command was refused, stopped or could not be fully observed. The coding task stopped." };
    } finally {
      this.retiring();
      let stopped = true;
      try { await this.controller?.close(); } catch { this.cleanupFailed = true; stopped = false; }
      try { await this.files?.close(); } catch { this.cleanupFailed = true; stopped = false; }
      try { await this.runner?.stopAll("quit"); await this.workspace?.stop(); await Promise.all(this.stopProofs); }
      catch { this.cleanupFailed = true; stopped = false; }
      if (this.workspace && stopped && !this.cleanupFailed) {
        try {
          // This host-only seal cannot be inferred from a model result, idle event or Stop request.
          await this.workspace.sealForReview?.();
          const output = await this.workspace.exportReview(this.o.reviewBase);
          const exits = this.runner?.exitsAfter(0).filter(item => item.exit.ended === "exit" && typeof item.exit.code === "number" && !item.exit.outputCut && !item.exit.endLost) ?? [];
          const checks = { ran: exits.length, passed: exits.filter(item => item.exit.code === 0).length, failed: exits.filter(item => item.exit.code !== 0).length };
          if (!this.current() && !this.lifetime.signal.aborted) this.invalidate();
          const changed = this.invalid || signal.aborted || this.commandStopped || (this.lifetime.signal.aborted && !this.commandFailed);
          await this.o.publish(output, changed ? "stopped" : result.success && !pipelineFailed && !this.commandFailed ? "done" : "failed", checks);
          published = true;
        } catch (error) { if (error instanceof CodingPrivacyCleanupError) this.cleanupFailed = true; pipelineFailed = true; }
      }
      try { await this.workspace?.close(); } catch { this.cleanupFailed = true; }
      if (!this.current() && !this.lifetime.signal.aborted) this.invalidate();
      try { await Promise.all(this.stopProofs); } catch { this.cleanupFailed = true; }
      if (this.watch) clearInterval(this.watch); this.watch = null;
      signal.removeEventListener("abort", stop);
      this.settled = true;
      this.completed = result.success && !pipelineFailed && published && !this.cleanupFailed && !this.lifetime.signal.aborted && !this.invalid;
      this.finishDisposed(!this.cleanupFailed);
    }
    if (this.cleanupFailed) return { success: false, summary: "The coding session could not be verified as closed. Further coding work is blocked." };
    if (!published && this.workspace) return { success: false, ...(result.stopped ? { stopped: true } : {}), summary: "The coding task ended, but its review could not be published. The original folder is unchanged." };
    if (this.invalid) return { success: false, stopped: true, summary: "The coding context changed, so I stopped this task." };
    if (this.commandFailed) return { success: false, ...(this.commandStopped ? { stopped: true } : {}), summary: "A command was refused, stopped or could not be fully observed. The coding task stopped." };
    if (pipelineFailed && result.success) return { success: false, summary: "The coding result could not be prepared for review. The original folder is unchanged." };
    return { ...result, success: this.completed };
  }

  dispose(): Promise<void> {
    if (!this.disposing) {
      if (!this.settled) this.stop();
      this.disposing = (async () => {
        if (this.runPromise) await this.runPromise;
        else { this.settled = true; this.finishDisposed(!this.cleanupFailed); }
        if (this.cleanupFailed) throw new Error("The coding session could not be verified as closed.");
      })();
    }
    return this.disposing;
  }
}
