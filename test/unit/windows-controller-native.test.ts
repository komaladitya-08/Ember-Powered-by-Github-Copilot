/** Portable ACL and FFI ownership/fault checks. Actual Windows SDK/native storage is tested in the Server lane. */
import { afterEach, expect, it, vi } from "vitest";
import type { WindowsCodingInfo, WindowsCodingNative } from "../../app/main/agent/windows-coding-native";
import type { WindowsControllerAcl } from "../../app/main/agent/windows-controller-native";

afterEach(() => { vi.restoreAllMocks(); vi.resetModules(); });
const USER = "S-1-5-21-1-2-3-1001", OWNER = "S-1-5-32-544", SYSTEM = "S-1-5-18", ALL = 0x1f01ff;
const volume = "\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\";
const acl = (directory = false, fixed = false): WindowsControllerAcl => ({ owner: fixed ? USER : OWNER, control: fixed ? 0x1004 : 0x404,
  aces: [USER, SYSTEM].map(sid => ({ type: 0, flags: (directory ? 3 : 0) | (fixed ? 0 : 0x10), mask: ALL, sid })) });

async function fixture(deferBinding = false) {
  vi.resetModules();
  const module = await import("../../app/main/agent/windows-controller-native");
  const { ScopedCodingFileError } = await import("../../app/main/agent/coding-platform");
  interface Row { info: WindowsCodingInfo; acl: WindowsControllerAcl; removed: boolean }
  const rows = new Map<bigint, Row>(), objects = new Map<bigint, { row: Row; info: WindowsCodingInfo }>();
  const strings = new Map<bigint, string>(), sids = new Map<bigint, string>([[91n, USER], [92n, OWNER]]);
  const descriptors = new Map<bigint, WindowsControllerAcl>(), acls = new Map<bigint, WindowsControllerAcl>(), aceHeaders = new Map<bigint, Buffer>();
  const opened: { raw: bigint; path: string; access: number; share: number; disposition: number; flags: number }[] = [], closed: bigint[] = [], frees: bigint[] = [], queries: number[] = [];
  const dispositions: { raw: bigint; flags: number; kind: number }[] = [];
  let next = 100n, address = 10_000n, failMetadata = false, failClose = false, failFree = false, disposition: number | "unknown" = 0;
  let rawPatch: Partial<WindowsCodingInfo> | undefined, onSecurity: ((row: Row) => void) | undefined;
  let tokenFault: "false-output" | "throw-output" | "throw-empty" | undefined;
  const add = (handle: bigint, suffix: string, directory = false, fixed = false) => {
    rows.set(handle, { info: { id: handle.toString(16).padStart(16, "0"), volume: volume.toLowerCase(), finalPath: volume + suffix,
      kind: directory ? "directory" : "file", attributes: directory ? 0x10 : 0x80, links: 1, size: directory ? 0 : 7, created: "1", written: "2", changed: "3" }, acl: acl(directory, fixed), removed: false });
  };
  add(1n, "controller", true, true); add(2n, "controller\\state.json"); add(3n, "controller\\state", true); add(4n, "controller\\state\\session.json"); add(5n, "unrelated\\auth.json");
  const row = (raw: bigint) => objects.get(raw)!;
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    GetCurrentProcess: () => -1n,
    OpenProcessToken: (...args) => {
      if (tokenFault !== "throw-empty") (args[2] as unknown[])[0] = 90n;
      if (tokenFault === "throw-output" || tokenFault === "throw-empty") throw new Error("synthetic token acquisition completion");
      return tokenFault === "false-output" ? 0 : 1;
    },
    GetTokenInformation: (...args) => { const kind = args[1] as number; queries.push(kind); (args[2] as Buffer).writeBigUInt64LE(kind === 1 ? 91n : 92n); (args[4] as number[])[0] = 16; return 1; },
    ConvertSidToStringSidW: (...args) => { const text = address++; strings.set(text, sids.get(args[0] as bigint)!); (args[1] as unknown[])[0] = text; return 1; },
    LocalFree: (...args) => {
      const raw = args[0] as bigint; frees.push(raw);
      if (failFree && descriptors.has(raw)) { failFree = false; return raw; }
      strings.delete(raw); descriptors.delete(raw); return null;
    },
    CloseHandle: (...args) => { const raw = args[0] as bigint; closed.push(raw); if (failClose && raw !== 90n) { failClose = false; return 0; } objects.delete(raw); return 1; },
    CreateFileW: (...args) => {
      const selected = [...rows.values()].find(candidate => candidate.info.finalPath === args[0]);
      if (!selected) return 0xffffffffffffffffn;
      const raw = next++, info = { ...selected.info, ...rawPatch }; rawPatch = undefined; objects.set(raw, { row: selected, info });
      opened.push({ raw, path: args[0] as string, access: args[1] as number, share: args[2] as number, disposition: args[4] as number, flags: args[5] as number }); return raw;
    },
    GetFileType: () => 1,
    GetFileInformationByHandle: (...args) => {
      if (failMetadata) { failMetadata = false; return 0; }
      const info = row(args[0] as bigint).info, bytes = args[1] as Buffer, id = BigInt(`0x${info.id}`);
      bytes.writeUInt32LE(info.attributes, 0); bytes.writeBigUInt64LE(BigInt(info.created), 4); bytes.writeBigUInt64LE(BigInt(info.written), 20);
      bytes.writeUInt32LE(Math.floor(info.size / 0x100000000), 32); bytes.writeUInt32LE(info.size >>> 0, 36); bytes.writeUInt32LE(info.links, 40);
      bytes.writeUInt32LE(Number(id >> 32n), 44); bytes.writeUInt32LE(Number(id & 0xffffffffn), 48); return 1;
    },
    GetFileInformationByHandleEx: (...args) => {
      const info = row(args[0] as bigint).info, bytes = args[2] as Buffer;
      bytes.writeBigUInt64LE(BigInt(info.created), 0); bytes.writeBigUInt64LE(BigInt(info.written), 16); bytes.writeBigUInt64LE(BigInt(info.changed), 24); bytes.writeUInt32LE(info.attributes, 32); return 1;
    },
    GetFinalPathNameByHandleW: (...args) => { const name = row(args[0] as bigint).info.finalPath; (args[1] as Buffer).write(name, "utf16le"); return name.length; },
    GetSecurityInfo: (...args) => {
      const selected = row(args[0] as bigint).row, security = address; address += 1000n;
      descriptors.set(security, selected.acl); acls.set(security + 200n, selected.acl); sids.set(security + 100n, selected.acl.owner);
      (args[3] as unknown[])[0] = security + 100n; (args[5] as unknown[])[0] = security + 200n; (args[7] as unknown[])[0] = security;
      const callback = onSecurity; onSecurity = undefined; callback?.(selected); return 0;
    },
    GetSecurityDescriptorControl: (...args) => { (args[1] as number[])[0] = descriptors.get(args[0] as bigint)!.control; (args[2] as number[])[0] = 1; return 1; },
    GetAclInformation: (...args) => { (args[1] as Buffer).writeUInt32LE(acls.get(args[0] as bigint)!.aces.length); return 1; },
    GetAce: (...args) => {
      const pointer = args[0] as bigint, index = args[1] as number, ace = acls.get(pointer)!.aces[index], location = pointer + 100n + BigInt(index * 100);
      const header = Buffer.alloc(8); header[0] = ace.type; header[1] = ace.flags; header.writeUInt16LE(20, 2); header.writeUInt32LE(ace.mask, 4);
      aceHeaders.set(location, header); sids.set(location + 8n, ace.sid); (args[2] as unknown[])[0] = location; return 1;
    },
    NtSetInformationFile: (...args) => {
      dispositions.push({ raw: args[0] as bigint, flags: (args[2] as Buffer).readUInt32LE(), kind: args[4] as number });
      if (disposition === "unknown") throw new Error("synthetic unknown disposition completion");
      if (disposition !== 0) return disposition;
      row(args[0] as bigint).row.removed = true; return 0;
    },
  };
  const decode = Object.assign((pointer: bigint) => aceHeaders.get(pointer)!, { string16: (pointer: bigint) => strings.get(pointer)! });
  const bind = () => module.bindWindowsControllerNative({ sizeof: () => 8, decode } as unknown as Parameters<typeof module.bindWindowsControllerNative>[0],
    () => ({ func: prototype => handlers[/\b(\w+)\s*\(/.exec(prototype)![1]] }));
  const authority = deferBinding ? undefined! : bind();
  const unavailable = (): never => { throw new Error("This fixture has no filesystem creation or data authority"); };
  const api: WindowsCodingNative = { ownerSid: USER, pin: unavailable, info: handle => ({ ...rows.get(handle)!.info }), list: unavailable, open: unavailable, create: unavailable,
    read: unavailable, write: unavailable, flush: unavailable, replace: unavailable, remove: unavailable, close: unavailable,
    assertPrivate: handle => { if (handle !== 1n) throw new ScopedCodingFileError("boundary"); } };
  return { module, authority, bind, api, rows, opened, closed, objects, frees, queries, dispositions, descriptors,
    failMetadata: () => { failMetadata = true; }, failClose: () => { failClose = true; }, failFree: () => { failFree = true; },
    rawPatch: (patch: Partial<WindowsCodingInfo>) => { rawPatch = patch; }, onSecurity: (callback: (selected: Row) => void) => { onSecurity = callback; },
    disposition: (result: number | "unknown") => { disposition = result; }, tokenFault: (fault: NonNullable<typeof tokenFault>) => { tokenFault = fault; } };
}

