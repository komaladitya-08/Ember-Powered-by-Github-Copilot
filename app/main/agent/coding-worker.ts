/** Adapts a native Copilot coding session to Ember's task cards and Stop lifecycle. */
import type { ProviderConfig } from "@github/copilot-sdk";
import type { ModeInForce } from "../../shared/approvals";
import type { Confirmer } from "./confirm";
import type { OS } from "../../shared/shortcuts";
import type { ClassifyContext } from "../commands/types";
import { CodingSession } from "./coding-session";
import { CodingRuntime, CodingRuntimeCleanupError, type CodingRuntimeInput } from "./coding-runtime";
import { codingRecommendations, createCodingPermissionHandler } from "./coding-permission";
import { createCodingSafety } from "./coding-safety";
import { handoffContext } from "./handoff-context";
import type { TaskSpec, WorkerResult } from "./worker";

/** The prompt must show the model's exact question and choices; never truncate them into different meanings. */
export function validCodingClarification(request: { question: string; choices?: string[]; allowFreeform?: boolean }): boolean {
  return typeof request.question === "string" && request.question.trim().length > 0 && request.question.length <= 2000 &&
    (request.choices === undefined || (Array.isArray(request.choices) && request.choices.length <= 20 &&
      request.choices.every(choice => typeof choice === "string" && choice.length > 0 && choice.length <= 200))) &&
    (request.allowFreeform !== false || !!request.choices?.length);
}

export interface CodingWorkerOptions {
  runtime: CodingRuntimeInput;
  /** Sign-in for a GitHub session only; never passed in the runtime's environment. */
  gitHubToken?: string;
  model: string | null;
  provider?: ProviderConfig;
  mode(): ModeInForce;
  onModeChange?(notify: () => void): () => void;
  confirmer: Pick<Confirmer, "ask">;
  commandPolicy(): { state: "on" | "off" | "needs-consent"; askEvery: boolean };
  home: string;
  os: OS;
  ember(): Promise<ClassifyContext["ember"]>;
  progress(text: string): void;
  beforeStart(): Promise<void>;
  /** Hold new coding work as soon as this runtime begins stopping. */
  onRetiring?(): void;
  clarify?: (request: { question: string; choices?: string[]; allowFreeform?: boolean }, signal: AbortSignal) => Promise<{ answer: string; wasFreeform: boolean } | null>;
}

export class CodingWorker {
  private session: CodingSession | null = null;
  private completedForHandoff = false;
  private runtime: CodingRuntime | null = null;
  private unsafeCleanup = false;
  private finishDisposed!: (ok: boolean) => void;
  /** Settles only after the runtime session has disconnected and its abort has completed. */
  readonly disposed = new Promise<boolean>(resolve => { this.finishDisposed = resolve; });
  constructor(private readonly spec: TaskSpec, private readonly o: CodingWorkerOptions) {}
  // This worker owns and deletes its session in a separate runtime, not the host's shared runtime.
  get sessionId(): null { return null; }

