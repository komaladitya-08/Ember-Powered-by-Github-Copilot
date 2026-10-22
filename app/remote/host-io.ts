/**
 * The real machine behind the agent's pure modules: what main.ts injects into them on a remote. Every program runs with
 * a fixed argv, a timeout and no shell, and nothing here throws: a reader that fails answers null ("couldn't tell"),
 * which every caller treats as the safe answer. Linux reads /proc; macOS uses ps. Plain Node; a target's paths through
 * node:path/posix.
 */

import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path/posix";
import type { DesktopIo } from "./desktop-linux";
import { hashLine, type AgentOs } from "./places";
import { processStart } from "./lock";

/** A program's stdout (null when it failed or took longer than `timeoutMs`). */
export function run(program: string, args: string[], o: { env?: NodeJS.ProcessEnv; timeoutMs?: number; input?: string } = {}): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    try {
      const child = execFile(program, args, { env: o.env ?? { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" }, timeout: o.timeoutMs ?? 3000, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: stdout ?? "", stderr: stderr ?? "" });
      });
      if (o.input !== undefined) child.stdin?.end(o.input);
      child.stdin?.on("error", () => { /* it exited before reading */ });
    } catch {
      resolve({ ok: false, stdout: "", stderr: "" });
    }
  });
}

/** A file's text, or null. */
function readText(p: string): string | null {
  try { return fs.readFileSync(p, "utf8"); } catch { return null; }
}

/** The machine-id hash (§5.1.9's `machine`): /etc/machine-id (Linux) or the platform UUID (macOS), as sha256sum hashes it. */
export async function machineHash(agentOs: AgentOs): Promise<string> {
  if (agentOs === "linux") {
    // An empty /etc/machine-id (a container's, or a first boot's) falls through to D-Bus's.
    const id = ["/etc/machine-id", "/var/lib/dbus/machine-id"].map(readText).find(t => t?.trim());
    if (id) return hashLine(id);
  } else {
    const r = await run("/usr/sbin/ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]);
    const m = /"IOPlatformUUID" = "([^"]+)"/.exec(r.stdout);
    if (m) return hashLine(m[1]);
  }
  // No machine id: the host name stands in (the state folder still keeps machines apart by it).
  return hashLine(`no-machine-id ${os.hostname()}`);
}

/** Is this Linux WSL on some Windows PC (§5.1.9's `wsl`)? */
export function isWslHost(): boolean {
  return fs.existsSync("/proc/sys/fs/binfmt_misc/WSLInterop") || fs.existsSync("/proc/sys/fs/binfmt_misc/WSLInterop-late")
    || /microsoft/i.test(readText("/proc/version") ?? "");
}

