/**
 * The panel's Changes tab (docs/CODING-APP.md §4): the session's diff through the SDK's `workspaces.diff` (this
 * session's changes, the uncommitted ones, or those against the branch), by file, each file's lines drawn with the
 * shared diff rows (a sign, line numbers and words, never colour alone); line comments collected in a Review strip and
 * sent to Copilot as one message; rewinding through `history.*`, with a preview and a plain warning that commands
 * already run are not undone; and git actions that are only messages to Copilot, which asks before it runs anything.
 *
 * It reads again when a turn ends, when a tool changed files or ran a command (after a short settle), after a rewind
 * and on demand, and only while it is up (a change while it is hidden is read when it next shows). Every SDK call goes
 * through `app.rpc`, by name, on CODE_RPC's allow-list; a method that isn't allowed says so instead of failing.
 * Its pure logic is changes-model.ts and its words copy-changes.ts.
 */
import { codeRpcAllowed, type CodeDone } from "../../shared/code";
import { diffRows, type DiffRow } from "../shared/diff-rows";
import {
  DIFF_MODES, addComment, busyIn, changesFiles, commentable, commitPrompt, diffFrom, editComment, historyChanged, linesWords, previewFrom, pullRequestPrompt,
  PUSH_PROMPT, rangeOf, removeComment, REVIEW_MAX, reviewPrompt, rewindPointsFrom, rewindResultFrom, shownPath, wantRebuild, COMMENT_MAX,
  type DiffMode, type DiffView, type LineRange, type ReviewComment, type RewindList, type RewindMode, type RewindPoint, type RewindPreview,
} from "./changes-model";
import { PANEL_NO_SESSION, TAB_NAMES, UNREACHABLE } from "./copy";
import * as W from "./copy-changes";
import { el, idPart } from "./dom";
import type { PanelContext, PanelInstance, PanelTab } from "./panel";
import { arrowsBetween, redraw, section, segmented, settle } from "./panel-kit";
import type { CodeState } from "./store";

/** How long the tab waits to read again after the runtime said it was busy (times the try), and how many tries. */
const BUSY_WAIT_MS = 700, BUSY_TRIES = 6;

/** How long after the last tool that changed files the diff is read again. */
export const FILE_CHANGE_SETTLE_MS = 400;

type Load<T> = { state: "idle" } | { state: "loading"; was?: T } | { state: "ok"; value: T } | { state: "failed"; reason: string; was?: T };
const valueOf = <T>(l: Load<T>): T | undefined => (l.state === "ok" ? l.value : l.state === "loading" || l.state === "failed" ? l.was : undefined);
const reasonOf = (r: CodeDone<unknown>): string => (r.ok ? "" : r.reason || UNREACHABLE);
/** Main's sentence for a method the allow-list doesn't have: the call isn't made. */
const NOT_ALLOWED = "The coding window can't call that.";

export const changesTab: PanelTab = { id: "changes", label: TAB_NAMES.changes ?? "Changes", mount: mountChanges };

interface Kept { review: ReviewComment[]; drafts: Record<string, string> }

