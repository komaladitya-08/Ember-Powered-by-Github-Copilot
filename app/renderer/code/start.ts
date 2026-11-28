/**
 * The start flow: which project (or a folder from main's picker), whether Copilot works in the folder or in a new git
 * worktree (and from which branch), the model and its reasoning effort (client `models.list`), the agent mode, the
 * permission mode, an optional agent and name, then `create`. Paths never come from the window: a folder is chosen
 * only in main's picker (`addProject`).
 */
import { CODE_LIMITS, type CodeAgentMode, type CodeCreate, type CodePermissionMode } from "../../shared/code";
import type { CodeApp, View } from "./app";
import {
  DEFAULT_EFFORT, DEFAULT_MODEL, MODELS_UNAVAILABLE, START_AGENT, START_AGENT_MODE, START_BASE, START_CANCEL, START_CHOOSE_FOLDER, START_EFFORT,
  START_GO, START_IN_FOLDER, START_IN_WORKTREE, START_LEAD, START_MODEL, START_NAME, START_NO_AGENT, START_NO_GIT, START_NO_PROJECT, START_PERMISSIONS,
  START_PROJECT, START_TITLE, START_WHERE, START_WORKTREE_HINT, STARTING, agentModeHint, agentModeName, effortName, permissionModeHint, permissionModeName,
  startBaseHint,
} from "./copy";
import { byId, el, setText } from "./dom";
import { setNote, type CodeState } from "./store";

const AGENT_MODES: CodeAgentMode[] = ["interactive", "plan", "autopilot"];
const PERMISSION_MODES: CodePermissionMode[] = ["manual", "assisted", "allow-all"];
const CHOOSE = "__choose__";

export interface StartView extends View { focus(): void }

