/**
 * The command window's preload (§8.5): it bridges only the command window's own channels (COMMANDS_IPC and
 * COMMANDS_EXTRA_IPC, all "commands:*"), and nothing else (critique integration-5). Main takes each message only from
 * this window's webContents; what the user types goes to main for the run and is never logged.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { COMMANDS_IPC } from "../shared/commands";
import { COMMANDS_EXTRA_IPC, type CommandsApi, type OutputMsg, type Snapshot, type WindowView } from "../renderer/command/model";

const on = <T>(channel: string, fn: (v: T) => void) => { ipcRenderer.on(channel, (_e: IpcRendererEvent, v: T) => fn(v)); };

const api: CommandsApi = {
  pull: () => ipcRenderer.invoke(COMMANDS_IPC.state) as Promise<Snapshot | null>,
  onState: fn => on<WindowView>(COMMANDS_IPC.state, fn),
  onOutput: fn => on<OutputMsg>(COMMANDS_IPC.output, fn),
  answer: a => ipcRenderer.send(COMMANDS_IPC.answer, { n: a.n, answer: a.answer, sha256: a.sha256 }),
  stop: runId => ipcRenderer.send(COMMANDS_IPC.stop, { runId }),
  input: (runId, data) => ipcRenderer.send(COMMANDS_IPC.input, { runId, data }),
  cardSeen: m => ipcRenderer.send(COMMANDS_IPC.cardSeen, { n: m.n, inView: m.inView, seen: m.seen }),
  close: runId => ipcRenderer.send(COMMANDS_IPC.close, { runId }),
  size: s => ipcRenderer.send(COMMANDS_EXTRA_IPC.size, { cols: s.cols, rows: s.rows }),
  closeWindow: stop => ipcRenderer.send(COMMANDS_EXTRA_IPC.closeWindow, { stop: stop === true }),
};

contextBridge.exposeInMainWorld("emberCommands", api);
