import { expect, it, vi } from "vitest";
import { decodeWindowsCodingDirectoryBatch } from "../../app/main/agent/windows-coding-native";
import { ScopedCodingFileError } from "../../app/main/agent/coding-platform";

function record(name: string, id = 0x100000002n, directory = false): Buffer {
  const text = Buffer.from(name, "utf16le"), size = Math.ceil((104 + text.length) / 8) * 8;
  const bytes = Buffer.alloc(size);
  bytes.writeBigInt64LE(directory ? 0n : 19n, 40); bytes.writeUInt32LE(directory ? 0x10 : 0x20, 56);
  bytes.writeUInt32LE(text.length, 60); bytes.writeBigUInt64LE(id, 96); text.copy(bytes, 104);
  return bytes;
}
function batch(...items: Buffer[]): Buffer {
  for (const item of items.slice(0, -1)) item.writeUInt32LE(item.length, 0);
  return Buffer.concat(items);
}

it("decodes the Win64 native layout, preserving file ids and skipping only literal dot entries", () => {
  const bytes = batch(record(".", 0n, true), record("..", 0n, true), record("source", 9n, true), record("app.ts"));
  expect(decodeWindowsCodingDirectoryBatch(bytes, bytes.length, 2)).toEqual([
    { name: "source", id: "0000000000000009", attributes: 0x10, size: 0 },
    { name: "app.ts", id: "0000000100000002", attributes: 0x20, size: 19 },
  ]);
});

it("bounds native byte counts and entry counts before parsing untrusted offsets", () => {
  const bytes = batch(record("a"), record("b"));
  for (const size of [-1, bytes.length + 1, NaN]) expect(() => decodeWindowsCodingDirectoryBatch(bytes, size, 2)).toThrow(ScopedCodingFileError);
  expect(() => decodeWindowsCodingDirectoryBatch(bytes, bytes.length, 1)).toThrowError(expect.objectContaining({ code: "limit" }));
  expect(() => decodeWindowsCodingDirectoryBatch(bytes, bytes.length, 10_001)).toThrow(ScopedCodingFileError);
});

it("rejects malformed next-entry alignment, overlapping names, and a nonexistent next record", () => {
  for (const next of [8, 105, 112, 0xfffffff8]) {
    const bytes = record("entry"); bytes.writeUInt32LE(next, 0);
    expect(() => decodeWindowsCodingDirectoryBatch(bytes, bytes.length, 2)).toThrow(ScopedCodingFileError);
  }
  const bytes = record("entry"); bytes.writeUInt32LE(bytes.length, 0);
  expect(() => decodeWindowsCodingDirectoryBatch(bytes, bytes.length, 2)).toThrow(ScopedCodingFileError);
});

it("rejects malformed UTF16, zero identities, negative sizes and path-namespace names", () => {
  const odd = record("a"); odd.writeUInt32LE(3, 60);
  expect(() => decodeWindowsCodingDirectoryBatch(odd, odd.length, 1)).toThrow(ScopedCodingFileError);
  const lone = record("a"); lone.writeUInt16LE(0xd800, 104);
  expect(() => decodeWindowsCodingDirectoryBatch(lone, lone.length, 1)).toThrow(ScopedCodingFileError);
  const zero = record("a", 0n), negative = record("a"); negative.writeBigInt64LE(-1n, 40);
  for (const bytes of [zero, negative]) expect(() => decodeWindowsCodingDirectoryBatch(bytes, bytes.length, 1)).toThrow(ScopedCodingFileError);
  for (const name of ["../escape", "stream:token", "NUL.txt", "COM¹", "trailing.", "part\\child", "secret\0tail"]) {
    const bytes = record(name); expect(() => decodeWindowsCodingDirectoryBatch(bytes, bytes.length, 1)).toThrow(ScopedCodingFileError);
  }
});

