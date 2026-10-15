/**
 * AgentHost owns the Copilot client: finds the bundled runtime, signs in,
 * picks models, and starts the conductor. Its status drives the Copilot
 * section of the settings window.
 *
 * Starts and stops run one at a time, in order; a start that a newer one
 * replaced gives up at its next step. A health check notices when the runtime
 * dies (or hangs) and reconnects. Changing models doesn't restart anything.
 */

import path from "node:path";
import { CopilotClient, RuntimeConnection, type ProviderConfig } from "@github/copilot-sdk";
import { Conductor, ConnectionLost, forgetSavedConversation, readAgentState, within, writeAgentState } from "./conductor";
import { Presenter, type BubbleOwner } from "./presenter";
import { chooseModels, type ModelLike } from "./models";
import type { AdminPolicy } from "../admin";
import type { Logger } from "../logger";
import type { SettingsStore } from "../settings";
import type { EmberState } from "../../shared/overlay";
import { TaskManager, statusWord, taskOutcome } from "./tasks";
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
  /** A task finished (for a notification when the user isn't looking). `text`: one line saying how it went. */
  onTaskFinished?: (task: { title: string; status: string; summary: string; text: string }) => void;
  /** The conversation changed (the settings window shows it). */
  onTranscript?: (entries: TranscriptEntry[]) => void;
  /** The organisation's own endpoint (admin policy), or for tests and offline demos an OpenAI-compatible server. */
  provider?: ProviderConfig;
  /** Admin lockdown (/etc/ember/policy.json). */
  admin?: () => AdminPolicy;
  /** Is the computer online? A failed start while offline is retried instead of blamed on the sign-in. */
  isOnline?: () => boolean;
  /**
   * Can GitHub be reached right now (see gitHubReachable)? Copilot says "not authenticated" both for a
   * sign-in it refuses and for a GitHub it can't reach (a VPN not up yet, a proxy, a captive portal):
   * with this, the sign-in is blamed only when GitHub answers and Copilot still refuses it.
   */
  reachable?: () => Promise<boolean>;
  /** How often the runtime's health is checked (ms). */
  healthMs?: number;
}

/** A quick look at whether GitHub answers at all, through `fetch` (main passes Electron's net.fetch, which uses the system proxy). */
export function gitHubReachable(fetch: (url: string, init: { method: string; signal: AbortSignal }) => Promise<unknown>, ms = 5000): () => Promise<boolean> {
  return () => fetch("https://api.github.com/", { method: "HEAD", signal: AbortSignal.timeout(ms) }).then(() => true, () => false);
}

const NETWORK = /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network is unreachable|fetch failed|socket hang up/i;
const SIGNED_OUT = "Not connected to Copilot: sign in with GitHub below.";
/** A hung runtime is given this long to answer a health check, a stop or a delete. */
const RUNTIME_WAIT_MS = 5000;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const SOURCE_TEXT: Record<string, string> = { stored: "Ember's saved sign-in", environment: "a token from the environment", "github-cli": "the GitHub CLI sign-in" };

