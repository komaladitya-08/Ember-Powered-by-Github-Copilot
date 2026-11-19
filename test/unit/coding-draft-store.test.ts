import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { Worker } from "node:worker_threads";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCodingReviewExport, type CodingReviewExport } from "../../app/main/agent/coding-result-export";
import type { CodingArtifactReceipt, CodingArtifactSourceRef, CodingArtifactStore } from "../../app/main/agent/coding-artifact-store";
import type { SecretBox } from "../../app/main/agent/auth";
import type { CodingDraftMetadata } from "../../app/main/agent/coding-draft-format";
import { CODING_DRAFT_MAX_FILE_BYTES } from "../../app/main/agent/coding-draft-format";
import type { CodingDraftSnapshot } from "../../app/main/agent/coding-draft-snapshot";
import type { CodingDraftStore } from "../../app/main/agent/coding-draft-store";
import { LinuxCodingArtifactStore } from "../../app/main/agent/linux-coding-artifact-store";

const require = createRequire(import.meta.url), root = fileURLToPath(new URL("../../", import.meta.url));
const owner = { library: "a".repeat(64), holder: "b".repeat(64) }, current = () => true;
let bundle: string, dir: string, workerSource: string, api: typeof import("../../app/main/agent/coding-draft-store");
const clients: CodingDraftStore[] = [], snapshots: CodingDraftSnapshot[] = [];
beforeAll(async () => {
  bundle = await fsp.mkdtemp(path.join(os.tmpdir(), "ember-draft-bundle-"));
  workerSource = buildSync({ absWorkingDir: root, entryPoints: ["app/main/agent/coding-draft-worker.ts"], bundle: true,
    platform: "node", format: "cjs", target: "node22", write: false, logLevel: "silent" }).outputFiles[0].text;
  const client = buildSync({ absWorkingDir: root, entryPoints: ["app/main/agent/coding-draft-store.ts"], bundle: true,
    platform: "node", format: "cjs", target: "node22", write: false, logLevel: "silent",
    define: { __EMBER_CODING_DRAFT_WORKER_SOURCE__: JSON.stringify(workerSource) } }).outputFiles[0].text;
  const file = path.join(bundle, "store.cjs"); await fsp.writeFile(file, client, { mode: 0o600 }); api = require(file);
});
beforeEach(async () => { dir = await fsp.mkdtemp(path.join(os.tmpdir(), "ember-coding-draft-")); });
afterEach(async () => {
  vi.restoreAllMocks(); snapshots.splice(0).forEach(value => value.close());
  await Promise.all(clients.splice(0).map(value => value.close()));
  await fsp.rm(dir, { recursive: true, force: true });
});
afterAll(async () => { await fsp.rm(bundle, { recursive: true, force: true }); });
function box(): SecretBox & { encryptString: ReturnType<typeof vi.fn>; decryptString: ReturnType<typeof vi.fn> } {
  return { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "gnome_libsecret",
    encryptString: vi.fn((text: string) => Buffer.from(text).reverse()), decryptString: vi.fn((bytes: Buffer) => Buffer.from(bytes).reverse().toString()) };
}
function store(keyring = box(), asyncKeyring = false): CodingDraftStore { const value = new api.CodingDraftStore(dir, keyring, asyncKeyring); clients.push(value); return value; }
function metadata(document: CodingReviewExport): CodingDraftMetadata {
  return { version: 1, id: randomUUID(), owner, name: "Saved private draft", savedAt: 100, sourceLabel: "Chosen source",
    context: { request: "Repair the greeting", summary: "Repaired greeting in the private copy" }, historicalChecks: { ran: 1, passed: 0, failed: 1 }, binding: document.binding };
}
function review(text = "module.exports = 'private proposed greeting';\n", name = "main.cjs"): CodingReviewExport {
  const binding = { owner: owner.holder, session: randomUUID(), snapshot: randomUUID() };
  return createCodingReviewExport({ binding,
    baseline: { binding, entries: [{ path: "old.txt", kind: "file", bytes: Buffer.from("removed"), executable: false },
      { path: name, kind: "file", bytes: Buffer.from("original greeting\n"), executable: false }] },
    proposed: { binding, entries: [{ path: "empty", kind: "directory" }, { path: name, kind: "file", bytes: Buffer.from(text), executable: true },
      { path: "image.bin", kind: "file", bytes: Buffer.from([0, 255, 1]), executable: false }] },
    current: { binding, entries: [{ path: name, kind: "file", bytes: Buffer.from("concurrent original edit\n"), executable: false }] },
    scope: { version: 1, source: { excludedRoots: [".git", "node_modules"], omitted: [{ path: ".git", kind: "directory" }], byteLimit: 10 * 1024 * 1024 }, dependencies: null },
  }).review;
}
function artifact(document: CodingReviewExport) {
  const receipt = Object.freeze({}) as CodingArtifactReceipt, source = Object.freeze({}) as CodingArtifactSourceRef;
  let identity = 1, next = 1;
  const sources = new WeakMap<object, number>([[source, 1]]);
  const bytes = Buffer.from(JSON.stringify(document, null, 2));
  const service = {
    async verify(value: CodingArtifactReceipt, check: () => void) { check(); if (value !== receipt) throw new Error("unknown artifact"); },
    async read(value: CodingArtifactReceipt, name: string, limit: number, check: () => void) { check(); if (value !== receipt || name !== "review.json" || bytes.length > limit) throw new Error("unknown artifact"); return Buffer.from(bytes); },
    async sourceBoundary(_path: string, check: () => void, expected?: CodingArtifactSourceRef) { check(); return expected && sources.has(expected) ? expected : null; },
    async sameSource(before: CodingArtifactSourceRef, after: CodingArtifactSourceRef, check: () => void) { check(); return sources.get(before) === identity && sources.get(after) === identity; },
  } as unknown as CodingArtifactStore;
  return { service, receipt, source, change() { identity = ++next; }, fresh() { const value = Object.freeze({}) as CodingArtifactSourceRef; sources.set(value, identity); return value; } };
}
async function captured(client: CodingDraftStore, document = review(), selected = artifact(document), meta = metadata(document), check = current) {
  const snapshot = await client.capture({ store: selected.service, artifact: selected.receipt, source: selected.source, metadata: meta, current: check }); snapshots.push(snapshot);
  return { snapshot, selected, meta, document };
}
const file = (id: string, library = owner.library) => path.join(dir, "coding-drafts", `coding-draft-${library}-${id}.bin`);
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function enteredOrSettled(entered: Promise<void>, pending: Promise<unknown>): Promise<void> {
  await Promise.race([entered, pending.then(() => { throw new Error("The draft operation ended before its held fixture stage."); })]);
}

