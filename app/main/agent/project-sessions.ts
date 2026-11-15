/** A bounded project board, in memory only. TaskManager alone owns execution and authority. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { TaskEntry } from "../../shared/activity";
type ObservedTask = Pick<TaskEntry, "id" | "status" | "summary"> & { title?: string; detail?: string; activity?: TaskEntry["activity"] };
import type { ProjectSession, ProjectSessionKind, ProjectSessionProject, ProjectSessionsState, ProjectSequence, ProjectSequenceReason, ProjectSequenceStep } from "../../shared/project-sessions";

const label = z.string().trim().min(1).max(80).refine(v => !/[\p{Cc}\p{Cf}]/u.test(v));
export const projectSessionsAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), name: label, goal: z.string().trim().max(4000).optional() }).strict(),
  z.object({ action: z.literal("select"), id: z.string().uuid().nullable() }).strict(),
  z.object({ action: z.literal("forget"), id: z.string().uuid() }).strict(),
]);
const live = (s: string) => s === "running" || s === "waiting" || s === "queued";
export const MAX_PROJECTS = 8;
export const MAX_PROJECT_SESSIONS = 80;
export const MAX_PROJECT_SEQUENCES = 8;
const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const sequenceGoal = z.object({ name: label, goal: z.string().min(3).max(4000) }).strict();
export const projectSequenceSnapshot = z.object({
  id: z.string().uuid(), createdAt: instant,
  status: z.enum(["active", "completed", "interrupted", "retired"]),
  reason: z.enum(["stopped", "steered", "context-changed", "failed", "interrupted"]).optional(),
  steps: z.array(sequenceGoal.extend({
    status: z.enum(["pending", "interrupted", "queued", "running", "waiting", "done", "failed", "stopped"]),
    sessionId: z.string().uuid().optional(), summary: z.string().max(24_080).optional(),
    startedAt: instant.optional(), finishedAt: instant.optional(),
  }).strict()).min(2).max(8),
}).strict().refine(plan => plan.status !== "completed" || plan.steps.every(step => step.status === "done"), "A completed plan needs observed success for every step");

/** Shared strict format for explicit encrypted checkpoints; a saved task ID is never authority. */
export const projectSessionSnapshot = z.object({
  projects: z.array(z.object({
    id: z.string().uuid(), name: label, goal: z.string().max(4000), createdAt: instant,
    sessions: z.array(z.object({
      id: z.string().uuid(), taskId: z.string().max(2000), title: z.string().min(1).max(2000),
      kind: z.enum(["desktop", "coding"]), status: z.enum(["queued", "running", "waiting", "done", "failed", "stopped"]),
      detail: z.string().max(4000), summary: z.string().max(24_080).optional(), startedAt: instant, finishedAt: instant.optional(),
    }).strict()).max(MAX_PROJECT_SESSIONS),
    sequences: z.array(projectSequenceSnapshot).max(MAX_PROJECT_SEQUENCES).optional(),
  }).strict()).max(MAX_PROJECTS),
  selectedProjectId: z.string().uuid().nullable(),
}).strict().refine(state => {
  const projectIds = state.projects.map(p => p.id), sessionIds = state.projects.flatMap(p => p.sessions.map(s => s.id));
  const sequenceIds = state.projects.flatMap(p => (p.sequences ?? []).map(plan => plan.id));
  return new Set(projectIds).size === projectIds.length && new Set(sessionIds).size === sessionIds.length
    && new Set(sequenceIds).size === sequenceIds.length
    && state.projects.every(p => (p.sequences ?? []).every(plan => {
      const linked = plan.steps.flatMap(step => step.sessionId ? [step.sessionId] : []);
      return new Set(linked).size === linked.length && linked.every(id => p.sessions.some(session => session.id === id));
    }))
    && (state.selectedProjectId === null || projectIds.includes(state.selectedProjectId));
}, "Invalid project or session identities");


export class ProjectSessionBook {
  private projects: ProjectSessionProject[] = [];
  private selectedProjectId: string | null = null;
  constructor(private readonly now: () => number = Date.now) {}

  state(): ProjectSessionsState {
    return structuredClone({ projects: this.projects, selectedProjectId: this.selectedProjectId });
  }

