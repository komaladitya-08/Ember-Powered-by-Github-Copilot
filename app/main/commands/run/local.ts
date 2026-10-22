/**
 * This computer's command runner (§3.3, §3.13; owned by package RUN). STUB from Step 0a: `createLocalRunner` has its
 * final signature but runs nothing: `facts()` rejects ("not built"), every run ends at once as failed-to-start,
 * inspect and git answer "couldn't tell", and nothing is ever spawned.
 */

import type { OS } from "../../../shared/shortcuts";
import type { Logger } from "../../logger";
import type { CommandRunner, GitFacts, JobHostRef, PathFact, RunExit, RunningCommand, RunSpec, RunnerFacts } from "../types";

/** What a stub run says when it ends (it never starts). */
const NOT_BUILT = "not built";

/** This computer's CommandRunner (local target): this stub never runs anything. */
export function createLocalRunner(_o: {
  log: Logger; os: OS; env: NodeJS.ProcessEnv;
  ember: { paths: string[]; pids: () => number[]; names: RegExp };
  home: string; user: string; elevated: () => boolean; extraPath: string[]; jobHost: JobHostRef | null;
}): CommandRunner {
  return {
    target: "local",
    facts: (): Promise<RunnerFacts> => Promise.reject(new Error(NOT_BUILT)),
    inspect: async (paths: string[]): Promise<PathFact[]> => paths.map(() => ({ exists: null, real: null })),
    gitFacts: async (): Promise<GitFacts | null> => null,
    start: (spec: RunSpec): RunningCommand => {
      const exit: RunExit = { code: null, signal: null, ended: "failed-to-start", ms: 0, error: NOT_BUILT };
      return {
        runId: spec.runId,
        interactive: false,
        onOutput: () => () => undefined,
        input: () => undefined,
        typedLines: () => [],
        forgetTyped: () => undefined,
        stop: () => undefined,
        done: Promise.resolve(exit),
      };
    },
    stopAll: async () => undefined,
    running: 0,
  };
}