describe("explicit encrypted coding drafts", () => {
  it("roundtrips complete baseline/proposal/binary/deletion/conflict/scope with inert bounded context, never plaintext source", async () => {
    const keyring = box(), client = store(keyring), value = await captured(client);
    await expect(client.save(owner, value.snapshot, current)).resolves.toBe(value.meta.id);
    expect(keyring.encryptString).toHaveBeenCalledWith(expect.stringMatching(/^[A-Za-z0-9+/]{43}=$/));
    expect(keyring.encryptString.mock.calls[0][0].length).toBe(44);
    const ciphertext = fs.readFileSync(file(value.meta.id));
    for (const text of ["private proposed greeting", value.meta.name, value.meta.context.request, "original greeting"]) expect(ciphertext.includes(text)).toBe(false);
    const opened = await client.open(owner, value.meta.id, current);
    expect(opened!.metadata()).toEqual(value.meta); expect(JSON.parse(opened!.reviewBytes().toString())).toEqual(value.document);
    expect(Object.keys(opened!).sort()).toEqual(["close", "metadata", "reviewBytes"]);
    const copy = opened!.reviewBytes(); copy.fill(0); expect(JSON.parse(opened!.reviewBytes().toString()).baseline).toEqual(value.document.baseline);
    opened!.close(); expect(() => opened!.metadata()).toThrow();
  });

  it("requires exact credential holder for all bytes and context, including another key at the same library", async () => {
    const client = store(), value = await captured(client); await client.save(owner, value.snapshot, current);
    await expect(client.open({ ...owner, holder: "c".repeat(64) }, value.meta.id, current)).rejects.toMatchObject({ code: "holder" });
    await expect(client.list({ ...owner, holder: "c".repeat(64) }, current)).rejects.toMatchObject({ code: "holder" });
    expect(await client.open({ library: "d".repeat(64), holder: owner.holder }, value.meta.id, current)).toBeNull();
  });

  it("refuses forged snapshots and forged artifact receipts before any durable write", async () => {
    const client = store(), document = review(), selected = artifact(document);
    await expect(client.save(owner, { close() {} } as CodingDraftSnapshot, current)).rejects.toMatchObject({ code: "invalid" });
    await expect(client.capture({ store: selected.service, artifact: {} as CodingArtifactReceipt, metadata: metadata(document), current })).rejects.toMatchObject({ code: "io" });
    expect(fs.readdirSync(path.join(dir, "coding-drafts"))).toEqual([]);
  });

  it.each(["credential text", "credential path", "context", "noncanonical", "extra metadata"])("refuses complete unsafe or noncanonical %s without saving", async kind => {
    const client = store(); let document = review();
    if (kind === "credential text") document = review("const line = 'ordinary';\npassword=hunter2\n");
    if (kind === "credential path") document = review("ordinary", ".env");
    const meta = metadata(document); if (kind === "context") meta.context.summary = "password=hunter2";
    if (kind === "extra metadata") Object.assign(meta, { taskId: "old executable reference" });
    const selected = artifact(document);
    if (kind === "noncanonical") selected.service.read = async () => Buffer.from(JSON.stringify(document));
    await expect(captured(client, document, selected, meta)).rejects.toMatchObject({ code: ["credential text", "credential path", "context"].includes(kind) ? "privacy" : "invalid" });
    expect(fs.readdirSync(path.join(dir, "coding-drafts"))).toEqual([]);
  });

  it("requires an actual system keyring and never substitutes synchronous access for async keyring methods", async () => {
    const keyring = box(), client = store(keyring), value = await captured(client);
    keyring.getSelectedStorageBackend = () => "basic_text";
    await expect(client.save(owner, value.snapshot, current)).rejects.toMatchObject({ code: "keyring" });
    expect(keyring.encryptString).not.toHaveBeenCalled();
    const asyncClient = store(box(), true), next = await captured(asyncClient);
    await expect(asyncClient.save(owner, next.snapshot, current)).rejects.toMatchObject({ code: "keyring" });
  });

  it("authenticates ciphertext, header and context before opening anything and retains corrupt bytes for explicit Forget", async () => {
    const client = store(), value = await captured(client); await client.save(owner, value.snapshot, current);
    const bytes = fs.readFileSync(file(value.meta.id)); bytes[bytes.length - 20] ^= 1; fs.writeFileSync(file(value.meta.id), bytes);
    await expect(client.open(owner, value.meta.id, current)).rejects.toMatchObject({ code: "io" });
    expect(fs.readFileSync(file(value.meta.id))).toEqual(bytes);
    await client.forget(owner, value.meta.id, current); expect(fs.existsSync(file(value.meta.id))).toBe(false);
  });

  it("waits pending encryption and cannot resurrect a draft after Forget", async () => {
    const keyring = box(), entered = deferred<void>(), held = deferred<Buffer>();
    Object.assign(keyring, { isAsyncEncryptionAvailable: async () => true, decryptStringAsync: async (value: Buffer) => ({ result: keyring.decryptString(value), shouldReEncrypt: false }),
      encryptStringAsync: (value: string) => { entered.resolve(); return held.promise.then(() => keyring.encryptString(value)); } });
    const client = store(keyring, true), value = await captured(client), saving = client.save(owner, value.snapshot, current).catch(error => error);
    let forgotten: Promise<void> | undefined;
    try {
      await enteredOrSettled(entered.promise, saving); let done = false; forgotten = client.forget(owner, value.meta.id, current).then(() => { done = true; });
      await Promise.resolve(); expect(done).toBe(false); held.resolve(Buffer.alloc(0));
      expect(await saving).toMatchObject({ code: "stale" }); await forgotten;
    } finally { held.resolve(Buffer.alloc(0)); await saving; await forgotten; }
    expect(fs.existsSync(file(value.meta.id))).toBe(false); expect(fs.readdirSync(path.join(dir, "coding-drafts"))).toEqual([]);
  });

  it("Forget everything discovers all exact libraries after reopening and preserves unrelated files without keyring access", async () => {
    const client = store(), first = await captured(client); await client.save(owner, first.snapshot, current);
    const other = { library: "c".repeat(64), holder: "d".repeat(64) };
    // Rebuild all tree bindings by creating a separate canonical document through the formatter.
    const decoded = { owner: other.holder, session: randomUUID(), snapshot: randomUUID() };
    const secondDocument = createCodingReviewExport({ binding: decoded, baseline: { binding: decoded, entries: [] }, proposed: { binding: decoded, entries: [] } }).review;
    const meta = { ...metadata(secondDocument), owner: other }, second = await captured(client, secondDocument, artifact(secondDocument), meta);
    await client.save(other, second.snapshot, current); await client.close();
    const unrelated = path.join(dir, "coding-drafts", "coding-draft-unrelated.bin"); fs.writeFileSync(unrelated, "keep");
    const unavailable = box(); unavailable.isEncryptionAvailable = () => false;
    const reopened = store(unavailable); await reopened.forgetAll(current);
    expect(fs.readdirSync(path.join(dir, "coding-drafts"))).toEqual(["coding-draft-unrelated.bin"]);
  });

  it("global Forget fences a capture still waiting for stopped artifact bytes, before any file exists", async () => {
    const client = store(), document = review(), selected = artifact(document), entered = deferred<void>(), release = deferred<void>();
    const original = selected.service.read.bind(selected.service);
    selected.service.read = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
    const capturing = client.capture({ store: selected.service, artifact: selected.receipt, metadata: metadata(document), current }).catch(error => error);
    let forgotten: Promise<void> | undefined;
    try {
      await enteredOrSettled(entered.promise, capturing); forgotten = client.forgetAll(current); release.resolve();
      expect(await capturing).toMatchObject({ code: "stale" }); await forgotten;
    } finally { release.resolve(); await capturing; await forgotten; }
    expect(fs.readdirSync(path.join(dir, "coding-drafts"))).toEqual([]);
  });

  it("Forget also revokes a completed unsaved snapshot held by an old caller", async () => {
    const client = store(), value = await captured(client);
    await client.forgetAll(current);
    await expect(client.save(owner, value.snapshot, current)).rejects.toMatchObject({ code: "invalid" });
    expect(fs.readdirSync(path.join(dir, "coding-drafts"))).toEqual([]);
  });

  it("keeps existing ciphertext when account authority changes during decryption and revokes already-opened data on Forget", async () => {
    const keyring = box(), client = store(keyring), value = await captured(client); await client.save(owner, value.snapshot, current);
    const opened = await client.open(owner, value.meta.id, current); let active = true;
    const other = store(keyring); keyring.decryptString = vi.fn(() => { active = false; return ""; });
    await expect(other.open(owner, value.meta.id, () => active)).rejects.toMatchObject({ code: "stale" });
    expect(fs.existsSync(file(value.meta.id))).toBe(true);
    await client.forget(owner, value.meta.id, current); expect(() => opened!.reviewBytes()).toThrow();
  });

  it("captures the original holder before async keyring waits instead of accepting a later mutated option", async () => {
    const keyring = box(), client = store(keyring), value = await captured(client); await client.save(owner, value.snapshot, current);
    const entered = deferred<void>(), release = deferred<void>(), selected = { ...owner, holder: "c".repeat(64) };
    Object.assign(keyring, { isAsyncEncryptionAvailable: async () => true, encryptStringAsync: async (text: string) => keyring.encryptString(text),
      decryptStringAsync: (bytes: Buffer) => { entered.resolve(); return release.promise.then(() => ({ result: keyring.decryptString(bytes), shouldReEncrypt: false })); } });
    const reader = store(keyring, true), opening = reader.open(selected, value.meta.id, current).catch(error => error);
    try {
      await enteredOrSettled(entered.promise, opening); selected.holder = owner.holder; release.resolve();
      expect(await opening).toMatchObject({ code: "holder" });
    } finally { release.resolve(); await opening; }
    expect(fs.existsSync(file(value.meta.id))).toBe(true);
  });

  it("creates continuation data only with a fresh explicit grant and same live native source; restart remains inert", async () => {
    const client = store(), value = await captured(client); await client.save(owner, value.snapshot, current);
    const draft = (await client.open(owner, value.meta.id, current))!, fresh = value.selected.fresh();
    let granted = true;
    const input = { store: value.selected.service, source: fresh, grant: { path: "/chosen/source", current: () => granted }, owner, request: "Now repair the tests", current };
    const attached = await api.reattachCodingDraft(draft, input);
    expect(attached.kind).toBe("continuation-data");
    if (attached.kind === "continuation-data") {
      expect(attached.continuation.current()).toBe(true);
      expect(attached.continuation.proposed.entries.find(entry => entry.path === "image.bin")).toMatchObject({ bytes: Buffer.from([0, 255, 1]) });
      granted = false; expect(attached.continuation.current()).toBe(false); granted = true;
    }
    value.selected.change();
    expect(await api.reattachCodingDraft(draft, { ...input, source: value.selected.fresh() })).toEqual({ kind: "review-only", reason: "source-changed" });
    await client.close(); const reopened = store(), restored = (await reopened.open(owner, value.meta.id, current))!;
    expect(await api.reattachCodingDraft(restored, input)).toEqual({ kind: "review-only", reason: "source-identity-unknown" });
  });

  it("never treats old checks as a current success, or a saved snapshot as request/command authority", async () => {
    const client = store(), value = await captured(client); await client.save(owner, value.snapshot, current);
    const draft = (await client.open(owner, value.meta.id, current))!;
    expect(draft.metadata().historicalChecks).toEqual({ ran: 1, passed: 0, failed: 1 });
    expect(Object.keys(draft)).not.toContain("run"); expect(Object.keys(draft)).not.toContain("taskId");
    await expect(api.reattachCodingDraft(draft, { store: value.selected.service, source: value.selected.fresh(), grant: { path: "/chosen/source", current }, owner, request: "", current })).rejects.toMatchObject({ code: "invalid" });
  });

  it("honours a separately revoked source lifetime even while Save and its owner remain current", async () => {
    const client = store(), document = review(), selected = artifact(document), meta = metadata(document);
    const snapshot = await client.capture({ store: selected.service, artifact: selected.receipt, source: selected.source, metadata: meta, current, sourceCurrent: () => false }); snapshots.push(snapshot);
    await client.save(owner, snapshot, current); const draft = (await client.open(owner, meta.id, current))!;
    expect(draft.metadata().name).toBe(meta.name);
    expect(await api.reattachCodingDraft(draft, { store: selected.service, source: selected.fresh(), grant: { path: "/chosen/source", current }, owner, request: "A new request", current })).toEqual({ kind: "review-only", reason: "source-identity-unknown" });
  });

  it.each(["sourceBoundary", "sameSource"] as const)("refuses source lifetime revocation during held %s before returning continuation data", async stage => {
    const client = store(), document = review(), selected = artifact(document), meta = metadata(document);
    let sourceCurrent = true;
    const snapshot = await client.capture({ store: selected.service, artifact: selected.receipt, source: selected.source, metadata: meta, current, sourceCurrent: () => sourceCurrent }); snapshots.push(snapshot);
    await client.save(owner, snapshot, current); const draft = (await client.open(owner, meta.id, current))!;
    const entered = deferred<void>(), release = deferred<void>();
    if (stage === "sourceBoundary") {
      const original = selected.service.sourceBoundary.bind(selected.service);
      vi.spyOn(selected.service, "sourceBoundary").mockImplementation(async (...args) => { entered.resolve(); await release.promise; return original(...args); });
    } else {
      const original = selected.service.sameSource.bind(selected.service);
      vi.spyOn(selected.service, "sameSource").mockImplementation(async (...args) => { entered.resolve(); await release.promise; return original(...args); });
    }
    const attaching = api.reattachCodingDraft(draft, { store: selected.service, source: selected.fresh(), grant: { path: "/chosen/source", current }, owner, request: "A new request", current }).catch(error => error);
    try {
      await enteredOrSettled(entered.promise, attaching); sourceCurrent = false; release.resolve();
      expect(await attaching).toMatchObject({ code: "stale" });
    } finally { release.resolve(); await attaching; }
  });

  it("rechecks the owning-source lifetime across worker validation instead of returning a positive kind with stale data", async () => {
    const client = store(), document = review(), selected = artifact(document), meta = metadata(document);
    let sourceCurrent = true;
    const snapshot = await client.capture({ store: selected.service, artifact: selected.receipt, source: selected.source, metadata: meta, current, sourceCurrent: () => sourceCurrent }); snapshots.push(snapshot);
    await client.save(owner, snapshot, current); const draft = (await client.open(owner, meta.id, current))!;
    const original = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function(this: Worker, ...args: Parameters<Worker["postMessage"]>) {
      sourceCurrent = false; return original.apply(this, args);
    });
    await expect(api.reattachCodingDraft(draft, { store: selected.service, source: selected.fresh(), grant: { path: "/chosen/source", current }, owner, request: "A new request", current })).rejects.toMatchObject({ code: "stale" });
  });

  it("refuses an unstaged worker build instead of validating source on the main thread or using a project path", async () => {
    const source = buildSync({ absWorkingDir: root, entryPoints: ["app/main/agent/coding-draft-store.ts"], bundle: true,
      platform: "node", format: "cjs", target: "node22", write: false, logLevel: "silent" }).outputFiles[0].text;
    const entry = path.join(bundle, "unstaged.cjs"); fs.writeFileSync(entry, source);
    const unsupported = require(entry) as typeof api;
    const client = new unsupported.CodingDraftStore(dir, box(), false); clients.push(client);
    // Vitest installs config.define values on globalThis too. The unstaged CommonJS bundle must see no such fallback.
    const key = ["__EMBER", "CODING_DRAFT_WORKER_SOURCE__"].join("_"), injected = Object.getOwnPropertyDescriptor(globalThis, key);
    Reflect.deleteProperty(globalThis, key);
    try { await expect(captured(client)).rejects.toMatchObject({ code: "unavailable" }); }
    finally { if (injected) Object.defineProperty(globalThis, key, injected); }
    expect(fs.readdirSync(path.join(dir, "coding-drafts"))).toEqual([]);
  });

  it("rejects a swapped storage directory during keyring waits without writing a replacement folder", async () => {
    const keyring = box(), entered = deferred<void>(), release = deferred<void>();
    Object.assign(keyring, { isAsyncEncryptionAvailable: async () => true, decryptStringAsync: async (value: Buffer) => ({ result: keyring.decryptString(value), shouldReEncrypt: false }),
      encryptStringAsync: (value: string) => { entered.resolve(); return release.promise.then(() => keyring.encryptString(value)); } });
    const client = store(keyring, true), value = await captured(client), saving = client.save(owner, value.snapshot, current).catch(error => error);
    const folder = path.join(dir, "coding-drafts");
    try {
      await enteredOrSettled(entered.promise, saving);
      fs.renameSync(folder, path.join(dir, "old-drafts")); fs.mkdirSync(folder, { mode: 0o700 });
      release.resolve(); expect(await saving).toMatchObject({ code: "stale" });
    } finally { release.resolve(); await saving; }
    expect(fs.readdirSync(folder)).toEqual([]); expect(fs.readdirSync(path.join(dir, "old-drafts"))).toEqual([]);
  });

  it("rejects hard-linked saved files before decrypting source data", async () => {
    const keyring = box(), client = store(keyring), value = await captured(client); await client.save(owner, value.snapshot, current);
    const link = path.join(dir, "second-link"); fs.linkSync(file(value.meta.id), link); keyring.decryptString.mockClear();
    await expect(client.open(owner, value.meta.id, current)).rejects.toMatchObject({ code: "invalid" });
    expect(keyring.decryptString).not.toHaveBeenCalled();
  });

  it("bounds ciphertext before allocation or keyring access, preserving the oversized file for explicit Forget", async () => {
    const keyring = box(), client = store(keyring), value = await captured(client); await client.save(owner, value.snapshot, current);
    fs.truncateSync(file(value.meta.id), CODING_DRAFT_MAX_FILE_BYTES + 1); keyring.decryptString.mockClear();
    await expect(client.open(owner, value.meta.id, current)).rejects.toMatchObject({ code: "invalid" });
    expect(keyring.decryptString).not.toHaveBeenCalled(); expect(fs.statSync(file(value.meta.id)).size).toBe(CODING_DRAFT_MAX_FILE_BYTES + 1);
    await client.forget(owner, value.meta.id, current); expect(fs.existsSync(file(value.meta.id))).toBe(false);
  });

  it("retains typed unknown thread cleanup, hides its raw failure and fences later admission and close", async () => {
    const source = buildSync({ absWorkingDir: root, entryPoints: ["app/main/agent/coding-draft-store.ts"], bundle: true,
      platform: "node", format: "cjs", target: "node22", write: false, logLevel: "silent",
      define: { __EMBER_CODING_DRAFT_WORKER_SOURCE__: JSON.stringify(workerSource) } }).outputFiles[0].text;
    const entry = path.join(bundle, "unknown-thread.cjs"); fs.writeFileSync(entry, source);
    const isolated = require(entry) as typeof api, client = new isolated.CodingDraftStore(dir, box(), false);
    const realTerminate = Worker.prototype.terminate;
    const termination = vi.spyOn(Worker.prototype, "terminate").mockImplementation(async function(this: Worker) {
      await realTerminate.call(this); // The test owns and observes the actual thread even while modeling a rejected receipt.
      throw new Error("PRIVATE thread detail must not escape");
    });
    try {
      let failure: unknown;
      try { await captured(client); } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(isolated.CodingDraftCleanupError);
      expect((failure as Error).message).toBe("The coding draft worker could not be verified as stopped.");
      termination.mockRestore();
      await expect(client.capture({ store: artifact(review()).service, artifact: {} as CodingArtifactReceipt, metadata: metadata(review()), current })).rejects.toBe(failure);
      await expect(client.close()).rejects.toBe(failure);
    } finally { termination.mockRestore(); await client.close().catch(() => undefined); }
  });

  it("observes a spawned worker exit before returning task cancellation while complete large source is pending", async () => {
    const client = store(), document = review("const letters = '" + "x".repeat(4 * 1024 * 1024 - 100) + "';\n"), selected = artifact(document);
    const post = Worker.prototype.postMessage, terminated = vi.spyOn(Worker.prototype, "terminate");
    let active = true, timerRan = false;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function(this: Worker, ...args: Parameters<Worker["postMessage"]>) {
      setTimeout(() => { timerRan = true; active = false; }, 0);
      return post.apply(this, args);
    });
    await expect(client.capture({ store: selected.service, artifact: selected.receipt, metadata: metadata(document), current: () => active })).rejects.toMatchObject({ code: "stale" });
    expect(timerRan).toBe(true); expect(terminated).toHaveBeenCalledOnce();
    expect(await terminated.mock.results[0].value).toEqual(expect.any(Number));
    expect(fs.readdirSync(path.join(dir, "coding-drafts"))).toEqual([]);
  });

  it.skipIf(process.platform !== "linux")("bridges real host-issued artifact and source receipts while leaving the original folder unchanged", async () => {
    const base = path.join(dir, "native-reviews"), source = path.join(dir, "original");
    fs.mkdirSync(base, { mode: 0o700 }); fs.mkdirSync(source, { mode: 0o700 }); fs.writeFileSync(path.join(source, "main.cjs"), "untouched original");
    const real = await LinuxCodingArtifactStore.create(base), document = review(), client = store();
    try {
      const initial = await real.sourceBoundary(source, () => {});
      const output = await real.write({ "review.json": Buffer.from(JSON.stringify(document, null, 2)), "changes.patch": Buffer.from(document.textPatch) }, () => {});
      const receipt = await real.claim(output, () => {}), meta = metadata(document);
      const snapshot = await client.capture({ store: real, artifact: receipt, metadata: meta, source: initial!, current }); snapshots.push(snapshot);
      await client.save(owner, snapshot, current); const draft = (await client.open(owner, meta.id, current))!;
      const fresh = await real.sourceBoundary(source, () => {});
      const result = await api.reattachCodingDraft(draft, { store: real, source: fresh!, grant: { path: source, current }, owner, request: "Continue only in a new private copy", current });
      expect(result.kind).toBe("continuation-data"); expect(fs.readFileSync(path.join(source, "main.cjs"), "utf8")).toBe("untouched original");
      fs.renameSync(source, path.join(dir, "moved-original")); fs.mkdirSync(source, { mode: 0o700 });
      expect(await api.reattachCodingDraft(draft, { store: real, source: (await real.sourceBoundary(source, () => {}))!, grant: { path: source, current }, owner, request: "Inspect restored data", current })).toEqual({ kind: "review-only", reason: "source-changed" });
    } finally { await real.close(); }
  });
});
