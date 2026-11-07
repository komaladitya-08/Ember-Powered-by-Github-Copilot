/** IPC channel names and payload types shared by main, preload and renderers. */

import type { EnvReport, FixId, TargetFixId } from "../main/environment";
import type { Settings, SettingsPatch } from "../main/settings";
import type { AgentStatus, AnswerStream, TranscriptEntry } from "../main/agent/host";
import type { MemoryItem } from "../main/memory/service";
import type { Intro } from "../main/memory/intro";
import type { MemoryModelStatus } from "../main/memory/better-recall";
import type { MemoryOwnerReason, MemoryOwnership } from "../main/memory/owner";
import type { MemoryCorrection } from "./memory-correction";

/** A routine as Home lists it. */
export interface RoutineRow { id: string; name: string; steps: string[] }
/** Whether a newer Ember is out (app/main/updates.ts): "off" until the user turned it on and agreed to its note. */
export interface UpdateStatus { phase: "off" | "idle" | "checking" | "current" | "available" | "failed"; latest: string | null; checkedAt: string | null }
/** A waiting reminder and whether its exact current version is retained after quit. */
export interface ReminderRow { id: string; text: string; at: number; created: number; kept: boolean }
export interface ReminderChange { expected: Omit<ReminderRow, "kept">; replacement: { text: string; at: number } | null }
export type ProjectMode = "review" | "plan" | "patch";
export interface ProjectSelection { names: string[]; sizes?: (number | null)[]; changed?: boolean; error?: string }
export type ProjectResult = { answer: string; patch?: { name: string; diff: string }; canContinue: boolean } | { error: string };
export type ProjectWorkspaceAction = { action: "list" } | { action: "save" | "open" | "forget"; name: string };
export interface ProjectWorkspaceReply {
  names?: string[];
  message?: string;
  opened?: { files: string[]; sizes?: (number | null)[]; folder: string | null; previous: { mode: ProjectMode; question: string; answer: string } | null };
}
/** How long Undo can put a forgotten memory back (ms): main keeps what it removed that long, and Home offers Undo. */
export const MEMORY_UNDO_MS = 60_000;
/** What one Forget removed: the fact's words, how many of Ember's notes went with it, and Undo's token (memory-7). */
export interface MemoryForgotten { text: string; derived: number; undo: string }
/** `reason`: why memory isn't open, so Home says it truthfully (memory-2); absent from an older main. */
export interface MemoryView { rows: MemoryItem[]; ownership: MemoryOwnership; epoch?: number; reason?: MemoryOwnerReason | null }
import type { HistoryProblemKind } from "./conversation";
import type { MicState } from "./voice";
import type { AdminPolicy } from "../main/admin";
import type { OS, ShortcutId, ShownShortcut } from "./shortcuts";
import type { TargetSummary } from "./targets";
import type { Installed, MarketplaceEntry } from "./extensions";
import type { TaskControlAction, TaskEntry } from "./activity";

/** Main pushes Home's Task activity at most this often (a task's steps can come many a second). */
export const TASKS_PUSH_MS = 500;

