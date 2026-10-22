import { describe, expect, it } from "vitest";
import posix from "node:path/posix";
import win32 from "node:path/win32";
import type { RunnerFacts } from "../../app/main/commands/types";
import { localFactsWith, powershellPath, type FactProbes } from "../../app/main/commands/run/facts";
import { inspectPaths, MAX_INSPECT, type InspectFs } from "../../app/main/commands/run/inspect";
import { GIT_ARGV, GIT_FACTS_MS, readGitFacts, type GitRun } from "../../app/main/commands/run/git-facts";

const ember: RunnerFacts["ember"] = { paths: ["/home/ana/.config/ember"], pids: [10], names: /^ember$/ };

/** Probes over a fake set of executables and `--version` answers. */
function probes(executables: string[], versions: Record<string, string> = {}): FactProbes & { ran: string[] } {
  const ran: string[] = [];
  return {
    ran,
    executable: async p => executables.includes(p),
    run: async (file, args) => {
      ran.push([file, ...args].join(" "));
      return file in versions ? { code: 0, out: versions[file] } : { code: 1, out: "script: unrecognized option '--version'" };
    },
  };
}

const opts = (os: "linux" | "darwin" | "win32", over: Partial<Parameters<typeof localFactsWith>[0]> = {}) => ({
  os, env: { PATH: "/usr/local/bin:/usr/bin:/bin" }, home: "/home/ana", user: "ana", elevated: () => false, extraPath: [], ember, ...over,
});

describe("localFacts", () => {
  it("offers bash first on Linux, then sh and zsh, with util-linux script for a PTY", async () => {
    const p = probes(["/usr/bin/bash", "/usr/bin/sh", "/usr/bin/zsh", "/usr/bin/script"], { "/usr/bin/script": "script from util-linux 2.32.1\n" });
    await expect(localFactsWith(opts("linux"), p)).resolves.toEqual({
      os: "linux", shells: ["bash", "sh", "zsh"], shellPaths: { bash: "/usr/bin/bash", sh: "/usr/bin/sh", zsh: "/usr/bin/zsh" },
      script: { path: "/usr/bin/script", kind: "util-linux" }, pty: true, home: "/home/ana", user: "ana", privileged: false, ember, extraPath: [],
    });
    expect(p.ran).toEqual(["/usr/bin/script --version"]);
  });

  it("falls back to sh, and to pipes when script isn't util-linux's (BusyBox's has no -e)", async () => {
    const f = await localFactsWith(opts("linux"), probes(["/bin/sh", "/bin/script"], { "/bin/script": "BusyBox v1.36.1 (2024-01-01) multi-call binary." }));
    expect(f.shells).toEqual(["sh"]);
    expect(f.shellPaths).toEqual({ sh: "/bin/sh" });
    expect(f.script).toBeNull();
    expect(f.pty).toBe(false);
  });

  it("looks in PATH's absolute folders, then the extra ones, then the system's, and offers no shell with an unsafe path", async () => {
    const env = { PATH: "relative/bin:.:/home/ana/my tools:/home/ana/.local/bin:/usr/bin" };
    const p = probes(["/home/ana/my tools/bash", "relative/bin/bash", "/home/ana/.local/bin/zsh", "/opt/homebrew/bin/bash", "/bin/bash", "/bin/sh"]);
    const f = await localFactsWith(opts("linux", { env, extraPath: ["/opt/homebrew/bin"] }), p);
    expect(f.shellPaths).toEqual({ bash: "/opt/homebrew/bin/bash", zsh: "/home/ana/.local/bin/zsh", sh: "/bin/sh" });
    expect(f.extraPath).toEqual(["/opt/homebrew/bin"]);
    const none = await localFactsWith(opts("linux", { env: { PATH: "/weird'dir" } }), probes(["/weird'dir/bash"]));
    expect(none.shells).toEqual([]);
  });

  it("offers zsh first on macOS and takes BSD script without asking it for a version", async () => {
    const p = probes(["/bin/zsh", "/bin/bash", "/bin/sh", "/usr/bin/script"]);
    const f = await localFactsWith(opts("darwin", { env: { PATH: "/usr/bin:/bin" }, home: "/Users/ana" }), p);
    expect(f.shells).toEqual(["zsh", "bash", "sh"]);
    expect(f.shellPaths).toEqual({ zsh: "/bin/zsh", bash: "/bin/bash", sh: "/bin/sh" });
    expect(f.script).toEqual({ path: "/usr/bin/script", kind: "bsd" });
    expect(p.ran).toEqual([]);
  });

  it("offers Windows PowerShell only on Windows, from %SystemRoot%, probing nothing", async () => {
    const p = probes([]);
    const f = await localFactsWith(opts("win32", { env: { SystemRoot: "D:\\Win" }, home: "C:\\Users\\ana" }), p);
    expect(f).toMatchObject({ shells: ["powershell"], shellPaths: { powershell: "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" }, script: null, pty: false });
    expect(p.ran).toEqual([]);
    expect(powershellPath({ SYSTEMROOT: "C:\\Windows\\" })).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(powershellPath({ windir: "E:\\W" })).toBe("E:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(powershellPath({ SystemRoot: "\\\\evil\\share" })).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
    expect(powershellPath({})).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  });

  it("takes privilege from the injected function, never from whoami, and fails closed (critique integration-23)", async () => {
    const p = probes(["/usr/bin/bash"]);
    await expect(localFactsWith(opts("linux", { elevated: () => true }), p)).resolves.toMatchObject({ privileged: true });
    await expect(localFactsWith(opts("win32", { elevated: () => true }), p)).resolves.toMatchObject({ privileged: true });
    await expect(localFactsWith(opts("linux", { elevated: () => { throw new Error("no token"); } }), p)).resolves.toMatchObject({ privileged: true });
    expect(p.ran.some(r => /whoami|id -u/.test(r))).toBe(false);
  });
});

// ─────────────── inspect ───────────────

type Node = { kind: "file" } | { kind: "dir" } | { kind: "link"; to: string } | { kind: "denied" };

/** A fake filesystem with POSIX or Windows rules: realpath resolves links in every segment, as the OS does. */
function fakeFs(tree: Record<string, Node>, os: "posix" | "win32"): InspectFs {
  const sep = os === "win32" ? "\\" : "/";
  const P = os === "win32" ? win32 : posix;
  const norm = (p: string) => (os === "win32" ? p.toLowerCase() : p);
  const find = (p: string) => Object.entries(tree).find(([k]) => norm(k) === norm(p));
  const err = (code: string) => Object.assign(new Error(code), { code });
  const split = (p: string) => {
    const root = os === "win32" ? p.slice(0, 3) : "/";
    return { root, parts: p.slice(root.length).split(sep).filter(Boolean) };
  };
  const real = (p: string, depth = 0): string => {
    if (depth > 20) throw err("ELOOP");
    const { root, parts } = split(p);
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const next = cur.endsWith(sep) ? cur + parts[i] : cur + sep + parts[i];
      const hit = find(next);
      if (!hit) throw err("ENOENT");
      if (hit[1].kind === "denied") throw err("EACCES");
      // A link's target is read relative to the folder holding the link.
      if (hit[1].kind === "link") cur = real(P.isAbsolute(hit[1].to) ? hit[1].to : P.resolve(cur, hit[1].to), depth + 1);
      else cur = hit[0];
      if (i < parts.length - 1 && hit[1].kind === "file") throw err("ENOTDIR");
    }
    return cur;
  };
  return {
    lstat: async p => {
      const { root, parts } = split(p);
      const parent = parts.length > 1 ? real(root + parts.slice(0, -1).join(sep)) : root;
      const hit = find(parent.endsWith(sep) ? parent + parts[parts.length - 1] : parent + sep + parts[parts.length - 1]);
      if (!hit) throw err("ENOENT");
      if (hit[1].kind === "denied") throw err("EACCES");
      return { isSymbolicLink: () => hit[1].kind === "link" };
    },
    realpath: async p => real(p),
    readlink: async p => {
      const hit = find(p);
      if (!hit || hit[1].kind !== "link") throw err("EINVAL");
      return hit[1].to;
    },
  };
}

