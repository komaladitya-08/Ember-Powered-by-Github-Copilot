/** The conductor's project board. Names and model results are always plain text. */
import type { ProjectSession, ProjectSessionsState } from "../../shared/project-sessions";
import { STATUS_WORDS } from "../../shared/activity";
import { ipcErrorText } from "./copy";

export function mountProjectSessions(): void {
  const root = document.querySelector<HTMLElement>("#project-sessions")!;
  const find = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#project-sessions-${id}`)!;
  const create = find<HTMLFormElement>("create");
  const name = find<HTMLInputElement>("name");
  const goal = find<HTMLTextAreaElement>("goal");
  const add = find<HTMLButtonElement>("add");
  const select = find<HTMLSelectElement>("select");
  const goalText = find<HTMLParagraphElement>("goal-text");
  const requestForm = find<HTMLFormElement>("request-form");
  const request = find<HTMLTextAreaElement>("request");
  const send = find<HTMLButtonElement>("send");
  const forget = find<HTMLButtonElement>("forget");
  const status = find<HTMLParagraphElement>("status");
  const list = find<HTMLOListElement>("list");
  const save = find<HTMLButtonElement>("save");
  const open = find<HTMLButtonElement>("open");
  const forgetSaved = find<HTMLButtonElement>("forget-saved");
  let state: ProjectSessionsState = { projects: [], selectedProjectId: null };
  let loaded = false;
  let connected = false;
  let pending = false;
  let epoch = 0;
  let accountEpoch = 0;
  let drawn = "";

  const active = () => state.projects.find(p => p.id === state.selectedProjectId);
  const ongoing = (session: ProjectSession) => !["done", "failed", "stopped"].includes(session.status);
  const button = (label: string, clicked: () => void) => {
    const result = document.createElement("button");
    result.type = "button";
    result.className = "btn quiet small";
    result.textContent = label;
    result.addEventListener("click", clicked);
    return result;
  };
  const render = () => {
    const project = active();
    const options = [{ id: "", name: "No active project" }, ...state.projects];
    if (JSON.stringify(options.map(p => [p.id, p.name])) !== select.dataset.options) {
      select.replaceChildren(...options.map(p => new Option(p.name, p.id)));
      select.dataset.options = JSON.stringify(options.map(p => [p.id, p.name]));
    }
    select.value = state.selectedProjectId ?? "";
    select.disabled = !loaded || pending;
    add.disabled = !loaded || pending;
    forget.disabled = !project || pending || project.sessions.some(ongoing);
    request.disabled = !project || !connected || pending;
    send.disabled = request.disabled;
    save.disabled = !loaded || !connected || pending || !state.projects.length;
    open.disabled = !loaded || !connected || pending || state.projects.some(p => p.sessions.some(ongoing));
    forgetSaved.disabled = !loaded || !connected || pending;
    goalText.textContent = project?.goal ?? "";
    goalText.hidden = !project?.goal;
    // Keep focused session controls in place unless their actual state changes.
    const signature = JSON.stringify([project?.id, project?.sessions]);
    if (signature === drawn) return;
    drawn = signature;
    const focused = list.contains(document.activeElement) && document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.sessionControl : undefined;
    list.replaceChildren();
    if (!project?.sessions.length) {
      const item = document.createElement("li");
      item.className = "hint";
      item.textContent = project ? "No delegated sessions yet. Ask Ember what to do next, or give it a task to delegate." : "Create or select a project to see its sessions.";
      list.append(item);
      return;
    }
    for (const session of project.sessions) {
      const item = document.createElement("li");
      const heading = document.createElement("h4");
      heading.textContent = session.title;
      const detail = document.createElement("p");
      detail.className = "hint";
      detail.textContent = `${session.kind === "coding" ? "Coding" : "Desktop"} · ${STATUS_WORDS[session.status]}${session.detail ? ` · ${session.detail}` : ""}`;
      item.append(heading, detail);
      if (session.summary) {
        const summary = document.createElement("p");
        summary.textContent = session.summary;
        item.append(summary);
      }
      const controls = document.createElement("div");
      controls.className = "agent-actions";
      controls.append(button("Task activity", () => document.getElementById("p-tasks")?.click()));
      if (ongoing(session)) {
        const stop = button("Stop session", () => {
          const owner = accountEpoch;
          stop.disabled = true;
          void window.ember.taskControl(session.taskId, "stop").then(async accepted => {
            if (owner !== accountEpoch) return;
            status.textContent = accepted ? "Stopping this session…" : "This session has already ended or is no longer available.";
            await refresh();
          }).catch(() => {
            if (owner !== accountEpoch) return;
            status.textContent = "Couldn't stop the session. Try Stop everything on Home.";
            stop.disabled = false;
          });
        });
        stop.setAttribute("aria-label", `Stop session: ${session.title}`);
        stop.dataset.sessionControl = session.taskId;
        controls.append(stop);
      }
      item.append(controls);
      list.append(item);
    }
    if (focused) [...list.querySelectorAll<HTMLButtonElement>("[data-session-control]")]
      .find(control => control.dataset.sessionControl === focused)?.focus({ preventScroll: true });
  };
  const refresh = async () => {
    const ticket = ++epoch;
    try {
      const next = await window.ember.projectSessionsState();
      if (ticket !== epoch) return;
      state = next;
      loaded = true;
      render();
    } catch {
      if (ticket === epoch) status.textContent = "Couldn't load projects. Reopen Settings to try again.";
    }
  };
  const change = async (input: unknown): Promise<boolean> => {
    const ticket = ++epoch;
    const owner = accountEpoch;
    pending = true;
    render();
    try {
      const next = await window.ember.projectSessionsAction(input);
      if (ticket !== epoch) return false;
      state = next;
      loaded = true;
      return true;
    } catch (err) {
      if (ticket === epoch) status.textContent = ipcErrorText(err);
      return false;
    } finally {
      if (owner === accountEpoch) {
        pending = false;
        render();
        void refresh();
      }
    }
  };
  create.addEventListener("submit", event => {
    event.preventDefault();
    if (add.disabled || !name.value.trim()) return;
    const focused = document.activeElement;
    const submittedName = name.value, submittedGoal = goal.value;
    void change({ action: "create", name: submittedName, goal: submittedGoal }).then(ok => {
      if (!ok) return;
      if (name.value === submittedName) name.value = "";
      if (goal.value === submittedGoal) goal.value = "";
      status.textContent = "Project created. Ask the conductor to plan or delegate work.";
      if (!request.disabled && document.activeElement === focused && create.contains(focused)) request.focus();
    });
  });
  select.addEventListener("change", () => {
    if (select.disabled) return;
    void change({ action: "select", id: select.value || null }).then(ok => { if (ok) status.textContent = active() ? `Active project: ${active()!.name}.` : "New tasks won't be grouped into a project."; });
  });
  forget.addEventListener("click", () => {
    if (forget.disabled || !active()) return;
    void change({ action: "forget", id: active()!.id }).then(ok => { if (ok) status.textContent = "Project record forgotten. Your files are unchanged."; });
  });
  requestForm.addEventListener("submit", event => {
    event.preventDefault();
    if (send.disabled || !request.value.trim()) return;
    const owner = accountEpoch;
    const text = request.value;
    pending = true;
    render();
    void window.ember.conversationSend(text).then(result => {
      if (owner !== accountEpoch) return;
      if (request.value === text) request.value = "";
      status.textContent = result === "stopped" ? "Ember stopped its work." : "Sent to the conductor. Its reply appears in the shared conversation; delegated tasks appear here.";
    }).catch(err => { if (owner === accountEpoch) status.textContent = ipcErrorText(err); }).finally(() => {
      if (owner === accountEpoch) {
        pending = false;
        render();
        void refresh();
      }
    });
  });
  find<HTMLButtonElement>("conversation").addEventListener("click", () => document.getElementById("p-write")?.click());
  find<HTMLButtonElement>("activity").addEventListener("click", () => document.getElementById("p-tasks")?.click());
  const checkpoint = async (action: "save" | "open" | "forget") => {
    const ticket = ++epoch;
    const owner = accountEpoch;
    pending = true;
    render();
    try {
      const reply = await window.ember.projectSessionsCheckpoint(action);
      if (ticket !== epoch) return;
      state = reply.state;
      status.textContent = reply.message;
    } catch (err) {
      if (ticket === epoch) status.textContent = ipcErrorText(err);
    } finally {
      if (owner === accountEpoch) {
        pending = false;
        render();
        void refresh();
      }
    }
  };
  save.addEventListener("click", () => { if (!save.disabled) void checkpoint("save"); });
  open.addEventListener("click", () => { if (!open.disabled) void checkpoint("open"); });
  forgetSaved.addEventListener("click", () => { if (!forgetSaved.disabled) void checkpoint("forget"); });
  window.ember.onTasks(() => { if (!pending) void refresh(); });
  window.ember.onConversation(() => { if (!pending) void refresh(); });
  let statusEpoch = 0;
  window.ember.onAgentStatus(next => { statusEpoch++; connected = next.phase === "ready"; render(); if (!pending) void refresh(); });
  const statusTicket = statusEpoch;
  void window.ember.agentStatus().then(next => { if (statusTicket === statusEpoch) { connected = next?.phase === "ready"; render(); } }).catch(() => undefined);
  window.ember.onConversationForgotten(() => {
    accountEpoch++;
    epoch++;
    pending = false;
    state = { projects: [], selectedProjectId: null };
    name.value = ""; goal.value = ""; request.value = "";
    status.textContent = "";
    render();
    void refresh();
  });
  render();
  void refresh();
}
