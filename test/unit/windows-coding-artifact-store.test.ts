import { afterEach, expect, it, vi } from "vitest";
import path from "node:path/win32";
import type { WindowsCodingNative, WindowsCodingInfo, WindowsCodingPin } from "../../app/main/agent/windows-coding-native";
import "../../app/main/agent/windows-coding-policy";

afterEach(() => { vi.doUnmock("../../app/main/platform/os"); vi.doUnmock("../../app/main/agent/windows-coding-native"); vi.restoreAllMocks(); vi.resetModules(); });

/** Ownership/fault model only; the dedicated Windows lane exercises real NTFS behavior. */
async function setup() {
  vi.resetModules(); vi.doMock("../../app/main/platform/os", () => ({ HOST_PLATFORM: "win32", HOST_ARCH: "x64" }));
  const native = await import("../../app/main/agent/windows-coding-native"), { ScopedCodingFileError } = await import("../../app/main/agent/coding-platform");
  const { CodingResultRegistryError } = await import("../../app/main/agent/coding-artifact-store");
  interface Node { info: WindowsCodingInfo; bytes: Buffer; private: boolean }
  const volume = "\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\", nodes = new Map<string, Node>(), handles = new Map<bigint, Node>();
  const closed: bigint[] = [], removed: string[] = [], createdRoots: string[] = [], uncertain = new Set<bigint>(), writers = new Set<bigint>();
  let next = 100n, clock = 1, poison = false, failClose = false, failOpen = false, tamperOpen = false, failRemove: "known" | "unknown" | null = null, writes = 0;
  let onRead: (() => void) | undefined;
  let onReaderEof: ((row: Node) => void) | undefined;
  const key = (value: string) => value.toLowerCase(), location = (value: string) => volume + value.slice(3);
  const node = (value: string, kind: "file" | "directory", privateObject = false): Node => {
    const row: Node = { info: { id: String(next++), volume: volume.toLowerCase(), finalPath: value, kind, attributes: kind === "directory" ? 0x10 : 0x20,
      links: 1, size: 0, created: String(clock++), written: String(clock++), changed: String(clock++) }, bytes: Buffer.alloc(0), private: privateObject };
    nodes.set(key(value), row); return row;
  };
  const value = (handle: bigint) => { if (poison) throw new native.WindowsCodingCleanupError(); const row = handles.get(handle); if (!row) throw new ScopedCodingFileError("boundary"); return row; };
  const token = (row: Node) => { const handle = next++; handles.set(handle, row); return handle; };
  const bump = (row: Node) => { row.info.written = String(clock++); row.info.changed = String(clock++); };
  const directories = ["C:\\", "C:\\private", "C:\\protected", "C:\\project", "C:\\exports", "C:\\other"];
  for (const directory of directories) node(location(directory), "directory");
  const pin = (absolute: string): WindowsCodingPin => {
    const selected = nodes.get(key(location(absolute))); if (!selected || selected.info.kind !== "directory") throw new ScopedCodingFileError(selected ? "unsupported" : "missing");
    const root = nodes.get(key(volume))!, parts = absolute.slice(3).split("\\").filter(Boolean), opened = [token(root)]; let prefix = "C:\\";
    for (const part of parts) { prefix = path.join(prefix, part); const row = nodes.get(key(location(prefix))); if (!row) throw new ScopedCodingFileError("missing"); opened.push(token(row)); }
    return { handle: opened[opened.length - 1], handles: opened, path: absolute };
  };
  const api: WindowsCodingNative = {
    ownerSid: "S-1-5-21-1001", pin,
    info: handle => ({ ...value(handle).info }),
    list: (handle, maximum) => {
      const parent = value(handle).info.finalPath, rows = [...nodes.values()].filter(row => path.dirname(row.info.finalPath) === parent && row.info.finalPath !== parent);
      if (rows.length > maximum) throw new ScopedCodingFileError("limit");
      return rows.map(row => ({ name: path.basename(row.info.finalPath), id: row.info.id, attributes: row.info.attributes, size: row.info.size }));
    },
    open: (parent, name, kind, mode) => {
      const row = nodes.get(key(path.join(value(parent).info.finalPath, name)));
      if (mode === "copy" && failOpen) {
        failOpen = false;
        if (tamperOpen && row) { tamperOpen = false; row.bytes[0] ^= 1; bump(row); }
        throw new ScopedCodingFileError("conflict");
      }
      if (!row || row.info.kind !== kind) throw new ScopedCodingFileError("missing"); return token(row);
    },
    create: (parent, name, kind) => {
      const container = value(parent), target = path.join(container.info.finalPath, name); if (nodes.has(key(target))) throw new ScopedCodingFileError("exists");
      const row = node(target, kind, true); bump(container); if (kind === "directory") createdRoots.push(target); const handle = token(row); if (kind === "file") writers.add(handle); return handle;
    },
    read: (handle, offset, length) => {
      const row = value(handle), callback = onRead; onRead = undefined; callback?.();
      if (!writers.has(handle) && offset === row.bytes.length && length === 1) { const finished = onReaderEof; onReaderEof = undefined; finished?.(row); }
      return Buffer.from(row.bytes.subarray(offset, offset + length));
    },
    write: (handle, bytes) => { const row = value(handle); row.bytes = Buffer.from(bytes); row.info.size = bytes.length; bump(row); writes++; },
    flush: handle => { value(handle); }, replace: () => { throw new Error("Artifacts never rename existing host files."); },
    remove: handle => {
      const row = value(handle);
      if (failRemove) { const failure = failRemove; failRemove = null; if (failure === "unknown") throw new Error("unknown native completion"); const error = new ScopedCodingFileError("conflict"); Object.defineProperty(error, "cause", { value: { status: 0xc0000043 } }); throw error; }
      if ([...nodes.values()].some(child => path.dirname(child.info.finalPath) === row.info.finalPath && child !== row)) throw new ScopedCodingFileError("not-empty");
      nodes.delete(key(row.info.finalPath)); removed.push(row.info.finalPath); const parent = nodes.get(key(path.dirname(row.info.finalPath))); if (parent) bump(parent);
    },
    assertPrivate: handle => { if (!value(handle).private) throw new ScopedCodingFileError("boundary"); },
    close: handle => {
      closed.push(handle); if (uncertain.has(handle)) throw new native.WindowsCodingCleanupError(); if (failClose) { failClose = false; uncertain.add(handle); poison = true; throw new native.WindowsCodingCleanupError(); }
      const row = handles.get(handle); if (!row) throw new ScopedCodingFileError("boundary");
      // Windows can finalize last-write timestamps only when its last writing handle closes.
      if (writers.delete(handle)) bump(row); handles.delete(handle);
    },
  };
  vi.doMock("../../app/main/agent/windows-coding-native", () => ({ ...native, loadWindowsCodingNative: () => api,
    retireWindowsCodingNative: () => { poison = true; return new native.WindowsCodingCleanupError(); } }));
  const { WindowsCodingArtifactStore } = await import("../../app/main/agent/windows-coding-artifact-store");
  const store = await WindowsCodingArtifactStore.create({ privateBase: "C:\\private", protectedPaths: ["C:\\protected"] });
  const files = { "review.json": Buffer.from("{\"review\":true}"), "changes.patch": Buffer.from("patch\n") }, check = () => undefined;
  return { store, files, check, nodes, handles, closed, removed, createdRoots, volume, location, CodingResultRegistryError,
    failClose: () => { failClose = true; }, failOpen: (tamper = false) => { failOpen = true; tamperOpen = tamper; }, failRemove: (kind: "known" | "unknown") => { failRemove = kind; },
    onRead: (callback: () => void) => { onRead = callback; }, writes: () => writes,
    onReaderEof: (callback: (row: Node) => void) => { onReaderEof = callback; }, externalPoison: () => { poison = true; },
    addUnknown: (root: string) => node(path.join(root, "unknown.txt"), "file", true), replaceSource: () => node(location("C:\\project"), "directory") };
}

