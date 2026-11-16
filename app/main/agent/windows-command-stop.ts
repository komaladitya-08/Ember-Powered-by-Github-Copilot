/** Root-only command prerequisite. ACTIVE_PROCESS=1 forbids child writers; this is not a generic command backend. */
import { createRequire } from "node:module";
import type * as Koffi from "koffi";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import type { WindowsHandle, WindowsLpacApi, WindowsSuspendedProcess } from "./experimental-windows-lpac-api";
import { WindowsCodingCleanupError } from "./windows-coding-native";

const LIMITS = 0x2008, MAX_STOP = 15_000;
const refuse = () => new Error("The Windows root-only command writer contract was refused.");
const handle = (value: unknown): value is WindowsHandle => typeof value === "bigint" && value > 0n && value < 0x8000000000000000n;
const dword = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const bool = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
export class WindowsCommandRootOnlyCleanupError extends WindowsCodingCleanupError {
  constructor() { super(); this.name = "WindowsCommandRootOnlyCleanupError"; this.message = "Windows root-only command writer cleanup could not be verified."; }
}
export interface WindowsCommandRootOnlyStopFence { failure?: WindowsCommandRootOnlyCleanupError; retained: unknown[] }
const processFence: WindowsCommandRootOnlyStopFence = { retained: [] };
const liveOwners = new WeakMap<WindowsCommandRootOnlyStopFence, Set<{ state: { requestStop(): void }; retained: boolean }>>();
declare const stoppedBrand: unique symbol;
export interface WindowsCommandRootOnlyStoppedRef { readonly scope: "root-only"; readonly [stoppedBrand]: true }
const receipts = new WeakMap<object, object>();
const issuedBindings = new WeakSet<object>();
/** Only the issuing owner, after all native closes, can authorize this exact grant generation's revocation. */
export function requireWindowsCommandRootOnlyStopped(ref: unknown, binding: object): void {
  if (!binding || typeof binding !== "object" || !ref || typeof ref !== "object" || !receipts.has(ref) || receipts.get(ref) !== binding) throw refuse();
}
export interface WindowsCommandRootOnlyJobState { total: number; active: number; pids: number[] }
export interface WindowsCommandRootOnlyStopNative {
  configure(job: WindowsHandle): void;
  assertLimits(job: WindowsHandle): void;
  state(job: WindowsHandle): WindowsCommandRootOnlyJobState;
  processId(process: WindowsHandle): number;
  threadProcessId(thread: WindowsHandle): number;
  member(process: WindowsHandle, job: WindowsHandle): boolean;
  /** Exactly WAIT_OBJECT_0 or WAIT_TIMEOUT; any other ABI/native result throws. Never opens a PID. */
  wait(handle: WindowsHandle): 0 | 258;
  close(handle: WindowsHandle): void;
}
type NativeFunction = (...args: unknown[]) => unknown;
export const WINDOWS_COMMAND_ROOT_ONLY_STOP_FUNCTIONS = [
  "int __stdcall SetInformationJobObject(void *job, int kind, void *information, uint32_t size)",
  "int __stdcall QueryInformationJobObject(void *job, int kind, void *information, uint32_t size, void *returned)",
  "uint32_t __stdcall GetProcessId(void *process)",
  "uint32_t __stdcall GetProcessIdOfThread(void *thread)",
  "int __stdcall IsProcessInJob(void *process, void *job, _Out_ int *member)",
  "uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)",
  "int __stdcall CloseHandle(void *handle)",
] as const;
/** Injected FFI contract tests need no Windows DLL. Unknown call completion retains its argument buffers. */
export function bindWindowsCommandRootOnlyStopNative(koffi: Pick<typeof Koffi, "sizeof">,
  load: (name: string) => { func(prototype: string): unknown }): WindowsCommandRootOnlyStopNative {
  const functions: Record<string, NativeFunction> = {}, retained = new Set<unknown>();
  try {
    if (koffi.sizeof("void *") !== 8) throw refuse();
    const library = load("kernel32.dll");
    for (const prototype of WINDOWS_COMMAND_ROOT_ONLY_STOP_FUNCTIONS) {
      const value = library.func(prototype); if (typeof value !== "function") throw refuse();
      functions[/\b(\w+)\s*\(/.exec(prototype)![1]] = value as NativeFunction;
    }
  } catch { throw refuse(); }
  const checked = (value: unknown) => { if (!bool(value) || value === 0) throw refuse(); };
  const query = (job: WindowsHandle, kind: number, size: number): Buffer => {
    const bytes = Buffer.alloc(size); retained.add(bytes);
    checked(functions.QueryInformationJobObject(job, kind, bytes, size, null)); return bytes;
  };
  const release = (bytes: Buffer) => { bytes.fill(0); retained.delete(bytes); };
  const native: WindowsCommandRootOnlyStopNative = {
    configure(job) {
      const bytes = Buffer.alloc(144); bytes.writeUInt32LE(LIMITS, 16); bytes.writeUInt32LE(1, 40); retained.add(bytes);
      checked(functions.SetInformationJobObject(job, 9, bytes, bytes.length)); release(bytes); native.assertLimits(job);
    },
    assertLimits(job) {
      const observed = query(job, 9, 144), ui = query(job, 4, 4);
      // Accounting/peak usage is dynamic; all limit fields must remain exactly the configured zero/one values.
      const expected = Buffer.alloc(64); expected.writeUInt32LE(LIMITS, 16); expected.writeUInt32LE(1, 40);
      if (!observed.subarray(0, 64).equals(expected) || observed.readBigUInt64LE(112) !== 0n || observed.readBigUInt64LE(120) !== 0n || ui.readUInt32LE(0) !== 0) throw refuse();
      release(observed); release(ui);
    },
    state(job) {
      const accounting = query(job, 1, 48), list = query(job, 3, 16);
      const total = accounting.readUInt32LE(36), active = accounting.readUInt32LE(40), terminated = accounting.readUInt32LE(44);
      const assigned = list.readUInt32LE(0), listed = list.readUInt32LE(4);
      if (total > 1 || active > total || terminated > total || assigned !== listed || active !== listed || listed > 1) throw refuse();
      const pids: number[] = [];
      if (listed) { const value = list.readBigUInt64LE(8); if (value < 1n || value > 0xffffffffn) throw refuse(); pids.push(Number(value)); }
      release(accounting); release(list); return { total, active, pids };
    },
    processId(process) { const value = functions.GetProcessId(process); if (!dword(value) || value === 0) throw refuse(); return value; },
    threadProcessId(thread) { const value = functions.GetProcessIdOfThread(thread); if (!dword(value) || value === 0) throw refuse(); return value; },
    member(process, job) {
      const inside: unknown[] = [0]; retained.add(inside); checked(functions.IsProcessInJob(process, job, inside));
      if (inside[0] !== 0 && inside[0] !== 1) throw refuse(); retained.delete(inside); return inside[0] === 1;
    },
    wait(owner) { const value = functions.WaitForSingleObject(owner, 0); if (value !== 0 && value !== 258) throw refuse(); return value; },
    close(owner) { checked(functions.CloseHandle(owner)); },
  };
  return native;
}
export function loadWindowsCommandRootOnlyStopNative(): WindowsCommandRootOnlyStopNative {
  if (HOST_PLATFORM !== "win32" || HOST_ARCH !== "x64") throw refuse();
  const koffi = createRequire(__filename)("koffi") as typeof Koffi;
  return bindWindowsCommandRootOnlyStopNative(koffi, name => koffi.load(name));
}
export interface WindowsCommandRootOnlyStopOwner {
  readonly scope: "root-only";
  /** Trusted native CREATE_SUSPENDED issuer supplies an owned root, never arbitrary running project code. No job is passed. */
  launch(create: () => WindowsSuspendedProcess, attest: (root: Readonly<WindowsSuspendedProcess>) => void, current: () => boolean): Promise<number>;
  stop(timeoutMs?: number): Promise<WindowsCommandRootOnlyStoppedRef>;
  /** External file/ACL uncertainty retires the entire shared boundary without disposal, queries or a receipt. */
  retainStop(): void;
}
type StopApi = Pick<WindowsLpacApi, "createJob" | "assign" | "resume" | "terminateJob" | "terminateProcess">;
/** No profile is issued here. The caller's synchronous attestation owns exact image/token/fresh-profile authority. */
export function createWindowsCommandRootOnlyStopOwner(binding: object, api: StopApi,
  native: WindowsCommandRootOnlyStopNative = loadWindowsCommandRootOnlyStopNative(), clock: () => number = () => performance.now(),
  fence: WindowsCommandRootOnlyStopFence = processFence): WindowsCommandRootOnlyStopOwner {
  if (!binding || typeof binding !== "object" || !api || !native || typeof clock !== "function") throw refuse();
  if (fence.failure) throw fence.failure;
  if (issuedBindings.has(binding)) throw refuse();
  issuedBindings.add(binding); // An inert/older receipt must never authorize a later live owner sharing a binding.
  let job: WindowsHandle | undefined, root: Readonly<WindowsSuspendedProcess> | undefined, rawRoot: unknown, knownProcess: WindowsHandle | undefined, knownThread: WindowsHandle | undefined;
  let launched = false, retired = false, closed = false, rootStop = false, jobStop = false, disposalStarted = false, history = 0;
  let stopping: Promise<WindowsCommandRootOnlyStoppedRef> | undefined;
  const closeAttempted = new Set<WindowsHandle>(), callbacks: unknown[] = [];
  let active = liveOwners.get(fence); if (!active) { active = new Set(); liveOwners.set(fence, active); }
  const record = { retained: false, state: { binding, api, native, callbacks, closeAttempted, requestStop: () => requestStop(),
    get job() { return job; }, get root() { return root; }, get rawRoot() { return rawRoot; }, get knownProcess() { return knownProcess; }, get knownThread() { return knownThread; } } };
  active.add(record); // Retain all still-live owners, including peers when this process-wide boundary is poisoned.
  const peerOwns = (value: WindowsHandle) => [...active!].some(owner => {
    if (owner === record) return false;
    const state = owner.state as { job?: WindowsHandle; root?: Readonly<WindowsSuspendedProcess>; knownProcess?: WindowsHandle; knownThread?: WindowsHandle };
    return state.job === value || state.root?.process === value || state.root?.thread === value || state.knownProcess === value || state.knownThread === value;
  });
  const requestStop = () => {
    // Stop requests carry no disposal authority and never touch a handle after an uncertain close attempt.
    if (disposalStarted) return;
    if (knownProcess && !rootStop && !closeAttempted.has(knownProcess)) { rootStop = true; try { api.terminateProcess(knownProcess); } catch {} }
    if (job && !jobStop && !closeAttempted.has(job)) { jobStop = true; try { api.terminateJob(job); } catch {} }
  };
  const terminal = (extra?: unknown, stopPeers = false): never => {
    retired = true;
    if (!fence.failure) fence.failure = new WindowsCommandRootOnlyCleanupError();
    for (const owner of active!) if (!owner.retained) { owner.retained = true; fence.retained.push(owner.state); }
    // The opaque thrown value is retained privately; outward errors never copy native/callback messages or causes.
    if (extra !== undefined) callbacks.push(extra);
    if (stopPeers) for (const owner of active!) owner.state.requestStop(); else requestStop();
    throw fence.failure;
  };
  const usable = () => { if (fence.failure) return terminal(); if (closed) throw refuse(); };
  const state = () => {
    const value = native.state(job!);
    if (!value || !dword(value.total) || value.total > 1 || !dword(value.active) || value.active > value.total || !Array.isArray(value.pids) ||
      value.pids.length !== value.active || value.pids.length > 1 || value.total < history || value.pids.some(pid => !dword(pid) || !pid || !root || pid !== root.pid) || (!root && value.total !== 0)) throw refuse();
    history = value.total;
    return value;
  };
  try {
    const created = api.createJob(); if (!handle(created) || peerOwns(created)) return terminal(created); job = created;
    usable();
    native.configure(job); native.assertLimits(job); const initial = state(); if (initial.total !== 0 || initial.active !== 0) throw refuse();
  } catch (error) { return terminal(error); }
  return Object.freeze({
    scope: "root-only" as const,
    retainStop() {
      try { terminal(undefined, true); }
      catch (error) { if (error !== fence.failure) throw new WindowsCommandRootOnlyCleanupError(); }
    },
    async launch(create: () => WindowsSuspendedProcess, attest: (root: Readonly<WindowsSuspendedProcess>) => void, current: () => boolean) {
      usable(); if (launched || retired || typeof create !== "function" || typeof attest !== "function" || typeof current !== "function") throw refuse();
      launched = true; callbacks.push(create, attest, current);
      // Reserve admission before any callback; pre-create revocation still permits an inert closed-job receipt.
      try { const admitted = current(); usable(); if (admitted !== true || retired) throw refuse(); }
      catch (error) { retired = true; if (fence.failure) return terminal(error); throw refuse(); }
      try {
        rawRoot = create();
        const value = rawRoot as WindowsSuspendedProcess;
        if (!value) throw refuse();
        const process = value.process;
        if (!handle(process) || process === job || peerOwns(process)) throw refuse();
        knownProcess = process; // Capture the known owned process before any further fallible property access.
        const thread = value.thread;
        if (!handle(thread) || process === thread || thread === job || peerOwns(thread)) throw refuse();
        knownThread = thread;
        const pid = value.pid; if (!dword(pid) || !pid) throw refuse();
        root = Object.freeze({ process, thread, pid });
        usable();
        if (retired) throw refuse();
        if (native.processId(root.process) !== root.pid || native.threadProcessId(root.thread) !== root.pid || native.member(root.process, job!)) throw refuse();
        native.assertLimits(job!); if (state().total !== 0) throw refuse();
        api.assign(job!, root.process);
        if (!native.member(root.process, job!)) throw refuse();
        const assigned = state(); if (assigned.total !== 1 || assigned.active !== 1 || assigned.pids[0] !== root.pid) throw refuse();
        const attested = attest(root); usable();
        if (attested !== undefined || retired) throw refuse();
        const admitted = current(); usable();
        if (admitted !== true || retired) throw refuse();
        native.assertLimits(job!);
        if (native.processId(root.process) !== root.pid || native.threadProcessId(root.thread) !== root.pid || !native.member(root.process, job!)) throw refuse();
        const final = current(); usable();
        if (final !== true || retired) throw refuse();
        api.resume(root.thread); return root.pid;
      } catch (error) { return terminal(error); }
    },
    stop(timeoutMs = MAX_STOP) {
      if (stopping) return stopping;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_STOP) return Promise.reject(refuse());
      retired = true; // Revoke admission synchronously, before the first await or native request.
      let previous = 0, invalidStart = false;
      try { previous = clock(); if (!Number.isFinite(previous) || previous < 0) throw refuse(); }
      catch (error) { invalidStart = true; callbacks.push(error); }
      const deadline = previous + timeoutMs; // Includes time awaiting the first microtask and every later yield.
      // Defer native work so a trusted callback's synchronous Stop revocation cannot close its in-flight launch handles.
      stopping = Promise.resolve().then(async () => {
        usable();
        try {
          if (invalidStart) throw refuse();
          const within = () => { const now = clock(); if (!Number.isFinite(now) || now < previous || now > deadline) throw refuse(); previous = now; };
          within(); native.assertLimits(job!); within();
          if (root) {
            const status = native.wait(root.process);
            if (status !== 0 && status !== 258) throw refuse();
            if (status === 258) { rootStop = true; api.terminateProcess(root.process); }
          }
          jobStop = true; api.terminateJob(job!); within();
          // Yield rather than block Electron's main thread; every poll addresses the same retained objects.
          for (;;) {
            within(); const observed = state(); within();
            if (observed.active === 0) {
              let ready = true;
              for (const owner of root ? [root.process, root.thread] : []) {
                const status = native.wait(owner); if (status !== 0 && status !== 258) throw refuse(); if (status === 258) ready = false; within();
              }
              if (ready) break;
            }
            if (previous === deadline) throw refuse();
            await new Promise<void>(resolve => setImmediate(resolve));
            usable();
          }
          native.assertLimits(job!); const final = state(); if (final.active !== 0) throw refuse();
          for (const owner of root ? [root.process, root.thread] : []) if (native.wait(owner) !== 0) throw refuse();
          within();
          // No later handle is touched after any uncertain close, including by best-effort Stop.
          disposalStarted = true;
          for (const owner of root ? [root.thread, root.process, job!] : [job!]) {
            closeAttempted.add(owner); if (native.close(owner) !== undefined) throw refuse(); within();
          }
          closed = true; active!.delete(record); const receipt = Object.freeze({ scope: "root-only" as const }) as WindowsCommandRootOnlyStoppedRef;
          receipts.set(receipt, binding); return receipt;
        } catch (error) { return terminal(error); }
      });
      return stopping;
    },
  });
}
