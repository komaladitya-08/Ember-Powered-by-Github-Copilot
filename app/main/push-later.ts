/**
 * A push that waits: asked for many times a second (a task's steps), it sends once at the end of each `ms` (the latest
 * state then), never more often. Plain Node, no Electron, so it is unit-tested with fake timers (home-status.test.ts):
 * main uses it for Home's Task activity (TASKS_PUSH_MS).
 */

/** Returns the function to call on every change; `send` runs at most once per `ms`, `ms` after the first change. */
export function pushLater(ms: number, send: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      send();
    }, ms);
  };
}
