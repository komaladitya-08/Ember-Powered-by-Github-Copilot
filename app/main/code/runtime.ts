/**
 * The Copilot runtime coding sessions run in (docs/CODING-APP.md §2 "CodeRuntime"): one for the run, apart from the
 * conversation's and the chats', started when the first coding session needs it, and the only place in
 * app/main/code that makes an SDK client. It runs in the SDK's full Copilot mode ("copilot-cli"), not the "empty"
 * mode the chats use, so skills, memory, custom instructions, on-demand instruction discovery, file hooks, host git,
 * the session store and the environment context behave as they do in Copilot (the session's own options turn each
 * on: session-runtime.ts `codeSessionConfig`).
 *
 * The constraint behind it: the pinned SDK (1.0.21) exports a client's GitHub token to the runtime's environment and
 * so to every command a tool runs (runtime-env.ts). So the client is tokenless (codingRuntimeOptions: no token, no
 * inherited GitHub credential) and the sign-in goes with each session instead (`SessionConfig.gitHubToken`). Its
 * state (COPILOT_HOME) is a folder of its own beside Ember's data folder (`stateRoot`, which the platform names:
 * state.ts), 0700, so a session can be opened again after a restart and its sandbox can deny the whole data folder
 * while the runtime's tools still write the session's own plan; an earlier build's `<userData>/code/copilot` is
 * moved there once before the runtime starts, and stays in use where it can't be. Plain Node: the client factory is
 * injected.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { CopilotClient, type CopilotClientOptions } from "@github/copilot-sdk";
import { codingRuntimeOptions } from "../agent/coding-runtime";
import { redactingClient, type ModelRedactor } from "../agent/redacting-client";
import { settleCodeState } from "./state";

export interface CodeRuntimeInput {
  userData: string;
  /** Where the runtime keeps its sessions (SystemPaths.codeState): outside `userData`. */
  stateRoot: string;
  log?: { info(event: string, fields?: Record<string, unknown>): void; warn(event: string, fields?: Record<string, unknown>): void };
  runtimePath: string;
  env: NodeJS.ProcessEnv;
  /** The vault's redactor: every session's prompts and hook answers pass it (redactingClient). */
  redact?: ModelRedactor;
}

/** Ember's coding folder: the index and the worktrees. */
export const codeDir = (userData: string): string => path.join(userData, "code");
/** Where an earlier build kept the runtime's sessions, inside Ember's data folder (moved at start: state.ts). */
export const legacyCodeHome = (userData: string): string => path.join(codeDir(userData), "copilot");

/** The client options: tokenless, as for coding, in the SDK's full Copilot mode, state in `home`. */
export function codeClientOptions(input: Pick<CodeRuntimeInput, "userData" | "runtimePath" | "env">, home: string): CopilotClientOptions {
  return { ...codingRuntimeOptions(input, home), mode: "copilot-cli" };
}

/** One tokenless runtime for this run's coding sessions. */
export class CodeRuntime {
  private starting: Promise<CopilotClient> | null = null;
  private raw: CopilotClient | null = null;
  private inUse: string | null = null;

  constructor(private readonly input: CodeRuntimeInput, private readonly factory: (o: CopilotClientOptions) => CopilotClient = o => new CopilotClient(o)) {}

  /** The runtime's client, started on first use (again after a failed start). */
  client(): Promise<CopilotClient> {
    this.starting ??= (async () => {
      const dir = codeDir(this.input.userData);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.chmod(dir, 0o700);
      const home = await settleCodeState({ legacy: legacyCodeHome(this.input.userData), wanted: this.input.stateRoot, ...(this.input.log ? { log: this.input.log } : {}) });
      await fs.mkdir(home, { recursive: true, mode: 0o700 });
      await fs.chmod(home, 0o700);
      this.inUse = home;
      const raw = this.factory(codeClientOptions(this.input, home));
      this.raw = raw;
      await raw.start();
      return this.input.redact ? redactingClient(raw, this.input.redact) : raw;
    })();
    const started = this.starting;
    started.catch(() => { if (this.starting === started) { this.starting = null; void this.stop(); } });
    return started;
  }

  /** Where the runtime keeps its sessions in this run: the state root, or the earlier folder it couldn't move. */
  get home(): string { return this.inUse ?? this.input.stateRoot; }

  /** Whether the runtime has been started in this run. */
  get started(): boolean { return this.raw !== null; }

  /** Stops the runtime; the sessions it keeps on disk stay. */
  async stop(): Promise<void> {
    const raw = this.raw;
    this.raw = null;
    this.starting = null;
    if (raw) await raw.stop().catch(() => undefined);
  }
}
