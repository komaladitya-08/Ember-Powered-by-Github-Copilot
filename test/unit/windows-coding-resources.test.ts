/** Portable ownership/ordering model only. Real NTFS behavior belongs to the dedicated Windows integration lane. */
import fs from "node:fs";
import path from "node:path/win32";
import { createHash, randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { WindowsCodingNative, WindowsCodingInfo } from "../../app/main/agent/windows-coding-native";
import type { WindowsProjectCodingResources } from "../../app/main/agent/windows-coding-resources";
import type { WindowsFileOnlyWorkspaceInput } from "../../app/main/agent/windows-file-only-workspace";
import type { CodingArtifactStore, CodingArtifactFiles, CodingArtifactInput, CodingArtifactReceipt, CodingArtifactRef, CodingArtifactSourceRef } from "../../app/main/agent/coding-artifact-store";
import type { CodingWorkspaceReview } from "../../app/main/agent/coding-platform";
import type { ProjectCodingWorkspaces } from "../../app/main/agent/project-coding-workspaces";
import type { TaskSpec } from "../../app/main/agent/worker";
import type { CodingWorkspaceContinuation } from "../../app/main/agent/coding-seed-snapshot";
import type { CodingExportInput, CodingExportTree } from "../../app/main/agent/coding-result-export";

type ContinuedWorkspaceInput = Omit<WindowsFileOnlyWorkspaceInput, "review"> & { continuation?: CodingWorkspaceContinuation;
  review: WindowsFileOnlyWorkspaceInput["review"] & { sourceBoundary?: CodingArtifactSourceRef } };

const A = "a".repeat(64), B = "b".repeat(64), P = "11111111-1111-4111-8111-111111111111", Q = "22222222-2222-4222-8222-222222222222";
const COMMON = "C:\\temporary\\ember-coding", SOURCE = "C:\\project", SECOND = "C:\\second-project";
const volume = "\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\";
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const owners: WindowsProjectCodingResources[] = [];
afterEach(async () => {
  await Promise.all(owners.splice(0).map(owner => owner.close().catch(() => undefined)));
  vi.restoreAllMocks();
  for (const name of ["platform/os", "agent/windows-coding-native", "agent/windows-coding-artifact-store", "agent/windows-file-only-workspace", "agent/coding-privacy-scanner", "agent/coding-toolchain"])
    vi.doUnmock(`../../app/main/${name}`);
  vi.resetModules();
});

async function setup(options: { existingCommon?: boolean; unknownChildren?: number } = {}) {
  vi.resetModules();
  vi.doMock("../../app/main/platform/os", () => ({ HOST_PLATFORM: "win32", HOST_ARCH: "x64" }));
  const native = await import("../../app/main/agent/windows-coding-native");
  const { ScopedCodingFileError } = await import("../../app/main/agent/coding-platform");
  const errors = await import("../../app/main/agent/coding-artifact-store");
  const privacy = await import("../../app/main/agent/coding-privacy-scanner");
  const { createCodingReviewExport } = await import("../../app/main/agent/coding-result-export");
  let next = 1n, clock = 1, poisoned = false, failClose = false;
  let owner: string | null = A, ownerEpoch = 0, privacyEpoch = 0;
  const projects = new Set([P, Q]), events: string[] = [], removed: string[] = [], closed: bigint[] = [];
  const scopes = new WeakMap<object, number>();
  interface Node { logical: string; info: WindowsCodingInfo; private: boolean }
  interface Handle { row: Node; capability: "read" | "base" | "copy"; parent?: bigint; root?: Node }
  const nodes = new Map<string, Node>(), handles = new Map<bigint, Handle>();
  const key = (value: string) => value.toLowerCase();
  const location = (value: string) => volume + value.slice(3);
  const node = (logical: string, kind: "file" | "directory" = "directory", privateObject = false): Node => {
    const row: Node = { logical, private: privateObject, info: { id: String(next++), volume: volume.toLowerCase(), finalPath: location(logical),
      kind, attributes: kind === "directory" ? 0x10 : 0x20, links: 1, size: 0, created: String(clock++), written: String(clock++), changed: String(clock++) } };
    nodes.set(key(logical), row); return row;
  };
  for (const directory of ["C:\\", "C:\\temporary", "C:\\data", "C:\\application", SOURCE, SECOND]) node(directory);
  if (options.existingCommon || options.unknownChildren) {
    node(COMMON, "directory", true);
    for (let index = 0; index < (options.unknownChildren ?? 0); index++) node(path.join(COMMON, `unknown-${index}`), "directory", true);
  }
  const value = (handle: bigint) => {
    if (poisoned) throw new native.WindowsCodingCleanupError();
    const selected = handles.get(handle);
    if (!selected || nodes.get(key(selected.row.logical)) !== selected.row) throw new ScopedCodingFileError("boundary");
    return selected;
  };
  const token = (row: Node, capability: Handle["capability"], parent?: bigint, root?: Node) => {
    const handle = next++; handles.set(handle, { row, capability, parent, root }); return handle;
  };
  const api: WindowsCodingNative = {
    ownerSid: "S-1-5-21-1001",
    pin(absolute, mode) {
      if (!/^[A-Za-z]:\\/.test(absolute) || path.normalize(absolute) !== absolute) throw new ScopedCodingFileError("path");
      const selected = nodes.get(key(absolute));
      if (!selected || selected.info.kind !== "directory") throw new ScopedCodingFileError(selected ? "unsupported" : "missing");
      const chain: bigint[] = [token(nodes.get(key("C:\\"))!, "read")]; let prefix = "C:\\";
      for (const part of absolute.slice(3).split("\\").filter(Boolean)) {
        prefix = path.join(prefix, part); const row = nodes.get(key(prefix));
        if (!row || row.info.kind !== "directory") throw new ScopedCodingFileError("missing");
        chain.push(token(row, key(prefix) === key(absolute) && mode === "base" ? "base" : "read"));
      }
      return { path: absolute, handles: chain, handle: chain[chain.length - 1] };
    },
    info: handle => ({ ...value(handle).row.info }),
    list(handle, maximum) {
      const parent = value(handle).row.logical, children = [...nodes.values()].filter(row => row.logical !== parent && key(path.dirname(row.logical)) === key(parent));
      if (children.length > maximum) throw new ScopedCodingFileError("limit");
      return children.map(row => ({ name: path.basename(row.logical), id: row.info.id, attributes: row.info.attributes, size: row.info.size }));
    },
    open(parent, name, kind, mode) {
      const base = value(parent), row = nodes.get(key(path.join(base.row.logical, name)));
      if (mode === "copy" && base.capability !== "copy") throw new ScopedCodingFileError("boundary");
      if (!row || row.info.kind !== kind) throw new ScopedCodingFileError("missing");
      return token(row, mode === "copy" ? "copy" : "read", parent, mode === "copy" ? base.root : undefined);
    },
    create(parent, name, kind) {
      const base = value(parent);
      if (base.capability === "read" || base.capability === "base" && kind !== "directory") throw new ScopedCodingFileError("boundary");
      const logical = path.join(base.row.logical, name); if (nodes.has(key(logical))) throw new ScopedCodingFileError("exists");
      const row = node(logical, kind, true); events.push(`native-create:${logical}`);
      return token(row, "copy", parent, base.capability === "base" ? row : base.root);
    },
    read() { throw new Error("Resource ownership does not read project contents."); },
    write() { throw new Error("Resource ownership does not write project contents."); },
    flush() { throw new Error("No path-based recovery marker is created."); },
    replace() { throw new Error("Resource ownership never renames source files."); },
    remove(handle) {
      const selected = value(handle);
      if (selected.capability !== "copy" || selected.parent === undefined || !handles.has(selected.parent)) throw new ScopedCodingFileError("boundary");
      if ([...nodes.values()].some(row => row !== selected.row && key(path.dirname(row.logical)) === key(selected.row.logical))) throw new ScopedCodingFileError("not-empty");
      nodes.delete(key(selected.row.logical)); removed.push(selected.row.logical); events.push(`native-remove:${selected.row.logical}`);
    },
    assertPrivate(handle) { const selected = value(handle); if (selected.capability !== "copy" || !selected.row.private) throw new ScopedCodingFileError("boundary"); },
    close(handle) {
      closed.push(handle);
      if (failClose) { failClose = false; throw new native.WindowsCodingCleanupError(); }
      if (!handles.delete(handle)) throw new ScopedCodingFileError("boundary");
    },
  };
  const realpath = fs.realpathSync.native;
  vi.spyOn(fs.realpathSync, "native").mockImplementation(((file, ...args) => typeof file === "string" && /^[A-Za-z]:\\/.test(file)
    ? path.normalize(file) : Reflect.apply(realpath, fs.realpathSync, [file, ...args])) as typeof realpath);
  vi.doMock("../../app/main/agent/windows-coding-native", () => ({ ...native, loadWindowsCodingNative: () => api,
    retireWindowsCodingNative: () => { poisoned = true; return new native.WindowsCodingCleanupError(); } }));
  const retirePrivacy = vi.fn(async () => { privacyEpoch++; });
  vi.doMock("../../app/main/agent/coding-privacy-scanner", () => ({ ...privacy,
    captureCodingPrivacyScope() { const scope = Object.freeze({}); scopes.set(scope, privacyEpoch); return scope; },
    assertCodingPrivacyScope(scope: object) { if (scopes.get(scope) !== privacyEpoch) throw new privacy.CodingPrivacyScanError("stale"); },
    retireCodingPrivacyScanners: retirePrivacy, codingPrivacyCleanupFailure: () => null }));
  const discover = vi.fn(() => { throw new Error("Files-only resources must not discover command tools."); });
  vi.doMock("../../app/main/agent/coding-toolchain", () => ({ discoverCodingToolchain: discover }));

  let claimGate: ReturnType<typeof deferred<void>> | undefined, storeGate: ReturnType<typeof deferred<void>> | undefined;
  const claimEntered = deferred<void>(), storeEntered = deferred<void>();
  class Store implements CodingArtifactStore {
    base = "";
    records = new Map<CodingArtifactRef, { input: CodingArtifactInput; receipt?: CodingArtifactReceipt; files: CodingArtifactFiles; claimed: boolean }>();
    removed = new WeakMap<CodingArtifactRef, string>();
    sources = new WeakMap<CodingArtifactSourceRef, { path: string; id: string }>();
    exports = new Set<string>();
    cleanupFailures = 0;
    closed = false;
    get size() { return this.records.size; }
    validSourcePath(source: string) { return /^[A-Za-z]:\\/.test(source); }
    async write(files: CodingArtifactFiles, check: () => void) {
      check(); const artifact = Object.freeze({}) as CodingArtifactRef, directory = path.join(this.base, `artifact-${randomUUID()}`);
      node(directory, "directory", true); const input = Object.freeze({ directory, artifact });
      this.records.set(artifact, { input, files: { "changes.patch": Buffer.from(files["changes.patch"]), "review.json": Buffer.from(files["review.json"]) }, claimed: false });
      events.push("artifact-write"); check(); return input;
    }
    async claim(input: CodingArtifactInput, check: () => void) {
      events.push("artifact-claim"); claimEntered.resolve(); if (claimGate) await claimGate.promise; check();
      const record = input.artifact && this.records.get(input.artifact);
      if (!record || record.input.directory !== input.directory || record.claimed) throw new errors.CodingResultRegistryError("invalid");
      record.claimed = true;
      const files = Object.fromEntries(Object.entries(record.files).map(([name, bytes]) => [name, { bytes: bytes.length, sha256: hash(bytes) }])) as CodingArtifactReceipt["files"];
      record.receipt = Object.freeze({ ref: input.artifact!, directory: input.directory, bytes: Object.values(record.files).reduce((sum, bytes) => sum + bytes.length, 0), files });
      return record.receipt;
    }
    async verify(receipt: CodingArtifactReceipt, check: () => void) { check(); if (this.records.get(receipt.ref)?.receipt !== receipt) throw new errors.CodingResultRegistryError("artifact"); }
    async read(receipt: CodingArtifactReceipt, name: keyof CodingArtifactFiles, maximum: number, check: () => void) {
      await this.verify(receipt, check); const bytes = this.records.get(receipt.ref)!.files[name];
      if (bytes.length > maximum) throw new errors.CodingResultRegistryError("limit"); return Buffer.from(bytes);
    }
    async sourceBoundary(source: string, check: () => void, expected?: CodingArtifactSourceRef) {
      check(); const selected = nodes.get(key(source)); if (!selected) return null;
      if (expected) {
        const captured = this.sources.get(expected);
        if (!captured || captured.path !== source || captured.id !== selected.info.id) throw new errors.CodingResultRegistryError("stale");
        return expected;
      }
      const ref = Object.freeze({}) as CodingArtifactSourceRef; this.sources.set(ref, { path: source, id: selected.info.id }); return ref;
    }
    async sameSource(first: CodingArtifactSourceRef | null, second: CodingArtifactSourceRef | null, check: () => void) {
      check(); return !!first && !!second && this.sources.get(first)?.id === this.sources.get(second)?.id;
    }
    async export(receipt: CodingArtifactReceipt, source: CodingArtifactSourceRef | null, destination: string, check: () => void) {
      await this.verify(receipt, check); if (!source || !this.sources.has(source)) throw new errors.CodingResultRegistryError("destination");
      const directory = path.join(destination, `export-${randomUUID()}`); this.exports.add(directory); return { ok: true, message: "Exported fixture.", directory };
    }
    async discard(input: CodingArtifactInput) {
      events.push("artifact-discard");
      if (input.artifact && this.removed.get(input.artifact) === input.directory) return;
      const record = input.artifact && this.records.get(input.artifact);
      if (!record || record.input.directory !== input.directory) throw new errors.CodingResultRegistryError("invalid");
      nodes.delete(key(input.directory)); this.records.delete(input.artifact!); this.removed.set(input.artifact!, input.directory);
    }
    async cleanup(retained: ReadonlySet<CodingArtifactRef>) {
      events.push("artifact-cleanup");
      if (this.cleanupFailures) { this.cleanupFailures--; throw new errors.CodingResultRegistryError("cleanup"); }
      for (const [ref, record] of [...this.records]) if (record.claimed && !retained.has(ref)) await this.discard(record.input);
    }
    async close() { events.push("store-close"); for (const record of [...this.records.values()]) await this.discard(record.input); this.closed = true; }
  }
  const store = new Store(), storeCreate = vi.fn(async (input: { privateBase: string }) => {
    storeEntered.resolve(); if (storeGate) await storeGate.promise;
    if (!/^[A-Za-z]:\\/.test(input.privateBase)) throw new errors.CodingResultRegistryError("invalid");
    store.base = input.privateBase; return store;
  });
  vi.doMock("../../app/main/agent/windows-coding-artifact-store", () => ({ WindowsCodingArtifactStore: { create: storeCreate } }));
  interface Backend {
    input: ContinuedWorkspaceInput; executionRoot: string; sourceBoundary: CodingArtifactSourceRef; seed?: CodingWorkspaceContinuation;
    stop: ReturnType<typeof vi.fn<() => Promise<void>>>; close: ReturnType<typeof vi.fn<() => Promise<void>>>;
    sealForReview(): Promise<void>; exportReview(base: string): Promise<CodingWorkspaceReview>; transferReview(output: CodingWorkspaceReview): void;
    files<T>(operation: (directory: string) => Promise<T>): Promise<T>;
    exportGate?: ReturnType<typeof deferred<void>>; closeGate?: ReturnType<typeof deferred<void>>; transferHook?(): void;
    output?: CodingWorkspaceReview; transferred: boolean; sealed: boolean;
  }
  const backends: Backend[] = []; let createGate: ReturnType<typeof deferred<void>> | undefined;
  const createEntered = deferred<void>();
  const createBackend = vi.fn(async (input: ContinuedWorkspaceInput) => {
    if (!/^[A-Za-z]:\\/.test(input.privateBase) || input.protectedPaths.some(value => !/^[A-Za-z]:\\/.test(value))) throw new Error("Adapter paths must be drive spellings.");
    const clone = (tree: CodingExportTree): CodingExportTree => ({ binding: { ...tree.binding }, entries: tree.entries.map(entry => entry.kind === "file" ? { ...entry, bytes: Buffer.from(entry.bytes) } : { ...entry }) });
    // Faithful admission seam: the real Copy owns clones before its first await; source bytes remain caller-owned.
    const seed = input.continuation ? { ...input.continuation, baseline: clone(input.continuation.baseline), proposed: clone(input.continuation.proposed) } : undefined;
    const check = () => { if (!input.current()) throw new errors.CodingResultRegistryError("stale"); };
    const sourceBoundary = await store.sourceBoundary(input.source, check, input.review.sourceBoundary);
    if (!sourceBoundary) throw new errors.CodingResultRegistryError("artifact");
    const fresh = await store.sourceBoundary(input.source, check);
    if (!await store.sameSource(sourceBoundary, fresh, check)) throw new errors.CodingResultRegistryError("stale");
    const directory = path.join(input.privateBase, `copy-${randomUUID()}`); node(directory, "directory", true);
    let exporting: Promise<CodingWorkspaceReview> | undefined;
    const backend: Backend = { input, seed, executionRoot: "/work", sourceBoundary, transferred: false, sealed: false,
      stop: vi.fn(async () => { events.push("backend-stop"); }),
      close: vi.fn(async () => {
        events.push("backend-close"); if (backend.closeGate) await backend.closeGate.promise;
        await exporting?.catch(() => undefined);
        if (backend.output && !backend.transferred) await store.discard(backend.output);
        for (const tree of [backend.seed?.baseline, backend.seed?.proposed]) for (const entry of tree?.entries ?? []) if (entry.kind === "file") entry.bytes.fill(0);
        backend.seed = undefined;
        nodes.delete(key(directory));
      }),
      async sealForReview() { await backend.stop(); backend.sealed = true; },
      exportReview(base) {
        if (base !== input.reviewBase || !backend.sealed || !input.review.current()) return Promise.reject(new errors.CodingResultRegistryError("stale"));
        return exporting ??= (async () => {
          const binding = input.review.binding, tree = (text: string) => ({ binding, entries: [{ path: "app.ts", kind: "file" as const, bytes: Buffer.from(text), executable: false }] });
          const rendered = createCodingReviewExport({ binding, baseline: tree("original\n"), proposed: tree("changed\n"), current: tree("original\n") });
          const artifact = await store.write({ "changes.patch": Buffer.from(rendered.review.textPatch), "review.json": Buffer.from(JSON.stringify(rendered.review, null, 2)) }, () => {
            if (!input.review.current()) throw new errors.CodingResultRegistryError("stale");
          });
          backend.output = Object.freeze({ ...artifact, review: rendered.review, cleanup: "complete" });
          if (backend.exportGate) await backend.exportGate.promise; return backend.output;
        })();
      },
      transferReview(output) {
        if (output !== backend.output || backend.transferred) throw new errors.CodingResultRegistryError("invalid");
        events.push("producer-transfer"); backend.transferred = true; backend.transferHook?.();
      },
      async files<T>(operation: (root: string) => Promise<T>) { if (!input.current()) throw new ScopedCodingFileError("cancelled"); return operation(directory); },
    };
    backends.push(backend); createEntered.resolve(); if (createGate) await createGate.promise; return backend;
  });
  vi.doMock("../../app/main/agent/windows-file-only-workspace", () => ({ WindowsFileOnlyWorkspace: { create: createBackend } }));
  interface Selection { path: string; id: string; owner: string | null; epoch: number; live: boolean }
  const selections = new Map<string, Selection>();
  const folders = {
    capture: vi.fn((projectId: string) => {
      const selected = selections.get(projectId); if (!selected || selected.owner !== owner || selected.epoch !== ownerEpoch || !projects.has(projectId) || !selected.live) return null;
      return { path: selected.path, current: () => selections.get(projectId) === selected && nodes.get(key(selected.path))?.info.id === selected.id && selected.owner === owner && selected.epoch === ownerEpoch && selected.live && projects.has(projectId) };
    }),
    ownerCurrent: vi.fn(() => { const selected = owner, epoch = ownerEpoch; return () => owner !== null && selected === owner && epoch === ownerEpoch; }),
    ownerReset: vi.fn(() => { ownerEpoch++; selections.clear(); }),
  };
  const { WindowsProjectCodingResources } = await import("../../app/main/agent/windows-coding-resources");
  const { CodingResultRegistry } = await import("../../app/main/agent/coding-result-registry");
  const changed = vi.fn();
  const open = async () => {
    const value = await WindowsProjectCodingResources.create({ userData: "C:\\data", protectedPaths: ["C:\\data", "C:\\application"],
      currentOwner: () => owner, projectExists: id => projects.has(id), env: { GH_TOKEN: "never-forward", NODE_OPTIONS: "never-forward" },
      execPath: "C:\\application\\Ember.exe", isElectron: true, changed, folders: folders as unknown as ProjectCodingWorkspaces,
      storage: { common: COMMON, protectedPaths: [COMMON] } });
    owners.push(value); return value;
  };
  const bind = async (value: WindowsProjectCodingResources, projectId = P, source = SOURCE) => {
    const selected = await value.validateSource({ path: source, current: () => true });
    selections.set(projectId, { path: selected.path, id: nodes.get(key(selected.path))!.info.id, owner, epoch: ownerEpoch, live: true });
  };
  const spec = (value: WindowsProjectCodingResources, projectId = P): TaskSpec => {
    const workspace = value.workspace(projectId); expect(workspace).not.toBeNull();
    return { id: randomUUID(), goal: "Repair the private copied file", target: {}, codingWorkspace: workspace! };
  };
  const start = async (value: WindowsProjectCodingResources, projectId = P) => {
    const task = spec(value, projectId), controller = new AbortController();
    return { task, controller, workspace: await value.createWorkspace(task, controller.signal, () => true) };
  };
  const review = async (value: WindowsProjectCodingResources, workspace: Awaited<ReturnType<typeof start>>["workspace"]) => {
    await workspace.sealForReview?.(); return workspace.exportReview(value.reviewBase);
  };
  return { open, bind, spec, start, review, api, nodes, handles, node, key, location, removed, closed, events, backends, store, storeCreate, discover, changed, folders, projects,
    createBackend, createEntered, storeEntered, claimEntered, errors, native, retirePrivacy, CodingResultRegistry,
    setOwner(value: string | null) { owner = value; folders.ownerReset(); },
    failNextClose() { failClose = true; }, gateCreate() { return createGate = deferred<void>(); }, gateStore() { return storeGate = deferred<void>(); }, gateClaim() { return claimGate = deferred<void>(); },
  };
}

it("uses only files/review resources and supplied folder metadata, without discovering or exposing command tools", async () => {
  const f = await setup(), value = await f.open();
  expect(value.availability()).toMatchObject({ available: true, mode: "files-only", canContinue: true });
  expect(value.availability()).not.toHaveProperty("nodePath"); expect(value.folders).toBe(f.folders); expect(f.discover).not.toHaveBeenCalled();
  expect(value.availability().message).toContain("Commands, tests and dependency installation are unavailable");
  expect((await value.results()).state(P)).toEqual([]); expect(f.storeCreate).not.toHaveBeenCalled();
  await f.bind(value); const task = await f.start(value);
  expect(task.workspace).not.toHaveProperty("run"); expect(f.backends[0].input).not.toHaveProperty("env");
  expect(f.backends[0].input).not.toHaveProperty("nodePath"); expect(f.backends[0].input.scope).toEqual({ excludeRoots: [".git", "node_modules"] });
});

it.each([0, 2])("retains any pre-existing common root and its %s unknown children without adoption or deletion", async unknownChildren => {
  const f = await setup({ existingCommon: true, unknownChildren }), value = await f.open();
  expect(value.availability().available).toBe(false); expect(value.availability().message).toMatch(/Earlier|retained/i);
  await value.close().catch(() => undefined); expect(f.removed).toEqual([]); expect(f.nodes.has(f.key(COMMON))).toBe(true); expect(f.createBackend).not.toHaveBeenCalled();
});

it("removes only its fresh common/copy/review roots after successful cleanup and leaves original/protected directories intact", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); const task = await f.start(value);
  await task.workspace.close(); await value.close();
  expect(f.nodes.has(f.key(COMMON))).toBe(false); expect(f.removed.at(-1)).toBe(COMMON);
  for (const source of [SOURCE, "C:\\data", "C:\\application"]) expect(f.nodes.has(f.key(source))).toBe(true);
  expect(f.handles.size).toBe(0);
});

