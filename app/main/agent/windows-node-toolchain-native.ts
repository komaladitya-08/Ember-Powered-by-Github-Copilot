/** Disabled fixed Node assets. Only a fresh RX/Low copy is executable; packaged originals never receive grants. */
import path from "node:path/win32";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type * as Koffi from "koffi";
import manifest from "../../shared/windows-node-toolchain.json";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import { copyNodeArgv } from "../commands/node-invocation";
import { ScopedCodingFileError } from "./coding-platform";
import { WindowsCodingCleanupError, decodeWindowsCodingDirectoryBatch, type WindowsCodingInfo } from "./windows-coding-native";
import { windowsCodingRelative, windowsCodingSame, windowsCodingWithin } from "./windows-coding-policy";
import { windowsCommandCreatorProfile, bindWindowsCommandCreatorAssets, requireWindowsCommandCreatorAssets,
  releaseWindowsCommandCreatorAssets, type WindowsCommandCreatorProfileRef } from "./windows-command-creator-profile";
import { createWindowsCommandOutput, requireWindowsCommandOutputLaunch, requireWindowsCommandOutputClosed, requireWindowsCommandOutputActive,
  retainWindowsCommandOutput, type WindowsCommandOutputOwner, type WindowsCommandOutputOptions,
  type WindowsCommandOutputLaunchRef, type WindowsCommandOutputClosedRef } from "./windows-command-output";
import { requireWindowsCommandRootOnlyCompletedOutput, requireWindowsCommandRootOnlyLaunchMetadata, windowsCommandRootOnlyLaunchDirectory,
  type WindowsCommandRootOnlyLaunchContext, type WindowsCommandRootOnlyCompletedRef, type WindowsCommandRootOnlyRunRef } from "./windows-command-copy";
import { requireWindowsCommandRootOnlyAttestingCurrent, requireWindowsCommandRootOnlyTokenHandle,
  requireWindowsCommandRootOnlyReturned, type WindowsCommandRootOnlyReturnedRef, type WindowsCommandRootOnlyAttestingRef } from "./windows-command-stop";
import { issueWindowsCommandLaunchCancellation, readConsumedWindowsCommandLaunchCancellation, type WindowsCommandLaunchCancellationRef } from "./windows-command-launch-cancel";

type DisposalFailure = Readonly<{ stage: number; object: number; operation: number; predicate: number; result: number }>;
const disposalFailures = new WeakMap<object, DisposalFailure>();
export class WindowsNodeToolchainCleanupError extends WindowsCodingCleanupError {
  constructor() { super(); this.name = "WindowsNodeToolchainCleanupError"; this.message = "Windows coding Node assets could not be verified; retain their native owners."; }
  /** First disposal observation only. Constructed, foreign and serialized errors have no diagnostic authority. */
  static failure(error: unknown): DisposalFailure | undefined { return typeof error === "object" && error !== null ? disposalFailures.get(error) : undefined; }
}
export interface WindowsNodeToolchainFence { failure?: WindowsNodeToolchainCleanupError; retained: unknown[] }
export interface WindowsNodeToolchainInput {
  resourcesPath: string; privateParent: string; profile: WindowsCommandCreatorProfileRef; signal: AbortSignal;
  /** Task admission only, never native ownership, asset identity or Stop authority. */
  current(): boolean;
}
export interface WindowsNodeToolchainOwner {
  createSuspended(context: WindowsCommandRootOnlyLaunchContext, argv: readonly string[], options: WindowsCommandOutputOptions): WindowsCommandOutputLaunchRef;
  finishOutput(completed: WindowsCommandRootOnlyCompletedRef, run: WindowsCommandRootOnlyRunRef, launch: WindowsCommandOutputLaunchRef): Promise<WindowsCommandOutputClosedRef>;
  close(): Promise<void>;
}
type Fn = (...args: unknown[]) => unknown;
type Loader = (name: string) => { func(prototype: string): unknown };
type Native = Pick<typeof Koffi, "sizeof" | "address" | "decode">;
type Handle = { raw: bigint; attempted: boolean; closed: boolean };
type Allocation = { raw: bigint; size?: number; attempted: boolean; freed: boolean };
type File = { handle: Handle; identity: WindowsCodingInfo; parent: bigint | null; name: string };
type Use = { state: State; io: WindowsCommandOutputOwner; launch: WindowsCommandOutputLaunchRef; context: WindowsCommandRootOnlyLaunchContext; binding: object; serial: number;
  attested: boolean; finished: boolean; cancellation?: WindowsCommandLaunchCancellationRef };
type CancellationEvidence = Readonly<{ phase: "empty" | "held"; context: WindowsCommandRootOnlyLaunchContext; profile: WindowsCommandCreatorProfileRef;
  point: "creating" | "returned" | "attesting"; serial: number; launch?: WindowsCommandOutputLaunchRef; witness?: WindowsCommandRootOnlyAttestingRef | WindowsCommandRootOnlyReturnedRef }>;
type Universe = { failure?: WindowsNodeToolchainCleanupError; busy: boolean; owners: Set<State>; handles: Set<bigint>; allocations: Set<bigint> };
type State = {
  u: Universe; fence: WindowsNodeToolchainFence; native: Native; fn: Record<string, Fn>; libraries: unknown[]; pending: Set<unknown>; buffers: Set<Buffer>;
  input: WindowsNodeToolchainInput; profile: ReturnType<typeof windowsCommandCreatorProfile>; key: object; bound: boolean; ownerSid?: string;
  handles: Handle[]; allocations: Allocation[]; pins: File[]; source: File[]; parent?: File; root?: File; image?: File;
  rootLock?: File; imageLock?: File; imagePath?: string; use?: Use; ready: boolean; retired: boolean; creating: boolean; closed: boolean; closing?: Promise<void>;
  createOutput: typeof createWindowsCommandOutput;
  serial: number; nativeEntries: Set<number>; cancellation?: CancellationEvidence;
  attesting?: { ref: WindowsCommandRootOnlyAttestingRef; binding: object };
  disposal?: { stage: number; object: number; operation: number; predicate: number; result: number };
};
const universes = new WeakMap<WindowsNodeToolchainFence, Universe>(), processFence: WindowsNodeToolchainFence = { retained: [] };
const uses = new WeakMap<object, Use>();
const returnedUses = new WeakMap<object, Use>();
const assetKeys = new WeakMap<object, State>();
const CHUNK = 64 * 1024, MAX_NODE = 128 * 1024 * 1024, READ = 0x120089, DIR = 0x1200a9, META = 0x120080, ALL = 0x1f01ff;
const DELETE = 0x10000, WRITE_DAC = 0x40000, WRITE_OWNER = 0x80000, OWNER_RIGHTS = "S-1-3-4", SPECIAL = 0x5640 | 0x40000 | 0x400000;
const pointer = (v: unknown): v is bigint => typeof v === "bigint" && v > 0n && v < 0x8000000000000000n;
const uint = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= 0xffffffff;
const boolean = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= -0x80000000 && v <= 0x7fffffff && v !== 0;
const refuse = () => new Error("The fixed Windows coding Node toolchain is unavailable.");
class PreparationCancelled extends ScopedCodingFileError { constructor() { super("cancelled"); } }

// Fixed disposal sites only; neither the observation nor this reader decides ownership or cleanup.
const DISPOSAL_OPERATIONS = ["GetFileType", "GetFileInformationByHandle", "GetFileInformationByHandleEx", "GetFinalPathNameByHandleW", "NtQueryInformationFile",
  "GetSecurityInfo", "GetSecurityDescriptorLength", "ConvertSidToStringSidW", "GetSecurityDescriptorControl", "GetAclInformation", "GetAce", "GetSecurityDescriptorSacl",
  "LocalFree", "NtCreateFile", "GetHandleInformation", "NtQueryObject", "NtSetInformationFile", "CloseHandle"] as const;
