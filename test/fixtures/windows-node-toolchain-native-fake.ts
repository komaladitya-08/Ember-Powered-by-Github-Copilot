/** Fixed native object model. Large assets are streamed marker bytes; no Windows call or executable runs. */
import path from "node:path/win32";
import { outputFake } from "./windows-command-output-fake";
import { OWNER, SYSTEM } from "./windows-command-creator-native-fake";
import { bindWindowsNodeToolchainNative, type WindowsNodeToolchainFence, type WindowsNodeToolchainOwner } from "../../app/main/agent/windows-node-toolchain-native";
import { bindWindowsCommandOutputNative, requireWindowsCommandOutputClosed, type WindowsCommandOutputLaunchRef } from "../../app/main/agent/windows-command-output";
import { windowsCommandCreatorProfile, closeWindowsCommandCreatorProfile } from "../../app/main/agent/windows-command-creator-profile";
import manifest from "../../app/shared/windows-node-toolchain.json";

const VOLUME = "\\\\?\\Volume{12345678-1234-1234-1234-123456789abc}\\", ALL = 0x1f01ff, RX = 0x1200a9;
export const ASSET_MARKERS = { node: 78, licence: 76, receipt: 82 } as const;
interface Security { owner: string; rx: boolean; directory: boolean; ownerRights: boolean; ownerMask: number; packageMask: number; low: boolean; protected: boolean; sacl: "explicit" | "absent" | "empty" }
export interface AssetRow { id: bigint; name: string; kind: "file" | "directory"; size: number; marker: number; damaged: boolean; links: number; attributes: number; created: bigint; written: bigint; changed: bigint; removed: boolean; security: Security }
interface Handle { row?: AssetRow; access: number; share: number; cursor: number; role?: "host" | "primary" | "duplicate"; source?: bigint }
interface Descriptor { bytes: Buffer; security: Security; row?: AssetRow; dacl: bigint; sacl: bigint; behaviouralPrincipal?: string }
export function nodeAssetFake(configuration: { fence?: WindowsNodeToolchainFence; handleBase?: bigint; io?: ReturnType<typeof outputFake>; signal?: AbortSignal; current?(): boolean } = {}) {
  const io = configuration.io ?? outputFake(), profile = windowsCommandCreatorProfile(io.profile), nodes = new Map<string, AssetRow>(), handles = new Map<bigint, Handle>();
  const buffers = new Map<bigint, Buffer>(), addresses = new WeakMap<Buffer, bigint>(), texts = new Map<bigint, string>(), descriptors = new Map<bigint, Descriptor>();
  const sids = new Map<bigint, string>(), aclEntries = new Map<bigint, { descriptor: Descriptor; label: boolean }>(), memory = new Map<bigint, Buffer>();
  const calls: { name: string; args: unknown[] }[] = [], opened: { raw: bigint; row: AssetRow; access: number; share: number; fresh: boolean }[] = [];
  const replacements: { original: AssetRow; replacement: AssetRow }[] = [];
  const overlappingAllocations: { raw: bigint; target: bigint; bytes: number }[] = [];
  const fence: WindowsNodeToolchainFence = configuration.fence ?? { retained: [] };
  const state = { current: true, fault: "", faultMode: "throw", readCalls: 0, writes: 0, maximumRead: 0, maximumWrite: 0, copiedBytes: 0, yieldsSeen: 0,
    nativeReadsAfterCreate: 0, tokenFault: "", allowWriteDac: false, allowWriteOwner: false, ordinaryAppContainer: false, ownerRights: true, ownerMask: 0x20000, packageMask: RX, low: true,
    imageMismatch: false, imagePath: "", sourceTamper: false, writeTamper: false, closeCalls: 0, frees: 0, nextHandleAlias: undefined as bigint | undefined,
    replaceHandover: "" as "" | "image" | "root",
    textBefore: "" as "" | "profile" | "descriptor",
    onCall: undefined as ((name: string, args: unknown[]) => void) | undefined,
    afterCall: undefined as ((name: string, args: unknown[], result: unknown) => unknown) | undefined };
  let serial = configuration.handleBase ?? 0x400000n, nextId = 1n, nextPointer = 0x30000000n;
  const pointer = () => nextPointer += 0x10000n;
  const address = (b: Buffer) => { let raw = addresses.get(b); if (raw === undefined) { raw = pointer(); addresses.set(b, raw); buffers.set(raw, b); } return raw; };
  const readPointer = (raw: bigint, size: number): Buffer => {
    const exact = memory.get(raw); if (exact) return exact.subarray(0, size);
    for (const [base, b] of buffers) if (raw >= base && raw + BigInt(size) <= base + BigInt(b.length)) return b.subarray(Number(raw - base), Number(raw - base) + size);
    for (const [base, descriptor] of descriptors) if (raw >= base && raw + BigInt(size) <= base + BigInt(descriptor.bytes.length)) return descriptor.bytes.subarray(Number(raw - base), Number(raw - base) + size);
    throw Error("PRIVATE unsupported pointer view");
  };
  const sidBytes = (text: string) => { const parts = text.split("-"), sub = parts.slice(3).map(Number), b = Buffer.alloc(8 + sub.length * 4); b[0] = 1; b[1] = sub.length;
    let authority = BigInt(parts[2]); for (let i = 5; i >= 0; i--) { b[2 + i] = Number(authority & 255n); authority >>= 8n; } sub.forEach((v, i) => b.writeUInt32LE(v, 8 + i * 4)); return b; };
  const sidText = (raw: bigint) => { const known = sids.get(raw); if (known) return known;
    const header = readPointer(raw, 8), b = readPointer(raw, 8 + header[1] * 4); let authority = 0n;
    for (let i = 2; i < 8; i++) authority = (authority << 8n) | BigInt(b[i]); return `S-${b[0]}-${authority}-${Array.from({ length: b[1] }, (_, i) => b.readUInt32LE(8 + i * 4)).join("-")}`; };
  const security = (directory: boolean, rx = false): Security => ({ owner: OWNER, directory, rx, ownerRights: state.ownerRights, ownerMask: state.ownerMask, packageMask: state.packageMask, low: rx && state.low, protected: true, sacl: "explicit" });
  const add = (name: string, kind: AssetRow["kind"], size = 0, marker = 0): AssetRow => { const row: AssetRow = { id: nextId++, name, kind, size, marker, damaged: false, links: 1,
    attributes: kind === "directory" ? 16 : 128, created: 100n, written: 200n, changed: 300n, removed: false, security: security(kind === "directory") }; nodes.set(name, row); return row; };
  for (const folder of ["C:\\", "C:\\scratch", "C:\\scratch\\tools", "C:\\Ember", "C:\\Ember\\resources", "C:\\Ember\\resources\\coding", "C:\\Ember\\resources\\coding\\windows-node-x64"]) add(folder, "directory");
  const sourceRoot = "C:\\Ember\\resources\\coding\\windows-node-x64";
  manifest.files.filter(member => member.ship).forEach(member => add(path.join(sourceRoot, member.name), "file", member.bytes, member.name === "node.exe" ? ASSET_MARKERS.node : member.name === "LICENSE" ? ASSET_MARKERS.licence : ASSET_MARKERS.receipt));
  const row = (raw: unknown) => { const value = handles.get(raw as bigint)?.row; if (!value) throw Error("PRIVATE unknown file handle"); return value; };
  const take = (record: Handle) => { const raw = state.nextHandleAlias ?? serial++; state.nextHandleAlias = undefined; handles.set(raw, record); return raw; };
  const descriptor = (sec: Security, object?: AssetRow) => {
    const raw = pointer(), b = Buffer.alloc(1024), dacl = raw + 128n, sacl = raw + 768n;
    const value: Descriptor = { bytes: b, security: { ...sec }, row: object, dacl, sacl }; descriptors.set(raw, value);
    sids.set(raw + 32n, sec.owner); sidBytes(sec.owner).copy(b, 32); aclEntries.set(dacl, { descriptor: value, label: false }); aclEntries.set(sacl, { descriptor: value, label: true });
    const entries = [{ sid: sec.owner, mask: ALL, type: 0 }, { sid: SYSTEM, mask: ALL, type: 0 }, ...(sec.rx ? [{ sid: profile.sidText, mask: sec.packageMask, type: 0 }, ...(sec.ownerRights ? [{ sid: "S-1-3-4", mask: sec.ownerMask, type: 0 }] : [])] : [])];
    b[128] = 2; b.writeUInt16LE(8 + entries.length * 64, 130); b.writeUInt16LE(entries.length, 132);
    for (const [index, entry] of entries.entries()) { const at = 136 + index * 64; b[at] = entry.type; b[at + 1] = sec.directory ? 3 : 0; b.writeUInt16LE(64, at + 2); b.writeUInt32LE(entry.mask, at + 4); sids.set(raw + BigInt(at + 8), entry.sid); sidBytes(entry.sid).copy(b, at + 8); }
    const label = sec.low ? "S-1-16-4096" : "S-1-16-8192";
    b[768] = 2; b.writeUInt16LE(sec.sacl === "explicit" ? 40 : 8, 770); b.writeUInt16LE(sec.sacl === "explicit" ? 1 : 0, 772);
    b[776] = 17; b[777] = sec.directory ? 3 : 0; b.writeUInt16LE(32, 778); b.writeUInt32LE(1, 780); sids.set(raw + 784n, label); sidBytes(label).copy(b, 784);
    return raw;
  };
  const fillToken = (token: Handle, kind: number, b: Buffer, returned: number[]) => {
    const emitSid = (offset: number, text: string, pointerOffset = 0) => { const bytes = sidBytes(text); bytes.copy(b, offset); b.writeBigUInt64LE(address(b) + BigInt(offset), pointerOffset); returned[0] = offset + bytes.length; };
    if (kind === 1) { emitSid(16, token.role !== "host" && state.tokenFault === "foreign-user" ? "S-1-5-21-7-8-9-1001" : OWNER); return; }
    if (kind === 29) { b.writeUInt32LE(state.tokenFault === "not-container" ? 0 : 1); returned[0] = 4; return; }
    if (kind === 30) { b.writeUInt32LE(state.tokenFault === "capability" ? 1 : 0); returned[0] = 8; return; }
    if (kind === 11) { b.writeUInt32LE(state.tokenFault === "unrestricted" ? 0 : 1);
      emitSid(24, state.tokenFault === "foreign-restricting" || state.tokenFault === "duplicate-restricting" && token.role === "duplicate" ? "S-1-15-2-1" : profile.sidText, 8);
      b.writeUInt32LE(state.tokenFault === "duplicate-restricting-attributes" && token.role === "duplicate" ? 3 : 7, 16); return; }
    if (kind === 31) { emitSid(8, state.tokenFault === "foreign-package" ? "S-1-15-2-1" : profile.sidText); return; }
    if (kind === 25) { emitSid(16, state.tokenFault === "medium" ? "S-1-16-8192" : "S-1-16-4096"); b.writeUInt32LE(state.tokenFault === "disabled-integrity" || state.tokenFault === "duplicate-integrity-attributes" && token.role === "duplicate" ? 0x20 : 0x60, 8); return; }
    if (kind === 27) { b.writeUInt32LE(state.tokenFault === "no-write-up-policy" ? 0 : 3); returned[0] = 4; return; }
    if (kind === 8) { b.writeUInt32LE(state.tokenFault === "primary-duplicate" || token.role !== "duplicate" ? 1 : 2); returned[0] = 4; return; }
    if (kind === 9) { b.writeUInt32LE(state.tokenFault === "bad-impersonation" ? 1 : 2); returned[0] = 4; return; }
    throw Error("PRIVATE unknown token class");
  };
  const native = { sizeof: (name: string) => name === "void *" || name === "size_t" ? 8 : 4, address,
    decode: Object.assign((raw: bigint, _type: string, size: number) => Uint8Array.from(readPointer(raw, size)), { string16: (raw: bigint) => { const text = texts.get(raw); if (text === undefined) throw Error("PRIVATE unknown string"); return text; } }) };
  const handlers: Record<string, (...args: unknown[]) => unknown> = {
    GetCurrentProcess: () => -1n,
    OpenProcessToken: (process, access, out) => { (out as unknown[])[0] = take({ access: Number(access), share: 0, cursor: 0, role: process === -1n ? "host" : "primary" }); return 1; },
    DuplicateTokenEx: (source, access, _security, level, kind, out) => { if (level !== 2 || kind !== 2 || handles.get(source as bigint)?.role !== "primary") throw Error("PRIVATE invalid token source");
      (out as unknown[])[0] = take({ access: Number(access), share: 0, cursor: 0, role: "duplicate", source: source as bigint }); return 1; },
    GetTokenInformation: (raw, kind, b, _size, returned) => { const h = handles.get(raw as bigint); if (!h?.role) throw Error("PRIVATE unknown token"); fillToken(h, Number(kind), b as Buffer, returned as number[]); return 1; },
    ConvertSidToStringSidW: (sid, out) => { let raw = pointer(); const value = sidText(sid as bigint);
      const target = state.textBefore === "profile" ? profile.sid : state.textBefore === "descriptor" ? [...descriptors.keys()].at(-1) : undefined;
      if (!overlappingAllocations.length && target !== undefined) { raw = target - 16n; overlappingAllocations.push({ raw, target, bytes: (value.length + 1) * 2 }); }
      texts.set(raw, value); (out as unknown[])[0] = raw; return 1; },
    ConvertStringSecurityDescriptorToSecurityDescriptorW: (text, _revision, out) => { const literal = String(text); const sec = security(literal.includes("OICI"), true);
      sec.ownerRights = literal.includes(";;;OW)"); sec.ownerMask = literal.includes(";RC;;;OW)") ? 0x20000 : ALL; sec.packageMask = literal.includes("0x1200a9") ? RX : ALL;
      const raw = descriptor(sec), principal = /\(A;;0x1;;;((?:S-1-15-2-)[^)]*)\)/.exec(literal)?.[1];
      if (principal) descriptors.get(raw)!.behaviouralPrincipal = principal; (out as unknown[])[0] = raw; return 1; },
    LocalFree: raw => { state.frees++; const d = descriptors.get(raw as bigint); if (d) { aclEntries.delete(d.dacl); aclEntries.delete(d.sacl); descriptors.delete(raw as bigint); } texts.delete(raw as bigint); return null; },
    GetDriveTypeW: () => 3,
    GetVolumeInformationW: (...args) => { (args[6] as Buffer).write("NTFS\0", "utf16le"); return 1; },
    NtCreateFile: (...args) => { const attrs = args[2] as Buffer, unicode = readPointer(attrs.readBigUInt64LE(16), 16), text = readPointer(unicode.readBigUInt64LE(8), unicode.readUInt16LE(0));
      const parent = attrs.readBigUInt64LE(8), name = parent ? path.join(row(parent).name, text.toString("utf16le")) : text.toString("utf16le").replace(/^\\\?\?\\/, "");
      const fresh = args[7] === 2; let object = nodes.get(name);
      if (fresh) { if (object && !object.removed) return 0xc0000035; object = add(name, Number(args[8]) & 1 ? "directory" : "file"); object.security = { ...descriptors.get(attrs.readBigUInt64LE(32))!.security }; }
      if (!fresh && object?.security.rx && name.startsWith("C:\\scratch\\tools\\ember-node-") && !replacements.length &&
          (state.replaceHandover === "image" && object.kind === "file" && args[1] === 0x120080 || state.replaceHandover === "root" && object.kind === "directory" && args[1] === 0x1200a0)) {
        const original = object, replacement = { ...original, id: nextId++, security: { ...original.security } };
        nodes.set(name, replacement); object = replacement; replacements.push({ original, replacement });
      }
      if (!object || object.removed) return 0xc0000034;
      const raw = take({ row: object, access: Number(args[1]), share: Number(args[6]), cursor: 0 }); (args[0] as unknown[])[0] = raw; (args[3] as Buffer).writeBigUInt64LE(fresh ? 2n : 1n, 8);
      opened.push({ raw, row: object, access: Number(args[1]), share: Number(args[6]), fresh }); return 0; },
    GetHandleInformation: (_raw, out) => { (out as unknown[])[0] = 0; return 1; },
    NtQueryObject: (raw, _kind, b, _size, returned) => { (b as Buffer).writeUInt32LE(handles.get(raw as bigint)!.access, 4); (returned as number[])[0] = 56; return 0; },
    GetFileType: () => 1,
    GetFileInformationByHandle: (raw, out) => { const f = row(raw), b = out as Buffer; b.writeUInt32LE(f.attributes); b.writeBigUInt64LE(f.created, 4); b.writeBigUInt64LE(f.written, 20); b.writeUInt32LE(1, 28);
      b.writeUInt32LE(Math.floor(f.size / 0x100000000), 32); b.writeUInt32LE(f.size % 0x100000000, 36); b.writeUInt32LE(f.links, 40); b.writeUInt32LE(Number(f.id >> 32n), 44); b.writeUInt32LE(Number(f.id & 0xffffffffn), 48); return 1; },
    GetFileInformationByHandleEx: (raw, _kind, out) => { const f = row(raw), b = out as Buffer; b.writeBigUInt64LE(f.created); b.writeBigUInt64LE(f.written, 16); b.writeBigUInt64LE(f.changed, 24); b.writeUInt32LE(f.attributes, 32); return 1; },
    GetFinalPathNameByHandleW: (raw, out) => { const value = VOLUME + row(raw).name.slice(3); (out as Buffer).write(value, "utf16le"); return value.length; },
    NtQueryInformationFile: (raw, io, out) => { const f = row(raw), b = out as Buffer; if (f.kind === "directory") { (io as Buffer).writeBigUInt64LE(0n, 8); return 0; }
      b.writeUInt32LE(14, 4); b.writeBigInt64LE(BigInt(f.size), 8); b.write("::$DATA", 24, "utf16le"); (io as Buffer).writeBigUInt64LE(38n, 8); return 0; },
    GetSecurityInfo: (raw, _kind, _information, own, _group, dacl, sacl, out) => { const f = row(raw), sec = { ...f.security };
      if (sec.rx) { sec.ownerRights &&= state.ownerRights; sec.ownerMask = state.ownerMask; sec.packageMask = state.packageMask; sec.low &&= state.low; }
      const sd = descriptor(sec, f), d = descriptors.get(sd)!;
      (own as unknown[])[0] = sd + 32n; (dacl as unknown[])[0] = d.dacl; if (sacl) (sacl as unknown[])[0] = sec.sacl === "absent" ? null : d.sacl; (out as unknown[])[0] = sd; return 0; },
    GetSecurityDescriptorLength: raw => descriptors.get(raw as bigint)!.bytes.length,
    GetSecurityDescriptorControl: (raw, out, revision) => { const s = descriptors.get(raw as bigint)!.security; (out as Buffer).writeUInt16LE(4 | (s.protected ? 0x1000 : 0) | (s.sacl === "absent" ? 0 : 16)); (revision as number[])[0] = 1; return 1; },
    GetSecurityDescriptorSacl: (raw, present, acl, defaulted) => { const d = descriptors.get(raw as bigint)!; (present as number[])[0] = d.security.sacl === "absent" ? 0 : 1;
      (acl as unknown[])[0] = d.security.sacl === "absent" ? null : d.sacl; (defaulted as number[])[0] = 0; return 1; },
    GetAclInformation: (raw, out) => { const acl = aclEntries.get(raw as bigint)!, s = acl.descriptor.security; (out as Buffer).writeUInt32LE(acl.label ? s.sacl === "explicit" ? 1 : 0 : s.rx ? s.ownerRights ? 4 : 3 : 2); return 1; },
    GetAce: (raw, index, out) => { const acl = aclEntries.get(raw as bigint)!, base = [...descriptors.entries()].find(([, d]) => d === acl.descriptor)![0]; (out as unknown[])[0] = base + BigInt(acl.label ? 776 : 136 + Number(index) * 64); return 1; },
    NtQueryDirectoryFile: (...args) => { const h = handles.get(args[0] as bigint)!, f = h.row!, io = args[4] as Buffer, b = args[5] as Buffer; if (args[10] === 1) h.cursor = 0;
      const children = [...nodes.values()].filter(candidate => !candidate.removed && candidate !== f && path.dirname(candidate.name) === f.name).sort((a, c) => a.name.localeCompare(c.name));
      const child = children[h.cursor++]; if (!child) { io.writeUInt32LE(0x80000006); return 0x80000006; } const name = path.basename(child.name), length = 104 + name.length * 2;
      b.writeBigInt64LE(BigInt(child.size), 40); b.writeUInt32LE(child.attributes, 56); b.writeUInt32LE(name.length * 2, 60); b.writeBigUInt64LE(child.id, 96); b.write(name, 104, "utf16le"); io.writeBigUInt64LE(BigInt(length), 8); return 0; },
    NtReadFile: (...args) => { state.readCalls++; if (io.state.creates) state.nativeReadsAfterCreate++; const f = row(args[0]), offset = Number((args[7] as Buffer).readBigInt64LE()), count = Math.min(Number(args[6]), Math.max(0, f.size - offset));
      state.maximumRead = Math.max(state.maximumRead, Number(args[6])); const b = args[5] as Buffer; b.fill(f.marker, 0, count); if (count && (f.damaged || state.sourceTamper && f.name.startsWith(sourceRoot))) b[0] ^= 1;
      (args[4] as Buffer).writeBigUInt64LE(BigInt(count), 8); if (!count) (args[4] as Buffer).writeUInt32LE(0xc0000011); return count ? 0 : 0xc0000011; },
    NtWriteFile: (...args) => { const f = row(args[0]), offset = Number((args[7] as Buffer).readBigInt64LE()), count = Number(args[6]), b = args[5] as Buffer; state.writes++; state.maximumWrite = Math.max(state.maximumWrite, count); state.copiedBytes += count;
      f.marker ||= b[0]; f.damaged ||= !b.equals(Buffer.alloc(count, f.marker)) || state.writeTamper; f.size = Math.max(f.size, offset + count); f.written++; f.changed++; (args[4] as Buffer).writeBigUInt64LE(BigInt(count), 8); return 0; },
    FlushFileBuffers: () => 1,
    NtSetInformationFile: (raw, io) => { const f = row(raw); f.removed = true; (io as Buffer).writeUInt32LE(0); return 0; },
    GetProcessId: () => io.state.returnedPid,
    QueryFullProcessImageNameW: (_process, _flags, out, count) => { const image = state.imagePath ? nodes.get(state.imagePath)! : [...nodes.values()].find(f => f.name.startsWith("C:\\scratch\\tools\\ember-node-") && f.kind === "file")!;
      const name = state.imageMismatch ? "C:\\foreign\\node.exe" : image.name; (out as Buffer).write(name, "utf16le"); (count as number[])[0] = name.length; return 1; },
    AccessCheck: (raw, token, desired, _mapping, _privileges, length, granted, allowed) => { const d = descriptors.get(raw as bigint)!, h = handles.get(token as bigint); if (h?.role !== "duplicate") throw Error("PRIVATE AccessCheck requires an impersonation duplicate");
      const mask = Number(desired), permitted = d.behaviouralPrincipal !== undefined ? mask === 1 && (d.behaviouralPrincipal === profile.sidText || d.behaviouralPrincipal === "S-1-15-2-1" && state.ordinaryAppContainer) :
        state.tokenFault === "unrestricted" || (mask === RX ? d.security.packageMask === RX : mask === 0x40000 ? state.allowWriteDac || !d.security.ownerRights : state.allowWriteOwner);
      (length as number[])[0] = 0; (granted as number[])[0] = permitted ? mask : 0; (allowed as number[])[0] = permitted ? 1 : 0; return 1; },
    CloseHandle: raw => { state.closeCalls++; if (!handles.delete(raw as bigint)) throw Error("PRIVATE duplicate handle close"); return 1; },
  };
  const load = (_library: string) => ({ func(prototype: string) { const name = /\b(\w+)\s*\(/.exec(prototype)![1]; if (!handlers[name]) throw Error("PRIVATE unexpected prototype"); return (...args: unknown[]) => {
    const saved = name === "NtReadFile" || name === "NtWriteFile" ? args.map(value => Buffer.isBuffer(value) ? { bytes: value.length } : value) : args;
    calls.push({ name, args: saved }); state.onCall?.(name, args);
    if (state.fault === name) { if (state.faultMode === "throw") throw Error("PRIVATE native uncertainty"); return state.faultMode === "bad" ? "bad" : name.startsWith("Nt") ? 1 : name === "LocalFree" ? args[0] : 0; }
    const result = handlers[name](...args); return state.afterCall ? state.afterCall(name, args, result) : result;
  }; } });
  const createOutput = (requested: typeof io.profile, options: Parameters<typeof bindWindowsCommandOutputNative>[4]) => {
    if (requested !== io.profile) throw Error("PRIVATE profile substitution");
    return bindWindowsCommandOutputNative(io.native as unknown as Parameters<typeof bindWindowsCommandOutputNative>[0], io.loader, io.profile, { ownerSid: OWNER }, options, io.fence, () => io.state.now);
  };
  const binding = bindWindowsNodeToolchainNative(native as unknown as Parameters<typeof bindWindowsNodeToolchainNative>[0], load, fence, createOutput);
  const input = () => ({ resourcesPath: "C:\\Ember\\resources", privateParent: "C:\\scratch\\tools", profile: io.profile,
    signal: configuration.signal ?? io.abort.signal, current: configuration.current ?? (() => state.current) });
  const prepare = () => binding.prepare(input());
  const launch = async (owner: WindowsNodeToolchainOwner, argv: readonly string[] = ["--preserve-symlinks", "--preserve-symlinks-main", "test.cjs"]) => {
    // A new fake job starts empty; the native allocator may reuse the positively freed COM address.
    io.state.assigned = false; io.state.ended = false; io.state.profileFrees = 0;
    const copy = await io.prepare(); let ref: WindowsCommandOutputLaunchRef | undefined;
    const run = await copy.launchRootOnlyWithOutput(context => ref = owner.createSuspended(context, argv, io.options), () => undefined); return { copy, ref: ref!, run };
  };
  const finish = async (owner: WindowsNodeToolchainOwner, value: Awaited<ReturnType<typeof launch>>) => {
    io.state.ended = true; const done = await value.copy.completeRootOnly(value.run, io.abort.signal), closed = await owner.finishOutput(done, value.run, value.ref);
    const facts = requireWindowsCommandOutputClosed(closed, value.ref, value.run); await value.copy.close(); await owner.close(); closeWindowsCommandCreatorProfile(io.profile); return { done, closed, facts };
  };
  return { io, state, nodes, handles, calls, opened, fence, native, load, binding, input, prepare, launch, finish, add, replacements, overlappingAllocations,
    assets: () => [...nodes.values()].filter(f => f.name.startsWith("C:\\scratch\\tools\\ember-node-")),
    descriptorRows: descriptors };
}
