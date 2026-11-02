/**
 * Home's "Task activity" (docs/DESIGN.md "Home"): what each task this session did and is doing, one group per task,
 * newest first, from main's in-memory list (IPC.tasks, pushed again as the cards change, at most twice a second). Every
 * string is set as text: a plan's, a note's, a summary's and a view's words are the worker's own and may carry what it
 * read on the screen. Home never answers a question (the bubble, the card and the keys do): it only says how each was
 * answered. Groups are rebuilt only when what they show changed, and a row the user opened stays open.
 */

import type { TaskEntry } from "../../shared/activity";
import { PLAN_WORD, type PlanStep } from "../../shared/view";
import { STATUS_WORDS, ROW_WORD } from "../../shared/activity";
import { viewNodes } from "../overlay/view";
import { askedWhere, FILTER_EMPTY, TASK_FILTERS, TASK_FILTER_FROM, filterLabel, filterTasks, type TaskFilter, NOTE_TAG, TASKS_EMPTY, droppedText, offsetText, offsetWords, stepsLine, taskAnnouncement, taskMeta, timelineRows, type TimelineRow } from "./tasks-copy";

const $ = (id: string) => document.getElementById(id)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/**
 * A task's result view, drawn by the cards' own catalog code (textContent only): the one place Home draws a view, so a
 * shared view module can take its place.
 */
const resultView = (view: NonNullable<TaskEntry["view"]>): HTMLElement[] => viewNodes(view);

/** Rows the user opened, by task and row id. */
const opened = new Set<string>();
/** Each group as last drawn (its key), so an unchanged one is left alone (a screen reader keeps its place). */
const drawn = new Map<string, { key: string; node: HTMLElement; meta: HTMLElement; entry: TaskEntry }>();
/** Each task's state as last announced. */
const said = new Map<string, TaskEntry["status"]>();
let listeners: ((tasks: TaskEntry[]) => void)[] = [];
/** Where a waiting question is answered: moved into the waiting task's group (kept here: a rebuilt group drops it). */
const askingNote = $("tasks-asking");
let latest: TaskEntry[] = [];

function planList(plan: readonly PlanStep[]): HTMLOListElement {
  const ol = el("ol", "plan-list");
  ol.append(...plan.map(p => {
    const li = el("li");
    li.dataset.state = p.state;
    li.append(el("span", "sr", PLAN_WORD[p.state]), document.createTextNode(p.text));
    return li;
  }));
  return ol;
}

function rowItem(taskId: string, r: TimelineRow): HTMLLIElement {
  const li = el("li");
  li.dataset.status = r.state;
  const time = el("time", "at", offsetText(r.at));
  time.setAttribute("aria-label", offsetWords(r.at));
  const sym = el("i", "sym");
  sym.setAttribute("aria-hidden", "true");
  const what = el("span", r.model ? "what model" : "what");
  what.append(el("span", "sr", ROW_WORD[r.state]));
  if (r.model) what.append(el("span", "note-tag", NOTE_TAG), document.createTextNode(" "));
  what.append(document.createTextNode(r.words));
  if (r.asked) what.append(el("span", "asked", r.asked));
  if (!r.steps) { li.append(time, sym, what); return li; }
  // Steps folded together: the row opens to list each, and stays open by its id across updates.
  const key = `${taskId}:${r.id}`;
  const fold = el("details", "steps");
  fold.open = opened.has(key);
  fold.addEventListener("toggle", () => { if (fold.open) opened.add(key); else opened.delete(key); });
  const summary = el("summary");
  summary.append(what);
  const list = el("ol", "step-list");
  list.append(...r.steps.map(s => {
    const item = el("li");
    item.dataset.status = s.state;
    const t = el("time", "at", offsetText(s.at));
    t.setAttribute("aria-label", offsetWords(s.at));
    item.append(t, el("span", "what", s.words));
    return item;
  }));
  fold.append(summary, list);
  li.append(time, sym, fold);
  return li;
}

/** A task that ended folds to its title and summary line until opened (UI audit #1: groups were long). */
const ended = (t: TaskEntry) => t.status === "done" || t.status === "failed" || t.status === "stopped";

function group(t: TaskEntry, now: number): { node: HTMLElement; meta: HTMLElement } {
  const node = el("article", "task-group");
  node.dataset.status = t.status;
  const headId = `task-${t.id}-t`;
  node.setAttribute("aria-labelledby", headId);
  const fold = ended(t) ? el("details", "task-fold") : null;
  const head = el(fold ? "summary" : "div", "task-head");
  const sym = el("i", "sym");
  sym.setAttribute("aria-hidden", "true");
  const text = el("div", "task-text");
  const h = el("h3", "task-title");
  h.id = headId;
  h.append(el("span", "sr", `${STATUS_WORDS[t.status]}: `), document.createTextNode(t.title));
  const meta = el("p", "task-meta", taskMeta(t, now));
  text.append(h, meta);
  const steps = stepsLine(t);
  if (steps) text.append(el("p", "task-steps", steps));
  head.append(sym, text);
  const body = el("div", "task-body");
  if (t.plan?.length) body.append(planList(t.plan));
  const rows = timelineRows(t.activity.items);
  if (rows.length) {
    const ol = el("ol", "timeline");
    ol.setAttribute("aria-label", `What “${t.title}” did`);
    const dropped = droppedText(t.activity.dropped);
    if (dropped) ol.append(el("li", "dropped", dropped));
    ol.append(...rows.map(r => rowItem(t.id, r)));
    body.append(ol);
  }
  // How it ended: the worker's summary (unless a problem row already says the same), and what it found or made.
  const said = t.activity.items.some(i => i.kind === "problem" && i.words === t.summary);
  if ((t.summary && !said) || t.view?.length) {
    const result = el("div", "task-result");
    if (t.summary && !said) result.append(el("p", "summary", t.summary));
    if (t.view?.length) {
      const view = el("div", "view");
      view.append(...resultView(t.view));
      result.append(view);
    }
    body.append(result);
  }
  if (fold) {
    // Opened by the user, it stays open across updates.
    const key = `${t.id}:`;
    fold.open = opened.has(key);
    fold.addEventListener("toggle", () => { if (fold.open) opened.add(key); else opened.delete(key); });
    fold.append(head, body);
    node.append(fold);
  } else {
    node.append(head, body);
  }
  return { node, meta };
}

