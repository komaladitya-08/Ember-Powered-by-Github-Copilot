/** Native boundary/ownership fault injection only; no Windows API or token is exercised here. */
import path from "node:path/win32";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { expect, it } from "vitest";
import { bindWindowsCommandCopyNative, createFreshWindowsCommandTree, WindowsCommandCopyCleanupError, type FreshWindowsCommandTreeInput } from "../../app/main/agent/windows-command-copy-native";
import { ScopedCodingFileError } from "../../app/main/agent/coding-platform";
import type { CodingExportEntry } from "../../app/main/agent/coding-result-export";
const OWNER = "S-1-5-21-1-2-3-1001", SYSTEM = "S-1-5-18", PACKAGE = "S-1-15-2-1234-5678";
const VOLUME = "\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\";
type Security = { owner: string; package?: string; inherited: boolean; low: boolean; extra?: boolean; badMask?: boolean };
type ObjectRow = { id: bigint; name: string; kind: "file" | "directory"; bytes: Buffer; security: Security; links: number; attributes: number; created: bigint; written: bigint; changed: bigint; streams?: boolean; removed?: boolean; deletePending?: boolean; reportedSize?: number; serial?: number };
type Handle = { object?: ObjectRow; access: number; share: number; index: number };
function setup() {
  const buffers = new Map<bigint, Buffer>(), texts = new Map<bigint, string>(), sids = new Map<bigint, string>(), descriptors = new Map<bigint, Security>();
  const aclRows = new Map<bigint, { row: ObjectRow; label: boolean }>(), aceRows = new Map<bigint, Buffer>();
  const objects = new Map<string, ObjectRow>(), handles = new Map<bigint, Handle>();
  const calls: { name: string; args: unknown[] }[] = [], opened: { raw: bigint; object: ObjectRow; access: number; share: number; fresh: boolean; parent: bigint }[] = [];
  let serial = 100n, nextId = 1n, nextPointer = 0x10000n, sets = 0;
  const control = { fault: "", failSet: 0, current: true, label: true, owner: OWNER, dataReads: 0, yieldRetire: false, retireOnSet: 0, streamBytes: undefined as number | undefined, streamStatus: 0, directoryStatus: 0, directoryBytes: undefined as number | undefined };
  const fence = { retained: [] as unknown[], failure: undefined as WindowsCommandCopyCleanupError | undefined };
  const pointer = () => nextPointer += 0x100n;
  const address = (bytes: Buffer) => { const p = pointer(); buffers.set(p, bytes); return p; };
  const sidPointer = (sid: string) => { const p = pointer(); sids.set(p, sid); return p; };
  const add = (name: string, kind: "file" | "directory", bytes = Buffer.alloc(0), security: Security = { owner: OWNER, inherited: false, low: true }): ObjectRow => {
    const row: ObjectRow = { id: nextId++, name, kind, bytes: Buffer.from(bytes), security: { ...security }, links: 1, attributes: kind === "directory" ? 16 : 128, created: 100n, written: 200n, changed: 300n };
    objects.set(name, row); return row;
  };
  add("C:\\", "directory"); add("C:\\scratch", "directory"); add("C:\\source", "directory"); add("C:\\source\\input.ts", "file", Buffer.from("source remains untouched"));
  const file = (raw: unknown) => { const row = handles.get(raw as bigint)?.object; if (!row) throw new Error("bad mock file handle"); return row; };
  const final = (row: ObjectRow) => VOLUME + row.name.slice(3);
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    GetCurrentProcess: () => -1n,
    OpenProcessToken: (...args) => { const raw = serial++; handles.set(raw, { access: 8, share: 0, index: 0 }); (args[2] as unknown[])[0] = raw; return 1; },
    GetTokenInformation: (...args) => { (args[2] as Buffer).writeBigUInt64LE(sidPointer(OWNER)); (args[4] as number[])[0] = 16; return 1; },
    ConvertSidToStringSidW: (...args) => { const p = pointer(); texts.set(p, sids.get(args[0] as bigint)!); (args[1] as unknown[])[0] = p; return 1; },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: (...args) => {
      const text = args[0] as string, p = pointer(); const pkg = /0x1301bf;;;([^)]*)/.exec(text)?.[1];
      descriptors.set(p, { owner: OWNER, package: pkg, inherited: false, low: true }); (args[2] as unknown[])[0] = p; return control.fault === "descriptor false" ? 0 : 1;
    },
    LocalFree: (...args) => { if (control.fault === "free throw") throw new Error("private allocator uncertainty"); return control.fault === "free" ? args[0] : null; },
    GetDriveTypeW: () => 3,
    GetVolumeInformationW: (...args) => { (args[6] as Buffer).write("NTFS\0", "utf16le"); return 1; },
    NtCreateFile: (...args) => {
      const oa = args[2] as Buffer, unicode = buffers.get(oa.readBigUInt64LE(16))!, text = buffers.get(unicode.readBigUInt64LE(8))!;
      const component = text.toString("utf16le", 0, unicode.readUInt16LE(0)), parent = oa.readBigUInt64LE(8), fresh = args[7] === 2;
      const name = parent ? path.join(file(parent).name, component) : component.replace(/^\\\?\?\\/, "");
      let row = objects.get(name);
      if (fresh) { if (row && !row.removed) return 0xc0000035; row = add(name, Number(args[8]) & 1 ? "directory" : "file", Buffer.alloc(0), descriptors.get(oa.readBigUInt64LE(32))!); }
      if (!row || row.removed) return 0xc0000034;
      const raw = serial++; (args[3] as Buffer).writeBigUInt64LE(BigInt(fresh && control.fault !== "not fresh" ? 2 : 1), 8); handles.set(raw, { object: row, access: Number(args[1]), share: Number(args[6]), index: 0 }); opened.push({ raw, object: row, access: Number(args[1]), share: Number(args[6]), fresh, parent }); (args[0] as unknown[])[0] = raw;
      if (fresh && control.fault === "create throw") throw new Error("private FFI diagnostic"); return fresh && control.fault === "create status" ? 0xc0000022 : 0;
    },
    GetHandleInformation: (...args) => { (args[1] as number[])[0] = 0; return 1; },
    NtQueryObject: (...args) => { (args[2] as Buffer).writeUInt32LE(handles.get(args[0] as bigint)!.access | (control.fault === "extra handle rights" ? 0x10000 : 0), 4); (args[4] as number[])[0] = 56; return 0; },
    GetFileType: () => 1,
    GetFileInformationByHandle: (...args) => {
      const row = file(args[0]), b = args[1] as Buffer;
      b.writeUInt32LE(row.attributes); b.writeBigUInt64LE(row.created, 4); b.writeBigUInt64LE(row.written, 20); b.writeUInt32LE(row.serial ?? 1, 28); b.writeUInt32LE(Math.floor((row.reportedSize ?? row.bytes.length) / 0x100000000), 32); b.writeUInt32LE((row.reportedSize ?? row.bytes.length) % 0x100000000, 36); b.writeUInt32LE(row.links, 40); b.writeUInt32LE(Number(row.id >> 32n), 44); b.writeUInt32LE(Number(row.id & 0xffffffffn), 48); return 1;
    },
    GetFileInformationByHandleEx: (...args) => { const row = file(args[0]), b = args[2] as Buffer; if (args[1] === 1) { b.writeBigInt64LE(BigInt(row.reportedSize ?? row.bytes.length), 8); b.writeUInt32LE(row.links, 16); b[20] = row.deletePending ? 1 : 0; b[21] = row.kind === "directory" ? 1 : 0; return 1; } b.writeBigUInt64LE(row.created); b.writeBigUInt64LE(row.written, 16); b.writeBigUInt64LE(row.changed, 24); b.writeUInt32LE(row.attributes, 32); return 1; },
    GetFinalPathNameByHandleW: (...args) => { const row = file(args[0]); if (row.links === 0) throw new Error("unlinked object has no name"); if (row.deletePending && control.fault === "pending name failed") return 0; const text = final(row); (args[1] as Buffer).write(text, "utf16le"); return text.length; },
    NtQueryInformationFile: (...args) => {
      const row = file(args[0]), b = args[2] as Buffer, io = args[1] as Buffer;
      if (row.kind === "directory" && !row.streams) { io.writeBigUInt64LE(0n, 8); return 0; }
      const name = row.streams ? ":secret:$DATA" : "::$DATA"; b.writeUInt32LE(name.length * 2, 4); b.writeBigInt64LE(BigInt(row.reportedSize ?? row.bytes.length), 8); b.write(name, 24, "utf16le"); io.writeUInt32LE(control.streamStatus); io.writeBigUInt64LE(BigInt(control.streamBytes ?? 24 + name.length * 2), 8); return 0;
    },
    GetSecurityInfo: (...args) => {
      const row = file(args[0]), sd = pointer(), dacl = pointer(), sacl = pointer();
      descriptors.set(sd, row.security); aclRows.set(dacl, { row, label: false }); aclRows.set(sacl, { row, label: true });
      (args[3] as unknown[])[0] = sidPointer(control.owner === OWNER ? row.security.owner : control.owner);
      (args[5] as unknown[])[0] = dacl; (args[6] as unknown[])[0] = sacl; (args[7] as unknown[])[0] = sd; return 0;
    },
    GetSecurityDescriptorControl: (...args) => { const sec = descriptors.get(args[0] as bigint)!; (args[1] as number[])[0] = 4 | 16 | (sec.inherited ? 0 : 0x1000); return 1; },
    GetAclInformation: (...args) => { const acl = aclRows.get(args[0] as bigint)!, count = acl.label ? 1 : (acl.row.security.package ? 3 : 2) + (acl.row.security.extra ? 1 : 0); (args[1] as Buffer).writeUInt32LE(count); return 1; },
    GetAce: (...args) => {
      const acl = aclRows.get(args[0] as bigint)!, sec = acl.row.security, index = Number(args[1]), p = pointer(), b = Buffer.alloc(8);
      b[0] = acl.label ? 17 : 0; b[1] = (acl.row.kind === "directory" ? 3 : 0) | (sec.inherited ? 16 : 0); b.writeUInt16LE(28, 2);
      b.writeUInt32LE(acl.label ? 1 : index === 2 ? sec.badMask ? 0x1f01ff : 0x1301bf : 0x1f01ff, 4);
      aceRows.set(p, b); sids.set(p + 8n, acl.label ? sec.low && control.label ? "S-1-16-4096" : "S-1-16-8192" : index === 0 ? sec.owner : index === 1 ? SYSTEM : sec.package!); (args[2] as unknown[])[0] = p; return 1;
    },
    NtSetSecurityObject: (...args) => { sets++; if (control.failSet && sets === control.failSet) throw new Error("private partial ACL error"); file(args[0]).security = { ...descriptors.get(args[2] as bigint)! }; if (control.retireOnSet && sets === control.retireOnSet) control.current = false; return 0; },
    NtWriteFile: (...args) => { const row = file(args[0]), offset = Number((args[7] as Buffer).readBigInt64LE(0)), bytes = args[5] as Buffer, count = Number(args[6]); row.bytes = Buffer.concat([row.bytes.subarray(0, offset), bytes.subarray(0, count)]); row.written++; row.changed++; (args[4] as Buffer).writeBigUInt64LE(BigInt(count), 8); return 0; },
    FlushFileBuffers: () => 1,
    NtReadFile: (...args) => { control.dataReads++; const row = file(args[0]), offset = Number((args[7] as Buffer).readBigInt64LE(0)), count = Math.min(Number(args[6]), Math.max(0, row.bytes.length - offset)); row.bytes.copy(args[5] as Buffer, 0, offset, offset + count); (args[4] as Buffer).writeBigUInt64LE(BigInt(count), 8); return count ? 0 : 0xc0000011; },
    NtQueryDirectoryFile: (...args) => {
      const h = handles.get(args[0] as bigint)!, parent = h.object!, b = args[5] as Buffer, io = args[4] as Buffer;
      if (args[10] === 1) h.index = 0;
      const children = [...objects.values()].filter(row => !row.removed && row.name !== parent.name && path.dirname(row.name) === parent.name).sort((a, c) => a.name.localeCompare(c.name));
      const child = children[h.index++]; if (!child) return 0x80000006;
      const name = path.basename(child.name), length = 104 + name.length * 2; b.writeBigInt64LE(BigInt(child.reportedSize ?? child.bytes.length), 40); b.writeUInt32LE(child.attributes, 56); b.writeUInt32LE(name.length * 2, 60); b.writeBigUInt64LE(child.id, 96); b.write(name, 104, "utf16le"); io.writeUInt32LE(control.directoryStatus); io.writeBigUInt64LE(BigInt(control.directoryBytes ?? length), 8); return 0;
    },
    NtSetInformationFile: (...args) => { file(args[0]).removed = true; return 0; },
    CloseHandle: (...args) => { if (control.fault === "close throw") { handles.delete(args[0] as bigint); throw new Error("private close uncertainty"); } if (control.fault === "close") return 0; handles.delete(args[0] as bigint); return 1; },
  };
  const native = { sizeof: () => 8, address, decode: Object.assign((p: bigint) => aceRows.get(p)!, { string16: (p: bigint) => texts.get(p)! }) } as unknown as Parameters<typeof bindWindowsCommandCopyNative>[0];
  const load = () => ({ func(prototype: string) { const name = /\b(\w+)\s*\(/.exec(prototype)![1]; return (...args: unknown[]) => { calls.push({ name, args }); const handler = handlers[name]; if (!handler) throw new Error("unexpected native test call"); return handler(...args); }; } });
  const binding = bindWindowsCommandCopyNative(native, load, fence);
  const input = (entries: readonly CodingExportEntry[] = [{ path: "a.ts", kind: "file", bytes: Buffer.from("baseline"), executable: false }]): FreshWindowsCommandTreeInput => ({ parent: "C:\\scratch", protectedPaths: ["C:\\source"], entries, current: () => control.current });
  return { binding, input, control, calls, handles, objects, opened, fence, add, sets: () => sets, root: () => [...objects.values()].find(row => path.basename(row.name).startsWith("ember-command-"))! };
}