it("uses native GUID receipts for identity while keeping selected drive spellings at public/API boundaries", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value);
  expect(value.workspace(P)?.path).toBe(SOURCE); expect(value.reviewBase).toMatch(/^C:\\/);
  const task = await f.start(value); expect(f.backends[0].input.source).toBe(SOURCE);
  expect(f.backends[0].input.protectedPaths.every(item => /^[A-Za-z]:\\/.test(item))).toBe(true);
  await task.workspace.close();
});

it("refuses protected/private overlap and a source with a protected root's native identity", async () => {
  const f = await setup(), value = await f.open();
  for (const selected of ["C:\\data", "C:\\application", "C:\\temporary", COMMON, value.reviewBase])
    await expect(value.validateSource({ path: selected, current: () => true })).rejects.toThrow();
  f.nodes.get(f.key(SOURCE))!.info.id = f.nodes.get(f.key("C:\\data"))!.info.id;
  await expect(value.validateSource({ path: SOURCE, current: () => true })).rejects.toThrow(); expect(f.createBackend).not.toHaveBeenCalled();
});

it("requires exact task/output identities and publishes the transferred artifact/source capability only once", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); const task = await f.start(value), output = await f.review(value, task.workspace);
  await expect(value.publish({ ...task.task }, output, "done", { ran: 0, passed: 0, failed: 0 })).rejects.toThrow();
  await expect(value.publish(task.task, { ...output }, "done", { ran: 0, passed: 0, failed: 0 })).rejects.toThrow();
  const summary = await value.publish(task.task, output, "done", { ran: 0, passed: 0, failed: 0 });
  expect(summary).toMatchObject({ projectId: P, sourcePath: SOURCE, checks: { ran: 0, passed: 0, failed: 0 } });
  expect(f.events.indexOf("producer-transfer")).toBeLessThan(f.events.indexOf("artifact-claim"));
  await expect(value.publish(task.task, output, "done", { ran: 0, passed: 0, failed: 0 })).rejects.toThrow();
  expect((await value.results()).state(P)).toHaveLength(1);
});

