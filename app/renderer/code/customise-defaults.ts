/**
 * Customise › Defaults (docs/CODING-APP.md §8): what a new session starts with when the start flow names nothing
 * (permissions, agent mode, model, reasoning effort, where it works), for every project and per project; a project's
 * instructions for Copilot (appended to each session's system message: the person's own words, never a model's); and
 * a project's extra folders (added only through main's folder picker). Everything goes through main's own commands
 * (`settings`, `setSettings`, `projectFolders`), which keep them in Ember's index and apply the organisation's policy
 * on top: a mode it forbids shows as not allowed and is never saved.
 */
import { CODE_EFFORTS, CODE_LIMITS, type CodeDefaults, type CodeSettings } from "../../shared/code";
import { agentModeName, effortName, permissionModeName } from "./copy";
import {
  DEFAULTS_EVERYONE, DEFAULTS_EVERYONE_LEAD, DEFAULTS_NO_PROJECT, DEFAULTS_PROJECT, DEFAULTS_PROJECT_CHOOSE, DEFAULTS_SAVED, DEFAULTS_SECTION, DEFAULT_AGENT_MODE,
  DEFAULT_EFFORT_LABEL, DEFAULT_IN_FOLDER, DEFAULT_IN_WORKTREE, DEFAULT_MODEL_LABEL, DEFAULT_PERMISSIONS, DEFAULT_WHERE, FOLDERS, FOLDERS_EMPTY, FOLDERS_LEAD,
  FOLDERS_NEXT, FOLDER_ADD, FOLDER_REMOVE, INSTRUCTIONS, INSTRUCTIONS_LEAD, INSTRUCTIONS_SAVE, INSTRUCTIONS_SAVED, NOT_SET, SAME_AS_EVERYONE, SAVE_DEFAULTS,
  folderRemoveLabel, instructionsCount, modeNotAllowed,
} from "./copy-settings";
import { action, defineSection, field, list, part, problem, row, type SectionCtx } from "./customise-kit";
import { el, idPart, setText } from "./dom";

const PERMISSIONS = ["manual", "assisted", "allow-all"] as const;
const AGENT_MODES = ["interactive", "plan", "autopilot"] as const;

/** The defaults a form's selects hold ("" is unset: the scope above, or Copilot's own). */
export function defaultsFrom(values: Readonly<Record<keyof CodeDefaults, string>>): CodeDefaults {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) if (v) out[k] = v;
  return out as CodeDefaults;
}

defineSection(DEFAULTS_SECTION, "client", ctx => {
  const api = ctx.app.api;
  let projectId: string | null = null;
  const view = {
    draw(body: HTMLElement): void {
      if (!api.settings || !api.setSettings) { body.replaceChildren(problem({ reason: "", unavailable: true })); return; }
      const everyone = part(DEFAULTS_EVERYONE, { lead: DEFAULTS_EVERYONE_LEAD });
      const project = part(DEFAULTS_PROJECT);
      body.replaceChildren(everyone.root, project.root);
      // The models first (a model the list doesn't have yet is still shown by its id).
      void ctx.app.loadCatalog().catch(() => undefined).then(async () => {
        const r = await api.settings!();
        if (!r.ok) { everyone.body.replaceChildren(problem(r, () => view.draw(body))); return; }
        everyone.body.replaceChildren(defaultsForm(ctx, "all", r.value.defaults, r.value, NOT_SET, d => api.setSettings!({ defaults: d })));
        drawProject(project.body);
      });
    },
  };
  return view;

  function drawProject(host: HTMLElement): void {
    const s = ctx.app.state;
    const ids = s.projects.order.filter(id => s.projects.byId[id]);
    if (!ids.length) { host.replaceChildren(el("p", { className: "cz-empty", textContent: DEFAULTS_NO_PROJECT })); return; }
    if (!projectId || !ids.includes(projectId)) projectId = (ctx.session() ? ctx.session()!.projectId : null) ?? ids[0];
    if (!ids.includes(projectId)) projectId = ids[0];
    const chooser = el("select", {}, ...ids.map(id => el("option", { value: id, textContent: s.projects.byId[id].name, selected: id === projectId })));
    const inner = el("div");
    chooser.addEventListener("change", () => { projectId = chooser.value; fill(); });
    host.replaceChildren(field("cz-defaults-project", DEFAULTS_PROJECT_CHOOSE, chooser).root, inner);
    const fill = () => {
      const id = projectId!;
      void api.settings!(id).then(r => {
        if (id !== projectId) return;
        if (!r.ok) { inner.replaceChildren(problem(r, fill)); return; }
        const p = r.value.project ?? {};
        inner.replaceChildren(
          defaultsForm(ctx, `p-${idPart(id)}`, p.defaults ?? {}, r.value, SAME_AS_EVERYONE, d => api.setSettings!({ projectId: id, defaults: d })),
          instructionsPart(ctx, id, p.instructions ?? ""),
          foldersPart(ctx, id, p.folders ?? []),
        );
      });
    };
    fill();
  }
});

