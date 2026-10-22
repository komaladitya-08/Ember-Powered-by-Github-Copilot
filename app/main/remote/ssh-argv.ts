/**
 * Ember's own ssh command lines (§5.1.3, §5.1.4, §5.1.7) and the environment they run in. The argv is fixed text plus
 * validated values, with `--` before the destination, so nothing the user, a config file or a remote says can add an
 * option. It always passes `ControlMaster=no` (the user's `ControlMaster auto` never makes Ember's ssh a master) and
 * `ControlPath=none` unless Ember deliberately rides the user's checked live master. A ProxyJump is rewritten into a
 * chain of hardened ProxyCommands, because OpenSSH builds jump hops without the command line's `-o` options (critique
 * remote-4). The environment of a batch run makes every prompt fail at once instead of popping up anywhere. Pure.
 */

import type { OS } from "../../shared/shortcuts";
import { hopDest, optionKey, validDest, validHop, validOptionValue, validPort, validSshFile, type CarriedOptions, type Hop } from "./destination";
import { versionAtLeast, type SshVersion } from "./ssh-config";

/** The hardening every connect passes, in this order (§5.1.4). */
const HARDENING = [
  "UpdateHostKeys=no",
  "ForwardAgent=no", "ForwardX11=no", "ForwardX11Trusted=no", "ClearAllForwardings=yes",
  "PermitLocalCommand=no", "RemoteCommand=none", "RequestTTY=no", "EscapeChar=none",
  "ServerAliveInterval=15", "ServerAliveCountMax=3", "ConnectTimeout=15", "LogLevel=ERROR",
] as const;

/** OpenSSH ≥ 8.7's keys that would break the stdio channel if a host's config set them (critique remote-19). */
const SESSION_FIXES = ["SessionType=default", "StdinNull=no", "ForkAfterAuthentication=no"] as const;

/** The most jump hops Ember chains (§5.1.3); Windows takes one. */
export const MAX_HOPS = 3;

/** How a connect is made (§5.1.4). */
export interface SshArgvOptions {
  /** The client: an absolute path (sshClientPath, or /usr/bin/ssh inside a WSL distro). */
  ssh: string;
  /** The OS the client runs on (Windows quotes a hop command its own way and takes one hop). */
  os: OS;
  /** `ssh -V`'s version: the ≥ 8.7 session options are passed only to clients that know them. */
  version: Pick<SshVersion, "major" | "minor">;
  dest: string;
  /** A port given apart from the destination (HostRecord.port). */
  port?: number;
  /** "batch": BatchMode=yes (every connect starts so); "interactive": prompts go to Ember's prompt (askpass). */
  mode: "batch" | "interactive";
  /** StrictHostKeyChecking=ask: an interactive connect to a host whose key is unknown (its card asks the user). */
  acceptNewKey?: boolean;
  /** The user's live master's socket, checked with `ssh -O check` (§5.1.7); otherwise ControlPath=none. */
  controlPath?: string | null;
  /** The hardened ProxyCommand that replaces a ProxyJump (hopCommand). */
  proxyCommand?: string | null;
  /** Options carried over from the user's own ssh command line (allow-listed; ProxyJump is replaced, never passed). */
  extra?: CarriedOptions;
  /** Through a WSL distro's own client (L22): `wsl.exe -d <distro> --exec /usr/bin/ssh …`. */
  wsl?: { exe: string; distro: string };
}

/** Thrown for a value that must never reach ssh's argv (a validator refused it). */
export class SshArgvError extends Error {}

/** The carried -F, -i and -o options (ProxyJump left out: Ember's chain replaces it, §5.1.3). */
function carried(extra: CarriedOptions | undefined, o: { proxyJump: boolean }): string[] {
  if (!extra) return [];
  const out: string[] = [];
  if (extra.configFile !== undefined) {
    if (!validSshFile(extra.configFile)) throw new SshArgvError("config file");
    out.push("-F", extra.configFile);
  }
  for (const f of extra.identityFiles ?? []) {
    if (!validSshFile(f)) throw new SshArgvError("identity file");
    out.push("-i", f);
  }
  for (const [k, v] of Object.entries(extra.options ?? {})) {
    const key = optionKey(k);
    if (key !== k || !validOptionValue(v)) throw new SshArgvError("option");
    if (key === "ProxyJump") continue;
    if (key === "IdentityFile" && !validSshFile(v)) throw new SshArgvError("identity file");
    out.push("-o", `${key}=${v}`);
  }
  if (o.proxyJump) {
    const jump = jumpList(extra);
    if (jump.length) out.push("-o", `ProxyJump=${jump.join(",")}`);
  }
  return out;
}

/** The hops the user's command line named (-J, else -o ProxyJump), validated. */
function jumpList(extra: CarriedOptions | undefined): string[] {
  const jump = extra?.jump?.length ? extra.jump : (extra?.options?.ProxyJump?.split(",") ?? []);
  if (!jump.every(validHop)) throw new SshArgvError("jump host");
  return jump;
}

