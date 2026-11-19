/** Portable ownership and privacy model; real NTFS acceptance belongs to the Windows native lane. */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodingExportBinding, CodingExportEntry, CodingExportTree } from "../../app/main/agent/coding-result-export";
import type { CodingWorkspaceContinuation } from "../../app/main/agent/coding-seed-snapshot";
import type { CodingProjectManifest } from "../../app/main/agent/coding-project-scope";
import type { CodingPrivacyScope } from "../../app/main/agent/coding-privacy-scanner";
import type { WindowsCodingInfo, WindowsCodingNative } from "../../app/main/agent/windows-coding-native";

const OWNER = "a".repeat(64), ROOT = 1n, VOLUME = "\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\";
const binding = (): CodingExportBinding => ({ owner: OWNER, session: randomUUID(), snapshot: randomUUID() });
const previous = binding();
const file = (path: string, bytes: string | Buffer, executable = false): CodingExportEntry => ({ path, kind: "file", bytes: typeof bytes === "string" ? Buffer.from(bytes) : bytes, executable });
const directory = (path: string): CodingExportEntry => ({ path, kind: "directory" });
const tree = (...entries: CodingExportEntry[]): CodingExportTree => ({ binding: { ...previous }, entries });
const scope = (): CodingProjectManifest => ({ version: 1, source: { excludedRoots: [".git", "node_modules"], omitted: [], byteLimit: 10 * 1024 * 1024 }, dependencies: null });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(yes => { resolve = yes; }); return { promise, resolve }; }

afterEach(() => { vi.restoreAllMocks(); vi.doUnmock("../../app/main/agent/coding-privacy-scanner"); vi.doUnmock("../../app/main/agent/windows-coding-native"); vi.resetModules(); });

