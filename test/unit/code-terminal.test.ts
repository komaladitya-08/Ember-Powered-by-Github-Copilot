/**
 * The Terminal tab's model (app/renderer/code/terminal-model.ts): output's ANSI escapes read into tones or dropped,
 * the command line's history, bounded scrollback, and the agent's shell commands read from the transcript with their
 * output, exit code, sandbox and duration.
 */
import { describe, expect, it } from "vitest";
import type { CodeSdkEvent } from "../../app/shared/code";
import {
  HISTORY_MAX, ansiRuns, boundScrollback, freshCursor, historyStep, keepTail, liveRowFor, remember, runMs, shellRuns, stripAnsi, type UserRun,
} from "../../app/renderer/code/terminal-model";
import { EMPTY_TRANSCRIPT, reduceEvent, type Transcript } from "../../app/renderer/code/transcript";

let n = 0;
const ev = (type: string, data: unknown, at = "2026-11-27T10:00:00Z"): CodeSdkEvent => ({ id: `t${++n}`, timestamp: at, type, data });
const play = (...events: CodeSdkEvent[]): Transcript => events.reduce(reduceEvent, EMPTY_TRANSCRIPT);
const E = "\u001b";

describe("a command's output, as text", () => {
  it("maps SGR colours and bold to tones, and resets them", () => {
    expect(ansiRuns(`ok ${E}[31mred${E}[0m ${E}[1;32mbold green${E}[22m plain green${E}[39m end`)).toEqual([
      { text: "ok " }, { text: "red", tone: "red" }, { text: " " }, { text: "bold green", tone: "green", bold: true }, { text: " plain green", tone: "green" }, { text: " end" },
    ]);
    expect(ansiRuns(`${E}[90mdim${E}[m`)).toEqual([{ text: "dim", tone: "dim" }]);
  });

  it("drops every other escape: cursor moves, screen clears, titles, 256 colours' arguments", () => {
    expect(ansiRuns(`${E}[2J${E}[Ha${E}]0;title\u0007b${E}[38;5;196mc${E}[0m`)).toEqual([{ text: "abc" }]);
    expect(stripAnsi(`${E}[1mhi${E}[0m${E}]8;;https://x\u0007link${E}]8;;\u0007\u0000`)).toBe("hilink");
  });

  it("shows a line rewritten with a carriage return as a terminal leaves it", () => {
    expect(stripAnsi("10%\r50%\r100%\ndone\r\n")).toBe("100%\ndone\n");
  });
});

describe("the command line's history", () => {
  it("keeps commands in order, without blanks or a repeat of the last, up to its limit", () => {
    let h: string[] = [];
    for (const c of ["ls", "  ", "ls", "git status", "ls"]) h = remember(h, c);
    expect(h).toEqual(["ls", "git status", "ls"]);
    let big: string[] = [];
    for (let i = 0; i < HISTORY_MAX + 3; i++) big = remember(big, `c${i}`);
    expect(big).toHaveLength(HISTORY_MAX);
    expect(big[0]).toBe("c3");
  });

  it("goes up through older commands and back down to what was being written", () => {
    const h = ["one", "two"];
    let cur = freshCursor(h);
    const up1 = historyStep(h, cur, "draft", "up")!;
    expect(up1.line).toBe("two");
    cur = up1.cursor;
    const up2 = historyStep(h, cur, up1.line, "up")!;
    expect(up2.line).toBe("one");
    expect(historyStep(h, up2.cursor, "one", "up")).toBeNull();
    const down1 = historyStep(h, up2.cursor, "one", "down")!;
    const down2 = historyStep(h, down1.cursor, "two", "down")!;
    expect(down2.line).toBe("draft");
    expect(historyStep(h, down2.cursor, "draft", "down")).toBeNull();
  });
});

describe("scrollback", () => {
  const run = (id: string, chars: number, state: UserRun["state"] = "done"): UserRun => ({ id, command: "x", output: "o".repeat(chars), cut: false, state, startedAt: 0 });
  it("drops the oldest commands past its limit, never the running one", () => {
    expect(boundScrollback([run("a", 50), run("b", 50), run("c", 50)], 110).map(r => r.id)).toEqual(["b", "c"]);
    expect(boundScrollback([run("a", 500, "running"), run("b", 50)], 100).map(r => r.id)).toEqual(["a", "b"]);
  });
  it("keeps a command's last output", () => {
    expect(keepTail("abcdef", 3)).toEqual({ text: "def", cut: true });
    expect(keepTail("ab", 3)).toEqual({ text: "ab", cut: false });
  });
});

describe("the agent's commands", () => {
  const t = play(
    ev("tool.execution_start", { toolCallId: "g", toolName: "grep", arguments: { pattern: "x" } }),
    ev("tool.execution_start", { toolCallId: "c1", toolName: "bash", arguments: { command: "npm test" }, shellToolInfo: { displayCommand: "npm test" } }, "2026-11-27T10:00:00Z"),
    ev("tool.shell_output", { toolCallId: "c1", text: "ok\n", sequence: 0 }),
    ev("tool.execution_complete", { toolCallId: "c1", success: false, shellExecution: { exitCode: 1 }, sandboxed: true }, "2026-11-27T10:00:04Z"),
    ev("tool.execution_start", { toolCallId: "c2", toolName: "bash", arguments: { command: "ls" } }, "2026-11-27T10:00:05Z"),
    ev("tool.execution_start", { toolCallId: "u1", toolName: "bash", arguments: { command: "git status" } }),
    ev("tool.execution_complete", { toolCallId: "u1", success: true, isUserRequested: true, shellExecution: { exitCode: 0 } }),
  );

  it("lists every shell command in order with its output, exit code, sandbox and the person's own marked", () => {
    const runs = shellRuns(t);
    expect(runs.map(r => [r.toolCallId, r.command, r.state, r.exitCode, r.sandboxed, r.userRequested])).toEqual([
      ["c1", "npm test", "failed", 1, true, false], ["c2", "ls", "running", undefined, undefined, false], ["u1", "git status", "done", 0, undefined, true],
    ]);
    expect(runs[0].output).toBe("ok\n");
    expect(shellRuns(undefined)).toEqual([]);
  });

  it("times a command from its start to its end, or to now while it runs", () => {
    const [done, running] = shellRuns(t);
    expect(runMs(done, 0)).toBe(4000);
    expect(runMs(running, Date.parse("2026-11-27T10:00:07Z"))).toBe(2000);
    expect(runMs({ state: "done" }, 0)).toBeUndefined();
  });

  it("finds the person's running command's row by its command among rows that weren't there when it was sent", () => {
    expect(liveRowFor(t, " ls ", new Set())?.toolCallId).toBe("c2");
    expect(liveRowFor(t, "ls", new Set(["c2"]))).toBeNull();
  });
});
