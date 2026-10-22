/**
 * Noticing the user's own ssh (R4, §2.7): read-only. The process list gives the user's own ssh clients and their
 * command lines; `sshDestination` takes out the host and the few options Ember's own connection carries over (-l, -p,
 * -J, -i, -F and an allow-list of -o keys), following OpenSSH's own option grammar, and drops everything else (-L, -R,
 * -D, -A, -X, ProxyCommand…): Ember's connection never forwards anything and never runs a command of the user's
 * choosing. Ember never touches the user's terminal or session; what it reads stays in memory and is shown only as an
 * offer (TG runs the poller and the offer). Readers: Linux /proc of this user's processes, macOS `ps`, Windows one CIM
 * query of this session's ssh.exe, and, with WSL on, one fixed reader per running distro. Plain Node.
 */

import { execFile } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { OS } from "../../shared/shortcuts";
import { DISTRO_NAME } from "../../shared/targets";
import { optionKey, parseTypedDestination, validDest, validHop, validOptionValue, validPort, validSshFile } from "./destination";
import { childEnv } from "./ssh-argv";
import type { SshSeen } from "./types";

/** OpenSSH's client options that take a value (ssh.c's getopt string: "b:c:e:i:l:m:o:p:B:D:E:F:I:J:L:O:P:Q:R:S:w:W:"). */
const WITH_VALUE = new Set("bceilmopBDEFIJLOPQRSwW".split(""));
/** And those that don't ("1246afgknqstvxACGKMNTVXYy"). */
const FLAGS = new Set("1246afgknqstvxACGKMNTVXYy".split(""));
/** Runs that don't connect to a host for a session: a version, a config dump, a mux control command, a query, tunnels. */
const NOT_A_SESSION = new Set(["V", "G", "O", "Q", "N", "W"]);
/** -o keys whose value decides where the connection goes: one Ember can't carry means it doesn't offer at all. */
const ROUTE_KEYS = new Set(["Port", "User", "ProxyJump", "HostName", "HostKeyAlias"]);

/** Is this program OpenSSH's client (ssh, ssh.exe, by any path)? */
export function isSshProgram(argv0: string): boolean {
  const base = argv0.split(/[\\/]/).pop() ?? "";
  return /^ssh(\.exe)?$/i.test(base);
}

/** The destination an OpenSSH client command line connects to, or null (a -V, -G, -O, -Q run, a -W/-N tunnel, no host). */
export function sshDestination(argv: readonly string[]): SshSeen | null {
  if (!argv.length || !isSshProgram(argv[0])) return null;
  const seen: Omit<SshSeen, "dest"> & { dest?: string } = {};
  const identityFiles: string[] = [];
  const options: Record<string, string> = {};
  let dest: string | null = null;
  let i = 1;
  // ssh.c parses options before and after the destination; the first other word after it starts the command.
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      if (dest === null) { dest = argv[i + 1] ?? null; i++; continue; }
      break;
    }
    if (!a.startsWith("-") || a === "-") {
      if (dest !== null) break;
      dest = a;
      continue;
    }
    for (let k = 1; k < a.length; k++) {
      const c = a[k];
      if (FLAGS.has(c)) {
        if (NOT_A_SESSION.has(c)) return null;
        continue;
      }
      if (!WITH_VALUE.has(c)) return null;
      if (NOT_A_SESSION.has(c)) return null;
      const value = k + 1 < a.length ? a.slice(k + 1) : argv[++i];
      if (value === undefined) return null;
      if (!carry(c, value, seen, identityFiles, options)) return null;
      break;
    }
  }
  if (dest === null) return null;
  // ssh://user@host:port: user and port taken apart, as for a destination typed in settings.
  if (/^ssh:\/\//i.test(dest)) {
    const typed = parseTypedDestination(dest);
    if (!typed) return null;
    dest = typed.dest;
    if (typed.port !== undefined && seen.port === undefined) seen.port = typed.port;
  }
  if (!validDest(dest)) return null;
  return {
    dest,
    ...(seen.user !== undefined ? { user: seen.user } : {}),
    ...(seen.port !== undefined ? { port: seen.port } : {}),
    ...(seen.jump ? { jump: seen.jump } : {}),
    ...(identityFiles.length ? { identityFiles } : {}),
    ...(seen.configFile !== undefined ? { configFile: seen.configFile } : {}),
    ...(Object.keys(options).length ? { options } : {}),
  };
}

