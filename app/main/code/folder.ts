/**
 * Listing and reading a coding session's working folder for the window's Files tab (docs/CODING-APP.md §4 "Files"):
 * the SDK has no call for it (`workspaces.listFiles` and `readFile` are the session's own state folder, probed on
 * runtime 1.0.97), so main lists and reads, rooted at the session's folder.
 *
 * The constraint behind it: the window names a path only relative to the session's folder, and main resolves it
 * there, so nothing outside it is reached: a path with "..", a drive or a root is refused, and what it resolves to
 * after every link (realpath) must still be inside the folder. `.git` is never listed or read. What git ignores is left
 * out (`git check-ignore`, bounded in time), or outside a repository a short list of build and dependency folders.
 * Caps: CODE_LIMITS.folderEntries a folder, CODE_LIMITS.fileBytes a file. The user owns their folder, so its files are
 * listed and read as they are; the hub refuses Ember's own data on top (`reachesEmberData`). Plain Node.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { CODE_LIMITS, type CodeFileRead, type CodeFolderEntry, type CodeFolderListing } from "../../shared/code";
import { isInside } from "./guards";
import type { GitRunner } from "./workspaces";

/** A path the window gave that isn't one main reaches. */
export class FolderPathRefused extends Error {}

/** How long git may take to say what it ignores in one folder. */
export const IGNORE_CHECK_MS = 3_000;

/** Folders left out outside a repository (and as a fallback when git can't say). */
export const SKIPPED_NAMES: ReadonlySet<string> = new Set([
  ".git", "node_modules", "dist", "build", "out", "target", "__pycache__", ".venv", "venv", ".cache", ".next", ".nuxt",
  "coverage", ".gradle", ".idea", ".DS_Store", ".tox", ".mypy_cache", ".pytest_cache",
]);

/** `rel` as path parts: "" is the folder itself; ".." anywhere, a root or a drive, a NUL, or `.git` is refused. */
export function relParts(rel: string): string[] {
  if (typeof rel !== "string" || rel.length > CODE_LIMITS.relPath || /[\0\r\n]/.test(rel)) throw new FolderPathRefused("bad");
  if (/^([A-Za-z]:)?[\\/]/.test(rel) || /^\\\\/.test(rel)) throw new FolderPathRefused("absolute");
  const parts = rel.split(/[\\/]+/).filter(p => p && p !== ".");
  if (parts.some(p => p === ".." || p.toLowerCase() === ".git")) throw new FolderPathRefused("outside");
  return parts;
}

/** `rel` resolved under `root` (itself resolved): after every link it must still be inside; null where it isn't there. */
export async function resolveInside(root: string, rel: string): Promise<{ real: string; rootReal: string } | null> {
  const parts = relParts(rel);
  const rootReal = await fs.realpath(root);
  let real: string;
  try { real = await fs.realpath(path.join(rootReal, ...parts)); } catch { return null; /* not there (or a link to nowhere) */ }
  if (!isInside(real, rootReal)) throw new FolderPathRefused("outside");
  if (path.relative(rootReal, real).split(path.sep).some(p => p.toLowerCase() === ".git")) throw new FolderPathRefused("outside");
  return { real, rootReal };
}

/**
 * The names of folder `dir`'s own entries that git ignores; null when git can't say in time (not a repository, a
 * failure). `ls-files --ignored --directory` names an ignored folder once ("build/"), never what is in it, and isn't
 * thrown by a link out of the repository as `check-ignore` is.
 */
export async function ignoredBy(git: GitRunner, dir: string, names: readonly string[], ms = IGNORE_CHECK_MS): Promise<Set<string> | null> {
  if (!names.length) return new Set();
  const run = git(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z", "--", "."], dir).then(
    out => new Set(out.split("\0").filter(Boolean).map(n => n.replace(/\/$/, "")).filter(n => !n.includes("/"))),
    () => null,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), ms); });
  try { return await Promise.race([run, late]); } finally { clearTimeout(timer); }
}