it("stages only fresh owner-private LOW objects and retains metadata-only share7 pins before granting", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input());
  await tree.assertPrivate(); await tree.grant(PACKAGE);
  const root = s.root(); expect(tree.directory).toBe(root.name);
  const liveFresh = s.opened.filter(row => row.object.name.startsWith(root.name) && s.handles.has(row.raw));
  expect(liveFresh.length).toBeGreaterThan(0); for (const row of liveFresh) { expect(row.share).toBe(7); expect(row.access & (0x1f | 0x10000)).toBe(0); }
  expect([...s.handles.values()].every(handle => !(handle.access & (0x1f | 0x10000)))).toBe(true);
  expect(root.security.package).toBe(PACKAGE); expect(root.security.low).toBe(true);
  expect(s.calls.filter(call => call.name === "NtSetSecurityObject").every(call => Number(call.args[1]) === 0x80000014)).toBe(true);
  expect(s.calls.filter(call => call.name === "GetSecurityInfo").every(call => Number(call.args[2]) === 0x15)).toBe(true);
  expect(s.opened.filter(row => row.fresh).every(row => row.object.name.startsWith(root.name))).toBe(true);
  await tree.revoke(PACKAGE); await tree.close(); expect(s.handles.size).toBe(0);
});

it("detaches input before any yield, preserves source, returns private detached snapshots and removes only the fresh tree", async () => {
  const s = setup(), bytes = Buffer.from("baseline"), input = s.input([{ path: "a.ts", kind: "file", bytes, executable: false }]);
  const promised = s.binding.createFreshWindowsCommandTree(input); bytes.fill(0); const tree = await promised;
  const snapshot = await tree.snapshot(); expect(snapshot).toEqual([{ path: "a.ts", kind: "file", bytes: Buffer.from("baseline"), executable: false }]);
  if (snapshot[0].kind === "file") snapshot[0].bytes.fill(0);
  expect(await tree.snapshot()).toEqual([{ path: "a.ts", kind: "file", bytes: Buffer.from("baseline"), executable: false }]);
  await tree.close(); await tree.close(); expect(s.objects.get("C:\\source\\input.ts")!.bytes.toString()).toBe("source remains untouched");
  expect(s.calls.filter(call => ["NtWriteFile", "NtSetSecurityObject", "NtSetInformationFile"].includes(call.name)).every(call => s.opened.find(row => row.raw === call.args[0])!.object.name.startsWith(tree.directory))).toBe(true);
});

