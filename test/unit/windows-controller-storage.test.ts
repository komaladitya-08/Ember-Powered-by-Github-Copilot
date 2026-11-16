/** Portable ownership model; actual Windows CI separately proves inherited ACLs and native delete semantics. */
import path from "node:path/win32";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import type { WindowsCodingInfo, WindowsCodingNative, WindowsCodingPin } from "../../app/main/agent/windows-coding-native";
import type { WindowsControllerNative } from "../../app/main/agent/windows-controller-native";

beforeAll(async () => {
  // Keep cold module transformation outside operation timing; every fault fixture still resets its instances.
  await import("../../app/main/agent/windows-controller-storage");
  vi.resetModules();
});
afterEach(() => { vi.doUnmock("../../app/main/agent/windows-coding-native"); vi.doUnmock("../../app/main/agent/windows-controller-native"); vi.restoreAllMocks(); vi.resetModules(); });

async function setup() {
  vi.resetModules();
  const native = await import("../../app/main/agent/windows-coding-native"), { ScopedCodingFileError } = await import("../../app/main/agent/coding-platform");
  interface Node { info: WindowsCodingInfo; fixed: boolean; pending: boolean; bytes: Buffer }
  const volume = "\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\", nodes = new Map<string, Node>(), handles = new Map<bigint, Node>();
  const closed: bigint[] = [], fixedAssertions: string[] = [], nativeRemovals: string[] = [], claims: string[] = [], dispositions: string[] = [];
  let next = 100n, clock = 1, poisoned = false;
  let infoFailure: string | undefined, onCreate: ((name: string) => void) | undefined;
  const key = (value: string) => value.toLowerCase(), location = (value: string) => value.startsWith("C:\\") ? volume + value.slice(3) : value;
  const bump = (row: Node) => { row.info.changed = String(clock++); row.info.written = String(clock++); };
  const node = (absolute: string, kind: "directory" | "file", fixed = false): Node => {
    const row: Node = { info: { id: (next++).toString(16).padStart(16, "0"), volume: volume.toLowerCase(), finalPath: location(absolute), kind,
      attributes: kind === "directory" ? 0x10 : 0x20, links: 1, size: 0, created: String(clock++), changed: String(clock++), written: String(clock++) }, fixed, pending: false, bytes: Buffer.alloc(0) };
    nodes.set(key(row.info.finalPath), row); return row;
  };
  node("C:\\", "directory"); node("C:\\user-data", "directory");
  const auth = node("C:\\user-data\\auth.bin", "file"); auth.bytes = Buffer.from("host-only-canary"); auth.info.size = auth.bytes.length;
  const value = (handle: bigint) => { if (poisoned) throw new native.WindowsCodingCleanupError(); const row = handles.get(handle); if (!row) throw new ScopedCodingFileError("boundary"); return row; };
  const token = (row: Node) => { const handle = next++; handles.set(handle, row); return handle; };
  const children = (row: Node) => [...nodes.values()].filter(child => child !== row && path.dirname(child.info.finalPath) === row.info.finalPath);
  const remove = (row: Node) => { if (children(row).length) throw new ScopedCodingFileError("not-empty"); row.pending = true; dispositions.push(row.info.finalPath); };
  const pin = (absolute: string): WindowsCodingPin => {
    const opened = [token(nodes.get(key(volume))!)]; let logical = "C:\\";
    try {
      for (const name of absolute.slice(3).split("\\").filter(Boolean)) {
        logical = path.join(logical, name); const row = nodes.get(key(location(logical)));
        if (!row || row.info.kind !== "directory") throw new ScopedCodingFileError("missing"); opened.push(token(row));
      }
      return { handle: opened[opened.length - 1], handles: opened, path: absolute };
    } catch (error) { for (const handle of opened) handles.delete(handle); throw error; }
  };
  const api: WindowsCodingNative = {
    ownerSid: "S-1-5-21-1001", pin,
    info: handle => { const row = value(handle); if (infoFailure && row.info.finalPath.endsWith("\\" + infoFailure)) { infoFailure = undefined; throw new ScopedCodingFileError("conflict"); } return { ...row.info }; },
    list: (handle, maximum) => { const rows = children(value(handle)); if (rows.length > maximum) throw new ScopedCodingFileError("limit"); return rows.map(row => ({ name: path.basename(row.info.finalPath), id: row.info.id, attributes: row.info.attributes, size: row.info.size })); },
    create: (parent, name, kind) => {
      const folder = value(parent), absolute = path.join(folder.info.finalPath, name); if (nodes.has(key(absolute))) throw new ScopedCodingFileError("exists");
      const row = node(absolute, kind, true), handle = token(row); bump(folder); onCreate?.(name); return handle;
    },
    open: (parent, name, kind) => { const row = nodes.get(key(path.join(value(parent).info.finalPath, name))); if (!row || row.info.kind !== kind) throw new ScopedCodingFileError("missing"); return token(row); },
    assertPrivate: handle => { const row = value(handle); fixedAssertions.push(row.info.finalPath); if (!row.fixed) throw new ScopedCodingFileError("boundary"); },
    remove: handle => { const row = value(handle); nativeRemovals.push(row.info.finalPath); if (!row.fixed) throw new ScopedCodingFileError("boundary"); remove(row); },
    close: handle => {
      const row = value(handle); closed.push(handle); handles.delete(handle);
      // A delete-pending child remains in its namespace until its final held token closes.
      if (row.pending && ![...handles.values()].includes(row)) { nodes.delete(key(row.info.finalPath)); const parent = nodes.get(key(path.dirname(row.info.finalPath))); if (parent) bump(parent); }
    },
    read: () => { throw new Error("Controller storage never reads SDK or host file bodies"); },
    write: () => { throw new Error("Controller storage never writes existing file bodies"); },
    flush: () => { throw new Error("Controller storage never flushes SDK data"); },
    replace: () => { throw new Error("Controller storage never renames existing objects"); },
  };
  const security: WindowsControllerNative = { ownerSid: api.ownerSid, tokenOwnerSid: api.ownerSid,
    assertFixed: info => { const row = nodes.get(key(info.finalPath)); if (!row?.fixed || row.info.id !== info.id) throw new ScopedCodingFileError("boundary"); },
    boundary: (_api, root) => {
      const directory = value(root).info.finalPath;
      return { claim: (handle, parent) => {
        const row = value(handle), folder = value(parent);
        if (!row.info.finalPath.startsWith(directory + "\\") || path.dirname(row.info.finalPath) !== folder.info.finalPath) throw new ScopedCodingFileError("boundary");
        claims.push(row.info.finalPath); const expected = { ...row.info };
        return { info: expected, remove: () => { if (value(handle).info.id !== expected.id) throw new ScopedCodingFileError("boundary"); remove(row); } };
      } };
    },
  };
  vi.doMock("../../app/main/agent/windows-coding-native", () => ({ ...native, loadWindowsCodingNative: () => api,
    retireWindowsCodingNative: () => { poisoned = true; return new native.WindowsCodingCleanupError(); } }));
  vi.doMock("../../app/main/agent/windows-controller-native", async original => ({ ...await original<typeof import("../../app/main/agent/windows-controller-native")>(), loadWindowsControllerNative: () => security }));
  const { allocateWindowsControllerStorage } = await import("../../app/main/agent/windows-controller-storage");
  return { allocate: (signal?: AbortSignal) => allocateWindowsControllerStorage("C:\\user-data", signal), nodes, handles, location, closed, fixedAssertions, nativeRemovals, claims, dispositions, auth,
    sdk: (absolute: string, kind: "directory" | "file" = "file") => node(absolute, kind),
    actorRemove: (absolute: string) => { nodes.delete(key(location(absolute))); },
    failInfo: (name: string) => { infoFailure = name; }, onCreate: (callback: (name: string) => void) => { onCreate = callback; },
    row: (absolute: string) => nodes.get(key(location(absolute)))!,
  };
}

