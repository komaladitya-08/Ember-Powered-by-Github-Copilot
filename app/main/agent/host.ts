/**
 * AgentHost owns the Copilot client: finds the bundled runtime, signs in,
 * picks models, and starts the conductor. Its status drives the Copilot
 * section of the settings window.
 *
 * Starts and stops run one at a time, in order; a start that a newer one
 * replaced gives up at its next step. A health check notices when the runtime
 * dies and reconnects. Changing models doesn't restart anything.
 */

import path from "node:path";
import { CopilotClient, RuntimeConnection, type ProviderConfig } from "@github/copilot-sdk";
import { Conductor } from "./conductor";
import { Presenter, type BubbleOwner } from "./presenter";
import { ConnectionLost } from "./conductor";
import { chooseModels, type ModelLike } from "./models";
import type { AdminPolicy } from "../admin";
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
  pointer?: WorkerDeps["pointer"];
  desk?: WorkerDeps["desk"];
  onDesk?: WorkerDeps["onDesk"];
  /** Tier 3 (borrowing the user's mouse), when XTest is available. */
  cursor?: WorkerDeps["cursor"];
  /** The user's clipboard, for pasting text the keyboard can't type. */
  clipboard?: WorkerDeps["clipboard"];
}

export type AgentPhase = "signed-out" | "starting" | "ready" | "error";

export interface AgentStatus {
  phase: AgentPhase;
  detail: string;
  login?: string;
  /** Where the sign-in came from: Ember's own, the environment, or the GitHub CLI. */
  source?: string;
  models: { id: string; name: string; vision: boolean }[];
  conductorModel: string | null;
  workerModel: string | null;
  usage: { calls: number; inputTokens: number; outputTokens: number };
}

/** One line of the conversation, kept in memory for this session only (the settings window shows them). */
export interface TranscriptEntry { t: string; who: "you" | "ember" | "task"; text: string }

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
  /** A task finished (for a notification when the user isn't looking). */
  onTaskFinished?: (task: { title: string; status: string; summary: string }) => void;
  /** The conversation changed (the settings window shows it). */
  onTranscript?: (entries: TranscriptEntry[]) => void;
  /** The organisation's own endpoint (admin policy), or for tests and offline demos an OpenAI-compatible server. */
  provider?: ProviderConfig;
  /** Admin lockdown (/etc/ember/policy.json). */
  admin?: () => AdminPolicy;
  /** Is the computer online? A failed start while offline is retried instead of blamed on the sign-in. */
  isOnline?: () => boolean;
  /** How often the runtime's health is checked (ms). */
  healthMs?: number;
}

const SOURCE_TEXT: Record<string, string> = { stored: "Ember's saved sign-in", environment: "a token from the environment", "github-cli": "the GitHub CLI sign-in" };

export function explainStartError(err: unknown, ctx: { source?: string; online?: boolean } = {}): string {
  const msg = err instanceof Error ? err.message : String(err);
  const from = ctx.source && SOURCE_TEXT[ctx.source] ? ` (${SOURCE_TEXT[ctx.source]})` : "";
  if (/not found at|ENOENT|EACCES|spawn /i.test(msg)) return "Ember's Copilot runtime is missing or can't start. Reinstall Ember (sudo dnf reinstall ember).";
  if (/^None of the models/.test(msg)) return msg;
  if (ctx.online === false || /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network is unreachable/i.test(msg)) return "Ember can't reach GitHub right now. It will try again when the network is back.";
  if (/copilot (cli )?policy|disabled by (your )?organi[sz]ation|organi[sz]ation polic/i.test(msg)) return "Copilot is turned off for your account by an organisation policy. Ask your GitHub admin to enable the Copilot CLI policy.";
  if (/\bseat\b|subscription|no copilot access|\b(status|HTTP|code)\s*40[23]\b/i.test(msg)) return "This GitHub account has no Copilot access. Check your Copilot subscription or seat.";
  if (/not authenticated|unauthori[sz]ed|bad credentials|\b(status|HTTP|code)\s*401\b/i.test(msg)) {
    return `Copilot didn't accept the GitHub sign-in Ember found${from}. It may have expired, or this account may not have Copilot. Sign in again, or run “gh auth login” in a terminal and press Check again.`;
  }
  return msg;
}

