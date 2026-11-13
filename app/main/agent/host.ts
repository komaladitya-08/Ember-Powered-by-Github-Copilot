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
import { CopilotClient, type ProviderConfig } from "@github/copilot-sdk";
import { viewText, type ViewDoc } from "../../shared/view";
import type { TaskEntry } from "../../shared/activity";
import { Conductor, ConnectionLost, forgetSavedConversation, readAgentState, within, writeAgentState, type ConductorMemory } from "./conductor";
import { FEATURE_CONSENT_VERSION } from "../../shared/consent";
import { BubbleOwner, Presenter, lostWords, noAnswer, plainText, SIGN_IN_REFUSED, type LostWords, type NoticeBoard, type PresenterEvent, type PresenterOptions, type ServiceKind } from "./presenter";
import { localProviderLine, providerDown, type ActiveProvider, type TestResult } from "../provider";
import { keyNeeded } from "../../shared/provider";
import { chooseModels, costOf, mayUseRuntimeDefault, reasoningEffortsOf, type ModelLike, type ReasoningEffort } from "./models";
import { modelsManaged, type AdminPolicy } from "../admin";
import type { Logger } from "../logger";
import { hasConsent, type SettingsStore } from "../settings";
import type { BubbleState, EmberState } from "../../shared/overlay";
import type { ConversationContext } from "../../shared/ipc";
import { TaskManager, handedElsewhere, taskOutcome, titleOf, type KeptCard, type RetriedWords, type StopCause, type Task, type WorkerLike } from "./tasks";
import { redactingClient, type ModelRedactor } from "./redacting-client";
import { LINUX_WORKER_SYSTEM, Worker, type TaskSpec, type WorkerDeps, type WorkerSystem, type WorkerVault } from "./worker";
import type { Confirmer } from "./confirm";
import type { WindowTarget } from "../perception";
import type { Bounds } from "../perception/sidecar";
import type { PerceptionPort, SidecarPort } from "../perception/ports";
import type { DesktopUse } from "../targets/hands";
import type { TargetHands, TargetsForAgent } from "../targets/types";
import { isRiskyLabel, type Agreement, type PolicyEngine } from "../policy/policy";
import { terminalRequest } from "../policy/vocabulary";
import type { AuditLog } from "../policy/audit";
import { PLATFORM_WORDS } from "../../shared/words";
import type { TargetBinding, PromptCaps } from "../targets/types";
import type { TargetId } from "../../shared/targets";
import { whereWords } from "../commands/flow";
import { NO_CAPS } from "./persona";
import type { SignInWith } from "./github-app";
import { SessionToolsTimeoutError, type SessionExtensions } from "./session-config";
import { copilotOneShot } from "./one-shot";
import { PROJECT_SYSTEM, ProjectModelError, projectFailureText, type ProjectModelFailure } from "./project";
import { workspaceOwners } from "./project-workspaces";
import { runCommandTool } from "../commands/flow";
import { DEFAULT_TERM_SIZE } from "../commands/window";
import { afterTheStep } from "../policy/audit";
import type { CommandService } from "../commands/types";
import { createHash, randomUUID } from "node:crypto";
import type { OneShot } from "../memory/learn";
import type { MemoryWait } from "../memory/owner";
import { memoryNoteActions, type MemoryNote } from "../memory/questions";
import { runtimeClientOptions } from "./runtime-env";
import { redactGitHubTokens } from "./auth";
import { clearRuntimeTemp, runtimeTempDir, runtimeTempEnv } from "./runtime-temp";
import { LOCKED_DESCRIBE, lockedOutSystem } from "../screen-lock";
import { Reminders, whenWords, type Reminder } from "./reminders";
import type { RoutineBook } from "./routines";
import { AUTONOMY_NOT_SAVED, modeIntent, planModeIntent, type ModeIntentState } from "./autonomy-intent";
import type { ApprovalMode } from "../../shared/approvals";
import type { TaskVoiceTrust } from "./voice-answer";
import { BELOW_INTERACTIVE_HINT, approvalInputs, belowInteractiveForCard, modeInForce } from "../policy/autonomy";
import { WATCHES_NEEDED } from "../doctor";
import { CATCH_UP_MS, catchUpQuestion, catchUpReply, healthQuestion, healthReply, type Health, READ_OUT_REPLY, readOutRequest, resultsReply, resultsRequest, retryRequest, statusQuestion, statusReply, stopRequest } from "./status";
import { CONVERSATION_LIMIT, retainedConversationText, type ConversationTurn, type ConversationTurnEnd } from "../../shared/conversation";
import type { HistoryStore } from "./conversation-store";

/** The words a task was refused for are known by these (userWordsOf adds a full stop to an earlier request). */
const refusedKey = (l: string) => l.trim().replace(/\.$/, "");

/** The worker for a task its target can't take (the targets runtime said why): it ends at once with that, and no session is made. */
const refusedWorker = (_spec: TaskSpec, why: string): WorkerLike => ({
  run: async () => ({ success: false, summary: why }),
  steer: async () => false,
  dispose: async () => undefined,
  sessionId: null,
});

/** What workers need to see and act (absent when there is no desktop). */
export interface Hands {
  perception: PerceptionPort;
  sidecar: SidecarPort;
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
  /**
   * Whether this screen is locked now (screen-lock.ts lockedOutHands): a task's steps on it that aren't reads (opening
   * an app, changing a desktop setting) refuse meanwhile too (cross-review X9).
   */
  screenLocked?: () => boolean;
}

/**
 * Today's hands as a target's (§2.6), for a host built without a targets runtime (tests, the eval): this computer's
 * screen, no commands, grants by the app's name in lower case and window leases by the window's own key. Hands that say
 * the screen is locked refuse its app openings and setting changes meanwhile (cross-review X9).
 */
export function localTargetHands(hands: Hands, sys: WorkerSystem): TargetHands {
  return {
    ...hands, system: hands.screenLocked ? lockedOutSystem(sys, hands.screenLocked) : sys, commands: null, grantKey: app => app.toLowerCase(), leaseKey: key => key,
    binding: { id: "local", kind: "local", label: "This computer", screenOs: sys.os, shellOs: sys.os, desktop: "screen" },
  };
}

export type AgentPhase = "signed-out" | "starting" | "ready" | "error";

/**
 * Why Ember can't use Copilot (phase "error"): the network or GitHub out of reach, the sign-in refused, no Copilot for
 * this account (no seat, or an organisation's policy), no model it may use, the runtime itself, or Copilot not
 * answering, or the administrator's policy locking Ember down (`policy`: nothing connects). What the user reads (the
 * bubble's title, the handle) says that, not always "can't reach".
 */
export type AgentReason = "network" | "sign-in" | "no-access" | "models" | "runtime" | "not-answering" | "policy" | "other";

export interface AgentStatus {
  phase: AgentPhase;
  detail: string;
  /** Why, in the error phase. */
  reason?: AgentReason;
  /** Copilot listed no models (Copilot Free) and nothing limits them: sessions use the runtime's default model. */
  defaultModel?: boolean;
  login?: string;
  /** Where the sign-in came from: Ember's own, the environment, or the GitHub CLI. */
  source?: string;
  /** How this build signs in (HostOptions.signInWith): the settings window labels its button by it. */
  signInWith?: SignInWith;
  /** `cost`: the premium-request multiplier, when Copilot gives one (the settings window marks the costly ones). */
  models: { id: string; name: string; vision: boolean; cost?: number; reasoningEfforts?: ReasoningEffort[] }[];
  conductorModel: string | null;
  workerModel: string | null;
  usage: { calls: number; inputTokens: number; outputTokens: number };
  conversationContext?: ConversationContext;
  /** Copilot stopped answering, and Ember reconnects once the tasks that are running finish (reconnecting now would stop them). */
  waitingForTasks?: boolean;
  /**
   * The model service in force changed while a turn or a task was under way: this connection still serves them, and Ember
   * switches to the new service as soon as they are done (switchWhenQuiet). Absent otherwise (first-run-v4-1).
   */
  switchPending?: boolean;
  /**
   * The model service this connection uses when it isn't GitHub Copilot: the organisation's ("admin"), the user's own
   * ("user") or a development test server ("test"), by its host only (never the key). `listed`, ready with the user's
   * own provider on this computer: whether the start's check of it answered with a model list (only then does the
   * detail say "Connected to"), so first run says what Models & connections says (integrations-r8-1, -x8-2). Absent
   * for a host elsewhere, which isn't asked at a start.
   */
  service?: { kind: ActiveProvider["kind"]; host: string; listed?: boolean };
}

/** One line of the conversation, kept in memory for this session only (the settings window shows them). */
/**
 * `learned`: an "Ember learned: …" line (main adds them beside the host's own lines; never in the host's transcript,
 * which userWordsOf reads), with the fact's id for its Undo. `heardId`: a request Ember heard, as voice personalisation
 * knows it (app/main/personal/service.ts heard()).
 */
/**
 * (`stopped`: an answer that stopped short, kept with the words it had. Home shows it with a note; it is never "the last
 * answer" to read aloud, never a question Ember asked, and nothing sends the transcript to a model. `answerId`: the
 * AnswerStream id of an answer that streamed, on the entry that holds it (finished or stopped), so Home settles that
 * answer's row by identity, never by position or words. Display plumbing only: never sent to a model or spoken.)
 */
/**
 * Ember's answer as it develops, for Home's conversation (the bubble shows the same words). `id` names one answer (it
 * only grows, so a late word of an older one is told apart); `text` is all of it so far, as plain text. `done`: the
 * answer is complete (the transcript has it); `interrupted`: it stopped short (Stop, a problem, a lost connection), and
 * the transcript then holds its words as an `ember` entry marked `stopped`.
 */
export interface AnswerStream { id: number; text: string; state: "streaming" | "done" | "interrupted" }
/** `forgot`: a "learned" line that says what Ember forgot when asked (memory-v2), with the token its Undo takes. */
export interface TranscriptEntry {
  t: string; who: "you" | "ember" | "task" | "problem" | "learned"; text: string; truncated?: boolean; fact?: string; heardId?: number; stopped?: true; answerId?: number; forgot?: string;
  /**
   * A "learned" line that says Ember forgot the fact (`forgot`, its Undo's token): how many of Ember's notes went with
   * it, and what holds again (memory-12); `again`: its Undo put it back (memory-c1-3). The line stays where it was.
   */
  derived?: number; back?: string[]; again?: true;
  /** Brought back from before Ember restarted (keepConversation): for reading only, which Home marks (home-8). Never saved. */
  restored?: true;
}

/** How long to wait before each further try at a reconnect's account lookup (ms). */
const ACCOUNT_RETRY_MS: readonly number[] = [1000, 3000];

export interface HostOptions {
  /**
   * The saved copy of the conversation (conversation-store.ts), used only while `enabled()` (settings `keepConversation`).
   * Restored lines are for the person to read: inert, never model context.
   */
  history?: { store: HistoryStore; enabled(): boolean };
  /** Instead of ACCOUNT_RETRY_MS (tests). */
  accountRetryMs?: readonly number[];
  userData: string;
  /**
   * Long-term memory (app/main/memory/service.ts): the conductor gets it while the user has it on (settings `memory`,
   * with its consent) and the administrator allows it. Signing out, or another account signing in, erases it.
   * Learning on its own (app/main/memory/learning.ts), while the conductor has it: `useModel` gets one-shot sessions
   * with no tools on this connection, `taskDone` each finished task's result, and `intent` a request first ("get to
   * know me" and its answers, the answer to Ember's own question, "forget that"): the reply to say, or null.
   */
  memory?: ConductorMemory & {
    /** Erases what memory keeps; true when it did (memory never verified as this account's stays: memory-11). */
    forgetAll(): void | boolean;
    resolveAccountId?(token: string, login: string): Promise<number | null>;
    /** `why`: what keeps the account unknown when `id` is null (memory-2: Home says it, rather than "verify its owner"). */
    verifyAccount?(id: number | null, why?: MemoryWait): void;
    pauseAccount?(why?: MemoryWait): void;
    accountReady?(): boolean;
    useModel?(model: OneShot | null): void;
    /**
     * A task finished with this result. `asked`: the mark (`asked`) of the request that started it, so a result from a
     * task asked before a Forget is never learned from, however long it ran (memory-x8-4); absent when it can't be told.
     */
    taskDone?(title: string, result: string, asked?: number): void;
    intent?(text: string, how: { own: boolean }): string | null;
    /**
     * "Remember…" while memory isn't in force: what Ember says after the conversation's answer, since the conversation
     * keeps it only until Ember closes (memory-c1-1); after "forget…" with another request in it, that memory can't
     * change what's saved. Null for anything else.
     */
    rememberNote?(text: string): MemoryNote | null;
    /**
     * The conversation ended (New conversation, sign-out, another account, another model service): what the user had
     * Ember forget in it is no longer held back from the next, which holds none of it (memory-r9-1).
     */
    conversationEnded?(): void;
  };
  /** A reminder the user set is due: main says it aloud (when replies are spoken) and notifies if the user is away. */
  onReminder?: (r: Reminder) => void;
  /** Live reminder list for Home, including transient reminders while lasting routines are off. */
  onRemindersChanged?: (rows: Reminder[]) => void;
  /** Routines and lasting reminders (routines.ts): used only while the user has them on, agreed and allowed. */
  routines?: RoutineBook;
  /**
   * Extensions (app/main/extensions/service.ts): the conductor's session gets the tools the user agreed to, each call
   * decided by Ember's gate. When `generation` moves (an install, a change, a stop), Copilot is reconnected between
   * turns, the conversation resumed as it was.
   */
  extensions?: { forSession(): SessionExtensions | undefined; readonly generation: number; conversationEnded?(): void };
  /** The voice's side of a systems check ("Ember, systems check"): the microphone and whether replies are spoken. */
  health?: () => Pick<Health, "mic" | "speaks">;
  /**
   * Says `text` (Ember's last answer) aloud now, for "read it out" (voice-speaking-r6-1). False where Ember isn't
   * speaking replies (speaking off, the organisation): nothing is said. "no-voice" where no voice here can say it
   * (voice-speaking-r9-3): nothing is said either, and the conversation says so. Absent: never said.
   */
  readOut?: (text: string) => boolean | "no-voice";
  /**
   * Which tasks the owner asked for in a verified voice (voice-answer.ts TaskVoiceTrust): a task started in a turn whose
   * request Voice Match verified is granted it, and a task changed by a request it didn't verify loses it. Absent: none.
   */
  voiceTrust?: Pick<TaskVoiceTrust, "grant" | "end">;
  /**
   * The approval mode by voice or typed words (autonomy-intent.ts: a mode named, "work without asking", "ask me first
   * again"): how the modes stand (main builds it from the settings, with Voice Match's switch), choosing a mode or
   * withdrawing every card's agreement ("asking"), and opening Home's choice at a mode's row or its card. Absent: the
   * words go to the conversation like any others.
   */
  autonomy?: {
    state(): ModeIntentState;
    /**
     * `how`: spoken (and whether Voice Match verified it) or typed, for the audit entry. False when it couldn't be made
     * so (its audit entry couldn't be written, so a mode that asks less was undone).
     */
    set(to: ApprovalMode | "asking", how: { via: "voice" | "typed"; verified: boolean }): boolean;
    open(mode: ApprovalMode, card: boolean): void;
  };
  /**
   * Tasks that do the work show it on their cards in the corner, and the bubble beside the cursor only while they use
   * the user's mouse and keyboard (docs/DESIGN.md "Two bodies"). Main turns it on; without it (older tests) every task's
   * work and result also come to the bubble, as before.
   */
  cornerTasks?: boolean;
  runtimePath: string;
  settings: SettingsStore;
  log: Logger;
  setState: (patch: Partial<EmberState>) => void;
  /** A task's view for its card (null: the card went), carried apart from the state (the overlay's ViewHub). */
  showView?: (taskId: string, view: ViewDoc | null) => void;
  /** How many times its usual time each bubble stays (the user's "More time to read and answer"; default 1). */
  readTime?: () => number;
  onStatus: (s: AgentStatus) => void;
  /** Text description of the user's screen, for the conductor's describe_screen tool. */
  describeScreen?: () => Promise<string>;
  /**
   * Whether this computer's screen is locked now: describe_screen then doesn't read it (describeScreen isn't called) and
   * answers LOCKED_DESCRIBE, a refusal the turn's tasks don't carry as screen text (cross-review X9).
   */
  screenLocked?: () => boolean;
  hands?: Hands;
  onAnswer?: (text: string) => void;
  /** The words of Ember's message as they stream, and the end of a message that wasn't the final answer (see Conductor). */
  onAnswerDelta?: (delta: string) => void;
  onAnswerEnd?: (text: string) => void;
  onTurnEnd?: (aborted: boolean) => void;
  /** The matched request whose reply is starting, including queued and locally answered requests. */
  onTurnStart?: (turn: { text: string; spoken: boolean; manual?: true }) => void;
  /** The current answer was interrupted: buffered audio and delayed acknowledgements must go too. */
  onAnswerInterrupted?: () => void;
  /** The answer being written, for Home's conversation (see AnswerStream). */
  onAnswerStream?: (e: AnswerStream) => void;
  /**
   * Whether the conversation is answering a request now changed (AgentHost.conversationTurn), for Home (home-c1-1).
   * `ended`, with "idle": a Stop ended the turn (home-c2-2). An "idle" comes after the lines its turn left (home-r2-1).
   */
  onConversationTurn?: (turn: ConversationTurn, ended?: ConversationTurnEnd) => void;
  /** A task finished (for a notification when the user isn't looking). `text`: one line saying how it went. */
  onTaskFinished?: (task: { title: string; status: string; endedBy?: StopCause; summary: string; text: string }) => void;
  /** Main's kill switch (KillSwitch.pull with source "typed"): a typed "stop" while a task is at work (stopsNow). */
  stopEverything?: () => void;
  /** The conversation changed (the settings window shows it). */
  /** `why`: "new-conversation" when only the chat was started over (not an account's conversation forgotten). */
  onTranscript?: (entries: TranscriptEntry[], why?: "new-conversation") => void;
  /**
   * Another account signed in: the conversation of the one before (and its transcript) was deleted, so main
   * drops what it kept of it too (the ask box's history).
   */
  onAccountChanged?: () => void;
  /**
   * A model endpoint instead of GitHub Copilot: a fixed one (the organisation's own from the admin policy, or for tests
   * and offline demos an OpenAI-compatible server), or a function that says which is in force now (main's: the
   * administrator's, else the user's own provider while it is on and agreed to, app/main/provider.ts). The function is
   * asked at every connect; a change takes effect at the next reconnect (providerChanged, or the next request between
   * turns), and tasks already running finish on the endpoint they started with.
   */
  provider?: ProviderConfig | (() => ActiveProvider | null);
  /**
   * The user's own provider's connection test (main: the provider service's, the one GET of Test connection, to the
   * agreed host only, its key only there). Asked before a model server on this computer is connected to, and after a
   * turn there fails without an answer, so the status never says Connected while nothing listens (integrations-1).
   */
  probeProvider?: () => Promise<TestResult>;
  /** Admin lockdown (/etc/ember/policy.json). */
  admin?: () => AdminPolicy;
  /**
   * Why no model service may be connected now (the administrator's policy locks Ember down: admin.ts
   * modelServiceRefusal), or null: while it says why, no runtime client starts, whatever sign-in or endpoint is given.
   */
  refuseConnect?: () => string | null;
  /** The policy changed while Ember ran (admin.ts heldUntilRestart): the notice offers Restart Ember, not settings. */
  policyHeld?: () => boolean;
  /** Is the computer online? A failed start while offline is retried instead of blamed on the sign-in. */
  isOnline?: () => boolean;
  /**
   * Why there is no sign-in when that has a reason the user should hear (macOS's login keychain refused Ember's saved
   * one after an update, review #241): the signed-out status says it instead of the bare "not connected". null: no reason.
   */
  signedOutWhy?: () => string | null;
  /**
   * The host whose card the user's own provider waits for (on, allowed and with an address, not agreed to for it), or
   * null: signed out then, agreeing to it is the way on, not a GitHub sign-in (integrations-r3-1).
   */
  providerWaiting?: () => string | null;
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
  /** How often the runtime's health is checked at rest (ms); while an answer or a task is under way, every 2.5 s at most. */
  healthMs?: number;
  /**
   * The OS's keys, words, apps, settings and security vocabulary (main passes its SystemPlatform), for workers, the
   * conversation's prompt and words, and which requests name the terminal. Default: Linux's (LINUX_WORKER_SYSTEM).
   */
  system?: WorkerSystem;
  /** How long a request the runtime took may wait for its turn to begin (ms; TURN_START_MS, see TurnWatch). */
  turnStartMs?: number;
  /** How long a request waits for a connect under way, and the release of held requests for the switch's (ms; CONNECT_WAIT_MS). */
  connectWaitMs?: number;
  /** How long a turn under way may hear nothing before Ember says it's still waiting (ms; TURN_SLOW_MS). */
  turnSlowMs?: number;
  /** How long a turn under way may hear nothing before it is given up on (ms; TURN_SILENT_MS). */
  turnSilentMs?: number;
  /** Whether this user's inotify instances, or its watches ("watches"), are used up (inotifyUsedUp; tests pass their own). */
  inotifyUsedUp?: () => boolean | "watches";
  /** Where tasks act (§2): the targets runtime's view for the host (absent: this computer only, as before). */
  targets?: TargetsForAgent;
  /** The audit log and Confirmer tasks use when there are no `hands` (no window system: commands-only targets, §2.6). */
  taskBase?: { audit: AuditLog; confirmer: Confirmer };
  taskWindow?: (task: Task, focus: boolean) => boolean;
  /** The user isn't looking (idle, or Ember hidden): a card kept to be read waits for them (TaskManagerDeps.userAway). */
  userAway?: () => boolean;
  /** Ember's own pids now (app.getAppMetrics() and its helpers'), for commands on this computer (D4.5, live). */
  emberPids?: () => number[];
  /** A task announced a command the user asked for (D4.4): main speaks it when replies are spoken. */
  onAnnounce?: (text: string) => void;
  /**
   * How this build signs in (github-app.ts): with Ember's own GitHub App (default, "Sign in with GitHub"), or, while it
   * has none, through the GitHub CLI: the signed-out line then says so, and the status tells the settings window.
   */
  signInWith?: SignInWith;
  /**
   * How a spoken announcement says to cancel it (main's cancelWords: the kill phrase only where Ember can tell its own
   * voice from the user's, review #251). Default: the stop shortcut, as said aloud.
   */
  cancelWords?: () => string;
  /**
   * The settings shortcut as Ember holds it now (main: hasKey), or null while another app holds it: the bubbles name it
   * only then (Read all's route, the errors that send the user to settings, a task's "No model is available" result;
   * cross-review X5). Default: the OS's table.
   */
  settingsKey?: () => string | null;
  /** The stop chord as Ember holds it now, or null: an announcement names it only then (cross-review X0). As settingsKey. */
  stopKey?: () => string | null;
  /**
   * The vault, for tasks on this computer's own screen (fill_from_vault; owner decision of 2026-11-12). Never handed to
   * a task in WSL or on a computer reached over SSH. Absent: no task has the tool.
   */
  vault?: WorkerVault;
  /**
   * The vault's redactor (app/main/vault/redact.ts): the runtime client is wrapped in it (redactingClient), so no
   * prompt, system message or tool result of any session holds a value the vault filled. Absent: nothing is filled.
   */
  redact?: ModelRedactor;
  /**
   * How much the bubble's type is scaled now (the user's text size: page-prefs' textScale): an answer that needs more
   * than the bubble's six lines at that size offers Read all (cross-review X2). Default 1.
   */
  textScale?: () => number;
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

/** A URL's host with its port, as Ember names a model service ("models.example.com", "127.0.0.1:11434"). */
function serviceHost(url: string): string {
  try { return new URL(url).host || "?"; } catch { return "?"; }
}

/** The host name of a URL, as NO_PROXY lists it (null if it isn't one). */
function hostOf(url: string): string | null {
  try { return new URL(url).hostname.replace(/^\[|\]$/g, "") || null; } catch { return null; }
}

/**
 * A command runner's status line ("Starting Ubuntu…": WA's WSL runner while a stopped distro boots, `status()` and
 * `onStatus()`) given to `show` while it says something; nothing for a runner without one. Returns the unsubscribe.
 */
function followStatus(runner: unknown, show: (text: string) => void): () => void {
  const r = runner as { status?: () => string | null; onStatus?: (fn: (text: string | null) => void) => () => void } | null | undefined;
  if (!r || typeof r.onStatus !== "function") return () => undefined;
  const say = (text: string | null) => {
    if (typeof text !== "string" || !text.trim()) return;
    try { show(text.slice(0, 200)); } catch { /* a status is only a note */ }
  };
  try {
    const off = r.onStatus(say);
    say(typeof r.status === "function" ? r.status() : null);
    return () => { try { off(); } catch { /* already gone */ } };
  } catch {
    return () => undefined;
  }
}

/** show_me where Ember can't see this screen (no window system): today's words for a session without a desktop. */
const NO_GUIDE = "Ember can't point at things in this session (no desktop access). Explain the steps in words instead.";

/** What a task cut off by a runtime that stopped says (it didn't finish, and the user didn't stop it). */
/** What a task stopped because the organisation's policy changed says, in place of "Stopped." (tasks-approvals-r9-5). */
export const POLICY_CHANGED_STOP = "Your organisation changed my policy, so I stopped this.";
/** What a task this computer's screen lock stopped says (tasks-approvals-r9-5). */
export const SCREEN_LOCKED_STOP = "The screen locked, so I stopped this.";
export const CUT_OFF = "Copilot stopped unexpectedly; the task didn't finish.";
/** The same when the runtime was reconnected because it stopped answering the conversation (it didn't stop). */
export const CUT_OFF_STALLED = "Copilot didn't answer; the task didn't finish.";

const NETWORK = /ECONNREFUSED|ECONNRESET|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|getaddrinfo|network is unreachable|fetch failed|socket hang up|net::ERR_(INTERNET_DISCONNECTED|NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|CONNECTION_\w+|ADDRESS_UNREACHABLE|NETWORK_\w+|TIMED_OUT|PROXY_\w+|TUNNEL_CONNECTION_FAILED|EMPTY_RESPONSE)/i;
const SIGNED_OUT = "Not connected to Copilot: sign in with GitHub below.";
/** The same without Ember's own GitHub App: the sign-in is the GitHub CLI's (S1). */
const SIGNED_OUT_CLI = "Not connected to Copilot. Signing in needs a GitHub account with Copilot and the GitHub CLI: see below.";
/** A hung runtime is given this long to answer a health check, a stop or a delete. */
const RUNTIME_WAIT_MS = 5000;
/**
 * How often the runtime is checked while an answer or a task is under way (rp-2). The SDK drops a session's handlers
 * when its runtime exits and says nothing to the turn, so only a ping hears it: at the 20 s rest cadence, an answer
 * stood frozen for 16-19 s (measured). A local JSON-RPC ping is cheap.
 */
const BUSY_HEALTH_MS = 2500;
/** The conversation's request was taken but its turn never began (TurnWatch). */
const NOT_ANSWERING = "Copilot isn't answering. I'm reconnecting; ask me again in a moment.";
/** The same while tasks are at work: Copilot is reconnected once they're done. */
const NOT_ANSWERING_AFTER_TASKS = "Copilot isn't answering. I'll reconnect when the tasks that are running finish; ask me again then.";
/**
 * Signed out, and it couldn't be saved (the saved sign-in is still on disk, or the signed-out note couldn't be
 * written): what Models & connections says in place of "sign in below" (reliability-r9-2).
 */
export const SIGN_OUT_NOT_KEPT = "You're signed out for now, but Ember couldn't save that: its data folder can't be written. Until it can, Ember may sign in again by itself the next time it starts.";
/** The same, with this user's inotify instances used up (the runtime can't begin a turn then). */
const NO_WATCHERS = "Copilot can't work right now: this computer has run out of file watchers. Close a few apps, then ask me again.";
const NO_WATCHERS_WHY = "Copilot isn't answering: the system's limit on file watchers (fs.inotify.max_user_instances) is used up. Close some apps, or ask IT to raise the limit.";
/**
 * The conversation's turn began and then heard nothing from Copilot for minutes (TurnWatch), and ending it didn't
 * end it: Copilot is reconnected (the conductor said NO_ANSWER).
 */
const NO_ANSWER_DETAIL = "Copilot didn't answer in time. Reconnecting…";
/** A reconnect put off while tasks are at work (the runtime still works for them): what settings show meanwhile. */
const AFTER_TASKS = "Reconnecting when the tasks that are running finish…";

/**
 * What a model service that isn't answering is called as Ember reconnects, for the service in use (integrations-v1):
 * Copilot's words are NOT_ANSWERING and its kin above; the user's own provider and the organisation's are named as such.
 */
export function reconnectWords(service: ServiceKind) {
  if (service === false) return { notAnswering: NOT_ANSWERING, notAnsweringAfterTasks: NOT_ANSWERING_AFTER_TASKS, notAnsweringDetail: "Copilot isn't answering. Reconnecting…", noAnswerDetail: NO_ANSWER_DETAIL, notAnsweringNow: "Copilot isn't answering." };
  const who = service === "user" ? "Your model provider" : "The model service";
  return {
    notAnswering: `${who} isn't answering. I'm reconnecting; ask me again in a moment.`,
    notAnsweringAfterTasks: `${who} isn't answering. I'll reconnect when the tasks that are running finish; ask me again then.`,
    notAnsweringDetail: `${who} isn't answering. Reconnecting…`,
    noAnswerDetail: `${who} didn't answer in time. Reconnecting…`,
    notAnsweringNow: `${who} isn't answering.`,
  };
}

/**
 * What Ember's Copilot runtime stopping or running out of file watchers is called, for the service in use
 * (integrations-v1): Copilot's words above, and under the user's own provider or the organisation's service "Ember's
 * model connection" (noticeTitle's "My model connection" in the bubble), never Copilot, which the person isn't using.
 * `cutOff`: a task cut off by it, said only as the task's outcome in Ember's own voice (the bubble, the conversation's
 * task row), so as mine: "My model connection" (first-run-w5-1). `cutOffStalled`: a task cut off because the model
 * service didn't answer.
 */
export function runtimeWords(service: ServiceKind) {
  if (service === false) {
    return { stopped: "Copilot stopped unexpectedly. Reconnecting…", keepsStopping: "Copilot keeps stopping. Press Check again to retry, or restart Ember.", cutOff: CUT_OFF, cutOffStalled: CUT_OFF_STALLED, noWatchers: NO_WATCHERS, noWatchersWhy: NO_WATCHERS_WHY };
  }
  return {
    stopped: "Ember's model connection stopped unexpectedly. Reconnecting…",
    keepsStopping: "Ember's model connection keeps stopping. Press Check again to retry, or restart Ember.",
    cutOff: "My model connection stopped unexpectedly; the task didn't finish.",
    cutOffStalled: `${service === "user" ? "Your model provider" : "The model service"} didn't answer; the task didn't finish.`,
    noWatchers: "I can't work right now: this computer has run out of file watchers. Close a few apps, then ask me again.",
    noWatchersWhy: "Ember's model connection isn't answering: the system's limit on file watchers (fs.inotify.max_user_instances) is used up. Close some apps, or ask IT to raise the limit.",
  };
}

/** The inotify use of one user: instances, and the files and folders they watch where those can be counted. */
export interface InotifyUse { used: number; max: number; watches?: { used: number; max: number } }

/**
 * This user's inotify instances in use and the limit (fs.inotify.max_user_instances: 128 on RHEL 8, and every app
 * takes some; Ember's Copilot runtime takes one per conversation or task), or null when they can't be counted.
 * Counted in `proc`: the instances held by processes of `uid`. `watches`: the files and folders those instances watch
 * (each "inotify wd:" line of an instance's fdinfo) against fs.inotify.max_user_watches (8,192 on RHEL 8, which an
 * editor, a sync client or the desktop's file indexer can use up) or the user namespace's own lower limit
 * (user.max_inotify_watches); left out where there is no limit to read. With the watches used up the runtime took a
 * request and never began it, as with the instances, while the count of instances said all was well (reliability-r9-1).
 */
export function inotifyUse(proc = "/proc", uid = process.getuid?.()): InotifyUse | null {
  try {
    const max = Number(fs.readFileSync(path.join(proc, "sys/fs/inotify/max_user_instances"), "utf8"));
    if (!(max > 0)) return null;
    let n = 0, watched = 0;
    for (const pid of fs.readdirSync(proc)) {
      if (!/^\d+$/.test(pid)) continue;
      const dir = path.join(proc, pid, "fd");
      try {
        if (uid !== undefined && fs.statSync(path.join(proc, pid)).uid !== uid) continue;
        for (const fd of fs.readdirSync(dir)) {
          try {
            if (fs.readlinkSync(path.join(dir, fd)) !== "anon_inode:inotify") continue;
            n++;
            watched += (fs.readFileSync(path.join(proc, pid, "fdinfo", fd), "utf8").match(/^inotify wd:/gm) ?? []).length;
          } catch { /* closed meanwhile */ }
        }
      } catch { /* gone, or another user's */ }
    }
    const limits = ["sys/fs/inotify/max_user_watches", "sys/user/max_inotify_watches"].flatMap(file => {
      try { const v = Number(fs.readFileSync(path.join(proc, file), "utf8")); return Number.isFinite(v) && v >= 0 ? [v] : []; } catch { return []; /* no such limit here */ }
    });
    return { used: n, max, ...(limits.length ? { watches: { used: watched, max: Math.min(...limits) } } : {}) };
  } catch {
    return null;
  }
}

/**
 * Whether they are all in use: the Copilot runtime then takes requests but never begins them. "watches" when it is the
 * watched files and folders that are used up (fewer than WATCHES_NEEDED free), not the instances.
 */
export function inotifyUsedUp(proc = "/proc", uid = process.getuid?.()): boolean | "watches" {
  const u = inotifyUse(proc, uid);
  if (!u) return false;
  if (u.used >= u.max) return true;
  return u.watches && u.watches.max - u.watches.used < WATCHES_NEEDED ? "watches" : false;
}

/** runtimeWords' noWatchersWhy, for the watched files and folders: the limit an administrator raises is another one. */
const watchesWhy = (why: string) => why.replace("file watchers (fs.inotify.max_user_instances)", "watched files and folders (fs.inotify.max_user_watches)");

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
/** A promise and the call that settles it: a Stop's word to a request that waits (AgentHost.stopSignal). */
function signal(): { promise: Promise<void>; fire: () => void } {
  let fire = () => undefined as void;
  const promise = new Promise<void>(resolve => { fire = resolve; });
  return { promise, fire };
}

const SOURCE_TEXT: Record<string, string> = { stored: "Ember's saved sign-in", environment: "a token from the environment", "github-cli": "the GitHub CLI sign-in" };

/** The system proxy Ember gave the runtime (or couldn't), for a sign-in error that may really be the proxy's. */
function proxyNote(p?: { url: string | null; socks?: string }): string {
  if (p?.socks) return ` Your system proxy (${p.socks}) is a SOCKS proxy, which Ember's Copilot runtime can't use: ask IT for an HTTP proxy and set HTTPS_PROXY for Ember.`;
  if (p?.url) return ` Ember sent Copilot through your system proxy (${p.url}); if that proxy needs its own sign-in, set HTTPS_PROXY for Ember with it.`;
  return "";
}

/**
 * A problem on Copilot's or GitHub's side that passes (review #137): a 5xx, a rate limit, a request or the runtime's
 * own start that timed out ("Timeout waiting for CLI server to start", SessionToolsTimeoutError). A start that fails
 * with one is retried with the offline backoff, and asking retries at once, as offline.
 */
const TRANSIENT = /\b50[0234]\b|bad gateway|service unavailable|gateway time-?out|internal server error|overloaded|\b429\b|too many requests|rate.?limit|timed? ?out|timeout/i;
/** One of those: a TRANSIENT message, or the conversation's tools not reported in time (its message says neither). */
const transient = (err: unknown, msg: string) => err instanceof SessionToolsTimeoutError || TRANSIENT.test(msg);
/** What settings show for one, while the retry waits. */
const TRANSIENT_DETAIL = "Copilot had a problem on its side while Ember connected. Ember will try again in a moment.";

/**
 * How long each step of a start may wait for the runtime (reliability-performance-v1): a runtime that stalls in its
 * handshake, or a model list on a black-holed network, left Home at "Connecting…" for good, with nothing logged or
 * retried. A normal start takes a second or two.
 */
const START_STEP_MS = { start: 30_000, auth: 20_000, models: 20_000, conversation: 30_000 } as const;
/** A start step the runtime never answered: its message is TRANSIENT, so the start is retried as one. */
class StartTimeout extends Error {
  constructor(readonly step: keyof typeof START_STEP_MS) { super(`Copilot didn't answer in time (${step}): timed out`); }
}
/** What settings show while a start that timed out waits to try again. */
export const START_TIMEOUT_DETAIL = "Copilot isn't answering. Ember will try again in a moment.";
/** `p`, or a StartTimeout for `step` once its time is up. */
async function startStep<T>(p: Promise<T>, step: keyof typeof START_STEP_MS): Promise<T> {
  const r = await within(p, START_STEP_MS[step]);
  if (r === "timeout") throw new StartTimeout(step);
  return r;
}

/** A start's error that names no model Ember may use (thrown by doStart itself): shown as it is. */
const NO_MODEL = /^(None of the models|Copilot lists no models|Enter the model)/;

/** The user's own provider is on with no model named (Home › Copilot's Model fields). */
export const USER_PROVIDER_NO_MODEL = "Enter the model your provider should use in Ember's settings, under Models & connections.";
/** Every model the user named for their own provider is outside the administrator's allowed list. */
export const USER_PROVIDER_NOT_ALLOWED = "None of the models you entered for your provider are allowed by your administrator.";
/** A request held because the model service changed while a turn or a task was under way (it never goes to the one before). */
export const PROVIDER_SWITCH_TITLE = "Switching model service";
export const PROVIDER_SWITCH_WAIT = "You changed the model service, so I'll send this there once what I'm doing now has finished. It won't go to the one before.";
/** A task that would have started on the model service the user switched away from. */
/** How often held requests look again for a quiet moment to go (a turn's end comes a moment after its answer). */
const HELD_RECHECK_MS = 250;
/**
 * How long a request waits for Copilot to finish connecting before it is told Ember is still connecting: also how long
 * the release of held requests waits on the switch's connect before sending them on (a connect that hangs never holds
 * requests for ever).
 */
const CONNECT_WAIT_MS = 15_000;
export const PROVIDER_MOVED_TASK = "The model service changed before this task could start. Ask me again and I'll use the new one.";

/** Nothing answers at the user's own provider (providerDown's sentence): the start stops there, and is tried again. */
class ProviderDown extends Error {}

/** What a connection's endpoint is, to tell a change: its kind, config (key included: kept in memory only), models and the key's id (a re-saved key is another owner of the saved conversation). */
function providerKey(p: ActiveProvider | null): string {
  return p ? JSON.stringify([p.kind, p.config, p.models ?? null, p.keyId ?? null]) : "";
}

/** Which credentials a connection uses, for telling a change (kind, address, key): held in memory, never stored or logged. */
function providerCredentials(p: ActiveProvider | null): string {
  return p ? JSON.stringify([p.kind, p.config.baseUrl, p.config.apiKey ?? null, p.keyId ?? null]) : "";
}

/** The model service a conversation is held with: "copilot", or a provider's kind and address. */
function serviceOf(p: ActiveProvider | null): string {
  return p ? `${p.kind} ${p.config.baseUrl}` : "copilot";
}

/** Why memory waits while `p` is in force (integrations-r5): a model provider's, never a GitHub account check. */
function memoryWaitFor(p: ActiveProvider | null, otherwise: MemoryWait): MemoryWait {
  return !p ? otherwise : p.kind === "user" ? "own-provider" : "org-provider";
}

/** The words an error uses for `p` (ServiceKind). */
function kindOf(p: ActiveProvider | null): ServiceKind {
  return p ? (p.kind === "user" ? "user" : true) : false;
}

/**
 * The runtime can't start: starting it failed ("spawn … ENOENT"), the SDK didn't find it, or a file error names the
 * runtime's own path (`runtime`). Any other file error is about a file of Ember's (fileTrouble).
 */
function runtimeMissing(msg: string, runtime?: string): boolean {
  return /not found at|spawn /i.test(msg) || (!!runtime && /\b(ENOENT|EACCES|EPERM)\b/.test(msg) && msg.includes(runtime));
}

/** A file Ember needs couldn't be used (not the runtime's): why, in a sentence naming the file; null for other errors. */
function fileTrouble(msg: string): string | null {
  const code = /\b(ENOENT|EACCES|EPERM|EBUSY|ENOSPC|EDQUOT|EROFS)\b/.exec(msg)?.[1];
  if (!code) return null;
  const file = /'([^']+)'/.exec(msg)?.[1];
  const it = file ?? "one of its files";
  switch (code) {
    case "ENOSPC": case "EDQUOT": return `Ember couldn't save ${it}: the disk (or your storage quota) is full. Free some space, then press Check again.`;
    case "EROFS": return `Ember couldn't save ${it}: the disk is read-only. Ask IT to check Ember's data folder, then press Check again.`;
    case "EACCES": case "EPERM": return `Ember isn't allowed to use ${it}. Check that its folder belongs to you, then press Check again.`;
    case "EBUSY": return `${file ?? "One of Ember's files"} is in use by another program. Close it, then press Check again.`;
    default: return `Ember couldn't find ${it}. Press Check again; if it keeps happening, restart Ember.`;
  }
}

