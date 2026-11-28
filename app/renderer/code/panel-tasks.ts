/**
 * The panel's Agents and tasks tab (docs/CODING-APP.md §4): the session's background agents and shells (`tasks.list`,
 * with `tasks.getProgress`'s latest line for the running ones), read again when the SDK says they changed
 * (`session.background_tasks_changed`) or a sub-agent starts or ends; each with its name, kind, state, model, what it is
 * doing and how long it has been at work, and the actions the SDK offers for it: send it a message, cancel, remove,
 * move to the background. Above them, moving the current foreground work to the background (offered only while
 * `tasks.getCurrentPromotable` names some) and "Fleet…"; below, this turn's sub-agents with their rows in the transcript,
 * starting an agent (`tasks.startAgent`, its types from `agent.list`) and the scheduled prompts (`schedule.list`, `stop`).
 * The tab's name carries the count of what is running, whichever tab is up (panel.ts `badge`).
 *
 * The SDK's words for a task (its description, result, error, latest response) are the task's own and are shown as
 * its, in the secondary label, never as Ember's; what Ember says about an outcome is its own plain sentence.
 */
import type { CodeApp } from "./app";
import { PANEL_NO_SESSION } from "./copy";
import {
  AGENT_NAME, AGENT_PROMPT, AGENT_TYPE, BACKGROUND_HEADING, CANCEL_TASK, CANT_CANCEL, CANT_FLEET, CANT_PROMOTE, CANT_REMOVE, CANT_SEND, CANT_START,
  CANT_STOP_SCHEDULE, CLOSE, FLEET, FLEET_PROMPT, FLEET_STARTED, FLEET_WHAT, LOADING_TASKS, MOVE_TO_BACKGROUND, NEEDS_NAME, NEEDS_PROMPT, NO_AGENT_TYPES,
  NO_SCHEDULES, NO_SUB_AGENTS, NO_TASKS, PROMOTE_CURRENT, REMOVE_TASK, SCHEDULES_HEADING, SEND, SEND_MESSAGE, SENT, SHOW_IN_TRANSCRIPT, START_AGENT,
  START_FLEET, START_HEADING, STARTED, STOP_SCHEDULE, TASKS_FAILED, TURN_HEADING, cancelLabel, kindWords, messageFieldLabel, messageLabel, promoteLabel,
  removeLabel, scheduleWhen, showLabel, stateMark, stateWords, stopScheduleLabel, subAgentFacts, tabLabel,
} from "./copy-tasks";
import { duration } from "./copy-terminal";
import { button, el, idPart, setText } from "./dom";
import { registerPanelTab, type PanelContext } from "./panel";
import { revealInTranscript, rowKeyFor } from "./reveal";
import { rec } from "./sdk";
import type { CodeState } from "./store";
import {
  agentTypes, elapsedMs, progressLine, runningCount, said, scheduleRows, taskRow, taskRows, taskSignal, turnSubAgents, withProgress,
  type AgentType, type ScheduleRow, type TaskRow,
} from "./tasks-model";

/** The most running tasks whose progress is read at once, and the wait before reading again after a change. */
const PROGRESS_MAX = 8, REREAD_MS = 250;

/** What is known of each session's tasks, shared by the tab and its count (which runs whichever tab is up). */
interface Known { sig: string; rows: TaskRow[]; reading: boolean; failed: boolean; read: boolean }
const known = new Map<string, Known>();
const knownOf = (id: string): Known => {
  let k = known.get(id);
  if (!k) known.set(id, k = { sig: "", rows: [], reading: false, failed: false, read: false });
  return k;
};

/** Read a session's tasks (and the running ones' progress); `then` is told when they came. */
async function readTasks(app: CodeApp, id: string, then?: () => void): Promise<void> {
  const k = knownOf(id);
  k.reading = true;
  const r = await app.rpc({ scope: "session", sessionId: id, method: "tasks.list" });
  let rows = r.ok ? taskRows(r.value) : k.rows;
  if (r.ok) {
    const live = rows.filter(x => x.state === "running").slice(0, PROGRESS_MAX);
    const lines = await Promise.all(live.map(async x => {
      const p = await app.rpc({ scope: "session", sessionId: id, method: "tasks.getProgress", params: { id: x.id } });
      return [x.id, p.ok ? progressLine(p.value) : undefined] as const;
    }));
    rows = withProgress(rows, Object.fromEntries(lines));
  }
  Object.assign(k, { rows, reading: false, failed: !r.ok, read: true });
  then?.();
}

