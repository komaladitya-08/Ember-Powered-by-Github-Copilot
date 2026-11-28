/**
 * Customise › Instructions: the instruction files in force in the open session (session `instructions.getSources`,
 * read again with `instructions.reload`), those new sessions find (client `instructions.discover`), each marked in
 * force or not in the session, with its scope and the files it applies to, and its text behind a disclosure; and
 * where instruction files go (`instructions.getDiscoveryPaths`). The text is a file's own: drawn as text, never markup.
 */
import {
  INSTRUCTIONS_FOUND, INSTRUCTIONS_HOW, INSTRUCTIONS_NONE, INSTRUCTIONS_SESSION, IN_FORCE, NOT_IN_FORCE, PREFERRED, RELOAD, RELOADED, SESSION_PART_NONE, SHOW_TEXT,
  STARTS_OFF, WHERE_FILES_GO, appliesTo, sourceWords,
} from "./copy-customise";
import { action, defineSection, disclosure, list, load, part, pathList, problem, projectPaths, row } from "./customise-kit";
import { discoveryPaths, instructionRows, type InstructionRow } from "./customise-read";
import { el } from "./dom";

const TEXT_MAX = 20_000;

defineSection("Instructions", "both", ctx => {
  let inSession: Set<string> | null = null;
  const sourceRow = (s: InstructionRow, tag: string): HTMLLIElement => row({
    name: s.label, lines: [`${sourceWords(s.location)} · ${appliesTo(s.applyTo)}`, s.description], mono: s.path,
    tags: [tag, s.startsOff ? STARTS_OFF : ""],
    more: [s.content ? disclosure(SHOW_TEXT, into => into.replaceChildren(el("pre", { className: "cz-pre", tabIndex: 0, textContent: s.content.length > TEXT_MAX ? `${s.content.slice(0, TEXT_MAX)}…` : s.content }))) : null],
  });
  const loadSession = (host: HTMLElement, method: "instructions.getSources" | "instructions.reload") => load(host, () => ctx.call("session", method), v => {
    const rows = instructionRows(v);
    inSession = new Set(rows.map(r => r.id));
    return list(INSTRUCTIONS_SESSION, rows.map(r => sourceRow(r, IN_FORCE)), INSTRUCTIONS_NONE);
  });
  return {
    draw(body) {
      const reload = action(RELOAD, async () => { const v = await loadSession(sessionPart.body, "instructions.reload"); if (v !== null) { ctx.say(RELOADED); void loadFound(); } }, { aria: `${RELOAD}: ${INSTRUCTIONS_SESSION}` });
      const sessionPart = part(INSTRUCTIONS_SESSION, { scope: "session", session: ctx.session(), actions: ctx.session() ? [reload] : [] });
      const found = part(INSTRUCTIONS_FOUND, { scope: "client" });
      const where = part(WHERE_FILES_GO, { scope: "client", lead: INSTRUCTIONS_HOW });
      body.replaceChildren(sessionPart.root, found.root, where.root);
      inSession = null;
      const loadFound = () => load(found.body, () => ctx.call("client", "instructions.discover", projectPaths(ctx)), v => list(INSTRUCTIONS_FOUND, instructionRows(v).map(r => sourceRow(r, inSession ? (inSession.has(r.id) ? IN_FORCE : NOT_IN_FORCE) : "")), INSTRUCTIONS_NONE));
      if (ctx.session()) void loadSession(sessionPart.body, "instructions.getSources").then(() => loadFound());
      else { sessionPart.body.replaceChildren(problem({ reason: SESSION_PART_NONE })); void loadFound(); }
      void load(where.body, () => ctx.call("client", "instructions.getDiscoveryPaths", projectPaths(ctx)), v => pathList(WHERE_FILES_GO, discoveryPaths(v), PREFERRED, sourceWords));
    },
  };
});
