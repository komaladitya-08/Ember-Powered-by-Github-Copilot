/** Actual custom-only SDK, command policy flow, no-network command namespaces and review-only coding outcome. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { codingTestIsolationSupported, trustedCodingTestNodeOrSkip } from "../fixtures/coding/trusted-node";
import { expect, it, vi } from "vitest";
import { ScopedCodingWorker, type ScopedCodingWorkerOptions, type FileOnlyScopedCodingWorkerOptions } from "../../app/main/agent/scoped-coding-worker";
import { ScopedCodingFiles } from "../../app/main/agent/scoped-coding-files";
import { IsolatedCommandWorkspace, type IsolatedCommandReview } from "../../app/main/agent/isolated-command-workspace";
import { locateRuntime, runtimeFor } from "../../app/main/agent/runtime";
import { Refusals } from "../../app/main/policy/refusals";
import type { CommandFlowContext } from "../../app/main/commands/flow";
import type { CommandService, RunnerFacts } from "../../app/main/commands/types";
import type { CodingResultSummary } from "../../app/shared/project-coding";
import type { TaskSpec } from "../../app/main/agent/worker";
import type { Logger } from "../../app/main/logger";
// @ts-expect-error -- offline JavaScript model fixture
import { startMockLlm } from "../mock-llm/server.mjs";

const supported = codingTestIsolationSupported;
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture(model: { baseUrl: string }, nodePath: string, extra: Partial<ScopedCodingWorkerOptions> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-scoped-worker-"));
  const source = path.join(root, "source"), baseDir = path.join(root, "copies"), userData = path.join(root, "private"), reviews = path.join(root, "reviews");
  for (const folder of [source, baseDir, userData, reviews]) fs.mkdirSync(folder, { mode: 0o700 });
  const runtime = runtimeFor("linux", process.arch), located = locateRuntime({ appPath: process.cwd(), runtimeId: runtime.id, exe: runtime.exe });
  expect(located.exists).toBe(true);
  const fact: RunnerFacts = { os: "linux", shells: ["bash", "sh"], shellPaths: { bash: "/bin/bash", sh: "/bin/sh" }, script: null,
    home: "/host-home", user: "fixture", privileged: false, pty: true, ember: { paths: [userData], pids: [process.pid], names: /^ember$/ }, extraPath: [] };
  const nativeStart = vi.fn(() => { throw new Error("The parent host runner must never execute a coding command"); });
  const attach = vi.fn(), asks = vi.fn(async () => "once"), audit: unknown[] = [], states: CommandFlowContext["state"][] = [];
  const service: CommandService = {
    binding: { id: "local", kind: "local", label: "This computer", screenOs: "linux", shellOs: "linux", desktop: "screen" },
    capability: () => ({ state: "on", askEvery: null }), shells: () => ["bash", "sh"], consented() {}, userAskEvery: () => true, mode: () => "on",
    runner: { target: "local", facts: async () => fact, inspect: async paths => paths.map(() => ({ exists: null, real: null })), gitFacts: async () => null,
      start: nativeStart, stopAll: async () => undefined, running: 0 },
    window: { showCard() {}, hideCard() {}, cardReady: () => true, announce: async () => true, cancelAnnounce() {}, attach },
  };
  const published: { output: IsolatedCommandReview; status: string; checks: { ran: number; passed: number; failed: number } }[] = [];
  const contexts = vi.fn<ScopedCodingWorkerOptions["commandContext"]>((isolated, signal) => {
    const state = { cwd: null, downloaded: new Set<string>(), running: false }, refusals = new Refusals(); states.push(state);
    return { task: { id: "worker-fixture", title: "Fix the copied check", commandWords: () => "Run node --test test.cjs, fix it and rerun the same test.",
      agreed: () => [], tainted: () => false, taint() {}, readFrom: () => [] },
    service: isolated, confirmer: { ask: asks }, presenter: { announce() {}, endAnnouncement() {}, progress() {} } as unknown as CommandFlowContext["presenter"],
    audit: entry => audit.push(entry), log: quiet, signal, isOver: () => signal.aborted, state, size: () => ({ cols: 80, rows: 24 }), emberPids: () => [process.pid], refusals };
  });
  const options: ScopedCodingWorkerOptions = {
    runtime: { userData, runtimePath: located.path, env: process.env }, model: "mock-model", provider: { type: "openai", baseUrl: model.baseUrl, apiKey: "synthetic-host-key" },
    createWorkspace: (signal, admit) => IsolatedCommandWorkspace.create({ source, baseDir, protectedPaths: [userData], nodePath,
      binding: { owner: "a".repeat(64), session: crypto.randomUUID(), snapshot: crypto.randomUUID() }, signal, admit }),
    commandService: service, commandContext: contexts, current: () => true, reviewBase: reviews, beforeStart: async () => undefined, progress() {},
    publish: async (output, status, checks) => { published.push({ output, status, checks }); return { id: crypto.randomUUID() } as CodingResultSummary; }, ...extra,
  };
  const spec = { id: "worker-fixture", goal: "Fix the copied test and verify it with node --test test.cjs", target: { xid: 1, pid: 1 } } as unknown as TaskSpec;
  return { root, source, baseDir, userData, reviews, options, worker: new ScopedCodingWorker(spec, options), contexts, nativeStart, published, states, asks, attach, audit };
}

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("publishes an explicitly file-only SDK task with zero checks and no command service", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const asset = await trustedCodingTestNodeOrSkip(ctx);
  let step = 0;
  const model = await startMockLlm({ delayMs: 0, respond: () => {
    step++;
    if (step === 1) return { tool: { name: "coding_read", args: { path: "README.md" } } };
    if (step === 2) return { tool: { name: "coding_replace", args: { path: "README.md", oldText: "Old heading", newText: "Reviewed heading" } } };
    if (step === 3) return { tool: { name: "finish_coding", args: { success: true, summary: "Updated the copied heading for review." } } };
    return { text: "Review ready." };
  } });
  const f = fixture(model, asset.nodePath), { commandService: _service, commandContext: _context, publicDependencies: _publicDependencies, ...base } = f.options;
  const facts = vi.spyOn(_service.runner, "facts");
  const options: FileOnlyScopedCodingWorkerOptions = { ...base, mode: "files-only",
    platform: { files: (workspace, signal) => ScopedCodingFiles.create({ workspace, signal }) } };
  const worker = new ScopedCodingWorker({ id: "file-only-worker", goal: "Change the README heading without commands", target: {} } as TaskSpec, options);
  fs.writeFileSync(path.join(f.source, "README.md"), "Old heading\n");
  try {
    expect(await worker.run(new AbortController().signal)).toEqual({ success: true, summary: "Updated the copied heading for review. No commands or tests were run." });
    await worker.dispose(); expect(await worker.disposed).toBe(true); expect(worker.handoffSafe()).toBe(true);
    expect(facts).not.toHaveBeenCalled(); expect(f.contexts).not.toHaveBeenCalled(); expect(f.nativeStart).not.toHaveBeenCalled(); expect(f.asks).not.toHaveBeenCalled();
    expect(f.published).toHaveLength(1); expect(f.published[0]).toMatchObject({ status: "done", checks: { ran: 0, passed: 0, failed: 0 } });
    expect(f.published[0].output.review.textPatch).toContain("+Reviewed heading");
    expect(fs.readFileSync(path.join(f.source, "README.md"), "utf8")).toBe("Old heading\n");
    expect(fs.readdirSync(f.baseDir)).toEqual([]); expect(fs.readdirSync(path.join(f.userData, "coding-controllers"))).toEqual([]);
    expect(model.requests.every((request: { tools: string[] }) => !request.tools.some(name => ["run_command", "bash", "create", "task", "web_fetch"].includes(name)))).toBe(true);
  } finally { await worker.dispose(); await model.close(); facts.mockRestore(); fs.rmSync(f.root, { recursive: true, force: true }); }
}, 45_000);

for (const tool of ["run_command", "run_node", "node_only"] as const) it.skipIf(process.platform !== "linux" || process.arch !== "x64")(`fixes a real failing Node check through ${tool}, then exports without changing the source`, async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const asset = await trustedCodingTestNodeOrSkip(ctx);
  let step = 0;
  const model = await startMockLlm({ delayMs: 0, respond: () => {
    step++;
    if (step === 1 || step === 3) return { tool: { name: tool === "node_only" ? "run_node" : tool, args: tool !== "run_command"
      ? { argv: ["--test", "test.cjs"], why: "Verify the copied check" }
      : { target: "This computer", command: "node --test test.cjs", why: "Verify the copied check" } } };
    if (step === 2) return { tool: { name: "coding_replace", args: { path: "test.cjs", oldText: "1 + 1, 3", newText: "1 + 1, 2" } } };
    if (step === 4) return { tool: { name: "finish_coding", args: { success: true, summary: "Fixed the copied assertion and reran its exact Node check successfully." } } };
    return { text: "Ready for review." };
  } });
  // Host capability facts advertise no model shell for this case; the actual Linux isolation/Node backend is unchanged.
  const f = fixture(model, asset.nodePath, tool === "node_only" ? { platform: {
    facts: (_workspace, host) => ({ ...host, os: "linux", home: "/state", shells: [], shellPaths: {}, script: null, pty: false, extraPath: [] }),
    files: (workspace, signal) => ScopedCodingFiles.create({ workspace, signal }),
  } } : {}), original = "const {test}=require('node:test');const assert=require('node:assert/strict');test('sum',()=>assert.equal(1 + 1, 3));\n";
  fs.writeFileSync(path.join(f.source, "test.cjs"), original);
  try {
    expect(await f.worker.run(new AbortController().signal)).toEqual({ success: true, summary: "Fixed the copied assertion and reran its exact Node check successfully." });
    await f.worker.dispose(); expect(await f.worker.disposed).toBe(true); expect(f.worker.handoffSafe()).toBe(true);
    expect(f.nativeStart).not.toHaveBeenCalled(); expect(f.contexts).toHaveBeenCalledTimes(1); expect(f.asks).toHaveBeenCalledTimes(2);
    expect(f.attach).toHaveBeenCalledTimes(2); expect(f.states[0].cwd).toBe("/work");
    if (tool !== "run_command") {
      expect(f.attach.mock.calls.map(([card]) => card)).toEqual([expect.objectContaining({ kind: "node", argv: ["--test", "test.cjs"] }), expect.objectContaining({ kind: "node", argv: ["--test", "test.cjs"] })]);
      expect(f.attach.mock.calls.every(([card]) => card.shell === undefined)).toBe(true);
      expect(JSON.stringify(f.audit)).not.toContain('"argv"');
      expect(model.requests.every((request: { tools: string[] }) => request.tools.includes("run_node"))).toBe(true);
      if (tool === "node_only") expect(model.requests.every((request: { tools: string[] }) => !request.tools.includes("run_command"))).toBe(true);
    }
    expect(f.published).toHaveLength(1); expect(f.published[0]).toMatchObject({ status: "done", checks: { ran: 2, passed: 1, failed: 1 } });
    const review = f.published[0].output.review;
    expect(review.patchComplete).toBe(true); expect(review.changes).toHaveLength(1); expect(review.textPatch).toContain("1 + 1, 2");
    expect(fs.readFileSync(path.join(f.source, "test.cjs"), "utf8")).toBe(original);
    expect(fs.readdirSync(f.baseDir)).toEqual([]); expect(fs.readdirSync(path.join(f.userData, "coding-controllers"))).toEqual([]);
    expect(model.requests.every((r: { tools: string[] }) => !r.tools.some(name => ["bash", "create", "edit", "task"].includes(name)))).toBe(true);
    f.worker.invalidate(); expect(f.worker.handoffSafe()).toBe(false);
    f.options.current = () => true; expect(f.worker.handoffSafe()).toBe(false);
    expect(await f.worker.disposed).toBe(true);
  } finally { await f.worker.dispose(); await model.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
}, 60_000);

for (const how of ["stop", "current"] as const) it.skipIf(process.platform !== "linux" || process.arch !== "x64")(`never revives a completed handoff after ${how} revokes it`, async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const asset = await trustedCodingTestNodeOrSkip(ctx);
  let step = 0;
  const model = await startMockLlm({ delayMs: 0, respond: () => ++step === 1 ? { tool: { name: "finish_coding", args: { success: true, summary: "The empty fixture is ready." } } } : { text: "Ready." } });
  const f = fixture(model, asset.nodePath);
  try {
    expect((await f.worker.run(new AbortController().signal)).success).toBe(true); expect(f.worker.handoffSafe()).toBe(true);
    if (how === "stop") f.worker.stop(); else f.options.current = () => false;
    expect(f.worker.handoffSafe()).toBe(false);
    f.options.current = () => true; expect(f.worker.handoffSafe()).toBe(false);
    await f.worker.dispose(); expect(await f.worker.disposed).toBe(true);
  } finally { await f.worker.dispose(); await model.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
}, 45_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("returns a stopped inert partial review only after a real running command and its writer have exited", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const asset = await trustedCodingTestNodeOrSkip(ctx);
  let step = 0;
  const model = await startMockLlm({ delayMs: 0, respond: () => ++step === 1 ? { tool: { name: "run_command", args: {
    target: "This computer", command: "node -e \"const f=require('fs');f.writeFileSync('heartbeat','x');console.log('writer-started');setInterval(()=>f.appendFileSync('heartbeat','x'),20)\"", why: "Exercise the copied fixture until stopped" } } } : { text: "Stopped." } });
  const f = fixture(model, asset.nodePath), task = new AbortController(), begun = deferred<void>();
  f.attach.mockImplementation((_card, run) => { run.onOutput((bytes: Uint8Array) => { if (Buffer.from(bytes).toString().includes("writer-started")) begun.resolve(); }); });
  try {
    const running = f.worker.run(task.signal); await begun.promise; task.abort();
    expect(await running).toMatchObject({ success: false, stopped: true }); await f.worker.dispose();
    expect(await f.worker.disposed).toBe(true); expect(f.worker.handoffSafe()).toBe(false);
    expect(f.published).toHaveLength(1); expect(f.published[0]).toMatchObject({ status: "stopped", checks: { ran: 0, passed: 0, failed: 0 } });
    expect(f.published[0].output.review.proposed.some(file => file.path === "heartbeat")).toBe(true);
    expect(fs.readdirSync(f.source)).toEqual([]); expect(fs.readdirSync(f.baseDir)).toEqual([]);
  } finally { task.abort(); await f.worker.dispose(); await model.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
}, 45_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("does not block a new account after publication is refused when the controller and command workspace closed safely", async ctx => {
  if (!supported()) { ctx.skip(); return; }
  const asset = await trustedCodingTestNodeOrSkip(ctx);
  let step = 0;
  const model = await startMockLlm({ delayMs: 0, respond: () => ++step === 1 ? { tool: { name: "finish_coding", args: { success: true, summary: "The empty fixture is ready." } } } : { text: "Ready." } });
  const publish = vi.fn(async () => { throw new Error("Synthetic account change during registration"); }), f = fixture(model, asset.nodePath, { publish });
  try {
    expect(await f.worker.run(new AbortController().signal)).toMatchObject({ success: false, summary: expect.stringContaining("could not be published") });
    await f.worker.dispose(); expect(await f.worker.disposed).toBe(true); expect(f.worker.handoffSafe()).toBe(false); expect(publish).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(f.baseDir)).toEqual([]); expect(fs.readdirSync(path.join(f.userData, "coding-controllers"))).toEqual([]);
  } finally { await f.worker.dispose(); await model.close(); fs.rmSync(f.root, { recursive: true, force: true }); }
}, 45_000);