export const IPC = {
  getStatus: "ember:get-status",
  updateSettings: "ember:update-settings",
  applyFix: "ember:apply-fix",
  settingsChanged: "ember:settings-changed",
  agentStatus: "agent:status",
  agentStatusChanged: "agent:status-changed",
  signIn: "agent:sign-in",
  signInProgress: "agent:sign-in-progress",
  signOut: "agent:sign-out",
  ask: "agent:ask",
  voiceStatus: "voice:status",
  voiceDownload: "voice:download",
  voiceProgress: "voice:progress",
  /** Voice Match: teach Ember the owner's voice, stop doing so, or forget the voiceprint. */
  voiceMatchEnrol: "voice:match-enrol",
  voiceMatchCancel: "voice:match-cancel",
  voiceMatchForget: "voice:match-forget",
  /** Voice personalisation (app/main/personal/): back to the enrolment; what was heard lately; a correction taught; the words learnt. */
  voiceMatchReset: "voice:match-reset",
  voiceHeard: "voice:heard",
  voiceTeach: "voice:teach",
  voiceWords: "voice:words",
  voiceForgetWord: "voice:forget-word",
  voiceForgetWords: "voice:forget-words",
  /** The natural voice's download failed: try again (Home's "Try again" under its switch). */
  voiceNaturalRetry: "voice:natural-retry",
  askClose: "agent:ask-close",
  /** One of Ember's suggestions chosen in the Ask box (sent as Ember's words the user chose, not typed). */
  askSuggestion: "agent:ask-suggestion",
  activity: "ember:activity",
  /** "Check again": look for a sign-in once more and reconnect. */
  agentRetry: "agent:retry",
  cancelSignIn: "agent:cancel-sign-in",
  /** Opens GitHub's device page for the sign-in code shown (only https://github.com/…). */
  openSignInPage: "agent:open-sign-in-page",
  conversation: "agent:conversation",
  conversationChanged: "agent:conversation-changed",
  conversationForgotten: "agent:conversation-forgotten",
  conversationStream: "agent:conversation-stream",
  conversationSend: "agent:conversation-send",
  conversationStop: "agent:conversation-stop",
  conversationNew: "agent:conversation-new",
  projectPick: "project:pick",
  projectRemove: "project:remove",
  projectExport: "project:export",
  projectRun: "project:run",
  projectClear: "project:clear",
  projectCancel: "project:cancel",
  projectApply: "project:apply",
  projectChooseFolder: "project:choose-folder",
  projectRunCommand: "project:run-command",
  projectWorkspace: "project:workspace",
  /** Long-term memory (docs/MEMORY.md): what Ember remembers, and forgetting one fact or all of it. */
  memoryList: "memory:list",
  memoryChanged: "memory:changed",
  memoryForget: "memory:forget",
  /** Undo of a recent Forget, by the token Forget gave (memory-7, memory-v2). */
  memoryRestore: "memory:restore",
  memoryForgetAll: "memory:forget-all",
  memoryCorrect: "memory:correct",
  /** "Tell Ember about you": the answers, checked whole in main (IntroSchema) and kept as the user's own facts. */
  memoryIntroduce: "memory:introduce",
  /** Better recall's model (memory/better-recall.ts): its state and changes to it, Download and Remove. */
  memoryModel: "memory:model",
  memoryModelChanged: "memory:model-changed",
  memoryModelDownload: "memory:model-download",
  memoryModelRemove: "memory:model-remove",
  /** Telling the user a newer Ember is out (app/main/updates.ts): where it stands, looking now, and opening its page. */
  updatesStatus: "updates:status",
  updatesChanged: "updates:changed",
  updatesCheck: "updates:check",
  updatesOpen: "updates:open",
  /** Routines and lasting reminders (app/main/agent/routines.ts): the routines kept, and deleting one or all of them. */
  routinesList: "routines:list",
  routinesChanged: "routines:changed",
  routinesCount: "routines:count",
  routinesForget: "routines:forget",
  routinesForgetAll: "routines:forget-all",
  remindersList: "reminders:list",
  remindersChanged: "reminders:changed",
  reminderChange: "reminders:change",
  /**
   * Main asks the settings window to show one of its sections ("conversation", "copilot", "privacy"), or a control in
   * one ("computers:host", "computers:wsl"; renderer/home/section-request.ts).
   */
  focusSection: "ember:focus-section",
  /** The ask box: what Ember will read when you ask (shown as a chip), and your earlier questions. */
  askContext: "agent:ask-context",
  /** What was typed while the ask box was opening (Ember held the keyboard meanwhile). */
  askTyped: "agent:ask-typed",
  /** The ask box's field needs this many lines (1 to 4) for its text: the box grows to fit. */
  askFit: "agent:ask-fit",
  /** The ask box went away: what was left in its field is selected, so typing replaces it when the box opens again. */
  askHidden: "agent:ask-hidden",
  listenOnce: "voice:listen-once",
  listenOnceStatus: "voice:listen-once-status",
  /** Hide/show Ember and stay put/follow, from the settings window (the handle menu isn't keyboard-reachable). */
  presence: "ember:presence",
  setPresence: "ember:set-presence",
  presenceChanged: "ember:presence-changed",
  /** The settings file couldn't be used as it is (a hand edit that isn't valid JSON): what Ember did about it. */
  settingsNotice: "ember:settings-notice",
  /** Main tells the settings window whether it can be seen (minimised or hidden: false), as X11 doesn't say. */
  homeVisibility: "ember:home-visibility",
  quit: "ember:quit",
  /** The handle menu's Ask Ember… and Stop everything, from the settings window (a keyboard's way to them). */
  openAsk: "ember:open-ask",
  stopEverything: "ember:stop-everything",
  /**
   * Home's Task activity: every kept task's activity (AgentHost.taskActivities, in memory only), and main's push of
   * the same list when it changes (at most every TASKS_PUSH_MS, only to the settings window).
   */
  tasks: "tasks:activity",
  openApproval: "ember:open-approval",
  taskControl: "tasks:control",
  tasksChanged: "tasks:activity-changed",
  /** What is wrong with the saved conversation ("save" or "delete", else null): asked, and pushed when it changes. */
  historyProblem: "conversation:history-problem",
  historyProblemChanged: "conversation:history-problem-changed",
  /** Everything was stopped (first run's stop rehearsal hears the shortcut): the source, "hotkey" for the keys. */
  homeStopped: "ember:home-stopped",
  /** First run's "Hey Ember" meter: the window asks for the microphone's level while it shows, and gets it (0–8, null at the end). */
  watchLevel: "ember:watch-level",
  homeLevel: "ember:home-level",
  /** Copies a sign-in code or a setup command for the settings window (pages get no clipboard permission). */
  copyText: "ember:copy-text",
} as const;

