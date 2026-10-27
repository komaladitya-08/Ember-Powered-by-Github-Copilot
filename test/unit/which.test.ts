/** platform/which.ts: where a command lives, with each OS's PATH rules (design §2.5, §9.6). */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { which } from "../../app/main/platform/which";

/** A file test over a fixed set of paths (Windows paths compared without regard to case, as NTFS does). */
const files = (list: string[], caseless = false) => {
  const key = (p: string) => (caseless ? p.toLowerCase() : p);
  const set = new Set(list.map(key));
  const asked: string[] = [];
  return { isExecutable: (p: string) => { asked.push(p); return set.has(key(p)); }, asked };
};

describe("which on Windows", () => {
  const env = { Path: "\"C:\\Program Files\\GitHub CLI\";C:\\Windows\\system32;;relative\\bin", PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS" };

  it("reads Path whatever the case of its name, strips quotes and finds the .exe", () => {
    const f = files(["C:\\Program Files\\GitHub CLI\\gh.exe"], true);
    expect(which("gh", { os: "win32", env, ...f })).toBe("C:\\Program Files\\GitHub CLI\\gh.exe");
  });

  it("tries .exe before .com, and never a .cmd or .bat file", () => {
    const f = files(["C:\\Windows\\system32\\tool.com", "C:\\Windows\\system32\\tool.exe", "C:\\Program Files\\GitHub CLI\\gh.cmd", "C:\\Windows\\system32\\gh.bat"], true);
    expect(which("tool", { os: "win32", env, ...f })).toBe("C:\\Windows\\system32\\tool.exe");
    expect(which("gh", { os: "win32", env, ...f })).toBeNull();
    expect(which("gh.cmd", { os: "win32", env, ...f })).toBeNull();
    expect(f.asked.some(p => /\.(cmd|bat)$/i.test(p))).toBe(false);
  });

  it("takes a name that already ends in .exe or .com as it is", () => {
    const f = files(["C:\\Windows\\system32\\where.exe"], true);
    expect(which("where.exe", { os: "win32", env, ...f })).toBe("C:\\Windows\\system32\\where.exe");
    expect(f.asked).toEqual(["C:\\Program Files\\GitHub CLI\\where.exe", "C:\\Windows\\system32\\where.exe"]);
  });

  it("tries only the extensions PATHEXT lists, when it is set", () => {
    const f = files(["C:\\Windows\\system32\\tool.com"], true);
    expect(which("tool", { os: "win32", env: { PATH: "C:\\Windows\\system32", PATHEXT: ".EXE" }, ...f })).toBeNull();
    expect(which("tool", { os: "win32", env: { PATH: "C:\\Windows\\system32" }, ...f })).toBe("C:\\Windows\\system32\\tool.com");
  });

  it("never searches the working folder (empty or relative Path entries are skipped)", () => {
    const f = files([]);
    which("gh", { os: "win32", env, ...f });
    expect(f.asked.every(p => path.win32.isAbsolute(p))).toBe(true);
    expect(f.asked.some(p => p.startsWith("relative"))).toBe(false);
  });

  it("looks in the extra folders after Path", () => {
    const f = files(["C:\\Users\\ada\\scoop\\shims\\gh.exe"], true);
    expect(which("gh", { os: "win32", env: { Path: "C:\\Windows" }, extraDirs: ["C:\\Users\\ada\\scoop\\shims"], ...f })).toBe("C:\\Users\\ada\\scoop\\shims\\gh.exe");
  });

  it("checks a full path as it is, with the same extension rules", () => {
    const f = files(["C:\\tools\\gh.exe", "C:\\tools\\run.cmd"], true);
    expect(which("C:\\tools\\gh", { os: "win32", env: {}, ...f })).toBe("C:\\tools\\gh.exe");
    expect(which("C:\\tools\\run.cmd", { os: "win32", env: {}, ...f })).toBeNull();
  });

  it("finds nothing without a Path", () => {
    expect(which("gh", { os: "win32", env: {}, ...files(["C:\\Windows\\gh.exe"]) })).toBeNull();
  });
});

describe("which on macOS", () => {
  it("adds the folders a Finder-started app's PATH lacks (Homebrew, MacPorts), after PATH", () => {
    const f = files(["/opt/homebrew/bin/gh", "/usr/local/bin/gh"]);
    const extraDirs = ["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
    expect(which("gh", { os: "darwin", env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, extraDirs, ...f })).toBe("/opt/homebrew/bin/gh");
    expect(f.asked.slice(0, 4)).toEqual(["/usr/bin/gh", "/bin/gh", "/usr/sbin/gh", "/sbin/gh"]);
  });

  it("takes the name as it is (no extensions)", () => {
    const f = files(["/usr/bin/gh.exe"]);
    expect(which("gh", { os: "darwin", env: { PATH: "/usr/bin" }, ...f })).toBeNull();
  });
});

describe("which on Linux", () => {
  it("splits PATH on colons and defaults to /usr/bin:/bin, as main.ts and the desk did", () => {
    const f = files(["/bin/pactl"]);
    expect(which("pactl", { os: "linux", env: {}, ...f })).toBe("/bin/pactl");
    expect(f.asked).toEqual(["/usr/bin/pactl", "/bin/pactl"]);
    expect(which("pactl", { os: "linux", env: { PATH: "/opt/x:/bin" }, ...files(["/bin/pactl"]) })).toBe("/bin/pactl");
  });

  it("tests X_OK by default: a file that isn't executable doesn't count", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-which-"));
    fs.writeFileSync(path.join(dir, "tool"), "#!/bin/sh\n", { mode: 0o755 });
    fs.writeFileSync(path.join(dir, "plain"), "", { mode: 0o644 });
    const env = { PATH: dir };
    if (process.platform !== "win32") {
      expect(which("tool", { os: "linux", env })).toBe(path.join(dir, "tool"));
      expect(which("plain", { os: "linux", env })).toBeNull();
    }
    expect(which("missing", { os: "linux", env })).toBeNull();
  });
});