const DISPOSAL_PREDICATES = [0, 1, 2, 6, 2, 3, 6, 2, 4, 7, 6, 6, 6, 8, 9] as const;
function disposalSite(s: State, stage: number, object: number): void {
  try { s.disposal = { stage, object, operation: 0, predicate: DISPOSAL_PREDICATES[stage], result: 0 }; }
  catch { /* Diagnostic storage cannot change the existing cleanup path. */ }
}
function disposalOperation(s: State, name?: string): void {
  try { if (s.disposal) { s.disposal.operation = name === undefined ? 0 : DISPOSAL_OPERATIONS.indexOf(name as typeof DISPOSAL_OPERATIONS[number]) + 1;
    s.disposal.predicate = DISPOSAL_PREDICATES[s.disposal.stage]; s.disposal.result = 0; } }
  catch { /* A missing observation cannot replace a native outcome. */ }
}
function disposalRejected(s: State, predicate: number, result = 0): void {
  try { if (s.disposal) { s.disposal.predicate = predicate; s.disposal.result = result; } }
  catch { /* Preserve the first authoritative failure even if observation fails. */ }
}
function disposalResult(name: string, value: unknown): number {
  try {
    if (typeof value !== "number" || !Number.isInteger(value) || value < -0x80000000 || value > 0xffffffff) return 7;
    if (value === 0) return 1;
    if (name.startsWith("Nt")) {
      const known = [0xc0000022, 0xc0000043, 0xc0000121, 0xc0000056].indexOf(value >>> 0); if (known >= 0) return known + 2;
    }
    return 6;
  } catch { return 0; /* No result-classification fault can replace the original native refusal. */ }
}
function observeDisposalFailure(s: State, error: WindowsNodeToolchainCleanupError): void {
  try {
    const d = s.disposal; if (!d) return;
    const values = [d.stage, d.object, d.operation, d.predicate, d.result], maxima = [14, 5, 18, 9, 7];
    if (values.some((value, index) => !Number.isInteger(value) || value < 0 || value > maxima[index])) return;
    disposalFailures.set(error, Object.freeze({ stage: d.stage, object: d.object, operation: d.operation, predicate: d.predicate, result: d.result }));
  } catch { /* Passive diagnostics must not replace the fixed error or its quarantine. */ }
}

/** Only a real prepared asset owner's private key can authenticate known cancellation without native uncertainty. */
export function readWindowsNodeToolchainCancellation(key: object): CancellationEvidence {
  const s = assetKeys.get(key); if (!s?.cancellation) throw refuse(); usable(s);
  const evidence = s.cancellation;
  if (!s.retired || s.u.busy || s.pending.size || s.allocations.some(a => !a.freed) || s.handles.some(h => !h.closed &&
      ![...s.pins, ...s.source, s.parent, s.root, s.image, s.rootLock, s.imageLock].some(f => f?.handle === h))) throw refuse();
  if (evidence.phase === "empty") {
    if (s.nativeEntries.has(evidence.serial) || s.use && !s.use.finished) throw refuse();
  } else {
    if (!evidence.launch || s.use?.launch !== evidence.launch || evidence.point === "attesting" && s.use.attested || s.use.finished ||
        s.use.serial !== evidence.serial || returnedUses.get(s.use.binding) !== s.use || !s.nativeEntries.has(evidence.serial)) throw refuse();
    const actual = requireWindowsCommandOutputLaunch(evidence.launch);
    if (evidence.point === "attesting") requireWindowsCommandOutputActive(evidence.launch);
    if (actual.context !== evidence.context || actual.profile !== evidence.profile) throw refuse();
  }
  return evidence;
}
function claimCancellation(s: State, evidence: CancellationEvidence): WindowsCommandLaunchCancellationRef {
  if (s.cancellation) return poison(s); s.cancellation = Object.freeze(evidence);
  let claim: WindowsCommandLaunchCancellationRef;
  try { claim = issueWindowsCommandLaunchCancellation(s.key); } catch (error) { return poison(s, error); }
  if (evidence.phase === "held") s.use!.cancellation = claim;
  s.attesting = undefined;
  return claim;
}
function cancelLaunch(s: State, evidence: CancellationEvidence): never { throw claimCancellation(s, evidence); }
/** Registry observation only; no caller can register a binding or substitute an asset/PI. */
export function registeredWindowsNodeToolchainOutput(binding: object): WindowsCommandOutputLaunchRef | undefined {
  const use = returnedUses.get(binding); if (!use) return undefined; usable(use.state);
  if (use.finished || use.state.use !== use) throw refuse(); return use.launch;
}
/** Called only with Stop's exact identity-checked held root, before any Resume attempt. */
export function probeWindowsNodeToolchainReturnedCancellation(ref: WindowsCommandRootOnlyReturnedRef): WindowsCommandLaunchCancellationRef | undefined {
  const held = requireWindowsCommandRootOnlyReturned(ref), use = returnedUses.get(held.binding); if (!use) return undefined;
  const s = use.state; usable(s); const actual = requireWindowsCommandOutputLaunch(use.launch);
  if (use !== s.use || use.finished || use.context !== actual.context || use.binding !== held.binding || actual.profile !== s.input.profile ||
      held.root.process !== actual.root.process || held.root.thread !== actual.root.thread || held.root.pid !== actual.root.pid) return poison(s);
  for (const raw of [...actual.heldPiHandles, ...actual.handles]) {
    if (s.u.handles.has(raw) || s.u.allocations.has(raw)) return poison(s);
    for (const other of s.u.owners) if (raw >= other.profile.sid && raw < other.profile.sid + 40n ||
        other.allocations.some(a => !a.freed && raw >= a.raw && raw < a.raw + BigInt(a.size ?? 1))) return poison(s);
  }
  try { active(s); return undefined; } catch (error) {
    if (!(error instanceof PreparationCancelled) || s.u.failure || s.fence.failure) return poison(s, error);
    return claimCancellation(s, { phase: "held", point: "returned", context: use.context, profile: s.input.profile, serial: use.serial, launch: use.launch, witness: ref });
  }
}

export const WINDOWS_NODE_TOOLCHAIN_FUNCTIONS = {
  ntdll: [
    "int32_t __stdcall NtCreateFile(_Out_ void **file, uint32_t access, void *attributes, void *io, void *allocation, uint32_t fileAttributes, uint32_t share, uint32_t disposition, uint32_t options, void *ea, uint32_t eaLength)",
    "int32_t __stdcall NtQueryDirectoryFile(void *file, void *event, void *apc, void *context, void *io, void *information, uint32_t length, int kind, uint8_t single, void *name, uint8_t restart)",
    "int32_t __stdcall NtQueryInformationFile(void *file, void *io, void *information, uint32_t length, int kind)",
    "int32_t __stdcall NtReadFile(void *file, void *event, void *apc, void *context, void *io, void *bytes, uint32_t length, void *offset, void *key)",
    "int32_t __stdcall NtWriteFile(void *file, void *event, void *apc, void *context, void *io, void *bytes, uint32_t length, void *offset, void *key)",
    "int32_t __stdcall NtSetInformationFile(void *file, void *io, void *information, uint32_t length, int kind)",
    "int32_t __stdcall NtQueryObject(void *file, uint32_t kind, void *information, uint32_t length, _Out_ uint32_t *returned)",
  ],
  kernel32: [
    "int __stdcall CloseHandle(void *handle)", "void * __stdcall LocalFree(void *memory)", "void * __stdcall GetCurrentProcess()",
    "uint32_t __stdcall GetFileType(void *file)", "int __stdcall GetHandleInformation(void *file, _Out_ uint32_t *flags)",
    "int __stdcall GetFileInformationByHandle(void *file, void *information)", "int __stdcall GetFileInformationByHandleEx(void *file, int kind, void *information, uint32_t length)",
    "uint32_t __stdcall GetFinalPathNameByHandleW(void *file, void *name, uint32_t length, uint32_t flags)",
    "uint32_t __stdcall GetDriveTypeW(const char16_t *root)", "int __stdcall GetVolumeInformationW(const char16_t *root, void *name, uint32_t nameLength, void *serial, void *componentLength, void *flags, void *filesystem, uint32_t filesystemLength)",
    "int __stdcall FlushFileBuffers(void *file)", "uint32_t __stdcall GetProcessId(void *process)",
    "int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *text, _Inout_ uint32_t *length)",
  ],
  advapi32: [
    "int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)",
    "int __stdcall DuplicateTokenEx(void *existing, uint32_t access, void *security, int level, int kind, _Out_ void **token)",
    "int __stdcall GetTokenInformation(void *token, int kind, void *information, uint32_t size, _Out_ uint32_t *returned)",
    "int __stdcall ConvertSidToStringSidW(void *sid, _Out_ void **text)",
    "int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *text, uint32_t revision, _Out_ void **descriptor, void *length)",
    "uint32_t __stdcall GetSecurityInfo(void *file, int kind, uint32_t information, _Out_ void **owner, _Out_ void **group, _Out_ void **dacl, _Out_ void **sacl, _Out_ void **descriptor)",
    "int __stdcall GetSecurityDescriptorControl(void *descriptor, _Out_ uint16_t *control, _Out_ uint32_t *revision)",
    "uint32_t __stdcall GetSecurityDescriptorLength(void *descriptor)",
    "int __stdcall GetSecurityDescriptorSacl(void *descriptor, _Out_ int *present, _Out_ void **acl, _Out_ int *defaulted)",
    "int __stdcall GetAclInformation(void *acl, void *information, uint32_t length, int kind)", "int __stdcall GetAce(void *acl, uint32_t index, _Out_ void **ace)",
    "int __stdcall AccessCheck(void *descriptor, void *token, uint32_t desired, void *mapping, void *privileges, _Inout_ uint32_t *privilegeSize, _Out_ uint32_t *granted, _Out_ int *allowed)",
  ],
} as const;

