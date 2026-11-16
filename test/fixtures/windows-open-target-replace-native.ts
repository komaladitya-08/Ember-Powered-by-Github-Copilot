/** Parameter-equivalent ordinary-host control. This is not the production Native tree factory. */
import path from "node:path/win32";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type * as Koffi from "koffi";
import { HOST_ARCH, HOST_PLATFORM } from "../../app/main/platform/os";
import { WINDOWS_COMMAND_COPY_FUNCTIONS } from "../../app/main/agent/windows-command-copy-native";
import { decodeWindowsCodingDirectoryBatch } from "../../app/main/agent/windows-coding-native";
import { windowsCommandCreatorTokenSid } from "../../app/main/agent/windows-command-creator-token";
import { bindWindowsCommandCreatorTree, requireWindowsCommandCreatorTree, releaseWindowsCommandCreatorTree, windowsCommandCreatorProfile,
  type WindowsCommandCreatorProfileRef } from "../../app/main/agent/windows-command-creator-profile";
import { requireWindowsCommandRootOnlyPreparing, requireWindowsCommandRootOnlyCompletion } from "../../app/main/agent/windows-command-stop";
import { bindWindowsCommandCreatorOwnerHostNative, type WindowsCommandCreatorOwnerHostNative } from "./windows-command-creator-owner-host";

type Fn = (...args: unknown[]) => unknown;
type Codec = Pick<typeof Koffi, "sizeof" | "address" | "decode">;
type Load = (name: string) => { func(prototype: string): unknown };
export class WindowsOpenTargetReplaceCleanupError extends Error {
  constructor() { super("The open-target control retains unverified owners."); this.name = "WindowsOpenTargetReplaceCleanupError"; this.stack = `${this.name}: ${this.message}`; }
}
export interface WindowsOpenTargetReplaceFence { retained: unknown[] }
const failures = new WeakMap<WindowsOpenTargetReplaceFence, WindowsOpenTargetReplaceCleanupError>();
const processFence: WindowsOpenTargetReplaceFence = { retained: [] };
const valid = (v: unknown): v is bigint => typeof v === "bigint" && v > 0n && v < 0x8000000000000000n;
const OLD = Buffer.from("EMBER_OPEN_TARGET_OLD\n"), NEW = Buffer.from("EMBER_OPEN_TARGET_NEW\n");
const META = 0x1e0080, ALL = 0x1f01ff, MODIFY = 0x1301bf;
interface Info { id: string; volume: number; attributes: number; size: number; links: number; created: bigint }
export interface WindowsOpenTargetReplaceFixture {
  readonly directory: string; readonly report: string;
  readReport(stopped: unknown): Buffer;
  verifyAndClose(stopped: unknown, bSuccess: 0 | 1): Readonly<{ equalInitialState: 1; aNeverPinned: 1; bHeldThroughStop: 1; privateCleanup: 1 }>;
}
export interface WindowsOpenTargetReplaceNative {
  readonly host: WindowsCommandCreatorOwnerHostNative;
  guard<T>(operation: () => T): T;
  create(parent: string, profile: WindowsCommandCreatorProfileRef, binding: object, current: () => boolean): WindowsOpenTargetReplaceFixture;
}

