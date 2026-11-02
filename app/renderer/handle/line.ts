/**
 * The handle's one line when no bubble or status line speaks (review #5): the most urgent thing that is true now, never
 * a word that hides it. A task that waits for you comes first, then why Ember can't answer, the tasks under way, the
 * tasks that failed, the setup row that holds Ember back (by name), the microphone, and only then "Ready". Pure, so it is
 * unit-tested.
 */

import type { TaskCard } from "../../shared/overlay";
import type { MicState } from "../../shared/voice";
import { idleLine as micLine } from "../../shared/mic";
import { busyLine } from "../overlay/stack";

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

export function handleLine(s: { idle?: string; setup?: string | null; mic?: MicState; tasks: readonly TaskCard[] }): string {
  const waiting = s.tasks.filter(t => t.status === "waiting").length;
  if (waiting) return `${count(waiting, "task needs", "tasks need")} you`;
  // Why Ember can't answer ("Not connected", "Offline"): the reason is never hidden behind anything less urgent.
  if (s.idle && s.idle !== "Ready") return s.idle;
  const busy = busyLine(s.tasks);
  if (busy) return busy;
  const failed = s.tasks.filter(t => t.status === "failed").length;
  if (failed) return `${count(failed, "task", "tasks")} failed`;
  if (s.setup) return s.setup;
  return micLine(s.idle, s.mic);
}
