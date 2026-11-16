/** Portable lifecycle/fault model; native Windows CI separately proves NTFS sharing, identities and ACL enforcement. */
import { afterEach, expect, it, vi } from "vitest";
import path from "node:path/win32";
import type { WindowsCodingNative, WindowsCodingInfo, WindowsCodingPin } from "../../app/main/agent/windows-coding-native";

afterEach(() => { vi.doUnmock("../../app/main/platform/os"); vi.doUnmock("../../app/main/agent/windows-coding-native"); vi.restoreAllMocks(); vi.resetModules(); });

async function setup() {
  vi.resetModules(); vi.doMock("../../app/main/platform/os", () => ({ HOST_PLATFORM: "win32", HOST_ARCH: "x64" }));
  const native = await import("../../app/main/agent/windows-coding-native"), { ScopedCodingFileError } = await import("../../app/main/agent/coding-platform");
  interface Node { info: WindowsCodingInfo; bytes: Buffer; private: boolean }
  const volume = "\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\", nodes = new Map<string, Node>(), handles = new Map<bigint, Node>(), writers = new Set<bigint>();
  let next = 100n, clock = 1, poisoned = false;
  let onRead: (() => void) | undefined, onWrite: ((row: Node) => void) | undefined, sourceReleased: (() => void) | undefined;
  const key = (value: string) => value.toLowerCase(), location = (value: string) => volume + value.slice(3);
  const bump = (row: Node) => { row.info.written = String(clock++); row.info.changed = String(clock++); };
  const node = (absolute: string, kind: "file" | "directory", privateObject = false): Node => {
    const row: Node = { info: { id: String(next++), volume: volume.toLowerCase(), finalPath: absolute, kind,
      attributes: kind === "directory" ? 0x10 : 0x20, links: 1, size: 0, created: String(clock++), written: String(clock++), changed: String(clock++) }, bytes: Buffer.alloc(0), private: privateObject };
    nodes.set(key(absolute), row); return row;
  };
  const put = (absolute: string, bytes: Buffer | string) => {
    const target = location(absolute), row = nodes.get(key(target)) ?? node(target, "file");
    row.bytes = Buffer.from(bytes); row.info.size = row.bytes.length; bump(row); return row;
  };
  for (const absolute of ["C:\\", "C:\\copies", "C:\\reviews", "C:\\protected", "C:\\project", "C:\\exports"]) node(location(absolute), "directory");
  put("C:\\project\\app.ts", "export const answer = 41;\n"); put("C:\\project\\unchanged.bin", Buffer.from([0xff, 0, 0x7f]));
  const value = (handle: bigint) => { if (poisoned) throw new native.WindowsCodingCleanupError(); const row = handles.get(handle); if (!row) throw new ScopedCodingFileError("boundary"); return row; };
  const token = (row: Node) => { const handle = next++; handles.set(handle, row); return handle; };
  const pin = (absolute: string): WindowsCodingPin => {
    const selected = nodes.get(key(location(absolute))); if (!selected || selected.info.kind !== "directory") throw new ScopedCodingFileError("missing");
    const opened = [token(nodes.get(key(volume))!)]; let prefix = "C:\\";
    for (const name of absolute.slice(3).split("\\").filter(Boolean)) {
      prefix = path.join(prefix, name); const row = nodes.get(key(location(prefix))); if (!row) throw new ScopedCodingFileError("missing"); opened.push(token(row));
    }
    return { handle: opened[opened.length - 1], handles: opened, path: absolute };
  };
  const api: WindowsCodingNative = {
    ownerSid: "S-1-5-21-1001", pin, info: handle => ({ ...value(handle).info }),
    list: (handle, maximum) => {
      const parent = value(handle).info.finalPath, rows = [...nodes.values()].filter(row => row.info.finalPath !== parent && path.dirname(row.info.finalPath) === parent);
      if (rows.length > maximum) throw new ScopedCodingFileError("limit");
      return rows.map(row => ({ name: path.basename(row.info.finalPath), id: row.info.id, attributes: row.info.attributes, size: row.info.size }));
    },
    open: (parent, name, kind) => { const row = nodes.get(key(path.join(value(parent).info.finalPath, name))); if (!row || row.info.kind !== kind) throw new ScopedCodingFileError("missing"); return token(row); },
    create: (parent, name, kind) => {
      const container = value(parent), target = path.join(container.info.finalPath, name); if (nodes.has(key(target))) throw new ScopedCodingFileError("exists");
      const row = node(target, kind, true); bump(container); const handle = token(row); if (kind === "file") writers.add(handle); return handle;
    },
    read: (handle, offset, length) => { const row = value(handle), callback = onRead; onRead = undefined; callback?.(); return Buffer.from(row.bytes.subarray(offset, offset + length)); },
    write: (handle, bytes) => { const row = value(handle); row.bytes = Buffer.from(bytes); row.info.size = bytes.length; bump(row); onWrite?.(row); },
    flush: handle => { value(handle); },
    replace: (handle, parent, name, existing) => {
      const row = value(handle), container = value(parent), target = path.join(container.info.finalPath, name);
      if (!existing && nodes.has(key(target))) throw new ScopedCodingFileError("exists");
      nodes.delete(key(row.info.finalPath)); row.info.finalPath = target; nodes.set(key(target), row); bump(container);
    },
    remove: handle => {
      const row = value(handle);
      if ([...nodes.values()].some(child => child !== row && path.dirname(child.info.finalPath) === row.info.finalPath)) throw new ScopedCodingFileError("not-empty");
      nodes.delete(key(row.info.finalPath)); const parent = nodes.get(key(path.dirname(row.info.finalPath))); if (parent) bump(parent);
    },
    assertPrivate: handle => { if (!value(handle).private) throw new ScopedCodingFileError("boundary"); },
    close: handle => {
      const row = value(handle); if (writers.delete(handle)) bump(row); handles.delete(handle);
      if (row.info.finalPath === location("C:\\project") && ![...handles.values()].includes(row)) { const callback = sourceReleased; sourceReleased = undefined; callback?.(); }
    },
  };
  vi.doMock("../../app/main/agent/windows-coding-native", () => ({ ...native, loadWindowsCodingNative: () => api,
    retireWindowsCodingNative: () => { poisoned = true; return new native.WindowsCodingCleanupError(); } }));
  const { WindowsCodingArtifactStore } = await import("../../app/main/agent/windows-coding-artifact-store");
  const { WindowsCodingCopy } = await import("../../app/main/agent/windows-coding-copy");
  const { WindowsScopedCodingFiles } = await import("../../app/main/agent/windows-scoped-coding-files");
  const { createCodingReviewExport, decodeCodingReviewExport } = await import("../../app/main/agent/coding-result-export");
  const store = await WindowsCodingArtifactStore.create({ privateBase: "C:\\reviews", protectedPaths: ["C:\\protected"] });
  const binding = { owner: "a".repeat(64), session: "11111111-1111-4111-8111-111111111111", snapshot: "22222222-2222-4222-8222-222222222222" };
  let current = true, controllerClosed = true;
  const signal = new AbortController();
  const create = () => WindowsCodingCopy.create({ source: "C:\\project", privateBase: "C:\\copies", protectedPaths: ["C:\\protected"], signal: signal.signal, current: () => true,
    review: { store, binding, current: () => current, controllerClosed: () => controllerClosed } });
  return { api, nodes, handles, location, put, create, store, binding, createCodingReviewExport, decodeCodingReviewExport, WindowsScopedCodingFiles,
    revoke: () => { current = false; }, closeController: (closed: boolean) => { controllerClosed = closed; },
    onRead: (callback: () => void) => { onRead = callback; }, onWrite: (callback: (row: Node) => void) => { onWrite = callback; },
    rebindAfterIntake: () => { sourceReleased = () => { node(location("C:\\project"), "directory"); put("C:\\project\\app.ts", "replacement source\n"); }; } };
}