async function setup() {
  vi.resetModules();
  const privacy = await import("../../app/main/agent/coding-privacy-scanner");
  const native = await import("../../app/main/agent/windows-coding-native");
  const { ScopedCodingFileError } = await import("../../app/main/agent/coding-platform");
  let epoch = 0, current = true, predecessorCurrent = true, scanGate: ReturnType<typeof deferred> | undefined;
  let scannerCloseFailure = false;
  const privacyScope = Object.freeze({}) as CodingPrivacyScope, generation = epoch;
  const scans: string[] = [], scanners: { scope?: CodingPrivacyScope; closeCalls: number }[] = [], scanEntered = deferred();
  const assertScope = (value: CodingPrivacyScope) => { if (value !== privacyScope || generation !== epoch) throw new privacy.CodingPrivacyScanError("stale"); };
  class Scanner {
    closed = false;
    readonly record: typeof scanners[number];
    constructor(readonly options: { scope?: CodingPrivacyScope; signal?: AbortSignal } = {}) {
      assertScope(options.scope!); this.record = { scope: options.scope, closeCalls: 0 }; scanners.push(this.record);
    }
    assertCurrent() { assertScope(this.options.scope!); if (this.closed || this.options.signal?.aborted) throw new privacy.CodingPrivacyScanError("cancelled"); }
    async refusal(text: string, options: { current?: () => boolean; signal?: AbortSignal } = {}) {
      this.assertCurrent(); scans.push(text); scanEntered.resolve(); if (scanGate) await scanGate.promise;
      this.assertCurrent(); if (options.signal?.aborted || options.current?.() === false) throw new privacy.CodingPrivacyScanError("stale");
      return text.includes("SECRET_SENTINEL") ? "credential-text" : null;
    }
    async close() { this.record.closeCalls++; this.closed = true; if (scannerCloseFailure) throw new privacy.CodingPrivacyCleanupError(); }
  }
  vi.doMock("../../app/main/agent/coding-privacy-scanner", () => ({ ...privacy, CodingPrivacyScanner: Scanner, assertCodingPrivacyScope: assertScope }));
  const retire = vi.fn(() => new native.WindowsCodingCleanupError());
  vi.doMock("../../app/main/agent/windows-coding-native", () => ({ ...native, retireWindowsCodingNative: retire }));
  const helpers = await import("../../app/main/agent/windows-coding-continuation-seed");
  interface Row { handle: bigint; parent?: bigint; name: string; info: WindowsCodingInfo; body: Buffer; written: boolean; removed: boolean; unlinked: boolean }
  const rows = new Map<bigint, Row>(), held = new Set<bigint>([ROOT]), closed: bigint[] = [], removed: bigint[] = [], events: string[] = [], readBuffers: Buffer[] = [], writeInputs: Buffer[] = [];
  const root: Row = { handle: ROOT, name: "copy", info: { id: "root", volume: VOLUME, finalPath: VOLUME + "private\\copy", kind: "directory", attributes: 0x10,
    links: 1, size: 0, created: "1", written: "1", changed: "1" }, body: Buffer.alloc(0), written: false, removed: false, unlinked: false };
  rows.set(ROOT, root); let next = 2n, ticks = 2, infoFailure = false;
  const faults: { write?: boolean; flush?: boolean; read?: boolean; close?: boolean; volume?: boolean; parent?: boolean; links?: boolean; info?: boolean } = {};
  const row = (handle: bigint) => { const value = rows.get(handle); if (!value || !held.has(handle) || value.removed) throw new ScopedCodingFileError("boundary"); return value; };
  const touch = (value: Row) => { value.info.changed = String(ticks++); value.info.written = String(ticks++); };
  const api: WindowsCodingNative = {
    ownerSid: "S-1-5-21-1001",
    pin() { throw new Error("A continuation may not open any original or private pathname."); },
    open() { throw new Error("Materialization only uses fresh creation tokens."); },
    info(handle) {
      const value = row(handle);
      if (handle !== ROOT && faults.info && !infoFailure) { infoFailure = true; throw new ScopedCodingFileError("io"); }
      return { ...value.info };
    },
    assertPrivate(handle) { row(handle); },
    list(handle, maximum) {
      row(handle); const children = [...rows.values()].filter(value => value.parent === handle && !value.unlinked);
      if (children.length > maximum) throw new ScopedCodingFileError("limit");
      return children.map(value => ({ name: value.name, id: value.info.id, size: value.info.size, attributes: value.info.attributes }));
    },
    create(parent, name, kind) {
      const base = row(parent); if (base.info.kind !== "directory" || [...rows.values()].some(value => value.parent === parent && value.name === name && !value.unlinked)) throw new ScopedCodingFileError("boundary");
      const handle = next++, value: Row = { handle, parent, name,
        info: { id: `fresh-${handle}`, volume: faults.volume ? "another-volume" : VOLUME,
          finalPath: faults.parent ? VOLUME + "outside\\" + name : base.info.finalPath + "\\" + name, kind, attributes: kind === "directory" ? 0x10 : 0x20,
          links: faults.links && kind === "file" ? 2 : 1, size: 0, created: String(ticks++), written: "0", changed: "0" },
        body: Buffer.alloc(0), written: false, removed: false, unlinked: false };
      rows.set(handle, value); held.add(handle); touch(base); events.push(`create:${name}`); return handle;
    },
    write(handle, bytes) {
      const value = row(handle); if (value.info.kind !== "file" || value.written) throw new ScopedCodingFileError("boundary");
      value.written = true; writeInputs.push(bytes); value.body = Buffer.from(bytes); value.info.size = bytes.length; touch(value); events.push(`write:${value.name}`);
      if (faults.write) throw new ScopedCodingFileError("io");
    },
    flush(handle) { const value = row(handle); events.push(`flush:${value.name}`); if (faults.flush) throw new ScopedCodingFileError("io"); },
    read(handle, offset, maximum) {
      const value = row(handle); if (maximum > 1024 * 1024) throw new ScopedCodingFileError("limit");
      const bytes = Buffer.from(value.body.subarray(offset, offset + maximum));
      if (faults.read && offset === 0 && bytes.length) bytes[0] ^= 1;
      readBuffers.push(bytes); events.push(`read:${value.name}`); return bytes;
    },
    replace() { throw new Error("Continuation creation never replaces an old inode."); },
    remove(handle) {
      if (handle === ROOT) throw new Error("The caller owns the root.");
      const value = row(handle); if (value.parent === undefined || !held.has(value.parent)) throw new ScopedCodingFileError("boundary");
      if ([...rows.values()].some(child => child.parent === handle && !child.unlinked)) throw new ScopedCodingFileError("not-empty");
      value.removed = true; removed.push(handle); touch(row(value.parent)); events.push(`remove:${value.name}`);
    },
    close(handle) {
      if (handle === ROOT) throw new Error("The caller owns the borrowed root.");
      if (!held.has(handle)) throw new Error("No close may be retried.");
      closed.push(handle); events.push(`close:${rows.get(handle)?.name}`);
      if (faults.close) { faults.close = false; throw new native.WindowsCodingCleanupError(); }
      held.delete(handle); const value = rows.get(handle); if (value?.removed) value.unlinked = true;
    },
  };
  const input = (baseline = tree(file("app.ts", "original\n")), proposed = tree(file("app.ts", "changed\n"))): CodingWorkspaceContinuation => ({ baseline, proposed, current: () => predecessorCurrent });
  const check = () => { if (!current) throw new ScopedCodingFileError("cancelled"); };
  const prepare = (value = input(), signal?: AbortSignal) => helpers.prepareWindowsCodingContinuation(value, binding(), value.scope?.source.excludedRoots ?? [], privacyScope, signal, check);
  return { ...helpers, api, root, rows, held, closed, removed, events, readBuffers, writeInputs, faults, scans, scanners, scanEntered, privacyScope, retire, prepare, input, check,
    stop() { current = false; }, revokePredecessor() { predecessorCurrent = false; }, revokePrivacy() { epoch++; },
    gateScan() { return scanGate = deferred(); }, failScannerClose() { scannerCloseFailure = true; },
  };
}