it("records a producer before synchronous transfer can trigger global cleanup", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); const task = await f.start(value);
  let closing: Promise<void> | undefined; f.backends[0].transferHook = () => { closing = value.close(); };
  await f.review(value, task.workspace); await closing;
  expect(f.events).toContain("artifact-discard"); expect(f.store.records.size).toBe(0); expect(f.nodes.has(f.key(COMMON))).toBe(false);
});

it("can publish an inert stopped review after the folder changes while ordinary file authority stays revoked", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); const task = await f.start(value);
  task.controller.abort(); await task.workspace.stop(); await f.bind(value, P, SECOND);
  expect(f.backends[0].input.current()).toBe(false); expect(f.backends[0].input.review.current()).toBe(true);
  const output = await f.review(value, task.workspace), summary = await value.publish(task.task, output, "stopped", { ran: 0, passed: 0, failed: 0 });
  expect(summary).toMatchObject({ sourcePath: SOURCE, status: "stopped" });
});

it("refuses old publication after owner replacement and return to the same account", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); const task = await f.start(value), output = await f.review(value, task.workspace);
  f.setOwner(B); f.setOwner(A); expect(f.backends[0].input.review.current()).toBe(false);
  await expect(value.publish(task.task, output, "done", { ran: 0, passed: 0, failed: 0 })).rejects.toThrow();
  expect((await value.results()).state(P)).toEqual([]); expect(f.store.records.size).toBe(0);
});

