/**
 * The doctor's and setup check's rows for other computers and commands (§8.8): the SSH client (only while SSH is
 * allowed), the program that gives commands a terminal (Linux, macOS) or Windows PowerShell (Windows) while commands
 * are allowed here, the helper Ember copies to other computers (an installed Ember), WSL's own rows (WA's and WB's),
 * and a connected Mac's protected folders. The probes are small fixed programs with fixed arguments (`ssh -V`,
 * `script --version`, PowerShell's language mode) run only when the doctor asks; the rules that turn their answers into
 * rows are pure and tested.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import pathWin32 from "node:path/win32";
import type { OS } from "../../shared/shortcuts";
import { commandMode, type LoadedAdminPolicy } from "../admin";
import type { PlatformDoctorRow, SystemPlatform } from "../platform/types";
import { installSsh } from "../remote/ssh-errors";
import { sshAllowed } from "./registry";

/** What the rows are decided from (the real probes run the programs; tests pass answers). */
export interface DoctorProbes {
  /** The SSH client Ember would run and what `ssh -V` printed, or null when there is none. */
  ssh(): Promise<{ path: string; text: string } | null>;
  /** The `script` program that gives commands a terminal (Linux: util-linux's; macOS: BSD's), or null. */
  script(): Promise<string | null>;
  /** Windows PowerShell 5.1 and its language mode ("FullLanguage", "ConstrainedLanguage"; null: couldn't tell), or null when missing. */
  powershell(): Promise<{ path: string; language: string | null } | null>;
  /** The remote parts this install ships (their target names), or null when they are missing. */
  remoteParts(): Promise<string[] | null>;
}

/** "OpenSSH_8.0p1, …", "OpenSSH_for_Windows_9.5p1, …" → { major, minor }, or null when it isn't OpenSSH. */
export function parseSshVersion(text: string): { major: number; minor: number; windows: boolean } | null {
  const m = /OpenSSH_(for_Windows_)?(\d+)\.(\d+)/.exec(text);
  return m ? { major: Number(m[2]), minor: Number(m[3]), windows: !!m[1] } : null;
}

const atLeast = (v: { major: number; minor: number }, major: number, minor: number) => v.major > major || (v.major === major && v.minor >= minor);

/**
 * What to do when there is no SSH client: this OS's way to install it only (the row's detail already says none was
 * found, so the fix doesn't say it again; review #157, #218).
 */
export const noSshFix = (os: OS): string => installSsh(os);
/** §8.7's message for a Windows client that is too old. */
export const OLD_SSH_WIN_FIX = "Ember needs OpenSSH 8.1 or newer: update the OpenSSH Client in Settings › Apps › Optional features.";
/** A Windows client of 8.1 to 8.3: it works, but Ember's password window needs 8.4 (L15; review #157, #218). */
export const OLD_SSH_WIN_PASSWORDS_FIX = "Update the OpenSSH Client to 8.4 or newer to enter passwords in Ember.";
/** §5.1.1's message for a POSIX client that is too old. */
export const OLD_SSH_FIX = "Ember needs OpenSSH 7.6 or newer.";

/**
 * The SSH client row (§8.8). SSH is optional, so a missing or too old client is a warning, never a failure: the check-up
 * of a PC that never uses SSH (or a RHEL 8 host without openssh-clients) still passes (lead's ruling on §8.8).
 */