it("captures actual token user and default owner once and accepts protected roots plus inherited SDK descendants", async () => {
  const f = await fixture(); expect(f.authority.ownerSid).toBe(USER); expect(f.authority.tokenOwnerSid).toBe(OWNER); expect(f.queries).toEqual([1, 4]);
  f.authority.assertFixed(f.rows.get(1n)!.info);
  const boundary = f.authority.boundary(f.api, 1n), directory = boundary.claim(3n, 1n), file = boundary.claim(4n, 3n);
  expect(Object.isFrozen(file)).toBe(true); expect(Object.isFrozen(file.info)).toBe(true); expect(file.info.id).toBe("0000000000000004");
  file.remove(); directory.remove();
  expect(f.rows.get(4n)!.removed).toBe(true); expect(f.rows.get(3n)!.removed).toBe(true); expect(f.rows.get(5n)!.removed).toBe(false);
  expect(f.dispositions).toHaveLength(2); expect(f.dispositions.every(item => item.flags === 1 && item.kind === 64)).toBe(true);
  expect(f.opened.every(item => item.share === 7 && item.disposition === 3 && item.flags === 0x02200000)).toBe(true);
  expect(f.opened.every(item => item.access === 0x20080 || item.access === 0x30080)).toBe(true);
  expect(f.opened.filter(item => item.access & 0x10000)).toHaveLength(2); expect(f.objects.size).toBe(0); expect(f.descriptors.size).toBe(0); expect(f.queries).toEqual([1, 4]);
});

