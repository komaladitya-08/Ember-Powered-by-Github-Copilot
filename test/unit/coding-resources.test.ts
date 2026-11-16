import { afterEach, beforeEach, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { IsolatedCommandWorkspaceInput, IsolatedCommandWorkspace, IsolatedCommandReview } from "../../app/main/agent/isolated-command-workspace";
import { createCodingReviewExport, type CodingExportTree } from "../../app/main/agent/coding-result-export";
import { CodingResultRegistry } from "../../app/main/agent/coding-result-registry";
import { ProjectCodingWorkspaces } from "../../app/main/agent/project-coding-workspaces";
import type { TaskSpec } from "../../app/main/agent/worker";

const sim = vi.hoisted(() => ({ discover: vi.fn(), create: vi.fn() }));
vi.mock("../../app/main/agent/coding-toolchain", () => ({ discoverCodingToolchain: sim.discover }));
vi.mock("../../app/main/agent/isolated-command-workspace", () => ({ IsolatedCommandWorkspace: { create: sim.create } }));
import { ProjectCodingResources, type ProjectCodingResourcesOptions } from "../../app/main/agent/coding-resources";
import { selectCodingStorageBase } from "../../app/main/agent/coding-storage";
import { CodingPrivacyCleanupError, CodingPrivacyScanError } from "../../app/main/agent/coding-privacy-scanner";

const A = "a".repeat(64), B = "b".repeat(64), P = "11111111-1111-4111-8111-111111111111", Q = "22222222-2222-4222-8222-222222222222";
const verified = { available: true, nodePath: "/usr/bin/node", version: "v24.1.0", message: "Verified fixture tools." };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
interface Backend {
  input: IsolatedCommandWorkspaceInput;
  stop: ReturnType<typeof vi.fn<() => Promise<void>>>;
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
  exportReview: ReturnType<typeof vi.fn<(base: string) => Promise<IsolatedCommandReview>>>;
}
let temp: string, source: string, userData: string, app: string, temporary: string, owner: string | null;
let options: ProjectCodingResourcesOptions, changed: ReturnType<typeof vi.fn<() => void>>, backends: Backend[];
const resources: ProjectCodingResources[] = [];
const resourceIt = it.skipIf(process.platform !== "linux" || process.arch !== "x64");
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "ember-resources-test-"));
  source = path.join(temp, "source"); userData = path.join(temp, "user-data"); app = path.join(temp, "app"); temporary = path.join(temp, "temporary");
  for (const directory of [source, userData, app, temporary]) await fs.mkdir(directory, { mode: 0o700 });
  await fs.writeFile(path.join(source, "app.ts"), "original\n");
  vi.spyOn(os, "tmpdir").mockReturnValue(temporary);
  owner = A; changed = vi.fn<() => void>(); backends = [];
  options = { userData, protectedPaths: [userData, app], currentOwner: () => owner, projectExists: id => [P, Q].includes(id),
    env: { PATH: "/usr/bin:/bin", GH_TOKEN: "never-forwarded", NODE_OPTIONS: "never-forwarded" }, execPath: "/app/electron", isElectron: true, changed };
  sim.discover.mockReset().mockResolvedValue(verified);
  sim.create.mockReset().mockImplementation(async (input: IsolatedCommandWorkspaceInput) => makeBackend(input) as unknown as IsolatedCommandWorkspace);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(resources.splice(0).map(value => value.close().catch(() => undefined)));
  await fs.rm(temp, { recursive: true, force: true });
  vi.doUnmock("../../app/main/platform/os");
});
function makeBackend(input: IsolatedCommandWorkspaceInput): Backend {
  const backend: Backend = { input, stop: vi.fn(async () => undefined), close: vi.fn(async () => undefined), exportReview: vi.fn(async base => {
    const binding = input.binding, tree = (text: string): CodingExportTree => ({ binding, entries: [{ path: "app.ts", kind: "file", bytes: Buffer.from(text), executable: false }] });
    const rendered = createCodingReviewExport({ binding, baseline: tree("original\n"), proposed: tree("changed\n"), current: tree("original\n") });
    const directory = await fs.mkdtemp(path.join(base, "ember-coding-review-"));
    await fs.writeFile(path.join(directory, "review.json"), rendered.json, { mode: 0o600 });
    await fs.writeFile(path.join(directory, "changes.patch"), rendered.review.textPatch, { mode: 0o600 });
    return { directory, review: rendered.review, cleanup: "complete" };
  }) };
  backends.push(backend); return backend;
}
async function open(extra: Partial<ProjectCodingResourcesOptions> = {}) {
  const value = await ProjectCodingResources.create({ ...options, ...extra }); resources.push(value); return value;
}
async function ready(value: ProjectCodingResources) { await vi.waitFor(() => expect(value.availability().available).toBe(true)); }
async function bind(value: ProjectCodingResources, projectId = P, selected = source) {
  const folder = await value.validateSource({ path: selected, current: () => true });
  value.folders.bind(projectId, folder, value.folders.ownerCurrent(projectId));
}
function spec(value: ProjectCodingResources, projectId = P): TaskSpec {
  const workspace = value.workspace(projectId); expect(workspace).not.toBeNull();
  return { id: randomUUID(), goal: "Repair copied app", target: {}, codingWorkspace: workspace! };
}

