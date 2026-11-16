/** Disabled host-only standard streams. Native-owned pipes, launch provenance and stopped output are never model tools. */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path/win32";
import type * as Koffi from "koffi";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import { loadWindowsCodingNative, WindowsCodingCleanupError } from "./windows-coding-native";
import { windowsCommandCreatorProfile, type WindowsCommandCreatorProfileRef } from "./windows-command-creator-profile";
import type { WindowsSuspendedProcess } from "./experimental-windows-lpac-api";
import { windowsCommandRootOnlyLaunchDirectory, requireWindowsCommandRootOnlyCompletedOutput,
  type WindowsCommandRootOnlyLaunchContext, type WindowsCommandRootOnlyCompletedRef, type WindowsCommandRootOnlyRunRef } from "./windows-command-copy";
import { requireWindowsCommandRootOnlyOutputMatch, requireWindowsCommandRootOnlyOutputStoppedLaunch, type WindowsCommandRootOnlyOutputMatchRef } from "./windows-command-stop";

declare const launchBrand: unique symbol;
export interface WindowsCommandOutputLaunchRef { readonly scope: "native-output-launch"; readonly [launchBrand]: true }
declare const closedBrand: unique symbol;
export interface WindowsCommandOutputClosedRef { readonly scope: "native-output-closed"; readonly [closedBrand]: true }
export type WindowsCommandOutputReason = "none" | "cancelled" | "overflow" | "timeout" | "delivery";
export interface WindowsCommandOutputFacts { readonly stdoutBytes: number; readonly stderrBytes: number; readonly complete: boolean; readonly reason: WindowsCommandOutputReason }
export class WindowsCommandOutputCleanupError extends WindowsCodingCleanupError {
  constructor() { super(); this.name = "WindowsCommandOutputCleanupError"; this.message = "Windows command output ownership could not be verified; further output is unavailable."; }
}
export interface WindowsCommandOutputFence { failure?: WindowsCommandOutputCleanupError; retained: unknown[] }
export interface WindowsCommandOutputOptions {
  signal: AbortSignal; timeoutMs: number;
  output(bytes: Uint8Array, stream: "stdout" | "stderr"): void;
}
export interface WindowsCommandOutputOwner {
  readonly signal: AbortSignal;
  closeUnused(): void;
  createSuspended(context: WindowsCommandRootOnlyLaunchContext, program: string, command: Buffer): WindowsCommandOutputLaunchRef;
  closeOutputAfterStopped(completed: WindowsCommandRootOnlyCompletedRef, run: WindowsCommandRootOnlyRunRef): Promise<WindowsCommandOutputClosedRef>;
}
type Fn = (...args: unknown[]) => unknown;
type Loader = (name: string) => { func(prototype: string): unknown };
type NativeMemoryApi = Pick<typeof Koffi, "sizeof" | "address" | "alloc" | "free" | "encode" | "decode">;
type Owned = { raw: bigint; attempted: boolean; closed: boolean };
type Memory = { raw: unknown; address?: bigint; size: number; attempted: boolean; freed: boolean };
type ProfilePath = { output: unknown[]; raw?: unknown; decoded?: unknown; attempted: boolean; freed: boolean };
type Stream = { kind: "stdout" | "stderr"; server: Owned; writer: Owned; event: Owned; ov: Memory; bytes: Memory; count: number; pending: boolean; eof: boolean; cancelling: boolean };
type Universe = { failure?: WindowsCommandOutputCleanupError; busy: boolean; owners: Set<State>; handles: Set<bigint> };
type State = {
  universe: Universe; fence: WindowsCommandOutputFence; fn: Record<string, Fn>; native: NativeMemoryApi; load: Loader;
  libraries: unknown[];
  inFlight?: { name: string; args: unknown[] }; creation?: unknown[];
  lastError?: number;
  profile: WindowsCommandCreatorProfileRef; borrowedSid: bigint; ownerSid: string; options: WindowsCommandOutputOptions;
  controller: AbortController; reason: WindowsCommandOutputReason; owned: Owned[]; buffers: Set<Buffer>; streams: Stream[];
  allocations: Set<Memory>;
  profilePath?: ProfilePath;
  clock(): number;
  descriptor?: bigint; descriptorAttempted: boolean; root?: Readonly<WindowsSuspendedProcess>; launch?: WindowsCommandOutputLaunchRef;
  context?: WindowsCommandRootOnlyLaunchContext;
  piReleased: boolean;
  matched?: WindowsCommandRootOnlyOutputMatchRef; delegated: boolean; terminateAttempted: boolean; creating: boolean; closed: boolean;
  timer?: ReturnType<typeof setTimeout>; pump?: ReturnType<typeof setTimeout>; closing?: Promise<WindowsCommandOutputClosedRef>;
  abort: () => void; notify: Set<() => void>;
};
const launches = new WeakMap<object, State>(), closures = new WeakMap<object, { launch: WindowsCommandOutputLaunchRef; run: WindowsCommandRootOnlyRunRef; facts: Readonly<WindowsCommandOutputFacts> }>();
const universes = new WeakMap<WindowsCommandOutputFence, Universe>(), defaultFence: WindowsCommandOutputFence = { retained: [] };
const CHUNK = 16 * 1024, LIMIT = 256 * 1024, IO_PENDING = 997, IO_INCOMPLETE = 996, BROKEN_PIPE = 109, ABORTED = 995;
const pointer = (value: unknown): value is bigint => typeof value === "bigint" && value > 0n && value < 0x8000000000000000n;
const ERROR_CALLS = new Set(["ConnectNamedPipe", "ReadFile", "GetOverlappedResult", "CancelIoEx", "InitializeProcThreadAttributeList"]);
const dword = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const bool = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
const refusal = () => new Error("The native Windows command output reference is unavailable.");

