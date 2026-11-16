/** Diagnostic-only Win64 stdio. Never called by product launchers or supplied an external handle list. */
import { createRequire } from "node:module";
import path from "node:path/win32";
import type * as Koffi from "koffi";
import { ExperimentalWindowsCreateUncertain, LPAC_ATTRIBUTES, LPAC_CREATE_FLAGS, type WindowsHandle, type WindowsLpacApi, type WindowsLpacProfile, type WindowsSuspendedProcess } from "../../app/main/agent/experimental-windows-lpac-api";

export const WINDOWS_NODE_IO_OUTPUT = "node-startup-output.bin";
export const WINDOWS_NODE_IO_SETUP_STAGES = Object.freeze([
  "security-descriptor", "create-output-writer", "release-security-descriptor", "open-identity-pin", "identity-pin-metadata",
  "writer-metadata", "output-identity", "open-null", "null-type", "null-name", "null-eof", "writer-inheritance",
  "null-inheritance", "pin-inheritance", "writer-rights", "pin-rights", "null-rights",
] as const);
export const WINDOWS_NODE_IO_SETUP_OPERATIONS = Object.freeze([
  "ConvertStringSecurityDescriptorToSecurityDescriptorW", "CreateFileW", "GetHandleInformation",
  "NtQueryObject", "GetFileInformationByHandle", "ReadFile",
] as const);
type SetupStage = (typeof WINDOWS_NODE_IO_SETUP_STAGES)[number];
type SetupOperation = (typeof WINDOWS_NODE_IO_SETUP_OPERATIONS)[number];
export type WindowsNodeIoSetupReceipt = Readonly<{ stage: SetupStage; operation?: SetupOperation; code?: number;
  detail?: "returned-size" | "missing-required-rights" | "unexpected-rights"; value?: number }>;
const setupReceipts = new WeakMap<object, WindowsNodeIoSetupReceipt>();
class WindowsNodeIoSetupError extends Error {
  constructor(receipt: WindowsNodeIoSetupReceipt) {
    super("The bounded Node stdio diagnostic failed its native contract.");
    this.name = "WindowsNodeIoSetupError";
    setupReceipts.set(this, Object.freeze(receipt));
  }
}
/** Only branded setup failures yield fixed facts. Raw errors, similarly named objects and later failures do not. */
export function windowsNodeIoSetupReceipt(error: unknown): WindowsNodeIoSetupReceipt | undefined {
  return error !== null && typeof error === "object" ? setupReceipts.get(error) : undefined;
}
const INVALID_HANDLE = 0xffffffffffffffffn, HANDLE_INHERIT = 1, HANDLE_LIST = 0x20002, MAX_OUTPUT = 64 * 1024;
type NativeFunction = (...args: unknown[]) => unknown;
/** One native uncertainty fences subsequent diagnostics in this process; test bindings use an isolated fence. */
export interface WindowsNodeIoFence { failure?: Error; retained: unknown[] }
const processIoFence: WindowsNodeIoFence = { retained: [] };
export class WindowsNodeIoCleanupError extends Error {
  constructor() { super("The Node stdio diagnostic could not verify native cleanup; preserve its scratch and pinned assets."); this.name = "WindowsNodeIoCleanupError"; }
}
export interface WindowsNodeIoOwner {
  createHost(program: string, command: Buffer, cwd: string, env: Buffer): WindowsSuspendedProcess;
  createLpac(profile: WindowsLpacProfile, program: string, command: Buffer, cwd: string, env: Buffer): WindowsSuspendedProcess;
  /** Call only after the trusted control's exit code zero AND root exit/private-job zero were verified. */
  acceptHostControl(): void;
  /** The callback must synchronously throw unless exact LPAC root exit and private-job zero were observed. */
  readAfterStopped(stopped: () => void): Buffer;
  /** Caller must first positively stop all created processes; unknown stop retains this owner. */
  close(): void;
}
export const WINDOWS_NODE_IO_FUNCTIONS = {
  kernel32: [
    "uint32_t __stdcall GetLastError()", "int __stdcall CloseHandle(void *handle)", "void * __stdcall LocalFree(void *memory)",
    "void * __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)",
    "int __stdcall GetFileInformationByHandle(void *file, void *information)", "uint32_t __stdcall GetFileType(void *file)",
    "int __stdcall ReadFile(void *file, void *bytes, uint32_t size, _Out_ uint32_t *read, void *overlapped)",
    "int __stdcall GetHandleInformation(void *handle, _Out_ uint32_t *flags)",
    "int __stdcall SetHandleInformation(void *handle, uint32_t mask, uint32_t flags)",
    "int __stdcall InitializeProcThreadAttributeList(void *list, uint32_t count, uint32_t flags, _Inout_ size_t *size)",
    "int __stdcall UpdateProcThreadAttribute(void *list, uint32_t flags, uintptr_t key, void *value, size_t size, void *previous, void *returned)",
    "void __stdcall DeleteProcThreadAttributeList(void *list)",
    "int __stdcall CreateProcessW(const char16_t *program, void *command, void *processSecurity, void *threadSecurity, int inherit, uint32_t flags, void *environment, const char16_t *directory, void *startup, void *information)",
    "int __stdcall TerminateProcess(void *process, uint32_t code)", "uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)",
  ],
  advapi32: ["int __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(const char16_t *text, uint32_t revision, _Out_ void **descriptor, void *size)"],
  ntdll: ["int32_t __stdcall NtQueryObject(void *handle, uint32_t kind, void *information, uint32_t size, _Out_ uint32_t *returned)"],
} as const;