it("retires only a forgotten project's publication while preserving another project's result", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); await f.bind(value, Q, SECOND);
  const first = await f.start(value), second = await f.start(value, Q);
  const a = await f.review(value, first.workspace), b = await f.review(value, second.workspace), results = await value.results();
  await results.forgetProject(P);
  await expect(value.publish(first.task, a, "done", { ran: 0, passed: 0, failed: 0 })).rejects.toThrow();
  const summary = await value.publish(second.task, b, "done", { ran: 0, passed: 0, failed: 0 });
  expect(results.state(P)).toEqual([]); expect(results.state(Q).map(item => item.id)).toEqual([summary.id]);
});

it("synchronously revokes a queued publication when result reset races artifact claim", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); const task = await f.start(value), output = await f.review(value, task.workspace), gate = f.gateClaim();
  const publishing = value.publish(task.task, output, "done", { ran: 0, passed: 0, failed: 0 }).catch(error => error);
  await f.claimEntered.promise; const resetting = (await value.results()).reset(); gate.resolve();
  expect(await publishing).toBeInstanceOf(Error); await resetting;
  expect((await value.results()).state(P)).toEqual([]); expect(f.store.records.size).toBe(0);
});

it("drains a delayed store opening before close and never admits its stale backend", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); const gate = f.gateStore();
  const creating = value.createWorkspace(f.spec(value), new AbortController().signal, () => true).catch(error => error);
  await f.storeEntered.promise; let closed = false; const closing = value.close().then(() => { closed = true; });
  await Promise.resolve(); expect(closed).toBe(false); expect(f.store.closed).toBe(false);
  gate.resolve(); expect(await creating).toBeInstanceOf(Error); await closing;
  expect(f.createBackend).not.toHaveBeenCalled(); expect(f.store.closed).toBe(true);
});

