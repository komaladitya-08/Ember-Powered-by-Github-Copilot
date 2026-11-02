/**
 * "Work without asking" (owner decision of 2026-11-02, PLAN.md §2 "Approvals" and §10): while the user has it on, an
 * ordinary step that would have asked only because it is the first in an app, uses the borrowed mouse and keyboard, or
 * carries text from another window is announced instead (a line in the bubble and the task's card, and an audit entry
 * marked `autonomy`), within the scopes the user left on. It never touches what policy finds risky (sending, deleting,
 * paying, security settings, destructive keys, secrets…), which asks every time with no "Always", nor any hard "never".
 *
 * Fail closed: it is in force only with its own consent (FEATURE_CONSENT_VERSION.autonomy) and only where the
 * administrator allows it (admin.ts autonomyAllowed); a task that something on screen tried to steer, or whose step came
 * up unasked, or where the user already said no, asks as before (worker.ts). Pure, so it is unit-tested without Electron.
 */

import { FEATURE_CONSENT_VERSION } from "../../shared/consent";

/** What "Work without asking" may cover: using apps, ordinary commands, the borrowed mouse and keyboard, moving text between apps. */
export type AutonomyScope = "apps" | "commands" | "cursor" | "crossWindow";
export type AutonomyScopes = Record<AutonomyScope, boolean>;

/** All four on: what turning it on gives (Home's one switch). */
export const ALL_SCOPES: Readonly<AutonomyScopes> = Object.freeze({ apps: true, commands: true, cursor: true, crossWindow: true });

/** The setting as settings.ts keeps it. */
export interface AutonomySetting {
  on: boolean;
  scopes: AutonomyScopes;
  consent: { version: number; at: string | null };
}

/** The administrator's switches that bear on it (AdminPolicy's, structurally: this module loads without admin.ts). */
export interface AutonomyAdmin {
  features: { autonomy?: boolean; actions?: boolean };
  allowGrants: boolean;
  confirmEveryAction: boolean;
}

/** Has the user agreed to the current card? */
export const autonomyConsented = (s: Pick<AutonomySetting, "consent"> | undefined): boolean =>
  (s?.consent.version ?? 0) >= FEATURE_CONSENT_VERSION.autonomy;

/** May the organisation's users have it at all (the same rule as admin.ts autonomyAllowed)? */
export const autonomyPermitted = (admin: AutonomyAdmin | null | undefined): boolean =>
  !admin || (admin.features.autonomy !== false && admin.allowGrants !== false && !admin.confirmEveryAction && admin.features.actions !== false);

/**
 * The scopes in force now, or null: it is off, its card hasn't been agreed to (or was agreed to in an older wording),
 * or the administrator doesn't allow it. A setting that can't be read is off.
 */
export function autonomyInForce(s: AutonomySetting | undefined, admin?: AutonomyAdmin | null): AutonomyScopes | null {
  if (!s || s.on !== true || !autonomyConsented(s) || !autonomyPermitted(admin)) return null;
  const scopes: AutonomyScopes = { apps: s.scopes?.apps === true, commands: s.scopes?.commands === true, cursor: s.scopes?.cursor === true, crossWindow: s.scopes?.crossWindow === true };
  return Object.values(scopes).some(Boolean) ? scopes : null;
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