export interface SignInProgress {
  /** "waiting": watching for a GitHub CLI sign-in (gh auth login), no restart needed. */
  state: "code" | "done" | "error" | "unavailable" | "waiting" | "cancelled";
  userCode?: string;
  verificationUri?: string;
  message?: string;
  /** "waiting" without the GitHub CLI: the label of a button that opens its download page (IPC.openSignInPage). */
  link?: string;
}

export interface ListenOnceStatus {
  phase: "ready" | "blocked" | "starting" | "listening" | "checking";
  detail: string;
}

export interface VoiceStatus {
  state: MicState;
  detail: string | null;
  /** Listening can start: the wake word, voice activity and speech recognition models are in. */
  modelsReady: boolean;
  /** The models not in yet (or damaged), which the download fetches, and their size together. */
  modelsMissing: SpeechModelId[];
  modelsBytes: number;
  /** A download is under way, perhaps while listening carries on (only Ember's voice or Voice Match coming). */
  downloading?: boolean;
  /** Ember tried to speak and no voice started: the computer has none (review #101). */
  speechMissing?: boolean;
  /** Voice Match: whether a voiceprint is kept (`enrolled`) and in use (`on`), and enrolment's progress while it runs. */
  match?: VoiceMatchStatus;
  /** The selected natural voice: what became of turning it on, shown under its switch. */
  natural?: NaturalVoiceStatus;
  clear?: ClearHearingStatus;
  /** Optional voices supported by this computer's selected native backend. No model is downloaded by listing them. */
  naturalModels?: Settings["voice"]["naturalModel"][];
  listenOnce?: ListenOnceStatus;
}

/**
 * The effective local voice as Home shows it (VoiceService.naturalStatus): `off` (service stopped); `later` (selected at start:
 * decided the next time it speaks); `checking` (Ember's voice is loading to time this computer); `needs-voice` (Ember's own voice isn't downloaded yet, so nothing can be timed);
 * `downloading` (`percent` of it so far); `ready` (fetched: it speaks from the next reply); `on` (it speaks now);
 * `too-slow`; `failed` (the download failed: Try again); `wont-load` (downloaded, but it wouldn't load); `needs-native`
 * (Ember's faster speech didn't load on this computer, and Kokoro needs it).
 */
/** Hear me more clearly (Settings › Voice): how the clearer recognizer stands. */
export type ClearHearingStatus =
  | { state: "off" | "starting" | "on" | "wont-load" | "needs-native" }
  | { state: "downloading"; percent: number }
  | { state: "failed"; detail: string };

export type NaturalVoiceStatus = (
  | { state: "off" | "later" | "checking" | "needs-voice" | "ready" | "on" | "too-slow" | "wont-load" | "needs-native" }
  | { state: "downloading"; percent: number }
  | { state: "failed"; detail: string }) & {
    /** Effective requested voice; legacy natural:false selects the Kitten baseline. */
    model?: "kitten" | "kokoro" | "supertonic";
    /** Current/last usable local engine, including an explicit system-voice fallback. */
    voice?: "kitten" | "kokoro" | "supertonic" | "system";
  };

/** The speech models (app/voice/models.ts): wake word, voice activity, speech recognition, Ember's voice, Voice Match. */
export type SpeechModelId = "kws" | "vad" | "asr" | "tts" | "speaker";

