/**
 * Home's "Task activity" (docs/DESIGN.md "Home"): what each task this session did and is doing, one group per task,
 * newest first, from main's in-memory list (IPC.tasks, pushed again as the cards change, at most twice a second). Every
 * string is set as text: a plan's, a note's, a summary's and a view's words are the worker's own and may carry what it
 * read on the screen. Home never answers a question (the bubble, the card and the keys do): it only says how each was
 * answered. Groups are rebuilt only when what they show changed, a row the user opened stays open, and keyboard focus
 * stays on the control it was on (home-2).
 */

import type { TaskControlAction, TaskEntry } from "../../shared/activity";
import { PLAN_WORD, type PlanStep } from "../../shared/view";
import { rowWord } from "../../shared/activity";
import { renderView } from "../shared/view-dom";
import { askedWhere, FILTER_EMPTY, TASK_FILTERS, TASK_FILTER_FROM, filterLabel, filterTasks, type TaskFilter, NOTE_TAG, TASKS_EMPTY, droppedText, offsetText, offsetWords, stateWord, stepsLine, taskAnnouncement, taskMeta, timelineRows, type TimelineRow } from "./tasks-copy";

const $ = (id: string) => document.getElementById(id)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

/**
 * A task's view (its live view while it works, its result after), drawn by the shared view module in the window
 * profile (app/renderer/shared/view-dom.ts, textContent and static SVG only): the one place Home draws a view.
 */
const resultView = (view: NonNullable<TaskEntry["view"]>): HTMLElement[] => [renderView(view, { profile: "window" })];

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
/** A pushed view or newer read supersedes pending IPC snapshots; account erasure retires pending actions too. */
let readEpoch = 0;
let accountEpoch = 0;
let awaitingAccount = false;
let focusedAction: { account: number } | null = null;

async function refreshTasks(emptyOnFailure = false): Promise<void> {
  const read = ++readEpoch, account = accountEpoch;
  try {
    const entries = await window.ember.tasks();
    if (read === readEpoch && account === accountEpoch && !awaitingAccount) render(entries);
  } catch (error) {
    if (read !== readEpoch || account !== accountEpoch || awaitingAccount) return;
    if (emptyOnFailure) render([]);
    else throw error;
  }
}

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
  what.append(el("span", "sr", rowWord(r)));
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
  summary.dataset.control = `steps:${r.id}`;
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

/** Native controls use the exact ID from main; a rejected stale action refreshes its capabilities. */
function taskControls(t: TaskEntry, result: HTMLElement | null): HTMLElement {
  const group = el("div", "agent-actions");
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", `Actions for ${t.title}`);
  const status = el("p", "hint");
  status.id = `task-${t.id}-control-status`;
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const action = (label: string, kind: TaskControlAction, available: boolean) => {
    const button = el("button", "btn quiet small", label);
    button.type = "button";
    button.dataset.control = kind;
    button.setAttribute("aria-label", `${label}: ${t.title}`);
    button.disabled = !available;
    button.addEventListener("click", () => {
      const wasFocused = document.activeElement === button;
      const account = accountEpoch;
      const focus = wasFocused ? { account } : null;
      if (focus) focusedAction = focus;
      button.disabled = true;
      void window.ember.taskControl(t.id, kind).then(async accepted => {
        if (account !== accountEpoch) return;
        await refreshTasks();
        if (account !== accountEpoch) return;
        const keepFocus = wasFocused && kind !== "window" && (document.activeElement === document.body || group.contains(document.activeElement));
        const feedback = document.getElementById(status.id) ?? status;
        const stopped = latest.find(task => task.id === t.id)?.status === "stopped";
        feedback.textContent = accepted ? kind === "stop" ? stopped ? "This task stopped." : "Stopping this task…" : kind === "retry" ? "A new attempt started." : "App window opened." : "This action is no longer available.";
        if (keepFocus) {
          const heading = document.getElementById(`task-${t.id}-t`);
          const summary = heading?.closest("summary");
          if (summary) summary.focus();
          else if (heading) { heading.tabIndex = -1; heading.focus(); }
        }
      }).catch(() => {
        if (account !== accountEpoch) return;
        status.textContent = "I couldn't update this task. Try again."; button.disabled = !available;
      }).finally(() => { if (focusedAction === focus) focusedAction = null; });
    });
    group.append(button);
  };
  if (!ended(t)) action("Stop task", "stop", t.controls?.stop === true);
  // A failure, or a task whose question went unanswered while the user was away (tasks-approvals-c1-2): the card's
  // Try again, here for the keyboard and screen readers, since the overlay and the handle take no focus.
  if (t.status === "failed" || (t.status === "stopped" && t.controls?.retry === true)) action("Try again", "retry", t.controls?.retry === true);
  if (t.controls?.window) action("Show app", "window", true);
  if (result) {
    const show = el("button", "btn quiet small", "View result");
    show.type = "button";
    show.dataset.control = "view-result";
    show.setAttribute("aria-label", `View result: ${t.title}`);
    show.addEventListener("click", () => { result.scrollIntoView({ block: "nearest" }); result.focus({ preventScroll: true }); });
    group.append(show);
  }
  group.append(status);
  return group;
}

