/**
 * The words of Home's status panel (docs/DESIGN.md "Home"): Ember's state in one word or two beside its still ring,
 * what is on, today's tasks and approvals. Pure functions, so they are unit-tested (home-status.test.ts); the panel
 * only says what main already told the window (the agent's phase, the setup check, the tasks, the settings, the audit's
 * recent entries), and reads nothing new.
 */

import type { ActivityEntry } from "../../shared/ipc";
import type { TaskEntry } from "../../shared/activity";
import { dayLabel } from "./copy";

/**
 * The ring's state, as the handle's ring says it (docs/DESIGN.md "Presence"): never colour alone, the word beside it
 * always says the same. Still on Home: it never animates.
 */
export type RingState = "ready" | "acting" | "needs" | "starting" | "error";

export interface StatusFacts {
  /** The agent's phase (null before the first status). */
  phase: string | null;
  /** Setup rows that fail. */
  failing: number;
  /** Copilot stopped answering with tasks at work: Ember reconnects once they finish. */
  waitingForTasks?: boolean;
  /** Tasks working now, and those waiting for the user's answer. */
  running: number;
  asking: number;
}

/** "1 task", "2 tasks". */
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Ember's state in a word or two, the most urgent first: what blocks it (setup, Copilot), then what needs the user, then
 * the work under way, else Ready. `ring` is the still ring's state beside it.
 */
export function statusWord(f: StatusFacts): { word: string; ring: RingState } {
  if (f.failing) return { word: "Needs setting up", ring: "error" };
  if (f.phase === "error" && f.waitingForTasks) return { word: "Waiting for Copilot", ring: "starting" };
  if (f.phase === "signed-out" || f.phase === "error") return { word: "Not connected", ring: "error" };
  if (f.phase === "starting" || f.phase === null) return { word: "Connecting…", ring: "starting" };
  if (f.asking) return { word: f.asking === 1 ? "A task needs you" : `${f.asking} tasks need you`, ring: "needs" };
  if (f.running) return { word: `Working on ${count(f.running, "task")}`, ring: "acting" };
  return { word: "Ready", ring: "ready" };
}

/**
 * The link under the tagline to the setup check, when a row needs the user (the same count as the sidebar's badge and
 * the check's note, UI audit #6); null when none does. The tagline already says how many fail.
 */
export function setupLinkText(failing: number, look: number): string | null {
  if (failing) return "Open the setup check";
  return look ? `The setup check has ${look === 1 ? "1 thing" : `${look} things`} worth a look` : null;
}

/** How many tasks work now and how many wait for the user (from Task activity's list). */
export function taskCounts(tasks: readonly Pick<TaskEntry, "status">[]): { running: number; asking: number } {
  return {
    running: tasks.filter(t => t.status === "running" || t.status === "waiting").length,
    asking: tasks.filter(t => t.status === "waiting").length,
  };
}

export interface WhatsOn {
  /** The microphone: listening for the wake word, muted, or off (listening turned off, or not agreed to). */
  voice: "listening" | "muted" | "off";
  memory: boolean;
  /** Computers commands are on for (this one included). */
  commands: number;
  /** Computers over SSH the user added. */
  computers: number;
  wsl: boolean;
}

/**
 * The main capabilities and whether each is on, in a few words ("Listening on · Memory on · Commands off"), then the
 * other computers Ember can work on, when there are any ("2 computers over SSH", "WSL").
 */
export function whatsOnText(o: WhatsOn): string {
  return [
    o.voice === "listening" ? "Listening on" : o.voice === "muted" ? "Microphone off" : "Listening off",
    o.memory ? "Memory on" : "Memory off",
    o.commands ? "Commands on" : "Commands off",
    o.computers ? `${count(o.computers, "computer")} over SSH` : "",
    o.wsl ? "WSL" : "",
  ].filter(Boolean).join(" · ");
}

/** Today's tasks (requests to do or guide) and the steps the user allowed, from the audit's recent entries. */
export function todayCounts(entries: readonly ActivityEntry[], now = new Date()): { tasks: number; approvals: number } {
  let tasks = 0;
  let approvals = 0;
  for (const e of entries) {
    if (dayLabel(e.t, now) !== "Today") continue;
    if (e.event === "task" && e.phase === "asked") tasks++;
    if (e.event === "confirm" && (e.answer === "once" || e.answer === "always")) approvals++;
  }
  return { tasks, approvals };
}

/**
 * Today, from the same tasks Task activity lists, so the panel and the list below it always agree: how many need the
 * user, are at work, are done, didn't finish or stopped, and the steps the user allowed ("1 needs you · 1 done · 1
 * didn't finish · 1 approval"). Tasks of earlier runs today are only in the audit (`audit`): counted as "earlier"
 * when the audit has more than this run's list. Only the tasks begun today count.
 */
export function todaySummary(tasks: readonly Pick<TaskEntry, "status" | "activity">[], audit: { tasks: number; approvals: number }, now = new Date()): string {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const mine = tasks.filter(t => t.activity.startedAt >= start);
  const by = (s: TaskEntry["status"][]) => mine.filter(t => s.includes(t.status)).length;
  const approvals = Math.max(audit.approvals, mine.reduce((n, t) => n + t.activity.approvals, 0));
  const earlier = Math.max(0, audit.tasks - mine.length);
  const parts = [
    by(["waiting"]) ? `${by(["waiting"])} ${by(["waiting"]) === 1 ? "needs" : "need"} you` : "",
    by(["running", "queued"]) ? `${by(["running", "queued"])} working` : "",
    by(["done"]) ? `${by(["done"])} done` : "",
    by(["failed"]) ? `${by(["failed"])} didn't finish` : "",
    by(["stopped"]) ? `${by(["stopped"])} stopped` : "",
    earlier ? `${count(earlier, "earlier task")}` : "",
    approvals ? count(approvals, "approval") : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No tasks yet";
}