describe("Windows continuation intake", () => {
  it("clones both complete trees synchronously, rebinds them and creates only proposed fresh bytes", async () => {
    const f = await setup(), value = f.input(tree(file("app.ts", "original\n"), file("deleted.txt", "old\n")), tree(directory("empty"), directory("src"), file("src/app.ts", "changed\n")));
    const fresh = binding(), seed = f.prepareWindowsCodingContinuation(value, fresh, [], f.privacyScope, undefined, f.check);
    for (const entry of [...value.baseline.entries, ...value.proposed.entries]) if (entry.kind === "file") entry.bytes.fill(0);
    value.baseline.entries = []; value.proposed.entries = []; fresh.session = randomUUID();
    const result = await f.materializeWindowsCodingContinuation(seed, f.api, ROOT, f.check);
    expect(result.baseline.entries).toEqual([file("app.ts", "original\n"), file("deleted.txt", "old\n")]);
    expect(result.baseline.binding.session).not.toBe(fresh.session);
    expect([...f.rows.values()].filter(row => row.handle !== ROOT).map(row => row.name).sort()).toEqual(["app.ts", "empty", "src"]);
    expect([...f.rows.values()].find(row => row.name === "app.ts")?.body.toString()).toBe("changed\n");
    expect(f.closed).not.toContain(ROOT); expect(f.removed).toEqual([]); expect(f.held).toEqual(new Set([ROOT]));
    expect(f.readBuffers.every(bytes => bytes.every(value => value === 0))).toBe(true);
    expect(f.writeInputs.every(bytes => bytes.every(value => value === 0))).toBe(true);
    seed.dispose(); expect(result.baseline.entries).toEqual([file("app.ts", "original\n"), file("deleted.txt", "old\n")]);
  });
  it.each(["owner", "session", "snapshot"] as const)("rejects a mismatched proposed %s binding before native work", async key => {
    const f = await setup(), value = f.input(); value.proposed.binding[key] = key === "owner" ? "b".repeat(64) : randomUUID();
    expect(() => f.prepare(value)).toThrow(); expect(f.events).toEqual([]);
  });
  it("rejects a different new owner, changed omissions and dependency metadata", async () => {
    const f = await setup(), value = { ...f.input(), scope: scope() };
    expect(() => f.prepareWindowsCodingContinuation(value, { ...binding(), owner: "b".repeat(64) }, value.scope.source.excludedRoots, f.privacyScope, undefined, f.check)).toThrow();
    expect(() => f.prepareWindowsCodingContinuation(value, binding(), [], f.privacyScope, undefined, f.check)).toThrow();
    value.scope.dependencies = { access: "copied-read-only", mount: "/work/node_modules", files: 0, bytes: 0, sha256: "a".repeat(64), materializedLinks: [] };
    expect(() => f.prepare(value)).toThrow(); expect(f.events).toEqual([]);
  });
  it("rejects Windows names, case aliases, missing parents, excluded roots and executable metadata", async () => {
    const f = await setup(), invalid = [tree(file("CON.txt", "bad")), tree(file("a.txt", "one"), file("A.txt", "two")), tree(file("absent/a.txt", "bad")),
      tree(file("app.ts", "executable", true)), tree(directory("Node_Modules")), tree(file("bad:stream", "bad")), tree(file("trailing. ", "bad"))];
    for (const proposed of invalid) expect(() => f.prepare({ ...f.input(tree(), proposed), scope: scope() })).toThrow();
    expect(f.events).toEqual([]);
  });
  it("enforces per-file, per-tree, smaller current limits and shared-memory bounds before scanning", async () => {
    const f = await setup();
    for (const proposed of [tree(file("huge.txt", Buffer.alloc(4 * 1024 * 1024 + 1))), tree(file("a", Buffer.alloc(4 * 1024 * 1024)), file("b", Buffer.alloc(4 * 1024 * 1024)), file("c", Buffer.alloc(3 * 1024 * 1024))), tree(file("shared", Buffer.from(new SharedArrayBuffer(1))))])
      expect(() => f.prepare(f.input(tree(), proposed))).toThrow();
    const lower = { entries: 1, depth: 1, fileBytes: 2, workspaceBytes: 2, resultBytes: 1, searchMatches: 1 };
    expect(() => f.prepareWindowsCodingContinuation(f.input(tree(), tree(file("app.ts", "three"))), binding(), [], f.privacyScope, undefined, f.check, lower)).toThrow();
    expect(() => f.prepare(f.input(tree(), tree(...Array.from({ length: 10_001 }, (_, index) => directory(`dir-${index}`)))))).toThrow();
    const nested = Array.from({ length: 65 }, (_, index) => directory(Array.from({ length: index + 1 }, () => "dir").join("/")));
    expect(() => f.prepare(f.input(tree(), tree(...nested)))).toThrow();
    expect(f.scans).toEqual([]); expect(f.events).toEqual([]);
  });
  it("refuses aborted, stale or disposed seeds without allocating native files", async () => {
    const f = await setup(), abort = new AbortController(); abort.abort(); expect(() => f.prepare(f.input(), abort.signal)).toThrow();
    const seed = f.prepare(); seed.dispose(); seed.dispose();
    await expect(f.materializeWindowsCodingContinuation(seed, f.api, ROOT, f.check)).rejects.toThrow();
    f.revokePredecessor(); expect(() => f.prepare()).toThrow(); expect(f.events).toEqual([]);
  });
});

