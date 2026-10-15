/**
 * AgentHost owns the Copilot client: finds the bundled runtime, signs in,
 * picks models, and starts the conductor. Its status drives the Copilot
 * section of the settings window.
 */

import path from "node:path";
import { CopilotClient, RuntimeConnection, type ProviderConfig } from "@github/copilot-sdk";
import { Conductor } from "./conductor";
import { Presenter } from "./presenter";
import { chooseModels, type ModelLike } from "./models";
import type { Logger } from "../logger";
import type { SettingsStore } from "../settings";
import type { EmberState } from "../../shared/overlay";

export type AgentPhase = "signed-out" | "starting" | "ready" | "error";

export interface AgentStatus {
  phase: AgentPhase;
  detail: string;
  login?: string;
  models: { id: string; name: string; vision: boolean }[];
  conductorModel: string | null;
  workerModel: string | null;
  usage: { calls: number; inputTokens: number; outputTokens: number };
}

export interface HostOptions {
  userData: string;
  runtimePath: string;
  settings: SettingsStore;
  log: Logger;
  setState: (patch: Partial<EmberState>) => void;
  onStatus: (s: AgentStatus) => void;
  /** Tests and offline demos: talk to an OpenAI-compatible server instead of Copilot. */
  provider?: ProviderConfig;
}

export function explainStartError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/policy/i.test(msg)) return "Copilot is turned off for your account by an organization policy. Ask your GitHub admin to enable the Copilot CLI policy.";
  if (/not authenticated|unauthori[sz]ed|401|bad credentials/i.test(msg)) return "GitHub did not accept the sign-in. Sign in again.";
  if (/seat|subscription|402|403/i.test(msg)) return "This GitHub account has no Copilot access. Check your Copilot subscription or seat.";
  if (/ENOENT|spawn/i.test(msg)) return "Ember's Copilot runtime is missing. Reinstall Ember.";
  return msg;
}

export class AgentHost {
  private client: CopilotClient | null = null;
  conductor: Conductor | null = null;
  private status: AgentStatus = {
    phase: "signed-out", detail: "Not signed in to GitHub.", models: [], conductorModel: null, workerModel: null,
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
  };

  constructor(private o: HostOptions) {}

  getStatus(): AgentStatus {
    return this.status;
  }

  private setStatus(patch: Partial<AgentStatus>): void {
    this.status = { ...this.status, ...patch };
    this.o.onStatus(this.status);
  }

  async start(token: string | null): Promise<void> {
    await this.stop();
    if (!token && !this.o.provider) {
      this.setStatus({ phase: "signed-out", detail: "Not signed in to GitHub." });
      return;
    }
    this.setStatus({ phase: "starting", detail: "Connecting to Copilot…" });
    try {
      const client = new CopilotClient({
        mode: "empty",
        baseDirectory: path.join(this.o.userData, "copilot"),
        useLoggedInUser: false,
        ...(token ? { gitHubToken: token } : {}),
        connection: RuntimeConnection.forStdio({ path: this.o.runtimePath }),
        logLevel: "warning",
        env: { ...process.env, NO_PROXY: [process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",") },
      });
      await client.start();
      this.client = client;

      let login: string | undefined;
      let models: ModelLike[] = [];
      if (!this.o.provider) {
        const auth = await client.getAuthStatus();
        if (!auth.isAuthenticated) throw new Error("not authenticated");
        login = (auth as { login?: string }).login;
        models = (await client.listModels()) as ModelLike[];
      } else {
        models = [{ id: "mock-model", name: "Test model", capabilities: { supports: { vision: true } } }];
      }
      const s = this.o.settings.get();
      const choice = chooseModels(models, { conductor: s.models.conductor ?? undefined, worker: s.models.worker ?? undefined });

      const names: Record<string, string> = { cinder: "Cinder", wisp: "Wisp", glassling: "Glassling", glint: "Glint" };
      const presenter = new Presenter(this.o.setState, undefined, () => names[this.o.settings.get().character] ?? "Ember");
      this.conductor = new Conductor({
        client, settings: this.o.settings, presenter, log: this.o.log.child("conductor"),
        stateFile: path.join(this.o.userData, "agent.json"),
        workDir: path.join(this.o.userData, "copilot", "empty-workdir"),
        model: choice.conductor, provider: this.o.provider,
        onUsage: (i, o) => this.recordUsage(i, o),
      });
      await this.conductor.start();

      this.setStatus({
        phase: "ready",
        detail: login ? `Signed in as ${login}.` : "Connected.",
        login,
        models: models.map(m => ({ id: m.id, name: m.name ?? m.id, vision: m.capabilities?.supports?.vision === true })),
        conductorModel: choice.conductor,
        workerModel: choice.worker,
      });
      this.o.log.info("agent.ready", { login, conductorModel: choice.conductor, workerModel: choice.worker, models: models.length });
    } catch (err) {
      this.o.log.error("agent.start_failed", { err });
      this.setStatus({ phase: "error", detail: explainStartError(err) });
      await this.stop();
    }
  }

  recordUsage(input: number, output: number): void {
    const u = this.status.usage;
    this.setStatus({ usage: { calls: u.calls + 1, inputTokens: u.inputTokens + input, outputTokens: u.outputTokens + output } });
  }

  async ask(text: string): Promise<void> {
    if (!this.conductor) {
      this.o.setState({
        emotion: "confused", talking: false,
        bubble: { visible: true, mood: "error", title: "I'm not connected yet", thought: "Sign in to GitHub in Ember's settings (Ctrl+Alt+E) so I can use Copilot.", step: null, streaming: false, actions: [] },
      });
      return;
    }
    await this.conductor.ask(text);
  }

  /** Sign-out: the conversation belongs to the account that had it, so it is deleted. */
  async forgetConversation(): Promise<void> {
    await this.conductor?.forget();
    this.o.log.info("agent.conversation_forgotten");
  }

  async stop(): Promise<void> {
    await this.conductor?.stop();
    this.conductor = null;
    await this.client?.stop().catch(() => undefined);
    this.client = null;
  }
}
