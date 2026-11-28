/**
 * The Files tab's model, as pure functions: which files the window knows of, in a tree the keyboard walks, and what a
 * file's text looks like in the viewer. No DOM and no IPC: panel-files.ts draws it, test/unit/code-files.test.ts tests it.
 *
 * The constraint behind it: the window never lists or reads a folder itself. The SDK has no method that lists the
 * session's working folder (`workspaces.listFiles` and `readFile` cover only the session's own workspace folder, its
 * plans and pasted files in Copilot's state folder: probed on runtime 1.0.97), so main lists it, a folder at a time as
 * the tree opens (CODE_IPC.listFolder). The tree has two roots: the working folder, as main lists it, with the files
 * `workspaces.diff` says changed (whose paths are the repository's top's: `fromGitRoot`) and the paths the session's
 * tools touched marked, and the session's own files. Every path here came from main or the SDK; nothing is made up,
 * and a path for an attachment is main's own.
 */
import type { Transcript } from "./transcript";
import { arr, bool, rec, str, sub } from "./sdk";

/** Which root a file is under: the session's working folder, or the session's own workspace folder. */
export type FileRoot = "folder" | "session";
/** How the session changed a file, as the SDK names it (`workspaces.diff`'s change types, a tool's file edits, or the workspace's events). */
export type FileChange = "added" | "modified" | "deleted" | "renamed" | "edited";

/** One file (or, with `dir`, a folder) the window knows of. `path` is relative to its root, with "/" between its parts. */
export interface KnownFile { root: FileRoot; path: string; change?: FileChange; dir?: boolean }

/**
 * A `workspaces.diff` path (relative to the repository's top) as a path in the session's folder, which is `prefix`
 * below the top (main's `gitPrefix`: "" at the top, "sub/" below it); null for a file outside the session's folder.
 * Without a prefix (not known yet) the path is taken as it is.
 */
export function fromGitRoot(path: string, prefix: string | undefined): string | null {
  const p = normalise(path);
  if (!prefix) return p || null;
  const pre = normalise(prefix);
  if (!pre) return p || null;
  return p.startsWith(`${pre}/`) ? p.slice(pre.length + 1) : null;
}

/** A node of the tree: a folder (with its children) or a file. `id` is unique across both roots. */
export interface TreeNode { id: string; root: FileRoot; name: string; path: string; dir: boolean; change?: FileChange; children: TreeNode[] }

/** A row of the tree as drawn: the node, its depth (1 for a root) and its place among its siblings (for aria). */
export interface TreeRow { node: TreeNode; level: number; setSize: number; posInSet: number; parent: string | null; expanded: boolean }

/** The most characters the viewer shows, and the most lines. */
export const VIEW_CHARS = 400_000;
export const VIEW_LINES = 5_000;

const ROOT_ID: Readonly<Record<FileRoot, string>> = { folder: "root:folder", session: "root:session" };
export const rootId = (root: FileRoot): string => ROOT_ID[root];
export const fileId = (root: FileRoot, path: string): string => `${root}:${path}`;

/** A path with "/" between its parts, no "./", no empty parts and no trailing "/". */
export function normalise(p: string): string {
  return p.replace(/\\/g, "/").split("/").filter(x => x && x !== ".").join("/");
}

/** Whether a folder path is written the Windows way (a drive letter, or backslashes only), so it compares case-blind. */
const windowsish = (folder: string) => /^[A-Za-z]:[\\/]/.test(folder) || (folder.includes("\\") && !folder.includes("/"));

/**
 * `abs` relative to `folder` when it lies inside it (null otherwise, or for a path with ".." in it). Both come from main
 * or the SDK; this only tells whether one is under the other.
 */
export function relativeTo(folder: string, abs: string): string | null {
  if (!folder || !abs) return null;
  const f = folder.replace(/\\/g, "/").replace(/\/+$/, "");
  const a = abs.replace(/\\/g, "/");
  if (a.split("/").includes("..")) return null;
  const blind = windowsish(folder);
  const fa = blind ? f.toLowerCase() : f, aa = blind ? a.toLowerCase() : a;
  if (!aa.startsWith(`${fa}/`)) return null;
  const rel = normalise(a.slice(f.length + 1));
  return rel || null;
}

/** A path under `folder` for an attachment, written with the folder's own separator. */
export function joinPath(folder: string, rel: string): string {
  const sep = folder.includes("\\") && !folder.includes("/") ? "\\" : "/";
  return `${folder.replace(/[\\/]+$/, "")}${sep}${normalise(rel).split("/").join(sep)}`;
}

/** Whether a path names a file (relative, with no ".." and no drive or root). */
export function plainRelative(p: string): boolean {
  return !!p && !/^([A-Za-z]:)?[\\/]/.test(p) && !p.replace(/\\/g, "/").split("/").includes("..");
}

const CHANGE_TYPES = new Set(["added", "modified", "deleted", "renamed"]);