function mountChanges(host: HTMLElement, ctx: PanelContext): PanelInstance {
  const app = ctx.app;
  let sid: string | null = null;
  let mode: DiffMode = "session";
  let ignoreWs = false;
  let diff: Load<DiffView> = { state: "idle" };
  let points: Load<RewindList> = { state: "idle" };
  let diffToken = 0, pointsToken = 0;
  /** Reads again after the runtime said it was busy though the window saw the turn end, and how many in a row. */
  let busyRetry: ReturnType<typeof setTimeout> | null = null, busyTries = 0;
  const open = new Set<string>();
  let sel: { file: string; anchor: number; focus: number } | null = null;
  /** The comment being written: on which file (its SDK path) and which lines. */
  let commenting: { path: string; range: LineRange } | null = null;
  let editing: string | null = null;
  let gitForm: "commit" | "pr" | null = null;
  let gitNote = "";
  /** What became of the last review sent (a note), or why it wasn't sent (a problem). */
  let reviewNote: { text: string; problem: boolean } | null = null;
  let rewindAt: { point: RewindPoint; preview: Load<RewindPreview>; choice: RewindMode; running: boolean } | null = null;
  let rewindNote = "";
  let dirty = false;
  let wasBusy = false;
  /** show() ran in this draw: its reads stand for the panel opening again. */
  let justShown = false;
  const kept = new Map<string, Kept>();
  const keep = (): Kept => {
    if (!sid) return { review: [], drafts: {} };
    if (!kept.has(sid)) kept.set(sid, { review: [], drafts: {} });
    return kept.get(sid)!;
  };
  const folder = () => (sid ? app.state.sessions.byId[sid]?.folder : undefined);
  const busy = () => !!sid && busyIn(app.state, sid);
  const up = () => !host.hidden && app.state.ui.panelOpen && app.state.ui.panelTab === "changes";
  const say = (text: string) => app.onSaid?.("said", text);

  // ───── The frame: nothing chosen, or the tab's parts ─────
  const none = el("p", { className: "panel-empty" });
  const modes = segmented<DiffMode>(W.MODE_LABEL, DIFF_MODES.map(m => ({ value: m, label: W.MODE_NAMES[m] })), "mode", m => { if (m !== mode) { mode = m; modes.set(m); void readDiff(); } });
  const ws = el("input", { type: "checkbox", id: "ch-ws", attrs: { role: "switch" }, data: { key: "ws" } });
  ws.addEventListener("change", () => { ignoreWs = ws.checked; void readDiff(); });
  const refresh = el("button", { type: "button", className: "btn quiet small", textContent: W.REFRESH, data: { key: "refresh" } });
  refresh.addEventListener("click", () => { void readDiff(); void readPoints(); });
  const bar = el("div", { className: "ch-bar" }, modes.node, el("span", { className: "ch-tools" }, el("label", { className: "ch-ws", htmlFor: "ch-ws" }, ws, W.IGNORE_WHITESPACE), refresh));
  const summary = el("div", { className: "ch-summary" });
  const reviewHost = el("div", { className: "pt-body ch-review-host" });
  const filesHost = el("div", { className: "pt-body ch-files-host" });
  const gitHost = el("div", { className: "pt-body" });
  const rewindHost = el("div", { className: "pt-body" });
  const body = el("div", { className: "pt ch" }, bar, summary, reviewHost, section("ch-files", W.FILES_HEADING, filesHost), section("ch-git", W.GIT_HEADING, gitHost), section("ch-rewind", W.REWIND_HEADING, rewindHost));
  host.replaceChildren(none, body);
  arrowsBetween(filesHost, ".ch-file-head");
  arrowsBetween(rewindHost, ".rw-go");

  const stopWatching = app.watchEvents(env => {
    if (env.sessionId !== sid) return;
    const t = env.event.type;
    // A tool that changed files (its `fileEdits`, or any command, which may have), or a file of the session's own: the
    // runtime sends no event for a repository file a tool wrote (probed on runtime 1.0.97: `session.workspace_file_changed`
    // is the session's state folder only).
    if (t === "session.workspace_file_changed" || (t === "tool.execution_complete" && changesFiles(env.event.data))) { if (up()) fileSettle.call(); else dirty = true; }
    if (t === "session.snapshot_rewind" || t === "session.truncation") { if (up()) { void readPoints(); void readDiff(); } else dirty = true; }
  });
  const fileSettle = settle(FILE_CHANGE_SETTLE_MS, () => { void readDiff(); });

  // ───── Reading ─────
  async function call(method: string, params?: unknown): Promise<CodeDone<unknown>> {
    if (!sid) return { ok: false, reason: UNREACHABLE };
    if (!codeRpcAllowed("session", method)) return { ok: false, reason: NOT_ALLOWED };
    return app.rpc({ scope: "session", sessionId: sid, method, ...(params !== undefined ? { params } : {}) });
  }

  async function readDiff(): Promise<void> {
    if (!sid) return;
    const my = ++diffToken, at = sid;
    diff = { state: "loading", ...(valueOf(diff) ? { was: valueOf(diff) } : {}) };
    drawSummary();
    const r = await call("workspaces.diff", { mode, ...(ignoreWs ? { ignoreWhitespace: true } : {}) });
    if (my !== diffToken || at !== sid) return;
    const view = r.ok ? diffFrom(r.value, mode) : null;
    diff = view ? { state: "ok", value: view } : { state: "failed", reason: r.ok ? "" : reasonOf(r), ...(valueOf(diff) ? { was: valueOf(diff) } : {}) };
    // A file no longer changed loses its place in the open set, its selection and its comment form.
    const paths = new Set(view?.files.map(f => f.path) ?? []);
    for (const p of [...open]) if (view && !paths.has(p)) open.delete(p);
    if (sel && view && !paths.has(sel.file)) { sel = null; commenting = null; }
    drawSummary();
    drawFiles();
    againIfBusy(view?.unavailable === "session-busy");
  }

  /**
   * The runtime answers "session-busy" for a while after a turn's `session.idle` (probed on runtime 1.0.97: its own
   * work after the turn, a title or the session store, still runs), and nothing of the window's changes when it ends:
   * so the tab reads again on its own, a few times with longer waits, while the window sees no turn running.
   */
  function againIfBusy(said: boolean): void {
    if (!said) { busyTries = 0; return; }
    if (busyRetry || busy() || busyTries >= BUSY_TRIES) return;
    busyRetry = setTimeout(() => { busyRetry = null; busyTries++; if (up() && sid && !busy()) { void readDiff(); void readPoints(); } }, BUSY_WAIT_MS * (busyTries + 1));
  }

  async function readPoints(): Promise<void> {
    if (!sid) return;
    const my = ++pointsToken, at = sid;
    points = { state: "loading", ...(valueOf(points) ? { was: valueOf(points) } : {}) };
    const r = await call("history.listRewindPoints");
    if (my !== pointsToken || at !== sid) return;
    const list = r.ok ? rewindPointsFrom(r.value) : null;
    points = list ? { state: "ok", value: list } : { state: "failed", reason: r.ok ? "" : reasonOf(r) };
    if (rewindAt && list && !list.points.some(p => p.eventId === rewindAt!.point.eventId)) rewindAt = null;
    drawRewind();
    againIfBusy(list?.unavailable === "session-busy");
  }

  // ───── The summary line and its notes ─────
  function drawSummary(): void {
    const v = valueOf(diff);
    const lines: HTMLElement[] = [];
    if (diff.state === "loading") lines.push(el("p", { className: "hint", textContent: W.REFRESHING }));
    else if (diff.state === "failed") lines.push(el("p", { className: "pt-problem", textContent: W.readFailed("changes", diff.reason) }));
    if (v) {
      if (v.fallback || v.mode !== v.requested) lines.push(el("p", { className: "pt-note", textContent: W.fallbackWords(v.requested, v.mode, v.unavailable) }));
      else if (v.unavailable) lines.push(el("p", { className: "pt-note", textContent: W.unavailableWords(v.unavailable) }));
      if (v.mode === "branch" && v.baseBranch) lines.push(el("p", { className: "hint", textContent: W.againstBase(v.baseBranch) }));
      const words = W.changesSummary(v.files.length, v.added, v.removed);
      if (words && diff.state !== "loading") lines.push(el("p", { className: "ch-count", textContent: words }));
    }
    redraw(summary, ...lines);
  }

  // ───── Files and their lines ─────
  function drawFiles(): void {
    const v = valueOf(diff);
    if (!v) { redraw(filesHost); return; }
    if (!v.files.length) { redraw(filesHost, diff.state === "loading" ? null : el("p", { className: "pt-empty", textContent: W.noChanges(v.mode, v.baseBranch) })); return; }
    const list = el("ul", { className: "ch-files", attrs: { role: "list" } });
    for (const f of v.files) {
      const key = idPart(f.path);
      const shown = shownPath(f.path, folder());
      const isOpen = open.has(f.path);
      const head = el("button", {
        type: "button", className: "ch-file-head", id: `chf-${key}`,
        attrs: { "aria-expanded": String(isOpen), "aria-controls": `chb-${key}`, "aria-label": W.fileLabel(shown, f.status, f.added, f.removed, f.oldPath ? shownPath(f.oldPath, folder()) : undefined) },
        data: { key: `file-${key}` },
      },
      el("span", { className: "ch-path", textContent: shown }),
      el("span", { className: "ch-meta", attrs: { "aria-hidden": "true" } }, el("span", { textContent: W.STATUS_WORDS[f.status] }), f.added || f.removed || f.status !== "renamed" ? el("span", { className: "ch-n", textContent: W.counts(f.added, f.removed) }) : null));
      head.addEventListener("click", () => { if (open.has(f.path)) open.delete(f.path); else open.add(f.path); drawFiles(); });
      const li = el("li", { className: "ch-file" }, head);
      if (isOpen) li.append(fileBody(f.path, key, f.diff, f.truncated, f.oldPath));
      list.append(li);
    }
    redraw(filesHost, list);
  }

  function fileBody(path: string, key: string, text: string, truncated: boolean, oldPath?: string): HTMLElement {
    const shown = shownPath(path, folder());
    const bodyEl = el("div", { className: "ch-file-body", id: `chb-${key}`, attrs: { role: "region", "aria-labelledby": `chf-${key}` } });
    if (oldPath) bodyEl.append(el("p", { className: "hint", textContent: W.renamedFrom(shownPath(oldPath, folder())) }));
    if (truncated) { bodyEl.append(el("p", { className: "hint", textContent: W.DIFF_TRUNCATED })); return bodyEl; }
    const rows = diffRows(text).rows.filter(r => r.kind !== "file");
    if (!rows.some(commentable)) { bodyEl.append(el("p", { className: "hint", textContent: W.DIFF_EMPTY })); return bodyEl; }
    const lines = el("div", { className: "diff-lines ch-lines", tabIndex: 0, attrs: { role: "listbox", "aria-multiselectable": "true", "aria-label": W.diffLinesLabel(shown) }, data: { key: `lines-${key}` } });
    const els: HTMLElement[] = [];
    rows.forEach((r, i) => {
      const sign = r.kind === "add" ? "+" : r.kind === "del" ? "−" : "";
      const ok = commentable(r);
      const row = el("div", {
        className: `d-${r.kind}`, id: `chl-${key}-${i}`,
        attrs: { role: "option", "aria-selected": ok ? "false" : undefined, "aria-disabled": ok ? undefined : "true", "aria-label": ok ? W.lineLabel(r.kind as "add" | "del" | "ctx", r.kind === "del" ? r.oldNo : r.newNo, r.text) : r.text },
        data: { i: String(i) },
      },
      el("span", { className: "d-no", textContent: r.oldNo !== undefined ? String(r.oldNo) : "" }),
      el("span", { className: "d-no", textContent: r.newNo !== undefined ? String(r.newNo) : "" }),
      el("span", { className: "d-sign", textContent: sign }),
      el("span", { className: "d-text", textContent: r.text || " " }));
      els.push(row);
      lines.append(row);
    });
    const footer = el("div", { className: "ch-file-foot" });
    const choosable = rows.map((r, i) => (commentable(r) ? i : -1)).filter(i => i >= 0);
    let active = sel?.file === path ? sel.focus : choosable[0];

    const paint = () => {
      const s = sel?.file === path ? sel : null;
      const lo = s ? Math.min(s.anchor, s.focus) : -1, hi = s ? Math.max(s.anchor, s.focus) : -2;
      els.forEach((row, i) => {
        if (!commentable(rows[i])) return;
        const on = i >= lo && i <= hi;
        row.setAttribute("aria-selected", String(on));
        row.classList.toggle("chosen", on);
        row.classList.toggle("active", i === active);
      });
      lines.setAttribute("aria-activedescendant", `chl-${key}-${active}`);
      drawFoot(footer, path, rows);
    };
    const choose = (i: number, extend: boolean) => {
      active = i;
      sel = extend && sel?.file === path ? { ...sel, focus: i } : { file: path, anchor: i, focus: i };
      if (commenting && commenting.path !== path) commenting = null;
      paint();
      els[i]?.scrollIntoView({ block: "nearest" });
    };
    lines.addEventListener("pointerdown", e => {
      const row = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
      if (!row) return;
      const i = Number(row.dataset.i);
      if (!commentable(rows[i])) return;
      e.preventDefault();
      lines.focus({ preventScroll: true });
      choose(i, e.shiftKey);
    });
    lines.addEventListener("keydown", e => {
      const at = choosable.indexOf(active);
      let next = -1;
      if (e.key === "ArrowDown") next = choosable[Math.min(choosable.length - 1, at + 1)];
      else if (e.key === "ArrowUp") next = choosable[Math.max(0, at - 1)];
      else if (e.key === "Home") next = choosable[0];
      else if (e.key === "End") next = choosable[choosable.length - 1];
      if (next !== undefined && next >= 0) { e.preventDefault(); choose(next, e.shiftKey); return; }
      if (e.key === " " || e.key === "Spacebar") { e.preventDefault(); choose(active, e.shiftKey); return; }
      if (e.key === "Enter" || (e.key.toLowerCase() === "c" && !e.ctrlKey && !e.metaKey && !e.altKey)) {
        e.preventDefault();
        if (!sel || sel.file !== path) choose(active, false);
        startComment(path, rows, footer);
        return;
      }
      if (e.key === "Escape" && sel?.file === path) { e.preventDefault(); e.stopPropagation(); sel = null; commenting = null; paint(); }
    });
    bodyEl.append(lines, footer);
    paint();
    return bodyEl;
  }

  function startComment(path: string, rows: readonly DiffRow[], footer: HTMLElement): void {
    if (!sel || sel.file !== path) return;
    const r = rangeOf(shownPath(path, folder()), rows, sel.anchor, sel.focus);
    if (!r) return;
    commenting = { path, range: r };
    drawFoot(footer, path, rows);
    footer.querySelector<HTMLTextAreaElement>("textarea")?.focus();
  }

  function drawFoot(footer: HTMLElement, path: string, rows: readonly DiffRow[]): void {
    const s = sel?.file === path ? sel : null;
    const range = s ? rangeOf(shownPath(path, folder()), rows, s.anchor, s.focus) : null;
    const form = commenting?.path === path ? commenting.range : null;
    if (!range && !form) { redraw(footer); return; }
    if (!form && range) {
      const b = el("button", { type: "button", className: "btn quiet small", textContent: W.commentOn(linesWords(range)), data: { key: `comment-${idPart(path)}` } });
      b.addEventListener("click", () => startComment(path, rows, footer));
      redraw(footer, b);
      return;
    }
    const c = form!;
    const id = `chc-${idPart(path)}`;
    const k = keep();
    const area = el("textarea", { id, rows: 3, maxLength: COMMENT_MAX, value: k.drafts[`comment:${path}`] ?? "", data: { key: `comment-text-${idPart(path)}` } });
    area.addEventListener("input", () => { k.drafts[`comment:${path}`] = area.value; });
    const problem = el("p", { className: "pt-problem", attrs: { role: "alert" } });
    const add = el("button", { type: "submit", className: "btn quiet small", textContent: W.COMMENT_ADD, data: { key: "comment-add" } });
    const cancel = el("button", { type: "button", className: "btn quiet small", textContent: W.CANCEL, data: { key: "comment-cancel" } });
    const lines = () => filesHost.querySelector<HTMLElement>(`#chb-${CSS.escape(idPart(path))} .ch-lines`);
    cancel.addEventListener("click", () => { commenting = null; drawFoot(footer, path, rows); lines()?.focus(); });
    const f = el("form", { className: "pt-form ch-comment", attrs: { "aria-labelledby": `${id}-t` } },
      el("p", { className: "pt-form-title", id: `${id}-t`, textContent: W.commentFormTitle(c.file, linesWords(c)) }),
      el("pre", { className: "ch-quote", textContent: c.quoted.join("\n"), attrs: { "aria-label": linesWords(c) } }),
      el("label", { htmlFor: id, textContent: W.COMMENT_LABEL }), area, problem, el("div", { className: "pt-actions" }, add, cancel));
    f.addEventListener("submit", e => {
      e.preventDefault();
      if (!area.value.trim()) { problem.textContent = W.COMMENT_EMPTY; area.focus(); return; }
      if (k.review.length >= REVIEW_MAX) { problem.textContent = W.REVIEW_FULL; return; }
      k.review = addComment(k.review, { file: c.file, ...(c.newLines ? { newLines: c.newLines } : {}), ...(c.oldLines ? { oldLines: c.oldLines } : {}), quoted: c.quoted, id: app.key("rc"), text: area.value });
      delete k.drafts[`comment:${path}`];
      commenting = null; sel = null; reviewNote = null;
      drawReview();
      drawFiles();
      lines()?.focus();
    });
    area.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel.click(); } });
    redraw(footer, f);
  }

  // ───── The Review strip ─────
  function drawReview(): void {
    const k = keep();
    const note = reviewNote ? el("p", { className: reviewNote.problem ? "pt-problem" : "pt-note", tabIndex: -1, textContent: reviewNote.text, data: { key: "review-note" } }) : null;
    if (!sid || !k.review.length) { redraw(reviewHost, note); return; }
    const list = el("ol", { className: "ch-review-list" });
    for (const c of k.review) {
      const where = W.commentWhere(c.file, linesWords(c));
      const li = el("li", { className: "ch-rc" }, el("p", { className: "ch-rc-where", textContent: where }),
        el("pre", { className: "ch-quote", textContent: c.quoted.slice(0, 3).join("\n") + (c.quoted.length > 3 ? "\n…" : ""), attrs: { "aria-hidden": "true" } }));
      if (editing === c.id) {
        const id = `rce-${idPart(c.id)}`;
        const area = el("textarea", { id, rows: 3, maxLength: COMMENT_MAX, value: k.drafts[`edit:${c.id}`] ?? c.text, data: { key: `edit-text-${c.id}` } });
        area.addEventListener("input", () => { k.drafts[`edit:${c.id}`] = area.value; });
        const save = el("button", { type: "submit", className: "btn quiet small", textContent: W.COMMENT_SAVE, data: { key: `edit-save-${c.id}` } });
        const cancel = el("button", { type: "button", className: "btn quiet small", textContent: W.CANCEL, data: { key: `edit-cancel-${c.id}` } });
        const f = el("form", { className: "pt-form" }, el("label", { htmlFor: id, textContent: W.COMMENT_LABEL }), area, el("div", { className: "pt-actions" }, save, cancel));
        const done = (focusKey: string) => { editing = null; delete k.drafts[`edit:${c.id}`]; drawReview(); reviewHost.querySelector<HTMLElement>(`[data-key="${CSS.escape(focusKey)}"]`)?.focus(); };
        f.addEventListener("submit", e => { e.preventDefault(); k.review = editComment(k.review, c.id, area.value); done(k.review.some(x => x.id === c.id) ? `edit-${c.id}` : "review-send"); });
        cancel.addEventListener("click", () => done(`edit-${c.id}`));
        area.addEventListener("keydown", e => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); cancel.click(); } });
        li.append(f);
      } else {
        const edit = el("button", { type: "button", className: "btn quiet small", textContent: W.COMMENT_EDIT, attrs: { "aria-label": W.editLabel(c.file, linesWords(c)) }, data: { key: `edit-${c.id}` } });
        const remove = el("button", { type: "button", className: "link-btn danger", textContent: W.COMMENT_REMOVE, attrs: { "aria-label": W.removeLabel(c.file, linesWords(c)) }, data: { key: `remove-${c.id}` } });
        edit.addEventListener("click", () => { editing = c.id; drawReview(); reviewHost.querySelector<HTMLTextAreaElement>("textarea")?.focus(); });
        remove.addEventListener("click", () => {
          const i = k.review.findIndex(x => x.id === c.id);
          k.review = removeComment(k.review, c.id);
          drawReview();
          const next = k.review[Math.min(i, k.review.length - 1)];
          reviewHost.querySelector<HTMLElement>(next ? `[data-key="${CSS.escape(`edit-${next.id}`)}"]` : "[data-key]")?.focus();
          if (!next) filesHost.querySelector<HTMLElement>(".ch-file-head")?.focus();
        });
        li.append(el("p", { className: "ch-rc-text", textContent: c.text }), el("div", { className: "pt-actions" }, edit, remove));
      }
      list.append(li);
    }
    const send = el("button", { type: "button", className: "btn small", textContent: W.REVIEW_SEND, data: { key: "review-send" } });
    send.addEventListener("click", () => { void sendReview(); });
    const strip = el("section", { className: "ch-review", attrs: { "aria-labelledby": "ch-review-h" } },
      el("div", { className: "ch-review-head" }, el("h2", { className: "pt-h", id: "ch-review-h", textContent: W.REVIEW_HEADING }), el("span", { className: "tag quiet", textContent: W.reviewCount(k.review.length) })),
      list, el("p", { className: "hint", textContent: busy() ? W.REVIEW_QUEUED_HINT : W.REVIEW_HINT }),
      note,
      el("div", { className: "pt-actions" }, send));
    redraw(reviewHost, strip);
  }

  async function sendReview(): Promise<void> {
    if (!sid) return;
    const k = keep();
    if (!k.review.length) return;
    const queued = busy();
    const ok = await app.send(sid, reviewPrompt(k.review, valueOf(diff)?.mode ?? mode), [], queued ? "enqueue" : undefined);
    if (ok) { k.review = []; reviewNote = { text: queued ? W.REVIEW_QUEUED : W.REVIEW_SENT, problem: false }; say(reviewNote.text); }
    else reviewNote = { text: W.sendFailed(W.NOT_SENT_WHY), problem: true };
    drawReview();
    reviewHost.querySelector<HTMLElement>(ok ? "[data-key='review-note']" : "[data-key='review-send']")?.focus();
  }

  // ───── Git, through Copilot ─────
  function drawGit(): void {
    const k = keep();
    const commit = el("button", { type: "button", className: "btn quiet small", textContent: W.COMMIT, attrs: { "aria-expanded": String(gitForm === "commit"), "aria-describedby": "ch-git-hint" }, data: { key: "git-commit" } });
    const push = el("button", { type: "button", className: "btn quiet small", textContent: W.PUSH, attrs: { "aria-describedby": "ch-git-hint" }, data: { key: "git-push" } });
    const pr = el("button", { type: "button", className: "btn quiet small", textContent: W.PULL_REQUEST, attrs: { "aria-expanded": String(gitForm === "pr"), "aria-describedby": "ch-git-hint" }, data: { key: "git-pr" } });
    commit.addEventListener("click", () => { gitForm = gitForm === "commit" ? null : "commit"; drawGit(); gitHost.querySelector<HTMLElement>(gitForm ? "#ch-commit-msg" : "[data-key='git-commit']")?.focus(); });
    pr.addEventListener("click", () => { gitForm = gitForm === "pr" ? null : "pr"; drawGit(); gitHost.querySelector<HTMLElement>(gitForm ? "#ch-pr-title" : "[data-key='git-pr']")?.focus(); });
    push.addEventListener("click", () => { void sendGit(PUSH_PROMPT, "git-push"); });
    let form: HTMLElement | null = null;
    const cancelBtn = (back: string) => {
      const b = el("button", { type: "button", className: "btn quiet small", textContent: W.CANCEL, data: { key: "git-cancel" } });
      b.addEventListener("click", () => { gitForm = null; drawGit(); gitHost.querySelector<HTMLElement>(`[data-key='${back}']`)?.focus(); });
      return b;
    };
    if (gitForm === "commit") {
      const msg = el("textarea", { id: "ch-commit-msg", rows: 3, maxLength: 2_000, value: k.drafts.commit ?? "", attrs: { "aria-describedby": "ch-commit-hint" }, data: { key: "commit-msg" } });
      msg.addEventListener("input", () => { k.drafts.commit = msg.value; });
      const go = el("button", { type: "submit", className: "btn quiet small", textContent: W.COMMIT_SEND, data: { key: "commit-send" } });
      form = el("form", { className: "pt-form" }, el("label", { htmlFor: msg.id, textContent: W.COMMIT_MESSAGE }), msg,
        el("p", { className: "hint", id: "ch-commit-hint", textContent: W.COMMIT_MESSAGE_HINT }), el("div", { className: "pt-actions" }, go, cancelBtn("git-commit")));
      form.addEventListener("submit", e => { e.preventDefault(); void sendGit(commitPrompt(msg.value), "git-commit", () => { delete k.drafts.commit; }); });
    } else if (gitForm === "pr") {
      const title = el("input", { type: "text", id: "ch-pr-title", maxLength: 200, value: k.drafts.prTitle ?? "", data: { key: "pr-title" } });
      const notes = el("textarea", { id: "ch-pr-notes", rows: 3, maxLength: 4_000, value: k.drafts.prNotes ?? "", data: { key: "pr-notes" } });
      title.addEventListener("input", () => { k.drafts.prTitle = title.value; });
      notes.addEventListener("input", () => { k.drafts.prNotes = notes.value; });
      const go = el("button", { type: "submit", className: "btn quiet small", textContent: W.PR_SEND, data: { key: "pr-send" } });
      form = el("form", { className: "pt-form" }, el("label", { htmlFor: title.id, textContent: W.PR_TITLE }), title, el("label", { htmlFor: notes.id, textContent: W.PR_NOTES }), notes,
        el("div", { className: "pt-actions" }, go, cancelBtn("git-pr")));
      form.addEventListener("submit", e => { e.preventDefault(); void sendGit(pullRequestPrompt(title.value, notes.value), "git-pr", () => { delete k.drafts.prTitle; delete k.drafts.prNotes; }); });
    }
    redraw(gitHost, el("p", { className: "hint", id: "ch-git-hint", textContent: W.GIT_HINT }), el("div", { className: "pt-actions" }, commit, push, pr), form,
      gitNote ? el("p", { className: "pt-note", textContent: gitNote }) : null);
  }

  async function sendGit(prompt: string, back: string, sent?: () => void): Promise<void> {
    if (!sid) return;
    const queued = busy();
    const ok = await app.send(sid, prompt, [], queued ? "enqueue" : undefined);
    if (ok) { sent?.(); gitForm = null; gitNote = queued ? W.GIT_QUEUED : W.GIT_SENT; say(gitNote); }
    else gitNote = W.gitFailed(W.NOT_SENT_WHY);
    drawGit();
    gitHost.querySelector<HTMLElement>(`[data-key='${back}']`)?.focus();
  }

  // ───── Rewind ─────
  function drawRewind(): void {
    const v = valueOf(points);
    const parts: (HTMLElement | null)[] = [el("p", { className: "hint", textContent: W.REWIND_HINT })];
    if (points.state === "failed") parts.push(el("p", { className: "pt-problem", textContent: W.readFailed("rewind", points.reason) }));
    if (v?.unavailable) parts.push(el("p", { className: "pt-note", textContent: W.unavailableRewind(v.unavailable) }));
    else if (v && !v.tracking && v.points.length) parts.push(el("p", { className: "pt-note", textContent: W.unavailableWords("file-change-tracking-disabled") }));
    if (rewindNote) parts.push(el("p", { className: "pt-note", tabIndex: -1, textContent: rewindNote, data: { key: "rewind-note" } }));
    if (v && !v.points.length && !v.unavailable) parts.push(el("p", { className: "pt-empty", textContent: W.REWIND_NONE }));
    if (v?.points.length) {
      const list = el("ol", { className: "rw-list" });
      for (const p of v.points) {
        const when = W.pointTime(p.at);
        const go = el("button", { type: "button", className: "btn quiet small rw-go", textContent: W.REWIND_TO, attrs: { "aria-label": W.rewindToLabel(when, p.message), "aria-expanded": String(rewindAt?.point.eventId === p.eventId) }, data: { key: `rw-${p.eventId}` } });
        go.addEventListener("click", () => { void openRewind(p); });
        const li = el("li", { className: "rw-point" },
          el("p", { className: "rw-when", textContent: when }),
          el("p", { className: "rw-msg", textContent: p.message || "…" }),
          el("p", { className: "rw-changes", textContent: [W.pointChanges(p.fileCount, p.added, p.removed), p.autopilot ? W.POINT_AUTOPILOT : ""].filter(Boolean).join(" · ") }),
          go);
        if (rewindAt?.point.eventId === p.eventId) li.append(rewindConfirm());
        list.append(li);
      }
      parts.push(list);
    }
    redraw(rewindHost, ...parts);
  }

  async function openRewind(p: RewindPoint): Promise<void> {
    if (rewindAt?.point.eventId === p.eventId) { rewindAt = null; drawRewind(); rewindHost.querySelector<HTMLElement>(`[data-key="${CSS.escape(`rw-${p.eventId}`)}"]`)?.focus(); return; }
    rewindNote = "";
    rewindAt = { point: p, preview: { state: "loading" }, choice: "conversation", running: false };
    drawRewind();
    rewindHost.querySelector<HTMLElement>(".rw-confirm")?.focus();
    const at = sid;
    const r = await call("history.previewRewind", { eventId: p.eventId });
    if (!rewindAt || rewindAt.point.eventId !== p.eventId || at !== sid) return;
    const pv = r.ok ? previewFrom(r.value) : null;
    rewindAt.preview = pv ? { state: "ok", value: pv } : { state: "failed", reason: r.ok ? "" : reasonOf(r) };
    drawRewind();
  }

  function rewindConfirm(): HTMLElement {
    const at = rewindAt!;
    const pv = valueOf(at.preview);
    const canFiles = at.point.canRestoreFiles && !!pv?.available;
    if (!canFiles && at.choice === "conversation-and-files") at.choice = "conversation";
    const box = el("div", { className: "rw-confirm", tabIndex: -1, attrs: { role: "group", "aria-label": W.rewindToLabel(W.pointTime(at.point.at), at.point.message) } });
    if (at.preview.state === "loading") box.append(el("p", { className: "hint", textContent: W.PREVIEWING }));
    else if (at.preview.state === "failed") box.append(el("p", { className: "pt-problem", textContent: W.previewFailed(at.preview.reason) }));
    else if (pv && pv.available) {
      box.append(el("p", { className: "rw-sub", textContent: W.previewFiles(pv.files.length) }));
      if (pv.files.length) box.append(el("ul", { className: "rw-files" }, ...pv.files.map(f => el("li", {}, el("span", { className: "rw-path", textContent: shownPath(f.path, folder()) }), el("span", { className: "rw-what", textContent: `${W.CHANGE_WORDS[f.change]}, ${W.counts(f.added, f.removed)}` })))));
    } else if (pv) box.append(el("p", { className: "pt-note", textContent: pv.reason === "session-busy" ? W.REWIND_BUSY : W.NO_FILE_RESTORE }));
    const group = el("fieldset", { className: "rw-modes" }, el("legend", { textContent: W.MODE_CHOICE }));
    for (const m of ["conversation", "conversation-and-files"] as RewindMode[]) {
      const id = `rw-mode-${m}`;
      const disabled = m === "conversation-and-files" && !canFiles;
      const r = el("input", { type: "radio", name: "rw-mode", id, value: m, checked: at.choice === m, disabled: disabled || at.running, attrs: { "aria-describedby": `${id}-hint` }, data: { key: id } });
      r.addEventListener("change", () => { if (r.checked && rewindAt) rewindAt.choice = m; });
      group.append(el("div", { className: "rw-mode" }, r, el("label", { htmlFor: id, textContent: W.REWIND_MODES[m] }),
        el("p", { className: "hint", id: `${id}-hint`, textContent: disabled && at.preview.state !== "loading" ? W.NO_FILE_RESTORE : W.REWIND_MODE_HINTS[m] })));
    }
    box.append(group, el("p", { className: "rw-warn", textContent: W.COMMANDS_NOT_UNDONE }));
    const nowBusy = busy();
    if (nowBusy) box.append(el("p", { className: "pt-note", id: "rw-busy", textContent: W.REWIND_BUSY }));
    if (at.running) box.append(el("p", { className: "hint", textContent: W.REWINDING }));
    const go = el("button", { type: "button", className: "btn quiet small", textContent: W.REWIND_CONFIRM, disabled: nowBusy || at.running || at.preview.state === "loading", attrs: { "aria-describedby": nowBusy ? "rw-busy" : undefined }, data: { key: "rw-confirm" } });
    const cancel = el("button", { type: "button", className: "btn quiet small", textContent: W.CANCEL, disabled: at.running, data: { key: "rw-cancel" } });
    go.addEventListener("click", () => { void doRewind(); });
    cancel.addEventListener("click", () => { const id = at.point.eventId; rewindAt = null; drawRewind(); rewindHost.querySelector<HTMLElement>(`[data-key="${CSS.escape(`rw-${id}`)}"]`)?.focus(); });
    box.append(el("div", { className: "pt-actions" }, go, cancel));
    box.addEventListener("keydown", e => { if (e.key === "Escape" && !at.running) { e.preventDefault(); e.stopPropagation(); cancel.click(); } });
    return box;
  }

  async function doRewind(): Promise<void> {
    const at = rewindAt;
    if (!sid || !at || at.running) return;
    if (busy()) { drawRewind(); return; }
    at.running = true;
    drawRewind();
    const id = sid;
    const r = await call("history.rewind", { eventId: at.point.eventId, mode: at.choice });
    if (id !== sid) return;
    at.running = false;
    if (!r.ok) { rewindNote = W.rewindFailed(reasonOf(r)); drawRewind(); return; }
    const done = rewindResultFrom(r.value);
    rewindNote = W.rewindDone(done);
    rewindAt = null;
    say(rewindNote);
    // The conversation was cut: the window attaches again and draws the kept history afresh (the store does it on
    // `session.snapshot_rewind` too; this covers the event being slow or not sent).
    if (historyChanged(done)) app.set(s => wantRebuild(s, id));
    drawRewind();
    rewindHost.querySelector<HTMLElement>("[data-key='rewind-note']")?.focus();
    void readPoints();
    void readDiff();
  }

  // ───── Showing a session ─────
  function drawAll(): void {
    none.hidden = !!sid;
    body.hidden = !sid;
    if (!sid) { none.textContent = PANEL_NO_SESSION; return; }
    modes.set(mode);
    ws.checked = ignoreWs;
    drawSummary(); drawReview(); drawFiles(); drawGit(); drawRewind();
  }

  return {
    show(sessionId) {
      justShown = true;
      if (sessionId !== sid) {
        sid = sessionId;
        busyTries = 0;
        diff = { state: "idle" }; points = { state: "idle" };
        open.clear(); sel = null; commenting = null; editing = null; gitForm = null; gitNote = ""; reviewNote = null; rewindAt = null; rewindNote = "";
        fileSettle.cancel();
      }
      wasBusy = !!sid && busy();
      dirty = false;
      drawAll();
      if (sid) { void readDiff(); void readPoints(); }
    },
    render(s: CodeState, prev: CodeState | null) {
      if (!sid) return;
      const nowBusy = busyIn(s, sid);
      // Opened again after it was closed (the show() of this same draw already read everything).
      const reopened = !justShown && !!prev && !prev.ui.panelOpen && s.ui.panelOpen;
      justShown = false;
      if ((wasBusy && !nowBusy) || dirty || reopened) {
        dirty = false;
        void readDiff(); void readPoints();
      }
      if (nowBusy !== wasBusy) { wasBusy = nowBusy; drawReview(); if (rewindAt) drawRewind(); }
    },
    dispose() { stopWatching(); fileSettle.cancel(); if (busyRetry) clearTimeout(busyRetry); busyRetry = null; },
  };
}