it("revokes current descendants created during execution, including inherited child directories and files", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
  const sec = { owner: OWNER, package: PACKAGE, inherited: true, low: true };
  s.add(path.join(tree.directory, "new"), "directory", Buffer.alloc(0), sec); s.add(path.join(tree.directory, "new", "out.ts"), "file", Buffer.from("created"), sec);
  await tree.revoke(PACKAGE); expect(s.objects.get(path.join(tree.directory, "new", "out.ts"))!.security.package).toBeUndefined();
  const snapshot = await tree.snapshot(); expect(snapshot.map(entry => entry.path).sort()).toEqual(["a.ts", "new", "new/out.ts"]); await tree.close();
});

it("task cancellation permanently blocks grants but permits known revoke/close and separately guarded stopped review", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE); s.control.current = false;
  await expect(tree.grant(PACKAGE)).rejects.toMatchObject({ code: "cancelled" }); await tree.revoke(PACKAGE);
  await expect(tree.snapshot()).rejects.toMatchObject({ code: "cancelled" });
  expect((await tree.snapshot(() => undefined)).length).toBe(1); s.control.current = true;
  await expect(tree.grant(PACKAGE)).rejects.toMatchObject({ code: "cancelled" }); await tree.close();
});

it.each(["close", "close throw", "free", "free throw", "extra handle rights"])("terminalizes %s uncertainty and never retries or continues cleanup", async fault => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); s.control.fault = fault;
  await expect(fault.startsWith("close") ? tree.close() : tree.assertPrivate()).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  const count = s.calls.length; await expect(tree.close()).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); await expect(s.binding.createFreshWindowsCommandTree(s.input())).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls).toHaveLength(count); expect(s.fence.retained).toHaveLength(1);
});

