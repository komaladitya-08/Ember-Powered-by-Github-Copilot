/**
 * The handle's one line when no bubble or status line speaks (review #5): the most urgent thing that is true now, never
 * a word that hides it. A task that waits for you comes first, then why Ember can't answer, the tasks under way, the
 * tasks that failed, the setup row that holds Ember back (by name), the microphone, and only then "Ready". Pure, so it is
 * unit-tested.
 */

import { TASK_STOPPING, type BubbleState, type TaskCard } from "../../shared/overlay";
import { plainStream } from "@ember/bubble";
import type { MicState } from "../../shared/voice";
import { idleLine as micLine } from "../../shared/mic";
import { STATUS_WORDS } from "../../shared/activity";
import { cardLines, underWay } from "../overlay/stack";

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

export function handleLine(s: { idle?: string; setup?: string | null; mic?: MicState; tasks: readonly TaskCard[] }): string {
  const waiting = s.tasks.filter(t => t.status === "waiting");
  if (waiting.length) return waiting.length === 1 && waiting[0].title.trim()
    ? `Needs you: ${oneLine(waiting[0].title)}` : `${count(waiting.length, "task needs", "tasks need")} you`;
  // Why Ember can't answer ("Not connected", "Offline"): the reason is never hidden behind anything less urgent.
  if (s.idle && s.idle !== "Ready") return s.idle;
  const running = s.tasks.filter(t => t.status === "running");
  const queued = s.tasks.filter(t => t.status === "queued");
  if (running.length && queued.length) return `${running.length} working · ${queued.length} queued`;
  if (running.length === 1 && running[0].title.trim()) return `${running[0].detail === TASK_STOPPING ? "Stopping" : "Working"}: ${oneLine(running[0].title)}`;
  if (running.length) return `Working on ${count(running.length, "task", "tasks")}…`;
  if (queued.length === 1 && queued[0].title.trim()) return `Waiting its turn: ${oneLine(queued[0].title)}`;
  if (queued.length) return `${count(queued.length, "task", "tasks")} queued`;
  const failed = s.tasks.filter(t => t.status === "failed").length;
  if (failed) return `${count(failed, "task", "tasks")} failed`;
  if (s.setup) return s.setup;
  return micLine(s.idle, s.mic);
}

const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();

/** The pill can ellipsise its line; hovering still names every active task and its current step, as plain text. */
export function handleSummary(line: string, tasks: readonly TaskCard[]): string {
  const active = tasks.filter(underWay).map(task => {
    const where = task.where ? ` (${oneLine(task.where)})` : "";
    const doing = task.status === "running" ? cardLines(task).live : null;
    return `${STATUS_WORDS[task.status]}: ${oneLine(task.title)}${where}${doing ? ` — ${oneLine(doing)}` : ""}`;
  });
  return [line, ...active].join("\n");
}

/**
 * The pill's one line: the status line, else what the bubble says (an answer's title is the character's name, already
 * shown above it: the line shows what it said; anything else, its title), else `idle` (handleLine). So the line follows
 * the bubble: once the bubble is empty it says `idle` again, never a task that has ended.
 */
export function pillLine(s: { status?: string | null; bubble: Pick<BubbleState, "visible" | "title" | "thought" | "streaming"> }, name: string, idle: string): string {
  const b = s.bubble;
  const said = b.visible ? (b.title === name ? (b.streaming ? plainStream(b.thought) : b.thought) : b.title) : "";
  return s.status ?? (said.replace(/\s+/g, " ").trim() || idle);
}
