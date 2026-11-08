/**
 * The words of Home's status panel (docs/DESIGN.md "Home"): Ember's state in one word or two beside its still ring,
 * what is on, today's tasks and approvals. Pure functions, so they are unit-tested (home-status.test.ts); the panel
 * only says what main already told the window (the agent's phase, the setup check, the tasks, the settings, the audit's
 * recent entries), and reads nothing new.
 */

import type { ActivityEntry } from "../../shared/ipc";
import { STATUS_WORDS, type TaskEntry } from "../../shared/activity";
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
  /** The model service the connection uses when it isn't Copilot (the agent's status kind). */
  service?: string;
  /** The organisation's policy locks Ember down (Status.admin.error), `held` until a restart reads a changed one. */
  locked?: boolean;
  held?: boolean;
  /**
   * Ember is answering a request: one sent from Home's composer (until the reply, a problem or Stop: home-7), or any
   * the conversation answers, as main says (from the Ask box and by voice too: home-c1-1).
   */
  answering?: boolean;
}

/** "1 task", "2 tasks". */
const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Ember's state in a word or two, the most urgent first: what blocks it (setup, Copilot), then what needs the user, then
 * the work under way, else Ready. `ring` is the still ring's state beside it.
 */
export function statusWord(f: StatusFacts): { word: string; ring: RingState } {
  // Locked down nothing connects, whatever the sign-in: never "Not connected", which connecting can't help (safety-privacy-4).
  if (f.locked) return { word: f.held ? "Locked until a restart" : "Locked by your organisation", ring: "error" };
  if (f.failing) return { word: "Needs setting up", ring: "error" };
  if (f.phase === "error" && f.waitingForTasks) return { word: f.service ? "Waiting for the model service" : "Waiting for Copilot", ring: "starting" };
  if (f.phase === "signed-out" || f.phase === "error") return { word: "Not connected", ring: "error" };
  if (f.phase === "starting" || f.phase === null) return { word: "Connecting…", ring: "starting" };
  if (f.asking) return { word: f.asking === 1 ? "A task needs you" : `${f.asking} tasks need you`, ring: "needs" };
  if (f.running) return { word: `Working on ${count(f.running, "task")}`, ring: "acting" };
  if (f.answering) return { word: "Thinking…", ring: "acting" };
  return { word: "Ready", ring: "ready" };
}

/**
 * The status panel's connect button while Ember isn't connected, by the service that isn't (the agent's status kind):
 * Copilot's sign-in, the user's own provider's details, or where the organisation's service says why (first-run-r1).
 * `waiting`: signed out while the user's own provider waits for its card, which is the way on (integrations-r3-1).
 */
export function connectLabel(service?: string, waiting = false): string {
  return service === "user" || waiting ? "Check my provider…" : service ? "Models & connections…" : "Connect Copilot…";
}

/**
 * The link under the tagline to the setup check, when a row needs the user (the same count as the sidebar's badge and
 * the check's note, UI audit #6); null when none does. The tagline already says how many fail; `held` rows hold Ember
 * back without failing (it can't read or use apps), and are to fix, as first run says (first-run-5).
 */
export function setupLinkText(failing: number, look: number, held = 0): string | null {
  if (failing) return "Open the setup check";
  const n = (k: number) => (k === 1 ? "1 thing" : `${k} things`);
  if (held) return `The setup check has ${n(held)} to fix`;
  return look ? `The setup check has ${n(look)} worth a look` : null;
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
  /** "paused": it was on, and waits for the user to agree to its changed note (FEATURE_CONSENT_VERSION.memory). */
  memory: boolean | "paused";
  /** Computers commands are on for (this one included). */
  commands: number;
  /** Computers over SSH the user added. */
  computers: number;
  wsl: boolean;
}

/**
 * Memory as Home's status line says it: on only while its owner is verified too, so memory that is on but can't be
 * opened (connecting, a model provider in force, another account's) reads "paused", never "on" (memory-2), and so does
 * memory whose saved file can't be read (`trouble` "unreadable": nothing new is kept, memory-r2).
 * `notePaused`: on under an earlier note (memoryPaused).
 */
export function memoryWhatsOn(on: boolean, notePaused: boolean, ownership: "waiting" | "ready" | "locked", trouble?: "unreadable" | "reset" | "unsaved" | null): WhatsOn["memory"] {
  if (notePaused) return "paused";
  if (!on) return false;
  return ownership === "ready" && trouble !== "unreadable" ? true : "paused";
}

/**
 * The main capabilities and whether each is on, in a few words ("Listening on · Memory on · Commands off"), then the
 * other computers Ember can work on, when there are any ("2 computers over SSH", "WSL").
 */
export function whatsOnText(o: WhatsOn): string {
  return [
    o.voice === "listening" ? "Listening on" : o.voice === "muted" ? "Microphone off" : "Listening off",
    o.memory === "paused" ? "Memory paused" : o.memory ? "Memory on" : "Memory off",
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
 * user, are at work, are done, didn't finish, stopped or got no answer in time (a question nobody answered, in its
 * row's words: tasks-approvals-r3-1), and the steps the user allowed ("1 needs you · 1 done · 1 didn't finish ·
 * 1 approval"). Tasks of earlier runs today are only in the audit (`audit`): counted as "earlier" when the audit has
 * more than this run's list. Only the tasks begun today count.
 */
export function todaySummary(tasks: readonly Pick<TaskEntry, "status" | "activity" | "unanswered">[], audit: { tasks: number; approvals: number }, now = new Date()): string {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const mine = tasks.filter(t => t.activity.startedAt >= start);
  const by = (s: TaskEntry["status"][]) => mine.filter(t => s.includes(t.status) && !(t.status === "stopped" && t.unanswered)).length;
  const unanswered = mine.filter(t => t.status === "stopped" && t.unanswered).length;
  const approvals = Math.max(audit.approvals, mine.reduce((n, t) => n + t.activity.approvals, 0));
  const earlier = Math.max(0, audit.tasks - mine.length);
  const parts = [
    by(["waiting"]) ? `${by(["waiting"])} ${by(["waiting"]) === 1 ? "needs" : "need"} you` : "",
    by(["running", "queued"]) ? `${by(["running", "queued"])} working` : "",
    by(["done"]) ? `${by(["done"])} done` : "",
    by(["failed"]) ? `${by(["failed"])} didn't finish` : "",
    by(["stopped"]) ? `${by(["stopped"])} stopped` : "",
    // A count reads as a clause, as its neighbours do, in the row's own words ("2 got no answer in time"): accessibility-visual-r4-1.
    unanswered ? `${unanswered} got ${STATUS_WORDS.unanswered.toLowerCase()}` : "",
    earlier ? `${count(earlier, "earlier task")}` : "",
    approvals ? count(approvals, "approval") : "",
  ].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No tasks yet";
}
