/**
 * Customise › Permissions, for the open session: its permission mode and agent mode with what each means, changed only
 * through their own commands (`emberCode.setPermissionMode`/`setAgentMode` by way of CodeApp.setMode, never an RPC
 * call: main refuses one), the organisation's limits (session `managedSettings.get`, client `managedSettings.read`:
 * a mode it turns off is shown off, and said so), rules in the SDK's syntax added and removed for the session or its
 * folder (`permissions.modifyRules`; Copilot has no method that lists them, so the page lists those added here),
 * "Forget this session's approvals" (`permissions.resetSessionApprovals`, confirmed), the folders its tools may reach
 * (`permissions.paths.list`/`add`) and whether its folder is trusted (`permissions.folderTrust.isTrusted`/`addTrusted`,
 * confirmed, with what trust turns on).
 */
import type { CodeAgentMode, CodePermissionMode } from "../../shared/code";
import { agentModeHint, agentModeName, permissionModeHint, permissionModeName } from "./copy";
import {
  AGENT_MODE_LABEL, APPROVED_PATHS, FOLDER_ADD, FOLDER_ADDED, FOLDER_LABEL, FORGET, FORGET_APPROVALS, FORGET_QUESTION, FORGOTTEN, NOT_TRUSTED,
  ORG_APPROVE_ALL_OFF, ORG_DEVICE, ORG_DEVICE_UNREADABLE, ORG_FAIL_CLOSED, ORG_NONE, PERM_FOLDERS, PERM_FOLDERS_LEAD, PERM_MODES, PERM_MODE_LABEL, PERM_ORG,
  PERM_RULES, PERM_RULES_LEAD, PERM_TRUST, PRIMARY_FOLDER, REMOVE, RULES_NONE, RULES_UNLISTED, RULE_ADD, RULE_ADDED, RULE_EXAMPLES, RULE_LABEL,
  RULE_REMOVED, RULE_SCOPE, RULE_SCOPE_LOCATION, RULE_SCOPE_SESSION, TRUST, TRUSTED, TRUST_DONE, TRUST_LEAD, modeOffByOrg, orgManages, removeQuestion, trustLabel,
  trustQuestion,
} from "./copy-customise";
import { folderError, parseRule, ruleText, withRule, withoutRule, type Rule } from "./customise-forms";
import { confirmed, defineSection, field, input, list, load, part, row } from "./customise-kit";
import { allowedPaths, managedDevice, managedSession } from "./customise-read";
import { el, setText } from "./dom";

const PERMISSION_MODES: CodePermissionMode[] = ["manual", "assisted", "allow-all"];
const AGENT_MODES: CodeAgentMode[] = ["interactive", "plan", "autopilot"];

/** Rules added from this window, per session and scope (Copilot has no method that lists the rules in force). */
const added = new Map<string, Rule[]>();

