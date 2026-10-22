/**
 * Target paths (design §3.4.4, §3.6, critique integration-11): every path is resolved and judged with the target's
 * rules, never the PC's. The POSIX corpus runs here with `node:path/win32` unavailable to the code and
 * `process.platform` saying "win32", and gives the same answers; then the path helpers one by one.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

/** While `blocked.on`, path.win32 is unavailable: every use is recorded and throws (none may happen for POSIX targets). */
const blocked = vi.hoisted(() => ({ on: false, used: [] as string[] }));
vi.mock("node:path/win32", async importOriginal => {
  const real = ((await importOriginal()) as { default: Record<string, unknown> }).default;
  const trap = new Proxy(real, {
    get(target, key) {
      if (!blocked.on || typeof key === "symbol" || key === "then" || key === "__esModule") return target[key as string];
      blocked.used.push(String(key));
      return () => { throw new Error(`path.win32.${String(key)} used for a POSIX target`); };
    },
  });
  return { default: trap };
});
const used = blocked.used;

import * as P from "../../app/main/commands/paths";
import { loadCorpus, problemsOf, runCase } from "../fixtures/commands/corpus";

describe("the POSIX corpus with path.win32 unavailable, on a PC that says it is Windows", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");
  const corpus = loadCorpus("posix");
  beforeAll(() => { Object.defineProperty(process, "platform", { value: "win32" }); blocked.on = true; });
  afterAll(() => { blocked.on = false; if (platform) Object.defineProperty(process, "platform", platform); });

  it("decides every case as the corpus says, without touching path.win32", () => {
    used.length = 0;
    const problems = corpus.cases.map(c => problemsOf(c, runCase(c, corpus))).filter(p => p !== "");
    expect(problems).toEqual([]);
    expect(used).toEqual([]);
    expect(process.platform).toBe("win32");
  });

  it("resolves POSIX paths with POSIX rules", () => {
    const lin = { os: "linux" as const, home: "/home/ana", cwd: "/home/ana/proj" };
    expect(P.resolveTargetPath("~/x", lin)).toBe("/home/ana/x");
    expect(P.resolveTargetPath("..\\a", lin)).toBe("/home/ana/proj/..\\a");
    expect(used).toEqual([]);
  });

  it("is a real block: resolving a Windows path would use path.win32", () => {
    expect(() => P.resolveTargetPath("x", { os: "win32", home: "C:\\Users\\ana", cwd: "C:\\Users\\ana" })).toThrow(/path\.win32/);
    used.length = 0;
  });
});

const lin = { os: "linux" as const, home: "/home/ana", cwd: "/home/ana/proj" };
const envL = P.pathEnv({ flavour: "posix", os: "linux", home: "/home/ana", cwd: "/home/ana/proj" });
const envD = P.pathEnv({ flavour: "posix", os: "darwin", home: "/Users/ana", cwd: "/Users/ana/proj" });
const envU = P.pathEnv({ flavour: "posix", os: "linux", home: null, cwd: null });
const envH = P.pathEnv({ flavour: "posix", os: "linux", home: "/home/ana", cwd: "/home/ana" });

describe("resolveTargetPath (POSIX)", () => {
  it.each([
    ["~/x", "/home/ana/x"], ["~", "/home/ana"], ["../a", "/home/ana/a"], ["/a/b/../c", "/a/c"], ["x//y/", "/home/ana/proj/x/y"],
    ["./", "/home/ana/proj"], ["/", "/"], ["a/../../..", "/home"],
  ])("%j → %j", (p, want) => {
    expect(P.resolveTargetPath(p, lin)).toBe(want);
  });
  it("uses the home it is given on macOS", () => {
    expect(P.resolveTargetPath("~/Library/X", { os: "darwin", home: "/Users/ana", cwd: "/Users/ana" })).toBe("/Users/ana/Library/X");
  });
});

