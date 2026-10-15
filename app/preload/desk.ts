import { contextBridge, ipcRenderer } from "electron";
import { DESK, type DeskViewApi } from "../shared/desk";

const api: DeskViewApi = {
  onFrame: fn => { ipcRenderer.on(DESK.frame, (_e, f) => fn(f)); },
  onMode: fn => { ipcRenderer.on(DESK.mode, (_e, m) => fn(m)); },
  takeOver: () => ipcRenderer.send(DESK.takeOver),
  handBack: () => ipcRenderer.send(DESK.handBack),
  hide: () => ipcRenderer.send(DESK.hide),
  input: e => ipcRenderer.send(DESK.input, e),
};

contextBridge.exposeInMainWorld("emberDesk", api);
