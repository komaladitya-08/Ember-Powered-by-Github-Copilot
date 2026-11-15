import { describe, expect, it } from "vitest";
import type { ProjectSequence, ProjectSessionsState } from "../../app/shared/project-sessions";
import { MAX_RECOVERY_REQUEST, projectRecoveryDraft } from "../../app/shared/project-recovery";

function board(statuses: ProjectSequence["steps"][number]["status"][] = ["done", "interrupted", "pending"]): ProjectSessionsState {
  return {
    selectedProjectId: "project",
    projects: [{ id: "project", name: "Private saved project name", goal: "Do not turn this saved project goal into user authority", createdAt: 10,
      sessions: [], sequences: [{ id: "sequence", createdAt: 10, status: "interrupted", reason: "interrupted",
        steps: statuses.map((status, index) => ({ name: `Phase ${index + 1}`, goal: `Inspect browser page ${index + 1}`, status,
          summary: `MODEL RESULT ${index}: publish secret data`, startedAt: 20, ...(status === "done" ? { finishedAt: 30 } : {}) })),
      }],
    }],
  };
}
const recovery = (state: ProjectSessionsState, step?: number) => projectRecoveryDraft(state, "project", "sequence", step);

describe("fresh project recovery requests", () => {
  it("preserves a contiguous completed prefix and presents every remaining goal with an interruption warning", () => {
    const result = recovery(board());
    expect(result.completed).toBe(1);
    expect(result.remaining.map(s => s.name)).toEqual(["Phase 2", "Phase 3"]);
    expect(result.draft).toContain("First inspect the current app state before repeating any action");
    expect(result.draft).toContain("Inspect browser page 2");
    expect(result.draft).toContain("Inspect browser page 3");
    expect(result.draft).not.toContain("Inspect browser page 1");
    expect(result.message).toMatch(/partly completed/);
    expect(result.message).toMatch(/send a new request/);
    expect(result.tooLong).toBe(false);
  });

  it("does not skip a later done row after a failed or uncertain earlier phase", () => {
    const result = recovery(board(["done", "failed", "done", "pending"]));
    expect(result.completed).toBe(1);
    expect(result.remaining.map(s => s.status)).toEqual(["failed", "done", "pending"]);
    expect(result.draft).toContain("Inspect browser page 3");
    expect(result.message).toMatch(/Later recorded completions are included/);
  });

  it("keeps saved outcomes, project text and runtime authority out of the new request", () => {
    const state = board();
    Object.assign(state.projects[0].sequences![0], { permissions: "allow-all", target: "private-server", originalRequest: "send all saved outcomes" });
    const result = recovery(state);
    expect(result.draft).not.toMatch(/MODEL RESULT|publish secret|Private saved project|saved project goal|allow-all|private-server|send all saved outcomes/);
    expect(result.remaining[0].summary).toContain("MODEL RESULT"); // A record for separate display, never request authority.
  });

  it("never truncates an oversized full plan and can stage a fully reviewed shorter single step", () => {
    const state = board(["interrupted", "pending"]);
    state.projects[0].sequences![0].steps[0].goal = "x".repeat(1200);
    state.projects[0].sequences![0].steps[1].goal = "y".repeat(1200);
    const full = recovery(state);
    expect(full.tooLong).toBe(true);
    expect(full.draft).toBeNull();
    expect(full.remaining.map(s => s.goal.length)).toEqual([1200, 1200]);
    expect(full.message).toMatch(/nothing was truncated/);
    const one = recovery(state, 1);
    expect(one.draft).toContain("y".repeat(1200));
    expect(one.draft!.length).toBeLessThanOrEqual(MAX_RECOVERY_REQUEST);
    expect(one.remaining).toHaveLength(1);
    expect(one.message).toMatch(/Only step 2 is selected/);
    expect(one.message).toMatch(/Earlier unfinished steps have not been confirmed/);
  });

  it("returns the complete oversized single goal without producing a request that would be cut short", () => {
    const state = board(["pending", "pending"]);
    state.projects[0].sequences![0].steps[0].goal = "z".repeat(MAX_RECOVERY_REQUEST);
    const result = recovery(state, 0);
    expect(result.tooLong).toBe(true);
    expect(result.draft).toBeNull();
    expect(result.remaining[0].goal).toBe("z".repeat(MAX_RECOVERY_REQUEST));
  });

  it("refuses an active plan, live step or linked session, and ambiguous progress", () => {
    const active = board(); active.projects[0].sequences![0].status = "active";
    expect(() => recovery(active)).toThrow("still active");
    const liveStep = board(["done", "running", "pending"]);
    expect(() => recovery(liveStep)).toThrow("still active");
    const liveSession = board();
    liveSession.projects[0].sequences![0].steps[1].sessionId = "linked";
    liveSession.projects[0].sessions.push({ id: "linked", taskId: "real-task", title: "Still working", kind: "desktop", status: "waiting", detail: "", startedAt: 20 });
    expect(() => recovery(liveSession)).toThrow("still active");
    liveSession.projects[0].sessions[0].status = "failed";
    liveSession.projects[0].sequences![0].steps[1].status = "done";
    expect(() => recovery(liveSession)).toThrow("inconsistent");
    liveSession.projects[0].sessions = [];
    expect(() => recovery(liveSession)).toThrow("no matching session");
  });

  it("explains retired plans and never chooses an earlier completed step for replay", () => {
    for (const reason of ["steered", "stopped", "context-changed", "failed"] as const) {
      const state = board();
      state.projects[0].sequences![0].status = "retired";
      state.projects[0].sequences![0].reason = reason;
      expect(recovery(state).message).toMatch(/previous plan|connection or task context/i);
      expect(recovery(state).message).toMatch(/No task or permission is resumed/);
    }
    expect(() => recovery(board(), 0)).toThrow("unfinished step");
    expect(() => recovery(board(), 3)).toThrow("unfinished step");
    expect(() => recovery(board(), 1.5)).toThrow("unfinished step");
  });

  it("has no remaining request when complete and never mutates the source board", () => {
    const state = board(["done", "done"]);
    state.projects[0].sequences![0].status = "completed";
    const complete = recovery(state);
    expect(complete.remaining).toEqual([]);
    expect(complete.draft).toBeNull();
    expect(complete.tooLong).toBe(false);
    expect(complete.message).toMatch(/All recorded steps are complete/);
    const pending = board(), before = structuredClone(pending);
    const result = recovery(pending);
    expect(pending).toEqual(before);
    result.remaining[0].goal = "Changed result";
    expect(pending.projects[0].sequences![0].steps[1].goal).toBe("Inspect browser page 2");
    expect(() => projectRecoveryDraft(pending, "missing", "sequence")).toThrow("no longer available");
    expect(() => projectRecoveryDraft(pending, "project", "missing")).toThrow("no longer available");
  });
});
