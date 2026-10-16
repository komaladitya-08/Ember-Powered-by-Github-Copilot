import { contextBridge, ipcRenderer } from "electron";
import { OVERLAY, type OverlayApi } from "../shared/overlay";

const on = <T>(channel: string, fn: (v: T) => void) => { ipcRenderer.on(channel, (_e, v: T) => fn(v)); };

const api: OverlayApi = {
  onInit: fn => on(OVERLAY.init, fn),
  onFrame: fn => on(OVERLAY.frame, fn),
  onSettings: fn => on(OVERLAY.settings, fn),
  onState: fn => on(OVERLAY.state, fn),
  setInteractive: rects => ipcRenderer.send(OVERLAY.interactive, rects),
  bubbleAction: id => ipcRenderer.send(OVERLAY.bubbleAction, id),
  setCards: rect => ipcRenderer.send(OVERLAY.cards, rect),
};

contextBridge.exposeInMainWorld("emberOverlay", api);
