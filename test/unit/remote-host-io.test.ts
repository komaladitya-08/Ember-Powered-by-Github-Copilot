/**
 * The remote agent's real-machine adapters (app/remote/host-io.ts): programs run with fixed argv and a timeout, nothing
 * throws, and every reader's failure is the safe answer (null/false/[]). Linux runs the real /proc, pgrep, /bin/sh and
 * socket checks; the pure parts (argv guards, extraPath, tccLimited, isWslHost) run everywhere.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { childOf, extraPath, isWslHost, killSession, realDesktopIo, run, spawnGroup, startOf, sweeper, tccLimited } from "../../app/remote/host-io";

/** Every program host-io hands to execFile, so a guard that must not run pkill can be checked without running it. */
const execCalls = vi.hoisted(() => [] as { program: string; args: string[]; options?: { env?: NodeJS.ProcessEnv } }[]);
/** Canned execFile answers keyed by program, for tests of the systemd/D-Bus readers (empty means run the real program). */
const execAnswers = vi.hoisted(() => new Map<string, { err: Error | null; stdout: string; stderr: string }>());
vi.mock("node:child_process", async importOriginal => {
  const real = await importOriginal<typeof import("node:child_process")>();
  const execFile = ((...args: Parameters<typeof real.execFile>) => {
    const [program, argv, options] = args;
    const captured = typeof options === "object" && options !== null ? options as { env?: NodeJS.ProcessEnv } : undefined;
    execCalls.push({ program: String(program), args: Array.isArray(argv) ? argv.map(String) : [], options: captured });
    const answer = execAnswers.get(String(program));
    if (answer) {
      const callback = args.find(a => typeof a === "function") as ((err: Error | null, stdout: string, stderr: string) => void) | undefined;
      queueMicrotask(() => callback?.(answer.err, answer.stdout, answer.stderr));
      return { stdin: { end() {}, on() {} } } as unknown as ReturnType<typeof real.execFile>;
    }
    return real.execFile(...args);
  }) as typeof real.execFile;
  return { ...real, execFile };
});
const execFileAnswer = (program: string, result: Partial<{ err: Error | null; stdout: string; stderr: string }> = {}) => {
  execAnswers.set(program, { err: result.err ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
};

const dirs: string[] = [];
const tempDir = (prefix = "ember-host-io-") => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};
/** A POSIX single-quoted shell word (temp paths are usually plain, this keeps them safe if they aren't). */
const shq = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;

const waitClose = (child: ChildProcess, ms = 5000) => new Promise<void>((resolve, reject) => {
  if (child.exitCode !== null || child.signalCode !== null) return resolve();
  const timer = setTimeout(() => reject(new Error("the child did not exit")), ms);
  child.once("close", () => { clearTimeout(timer); resolve(); });
});

afterEach(() => {
  vi.useRealTimers();
  execCalls.length = 0;
  execAnswers.clear();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe.runIf(process.platform === "linux")("run()", () => {
  it("resolves the program's stdout when it succeeds", async () => {
    await expect(run("/bin/echo", ["hello", "ember"])).resolves.toEqual({ ok: true, stdout: "hello ember\n", stderr: "" });
  });

  it("reports a failing program as ok:false, with its stderr and no throw", async () => {
    await expect(run("/bin/sh", ["-c", "printf boom >&2; exit 3"])).resolves.toEqual({ ok: false, stdout: "", stderr: "boom" });
  });

  it("reports a missing program as ok:false, with empty output and no throw", async () => {
    await expect(run("/no/such/ember-program", [])).resolves.toEqual({ ok: false, stdout: "", stderr: "" });
  });

  it("writes input to the program's stdin", async () => {
    await expect(run("/bin/cat", [], { input: "through stdin\n" })).resolves.toEqual({ ok: true, stdout: "through stdin\n", stderr: "" });
  });

  it("gives up quickly when a program outlives timeoutMs", async () => {
    const started = Date.now();
    await expect(run("/bin/sleep", ["5"], { timeoutMs: 100 })).resolves.toMatchObject({ ok: false });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("starts with only the fixed PATH, never the agent's own environment", async () => {
    const r = await run("/usr/bin/env", []);
    expect(r.ok).toBe(true);
    expect(r.stdout.trim().split("\n")).toEqual(["PATH=/usr/bin:/bin:/usr/sbin:/sbin"]);
    for (const key of Object.keys(process.env)) {
      if (key !== "PATH") expect(r.stdout).not.toContain(`${key}=`);
    }
  });
});

describe.runIf(process.platform === "linux")("sweeper()", () => {
  it("runs the script through /bin/sh -s with (signal, runId) as its arguments", async () => {
    const marker = path.join(tempDir(), "argv");
    const script = `printf '%s %s' "$1" "$2" > ${shq(marker)}\n`;
    await sweeper(script)("0123456789abcdef", "KILL");
    expect(fs.readFileSync(marker, "utf8")).toBe("KILL 0123456789abcdef");
  });

  it("runs nothing for a run id that isn't exactly 16 lowercase hex digits", async () => {
    const marker = path.join(tempDir(), "ran");
    const script = `printf ran > ${shq(marker)}\n`;
    for (const runId of ["", "0".repeat(15), "0".repeat(17), "0123456789ABCDEF", "0123456789abcdeg"]) {
      await sweeper(script)(runId, "TERM");
    }
    expect(fs.existsSync(marker)).toBe(false);
  });
});

describe("killSession()", () => {
  it("returns without running pkill unless the session id is an integer above 1", async () => {
    for (const sid of [0, 1, -5, 2.5, NaN]) await killSession(sid, "KILL");
    expect(execCalls).toEqual([]);
  });
});

describe.runIf(process.platform === "linux")("childOf()", () => {
  it("finds a real process's child, and answers null when there is none", async () => {
    const shell = spawn("/bin/sh", ["-c", "sleep 5 & wait"], { stdio: "ignore", detached: true });
    const shellPid = shell.pid!;
    try {
      let child: number | null = null;
      const until = Date.now() + 3000;
      while (child === null && Date.now() < until) {
        child = await childOf(shellPid);
        if (child === null) await new Promise(r => setTimeout(r, 20));
      }
      expect(Number.isInteger(child)).toBe(true);
      expect(child!).toBeGreaterThan(1);
      expect(() => process.kill(child!, 0)).not.toThrow();
      expect(await childOf(2147483647)).toBeNull();
    } finally {
      try { process.kill(-shellPid, "SIGKILL"); } catch { try { shell.kill("SIGKILL"); } catch { /* gone */ } }
      await waitClose(shell);
    }
  }, 10_000);
});

describe.runIf(process.platform === "linux")("startOf()", () => {
  it("reads a live Linux process's start time, and null when there is no such process", () => {
    const start = startOf("linux")(process.pid);
    expect(typeof start).toBe("string");
    expect(start).toMatch(/^\d+$/);
    expect(startOf("linux")(2147483647)).toBeNull();
  });
});

describe("extraPath(), tccLimited() and isWslHost()", () => {
  it("extraPath is [] away from macOS", () => {
    expect(extraPath("linux")).toEqual([]);
  });

  it("tccLimited is undefined away from macOS", () => {
    expect(tccLimited("linux", tempDir())).toBeUndefined();
  });

  it("isWslHost always answers a boolean", () => {
    expect(typeof isWslHost()).toBe("boolean");
  });
});

describe.runIf(process.platform === "linux")("tccLimited() on macOS semantics", () => {
  it("is false when ~/Documents can be listed, and for a folder that is not there", () => {
    const withDocuments = tempDir();
    fs.mkdirSync(path.join(withDocuments, "Documents"));
    expect(tccLimited("darwin", withDocuments)).toBe(false);
    expect(tccLimited("darwin", tempDir())).toBe(false);
  });
});

describe.runIf(process.platform === "linux")("realDesktopIo()", () => {
  const uid = process.getuid!();
  const ioFor = (home: string) => realDesktopIo({ uid, user: "ember-user", home, host: "ember-host" });

  it("echoes the user, uid, home and host it was given", () => {
    const home = tempDir();
    const io = ioFor(home);
    expect({ uid: io.uid, user: io.user, host: io.host, home: io.home }).toEqual({ uid, user: "ember-user", host: "ember-host", home });
  });

  it("reads this uid's processes, /proc/<pid>/cgroup and environ, null when they can't be read", async () => {
    const io = ioFor(tempDir());
    expect(await io.processes()).toContain(process.pid);
    expect(typeof await io.cgroup(process.pid)).toBe("string");
    expect(await io.cgroup(2147483647)).toBeNull();
    const environ = await io.environ(process.pid);
    expect(environ).not.toBeNull();
    expect(environ!.toString("utf8")).toContain("=");
    expect(await io.environ(2147483647)).toBeNull();
  });

  it("processes() lists this uid's processes only, not another uid's", async () => {
    expect(await ioFor(tempDir()).processes()).toContain(process.pid);
    const otherUid = uid === 0 ? 1 : uid + 12345;
    const other = realDesktopIo({ uid: otherUid, user: "other-user", home: tempDir(), host: "other-host" });
    expect(await other.processes()).not.toContain(process.pid);
  });

  it("owns a real unix socket only for its owner's uid, and never a file or missing path", async () => {
    const io = ioFor(tempDir());
    const socketDir = tempDir();
    const socketPath = path.join(socketDir, "bus.sock");
    const server = net.createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => resolve());
    });
    try {
      expect(await io.socketOwnedBy(socketPath, uid)).toBe(true);
      expect(await io.socketOwnedBy(socketPath, uid === 0 ? 1 : uid + 1)).toBe(false);
      const file = path.join(socketDir, "regular");
      fs.writeFileSync(file, "not a socket");
      expect(await io.socketOwnedBy(file, uid)).toBe(false);
      expect(await io.socketOwnedBy(path.join(socketDir, "missing"), uid)).toBe(false);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it("exists follows the file system", async () => {
    const home = tempDir();
    const io = ioFor(home);
    expect(await io.exists(home)).toBe(true);
    expect(await io.exists(path.join(home, "missing"))).toBe(false);
  });

  it("emberRunning is false without the single-instance lock", async () => {
    expect(await ioFor(tempDir()).emberRunning()).toBe(false);
  });

  it("emberRunning is true only for a live pid behind this host's SingletonLock", async () => {
    const lockFor = (home: string, target: string) => {
      const dir = path.join(home, ".config/ember");
      fs.mkdirSync(dir, { recursive: true });
      fs.symlinkSync(target, path.join(dir, "SingletonLock"));
    };

    const live = tempDir();
    lockFor(live, `${os.hostname()}-${process.pid}`);
    expect(await ioFor(live).emberRunning()).toBe(true);

    const otherHost = tempDir();
    lockFor(otherHost, `not-${os.hostname()}-${process.pid}`);
    expect(await ioFor(otherHost).emberRunning()).toBe(false);

    const exited = spawn("/bin/true", [], { stdio: "ignore" });
    const exitedPid = exited.pid!;
    await waitClose(exited);
    const dead = tempDir();
    lockFor(dead, `${os.hostname()}-${exitedPid}`);
    expect(await ioFor(dead).emberRunning()).toBe(false);
  }, 10_000);
});

describe.runIf(process.platform === "linux")("realDesktopIo() loginctl and busctl", () => {
  const uid = process.getuid!();
  const home = "/home/ember-user";
  const io = () => realDesktopIo({ uid, user: "ember-user", home, host: "ember-host" });
  const busEnv = {
    PATH: "/usr/bin:/bin",
    HOME: home,
    XDG_RUNTIME_DIR: `/run/user/${uid}`,
    DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${uid}/bus`,
  };
  const lastCall = () => execCalls[execCalls.length - 1];
  const userArgs = ["show-user", String(uid), "-p", "Display", "-p", "Sessions"];
  const sessionArgs = ["show-session", "42", "-p", "Id", "-p", "User", "-p", "Type", "-p", "Class", "-p", "Active", "-p", "State", "-p", "Remote", "-p", "Seat", "-p", "Display", "-p", "LockedHint"];
  const managerArgs = ["--user", "get-property", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "Environment"];
  const saverArgs = ["--user", "call", "org.gnome.ScreenSaver", "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver", "GetActive"];

  it("showUser passes loginctl show-user <uid> -p Display -p Sessions, and its stdout", async () => {
    execFileAnswer("loginctl", { stdout: "Display=1\nSessions=1 2\n" });
    await expect(io().showUser(uid)).resolves.toBe("Display=1\nSessions=1 2\n");
    expect(lastCall()).toMatchObject({ program: "loginctl", args: userArgs });
  });

  it("showUser is null when loginctl fails, with the same argv", async () => {
    execFileAnswer("loginctl", { err: new Error("no such user"), stderr: "Failed" });
    await expect(io().showUser(uid)).resolves.toBeNull();
    expect(lastCall()).toMatchObject({ program: "loginctl", args: userArgs });
  });

  it("showSession passes -p for every property in order, and its stdout", async () => {
    execFileAnswer("loginctl", { stdout: "Id=42\n" });
    await expect(io().showSession("42")).resolves.toBe("Id=42\n");
    expect(lastCall()).toMatchObject({ program: "loginctl", args: sessionArgs });
  });

  it("showSession is null when loginctl fails, with the same argv", async () => {
    execFileAnswer("loginctl", { err: new Error("no such session"), stderr: "Failed" });
    await expect(io().showSession("42")).resolves.toBeNull();
    expect(lastCall()).toMatchObject({ program: "loginctl", args: sessionArgs });
  });

  it("managerEnvironment passes busctl's exact argv, its stdout and the bus environment", async () => {
    execFileAnswer("busctl", { stdout: "s \"A=B\"\n" });
    await expect(io().managerEnvironment()).resolves.toBe("s \"A=B\"\n");
    expect(lastCall()).toMatchObject({ program: "busctl", args: managerArgs });
    expect(lastCall().options?.env).toEqual(busEnv);
  });

  it("managerEnvironment is null when busctl fails, still with the same argv and environment", async () => {
    execFileAnswer("busctl", { err: new Error("no bus"), stderr: "Failed" });
    await expect(io().managerEnvironment()).resolves.toBeNull();
    expect(lastCall()).toMatchObject({ program: "busctl", args: managerArgs });
    expect(lastCall().options?.env).toEqual(busEnv);
  });

  it("gnomeScreenSaver passes busctl's exact argv, its stdout and the bus environment", async () => {
    execFileAnswer("busctl", { stdout: "(b) true\n" });
    await expect(io().gnomeScreenSaver()).resolves.toBe("(b) true\n");
    expect(lastCall()).toMatchObject({ program: "busctl", args: saverArgs });
    expect(lastCall().options?.env).toEqual(busEnv);
  });

  it("gnomeScreenSaver is \"absent\" when the bus says the name is unowned", async () => {
    for (const stderr of ["Call failed: ServiceUnknown", "org.freedesktop.DBus.Error.NameHasNoOwner"]) {
      execFileAnswer("busctl", { err: new Error("unowned"), stderr });
      await expect(io().gnomeScreenSaver()).resolves.toBe("absent");
    }
  });

  it("gnomeScreenSaver is null for another busctl failure", async () => {
    execFileAnswer("busctl", { err: new Error("connection"), stderr: "Could not connect: Connection refused" });
    await expect(io().gnomeScreenSaver()).resolves.toBeNull();
    expect(lastCall()).toMatchObject({ program: "busctl", args: saverArgs });
    expect(lastCall().options?.env).toEqual(busEnv);
  });
});

describe.runIf(process.platform === "linux")("spawnGroup()", () => {
  it("starts a detached child in its own group with piped stdio, and its input reaches its output", async () => {
    const child = spawnGroup("/bin/cat", [], { PATH: "/usr/bin:/bin" });
    const pid = child.pid!;
    try {
      expect(pid).toBeGreaterThan(1);
      expect(child.stdin).not.toBeNull();
      expect(child.stdout).not.toBeNull();
      expect(child.stderr).not.toBeNull();
      expect(() => process.kill(-pid, 0)).not.toThrow();

      const got = await new Promise<string>((resolve, reject) => {
        let out = "";
        const timer = setTimeout(() => reject(new Error(`no echo; got ${JSON.stringify(out)}`)), 2000);
        child.stdout!.setEncoding("utf8");
        child.stdout!.on("data", (chunk: string) => {
          out += chunk;
          if (out.includes("ember-echo\n")) { clearTimeout(timer); resolve(out); }
        });
        child.once("error", err => { clearTimeout(timer); reject(err); });
        child.stdin!.write("ember-echo\n");
      });
      expect(got).toBe("ember-echo\n");
    } finally {
      try { process.kill(-pid, "SIGKILL"); } catch { try { child.kill("SIGKILL"); } catch { /* gone */ } }
      await waitClose(child);
    }
  }, 10_000);
});
