/** Current-turn joins observe cleanup without consuming reports, extending authority or scheduling another turn. */
import { afterEach, expect, it, vi } from "vitest";
import { waitForTaskSettlement, type TaskWaitObservation } from "../../app/main/agent/task-wait";
const row = (id: string, status: TaskWaitObservation["status"] = "running", cleanup: TaskWaitObservation["cleanup"] = "pending"): TaskWaitObservation =>
  ({ id, status, cleanup, handoffSafe: cleanup === "complete", summary: "fixed summary" });
function setup(ids = ["a", "b"]) {
  const rows = [...new Set(ids)].map(id => row(id)), listeners = new Set<() => void>(), abort = new AbortController();
  let current = true, unsubscribed = 0;
  const input = { ids, timeoutMs: 100, signal: abort.signal, current: () => current,
    snapshot: () => rows, subscribe(listener: () => void) { listeners.add(listener); return () => { unsubscribed++; listeners.delete(listener); }; } };
  return { input, rows, listeners, abort, emit() { for (const listener of [...listeners]) listener(); },
    current(value: boolean) { current = value; }, unsubscribed: () => unsubscribed };
}
afterEach(() => vi.useRealTimers());
it("waits beyond card completion until actual cleanup, then joins all independent tasks without consuming anything", async () => {
  vi.useFakeTimers(); const value = setup(), work = waitForTaskSettlement(value.input); let settled = false; void work.then(() => { settled = true; });
  value.rows[0] = row("a", "done", "complete"); value.emit(); await Promise.resolve(); expect(settled).toBe(false);
  value.rows[1] = row("b", "done"); value.emit(); await Promise.resolve(); expect(settled).toBe(false);
  value.rows[1].cleanup = "complete"; value.rows[1].handoffSafe = true; value.emit();
  expect(await work).toMatchObject({ reason: "settled", dependentSuccess: true, tasks: [{ cleanup: "complete" }, { cleanup: "complete" }] });
  expect(value.listeners.size).toBe(0); expect(value.unsubscribed()).toBe(1); expect(vi.getTimerCount()).toBe(0);
});
it.each([false, true])("keeps known cleanup separate from the dependent-success witness, handoffSafe=%s", async handoffSafe => {
  const value = setup(["a"]); value.rows[0] = { ...row("a", "done", "complete"), handoffSafe };
  expect(await waitForTaskSettlement(value.input)).toMatchObject({ reason: "settled", dependentSuccess: handoffSafe, tasks: [{ cleanup: "complete", handoffSafe }] });
});
it.each(["failed", "cancelled", "missing"] as const)("reports %s without claiming dependent success", async status => {
  const value = setup(["a"]); value.rows[0] = row("a", status, "complete");
  expect(await waitForTaskSettlement(value.input)).toMatchObject({ reason: "settled", dependentSuccess: false, tasks: [{ status }] });
});
it("reports terminal unknown cleanup without promoting a done card", async () => {
  const value = setup(["a"]); value.rows[0] = row("a", "done", "unknown");
  expect(await waitForTaskSettlement(value.input)).toMatchObject({ reason: "settled", dependentSuccess: false, tasks: [{ status: "done", cleanup: "unknown", handoffSafe: false }] });
});
it("returns bounded observed pending state on timeout and releases its listener and timer", async () => {
  vi.useFakeTimers(); const value = setup(), work = waitForTaskSettlement(value.input);
  await vi.advanceTimersByTimeAsync(100);
  expect(await work).toMatchObject({ reason: "timeout", dependentSuccess: false, tasks: [{ status: "running", summary: "" }, { status: "running", summary: "" }] });
  expect(value.listeners.size).toBe(0); expect(value.unsubscribed()).toBe(1); expect(vi.getTimerCount()).toBe(0);
});
it("closes the subscribe/snapshot finish-registration race", async () => {
  const value = setup(["a"]), original = value.input.subscribe;
  value.input.subscribe = listener => { const remove = original(listener); value.rows[0] = row("a", "done", "complete"); listener(); return remove; };
  expect(await waitForTaskSettlement(value.input)).toMatchObject({ reason: "settled", dependentSuccess: true }); expect(value.unsubscribed()).toBe(1);
});
it("rechecks a synchronous snapshot completion without recursion or a lost wakeup", async () => {
  const value = setup(["a"]); let snapshots = 0;
  value.input.snapshot = () => { if (++snapshots === 1) { const old = [...value.rows]; value.rows[0] = row("a", "done", "complete"); value.emit(); return old; } return value.rows; };
  expect(await waitForTaskSettlement(value.input)).toMatchObject({ reason: "settled", dependentSuccess: true }); expect(snapshots).toBe(2);
});
it("bounds an always-reentrant observer and still expires", async () => {
  vi.useFakeTimers(); const value = setup(["a"]); value.input.snapshot = () => { value.emit(); return value.rows; };
  const work = waitForTaskSettlement(value.input); await vi.advanceTimersByTimeAsync(100);
  expect(await work).toMatchObject({ reason: "timeout", dependentSuccess: false }); expect(value.unsubscribed()).toBe(1); expect(vi.getTimerCount()).toBe(0);
});
it.each(["abort", "current", "throw"])("ends quietly without summaries when its context changes through %s", async fault => {
  vi.useFakeTimers(); const value = setup(), work = waitForTaskSettlement(value.input);
  if (fault === "abort") value.abort.abort(); else if (fault === "current") value.current(false); else value.input.current = () => { throw new Error("private context"); };
  await vi.advanceTimersByTimeAsync(50);
  expect(await work).toEqual({ reason: "cancelled", dependentSuccess: false, tasks: [] });
  expect(value.listeners.size).toBe(0); expect(value.unsubscribed()).toBe(1); expect(vi.getTimerCount()).toBe(0);
});
it("checks cancellation again after a current callback aborts reentrantly", async () => {
  const value = setup(["a"]); value.rows[0] = row("a", "done", "complete"); value.input.current = () => { value.abort.abort(); return true; };
  expect(await waitForTaskSettlement(value.input)).toEqual({ reason: "cancelled", dependentSuccess: false, tasks: [] });
});
it("rechecks current authority after observer disposal before returning any payload", async () => {
  const value = setup(["a"]); value.rows[0] = row("a", "done", "complete"); value.input.subscribe = () => () => value.current(false);
  expect(await waitForTaskSettlement(value.input)).toEqual({ reason: "cancelled", dependentSuccess: false, tasks: [] });
});
it("deduplicates IDs, clones bounded untrusted summaries and ignores repeat completion", async () => {
  const value = setup(["a", "a"]); value.rows[0] = { ...row("a", "done", "complete"), summary: "x".repeat(1000) };
  const result = await waitForTaskSettlement(value.input); value.rows[0].summary = "changed"; value.emit();
  expect(result.tasks).toHaveLength(1); expect(result.tasks[0].summary).toBe("x".repeat(512)); expect(value.unsubscribed()).toBe(1);
});
it.each([[], Array.from({ length: 9 }, (_, index) => String(index)), [""], ["x".repeat(61)]].map(ids => ({ ids })))("refuses invalid task bounds without registering a listener (%#)", async ({ ids }) => {
  const value = setup(ids); expect(await waitForTaskSettlement(value.input)).toEqual({ reason: "cancelled", dependentSuccess: false, tasks: [] }); expect(value.listeners.size).toBe(0);
});
it.each([-1, 20_001, NaN, Infinity, 0.5])("refuses an invalid wait budget %s", async timeoutMs => {
  const value = setup(); expect(await waitForTaskSettlement({ ...value.input, timeoutMs })).toEqual({ reason: "cancelled", dependentSuccess: false, tasks: [] }); expect(value.unsubscribed()).toBe(0);
});
