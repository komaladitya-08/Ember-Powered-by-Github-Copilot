/** IPC channel names and payload types shared by main, preload and renderers. */

import type { EnvReport } from "../main/environment";
import type { Settings, SettingsPatch } from "../main/settings";
import type { AgentStatus } from "../main/agent/host";

export const IPC = {
  getStatus: "ember:get-status",
  updateSettings: "ember:update-settings",
  settingsChanged: "ember:settings-changed",
  agentStatus: "agent:status",
  agentStatusChanged: "agent:status-changed",
  signIn: "agent:sign-in",
  signInProgress: "agent:sign-in-progress",
  signOut: "agent:sign-out",
  ask: "agent:ask",
  askClose: "agent:ask-close",
} as const;

export interface SignInProgress {
  state: "code" | "done" | "error" | "unavailable";
  userCode?: string;
  verificationUri?: string;
  message?: string;
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
  agentStatus(): Promise<AgentStatus>;
  onAgentStatus(fn: (s: AgentStatus) => void): () => void;
  signIn(): Promise<void>;
  onSignInProgress(fn: (p: SignInProgress) => void): () => void;
  signOut(): Promise<void>;
}

export interface EmberAskApi {
  ask(text: string): void;
  close(): void;
}