describe("inspectPaths", () => {
  const posixTree: Record<string, Node> = {
    "/home": { kind: "dir" }, "/home/ana": { kind: "dir" }, "/home/ana/.ssh": { kind: "dir" }, "/home/ana/.ssh/id_ed25519": { kind: "file" },
    "/home/ana/src": { kind: "dir" }, "/home/ana/src/k": { kind: "link", to: "/home/ana/.ssh" }, "/home/ana/src/notes.txt": { kind: "file" },
    "/home/ana/src/dangling": { kind: "link", to: "../.ssh/new_key" }, "/home/ana/src/rel": { kind: "link", to: "../.ssh" },
    "/root": { kind: "denied" },
  };
  const fs = fakeFs(posixTree, "posix");

  it("answers each path's existence and real path, links resolved (critique integration-26)", async () => {
    await expect(inspectPaths(["/home/ana/src/notes.txt", "k/id_ed25519", "rel/id_ed25519"], "/home/ana/src", { os: "linux", fs })).resolves.toEqual([
      { exists: true, real: "/home/ana/src/notes.txt" },
      { exists: true, real: "/home/ana/.ssh/id_ed25519" },
      { exists: true, real: "/home/ana/.ssh/id_ed25519" },
    ]);
  });

  it("gives a missing path its nearest existing parent's real path plus the rest, and a dangling link its target's", async () => {
    await expect(inspectPaths(["k/new/deeper", "/home/ana/src/../src/missing.txt", "dangling"], "/home/ana/src", { os: "linux", fs })).resolves.toEqual([
      { exists: false, real: "/home/ana/.ssh/new/deeper" },
      { exists: false, real: "/home/ana/src/missing.txt" },
      { exists: true, real: "/home/ana/.ssh/new_key" },
    ]);
  });

  it("answers null for what it can't tell, and never throws", async () => {
    const broken: InspectFs = { lstat: () => { throw new Error("sync throw"); }, realpath: () => Promise.reject(new Error("x")), readlink: () => Promise.reject(new Error("x")) };
    await expect(inspectPaths(["/root/.bashrc", "x\0y", "", "rel"], "relative-cwd", { os: "linux", fs })).resolves.toEqual([
      { exists: null, real: null }, { exists: null, real: null }, { exists: null, real: null }, { exists: null, real: null },
    ]);
    await expect(inspectPaths(["/a"], "/", { os: "linux", fs: broken })).resolves.toEqual([{ exists: null, real: null }]);
    const many = Array.from({ length: MAX_INSPECT + 2 }, (_, i) => `/home/ana/src/f${i}`);
    const got = await inspectPaths(many, "/", { os: "linux", fs });
    expect(got).toHaveLength(MAX_INSPECT + 2);
    expect(got[0]).toEqual({ exists: false, real: "/home/ana/src/f0" });
    expect(got[MAX_INSPECT]).toEqual({ exists: null, real: null });
  });

  it("follows Windows' path rules on Windows: 8.3 names and junctions come back long", async () => {
    const winTree: Record<string, Node> = {
      "C:\\Users": { kind: "dir" }, "C:\\Users\\ana": { kind: "dir" }, "C:\\Users\\ANA~1": { kind: "link", to: "C:\\Users\\ana" },
      "C:\\Users\\ana\\.aws": { kind: "dir" }, "C:\\Users\\ana\\.aws\\credentials": { kind: "file" },
      "C:\\Users\\ana\\src": { kind: "dir" }, "C:\\Users\\ana\\src\\j": { kind: "link", to: "C:\\Users\\ana\\.aws" },
    };
    const wfs = fakeFs(winTree, "win32");
    await expect(inspectPaths(["C:\\Users\\ANA~1\\.aws\\credentials", "j\\credentials", "j\\new.txt"], "C:\\Users\\ana\\src", { os: "win32", fs: wfs })).resolves.toEqual([
      { exists: true, real: "C:\\Users\\ana\\.aws\\credentials" },
      { exists: true, real: "C:\\Users\\ana\\.aws\\credentials" },
      { exists: false, real: "C:\\Users\\ana\\.aws\\new.txt" },
    ]);
  });
});

