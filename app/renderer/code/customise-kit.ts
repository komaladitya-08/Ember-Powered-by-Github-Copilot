/**
 * What every Customise section is built from (docs/CODING-APP.md §4 "Customise"): the line at its top saying whether it
 * applies to this computer or to a session (naming the session, with a chooser), the session it is about, one call
 * path to the SDK's methods, and the parts every page reuses: a part that loads with "Loading…" and, when the call is
 * refused or fails, says main's plain sentence with Try again (never a blank page or the SDK's text); rows; switches
 * that put themselves back when a change is refused; a destructive action confirmed in place; labelled fields whose
 * errors sit under them.
 *
 * A method not on CODE_RPC (app/shared/code.ts) is never sent: its part says it isn't available yet, and lights up
 * as soon as the allow-list has it. Sections register through `defineSection`, which replaces customise.ts's empty
 * state for that label.
 */
import { codeRpcAllowed, type CodeSdkEvent, type CodeSessionRow } from "../../shared/code";
import type { CodeApp } from "./app";
import { sessionTitle } from "./copy";
import {
  CANCEL, CHOOSE_SESSION, FAILED, LOADING, NOT_AVAILABLE, NO_SESSION, NO_SESSIONS, PART_COMPUTER, RETRY, SCOPE_BOTH_NONE, SCOPE_COMPUTER, partSession,
  scopeBoth, scopeSession,
} from "./copy-customise";
import { registerCustomiseSection, sectionId } from "./customise";
import { el, idPart, setText } from "./dom";
import type { CodeState } from "./store";

/** An SDK call's outcome as a section reads it: its value, or a sentence (and whether the window may call it at all). */
export type Res = { ok: true; value: unknown } | { ok: false; reason: string; unavailable?: boolean };
export type Scope = "client" | "session";

/** The session Customise is about: the one last shown, or the one chosen in a section's chooser. Shared by every section. */
let chosen: string | null = null;

/** What a section's code gets. */
export interface SectionCtx {
  app: CodeApp;
  /** The session this section is about (null: none chosen, or a section about this computer only). */
  session(): CodeSessionRow | null;
  /** Call one of the SDK's methods; a session-scoped one goes to `session()`. */
  call(scope: Scope, method: string, params?: unknown): Promise<Res>;
  /** Say a change's outcome on the section's status line (once, politely). */
  say(text: string): void;
  /** The SDK events of `session()` while this section is up: register once, as the section is built (`dispose` stops them). */
  onEvent(fn: (e: CodeSdkEvent) => void): void;
}
export interface SectionView {
  /** Draw the section afresh into `body` (on mount, and when its session changes). */
  draw(body: HTMLElement): void;
  render?(s: CodeState, prev: CodeState | null): void;
}

