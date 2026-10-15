import { contextBridge, ipcRenderer } from "electron";
import { IPC, type EmberAskApi } from "../shared/ipc";

const api: EmberAskApi = {
  ask: text => ipcRenderer.send(IPC.ask, text),
  close: () => ipcRenderer.send(IPC.askClose),
};

contextBridge.exposeInMainWorld("emberAsk", api);
