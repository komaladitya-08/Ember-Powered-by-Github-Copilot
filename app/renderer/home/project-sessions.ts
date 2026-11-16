/** The conductor's project board. Names and model results are always plain text. */
import type { ProjectSession, ProjectSessionsState } from "../../shared/project-sessions";
import { STATUS_WORDS } from "../../shared/activity";
import { ipcErrorText } from "./copy";
import { projectRecoveryDraft } from "../../shared/project-recovery";

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
  const plans = find<HTMLDivElement>("plans");
  const review = find<HTMLElement>("recovery");
  const reviewNote = find<HTMLParagraphElement>("recovery-note");
  const reviewDraft = find<HTMLTextAreaElement>("recovery-draft");
  const reviewUse = find<HTMLButtonElement>("recovery-use");
  const reviewReplace = find<HTMLParagraphElement>("recovery-replace");
  let state: ProjectSessionsState = { projects: [], selectedProjectId: null };
  let loaded = false;
  let connected = false;
  let pending = false;
  let epoch = 0;
  let accountEpoch = 0;
  let drawn = "";
  let plansDrawn = "";
  let reviewed: { projectId: string; sequenceId: string; signature: string } | undefined;
  let announcedProjectId: string | null = null;

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
  const closeReview = () => {
    reviewed = undefined;
    review.hidden = true;
    reviewDraft.value = "";
    reviewNote.textContent = "";
  };
  const updateReview = () => {
    reviewUse.disabled = !reviewed || pending || !reviewDraft.value.trim() || reviewDraft.value.length > 2000;
    reviewUse.textContent = request.value ? "Replace request draft" : "Use in request";
    reviewReplace.textContent = request.value ? "Using this review will replace the text currently in Ask the conductor." : "Using this review fills Ask the conductor. You decide when to send it.";
  };
  const prepareReview = (projectId: string, sequenceId: string, stepIndex?: number) => {
    try {
      const result = projectRecoveryDraft(state, projectId, sequenceId, stepIndex);
      const sequence = state.projects.find(p => p.id === projectId)?.sequences?.find(s => s.id === sequenceId);
      reviewed = { projectId, sequenceId, signature: JSON.stringify(sequence) };
      reviewNote.textContent = result.message;
      reviewDraft.value = result.draft ?? "";
      review.hidden = false;
      updateReview();
      reviewDraft.focus();
    } catch (error) { status.textContent = error instanceof Error ? error.message : "Couldn't prepare these goals. Write a new request."; }
  };
  const render = () => {
    const project = active();
    const options = [{ id: "", name: "No active project" }, ...state.projects];
    if (JSON.stringify(options.map(p => [p.id, p.name])) !== select.dataset.options) {
      select.replaceChildren(...options.map(p => new Option(p.name, p.id)));
      select.dataset.options = JSON.stringify(options.map(p => [p.id, p.name]));
    }
    select.value = state.selectedProjectId ?? "";
    if (announcedProjectId !== state.selectedProjectId) {
      announcedProjectId = state.selectedProjectId;
      window.dispatchEvent(new CustomEvent("ember-project-changed", { detail: { projectId: announcedProjectId } }));
    }
    select.disabled = !loaded || pending;
    add.disabled = !loaded || pending;
    forget.disabled = !project || pending || project.sessions.some(ongoing) || !!project.sequences?.some(plan => plan.status === "active");
    request.disabled = !project || !connected || pending;
    send.disabled = request.disabled;
    save.disabled = !loaded || !connected || pending || !state.projects.length;
    open.disabled = !loaded || !connected || pending || state.projects.some(p => p.sessions.some(ongoing) || p.sequences?.some(plan => plan.status === "active"));
    forgetSaved.disabled = !loaded || !connected || pending;
    goalText.textContent = project?.goal ?? "";
    goalText.hidden = !project?.goal;
    if (reviewed && (reviewed.projectId !== project?.id || reviewed.signature !== JSON.stringify(project.sequences?.find(s => s.id === reviewed!.sequenceId)))) {
      closeReview();
      status.textContent = "The project or plan changed. Review its current goals again before preparing a request.";
    }
    updateReview();
    // Keep focused session controls in place unless their actual state changes.
    const signature = JSON.stringify([project?.id, project?.sessions, project?.sequences, pending]);
    if (signature === drawn) return;
    drawn = signature;
    const focused = list.contains(document.activeElement) && document.activeElement instanceof HTMLElement
      ? document.activeElement.dataset.sessionControl : undefined;
    const planSignature = JSON.stringify([project?.id, project?.sequences, pending]);
    if (planSignature !== plansDrawn) {
      plansDrawn = planSignature;
      const openPlans = new Set([...plans.querySelectorAll<HTMLDetailsElement>("details[open]")].map(detail => detail.dataset.sequence));
      const focusedPlan = plans.contains(document.activeElement) && document.activeElement instanceof HTMLElement
        ? document.activeElement.dataset.planControl : undefined;
      plans.replaceChildren();
      plans.hidden = !project?.sequences?.length;
      for (const sequence of project?.sequences ?? []) {
        const item = document.createElement("details");
        item.className = "disclose";
        item.dataset.sequence = sequence.id;
        item.open = openPlans.has(sequence.id);
        const heading = document.createElement("summary");
        const done = sequence.steps.filter(step => step.status === "done").length;
        heading.textContent = `Desktop plan · ${sequence.status} · ${done} of ${sequence.steps.length} completed`;
        heading.dataset.planControl = `${sequence.id}:summary`;
        item.append(heading);
        const steps = document.createElement("ol");
        const reviewable = sequence.status !== "active" && !sequence.steps.some(step => ["queued", "running", "waiting"].includes(step.status));
        let prefix = 0;
        while (sequence.steps[prefix]?.status === "done") prefix++;
        sequence.steps.forEach((step, index) => {
          const row = document.createElement("li");
          const title = document.createElement("h4");
          title.textContent = step.name;
          const detail = document.createElement("p");
          detail.className = "hint";
          detail.textContent = step.status === "pending" ? "Not started" : step.status === "interrupted" ? "Interrupted" : STATUS_WORDS[step.status];
          const goal = document.createElement("p");
          goal.textContent = step.goal;
          row.append(title, detail, goal);
          if (step.summary) {
            const outcome = document.createElement("p");
            outcome.textContent = `Recorded outcome: ${step.summary}`;
            row.append(outcome);
          }
          if (index >= prefix && reviewable) {
            const one = button(`Review step ${index + 1}`, () => prepareReview(project!.id, sequence.id, index));
            one.dataset.planControl = `${sequence.id}:${index}`;
            one.disabled = pending;
            row.append(one);
          }
          steps.append(row);
        });
        item.append(steps);
        if (reviewable && prefix < sequence.steps.length) {
          const remaining = button("Review remaining steps", () => prepareReview(project!.id, sequence.id));
          remaining.dataset.planControl = `${sequence.id}:remaining`;
          remaining.disabled = pending;
          item.append(remaining);
        }
        plans.append(item);
      }
      if (focusedPlan) [...plans.querySelectorAll<HTMLElement>("[data-plan-control]")]
        .find(control => control.dataset.planControl === focusedPlan)?.focus({ preventScroll: true });
    }
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
  request.addEventListener("input", updateReview);
  reviewDraft.addEventListener("input", updateReview);
  find<HTMLButtonElement>("recovery-cancel").addEventListener("click", closeReview);
  reviewUse.addEventListener("click", () => {
    if (reviewUse.disabled || !reviewed) return;
    const sequence = active()?.sequences?.find(s => s.id === reviewed!.sequenceId);
    if (active()?.id !== reviewed.projectId || JSON.stringify(sequence) !== reviewed.signature) { closeReview(); return; }
    request.value = reviewDraft.value;
    closeReview();
    status.textContent = connected ? "Review your new request, then send it to the conductor." : "Request prepared. Connect a model, review it, then send it to the conductor.";
    if (!request.disabled) request.focus();
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
    closeReview();
    name.value = ""; goal.value = ""; request.value = "";
    status.textContent = "";
    render();
    void refresh();
  });
  render();
  void refresh();
}