it("retains a possibly acquired raw handle and descriptor after a thrown CREATE_NEW without any continued free/close", async () => {
  const s = setup(); s.control.fault = "create throw";
  await expect(s.binding.createFreshWindowsCommandTree(s.input())).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls.at(-1)!.name).toBe("NtCreateFile"); expect(s.fence.retained).toHaveLength(1); expect(s.handles.size).toBeGreaterThan(0);
});

it.each(["grant", "revoke"])("preserves every remaining owner after a partial %s mutation", async operation => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input());
  if (operation === "revoke") await tree.grant(PACKAGE);
  s.control.failSet = s.sets() + 2;
  await expect(operation === "grant" ? tree.grant(PACKAGE) : tree.revoke(PACKAGE)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls.at(-1)!.name).toBe("NtSetSecurityObject"); const count = s.calls.length;
  await expect(tree.close()).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); expect(s.calls).toHaveLength(count);
});

it.each(["owner", "label", "ACL", "root", "reparse", "hardlink", "ADS", "case alias", "file limit"])("quarantines changed %s before revocation or private snapshot publication", async fault => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
  const root = s.root(), child = s.objects.get(path.join(tree.directory, "a.ts"))!;
  if (fault === "owner") s.control.owner = "S-1-5-21-9999";
  if (fault === "label") s.control.label = false;
  if (fault === "ACL") child.security.badMask = true;
  if (fault === "root") root.id += 1000n;
  if (fault === "reparse") child.attributes |= 0x400;
  if (fault === "hardlink") child.links = 2;
  if (fault === "ADS") child.streams = true;
  if (fault === "case alias") s.add(path.join(tree.directory, "A.ts"), "file", Buffer.alloc(0), { owner: OWNER, package: PACKAGE, inherited: true, low: true });
  if (fault === "file limit") child.bytes = Buffer.alloc(8 * 1024 * 1024 + 1);
  await expect(tree.revoke(PACKAGE)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); const count = s.calls.length;
  await expect(tree.snapshot(() => undefined)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); expect(s.calls).toHaveLength(count);
});

