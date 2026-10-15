import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type EmberHomeApi } from "../shared/ipc";
import type { Settings } from "../main/settings";

const api: EmberHomeApi = {
  getStatus: () => ipcRenderer.invoke(IPC.getStatus),
  updateSettings: patch => ipcRenderer.invoke(IPC.updateSettings, patch),
  onSettingsChanged: fn => {
    const handler = (_e: IpcRendererEvent, s: Settings) => fn(s);
    ipcRenderer.on(IPC.settingsChanged, handler);
    return () => ipcRenderer.removeListener(IPC.settingsChanged, handler);
  },
};

contextBridge.exposeInMainWorld("ember", api);
