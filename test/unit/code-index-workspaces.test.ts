/**
 * Ember's own record of coding projects and sessions (app/main/code/session-index.ts: 0600, written whole, checked
 * when read, a broken file moved aside and the index started empty) and the folders sessions work in
 * (app/main/code/workspaces.ts: Ember's data refused, git's facts, a worktree per session on its own branch, removed
 * with it), over a fake git.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionIndex, indexFile, writeAtomic } from "../../app/main/code/session-index";
import { FolderRefused, createWorktree, gitFacts, plainBranch, removeWorktree, repositoryOf, safeSessionPart, usableFolder, worktreePlan, worktreesDir, type GitRunner } from "../../app/main/code/workspaces";

let dir: string;
beforeEach(() => { dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "ember-code-index-"))); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

const posixModes = process.platform !== "win32";

describe("the coding index", () => {
  it("keeps projects and sessions' own facts across a restart, in a file only the user can read", async () => {
    const file = indexFile(dir);
    const index = new SessionIndex(file).load();
    const p = index.addProject({ folder: "/src/app", name: "app", gitRoot: "/src/app", branch: "main" });
    index.addSession("s1", { projectId: p.id, folder: "/src/app", isolation: "folder", createdBy: "user" });
    index.updateSession("s1", { pinned: true, unread: 3 });
    await index.flushed();
    if (posixModes) expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const again = new SessionIndex(file).load();
    expect(again.projects()).toEqual([{ id: p.id, folder: "/src/app", name: "app", gitRoot: "/src/app", branch: "main" }]);
    expect(again.session("s1")).toMatchObject({ projectId: p.id, isolation: "folder", pinned: true, archived: false, unread: 3, createdBy: "user" });
  });

  it("starts empty from a file that isn't valid, and moves that file aside and says so", () => {
    const file = indexFile(dir);
    fs.writeFileSync(file, JSON.stringify({ version: 1, projects: [{ id: "x" }], sessions: {} }));
    const warned: string[] = [];
    const index = new SessionIndex(file, { warn: e => warned.push(e) }, () => 42).load();
    expect(index.projects()).toEqual([]);
    expect(warned).toEqual(["code.index_corrupt"]);
    expect(fs.existsSync(`${file}.broken-42`)).toBe(true);
    fs.writeFileSync(file, "{ not json");
    expect(new SessionIndex(file, { warn: e => warned.push(e) }, () => 43).load().projects()).toEqual([]);
    expect(warned).toEqual(["code.index_corrupt", "code.index_corrupt"]);
  });

  it("refuses a change that would make a record invalid, keeping the record as it was", () => {
    const index = new SessionIndex(indexFile(dir)).load();
    index.addSession("s1", { projectId: "p", folder: "/src", isolation: "folder", createdBy: "user" });
    index.updateSession("s1", { name: "x".repeat(500) });
    expect(index.session("s1")?.name).toBeUndefined();
  });

  it("writes whole or not at all: a temporary file renamed over the old one", async () => {
    const file = path.join(dir, "a.json");
    fs.writeFileSync(file, "old");
    await writeAtomic(file, "new");
    expect(fs.readFileSync(file, "utf8")).toBe("new");
    expect(fs.readdirSync(dir)).toEqual(["a.json"]);
  });
});

/** A git that answers from a table, recording what it was asked. */
function fakeGit(answers: Record<string, string | Error>): GitRunner & { asked: string[][] } {
  const asked: string[][] = [];
  const run = (async (args: readonly string[]) => {
    asked.push([...args]);
    const a = answers[args.join(" ")] ?? answers[args[0]];
    if (a === undefined || a instanceof Error) throw a ?? new Error("no");
    return a;
  }) as unknown as GitRunner & { asked: string[][] };
  run.asked = asked;
  return run;
}

