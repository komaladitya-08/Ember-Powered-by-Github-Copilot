/** Real complete-file scans keep Stop responsive; no test substitutes a permissive content scanner. */
import fs from "node:fs";
import promises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { IsolatedCommandWorkspace } from "../../app/main/agent/isolated-command-workspace";
import { createCodingDependencySnapshot } from "../../app/main/agent/coding-dependency-snapshot";
import { CodingPrivacyScanner, CodingPrivacyCleanupError, retireCodingPrivacyScanners } from "../../app/main/agent/coding-privacy-scanner";
import { ScopedCodingWorker } from "../../app/main/agent/scoped-coding-worker";
import type { CommandService } from "../../app/main/commands/types";
import type { TaskSpec } from "../../app/main/agent/worker";
import { codingTestIsolationSupported } from "../fixtures/coding/trusted-node";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-privacy-workspace-")); roots.push(root);
  const source = path.join(root, "source"), baseDir = path.join(root, "copies"), privateDir = path.join(root, "private"), reviews = path.join(root, "reviews");
  for (const directory of [source, baseDir, privateDir, reviews]) fs.mkdirSync(directory, { mode: 0o700 });
  return { root, source, baseDir, privateDir, reviews, input: { source, baseDir, protectedPaths: [privateDir],
    binding: { owner: "a".repeat(64), session: crypto.randomUUID(), snapshot: crypto.randomUUID() } } };
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function enteredScan(bytes: number) {
  const entered = deferred(), original = CodingPrivacyScanner.prototype.refusal;
  vi.spyOn(CodingPrivacyScanner.prototype, "refusal").mockImplementation(function (this: CodingPrivacyScanner, text, options) {
    const pending = original.call(this, text, options);
    if (Buffer.byteLength(text) === bytes) entered.resolve();
    return pending;
  });
  return entered.promise;
}
const adverse = (bytes: number) => "sk-".repeat(Math.floor(bytes / 3)) + "x".repeat(bytes % 3);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("handles task Stop during an actual complete 4 MiB startup scan and never starts its model or command", async ctx => {
  if (!codingTestIsolationSupported()) { ctx.skip(); return; }
  const f = fixture(), bytes = 4 * 1024 * 1024, entered = enteredScan(bytes), task = new AbortController();
  fs.writeFileSync(path.join(f.source, "large.js"), adverse(bytes));
  const facts = vi.fn(async () => { throw new Error("A stopped startup must not reach command facts"); });
  const worker = new ScopedCodingWorker({ id: "privacy-stop", goal: "Inspect the copied source", target: { xid: 1, pid: 1 } } as unknown as TaskSpec, {
    runtime: { userData: f.privateDir, runtimePath: "/never-start-model", env: {} },
    createWorkspace: (signal, admit) => IsolatedCommandWorkspace.create({ ...f.input, signal, admit }),
    commandService: { binding: { id: "local", kind: "local" }, runner: { facts } } as unknown as CommandService,
    commandContext: () => { throw new Error("A stopped startup has no command context"); }, current: () => true, reviewBase: f.reviews,
    publish: async () => { throw new Error("A stopped startup cannot publish an execution result"); }, progress() {}, beforeStart: async () => undefined,
  });
  try {
    const running = worker.run(task.signal); await entered;
    const started = performance.now(); let tick = Infinity;
    await new Promise<void>(resolve => setTimeout(() => { tick = performance.now() - started; task.abort(); resolve(); }, 100));
    expect(tick).toBeLessThan(300);
    expect(await running).toMatchObject({ success: false, stopped: true }); await worker.dispose();
    expect(performance.now() - started).toBeLessThan(1500); expect(await worker.disposed).toBe(true);
    expect(facts).not.toHaveBeenCalled(); expect(fs.readdirSync(f.baseDir)).toEqual([]);
    expect(fs.existsSync(path.join(f.privateDir, "coding-controllers"))).toBe(false);
  } finally { task.abort(); await worker.dispose(); }
}, 10_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("cancels an actual complete 8 MiB dependency scan before copied bytes become an accepted result", async ctx => {
  if (!codingTestIsolationSupported()) { ctx.skip(); return; }
  const f = fixture(), bytes = 8 * 1024 * 1024, entered = enteredScan(bytes), task = new AbortController();
  fs.writeFileSync(path.join(f.source, "large.js"), adverse(bytes));
  const pending = createCodingDependencySnapshot({ source: { path: f.source, current: () => true }, baseDir: f.baseDir,
    protectedPaths: [f.privateDir], signal: task.signal }).catch(error => error);
  await entered;
  const started = performance.now(); let tick = Infinity;
  await new Promise<void>(resolve => setTimeout(() => { tick = performance.now() - started; task.abort(); resolve(); }, 100));
  expect(tick).toBeLessThan(300); expect(await pending).toMatchObject({ code: "cancelled" });
  expect(performance.now() - started).toBeLessThan(1500); expect(fs.readdirSync(f.baseDir)).toEqual([]);
}, 10_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("uses a distinct complete-file scan lifetime to preserve inert source bytes after verified Stop", async ctx => {
  if (!codingTestIsolationSupported()) { ctx.skip(); return; }
  const f = fixture(), workspace = await IsolatedCommandWorkspace.create(f.input), scans: CodingPrivacyScanner[] = [];
  try {
    await workspace.files(async root => { fs.writeFileSync(path.join(root, "partial.js"), "export const partial = 1;\n"); });
    await workspace.stop();
    const original = CodingPrivacyScanner.prototype.refusal;
    vi.spyOn(CodingPrivacyScanner.prototype, "refusal").mockImplementation(function (this: CodingPrivacyScanner, text, options) { scans.push(this); return original.call(this, text, options); });
    const exported = await workspace.exportReview(f.reviews);
    expect(exported.review.proposed.find(file => file.path === "partial.js")).toMatchObject({ base64: Buffer.from("export const partial = 1;\n").toString("base64") });
    expect(scans.length).toBeGreaterThan(0);
    await expect(scans[0].refusal("not admitted after export")).rejects.toMatchObject({ code: "cancelled" });
    expect(fs.readdirSync(f.source)).toEqual([]);
  } finally { await workspace.close(); }
}, 10_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("retains unknown privileged scanner termination as an export and disposal barrier", async ctx => {
  if (!codingTestIsolationSupported()) { ctx.skip(); return; }
  const f = fixture(), workspace = await IsolatedCommandWorkspace.create(f.input);
  await workspace.files(async root => { fs.writeFileSync(path.join(root, "partial.js"), "export const partial = 1;\n"); });
  await workspace.stop();
  const original = CodingPrivacyScanner.prototype.close;
  const failed = new WeakSet<CodingPrivacyScanner>();
  const scan = CodingPrivacyScanner.prototype.refusal;
  vi.spyOn(CodingPrivacyScanner.prototype, "refusal").mockImplementation(function (this: CodingPrivacyScanner, text, options) { failed.add(this); return scan.call(this, text, options); });
  vi.spyOn(CodingPrivacyScanner.prototype, "close").mockImplementation(async function (this: CodingPrivacyScanner) {
    await original.call(this); // The test itself still proves termination before simulating an unknown receipt.
    if (failed.has(this)) throw new CodingPrivacyCleanupError();
  });
  await expect(workspace.exportReview(f.reviews)).rejects.toBeInstanceOf(CodingPrivacyCleanupError);
  await expect(workspace.exportReview(f.reviews)).rejects.toBeInstanceOf(CodingPrivacyCleanupError);
  await expect(workspace.close()).rejects.toBeInstanceOf(CodingPrivacyCleanupError);
  expect(fs.readdirSync(f.reviews)).toEqual([]);
  expect(fs.readdirSync(f.baseDir).some(name => name.startsWith("ember-coding-snapshot-"))).toBe(true);
}, 10_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("cannot open a fresh privileged scanner from a workspace captured before global Forget", async ctx => {
  if (!codingTestIsolationSupported()) { ctx.skip(); return; }
  const f = fixture(), workspace = await IsolatedCommandWorkspace.create(f.input);
  try {
    await workspace.files(async root => { fs.writeFileSync(path.join(root, "partial.js"), "export const partial = 1;\n"); });
    await retireCodingPrivacyScanners();
    await expect(workspace.files(async () => "old source must not escape")).rejects.toMatchObject({ code: "stale" });
    await expect(workspace.exportReview(f.reviews)).rejects.toMatchObject({ code: "stale" });
    expect(fs.readdirSync(f.reviews)).toEqual([]);
  } finally { await workspace.close(); }
}, 10_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("project publication revocation blocks old exports without retiring another project's scanner", async ctx => {
  if (!codingTestIsolationSupported()) { ctx.skip(); return; }
  const first = fixture(), second = fixture(); let reviewCurrent = true;
  const input = { ...first.input, reviewCurrent: () => reviewCurrent };
  const forgotten = await IsolatedCommandWorkspace.create(input), continuing = await IsolatedCommandWorkspace.create(second.input);
  try {
    await forgotten.files(async root => { fs.writeFileSync(path.join(root, "partial.js"), "export const partial = 1;\n"); });
    await continuing.files(async root => { fs.writeFileSync(path.join(root, "kept.js"), "export const kept = 2;\n"); });
    await forgotten.stop(); reviewCurrent = false; input.reviewCurrent = () => true;
    await expect(forgotten.exportReview(first.reviews)).rejects.toMatchObject({ code: "stale" });
    expect(await continuing.run("printf allowed", "/work", () => undefined, new AbortController().signal)).toMatchObject({ exitCode: 0, output: "allowed", observed: true });
    expect(fs.readdirSync(first.reviews)).toEqual([]);
  } finally { await forgotten.close(); await continuing.close(); }
}, 10_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("withholds an export if its project is forgotten while complete-file privacy is pending", async ctx => {
  if (!codingTestIsolationSupported()) { ctx.skip(); return; }
  const f = fixture(); let reviewCurrent = true;
  const workspace = await IsolatedCommandWorkspace.create({ ...f.input, reviewCurrent: () => reviewCurrent });
  try {
    await workspace.files(async root => { fs.writeFileSync(path.join(root, "partial.js"), "export const partial = 1;\n"); }); await workspace.stop();
    const original = CodingPrivacyScanner.prototype.refusal;
    vi.spyOn(CodingPrivacyScanner.prototype, "refusal").mockImplementation(function (this: CodingPrivacyScanner, text, options) {
      const pending = original.call(this, text, options); reviewCurrent = false; return pending;
    });
    await expect(workspace.exportReview(f.reviews)).rejects.toMatchObject({ code: "stale" });
    expect(fs.readdirSync(f.reviews)).toEqual([]);
  } finally { await workspace.close(); }
}, 10_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("preserves unsafe startup privacy cleanup over a simultaneous snapshot-removal failure", async ctx => {
  if (!codingTestIsolationSupported()) { ctx.skip(); return; }
  const f = fixture(); fs.writeFileSync(path.join(f.source, "ordinary.js"), "password=hunter2\n");
  const close = CodingPrivacyScanner.prototype.close, remove = promises.rm;
  vi.spyOn(CodingPrivacyScanner.prototype, "close").mockImplementation(async function (this: CodingPrivacyScanner) {
    await close.call(this); throw new CodingPrivacyCleanupError();
  });
  vi.spyOn(promises, "rm").mockImplementation((target, options) => String(target).includes("ember-coding-snapshot-") ?
    Promise.reject(new Error("Synthetic snapshot cleanup failure")) : remove(target, options));
  await expect(IsolatedCommandWorkspace.create(f.input)).rejects.toBeInstanceOf(CodingPrivacyCleanupError);
}, 10_000);

it.skipIf(process.platform !== "linux" || process.arch !== "x64")("releases a terminal backend's owned baseline references while preserving source and published review bytes", async ctx => {
  if (!codingTestIsolationSupported()) { ctx.skip(); return; }
  const f = fixture(), original = "export const retained = 1;\n"; fs.writeFileSync(path.join(f.source, "ordinary.js"), original);
  const workspace = await IsolatedCommandWorkspace.create(f.input);
  const retained = workspace as unknown as { baseline: { entries: unknown[] }; exporting: Promise<unknown> | null };
  expect(retained.baseline.entries.length).toBeGreaterThan(0);
  const output = await workspace.exportReview(f.reviews); await workspace.close();
  expect(retained.baseline.entries).toEqual([]); expect(retained.exporting).toBeNull();
  await expect(workspace.exportReview(f.reviews)).rejects.toThrow("closing or already exporting");
  expect(output.review.baseline[0]).toMatchObject({ base64: Buffer.from(original).toString("base64") });
  expect(fs.readFileSync(path.join(f.source, "ordinary.js"), "utf8")).toBe(original);
}, 10_000);
