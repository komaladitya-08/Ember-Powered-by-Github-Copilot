/** IPC channel names and payload types shared by main, preload and renderers. */

import type { EnvReport } from "../main/environment";
import type { Settings, SettingsPatch } from "../main/settings";
import type { AgentStatus, TranscriptEntry } from "../main/agent/host";
import type { MicState } from "./voice";
import type { AdminPolicy } from "../main/admin";

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
  askClose: "agent:ask-close",
  activity: "ember:activity",
  /** "Check again": look for a sign-in once more and reconnect. */
  agentRetry: "agent:retry",
  cancelSignIn: "agent:cancel-sign-in",
  conversation: "agent:conversation",
  conversationChanged: "agent:conversation-changed",
  /** Main asks the settings window to show one of its sections ("conversation", "copilot", "privacy"). */
  focusSection: "ember:focus-section",
  /** The ask box: what Ember will read when you ask (shown as a chip), and your earlier questions. */
  askContext: "agent:ask-context",
  /** Hide/show Ember and stay put/follow, from the settings window (the handle menu isn't keyboard-reachable). */
  presence: "ember:presence",
  setPresence: "ember:set-presence",
  presenceChanged: "ember:presence-changed",
  quit: "ember:quit",
} as const;

export interface SignInProgress {
  /** "waiting": watching for a GitHub CLI sign-in (gh auth login), no restart needed. */
  state: "code" | "done" | "error" | "unavailable" | "waiting" | "cancelled";
  userCode?: string;
  verificationUri?: string;
  message?: string;
}

export interface VoiceStatus {
  state: MicState;
  detail: string | null;
  modelsReady: boolean;
  modelsBytes: number;
}

export interface Status {
  appVersion: string;
  settings: Settings;
  environment: EnvReport;
  logFile: string;
  /** The administrator's policy in force, if any. */
  admin: {
    source: string | null;
    /** The policy file is broken, so Ember is locked down. */
    error: string | null;
    /** Settings the administrator decides. */
    managed: string[];
    features: AdminPolicy["features"];
    /** The organisation's own model endpoint, when set. */
    provider: string | null;
    confirmEveryAction: boolean;
    allowGrants: boolean;
    retentionDays: number;
    /** Never-look entries the administrator set: shown locked; they never go into the user's own list. */
    neverLook: string[];
  };
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
  onVoiceProgress(fn: (p: { done: number; total: number }) => void): () => void;
  /** The newest audit entries, newest first. */
  activity(): Promise<ActivityEntry[]>;
  /** Look for a sign-in again (e.g. after gh auth login) and reconnect; says whether one was found and where. */
  retrySignIn(): Promise<{ found: boolean; source: string | null }>;
  /** Ember beside the cursor or hidden, following or staying put (`overlay` false: no compositor, Ember lives in the corner card). */
  presence(): Promise<Presence>;
  setPresence(p: Partial<Pick<Presence, "hidden" | "paused">>): Promise<Presence>;
  onPresence(fn: (p: Presence) => void): () => void;
  /** Quit Ember (asks first while tasks are running). */
  quit(): Promise<void>;
  cancelSignIn(): Promise<void>;
  /** This session's conversation (kept in memory only). */
  conversation(): Promise<TranscriptEntry[]>;
  onConversation(fn: (entries: TranscriptEntry[]) => void): () => void;
  onFocusSection(fn: (section: string) => void): () => void;
}

export interface Presence { hidden: boolean; paused: boolean; overlay: boolean }

/** What the ask box shows: where Ember will look, and the user's recent questions (newest last). */
export interface AskContext {
  /** e.g. "Mousepad · notes.txt · 12 words selected", or null when Ember can't read the screen. */
  sees: string | null;
  history: string[];
}

export interface EmberAskApi {
  ask(text: string): void;
  close(): void;
  onContext(fn: (c: AskContext) => void): void;
}