resourceIt("uses one supplied folder manager and keeps unused result access metadata-only", async () => {
  const folders = new ProjectCodingWorkspaces(options), factory = vi.spyOn(CodingResultRegistry, "create");
  const value = await open({ folders }); expect(value.folders).toBe(folders);
  const results = await value.results();
  expect(results.state(P)).toEqual([]); expect(await results.review("unknown")).toBeNull();
  expect((await results.export("unknown", source, () => true)).ok).toBe(false);
  await results.reset(); await results.forgetProject(P); await results.forgetResult("unknown"); await value.invalidate();
  expect(factory).not.toHaveBeenCalled();
});

resourceIt("keeps availability false until the verified kernel/Node discovery resolves, with no Electron fallback", async () => {
  const discovery = deferred<typeof verified>(); sim.discover.mockReturnValue(discovery.promise);
  const value = await open();
  expect(value.availability()).toMatchObject({ available: false }); expect(value.availability()).not.toHaveProperty("nodePath");
  expect(sim.discover).toHaveBeenCalledWith(expect.objectContaining({ env: { PATH: "/usr/bin:/bin" }, execPath: "/app/electron", isElectron: true }));
  discovery.resolve(verified); await ready(value);
  expect(value.availability()).toMatchObject({ available: true, nodePath: "/usr/bin/node" }); expect(changed).toHaveBeenCalled();
});

resourceIt("never substitutes the app executable when discovery cannot verify a system Node", async () => {
  sim.discover.mockResolvedValue({ available: false, nodePath: null, version: null, message: "No supported tools." });
  const value = await open(); await vi.waitFor(() => expect(changed).toHaveBeenCalled());
  expect(value.availability().available).toBe(false); expect(value.availability()).not.toHaveProperty("nodePath");
  expect(value.workspace(P)).toBeNull(); expect(sim.create).not.toHaveBeenCalled();
});

resourceIt("creates private temporary copy/review storage outside user data and rejects all common-parent descendants as sources", async () => {
  const value = await open(); await ready(value);
  const privateRoot = path.dirname(value.reviewBase), common = path.dirname(privateRoot);
  expect(path.dirname(common)).toBe(temporary); expect(privateRoot.startsWith(userData + path.sep)).toBe(false);
  for (const directory of [common, privateRoot, value.reviewBase, path.join(privateRoot, "copies")]) expect((await fs.stat(directory)).mode & 0o777).toBe(0o700);
  const oldCopy = path.join(common, "other-process", "copy"); await fs.mkdir(oldCopy, { recursive: true, mode: 0o700 });
  for (const selected of [oldCopy, value.reviewBase, userData, app, temp]) await expect(value.validateSource({ path: selected, current: () => true })).rejects.toThrow();
  await bind(value); const task = spec(value), workspace = await value.createWorkspace(task, new AbortController().signal, () => true);
  expect(backends[0].input).toMatchObject({ source, baseDir: path.join(privateRoot, "copies"), protectedPaths: [userData, app], nodePath: "/usr/bin/node", binding: { owner: A } });
  expect(backends[0].input).not.toHaveProperty("env");
  await workspace.close();
});