describe("POSIX path rules", () => {
  it("compares paths by segment, without case on macOS and drive mounts", () => {
    expect(P.isUnder("/home/ana/proj/x", "/home/ana/proj", envL)).toBe(true);
    expect(P.isUnder("/home/ana/project", "/home/ana/proj", envL)).toBe(false);
    expect(P.isUnder("/HOME/ana/x", "/home/ana", envL)).toBe(false);
    expect(P.isUnder("/Users/ANA/x", "/Users/ana", envD)).toBe(true);
    const envM = P.pathEnv({ flavour: "posix", os: "linux", home: "/home/ana", cwd: null, mountRoot: "/mnt" });
    expect(P.isUnder("/mnt/C/Users/x", "/mnt/c/users", envM)).toBe(true);
  });

  it.each([
    ["/home/ana/.ssh/id_rsa", "read", "secret"], ["/home/ana/.ssh/id_rsa.pub", "read", null], ["/home/ana/.ssh/known_hosts", "read", null],
    ["/home/ana/.ssh", "list", null], ["/home/ana/.bash_history", "read", "history"], ["/etc/shadow", "read", "secret"],
    ["/home/ana/proj/.env", "read", "secret"], ["/home/ana/proj/.env.example", "read", null], ["/home/ana/.aws/credentials", "write", "secret"],
    ["/proc/123/environ", "read", "secret"], ["/root/x", "read", "secret"], ["/home/bob/.netrc", "read", "secret"], ["/home/ana/proj/a.ts", "read", null],
  ] as const)("secretKind(%j, %s) → %s", (p, use, want) => {
    expect(P.secretKind(p, use, envL)).toBe(want);
  });

  it("finds secrets without regard to case on macOS, and in any home when the home isn't known", () => {
    expect(P.secretKind("/Users/ana/Library/Keychains/login.keychain-db", "read", envD)).toBe("secret");
    expect(P.secretKind("/USERS/ana/.SSH/id_rsa", "read", envD)).toBe("secret");
    expect(P.secretKind("/home/x/.ssh/id_rsa", "read", envU)).toBe("secret");
    expect(P.secretKind("/home/~/.aws/credentials", "read", envU)).toBe("secret");
  });

  it.each([
    ["/home/ana/.bashrc", "startup"], ["/home/ana/.config/fish/config.fish", "startup"], ["/etc/profile.d/x.sh", "startup"],
    ["/home/ana/proj/.git/hooks/pre-commit", "hook"], ["/etc/wsl.conf", "wsl-config"], ["/etc/hosts", "system"], ["/usr/local/bin/x", "system"],
    ["/var/tmp/x", null], ["/dev/sda", "disk"], ["/dev/null", null], ["/home/ana/.config/autostart/x.desktop", "autostart"], ["/home/ana/proj/x", null], ["/tmp/x", null],
  ])("writeKind(%j) → %s", (p, want) => {
    expect(P.writeKind(p, envL)).toBe(want);
  });

  it("knows WSL's configuration and the Windows system folders under the drive mount", () => {
    const envM = P.pathEnv({ flavour: "posix", os: "linux", home: "/home/ana", cwd: null, mountRoot: "/mnt", windows: P.windowsContextOf("C:\\Users\\ana") });
    expect(P.writeKind("/mnt/c/Users/ana/.wslconfig", envM)).toBe("wsl-config");
    expect(P.writeKind("/mnt/c/Windows/x", envM)).toBe("system");
    expect(P.isEmberPath("/mnt/c/Users/ana/AppData/Local/ember", envM)).toBe(true);
  });

  it("knows Ember's own folders, and the folders above them", () => {
    expect(P.isEmberPath("/home/ana/.config/ember/x", envL)).toBe(true);
    expect(P.isEmberPath("/home/ana/.local/share/ember-x/y", envL)).toBe(true);
    expect(P.isEmberPath("/etc/ember/policy.json", envL)).toBe(true);
    expect(P.isEmberPath("/home/zed/.local/state/ember-remote", envU)).toBe(true);
    expect(P.holdsEmberPath("/home/ana/.config", envL)).toBe(true);
    expect(P.holdsEmberPath("/home/ana/proj", envL)).toBe(false);
    expect(P.holdsEmberPath("/home", envU)).toBe(true);
    expect(P.holdsEmberPath("/tmp", envU)).toBe(false);
  });

  it("has an empty work tree when the folder is the home or above it; temporary folders always count", () => {
    expect(P.inWorkTree("/home/ana/proj/x", envL)).toBe(true);
    expect(P.inWorkTree("/home/ana/x", envL)).toBe(false);
    expect(P.inWorkTree("/tmp/x", envL)).toBe(true);
    expect(P.inWorkTree("/home/ana/x", envH)).toBe(false);
    expect(P.isTemp("/var/tmp/x", envL)).toBe(true);
    expect(P.isTemp("/home/ana/tmp", envL)).toBe(false);
  });

  it("knows home dot files and broad paths", () => {
    expect(P.homeDotFile("/home/ana/.gitconfig", envL)).toBe(true);
    expect(P.homeDotFile("/home/ana/proj/.env", envL)).toBe(false);
    for (const p of ["/", "/home", "/home/ana", "/home/ana/proj"]) expect(P.isBroadPath(p, envL)).toBe(true);
    expect(P.isBroadPath("/home/ana/proj/build", envL)).toBe(false);
  });

  it("matches globs with the shell's dot rule, and finds their fixed folder", () => {
    expect(P.globRegExp("/home/ana/proj/*", envL, true).test("/home/ana/proj/.env")).toBe(false);
    expect(P.globRegExp("/home/ana/proj/*", envL, false).test("/home/ana/proj/.env")).toBe(true);
    expect(P.globRegExp("/home/ana/proj/*.log", envL, true).test("/home/ana/proj/a/b.log")).toBe(false);
    expect(P.globRegExp("/home/ana/[ab].txt", envL, true).test("/home/ana/b.txt")).toBe(true);
    expect(P.globPrefix("/home/ana/proj/src/*.ts", envL)).toBe("/home/ana/proj/src");
    expect(P.globPrefix("/home/ana/*/x", envL)).toBe("/home/ana");
  });

  it("judges a glob by every name it could match: secret folders and names, Ember's folders (critique: glob evasion)", () => {
    const reach = (g: string, use: P.PathUse = "read"): { secret: boolean; ember: boolean } => P.globReaches(g, use, envL, true);
    for (const g of ["/home/ana/.ss[h]/id_rsa", "/home/ana/.s*/config.bak", "/home/*/.ssh/id_rsa", "/home/ana/*/id_rsa", "/proc/[0-9]*/environ", "/home/ana/proj/*/.env"]) {
      expect(reach(g).secret, g).toBe(true);
    }
    for (const g of ["/home/ana/proj/*.txt", "/home/ana/proj/src/*.ts", "/home/ana/proj/*", "/home/ana/*/notes.md"]) expect(reach(g).secret, g).toBe(false);
    expect(reach("/home/ana/.s*", "list").secret).toBe(false);
    expect(reach("/home/ana/.s*", "readTree").secret).toBe(true);
    expect(reach("/home/ana/.config/emb*/settings.json").ember).toBe(true);
    expect(reach("/home/ana/.conf*").ember).toBe(false);
    expect(reach("/home/ana/.conf*", "deleteTree").ember).toBe(true);
  });

  it("finds start-up files, hooks and git's settings behind a glob being written", () => {
    expect(P.globWriteKind("/home/ana/.bash?c", envL, true)).toBe("startup");
    expect(P.globWriteKind("/home/ana/proj/.git/hoo*/pre-commit", envL, true)).toBe("hook");
    expect(P.globWriteKind("/home/ana/proj/.git/c*", envL, true)).toBe("git-config");
    expect(P.globWriteKind("/home/ana/proj/*.log", envL, true)).toBeNull();
    expect(P.writeKind("/home/ana/proj/.git/config", envL)).toBe("git-config");
    expect(P.writeKind("/home/ana/.gitconfig", envL)).toBe("git-config");
    expect(P.writeKind("/home/ana/proj/.gitignore", envL)).toBeNull();
  });

  it("maps Windows paths to the drive mount", () => {
    expect(P.toMount("C:\\Users\\ana", "/mnt")).toBe("/mnt/c/Users/ana");
    expect(P.toMount("D:\\", "/mnt/")).toBe("/mnt/d");
    expect(P.toMount("/x", "/mnt")).toBe("/x");
  });
});

