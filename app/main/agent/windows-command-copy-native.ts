/** Host-only fresh command-copy ownership. No existing project receives a package grant.
 * Raw Win32 handles never leave this module; the coordinator supplies a branded closed-job Stop before revoke.
 */
import path from "node:path/win32";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type * as Koffi from "koffi";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import { ScopedCodingFileError } from "./coding-platform";
import type { CodingExportEntry } from "./coding-result-export";
import { decodeWindowsCodingDirectoryBatch, type WindowsCodingInfo, type WindowsCodingKind } from "./windows-coding-native";
import { windowsCodingRelative, windowsCodingFold, windowsCodingWithin } from "./windows-coding-policy";

export interface FreshWindowsCommandTreeInput { parent: string; protectedPaths: readonly string[]; entries: readonly CodingExportEntry[]; current(): boolean }
export interface FreshWindowsCommandTree {
  readonly directory: string;
  assertPrivate(): Promise<void>;
  grant(packageSid: string, check?: () => void): Promise<void>;
  /** Host coordinator must first prove its exact root-only job closed; cancellation does not prevent cleanup. */
  revoke(packageSid: string): Promise<void>;
  /** Detached host-only bytes, never model/publication authority. */
  snapshot(check?: () => void): Promise<readonly CodingExportEntry[]>;
  close(): Promise<void>;
}
export class WindowsCommandCopyCleanupError extends Error {
  readonly code = "windows-command-copy-cleanup-unverified";
  constructor() { super("Fresh Windows command-copy ownership is unverified; retain every native owner."); this.name = "WindowsCommandCopyCleanupError"; }
}
type FailureStage = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
type FailureOperation = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21 | 22 | 23 | 24 | 25 | 26 | 27;
type FailurePredicate = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
type FailureDomain = 0 | 1 | 2;
export interface WindowsCommandCopyNativeFailure {
  readonly stage: FailureStage; readonly operation: FailureOperation; readonly predicate: FailurePredicate; readonly domain: FailureDomain; readonly code: number;
}
const nativeFailures = new WeakMap<object, WindowsCommandCopyNativeFailure>();
/** Status-only first failure. Foreign errors and serialized copies carry no authority. */
export function windowsCommandCopyNativeFailure(error: unknown): WindowsCommandCopyNativeFailure | undefined {
  return typeof error === "object" && error !== null ? nativeFailures.get(error) : undefined;
}
// Closed diagnostic enums. Operations follow WINDOWS_COMMAND_COPY_FUNCTIONS below; zero means no known prototype.
// Stages: owner-token, pin, create, stage, assert, grant, revoke, snapshot, close (1..9).
// Predicates: call throw, status, ABI/decode, handle/rights, metadata/path, stream, ACL/owner/label, invariant (1..8).
const OP: Readonly<Record<string, FailureOperation>> = Object.freeze({ NtCreateFile: 1, NtQueryDirectoryFile: 2, NtQueryInformationFile: 3,
  NtReadFile: 4, NtWriteFile: 5, NtSetInformationFile: 6, NtSetSecurityObject: 7, NtQueryObject: 8, CloseHandle: 9,
  LocalFree: 10, GetCurrentProcess: 11, GetFileType: 12, GetHandleInformation: 13, GetFileInformationByHandle: 14,
  GetFileInformationByHandleEx: 15, GetFinalPathNameByHandleW: 16, GetDriveTypeW: 17, GetVolumeInformationW: 18,
  FlushFileBuffers: 19, OpenProcessToken: 20, GetTokenInformation: 21, ConvertSidToStringSidW: 22,
  ConvertStringSecurityDescriptorToSecurityDescriptorW: 23, GetSecurityInfo: 24, GetSecurityDescriptorControl: 25,
  GetAclInformation: 26, GetAce: 27 });
const NT_STATUS = new Set(["NtCreateFile", "NtQueryDirectoryFile", "NtQueryInformationFile", "NtReadFile", "NtWriteFile", "NtSetInformationFile", "NtSetSecurityObject", "NtQueryObject"]);
const BOOL_STATUS = new Set(["CloseHandle", "GetHandleInformation", "GetFileInformationByHandle", "GetFileInformationByHandleEx", "GetVolumeInformationW", "FlushFileBuffers", "OpenProcessToken", "GetTokenInformation", "ConvertSidToStringSidW", "ConvertStringSecurityDescriptorToSecurityDescriptorW", "GetSecurityDescriptorControl", "GetAclInformation", "GetAce"]);
function returnedStatus(name: string, value: unknown): { domain: FailureDomain; code: number } {
  if (typeof value !== "number" || !Number.isInteger(value) || value < -0x80000000 || value > 0xffffffff) return { domain: 0, code: 0 };
  const domain = NT_STATUS.has(name) ? 1 : BOOL_STATUS.has(name) ? 2 : 0;
  return { domain, code: domain ? value >>> 0 : 0 };
}
export interface WindowsCommandCopyNativeFence { failure?: WindowsCommandCopyCleanupError; retained: unknown[] }
const processFence: WindowsCommandCopyNativeFence = { retained: [] };
const liveOwners = new WeakMap<WindowsCommandCopyNativeFence, Set<object>>();
const retainedOwners = new WeakSet<object>();
const MAX_ENTRIES = 4000, MAX_DEPTH = 32, MAX_FILE = 8 * 1024 * 1024, MAX_BYTES = 100 * 1024 * 1024, CHUNK = 64 * 1024;
const META = 0x1e0080, TRAVERSE = 0x20, SYNC = 0x100000, READ = 0x120089, LIST = 0x1200a9, DELETE = 0x10000;
const ALL = 0x1f01ff, MODIFY = 0x1301bf, LABEL = 0x10, PROTECTED_DACL = 0x80000000;
const SPECIAL = 0x5640 | 0x40000 | 0x400000;
type Fn = (...args: unknown[]) => unknown;
type Node = { raw: bigint; kind: WindowsCodingKind; relative: string; parent?: Node; name: string; identity: WindowsCodingInfo; acl: "private" | "granted" | "inherited"; executable: boolean };
const boundary = () => new ScopedCodingFileError("boundary");
const valid = (value: unknown): value is bigint => typeof value === "bigint" && value > 0n && value < 0x8000000000000000n;
const sidValid = (sid: unknown, packageOnly = false): sid is string => typeof sid === "string" && sid.length <= 184 &&
  (packageOnly ? /^S-1-15-2-(?:\d+-)*\d+$/.test(sid) && sid !== "S-1-15-2-1" : /^S-1-5-(?:\d+-)*\d+$/.test(sid)) &&
  sid.split("-").slice(2).length <= 16 && sid.split("-").slice(2).every(n => Number.isSafeInteger(Number(n)) && Number(n) <= 0xffffffff && String(Number(n)) === n);