describe("Windows continuation privacy and native materialization", () => {
  it("scans unchanged files in both baseline and proposed under the original privacy scope before any creation", async () => {
    const f = await setup(), seed = f.prepare(f.input(tree(file("same.txt", "unchanged\n")), tree(file("same.txt", "unchanged\n"))));
    const gate = f.gateScan(), pending = f.materializeWindowsCodingContinuation(seed, f.api, ROOT, f.check);
    await f.scanEntered.promise; expect(f.events).toEqual([]); gate.resolve(); const result = await pending;
    expect(f.scans).toEqual(["unchanged\n", "unchanged\n"]); expect(result.baseline.entries).toEqual([file("same.txt", "unchanged\n")]);
    expect(f.scanners.every(scanner => scanner.scope === f.privacyScope && scanner.closeCalls === 1)).toBe(true);
  });
  it.each(["baseline", "proposed"] as const)("rejects complete secret text in the %s before creating any file", async side => {
    const f = await setup(), value = f.input(); value[side] = tree(file("app.ts", "safe-prefix\n" + "x".repeat(3000) + "SECRET_SENTINEL\n"));
    const seed = f.prepare(value); await expect(f.materializeWindowsCodingContinuation(seed, f.api, ROOT, f.check)).rejects.toThrow();
    expect(f.events).toEqual([]); expect(f.scans.some(text => text.includes("SECRET_SENTINEL"))).toBe(true);
  });
  it("preserves admitted non-UTF8 bytes while scanning all valid UTF8 content", async () => {
    const f = await setup(), binary = Buffer.from([0, 255, 7]), seed = f.prepare(f.input(tree(file("binary.dat", binary)), tree(file("binary.dat", binary), file("empty.txt", ""))));
    const result = await f.materializeWindowsCodingContinuation(seed, f.api, ROOT, f.check);
    expect(result.baseline.entries).toEqual([file("binary.dat", binary)]); expect(f.scans).toEqual([""]);
    expect([...f.rows.values()].find(row => row.name === "binary.dat")?.body).toEqual(binary);
  });
  it.each(["stop", "predecessor", "privacy"] as const)("revokes materialization during a delayed privacy scan (%s)", async reason => {
    const f = await setup(), seed = f.prepare(), gate = f.gateScan(), pending = f.materializeWindowsCodingContinuation(seed, f.api, ROOT, f.check);
    const rejected = pending.catch(error => error); await f.scanEntered.promise;
    if (reason === "stop") f.stop(); else if (reason === "predecessor") f.revokePredecessor(); else f.revokePrivacy();
    gate.resolve(); expect(await rejected).toBeInstanceOf(Error); expect(f.events).toEqual([]);
  });
  it("closes and refuses a privacy worker with unknown shutdown before any native work", async () => {
    const f = await setup(), seed = f.prepare(); f.failScannerClose();
    await expect(f.materializeWindowsCodingContinuation(seed, f.api, ROOT, f.check)).rejects.toThrow(); expect(f.events).toEqual([]);
  });
  it("requires a fresh empty borrowed COPY root and never removes pre-existing data", async () => {
    const f = await setup(), existing = f.api.create(ROOT, "unowned.txt", "file"); f.api.close(existing); const before = [...f.events];
    await expect(f.materializeWindowsCodingContinuation(f.prepare(), f.api, ROOT, f.check)).rejects.toThrow();
    expect(f.events).toEqual(before); expect(f.removed).toEqual([]); expect(f.closed).not.toContain(ROOT);
  });
  it.each(["write", "flush", "read"] as const)("rolls back only exact fresh children after %s failure", async failure => {
    const f = await setup(), seed = f.prepare(f.input(tree(), tree(directory("src"), file("src/app.ts", "changed\n")))); f.faults[failure] = true;
    await expect(f.materializeWindowsCodingContinuation(seed, f.api, ROOT, f.check)).rejects.toThrow();
    expect(f.removed.map(handle => f.rows.get(handle)?.name)).toEqual(["app.ts", "src"]); expect(f.held).toEqual(new Set([ROOT]));
    expect(f.closed).not.toContain(ROOT); expect(f.events.filter(event => event === "write:app.ts")).toHaveLength(1);
    expect(f.events.indexOf("remove:app.ts")).toBeLessThan(f.events.indexOf("close:app.ts"));
    expect(f.events.indexOf("close:app.ts")).toBeLessThan(f.events.indexOf("remove:src"));
  });
  it("owns a returned creation token before its first fallible info query", async () => {
    const f = await setup(), seed = f.prepare(); f.faults.info = true;
    await expect(f.materializeWindowsCodingContinuation(seed, f.api, ROOT, f.check)).rejects.toThrow();
    expect(f.removed).toHaveLength(1); expect(f.closed).toEqual(f.removed); expect(f.held).toEqual(new Set([ROOT]));
  });
  it("retains and retires an unexpected root child without deleting content outside its creation ledger", async () => {
    const f = await setup(), seed = f.prepare(); let foreign: bigint | undefined;
    const check = () => {
      f.check();
      if (foreign === undefined && f.events.includes("write:app.ts")) {
        foreign = f.api.create(ROOT, "unscanned.txt", "file"); f.api.close(foreign);
      }
    };
    await expect(f.materializeWindowsCodingContinuation(seed, f.api, ROOT, check)).rejects.toBeInstanceOf(f.WindowsCodingContinuationCleanupError);
    expect(f.retire).toHaveBeenCalled(); expect(f.removed).not.toContain(foreign); expect(f.closed).not.toContain(ROOT);
    expect(f.rows.get(foreign!)?.removed).toBe(false);
  });
  it.each(["volume", "parent", "links"] as const)("rejects a forged fresh child %s receipt", async failure => {
    const f = await setup(), seed = f.prepare(); f.faults[failure] = true;
    await expect(f.materializeWindowsCodingContinuation(seed, f.api, ROOT, f.check)).rejects.toThrow();
    expect(f.events.some(event => event.startsWith("write:"))).toBe(false); expect(f.closed).not.toContain(ROOT);
  });
  it("makes an unverified child close terminal and never retries a possibly recycled token", async () => {
    const f = await setup(), seed = f.prepare(); f.faults.close = true;
    await expect(f.materializeWindowsCodingContinuation(seed, f.api, ROOT, f.check)).rejects.toBeInstanceOf(f.WindowsCodingContinuationCleanupError);
    expect(f.retire).toHaveBeenCalled(); expect(new Set(f.closed).size).toBe(f.closed.length); expect(f.closed).not.toContain(ROOT);
    await expect(f.materializeWindowsCodingContinuation(seed, f.api, ROOT, f.check)).rejects.toThrow(); expect(new Set(f.closed).size).toBe(f.closed.length);
  });
});
