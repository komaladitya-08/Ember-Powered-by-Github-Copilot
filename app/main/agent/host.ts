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
import { TaskManager } from "./tasks";
import { Worker, type WorkerDeps } from "./worker";
import type { Confirmer } from "./confirm";
import type { Perception, WindowTarget } from "../perception";
import type { AtspiSidecar, Bounds } from "../perception/sidecar";
import type { PolicyEngine } from "../policy/policy";
import type { AuditLog } from "../policy/audit";

/** What workers need to see and act (absent when there is no desktop). */
export interface Hands {
  perception: Perception;
  sidecar: AtspiSidecar;
  policy: PolicyEngine;
  audit: AuditLog;
  confirmer: Confirmer;
  flyTo: (bounds: Bounds | null) => void;
  currentWindow: () => (WindowTarget & { app?: string }) | null;
  /** Tier 3 (borrowing the user's mouse), when XTest is available. */
  cursor?: WorkerDeps["cursor"];
}

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
  /** Text description of the user's screen, for the conductor's describe_screen tool. */
  describeScreen?: () => Promise<string>;
  hands?: Hands;
  onAnswer?: (text: string) => void;
  onTurnEnd?: (aborted: boolean) => void;
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
  tasks: TaskManager | null = null;
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
      const hands = this.o.hands;
      const workerVision = models.find(m => m.id === choice.worker)?.capabilities?.supports?.vision === true;
      this.tasks = hands ? new TaskManager({
        log: this.o.log.child("tasks"),
        currentWindow: hands.currentWindow,
        setCards: cards => this.o.setState({ tasks: cards }),
        deleteSession: id => client.deleteSession(id),
        onFinished: task => {
          if (hands.confirmer.waiting) return;
          this.o.setState({
            emotion: task.status === "done" ? "proud" : task.status === "cancelled" ? "neutral" : "sad", talking: false,
            bubble: { visible: true, mood: task.status === "done" ? "done" : task.status === "cancelled" ? "idle" : "error", title: task.title, thought: task.result?.summary ?? "", step: null, streaming: false, actions: [] },
          });
        },
        makeWorker: (spec, progress) => new Worker({
          client, log: this.o.log.child(`task-${spec.id}`), model: choice.worker, vision: workerVision, provider: this.o.provider,
          workDir: path.join(this.o.userData, "copilot", "empty-workdir"),
          perception: hands.perception, sidecar: hands.sidecar, policy: hands.policy, confirmer: hands.confirmer, audit: hands.audit,
          settings: this.o.settings,
          presenter: new Presenter(this.o.setState, undefined, () => spec.goal.length > 40 ? spec.goal.slice(0, 39) + "…" : spec.goal),
          lease: (key, owner) => this.tasks!.lease(key, owner),
          flyTo: hands.flyTo,
          cursor: hands.cursor,
          onProgress: progress,
          onUsage: (i, o) => this.recordUsage(i, o),
        }, spec),
      }) : null;
      const tasks = this.tasks;
      const presenter = new Presenter(this.o.setState, undefined, () => names[this.o.settings.get().character] ?? "Ember");
      this.conductor = new Conductor({
        client, settings: this.o.settings, presenter, log: this.o.log.child("conductor"),
        stateFile: path.join(this.o.userData, "agent.json"),
        workDir: path.join(this.o.userData, "copilot", "empty-workdir"),
        model: choice.conductor, provider: this.o.provider, describeScreen: this.o.describeScreen,
        onUsage: (i, o) => this.recordUsage(i, o),
        onAnswer: this.o.onAnswer,
        onTurnEnd: this.o.onTurnEnd,
        startTask: tasks ? goal => {
          const t = tasks.start(goal);
          return `Task ${t.id} started: "${t.title}". It runs in the background and shows a card beside Ember. Tell the user you're on it, in a few words.`;
        } : undefined,
        takeReports: tasks ? () => tasks.takeReports().map(t => `Task "${t.title}" ${t.status}: ${t.result?.summary ?? ""}`) : undefined,
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

  /** Stops the current answer and every running task (the handle's Stop). */
  async abortAll(): Promise<void> {
    this.tasks?.cancelAll();
    this.o.hands?.confirmer.cancelAll();
    await this.conductor?.abort();
  }

  /** Sign-out: the conversation belongs to the account that had it, so it is deleted. */
  async forgetConversation(): Promise<void> {
    this.tasks?.cancelAll();
    await this.conductor?.forget();
    this.o.log.info("agent.conversation_forgotten");
  }

  async stop(): Promise<void> {
    this.tasks?.cancelAll();
    this.tasks = null;
    await this.conductor?.stop();
    this.conductor = null;
    await this.client?.stop().catch(() => undefined);
    this.client = null;
  }
}
