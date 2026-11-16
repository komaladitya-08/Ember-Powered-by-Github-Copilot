/** Real Host/conductor/custom SDK with a bounded Linux file fixture. No command service or Windows backend is provided. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { AgentHost, codingAvailable } from "../../app/main/agent/host";
import { ScopedCodingFiles } from "../../app/main/agent/scoped-coding-files";
import { createCodingReviewExport } from "../../app/main/agent/coding-result-export";
import type { CodingCommandWorkspace, CodingWorkspaceReview } from "../../app/main/agent/coding-platform";
import type { ScopedCodingChecks } from "../../app/main/agent/scoped-coding-worker";
import type { TaskSpec } from "../../app/main/agent/worker";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
import { SettingsStore } from "../../app/main/settings";
import { AuditLog } from "../../app/main/policy/audit";
import { Confirmer } from "../../app/main/agent/confirm";
import { createLogger } from "../../app/main/logger";
import { CONSENT_VERSION } from "../../app/shared/consent";
// @ts-expect-error -- offline JavaScript model fixture
import { startMockLlm } from "../mock-llm/server.mjs";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const request = "Change only the README heading in this project's private copy, leave the original unchanged, and prepare a review without running commands.";
const original = "Old heading\n";

async function fixture(holdCreation = false) {
  const temporary = fs.realpathSync(os.tmpdir()), parent = path.basename(temporary).startsWith("ember-run-") ? path.dirname(temporary) : temporary;
  const root = fs.mkdtempSync(path.join(parent, "ember-host-file-only-"));
  const userData = path.join(root, "host"), source = path.join(root, "source"), copies = path.join(root, "copies"), reviews = path.join(root, "reviews");
  for (const directory of [userData, source, copies, reviews]) fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(source, "README.md"), original);
  let dispatched = false, step = 0, sourceCurrent = true, forbiddenExecutions = 0, brokers = 0;
  const accepted: TaskSpec[] = [], published: { output: CodingWorkspaceReview; status: string; checks: ScopedCodingChecks }[] = [];
  const creationEntered = deferred(), releaseCreation = deferred();
  const model = await startMockLlm({ delayMs: 0, respond: (_messages: unknown[], tools: string[]) => {
    if (tools.includes("start_coding")) {
      if (!dispatched) { dispatched = true; return { tool: { name: "start_coding", args: { goal: "Update the private README heading for review", sessionName: "README edit" } } }; }
      return { text: "The file edit has its own task card and Stop. Commands and tests are unavailable." };
    }
    if (tools.includes("finish_coding")) {
      if (++step === 1) return { tool: { name: "coding_read", args: { path: "README.md" } } };
      if (step === 2) return { tool: { name: "coding_replace", args: { path: "README.md", oldText: "Old heading", newText: "Reviewed heading" } } };
      if (step === 3) return { tool: { name: "finish_coding", args: { success: true, summary: "Updated the copied README heading for review." } } };
    }
    return { text: "Review ready." };
  } });
  const runtime = runtimeFor("linux", process.arch), located = locateRuntime({ appPath: process.cwd(), runtimeId: runtime.id, exe: runtime.exe });
  expect(located.exists).toBe(true);
  const settings = new SettingsStore(path.join(userData, "settings.json")); settings.load();
  settings.update({ consent: { version: CONSENT_VERSION, at: new Date().toISOString() } });
  const log = createLogger({ dir: path.join(userData, "logs") }), audit = new AuditLog(path.join(userData, "audit"));
  const confirmer = new Confirmer(() => { throw new Error("No command approval is allowed in this file fixture"); });
  const host: AgentHost = new AgentHost({ userData, settings, runtimePath: located.path, log, setState() {}, onStatus() {}, taskBase: { audit, confirmer },
    provider: () => ({ kind: "user", config: { type: "openai", wireApi: "completions", baseUrl: model.baseUrl, apiKey: "synthetic-file-host-provider" },
      models: { conductor: "mock-model", worker: "mock-model" } }),
    scopedCoding: {
      mode: "files-only", available: () => true,
      workspace: projectId => projectId ? { projectId, path: source, current: () => sourceCurrent } : null,
      platform: { files: async (workspace, signal) => { brokers++; return ScopedCodingFiles.create({ workspace, signal }); } },
      createWorkspace: async (spec, signal, admit) => {
        accepted.push(spec); creationEntered.resolve();
        if (holdCreation) await releaseCreation.promise;
        if (signal.aborted || !admit()) throw new Error("The fixture folder grant retired before allocation");
        const directory = fs.mkdtempSync(path.join(copies, "copy-"));
        fs.copyFileSync(path.join(source, "README.md"), path.join(directory, "README.md"));
        const binding = { owner: host.projectWorkspaceScope()!, session: randomUUID(), snapshot: randomUUID() };
        const baseline = { binding, entries: [{ path: "README.md", kind: "file" as const, bytes: Buffer.from(original), executable: false }] };
        let retired = false, tail = Promise.resolve();
        const workspace: CodingCommandWorkspace = {
          executionRoot: "/work", nodeAvailable: false,
          files: operation => {
            const pending = tail.then(async () => {
              if (retired || signal.aborted || !admit()) throw new Error("The fixture file lease retired");
              const result = await operation(directory);
              if (retired || signal.aborted || !admit()) throw new Error("The fixture file lease retired");
              return result;
            });
            tail = pending.then(() => undefined, () => undefined); return pending;
          },
          run: async () => { forbiddenExecutions++; throw new Error("No command capability exists in this fixture"); },
          stop: () => { retired = true; return tail; },
          exportReview: async selectedBase => {
            expect(selectedBase).toBe(reviews); await workspace.stop();
            const tree = (filename: string) => ({ binding, entries: [{ path: "README.md", kind: "file" as const, bytes: fs.readFileSync(filename), executable: false }] });
            const proposed = tree(path.join(directory, "README.md")), current = tree(path.join(source, "README.md"));
            try {
              const rendered = createCodingReviewExport({ binding, baseline, proposed, current });
              const output = fs.mkdtempSync(path.join(reviews, "review-"));
              fs.writeFileSync(path.join(output, "review.json"), rendered.json, { mode: 0o600 });
              fs.writeFileSync(path.join(output, "changes.patch"), rendered.review.textPatch, { mode: 0o600 });
              return { directory: output, review: rendered.review, cleanup: "complete" };
            } finally { for (const captured of [baseline, proposed, current]) for (const entry of captured.entries) entry.bytes.fill(0); }
          },
          close: async () => { await workspace.stop(); baseline.entries[0].bytes.fill(0); fs.rmSync(directory, { recursive: true, force: true }); },
        };
        return workspace;
      },
      reviewBase: reviews,
      publish: async (spec, output, status, checks) => {
        published.push({ output, status, checks });
        return { id: randomUUID(), projectId: spec.codingWorkspace!.projectId!, taskId: spec.id, title: "README edit", sourcePath: source,
          status, files: output.review.changes.length, conflicts: 0, patchComplete: output.review.patchComplete, checks, message: "Fixture review ready" };
      },
    },
  });
  let closed = false;
  return { host, model, root, source, userData, copies, accepted, published, creationEntered, releaseCreation,
    revoke: (projectId: string) => { sourceCurrent = false; host.codingWorkspaceChanged(projectId); },
    executions: () => forbiddenExecutions, brokers: () => brokers,
    cleanup: async () => {
      releaseCreation.resolve();
      try { await host.stop(); closed = true; }
      finally { await model.close(); if (closed) fs.rmSync(root, { recursive: true, force: true }); }
    } };
}

it.skipIf(process.platform !== "linux")("runs a real file-only Host task without local command hands and publishes an inert review with zero checks", async () => {
  const f = await fixture();
  try {
    expect(await f.host.start(null)).toBe("ready");
    const project = f.host.projectSessionsAction({ action: "create", name: "File-only project" }).selectedProjectId!;
    expect(await f.host.ask(request)).toBe(true);
    await expect.poll(() => f.host.projectSessionsState().projects.find(p => p.id === project)?.sessions[0]?.status, { timeout: 20_000 }).toBe("done");
    await f.host.awaitCodingCleanup();
    expect(f.accepted).toHaveLength(1); expect(f.accepted[0].userWords).toBe(request); expect(f.accepted[0].codingWorkspace?.projectId).toBe(project);
    expect(f.published).toHaveLength(1); expect(f.published[0]).toMatchObject({ status: "done", checks: { ran: 0, passed: 0, failed: 0 } });
    expect(f.published[0].output.review.textPatch).toContain("+Reviewed heading");
    expect(fs.readFileSync(path.join(f.source, "README.md"), "utf8")).toBe(original);
    expect(f.executions()).toBe(0); expect(f.brokers()).toBe(1); expect(fs.readdirSync(f.copies)).toEqual([]);
    expect(fs.readdirSync(path.join(f.userData, "coding-controllers"))).toEqual([]);
    const coding = f.model.requests.filter((entry: { tools: string[] }) => entry.tools.includes("finish_coding"));
    expect(coding.length).toBeGreaterThanOrEqual(3);
    const allowed = ["coding_list", "coding_read", "coding_write", "coding_replace", "coding_delete", "coding_mkdir", "coding_search", "finish_coding"];
    expect(coding.every((entry: { tools: string[] }) => entry.tools.length === allowed.length && entry.tools.every(name => allowed.includes(name)))).toBe(true);
    expect(f.host.projectSessionsState().projects.find(p => p.id === project)?.sessions[0]?.summary).toContain("No commands or tests were run.");
    expect(codingAvailable()).toBe(false);
  } finally { await f.cleanup(); }
}, 35_000);

it.skipIf(process.platform !== "linux")("revokes a file-only Host task waiting for its folder copy before any controller or file tools can start", async () => {
  const f = await fixture(true);
  try {
    expect(await f.host.start(null)).toBe("ready");
    const project = f.host.projectSessionsAction({ action: "create", name: "Revoked project" }).selectedProjectId!;
    expect(await f.host.ask(request)).toBe(true); await f.creationEntered.promise;
    f.revoke(project); f.releaseCreation.resolve();
    await expect.poll(() => f.host.projectSessionsState().projects.find(p => p.id === project)?.sessions[0]?.status, { timeout: 15_000 }).toBe("stopped");
    await f.host.awaitCodingCleanup();
    expect(f.accepted).toHaveLength(1); expect(f.accepted[0].userWords).toBe(request);
    expect(f.brokers()).toBe(0); expect(f.executions()).toBe(0); expect(f.published).toEqual([]);
    expect(f.model.requests.every((entry: { tools: string[] }) => !entry.tools.includes("finish_coding"))).toBe(true);
    expect(fs.readdirSync(f.copies)).toEqual([]); expect(fs.readFileSync(path.join(f.source, "README.md"), "utf8")).toBe(original);
  } finally { await f.cleanup(); }
}, 30_000);