/** A form of the five defaults, each a select whose first choice is unset; Save sends them all. */
function defaultsForm(ctx: SectionCtx, key: string, d: CodeDefaults, all: CodeSettings, unset: string, save: (d: CodeDefaults) => Promise<{ ok: boolean; reason?: string }>): HTMLElement {
  const allowed = new Set(all.permissionModes);
  const select = (values: readonly string[], name: (v: string) => string, value: string | undefined, disabled?: (v: string) => boolean) =>
    el("select", {}, el("option", { value: "", textContent: unset }), ...values.map(v => el("option", { value: v, textContent: disabled?.(v) ? modeNotAllowed(name(v)) : name(v), disabled: !!disabled?.(v), selected: v === value })));
  const models = ctx.app.state.catalog.models ?? [];
  const modelIds = [...new Set([...models.filter(m => m.enabled).map(m => m.id), ...(d.model ? [d.model] : [])])];
  const isolation = select(["folder", "worktree"], v => (v === "worktree" ? DEFAULT_IN_WORKTREE : DEFAULT_IN_FOLDER), d.isolation);
  const permission = select(PERMISSIONS, permissionModeName, d.permissionMode, v => !allowed.has(v as never));
  const agent = select(AGENT_MODES, agentModeName, d.agentMode);
  const model = select(modelIds, id => models.find(m => m.id === id)?.name ?? id, d.model);
  const effort = select(CODE_EFFORTS, effortName, d.reasoningEffort);
  const form = el("form", { className: "cz-form" },
    field(`cz-def-${key}-where`, DEFAULT_WHERE, isolation).root,
    field(`cz-def-${key}-perm`, DEFAULT_PERMISSIONS, permission).root,
    field(`cz-def-${key}-agent`, DEFAULT_AGENT_MODE, agent).root,
    field(`cz-def-${key}-model`, DEFAULT_MODEL_LABEL, model).root,
    field(`cz-def-${key}-effort`, DEFAULT_EFFORT_LABEL, effort).root);
  const go = action(SAVE_DEFAULTS, async () => {
    const r = await save(defaultsFrom({ isolation: isolation.value, permissionMode: permission.value, agentMode: agent.value, model: model.value, reasoningEffort: effort.value }));
    ctx.say(r.ok ? DEFAULTS_SAVED : r.reason ?? "");
  });
  form.addEventListener("submit", e => { e.preventDefault(); go.click(); });
  form.append(el("div", { className: "cz-form-actions" }, go));
  return form;
}

function instructionsPart(ctx: SectionCtx, projectId: string, text: string): HTMLElement {
  const p = part(INSTRUCTIONS, { lead: INSTRUCTIONS_LEAD });
  const area = el("textarea", { rows: 6, value: text, maxLength: CODE_LIMITS.instructions, spellcheck: false });
  const count = el("p", { className: "hint", attrs: { "aria-live": "off" }, textContent: instructionsCount(text.length, CODE_LIMITS.instructions) });
  area.addEventListener("input", () => setText(count, instructionsCount(area.value.length, CODE_LIMITS.instructions)));
  const f = field(`cz-instr-${idPart(projectId)}`, INSTRUCTIONS, area);
  const save = action(INSTRUCTIONS_SAVE, async () => {
    const r = await ctx.app.api.setSettings!({ projectId, instructions: area.value });
    f.error(r.ok ? "" : r.reason);
    if (r.ok) ctx.say(INSTRUCTIONS_SAVED);
  });
  // The part's heading names it; the field's own label is for the screen reader's form mode.
  p.body.append(f.root, count, el("div", { className: "cz-form-actions" }, save));
  return p.root;
}

function foldersPart(ctx: SectionCtx, projectId: string, folders: readonly string[]): HTMLElement {
  const p = part(FOLDERS, { lead: FOLDERS_LEAD });
  const draw = (now: readonly string[]) => {
    const add = action(FOLDER_ADD, async () => {
      const r = await ctx.app.api.projectFolders!(projectId, { add: true });
      if (!r.ok) { ctx.say(r.reason); return; }
      draw(r.value);
      ctx.say(FOLDERS_NEXT);
    });
    p.body.replaceChildren(
      list(FOLDERS, now.map(f => row({ name: f.split(/[\\/]/).filter(Boolean).pop() ?? f, id: `cz-folder-${idPart(f)}`, mono: f, actions: [action(FOLDER_REMOVE, async () => {
        const r = await ctx.app.api.projectFolders!(projectId, { remove: f });
        if (!r.ok) { ctx.say(r.reason); return; }
        draw(r.value);
        ctx.say(FOLDERS_NEXT);
      }, { aria: folderRemoveLabel(f) })] })), FOLDERS_EMPTY),
      el("div", { className: "cz-form-actions" }, add));
  };
  if (!ctx.app.api.projectFolders) p.body.replaceChildren(problem({ reason: "", unavailable: true }));
  else draw(folders);
  return p.root;
}