registerPanelTab({
  id: "agents", label: "Agents and tasks", mount,
  badge(s: CodeState, ctx: PanelContext) {
    const id = s.view.kind === "session" ? s.view.id : null;
    if (!id) return null;
    const t = s.transcripts[id];
    const k = knownOf(id);
    const sig = taskSignal(t);
    if (t && sig !== k.sig && !k.reading) { k.sig = sig; void readTasks(ctx.app, id, () => ctx.app.draw()); }
    const n = runningCount(k.rows, turnSubAgents(t));
    return n ? { text: String(n), label: tabLabel(n) } : null;
  },
});

function mount(host: HTMLElement, ctx: PanelContext) {
  const app: CodeApp = ctx.app;
  let sessionId: string | null = null;
  let schedules: ScheduleRow[] = [];
  let types: AgentType[] | null = null;
  let promotable: TaskRow | null = null;
  let messaging: string | null = null;
  const drafts = new Map<string, string>();
  let tick = 0, reread = 0, gen = 0;

  const note = el("p", { className: "pk-note", attrs: { role: "status" } });
  const say = (words: string) => setText(note, words);

  // ───── The bar: promote the current work, and Fleet… ─────
  const promote = button(PROMOTE_CURRENT, { className: "pk-promote" });
  const fleetBtn = button(FLEET, { className: "pk-fleet-open", aria: undefined });
  fleetBtn.setAttribute("aria-expanded", "false");
  fleetBtn.setAttribute("aria-controls", "pk-fleet");
  const fleetText = el("textarea", { id: "pk-fleet-text", className: "pk-field", rows: 3 });
  const fleetGo = el("button", { type: "submit", className: "btn small", textContent: START_FLEET });
  const fleetClose = button(CLOSE);
  const fleet = el("form", { id: "pk-fleet", className: "pk-form", hidden: true },
    el("p", { className: "hint", textContent: FLEET_WHAT }),
    el("label", { className: "pk-label", htmlFor: "pk-fleet-text", textContent: FLEET_PROMPT }), fleetText,
    el("div", { className: "pk-actions" }, fleetGo, fleetClose));
  const bar = el("div", { className: "pk-bar" }, promote, fleetBtn);

  // ───── Lists ─────
  const bgList = el("ul", { className: "pk-list", attrs: { "aria-labelledby": "pk-bg-h" } });
  const bgEmpty = el("p", { className: "pk-empty" });
  const turnList = el("ul", { className: "pk-list", attrs: { "aria-labelledby": "pk-turn-h" } });
  const turnEmpty = el("p", { className: "pk-empty", textContent: NO_SUB_AGENTS });
  const schedList = el("ul", { className: "pk-list", attrs: { "aria-labelledby": "pk-sched-h" } });
  const schedEmpty = el("p", { className: "pk-empty", textContent: NO_SCHEDULES });

  // ───── Start an agent ─────
  const typeSel = el("select", { id: "pk-type", className: "pk-select" });
  const promptText = el("textarea", { id: "pk-prompt", className: "pk-field", rows: 3 });
  const nameField = el("input", { id: "pk-name", className: "pk-input", type: "text", autocomplete: "off", spellcheck: false });
  const startGo = el("button", { type: "submit", className: "btn small", textContent: START_AGENT });
  const startNone = el("p", { className: "pk-empty", textContent: NO_AGENT_TYPES, hidden: true });
  const startForm = el("form", { className: "pk-form" },
    el("label", { className: "pk-label", htmlFor: "pk-type", textContent: AGENT_TYPE }), el("span", { className: "select-wrap" }, typeSel),
    el("label", { className: "pk-label", htmlFor: "pk-prompt", textContent: AGENT_PROMPT }), promptText,
    el("label", { className: "pk-label", htmlFor: "pk-name", textContent: AGENT_NAME }), nameField,
    el("div", { className: "pk-actions" }, startGo));
  const start = el("details", { className: "disclose pk-start" }, el("summary", { textContent: START_HEADING }), startNone, startForm);

  const none = el("p", { className: "panel-empty" });
  const body = el("div", { className: "pk" },
    bar, fleet, note,
    el("section", { className: "pk-sec", attrs: { "aria-labelledby": "pk-bg-h" } }, el("h3", { id: "pk-bg-h", className: "pk-h", textContent: BACKGROUND_HEADING }), bgEmpty, bgList),
    el("section", { className: "pk-sec", attrs: { "aria-labelledby": "pk-turn-h" } }, el("h3", { id: "pk-turn-h", className: "pk-h", textContent: TURN_HEADING }), turnEmpty, turnList),
    start,
    el("section", { className: "pk-sec", attrs: { "aria-labelledby": "pk-sched-h" } }, el("h3", { id: "pk-sched-h", className: "pk-h", textContent: SCHEDULES_HEADING }), schedEmpty, schedList));
  host.replaceChildren(body, none);

  // ───── Reading ─────
  async function refresh(): Promise<void> {
    const id = sessionId;
    if (!id) return;
    const mine = ++gen;
    const busy = !!app.state.transcripts[id]?.busy || !!app.state.sessions.byId[id]?.busy;
    const [, sched, prom] = await Promise.all([
      readTasks(app, id),
      app.rpc({ scope: "session", sessionId: id, method: "schedule.list" }),
      busy ? app.rpc({ scope: "session", sessionId: id, method: "tasks.getCurrentPromotable" }) : Promise.resolve(null),
    ]);
    if (mine !== gen || id !== sessionId) return;
    schedules = sched.ok ? scheduleRows(sched.value) : [];
    promotable = prom && prom.ok ? taskRow(rec(prom.value)?.task) : null;
    draw();
    app.draw();
  }
  async function loadTypes(): Promise<void> {
    const id = sessionId;
    if (!id || types) return;
    const r = await app.rpc({ scope: "session", sessionId: id, method: "agent.list", params: { includeBuiltInAgents: true } });
    if (id !== sessionId) return;
    types = r.ok ? agentTypes(r.value) : [];
    typeSel.replaceChildren(...types.map(a => el("option", { value: a.id, textContent: a.name, title: a.description })));
    startNone.hidden = types.length > 0;
    startForm.hidden = !types.length;
  }

  // ───── Drawing ─────
  function taskItem(r: TaskRow, now: number): HTMLElement {
    const ms = elapsedMs(r, now);
    const actions = el("div", { className: "pk-actions" });
    if (r.canMessage) {
      const b = button(SEND_MESSAGE, { aria: messageLabel(r.name), onClick: () => { messaging = messaging === r.id ? null : r.id; draw(); if (messaging) body.querySelector<HTMLElement>(`#pk-msg-${idPart(r.id)}`)?.focus(); } });
      b.setAttribute("aria-expanded", String(messaging === r.id));
      actions.append(b);
    }
    if (r.canPromote && !r.background) actions.append(button(MOVE_TO_BACKGROUND, { aria: promoteLabel(r.name), onClick: () => { void act(r, "tasks.promoteToBackground", "promoted", CANT_PROMOTE); } }));
    if (r.canCancel) actions.append(button(CANCEL_TASK, { aria: cancelLabel(r.name), onClick: () => { void act(r, "tasks.cancel", "cancelled", CANT_CANCEL); } }));
    if (r.canRemove) actions.append(button(REMOVE_TASK, { aria: removeLabel(r.name), onClick: () => { void act(r, "tasks.remove", "removed", CANT_REMOVE); } }));
    if (r.toolCallId && sessionId && rowKeyFor(app, sessionId, r.toolCallId)) actions.append(button(SHOW_IN_TRANSCRIPT, { aria: showLabel(r.name), onClick: () => reveal(r.toolCallId!) }));
    const li = el("li", { className: "pk-row", data: { task: r.id } },
      el("p", { className: "pk-name", data: { status: stateMark(r.state) } },
        el("span", { className: "pk-title", textContent: r.name }), el("span", { className: "pk-state", textContent: stateWords(r.state) })),
      el("p", { className: "pk-facts" }, el("span", { textContent: [kindWords(r.kind, r.agentType), r.model].filter(Boolean).join(" · ") }),
        ms !== undefined ? el("span", { className: "pk-time", data: { task: r.id }, textContent: ` · ${duration(ms)}` }) : null),
      r.command && r.kind === "shell" && r.command !== r.name ? el("code", { className: "pk-code", textContent: r.command }) : null,
      r.doing && r.state !== "failed" ? el("p", { className: "pk-doing", textContent: r.doing }) : null,
      r.error ? el("p", { className: "pk-doing", textContent: r.error }) : null,
      actions);
    if (messaging === r.id) {
      const field = el("input", { id: `pk-msg-${idPart(r.id)}`, className: "pk-input", type: "text", autocomplete: "off", value: drafts.get(r.id) ?? "", attrs: { "aria-label": messageFieldLabel(r.name) } });
      field.addEventListener("input", () => drafts.set(r.id, field.value));
      field.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); messaging = null; draw(); body.querySelector<HTMLElement>(`[data-task="${CSS.escape(r.id)}"] [aria-expanded]`)?.focus(); } });
      const form = el("form", { className: "pk-msg" }, field, el("button", { type: "submit", className: "btn small", textContent: SEND }));
      form.addEventListener("submit", e => { e.preventDefault(); void message(r, field.value); });
      li.append(form);
    }
    return li;
  }

  function draw(): void {
    const id = sessionId;
    if (!id) return;
    const k = knownOf(id);
    const now = Date.now();
    const focus = document.activeElement instanceof HTMLElement && body.contains(document.activeElement) ? focusKey(document.activeElement) : null;
    bgList.replaceChildren(...k.rows.map(r => taskItem(r, now)));
    setText(bgEmpty, k.rows.length ? "" : !k.read ? LOADING_TASKS : k.failed ? TASKS_FAILED : NO_TASKS);
    bgEmpty.hidden = k.rows.length > 0;
    const subs = turnSubAgents(app.state.transcripts[id]);
    turnList.replaceChildren(...subs.map(a => el("li", { className: "pk-row" },
      el("p", { className: "pk-name", data: { status: stateMark(a.state) } }, el("span", { className: "pk-title", textContent: a.name }), el("span", { className: "pk-state", textContent: stateWords(a.state) })),
      a.description ? el("p", { className: "pk-doing", textContent: a.description }) : null,
      subAgentFacts(a.model, a.steps, a.durationMs) ? el("p", { className: "pk-facts", textContent: subAgentFacts(a.model, a.steps, a.durationMs) }) : null,
      el("div", { className: "pk-actions" }, button(SHOW_IN_TRANSCRIPT, { aria: showLabel(a.name), onClick: () => reveal(a.toolCallId) })))));
    turnEmpty.hidden = subs.length > 0;
    schedList.replaceChildren(...schedules.map(sc => el("li", { className: "pk-row" },
      el("p", { className: "pk-title", textContent: sc.prompt }),
      el("p", { className: "pk-facts", textContent: scheduleWhen(sc) }),
      el("div", { className: "pk-actions" }, button(STOP_SCHEDULE, { aria: stopScheduleLabel(sc.prompt), onClick: () => { void stopSchedule(sc); } })))));
    schedEmpty.hidden = schedules.length > 0;
    promote.hidden = !promotable;
    if (promotable) promote.setAttribute("aria-label", promoteLabel(promotable.name)); else promote.removeAttribute("aria-label");
    if (focus) restoreFocus(focus);
    const live = k.rows.some(r => r.state === "running");
    if (live && !tick) tick = window.setInterval(ticks, 1000);
    if (!live && tick) { clearInterval(tick); tick = 0; }
  }
  /** The clock of a running task is text, changed in place once a second (no drawing again, no motion). */
  function ticks(): void {
    if (!sessionId || host.hidden) return;
    const now = Date.now();
    for (const r of knownOf(sessionId).rows) {
      if (r.state !== "running") continue;
      const ms = elapsedMs(r, now);
      const node = body.querySelector<HTMLElement>(`.pk-time[data-task="${CSS.escape(r.id)}"]`);
      if (node && ms !== undefined) setText(node, ` · ${duration(ms)}`);
    }
  }

  /** Where focus was, so a list drawn again puts it back: the control's label (or field's id) in its row. */
  const focusKey = (e: HTMLElement): { row?: string; id?: string; label?: string } => ({
    ...(e.closest<HTMLElement>("[data-task]")?.dataset.task ? { row: e.closest<HTMLElement>("[data-task]")!.dataset.task } : {}),
    ...(e.id ? { id: e.id } : {}), ...(e.getAttribute("aria-label") ?? e.textContent ? { label: e.getAttribute("aria-label") ?? e.textContent ?? "" } : {}),
  });
  function restoreFocus(f: { row?: string; id?: string; label?: string }): void {
    if (f.id && document.getElementById(f.id)) { document.getElementById(f.id)!.focus({ preventScroll: true }); return; }
    const scope = f.row ? body.querySelector<HTMLElement>(`[data-task="${CSS.escape(f.row)}"]`) : body;
    const match = [...(scope ?? body).querySelectorAll<HTMLElement>("button")].find(b => (b.getAttribute("aria-label") ?? b.textContent) === f.label);
    (match ?? scope?.querySelector<HTMLElement>("button"))?.focus({ preventScroll: true });
  }

  // ───── Actions ─────
  async function act(r: TaskRow, method: string, field: string, failed: string): Promise<void> {
    const id = sessionId;
    if (!id) return;
    const got = await app.rpc({ scope: "session", sessionId: id, method, params: { id: r.id } });
    say(got.ok ? (said(got.value, field) ? "" : failed) : got.reason || failed);
    void refresh();
  }
  async function message(r: TaskRow, words: string): Promise<void> {
    const id = sessionId;
    const text = words.trim();
    if (!id) return;
    if (!text) { say(NEEDS_PROMPT); return; }
    const got = await app.rpc({ scope: "session", sessionId: id, method: "tasks.sendMessage", params: { id: r.id, message: text } });
    if (got.ok && said(got.value, "sent")) { drafts.delete(r.id); messaging = null; say(SENT(r.name)); draw(); body.querySelector<HTMLElement>(`[data-task="${CSS.escape(r.id)}"] button`)?.focus(); }
    else say(got.ok ? CANT_SEND : got.reason || CANT_SEND);
  }
  async function stopSchedule(sc: ScheduleRow): Promise<void> {
    const id = sessionId;
    if (!id) return;
    const got = await app.rpc({ scope: "session", sessionId: id, method: "schedule.stop", params: { id: sc.id } });
    say(got.ok ? (rec(got.value)?.entry ? "" : CANT_STOP_SCHEDULE) : got.reason || CANT_STOP_SCHEDULE);
    void refresh();
  }
  promote.addEventListener("click", () => { void (async () => {
    const id = sessionId;
    if (!id) return;
    const got = await app.rpc({ scope: "session", sessionId: id, method: "tasks.promoteCurrentToBackground" });
    say(got.ok ? (rec(got.value)?.task ? "" : CANT_PROMOTE) : got.reason || CANT_PROMOTE);
    void refresh();
  })(); });

  fleetBtn.addEventListener("click", () => {
    fleet.hidden = !fleet.hidden;
    fleetBtn.setAttribute("aria-expanded", String(!fleet.hidden));
    if (!fleet.hidden) fleetText.focus();
  });
  fleetClose.addEventListener("click", () => { fleet.hidden = true; fleetBtn.setAttribute("aria-expanded", "false"); fleetBtn.focus(); });
  fleet.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); fleetClose.click(); } });
  fleet.addEventListener("submit", e => { e.preventDefault(); void (async () => {
    const id = sessionId;
    const text = fleetText.value.trim();
    if (!id) return;
    if (!text) { say(NEEDS_PROMPT); fleetText.focus(); return; }
    fleetGo.disabled = true;
    const got = await app.rpc({ scope: "session", sessionId: id, method: "fleet.start", params: { prompt: text } });
    fleetGo.disabled = false;
    if (got.ok && said(got.value, "started")) { fleetText.value = ""; fleetClose.click(); say(FLEET_STARTED); void refresh(); }
    else say(got.ok ? CANT_FLEET : got.reason || CANT_FLEET);
  })(); });

  start.addEventListener("toggle", () => { if (start.open) void loadTypes(); });
  startForm.addEventListener("submit", e => { e.preventDefault(); void (async () => {
    const id = sessionId;
    if (!id) return;
    const prompt = promptText.value.trim(), name = nameField.value.trim();
    if (!prompt) { say(NEEDS_PROMPT); promptText.focus(); return; }
    if (!name) { say(NEEDS_NAME); nameField.focus(); return; }
    startGo.disabled = true;
    const got = await app.rpc({ scope: "session", sessionId: id, method: "tasks.startAgent", params: { agentType: typeSel.value, prompt, name } });
    startGo.disabled = false;
    if (got.ok && typeof rec(got.value)?.agentId === "string") { promptText.value = ""; nameField.value = ""; say(STARTED(name)); void refresh(); }
    else say(got.ok ? CANT_START : got.reason || CANT_START);
  })(); });

  function reveal(toolCallId: string): void {
    if (!sessionId) return;
    const key = rowKeyFor(app, sessionId, toolCallId);
    if (key) revealInTranscript(app, key);
  }

  return {
    show(id: string | null) {
      sessionId = id;
      gen++;
      schedules = []; promotable = null; messaging = null; types = null;
      body.hidden = !id;
      none.hidden = !!id;
      setText(none, id ? "" : PANEL_NO_SESSION);
      say("");
      fleet.hidden = true; fleetBtn.setAttribute("aria-expanded", "false");
      start.open = false;
      if (!id) return;
      draw();
      void refresh();
    },
    render(s: CodeState, prev: CodeState | null) {
      if (!sessionId) return;
      const t = s.transcripts[sessionId], was = prev?.transcripts[sessionId];
      if (t === was && prev) return;
      // A sub-agent or a background task changed: read the lists again, once the changes have settled.
      if (taskSignal(t) !== taskSignal(was)) { clearTimeout(reread); reread = window.setTimeout(() => { void refresh(); }, REREAD_MS); }
      if ((t?.busy ?? false) !== (was?.busy ?? false)) draw();
    },
    dispose() { if (tick) clearInterval(tick); clearTimeout(reread); gen++; },
  };
}