export function sshClientRow(os: OS, found: { path: string; text: string } | null): PlatformDoctorRow {
  const row = { id: "ssh-client", label: "SSH client" };
  const v = found ? parseSshVersion(found.text) : null;
  if (!found || !v) return { ...row, status: "warn", detail: "No SSH client found", fix: noSshFix(os) };
  const ver = `${v.major}.${v.minor}`;
  if (os === "win32") {
    if (!atLeast(v, 8, 1)) return { ...row, status: "warn", detail: "OpenSSH is too old for Ember", fix: OLD_SSH_WIN_FIX };
    // Win32-OpenSSH runs Ember's askpass only from 8.4 (L15).
    if (!atLeast(v, 8, 4)) return { ...row, status: "warn", detail: "Passwords can't be asked here: keys and the ssh-agent only", fix: OLD_SSH_WIN_PASSWORDS_FIX };
    return { ...row, status: "ok", detail: `OpenSSH ${ver} (passwords through Ember's prompt)` };
  }
  if (!atLeast(v, 7, 6)) return { ...row, status: "warn", detail: "OpenSSH is too old for Ember", fix: OLD_SSH_FIX };
  return { ...row, status: "ok", detail: `OpenSSH ${ver} at ${found.path}` };
}

/** The command window terminal row (Linux, macOS; §8.8): util-linux is named only on Linux (review #157). */
export function commandTerminalRow(script: string | null, os: OS = "linux"): PlatformDoctorRow {
  const row = { id: "command-terminal", label: "Command window terminal" };
  const fix = os === "darwin" ? "macOS comes with script at /usr/bin/script, but Ember can't find it there." : "Install util-linux with: sudo dnf install util-linux";
  return script
    ? { ...row, status: "ok", detail: "script gives commands a terminal" }
    : { ...row, status: "warn", detail: "No script program: commands can't ask for passwords or answers", fix };
}

/** The PowerShell row (Windows; §8.8). */
export function powershellRow(ps: { path: string; language: string | null } | null): PlatformDoctorRow {
  const row = { id: "powershell", label: "PowerShell for commands" };
  if (!ps) return { ...row, status: "fail", detail: "Windows PowerShell isn't available", fix: "Turn on Windows PowerShell in Windows features." };
  if (ps.language && ps.language !== "FullLanguage") {
    return { ...row, status: "warn", detail: "PowerShell runs in Constrained Language Mode: command output may not be UTF-8, and SSH passwords can't be asked" };
  }
  return { ...row, status: "ok", detail: "Windows PowerShell 5.1" };
}

/** "Linux (x64, arm64) and macOS" from the parts' target names. */
function partsWords(targets: string[]): string {
  const linux = ["x64", "arm64"].filter(a => targets.includes(`linux-${a}`));
  const words = [linux.length ? `Linux (${linux.join(", ")})` : "", targets.some(t => t.startsWith("darwin-")) ? "macOS" : ""].filter(Boolean);
  return words.join(" and ");
}

/** The remote parts row (§8.8): missing parts only stop SSH targets, so it is a warning, like the SSH client's. */
export function remotePartsRow(targets: string[] | null): PlatformDoctorRow {
  const row = { id: "remote-parts", label: "Helper for other computers" };
  const words = targets ? partsWords(targets) : "";
  return words ? { ...row, status: "ok", detail: `Ready for ${words}` } : { ...row, status: "warn", detail: "Missing from this install", fix: "Reinstall Ember." };
}

/** A connected Mac whose protected folders commands can't open (§8.8 `remote-tcc:<host>`, L6). */
export function remoteTccRow(hostId: string): PlatformDoctorRow {
  return {
    id: `remote-tcc:${hostId}`, label: `Folders on ${hostId}`, status: "warn",
    detail: `Commands on ${hostId} can't open your Desktop, Documents or Downloads folders until “Allow full disk access for remote users” is on.`,
    fix: "Turn it on in System Settings › General › Sharing › Remote Login › ⓘ.",
  };
}

/** The rows for this PC, from the probes' answers (pure apart from awaiting them). */
export async function doctorRowsWith(o: { os: OS; admin: () => LoadedAdminPolicy; packaged: boolean }, p: DoctorProbes): Promise<PlatformDoctorRow[]> {
  const admin = o.admin();
  const rows: PlatformDoctorRow[] = [];
  const ssh = sshAllowed(admin);
  const safe = async <T>(f: () => Promise<T>, fallback: T): Promise<T> => { try { return await f(); } catch { return fallback; } };
  if (ssh) rows.push(sshClientRow(o.os, await safe(() => p.ssh(), null)));
  if (commandMode(admin, "local") !== "off") {
    if (o.os === "win32") rows.push(powershellRow(await safe(() => p.powershell(), null)));
    else rows.push(commandTerminalRow(await safe(() => p.script(), null), o.os));
  }
  // Only an installed Ember carries the parts; a development copy builds them on demand.
  if (ssh && o.packaged) rows.push(remotePartsRow(await safe(() => p.remoteParts(), null)));
  return rows;
}