/** Fault seam; production uses only the default Koffi loader. No injectable acceptance predicates. */
export function bindWindowsOpenTargetReplaceNative(native: Codec, load: Load, fence: WindowsOpenTargetReplaceFence = processFence): WindowsOpenTargetReplaceNative {
  const handles = new Set<bigint>(), allocations = new Set<bigint>(), foreign = new Set<bigint>(), borrowed = new Set<bigint>(), attempted = new Set<bigint>(), pending = new Set<unknown>();
  const retained = { handles, allocations, foreign, borrowed, attempted, pending, native, load, get selected() { return selected; } };
  let closed = false, selected: { profile: WindowsCommandCreatorProfileRef; key: object; binding: object; current: () => boolean; staging: boolean } | undefined;
  const fail = (): never => {
    let error = failures.get(fence); if (!error) { error = new WindowsOpenTargetReplaceCleanupError(); failures.set(fence, error); fence.retained.push(retained); }
    throw error;
  };
  const usable = () => { const error = failures.get(fence); if (error) throw error; if (closed) throw new WindowsOpenTargetReplaceCleanupError(); };
  const active = () => {
    usable(); if (!selected) return;
    try { requireWindowsCommandCreatorTree(selected.profile, selected.key); if (selected.staging) requireWindowsCommandRootOnlyPreparing(selected.binding); }
    catch { return fail(); }
    const current = selected.current; let result: unknown; try { result = current(); } catch { return fail(); }
    usable(); if (result !== true) fail();
    try { requireWindowsCommandCreatorTree(selected.profile, selected.key); if (selected.staging) requireWindowsCommandRootOnlyPreparing(selected.binding); }
    catch { return fail(); }
  };
  const guard = <T>(operation: () => T): T => { active(); let result: T; try { result = operation(); } catch { return fail(); } active(); return result; };
  const fn: Record<string, Fn> = {};
  try {
    usable(); if (native.sizeof("void *") !== 8) fail();
    for (const [library, prototypes] of Object.entries(WINDOWS_COMMAND_COPY_FUNCTIONS)) {
      const dll = load(`${library}.dll`);
      for (const prototype of prototypes) { const value = dll.func(prototype); if (typeof value !== "function") fail(); fn[/\b(\w+)\s*\(/.exec(prototype)![1]] = value as Fn; }
    }
  } catch { fail(); }
  const invoke = (name: string, args: unknown[], accept: (value: unknown) => boolean): unknown => {
    active(); const frame = { name, args }; pending.add(frame); let value: unknown;
    try { value = fn[name](...args); } catch { return fail(); }
    active(); if (!accept(value)) fail(); pending.delete(frame); return value;
  };
  const bool = (name: string, args: unknown[]) => invoke(name, args, value => value === 1 || value === true);
  const nt = (name: string, args: unknown[]) => invoke(name, args, value => value === 0);
  const pointer = (v: unknown): bigint => { if (!valid(v)) fail(); return v as bigint; };
  const own = (value: unknown, bucket: Set<bigint>) => { const raw = pointer(value); if (handles.has(raw) || allocations.has(raw) || foreign.has(raw) || borrowed.has(raw)) fail(); attempted.delete(raw); bucket.add(raw); return raw; };
  const close = (raw: bigint) => { active(); if (!handles.has(raw) || attempted.has(raw)) fail(); attempted.add(raw); bool("CloseHandle", [raw]); handles.delete(raw); };
  const free = (raw: bigint) => { active(); if (!allocations.has(raw) || attempted.has(raw)) fail(); attempted.add(raw); invoke("LocalFree", [raw], v => v === null || v === 0n); allocations.delete(raw); };
  const decode = (raw: bigint, count: number) => {
    active(); if (!valid(raw) || !Number.isInteger(count) || count < 1 || count > 65536 || raw + BigInt(count) >= 0x8000000000000000n) fail();
    let out: Buffer; try { out = Buffer.from(native.decode(raw, "uint8_t", count) as Uint8Array); } catch { return fail(); }
    active(); if (out.length !== count) fail(); return out;
  };
  const descriptor = <T>(sddl: string, operation: (raw: bigint) => T): T => {
    active(); const out: unknown[] = [null]; pending.add(out); let result: unknown;
    try { result = fn.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out, null); } catch { if (valid(out[0])) own(out[0], allocations); return fail(); }
    const raw = own(out[0], allocations); active(); if (result !== true && result !== 1) fail(); pending.delete(out);
    const returned = operation(raw); free(raw); return returned;
  };
  const acquire = (parent: bigint | null, name: string, directory: boolean, access: number, share: number, create = false, sd: bigint | null = null) => {
    active(); if (name.length < 1 || name.length > 2048 || /[\0\p{Cc}\p{Cf}]/u.test(name) || handles.size > 128) fail();
    const text = Buffer.from(name + "\0", "utf16le"), unicode = Buffer.alloc(16), attributes = Buffer.alloc(48), io = Buffer.alloc(16), out: unknown[] = [null];
    unicode.writeUInt16LE(text.length - 2); unicode.writeUInt16LE(text.length, 2); unicode.writeBigUInt64LE(pointer(native.address(text)), 8);
    attributes.writeUInt32LE(48); if (parent !== null) attributes.writeBigUInt64LE(parent, 8); attributes.writeBigUInt64LE(pointer(native.address(unicode)), 16); attributes.writeUInt32LE(0x1040, 24); if (sd !== null) attributes.writeBigUInt64LE(sd, 32);
    const frame = { text, unicode, attributes, io, out }; pending.add(frame); let result: unknown;
    active(); try { result = fn.NtCreateFile(out, access, attributes, io, null, create ? directory ? 16 : 128 : 0, share, create ? 2 : 1, 0x200020 | (directory ? 1 : 0x40), null, 0); }
    catch { if (valid(out[0])) own(out[0], handles); return fail(); }
    const raw = own(out[0], handles); active(); if (result !== 0 || io.readUInt32LE(0) !== 0 || io.readBigUInt64LE(8) !== BigInt(create ? 2 : 1)) fail();
    const flags = [0xffffffff], basic = Buffer.alloc(56), returned = [0]; bool("GetHandleInformation", [raw, flags]); nt("NtQueryObject", [raw, 0, basic, basic.length, returned]);
    const rights = basic.readUInt32LE(4); if (flags[0] !== 0 || returned[0] !== 56 || (rights & access) !== access || (rights & ~(access | 0x80 | 0x100000)) !== 0) fail();
    text.fill(0); unicode.fill(0); pending.delete(frame); return raw;
  };
  const info = (raw: bigint, detached = false): Info => {
    if (!handles.has(raw)) fail(); invoke("GetFileType", [raw], v => v === 1);
    const data = Buffer.alloc(52), basic = Buffer.alloc(40); bool("GetFileInformationByHandle", [raw, data]); bool("GetFileInformationByHandleEx", [raw, 0, basic, basic.length]);
    const attributes = data.readUInt32LE(0), size = data.readUInt32LE(32) * 0x100000000 + data.readUInt32LE(36), links = data.readUInt32LE(40);
    if (attributes & 0x445640 || !Number.isSafeInteger(size) || (!detached && links !== 1) || detached && links > 1 || attributes !== basic.readUInt32LE(32) || data.readBigUInt64LE(4) !== basic.readBigUInt64LE(0) || data.subarray(44, 52).every(v => v === 0)) fail();
    return { id: data.subarray(44, 52).toString("hex"), volume: data.readUInt32LE(28), attributes, size, links, created: basic.readBigUInt64LE(0) };
  };
  const same = (a: Info, b: Info) => a.id === b.id && a.volume === b.volume && a.created === b.created && (a.attributes & 16) === (b.attributes & 16);
  const streams = (raw: bigint, directory: boolean, size: number) => {
    const io = Buffer.alloc(16), bytes = Buffer.alloc(1024); nt("NtQueryInformationFile", [raw, io, bytes, bytes.length, 22]); const count = io.readBigUInt64LE(8);
    if (io.readUInt32LE(0) !== 0) fail(); if (directory && count === 0n) return;
    if (count < 38n || count > BigInt(bytes.length) || bytes.readUInt32LE(0) !== 0 || bytes.readUInt32LE(4) !== 14 || bytes.toString("utf16le", 24, 38) !== "::$DATA" || bytes.readBigInt64LE(8) !== BigInt(size)) fail();
  };
  const sid = (bytes: Buffer) => {
    if (bytes.length < 8 || bytes[0] !== 1 || bytes[1] < 1 || bytes[1] > 15 || bytes.length !== 8 + bytes[1] * 4) return fail();
    let authority = 0n; for (let i = 2; i < 8; i++) authority = authority << 8n | BigInt(bytes[i]);
    return `S-1-${authority}-${Array.from({ length: bytes[1] }, (_, i) => bytes.readUInt32LE(8 + i * 4)).join("-")}`;
  };
  const aclView = (sd: bigint, length: number, raw: unknown) => {
    const address = pointer(raw); if (address % 4n || address < sd + 20n || address + 8n > sd + BigInt(length)) fail();
    const header = decode(address, 8), size = header.readUInt16LE(2), count = header.readUInt16LE(4);
    if (![2, 4].includes(header[0]) || header[1] || header.readUInt16LE(6) || size < 8 + count * 12 || address + BigInt(size) > sd + BigInt(length)) fail();
    return { raw: address, bytes: decode(address, size), count, end: address + BigInt(size) };
  };
  const security = (raw: bigint, owner: string, pkg: string, directory: boolean, granted: boolean, automatic: boolean, inherited = false, aclOwner = owner) => {
    const ownOut: unknown[] = [null], dacl: unknown[] = [null], sacl: unknown[] = [null], out: unknown[] = [null], frame = { ownOut, dacl, sacl, out }; pending.add(frame);
    active(); let status: unknown; try { status = fn.GetSecurityInfo(raw, 1, 0x15, ownOut, null, dacl, sacl, out); } catch { if (valid(out[0])) own(out[0], allocations); return fail(); }
    const sd = own(out[0], allocations); active(); if (status !== 0) fail();
    const length = invoke("GetSecurityDescriptorLength", [sd], v => typeof v === "number" && Number.isInteger(v) && v >= 20 && v <= 65536) as number;
    const ownerPtr = pointer(ownOut[0]); if (ownerPtr % 4n || ownerPtr < sd + 20n || ownerPtr + 8n > sd + BigInt(length)) fail(); const header = decode(ownerPtr, 8), sidLength = 8 + header[1] * 4;
    if (sidLength > 68 || ownerPtr + BigInt(sidLength) > sd + BigInt(length)) fail(); const ownerBytes = decode(ownerPtr, sidLength); if (sid(ownerBytes) !== owner) fail();
    const controls = [-1], revision = [0]; bool("GetSecurityDescriptorControl", [sd, controls, revision]);
    if (!Number.isInteger(controls[0]) || controls[0] < 0 || controls[0] > 65535 || !(controls[0] & 4) || !(controls[0] & 16) || !inherited && !(controls[0] & 0x1000) || automatic && (controls[0] & 0xc00) !== 0xc00) fail();
    const d = aclView(sd, length, dacl[0]), s = aclView(sd, length, sacl[0]); if (!(d.end <= s.raw || s.end <= d.raw)) fail();
    const flags = (directory ? 3 : 0) | (inherited ? 16 : 0), expected = new Map([[aclOwner, ALL], ["S-1-5-18", ALL], ...(granted ? [[pkg, MODIFY] as [string, number]] : [])]);
    const rows = (view: ReturnType<typeof aclView>, type: number) => { let offset = 8; const found = new Map<string, number>(); for (let index = 0; index < view.count; index++) {
      if (offset + 12 > view.bytes.length) fail(); const size = view.bytes.readUInt16LE(offset + 2); if (size < 12 || size > 76 || offset + size > view.bytes.length || view.bytes[offset] !== type || view.bytes[offset + 1] !== flags) fail();
      const who = sid(view.bytes.subarray(offset + 8, offset + size)); if (found.has(who)) fail(); found.set(who, view.bytes.readUInt32LE(offset + 4)); offset += size;
    } if (offset !== view.bytes.length) fail(); return found; };
    const observed = rows(d, 0), label = rows(s, 17); if (observed.size !== expected.size || [...expected].some(([who, mask]) => observed.get(who) !== mask) || label.size !== 1 || label.get("S-1-16-4096") !== 1) fail();
    const copy = { owner: Buffer.from(ownerBytes), dacl: Buffer.from(d.bytes), label: Buffer.from(s.bytes), control: controls[0] }; ownerBytes.fill(0); d.bytes.fill(0); s.bytes.fill(0); free(sd); pending.delete(frame); return copy;
  };
  const set = (raw: bigint, directory: boolean, owner: string, pkg: string, granted: boolean) => descriptor(`O:${owner}D:P(A;${directory ? "OICI" : ""};FA;;;${owner})(A;${directory ? "OICI" : ""};FA;;;SY)${granted ? `(A;${directory ? "OICI" : ""};0x1301bf;;;${pkg})` : ""}S:(ML;${directory ? "OICI" : ""};NW;;;LW)`, sd => {
    const length = invoke("GetSecurityDescriptorLength", [sd], v => typeof v === "number" && Number.isInteger(v) && v >= 20 && v <= 65536) as number;
    const view = (name: string) => { const present = [-1], raw: unknown[] = [null], defaulted = [-1]; bool(name, [sd, present, raw, defaulted]); if (present[0] !== 1 || defaulted[0] !== 0) fail(); return aclView(sd, length, raw[0]); };
    const d = view("GetSecurityDescriptorDacl"), s = view("GetSecurityDescriptorSacl"); if (!(d.end <= s.raw || s.end <= d.raw) || d.count !== (granted ? 3 : 2) || s.count !== 1) fail();
    invoke("SetSecurityInfo", [raw, 1, 0x80000014, null, null, d.raw, s.raw], v => v === 0); d.bytes.fill(0); s.bytes.fill(0);
  });
  const data = (raw: bigint, bytes: Buffer, write: boolean) => { const io = Buffer.alloc(16), offset = Buffer.alloc(8); nt(write ? "NtWriteFile" : "NtReadFile", [raw, null, null, null, io, bytes, bytes.length, offset, null]); if (io.readUInt32LE(0) !== 0 || io.readBigUInt64LE(8) !== BigInt(bytes.length)) fail(); if (write) bool("FlushFileBuffers", [raw]); };
  // The existing ordinary-host binder retains its own process/token ledger. An alias into this fixture is terminal before a later query/close.
  const host = bindWindowsCommandCreatorOwnerHostNative(native, name => { const dll = load(name); return { func(prototype) {
    const original = dll.func(prototype) as Fn; if (typeof original !== "function") fail(); const operation = /\b(\w+)\s*\(/.exec(prototype)![1]; return (...args: unknown[]) => {
      if (operation !== "TerminateJobObject" && operation !== "TerminateProcess") active();
      if (operation === "CloseHandle" && (handles.has(args[0] as bigint) || allocations.has(args[0] as bigint) || borrowed.has(args[0] as bigint))) fail();
      const result = original(...args);
      const owned = (value: unknown) => handles.has(value as bigint) || allocations.has(value as bigint) || borrowed.has(value as bigint);
      if (operation === "CreateJobObjectW") { if (owned(result)) fail(); if (valid(result)) foreign.add(result); }
      if (operation === "CreateProcessW") {
        const information = args[9]; if (!Buffer.isBuffer(information) || information.length !== 24) return fail();
        const process = information.readBigUInt64LE(0), thread = information.readBigUInt64LE(8);
        // No aliased PI field can reach the host binder's query or partial-created termination path.
        if (owned(process) || owned(thread)) fail();
        if (result === 1 || result === true) { if (valid(process)) foreign.add(process); if (valid(thread)) foreign.add(thread); }
      }
      if (operation === "OpenProcessToken") { const out = args[2] as unknown[]; if (owned(out[0])) fail(); }
      if (operation !== "TerminateJobObject" && operation !== "TerminateProcess") active();
      return result;
    };
  } }; }, { retained: fence.retained });
  return { host, guard,
    create(parent, profile, binding, current) {
      active(); if (selected || typeof current !== "function" || !/^[A-Za-z]:\\/.test(parent) || path.normalize(parent) !== parent || /[\p{Cc}\p{Cf}]/u.test(parent)) fail();
      const key = Object.freeze({}), issued = { profile, key, binding }; pending.add(issued);
      let pkg: string; try { requireWindowsCommandRootOnlyPreparing(binding); pkg = bindWindowsCommandCreatorTree(profile, key); const sid = pointer(windowsCommandCreatorProfile(profile).sid); if (handles.has(sid) || allocations.has(sid) || foreign.has(sid) || borrowed.has(sid)) fail(); borrowed.add(sid); } catch { return fail(); }
      selected = { profile, key, binding, current, staging: true }; pending.delete(issued); active();
      const tokenOut: unknown[] = [null]; pending.add(tokenOut); let result: unknown;
      const process = invoke("GetCurrentProcess", [], value => value === -1n || value === 0xffffffffffffffffn);
      try { result = fn.OpenProcessToken(process, 8, tokenOut); } catch { if (valid(tokenOut[0])) own(tokenOut[0], handles); return fail(); }
      const token = own(tokenOut[0], handles); active(); if (result !== 1 && result !== true) fail();
      const tokenSid = (kind: 1 | 4) => { const bytes = Buffer.alloc(4096), count = [0]; bool("GetTokenInformation", [token, kind, bytes, bytes.length, count]); let value: string; try { value = windowsCommandCreatorTokenSid(bytes, count[0], native.address(bytes), kind); } catch { return fail(); } bytes.fill(0); return value; };
      const owner = tokenSid(1), creatorOwner = tokenSid(4); if (!/^S-1-5-(?:\d+-)*\d+$/.test(owner) || owner === "S-1-5-18") fail(); close(token); pending.delete(tokenOut);
      const drive = parent.slice(0, 3), filesystem = Buffer.alloc(64); invoke("GetDriveTypeW", [drive], v => v === 3); bool("GetVolumeInformationW", [drive, null, 0, null, null, null, filesystem, 32]); if (filesystem.toString("utf16le").split("\0")[0] !== "NTFS") fail();
      const ancestors: { raw: bigint; info: Info }[] = [];
      let parentRaw = acquire(null, `\\??\\${drive}`, true, 0x1200a0, 3); ancestors.push({ raw: parentRaw, info: info(parentRaw) });
      const parts = parent.slice(3).split("\\").filter(Boolean); if (parts.length > 32 || parts.some(p => p === "." || p === ".." || /[:\p{Cc}\p{Cf}]/u.test(p) || /[. ]$/.test(p))) fail();
      let relativeParent = parentRaw, parentName = "";
      for (const part of parts) { relativeParent = parentRaw; parentName = part; parentRaw = acquire(parentRaw, part, true, 0x1200a0, 3); ancestors.push({ raw: parentRaw, info: info(parentRaw) }); }
      if (!parentName) fail(); const creatorParent = acquire(relativeParent, parentName, true, 0x1200a6, 3);
      const rootName = `ember-open-target-${randomUUID()}`, directory = path.join(parent, rootName);
      const rootCreator = descriptor(`O:${owner}D:P(A;OICI;FA;;;${owner})(A;OICI;FA;;;SY)S:(ML;OICI;NW;;;LW)`, sd => acquire(creatorParent, rootName, true, ALL, 7, true, sd));
      const root = acquire(parentRaw, rootName, true, META | 0x20, 7), rootBefore = info(root); close(creatorParent);
      const createTarget = (name: string) => descriptor(`O:${owner}D:P(A;;FA;;;${owner})(A;;FA;;;SY)S:(ML;;NW;;;LW)`, sd => { const raw = acquire(root, name, false, ALL, 7, true, sd); data(raw, OLD, true); return raw; });
      const a = createTarget("a-old.txt"), b = createTarget("b-old.txt"), originalA = info(a), originalB = info(b);
      streams(root, true, rootBefore.size); streams(a, false, OLD.length); streams(b, false, OLD.length);
      for (const [raw, directory] of [[root, true], [a, false], [b, false]] as const) { const privateState = security(raw, owner, pkg, directory, false, false); privateState.owner.fill(0); privateState.dacl.fill(0); privateState.label.fill(0); }
      set(root, true, owner, pkg, true); set(a, false, owner, pkg, true); set(b, false, owner, pkg, true);
      const rootSecurity = security(root, owner, pkg, true, true, true); rootSecurity.owner.fill(0); rootSecurity.dacl.fill(0); rootSecurity.label.fill(0);
      const sa = security(a, owner, pkg, false, true, true), sb = security(b, owner, pkg, false, true, true), ai = info(a), bi = info(b);
      streams(root, true, info(root).size); streams(a, false, OLD.length); streams(b, false, OLD.length);
      if (!same(originalA, ai) || !same(originalB, bi) || !ai.attributes || ai.attributes & ~0xa0 || bi.attributes & ~0xa0 || !(rootBefore.attributes & 16) || !sa.owner.equals(sb.owner) || !sa.dacl.equals(sb.dacl) || !sa.label.equals(sb.label) || sa.control !== sb.control || ai.attributes !== bi.attributes || ai.size !== OLD.length || bi.size !== OLD.length || ai.id === bi.id || ai.volume !== bi.volume || ai.volume !== rootBefore.volume) fail();
      const bytesA = Buffer.alloc(OLD.length), bytesB = Buffer.alloc(OLD.length); data(a, bytesA, false); data(b, bytesB, false); if (!bytesA.equals(OLD) || !bytesB.equals(OLD)) fail(); bytesA.fill(0); bytesB.fill(0);
      for (const s of [sa, sb]) { s.owner.fill(0); s.dacl.fill(0); s.label.fill(0); }
      close(a); close(b); close(rootCreator);
      // A never enters this retained-metadata phase. These are exactly the production target pin parameters.
      const targetB = acquire(root, "b-old.txt", false, META, 7); if (!same(bi, info(targetB))) fail();
      for (const p of ancestors) if (!same(p.info, info(p.raw))) fail(); if (!same(rootBefore, info(root))) fail(); selected.staging = false;
      let stopAccepted = false;
      const stopped = (receipt: unknown) => { active(); try { if (requireWindowsCommandRootOnlyCompletion(receipt, binding).rootPresent !== 1) fail(); } catch { return fail(); }
        // Stop closed these exact process/job owners. Only this branded binding permits legitimate handle-number reuse.
        if (!stopAccepted) { host.retire(); foreign.clear(); stopAccepted = true; } active(); };
      let read = false, finished = false;
      const named = (name: string, expectedBytes: Buffer, expectedOwner: string, inherited: boolean) => {
        const raw = acquire(root, name, false, 0x120089, 1), details = info(raw); if (details.attributes & 16 || details.size !== expectedBytes.length || details.volume !== rootBefore.volume) fail(); streams(raw, false, details.size);
        const secure = security(raw, expectedOwner, pkg, false, true, false, inherited, owner); secure.owner.fill(0); secure.dacl.fill(0); secure.label.fill(0);
        const bytes = Buffer.alloc(expectedBytes.length); data(raw, bytes, false); if (!bytes.equals(expectedBytes)) fail(); bytes.fill(0); close(raw); return details;
      };
      return Object.freeze({ directory, report: path.join(directory, "report.bin"),
        readReport(receipt: unknown) { stopped(receipt); if (read || finished) fail(); read = true; const raw = acquire(root, "report.bin", false, 0x120089, 1), details = info(raw); if (details.attributes & 16 || details.size !== 64) fail(); streams(raw, false, details.size);
          const secure = security(raw, creatorOwner, pkg, false, true, false, true, owner); secure.owner.fill(0); secure.dacl.fill(0); secure.label.fill(0);
          const report = Buffer.alloc(64); data(raw, report, false); if (!same(details, info(raw))) fail(); close(raw); return report; },
        verifyAndClose(receipt: unknown, bSuccess: 0 | 1) {
          stopped(receipt); if (!read || finished || bSuccess !== 0 && bSuccess !== 1) fail(); finished = true;
          const aNow = named("a-old.txt", NEW, creatorOwner, true), bNow = named("b-old.txt", bSuccess ? NEW : OLD, bSuccess ? creatorOwner : owner, !!bSuccess);
          if (aNow.id === ai.id || (bSuccess ? bNow.id === bi.id : bNow.id !== bi.id)) fail();
          if (!same(bi, info(targetB, !!bSuccess))) fail(); close(targetB);
          const expected = ["a-old.txt", "b-old.txt", "report.bin", ...(!bSuccess ? ["b-temp.txt"] : [])].sort();
          if (!bSuccess) named("b-temp.txt", NEW, creatorOwner, true);
          const listing = acquire(parentRaw, rootName, true, 0x1200a9, 7), found: string[] = [];
          for (let index = 0; index < 16; index++) { const io = Buffer.alloc(16), buffer = Buffer.alloc(1024), status = invoke("NtQueryDirectoryFile", [listing, null, null, null, io, buffer, buffer.length, 37, 1, null, index === 0 ? 1 : 0], v => v === 0 || v === 0x80000006 || v === -2147483642); if (status !== 0) break;
            const count = io.readBigUInt64LE(8); if (io.readUInt32LE(0) || count < 1n || count > BigInt(buffer.length)) fail(); let rows; try { rows = decodeWindowsCodingDirectoryBatch(buffer, Number(count), 1); } catch { return fail(); }
            for (const row of rows) found.push(row.name); if (index === 15) fail(); }
          if (found.sort().join("|") !== expected.join("|")) fail(); close(listing);
          for (const name of expected) { const raw = acquire(root, name, false, 0x1300a0, 7), io = Buffer.alloc(16), disposition = Buffer.alloc(4); io.writeUInt32LE(0xffffffff); disposition.writeUInt32LE(1); nt("NtSetInformationFile", [raw, io, disposition, disposition.length, 64]); if (io.readUInt32LE(0) !== 0) fail(); close(raw); }
          const deletion = acquire(parentRaw, rootName, true, 0x1300a0, 7), io = Buffer.alloc(16), disposition = Buffer.alloc(4); io.writeUInt32LE(0xffffffff); disposition.writeUInt32LE(1); nt("NtSetInformationFile", [deletion, io, disposition, disposition.length, 64]); if (io.readUInt32LE(0) !== 0) fail(); close(deletion); close(root);
          for (const p of ancestors.slice().reverse()) { if (!same(p.info, info(p.raw))) fail(); close(p.raw); }
          if (handles.size || allocations.size || pending.size) fail(); releaseWindowsCommandCreatorTree(profile, key); borrowed.clear(); selected = undefined; closed = true;
          return Object.freeze({ equalInitialState: 1, aNeverPinned: 1, bHeldThroughStop: 1, privateCleanup: 1 });
        },
      });
    },
  };
}

export function loadWindowsOpenTargetReplaceNative(): WindowsOpenTargetReplaceNative {
  if (HOST_PLATFORM !== "win32" || HOST_ARCH !== "x64") throw new WindowsOpenTargetReplaceCleanupError();
  const require = createRequire(typeof __filename === "string" ? __filename : import.meta.url), koffi = require("koffi") as typeof Koffi;
  return bindWindowsOpenTargetReplaceNative(koffi, name => koffi.load(name), processFence);
}