/** A process's start time (lock.ts processStart) on this machine. */
export function startOf(agentOs: AgentOs): (pid: number) => string | null {
  return pid => processStart(agentOs, pid, {
    stat: p => readText(`/proc/${p}/stat`),
    ps: p => {
      // Synchronous on purpose: the lock and the orphan sweep ask before anything is served.
      try {
        return execFileSync("/bin/ps", ["-o", "lstart=", "-p", String(p)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
      } catch {
        return null;
      }
    },
  });
}

/** Runs the environment sweep (contracts' sweepScript) for a run id with a signal; resolves when it has finished. */
export function sweeper(script: string): (runId: string, signal: "INT" | "TERM" | "KILL") => Promise<void> {
  return (runId, signal) => {
    if (!/^[0-9a-f]{16}$/.test(runId)) return Promise.resolve();
    return run("/bin/sh", ["-s", "--", signal, runId], { input: script, timeoutMs: 3000 }).then(() => undefined);
  };
}

/** `pkill -<SIG> -s <sid>`: every process of a session. */
export async function killSession(sid: number, signal: "TERM" | "KILL"): Promise<void> {
  if (!Number.isInteger(sid) || sid <= 1) return;
  await run("pkill", [`-${signal}`, "-s", String(sid)], { timeoutMs: 2000 });
}

/** The first child of a process (`pgrep -P`), or null. */
export async function childOf(pid: number): Promise<number | null> {
  const r = await run("pgrep", ["-P", String(pid)], { timeoutMs: 2000 });
  const first = Number(r.stdout.trim().split(/\s+/)[0]);
  return Number.isInteger(first) && first > 1 ? first : null;
}

/** macOS: Homebrew's folders and /etc/paths(.d) lines that exist, as data (§3.3.1); [] elsewhere. */
export function extraPath(agentOs: AgentOs): string[] {
  if (agentOs !== "darwin") return [];
  const out: string[] = [];
  const add = (p: string) => {
    const dir = p.trim();
    if (!dir.startsWith("/") || out.includes(dir)) return;
    try { if (fs.statSync(dir).isDirectory()) out.push(dir); } catch { /* not there */ }
  };
  for (const p of ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"]) add(p);
  for (const l of (readText("/etc/paths") ?? "").split("\n")) add(l);
  let extra: string[] = [];
  try { extra = fs.readdirSync("/etc/paths.d").sort(); } catch { /* none */ }
  for (const f of extra) for (const l of (readText(path.join("/etc/paths.d", f)) ?? "").split("\n")) add(l);
  return out;
}

/** macOS: commands over SSH can't open ~/Documents without "full disk access for remote users" (L6). */
export function tccLimited(agentOs: AgentOs, home: string): boolean | undefined {
  if (agentOs !== "darwin") return undefined;
  try {
    fs.readdirSync(path.join(home, "Documents"));
    return false;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM" || (err as NodeJS.ErrnoException).code === "EACCES";
  }
}

/** The fixed loginctl properties discovery reads (§5.3.4 step 2). */
const SESSION_PROPS = ["Id", "User", "Type", "Class", "Active", "State", "Remote", "Seat", "Display", "LockedHint"];

/** DesktopIo over this Linux machine: loginctl, busctl on the user's bus, /proc. */
export function realDesktopIo(o: { uid: number; user: string; home: string; host: string }): DesktopIo {
  const runtime = `/run/user/${o.uid}`;
  // busctl --user finds the user's bus from these, never from the SSH login's own variables.
  const busEnv = { PATH: "/usr/bin:/bin", HOME: o.home, XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtime}/bus` };
  return {
    uid: o.uid,
    user: o.user,
    host: o.host,
    home: o.home,
    showUser: async uid => {
      const r = await run("loginctl", ["show-user", String(uid), "-p", "Display", "-p", "Sessions"]);
      return r.ok ? r.stdout : null;
    },
    showSession: async id => {
      const r = await run("loginctl", ["show-session", id, ...SESSION_PROPS.flatMap(p => ["-p", p])]);
      return r.ok ? r.stdout : null;
    },
    managerEnvironment: async () => {
      const r = await run("busctl", ["--user", "get-property", "org.freedesktop.systemd1", "/org/freedesktop/systemd1", "org.freedesktop.systemd1.Manager", "Environment"], { env: busEnv });
      return r.ok ? r.stdout : null;
    },
    gnomeScreenSaver: async () => {
      const r = await run("busctl", ["--user", "call", "org.gnome.ScreenSaver", "/org/gnome/ScreenSaver", "org.gnome.ScreenSaver", "GetActive"], { env: busEnv });
      if (r.ok) return r.stdout;
      // Not a GNOME session: nothing owns the name (and nothing can start it).
      return /ServiceUnknown|was not provided by any|not activatable|NameHasNoOwner/i.test(r.stderr) ? "absent" : null;
    },
    processes: async () => {
      let names: string[];
      try { names = fs.readdirSync("/proc"); } catch { return []; }
      return names.filter(n => /^\d+$/.test(n)).map(Number).filter(pid => {
        try { return fs.statSync(`/proc/${pid}`).uid === o.uid; } catch { return false; }
      });
    },
    cgroup: async pid => readText(`/proc/${pid}/cgroup`),
    environ: async pid => {
      try { return fs.readFileSync(`/proc/${pid}/environ`); } catch { return null; }
    },
    socketOwnedBy: async (p, uid) => {
      try {
        const st = fs.lstatSync(p);
        return st.isSocket() && st.uid === uid;
      } catch {
        return false;
      }
    },
    exists: async p => fs.existsSync(p),
    emberRunning: async () => {
      // Electron's single-instance lock: a link to "<host>-<pid>" in Ember's own folder.
      let target: string;
      try { target = fs.readlinkSync(path.join(o.home, ".config/ember/SingletonLock")); } catch { return false; }
      const m = /^(.*)-(\d+)$/.exec(target);
      if (!m || m[1] !== os.hostname()) return false;
      try {
        process.kill(Number(m[2]), 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    },
  };
}

/** Starts a program detached in its own group, its stdio piped (the desktop child). */
export function spawnGroup(program: string, args: string[], env: NodeJS.ProcessEnv) {
  return spawn(program, args, { detached: true, env, stdio: ["pipe", "pipe", "pipe"] });
}