/** What teaching a correction did ("That's not what I said"): app/main/personal/service.ts PersonalVoice.teach. */
export interface VoiceTeachOutcome { outcome: "learnt" | "off" | "unknown" | "unlike" | "same"; word?: { heard: string; meant: string } }
/** A correction Ember learnt: what it heard, what was meant, when (ISO). */
export interface VoiceWord { heard: string; meant: string; at: string }

export interface VoiceMatchStatus {
  enrolled: boolean;
  /** How many of the owner's requests Voice Match has learnt from since enrolment (Keep learning my voice). */
  learnt?: number;
  /** In use: wanted, a voiceprint kept, and its model in. */
  on: boolean;
  /** Its voiceprint model is in (false: Voice Match is off until it is downloaded, whatever the setting says). */
  model?: boolean;
  /** Turned on in settings with a voiceprint kept, but off for now: its model is missing or was damaged. */
  wanted?: boolean;
  /** `got` of `of` phrases kept; `phrase`: the one to say now; `again`: the last wasn't kept, and why. */
  enrolling: { got: number; of: number; phrase: string; again?: "short" | "unlike" | "failed" } | null;
}

/**
 * What the settings window shows that differs by OS, built by main from its Platform object. Linux's reproduces the
 * window's own markup and strings, so a Linux window looks exactly as it did before there were other OSes.
 */
export interface StatusPlatform {
  os: OS;
  /**
   * Each global shortcut as Ember's copy writes it ("Ctrl+Alt+Space") and as key caps (["Ctrl", "Alt", "Space"]): the
   * chord Ember holds, its fallback while another app holds the default (D-45b); `taken` (label "") while it holds neither.
   */
  shortcuts: Record<ShortcutId, ShownShortcut>;
  /** How the window names the data folder ("~/.config/ember") and the settings file in it. */
  dataDir: string;
  settingsFile: string;
  /** Where a copy of the audit log goes ("the system journal (journalctl -t ember-audit)"), or null when nothing copies it. */
  auditCopy: string | null;
  /** The voice consent's sentence about the OS's microphone indicator. */
  micIndicator: string;
  /** What the OS will ask the user to allow for Ember, said before Start ("" when nothing). */
  permissionsNote: string;
  /** Ember listens to the speakers to tell its own voice apart (Linux only): false drops that sentence from the consent. */
  speakerRejection: boolean;
  /** A conversation can tell when other sound is playing (Windows): the consent says so. */
  outputLevel: boolean;
  /** The button text of each setup-check fix this OS offers ("Turn on", "Open System Settings"); others say "Turn on". */
  fixLabels: Partial<Record<FixId | TargetFixId, string>>;
  /** Ember's desk is offered here. */
  desk: boolean;
  /** A note under "Start Ember when I log in" (macOS waiting for approval, Windows turned off in Task Manager), or null. */
  autostartNote: string | null;
}

export interface Status {
  appVersion: string;
  settings: Settings;
  environment: EnvReport;
  logFile: string;
  /** Set when settings.json couldn't be used as it was (see IPC.settingsNotice). */
  settingsNotice: string | null;
  /** The administrator's policy in force, if any. */
  admin: {
    source: string | null;
    /** The policy file is broken, so Ember is locked down. */
    error: string | null;
    /** The policy changed while Ember ran: it is locked down until a restart reads the new one (`error` says so too). */
    held?: boolean;
    /** Settings the administrator decides. */
    managed: string[];
    features: AdminPolicy["features"];
    /** The organisation's own model endpoint, when set. */
    provider: string | null;
    confirmEveryAction: boolean;
    allowGrants: boolean;
    /** Days the record of actions is kept; null while Ember is locked down, when none is deleted. */
    retentionDays: number | null;
    /** Never-look entries the administrator set: shown locked; they never go into the user's own list. */
    neverLook: string[];
    /** Each kind of computer's commands mode (admin.ts commandMode): the Commands section shows what is locked. */
    commands?: { local: "off" | "ask" | "on"; wsl: "off" | "ask" | "on"; ssh: "off" | "ask" | "on" };
    /** The administrator lists the SSH hosts Ember may reach (`ssh.allowedHosts`). */
    sshHostsLimited?: boolean;
  };
  /** Absent from a main that doesn't send it yet: the window then keeps its Linux markup and strings. */
  platform?: StatusPlatform;
}

