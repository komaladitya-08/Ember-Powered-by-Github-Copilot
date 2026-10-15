import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type EmberHomeApi, type SignInProgress, type VoiceStatus } from "../shared/ipc";
import type { Settings } from "../main/settings";
import type { AgentStatus } from "../main/agent/host";

const listen = <T>(channel: string, fn: (v: T) => void) => {
  const handler = (_e: IpcRendererEvent, v: T) => fn(v);
  ipcRenderer.on(channel, handler);
  return () => { ipcRenderer.removeListener(channel, handler); };
};

const api: EmberHomeApi = {
  getStatus: () => ipcRenderer.invoke(IPC.getStatus),
  updateSettings: patch => ipcRenderer.invoke(IPC.updateSettings, patch),
  onSettingsChanged: fn => listen<Settings>(IPC.settingsChanged, fn),
  applyFix: fix => ipcRenderer.invoke(IPC.applyFix, fix),
  agentStatus: () => ipcRenderer.invoke(IPC.agentStatus),
  onAgentStatus: fn => listen<AgentStatus>(IPC.agentStatusChanged, fn),
  signIn: () => ipcRenderer.invoke(IPC.signIn),
  onSignInProgress: fn => listen<SignInProgress>(IPC.signInProgress, fn),
  signOut: () => ipcRenderer.invoke(IPC.signOut),
  voiceStatus: () => ipcRenderer.invoke(IPC.voiceStatus),
  onVoiceStatus: fn => listen<VoiceStatus>(IPC.voiceStatus, fn),
  downloadVoice: () => ipcRenderer.invoke(IPC.voiceDownload),
  onVoiceProgress: fn => listen<{ done: number; total: number }>(IPC.voiceProgress, fn),
};

contextBridge.exposeInMainWorld("ember", api);