it("mints four protected roles and removes inherited SDK descendants only through separate boundary claims", async () => {
  const f = await setup(), storage = await f.allocate(), root = storage.paths.root;
  expect(Object.keys(storage.paths).sort()).toEqual(["cwd", "home", "root", "state", "temporary"]);
  expect([storage.paths.cwd, storage.paths.home, storage.paths.state, storage.paths.temporary].map(value => path.basename(value))).toEqual(["cwd", "home", "state", "tmp"]);
  for (const absolute of Object.values(storage.paths)) expect(f.row(absolute).fixed).toBe(true);
  const sdkDirectory = path.join(storage.paths.state, "session"), sdkFile = path.join(sdkDirectory, "transcript.json");
  f.sdk(sdkDirectory, "directory"); f.sdk(sdkFile); f.sdk(path.join(storage.paths.home, "cache.json"));
  await storage.close();
  expect(f.claims).toContain(f.location(sdkFile)); expect(f.fixedAssertions).not.toContain(f.location(sdkFile)); expect(f.nativeRemovals).not.toContain(f.location(sdkFile));
  expect(f.dispositions.indexOf(f.location(sdkFile))).toBeLessThan(f.dispositions.indexOf(f.location(sdkDirectory)));
  expect(f.nodes.has(f.location(root).toLowerCase())).toBe(false); expect(f.row("C:\\user-data").fixed).toBe(false);
  expect(f.auth.bytes.toString()).toBe("host-only-canary"); expect(f.handles.size).toBe(0);
});