/** Injectable native binding is only for FFI contract/lifecycle tests, just like the fixture's LPAC binding. */
export function bindWindowsNodeIo(koffi: Pick<typeof Koffi, "sizeof" | "address">, load: (name: string) => { func(prototype: string): unknown },
  stateDir: string, profile: WindowsLpacProfile, api: Pick<WindowsLpacApi, "ownerSid">, fence: WindowsNodeIoFence = processIoFence): WindowsNodeIoOwner {
  if (fence.failure) throw fence.failure;
  if (koffi.sizeof("void *") !== 8) throw new Error("The Node stdio diagnostic requires Win64.");
  if (!/^[A-Za-z]:\\/.test(stateDir) || stateDir.includes("/") || /[\0\r\n]/.test(stateDir) || path.normalize(stateDir) !== stateDir || !profile.name ||
    typeof profile.sid !== "bigint" || profile.sid <= 0n || profile.sid === INVALID_HANDLE || !/^S-1-15-2-(?:\d+-)*\d+$/.test(profile.sidText) || profile.sidText === "S-1-15-2-1")
    throw new Error("The Node stdio diagnostic requires its fresh local fixture state and package identity.");
  const boundProfile = { ...profile }, ownerSid = api.ownerSid();
  if (!/^S-1-5-(?:\d+-)*\d+$/.test(ownerSid)) throw new Error("The Node stdio diagnostic has no valid owner identity.");
  const fn: Record<string, NativeFunction> = {};
  for (const [library, prototypes] of Object.entries(WINDOWS_NODE_IO_FUNCTIONS)) {
    const dll = load(`${library}.dll`);
    for (const prototype of prototypes) fn[/\b(\w+)\s*\(/.exec(prototype)![1]] = dll.func(prototype) as NativeFunction;
  }
  let setupStage: SetupStage | undefined = "security-descriptor";
  const failure = (operation?: SetupOperation, code?: unknown) => {
    if (setupStage === undefined) return new Error("The bounded Node stdio diagnostic failed its native contract.");
    const receipt: WindowsNodeIoSetupReceipt = typeof code === "number" && Number.isInteger(code) && code >= 0 && code <= 0xffffffff && operation
      ? { stage: setupStage, operation, code } : { stage: setupStage };
    return new WindowsNodeIoSetupError(receipt);
  };
  // Call only immediately after a native FALSE/invalid-handle result. Predicate failures must never sample stale error state.
  const win32Failure = (operation: SetupOperation, result: unknown) => {
    const failed = operation === "CreateFileW" ? result === INVALID_HANDLE : result === 0 || result === false;
    if (setupStage === undefined || !failed) return failure();
    try { return failure(operation, fn.GetLastError()); } catch { return failure(); }
  };
  const ntFailure = (status: number) => failure("NtQueryObject", Number.isInteger(status) && status >= -0x80000000 && status <= 0xffffffff ? status >>> 0 : undefined);
  const rightsFailure = (detail: "returned-size" | "missing-required-rights" | "unexpected-rights", value: unknown) => {
    if (setupStage === undefined || typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff) return failure();
    return new WindowsNodeIoSetupError({ stage: setupStage, operation: "NtQueryObject", detail, value });
  };
  const valid = (value: unknown): value is WindowsHandle => typeof value === "bigint" && value > 0n && value < 0x8000000000000000n;
  const handle = (value: unknown): WindowsHandle => { if (!valid(value)) throw failure(); return value; };
  let writer: WindowsHandle | undefined, stdin: WindowsHandle | undefined, pin: WindowsHandle | undefined;
  let closed = false, hostCreated = false, hostAccepted = false, lpacCreated = false, exclusivePin = false, output: Buffer | undefined, readFailure: Error | undefined;
  let terminal: WindowsNodeIoCleanupError | ExperimentalWindowsCreateUncertain | undefined;
  const retainedBuffers: Buffer[] = [];
  const retainedHandles = new Set<WindowsHandle>();
  let retained = false;
  const retain = (error: WindowsNodeIoCleanupError | ExperimentalWindowsCreateUncertain) => {
    terminal ??= error; fence.failure ??= terminal;
    if (!retained) { fence.retained.push({ retainedBuffers, retainedHandles, boundProfile, stateDir }); retained = true; }
    return terminal;
  };
  const poison = () => retain(new WindowsNodeIoCleanupError());
  const usable = () => { if (terminal) throw terminal; if (fence.failure) throw fence.failure; if (closed) throw new Error("The Node stdio diagnostic is closed."); };
  const open = (...args: unknown[]): WindowsHandle => {
    let value: unknown;
    try { value = fn.CreateFileW(...args); } catch { throw poison(); }
    if (value === null || value === 0n || value === INVALID_HANDLE) throw win32Failure("CreateFileW", value);
    if (!valid(value)) throw poison();
    if (retainedHandles.has(value)) throw poison();
    // Win32 can recycle a successfully closed writer/stdin value for the publication read pin.
    attemptedCloses.delete(value);
    retainedHandles.add(value);
    return value;
  };
  const flags = (value: WindowsHandle, inherit: boolean) => {
    const observed = [0];
    const ok = fn.GetHandleInformation(value, observed);
    if (!ok) throw win32Failure("GetHandleInformation", ok);
    if (observed[0] !== (inherit ? HANDLE_INHERIT : 0)) throw failure();
  };
  const granted = (value: WindowsHandle, required: number, allowed: number) => {
    // PUBLIC_OBJECT_BASIC_INFORMATION: four ULONG fields plus Reserved[10], exactly 56 bytes.
    // NtQueryObject rejects an oversized ObjectBasicInformation buffer with STATUS_INFO_LENGTH_MISMATCH.
    const basic = Buffer.alloc(56), returned = [0];
    const status = fn.NtQueryObject(value, 0, basic, basic.length, returned);
    if (status !== 0) throw typeof status === "number" ? ntFailure(status) : failure();
    if (returned[0] !== basic.length) throw rightsFailure("returned-size", returned[0]);
    const access = basic.readUInt32LE(4);
    if ((access & required) !== required) throw rightsFailure("missing-required-rights", access);
    if ((access & ~allowed) !== 0) throw rightsFailure("unexpected-rights", access);
  };
  const info = (value: WindowsHandle): Buffer => {
    const bytes = Buffer.alloc(52);
    if (Number(fn.GetFileType(value)) !== 1) throw failure();
    const ok = fn.GetFileInformationByHandle(value, bytes);
    if (!ok) throw win32Failure("GetFileInformationByHandle", ok);
    if ((bytes.readUInt32LE(0) & 0x410) !== 0 || bytes.readUInt32LE(40) !== 1) throw failure();
    return bytes;
  };
  const sameId = (a: Buffer, b: Buffer) => a.readUInt32LE(28) === b.readUInt32LE(28) && a.subarray(44, 52).equals(b.subarray(44, 52));
  const stable = (a: Buffer, b: Buffer) => a.subarray(0, 12).equals(b.subarray(0, 12)) && a.subarray(20).equals(b.subarray(20));
  const size = (bytes: Buffer) => {
    const length = bytes.readUInt32LE(32) * 0x100000000 + bytes.readUInt32LE(36);
    if (!Number.isSafeInteger(length) || length > MAX_OUTPUT) throw failure();
    return length;
  };
  const attemptedCloses = new Set<WindowsHandle>();
  const closeOwned = (value: WindowsHandle) => {
    if (attemptedCloses.has(value)) return;
    attemptedCloses.add(value);
    retainedHandles.add(value);
    try { if (!fn.CloseHandle(value)) throw failure(); retainedHandles.delete(value); }
    catch { throw poison(); }
  };
  const closeIo = () => {
    let failed = false;
    // Invalidate before attempting CloseHandle: a failed close must never be retried on a reused numeric handle.
    for (const kind of ["writer", "stdin"] as const) {
      const value = kind === "writer" ? writer : stdin;
      if (kind === "writer") writer = undefined; else stdin = undefined;
      if (value !== undefined) try { closeOwned(value); } catch { failed = true; }
    }
    if (failed) throw poison();
  };
  const close = () => {
    output?.fill(0); output = undefined;
    if (terminal) throw terminal;
    if (retainedBuffers.length) throw poison();
    if (closed) return;
    closed = true;
    // The identity pin remains held unless both parent IO closes were positively verified.
    closeIo();
    let failed = false;
    const held = pin; pin = undefined;
    if (held !== undefined) try { closeOwned(held); } catch { failed = true; }
    if (failed) throw poison();
  };
  let initial: Buffer;
  try {
    const descriptorOutput: unknown[] = [null];
    // Only this new artifact: protected owner/SYSTEM DACL, Low mandatory label, no broad package grant.
    const sddl = `O:${ownerSid}G:${ownerSid}D:P(A;;FA;;;SY)(A;;FA;;;${ownerSid})S:(ML;;NW;;;LW)`;
    let converted: unknown;
    try { converted = fn.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, descriptorOutput, null); }
    catch {
      if (valid(descriptorOutput[0])) retainedHandles.add(descriptorOutput[0]);
      throw poison();
    }
    if (!converted) {
      const conversionError = win32Failure("ConvertStringSecurityDescriptorToSecurityDescriptorW", converted);
      if (descriptorOutput[0] !== null && descriptorOutput[0] !== 0n) {
        if (valid(descriptorOutput[0])) retainedHandles.add(descriptorOutput[0]);
        throw poison();
      }
      throw conversionError;
    }
    if (!valid(descriptorOutput[0])) throw poison();
    const descriptor = descriptorOutput[0];
    let writerFailed = false, writerError: unknown;
    try {
      setupStage = "create-output-writer";
      const security = Buffer.alloc(24); security.writeUInt32LE(24); security.writeBigUInt64LE(descriptor, 8); // bInheritHandle remains FALSE.
      writer = open(path.join(stateDir, WINDOWS_NODE_IO_OUTPUT), 0x2, 3, security, 1, 0x00200000, null);
    } catch (error) { writerFailed = true; writerError = error; }
    setupStage = "release-security-descriptor";
    try { if (fn.LocalFree(descriptor) !== null) throw failure(); }
    catch { retainedHandles.add(descriptor); throw poison(); }
    if (writerFailed) throw writerError;
    if (writer === undefined) throw failure();
    setupStage = "open-identity-pin";
    pin = open(path.join(stateDir, WINDOWS_NODE_IO_OUTPUT), 0x81, 3, null, 3, 0x00200000, null);
    if (pin === writer) throw failure();
    setupStage = "identity-pin-metadata";
    initial = info(pin);
    setupStage = "writer-metadata";
    const writerInfo = info(writer);
    setupStage = "output-identity";
    if (!sameId(initial, writerInfo) || size(initial) !== 0) throw failure();
    setupStage = "open-null";
    stdin = open("\\\\?\\GLOBALROOT\\Device\\Null", 0x80000000, 3, null, 3, 0, null);
    setupStage = "null-type";
    if (stdin === writer || stdin === pin || Number(fn.GetFileType(stdin)) !== 2) throw failure();
    setupStage = "null-name";
    const name = Buffer.alloc(4096), returned = [0];
    const nameStatus = fn.NtQueryObject(stdin, 1, name, name.length, returned);
    if (nameStatus !== 0) throw typeof nameStatus === "number" ? ntFailure(nameStatus) : failure();
    if (returned[0] < 16 || returned[0] > name.length) throw failure();
    const length = name.readUInt16LE(0), maximum = name.readUInt16LE(2), offset = name.readBigUInt64LE(8) - koffi.address(name);
    if (length === 0 || length % 2 || maximum % 2 || maximum < length || offset < 16n || offset > BigInt(returned[0] - maximum) ||
      name.toString("utf16le", Number(offset), Number(offset) + length) !== "\\Device\\Null") throw failure();
    setupStage = "null-eof";
    const eof = [0];
    const readOk = fn.ReadFile(stdin, Buffer.alloc(1), 1, eof, null);
    if (!readOk) throw win32Failure("ReadFile", readOk);
    if (eof[0] !== 0) throw failure();
    for (const [value, stage] of [[writer, "writer-inheritance"], [stdin, "null-inheritance"], [pin, "pin-inheritance"]] as const) {
      setupStage = stage; flags(value, false);
    }
    setupStage = "writer-rights";
    granted(writer, 0x2, 0x100002); // Win32 may add SYNCHRONIZE to the requested payload-only access.
    setupStage = "pin-rights";
    granted(pin, 0x81, 0x100081);
    setupStage = "null-rights";
    granted(stdin, 0x1, 0x120089); // GENERIC_READ mapping on the canonical character device.
  } catch (error) {
    const original = windowsNodeIoSetupReceipt(error) ? error : failure();
    // Independently release every known IO handle even if descriptor cleanup already poisoned this owner.
    for (const value of new Set([writer, stdin, pin])) if (value !== undefined) {
      retainedHandles.add(value);
      try { closeOwned(value); } catch { /* Every remaining known handle still receives one close attempt. */ }
    }
    closed = true;
    if (terminal) throw terminal;
    if (error instanceof WindowsNodeIoCleanupError) throw error;
    throw original;
  }
  setupStage = undefined;
  const unchanged = () => {
    try {
      if (pin === undefined) throw failure();
      const current = info(pin);
      if (!sameId(initial, current)) throw failure();
      if (writer !== undefined && !sameId(initial, info(writer))) throw failure();
      return current;
    } catch { throw poison(); } // An owned artifact's identity/type/link-count anomaly retires every future use.
  };
  const publishReadPin = () => {
    if (exclusivePin) return;
    // The original no-DELETE identity pin stays held while the fixed path is reopened without WRITE sharing.
    // A surviving child/parent writer makes this open fail; no payload can be published in that case.
    try {
      if (pin === undefined || writer !== undefined || stdin !== undefined) throw failure();
      const previous = pin, before = unchanged();
      const candidate = open(path.join(stateDir, WINDOWS_NODE_IO_OUTPUT), 0x81, 1, null, 3, 0x00200000, null);
      flags(candidate, false); granted(candidate, 0x81, 0x100081);
      const candidateInfo = info(candidate), after = unchanged();
      if (!sameId(before, candidateInfo) || !stable(before, candidateInfo) || !stable(before, after)) throw failure();
      pin = candidate; exclusivePin = true;
      closeOwned(previous);
    } catch { throw poison(); }
  };
  const create = (lpac: boolean, program: string, command: Buffer, cwd: string, env: Buffer): WindowsSuspendedProcess => {
    usable();
    if (writer === undefined || stdin === undefined || pin === undefined || writer === stdin || writer === pin || stdin === pin ||
      (lpac ? !hostAccepted || lpacCreated : hostCreated || lpacCreated)) throw failure();
    unchanged();
    for (const value of [writer, stdin, pin]) flags(value, false);
    if (Number(fn.GetFileType(stdin)) !== 2) throw failure();
    const count = lpac ? 3 : 1, bytes = [0n];
    const sizing = fn.InitializeProcThreadAttributeList(null, count, 0, bytes);
    if (sizing || Number(fn.GetLastError()) !== 122) throw failure();
    const length = Number(bytes[0]);
    if (!Number.isSafeInteger(length) || length < 1 || length > 65536) throw failure();
    const attributes = Buffer.alloc(length);
    let initialized: unknown;
    try { initialized = fn.InitializeProcThreadAttributeList(attributes, count, 0, bytes); }
    catch { retainedBuffers.push(attributes); throw poison(); }
    if (!initialized) throw failure();
    const capabilities = Buffer.alloc(24); capabilities.writeBigUInt64LE(boundProfile.sid);
    const policy = Buffer.alloc(4); policy.writeUInt32LE(1);
    const handles = Buffer.alloc(16); handles.writeBigUInt64LE(stdin, 0); handles.writeBigUInt64LE(writer, 8);
    const startup = Buffer.alloc(112), information = Buffer.alloc(24);
    startup.writeUInt32LE(112); startup.writeUInt32LE(0x100, 60);
    startup.writeBigUInt64LE(stdin, 80); startup.writeBigUInt64LE(writer, 88); startup.writeBigUInt64LE(writer, 96); startup.writeBigUInt64LE(koffi.address(attributes), 104);
    let attempted = false, returned = false, created = false, failureError: unknown, failed = false, uncertain = false, attributesDeleted = false;
    let process: bigint, thread: bigint, result: WindowsSuspendedProcess | undefined;
    try {
      const entries: [number, Buffer][] = lpac ? [[LPAC_ATTRIBUTES.securityCapabilities, capabilities], [LPAC_ATTRIBUTES.allApplicationPackagesPolicy, policy], [HANDLE_LIST, handles]] : [[HANDLE_LIST, handles]];
      for (const [key, value] of entries) if (!fn.UpdateProcThreadAttribute(attributes, 0, key, value, value.length, null, null)) throw failure();
      // Reset and verify immediately around the call, before inspecting PROCESS_INFORMATION or deleting attrs.
      let launchFailed = false, launchError: unknown;
      try {
        // No await, promise or arbitrary callback occurs while either owned handle is inheritable.
        for (const value of [stdin, writer]) { if (!fn.SetHandleInformation(value, HANDLE_INHERIT, HANDLE_INHERIT)) throw poison(); flags(value, true); }
        attempted = true;
        const ok = fn.CreateProcessW(program, command, null, null, 1, LPAC_CREATE_FLAGS, env, cwd, startup, information);
        returned = true; created = !!ok;
      } catch (error) { launchFailed = true; launchError = error; }
      let resetFailed = false;
      for (const value of [stdin, writer]) try { if (!fn.SetHandleInformation(value, HANDLE_INHERIT, 0)) throw failure(); flags(value, false); } catch { resetFailed = true; }
      if (resetFailed) throw poison();
      if (launchFailed) throw launchError;
      process = information.readBigUInt64LE(0); thread = information.readBigUInt64LE(8);
      if (!created) { if (process !== 0n || thread !== 0n) uncertain = true; throw failure(); }
      result = { process: handle(process), thread: handle(thread), pid: information.readUInt32LE(16) };
      if (result.process === result.thread || !result.pid || result.process === writer || result.process === stdin || result.process === pin || result.thread === writer || result.thread === stdin || result.thread === pin) throw failure();
    } catch (error) {
      failed = true; failureError = error instanceof WindowsNodeIoCleanupError ? error : failure();
      process = information.readBigUInt64LE(0); thread = information.readBigUInt64LE(8);
      // A thrown FFI call cannot establish CreateProcessW's FALSE/no-process guarantee.
      if (attempted && !returned) uncertain = true;
    }
    finally {
      try { fn.DeleteProcThreadAttributeList(attributes); attributesDeleted = true; }
      catch { failed = true; failureError = poison(); retainedBuffers.push(attributes, capabilities, policy, handles); }
      // UpdateProcThreadAttribute retains addresses; keep every backing buffer alive until Delete.
      if (attributesDeleted) { capabilities.fill(0); policy.fill(0); handles.fill(0); }
    }
    if (failed) {
      if (created) {
        try {
          if (!valid(process) || process === writer || process === stdin || process === pin) throw failure();
          if (!fn.TerminateProcess(process, 125) && Number(fn.WaitForSingleObject(process, 0)) !== 0) throw failure();
          if (Number(fn.WaitForSingleObject(process, 3000)) !== 0) throw failure();
          for (const value of new Set([thread, process])) if (valid(value) && value !== writer && value !== stdin && value !== pin) {
            if (!fn.CloseHandle(value)) throw failure();
          }
        } catch { uncertain = true; }
      }
      if (uncertain) {
        for (const value of [writer, stdin, pin, process, thread]) if (value !== undefined && valid(value)) retainedHandles.add(value);
        const uncertainty = new ExperimentalWindowsCreateUncertain("A Node stdio process creation could not be observed terminated; preserve all diagnostic assets.");
        terminal = uncertainty; fence.failure = uncertainty;
        throw retain(uncertainty);
      }
      throw failureError;
    }
    if (lpac) lpacCreated = true; else hostCreated = true;
    return result!;
  };
  return {
    createHost: (program, command, cwd, env) => create(false, program, command, cwd, env),
    createLpac(requested, program, command, cwd, env) {
      if (requested.sid !== boundProfile.sid || requested.sidText !== boundProfile.sidText || requested.name !== boundProfile.name) throw failure();
      return create(true, program, command, cwd, env);
    },
    acceptHostControl() {
      usable();
      if (!hostCreated || hostAccepted || lpacCreated || size(unchanged()) !== 0) throw failure();
      hostAccepted = true;
    },
    readAfterStopped(stopped) {
      usable();
      if (!hostAccepted || !lpacCreated || typeof stopped !== "function") throw failure();
      const stop = () => { const result = stopped(); usable(); if (result !== undefined) throw failure(); };
      stop(); closeIo(); stop();
      if (output) return Buffer.from(output);
      if (readFailure) throw readFailure;
      let pending: Buffer | undefined;
      try {
        publishReadPin();
        const before = unchanged(), length = size(before), bytes = Buffer.alloc(length), read = [0]; pending = bytes;
        if (!fn.ReadFile(pin, bytes, length, read, null) || read[0] !== length) throw failure();
        const extra = [0];
        if (!fn.ReadFile(pin, Buffer.alloc(1), 1, extra, null) || extra[0] !== 0) throw failure();
        if (!stable(before, unchanged())) throw poison();
        stop(); output = bytes;
        return Buffer.from(output);
      } catch { pending?.fill(0); if (terminal) throw terminal; throw readFailure = failure(); }
    },
    close,
  };
}
export function loadWindowsNodeIo(stateDir: string, profile: WindowsLpacProfile, api: Pick<WindowsLpacApi, "ownerSid">): WindowsNodeIoOwner {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("The Node stdio diagnostic requires Windows x64.");
  const koffi = createRequire(import.meta.url)("koffi") as typeof Koffi;
  return bindWindowsNodeIo(koffi, name => koffi.load(name), stateDir, profile, api);
}