it("closes a late-created backend exactly once before invalidation completes", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); const gate = f.gateCreate();
  const creating = value.createWorkspace(f.spec(value), new AbortController().signal, () => true).catch(error => error);
  await f.createEntered.promise; let done = false; const invalidating = value.invalidate().then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false); gate.resolve(); expect(await creating).toBeInstanceOf(Error); await invalidating;
  expect(f.backends[0].close).toHaveBeenCalledOnce(); expect(f.backends[0].stop).toHaveBeenCalledOnce();
});

it("drains an in-flight export and reclaims its late transferred capability before removing private roles", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); const task = await f.start(value), gate = deferred<void>();
  await task.workspace.sealForReview?.(); f.backends[0].exportGate = gate;
  const exporting = task.workspace.exportReview(value.reviewBase); await vi.waitFor(() => expect(f.store.size).toBe(1));
  let done = false; const closing = value.close().then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
  gate.resolve(); await exporting; await closing;
  expect(f.store.size).toBe(0); expect(f.events.indexOf("artifact-discard")).toBeLessThan(f.events.findIndex(event => event.startsWith("native-remove:")));
});

it("keeps ordinary artifact-cleanup failure retryable without retiring native storage", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); const task = await f.start(value), output = await f.review(value, task.workspace);
  await value.publish(task.task, output, "done", { ran: 0, passed: 0, failed: 0 }); await task.workspace.close(); f.store.cleanupFailures = 1;
  await expect((await value.results()).reset()).rejects.toThrow(); expect(value.availability().available).toBe(false);
  expect(value.availability().message).toContain("Retry Forget everything"); await value.invalidate(); expect(value.availability().available).toBe(true);
});