export function explainStartError(err: unknown, ctx: { source?: string; online?: boolean } = {}): string {
  const msg = err instanceof Error ? err.message : String(err);
  const from = ctx.source && SOURCE_TEXT[ctx.source] ? ` (${SOURCE_TEXT[ctx.source]})` : "";
  if (/not found at|ENOENT|EACCES|spawn /i.test(msg)) return "Ember's Copilot runtime is missing or can't start. Reinstall Ember (sudo dnf reinstall ember).";
  if (/^None of the models/.test(msg)) return msg;
  if (ctx.online === false || NETWORK.test(msg)) return "Ember can't reach GitHub right now. It will try again when the network is back.";
  if (/certificate|self.signed|issuer/i.test(msg)) return "Ember can't verify GitHub's certificate. If your organisation's network inspects secure traffic, ask IT to add its certificate for Ember.";
  if (/client not connected|connection is disposed|connection (closed|lost)/i.test(msg)) return "Ember's Copilot runtime stopped while connecting. Press Check again.";
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
    phase: "signed-out", detail: SIGNED_OUT, models: [], conductorModel: null, workerModel: null,
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
  /** When the runtime died lately (five in ten minutes: Ember stops trying). */
  private crashes: number[] = [];
  /** When a start failed for want of a network lately (the wait before the next try grows). */
  private offline: number[] = [];
  /** Starts asked for and not finished yet (a question waits for them rather than saying "not connected"). */
  private starting = 0;
  /** Bumped by every Stop (abortAll): a request still waiting to be sent is dropped. */
  private stops = 0;
  /** This run's conversation: a reconnect resumes it; quitting (stop()) and signing out delete it. */
  private conversation: string | null = null;
  private models: ModelLike[] = [];
  /** The bubble is shared by the conversation and every task: whoever wrote it last owns it. */
  private readonly owner: BubbleOwner = { current: null };
  /** Main's own writes to the bubble ("Listening…", the kill switch's message), as an owner. */
  private readonly mainBubble = {};
  private readonly transcript: TranscriptEntry[] = [];
  /** The conversation's presenter (kept across restarts, so a restart can tidy its bubble). */
  private readonly presenter: Presenter;
  /** Each running task's presenter (the kill switch silences them). */
  private readonly taskPresenters = new Map<string, Presenter>();
  /** Tasks the kill switch stopped: they finish without a bubble of their own (the kill switch said it). */
  private readonly stoppedByAll = new Set<string>();
  private readonly stateFile: string;

  constructor(private o: HostOptions) {
    this.stateFile = path.join(o.userData, "agent.json");
    this.presenter = new Presenter(o.setState, undefined, () => NAMES[o.settings.get().character] ?? "Ember", this.owner, text => this.remember("ember", text), !!o.provider);
  }

  /** Changes with every Stop: main takes it before a slow step (reading the screen) and passes it to ask(). */
  get stopEpoch(): number {
    return this.stops;
  }

  /** Main writes the bubble itself next ("Listening…", the kill switch's message): no presenter's timer hides it. */
  claimBubble(): void {
    this.owner.current = this.mainBubble;
    this.presenter.letGo();
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

  /**
   * (Re)connects with this sign-in. Calls queue: the newest one wins. Resolves to the phase once every
   * queued start and stop has run: "ready", or "error"/"signed-out" with the reason in the status.
   *
   * `how`: "auto" for Ember's own start at launch. After the user signed out, a GitHub CLI or
   * environment sign-in found then isn't used until they sign in again ("user", the default).
   */
  start(token: string | null, source?: string, how: "user" | "auto" = "user"): Promise<AgentPhase> {
    const automatic = source === "environment" || source === "github-cli";
    if (token && how === "user") this.setSignedOut(false);
    else if (token && automatic && readAgentState(this.stateFile).signedOut) token = null;
    return this.launch(token, source);
  }

  private launch(token: string | null, source?: string): Promise<AgentPhase> {
    const gen = ++this.gen;
    this.token = token;
    this.source = source;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    this.starting++;
    const run = this.chain.then(() => this.doStart(token, gen)).finally(() => { this.starting--; });
    this.chain = run.catch(() => undefined);
    return run.then(() => this.settled());
  }

  /** The phase once every queued start and stop has run. */
  private async settled(): Promise<AgentPhase> {
    for (let c = this.chain; ; c = this.chain) {
      await c;
      if (c === this.chain) return this.status.phase;
    }
  }

  private setSignedOut(on: boolean): void {
    try { writeAgentState(this.stateFile, { signedOut: on }); } catch (err) { this.o.log.warn("agent.state_not_saved", { err }); }
  }

  /**
   * Disconnects for good (quit): the conversation is deleted first, within about two seconds and while
   * the runtime can still do it (what the user asked is kept only while Ember runs).
   */
  stop(): Promise<void> {
    return this.halt(true);
  }

  private halt(forget: boolean): Promise<void> {
    ++this.gen;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    const run = this.chain.then(() => this.doStop(forget));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async doStart(token: string | null, gen: number): Promise<void> {
    await this.doStop();
    if (gen !== this.gen) return;
    if (!token && !this.o.provider) {
      this.setStatus({ phase: "signed-out", detail: SIGNED_OUT, login: undefined, source: undefined });
      return;
    }
    this.setStatus({ phase: "starting", detail: "Connecting to Copilot…", source: this.source });
    const localhost = (v: string | undefined) => [v, "127.0.0.1", "localhost"].filter(Boolean).join(",");
    let unreachable = false;
    try {
      let client: CopilotClient;
      let login: string | undefined;
      for (let attempt = 1; ; attempt++) {
        client = new CopilotClient({
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
        if (this.o.provider) break;
        const auth = await client.getAuthStatus();
        if (gen !== this.gen) return;
        if (auth.isAuthenticated) { login = (auth as { login?: string }).login; break; }
        const refused = new Error(`not authenticated${auth.statusMessage ? `: ${auth.statusMessage}` : ""}`);
        // Copilot says the same for a sign-in it refuses and for a GitHub it can't reach: ask GitHub first.
        if (!this.o.reachable) throw refused;
        const reach = await this.o.reachable().catch(() => false);
        if (gen !== this.gen) return;
        if (!reach) { unreachable = true; throw refused; }
        // GitHub answers: a moment's hiccup (a proxy or VPN still settling) gets two more tries before the sign-in is blamed.
        if (attempt >= 3) throw refused;
        this.o.log.warn("agent.auth_retry", { attempt });
        this.client = null;
        await this.stopClient(client);
        await sleep(2000 * attempt);
        if (gen !== this.gen) return;
      }

      let models: ModelLike[] = [];
      const allowed = this.o.admin?.().models.allowed;
      if (!this.o.provider) {
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
          const text = taskOutcome(task);
          this.taskPresenters.delete(task.id);
          this.remember("task", text);
          this.o.onTaskFinished?.({ title: task.title, status: task.status, summary, text });
          // Stopped by the kill switch: its message is on screen, and this task's "Stopped." doesn't replace it.
          if (this.stoppedByAll.delete(task.id) && task.status === "cancelled") return;
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
          presenter: this.taskPresenter(spec.id, spec.goal),
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
        stateFile: this.stateFile,
        resume: this.conversation,
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
        takeReports: tasks ? () => tasks.takeReports().map(t => `Task "${t.title}" ${statusWord(t.status)}: ${t.result?.summary ?? ""}`) : undefined,
        tasks: tasks ? {
          list: () => tasks.list().map(t => ({ id: t.id, title: t.title, status: t.status, detail: t.detail })),
          cancel: id => { const t = tasks.get(id); if (!t || (t.status !== "running" && t.status !== "queued")) return false; tasks.cancel(id); return true; },
          steer: (id, text) => tasks.steer(id, text),
        } : undefined,
      });
      await this.conductor.start();
      this.conversation = this.conductor.sessionId;
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
      // Connected: the wait before the next offline try starts short again. (Crashes count for ten minutes:
      // a runtime that dies again soon after every reconnect is given up on.)
      this.offline = [];
      this.watchHealth(client, gen);
    } catch (err) {
      if (gen !== this.gen) return;
      const online = this.o.isOnline?.();
      const offline = online === false || unreachable || NETWORK.test(String(err));
      this.o.log.error("agent.start_failed", { err, online, unreachable });
      this.setStatus({ phase: "error", detail: explainStartError(err, { source: this.source, online: offline ? false : online }) });
      await this.doStop();
      // Offline (e.g. started at login before the network or the VPN): try again later rather than blaming the sign-in.
      if (offline) this.retryLater();
    }
  }

  private retryLater(): void {
    if (this.retry) return;
    const recent = this.offline.filter(t => Date.now() - t < 30 * 60_000);
    this.offline = [...recent, Date.now()];
    const ms = Math.min(5 * 60_000, 15_000 * 2 ** Math.min(recent.length, 4));
    this.retry = setTimeout(() => { this.retry = null; void this.launch(this.token, this.source); }, ms);
    this.retry.unref?.();
  }

  /** The runtime is a separate process: if it dies or stops answering, Ember says so and reconnects. */
  private watchHealth(client: CopilotClient, gen: number): void {
    if (this.health) clearInterval(this.health);
    const every = this.o.healthMs ?? 20_000;
    let checking = false;
    this.health = setInterval(() => {
      if (gen !== this.gen || checking) return;
      checking = true;
      void within(client.ping("ember"), Math.min(10_000, Math.max(2000, every)))
        .then(r => { if (r === "timeout") this.lost(gen, "health check timed out"); }, () => this.lost(gen, "health check"))
        .finally(() => { checking = false; });
    }, every);
    this.health.unref?.();
  }

  /** `gen`: the connection the failure belongs to (a newer one is left alone). */
  private lost(gen: number, why: string): void {
    if (gen !== this.gen) return;
    this.o.log.error("agent.runtime_lost", { why });
    // An answer cut off half-way says so, instead of vanishing.
    if (this.presenter.busy || why === "send failed") this.presenter.fail("Copilot stopped unexpectedly. I'm reconnecting; ask me again in a moment.");
    else this.presenter.reset();
    this.setStatus({ phase: "error", detail: "Copilot stopped unexpectedly. Reconnecting…" });
    const recent = this.crashes.filter(t => Date.now() - t < 10 * 60_000);
    if (recent.length >= 5) {
      this.setStatus({ phase: "error", detail: "Copilot keeps stopping. Press Check again to retry, or restart Ember." });
      void this.halt(false);
      return;
    }
    this.crashes = [...recent, Date.now()];
    void this.launch(this.token, this.source);
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

  /** A task's own presenter: its bubble is titled with the goal. */
  private taskPresenter(id: string, goal: string): Presenter {
    const p = new Presenter(this.o.setState, undefined, () => goal.length > 40 ? goal.slice(0, 39) + "…" : goal, this.owner, undefined, !!this.o.provider);
    this.taskPresenters.set(id, p);
    return p;
  }

  /** Where the user was when they last called Ember: tasks from this request start there. */
  private askTarget: (WindowTarget & { app?: string }) | null = null;

  /**
   * Sends the user's request to the conductor. `epoch`: stopEpoch when the user asked (main takes it
   * before reading the screen); a Stop since then drops the request instead of sending it.
   */
  async ask(text: string, context?: { target: WindowTarget & { app?: string }; text: string } | null, epoch = this.stopEpoch): Promise<void> {
    if (epoch !== this.stopEpoch) return;
    this.askTarget = context?.target ?? null;
    // Still connecting (just started, reconnecting, or the session still opening): wait a little rather than say "not connected".
    if (this.starting > 0 || this.status.phase === "starting") {
      this.presenter.userPrompt(text);
      await Promise.race([this.settled(), sleep(15_000)]);
      // Stop was pressed while it waited: the request is dropped, not sent once connected.
      if (epoch !== this.stopEpoch) { this.presenter.reset(); return; }
    }
    if (!this.conductor?.sessionId || this.status.phase !== "ready") {
      const signedOut = this.status.phase === "signed-out" || /sign-in|signed in|sign in/i.test(this.status.detail);
      this.presenter.notice({
        title: signedOut ? "I need Copilot first" : "I can't reach Copilot",
        text: signedOut ? "Connect your GitHub account in settings, then ask me again." : this.status.detail,
        actions: [{ id: "ui:settings", label: "Open settings" }],
      });
      return;
    }
    // The connection this request goes out on: if sending fails, that one is replaced (not a newer one).
    const gen = this.gen;
    this.remember("you", text);
    try {
      await this.conductor.ask(text, context?.text);
    } catch (err) {
      if (err instanceof ConnectionLost) this.lost(gen, "send failed");
      else throw err;
    }
  }

  /**
   * Stops the current answer and every running task (the kill switch). Main shows the kill switch's
   * message right after: nothing of the conversation's or a stopped task's replaces it.
   */
  async abortAll(): Promise<void> {
    this.stops++;
    this.claimBubble();
    this.presenter.quiet();
    for (const p of this.taskPresenters.values()) p.quiet();
    for (const t of this.tasks?.list() ?? []) if (t.status === "running" || t.status === "queued") this.stoppedByAll.add(t.id);
    this.tasks?.cancelAll();
    this.o.hands?.confirmer.cancelAll();
    await this.conductor?.abort();
  }

  /**
   * Sign-out: the conversation belongs to the account that had it, so it is deleted (now, or at the
   * next start if Copilot isn't connected). A GitHub CLI or environment sign-in then isn't used on
   * its own (start(…, "auto")) until the user signs in again.
   */
  async forgetConversation(): Promise<void> {
    this.tasks?.cancelAll();
    this.o.hands?.confirmer.cancelAll();
    await this.tasks?.drain(2500);
    await within(this.tasks?.flushDeletes() ?? Promise.resolve(), RUNTIME_WAIT_MS);
    await this.forgetCurrent(RUNTIME_WAIT_MS);
    this.setSignedOut(true);
    this.transcript.length = 0;
    this.o.onTranscript?.([]);
    this.o.log.info("agent.conversation_forgotten");
  }

  /** Deletes this run's conversation (now, or at the next start if Copilot doesn't answer within `ms`). */
  private async forgetCurrent(ms: number): Promise<void> {
    this.conversation = null;
    try {
      if (this.conductor) await this.conductor.forget(ms);
      else forgetSavedConversation(this.stateFile);
    } catch (err) {
      this.o.log.warn("agent.forget_failed", { err });
    }
  }

  /** `forget`: a clean stop (quit) deletes the conversation; a restart keeps it to resume. */
  private async doStop(forget = false): Promise<void> {
    if (this.health) { clearInterval(this.health); this.health = null; }
    // Nothing keeps acting or asking once the brain goes away (sign-out, restart, quit).
    this.tasks?.cancelAll();
    this.o.hands?.confirmer.cancelAll();
    // First, while the runtime surely still runs (quitting doesn't wait long).
    if (forget) await this.forgetCurrent(2000);
    await this.tasks?.drain(2500);
    // Finished tasks' sessions are deleted now, while the client can still do it (a hung runtime isn't waited for).
    await within(this.tasks?.flushDeletes() ?? Promise.resolve(), RUNTIME_WAIT_MS);
    // The cards go with their manager: a failed card's Close would reach nobody after a restart.
    this.tasks?.close();
    this.tasks = null;
    this.presenter.reset();
    await this.conductor?.stop();
    this.conductor = null;
    const client = this.client;
    this.client = null;
    if (client) await this.stopClient(client);
  }

  /** Stops the runtime; one that doesn't answer (hung) is killed. */
  private async stopClient(client: CopilotClient): Promise<void> {
    const r = await within(client.stop().catch(() => undefined), RUNTIME_WAIT_MS);
    if (r === "timeout") {
      this.o.log.warn("agent.runtime_hung");
      await client.forceStop().catch(() => undefined);
    }
  }
}
