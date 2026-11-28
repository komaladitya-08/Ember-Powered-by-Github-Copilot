/**
 * Customise › Agents: the open session's agents, built-in and custom (session `agent.list` with built-ins), the one
 * in use (`agent.getCurrent`), chosen with `agent.select` or put back to Copilot's own with `agent.deselect`, read again
 * with `agent.reload`; the agents new sessions find (client `agents.discover`), and where a custom agent's file goes
 * (`agents.getDiscoveryPaths`), with how to write one in words.
 */
import {
  AGENTS_FOUND, AGENTS_HOW, AGENTS_NONE, AGENTS_SESSION, AGENT_STOP_USING, AGENT_SUB_ONLY, AGENT_USE, IN_USE, PREFERRED, RELOAD, RELOADED, SESSION_PART_NONE,
  WHERE_FILES_GO, agentInUse, agentMeta, agentUseLabel, sourceWords,
} from "./copy-customise";
import { action, defineSection, list, load, part, pathList, problem, projectPaths, row } from "./customise-kit";
import { agentRows, currentAgent, discoveryPaths, type AgentRow } from "./customise-read";
import { el, setText } from "./dom";

defineSection("Agents", "both", ctx => {
  const loadSession = async (host: HTMLElement, inUse: HTMLElement): Promise<void> => {
    let current: string | null = null;
    await load(host, async () => {
      const [listR, cur] = await Promise.all([ctx.call("session", "agent.list", { includeBuiltInAgents: true }), ctx.call("session", "agent.getCurrent")]);
      current = cur.ok ? currentAgent(cur.value) : null;
      setText(inUse, cur.ok ? agentInUse(current) : "");
      return listR;
    }, v => {
      const back = current ? action(AGENT_STOP_USING, async () => {
        const r = await ctx.call("session", "agent.deselect");
        ctx.say(r.ok ? agentInUse(null) : r.reason);
        if (r.ok) await loadSession(host, inUse);
      }) : null;
      return [list(AGENTS_SESSION, agentRows(v).map(a => agentRow(a, current, host, inUse)), AGENTS_NONE), back ? el("div", { className: "cz-form-actions" }, back) : null];
    });
  };
  const agentRow = (a: AgentRow, current: string | null, host: HTMLElement, inUse: HTMLElement): HTMLLIElement => {
    const using = current === a.name || current === a.id;
    const use = a.selectable && !using ? action(AGENT_USE, async () => {
      const r = await ctx.call("session", "agent.select", { name: a.name });
      ctx.say(r.ok ? agentInUse(a.displayName) : r.reason);
      if (r.ok) await loadSession(host, inUse);
    }, { aria: agentUseLabel(a.displayName) }) : null;
    return row({ name: a.displayName, lines: [a.description, agentMeta(a), a.selectable ? undefined : AGENT_SUB_ONLY], tags: [using ? IN_USE : ""], mono: a.path, actions: [use] });
  };
  return {
    draw(body) {
      const inUse = el("p", { className: "cz-line cz-current" });
      const reload = action(RELOAD, async () => {
        const r = await ctx.call("session", "agent.reload");
        ctx.say(r.ok ? RELOADED : r.reason);
        if (r.ok) await loadSession(sessionPart.body, inUse);
      }, { aria: `${RELOAD}: ${AGENTS_SESSION}` });
      const sessionPart = part(AGENTS_SESSION, { scope: "session", session: ctx.session(), actions: ctx.session() ? [reload] : [] });
      sessionPart.root.insertBefore(inUse, sessionPart.body);
      const found = part(AGENTS_FOUND, { scope: "client" });
      const where = part(WHERE_FILES_GO, { scope: "client", lead: AGENTS_HOW });
      body.replaceChildren(sessionPart.root, found.root, where.root);
      if (ctx.session()) void loadSession(sessionPart.body, inUse); else sessionPart.body.replaceChildren(problem({ reason: SESSION_PART_NONE }));
      void load(found.body, () => ctx.call("client", "agents.discover", projectPaths(ctx)), v => list(AGENTS_FOUND, agentRows(v).map(a => row({ name: a.displayName, lines: [a.description, agentMeta(a)], mono: a.path })), AGENTS_NONE));
      void load(where.body, () => ctx.call("client", "agents.getDiscoveryPaths", projectPaths(ctx)), v => pathList(WHERE_FILES_GO, discoveryPaths(v), PREFERRED, sourceWords));
    },
  };
});
