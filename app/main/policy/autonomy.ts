/**
 * The approval modes (owner decision of 2026-11-12, PLAN.md §2 "Approvals" and §10): one choice of Interactive, Assisted
 * and Autopilot replaces "Work without asking" and Home's two narrower switches. In Interactive an ordinary step that
 * would have asked only because it is the first in an app, uses the borrowed mouse and keyboard, or carries text from
 * another window is announced instead (a line in the bubble and the task's card, and an audit entry marked `autonomy`):
 * what Work without asking did with every scope on, plus the app switch. It never touches what policy finds risky
 * (sending, deleting, paying, security settings, destructive keys, secrets…), which asks every time with no "Always",
 * nor any hard "never". Assisted adds a check of such a question against the user's own words; Autopilot announces
 * every question instead of asking it, but for the few commands that still ask there, and keeps every "never".
 *
 * Fail closed: a mode is in force only with its own card agreed to as it reads now (FEATURE_CONSENT_VERSION) and only
 * where the administrator allows it; otherwise Ember is below Interactive ("asking") and asks as it did before the
 * modes. Every consumer reads the mode through modeInForce and its inputs through approvalInputs, so none can miss a
 * rule. A task that something on screen tried to steer, or whose step came up unasked, or where the user already said
 * no, asks as before (worker.ts). Pure but for the hold, so it is unit-tested without Electron.
 */

import { APPROVAL_MODES, modeCardVersion, modeRank, type ApprovalMode, type ApprovalsState, type ModeInForce, type ModeWhy } from "../../shared/approvals";

export { APPROVAL_MODES, type ApprovalMode, type ModeInForce };

/** What an ordinary step may need waived: using apps, ordinary commands, the borrowed mouse and keyboard, moving text between apps. */
export type AutonomyScope = "apps" | "commands" | "cursor" | "crossWindow";
export type AutonomyScopes = Record<AutonomyScope, boolean>;

/** All four on: what Interactive and the modes above it give. */
export const ALL_SCOPES: Readonly<AutonomyScopes> = Object.freeze({ apps: true, commands: true, cursor: true, crossWindow: true });

/** The setting as settings.ts keeps it: the mode chosen, and each mode's card as agreed to. */
export interface ApprovalsSetting {
  mode: ApprovalMode;
  consent: Record<ApprovalMode, { version: number; at: string | null }>;
}

/** The administrator's switches that bear on it (AdminPolicy's, structurally: this module loads without admin.ts). */
export interface AutonomyAdmin {
  features: { autonomy?: boolean; actions?: boolean; aiReview?: boolean };
  allowGrants: boolean;
  confirmEveryAction: boolean;
  /** The highest mode users may choose (`approvals.maxMode`): it can only lower the mode. */
  approvals?: { maxMode?: ApprovalMode };
}

/** Has the user agreed to `mode`'s own card as it reads now? */
export const modeAgreed = (s: Pick<ApprovalsSetting, "consent"> | undefined, mode: ApprovalMode): boolean =>
  (s?.consent?.[mode]?.version ?? 0) >= modeCardVersion(mode);

/** May the organisation's users have a mode at all (the same rule as admin.ts autonomyAllowed)? Not: Ember is below Interactive. */
export const autonomyPermitted = (admin: AutonomyAdmin | null | undefined): boolean =>
  !admin || (admin.features.autonomy !== false && admin.allowGrants !== false && !admin.confirmEveryAction && admin.features.actions !== false);

/**
 * May Autopilot be in force under this administrator's policy at all: its switches for a mode, and its cap? What a
 * computer reached over SSH asks of its own policy before it lets the PC's Autopilot stand in for the user's yes
 * (app/remote/gate.ts): that policy holds there as the organisation's.
 */
export const autopilotPermitted = (admin: AutonomyAdmin | null | undefined): boolean =>
  autonomyPermitted(admin) && (admin?.approvals?.maxMode ?? "autopilot") === "autopilot";

/** The modes Home offers a row and a card for, and the only ones its choice may name (chooseMode). */
export const OFFERED_MODES: readonly ApprovalMode[] = ["interactive", "assisted", "autopilot"];

