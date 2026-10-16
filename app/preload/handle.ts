import { contextBridge, ipcRenderer } from "electron";
import { OVERLAY, type HandleApi } from "../shared/overlay";

const on = <T>(channel: string, fn: (v: T) => void) => { ipcRenderer.on(channel, (_e, v: T) => fn(v)); };

const api: HandleApi = {
  onInit: fn => on(OVERLAY.init, fn),
  onSettings: fn => on(OVERLAY.settings, fn),
  onState: fn => on(OVERLAY.state, fn),
  openMenu: () => ipcRenderer.send(OVERLAY.handleMenu),
  bubbleAction: id => ipcRenderer.send(OVERLAY.bubbleAction, id),
  fit: height => ipcRenderer.send(OVERLAY.handleFit, height),
};

contextBridge.exposeInMainWorld("emberHandle", api);