/** A task that ended folds to its title and summary line until opened (UI audit #1: groups were long). */
const ended = (t: TaskEntry) => t.status === "done" || t.status === "failed" || t.status === "stopped";

function group(t: TaskEntry, now: number): { node: HTMLElement; meta: HTMLElement } {
  const node = el("article", "task-group");
  node.dataset.status = t.status;
  node.dataset.task = t.id;
  const headId = `task-${t.id}-t`;
  node.setAttribute("aria-labelledby", headId);
  const fold = ended(t) ? el("details", "task-fold") : null;
  const head = el(fold ? "summary" : "div", "task-head");
  if (fold) head.dataset.control = "fold";
  const sym = el("i", "sym");
  sym.setAttribute("aria-hidden", "true");
  const text = el("div", "task-text");
  const h = el("h3", "task-title");
  h.id = headId;
  h.append(el("span", "sr", `${stateWord(t)}: `), document.createTextNode(t.title));
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
  let resultNode: HTMLElement | null = null;
  const said = t.activity.items.some(i => i.kind === "problem" && i.words === t.summary);
  if ((t.summary && !said) || t.view) {
    const result = el("div", "task-result");
    result.dataset.control = "result";
    result.tabIndex = -1;
    result.setAttribute("role", "group");
    result.setAttribute("aria-label", `Result: ${t.title}`);
    resultNode = result;
    if (t.summary && !said) result.append(el("p", "summary", t.summary));
    if (t.view) {
      const view = el("div", "task-view");
      view.append(...resultView(t.view));
      result.append(view);
    }
    body.append(result);
  }
  body.prepend(taskControls(t, resultNode));
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

/** Where keyboard focus was in Task activity before a list is drawn: the element, and the control and task it is. */
interface HeldFocus { el: HTMLElement; task?: string; control?: string }
function focusHeld(list: HTMLElement): HeldFocus | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement) || !(list.contains(el) || askingNote.contains(el))) return null;
  const group = el.closest<HTMLElement>(".task-group");
  return { el, task: group?.dataset.task, control: el.closest<HTMLElement>("[data-control]")?.dataset.control };
}
/**
 * Puts focus back after a list is drawn (home-2): a group whose task changed is a new node (main pushes every step, at
 * most twice a second), so the control that had focus is found again in it by what it is (Stop task, a steps row…);
 * one that is gone leaves focus on the task's own heading, never the top of the page.
 */
function keepFocus(held: HeldFocus): void {
  if (document.activeElement === held.el) return;
  if (held.el.isConnected) { held.el.focus({ preventScroll: true }); return; }
  const node = held.task ? drawn.get(held.task)?.node : undefined;
  if (!node?.isConnected) return;
  const same = held.control ? node.querySelector<HTMLElement>(`[data-control="${CSS.escape(held.control)}"]`) : null;
  if (same && !(same instanceof HTMLButtonElement && same.disabled)) same.focus({ preventScroll: true });
  if (same && document.activeElement === same) return;
  const summary = node.querySelector<HTMLElement>(":scope > details > summary");
  if (summary) { summary.focus({ preventScroll: true }); return; }
  const heading = node.querySelector<HTMLElement>(".task-title");
  if (heading) { heading.tabIndex = -1; heading.focus({ preventScroll: true }); }
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
  const focus = focusHeld(list);
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
    // Remove changed groups first so adding their replacements leaves the unchanged groups in place.
    const keep = new Set<Element>(nodes);
    for (const child of [...list.children]) if (!keep.has(child)) child.remove();
    nodes.forEach((node, i) => {
      const at = list.children[i] ?? null;
      if (node !== at) list.insertBefore(node, at);
    });
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
  if (focus) keepFocus(focus);
  // A task's state, said once when it changes (not on the first list).
  const live: string[] = [];
  for (const t of all) {
    const before = said.get(t.id);
    if (before !== undefined && before !== t.status) live.push(taskAnnouncement(t.title, t.status, t.unanswered === true));
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
  void refreshTasks(true);
  window.ember.onTasks(entries => {
    readEpoch++;
    // Old-manager updates can arrive while sign-out drains. The next ready connection is read afresh.
    if (!awaitingAccount) render(entries);
  });
  window.ember.onConversationForgotten?.(() => {
    const list = $("tasks"), bar = $("task-filter");
    const focused = document.activeElement;
    const hadFocus = !!focused && (list.contains(focused) || bar.contains(focused) || (focused === document.body && focusedAction?.account === accountEpoch));
    accountEpoch++;
    readEpoch++;
    awaitingAccount = true;
    focusedAction = null;
    opened.clear(); said.clear();
    $("tasks-live").textContent = "";
    render([]);
    if (hadFocus && (document.activeElement === document.body || list.contains(document.activeElement) || bar.contains(document.activeElement))) {
      const heading = document.getElementById("tasks-h") ?? list;
      heading.tabIndex = -1;
      heading.focus();
    }
  });
  window.ember.onAgentStatus?.(status => {
    if (!awaitingAccount || status.phase !== "ready") return;
    awaitingAccount = false;
    void refreshTasks(true);
  });
  setInterval(() => { if (latest.some(t => t.activity.endedAt === undefined)) tick(); }, 1000);
}