function poison(s: State, extra?: unknown): never {
  if (!s.u.failure) {
    s.u.failure = new WindowsNodeToolchainCleanupError(); s.fence.failure = s.u.failure;
    observeDisposalFailure(s, s.u.failure);
    for (const owner of s.u.owners) { owner.retired = true; owner.fence.retained.push({ owner, extra }); }
    for (const owner of s.u.owners) if (owner.use && !owner.use.finished) try { retainWindowsCommandOutput(owner.use.launch); } catch { /* The actual output owner retains and requests only exact-root termination. */ }
  }
  throw s.u.failure;
}
function usable(s: State): void {
  if (s.u.failure || s.fence.failure) poison(s); if (s.closed) throw refuse();
  if (s.bound) try { if (requireWindowsCommandCreatorAssets(s.input.profile, s.key) !== s.profile.sidText) poison(s); }
  catch (error) { return poison(s, error); }
}
function active(s: State): void {
  usable(s); let current = false;
  try { current = s.input.current() === true; }
  catch (error) { if (error instanceof WindowsCodingCleanupError) return poison(s, error); /* Ordinary admission loss retires work. */ }
  usable(s); if (s.retired || s.input.signal.aborted || !current) { s.retired = true; throw new PreparationCancelled(); }
}
function invoke(s: State, name: string, args: unknown[], accepted: (v: unknown) => boolean = boolean): unknown {
  usable(s); if (s.u.busy) { disposalRejected(s, 6); return poison(s); } s.u.busy = true;
  const pending = { name, args }; s.pending.add(pending);
  disposalOperation(s, name);
  try { const result = s.fn[name](...args); usable(s); if (!accepted(result)) { disposalRejected(s, 4, disposalResult(name, result)); return poison(s); }
    s.pending.delete(pending); disposalOperation(s); return result; }
  catch (error) { disposalRejected(s, 5); return poison(s, error); } finally { s.u.busy = false; }
}
function memory<T>(s: State, name: string, args: unknown[], action: () => T): T {
  usable(s); if (s.u.busy) { disposalRejected(s, 6); return poison(s); } s.u.busy = true; const pending = { name, args }; s.pending.add(pending); disposalOperation(s);
  try { const result = action(); usable(s); s.pending.delete(pending); return result; } catch (error) { disposalRejected(s, 5); return poison(s, error); } finally { s.u.busy = false; }
}
function buffer(s: State, size: number): Buffer { const b = Buffer.alloc(size); s.buffers.add(b); return b; }
function wipe(s: State, ...values: Buffer[]): void { usable(s); for (const b of values) { b.fill(0); s.buffers.delete(b); } }
function address(s: State, value: Buffer): bigint { const raw = memory(s, "address", [value], () => s.native.address(value)); if (!pointer(raw)) return poison(s); return raw; }
function decode(s: State, raw: bigint, size: number): Buffer {
  const value = memory(s, "decode", [raw, size], () => s.native.decode(raw, "uint8_t", size));
  if (!(value instanceof Uint8Array) && !Array.isArray(value) || value.length !== size) return poison(s);
  const b = Buffer.from(value as Uint8Array); s.buffers.add(b); return b;
}
function alias(s: State, raw: unknown, witness?: { ref: WindowsCommandRootOnlyAttestingRef; binding: object }): bigint {
  if (!pointer(raw) || s.u.handles.has(raw) || s.u.allocations.has(raw)) return poison(s);
  for (const other of s.u.owners) {
    if (raw >= other.profile.sid && raw < other.profile.sid + 40n || other.allocations.some(a => !a.freed && raw >= a.raw && raw < a.raw + BigInt(a.size ?? 1))) return poison(s);
    if (other.use && !other.use.finished) {
      const actual = requireWindowsCommandOutputLaunch(other.use.launch);
      if (actual.heldPiHandles.includes(raw) || actual.handles.includes(raw)) return poison(s);
    }
  }
  const live = witness ?? s.attesting;
  if (live) try { requireWindowsCommandRootOnlyTokenHandle(live.ref, live.binding, raw); } catch (error) { return poison(s, error); }
  return raw;
}
function takeHandle(s: State, out: unknown[], witness?: { ref: WindowsCommandRootOnlyAttestingRef; binding: object }): Handle {
  const raw = alias(s, out[0], witness), held = { raw, attempted: false, closed: false }; s.handles.push(held); s.u.handles.add(raw); return held;
}
function tokenHandle(s: State, out: unknown[], access: number, witness?: { ref: WindowsCommandRootOnlyAttestingRef; binding: object }): Handle {
  const held = takeHandle(s, out, witness), flags = [undefined], basic = buffer(s, 56), returned = [undefined];
  invoke(s, "GetHandleInformation", [held.raw, flags]); invoke(s, "NtQueryObject", [held.raw, 0, basic, basic.length, returned], v => v === 0);
  if (flags[0] !== 0 || returned[0] !== 56 || basic.readUInt32LE(4) !== access) return poison(s); wipe(s, basic); return held;
}
function allocateResult(s: State, name: string, args: unknown[], out: unknown[], success: (v: unknown) => boolean = boolean): Allocation {
  s.pending.add(out); invoke(s, name, args, success); const raw = alias(s, out[0]);
  const held = { raw, attempted: false, freed: false }; s.allocations.push(held); s.u.allocations.add(raw); s.pending.delete(out); return held;
}
function registerSpan(s: State, held: Allocation, size: number): void {
  if (!Number.isInteger(size) || size < 1 || size > 65536 || held.attempted || held.freed || !pointer(held.raw + BigInt(size) - 1n)) return poison(s);
  const end = held.raw + BigInt(size);
  for (const owner of s.u.owners) {
    if (held.raw < owner.profile.sid + 40n && owner.profile.sid < end) return poison(s);
    for (const handle of s.u.handles) if (handle >= held.raw && handle < end) return poison(s);
    for (const other of owner.allocations) if (other !== held && !other.freed && held.raw < other.raw + BigInt(other.size ?? 1) && other.raw < end) return poison(s);
  }
  held.size = size;
}
function close(s: State, held: Handle): void {
  usable(s); if (held.closed) return; if (held.attempted || !s.u.handles.has(held.raw)) return poison(s);
  held.attempted = true; invoke(s, "CloseHandle", [held.raw]); held.closed = true; s.u.handles.delete(held.raw);
}
function free(s: State, held: Allocation): void {
  usable(s); if (held.freed) return; if (held.attempted || !s.u.allocations.has(held.raw)) return poison(s);
  if (held.size === undefined) return poison(s); registerSpan(s, held, held.size);
  held.attempted = true; invoke(s, "LocalFree", [held.raw], v => v === null); held.freed = true; s.u.allocations.delete(held.raw);
}
function sidText(s: State, raw: bigint, limit?: bigint): string {
  const header = decode(s, raw, 8), size = 8 + header[1] * 4;
  if (header[0] !== 1 || header[1] < 1 || header[1] > 15 || limit !== undefined && raw + BigInt(size) > limit) return poison(s); wipe(s, header);
  const out: unknown[] = [undefined], text = allocateResult(s, "ConvertSidToStringSidW", [raw, out], out);
  const value = memory(s, "decode.string16", [text.raw], () => s.native.decode.string16(text.raw));
  if (typeof value !== "string" || value.length > 184 || !/^S-\d+(?:-\d+)+$/.test(value)) return poison(s);
  registerSpan(s, text, (value.length + 1) * 2);
  free(s, text); return value;
}
function ordinary(value: string): string {
  if (typeof value !== "string" || value.length > 4096 || !/^[A-Za-z]:\\/.test(value) || value.includes("/") || path.normalize(value) !== value || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(value)) throw refuse();
  const parts = value.slice(3).split("\\"); if (parts.length > 64) throw refuse();
  for (const part of parts) if (!part || windowsCodingRelative(part, false) !== part || part.includes("/")) throw refuse(); return value;
}
function open(s: State, parent: bigint | null, name: string, kind: "file" | "directory", access: number, share: number, descriptor?: bigint): Handle {
  const text = buffer(s, (name.length + 1) * 2); text.write(name, "utf16le"); const unicode = buffer(s, 16), attributes = buffer(s, 48), io = buffer(s, 16), out: unknown[] = [undefined];
  unicode.writeUInt16LE(text.length - 2); unicode.writeUInt16LE(text.length, 2); unicode.writeBigUInt64LE(address(s, text), 8);
  attributes.writeUInt32LE(48); if (parent !== null) attributes.writeBigUInt64LE(parent, 8); attributes.writeBigUInt64LE(address(s, unicode), 16); attributes.writeUInt32LE(0x1040, 24); if (descriptor) attributes.writeBigUInt64LE(descriptor, 32);
  s.pending.add(out); invoke(s, "NtCreateFile", [out, access, attributes, io, null, descriptor ? kind === "directory" ? 16 : 128 : 0, share, descriptor ? 2 : 1, 0x200020 | (kind === "directory" ? 1 : 0x40), null, 0], v => v === 0);
  const held = takeHandle(s, out); if (io.readUInt32LE(0) !== 0 || io.readBigUInt64LE(8) !== BigInt(descriptor ? 2 : 1)) return poison(s); s.pending.delete(out);
  const flags = [undefined], basic = buffer(s, 56), returned = [undefined]; invoke(s, "GetHandleInformation", [held.raw, flags]);
  invoke(s, "NtQueryObject", [held.raw, 0, basic, basic.length, returned], v => v === 0);
  const granted = basic.readUInt32LE(4);
  if (flags[0] !== 0 || returned[0] !== 56 || (granted & access) !== access || (granted & ~(access | 0x80 | 0x100000)) !== 0) return poison(s);
  wipe(s, text, unicode, attributes, io, basic); return held;
}
function info(s: State, held: Handle): WindowsCodingInfo {
  if (held.closed || held.attempted || invoke(s, "GetFileType", [held.raw], v => v === 1) !== 1) return poison(s);
  const b = buffer(s, 52), basic = buffer(s, 40), full = buffer(s, 65536); invoke(s, "GetFileInformationByHandle", [held.raw, b]); invoke(s, "GetFileInformationByHandleEx", [held.raw, 0, basic, basic.length]);
  const attributes = b.readUInt32LE(0), size = b.readUInt32LE(32) * 0x100000000 + b.readUInt32LE(36), length = invoke(s, "GetFinalPathNameByHandleW", [held.raw, full, 32768, 1], v => uint(v) && v > 0 && v < 32768) as number;
  const finalPath = full.toString("utf16le", 0, length * 2), volume = /^(\\\\\?\\Volume\{[0-9a-f-]{36}\}\\)/i.exec(finalPath)?.[1];
  if (attributes & SPECIAL || b.readUInt32LE(40) !== 1 || attributes !== basic.readUInt32LE(32) || b.readBigUInt64LE(4) !== basic.readBigUInt64LE(0) || b.readBigUInt64LE(20) !== basic.readBigUInt64LE(16) || !volume || !Number.isSafeInteger(size) || size > MAX_NODE || /[\p{Cc}\p{Cf}\p{Cs}]/u.test(finalPath)) return poison(s);
  const id = ((BigInt(b.readUInt32LE(44)) << 32n) | BigInt(b.readUInt32LE(48))).toString(16).padStart(16, "0"); if (id === "0000000000000000") return poison(s);
  const value = { id, volume: `${b.readUInt32LE(28)}:${volume.toLowerCase()}`, finalPath, kind: attributes & 16 ? "directory" as const : "file" as const, attributes, links: 1, size,
    created: basic.readBigUInt64LE(0).toString(), written: basic.readBigUInt64LE(16).toString(), changed: basic.readBigUInt64LE(24).toString() };
  wipe(s, b, basic, full); return value;
}
function streams(s: State, file: File): void {
  const io = buffer(s, 16), b = buffer(s, 1024); invoke(s, "NtQueryInformationFile", [file.handle.raw, io, b, b.length, 22], v => v === 0);
  const count = io.readBigUInt64LE(8);
  if (io.readUInt32LE(0) !== 0 || !(file.identity.kind === "directory" && count === 0n) && (count < 38n || count > BigInt(b.length) || b.readUInt32LE(0) !== 0 || b.readUInt32LE(4) !== 14 || b.toString("utf16le", 24, 38) !== "::$DATA" || b.readBigInt64LE(8) !== BigInt(file.identity.size))) return poison(s);
  wipe(s, io, b);
}
function file(s: State, handle: Handle, parent: bigint | null, name: string): File { const f = { handle, parent, name, identity: info(s, handle) }; streams(s, f); return f; }
function unchanged(s: State, f: File, data = true): void { if (!windowsCodingSame(f.identity, info(s, f.handle), data)) return poison(s); }
function privateOrRx(s: State, f: File, rx: boolean, useDescriptor?: (raw: bigint) => void): void {
  const own: unknown[] = [undefined], group: unknown[] = [undefined], dacl: unknown[] = [undefined], sacl: unknown[] = [undefined], out: unknown[] = [undefined];
  const sd = allocateResult(s, "GetSecurityInfo", [f.handle.raw, 1, 1 | 2 | 4 | 0x10, own, group, dacl, sacl, out], out, v => v === 0);
  const length = invoke(s, "GetSecurityDescriptorLength", [sd.raw], v => uint(v) && v >= 20 && v <= 65536) as number;
  registerSpan(s, sd, length);
  const view = (value: unknown, minimum: number) => { if (!pointer(value) || value < sd.raw + 20n || value + BigInt(minimum) > sd.raw + BigInt(length)) return poison(s); return value; };
  if (sidText(s, view(own[0], 12), sd.raw + BigInt(length)) !== s.ownerSid) return poison(s);
  const control = buffer(s, 2), revision = [undefined]; invoke(s, "GetSecurityDescriptorControl", [sd.raw, control, revision]); if (revision[0] !== 1 || (control.readUInt16LE(0) & 0x9004) !== 0x9004) return poison(s);
  // AccessCheck requires owner and group in the descriptor itself, not only separately returned SID pointers.
  const header = decode(s, sd.raw, 20), groupOffset = header.readUInt32LE(8), groupPointer = view(group[0], 12);
  if (header[0] !== 1 || header.readUInt16LE(2) !== control.readUInt16LE(0) || groupOffset < 20 || groupOffset % 4 !== 0 ||
      sd.raw + BigInt(groupOffset) !== groupPointer) return poison(s);
  const groupSid = sidText(s, groupPointer, sd.raw + BigInt(length));
  if (rx && groupSid !== s.ownerSid) return poison(s); wipe(s, header);
  const aclView = (value: unknown) => {
    const raw = view(value, 8), header = decode(s, raw, 8), size = header.readUInt16LE(2), count = header.readUInt16LE(4);
    if (![2, 4].includes(header[0]) || header[1] !== 0 || header.readUInt16LE(6) !== 0 || size < 8 + count * 20 || raw + BigInt(size) > sd.raw + BigInt(length)) return poison(s);
    wipe(s, header); return { raw, end: raw + BigInt(size), count };
  };
  const inspectAcl = (raw: unknown, expected: { sid: string; mask: number; type: number }[]) => {
    const acl = aclView(raw), details = buffer(s, 12); invoke(s, "GetAclInformation", [acl.raw, details, details.length, 2]); if (acl.count !== expected.length || details.readUInt32LE(0) !== expected.length) return poison(s);
    const seen: string[] = [];
    for (let i = 0; i < expected.length; i++) {
      const ace: unknown[] = [undefined]; invoke(s, "GetAce", [acl.raw, i, ace]); const at = view(ace[0], 12), header = decode(s, at, 8), size = header.readUInt16LE(2);
      if (at < acl.raw + 8n || size < 20 || size > 76 || at + BigInt(size) > acl.end || header[1] !== (f.identity.kind === "directory" ? 3 : 0)) return poison(s);
      seen.push(`${sidText(s, at + 8n, at + BigInt(size))}:${header.readUInt32LE(4)}:${header[0]}`); wipe(s, header);
    }
    if (seen.sort().join("|") !== expected.map(ace => `${ace.sid}:${ace.mask}:${ace.type}`).sort().join("|")) return poison(s); wipe(s, details);
  };
  inspectAcl(dacl[0], [{ sid: s.ownerSid!, mask: ALL, type: 0 }, { sid: "S-1-5-18", mask: ALL, type: 0 }, ...(rx ? [{ sid: s.profile.sidText, mask: DIR, type: 0 }, { sid: OWNER_RIGHTS, mask: 0x20000, type: 0 }] : [])]);
  const present = [undefined], label: unknown[] = [undefined], defaulted = [undefined]; invoke(s, "GetSecurityDescriptorSacl", [sd.raw, present, label, defaulted]);
  if (present[0] !== 0 && present[0] !== 1 || defaulted[0] !== 0 && defaulted[0] !== 1 || !!(control.readUInt16LE(0) & 0x10) !== (present[0] === 1) || !!(control.readUInt16LE(0) & 0x20) !== (defaulted[0] === 1) || label[0] !== sacl[0]) return poison(s);
  if (present[0] === 0) {
    // Windows treats an object with no integrity label as Medium with no-write-up. Absence must be positively read back.
    if (rx || label[0] !== null || defaulted[0] !== 0) return poison(s);
  } else if (rx) inspectAcl(sacl[0], [{ sid: "S-1-16-4096", mask: 1, type: 17 }]);
  else {
    const acl = aclView(label[0]), details = buffer(s, 12); invoke(s, "GetAclInformation", [acl.raw, details, details.length, 2]);
    const count = details.readUInt32LE(0); if (count > 1 || acl.count !== count) return poison(s);
    if (count === 1) {
      const ace: unknown[] = [undefined]; invoke(s, "GetAce", [acl.raw, 0, ace]); const at = view(ace[0], 12), header = decode(s, at, 8), size = header.readUInt16LE(2), flags = header[1], mask = header.readUInt32LE(4);
      if (at < acl.raw + 8n || header[0] !== 17 || ![0, 3, 16, 19].includes(flags) || size < 20 || size > 76 || at + BigInt(size) > acl.end || !(mask & 1) || mask & ~7) return poison(s);
      const integrity = sidText(s, at + 8n, at + BigInt(size)), rid = /^S-1-16-(\d+)$/.exec(integrity)?.[1];
      if (!rid || !Number.isSafeInteger(Number(rid)) || Number(rid) < 8192 || Number(rid) > 0xffffffff) return poison(s); wipe(s, header);
    }
    wipe(s, details);
  }
  useDescriptor?.(sd.raw); usable(s); free(s, sd); wipe(s, control);
}
function descriptor(s: State, kind: "file" | "directory", operation: (raw: bigint) => Handle): Handle {
  const flags = kind === "directory" ? "OICI" : "", out: unknown[] = [undefined];
  const sddl = `O:${s.ownerSid}G:${s.ownerSid}D:P(A;${flags};FA;;;${s.ownerSid})(A;${flags};FA;;;SY)(A;${flags};0x1200a9;;;${s.profile.sidText})(A;${flags};RC;;;OW)S:(ML;${flags};NW;;;LW)`;
  const sd = allocateResult(s, "ConvertStringSecurityDescriptorToSecurityDescriptorW", [sddl, 1, out, null], out);
  registerSpan(s, sd, invoke(s, "GetSecurityDescriptorLength", [sd.raw], v => uint(v) && v >= 20 && v <= 65536) as number);
  const held = operation(sd.raw); free(s, sd); return held;
}
async function pin(s: State, absolute: string, writable = false): Promise<File> {
  const drive = absolute.slice(0, 3), fs = buffer(s, 64); invoke(s, "GetDriveTypeW", [drive], v => v === 3); invoke(s, "GetVolumeInformationW", [drive, null, 0, null, null, null, fs, 32]);
  if (fs.toString("utf16le").split("\0")[0] !== "NTFS") return poison(s); wipe(s, fs);
  let selected = file(s, open(s, null, `\\??\\${drive}`, "directory", DIR, 3), null, `\\??\\${drive}`); s.pins.push(selected);
  for (const component of absolute.slice(3).split("\\")) { active(s); const next = file(s, open(s, selected.handle.raw, component, "directory", DIR, 3), selected.handle.raw, component); s.pins.push(next); selected = next; await yieldWork(s); }
  if (writable) { const next = file(s, open(s, selected.parent, selected.name, "directory", DIR | 2 | 4, 3), selected.parent, selected.name); if (!windowsCodingSame(selected.identity, next.identity)) return poison(s); s.pins.push(next); selected = next; }
  return selected;
}
async function yieldWork(s: State): Promise<void> { await new Promise<void>(resolve => setImmediate(resolve)); active(s); }
function ioCount(s: State, io: Buffer, maximum: number): number { const count = io.readBigUInt64LE(8); if (io.readUInt32LE(0) !== 0 || count > BigInt(maximum)) return poison(s); return Number(count); }
async function hashFile(s: State, f: File, expected: { bytes: number; sha256: string }, write?: File): Promise<void> {
  const hash = createHash("sha256"); let position = 0;
  if (expected.bytes > MAX_NODE || f.identity.size !== expected.bytes) return poison(s);
  while (position < expected.bytes) {
    active(s); const size = Math.min(CHUNK, expected.bytes - position), bytes = buffer(s, size), io = buffer(s, 16), offset = buffer(s, 8); offset.writeBigInt64LE(BigInt(position));
    invoke(s, "NtReadFile", [f.handle.raw, null, null, null, io, bytes, size, offset, null], v => v === 0); if (ioCount(s, io, size) !== size) return poison(s);
    hash.update(bytes);
    if (write) { const written = buffer(s, 16); invoke(s, "NtWriteFile", [write.handle.raw, null, null, null, written, bytes, size, offset, null], v => v === 0); if (ioCount(s, written, size) !== size) return poison(s); wipe(s, written); }
    position += size; wipe(s, bytes, io, offset); await yieldWork(s);
  }
  const end = buffer(s, 1), io = buffer(s, 16), offset = buffer(s, 8); offset.writeBigInt64LE(BigInt(position));
  const result = invoke(s, "NtReadFile", [f.handle.raw, null, null, null, io, end, 1, offset, null], v => v === 0 || v === -1073741807 || v === 0xc0000011);
  if (result !== 0 && (io.readUInt32LE(0) !== 0xc0000011 || io.readBigUInt64LE(8) !== 0n) || result === 0 && ioCount(s, io, 1) !== 0 || hash.digest("hex") !== expected.sha256) return poison(s);
  unchanged(s, f); wipe(s, end, io, offset);
}
function listing(s: State, f: File): ReturnType<typeof decodeWindowsCodingDirectoryBatch> {
  const entries: ReturnType<typeof decodeWindowsCodingDirectoryBatch> = []; let restart = 1;
  for (let page = 0; page < 5; page++) {
    const io = buffer(s, 16), bytes = buffer(s, 65536), result = invoke(s, "NtQueryDirectoryFile", [f.handle.raw, null, null, null, io, bytes, bytes.length, 37, 0, null, restart], v => v === 0 || v === -2147483642 || v === 0x80000006); restart = 0;
    if (result !== 0) { if (io.readUInt32LE(0) !== 0x80000006 || io.readBigUInt64LE(8) !== 0n) return poison(s); wipe(s, io, bytes); return entries; }
    const count = ioCount(s, io, bytes.length); if (!count) return poison(s);
    for (const entry of decodeWindowsCodingDirectoryBatch(bytes, count, 4)) { if (entry.attributes & SPECIAL || entry.name.includes("/") || entries.some(other => other.name === entry.name)) return poison(s); entries.push(entry); }
    wipe(s, io, bytes);
  }
  return poison(s);
}

