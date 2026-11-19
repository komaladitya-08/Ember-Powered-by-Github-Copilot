/** Renderer-only navigation between a named coding session and its exact retained review. */
import type { CodingResultSummary } from "../../shared/project-coding";
import type { ProjectSession } from "../../shared/project-sessions";

/** Local navigation identity only; it grants no read, export or continuation authority. */
export interface CodingSessionReviewIdentity {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly sourcePath: string;
}

export function codingSessionReview(projectId: string, session: Pick<ProjectSession, "kind" | "taskId" | "status">,
  summaries: readonly CodingResultSummary[]): Readonly<CodingSessionReviewIdentity> | null {
  if (session.kind !== "coding" || !session.taskId || !["done", "failed", "stopped"].includes(session.status)) return null;
  const matches = summaries.filter(result => result.projectId === projectId && result.taskId === session.taskId);
  if (matches.length !== 1 || !matches[0].id || !matches[0].sourcePath) return null;
  const { id, taskId, sourcePath } = matches[0];
  return Object.freeze({ id, projectId, taskId, sourcePath });
}

export function sameCodingSessionReview(identity: CodingSessionReviewIdentity,
  result: Pick<CodingResultSummary, "id" | "projectId" | "taskId" | "sourcePath">): boolean {
  return identity.id === result.id && identity.projectId === result.projectId && identity.taskId === result.taskId && identity.sourcePath === result.sourcePath;
}

export interface ProjectSessionReviews {
  forSession(projectId: string, session: ProjectSession): { key: string; disabled: boolean; open(origin: HTMLButtonElement, resolveOrigin: () => HTMLButtonElement | null): void } | null;
  onChange(listener: () => void): void;
}