/** The modes that can be in force: a mode named in settings.json that isn't one of these is Interactive at most. */
const BUILT: readonly ApprovalMode[] = ["interactive", "assisted", "autopilot"];

/**
 * Held below Interactive in memory (PR #193 review): a mode that asks less that couldn't be audited and couldn't be
 * undone on disk either (disk full, folder unwritable) must not be in force, whatever settings.json says. Every
 * consumer goes through modeInForce, so none can miss it. SettingsStore stays as it is (it never invents a value it
 * didn't save).
 */
let held = false;
/** Keep Ember below Interactive in this process until {@link releaseAutonomyHold}. */
export const holdAutonomyOff = (): void => { held = true; };
/** Called once the mode the settings give is recorded, or is no higher than the one that was (policy/mode-record.ts). */
export const releaseAutonomyHold = (): void => { held = false; };
/** Is it held below Interactive now? */
export const autonomyHeld = (): boolean => held;

/** The mode the setting and the administrator give, the hold apart, and why it is below the one chosen. */
function standing(s: ApprovalsSetting | undefined, admin: AutonomyAdmin | null | undefined): { mode: ModeInForce; why: ModeWhy | null } {
  if (!autonomyPermitted(admin)) return { mode: "asking", why: "organisation" };
  const chosen = modeRank(s?.mode);
  if (!s || !chosen) return { mode: "asking", why: "card" };
  const built = BUILT.includes(s.mode);
  const cap = admin?.approvals?.maxMode ? modeRank(admin.approvals.maxMode) : APPROVAL_MODES.length;
  const checkOff = admin?.features.aiReview === false;
  let mode: ModeInForce = "asking";
  // The highest mode at or below the choice and the cap whose own card is agreed to: a card never covers another mode.
  for (let rank = Math.min(built ? chosen : 1, cap); rank >= 1 && mode === "asking"; rank--) {
    const m = APPROVAL_MODES[rank - 1];
    if (m === "assisted" && checkOff) continue;
    if (modeAgreed(s, m)) mode = m;
  }
  if (mode === s.mode) return { mode, why: null };
  return { mode, why: chosen > cap ? "cap" : !built ? "unavailable" : s.mode === "assisted" && checkOff ? "check-off" : "card" };
}

/** The mode the setting and the administrator give, whatever the hold says: what the hold is released by (mode-record.ts). */
export const modeWithoutHold = (s: ApprovalsSetting | undefined, admin?: AutonomyAdmin | null): ModeInForce => standing(s, admin).mode;

/**
 * The mode in force now: the highest mode at or below the one chosen and the administrator's cap whose own card is
 * agreed to as it reads now; "asking" (below Interactive) when there is none, where the administrator doesn't allow a
 * mode, while the hold is on, and for a setting that can't be read. With the administrator's `features.aiReview` false,
 * Assisted's check is off, so a chosen Assisted is in force as Interactive.
 */
export function modeInForce(s: ApprovalsSetting | undefined, admin?: AutonomyAdmin | null): ModeInForce {
  return held ? "asking" : standing(s, admin).mode;
}

/** What a state gives the machinery that decides: the policy engine's inputs keep their shape. */
export interface ApprovalInputs {
  /** PolicyInputs.autonomy and the command flow's: every scope, or null below Interactive. */
  scopes: AutonomyScopes | null;
  /** PolicyInputs.trustAskedApps: no "Let me work in …?" in an app the user asked for help in. */
  askedApps: boolean;
  /**
   * Assisted's check (PolicyInputs.assisted, PolicyEngine.assist; for commands the reviewer, commands/review.ts): a step
   * or a command that would ask goes to it first, and goes ahead announced when it finds it in the user's own words.
   */
  check: boolean;
  /**
   * Autopilot (PolicyInputs.autopilot, the command flow's and the extensions gate's): a question is announced instead of
   * asked, a risky one included. What still asks there is each consumer's own to keep (a command that would read or
   * print secrets or outlive the kill switch, the organisation's and the user's "ask every command"), and so is every
   * refusal.
   */
  autopilot: boolean;
}

