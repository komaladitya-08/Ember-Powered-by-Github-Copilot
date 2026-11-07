import { contextBridge, ipcRenderer } from "electron";
import { IPC, type AskContext, type EmberAskApi, type ListenOnceStatus } from "../shared/ipc";

const api: EmberAskApi = {
  ask: text => ipcRenderer.send(IPC.ask, text),
  askSuggestion: text => ipcRenderer.send(IPC.askSuggestion, text),
  close: () => ipcRenderer.send(IPC.askClose),
  onContext: fn => { ipcRenderer.on(IPC.askContext, (_e, c: AskContext) => fn(c)); },
  listenOnce: on => ipcRenderer.invoke(IPC.listenOnce, on),
  onListenOnce: fn => { ipcRenderer.on(IPC.listenOnceStatus, (_e, status: ListenOnceStatus) => fn(status)); },
  onTyped: fn => { ipcRenderer.on(IPC.askTyped, (_e, t: { text: string; submit: boolean; cancel: boolean }) => fn(t)); },
  onHidden: fn => { ipcRenderer.on(IPC.askHidden, () => fn()); },
  fit: rows => ipcRenderer.send(IPC.askFit, rows),
  voiceSettings: () => ipcRenderer.send(IPC.askVoiceSettings),
  shape: rects => ipcRenderer.send(IPC.askShape, rects),
};

contextBridge.exposeInMainWorld("emberAsk", api);