it("keeps the full intake baseline and seals actual copied edits after Stop without reopening ordinary files", async () => {
  const f = await setup(), copy = await f.create(), broker = await f.WindowsScopedCodingFiles.create({ copy, signal: new AbortController().signal });
  await broker.writeText("app.ts", "export const answer = 42;\n"); await broker.close(); await copy.stop();
  const producer = await copy.exportReview(), output = producer.transfer();
  expect(output.cleanup).toBe("retained");
  expect(output.review.binding).toEqual(f.binding);
  const before = output.review.baseline.find(entry => entry.path === "app.ts")!, after = output.review.proposed.find(entry => entry.path === "app.ts")!;
  expect(before.kind === "file" && Buffer.from(before.base64, "base64").toString()).toBe("export const answer = 41;\n");
  expect(after.kind === "file" && Buffer.from(after.base64, "base64").toString()).toBe("export const answer = 42;\n");
  expect(output.review.current).toEqual(output.review.baseline); expect(output.review.patchComplete).toBe(true);
  expect(output.review.baseline.find(entry => entry.path === "unchanged.bin")).toEqual(output.review.proposed.find(entry => entry.path === "unchanged.bin"));
  expect(f.nodes.get(f.location("C:\\project\\app.ts").toLowerCase())!.bytes.toString()).toBe("export const answer = 41;\n");
  await expect(copy.files(async () => undefined)).rejects.toMatchObject({ code: "cancelled" });
  const receipt = await f.store.claim(output, () => undefined), bytes = await f.store.read(receipt, "review.json", 64 * 1024 * 1024, () => undefined);
  const decoded = f.decodeCodingReviewExport(bytes, f.binding);
  expect(f.createCodingReviewExport(decoded).review).toEqual(output.review); bytes.fill(0);
  for (const tree of [decoded.baseline, decoded.proposed, decoded.current]) for (const entry of tree?.entries ?? []) if (entry.kind === "file") entry.bytes.fill(0);
  await copy.close(); expect(f.store.size).toBe(1); await f.store.cleanup(new Set()); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("refuses a source rebound between its original provenance receipt and the copy's intake pin", async () => {
  const f = await setup(); f.rebindAfterIntake();
  await expect(f.create()).rejects.toMatchObject({ code: "boundary" });
  expect([...f.nodes.values()].filter(row => row.info.finalPath.startsWith(f.location("C:\\copies") + "\\"))).toEqual([]);
  await f.store.close(); expect(f.handles.size).toBe(0);
});

it("requires trusted controller closure before sealed review and never reopens the stopped broker", async () => {
  const f = await setup(), copy = await f.create(); f.closeController(false); await copy.stop();
  await expect(copy.exportReview()).rejects.toMatchObject({ code: "boundary" });
  expect(f.store.size).toBe(0); await expect(copy.withTree(async () => undefined)).rejects.toMatchObject({ code: "cancelled" });
  await copy.close(); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("releases a newly opened original file when its first metadata query fails during current capture", async () => {
  const f = await setup(), copy = await f.create(); await copy.stop();
  const info = f.api.info.bind(f.api); let refused = false;
  vi.spyOn(f.api, "info").mockImplementation(handle => {
    const result = info(handle);
    if (!refused && result.finalPath === f.location("C:\\project\\app.ts")) { refused = true; throw new Error("synthetic metadata refusal"); }
    return result;
  });
  const producer = await copy.exportReview(); expect(refused).toBe(true); expect(producer.output.review.current).toBeNull();
  await producer.discard(); await copy.close(); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("revokes a sealed read after one payload chunk and clears every partially read full-file buffer", async () => {
  const f = await setup(); f.put("C:\\project\\app.ts", "ordinary text\n".repeat(10_000));
  const copy = await f.create(); await copy.stop(); const captured: Buffer[] = [], alloc = Buffer.alloc.bind(Buffer), size = Buffer.byteLength("ordinary text\n".repeat(10_000));
  vi.spyOn(Buffer, "alloc").mockImplementation(((...args: Parameters<typeof Buffer.alloc>) => { const bytes = alloc(...args); if (bytes.length === size) captured.push(bytes); return bytes; }) as typeof Buffer.alloc);
  f.onRead(f.revoke);
  await expect(copy.exportReview()).rejects.toMatchObject({ code: "cancelled" });
  expect(captured.length).toBeGreaterThan(0); expect(captured.every(bytes => bytes.every(byte => byte === 0))).toBe(true);
  vi.restoreAllMocks(); expect(f.store.size).toBe(0); await copy.close(); await f.store.close(); expect(f.handles.size).toBe(0);
});

it("drains a close during the first artifact write and reclaims only its exact unpublished producer", async () => {
  const f = await setup(), copy = await f.create(); await copy.stop(); let closing: Promise<void> | undefined;
  f.onWrite(row => { if (row.info.finalPath.startsWith(f.location("C:\\reviews") + "\\") && !closing) closing = copy.close(); });
  await expect(copy.exportReview()).rejects.toBeDefined(); await closing;
  expect(f.store.size).toBe(0); await f.store.close(); expect(f.handles.size).toBe(0);
});