const win = { os: "win32" as const, home: "C:\\Users\\ana", cwd: "C:\\Users\\ana\\proj" };
const envW = P.pathEnv({ flavour: "win32", os: "win32", home: win.home, cwd: win.cwd, windows: P.windowsContextOf(win.home) });

describe("resolveTargetPath (Windows)", () => {
  it.each([
    ["~\\x", "C:\\Users\\ana\\x"], ["~/x", "C:\\Users\\ana\\x"], ["..\\a", "C:\\Users\\ana\\a"], ["C:/x/y", "C:\\x\\y"],
    ["c:\\X\\..\\y", "C:\\y"], ["\\\\server\\share\\x", "\\\\server\\share\\x"], ["C:x", "C:\\Users\\ana\\proj\\x"], ["D:x", "D:\\x"],
    ["\\x", "C:\\x"], ["x/y\\z", "C:\\Users\\ana\\proj\\x\\y\\z"], ["C:\\", "C:\\"],
  ])("%j → %j", (p, want) => {
    expect(P.resolveTargetPath(p, win)).toBe(want);
  });
});

describe("Windows path rules", () => {
  it("compares without regard to case", () => {
    expect(P.isUnder("c:\\users\\ANA\\x", "C:\\Users\\ana", envW)).toBe(true);
    expect(P.globRegExp("C:\\x\\*.TXT", envW, false).test("c:\\x\\a.txt")).toBe(true);
  });

  it.each([
    ["C:\\Users\\ana\\.ssh\\id_rsa", "secret"], ["c:\\users\\ana\\AppData\\Roaming\\Microsoft\\Credentials\\x", "secret"],
    ["C:\\Windows\\System32\\config\\SAM", "secret"], ["C:\\Users\\ana\\AppData\\Roaming\\Microsoft\\Windows\\PowerShell\\PSReadLine\\ConsoleHost_history.txt", "history"],
    ["C:\\Users\\ana\\proj\\a.txt", null],
  ])("secretKind(%j) → %s", (p, want) => {
    expect(P.secretKind(p, "read", envW)).toBe(want);
  });

  it.each([
    ["C:\\Users\\ana\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1", "startup"], ["C:\\Users\\ana\\.wslconfig", "wsl-config"],
    ["C:\\Windows\\x", "system"], ["C:\\Program Files (x86)\\x", "system"], ["C:\\ProgramData\\x", "system"],
    ["C:\\Users\\ana\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup\\x.lnk", "autostart"], ["\\\\.\\PhysicalDrive0", "disk"],
    ["C:\\Users\\ana\\proj\\x", null],
  ])("writeKind(%j) → %s", (p, want) => {
    expect(P.writeKind(p, envW)).toBe(want);
  });

  it("knows Ember's folders, home dot files, temporary folders and broad paths", () => {
    expect(P.isEmberPath("C:\\Users\\ana\\AppData\\Local\\Ember\\x", envW)).toBe(true);
    expect(P.holdsEmberPath("C:\\Users", envW)).toBe(true);
    expect(P.homeDotFile("C:\\Users\\ana\\.npmrc", envW)).toBe(true);
    expect(P.isTemp("C:\\Users\\ana\\AppData\\Local\\Temp\\x", envW)).toBe(true);
    expect(P.isBroadPath("C:\\", envW)).toBe(true);
    expect(P.isBroadPath("C:\\Users", envW)).toBe(true);
    expect(P.globPrefix("C:\\x\\*\\y", envW)).toBe("C:\\x");
  });
});