/** Registers a section: `scope` says what its top line says, `build` makes its view once it is mounted. */
export function defineSection(label: string, scope: Scope | "both", build: (ctx: SectionCtx) => SectionView): void {
  registerCustomiseSection({
    id: sectionId(label), label,
    mount(host, panel) {
      const app = panel.app;
      const scopeLine = el("p", { className: "cz-scope" });
      const select = el("select", { id: `cz-session-${sectionId(label)}` });
      const chooser = el("span", { className: "cz-chooser" }, el("label", { htmlFor: select.id, textContent: CHOOSE_SESSION }), el("span", { className: "select-wrap" }, select));
      const said = el("p", { className: "cz-said", attrs: { role: "status" } });
      const body = el("div", { className: "cz-body" });
      const head = el("div", { className: "cz-top" }, scopeLine, scope === "client" ? null : chooser);
      host.replaceChildren(head, said, body);
      const listeners = new Set<(e: CodeSdkEvent) => void>();
      // After the store has taken each event (the app's one subscription), never a second one of the page's own.
      const stopEvents = app.watchEvents(env => { if (env.sessionId === chosen) for (const fn of listeners) fn(env.event); });
      const row = () => (chosen ? app.state.sessions.byId[chosen] ?? null : null);
      const ctx: SectionCtx = {
        app, session: row,
        call: (s, method, params) => call(app, s, s === "session" ? chosen : null, method, params),
        say: text => { setText(said, ""); setText(said, text); },
        onEvent: fn => { listeners.add(fn); },
      };
      const view = build(ctx);
      let drawnFor: string | null | undefined;
      let options = "";
      const sessions = () => app.state.sessions.order.map(id => app.state.sessions.byId[id]).filter((r): r is CodeSessionRow => !!r && !r.archived);
      const top = () => {
        const r = row();
        const name = r ? sessionTitle(r) : "";
        setText(scopeLine, scope === "client" ? SCOPE_COMPUTER : scope === "both" ? (r ? scopeBoth(name) : SCOPE_BOTH_NONE) : r ? scopeSession(name) : sessions().length ? NO_SESSION : NO_SESSIONS);
        const list = sessions();
        chooser.hidden = scope === "client" || !list.length;
        const sig = list.map(x => `${x.id}:${sessionTitle(x)}`).join("|") + `#${chosen ?? ""}`;
        if (sig !== options) {
          options = sig;
          select.replaceChildren(...list.map(x => {
            const project = app.state.projects.byId[x.projectId]?.name;
            return el("option", { value: x.id, textContent: project ? `${sessionTitle(x)} (${project})` : sessionTitle(x), selected: x.id === chosen });
          }));
        }
      };
      const draw = () => {
        // The section's listeners stay across a draw (they are registered once, as it is built): clearing them here
        // left the MCP page deaf to every status event after its first draw.
        drawnFor = chosen;
        top();
        setText(said, "");
        view.draw(body);
      };
      select.addEventListener("change", () => {
        chosen = select.value || null;
        const r = row();
        // A session kept on disk opens when it is attached: its methods answer only once it is open.
        if (r && !r.open) void app.attach(r.id).then(draw); else draw();
      });
      return {
        show(sessionId) {
          if (sessionId) chosen = sessionId;
          if (scope !== "client" && (!chosen || !app.state.sessions.byId[chosen])) chosen = sessions().find(r => r.open)?.id ?? null;
          draw();
        },
        render(s, prev) {
          if (scope !== "client" && chosen && !s.sessions.byId[chosen]) { chosen = null; draw(); return; }
          if (scope !== "client" && drawnFor !== chosen) { draw(); return; }
          top();
          view.render?.(s, prev);
        },
        dispose() { listeners.clear(); stopEvents(); },
      };
    },
  });
}

/** One SDK call: refused here when the allow-list doesn't have it or no session is chosen, else main's answer. */
export async function call(app: CodeApp, scope: Scope, sessionId: string | null, method: string, params?: unknown): Promise<Res> {
  if (!codeRpcAllowed(scope, method)) return { ok: false, reason: NOT_AVAILABLE, unavailable: true };
  if (scope === "session" && !sessionId) return { ok: false, reason: NO_SESSION };
  const r = await app.rpc({ scope, ...(sessionId && scope === "session" ? { sessionId } : {}), method, ...(params !== undefined ? { params } : {}) });
  return r.ok ? { ok: true, value: r.value } : { ok: false, reason: r.reason || FAILED };
}

/** A part of a section: its heading, the scope it is about where the section mixes them, and its own body. */
export function part(title: string, opts: { scope?: Scope; session?: CodeSessionRow | null; actions?: Node[]; lead?: string } = {}): { root: HTMLElement; body: HTMLElement } {
  const id = `cz-h-${idPart(title)}`;
  const tag = opts.scope === "client" ? PART_COMPUTER : opts.scope === "session" && opts.session ? partSession(sessionTitle(opts.session)) : "";
  const body = el("div", { className: "cz-part-body" });
  const root = el("section", { className: "cz-part", attrs: { "aria-labelledby": id } },
    el("div", { className: "cz-part-head" }, el("h3", { id, textContent: title }), tag ? el("span", { className: "tag quiet", textContent: tag }) : null, el("span", { className: "cz-gap" }), ...(opts.actions ?? [])),
    opts.lead ? el("p", { className: "hint", textContent: opts.lead }) : null, body);
  return { root, body };
}

/**
 * Loads into `host`: "Loading…", then what `draw` makes of the value, or the refusal's sentence with Try again (a
 * method not available yet says so, with nothing to try). Resolves with the value, or null when it didn't load.
 */
