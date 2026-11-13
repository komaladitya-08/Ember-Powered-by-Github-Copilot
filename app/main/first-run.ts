/**
 * First run's one agreement in main (owner decision of 2026-11-12, CLAUDE.md "Consent"; the rows are decided in
 * app/shared/first-run.ts). Agreeing records CONSENT_VERSION first, so nothing is read, heard or sent before it, and
 * then, one feature at a time and each in its own saved change, what that feature's own card records: commands on this
 * computer through the targets runtime (the card's hash checked against the text the row showed), memory's note,
 * listening with spoken replies, screenshots, and Interactive through the mode's own path (its audit entry, or it
 * isn't in force). A failure part-way leaves each feature either on with its consent or off, and the answer names
 * what couldn't be turned on. It answers only the settings window's own page and takes its arguments as unknown,
 * checked with zod. Plain Node: Electron's objects are injected.
 */

import { z } from "zod";
import { CONSENT_VERSION } from "../shared/consent";
import { FIRST_RUN_IPC, FIRST_RUN_ROWS, firstRunPlan, firstRunRows, type FirstRunCard, type FirstRunChoice, type FirstRunDone, type FirstRunFacts, type FirstRunRow, type FirstRunView } from "../shared/first-run";
import type { Settings, SettingsPatch } from "./settings";
import { consentGiven } from "./targets/consent";

/** What the agreement works through (main.ts builds it over the settings, the policy, the targets and the mode's record). */
export interface FirstRunDeps {
  /** The facts as they are now (read for the view and again when the agreement is pressed). */
  facts(): FirstRunFacts;
  /** The user's current consent is recorded already (nothing to agree to). */
  consented(): boolean;
  /** This computer's commands card as it reads now, or null while it can't be built (or commands are off here). */
  commandsCard(): FirstRunCard | null;
  settings: { own(): Settings; update(patch: SettingsPatch): unknown };
  /** Records the commands card's yes for this computer when `sha256` is the card's as it reads now; false otherwise. */
  agreeCommands(sha256: string): boolean;
  /** Chooses Interactive with its card's version through the mode's own path; true only when it is then in force. */
  chooseInteractive(): boolean;
  now(): Date;
  log?: { warn(event: string, fields?: Record<string, unknown>): void };
}

/** The view the consent step draws: none of the rows once the current consent is recorded. */
export function firstRunView(d: Pick<FirstRunDeps, "facts" | "consented" | "commandsCard">): FirstRunView {
  if (d.consented()) return { rows: [], commands: null };
  const rows = firstRunRows(d.facts());
  return { rows, commands: rows.some(r => r.row === "commands") ? d.commandsCard() : null };
}

/** What a row's own card records, as one settings change (commands and Interactive go through their own paths). */
function patchOn(row: "memory" | "voice" | "screenshots", own: Settings, now: Date): SettingsPatch {
  if (row === "memory") return { memory: { ...own.memory, on: true, consent: consentGiven("memory", now) } };
  // The “Hey Ember” card's yes (Home's consent-yes), with spoken replies on; Voice Match stays as it is (off).
  if (row === "voice") return { wakeWord: true, speak: true, voice: { ...own.voice, consent: true, muted: false } };
  return { screenImages: true };
}

/** What a new user's row turned off leaves: off, with nothing recorded. */
const patchOff = (row: FirstRunRow): SettingsPatch => (row === "voice" ? { wakeWord: false, speak: false } : { screenImages: false });

/**
 * The agreement. `choice`: the switches as the user left them; `commandsSha256`: the hash of the commands card the row
 * showed. The facts are read again now, so a row the policy or the models no longer allow gets nothing.
 */
export function agreeFirstRun(d: FirstRunDeps, choice: FirstRunChoice, commandsSha256: string | null): FirstRunDone {
  if (d.consented()) return { ok: true, failed: [] };
  const plan = firstRunPlan(d.facts(), choice);
  const now = d.now();
  // First, and alone: without it nothing else is recorded or turned on.
  try { d.settings.update({ consent: { version: CONSENT_VERSION, at: now.toISOString() } }); } catch (err) {
    d.log?.warn("first_run.consent_not_saved", { err: err instanceof Error ? err.name : "unknown" });
    return { ok: false, failed: [] };
  }
  const failed: FirstRunRow[] = [];
  for (const row of plan.on) {
    try {
      const ok = row === "commands" ? commandsSha256 !== null && d.agreeCommands(commandsSha256)
        : row === "interactive" ? d.chooseInteractive()
          : (d.settings.update(patchOn(row, d.settings.own(), now)), true);
      if (!ok) failed.push(row);
    } catch (err) {
      d.log?.warn("first_run.row_not_saved", { row, err: err instanceof Error ? err.name : "unknown" });
      failed.push(row);
    }
  }
  for (const row of plan.off) {
    // Off already in force (nothing listens without the card; nothing is sent before a task): only the switch's place.
    try { d.settings.update(patchOff(row)); } catch (err) { d.log?.warn("first_run.off_not_saved", { row, err: err instanceof Error ? err.name : "unknown" }); }
  }
  return { ok: true, failed };
}

/** The agreement's arguments: exactly the five switches and a card's hash (or null). */
export const AgreeArgs = z.tuple([
  z.object(Object.fromEntries(FIRST_RUN_ROWS.map(r => [r, z.boolean()])) as Record<FirstRunRow, z.ZodBoolean>).strict(),
  z.string().regex(/^[0-9a-f]{64}$/).nullable(),
]);

/** The part of Electron's ipcMain these channels use. */
export interface FirstRunIpcMain {
  handle(channel: string, fn: (event: FirstRunIpcEvent, ...args: unknown[]) => unknown): void;
}
/** The part of an invoke event the sender check reads. */
export interface FirstRunIpcEvent { sender: unknown; senderFrame?: { url: string } | null }

/**
 * Registers FIRST_RUN_IPC's handlers. A sender that isn't the settings window is refused with an error (as every Ember
 * handler does); arguments that fail their schema record nothing and answer as a consent that wasn't saved.
 */
export function registerFirstRunIpc(ipcMain: FirstRunIpcMain, isHomeSender: (event: FirstRunIpcEvent) => boolean, d: FirstRunDeps): void {
  ipcMain.handle(FIRST_RUN_IPC.view, (event): FirstRunView => {
    if (!isHomeSender(event)) throw new Error(`untrusted IPC sender on ${FIRST_RUN_IPC.view}`);
    try { return firstRunView(d); } catch (err) {
      d.log?.warn("first_run.view_failed", { err: err instanceof Error ? err.name : "unknown" });
      return { rows: [], commands: null };
    }
  });
  ipcMain.handle(FIRST_RUN_IPC.agree, (event, ...args): FirstRunDone => {
    if (!isHomeSender(event)) throw new Error(`untrusted IPC sender on ${FIRST_RUN_IPC.agree}`);
    const parsed = AgreeArgs.safeParse(args);
    if (!parsed.success) return { ok: false, failed: [] };
    return agreeFirstRun(d, parsed.data[0], parsed.data[1]);
  });
}
