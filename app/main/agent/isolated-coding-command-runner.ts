/** CommandRunner bridge: the existing command flow owns policy; this bridge owns an isolated run's observations. */
import { createHash } from "node:crypto";
import type { CommandRunner, GitFacts, PathFact, RunnerFacts, RunningCommand, RunExit, RunSpec, ShellId } from "../commands/types";
import { copyNodeArgv, nodeInvocationSha256, type NodeRunSpec } from "../commands/node-invocation";

export interface ObservedCodingCommand {
  observed: true;
  exitCode: number | null;
  signal: string | null;
  stopped: boolean;
  timedOut: boolean;
  outputLimited: boolean;
}

export interface IsolatedCodingCommandPort {
  readonly executionRoot: string;
  readonly nodeAvailable?: boolean;
  /** The backend must execute this exact policy-selected grammar or refuse before admitting work. */
  run(command: string, cwd: string, output: (bytes: Uint8Array, stream: "stdout" | "stderr") => void, signal: AbortSignal, shell: ShellId): Promise<ObservedCodingCommand>;
  /** Executes only the backend's host-selected Node binary, with these exact argument boundaries. */
  runNode?(argv: readonly string[], cwd: string, output: (bytes: Uint8Array, stream: "stdout" | "stderr") => void, signal: AbortSignal): Promise<ObservedCodingCommand>;
  /** Revokes queued work and resolves only after the backend's real stopped-writer check. */
  stop(): Promise<void>;
}

export interface IsolatedCodingCommandRunnerOptions {
  workspace: IsolatedCodingCommandPort;
  facts: RunnerFacts;
  /** These inspect the isolated copy under the backend's exclusive file lease, never the source folder. */
  inspect(paths: string[], cwd: string): Promise<PathFact[]>;
  gitFacts?(cwd: string): Promise<GitFacts | null>;
  signal: AbortSignal;
  current(): boolean;
}

interface ObservedExit { sequence: number; runId: string; checkKey: string; exit: RunExit }
const MAX_OUTPUT = 256 * 1024;
const MAX_RUNS = 200;

/** Does not classify, approve or rewrite commands. Only run_command/flow.ts should call start(). */
export class IsolatedCodingCommandRunner implements CommandRunner {
  readonly target = "local" as const;
  #workspace: IsolatedCodingCommandPort;
  #runNode: IsolatedCodingCommandPort["runNode"];
  #facts: RunnerFacts;
  #inspect: IsolatedCodingCommandRunnerOptions["inspect"];
  #gitFacts: IsolatedCodingCommandRunnerOptions["gitFacts"];
  #signal: AbortSignal;
  #current: () => boolean;
  #active = new Set<{ stop(why: "task" | "killswitch"): void }>();
  #exits: ObservedExit[] = [];
  #started = 0;
  #retired = false;
  #stopping: Promise<void> | null = null;
  #ownerAbort: () => void;

