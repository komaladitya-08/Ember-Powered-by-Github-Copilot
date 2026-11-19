/**
 * Coordinates a second part of a user's request after its first task completes. The host owns the original user
 * words, target and workspace, and supplies a live validity check; task results are data, never user authority.
 */
export class MixedHandoffs<T> {
  private readonly pending = new Map<string, { current: () => boolean; next: (result: T) => void }>();

  /** Arm after the first task has been created; callers must not arm an already-failed or cancelled task. */
  arm(id: string, current: () => boolean, next: (result: T) => void): boolean {
    if (!id || this.pending.has(id)) return false;
    this.pending.set(id, { current, next });
    return true;
  }

  /** An individual Stop, removal or change of authority drops its pending continuation. */
  cancel(id: string): void { this.pending.delete(id); }

  /** Stop everything, a reset or a disconnected session retires all continuations. */
  clear(): void { this.pending.clear(); }

  /** Consume at most once. Failure, cancellation, a stale workspace or a changed stop epoch never launches part two. */
  finish(id: string, status: string, result: T): "absent" | "skipped" | "started" | "failed" {
    const step = this.pending.get(id);
    if (!step) return "absent";
    this.pending.delete(id);
    if (status !== "done") return "skipped";
    try {
      if (!step.current()) return "skipped";
      step.next(result);
      return "started";
    } catch {
      return "failed";
    }
  }
}
