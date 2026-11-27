/**
 * The Plan tab's logic (app/renderer/code/plan-model.ts): the plan file, the to-dos with their dependencies, the
 * Autopilot objective, and the exit-plan-mode request main has waiting.
 */
import { describe, expect, it } from "vitest";
import type { CodePendingRequest } from "../../app/shared/code";
import {
  fitsParams, objectiveFileFrom, objectiveStateFrom, objectiveText, pendingPlanExit, planFrom, requestItemOf, todoProgress, todoStatus, todosFrom, TODO_SYMBOL,
} from "../../app/renderer/code/plan-model";
import { EMPTY_STATE } from "../../app/renderer/code/store";

describe("the plan file", () => {
  it("reads whether it exists and what it says", () => {
    expect(planFrom({ exists: true, content: "## Plan", path: "/p/plan.md" })).toEqual({ exists: true, content: "## Plan" });
    expect(planFrom({ exists: false, content: null, path: null })).toEqual({ exists: false, content: "" });
    expect(planFrom({ exists: true, content: null })).toEqual({ exists: false, content: "" });
    expect(planFrom({})).toBeNull();
  });

  it("fits a save into one call's params, as main bounds them", () => {
    expect(fitsParams("short")).toBe(true);
    expect(fitsParams("é".repeat(200_000))).toBe(false);
  });
});

describe("the to-dos", () => {
  it("names the agent's free-form states, and draws each with a shared state symbol", () => {
    expect(["pending", "", "in_progress", "In Progress", "done", "completed", "blocked", "cancelled", "later"].map(todoStatus))
      .toEqual(["pending", "pending", "in-progress", "in-progress", "done", "done", "blocked", "skipped", "other"]);
    expect(TODO_SYMBOL.done).toBe("done");
    expect(TODO_SYMBOL["in-progress"]).toBe("running");
  });

  it("lists them in order with what each waits for, by title", () => {
    const l = todosFrom({
      rows: [
        { id: "a", title: "Read next", status: "done" },
        { id: "b", title: "OAuth", status: "in_progress", description: "src/oauth.ts" },
        { id: "c", status: "pending", description: "Tests for both" },
        { id: "d", title: "Odd", status: "later" },
        "junk",
      ],
      dependencies: [{ todoId: "c", dependsOn: "a" }, { todoId: "c", dependsOn: "b" }, { todoId: "c", dependsOn: "a" }, { todoId: "d", dependsOn: "gone" }, { todoId: "a", dependsOn: "a" }],
    }, true)!;
    expect(l.withDependencies).toBe(true);
    expect(l.todos.map(t => [t.id, t.title, t.status, t.after, t.ready])).toEqual([
      ["a", "Read next", "done", [], true], ["b", "OAuth", "in-progress", [], true], ["c", "Tests for both", "pending", ["Read next", "OAuth"], false], ["d", "Odd", "other", ["gone"], false],
    ]);
    expect(l.todos[1].description).toBe("src/oauth.ts");
    expect(l.todos[2].description).toBeUndefined();
    expect(l.todos[3].rawStatus).toBe("later");
    expect(todoProgress(l.todos)).toEqual({ done: 1, total: 4 });
  });

  it("reads the rows alone from the older method, and nothing from a shape that isn't one", () => {
    expect(todosFrom({ rows: [{ title: "x" }] }, false)).toEqual({ withDependencies: false, todos: [{ id: "#1", title: "x", status: "pending", after: [], ready: true }] });
    expect(todosFrom({ nope: [] }, true)).toBeNull();
  });
});

describe("the Autopilot objective", () => {
  it("reads the runtime's state and the objective file", () => {
    expect(objectiveStateFrom({ state: { id: 2, objective: "Ship it", status: "paused", turnCount: 3, pauseReason: "Credit limit reached", creditCountNanoAiu: "0" } }))
      .toEqual({ id: 2, objective: "Ship it", status: "paused", turns: 3, pauseReason: "Credit limit reached" });
    expect(objectiveStateFrom({ state: null })).toBeNull();
    expect(objectiveStateFrom({})).toBeUndefined();
    expect(objectiveFileFrom({ content: "Ship it" })).toBe("Ship it");
    expect(objectiveFileFrom({ content: null })).toBeNull();
    expect(objectiveFileFrom("x")).toBeUndefined();
  });

  it("shows the file's words, else the runtime's", () => {
    expect(objectiveText({ content: "File", state: null })).toBe("File");
    expect(objectiveText({ content: null, state: { id: 1, objective: "Runtime", status: "active", turns: 0 } })).toBe("Runtime");
    expect(objectiveText({ content: "  " })).toBe("");
  });
});

describe("leaving plan mode", () => {
  const p = (requestId: string, kind: CodePendingRequest["kind"], openedAt: number, sessionId = "s1"): CodePendingRequest => ({ sessionId, requestId, kind, data: { summary: "x", actions: ["interactive"] }, openedAt });

  it("finds the request main has waiting for the session shown, the oldest first", () => {
    const s = { ...EMPTY_STATE, pending: { a: p("a", "permission", 1), b: p("b", "exit-plan-mode", 3), c: p("c", "exit-plan-mode", 2), d: p("d", "exit-plan-mode", 0, "s2") } };
    expect(pendingPlanExit(s, "s1")?.requestId).toBe("c");
    expect(pendingPlanExit(s, null)).toBeNull();
    expect(pendingPlanExit(EMPTY_STATE, "s1")).toBeNull();
  });

  it("draws it from main's entry as the card would, never answered", () => {
    expect(requestItemOf(p("c", "exit-plan-mode", 2))).toEqual({ kind: "request", key: "plan-tab-c", requestId: "c", request: "exit-plan-mode", data: { summary: "x", actions: ["interactive"] }, done: false });
  });
});