/** The session's folder relative to its repository's top ("" at the top), or undefined outside one. */
export async function gitPrefixOf(git: GitRunner, folder: string): Promise<string | undefined> {
  try { return (await git(["rev-parse", "--show-prefix"], folder)).trim().replace(/\\/g, "/"); } catch { return undefined; /* not a repository */ }
}

/** Lists folder `rel` of `root`: folders first, then files, each by name; `.git`, links out of it and what is ignored left out. */
export async function listFolder(root: string, rel: string, git: GitRunner): Promise<CodeFolderListing> {
  const at = await resolveInside(root, rel);
  if (!at) throw new FolderPathRefused("missing");
  const stat = await fs.stat(at.real);
  if (!stat.isDirectory()) throw new FolderPathRefused("not-folder");
  const dirents = await fs.readdir(at.real, { withFileTypes: true });
  const all = dirents.filter(d => d.name !== ".git");
  // Read at most a few times the cap (a folder of a million files is listed as its first part).
  const named = all.slice(0, CODE_LIMITS.folderEntries * 4);
  const ignored = await ignoredBy(git, at.real, named.map(d => d.name));
  const entries: CodeFolderEntry[] = [];
  for (const d of named) {
    if (ignored ? ignored.has(d.name) : SKIPPED_NAMES.has(d.name)) continue;
    const full = path.join(at.real, d.name);
    let kind: CodeFolderEntry["kind"] | null = d.isDirectory() ? "folder" : d.isFile() ? "file" : null;
    let size: number | undefined;
    try {
      if (d.isSymbolicLink()) {
        // A link is listed only where it leads inside the folder.
        const to = await fs.realpath(full);
        if (!isInside(to, at.rootReal)) continue;
        const s = await fs.stat(to);
        kind = s.isDirectory() ? "folder" : s.isFile() ? "file" : null;
        if (kind === "file") size = s.size;
      } else if (kind === "file") size = (await fs.stat(full)).size;
    } catch { continue; /* gone, or a link to nowhere: not listed */ }
    if (!kind) continue;
    entries.push({ name: d.name, kind, ...(size !== undefined ? { size } : {}), path: full });
  }
  entries.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) : a.kind === "folder" ? -1 : 1));
  const truncated = entries.length > CODE_LIMITS.folderEntries || all.length > named.length;
  const prefix = await gitPrefixOf(git, at.rootReal);
  return { entries: entries.slice(0, CODE_LIMITS.folderEntries), ...(truncated ? { truncated: true } : {}), ...(prefix !== undefined ? { gitPrefix: prefix } : {}) };
}

/** Whether `bytes` are text: no NUL and valid UTF-8. */
export function isText(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); return true; } catch { return false; }
}

/** Reads file `rel` of `root`: its text, or that it is binary or too large to show. */
export async function readFolderFile(root: string, rel: string): Promise<CodeFileRead & { real: string }> {
  if (!relParts(rel).length) throw new FolderPathRefused("not-file");
  const at = await resolveInside(root, rel);
  if (!at) throw new FolderPathRefused("missing");
  const stat = await fs.stat(at.real);
  if (!stat.isFile()) throw new FolderPathRefused("not-file");
  if (stat.size > CODE_LIMITS.fileBytes) return { tooLarge: true, size: stat.size, real: at.real };
  const handle = await fs.open(at.real, "r");
  try {
    const buf = Buffer.alloc(Math.min(stat.size, CODE_LIMITS.fileBytes) + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead > CODE_LIMITS.fileBytes) return { tooLarge: true, size: bytesRead, real: at.real };
    const bytes = buf.subarray(0, bytesRead);
    return isText(bytes) ? { text: bytes.toString("utf8"), size: bytesRead, real: at.real } : { binary: true, size: bytesRead, real: at.real };
  } finally { await handle.close(); }
}