it.each(["S-1-15-2-1", OWNER, "S-1-15-2-1234;grant", ""])("refuses foreign package admission %s without mutating any ACL", async sid => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); const count = s.sets();
  await expect(tree.grant(sid)).rejects.toThrow(); expect(s.sets()).toBe(count); await tree.close();
});

it.each([
  { entries: [{ path: "../source/a.ts", kind: "file", bytes: Buffer.alloc(0), executable: false }] },
  { entries: [{ path: "a.ts:stream", kind: "file", bytes: Buffer.alloc(0), executable: false }] },
  { entries: [{ path: "a.ts", kind: "file", bytes: Buffer.alloc(0), executable: true }] },
  { entries: [{ path: "A.ts", kind: "directory" }, { path: "a.ts", kind: "directory" }] },
] satisfies { entries: CodingExportEntry[] }[])("rejects unsafe detached input before any native acquisition", async ({ entries }) => {
  const s = setup(); await expect(s.binding.createFreshWindowsCommandTree(s.input(entries))).rejects.toThrow(); expect(s.calls).toEqual([]);
});

it("pins a large protected tool by metadata without reading or granting it", async () => {
  const s = setup(); const asset = s.add("C:\\asset.exe", "file"); asset.reportedSize = 120 * 1024 * 1024;
  const input = s.input(); input.protectedPaths = ["C:\\source", "C:\\asset.exe"];
  const tree = await s.binding.createFreshWindowsCommandTree(input); await tree.grant(PACKAGE); await tree.revoke(PACKAGE); await tree.close();
  expect(s.opened.filter(row => row.object === asset).every(row => (row.access & (0x1f | 0x10000 | 0xc0000)) === 0)).toBe(true);
  expect(s.calls.some(call => ["NtReadFile", "NtWriteFile", "NtSetSecurityObject", "NtSetInformationFile"].includes(call.name) && s.opened.find(row => row.raw === call.args[0])?.object === asset)).toBe(false);
});

it("can revoke a known partially granted tree after task cancellation without renewing grant authority", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); s.control.retireOnSet = 1;
  await expect(tree.grant(PACKAGE)).rejects.toMatchObject({ code: "cancelled" }); expect(s.root().security.package).toBe(PACKAGE);
  expect(s.fence.failure).toBeUndefined(); await tree.revoke(PACKAGE); expect(s.root().security.package).toBeUndefined();
  await expect(tree.grant(PACKAGE, () => undefined)).rejects.toMatchObject({ code: "cancelled" }); await tree.close(); expect(s.handles.size).toBe(0);
});

it("cancellation while staging yields rolls back only the known fresh private tree", async () => {
  const s = setup(), entries = Array.from({ length: 40 }, (_, i): CodingExportEntry => ({ path: `f${i}.ts`, kind: "file", bytes: Buffer.from("bounded"), executable: false }));
  const promise = s.binding.createFreshWindowsCommandTree(s.input(entries)); setImmediate(() => { s.control.current = false; });
  await expect(promise).rejects.toMatchObject({ code: "cancelled" });
  expect(s.fence.failure).toBeUndefined(); expect(s.handles.size).toBe(0);
  expect([...s.objects.values()].filter(row => row.name.includes("ember-command-")).every(row => row.removed)).toBe(true);
  expect(s.objects.get("C:\\source\\input.ts")!.removed).not.toBe(true);
});

it("a rejected explicit review guard publishes no bytes and never revives retired work authority", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); s.control.current = false;
  await expect(tree.snapshot()).rejects.toMatchObject({ code: "cancelled" }); const before = s.control.dataReads;
  await expect(tree.snapshot(() => { throw new Error("retired account"); })).rejects.toMatchObject({ code: "cancelled" }); expect(s.control.dataReads).toBe(before);
  await expect(tree.snapshot((() => Promise.resolve()) as unknown as () => void)).rejects.toMatchObject({ code: "cancelled" });
  await expect(tree.snapshot((() => true) as unknown as () => void)).rejects.toMatchObject({ code: "cancelled" });
  expect((await tree.snapshot(() => undefined)).length).toBe(1); await tree.close();
});

it("zeroes a partially read snapshot and closes its data handle after a known review revocation", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input([{ path: "large.ts", kind: "file", bytes: Buffer.alloc(2 * 1024 * 1024, 7), executable: false }]));
  await expect(tree.snapshot(() => { if (s.control.dataReads > 0) throw new Error("retired review"); })).rejects.toMatchObject({ code: "cancelled" });
  const reads = s.calls.filter(call => call.name === "NtReadFile"); expect(reads.length).toBeGreaterThan(0);
  for (const call of reads) expect((call.args[5] as Buffer).every(byte => byte === 0)).toBe(true);
  expect([...s.handles.values()].filter(handle => handle.object?.kind === "file").every(handle => !(handle.access & 1))).toBe(true);
  await tree.close(); expect(s.handles.size).toBe(0);
});

it("uses only relative component opens after the drive and refuses parent/protected overlap before creating anything", async () => {
  const s = setup(), input = s.input(); input.protectedPaths = ["C:\\scratch"];
  await expect(s.binding.createFreshWindowsCommandTree(input)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.opened.some(row => row.fresh)).toBe(false);
  expect(s.opened.filter(row => row.parent === 0n).every(row => row.object.name === "C:\\")).toBe(true);
});