/** Runs one fixed program with fixed arguments: its stdout and stderr (never a shell; a short timeout; no Ember secrets). */
function run(file: string, args: string[], o: { env: NodeJS.ProcessEnv; windowsHide?: boolean; timeoutMs: number }): Promise<{ stdout: string; stderr: string } | null> {
  return new Promise(resolve => {
    try {
      execFile(file, args, { timeout: o.timeoutMs, windowsHide: o.windowsHide ?? false, env: o.env, encoding: "utf8", maxBuffer: 64 * 1024 },
        (err, stdout, stderr) => {
          const missing = !!err && (err as NodeJS.ErrnoException).code === "ENOENT";
          resolve(missing ? null : { stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
        });
    } catch {
      resolve(null);
    }
  });
}

/** Only what a probe needs from Ember's environment (never a token: §3.3.1's rule for every child). */
function probeEnv(env: NodeJS.ProcessEnv, os: OS): NodeJS.ProcessEnv {
  const keep = os === "win32" ? ["SystemRoot", "SYSTEMROOT", "windir", "PATH", "Path", "PATHEXT", "TEMP", "TMP"] : ["PATH", "LANG", "HOME"];
  return Object.fromEntries(keep.filter(k => env[k] !== undefined).map(k => [k, env[k]]));
}

/** The real probes (the doctor and the setup check). */
export function realDoctorProbes(o: { os: OS; sys: SystemPlatform; resourcesPath: string; env: NodeJS.ProcessEnv }): DoctorProbes {
  const env = probeEnv(o.env, o.os);
  const hide = o.sys.spawnDefaults.windowsHide;
  const systemRoot = o.env.SystemRoot ?? o.env.SYSTEMROOT ?? "C:\\Windows";
  return {
    ssh: async () => {
      const file = o.os === "win32" ? pathWin32.join(systemRoot, "System32", "OpenSSH", "ssh.exe") : "/usr/bin/ssh";
      const out = await run(file, ["-V"], { env, windowsHide: hide, timeoutMs: 5000 });
      return out ? { path: file, text: `${out.stderr}\n${out.stdout}` } : null;
    },
    script: async () => {
      if (o.os === "darwin") return fs.existsSync("/usr/bin/script") ? "/usr/bin/script" : null;
      const file = o.sys.which("script");
      if (!file) return null;
      const out = await run(file, ["--version"], { env, timeoutMs: 5000 });
      // BusyBox's script has no -e (§3.10): only util-linux's gives commands a terminal.
      return out && /util-linux/.test(`${out.stdout}${out.stderr}`) ? file : null;
    },
    powershell: async () => {
      const file = pathWin32.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      if (!fs.existsSync(file)) return null;
      const out = await run(file, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$ExecutionContext.SessionState.LanguageMode"], { env, windowsHide: hide, timeoutMs: 15_000 });
      const lang = out ? /\b(FullLanguage|ConstrainedLanguage|RestrictedLanguage|NoLanguage)\b/.exec(out.stdout)?.[1] ?? null : null;
      return { path: file, language: lang };
    },
    remoteParts: async () => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(o.resourcesPath, "remote-parts", "remote-parts.json"), "utf8")) as { targets?: unknown };
        return raw && typeof raw.targets === "object" && raw.targets ? Object.keys(raw.targets) : null;
      } catch {
        return null; // not shipped (or unreadable): the row says so
      }
    },
  };
}
