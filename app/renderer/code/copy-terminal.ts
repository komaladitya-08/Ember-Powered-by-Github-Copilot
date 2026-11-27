/**
 * The Terminal tab's words, as pure functions: sentence case, British spelling, curly quotes round names, and plain
 * sentences in place of anything the SDK said. Pinned in test/unit/code-terminal-copy.test.ts.
 */
import { pathTail, sandboxWords } from "./copy";

export const AGENT_HEADING = "Copilot's commands";
export const USER_HEADING = "Your commands";
export const RUNNING_NOW = "Running now";
export const NO_AGENT_COMMANDS = "Copilot hasn't run a command in this session yet.";
export const SHOW_IN_TRANSCRIPT = "Show in transcript";
export const STOP_COMMAND = "Stop";
export const STOP_TURN = "Stop the turn";
export const COMMAND_LINE_LABEL = "Command";
export const RUN = "Run";
export const CANCEL = "Cancel";
export const CLEAR = "Clear";
export const OUTPUT_CUT = "Only the last part of the output is kept.";
export const NO_OUTPUT = "No output.";
export const YOUR_RUN = "You ran this";
export const BY_SUB_AGENT = "A sub-agent ran this";

/** What the person's shell is: said where it is empty, so nobody expects a full terminal. */
export const USER_EMPTY = "Run a command in the session's folder. Copilot sees what it prints. This runs one command at a time and shows its output: it isn't a full terminal, so programs that ask for input or draw the screen won't work here.";
export const COMMAND_HINT = "Enter runs. Up and Down go through earlier commands.";

/** Where the person's commands run, and whether the sandbox holds them. */
export function whereItRuns(folder: string, sandbox: string | undefined): string {
  const box = sandboxWords(sandbox);
  const at = `Runs in ${pathTail(folder) || "the session's folder"}`;
  if (!box) return `${at}. Whether it runs in the sandbox shows once the session has started.`;
  return `${at}. ${box}.`;
}

/** A command's end in words: still going, how it ended, how long it took and where it ran. */
export function runEnd(r: { state: string; exitCode?: number; sandboxed?: boolean }, ms: number | undefined): string {
  const took = ms !== undefined ? ` ${duration(ms)}` : "";
  const box = r.sandboxed === true ? " In the sandbox." : r.sandboxed === false ? " Outside the sandbox." : "";
  if (r.state === "running") return `Running${took ? `,${took} so far` : ""}.${box}`;
  if (r.state === "cancelled") return `Cancelled${took ? ` after${took}` : ""}.`;
  const code = r.exitCode !== undefined ? `, exit code ${r.exitCode}` : "";
  const how = r.state === "failed" || (r.exitCode !== undefined && r.exitCode !== 0) ? `Failed${code}` : `Finished${code}`;
  return `${how}${took ? `, in${took}` : ""}.${box}`;
}

/** A length of time as people say it: "4 s", "2 min 5 s", "1 h 3 min". */
export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60), rest = s % 60;
  if (m < 60) return rest ? `${m} min ${rest} s` : `${m} min`;
  const h = Math.floor(m / 60), mins = m % 60;
  return mins ? `${h} h ${mins} min` : `${h} h`;
}

/** The button that shows Copilot's earlier commands. */
export const earlierLabel = (n: number): string => `Show earlier (${n})`;
/** A command's output, as a screen reader names it. */
export const outputLabel = (command: string): string => `Output of “${short(command)}”`;
/** A Stop button's full name. */
export const stopLabel = (command: string): string => `Stop “${short(command)}”`;
/** A command's row in the transcript. */
export const showLabel = (command: string): string => `Show “${short(command)}” in the transcript`;
/** The running indicator of the person's command. */
export const runningLabel = (command: string): string => `Running “${short(command)}”…`;
const short = (c: string) => { const one = c.replace(/\s+/g, " ").trim(); return one.length > 60 ? `${one.slice(0, 59)}…` : one; };

export const CANT_RUN = "That command couldn't start. Try again.";
export const CANT_CANCEL = "That command couldn't be cancelled. It may have finished.";
export const CANT_STOP = "That command couldn't be stopped. It may have finished.";
export const NOT_IN_TRANSCRIPT = "That command's row isn't in the transcript any more.";
/** Said once when the person's command ends (never its output). */
export const userRunDone = (exitCode: number | undefined, ok: boolean): string =>
  ok ? `Your command finished${exitCode !== undefined ? `, exit code ${exitCode}` : ""}.` : `Your command failed${exitCode !== undefined ? `, exit code ${exitCode}` : ""}.`;
