/**
 * AgentHost owns the Copilot client: finds the bundled runtime, signs in,
 * picks models, and starts the conductor. Its status drives the Copilot
 * section of the settings window.
 *
 * Starts and stops run one at a time, in order; a start that a newer one
 * replaced gives up at its next step. A health check notices when the runtime
 * dies (or hangs) and reconnects. Changing models doesn't restart anything.
 */

import fs from "node:fs";
import path from "node:path";
import { CopilotClient, RuntimeConnection, type ProviderConfig } from "@github/copilot-sdk";
import { Conductor, ConnectionLost, NO_ANSWER, forgetSavedConversation, readAgentState, within, writeAgentState } from "./conductor";
import { BubbleOwner, Presenter, type PresenterEvent } from "./presenter";
import { chooseModels, type ModelLike } from "./models";
import type { AdminPolicy } from "../admin";
import type { Logger } from "../logger";
import type { SettingsStore } from "../settings";
import type { BubbleState, EmberState } from "../../shared/overlay";
import { TaskManager, statusWord, taskOutcome, titleOf, type Task } from "./tasks";
import { Worker, type WorkerDeps } from "./worker";
import type { Confirmer } from "./confirm";
import type { Perception, WindowTarget } from "../perception";
import type { AtspiSidecar, Bounds } from "../perception/sidecar";
import { isRiskyLabel, type PolicyEngine } from "../policy/policy";
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
  /** Is Enter or Space held down on the user's keyboard (a guide sees a keyboard user press the control pointed at)? */
  activationKey?: WorkerDeps["activationKey"];
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
  /** Copilot stopped answering and Ember reconnects once the tasks running are done (reconnecting now would stop them). */
  waitingForTasks?: boolean;
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
  /**
   * Another account signed in: the conversation of the one before (and its transcript) was deleted, so main
   * drops what it kept of it too (the ask box's history).
   */
  onAccountChanged?: () => void;
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
  /**
   * The system's proxy for a URL, in Chromium's words ("PROXY host:port; DIRECT"): main passes
   * session.defaultSession.resolveProxy, which follows GNOME's settings and PAC files. The runtime only reads
   * HTTPS_PROXY, so without one in the environment this is passed on to it.
   */
  resolveProxy?: (url: string) => Promise<string>;
  /** How often the runtime's health is checked (ms). */
  healthMs?: number;
  /** How long a request the runtime took may wait for its turn to begin (ms; TURN_START_MS, see TurnWatch). */
  turnStartMs?: number;
  /** How long a turn under way may hear nothing before Ember says it's still waiting (ms; TURN_SLOW_MS). */
  turnSlowMs?: number;
  /** How long a turn under way may hear nothing before it is given up on (ms; TURN_SILENT_MS). */
  turnSilentMs?: number;
  /** Whether this user's inotify instances are all in use (inotifyUsedUp; tests pass their own). */
  inotifyUsedUp?: () => boolean;
}

/** A quick look at whether GitHub answers at all, through `fetch` (main passes Electron's net.fetch, which uses the system proxy). */
export function gitHubReachable(fetch: (url: string, init: { method: string; signal: AbortSignal }) => Promise<unknown>, ms = 5000): () => Promise<boolean> {
  return () => fetch("https://api.github.com/", { method: "HEAD", signal: AbortSignal.timeout(ms) }).then(() => true, () => false);
}

/**
 * Chromium's proxy for a URL ("PROXY host:port; DIRECT", the first entry counts) as a proxy URL for the runtime;
 * null for DIRECT. A SOCKS proxy comes back as `socks`: the runtime can't use one.
 */
export function proxyFromChromium(rule: string): { url: string | null; socks?: string } {
  const m = /^(PROXY|HTTPS|SOCKS[45]?)\s+(\S+)$/i.exec(rule.split(";")[0]?.trim() ?? "");
  if (!m) return { url: null };
  const kind = m[1].toUpperCase();
  if (kind.startsWith("SOCKS")) return { url: null, socks: `${kind === "SOCKS5" ? "socks5" : "socks4"}://${m[2]}` };
  return { url: `${kind === "HTTPS" ? "https" : "http"}://${m[2]}` };
}

/** The host name of a URL, as NO_PROXY lists it (null if it isn't one). */
function hostOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^\[|\]$/g, "") || null; } catch { return null; }
}

/** What a task cut off by a runtime that stopped says (it didn't finish, and the user didn't stop it). */
export const CUT_OFF = "Copilot stopped unexpectedly; the task didn't finish.";
/** The same when the runtime was reconnected because it stopped answering the conversation (it didn't stop). */
export const CUT_OFF_STALLED = "Copilot didn't answer; the task didn't finish.";

