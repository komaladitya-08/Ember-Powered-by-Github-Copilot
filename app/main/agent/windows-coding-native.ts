/**
 * Experimental Win64 NTFS primitives for a host-owned disposable copy. No product adapter imports this module.
 * Every path traversal opens one component relative to an already pinned directory. Source capabilities never
 * receive write/delete rights; only fresh protected owner/SYSTEM objects mint mutable copy capabilities.
 * Handles returned to callers are lifetime tokens, not reusable OS handle numbers. Native handles remain private.
 */
import path from "node:path/win32";
import { createRequire } from "node:module";
import type * as Koffi from "koffi";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import { ScopedCodingFileError, type ScopedCodingFileFailure } from "./coding-platform";

export type WindowsCodingHandle = bigint;
/** Unknown native handle termination is terminal for this process's experimental file boundary. */
export class WindowsCodingCleanupError extends Error {
  readonly code = "windows-coding-cleanup-unverified";
  constructor() { super("Windows coding resource cleanup could not be verified."); this.name = "WindowsCodingCleanupError"; }
}
export type WindowsCodingKind = "file" | "directory";
export interface WindowsCodingInfo {
  id: string; volume: string; finalPath: string; kind: WindowsCodingKind; attributes: number; links: number; size: number;
  created: string; written: string; changed: string;
}
export interface WindowsCodingDirEntry { name: string; id: string; attributes: number; size: number }
export interface WindowsCodingPin { handle: WindowsCodingHandle; handles: WindowsCodingHandle[]; path: string }
export interface WindowsCodingNative {
  readonly ownerSid: string;
  pin(absolute: string, mode: "read" | "base"): WindowsCodingPin;
  info(handle: WindowsCodingHandle): WindowsCodingInfo;
  list(handle: WindowsCodingHandle, maximum: number): WindowsCodingDirEntry[];
  open(parent: WindowsCodingHandle, name: string, kind: WindowsCodingKind, mode: "source" | "copy"): WindowsCodingHandle;
  create(parent: WindowsCodingHandle, name: string, kind: WindowsCodingKind): WindowsCodingHandle;
  read(handle: WindowsCodingHandle, offset: number, length: number): Buffer;
  write(handle: WindowsCodingHandle, bytes: Buffer): void;
  flush(handle: WindowsCodingHandle): void;
  replace(temporary: WindowsCodingHandle, parent: WindowsCodingHandle, name: string, replace: boolean): void;
  remove(handle: WindowsCodingHandle): void;
  assertPrivate(handle: WindowsCodingHandle): void;
  close(handle: WindowsCodingHandle): void;
}

type NativeFunction = (...args: unknown[]) => unknown;
type Lease = { raw: bigint; kind: WindowsCodingKind; capability: "read" | "base" | "copy"; root?: bigint; created: boolean; written: boolean; removed: boolean; poisoned: boolean };
const MAX_FILE = 128 * 1024 * 1024, MAX_CHUNK = 1024 * 1024, MAX_ENTRIES = 10_000;
const READ = 0x120089, DIRECTORY_READ = 0x1200a9, ALL = 0x1f01ff, DELETE = 0x10000;
const INVALID_HANDLE = 0xffffffffffffffffn;
const SPECIAL = 0x5640 | 0x40000 | 0x400000;
let nextLease = 1n;
let cleanupFailure: WindowsCodingCleanupError | undefined;
/** A host owner that cannot account for its native scratch must close further admissions until restart. */
export function retireWindowsCodingNative(): WindowsCodingCleanupError { return cleanupFailure ??= new WindowsCodingCleanupError(); }
function fail(code: ScopedCodingFileFailure, operation?: string, status?: number): never {
  const error = new ScopedCodingFileError(code);
  if (operation) Object.defineProperty(error, "cause", { value: Object.freeze({ operation, ...(status === undefined ? {} : { status: status >>> 0 }) }) });
  throw error;
}
function component(value: string): string {
  if (typeof value !== "string" || !value || value.length > 255 || Buffer.byteLength(value) > 255 || value !== value.normalize("NFC") ||
      Buffer.from(value).toString("utf8") !== value || /[\\/:<>"|?*\p{Cc}\p{Cf}]/u.test(value) || /[. ]$/.test(value) || value === "." || value === ".." ||
      /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value)) fail("path");
  return value;
}
const identifier = (value: bigint) => value.toString(16).padStart(16, "0");

