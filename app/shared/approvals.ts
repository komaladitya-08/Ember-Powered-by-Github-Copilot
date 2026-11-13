/**
 * The approval modes as main and the settings window both name them (PLAN.md §2 "Approvals", owner decision of
 * 2026-11-12): one choice of Interactive, Assisted and Autopilot, each agreed to on a card of its own. Which mode is in
 * force is main's to decide (app/main/policy/autonomy.ts), never a page's: Home is told (ApprovalsState) and draws it.
 * Pure and renderer-safe.
 */

import { FEATURE_CONSENT_VERSION } from "./consent";

/** The modes, from the one that asks most to the one that asks least. */
export const APPROVAL_MODES = ["interactive", "assisted", "autopilot"] as const;
export type ApprovalMode = (typeof APPROVAL_MODES)[number];

/**
 * What is in force: a mode, or "asking", below Interactive, where Ember asks before ordinary steps as it did before
 * the modes. "asking" is never a choice: it holds while no card is agreed to or the organisation keeps Ember there.
 */
export type ModeInForce = "asking" | ApprovalMode;

/** Each mode's card: its entry in FEATURE_CONSENT_VERSION (Interactive's is `autonomy`, Work without asking's before it). */
export const MODE_CARD = { interactive: "autonomy", assisted: "assisted", autopilot: "autopilot" } as const satisfies Record<ApprovalMode, keyof typeof FEATURE_CONSENT_VERSION>;

/** The version of `mode`'s card that an agreement must carry now. */
export const modeCardVersion = (mode: ApprovalMode): number => FEATURE_CONSENT_VERSION[MODE_CARD[mode]];

/** How far a mode goes: "asking" 0, then the modes in order. An unknown value ranks with "asking" (fail closed). */
export const modeRank = (mode: unknown): number => APPROVAL_MODES.indexOf(mode as ApprovalMode) + 1;

/**
 * Why the mode in force is below the one chosen: the organisation keeps Ember below Interactive (`organisation`) or caps
 * the mode (`cap`), turned Assisted's check off (`check-off`), the choice couldn't be recorded (`not-recorded`: the
 * in-memory hold), the card of the chosen mode isn't agreed to as it reads now (`card`), or Ember doesn't offer the
 * chosen mode (`unavailable`: a settings.json edited by hand).
 */
export type ModeWhy = "organisation" | "cap" | "check-off" | "not-recorded" | "card" | "unavailable";

/** The approval modes as Home is told of them (with each status, pushed on APPROVALS_IPC.changed, and with the answer to a choice). */
export interface ApprovalsState {
  /** The mode the user chose: their own setting, without the administrator's cap. */
  chosen: ApprovalMode;
  /** The mode in force now. */
  inForce: ModeInForce;
  /** Why it is below the chosen one; null when it is the chosen one. */
  why: ModeWhy | null;
  /** The modes Home offers a row for, in order. */
  offered: ApprovalMode[];
  /** The modes whose card is agreed to as it reads now. */
  agreed: ApprovalMode[];
  /** The highest mode the organisation allows; null without a cap. */
  cap: ApprovalMode | null;
  /** The organisation turned Assisted's check off (`features.aiReview: false`): Assisted can't be chosen, and its row says so. */
  checkOff?: true;
}

/**
 * What a choice came to: the state after it, and when it wasn't made, why (Home words it: copy.ts modeRefusal).
 * `not-recorded`: it couldn't be saved or written to the audit log, so it was undone.
 */
export type ApprovalsDone = { ok: true; state: ApprovalsState } | { ok: false; why: ModeWhy; state: ApprovalsState };

/** Home's channels for the mode: main takes them only from the settings window (app/main/approvals-ipc.ts). */
export const APPROVALS_IPC = {
  /** Main says the modes stand differently (ApprovalsState): a choice, a hand edit, the policy, a change that couldn't be recorded. */
  changed: "approvals:changed",
  /**
   * The user said yes to a mode's card: the mode and the card's version they read. Main records the agreement and
   * chooses the mode in one change, or refuses (a card that changed, a mode it doesn't offer, the organisation's limit).
   */
  choose: "approvals:choose",
} as const;
