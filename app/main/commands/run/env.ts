/**
 * The environment every command runs with (§3.3.1; package RUN). Pure, so the remote agent bundles the same rules and
 * the tests pin them on every OS. It starts from the environment Ember itself was started with (`process.env` here,
 * the agent's sanitised one on a remote) and removes what a command must never get: Ember's own variables, Electron's
 * and Node's switches, the token that powers Ember's sign-in, and every variable that runs hidden code when a shell or
 * a program starts (rc files, exported functions, loader injection) or makes the shell read the command differently
 * from how it was classified (CDPATH, bash's option sets); on a remote also SSH's session variables. It repairs what Electron
 * changed for GUI apps (as `appEnv` does), adds the run's marker and the extra PATH folders, and on runs nobody can type
 * into makes a program that wants a password fail at once instead of waiting. Windows compares names without regard
 * to case (its environment is case-insensitive; Node keeps the stored spelling, such as "Path").
 */

import type { OS } from "../../../shared/shortcuts";

/** Removed by exact name (any case on Windows): Node's switches, Ember's sign-in, rc and loader injection. */
const REMOVE = [
  "NODE_OPTIONS", "NODE_PATH", "NODE_DEBUG",
  // The three variables Ember's sign-in reads (agent/auth.ts): the token that powers Ember never reaches a command.
  "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN",
  // No hidden code at a shell's start.
  "BASH_ENV", "ENV", "ZDOTDIR", "PROMPT_COMMAND", "PS1", "PS2", "PS3", "PS4",
  // Nor a shell that reads the classified text differently (L9's reason for no rc files): bash and zsh take CDPATH from
  // the environment (`cd build` could land in $CDPATH/build, not the folder the decision judged), bash takes its option
  // sets (SHELLOPTS, BASHOPTS: extglob changes the grammar) and GLOBIGNORE; IFS is reset by every shell Ember starts.
  "CDPATH", "SHELLOPTS", "BASHOPTS", "GLOBIGNORE", "IFS",
  "LD_PRELOAD", "LD_LIBRARY_PATH", "LD_AUDIT",
  // Electron's and an AppImage's markers (appEnv's repairs): GUI apps a command starts stay readable by Ember.
  "ORIGINAL_XDG_CURRENT_DESKTOP", "CHROME_DESKTOP", "NO_AT_BRIDGE", "APPDIR", "APPIMAGE", "ARGV0", "OWD",
];
/**
 * Removed by prefix: Ember's own, Electron's, Copilot's, the macOS loader's (L9: every DYLD_*), and bash's exported
 * functions (`BASH_FUNC_ls%%=() { … }` makes every `ls` in the command run that hidden body instead).
 */
const REMOVE_PREFIXES = ["EMBER_", "ELECTRON_", "COPILOT_", "DYLD_", "BASH_FUNC_"];
/** Removed on a remote: the SSH session's own variables. */
const REMOTE_REMOVE = ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "SSH_ORIGINAL_COMMAND"];
/** Removed on runs without a PTY: helpers that would put up a password prompt nobody can answer. */
const PIPE_REMOVE = ["SUDO_ASKPASS", "SSH_ASKPASS"];
/** Set on runs without a PTY (critique security-12): a program that wants an answer fails at once. */
const PIPE_DEFAULTS: Readonly<Record<string, string>> = { GIT_TERMINAL_PROMPT: "0", DEBIAN_FRONTEND: "noninteractive", SSH_ASKPASS_REQUIRE: "never" };
/** PATH's base when the environment has none and folders must be added (a POSIX shell's own default). */
const POSIX_DEFAULT_PATH = "/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";

/** An environment whose names compare as the OS compares them (Windows: without regard to case). */
export class EnvMap {
  private readonly vars = new Map<string, { name: string; value: string }>();

  constructor(private readonly os: OS, base: NodeJS.ProcessEnv | Record<string, string> = {}) {
    for (const [k, v] of Object.entries(base)) if (typeof v === "string") this.set(k, v);
  }

  private key(name: string): string {
    return this.os === "win32" ? name.toUpperCase() : name;
  }

  get(name: string): string | undefined {
    return this.vars.get(this.key(name))?.value;
  }

  /** Sets a variable, replacing it under any spelling Windows treats as the same name (the stored spelling is kept). */
  set(name: string, value: string): void {
    const k = this.key(name);
    const had = this.vars.get(k);
    this.vars.set(k, { name: had ? had.name : name, value });
  }

  delete(name: string): void {
    this.vars.delete(this.key(name));
  }

  /** Removes every variable whose name starts with `prefix` (without regard to case on Windows). */
  deletePrefix(prefix: string): void {
    const p = this.key(prefix);
    for (const k of [...this.vars.keys()]) if (k.startsWith(p)) this.vars.delete(k);
  }