defineSection("Permissions", "session", ctx => {
  let pickers: { permission: HTMLSelectElement; agent: HTMLSelectElement; permNote: (t: string) => void; agentNote: (t: string) => void } | null = null;
  let approveAllOff = false;

  function syncModes(): void {
    const r = ctx.session();
    if (!r || !pickers) return;
    pickers.permission.value = r.permissionMode;
    pickers.agent.value = r.agentMode;
    for (const o of pickers.permission.options) {
      o.disabled = o.value === "allow-all" && approveAllOff && r.permissionMode !== "allow-all";
      o.textContent = o.disabled ? modeOffByOrg(permissionModeName(o.value)) : permissionModeName(o.value);
    }
    const notes = ctx.app.state.notes[r.id] ?? {};
    pickers.permNote(notes.permission ?? "");
    pickers.agentNote(notes.agent ?? "");
  }

  function modes(): HTMLElement {
    const r = ctx.session()!;
    const perm = el("select", {}, ...PERMISSION_MODES.map(m => el("option", { value: m, textContent: permissionModeName(m) })));
    const agent = el("select", {}, ...AGENT_MODES.map(m => el("option", { value: m, textContent: agentModeName(m) })));
    const permF = field("cz-perm-mode", PERM_MODE_LABEL, perm, permissionModeHint(r.permissionMode));
    const agentF = field("cz-agent-mode", AGENT_MODE_LABEL, agent, agentModeHint(r.agentMode));
    const hintOf = (f: HTMLElement) => f.querySelector<HTMLElement>(".hint");
    perm.addEventListener("change", () => { setText(hintOf(permF.root)!, permissionModeHint(perm.value)); void ctx.app.setMode(r.id, "permission", perm.value); });
    agent.addEventListener("change", () => { setText(hintOf(agentF.root)!, agentModeHint(agent.value)); void ctx.app.setMode(r.id, "agent", agent.value); });
    pickers = { permission: perm, agent, permNote: permF.error, agentNote: agentF.error };
    syncModes();
    return el("div", { className: "cz-form cz-two" }, permF.root, agentF.root);
  }

  function rules(sid: string): HTMLElement {
    const box = input({ spell: false });
    const f = field("cz-rule", RULE_LABEL, box, RULE_EXAMPLES);
    const scope = el("select", {}, el("option", { value: "session", textContent: RULE_SCOPE_SESSION }), el("option", { value: "location", textContent: RULE_SCOPE_LOCATION }));
    const scopeF = field("cz-rule-scope", RULE_SCOPE, scope);
    const go = el("button", { type: "submit", className: "btn quiet small", textContent: RULE_ADD });
    const listHost = el("div");
    const key = (s: string) => `${sid}:${s}`;
    const draw = () => {
      const rowsOf = (s: "session" | "location") => (added.get(key(s)) ?? []).map(rule => row({
        name: ruleText(rule), lines: [s === "session" ? RULE_SCOPE_SESSION : RULE_SCOPE_LOCATION],
        actions: [confirmed(REMOVE, removeQuestion(ruleText(rule)), REMOVE, async () => {
          const res = await ctx.call("session", "permissions.modifyRules", { scope: s, remove: [rule] });
          if (!res.ok) { ctx.say(res.reason); return; }
          added.set(key(s), withoutRule(added.get(key(s)) ?? [], rule));
          ctx.say(RULE_REMOVED(ruleText(rule)));
          draw();
        }, { aria: `${REMOVE} “${ruleText(rule)}”` })],
      }));
      listHost.replaceChildren(list(PERM_RULES, [...rowsOf("session"), ...rowsOf("location")], RULES_NONE));
    };
    const form = el("form", { className: "cz-form cz-rule-form", noValidate: true }, f.root, scopeF.root, el("div", { className: "cz-form-actions" }, go));
    form.addEventListener("submit", async e => {
      e.preventDefault();
      if (go.disabled) return;
      const parsed = parseRule(box.value);
      if ("error" in parsed) { f.error(parsed.error); box.focus(); return; }
      f.error("");
      const s = scope.value as "session" | "location";
      go.disabled = true;
      const res = await ctx.call("session", "permissions.modifyRules", { scope: s, add: [parsed.rule] });
      go.disabled = false;
      if (!res.ok) { f.error(res.reason); box.focus(); return; }
      added.set(key(s), withRule(added.get(key(s)) ?? [], parsed.rule));
      box.value = "";
      ctx.say(RULE_ADDED(ruleText(parsed.rule)));
      draw();
    });
    draw();
    return el("div", { className: "cz-stack" }, form, el("p", { className: "hint", textContent: RULES_UNLISTED }), listHost);
  }

  function folders(host: HTMLElement): void {
    void load(host, () => ctx.call("session", "permissions.paths.list"), v => {
      const p = allowedPaths(v);
      const box = input();
      const f = field("cz-folder", FOLDER_LABEL, box);
      const go = el("button", { type: "submit", className: "btn quiet small", textContent: FOLDER_ADD });
      const form = el("form", { className: "cz-form cz-one-line", noValidate: true }, f.root, go);
      form.addEventListener("submit", async e => {
        e.preventDefault();
        if (go.disabled) return;
        const why = folderError(box.value);
        f.error(why ?? "");
        if (why) { box.focus(); return; }
        go.disabled = true;
        const path = box.value.trim();
        const res = await ctx.call("session", "permissions.paths.add", { path });
        go.disabled = false;
        if (!res.ok) { f.error(res.reason); box.focus(); return; }
        ctx.say(FOLDER_ADDED(path));
        folders(host);
      });
      return [
        list(PERM_FOLDERS, [
          ...(p.primary ? [row({ name: PRIMARY_FOLDER, mono: p.primary })] : []),
          ...p.directories.map(d => row({ name: d })),
        ], ""),
        p.approved.length ? el("div", {}, el("h4", { textContent: APPROVED_PATHS }), el("ul", { className: "cz-plain" }, ...p.approved.map(a => el("li", { className: "cz-mono", textContent: a })))) : null,
        form,
      ];
    });
  }

  function trust(host: HTMLElement): void {
    const r = ctx.session()!;
    const project = ctx.app.state.projects.byId[r.projectId];
    const folder = project?.gitRoot ?? project?.folder ?? r.folder;
    void load(host, () => ctx.call("session", "permissions.folderTrust.isTrusted", { path: folder }), v => {
      const trusted = (v as { trusted?: unknown })?.trusted === true;
      return list(PERM_TRUST, [row({
        name: folder, tags: [trusted ? TRUSTED : NOT_TRUSTED],
        actions: [trusted ? null : confirmed(TRUST, trustQuestion(folder), TRUST, async () => {
          const res = await ctx.call("session", "permissions.folderTrust.addTrusted", { path: folder });
          ctx.say(res.ok ? TRUST_DONE(folder) : res.reason);
          if (res.ok) trust(host);
        }, { aria: trustLabel(folder) })],
      })], "");
    });
  }

  return {
    draw(body) {
      pickers = null;
      approveAllOff = false;
      const r = ctx.session();
      if (!r) { body.replaceChildren(); return; }
      const modesPart = part(PERM_MODES);
      modesPart.body.replaceChildren(modes());
      const org = part(PERM_ORG);
      const rulesPart = part(PERM_RULES, { lead: PERM_RULES_LEAD });
      rulesPart.body.replaceChildren(rules(r.id));
      const forget = el("div", { className: "cz-form-actions" }, confirmed(FORGET_APPROVALS, FORGET_QUESTION, FORGET, async () => {
        const res = await ctx.call("session", "permissions.resetSessionApprovals", { includeLocation: true });
        ctx.say(res.ok ? FORGOTTEN : res.reason);
      }));
      rulesPart.root.append(forget);
      const foldersPart = part(PERM_FOLDERS, { lead: PERM_FOLDERS_LEAD });
      const trustPart = part(PERM_TRUST, { lead: TRUST_LEAD });
      body.replaceChildren(modesPart.root, org.root, rulesPart.root, foldersPart.root, trustPart.root);
      void load(org.body, async () => {
        const [s, d] = await Promise.all([ctx.call("session", "managedSettings.get"), ctx.call("client", "managedSettings.read")]);
        return s.ok ? { ok: true, value: { s: s.value, d: d.ok ? d.value : null } } : s;
      }, v => {
        const { s, d } = v as { s: unknown; d: unknown };
        const m = managedSession(s);
        const dev = d === null ? null : managedDevice(d);
        approveAllOff = m.approveAllOff;
        syncModes();
        const lines = [
          m.approveAllOff ? ORG_APPROVE_ALL_OFF : "",
          m.keys.length ? orgManages(m.keys) : "",
          m.failClosed ? ORG_FAIL_CLOSED : "",
          dev?.unreadable ? ORG_DEVICE_UNREADABLE : dev?.present ? ORG_DEVICE : "",
        ].filter(Boolean);
        return (lines.length ? lines : [ORG_NONE]).map(t => el("p", { className: "cz-line", textContent: t }));
      });
      folders(foldersPart.body);
      trust(trustPart.body);
    },
    render() { syncModes(); },
  };
});