// ─────────────── git push facts ───────────────

function git(answers: Partial<Record<keyof typeof GIT_ARGV, { code: number | null; stdout: string }>>): GitRun & { calls: { args: readonly string[]; cwd: string; timeoutMs: number }[] } {
  const calls: { args: readonly string[]; cwd: string; timeoutMs: number }[] = [];
  const run = (async (args, o) => {
    calls.push({ args, ...o });
    const key = (Object.keys(GIT_ARGV) as (keyof typeof GIT_ARGV)[]).find(k => GIT_ARGV[k].join(" ") === args.join(" "));
    return (key && answers[key]) ?? { code: 128, stdout: "" };
  }) as GitRun & { calls: typeof calls };
  run.calls = calls;
  return run;
}

describe("readGitFacts", () => {
  it("reads the branch, push.default and the upstream with the fixed argv, in the command's folder, within 5 s", async () => {
    const run = git({ branch: { code: 0, stdout: "feature-x\n" }, pushDefault: { code: 0, stdout: "simple\n" }, upstream: { code: 0, stdout: "origin/feature-x\n" } });
    await expect(readGitFacts("/home/ana/src", run)).resolves.toEqual({ branch: "feature-x", pushDefault: "simple", upstream: "origin/feature-x" });
    expect(run.calls.map(c => c.args.join(" ")).sort()).toEqual(["config --get push.default", "rev-parse --abbrev-ref @{u}", "rev-parse --abbrev-ref HEAD"]);
    expect(run.calls.every(c => c.cwd === "/home/ana/src" && c.timeoutMs === GIT_FACTS_MS)).toBe(true);
    expect(GIT_FACTS_MS).toBe(5000);
  });

  it("says unset push.default and no upstream as null, and a detached HEAD as no branch", async () => {
    await expect(readGitFacts("/r", git({ branch: { code: 0, stdout: "HEAD\n" }, pushDefault: { code: 1, stdout: "" } }))).resolves.toEqual({ branch: null, pushDefault: null, upstream: null });
  });

  it("answers null outside a work tree and when push.default couldn't be read (never taken for unset)", async () => {
    await expect(readGitFacts("/tmp", git({ pushDefault: { code: 1, stdout: "" } }))).resolves.toBeNull();
    await expect(readGitFacts("/r", git({ branch: { code: 0, stdout: "main\n" }, pushDefault: { code: null, stdout: "" } }))).resolves.toBeNull();
    await expect(readGitFacts("/r", git({ branch: { code: 0, stdout: "main\n" }, pushDefault: { code: 3, stdout: "" } }))).resolves.toBeNull();
    await expect(readGitFacts("/r", (async () => { throw new Error("no git"); }) as GitRun)).resolves.toBeNull();
  });
});