resourceIt("discloses the fixed source scope before work and grants only ordinary in-project dependencies", async () => {
  const value = await open(); await ready(value); await bind(value);
  expect(value.availability().message).toContain("exclude .git and node_modules");
  expect(value.availability().message).toContain("No dependencies are installed or downloaded");
  const first = await value.createWorkspace(spec(value), new AbortController().signal, () => true);
  expect(backends[0].input.scope).toEqual({ excludeRoots: [".git", "node_modules"] }); await first.close();
  const dependencies = path.join(source, "node_modules"); await fs.mkdir(dependencies, { mode: 0o700 });
  const second = await value.createWorkspace(spec(value), new AbortController().signal, () => true);
  expect(backends[1].input.scope?.dependencies?.path).toBe(dependencies);
  expect(backends[1].input.scope?.dependencies?.current()).toBe(true);
  await second.close(); await value.invalidate(); expect(backends[1].input.scope?.dependencies?.current()).toBe(false);
});

resourceIt("refuses an external node_modules link without silently granting its target", async () => {
  const value = await open(); await ready(value); await bind(value);
  const external = path.join(temp, "external-dependencies"); await fs.mkdir(external, { mode: 0o700 });
  await fs.symlink(external, path.join(source, "node_modules"), "dir");
  await expect(value.createWorkspace(spec(value), new AbortController().signal, () => true)).rejects.toThrow();
  expect(sim.create).not.toHaveBeenCalled(); expect(await fs.readdir(external)).toEqual([]);
});

resourceIt("rejects an existing common-parent symlink rather than adopting or chmodding it", async () => {
  const elsewhere = path.join(temp, "elsewhere"); await fs.mkdir(elsewhere, { mode: 0o755 });
  await fs.chmod(elsewhere, 0o755);
  await fs.symlink(elsewhere, path.join(temporary, `ember-coding-${process.getuid!()}`), "dir");
  const value = await open();
  expect(value.availability().available).toBe(false); expect(sim.discover).not.toHaveBeenCalled();
  expect((await fs.stat(elsewhere)).mode & 0o777).toBe(0o755);
});

resourceIt("blocks an unmarked prior process directory without reusing or deleting its private data", async () => {
  const common = path.join(temporary, `ember-coding-${process.getuid!()}`), prior = path.join(common, "process-123456-AbCd12");
  await fs.mkdir(prior, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(prior, "unknown-copy.txt"), "keep prior data\n", { mode: 0o600 });
  const value = await open(); expect(value.availability().available).toBe(false);
  expect(value.availability().message).toContain("no verified cleanup receipt"); expect(sim.discover).not.toHaveBeenCalled();
  expect(await fs.readFile(path.join(prior, "unknown-copy.txt"), "utf8")).toBe("keep prior data\n");
});

resourceIt("recovers only an exact durable fully-closed receipt with known empty role directories", async () => {
  const common = path.join(temporary, `ember-coding-${process.getuid!()}`), name = "process-123456-AbCd12", prior = path.join(common, name);
  await fs.mkdir(prior, { recursive: true, mode: 0o700 });
  for (const role of ["copies", "reviews"]) await fs.mkdir(path.join(prior, role), { mode: 0o700 });
  const stat = await fs.stat(prior, { bigint: true });
  await fs.writeFile(path.join(prior, "cleanup-complete.json"), JSON.stringify({ version: 1, phase: "fully-closed", directory: name, volume: stat.dev.toString(), ino: stat.ino.toString() }), { mode: 0o600 });
  const value = await open(); await ready(value);
  await expect(fs.lstat(prior)).rejects.toMatchObject({ code: "ENOENT" });
});

resourceIt("does not trust a cleanup marker when a supposedly empty role contains an unknown file", async () => {
  const common = path.join(temporary, `ember-coding-${process.getuid!()}`), name = "process-123456-AbCd12", prior = path.join(common, name);
  await fs.mkdir(path.join(prior, "copies"), { recursive: true, mode: 0o700 });
  const stat = await fs.stat(prior, { bigint: true });
  await fs.writeFile(path.join(prior, "cleanup-complete.json"), JSON.stringify({ version: 1, phase: "fully-closed", directory: name, volume: stat.dev.toString(), ino: stat.ino.toString() }), { mode: 0o600 });
  await fs.writeFile(path.join(prior, "copies", "keep.txt"), "keep\n");
  const value = await open(); expect(value.availability().available).toBe(false);
  expect(await fs.readFile(path.join(prior, "copies", "keep.txt"), "utf8")).toBe("keep\n");
});

