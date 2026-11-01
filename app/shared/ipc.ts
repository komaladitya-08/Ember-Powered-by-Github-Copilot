/** IPC channel names and payload types shared by main, preload and renderers. */

import type { EnvReport, FixId, TargetFixId } from "../main/environment";
import type { Settings, SettingsPatch } from "../main/settings";
import type { AgentStatus, TranscriptEntry } from "../main/agent/host";
import type { MicState } from "./voice";
import type { AdminPolicy } from "../main/admin";
import type { OS, ShortcutId, ShownShortcut } from "./shortcuts";
import type { TargetSummary } from "./targets";

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
  askClose: "agent:ask-close",
  activity: "ember:activity",
  /** "Check again": look for a sign-in once more and reconnect. */
  agentRetry: "agent:retry",
  cancelSignIn: "agent:cancel-sign-in",
  /** Opens GitHub's device page for the sign-in code shown (only https://github.com/…). */
  openSignInPage: "agent:open-sign-in-page",
  conversation: "agent:conversation",
  conversationChanged: "agent:conversation-changed",
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

export interface VoiceStatus {
  state: MicState;
  detail: string | null;
  modelsReady: boolean;
  modelsBytes: number;
  /** Ember tried to speak and no voice started: the computer has none (review #101). */
  speechMissing?: boolean;
  /** Voice Match: whether a voiceprint is kept (`enrolled`) and in use (`on`), and enrolment's progress while it runs. */
  match?: VoiceMatchStatus;
}

export interface VoiceMatchStatus {
  enrolled: boolean;
  on: boolean;
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

export interface EmberHomeApi {
  getStatus(): Promise<Status>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  onSettingsChanged(fn: (s: Settings) => void): () => void;
  /** Applies a fix offered by a setup check; returns the new report. */
  applyFix(fix: NonNullable<EnvReport["checks"][number]["fix"]>): Promise<EnvReport>;
  agentStatus(): Promise<AgentStatus>;
  onAgentStatus(fn: (s: AgentStatus) => void): () => void;
  signIn(): Promise<void>;
  onSignInProgress(fn: (p: SignInProgress) => void): () => void;
  signOut(): Promise<void>;
  voiceStatus(): Promise<VoiceStatus>;
  onVoiceStatus(fn: (s: VoiceStatus) => void): () => void;
  downloadVoice(): Promise<void>;
  /** Voice Match: starts teaching Ember the owner's voice (false: Ember isn't listening, so it can't), or stops; forgets the voiceprint. */
  enrolVoice(): Promise<boolean>;
  cancelEnrolVoice(): Promise<void>;
  forgetVoice(): Promise<void>;
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
  /** Stops everything, as the handle menu's Stop everything does. */
  stopEverything(): Promise<void>;
  cancelSignIn(): Promise<void>;
  /** Opens GitHub's page where the sign-in code is entered (again). */
  openSignInPage(): Promise<void>;
  /** This session's conversation (kept in memory only). */
  conversation(): Promise<TranscriptEntry[]>;
  onConversation(fn: (entries: TranscriptEntry[]) => void): () => void;
  onFocusSection(fn: (section: string) => void): () => void;
  /** The window was minimised or hidden (false), or shown again (true): nothing is drawn while it can't be seen. */
  onVisibility(fn: (visible: boolean) => void): () => void;
}

export interface Presence { hidden: boolean; paused: boolean; overlay: boolean }

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
}

export interface EmberAskApi {
  ask(text: string): void;
  close(): void;
  onContext(fn: (c: AskContext) => void): void;
  /** Text typed before the box had the keyboard: it goes in the box (Enter sends it, Esc closes the box). */
  onTyped(fn: (t: { text: string; submit: boolean; cancel: boolean }) => void): void;
  /** The box went away (nothing can be typed in it now): what was left in the field is selected for the next opening. */
  onHidden(fn: () => void): void;
  /** The page needs `rows` rows (the field's 1 to 4 lines, and one for the note when a paste was cut): the box grows to fit. */
  fit?(rows: number): void;
}