const NETWORK = /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network is unreachable|fetch failed|socket hang up|net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|CONNECTION_\w+|ADDRESS_UNREACHABLE|NETWORK_\w+|TIMED_OUT|PROXY_\w+|TUNNEL_CONNECTION_FAILED|EMPTY_RESPONSE)/i;
const SIGNED_OUT = "Not connected to Copilot: sign in with GitHub below.";
/** A hung runtime is given this long to answer a health check, a stop or a delete. */
const RUNTIME_WAIT_MS = 5000;
/** The conversation's request was taken but its turn never began (TurnWatch). */
const NOT_ANSWERING = "Copilot isn't answering. I'm reconnecting; ask me again in a moment.";
/** The same while tasks are at work: Copilot is reconnected once they're done. */
const NOT_ANSWERING_AFTER_TASKS = "Copilot isn't answering. I'll reconnect when the tasks running are done; ask me again then.";
/** The same, with this user's inotify instances used up (the runtime can't begin a turn then). */
const NO_WATCHERS = "Copilot can't work right now: this computer has run out of file watchers. Close a few apps, then ask me again.";
const NO_WATCHERS_WHY = "Copilot isn't answering: the system's limit on file watchers (fs.inotify.max_user_instances) is used up. Close some apps, or ask IT to raise the limit.";
const NO_WATCHERS_DETAIL = `${NO_WATCHERS_WHY} Reconnecting…`;
/**
 * The conversation's turn began and then heard nothing from Copilot for minutes (TurnWatch), and ending it didn't
 * end it: Copilot is reconnected (the conductor said NO_ANSWER).
 */
const NO_ANSWER_DETAIL = "Copilot didn't answer in time. Reconnecting…";
/** A reconnect put off while tasks are at work (the runtime still works for them): what settings show meanwhile. */
const AFTER_TASKS = "Reconnecting when the tasks running are done…";

/**
 * This user's inotify instances in use and the limit (fs.inotify.max_user_instances: 128 on RHEL 8, and every app
 * takes some; Ember's Copilot runtime takes one per conversation or task), or null when they can't be counted.
 * Counted in `proc`: the instances held by processes of `uid`.
 */
export function inotifyUse(proc = "/proc", uid = process.getuid?.()): { used: number; max: number } | null {
  try {
    const max = Number(fs.readFileSync(path.join(proc, "sys/fs/inotify/max_user_instances"), "utf8"));
    if (!(max > 0)) return null;
    let n = 0;
    for (const pid of fs.readdirSync(proc)) {
      if (!/^\d+$/.test(pid)) continue;
      const dir = path.join(proc, pid, "fd");
      try {
        if (uid !== undefined && fs.statSync(path.join(proc, pid)).uid !== uid) continue;
        for (const fd of fs.readdirSync(dir)) {
          try { if (fs.readlinkSync(path.join(dir, fd)) === "anon_inode:inotify") n++; } catch { /* closed meanwhile */ }
        }
      } catch { /* gone, or another user's */ }
    }
    return { used: n, max };
  } catch {
    return null;
  }
}