  apply(raw: unknown): ProjectSessionsState {
    const result = projectSessionsAction.safeParse(raw);
    if (!result.success) throw new Error("Check the project name and try again.");
    const action = result.data;
    if (action.action === "create") {
      if (this.projects.length >= MAX_PROJECTS) throw new Error("Keep up to eight projects in this run. Close a finished project before creating another.");
      if (this.projects.some(p => p.name.toLowerCase() === action.name.toLowerCase())) throw new Error("A project with that name already exists. Select it or choose another name.");
      const project = { id: randomUUID(), name: action.name, goal: action.goal ?? "", createdAt: this.now(), sessions: [] };
      this.projects.push(project);
      this.selectedProjectId = project.id;
    } else if (action.action === "select") {
      if (action.id !== null && !this.projects.some(p => p.id === action.id)) throw new Error("That project is no longer available.");
      this.selectedProjectId = action.id;
    } else {
      const p = this.project(action.id);
      if (p.sessions.some(s => live(s.status)) || p.sequences?.some(plan => plan.status === "active" || plan.steps.some(step => live(step.status)))) throw new Error("Stop or finish this project's sessions before closing it.");
      this.projects = this.projects.filter(p => p.id !== action.id);
      if (this.selectedProjectId === action.id) this.selectedProjectId = null;
    }
    return this.state();
  }

  private project(id: string): ProjectSessionProject {
    const project = this.projects.find(p => p.id === id);
    if (!project) throw new Error("That project is no longer available.");
    return project;
  }

  /** Validate the destination before asking TaskManager to start anything. */
  destination(id?: string | null): string | null {
    const selected = id === undefined ? this.selectedProjectId : id;
    if (selected === null) return null;
    const p = this.project(selected);
    if (p.sessions.filter(s => live(s.status)).length >= MAX_PROJECT_SESSIONS) throw new Error("This project has too many sessions in progress. Finish or stop one first.");
    return p.id;
  }

  /** Keep the bounded ordered goals before starting a worker; this is metadata, never saved authority. */
  beginSequence(projectId: string, steps: readonly { name: string; goal: string }[]): string {
    const parsed = z.array(sequenceGoal).min(2).max(8).safeParse(steps);
    if (!parsed.success) throw new Error("A sequence needs 2–8 named desktop goals.");
    const p = this.project(projectId);
    const plans = p.sequences ??= [];
    if (plans.length >= MAX_PROJECT_SEQUENCES) {
      const old = plans.findIndex(plan => plan.status !== "active" && !plan.steps.some(step => live(step.status)));
      if (old < 0) throw new Error("Finish or stop an existing sequence before starting another.");
      plans.splice(old, 1);
    }
    const plan: ProjectSequence = { id: randomUUID(), createdAt: this.now(), status: "active", steps: parsed.data.map(step => ({ ...step, status: "pending" })) };
    plans.push(plan);
    return plan.id;
  }

  linkSequenceStep(projectId: string, sequenceId: string, index: number, taskId: string): void {
    const p = this.project(projectId), plan = p.sequences?.find(plan => plan.id === sequenceId);
    if (!plan || plan.status !== "active" || !Number.isInteger(index) || index < 0 || index >= plan.steps.length) throw new Error("The sequence is no longer active.");
    const session = p.sessions.find(session => session.taskId === taskId && session.kind === "desktop");
    if (!taskId || !session || plan.steps.some((step, i) => i !== index && step.sessionId === session.id)) throw new Error("The sequence session is unavailable.");
    if (index > 0 && plan.steps.slice(0, index).some(step => step.status !== "done")) throw new Error("The preceding sequence steps have not succeeded.");
    const step = plan.steps[index];
    if (step.sessionId !== undefined && step.sessionId !== session.id) throw new Error("The sequence step already has a session.");
    step.sessionId = session.id;
    this.copyOutcome(step, session);
    this.setSequenceOutcome(plan);
  }

  retireSequence(projectId: string, sequenceId: string, reason: ProjectSequenceReason): void {
    const plan = this.project(projectId).sequences?.find(plan => plan.id === sequenceId);
    if (!plan || plan.status === "completed") return;
    if (plan.status === "retired") {
      // Retiring a tail does not necessarily stop its current worker. A subsequent change to that worker's goal
      // must survive earlier retirement and later cleanup updates, or its success could falsely complete the old goal.
      if (reason === "steered") plan.reason = "steered";
      return;
    }
    plan.status = "retired";
    plan.reason = reason;
  }

  /** The final step has no continuation listener, but steering still supersedes its recorded original goal. */
  steerTask(taskId: string): void {
    for (const project of this.projects) {
      const session = project.sessions.find(session => session.taskId === taskId && live(session.status));
      if (!session) continue;
      for (const plan of project.sequences ?? []) {
        if (plan.status !== "completed" && plan.steps.some(step => step.sessionId === session.id)) {
          this.retireSequence(project.id, plan.id, "steered");
        }
      }
    }
  }

