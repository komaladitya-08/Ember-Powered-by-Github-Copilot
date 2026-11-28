/**
 * Customise › Skills: the open session's skills (session `skills.list`, turned on and off for that session with
 * `skills.enable`/`disable`, read again with `skills.reload`), the skills new sessions find (client `skills.discover`,
 * kept off in every new session with `skills.config.setSkillDisabled`), and where a skill's folder goes
 * (`skills.getDiscoveryPaths`). Installing from a catalogue takes the SDK's catalogue contract (`skills.planInstall`
 * with a negotiated handle), which the window has no way to make yet: it says so and where to put a skill instead.
 */
import {
  PREFERRED, RELOAD, SESSION_PART_NONE, SKILLS_COMPUTER, SKILLS_COMPUTER_HINT, SKILLS_INSTALL, SKILLS_NONE, SKILLS_SESSION, SKILLS_SESSION_HINT,
  WHERE_FILES_GO, fromPlugin, loadedWith, skillCommand, sourceWords, turnedOn,
} from "./copy-customise";
import { action, defineSection, list, load, part, pathList, problem, projectPaths, row, toggle, type Scope } from "./customise-kit";
import { discoveryPaths, loadDiagnostics, skillRows, type SkillRow } from "./customise-read";
import { idPart } from "./dom";

defineSection("Skills", "both", ctx => {
  const skillRow = (s: SkillRow, scope: Scope): HTMLLIElement => {
    const id = `cz-skill-${scope}-${idPart(s.name)}`;
    const sw = toggle({
      labelledBy: id, on: s.enabled, ctx,
      change: on => scope === "session" ? ctx.call("session", on ? "skills.enable" : "skills.disable", { name: s.name }) : ctx.call("client", "skills.config.setSkillDisabled", { name: s.name, disabled: !on }),
      done: on => ctx.say(turnedOn(s.name, on)),
    });
    return row({ name: s.name, id, lines: [s.description, s.userInvocable ? skillCommand(s.command ?? s.name, s.hint) : undefined], tags: [s.plugin ? fromPlugin(s.plugin) : sourceWords(s.source)], mono: s.path, actions: [sw] });
  };
  const loadSession = (host: HTMLElement) => void load(host, () => ctx.call("session", "skills.list"), v => list(SKILLS_SESSION, skillRows(v).map(s => skillRow(s, "session")), SKILLS_NONE));
  return {
    draw(body) {
      const reload = action(RELOAD, async () => {
        const r = await ctx.call("session", "skills.reload");
        ctx.say(r.ok ? loadedWith(loadDiagnostics(r.value)) : r.reason);
        if (r.ok) loadSession(sessionPart.body);
      }, { aria: `${RELOAD}: ${SKILLS_SESSION}` });
      const sessionPart = part(SKILLS_SESSION, { scope: "session", session: ctx.session(), lead: SKILLS_SESSION_HINT, actions: ctx.session() ? [reload] : [] });
      const computer = part(SKILLS_COMPUTER, { scope: "client", lead: SKILLS_COMPUTER_HINT });
      const where = part(WHERE_FILES_GO, { scope: "client", lead: SKILLS_INSTALL });
      body.replaceChildren(sessionPart.root, computer.root, where.root);
      if (ctx.session()) loadSession(sessionPart.body); else sessionPart.body.replaceChildren(problem({ reason: SESSION_PART_NONE }));
      void load(computer.body, () => ctx.call("client", "skills.discover", projectPaths(ctx)), v => list(SKILLS_COMPUTER, skillRows(v).map(s => skillRow(s, "client")), SKILLS_NONE));
      void load(where.body, () => ctx.call("client", "skills.getDiscoveryPaths", projectPaths(ctx)), v => pathList(WHERE_FILES_GO, discoveryPaths(v), PREFERRED, sourceWords));
    },
  };
});
