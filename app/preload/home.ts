import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { EXTENSIONS_IPC, IPC, PROVIDER_IPC, type EmberExtensionsApi, type EmberHomeApi, type EmberProviderApi, type Presence, type ReminderRow, type UpdateStatus, type RoutineRow, type SignInProgress, type VoiceStatus, type VoiceWord } from "../shared/ipc";
import type { Settings } from "../main/settings";
import type { HistoryProblemKind } from "../shared/conversation";
import type { AgentStatus, AnswerStream, TranscriptEntry } from "../main/agent/host";
import type { MemoryModelStatus } from "../main/memory/better-recall";
import type { TaskEntry } from "../shared/activity";
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
  recheckSetup: () => ipcRenderer.invoke(IPC.recheckSetup),
  agentStatus: () => ipcRenderer.invoke(IPC.agentStatus),
  projectPick: () => ipcRenderer.invoke(IPC.projectPick),
  projectRemove: name => ipcRenderer.invoke(IPC.projectRemove, name),
  projectExport: kind => ipcRenderer.invoke(IPC.projectExport, kind),
  projectRun: request => ipcRenderer.invoke(IPC.projectRun, request),
  projectClear: () => ipcRenderer.invoke(IPC.projectClear),
  projectCancel: () => ipcRenderer.invoke(IPC.projectCancel),
  projectApply: () => ipcRenderer.invoke(IPC.projectApply),
  projectChooseFolder: () => ipcRenderer.invoke(IPC.projectChooseFolder),
  projectRunCommand: command => ipcRenderer.invoke(IPC.projectRunCommand, command),
  projectWorkspace: input => ipcRenderer.invoke(IPC.projectWorkspace, input),
  onAgentStatus: fn => listen<AgentStatus>(IPC.agentStatusChanged, fn),
  signIn: () => ipcRenderer.invoke(IPC.signIn),
  onSignInProgress: fn => listen<SignInProgress>(IPC.signInProgress, fn),
  signOut: () => ipcRenderer.invoke(IPC.signOut),
  voiceStatus: () => ipcRenderer.invoke(IPC.voiceStatus),
  onVoiceStatus: fn => listen<VoiceStatus>(IPC.voiceStatus, fn),
  listenOnce: on => ipcRenderer.invoke(IPC.listenOnce, on),
  downloadVoice: () => ipcRenderer.invoke(IPC.voiceDownload),
  retryNaturalVoice: () => ipcRenderer.invoke(IPC.voiceNaturalRetry),
  enrolVoice: () => ipcRenderer.invoke(IPC.voiceMatchEnrol),
  cancelEnrolVoice: () => ipcRenderer.invoke(IPC.voiceMatchCancel),
  forgetVoice: () => ipcRenderer.invoke(IPC.voiceMatchForget),
  resetVoice: () => ipcRenderer.invoke(IPC.voiceMatchReset),
  voiceHeard: () => ipcRenderer.invoke(IPC.voiceHeard),
  teachWords: (id, meant) => ipcRenderer.invoke(IPC.voiceTeach, id, meant),
  voiceWords: () => ipcRenderer.invoke(IPC.voiceWords),
  onVoiceWords: fn => listen<VoiceWord[]>(IPC.voiceWords, fn),
  forgetVoiceWord: word => ipcRenderer.invoke(IPC.voiceForgetWord, word),
  forgetVoiceWords: () => ipcRenderer.invoke(IPC.voiceForgetWords),
  memory: () => ipcRenderer.invoke(IPC.memoryList),
  onMemory: fn => listen(IPC.memoryChanged, fn),
  forgetMemory: id => ipcRenderer.invoke(IPC.memoryForget, id),
  forgetAllMemory: () => ipcRenderer.invoke(IPC.memoryForgetAll),
  correctMemory: change => ipcRenderer.invoke(IPC.memoryCorrect, change),
  introduceMe: answers => ipcRenderer.invoke(IPC.memoryIntroduce, answers),
  memoryModel: () => ipcRenderer.invoke(IPC.memoryModel),
  onMemoryModel: fn => listen<MemoryModelStatus>(IPC.memoryModelChanged, fn),
  downloadMemoryModel: () => ipcRenderer.invoke(IPC.memoryModelDownload),
  removeMemoryModel: () => ipcRenderer.invoke(IPC.memoryModelRemove),
  updates: () => ipcRenderer.invoke(IPC.updatesStatus),
  onUpdates: fn => listen<UpdateStatus>(IPC.updatesChanged, fn),
  checkForUpdates: () => ipcRenderer.invoke(IPC.updatesCheck),
  openUpdate: () => ipcRenderer.invoke(IPC.updatesOpen),
  routines: () => ipcRenderer.invoke(IPC.routinesList),
  routinesCount: () => ipcRenderer.invoke(IPC.routinesCount),
  reminders: () => ipcRenderer.invoke(IPC.remindersList),
  onReminders: fn => listen<ReminderRow[]>(IPC.remindersChanged, fn),
  changeReminder: change => ipcRenderer.invoke(IPC.reminderChange, change),
  onRoutines: fn => listen<RoutineRow[]>(IPC.routinesChanged, fn),
  forgetRoutine: id => ipcRenderer.invoke(IPC.routinesForget, id),
  forgetAllRoutines: () => ipcRenderer.invoke(IPC.routinesForgetAll),
  onVoiceProgress: fn => listen<{ done: number; total: number; phase?: "unpacking" }>(IPC.voiceProgress, fn),
  activity: (limit?: number) => ipcRenderer.invoke(IPC.activity, limit),
  retrySignIn: () => ipcRenderer.invoke(IPC.agentRetry),
  cancelSignIn: () => ipcRenderer.invoke(IPC.cancelSignIn),
  openSignInPage: () => ipcRenderer.invoke(IPC.openSignInPage),
  tasks: () => ipcRenderer.invoke(IPC.tasks),
  openApproval: () => ipcRenderer.invoke(IPC.openApproval),
  taskControl: (id, action) => ipcRenderer.invoke(IPC.taskControl, { id, action }),
  onTasks: fn => listen<TaskEntry[]>(IPC.tasksChanged, fn),
  historyProblem: () => ipcRenderer.invoke(IPC.historyProblem),
  onHistoryProblem: fn => listen<HistoryProblemKind | null>(IPC.historyProblemChanged, fn),
  conversation: () => ipcRenderer.invoke(IPC.conversation),
  conversationSend: text => ipcRenderer.invoke(IPC.conversationSend, text),
  conversationStop: () => ipcRenderer.invoke(IPC.conversationStop),
  conversationNew: () => ipcRenderer.invoke(IPC.conversationNew),
  onConversation: fn => listen<TranscriptEntry[]>(IPC.conversationChanged, fn),
  onConversationForgotten: fn => listen<unknown>(IPC.conversationForgotten, () => fn()),
  onConversationStream: fn => listen<AnswerStream>(IPC.conversationStream, fn),
  onFocusSection: fn => listen<string>(IPC.focusSection, fn),
  presence: () => ipcRenderer.invoke(IPC.presence),
  setPresence: p => ipcRenderer.invoke(IPC.setPresence, p),
  onPresence: fn => listen<Presence>(IPC.presenceChanged, fn),
  onSettingsNotice: fn => listen<string | null>(IPC.settingsNotice, fn),
  onVisibility: fn => listen<boolean>(IPC.homeVisibility, v => fn(v !== false)),
  quit: () => ipcRenderer.invoke(IPC.quit),
  openAsk: () => ipcRenderer.invoke(IPC.openAsk),
  stopEverything: () => ipcRenderer.invoke(IPC.stopEverything),
  onStopped: fn => listen<string>(IPC.homeStopped, fn),
  watchLevel: on => ipcRenderer.invoke(IPC.watchLevel, on),
  onLevel: fn => listen<number | null>(IPC.homeLevel, fn),
  copyText: text => ipcRenderer.invoke(IPC.copyText, text),
};

