/**
 * The conductor: Ember's one long-lived Copilot session. It hears every
 * request, answers directly, changes Ember's look, and (from M4) hands tasks
 * to worker sessions. It never receives screenshots, so it stays fast.
 */

import fs from "node:fs";
import crypto from "node:crypto";
import { defineTool, type CopilotClient, type CopilotSession, type ProviderConfig, type Tool } from "@github/copilot-sdk";
import { z } from "zod";
import { hardenedSessionConfig, verifySessionTools } from "./session-config";
import { emberSystemMessage } from "./persona";
import type { Presenter } from "./presenter";
import type { Logger } from "../logger";
import { CHARACTERS, type SettingsStore } from "../settings";

export interface ConductorDeps {
  client: CopilotClient;
  settings: SettingsStore;
  presenter: Presenter;
  log: Logger;
  /** JSON file remembering the conductor's session id between runs. */
  stateFile: string;
  /** An empty directory: the session's working directory. */
  workDir: string;
  model: string | null;
  provider?: ProviderConfig;
  /** Called for every model call with its token counts (usage meter). */
  onUsage?: (inputTokens: number, outputTokens: number) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK types tool lists as Tool<any>[]
export function conductorTools(settings: SettingsStore): Tool<any>[] {
  return [
    defineTool("set_appearance", {
      description: "Change how Ember looks: one of cinder, wisp, glassling, glint; optionally its size in pixels (36-110).",
      parameters: z.object({
        character: z.enum(CHARACTERS).optional().describe("Which character to become"),
        size: z.number().int().min(36).max(110).optional().describe("Size on screen in pixels"),
      }),
      skipPermission: true,
      defer: "never",
      handler: async ({ character, size }) => {
        const s = settings.update({ ...(character ? { character } : {}), ...(size ? { size } : {}) });
        return `Ember now looks like ${s.character} at ${s.size}px.`;
      },
    }),
    defineTool("describe_screen", {
      description: "Describe what is currently on the user's screen (focused window, its controls and text).",
      parameters: z.object({}),
      skipPermission: true,
      defer: "never",
      // Screen reading arrives in M3.
      handler: async () => "Screen reading is not available in this version of Ember yet. Tell the user it is coming soon.",
    }),
    defineTool("start_task", {
      description: "Start a task in the user's applications (opening apps, clicking, typing, changing settings).",
      parameters: z.object({ goal: z.string().describe("One clear goal, in the user's words") }),
      skipPermission: true,
      defer: "never",
      // Workers arrive in M4.
      handler: async () => "Ember cannot operate applications in this version yet. Tell the user this is coming soon and offer to explain how to do it instead.",
    }),
  ];
}

export class Conductor {
  private session: CopilotSession | null = null;
  readonly toolNames: string[];

  constructor(private deps: ConductorDeps) {
    this.toolNames = conductorTools(deps.settings).map(t => t.name);
  }

  get sessionId(): string | null {
    return this.session?.sessionId ?? null;
  }

  async start(): Promise<void> {
    const d = this.deps;
    fs.mkdirSync(d.workDir, { recursive: true });
    const saved = this.readState();
    const config = hardenedSessionConfig({
      model: d.model ?? undefined,
      provider: d.provider,
      tools: conductorTools(d.settings),
      systemMessage: emberSystemMessage(),
      workingDirectory: d.workDir,
      onPermissionRequest: () => ({ kind: "reject", feedback: "Ember's conductor asks for nothing beyond its own tools." }),
    });
    if (saved) {
      try {
        this.session = await d.client.resumeSession(saved, config);
        d.log.info("conductor.resumed", { sessionId: saved });
      } catch (err) {
        d.log.warn("conductor.resume_failed", { sessionId: saved, err });
      }
    }
    if (!this.session) {
      const sessionId = `ember-conductor-${crypto.randomUUID()}`;
      this.session = await d.client.createSession({ ...config, sessionId });
      this.writeState(sessionId);
      d.log.info("conductor.created", { sessionId });
    }
    const tools = await verifySessionTools(this.session, this.toolNames);
    d.log.info("conductor.tools", { tools });
    this.session.on(e => {
      d.presenter.event(e as { type: string; data?: Record<string, unknown> });
      if (e.type === "assistant.usage") d.onUsage?.(e.data.inputTokens ?? 0, e.data.outputTokens ?? 0);
    });
  }

  async ask(text: string): Promise<void> {
    if (!this.session) throw new Error("Ember's brain is not connected yet.");
    this.deps.presenter.userPrompt(text);
    this.deps.log.info("conductor.ask", { chars: text.length });
    await this.session.send({ prompt: text });
  }

  async abort(): Promise<void> {
    await this.session?.abort();
  }

  async stop(): Promise<void> {
    await this.session?.disconnect().catch(() => undefined);
    this.session = null;
  }

  /**
   * Forget the conversation: delete it from the runtime's store and drop the
   * saved id, so the next start begins a fresh one (e.g. after sign-out, so
   * another account never resumes this one's conversation).
   */
  async forget(): Promise<void> {
    const id = this.session?.sessionId ?? this.readState();
    await this.stop();
    if (id) await this.deps.client.deleteSession(id).catch(err => this.deps.log.warn("conductor.delete_failed", { err }));
    try { fs.rmSync(this.deps.stateFile); } catch { /* none */ }
  }

  private readState(): string | null {
    try {
      const j = JSON.parse(fs.readFileSync(this.deps.stateFile, "utf8")) as { conductorSessionId?: string };
      return j.conductorSessionId ?? null;
    } catch {
      return null;
    }
  }

  private writeState(id: string): void {
    fs.writeFileSync(this.deps.stateFile, JSON.stringify({ conductorSessionId: id }, null, 2) + "\n", { mode: 0o600 });
  }
}
