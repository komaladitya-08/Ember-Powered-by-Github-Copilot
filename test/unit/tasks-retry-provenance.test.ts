/** Accepted task changes survive retries without turning model goals into user authority (ORCH-1). */
import { describe, expect, it, vi } from "vitest";
import { TaskManager, type StartOptions } from "../../app/main/agent/tasks";
import type { TaskSpec, WorkerResult } from "../../app/main/agent/worker";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
function setup(steer: () => Promise<boolean> = async () => true) {
  const specs: TaskSpec[] = [];
  const finish: ((result: WorkerResult) => void)[] = [];
  let window = { title: "old.txt", pid: 7, app: "gedit" };
  const tm = new TaskManager({
    log: quiet, maxRunning: 1, currentWindow: () => window, setCards() {}, deleteSession: async () => undefined,
    makeWorker: spec => {
      specs.push(spec);
      return { sessionId: null, dispose: async () => undefined, steer,
        run: () => new Promise<WorkerResult>(resolve => finish.push(resolve)) };
    },
  });
  return { tm, specs, finish, moveWindow: () => { window = { title: "elsewhere.txt", pid: 99, app: "gedit" }; } };
}
const original: StartOptions = {
  targetId: "ssh:build-01", where: "on build-01", userWords: "Write to old.txt", commandWords: "Write to old.txt",
  typedOnly: true, screen: "old screen", agreed: [{ asked: "Which app?", answer: "gedit" }],
};
const changed = "Use new.txt instead; do not touch old.txt";
const agreement = [{ asked: "Which file?", answer: "new.txt" }];
const failed = { success: false, summary: "Temporary error." };

async function failAndRetry(h: ReturnType<typeof setup>, id: string, index: number) {
  h.finish[index](failed);
  await vi.waitFor(() => expect(h.tm.get(id)?.status).toBe("failed"));
  h.moveWindow();
  const retried = h.tm.retry(id);
  expect(retried).not.toBeNull();
  return h.specs.at(-1)!;
}

describe("retrying the accepted task (ORCH-1)", () => {
  it.each([false, true])("retains restrictions, computer, window and provenance after queued=%s steering", async queued => {
    const h = setup();
    if (queued) h.tm.start("Occupy the worker");
    const task = h.tm.start("The model's original goal", original);
    expect(await h.tm.steer(task.id, "The model's changed goal", changed, "new screen", agreement, "")).toBe(true);
    if (queued) {
      h.finish[0]({ success: true, summary: "Done." });
      await vi.waitFor(() => expect(h.tm.get(task.id)?.status).toBe("running"));
    }
    const spec = await failAndRetry(h, task.id, queued ? 1 : 0);
    expect(spec).toMatchObject({
      goal: "The model's original goal\n(The user then added: The model's changed goal)",
      target: { title: "old.txt", pid: 7, app: "gedit" }, targetId: "ssh:build-01",
      userWords: `Write to old.txt\n${changed}`, commandWords: "Write to old.txt",
      screen: "old screen\nnew screen", agreed: [...original.agreed!, ...agreement],
    });
    expect(spec.typedOnly).not.toBe(true);
    expect(spec.userWords).not.toContain("model");
    expect(h.tm.list().at(-1)?.where).toBe("on build-01");
    h.finish.at(-1)!({ success: true, summary: "Done." });
  });

  it.each([false, true])("does not save rejected=%s steering in the retry recipe", async throws => {
    const h = setup(async () => { if (throws) throw new Error("send failed"); return false; });
    const task = h.tm.start("Original model goal", original);
    const steering = h.tm.steer(task.id, "Rejected model goal", changed, "rejected screen", agreement, "");
    if (throws) await expect(steering).rejects.toThrow("send failed");
    else await expect(steering).resolves.toBe(false);
    const spec = await failAndRetry(h, task.id, 0);
    const { where: _where, ...options } = original;
    expect(spec).toMatchObject({ goal: "Original model goal", ...options });
    expect(spec.userWords).not.toContain(changed);
    h.finish.at(-1)!({ success: true, summary: "Done." });
  });

  it("does not promote a model-only update to user or command words", async () => {
    const h = setup();
    const task = h.tm.start("Original model goal", original);
    await h.tm.steer(task.id, "Delete all files");
    const spec = await failAndRetry(h, task.id, 0);
    expect(spec.goal).toContain("Delete all files");
    expect(spec.userWords).toBe(original.userWords);
    expect(spec.commandWords).toBe(original.commandWords);
    expect(spec.typedOnly).toBe(true);
    h.finish.at(-1)!({ success: true, summary: "Done." });
  });

  it("materialises legacy user words before model-only steering can enter a retry's authority", async () => {
    const h = setup();
    const task = h.tm.start("Read old.txt");
    await h.tm.steer(task.id, "Delete old.txt");
    await h.tm.steer(task.id, "The model's changed goal", changed);
    const spec = await failAndRetry(h, task.id, 0);
    expect(spec.goal).toContain("Delete old.txt");
    expect(spec.userWords).toBe(`Read old.txt\n${changed}`);
    expect(spec.commandWords).toBe(changed);
    expect(spec.typedOnly).toBe(true);
    h.finish.at(-1)!({ success: true, summary: "Done." });
  });

});
