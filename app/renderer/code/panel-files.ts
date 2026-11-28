/**
 * The panel's Files tab (docs/CODING-APP.md §4): the session's files as a tree the keyboard walks (role="tree", arrow
 * keys, type-ahead), a filter, a read-only viewer for a text file (bounded, monospace, with line numbers, a binary file
 * named and never shown) and "Attach to message", which hands the file to the composer as its picker's results are.
 *
 * What it lists is what main and the SDK list (files-model.ts says why there are two roots): the working folder as
 * main lists it (`listFolder`, a folder at a time as it opens: the top at once, and the folders that hold changes), with
 * `workspaces.diff`'s changes and the paths the session's tools touched marked; and `workspaces.listFiles` for
 * Copilot's own session files. It reads a working-folder file through main (`readFile`: its text, or that it is binary
 * or too large) and a session file through `workspaces.readFile` (`statFile` needs the runtime's "session memory v2",
 * which is off: probed on runtime 1.0.97). The window reads no folder itself. Every string goes in as text, never markup.
 */
import { CODE_LIMITS, type CodeAttachment, type CodeFolderEntry, type CodeSessionRow } from "../../shared/code";
import type { CodeApp } from "./app";
import { PANEL_NO_SESSION, pathTail } from "./copy";
import {
  ATTACH_FILE, BINARY_FILE, CANT_READ, DELETED_FILE, EMPTY_FILE, FILES_LIST_FAILED, FILES_TREE_LABEL, FILTER_LABEL, FILTER_PLACEHOLDER,
  FOLDER_SCOPE, LOADING_FILES, NO_SELECTION, READING_FILE, REFRESH_FILES, SESSION_FILES, SESSION_NOT_ATTACHABLE, TOO_BIG, VIEWER_LABEL,
  attachLabel, attached, changeWords, fileFacts, folderCut, folderRoot, rootEmpty, rowLabel, sizeWords,
} from "./copy-files";
import { button, el, idPart, setText } from "./dom";
import {
  buildTree, diffFiles, fileView, filterTree, fromGitRoot, mergeFiles, rootId, seenFiles, treeKey, typeAhead, visibleRows,
  workspaceFiles, type DiffFile, type FileRoot, type KnownFile, type TreeNode, type TreeRow,
} from "./files-model";
import { registerPanelTab, type PanelContext } from "./panel";
import { ATTACH_EVENT } from "./attach-event";
import { str } from "./sdk";
import type { CodeState } from "./store";

/** Waits before listing again after the session's tools changed files. */
const RELIST_MS = 600;
/** A folder main listed: its entries, and whether it had more than it lists. */
interface Listed { entries: CodeFolderEntry[]; truncated: boolean }


registerPanelTab({ id: "files", label: "Files", mount });