/** One line of the activity timeline (an audit entry). */
export interface ActivityEntry {
  t: string;
  event: string;
  task?: string;
  kind?: string;
  app?: string;
  window?: string;
  element?: { role: string; name: string };
  verdict?: string;
  reason?: string;
  answer?: string;
  ok?: boolean;
  error?: string;
  tier?: number | string;
  value?: string;
  source?: string;
  [key: string]: unknown;
}

/** The live model prompt window, separate from cumulative usage and any account allowance. */
export type ConversationContext =
  | { kind: "usage"; currentTokens: number; tokenLimit?: number }
  | { kind: "compacting" };

export interface EmberHomeApi {
  getStatus(): Promise<Status>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  onSettingsChanged(fn: (s: Settings) => void): () => void;
  /** Applies a fix offered by a setup check; returns the new report. */
  applyFix(fix: NonNullable<EnvReport["checks"][number]["fix"]>): Promise<EnvReport>;
  agentStatus(): Promise<AgentStatus>;
  projectPick(): Promise<ProjectSelection>;
  projectRemove(name: string): Promise<ProjectSelection>;
  projectExport(kind: "answer" | "diff"): Promise<{ message: string }>;
  projectRun(request: { mode: ProjectMode; question: string; includePrevious?: boolean }): Promise<ProjectResult>;
  projectClear(): Promise<void>;
  projectCancel(): Promise<void>;
  projectApply(): Promise<{ message: string; done: boolean }>;
  projectChooseFolder(): Promise<{ folder: string | null; message?: string }>;
  projectRunCommand(command: string): Promise<string>;
  projectWorkspace(input: ProjectWorkspaceAction): Promise<ProjectWorkspaceReply>;
  onAgentStatus(fn: (s: AgentStatus) => void): () => void;
  signIn(): Promise<void>;
  onSignInProgress(fn: (p: SignInProgress) => void): () => void;
  signOut(): Promise<void>;
  voiceStatus(): Promise<VoiceStatus>;
  onVoiceStatus(fn: (s: VoiceStatus) => void): () => void;
  downloadVoice(): Promise<void>;
  /** Fetches the natural voice again after its download failed. */
  retryNaturalVoice(): Promise<void>;
  /** Voice Match: starts teaching Ember the owner's voice (false: Ember isn't listening, so it can't), or stops; forgets the voiceprint. */
  enrolVoice(): Promise<boolean>;
  cancelEnrolVoice(): Promise<void>;
  forgetVoice(): Promise<void>;
  /** Voice Match goes back to the enrolment alone (what it learnt since is dropped). */
  resetVoice(): Promise<void>;
  /** The ids of the requests heard lately (their conversation rows' `heardId`), for "That's not what I said". */
  voiceHeard(): Promise<number[]>;
  /** The user retyped what they meant for the request heard as `id`: what happened (VoiceTeachOutcome). */
  teachWords(id: number, meant: string): Promise<VoiceTeachOutcome>;
  /** The corrections learnt, and forgetting one (by its place) or all. */
  voiceWords(): Promise<VoiceWord[]>;
  onVoiceWords(fn: (words: VoiceWord[]) => void): () => void;
  forgetVoiceWord(word: VoiceWord): Promise<VoiceWord[]>;
  forgetVoiceWords(): Promise<void>;
  /** What Ember remembers (newest first), and changes to it. */
  memory(): Promise<MemoryView>;
  onMemory(fn: (view: MemoryView) => void): () => void;
  /** Forgets one fact: what went (its words, Ember's notes made from it) and Undo's token, or null if it wasn't there. */
  forgetMemory(id: string): Promise<MemoryForgotten | null>;
  /** Undo of a recent Forget: true if it was put back, false once it is too late. */
  restoreMemory(token: string): Promise<boolean>;
  forgetAllMemory(): Promise<void>;
  /** Saves one explicit local correction without changing the fact's original source authority. */
  correctMemory(change: MemoryCorrection): Promise<MemoryItem>;
  /** Keeps "Tell Ember about you"'s answers; how many were kept, or null while memory is off. */
  introduceMe(answers: Intro): Promise<number | null>;
  /** Better recall's model: whether it is here, and changes; the user's Download (the agreement to fetch it) and Remove. */
  memoryModel(): Promise<MemoryModelStatus>;
  onMemoryModel(fn: (s: MemoryModelStatus) => void): () => void;
  downloadMemoryModel(): Promise<void>;
  removeMemoryModel(): Promise<void>;
  /** Whether a newer Ember is out, looking now, and opening its release page. */
  updates(): Promise<UpdateStatus>;
  onUpdates(fn: (s: UpdateStatus) => void): () => void;
  checkForUpdates(): Promise<UpdateStatus>;
  openUpdate(): Promise<void>;
  /** The routines kept, and changes to them; deleting one, or all of them with the lasting reminders. */
  routines(): Promise<RoutineRow[]>;
  /** How many routines are stored, whatever the policy; unknown (never zero) when they can't be read. */
  routinesCount(): Promise<{ known: true; n: number } | { known: false }>;
  reminders(): Promise<ReminderRow[]>;
  onReminders(fn: (rows: ReminderRow[]) => void): () => void;
  changeReminder(change: ReminderChange): Promise<void>;
  onRoutines(fn: (rows: RoutineRow[]) => void): () => void;
  forgetRoutine(id: string): Promise<void>;
  forgetAllRoutines(): Promise<void>;
  /** `phase` "unpacking": the last download is in, and is being checked and unpacked. */
  onVoiceProgress(fn: (p: { done: number; total: number; phase?: "unpacking" }) => void): () => void;
  /** The newest audit entries, newest first. */
  activity(): Promise<ActivityEntry[]>;
  /** Look for a sign-in again (e.g. after gh auth login) and reconnect; says whether one was found and where. */
  retrySignIn(): Promise<{ found: boolean; source: string | null; hint?: string }>;
  /** Ember beside the cursor or hidden, following or staying put (`overlay` false: no compositor, Ember lives in the corner card). */
  presence(): Promise<Presence>;
  setPresence(p: Partial<Pick<Presence, "hidden" | "paused">>): Promise<Presence>;
  onPresence(fn: (p: Presence) => void): () => void;
  onSettingsNotice(fn: (notice: string | null) => void): () => void;
  /** Quit Ember (asks first while tasks are running). */
  quit(): Promise<void>;
  /** Opens the ask box, as the handle menu's Ask Ember… does (the keyboard's way when another app has the shortcut). */
  openAsk(): Promise<void>;
  listenOnce(on: boolean): Promise<ListenOnceStatus>;
  /** Stops everything, as the handle menu's Stop everything does. */
  stopEverything(): Promise<void>;
  /** Everything was just stopped, and how ("hotkey", "voice", "menu" or "settings"). */
  onStopped(fn: (source: string) => void): () => void;
  /** Send the microphone's level here while first run's "Hey Ember" try shows (true), or stop (false). */
  watchLevel(on: boolean): Promise<void>;
  /** The microphone's level (0–LEVEL_STEPS) while Ember hears a request, and null when it stops hearing. */
  onLevel(fn: (level: number | null) => void): () => void;
  /** Copies plain text, bounded by the session conversation's per-message limit. */
  copyText(text: string): Promise<void>;
  cancelSignIn(): Promise<void>;
  /** Opens GitHub's page where the sign-in code is entered (again). */
  openSignInPage(): Promise<void>;
  /** What each task this session did and is doing, newest first (kept in memory only), and changes to it. */
  tasks(): Promise<TaskEntry[]>;
  openApproval(): Promise<boolean>;
  taskControl(id: string, action: TaskControlAction): Promise<boolean>;
  onTasks(fn: (tasks: TaskEntry[]) => void): () => void;
  /** Whether the saved conversation couldn't be written ("save") or deleted ("delete"), and changes to it. */
  historyProblem(): Promise<HistoryProblemKind | null>;
  onHistoryProblem(fn: (problem: HistoryProblemKind | null) => void): () => void;
  /** This session's conversation (kept in memory only). */
  conversation(): Promise<TranscriptEntry[]>;
  /** Explicit typed request from Home, without capturing its foreground window. */
  conversationSend(text: string): Promise<void>;
  /** Ends the current response and queued requests; independently running tasks continue. */
  conversationStop(): Promise<void>;
  /** Starts a fresh chat: memory, reminders, running tasks and sign-in stay. */
  conversationNew(): Promise<void>;
  onConversation(fn: (entries: TranscriptEntry[]) => void): () => void;
  /** Explicit account/session erasure, distinct from a list made empty by forgetting learned facts. */
  onConversationForgotten(fn: () => void): () => void;
  /** Ember's answer as it develops (the same words the bubble shows), so Home's conversation can show it too. */
  onConversationStream(fn: (e: AnswerStream) => void): () => void;
  onFocusSection(fn: (section: string) => void): () => void;
  /** The window was minimised or hidden (false), or shown again (true): nothing is drawn while it can't be seen. */
  onVisibility(fn: (visible: boolean) => void): () => void;
}