/** One changed file of `workspaces.diff`, read. */
export interface DiffFile { path: string; change: FileChange; oldPath?: string; after?: string; cut: boolean }

/** `workspaces.diff`'s changes (a file outside the folder, by a "../" or an absolute path, is left out). */
export function diffFiles(result: unknown): DiffFile[] {
  return arr(result, "changes").flatMap(c => {
    const path = str(c, "path");
    if (!path || !plainRelative(path)) return [];
    const type = str(c, "changeType") ?? "modified";
    const contents = sub(c, "contents");
    const after = typeof contents?.after === "string" ? contents.after : undefined;
    return [{
      path: normalise(path), change: (CHANGE_TYPES.has(type) ? type : "modified") as FileChange,
      ...(str(c, "oldPath") ? { oldPath: str(c, "oldPath") } : {}), ...(after !== undefined ? { after } : {}),
      cut: bool(c, "isTruncated") ?? false,
    }];
  });
}

/** `workspaces.listFiles`'s paths (the session's own workspace folder). */
export function workspaceFiles(result: unknown): string[] {
  const files = rec(result)?.files;
  return Array.isArray(files) ? files.filter((f): f is string => typeof f === "string" && plainRelative(f)).map(normalise).filter(Boolean) : [];
}

/** The keys of a tool's arguments that name a file it read or wrote. */
const PATH_ARGS = ["path", "file_path", "filePath", "filename", "file"];

/**
 * The working folder's files the session's tools touched: what a tool's `fileEdits` say it changed (marked "edited"),
 * and the files its arguments name (a view, a create), when they lie in `folder`.
 */
export function seenFiles(t: Transcript | undefined, folder: string): KnownFile[] {
  if (!t) return [];
  const out = new Map<string, KnownFile>();
  for (const i of t.items) {
    if (i.kind !== "tool") continue;
    for (const k of PATH_ARGS) {
      const v = i.args?.[k];
      const rel = typeof v === "string" ? relativeTo(folder, v) : null;
      if (rel && !out.has(rel)) out.set(rel, { root: "folder", path: rel });
    }
    for (const f of i.fileEdits) {
      const rel = relativeTo(folder, f.path);
      if (rel) out.set(rel, { root: "folder", path: rel, change: "edited" });
    }
  }
  return [...out.values()];
}

/** Files merged by root and path: a change the diff names wins over a tool's "edited", which wins over none. */
export function mergeFiles(...lists: readonly (readonly KnownFile[])[]): KnownFile[] {
  const rank = (c?: FileChange) => (c === undefined ? 0 : c === "edited" ? 1 : 2);
  const out = new Map<string, KnownFile>();
  for (const list of lists) for (const f of list) {
    const id = fileId(f.root, f.path);
    const had = out.get(id);
    if (!had || rank(f.change) > rank(had.change)) out.set(id, f);
  }
  return [...out.values()];
}

const byName = (a: TreeNode, b: TreeNode) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });

/** The tree of both roots: folders first, then files, each by name; a folder is marked changed when a file in it is. */
export function buildTree(files: readonly KnownFile[], names: Readonly<Record<FileRoot, string>>): TreeNode[] {
  const roots: TreeNode[] = (["folder", "session"] as const).map(root => ({ id: ROOT_ID[root], root, name: names[root], path: "", dir: true, children: [] }));
  for (const f of files) {
    const parts = normalise(f.path).split("/").filter(Boolean);
    let at = roots[f.root === "folder" ? 0 : 1];
    parts.forEach((name, i) => {
      const path = parts.slice(0, i + 1).join("/");
      const last = i === parts.length - 1 && !f.dir;
      let next = at.children.find(c => c.name === name && c.dir === !last);
      if (!next) { next = { id: last ? fileId(f.root, path) : `${f.root}:${path}/`, root: f.root, name, path, dir: !last, children: [] }; at.children.push(next); }
      if (f.change) { if (last || (f.dir && i === parts.length - 1)) next.change = f.change; else next.change ??= "edited"; }
      at = next;
    });
  }
  const sort = (n: TreeNode) => { n.children.sort(byName); n.children.forEach(sort); };
  roots.forEach(sort);
  return roots;
}

/** The tree with only the files whose path holds `query` (case-blind), and the folders on the way to them; and which folders to open to show them. */
export function filterTree(tree: readonly TreeNode[], query: string): { tree: TreeNode[]; open: Set<string> } {
  const q = query.trim().toLocaleLowerCase();
  const open = new Set<string>();
  if (!q) return { tree: tree.slice(), open };
  const keep = (n: TreeNode): TreeNode | null => {
    if (!n.dir) return n.path.toLocaleLowerCase().includes(q) ? n : null;
    const kids = n.children.map(keep).filter((c): c is TreeNode => !!c);
    if (!kids.length) return null;
    open.add(n.id);
    return { ...n, children: kids };
  };
  // The roots stay, empty or not, so the person sees where nothing matched.
  return { tree: tree.map(r => keep(r) ?? { ...r, children: [] }), open };
}