/** FILE_ID_BOTH_DIR_INFORMATION: filename starts at 104, the 64-bit NTFS file identifier at 96. */
export function decodeWindowsCodingDirectoryBatch(buffer: Buffer, bytes: number, maximum: number): WindowsCodingDirEntry[] {
  if (!Buffer.isBuffer(buffer) || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > buffer.length || !Number.isSafeInteger(maximum) || maximum < 0 || maximum > MAX_ENTRIES) fail("boundary");
  const result: WindowsCodingDirEntry[] = [];
  let offset = 0, seen = 0;
  while (offset < bytes) {
    if (++seen > maximum + 2 || bytes - offset < 104) fail("limit");
    const next = buffer.readUInt32LE(offset), length = buffer.readUInt32LE(offset + 60);
    const end = next ? offset + next : bytes;
    if ((next && (next < 104 || next % 8 || end >= bytes)) || length < 2 || length % 2 || length > 510 || offset + 104 + length > end) fail("boundary");
    const raw = buffer.subarray(offset + 104, offset + 104 + length), name = raw.toString("utf16le");
    if (!Buffer.from(name, "utf16le").equals(raw) || Buffer.from(name).toString("utf8") !== name) fail("unsupported");
    const size = buffer.readBigInt64LE(offset + 40);
    if (size < 0n || size > BigInt(Number.MAX_SAFE_INTEGER)) fail("limit");
    if (name !== "." && name !== "..") {
      component(name);
      if (result.length >= maximum) fail("limit");
      const fileId = buffer.readBigUInt64LE(offset + 96); if (fileId === 0n) fail("boundary");
      result.push({ name, id: identifier(fileId), attributes: buffer.readUInt32LE(offset + 56), size: Number(size) });
    }
    if (!next) break;
    offset = end;
  }
  return result;
}

export const WINDOWS_CODING_FUNCTIONS = {
  ntdll: [
    "int32_t __stdcall NtCreateFile(_Out_ void **file, uint32_t access, void *attributes, void *io, void *allocationSize, uint32_t fileAttributes, uint32_t share, uint32_t disposition, uint32_t options, void *ea, uint32_t eaLength)",
    "int32_t __stdcall NtQueryDirectoryFile(void *file, void *event, void *apc, void *context, void *io, void *information, uint32_t length, int kind, uint8_t single, void *name, uint8_t restart)",
    "int32_t __stdcall NtReadFile(void *file, void *event, void *apc, void *context, void *io, void *bytes, uint32_t length, void *offset, void *key)",
    "int32_t __stdcall NtWriteFile(void *file, void *event, void *apc, void *context, void *io, void *bytes, uint32_t length, void *offset, void *key)",
    "int32_t __stdcall NtSetInformationFile(void *file, void *io, void *information, uint32_t length, int kind)",
  ],
  kernel32: [
    "int __stdcall CloseHandle(void *file)", "uint32_t __stdcall GetLastError()", "void * __stdcall GetCurrentProcess()",
    "void * __stdcall LocalFree(void *memory)", "uint32_t __stdcall GetFileType(void *file)",
    "int __stdcall GetFileInformationByHandle(void *file, void *information)",
    "int __stdcall GetFileInformationByHandleEx(void *file, int kind, void *information, uint32_t length)",
    "uint32_t __stdcall GetFinalPathNameByHandleW(void *file, void *name, uint32_t length, uint32_t flags)",
    "uint32_t __stdcall GetDriveTypeW(const char16_t *root)",
    "int __stdcall GetVolumeInformationW(const char16_t *root, void *name, uint32_t nameLength, void *serial, void *componentLength, void *flags, void *filesystem, uint32_t filesystemLength)",
    "int __stdcall FlushFileBuffers(void *file)",
  ],
  advapi32: [
    "int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)",
    "int __stdcall GetTokenInformation(void *token, int kind, void *information, uint32_t length, _Out_ uint32_t *returned)",
    "int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)",
    "int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *text, uint32_t revision, _Out_ void **descriptor, void *length)",
    "uint32_t __stdcall GetSecurityInfo(void *file, int objectKind, uint32_t information, _Out_ void **owner, void *group, _Out_ void **dacl, void *sacl, _Out_ void **descriptor)",
    "int __stdcall GetSecurityDescriptorControl(void *descriptor, _Out_ uint16_t *control, _Out_ uint32_t *revision)",
    "int __stdcall GetAclInformation(void *acl, void *information, uint32_t length, int kind)",
    "int __stdcall GetAce(void *acl, uint32_t index, _Out_ void **ace)",
  ],
} as const;

