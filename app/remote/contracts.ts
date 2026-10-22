/**
 * The functions the remote agent takes from the packages it shares with the PC: CL's classifier (gate 2 judges every
 * command with the same rules the PC did), RUN's launcher, command environment and facts (§3.3, §3.3.1), behind their
 * contract signatures (design §11.4). Every other agent module receives them through `AgentContracts` (dependency
 * injection), so this file is the only place that names their implementations.
 *
 * The sweep script is the agent's own: RUN's `sweepScript` reads /proc only (a WSL distro's sweep), and an agent also
 * runs on macOS remotes, where `ps -E` is the only way to see a process's environment (§3.13).
 * Plain Node: no Electron, no koffi at load (RUN's job-object code loads it lazily, on Windows only).
 */

import type { OS } from "../shared/shortcuts";
import type { Classification, ClassifyContext, JobHostRef, RunnerFacts, RunSpec, ShellId } from "../main/commands/types";
import { classifyCommand } from "../main/commands/classify";
import { commandEnv } from "../main/commands/run/env";
import { localFacts } from "../main/commands/run/facts";
import { launchArgv } from "../main/commands/run/local";

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
// The agent's own sweep.

/**
 * The agent's sweep (§3.13). Linux: own-uid entries of /proc/[0-9]*\/environ holding EMBER_RUN_ID=<runId> (other
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

/** The contract functions the agent runs with: CL's and RUN's own. */
export const CONTRACTS: AgentContracts = { classifyCommand, launchArgv, commandEnv, sweepScript, localFacts };
