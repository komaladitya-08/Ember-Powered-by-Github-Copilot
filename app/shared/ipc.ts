/** IPC channel names and payload types shared by main, preload and renderers. */

import type { EnvReport } from "../main/environment";
import type { Settings, SettingsPatch } from "../main/settings";
import type { AgentStatus } from "../main/agent/host";
import type { MicState } from "./voice";

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
} as const;

export interface SignInProgress {
  state: "code" | "done" | "error" | "unavailable";
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
}

export interface EmberAskApi {
  ask(text: string): void;
  close(): void;
}