/** Why a start failed, in the order explainStartError judges it. `runtime`: the runtime's path (a file error naming it is its). */
export function startErrorReason(err: unknown, ctx: { online?: boolean; runtime?: string } = {}): AgentReason {
  const msg = err instanceof Error ? err.message : String(err);
  if (runtimeMissing(msg, ctx.runtime)) return "runtime";
  if (fileTrouble(msg)) return "other";
  if (NO_MODEL.test(msg)) return "models";
  if (ctx.online === false || NETWORK.test(msg) || /certificate|self.signed|issuer|ERR_CERT_/i.test(msg)) return "network";
  if (/client not connected|connection (is |got |was )?disposed|connection (closed|lost)|pending response rejected/i.test(msg)) return "runtime";
  if (/copilot (cli )?policy|disabled by (your )?organi[sz]ation|organi[sz]ation polic|\bseat\b|subscription|no copilot access|\b(status|HTTP|code)\s*40[23]\b/i.test(msg)) return "no-access";
  if (/not authenticated|unauthori[sz]ed|bad credentials|\b(status|HTTP|code)\s*401\b/i.test(msg)) return "sign-in";
  if (transient(err, msg)) return "not-answering";
  return "other";
}

/** The bubble's title when Ember can't take a request, by why (the status' detail says the rest). */
/** What the kill switch's bubble says, and the conversation after a typed "stop" stopped everything (home-c1-1). */
export const STOPPED_EVERYTHING = "Okay, I've stopped everything.";
/** What the conversation says after another GitHub account signed in and Ember erased the previous one's memory (memory-11). */
export const ACCOUNT_CHANGED_FORGOT = "You're signed in to another GitHub account now, so I've forgotten the previous account's memory, reminders and routines.";

/** The bubble's title for a request with no GitHub sign-in while the user's own provider waits for its card (integrations-r3-1). */
export const PROVIDER_WAITING_TITLE = "Your provider needs your OK";
/** And what to do, by the host the card names ("in settings": Home names its section, problemInHome). */
export const providerWaitingWhy = (host: string) => `Agree to use ${host} in settings, or turn off “Use my own model provider”, then ask me again.`;

export const NOTICE_TITLE: Record<AgentReason | "signed-out", string> = {
  "signed-out": "I need Copilot first",
  "sign-in": "Copilot didn't accept the sign-in",
  network: "I can't reach Copilot",
  "no-access": "Copilot isn't available to this account",
  models: "No Copilot model I can use",
  runtime: "Copilot isn't running",
  "not-answering": "Copilot isn't answering",
  policy: "Your organisation's policy stops me",
  other: "Copilot isn't working right now",
};

/**
 * The bubble's title when Ember can't take a request, for the model service the connection uses (`service`, the
 * status' kind): NOTICE_TITLE for Copilot, and words that name the user's own provider or the organisation's service
 * otherwise, never Copilot (integrations-3).
 */
export function noticeTitle(reason: AgentReason | "signed-out", service?: ActiveProvider["kind"]): string {
  if (!service || reason === "signed-out" || reason === "policy") return NOTICE_TITLE[reason];
  const it = service === "user" ? "your model provider" : "the model service";
  const It = it[0].toUpperCase() + it.slice(1);
  switch (reason) {
    case "sign-in": case "no-access": return `${It} refused the connection`;
    case "network": return `I can't reach ${it}`;
    case "models": return service === "user" ? "No model set for your provider" : "No model I can use";
    case "runtime": return "My model connection isn't running";
    case "not-answering": return `${It} isn't answering`;
    default: return `${It} isn't working right now`;
  }
}

/** Who Ember is still connecting to, in the bubble's title. */
export function stillConnectingTitle(service?: ActiveProvider["kind"]): string {
  return `I'm still connecting to ${service === "user" ? "your model provider" : service ? "the model service" : "Copilot"}`;
}

/**
 * What Ember's handle says when nothing else is going on: a few words (the pill is narrow). The user's own provider
 * unreached is "Can't connect", not "Offline": a model server on this computer that isn't running (integrations-1).
 */
export function idleWord(s: Pick<AgentStatus, "phase" | "reason" | "waitingForTasks"> & { service?: AgentStatus["service"]; detail?: string }): string {
  if (s.phase === "ready") return "Ready";
  if (s.phase === "starting") return "Connecting…";
  if (s.phase === "signed-out") return "Not connected";
  if (s.waitingForTasks) return "Waiting for tasks";
  // Another model service in use is never called Copilot (accessibility-visual-c1-2: the Ask box said "Copilot problem").
  const kind = s.service?.kind;
  // The Copilot runtime stopped and Ember starts it again by itself (lost(): a detail ending "Reconnecting…", as
  // composerRefusal reads it); given up, or unable to start, it is the runtime's problem, never the provider's
  // (reliability-performance-c2-3: "Provider problem" sent people to check a provider that was fine).
  if (s.reason === "runtime") return s.detail?.endsWith("Reconnecting…") ? "Reconnecting…" : kind ? "Connection problem" : "Copilot problem";
  switch (s.reason) {
    case "network": return kind === "user" ? "Can't connect" : "Offline";
    case "sign-in": return kind ? "Access refused" : "Sign-in refused";
    case "no-access": return kind ? "Access refused" : "No Copilot access";
    case "models": return "No model";
    case "not-answering": return "Reconnecting…";
    case "policy": return "Locked down";
    default: return kind === "user" ? "Provider problem" : kind ? "Service problem" : "Copilot problem";
  }
}

/**
 * Why a request asked now would go unanswered, in the handle's word (idleWord), or null when Ember can answer it (ready)
 * or may still (connecting: a request waits a moment for the connection). The Ask box says it (companion-6).
 */
export function unansweredWord(s: Parameters<typeof idleWord>[0] | undefined): string | null {
  return !s || s.phase === "ready" || s.phase === "starting" ? null : idleWord(s);
}

/**
 * Why a start failed, in one plain sentence for the settings window. `reinstall`: how this OS says to install Ember
 * again (default Linux's "Reinstall Ember (sudo dnf reinstall ember).").
 */
export function explainStartError(err: unknown, ctx: { source?: string; sourceName?: string; online?: boolean; proxy?: { url: string | null; socks?: string }; reinstall?: string; runtime?: string } = {}): string {
  // A token the runtime's error quoted is never shown (BE audit #1).
  const msg = redactGitHubTokens(err instanceof Error ? err.message : String(err));
  const from = ctx.source && SOURCE_TEXT[ctx.source] ? ` (${SOURCE_TEXT[ctx.source]})` : "";
  if (runtimeMissing(msg, ctx.runtime)) return `Ember's Copilot runtime is missing or can't start. ${ctx.reinstall ?? PLATFORM_WORDS.linux.reinstall}`;
  const files = fileTrouble(msg);
  if (files) return files;
  if (NO_MODEL.test(msg)) return msg;
  if (ctx.online === false || NETWORK.test(msg)) return "Ember can't reach GitHub right now. It will try again when the network is back.";
  if (/certificate|self.signed|issuer|ERR_CERT_/i.test(msg)) return "Ember can't verify GitHub's certificate. If your organisation's network inspects secure traffic, ask IT to add its certificate for Ember.";
  if (/client not connected|connection (is |got |was )?disposed|connection (closed|lost)|pending response rejected/i.test(msg)) return "Ember's Copilot runtime stopped while connecting. Press Check again.";
  if (/copilot (cli )?policy|disabled by (your )?organi[sz]ation|organi[sz]ation polic/i.test(msg)) return "Your organisation has turned Copilot off for your account. Ask whoever manages its GitHub to turn it on (the Copilot CLI policy).";
  if (/\bseat\b|subscription|no copilot access|\b(status|HTTP|code)\s*40[23]\b/i.test(msg)) return "This GitHub account doesn't have Copilot. Add Copilot to it, or ask whoever manages your GitHub plan.";
  if (/not authenticated|unauthori[sz]ed|bad credentials|\b(status|HTTP|code)\s*401\b/i.test(msg)) {
    // A token from the environment comes before every other sign-in: only taking it out of Ember's environment (or
    // fixing it) gets past it for good. (Ember tried the other sign-ins it found before saying this: main.)
    if (ctx.source === "environment" && ctx.sourceName && /^[A-Z_]+$/.test(ctx.sourceName)) {
      return `Copilot didn't accept the GitHub token in ${ctx.sourceName} (set in Ember's environment). It may have expired, lack the Copilot permission, or belong to an account without Copilot. Replace it or remove ${ctx.sourceName}, then restart Ember; or run “gh auth login” in a terminal and press Check again.${proxyNote(ctx.proxy)}`;
    }
    return `Copilot didn't accept the GitHub sign-in Ember found${from}. It may have expired, or this account may not have Copilot. Sign in again.${proxyNote(ctx.proxy)}`;
  }
  if (err instanceof StartTimeout) return START_TIMEOUT_DETAIL;
  if (transient(err, msg)) return TRANSIENT_DETAIL;
  return msg;
}

/**
 * Why a sign-in (the device flow) failed, in one plain sentence for the settings window. Nothing retries a sign-in, so
 * unlike a start's error it never promises one; a reply that wasn't GitHub's (a proxy's error page) isn't shown raw.
 */
export function explainSignInError(err: unknown, ctx: { online?: boolean; reinstall?: string } = {}): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (/^(The sign-in code expired|Sign-in was cancelled)/.test(msg)) return msg;
  if (/refused the sign-in request \(4\d\d\)/.test(msg)) return "GitHub didn't accept Ember's sign-in request. Make sure Ember is up to date, or run “gh auth login” in a terminal and press Check again.";
  if (ctx.online === false || NETWORK.test(msg)) return "Ember can't reach GitHub right now. Check the network, then sign in again.";
  if (/refused the sign-in request \(5\d\d\)|is not valid JSON|Unexpected token|JSON/i.test(msg) || TRANSIENT.test(msg)) return "GitHub's sign-in page didn't answer properly (a proxy or a problem on GitHub's side). Try signing in again in a moment.";
  return explainStartError(err, ctx);
}

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
/** A finished task as the next turn hears it (in <task_results>): its summary, and what its card showed, as words. */
// (The model hears the plain state, "failed" or "stopped"; the user hears the card's words: tasks.ts statusWord. One
// whose question went unanswered wasn't stopped, so it isn't told so: tasks-approvals-r1.)
export const report = (t: Task) => `Task "${t.title}" ${t.status === "cancelled" ? t.endedBy === "expired" ? "ended with no answer in time" : "stopped" : t.status}: ${t.result?.summary ?? ""}${t.view ? `\n${viewText(t.view)}` : ""}`;
/**
 * Told to the conversation with what was heard in a spoken conversation (AgentHost.ask `replaces`), and not in its prompt:
 * with conversations off the prompts stay as they were. Host-written, never model or screen text.
 */
const CONVERSATION_LINE = "(Heard in an open spoken conversation, without your name. A running task goes on while you talk: answer other questions as it runs, and pass on what changes it with steer_task, not a second task. If this plainly wasn't meant for you, such as people talking to each other or a video, reply with only “…”.)";
const CUT_IN_LINE = "(The user said this before you had finished, so your last reply was stopped. It adds to or changes what they asked: answer with all of it in mind.)";

/** Requests sent while the conversation was busy, kept at most (the runtime runs them one turn at a time). */
const MAX_QUEUED = 20;
/** Finished tasks kept for "what did I miss?" after their cards go (it names three and counts the rest). */
const FINISHED_KEPT = 20;

/**
 * One request of the user's: where they were when they called Ember, what they said, and what the conversation
 * read on the screen in its turn (the context sent with it, describe_screen's answers).
 */