it("keeps another controller's uncertainty after one owner closes and admits again only after both retire", async () => {
  const f = await setup(), first = await f.allocate(), second = await f.allocate();
  for (let index = 0; index < 20; index++) f.sdk(path.join(first.paths.state, `sdk-${index}.json`));
  second.retire(); const closing = first.close();
  await expect(f.allocate()).rejects.toMatchObject({ code: "windows-controller-storage-unverified" }); await closing;
  await expect(f.allocate()).rejects.toMatchObject({ code: "windows-controller-storage-unverified" });
  second.verify(); await second.close(); const next = await f.allocate(); await next.close(); expect(f.handles.size).toBe(0);
});

it("refuses unknown parent state without deleting a live controller or an unrelated actor's file", async () => {
  const f = await setup(), storage = await f.allocate(), unknown = path.join(path.dirname(storage.paths.root), "unknown.bin"); f.sdk(unknown);
  await expect(f.allocate()).rejects.toMatchObject({ code: "windows-controller-storage-unverified" });
  expect(f.row(unknown)).toBeDefined(); storage.verify(); await storage.close(); expect(f.row(unknown)).toBeDefined();
  f.actorRemove(unknown); const next = await f.allocate(); await next.close(); expect(f.handles.size).toBe(0);
});

it.each(["namespace", "acl"])("retains a controller whose fixed %s changed and never deletes the replacement", async kind => {
  const f = await setup(), storage = await f.allocate(), root = storage.paths.root;
  if (kind === "namespace") f.sdk(root, "directory"); else f.row(storage.paths.home).fixed = false;
  expect(() => storage.verify()).toThrow(); const closing = storage.close(); await expect(closing).rejects.toThrow(); expect(storage.close()).toBe(closing);
  await expect(f.allocate()).rejects.toMatchObject({ code: "windows-controller-storage-unverified" });
  expect(f.row(root)).toBeDefined(); expect(f.dispositions).toEqual([]); expect(f.handles.size).toBeGreaterThan(0);
});

it("tracks a freshly minted child before its failing metadata query and closes all known creation pins", async () => {
  const f = await setup(); f.failInfo("state");
  await expect(f.allocate()).rejects.toThrow(); expect(f.handles.size).toBe(0);
  expect([...f.nodes.values()].some(row => /\\controller-/.test(row.info.finalPath))).toBe(false);
  const next = await f.allocate(); await next.close(); expect(f.auth.bytes.toString()).toBe("host-only-canary");
});

it("closes a newly opened inherited child when its cleanup metadata cannot be verified", async () => {
  const f = await setup(), storage = await f.allocate(); f.sdk(path.join(storage.paths.state, "fault.json"));
  const held = f.handles.size; f.failInfo("fault.json");
  await expect(storage.close()).rejects.toThrow(); expect(f.handles.size).toBe(held);
  expect(f.claims.some(value => value.endsWith("fault.json"))).toBe(false);
  await expect(f.allocate()).rejects.toMatchObject({ code: "windows-controller-storage-unverified" });
});

it("closes every temporary ancestor pin when checking another live controller's metadata fails", async () => {
  const f = await setup(), first = await f.allocate(), held = f.handles.size; f.failInfo(path.basename(first.paths.root));
  await expect(f.allocate()).rejects.toMatchObject({ code: "conflict" }); expect(f.handles.size).toBe(held);
  first.verify(); const next = await f.allocate(); await next.close(); await first.close(); expect(f.handles.size).toBe(0);
});

it("removes only its fresh roles when startup aborts during allocation and leaves the parent unchanged", async () => {
  const f = await setup(), signal = new AbortController(); f.onCreate(name => { if (name === "home") signal.abort(); });
  await expect(f.allocate(signal.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(f.handles.size).toBe(0); expect([...f.nodes.values()].some(row => /\\controller-/.test(row.info.finalPath))).toBe(false);
  expect(f.auth.bytes.toString()).toBe("host-only-canary"); expect(f.row("C:\\user-data").fixed).toBe(false);
});