export function mountStart(app: CodeApp): StartView {
  const root = byId("start-view");
  // A pop-up button sits in a wrapper that draws its up-down mark (a select can't draw one itself).
  const field = (id: string, label: string, control: HTMLElement, hint?: HTMLElement) =>
    el("div", { className: "field" }, el("label", { htmlFor: id, textContent: label }),
      control.tagName === "SELECT" ? el("span", { className: "select-wrap" }, control) : control, hint ?? null);
  const project = el("select", { id: "start-project" });
  const isolationFolder = el("input", { type: "radio", name: "start-where", id: "start-folder", value: "folder", checked: true });
  const isolationTree = el("input", { type: "radio", name: "start-where", id: "start-worktree", value: "worktree" });
  const treeHint = el("p", { className: "hint", id: "start-tree-hint" });
  const base = el("input", { type: "text", id: "start-base", maxLength: 255, autocomplete: "off", spellcheck: false });
  const baseHint = el("p", { className: "hint", id: "start-base-hint" });
  base.setAttribute("aria-describedby", "start-base-hint");
  const model = el("select", { id: "start-model" });
  const effort = el("select", { id: "start-effort" });
  const modelsNote = el("p", { className: "hint", id: "start-models-note" });
  const agentMode = el("select", { id: "start-agent-mode" }, ...AGENT_MODES.map(m => el("option", { value: m, textContent: agentModeName(m) })));
  const agentHint = el("p", { className: "hint", id: "start-agent-mode-hint" });
  const permission = el("select", { id: "start-permissions" }, ...PERMISSION_MODES.map(m => el("option", { value: m, textContent: permissionModeName(m) })));
  const permissionHint = el("p", { className: "hint", id: "start-permissions-hint" });
  const agent = el("select", { id: "start-agent" });
  const name = el("input", { type: "text", id: "start-name", maxLength: CODE_LIMITS.name, autocomplete: "off" });
  const go = el("button", { type: "submit", className: "btn", textContent: START_GO });
  const cancel = el("button", { type: "button", className: "btn quiet", textContent: START_CANCEL });
  const status = el("p", { className: "start-status", attrs: { role: "status" } });
  const problem = el("p", { className: "start-problem", attrs: { role: "alert" } });
  agentMode.setAttribute("aria-describedby", agentHint.id);
  permission.setAttribute("aria-describedby", permissionHint.id);
  const title = el("h1", { id: "start-title", textContent: START_TITLE, tabIndex: -1 });
  const form = el("form", { className: "start-form", attrs: { "aria-labelledby": "start-title" } },
    el("p", { className: "lead", textContent: START_LEAD }),
    el("div", { className: "group" },
      field("start-project", START_PROJECT, project),
      el("fieldset", { className: "field where" },
        el("legend", { textContent: START_WHERE }),
        el("label", { className: "radio" }, isolationFolder, START_IN_FOLDER),
        el("label", { className: "radio" }, isolationTree, START_IN_WORKTREE),
        treeHint),
      field("start-base", START_BASE, base, baseHint)),
    el("div", { className: "group" },
      field("start-model", START_MODEL, model, modelsNote),
      field("start-effort", START_EFFORT, effort),
      field("start-agent-mode", START_AGENT_MODE, agentMode, agentHint),
      field("start-permissions", START_PERMISSIONS, permission, permissionHint),
      field("start-agent", START_AGENT, agent),
      field("start-name", START_NAME, name)),
    problem,
    el("div", { className: "actions" }, cancel, go),
    status);
  root.replaceChildren(el("div", { className: "start-inner" }, title, form));

  let starting = false;
  let lastProjects = "";
  let lastModels: unknown = null;
  let lastAgents: unknown = null;

  const current = (s: CodeState) => s.projects.byId[project.value];
  const drawWhere = (s: CodeState) => {
    const p = current(s);
    const git = !!p?.gitRoot;
    isolationTree.disabled = !git;
    if (!git) isolationFolder.checked = true;
    setText(treeHint, !p ? "" : git ? START_WORKTREE_HINT : START_NO_GIT);
    const tree = isolationTree.checked && git;
    base.disabled = !tree;
    base.placeholder = p?.branch ?? "";
    setText(baseHint, startBaseHint(p?.branch));
    (base.closest(".field") as HTMLElement).hidden = !tree;
  };
  const drawEfforts = (s: CodeState) => {
    const m = s.catalog.models?.find(x => x.id === model.value);
    const want = effort.value;
    effort.replaceChildren(el("option", { value: "", textContent: m?.defaultEffort ? `${DEFAULT_EFFORT} (${effortName(m.defaultEffort)})` : DEFAULT_EFFORT }), ...(m?.efforts ?? []).map(e => el("option", { value: e, textContent: effortName(e) })));
    effort.value = m?.efforts.includes(want) ? want : "";
    effort.disabled = !m?.efforts.length;
  };
  const drawHints = () => {
    setText(agentHint, agentModeHint(agentMode.value));
    setText(permissionHint, permissionModeHint(permission.value));
  };
  /** The person's defaults for the project (main's `settings`: the project's over everyone's, within the organisation's modes). */
  let wantedModel = "";
  const has = (s: HTMLSelectElement, v: string) => [...s.options].some(o => o.value === v && !o.disabled);
  const applyDefaults = (id: string) => {
    if (!app.api.settings || !id || id === CHOOSE) return;
    void app.api.settings(id).then(r => {
      if (!r.ok || project.value !== id) return;
      const d = r.value.effective;
      if (d.isolation === "worktree" && !isolationTree.disabled) isolationTree.checked = true;
      else isolationFolder.checked = true;
      if (d.permissionMode && has(permission, d.permissionMode)) permission.value = d.permissionMode;
      if (d.agentMode) agentMode.value = d.agentMode;
      wantedModel = d.model ?? "";
      if (has(model, wantedModel)) model.value = wantedModel;
      drawEfforts(app.state);
      if (d.reasoningEffort && has(effort, d.reasoningEffort)) effort.value = d.reasoningEffort;
      drawWhere(app.state);
      drawHints();
    }, () => undefined);
  };

  project.addEventListener("change", () => {
    if (project.value !== CHOOSE) { drawWhere(app.state); applyDefaults(project.value); return; }
    void app.addProject().then(id => { project.value = id ?? project.options[0]?.value ?? ""; if (id) render(app.state, null); drawWhere(app.state); applyDefaults(project.value); });
  });
  isolationFolder.addEventListener("change", () => drawWhere(app.state));
  isolationTree.addEventListener("change", () => drawWhere(app.state));
  model.addEventListener("change", () => drawEfforts(app.state));
  agentMode.addEventListener("change", drawHints);
  permission.addEventListener("change", drawHints);
  cancel.addEventListener("click", () => app.showView({ kind: "none" }));
  form.addEventListener("submit", e => {
    e.preventDefault();
    if (starting) return;
    const p = current(app.state);
    if (!p) { setText(problem, START_NO_PROJECT); project.focus(); return; }
    const tree = isolationTree.checked && !!p.gitRoot;
    const options: CodeCreate = {
      projectId: p.id, isolation: tree ? "worktree" : "folder",
      ...(tree && base.value.trim() ? { baseBranch: base.value.trim() } : {}),
      ...(model.value ? { model: model.value } : {}), ...(effort.value ? { reasoningEffort: effort.value } : {}),
      agentMode: agentMode.value as CodeAgentMode, permissionMode: permission.value as CodePermissionMode,
      ...(agent.value ? { agent: agent.value } : {}), ...(name.value.trim() ? { name: name.value.trim().slice(0, CODE_LIMITS.name) } : {}),
    };
    starting = true;
    go.disabled = true;
    setText(problem, "");
    setText(status, STARTING);
    void app.create(options).finally(() => { starting = false; go.disabled = false; setText(status, ""); });
  });

  function render(s: CodeState, prev: CodeState | null): void {
    const sig = JSON.stringify(s.projects.order.map(id => [id, s.projects.byId[id]?.name]));
    if (sig !== lastProjects) {
      lastProjects = sig;
      const want = project.value;
      project.replaceChildren(...s.projects.order.map(id => el("option", { value: id, textContent: s.projects.byId[id]?.name ?? id })), el("option", { value: CHOOSE, textContent: START_CHOOSE_FOLDER }));
      project.value = s.projects.byId[want] ? want : s.projects.order[0] ?? CHOOSE;
      if (project.value === CHOOSE && s.projects.order.length) project.value = s.projects.order[0];
      drawWhere(s);
    }
    if (s.catalog.models !== lastModels) {
      lastModels = s.catalog.models;
      const want = model.value || wantedModel;
      model.replaceChildren(el("option", { value: "", textContent: DEFAULT_MODEL }), ...(s.catalog.models ?? []).filter(m => m.enabled).map(m => el("option", { value: m.id, textContent: m.name })));
      model.value = s.catalog.models?.some(m => m.id === want) ? want : "";
      setText(modelsNote, s.catalog.modelsFailed ? MODELS_UNAVAILABLE : "");
      drawEfforts(s);
    }
    if (s.catalog.agents !== lastAgents) {
      lastAgents = s.catalog.agents;
      agent.replaceChildren(el("option", { value: "", textContent: START_NO_AGENT }), ...(s.catalog.agents ?? []).map(a => el("option", { value: a.id, textContent: a.name })));
      (agent.closest(".field") as HTMLElement).hidden = !s.catalog.agents?.length;
    }
    const note = s.notes[""]?.start ?? "";
    if (note !== (prev?.notes[""]?.start ?? "")) setText(problem, note);
    drawHints();
  }

  return {
    render,
    focus() {
      const v = app.state.view;
      if (v.kind === "start" && v.projectId && app.state.projects.byId[v.projectId]) { project.value = v.projectId; drawWhere(app.state); }
      applyDefaults(project.value);
      app.set(s => setNote(s, "", "start", ""));
      void app.loadCatalog();
      title.focus();
    },
  };
}