/** One option's value carried over, dropped, or (false) a route Ember can't reproduce, so no offer. */
function carry(c: string, v: string, seen: Omit<SshSeen, "dest">, ids: string[], options: Record<string, string>): boolean {
  switch (c) {
    case "l":
      if (!/^[A-Za-z0-9._-]{1,64}$/.test(v)) return false;
      seen.user = v;
      return true;
    case "p": {
      const n = Number(v);
      if (!/^\d{1,5}$/.test(v) || !validPort(n)) return false;
      seen.port = n;
      return true;
    }
    case "J": {
      if (v.toLowerCase() === "none") return true;
      const hops = v.split(",");
      if (!hops.every(validHop)) return false;
      seen.jump = hops;
      return true;
    }
    case "i":
      // A relative key file is relative to a folder Ember can't know: left to the agent and the user's config.
      if (validSshFile(v)) ids.push(v);
      return true;
    case "F":
      if (!validSshFile(v)) return false;
      seen.configFile = v;
      return true;
    case "o": {
      const m = /^([A-Za-z][A-Za-z0-9]*)\s*(?:=\s*|\s+)(.*)$/.exec(v.trim());
      if (!m) return true;
      const key = optionKey(m[1]);
      if (!key) return true;
      const value = m[2].trim().replace(/^"(.*)"$/, "$1");
      const ok = validOptionValue(value)
        && (key !== "ProxyJump" || value.split(",").every(validHop))
        && (key !== "IdentityFile" || validSshFile(value))
        && (key !== "Port" || (/^\d{1,5}$/.test(value) && validPort(Number(value))));
      if (!ok) return !ROUTE_KEYS.has(key);
      if (!(key in options)) options[key] = value;
      return true;
    }
    default:
      // Every other option (forwarding, a command, a control socket, a cipher…) is never carried.
      return true;
  }
}

/** One of the user's ssh client processes. */
export interface SshProcess { pid: number; argv: string[]; via: SshSeen["via"] }

/** What the readers use (injected in tests). */
export interface NoticeDeps {
  /** Linux: /proc's entries, a process's cmdline and comm, and the owner of /proc/<pid>. */
  readdir(p: string): string[];
  readFile(p: string): Buffer | null;
  ownerUid(p: string): number | null;
  /** This process's user id (POSIX). */
  uid: number | null;
  /** Runs a fixed reader (ps, PowerShell's CIM query, a distro's sh) with `env` as its whole environment. */
  run(argv: readonly string[], o: { input?: string; timeoutMs: number; env: Record<string, string> }): Promise<{ code: number | null; stdout: string }>;
  /** Windows' folder (for powershell.exe by absolute path). */
  systemRoot?: string;
  /** Ember's own environment: the readers get it without Ember's variables and the GitHub sign-in (childEnv). */
  env?: Readonly<Record<string, string | undefined>>;
}

/** The most processes looked at, and the most ssh processes reported. */
const SCAN_MAX = 5000;
const SSH_MAX = 64;

/** Ember's own connection, recognised by its fixed options (it is never offered back). */
function isEmbers(argv: readonly string[]): boolean {
  return argv.includes("EscapeChar=none") && argv.includes("PermitLocalCommand=no") && argv.at(-2) === "sh" && argv.at(-1) === "-s";
}

