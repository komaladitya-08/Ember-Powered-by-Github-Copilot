/**
 * The prompt window's preload (§8.6): it bridges only PROMPT_IPC's channels ("prompt:*"), nothing else (critique
 * integration-5). Main takes an answer only from this window's page and only for the card on screen; a secret typed
 * here goes to main once, for ssh, and is never logged.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { PROMPT_IPC, type PromptCard } from "../shared/remote-ui";
import type { PromptApi } from "../renderer/prompt/api";

const api: PromptApi = {
  pull: () => ipcRenderer.invoke(PROMPT_IPC.show) as Promise<PromptCard | null>,
  onShow: fn => { ipcRenderer.on(PROMPT_IPC.show, (_e: IpcRendererEvent, card: PromptCard | null) => fn(card)); },
  answer: a => ipcRenderer.send(PROMPT_IPC.answer, { id: a.id, ok: a.ok, ...(a.value !== undefined ? { value: a.value } : {}), ...(a.sha256 !== undefined ? { sha256: a.sha256 } : {}) }),
  cancel: id => ipcRenderer.send(PROMPT_IPC.cancel, { id }),
};

contextBridge.exposeInMainWorld("emberPrompt", api);