it("cooperatively yields a bounded long grant, refuses concurrent calls and then safely revokes", async () => {
  const s = setup(), entries = Array.from({ length: 40 }, (_, i): CodingExportEntry => ({ path: `f${i}.ts`, kind: "file", bytes: Buffer.alloc(0), executable: false }));
  const tree = await s.binding.createFreshWindowsCommandTree(s.input(entries));
  let ran = false; const turn = new Promise<void>(resolve => setImmediate(() => { ran = true; resolve(); }));
  const granting = tree.grant(PACKAGE); await expect(tree.snapshot()).rejects.toThrow(); await turn; expect(ran).toBe(true); await granting;
  await tree.revoke(PACKAGE); await tree.close(); expect(s.handles.size).toBe(0);
});


it("does not trust a purported successful CREATE_NEW that reports an existing object", async () => {
  const s = setup(); s.control.fault = "not fresh";
  await expect(s.binding.createFreshWindowsCommandTree(s.input())).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls.at(-1)!.name).toBe("NtCreateFile");
  expect(s.calls.some(call => ["NtWriteFile", "NtSetSecurityObject", "NtSetInformationFile"].includes(call.name))).toBe(false);
});


it("retains all peer native owners immediately when one owner loses cleanup certainty", async () => {
  const s = setup(), first = await s.binding.createFreshWindowsCommandTree(s.input()), second = await s.binding.createFreshWindowsCommandTree(s.input());
  s.control.fault = "close"; await expect(first.close()).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.fence.retained).toHaveLength(2); const count = s.calls.length;
  await expect(second.snapshot()).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); await expect(second.close()).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); expect(s.calls).toHaveLength(count);
});

it.each(["depth", "total bytes"])("rejects current project-created descendants above the %s bound before reading data or restoring partial ACLs", async limit => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input([])); await tree.grant(PACKAGE);
  const sec = { owner: OWNER, package: PACKAGE, inherited: true, low: true };
  if (limit === "depth") { let directory = tree.directory; for (let i = 0; i < 33; i++) { directory = path.join(directory, "d"); s.add(directory, "directory", Buffer.alloc(0), sec); } }
  else for (let i = 0; i < 13; i++) s.add(path.join(tree.directory, `f${i}.ts`), "file", Buffer.alloc(0), sec).reportedSize = 8 * 1024 * 1024;
  const before = s.sets(); await expect(tree.revoke(PACKAGE)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); expect(s.sets()).toBe(before); expect(s.control.dataReads).toBe(0);
});

it("bounds the detached entry count before native ownership or allocation", async () => {
  const s = setup(), entries = Array.from({ length: 4001 }, (_, i): CodingExportEntry => ({ path: `f${i}.ts`, kind: "file", bytes: Buffer.alloc(0), executable: false }));
  await expect(s.binding.createFreshWindowsCommandTree(s.input(entries))).rejects.toThrow(); expect(s.calls).toEqual([]);
});


it.each(["descriptor false", "create status"])("retains allocator/acquisition outputs after %s without continued native cleanup", async fault => {
  const s = setup(); s.control.fault = fault;
  await expect(s.binding.createFreshWindowsCommandTree(s.input())).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls.at(-1)!.name).toBe(fault === "descriptor false" ? "ConvertStringSecurityDescriptorToSecurityDescriptorW" : "NtCreateFile");
  expect(s.fence.retained).toHaveLength(1);
});

it("verifies the whole tree is private before granting the first object", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input());
  s.objects.get(path.join(tree.directory, "a.ts"))!.security.package = PACKAGE;
  await expect(tree.grant(PACKAGE)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); expect(s.sets()).toBe(0); expect(s.root().security.package).toBeUndefined();
});

it("accepts legitimate removal of an initially staged file using only positive held-object deletion evidence", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
  const removed = s.objects.get(path.join(tree.directory, "a.ts"))!;
  removed.removed = true; removed.links = 0; removed.deletePending = true;
  const before = s.calls.length; await tree.revoke(PACKAGE);
  expect(s.calls.slice(before).some(call => call.name === "GetFinalPathNameByHandleW" && s.opened.find(row => row.raw === call.args[0])?.object === removed)).toBe(false);
  expect(await tree.snapshot()).toEqual([]); expect([...s.handles.values()].some(handle => handle.object === removed)).toBe(false);
  await tree.close(); expect(s.handles.size).toBe(0);
});

it("accounts for removed initially staged directory descendants before enumerating the current tree", async () => {
  const s = setup(), entries: CodingExportEntry[] = [{ path: "src", kind: "directory" }, { path: "src/a.ts", kind: "file", bytes: Buffer.from("staged"), executable: false }];
  const tree = await s.binding.createFreshWindowsCommandTree(s.input(entries)); await tree.grant(PACKAGE);
  for (const row of s.objects.values()) if (row.name.startsWith(path.join(tree.directory, "src"))) { row.removed = true; row.links = 0; row.deletePending = true; }
  await tree.revoke(PACKAGE); expect(await tree.snapshot()).toEqual([]); await tree.close(); expect(s.handles.size).toBe(0);
});