/** Linux: this user's processes whose comm is "ssh", from /proc. Null when /proc can't be read. */
export function linuxSshProcesses(d: NoticeDeps): SshProcess[] | null {
  let entries: string[];
  try {
    entries = d.readdir("/proc");
  } catch {
    return null;
  }
  const out: SshProcess[] = [];
  for (const e of entries.slice(0, SCAN_MAX)) {
    if (!/^\d{1,10}$/.test(e)) continue;
    const comm = d.readFile(`/proc/${e}/comm`)?.toString("utf8").trim();
    if (comm !== "ssh") continue;
    if (d.uid === null || d.ownerUid(`/proc/${e}`) !== d.uid) continue;
    const raw = d.readFile(`/proc/${e}/cmdline`);
    if (!raw || raw.length > 64 * 1024) continue;
    const argv = raw.toString("utf8").split("\0");
    if (argv.at(-1) === "") argv.pop();
    if (!argv.length || !isSshProgram(argv[0]) || isEmbers(argv)) continue;
    out.push({ pid: Number(e), argv, via: "local" });
    if (out.length >= SSH_MAX) break;
  }
  return out;
}

/** macOS: `ps -U <uid> -o pid=,args=` lines (args joined by spaces, so split on them). */
export function parsePs(text: string): SshProcess[] {
  const out: SshProcess[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d{1,10})\s+(.+)$/.exec(line);
    if (!m) continue;
    const argv = m[2].trim().split(/\s+/);
    if (!isSshProgram(argv[0]) || isEmbers(argv)) continue;
    out.push({ pid: Number(m[1]), argv, via: "local" });
    if (out.length >= SSH_MAX) break;
  }
  return out;
}

/** A Windows command line split as CommandLineToArgvW does (backslashes count only before a quote). */
export function windowsArgv(cmd: string): string[] {
  const out: string[] = [];
  let cur = "";
  let any = false;
  let quoted = false;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i];
    if (c === "\\") {
      let n = 0;
      while (cmd[i] === "\\") { n++; i++; }
      if (cmd[i] === "\"") {
        cur += "\\".repeat(Math.floor(n / 2));
        if (n % 2 === 1) { cur += "\""; any = true; continue; }
        i--;
        any = true;
        continue;
      }
      cur += "\\".repeat(n);
      i--;
      any = true;
      continue;
    }
    if (c === "\"") {
      if (quoted && cmd[i + 1] === "\"") { cur += "\""; i++; any = true; continue; }
      quoted = !quoted;
      any = true;
      continue;
    }
    if (!quoted && (c === " " || c === "\t")) {
      if (any) out.push(cur);
      cur = "";
      any = false;
      continue;
    }
    cur += c;
    any = true;
  }
  if (any) out.push(cur);
  return out;
}

/**
 * The one CIM query on Windows (fixed text, no input): this session's ssh.exe processes as JSON lines
 * `{"p":<pid>,"c":"<command line>"}`. Run by Windows PowerShell 5.1 with no profile, hidden.
 */
export const CIM_SCRIPT = "$s=(Get-Process -Id $PID).SessionId; Get-CimInstance Win32_Process -Filter \"Name='ssh.exe'\" | Where-Object { $_.SessionId -eq $s } | ForEach-Object { ConvertTo-Json -Compress @{ p = [int]$_.ProcessId; c = [string]$_.CommandLine } }";

/** Parses the CIM query's lines. */
export function parseCim(text: string): SshProcess[] {
  const out: SshProcess[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim().startsWith("{")) continue;
    let v: unknown;
    try { v = JSON.parse(line); } catch { continue; }
    const r = v as { p?: unknown; c?: unknown };
    if (typeof r.p !== "number" || !Number.isInteger(r.p) || typeof r.c !== "string" || r.c.length > 32 * 1024) continue;
    const argv = windowsArgv(r.c);
    if (!argv.length || !isSshProgram(argv[0]) || isEmbers(argv)) continue;
    out.push({ pid: r.p, argv, via: "local" });
    if (out.length >= SSH_MAX) break;
  }
  return out;
}

/**
 * The fixed reader a running distro runs (`wsl.exe -d <d> --exec /bin/sh -s`, this text on stdin): this user's ssh
 * processes there, one per line, `<pid><TAB><cmdline with NUL as \x01>`.
 */
export const WSL_READER = [
  "u=$(id -u)",
  "for d in /proc/[0-9]*; do",
  "  [ \"$(cat \"$d/comm\" 2>/dev/null)\" = ssh ] || continue",
  "  [ \"$(stat -c %u \"$d\" 2>/dev/null)\" = \"$u\" ] || continue",
  "  printf '%s\\t' \"${d#/proc/}\"",
  "  tr '\\000\\n' '\\001 ' < \"$d/cmdline\" 2>/dev/null",
  "  printf '\\n'",
  "done",
  "",
].join("\n");

