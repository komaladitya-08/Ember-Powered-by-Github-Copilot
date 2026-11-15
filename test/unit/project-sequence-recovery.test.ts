import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { MAX_PROJECT_SESSIONS, MAX_PROJECT_SEQUENCES, ProjectSessionBook, projectSessionSnapshot } from "../../app/main/agent/project-sessions";
import { projectRecoveryDraft } from "../../app/shared/project-recovery";

const goals = [{ name: "Inspect", goal: "Inspect the browser page" }, { name: "Verify", goal: "Verify the page title" }];
const setup = () => {
  const book = new ProjectSessionBook(() => 100);
  const project = book.apply({ action: "create", name: "Website" }).selectedProjectId!;
  const sequence = book.beginSequence(project, goals);
  const attach = (taskId: string, status = "running") => book.attach(project, { id: taskId, title: taskId, status, started: 10, detail: "Working" }, "desktop");
  return { book, project, sequence, attach };
};

it("keeps the full ordered plan before work and completes only after the final observed success", () => {
  const { book, project, sequence, attach } = setup();
  expect(book.state().projects[0].sequences![0]).toMatchObject({ id: sequence, status: "active", steps: goals.map(goal => ({ ...goal, status: "pending" })) });
  attach("first"); book.linkSequenceStep(project, sequence, 0, "first");
  expect(() => book.linkSequenceStep(project, sequence, 1, "first")).toThrow();
  book.refresh([{ id: "first", status: "done", summary: "Page opened." }]);
  attach("second"); book.linkSequenceStep(project, sequence, 1, "second");
  const working = book.state().projects[0].sequences![0];
  expect(working.status).toBe("active");
  expect(working.steps.map(step => step.status)).toEqual(["done", "running"]);
  expect(working.steps[0]).toMatchObject({ summary: "Page opened.", startedAt: 10, finishedAt: 100 });
  book.refresh([{ id: "second", status: "done", summary: "Title checked." }]);
  expect(book.state().projects[0].sequences![0]).toMatchObject({ status: "completed", steps: [{ status: "done" }, { status: "done", summary: "Title checked." }] });
});

it("preserves goal and observed outcome independently when a session leaves the bounded history", () => {
  const { book, project, sequence, attach } = setup();
  attach("first"); book.linkSequenceStep(project, sequence, 0, "first");
  book.refresh([{ id: "first", status: "done", summary: "Observed first outcome." }]);
  for (let i = 0; i <= MAX_PROJECT_SESSIONS; i++) attach(`later-${i}`, "done");
  const state = book.state(), plan = state.projects[0].sequences![0];
  expect(state.projects[0].sessions.some(session => session.taskId === "first")).toBe(false);
  expect(plan.steps[0]).toMatchObject({ name: "Inspect", goal: goals[0].goal, status: "done", summary: "Observed first outcome." });
  expect(plan.steps[0].sessionId).toBeUndefined();
  expect(plan.steps[1]).toMatchObject({ goal: goals[1].goal, status: "pending" });
  expect(projectSessionSnapshot.safeParse(state).success).toBe(true);
});

it("records retirement and never treats a steered worker's success as proof of its original goal", () => {
  const { book, project, sequence, attach } = setup();
  attach("first"); book.linkSequenceStep(project, sequence, 0, "first");
  book.retireSequence(project, sequence, "steered");
  book.retireSequence(project, sequence, "context-changed");
  book.refresh([{ id: "first", status: "done", summary: "Completed a changed goal." }]);
  const plan = book.state().projects[0].sequences![0];
  expect(plan).toMatchObject({ status: "retired", reason: "steered" });
  expect(plan.steps[0]).toMatchObject({ status: "interrupted", summary: "Completed a changed goal.", goal: goals[0].goal });
  expect(plan.steps[1].status).toBe("pending");
  expect(() => book.linkSequenceStep(project, sequence, 1, "first")).toThrow("no longer active");
});

it.each([null, "context-changed", "stopped", "failed", "interrupted"] as const)("keeps a changed original goal uncertain after steering an %s plan", reason => {
  const { book, project, sequence, attach } = setup();
  attach("first"); book.linkSequenceStep(project, sequence, 0, "first");
  book.refresh([{ id: "first", status: "done", summary: "Original first goal completed." }]);
  attach("second"); book.linkSequenceStep(project, sequence, 1, "second");
  if (reason) book.retireSequence(project, sequence, reason);
  book.steerTask("second");
  // Later cleanup/context updates must not erase that the running worker's original goal changed.
  book.retireSequence(project, sequence, "context-changed");
  book.retireSequence(project, sequence, "stopped");
  book.refresh([{ id: "second", status: "done", summary: "A different page was inspected." }]);
  const state = book.state(), plan = state.projects[0].sequences![0];
  expect(plan).toMatchObject({ status: "retired", reason: "steered" });
  expect(plan.steps.map(step => step.status)).toEqual(["done", "interrupted"]);
  expect(plan.steps[1].goal).toBe(goals[1].goal);
  const recovery = projectRecoveryDraft(state, project, sequence);
  expect(recovery.completed).toBe(1);
  expect(recovery.remaining.map(step => step.goal)).toEqual([goals[1].goal]);
  expect(recovery.message).toContain("previous plan was changed");
  expect(projectSessionSnapshot.safeParse(state).success).toBe(true);
});

it("never changes a completed plan when steering another task or retiring old metadata", () => {
  const { book, project, sequence, attach } = setup();
  attach("first"); book.linkSequenceStep(project, sequence, 0, "first");
  book.refresh([{ id: "first", status: "done", summary: "First goal completed." }]);
  attach("second"); book.linkSequenceStep(project, sequence, 1, "second");
  book.refresh([{ id: "second", status: "done", summary: "Second goal completed." }]);
  const completed = book.state().projects[0].sequences![0];
  attach("unrelated");
  book.steerTask("unrelated"); book.steerTask("second");
  book.retireSequence(project, sequence, "steered");
  expect(book.state().projects[0].sequences![0]).toEqual(completed);
});

it("bounds retained plans, refuses active-plan replacement and rejects executable or cross-project checkpoint fields", () => {
  const { book, project, sequence } = setup();
  for (let i = 1; i < MAX_PROJECT_SEQUENCES; i++) book.beginSequence(project, goals);
  expect(() => book.beginSequence(project, goals)).toThrow("Finish or stop");
  expect(() => book.apply({ action: "forget", id: project })).toThrow("Stop or finish");
  expect(() => book.restore({ projects: [], selectedProjectId: null })).toThrow("Stop or finish");
  book.retireSequence(project, sequence, "failed");
  expect(() => book.beginSequence(project, goals)).not.toThrow();
  expect(book.state().projects[0].sequences).toHaveLength(MAX_PROJECT_SEQUENCES);
  const state = book.state();
  state.projects[0].sequences![0].steps[0].sessionId = randomUUID();
  expect(projectSessionSnapshot.safeParse(state).success).toBe(false);
  const invalid = { ...goals[0], permissions: { approved: true } };
  expect(() => book.beginSequence(project, [invalid, goals[1]])).toThrow("2–8");
});
