/** Test-only owned host processes and writer-excluding read pins for the manual fixed-C access witness. */
import path from "node:path/win32";
import { createRequire } from "node:module";
import type * as Koffi from "koffi";

type NativeFunction = (...args: unknown[]) => unknown;
type Handle = bigint;
type HandleRecord = { value: Handle; closed: boolean; attempted: boolean };
export interface WindowsLpacChildAccessNativeFence { failure?: WindowsLpacChildAccessNativeCleanupError; retained: unknown[] }
export type WindowsLpacChildAccessNativeReceipt = Readonly<{ stage: number; operation: number; domain: number; code: number }>;
const receipts = new WeakMap<object, WindowsLpacChildAccessNativeReceipt>();
class WindowsLpacChildAccessNativeError extends Error {
  constructor(receipt: WindowsLpacChildAccessNativeReceipt) {
    super("The fixed child access witness could not verify its native contract."); this.name = "WindowsLpacChildAccessNativeError";
    const valid = (value: unknown, maximum: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= maximum;
    let closed = { stage: 0, operation: 0, domain: 0, code: 0 };
    try {
      const stage = receipt.stage, operation = receipt.operation, domain = receipt.domain, code = receipt.code;
      closed = { stage: valid(stage, 9) ? stage : 0, operation: valid(operation, 29) ? operation : 0,
        domain: domain === 1 && valid(code, 0xffffffff) ? 1 : 0, code: domain === 1 && valid(code, 0xffffffff) ? code : 0 };
    } catch { /* Throwing accessors are unknown metadata; never expose their error or partial receipt. */ }
    receipts.set(this, Object.freeze(closed));
  }
}
export class WindowsLpacChildAccessNativeCleanupError extends WindowsLpacChildAccessNativeError {
  constructor(receipt: WindowsLpacChildAccessNativeReceipt = { stage: 0, operation: 0, domain: 0, code: 0 }) {
    super(receipt); this.name = "WindowsLpacChildAccessNativeCleanupError";
  }
}
export function windowsLpacChildAccessNativeReceipt(error: unknown): WindowsLpacChildAccessNativeReceipt | undefined {
  if (!error || typeof error !== "object") return undefined;
  const value = receipts.get(error); return value ? { ...value } : undefined;
}
export interface WindowsLpacChildAccessReadPin {
  readonly size: number;
  read(): Buffer;
  unchanged(): void;
  close(): void;
}
export interface WindowsLpacChildAccessTool {
  /** Private filtering metadata; never a process acquisition or publication authority. */
  readonly pid: number;
  /** Borrowed only by the fixed private watchdog; this never transfers CloseHandle authority. */
  borrowedJob(): bigint;
  current(): void;
  isExited(): boolean;
  sampleMembers(): void;
  /** Natural completion only. This never kills a process to manufacture a successful collection. */
  waitExitedBefore(deadline: number): number;
  /** Cleanup only; does not establish successful capture/export. */
  stopBefore(deadline: number): void;
  closeStopped(): void;
}
export interface WindowsLpacChildAccessNative {
  requireAdministrator(): void;
  pinFile(file: string, maximum: number): WindowsLpacChildAccessReadPin;
  launchTool(input: { program: string; command: Buffer; cwd: string; environment: Buffer; pin: WindowsLpacChildAccessReadPin }): WindowsLpacChildAccessTool;
  /** The existing LPAC fixture retains all ownership and performs its separate exact-package/capability witness. */
  verifyBorrowedRoot(input: { process: bigint; pid: number; job: bigint; program: string; pin: WindowsLpacChildAccessReadPin }): void;
  /** Conservative conflict detection on a fresh disposable runner, never name-based termination. */
  requireExclusiveTools(allowed: readonly WindowsLpacChildAccessTool[]): void;
}
export const WINDOWS_LPAC_CHILD_ACCESS_NATIVE_FUNCTIONS = {
  kernel32: [
    "uint32_t __stdcall GetLastError()", "int __stdcall CloseHandle(void *handle)",
    "void * __stdcall GetCurrentProcess()",
    "uint32_t __stdcall GetDriveTypeW(const char16_t *root)",
    "void * __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)",
    "uint32_t __stdcall GetFileType(void *file)", "int __stdcall GetFileInformationByHandle(void *file, void *information)",
    "uint32_t __stdcall GetFinalPathNameByHandleW(void *file, void *name, uint32_t characters, uint32_t flags)",
    "int __stdcall SetFilePointerEx(void *file, int64_t distance, _Out_ int64_t *position, uint32_t method)",
    "int __stdcall ReadFile(void *file, void *bytes, uint32_t size, _Out_ uint32_t *read, void *overlapped)",
    "void * __stdcall CreateJobObjectW(void *security, const char16_t *name)",
    "int __stdcall SetInformationJobObject(void *job, int kind, void *information, uint32_t size)",
    "int __stdcall QueryInformationJobObject(void *job, int kind, void *information, uint32_t size, void *returned)",
    "int __stdcall AssignProcessToJobObject(void *job, void *process)",
    "int __stdcall IsProcessInJob(void *process, void *job, _Out_ int *member)",
    "int __stdcall CreateProcessW(const char16_t *program, void *command, void *processSecurity, void *threadSecurity, int inherit, uint32_t flags, void *environment, const char16_t *directory, void *startup, void *information)",
    "uint32_t __stdcall GetProcessId(void *process)",
    "int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *image, _Inout_ uint32_t *characters)",
    "void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)",
    "uint32_t __stdcall ResumeThread(void *thread)", "uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)",
    "int __stdcall GetExitCodeProcess(void *process, _Out_ uint32_t *code)",
    "int __stdcall TerminateProcess(void *process, uint32_t code)", "int __stdcall TerminateJobObject(void *job, uint32_t code)",
    "void * __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)",
    "int __stdcall Process32FirstW(void *snapshot, void *entry)", "int __stdcall Process32NextW(void *snapshot, void *entry)",
  ],
  advapi32: [
    "int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)",
    "int __stdcall GetTokenInformation(void *token, int kind, void *information, uint32_t size, _Out_ uint32_t *returned)",
  ],
} as const;
const INVALID = 0xffffffffffffffffn, MAX_MEMBERS = 8;
const processFence: WindowsLpacChildAccessNativeFence = { retained: [] };
const validHandle = (value: unknown): value is Handle => typeof value === "bigint" && value > 0n && value < 0x8000000000000000n;
const dword = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const nativeBool = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
const localPath = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^[A-Za-z]:\\/.test(value) || path.normalize(value) !== value || value.includes("/") || /[\p{Cc}\p{Cf}<>"|?*]/u.test(value)) return false;
  return value.slice(3).split("\\").every(part => part.length > 0 && !/[.: ]$|:/.test(part) && part !== "." && part !== "..");
};
const stable = (a: Buffer, b: Buffer) => a.subarray(0, 12).equals(b.subarray(0, 12)) && a.subarray(20).equals(b.subarray(20));
const sameSet = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every(value => b.includes(value));

/** Portable FFI seam; the production application never imports this diagnostic factory. */
export function bindWindowsLpacChildAccessNative(koffi: Pick<typeof Koffi, "sizeof">,
  load: (name: string) => { func(prototype: string): unknown }, fence: WindowsLpacChildAccessNativeFence = processFence,
  clock: () => number = () => performance.now()): WindowsLpacChildAccessNative {
  if (fence.failure) throw fence.failure;
  let stage = 1, operation = 0, domain = 0, code = 0;
  const fn: Record<string, NativeFunction> = {}, operations: Record<string, number> = {};
  const records = new Map<Handle, HandleRecord>(), borrowed = new Set<Handle>(), owners: unknown[] = [];
  const receipt = () => ({ stage, operation, domain, code });
  const failure = () => new WindowsLpacChildAccessNativeError(receipt());
  const poison = (extra?: unknown): never => {
    const first = extra !== null && typeof extra === "object" ? receipts.get(extra) : undefined;
    if (!fence.failure) { fence.failure = new WindowsLpacChildAccessNativeCleanupError(first ?? receipt()); fence.retained.push({ records, owners, fn, extra }); }
    throw fence.failure;
  };
  const usable = () => { if (fence.failure) throw fence.failure; };
  try {
    if (koffi.sizeof("void *") !== 8) throw failure();
    let index = 0;
    for (const [library, prototypes] of Object.entries(WINDOWS_LPAC_CHILD_ACCESS_NATIVE_FUNCTIONS)) {
      const dll = load(`${library}.dll`);
      for (const prototype of prototypes) {
        const name = /\b(\w+)\s*\(/.exec(prototype)![1], value = dll.func(prototype);
        if (typeof value !== "function") throw failure(); fn[name] = value as NativeFunction; operations[name] = ++index;
      }
    }
  } catch { throw failure(); }
  const call = (name: string, ...args: unknown[]): unknown => {
    usable(); operation = operations[name]; domain = 0; code = 0;
    try { return fn[name](...args); } catch (error) { return poison(error); }
  };
  const lastError = (): number | undefined => {
    try { const value = fn.GetLastError(); if (dword(value)) { domain = 1; code = value; return value; } }
    catch { /* Unknown TLS metadata never becomes an error string or a guessed numeric code. */ }
    return undefined;
  };
  const falseFailure = (): never => { lastError(); throw failure(); };
  const requireTrue = (value: unknown): void => { if (!nativeBool(value)) poison(value); if (value === 0) falseFailure(); };
  const own = (value: unknown): HandleRecord => {
    if (!validHandle(value) || borrowed.has(value) || (records.has(value) && !records.get(value)!.closed)) return poison(value);
    const record = { value, closed: false, attempted: false }; records.set(value, record); return record;
  };
  const acquire = (name: string, args: unknown[], invalid: "null" | "invalid"): HandleRecord => {
    const value = call(name, ...args);
    if ((invalid === "null" && (value === null || value === 0n)) || (invalid === "invalid" && value === INVALID)) falseFailure();
    return own(value);
  };
  const close = (record: HandleRecord): void => {
    usable(); if (record.closed) return; if (record.attempted) poison(); record.attempted = true;
    const result = call("CloseHandle", record.value);
    if (!nativeBool(result) || result === 0) { if (result === 0) lastError(); poison(); }
    record.closed = true;
  };
  const tokenCheck = (process: Handle, administrator: boolean): void => {
    const output: unknown[] = [null]; owners.push({ tokenOutput: output });
    const opened = call("OpenProcessToken", process, 0x8, output);
    if (!nativeBool(opened)) poison({ tokenOutput: output });
    if (opened === 0) { if (output[0] !== null && output[0] !== 0n) poison({ tokenOutput: output }); falseFailure(); }
    const token = own(output[0]);
    let refused: Error | undefined, malformed = false;
    try {
      for (const [kind, expected] of administrator ? [[29, 0], [20, 1]] : [[29, 0]]) {
        const bytes = Buffer.alloc(4), count: unknown[] = [0];
        try {
          requireTrue(call("GetTokenInformation", token.value, kind, bytes, 4, count));
          if (count[0] !== 4 || bytes.readUInt32LE() > 1) { malformed = true; throw failure(); }
          if (bytes.readUInt32LE() !== expected) throw failure();
        } finally { bytes.fill(0); }
      }
    } catch (error) { if (fence.failure) throw fence.failure; refused = error instanceof Error ? error : failure(); }
    close(token); if (malformed) poison(refused); if (refused) throw refused;
  };
  type PinState = { file: string; record: HandleRecord; before: Buffer; size: number; maximum: number };
  const pins = new WeakMap<WindowsLpacChildAccessReadPin, PinState>();
  const info = (record: HandleRecord, maximum: number): Buffer => {
    if (record.closed) throw failure();
    if (call("GetFileType", record.value) !== 1) throw failure();
    const bytes = Buffer.alloc(52); requireTrue(call("GetFileInformationByHandle", record.value, bytes));
    const size = bytes.readUInt32LE(32) * 0x100000000 + bytes.readUInt32LE(36);
    if ((bytes.readUInt32LE(0) & 0x410) !== 0 || bytes.readUInt32LE(40) !== 1 || !Number.isSafeInteger(size) || size > maximum) throw failure();
    return bytes;
  };
  const pinCurrent = (pin: PinState): void => {
    usable();
    try { if (!stable(pin.before, info(pin.record, pin.maximum))) throw failure(); }
    catch (error) { poison(error); }
  };
  type ToolState = { object: WindowsLpacChildAccessTool; pin: PinState; program: string; job: HandleRecord; root: HandleRecord; thread: HandleRecord;
    pid: number; members: Map<number, HandleRecord>; assigned: boolean; resumed: boolean; stopped: boolean; closed: boolean };
  const tools = new WeakMap<WindowsLpacChildAccessTool, ToolState>();
  const liveTool = (tool: ToolState): void => { usable(); if (tool.closed) throw failure(); pinCurrent(tool.pin); };
  const wait = (record: HandleRecord, milliseconds: number): number => {
    const value = call("WaitForSingleObject", record.value, milliseconds);
    if (value !== 0 && value !== 258) { if (value === 0xffffffff) lastError(); return poison(); }
    return value;
  };
  const imageAt = (process: Handle, id: number, expected: string): void => {
    const observedPid = call("GetProcessId", process);
    if (!dword(observedPid)) poison(); if (observedPid === 0) falseFailure(); if (observedPid !== id) throw failure();
    const bytes = Buffer.alloc(65536), length: unknown[] = [32768];
    try {
      requireTrue(call("QueryFullProcessImageNameW", process, 0, bytes, length));
      if (!dword(length[0]) || length[0] < 1 || length[0] > 32767) poison();
      if (bytes.toString("utf16le", 0, (length[0] as number) * 2).toLowerCase() !== expected.toLowerCase()) throw failure();
    } finally { bytes.fill(0); }
  };
  const image = (tool: ToolState): void => imageAt(tool.root.value, tool.pid, tool.program);
  const inJob = (record: HandleRecord, tool: ToolState): void => {
    const value: unknown[] = [0]; requireTrue(call("IsProcessInJob", record.value, tool.job.value, value));
    if (!nativeBool(value[0]) || value[0] === 0) throw failure();
  };
  const memberIds = (tool: ToolState): number[] => {
    const bytes = Buffer.alloc(8 + MAX_MEMBERS * 8);
    try {
      requireTrue(call("QueryInformationJobObject", tool.job.value, 3, bytes, bytes.length, null));
      const assigned = bytes.readUInt32LE(0), listed = bytes.readUInt32LE(4);
      if (assigned !== listed || listed > MAX_MEMBERS) throw failure();
      const result: number[] = [];
      for (let index = 0; index < listed; index++) {
        const value = bytes.readBigUInt64LE(8 + index * 8);
        if (value === 0n || value > 0xffffffffn || result.includes(Number(value))) throw failure(); result.push(Number(value));
      }
      return result;
    } finally { bytes.fill(0); }
  };
  const sample = (tool: ToolState): void => {
    liveTool(tool); const found = memberIds(tool);
    if (wait(tool.root, 0) === 258 && !found.includes(tool.pid)) throw failure();
    for (const id of found) {
      if (id === tool.pid) { inJob(tool.root, tool); continue; }
      let record = tool.members.get(id);
      if (!record) {
        if (tool.members.size >= MAX_MEMBERS - 1) throw failure();
        record = acquire("OpenProcess", [0x101000, 0, id], "null"); tool.members.set(id, record);
      }
      if (wait(record, 0) !== 258 || call("GetProcessId", record.value) !== id) throw failure(); inJob(record, tool);
    }
    for (const [id, record] of tool.members) if (!found.includes(id) && wait(record, 0) !== 0) throw failure();
    if (!sameSet(found, memberIds(tool))) throw failure();
  };
  const jobIsEmpty = (tool: ToolState): boolean => {
    const bytes = Buffer.alloc(48);
    try {
      requireTrue(call("QueryInformationJobObject", tool.job.value, 1, bytes, bytes.length, null));
      const active = bytes.readUInt32LE(40), listed = memberIds(tool).length;
      if (active > MAX_MEMBERS) throw failure(); return active === 0 && listed === 0;
    } finally { bytes.fill(0); }
  };
  const jobEmpty = (tool: ToolState): void => { if (!jobIsEmpty(tool)) throw failure(); };
  const stoppedProof = (tool: ToolState): void => {
    liveTool(tool); jobEmpty(tool);
    if (wait(tool.root, 0) !== 0) throw failure();
    for (const record of tool.members.values()) if (wait(record, 0) !== 0) throw failure();
  };
  const waitStopped = (tool: ToolState, deadline: number): number => {
    usable(); stage = 7; if (tool.closed) throw failure();
    try {
      let previous = clock();
      if (!Number.isFinite(previous) || previous < 0 || !Number.isFinite(deadline) || deadline < previous || deadline - previous > 15_000) throw failure();
      const now = () => { const value = clock(); if (!Number.isFinite(value) || value < previous || value > deadline) throw failure(); previous = value; return value; };
      liveTool(tool);
      // Natural completion can leave an auxiliary finishing after the root. Retain every observed member while
      // positively waiting for both root completion and native job zero, without killing a successful collector.
      for (;;) {
        const empty = jobIsEmpty(tool); now();
        if (empty) break;
        sample(tool); now();
      }
      for (const record of [tool.root, ...tool.members.values()]) {
        if (wait(record, Math.max(0, Math.floor(deadline - now()))) !== 0) throw failure(); now();
      }
      stoppedProof(tool); now();
      const exit: unknown[] = [0]; requireTrue(call("GetExitCodeProcess", tool.root.value, exit));
      if (!dword(exit[0]) || exit[0] === 259) throw failure(); now(); tool.stopped = true; return exit[0];
    } catch (error) { return poison(error); }
  };
  return {
    requireAdministrator() {
      usable(); stage = 4; const current = call("GetCurrentProcess"); if (current !== INVALID) poison(current); tokenCheck(current as Handle, true);
    },
    pinFile(file, maximum) {
      usable(); stage = 2;
      if (!localPath(file) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256 * 1024 * 1024) throw failure();
      if (call("GetDriveTypeW", path.parse(file).root) !== 3) throw failure();
      let record: HandleRecord;
      try { record = acquire("CreateFileW", [file, 0x80000080, 1, null, 3, 0x00200000, null], "invalid"); }
      catch (error) { return poison(error); }
      let pin: PinState;
      try {
        const before = info(record, maximum), size = before.readUInt32LE(32) * 0x100000000 + before.readUInt32LE(36);
        const name = Buffer.alloc(65536);
        try {
          const count = call("GetFinalPathNameByHandleW", record.value, name, 32768, 0);
          if (!dword(count) || count < 1 || count > 32767 || name.toString("utf16le", 0, count * 2).toLowerCase() !== `\\\\?\\${file}`.toLowerCase()) throw failure();
        } finally { name.fill(0); }
        pin = { file, record, before, size, maximum };
      } catch (error) { if (fence.failure) throw fence.failure; close(record); throw error; }
      const object: WindowsLpacChildAccessReadPin = {
        size: pin.size,
        unchanged() { stage = 2; pinCurrent(pin); },
        read() {
          usable(); stage = 3; pinCurrent(pin); const output = Buffer.alloc(pin.size + 1), position: unknown[] = [undefined];
          let complete = false;
          try {
            requireTrue(call("SetFilePointerEx", record.value, 0n, position, 0));
            // Koffi 3.2.1 marshals int64_t as Number when representable and BigInt for large values. Require literal zero, never coercion.
            if (position[0] !== 0 && position[0] !== 0n) throw failure();
            let offset = 0;
            while (offset < output.length) {
              const count: unknown[] = [0], chunk = output.subarray(offset, Math.min(output.length, offset + 65536));
              requireTrue(call("ReadFile", record.value, chunk, chunk.length, count, null));
              const amount = count[0];
              if (!dword(amount) || amount > chunk.length) return poison();
              if (amount === 0) break; offset += amount;
            }
            if (offset !== pin.size) throw failure(); pinCurrent(pin); complete = true; return output.subarray(0, pin.size);
          } catch (error) { return poison(error); }
          finally { if (!complete) output.fill(0); }
        },
        close() { stage = 9; close(record); },
      };
      pins.set(object, pin); owners.push({ object, pin }); return Object.freeze(object);
    },
    launchTool(input) {
      usable(); stage = 5; const pin = pins.get(input.pin);
      if (!pin || pin.record.closed || !localPath(input.program) || !localPath(input.cwd) || input.program.toLowerCase() !== pin.file.toLowerCase() ||
        !Buffer.isBuffer(input.command) || input.command.length < 4 || input.command.length > 65534 || input.command.length % 2 ||
        input.command.readUInt16LE(input.command.length - 2) !== 0 || input.command.subarray(0, -2).toString("utf16le").includes("\0") ||
        !input.command.toString("utf16le").startsWith(`"${input.program}"`) || !Buffer.isBuffer(input.environment) || input.environment.length < 4 ||
        input.environment.length > 65536 || input.environment.length % 2 || input.environment.readUInt32LE(input.environment.length - 4) !== 0) throw failure();
      pinCurrent(pin);
      const job = acquire("CreateJobObjectW", [null, null], "null"), limits = Buffer.alloc(144); limits.writeUInt32LE(0x2000, 16);
      let tool: ToolState | undefined, created = false;
      try {
        requireTrue(call("SetInformationJobObject", job.value, 9, limits, limits.length));
        const observed = Buffer.alloc(144), ui = Buffer.alloc(4);
        requireTrue(call("QueryInformationJobObject", job.value, 9, observed, observed.length, null));
        requireTrue(call("QueryInformationJobObject", job.value, 4, ui, ui.length, null));
        if (observed.readUInt32LE(16) !== 0x2000 || observed.readUInt32LE(40) !== 0 || ui.readUInt32LE() !== 0) throw failure();
        const startup = Buffer.alloc(104), information = Buffer.alloc(24); startup.writeUInt32LE(104);
        owners.push({ startup, information, job }); // An unknown CreateProcess completion must retain every output buffer.
        const result = call("CreateProcessW", input.program, input.command, null, null, 0, 0x08000404, input.environment, input.cwd, startup, information);
        if (!nativeBool(result)) poison({ information });
        if (result === 0) { if (information.some(value => value !== 0)) poison({ information }); falseFailure(); }
        created = true;
        const root = own(information.readBigUInt64LE(0)), thread = own(information.readBigUInt64LE(8)), id = information.readUInt32LE(16);
        if (!id || information.readUInt32LE(20) === 0) poison({ root, thread, information });
        const object = {} as WindowsLpacChildAccessTool;
        tool = { object, pin, program: input.program, job, root, thread, pid: id, members: new Map(), assigned: false, resumed: false, stopped: false, closed: false };
        owners.push(tool); tools.set(object, tool);
        requireTrue(call("AssignProcessToJobObject", job.value, root.value)); tool.assigned = true;
        image(tool); tokenCheck(root.value, false); inJob(root, tool); pinCurrent(pin);
        if (call("ResumeThread", thread.value) !== 1) poison(tool); tool.resumed = true; close(thread);
        const exact = tool;
        Object.assign(object, {
          pid: id,
          borrowedJob() { usable(); if (exact.closed || job.closed) throw failure(); return job.value; },
          current() { stage = 6; liveTool(exact); image(exact); inJob(root, exact); if (wait(root, 0) !== 258) throw failure(); },
          isExited() { stage = 6; liveTool(exact); return wait(root, 0) === 0; },
          sampleMembers() { stage = 6; try { sample(exact); } catch (error) { poison(error); } },
          waitExitedBefore(deadline: number) { return waitStopped(exact, deadline); },
          stopBefore(deadline: number) {
            usable(); stage = 7; liveTool(exact);
            try { sample(exact); requireTrue(call("TerminateJobObject", job.value, 125)); waitStopped(exact, deadline); }
            catch (error) { poison(error); }
          },
          closeStopped() {
            usable(); stage = 9; if (exact.closed) return;
            try { stoppedProof(exact); for (const record of [...exact.members.values(), root, thread, job]) close(record); exact.closed = true; }
            catch (error) { poison(error); }
          },
        });
        return Object.freeze(object);
      } catch (error) {
        if (fence.failure) throw fence.failure;
        if (created) {
          if (!tool || tool.resumed) return poison(error);
          try {
            requireTrue(call("TerminateProcess", tool.root.value, 125)); if (wait(tool.root, 5000) !== 0) poison();
            if (tool.assigned) { requireTrue(call("TerminateJobObject", job.value, 125)); jobEmpty(tool); }
            close(tool.thread); close(tool.root); tool.closed = true;
          } catch (cleanup) { return poison(cleanup); }
        }
        close(job); throw error;
      } finally { limits.fill(0); }
    },
    verifyBorrowedRoot(input) {
      usable(); stage = 6; const pin = pins.get(input.pin);
      if (!pin || pin.record.closed || !localPath(input.program) || input.program.toLowerCase() !== pin.file.toLowerCase() ||
        !validHandle(input.process) || !validHandle(input.job) || input.process === input.job || !dword(input.pid) || input.pid === 0 ||
        [input.process, input.job].some(value => records.has(value) && !records.get(value)!.closed)) throw failure();
      borrowed.add(input.process); borrowed.add(input.job); owners.push({ borrowedRoot: { ...input } });
      pinCurrent(pin); imageAt(input.process, input.pid, input.program);
      const member: unknown[] = [0]; requireTrue(call("IsProcessInJob", input.process, input.job, member));
      if (!nativeBool(member[0])) poison(); if (member[0] === 0) throw failure();
      const state = call("WaitForSingleObject", input.process, 0);
      if (state !== 0 && state !== 258) { if (state === 0xffffffff) lastError(); poison(); }
      if (state !== 258) throw failure(); pinCurrent(pin);
    },
    requireExclusiveTools(allowed) {
      usable(); stage = 8;
      if (!Array.isArray(allowed) || allowed.length > 8 || new Set(allowed).size !== allowed.length) throw failure();
      const expected = new Set<number>(), required = new Set<number>();
      for (const object of allowed) {
        const tool = tools.get(object); if (!tool || tool.closed) throw failure();
        object.current(); object.sampleMembers();
        const current = memberIds(tool);
        if (!current.includes(tool.pid)) throw failure();
        for (const id of current) {
          const record = id === tool.pid ? tool.root : tool.members.get(id);
          if (!record || wait(record, 0) !== 258 || call("GetProcessId", record.value) !== id) throw failure();
          inJob(record, tool); expected.add(id);
        }
        // Retired handles remain owned for Stop, but never authorize a later process using their former PID.
        if (!sameSet(current, memberIds(tool))) throw failure();
        if (/^procmon(?:64a?|)\.exe$/i.test(path.basename(tool.program))) required.add(tool.pid);
      }
      stage = 8;
      const snapshot = acquire("CreateToolhelp32Snapshot", [2, 0], "invalid");
      let refused: Error | undefined;
      try {
        const entry = Buffer.alloc(568), seen = new Set<number>(); let first = true, count = 0;
        for (;;) {
          entry.fill(0); entry.writeUInt32LE(568);
          const result = call(first ? "Process32FirstW" : "Process32NextW", snapshot.value, entry); first = false;
          if (!nativeBool(result)) poison(result);
          if (result === 0) { if (lastError() !== 18) throw failure(); break; }
          if (++count > 4096 || entry.readUInt32LE() !== 568) throw failure();
          const id = entry.readUInt32LE(8), nameBytes = entry.subarray(44, 564); let end = -1;
          for (let index = 0; index < 520; index += 2) if (nameBytes.readUInt16LE(index) === 0) { end = index; break; }
          if (end < 0) throw failure(); const name = nameBytes.toString("utf16le", 0, end);
          if (/[\p{Cc}\p{Cf}]/u.test(name)) throw failure();
          if (/^procmon(?:64a?|)\.exe$/i.test(name)) { if (!expected.has(id)) throw failure(); seen.add(id); }
        }
        if ([...required].some(id => !seen.has(id))) throw failure();
      } catch (error) { if (fence.failure) throw fence.failure; refused = error instanceof Error ? error : failure(); }
      close(snapshot); if (refused) poison(refused);
    },
  };
}

export function loadWindowsLpacChildAccessNative(): WindowsLpacChildAccessNative {
  if (process.platform !== "win32" || process.arch !== "x64") throw new WindowsLpacChildAccessNativeError({ stage: 1, operation: 0, domain: 0, code: 0 });
  const koffi = createRequire(import.meta.url)("koffi") as typeof Koffi;
  return bindWindowsLpacChildAccessNative(koffi, name => koffi.load(name));
}