it("follows current in-root names by held identity after a legitimate staged-file rename", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
  const old = path.join(tree.directory, "a.ts"), moved = s.objects.get(old)!; s.objects.delete(old); moved.name = path.join(tree.directory, "renamed.ts"); moved.changed++; s.objects.set(moved.name, moved);
  await tree.revoke(PACKAGE);
  expect(await tree.snapshot()).toEqual([{ path: "renamed.ts", kind: "file", bytes: Buffer.from("baseline"), executable: false }]);
  await tree.close(); expect(s.handles.size).toBe(0); expect(s.objects.get("C:\\source\\input.ts")!.bytes.toString()).toBe("source remains untouched");
});

it("accepts a same-name replacement with a new inherited object while releasing the positively removed old object", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
  const name = path.join(tree.directory, "a.ts"), old = s.objects.get(name)!; old.removed = true; old.links = 0; old.deletePending = true;
  const replacement = s.add(name, "file", Buffer.from("replacement"), { owner: OWNER, package: PACKAGE, inherited: true, low: true });
  expect(replacement.id).not.toBe(old.id); await tree.revoke(PACKAGE);
  expect(await tree.snapshot()).toEqual([{ path: "a.ts", kind: "file", bytes: Buffer.from("replacement"), executable: false }]);
  expect([...s.handles.values()].some(handle => handle.object === old)).toBe(false); expect(replacement.security.package).toBeUndefined();
  await tree.close(); expect(s.handles.size).toBe(0);
});

it("accepts an in-place data edit without insisting on the staged bytes or old mutable timestamps", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
  const row = s.objects.get(path.join(tree.directory, "a.ts"))!; row.bytes = Buffer.from("edited"); row.written++; row.changed++;
  await tree.revoke(PACKAGE); expect(await tree.snapshot()).toEqual([{ path: "a.ts", kind: "file", bytes: Buffer.from("edited"), executable: false }]); await tree.close();
});

it.each(["moved outside", "pending outside", "unlinked without pending", "hardlinked pending"])("retains rather than misclassifies an old held object that is %s", async fault => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
  const name = path.join(tree.directory, "a.ts"), old = s.objects.get(name)!;
  if (fault === "moved outside" || fault === "pending outside") { s.objects.delete(name); old.name = "C:\\outside-profile\\a.ts"; s.objects.set(old.name, old); old.deletePending = fault === "pending outside"; }
  else { old.removed = true; old.links = fault === "hardlinked pending" ? 2 : 0; old.deletePending = fault === "hardlinked pending"; }
  const before = s.sets(); await expect(tree.revoke(PACKAGE)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); expect(s.sets()).toBe(before);
  expect([...s.handles.values()].some(handle => handle.object === old)).toBe(true);
});


it("accepts a positively delete-pending staged object only when its remaining name is still inside the fresh root", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
  const old = s.objects.get(path.join(tree.directory, "a.ts"))!; old.removed = true; old.deletePending = true;
  await tree.revoke(PACKAGE); expect(await tree.snapshot()).toEqual([]); await tree.close(); expect(s.handles.size).toBe(0);
});

it("does not guess that a failed pending-object name query means safe deletion", async () => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
  const old = s.objects.get(path.join(tree.directory, "a.ts"))!; old.removed = true; old.deletePending = true; s.control.fault = "pending name failed";
  await expect(tree.revoke(PACKAGE)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls.at(-1)!.name).toBe("GetFinalPathNameByHandleW"); expect([...s.handles.values()].some(handle => handle.object === old)).toBe(true);
});

it.each(["identity", "volume serial", "creation", "owner", "label", "ACL"])("does not release an unlinked old object with changed %s attestation", async field => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input()); await tree.grant(PACKAGE);
  const old = s.objects.get(path.join(tree.directory, "a.ts"))!; old.removed = true; old.links = 0; old.deletePending = true;
  if (field === "identity") old.id++;
  if (field === "volume serial") old.serial = 2;
  if (field === "creation") old.created++;
  if (field === "owner") old.security.owner = "S-1-5-21-9999";
  if (field === "label") old.security.low = false;
  if (field === "ACL") old.security.extra = true;
  const before = s.sets(); await expect(tree.revoke(PACKAGE)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); expect(s.sets()).toBe(before);
  expect([...s.handles.values()].some(handle => handle.object === old)).toBe(true);
});

it.each(["true", "false", "throw"])("rechecks peer uncertainty immediately after task-current callback returns %s before constructor admission", async outcome => {
  const s = setup(), peer = await s.binding.createFreshWindowsCommandTree(s.input());
  const old = s.objects.get(path.join(peer.directory, "a.ts"))!; old.removed = true; old.links = 0; old.deletePending = true;
  let afterPeerFailure = -1;
  const input = s.input(); input.current = () => {
    s.control.fault = "close"; void peer.close().catch(() => undefined); afterPeerFailure = s.calls.length;
    if (outcome === "throw") throw new Error("retired task callback"); return outcome === "true";
  };
  await expect(s.binding.createFreshWindowsCommandTree(input)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.fence.failure).toBeInstanceOf(WindowsCommandCopyCleanupError); expect(afterPeerFailure).toBeGreaterThan(0);
  expect(s.calls).toHaveLength(afterPeerFailure); expect(s.calls.at(-1)!.name).toBe("CloseHandle");
});

