/**
 * The run_command flow (§3.8.3; owned by package AG). STUB from Step 0a: `runCommandTool` has its final signature and
 * fails every call ("not built") without running, asking or recording anything.
 */

import type { ToolResultObject } from "@github/copilot-sdk";
import type { Logger } from "../logger";
import type { Confirmer } from "../agent/confirm";
import type { Presenter } from "../agent/presenter";
import type { AuditEntry } from "../policy/audit";
import type { Agreement, ReadSource } from "../policy/policy";
import type { CommandService, RunCommandArgs } from "./types";

/** What run_command needs from its worker. */
export interface CommandFlowContext {
  task: {
    id: string;
    title: string;
    /** The user's own words only (Worker.commandWords, §3.7): never the goal; "" when none. */
    commandWords: () => string;
    agreed: () => Agreement[];
    tainted: () => boolean;
    /** Marks the task tainted (command output that reads like instructions, §3.11 step 7); audited. */
    taint: (why: string) => void;
    readFrom: () => ReadSource[];
  };
  service: CommandService;
  confirmer: Confirmer;
  presenter: Presenter;
  audit: (e: AuditEntry) => void;
  log: Logger;
  /** The task's own stop: the run stops with it. */
  signal: AbortSignal;
  isOver: () => boolean;
  /** The task's folder and downloads on this target (kept by the worker across calls). */
  state: { cwd: string | null; downloaded: Set<string>; running: boolean };
  /** The command window's size for new runs. */
  size: () => { cols: number; rows: number };
  /** Ember's own pids now (D4.5; main's live list, §3.6.2). */
  emberPids: () => number[];
}

const fail = (text: string): ToolResultObject => ({ textResultForLlm: text, resultType: "failure", error: text });

/** Runs one run_command call to the end; returns the tool result (done, denied or fail). */
export async function runCommandTool(_a: RunCommandArgs, _ctx: CommandFlowContext): Promise<ToolResultObject> {
  return fail("not built");
}
