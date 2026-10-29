import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type EmberHomeApi, type Presence, type SignInProgress, type VoiceStatus } from "../shared/ipc";
import type { Settings } from "../main/settings";
import type { AgentStatus, TranscriptEntry } from "../main/agent/host";
import { TARGETS_IPC, type TargetSummary } from "../shared/targets";
import type { EmberTargetsApi } from "../renderer/home/computers-copy";

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
  onVoiceProgress: fn => listen<{ done: number; total: number; phase?: "unpacking" }>(IPC.voiceProgress, fn),
  activity: () => ipcRenderer.invoke(IPC.activity),
  retrySignIn: () => ipcRenderer.invoke(IPC.agentRetry),
  cancelSignIn: () => ipcRenderer.invoke(IPC.cancelSignIn),
  openSignInPage: () => ipcRenderer.invoke(IPC.openSignInPage),
  conversation: () => ipcRenderer.invoke(IPC.conversation),
  onConversation: fn => listen<TranscriptEntry[]>(IPC.conversationChanged, fn),
  onFocusSection: fn => listen<string>(IPC.focusSection, fn),
  presence: () => ipcRenderer.invoke(IPC.presence),
  setPresence: p => ipcRenderer.invoke(IPC.setPresence, p),
  onPresence: fn => listen<Presence>(IPC.presenceChanged, fn),
  onSettingsNotice: fn => listen<string | null>(IPC.settingsNotice, fn),
  onVisibility: fn => listen<boolean>(IPC.homeVisibility, v => fn(v !== false)),
  quit: () => ipcRenderer.invoke(IPC.quit),
  openAsk: () => ipcRenderer.invoke(IPC.openAsk),
  stopEverything: () => ipcRenderer.invoke(IPC.stopEverything),
};

contextBridge.exposeInMainWorld("ember", api);

// Computers and their commands (§8.3): TARGETS_IPC's channels only; main takes them only from this window (isHome).
const targets: EmberTargetsApi = {
  list: () => ipcRenderer.invoke(TARGETS_IPC.list) as Promise<TargetSummary[]>,
  onChanged: fn => listen<TargetSummary[]>(TARGETS_IPC.changed, fn),
  act: a => ipcRenderer.invoke(TARGETS_IPC.act, a),
};
contextBridge.exposeInMainWorld("emberTargets", targets);