/** What needs the user first, then what is at work, then the rest, each newest first (main sends newest first). */
const RANK: Record<TaskEntry["status"], number> = { waiting: 0, running: 1, queued: 1, done: 2, failed: 2, stopped: 2 };
const ordered = (tasks: readonly TaskEntry[]) => tasks.map((t, i) => ({ t, i })).sort((a, b) => RANK[a.t.status] - RANK[b.t.status] || a.i - b.i).map(x => x.t);

/** The filter chosen (shown once there are TASK_FILTER_FROM tasks). */
let filter: TaskFilter = "all";
function renderFilter(all: readonly TaskEntry[]): void {
  const bar = $("task-filter");
  bar.hidden = all.length < TASK_FILTER_FROM;
  if (bar.hidden) filter = "all";
  if (!bar.childElementCount) {
    bar.append(...TASK_FILTERS.map(f => {
      const b = el("button", "btn quiet small", f.label);
      b.type = "button";
      b.dataset.filter = f.id;
      b.addEventListener("click", () => { filter = f.id; render(given); });
      return b;
    }));
  }
  for (const b of bar.querySelectorAll<HTMLButtonElement>("button")) {
    const f = b.dataset.filter as TaskFilter;
    b.setAttribute("aria-pressed", String(f === filter));
    b.textContent = filterLabel(f, all);
  }
}

/** The list main sent last (the filter draws from it). */
let given: TaskEntry[] = [];
function render(sent: TaskEntry[]): void {
  given = sent;
  const all = ordered(sent);
  latest = all;
  renderFilter(all);
  const tasks = filterTasks(all, filter);
  const list = $("tasks");
  const now = Date.now();
  if (!tasks.length) {
    drawn.clear();
    const empty = all.length ? FILTER_EMPTY : TASKS_EMPTY;
    if (list.querySelector(".empty")?.textContent !== empty) list.replaceChildren(el("p", "empty", empty));
  } else {
    const nodes = tasks.map(t => {
      // Everything but the clock: the clock is written by the tick below, so it never rebuilds a group.
      const key = JSON.stringify({ ...t, activity: { ...t.activity, live: undefined } });
      const had = drawn.get(t.id);
      if (had && had.key === key) { had.entry = t; return had.node; }
      const g = group(t, now);
      drawn.set(t.id, { key, ...g, entry: t });
      return g.node;
    });
    for (const id of [...drawn.keys()]) if (!tasks.some(t => t.id === id)) drawn.delete(id);
    // Moved into order only where the order changed (focus and a screen reader's place stay put).
    if (list.children.length !== nodes.length || nodes.some((n, i) => list.children[i] !== n)) list.replaceChildren(...nodes);
  }
  // A task waits for the user's answer: Home says where it is asked, and with which keys, in that task's own group (it
  // never answers itself); otherwise the note waits, hidden, above the list.
  const asking = askingNote;
  const waiting = tasks.find(t => t.status === "waiting");
  const body = waiting ? drawn.get(waiting.id)?.node.querySelector(":scope > .task-body") : null;
  asking.hidden = !body;
  // Its words say where: the bubble (with the keys), the command window, or a consent card's own window.
  const where = waiting ? askedWhere(waiting.activity.items) : "bubble";
  for (const s of asking.querySelectorAll<HTMLElement>(":scope > [data-asked-in]")) s.hidden = s.dataset.askedIn !== where;
  if (body && asking.parentElement !== body) body.prepend(asking);
  else if (!body && asking.nextElementSibling !== list) list.before(asking);
  // A task's state, said once when it changes (not on the first list).
  const live: string[] = [];
  for (const t of all) {
    const before = said.get(t.id);
    if (before !== undefined && before !== t.status) live.push(taskAnnouncement(t.title, t.status));
    said.set(t.id, t.status);
  }
  if (live.length) $("tasks-live").textContent = live.join(". ");
  for (const fn of listeners) fn(all);
}

/** The clock of each task under way, written as text once a second while the window can be seen. */
function tick(): void {
  if (document.visibilityState !== "visible") return;
  const now = Date.now();
  for (const d of drawn.values()) {
    if (d.entry.activity.endedAt !== undefined) continue;
    const text = taskMeta(d.entry, now);
    if (d.meta.textContent !== text) d.meta.textContent = text;
  }
}

/**
 * Where Home says a waiting question is answered, in view: a filter that hides the waiting task (Working, Ended) goes
 * back to All first. Null when no task waits.
 */
export function revealAsking(): HTMLElement | null {
  if (!latest.some(t => t.status === "waiting")) return null;
  if (askingNote.hidden) { filter = "all"; render(given); }
  return askingNote.hidden ? null : askingNote;
}

/** Starts Task activity: the list now, and again whenever main pushes it. `onChange` hears every list (the status panel). */
export function startTasks(onChange?: (tasks: TaskEntry[]) => void): void {
  if (onChange) listeners = [...listeners, onChange];
  void window.ember.tasks().then(render, () => render([]));
  window.ember.onTasks(render);
  setInterval(() => { if (latest.some(t => t.activity.endedAt === undefined)) tick(); }, 1000);
}