export async function load(host: HTMLElement, run: () => Promise<Res>, draw: (v: unknown) => Node | (Node | null)[]): Promise<unknown> {
  host.replaceChildren(el("p", { className: "cz-loading", textContent: LOADING }));
  host.setAttribute("aria-busy", "true");
  const r = await run();
  host.removeAttribute("aria-busy");
  if (!r.ok) {
    host.replaceChildren(problem(r, () => { void load(host, run, draw); }));
    return null;
  }
  const out = draw(r.value);
  host.replaceChildren(...(Array.isArray(out) ? out.filter((n): n is Node => !!n) : [out]));
  return r.value;
}

/** A refusal's line: the sentence and Try again, or "not available yet" alone. */
export function problem(r: { reason: string; unavailable?: boolean }, retry?: () => void): HTMLElement {
  if (r.unavailable) return el("p", { className: "cz-na", textContent: NOT_AVAILABLE });
  const line = el("div", { className: "cz-problem" }, el("p", { textContent: r.reason }));
  if (retry) {
    const again = el("button", { type: "button", className: "btn quiet small", textContent: RETRY });
    again.addEventListener("click", () => { retry(); });
    line.append(again);
  }
  return line;
}

/** A list of rows with its accessible name, or the empty sentence. */
export function list(label: string, rows: Node[], empty: string): HTMLElement {
  if (!rows.length) return el("p", { className: "cz-empty", textContent: empty });
  return el("ul", { className: "cz-list", attrs: { "aria-label": label } }, ...rows);
}

/** One row: a name (weight 600), its lines of detail, tags, and its controls at the trailing edge. */
export function row(o: { name: string; id?: string; lines?: (string | undefined)[]; tags?: (string | false | undefined)[]; mono?: string; actions?: (Node | null)[]; more?: (Node | null)[] }): HTMLLIElement {
  const nameId = o.id ?? `cz-n-${idPart(o.name)}`;
  const words = el("div", { className: "cz-words" },
    el("p", { className: "cz-name" }, el("span", { id: nameId, textContent: o.name }), ...(o.tags ?? []).filter((t): t is string => !!t).map(t => el("span", { className: "tag quiet", textContent: t }))),
    ...(o.lines ?? []).filter((l): l is string => !!l).map(l => el("p", { className: "cz-line", textContent: l })),
    o.mono ? el("p", { className: "cz-mono", textContent: o.mono }) : null,
    ...(o.more ?? []));
  const li = el("li", { className: "cz-row" }, words);
  const actions = (o.actions ?? []).filter((n): n is Node => !!n);
  if (actions.length) li.append(el("div", { className: "cz-actions" }, ...actions));
  return li;
}

/** A switch for something that takes effect at once: it shows what main says, putting itself back when refused. */
export function toggle(o: { labelledBy: string; label?: string; on: boolean; disabled?: boolean; change(on: boolean): Promise<Res>; done?(on: boolean): void; ctx: SectionCtx }): HTMLInputElement {
  const sw = el("input", { type: "checkbox", checked: o.on, disabled: !!o.disabled, attrs: { role: "switch", "aria-labelledby": o.label ? undefined : o.labelledBy, "aria-label": o.label } });
  sw.addEventListener("change", async () => {
    const want = sw.checked;
    sw.disabled = true;
    const r = await o.change(want);
    sw.disabled = !!o.disabled;
    if (!r.ok) { sw.checked = !want; o.ctx.say(r.reason); return; }
    o.done?.(want);
  });
  return sw;
}

/** A button that does one thing at a time: disabled while its work runs. */
export function action(label: string, run: () => Promise<void>, opts: { aria?: string; prominent?: boolean; className?: string } = {}): HTMLButtonElement {
  const b = el("button", { type: "button", className: `btn${opts.prominent ? "" : " quiet"} small${opts.className ? ` ${opts.className}` : ""}`, textContent: label });
  if (opts.aria) b.setAttribute("aria-label", opts.aria);
  b.addEventListener("click", async () => {
    if (b.disabled) return;
    b.disabled = true;
    try { await run(); } finally { b.disabled = false; }
  });
  return b;
}

/**
 * A destructive action, confirmed in place: its button becomes the question with the action (in red words, never
 * filled) and Cancel, which has the focus; Escape cancels. `run` happens only on the second press.
 */