/** Native ABI seam only. Production uses fixed loaders; no supplied manifest, asset bytes, SID or Stop predicate. */
export function bindWindowsNodeToolchainNative(native: Native, load: Loader, fence: WindowsNodeToolchainFence = processFence,
  createOutput: typeof createWindowsCommandOutput = createWindowsCommandOutput) {
  let u = universes.get(fence); if (!u) { u = { busy: false, owners: new Set(), handles: new Set(), allocations: new Set() }; universes.set(fence, u); }
  return { async prepare(input: WindowsNodeToolchainInput): Promise<WindowsNodeToolchainOwner> {
    if (u!.failure || fence.failure) throw u!.failure ?? fence.failure;
    if (!input || !(input.signal instanceof AbortSignal) || typeof input.current !== "function") throw refuse();
    const resourcesPath = ordinary(input.resourcesPath), privateParent = ordinary(input.privateParent), profile = windowsCommandCreatorProfile(input.profile);
    const s: State = { u: u!, fence, native, fn: {}, libraries: [], pending: new Set(), buffers: new Set(), input: { resourcesPath, privateParent, profile: input.profile, signal: input.signal, current: input.current.bind(input) }, profile, key: Object.freeze({}), bound: false,
      handles: [], allocations: [], pins: [], source: [], ready: false, retired: false, creating: false, closed: false, createOutput, serial: 0, nativeEntries: new Set() };
    s.u.owners.add(s);
    assetKeys.set(s.key, s);
    try {
      active(s); if (memory(s, "sizeof", ["void *"], () => native.sizeof("void *")) !== 8) return poison(s);
      if (s.u.busy) return poison(s); s.u.busy = true;
      try { for (const [library, prototypes] of Object.entries(WINDOWS_NODE_TOOLCHAIN_FUNCTIONS)) { const dll = load(`${library}.dll`); s.libraries.push(dll); usable(s); for (const proto of prototypes) { const f = dll.func(proto); usable(s); if (typeof f !== "function") return poison(s); s.fn[/\b(\w+)\s*\(/.exec(proto)![1]] = f as Fn; } } } finally { s.u.busy = false; }
      bindWindowsCommandCreatorAssets(input.profile, s.key); s.bound = true;
      const tokenOut: unknown[] = [undefined]; s.pending.add(tokenOut); const self = invoke(s, "GetCurrentProcess", [], v => v === -1n || v === 0xffffffffffffffffn);
      invoke(s, "OpenProcessToken", [self, 8, tokenOut]); const token = tokenHandle(s, tokenOut, 8); s.pending.delete(tokenOut);
      const tokenBytes = buffer(s, 4096), returned = [undefined]; invoke(s, "GetTokenInformation", [token.raw, 1, tokenBytes, tokenBytes.length, returned]);
      if (!uint(returned[0]) || returned[0] < 28 || returned[0] > tokenBytes.length) return poison(s);
      const user = tokenBytes.readBigUInt64LE(0), base = address(s, tokenBytes); if (!pointer(user) || user < base + 16n || user + 12n > base + BigInt(returned[0])) return poison(s);
      s.ownerSid = sidText(s, user, base + BigInt(returned[0])); if (!/^S-1-5-(?:\d+-)*\d+$/.test(s.ownerSid) || s.ownerSid === "S-1-5-18") return poison(s); close(s, token); wipe(s, tokenBytes);
      s.parent = await pin(s, privateParent, true); privateOrRx(s, s.parent, false);
      const sourceRoot = await pin(s, path.join(resourcesPath, "coding", "windows-node-x64"));
      if (windowsCodingWithin(s.parent.identity.finalPath, sourceRoot.identity.finalPath) || windowsCodingWithin(sourceRoot.identity.finalPath, s.parent.identity.finalPath)) return poison(s);
      const members = manifest.files.filter(member => member.ship);
      const sourceEntries = listing(s, sourceRoot);
      if (sourceEntries.map(entry => entry.name).sort().join("|") !== members.map(member => member.name).sort().join("|")) return poison(s);
      for (const member of members) {
        const f = file(s, open(s, sourceRoot.handle.raw, member.name, "file", READ, 1), sourceRoot.handle.raw, member.name), listed = sourceEntries.find(entry => entry.name === member.name)!; s.source.push(f);
        if (listed.id !== f.identity.id || listed.size !== f.identity.size || listed.attributes !== f.identity.attributes) return poison(s);
        await hashFile(s, f, member);
      }
      unchanged(s, sourceRoot);
      const rootName = `ember-node-${randomUUID()}`;
      s.root = file(s, descriptor(s, "directory", sd => open(s, s.parent!.handle.raw, rootName, "directory", ALL, 7, sd)), s.parent.handle.raw, rootName); privateOrRx(s, s.root, true);
      s.image = file(s, descriptor(s, "file", sd => open(s, s.root!.handle.raw, "node.exe", "file", ALL, 7, sd)), s.root.handle.raw, "node.exe"); privateOrRx(s, s.image, true);
      const node = members.find(member => member.name === "node.exe")!, source = s.source.find(f => f.name === "node.exe")!;
      await hashFile(s, source, node, s.image); invoke(s, "FlushFileBuffers", [s.image.handle.raw]); s.image.identity = info(s, s.image.handle); streams(s, s.image);
      privateOrRx(s, s.image, true); privateOrRx(s, s.root, true);
      // Preserve metadata-only cleanup pins, then close all staging writers before acquiring write-denying runtime pins.
      const imageRef = file(s, open(s, s.root.handle.raw, "node.exe", "file", META, 7), s.root.handle.raw, "node.exe"); unchanged(s, s.image);
      if (!windowsCodingSame(s.image.identity, imageRef.identity)) return poison(s);
      close(s, s.image.handle); s.image = imageRef;
      s.imageLock = file(s, open(s, s.root.handle.raw, "node.exe", "file", READ, 1), s.root.handle.raw, "node.exe");
      if (!windowsCodingSame(s.image.identity, s.imageLock.identity)) return poison(s);
      // Bind the exact runtime bytes only after every staging writer closed and the held pin denies new writers.
      await hashFile(s, s.imageLock, node);
      const rootRef = file(s, open(s, s.parent.handle.raw, rootName, "directory", META | 0x20, 7), s.parent.handle.raw, rootName);
      if (!windowsCodingSame(s.root.identity, rootRef.identity, false) || s.root.identity.created !== rootRef.identity.created) return poison(s);
      close(s, s.root.handle); s.root = rootRef;
      s.image.parent = s.root.handle.raw; s.imageLock.parent = s.root.handle.raw;
      s.rootLock = file(s, open(s, s.parent.handle.raw, rootName, "directory", DIR, 1), s.parent.handle.raw, rootName);
      if (!windowsCodingSame(s.root.identity, s.rootLock.identity, false)) return poison(s);
      s.imagePath = path.join(privateParent, rootName, "node.exe");
      for (const f of s.source) { unchanged(s, f); close(s, f.handle); } s.source = [];
      active(s); s.ready = true; return owner(s);
    } catch (error) {
      if (error instanceof PreparationCancelled && !s.u.failure && !s.fence.failure) { await dispose(s); throw refuse(); }
      return poison(s, error);
    }
  } };
}

function owner(s: State): WindowsNodeToolchainOwner {
  return Object.freeze({
    createSuspended(context: WindowsCommandRootOnlyLaunchContext, argv: readonly string[], options: WindowsCommandOutputOptions): WindowsCommandOutputLaunchRef {
      if (s.u.busy || s.creating) return poison(s); usable(s); s.creating = true;
      const serial = ++s.serial;
      let io: WindowsCommandOutputOwner | undefined, launch: WindowsCommandOutputLaunchRef | undefined, line: Buffer | undefined, entered = false;
      try {
        active(s); if (!s.ready || s.closing || s.use && !s.use.finished) throw refuse();
        windowsCommandRootOnlyLaunchDirectory(context); const metadata = requireWindowsCommandRootOnlyLaunchMetadata(context);
        if (!metadata.live || metadata.profile !== s.input.profile || returnedUses.has(metadata.binding)) throw refuse();
        const captured = copyNodeArgv(argv); usable(s);
        const properties = Object.getOwnPropertyDescriptors(options); usable(s);
        if (Reflect.ownKeys(properties).sort().join("|") !== "output|signal|timeoutMs" || Object.values(properties).some(p => !Object.hasOwn(p, "value"))) throw refuse();
        const signal = properties.signal.value, timeoutMs = properties.timeoutMs.value, output = properties.output.value;
        if (!(signal instanceof AbortSignal) || typeof output !== "function" || typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 20 * 60_000) throw refuse();
        const selected: WindowsCommandOutputOptions = { signal, timeoutMs, output };
        const quote = (v: string) => `"${v.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
        line = Buffer.from([s.imagePath!, ...captured].map(quote).join(" ") + "\0", "utf16le"); active(s); entered = true; s.nativeEntries.add(serial);
        io = s.createOutput(s.input.profile, { ...selected, signal: AbortSignal.any([s.input.signal, selected.signal]) }); usable(s);
        launch = io.createSuspended(context, s.imagePath!, line); usable(s); const actual = requireWindowsCommandOutputLaunch(launch);
        if (actual.profile !== s.input.profile || actual.context !== context) return poison(s);
        const use = { state: s, io, launch, context, binding: metadata.binding, serial, attested: false, finished: false };
        s.use = use; uses.set(launch, use); returnedUses.set(metadata.binding, use); return launch;
      } catch (error) {
        if (error instanceof PreparationCancelled && !entered && !s.u.failure && !s.fence.failure) return cancelLaunch(s, { phase: "empty", point: "creating", context, profile: s.input.profile, serial });
        if (!entered && !s.u.failure && !s.fence.failure) throw error;
        if (launch) try { retainWindowsCommandOutput(launch); } catch { /* Genuine output retains its positive PI. */ }
        return poison(s, { io, error });
      } finally { line?.fill(0); if (!s.u.failure && !s.fence.failure) s.creating = false; }
    },
    async finishOutput(completed: WindowsCommandRootOnlyCompletedRef, run: WindowsCommandRootOnlyRunRef, launch: WindowsCommandOutputLaunchRef) {
      if (s.u.busy) return poison(s);
      usable(s); const use = uses.get(launch); if (!use || use.state !== s || use !== s.use) throw refuse();
      const facts = requireWindowsCommandRootOnlyCompletedOutput(completed, run, launch), metadata = requireWindowsCommandRootOnlyLaunchMetadata(requireWindowsCommandOutputLaunch(launch).context);
      const cancelled = use.cancellation && readConsumedWindowsCommandLaunchCancellation(use.cancellation, metadata.binding);
      if (!use.attested && !(cancelled?.phase === "held" && cancelled.launch === launch && facts.outcome === "cancelled" && facts.exitCode === null)) throw refuse();
      try { const closed = await use.io.closeOutputAfterStopped(completed, run); usable(s); requireWindowsCommandOutputClosed(closed, launch, run); use.finished = true; return closed; }
      catch (error) { return poison(s, error); }
    },
    close(): Promise<void> {
      disposalSite(s, 1, 0);
      try {
        if (s.u.busy || s.creating) return Promise.reject(poison(s));
        if (s.u.failure || s.fence.failure) return Promise.reject(poison(s)); if (s.closed) return Promise.resolve();
        if (s.use && !s.use.finished) return Promise.reject(refuse()); s.retired = true;
        return s.closing ??= dispose(s);
      } finally { try { s.disposal = undefined; } catch { /* A passive close-entry record cannot alter its return or error. */ } }
    },
  });
}

/** No process can be present: ready unused assets or an authenticated finished use, including prelaunch cancellation. */
async function dispose(s: State): Promise<void> {
  disposalSite(s, 1, 0);
  try {
    usable(s); if (s.use && !s.use.finished) throw refuse();
    for (const [index, f] of [s.imageLock, s.rootLock].entries()) if (f && !f.handle.closed) {
      disposalSite(s, 2, index + 1); unchanged(s, f, f.identity.kind === "file"); disposalSite(s, 3, index + 1); close(s, f.handle);
    }
    for (const f of [s.image, s.root]) if (f && !f.handle.closed) {
      const object = f === s.image ? 3 : 4;
      disposalSite(s, 4, object); unchanged(s, f, false); disposalSite(s, 5, object); privateOrRx(s, f, true);
      const parent = f === s.image ? s.root!.handle.raw : f.parent;
      disposalSite(s, 6, object);
      const candidate = file(s, open(s, parent, f.name, f.identity.kind, DELETE | META | (f.identity.kind === "directory" ? 0x20 : 0), 7), parent, f.name);
      disposalSite(s, 7, object);
      if (!windowsCodingSame(f.identity, candidate.identity, false)) return poison(s);
      const disposition = buffer(s, 1), io = buffer(s, 16); disposition[0] = 1; disposalSite(s, 8, object); invoke(s, "NtSetInformationFile", [candidate.handle.raw, io, disposition, 1, 13], v => v === 0);
      disposalSite(s, 9, object); if (io.readUInt32LE(0) !== 0) return poison(s);
      disposalSite(s, 10, object); close(s, candidate.handle); disposalSite(s, 11, object); close(s, f.handle); wipe(s, disposition, io);
    }
    disposalSite(s, 12, 5); for (const held of s.handles.slice().reverse()) if (!held.closed) close(s, held);
    disposalSite(s, 13, 5);
    if (s.allocations.some(a => !a.freed)) return poison(s);
    disposalSite(s, 14, 0);
    if (s.bound) { releaseWindowsCommandCreatorAssets(s.input.profile, s.key); s.bound = false; }
    s.closed = true; s.u.owners.delete(s);
  } catch (error) { return poison(s, error); }
  finally { try { s.disposal = undefined; } catch { /* No diagnostic lifetime can change cleanup settlement. */ } }
}

/** Called only inside Copy's genuine non-consuming witness hook, after matching its actual returned PI. */
export function attestWindowsNodeToolchainOutput(launch: WindowsCommandOutputLaunchRef, ref: WindowsCommandRootOnlyAttestingRef, binding: object): void {
  const use = uses.get(launch); if (!use) return;
  try { attest(use, ref, binding); } catch (error) {
    const s = use.state;
    if (error instanceof PreparationCancelled && !s.u.failure && !s.fence.failure) {
      const actual = requireWindowsCommandOutputLaunch(launch), context = requireWindowsCommandRootOnlyLaunchMetadata(actual.context);
      if (context.binding !== binding || context.profile !== s.input.profile) return poison(s);
      return cancelLaunch(s, { phase: "held", point: "attesting", context: actual.context, profile: s.input.profile, serial: s.serial, launch, witness: ref });
    }
    return poison(s, error);
  }
}
function attest(use: Use, ref: WindowsCommandRootOnlyAttestingRef, binding: object): void {
  const launch = use.launch;
  const s = use.state; active(s); if (use.attested || use.finished || s.use !== use) return poison(s);
  const witness = { ref, binding }, actual = requireWindowsCommandOutputLaunch(launch); requireWindowsCommandRootOnlyAttestingCurrent(ref, binding); s.attesting = witness;
  for (const held of s.handles) if (!held.closed) requireWindowsCommandRootOnlyTokenHandle(ref, binding, held.raw);
  for (const f of [s.parent!, s.root!, s.image!, s.rootLock!, s.imageLock!]) unchanged(s, f, f.identity.kind === "file");
  privateOrRx(s, s.parent!, false); privateOrRx(s, s.root!, true); privateOrRx(s, s.image!, true);
  if (invoke(s, "GetProcessId", [actual.root.process], v => uint(v) && v === actual.root.pid) !== actual.root.pid) return poison(s);
  const text = buffer(s, 65536), count = [32768]; invoke(s, "QueryFullProcessImageNameW", [actual.root.process, 0, text, count]);
  if (!uint(count[0]) || count[0] < 1 || count[0] >= 32768 || text.toString("utf16le", 0, count[0] * 2).toLowerCase() !== s.imagePath!.toLowerCase()) return poison(s); wipe(s, text);
  const out: unknown[] = [undefined]; s.pending.add(out); invoke(s, "OpenProcessToken", [actual.root.process, 8 | 2, out]); const primary = tokenHandle(s, out, 8 | 2, witness); s.pending.delete(out);
  const duplicateOut: unknown[] = [undefined]; s.pending.add(duplicateOut); invoke(s, "DuplicateTokenEx", [primary.raw, 8, null, 2, 2, duplicateOut]); const duplicate = tokenHandle(s, duplicateOut, 8, witness); s.pending.delete(duplicateOut);
  const tokenInfo = (token: Handle, kind: number, size: number) => { const bytes = buffer(s, size), length = [undefined]; invoke(s, "GetTokenInformation", [token.raw, kind, bytes, size, length]); if (!uint(length[0]) || length[0] < 4 || length[0] > size) return poison(s); return { bytes, length: length[0] }; };
  const tokenSid = (info: ReturnType<typeof tokenInfo>, offset: number, minimum: number) => {
    if (info.length < minimum || offset + 8 > info.length) return poison(s);
    const at = info.bytes.readBigUInt64LE(offset), base = address(s, info.bytes);
    if (!pointer(at) || at < base + BigInt(minimum) || at + 12n > base + BigInt(info.length)) return poison(s);
    return sidText(s, at, base + BigInt(info.length));
  };
  let restrictions: string | undefined, integrityAttributes: number | undefined, mandatoryPolicy: number | undefined;
  for (const token of [primary, duplicate]) {
    const ac = tokenInfo(token, 29, 4), capabilities = tokenInfo(token, 30, 4096), restricted = tokenInfo(token, 11, 4096), packageInfo = tokenInfo(token, 31, 256), integrity = tokenInfo(token, 25, 256), user = tokenInfo(token, 1, 4096), policy = tokenInfo(token, 27, 4);
    const count = restricted.bytes.readUInt32LE(0), header = 8 + count * 16;
    if (ac.bytes.readUInt32LE(0) !== 1 || capabilities.bytes.readUInt32LE(0) !== 0 || count > 128 || restricted.length < (count ? header : 4) ||
        tokenSid(packageInfo, 0, 8) !== s.profile.sidText || tokenSid(integrity, 0, 16) !== "S-1-16-4096" || tokenSid(user, 0, 16) !== s.ownerSid || (integrity.bytes.readUInt32LE(8) & 0x60) !== 0x60 || !(policy.bytes.readUInt32LE(0) & 1) || policy.bytes.readUInt32LE(0) & ~3) return poison(s);
    const rows: string[] = [];
    for (let i = 0; i < count; i++) { const row = `${tokenSid(restricted, 8 + 16 * i, header)}:${restricted.bytes.readUInt32LE(16 + i * 16)}`; if (rows.includes(row)) return poison(s); rows.push(row); }
    const facts = rows.sort().join("|");
    if (restrictions !== undefined && facts !== restrictions || integrityAttributes !== undefined && integrity.bytes.readUInt32LE(8) !== integrityAttributes || mandatoryPolicy !== undefined && policy.bytes.readUInt32LE(0) !== mandatoryPolicy) return poison(s);
    restrictions = facts; integrityAttributes = integrity.bytes.readUInt32LE(8); mandatoryPolicy = policy.bytes.readUInt32LE(0);
    wipe(s, ac.bytes, capabilities.bytes, restricted.bytes, packageInfo.bytes, integrity.bytes, user.bytes, policy.bytes);
  }
  const type = tokenInfo(duplicate, 8, 4), level = tokenInfo(duplicate, 9, 4);
  if (type.bytes.readUInt32LE(0) !== 2 || level.bytes.readUInt32LE(0) !== 2) return poison(s); wipe(s, type.bytes, level.bytes);
  const access = (sd: bigint, desired: number, expected: boolean) => {
      const mapping = buffer(s, 16), privileges = buffer(s, 1024), length = [1024], granted = [undefined], allowed = [undefined];
      [READ, 0x120116, 0x1200a0, ALL].forEach((v, i) => mapping.writeUInt32LE(v, i * 4));
      invoke(s, "AccessCheck", [sd, duplicate.raw, desired, mapping, privileges, length, granted, allowed]);
      if (!uint(length[0]) || length[0] > privileges.length || (expected ? allowed[0] !== 1 || granted[0] !== desired : allowed[0] !== 0 || granted[0] !== 0)) return poison(s);
      wipe(s, mapping, privileges);
  };
  for (const f of [s.root!, s.image!]) privateOrRx(s, f, true, sd => {
    for (const desired of [DIR, WRITE_DAC, WRITE_OWNER]) access(sd, desired, desired === DIR);
  });
  // Behavioural AAP exclusion with a positive own-package control; class 46 is unsupported on the native CI target.
  for (const principal of [s.profile.sidText, "S-1-15-2-1"]) {
    const out: unknown[] = [undefined], sd = allocateResult(s, "ConvertStringSecurityDescriptorToSecurityDescriptorW",
      [`O:SYG:SYD:P(A;;0x1;;;${s.ownerSid})(A;;0x1;;;${principal})`, 1, out, null], out);
    registerSpan(s, sd, invoke(s, "GetSecurityDescriptorLength", [sd.raw], v => uint(v) && v >= 20 && v <= 65536) as number);
    access(sd.raw, 1, principal === s.profile.sidText); free(s, sd);
  }
  close(s, duplicate); close(s, primary); requireWindowsCommandRootOnlyAttestingCurrent(ref, binding); active(s); use.attested = true; s.attesting = undefined;
}

/** Fixed Win64 production entry. No test fixture, caller loader, runtime download or host Node discovery. */
export function createWindowsNodeToolchainAssets(input: WindowsNodeToolchainInput): Promise<WindowsNodeToolchainOwner> {
  if (HOST_PLATFORM !== "win32" || HOST_ARCH !== "x64") return Promise.reject(refuse());
  const native = createRequire(__filename)("koffi") as typeof Koffi;
  return bindWindowsNodeToolchainNative(native, name => native.load(name)).prepare(input);
}