function destTail(dest: string, port: number | undefined): string[] {
  if (!validDest(dest)) throw new SshArgvError("destination");
  if (port !== undefined && !validPort(port)) throw new SshArgvError("port");
  return [...(port !== undefined ? ["-p", String(port)] : []), "--", dest];
}

/** Prefixes the WSL launcher (L22) to a client argv. */
function viaWsl(argv: string[], wsl: { exe: string; distro: string } | undefined): string[] {
  return wsl ? [wsl.exe, "-d", wsl.distro, "--exec", ...argv] : argv;
}

/**
 * The connect argv (§5.1.4), program first: `<ssh> -T -o … -- <dest> sh -s`. The remote command is always the two words
 * `sh -s` (valid in every login shell); the bootstrap script arrives on stdin (§5.1.9).
 */
export function sshArgv(o: SshArgvOptions): string[] {
  const opts: string[] = [];
  const add = (...kv: string[]) => { for (const v of kv) opts.push("-o", v); };
  if (o.mode === "batch") add("BatchMode=yes");
  add(`StrictHostKeyChecking=${o.mode === "interactive" && o.acceptNewKey ? "ask" : "yes"}`);
  add(...HARDENING);
  add("ControlMaster=no");
  if (o.controlPath) {
    if (/[\u0000-\u001f\u007f]/.test(o.controlPath) || o.controlPath.length > 1024) throw new SshArgvError("control path"); // eslint-disable-line no-control-regex -- control characters are exactly what's refused here
    add(`ControlPath=${o.controlPath}`);
  } else {
    add("ControlPath=none");
  }
  if (versionAtLeast(o.version, 8, 7)) add(...SESSION_FIXES);
  if (o.proxyCommand) {
    // ProxyCommand must come first: a ProxyJump given earlier (even "none") makes OpenSSH ignore every later
    // ProxyCommand (readconf.c, oProxyCommand), and a ProxyCommand given first makes every later ProxyJump inactive
    // (parse_jump), the user's config included.
    add(`ProxyCommand=${o.proxyCommand}`, "ProxyJump=none");
  }
  return viaWsl([o.ssh, "-T", ...opts, ...carried(o.extra, { proxyJump: false }), ...destTail(o.dest, o.port), "sh", "-s"], o.wsl);
}

/** `ssh -G` for a destination with its carried options (§5.1.3): resolves without connecting. */
export function sshGArgv(o: { ssh: string; dest: string; port?: number; extra?: CarriedOptions; wsl?: { exe: string; distro: string } }): string[] {
  return viaWsl([o.ssh, "-G", ...carried(o.extra, { proxyJump: true }), ...destTail(o.dest, o.port)], o.wsl);
}

/** `ssh -G` for one jump hop (the user's config file, if one was carried, as OpenSSH passes it to a hop). */
export function sshGHopArgv(o: { ssh: string; hop: Hop; configFile?: string; wsl?: { exe: string; distro: string } }): string[] {
  if (o.configFile !== undefined && !validSshFile(o.configFile)) throw new SshArgvError("config file");
  return viaWsl([o.ssh, "-G", ...(o.configFile !== undefined ? ["-F", o.configFile] : []), ...destTail(hopDest(o.hop), o.hop.port)], o.wsl);
}

/** `ssh -V` (the version on stderr). */
export function sshVersionArgv(o: { ssh: string; wsl?: { exe: string; distro: string } }): string[] {
  return viaWsl([o.ssh, "-V"], o.wsl);
}

/** `ssh -O check` against the user's master (§5.1.7): exit 0 means it is alive and Ember may ride it. */
export function sshCheckArgv(o: { ssh: string; controlPath: string; dest: string; port?: number }): string[] {
  if (/[\u0000-\u001f\u007f]/.test(o.controlPath) || o.controlPath.length > 1024) throw new SshArgvError("control path"); // eslint-disable-line no-control-regex -- control characters are exactly what's refused here
  return [o.ssh, "-O", "check", "-o", "BatchMode=yes", "-o", `ControlPath=${o.controlPath}`, ...destTail(o.dest, o.port)];
}

/** A POSIX shell word: '…' with every ' written as '\''. */
export function shQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Text placed in a ProxyCommand: ssh expands %-tokens there, so a literal % is written %%. */
function pct(s: string): string {
  return s.replace(/%/g, "%%");
}

/**
 * The hardened ProxyCommand chain that replaces `proxyjump` (§5.1.3, critique remote-4), or throws SshArgvError when
 * the hops can't be hardened (more than MAX_HOPS; more than one on Windows; a hop the validator refuses). Each hop runs
 * `ssh -T` with Ember's own refusals and `-W [%h]:%p`; a chain nests the previous hop's command as `-o ProxyCommand=`,
 * every `%` of a nested level doubled, because ssh expands one level of %-tokens before it runs each command.
 * POSIX runs a ProxyCommand with `/bin/sh -c`, so the words are single-quoted; Win32-OpenSSH starts it with
 * CreateProcess and no shell (posix_spawnp of the whole command line), so the client's path is double-quoted there.
 */
