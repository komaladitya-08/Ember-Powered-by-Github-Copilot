/**
 * The Copilot runtime the native chat sessions run in: one for the run, apart from the conversation's, started when
 * the first chat needs it. It is tokenless (codingRuntimeOptions): the pinned SDK exports a client's GitHub token to
 * the runtime's environment and so to every command a native tool runs, which is why the sign-in goes with each
 * session instead (ChatSessionOptions.gitHubToken), as for coding. Its state lives in `<userData>/chat` (0700, inside
 * Ember's data folder, which every chat's sandbox denies to the tools), so a chat can be opened again after a
 * restart. Plain Node: the client factory is injected for tests.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { CopilotClient, type CopilotClientOptions } from "@github/copilot-sdk";
import { codingRuntimeOptions } from "./coding-runtime";
import { redactingClient, type ModelRedactor } from "./redacting-client";

export interface ChatRuntimeInput {
  userData: string;
  runtimePath: string;
  env: NodeJS.ProcessEnv;
  /** The vault's redactor: every session's prompts and hook answers pass it (redactingClient). */
  redact?: ModelRedactor;
}

/** The folder the chat runtime keeps its sessions in. */
export const chatRuntimeDir = (userData: string): string => path.join(userData, "chat");

/** One tokenless runtime for this run's chats. */
export class ChatRuntime {
  private starting: Promise<CopilotClient> | null = null;
  private raw: CopilotClient | null = null;

  constructor(private readonly input: ChatRuntimeInput, private readonly factory: (o: CopilotClientOptions) => CopilotClient = o => new CopilotClient(o)) {}

  /** The runtime's client, started on first use (again after a failed start). */
  client(): Promise<CopilotClient> {
    this.starting ??= (async () => {
      const dir = chatRuntimeDir(this.input.userData);
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      await fs.chmod(dir, 0o700);
      const raw = this.factory(codingRuntimeOptions(this.input, dir));
      this.raw = raw;
      await raw.start();
      return this.input.redact ? redactingClient(raw, this.input.redact) : raw;
    })();
    const started = this.starting;
    started.catch(() => { if (this.starting === started) { this.starting = null; void this.stop(); } });
    return started;
  }

  /** Stops the runtime; the sessions it keeps on disk stay. */
  async stop(): Promise<void> {
    const raw = this.raw;
    this.raw = null;
    this.starting = null;
    if (raw) await raw.stop().catch(() => undefined);
  }
}
