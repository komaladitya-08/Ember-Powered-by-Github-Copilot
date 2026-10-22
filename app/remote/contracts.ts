/**
 * The functions the remote agent takes from packages built alongside it (CL's classifier; RUN's launcher, command
 * environment, sweep script and facts), behind their exact contract signatures (design §11.4, pkg-run.md, pkg-cl.md).
 * Every other agent module receives them through `AgentContracts` (dependency injection), so this file is the only
 * place that names their implementations.
 *
 * Until CL and RUN merge, the implementations here are fail-closed stand-ins written from the design's normative text:
 * - `classifyCommand` finds one "unclear" finding in every command (gate 2 then asks once for every command: the PC
 *   resends with that rule in its stamp after the user's yes, §3.16), and never refuses on its own;
 * - `launchArgv`, `commandEnv`, `sweepScript` and `localFacts` follow §3.3, §3.3.1 and §3.13 for POSIX targets (the
 *   only ones an agent runs on in v1) and throw for the others.
 * When CL and RUN land, the body of this file becomes re-exports of theirs (the signatures are already theirs).
 * Plain Node: no Electron, no koffi; a target's paths through node:path/posix.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path/posix";
import type { OS } from "../shared/shortcuts";
import { SHELL_FAMILY } from "../main/commands/types";
import type { Classification, ClassifyContext, JobHostRef, RunnerFacts, RunSpec, ShellId } from "../main/commands/types";
import { NO_RC, posixBody, posixInner } from "../main/commands/run/shells";

/** CL: what a command does (pure). */
export type ClassifyCommand = (text: string, shell: ShellId, ctx: ClassifyContext) => Classification;
/** RUN: the exact argv, spawn options and the run's own environment additions (§3.3; pure). */
export type LaunchArgv = (spec: RunSpec, facts: RunnerFacts, o: { jobHost: JobHostRef | null; wsl?: { exe: string; distro: string } }) => {
  command: string;
  args: string[];
  options: { detached: boolean; windowsHide?: boolean; stdio: ["pipe" | "ignore", "pipe", "pipe"] };
  env: Record<string, string>;
};
/** RUN: §3.3.1's base environment for a run (pure). */
export type CommandEnv = (base: NodeJS.ProcessEnv, o: { os: OS; pty: boolean; remote: boolean; extraPath: string[]; runId: string }) => Record<string, string>;
/** RUN: this computer's RunnerFacts. */
export type LocalFacts = (o: { os: OS; env: NodeJS.ProcessEnv; home: string; user: string; elevated: () => boolean; extraPath: string[]; ember: RunnerFacts["ember"] }) => Promise<RunnerFacts>;

/** What the agent uses of CL and RUN. */
export interface AgentContracts {
  classifyCommand: ClassifyCommand;
  launchArgv: LaunchArgv;
  commandEnv: CommandEnv;
  /** The sweep (§3.13), run as `/bin/sh -s -- <SIGNAL> <runId>` with this text on its stdin. */
  sweepScript: string;
  localFacts: LocalFacts;
}

// ---------------------------------------------------------------------------------------------------------------------
// The stand-ins.

/** The rule the stand-in classifier gives every command (the PC adds it to the stamp after the user's yes). */
export const UNCHECKED_RULE = "remote.unchecked";

/** CL stand-in: every command is "unclear" (asks), nothing is refused here (the PC's own classifier refuses). */
export const classifyCommand: ClassifyCommand = (_text, shell) => ({
  shell,
  family: SHELL_FAMILY[shell],
  findings: [{
    cls: "unclear",
    rule: UNCHECKED_RULE,
    says: "This computer can't check commands itself yet, so each one asks first.",
    program: "",
    objects: [],
    widening: [],
    at: 0,
  }],
  refuse: null,
  probe: [],
  needsGit: false,
  downloads: [],
  programs: [],
  commands: [],
});

/** A POSIX shell's path may go into a fixed launcher text only when it is made of these characters (§3.3). */
const SAFE_PATH = /^\/[A-Za-z0-9/._-]+$/;

/** RUN stand-in: §3.3's table for Linux and macOS (PTY through script(1), else pipes). */
export const launchArgv: LaunchArgv = (spec, facts) => {
  if (facts.os === "win32" || spec.shell === "powershell" || spec.shell === "cmd") throw new Error("this computer runs POSIX shells only");
  const shell = spec.shell;
  const shellPath = facts.shellPaths[shell];
  if (!shellPath || !SAFE_PATH.test(shellPath)) throw new Error(`${shell} isn't available here`);
  const env: Record<string, string> = { EMBER_CMD: spec.command, EMBER_RUN_ID: spec.runId };
  if (facts.script && facts.pty) {
    Object.assign(env, { SHELL: "/bin/sh", TERM: "xterm-256color", EMBER_COLS: String(spec.cols), EMBER_ROWS: String(spec.rows) });
    const inner = posixInner(shell, shellPath, "env");
    const args = facts.script.kind === "util-linux" ? ["-q", "-e", "-f", "-c", inner, "/dev/null"] : ["-q", "/dev/null", "/bin/sh", "-c", inner];
    return { command: facts.script.path, args, options: { detached: true, stdio: ["pipe", "pipe", "pipe"] }, env };
  }
  env.TERM = "dumb";
  return { command: shellPath, args: [...NO_RC[shell], "-c", posixBody({ pty: false, from: "env" })], options: { detached: true, stdio: ["ignore", "pipe", "pipe"] }, env };
};

