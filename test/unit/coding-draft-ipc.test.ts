/** Explicit Home workflow with real encrypted storage, certified artifact receipts and the actual fixed validation worker. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { registerCodingDraftIpc, type CodingDraftIpc } from "../../app/main/coding-draft-ipc";
import type { CodingDraftImportResult as HostImportResult } from "../../app/main/agent/coding-draft-import";
import type { OpenCodingDraft } from "../../app/main/agent/coding-draft-store";
import type { CodingDraftOwner } from "../../app/main/agent/coding-draft-format";
import { CodingDraftStore } from "../../app/main/agent/coding-draft-store";
import { CodingResultRegistry } from "../../app/main/agent/coding-result-registry";
import { LinuxCodingArtifactStore } from "../../app/main/agent/linux-coding-artifact-store";
import { ProjectCodingWorkspaces } from "../../app/main/agent/project-coding-workspaces";
import { createCodingReviewExport } from "../../app/main/agent/coding-result-export";
import { IPC } from "../../app/shared/ipc";
import type { SecretBox } from "../../app/main/agent/auth";
import type { ProjectSessionsState } from "../../app/shared/project-sessions";
import type { ProjectCodingResourcesPort } from "../../app/main/agent/project-coding-backend";
const A = "a".repeat(64), B = "b".repeat(64), P = "11111111-1111-4111-8111-111111111111";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-draft-home-")), reviews = path.join(dir, "reviews"), source = path.join(dir, "project");
  fs.mkdirSync(reviews, { mode: 0o700 }); fs.mkdirSync(source, { mode: 0o700 }); fs.writeFileSync(path.join(source, "main.ts"), "old\n");
  const state = { consent: true, use: true, retain: true, keyring: true, owner: A as string | null, cancelFolder: false };
  const box = { isEncryptionAvailable: () => state.keyring, getSelectedStorageBackend: () => "test-keyring",
    encryptString: (text: string) => Buffer.from(text), decryptString: (value: Buffer) => value.toString() } as SecretBox;
  const store = await LinuxCodingArtifactStore.create(reviews);
  const registry = await CodingResultRegistry.create({ privateBase: reviews, currentOwner: () => state.owner, projectExists: id => id === P, store });
  const binding = { owner: A, session: randomUUID(), snapshot: randomUUID() };
  const tree = (text: string) => ({ binding, entries: [{ path: "main.ts", kind: "file" as const, bytes: Buffer.from(text), executable: false }] });
  const review = createCodingReviewExport({ binding, baseline: tree("old\n"), proposed: tree("new\n"), current: tree("old\n") });
  const artifact = await store.write({ "review.json": Buffer.from(JSON.stringify(review.review, null, 2)), "changes.patch": Buffer.from(review.review.textPatch) }, () => {});
  const result = await registry.put({ expectedOwner: A, projectId: P, taskId: randomUUID(), title: "Parser result", sourcePath: source,
    status: "done", checks: { ran: 1, passed: 1, failed: 0 }, context: { request: "Check only the parser", summary: "Historical parser checks passed" }, current: () => state.owner === A,
    output: { ...artifact, review: review.review, cleanup: "complete" } });
  const folders = new ProjectCodingWorkspaces({ currentOwner: () => state.owner, projectExists: id => id === P });
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const imported = vi.fn(), importDraft = vi.fn(async (_projectId: string, _draft: OpenCodingDraft, _owner: CodingDraftOwner, _signal: AbortSignal, _current: () => boolean): Promise<HostImportResult> => ({ ok: false, message: "1 saved change conflicts. No import was prepared." }));
  let resourceGate: ReturnType<typeof deferred<void>> | undefined;
  const storageCheck = vi.fn(async () => state.keyring);
  const resources = { results: async () => registry, importDraft } as unknown as ProjectCodingResourcesPort;
  const ipc: CodingDraftIpc = registerCodingDraftIpc({ handle: (name, handler) => { handlers.set(name, handler); }, createStore: () => new CodingDraftStore(dir, box, false),
    owner: () => state.owner ? ({ library: state.owner, holder: state.owner }) : null, consented: () => state.consent, canUse: () => state.use, canRetain: () => state.retain,
    storageAvailable: storageCheck, projects: () => ({ selectedProjectId: P, projects: [{ id: P, sessions: [] }] } as unknown as ProjectSessionsState),
    folders, resources: async () => { if (resourceGate) await resourceGate.promise; return resources; },
    chooseFolder: async () => {
      if (!state.cancelFolder) { folders.bind(P, { path: source, current: () => true }, folders.ownerCurrent(P)); ipc.folderChanged(P); }
      return { projectId: P, folder: folders.state(P), available: true, canChoose: true, message: "Folder" };
    }, imported, changed: vi.fn() });
  const call = async (name: string, ...args: unknown[]) => handlers.get(name)!(...args);
  cleanups.push(async () => { await ipc.close().catch(() => undefined); await registry.close().catch(() => undefined); fs.rmSync(dir, { recursive: true, force: true }); });
  const save = async () => { const value = await call(IPC.codingDraftSave, result.id, "Parser draft") as { drafts: { id: string }[] }; return value.drafts[0].id; };
  return { storageCheck, dir, source, state, ipc, call, save, result, imported, importDraft, gateResources() { return resourceGate = deferred<void>(); } };
}
it.skipIf(process.platform !== "linux")("saves certified complete files and actual historical context encrypted, then opens an inert bounded view", async () => {
  const f = await fixture(), id = await f.save();
  const ciphertext = fs.readFileSync(path.join(f.dir, "coding-drafts", fs.readdirSync(path.join(f.dir, "coding-drafts"))[0]));
  expect(ciphertext.includes(Buffer.from("Check only the parser"))).toBe(false); expect(ciphertext.includes(Buffer.from("new\n"))).toBe(false);
  expect(await f.call(IPC.codingDraftOpen, id)).toMatchObject({ id, context: { request: "Check only the parser", summary: "Historical parser checks passed" },
    files: [{ path: "main.ts", kind: "file" }], filesTotal: 1 });
  expect(f.importDraft).not.toHaveBeenCalled(); expect(f.imported).not.toHaveBeenCalled(); expect(fs.readFileSync(path.join(f.source, "main.ts"), "utf8")).toBe("old\n");
});
it.skipIf(process.platform !== "linux")("refuses retention before consent and keeps erasure available when the keyring is unavailable", async () => {
  const f = await fixture(); f.state.consent = false;
  await expect(f.call(IPC.codingDraftSave, f.result.id, "Draft")).rejects.toThrow(); expect(fs.existsSync(path.join(f.dir, "coding-drafts"))).toBe(false);
  f.state.consent = true; await f.save(); f.state.keyring = false;
  expect(await f.call(IPC.codingDraftsState)).toMatchObject({ canSave: false, canOpen: false, canForget: true });
  await f.call(IPC.codingDraftForgetAll); expect(fs.readdirSync(path.join(f.dir, "coding-drafts"))).toEqual([]);
});
it.skipIf(process.platform !== "linux")("requires a real new folder choice after Open, refuses conflicts and never starts work", async () => {
  const f = await fixture(), id = await f.save(); await f.call(IPC.codingDraftOpen, id);
  expect(await f.call(IPC.codingDraftImport, id, P)).toMatchObject({ ok: false }); expect(f.importDraft).not.toHaveBeenCalled();
  f.state.cancelFolder = true; expect(await f.call(IPC.codingDraftFolderChoose, id, P)).toMatchObject({ ok: false });
  f.state.cancelFolder = false; expect(await f.call(IPC.codingDraftFolderChoose, id, P)).toMatchObject({ ok: true });
  expect(await f.call(IPC.codingDraftImport, id, P)).toMatchObject({ ok: false }); expect(f.imported).not.toHaveBeenCalled();
  expect(await f.call(IPC.codingDraftImport, id, P)).toMatchObject({ ok: false, message: expect.stringContaining("Choose a coding folder again") });
  expect(f.importDraft).toHaveBeenCalledTimes(1);
});
it.skipIf(process.platform !== "linux")("holds all new draft admissions while Forget drains an earlier Save", async () => {
  const f = await fixture(), id = await f.save(), gate = f.gateResources();
  const saving = f.call(IPC.codingDraftSave, f.result.id, "Pending draft"); const forgetting = f.call(IPC.codingDraftForgetAll);
  await expect(f.call(IPC.codingDraftOpen, id)).rejects.toThrow();
  await expect(f.call(IPC.codingDraftSave, f.result.id, "During erasure")).rejects.toThrow();
  await expect(f.call(IPC.codingDraftImport, id, P)).rejects.toThrow();
  gate.resolve(); await saving; await forgetting; expect(fs.readdirSync(path.join(f.dir, "coding-drafts"))).toEqual([]); expect(f.imported).not.toHaveBeenCalled();
});
it.skipIf(process.platform !== "linux")("retires a paused Save on account change without publishing data for another owner", async () => {
  const f = await fixture(), gate = f.gateResources(); const saving = f.call(IPC.codingDraftSave, f.result.id, "Old owner");
  f.state.owner = B; const invalidated = f.ipc.invalidate(); gate.resolve();
  expect(await saving).toMatchObject({ drafts: [], canSave: false }); await invalidated;
  const files = fs.existsSync(path.join(f.dir, "coding-drafts")) ? fs.readdirSync(path.join(f.dir, "coding-drafts")) : [];
  expect(files).toEqual([]); expect(f.imported).not.toHaveBeenCalled();
});

it.skipIf(process.platform !== "linux")("does not acknowledge Forget for an opened draft until its separate import operation has drained", async () => {
  const f = await fixture(), id = await f.save(); await f.call(IPC.codingDraftOpen, id); await f.call(IPC.codingDraftFolderChoose, id, P);
  const held = deferred<void>(), entered = deferred<void>();
  f.importDraft.mockImplementationOnce(async (_project, _draft, _owner, _signal, current) => {
    entered.resolve(); await held.promise; expect(current()).toBe(false); return { ok: false, message: "Retired" };
  });
  const importing = f.call(IPC.codingDraftImport, id, P); await entered.promise;
  let done = false; const forgetting = f.call(IPC.codingDraftForget, id).then(value => { done = true; return value; });
  await Promise.resolve(); expect(done).toBe(false); held.resolve(); await importing; await forgetting;
  expect(f.imported).not.toHaveBeenCalled(); expect(fs.readdirSync(path.join(f.dir, "coding-drafts"))).toEqual([]);
});

it.skipIf(process.platform !== "linux")("erases an explicit saved draft without consent while reading no remaining library metadata", async () => {
  const f = await fixture(), first = await f.save(); await f.save(); f.storageCheck.mockClear(); f.state.consent = false; f.state.retain = false;
  expect(await f.call(IPC.codingDraftForget, first)).toMatchObject({ canOpen: false, drafts: [], message: expect.stringContaining("forgotten") });
  expect(f.storageCheck).not.toHaveBeenCalled(); expect(fs.readdirSync(path.join(f.dir, "coding-drafts"))).toHaveLength(1);
});

it.skipIf(process.platform !== "linux")("requires the verified owner for Forget and retains the stronger action gate for reading and saving", async () => {
  const f = await fixture(), id = await f.save(); f.state.retain = false;
  await expect(f.call(IPC.codingDraftOpen, id)).rejects.toThrow(); await expect(f.call(IPC.codingDraftSave, f.result.id, "Denied")).rejects.toThrow();
  f.state.owner = null;
  expect(await f.call(IPC.codingDraftsState)).toMatchObject({ canForget: false });
  await expect(f.call(IPC.codingDraftForgetAll)).rejects.toThrow();
  expect(fs.readdirSync(path.join(f.dir, "coding-drafts"))).toHaveLength(1);
});