export const WINDOWS_COMMAND_OUTPUT_FUNCTIONS = {
  kernel32: [
    "uint32_t __stdcall GetLastError()", "int __stdcall CloseHandle(void *handle)", "void * __stdcall LocalFree(void *memory)",
    "void * __stdcall CreateNamedPipeW(const char16_t *name, uint32_t openMode, uint32_t pipeMode, uint32_t instances, uint32_t outSize, uint32_t inSize, uint32_t timeout, void *security)",
    "void * __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)",
    "int __stdcall ConnectNamedPipe(void *pipe, void *overlapped)",
    "int __stdcall ReadFile(void *file, void *bytes, uint32_t size, _Out_ uint32_t *read, void *overlapped)",
    "int __stdcall GetOverlappedResult(void *file, void *overlapped, _Out_ uint32_t *transferred, int wait)",
    "int __stdcall CancelIoEx(void *file, void *overlapped)",
    "void * __stdcall CreateEventW(void *security, int manualReset, int initialState, const char16_t *name)",
    "int __stdcall ResetEvent(void *event)", "uint32_t __stdcall GetFileType(void *file)",
    "int __stdcall GetHandleInformation(void *handle, _Out_ uint32_t *flags)",
    "int __stdcall SetHandleInformation(void *handle, uint32_t mask, uint32_t flags)",
    "uint32_t __stdcall GetWindowsDirectoryW(void *text, uint32_t size)",
    "int __stdcall InitializeProcThreadAttributeList(void *list, uint32_t count, uint32_t flags, _Inout_ size_t *size)",
    "int __stdcall UpdateProcThreadAttribute(void *list, uint32_t flags, uintptr_t key, void *value, size_t size, void *previous, void *returned)",
    "void __stdcall DeleteProcThreadAttributeList(void *list)",
    "int __stdcall CreateProcessW(const char16_t *program, void *command, void *processSecurity, void *threadSecurity, int inherit, uint32_t flags, void *environment, const char16_t *directory, void *startup, void *information)",
    "int __stdcall TerminateProcess(void *process, uint32_t code)",
  ],
  advapi32: ["int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *text, uint32_t revision, _Out_ void **descriptor, void *size)"],
  ntdll: ["int32_t __stdcall NtQueryObject(void *handle, uint32_t kind, void *information, uint32_t size, _Out_ uint32_t *returned)"],
  userenv: ["int32_t __stdcall GetAppContainerFolderPath(const char16_t *sidText, _Out_ void **path)"],
  ole32: ["void __stdcall CoTaskMemFree(void *memory)"],
} as const;

