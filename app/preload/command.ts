/**
 * The command window's preload (§8.5): it bridges only the command window's own channels (COMMANDS_IPC and
 * COMMANDS_EXTRA_IPC, all "commands:*"), and nothing else (critique integration-5). Main takes each message only from
 * this window's webContents; what the user types goes to main for the run and is never logged.
 */

import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { COMMANDS_IPC } from "../shared/commands";
import { COMMAND_CARD_OBSERVATION_RANGES, type CommandCardObservationData } from "../shared/command-card-observation";
import { COMMANDS_EXTRA_IPC, type CommandsApi, type OutputMsg, type Snapshot, type WindowView } from "../renderer/command/model";

const on = <T>(channel: string, fn: (v: T) => void) => { ipcRenderer.on(channel, (_e: IpcRendererEvent, v: T) => fn(v)); };

/** Read data properties only. A malformed observer must never interfere with an existing seen/inView report. */
function data(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  const property = Object.getOwnPropertyDescriptor(value, key);
  return property && Object.hasOwn(property, "value") ? property.value : undefined;
}

function cardSeen(value: unknown): void {
  let original: { n: number; inView: boolean; seen: boolean } | undefined;
  let observation: { n: number; diagnostic: CommandCardObservationData } | undefined;
  try {
    const n = data(value, "n"), inView = data(value, "inView"), seen = data(value, "seen");
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) return;
    // Preserve the original message exactly; do not even inspect an optional diagnostic getter on this path.
    if (typeof inView === "boolean" && typeof seen === "boolean") {
      original = { n, inView, seen };
    } else {
      if (!value || typeof value !== "object" || Reflect.ownKeys(value).length !== 2 || !Object.hasOwn(value, "diagnostic")) return;
      const raw = data(value, "diagnostic");
      if (!raw || typeof raw !== "object" || Reflect.ownKeys(raw).length !== Object.keys(COMMAND_CARD_OBSERVATION_RANGES).length) return;
      const diagnostic: Record<string, number> = {};
      for (const [key, [min, max]] of Object.entries(COMMAND_CARD_OBSERVATION_RANGES)) {
        const field = data(raw, key);
        if (typeof field !== "number" || !Number.isInteger(field) || field < min || field > max) return;
        diagnostic[key] = field;
      }
      observation = { n, diagnostic: diagnostic as unknown as CommandCardObservationData };
    }
  } catch { return; /* An unreadable observer supplies no diagnostic. */ }
  if (original) { ipcRenderer.send(COMMANDS_IPC.cardSeen, original); return; }
  // Observer-only failure is isolated; delivery of an original report keeps its existing return/throw behaviour.
  try { if (observation) ipcRenderer.send(COMMANDS_IPC.cardSeen, observation); } catch { /* No retry or authority. */ }
}

const api: CommandsApi = {
  pull: () => ipcRenderer.invoke(COMMANDS_IPC.state) as Promise<Snapshot | null>,
  onState: fn => on<WindowView>(COMMANDS_IPC.state, fn),
  onOutput: fn => on<OutputMsg>(COMMANDS_IPC.output, fn),
  answer: a => ipcRenderer.send(COMMANDS_IPC.answer, { n: a.n, answer: a.answer, sha256: a.sha256 }),
  stop: runId => ipcRenderer.send(COMMANDS_IPC.stop, { runId }),
  input: (runId, data) => ipcRenderer.send(COMMANDS_IPC.input, { runId, data }),
  cardSeen,
  close: runId => ipcRenderer.send(COMMANDS_IPC.close, { runId }),
  size: s => ipcRenderer.send(COMMANDS_EXTRA_IPC.size, { cols: s.cols, rows: s.rows }),
  closeWindow: stop => ipcRenderer.send(COMMANDS_EXTRA_IPC.closeWindow, { stop: stop === true }),
};

contextBridge.exposeInMainWorld("emberCommands", api);