/** Fault injection for resource ownership only. Native enforcement is exercised in the Windows integration lane. */
function failedCreationNative(options: { descriptorFree?: boolean; invalidCreatedInfo?: boolean; createdClose?: boolean; wrongById?: boolean; byIdFailure?: boolean; deleteClose?: boolean; wrongNamed?: boolean }) {
  const pointers = new Map<bigint, Buffer>(), strings = new Map<bigint, string>();
  type ObjectIdentity = { id: bigint; name: string; relative: string; directory: boolean; key: string };
  const names = new Map<string, ObjectIdentity>(), objects = new Map<bigint, ObjectIdentity & { created: boolean; byId: boolean; access: number }>();
  const rolledBack: bigint[] = [], closed: bigint[] = [], created: bigint[] = [];
  const rejectedByIdDisposition: bigint[] = [];
  const opened: { raw: bigint; parent: bigint; name: string; access: number; share: number; fresh: boolean }[] = [];
  const byId: { raw: bigint; hint: bigint; descriptor: Buffer; access: number; share: number; flags: number }[] = [];
  let nextPointer = 1_000n, nextHandle = 100n, nextString = 50_000n, securityDirectory = false;
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    GetDriveTypeW: () => 3,
    GetVolumeInformationW: (...args) => { (args[6] as Buffer).write("NTFS\0", "utf16le"); return 1; },
    NtCreateFile: (...args) => {
      const attributes = args[2] as Buffer, unicode = pointers.get(attributes.readBigUInt64LE(16))!;
      const text = pointers.get(unicode.readBigUInt64LE(8))!, name = text.toString("utf16le", 0, unicode.readUInt16LE(0));
      const handle = nextHandle++, fresh = args[7] === 2, parent = attributes.readBigUInt64LE(8), parentObject = objects.get(parent), key = parent ? `${parentObject!.id}:${name}` : "drive";
      let identity = names.get(key);
      if (fresh || !parent) { identity = { id: fresh ? handle : 1n, name, relative: parentObject ? `${parentObject.relative ? parentObject.relative + "\\" : ""}${name}` : "", directory: !!(Number(args[8]) & 1), key }; names.set(key, identity); }
      if (!identity) return 0xc0000034;
      objects.set(handle, { ...identity, id: identity.id + (!fresh && Number(args[1]) === 0x1300a0 && options.wrongNamed ? 1n : 0n), created: fresh, byId: false, access: Number(args[1]) }); if (fresh) created.push(handle);
      opened.push({ raw: handle, parent, name, access: Number(args[1]), share: Number(args[6]), fresh });
      (args[0] as unknown[])[0] = handle; return 0;
    },
    OpenFileById: (...args) => {
      if (options.byIdFailure) return 0xffffffffffffffffn;
      const hint = args[0] as bigint, original = objects.get(hint)!, handle = nextHandle++, descriptor = Buffer.from(args[1] as Buffer);
      objects.set(handle, { ...original, id: original.id + (options.wrongById ? 1n : 0n), created: false, byId: true, access: Number(args[2]) });
      byId.push({ raw: handle, hint, descriptor, access: Number(args[2]), share: Number(args[3]), flags: Number(args[5]) }); return handle;
    },
    GetFileType: (...args) => objects.get(args[0] as bigint)?.created && options.invalidCreatedInfo ? 0 : 1,
    GetFileInformationByHandle: (...args) => {
      const row = objects.get(args[0] as bigint)!, bytes = args[1] as Buffer;
      bytes.writeUInt32LE(row.directory ? 0x10 : 0x80, 0); bytes.writeBigUInt64LE(1n, 4); bytes.writeBigUInt64LE(2n, 20);
      bytes.writeUInt32LE(1, 40); bytes.writeUInt32LE(Number(row.id), 48); return 1;
    },
    GetFileInformationByHandleEx: (...args) => {
      const row = objects.get(args[0] as bigint)!, bytes = args[2] as Buffer;
      bytes.writeBigUInt64LE(1n, 0); bytes.writeBigUInt64LE(2n, 16); bytes.writeBigUInt64LE(3n, 24); bytes.writeUInt32LE(row.directory ? 0x10 : 0x80, 32); return 1;
    },
    GetFinalPathNameByHandleW: (...args) => {
      const row = objects.get(args[0] as bigint)!;
      // MS-FSA FileNormalizedNameInformation requires FILE_TRAVERSE on an open-by-ID handle.
      if (row.byId && !(row.access & 0x20)) return 0;
      const location = "\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\" + row.relative;
      (args[1] as Buffer).write(location, "utf16le"); return location.length;
    },
    GetCurrentProcess: () => -1n,
    OpenProcessToken: (...args) => { (args[2] as unknown[])[0] = 90n; return 1; },
    GetTokenInformation: (...args) => { (args[2] as Buffer).writeBigUInt64LE(91n); (args[4] as number[])[0] = 16; return 1; },
    ConvertSidToStringSidW: (...args) => { const pointer = nextString++; strings.set(pointer, args[0] === 10_108n ? "S-1-5-18" : "S-1-5-21-1-2-3-1001"); (args[1] as unknown[])[0] = pointer; return 1; },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: (...args) => { (args[2] as unknown[])[0] = 93n; return 1; },
    GetSecurityInfo: (...args) => {
      securityDirectory = objects.get(args[0] as bigint)!.directory;
      (args[3] as unknown[])[0] = 94n; (args[5] as unknown[])[0] = 95n; (args[7] as unknown[])[0] = 96n; return 0;
    },
    GetSecurityDescriptorControl: (...args) => { (args[1] as number[])[0] = 0x1004; (args[2] as number[])[0] = 1; return 1; },
    GetAclInformation: (...args) => { (args[1] as Buffer).writeUInt32LE(2); return 1; },
    GetAce: (...args) => { (args[2] as unknown[])[0] = 10_000n + BigInt(Number(args[1]) * 100); return 1; },
    GetLastError: () => 5,
    LocalFree: (...args) => options.descriptorFree && args[0] === 93n ? 93n : 0n,
    NtSetInformationFile: (...args) => {
      const raw = args[0] as bigint, value = objects.get(raw)!;
      // Observed NTFS c0b14060 behavior: a disposition through the by-ID file object rejects with INVALID_PARAMETER.
      if (value.byId) { rejectedByIdDisposition.push(raw); return 0xc000000d; }
      rolledBack.push(raw); names.delete(value.key); return 0;
    },
    CloseHandle: (...args) => {
      const handle = args[0] as bigint; closed.push(handle);
      const value = objects.get(handle);
      if (value?.created && options.createdClose || value && !value.created && value.directory && (value.access & 0x10000) && options.deleteClose) return 0;
      objects.delete(handle); return 1;
    },
  };
  const native = {
    sizeof: () => 8,
    address: (bytes: Buffer) => { const pointer = nextPointer++; pointers.set(pointer, bytes); return pointer; },
    decode: Object.assign(() => { const header = Buffer.alloc(8); header[1] = securityDirectory ? 3 : 0; header.writeUInt16LE(28, 2); header.writeUInt32LE(0x1f01ff, 4); return header; },
      { string16: (pointer: bigint) => strings.get(pointer)! }),
  } as unknown as Parameters<typeof import("../../app/main/agent/windows-coding-native").bindWindowsCodingNative>[0];
  const load = () => ({ func(prototype: string) { const name = /\b(\w+)\s*\(/.exec(prototype)![1]; return handlers[name] ?? (() => { throw new Error(`Unexpected test native call: ${name}`); }); } });
  return { native, load, rolledBack, closed, created, opened, byId, rejectedByIdDisposition, live: () => [...objects.keys()] };
}

