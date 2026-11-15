import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SecretBox } from "../../app/main/agent/auth";
import { ProjectSessionStore } from "../../app/main/agent/project-session-store";
import type { ProjectSessionsState } from "../../app/shared/project-sessions";

const owner = { library: "1".repeat(64), holder: "2".repeat(64) };
const current = () => true;
let dir: string;
const filename = (library = owner.library) => path.join(dir, `project-sessions-${library}.bin`);
function box() {
  return {
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: vi.fn((text: string) => Buffer.from(text).reverse()),
    decryptString: vi.fn((bytes: Buffer) => Buffer.from(bytes).reverse().toString("utf8")),
  };
}
function snapshot(): ProjectSessionsState {
  const id = randomUUID();
  return { selectedProjectId: id, projects: [{ id, name: "Private project", goal: "Private project goal", createdAt: 10,
    sessions: ["queued", "running", "waiting", "done", "failed", "stopped"].map((status, index) => ({
      id: randomUUID(), taskId: `task-${index}`, title: `Task ${index}`, kind: "desktop", status: status as "done",
      detail: "Observed task detail", summary: "Private session output", startedAt: 20,
      ...(index >= 3 ? { finishedAt: 30 } : {}),
    })),
  }] };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-board-checkpoint-")); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(dir, { recursive: true, force: true }); });

describe("explicit project board checkpoints", () => {
  it("stores encrypted history, remints IDs, and never restores running work or task authority", async () => {
    const crypto = box(), state = snapshot(), store = new ProjectSessionStore(dir, crypto, false);
    expect(await store.load(owner, current)).toBeNull();
    await store.save(owner, state, current);
    expect(fs.readFileSync(filename()).includes(Buffer.from("Private project goal"))).toBe(false);
    expect(fs.readdirSync(dir)).toEqual([path.basename(filename())]);
    const restored = (await new ProjectSessionStore(dir, crypto, false).load(owner, current))!;
    expect(restored.projects[0].id).not.toBe(state.projects[0].id);
    expect(restored.selectedProjectId).toBe(restored.projects[0].id);
    expect(restored.projects[0]).toMatchObject({ name: "Private project", goal: "Private project goal", createdAt: 10 });
    const sessions = restored.projects[0].sessions;
    expect(sessions.map(s => s.status)).toEqual(["stopped", "stopped", "stopped", "done", "failed", "stopped"]);
    expect(sessions.every((s, i) => s.taskId === "" && s.id !== state.projects[0].sessions[i].id)).toBe(true);
    expect(sessions.slice(0, 3).every(s => s.detail.includes("Interrupted") && s.finishedAt !== undefined)).toBe(true);
    expect(sessions[3]).toMatchObject({ summary: "Private session output", finishedAt: 30 });
    expect(state.projects[0].sessions[0].status).toBe("queued");
  });

  it("rejects a different account, holder, or copied owner record without exposing metadata", async () => {
    const store = new ProjectSessionStore(dir, box(), false);
    await store.save(owner, snapshot(), current);
    await expect(store.load({ ...owner, holder: "3".repeat(64) }, current)).rejects.toThrow("different account or model connection");
    expect(await store.load({ library: "4".repeat(64), holder: "4".repeat(64) }, current)).toBeNull();
    fs.copyFileSync(filename(), filename("4".repeat(64)));
    await expect(store.load({ library: "4".repeat(64), holder: owner.holder }, current)).rejects.toThrow("different account or model connection");
    await expect(store.load({ ...owner, library: "../escape" }, current)).rejects.toThrow();
  });

  it("never falls back to plaintext or synchronous keyring access when async access was requested", async () => {
    const plain = { ...box(), getSelectedStorageBackend: () => "basic_text" };
    await expect(new ProjectSessionStore(dir, plain, false).save(owner, snapshot(), current)).rejects.toThrow("system keyring");
    expect(plain.encryptString).not.toHaveBeenCalled();
    const unavailable = box();
    await expect(new ProjectSessionStore(dir, unavailable, true).save(owner, snapshot(), current)).rejects.toThrow("system keyring");
    expect(unavailable.encryptString).not.toHaveBeenCalled();
    await expect(new ProjectSessionStore(dir, { ...unavailable, isAsyncEncryptionAvailable: async () => true }, true).save(owner, snapshot(), current)).rejects.toThrow("system keyring");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("leaves saved data in place if the keyring locks or the decrypted data is corrupt", async () => {
    const crypto = box(), store = new ProjectSessionStore(dir, crypto, false);
    await store.save(owner, snapshot(), current);
    const original = fs.readFileSync(filename());
    crypto.decryptString.mockImplementationOnce(() => { throw new Error("locked"); });
    await expect(store.load(owner, current)).rejects.toThrow("saved file was left in place");
    expect(fs.readFileSync(filename())).toEqual(original);
    fs.writeFileSync(filename(), "invalid");
    await expect(store.load(owner, current)).rejects.toThrow("saved file was left in place");
    expect(fs.readFileSync(filename(), "utf8")).toBe("invalid");
    await store.forget(owner, current);
    expect(await store.load(owner, current)).toBeNull();
  });

  it("bounds ciphertext and schemas, and never accepts executable checkpoint fields", async () => {
    const crypto = box(), store = new ProjectSessionStore(dir, crypto, false);
    fs.writeFileSync(filename(), Buffer.alloc(1_048_577));
    await expect(store.load(owner, current)).rejects.toThrow("invalid");
    expect(crypto.decryptString).not.toHaveBeenCalled();
    const state = snapshot();
    for (const invalid of [
      { ...state, selectedProjectId: randomUUID() },
      { ...state, projects: [...state.projects, ...state.projects] },
      { ...state, projects: [{ ...state.projects[0], workspace: "/execute/here" }] },
      { ...state, projects: [{ ...state.projects[0], sessions: [{ ...state.projects[0].sessions[0], status: "unknown" }] }] },
    ]) await expect(store.save(owner, invalid as unknown as ProjectSessionsState, current)).rejects.toThrow();
    expect(crypto.encryptString).not.toHaveBeenCalled();
  });

  it("cancels stale saves after async encryption and never resurrects a forgotten checkpoint", async () => {
    const working = box(), normal = new ProjectSessionStore(dir, working, false);
    await normal.save(owner, snapshot(), current);
    const encrypted = deferred<Buffer>(), begun = deferred<void>();
    const slow = { ...working, isAsyncEncryptionAvailable: async () => true, encryptStringAsync: () => { begun.resolve(); return encrypted.promise; } };
    const saving = new ProjectSessionStore(dir, slow, true).save(owner, snapshot(), current);
    await begun.promise;
    // Forget deliberately works with no keyring and a replacement credential.
    await new ProjectSessionStore(dir, { ...working, isEncryptionAvailable: () => false }, false).forget({ ...owner, holder: "5".repeat(64) }, current);
    encrypted.resolve(Buffer.from("late ciphertext"));
    await expect(saving).rejects.toThrow("cancelled");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("forgets every account's checkpoint after restart without a connected owner or keyring", async () => {
    const working = box(), store = new ProjectSessionStore(dir, working, false);
    await store.save(owner, snapshot(), current);
    await store.save({ library: "6".repeat(64), holder: "7".repeat(64) }, snapshot(), current);
    const unrelated = ["settings.json", "project-sessions-other.bin", `project-sessions-${owner.library}.bin.broken`, `project-sessions-${"A".repeat(64)}.bin`, `project-sessions-${owner.library}.bin.extra`];
    for (const name of unrelated) fs.writeFileSync(path.join(dir, name), "keep");
    const unavailable = { ...working, isEncryptionAvailable: vi.fn(() => false), getSelectedStorageBackend: () => "basic_text" };
    await new ProjectSessionStore(dir, unavailable, false).forgetAll(current);
    expect(fs.readdirSync(dir).sort()).toEqual(unrelated.sort());
    expect(unavailable.isEncryptionAvailable).not.toHaveBeenCalled();
    expect(working.decryptString).not.toHaveBeenCalled();
  });

  it("forget everything cancels every pending save even before any checkpoint file exists", async () => {
    const working = box(), one = deferred<Buffer>(), two = deferred<Buffer>();
    const begun: (() => void)[] = [];
    const ready = [deferred<void>(), deferred<void>()];
    const pending = [one, two].map((result, index) => {
      begun.push(() => ready[index].resolve());
      const slow = { ...working, isAsyncEncryptionAvailable: async () => true, encryptStringAsync: () => { begun[index](); return result.promise; } };
      return new ProjectSessionStore(dir, slow, true).save({ library: String(index + 3).repeat(64), holder: owner.holder }, snapshot(), current);
    });
    await Promise.all(ready.map(r => r.promise));
    expect(fs.readdirSync(dir)).toEqual([]);
    await new ProjectSessionStore(dir, working, false).forgetAll(current);
    one.resolve(Buffer.from("old one")); two.resolve(Buffer.from("old two"));
    for (const saving of pending) await expect(saving).rejects.toThrow("cancelled");
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("does not delete anything when forget everything is cancelled", async () => {
    const store = new ProjectSessionStore(dir, box(), false);
    await store.save(owner, snapshot(), current);
    const original = fs.readFileSync(filename());
    await expect(store.forgetAll(() => false)).rejects.toThrow("cancelled");
    expect(fs.readFileSync(filename())).toEqual(original);
  });

  it("checks the current account again after keyring waits and keeps the previous saved board", async () => {
    const working = box(), store = new ProjectSessionStore(dir, working, false);
    await store.save(owner, snapshot(), current);
    const prior = fs.readFileSync(filename()), encrypted = deferred<Buffer>(), begun = deferred<void>();
    let active = true;
    const slow = { ...working, isAsyncEncryptionAvailable: async () => true, encryptStringAsync: () => { begun.resolve(); return encrypted.promise; } };
    const saving = new ProjectSessionStore(dir, slow, true).save(owner, snapshot(), () => active);
    await begun.promise;
    active = false; encrypted.resolve(Buffer.from("wrong account"));
    await expect(saving).rejects.toThrow("cancelled");
    expect(fs.readFileSync(filename())).toEqual(prior);
    expect(fs.readdirSync(dir)).toHaveLength(1);
    await expect(store.forget(owner, () => false)).rejects.toThrow("cancelled");
    expect(fs.readFileSync(filename())).toEqual(prior);
  });

  it("rejects a load that outlives an account change or a new save", async () => {
    const working = box(), store = new ProjectSessionStore(dir, working, false);
    await store.save(owner, snapshot(), current);
    for (const reason of ["account", "save"]) {
      const decrypted = deferred<{ result: string; shouldReEncrypt: boolean }>(), begun = deferred<void>();
      let active = true;
      const slow: SecretBox = { ...working, isAsyncEncryptionAvailable: async () => true, decryptStringAsync: () => { begun.resolve(); return decrypted.promise; } };
      const loading = new ProjectSessionStore(dir, slow, true).load(owner, () => active);
      const old = fs.readFileSync(filename());
      await begun.promise;
      if (reason === "account") active = false;
      else await store.save(owner, snapshot(), current);
      decrypted.resolve({ result: working.decryptString(old), shouldReEncrypt: false });
      await expect(loading).rejects.toThrow("cancelled");
    }
  });

  it("keeps the previous checkpoint and removes temporary ciphertext if commit fails", async () => {
    const store = new ProjectSessionStore(dir, box(), false);
    await store.save(owner, snapshot(), current);
    const prior = fs.readFileSync(filename());
    vi.spyOn(fs, "renameSync").mockImplementationOnce(() => { throw new Error("disk full"); });
    await expect(store.save(owner, snapshot(), current)).rejects.toThrow("disk full");
    expect(fs.readFileSync(filename())).toEqual(prior);
    expect(fs.readdirSync(dir)).toEqual([path.basename(filename())]);
  });

  it("rejects a replacement storage directory while the keyring is pending", async () => {
    const working = box(), store = new ProjectSessionStore(dir, working, false);
    await store.save(owner, snapshot(), current);
    const encrypted = deferred<Buffer>(), begun = deferred<void>();
    const slow = { ...working, isAsyncEncryptionAvailable: async () => true, encryptStringAsync: () => { begun.resolve(); return encrypted.promise; } };
    const saving = new ProjectSessionStore(dir, slow, true).save(owner, snapshot(), current);
    await begun.promise;
    const displaced = `${dir}-old`;
    fs.renameSync(dir, displaced); fs.mkdirSync(dir);
    try {
      fs.writeFileSync(path.join(dir, "keep"), "replacement");
      encrypted.resolve(Buffer.from("late ciphertext"));
      await expect(saving).rejects.toThrow("folder changed");
      expect(fs.readdirSync(dir)).toEqual(["keep"]);
      expect(fs.readdirSync(displaced)).toEqual([path.basename(filename())]);
    } finally { fs.rmSync(displaced, { recursive: true, force: true }); }
  });

  it.skipIf(process.platform === "win32")("refuses symbolic-link checkpoint files and storage roots", async () => {
    const target = path.join(dir, "target");
    fs.writeFileSync(target, "keep");
    fs.symlinkSync(target, filename());
    await expect(new ProjectSessionStore(dir, box(), false).load(owner, current)).rejects.toThrow();
    expect(fs.readFileSync(target, "utf8")).toBe("keep");
    const linked = path.join(dir, "linked");
    fs.symlinkSync(dir, linked, "dir");
    await expect(new ProjectSessionStore(linked, box(), false).save(owner, snapshot(), current)).rejects.toThrow("folder is unavailable");
  });
});

describe("ordered plan checkpoint recovery", () => {
  function withPlan(status: "queued" | "running" | "waiting" = "running"): ProjectSessionsState {
    const state = snapshot(), project = state.projects[0];
    const liveSession = project.sessions.find(session => session.status === status)!;
    const doneSession = project.sessions.find(session => session.status === "done")!;
    project.sequences = [{
      id: randomUUID(), createdAt: 10, status: "active",
      steps: Array.from({ length: 8 }, (_, index) => ({
        name: `Review page ${index + 1}`, goal: `Inspect browser page ${index + 1} and verify its title`,
        status: index === 0 ? "done" as const : index === 1 ? status : "pending" as const,
        ...(index === 0 ? { sessionId: doneSession.id, summary: "Page one was reviewed.", startedAt: 20, finishedAt: 30 } : {}),
        ...(index === 1 ? { sessionId: liveSession.id, summary: "The page may already be open.", startedAt: 40 } : {}),
      })),
    }];
    return state;
  }

  it("keeps v1 checkpoints without ordered plans backwards compatible", async () => {
    const crypto = box(), store = new ProjectSessionStore(dir, crypto, false), state = snapshot();
    await store.save(owner, state, current);
    const saved = JSON.parse(crypto.decryptString(fs.readFileSync(filename())));
    expect(saved.version).toBe(1);
    expect(saved.state.projects[0]).not.toHaveProperty("sequences");
    const loaded = (await store.load(owner, current))!;
    expect(loaded.projects[0]).not.toHaveProperty("sequences");
    expect(loaded.projects[0].name).toBe(state.projects[0].name);
    expect(loaded.projects[0].sessions[3].summary).toBe(state.projects[0].sessions[3].summary);
  });

  for (const status of ["queued", "running", "waiting"] as const) {
    it(`restores an eight-step ${status} plan as inert interrupted progress without losing its remaining goals`, async () => {
      const crypto = box(), store = new ProjectSessionStore(dir, crypto, false), state = withPlan(status);
      const before = structuredClone(state), original = state.projects[0], originalPlan = original.sequences![0];
      await store.save(owner, state, current);
      expect(fs.readFileSync(filename()).includes(Buffer.from(originalPlan.steps[7].goal))).toBe(false);
      const loaded = (await store.load(owner, current))!, project = loaded.projects[0], plan = project.sequences![0];
      expect(loaded.selectedProjectId).toBe(project.id);
      expect(project.id).not.toBe(original.id);
      expect(plan.id).not.toBe(originalPlan.id);
      expect(plan).toMatchObject({ status: "interrupted", reason: "interrupted", createdAt: 10 });
      expect(plan.steps.map(step => step.goal)).toEqual(originalPlan.steps.map(step => step.goal));
      expect(plan.steps.map(step => step.name)).toEqual(originalPlan.steps.map(step => step.name));
      expect(plan.steps.map(step => step.status)).toEqual(["done", "interrupted", "pending", "pending", "pending", "pending", "pending", "pending"]);
      expect(plan.steps[0]).toMatchObject({ summary: "Page one was reviewed.", startedAt: 20, finishedAt: 30 });
      expect(plan.steps[1]).toMatchObject({ summary: "The page may already be open.", startedAt: 40, finishedAt: expect.any(Number) });
      expect(plan.steps[0].sessionId).toBe(project.sessions.find(session => session.title === "Task 3")!.id);
      expect(plan.steps[1].sessionId).toBe(project.sessions.find(session => session.title === original.sessions.find(session => session.status === status)!.title)!.id);
      expect(plan.steps[0].sessionId).not.toBe(originalPlan.steps[0].sessionId);
      expect(plan.steps[1].sessionId).not.toBe(originalPlan.steps[1].sessionId);
      expect(project.sessions.every(session => session.taskId === "")).toBe(true);
      expect(plan.steps.slice(2).every(step => step.sessionId === undefined && step.startedAt === undefined)).toBe(true);
      expect(state).toEqual(before);
      const again = (await store.load(owner, current))!;
      expect(again.projects[0].sequences![0].id).not.toBe(plan.id);
    });
  }

  it("preserves completed and deliberately retired plans and self-contained outcomes after session rows are evicted", async () => {
    const state = snapshot(), project = state.projects[0];
    project.sessions = [];
    project.sequences = [
      { id: randomUUID(), createdAt: 10, status: "completed", steps: [
        { name: "Read", goal: "Inspect the browser page", status: "done", summary: "Read the page.", startedAt: 20, finishedAt: 30 },
        { name: "Verify", goal: "Check the page title", status: "done", summary: "The title matched.", startedAt: 40, finishedAt: 50 },
      ] },
      { id: randomUUID(), createdAt: 60, status: "retired", reason: "steered", steps: [
        { name: "Prepare", goal: "Prepare the message draft", status: "done", summary: "Draft prepared.", startedAt: 70, finishedAt: 80 },
        { name: "Review", goal: "Review the prepared message", status: "pending" },
      ] },
    ];
    const before = structuredClone(state), store = new ProjectSessionStore(dir, box(), false);
    await store.save(owner, state, current);
    const loaded = (await store.load(owner, current))!, plans = loaded.projects[0].sequences!;
    expect(plans.map(plan => plan.status)).toEqual(["completed", "retired"]);
    expect(plans[1].reason).toBe("steered");
    expect(plans[0].steps).toEqual(project.sequences[0].steps);
    expect(plans[1].steps).toEqual(project.sequences[1].steps);
    expect(plans.every((plan, index) => plan.id !== project.sequences![index].id)).toBe(true);
    expect(state).toEqual(before);
  });

  it("refuses plan fields that could restore authority, duplicate plan identities or another project's session link", async () => {
    const state = withPlan(), store = new ProjectSessionStore(dir, box(), false);
    const invalid = (change: (copy: ProjectSessionsState) => void) => { const copy = structuredClone(state); change(copy); return copy; };
    const cases = [
      invalid(copy => Object.assign(copy.projects[0].sequences![0], { permissions: ["send"] })),
      invalid(copy => Object.assign(copy.projects[0].sequences![0].steps[1], { taskId: "old-executable-task" })),
      invalid(copy => { copy.projects[0].sequences!.push(structuredClone(copy.projects[0].sequences![0])); }),
      invalid(copy => {
        const other = snapshot().projects[0];
        copy.projects.push(other);
        copy.projects[0].sequences![0].steps[1].sessionId = other.sessions[0].id;
      }),
    ];
    for (const copy of cases) await expect(store.save(owner, copy, current)).rejects.toThrow();
    expect(fs.readdirSync(dir)).toEqual([]);
  });
});
