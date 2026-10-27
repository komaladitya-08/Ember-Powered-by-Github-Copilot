/**
 * The settings window's setup check for other computers and WSL (§8.8): the targets runtime's doctor rows shown as
 * setup-check rows, as `ember --doctor` shows them, and the route of a fix button's id. `wsl-a11y:<distro>` goes to the
 * targets runtime's applyFix, this OS's own fixes to the platform, and any other id is refused before anything runs
 * (fail closed). Plain Node and pure but for the timers; main wires it behind the settings window's trusted-sender guard.
 */

import { DISTRO_NAME } from "../../shared/targets";
import type { Check, EnvReport, FixId, TargetFixId } from "../environment";
import type { PlatformDoctorRow } from "../platform/types";

/** The fix id the targets runtime applies: turning on toolkit accessibility in a running distro (§8.8). */
export function targetFixOf(id: unknown): TargetFixId | null {
  if (typeof id !== "string") return null;
  const m = /^wsl-a11y:(.+)$/.exec(id);
  return m && DISTRO_NAME.test(m[1]) ? (id as TargetFixId) : null;
}

/**
 * Words for the window, which shows them as plain text: a row's Markdown code marks (`wsl --update`) dropped, so no
 * stray backticks show (the doctor prints the rows in a terminal as they are; review #157, #218).
 */
const plain = (s: string): string => s.replace(/`/g, "");

/** A detail and the fix after it: one full stop between them, never two ("…is on.. System Settings"; review #157). */
const joined = (detail: string, fix: string): string => `${detail}${/[.!?…]$/.test(detail.trimEnd()) ? " " : ". "}${fix}`;

/**
 * The doctor's target rows as setup-check rows. A `wsl-a11y:<distro>` row that isn't ok gets its fix button (its id);
 * another row's fix, words for the user, follows its detail, as the doctor prints it under the row.
 */
export function setupChecks(rows: readonly PlatformDoctorRow[]): Check[] {
  return rows.map(r => {
    const button = r.status !== "ok" ? targetFixOf(r.id) : null;
    const words = !button && r.status !== "ok" && r.fix ? joined(r.detail, r.fix) : r.detail;
    return { id: r.id, label: r.label, status: r.status, detail: plain(words), ...(button ? { fix: button } : {}) };
  });
}

/** The report with the target rows after this OS's own checks. */
export function withTargetChecks(env: EnvReport, checks: readonly Check[]): EnvReport {
  return { ...env, checks: [...env.checks, ...checks] };
}

/** After a target fix worked: its row says what to do next (the doctor's view of the distro may lag a moment). */
export function afterTargetFix(env: EnvReport, fix: TargetFixId, message: string): EnvReport {
  return { ...env, checks: env.checks.map(c => (c.id === fix && c.status !== "ok" ? { id: c.id, label: c.label, status: c.status, detail: plain(message) } : c)) };
}

/** What applying a fix may call. */
export interface FixRoutes {
  /** The fixes this OS offers (sys.fixes.ids). */
  osFixes: readonly FixId[];
  applyOs(id: FixId): Promise<void>;
  /** The targets runtime's applyFix; null when there is none (yet). */
  applyTarget: ((id: TargetFixId) => Promise<{ ok: boolean; message: string }>) | null;
}

/**
 * Applies the fix a setup-check button asked for: a target fix through the targets runtime (its refusal is thrown with
 * its words), one of this OS's through the platform; any other id throws before anything runs. Returns the target
 * fix's words ("Restart your Linux apps."), or null for this OS's own.
 */
export async function applySetupFix(fix: unknown, r: FixRoutes): Promise<{ target: TargetFixId; message: string } | null> {
  const target = targetFixOf(fix);
  if (target) {
    if (!r.applyTarget) throw new Error("Ember can't apply that fix right now.");
    const done = await r.applyTarget(target);
    if (!done.ok) throw new Error(done.message);
    return { target, message: done.message };
  }
  if (typeof fix !== "string" || !r.osFixes.includes(fix as FixId)) throw new Error(`unknown fix: ${String(fix).slice(0, 80)}`);
  await r.applyOs(fix as FixId);
  return null;
}

/**
 * The target rows for the setup check, read through `read` (the targets runtime's doctorRows): a read is kept for
 * `keepMs` (the window asks again each time it comes back, and a WSL row looks inside running distros), shared while it
 * runs, and waited for at most `waitMs`; then the rows from before are shown and the read finishes for the next ask. A
 * read that fails gives the rows from before (or none). `fresh`: read again now (after a fix).
 */
export function targetChecksSource(read: () => Promise<PlatformDoctorRow[]>, o: { keepMs: number; waitMs: number; now: () => number }): (fresh?: boolean) => Promise<Check[]> {
  let kept: { at: number; checks: Check[] } | null = null;
  let reading: Promise<Check[]> | null = null;
  const start = (): Promise<Check[]> => {
    if (reading) return reading;
    const p = Promise.resolve().then(read).then(rows => {
      const checks = setupChecks(Array.isArray(rows) ? rows : []);
      kept = { at: o.now(), checks };
      return checks;
    }, () => kept?.checks ?? []).finally(() => { if (reading === p) reading = null; });
    reading = p;
    return p;
  };
  return async (fresh = false) => {
    if (!fresh && kept && o.now() - kept.at < o.keepMs) return kept.checks;
    const p = start();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), o.waitMs); });
    try {
      return (await Promise.race([p, late])) ?? kept?.checks ?? [];
    } finally {
      clearTimeout(timer);
    }
  };
}