  async run(signal: AbortSignal): Promise<WorkerResult> {
    this.completedForHandoff = false;
    const workspace = this.spec.codingWorkspace;
    if (!workspace || !workspace.current()) return { success: false, summary: "The coding workspace changed. Choose it again before starting." };
    const startingMode = this.o.mode();
    const local = new AbortController();
    let invalid = "";
    const stop = () => { this.o.onRetiring?.(); local.abort(); };
    signal.addEventListener("abort", stop, { once: true });
    const check = () => {
      try {
        if (!workspace.current()) { invalid = "The coding workspace changed, so I stopped this task."; stop(); }
        else if (this.o.mode() !== startingMode) { invalid = "The approval mode changed, so I stopped this task. Start it again to use the new mode."; stop(); }
      } catch { invalid = "I couldn't verify the workspace or approval mode, so I stopped this task."; stop(); }
    };
    const off = this.o.onModeChange?.(check);
    const watch = setInterval(check, 200);
    watch.unref();
    try {
      if (signal.aborted) local.abort();
      await this.o.beforeStart();
      local.signal.throwIfAborted();
      const ember = await this.o.ember();
      local.signal.throwIfAborted();
      const reviews = codingRecommendations();
      const safety = createCodingSafety({ workspace: workspace.path, home: this.o.home, os: this.o.os, ember });
      const permission = createCodingPermissionHandler({
        mode: this.o.mode, confirmer: this.o.confirmer, signal: local.signal,
        task: { id: this.spec.id, title: this.spec.goal, goal: this.spec.userWords ?? this.spec.goal },
        commandPolicy: this.o.commandPolicy, workspace: workspace.path, home: this.o.home, os: this.o.os, ember, recommendation: reviews.recommendation, requiresHuman: reviews.requiresHuman,
      });
      this.o.progress("Starting Copilot in the selected workspace…");
      try { this.runtime = await CodingRuntime.start(this.o.runtime, local.signal); }
      catch (err) { if (err instanceof CodingRuntimeCleanupError) this.unsafeCleanup = true; throw err; }
      local.signal.throwIfAborted();
      const session = await CodingSession.create({ client: this.runtime.client, workspace: workspace.path,
        ...(this.o.model ? { model: this.o.model } : {}), ...(this.o.provider ? { provider: this.o.provider } : {}),
        ...(!this.o.provider && this.o.gitHubToken ? { gitHubToken: this.o.gitHubToken } : {}),
        mode: startingMode, canAllowAll: false, permission, signal: local.signal, protectedPaths: ember.paths, requireCompletion: this.spec.codingCompletion === true,
        preToolUse: async input => {
          if (local.signal.aborted || !workspace.current() || this.o.mode() !== startingMode) return "The workspace or approval mode changed.";
          if (/^(?:builtin:)?(?:bash|powershell)$/.test(input.toolName) && this.o.commandPolicy().state !== "on") return "Commands are turned off or need consent.";
          return safety(input);
        },
        ...(this.o.clarify ? { onUserInputRequest: async request => {
          if (!validCodingClarification(request)) throw new Error("The clarification is too long or invalid to show safely.");
          const answer = await this.o.clarify!(request, local.signal);
          if (!answer || local.signal.aborted || !answer.answer.trim() || answer.answer.length > 1024 ||
              (answer.wasFreeform ? request.allowFreeform === false || /[\0\r\n]/.test(answer.answer) : !request.choices?.includes(answer.answer))) {
            throw new Error("The clarification was cancelled or invalid.");
          }
          return answer;
        } } : {}),
        onEvent: event => {
          reviews.onEvent(event);
          if (event.type === "tool.execution_start") this.o.progress(`Using ${event.data.toolName}…`);
        },
      });
      this.session = session;
      if (!workspace.current() || this.o.mode() !== startingMode) { await session.stop(); return { success: false, summary: "The workspace or approval mode changed. Start the task again." }; }
      if (session.modeStatus.warning) this.o.progress(session.modeStatus.warning);
      const answer = await session.run(this.spec.goal + handoffContext(this.spec.handoffSummary), local.signal);
      if (this.spec.codingCompletion) {
        const result = session.handoffResult();
        if (!result) return { success: false, summary: "I couldn't confirm that the coding part finished, so I didn't start the desktop part." };
        if (!result.success) return { success: false, summary: `${result.summary} I didn't start the desktop part.` };
        this.completedForHandoff = true;
        return { success: true, summary: result.summary };
      }
      return { success: true, summary: answer || "The coding task finished." };
    } catch (err) {
      if (signal.aborted) return { success: false, stopped: true, summary: "Stopped." };
      if (invalid) return { success: false, summary: invalid };
      throw err;
    } finally {
      clearInterval(watch);
      off?.();
      signal.removeEventListener("abort", stop);
    }
  }

  async steer(): Promise<boolean> { return false; }
  handoffSafe(): boolean { return this.completedForHandoff; }
  async dispose(): Promise<void> {
    this.o.onRetiring?.();
    let failure: unknown;
    try { await this.session?.close(); } catch (err) { failure = err; }
    try { await this.runtime?.close(); } catch (err) { failure ??= err; }
    if (failure || this.unsafeCleanup) {
      this.finishDisposed(false);
      throw new CodingRuntimeCleanupError();
    }
    this.finishDisposed(true);
  }
}