it("forgets one private result while retaining project selection and completed user exports", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); const task = await f.start(value), output = await f.review(value, task.workspace);
  const result = await value.publish(task.task, output, "done", { ran: 0, passed: 0, failed: 0 }); await task.workspace.close();
  const results = await value.results(), exported = await results.export(result.id, "C:\\exports", () => true);
  expect(exported.ok).toBe(true); await results.forgetResult(result.id);
  expect(results.state(P)).toEqual([]); expect(value.workspace(P)?.path).toBe(SOURCE); expect(f.store.exports.has(exported.directory!)).toBe(true);
});

it("does not let a missing-result error poison future copied-file work", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); const task = await f.start(value), output = await f.review(value, task.workspace);
  await value.publish(task.task, output, "done", { ran: 0, passed: 0, failed: 0 });
  await expect((await value.results()).forgetResult("missing-result")).rejects.toBeInstanceOf(f.errors.CodingResultRegistryError);
  expect(value.availability().available).toBe(true);
});

it("makes unknown native cleanup terminal, retains its owned roots and blocks a new resource owner", async () => {
  const f = await setup(), value = await f.open(); f.failNextClose();
  await expect(value.validateSource({ path: SOURCE, current: () => true })).rejects.toBeInstanceOf(f.native.WindowsCodingCleanupError);
  expect(value.availability().available).toBe(false); await expect(value.invalidate()).rejects.toThrow("retained");
  expect(f.removed).toEqual([]); expect(f.nodes.has(f.key(COMMON))).toBe(true);
  const next = await f.open(); expect(next.availability().available).toBe(false); expect(f.createBackend).not.toHaveBeenCalled();
});

