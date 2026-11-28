/**
 * Customise › Session settings (docs/CODING-APP.md §8): a session's options the SDK changes while it runs
 * (`options.update`, through main's own `configure`, which keeps them in Ember's index and gives them again each time
 * the session opens): reasoning summaries, the long context tier, Copilot as co-author of commits, and the built-in
 * tools it leaves out (listed from the session's `tools.getCurrentMetadata`). Leaving a tool out only narrows what the
 * session may do: the window can't widen it (no allow-list, no sandbox, no mode: main takes only these keys).
 */
import type { CodeSessionOptions } from "../../shared/code";
import {
  COAUTHOR, LONG_CONTEXT, LONG_CONTEXT_LEAD, SAVE_SESSION_SETTINGS, SESSION_SETTINGS_SAVED, SESSION_SETTINGS_SECTION, SUMMARY, SUMMARY_LEAD, TOOLS, TOOLS_EMPTY,
  TOOLS_LEAD, summaryName, toolLabel,
} from "./copy-settings";
import { action, defineSection, field, part, problem } from "./customise-kit";
import { el, idPart } from "./dom";
import { arr, str } from "./sdk";

/** The tools a session lists (`tools.getCurrentMetadata`): name and title, MCP servers' tools left out (MCP servers has them). */
export function builtinTools(v: unknown): { name: string; title?: string }[] {
  return arr(v, "tools").filter(t => !str(t, "mcpServerName") && str(t, "name")).map(t => ({ name: str(t, "name")!, ...(str(t, "title") ? { title: str(t, "title") } : {}) }));
}

/** The options a form holds, as main takes them. */
export function sessionOptionsFrom(f: { summary: string; long: boolean; coauthor: boolean; off: readonly string[] }): CodeSessionOptions {
  return {
    ...(f.summary ? { reasoningSummary: f.summary as CodeSessionOptions["reasoningSummary"] } : {}),
    contextTier: f.long ? "long_context" : "default",
    coauthor: f.coauthor,
    excludedTools: [...new Set(f.off)].sort(),
  };
}

defineSection(SESSION_SETTINGS_SECTION, "session", ctx => ({
  draw(body) {
    const r = ctx.session();
    const api = ctx.app.api;
    if (!r) { body.replaceChildren(); return; }
    if (!api.sessionOptions || !api.configure) { body.replaceChildren(problem({ reason: "", unavailable: true })); return; }
    const id = idPart(r.id);
    const summary = el("select", {}, ...["", "none", "concise", "detailed"].map(v => el("option", { value: v, textContent: summaryName(v) })));
    const long = el("input", { type: "checkbox", attrs: { role: "switch" } });
    const coauthor = el("input", { type: "checkbox", attrs: { role: "switch" } });
    const tools = part(TOOLS, { lead: TOOLS_LEAD });
    const boxes = new Map<string, HTMLInputElement>();
    const general = part(SESSION_SETTINGS_SECTION);
    const longId = `cz-long-${id}`, coId = `cz-coauthor-${id}`;
    long.id = longId;
    coauthor.id = coId;
    general.body.append(
      field(`cz-summary-${id}`, SUMMARY, summary, SUMMARY_LEAD).root,
      el("div", { className: "cz-switch-row" }, el("label", { htmlFor: longId, textContent: LONG_CONTEXT }), long),
      el("p", { className: "hint", textContent: LONG_CONTEXT_LEAD }),
      el("div", { className: "cz-switch-row" }, el("label", { htmlFor: coId, textContent: COAUTHOR }), coauthor),
    );
    const save = action(SAVE_SESSION_SETTINGS, async () => {
      const off = [...boxes].filter(([, b]) => !b.checked).map(([n]) => n);
      const res = await api.configure!(r.id, sessionOptionsFrom({ summary: summary.value, long: long.checked, coauthor: coauthor.checked, off }));
      ctx.say(res.ok ? SESSION_SETTINGS_SAVED : res.reason);
    });
    body.replaceChildren(general.root, tools.root, el("div", { className: "cz-form-actions" }, save));
    void Promise.all([api.sessionOptions(r.id), ctx.call("session", "tools.getCurrentMetadata", {})]).then(([o, t]) => {
      const kept = o.ok ? o.value : {};
      summary.value = kept.reasoningSummary ?? "";
      long.checked = kept.contextTier === "long_context";
      coauthor.checked = kept.coauthor ?? true;
      const off = new Set(kept.excludedTools ?? []);
      // A tool left out isn't in the session's list any more: it is still shown, off, so it can be turned on again.
      const listed = t.ok ? builtinTools(t.value) : [];
      const all: { name: string; title?: string }[] = [...listed, ...[...off].filter(n => !listed.some(l => l.name === n)).map(name => ({ name }))];
      if (!all.length) { tools.body.replaceChildren(t.ok ? el("p", { className: "cz-empty", textContent: TOOLS_EMPTY }) : problem(t)); return; }
      tools.body.replaceChildren(el("ul", { className: "cz-list cz-checks", attrs: { "aria-label": TOOLS } }, ...all.map(tool => {
        const box = el("input", { type: "checkbox", checked: !off.has(tool.name), id: `cz-tool-${id}-${idPart(tool.name)}` });
        boxes.set(tool.name, box);
        return el("li", { className: "cz-check" }, box, el("label", { htmlFor: box.id, textContent: toolLabel(tool.name, tool.title) }));
      })));
    });
  },
}));