/** Parses the WSL reader's lines. */
export function parseWslReader(text: string, distro: string): SshProcess[] {
  const out: SshProcess[] = [];
  for (const line of text.split("\n")) {
    const m = /^(\d{1,10})\t(.*)$/.exec(line);
    if (!m) continue;
    const argv = m[2].split("\u0001");
    if (argv.at(-1) === "") argv.pop();
    if (!argv.length || !isSshProgram(argv[0]) || isEmbers(argv)) continue;
    out.push({ pid: Number(m[1]), argv, via: `wsl:${distro}` });
    if (out.length >= SSH_MAX) break;
  }
  return out;
}

/** userSshProcesses with its readers given (tests); Ember calls userSshProcesses. */
export async function userSshProcessesWith(os: OS, d: NoticeDeps, o: { wsl?: { exe: string; distros: string[] } } = {}): Promise<SshProcess[] | null> {
  const env = childEnv(d.env ?? {}, os);
  let local: SshProcess[] | null;
  if (os === "linux") {
    local = linuxSshProcesses(d);
  } else if (os === "darwin") {
    if (d.uid === null) return null;
    const r = await d.run(["/bin/ps", "-U", String(d.uid), "-o", "pid=,args="], { timeoutMs: 5_000, env }).catch(() => null);
    local = r && r.code === 0 ? parsePs(r.stdout) : null;
  } else {
    const root = d.systemRoot && /^[A-Za-z]:\\/.test(d.systemRoot) ? d.systemRoot.replace(/\\+$/, "") : "C:\\Windows";
    const ps = `${root}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const r = await d.run([ps, "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", CIM_SCRIPT], { timeoutMs: 8_000, env }).catch(() => null);
    local = r && r.code === 0 ? parseCim(r.stdout) : null;
  }
  if (local === null) return null;
  if (os === "win32" && o.wsl) {
    for (const distro of o.wsl.distros.slice(0, 8)) {
      if (!DISTRO_NAME.test(distro)) continue;
      const r = await d.run([o.wsl.exe, "-d", distro, "--exec", "/bin/sh", "-s"], { input: WSL_READER, timeoutMs: 5_000, env }).catch(() => null);
      if (r && r.code === 0) local.push(...parseWslReader(r.stdout, distro));
    }
  }
  return local;
}

/**
 * The user's own ssh client processes now: pid and argv (Linux /proc/<pid>/cmdline of own-uid "ssh" processes;
 * macOS `ps -U <uid> -o pid=,args=`; Windows a CIM query for ssh.exe of this session; with WSL on, also each running
 * distro's own-uid ssh processes through one fixed `wsl.exe -d <d> --exec /bin/sh -s` reader of /proc/*\/cmdline,
 * script on stdin). Null when it can't be read.
 */
export function userSshProcesses(os: OS, o?: { wsl?: { exe: string; distros: string[] } }): Promise<{ pid: number; argv: string[]; via: SshSeen["via"] }[] | null> {
  const deps: NoticeDeps = {
    readdir: p => readdirSync(p),
    readFile: p => { try { return readFileSync(p); } catch { return null; } },
    ownerUid: p => { try { return statSync(p).uid; } catch { return null; } },
    uid: typeof process.getuid === "function" ? process.getuid() : null,
    run: (argv, ro) => new Promise(resolve => {
      const child = execFile(argv[0], argv.slice(1), { env: ro.env, timeout: ro.timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024, encoding: "utf8" }, (err, stdout) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string }) | null;
        resolve({ code: e ? (typeof e.code === "number" ? e.code : null) : 0, stdout: String(stdout ?? "") });
      });
      child.stdin?.end(ro.input ?? "");
    }),
    systemRoot: process.env.SystemRoot ?? process.env.SYSTEMROOT,
    env: process.env,
  };
  return userSshProcessesWith(os, deps, o).catch(() => null);
}