it.each([null, Object.freeze({})])("refuses a missing/forged predecessor capability instead of recapturing the original folder", async continuation => {
  const f = await setup(), value = await f.open(); await f.bind(value); const task = f.spec(value);
  task.codingWorkspace = { ...task.codingWorkspace!, continuation: continuation as NonNullable<TaskSpec["codingWorkspace"]>["continuation"] };
  await expect(value.createWorkspace(task, new AbortController().signal, () => true)).rejects.toThrow("changed");
  expect(value.captureContinuation("old-result", P)).toBeNull(); expect(value.continuationCurrent(Object.freeze({}) as never, P)).toBe(false);
  expect(f.createBackend).not.toHaveBeenCalled();
});

async function predecessor(f: Awaited<ReturnType<typeof setup>>, value: WindowsProjectCodingResources) {
  const first = await f.start(value), output = await f.review(value, first.workspace);
  const result = await value.publish(first.task, output, "stopped", { ran: 0, passed: 0, failed: 0 }); await first.workspace.close();
  const ref = value.captureContinuation(result.id, P); expect(ref).not.toBeNull();
  const task = f.spec(value); task.codingWorkspace = { ...task.codingWorkspace!, continuation: ref! };
  return { result, ref: ref!, task };
}
function treeText(tree: CodingExportTree | undefined): string | undefined { const entry = tree?.entries[0]; return entry?.kind === "file" ? entry.bytes.toString() : undefined; }
function treeBytes(input: CodingExportInput): Buffer[] { return [input.baseline, input.proposed, input.current].flatMap(tree => tree?.entries.flatMap(entry => entry.kind === "file" ? [entry.bytes] : []) ?? []); }

it("loads an opaque predecessor through its original same-store source boundary and hands complete independent trees to the fresh copy", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); const previous = await predecessor(f, value);
  const load = vi.spyOn(f.CodingResultRegistry.prototype, "loadContinuation"), workspace = await value.createWorkspace(previous.task, new AbortController().signal, () => true);
  expect(load).toHaveBeenCalledOnce(); const [ref, projectId, boundary, current] = load.mock.calls[0];
  expect(ref).toBe(previous.ref); expect(projectId).toBe(P); expect(boundary).toBe(f.backends[1].input.review.sourceBoundary); expect(current()).toBe(true);
  expect(f.backends[1].sourceBoundary).toBe(boundary); expect(treeText(f.backends[1].seed?.baseline)).toBe("original\n");
  expect(treeText(f.backends[1].seed?.proposed)).toBe("changed\n");
  const decoded = await load.mock.results[0].value as CodingExportInput;
  expect(treeBytes(decoded).every(bytes => bytes.every(byte => byte === 0))).toBe(true);
  expect(f.backends[1].seed?.proposed.entries[0]).not.toBe(decoded.proposed.entries[0]);
  expect(value.availability()).toMatchObject({ canContinue: true, mode: "files-only" }); await workspace.close();
});

it("forgets the predecessor after admission without revoking the independent new copy or its result", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); const previous = await predecessor(f, value);
  const workspace = await value.createWorkspace(previous.task, new AbortController().signal, () => true), backend = f.backends[1];
  await (await value.results()).forgetResult(previous.result.id);
  expect(value.continuationCurrent(previous.ref, P)).toBe(false); expect(backend.input.current()).toBe(true); expect(treeText(backend.seed?.proposed)).toBe("changed\n");
  const output = await f.review(value, workspace), result = await value.publish(previous.task, output, "done", { ran: 0, passed: 0, failed: 0 });
  expect((await value.results()).state(P).map(item => item.id)).toEqual([result.id]);
});