it("retains a fresh handle before descriptor disposal and rolls it back before closing on LocalFree failure", async () => {
  vi.resetModules(); const module = await import("../../app/main/agent/windows-coding-native"), fake = failedCreationNative({ descriptorFree: true });
  const api = module.bindWindowsCodingNative(fake.native, fake.load), base = api.pin("C:\\", "base");
  expect(() => api.create(base.handle, "fresh-copy", "directory")).toThrow(module.WindowsCodingCleanupError);
  expect(fake.created).toHaveLength(1); expect(fake.rolledBack).toEqual(fake.created); expect(fake.closed).toContain(fake.created[0]);
  expect(() => api.info(base.handle)).toThrow(module.WindowsCodingCleanupError);
  expect(() => module.bindWindowsCodingNative(fake.native, fake.load)).toThrow(module.WindowsCodingCleanupError);
  for (const handle of base.handles.slice().reverse()) api.close(handle);
});

it("rolls back a fresh native object when validation fails before capability ownership transfers", async () => {
  vi.resetModules(); const module = await import("../../app/main/agent/windows-coding-native"), fake = failedCreationNative({ invalidCreatedInfo: true });
  const api = module.bindWindowsCodingNative(fake.native, fake.load), base = api.pin("C:\\", "base");
  expect(() => api.create(base.handle, "fresh-copy", "directory")).toThrowError(expect.objectContaining({ code: "unsupported" }));
  expect(fake.created).toHaveLength(1); expect(fake.rolledBack).toEqual(fake.created); expect(fake.closed).toContain(fake.created[0]);
  expect(api.info(base.handle).kind).toBe("directory"); for (const handle of base.handles.slice().reverse()) api.close(handle);
});

