/**
 * Customise › Hooks, read-only: every hook Copilot finds (client `hooks.discover`, with the session's project), its
 * event, where it comes from and whether it is on, and the line on when a repository's own hooks run: only in a
 * sandboxed session in a folder the person trusts (app/main/code/session-runtime.ts `trustChanged`).
 */
import { HOOKS_FOUND, HOOKS_LEAD, HOOKS_NONE, HOOKS_REPO, HOOK_OFF, RELOAD, hookEvent, hookProblems, sourceWords } from "./copy-customise";
import { action, defineSection, list, load, part, projectPaths, row } from "./customise-kit";
import { hookRows } from "./customise-read";
import { el } from "./dom";

defineSection("Hooks", "client", ctx => ({
  draw(body) {
    const reload = action(RELOAD, async () => { await fill(); }, { aria: `${RELOAD}: ${HOOKS_FOUND}` });
    const hooks = part(HOOKS_FOUND, { lead: HOOKS_LEAD, actions: [reload] });
    body.replaceChildren(el("p", { className: "cz-callout", textContent: HOOKS_REPO }), hooks.root);
    const fill = () => load(hooks.body, () => ctx.call("client", "hooks.discover", projectPaths(ctx)), v => {
      const h = hookRows(v);
      const problems = hookProblems(h);
      return [
        list(HOOKS_FOUND, h.hooks.map(x => row({ name: hookEvent(x.event), lines: [sourceWords(x.origin)], mono: x.source, tags: [x.enabled ? "" : HOOK_OFF] })), HOOKS_NONE),
        problems ? el("p", { className: "hint", textContent: problems }) : null,
      ];
    });
    void fill();
  },
}));
