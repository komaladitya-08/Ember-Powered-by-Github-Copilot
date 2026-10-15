/** IPC channel names and payload types shared by main, preload and renderers. */

import type { EnvReport } from "../main/environment";
import type { Settings, SettingsPatch } from "../main/settings";

export const IPC = {
  getStatus: "ember:get-status",
  updateSettings: "ember:update-settings",
  settingsChanged: "ember:settings-changed",
} as const;

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
}
