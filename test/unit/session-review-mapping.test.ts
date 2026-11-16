import { describe, expect, it } from "vitest";
import type { CodingResultSummary } from "../../app/shared/project-coding";
import type { ProjectSession } from "../../app/shared/project-sessions";
import { codingSessionReview, sameCodingSessionReview } from "../../app/renderer/home/session-reviews";

const session = (changes: Partial<ProjectSession> = {}): ProjectSession => ({
  id: "session-one", taskId: "task-one", title: "Named coding session", kind: "coding", status: "done", detail: "", startedAt: 1, ...changes,
});
const result = (changes: Partial<CodingResultSummary> = {}): CodingResultSummary => ({
  id: "result-one", projectId: "project-one", taskId: "task-one", title: "Worker result title", sourcePath: "/work/original-app", status: "done",
  files: 1, conflicts: 0, patchComplete: true, checks: { ran: 0, passed: 0, failed: 0 }, message: "Review the proposed changes.", ...changes,
});

describe("Named coding sessions and their exact review identity", () => {
  it.each(["done", "failed", "stopped"] as const)("maps a %s coding session to its retained result", status => {
    expect(codingSessionReview("project-one", session({ status }), [result()])).toEqual({
      id: "result-one", projectId: "project-one", taskId: "task-one", sourcePath: "/work/original-app",
    });
  });

  it.each(["queued", "running", "waiting"] as const)("does not offer a result while the session is %s", status => {
    expect(codingSessionReview("project-one", session({ status }), [result()])).toBeNull();
  });

  it("does not attach coding results to a desktop session or an inert restored session", () => {
    expect(codingSessionReview("project-one", session({ kind: "desktop" }), [result()])).toBeNull();
    expect(codingSessionReview("project-one", session({ taskId: "" }), [result({ taskId: "" })])).toBeNull();
  });

  it("matches the project and task together rather than a result title or list order", () => {
    const misleading = [result({ id: "other-project", projectId: "project-two", title: "Named coding session" }), result({ id: "other-task", taskId: "task-two", title: "Named coding session" })];
    expect(codingSessionReview("project-one", session(), misleading)).toBeNull();
    expect(codingSessionReview("project-one", session(), [...misleading, result()])?.id).toBe("result-one");
    expect(codingSessionReview("project-two", session(), [result()])).toBeNull();
  });

  it("keeps the source recorded by the result instead of guessing from a later folder choice", () => {
    const historical = result({ sourcePath: "C:\\old-project\\App" });
    const identity = codingSessionReview("project-one", session(), [historical]);
    expect(identity?.sourcePath).toBe("C:\\old-project\\App");
    expect(identity && sameCodingSessionReview(identity, historical)).toBe(true);
    expect(identity && sameCodingSessionReview(identity, { ...historical, sourcePath: "C:\\new-project\\App" })).toBe(false);
  });

  it("does not choose between two results for the same task, including duplicate rows", () => {
    expect(codingSessionReview("project-one", session(), [result(), result({ id: "later-result" })])).toBeNull();
    expect(codingSessionReview("project-one", session(), [result(), result()])).toBeNull();
  });

  it.each([{ id: "" }, { sourcePath: "" }])("does not expose an incomplete result identity %j", changes => {
    expect(codingSessionReview("project-one", session(), [result(changes)])).toBeNull();
  });

  it("returns no mapping after the result is removed or replaced by another task", () => {
    expect(codingSessionReview("project-one", session(), [])).toBeNull();
    expect(codingSessionReview("project-one", session(), [result({ taskId: "task-two" })])).toBeNull();
  });

  it("returns a detached frozen identity without copying private review content", () => {
    const summary = result();
    const identity = codingSessionReview("project-one", session(), [summary]);
    expect(identity).not.toBeNull();
    expect(Object.keys(identity!).sort()).toEqual(["id", "projectId", "sourcePath", "taskId"]);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Reflect.set(identity!, "id", "other-result")).toBe(false);
    summary.id = "new-result"; summary.sourcePath = "/work/replacement"; summary.title = "Changed title";
    expect(identity).toEqual({ id: "result-one", projectId: "project-one", taskId: "task-one", sourcePath: "/work/original-app" });
    expect(sameCodingSessionReview(identity!, summary)).toBe(false);
  });

  it.each([
    { id: "later-result" }, { projectId: "project-two" }, { taskId: "task-two" }, { sourcePath: "/work/another-app" },
    { sourcePath: "/WORK/original-app" }, { sourcePath: "/work/original-app/" },
  ])("rejects a changed review identity %j", changes => {
    const identity = codingSessionReview("project-one", session(), [result()])!;
    expect(sameCodingSessionReview(identity, result(changes))).toBe(false);
  });

  it("allows display and outcome details to refresh without substituting the review identity", () => {
    const identity = codingSessionReview("project-one", session(), [result()])!;
    expect(sameCodingSessionReview(identity, result({ title: "Fresh result title", message: "Refreshed detail", files: 2, status: "stopped" }))).toBe(true);
  });
});