  private copyOutcome(step: ProjectSequenceStep, session: ProjectSession, steered = false): void {
    // A steered worker's success does not establish that its original saved goal was completed.
    const changedGoal = steered && step.status !== "done";
    step.status = changedGoal && session.status === "done" ? "interrupted" : session.status;
    step.startedAt = session.startedAt;
    if (session.summary !== undefined) step.summary = session.summary;
    if (session.finishedAt !== undefined) step.finishedAt = session.finishedAt;
  }

  private setSequenceOutcome(plan: ProjectSequence): void {
    if (plan.status !== "active") return;
    if (plan.steps.every(step => step.status === "done")) { plan.status = "completed"; delete plan.reason; }
    else if (plan.steps.some(step => step.status === "failed" || step.status === "stopped")) {
      plan.status = "retired";
      plan.reason = plan.steps.some(step => step.status === "failed") ? "failed" : "stopped";
    }
  }

  /** Metadata only: task IDs never grant authority, create SDK sessions or change the task's user words. */
  attach(projectId: string | null, task: { id: string; title: string; status: string; started: number; detail: string }, kind: ProjectSessionKind, title?: string): void {
    if (projectId === null) return;
    const p = this.project(projectId);
    if (p.sessions.some(s => s.taskId === task.id)) return;
    while (p.sessions.length >= MAX_PROJECT_SESSIONS) {
      const old = p.sessions.findIndex(s => !live(s.status));
      if (old < 0) throw new Error("This project has too many sessions in progress.");
      const [removed] = p.sessions.splice(old, 1);
      // Plan outcomes survive the short session history; an evicted row is no longer a live UI reference.
      for (const plan of p.sequences ?? []) for (const step of plan.steps) if (step.sessionId === removed.id) {
        this.copyOutcome(step, removed, plan.reason === "steered");
        delete step.sessionId;
      }
    }
    const parsed = title === undefined ? null : label.safeParse(title);
    p.sessions.push({
      id: randomUUID(), taskId: task.id, title: parsed && parsed.success ? parsed.data : task.title,
      kind, status: task.status === "cancelled" ? "stopped" : task.status as "queued" | "running" | "done" | "failed",
      detail: task.detail, startedAt: task.started,
    });
  }

  /** Keep terminal outcomes even after TaskManager removes cards and evicts its short recent-history list. */
  refresh(tasks: readonly ObservedTask[]): void {
    const byId = new Map(tasks.map(t => [t.id, t]));
    for (const p of this.projects) for (const s of p.sessions) {
      const task = byId.get(s.taskId);
      if (!task) continue;
      s.status = task.status;
      s.detail = task.detail ?? task.activity?.live ?? "";
      if (task.summary !== undefined) s.summary = task.summary;
      if (!live(s.status) && s.finishedAt === undefined) s.finishedAt = this.now();
    }
    for (const p of this.projects) for (const plan of p.sequences ?? []) {
      for (const step of plan.steps) {
        const session = step.sessionId ? p.sessions.find(session => session.id === step.sessionId) : undefined;
        if (session) this.copyOutcome(step, session, plan.reason === "steered");
      }
      this.setSequenceOutcome(plan);
    }
  }

  /** Open a checkpoint as inert history. Existing live sessions must stay visible with their Stop controls. */
  restore(raw: ProjectSessionsState, expected?: ProjectSessionsState): ProjectSessionsState {
    if (expected && JSON.stringify(this.state()) !== JSON.stringify(expected)) {
      throw new Error("Projects changed while opening the checkpoint. Your current projects were kept; try again.");
    }
    if (this.projects.some(p => p.sessions.some(s => live(s.status)) || p.sequences?.some(plan => plan.status === "active" || plan.steps.some(step => live(step.status))))) throw new Error("Stop or finish the current sessions before opening a saved project board.");
    const parsed = projectSessionSnapshot.safeParse(raw);
    if (!parsed.success || parsed.data.projects.some(p => p.sessions.some(s => live(s.status) || s.taskId !== "") || p.sequences?.some(plan => plan.status === "active" || plan.steps.some(step => live(step.status))))) {
      throw new Error("The saved project board is invalid or still contains live task references.");
    }
    const state = structuredClone(parsed.data);
    this.projects = state.projects;
    this.selectedProjectId = state.selectedProjectId;
    return this.state();
  }

  clear(): void { this.projects = []; this.selectedProjectId = null; }
}
