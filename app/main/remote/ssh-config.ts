/**
 * What the user's own SSH set-up says about a destination, read without connecting (§5.1.1, §5.1.3): the client Ember
 * runs (an absolute path to the system's OpenSSH, never `ssh` from PATH), its version from `ssh -V`, and `ssh -G`'s
 * resolved options. Ember reads them to show the consent card, apply the PC admin's allowed hosts, refuse settings that
 * throw host keys away, find a live ControlMaster and rewrite ProxyJump into its hardened chain. Pure parsing; the
 * processes run in connections.ts.
 */

import type { OS } from "../../shared/shortcuts";
import { parseHop, type Hop } from "./destination";

/** `ssh -G`'s answer, the keys Ember uses (§5.1.3). */
export interface SshConfig {
  user: string;
  hostname: string;
  port: number;
  /** The hops of `proxyjump`, in connection order (the first is reached first); null when none (or `none`). */
  proxyJump: Hop[] | null;
  /** `proxyjump` as ssh printed it, for messages; null when none. */
  proxyJumpText: string | null;
  /** A user ProxyCommand (an SSO helper such as cloudflared): left as configured; the deadline bounds it. */
  proxyCommand: boolean;
  /** The control socket (already expanded by ssh), null when none. */
  controlPath: string | null;
  controlMaster: string | null;
  controlPersist: string | null;
  /** Every user known-hosts file. */
  userKnownHostsFile: string[];
  strictHostKeyChecking: string | null;
  identityFile: string[];
  /** OpenSSH ≥ 8.7 only (absent on older clients). */
  sessionType: string | null;
  stdinNull: string | null;
  forkAfterAuthentication: string | null;
  /** Every key ssh printed, lower case, each with its values in order (for diagnostics only; never logged). */
  raw: Map<string, string[]>;
}

/** Thrown when `ssh -G` printed something Ember can't use (no user, host name or port; a hop it can't harden). */
export class SshConfigError extends Error {}

/**
 * `ssh -G`'s output: one `key value…` line per option (keys in lower case, values as ssh prints them; a key may repeat,
 * as `identityfile` does). Throws SshConfigError without a user, host name or valid port, or with a `proxyjump`
 * whose hops Ember can't take apart.
 */
export function parseSshG(text: string): SshConfig {
  const raw = new Map<string, string[]>();
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^([A-Za-z][A-Za-z0-9]*)(?:\s+(.*))?$/.exec(line.trim());
    if (!m) continue;
    const key = m[1].toLowerCase();
    const list = raw.get(key) ?? [];
    list.push((m[2] ?? "").trim());
    raw.set(key, list);
  }
  const one = (k: string): string | null => {
    const v = raw.get(k)?.[0];
    return v === undefined || v === "" ? null : v;
  };
  const noneIsNull = (v: string | null) => (v === null || v.toLowerCase() === "none" ? null : v);
  const user = one("user");
  const hostname = one("hostname");
  const port = Number(one("port"));
  if (!user || !hostname || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SshConfigError("ssh -G gave no user, host name or port");
  }
  const jumpText = noneIsNull(one("proxyjump"));
  let proxyJump: Hop[] | null = null;
  if (jumpText) {
    proxyJump = [];
    for (const part of jumpText.split(",")) {
      const hop = parseHop(part.trim());
      if (!hop) throw new SshConfigError("a jump host Ember can't use");
      proxyJump.push(hop);
    }
  }
  return {
    user,
    hostname,
    port,
    proxyJump,
    proxyJumpText: jumpText,
    proxyCommand: noneIsNull(one("proxycommand")) !== null,
    controlPath: noneIsNull(one("controlpath")),
    controlMaster: one("controlmaster"),
    controlPersist: one("controlpersist"),
    userKnownHostsFile: (raw.get("userknownhostsfile") ?? []).flatMap(v => v.split(/\s+/)).filter(Boolean),
    strictHostKeyChecking: one("stricthostkeychecking"),
    identityFile: raw.get("identityfile") ?? [],
    sessionType: one("sessiontype"),
    stdinNull: one("stdinnull"),
    forkAfterAuthentication: one("forkafterauthentication"),
    raw,
  };
}

/** Does this configuration throw host keys away (`/dev/null`, `none` or Windows' `NUL`, any case; critique remote-19)? */
export function knownHostsDiscarded(cfg: Pick<SshConfig, "userKnownHostsFile">): boolean {
  return cfg.userKnownHostsFile.some(f => /^(\/dev\/null|none|nul)$/i.test(f));
}

/**
 * A session option Ember can't override on this client (clients older than 8.7 neither print nor accept them, so
 * this only fires on a config the client printed but Ember can't pass): its name, or null.
 */