describe("a coding session's folder", () => {
  it("is never Ember's own data folder, anything in it, or a folder that holds it", async () => {
    const ember = path.join(dir, "ember");
    fs.mkdirSync(path.join(ember, "code"), { recursive: true });
    const project = path.join(dir, "project");
    fs.mkdirSync(project);
    await expect(usableFolder(ember, [ember])).rejects.toBeInstanceOf(FolderRefused);
    await expect(usableFolder(path.join(ember, "code"), [ember])).rejects.toBeInstanceOf(FolderRefused);
    await expect(usableFolder(dir, [ember])).rejects.toBeInstanceOf(FolderRefused);
    await expect(usableFolder(path.join(dir, "missing"), [ember])).rejects.toThrow("Choose a folder that exists.");
    expect(await usableFolder(project, [ember])).toBe(project);
  });

  it("is told by git: its root, its branch and its repository from origin's URL", async () => {
    const git = fakeGit({ "rev-parse --show-toplevel": `${dir}\n`, "rev-parse --abbrev-ref HEAD": "main\n", "remote get-url origin": "git@github.com:acme/app.git\n" });
    expect(await gitFacts(dir, git)).toEqual({ gitRoot: dir, branch: "main", repository: "acme/app" });
    expect(await gitFacts(dir, fakeGit({}))).toEqual({});
    expect(repositoryOf("https://github.com/acme/app.git")).toBe("acme/app");
    expect(repositoryOf("ssh://git@example.com:2222/team/tool")).toBe("team/tool");
    expect(repositoryOf("/srv/repos/x")).toBeUndefined();
  });
});

describe("a session's worktree", () => {
  it("goes under Ember's worktrees folder on a new branch named for the session", () => {
    expect(worktreePlan(dir, "0e1f5d7b-1d3c-481e-93e3-85ffe8f48dd7")).toEqual({ folder: path.join(dir, "worktrees", "0e1f5d7b-1d3c-481e-93e3-85ffe8f48dd7"), branch: "ember/0e1f5d7b" });
    expect(() => safeSessionPart("../escape")).toThrow();
    expect(() => safeSessionPart(".hidden")).toThrow();
    expect(plainBranch("feature/x")).toBe(true);
    for (const bad of ["-rf", "a..b", "x.lock", "a//b", "a/", "sp ace"]) expect(plainBranch(bad), bad).toBe(false);
  });

  it("is made from the base branch with git worktree add, taking the next free branch name", async () => {
    const git = fakeGit({ "rev-parse --verify --quiet refs/heads/ember/abcdef12": "x\n", worktree: "" });
    const made = await createWorktree({ codeDir: dir, sessionId: "abcdef12-0000", gitRoot: "/src/app", baseBranch: "main", git });
    expect(made).toEqual({ folder: path.join(dir, "worktrees", "abcdef12-0000"), branch: "ember/abcdef12-2", baseBranch: "main" });
    expect(git.asked.at(-1)).toEqual(["worktree", "add", "-b", "ember/abcdef12-2", "--", made.folder, "main"]);
  });

  it("is refused, plainly, for a folder that isn't a git repository or a base branch git wouldn't take", async () => {
    await expect(createWorktree({ codeDir: dir, sessionId: "s1", gitRoot: undefined, git: fakeGit({}) }))
      .rejects.toThrow("That folder isn't a git repository, so Ember can't make a worktree for it. Work in the folder itself instead.");
    await expect(createWorktree({ codeDir: dir, sessionId: "s1", gitRoot: "/src", baseBranch: "--upload-pack=x", git: fakeGit({}) })).rejects.toBeInstanceOf(FolderRefused);
  });

  it("is removed with its session, and only ever inside Ember's worktrees folder", async () => {
    const folder = path.join(worktreesDir(dir), "s1");
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, "f"), "x");
    const git = fakeGit({ worktree: "" });
    await removeWorktree({ codeDir: dir, folder, gitRoot: "/src/app", git });
    expect(fs.existsSync(folder)).toBe(false);
    expect(git.asked[0]).toEqual(["worktree", "remove", "--force", "--", folder]);
    await expect(removeWorktree({ codeDir: dir, folder: path.join(dir, "elsewhere"), git })).rejects.toThrow();
    await expect(removeWorktree({ codeDir: dir, folder: worktreesDir(dir), git })).rejects.toThrow();
  });
});