  toRecord(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const { name, value } of this.vars.values()) out[name] = value;
    return out;
  }
}

/** `PATH` with `extra` folders appended that aren't already there (Windows: compared without regard to case). */
export function appendPath(path: string | undefined, extra: readonly string[], os: OS): string | undefined {
  const sep = os === "win32" ? ";" : ":";
  const norm = (d: string) => {
    const t = os === "win32" ? d.replace(/[\\/]+$/, "").toLowerCase() : d.replace(/\/+$/, "");
    return t === "" ? d : t;
  };
  const wanted = extra.filter(d => d !== "" && !d.includes(sep) && !d.includes("\0"));
  if (wanted.length === 0) return path;
  const parts = path !== undefined && path !== "" ? path.split(sep) : os === "win32" ? [] : POSIX_DEFAULT_PATH.split(sep);
  const seen = new Set(parts.map(norm));
  for (const d of wanted) {
    if (seen.has(norm(d))) continue;
    seen.add(norm(d));
    parts.push(d);
  }
  return parts.join(sep);
}

/**
 * The base environment of every command run (§3.3.1): `base` cleaned as above, with `TERM` (xterm-256color on a PTY,
 * dumb on pipes), `EMBER_RUN_ID` (the marker the kill sweep finds stragglers by, §3.13), `extraPath` appended to PATH,
 * and the non-interactive defaults on runs without a PTY. `remote` also removes SSH's session variables. The user's own
 * variables are kept, their ssh-agent and their own tool tokens included: those are the user's capabilities, and the
 * classifier asks before commands that would print or send them.
 */
export function commandEnv(base: NodeJS.ProcessEnv, o: { os: OS; pty: boolean; remote: boolean; extraPath: string[]; runId: string }): Record<string, string> {
  const env = new EnvMap(o.os, base);
  // Electron rewrites XDG_CURRENT_DESKTOP for its own process; GUI apps a command starts get the session's own value.
  const desktop = env.get("ORIGINAL_XDG_CURRENT_DESKTOP");
  if (desktop !== undefined) env.set("XDG_CURRENT_DESKTOP", desktop);
  for (const name of REMOVE) env.delete(name);
  for (const prefix of REMOVE_PREFIXES) env.deletePrefix(prefix);
  if (o.remote) for (const name of REMOTE_REMOVE) env.delete(name);
  if (!o.pty) {
    for (const name of PIPE_REMOVE) env.delete(name);
    for (const [k, v] of Object.entries(PIPE_DEFAULTS)) env.set(k, v);
  }
  const path = appendPath(env.get("PATH"), o.extraPath, o.os);
  if (path !== undefined) env.set("PATH", path);
  env.set("TERM", o.pty ? "xterm-256color" : "dumb");
  env.set("EMBER_RUN_ID", o.runId);
  return env.toRecord();
}

/** `base` with `extra` laid over it, names compared as `os` compares them (a later value replaces any spelling). */
export function mergeEnv(base: Record<string, string>, extra: Record<string, string>, os: OS): Record<string, string> {
  const env = new EnvMap(os, base);
  for (const [k, v] of Object.entries(extra)) env.set(k, v);
  return env.toRecord();
}

/** Where Homebrew puts command-line tools on a Mac: apps started from Finder get launchd's PATH without them. */
const MAC_BREW_DIRS = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];

/**
 * A Mac's extra command folders (§3.3.1, critique integration-18), for an agent that must work them out itself (main
 * passes the PC's through TargetsDeps.extraPath): Homebrew's folders, then each line of `/etc/paths` and of every file
 * in `/etc/paths.d` (sorted), read as data and never run; only absolute folders that exist, each once.
 */
export function macExtraPath(o: { readText(file: string): string | null; list(dir: string): string[]; isDir(dir: string): boolean }): string[] {
  const lines = (file: string) => (o.readText(file) ?? "").split(/\r?\n/).map(l => l.trim());
  const listed = (() => {
    try {
      return o.list("/etc/paths.d").filter(n => !n.startsWith(".")).sort();
    } catch {
      return []; // no /etc/paths.d: nothing listed there
    }
  })();
  const candidates = [...MAC_BREW_DIRS, ...lines("/etc/paths"), ...listed.flatMap(n => lines(`/etc/paths.d/${n}`))];
  const out: string[] = [];
  for (const d of candidates) {
    if (!d.startsWith("/") || d.startsWith("#") || /[\0:]/.test(d) || out.includes(d)) continue;
    let dir = false;
    try {
      dir = o.isDir(d);
    } catch {
      // unreadable: left out
    }
    if (dir) out.push(d);
  }
  return out;
}