contextBridge.exposeInMainWorld("ember", api);

// Computers and their commands (§8.3): TARGETS_IPC's channels only; main takes them only from this window (isHome).
const targets: EmberTargetsApi = {
  list: () => ipcRenderer.invoke(TARGETS_IPC.list) as Promise<TargetSummary[]>,
  onChanged: fn => listen<TargetSummary[]>(TARGETS_IPC.changed, fn),
  act: a => ipcRenderer.invoke(TARGETS_IPC.act, a),
};
contextBridge.exposeInMainWorld("emberTargets", targets);

// Extensions, plugins and connectors: EXTENSIONS_IPC's channels only; main takes them only from this window and checks
// every argument (app/main/extensions-ipc.ts).
const extensions: EmberExtensionsApi = {
  state: () => ipcRenderer.invoke(EXTENSIONS_IPC.state),
  onChanged: fn => listen<null>(EXTENSIONS_IPC.changed, () => fn()),
  browse: marketplace => ipcRenderer.invoke(EXTENSIONS_IPC.browse, marketplace),
  connectors: () => ipcRenderer.invoke(EXTENSIONS_IPC.connectors),
  addMarketplace: source => ipcRenderer.invoke(EXTENSIONS_IPC.addMarketplace, source),
  removeMarketplace: name => ipcRenderer.invoke(EXTENSIONS_IPC.removeMarketplace, name),
  install: (marketplace, name) => ipcRenderer.invoke(EXTENSIONS_IPC.install, marketplace, name),
  uninstall: id => ipcRenderer.invoke(EXTENSIONS_IPC.uninstall, id),
  setEnabled: (id, on) => ipcRenderer.invoke(EXTENSIONS_IPC.setEnabled, id, on),
  connect: name => ipcRenderer.invoke(EXTENSIONS_IPC.connect, name),
  disconnect: id => ipcRenderer.invoke(EXTENSIONS_IPC.disconnect, id),
  reagree: (id, token) => ipcRenderer.invoke(EXTENSIONS_IPC.reagree, id, token),
  agree: () => ipcRenderer.invoke(EXTENSIONS_IPC.agree),
};
contextBridge.exposeInMainWorld("emberExtensions", extensions);

// The user's own model provider (Home › Copilot): PROVIDER_IPC's channels only; main takes them only from this window and
// checks every argument (app/main/provider-ipc.ts). The key goes to main once and never comes back.
const provider: EmberProviderApi = {
  state: () => ipcRenderer.invoke(PROVIDER_IPC.state),
  onChanged: fn => listen<null>(PROVIDER_IPC.changed, () => fn()),
  saveKey: key => ipcRenderer.invoke(PROVIDER_IPC.saveKey, key),
  removeKey: () => ipcRenderer.invoke(PROVIDER_IPC.removeKey),
  agree: host => ipcRenderer.invoke(PROVIDER_IPC.agree, host),
  test: () => ipcRenderer.invoke(PROVIDER_IPC.test),
};
contextBridge.exposeInMainWorld("emberProvider", provider);