interface UserRequest {
  /** The exact prompt prepared for this request; unset until dispatch, never matched by user-text suffix. */
  prompt?: string;
  target: (WindowTarget & { app?: string }) | null;
  words: string;
  /** Follow-up listening belongs to this request, not whichever request arrived most recently. */
  spoken?: boolean;
  manual?: true;
  screen: string[];
  /** The target the context was read on (QuickContext.targetId; absent: this computer). */
  targetId?: TargetId;
  /** Heard where Ember can't tell the user from its speakers: never the user's own words for commands (OWNER V1). */
  voiceUnchecked?: boolean;
  /**
   * One of Ember's suggestions the user chose (app/main/personal/predict.ts): their click, but Ember's words, so never
   * the user's own words for commands either (no announce-with-Stop for a dangerous command it names); not voice.
   */
  suggested?: boolean;
  /**
   * Heard while Ember was speaking, or where Ember can't tell its own voice from the user's and had spoken since it
   * began to listen: never the user's own words for Assisted's check (PLAN.md §2 "Approvals").
   */
  overEmber?: boolean;
  /** Spoken and verified by Voice Match as the owner's, at this time (a task it starts holds voice trust from then). */
  verifiedAt?: number;
  /** "Remember…" while memory can't keep it: said behind its turn's answer (memory-c1-1). */
  memoryNote?: MemoryNote;
}
/** Words that only answer ("yes please", "both of them", "the first one", "go ahead"), besides names and numbers. */
const ANSWER_WORD = /^(yes|yeah|yep|yup|sure|ok|okay|please|go|ahead|do|it|that|this|them|those|these|both|all|of|the|a|an|first|second|third|last|one|ones|and|or|either|neither|none|no|nope|thanks|thank|you|correct|right|exactly|fine|sounds|good|great|perfect|alright|absolutely|definitely|indeed|just|only|too|also|same|again)$/i;
/** The words of what someone said ("don't" is one). */
const wordsOf = (s: string) => s.normalize("NFKC").match(/[\p{L}\p{N}]+(?:['’][\p{L}]+)?/gu) ?? [];
/**
 * A few words that name no action: only answer words, names and numbers ("Ana Lopez", "both of them", "yes please"). A
 * name is capitalised where no sentence starts, or is followed by another one ("Ana Lopez"; not "Rename it").
 */
const onlyAnswers = (s: string) => {
  const ws = wordsOf(s);
  const name = (w: string, i: number) => /^\p{Lu}/u.test(w) && (i > 0 || ws.length === 1 || /^\p{Lu}/u.test(ws[1]));
  return ws.length > 0 && ws.length <= 6 && ws.every((w, i) => ANSWER_WORD.test(w) || /^\p{N}+$/u.test(w) || name(w, i));
};
/** Does a reply of Ember's ask the user something: a sentence of it ends with "?" ("Which report? I can also attach both.")? */
const asks = (s: string) => /[?？](?=\s|$)/.test(s);
/** What a reply of Ember's asked: its paragraphs with a question ("I can delete the old installers. Shall I?"). */
const questionOf = (s: string) => s.split(/\n\s*\n/).filter(asks).join("\n\n").trim();
/** Words that say no, or not that ("not now", "something else", "later", "no thanks"): such a reply agrees to nothing. */
const NOT_AGREEING = /^(no|nope|nah|not|neither|nor|none|nothing|never|don['’]t|dont|cancel|stop|wait|later|else|other|instead|skip|hold|thanks|thank)$/i;
/** A task's result offering to try again ("Want me to try again?"): a yes to it asks for that task again (tasks-approvals-c1-3). */
const OFFERS_RETRY = /\b(?:try (?:it |that )?(?:again|once more)|another (?:go|try)|retry)\b/i;
/** A short question of the user's about what just happened ("why didn't it work?", "what went wrong"). */
const ASKS_WHAT_HAPPENED = /^(?:(?:hey|ok|okay|so|and|but)[,\s]+)?(?:ember[,\s]+)?(?:why|what|how|where|did|didn['’]t|was|wasn['’]t|is|isn['’]t)\b/i;
/**
 * Does the user's reply agree to Ember's question `asked`, or answer it ("yes", "sure, go ahead", "the forecast", "the
 * second", "April")? A few words, none saying no, each an answer word, a number or a word of the question; or a name
 * where the question asks who or which ("Ana Lopez"). Not "no", "something else", or a new request ("Open Firefox" to "Shall I?").
 */
const agrees = (reply: string, asked: string): boolean => {
  const ws = wordsOf(reply);
  if (!ws.length || ws.length > 6 || ws.some(w => NOT_AGREEING.test(w))) return false;
  const theirs = new Set(wordsOf(asked).map(w => w.toLowerCase()));
  if (ws.every(w => ANSWER_WORD.test(w) || /^\p{N}+$/u.test(w) || theirs.has(w.toLowerCase()))) return true;
  return /\b(who|whom|which|what)\b/i.test(asked) && ws.length <= 3 && ws.every(w => /^\p{Lu}/u.test(w));
};

export class AgentHost {
  private projectModel: ((system: string, prompt: string, signal: AbortSignal, onFailure?: (f: ProjectModelFailure) => void) => Promise<string | null>) | null = null;
  /** The model service project requests go to, for the words of their errors. */
  private projectService: ServiceKind = false;
  private projectRun: AbortController | null = null;
  private client: CopilotClient | null = null;
  /** The connected runtime, for the extensions' marketplaces (null until Copilot is ready). */
  get copilotClient(): CopilotClient | null {
    return this.status.phase === "ready" ? this.client : null;
  }
  conductor: Conductor | null = null;
  tasks: TaskManager | null = null;
  /**
   * Home's Task activity from the TaskManagers before this one (TaskManager.history): a reconnect hands it on, so it is
   * kept until Ember quits, as Home says; sign-out and an account change drop it (tasks-approvals-c2-1).
   */
  private earlierTasks: TaskEntry[] = [];
  /** The manager whose tasks were forgotten with the conversation (sign-out): its history isn't handed on. */
  private tasksForgotten: TaskManager | null = null;
  /**
   * The manager before a reconnect while it hands its finished cards to the next one (TaskManager.keptCards): a switch of
   * model service made once the work under way was done keeps its cards' Try again, Close and View result
   * (tasks-approvals-r4-2). It stays `tasks` until the next manager takes them, so they stay on screen and Close closes
   * them while Ember reconnects (integrations-v5-2); `service`: the one its tasks used (integrations-v5-1). Any other
   * restart takes them off for good, as before.
   */
  private handing: { tasks: TaskManager; service: string } | null = null;
  /** Tasks whose cards came from a connection on another model service: the conversation here isn't told of them (integrations-v5-1). */
  private fromElsewhere = new WeakSet<Task>();
  /** The tasks each turn asked for, steered or stopped: a task's words are its alone only in a turn that touched no other (integrations-w5-1). */
  private turnTasks = new WeakMap<UserRequest, Set<string>>();
  /** The next stop is the waiting switch's own reconnect (switchWhenQuiet, releaseHeld): its cards are kept. */
  private keepCards = false;
  private status: AgentStatus;
  /** Bumped by every start() and stop(): an older start gives up at its next step. */
  private gen = 0;
  /** Starts and stops run one after another. */
  private chain: Promise<void> = Promise.resolve();
  private token: string | null = null;
  private source: string | undefined;
  /** The environment variable the token came from (source "environment"). */
  private sourceName: string | undefined;
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
  /**
   * Settled by every Stop (stopped()): a request waiting for a connection, or for a silent turn to end, is dropped at
   * once, not when the wait runs out (home-r3-1: Home said "Thinking…" for up to CONNECT_WAIT_MS after the Stop).
   */
  private stopSignal = signal();
  /** This run's conversation: a reconnect resumes it; quitting (stop()) and signing out delete it. */
  private conversation: string | null = null;
  /** The account the conversation belongs to: signed in as another, it isn't resumed. */
  private conversationLogin: string | undefined;
  /** The GitHub account Ember last connected to Copilot with (kept across connections to another model service). */
  private githubLogin: string | undefined;
  private githubAccountId: number | null = null;
  /** The last Copilot connection looked the GitHub account up and could not establish its id (cleared when one does, or at sign-out). */
  private accountUnresolved = false;
  /** A failed account-boundary deletion must be retried before any new session in this run. */
  private memoryDeletionPending = false;
  /**
   * The model service the conversation was held with ("copilot", or a provider's kind and address): on another, it isn't
   * resumed (its history isn't sent to a service it wasn't held with); a new conversation starts, and memory stays.
   */
  private conversationService: string | null = null;
  /** The endpoint this connection uses (null: GitHub Copilot), asked of HostOptions.provider as it started. */
  private active: ActiveProvider | null = null;
  /** What providerNow() said as this connection started (providerKey), to see a change since. */
  private startedProvider = "";
  /** Requests asked after the model service changed while a turn or a task was under way: sent to the new one later. */
  private held: { text: string; context: Parameters<AgentHost["ask"]>[1]; epoch: number; how: Parameters<AgentHost["ask"]>[3] }[] = [];
  /** Requests asked that wait for a connection, or for a silent turn to end, before they are sent (conversationTurn). */
  private waitingAsks = 0;
  /** What Home was last told of the conversation's turn (turnChanged). */
  private turnTold: ConversationTurn = "idle";
  /** The turn's end is told once what came with it has been (turnChanged). */
  private turnEnding = false;
  /** How the turn Home was told of ended, when a Stop ended it: told with its "idle" (home-c2-2). */
  private turnEnd: ConversationTurnEnd | undefined;
  /** A release of the held requests is under way. */
  private releasing = false;
  /** Counts releases and the Stops that end them: a release that finds it moved on does nothing more. */
  private releaseGen = 0;
  /** The next look at whether the held requests can go. */
  private heldTimer: ReturnType<typeof setTimeout> | null = null;
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
  /** A switch of model service waits for the turn or the tasks under way (AgentStatus.switchPending). */
  private switchWaits = false;
  /** Ember is quitting: finished tasks are neither shown nor announced. */
  private quitting = false;
  /** How the tasks of a connection that went away ended, for the next conductor (it resumes the conversation). */
  private carried: string[] = [];
  /**
   * "Commands are off" with Open settings (review #40: once per run): its presenter, once offered. It counts as offered
   * once it has reached the screen, or while it waits to.
   */
  private commandsHint: Presenter | null = null;
  /**
   * A request asked for a terminal or a command while commands are off by the user's switch: the hint is offered when
   * its turn ends, behind the answer (asked before the request, it would be covered by "Thinking…" and run out unseen).
   */
  private hintOwed = false;
  /** "Memory is off" behind the answer to a "remember…" that memory couldn't keep (memory-c1-1): its presenter. */
  private memoryHint: Presenter | null = null;
  /** A refused sign-in is being checked with Copilot (checkSignIn): one check at a time. */
  private checkingSignIn = false;
  private checkingProvider = false;
  /** The system proxy given to the runtime at the last start (or a SOCKS one it couldn't use). */
  private proxy: { url: string | null; socks?: string } | undefined;
  private readonly transcript: TranscriptEntry[] = [];
  /** Lines restored from the saved copy: shown, but never a question a "yes" agrees to or words a task is checked against. */
  private readonly restored = new WeakSet<TranscriptEntry>();
  /** Lines Forget everything deleted from the saved copy: they stay on screen but are never saved again. */
  private readonly unsaved = new WeakSet<TranscriptEntry>();
  /**
   * The history generation: bumped whenever the saved conversation is invalidated because the identity behind it may
   * have changed (the model service's credentials, sign-out, another account). A connection captures it as it starts
   * (doStart); what it says after a bump (a late answer, a stream, a task's result) is shown but never saved.
   */
  private connGen = 0;
  /** The generation of the connection whose callback is running now (underGen), else null: this is the current one. */
  private callGen: number | null = null;
  /** The generation the live conversation (conductor) began under: what the presenter says for it (its answers) is of that one. */
  private conductorGen: number | null = null;
  /** A deletion of the saved conversation failed and hasn't succeeded since (told to the person by sign-out and Forget). */
  private historyEraseFailed = false;
  /** The owner the saved copy was last looked at for: a reconnect of the same one doesn't restore again. */
  private historyOwner: string | null = null;
  /** The model service's credentials as last seen (providerCredentials), to tell a change that may be another account. */
  private historyService: string | null = null;
  /** The user's lines in the transcript that were heard where Ember can't tell the user from its speakers (V1). */
  private readonly voiceUnchecked = new WeakSet<TranscriptEntry>();
  /** The user's requests that were Ember's suggestions they chose (UserRequest.suggested). */
  private readonly suggested = new WeakSet<TranscriptEntry>();
  /** The user's lines that were heard over Ember's own voice (UserRequest.overEmber). */
  private readonly overEmber = new WeakSet<TranscriptEntry>();
  /**
   * Lines of the user's words a task was refused for because they named the terminal, and the request whose turn
   * refused it: a later turn (the user answering how else) isn't held to them again.
   */
  private readonly terminalRefused = new Map<string, UserRequest>();
  /** The request whose turn wrote the last problem line (rememberProblem). */
  private problemTurn: UserRequest | null = null;
  /** Main's hold is pinned ("Read all" opened the whole answer): no timer gives it back. */
  private pinned = false;
  /** What the last "I can't reach Copilot" (or "I need Copilot first") notice said, until Ember is connected again. */
  private unreachable: string | null = null;
  /** The bubble says the runtime stopped and Ember is reconnecting (lost): once ready, it says Copilot is back (rp-6). */
  private reconnectingShown: string | null = null;
  /** The bubble says Ember stopped reconnecting (lost gave up): once Check again brings it back, it says so (reliability-performance-r3-2). */
  private gaveUpShown: string | null = null;
  /** A finished task's line in the transcript: its result as it said it (without the title the conversation wrote). */
  private readonly results = new WeakMap<TranscriptEntry, string>();
  /**
   * A line of a task that may be tried again (it failed, or its question went unanswered): the user's own words it was
   * asked with (TaskManager.askedWith), which a "try again" right after it carries (tasks-approvals-1).
   */
  private readonly retryWords = new WeakMap<TranscriptEntry, RetriedWords & { task: string }>();
  /** The conversation's presenter (kept across restarts, so a restart can tidy its bubble). */
  private readonly presenter: Presenter;
  /** Bubbles of Ember's own that are no turn's or task's (the targets runtime's), written through the shared bubble. */
  private readonly noticeBoard: Presenter;
  /** The targets runtime's offers, on a board of their own (cross-review X3: see offers). */
  private readonly offerBoard: Presenter;
  /** Each running task's presenter (the kill switch silences them). */
  private readonly taskPresenters = new Map<string, Presenter>();
  /** Tasks the kill switch stopped: they finish without a bubble of their own (the kill switch said it). */
  private readonly stoppedByAll = new Set<string>();
  /** Why tasks stopped with their computer (its connection dropped, someone there pressed Stop): said instead of "Stopped.". */
  private readonly stoppedWhy = new Map<string, string>();
  /** Tasks the conversation's latest turn started (its reply announces them: "On it…"). */
  private readonly announced = new Set<string>();
  /** Finished tasks' presenters, while their cards are up (closing a card drops a result still waiting to show). */
  private readonly outcomes = new Map<string, Presenter>();
  /**
   * The tasks that finished in this conversation, newest last (at most FINISHED_KEPT, none older than CATCH_UP_MS):
   * "what did I miss?" and "status?" answer from them after their cards have gone (TaskManager forgets a task then).
   */
  private finishedLately: Task[] = [];
  /** The target each task started by the conversation acts on, until it finishes (its result names a remote). */
  private readonly taskBindings = new Map<string, TargetBinding>();
  /** Memory's mark of the request that started each task the conversation started, until it finishes (memory-x8-4). */
  private readonly taskMarks = new Map<string, number>();
  /** Whether each running remote task has used its computer's desktop (a lock there stops only those, §5.3.4 step 8). */
  private readonly taskDesktop = new Map<string, () => boolean>();
  /** Each running task's hold on its command runner's status line (followStatus), let go when it finishes. */
  private readonly taskStatus = new Map<string, () => void>();
  /**
   * What the conversation's prompt promised when it was created (§3.15): kept for its resumes (the system message is
   * kept with it), and compared with now on every request.
   */
  private convoCaps: PromptCaps | null = null;
  /** Which chat a request belongs to: bumped whenever a conversation is forgotten, so a late failure of an old request can't reconnect (and cut off the tasks of) a newer chat. */
  private conversationEpoch = 0;
  /**
   * The chat the conductor's answer callbacks speak for. New conversation renews the same conductor (one set of callbacks)
   * onto a fresh session, so the binding moves with it; the conductor itself drops a retired session's events.
   */
  private conductorChat: { chat: number } = { chat: 0 };
  /** The answer streaming now (Home shows it as it comes); null between answers. */
  private stream: { id: number; text: string; unsaved: boolean } | null = null;
  private streamSeq = 0;
  /**
   * The answer Home was showing when Ember began to quit, kept then as a line (stop()): its own message may still come
   * while Ember quits, and it is that line, never a second one.
   */
  private keptAtQuit: TranscriptEntry | null = null;
  /** A "New conversation" under way: a second one joins it. */
  private resetting: Promise<void> | null = null;
  private readonly stateFile: string;

  /** The OS's keys, words, apps, settings and security vocabulary (Linux's unless main passes its own). */
  private get sys(): WorkerSystem { return this.o.system ?? LINUX_WORKER_SYSTEM; }

  /** The Confirmer tasks ask with: the hands', or without them (no window system) the task base's (§2.6). */
  private get confirmer(): Confirmer | undefined { return this.o.hands?.confirmer ?? this.o.taskBase?.confirmer; }

  /** The signed-out line for how this build signs in. */
  private get signedOut(): string { return this.o.signInWith === "github-cli" ? SIGNED_OUT_CLI : SIGNED_OUT; }

  /**
   * What every presenter's bubbles follow: this OS's shortcuts, those Ember holds now (a bubble names a shortcut only
   * while it works, cross-review X0, X5), the user's More time to read and answer, and their text size.
   */
  private get bubbleOptions(): PresenterOptions {
    const o = this.o;
    return {
      shortcuts: this.sys.shortcuts, ...(o.readTime ? { readTime: o.readTime } : {}), ...(o.textScale ? { textScale: o.textScale } : {}),
      ...(o.settingsKey ? { settingsKey: o.settingsKey } : {}), ...(o.stopKey ? { stopKey: o.stopKey } : {}),
      serviceOnThisComputer: () => this.ownServiceHere(),
    };
  }

  /** Said once a run (BELOW_INTERACTIVE_HINT); taken by the first question it is added to. */
  private belowInteractiveTold = false;
  /**
   * The words for the first question Interactive would have announced instead, while Ember is below Interactive for
   * want of its card (an existing user after the update): once a run (modes-x9p-3).
   */
  private belowInteractiveHint(): string | null {
    if (this.belowInteractiveTold || !belowInteractiveForCard(this.o.settings.get().approvals, this.o.admin?.() ?? null)) return null;
    this.belowInteractiveTold = true;
    return BELOW_INTERACTIVE_HINT;
  }

  /** The user's own model service in use runs on this computer (Ollama, LM Studio): unreachable, it is asked about as not running. */
  private ownServiceHere(): boolean {
    const p = this.active ?? this.providerNow();
    return p?.kind === "user" && !keyNeeded(p.config.baseUrl);
  }

  constructor(private o: HostOptions) {
    this.status = {
      phase: "signed-out", detail: this.signedOut, models: [], conductorModel: null, workerModel: null,
      usage: { calls: 0, inputTokens: 0, outputTokens: 0 }, ...(o.signInWith ? { signInWith: o.signInWith } : {}),
    };
    this.stateFile = path.join(o.userData, "agent.json");
    // Off (the default): no saved conversation is left on this computer, whatever an earlier run did.
    if (o.history && !o.history.enabled()) o.history.store.clear();
    // A question with buttons holds the bubble; what it held off shows once it's answered.
    const c = this.confirmer;
    this.owner = new BubbleOwner(c ? { up: () => c.waiting, answered: () => c.settled().then(() => this.dropAnnouncement()) } : undefined);
    // Every change of the conversation's bubble may change what Home says of its turn (its stall: home-c1-1).
    this.presenter = new Presenter(patch => { o.setState(patch); this.turnChanged(); }, undefined, () => "Ember", this.owner, text => this.rememberAnswer(text), () => this.serviceKind(),
      { onEvent: e => this.conversationEvent(e), onProblem: text => this.rememberProblem(text), ...this.bubbleOptions });
    this.noticeBoard = new Presenter(o.setState, undefined, () => "Ember", this.owner, undefined, () => this.serviceKind(), this.bubbleOptions);
    this.offerBoard = new Presenter(o.setState, undefined, () => "Ember", this.owner, undefined, () => this.serviceKind(), this.bubbleOptions);
    // Reminders kept from the last run come back now, not once Copilot connects: one due while Ember was offline or
    // signed out is still told on time (a reminder never needs Copilot). Not before the user has agreed to Ember at
    // all: nothing is read or told until then (they come back with the conversation, once it starts).
    let agreed = false;
    try { agreed = hasConsent(o.settings.get()); } catch { /* settings unread: nothing comes back yet */ }
    if (agreed && this.routinesWanted()) this.keepRoutines();
  }

  /**
   * The user's reminders (reminders.ts): set only from their own words, kept in memory only, and when one is due it is
   * shown in the bubble (main also says it and notifies): it never starts anything.
   */
  readonly reminders = new Reminders({ onDue: r => this.reminderDue(r), onList: rows => this.o.onRemindersChanged?.(rows) });

  private reminderDue(r: Reminder): void {
    this.o.log.info("agent.reminder_due", { late: Math.max(0, Date.now() - r.at) });
    // One that fell due while Ember was closed (a lasting reminder) says when it was due.
    const text = r.missed ? `${r.text} (due ${whenWords(r.at, Date.now())})` : r.text;
    this.remember("ember", `${r.missed ? "Missed reminder" : "Reminder"}: ${text}`);
    this.noticeBoard.post({ title: r.missed ? "Missed reminder" : "Reminder", thought: text, actions: [], mood: "attention" }, { ms: 60_000, emotion: "curious" });
    this.o.onReminder?.(r);
  }

  /**
   * Where the targets runtime's bubbles go (a connection, an offer, a loss): through the shared bubble, so the
   * conversation's and the tasks' bubbles wait behind them as behind a question, and no presenter's timer hides them.
   */
  get notices(): NoticeBoard {
    return this.noticeBoard;
  }

  /**
   * Where the targets runtime's offers go ("You're connected to web-07", "I can work in WSL", offer_connect's Connect):
   * the shared bubble too, but not the notices' writer, which keeps one bubble at a time. An offer nobody asked for
   * then waits behind a held notice ("Lost build-01", "Can't connect") instead of replacing it for good, and one the
   * user asked for covers it, which comes back after (cross-review X3).
   */
  get offers(): NoticeBoard {
    return this.offerBoard;
  }

  /**
   * A turn of the conversation starts with its request's message (the runtime holds a request sent during a
   * turn until that turn ends): what that turn does belongs to that request. The message is the prompt
   * conductor.ask sent. Match it whole and consume only that request; identical prompts take the oldest one.
   * A message that is none of them (nothing the user asked) takes none of their context or authority.
   */
  private conversationEvent(e: PresenterEvent): void {
    // Copilot refused the sign-in mid-session (revoked, expired, the seat removed): it is asked whether it still holds.
    if (e.type === "session.error" && (e.data?.errorType === "authentication" || e.data?.statusCode === 401)) void this.checkSignIn(this.gen);
    // A turn on the user's own provider failed with no answer from it (no status code): is anything listening there?
    else if (e.type === "session.error" && this.active?.kind === "user" && typeof e.data?.statusCode !== "number") void this.checkProvider(this.gen);
    if (e.type !== "user.message" || (e as { agentId?: string }).agentId) return;
    const said = typeof e.data?.content === "string" ? e.data.content : undefined;
    const i = said === undefined ? -1 : this.queued.findIndex(r => r.prompt === said);
    this.turn = i < 0 ? null : this.queued[i];
    if (i >= 0) this.queued.splice(i, 1);
    if (this.turn) this.o.onTurnStart?.({ text: this.turn.words, spoken: !!this.turn.spoken, ...(this.turn.manual ? { manual: true } : {}) });
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

  /**
   * A turn or a task failed on a refused sign-in (review #138): Copilot is asked whether the sign-in still holds. If it
   * doesn't (the token was revoked or expired, or the account lost Copilot), Ember leaves Ready for the sign-in error:
   * the handle says "Sign-in refused", settings offer Sign in and Check again, a question says why instead of failing
   * the same way again, and the bubble gets its Open settings button. A passing 401 changes nothing.
   */
  private async checkSignIn(gen: number): Promise<void> {
    const client = this.client;
    if (this.active || this.checkingSignIn || gen !== this.gen || this.status.phase !== "ready" || !client) return;
    this.checkingSignIn = true;
    try {
      const auth = await within(client.getAuthStatus(), 10_000);
      if (gen !== this.gen || this.status.phase !== "ready" || auth === "timeout" || auth.isAuthenticated) return;
      this.o.log.warn("agent.sign_in_refused", { source: this.source });
      const detail = explainStartError(new Error("not authenticated"), { source: this.source, sourceName: this.sourceName, proxy: this.proxy });
      this.setStatus({ phase: "error", reason: "sign-in", detail });
      this.presenter.notice({ title: NOTICE_TITLE["sign-in"], text: SIGN_IN_REFUSED, actions: [{ id: "ui:settings", label: "Open settings" }] });
    } catch (err) {
      this.o.log.warn("agent.sign_in_check_failed", { err });
    } finally {
      this.checkingSignIn = false;
    }
  }

  /**
   * A turn on the user's own provider failed without an answer (integrations-1): its connection test is made. If nothing
   * answers (a model server on this computer that was stopped, a host gone from the network), Ember leaves Ready for
   * the reason, so the handle, Home and the next request say why at once, and reconnects later as a start that can't
   * reach it does (each try asks the provider first). Never while a task is under way: the reconnect would cut it off.
   */
  private async checkProvider(gen: number): Promise<void> {
    const p = this.active;
    const probe = this.o.probeProvider;
    if (p?.kind !== "user" || !probe || this.checkingProvider || gen !== this.gen || this.status.phase !== "ready" || this.tasksAtWork()) return;
    this.checkingProvider = true;
    try {
      const down = providerDown(await probe(), serviceHost(p.config.baseUrl), !keyNeeded(p.config.baseUrl));
      if (!down || gen !== this.gen || this.status.phase !== "ready" || this.tasksAtWork()) return;
      this.o.log.warn("agent.provider_unreachable", { during: "turn" });
      this.setStatus({ phase: "error", reason: "network", detail: down });
      this.retryLater();
    } catch (err) {
      this.o.log.warn("agent.provider_check_failed", { err });
    } finally {
      this.checkingProvider = false;
    }
  }

  /**
   * Commands are off only by the user's switch (caps.commandsOffered) and the user asked for a terminal or a command, or
   * the answer said where to turn them on: once per run, after the answer, a bubble says commands are off, with Open
   * settings (review #40). Never where the administrator turned commands off, or once they're on.
   */
  private hintCommands(): void {
    const h = this.commandsHint;
    if (h && (h.shownAt !== null || h.visible)) return;
    let caps: PromptCaps | undefined;
    try { caps = this.o.targets?.caps(); } catch { return; }
    if (!caps?.commandsOffered || caps.commands) return;
    // Its own presenter: the bubble shows once the conversation's answer has gone (it doesn't cut the answer short), and
    // stays as long as the user's More time to read and answer says, as every bubble does.
    const p = this.commandsHint = new Presenter(this.o.setState, undefined, () => "Ember", this.owner, undefined, () => this.serviceKind(), this.bubbleOptions);
    p.outcome({
      title: "Commands are off", text: "Ember can run commands for you in its own command window once you turn them on in its settings (Commands).",
      emotion: "neutral", gesture: "rest", mood: "idle", actions: [{ id: "ui:settings", label: "Open settings" }],
    });
  }

  /**
   * After the conversation answered "remember…" while memory can't keep it (memory-c1-1): Ember's own line in the
   * conversation, and a bubble that shows once the answer has gone (it doesn't cut the answer short), with Open Memory.
   */
  private noteMemory(n: MemoryNote): void {
    this.remember("ember", n.text);
    this.memoryHint?.quiet();
    const p = this.memoryHint = new Presenter(this.o.setState, undefined, () => "Ember", this.owner, undefined, () => this.serviceKind(), this.bubbleOptions);
    p.outcome({ title: n.title, text: n.text, emotion: "neutral", gesture: "rest", mood: "idle", actions: memoryNoteActions(n) });
  }

  /** Changes with every Stop: main takes it before a slow step (reading the screen) and passes it to ask(). */
  get stopEpoch(): number {
    return this.stops;
  }

  /**
   * Main writes the bubble itself next ("Listening…", the kill switch's message): no presenter's timer hides
   * it, and neither the conversation nor a task replaces it until main gives it back (releaseBubble), the user
   * asks something, or 30 seconds pass. A task's work shows on its card meanwhile. The answer or result it
   * covers doesn't run out of time underneath (main may put it back: a wake that was another word). `ms`: main's own
   * notice gives the bubble back itself after this long (ten times its usual time with More time to read and answer):
   * held that long, and the 30 seconds count from then (cross-review X4).
   */
  /**
   * What Ember does without asking outside a task, said in the conversation's bubble with its "Without asking" tag: the
   * extensions gate's announcement in Autopilot (extensions/gate.ts gateAnnouncement: Ember's own words, never a
   * model's). Whether it was said: the gate asks instead when it wasn't.
   */
  announceUnasked(words: string): boolean {
    try {
      this.presenter.workedWithoutAsking(words);
      return true;
    } catch (err) {
      this.o.log.warn("agent.announce_failed", { err });
      return false;
    }
  }

  claimBubble(o: { pin?: boolean; ms?: number } = {}): void {
    this.owner.claim(this.mainBubble);
    this.presenter.letGo();
    if (this.mainHold) clearTimeout(this.mainHold);
    this.mainHold = null;
    // Pinned ("Read all" opened the whole answer): main holds it until the user closes it or asks something, or the
    // answer goes another way (releasePin).
    this.pinned = !!o.pin;
    if (o.pin) return;
    this.mainHold = setTimeout(() => this.releaseBubble(null), MAIN_HOLD_MS + Math.max(0, o.ms ?? 0));
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
    this.pinned = false;
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

  /**
   * A question's answer ("Thanks! Carrying on.") has had its moment (the Confirmer's afterAnswer): what the question held
   * off or covered shows again. False when nothing is left to show: main empties the bubble (afterAnswerPatch).
   */
  afterAnswer(): boolean {
    return this.owner.afterAnswer();
  }

  /**
   * The Ask box opened (`open`) or closed: while it is open, no bubble goes on its timer, so the answer being replied to
   * stays beside the box (companion-c2-1); once it closes, each goes after what was left of its time, or a moment.
   */
  holdForAsk(open: boolean): void {
    this.owner.holdForAsk(open);
  }

  /**
   * The expanded answer went without its Close button (main cleared it for settings, or a question replaced it): a pinned
   * hold has nothing left to keep, and no timer would end it, so it ends now as Close ends it. Any other hold of main's
   * ("Listening…") keeps its own time. `showing`: what is on screen now.
   */
  releasePin(showing: BubbleState | null): void {
    if (this.pinned && this.owner.holder === this.mainBubble) this.releaseBubble(showing);
    this.pinned = false;
  }

  getStatus(): AgentStatus {
    return this.status;
  }

  /** A start failed for want of a network and will try again by itself: nothing for the user to set up. */
  get waitingForNetwork(): boolean {
    return this.retry !== null;
  }

  /** The conversation as Home shows it: the lines restored from before a restart say so (`restored`, home-8). */
  getTranscript(): TranscriptEntry[] {
    return this.transcript.map(e => (this.restored.has(e) ? { ...e, restored: true } : e));
  }

  /**
   * Who and what the saved conversation belongs to: the GitHub account's id (when known) together with the model
   * service of this connection: "copilot", or the provider's kind, a hash of its address and the random id of the key
   * saved for it (never the key, nor anything derived from it). Written into the file and compared on every restart, so
   * a conversation is shown only to the same account on the same service with the same key. Null (nothing is saved or
   * shown, the saved copy goes) while that can't be established: neither an account nor a provider is known, or the
   * provider's key has no id (saved before ids existed, or a fixed config's own key).
   */
  private historyAccount(): string | null {
    const p = this.active;
    let service: string;
    if (!p) service = "copilot";
    else if (p.config.apiKey && !p.keyId) return null;
    else service = `provider:${p.kind}|${createHash("sha256").update(p.config.baseUrl).digest("hex").slice(0, 32)}|${p.config.apiKey ? p.keyId : "nokey"}`;
    if (this.githubAccountId !== null) return `github:${this.githubAccountId}|${service}`;
    return p ? `none|${service}` : null;
  }

  /** Tells Home when history is on but a provider's key can't be tied to an id, so nothing would be saved (never silent). */
  private noteOwner(owner: string | null): void {
    const keyLess = owner === null && !!this.active?.config.apiKey;
    // Copilot: only after an attempted lookup came back without an id (not while one is outstanding).
    const noAccount = owner === null && !this.active && this.accountUnresolved;
    this.o.history?.store.setOwnerKnown(!keyLess && !noAccount, noAccount ? "account" : "owner");
  }

  /** What is being said now comes from a connection that began before the saved copy was last invalidated. */
  private staleSource(): boolean {
    const g = this.callGen ?? this.conductorGen;
    return g !== null && g !== this.connGen;
  }

  /** A history fence: what a connection that began before the current generation says is never saved (see connGen). */
  private underGen<T>(gen: number, f: () => T): T {
    const before = this.callGen;
    this.callGen = gen;
    try { return f(); } finally { this.callGen = before; }
  }

  /** Saves only once the saved copy of this owner has been looked at (restoreHistory): an earlier copy is never silently replaced. */
  private saveHistory(): void {
    const h = this.o.history;
    if (!h?.enabled()) return;
    const owner = this.historyAccount();
    this.noteOwner(owner);
    if (owner === null || owner !== this.historyOwner) return;
    h.store.save(owner, this.transcript.filter(e => !this.unsaved.has(e)));
  }

  /**
   * The credentials of the model service changed (its key replaced or removed, its address or kind changed, or it was
   * turned on or off): that may be another person's account, so the saved copy goes and the lines on screen now are never
   * saved under the new one. Compared in memory only; nothing is derived from the key.
   */
  private checkHistoryService(): void {
    const now = providerCredentials(this.providerNow());
    if (this.historyService === now) return;
    const first = this.historyService === null;
    this.historyService = now;
    if (first) return;
    for (const e of this.transcript) this.unsaved.add(e);
    this.connGen++;
    this.eraseHistory();
    this.o.log.info("agent.history_service_changed");
  }

  /** The conversation went (sign-out, another account, New conversation): so does the saved copy, whatever the setting. */
  private dropHistory(sameOwner = false): void {
    // (New conversation and the switch keep the owner: it was looked at already. Sign-out and another account look afresh.)
    if (!sameOwner) { this.historyOwner = null; this.connGen++; }
    this.eraseHistory();
  }

  /** Deletes the saved copy and remembers whether that worked. */
  private eraseHistory(): boolean {
    const ok = this.o.history?.store.clear() ?? true;
    this.historyEraseFailed = !ok;
    return ok;
  }

  /** Why the saved conversation couldn't be deleted (a sentence Home shows as it is), or null. */
  historyDeleteProblem(): string | null {
    return this.historyEraseFailed ? "Ember couldn't finish deleting the saved conversation on this computer. Try again." : null;
  }

  /**
   * Shows the lines saved before Ember restarted, once the account is known and only if it is the one that saved them.
   * They are for reading: marked `restored`, they are never a question a later "yes" agrees to, never words a task is
   * checked against, and nothing is sent to a model or spoken (the conductor's session is new).
   */
  private restoreHistory(): void {
    const h = this.o.history;
    if (!h?.enabled()) return;
    const owner = this.historyAccount();
    this.noteOwner(owner);
    // A key with no id (saved before ids existed): whose it is can't be told, so no earlier copy is kept for it.
    if (owner === null && this.active?.config.apiKey && !this.active.keyId) { this.eraseHistory(); return; }
    if (owner === null || owner === this.historyOwner) return;
    this.historyOwner = owner;
    const saved = h.store.load(owner);
    if (!saved.length) return;
    // Said before the account was known (or a connection ago): the saved lines come first and the live ones after, so the
    // next save keeps both instead of replacing the earlier copy.
    const live = this.transcript.splice(0);
    const entries = saved.map(e => { const entry: TranscriptEntry = { ...e }; this.restored.add(entry); return entry; });
    this.transcript.push(...entries, ...live);
    if (this.transcript.length > CONVERSATION_LIMIT) this.transcript.splice(0, this.transcript.length - CONVERSATION_LIMIT);
    this.o.log.info("agent.history_restored", { n: saved.length });
    this.o.onTranscript?.(this.getTranscript());
    if (live.length) this.saveHistory();
  }

  /** The setting changed: on saves what is shown now, off deletes the saved copy. */
  applyHistorySetting(): void {
    const h = this.o.history;
    if (!h) return;
    if (h.enabled()) { this.restoreHistory(); this.saveHistory(); }
    else this.dropHistory(true);
  }

  /** Forget everything: the saved copy goes now, and what is on screen is never saved. */
  forgetHistory(): boolean {
    for (const e of this.transcript) this.unsaved.add(e);
    // The answer streaming now is on screen too: its words are never saved, even if it is stopped later.
    if (this.stream) this.stream.unsaved = true;
    return this.eraseHistory();
  }

  /** The last retained answer. Home discloses if the explicit per-message memory bound was reached. */
  lastAnswer(o: { readable?: boolean } = {}): string | null {
    // `readable` (for "read it out", "say that again"): the last thing Ember said, a finished task's result too (main
    // speaks those: an older answer was read in its place, voice-speaking-x7-3), and not Ember's own "I can't read it
    // out", which a second "read it out" would otherwise read.
    const unread: readonly string[] = o.readable ? Object.values(READ_OUT_REPLY) : [];
    return [...this.transcript].reverse().find(e => (e.who === "ember" || (o.readable && e.who === "task")) && !e.stopped && !unread.includes(e.text))?.text ?? null;
  }

  /**
   * What the user said for a task started in turn `r`, which its risky steps are checked against (`words`): their words
   * in that turn, and where those only answer Ember ("yes please", "Ana Lopez", "the forecast": Ember's last words before
   * them asked a question, a sentence ending with "?", and they name nothing risky of their own, or they are a few words
   * that name no action at all), the user's words in the turn before too (and before that while those answered too:
   * three turns at most, each within ten minutes of the next, none before a task's outcome). Only the user's own words,
   * never what was read on the screen.
   *
   * `agreed`: Ember's questions in those turns that the user's reply agreed to or answered ("I can delete the old
   * installers. Shall I?" "Sure, go ahead."), the reply within ten minutes; a task's result asking ("Want me to send
   * it?") counts for the reply right after it only. A risky step one of them names is still asked about (PolicyEngine).
   *
   * `commandWords`: the same words without those heard where Ember can't tell the user from its speakers (OWNER V1:
   * a call or a video can say "delete the build folder"), present only when some were left out. Commands hear these.
   * `typedOnly`: commandWords leaves out only a routine's steps, nothing heard by voice (the command card doesn't say
   * the user asked by voice).
   * `checkWords`: the words Assisted's check reads a step against (PLAN.md §2 "Approvals"), present only when they
   * differ from the ones commands hear: what was heard unchecked counts here, but never a suggestion the user chose
   * (Ember's words), words heard over Ember's own voice, or a routine's saved steps (the request that ran it counts).
   */
  private userWordsOf(r: UserRequest | null, o: { routine?: boolean } = {}): { words?: string; agreed?: Agreement[]; commandWords?: string; typedOnly?: boolean; checkWords?: string; retried?: { task: string; partWay?: boolean } } {
    if (!r) return {};
    const said = [r.words];
    const typed = r.voiceUnchecked || r.suggested ? [] : [r.words];
    const checked = r.suggested || r.overEmber ? [] : [r.words];
    // Left out for being heard where Ember can't tell (the card then says so), not only for being a suggestion.
    let heardLeft = !!r.voiceUnchecked;
    const agreed: Agreement[] = [];
    const log = this.transcript;
    const apart = (a: TranscriptEntry, b: TranscriptEntry) => Date.parse(a.t) - Date.parse(b.t);
    const requestText = retainedConversationText(r.words).text;
    let at = log.map(e => e.who === "you" && !this.restored.has(e) && e.text === requestText).lastIndexOf(true);
    // "Try again" right after a task that didn't finish: that task's own words go with it (tasks-approvals-1).
    const again = this.retriedWords(r, at);
    if (again) {
      // Ended as a sentence, so a retry asked as a question ("can you try again?") doesn't make the request it carries
      // one too (policy reads sentences, not lines), as the turns before a reply are.
      const ended = (w: string) => (/[.!?…]\s*$/.test(w) || !w.trim() ? w.trim() : `${w.trim()}.`);
      said.unshift(ended(again.userWords));
      if (typed.length) typed.unshift(ended(again.commandWords ?? again.userWords));
      if (checked.length) checked.unshift(ended(again.checkWords ?? again.commandWords ?? again.userWords));
      // What they agreed to for it goes too, as its card's Try again carries it (tasks-approvals-c1-3).
      if (again.agreed) agreed.push(...again.agreed);
      at = 0;
    }
    for (let n = 0; at > 0 && n < 3; n++) {
      const reply = log[at].text;
      const last = log[at - 1];
      // Lines from before a restart are only to read: no question there is agreed to, none of those words stand for this task.
      if (this.restored.has(last)) break;
      const question = last.who === "ember" && !last.stopped ? questionOf(last.text) : n === 0 && last.who === "task" ? questionOf(this.results.get(last) ?? "") : "";
      if (question && apart(log[at], last) <= 10 * 60_000 && agrees(reply, question)) agreed.unshift({ asked: question, answer: reply });
      let k = at - 1;
      const asked = last.who === "ember" && !last.stopped && asks(last.text);
      while (k >= 0 && log[k].who === "ember") k--;
      const before = log[k];
      if (!before || this.restored.has(before) || before.who !== "you" || apart(log[at], before) > 10 * 60_000) break;
      if (isRiskyLabel(reply, this.sys.os) || !(asked || onlyAnswers(reply))) break;
      said.unshift(/[.!?]\s*$/.test(before.text) ? before.text.trim() : `${before.text.trim()}.`);
      if (!this.voiceUnchecked.has(before) && !this.suggested.has(before)) typed.unshift(said[0]);
      else if (this.voiceUnchecked.has(before)) heardLeft = true;
      if (!this.suggested.has(before) && !this.overEmber.has(before)) checked.unshift(said[0]);
      at = k;
    }
    const left = typed.length < said.length || again?.commandWords !== undefined;
    const voiced = left && (heardLeft || (again?.commandWords !== undefined && !again.typedOnly));
    // The steps of a routine this turn ran (run_routine): the user's own words when they saved it, so its tasks' risky
    // steps get the usual question rather than "you didn't ask for this". Never words for commands: a step saved as
    // "delete the build folder" must not make `rm -rf build` the user's own request now (it asks, as any dangerous
    // command they didn't say does), so commandWords is always given then, without them (the worker would otherwise
    // fall back to the words, steps and all). `routine`: false leaves them out (a steer).
    const steps = o.routine !== false && r === this.turn ? this.conductor?.routineSaid ?? "" : "";
    // What the worker would take for the check without being told (commandWords, else the words): given only when it differs.
    const forCommands = left || steps ? typed.join("\n") : said.join("\n");
    if (steps) said.push(steps);
    return {
      words: said.join("\n"), ...(agreed.length ? { agreed } : {}),
      ...(left || steps ? { commandWords: typed.join("\n") } : {}),
      ...(checked.join("\n") !== forCommands ? { checkWords: checked.join("\n") } : {}),
      ...((steps || left) && !voiced ? { typedOnly: true } : {}),
      ...(again ? { retried: { task: again.task, ...(again.partWay ? { partWay: true } : {}) } } : {}),
    };
  }

  /**
   * The words of the task a "try again" asks for again, or null (tasks-approvals-1, -c1-3): request `r` (at `at` in the
   * transcript) only asks to try again (retryRequest: "try again", "can you try again?", "yes, try again"), and the
   * nearest line before it, Ember's lines aside and at most two short questions of the user's own about what happened
   * ("why didn't it work?", naming nothing risky), is of a task that may be tried again (it failed, or its question went
   * unanswered: never one the user said "Not now" to or stopped); or `r` agrees ("yes please") to that task's own offer
   * to try again ("Want me to try again?") with nothing asked since. All within ten minutes, or for as long as that task's
   * card still offers Try again (one kept while the user was away: tasks-approvals-4), and the request is the user's own
   * (not heard where Ember can't tell them from its speakers, not a suggestion). Those are the words that task was asked
   * with, and what they agreed to, as its card's Try again carries them: never its goal, which the model wrote. A
   * request of the user's own in between ends the search.
   */
  private retriedWords(r: UserRequest, at: number): (RetriedWords & { task: string }) | null {
    const log = this.transcript;
    if (at <= 0 || r.voiceUnchecked || r.suggested) return null;
    const retry = retryRequest(r.words);
    const now = Date.parse(log[at].t);
    let k = at - 1;
    let old = false;
    for (let asked = 0; k >= 0; k--) {
      const e = log[k];
      if (this.restored.has(e)) return null;
      if (now - Date.parse(e.t) > 10 * 60_000) old = true;
      if (e.who === "ember") continue;
      const t = e.text.trim();
      const why = e.who === "you" && t.length <= 80 && (ASKS_WHAT_HAPPENED.test(t) || retryRequest(t)) && !isRiskyLabel(t, this.sys.os);
      if (retry && why && asked++ < 2) continue;
      break;
    }
    const line = log[k];
    const words = line?.who === "task" ? this.retryWords.get(line) : undefined;
    if (!words || (old && !this.tasks?.canRetry(words.task))) return null;
    if (retry) return words;
    // Its offer is the last question before the yes: only Ember's lines that ask nothing lie between.
    const offer = log.slice(k + 1, at).every(e => e.who === "ember" && !asks(e.text)) ? questionOf(this.results.get(line) ?? "") : "";
    return offer && OFFERS_RETRY.test(offer) && agrees(r.words, offer) && !isRiskyLabel(r.words, this.sys.os) ? words : null;
  }

  /** A word of the answer (of the chat `chat`: a retired chat's late words are dropped). */
  private streamDelta(delta: string, chat: number): void {
    // (Quitting: the answer Home showed was kept as it stood; no words are shown after it.)
    if (chat !== this.conversationEpoch || !delta || this.quitting) return;
    if (!this.stream) {
      if (!delta.trim()) return;
      this.stream = { id: ++this.streamSeq, text: "", unsaved: this.staleSource() };
    }
    this.stream.text += delta;
    this.o.onAnswerStream?.({ id: this.stream.id, text: plainText(this.stream.text), state: "streaming" });
  }

  /** The answer open now is complete or stopped short; `chat` undefined: ended by this chat's own doing. */
  private endStream(state: "done" | "interrupted", chat?: number): TranscriptEntry | undefined {
    const s = this.stream;
    if (!s || (chat !== undefined && chat !== this.conversationEpoch)) return undefined;
    this.stream = null;
    const text = plainText(s.text);
    // The words said so far are kept in the transcript (the host's record, so a reopened Home shows them), before the
    // stream's own event so Home never sees the row go and come back.
    const kept = state === "interrupted" && text.trim() ? this.remember("ember", text, undefined, true, s.id, s.unsaved) : undefined;
    this.o.onAnswerStream?.({ id: s.id, text, state });
    return kept;
  }

  /**
   * A finished answer, from the presenter (after its words streamed to Home). Quitting after the words Home showed were
   * kept (stop()), it is that line: the same words mark it whole (no longer stopped short), and words Home never
   * showed are not kept. Nothing else is said while Ember quits.
   */
  private rememberAnswer(text: string): void {
    const kept = this.keptAtQuit;
    if (!this.quitting || !kept) { this.remember("ember", text, undefined, undefined, this.stream?.id, this.stream?.unsaved); return; }
    const at = this.transcript.indexOf(kept);
    if (at < 0 || !kept.stopped || retainedConversationText(text).text.trim() !== kept.text.trim()) return;
    const whole: TranscriptEntry = { ...kept };
    delete whole.stopped;
    this.transcript[at] = whole;
    if (this.unsaved.has(kept)) this.unsaved.add(whole);
    this.keptAtQuit = whole;
    this.o.onTranscript?.(this.getTranscript());
    this.saveHistory();
  }

  private remember(who: TranscriptEntry["who"], text: string, heardId?: number, stopped?: true, answerId?: number, fenced = false): TranscriptEntry {
    const entry: TranscriptEntry = { t: new Date().toISOString(), who, ...retainedConversationText(text), ...(heardId ? { heardId } : {}), ...(stopped ? { stopped } : {}), ...(answerId ? { answerId } : {}) };
    // Said by a connection that began before the saved copy was last invalidated (or by a stream Forget everything covered).
    if (fenced || this.staleSource()) this.unsaved.add(entry);
    this.transcript.push(entry);
    if (this.transcript.length > CONVERSATION_LIMIT) this.transcript.splice(0, this.transcript.length - CONVERSATION_LIMIT);
    this.o.onTranscript?.(this.getTranscript());
    this.saveHistory();
    return entry;
  }

  /**
   * One failure, one line: the conversation saying it again (a failed send's reconnect, a silent turn reconnected after
   * it wasn't ended) restates the line before, in the words the bubble ends on. A new request writes its own line first,
   * so each request still gets its own.
   */
  private rememberProblem(text: string): void {
    // What was said so far stays where it was, before the problem's line.
    this.endStream("interrupted");
    const last = this.transcript.at(-1);
    const retained = retainedConversationText(text);
    const said = retained.text;
    // (Only the same request's: two requests sent together that both fail get a line each.)
    if (last?.who === "problem" && this.problemTurn === this.turn && (last.text === said || Date.now() - Date.parse(last.t) < 3000)) {
      const again = { ...last, ...retained, truncated: retained.truncated };
      this.transcript[this.transcript.length - 1] = again;
      if (this.unsaved.has(last)) this.unsaved.add(again);
      this.o.onTranscript?.(this.getTranscript());
      this.saveHistory();
      return;
    }
    this.problemTurn = this.turn;
    this.remember("problem", text);
  }

  private setStatus(patch: Partial<AgentStatus>): void {
    // A reason holds for its error, the default model for its connection.
    const cleared = patch.phase && patch.phase !== this.status.phase
      ? { ...(patch.phase !== "error" ? { reason: undefined } : {}), ...(patch.phase !== "ready" ? { defaultModel: undefined, conversationContext: undefined } : {}) } : {};
    // (A switch waits only while this connection is ready to serve what is under way: first-run-v4-1.)
    const switchPending = this.switchWaits && (patch.phase ?? this.status.phase) === "ready" ? true : undefined;
    this.status = { ...this.status, ...cleared, ...patch, waitingForTasks: this.reconnectAfterTasks !== null, switchPending };
    // Connected again: a notice saying why Ember couldn't answer no longer holds (one still up goes).
    if (this.status.phase === "ready" && this.unreachable !== null) { this.presenter.withdraw(this.unreachable); this.unreachable = null; }
    // Connected again after the runtime stopped: a bubble still saying it is reconnecting says it is back (rp-6).
    if (this.status.phase === "ready" && this.reconnectingShown !== null) {
      const shown = this.reconnectingShown;
      this.reconnectingShown = null;
      this.presenter.reconnected(shown);
      this.problemReconnected();
    }
    // Connected again after Ember gave up (Check again): what said it had stopped reconnecting says it is back.
    if (this.status.phase === "ready" && this.gaveUpShown !== null) {
      const shown = this.gaveUpShown;
      this.gaveUpShown = null;
      this.presenter.reconnected(shown);
      this.problemNow(w => w.reconnected, w => w.gaveUp);
    }
    this.o.onStatus(this.status);
  }

  /**
   * Connected again after the runtime stopped: the conversation's line that said Ember was reconnecting says it is back
   * (reliability-performance-c1-1: Home kept "ask me again in a moment" for good, under its own "Connected.").
   */
  private problemReconnected(): void {
    this.problemNow(w => w.reconnected);
  }

  /**
   * The conversation's latest problem line that says Ember is reconnecting (or `was` of the same words), in Copilot's
   * words or "my model connection"'s as it was written (integrations-v1), says `next` of the same words instead, in Home
   * and the saved copy.
   */
  private problemNow(next: (w: LostWords) => string, was: (w: LostWords) => string = w => w.reconnecting): void {
    const pairs = [lostWords(false), lostWords("user")].map(w => ({ said: retainedConversationText(was(w)).text, w }));
    const at = this.transcript.findLastIndex(e => e.who === "problem" && pairs.some(p => p.said === e.text));
    if (at < 0) return;
    const old = this.transcript[at];
    const now = { ...old, ...retainedConversationText(next(pairs.find(p => p.said === old.text)!.w)) };
    this.transcript[at] = now;
    if (this.unsaved.has(old)) this.unsaved.add(now);
    this.o.onTranscript?.(this.getTranscript());
    this.saveHistory();
  }

  /**
   * (Re)connects with this sign-in. Calls queue: the newest one wins. Resolves to the phase once every
   * queued start and stop has run: "ready", or "error"/"signed-out" with the reason in the status.
   *
   * `how`: "auto" for Ember's own start at launch. After the user signed out, a GitHub CLI or
   * environment sign-in found then isn't used until they sign in again ("user", the default).
   * `name`: the environment variable a token from the environment came from (a refusal names it).
   */
  start(token: string | null, source?: string, how: "user" | "auto" = "user", name?: string): Promise<AgentPhase> {
    this.quitting = false;
    this.keptAtQuit = null;
    this.sourceName = source === "environment" ? name : undefined;
    const automatic = source === "environment" || source === "github-cli";
    // A start after Ember gave up on a runtime that kept stopping is someone's own try (Check again, a sign-in): the
    // count starts afresh, or one more stop within ten minutes gave up again without a single try (reliability-r9-5).
    if (this.gaveUp) { this.gaveUp = false; this.crashes = []; }
    if (token && how === "user") this.setSignedOut(false);
    // (Signed out in this run counts whatever the disk kept of it: reliability-r9-2.)
    else if (token && automatic && (this.signedOutNow || readAgentState(this.stateFile).signedOut)) token = null;
    return this.launch(token, source);
  }

  private launch(token: string | null, source?: string): Promise<AgentPhase> {
    const gen = ++this.gen;
    // (This connect is the switch: the next status says nothing waits.)
    this.switchWaits = false;
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

  /**
   * The user signed out, or signed in again. Kept for this run whatever the disk says: a sign-out whose flag couldn't
   * be written (a read-only or broken disk) still holds a GitHub CLI or environment sign-in back until Ember closes,
   * and the status says it wasn't saved (signOutUnsaved), as the next start can't know of it (reliability-r9-2).
   */
  private setSignedOut(on: boolean): void {
    this.signedOutNow = on;
    try {
      writeAgentState(this.stateFile, { signedOut: on });
      this.signOutUnsaved = false;
    } catch (err) {
      this.signOutUnsaved = on;
      this.o.log.warn("agent.state_not_saved", { err });
    }
  }
  private signedOutNow = false;
  /** Ember stopped reconnecting after the runtime kept stopping (lost): the next start() begins the count again. */
  private gaveUp = false;
  /** The last sign-out couldn't be saved: the next start may use a sign-in it finds, and the status says so. */
  signOutUnsaved = false;

  /**
   * Disconnects for good (quit): the conversation is deleted first, within about two seconds and while
   * the runtime can still do it (what the user asked is kept only while Ember runs).
   */
  stop(): Promise<void> {
    this.quitting = true;
    // An answer whose words Home shows is kept as they stand (if the person keeps their conversation), whether or not its
    // own message comes before the runtime goes: quitting in that gap lost an answer the person had read (CI el8).
    this.keptAtQuit = this.endStream("interrupted") ?? null;
    // Requests held for a new model service go with Ember (not doStop, which every reconnect runs: the switch itself).
    this.dropHeld();
    const halted = this.halt(true);
    // What was said last is on disk before Ember quits (if the person keeps their conversation).
    return halted.finally(() => this.o.history?.store.flush());
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
    // The administrator's policy locks Ember down: nothing connects, so nothing Ember reads goes anywhere.
    // The endpoint in force as this connection starts: it holds until the next connect (tasks keep theirs).
    const provider = this.active = this.providerNow();
    this.startedProvider = providerKey(provider);
    this.checkHistoryService();
    const refused = this.o.refuseConnect?.() ?? null;
    if (refused) {
      this.setStatus({ phase: "error", reason: "policy", detail: refused, login: undefined, source: undefined, service: undefined });
      // Said as what it is: memory waits for the policy, not for a GitHub check that comes back on its own (memory-r9-3).
      this.o.memory?.pauseAccount?.("lockdown");
      this.dropHanded();
      return;
    }
    if (!token && !provider) {
      this.setStatus({ phase: "signed-out", detail: this.o.signedOutWhy?.() ?? (this.signOutUnsaved ? SIGN_OUT_NOT_KEPT : this.signedOut), login: undefined, source: undefined, service: undefined });
      this.o.memory?.pauseAccount?.("signed-out");
      this.dropHanded();
      return;
    }
    // The service is named from the start, so a failure to reach it is never explained as Copilot's (integrations-3).
    this.setStatus({
      phase: "starting", detail: provider?.kind === "user" ? `Connecting to ${serviceHost(provider.config.baseUrl)}…` : "Connecting to Copilot…", source: this.source,
      service: provider ? { kind: provider.kind, host: serviceHost(provider.config.baseUrl) } : undefined,
    });
    let unreachable = false;
    // What that check answered, for the ready status: "Connected" only with a model list (integrations-r8-1).
    let checked: TestResult | null = null;
    try {
      // A model server on this computer (Ollama, LM Studio) is asked first whether it listens: nothing else would ask it
      // before the first request, which then waits about 24 s to fail (integrations-1). Only there: a remote host's
      // test goes through Electron's proxy settings, which may differ from the runtime's, so it can't veto a connect.
      if (provider?.kind === "user" && this.o.probeProvider && !keyNeeded(provider.config.baseUrl)) {
        checked = await this.o.probeProvider();
        const down = providerDown(checked, serviceHost(provider.config.baseUrl), true);
        if (gen !== this.gen) return;
        if (down) throw new ProviderDown(down);
      }
      const env = await this.runtimeEnv();
      if (gen !== this.gen) return;
      let client: CopilotClient;
      let login: string | undefined;
      for (let attempt = 1; ; attempt++) {
        // The sign-in goes to the runtime in one place only, and no inherited GitHub credential goes with it (runtime-env.ts).
        const runtime = new CopilotClient(runtimeClientOptions({ userData: this.o.userData, runtimePath: this.o.runtimePath, token, provider: !!provider, env }));
        // Every session of this client sends its text through the vault's redactor (PLAN.md §2 "Approvals", "The vault").
        client = this.o.redact ? redactingClient(runtime, this.o.redact) : runtime;
        // Known before it starts, so a stop() that comes meanwhile stops it too.
        this.client = client;
        await startStep(client.start(), "start");
        if (gen !== this.gen) return;
        if (provider) break;
        const auth = await startStep(client.getAuthStatus(), "auth");
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
      // Another model service than the conversation's (the user's own provider turned on or off, or changed): the
      // conversation isn't resumed there, so its history goes nowhere it wasn't sent before. A new one starts; saved
      // memory stays on disk but pauses while no GitHub account is verified (the user's provider has none: owner.ts).
      const service = serviceOf(provider);
      if (this.conversation && this.conversationService !== null && service !== this.conversationService) {
        this.o.log.info("agent.service_changed", { kind: provider?.kind ?? "copilot" });
        await this.forgetCurrent(RUNTIME_WAIT_MS);
        this.carried = [];
      }
      const lookUp = async () => !provider && token && login ? await this.o.memory?.resolveAccountId?.(token, login) ?? null : null;
      let accountId = await lookUp();
      // A failed lookup says nothing about who this is, and waking from sleep fails it while the network settles. Only
      // after these tries does it count as an owner not verified (below), which ends the conversation.
      for (const wait of provider || this.githubAccountId === null ? [] : this.o.accountRetryMs ?? ACCOUNT_RETRY_MS) {
        if (accountId !== null || gen !== this.gen) break;
        await new Promise(done => setTimeout(done, wait));
        if (gen === this.gen) accountId = await lookUp();
      }
      if (gen !== this.gen) return;
      const sameAccount = accountId !== null && accountId === this.githubAccountId;
      const changedId = accountId !== null && this.githubAccountId !== null && !sameAccount;
      const changedLogin = (this.conversation && login !== this.conversationLogin) || (this.githubLogin !== undefined && login !== this.githubLogin);
      if (!provider && (changedId || (changedLogin && this.githubAccountId === null))) await this.accountChanged();
      else if (!provider && this.githubAccountId !== null && accountId === null) {
        // A reconnect whose owner could not be verified must not resume a session that used saved memory.
        await this.accountChanged(false);
      }
      if (gen !== this.gen) return;
      if (this.memoryDeletionPending) this.forgetKept();
      if (!provider) { this.githubLogin = login; this.githubAccountId = accountId; }
      this.accountUnresolved = !provider && accountId === null;
      this.restoreHistory();
      // This connection's generation: what it says after the saved copy is invalidated again is never saved (underGen).
      const hg = this.conductorGen = this.connGen;
      // Memory works only with GitHub Copilot: under a model provider it waits, and Home says which (integrations-2).
      this.o.memory?.verifyAccount?.(accountId, memoryWaitFor(provider, "unverified"));

      let models: ModelLike[] = [];
      const admin = this.o.admin?.();
      const allowed = admin?.models.allowed;
      if (!provider) {
        models = (await startStep(client.listModels(), "models")) as ModelLike[];
      } else if (provider.kind === "user") {
        // The user's own provider serves the models they named (within the administrator's allowed list, below).
        const named = [...new Set([provider.models?.conductor, provider.models?.worker].filter((m): m is string => !!m))];
        if (!named.length) throw new Error(USER_PROVIDER_NO_MODEL);
        models = named.map(id => ({ id, name: id, capabilities: { supports: { vision: true } } }));
      } else {
        // A custom endpoint serves the models the admin named (its deployments and allowed list), or a test model.
        const named = [...new Set([admin?.models.conductor, admin?.models.worker, ...(allowed ?? [])].filter((m): m is string => !!m))];
        models = named.length
          ? named.map(id => ({ id, name: id, capabilities: { supports: { vision: true } } }))
          : [{ id: "mock-model", name: "Test model", capabilities: { supports: { vision: true } } }];
      }
      if (gen !== this.gen) return;
      const listed = models.length;
      if (allowed) models = models.filter(m => allowed.includes(m.id));
      const s = this.o.settings.get();
      const wanted = provider?.kind === "user"
        ? { conductor: provider.models?.conductor ?? provider.models?.worker ?? undefined, worker: provider.models?.worker ?? provider.models?.conductor ?? undefined }
        : { conductor: s.models.conductor ?? undefined, worker: s.models.worker ?? undefined };
      const choice = chooseModels(models, wanted);
      // The runtime's default model only where nothing limits the models (it may be one the administrator didn't allow).
      const runtimeDefault = !choice.conductor
        && mayUseRuntimeDefault(listed, { provider: !!provider, allowed, conductor: admin?.models.conductor, worker: admin?.models.worker });
      // Said by cause: the administrator's list, their pinned model with nothing listed, or models listed but none turned on.
      if (!choice.conductor && !runtimeDefault) {
        throw new Error(allowed ? (provider?.kind === "user" ? USER_PROVIDER_NOT_ALLOWED : "None of the models your administrator allows are available to this account.")
          : listed === 0 ? "Copilot lists no models for this account, and your administrator chose which model Ember uses, so Ember can't use Copilot's default one."
          : "None of the models Copilot lists are enabled for this account. Turn one on in your Copilot settings on GitHub.");
      }
      if (runtimeDefault) this.o.log.info("agent.runtime_default_model");
      this.models = models;
      // Sessions of tasks from an earlier run (Ember crashed or was killed before it could delete them).
      // Housekeeping must not hold up the first answer: sweep alongside the session setup, not before it.
      void this.sweepTaskSessions(client);

      const hands = this.o.hands;
      // Without a window system tasks still run where a target takes them (commands; SSH and WSL targets: §2.6), and
      // only then: with none (commands off, no other computer), the tools are today's (no TaskManager; start_task and
      // show_me say there is no desktop), as the prompt is. Once one can, the next request reconnects first (ask).
      const targets = this.o.targets;
      this.status = { ...this.status, conductorModel: choice.conductor, workerModel: choice.worker };
      // (And the user's own switch, Send screenshots for tasks, read as each task's worker is made: safety-privacy-7.)
      const workerVision = () => this.models.find(m => m.id === this.status.workerModel)?.capabilities?.supports?.vision === true
        && this.o.admin?.().features.screenImages !== false && this.o.settings.get().screenImages !== false;
      const takesTasks = !!hands || (!!targets && this.targetsTakeTasks());
      const carried = this.handOn(service, takesTasks);
      this.tasks = takesTasks ? new TaskManager({
        log: this.o.log.child("tasks"),
        ...(this.o.readTime ? { readTime: this.o.readTime } : {}),
        ...(this.o.taskWindow ? { taskWindow: this.o.taskWindow } : {}),
        ...(this.o.userAway ? { userAway: this.o.userAway } : {}),
        currentWindow: hands?.currentWindow ?? (() => null),
        setCards: cards => this.o.setState({ tasks: cards }),
        onView: (id, view) => this.o.showView?.(id, view),
        deleteSession: id => client.deleteSession(id),
        audit: hands?.audit ?? this.o.taskBase?.audit,
        settingsKey: this.o.settingsKey ?? this.sys.shortcuts?.settings.label,
        onFinished: task => {
          this.finishedLately = [...this.finishedLately.filter(t => t !== task && Date.now() - (t.finished ?? 0) <= CATCH_UP_MS), task].slice(-FINISHED_KEPT);
          // Copilot is to be reconnected once the tasks are done: this may have been the last one.
          if (this.reconnectAfterTasks) void Promise.resolve().then(() => { if (!this.tasksAtWork()) this.reconnectAfterTasks?.(); });
          // Requests held for a model service the user switched to go there once nothing else is under way, and with
          // none held, the switch itself is made then.
          this.releaseHeldSoon();
          this.switchWhenQuiet();
          // Stopped because its computer went (or someone there pressed Stop): it says why, not just "Stopped.".
          const why = task.status === "cancelled" ? this.stoppedWhy.get(task.id) : undefined;
          this.stoppedWhy.delete(task.id);
          // ("What did I miss?" then says why, not "you stopped it".)
          if (why) task.stopReason = why;
          const summary = why ?? task.result?.summary ?? "";
          // A task failed on a refused sign-in: is it still signed in (checkSignIn)?
          if (task.status === "failed" && summary === SIGN_IN_REFUSED) void this.checkSignIn(gen);
          const text = why ? `${task.title}: ${why}` : taskOutcome(task);
          const binding = this.taskBindings.get(task.id);
          this.taskBindings.delete(task.id);
          const mark = this.taskMarks.get(task.id);
          this.taskMarks.delete(task.id);
          this.taskDesktop.delete(task.id);
          this.taskStatus.get(task.id)?.();
          this.taskStatus.delete(task.id);
          const presenter = this.taskPresenters.get(task.id) ?? this.taskPresenter(task.id, task.goal, binding, false, task.mode !== "guide");
          this.taskPresenters.delete(task.id);
          // What it showed on its card goes to the conversation too, as words (and to the next turn's task results).
          const view = task.view ? viewText(task.view) : "";
          const said = this.underGen(hg, () => this.remember("task", view ? `${text}\n${view}` : text));
          if (summary) this.results.set(said, summary);
          const asked = tasks?.askedWith(task.id);
          if (asked && !why) this.retryWords.set(said, { ...asked, task: task.id });
          // Memory learns from what a finished task found (source `task`: context, never the user's word).
          if (this.memoryOn && task.status === "done" && summary && !why) this.o.memory?.taskDone?.(task.title, view ? `${summary}\n${view}` : summary, mark);
          // Stopped by the kill switch: its message is on screen and says it all (nothing shown or spoken per task).
          // Quitting: nothing more is shown or said.
          if ((this.stoppedByAll.delete(task.id) && task.status === "cancelled") || this.quitting) { presenter.quiet(); return; }
          // A task on another computer says where when it is spoken or notified ("On build-01: done. …", §6).
          this.o.onTaskFinished?.({ title: task.title, status: task.status, ...(task.endedBy ? { endedBy: task.endedBy } : {}), summary, text: binding?.kind === "ssh" ? `On ${binding.label}: ${text}` : text });
          this.dropAnnouncement(task.id);
          // Shown when nothing else holds the bubble (an answer, a question, "Listening…"), then it goes on its own.
          const o = OUTCOME[task.status === "done" || task.status === "cancelled" ? task.status : "failed"];
          presenter.outcome({ title: task.title, text: summary || o.empty, emotion: o.emotion, gesture: o.gesture, mood: o.mood });
          this.outcomes.set(task.id, presenter);
        },
        onRemoved: (task, byUser) => {
          this.taskMarks.delete(task.id);
          const p = this.outcomes.get(task.id);
          this.outcomes.delete(task.id);
          // The user closed the card: its result, if it hasn't shown yet, doesn't pop up afterwards.
          if (byUser && p?.waiting) p.drop();
        },
        provider: kindOf(provider),
        actionsAllowed: () => this.actionsAllowed(),
        earlier: () => this.earlierTasks,
        // No Try again while the switch waits: a task started on the service before would be refused at once
        // (tasks-approvals-c4-1); nor while its cards are handed to the next connection, this one gone (integrations-v5-2).
        // The cards before this connection go on here (tasks-approvals-r4-2).
        retryWaits: () => this.providerMoved() || this.handing !== null,
        carried,
        makeWorker: (spec, progress, update, activity) => {
          // The model service changed since this connection started: no task starts on the one before (a queued task, or
          // one a turn already under way asked for). Tasks running now finish where they started.
          if (this.providerMoved() || this.handing !== null) return refusedWorker(spec, PROVIDER_MOVED_TASK);
          // The hands of the task's target now (its state may have changed while the task waited), or why it can't take
          // the task (it ends at once, saying so). Without a targets runtime (tests, the eval): this screen's, as before,
          // and only for a task on this computer: one bound elsewhere never runs on this screen's hands (fail closed).
          const id = spec.targetId ?? "local";
          const got = targets ? targets.handsFor(id)
            : hands && id === "local" ? { ok: true as const, hands: localTargetHands(hands, this.sys) }
            : { ok: false as const, why: id === "local" ? "Ember can't work on this computer's screen here." : "Ember can't work on that computer here." };
          if (!got.ok) return refusedWorker(spec, got.why);
          const h = got.hands;
          // Its computer, as its outcome's bubble names it (a retried task gets it here, from the one handsFor).
          this.taskBindings.set(spec.id, h.binding);
          const usedDesktop = (h as TargetHands & Partial<DesktopUse>).usedDesktop;
          if (typeof usedDesktop === "function") this.taskDesktop.set(spec.id, () => usedDesktop.call(h));
          const presenter = this.taskPresenter(spec.id, spec.goal, h.binding, (targets?.othersNamed?.(id, spec.userWords ?? "") ?? []).length > 0, spec.mode !== "guide");
          // "Starting Ubuntu…" while a stopped distro boots for the task's first command: that happens while its facts are
          // read, before any run (or command window tab) exists, so the task's bubble says it.
          this.taskStatus.get(spec.id)?.();
          this.taskStatus.set(spec.id, followStatus(h.commands?.runner, text => presenter.progress(text)));
          return new Worker({
            client, log: this.o.log.child(`task-${spec.id}`), model: this.status.workerModel, runtimeDefault, vision: workerVision() && h.binding.desktop === "screen",
            reasoningEfforts: this.taskReasoningEfforts(this.models.find(m => m.id === this.status.workerModel)),
            provider: provider?.config, workDir: path.join(this.o.userData, "copilot", "empty-workdir"),
            perception: h.perception, sidecar: h.sidecar, policy: h.policy, confirmer: h.confirmer, audit: h.audit,
            settings: this.o.settings, presenter,
            // The approval mode in force (policy/autonomy.ts), read at each step: in Assisted a step or a command that
            // would ask goes to its check first, on the conversation's lighter model; in Autopilot it is announced
            // instead, but for the few commands that still ask there; Interactive and above give every scope; below
            // Interactive, none of these.
            check: () => approvalInputs(modeInForce(this.o.settings.get().approvals, this.o.admin?.() ?? null)).check,
            checkModel: this.status.conductorModel,
            autonomy: () => approvalInputs(modeInForce(this.o.settings.get().approvals, this.o.admin?.() ?? null)).scopes,
            autopilot: () => approvalInputs(modeInForce(this.o.settings.get().approvals, this.o.admin?.() ?? null)).autopilot,
            belowInteractiveHint: () => this.belowInteractiveHint(),
            lease: (key, owner, signal) => this.tasks!.lease(h.leaseKey(key), owner, signal),
            flyTo: h.flyTo, cursor: h.cursor, clipboard: h.clipboard, pointer: h.pointer, activationKey: h.activationKey,
            desk: h.desk, onDesk: h.onDesk, onProgress: progress, onUpdate: update, onActivity: activity, onUsage: (i, o) => this.recordUsage(i, o),
            limits: { turnStartMs: this.o.turnStartMs, turnSlowMs: this.o.turnSlowMs, turnSilentMs: this.o.turnSilentMs },
            inotifyUsedUp: this.o.inotifyUsedUp ?? inotifyUsedUp,
            system: h.system, target: h.binding, commands: h.commands, grantKey: h.grantKey, onAuthorized: h.onAuthorized,
            ...(this.o.emberPids ? { emberPids: this.o.emberPids } : {}),
            ...(this.o.settingsKey ? { settingsKey: this.o.settingsKey } : {}),
            // The vault fills only on this computer's own screen.
            ...(this.o.vault && id === "local" ? { vault: this.o.vault } : {}),
          }, spec);
        },
      }) : null;
      const tasks = this.tasks;
      // Turn `r` asked for, steered or stopped task `id`: once it has touched two, none of its tasks' words is that task's
      // alone, so their cards' Try again doesn't go on to another model service (StartOptions.alone, integrations-w5-1).
      const touch = (r: UserRequest | null, id: string) => {
        if (!r || !tasks) return;
        const ids = this.turnTasks.get(r) ?? new Set<string>();
        this.turnTasks.set(r, ids.add(id));
        if (ids.size > 1) for (const x of ids) tasks.shared(x);
      };
      // What the conversation's prompt may promise is fixed when it is created and kept for its resumes (§3.15).
      const caps = this.conversation && this.convoCaps ? this.convoCaps : targets?.caps() ?? NO_CAPS;
      const memory = this.memoryWanted() ? this.o.memory : undefined;
      this.memoryOn = !!memory;
      // Memory's own model calls (learning, sleep-time refinement) go on this connection, each a session with no tools.
      this.o.memory?.useModel?.(memory ? copilotOneShot({ client, model: choice.conductor, provider: provider?.config, workDir: path.join(this.o.userData, "copilot", "empty-workdir"), log: this.o.log.child("memory") }) : null);
      const routines = this.keepRoutines();
      // The extension tools as they are now (none while extensions are off): a later change reconnects between turns.
      this.extensionsGen = this.o.extensions?.generation ?? 0;
      const extensions = this.o.extensions?.forSession();
      const chatOf = { chat: this.conversationEpoch };
      this.conductorChat = chatOf;
      this.conductor = new Conductor({
        client, settings: this.o.settings, presenter: this.presenter, log: this.o.log.child("conductor"),
        reminders: this.reminders,
        ...(routines ? { routines } : {}),
        ...(extensions ? { extensions } : {}),
        stateFile: this.stateFile,
        resume: this.conversation,
        workDir: path.join(this.o.userData, "copilot", "empty-workdir"),
        model: choice.conductor, provider: provider?.config, service: kindOf(provider),
        // What the conversation reads on the screen goes with the tasks it starts in that turn (their goals may carry it).
        describeScreen: targets ? async (choice?: string) => { const turn = this.turn; const seen = await this.describeTarget(choice); if (seen.read) turn?.screen.push(seen.text); return seen.text; }
          : this.o.describeScreen ? async () => { const turn = this.turn; const seen = await this.describeThisScreen(); if (seen.read) turn?.screen.push(seen.text); return seen.text; } : undefined,
        caps,
        ...(memory ? { memory } : {}),
        ...(targets ? {
          listComputers: () => targets.describeTargets(),
          // Only a host the user's own words named, and only a button for them to click (the model never connects).
          offerConnect: (name: string) => targets.offerConnect(name, this.userWordsOf(this.turn).words ?? ""),
        } : {}),
        onUsage: (i, o) => this.recordUsage(i, o),
        onConversationContext: context => {
          if (gen === this.gen && this.status.phase === "ready") this.setConversationContext(context);
        },
        // An answer that tells the user where to turn commands on gets the button for it (once per run).
        onAnswer: text => this.underGen(hg, () => { this.endStream("done", chatOf.chat); this.o.onAnswer?.(text); if (/settings \(Commands\)|turn commands on|commands are off/i.test(text)) this.hintCommands(); }),
        onAnswerDelta: delta => this.underGen(hg, () => { this.streamDelta(delta, chatOf.chat); this.o.onAnswerDelta?.(delta); }),
        onAnswerEnd: text => this.underGen(hg, () => { this.endStream("done", chatOf.chat); this.o.onAnswerEnd?.(text); }),
        onAnswerInterrupted: () => this.underGen(hg, () => { this.endStream("interrupted", chatOf.chat); this.o.onAnswerInterrupted?.(); }),
        onTurnEnd: aborted => {
          this.underGen(hg, () => this.endStream(aborted ? "interrupted" : "done", chatOf.chat));
          // The hint a request asked for waits behind that turn's answer now (none for a turn that was stopped).
          if (this.hintOwed) { this.hintOwed = false; if (!aborted) this.hintCommands(); }
          // "Remember…" while memory can't keep it: the conversation knows it until Ember closes, and Ember says memory
          // won't, behind the answer (memory-c1-1). None for a turn that was stopped.
          const note = this.turn?.memoryNote;
          if (note && this.turn) { delete this.turn.memoryNote; if (!aborted) this.noteMemory(note); }
          this.o.onTurnEnd?.(aborted);
          this.releaseHeldSoon();
          this.switchWhenQuiet();
          this.turnChanged();
        },
        onTurnOpen: () => this.turnChanged(),
        turnStartMs: this.o.turnStartMs,
        turnSlowMs: this.o.turnSlowMs,
        turnSilentMs: this.o.turnSilentMs,
        words: this.sys.words,
        shortcuts: this.sys.shortcuts,
        ...(this.o.settingsKey ? { settingsKey: this.o.settingsKey } : {}),
        // A turn under way that went silent (a model request that never answers) is ended, and Ember says Copilot
        // didn't answer; the requests waiting behind it go with it. Only the conversation's request is given up on:
        // the tasks go on (each one's own watch decides its fate).
        onSilentTurn: () => { this.queued = []; this.turnChanged(); },
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
          this.turnChanged();
          const full = why === "not-started" && (this.o.inotifyUsedUp ?? inotifyUsedUp)();
          const reason = why === "silent" ? "turn went silent and didn't end" : full === "watches" ? "turn didn't start: inotify watches used up" : full ? "turn didn't start: inotify instances used up" : "turn didn't start";
          // Named for the service in use, never Copilot when it isn't (integrations-v1).
          const words = reconnectWords(this.serviceKind());
          const runtime = runtimeWords(this.serviceKind());
          const noWatchersWhy = full === "watches" ? watchesWhy(runtime.noWatchersWhy) : runtime.noWatchersWhy;
          const noWatchersDetail = `${noWatchersWhy} Reconnecting…`;
          if (this.tasksAtWork()) {
            this.o.log.warn("agent.reconnect_after_tasks", { why: reason });
            // (A silent turn: the conductor said Copilot didn't answer.)
            if (why === "not-started") this.presenter.fail(full ? runtime.noWatchers : words.notAnsweringAfterTasks);
            // (Set first: the status says the reconnect waits for the tasks, so settings doesn't offer one that stops them.)
            this.reconnectAfterTasks = () => { this.reconnectAfterTasks = null; this.lost(gen, reason, undefined, why === "silent" ? words.noAnswerDetail : full ? noWatchersDetail : words.notAnsweringDetail, asked, runtime.cutOffStalled); };
            this.setStatus({ phase: "error", reason: "not-answering", detail: full ? `${noWatchersWhy} ${AFTER_TASKS}` : `${words.notAnsweringNow} ${AFTER_TASKS}` });
            return;
          }
          if (why === "silent") this.lost(gen, reason, noAnswer(this.serviceKind()), words.noAnswerDetail, asked, runtime.cutOffStalled);
          else this.lost(gen, reason, full ? runtime.noWatchers : words.notAnswering, full ? noWatchersDetail : undefined, asked, runtime.cutOffStalled);
        },
        startTask: tasks ? (goal, choice) => {
          // With actions turned off by the administrator, Ember can still answer and guide, never act.
          if (this.o.admin?.().features.actions === false) return "Your organisation has turned off Ember acting in apps. Tell the user, and offer to show them how (show_me) instead.";
          // Risky steps are checked against what the user said in this turn's request (and the one it answers), not the
          // goal (the conductor may have read it off the screen). A request sent meanwhile waits for its own turn: none of
          // it goes with this task.
          const r = this.turn;
          if (!r) return "No user request belongs to this turn. Ask the user to repeat their request before starting a task.";
          const said = this.userWordsOf(r);
          // The task's computer (§2.3): the one the user's own words name, the model's choice only when their words name it
          // too, else the one Ember is set to. Its hands are asked for now: a computer that can't take the task refuses it
          // here, before anything is queued (§2.6).
          let bound: TargetHands | null = null;
          if (targets) {
            const b = targets.bind({ userWords: said.words ?? "", ...(choice !== undefined ? { choice } : {}) });
            if (!b.ok) return b.why;
            const got = targets.handsFor(b.binding.id);
            if (!got.ok) return got.why;
            bound = got.hands;
          }
          // The method the user named is part of the task: never let a goal turn "in the terminal" into another app. Earlier
          // words it was refused for in an earlier turn no longer count: what the user said since answers Ember's "how else?"
          // ("yes, use Files instead"). In the turn that refused them they still do, and the user's own words always do.
          // Where the task's computer runs commands, the terminal the user asked for is Ember's command window (§3.15).
          const commands = bound?.commands ?? null;
          if (r && said.words && !(commands && commands.capability().state !== "off")) {
            const key = refusedKey;
            // (The words before this turn's request: without a routine's steps, which come after it.)
            const base = this.userWordsOf(r, { routine: false }).words ?? r.words;
            const earlier = base.slice(0, base.length - r.words.length).split("\n").filter(l => l.trim());
            const held = [...earlier.filter(l => { const by = this.terminalRefused.get(key(l)); return !by || by === r; }), r.words].join("\n");
            const terminal = terminalRequest(this.sys.os, this.wslOn());
            if (terminal.asks.test(held.replace(terminal.refuses, " ")) && !terminal.names.test(goal)) {
              for (const l of said.words.split("\n")) this.terminalRefused.set(key(l), r);
              while (this.terminalRefused.size > 60) this.terminalRefused.delete(this.terminalRefused.keys().next().value!);
              return "The user asked to use the terminal. Ember doesn't act in terminals, and must not do the task in another app instead. Tell the user plainly that Ember can't use the terminal, and offer to guide them through it (show_me) or ask how else they want it done.";
            }
          }
          const binding = bound?.binding;
          const where = binding ? whereWords(binding) : undefined;
          // When its request was asked, for memory: a Forget since then keeps its result from being learned (memory-x8-4).
          const mark = this.conductor?.askedMark ?? this.o.memory?.asked?.();
          const t = tasks.start(goal, {
            target: this.contextFor(r, binding), userWords: said.words, agreed: said.agreed, screen: r?.screen.join("\n") || undefined,
            ...(said.commandWords !== undefined ? { commandWords: said.commandWords } : {}), ...(said.typedOnly ? { typedOnly: true } : {}),
            ...(said.checkWords !== undefined ? { checkWords: said.checkWords } : {}),
            ...(binding ? { targetId: binding.id } : {}), ...(where ? { where } : {}),
            // A "try again" of a task that did part of the work: the new worker is told so, as its card's Try again does.
            ...(said.retried?.partWay ? { partWay: true } : {}),
            // This turn's request alone (no answer to Ember's question, no earlier try's words, no routine's steps): its card's
            // Try again may start from it on another model service, unless the turn touches another task (integrations-w5-1).
            ...(said.words === r.words && !said.agreed?.length ? { alone: true as const } : {}),
          });
          touch(r, t.id);
          // That task's card goes, as its Try again's does: a press of it can't start a second attempt (tasks-approvals-r2).
          if (said.retried) tasks.dismiss(said.retried.task);
          if (binding) this.taskBindings.set(t.id, binding);
          if (mark !== undefined) this.taskMarks.set(t.id, mark);
          // Asked for in the owner's verified voice: its own questions may take a short spoken yes (owner decision of
          // 2026-11-03; voice-answer.ts TaskVoiceTrust).
          if (r?.verifiedAt !== undefined) this.o.voiceTrust?.grant(t.id, r.verifiedAt);
          this.announced.add(t.id);
          // Two tasks already at work: this one waits for one of them, and its first words say so (tasks-approvals-7).
          if (t.status === "queued") {
            const busy = tasks.list().filter(x => x.status === "running" && x.mode !== "guide").length;
            const atWork = busy === 1 ? "one task is" : busy === 2 ? "two tasks are" : `${busy} tasks are`;
            return `Task ${t.id} is waiting${where ? ` ${where}` : ""}: ${atWork} already at work, and it starts when one of them ends. Its card beside Ember says so. Tell the user that, in a few words: it hasn't begun yet.`;
          }
          return `Task ${t.id} started${where ? ` ${where}` : ""}: "${t.title}". It runs in the background and shows a card beside Ember. Tell the user you're on it, in a few words.`;
        } : undefined,
        showMe: tasks ? async goal => {
          if (!this.turn) return "No user request belongs to this turn. Ask the user to repeat their request before starting a guide.";
          // Ember points only on this screen, never at another computer's (§2.6), and only where it can see this screen:
          // a computer that can't take the guide refuses it here, before anything is queued.
          if (targets) {
            const b = targets.bind({ userWords: this.userWordsOf(this.turn).words ?? "" });
            if (!b.ok) return b.why;
            if (b.binding.kind === "ssh") return "Ember can't point at things on another computer's screen. Explain the steps in words instead.";
            if (b.binding.desktop !== "screen") return NO_GUIDE;
            const got = targets.handsFor(b.binding.id);
            if (!got.ok) return got.why;
            if (got.hands.binding.desktop !== "screen") return NO_GUIDE;
          }
          // Nothing is promised that can't be done: a window Ember can't read is one it can't point into. A window read on
          // another computer is never one to point into here (G14): the guide then finds its own on this screen.
          const read = this.turn;
          const target = read?.targetId?.startsWith("ssh:") ? {} : read?.target ?? undefined;
          const stops = this.stops;
          const why = await this.cantGuide(target);
          // Stop, or a restart or sign-out, came while the window was read: nothing starts (as the conductor refuses after Stop).
          if (stops !== this.stops || gen !== this.gen) return "The user just stopped everything. Don't start anything now; say you've stopped.";
          if (why) return `Ember can't guide here: ${why} Don't tell the user to follow Ember's pointer; explain the steps in words instead, briefly.`;
          const mark = this.conductor?.askedMark ?? this.o.memory?.asked?.();
          const t = tasks.start(goal, { target, mode: "guide" });
          if (mark !== undefined) this.taskMarks.set(t.id, mark);
          touch(read, t.id);
          this.announced.add(t.id);
          // Guides have a limit of their own: this one waits for one before it to end (nothing points yet, so no "follow me").
          if (t.status === "queued") return `Guide ${t.id} is waiting: other guides are still showing the user something, and this one starts when one of them ends. Tell the user that, in a few words; don't tell them to follow Ember's pointer yet.`;
          return `Guide ${t.id} started: Ember will point at each step and wait for the user to click. Tell the user to follow Ember, in a few words.`;
        } : undefined,
        takeReports: () => [...this.carried.splice(0), ...(tasks?.takeReports().map(report) ?? [])],
        // Taken for a request that couldn't be sent (the runtime died): kept for the next conductor after the reconnect.
        returnReports: reports => { this.carried.unshift(...reports); },
        tasks: tasks ? {
          // (Never a card from a connection on another model service: its title and words are that conversation's, integrations-v5-1.)
          list: () => tasks.list().filter(t => !this.fromElsewhere.has(t)).map(t => ({ id: t.id, title: t.title, status: t.status, detail: t.detail })),
          cancel: id => { touch(this.turn, id); const t = tasks.get(id); if (!t || (t.status !== "running" && t.status !== "queued")) return false; tasks.cancel(id); return true; },
          // What the user said for the change, as for a task started in this turn ("work" answering "Which account?").
          // (A change of plan is the user's own words: a routine run this turn doesn't steer a task.)
          steer: (id, text) => {
            if (!this.turn) return Promise.resolve(false);
            touch(this.turn, id);
            const said = this.userWordsOf(this.turn, { routine: false });
            // Changed by a request Voice Match didn't verify (typed, or another voice's): its short yeses are no longer trusted.
            if (this.turn?.verifiedAt === undefined) this.o.voiceTrust?.end(id, "steered");
            return tasks.steer(id, text, said.words, this.turn?.screen.join("\n") || undefined, said.agreed, said.commandWords, said.checkWords);
          },
        } : undefined,
      });
      await startStep(this.conductor.start(), "conversation");
      this.conversation = this.conductor.sessionId;
      this.convoCaps = caps;
      this.conversationLogin = login;
      this.conversationService = service;
      if (gen !== this.gen) return;

      this.projectModel = (system, prompt, signal, onFailure) => copilotOneShot({
        client, model: this.status.conductorModel, provider: provider?.config,
        workDir: path.join(this.o.userData, "copilot", "empty-workdir"), log: this.o.log.child("project"), purpose: "project", onFailure,
      })(system, prompt, signal);
      this.projectService = kindOf(provider);
      const where = provider?.kind === "user" ? serviceHost(provider.config.baseUrl) : null;
      // A model server on this computer answered the start's probe with a model list: connected; answered without one,
      // in use, with Test connection to say more (integrations-r8-1). A host elsewhere isn't asked until a request
      // reaches it, so it is only in use, and one with no key saved may refuse requests (integrations-r3).
      const remote = provider?.kind === "user" && keyNeeded(provider.config.baseUrl);
      const using = remote ? `Using ${where}${provider.config.apiKey ? "." : ", with no API key saved. If it needs one, save it under Model provider."}` : where ? localProviderLine(checked, where) : "";
      const signedIn = login ? `Signed in as ${login}.` : where ? using : "Connected.";
      this.setStatus({
        phase: "ready",
        detail: runtimeDefault ? `${signedIn} Using Copilot's default model: this account doesn't list models to choose from.` : signedIn,
        reason: undefined,
        defaultModel: runtimeDefault,
        login,
        source: this.source,
        models: models.map(m => {
          const reasoningEfforts = this.taskReasoningEfforts(m);
          return { id: m.id, name: m.name ?? m.id, vision: m.capabilities?.supports?.vision === true,
            ...(m.billing?.multiplier !== undefined ? { cost: costOf(m) } : {}),
            ...(reasoningEfforts.length ? { reasoningEfforts } : {}),
          };
        }),
        conductorModel: choice.conductor,
        workerModel: choice.worker,
        // What the start's check found goes with it, for first run's words (integrations-x8-2).
        service: provider ? { kind: provider.kind, host: serviceHost(provider.config.baseUrl), ...(checked ? { listed: checked.ok } : {}) } : undefined,
      });
      this.o.log.info("agent.ready", { login, conductorModel: choice.conductor, workerModel: choice.worker, models: models.length, runtimeDefault });
      // Connected: the wait before the next offline try starts short again. (Crashes count for ten minutes:
      // a runtime that dies again soon after every reconnect is given up on.)
      this.offline = [];
      this.watchHealth(client, gen);
    } catch (err) {
      if (gen !== this.gen) return;
      if (err instanceof ProviderDown) {
        // Said as the test said it, and tried again as an offline start is (15 s, 30 s, then every minute).
        this.o.log.warn("agent.provider_unreachable", { during: "start" });
        this.setStatus({ phase: "error", reason: "network", detail: err.message });
        await this.doStop();
        // Memory waits for the provider, not for a GitHub account (integrations-r5).
        if (gen === this.gen) { this.o.memory?.pauseAccount?.(memoryWaitFor(provider, "unverified")); this.retryLater(); }
        return;
      }
      const online = this.o.isOnline?.();
      const offline = online === false || unreachable || NETWORK.test(String(err));
      this.o.log.error("agent.start_failed", { err, online, unreachable, ...(err instanceof StartTimeout ? { why: "timeout", step: err.step } : {}) });
      const ctx = { source: this.source, sourceName: this.sourceName, online: offline ? false : online, proxy: this.proxy, reinstall: this.sys.words.reinstall, runtime: this.o.runtimePath };
      const reason = startErrorReason(err, ctx);
      this.setStatus({ phase: "error", detail: explainStartError(err, ctx), reason });
      // A runtime that didn't answer is hung: it is killed rather than asked to stop (which would wait on it too).
      if (err instanceof StartTimeout && this.client) { const hung = this.client; this.client = null; await hung.forceStop().catch(() => undefined); }
      await this.doStop();
      // Not connected, so no account was checked: memory waits for the next connection, and Home says so. Under a model
      // provider it waits for that, and doesn't come back when Ember reconnects (integrations-r5).
      if (gen === this.gen) this.o.memory?.pauseAccount?.(memoryWaitFor(provider, "unverified"));
      // Offline (e.g. started at login before the network or the VPN), or a problem on Copilot's side that passes (a
      // 5xx, a rate limit, a timeout): try again later rather than blaming the sign-in. Not if a newer start or stop
      // came meanwhile: a stale retry would restart a working connection.
      if ((offline || reason === "not-answering") && gen === this.gen) this.retryLater();
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
    // Its own temporary folder (0700, emptied at each connect): large tool output it saves there stays private.
    const tmp = runtimeTempEnv(clearRuntimeTemp(runtimeTempDir(this.o.userData)));
    const env: NodeJS.ProcessEnv = { ...e, ...tmp, NO_PROXY: noProxy(e.NO_PROXY), no_proxy: noProxy(e.no_proxy ?? e.NO_PROXY) };
    this.proxy = undefined;
    if (e.HTTPS_PROXY || e.https_proxy || !this.o.resolveProxy) return env;
    const resolve = this.o.resolveProxy;
    const proxyFor = async (url: string) => {
      const rule = await within(Promise.resolve().then(() => resolve(url)).catch(() => "DIRECT"), 3000);
      return proxyFromChromium(rule === "timeout" ? "DIRECT" : rule);
    };
    let p = await proxyFor("https://api.github.com/");
    let direct: string[] = [];
    const baseUrl = this.active?.config.baseUrl;
    const endpoint = baseUrl ? hostOf(baseUrl) : null;
    if (baseUrl && endpoint) {
      const own = await proxyFor(baseUrl);
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
    this.retry = setTimeout(() => { this.retry = null; void this.retryQuietly(); }, ms);
    this.retry.unref?.();
  }

  /**
   * A background try. While a model server on this computer can't be reached, it is asked first, and the status stays
   * as it is while nothing answers: no "Connecting…" and the same sentence again every minute, which a screen reader
   * would repeat and the handle would flip with (integrations-c1-2). Once it answers, Ember connects as usual. A try
   * the person asked for (Check again, a request) or a network change still says it is connecting.
   */
  private async retryQuietly(): Promise<void> {
    const p = this.providerNow();
    const probe = this.o.probeProvider;
    const waiting = this.status.phase === "error" && this.status.reason === "network";
    if (waiting && p?.kind === "user" && probe && !keyNeeded(p.config.baseUrl)) {
      const gen = this.gen;
      let down: string | null = null;
      try { down = providerDown(await probe(), serviceHost(p.config.baseUrl), true); } catch { /* unknown: connect as before */ }
      // Something else started, stopped or scheduled meanwhile: it decides.
      if (gen !== this.gen || this.retry || this.quitting) return;
      if (down) { this.o.log.info("agent.provider_still_down"); this.retryLater(); return; }
    }
    void this.launch(this.token, this.source);
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
    // A monotonic clock: a wall clock set back an hour stopped checks at rest for that hour (reliability-performance-c1-2).
    let last = performance.now();
    // Ticks at the busy cadence; at rest a tick pings only once `every` has passed since the last ping.
    this.health = setInterval(() => {
      if (gen !== this.gen || checking) return;
      if (!this.underWay() && performance.now() - last < every) return;
      last = performance.now();
      checking = true;
      void within(client.ping("ember"), Math.min(10_000, Math.max(2000, every)))
        .then(r => { if (r === "timeout") this.lost(gen, "health check timed out"); }, () => this.lost(gen, "health check"))
        .finally(() => { checking = false; });
    }, Math.min(every, BUSY_HEALTH_MS));
    this.health.unref?.();
  }

  /** An answer, a request waiting for its turn, a connection starting or a task is under way: a dead runtime would freeze it. */
  private underWay(): boolean {
    return this.starting > 0 || this.queued.length > 0 || this.presenter.busy || (this.conductor?.turnOpen ?? false) || this.tasksAtWork();
  }

  /**
   * `gen`: the connection the failure belongs to (a newer one is left alone). `says`: what the conversation
   * tells the user (always shown), when it isn't that Copilot stopped; `detail`: what settings show then.
   * `stalled`: the turn of a request the user sent on this connection never began or went silent, not a crash: it
   * isn't counted towards giving up (each one takes a request of the user's, so it never loops on its own; with the
   * file watchers used up, Ember would otherwise stop trying, and stay stopped once they're free again).
   * `cut`: what the tasks cut off by the reconnect say.
   */
  private lost(gen: number, why: string, says?: string, detail?: string, stalled = false, cut?: string): void {
    if (gen !== this.gen) return;
    this.o.log.error("agent.runtime_lost", { why });
    // Named for the service in use: under a provider the runtime is "Ember's model connection" (integrations-v1).
    const words = runtimeWords(this.serviceKind());
    const reconnecting = lostWords(this.serviceKind()).reconnecting;
    // Its tasks were cut off: they end as failed (the user stopped nothing), and the next conductor hears so.
    this.cutOff = cut ?? words.cutOff;
    // An answer cut off half-way says so, instead of vanishing.
    if (says || this.presenter.busy || why === "send failed") { this.presenter.fail(says ?? reconnecting); this.reconnectingShown = says ? null : reconnecting; }
    else this.presenter.reset();
    this.setStatus({ phase: "error", reason: says || stalled ? "not-answering" : "runtime", detail: detail ?? (says ? reconnectWords(this.serviceKind()).notAnsweringDetail : words.stopped) });
    if (!stalled) {
      const recent = this.crashes.filter(t => Date.now() - t < 10 * 60_000);
      if (recent.length >= 5) {
        this.setStatus({ phase: "error", reason: "runtime", detail: words.keepsStopping });
        // What said Ember was reconnecting says it has stopped trying, in the words it was said in (reliability-performance-c2-3).
        if (this.reconnectingShown !== null) {
          const shown = this.reconnectingShown;
          this.reconnectingShown = null;
          const said = [lostWords(false), lostWords("user")].find(w => w.reconnecting === shown) ?? lostWords(this.serviceKind());
          this.presenter.gaveUp(shown, said.gaveUpBubble);
          this.gaveUpShown = said.gaveUpBubble;
          this.problemNow(w => w.gaveUp);
        }
        this.gaveUp = true;
        void this.halt(false);
        return;
      }
      this.crashes = [...recent, Date.now()];
    }
    void this.launch(this.token, this.source);
  }

  private async sweepTaskSessions(client: CopilotClient): Promise<void> {
    try {
      const old = (await client.listSessions()).filter(m => /^ember-(?:task|project)-/.test(m.sessionId));
      await Promise.all(old.map(m => client.deleteSession(m.sessionId).catch(err => this.o.log.warn("agent.sweep_failed", { sessionId: m.sessionId, err }))));
      if (old.length) this.o.log.info("agent.swept_task_sessions", { count: old.length });
    } catch (err) {
      this.o.log.warn("agent.sweep_failed", { err });
    }
  }

  private taskReasoningEfforts(model: ModelLike | undefined): ReasoningEffort[] {
    return this.active || modelsManaged(this.o.admin?.().models) ? [] : reasoningEffortsOf(model);
  }

  /** A different model chosen in settings: the conversation switches now, tasks use it from their next start. No restart. */
  async setModels(prefer: { conductor?: string | null; worker?: string | null }): Promise<void> {
    const conductor = this.conductor;
    const gen = this.gen;
    if (this.status.phase !== "ready" || !conductor) return;
    const choice = chooseModels(this.models, { conductor: prefer.conductor ?? undefined, worker: prefer.worker ?? undefined });
    if (!choice.conductor) return;
    if (choice.conductor !== this.status.conductorModel) await conductor.setModel(choice.conductor);
    if (gen !== this.gen || conductor !== this.conductor || this.status.phase !== "ready") return;
    this.setStatus({ conductorModel: choice.conductor, workerModel: choice.worker });
    this.o.log.info("agent.models_changed", { conductorModel: choice.conductor, workerModel: choice.worker });
  }

  recordUsage(input: number, output: number): void {
    const u = this.status.usage;
    this.setStatus({ usage: { calls: u.calls + 1, inputTokens: u.inputTokens + input, outputTokens: u.outputTokens + output } });
  }

  private setConversationContext(context: ConversationContext | undefined): void {
    const before = this.status.conversationContext;
    if (context?.kind === before?.kind) {
      if (context?.kind !== "usage") return;
      if (before?.kind === "usage" && context.currentTokens === before.currentTokens && context.tokenLimit === before.tokenLimit) return;
    }
    this.setStatus({ conversationContext: context });
  }

  /** A task's own presenter: its bubble is titled as its card is and names the task, and gives way to an answer being read. */
  /** `corner`: a task that does the work, shown on its card in the corner while it works in the background ("Two bodies"). */
  private taskPresenter(id: string, goal: string, binding?: TargetBinding, othersNamed = false, corner = false): Presenter {
    const title = titleOf(goal);
    // Its bubbles say where it acts when that isn't this computer (§2.4), and on this computer too when the user's words
    // also named another one (D4.4's wrong-target guard); an announced command is spoken when replies are, naming the
    // place as its bubble's badge does ("In Ubuntu (WSL): …", follow-up F-wording).
    const where = binding ? whereWords(binding) ?? (othersNamed ? "on this computer" : undefined) : undefined;
    const place = where ? `${where.charAt(0).toUpperCase()}${where.slice(1)}: ` : "";
    const announce = this.o.onAnnounce;
    const p = new Presenter(this.o.setState, undefined, () => title, this.owner, undefined, () => this.serviceKind(), {
      task: id, corner: corner && this.o.cornerTasks === true, ...this.bubbleOptions, ...(where ? { where } : {}),
      ...(announce ? { onAnnounce: (text: string) => announce(`${place}${text.trim()} ${this.o.cancelWords?.() ?? `Press ${this.sys.shortcuts.stop.say} to cancel.`}`) } : {}),
    });
    this.taskPresenters.set(id, p);
    return p;
  }

  /**
   * The window a task starts in (§2.6, G14): the turn's context only when it was read on the task's own target; for a
   * task on this computer without one, this screen's current window (as before targets existed); otherwise none (an
   * empty target, so another computer's task never starts in this screen's window, and the reverse).
   */
  private contextFor(r: UserRequest | null, binding: TargetBinding | undefined): (WindowTarget & { app?: string }) | undefined {
    if (!binding) return r?.target ?? undefined;
    if (r?.target) return (r.targetId ?? "local") === binding.id ? r.target : {};
    return binding.id === "local" ? undefined : {};
  }

  /**
   * describe_screen with targets (§2.6): the screen of the computer the user's words name (or the model's choice, when
   * their words name it too), else the active one's; this screen's through main, another computer's through its agent.
   * `read`: it is screen text (the turn's tasks then know it was read); a refusal isn't.
   */
  private async describeTarget(choice?: string): Promise<{ text: string; read: boolean }> {
    const targets = this.o.targets!;
    const b = targets.bind({ userWords: this.userWordsOf(this.turn).words ?? "", ...(choice !== undefined ? { choice } : {}) });
    if (!b.ok) return { text: b.why, read: false };
    const remote = targets.describeScreen(b.binding.id);
    if (remote) return { text: await remote, read: true };
    if (this.o.describeScreen) return this.describeThisScreen();
    return { text: `Ember can't read the screen in this session (${this.sys.words.noScreen}). Tell the user.`, read: false };
  }

  /**
   * describe_screen of this computer's screen (a local or WSL target's), through main. While the screen is locked it
   * reads nothing and answers LOCKED_DESCRIBE: a turn still running when the screen locks would otherwise read the
   * focused window and the open windows for the model, and the refusal is Ember's own words, not screen text that the
   * turn's tasks carry as read (cross-review X9).
   */
  private async describeThisScreen(): Promise<{ text: string; read: boolean }> {
    if (this.o.screenLocked?.()) return { text: LOCKED_DESCRIBE, read: false };
    return { text: await this.o.describeScreen!(), read: true };
  }

  /**
   * Some computer can take a task without this screen's hands (§2.6): commands on (or awaiting their card) somewhere, or
   * another computer Ember knows. False without a targets runtime, and when it can't say.
   */
  private targetsTakeTasks(): boolean {
    try {
      const c = this.o.targets?.caps();
      return !!c && (c.commands || c.targets);
    } catch {
      return false;
    }
  }

  /** Windows with WSL turned on (the user's switch, and the administrator allows it): the terminal words then differ (§3.15). */
  private wslOn(): boolean {
    if (this.sys.os !== "win32" || !this.o.targets || this.o.admin?.().features.wsl === false) return false;
    return this.o.settings.get().targets?.wsl.on === true;
  }

  /**
   * The trusted line before each request's context (§2.6): where Ember is set to work and what commands can do now
   * (built by the targets runtime from local data), and what changed about commands since the conversation began (its
   * prompt is kept as it was created). "" without a targets runtime.
   */
  private trustedLine(): string {
    const targets = this.o.targets;
    if (!targets) return "";
    const was = this.convoCaps ?? NO_CAPS;
    const now = targets.caps();
    const since = was.commands === now.commands ? ""
      : now.commands ? "(Since this conversation began, the user turned on commands: tasks can now run commands in Ember's command window.)"
      : "(Since this conversation began, commands were turned off: tasks can't run commands now. Say so if the user asks for one.)";
    return [targets.activeLine().trim(), since].filter(Boolean).join(" ");
  }

  /**
   * Why Ember can't point at controls in the window the user was in (null: it can): the window can't be read through
   * accessibility (it exposes nothing, or the helper is missing), it's private, or it doesn't answer. Without a known
   * window (the desktop) the guide finds its own.
   */
  private async cantGuide(target: (WindowTarget & { app?: string }) | undefined): Promise<string | null> {
    const perception = this.o.hands?.perception;
    if (!target?.title || !perception || typeof perception.read !== "function") return null;
    const seen = await within(perception.read(target).catch(() => null), 4000);
    if (seen === "timeout") return "the window doesn't answer right now.";
    if (!seen) return "Ember can't read that window (its desktop controls aren't available here).";
    if (seen.blocked) return "that window is private (a password prompt, or on the never-look list).";
    if (!seen.window) return seen.busy ? "the window doesn't answer right now." : "Ember can't read that window (it exposes no accessibility information).";
    return null;
  }

  /** The endpoint in force now, as HostOptions.provider says it (a fixed config is the organisation's); null: Copilot. */
  private providerNow(): ActiveProvider | null {
    const p = this.o.provider;
    if (!p) return null;
    if (typeof p !== "function") return { kind: "admin", config: p };
    return p();
  }

  /** The words errors use for the service in use (this connection's, or before one starts, the one in force). */
  private serviceKind(): ServiceKind {
    return kindOf(this.active ?? this.providerNow());
  }

  /** Checks, once the current turn of events settles, whether the held requests can go (releaseHeld). */
  private releaseHeldSoon(): void {
    if (this.held.length) void Promise.resolve().then(() => this.releaseHeld());
  }

  /**
   * Nothing a switch of model service would cut off: no start under way, no request waiting for its turn, no task
   * running or queued, and no conversation turn under way or owed as the runtime's own events say. Not the bubble's
   * state: a notice may cover a streaming answer (the hold's own), and after a Stop the runtime never confirms, the
   * bubble may still look busy though the turn is over from Ember's side (TurnWatch.clear).
   */
  private quietForSwitch(): boolean {
    return this.starting === 0 && !this.queued.length && !this.tasksAtWork() && !(this.conductor?.turnOpen ?? false);
  }

  /** Drops the requests held for a new model service (Stop, quit): none of them is sent, and the notice goes. */
  private dropHeld(): void {
    const had = this.held.length > 0;
    this.held = [];
    // A release under way ends with them (a connect that hangs leaves nothing holding later requests).
    this.releaseGen++;
    this.releasing = false;
    if (this.heldTimer) { clearTimeout(this.heldTimer); this.heldTimer = null; }
    if (had) this.noticeBoard.clear();
    this.turnChanged();
  }

  /**
   * Sends the requests held for a new model service once nothing is under way any more: Ember reconnects to the service
   * in force, then asks each in order. A Stop pressed meanwhile drops them (their epoch is old). Nothing goes to the
   * service before.
   */
  private async releaseHeld(): Promise<void> {
    if (this.quitting || this.releasing || !this.held.length) return;
    if (!this.quietForSwitch()) {
      // A turn's end reaches the runtime's events a moment after its answer: looked at again shortly, until it is quiet.
      if (!this.heldTimer) this.heldTimer = setTimeout(() => { this.heldTimer = null; void this.releaseHeld(); }, HELD_RECHECK_MS);
      return;
    }
    this.releasing = true;
    // (No longer only held: Ember connects to the new service for them.)
    this.turnChanged();
    const gen = ++this.releaseGen;
    try {
      // The connect to the new service, for at most CONNECT_WAIT_MS: one that hangs doesn't hold the requests for ever.
      // They go on down the usual path, which waits a little more and then says Ember is still connecting.
      if (this.providerMoved()) {
        this.keepCards = true;
        await Promise.race([this.launch(this.token, this.source), sleep(this.o.connectWaitMs ?? CONNECT_WAIT_MS)]);
      }
      // Each held request, in order, then any asked meanwhile (they queued behind, `releasing`), until none is left. A
      // Stop meanwhile ends the release (dropHeld): nothing more is sent.
      while (this.held.length && !this.quitting && gen === this.releaseGen) {
        const h = this.held.shift()!;
        if (!this.held.length) this.noticeBoard.clear();
        this.o.log.info("agent.held_released", { left: this.held.length });
        // `released`: this one goes through; any other asked while it is sent queues behind. (Still answering meanwhile,
        // for Home, until it is sent or dropped.)
        this.waitingAsks++;
        try { await this.ask(h.text, h.context, h.epoch, { ...h.how, released: true }); } finally { this.waitingAsks--; this.turnChanged(); }
      }
    } finally {
      if (gen === this.releaseGen) {
        this.releasing = false;
        // One held while it finished (or a release that couldn't go now): looked at again.
        if (this.held.length) this.releaseHeldSoon();
      }
    }
  }

  /** The endpoint in force is no longer the one this connection started with. */
  private providerMoved(): boolean {
    return providerKey(this.providerNow()) !== this.startedProvider;
  }

  /**
   * The model service in force may have changed (main calls this when the user's own provider is turned on or off,
   * edited, or its key saved or removed): Copilot is reconnected now when nothing would be cut off (not connected, or
   * ready and idle), so the next request goes to the service in force. Otherwise the status says the switch waits, and
   * Ember reconnects as soon as the turn and the tasks under way are done (switchWhenQuiet; a request asked meanwhile is
   * held for it), and they finish where they started. Resolves to the phase once the reconnect is done, or null when
   * nothing reconnects now.
   */
  providerChanged(): Promise<AgentPhase> | null {
    this.checkHistoryService();
    if (this.quitting) return null;
    // Put back as it was before the switch could happen: nothing waits any more.
    if (!this.providerMoved()) { this.waitForSwitch(false); return null; }
    if (this.status.phase === "ready" && (!this.quietForSwitch() || this.held.length > 0)) {
      // (A connect already under way reads the service in force as it starts: nothing waits for it.)
      if (this.starting === 0) this.waitForSwitch(true);
      return null;
    }
    this.o.log.info("agent.provider_changed", { kind: this.providerNow()?.kind ?? "copilot" });
    return this.launch(this.token, this.source);
  }

  /** Says in the status whether a switch of model service waits for what is under way (AgentStatus.switchPending). */
  private waitForSwitch(on: boolean): void {
    if (this.switchWaits === on) return;
    this.switchWaits = on;
    this.setStatus({});
    // A failed card's Try again waits with it (tasks-approvals-c4-1).
    this.tasks?.refresh();
  }

  /**
   * The model service in force moved while a turn or a task was under way (providerChanged put the reconnect off): once
   * nothing is, Ember reconnects to it now, not at the next request, so its status (and first run's sign-in step, Home and
   * Settings with it) names the service in force, never the one before for good (first-run-v4-1). Requests held for the
   * new service go through releaseHeld instead, which reconnects first.
   */
  private switchWhenQuiet(): void {
    void Promise.resolve().then(() => {
      if (this.quitting || this.held.length || this.releasing || this.status.phase !== "ready" || !this.providerMoved() || !this.quietForSwitch()) return;
      this.o.log.info("agent.provider_changed", { kind: this.providerNow()?.kind ?? "copilot", after: "quiet" });
      // The tasks it waited for keep their cards (tasks-approvals-r4-2).
      this.keepCards = true;
      void this.launch(this.token, this.source);
    });
  }

  /**
   * Nothing a reconnect would cut off: no start under way, no answer or guide step, no request waiting for its turn,
   * no task running or queued. A sign-in due for renewal waits for this before it is renewed and Copilot reconnected
   * with it (review #138, cross-review X11).
   */
  /** Whether this conversation's conductor was given memory (memoryWanted() when it started). */
  private memoryOn = false;
  /** The extensions' generation this conversation's conductor was given (ExtensionsService.generation when it started). */
  private extensionsGen = 0;

  /** Whether this conversation's conductor was given routines (routinesWanted() when it started). */
  private routinesOn = false;
  /** The kept reminders were put back this run (once: a reconnect doesn't put back what already fired). */
  private remindersRestored = false;

  /** Routines are on, agreed to, and allowed (settings.get() has the administrator's switch applied). */
  private routinesWanted(): boolean {
    const r = this.o.settings.get().routines;
    return !!this.o.routines && r.on && r.consent.version >= FEATURE_CONSENT_VERSION.routines;
  }

  /**
   * Follows the routines switch as a conversation starts: on, reminders are kept in routines.json (and the ones kept
   * from the last run come back, once); off, they are kept in memory only. The book to give the conductor, or none.
   */
  private keepRoutines(): RoutineBook | undefined {
    const book = this.routinesWanted() ? this.o.routines : undefined;
    this.routinesOn = !!book;
    if (!book) {
      this.reminders.setOnChange(null);
      // Turned off after this run's reminders were kept: the file lets go of them (they last in memory only now).
      // Left there, one told this run would be put back at the next start with routines on and told again, as missed.
      if (this.remindersRestored && this.o.routines) {
        this.remindersRestored = false;
        try { this.o.routines.setReminders([]); } catch (err) { this.o.log.warn("agent.reminders_not_kept", { err }); }
      }
      return undefined;
    }
    try {
      if (!this.remindersRestored) { this.remindersRestored = true; this.reminders.restore(book.reminders()); }
      this.reminders.setOnChange(list => { try { book.setReminders(list); } catch (err) { this.o.log.warn("agent.reminders_not_kept", { err }); } });
      book.setReminders(this.reminders.list());
    } catch (err) {
      this.o.log.warn("agent.routines_unreadable", { err });
    }
    return book;
  }

  /** Memory is on, agreed to, and allowed (settings.get() has the administrator's switch applied). */
  private memoryWanted(): boolean {
    const m = this.o.settings.get().memory;
    return !!this.o.memory && (this.o.memory.accountReady?.() ?? true) && m.on && m.consent.version >= FEATURE_CONSENT_VERSION.memory;
  }

  get idle(): boolean {
    return this.starting === 0 && !this.presenter.atWork && !this.queued.length && !this.tasksAtWork();
  }

  /** A foreground conversation is generating or waiting; background results keep their cards meanwhile. */
  get answerOpen(): boolean {
    return !!this.queued.length || (this.conductor?.turnOpen ?? false);
  }

  /**
   * Whether the conversation is answering a request, from every way one is asked (Home, the Ask box, voice): "thinking"
   * from its asking until its turn ends, it is stopped or dropped (sent and owed its turn, its turn under way, held for a
   * new model service, or waiting for a connection), "slow" while the bubble says Ember is still waiting for the model
   * service. Home's composer and status panel say this rather than guess it from the conversation's lines (home-c1-1).
   */
  get conversationTurn(): ConversationTurn {
    if (!this.answerOpen && !this.held.length && !this.waitingAsks) return "idle";
    // Held for the new model service while a task finishes, with nothing answering: never "thinking" (home-r4-4).
    if (this.held.length && !this.answerOpen && !this.releasing && !this.waitingAsks) return "held";
    return this.presenter.stalledNow ? "slow" : "thinking";
  }

  /**
   * Tells Home when conversationTurn changed (called wherever what it reads may have). `ended`: a Stop is ending the
   * turn Home was told of (said first, so the bubble's change as it stops isn't told as "thinking" again). Its end is
   * told once what Ember does as it ends has been (a microtask later): the reply's or the problem's line, and Stop
   * everything's word, reach Home first, so Home never says how it went before they come (home-r2-1: a model error's
   * "idle" came before its Problem line, and Home said no reply was written). An "idle" that is over by then (a request
   * between two waits) is never told.
   */
  private turnChanged(ended?: ConversationTurnEnd): void {
    if (ended && this.turnTold !== "idle") this.turnEnd = ended;
    const now = this.conversationTurn;
    if (now === this.turnTold) return;
    if (now !== "idle") {
      if (this.turnEnd) return;
      this.turnTold = now;
      this.o.onConversationTurn?.(now);
      return;
    }
    if (this.turnEnding) return;
    this.turnEnding = true;
    queueMicrotask(() => {
      this.turnEnding = false;
      if (this.conversationTurn !== "idle" || this.turnTold === "idle") return;
      this.turnTold = "idle";
      const end = this.turnEnd;
      this.turnEnd = undefined;
      if (end) this.o.onConversationTurn?.("idle", end); else this.o.onConversationTurn?.("idle");
    });
  }

  /** Tasks running or waiting to run. */
  private tasksAtWork(): boolean {
    return this.tasks?.list().some(t => t.status === "running" || t.status === "queued") ?? false;
  }

  /** No conversation turn is under way or owed: a request answered here can't cut into one. */
  private betweenTurns(): boolean {
    return !this.presenter.busy && !this.queued.length;
  }

  /**
   * Answers `text` with Ember's own `reply`, without a Copilot turn: kept in the conversation, shown and spoken as an
   * answer, and (asked by voice) followed by the usual follow-up window.
   */
  private answerLocally(text: string, reply: string, how: { voiceUnchecked?: boolean; suggested?: boolean; overEmber?: boolean; heardId?: number; spoken?: boolean; manual?: true }): void {
    // The request is kept as it was asked: heard unchecked, a chosen suggestion and a heard one keep what they were (a later
    // "yes please" that reads back over this line must not take Ember's suggested words, or words heard from the speakers,
    // for the user's own: review of #145).
    const asked = this.remember("you", text, how.heardId);
    if (how.voiceUnchecked) this.voiceUnchecked.add(asked);
    if (how.suggested) this.suggested.add(asked);
    if (how.overEmber) this.overEmber.add(asked);
    this.interruptAnswer();
    this.o.onTurnStart?.({ text, spoken: !!how.spoken, ...(how.manual ? { manual: true } : {}) });
    this.presenter.say(reply);
    this.o.onAnswer?.(reply);
    this.o.onTurnEnd?.(false);
  }

  /**
   * Memory's question (app/main/memory/questions.ts): said as Ember's own line, shown and spoken like an answer, only
   * while nothing is under way and Ember is connected. False when it can't be said now.
   */
  sayFromMemory(text: string): boolean {
    if (!this.idle || !this.betweenTurns() || this.status.phase !== "ready") return false;
    this.remember("ember", text);
    this.o.onTurnStart?.({ text: "", spoken: false });
    this.presenter.say(text);
    this.o.onAnswer?.(text);
    return true;
  }

  /** The tasks on cards now, and those that finished lately whose cards have gone (finishedLately). */
  private tasksLately(): Task[] {
    const now = this.tasks?.list() ?? [];
    return [...now, ...this.finishedLately.filter(t => !now.includes(t))];
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
  /**
   * `how.voiceUnchecked`: heard where Ember can't tell the user from its speakers (UserRequest.voiceUnchecked).
   * `how.overEmber`: heard over Ember's own voice (UserRequest.overEmber).
   * Resolves true when the request is answered (here, or by a conductor turn), false when it was dropped or went
   * unanswered (stopped, not connected, never sent): main's acknowledgement is then not said.
   */
  /**
   * `how.onSent`: called once the request goes to Copilot (never for one answered here, dropped, left unsent, or queued
   * behind a turn under way), just before it is sent: main's acknowledgement waits for it, so "On it." never comes
   * while the request still waits, nor over another turn's answer.
   */
  async ask(text: string, context?: { target: WindowTarget & { app?: string }; text: string; targetId?: TargetId } | null, epoch = this.stopEpoch, how: { voiceUnchecked?: boolean; verified?: boolean; spoken?: boolean; manual?: true; short?: boolean; onSent?: () => void; released?: boolean; suggested?: boolean; heardId?: number; replaces?: boolean; overEmber?: boolean } = {}): Promise<boolean> {
    // A request that waits (for a silent turn's end, or a connection) is answering, for Home, until it is queued or
    // dropped: never a moment's "idle" between its waits and its turn (home-r2-2: Home took that for its turn's end, and
    // said no reply was written as the reply came).
    const waiting = { counted: false };
    try { return await this.asking(text, context, epoch, how, waiting); } finally { if (waiting.counted) { this.waitingAsks--; this.turnChanged(); } }
  }

  /** ask() itself. `waiting.counted`: it counts in waitingAsks, from its first wait until it is queued (or ask ends). */
  private async asking(text: string, context: Parameters<AgentHost["ask"]>[1], epoch: number, how: NonNullable<Parameters<AgentHost["ask"]>[3]>, waiting: { counted: boolean }): Promise<boolean> {
    if (epoch !== this.stopEpoch) return false;
    if (this.stopsNow(text, how)) return true;
    // Said over a reply still on its way (a conversation): that reply goes, and this one is answered knowing why.
    const cutIn = how.replaces === true && (this.conductor?.turnOpen ?? false);
    if (cutIn) {
      // (Answering all along, for Home, while the reply it cuts in on ends: home-r2-2.)
      if (!waiting.counted) { waiting.counted = true; this.waitingAsks++; }
      this.queued = [];
      try { await this.conductor?.replaceTurn(); } catch (err) { this.o.log.warn("agent.replace_turn_failed", { err }); }
      if (epoch !== this.stopEpoch) return false;
    }
    // Its turn begins at once only when no turn was under way or waiting as it was asked (before its own "Thinking…"):
    // otherwise main's acknowledgement would be said over the earlier turn's answer, so one queued behind gets none.
    const first = this.betweenTurns();
    // The approval mode by its name, "work without asking" or "ask me first again": set here and never by the
    // conductor (it has no tool for it). To a mode that asks less only by voice, from anyone heard while Voice Match is
    // off and only from the owner's verified voice while it is on, never over Ember's voice, and only with that mode's
    // card agreed to in Home; to one that asks more, from anyone (autonomy-intent.ts).
    const mode = this.o.autonomy ? modeIntent(text) : null;
    if (mode && this.o.autonomy) {
      // A suggestion pressed is no one's voice: as typed.
      const spoken = how.spoken === true && !how.suggested;
      let plan: ReturnType<typeof planModeIntent> = { reply: AUTONOMY_NOT_SAVED };
      let saved = true;
      try {
        plan = planModeIntent(mode, this.o.autonomy.state(), { spoken, verified: how.verified === true, short: how.short === true, overEmber: how.overEmber === true });
        if (plan.set !== undefined) saved = this.o.autonomy.set(plan.set, { via: spoken ? "voice" : "typed", verified: how.verified === true });
        if (plan.open) this.o.autonomy.open(plan.open.mode, plan.open.card);
      } catch (err) { saved = false; this.o.log.warn("agent.autonomy_not_saved", { err }); }
      this.o.log.info("agent.autonomy_switch", { intent: mode.kind, ...(mode.kind === "to" || mode.kind === "off" ? { mode: mode.mode } : {}), set: plan.set ?? null, saved, opened: !!plan.open, verified: how.verified === true });
      // Said only once it is so: a change that couldn't be saved or recorded says that instead (review of #127).
      this.answerLocally(text, saved ? plan.reply : AUTONOMY_NOT_SAVED, how);
      return true;
    }
    // Memory's own words (app/main/memory/learning.ts): "get to know me" and its answers, the answer to Ember's own
    // question, "forget that". Answered here, never by the conductor; a fact is the user's only if Ember heard them.
    const remembered = this.betweenTurns() ? this.o.memory?.intent?.(text, { own: !how.voiceUnchecked }) ?? null : null;
    if (remembered) {
      this.o.log.info("agent.memory_local");
      this.answerLocally(text, remembered, how);
      return true;
    }
    // "Read it out" (the suggestion under an answer that wasn't said, typed or spoken): the last answer, said once.
    // No setting changes, and the answer isn't written into the conversation a second time (voice-speaking-r6-1).
    // Never while a question is up: reading an answer over it would cut the question's own voice, and "allow" said
    // over Ember's voice doesn't count, so the request is the conversation's as any other is then (voice-speaking-x7-4).
    if (readOutRequest(text) && this.betweenTurns() && !this.confirmer?.waiting) {
      const last = this.lastAnswer({ readable: true });
      let said: boolean | "no-voice" = false;
      try { said = !!last && (this.o.readOut?.(last) ?? false); } catch (err) { this.o.log.warn("agent.read_out_failed", { err }); }
      this.o.log.info("agent.read_out", { said, answer: !!last });
      if (said !== true) this.answerLocally(text, !last ? READ_OUT_REPLY.none : said === "no-voice" ? READ_OUT_REPLY.noVoice : READ_OUT_REPLY.silent, how);
      // No line and no turn of the model's come for it: Home is told it was answered, or its composer says
      // "Thinking…" for good (voice-speaking-x7-2). With a turn told and not yet over, that turn's end says it.
      else if (this.turnTold === "idle" && !this.turnEnding) {
        this.o.onConversationTurn?.("thinking");
        this.o.onConversationTurn?.("idle", "read-out");
      }
      return true;
    }
    // "Ember?", "status?", "what are you doing?": answered at once from the tasks' own state, with no Copilot turn (it
    // works offline and costs no request). Only between turns: a request waiting for its turn is the conductor's.
    // "Just show me" / "read them out again": the switch for reading results aloud, set here (Settings › Voice has it).
    const results = resultsRequest(text);
    if (results && this.betweenTurns()) {
      let saved = true;
      try { this.o.settings.update({ speakResults: results === "loud" }); } catch (err) { saved = false; this.o.log.warn("agent.results_not_saved", { err }); }
      // Said from what happens now: the switch as applied (the organisation's policy too) and whether Ember speaks at all.
      let on = false;
      try { on = this.o.settings.get().speakResults; } catch { /* unread: said as not read out */ }
      const speaks = this.o.health?.().speaks ?? false;
      this.o.log.info("agent.results_switch", { on, saved, speaks });
      this.answerLocally(text, resultsReply(results, { saved, on, speaks }), how);
      return true;
    }
    // "Systems check": Ember's report on itself, which works when Copilot doesn't.
    if (healthQuestion(text) && this.betweenTurns()) {
      const health: Health = {
        phase: this.status.phase, ...(this.status.detail ? { detail: this.status.detail } : {}),
        mic: "off", speaks: false, ...this.o.health?.(), tasks: this.tasks?.list().filter(t => t.status === "running" || t.status === "queued").length ?? 0,
      };
      this.o.log.info("agent.health_local", { phase: health.phase, mic: health.mic });
      this.answerLocally(text, healthReply(health), how);
      return true;
    }
    // "What did I miss?": the tasks that finished lately, from Ember's own record.
    if (catchUpQuestion(text) && this.betweenTurns()) {
      this.o.log.info("agent.catch_up_local");
      this.answerLocally(text, catchUpReply(this.tasksLately(), Date.now()), how);
      return true;
    }
    const status = statusQuestion(text);
    if (status && this.betweenTurns()) {
      const tasks = this.tasksLately();
      this.o.log.info("agent.status_local", { kind: status, running: tasks.filter(t => t.status === "running").length });
      this.answerLocally(text, statusReply(status, tasks, Date.now(), id => this.tasks?.holdUp(id)), how);
      return true;
    }
    // The conversation's last turn went silent and is being ended (a moment): the request waits to see whether the
    // conversation goes on, or Copilot is being reconnected (then it waits for that below).
    const ending = this.conductor?.ending;
    if (ending) {
      if (!waiting.counted) { waiting.counted = true; this.waitingAsks++; }
      this.presenter.userPrompt(text);
      await Promise.race([ending, this.stopSignal.promise]);
      if (epoch !== this.stopEpoch) { this.presenter.reset(); return false; }
    }
    // Offline when it last tried (a retry is waiting): the network may be back, so it tries now and the question waits for it.
    if (this.status.phase === "error") this.retryNow();
    // No window system, and no computer could take a task when the conversation's tools were made, but one can now (the
    // user turned commands on, or added a computer): Copilot is reconnected first, so the conversation (resumed as it
    // was) has the task tools. Never while a turn or a task is under way (the reconnect would cut it off).
    if (this.status.phase === "ready" && !this.tasks && !this.o.hands && this.targetsTakeTasks() && !this.presenter.busy && !this.queued.length) {
      this.o.log.info("agent.tasks_available");
      void this.launch(this.token, this.source);
    }
    // The model service in force changed since this connection started (the user's own provider turned on or off, or
    // edited): reconnected first, so this request goes to the one in force now. Tasks finish on the service they started
    // with; while they (or a turn) are under way, the request is held for the new service instead.
    if (!how.released && (this.held.length > 0 || this.releasing || (this.status.phase === "ready" && this.providerMoved() && !this.quietForSwitch()))) {
      // A turn or a task is under way on the service before: this request goes to the one in force now, never to that
      // one. It waits (saying so) until they are done, then Ember reconnects and sends it (releaseHeld). One asked while
      // others wait goes behind them, in order. The notice is the notice board's, so the conversation's own state (a
      // turn still streaming) is left as it is.
      this.o.log.info("agent.request_held", { kind: this.providerNow()?.kind ?? "copilot", waiting: this.held.length });
      this.held.push({ text, context, epoch, how });
      this.turnChanged();
      // It stays for as long as anything is held (no timer): it goes when they are sent or dropped.
      this.noticeBoard.post({ title: PROVIDER_SWITCH_TITLE, thought: PROVIDER_SWITCH_WAIT, actions: [], mood: "attention" });
      this.releaseHeldSoon();
      return true;
    }
    if (this.status.phase !== "starting" && this.providerMoved()) {
      this.o.log.info("agent.provider_changed", { kind: this.providerNow()?.kind ?? "copilot" });
      void this.launch(this.token, this.source);
    } else if (this.status.phase === "ready" && (this.memoryWanted() !== this.memoryOn || this.routinesWanted() !== this.routinesOn) && this.idle) {
      // Memory was turned on or off since the conversation's tools were made: Copilot is reconnected first (the
      // conversation resumed as it was), so the tools match the switch. Only between turns, with no task under way.
      this.o.log.info("agent.memory_changed", { on: this.memoryWanted(), routines: this.routinesWanted() });
      void this.launch(this.token, this.source);
    } else if (this.status.phase === "ready" && this.o.extensions && this.o.extensions.generation !== this.extensionsGen && this.idle) {
      // An extension was installed, changed, turned on or off, or stopped: the same reconnect, so the tools match.
      this.o.log.info("agent.extensions_changed");
      void this.launch(this.token, this.source);
    }
    // Still connecting (just started, reconnecting, or the session still opening): wait a little rather than say "not connected".
    if (this.starting > 0 || this.status.phase === "starting") {
      if (!waiting.counted) { waiting.counted = true; this.waitingAsks++; }
      this.presenter.userPrompt(text);
      await Promise.race([this.settled(), sleep(this.o.connectWaitMs ?? CONNECT_WAIT_MS), this.stopSignal.promise]);
      // Stop was pressed while it waited: the request is dropped at once, not sent once connected.
      if (epoch !== this.stopEpoch) { this.presenter.reset(); return false; }
    }
    if (!this.conductor?.sessionId || this.status.phase !== "ready") {
      const signedOut = this.status.phase === "signed-out";
      // Signed out while the user's own provider waits for its card: agreeing is the way on, not Copilot (integrations-r3-1).
      const waitingFor = signedOut ? this.o.providerWaiting?.() ?? null : null;
      const why = waitingFor ? providerWaitingWhy(waitingFor) : signedOut ? "Connect your GitHub account in settings, then ask me again." : this.status.detail;
      const title = waitingFor ? PROVIDER_WAITING_TITLE : this.status.phase === "starting" ? stillConnectingTitle(this.status.service?.kind) : noticeTitle(signedOut ? "signed-out" : this.status.reason ?? "other", this.status.service?.kind);
      const restart = this.status.reason === "policy" && !!this.o.policyHeld?.();
      // Not signed in: signing in is what to do next (as the greeting says it), not a problem. Settings is offered only
      // where it can help: not while Ember waits for the network or reconnects by itself.
      const selfMending = !signedOut && (this.status.phase === "starting" || this.status.reason === "network" || this.status.reason === "not-answering");
      const actions = restart ? [{ id: "ui:restart", label: "Restart Ember" }] : selfMending ? [] : [{ id: "ui:settings", label: "Open settings" }];
      this.presenter.notice({ title, text: why, actions, ...(signedOut ? { mood: "attention" as const } : {}) });
      this.unreachable = why;
      // The conversation section keeps what was asked, and why it went unanswered.
      const asked = this.remember("you", text, how.heardId);
      if (how.voiceUnchecked) this.voiceUnchecked.add(asked);
      if (how.suggested) this.suggested.add(asked);
      if (how.overEmber) this.overEmber.add(asked);
      this.remember("problem", `${title}: ${why}`);
      return false;
    }
    // The connection this request goes out on: if sending fails, that one is replaced (not a newer one).
    const gen = this.gen;
    const chat = this.conversationEpoch;
    const asked = this.remember("you", text, how.heardId);
    if (how.voiceUnchecked) this.voiceUnchecked.add(asked);
    if (how.suggested) this.suggested.add(asked);
    if (how.overEmber) this.overEmber.add(asked);
    // Its turn may start only after the one running now: it takes this context then (see conversationEvent).
    const request: UserRequest = {
      target: context?.target ?? null, words: text, screen: context?.text ? [context.text] : [], ...(context?.targetId ? { targetId: context.targetId } : {}),
      ...(how.spoken ? { spoken: true } : {}),
      ...(how.manual ? { manual: true } : {}),
      ...(how.voiceUnchecked ? { voiceUnchecked: true } : {}), ...(how.suggested ? { suggested: true } : {}), ...(how.overEmber ? { overEmber: true } : {}),
      ...(how.spoken && how.verified ? { verifiedAt: Date.now() } : {}),
    };
    // "Remember…" (or "forget…" with more) while memory can't: the conversation takes it, and Ember says after the answer
    // what memory won't do.
    const note = this.o.memory?.rememberNote?.(text) ?? null;
    if (note) request.memoryNote = note;
    // Asked again: words a task was refused for earlier hold again (also when Ember asks something before the task).
    for (const l of text.split("\n")) this.terminalRefused.delete(refusedKey(l));
    // A terminal or a command asked for while commands are off by the user's switch: Ember offers the switch (once),
    // when this request's turn ends (hintCommands checks then whether commands are off by the user's switch).
    const terminal = terminalRequest(this.sys.os, this.wslOn());
    if (terminal.asks.test(text.replace(terminal.refuses, " ")) || /\b(?:run|execute|type)\s+(?:(?:a|an|the|this|that|these|those|some)\s+)?commands?\b/i.test(text)) this.hintOwed = true;
    // Owed its turn from here, no longer waiting; and a Stop before it doesn't end that turn (home-c2-2).
    if (waiting.counted) { waiting.counted = false; this.waitingAsks--; }
    this.turnEnd = undefined;
    this.queued.push(request);
    this.queued.splice(0, this.queued.length - MAX_QUEUED);
    this.turnChanged();
    try {
      if (first) how.onSent?.();
      await this.conductor.ask(text, context?.text, [this.trustedLine(), ...(how.replaces ? [CONVERSATION_LINE] : []), ...(cutIn ? [CUT_IN_LINE] : [])].filter(Boolean).join(" "), !how.voiceUnchecked, prompt => { request.prompt = prompt; });
    } catch (err) {
      // Never sent: no turn of its own will come (nor its hint).
      this.hintOwed = false;
      this.queued = this.queued.filter(r => r !== request);
      this.turnChanged();
      // A request of a chat that was started over meanwhile: its failure is the old chat's, not the connection's.
      if (err instanceof ConnectionLost) { if (chat === this.conversationEpoch) this.lost(gen, "send failed"); return false; }
      throw err;
    }
    return true;
  }

  /**
   * Whose a Projects answer is: the signed-in account, or the provider's whole config with its key (workspaceOwners'
   * holder). An answer goes to no other.
   */
  projectWorkspaceScope(): string | null {
    return this.projectOwners()?.holder ?? null;
  }

  /** Whose the saved workspaces are: the signed-in account or the model service, never its key (integrations-r9-3). */
  projectLibraryScope(): string | null {
    return this.projectOwners()?.library ?? null;
  }

  private projectOwners(): { library: string; holder: string } | null {
    if (this.status.phase !== "ready" || this.providerMoved()) return null;
    return workspaceOwners(this.providerNow(), this.githubAccountId);
  }

  /** Project commands use the same classifier, review card, runner and audit as desktop tasks. */
  async runProjectCommand(command: string, folder: string, service: CommandService, signal: AbortSignal, projectFolderCurrent: () => boolean): Promise<string> {
    const base = this.o.taskBase;
    if (!base || service.binding.kind !== "local") return "Commands are unavailable on this computer.";
    const isOver = () => signal.aborted || this.status.phase !== "ready" || this.o.screenLocked?.() === true;
    const result = await runCommandTool({ target: service.binding.id, command, why: "You entered this command in Project work." }, {
      task: {
        id: `project-${randomUUID()}`, title: "Project command", commandWords: () => command,
        agreed: () => [], tainted: () => false, taint: () => undefined, readFrom: () => [],
      },
      service, confirmer: base.confirmer, presenter: this.presenter, signal, isOver, projectFolderCurrent,
      log: this.o.log.child("project-command"), size: () => DEFAULT_TERM_SIZE,
      emberPids: () => this.o.emberPids?.() ?? [],
      state: { cwd: folder, downloaded: new Set(), running: false },
      audit: entry => {
        try { base.audit.write(entry); } catch (err) { if (!afterTheStep(entry)) throw err; }
      },
    });
    if (isOver()) return "Project command stopped.";
    if (result.resultType === "success") return "Command finished. See the command window for output.";
    const first = result.textResultForLlm.split("\n", 1)[0];
    return first.replace(/\s+(?:Don't|Finish the task).*$/, "").slice(0, 320);
  }

  /**
   * The model's answer to a project request, or null when it was stopped or can't be asked now. A call the model
   * service refused or couldn't finish throws ProjectModelError with one sentence for the cause (integrations-5).
   */
  async runProject(prompt: string, run: AbortController): Promise<string | null> {
    if (run.signal.aborted || this.projectRun || this.status.phase !== "ready" || this.providerMoved() || !this.projectModel || this.o.screenLocked?.()) return null;
    this.projectRun = run;
    try {
      let failure: ProjectModelFailure | null = null;
      const answer = await this.projectModel(PROJECT_SYSTEM, prompt, run.signal, f => { failure = f; });
      if (answer === null && failure && !run.signal.aborted) {
        // Nothing answered at the user's own provider (no status code): is anything listening there? Asked as a failed
        // turn asks (checkProvider), so Projects-only use leaves Ready for the reason too (integrations-r2-5).
        if (this.active?.kind === "user" && typeof (failure as ProjectModelFailure).statusCode !== "number") void this.checkProvider(this.gen);
        throw new ProjectModelError(projectFailureText(failure, { provider: this.projectService, settingsKey: this.o.settingsKey ? this.o.settingsKey() : this.sys.shortcuts?.settings.label, local: this.ownServiceHere() }));
      }
      return answer;
    } finally {
      if (this.projectRun === run) this.projectRun = null;
    }
  }

  /**
   * A typed "stop" or "stop everything" (stopRequest) while a task is running or waiting: the kill switch at once, as
   * "Ember, stop" is, never a Copilot turn that may take seconds to call cancel_task, or a notice while it connects
   * (tasks-approvals-v2). Stopping is safe, so it needs no Voice Match. True when it stopped; false leaves the request
   * to the conversation (nothing at work, or a stop of something else). The conversation keeps what was asked, as it
   * was asked (`how`: heard unchecked, a suggestion, the request heard), and that everything stopped (home-c1-1: the
   * "stop" vanished from Home, which went on waiting for a reply that never comes).
   */
  stopsNow(text: string, how: { voiceUnchecked?: boolean; suggested?: boolean; overEmber?: boolean; heardId?: number } = {}): boolean {
    if (!this.stopsWith(text) || !this.o.stopEverything) return false;
    this.o.log.info("agent.stop_local");
    const asked = this.remember("you", text, how.heardId);
    if (how.voiceUnchecked) this.voiceUnchecked.add(asked);
    if (how.suggested) this.suggested.add(asked);
    if (how.overEmber) this.overEmber.add(asked);
    this.o.stopEverything();
    this.remember("ember", STOPPED_EVERYTHING);
    return true;
  }

  /** Whether `text` asked now would stop everything at once (stopsNow), without stopping anything. */
  stopsWith(text: string): boolean {
    return !!this.o.stopEverything && stopRequest(text) && this.tasksAtWork();
  }

  /** A Stop: requests asked before it are dropped (stopEpoch), those still waiting at once (stopSignal, home-r3-1). */
  private stopped(): void {
    this.stops++;
    const was = this.stopSignal;
    this.stopSignal = signal();
    was.fire();
  }

  /**
   * The conversation's own Stop (its bubble's, while Copilot keeps it waiting: presenter STOP_ANSWER): the turn under
   * way ends, and so does a request still waiting to be sent. Tasks and their questions go on (the kill switch stops
   * those). Returns whether anything was under way (a turn, a request waiting for its turn or for a model service, or
   * the answer still being spoken: `speaking`, which main knows); only then does the bubble say "Stopped", so a press
   * with nothing to stop never covers what it shows with a stop that didn't happen (home-3).
   */
  async stopAnswer(o: { speaking?: boolean } = {}): Promise<boolean> {
    const underWay = this.answerOpen || this.presenter.busy || this.held.length > 0 || o.speaking === true;
    // (Its turn is over from Ember's side at once, whether or not the runtime confirms it: Home says so now, and that
    // Stop ended it: home-c2-2.)
    if (underWay) this.turnChanged("stopped");
    this.stopped();
    this.queued = [];
    this.dropHeld();
    if (underWay) this.presenter.stopped();
    this.o.log.info("agent.answer_stopped", { underWay });
    const aborting = this.conductor?.abort();
    this.turnChanged();
    await aborting;
    // (The turn is over from Ember's side, whether or not the runtime confirms it: a switch waiting for it is made.)
    this.switchWhenQuiet();
    return underWay;
  }

  /** A wake interrupts the spoken reply while its independently scheduled tasks keep running. */
  interruptAnswer(): void {
    if (this.conductor) this.conductor.interruptAnswer();
    else this.o.onAnswerInterrupted?.();
  }

  /** Formal permission pauses speech without cancelling the request whose tool is waiting for that permission. */
  pauseAnswer(): void {
    this.conductor?.pauseAnswer();
  }

  /**
   * Stops the current answer and every running task (the kill switch). Main shows the kill switch's
   * message right after: nothing of the conversation's or a stopped task's replaces it.
   */
  async abortAll(): Promise<void> {
    this.turnChanged("stopped-everything");
    this.projectRun?.abort();
    this.stopped();
    // Requests still waiting for their turn are dropped with it (the runtime runs none of them), and those held for a
    // new model service.
    this.queued = [];
    this.dropHeld();
    this.claimBubble();
    this.presenter.quiet();
    // (A connection's bubble too: the kill switch stops its reconnects, so "I'll try to reconnect" doesn't come back.)
    this.noticeBoard.quiet();
    this.offerBoard.quiet();
    // (And the "Commands are off" hint waiting behind the answer: offered again later if it never showed.)
    this.hintOwed = false;
    this.commandsHint?.quiet();
    this.memoryHint?.quiet();
    for (const p of this.taskPresenters.values()) p.quiet();
    for (const t of this.tasks?.list() ?? []) if (t.status === "running" || t.status === "queued") this.stoppedByAll.add(t.id);
    this.tasks?.cancelAll();
    this.confirmer?.cancelAll();
    const aborting = this.conductor?.abort();
    this.turnChanged();
    await aborting;
  }

  /**
   * What each kept task did and is doing, newest first (TaskManager.activities): Home's "Task activity" reads it. In
   * memory only; while no TaskManager runs (reconnecting), what the ones before it kept (tasks-approvals-c2-1).
   */
  taskActivities(): TaskEntry[] {
    return this.tasks?.activities() ?? this.earlierTasks;
  }

  /**
   * Try again was pressed on the conversation's problem: the request it offers (that turn's own, never a newer one asked
   * while it ran), taken once, the button going with it, so a second press asks nothing twice. Null when none is offered.
   */
  takeRetry(): string | null {
    return this.presenter.takeRetry();
  }

  /**
   * The user pressed Try again on a failed task's card: it starts again with what it was asked with, on the same
   * computer (which must still take it: its worker refuses otherwise). Nothing starts while the organisation has
   * turned acting off. Returns whether it started.
   */
  retryTask(id: string): boolean {
    if (!this.actionsAllowed()) return false;
    const t = this.tasks?.retry(id);
    if (!t) return false;
    this.announced.add(t.id);
    return true;
  }

  /** The organisation lets tasks act (its policy's features.actions); a failed card's Try again shows only then. */
  private actionsAllowed(): boolean {
    return this.o.admin?.().features.actions !== false;
  }

  /**
   * Every task running or waiting now is about to be stopped for `why` (the organisation's policy changed: the kill
   * switch follows): each one's result says so, and "What did I miss?" too, instead of "you stopped it"
   * (tasks-approvals-r9-5).
   */
  stoppingBecause(why: string): void {
    for (const t of this.tasks?.list() ?? []) if (t.status === "running" || t.status === "queued") this.stoppedWhy.set(t.id, why);
  }

  /**
   * Stops every task bound to `target` (a queued one ends before it starts, a running one is aborted, with its question
   * if it asked one): someone at that computer pressed Stop, or its connection went (§5.3.9, §5.1.11). With `only:
   * "desktop"` (its screen locked or its session went inactive, §5.3.4 step 8), only the running tasks that used its
   * desktop: one running only commands there goes on (its command window is on this PC), and a queued one hasn't used
   * it; a running task that can't say counts as one that did. Tasks on other computers go on. `why`: what each stopped
   * task's result says instead of "Stopped." ("build-01's connection dropped, so I stopped this."). Returns how many it
   * stopped.
   */
  cancelTasksOn(target: TargetId, only?: "desktop", why?: string): number {
    let n = 0;
    for (const t of this.tasks?.list() ?? []) {
      if ((t.targetId ?? "local") !== target || (t.status !== "running" && t.status !== "queued")) continue;
      if (only === "desktop" && (t.status === "queued" || this.taskDesktop.get(t.id)?.() === false)) continue;
      if (why) this.stoppedWhy.set(t.id, why);
      this.tasks?.cancel(t.id);
      n++;
    }
    if (n) this.o.log.info("agent.target_tasks_stopped", { kind: target.split(":")[0], n, ...(only ? { only } : {}) });
    return n;
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
    this.confirmer?.cancelAll();
    await this.tasks?.drain(2500);
    await within(this.tasks?.flushDeletes() ?? Promise.resolve(), RUNTIME_WAIT_MS);
    await this.forgetCurrent(RUNTIME_WAIT_MS);
    // The runtime's saved tool output goes with the conversation.
    try { clearRuntimeTemp(runtimeTempDir(this.o.userData)); } catch (err) { this.o.log.warn("agent.runtime_temp_not_cleared", { err }); }
    // Memory is about the person who signed out: it goes with their conversation (docs/MEMORY.md §3).
    this.setSignedOut(true);
    try { this.forgetKept(); }
    finally {
      // The next account to sign in is nobody's successor: no account change is told for it.
      this.githubLogin = undefined;
      this.githubAccountId = null;
      this.accountUnresolved = false;
      // How its tasks ended belongs to this conversation too: the next one (maybe another account's) doesn't hear it,
      // and Home's Task activity doesn't keep them (tasks-approvals-c2-1).
      this.tasks?.takeReports();
      this.earlierTasks = [];
      this.tasksForgotten = this.tasks;
      // Cards a reconnect was handing on were this conversation's too (integrations-v5-2).
      this.dropHanded();
      this.finishedLately = [];
      this.carried = [];
      this.transcript.length = 0;
      this.dropHistory();
      this.terminalRefused.clear();
      this.o.onTranscript?.([]);
      this.o.log.info("agent.conversation_forgotten");
    }
    // Everything else is done; the person is told if the saved copy is still there (sign-out shows the sentence as it is).
    const stuck = this.historyDeleteProblem();
    if (stuck) throw new Error(stuck);
  }

  /**
   * "New conversation": only the chat starts over. The reply under way and queued messages stop, the conductor's
   * session and the transcript go; sign-in, memory, reminders, routines, running tasks and approvals are untouched
   * (unlike `forgetConversation`, which is for sign-out). How tasks ended still reaches the next turn.
   */
  async newConversation(): Promise<void> {
    // A second click while one is under way is the same reset, not another that could erase what the first started.
    this.resetting ??= this.resetConversation().finally(() => { this.resetting = null; });
    return this.resetting;
  }

  private async resetConversation(): Promise<void> {
    const conductor = this.conductor;
    const gen = this.gen;
    // Retires the requests of this chat at once: a late send failure of one is no reason to reconnect.
    const before = ++this.conversationEpoch;
    await this.stopAnswer();
    // Signed out, another account or a reconnect meanwhile: that conversation isn't this one's to erase.
    if (before !== this.conversationEpoch || gen !== this.gen || conductor !== this.conductor) return;
    const caps = this.convoCaps;
    const forgetting = this.forgetCurrent(RUNTIME_WAIT_MS);
    const mine = this.conversationEpoch;
    await forgetting;
    if (mine !== this.conversationEpoch || gen !== this.gen || conductor !== this.conductor) return;
    this.transcript.length = 0;
    this.dropHistory(true);
    this.o.onTranscript?.([], "new-conversation");
    // A fresh session on the same runtime: tasks, their approvals and the connection are left as they are. It is built
    // for the model selected now and the extension tools as they are now, not the retired chat's.
    if (conductor) {
      try {
        const extensions = this.o.extensions?.forSession();
        const extensionsGen = this.o.extensions?.generation ?? 0;
        await conductor.renew(RUNTIME_WAIT_MS, { model: this.status.conductorModel ?? undefined, extensions });
        if (mine === this.conversationEpoch && gen === this.gen && conductor === this.conductor && conductor.sessionId) {
          this.conversation = conductor.sessionId;
          // The renewed session's answers are this chat's (its retired session's are dropped by the conductor).
          this.conductorChat.chat = mine;
          this.convoCaps = caps;
          this.extensionsGen = extensionsGen;
          // This chat replaces the one whose failure was waiting for the tasks to end: that deferred reconnect is
          // moot, and Ember answers again now (tasks keep running).
          if (this.reconnectAfterTasks) {
            this.reconnectAfterTasks = null;
            const login = this.status.login;
            this.setStatus({ phase: "ready", detail: login ? `Signed in as ${login}.` : "Connected." });
          }
        }
      } catch (err) {
        this.o.log.warn("agent.new_conversation_failed", { err });
        if (gen === this.gen && conductor === this.conductor) {
          if (this.tasksAtWork()) {
            this.reconnectAfterTasks = () => { this.reconnectAfterTasks = null; this.lost(gen, "new conversation failed", undefined, undefined, true); };
            this.setStatus({ phase: "error", reason: "not-answering", detail: `I couldn't start a new conversation. ${AFTER_TASKS}` });
          } else this.lost(gen, "new conversation failed", undefined, undefined, true);
        }
        // The caller (Home) must not say it worked.
        throw err;
      }
    }
    this.o.log.info("agent.new_conversation");
  }

  /**
   * Another account than the conversation's signed in: the conversation is deleted, as at sign-out, and what it said,
   * how its tasks ended and what Ember kept about its person go with it.
   */
  private async accountChanged(eraseKept = true): Promise<void> {
    this.o.log.info("agent.account_changed");
    await this.forgetCurrent(RUNTIME_WAIT_MS);
    this.carried = [];
    this.transcript.length = 0;
    this.dropHistory();
    this.terminalRefused.clear();
    this.o.onTranscript?.([]);
    // What Ember remembered was about the account before, its person: none of it carries over.
    const erased = eraseKept && this.forgetKept();
    // How the tasks ended was the other account's too: "what did I miss?" doesn't tell this one, nor Task activity.
    this.finishedLately = [];
    this.earlierTasks = [];
    this.dropHanded();
    this.o.onAccountChanged?.();
    // Never without a word: the new account's conversation starts by saying what went (memory-11).
    if (erased) this.remember("ember", ACCOUNT_CHANGED_FORGOT);
  }

  /**
   * Forgets personal memory before another account may use it. Main still disconnects credentials on failure. True
   * when memory was erased (memory not verified as the previous account's stays on the computer).
   */
  private forgetKept(): boolean {
    let failure: Error | undefined;
    let erased = false;
    try {
      erased = this.o.memory?.forgetAll() === true;
      this.memoryDeletionPending = false;
    } catch (err) {
      this.memoryDeletionPending = true;
      this.o.log.warn("agent.memory_not_forgotten", { err: err instanceof Error ? err.message : String(err) });
      failure = new Error("Ember couldn't finish deleting memory from this computer. Use Forget everything in Memory before connecting again.", { cause: err });
    }
    this.reminders.clear();
    try { this.o.routines?.forgetAll(); } catch (err) { this.o.log.warn("agent.routines_not_forgotten", { err: err instanceof Error ? err.message : String(err) }); }
    if (failure) throw failure;
    return erased;
  }

  /**
   * The finished cards the manager before kept on screen through the reconnect, for this connection's (`takes`: there is
   * one), which lists them at once (tasks-approvals-r4-2, integrations-v5-2); with none to take them, they go now. From
   * another model service (`service`: this connection's) they go on without what the conversation there wrote, as it
   * isn't resumed here (integrations-v5-1): Try again starts from the user's own words, only where they were that
   * task's alone (handedElsewhere, integrations-w5-1), and this conversation isn't told of them (list_tasks).
   */
  private handOn(service: string, takes: boolean): KeptCard[] {
    const from = this.handing;
    this.handing = null;
    if (!from) return [];
    const kept = takes ? from.tasks.keptCards() : [];
    from.tasks.close(kept.length > 0);
    if (this.tasks === from.tasks) this.tasks = null;
    if (from.service === service) return kept;
    const handed = kept.map(handedElsewhere);
    for (const c of handed) this.fromElsewhere.add(c.task);
    return handed;
  }

  /** The cards a reconnect was handing on go after all: a sign-out, an account change, or no connection (integrations-v5-2). */
  private dropHanded(): void {
    const from = this.handing;
    if (!from) return;
    this.handing = null;
    from.tasks.close();
    if (this.tasks === from.tasks) this.tasks = null;
  }

  /** Deletes this run's conversation (now, or at the next start if Copilot doesn't answer within `ms`). */
  private async forgetCurrent(ms: number): Promise<void> {
    this.conversationEpoch++;
    this.stream = null;
    this.conversation = null;
    this.setConversationContext(undefined);
    // An extension's result that read as instructions tainted that conversation (across its reconnects); it ends here.
    this.o.extensions?.conversationEnded?.();
    // What the user had Ember forget was held back from this conversation, which still knew it; the next doesn't (memory-r9-1).
    try { this.o.memory?.conversationEnded?.(); } catch (err) { this.o.log.warn("agent.memory_not_told", { err: err instanceof Error ? err.message : String(err) }); }
    this.convoCaps = null;
    try {
      if (this.conductor) await this.conductor.forget(ms);
      else forgetSavedConversation(this.stateFile);
    } catch (err) {
      this.o.log.warn("agent.forget_failed", { err });
    }
  }

  /** `forget`: a clean stop (quit) deletes the conversation; a restart keeps it to resume. */
  private async doStop(forget = false): Promise<void> {
    // Under a model provider memory waits for it, never "Checking your GitHub account…" (integrations-r5).
    this.o.memory?.pauseAccount?.(memoryWaitFor(this.providerNow(), "checking"));
    this.projectRun?.abort();
    this.projectRun = null;
    this.projectModel = null;
    this.setConversationContext(undefined);
    if (this.health) { clearInterval(this.health); this.health = null; }
    // (A reconnect put off until the tasks were done: this is it, or something newer.)
    this.reconnectAfterTasks = null;
    const cutOff = this.cutOff;
    this.cutOff = null;
    // The waiting switch's reconnect: the finished cards stay with their manager, on screen, until the next connection's
    // takes them, each within the time it has left; never the tasks a stop cuts off, nor after a sign-out, an account
    // change or when quitting, nor when Ember doesn't connect (tasks-approvals-r4-2, integrations-v5-2).
    const keep = !forget && this.keepCards && !!this.tasks && this.tasks !== this.tasksForgotten;
    this.keepCards = false;
    // Nothing keeps acting or asking once the brain goes away (sign-out, restart, quit). Cut off by a runtime
    // that stopped (or stopped answering), tasks end as failed.
    this.tasks?.cancelAll(cutOff ?? undefined);
    this.confirmer?.cancelAll();
    // First, while the runtime surely still runs (quitting doesn't wait long).
    if (forget) await this.forgetCurrent(2000);
    await this.tasks?.drain(2500);
    // Finished tasks' sessions are deleted now, while the client can still do it (a hung runtime isn't waited for).
    await within(this.tasks?.flushDeletes() ?? Promise.resolve(), RUNTIME_WAIT_MS);
    // A reconnect resumes the conversation: its next turn hears how these tasks ended. Quitting forgets it all.
    this.carried = forget ? [] : [...this.carried, ...(this.tasks?.takeReports().map(report) ?? [])];
    // What they did stays in Home's Task activity until Ember quits (tasks-approvals-c2-1), not after a sign-out.
    if (forget) this.earlierTasks = [];
    else if (this.tasks && this.tasks !== this.tasksForgotten) this.earlierTasks = this.tasks.history();
    this.tasksForgotten = null;
    // The cards go with their manager: a failed card's Close would reach nobody after a restart. (A second switch before
    // the next manager took them hands on the same cards, from the service they ran on.)
    if (keep && this.tasks) this.handing = { tasks: this.tasks, service: this.handing?.tasks === this.tasks ? this.handing.service : serviceOf(this.active) };
    else {
      this.handing = null;
      this.tasks?.close();
      this.tasks = null;
    }
    this.outcomes.clear();
    // The session goes, and with it every turn of it, running or waiting.
    this.queued = [];
    this.turn = null;
    this.presenter.reset();
    await this.conductor?.stop();
    this.conductor = null;
    this.turnChanged();
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
