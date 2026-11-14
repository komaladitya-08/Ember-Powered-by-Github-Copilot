/**
 * Home's choice of an approval mode (APPROVALS_IPC.choose) in main, over an injected ApprovalsApi. It answers only the
 * settings window's own page (`isHomeSender`, checked before anything else) and takes its arguments as unknown,
 * checked with zod: exactly one of the three modes and the version of the card the user agreed to. From Home the mode
 * changes only here, together with that agreement (PLAN.md §2 "Approvals"): a general settings change never carries
 * it (windows.ts settingsFromHome), and no model has a tool for it. Plain Node: Electron's objects are injected.
 */

import { z } from "zod";
import { APPROVALS_IPC, APPROVAL_MODES, type ApprovalMode, type ApprovalsDone, type ApprovalsState } from "../shared/approvals";

/** What main does for the channels (main.ts builds it over the settings, the policy and the mode's record). */
export interface ApprovalsApi {
  state(): ApprovalsState;
  /**
   * Records the agreement to `mode`'s card (`version`: the one the user read) and chooses the mode, in one change; main
   * refuses a card that isn't the one in force now, a mode it doesn't offer and what the organisation doesn't allow.
   */
  choose(mode: ApprovalMode, version: number): ApprovalsDone;
}

/** The part of Electron's ipcMain these channels use. */
export interface ApprovalsIpcMain {
  handle(channel: string, fn: (event: ApprovalsIpcEvent, ...args: unknown[]) => unknown): void;
}
/** The part of an invoke event the sender check reads. */
export interface ApprovalsIpcEvent { sender: unknown; senderFrame?: { url: string } | null }

/** choose's arguments: exactly a mode's name and a card's version (a small whole number). */
export const ChooseArgs = z.tuple([z.enum(APPROVAL_MODES), z.number().int().min(1).max(10_000)]);

/**
 * Registers APPROVALS_IPC.choose's handler. A sender that isn't the settings window is refused with an error (as every
 * Ember handler does). Arguments that fail their schema change nothing: the answer is that of a mode Ember doesn't
 * offer, with the state as it stands. A failure below (a save that failed) answers as a choice that couldn't be
 * recorded, its error going to the log by name.
 */
export function registerApprovalsIpc(
  ipcMain: ApprovalsIpcMain,
  isHomeSender: (event: ApprovalsIpcEvent) => boolean,
  api: ApprovalsApi,
  opts: { log?: { warn(event: string, fields?: Record<string, unknown>): void } } = {},
): void {
  ipcMain.handle(APPROVALS_IPC.choose, (event, ...args): ApprovalsDone => {
    if (!isHomeSender(event)) throw new Error(`untrusted IPC sender on ${APPROVALS_IPC.choose}`);
    const parsed = ChooseArgs.safeParse(args);
    if (!parsed.success) return { ok: false, why: "unavailable", state: api.state() };
    try {
      return api.choose(...parsed.data);
    } catch (err) {
      opts.log?.warn("approvals.ipc_failed", { err: err instanceof Error ? err.name : "unknown" });
      return { ok: false, why: "not-recorded", state: api.state() };
    }
  });
}
