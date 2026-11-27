/**
 * The folders coding sessions work in (docs/CODING-APP.md §2 "Workspaces"): a project's folder as main's own picker
 * chose it (never a path typed by a window), refused when it is Ember's own data folder or inside it; its git root,
 * repository and branch, read with plain `git` (execFile, no shell, a timeout, no prompt); and, for a session that
 * works apart from the folder (isolation "worktree"), a git worktree Ember makes for it under
 * `<userData>/code/worktrees/<session>` on a new branch `ember/<short id>` from the base branch, removed with the
 * session. That folder is inside Ember's data folder, which every session's sandbox denies to the tools: the SDK's
 * sandbox gives a session its own working folder back (runtime 1.0.97, probed), and the pre-tool hook treats it as
 * the session's own (guards.ts). Plain Node: the git runner is injected for tests.
 */

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { codingWorkspace, protectedPath } from "../agent/coding-session";
import { isInside } from "./guards";

/** Runs git with `args` in `cwd`; resolves with its standard output, rejects when it fails or takes too long. */
export type GitRunner = (args: readonly string[], cwd: string) => Promise<string>;

/** How long one git command may take. */
export const GIT_TIMEOUT_MS = 15_000;

/** git through execFile: no shell, no prompt for credentials, a timeout, output capped. */
export function gitRunner(env: NodeJS.ProcessEnv = process.env): GitRunner {
  const childEnv = { ...env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" };
  return (args, cwd) => new Promise((resolve, reject) => {
    execFile("git", [...args], { cwd, env: childEnv, timeout: GIT_TIMEOUT_MS, maxBuffer: 1024 * 1024, windowsHide: true, encoding: "utf8" }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/** What git says of a folder. */
export interface GitFacts {
  gitRoot?: string;
  /** "owner/name" from the origin remote's URL, when it is one. */
  repository?: string;
  branch?: string;
}

/** "owner/name" from a remote's URL (https, ssh or scp form), or undefined. */
export function repositoryOf(url: string): string | undefined {
  const m = /^(?:[a-z+]+:\/\/(?:[^@/]+@)?[^/]+(?::\d+)?\/|[^@\s]+@[^:\s]+:)([^\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  if (!m) return undefined;
  const parts = m[1].split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const repo = parts.slice(-2).join("/");
  return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo) ? repo : undefined;
}

/** git's facts of `folder`; an empty object where it isn't a git repository or git can't say. */
export async function gitFacts(folder: string, git: GitRunner): Promise<GitFacts> {
  let root: string;
  try { root = (await git(["rev-parse", "--show-toplevel"], folder)).trim(); } catch { return {}; }
  if (!root) return {};
  const facts: GitFacts = { gitRoot: path.resolve(root) };
  try {
    const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], folder)).trim();
    if (branch && branch !== "HEAD") facts.branch = branch.slice(0, 400);
  } catch { /* a repository with no commit yet has no branch to name */ }
  try {
    const repo = repositoryOf((await git(["remote", "get-url", "origin"], folder)).trim());
    if (repo) facts.repository = repo;
  } catch { /* no origin: no repository to name */ }
  return facts;
}

/** A folder Ember won't work in: a sentence for the person. */
export class FolderRefused extends Error {}

/**
 * `folder` as a session may work in it: absolute, a directory that exists, resolved through links, and neither one of
 * Ember's own paths nor inside one (nor one that holds one: the sandbox would then deny the session its own folder's
 * parent's data, and the tools would run beside it).
 */
export async function usableFolder(folder: string, protectedPaths: readonly string[]): Promise<string> {
  let resolved: string;
  try { resolved = await codingWorkspace(folder); } catch { throw new FolderRefused("Choose a folder that exists."); }
  if (!protectedPaths.length || protectedPaths.some(p => !path.isAbsolute(p))) throw new FolderRefused("Ember couldn't tell where its own data is, so it won't start a coding session.");
  const denied = [...new Set((await Promise.all(protectedPaths.map(protectedPath))).flat())];
  if (denied.some(p => isInside(resolved, p) || isInside(p, resolved))) throw new FolderRefused("That folder holds Ember's own data. Choose another.");
  return resolved;
}

/** The folder Ember keeps its worktrees in. */
export const worktreesDir = (codeDir: string): string => path.join(codeDir, "worktrees");

/** A session id as it may name a folder and a branch: letters, digits, dot, dash and underscore only. */
export function safeSessionPart(sessionId: string): string {
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(sessionId) || sessionId.startsWith(".")) throw new Error("A session id that can't name a folder.");
  return sessionId;
}

/** Where a session's worktree goes, and the branch it is on. */
export function worktreePlan(codeDir: string, sessionId: string): { folder: string; branch: string } {
  const id = safeSessionPart(sessionId);
  const short = id.replace(/[^A-Za-z0-9]/g, "").slice(0, 8).toLowerCase() || "session";
  return { folder: path.join(worktreesDir(codeDir), id), branch: `ember/${short}` };
}

/** A branch name git would take (`git check-ref-format --branch`'s rules, the common part): no option, no `..`. */
export function plainBranch(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(name) && !name.includes("..") && !name.includes("//") && !name.endsWith("/") && !name.endsWith(".lock") && !name.endsWith(".");
}

/**
 * Makes the worktree for `sessionId` from `gitRoot`: on a new branch from `baseBranch` (default: the folder's
 * current branch, or HEAD). A branch of that name already there gets a numbered one. Throws FolderRefused with a
 * sentence when the folder isn't a repository or git refuses.
 */
export async function createWorktree(o: { codeDir: string; sessionId: string; gitRoot: string | undefined; baseBranch?: string; git: GitRunner }): Promise<{ folder: string; branch: string; baseBranch: string }> {
  if (!o.gitRoot) throw new FolderRefused("That folder isn't a git repository, so Ember can't make a worktree for it. Work in the folder itself instead.");
  if (o.baseBranch !== undefined && !plainBranch(o.baseBranch)) throw new FolderRefused("That branch name isn't one git takes.");
  const plan = worktreePlan(o.codeDir, o.sessionId);
  await fs.mkdir(worktreesDir(o.codeDir), { recursive: true, mode: 0o700 });
  let base = o.baseBranch;
  if (!base) {
    try { base = (await o.git(["rev-parse", "--abbrev-ref", "HEAD"], o.gitRoot)).trim(); } catch { base = "HEAD"; }
    if (!base || !plainBranch(base)) base = "HEAD";
  }
  let branch = plan.branch;
  for (let n = 2; n < 50; n++) {
    try { await o.git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], o.gitRoot); branch = `${plan.branch}-${n}`; }
    catch { break; /* no such branch: this name is free */ }
  }
  try {
    await o.git(["worktree", "add", "-b", branch, "--", plan.folder, base], o.gitRoot);
  } catch {
    throw new FolderRefused("Ember couldn't make a worktree for this session.");
  }
  return { folder: plan.folder, branch, baseBranch: base };
}

/**
 * Removes a worktree Ember made: `git worktree remove --force` from its repository, then the folder if anything is
 * left (only ever a folder inside Ember's worktrees folder). The branch is kept: it may hold the session's work.
 */
export async function removeWorktree(o: { codeDir: string; folder: string; gitRoot?: string; git: GitRunner }): Promise<void> {
  const root = worktreesDir(o.codeDir);
  if (!isInside(o.folder, root) || path.resolve(o.folder) === path.resolve(root)) throw new Error("Not one of Ember's worktrees.");
  if (o.gitRoot) {
    try { await o.git(["worktree", "remove", "--force", "--", o.folder], o.gitRoot); } catch { /* removed by hand below; git prunes its record later */ }
    try { await o.git(["worktree", "prune"], o.gitRoot); } catch { /* best effort: the record is pruned next time */ }
  }
  await fs.rm(o.folder, { recursive: true, force: true });
}