export interface Presence { hidden: boolean; paused: boolean; overlay: boolean; approval?: boolean }

/** What the ask box shows: where Ember will look, and the user's recent questions (newest last). */
export interface AskContext {
  /** The window's app and title, e.g. "Mousepad · notes.txt", or null when Ember can't read the screen. */
  sees: string | null;
  /** What else a request sends from the screen (with `sees`): the selection or the field's text, other windows' titles. */
  carries?: { selection: boolean; fieldText: boolean; windows: number };
  /** The user is in a private window (never-look list, password prompt): Ember reads nothing there. */
  privateWindow?: boolean;
  history: string[];
  /**
   * The box is opening (sent before its window is shown; not a later update of what Ember will see): back to the newest
   * earlier question, one line tall. What was left in it was selected as it went away (onHidden).
   */
  opened?: boolean;
  /**
   * With `opened`: the box says to wait for it before typing, a row under the rest (its first few openings where Ember
   * can't hold the letters typed while it opens: Windows, macOS; review #78).
   */
  tip?: boolean;
  /** Where a request goes when it names no computer (the picker's choice, §8.1); absent or null: this computer. */
  target?: TargetSummary | null;
  /**
   * What the user might say next (app/main/personal/predict.ts): Ember's suggestions, a row of chips under the field
   * (with `opened`: the box opens a row taller). Choosing one sends it as if typed.
   */
  suggestions?: string[];
  listenOnce?: ListenOnceStatus;
}

