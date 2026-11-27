/**
 * The words of the coding window's Files, Terminal and Agents and tasks tabs (copy-files.ts, copy-terminal.ts,
 * copy-tasks.ts): pinned, sentence case with curly quotes round names, "…" only on what opens something or is under
 * way, straight apostrophes, and no raw SDK text.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as files from "../../app/renderer/code/copy-files";
import * as tasks from "../../app/renderer/code/copy-tasks";
import * as terminal from "../../app/renderer/code/copy-terminal";

describe("the Files tab's words", () => {
  it("names a file's change for a screen reader beside its mark", () => {
    expect(files.rowLabel("a.ts", "modified", false)).toBe("a.ts, changed");
    expect(files.rowLabel("a.ts", "edited", false)).toBe("a.ts, changed by Copilot");
    expect(files.rowLabel("src", "edited", true)).toBe("src, has changes");
    expect(files.rowLabel("b.ts", undefined, false)).toBe("b.ts");
  });
  it("says what a file is, and when only its start is shown", () => {
    expect(files.fileFacts(1, false)).toBe("1 line.");
    expect(files.fileFacts(1200, true, 5000)).toBe("1,200 lines, 4.9 KB. Only the start is shown.");
    expect(files.sizeWords(3 * 1024 * 1024)).toBe("3.0 MB");
    expect(files.TOO_BIG(3 * 1024 * 1024)).toBe("This file is 3.0 MB, too large to show here.");
  });
  it("says what a root holds when it is empty or nothing matches", () => {
    expect(files.rootEmpty("folder", "")).toBe("No files from this folder yet.");
    expect(files.rootEmpty("session", " zz ")).toBe("Nothing here matches “zz”.");
    expect(files.attached("a.ts")).toBe("“a.ts” will go with your next message.");
    expect(files.attachLabel("a.ts")).toBe("Attach “a.ts” to the message");
  });
});

describe("the Terminal tab's words", () => {
  it("ends a command with how it went, how long and where it ran", () => {
    expect(terminal.runEnd({ state: "failed", exitCode: 1, sandboxed: true }, 4200)).toBe("Failed, exit code 1, in 4 s. In the sandbox.");
    expect(terminal.runEnd({ state: "done", exitCode: 0 }, 125_000)).toBe("Finished, exit code 0, in 2 min 5 s.");
    expect(terminal.runEnd({ state: "done", exitCode: 2, sandboxed: false }, undefined)).toBe("Failed, exit code 2. Outside the sandbox.");
    expect(terminal.runEnd({ state: "running" }, 3000)).toBe("Running, 3 s so far.");
    expect(terminal.runEnd({ state: "cancelled" }, 1000)).toBe("Cancelled after 1 s.");
    expect(terminal.duration(3_720_000)).toBe("1 h 2 min");
  });
  it("says where the person's commands run and whether the sandbox holds them", () => {
    expect(terminal.whereItRuns("/home/me/work/app", "on")).toBe("Runs in work/app. In the sandbox.");
    expect(terminal.whereItRuns("/home/me/work/app", "off")).toBe("Runs in work/app. Outside the sandbox.");
    expect(terminal.whereItRuns("/home/me/work/app", undefined)).toBe("Runs in work/app. Whether it runs in the sandbox shows once the session has started.");
  });
  it("says it is a command runner, not a terminal", () => {
    expect(terminal.USER_EMPTY).toContain("it isn't a full terminal");
    expect(terminal.stopLabel("npm   test")).toBe("Stop “npm test”");
    expect(terminal.userRunDone(1, false)).toBe("Your command failed, exit code 1.");
  });
});

describe("the Agents and tasks tab's words", () => {
  it("names states in words beside their marks", () => {
    expect((["running", "idle", "completed", "failed", "cancelled", "orphaned"] as const).map(tasks.stateWords))
      .toEqual(["Running", "Waiting for a message", "Finished", "Failed", "Cancelled", "Lost touch"]);
    expect((["running", "idle", "completed", "failed", "cancelled"] as const).map(tasks.stateMark)).toEqual(["running", "waiting", "done", "failed", "stopped"]);
  });
  it("puts the count in the tab's name for screen readers", () => {
    expect(tasks.tabLabel(0)).toBe("Agents and tasks");
    expect(tasks.tabLabel(2)).toBe("Agents and tasks, 2 running");
    expect(tasks.taskFacts("agent", "explore", "gpt-5.4-mini", 125_000)).toBe("Agent: explore · gpt-5.4-mini · 2 min 5 s");
    expect(tasks.subAgentFacts(undefined, 1, 4200)).toBe("1 step · 4 s");
  });
  it("says when a schedule runs", () => {
    expect(tasks.scheduleWhen({ id: 1, prompt: "x", recurring: true, selfPaced: false, intervalMs: 600_000 })).toBe("Every 10 min");
    expect(tasks.scheduleWhen({ id: 1, prompt: "x", recurring: true, selfPaced: true })).toBe("When Copilot chooses");
    expect(tasks.scheduleWhen({ id: 1, prompt: "x", recurring: false, selfPaced: false, cron: "0 9 * * 1" })).toBe("On a schedule (0 9 * * 1)");
  });
});

describe("all three tabs' words", () => {
  it("use straight apostrophes, curly quotes, no tracked capitals, and an ellipsis character", () => {
    for (const f of ["copy-files.ts", "copy-terminal.ts", "copy-tasks.ts"]) {
      const src = fs.readFileSync(path.resolve("app/renderer/code", f), "utf8");
      expect(src, f).not.toMatch(/’/);
      expect(src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ""), f).not.toMatch(/\.\.\.(?!\w)/);
    }
    for (const value of [...Object.values(files), ...Object.values(terminal), ...Object.values(tasks)]) {
      if (typeof value !== "string") continue;
      expect(value, value).not.toMatch(/"[^"]+"/);
      expect(value, value).not.toMatch(/\b[A-Z]{4,}\b/);
    }
  });
});