resourceIt("keeps published partial results bound to the old source while Stop and a new folder choice do not revoke owner authority", async () => {
  const value = await open(); await ready(value); await bind(value);
  const task = spec(value), signal = new AbortController(), workspace = await value.createWorkspace(task, signal.signal, () => true);
  signal.abort(); await workspace.stop();
  expect(backends[0].input.reviewCurrent?.()).toBe(true);
  const next = path.join(temp, "next-source"); await fs.mkdir(next, { mode: 0o700 }); await bind(value, P, next);
  expect(backends[0].input.admit?.()).toBe(false); expect(backends[0].input.reviewCurrent?.()).toBe(true);
  const output = await workspace.exportReview(value.reviewBase);
  const result = await value.publish(task, output, "stopped", { ran: 1, passed: 0, failed: 1 });
  expect(result).toMatchObject({ sourcePath: source, status: "stopped", checks: { ran: 1, passed: 0, failed: 1 } });
  expect((await value.results()).state(P)).toHaveLength(1);
  await workspace.close(); expect(backends[0].close).toHaveBeenCalledTimes(1);
});

resourceIt("cleans a stopped old-owner output after owner ABA without publishing it to the restored account", async () => {
  const value = await open(); await ready(value); await bind(value);
  const task = spec(value), workspace = await value.createWorkspace(task, new AbortController().signal, () => true);
  const output = await workspace.exportReview(value.reviewBase);
  owner = B; await value.invalidate(); owner = A; await value.invalidate();
  expect(backends[0].input.reviewCurrent?.()).toBe(false);
  await expect(value.publish(task, output, "stopped", { ran: 0, passed: 0, failed: 0 })).rejects.toThrow();
  expect((await value.results()).state(P)).toEqual([]); expect(await fs.readdir(value.reviewBase)).toEqual([]);
  expect(value.workspace(P)).toBeNull(); await workspace.close();
});

resourceIt("latches per-project result invalidation before a lazy registry exists without affecting another project", async () => {
  const value = await open(); await ready(value); await bind(value, P); await bind(value, Q);
  const first = spec(value, P), second = spec(value, Q);
  const a = await value.createWorkspace(first, new AbortController().signal, () => true), b = await value.createWorkspace(second, new AbortController().signal, () => true);
  const one = await a.exportReview(value.reviewBase), two = await b.exportReview(value.reviewBase);
  const results = await value.results(); await results.forgetProject(P);
  expect(backends[0].input.reviewCurrent?.()).toBe(false); expect(backends[1].input.reviewCurrent?.()).toBe(true);
  await expect(value.publish(first, one, "stopped", { ran: 0, passed: 0, failed: 0 })).rejects.toThrow();
  const result = await value.publish(second, two, "done", { ran: 1, passed: 1, failed: 0 });
  expect(results.state(P)).toEqual([]); expect(results.state(Q)).toEqual([result]);
  await Promise.all([a.close(), b.close()]);
});

resourceIt("revokes pending creation synchronously and treats its clean cancellation as expected", async () => {
  const value = await open(); await ready(value); await bind(value);
  const entered = deferred<IsolatedCommandWorkspaceInput>(), release = deferred<void>();
  sim.create.mockImplementationOnce(async (input: IsolatedCommandWorkspaceInput) => { entered.resolve(input); await release.promise; return makeBackend(input) as unknown as IsolatedCommandWorkspace; });
  const creating = value.createWorkspace(spec(value), new AbortController().signal, () => true).catch(error => error);
  const input = await entered.promise, invalidated = value.invalidate();
  expect(input.admit?.()).toBe(false); release.resolve();
  expect(await creating).toBeInstanceOf(Error); await expect(invalidated).resolves.toBeUndefined();
  expect(backends[0].stop).toHaveBeenCalled(); expect(backends[0].close).toHaveBeenCalled();
  expect(value.availability().available).toBe(true); expect(value.workspace(P)).toBeNull();
});

resourceIt("retains private storage and hard-blocks an unverified privacy-thread exit during copy creation", async () => {
  const value = await open(); await ready(value); await bind(value);
  sim.create.mockRejectedValueOnce(new CodingPrivacyCleanupError());
  await expect(value.createWorkspace(spec(value), new AbortController().signal, () => true)).rejects.toBeInstanceOf(CodingPrivacyCleanupError);
  expect(value.availability().available).toBe(false);
  const privateRoot = path.dirname(value.reviewBase);
  await expect(value.close()).rejects.toThrow("retained");
  expect(await fs.readdir(privateRoot)).not.toContain("cleanup-complete.json");
});

