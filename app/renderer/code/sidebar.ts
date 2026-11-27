/**
 * The sidebar: projects with their sessions (status marks in a symbol and words, pinned first), search, an archived
 * view, New session…, Add project… and Customise…. Rows are drawn again only when what they show changes, and focus
 * stays on the control it was on across a redraw.
 */
import type { CodeSessionRow } from "../../shared/code";
import type { CodeApp, View } from "./app";
import {
  ADD_PROJECT, ARCHIVED_TITLE, BACK_TO_SESSIONS, CUSTOMISE, LOADING, NEW_SESSION, OTHER_SESSIONS, PROJECT_EMPTY, SEARCH_LABEL, SEARCH_PLACEHOLDER,
  archiveLabel, archivedLink, foldProject, newSessionIn, pinLabel, sessionLabel, sessionTitle, sidebarEmpty, statusWords, updatedWords,
} from "./copy";
import { byId, el, setText } from "./dom";
import { archivedCount, setArchivedView, setQuery, sidebarGroups, statusOf, type CodeState } from "./store";

const MARK: Record<string, string | undefined> = { "needs-you": "waiting", working: "running", unread: "unread" };

export function mountSidebar(app: CodeApp, opts: { onNewSession(projectId?: string): void; onCustomise(): void }): View {
  const list = byId("side-list");
  const search = byId<HTMLInputElement>("side-search");
  const note = byId("side-note");
  const archivedBtn = byId<HTMLButtonElement>("side-archived");
  byId("side-search-label").textContent = SEARCH_LABEL;
  search.placeholder = SEARCH_PLACEHOLDER;
  const newBtn = byId<HTMLButtonElement>("side-new");
  newBtn.textContent = NEW_SESSION;
  newBtn.addEventListener("click", () => opts.onNewSession());
  const addBtn = byId<HTMLButtonElement>("side-add");
  addBtn.textContent = ADD_PROJECT;
  addBtn.addEventListener("click", () => { void app.addProject(); });
  const customiseBtn = byId<HTMLButtonElement>("side-customise");
  customiseBtn.textContent = CUSTOMISE;
  customiseBtn.addEventListener("click", () => opts.onCustomise());
  search.addEventListener("input", () => app.set(s => setQuery(s, search.value)));
  search.addEventListener("keydown", e => {
    if (e.key === "Escape" && search.value) { e.preventDefault(); search.value = ""; app.set(s => setQuery(s, "")); }
    if (e.key === "ArrowDown") { e.preventDefault(); list.querySelector<HTMLElement>(".s-open")?.focus(); }
  });
  archivedBtn.addEventListener("click", () => app.set(s => setArchivedView(s, !s.archivedView)));

  // Up and Down move between the sessions' rows, as in a list.
  list.addEventListener("keydown", e => {
    const t = e.target as HTMLElement;
    if (!t.classList.contains("s-open") || (e.key !== "ArrowDown" && e.key !== "ArrowUp")) return;
    const rows = [...list.querySelectorAll<HTMLElement>(".s-open")];
    const i = rows.indexOf(t);
    const next = rows[i + (e.key === "ArrowDown" ? 1 : -1)];
    if (next) { e.preventDefault(); next.focus(); }
  });

  const rowEls = new Map<string, { li: HTMLLIElement; sig: string }>();
  let drawnSig = "";

  function rowItem(s: CodeState, row: CodeSessionRow): HTMLLIElement {
    const status = statusOf(s, row);
    const shown = s.view.kind === "session" && s.view.id === row.id;
    const title = sessionTitle(row);
    const sig = JSON.stringify([title, row.branch, row.isolation, row.pinned, row.archived, status, shown, Math.floor(row.updatedAt / 60_000)]);
    const had = rowEls.get(row.id);
    if (had && had.sig === sig) return had.li;
    const open = el("button", { type: "button", className: "s-open", attrs: { "aria-label": sessionLabel(row, status), ...(shown ? { "aria-current": "true" } : {}) }, data: { session: row.id, focus: "open" } });
    const mark = el("span", { className: "s-mark", attrs: { "aria-hidden": "true" }, data: { mark: MARK[status] ?? "none" } });
    if (MARK[status] && status !== "unread") mark.dataset.status = MARK[status]!;
    open.append(
      mark,
      el("span", { className: "s-text" },
        el("span", { className: "s-name", textContent: title }),
        // The state's words lead the line under the name (the row's name says them to a screen reader).
        el("span", { className: "s-meta" },
          statusWords(status) ? el("span", { className: `s-state s-${status}`, textContent: statusWords(status) }) : null,
          row.isolation === "worktree" && row.branch ? el("span", { className: "s-branch", textContent: row.branch }) : null,
          el("span", { className: "s-time", textContent: updatedWords(row.updatedAt, Date.now()) }))),
    );
    open.addEventListener("click", () => { void app.openSession(row.id); });
    const pin = el("button", { type: "button", className: "s-act s-pin", attrs: { "aria-label": pinLabel(title, row.pinned), "aria-pressed": String(row.pinned), title: pinLabel(title, row.pinned) }, data: { focus: "pin" } });
    pin.addEventListener("click", () => { void app.updateRow(row.id, { pinned: !row.pinned }); });
    const archive = el("button", { type: "button", className: "s-act s-archive", attrs: { "aria-label": archiveLabel(title, row.archived), title: archiveLabel(title, row.archived) }, data: { focus: "archive", archived: String(row.archived) } });
    archive.addEventListener("click", () => { void app.updateRow(row.id, { archived: !row.archived }); });
    const li = el("li", { className: `s-row${shown ? " current" : ""}${row.pinned ? " pinned" : ""}` }, open, pin, archive);
    li.dataset.session = row.id;
    const focused = had && document.activeElement && had.li.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.focus : undefined;
    if (had) had.li.replaceWith(li);
    rowEls.set(row.id, { li, sig });
    if (focused) li.querySelector<HTMLElement>(`[data-focus="${focused}"]`)?.focus();
    return li;
  }

  function render(s: CodeState, prev: CodeState | null): void {
    if (prev && s.sessions === prev.sessions && s.projects === prev.projects && s.pending === prev.pending && s.view === prev.view
      && s.query === prev.query && s.archivedView === prev.archivedView && s.ui.folded === prev.ui.folded && s.transcripts === prev.transcripts && s.notes === prev.notes && s.listed === prev.listed) return;
    setText(archivedBtn, s.archivedView ? BACK_TO_SESSIONS : archivedLink(archivedCount(s)));
    archivedBtn.setAttribute("aria-pressed", String(s.archivedView));
    setText(note, s.notes[""]?.sidebar ?? "");
    const groups = sidebarGroups(s);
    const busyOf = groups.map(g => g.rows.map(r => `${r.id}:${statusOf(s, r)}`).join(",")).join("|");
    const sig = JSON.stringify([s.listed, s.archivedView, s.query, s.ui.folded, groups.map(g => [g.projectId, g.project?.name, g.rows.map(r => r.id)]), busyOf]);
    const focusedSession = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>("#side-list [data-session]")?.dataset.session;
    const focusedName = (document.activeElement as HTMLElement | null)?.dataset.focus;
    if (sig === drawnSig) {
      // The same groups and rows: each row is drawn again in place where what it shows changed.
      for (const g of groups) if (!s.ui.folded.includes(g.projectId) || s.query.trim()) for (const r of g.rows) rowItem(s, r);
      return;
    }
    drawnSig = sig;
    const kids: HTMLElement[] = [];
    if (!s.listed) kids.push(el("p", { className: "side-empty", textContent: LOADING }));
    else if (!groups.length) kids.push(el("p", { className: "side-empty", textContent: sidebarEmpty(s.query, s.archivedView) }));
    if (s.archivedView) kids.push(el("h2", { className: "side-h", textContent: ARCHIVED_TITLE }));
    const seen = new Set<string>();
    for (const g of groups) {
      const name = g.project?.name ?? OTHER_SESSIONS;
      const folded = s.ui.folded.includes(g.projectId) && !s.query.trim();
      const headId = `proj-${g.projectId || "other"}`.replace(/[^A-Za-z0-9_-]/g, "");
      const fold = el("button", { type: "button", className: "p-fold", attrs: { "aria-expanded": String(!folded), "aria-label": foldProject(name, folded) }, data: { focus: `fold:${g.projectId}` } },
        el("span", { className: "p-name", textContent: name, id: headId }));
      fold.addEventListener("click", () => app.setUi({ folded: folded ? s.ui.folded.filter(x => x !== g.projectId) : [...s.ui.folded, g.projectId] }));
      const add = g.project && !s.archivedView ? el("button", { type: "button", className: "s-act p-new", attrs: { "aria-label": newSessionIn(name), title: newSessionIn(name) }, data: { focus: `new:${g.projectId}` } }) : null;
      add?.addEventListener("click", () => opts.onNewSession(g.projectId));
      const head = el("div", { className: "p-head" }, fold, add);
      const ul = el("ul", { className: "s-list", attrs: { "aria-labelledby": headId } });
      if (!folded) {
        for (const r of g.rows) { ul.append(rowItem(s, r)); seen.add(r.id); }
        if (!g.rows.length) ul.append(el("li", { className: "s-none", textContent: PROJECT_EMPTY }));
      }
      kids.push(el("section", { className: "p-group" }, head, ul));
    }
    for (const id of [...rowEls.keys()]) if (!seen.has(id)) rowEls.delete(id);
    list.replaceChildren(...kids);
    if (focusedSession && document.activeElement === document.body) rowEls.get(focusedSession)?.li.querySelector<HTMLElement>(`[data-focus="${focusedName ?? "open"}"]`)?.focus();
    else if (focusedName && document.activeElement === document.body) list.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusedName)}"]`)?.focus();
  }

  return { render };
}