it("keeps an uncertain close terminal and does not retry or forget the failed raw handle", async () => {
  vi.resetModules(); const module = await import("../../app/main/agent/windows-coding-native"), fake = failedCreationNative({ invalidCreatedInfo: true, createdClose: true });
  const api = module.bindWindowsCodingNative(fake.native, fake.load), base = api.pin("C:\\", "base");
  let failure: unknown; try { api.create(base.handle, "fresh-copy", "directory"); } catch (error) { failure = error; }
  expect(failure).toBeInstanceOf(module.WindowsCodingCleanupError); expect(fake.rolledBack).toEqual(fake.created);
  const calls = fake.closed.filter(handle => handle === fake.created[0]); expect(calls).toHaveLength(1);
  expect(() => api.info(base.handle)).toThrow(module.WindowsCodingCleanupError);
  expect(fake.closed.filter(handle => handle === fake.created[0])).toHaveLength(1);
  for (const handle of base.handles.slice().reverse()) api.close(handle);
});

it("transfers fresh directory ownership to a distinct verified non-DELETE file object before returning", async () => {
  vi.resetModules(); const module = await import("../../app/main/agent/windows-coding-native"), fake = failedCreationNative({});
  const api = module.bindWindowsCodingNative(fake.native, fake.load), base = api.pin("C:\\", "base"), directory = api.create(base.handle, "fresh-copy", "directory");
  expect(fake.opened.filter(open => !open.fresh).every(open => !(open.access & 0x10000) && open.share === 3)).toBe(true);
  expect(fake.opened.find(open => open.fresh)).toMatchObject({ access: 0x1300af, share: 7 });
  expect(fake.byId[0]).toMatchObject({ hint: fake.created[0], access: 0x1200af, share: 7, flags: 0x02200000 });
  expect(fake.byId[0].descriptor.readUInt32LE(0)).toBe(24); expect(fake.byId[0].descriptor.readUInt32LE(4)).toBe(0);
  expect(fake.byId[0].descriptor.readBigUInt64LE(8)).toBe(fake.created[0]);
  expect(fake.closed).toContain(fake.created[0]); expect(api.info(directory).id).toBe(fake.created[0].toString(16).padStart(16, "0"));
  api.remove(directory); const deleting = fake.opened.at(-1)!;
  expect(fake.byId).toHaveLength(1); expect(deleting).toMatchObject({ parent: fake.opened.find(open => open.access === 0x1200af)!.raw, name: "fresh-copy", access: 0x1300a0, share: 7, fresh: false });
  expect(fake.rolledBack).toEqual([deleting.raw]); expect(fake.closed).toContain(deleting.raw); expect(fake.rejectedByIdDisposition).toEqual([]);
  expect(() => api.info(directory)).toThrow(); api.close(directory); for (const handle of base.handles.slice().reverse()) api.close(handle);
});