resourceIt("does not classify an ordinary completed-scan failure as uncertain thread cleanup", async () => {
  const value = await open(); await ready(value); await bind(value);
  sim.create.mockRejectedValueOnce(new CodingPrivacyScanError("timeout"));
  await expect(value.createWorkspace(spec(value), new AbortController().signal, () => true)).rejects.toThrow("could not be created");
  expect(value.availability().available).toBe(true);
});

resourceIt("binds privileged review authority to project existence independently of task Stop", async () => {
  let exists = true;
  const value = await open({ projectExists: id => id === P && exists }); await ready(value); await bind(value);
  const task = spec(value), workspace = await value.createWorkspace(task, new AbortController().signal, () => true);
  expect(backends[0].input.privacyScope).toBeDefined(); expect(backends[0].input.reviewCurrent?.()).toBe(true);
  exists = false; expect(backends[0].input.reviewCurrent?.()).toBe(false);
  await workspace.close();
});

resourceIt("waits for verified backend close and blocks fresh admission before global Forget succeeds", async () => {
  const value = await open(); await ready(value); await bind(value);
  const task = spec(value), workspace = await value.createWorkspace(task, new AbortController().signal, () => true);
  const directory = path.join(backends[0].input.baseDir, "held-private-copy");
  await fs.mkdir(directory, { mode: 0o700 }); await fs.writeFile(path.join(directory, "app.ts"), "retained until verified close");
  const entered = deferred<void>(), release = deferred<void>();
  backends[0].close.mockImplementation(async () => { entered.resolve(); await release.promise; await fs.rm(directory, { recursive: true }); });
  let completed = false;
  const invalidating = value.invalidate().then(() => { completed = true; });
  await entered.promise; expect(completed).toBe(false); expect(value.availability().available).toBe(false);
  expect(await fs.readFile(path.join(directory, "app.ts"), "utf8")).toBe("retained until verified close");
  await bind(value); const selected = value.folders.capture(P)!;
  const later: TaskSpec = { id: randomUUID(), goal: "new request", target: {}, codingWorkspace: { ...selected, projectId: P } };
  await expect(value.createWorkspace(later, new AbortController().signal, () => true)).rejects.toThrow();
  const joined = workspace.close(); expect(backends[0].close).toHaveBeenCalledTimes(1);
  release.resolve(); await Promise.all([invalidating, joined]);
  expect(completed).toBe(true); await expect(fs.lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  expect(backends[0].close).toHaveBeenCalledTimes(1); expect(value.availability().available).toBe(true);
});

resourceIt("drains a held export and removes a stopped artifact before its publisher ever resumes", async () => {
  const value = await open(); await ready(value); await bind(value);
  const task = spec(value), workspace = await value.createWorkspace(task, new AbortController().signal, () => true);
  const render = backends[0].exportReview.getMockImplementation()!, entered = deferred<void>(), release = deferred<void>();
  backends[0].exportReview.mockImplementationOnce(async base => { const output = await render(base); entered.resolve(); await release.promise; return output; });
  const exporting = workspace.exportReview(value.reviewBase); await entered.promise;
  let completed = false; const invalidating = value.invalidate().then(() => { completed = true; });
  await Promise.resolve(); expect(completed).toBe(false); expect((await fs.readdir(value.reviewBase)).length).toBe(1);
  release.resolve(); const output = await exporting; await invalidating;
  expect(await fs.readdir(value.reviewBase)).toEqual([]);
  await expect(value.publish(task, output, "stopped", { ran: 0, passed: 0, failed: 0 })).rejects.toThrow();
  expect(await fs.readdir(value.reviewBase)).toEqual([]);
});

resourceIt("waits for an in-flight publication and its artifact cleanup before global Forget completes", async () => {
  const value = await open(); await ready(value); await bind(value);
  const task = spec(value), workspace = await value.createWorkspace(task, new AbortController().signal, () => true);
  const output = await workspace.exportReview(value.reviewBase), entered = deferred<void>(), release = deferred<void>();
  const original = CodingResultRegistry.prototype.put;
  vi.spyOn(CodingResultRegistry.prototype, "put").mockImplementationOnce(async function (this: CodingResultRegistry, input) {
    entered.resolve(); await release.promise; return original.call(this, input);
  });
  const publishing = value.publish(task, output, "done", { ran: 1, passed: 1, failed: 0 }).catch(error => error);
  await entered.promise;
  let completed = false; const invalidating = value.invalidate().then(() => { completed = true; });
  await Promise.resolve(); expect(completed).toBe(false);
  release.resolve(); expect(await publishing).toBeInstanceOf(Error); await invalidating;
  expect((await value.results()).state(P)).toEqual([]); expect(await fs.readdir(value.reviewBase)).toEqual([]);
});

resourceIt("does not claim global Forget erased residue from a failed startup with no returned backend", async () => {
  const value = await open(); await ready(value); await bind(value);
  let leftover = "";
  sim.create.mockImplementationOnce(async (input: IsolatedCommandWorkspaceInput) => {
    leftover = path.join(input.baseDir, "unverified-startup-copy"); await fs.mkdir(leftover, { mode: 0o700 });
    await fs.writeFile(path.join(leftover, "app.ts"), "keep failed startup data"); throw new Error("startup failed before ownership returned");
  });
  await expect(value.createWorkspace(spec(value), new AbortController().signal, () => true)).rejects.toThrow();
  await expect(value.invalidate()).rejects.toThrow("retained"); expect(value.availability().available).toBe(false);
  expect(await fs.readFile(path.join(leftover, "app.ts"), "utf8")).toBe("keep failed startup data");
});

resourceIt("blocks future coding and retains the private base when a known backend cannot prove shutdown", async () => {
  const value = await open(); await ready(value); await bind(value);
  await value.createWorkspace(spec(value), new AbortController().signal, () => true);
  backends[0].stop.mockRejectedValue(new Error("unknown process state"));
  await expect(value.invalidate()).rejects.toThrow("retained"); expect(value.availability().available).toBe(false);
  const root = path.dirname(value.reviewBase);
  await expect(value.close()).rejects.toThrow("retained");
  expect((await fs.stat(root)).mode & 0o777).toBe(0o700);
});

resourceIt("lets verified retry of inert registry cleanup restore availability without clearing execution uncertainty", async () => {
  const value = await open(); await ready(value); await bind(value);
  const task = spec(value), workspace = await value.createWorkspace(task, new AbortController().signal, () => true);
  const output = await workspace.exportReview(value.reviewBase);
  await value.publish(task, output, "done", { ran: 1, passed: 1, failed: 0 }); await workspace.close();
  const results = await value.results(), unlink = vi.spyOn(fs, "unlink").mockRejectedValueOnce(new Error("temporary cleanup failure"));
  await expect(results.reset()).rejects.toThrow("retained"); expect(value.availability().available).toBe(false);
  unlink.mockRestore(); await results.reset(); expect(value.availability().available).toBe(true);
  expect(await fs.readdir(value.reviewBase)).toEqual([]);
});

resourceIt("forgets a failed publication once and retries unadopted output cleanup after registry opening recovers", async () => {
  const value = await open(); await ready(value); await bind(value);
  const task = spec(value), workspace = await value.createWorkspace(task, new AbortController().signal, () => true);
  const output = await workspace.exportReview(value.reviewBase), create = vi.spyOn(CodingResultRegistry, "create").mockRejectedValueOnce(new Error("temporary open failure"));
  const publishing = value.publish(task, output, "done", { ran: 1, passed: 1, failed: 0 }).catch(error => error);
  await expect(value.publish(task, output, "done", { ran: 1, passed: 1, failed: 0 })).rejects.toThrow("grant changed");
  expect(await publishing).toBeInstanceOf(Error);
  expect(value.availability().available).toBe(false); expect((await fs.readdir(value.reviewBase)).length).toBe(1);
  await expect(value.publish(task, output, "done", { ran: 1, passed: 1, failed: 0 })).rejects.toThrow("grant changed");
  await (await value.results()).reset();
  expect(create).toHaveBeenCalledTimes(2); expect(await fs.readdir(value.reviewBase)).toEqual([]);
  expect(value.availability().available).toBe(true); await workspace.close();
});

resourceIt("keeps only a blocked cleanup receipt when failed publication output is unsafe, then retries project Forget", async () => {
  const value = await open(); await ready(value); await bind(value);
  const task = spec(value), workspace = await value.createWorkspace(task, new AbortController().signal, () => true);
  const output = await workspace.exportReview(value.reviewBase), extra = path.join(output.directory, "unknown.txt");
  await fs.writeFile(extra, "keep");
  await expect(value.publish(task, output, "done", { ran: 1, passed: 1, failed: 0 })).rejects.toThrow();
  expect(value.availability().available).toBe(false); expect(await fs.readFile(extra, "utf8")).toBe("keep");
  await expect((await value.results()).forgetProject(P)).rejects.toThrow("retained");
  await fs.unlink(extra); await (await value.results()).forgetProject(P);
  expect(value.availability().available).toBe(true); expect(await fs.readdir(value.reviewBase)).toEqual([]);
  await workspace.close();
});

resourceIt("removes one private result through the lazy facade without treating a stale id as uncertain cleanup", async () => {
  const value = await open(); await ready(value); await bind(value);
  const task = spec(value), workspace = await value.createWorkspace(task, new AbortController().signal, () => true);
  const output = await workspace.exportReview(value.reviewBase);
  const published = await value.publish(task, output, "done", { ran: 1, passed: 1, failed: 0 });
  const results = await value.results(); await results.forgetResult(published.id);
  expect(results.state(P)).toEqual([]); expect(await fs.readdir(value.reviewBase)).toEqual([]);
  await expect(results.forgetResult(published.id)).rejects.toMatchObject({ code: "stale" });
  expect(value.availability().available).toBe(true); await workspace.close();
});

resourceIt("shares backend close, removes only known empty directories and leaves unknown leftovers private", async () => {
  const value = await open(); await ready(value); await bind(value);
  const workspace = await value.createWorkspace(spec(value), new AbortController().signal, () => true);
  const a = workspace.close(), b = workspace.close(); expect(a).toBe(b); await a;
  expect(backends[0].close).toHaveBeenCalledTimes(1);
  const root = path.dirname(value.reviewBase), unknown = path.join(root, "unknown.txt"); await fs.writeFile(unknown, "keep\n", { mode: 0o600 });
  await expect(value.close()).rejects.toThrow("retained");
  expect(await fs.readFile(unknown, "utf8")).toBe("keep\n");
});

resourceIt("removes a fully known empty process directory while leaving the shared common parent for other instances", async () => {
  const value = await open(); await ready(value);
  const root = path.dirname(value.reviewBase), common = path.dirname(root);
  await value.close(); await expect(fs.lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await fs.stat(common)).mode & 0o777).toBe(0o700);
});