export function hopCommand(o: { ssh: string; os: OS; hops: readonly Hop[]; mode: "batch" | "interactive"; configFile?: string }): string {
  if (o.hops.length === 0 || o.hops.length > MAX_HOPS) throw new SshArgvError("too many jump hosts");
  if (o.os === "win32" && o.hops.length > 1) throw new SshArgvError("Windows takes one jump host");
  if (o.configFile !== undefined && (!validSshFile(o.configFile) || (o.os === "win32" && o.configFile.includes("\"")))) throw new SshArgvError("config file");
  let inner: string | null = null;
  for (const hop of o.hops) {
    const dest = hopDest(hop);
    if (!validHop(dest) || (hop.port !== undefined && !validPort(hop.port))) throw new SshArgvError("jump host");
    const words: string[] = [
      o.os === "win32" ? `"${pct(o.ssh)}"` : shQuote(pct(o.ssh)),
      "-T",
      "-o", `BatchMode=${o.mode === "batch" ? "yes" : "no"}`,
      "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no", "-o", "ControlMaster=no", "-o", "ControlPath=none",
      "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ClearAllForwardings=yes", "-o", "PermitLocalCommand=no",
      "-o", "LogLevel=ERROR",
      ...(o.configFile !== undefined ? ["-F", o.os === "win32" ? `"${pct(o.configFile)}"` : shQuote(pct(o.configFile))] : []),
      ...(hop.port !== undefined ? ["-p", String(hop.port)] : []),
      ...(inner !== null ? ["-o", shQuote(`ProxyCommand=${pct(inner)}`)] : []),
      "-W", o.os === "win32" ? "[%h]:%p" : "'[%h]:%p'",
      "--", dest,
    ];
    inner = words.join(" ");
  }
  return inner as string;
}

/** Variables never handed to ssh (§5.1.4): Ember's own, Electron's, Node's options and every GitHub/Copilot sign-in. */
const NEVER_ENV = /^(EMBER_|ELECTRON_|COPILOT_|GH_|GITHUB_)|^(NODE_OPTIONS|NODE_PATH|NODE_DEBUG)$/;

/**
 * The environment for any other program Ember starts here (ssh -V/-G/-O runs get sshEnv; PowerShell, ioreg, ps, a WSL
 * reader get this): the user's, minus Ember's own variables, Electron's, Node's options and every GitHub sign-in
 * variable, so the token that powers Ember never reaches a child. Windows names compare without regard to case.
 */
export function childEnv(base: Readonly<Record<string, string | undefined>>, os: OS): Record<string, string> {
  const never = os === "win32" ? new RegExp(NEVER_ENV.source, "i") : NEVER_ENV;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && !never.test(k)) out[k] = v;
  }
  return out;
}

/** The askpass channel of an interactive run (§5.1.6). */
export type AskpassEnv =
  /** Linux and macOS PCs: the wrapper script, the per-run socket and its nonce. */
  | { kind: "socket"; program: string; sock: string; nonce: string }
  /** Windows PCs (Win32-OpenSSH ≥ 8.4): the compiled helper, the per-run pipe and its nonce. */
  | { kind: "pipe"; program: string; pipe: string; nonce: string };

/**
 * The ssh child's environment (§5.1.4): the user's environment as Ember got it, minus Ember's, Electron's, Node's
 * options and GitHub's sign-in variables (SSH_AUTH_SOCK kept: the user's agent authenticates; it is never forwarded).
 * A batch run removes SSH_ASKPASS and DISPLAY and sets SSH_ASKPASS_REQUIRE=never, so no prompt can appear anywhere (a
 * jump hop's or an SSO helper's included). An interactive run points askpass at Ember's helper. Windows names compare
 * without regard to case.
 */
export function sshEnv(base: Readonly<Record<string, string | undefined>>, o: { os: OS; mode: "batch" } | { os: OS; mode: "interactive"; askpass: AskpassEnv }): Record<string, string> {
  const win32 = o.os === "win32";
  const never = win32 ? new RegExp(NEVER_ENV.source, "i") : NEVER_ENV;
  const askpassVars = win32 ? /^(SSH_ASKPASS|SSH_ASKPASS_REQUIRE|DISPLAY)$/i : /^(SSH_ASKPASS|SSH_ASKPASS_REQUIRE|DISPLAY)$/;
  const env: Record<string, string> = {};
  let display: string | undefined;
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || never.test(k)) continue;
    if (askpassVars.test(k)) {
      if (/^DISPLAY$/i.test(k)) display = v;
      continue;
    }
    env[k] = v;
  }
  if (o.mode === "batch") {
    env.SSH_ASKPASS_REQUIRE = "never";
    return env;
  }
  env.SSH_ASKPASS = o.askpass.program;
  env.SSH_ASKPASS_REQUIRE = "force";
  env.EMBER_ASKPASS_NONCE = o.askpass.nonce;
  if (o.askpass.kind === "socket") {
    // OpenSSH older than 8.4 runs askpass only with a DISPLAY and no terminal (Ember's ssh has none: detached).
    env.DISPLAY = display || "ember:0";
    env.EMBER_ASKPASS_SOCK = o.askpass.sock;
  } else {
    env.EMBER_ASKPASS_PIPE = o.askpass.pipe;
  }
  return env;
}