function mount(host: HTMLElement, ctx: PanelContext) {
  const app: CodeApp = ctx.app;
  const filter = el("input", { type: "search", id: "pf-filter", className: "pf-filter", placeholder: FILTER_PLACEHOLDER, autocomplete: "off", spellcheck: false });
  const refresh = button(REFRESH_FILES, { className: "pf-refresh" });
  const note = el("p", { className: "pf-note", attrs: { role: "status" } });
  const tree = el("ul", { className: "pf-tree", attrs: { role: "tree", "aria-label": FILES_TREE_LABEL } });
  const scope = el("p", { className: "hint pf-scope", textContent: FOLDER_SCOPE });
  const vName = el("p", { className: "pf-vname" });
  const vFacts = el("p", { className: "pf-vfacts" });
  const attach = button(ATTACH_FILE, { className: "pf-attach" });
  const vWords = el("p", { className: "pf-vwords" });
  const nos = el("pre", { className: "pf-nos", attrs: { "aria-hidden": "true" } });
  const text = el("pre", { className: "pf-text" });
  const lines = el("div", { className: "pf-lines", tabIndex: 0, attrs: { role: "region", "aria-label": VIEWER_LABEL } }, nos, text);
  const none = el("p", { className: "panel-empty" });
  const viewer = el("section", { className: "pf-viewer", attrs: { "aria-label": VIEWER_LABEL } },
    el("div", { className: "pf-vhead" }, el("div", { className: "pf-vtitle" }, vName, vFacts), attach), vWords, lines);
  host.replaceChildren(el("div", { className: "pf" },
    el("div", { className: "pf-bar" }, el("label", { className: "sr", htmlFor: "pf-filter", textContent: FILTER_LABEL }), filter, refresh),
    note, tree, scope, viewer), none);

  let sessionId: string | null = null;
  let listed: { folder: DiffFile[]; session: string[] } = { folder: [], session: [] };
  /** The working folder's folders main listed, by their path ("" for the top). */
  let dirs = new Map<string, Listed>();
  /** The session's folder below its repository's top (main's `gitPrefix`), for `workspaces.diff`'s paths. */
  let gitPrefix: string | undefined;
  let loading = false, failed = false, opened = false;
  const open = new Set<string>([rootId("folder"), rootId("session")]);
  let focused = rootId("folder");
  let selected: { root: FileRoot; path: string; name: string } | null = null;
  let rows: TreeRow[] = [];
  let sig = "";
  let gen = 0;
  let relist = 0;

  const row = (): CodeSessionRow | null => (sessionId ? app.state.sessions.byId[sessionId] ?? null : null);
  /** The working folder the SDK's paths are relative to: the session's own, as the SDK last said it, else main's. */
  const folderOf = (s: CodeState): string => (sessionId ? s.transcripts[sessionId]?.context?.cwd ?? s.sessions.byId[sessionId]?.folder ?? "" : "");

  /** Lists folder `rel` of the working folder through main; false where it couldn't. */
  async function listDir(id: string, rel: string): Promise<boolean> {
    const r = await app.listFolder(id, rel);
    if (id !== sessionId) return false;
    if (!r.ok) { dirs.delete(rel); return false; }
    dirs.set(rel, { entries: r.value.entries, truncated: r.value.truncated === true });
    if (r.value.gitPrefix !== undefined) gitPrefix = r.value.gitPrefix;
    return true;
  }

  async function list(): Promise<void> {
    const id = sessionId;
    if (!id) return;
    const mine = ++gen;
    loading = true;
    draw(app.state);
    // The top first: its answer says where the session's folder is in its repository, which the diff's paths need.
    const again = [...dirs.keys()].filter(d => d);
    const [top, diff, ws] = await Promise.all([
      listDir(id, ""),
      app.rpc({ scope: "session", sessionId: id, method: "workspaces.diff", params: { mode: "unstaged" } }),
      app.rpc({ scope: "session", sessionId: id, method: "workspaces.listFiles" }),
    ]);
    await Promise.all(again.map(d => listDir(id, d)));
    if (mine !== gen || id !== sessionId) return;
    loading = false;
    failed = !top && !diff.ok && !ws.ok;
    listed = {
      folder: diff.ok ? diffFiles(diff.value).flatMap(f => { const path = fromGitRoot(f.path, gitPrefix); return path ? [{ ...f, path }] : []; }) : [],
      session: ws.ok ? workspaceFiles(ws.value) : [],
    };
    // The first listing opens (and lists) the folders that hold changes, so what the session changed shows at once.
    if (!opened) {
      opened = true;
      const holding = new Set<string>();
      for (const f of listed.folder) { const parts = f.path.split("/"); for (let i = 1; i < parts.length; i++) holding.add(parts.slice(0, i).join("/")); }
      for (const d of holding) open.add(`folder:${d}/`);
      await Promise.all([...holding].filter(d => !dirs.has(d)).map(d => listDir(id, d)));
      if (mine !== gen || id !== sessionId) return;
    }
    draw(app.state);
  }

  function files(s: CodeState): KnownFile[] {
    const t = sessionId ? s.transcripts[sessionId] : undefined;
    const changedHere = Object.keys(t?.workspaceFiles ?? {}).map(path => ({ root: "session" as const, path, change: "edited" as const }));
    const inFolders: KnownFile[] = [];
    for (const [rel, d] of dirs) for (const e of d.entries) inFolders.push({ root: "folder", path: rel ? `${rel}/${e.name}` : e.name, ...(e.kind === "folder" ? { dir: true } : {}) });
    return mergeFiles(
      inFolders,
      seenFiles(t, folderOf(s)),
      listed.folder.map(f => ({ root: "folder" as const, path: f.path, change: f.change })),
      listed.session.map(path => ({ root: "session" as const, path })),
      changedHere,
    );
  }

  /** The entry main listed for a working-folder file, with its absolute path (for an attachment). */
  function entryOf(rel: string): CodeFolderEntry | undefined {
    const at = rel.lastIndexOf("/");
    return dirs.get(at < 0 ? "" : rel.slice(0, at))?.entries.find(e => e.name === (at < 0 ? rel : rel.slice(at + 1)));
  }

  function draw(s: CodeState): void {
    const r = row();
    const all = buildTree(files(s), { folder: folderRoot(r ? pathTail(r.folder) : ""), session: SESSION_FILES });
    const q = filter.value;
    const shown = filterTree(all, q);
    const openNow = new Set([...open, ...shown.open]);
    rows = visibleRows(shown.tree, openNow);
    if (!rows.some(x => x.node.id === focused)) focused = rows[0]?.node.id ?? rootId("folder");
    setText(note, loading && !rows.some(x => !x.node.dir) ? LOADING_FILES : failed ? FILES_LIST_FAILED : "");
    const items: HTMLElement[] = [];
    for (const x of rows) {
      items.push(treeItem(x));
      // An open root with nothing under it says so (as a row of its own, not a tree item).
      if (x.level === 1 && x.expanded && !x.node.children.length) items.push(el("li", { className: "pf-none", attrs: { role: "none" }, textContent: rootEmpty(x.node.root, q) }));
      // A folder with more entries than main lists says so after them.
      const rel = x.node.root === "folder" && x.node.dir ? x.node.path : null;
      if (rel !== null && x.expanded && dirs.get(rel)?.truncated) items.push(el("li", { className: "pf-none", attrs: { role: "none" }, textContent: folderCut(CODE_LIMITS.folderEntries) }));
    }
    const hadFocus = tree.contains(document.activeElement);
    tree.replaceChildren(...items);
    if (hadFocus) tree.querySelector<HTMLElement>("[tabindex='0']")?.focus({ preventScroll: true });
  }

  function treeItem(x: TreeRow): HTMLElement {
    const n = x.node;
    const isSel = !!selected && !n.dir && selected.root === n.root && selected.path === n.path;
    const li = el("li", {
      id: `pf-${idPart(n.id)}`, className: `pf-row${n.dir ? " dir" : " file"}${x.level === 1 ? " root" : ""}`, tabIndex: n.id === focused ? 0 : -1,
      attrs: {
        role: "treeitem", "aria-level": String(x.level), "aria-setsize": String(x.setSize), "aria-posinset": String(x.posInSet),
        "aria-selected": String(isSel), "aria-label": rowLabel(n.name, n.change, n.dir), ...(n.dir ? { "aria-expanded": String(x.expanded) } : {}),
      },
      data: { node: n.id, ...(n.change ? { change: n.change } : {}) },
    },
    el("span", { className: "pf-twist", attrs: { "aria-hidden": "true" } }),
    el("span", { className: "pf-icon", attrs: { "aria-hidden": "true" } }),
    el("span", { className: "pf-name", textContent: n.name }),
    n.change ? el("span", { className: "pf-mark", attrs: { "aria-hidden": "true" }, title: n.dir ? "" : changeWords(n.change) }) : null);
    li.style.setProperty("--level", String(x.level - 1));
    return li;
  }

  const nodeOf = (id: string): TreeNode | undefined => rows.find(r => r.node.id === id)?.node;

  function activate(id: string): void {
    const n = nodeOf(id);
    if (!n) return;
    focused = id;
    if (n.dir) {
      if (open.has(id)) open.delete(id); else { open.add(id); listOpened(n); }
      draw(app.state);
      return;
    }
    selected = { root: n.root, path: n.path, name: n.name };
    draw(app.state);
    void read(n);
  }

  /** A working-folder folder opened for the first time: main lists it, and the tree draws again. */
  function listOpened(n: TreeNode): void {
    const id = sessionId;
    if (!id || n.root !== "folder" || !n.dir || n.path === "" || dirs.has(n.path)) return;
    void listDir(id, n.path).then(ok => { if (id === sessionId) { if (!ok) setText(note, FILES_LIST_FAILED); draw(app.state); } });
  }

  tree.addEventListener("click", e => {
    const li = (e.target as HTMLElement).closest<HTMLElement>(".pf-row");
    if (li?.dataset.node) { activate(li.dataset.node); tree.querySelector<HTMLElement>(`[data-node="${CSS.escape(li.dataset.node)}"]`)?.focus(); }
  });
  tree.addEventListener("keydown", e => {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); activate(focused); tree.querySelector<HTMLElement>("[tabindex='0']")?.focus(); return; }
    let move = treeKey(rows, focused, e.key);
    if (!move && e.key.length === 1 && /\S/.test(e.key)) { const to = typeAhead(rows, focused, e.key); move = to ? { focus: to } : null; }
    if (!move) return;
    e.preventDefault();
    focused = move.focus;
    if (move.toggle) {
      if (move.toggle.open) { open.add(move.toggle.id); const n = nodeOf(move.toggle.id); if (n) listOpened(n); } else open.delete(move.toggle.id);
    }
    draw(app.state);
    tree.querySelector<HTMLElement>("[tabindex='0']")?.focus();
    tree.querySelector<HTMLElement>("[tabindex='0']")?.scrollIntoView({ block: "nearest" });
  });

  filter.addEventListener("input", () => { draw(app.state); });
  filter.addEventListener("keydown", e => {
    if (e.key === "ArrowDown") { e.preventDefault(); const first = rows.find(r => !r.node.dir) ?? rows[0]; if (first) { focused = first.node.id; draw(app.state); tree.querySelector<HTMLElement>("[tabindex='0']")?.focus(); } }
    if (e.key === "Escape" && filter.value) { e.preventDefault(); e.stopPropagation(); filter.value = ""; draw(app.state); }
  });
  refresh.addEventListener("click", () => { void list(); });

  // ───── The viewer ─────
  let reading = 0;
  function showWords(words: string, facts = ""): void {
    setText(vWords, words);
    setText(vFacts, facts);
    nos.textContent = "";
    text.textContent = "";
    lines.hidden = true;
  }
  function showText(path: string, body: string, cut: boolean, size?: number): void {
    const v = fileView(path, body, cut);
    if (v.kind === "binary") return showWords(BINARY_FILE, size !== undefined ? sizeWords(size) : "");
    if (v.kind === "empty") return showWords(EMPTY_FILE);
    setText(vWords, "");
    setText(vFacts, fileFacts(v.lines.length, v.cut, size));
    nos.textContent = v.lines.map((_l, i) => String(i + 1)).join("\n");
    text.textContent = v.lines.join("\n");
    lines.hidden = false;
    lines.scrollTop = 0;
  }
  function drawViewerHead(): void {
    viewer.hidden = false;
    if (!selected) { setText(vName, ""); attach.hidden = true; showWords(NO_SELECTION); return; }
    setText(vName, selected.path);
    attach.hidden = false;
    attach.disabled = selected.root !== "folder";
    attach.title = selected.root === "folder" ? "" : SESSION_NOT_ATTACHABLE;
    attach.setAttribute("aria-label", attachLabel(selected.name));
    if (selected.root !== "folder") attach.setAttribute("aria-description", SESSION_NOT_ATTACHABLE); else attach.removeAttribute("aria-description");
  }

  async function read(n: TreeNode): Promise<void> {
    const id = sessionId;
    if (!id) return;
    const mine = ++reading;
    drawViewerHead();
    showWords(READING_FILE);
    if (n.root === "session") {
      const r = await app.rpc({ scope: "session", sessionId: id, method: "workspaces.readFile", params: { path: n.path } });
      if (mine !== reading) return;
      const body = r.ok ? str(r.value, "content", true) : undefined;
      if (body === undefined) return showWords(CANT_READ);
      return showText(n.path, body, false);
    }
    const known = listed.folder.find(f => f.path === n.path);
    if (known?.change === "deleted") return showWords(DELETED_FILE);
    const r = await app.readFile(id, n.path);
    if (mine !== reading) return;
    if (!r.ok) return showWords(r.reason || CANT_READ);
    const v = r.value;
    if ("tooLarge" in v) return showWords(TOO_BIG(v.size));
    if ("binary" in v) return showWords(BINARY_FILE, sizeWords(v.size));
    showText(n.path, v.text, false, v.size);
  }

  attach.addEventListener("click", () => {
    const r = row();
    if (!selected || selected.root !== "folder" || !r || !sessionId) return;
    // The path main listed (attachments pass main's check only for paths it offered or in the session's folder).
    const listedEntry = entryOf(selected.path);
    if (!listedEntry) { setText(note, CANT_READ); return; }
    const a: CodeAttachment = { type: "file", path: listedEntry.path, displayName: selected.name };
    document.dispatchEvent(new CustomEvent(ATTACH_EVENT, { detail: { sessionId, attachments: [a] } }));
    setText(note, attached(selected.name));
  });

  /** What in the transcript means the lists may have changed: the files tools touched, and the workspace's own changes. */
  const signal = (s: CodeState): string => {
    const t = sessionId ? s.transcripts[sessionId] : undefined;
    if (!t) return "";
    let edits = 0;
    for (const i of t.items) if (i.kind === "tool") edits += i.fileEdits.length + (i.state === "running" ? 0 : 1);
    return `${edits}|${Object.keys(t.workspaceFiles ?? {}).length}`;
  };

  return {
    show(id: string | null) {
      if (id === sessionId) return;
      sessionId = id;
      gen++; reading++;
      listed = { folder: [], session: [] };
      dirs = new Map(); gitPrefix = undefined;
      selected = null; failed = false; opened = false;
      filter.value = "";
      focused = rootId("folder");
      sig = signal(app.state);
      const on = !!id;
      for (const n of [filter, refresh, tree, scope, viewer] as HTMLElement[]) n.hidden = !on;
      none.hidden = on;
      setText(none, on ? "" : PANEL_NO_SESSION);
      if (!on) { setText(note, ""); return; }
      drawViewerHead();
      void list();
    },
    render(s: CodeState, prev: CodeState | null) {
      if (!sessionId) return;
      const next = signal(s);
      if (next !== sig) {
        sig = next;
        clearTimeout(relist);
        relist = window.setTimeout(() => { void list(); }, RELIST_MS);
        draw(s);
      } else if (prev && prev.sessions.byId[sessionId] !== s.sessions.byId[sessionId]) draw(s);
    },
    dispose() { clearTimeout(relist); gen++; reading++; },
  };
}

