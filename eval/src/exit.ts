/**
 * Whether an evaluation run passes, and if not, why: the process exit code.
 * The per-PR tier needs every task that ran to pass; the live tier needs
 * pass^k on at least 70 % of them (PLAN.md §6). Either way at least one task
 * must have run, and every blocking (safety) gate must pass: one that couldn't
 * be measured doesn't.
 */

import path from "node:path";
import type { Outcome } from "./runner";
import type { GateResult } from "./gates";

/** The live tier's bar: tasks passed on every attempt (pass^k), in percent of the tasks that ran. */
export const LIVE_PASS_PCT = 70;

export interface ExitInput {
  /** The task suite was part of this run (not --no-tasks). */
  suite: boolean;
  live: boolean;
  outcomes: Pick<Outcome, "status">[];
  gates: Pick<GateResult, "name" | "status" | "blocking" | "value" | "note">[];
}

export function computeExit(r: ExitInput): { code: 0 | 1; problems: string[] } {
  const problems: string[] = [];
  if (r.suite) {
    const ran = r.outcomes.filter(o => o.status !== "skipped");
    const passed = ran.filter(o => o.status === "pass").length;
    if (!ran.length) {
      problems.push(r.outcomes.length ? `no task could run on this machine (all ${r.outcomes.length} skipped)` : "no tasks ran");
    } else if (r.live ? passed * 100 < ran.length * LIVE_PASS_PCT : passed < ran.length) {
      problems.push(r.live
        ? `${passed}/${ran.length} tasks passed every attempt; the live tier needs ≥ ${LIVE_PASS_PCT} %`
        : `${ran.length - passed} of ${ran.length} tasks failed`);
    }
  }
  for (const g of r.gates) {
    if (!g.blocking || g.status === "pass") continue;
    problems.push(g.status === "fail"
      ? `${g.name}: ${g.value}`
      : `${g.name}: not measured (${g.value}${g.note ? `; ${g.note}` : ""}), and a blocking gate has to pass`);
  }
  return { code: problems.length ? 1 : 0, problems };
}

/**
 * Why the live tier can't run here, or null. It measures Ember on the eval VM's real desktop, so it needs that
 * session's display (and the X authority to open it) and its session bus (settings, the accessibility bus). A
 * runner started as a system service has none of them, and a run there would only skip tasks and leave gates
 * unmeasured: it stops at once instead (exit 2). docs/DEVELOPING.md §8 says how to run the runner in the session.
 */
export function liveDesktopProblem(env: NodeJS.ProcessEnv, probe: { uid: number; displayOpens: (name: string) => boolean; isSocket: (file: string) => boolean }): string | null {
  const fix = "run it in the logged-in “GNOME on Xorg” session, as its user, or set DISPLAY, XAUTHORITY and DBUS_SESSION_BUS_ADDRESS to that session's (docs/DEVELOPING.md §8)";
  if (!env.DISPLAY) return `the live tier runs on a desktop, and DISPLAY isn't set: ${fix}`;
  if (!probe.displayOpens(env.DISPLAY)) {
    return `the live tier can't open the display ${env.DISPLAY} (${env.XAUTHORITY ? `XAUTHORITY=${env.XAUTHORITY}` : "XAUTHORITY isn't set"}): ${fix}`;
  }
  const bus = path.join(env.XDG_RUNTIME_DIR || `/run/user/${probe.uid}`, "bus");
  if (!env.DBUS_SESSION_BUS_ADDRESS && !probe.isSocket(bus)) {
    return `the live tier needs the desktop session's bus (settings, the accessibility bus), and DBUS_SESSION_BUS_ADDRESS isn't set (nor is there ${bus}): ${fix}`;
  }
  return null;
}
