/** Recovery drafts are plain editable text. Reading a checkpoint never authorises work. */
import type { ProjectSequence, ProjectSessionsState } from "./project-sessions";

export const MAX_RECOVERY_REQUEST = 2000;
export interface ProjectRecoveryDraft {
  projectId: string;
  sequenceId: string;
  completed: number;
  remaining: ProjectSequence["steps"];
  draft: string | null;
  tooLong: boolean;
  message: string;
}

const live = (status: string) => status === "running" || status === "waiting" || status === "queued";

/**
 * Prepares a new request for the person to review and send. Saved outcomes, targets and approvals never become the
 * person's words. A chosen step index is its original index in the plan; choosing it does not complete earlier work.
 */
export function projectRecoveryDraft(state: ProjectSessionsState, projectId: string, sequenceId: string, stepIndex?: number): ProjectRecoveryDraft {
  const project = state.projects.find(p => p.id === projectId);
  const sequence = project?.sequences?.find(s => s.id === sequenceId);
  if (!project || !sequence) throw new Error("That saved plan is no longer available. Open its project again.");
  if (sequence.status === "active") throw new Error("This plan is still active. Stop or finish it before preparing a new request.");
  const sessions = new Map(project.sessions.map(s => [s.id, s]));
  for (const step of sequence.steps) {
    const session = step.sessionId ? sessions.get(step.sessionId) : undefined;
    if (step.sessionId && !session) throw new Error("A saved step has no matching session record. Open the checkpoint again or write a new request.");
    if (live(step.status) || (session && live(session.status))) throw new Error("A session in this plan is still active. Stop or finish it before preparing a new request.");
    if (step.status === "done" && session && session.status !== "done") throw new Error("The saved progress is inconsistent. Review the project and write a new request.");
  }

  let completed = 0;
  while (completed < sequence.steps.length && sequence.steps[completed].status === "done") completed++;
  if (stepIndex !== undefined && (!Number.isInteger(stepIndex) || stepIndex < completed || stepIndex >= sequence.steps.length)) {
    throw new Error("Choose an unfinished step from this plan.");
  }
  const selected = stepIndex === undefined ? sequence.steps.slice(completed) : [sequence.steps[stepIndex]];
  const remaining = structuredClone(selected);
  let message = "Review the full goals, edit them if needed, then send a new request. No task or permission is resumed.";
  if (sequence.reason === "steered") message = "The previous plan was changed. These saved goals may be out of date; review and edit them before sending a new request. No task or permission is resumed.";
  else if (sequence.reason === "stopped") message = "The previous plan was stopped. Review these goals before choosing to request them again. No task or permission is resumed.";
  else if (sequence.reason === "context-changed") message = "The previous plan's connection or task context changed. Review the goals for the current apps and connection before sending a new request. No task or permission is resumed.";
  else if (sequence.reason === "failed") message = "The previous plan did not finish. Review the remaining goals and app state before sending a new request. No task or permission is resumed.";
  if (stepIndex !== undefined) {
    message += ` Only step ${stepIndex + 1} is selected.`;
    if (stepIndex > completed) message += " Earlier unfinished steps have not been confirmed and are not included.";
  }
  if (!remaining.length) return { projectId, sequenceId, completed, remaining, draft: null, tooLong: false, message: "All recorded steps are complete. Start a new request if you want to do more." };
  if (remaining.some(s => s.status === "done")) {
    message += " Later recorded completions are included after an earlier unfinished step. Review their effects before requesting them again.";
  }
  if (sequence.status === "interrupted" || remaining.some(s => s.status !== "pending" && s.status !== "done")) {
    message += " An unfinished step may have partly completed. Check the current app state before repeating it.";
  }
  const heading = "First inspect the current app state before repeating any action. Then carry out these desktop steps as a new request:";
  const draft = `${heading}\n${remaining.map((step, index) => `${index + 1}. ${step.name}\n${step.goal}`).join("\n\n")}`;
  const tooLong = draft.length > MAX_RECOVERY_REQUEST;
  if (tooLong) message += " These goals do not fit in one request. Review the full steps below and choose a shorter step or write a shorter request; nothing was truncated.";
  return { projectId, sequenceId, completed, remaining, draft: tooLong ? null : draft, tooLong, message };
}