export interface EmberAskApi {
  ask(text: string): void;
  /** One of Ember's suggestions chosen (AskContext.suggestions): main sends it as the user's choice of Ember's words. */
  askSuggestion?(text: string): void;
  close(): void;
  listenOnce(on: boolean): Promise<ListenOnceStatus>;
  onListenOnce(fn: (s: ListenOnceStatus) => void): void;
  onContext(fn: (c: AskContext) => void): void;
  /** Text typed before the box had the keyboard: it goes in the box (Enter sends it, Esc closes the box). */
  onTyped(fn: (t: { text: string; submit: boolean; cancel: boolean }) => void): void;
  /** The box went away (nothing can be typed in it now): what was left in the field is selected for the next opening. */
  onHidden(fn: () => void): void;
  /** The page needs `rows` rows (the field's 1 to 4 lines, and one for the note when a paste was cut): the box grows to fit. */
  fit?(rows: number): void;
}

/**
 * Home's Extensions section (app/main/extensions-ipc.ts, app/renderer/home/extensions.ts): main takes these only from
 * the settings window, checks every argument's type and size, and answers in plain words (never the runtime's raw text).
 */
export const EXTENSIONS_IPC = {
  /** What is installed, the marketplaces added, and whether extensions may be used at all (ExtensionsState). */
  state: "extensions:state",
  /** Main says something changed (installed, enabled, connected, a tool changed): the page asks for the state again. */
  changed: "extensions:changed",
  browse: "extensions:browse",
  connectors: "extensions:connectors",
  addMarketplace: "extensions:add-marketplace",
  removeMarketplace: "extensions:remove-marketplace",
  install: "extensions:install",
  uninstall: "extensions:uninstall",
  setEnabled: "extensions:set-enabled",
  /** Connect a connector: GitHub's consent page opens in the browser when it needs one (only https://github.com/…). */
  connect: "extensions:connect",
  disconnect: "extensions:disconnect",
  /** The user agrees again to an item whose tools changed since they agreed (rug-pull protection). */
  reagree: "extensions:reagree",
  /** The user said yes to extensions' first-use card: recorded with FEATURE_CONSENT_VERSION.extensions. */
  agree: "extensions:agree",
} as const;

/** How an extensions action went: `why` is one plain sentence for the page. */
export type ExtensionsDone = { ok: true } | { ok: false; why: string };

/** Extensions as Home shows them. */
export interface ExtensionsState {
  /** This build has the extensions runtime (false: the section says it isn't ready yet). */
  available: boolean;
  /** The organisation allows extensions, and Ember isn't locked down. */
  allowed: boolean;
  installed: Installed[];
  marketplaces: { name: string; source: string }[];
  /** The user agreed to extensions' first-use card at its current version (absent without the runtime). */
  consented?: boolean;
  /** Set when the list couldn't be read: one plain sentence. */
  error?: string;
}