it.each([{ wrongById: true }, { byIdFailure: true }])("rolls back only the original fresh object when by-ID transfer fails: %j", async options => {
  vi.resetModules(); const module = await import("../../app/main/agent/windows-coding-native"), fake = failedCreationNative(options);
  const api = module.bindWindowsCodingNative(fake.native, fake.load), base = api.pin("C:\\", "base");
  expect(() => api.create(base.handle, "fresh-copy", "directory")).toThrow();
  expect(fake.rolledBack).toEqual(fake.created); expect(fake.closed).toContain(fake.created[0]);
  for (const opened of fake.byId) expect(fake.closed).toContain(opened.raw);
  expect(api.info(base.handle).kind).toBe("directory"); for (const handle of base.handles.slice().reverse()) api.close(handle);
});

it("closes the verified persistent handle when the original creation handle's close becomes uncertain", async () => {
  vi.resetModules(); const module = await import("../../app/main/agent/windows-coding-native"), fake = failedCreationNative({ createdClose: true });
  const api = module.bindWindowsCodingNative(fake.native, fake.load), base = api.pin("C:\\", "base");
  expect(() => api.create(base.handle, "fresh-copy", "directory")).toThrow(module.WindowsCodingCleanupError);
  expect(fake.closed.filter(handle => handle === fake.created[0])).toHaveLength(1); expect(fake.closed).toContain(fake.byId[0].raw);
  expect(() => api.info(base.handle)).toThrow(module.WindowsCodingCleanupError); for (const handle of base.handles.slice().reverse()) api.close(handle);
});

it("retains terminal failure when the exact transient deletion handle cannot be confirmed closed", async () => {
  vi.resetModules(); const module = await import("../../app/main/agent/windows-coding-native"), fake = failedCreationNative({ deleteClose: true });
  const api = module.bindWindowsCodingNative(fake.native, fake.load), base = api.pin("C:\\", "base"), directory = api.create(base.handle, "fresh-copy", "directory");
  expect(() => api.remove(base.handle)).toThrow(); expect(fake.byId).toHaveLength(1);
  expect(() => api.remove(directory)).toThrow(module.WindowsCodingCleanupError);
  const deleting = fake.opened.at(-1)!.raw;
  expect(fake.rolledBack).toEqual([deleting]); expect(fake.closed.filter(handle => handle === deleting)).toHaveLength(1);
  expect(() => api.info(directory)).toThrow(module.WindowsCodingCleanupError); api.close(directory);
  for (const handle of base.handles.slice().reverse()) api.close(handle);
});

it("closes a mismatched named candidate without disposition and retains the original identity", async () => {
  vi.resetModules(); const module = await import("../../app/main/agent/windows-coding-native"), fake = failedCreationNative({ wrongNamed: true });
  const api = module.bindWindowsCodingNative(fake.native, fake.load), base = api.pin("C:\\", "base"), directory = api.create(base.handle, "fresh-copy", "directory"), before = api.info(directory);
  expect(() => api.remove(directory)).toThrowError(expect.objectContaining({ code: "boundary" }));
  expect(fake.rolledBack).toEqual([]); expect(fake.closed).toContain(fake.opened.at(-1)!.raw); expect(api.info(directory)).toEqual(before);
  api.close(directory); for (const handle of base.handles.slice().reverse()) api.close(handle); expect(fake.live()).toEqual([]);
});

it("rejects an expired traversal parent before any named reopen or deletion fallback", async () => {
  vi.resetModules(); const module = await import("../../app/main/agent/windows-coding-native"), fake = failedCreationNative({});
  const api = module.bindWindowsCodingNative(fake.native, fake.load), base = api.pin("C:\\", "base"), root = api.create(base.handle, "fresh-copy", "directory");
  const parent = api.create(root, "parent", "directory"), child = api.create(parent, "child", "directory"); api.close(parent);
  const opened = fake.opened.length, byId = fake.byId.length;
  expect(() => api.remove(child)).toThrowError(expect.objectContaining({ code: "boundary" }));
  expect(fake.opened).toHaveLength(opened); expect(fake.byId).toHaveLength(byId); expect(fake.rolledBack).toEqual([]);
  api.close(child); api.close(root); for (const handle of base.handles.slice().reverse()) api.close(handle); expect(fake.live()).toEqual([]);
});