const NAMES: Record<string, string> = { cinder: "Cinder", wisp: "Wisp", glassling: "Glassling", glint: "Glint" };

export class AgentHost {
  private client: CopilotClient | null = null;
  conductor: Conductor | null = null;
  tasks: TaskManager | null = null;
  private status: AgentStatus = {
    phase: "signed-out", detail: "Not signed in to GitHub.", models: [], conductorModel: null, workerModel: null,
    usage: { calls: 0, inputTokens: 0, outputTokens: 0 },
  };
  /** Bumped by every start() and stop(): an older start gives up at its next step. */
  private gen = 0;
  /** Starts and stops run one after another. */
  private chain: Promise<void> = Promise.resolve();
  private token: string | null = null;
  private source: string | undefined;
  private health: ReturnType<typeof setInterval> | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private failures: number[] = [];
  private models: ModelLike[] = [];
  /** The bubble is shared by the conversation and every task: whoever wrote it last owns it. */
  private readonly owner: BubbleOwner = { current: null };
  private readonly transcript: TranscriptEntry[] = [];
  /** The conversation's presenter (kept across restarts, so a restart can tidy its bubble). */
  private readonly presenter: Presenter;

  constructor(private o: HostOptions) {
    this.presenter = new Presenter(o.setState, undefined, () => NAMES[o.settings.get().character] ?? "Ember", this.owner, text => this.remember("ember", text));
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  getTranscript(): TranscriptEntry[] {
    return [...this.transcript];
  }

  /** The last thing Ember said, in full. */
  lastAnswer(): string | null {
    return [...this.transcript].reverse().find(e => e.who === "ember")?.text ?? null;
  }

  private remember(who: TranscriptEntry["who"], text: string): void {
    this.transcript.push({ t: new Date().toISOString(), who, text: text.slice(0, 4000) });
    if (this.transcript.length > 60) this.transcript.splice(0, this.transcript.length - 60);
    this.o.onTranscript?.(this.getTranscript());
  }

  private setStatus(patch: Partial<AgentStatus>): void {
    this.status = { ...this.status, ...patch };
    this.o.onStatus(this.status);
  }

  /** (Re)connects with this sign-in. Calls queue: the newest one wins. */
  start(token: string | null, source?: string): Promise<void> {
    const gen = ++this.gen;
    this.token = token;
    this.source = source;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const run = this.chain.then(() => this.doStart(token, gen));
    this.chain = run.catch(() => undefined);
    return run;
  }

  stop(): Promise<void> {
    ++this.gen;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const run = this.chain.then(() => this.doStop());
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doStart(token: string | null, gen: number): Promise<void> {
    await this.doStop();
    if (gen !== this.gen) return;
    if (!token && !this.o.provider) {
      this.setStatus({ phase: "signed-out", detail: "Not signed in to GitHub.", login: undefined, source: undefined });
      return;
    }
    this.setStatus({ phase: "starting", detail: "Connecting to Copilot…", source: this.source });
    const localhost = (v: string | undefined) => [v, "127.0.0.1", "localhost"].filter(Boolean).join(",");
    try {
      const client = new CopilotClient({
        mode: "empty",
        baseDirectory: path.join(this.o.userData, "copilot"),
        useLoggedInUser: false,
        ...(token ? { gitHubToken: token } : {}),
        connection: RuntimeConnection.forStdio({ path: this.o.runtimePath }),
        logLevel: "warning",
        // Both spellings: the runtime reads the lowercase one first.
        env: { ...process.env, NO_PROXY: localhost(process.env.NO_PROXY), no_proxy: localhost(process.env.no_proxy ?? process.env.NO_PROXY) },
      });
      // Known before it starts, so a stop() that comes meanwhile stops it too.
      this.client = client;
      await client.start();
      if (gen !== this.gen) return;

      let login: string | undefined;
      let models: ModelLike[] = [];
      const allowed = this.o.admin?.().models.allowed;
      if (!this.o.provider) {
        const auth = await client.getAuthStatus();
        if (!auth.isAuthenticated) throw new Error(`not authenticated${auth.statusMessage ? `: ${auth.statusMessage}` : ""}`);
        login = (auth as { login?: string }).login;
        models = (await client.listModels()) as ModelLike[];
      } else {
        // A custom endpoint serves the models the admin named (its deployments and allowed list), or a test model.
        const admin = this.o.admin?.();
        const named = [...new Set([admin?.models.conductor, admin?.models.worker, ...(allowed ?? [])].filter((m): m is string => !!m))];
        models = named.length
          ? named.map(id => ({ id, name: id, capabilities: { supports: { vision: true } } }))
          : [{ id: "mock-model", name: "Test model", capabilities: { supports: { vision: true } } }];
      }
      if (gen !== this.gen) return;
      if (allowed) models = models.filter(m => allowed.includes(m.id));
      const s = this.o.settings.get();
      const choice = chooseModels(models, { conductor: s.models.conductor ?? undefined, worker: s.models.worker ?? undefined });
      // Never fall back to the runtime's default model: it may be one the administrator didn't allow.
      if (!choice.conductor) throw new Error(allowed ? "None of the models your administrator allows are available to this account." : "Copilot offered no models to this account.");
      this.models = models;
      // Sessions of tasks from an earlier run (Ember quit or restarted before their 10 minutes were up).
      await this.sweepTaskSessions(client);
      if (gen !== this.gen) return;

      const hands = this.o.hands;
      this.status = { ...this.status, conductorModel: choice.conductor, workerModel: choice.worker };
      const workerVision = () => this.models.find(m => m.id === this.status.workerModel)?.capabilities?.supports?.vision === true
        && this.o.admin?.().features.screenImages !== false;
      this.tasks = hands ? new TaskManager({
        log: this.o.log.child("tasks"),
        currentWindow: hands.currentWindow,
        setCards: cards => this.o.setState({ tasks: cards }),
        deleteSession: id => client.deleteSession(id),
        audit: hands.audit,
        onFinished: task => {
          const summary = task.result?.summary ?? "";
          this.remember("task", `${task.title}: ${task.status === "done" ? "done" : task.status}${summary ? `. ${summary}` : ""}`);
          this.o.onTaskFinished?.({ title: task.title, status: task.status, summary });
          // A question is up: the result waits for it (it is never dropped).
          const show = (tries: number) => {
            if (hands.confirmer.waiting && tries < 120) { setTimeout(() => show(tries + 1), 1000).unref?.(); return; }
            this.o.setState({
              emotion: task.status === "done" ? "proud" : task.status === "cancelled" ? "neutral" : "sad", talking: false,
              gesture: task.status === "done" ? "thumbsUp" : task.status === "cancelled" ? "rest" : "facepalm",
              bubble: { visible: true, mood: task.status === "done" ? "done" : task.status === "cancelled" ? "idle" : "error", title: task.title, thought: summary, step: null, streaming: false, actions: [] },
            });
          };
          show(0);
        },
        makeWorker: (spec, progress) => new Worker({
          client, log: this.o.log.child(`task-${spec.id}`), model: this.status.workerModel, vision: workerVision(), provider: this.o.provider,
          workDir: path.join(this.o.userData, "copilot", "empty-workdir"),
          perception: hands.perception, sidecar: hands.sidecar, policy: hands.policy, confirmer: hands.confirmer, audit: hands.audit,
          settings: this.o.settings,
          presenter: new Presenter(this.o.setState, undefined, () => spec.goal.length > 40 ? spec.goal.slice(0, 39) + "…" : spec.goal, this.owner),
          lease: (key, owner, signal) => this.tasks!.lease(key, owner, signal),
          flyTo: hands.flyTo,
          cursor: hands.cursor,
          clipboard: hands.clipboard,
          pointer: hands.pointer,
          desk: hands.desk,
          onDesk: hands.onDesk,
          onProgress: progress,
          onUsage: (i, o) => this.recordUsage(i, o),
        }, spec),
      }) : null;
      const tasks = this.tasks;
      this.conductor = new Conductor({
        client, settings: this.o.settings, presenter: this.presenter, log: this.o.log.child("conductor"),
        stateFile: path.join(this.o.userData, "agent.json"),
        workDir: path.join(this.o.userData, "copilot", "empty-workdir"),
        model: choice.conductor, provider: this.o.provider, describeScreen: this.o.describeScreen,
        onUsage: (i, o) => this.recordUsage(i, o),
        onAnswer: this.o.onAnswer,
        onTurnEnd: this.o.onTurnEnd,
        startTask: tasks ? goal => {
          // With actions turned off by the administrator, Ember can still answer and guide, never act.
          if (this.o.admin?.().features.actions === false) return "Your organisation has turned off Ember acting in apps. Tell the user, and offer to show them how (show_me) instead.";
          const t = tasks.start(goal, { target: this.askTarget ?? undefined });
          return `Task ${t.id} started: "${t.title}". It runs in the background and shows a card beside Ember. Tell the user you're on it, in a few words.`;
        } : undefined,
        showMe: tasks ? goal => {
          const t = tasks.start(goal, { target: this.askTarget ?? undefined, mode: "guide" });
          return `Guide ${t.id} started: Ember will point at each step and wait for the user to click. Tell the user to follow Ember, in a few words.`;
        } : undefined,
        takeReports: tasks ? () => tasks.takeReports().map(t => `Task "${t.title}" ${t.status}: ${t.result?.summary ?? ""}`) : undefined,
        tasks: tasks ? {
          list: () => tasks.list().map(t => ({ id: t.id, title: t.title, status: t.status, detail: t.detail })),
          cancel: id => { const t = tasks.get(id); if (!t || (t.status !== "running" && t.status !== "queued")) return false; tasks.cancel(id); return true; },
          steer: (id, text) => tasks.steer(id, text),
        } : undefined,
      });
      await this.conductor.start();
      if (gen !== this.gen) return;

      this.setStatus({
        phase: "ready",
        detail: login ? `Signed in as ${login}.` : "Connected.",
        login,
        source: this.source,
        models: models.map(m => ({ id: m.id, name: m.name ?? m.id, vision: m.capabilities?.supports?.vision === true })),
        conductorModel: choice.conductor,
        workerModel: choice.worker,
      });
      this.o.log.info("agent.ready", { login, conductorModel: choice.conductor, workerModel: choice.worker, models: models.length });
      this.watchHealth(client, gen);
    } catch (err) {
      if (gen !== this.gen) return;
      const online = this.o.isOnline?.();
      this.o.log.error("agent.start_failed", { err, online });
      this.setStatus({ phase: "error", detail: explainStartError(err, { source: this.source, online }) });
      await this.doStop();
      // Offline (e.g. started at login before the network): try again later rather than blaming the sign-in.
      if (online === false || /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo/i.test(String(err))) this.retryLater();
    }
  }

  private retryLater(): void {
    if (this.retry) return;
    const recent = this.failures.filter(t => Date.now() - t < 30 * 60_000);
    this.failures = [...recent, Date.now()];
    const ms = Math.min(5 * 60_000, 15_000 * 2 ** Math.min(recent.length, 4));
    this.retry = setTimeout(() => { this.retry = null; void this.start(this.token, this.source); }, ms);
    this.retry.unref?.();
  }

  /** The runtime is a separate process: if it dies, Ember says so and reconnects. */
  private watchHealth(client: CopilotClient, gen: number): void {
    if (this.health) clearInterval(this.health);
    this.health = setInterval(() => {
      if (gen !== this.gen) return;
      void client.ping("ember").catch(() => this.lost(gen, "health check"));
    }, this.o.healthMs ?? 20_000);
    this.health.unref?.();
  }

  private lost(gen: number, why: string): void {
    if (gen !== this.gen) return;
    this.o.log.error("agent.runtime_lost", { why });
    this.presenter.reset();
    this.setStatus({ phase: "error", detail: "Copilot stopped unexpectedly. Reconnecting…" });
    const recent = this.failures.filter(t => Date.now() - t < 10 * 60_000);
    if (recent.length >= 5) {
      this.setStatus({ phase: "error", detail: "Copilot keeps stopping. Press Check again to retry, or restart Ember." });
      void this.stop();
      return;
    }
    this.failures = [...recent, Date.now()];
    void this.start(this.token, this.source);
  }

  private async sweepTaskSessions(client: CopilotClient): Promise<void> {
    try {
      const old = (await client.listSessions()).filter(m => m.sessionId.startsWith("ember-task-"));
      await Promise.all(old.map(m => client.deleteSession(m.sessionId).catch(err => this.o.log.warn("agent.sweep_failed", { sessionId: m.sessionId, err }))));
      if (old.length) this.o.log.info("agent.swept_task_sessions", { count: old.length });
    } catch (err) {
      this.o.log.warn("agent.sweep_failed", { err });
    }
  }

  /** A different model chosen in settings: the conversation switches now, tasks use it from their next start. No restart. */
  async setModels(prefer: { conductor?: string | null; worker?: string | null }): Promise<void> {
    if (this.status.phase !== "ready" || !this.conductor) return;
    const choice = chooseModels(this.models, { conductor: prefer.conductor ?? undefined, worker: prefer.worker ?? undefined });
    if (!choice.conductor) return;
    if (choice.conductor !== this.status.conductorModel) await this.conductor.setModel(choice.conductor);
    this.setStatus({ conductorModel: choice.conductor, workerModel: choice.worker });
    this.o.log.info("agent.models_changed", { conductorModel: choice.conductor, workerModel: choice.worker });
  }

  recordUsage(input: number, output: number): void {
    const u = this.status.usage;
    this.setStatus({ usage: { calls: u.calls + 1, inputTokens: u.inputTokens + input, outputTokens: u.outputTokens + output } });
  }

  /** Where the user was when they last called Ember: tasks from this request start there. */
  private askTarget: (WindowTarget & { app?: string }) | null = null;

  async ask(text: string, context?: { target: WindowTarget & { app?: string }; text: string } | null): Promise<void> {
    this.askTarget = context?.target ?? null;
    // Still connecting (just started, or reconnecting): wait a little rather than say "not connected".
    if (!this.conductor && this.status.phase === "starting") {
      this.presenter.userPrompt(text);
      await Promise.race([this.chain, new Promise(r => setTimeout(r, 15_000))]);
    }
    if (!this.conductor) {
      const signedOut = this.status.phase === "signed-out" || /sign-in|signed in|sign in/i.test(this.status.detail);
      this.presenter.notice({
        title: signedOut ? "I need Copilot first" : "I can't reach Copilot",
        text: signedOut ? "Connect your GitHub account in settings, then ask me again." : this.status.detail,
        actions: [{ id: "ui:settings", label: "Open settings" }],
      });
      return;
    }
    this.remember("you", text);
    try {
      await this.conductor.ask(text, context?.text);
    } catch (err) {
      if (err instanceof ConnectionLost) this.lost(this.gen, "send failed");
      else throw err;
    }
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
    this.o.hands?.confirmer.cancelAll();
    await this.tasks?.drain(2500);
    await this.tasks?.flushDeletes();
    await this.conductor?.forget();
    this.transcript.length = 0;
    this.o.onTranscript?.([]);
    this.o.log.info("agent.conversation_forgotten");
  }

  private async doStop(): Promise<void> {
    if (this.health) { clearInterval(this.health); this.health = null; }
    // Nothing keeps acting or asking once the brain goes away (sign-out, restart, quit).
    this.tasks?.cancelAll();
    this.o.hands?.confirmer.cancelAll();
    await this.tasks?.drain(2500);
    // Finished tasks' sessions are deleted now, while the client can still do it.
    await this.tasks?.flushDeletes();
    this.tasks = null;
    this.presenter.reset();
    await this.conductor?.stop();
    this.conductor = null;
    await this.client?.stop().catch(() => undefined);
    this.client = null;
  }
}
