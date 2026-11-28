/**
 * The coding window's preload (docs/CODING-APP.md §2): `window.emberCode`, exactly the EmberCodeApi of
 * app/shared/code.ts, over CODE_IPC. Nothing else of Electron reaches the page. What main sends is passed on as it
 * came (main has redacted and bounded it); a listener's own failure never stops the others.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { CODE_IPC, type EmberCodeApi } from "../shared/code";

/** Subscribes `listener` to a main → window channel; returns how to unsubscribe. */
function listen<T>(channel: string, listener: (value: T) => void): () => void {
  const on = (_e: IpcRendererEvent, value: T) => { try { listener(value); } catch { /* the page's own failure */ } };
  ipcRenderer.on(channel, on);
  return () => { ipcRenderer.removeListener(channel, on); };
}

const api: EmberCodeApi = {
  list: () => ipcRenderer.invoke(CODE_IPC.list),
  addProject: () => ipcRenderer.invoke(CODE_IPC.addProject),
  removeProject: projectId => ipcRenderer.invoke(CODE_IPC.removeProject, projectId),
  create: options => ipcRenderer.invoke(CODE_IPC.create, options),
  attach: (sessionId, sinceSeq) => (sinceSeq === undefined ? ipcRenderer.invoke(CODE_IPC.attach, sessionId) : ipcRenderer.invoke(CODE_IPC.attach, sessionId, sinceSeq)),
  detach: sessionId => { ipcRenderer.send(CODE_IPC.detach, sessionId); },
  send: message => ipcRenderer.invoke(CODE_IPC.send, message),
  interrupt: (sessionId, options) => (options === undefined ? ipcRenderer.invoke(CODE_IPC.interrupt, sessionId) : ipcRenderer.invoke(CODE_IPC.interrupt, sessionId, options)),
  stopAll: () => { ipcRenderer.send(CODE_IPC.stopAll); },
  respond: answer => ipcRenderer.invoke(CODE_IPC.respond, answer),
  setPermissionMode: (sessionId, mode) => ipcRenderer.invoke(CODE_IPC.setPermissionMode, sessionId, mode),
  setAgentMode: (sessionId, mode) => ipcRenderer.invoke(CODE_IPC.setAgentMode, sessionId, mode),
  update: (sessionId, change) => ipcRenderer.invoke(CODE_IPC.update, sessionId, change),
  fork: (sessionId, options) => (options === undefined ? ipcRenderer.invoke(CODE_IPC.fork, sessionId) : ipcRenderer.invoke(CODE_IPC.fork, sessionId, options)),
  remove: sessionId => ipcRenderer.invoke(CODE_IPC.remove, sessionId),
  pickAttachments: sessionId => ipcRenderer.invoke(CODE_IPC.pickAttachments, sessionId),
  rpc: call => ipcRenderer.invoke(CODE_IPC.rpc, call),
  onEvent: listener => listen(CODE_IPC.event, listener),
  onRow: listener => listen(CODE_IPC.row, listener),
  onRequest: listener => listen(CODE_IPC.request, listener),
  openLink: url => ipcRenderer.invoke(CODE_IPC.openLink, url),
  markRead: sessionId => { ipcRenderer.send(CODE_IPC.markRead, sessionId); },
  onMicHeld: listener => {
    try { listener(micHeld); } catch { /* the page's own failure */ }
    return listen<unknown>(CODE_IPC.micHeld, v => { listener(v === true); });
  },
};

// The latest word of the microphone, kept from before the page subscribes (main sends it as the window loads).
let micHeld = false;
ipcRenderer.on(CODE_IPC.micHeld, (_e, v: unknown) => { micHeld = v === true; });

contextBridge.exposeInMainWorld("emberCode", api);
