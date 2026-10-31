import { contextBridge, ipcRenderer } from "electron";
import { IPC, type AskContext, type EmberAskApi } from "../shared/ipc";

const api: EmberAskApi = {
  ask: text => ipcRenderer.send(IPC.ask, text),
  close: () => ipcRenderer.send(IPC.askClose),
  onContext: fn => { ipcRenderer.on(IPC.askContext, (_e, c: AskContext) => fn(c)); },
  onTyped: fn => { ipcRenderer.on(IPC.askTyped, (_e, t: { text: string; submit: boolean; cancel: boolean }) => fn(t)); },
  onHidden: fn => { ipcRenderer.on(IPC.askHidden, () => fn()); },
  fit: rows => ipcRenderer.send(IPC.askFit, rows),
};

contextBridge.exposeInMainWorld("emberAsk", api);
