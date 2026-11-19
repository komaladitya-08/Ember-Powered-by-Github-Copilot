/** Projects group delegated tasks for this run. They are neither folders nor restored model sessions. */
export type ProjectSessionKind = "desktop" | "coding";
export type ProjectSessionStatus = "queued" | "running" | "waiting" | "done" | "failed" | "stopped";
export interface ProjectSession {
  id: string;
  taskId: string;
  title: string;
  kind: ProjectSessionKind;
  status: ProjectSessionStatus;
  detail: string;
  summary?: string;
  startedAt: number;
  finishedAt?: number;
}
export type ProjectSequenceReason = "stopped" | "steered" | "context-changed" | "failed" | "interrupted";
export interface ProjectSequenceStep {
  name: string;
  goal: string;
  status: "pending" | "interrupted" | ProjectSessionStatus;
  sessionId?: string;
  summary?: string;
  startedAt?: number;
  finishedAt?: number;
}
export interface ProjectSequence {
  id: string;
  createdAt: number;
  status: "active" | "completed" | "interrupted" | "retired";
  reason?: ProjectSequenceReason;
  steps: ProjectSequenceStep[];
}
export interface ProjectSessionProject {
  id: string;
  name: string;
  goal: string;
  createdAt: number;
  sessions: ProjectSession[];
  sequences?: ProjectSequence[];
}
export interface ProjectSessionsState {
  projects: ProjectSessionProject[];
  selectedProjectId: string | null;
}
export type ProjectSessionsAction =
  | { action: "create"; name: string; goal?: string }
  | { action: "select"; id: string | null }
  | { action: "forget"; id: string };