const ASKING: Readonly<ApprovalInputs> = Object.freeze({ scopes: null, askedApps: false, check: false, autopilot: false });
const INTERACTIVE: Readonly<ApprovalInputs> = Object.freeze({ scopes: ALL_SCOPES, askedApps: true, check: false, autopilot: false });
const ASSISTED: Readonly<ApprovalInputs> = Object.freeze({ scopes: ALL_SCOPES, askedApps: true, check: true, autopilot: false });
const AUTOPILOT: Readonly<ApprovalInputs> = Object.freeze({ scopes: ALL_SCOPES, askedApps: true, check: false, autopilot: true });

/**
 * The inputs `mode` gives: below Interactive, what all three of the old switches off gave; in Interactive, what Work
 * without asking with every scope and the app switch gave, so the policy engine decides exactly as it did; in
 * Assisted, the same with its check on top, which can only turn a question into an announced step; in Autopilot, the
 * same as Interactive with every remaining question announced instead (never Assisted's check: no model decides there).
 */
export function approvalInputs(mode: ModeInForce): Readonly<ApprovalInputs> {
  return mode === "asking" ? ASKING : mode === "assisted" ? ASSISTED : mode === "autopilot" ? AUTOPILOT : INTERACTIVE;
}

/** The scopes in force now (approvalInputs' view of modeInForce): every one, or null below Interactive. */
export function autonomyInForce(s: ApprovalsSetting | undefined, admin?: AutonomyAdmin | null): AutonomyScopes | null {
  return approvalInputs(modeInForce(s, admin)).scopes;
}

/** The modes as Home is told of them: `own` is the user's own setting, never the one with the policy applied. */
export function approvalsState(own: ApprovalsSetting, admin: AutonomyAdmin | null | undefined): ApprovalsState {
  const at = standing(own, admin);
  // The organisation's reason holds whatever else does; then the hold.
  const lowered = held && at.why !== "organisation";
  return {
    chosen: own.mode,
    inForce: lowered ? "asking" : at.mode,
    why: lowered ? "not-recorded" : at.why,
    offered: [...OFFERED_MODES],
    agreed: APPROVAL_MODES.filter(m => modeAgreed(own, m)),
    cap: admin?.approvals?.maxMode ?? null,
    ...(admin?.features.aiReview === false ? { checkOff: true as const } : {}),
  };
}

/**
 * Home's choice of a mode (APPROVALS_IPC.choose): the mode changes only together with the agreement to its card, so the
 * setting that comes back holds both, built on the user's own (`own`). Refused, with why: a mode Home doesn't offer
 * (`unavailable`), a card that isn't the one in force now (`card`), or the organisation's limit.
 */
export function chooseMode(own: ApprovalsSetting, mode: ApprovalMode, version: number, admin: AutonomyAdmin | null | undefined, now: string): { ok: true; approvals: ApprovalsSetting } | { ok: false; why: ModeWhy } {
  if (!OFFERED_MODES.includes(mode)) return { ok: false, why: "unavailable" };
  if (version !== modeCardVersion(mode)) return { ok: false, why: "card" };
  const approvals: ApprovalsSetting = { mode, consent: { ...own.consent, [mode]: { version, at: now } } };
  const at = standing(approvals, admin);
  return at.mode === mode ? { ok: true, approvals } : { ok: false, why: at.why ?? "unavailable" };
}

/** Does `scopes` take in every one of `needs` (none needed: no, so nothing is waived by accident)? */
export function covers(scopes: AutonomyScopes | null | undefined, needs: readonly AutonomyScope[] | undefined): boolean {
  return !!scopes && !!needs && needs.length > 0 && needs.every(n => scopes[n] === true);
}

/** A list in words: "Firefox", "Firefox and Mail", "Firefox, Mail and Files". */
const listed = (xs: readonly string[]): string => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/**
 * What Ember says as it moves text between windows without asking: where from and where to, and how much, never what
 * (the bubble and the spoken line may be seen or heard by others; the text came from somewhere the user may not show).
 */
export function movingWords(from: readonly string[], into: string, chars?: number): string {
  const source = from.length ? listed(from.slice(0, 3)) : "another window";
  const size = typeof chars === "number" && chars > 0 ? ` (${chars} ${chars === 1 ? "character" : "characters"})` : "";
  return `Moving text from ${source} into ${into}${size}, without asking as you let me.`;
}
