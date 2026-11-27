/**
 * The panel's Plan tab (docs/CODING-APP.md §4): the session's plan file (`plan.read`, drawn with the window's
 * markdown-to-nodes renderer, never as markup), edited and saved (`plan.update`) or deleted (`plan.delete`, after a
 * plain question); the to-dos with their dependencies (`plan.readSqlTodosWithDependencies`, else `plan.readSqlTodos`);
 * and the Autopilot objective (`autopilotObjective.getState` and the objective file, written and deleted through
 * `workspaces.*AutopilotObjective`). It reads each again when the SDK says it changed (`session.plan_changed`,
 * `session.todos_changed`, `session.autopilot_objective_changed`), and only while it is up.
 *
 * When main has an exit-plan-mode request waiting for the session, the tab shows that request's own card (cards.ts
 * `requestCard`, with its arming and its one answer path through `app.respond`) and the tab's name carries a mark: one
 * decision, answered once, wherever it is answered. A method not on CODE_RPC's allow-list is not called: the part says
 * it isn't available and lights up once the method is allowed.
 */
import { codeRpcAllowed, type CodeDone } from "../../shared/code";
import { Arming, requestCard } from "./cards";
import { PANEL_NO_SESSION, TAB_NAMES, UNREACHABLE } from "./copy";
import * as W from "./copy-plan";
import { el } from "./dom";
import { markdownNodes } from "./markdown-dom";
import type { PanelContext, PanelInstance, PanelTab } from "./panel";
import { redraw, section } from "./panel-kit";
import {
  TODO_SYMBOL, fitsParams, objectiveFileFrom, objectiveStateFrom, objectiveText, pendingPlanExit, planFrom, requestItemOf, todoProgress, todosFrom,
  type Objective, type PlanFile, type TodoList,
} from "./plan-model";
import type { CodeState } from "./store";

type Load<T> = { state: "idle" } | { state: "loading"; was?: T } | { state: "ok"; value: T } | { state: "failed"; reason: string; was?: T };
const valueOf = <T>(l: Load<T>): T | undefined => (l.state === "ok" ? l.value : l.state === "loading" || l.state === "failed" ? l.was : undefined);
const reasonOf = (r: CodeDone<unknown>): string => (r.ok ? "" : r.reason || UNREACHABLE);
const PLAN_MAX = 200_000;

export const planTab: PanelTab = {
  id: "plan", label: TAB_NAMES.plan ?? "Plan", mount: mountPlan,
  mark: s => (pendingPlanExit(s, s.view.kind === "session" ? s.view.id : null) ? W.TAB_MARK : null),
};

type Editing = { text: string; changed: boolean; saving: boolean; problem?: string } | null;

