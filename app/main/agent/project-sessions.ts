/** A bounded project board, in memory only. TaskManager alone owns execution and authority. */
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { TaskEntry } from "../../shared/activity";
type ObservedTask = Pick<TaskEntry, "id" | "status" | "summary"> & { title?: string; detail?: string; activity?: TaskEntry["activity"] };
import type { ProjectSessionKind, ProjectSessionProject, ProjectSessionsState } from "../../shared/project-sessions";

const label = z.string().trim().min(1).max(80).refine(v => !/[\p{Cc}\p{Cf}]/u.test(v));
export const projectSessionsAction = z.discriminatedUnion("action", [
  z.object({ action: z.literal("create"), name: label, goal: z.string().trim().max(4000).optional() }).strict(),
  z.object({ action: z.literal("select"), id: z.string().uuid().nullable() }).strict(),
  z.object({ action: z.literal("forget"), id: z.string().uuid() }).strict(),
]);
const live = (s: string) => s === "running" || s === "waiting" || s === "queued";
export const MAX_PROJECTS = 8;
export const MAX_PROJECT_SESSIONS = 80;
const instant = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
/** Shared strict format for explicit encrypted checkpoints; a saved task ID is never authority. */
export const projectSessionSnapshot = z.object({
  projects: z.array(z.object({
    id: z.string().uuid(), name: label, goal: z.string().max(4000), createdAt: instant,
    sessions: z.array(z.object({
      id: z.string().uuid(), taskId: z.string().max(2000), title: z.string().min(1).max(2000),
      kind: z.enum(["desktop", "coding"]), status: z.enum(["queued", "running", "waiting", "done", "failed", "stopped"]),
      detail: z.string().max(4000), summary: z.string().max(24_080).optional(), startedAt: instant, finishedAt: instant.optional(),
    }).strict()).max(MAX_PROJECT_SESSIONS),
  }).strict()).max(MAX_PROJECTS),
  selectedProjectId: z.string().uuid().nullable(),
}).strict().refine(state => {
  const projectIds = state.projects.map(p => p.id), sessionIds = state.projects.flatMap(p => p.sessions.map(s => s.id));
  return new Set(projectIds).size === projectIds.length && new Set(sessionIds).size === sessionIds.length
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
      if (p.sessions.some(s => live(s.status))) throw new Error("Stop or finish this project's sessions before closing it.");
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

  /** Metadata only: task IDs never grant authority, create SDK sessions or change the task's user words. */
  attach(projectId: string | null, task: { id: string; title: string; status: string; started: number; detail: string }, kind: ProjectSessionKind, title?: string): void {
    if (projectId === null) return;
    const p = this.project(projectId);
    if (p.sessions.some(s => s.taskId === task.id)) return;
    while (p.sessions.length >= MAX_PROJECT_SESSIONS) {
      const old = p.sessions.findIndex(s => !live(s.status));
      if (old < 0) throw new Error("This project has too many sessions in progress.");
      p.sessions.splice(old, 1);
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
  }

  /** Open a checkpoint as inert history. Existing live sessions must stay visible with their Stop controls. */
  restore(raw: ProjectSessionsState, expected?: ProjectSessionsState): ProjectSessionsState {
    if (expected && JSON.stringify(this.state()) !== JSON.stringify(expected)) {
      throw new Error("Projects changed while opening the checkpoint. Your current projects were kept; try again.");
    }
    if (this.projects.some(p => p.sessions.some(s => live(s.status)))) throw new Error("Stop or finish the current sessions before opening a saved project board.");
    const parsed = projectSessionSnapshot.safeParse(raw);
    if (!parsed.success || parsed.data.projects.some(p => p.sessions.some(s => live(s.status) || s.taskId !== ""))) {
      throw new Error("The saved project board is invalid or still contains live task references.");
    }
    const state = structuredClone(parsed.data);
    this.projects = state.projects;
    this.selectedProjectId = state.selectedProjectId;
    return this.state();
  }

  clear(): void { this.projects = []; this.selectedProjectId = null; }
}