function absolute(value: string): string {
  if (typeof value !== "string" || value.length > 4096 || !/^[A-Za-z]:\\/.test(value) || path.normalize(value) !== value || value.includes("/") || /[\p{Cc}\p{Cf}]/u.test(value)) throw boundary();
  if (value.slice(3).split("\\").filter(Boolean).length > 64) throw boundary();
  for (const part of value.slice(3).split("\\").filter(Boolean)) if (windowsCodingRelative(part, false) !== part || part.includes("/")) throw boundary();
  return value;
}
function capture(input: FreshWindowsCommandTreeInput) {
  if (!input || typeof input.current !== "function" || !Array.isArray(input.entries) || input.entries.length > MAX_ENTRIES || !Array.isArray(input.protectedPaths) ||
      input.protectedPaths.length < 1 || input.protectedPaths.length > 64) throw boundary();
  const parent = absolute(input.parent), protectedPaths = input.protectedPaths.map(absolute), seen = new Set<string>(), kinds = new Map<string, WindowsCodingKind>();
  let total = 0;
  const entries = input.entries.map(raw => {
    if (!raw || typeof raw !== "object") throw boundary();
    const relative = windowsCodingRelative(raw.path, false), folded = windowsCodingFold(relative);
    if (relative !== raw.path || relative.split("/").length > MAX_DEPTH || seen.has(folded)) throw boundary();
    seen.add(folded);
    const keys = Object.keys(raw).sort().join(",");
    if (raw.kind === "directory" && keys === "kind,path") { kinds.set(folded, "directory"); return { path: relative, kind: "directory" as const }; }
    if (raw.kind !== "file" || keys !== "bytes,executable,kind,path" || !Buffer.isBuffer(raw.bytes) || raw.executable !== false || raw.bytes.length > MAX_FILE || (total += raw.bytes.length) > MAX_BYTES) throw boundary();
    kinds.set(folded, "file"); return { path: relative, kind: "file" as const, bytes: Buffer.from(raw.bytes), executable: raw.executable };
  });
  for (const entry of entries) { const parts = entry.path.split("/"); for (let i = 1; i < parts.length; i++) if (kinds.get(windowsCodingFold(parts.slice(0, i).join("/"))) !== "directory") throw boundary(); }
  entries.sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path, "en"));
  return { parent, protectedPaths, entries, current: input.current.bind(input) };
}
export const WINDOWS_COMMAND_COPY_FUNCTIONS = {
  ntdll: [
    "int32_t __stdcall NtCreateFile(_Out_ void **file, uint32_t access, void *attributes, void *io, void *allocation, uint32_t fileAttributes, uint32_t share, uint32_t disposition, uint32_t options, void *ea, uint32_t eaLength)",
    "int32_t __stdcall NtQueryDirectoryFile(void *file, void *event, void *apc, void *context, void *io, void *information, uint32_t length, int kind, uint8_t single, void *name, uint8_t restart)",
    "int32_t __stdcall NtQueryInformationFile(void *file, void *io, void *information, uint32_t length, int kind)",
    "int32_t __stdcall NtReadFile(void *file, void *event, void *apc, void *context, void *io, void *bytes, uint32_t length, void *offset, void *key)",
    "int32_t __stdcall NtWriteFile(void *file, void *event, void *apc, void *context, void *io, void *bytes, uint32_t length, void *offset, void *key)",
    "int32_t __stdcall NtSetInformationFile(void *file, void *io, void *information, uint32_t length, int kind)",
    "int32_t __stdcall NtSetSecurityObject(void *file, uint32_t information, void *descriptor)",
    "int32_t __stdcall NtQueryObject(void *file, uint32_t kind, void *information, uint32_t length, _Out_ uint32_t *returned)",
  ],
  kernel32: [
    "int __stdcall CloseHandle(void *file)", "void * __stdcall LocalFree(void *memory)", "void * __stdcall GetCurrentProcess()",
    "uint32_t __stdcall GetFileType(void *file)", "int __stdcall GetHandleInformation(void *file, _Out_ uint32_t *flags)",
    "int __stdcall GetFileInformationByHandle(void *file, void *information)", "int __stdcall GetFileInformationByHandleEx(void *file, int kind, void *information, uint32_t length)",
    "uint32_t __stdcall GetFinalPathNameByHandleW(void *file, void *name, uint32_t length, uint32_t flags)",
    "uint32_t __stdcall GetDriveTypeW(const char16_t *root)", "int __stdcall GetVolumeInformationW(const char16_t *root, void *name, uint32_t nameLength, void *serial, void *componentLength, void *flags, void *filesystem, uint32_t filesystemLength)",
    "int __stdcall FlushFileBuffers(void *file)",
  ],
  advapi32: [
    "int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)", "int __stdcall GetTokenInformation(void *token, int kind, void *information, uint32_t length, _Out_ uint32_t *returned)",
    "int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)",
    "int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *text, uint32_t revision, _Out_ void **descriptor, void *length)",
    "uint32_t __stdcall GetSecurityInfo(void *file, int kind, uint32_t information, _Out_ void **owner, void *group, _Out_ void **dacl, _Out_ void **sacl, _Out_ void **descriptor)",
    "int __stdcall GetSecurityDescriptorControl(void *descriptor, _Out_ uint16_t *control, _Out_ uint32_t *revision)", "int __stdcall GetAclInformation(void *acl, void *information, uint32_t length, int kind)",
    "int __stdcall GetAce(void *acl, uint32_t index, _Out_ void **ace)",
  ],
} as const;