export function confirmed(label: string, question: string, yes: string, run: () => Promise<void>, opts: { aria?: string } = {}): HTMLElement {
  const wrap = el("span", { className: "cz-confirm" });
  const trigger = el("button", { type: "button", className: "btn quiet small", textContent: label });
  if (opts.aria) trigger.setAttribute("aria-label", opts.aria);
  wrap.append(trigger);
  trigger.addEventListener("click", () => {
    const ask = el("span", { className: "cz-ask", attrs: { role: "group", "aria-label": question } });
    const go = el("button", { type: "button", className: "btn quiet small cz-danger", textContent: yes });
    const no = el("button", { type: "button", className: "btn quiet small", textContent: CANCEL });
    const back = () => { wrap.replaceChildren(trigger); trigger.focus(); };
    no.addEventListener("click", back);
    ask.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); back(); } });
    go.addEventListener("click", async () => {
      go.disabled = no.disabled = true;
      await run();
      if (wrap.isConnected) back();
    });
    ask.append(el("span", { className: "cz-ask-words", textContent: question }), go, no);
    wrap.replaceChildren(ask);
    no.focus();
  });
  return wrap;
}

/** A labelled field with its hint and an error line under it (`error("")` clears it). */
export function field(id: string, label: string, control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, hint?: string): { root: HTMLElement; error(text: string): void } {
  control.id = id;
  const err = el("p", { className: "cz-err", id: `${id}-err` });
  const hintEl = hint ? el("p", { className: "hint", id: `${id}-hint`, textContent: hint }) : null;
  control.setAttribute("aria-describedby", [hintEl ? hintEl.id : "", err.id].filter(Boolean).join(" "));
  const root = el("div", { className: "cz-field" }, el("label", { htmlFor: id, textContent: label }), control.tagName === "SELECT" ? el("span", { className: "select-wrap" }, control) : control, hintEl, err);
  return {
    root,
    error(text) {
      setText(err, text);
      if (text) control.setAttribute("aria-invalid", "true"); else control.removeAttribute("aria-invalid");
    },
  };
}

/** A one-line text field. */
export function input(o: { value?: string; placeholder?: string; type?: string; spell?: boolean } = {}): HTMLInputElement {
  return el("input", { type: o.type ?? "text", value: o.value ?? "", autocomplete: "off", spellcheck: !!o.spell, ...(o.placeholder ? { placeholder: o.placeholder } : {}) });
}

/** A disclosure in the window's style: its summary, and its content drawn the first time it opens. */
export function disclosure(summary: string, fill: (into: HTMLElement) => void): HTMLDetailsElement {
  const body = el("div", { className: "cz-disclosed" });
  const d = el("details", { className: "disclose" }, el("summary", { textContent: summary }), body);
  let filled = false;
  d.addEventListener("toggle", () => { if (d.open && !filled) { filled = true; fill(body); } });
  return d;
}

/**
 * The folders a client-scoped discovery scans for the session: the folder it works in (a worktree Ember made for it
 * too, which main takes as the session's own though it lies in Ember's data folder), so what is listed is what that
 * session's files hold; else its project's folder.
 */
export function projectPaths(ctx: SectionCtx): { projectPaths?: string[] } {
  const r = ctx.session();
  const folder = r ? r.folder || ctx.app.state.projects.byId[r.projectId]?.folder : undefined;
  return folder ? { projectPaths: [folder] } : {};
}
/** The same folder as a working directory (`mcp.discover`, `plugins.*`). */
export function workingDir(ctx: SectionCtx): { workingDirectory?: string } {
  const p = projectPaths(ctx).projectPaths?.[0];
  return p ? { workingDirectory: p } : {};
}

/** A line of paths where files go, the one used for new files marked. */
export function pathList(label: string, paths: { path: string; scope: string; preferred: boolean }[], preferredWord: string, scopeWord: (s: string) => string): HTMLElement {
  return list(label, paths.map(p => el("li", { className: "cz-path" }, el("span", { className: "cz-mono", textContent: p.path }), el("span", { className: "cz-line", textContent: [scopeWord(p.scope), p.preferred ? preferredWord : ""].filter(Boolean).join(" · ") }))), "");
}
