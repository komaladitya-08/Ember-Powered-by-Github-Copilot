/**
 * The coding window (docs/CODING-APP.md §4): Ember as a coding agent on the GitHub Copilot SDK. It reaches main only
 * through the preload's `window.emberCode` (app/shared/code.ts's EmberCodeApi), keeps its state in store.ts's pure
 * reducers over the SDK's own events, and draws the sidebar, the start flow, the transcript with its request cards,
 * the composer, the panel, Customise and the command palette from that state. Without the API (a page opened on its
 * own) it says so and does nothing.
 *
 * Live regions as Home's chat: a new request is said assertively, a whole reply politely, each through a held line
 * (shared/held-live.ts) that says nothing while the microphone is open for a request: `setMicHeld` is the hook main's
 * voice will call through the preload once the window has that signal.
 */
import type { EmberCodeApi } from "../../shared/code";
import { heldLive } from "../shared/held-live";
import { CodeApp } from "./app";
import { requestTitle } from "./cards";
import { mountComposer } from "./composer";
import { CUSTOMISE, GO_TO_REQUEST, NEW_SESSION, PALETTE_ACTIONS, PALETTE_TITLE, SIDEBAR_RESIZE, TAB_NAMES, needsYouBar, paletteHint, paletteTab, pathTail, sandboxWords, sessionTitle } from "./copy";
import { mountCustomise, sectionId } from "./customise";
import { byId, setText } from "./dom";
import { mountPalette, primaryKey, slashAction, type PaletteAction } from "./palette";
import { mountPanel, panelTabs } from "./panel";
import { mountSidebar } from "./sidebar";
import { mountStart } from "./start";
import { allPending, setArchivedView, shownSession, type CodeState, type MainView } from "./store";
import { mountTranscript } from "./transcript-view";

declare global { interface Window { emberCode?: EmberCodeApi; __emberCode?: { app: CodeApp; setMicHeld(on: boolean): void } } }

const api = window.emberCode;
if (!api) {
  document.body.classList.add("no-api");
} else start(api);

