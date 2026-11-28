/**
 * What a coding window's RPC call and a tool's arguments pass on top of the SDK (app/main/code/guards.ts): the
 * allow-list, nothing that turns the sandbox off or sets a permission mode, no path that is Ember's own data (but a
 * session's own worktree and SDK state, inside the data folder, are its own), sizes, and fail closed on what can't be
 * read whole.
 */

import path from "node:path";
import { describe, expect, it } from "vitest";
import { CODE_REFUSALS, isInside, reachesEmberData, rpcRefusal, stringsOf } from "../../app/main/code/guards";

// POSIX paths, judged as on Linux; isInside uses the host's own path rules, so these run where paths are POSIX.
const posix = process.platform !== "win32";
const ember = "/home/ana/.config/ember";
const place = { os: "linux" as const, home: "/home/ana", ember: [ember] };
const tree = path.posix.join(ember, "code", "worktrees", "s1");
const state = path.posix.join(ember, "code", "copilot", "session-state", "s1");
const where = { place, cwd: "/home/ana/src/app" };

describe.runIf(posix)("a coding window's RPC call", () => {
  it("goes through when it is on the allow-list and passes nothing of Ember's", () => {
    expect(rpcRefusal({ scope: "client", method: "models.list" }, where)).toBeNull();
    expect(rpcRefusal({ scope: "session", sessionId: "s1", method: "workspaces.diff", params: { mode: "session" } }, where)).toBeNull();
    expect(rpcRefusal({ scope: "session", sessionId: "s1", method: "history.listRewindPoints" }, where)).toBeNull();
  });

  it("is refused when it isn't on the allow-list: turn control, the sandbox's switch, options, lifecycle", () => {
    for (const method of ["send", "abort", "options.update", "sandbox.disableForSession", "permissions.setMode", "permissions.handlePendingPermissionRequest", "sessions.fork", "account.login", "constructor"]) {
      expect(rpcRefusal({ scope: "session", sessionId: "s1", method }, where), method).toBe(CODE_REFUSALS.rpcNotAllowed);
    }
    expect(rpcRefusal({ scope: "client", method: "runtime.shutdown" }, where)).toBe(CODE_REFUSALS.rpcNotAllowed);
  });

  it("never turns the sandbox off, whatever method carries it", () => {
    expect(rpcRefusal({ scope: "client", method: "user.settings.get", params: { sandbox: false } }, where)).toBe(CODE_REFUSALS.rpcSandbox);
    expect(rpcRefusal({ scope: "session", sessionId: "s1", method: "metadata.updateClientMetadata", params: { sandboxConfig: { enabled: false } } }, where)).toBe(CODE_REFUSALS.rpcSandbox);
    expect(rpcRefusal({ scope: "session", sessionId: "s1", method: "providers.getStatus", params: { x: { sandbox: { allowBypass: true } } } }, where)).toBe(CODE_REFUSALS.rpcSandbox);
    expect(rpcRefusal({ scope: "client", method: "sandbox.getHostSupport" }, where)).toBeNull();
  });

  it("never passes a path that is Ember's data, and never grants a folder that holds it", () => {
    expect(rpcRefusal({ scope: "session", sessionId: "s1", method: "permissions.paths.add", params: { path: ember } }, where)).toBe(CODE_REFUSALS.rpcPath);
    expect(rpcRefusal({ scope: "session", sessionId: "s1", method: "shell.exec", params: { command: `cat ${ember}/settings.json` } }, where)).toBe(CODE_REFUSALS.rpcPath);
    expect(rpcRefusal({ scope: "session", sessionId: "s1", method: "shell.exec", params: { command: "cat ~/.config/ember/audit/x.jsonl" } }, where)).toBe(CODE_REFUSALS.rpcPath);
    expect(rpcRefusal({ scope: "session", sessionId: "s1", method: "permissions.folderTrust.addTrusted", params: { path: "/home/ana/.config" } }, where)).toBe(CODE_REFUSALS.rpcPath);
    expect(rpcRefusal({ scope: "session", sessionId: "s1", method: "permissions.folderTrust.addTrusted", params: { path: "/home/ana/src/app" } }, where)).toBeNull();
  });

  it("may pass the session's own worktree and SDK state, though they lie inside Ember's data folder", () => {
    const own = { place, cwd: tree, own: [state] };
    expect(rpcRefusal({ scope: "session", sessionId: "s1", method: "shell.exec", params: { command: "ls", cwd: tree } }, own)).toBeNull();
    expect(rpcRefusal({ scope: "session", sessionId: "s1", method: "workspaces.readFile", params: { path: path.posix.join(state, "plan.md") } }, own)).toBeNull();
    expect(rpcRefusal({ scope: "session", sessionId: "s1", method: "shell.exec", params: { command: "ls", cwd: path.posix.join(ember, "code", "worktrees", "s2") } }, own)).toBe(CODE_REFUSALS.rpcPath);
  });

  it("is refused when its params are larger than CODE_LIMITS.params or too deep to read whole", () => {
    expect(rpcRefusal({ scope: "client", method: "models.list", params: { x: "a".repeat(300_000) } }, where)).toBe(CODE_REFUSALS.rpcTooLarge);
    let deep: unknown = "leaf";
    for (let i = 0; i < 40; i++) deep = { d: deep };
    expect(rpcRefusal({ scope: "client", method: "models.list", params: deep }, where)).toBe(CODE_REFUSALS.rpcTooLarge);
  });
});

describe.runIf(posix)("a tool's arguments", () => {
  it("reach Ember's data when any string names it, a command line's words included", () => {
    expect(reachesEmberData({ path: path.posix.join(ember, "settings.json") }, where)).toBe(true);
    expect(reachesEmberData({ command: `grep -r token ${ember}` }, where)).toBe(true);
    expect(reachesEmberData({ path: "/home/ana/src/app/README.md", command: "npm test" }, where)).toBe(false);
  });

  it("don't reach it in the session's own folders, and can't be judged when too many to read (fail closed)", () => {
    expect(reachesEmberData({ path: path.posix.join(tree, "src/index.ts") }, { place, cwd: tree })).toBe(false);
    // A relative path out of the worktree into the rest of the data folder is Ember's again.
    expect(reachesEmberData({ path: "../../../settings.json" }, { place, cwd: tree })).toBe(true);
    expect(reachesEmberData({ path: path.posix.join(state, "plan.md") }, { place, cwd: tree, own: [state] })).toBe(false);
    expect(reachesEmberData(Array.from({ length: 6000 }, () => "x"), where)).toBe("unreadable");
    expect(stringsOf({ a: ["b", { c: "d" }] })).toEqual(["a", "b", "c", "d"]);
  });

  it("judge inside and outside by whole path parts", () => {
    expect(isInside("/a/b/c", "/a/b")).toBe(true);
    expect(isInside("/a/bc", "/a/b")).toBe(false);
    expect(isInside("relative", "/a")).toBe(false);
  });
});
