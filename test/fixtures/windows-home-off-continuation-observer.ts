/** Failure-only closed observations for the existing files-only Home fixture. No task or approval authority. */
export const WINDOWS_HOME_OFF_SUMMARY_PHRASES: readonly string[] = Object.freeze([
  "The coding task could not be completed safely.",
  "The coding context changed, so I stopped this task.",
  "Stopped.",
  "A command was refused, stopped or could not be fully observed. The coding task stopped.",
  "The coding session could not be verified as closed. Further coding work is blocked.",
  "The coding task ended, but its review could not be published. The original folder is unchanged.",
  "The coding result could not be prepared for review. The original folder is unchanged.",
  "This coding task has already run.",
  "The coding worker did not report an explicit completed result.",
  "The coding workspace could not be verified as quiescent.",
  "The coding model could not finish the task.",
]);
const statuses = ["queued", "running", "waiting", "done", "failed", "stopped"];
const values = [41, 42, 43, 44];
const count = (value: unknown, maximum: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? Math.min(value, maximum) : 0;
const category = (value: unknown, maximum: number) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : 0;
export interface WindowsHomeOffRowObservation { readonly status: number; readonly summaryCategory: number }

/** Preserve the exact original poll value even if the best-effort observer fails. Unknown text is never cached. */
export function observeWindowsHomeOffStatus<T>(status: T, summaryCategory: unknown, record: (value: WindowsHomeOffRowObservation) => void): T {
  try {
    record(Object.freeze({ status: typeof status === "string" ? statuses.indexOf(status) + 1 : 0,
      summaryCategory: category(summaryCategory, WINDOWS_HOME_OFF_SUMMARY_PHRASES.length) }));
  } catch { /* Observations must not change the original predicate or its failure. */ }
  return status;
}

export interface WindowsHomeOffFailureState {
  index: unknown; status: unknown; summaryCategory: unknown; actions: unknown; dispatched: unknown;
  steps: readonly unknown[]; firstReads: readonly unknown[];
}

/** Fixed 20-integer tuple: index/status/summary/actions/dispatched, three step counts, twelve public-value flags. */
export function windowsHomeOffFailureTuple(state: WindowsHomeOffFailureState): readonly number[] {
  const tuple = [category(state.index, 2), category(state.status, 6), category(state.summaryCategory, WINDOWS_HOME_OFF_SUMMARY_PHRASES.length),
    count(state.actions, 9), count(state.dispatched, 3)];
  for (let index = 0; index < 3; index++) tuple.push(count(state.steps[index], 3));
  for (let index = 0; index < 3; index++) for (const value of values) {
    const text = state.firstReads[index];
    tuple.push(typeof text === "string" && text.includes(`export const answer = ${value};`) ? 1 : 0);
  }
  return Object.freeze(tuple);
}

/** Neither the original error nor arbitrary strings/IDs/paths are inspected or printed. Rethrow the same value. */
export function observeWindowsHomeOffFailure(error: unknown, snapshot: () => WindowsHomeOffFailureState, emit: (line: string) => void): never {
  try { emit("Windows files-only continuation checkpoint " + JSON.stringify(windowsHomeOffFailureTuple(snapshot()))); }
  catch { /* An observer/getter/logger failure cannot replace the original poll failure. */ }
  throw error;
}