/** The rows shown: every root, and the children of each open folder (only what is open is drawn: the tree is lazy). */
export function visibleRows(tree: readonly TreeNode[], open: ReadonlySet<string>): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (nodes: readonly TreeNode[], level: number, parent: string | null) => nodes.forEach((node, i) => {
    const expanded = node.dir && open.has(node.id);
    rows.push({ node, level, setSize: nodes.length, posInSet: i + 1, parent, expanded });
    if (expanded) walk(node.children, level + 1, node.id);
  });
  walk(tree, 1, null);
  return rows;
}

/** What a key does in the tree (WAI-ARIA's tree pattern): where focus goes, and a folder to open or close. */
export interface TreeMove { focus: string; toggle?: { id: string; open: boolean } }
export function treeKey(rows: readonly TreeRow[], focused: string, key: string): TreeMove | null {
  const i = Math.max(0, rows.findIndex(r => r.node.id === focused));
  const row = rows[i];
  if (!row) return null;
  switch (key) {
    case "ArrowDown": return { focus: rows[Math.min(rows.length - 1, i + 1)].node.id };
    case "ArrowUp": return { focus: rows[Math.max(0, i - 1)].node.id };
    case "Home": return { focus: rows[0].node.id };
    case "End": return { focus: rows[rows.length - 1].node.id };
    case "ArrowRight":
      if (!row.node.dir) return null;
      if (!row.expanded) return { focus: row.node.id, toggle: { id: row.node.id, open: true } };
      return row.node.children.length ? { focus: row.node.children[0].id } : null;
    case "ArrowLeft":
      if (row.node.dir && row.expanded) return { focus: row.node.id, toggle: { id: row.node.id, open: false } };
      return row.parent ? { focus: row.parent } : null;
    default: return null;
  }
}

/** Typing a letter moves to the next row whose name starts with it (after the focused one, wrapping). */
export function typeAhead(rows: readonly TreeRow[], focused: string, letter: string): string | null {
  const l = letter.toLocaleLowerCase();
  const i = rows.findIndex(r => r.node.id === focused);
  for (let n = 1; n <= rows.length; n++) {
    const r = rows[(i + n) % rows.length];
    if (r.node.name.toLocaleLowerCase().startsWith(l)) return r.node.id;
  }
  return null;
}

/** File names whose contents are never text: named in the viewer, never shown. */
const BINARY_NAME = /\.(png|jpe?g|gif|webp|bmp|ico|icns|tiff?|psd|pdf|zip|gz|tgz|bz2|xz|7z|rar|zst|jar|war|class|exe|dll|so|dylib|o|a|lib|bin|wasm|node|woff2?|ttf|otf|eot|mp[34]|m4a|wav|flac|ogg|webm|mov|avi|mkv|sqlite3?|db|pyc|keystore|p12|pfx)$/i;
export const binaryByName = (path: string): boolean => BINARY_NAME.test(path);

/** Whether text is a binary file's: a NUL, or more than one character in ten a control or replacement character. */
export function looksBinary(text: string): boolean {
  if (text.includes("\u0000")) return true;
  const sample = text.slice(0, 8_000);
  if (!sample) return false;
  let odd = 0;
  for (const ch of sample) {
    const c = ch.codePointAt(0) ?? 0;
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13 && c !== 12) || c === 0xfffd || c === 0x7f) odd++;
  }
  return odd / sample.length > 0.1;
}

/** What the viewer shows of a file: its lines (bounded), whether they were cut, or that it is binary. */
export type FileView = { kind: "text"; lines: string[]; cut: boolean } | { kind: "binary" } | { kind: "empty" };
export function fileView(path: string, text: string, cut = false): FileView {
  if (binaryByName(path) || looksBinary(text)) return { kind: "binary" };
  if (!text) return { kind: "empty" };
  const body = text.length > VIEW_CHARS ? text.slice(0, VIEW_CHARS) : text;
  let lines = body.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines = lines.slice(0, -1);
  const many = lines.length > VIEW_LINES;
  if (many) lines = lines.slice(0, VIEW_LINES);
  return { kind: "text", lines, cut: cut || many || text.length > VIEW_CHARS };
}

/** The working folder's paths a `completions.request` offered (its "@" items: documents and folders, relative). */
export function completionPaths(result: unknown): { path: string; dir: boolean }[] {
  return arr(result, "items").flatMap(i => {
    const kind = str(i, "kind");
    if (kind && kind !== "document" && kind !== "file" && kind !== "directory" && kind !== "folder") return [];
    const raw = (str(i, "label") ?? str(i, "insertText") ?? "").trim().replace(/^@/, "");
    if (!raw || !plainRelative(raw) || /\s/.test(raw)) return [];
    const dir = kind === "directory" || kind === "folder" || raw.endsWith("/");
    const path = normalise(raw);
    return path ? [{ path, dir }] : [];
  });
}