function start(api: EmberCodeApi): void {
  const app = new CodeApp(api);
  const asks = heldLive(byId("live-asks"), 300);
  const said = heldLive(byId("live-said"));
  app.onSaid = (kind, text) => (kind === "asks" ? asks : said).say(text);
  window.__emberCode = { app, setMicHeld: on => { asks.hold(on); said.hold(on); } };

  const chord = `${primaryKey(navigator.userAgent)}+K`;
  let lastWork: MainView = { kind: "none" };

  const startView = mountStart(app);
  const customise = mountCustomise(app, () => lastWork);
  const composer = mountComposer(app);
  const panel = mountPanel(app);
  const transcript = mountTranscript(app, byId("transcript"));

  const newSession = (projectId?: string) => { app.showView({ kind: "start", ...(projectId ? { projectId } : {}) }); app.draw(); startView.focus(); closeDrawer(); };
  const openCustomise = (section = sectionId("Models")) => { app.showView({ kind: "customise", section }); app.draw(); customise.focus(); closeDrawer(); };
  app.add(mountSidebar(app, { onNewSession: newSession, onCustomise: () => openCustomise() }));
  app.add(startView);
  app.add(customise);
  app.add(composer);
  app.add(panel);
  app.add({ render: (s, prev) => transcript.render(s, prev) });

  // ───── The main area: which view is up, the session's header, the needs-you bar ─────
  const views = { session: byId("session-view"), start: byId("start-view"), customise: byId("customise-view"), none: byId("empty-view") };
  const title = byId("session-title"), where = byId("session-where");
  const bar = byId("needs-bar"), barWords = byId("needs-words"), barGo = byId<HTMLButtonElement>("needs-go");
  barGo.textContent = GO_TO_REQUEST;
  byId("empty-new").textContent = NEW_SESSION;
  byId("empty-new").addEventListener("click", () => newSession());
  byId("palette-button").textContent = PALETTE_TITLE;
  byId("palette-button").setAttribute("aria-keyshortcuts", chord.replace("Command", "Meta").replace("Ctrl", "Control"));
  byId("palette-button").title = paletteHint(chord);
  byId("sidebar-resize").setAttribute("aria-label", SIDEBAR_RESIZE);
  let shownId: string | null = null;
  app.add({
    render(s: CodeState) {
      const kind = s.view.kind;
      for (const [k, node] of Object.entries(views)) node.hidden = k !== kind;
      if (kind === "session" || kind === "none" || kind === "start") lastWork = s.view.kind === "start" ? { kind: "none" } : s.view;
      const row = shownSession(s);
      if (row) {
        setText(title, sessionTitle(row));
        const project = s.projects.byId[row.projectId];
        const box = sandboxWords(row.sandbox);
        setText(where, [project?.name, row.isolation === "worktree" ? `worktree ${row.branch ?? ""}`.trim() : pathTail(row.folder), box].filter(Boolean).join(" · "));
      }
      if (s.view.kind === "session" && s.view.id !== shownId) {
        shownId = s.view.id;
        // A session opened by the person: its name takes focus, so a screen reader hears where it is.
        if (document.activeElement?.closest("#sidebar, #palette") || document.activeElement === document.body) title.focus({ preventScroll: true });
      }
      if (s.view.kind !== "session") shownId = null;
      document.body.style.setProperty("--side-w", `${s.ui.sidebarWidth}px`);
      const waiting = allPending(s);
      bar.hidden = !waiting.length;
      if (waiting.length) setText(barWords, needsYouBar(waiting.length));
      const first = waiting[0];
      barGo.setAttribute("aria-label", first ? `${GO_TO_REQUEST}: ${requestTitle(first.kind, first.data)}` : GO_TO_REQUEST);
    },
  });
  barGo.addEventListener("click", () => {
    const first = allPending(app.state)[0];
    if (!first) return;
    void app.openSession(first.sessionId).then(() => {
      app.draw();
      const card = transcript.firstOpenRequest();
      if (!card) return;
      card.scrollIntoView({ block: "nearest" });
      (card.querySelector<HTMLElement>(".card-actions button:not(:disabled), textarea, input, select") ?? card).focus();
    });
  });
  byId("transcript").addEventListener("keydown", e => { if (e.key === "Escape") composer.focus(); });

  // ───── Narrow windows: the sidebar is a drawer ─────
  const drawer = byId<HTMLButtonElement>("drawer-toggle");
  const sidebar = byId("sidebar");
  function closeDrawer(): void { if (document.body.classList.contains("drawer-open")) { document.body.classList.remove("drawer-open"); drawer.setAttribute("aria-expanded", "false"); } }
  drawer.addEventListener("click", () => {
    const open = !document.body.classList.contains("drawer-open");
    document.body.classList.toggle("drawer-open", open);
    drawer.setAttribute("aria-expanded", String(open));
    if (open) sidebar.querySelector<HTMLElement>("#side-search")?.focus();
  });
  sidebar.addEventListener("click", e => { if ((e.target as HTMLElement).closest(".s-open")) closeDrawer(); });
  sidebar.addEventListener("keydown", e => { if (e.key === "Escape" && document.body.classList.contains("drawer-open")) { closeDrawer(); drawer.focus(); } });

  // The sidebar's edge moves with the pointer or the arrow keys.
  const sideEdge = byId("sidebar-resize");
  const clampSide = (w: number) => Math.round(Math.min(480, Math.max(200, w)));
  sideEdge.setAttribute("aria-valuemin", "200");
  sideEdge.setAttribute("aria-valuemax", "480");
  sideEdge.addEventListener("pointerdown", e => {
    e.preventDefault();
    sideEdge.setPointerCapture(e.pointerId);
    const move = (m: PointerEvent) => app.setUi({ sidebarWidth: clampSide(m.clientX) });
    const up = () => { sideEdge.removeEventListener("pointermove", move); sideEdge.removeEventListener("pointerup", up); };
    sideEdge.addEventListener("pointermove", move);
    sideEdge.addEventListener("pointerup", up);
  });
  sideEdge.addEventListener("keydown", e => {
    const w = app.state.ui.sidebarWidth;
    const next = e.key === "ArrowRight" ? w + 16 : e.key === "ArrowLeft" ? w - 16 : null;
    if (next === null) return;
    e.preventDefault();
    app.setUi({ sidebarWidth: clampSide(next) });
    sideEdge.setAttribute("aria-valuenow", String(clampSide(next)));
  });

  // ───── The command palette ─────
  const actions = (): PaletteAction[] => {
    const s = app.state;
    const row = shownSession(s);
    const list: PaletteAction[] = [
      { id: "new", label: PALETTE_ACTIONS.newSession, run: () => newSession() },
      { id: "add", label: PALETTE_ACTIONS.addProject, run: () => { void app.addProject(); } },
      { id: "search", label: PALETTE_ACTIONS.search, run: () => { document.body.classList.add("drawer-open"); byId("side-search").focus(); } },
      { id: "archived", label: s.archivedView ? PALETTE_ACTIONS.sessions : PALETTE_ACTIONS.archived, run: () => app.set(st => setArchivedView(st, !st.archivedView)) },
      { id: "panel", label: PALETTE_ACTIONS.panel, run: () => panel.toggle() },
      ...panelTabs().map(t => ({ id: `tab:${t.id}`, label: paletteTab(TAB_NAMES[t.id] ?? t.label), run: () => panel.select(t.id) })),
      { id: "customise", label: CUSTOMISE, run: () => openCustomise() },
      { id: "stop-all", label: PALETTE_ACTIONS.stopAll, run: () => app.stopAll() },
    ];
    if (row) {
      list.splice(1, 0, { id: "composer", label: PALETTE_ACTIONS.focusComposer, run: () => composer.focus() }, { id: "attach", label: PALETTE_ACTIONS.attach, run: () => composer.attach() });
      if (s.transcripts[row.id]?.busy || row.busy) list.push({ id: "stop", label: PALETTE_ACTIONS.stop, run: () => { void app.interrupt(row.id); } });
      for (const c of app.commands.get(row.id) ?? []) list.push(slashAction(c.name, c.description, words => composer.insert(words)));
    }
    return list;
  };
  const palette = mountPalette(app, actions);
  byId("palette-button").addEventListener("click", () => palette.open());
  document.addEventListener("keydown", e => {
    if (e.key.toLowerCase() === "k" && (e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey) { e.preventDefault(); if (palette.isOpen()) palette.close(); else palette.open(); }
  });

  void app.refresh();
}
