/** Exact task controls from Home. Titles, summaries and renderer capability flags never select a task. */
import type { Task, TaskManager } from "./tasks";

export interface TaskWindow { id: number; pid: number; title: string; wmClass?: string }

/** Revalidate a worker-read native window before showing it. A title alone, or a recycled ID in another process, fails. */
export function sameTaskWindow(ref: TaskWindow, now: { client: number; id: number; pid: number | null; title: string; wmClass: string }): boolean {
  return ref.id > 0 && ref.pid > 0 && !!ref.title && (now.client === ref.id || now.id === ref.id)
    && now.pid === ref.pid && now.title === ref.title && (!ref.wmClass || now.wmClass === ref.wmClass);
}

/** Passive capability snapshots share one OS read; activation always obtains a fresh snapshot. */
export function createTaskWindowControl(d: {
  list: () => { client: number; id: number; pid: number | null; title: string; wmClass: string }[];
  activate: (id: number) => void;
  blocked: () => boolean;
}): (task: Task, focus: boolean) => boolean {
  let checked = -Infinity, shown: ReturnType<typeof d.list> = [];
  return (task, focus) => {
    if (!task.window || (task.targetId && task.targetId !== "local") || task.hand === "desk") return false;
    try {
      if (d.blocked()) return false;
      if (focus || Date.now() - checked >= 250) { shown = d.list(); checked = Date.now(); }
      const found = shown.find(w => sameTaskWindow(task.window!, w));
      if (!found) return false;
      if (focus) d.activate(found.client);
      return true;
    } catch { return false; }
  };
}

export interface TaskControlHost {
  tasks: Pick<TaskManager, "canStop" | "cancel" | "openWindow"> | null;
  retryTask(id: string): boolean;
}

/** Main calls this only after validating the Home sender. Availability is checked again at activation. */
export function taskControl(host: TaskControlHost | null, raw: unknown): boolean {
  if (!host || !raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const { id, action } = raw as { id?: unknown; action?: unknown };
  if (typeof id !== "string" || !/^[0-9]+-[0-9a-f]{8}$/.test(id)) return false;
  if (action === "stop") {
    if (!host.tasks?.canStop(id)) return false;
    host.tasks.cancel(id); return true;
  }
  if (action === "retry") return host.retryTask(id);
  if (action === "window") return host.tasks?.openWindow(id) ?? false;
  return false;
}
