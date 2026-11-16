/** A bounded read-only join. Card completion alone is never a cleanup or dependent-success witness. */
export type TaskWaitStatus = "queued" | "running" | "done" | "failed" | "cancelled" | "missing";
export interface TaskWaitObservation {
  id: string;
  status: TaskWaitStatus;
  cleanup: "pending" | "complete" | "unknown";
  handoffSafe: boolean;
  summary: string;
}
export interface TaskWaitResult {
  reason: "settled" | "timeout" | "cancelled";
  dependentSuccess: boolean;
  tasks: TaskWaitObservation[];
}
export const TASK_WAIT_MAX_MS = 20_000;
const statuses = new Set<TaskWaitStatus>(["queued", "running", "done", "failed", "cancelled", "missing"]);
const cancelled = (): TaskWaitResult => ({ reason: "cancelled", dependentSuccess: false, tasks: [] });
const resultGuards = new WeakMap<object, () => boolean>();
/** Recheck the captured host authority after the tool's await, immediately before it formats a model payload. */
export function currentTaskWaitResult(result: unknown): boolean {
  const current = result !== null && typeof result === "object" ? resultGuards.get(result) : undefined;
  try { return current?.() === true; } catch { return false; }
}

/** Subscribe before the first snapshot, then recheck after registration and every observed change or wait. */
export function waitForTaskSettlement(input: {
  ids: readonly string[];
  snapshot(): readonly TaskWaitObservation[];
  subscribe(changed: () => void): () => void;
  current(): boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<TaskWaitResult> {
  const ids = [...new Set(input.ids)], timeout = input.timeoutMs ?? TASK_WAIT_MAX_MS;
  if (!ids.length || ids.length > 8 || input.ids.length > 8 || ids.some(id => typeof id !== "string" || !id || id.length > 60) ||
      !Number.isInteger(timeout) || timeout < 0 || timeout > TASK_WAIT_MAX_MS) return Promise.resolve(cancelled());
  return new Promise(resolve => {
    let finished = false, ready = false, checking = false, again = false, authorized = true;
    let unsubscribe = () => undefined as void;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = performance.now() + timeout;
    const valid = () => {
      if (!authorized) return false;
      try { authorized = !input.signal?.aborted && input.current() === true && !input.signal?.aborted; }
      catch { authorized = false; }
      return authorized;
    };
    const finish = (value: TaskWaitResult) => {
      if (finished) return;
      finished = true;
      if (timer !== undefined) clearTimeout(timer);
      input.signal?.removeEventListener("abort", abort);
      try { unsubscribe(); } catch { /* A failed observer disposal grants no result authority. */ value = cancelled(); }
      const output = valid() ? value : cancelled();
      resultGuards.set(output, valid);
      resolve(output);
    };
    const abort = () => finish(cancelled());
    const check = () => {
      if (finished || !ready) return;
      if (checking) { again = true; return; }
      checking = true;
      let passes = 0;
      do {
        again = false;
        if (!valid()) { finish(cancelled()); break; }
        let rows: TaskWaitObservation[];
        try {
          const values = input.snapshot();
          if (values.length !== ids.length) throw new Error();
          rows = values.map((value, index) => {
            if (value.id !== ids[index] || !statuses.has(value.status) || !["pending", "complete", "unknown"].includes(value.cleanup) ||
                typeof value.handoffSafe !== "boolean" || typeof value.summary !== "string") throw new Error();
            return { id: ids[index], status: value.status, cleanup: value.cleanup, handoffSafe: value.cleanup === "complete" && value.handoffSafe,
              summary: value.cleanup === "pending" ? "" : value.summary.slice(0, 512).replace(/[\p{Cc}\p{Cf}]/gu, " ") };
          });
        } catch { finish(cancelled()); break; }
        if (!valid()) { finish(cancelled()); break; }
        const settled = rows.every(row => row.status === "missing" || row.status !== "running" && row.status !== "queued" && row.cleanup !== "pending");
        if (settled || performance.now() >= deadline) {
          finish({ reason: settled ? "settled" : "timeout", dependentSuccess: settled && rows.every(row => row.status === "done" && row.cleanup === "complete" && row.handoffSafe), tasks: rows });
          break;
        }
      } while (again && !finished && ++passes < 2);
      checking = false;
    };
    try { unsubscribe = input.subscribe(check); } catch { finish(cancelled()); return; }
    ready = true;
    input.signal?.addEventListener("abort", abort, { once: true });
    const tick = () => {
      check();
      if (!finished) timer = setTimeout(tick, Math.max(1, Math.min(50, deadline - performance.now())));
    };
    tick();
  });
}