  constructor(options: IsolatedCodingCommandRunnerOptions) {
    this.#workspace = options.workspace;
    this.#runNode = options.workspace.nodeAvailable === true && typeof options.workspace.runNode === "function"
      ? options.workspace.runNode.bind(options.workspace) : undefined;
    this.#facts = structuredClone(options.facts);
    this.#inspect = options.inspect.bind(options);
    this.#gitFacts = options.gitFacts?.bind(options);
    this.#signal = options.signal;
    this.#current = options.current;
    // A task abort revokes admission synchronously. Each active run also receives this signal directly.
    this.#ownerAbort = () => { this.#retired = true; };
    this.#signal.addEventListener("abort", this.#ownerAbort, { once: true });
    if (this.#signal.aborted) this.#ownerAbort();
  }

  get running(): number { return this.#active.size; }
  get sequence(): number { return this.#started; }
  get nodeAvailable(): boolean { return this.#runNode !== undefined; }
  /** Host-only observed metadata, with no command text, output, paths or credentials. */
  exitsAfter(sequence: number): readonly ObservedExit[] { return structuredClone(this.#exits.filter(exit => exit.sequence > sequence)); }

  async facts(): Promise<RunnerFacts> { this.#requireCurrent(); return structuredClone(this.#facts); }

  async inspect(paths: string[], cwd: string): Promise<PathFact[]> {
    const unknown = () => paths.map(() => ({ exists: null, real: null }));
    if (!Array.isArray(paths) || paths.length > 64) return [];
    try {
      this.#requireCurrent();
      const result = await this.#inspect([...paths], cwd);
      this.#requireCurrent();
      return result.length === paths.length ? result : unknown();
    } catch { return unknown(); }
  }

  async gitFacts(cwd: string): Promise<GitFacts | null> {
    try { this.#requireCurrent(); const result = await this.#gitFacts?.(cwd); this.#requireCurrent(); return result ?? null; }
    catch { return null; }
  }

  start(spec: RunSpec): RunningCommand {
    // Bind the exact decided bytes before yielding; mutation of a caller's object cannot change a queued command.
    let input: RunSpec;
    try {
      input = structuredClone(spec);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid command");
    }
    catch {
      return { runId: "", interactive: false, done: Promise.resolve({ code: null, signal: null, ended: "failed-to-start", ms: 0,
        error: "The isolated command request is invalid." }), onOutput: () => () => undefined,
        input() {}, typedLines: () => [], forgetTyped() {}, stop() {} };
    }
    return this.#start(input, () => this.#valid(input), (output, signal) => this.#workspace.run(input.command, input.cwd, output, signal, input.shell));
  }

  startNode(spec: NodeRunSpec): RunningCommand {
    let input: NodeRunSpec;
    try {
      input = structuredClone(spec);
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid Node invocation");
      input.argv = copyNodeArgv(input.argv);
    } catch {
      return { runId: "", interactive: false, done: Promise.resolve({ code: null, signal: null, ended: "failed-to-start", ms: 0,
        error: "The isolated Node request is invalid." }), onOutput: () => () => undefined,
        input() {}, typedLines: () => [], forgetTyped() {}, stop() {} };
    }
    return this.#start(input, () => this.#validNode(input), (output, signal) => this.#runNode!(input.argv, input.cwd, output, signal));
  }

  #start(spec: RunSpec | NodeRunSpec, valid: () => boolean,
    execute: (output: (bytes: Uint8Array, stream: "stdout" | "stderr") => void, signal: AbortSignal) => Promise<ObservedCodingCommand>): RunningCommand {
    const sequence = ++this.#started;
    const began = performance.now();
    const local = new AbortController();
    let why: "user" | "task" | "killswitch" | "timeout" | "output" | null = null;
    let cut = false;
    let buffered = 0;
    const chunks: Uint8Array[] = [];
    const listeners = new Set<(bytes: Uint8Array) => void>();
    const stop = (reason: NonNullable<typeof why>) => { why ??= reason; local.abort(); };
    const taskStopped = () => stop("task");
    this.#signal.addEventListener("abort", taskStopped, { once: true });
    if (this.#signal.aborted) taskStopped();
    const active = { stop: (reason: "task" | "killswitch") => stop(reason) };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (exit: Omit<RunExit, "ms">): RunExit => ({ ...exit, ms: Math.max(0, performance.now() - began) });
    const done = Promise.resolve().then(async (): Promise<RunExit> => {
      try {
        if (this.#signal.aborted || local.signal.aborted || this.#retired) return finish({ code: null, signal: null, ended: this.#ended(why) });
        this.#requireCurrent();
        if (sequence > MAX_RUNS || !valid()) return finish({ code: null, signal: null, ended: "failed-to-start", error: "The isolated command request is invalid or its budget is exhausted." });
        if (local.signal.aborted) return finish({ code: null, signal: null, ended: this.#ended(why) });
        this.#active.add(active);
        timer = setTimeout(() => stop("timeout"), spec.timeoutMs);
        timer.unref?.();
        const result = await execute(bytes => {
          if (local.signal.aborted) return;
          const chunk = Uint8Array.from(bytes);
          if (buffered + chunk.byteLength > MAX_OUTPUT) { cut = true; stop("output"); return; }
          buffered += chunk.byteLength;
          chunks.push(chunk);
          for (const listener of listeners) listener(Uint8Array.from(chunk));
        }, local.signal);
        if (result.observed !== true) throw new Error("Unverified command shutdown");
        if (result.timedOut) why ??= "timeout";
        if (result.outputLimited) { cut = true; why ??= "output"; }
        if (result.stopped) why ??= "task";
        return finish({ code: result.exitCode, signal: result.signal, ended: why ? this.#ended(why) : "exit", ...(cut ? { outputCut: true } : {}) });
      } catch {
        // A backend exception can mean uncertain writer state. Revoke all new work; never reinterpret it as success.
        this.#retired = true;
        return finish({ code: null, signal: null, ended: "lost", outputCut: true, endLost: true, error: "The isolated command's shutdown could not be verified." });
      } finally {
        if (timer) clearTimeout(timer);
        this.#signal.removeEventListener("abort", taskStopped);
        this.#active.delete(active);
      }
    }).then(exit => {
      if (this.#exits.length < MAX_RUNS) this.#exits.push({ sequence, runId: spec.runId, checkKey: spec.stamp?.sha256 ?? "", exit });
      return exit;
    });
    return {
      runId: spec.runId, interactive: false, done,
      onOutput: listener => { listeners.add(listener); for (const chunk of chunks) listener(Uint8Array.from(chunk)); return () => { listeners.delete(listener); }; },
      input() { /* The isolated pipe runner has closed stdin and never accepts model or user input. */ },
      typedLines: () => [], forgetTyped() {}, stop: reason => stop(reason),
    };
  }

  stopAll(why: "killswitch" | "quit"): Promise<void> {
    if (!this.#stopping) {
      this.#retired = true;
      this.#signal.removeEventListener("abort", this.#ownerAbort);
      for (const run of this.#active) run.stop(why === "killswitch" ? "killswitch" : "task");
      this.#stopping = Promise.resolve().then(() => this.#workspace.stop());
    }
    return this.#stopping;
  }

  #requireCurrent(): void {
    if (this.#retired || this.#signal.aborted || !this.#current()) throw new Error("The coding command context changed.");
  }

  #valid(spec: RunSpec): boolean {
    try {
      const hash = createHash("sha256").update(`${this.target}\0${spec.shell}\0${spec.cwd}\0${spec.command}`).digest("hex");
      return typeof spec.command === "string" && Buffer.byteLength(spec.command) <= 64 * 1024 && !spec.command.includes("\0") &&
        /^[0-9a-f]{16}$/.test(spec.runId) && !!spec.taskId && this.#facts.shells.includes(spec.shell) &&
        typeof spec.cwd === "string" && !/[\0\r\n]/.test(spec.cwd) && spec.stamp.taskId === spec.taskId && spec.stamp.sha256 === hash &&
        Number.isSafeInteger(spec.timeoutMs) && spec.timeoutMs >= 1 && spec.timeoutMs <= 20 * 60_000;
    } catch { return false; }
  }

  #validNode(spec: NodeRunSpec): boolean {
    try {
      return this.nodeAvailable && spec.kind === "node" && !("shell" in spec) && !("command" in spec) &&
        /^[0-9a-f]{16}$/.test(spec.runId) && !!spec.taskId && typeof spec.cwd === "string" && !/[\0\r\n]/.test(spec.cwd) &&
        spec.stamp.taskId === spec.taskId && spec.stamp.sha256 === nodeInvocationSha256(this.target, spec.cwd, spec.argv) &&
        Number.isSafeInteger(spec.timeoutMs) && spec.timeoutMs >= 1 && spec.timeoutMs <= 20 * 60_000;
    } catch { return false; }
  }

  #ended(why: "user" | "task" | "killswitch" | "timeout" | "output" | null): RunExit["ended"] {
    return why === "user" ? "stopped-user" : why === "killswitch" ? "killswitch" : why === "timeout" ? "timeout" : "stopped-task";
  }
}