it.each(["false-output", "throw-output"] as const)("retains and closes a returned process token before rejecting failed acquisition (%s)", async fault => {
  const f = await fixture(true); f.tokenFault(fault);
  expect(() => f.bind()).toThrowError(expect.objectContaining({ code: "boundary" }));
  expect(f.closed).toEqual([90n]); expect(f.queries).toEqual([]); expect(f.opened).toEqual([]);
});

it("fences an unknown token acquisition when no returned handle can establish what must be closed", async () => {
  const f = await fixture(true); f.tokenFault("throw-empty"); let failure: unknown;
  try { f.bind(); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(f.module.WindowsControllerNativeCleanupError);
  expect(() => f.bind()).toThrow(failure as Error); expect(f.closed).toEqual([]); expect(f.queries).toEqual([]);
});

it("binds every claim to the minted root, an already claimed direct parent, and the held native identities", async () => {
  const f = await fixture(), boundary = f.authority.boundary(f.api, 1n);
  expect(() => boundary.claim(4n, 3n)).toThrowError(expect.objectContaining({ code: "boundary" }));
  expect(() => boundary.claim(5n, 1n)).toThrowError(expect.objectContaining({ code: "boundary" }));
  expect(() => boundary.claim(1n, 1n)).toThrowError(expect.objectContaining({ code: "boundary" }));
  const file = boundary.claim(2n, 1n); f.rows.get(2n)!.info.id = "0000000000000042";
  expect(() => boundary.claim(2n, 1n)).toThrowError(expect.objectContaining({ code: "boundary" }));
  expect(() => file.remove()).toThrowError(expect.objectContaining({ code: "boundary" })); expect(f.dispositions).toEqual([]);
  f.rows.get(1n)!.info.id = "0000000000000099";
  expect(() => boundary.claim(3n, 1n)).toThrowError(expect.objectContaining({ code: "boundary" })); expect(f.objects.size).toBe(0);
});

it.each(["owner", "principal", "mask", "type", "flags", "extra"])("rejects a widened or unsupported descendant ACL before granting deletion (%s)", async change => {
  const f = await fixture(), boundary = f.authority.boundary(f.api, 1n), selected = f.rows.get(2n)!.acl;
  if (change === "owner") selected.owner = "S-1-5-21-444";
  if (change === "principal") selected.aces = [selected.aces[0], { ...selected.aces[1], sid: "S-1-1-0" }];
  if (change === "mask") selected.aces = [{ ...selected.aces[0], mask: 0x40000 }, selected.aces[1]];
  if (change === "type") selected.aces = [{ ...selected.aces[0], type: 1 }, selected.aces[1]];
  if (change === "flags") selected.aces = [{ ...selected.aces[0], flags: 0x18 }, selected.aces[1]];
  if (change === "extra") selected.aces = [...selected.aces, { ...selected.aces[0] }];
  expect(() => boundary.claim(2n, 1n)).toThrowError(expect.objectContaining({ code: "boundary" }));
  expect(f.dispositions).toEqual([]); expect(f.objects.size).toBe(0); expect(f.descriptors.size).toBe(0);
});

it.each([{ id: "0000000000000042" }, { attributes: 0x480 }, { links: 2 }, { size: 8 }])("rejects a transient query whose object differs from the held native token: %j", async patch => {
  const f = await fixture(), boundary = f.authority.boundary(f.api, 1n); f.rawPatch(patch);
  expect(() => boundary.claim(2n, 1n)).toThrowError(expect.objectContaining({ code: "boundary" }));
  expect(f.dispositions).toEqual([]); expect(f.objects.size).toBe(0);
});

it("rechecks the still-held native token after ACL queries rather than accepting an identity changed during the query", async () => {
  const f = await fixture(), boundary = f.authority.boundary(f.api, 1n); f.onSecurity(selected => { selected.info.id = "0000000000000042"; });
  expect(() => boundary.claim(2n, 1n)).toThrowError(expect.objectContaining({ code: "boundary" })); expect(f.dispositions).toEqual([]); expect(f.objects.size).toBe(0);
});

it("accounts for each transient handle before metadata can fail and never substitutes the caller's owner", async () => {
  const f = await fixture(), boundary = f.authority.boundary(f.api, 1n); f.failMetadata();
  expect(() => boundary.claim(2n, 1n)).toThrowError(expect.objectContaining({ code: "boundary" }));
  expect(f.objects.size).toBe(0); expect(f.closed).toContain(f.opened.at(-1)!.raw);
  expect(() => f.authority.boundary({ ...f.api, ownerSid: OWNER }, 1n)).toThrowError(expect.objectContaining({ code: "boundary" }));
});

it.each(["close", "free", "disposition"])("retains unknown native completion and rejects every subsequent call without retrying it (%s)", async kind => {
  const f = await fixture(), boundary = f.authority.boundary(f.api, 1n);
  let failure: unknown;
  if (kind === "disposition") {
    const file = boundary.claim(2n, 1n); f.disposition("unknown"); try { file.remove(); } catch (error) { failure = error; }
  } else {
    if (kind === "close") f.failClose(); else f.failFree();
    try { boundary.claim(2n, 1n); } catch (error) { failure = error; }
  }
  expect(failure).toBeInstanceOf(f.module.WindowsControllerNativeCleanupError);
  const opened = f.opened.length, closes = f.closed.length, frees = f.frees.length;
  expect(() => boundary.claim(3n, 1n)).toThrow(failure as Error);
  expect(() => f.authority.assertFixed(f.rows.get(1n)!.info)).toThrow(failure as Error);
  expect(() => f.module.bindWindowsControllerNative({ sizeof: () => 8 } as never, () => ({ func() {} }))).toThrow(failure as Error);
  expect(f.opened).toHaveLength(opened); expect(f.closed).toHaveLength(closes); expect(f.frees).toHaveLength(frees);
  if (kind === "close") expect(f.objects.size).toBe(1); if (kind === "free") expect(f.descriptors.size).toBe(1);
});

it("treats a returned nonzero NT status as a sanitized refusal while closing its exact transient deletion handle", async () => {
  const f = await fixture(), boundary = f.authority.boundary(f.api, 1n), file = boundary.claim(2n, 1n); f.disposition(0xc0000101);
  expect(() => file.remove()).toThrowError(expect.objectContaining({ code: "boundary" }));
  expect(f.objects.size).toBe(0); expect(f.rows.get(2n)!.removed).toBe(false); expect(() => boundary.claim(3n, 1n)).not.toThrow();
});

it("requires protected explicit user-owned ACLs for fixed roots while allowing only exact explicit or inherited descendant grants", async () => {
  const { assertWindowsControllerAcl } = await import("../../app/main/agent/windows-controller-native");
  expect(() => assertWindowsControllerAcl(acl(true, true), "directory", USER, OWNER, true)).not.toThrow();
  expect(() => assertWindowsControllerAcl(acl(true), "directory", USER, OWNER)).not.toThrow();
  expect(() => assertWindowsControllerAcl({ ...acl(), owner: USER }, "file", USER, OWNER)).not.toThrow();
  expect(() => assertWindowsControllerAcl({ ...acl(true, true), owner: OWNER }, "directory", USER, OWNER, true)).toThrow();
  expect(() => assertWindowsControllerAcl({ ...acl(true, true), control: 4 }, "directory", USER, OWNER, true)).toThrow();
  expect(() => assertWindowsControllerAcl({ ...acl(true), owner: USER, control: 0x1004 }, "directory", USER, OWNER, true)).toThrow();
  expect(() => assertWindowsControllerAcl({ ...acl(), control: 0 }, "file", USER, OWNER)).toThrow();
});