export function unfixableSessionOption(cfg: SshConfig, v: SshVersion): string | null {
  if (versionAtLeast(v, 8, 7)) return null;
  if (cfg.sessionType && cfg.sessionType !== "default") return "SessionType";
  if (cfg.stdinNull && cfg.stdinNull !== "no" && cfg.stdinNull !== "false") return "StdinNull";
  if (cfg.forkAfterAuthentication && cfg.forkAfterAuthentication !== "no" && cfg.forkAfterAuthentication !== "false") return "ForkAfterAuthentication";
  return null;
}

/** An OpenSSH client's version, from `ssh -V`. */
export interface SshVersion { major: number; minor: number; windows: boolean; text: string }

/**
 * `ssh -V`'s stderr: `OpenSSH_8.0p1, OpenSSL 1.1.1k …` or Win32-OpenSSH's `OpenSSH_for_Windows_9.5p1, LibreSSL 3.8.2`.
 * Null when it isn't an OpenSSH client.
 */
export function parseSshVersion(text: string): SshVersion | null {
  const m = /OpenSSH_(for_Windows_)?(\d+)\.(\d+)/.exec(String(text));
  if (!m) return null;
  const first = String(text).split(/\r?\n/).find(l => l.includes("OpenSSH_")) ?? "";
  return { major: Number(m[2]), minor: Number(m[3]), windows: !!m[1], text: first.trim().slice(0, 200) };
}

/** Is `v` at least major.minor? */
export function versionAtLeast(v: Pick<SshVersion, "major" | "minor">, major: number, minor: number): boolean {
  return v.major > major || (v.major === major && v.minor >= minor);
}

/** The oldest client Ember runs (§5.1.1): 7.6, and 8.1 on Windows (older builds break a binary stream). */
export function minimumVersion(os: OS): { major: number; minor: number } {
  return os === "win32" ? { major: 8, minor: 1 } : { major: 7, minor: 6 };
}

/** Can this client ask through Ember's prompt (askpass)? POSIX always (DISPLAY without a terminal); Windows from 8.4. */
export function askpassWorks(os: OS, v: SshVersion): boolean {
  return os !== "win32" || versionAtLeast(v, 8, 4);
}

/**
 * The system's OpenSSH client (§5.1.1): `/usr/bin/ssh` on Linux and macOS; `%SystemRoot%\System32\OpenSSH\ssh.exe` on
 * Windows (`systemRoot` from the environment, `C:\Windows` when unset). Never `ssh` from PATH.
 */
export function sshClientPath(os: OS, systemRoot?: string): string {
  if (os !== "win32") return "/usr/bin/ssh";
  const root = (systemRoot && /^[A-Za-z]:\\[^"<>|?*\u0000-\u001f]*$/.test(systemRoot) ? systemRoot : "C:\\Windows").replace(/\\+$/, ""); // eslint-disable-line no-control-regex -- a path with control characters is refused
  return `${root}\\System32\\OpenSSH\\ssh.exe`;
}

/**
 * The doctor's `ssh-client` row (§8.8) from what `ssh -V` said (null: no client at `path`). TG shows it only while SSH
 * is allowed; `askpass` says whether a Windows client's prompts can come through Ember (8.4+ and the helper built).
 */
export function sshClientRow(os: OS, path: string, v: SshVersion | null, o: { askpass?: boolean } = {}): { id: "ssh-client"; status: "ok" | "warn" | "fail"; label: string; detail: string; fix?: string } {
  const label = "SSH client";
  if (!v) {
    return { id: "ssh-client", status: "fail", label, detail: "No SSH client found", fix: "Ember can't find SSH on this computer. Install OpenSSH (Linux: `sudo dnf install openssh-clients`; Windows: Settings › Apps › Optional features › OpenSSH Client), then try again." };
  }
  const min = minimumVersion(os);
  if (!versionAtLeast(v, min.major, min.minor)) {
    return os === "win32"
      ? { id: "ssh-client", status: "fail", label, detail: "OpenSSH is too old for Ember", fix: "Ember needs OpenSSH 8.1 or newer: update the OpenSSH Client in Settings › Apps › Optional features." }
      : { id: "ssh-client", status: "fail", label, detail: "OpenSSH is too old for Ember", fix: "Ember needs OpenSSH 7.6 or newer." };
  }
  const version = `OpenSSH ${v.major}.${v.minor}`;
  if (os === "win32") {
    if (!askpassWorks(os, v) || o.askpass === false) return { id: "ssh-client", status: "warn", label, detail: "Passwords can't be asked here: keys and the ssh-agent only" };
    return { id: "ssh-client", status: "ok", label, detail: `${version} (passwords through Ember's prompt)` };
  }
  return { id: "ssh-client", status: "ok", label, detail: `${version} at ${path}` };
}