it.each(["grant", "snapshot"])("does not query, acquire or mutate after a %s guard reentrantly poisons another live owner", async operation => {
  const s = setup(), owner = await s.binding.createFreshWindowsCommandTree(s.input()), peer = await s.binding.createFreshWindowsCommandTree(s.input());
  const old = s.objects.get(path.join(peer.directory, "a.ts"))!; old.removed = true; old.links = 0; old.deletePending = true;
  let afterPeerFailure = -1;
  const check = () => { s.control.fault = "close"; void peer.close().catch(() => undefined); afterPeerFailure = s.calls.length; };
  await expect(operation === "grant" ? owner.grant(PACKAGE, check) : owner.snapshot(check)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls).toHaveLength(afterPeerFailure); const count = s.calls.length;
  await expect(owner.close()).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError); expect(s.calls).toHaveLength(count);
  expect(s.fence.retained).toHaveLength(2);
});

it("preserves an explicit typed cleanup error from an admission callback rather than reshaping it as cancellation", async () => {
  const s = setup(), owner = await s.binding.createFreshWindowsCommandTree(s.input()); const count = s.calls.length;
  await expect(owner.grant(PACKAGE, () => { throw new WindowsCommandCopyCleanupError(); })).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls).toHaveLength(count); expect(s.fence.retained).toHaveLength(1);
});


it.each([24, 37])("does not consume valid trailing stream-name bytes beyond declared information length %s", async length => {
  const s = setup(); s.control.streamBytes = length;
  await expect(s.binding.createFreshWindowsCommandTree(s.input())).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls.at(-1)!.name).toBe("NtQueryInformationFile"); expect(s.calls.some(call => call.name === "NtWriteFile")).toBe(false);
});

it("rejects a successful stream-query return with a contradictory IO_STATUS_BLOCK status", async () => {
  const s = setup(); s.control.streamStatus = 0xc0000022;
  await expect(s.binding.createFreshWindowsCommandTree(s.input())).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls.at(-1)!.name).toBe("NtQueryInformationFile");
});

it.each(["status", "zero length", "oversized length"])("rejects contradictory directory IO information: %s", async contradiction => {
  const s = setup(), tree = await s.binding.createFreshWindowsCommandTree(s.input());
  if (contradiction === "status") s.control.directoryStatus = 0xc0000022;
  else s.control.directoryBytes = contradiction === "zero length" ? 0 : 1025;
  await expect(tree.grant(PACKAGE)).rejects.toBeInstanceOf(WindowsCommandCopyCleanupError);
  expect(s.calls.at(-1)!.name).toBe("NtQueryDirectoryFile"); expect(s.sets()).toBe(0);
});


it("the emitted CommonJS default factory roots its trusted Koffi require at __filename before input refusal", async () => {
  const s = setup(), filename = "/trusted/ember/windows-command-copy-native.cjs", loads: string[] = [], requires: unknown[] = [];
  const source = readFileSync(new URL("../../app/main/agent/windows-command-copy-native.ts", import.meta.url), "utf8");
  const emitted = transformSync(source, { loader: "ts", format: "cjs", platform: "node", target: "node22" }).code;
  const module = { exports: {} as { createFreshWindowsCommandTree(input: FreshWindowsCommandTreeInput): Promise<unknown> } };
  const fake = setup();
  const native = { sizeof: () => 8, address: () => 1n, decode: Object.assign(() => Buffer.alloc(0), { string16: () => "" }), load(name: string) { loads.push(name); return { func: () => () => { throw new Error("No real native function belongs to the CJS loading test."); } }; } };
  const require = (name: string): unknown => {
    if (name === "node:path/win32") return path;
    if (name === "node:crypto") return { randomUUID };
    if (name === "node:module") return { createRequire(location: unknown) { requires.push(location); return (requested: string) => { expect(requested).toBe("koffi"); return native; }; } };
    if (name === "../platform/os") return { HOST_PLATFORM: "win32", HOST_ARCH: "x64" };
    if (name === "./coding-platform") return { ScopedCodingFileError };
    if (name === "./windows-coding-native" || name === "./windows-coding-policy") return {};
    throw new Error("The fixed CJS module requested an unexpected import.");
  };
  runInNewContext(emitted, { module, exports: module.exports, require, __filename: filename, Buffer, setImmediate });
  const input = fake.input(); input.protectedPaths = [];
  await expect(module.exports.createFreshWindowsCommandTree(input)).rejects.toBeInstanceOf(ScopedCodingFileError);
  expect(requires).toEqual([filename]); expect(loads).toEqual(["ntdll.dll", "kernel32.dll", "advapi32.dll"]); expect(s.calls).toEqual([]); expect(fake.calls).toEqual([]);
});

it.skipIf(process.platform === "win32" && process.arch === "x64")("the default native factory refuses this unsupported host before loading a DLL", async () => {
  const s = setup(); await expect(createFreshWindowsCommandTree(s.input())).rejects.toMatchObject({ code: "unavailable" }); expect(s.calls).toEqual([]);
});