/** A marketplace's entries, or the connectors' catalog. */
export type ExtensionsEntries = { ok: true; entries: MarketplaceEntry[] } | { ok: false; why: string };

/** Connect's outcome: connected, waiting for the user in GitHub's page (opened in the browser), or still pending. */
export type ExtensionsConnect = { ok: true; state: "connected" | "consent" | "pending" } | { ok: false; why: string };

/** The settings window's extensions API (`window.emberExtensions`, app/preload/home.ts). */
export interface EmberExtensionsApi {
  state(): Promise<ExtensionsState>;
  onChanged(fn: () => void): () => void;
  browse(marketplace: string): Promise<ExtensionsEntries>;
  connectors(): Promise<ExtensionsEntries>;
  addMarketplace(source: string): Promise<ExtensionsDone>;
  removeMarketplace(name: string): Promise<ExtensionsDone>;
  install(marketplace: string, name: string): Promise<ExtensionsDone>;
  uninstall(id: string): Promise<ExtensionsDone>;
  setEnabled(id: string, on: boolean): Promise<ExtensionsDone>;
  connect(name: string): Promise<ExtensionsConnect>;
  disconnect(id: string): Promise<ExtensionsDone>;
  reagree(id: string, reviewToken: string): Promise<ExtensionsDone>;
  agree(): Promise<ExtensionsDone>;
}

/**
 * Home's own model provider rows (app/main/provider-ipc.ts): main takes these only from the settings window, checks
 * every argument's type and size, and answers in plain words. The API key travels from the page to main once, in
 * saveKey, and is never sent back: the page hears only whether one is saved.
 */
export const PROVIDER_IPC = {
  /** Whether the user's own provider may be used and is in force, and whether a key is saved (ProviderState). */
  state: "provider:state",
  /** Main says the state changed (a key saved or removed, the connection): the page asks again. */
  changed: "provider:changed",
  saveKey: "provider:save-key",
  removeKey: "provider:remove-key",
  /**
   * The user said yes to the card for this host: main records it (FEATURE_CONSENT_VERSION.provider, with the host) only
   * when the host is the one the endpoint in settings names now. Home's general settings changes never carry the card's
   * record (settingsFromHome drops it).
   */
  agree: "provider:agree",
  /** One small request to the endpoint in settings (its model list), with the saved key: ProviderTest. */
  test: "provider:test",
} as const;

/** The user's own model provider as Home shows it. Never the key itself. */
export interface ProviderState {
  /** The organisation allows a provider of the user's own (no `provider` of its own, `features.userProvider` not false, not locked down). */
  allowed: boolean;
  /** Why it isn't allowed, for the managed note: the organisation's own service is in use, or it is turned off (or locked down). */
  managed: "organisation" | "off" | null;
  /** An API key is saved (encrypted with the keyring). */
  keySaved: boolean;
  /** A key can be kept safely here (a keyring, not basic_text). */
  keyring: boolean;
  /** The user's provider is what Ember uses now: on, agreed to for its host, and allowed. */
  inForce: boolean;
  /** The endpoint's host in settings (with its port), or null when there is no usable address. */
  host: string | null;
  /** The card was agreed to for that host: until then nothing goes there, Test connection included. */
  agreed: boolean;
}

/** How a provider action went: `why` is one plain sentence for the page. */
export type ProviderDone = { ok: true } | { ok: false; why: string };

/** "Test connection": the service answered (`models`: how many it lists, when it says), or why not in one sentence. */
export type ProviderTest = { ok: true; host: string; models: number | null } | { ok: false; why: string };

/** The settings window's provider API (`window.emberProvider`, app/preload/home.ts). */
export interface EmberProviderApi {
  state(): Promise<ProviderState>;
  onChanged(fn: () => void): () => void;
  /** Saves the API key, encrypted (refused without a keyring); it is never sent back. */
  saveKey(key: string): Promise<ProviderDone>;
  removeKey(): Promise<ProviderDone>;
  /** Records the yes to the card for `host` (the endpoint's host in settings now), and turns the provider on. */
  agree(host: string): Promise<ProviderDone>;
  test(): Promise<ProviderTest>;
}
