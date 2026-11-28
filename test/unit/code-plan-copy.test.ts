/**
 * The Plan tab's words (app/renderer/code/copy-plan.ts): pinned; the rules every word of both tabs keeps are in
 * code-changes-copy.test.ts.
 */
import { describe, expect, it } from "vitest";
import * as P from "../../app/renderer/code/copy-plan";

describe("the Plan tab's words", () => {
  it("names each part, its empty state and its questions", () => {
    expect([P.PLAN_HEADING, P.TODOS_HEADING, P.OBJECTIVE_HEADING]).toEqual(["Plan", "To-dos", "Autopilot objective"]);
    expect(P.PLAN_NONE).toBe("Copilot hasn't written a plan for this session.");
    expect(P.DELETE_PLAN_QUESTION).toBe("Delete the plan?");
    expect(P.todoProgress(1, 4)).toBe("1 of 4 done");
    expect(P.afterWords(["Read next", "OAuth"])).toBe("After “Read next”, “OAuth”");
    expect(P.todoStatusWord("other", "later")).toBe("later");
    expect(P.objectiveTurns(1)).toBe("1 turn so far");
    expect(P.objectiveTurns(0)).toBe("Not started yet");
    expect(P.readFailed("todos", "That didn't reach Ember. Try again.")).toBe("Ember couldn't read the to-dos. That didn't reach Ember. Try again.");
    expect(P.writeFailed("objective", "delete", "")).toBe("Ember couldn't delete the objective.");
  });
});
