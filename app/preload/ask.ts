import { contextBridge, ipcRenderer } from "electron";
import { IPC, type AskContext, type EmberAskApi } from "../shared/ipc";

const api: EmberAskApi = {
  ask: text => ipcRenderer.send(IPC.ask, text),
  close: () => ipcRenderer.send(IPC.askClose),
  onContext: fn => { ipcRenderer.on(IPC.askContext, (_e, c: AskContext) => fn(c)); },
};

contextBridge.exposeInMainWorld("emberAsk", api);
