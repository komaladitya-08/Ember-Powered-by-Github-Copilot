/**
 * Whether an evaluation run passes, and if not, why: the process exit code.
 * The per-PR tier needs every task that ran to pass; the live tier needs
 * pass^k on at least 70 % of them (PLAN.md §6). Either way at least one task
 * must have run, and every blocking (safety) gate must pass: one that couldn't
 * be measured doesn't.
 */

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