/** Whether they are all in use: the Copilot runtime then takes requests but never begins them. */
export function inotifyUsedUp(proc = "/proc", uid = process.getuid?.()): boolean {
  const u = inotifyUse(proc, uid);
  return !!u && u.used >= u.max;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const SOURCE_TEXT: Record<string, string> = { stored: "Ember's saved sign-in", environment: "a token from the environment", "github-cli": "the GitHub CLI sign-in" };

/** The system proxy Ember gave the runtime (or couldn't), for a sign-in error that may really be the proxy's. */
function proxyNote(p?: { url: string | null; socks?: string }): string {
  if (p?.socks) return ` Your system proxy (${p.socks}) is a SOCKS proxy, which Ember's Copilot runtime can't use: ask IT for an HTTP proxy and set HTTPS_PROXY for Ember.`;
  if (p?.url) return ` Ember sent Copilot through your system proxy (${p.url}); if that proxy needs its own sign-in, set HTTPS_PROXY for Ember with it.`;
  return "";
}

export function explainStartError(err: unknown, ctx: { source?: string; online?: boolean; proxy?: { url: string | null; socks?: string } } = {}): string {
  const msg = err instanceof Error ? err.message : String(err);
  const from = ctx.source && SOURCE_TEXT[ctx.source] ? ` (${SOURCE_TEXT[ctx.source]})` : "";
  if (/not found at|ENOENT|EACCES|spawn /i.test(msg)) return "Ember's Copilot runtime is missing or can't start. Reinstall Ember (sudo dnf reinstall ember).";
  if (/^None of the models/.test(msg)) return msg;
  if (ctx.online === false || NETWORK.test(msg)) return "Ember can't reach GitHub right now. It will try again when the network is back.";
  if (/certificate|self.signed|issuer|ERR_CERT_/i.test(msg)) return "Ember can't verify GitHub's certificate. If your organisation's network inspects secure traffic, ask IT to add its certificate for Ember.";
  if (/client not connected|connection (is |got |was )?disposed|connection (closed|lost)|pending response rejected/i.test(msg)) return "Ember's Copilot runtime stopped while connecting. Press Check again.";
  if (/copilot (cli )?policy|disabled by (your )?organi[sz]ation|organi[sz]ation polic/i.test(msg)) return "Copilot is turned off for your account by an organisation policy. Ask your GitHub admin to enable the Copilot CLI policy.";
  if (/\bseat\b|subscription|no copilot access|\b(status|HTTP|code)\s*40[23]\b/i.test(msg)) return "This GitHub account has no Copilot access. Check your Copilot subscription or seat.";
  if (/not authenticated|unauthori[sz]ed|bad credentials|\b(status|HTTP|code)\s*401\b/i.test(msg)) {
    return `Copilot didn't accept the GitHub sign-in Ember found${from}. It may have expired, or this account may not have Copilot. Sign in again, or run “gh auth login” in a terminal and press Check again.${proxyNote(ctx.proxy)}`;
  }
  return msg;
}

const NAMES: Record<string, string> = { cinder: "Cinder", wisp: "Wisp", glassling: "Glassling", glint: "Glint" };
/** How long main's own bubble holds off everything else at most, if main doesn't give it back sooner. */
const MAIN_HOLD_MS = 30_000;
/**
 * A reply this short only says "on it" (start_task asks the conversation for a few words): stale once the task
 * has spoken. A longer one answered something else as well.
 */
const ANNOUNCEMENT_CHARS = 80;
/** How a finished task looks: proud, calm (stopped, or the user said no), or sorry. */
const OUTCOME = {
  done: { emotion: "proud", gesture: "thumbsUp", mood: "done", empty: "Done." },
  cancelled: { emotion: "neutral", gesture: "rest", mood: "idle", empty: "Stopped." },
  failed: { emotion: "sad", gesture: "facepalm", mood: "error", empty: "It didn't finish." },
} as const;
/** A finished task, as the conductor hears about it. */
const report = (t: Task) => `Task "${t.title}" ${statusWord(t.status)}: ${t.result?.summary ?? ""}`;
/** Requests sent while the conversation was busy, kept at most (the runtime runs them one turn at a time). */
const MAX_QUEUED = 20;

/**
 * One request of the user's: where they were when they called Ember, what they said, and what the conversation
 * read on the screen in its turn (the context sent with it, describe_screen's answers).
 */
interface UserRequest { target: (WindowTarget & { app?: string }) | null; words: string; screen: string[] }
/** Words that only answer ("yes please", "both of them", "the first one", "go ahead"), besides names and numbers. */
const ANSWER_WORD = /^(yes|yeah|yep|yup|sure|ok|okay|please|go|ahead|do|it|that|this|them|those|these|both|all|of|the|a|an|first|second|third|last|one|ones|and|or|either|neither|none|no|nope|thanks|thank|you|correct|right|exactly|fine|sounds|good|great|perfect|alright|absolutely|definitely|indeed|just|only|too|also|same|again)$/i;
/**
 * A few words that name no action: only answer words, names and numbers ("Ana Lopez", "both of them", "yes please"). A
 * name is capitalised where no sentence starts, or is followed by another one ("Ana Lopez"; not "Rename it").
 */
const onlyAnswers = (s: string) => {
  const ws = s.normalize("NFKC").match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? [];
  const name = (w: string, i: number) => /^\p{Lu}/u.test(w) && (i > 0 || ws.length === 1 || /^\p{Lu}/u.test(ws[1]));
  return ws.length > 0 && ws.length <= 6 && ws.every((w, i) => ANSWER_WORD.test(w) || /^\p{N}+$/u.test(w) || name(w, i));
};

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
  /** The account the conversation belongs to: signed in as another, it isn't resumed. */
  private conversationLogin: string | undefined;
  private models: ModelLike[] = [];
  /** The bubble is shared by the conversation and every task (see BubbleOwner). */
  private readonly owner: BubbleOwner;
  /** Main's own writes to the bubble ("Listening…", the kill switch's message), as an owner. */
  private readonly mainBubble = {};
  /** Ends main's hold on the bubble if main doesn't give it back. */
  private mainHold: ReturnType<typeof setTimeout> | null = null;
  /**
   * The runtime stopped under the tasks (or stopped answering): the next stop ends them as failed with this, not as
   * stopped by the user.
   */
  private cutOff: string | null = null;
  /**
   * The conversation stalled while tasks were at work, and the runtime still works for them: Copilot is reconnected
   * (this) once they're done, not before (a reconnect would cut them off).
   */
  private reconnectAfterTasks: (() => void) | null = null;
  /** Ember is quitting: finished tasks are neither shown nor announced. */
  private quitting = false;
  /** How the tasks of a connection that went away ended, for the next conductor (it resumes the conversation). */
  private carried: string[] = [];
  /** The system proxy given to the runtime at the last start (or a SOCKS one it couldn't use). */
  private proxy: { url: string | null; socks?: string } | undefined;
  private readonly transcript: TranscriptEntry[] = [];
  /** The conversation's presenter (kept across restarts, so a restart can tidy its bubble). */
  private readonly presenter: Presenter;
  /** Each running task's presenter (the kill switch silences them). */
  private readonly taskPresenters = new Map<string, Presenter>();
  /** Tasks the kill switch stopped: they finish without a bubble of their own (the kill switch said it). */
  private readonly stoppedByAll = new Set<string>();
  /** Tasks the conversation's latest turn started (its reply announces them: "On it…"). */
  private readonly announced = new Set<string>();
  /** Finished tasks' presenters, while their cards are up (closing a card drops a result still waiting to show). */
  private readonly outcomes = new Map<string, Presenter>();
  private readonly stateFile: string;

  constructor(private o: HostOptions) {
    this.stateFile = path.join(o.userData, "agent.json");
    // A question with buttons holds the bubble; what it held off shows once it's answered.
    const c = o.hands?.confirmer;
    this.owner = new BubbleOwner(c ? { up: () => c.waiting, answered: () => c.settled().then(() => this.dropAnnouncement()) } : undefined);
    this.presenter = new Presenter(o.setState, undefined, () => NAMES[o.settings.get().character] ?? "Ember", this.owner, text => this.remember("ember", text), !!o.provider,
      { onEvent: e => this.conversationEvent(e) });
  }

  /**
   * A turn of the conversation starts with its request's message (the runtime holds a request sent during a
   * turn until that turn ends): what that turn does belongs to that request. The message is the prompt
   * conductor.ask sent, which ends with the user's words; the oldest request it matches is the one (those
   * before it never ran: Stop drops what is waiting). A message that is none of them (nothing the user asked)
   * takes none of their context.
   */
  private conversationEvent(e: PresenterEvent): void {
    if (e.type !== "user.message" || (e as { agentId?: string }).agentId) return;
    const said = typeof e.data?.content === "string" ? e.data.content.trimEnd() : "";
    const i = this.queued.findIndex(r => said.endsWith(r.words.trim()));
    this.turn = i < 0 ? null : this.queued[i];
    this.queued.splice(0, i + 1);
    // Its reply announces the tasks it starts ("On it…"), not the ones an earlier turn did.
    this.announced.clear();
  }

  /**
   * The conversation's reply announcing a task ("On it…") is stale once a question was answered (`task`
   * absent: a task has spoken to the user since) or, if it never got on screen, once that task finished.
   * One already read (covered by the question) isn't shown again. One never seen still shows once if it says
   * more than "on it" (it answered something else too); only a bare announcement is dropped.
   */
  private dropAnnouncement(task?: string): void {
    const p = this.presenter;
    if (p.busy || !p.visible || (task ? !this.announced.has(task) : this.announced.size === 0)) return;
    const b = p.bubble;
    const bare = b.mood === "idle" && b.thought.length <= ANNOUNCEMENT_CHARS;
    // (At a task's end a reply already seen may still be on screen: it keeps its own time.)
    if (p.waiting ? bare : !task) p.drop();
  }

  /** Changes with every Stop: main takes it before a slow step (reading the screen) and passes it to ask(). */
  get stopEpoch(): number {
    return this.stops;
  }

  /**
   * Main writes the bubble itself next ("Listening…", the kill switch's message): no presenter's timer hides
   * it, and neither the conversation nor a task replaces it until main gives it back (releaseBubble), the user
   * asks something, or 30 seconds pass. A task's work shows on its card meanwhile. The answer or result it
   * covers doesn't run out of time underneath (main may put it back: a wake that was another word).
   */
  claimBubble(): void {
    this.owner.claim(this.mainBubble);
    this.presenter.letGo();
    if (this.mainHold) clearTimeout(this.mainHold);
    this.mainHold = setTimeout(() => this.releaseBubble(null), MAIN_HOLD_MS);
    this.mainHold.unref?.();
  }

  /**
   * Main is done with its own bubble; `showing` is what is on screen now. The conversation's answer, or the
   * task result main covered, comes back if main put it back on screen, it hadn't been seen yet, or its turn
   * (or task) is still going, and it goes after its reading time. Otherwise it's over, and a task still at
   * work shows its progress again. Returns false if what is on screen now is nobody's but main's (no presenter
   * will hide it: one of main's own, or something put back that is over): main hides it itself.
   */
  releaseBubble(showing: BubbleState | null = null): boolean {
    if (this.mainHold) { clearTimeout(this.mainHold); this.mainHold = null; }
    if (this.owner.holder !== this.mainBubble) return true;
    this.owner.holder = null;
    const p = this.presenter;
    const back = (x: Presenter) => x.atWork || x.waiting || (showing !== null && x.isShowing(showing));
    const covered = this.owner.uncover(x => x === p || back(x));
    // (A question up meanwhile: it shows once that's answered.)
    if (back(p) && (p.reshow() || p.visible)) return true;
    p.drop();
    // What main put back stays on screen (it isn't replaced at once by something else waiting).
    if (!(covered && covered !== p && showing !== null && covered.isShowing(showing) && covered.reshow())) this.owner.free();
    return this.owner.current !== this.mainBubble;
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  /** A start failed for want of a network and will try again by itself: nothing for the user to set up. */
  get waitingForNetwork(): boolean {
    return this.retry !== null;
  }

  getTranscript(): TranscriptEntry[] {
    return [...this.transcript];
  }

  /** The last thing Ember said, in full. */
  lastAnswer(): string | null {
    return [...this.transcript].reverse().find(e => e.who === "ember")?.text ?? null;
  }

  /**
   * What the user said for a task started in turn `r`, which its risky steps are checked against: their words in that
   * turn, and where those only answer Ember ("yes please", "Ana Lopez", "both of them": Ember's last words before them
   * asked a question and they name nothing risky of their own, or they are a few words that name no action at all), the
   * user's words in the turn before too (and before that while those answered too: three turns at most, each within ten
   * minutes of the next, none before a task's outcome). Only the user's own words, never what was read on the screen.
   */
  private userWordsOf(r: UserRequest | null): string | undefined {
    if (!r) return undefined;
    const said = [r.words];
    const log = this.transcript;
    let at = log.map(e => e.who === "you" && e.text === r.words.slice(0, 4000)).lastIndexOf(true);
    for (let n = 0; at > 0 && n < 3; n++) {
      const reply = log[at].text;
      let k = at - 1;
      const asked = log[k]?.who === "ember" && /\?\s*$/.test(log[k].text.trim());
      while (k >= 0 && log[k].who === "ember") k--;
      const before = log[k];
      if (!before || before.who !== "you" || Date.parse(log[at].t) - Date.parse(before.t) > 10 * 60_000) break;
      if (isRiskyLabel(reply) || !(asked || onlyAnswers(reply))) break;
      said.unshift(/[.!?]\s*$/.test(before.text) ? before.text.trim() : `${before.text.trim()}.`);
      at = k;
    }
    return said.join("\n");
  }

  private remember(who: TranscriptEntry["who"], text: string): void {
    this.transcript.push({ t: new Date().toISOString(), who, text: text.slice(0, 4000) });
    if (this.transcript.length > 60) this.transcript.splice(0, this.transcript.length - 60);
    this.o.onTranscript?.(this.getTranscript());
  }

  private setStatus(patch: Partial<AgentStatus>): void {
    this.status = { ...this.status, ...patch, waitingForTasks: this.reconnectAfterTasks !== null };
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
    this.quitting = false;
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
    this.quitting = true;
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
    let unreachable = false;
    try {
      const env = await this.runtimeEnv();
      if (gen !== this.gen) return;
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
          env,
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
      // Another account than the conversation's (signed in again from the error state, or the GitHub CLI's
      // account changed): it isn't resumed under this one. It's deleted, as at sign-out, and what it said and
      // how its tasks ended go with it.
      if (this.conversation && login !== this.conversationLogin) {
        this.o.log.info("agent.account_changed");
        await this.forgetCurrent(RUNTIME_WAIT_MS);
        this.carried = [];
        this.transcript.length = 0;
        this.o.onTranscript?.([]);
        this.o.onAccountChanged?.();
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
          // Copilot is to be reconnected once the tasks are done: this may have been the last one.
          if (this.reconnectAfterTasks) void Promise.resolve().then(() => { if (!this.tasksAtWork()) this.reconnectAfterTasks?.(); });
          const summary = task.result?.summary ?? "";
          const text = taskOutcome(task);
          const presenter = this.taskPresenters.get(task.id) ?? this.taskPresenter(task.id, task.goal);
          this.taskPresenters.delete(task.id);
          this.remember("task", text);
          // Stopped by the kill switch: its message is on screen and says it all (nothing shown or spoken per task).
          // Quitting: nothing more is shown or said.
          if ((this.stoppedByAll.delete(task.id) && task.status === "cancelled") || this.quitting) { presenter.quiet(); return; }
          this.o.onTaskFinished?.({ title: task.title, status: task.status, summary, text });
          this.dropAnnouncement(task.id);
          // Shown when nothing else holds the bubble (an answer, a question, "Listening…"), then it goes on its own.
          const o = OUTCOME[task.status === "done" || task.status === "cancelled" ? task.status : "failed"];
          presenter.outcome({ title: task.title, text: summary || o.empty, emotion: o.emotion, gesture: o.gesture, mood: o.mood });
          this.outcomes.set(task.id, presenter);
        },
        onRemoved: (task, byUser) => {
          const p = this.outcomes.get(task.id);
          this.outcomes.delete(task.id);
          // The user closed the card: its result, if it hasn't shown yet, doesn't pop up afterwards.
          if (byUser && p?.waiting) p.drop();
        },
        provider: !!this.o.provider,
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
          activationKey: hands.activationKey,
          desk: hands.desk,
          onDesk: hands.onDesk,
          onProgress: progress,
          onUsage: (i, o) => this.recordUsage(i, o),
          limits: { turnStartMs: this.o.turnStartMs, turnSlowMs: this.o.turnSlowMs, turnSilentMs: this.o.turnSilentMs },
          inotifyUsedUp: this.o.inotifyUsedUp ?? inotifyUsedUp,
        }, spec),
      }) : null;
      const tasks = this.tasks;
      this.conductor = new Conductor({
        client, settings: this.o.settings, presenter: this.presenter, log: this.o.log.child("conductor"),
        stateFile: this.stateFile,
        resume: this.conversation,
        workDir: path.join(this.o.userData, "copilot", "empty-workdir"),
        model: choice.conductor, provider: this.o.provider,
        // What the conversation reads on the screen goes with the tasks it starts in that turn (their goals may carry it).
        describeScreen: this.o.describeScreen ? async () => { const turn = this.turn; const seen = await this.o.describeScreen!(); turn?.screen.push(seen); return seen; } : undefined,
        onUsage: (i, o) => this.recordUsage(i, o),
        onAnswer: this.o.onAnswer,
        onTurnEnd: this.o.onTurnEnd,
        turnStartMs: this.o.turnStartMs,
        turnSlowMs: this.o.turnSlowMs,
        turnSilentMs: this.o.turnSilentMs,
        // A turn under way that went silent (a model request that never answers) is ended, and Ember says Copilot
        // didn't answer; the requests waiting behind it go with it. Only the conversation's request is given up on:
        // the tasks go on (each one's own watch decides its fate).
        onSilentTurn: () => { this.queued = []; },
        // The runtime took a request and never began its turn, or a silent turn didn't end when it was aborted,
        // though it answers its health check: it is reconnected as a hung one is. The requests sent on it never run
        // there (a reconnect resumes the conversation). Out of inotify instances, the runtime can't begin a turn (a
        // reconnect doesn't help until apps close): Ember says so. With tasks at work, the runtime still works for
        // them: it is reconnected once they're done (a task that goes silent too is ended by its own watch, a
        // runtime that dies by the health check). Tasks cut off by a reconnect say Copilot didn't answer.
        onStuck: why => {
          // A request of the user's on this connection stalled (not a turn nobody asked for, which could repeat on its own).
          const asked = this.queued.length > 0 || this.turn !== null;
          this.queued = [];
          const full = why === "not-started" && (this.o.inotifyUsedUp ?? inotifyUsedUp)();
          const reason = why === "silent" ? "turn went silent and didn't end" : full ? "turn didn't start: inotify instances used up" : "turn didn't start";
          if (this.tasksAtWork()) {
            this.o.log.warn("agent.reconnect_after_tasks", { why: reason });
            // (A silent turn: the conductor said Copilot didn't answer.)
            if (why === "not-started") this.presenter.fail(full ? NO_WATCHERS : NOT_ANSWERING_AFTER_TASKS);
            // (Set first: the status says the reconnect waits for the tasks, so settings doesn't offer one that stops them.)
            this.reconnectAfterTasks = () => { this.reconnectAfterTasks = null; this.lost(gen, reason, undefined, why === "silent" ? NO_ANSWER_DETAIL : full ? NO_WATCHERS_DETAIL : "Copilot isn't answering. Reconnecting…", asked, CUT_OFF_STALLED); };
            this.setStatus({ phase: "error", detail: full ? `${NO_WATCHERS_WHY} ${AFTER_TASKS}` : `Copilot isn't answering. ${AFTER_TASKS}` });
            return;
          }
          if (why === "silent") this.lost(gen, reason, NO_ANSWER, NO_ANSWER_DETAIL, asked, CUT_OFF_STALLED);
          else this.lost(gen, reason, full ? NO_WATCHERS : NOT_ANSWERING, full ? NO_WATCHERS_DETAIL : undefined, asked, CUT_OFF_STALLED);
        },
        startTask: tasks ? goal => {
          // With actions turned off by the administrator, Ember can still answer and guide, never act.
          if (this.o.admin?.().features.actions === false) return "Your organisation has turned off Ember acting in apps. Tell the user, and offer to show them how (show_me) instead.";
          // Risky steps are checked against what the user said in this turn's request (and the one it answers), not the
          // goal (the conductor may have read it off the screen). A request sent meanwhile waits for its own turn: none of
          // it goes with this task.
          const r = this.turn;
          const t = tasks.start(goal, { target: r?.target ?? undefined, userWords: this.userWordsOf(r), screen: r?.screen.join("\n") || undefined });
          this.announced.add(t.id);
          return `Task ${t.id} started: "${t.title}". It runs in the background and shows a card beside Ember. Tell the user you're on it, in a few words.`;
        } : undefined,
        showMe: tasks ? goal => {
          const t = tasks.start(goal, { target: this.turn?.target ?? undefined, mode: "guide" });
          this.announced.add(t.id);
          return `Guide ${t.id} started: Ember will point at each step and wait for the user to click. Tell the user to follow Ember, in a few words.`;
        } : undefined,
        takeReports: () => [...this.carried.splice(0), ...(tasks?.takeReports().map(report) ?? [])],
        tasks: tasks ? {
          list: () => tasks.list().map(t => ({ id: t.id, title: t.title, status: t.status, detail: t.detail })),
          cancel: id => { const t = tasks.get(id); if (!t || (t.status !== "running" && t.status !== "queued")) return false; tasks.cancel(id); return true; },
          steer: (id, text) => tasks.steer(id, text, this.turn?.words, this.turn?.screen.join("\n") || undefined),
        } : undefined,
      });
      await this.conductor.start();
      this.conversation = this.conductor.sessionId;
      this.conversationLogin = login;
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
      this.setStatus({ phase: "error", detail: explainStartError(err, { source: this.source, online: offline ? false : online, proxy: this.proxy }) });
      await this.doStop();
      // Offline (e.g. started at login before the network or the VPN): try again later rather than blaming the
      // sign-in. Not if a newer start or stop came meanwhile: a stale retry would restart a working connection.
      if (offline && gen === this.gen) this.retryLater();
    }
  }

  /**
   * The runtime's environment. Localhost never goes through a proxy (both spellings: the runtime reads the
   * lowercase one first). The runtime reads only HTTPS_PROXY, not GNOME's proxy settings or a PAC file, so
   * without one in the environment the system's proxy is passed on: GitHub's, or with the organisation's own
   * endpoint that endpoint's (Ember's requests go only there then). An endpoint the system reaches directly
   * (GNOME's exceptions, a PAC file) is added to NO_PROXY.
   */
  private async runtimeEnv(): Promise<NodeJS.ProcessEnv> {
    const e = process.env;
    const noProxy = (v: string | undefined, more: string[] = []) => [v, "127.0.0.1", "localhost", ...more].filter(Boolean).join(",");
    const env: NodeJS.ProcessEnv = { ...e, NO_PROXY: noProxy(e.NO_PROXY), no_proxy: noProxy(e.no_proxy ?? e.NO_PROXY) };
    this.proxy = undefined;
    if (e.HTTPS_PROXY || e.https_proxy || !this.o.resolveProxy) return env;
    const resolve = this.o.resolveProxy;
    const proxyFor = async (url: string) => {
      const rule = await within(Promise.resolve().then(() => resolve(url)).catch(() => "DIRECT"), 3000);
      return proxyFromChromium(rule === "timeout" ? "DIRECT" : rule);
    };
    let p = await proxyFor("https://api.github.com/");
    let direct: string[] = [];
    const endpoint = this.o.provider?.baseUrl ? hostOf(this.o.provider.baseUrl) : null;
    if (endpoint) {
      const own = await proxyFor(this.o.provider!.baseUrl!);
      if (own.url || own.socks) p = own;
      else direct = [endpoint];
    }
    const out: NodeJS.ProcessEnv = direct.length ? { ...env, NO_PROXY: noProxy(e.NO_PROXY, direct), no_proxy: noProxy(e.no_proxy ?? e.NO_PROXY, direct) } : env;
    if (!p.url && !p.socks) return out;
    this.proxy = p;
    this.o.log.info("agent.system_proxy", { kind: p.socks ? "socks" : "http", endpointDirect: direct.length > 0 });
    if (!p.url) return out;
    return { ...out, HTTPS_PROXY: p.url, https_proxy: p.url, ...(e.HTTP_PROXY || e.http_proxy ? {} : { HTTP_PROXY: p.url, http_proxy: p.url }) };
  }

  private retryLater(): void {
    if (this.retry) return;
    const recent = this.offline.filter(t => Date.now() - t < 30 * 60_000);
    this.offline = [...recent, Date.now()];
    // 15 s, 30 s, then every minute: the network (or the VPN) is often back within minutes.
    const ms = Math.min(60_000, 15_000 * 2 ** Math.min(recent.length, 2));
    this.retry = setTimeout(() => { this.retry = null; void this.launch(this.token, this.source); }, ms);
    this.retry.unref?.();
  }

  /** A start that failed for want of a network and waits to try again tries now. Returns whether one did. */
  private retryNow(): boolean {
    if (!this.retry) return false;
    clearTimeout(this.retry);
    this.retry = null;
    void this.launch(this.token, this.source);
    return true;
  }

  /**
   * The network changed (main: on Electron's online/offline change). Back online, a start waiting to
   * retry tries at once instead of waiting out its time.
   */
  networkChanged(online = true): void {
    if (online && this.status.phase === "error" && this.retryNow()) this.o.log.info("agent.network_back");
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

  /**
   * `gen`: the connection the failure belongs to (a newer one is left alone). `says`: what the conversation
   * tells the user (always shown), when it isn't that Copilot stopped; `detail`: what settings show then.
   * `stalled`: the turn of a request the user sent on this connection never began or went silent, not a crash: it
   * isn't counted towards giving up (each one takes a request of the user's, so it never loops on its own; with the
   * file watchers used up, Ember would otherwise stop trying, and stay stopped once they're free again).
   * `cut`: what the tasks cut off by the reconnect say.
   */
  private lost(gen: number, why: string, says?: string, detail?: string, stalled = false, cut = CUT_OFF): void {
    if (gen !== this.gen) return;
    this.o.log.error("agent.runtime_lost", { why });
    // Its tasks were cut off: they end as failed (the user stopped nothing), and the next conductor hears so.
    this.cutOff = cut;
    // An answer cut off half-way says so, instead of vanishing.
    if (says || this.presenter.busy || why === "send failed") this.presenter.fail(says ?? "Copilot stopped unexpectedly. I'm reconnecting; ask me again in a moment.");
    else this.presenter.reset();
    this.setStatus({ phase: "error", detail: detail ?? (says ? "Copilot isn't answering. Reconnecting…" : "Copilot stopped unexpectedly. Reconnecting…") });
    if (!stalled) {
      const recent = this.crashes.filter(t => Date.now() - t < 10 * 60_000);
      if (recent.length >= 5) {
        this.setStatus({ phase: "error", detail: "Copilot keeps stopping. Press Check again to retry, or restart Ember." });
        void this.halt(false);
        return;
      }
      this.crashes = [...recent, Date.now()];
    }
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

  /** A task's own presenter: its bubble is titled as its card is and names the task, and gives way to an answer being read. */
  private taskPresenter(id: string, goal: string): Presenter {
    const title = titleOf(goal);
    const p = new Presenter(this.o.setState, undefined, () => title, this.owner, undefined, !!this.o.provider, { task: id });
    this.taskPresenters.set(id, p);
    return p;
  }

  /** Tasks running or waiting to run. */
  private tasksAtWork(): boolean {
    return this.tasks?.list().some(t => t.status === "running" || t.status === "queued") ?? false;
  }

  /** Requests sent whose turn hasn't started yet, oldest first (a request sent during a turn waits for it to end). */
  private queued: UserRequest[] = [];
  /**
   * The request whose turn is running (or ran last): tasks it starts begin in its window, and they and the tasks
   * it changes check risky steps against its words; what describe_screen reads in it goes with them.
   */
  private turn: UserRequest | null = null;

  /**
   * Sends the user's request to the conductor. `epoch`: stopEpoch when the user asked (main takes it
   * before reading the screen); a Stop since then drops the request instead of sending it.
   */
  async ask(text: string, context?: { target: WindowTarget & { app?: string }; text: string } | null, epoch = this.stopEpoch): Promise<void> {
    if (epoch !== this.stopEpoch) return;
    // The conversation's last turn went silent and is being ended (a moment): the request waits to see whether the
    // conversation goes on, or Copilot is being reconnected (then it waits for that below).
    const ending = this.conductor?.ending;
    if (ending) {
      this.presenter.userPrompt(text);
      await ending;
      if (epoch !== this.stopEpoch) { this.presenter.reset(); return; }
    }
    // Offline when it last tried (a retry is waiting): the network may be back, so it tries now and the question waits for it.
    if (this.status.phase === "error") this.retryNow();
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
    // Its turn may start only after the one running now: it takes this context then (see conversationEvent).
    const request: UserRequest = { target: context?.target ?? null, words: text, screen: context?.text ? [context.text] : [] };
    this.queued.push(request);
    this.queued.splice(0, this.queued.length - MAX_QUEUED);
    try {
      await this.conductor.ask(text, context?.text);
    } catch (err) {
      // Never sent: no turn of its own will come.
      this.queued = this.queued.filter(r => r !== request);
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
    // Requests still waiting for their turn are dropped with it (the runtime runs none of them).
    this.queued = [];
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
    // (The start that follows sign-out replaces this connection anyway: the tasks ending here don't reconnect it.)
    this.reconnectAfterTasks = null;
    this.tasks?.cancelAll();
    this.o.hands?.confirmer.cancelAll();
    await this.tasks?.drain(2500);
    await within(this.tasks?.flushDeletes() ?? Promise.resolve(), RUNTIME_WAIT_MS);
    await this.forgetCurrent(RUNTIME_WAIT_MS);
    this.setSignedOut(true);
    // How its tasks ended belongs to this conversation too: the next one (maybe another account's) doesn't hear it.
    this.tasks?.takeReports();
    this.carried = [];
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
    // (A reconnect put off until the tasks were done: this is it, or something newer.)
    this.reconnectAfterTasks = null;
    const cutOff = this.cutOff;
    this.cutOff = null;
    // Nothing keeps acting or asking once the brain goes away (sign-out, restart, quit). Cut off by a runtime
    // that stopped (or stopped answering), tasks end as failed.
    this.tasks?.cancelAll(cutOff ?? undefined);
    this.o.hands?.confirmer.cancelAll();
    // First, while the runtime surely still runs (quitting doesn't wait long).
    if (forget) await this.forgetCurrent(2000);
    await this.tasks?.drain(2500);
    // Finished tasks' sessions are deleted now, while the client can still do it (a hung runtime isn't waited for).
    await within(this.tasks?.flushDeletes() ?? Promise.resolve(), RUNTIME_WAIT_MS);
    // A reconnect resumes the conversation: its next turn hears how these tasks ended. Quitting forgets it all.
    this.carried = forget ? [] : [...this.carried, ...(this.tasks?.takeReports().map(report) ?? [])];
    // The cards go with their manager: a failed card's Close would reach nobody after a restart.
    this.tasks?.close();
    this.tasks = null;
    this.outcomes.clear();
    // The session goes, and with it every turn of it, running or waiting.
    this.queued = [];
    this.turn = null;
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