/** Variables no command inherits (§3.3.1): Ember's sign-in, Node's and the loader's switches, hidden start-up code. */
const REMOVE = /^(EMBER_.*|ELECTRON_.*|COPILOT_.*|NODE_OPTIONS|NODE_PATH|NODE_DEBUG|GH_TOKEN|GITHUB_TOKEN|BASH_ENV|ENV|ZDOTDIR|PROMPT_COMMAND|PS[1-4]|LD_PRELOAD|LD_LIBRARY_PATH|LD_AUDIT|DYLD_INSERT_LIBRARIES|DYLD_LIBRARY_PATH|CHROME_DESKTOP|NO_AT_BRIDGE|APPDIR|APPIMAGE|ARGV0|OWD)$/;
/** On a remote, also the SSH login's own variables. */
const REMOVE_REMOTE = /^(SSH_CONNECTION|SSH_CLIENT|SSH_TTY|SSH_ORIGINAL_COMMAND)$/;

/** RUN stand-in: §3.3.1 for POSIX targets. */
export const commandEnv: CommandEnv = (base, o) => {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v === undefined || REMOVE.test(k) || (o.remote && REMOVE_REMOTE.test(k))) continue;
    env[k] = v;
  }
  if (base.ORIGINAL_XDG_CURRENT_DESKTOP) env.XDG_CURRENT_DESKTOP = base.ORIGINAL_XDG_CURRENT_DESKTOP;
  delete env.ORIGINAL_XDG_CURRENT_DESKTOP;
  const have = (env.PATH ?? "").split(":").filter(Boolean);
  env.PATH = [...have, ...o.extraPath.filter(p => !have.includes(p))].join(":");
  env.TERM = o.pty ? "xterm-256color" : "dumb";
  env.EMBER_RUN_ID = o.runId;
  if (!o.pty) {
    Object.assign(env, { GIT_TERMINAL_PROMPT: "0", DEBIAN_FRONTEND: "noninteractive", SSH_ASKPASS_REQUIRE: "never" });
    delete env.SUDO_ASKPASS;
    delete env.SSH_ASKPASS;
  }
  return env;
};

/**
 * RUN stand-in: §3.13's sweep. Linux: own-uid entries of /proc/[0-9]*\/environ holding EMBER_RUN_ID=<runId> (other
 * users' environ files can't be read); macOS: `ps -E` lines of the user's own processes holding it. $1 is the signal
 * name, $2 the run id (16 hex digits: the agent checks it before it starts a sweep).
 */
export const sweepScript = [
  "if [ -r /proc/self/environ ]; then",
  "  for p in /proc/[0-9]*; do grep -qz \"^EMBER_RUN_ID=$2\\$\" \"$p/environ\" 2>/dev/null && kill -$1 \"${p#/proc/}\" 2>/dev/null; done",
  "else",
  "  ps -E -ww -U \"$(id -u)\" -o pid=,command= 2>/dev/null | while read -r pid rest; do",
  "    case \" $rest \" in *\" EMBER_RUN_ID=$2 \"*) kill -$1 \"$pid\" 2>/dev/null ;; esac",
  "  done",
  "fi",
  "exit 0",
].join("\n") + "\n";

/** Which shell is the default (§3.3: Linux bash, else sh; macOS zsh, else bash, else sh), then the others found. */
const SHELL_ORDER: Readonly<Record<"linux" | "darwin", readonly ("bash" | "zsh" | "sh")[]>> = { linux: ["bash", "sh", "zsh"], darwin: ["zsh", "bash", "sh"] };

/** `program --version`'s first line, or "" (a 3 s limit; never throws). */
function versionLine(program: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise(resolve => {
    execFile(program, ["--version"], { timeout: 3000, env, encoding: "utf8" }, (_err, stdout, stderr) => {
      resolve(`${stdout ?? ""}${stderr ?? ""}`.split("\n")[0] ?? "");
    });
  });
}

/** The first executable `name` on PATH (then the usual system folders), as an absolute path; null when none. */
function findProgram(name: string, env: NodeJS.ProcessEnv): string | null {
  const dirs = [...(env.PATH ?? "").split(":"), "/usr/bin", "/bin", "/usr/local/bin"].filter(d => d.startsWith("/"));
  for (const d of dirs) {
    const p = path.join(d, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch { /* not here */ }
  }
  return null;
}

/** RUN stand-in: the facts of the POSIX machine this runs on. */
export const localFacts: LocalFacts = async o => {
  if (o.os === "win32") throw new Error("this computer runs POSIX shells only");
  const shells: ShellId[] = [];
  const shellPaths: RunnerFacts["shellPaths"] = {};
  for (const s of SHELL_ORDER[o.os]) {
    const p = findProgram(s, o.env);
    if (p && SAFE_PATH.test(p)) { shells.push(s); shellPaths[s] = p; }
  }
  let script: RunnerFacts["script"] = null;
  if (o.os === "darwin") {
    if (findProgram("script", { PATH: "/usr/bin" }) === "/usr/bin/script") script = { path: "/usr/bin/script", kind: "bsd" };
  } else {
    const p = findProgram("script", o.env);
    if (p && SAFE_PATH.test(p) && /util-linux/.test(await versionLine(p, o.env))) script = { path: p, kind: "util-linux" };
  }
  return {
    os: o.os,
    shells,
    shellPaths,
    script,
    home: o.home,
    user: o.user,
    privileged: o.elevated(),
    pty: script !== null,
    ember: o.ember,
    extraPath: [...o.extraPath],
  };
};

/** The contract functions the agent runs with. */
export const CONTRACTS: AgentContracts = { classifyCommand, launchArgv, commandEnv, sweepScript, localFacts };