it.each(["forget-result", "forget-project", "reset", "owner-aba", "source-replaced", "stop"] as const)("refuses a decoded but still pending predecessor load after %s and wipes all decoded bytes", async change => {
  const f = await setup(), value = await f.open(); await f.bind(value); const previous = await predecessor(f, value);
  const entered = deferred<void>(), gate = deferred<void>(), load = f.CodingResultRegistry.prototype.loadContinuation;
  let decoded: CodingExportInput | undefined;
  vi.spyOn(f.CodingResultRegistry.prototype, "loadContinuation").mockImplementation(async function (this: Awaited<ReturnType<typeof f.CodingResultRegistry.create>>, ...args) {
    decoded = await load.apply(this, args); entered.resolve(); await gate.promise; return decoded;
  });
  const signal = new AbortController(), creating = value.createWorkspace(previous.task, signal.signal, () => true).catch(error => error);
  await entered.promise;
  if (change === "forget-result") await (await value.results()).forgetResult(previous.result.id);
  else if (change === "forget-project") await (await value.results()).forgetProject(P);
  else if (change === "reset") await (await value.results()).reset();
  else if (change === "owner-aba") { f.setOwner(B); f.setOwner(A); }
  else if (change === "source-replaced") f.nodes.get(f.key(SOURCE))!.info.id = "replacement-id";
  else signal.abort();
  gate.resolve(); expect(await creating).toBeInstanceOf(Error); expect(f.createBackend).toHaveBeenCalledTimes(1);
  expect(decoded).toBeDefined(); expect(treeBytes(decoded!).every(bytes => bytes.every(byte => byte === 0))).toBe(true);
});

it("drains and wipes a delayed continuation load before closing private storage", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); const previous = await predecessor(f, value);
  const entered = deferred<void>(), gate = deferred<void>(), load = f.CodingResultRegistry.prototype.loadContinuation;
  let decoded: CodingExportInput | undefined;
  vi.spyOn(f.CodingResultRegistry.prototype, "loadContinuation").mockImplementation(async function (this: Awaited<ReturnType<typeof f.CodingResultRegistry.create>>, ...args) {
    decoded = await load.apply(this, args); entered.resolve(); await gate.promise; return decoded;
  });
  const creating = value.createWorkspace(previous.task, new AbortController().signal, () => true).catch(error => error); await entered.promise;
  let closed = false; const closing = value.close().then(() => { closed = true; }); await Promise.resolve(); expect(closed).toBe(false);
  expect(f.nodes.has(f.key(COMMON))).toBe(true); gate.resolve(); expect(await creating).toBeInstanceOf(Error); await closing;
  expect(treeBytes(decoded!).every(bytes => bytes.every(byte => byte === 0))).toBe(true); expect(f.nodes.has(f.key(COMMON))).toBe(false);
});

it("checks predecessor current through fresh-copy admission, closes a late copy after predecessor Forget, and never falls back", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); const previous = await predecessor(f, value), gate = f.gateCreate();
  const creating = value.createWorkspace(previous.task, new AbortController().signal, () => true).catch(error => error);
  await vi.waitFor(() => expect(f.backends).toHaveLength(2)); await (await value.results()).forgetResult(previous.result.id);
  expect(f.backends[1].input.current()).toBe(false); gate.resolve(); expect(await creating).toBeInstanceOf(Error);
  expect(f.createBackend).toHaveBeenCalledTimes(2); expect(f.backends[1].stop).toHaveBeenCalledOnce(); expect(f.backends[1].close).toHaveBeenCalledOnce();
});

it("refuses a predecessor tied to another source directory even when project selection is explicitly rebound", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); const previous = await predecessor(f, value); await f.bind(value, P, SECOND);
  previous.task.codingWorkspace = { ...value.workspace(P)!, continuation: previous.ref };
  await expect(value.createWorkspace(previous.task, new AbortController().signal, () => true)).rejects.toThrow(); expect(f.createBackend).toHaveBeenCalledTimes(1);
});

it("does not accept a genuine predecessor capability for another project", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); await f.bind(value, Q, SECOND); const previous = await predecessor(f, value);
  const task = f.spec(value, Q); task.codingWorkspace = { ...task.codingWorkspace!, continuation: previous.ref };
  await expect(value.createWorkspace(task, new AbortController().signal, () => true)).rejects.toThrow("changed");
  expect(f.createBackend).toHaveBeenCalledTimes(1); expect(value.captureContinuation(previous.result.id, Q)).toBeNull();
});

it("captures the opaque predecessor before any asynchronous load and ignores later mutation of the task grant", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); const previous = await predecessor(f, value);
  const entered = deferred<void>(), gate = deferred<void>(), load = f.CodingResultRegistry.prototype.loadContinuation;
  vi.spyOn(f.CodingResultRegistry.prototype, "loadContinuation").mockImplementation(async function (this: Awaited<ReturnType<typeof f.CodingResultRegistry.create>>, ...args) {
    const decoded = await load.apply(this, args); entered.resolve(); await gate.promise; return decoded;
  });
  const creating = value.createWorkspace(previous.task, new AbortController().signal, () => true); await entered.promise;
  previous.task.codingWorkspace!.continuation = Object.freeze({}) as never; gate.resolve();
  const workspace = await creating; expect(treeText(f.backends[1].seed?.proposed)).toBe("changed\n"); await workspace.close();
});

it("latches native seed-cleanup uncertainty during continuation admission and retains the private roots", async () => {
  const f = await setup(), value = await f.open(); await f.bind(value); const previous = await predecessor(f, value);
  class WindowsSeedCleanupFailure extends f.native.WindowsCodingCleanupError {}
  f.createBackend.mockRejectedValueOnce(new WindowsSeedCleanupFailure());
  await expect(value.createWorkspace(previous.task, new AbortController().signal, () => true)).rejects.toBeInstanceOf(WindowsSeedCleanupFailure);
  expect(value.availability().available).toBe(false); await expect(value.close()).rejects.toThrow(); expect(f.nodes.has(f.key(COMMON))).toBe(true);
});