it("keeps unsupported-platform folder metadata and empty result reset usable without touching native storage", async () => {
  vi.resetModules(); vi.doMock("../../app/main/platform/os", () => ({ HOST_PLATFORM: "win32", HOST_ARCH: "x64" }));
  const { ProjectCodingResources: Unsupported } = await import("../../app/main/agent/coding-resources");
  const value = await Unsupported.create(options); resources.push(value);
  expect(value.availability().available).toBe(false); expect(value.availability().message).toContain("metadata only");
  const folder = await value.validateSource({ path: source, current: () => true });
  value.folders.bind(P, folder, value.folders.ownerCurrent(P)); expect(value.folders.state(P)).toMatchObject({ path: source, valid: true });
  const results = await value.results(); await results.reset(); await results.forgetProject(P); await results.forgetResult("unknown");
  expect(results.state(P)).toEqual([]); expect(await results.review("unknown")).toBeNull();
  expect((await results.export("unknown", source, () => true)).ok).toBe(false);
  expect(sim.discover).not.toHaveBeenCalled(); expect(sim.create).not.toHaveBeenCalled();
});

resourceIt("allocates only in the same selected storage base already registered with desktop gates", async () => {
  const storage = selectCodingStorageBase();
  const replacement = path.join(temp, "other-temporary"); await fs.mkdir(replacement, { mode: 0o700 });
  vi.mocked(os.tmpdir).mockReturnValue(replacement);
  const value = await open({ storage }); await ready(value);
  expect(value.reviewBase.startsWith(storage.common! + path.sep)).toBe(true);
  expect(await fs.readdir(replacement)).toEqual([]);
});

resourceIt("does not allocate storage if the shared canonical selection was unavailable", async () => {
  const value = await open({ storage: Object.freeze({ common: null, protectedPaths: Object.freeze([path.join(temporary, "unresolved-coding")]) }) });
  expect(value.availability().available).toBe(false);
  expect(sim.discover).not.toHaveBeenCalled();
  expect(await fs.readdir(temporary)).toEqual([]);
});