it("mints one-time producer references and verifies exact receipt object identity", async () => {
  const f = await setup(), output = await f.store.write(f.files, f.check);
  expect(f.store.validSourcePath("C:\\" + ("é".repeat(127) + "\\").repeat(16) + "é".repeat(7))).toBe(false);
  await expect(f.store.claim({ directory: output.directory }, f.check)).rejects.toMatchObject({ code: "invalid" });
  await expect(f.store.claim({ ...output, artifact: Object.freeze({}) as typeof output.artifact }, f.check)).rejects.toMatchObject({ code: "invalid" });
  const receipt = await f.store.claim(output, f.check);
  await expect(f.store.claim(output, f.check)).rejects.toMatchObject({ code: "invalid" });
  await expect(f.store.verify({ ...receipt }, f.check)).rejects.toMatchObject({ code: "invalid" });
  await f.store.verify(receipt, f.check); await f.store.cleanup(new Set([receipt.ref])); expect(f.store.size).toBe(1);
  await f.store.cleanup(new Set()); expect(f.store.size).toBe(0); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("reads complete bounded bytes only through the original claimed receipt", async () => {
  const f = await setup(), output = await f.store.write(f.files, f.check), receipt = await f.store.claim(output, f.check);
  const read = await f.store.read(receipt, "review.json", f.files["review.json"].length, f.check);
  expect(read).toEqual(f.files["review.json"]); read.fill(0);
  expect(await f.store.read(receipt, "review.json", 64 * 1024 * 1024, f.check)).toEqual(f.files["review.json"]);
  await expect(f.store.read({ ...receipt }, "review.json", 64, f.check)).rejects.toMatchObject({ code: "invalid" });
  await expect(f.store.read(receipt, "../review.json" as "review.json", 64, f.check)).rejects.toMatchObject({ code: "invalid" });
  await f.store.cleanup(new Set()); await expect(f.store.read(receipt, "review.json", 64, f.check)).rejects.toMatchObject({ code: "invalid" });
  await f.store.close(); expect(f.handles.size).toBe(0);
});

it("rejects invalid or insufficient read budgets before allocating any artifact payload", async () => {
  const f = await setup(), output = await f.store.write(f.files, f.check), receipt = await f.store.claim(output, f.check);
  const allocating = vi.spyOn(Buffer, "alloc");
  for (const budget of [-1, NaN, Infinity, 0.5, 64 * 1024 * 1024 + 1]) await expect(f.store.read(receipt, "review.json", budget, f.check)).rejects.toMatchObject({ code: "invalid" });
  await expect(f.store.read(receipt, "review.json", f.files["review.json"].length - 1, f.check)).rejects.toMatchObject({ code: "limit" });
  expect(allocating).not.toHaveBeenCalled(); allocating.mockRestore(); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("attests both exact artifact hashes before returning either requested file", async () => {
  const f = await setup(), output = await f.store.write(f.files, f.check), receipt = await f.store.claim(output, f.check);
  const file = f.nodes.get(path.join(f.createdRoots[0], "review.json").toLowerCase())!; file.bytes[0] ^= 1;
  await expect(f.store.read(receipt, "changes.patch", 64, f.check)).rejects.toMatchObject({ code: "artifact" });
  file.bytes[0] ^= 1; await f.store.verify(receipt, f.check); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("zeroes the selected result when authority is revoked during its final artifact recheck", async () => {
  const f = await setup(), output = await f.store.write(f.files, f.check), receipt = await f.store.claim(output, f.check);
  const allocations: Buffer[] = [], alloc = Buffer.alloc.bind(Buffer); let current = true, reviews = 0;
  vi.spyOn(Buffer, "alloc").mockImplementation(((...args: Parameters<typeof Buffer.alloc>) => {
    const result = alloc(...args); allocations.push(result); return result;
  }) as typeof Buffer.alloc);
  const eof = (row: { info: WindowsCodingInfo }) => {
    if (row.info.finalPath.endsWith("\\review.json") && ++reviews === 2) f.onRead(() => { current = false; });
    else f.onReaderEof(eof);
  };
  f.onReaderEof(eof);
  await expect(f.store.read(receipt, "review.json", 64, () => { if (!current) throw new Error("one owned request retired"); })).rejects.toMatchObject({ code: "stale" });
  expect(reviews).toBe(2); expect(allocations.length).toBeGreaterThan(2);
  expect(allocations.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
  vi.restoreAllMocks(); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("matches only current source capabilities from the same store and original native identity", async () => {
  const f = await setup(), original = await f.store.sourceBoundary("C:\\project", f.check), fresh = await f.store.sourceBoundary("C:\\project", f.check);
  expect(original).not.toBeNull(); expect(fresh).not.toBeNull(); expect(await f.store.sameSource(original, fresh, f.check)).toBe(true);
  expect(await f.store.sameSource(original, null, f.check)).toBe(false);
  expect(await f.store.sameSource(original, Object.freeze({}) as NonNullable<typeof fresh>, f.check)).toBe(false);
  const { WindowsCodingArtifactStore } = await import("../../app/main/agent/windows-coding-artifact-store");
  const other = await WindowsCodingArtifactStore.create({ privateBase: "C:\\other", protectedPaths: ["C:\\protected"] });
  const foreign = await other.sourceBoundary("C:\\project", f.check); expect(await f.store.sameSource(original, foreign, f.check)).toBe(false);
  await other.close(); f.replaceSource();
  const replacement = await f.store.sourceBoundary("C:\\project", f.check);
  expect(await f.store.sameSource(original, replacement, f.check)).toBe(false);
  expect(await f.store.sameSource(original, fresh, f.check)).toBe(false);
  await f.store.close(); expect(f.handles.size).toBe(0);
});

it("propagates a one-shot source authority failure instead of converting it to an unmatched source", async () => {
  const f = await setup(), original = await f.store.sourceBoundary("C:\\project", f.check), fresh = await f.store.sourceBoundary("C:\\project", f.check);
  let checks = 0;
  await expect(f.store.sameSource(original, fresh, () => { if (++checks === 2) throw new Error("retired once"); })).rejects.toMatchObject({ code: "stale" });
  expect(await f.store.sameSource(original, fresh, f.check)).toBe(true); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("keeps unknown source-pin close completion terminal for every later admission", async () => {
  const f = await setup(), original = await f.store.sourceBoundary("C:\\project", f.check), fresh = await f.store.sourceBoundary("C:\\project", f.check);
  f.failClose(); const failure = await f.store.sameSource(original, fresh, f.check).catch(error => error);
  expect(failure).toMatchObject({ code: "coding-artifact-cleanup-unverified" });
  await expect(f.store.sameSource(null, null, f.check)).rejects.toBe(failure); await expect(f.store.close()).rejects.toBe(failure);
});

it("keeps producer ownership through unrelated cleanup and rejects forged-directory discard", async () => {
  const f = await setup(), output = await f.store.write(f.files, f.check);
  await f.store.cleanup(new Set()); expect(f.store.size).toBe(1);
  await expect(f.store.discard({ directory: output.directory })).rejects.toMatchObject({ code: "invalid" });
  await expect(f.store.discard({ ...output, directory: "C:\\other" })).rejects.toMatchObject({ code: "invalid" });
  expect(f.store.size).toBe(1); await f.store.discard(output); expect(f.store.size).toBe(0); await f.store.close();
});

it("acknowledges only exact verified-removed capabilities without touching a later replacement or reviving claims", async () => {
  const f = await setup(), output = await f.store.write(f.files, f.check), receipt = await f.store.claim(output, f.check);
  await f.store.cleanup(new Set()); const removed = f.removed.length;
  await f.store.discard(output); await f.store.discard({ ...output });
  expect(f.removed.length).toBe(removed); expect(f.store.size).toBe(0);
  await expect(f.store.claim(output, f.check)).rejects.toMatchObject({ code: "invalid" });
  await expect(f.store.verify(receipt, f.check)).rejects.toMatchObject({ code: "invalid" });
  await expect(f.store.discard({ directory: output.directory })).rejects.toMatchObject({ code: "invalid" });
  await expect(f.store.discard({ ...output, directory: "C:\\other" })).rejects.toMatchObject({ code: "invalid" });
  await expect(f.store.discard({ ...output, artifact: Object.freeze({}) as typeof output.artifact })).rejects.toMatchObject({ code: "invalid" });
  const replacement = f.addUnknown(f.createdRoots[0]); await f.store.discard(output);
  expect(f.nodes.get(replacement.info.finalPath.toLowerCase())).toBe(replacement); expect(f.removed.length).toBe(removed);
  await f.store.close(); expect(f.handles.size).toBe(0);
});

it("does not acknowledge a removed capability through a later terminal cleanup failure", async () => {
  const f = await setup(), previous = await f.store.write(f.files, f.check); await f.store.discard(previous);
  const live = await f.store.write(f.files, f.check); await f.store.claim(live, f.check); f.failRemove("unknown");
  let failure: unknown; try { await f.store.cleanup(new Set()); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: "coding-artifact-cleanup-unverified" });
  await expect(f.store.discard(previous)).rejects.toBe(failure); await expect(f.store.discard(live)).rejects.toBe(failure);
  await expect(f.store.close()).rejects.toBe(failure);
});

it("consumes a legitimate producer claim before failed verification and retains unknown children", async () => {
  const f = await setup(), output = await f.store.write(f.files, f.check), extra = f.addUnknown(f.createdRoots[0]);
  await expect(f.store.claim(output, f.check)).rejects.toMatchObject({ code: "artifact" });
  await expect(f.store.claim(output, f.check)).rejects.toMatchObject({ code: "invalid" });
  await expect(f.store.cleanup(new Set())).rejects.toMatchObject({ code: "cleanup" }); expect(f.removed).toEqual([]);
  f.nodes.delete(extra.info.finalPath.toLowerCase()); await f.store.cleanup(new Set()); expect(f.store.size).toBe(0); await f.store.close();
});

it("closes an exact private root after a failed writer-to-reader transfer", async () => {
  const f = await setup(); f.failOpen();
  await expect(f.store.write(f.files, f.check)).rejects.toMatchObject({ code: "artifact" });
  expect(f.store.size).toBe(0); expect(f.removed).toContain(f.createdRoots[0]); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("retains a modified pending transfer when its exact reader hash no longer matches", async () => {
  const f = await setup(); f.failOpen(true);
  await expect(f.store.write(f.files, f.check)).rejects.toMatchObject({ code: "artifact" }); expect(f.store.size).toBe(1); expect(f.removed).toEqual([]);
  await expect(f.store.cleanup(new Set())).rejects.toMatchObject({ code: "cleanup" }); expect(f.removed).toEqual([]);
  await expect(f.store.close()).rejects.toMatchObject({ code: "cleanup" }); expect(f.handles.size).toBe(0); expect(f.nodes.has(f.createdRoots[0].toLowerCase())).toBe(true);
});

it("never settles changed timestamps on a published immutable file", async () => {
  const f = await setup(), output = await f.store.write(f.files, f.check), receipt = await f.store.claim(output, f.check);
  const file = f.nodes.get(path.join(f.createdRoots[0], "review.json").toLowerCase())!; file.info.changed = "host-change";
  await expect(f.store.verify(receipt, f.check)).rejects.toMatchObject({ code: "artifact" });
  await expect(f.store.cleanup(new Set())).rejects.toMatchObject({ code: "cleanup" }); expect(f.removed).toEqual([]);
  await expect(f.store.close()).rejects.toMatchObject({ code: "cleanup" }); expect(f.handles.size).toBe(0);
});

it("never recaptures changed reader metadata when its publication guard becomes stale", async () => {
  const f = await setup(); let stale = false;
  f.onReaderEof(row => { row.info.changed = "external-reader-change"; stale = true; });
  const check = () => { if (stale) throw new f.CodingResultRegistryError("stale"); };
  await expect(f.store.write(f.files, check)).rejects.toMatchObject({ code: "stale" }); expect(f.store.size).toBe(1); expect(f.removed).toEqual([]);
  await expect(f.store.cleanup(new Set())).rejects.toMatchObject({ code: "cleanup" }); expect(f.removed).toEqual([]);
  await expect(f.store.close()).rejects.toMatchObject({ code: "cleanup" }); expect(f.handles.size).toBe(0);
});

it("preserves a process-wide native cleanup failure observed from another store", async () => {
  const f = await setup(), output = await f.store.write(f.files, f.check); await f.store.claim(output, f.check); f.externalPoison();
  let failure: unknown; try { await f.store.cleanup(new Set()); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: "coding-artifact-cleanup-unverified" });
  await expect(f.store.close()).rejects.toBe(failure); expect(f.handles.size).toBe(0); expect(f.store.size).toBe(1);
});

it("retries a known deletion refusal without losing exact root or file ownership", async () => {
  const f = await setup(), output = await f.store.write(f.files, f.check); await f.store.claim(output, f.check); f.failRemove("known");
  await expect(f.store.cleanup(new Set())).rejects.toMatchObject({ code: "cleanup" }); expect(f.store.size).toBe(1);
  await f.store.cleanup(new Set()); expect(f.store.size).toBe(0); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("retains unknown disposition completion as a terminal cleanup barrier", async () => {
  const f = await setup(), output = await f.store.write(f.files, f.check); await f.store.claim(output, f.check); f.failRemove("unknown");
  let failure: unknown; try { await f.store.cleanup(new Set()); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: "coding-artifact-cleanup-unverified" }); expect(f.store.size).toBe(1);
  await expect(f.store.write(f.files, f.check)).rejects.toBe(failure); await expect(f.store.close()).rejects.toBe(failure);
});

it("attempts an uncertain CloseHandle once, drains other handles and shares the cached failure", async () => {
  const f = await setup(); f.failClose(); let failure: unknown;
  try { await f.store.write(f.files, f.check); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: "coding-artifact-cleanup-unverified" }); const failedHandle = f.closed[0];
  const first = f.store.close(), second = f.store.close(); expect(first).toBe(second);
  await expect(first).rejects.toBe(failure); expect(f.closed.filter(handle => handle === failedHandle)).toHaveLength(1);
  expect(f.handles.size).toBe(1); await expect(f.store.write(f.files, f.check)).rejects.toBe(failure);
});

it("revokes an in-flight readback synchronously on close and mints no later files", async () => {
  const f = await setup(); let closing: Promise<void> | undefined;
  f.onRead(() => { queueMicrotask(() => { closing = f.store.close(); }); });
  await expect(f.store.write(f.files, f.check)).rejects.toMatchObject({ code: "stale" }); await closing;
  expect(f.writes()).toBe(1); expect(f.store.size).toBe(0); expect(f.handles.size).toBe(0);
});

it("publishes explicit user exports after final verification and leaves them after private cleanup", async () => {
  const f = await setup(), output = await f.store.write(f.files, f.check), receipt = await f.store.claim(output, f.check), source = await f.store.sourceBoundary("C:\\project", f.check);
  const result = await f.store.export(receipt, source, "C:\\exports", f.check); expect(result.ok).toBe(true);
  await f.store.cleanup(new Set()); await f.store.close(); expect(f.store.size).toBe(0); expect(f.handles.size).toBe(0);
  const root = f.location(result.directory!); expect(f.nodes.get(root.toLowerCase())?.private).toBe(true);
  expect(f.nodes.get(path.join(root, "review.json").toLowerCase())?.bytes).toEqual(f.files["review.json"]);
});

it("removes partial user exports after a revoked publication guard", async () => {
  const f = await setup(), output = await f.store.write(f.files, f.check), receipt = await f.store.claim(output, f.check), source = await f.store.sourceBoundary("C:\\project", f.check);
  const check = () => { if (f.createdRoots.length > 1 && f.writes() > 2) throw new f.CodingResultRegistryError("stale"); };
  const result = await f.store.export(receipt, source, "C:\\exports", check); expect(result.ok).toBe(false); expect(f.store.size).toBe(1);
  expect(f.nodes.has(f.createdRoots[1].toLowerCase())).toBe(false); await f.store.cleanup(new Set()); await f.store.close();
});

it("removes a freshly minted empty export when authority is revoked before its first write", async () => {
  const f = await setup(), output = await f.store.write(f.files, f.check), receipt = await f.store.claim(output, f.check), source = await f.store.sourceBoundary("C:\\project", f.check);
  const check = () => { if (f.createdRoots.length > 1) throw new f.CodingResultRegistryError("stale"); };
  const result = await f.store.export(receipt, source, "C:\\exports", check); expect(result.ok).toBe(false); expect(f.store.size).toBe(1);
  expect(f.nodes.has(f.createdRoots[1].toLowerCase())).toBe(false); expect(f.writes()).toBe(2); await f.store.cleanup(new Set()); await f.store.close();
});

it("keeps an intake source identity through source-path replacement and refuses export", async () => {
  const f = await setup(), source = await f.store.sourceBoundary("C:\\project", f.check); expect(source).not.toBeNull(); f.replaceSource();
  expect(await f.store.sourceBoundary("C:\\project", f.check, source!)).toBe(source);
  await expect(f.store.sourceBoundary("C:\\other", f.check, source!)).rejects.toMatchObject({ code: "invalid" });
  const output = await f.store.write(f.files, f.check), receipt = await f.store.claim(output, f.check);
  expect((await f.store.export(receipt, source, "C:\\exports", f.check)).ok).toBe(false);
  expect(f.createdRoots).toHaveLength(1); await f.store.cleanup(new Set()); await f.store.close();
});

it("bounds queued producers before allocation and revokes their captured buffers on close", async () => {
  const f = await setup(), pending = Array.from({ length: 64 }, () => f.store.write(f.files, f.check));
  await expect(f.store.write(f.files, f.check)).rejects.toMatchObject({ code: "limit" });
  const createdBeforeClose = f.createdRoots.length, closing = f.store.close(); const results = await Promise.allSettled(pending); expect(results.every(result => result.status === "rejected")).toBe(true);
  await closing; expect(f.createdRoots).toHaveLength(createdBeforeClose); expect(f.handles.size).toBe(0);
});

it("reads input file getters once and rechecks synchronous revocation before copying", async () => {
  const f = await setup(); let reads = 0, closing: Promise<void> | undefined;
  const files = Object.defineProperty({ "changes.patch": Buffer.from("patch") }, "review.json", { enumerable: true,
    get: () => { reads++; closing = f.store.close(); return Buffer.from("{}"); } }) as typeof f.files;
  await expect(f.store.write(files, f.check)).rejects.toMatchObject({ code: "stale" }); expect(reads).toBe(1); await closing;
  expect(f.createdRoots).toHaveLength(0); expect(f.handles.size).toBe(0);
});

it("snapshots only required producer fields before queueing and ignores unrelated getters", async () => {
  const f = await setup(), output = await f.store.write(f.files, f.check); let reads = 0;
  const input = Object.defineProperties({}, {
    directory: { enumerable: true, get: () => { reads++; return output.directory; } },
    artifact: { enumerable: true, get: () => { reads++; return output.artifact; } },
    unrelated: { enumerable: true, get: () => { throw new Error("Never inspect extra host properties."); } },
  }) as typeof output;
  const receipt = await f.store.claim(input, f.check); expect(reads).toBe(2); await f.store.verify(receipt, f.check);
  await f.store.cleanup(new Set()); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("leaves a producer untouched when required snapshot getters throw", async () => {
  const f = await setup(), output = await f.store.write(f.files, f.check);
  const input = Object.defineProperty({ artifact: output.artifact }, "directory", { get: () => { throw new Error("Host input failure."); } }) as typeof output;
  await expect(f.store.claim(input, f.check)).rejects.toMatchObject({ code: "artifact" });
  const receipt = await f.store.claim(output, f.check); await f.store.verify(receipt, f.check); await f.store.cleanup(new Set()); await f.store.close();
});