/** Synchronous bounded system calls only; callers supply their own asynchronous admission/lease fences. */
export function bindWindowsCodingNative(native: Pick<typeof Koffi, "sizeof" | "address" | "decode">, load: (name: string) => { func(prototype: string): unknown }): WindowsCodingNative {
  if (cleanupFailure) throw cleanupFailure;
  if (native.sizeof("void *") !== 8) fail("unavailable");
  const functions: Record<string, NativeFunction> = {};
  for (const [name, prototypes] of Object.entries(WINDOWS_CODING_FUNCTIONS)) {
    const library = load(`${name}.dll`);
    for (const prototype of prototypes) functions[/\b(\w+)\s*\(/.exec(prototype)![1]] = library.func(prototype) as NativeFunction;
  }
  const pool = new Map<bigint, Lease>();
  let owner: string | undefined;
  const rawPointer = (value: unknown): bigint => {
    if (typeof value !== "bigint" || value === 0n || value === INVALID_HANDLE) fail("io");
    return value;
  };
  const win = (operation: string): never => fail("io", operation, Number(functions.GetLastError()));
  const nt = (value: unknown, operation: string): number => {
    if (typeof value !== "number" || !Number.isInteger(value)) fail("io", operation);
    const status = value >>> 0;
    if (status === 0) return status;
    const code: ScopedCodingFileFailure = status === 0xc0000034 || status === 0xc000003a ? "missing" : status === 0xc0000035 ? "exists" :
      status === 0xc0000043 || status === 0xc0000056 || status === 0xc0000054 ? "conflict" : status === 0xc0000101 ? "not-empty" :
        status === 0xc000050b || status === 0x8000002d || status === 0xc00000ba || status === 0xc0000103 ? "unsupported" : status === 0xc0000022 ? "boundary" : "io";
    return fail(code, operation, status);
  };
  const state = (handle: bigint): Lease => {
    if (cleanupFailure) throw cleanupFailure;
    const value = pool.get(handle);
    if (!value || value.poisoned || value.removed) fail("boundary");
    if (value.root !== undefined) {
      const root = pool.get(value.root);
      if (!root || root.poisoned || root.removed) fail("boundary");
    }
    return value;
  };
  const close = (handle: bigint): void => {
    const value = pool.get(handle);
    if (!value) fail("boundary");
    if (value.poisoned) throw cleanupFailure ??= new WindowsCodingCleanupError();
    let closed = false; try { closed = !!functions.CloseHandle(value.raw); } catch { /* Native completion is unknown. */ }
    if (!closed) { value.poisoned = true; throw cleanupFailure ??= new WindowsCodingCleanupError(); }
    pool.delete(handle);
  };
  const closeRaw = (handle: bigint): void => {
    let closed = false; try { closed = !!functions.CloseHandle(handle); } catch { /* Native completion is unknown. */ }
    if (!closed) throw cleanupFailure ??= new WindowsCodingCleanupError();
  };
  const rollbackCreated = (handle: bigint): void => {
    // Only a just-created empty object whose capability has not left this call may use this cleanup path.
    const value = pool.get(handle);
    if (!value || value.poisoned || !value.created || value.removed) throw cleanupFailure ??= new WindowsCodingCleanupError();
    const disposition = Buffer.alloc(4), io = Buffer.alloc(16); disposition.writeUInt32LE(1);
    let status: unknown; try { status = functions.NtSetInformationFile(value.raw, io, disposition, disposition.length, 64); } catch { /* Preserve unknown cleanup as terminal. */ }
    if (status !== 0) throw cleanupFailure ??= new WindowsCodingCleanupError();
    value.removed = true;
  };
  const discardCreated = (handle: bigint, problem: unknown): never => {
    try { rollbackCreated(handle); } catch (error) { problem = error; }
    try { close(handle); } catch (error) { problem = error; }
    throw problem;
  };
  const free = (pointer: bigint) => {
    let released = false; try { released = !functions.LocalFree(pointer); } catch { /* Native completion is unknown. */ }
    if (!released) throw cleanupFailure ??= new WindowsCodingCleanupError();
  };
  const managed = <T>(operation: () => T, release: () => void): T => {
    let result!: T, problem: unknown, failed = false;
    try { result = operation(); } catch (error) { failed = true; problem = error; }
    release();
    if (failed) throw problem;
    return result;
  };
  const sid = (pointer: bigint): string => {
    const output: unknown[] = [null];
    if (!functions.ConvertSidToStringSidW(pointer, output)) win("ConvertSidToStringSidW");
    const text = rawPointer(output[0]);
    return managed(() => native.decode.string16(text), () => free(text));
  };
  const ownerSid = (): string => {
    if (owner) return owner;
    const output: unknown[] = [null];
    if (!functions.OpenProcessToken(functions.GetCurrentProcess(), 0x8, output)) win("OpenProcessToken");
    const token = rawPointer(output[0]);
    owner = managed(() => {
      const info = Buffer.alloc(4096), returned = [0];
      if (!functions.GetTokenInformation(token, 1, info, info.length, returned) || returned[0] > info.length) win("GetTokenInformation");
      const value = sid(info.readBigUInt64LE(0));
      info.fill(0); // Keep the TOKEN_USER backing buffer alive through native SID conversion.
      if (!/^S-\d+(?:-\d+)+$/.test(value)) fail("boundary");
      return value;
    }, () => closeRaw(token));
    return owner;
  };
  const descriptor = <T>(directory: boolean, operation: (pointer: bigint) => T): T => {
    const principal = ownerSid(), inherit = directory ? "OICI" : "";
    const sddl = `O:${principal}D:P(A;${inherit};FA;;;${principal})(A;${inherit};FA;;;SY)`;
    const output: unknown[] = [null];
    if (!functions.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, output, null)) win("ConvertStringSecurityDescriptorToSecurityDescriptorW");
    const pointer = rawPointer(output[0]);
    return managed(() => operation(pointer), () => free(pointer));
  };
  const info = (handle: bigint): WindowsCodingInfo => {
    const value = state(handle);
    if (Number(functions.GetFileType(value.raw)) !== 1) fail("unsupported");
    const bytes = Buffer.alloc(52), basic = Buffer.alloc(40);
    if (!functions.GetFileInformationByHandle(value.raw, bytes) || !functions.GetFileInformationByHandleEx(value.raw, 0, basic, basic.length)) win("GetFileInformationByHandle");
    const attributes = bytes.readUInt32LE(0), directory = !!(attributes & 0x10), links = bytes.readUInt32LE(40);
    if ((attributes & SPECIAL) !== 0 || directory !== (value.kind === "directory") || (!directory && links !== 1)) fail("unsupported");
    if (attributes !== basic.readUInt32LE(32) || bytes.readBigUInt64LE(4) !== basic.readBigUInt64LE(0) || bytes.readBigUInt64LE(20) !== basic.readBigUInt64LE(16)) fail("conflict");
    const length = (BigInt(bytes.readUInt32LE(32)) << 32n) | BigInt(bytes.readUInt32LE(36));
    if (length > BigInt(Number.MAX_SAFE_INTEGER)) fail("limit");
    const text = Buffer.alloc(32768 * 2), count = Number(functions.GetFinalPathNameByHandleW(value.raw, text, 32768, 1));
    if (count < 1 || count >= 32768) win("GetFinalPathNameByHandleW");
    const finalPath = text.toString("utf16le", 0, count * 2), volume = /^(\\\\\?\\Volume\{[0-9a-f-]{36}\}\\)/i.exec(finalPath)?.[1];
    if (!volume || /[\0\r\n]/.test(finalPath)) fail("boundary");
    return { id: identifier((BigInt(bytes.readUInt32LE(44)) << 32n) | BigInt(bytes.readUInt32LE(48))), volume: volume.toLowerCase(), finalPath,
      kind: value.kind, attributes, links, size: Number(length), created: basic.readBigUInt64LE(0).toString(),
      written: basic.readBigUInt64LE(16).toString(), changed: basic.readBigUInt64LE(24).toString() };
  };
  const assertPrivate = (handle: bigint): void => {
    const value = state(handle);
    if (value.capability !== "copy") fail("boundary");
    info(handle);
    const output: unknown[] = [null], ownerOutput: unknown[] = [null], aclOutput: unknown[] = [null];
    const status = Number(functions.GetSecurityInfo(value.raw, 1, 1 | 4, ownerOutput, null, aclOutput, null, output));
    if (status !== 0) fail("boundary", "GetSecurityInfo", status);
    const security = rawPointer(output[0]);
    managed(() => {
      const own = sid(rawPointer(ownerOutput[0])), expected = [ownerSid(), "S-1-5-18"].sort();
      if (own !== ownerSid()) fail("boundary");
      const controls = [0], revision = [0];
      if (!functions.GetSecurityDescriptorControl(security, controls, revision) || !(controls[0] & 0x1000) || !(controls[0] & 4)) fail("boundary");
      const acl = rawPointer(aclOutput[0]), details = Buffer.alloc(12);
      if (!functions.GetAclInformation(acl, details, details.length, 2) || details.readUInt32LE(0) !== 2) fail("boundary");
      const granted: string[] = [];
      for (let index = 0; index < 2; index++) {
        const aceOutput: unknown[] = [null];
        if (!functions.GetAce(acl, index, aceOutput)) fail("boundary");
        const pointer = rawPointer(aceOutput[0]), header = Buffer.from(native.decode(pointer, "uint8_t", 8) as Uint8Array);
        if (header[0] !== 0 || header[1] !== (value.kind === "directory" ? 3 : 0) || header.readUInt16LE(2) < 12 || header.readUInt16LE(2) > 76 || header.readUInt32LE(4) !== ALL) fail("boundary");
        granted.push(sid(pointer + 8n));
      }
      granted.sort();
      if (granted.some((principal, index) => principal !== expected[index])) fail("boundary");
    }, () => free(security));
  };
  const openRaw = (parent: bigint | null, name: string, kind: WindowsCodingKind, access: number, share: number, create: boolean, security: bigint | null,
    capability: Lease["capability"], root?: bigint): bigint => {
    const text = Buffer.from(name + "\0", "utf16le");
    if (text.length > 65534) fail("path");
    const unicode = Buffer.alloc(16), attributes = Buffer.alloc(48), io = Buffer.alloc(16), output: unknown[] = [null];
    unicode.writeUInt16LE(text.length - 2, 0); unicode.writeUInt16LE(text.length, 2); unicode.writeBigUInt64LE(native.address(text), 8);
    attributes.writeUInt32LE(48, 0); if (parent !== null) attributes.writeBigUInt64LE(state(parent).raw, 8);
    attributes.writeBigUInt64LE(native.address(unicode), 16); attributes.writeUInt32LE(0x40 | 0x1000, 24);
    if (security !== null) attributes.writeBigUInt64LE(security, 32);
    const options = 0x20 | 0x200000 | (kind === "directory" ? 1 : 0x40);
    const status = functions.NtCreateFile(output, access, attributes, io, null, create ? (kind === "directory" ? 0x10 : 0x80) : 0,
      share, create ? 2 : 1, options, null, 0);
    // These buffers contain nested raw pointers; observable zeroing keeps both backing allocations alive until
    // the synchronous call completes, instead of relying on an optimizer's incidental local-variable liveness.
    text.fill(0); unicode.fill(0);
    if (status !== 0) {
      const maybe = output[0];
      if (typeof maybe === "bigint" && maybe !== 0n && maybe !== INVALID_HANDLE) closeRaw(maybe);
      nt(status, "NtCreateFile");
    }
    const raw = rawPointer(output[0]), handle = nextLease++;
    pool.set(handle, { raw, kind, capability, root, created: create, written: false, removed: false, poisoned: false });
    try { info(handle); return handle; } catch (error) { if (create) return discardCreated(handle, error); close(handle); throw error; }
  };
  const opened = (parent: bigint, name: string, kind: WindowsCodingKind, mode: "source" | "copy"): bigint => {
    const selected = state(parent); component(name);
    if ((mode !== "source" && mode !== "copy") || (kind !== "file" && kind !== "directory")) fail("path");
    if (selected.kind !== "directory" || (mode === "copy" && selected.capability !== "copy")) fail("boundary");
    const mutable = mode === "copy";
    const access = mutable ? (kind === "directory" ? ALL : READ | DELETE) : kind === "directory" ? DIRECTORY_READ : READ;
    return openRaw(parent, name, kind, access, kind === "directory" ? 3 : 1, false, null, mutable ? "copy" : "read", mutable ? selected.root : undefined);
  };
  const api: WindowsCodingNative = {
    get ownerSid() { return ownerSid(); },
    pin(absolute, mode) {
      if (mode !== "read" && mode !== "base") fail("path");
      if (typeof absolute !== "string" || absolute.length > 4096 || !/^[A-Za-z]:\\/.test(absolute) || absolute.includes("/") || /[\p{Cc}\p{Cf}]/u.test(absolute)) fail("path");
      const drive = path.parse(absolute).root;
      if (!/^[A-Za-z]:\\$/.test(drive) || Number(functions.GetDriveTypeW(drive)) !== 3) fail("unsupported");
      const filesystem = Buffer.alloc(64);
      if (!functions.GetVolumeInformationW(drive, null, 0, null, null, null, filesystem, 32) || filesystem.toString("utf16le").split("\0", 1)[0].toUpperCase() !== "NTFS") fail("unsupported");
      const suffix = absolute.slice(drive.length), parts = suffix ? suffix.split("\\").map(component) : [];
      const handles: bigint[] = [];
      try {
        let current = openRaw(null, `\\??\\${drive}`, "directory", DIRECTORY_READ, 3, false, null, "read"); handles.push(current);
        for (const name of parts) { current = opened(current, name, "directory", "source"); handles.push(current); }
        if (mode === "base") {
          const previous = handles[handles.length - 1];
          const baseParent = handles.length > 1 ? handles[handles.length - 2] : null, name = parts.length ? parts[parts.length - 1] : `\\??\\${drive}`;
          // The final scratch parent alone receives add-child rights; source/ancestor handles stay read-only.
          const writable = openRaw(baseParent, name, "directory", DIRECTORY_READ | 2 | 4, 3, false, null, "base");
          handles.push(writable); close(previous); handles.splice(handles.length - 2, 1); current = writable;
        }
        return { handle: current, handles, path: absolute };
      } catch (error) {
        let closeFailed = false;
        for (const handle of handles.reverse()) { try { close(handle); } catch { closeFailed = true; } }
        if (closeFailed) throw cleanupFailure ??= new WindowsCodingCleanupError();
        throw error;
      }
    },
    info,
    list(handle, maximum) {
      const value = state(handle);
      if (value.kind !== "directory" || !Number.isSafeInteger(maximum) || maximum < 0 || maximum > MAX_ENTRIES) fail("limit");
      const result: WindowsCodingDirEntry[] = [], buffer = Buffer.alloc(64 * 1024), io = Buffer.alloc(16);
      let restart = 1, pages = 0;
      for (;;) {
        if (++pages > MAX_ENTRIES + 1) fail("limit");
        io.fill(0); buffer.fill(0);
        const status = Number(functions.NtQueryDirectoryFile(value.raw, null, null, null, io, buffer, buffer.length, 37, 0, null, restart)) >>> 0;
        restart = 0;
        if (status === 0x80000006) break;
        nt(status, "NtQueryDirectoryFile");
        const count = io.readBigUInt64LE(8);
        if (count < 1n || count > BigInt(buffer.length)) fail("boundary");
        result.push(...decodeWindowsCodingDirectoryBatch(buffer, Number(count), maximum - result.length));
      }
      return result;
    },
    open: opened,
    create(parent, name, kind) {
      const selected = state(parent); component(name);
      if (kind !== "file" && kind !== "directory") fail("path");
      if (selected.kind !== "directory" || (selected.capability !== "copy" && selected.capability !== "base") || (selected.capability === "base" && kind !== "directory")) fail("boundary");
      // Retain ownership before descriptor disposal: a failing LocalFree must never strand a newly opened handle.
      let handle: bigint | undefined;
      try {
        descriptor(kind === "directory", security => { handle = openRaw(parent, name, kind, ALL, 3, true, security, "copy", selected.root); });
        const value = state(handle!);
        if (selected.capability === "base") value.root = handle!;
        assertPrivate(handle!); return handle!;
      } catch (error) { if (handle !== undefined) return discardCreated(handle, error); throw error; }
    },
    read(handle, offset, length) {
      const value = state(handle);
      if (value.kind !== "file" || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > MAX_CHUNK) fail("limit");
      if (!length) return Buffer.alloc(0);
      const bytes = Buffer.alloc(length), position = Buffer.alloc(8), io = Buffer.alloc(16); position.writeBigInt64LE(BigInt(offset));
      const status = Number(functions.NtReadFile(value.raw, null, null, null, io, bytes, length, position, null)) >>> 0;
      if (status === 0xc0000011) return Buffer.alloc(0);
      nt(status, "NtReadFile");
      const read = io.readBigUInt64LE(8); if (read > BigInt(length)) fail("boundary");
      return bytes.subarray(0, Number(read));
    },
    write(handle, bytes) {
      const value = state(handle);
      if (value.capability !== "copy" || value.kind !== "file" || !value.created || value.written) fail("boundary");
      if (!Buffer.isBuffer(bytes) || bytes.length > MAX_FILE || info(handle).size !== 0) fail("limit");
      value.written = true;
      for (let offset = 0; offset < bytes.length;) {
        const count = Math.min(MAX_CHUNK, bytes.length - offset), position = Buffer.alloc(8), io = Buffer.alloc(16); position.writeBigInt64LE(BigInt(offset));
        nt(functions.NtWriteFile(value.raw, null, null, null, io, bytes.subarray(offset, offset + count), count, position, null), "NtWriteFile");
        const written = io.readBigUInt64LE(8); if (written < 1n || written > BigInt(count)) fail("io"); offset += Number(written);
      }
      if (info(handle).size !== bytes.length) fail("conflict");
    },
    flush(handle) {
      const value = state(handle); if (value.capability !== "copy" || value.kind !== "file") fail("unsupported");
      if (!functions.FlushFileBuffers(value.raw)) win("FlushFileBuffers");
    },
    replace(temporary, parent, name, replace) {
      const value = state(temporary), directory = state(parent); component(name);
      if (value.capability !== "copy" || !value.created || value.kind !== "file" || directory.capability !== "copy" || directory.kind !== "directory" || value.root !== directory.root || typeof replace !== "boolean") fail("boundary");
      assertPrivate(temporary);
      if (info(temporary).volume !== info(parent).volume) fail("boundary");
      const text = Buffer.from(name, "utf16le"), rename = Buffer.alloc(20 + text.length), io = Buffer.alloc(16);
      rename.writeUInt32LE(replace ? 3 : 0, 0); rename.writeBigUInt64LE(directory.raw, 8); rename.writeUInt32LE(text.length, 16); text.copy(rename, 20);
      nt(functions.NtSetInformationFile(value.raw, io, rename, rename.length, 65), "NtSetInformationFile(rename)");
      value.created = false;
    },
    remove(handle) {
      const value = state(handle); if (value.capability !== "copy") fail("boundary");
      assertPrivate(handle);
      const disposition = Buffer.alloc(4), io = Buffer.alloc(16); disposition.writeUInt32LE(1);
      nt(functions.NtSetInformationFile(value.raw, io, disposition, disposition.length, 64), "NtSetInformationFile(disposition)");
      value.removed = true;
    },
    assertPrivate,
    close,
  };
  return api;
}

export function loadWindowsCodingNative(): WindowsCodingNative {
  if (HOST_PLATFORM !== "win32" || HOST_ARCH !== "x64") fail("unavailable");
  const native = createRequire(__filename)("koffi") as typeof Koffi;
  try { return bindWindowsCodingNative(native, name => native.load(name)); }
  catch (error) { if (error instanceof ScopedCodingFileError || error instanceof WindowsCodingCleanupError) throw error; return fail("unavailable"); }
}