/** Injectable FFI binding for contract tests; handles and allocator pointers remain in separate private ledgers. */
export function bindWindowsCommandCopyNative(native: Pick<typeof Koffi, "sizeof" | "address" | "decode">, load: (name: string) => { func(prototype: string): unknown }, fence: WindowsCommandCopyNativeFence = processFence) {
  if (fence.failure) throw fence.failure;
  if (native.sizeof("void *") !== 8) throw new ScopedCodingFileError("unavailable");
  const fn: Record<string, Fn> = {};
  for (const [library, prototypes] of Object.entries(WINDOWS_COMMAND_COPY_FUNCTIONS)) { const dll = load(`${library}.dll`); for (const prototype of prototypes) fn[/\b(\w+)\s*\(/.exec(prototype)![1]] = dll.func(prototype) as Fn; }
  return { async createFreshWindowsCommandTree(input: FreshWindowsCommandTreeInput): Promise<FreshWindowsCommandTree> {
    if (fence.failure) throw fence.failure;
    // This synchronous capture precedes the first await, including all detached source buffers.
    let selected: ReturnType<typeof capture>;
    try { selected = capture(input); } catch (error) { throw error instanceof ScopedCodingFileError ? error : boundary(); }
    const serials = new Map<bigint, number>();
    const handles = new Set<bigint>(), allocations = new Set<bigint>(), pending = new Set<unknown>(), nodes = new Set<Node>();
    const ownerRecord = { handles, allocations, pending, nodes, selected, serials };
    const peers = liveOwners.get(fence) ?? new Set<object>(); liveOwners.set(fence, peers); peers.add(ownerRecord);
    let rollbackKnown: (() => Promise<void>) | undefined;
    let terminal: WindowsCommandCopyCleanupError | undefined, closed = false, busy = false, retired = false, packageSid: string | undefined;
    let phase: "private" | "granting" | "granted" | "revoking" = "private", ticks = 0;
    let stage: FailureStage = 1;
    const poison = (predicate: FailurePredicate = 8, operation: FailureOperation = 0, status: { domain: FailureDomain; code: number } = { domain: 0, code: 0 }): never => {
      const first = !terminal && !fence.failure;
      terminal ??= fence.failure ?? new WindowsCommandCopyCleanupError(); fence.failure ??= terminal;
      if (first) nativeFailures.set(terminal, Object.freeze({ stage, operation, predicate, domain: status.domain, code: status.code }));
      for (const owner of peers) if (!retainedOwners.has(owner)) { fence.retained.push(owner); retainedOwners.add(owner); }
      throw terminal;
    };
    const usable = () => { if (terminal || fence.failure) poison(); if (closed) throw boundary(); };
    const active = () => {
      usable(); if (retired) throw new ScopedCodingFileError("cancelled");
      let current: unknown;
      try { current = selected.current(); }
      catch (error) { usable(); if (error instanceof WindowsCommandCopyCleanupError) return poison(); retired = true; throw new ScopedCodingFileError("cancelled"); }
      usable(); if (current !== true) { retired = true; throw new ScopedCodingFileError("cancelled"); }
    };
    const invoke = (name: string, args: unknown[], accepted: (value: unknown) => boolean): unknown => {
      usable(); const call = { name, args }; pending.add(call); let value: unknown;
      try { value = fn[name](...args); } catch { return poison(1, OP[name]); }
      if (!accepted(value)) return poison(2, OP[name], returnedStatus(name, value)); pending.delete(call); return value;
    };
    const bool = (name: string, args: unknown[]) => invoke(name, args, value => value === 1 || value === true);
    const nt = (name: string, args: unknown[]) => invoke(name, args, value => value === 0);
    const pointer = (value: unknown): bigint => { if (!valid(value)) poison(4); return value as bigint; };
    const closeRaw = (raw: bigint) => { usable(); if (!handles.has(raw)) poison(4, OP.CloseHandle); bool("CloseHandle", [raw]); handles.delete(raw); serials.delete(raw); };
    const free = (raw: bigint) => { usable(); if (!allocations.has(raw)) poison(4, OP.LocalFree); invoke("LocalFree", [raw], value => value === null || value === 0n); allocations.delete(raw); };
    const allocated = (name: string, args: unknown[], out: unknown[]): bigint => {
      pending.add(out); let result: unknown;
      try { result = fn[name](...args); } catch { if (valid(out[0])) allocations.add(out[0]); return poison(1, OP[name]); }
      if (valid(out[0])) allocations.add(out[0]);
      if (result !== 1 && result !== true) return poison(2, OP[name], returnedStatus(name, result));
      const raw = pointer(out[0]); pending.delete(out); return raw;
    };
    const textSid = (raw: bigint): string => {
      const out: unknown[] = [null], allocatedText = allocated("ConvertSidToStringSidW", [raw, out], out);
      let text: unknown; try { text = native.decode.string16(allocatedText); } catch { return poison(3, OP.ConvertSidToStringSidW); }
      if (typeof text !== "string" || text.length > 184 || !/^S-\d+(?:-\d+)+$/.test(text)) return poison(7, OP.ConvertSidToStringSidW);
      free(allocatedText); return text;
    };
    try {
    active();
    const tokenOut: unknown[] = [null]; pending.add(tokenOut); let tokenResult: unknown;
    try { tokenResult = fn.OpenProcessToken(fn.GetCurrentProcess(), 8, tokenOut); } catch { if (valid(tokenOut[0])) handles.add(tokenOut[0]); return poison(1); }
    if (valid(tokenOut[0])) handles.add(tokenOut[0]);
    if (tokenResult !== 1 && tokenResult !== true) return poison(2, OP.OpenProcessToken, returnedStatus("OpenProcessToken", tokenResult));
    const token = pointer(tokenOut[0]); pending.delete(tokenOut);
    const tokenInfo = Buffer.alloc(4096), tokenLength = [0]; bool("GetTokenInformation", [token, 1, tokenInfo, tokenInfo.length, tokenLength]);
    if (!Number.isInteger(tokenLength[0]) || tokenLength[0] < 16 || tokenLength[0] > tokenInfo.length) return poison(3, OP.GetTokenInformation);
    const owner = textSid(tokenInfo.readBigUInt64LE(0)); if (!sidValid(owner) || owner === "S-1-5-18") return poison(7, OP.GetTokenInformation);
    tokenInfo.fill(0); closeRaw(token);
    type Admission = boolean | (() => void);
    const checkAdmission = (admission: Admission) => { usable(); if (typeof admission === "function") { admission(); usable(); } else if (admission) active(); };
    let verifyRoot: () => void = () => {};
    const tick = async (admission: Admission) => { if (++ticks % 16 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); checkAdmission(admission); verifyRoot(); } };
    const guard = (check?: () => void, requireTask = false): (() => void) => () => {
      usable(); if (requireTask || check === undefined) active();
      if (check !== undefined) { let returned: unknown; try { returned = check(); } catch (error) { usable(); if (error instanceof WindowsCommandCopyCleanupError) return poison(); throw new ScopedCodingFileError("cancelled"); } usable(); if (returned !== undefined) throw new ScopedCodingFileError("cancelled"); }
    };
    const address = (bytes: Buffer) => { try { return pointer(native.address(bytes)); } catch { return poison(3); } };
    const acquire = (parent: bigint | null, name: string, kind: WindowsCodingKind | undefined, access: number, share: number, create = false, security: bigint | null = null): bigint => {
      if (handles.size >= 20000) return poison();
      const text = Buffer.from(name + "\0", "utf16le"), unicode = Buffer.alloc(16), attributes = Buffer.alloc(48), io = Buffer.alloc(16), output: unknown[] = [null];
      if (text.length > 65534) return poison(5, OP.NtCreateFile);
      unicode.writeUInt16LE(text.length - 2); unicode.writeUInt16LE(text.length, 2); unicode.writeBigUInt64LE(address(text), 8);
      attributes.writeUInt32LE(48); if (parent !== null) attributes.writeBigUInt64LE(parent, 8); attributes.writeBigUInt64LE(address(unicode), 16); attributes.writeUInt32LE(0x1040, 24); if (security !== null) attributes.writeBigUInt64LE(security, 32);
      const args = [output, access, attributes, io, null, create ? kind === "directory" ? 16 : 128 : 0, share, create ? 2 : 1, 0x200020 | (kind === "directory" ? 1 : kind === "file" ? 0x40 : 0), null, 0];
      pending.add(args); let status: unknown;
      try { status = fn.NtCreateFile(...args); } catch { if (valid(output[0])) handles.add(output[0]); return poison(1, OP.NtCreateFile); }
      if (valid(output[0])) { if (handles.has(output[0])) return poison(4, OP.NtCreateFile); handles.add(output[0]); }
      if (status !== 0 || io.readUInt32LE(0) !== 0 || io.readBigUInt64LE(8) !== BigInt(create ? 2 : 1)) return poison(status !== 0 ? 2 : 3, OP.NtCreateFile, status !== 0 ? returnedStatus("NtCreateFile", status) : { domain: 0, code: 0 }); const raw = pointer(output[0]); pending.delete(args); text.fill(0); unicode.fill(0);
      const flags = [0], basic = Buffer.alloc(56), returned = [0]; bool("GetHandleInformation", [raw, flags]); if (flags[0] !== 0) return poison(4, OP.GetHandleInformation);
      nt("NtQueryObject", [raw, 0, basic, basic.length, returned]); const rights = basic.readUInt32LE(4);
      if (returned[0] !== 56 || (rights & access) !== access || (rights & ~(access | 0x80 | SYNC)) !== 0) return poison(4, OP.NtQueryObject);
      return raw;
    };
    const info = (raw: bigint): WindowsCodingInfo => {
      if (!handles.has(raw) || invoke("GetFileType", [raw], value => value === 1) !== 1) return poison(4, OP.GetFileType);
      const bytes = Buffer.alloc(52), basic = Buffer.alloc(40); bool("GetFileInformationByHandle", [raw, bytes]); bool("GetFileInformationByHandleEx", [raw, 0, basic, basic.length]);
      const serial = bytes.readUInt32LE(28); if (serials.has(raw) && serials.get(raw) !== serial) return poison(5, OP.GetFileInformationByHandle); serials.set(raw, serial);
      const attributes = bytes.readUInt32LE(0), size = bytes.readUInt32LE(32) * 0x100000000 + bytes.readUInt32LE(36), links = bytes.readUInt32LE(40);
      if (attributes & SPECIAL || links !== 1 || !Number.isSafeInteger(size) || attributes !== basic.readUInt32LE(32) || bytes.readBigUInt64LE(4) !== basic.readBigUInt64LE(0) || bytes.readBigUInt64LE(20) !== basic.readBigUInt64LE(16)) return poison(5, OP.GetFileInformationByHandleEx);
      const output = Buffer.alloc(65536), length = invoke("GetFinalPathNameByHandleW", [raw, output, 32768, 1], value => typeof value === "number" && Number.isInteger(value) && value > 0 && value < 32768) as number;
      const finalPath = output.toString("utf16le", 0, length * 2), volume = /^(\\\\\?\\Volume\{[0-9a-f-]{36}\}\\)/i.exec(finalPath)?.[1];
      if (!volume || /[\p{Cc}\p{Cf}]/u.test(finalPath)) return poison(5, OP.GetFinalPathNameByHandleW);
      const id = ((BigInt(bytes.readUInt32LE(44)) << 32n) | BigInt(bytes.readUInt32LE(48))).toString(16).padStart(16, "0"); if (id === "0000000000000000") return poison(5, OP.GetFileInformationByHandle);
      return { id, volume: volume.toLowerCase(), finalPath, kind: attributes & 16 ? "directory" : "file", attributes, links, size, created: basic.readBigUInt64LE(0).toString(), written: basic.readBigUInt64LE(16).toString(), changed: basic.readBigUInt64LE(24).toString() };
    };
    const same = (a: WindowsCodingInfo, b: WindowsCodingInfo, data = false) => a.id === b.id && a.volume === b.volume && a.kind === b.kind && a.created === b.created && windowsCodingFold(a.finalPath) === windowsCodingFold(b.finalPath) && (!data || a.size === b.size && a.written === b.written && a.changed === b.changed && a.attributes === b.attributes);
    const metadata = (node: Node) => { const now = info(node.raw); if (!same(node.identity, now)) return poison(5); return now; };
    // NTFS stream enumeration has no data-read requirement; reject every named stream.
    // https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_stream_information
    const streams = (raw: bigint, kind: WindowsCodingKind, expectedSize: number) => {
      const io = Buffer.alloc(16), bytes = Buffer.alloc(1024); nt("NtQueryInformationFile", [raw, io, bytes, bytes.length, 22]); const count = io.readBigUInt64LE(8);
      if (io.readUInt32LE(0) !== 0) return poison(6, OP.NtQueryInformationFile);
      if (kind === "directory" && count === 0n) return;
      if (count < 38n || count > BigInt(bytes.length) || bytes.readUInt32LE(0) !== 0 || bytes.readUInt32LE(4) !== 14 || bytes.toString("utf16le", 24, 38) !== "::$DATA" || bytes.readBigInt64LE(8) !== BigInt(expectedSize)) return poison(6, OP.NtQueryInformationFile);
    };
    const security = (node: Node, expected: "private" | "granted" | "inherited", detached = false) => {
      if (!detached) metadata(node);
      const descriptor: unknown[] = [null], own: unknown[] = [null], dacl: unknown[] = [null], sacl: unknown[] = [null];
      pending.add(descriptor); let status: unknown;
      try { status = fn.GetSecurityInfo(node.raw, 1, 1 | 4 | LABEL, own, null, dacl, sacl, descriptor); } catch { if (valid(descriptor[0])) allocations.add(descriptor[0]); return poison(1, OP.GetSecurityInfo); }
      if (valid(descriptor[0])) allocations.add(descriptor[0]); if (status !== 0) return poison(2, OP.GetSecurityInfo);
      const sd = pointer(descriptor[0]); pending.delete(descriptor);
      if (textSid(pointer(own[0])) !== owner) return poison(7, OP.GetSecurityInfo);
      const controls = [0], revision = [0]; bool("GetSecurityDescriptorControl", [sd, controls, revision]);
      if (!(controls[0] & 4) || !(controls[0] & 16) || (expected !== "inherited" && !(controls[0] & 0x1000))) return poison(7, OP.GetSecurityDescriptorControl);
      const acl = pointer(dacl[0]), details = Buffer.alloc(12); bool("GetAclInformation", [acl, details, details.length, 2]);
      const expectedAces = [{ sid: owner, mask: ALL }, { sid: "S-1-5-18", mask: ALL }, ...(expected === "private" ? [] : [{ sid: packageSid!, mask: MODIFY }])];
      if (details.readUInt32LE(0) !== expectedAces.length) return poison(7, OP.GetAclInformation);
      const observed: string[] = [];
      for (let i = 0; i < expectedAces.length; i++) {
        const out: unknown[] = [null]; bool("GetAce", [acl, i, out]); const p = pointer(out[0]); let header: Buffer;
        try { header = Buffer.from(native.decode(p, "uint8_t", 8) as Uint8Array); } catch { return poison(3, OP.GetAce); }
        const flags = (node.kind === "directory" ? 3 : 0) | (expected === "inherited" ? 16 : 0);
        if (header.length !== 8 || header[0] !== 0 || header[1] !== flags || header.readUInt16LE(2) < 12 || header.readUInt16LE(2) > 76) return poison(7, OP.GetAce);
        observed.push(`${textSid(p + 8n)}:${header.readUInt32LE(4)}`);
      }
      if (observed.sort().join("|") !== expectedAces.map(ace => `${ace.sid}:${ace.mask}`).sort().join("|")) return poison(7, OP.GetAce);
      const labelAcl = pointer(sacl[0]), labelInfo = Buffer.alloc(12); bool("GetAclInformation", [labelAcl, labelInfo, labelInfo.length, 2]); if (labelInfo.readUInt32LE(0) !== 1) return poison(7, OP.GetAclInformation);
      const labelOut: unknown[] = [null]; bool("GetAce", [labelAcl, 0, labelOut]); const lp = pointer(labelOut[0]); let lh: Buffer;
      try { lh = Buffer.from(native.decode(lp, "uint8_t", 8) as Uint8Array); } catch { return poison(3, OP.GetAce); }
      const labelFlags = (node.kind === "directory" ? 3 : 0) | (expected === "inherited" ? 16 : 0);
      if (lh.length !== 8 || lh[0] !== 17 || lh[1] !== labelFlags || lh.readUInt32LE(4) !== 1 || lh.readUInt16LE(2) < 12 || lh.readUInt16LE(2) > 76 || textSid(lp + 8n) !== "S-1-16-4096") return poison(7, OP.GetAce);
      free(sd);
    };
    const withDescriptor = <T>(directory: boolean, granted: boolean, operation: (sd: bigint) => T): T => {
      const inherit = directory ? "OICI" : "", sddl = `O:${owner}D:P(A;${inherit};FA;;;${owner})(A;${inherit};FA;;;SY)${granted ? `(A;${inherit};0x1301bf;;;${packageSid})` : ""}S:(ML;${inherit};NW;;;LW)`;
      const output: unknown[] = [null], raw = allocated("ConvertStringSecurityDescriptorToSecurityDescriptorW", [sddl, 1, output, null], output);
      const result = operation(raw); free(raw); return result;
    };
    const pins: { raw: bigint; identity: WindowsCodingInfo }[] = [];
    const pin = async (name: string, directoryRequired = false) => {
      active();
      const drive = name.slice(0, 3); invoke("GetDriveTypeW", [drive], value => value === 3); const fs = Buffer.alloc(64); bool("GetVolumeInformationW", [drive, null, 0, null, null, null, fs, 32]); if (fs.toString("utf16le").split("\0")[0] !== "NTFS") return poison(5, OP.GetVolumeInformationW);
      let raw = acquire(null, `\\??\\${drive}`, "directory", 0x1200a0, 3), identity = info(raw); pins.push({ raw, identity });
      let relativeParent: bigint | null = null, componentName = `\\??\\${drive}`;
      const parts = name.slice(3).split("\\").filter(Boolean);
      for (let i = 0; i < parts.length; i++) { relativeParent = raw; componentName = parts[i]; const directory = i < parts.length - 1 || directoryRequired; raw = acquire(raw, componentName, directory ? "directory" : undefined, directory ? 0x1200a0 : 0x120080, 3); identity = info(raw); pins.push({ raw, identity }); await tick(true); active(); }
      return { raw, identity, relativeParent, componentName };
    };
    stage = 2;
    const parent = await pin(selected.parent, true); if (parent.identity.kind !== "directory") return poison(5);
    const protectedPins: Awaited<ReturnType<typeof pin>>[] = []; for (const name of selected.protectedPaths) protectedPins.push(await pin(name));
    for (const protectedPin of protectedPins) if (windowsCodingWithin(parent.identity.finalPath, protectedPin.identity.finalPath) || windowsCodingWithin(protectedPin.identity.finalPath, parent.identity.finalPath)) return poison(5);
    stage = 3;
    const rootName = `ember-command-${randomUUID()}`;
    const creatorParent = acquire(parent.relativeParent, parent.componentName, "directory", 0x1200a6, 3); if (!same(parent.identity, info(creatorParent))) return poison(5);
    const make = (parentNode: Node | undefined, name: string, kind: WindowsCodingKind, relative: string, executable = false): { node: Node; creator: bigint } => {
      const parentRaw = parentNode ? acquire(parentNode.parent?.raw ?? parent.raw, parentNode.name, "directory", LIST | 2 | 4, 7) : creatorParent;
      if (parentNode && !same(parentNode.identity, info(parentRaw))) return poison(5);
      const creator = withDescriptor(kind === "directory", false, sd => acquire(parentRaw, name, kind, kind === "directory" ? 0x1f01ff : ALL, 7, true, sd));
      const identity = info(creator); if (identity.kind !== kind || identity.volume !== parent.identity.volume) return poison(5);
      const raw = acquire(parentRaw, name, kind, META | (kind === "directory" ? TRAVERSE : 0), 7); if (!same(identity, info(raw))) return poison(5);
      const node: Node = { raw, kind, relative, parent: parentNode, name, identity, acl: "private", executable }; nodes.add(node); security(node, "private"); streams(raw, kind, identity.size); if (parentNode) closeRaw(parentRaw); return { node, creator };
    };
    active(); const createdRoot = make(undefined, rootName, "directory", ""); const root = createdRoot.node; closeRaw(createdRoot.creator); closeRaw(creatorParent);
    const rootIdentity = { ...root.identity }, directory = path.join(selected.parent, rootName);
    const checkRoot = () => { usable(); if (!same(rootIdentity, info(root.raw)) || !same(parent.identity, info(parent.raw))) return poison(5); };
    verifyRoot = checkRoot;
    const checkPins = async (admission: Admission) => { for (const p of pins) { if (!same(p.identity, info(p.raw))) return poison(5); await tick(admission); } checkRoot(); };
    const byPath = new Map<string, Node>([["", root]]);
    /** Only the same still-held fresh object can be treated as removed. A failed name query is never deletion proof.
     * https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_standard_info
     */
    const detached = (node: Node): boolean => {
      if (!handles.has(node.raw) || node === root) return poison(4);
      invoke("GetFileType", [node.raw], value => value === 1);
      const named = Buffer.alloc(52), standard = Buffer.alloc(24), basic = Buffer.alloc(40);
      bool("GetFileInformationByHandle", [node.raw, named]);
      bool("GetFileInformationByHandleEx", [node.raw, 1, standard, standard.length]);
      bool("GetFileInformationByHandleEx", [node.raw, 0, basic, basic.length]);
      const attributes = named.readUInt32LE(0), links = named.readUInt32LE(40), pendingDelete = standard[20];
      const id = ((BigInt(named.readUInt32LE(44)) << 32n) | BigInt(named.readUInt32LE(48))).toString(16).padStart(16, "0");
      if (id !== node.identity.id || named.readUInt32LE(28) !== serials.get(node.raw) || attributes & SPECIAL ||
          (attributes & 16 ? "directory" : "file") !== node.kind || links > 1 || links !== standard.readUInt32LE(16) || pendingDelete > 1 ||
          standard[21] !== (node.kind === "directory" ? 1 : 0) || named.readBigUInt64LE(4).toString() !== node.identity.created ||
          named.readBigUInt64LE(4) !== basic.readBigUInt64LE(0) || attributes !== basic.readUInt32LE(32)) return poison(5, OP.GetFileInformationByHandleEx);
      if (links === 1 && pendingDelete === 0) return false;
      // Zero links alone is deliberately insufficient until the supported NTFS kernel behavior has native evidence.
      if (pendingDelete !== 1) return poison(5, OP.GetFileInformationByHandleEx);
      if (links === 1) {
        const output = Buffer.alloc(65536), length = invoke("GetFinalPathNameByHandleW", [node.raw, output, 32768, 1], value => typeof value === "number" && Number.isInteger(value) && value > 0 && value < 32768) as number;
        const finalPath = output.toString("utf16le", 0, length * 2);
        if (!windowsCodingWithin(finalPath, root.identity.finalPath) || /[\p{Cc}\p{Cf}]/u.test(finalPath)) return poison(5, OP.GetFinalPathNameByHandleW);
      }
      security(node, node.acl, true); return true;
    };
    const releaseDeleted = async (admission: Admission) => {
      checkRoot(); for (const node of [...nodes]) if (node !== root) {
        if (detached(node)) { closeRaw(node.raw); nodes.delete(node); }
        await tick(admission);
      }
    };
    const walk = async (admission: Admission): Promise<Node[]> => {
      checkAdmission(admission); await checkPins(admission); checkRoot(); const known = new Map([...nodes].map(node => [node.identity.id, node])); const found: Node[] = [root], queue = [root], seen = new Set<string>([root.identity.id]), foldedPaths = new Set<string>(); let total = 0;
      for (let index = 0; index < queue.length; index++) {
        const parentNode = queue[index], before = metadata(parentNode);
        const listing = acquire(parentNode.parent?.raw ?? parent.raw, parentNode.name, "directory", LIST, 7); if (!same(before, info(listing))) return poison(5);
        let restart = 1, pages = 0;
        for (;;) {
          if (++pages > MAX_ENTRIES + 3) return poison();
          const buffer = Buffer.alloc(1024), io = Buffer.alloc(16); const status = invoke("NtQueryDirectoryFile", [listing, null, null, null, io, buffer, buffer.length, 37, 1, null, restart], value => value === 0 || value === -2147483642 || value === 0x80000006); restart = 0;
          if (status !== 0) break;
          if (io.readUInt32LE(0) !== 0) return poison(3, OP.NtQueryDirectoryFile);
          const count = io.readBigUInt64LE(8); if (count < 1n || count > BigInt(buffer.length)) return poison(3, OP.NtQueryDirectoryFile);
          let children; try { children = decodeWindowsCodingDirectoryBatch(buffer, Number(count), 1); } catch { return poison(3, OP.NtQueryDirectoryFile); }
          for (const child of children) {
            if (found.length > MAX_ENTRIES) return poison(); const relative = parentNode.relative ? `${parentNode.relative}/${child.name}` : child.name;
            if (relative.split("/").length > MAX_DEPTH || foldedPaths.has(windowsCodingFold(relative)) || seen.has(child.id)) return poison(5, OP.NtQueryDirectoryFile); foldedPaths.add(windowsCodingFold(relative)); seen.add(child.id);
            const kind = child.attributes & 16 ? "directory" : "file", raw = acquire(parentNode.raw, child.name, kind, META | (kind === "directory" ? TRAVERSE : 0), 7), identity = info(raw);
            if (identity.size > MAX_FILE && kind === "file" || identity.id !== child.id || identity.kind !== kind || identity.attributes !== child.attributes || identity.size !== child.size || identity.volume !== root.identity.volume || !windowsCodingWithin(identity.finalPath, root.identity.finalPath)) return poison(5);
            const previous = known.get(identity.id), node: Node = { raw, kind, relative, parent: parentNode, name: child.name, identity, acl: previous?.acl ?? "inherited", executable: previous?.executable ?? false };
            if (previous) { closeRaw(previous.raw); nodes.delete(previous); }
            nodes.add(node); streams(raw, kind, identity.size); if (kind === "file" && (total += identity.size) > MAX_BYTES) return poison(); found.push(node); if (kind === "directory") queue.push(node);
          }
          await tick(admission); checkRoot();
        }
        if (!same(before, metadata(parentNode), true)) return poison(5); closeRaw(listing);
      }
      return found;
    };
    const verify = (node: Node) => security(node, node.acl);
    const begin = (admission: boolean, nextStage: FailureStage) => { const previous = stage; stage = nextStage; try { if (admission) active(); else usable(); if (busy) throw boundary(); busy = true; } catch (error) { stage = previous; throw error; } };
    const end = () => { busy = false; };
    const setAcl = (node: Node, granted: boolean) => {
      // SetSecurityInfo propagates inheritance recursively; this held-handle native operation stays inside our bounded walk.
      // https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo#remarks
      // The native API accepts the converted self-relative descriptor; its documented user-mode name is NtSetSecurityObject.
      // https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-zwsetsecurityobject#remarks
      withDescriptor(node.kind === "directory", granted, sd => nt("NtSetSecurityObject", [node.raw, (4 | LABEL | PROTECTED_DACL) >>> 0, sd])); node.acl = granted ? "granted" : "private"; security(node, node.acl); node.identity = info(node.raw);
    };
    const retireOldPins = async (keep: readonly Node[], admission: Admission) => { const current = new Set(keep.map(node => node.raw)); for (const node of [...nodes]) { if (!current.has(node.raw)) { if (!detached(node)) return poison(5); closeRaw(node.raw); nodes.delete(node); } await tick(admission); } };
    const tree: FreshWindowsCommandTree = {
      directory,
      async assertPrivate() { begin(true, 5); try { if (phase !== "private") throw boundary(); for (const node of await walk(true)) { security(node, "private"); await tick(true); } } finally { end(); } },
      async grant(sid, check) {
        begin(true, 6); try {
          if (phase !== "private" || !sidValid(sid, true) || check !== undefined && typeof check !== "function") throw boundary(); const admit = guard(check, true); admit();
          const current = await walk(admit); for (const node of current) { security(node, "private"); await tick(admit); }
          await retireOldPins(current, admit);
          packageSid = sid; phase = "granting"; for (const node of current) { admit(); setAcl(node, true); await tick(admit); }
          const metadataPins = new Set([...nodes].map(node => node.raw)); for (const p of pins) metadataPins.add(p.raw);
          if (allocations.size || pending.size || [...handles].some(raw => !metadataPins.has(raw))) return poison();
          phase = "granted"; checkRoot();
        } finally { end(); }
      },
      async revoke(sid) {
        begin(false, 7); try {
          if (!sidValid(sid, true) || sid !== packageSid || phase === "private") throw boundary(); phase = "revoking";
          await releaseDeleted(false); const current = await walk(false); for (const node of current) { verify(node); await tick(false); }
          await retireOldPins(current, false);
          for (const node of current) { setAcl(node, false); await tick(false); } phase = "private"; packageSid = undefined; checkRoot();
        } finally { end(); }
      },
      async snapshot(check) {
        begin(false, 8); const result: CodingExportEntry[] = []; try {
          if (phase !== "private" || check !== undefined && typeof check !== "function") throw boundary(); const admit = guard(check); admit(); const current = await walk(admit); await retireOldPins(current, admit);
          for (const node of current) {
            admit(); security(node, "private"); if (!node.relative) continue;
            if (node.kind === "directory") result.push({ path: node.relative, kind: "directory" });
            else {
              const before = metadata(node), raw = acquire(node.parent!.raw, node.name, "file", READ, 1); if (!same(before, info(raw), true)) return poison(5);
              const bytes = Buffer.alloc(before.size); pending.add(bytes);
              try {
                for (let offset = 0; offset < bytes.length;) { const count = Math.min(CHUNK, bytes.length - offset), io = Buffer.alloc(16), position = Buffer.alloc(8); position.writeBigInt64LE(BigInt(offset)); nt("NtReadFile", [raw, null, null, null, io, bytes.subarray(offset, offset + count), count, position, null]); if (io.readBigUInt64LE(8) !== BigInt(count)) return poison(3, OP.NtReadFile); offset += count; await tick(admit); checkRoot(); }
                const io = Buffer.alloc(16), eof = Buffer.alloc(1), position = Buffer.alloc(8); position.writeBigInt64LE(BigInt(before.size)); invoke("NtReadFile", [raw, null, null, null, io, eof, 1, position, null], value => value === -1073741807 || value === 0xc0000011 || value === 0); if (io.readBigUInt64LE(8) !== 0n || !same(before, info(raw), true) || !same(before, metadata(node), true)) return poison(5, OP.NtReadFile);
                closeRaw(raw); pending.delete(bytes); result.push({ path: node.relative, kind: "file", bytes, executable: false });
              } catch (error) { bytes.fill(0); pending.delete(bytes); if (!terminal && !fence.failure && handles.has(raw)) closeRaw(raw); throw error; }
            }
            await tick(admit);
          }
          admit(); return Object.freeze(result.map(entry => Object.freeze(entry)));
        } catch (error) { for (const entry of result) if (entry.kind === "file") entry.bytes.fill(0); throw error; } finally { end(); }
      },
      async close() {
        if (closed) return;
        begin(false, 9); try {
          if (phase !== "private") return poison(); await releaseDeleted(false); const current = await walk(false); for (const node of current) { security(node, "private"); await tick(false); }
          await retireOldPins(current, false);
          for (const node of current.slice().reverse()) {
            const before = metadata(node), raw = acquire(node.parent?.raw ?? parent.raw, node.name, node.kind, DELETE | 0x1200a0, 7); if (!same(before, info(raw), true)) return poison(5); security(node, "private");
            const disposition = Buffer.alloc(4), io = Buffer.alloc(16); disposition.writeUInt32LE(1); nt("NtSetInformationFile", [raw, io, disposition, disposition.length, 64]); closeRaw(raw); closeRaw(node.raw); nodes.delete(node); if (node === root) verifyRoot = () => {}; await tick(false);
          }
          for (const node of [...nodes]) { closeRaw(node.raw); nodes.delete(node); await tick(false); } for (const p of pins.slice().reverse()) { if (!same(p.identity, info(p.raw))) return poison(5); closeRaw(p.raw); await tick(false); } closed = true; peers.delete(ownerRecord);
        } finally { end(); }
      },
    };
    rollbackKnown = async () => {
      const metadataPins = new Set([...nodes].map(node => node.raw)); for (const p of pins) metadataPins.add(p.raw);
      for (const raw of [...handles]) if (!metadataPins.has(raw)) { closeRaw(raw); await tick(false); }
      await tree.close(); for (const entry of selected.entries) if (entry.kind === "file") entry.bytes.fill(0);
    };
    stage = 4;
    for (const entry of selected.entries) {
      active(); checkRoot(); const parts = entry.path.split("/"), name = parts.pop()!, parentNode = byPath.get(windowsCodingFold(parts.join("/"))); if (!parentNode) return poison();
      const made = make(parentNode, name, entry.kind, entry.path, entry.kind === "file" && entry.executable); byPath.set(windowsCodingFold(entry.path), made.node);
      if (entry.kind === "file") {
        for (let offset = 0; offset < entry.bytes.length;) {
          const size = Math.min(CHUNK, entry.bytes.length - offset), io = Buffer.alloc(16), position = Buffer.alloc(8); position.writeBigInt64LE(BigInt(offset)); nt("NtWriteFile", [made.creator, null, null, null, io, entry.bytes.subarray(offset, offset + size), size, position, null]);
          const written = io.readBigUInt64LE(8); if (written !== BigInt(size)) return poison(3, OP.NtWriteFile); offset += size; await tick(true); checkRoot();
        }
        bool("FlushFileBuffers", [made.creator]); if (info(made.creator).size !== entry.bytes.length) return poison(5); made.node.identity = info(made.node.raw); entry.bytes.fill(0);
      }
      closeRaw(made.creator); await tick(true);
    }
    return tree;
    } catch (error) {
      if (terminal) throw terminal;
      if (error instanceof ScopedCodingFileError && error.code === "cancelled" && !allocations.size && !pending.size) {
        if (rollbackKnown) await rollbackKnown();
        else for (const raw of [...handles].reverse()) closeRaw(raw);
        for (const entry of selected.entries) if (entry.kind === "file") entry.bytes.fill(0);
        peers.delete(ownerRecord); throw error;
      }
      if (handles.size || allocations.size || pending.size) return poison(); peers.delete(ownerRecord); throw error;
    }
  } };
}
export async function createFreshWindowsCommandTree(input: FreshWindowsCommandTreeInput): Promise<FreshWindowsCommandTree> {
  if (HOST_PLATFORM !== "win32" || HOST_ARCH !== "x64") throw new ScopedCodingFileError("unavailable");
  const native = createRequire(__filename)("koffi") as typeof Koffi;
  return bindWindowsCommandCopyNative(native, name => native.load(name)).createFreshWindowsCommandTree(input);
}