function stop(s: State, reason: WindowsCommandOutputReason): void {
  if (s.reason === "none") s.reason = reason;
  s.controller.abort(); for (const wake of s.notify) wake();
}
function poison(s: State, extra?: unknown): never {
  const u = s.universe;
  if (!u.failure) {
    u.failure = new WindowsCommandOutputCleanupError(); s.fence.failure = u.failure;
    for (const owner of u.owners) {
      owner.fence.retained.push({ owner, extra });
      if (owner.pump) clearTimeout(owner.pump); if (owner.timer) clearTimeout(owner.timer);
      owner.pump = undefined; owner.timer = undefined; stop(owner, "cancelled");
    }
  }
  // A positive PI not yet handed to Stop still has a known process. Request termination only; retain every owner.
  for (const owner of u.owners) if (owner.root && !owner.delegated && !owner.terminateAttempted) {
    owner.terminateAttempted = true; try { owner.fn.TerminateProcess(owner.root.process, 125); } catch { /* No disposal authority. */ }
  }
  throw u.failure;
}
function usable(s: State): void { if (s.universe.failure || s.fence.failure) poison(s); if (s.closed) throw refusal(); }
function call(s: State, name: string, args: unknown[]): unknown {
  usable(s); if (s.universe.busy) return poison(s); s.universe.busy = true;
  s.inFlight = { name, args };
  try {
    s.lastError = undefined;
    const value = s.fn[name](...args);
    // Capture on the same thread before wrapper bookkeeping or another native operation can alter LastError.
    if (value === 0 && ERROR_CALLS.has(name)) {
      const error = s.fn.GetLastError(); if (!dword(error)) return poison(s); s.lastError = error;
    }
    usable(s); return value;
  } catch (error) { return poison(s, error); }
  finally { s.universe.busy = false; }
}
function ok(s: State, name: string, args: unknown[]): void { const value = call(s, name, args); if (!bool(value) || value === 0) poison(s); }
function last(s: State): number { usable(s); if (!dword(s.lastError)) return poison(s); return s.lastError; }
function own(s: State, value: unknown): Owned {
  if (!pointer(value) || s.universe.handles.has(value)) return poison(s);
  const token = { raw: value, attempted: false, closed: false }; s.owned.push(token); s.universe.handles.add(value); return token;
}
function close(s: State, value: Owned): void {
  usable(s); if (value.closed) return; if (value.attempted) return poison(s);
  value.attempted = true; ok(s, "CloseHandle", [value.raw]); value.closed = true; s.universe.handles.delete(value.raw);
}
function flags(s: State, value: Owned, expected: number): void {
  const output = Buffer.alloc(4); s.buffers.add(output); ok(s, "GetHandleInformation", [value.raw, output]);
  if (output.readUInt32LE(0) !== expected) poison(s); output.fill(0); s.buffers.delete(output);
}
function freshBuffer(s: State, size: number): Buffer { const value = Buffer.alloc(size); s.buffers.add(value); return value; }
function release(s: State, value: Buffer): void { usable(s); value.fill(0); s.buffers.delete(value); }
function nativeMemory<T>(s: State, name: string, args: unknown[], operation: () => T): T {
  usable(s); if (s.universe.busy) return poison(s); s.universe.busy = true; s.inFlight = { name, args };
  try { const result = operation(); usable(s); return result; } catch (error) { return poison(s, error); }
  finally { s.universe.busy = false; }
}
function allocate(s: State, size: number): Memory {
  const memory: Memory = { raw: undefined, size, attempted: false, freed: false }; s.allocations.add(memory);
  const raw: unknown = nativeMemory(s, "alloc", ["uint8_t", size], () => memory.raw = s.native.alloc("uint8_t", size));
  if (raw === null || raw === undefined) return poison(s);
  const address = nativeMemory(s, "address", [raw], () => s.native.address(raw));
  if (!pointer(address) || address < 0x10000n || s.universe.handles.has(address)) return poison(s);
  for (const owner of s.universe.owners) for (const other of owner.allocations) {
    if (other !== memory && !other.freed && other.address !== undefined && address < other.address + BigInt(other.size) && other.address < address + BigInt(size)) return poison(s);
  }
  memory.address = address; writeMemory(s, memory, Buffer.alloc(size)); return memory;
}
function writeMemory(s: State, memory: Memory, bytes: Buffer): void {
  if (memory.freed || memory.attempted || bytes.length !== memory.size) return poison(s);
  const result = nativeMemory(s, "encode", [memory.raw, bytes], () => s.native.encode(memory.raw, "uint8_t", bytes, bytes.length));
  if (result !== undefined) return poison(s);
}
function readMemory(s: State, memory: Memory, count: number): Uint8Array {
  if (memory.freed || memory.attempted || count < 0 || count > memory.size) return poison(s);
  const value: unknown = nativeMemory(s, "decode", [memory.raw, count], () => s.native.decode(memory.raw, "uint8_t", count));
  if (value instanceof Uint8Array && value.byteLength === count) return Uint8Array.from(value);
  if (!Array.isArray(value) || value.length !== count) return poison(s);
  const bytes = new Uint8Array(count);
  for (let index = 0; index < count; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index)), byte: unknown = descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
    if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) return poison(s); bytes[index] = byte;
  }
  return bytes;
}
function freeMemory(s: State, memory: Memory): void {
  usable(s); if (memory.freed) return; if (memory.attempted) return poison(s);
  writeMemory(s, memory, Buffer.alloc(memory.size)); memory.attempted = true;
  const result = nativeMemory(s, "free", [memory.raw], () => s.native.free(memory.raw));
  if (result !== undefined) return poison(s); memory.freed = true;
}
/** The OS owns this NUL-terminated string until a positive matching CoTaskMemFree; no host environment is consulted. */
function profileLocalAppData(s: State, name: string, sidText: string): string {
  if (s.profilePath) return poison(s);
  const held: ProfilePath = { output: [undefined], attempted: false, freed: false }; s.profilePath = held;
  const hr = call(s, "GetAppContainerFolderPath", [sidText, held.output]); held.raw = held.output[0];
  if (hr !== 0 || !pointer(held.raw) || held.raw < 0x10000n || held.raw % 2n) return poison(s);
  const raw = held.raw;
  const unaliased = (size: number) => {
    const end = raw + BigInt(size);
    for (const owner of s.universe.owners) {
      // The sealed factory fixes top-level package SIDs to 40 bytes. These are borrowed, never COM allocations.
      if (raw < owner.borrowedSid + 40n && owner.borrowedSid < end || owner.universe.handles.has(raw)) return poison(s);
      for (const memory of owner.allocations) if (!memory.freed && memory.address !== undefined && raw < memory.address + BigInt(memory.size) && memory.address < end) return poison(s);
      const other = owner.profilePath;
      if (other && other !== held && !other.freed && other.raw === raw) return poison(s);
    }
  };
  unaliased(2);
  // GetAppContainerFolderPath promises an allocated NUL-terminated PWSTR; string16 is Koffi's supported decoder.
  held.decoded = nativeMemory(s, "decode.string16", [raw], () => s.native.decode.string16(raw));
  const folder = held.decoded;
  const ordinary = (value: string) => value.length > 3 && value.length <= 32767 && /^[A-Za-z]:\\/.test(value) &&
    !value.includes("/") && !/[\p{Cc}\p{Cf}\p{Cs}]/u.test(value) && !/[:<>"|?*]/.test(value.slice(2)) && path.normalize(value) === value &&
    value.slice(3).split("\\").every(part => !!part && part !== "." && part !== ".." && !/[. ]$/.test(part));
  const suffix = `\\Packages\\${name}\\AC`;
  if (typeof folder !== "string" || !ordinary(folder) || !folder.toLowerCase().endsWith(suffix.toLowerCase())) return poison(s);
  const base = folder.slice(0, -suffix.length);
  if (!ordinary(base)) return poison(s);
  unaliased((folder.length + 1) * 2);
  held.attempted = true;
  if (call(s, "CoTaskMemFree", [raw]) !== undefined) return poison(s);
  held.freed = true; return base;
}
function nullInput(s: State, input: Owned): void {
  if (call(s, "GetFileType", [input.raw]) !== 2) return poison(s); flags(s, input, 0);
  const information = freshBuffer(s, 4096), returned = freshBuffer(s, 4);
  if (call(s, "NtQueryObject", [input.raw, 1, information, information.length, returned]) !== 0) return poison(s);
  const bytes = returned.readUInt32LE(0), length = information.readUInt16LE(0), maximum = information.readUInt16LE(2);
  const address = s.native.address(information), pointerValue = information.readBigUInt64LE(8);
  if (!pointer(address) || bytes < 16 || bytes > information.length || length === 0 || length % 2 || maximum < length || maximum % 2 ||
      pointerValue < address + 16n || pointerValue + BigInt(maximum) > address + BigInt(bytes) || pointerValue % 2n) return poison(s);
  const start = Number(pointerValue - address);
  if (information.subarray(start, start + length).toString("utf16le").toLowerCase() !== "\\device\\null") return poison(s);
  // Read only after proving the exact null device; another character device could block or read real input.
  const probe = freshBuffer(s, 1), count = freshBuffer(s, 4); ok(s, "ReadFile", [input.raw, probe, 1, count, null]);
  if (count.readUInt32LE(0) !== 0) return poison(s);
  for (const buffer of [probe, count, information, returned]) release(s, buffer);
}
/** The only cleanup allowed inside a failed inheritance interval is restoring these known, still-open flags. */
function createWithInheritance(s: State, inherited: Owned[], args: unknown[], information: Buffer): unknown {
  usable(s); if (s.universe.busy) return poison(s);
  s.universe.busy = true;
  s.creation = args;
  let result: unknown, error: unknown, failed = false;
  const checked = (value: unknown) => { if (!bool(value) || value === 0) throw refusal(); };
  const checkFlags = (value: Owned, expected: number) => {
    const bytes = freshBuffer(s, 4); checked(s.fn.GetHandleInformation(value.raw, bytes));
    if (bytes.readUInt32LE(0) !== expected) throw refusal();
  };
  try {
    for (const value of inherited) {
      checkFlags(value, 0); if (s.universe.failure) throw s.universe.failure;
      checked(s.fn.SetHandleInformation(value.raw, 1, 1)); if (s.universe.failure) throw s.universe.failure;
      checkFlags(value, 1); if (s.universe.failure) throw s.universe.failure;
    }
    result = s.fn.CreateProcessW(...args);
    if (s.universe.failure) throw s.universe.failure;
    const process = information.readBigUInt64LE(0);
    if (bool(result) && result !== 0 && pointer(process) && !s.universe.handles.has(process)) {
      s.root = Object.freeze({ process, thread: information.readBigUInt64LE(8), pid: information.readUInt32LE(16) });
    }
  } catch (caught) { failed = true; error = caught; }
  finally {
    // Restoration does not close a handle or claim creation completion. Try each exact known owner once.
    for (const value of inherited) try { checked(s.fn.SetHandleInformation(value.raw, 1, 0)); checkFlags(value, 0); }
    catch (caught) { failed = true; error ??= caught; }
    s.universe.busy = false;
  }
  if (failed || s.universe.failure) return poison(s, error);
  return result;
}
function stateFor(ref: unknown): State {
  if (!ref || typeof ref !== "object") throw refusal(); const s = launches.get(ref); if (!s) throw refusal(); usable(s); return s;
}

/** Genuine returned PI, available only to trusted lifecycle code; never a model/IPC field. */
export function requireWindowsCommandOutputLaunch(ref: WindowsCommandOutputLaunchRef): Readonly<{ root: Readonly<WindowsSuspendedProcess>; profile: WindowsCommandCreatorProfileRef; context: WindowsCommandRootOnlyLaunchContext; handles: readonly bigint[]; signal: AbortSignal }> {
  const s = stateFor(ref); if (!s.root || !s.launch || !s.context) throw refusal();
  return Object.freeze({ root: s.root, profile: s.profile, context: s.context, handles: Object.freeze(s.owned.filter(value => !value.closed).map(value => value.raw)), signal: s.controller.signal });
}
/** Called only with the genuine non-consuming live Stop match, after the exact returned PI was checked. */
export function activateWindowsCommandOutput(ref: WindowsCommandOutputLaunchRef, match: WindowsCommandRootOnlyOutputMatchRef): void {
  const s = stateFor(ref); requireWindowsCommandRootOnlyOutputMatch(match, ref);
  if (s.matched || !s.root) throw refusal(); s.matched = match; s.delegated = true;
  const stdin = s.owned.find(value => !s.streams.some(stream => stream.server === value || stream.writer === value || stream.event === value));
  if (!stdin) return poison(s);
  for (const value of [...s.streams.map(stream => stream.writer), stdin]) close(s, value);
  for (const stream of s.streams) { read(s, stream); if (s.controller.signal.aborted) return; }
  s.timer = setTimeout(() => stop(s, "timeout"), s.options.timeoutMs);
  schedule(s);
}
export function requireWindowsCommandOutputClosed(ref: unknown, launch: WindowsCommandOutputLaunchRef, run: WindowsCommandRootOnlyRunRef): Readonly<WindowsCommandOutputFacts> {
  if (!ref || typeof ref !== "object") throw refusal(); const value = closures.get(ref);
  if (!value || value.launch !== launch || value.run !== run) throw refusal(); return value.facts;
}
/** Quarantine only. This issues no Stop, close or publication authority and never disposes an uncertain owner. */
export function retainWindowsCommandOutput(ref: unknown): void {
  if (!ref || typeof ref !== "object") return; const s = launches.get(ref); if (!s) return;
  try { poison(s); } catch { /* The private universe retains the first failure and every owner. */ }
}
/** Called immediately after genuine Stop closes the held PI, before another native factory can reuse its numbers. */
export function releaseWindowsCommandOutputPI(ref: WindowsCommandOutputLaunchRef, stopped: unknown): void {
  requireWindowsCommandRootOnlyOutputStoppedLaunch(stopped, ref);
  const s = launches.get(ref); if (!s?.root || s.piReleased) return;
  s.universe.handles.delete(s.root.process); s.universe.handles.delete(s.root.thread); s.piReleased = true;
}

function accept(s: State, stream: Stream, count: unknown): void {
  if (!dword(count) || count > CHUNK) return poison(s);
  if (count === 0) return; // A successful zero-byte operation is not proof that every writer closed.
  const total = s.streams.reduce((sum, value) => sum + value.count, 0);
  if (stream.count + count > LIMIT || total + count > LIMIT) { stop(s, "overflow"); return; }
  if (s.reason !== "none") return; // After cancellation, drain fixed buffers without publishing more bytes.
  stream.count += count;
  const bytes = readMemory(s, stream.bytes, count);
  try { const delivered: unknown = s.options.output(bytes, stream.kind); if (delivered !== undefined) {
    stop(s, "delivery"); if (delivered instanceof Promise) void delivered.catch(() => undefined);
  } }
  catch { stop(s, "delivery"); }
  usable(s);
}
function finishRead(s: State, stream: Stream, returned: unknown): void {
  if (!bool(returned)) return poison(s);
  if (returned === 0) { const code = last(s); if (code === IO_PENDING) { stream.pending = true; return; } if (code === BROKEN_PIPE) { stream.pending = false; stream.eof = true; return; } return poison(s); }
  stream.pending = true; // Even synchronous overlapped completion is observed through GetOverlappedResult.
}
function read(s: State, stream: Stream): void {
  usable(s); if (stream.pending || stream.eof) return;
  if (stream.ov.freed || stream.bytes.freed || stream.ov.size !== 32 || stream.bytes.size !== CHUNK) return poison(s);
  ok(s, "ResetEvent", [stream.event.raw]); const header = Buffer.alloc(32); header.writeBigUInt64LE(stream.event.raw, 24); writeMemory(s, stream.ov, header); header.fill(0);
  stream.pending = true;
  const result = call(s, "ReadFile", [stream.server.raw, stream.bytes.raw, CHUNK, null, stream.ov.raw]);
  finishRead(s, stream, result);
}
function poll(s: State, stream: Stream): void {
  if (!stream.pending) { read(s, stream); return; }
  const count = freshBuffer(s, 4), result = call(s, "GetOverlappedResult", [stream.server.raw, stream.ov.raw, count, 0]);
  if (count.length !== 4 || stream.ov.freed || stream.bytes.freed) return poison(s);
  if (!bool(result)) return poison(s);
  if (result === 0) {
    const code = last(s);
    if (code === IO_INCOMPLETE) { release(s, count); return; }
    if (code === BROKEN_PIPE) { stream.pending = false; stream.eof = true; release(s, count); return; }
    if (code === ABORTED && stream.cancelling) { stream.pending = false; stream.cancelling = false; release(s, count); return; }
    return poison(s);
  }
  stream.pending = false; stream.cancelling = false; accept(s, stream, count.readUInt32LE(0)); release(s, count);
}
function schedule(s: State): void {
  if (s.pump || s.closed || s.universe.failure) return;
  s.pump = setTimeout(() => {
    s.pump = undefined;
    try { for (const stream of s.streams) if (!stream.eof) poll(s, stream); for (const wake of s.notify) wake(); if (s.streams.some(stream => !stream.eof)) schedule(s); }
    catch (error) { try { poison(s, error); } catch { /* No ambiguous operation is retried or disposed. */ } }
  }, 5);
}

/** Native ABI/lifecycle test seam. Production supplies the actual host SID and sealed fresh profile. No external handle is accepted. */
export function bindWindowsCommandOutputNative(native: NativeMemoryApi, load: Loader,
  profile: WindowsCommandCreatorProfileRef, host: { readonly ownerSid: string }, options: WindowsCommandOutputOptions,
  fence: WindowsCommandOutputFence = defaultFence, clock: () => number = () => performance.now()): WindowsCommandOutputOwner {
  let u = universes.get(fence); if (!u) { u = { busy: false, owners: new Set(), handles: new Set() }; universes.set(fence, u); }
  if (u.failure) throw u.failure;
  if (!(options?.signal instanceof AbortSignal) || typeof options.output !== "function" || !Number.isInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 20 * 60_000 || options.signal.aborted) throw refusal();
  const bound = windowsCommandCreatorProfile(profile), ownerSid = host.ownerSid;
  if (!/^S-1-5-(?:\d+-)*\d+$/.test(ownerSid)) throw refusal();
  const s: State = { universe: u, fence, fn: {}, native, load, libraries: [], profile, borrowedSid: bound.sid, ownerSid,
    options: { signal: options.signal, timeoutMs: options.timeoutMs, output: options.output.bind(options) }, controller: new AbortController(), reason: "none",
    owned: [], buffers: new Set(), allocations: new Set(), streams: [], clock, descriptorAttempted: false, delegated: false, terminateAttempted: false, piReleased: false, creating: false, closed: false,
    abort: () => stop(s, "cancelled"), notify: new Set() };
  u.owners.add(s); options.signal.addEventListener("abort", s.abort, { once: true });
  try {
    if (native.sizeof("void *") !== 8 || native.sizeof("uint32_t") !== 4 || native.sizeof("int") !== 4 || native.sizeof("size_t") !== 8) poison(s);
    if (u.busy) return poison(s); u.busy = true;
    for (const [library, prototypes] of Object.entries(WINDOWS_COMMAND_OUTPUT_FUNCTIONS)) { const dll = load(`${library}.dll`); s.libraries.push(dll); usable(s); for (const prototype of prototypes) { const fn = dll.func(prototype); usable(s); if (typeof fn !== "function") poison(s); s.fn[/\b(\w+)\s*\(/.exec(prototype)![1]] = fn as Fn; } }
  } catch (error) { return poison(s, error); }
  finally { u.busy = false; }
  return Object.freeze({
    signal: s.controller.signal,
    closeUnused() {
      if (s.universe.busy) return poison(s);
      if (s.universe.failure || s.fence.failure) return poison(s); if (s.closed) return;
      if (s.creating || s.launch || s.owned.length) throw refusal();
      s.options.signal.removeEventListener("abort", s.abort); s.closed = true; s.universe.owners.delete(s);
    },
    createSuspended(context: WindowsCommandRootOnlyLaunchContext, program: string, command: Buffer): WindowsCommandOutputLaunchRef {
      if (s.universe.busy) return poison(s);
      usable(s); if (s.creating || s.launch || s.controller.signal.aborted) throw refusal();
      const directory = windowsCommandRootOnlyLaunchDirectory(context);
      if (typeof program !== "string" || !/^[A-Za-z]:\\/.test(program) || program.length > 4096 || /[\0\r\n]/.test(program) ||
          !Buffer.isBuffer(command) || command.length < 4 || command.length > 64 * 1024 || command.length % 2 || command.readUInt16LE(command.length - 2) !== 0) throw refusal();
      for (let offset = 0; offset < command.length - 2; offset += 2) if (command.readUInt16LE(offset) === 0) throw refusal();
      s.creating = true;
      s.context = context;
      try {
        if (windowsCommandCreatorProfile(profile) !== bound) throw refusal();
        const descriptor = freshBuffer(s, 8);
        ok(s, "ConvertStringSecurityDescriptorToSecurityDescriptorW", [`O:${ownerSid}G:${ownerSid}D:P(A;;FA;;;SY)(A;;FA;;;${ownerSid})S:(ML;;NW;;;LW)`, 1, descriptor, null]);
        const sd = descriptor.readBigUInt64LE(0); if (!pointer(sd) || s.universe.handles.has(sd)) return poison(s); s.descriptor = sd;
        const security = freshBuffer(s, 24); security.writeUInt32LE(24); security.writeBigUInt64LE(sd, 8);
        const stdin = own(s, call(s, "CreateFileW", ["\\\\?\\GLOBALROOT\\Device\\Null", 0x80000000, 3, null, 3, 0, null]));
        nullInput(s, stdin);
        for (const kind of ["stdout", "stderr"] as const) {
          const name = `\\\\.\\pipe\\LOCAL\\ember-output-${randomUUID()}-${kind}`;
          const server = own(s, call(s, "CreateNamedPipeW", [name, 0x40080001, 8, 1, CHUNK, CHUNK, 0, security]));
          const event = own(s, call(s, "CreateEventW", [null, 1, 0, null])), ov = allocate(s, 32), bytes = allocate(s, CHUNK);
          const header = Buffer.alloc(32); header.writeBigUInt64LE(event.raw, 24); writeMemory(s, ov, header); header.fill(0);
          const connection = call(s, "ConnectNamedPipe", [server.raw, ov.raw]);
          if (!bool(connection)) return poison(s);
          if (connection === 0 && last(s) !== IO_PENDING) return poison(s);
          const writer = own(s, call(s, "CreateFileW", [name, 0x40000000, 0, security, 3, 0, null]));
          for (const value of [server, writer]) { if (call(s, "GetFileType", [value.raw]) !== 3) return poison(s); flags(s, value, 0); } flags(s, event, 0);
          const connected = freshBuffer(s, 4); ok(s, "GetOverlappedResult", [server.raw, ov.raw, connected, 0]); release(s, connected);
          s.streams.push({ kind, server, writer, event, ov, bytes, count: 0, pending: false, eof: false, cancelling: false });
        }
        s.descriptorAttempted = true; if (call(s, "LocalFree", [sd]) !== null) return poison(s); s.descriptor = undefined; release(s, descriptor); release(s, security);
        const required = freshBuffer(s, 8), sizing = call(s, "InitializeProcThreadAttributeList", [null, 3, 0, required]);
        if (sizing !== 0 || last(s) !== 122) return poison(s);
        const length = Number(required.readBigUInt64LE(0)); if (!Number.isInteger(length) || length < 1 || length > 65536) return poison(s);
        const attributes = allocate(s, length); ok(s, "InitializeProcThreadAttributeList", [attributes.raw, 3, 0, required]);
        const capabilities = allocate(s, 24), capBytes = Buffer.alloc(24); capBytes.writeBigUInt64LE(bound.sid); writeMemory(s, capabilities, capBytes); capBytes.fill(0);
        const policy = allocate(s, 4), policyBytes = Buffer.alloc(4); policyBytes.writeUInt32LE(1); writeMemory(s, policy, policyBytes); policyBytes.fill(0);
        const list = allocate(s, 24), listBytes = Buffer.alloc(24), inherited = [stdin, ...s.streams.map(stream => stream.writer)]; inherited.forEach((value, index) => listBytes.writeBigUInt64LE(value.raw, index * 8)); writeMemory(s, list, listBytes); listBytes.fill(0);
        for (const [key, memory] of [[0x20009, capabilities], [0x2000f, policy], [0x20002, list]] as const) ok(s, "UpdateProcThreadAttribute", [attributes.raw, 0, key, memory.raw, memory.size, null, null]);
        const startup = freshBuffer(s, 112); startup.writeUInt32LE(112); startup.writeUInt32LE(0x100, 60); startup.writeBigUInt64LE(stdin.raw, 80);
        startup.writeBigUInt64LE(s.streams[0].writer.raw, 88); startup.writeBigUInt64LE(s.streams[1].writer.raw, 96); startup.writeBigUInt64LE(attributes.address!, 104);
        const windows = freshBuffer(s, 32768 * 2), size = call(s, "GetWindowsDirectoryW", [windows, 32768]);
        if (!dword(size) || size < 3 || size >= 32768) return poison(s);
        const systemRoot = windows.subarray(0, size * 2).toString("utf16le"); if (!/^[A-Za-z]:\\/.test(systemRoot) || /[\0\r\n]/.test(systemRoot)) return poison(s);
        const local = profileLocalAppData(s, bound.name, bound.sidText);
        const env = Buffer.from(`LOCALAPPDATA=${local}\0PATH=\0SystemRoot=${systemRoot}\0TEMP=${directory}\0TMP=${directory}\0\0`, "utf16le"); s.buffers.add(env);
        const line = Buffer.from(command); s.buffers.add(line); const information = freshBuffer(s, 24);
        const result = createWithInheritance(s, inherited, [program, line, null, null, 1, 0x0008040c, env, directory, startup, information], information);
        const process = information.readBigUInt64LE(0), thread = information.readBigUInt64LE(8), pid = information.readUInt32LE(16);
        if (!bool(result) || result === 0 || !pointer(process) || !pointer(thread) || process === thread || !pid || s.universe.handles.has(process) || s.universe.handles.has(thread)) return poison(s);
        s.universe.handles.add(process); s.universe.handles.add(thread);
        if (call(s, "DeleteProcThreadAttributeList", [attributes.raw]) !== undefined) return poison(s);
        for (const memory of [list, policy, capabilities, attributes]) freeMemory(s, memory);
        for (const buffer of [...s.buffers]) release(s, buffer);
        const ref = Object.freeze({ scope: "native-output-launch" as const }) as WindowsCommandOutputLaunchRef; s.launch = ref; launches.set(ref, s); return ref;
      } catch (error) { return poison(s, error); }
    },
    closeOutputAfterStopped(completed: WindowsCommandRootOnlyCompletedRef, run: WindowsCommandRootOnlyRunRef): Promise<WindowsCommandOutputClosedRef> {
      if (s.universe.busy) return poison(s);
      if (s.universe.failure || s.fence.failure) return poison(s); if (!s.launch || !s.matched) return Promise.reject(refusal());
      const completion = requireWindowsCommandRootOnlyCompletedOutput(completed, run, s.launch);
      if (!s.piReleased) { s.universe.handles.delete(s.root!.process); s.universe.handles.delete(s.root!.thread); s.piReleased = true; }
      if (s.closing) return s.closing;
      usable(s);
      if (completion.outcome !== "natural-exit" && s.reason === "none") stop(s, "cancelled");
      if (s.reason !== "none") for (const stream of s.streams) if (stream.pending) {
        stream.cancelling = true;
        const cancelled = call(s, "CancelIoEx", [stream.server.raw, stream.ov.raw]);
        if (!bool(cancelled) || cancelled === 0 && last(s) !== 1168) return poison(s);
      }
      if (s.timer) clearTimeout(s.timer); s.timer = undefined;
      let previous: number; try { previous = s.clock(); } catch (error) { return poison(s, error); }
      if (!Number.isFinite(previous) || previous < 0) return poison(s);
      const deadline = previous + 15_000;
      const within = () => { let now: number; try { now = s.clock(); } catch (error) { return poison(s, error); }
        if (!Number.isFinite(now) || now < previous || now > deadline) return poison(s); previous = now;
      };
      s.closing = Promise.resolve().then(async () => {
        try {
          for (;;) {
            usable(s); within(); requireWindowsCommandRootOnlyCompletedOutput(completed, run, s.launch!);
            if (s.streams.every(stream => stream.eof && !stream.pending)) break;
            await new Promise<void>(resolve => { const timer = setTimeout(finish, 5); const wake = () => finish(); function finish() { clearTimeout(timer); s.notify.delete(wake); resolve(); } s.notify.add(wake); });
          }
          if (s.pump) clearTimeout(s.pump); s.pump = undefined;
          for (const value of s.owned.slice().reverse()) { close(s, value); within(); }
          for (const memory of [...s.allocations].reverse()) { freeMemory(s, memory); within(); }
          for (const buffer of [...s.buffers]) release(s, buffer);
          const ref = Object.freeze({ scope: "native-output-closed" as const }) as WindowsCommandOutputClosedRef;
          const facts = Object.freeze({ stdoutBytes: s.streams[0].count, stderrBytes: s.streams[1].count, reason: s.reason, complete: s.reason === "none" });
          closures.set(ref, { launch: s.launch!, run, facts }); s.closed = true; s.options.signal.removeEventListener("abort", s.abort); s.universe.owners.delete(s); return ref;
        } catch (error) { return poison(s, error); }
      });
      return s.closing;
    },
  });
}

export function createWindowsCommandOutput(profile: WindowsCommandCreatorProfileRef, options: WindowsCommandOutputOptions): WindowsCommandOutputOwner {
  if (HOST_PLATFORM !== "win32" || HOST_ARCH !== "x64") throw refusal();
  try {
    const native = createRequire(__filename)("koffi") as typeof Koffi;
    return bindWindowsCommandOutputNative(native, name => native.load(name), profile, loadWindowsCodingNative(), options);
  } catch (error) { if (error instanceof WindowsCommandOutputCleanupError) throw error; throw new WindowsCommandOutputCleanupError(); }
}