describe("Windows path forms", () => {
  it("reads \\\\wsl.localhost and \\\\wsl$ forms as a distro and a POSIX path", () => {
    expect(P.wslUncPath("\\\\wsl.localhost\\Ubuntu\\home\\ana\\.netrc")).toEqual({ distro: "Ubuntu", path: "/home/ana/.netrc" });
    expect(P.wslUncPath("\\\\WSL$\\Debian\\")).toEqual({ distro: "Debian", path: "/" });
    expect(P.wslUncPath("\\\\?\\UNC\\wsl.localhost\\U\\x")).toEqual({ distro: "U", path: "/x" });
    expect(P.wslUncPath("\\\\server\\share")).toBeNull();
  });

  it("calls device paths and admin shares opaque", () => {
    expect(P.opaqueWindowsPath("\\\\?\\C:\\x")).toBe("device");
    expect(P.opaqueWindowsPath("\\\\.\\C:")).toBe("device");
    expect(P.opaqueWindowsPath("\\\\localhost\\c$\\x")).toBe("admin-share");
    expect(P.opaqueWindowsPath("\\\\127.0.0.1\\c$\\x")).toBe("admin-share");
    expect(P.opaqueWindowsPath("\\\\server\\share\\x")).toBeNull();
    expect(P.SHORT_NAME.test("C:\\PROGRA~1\\x")).toBe(true);
    expect(P.SHORT_NAME.test("C:\\Users\\ana\\x~y")).toBe(false);
  });
});