function mountPlan(host: HTMLElement, ctx: PanelContext): PanelInstance {
  const app = ctx.app;
  let sid: string | null = null;
  let plan: Load<PlanFile> = { state: "idle" };
  let todos: Load<TodoList> = { state: "idle" };
  let objective: Load<Objective> = { state: "idle" };
  const tokens = { plan: 0, todos: 0, objective: 0 };
  let planEdit: Editing = null, objEdit: Editing = null;
  let confirm: "plan" | "objective" | null = null;
  let planNote = "", objNote = "";
  const dirty = { plan: false, todos: false, objective: false };
  const arming = new Arming();
  let drawnRequest = "";
  /** show() ran in this draw: its reads stand for the panel opening again. */
  let justShown = false;
  const up = () => !host.hidden && app.state.ui.panelOpen && app.state.ui.panelTab === "plan";
  const say = (text: string) => app.onSaid?.("said", text);

  const none = el("p", { className: "panel-empty" });
  const waitingHost = el("div", { className: "pt-body pl-waiting-host" });
  const planHost = el("div", { className: "pt-body" });
  const todosHost = el("div", { className: "pt-body" });
  const objHost = el("div", { className: "pt-body" });
  const body = el("div", { className: "pt pl" }, waitingHost, section("pl-plan", W.PLAN_HEADING, planHost), section("pl-todos", W.TODOS_HEADING, todosHost), section("pl-obj", W.OBJECTIVE_HEADING, objHost));
  host.replaceChildren(none, body);

  const stopWatching = app.watchEvents(env => {
    if (env.sessionId !== sid) return;
    const t = env.event.type;
    const part = t === "session.plan_changed" ? "plan" : t === "session.todos_changed" ? "todos" : t === "session.autopilot_objective_changed" ? "objective" : null;
    if (!part) return;
    if (!up()) { dirty[part] = true; return; }
    if (part === "plan") void readPlan(); else if (part === "todos") void readTodos(); else void readObjective();
  });

  async function call(method: string, params?: unknown): Promise<CodeDone<unknown>> {
    if (!sid) return { ok: false, reason: UNREACHABLE };
    if (!codeRpcAllowed("session", method)) return { ok: false, reason: "", code: "not-allowed" };
    return app.rpc({ scope: "session", sessionId: sid, method, ...(params !== undefined ? { params } : {}) });
  }

  // ───── The plan file ─────
  async function readPlan(): Promise<void> {
    if (!sid) return;
    const my = ++tokens.plan, at = sid;
    plan = { state: "loading", ...(valueOf(plan) ? { was: valueOf(plan) } : {}) };
    const r = await call("plan.read");
    if (my !== tokens.plan || at !== sid) return;
    const p = r.ok ? planFrom(r.value) : null;
    if (p && planEdit && valueOf(plan) && p.content !== valueOf(plan)!.content) planEdit.changed = true;
    plan = p ? { state: "ok", value: p } : { state: "failed", reason: reasonOf(r), ...(valueOf(plan) ? { was: valueOf(plan) } : {}) };
    drawPlan();
  }

  function drawPlan(): void {
    const p = valueOf(plan);
    const parts: (HTMLElement | null)[] = [];
    if (plan.state === "failed") parts.push(el("p", { className: "pt-problem", textContent: W.readFailed("plan", plan.reason) }));
    if (planNote) parts.push(el("p", { className: "pt-note", tabIndex: -1, textContent: planNote, data: { key: "plan-note" } }));
    if (planEdit) {
      const e = planEdit;
      const area = el("textarea", { id: "pl-editor", className: "pl-editor", rows: 14, maxLength: PLAN_MAX, value: e.text, spellcheck: true, disabled: e.saving, data: { key: "plan-editor" } });
      area.addEventListener("input", () => { e.text = area.value; });
      const save = el("button", { type: "submit", className: "btn small", textContent: W.PLAN_SAVE, disabled: e.saving, data: { key: "plan-save" } });
      const cancel = el("button", { type: "button", className: "btn quiet small", textContent: W.CANCEL, disabled: e.saving, data: { key: "plan-cancel" } });
      cancel.addEventListener("click", () => { planEdit = null; drawPlan(); focusKey(planHost, p?.exists ? "plan-edit" : "plan-write"); });
      const f = el("form", { className: "pt-form" }, el("label", { htmlFor: area.id, textContent: W.PLAN_EDITOR }), area,
        e.changed ? el("p", { className: "pt-note", textContent: W.PLAN_CHANGED }) : null,
        e.problem ? el("p", { className: "pt-problem", attrs: { role: "alert" }, textContent: e.problem }) : null,
        e.saving ? el("p", { className: "hint", textContent: W.SAVING }) : null,
        el("div", { className: "pt-actions" }, save, cancel));
      f.addEventListener("submit", ev => { ev.preventDefault(); void savePlan(); });
      area.addEventListener("keydown", ev => { if (ev.key === "Escape" && !e.saving) { ev.preventDefault(); ev.stopPropagation(); cancel.click(); } });
      parts.push(f);
    } else if (p?.exists) {
      parts.push(el("div", { className: "pl-doc md", tabIndex: 0, attrs: { role: "document", "aria-label": W.PLAN_DOC } }, ...markdownNodes(p.content)));
      const edit = el("button", { type: "button", className: "btn quiet small", textContent: W.PLAN_EDIT, data: { key: "plan-edit" } });
      const del = el("button", { type: "button", className: "link-btn danger", textContent: W.PLAN_DELETE, attrs: { "aria-expanded": String(confirm === "plan") }, data: { key: "plan-delete" } });
      edit.addEventListener("click", () => { planEdit = { text: p.content, changed: false, saving: false }; confirm = null; planNote = ""; drawPlan(); focusKey(planHost, "plan-editor"); });
      del.addEventListener("click", () => { confirm = confirm === "plan" ? null : "plan"; drawPlan(); focusKey(planHost, confirm ? "plan-confirm" : "plan-delete"); });
      parts.push(el("div", { className: "pt-actions" }, edit, del));
      if (confirm === "plan") parts.push(confirmBox("plan", W.DELETE_PLAN_QUESTION, W.DELETE_PLAN_DETAIL, () => { void deletePlan(); }));
    } else if (p) {
      const write = el("button", { type: "button", className: "btn quiet small", textContent: W.PLAN_WRITE, data: { key: "plan-write" } });
      write.addEventListener("click", () => { planEdit = { text: "", changed: false, saving: false }; planNote = ""; drawPlan(); focusKey(planHost, "plan-editor"); });
      parts.push(el("p", { className: "pt-empty", textContent: W.PLAN_NONE }), el("p", { className: "hint", textContent: W.PLAN_NONE_HINT }), el("div", { className: "pt-actions" }, write));
    }
    redraw(planHost, ...parts);
  }

  async function savePlan(): Promise<void> {
    const e = planEdit;
    if (!e || e.saving) return;
    if (!fitsParams(e.text)) { e.problem = W.PLAN_TOO_LONG; drawPlan(); return; }
    e.saving = true; e.problem = undefined; drawPlan();
    const r = await call("plan.update", { content: e.text });
    e.saving = false;
    if (!r.ok) { e.problem = W.writeFailed("plan", "save", reasonOf(r)); drawPlan(); focusKey(planHost, "plan-editor"); return; }
    planEdit = null; planNote = W.PLAN_SAVED; say(planNote);
    plan = { state: "ok", value: { exists: true, content: e.text } };
    drawPlan(); focusKey(planHost, "plan-note");
    void readPlan();
  }

  async function deletePlan(): Promise<void> {
    confirm = null;
    const r = await call("plan.delete");
    if (!r.ok) { planNote = W.writeFailed("plan", "delete", reasonOf(r)); drawPlan(); focusKey(planHost, "plan-note"); return; }
    planNote = W.PLAN_DELETED; say(planNote);
    plan = { state: "ok", value: { exists: false, content: "" } };
    drawPlan(); focusKey(planHost, "plan-note");
    void readPlan();
  }

  // ───── To-dos ─────
  async function readTodos(): Promise<void> {
    if (!sid) return;
    const my = ++tokens.todos, at = sid;
    todos = { state: "loading", ...(valueOf(todos) ? { was: valueOf(todos) } : {}) };
    const withDeps = codeRpcAllowed("session", "plan.readSqlTodosWithDependencies");
    let r = await call(withDeps ? "plan.readSqlTodosWithDependencies" : "plan.readSqlTodos");
    let deps = withDeps;
    // An older runtime without the dependencies method: the rows alone.
    if (withDeps && !r.ok) { const plain = await call("plan.readSqlTodos"); if (plain.ok) { r = plain; deps = false; } }
    if (my !== tokens.todos || at !== sid) return;
    const list = r.ok ? todosFrom(r.value, deps) : null;
    todos = list ? { state: "ok", value: list } : { state: "failed", reason: r.ok ? "" : r.code === "not-allowed" ? W.notAvailable("todos") : reasonOf(r) };
    drawTodos();
  }

  function drawTodos(): void {
    const v = valueOf(todos);
    const parts: (HTMLElement | null)[] = [];
    if (todos.state === "failed") parts.push(el("p", { className: "pt-problem", textContent: todos.reason.startsWith("To-dos can't") ? todos.reason : W.readFailed("todos", todos.reason) }));
    if (v && !v.todos.length) parts.push(el("p", { className: "pt-empty", textContent: W.TODOS_NONE }));
    if (v?.todos.length) {
      const pr = todoProgress(v.todos);
      parts.push(el("p", { className: "pl-progress", textContent: W.todoProgress(pr.done, pr.total) }));
      const list = el("ul", { className: "pl-todos", attrs: { role: "list" } });
      for (const t of v.todos) {
        const status = W.todoStatusWord(t.status, t.rawStatus);
        list.append(el("li", { className: "pl-todo", data: { state: t.status } },
          el("span", { className: "pl-sym", attrs: { "aria-hidden": "true" }, data: { status: TODO_SYMBOL[t.status] } }),
          el("div", { className: "pl-todo-words" },
            el("p", { className: "pl-todo-title" }, el("span", { className: "sr", textContent: `${status}: ` }), t.title),
            el("p", { className: "pl-todo-state", attrs: { "aria-hidden": "true" }, textContent: status }),
            t.description ? el("p", { className: "pl-todo-desc", textContent: t.description }) : null,
            t.after.length ? el("p", { className: "pl-todo-after", textContent: W.afterWords(t.after) }) : null)));
      }
      parts.push(list);
      if (!v.withDependencies) parts.push(el("p", { className: "hint", textContent: W.NO_DEPENDENCIES }));
    }
    redraw(todosHost, ...parts);
  }

  // ───── The Autopilot objective ─────
  async function readObjective(): Promise<void> {
    if (!sid) return;
    const my = ++tokens.objective, at = sid;
    objective = { state: "loading", ...(valueOf(objective) ? { was: valueOf(objective) } : {}) };
    const [st, file] = await Promise.all([call("autopilotObjective.getState"), call("workspaces.readAutopilotObjective")]);
    if (my !== tokens.objective || at !== sid) return;
    const state = st.ok ? objectiveStateFrom(st.value) : undefined;
    const content = file.ok ? objectiveFileFrom(file.value) : undefined;
    if (state === undefined && content === undefined) {
      const notAllowed = !st.ok && st.code === "not-allowed" && !file.ok && file.code === "not-allowed";
      objective = { state: "failed", reason: notAllowed ? W.notAvailable("objective") : W.readFailed("objective", !file.ok ? reasonOf(file) : !st.ok ? reasonOf(st) : "") };
    } else {
      const next: Objective = { content: content ?? null, ...(state !== undefined ? { state } : {}) };
      if (objEdit && valueOf(objective) && objectiveText(next) !== objectiveText(valueOf(objective)!)) objEdit.changed = true;
      objective = { state: "ok", value: next };
    }
    drawObjective();
  }

  function drawObjective(): void {
    const o = valueOf(objective);
    const parts: (HTMLElement | null)[] = [];
    if (objective.state === "failed") parts.push(el("p", { className: "pt-problem", textContent: objective.reason }));
    if (objNote) parts.push(el("p", { className: "pt-note", tabIndex: -1, textContent: objNote, data: { key: "obj-note" } }));
    const text = o ? objectiveText(o) : "";
    if (objEdit) {
      const e = objEdit;
      const area = el("textarea", { id: "pl-obj-editor", rows: 4, maxLength: 20_000, value: e.text, disabled: e.saving, data: { key: "obj-editor" } });
      area.addEventListener("input", () => { e.text = area.value; });
      const save = el("button", { type: "submit", className: "btn quiet small", textContent: W.OBJECTIVE_SAVE, disabled: e.saving, data: { key: "obj-save" } });
      const cancel = el("button", { type: "button", className: "btn quiet small", textContent: W.CANCEL, disabled: e.saving, data: { key: "obj-cancel" } });
      cancel.addEventListener("click", () => { objEdit = null; drawObjective(); focusKey(objHost, text ? "obj-edit" : "obj-set"); });
      const f = el("form", { className: "pt-form" }, el("label", { htmlFor: area.id, textContent: W.OBJECTIVE_EDITOR }), area,
        e.changed ? el("p", { className: "pt-note", textContent: W.OBJECTIVE_CHANGED }) : null,
        e.problem ? el("p", { className: "pt-problem", attrs: { role: "alert" }, textContent: e.problem }) : null,
        e.saving ? el("p", { className: "hint", textContent: W.SAVING }) : null,
        el("div", { className: "pt-actions" }, save, cancel));
      f.addEventListener("submit", ev => { ev.preventDefault(); void saveObjective(); });
      area.addEventListener("keydown", ev => { if (ev.key === "Escape" && !e.saving) { ev.preventDefault(); ev.stopPropagation(); cancel.click(); } });
      parts.push(f);
    } else if (o && text) {
      const st = o.state;
      const meta = st ? [W.OBJECTIVE_STATUS[st.status], W.objectiveTurns(st.turns)].join(" · ") : "";
      parts.push(el("div", { className: "pl-obj" },
        meta ? el("p", { className: "pl-obj-meta", data: { status: st?.status === "completed" ? "done" : st?.status === "paused" ? "stopped" : "running" } }, meta) : null,
        el("p", { className: "pl-obj-text", textContent: text }),
        st?.pauseReason ? el("p", { className: "hint", textContent: W.pausedBecause(st.pauseReason) }) : null,
        st?.summary ? el("p", { className: "hint", textContent: W.metSummary(st.summary) }) : null));
      const edit = el("button", { type: "button", className: "btn quiet small", textContent: W.OBJECTIVE_EDIT, data: { key: "obj-edit" } });
      const del = el("button", { type: "button", className: "link-btn danger", textContent: W.OBJECTIVE_DELETE, attrs: { "aria-expanded": String(confirm === "objective") }, data: { key: "obj-delete" } });
      edit.addEventListener("click", () => { objEdit = { text, changed: false, saving: false }; confirm = null; objNote = ""; drawObjective(); focusKey(objHost, "obj-editor"); });
      del.addEventListener("click", () => { confirm = confirm === "objective" ? null : "objective"; drawObjective(); focusKey(objHost, confirm ? "objective-confirm" : "obj-delete"); });
      parts.push(el("div", { className: "pt-actions" }, edit, del));
      if (confirm === "objective") parts.push(confirmBox("objective", W.DELETE_OBJECTIVE_QUESTION, W.DELETE_OBJECTIVE_DETAIL, () => { void deleteObjective(); }));
    } else if (o) {
      const set = el("button", { type: "button", className: "btn quiet small", textContent: W.OBJECTIVE_SET, data: { key: "obj-set" } });
      set.addEventListener("click", () => { objEdit = { text: "", changed: false, saving: false }; objNote = ""; drawObjective(); focusKey(objHost, "obj-editor"); });
      parts.push(el("p", { className: "pt-empty", textContent: W.OBJECTIVE_NONE }), el("p", { className: "hint", textContent: W.OBJECTIVE_NONE_HINT }), el("div", { className: "pt-actions" }, set));
    }
    redraw(objHost, ...parts);
  }

  async function saveObjective(): Promise<void> {
    const e = objEdit;
    if (!e || e.saving) return;
    if (!e.text.trim()) { e.problem = W.OBJECTIVE_EMPTY; drawObjective(); focusKey(objHost, "obj-editor"); return; }
    if (!fitsParams(e.text)) { e.problem = W.OBJECTIVE_TOO_LONG; drawObjective(); return; }
    e.saving = true; e.problem = undefined; drawObjective();
    const r = await call("workspaces.writeAutopilotObjective", { content: e.text });
    e.saving = false;
    if (!r.ok) { e.problem = W.writeFailed("objective", "save", reasonOf(r)); drawObjective(); focusKey(objHost, "obj-editor"); return; }
    objEdit = null; objNote = W.OBJECTIVE_SAVED; say(objNote);
    drawObjective(); focusKey(objHost, "obj-note");
    void readObjective();
  }

  async function deleteObjective(): Promise<void> {
    confirm = null;
    const r = await call("workspaces.deleteAutopilotObjective");
    objNote = r.ok ? W.OBJECTIVE_DELETED : W.writeFailed("objective", "delete", reasonOf(r));
    if (r.ok) { say(objNote); objective = { state: "ok", value: { content: null, state: null } }; }
    drawObjective(); focusKey(objHost, "obj-note");
    void readObjective();
  }

  /** A plain question before deleting: the question, what it does, then Delete and Keep it (neither prominent). */
  function confirmBox(what: "plan" | "objective", question: string, detail: string, yes: () => void): HTMLElement {
    const id = `pl-confirm-${what}`;
    const del = el("button", { type: "button", className: "btn quiet small danger", textContent: W.DELETE, data: { key: `${what}-confirm` } });
    const keep = el("button", { type: "button", className: "btn quiet small", textContent: W.KEEP, data: { key: `${what}-keep` } });
    const back = () => { confirm = null; if (what === "plan") { drawPlan(); focusKey(planHost, "plan-delete"); } else { drawObjective(); focusKey(objHost, "obj-delete"); } };
    del.addEventListener("click", yes);
    keep.addEventListener("click", back);
    const box = el("div", { className: "pt-confirm", attrs: { role: "group", "aria-labelledby": `${id}-q`, "aria-describedby": `${id}-d` } },
      el("p", { className: "pt-confirm-q", id: `${id}-q`, textContent: question }), el("p", { className: "hint", id: `${id}-d`, textContent: detail }), el("div", { className: "pt-actions" }, del, keep));
    box.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); back(); } });
    return box;
  }

  // ───── The exit-plan-mode request ─────
  function drawWaiting(s: CodeState): void {
    const p = pendingPlanExit(s, sid);
    const answering = p ? s.answering[p.requestId] : undefined;
    const sig = p ? `${p.requestId}:${answering?.state ?? ""}:${answering?.reason ?? ""}` : "";
    if (sig === drawnRequest) return;
    drawnRequest = sig;
    if (!p || !sid) { redraw(waitingHost); return; }
    const card = requestCard(requestItemOf(p), { app, sessionId: sid, arming, pending: p, answering, idPrefix: "plan-tab-" });
    redraw(waitingHost, el("section", { className: "pt-section pl-waiting", attrs: { "aria-labelledby": "pl-waiting-h" } },
      el("h2", { className: "pt-h", id: "pl-waiting-h", textContent: W.WAITING_HEADING }), el("p", { className: "hint", textContent: W.WAITING_HINT }), card));
  }

  function focusKey(scope: HTMLElement, key: string): void { scope.querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)?.focus(); }

  function readAll(): void { void readPlan(); void readTodos(); void readObjective(); }

  return {
    show(sessionId) {
      justShown = true;
      if (sessionId !== sid) {
        sid = sessionId;
        plan = { state: "idle" }; todos = { state: "idle" }; objective = { state: "idle" };
        planEdit = null; objEdit = null; confirm = null; planNote = ""; objNote = ""; drawnRequest = "";
      }
      dirty.plan = dirty.todos = dirty.objective = false;
      none.hidden = !!sid;
      body.hidden = !sid;
      if (!sid) { none.textContent = PANEL_NO_SESSION; return; }
      drawWaiting(app.state); drawPlan(); drawTodos(); drawObjective();
      readAll();
    },
    render(s: CodeState, prev: CodeState | null) {
      if (!sid) return;
      drawWaiting(s);
      // Opened again after it was closed (the show() of this same draw already read everything).
      const reopened = !justShown && !!prev && !prev.ui.panelOpen && s.ui.panelOpen;
      justShown = false;
      if (dirty.plan || reopened) { dirty.plan = false; void readPlan(); }
      if (dirty.todos || reopened) { dirty.todos = false; void readTodos(); }
      if (dirty.objective || reopened) { dirty.objective = false; void readObjective(); }
    },
    dispose() { stopWatching(); },
  };
}
