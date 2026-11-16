/** Synthetic Win32 object model shared by baseline and creator-owner composition tests. No real native call. */
import path from "node:path/win32";
import { bindWindowsCommandCopyNative, type FreshWindowsCommandTreeInput, type WindowsCommandCopyCleanupError } from "../../app/main/agent/windows-command-copy-native";
import type { CodingExportEntry } from "../../app/main/agent/coding-result-export";
export const OWNER = "S-1-5-21-1-2-3-1001", SYSTEM = "S-1-5-18", PACKAGE = "S-1-15-2-1234-5678";
const VOLUME = "\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\";
export type Security = { owner: string; aclOwner?: string; package?: string; inherited: boolean; low: boolean; extra?: boolean; badMask?: boolean; automatic?: boolean };
export type ObjectRow = { id: bigint; name: string; kind: "file" | "directory"; bytes: Buffer; security: Security; links: number; attributes: number; created: bigint; written: bigint; changed: bigint; streams?: boolean; removed?: boolean; deletePending?: boolean; reportedSize?: number; serial?: number };
type Handle = { object?: ObjectRow; access: number; share: number; index: number; tokenProcess?: bigint };
export function setup() {
  const buffers = new Map<bigint, Buffer>(), addresses = new WeakMap<Buffer, bigint>(), texts = new Map<bigint, string>(), sids = new Map<bigint, string>(), descriptors = new Map<bigint, Security>();
  const aclRows = new Map<bigint, { row: ObjectRow; label: boolean }>(), aceRows = new Map<bigint, Buffer>();
  const converted = new Map<bigint, { security: Security; length: number; dacl: bigint; sacl: bigint }>(), aclHeaders = new Map<bigint, Buffer>();
  const objects = new Map<string, ObjectRow>(), handles = new Map<bigint, Handle>();
  const calls: { name: string; args: unknown[] }[] = [], opened: { raw: bigint; object: ObjectRow; access: number; share: number; fresh: boolean; parent: bigint }[] = [];
  let serial = 100n, nextId = 1n, nextPointer = 0x10000n, sets = 0;
  const control = { fault: "", failSet: 0, current: true, label: true, owner: OWNER, dataReads: 0, yieldRetire: false, retireOnSet: 0, streamBytes: undefined as number | undefined, streamStatus: 0, directoryStatus: 0, directoryBytes: undefined as number | undefined,
    tokenUser: OWNER, tokenPackage: "S-1-15-2-10-11-12-13-14-15-16", tokenOwner: "S-1-5-32-544", tokenFault: "", tokenHook: undefined as ((kind: number) => void) | undefined };
  const fence = { retained: [] as unknown[], failure: undefined as WindowsCommandCopyCleanupError | undefined };
  // Each synthetic allocation reserves enough address space for bounded internal descriptor views.
  const pointer = () => nextPointer += 0x1000n;
  const address = (bytes: Buffer) => { let p = addresses.get(bytes); if (p === undefined) { p = pointer(); addresses.set(bytes, p); buffers.set(p, bytes); } return p; };
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
    OpenProcessToken: (...args) => {
      const rootToken = args[0] !== -1n;
      if (rootToken && control.tokenFault === "open missing") return 1;
      if (rootToken && control.tokenFault === "open alias") { (args[2] as unknown[])[0] = handles.keys().next().value; return 1; }
      if (rootToken && control.tokenFault === "open Stop job alias") { (args[2] as unknown[])[0] = 50000n; return 1; }
      const raw = serial++; handles.set(raw, { access: 8, share: 0, index: 0, tokenProcess: args[0] as bigint }); (args[2] as unknown[])[0] = raw;
      if (rootToken && control.tokenFault === "open throw") throw new Error("private token creation uncertainty");
      return rootToken && control.tokenFault === "open false" ? 0 : 1;
    },
    GetTokenInformation: (...args) => {
      if (handles.get(args[0] as bigint)?.tokenProcess === -1n) { (args[2] as Buffer).writeBigUInt64LE(sidPointer(OWNER)); (args[4] as number[])[0] = 16; return 1; }
      const bytes = args[2] as Buffer, kind = Number(args[1]), header = kind === 1 ? 16 : 8;
      const text = kind === 1 ? control.tokenUser : kind === 31 ? control.tokenPackage : control.tokenOwner;
      const parts = text.split("-"), sub = parts.slice(3).map(Number); let authority = BigInt(parts[2]);
      bytes.fill(0); bytes[header] = 1; bytes[header + 1] = sub.length;
      for (let i = 5; i >= 0; i--) { bytes[header + 2 + i] = Number(authority & 255n); authority >>= 8n; }
      sub.forEach((value, index) => bytes.writeUInt32LE(value, header + 8 + index * 4));
      bytes.writeBigUInt64LE(address(bytes) + BigInt(header)); (args[4] as number[])[0] = header + 8 + sub.length * 4;
      if (control.tokenFault === "short returned" && kind === 4) (args[4] as number[])[0] = header + 7;
      if (control.tokenFault === "outside pointer" && kind === 4) bytes.writeBigUInt64LE(address(bytes) + BigInt(bytes.length));
      if (control.tokenFault === "bad revision" && kind === 4) bytes[header] = 2;
      control.tokenHook?.(kind);
      if (control.tokenFault === `query throw ${kind}`) throw new Error("private token query uncertainty");
      return control.tokenFault === `query false ${kind}` ? 0 : 1;
    },
    ConvertSidToStringSidW: (...args) => { const p = pointer(); texts.set(p, sids.get(args[0] as bigint)!); (args[1] as unknown[])[0] = p; return 1; },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: (...args) => {
      const text = args[0] as string, p = pointer(); const pkg = /0x1301bf;;;([^)]*)/.exec(text)?.[1];
      const security = { owner: OWNER, package: pkg, inherited: false, low: true };
      descriptors.set(p, security);
      const dacl = p + 64n, sacl = p + 384n;
      for (const [raw, count] of [[dacl, pkg ? 3 : 2], [sacl, 1]] as const) {
        const bytes = Buffer.alloc(8); bytes[0] = 2; bytes.writeUInt16LE(8 + count * 48, 2); bytes.writeUInt16LE(count, 4); aclHeaders.set(raw, bytes);
      }
      converted.set(p, { security, length: 512, dacl, sacl });
      (args[2] as unknown[])[0] = p; return control.fault === "descriptor false" ? 0 : 1;
    },
    LocalFree: (...args) => {
      if (control.fault === "free throw") throw new Error("private allocator uncertainty"); if (control.fault === "free") return args[0];
      const raw = args[0] as bigint, view = converted.get(raw);
      if (view) { aclHeaders.delete(view.dacl); aclHeaders.delete(view.sacl); converted.delete(raw); }
      descriptors.delete(raw); return null;
    },
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
    GetSecurityDescriptorControl: (...args) => { const sec = descriptors.get(args[0] as bigint)!; (args[1] as number[])[0] = 4 | 16 | (sec.inherited ? 0 : 0x1000) | (sec.automatic ? 0xc00 : 0); return 1; },
    GetSecurityDescriptorLength: (...args) => converted.get(args[0] as bigint)?.length ?? 0,
    GetSecurityDescriptorDacl: (...args) => {
      const view = converted.get(args[0] as bigint); if (!view) return 0;
      (args[1] as unknown[])[0] = 1; (args[2] as unknown[])[0] = view.dacl; (args[3] as unknown[])[0] = 0; return 1;
    },
    GetSecurityDescriptorSacl: (...args) => {
      const view = converted.get(args[0] as bigint); if (!view) return 0;
      (args[1] as unknown[])[0] = 1; (args[2] as unknown[])[0] = view.sacl; (args[3] as unknown[])[0] = 0; return 1;
    },
    SetSecurityInfo: (...args) => {
      sets++; if (control.failSet && sets === control.failSet) throw new Error("private partial ACL error");
      if (args[1] !== 1 || args[2] !== 0x80000014 || args[3] !== null || args[4] !== null) return 87;
      const descriptor = [...converted.values()].find(value => value.dacl === args[5] && value.sacl === args[6]); if (!descriptor) return 87;
      const row = file(args[0]), previous = row.security.owner;
      row.security = { ...descriptor.security, aclOwner: descriptor.security.owner, owner: previous, automatic: true };
      if (control.retireOnSet && sets === control.retireOnSet) control.current = false;
      return 0;
    },
    GetAclInformation: (...args) => { const acl = aclRows.get(args[0] as bigint)!, count = acl.label ? 1 : (acl.row.security.package ? 3 : 2) + (acl.row.security.extra ? 1 : 0); (args[1] as Buffer).writeUInt32LE(count); return 1; },
    GetAce: (...args) => {
      const acl = aclRows.get(args[0] as bigint)!, sec = acl.row.security, index = Number(args[1]), p = pointer(), b = Buffer.alloc(8);
      b[0] = acl.label ? 17 : 0; b[1] = (acl.row.kind === "directory" ? 3 : 0) | (sec.inherited ? 16 : 0); b.writeUInt16LE(28, 2);
      b.writeUInt32LE(acl.label ? 1 : index === 2 ? sec.badMask ? 0x1f01ff : 0x1301bf : 0x1f01ff, 4);
      aceRows.set(p, b); sids.set(p + 8n, acl.label ? sec.low && control.label ? "S-1-16-4096" : "S-1-16-8192" : index === 0 ? sec.aclOwner ?? sec.owner : index === 1 ? SYSTEM : sec.package!); (args[2] as unknown[])[0] = p; return 1;
    },
    NtSetSecurityObject: (...args) => {
      sets++; if (control.failSet && sets === control.failSet) throw new Error("private partial ACL error");
      const row = file(args[0]), descriptor = descriptors.get(args[2] as bigint)!;
      row.security = { ...descriptor, aclOwner: descriptor.aclOwner ?? descriptor.owner, owner: Number(args[1]) & 1 ? descriptor.owner : row.security.owner };
      if (control.retireOnSet && sets === control.retireOnSet) control.current = false; return 0;
    },
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
    CloseHandle: (...args) => {
      const token = handles.get(args[0] as bigint)?.tokenProcess;
      if (token !== undefined && token !== -1n && control.tokenFault === "close throw") throw new Error("private token close uncertainty");
      if (token !== undefined && token !== -1n && control.tokenFault === "close false") return 0;
      if (control.fault === "close throw") { handles.delete(args[0] as bigint); throw new Error("private close uncertainty"); } if (control.fault === "close") return 0; handles.delete(args[0] as bigint); return 1;
    },
  };
  const native = { sizeof: () => 8, address, decode: Object.assign((p: bigint) => aceRows.get(p) ?? aclHeaders.get(p)!, { string16: (p: bigint) => texts.get(p)! }) } as unknown as Parameters<typeof bindWindowsCommandCopyNative>[0];
  const load = () => ({ func(prototype: string) { const name = /\b(\w+)\s*\(/.exec(prototype)![1]; return (...args: unknown[]) => { calls.push({ name, args }); const handler = handlers[name]; if (!handler) throw new Error("unexpected native test call"); return handler(...args); }; } });
  const binding = bindWindowsCommandCopyNative(native, load, fence);
  const input = (entries: readonly CodingExportEntry[] = [{ path: "a.ts", kind: "file", bytes: Buffer.from("baseline"), executable: false }]): FreshWindowsCommandTreeInput => ({ parent: "C:\\scratch", protectedPaths: ["C:\\source"], entries, current: () => control.current });
  return { binding, input, control, calls, handles, objects, opened, fence, add, handlers, native, sets: () => sets, root: () => [...objects.values()].find(row => path.basename(row.name).startsWith("ember-command-"))! };
}
