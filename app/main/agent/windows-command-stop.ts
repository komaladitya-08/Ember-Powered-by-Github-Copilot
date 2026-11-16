/** Root-only command prerequisite. ACTIVE_PROCESS=1 forbids child writers; this is not a generic command backend. */
import { createRequire } from "node:module";
import type * as Koffi from "koffi";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import type { WindowsHandle, WindowsLpacApi, WindowsSuspendedProcess } from "./experimental-windows-lpac-api";
import { WindowsCodingCleanupError } from "./windows-coding-native";
import { loadWindowsCommandRootOnlyExitNative, type WindowsCommandRootOnlyExitNative } from "./windows-command-exit-native";
import { requireWindowsCommandOutputLaunch, releaseWindowsCommandOutputPI, type WindowsCommandOutputLaunchRef } from "./windows-command-output";
import { consumeWindowsCommandLaunchCancellation, requireNoWindowsCommandLaunchCancellation } from "./windows-command-launch-cancel";

const LIMITS = 0x2008, MAX_STOP = 15_000;
const refuse = () => new Error("The Windows root-only command writer contract was refused.");
const handle = (value: unknown): value is WindowsHandle => typeof value === "bigint" && value > 0n && value < 0x8000000000000000n;
const dword = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const bool = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
type FailureStage = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14;
type FailureOperation = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
type FailurePredicate = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11;
type FailureConstraint = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15 | 16 | 17 | 18 | 19 | 20 | 21;
// Stages 1..13: load, job create, configure/readback, initial state, creator, preassign, assign,
// attest, postattest, resume, Stop request, completion, close; stage 14 is optional held-root exit observation.
// Operations 1..7 follow the unchanged fixed Stop prototypes below; the optional exit binding is separate.
// Predicates 1..11: call throw, ABI, returned failure, limit readback, job state, identity,
// ownership, authority, deadline, close, invariant. Zero operation/constraint means no known site/span.
export interface WindowsCommandRootOnlyFailure {
  readonly stage: FailureStage; readonly operation: FailureOperation; readonly predicate: FailurePredicate;
  readonly domain: 0 | 1; readonly code: number; readonly constraint: FailureConstraint;
}
const failures = new WeakMap<object, WindowsCommandRootOnlyFailure>();
/** Fixed first-failure facts only; foreign objects and serialized errors have no diagnostic authority. */
export function windowsCommandRootOnlyFailure(error: unknown): WindowsCommandRootOnlyFailure | undefined {
  return typeof error === "object" && error !== null ? failures.get(error) : undefined;
}
const observation = (stage: FailureStage, predicate: FailurePredicate, operation: FailureOperation = 0, constraint: FailureConstraint = 0,
  status?: unknown): WindowsCommandRootOnlyFailure => {
  const knownBool = (operation === 1 || operation === 2 || operation === 5 || operation === 7) &&
    typeof status === "number" && Number.isInteger(status) && status >= -0x80000000 && status <= 0xffffffff;
  return Object.freeze({ stage, operation, predicate, constraint, domain: knownBool ? 1 : 0, code: knownBool ? (status as number) >>> 0 : 0 });
};
const remember = (error: unknown, failure: WindowsCommandRootOnlyFailure) => {
  if (typeof error === "object" && error !== null && !failures.has(error)) failures.set(error, failure);
};
const refused = (stage: FailureStage, predicate: FailurePredicate, operation: FailureOperation = 0, constraint: FailureConstraint = 0, status?: unknown) => {
  const error = refuse(); remember(error, observation(stage, predicate, operation, constraint, status)); return error;
};
// Constraints 1..9: process/job time, flags, padding20, min/max workset, active limit, padding44,
// affinity. Historical 10/11 are reserved; 12/13/14 remain process/job memory/UI. No values leave here.
// 15..20 select the first failed existing state comparison in source order, not every failed comparison;
// 21 is existing PID bounds. The listed>1 comparison (20) overlaps earlier checks and is never first.
const LIMIT_SPANS = [[0, 8], [8, 16], [16, 20], [20, 24], [24, 32], [32, 40], [40, 44], [44, 48], [48, 56]] as const;
export class WindowsCommandRootOnlyCleanupError extends WindowsCodingCleanupError {
  constructor() { super(); this.name = "WindowsCommandRootOnlyCleanupError"; this.message = "Windows root-only command writer cleanup could not be verified."; }
}
export interface WindowsCommandRootOnlyStopFence { failure?: WindowsCommandRootOnlyCleanupError; retained: unknown[] }
const firstStopFailures = new WeakMap<WindowsCommandRootOnlyStopFence, WindowsCommandRootOnlyCleanupError>();
const processFence: WindowsCommandRootOnlyStopFence = { retained: [] };
const liveOwners = new WeakMap<WindowsCommandRootOnlyStopFence, Set<{ state: { requestStop(): void }; retained: boolean }>>();
declare const stoppedBrand: unique symbol;
export interface WindowsCommandRootOnlyStoppedRef { readonly scope: "root-only"; readonly [stoppedBrand]: true }
const receipts = new WeakMap<object, object>();
const completionFacts = new WeakMap<object, Readonly<{ rootPresent: 0 | 1 }>>();
declare const naturalExitBrand: unique symbol;
export interface WindowsCommandRootOnlyNaturalExitRef { readonly scope: "root-only-natural-exit"; readonly [naturalExitBrand]: true }
const naturalExits = new WeakMap<object, { binding: object; facts: Readonly<{ exitCode: number }> }>();
/** A genuine natural exit is observed on the held root before any Stop request or handle close. */
export function requireWindowsCommandRootOnlyNaturalExit(ref: unknown, binding: object): Readonly<{ exitCode: number }> {
  if (!ref || typeof ref !== "object" || !binding || typeof binding !== "object") throw refuse();
  const value = naturalExits.get(ref); if (!value || value.binding !== binding) throw refuse(); return value.facts;
}
declare const attestingBrand: unique symbol;
export interface WindowsCommandRootOnlyAttestingRef { readonly scope: "root-only-attesting"; readonly [attestingBrand]: true }
const attestations = new WeakMap<object, { binding: object; root: Readonly<WindowsSuspendedProcess>; current(): boolean; cancellation(): boolean; owns(value: WindowsHandle): boolean; live: boolean; claimed: boolean }>();
declare const outputMatchBrand: unique symbol;
export interface WindowsCommandRootOnlyOutputMatchRef { readonly scope: "root-only-output-match"; readonly [outputMatchBrand]: true }
const outputMatches = new WeakMap<object, { binding: object; launch: WindowsCommandOutputLaunchRef; witness: WindowsCommandRootOnlyAttestingRef }>();
const matchedOutputs = new WeakMap<object, WindowsCommandOutputLaunchRef>();
/** Non-consuming: the creator token may still use its original one-shot witness independently. */
export function matchWindowsCommandRootOnlyOutput(witness: WindowsCommandRootOnlyAttestingRef, binding: object,
  launch: WindowsCommandOutputLaunchRef): WindowsCommandRootOnlyOutputMatchRef {
  requireWindowsCommandRootOnlyAttestingCurrent(witness, binding);
  const actual = attestations.get(witness)!, expected = requireWindowsCommandOutputLaunch(launch);
  if (matchedOutputs.has(binding) || actual.root.process !== expected.root.process || actual.root.thread !== expected.root.thread || actual.root.pid !== expected.root.pid) throw refuse();
  for (const handle of expected.handles) requireWindowsCommandRootOnlyTokenHandle(witness, binding, handle);
  requireWindowsCommandRootOnlyAttestingCurrent(witness, binding);
  const ref = Object.freeze({ scope: "root-only-output-match" as const }) as WindowsCommandRootOnlyOutputMatchRef;
  outputMatches.set(ref, { binding, launch, witness }); matchedOutputs.set(binding, launch); return ref;
}
export function requireWindowsCommandRootOnlyOutputMatch(ref: unknown, launch: WindowsCommandOutputLaunchRef): void {
  if (!ref || typeof ref !== "object") throw refuse(); const value = outputMatches.get(ref);
  if (!value || value.launch !== launch) throw refuse(); requireWindowsCommandRootOnlyAttestingCurrent(value.witness, value.binding);
}
export function requireWindowsCommandRootOnlyOutputStopped(ref: unknown, binding: object, launch: WindowsCommandOutputLaunchRef): void {
  requireWindowsCommandRootOnlyStopped(ref, binding);
  if (matchedOutputs.get(binding) !== launch) throw refuse();
}
/** Native output uses this genuine receipt to retire only its already-closed PI numbers from the alias ledger. */
export function requireWindowsCommandRootOnlyOutputStoppedLaunch(ref: unknown, launch: WindowsCommandOutputLaunchRef): void {
  if (!ref || typeof ref !== "object") throw refuse(); const binding = receipts.get(ref);
  if (!binding || matchedOutputs.get(binding) !== launch) throw refuse();
}
const preparingOwners = new WeakMap<object, () => boolean>();
const creatingOwners = new WeakMap<object, () => boolean>();
declare const cancellationPhaseBrand: unique symbol;
export interface WindowsCommandRootOnlyCancellationPhaseRef { readonly scope: "root-only-cancellation-phase"; readonly [cancellationPhaseBrand]: true }
const cancellationPhases = new WeakMap<object, { live: boolean; available(): boolean; binding: object; phase: "empty" | "held"; launch?: WindowsCommandOutputLaunchRef }>();
/** Negative identity checks only: these confer no current execution, byte or Stop authority. */
export function requireWindowsCommandRootOnlyCancellationCreating(binding: object): void {
  if (creatingOwners.get(binding)?.() !== true) throw refuse();
}
export function requireWindowsCommandRootOnlyCancellationWitness(ref: unknown, binding: object, launch: WindowsCommandOutputLaunchRef): void {
  const value = ref && typeof ref === "object" ? attestations.get(ref) : undefined;
  if (!value || value.binding !== binding || !value.live || !value.cancellation() || matchedOutputs.get(binding) !== launch) throw refuse();
}
/** A phase exists only inside the exact owner's catch and expires before launch rejects. */
export function requireWindowsCommandRootOnlyCancellationPhase(ref: WindowsCommandRootOnlyCancellationPhaseRef): Readonly<{ binding: object; phase: "empty" | "held"; launch?: WindowsCommandOutputLaunchRef }> {
  const value = ref && typeof ref === "object" ? cancellationPhases.get(ref) : undefined;
  if (!value?.live || !value.available()) throw refuse(); return Object.freeze({ binding: value.binding, phase: value.phase, launch: value.launch });
}
const issuedBindings = new WeakSet<object>();
/** Only the issuing owner, after all native closes, can authorize this exact grant generation's revocation. */
export function requireWindowsCommandRootOnlyStopped(ref: unknown, binding: object): void {
  if (!binding || typeof binding !== "object" || !ref || typeof ref !== "object" || !receipts.has(ref) || receipts.get(ref) !== binding) throw refuse();
}
/** Only the genuine completed owner can distinguish an empty job from a launched root with missing creator evidence. */
export function requireWindowsCommandRootOnlyCompletion(ref: unknown, binding: object): Readonly<{ rootPresent: 0 | 1 }> {
  requireWindowsCommandRootOnlyStopped(ref, binding);
  const facts = completionFacts.get(ref as object); if (!facts) throw refuse(); return facts;
}
/** A grant generation starts only with this authentic configured, empty, not-yet-launched Stop owner. */
export function requireWindowsCommandRootOnlyPreparing(binding: object): void {
  if (!binding || typeof binding !== "object" || preparingOwners.get(binding)?.() !== true) throw refuse();
}
export function requireWindowsCommandRootOnlyAttestingCurrent(ref: unknown, binding: object): void {
  if (!ref || typeof ref !== "object") throw refuse();
  const value = attestations.get(ref); if (!value || value.binding !== binding || !value.live || !value.current()) throw refuse();
}
/** A single synchronous consumer receives the same already-attested held root, never a PID-opened replacement. */
export function takeWindowsCommandRootOnlyAttesting(ref: unknown, binding: object): Readonly<WindowsSuspendedProcess> {
  requireWindowsCommandRootOnlyAttestingCurrent(ref, binding);
  const value = attestations.get(ref as object)!; if (value.claimed) throw refuse(); value.claimed = true; return value.root;
}
/** A token result must not alias any retained root/thread/job handle in this Stop universe. No handle is exposed. */
export function requireWindowsCommandRootOnlyTokenHandle(ref: unknown, binding: object, value: unknown): void {
  requireWindowsCommandRootOnlyAttestingCurrent(ref, binding);
  if (!handle(value) || attestations.get(ref as object)!.owns(value)) throw refuse();
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
    if (koffi.sizeof("void *") !== 8) throw refused(1, 2);
    const library = load("kernel32.dll");
    for (const prototype of WINDOWS_COMMAND_ROOT_ONLY_STOP_FUNCTIONS) {
      const value = library.func(prototype); if (typeof value !== "function") throw refused(1, 2);
      functions[/\b(\w+)\s*\(/.exec(prototype)![1]] = value as NativeFunction;
    }
  } catch (error) { const failure = windowsCommandRootOnlyFailure(error); throw refused(1, failure?.predicate ?? 1); }
  const call = (stage: FailureStage, operation: FailureOperation, name: string, args: unknown[]) => {
    try { return functions[name](...args); } catch (error) { remember(error, observation(stage, 1, operation)); throw error; }
  };
  const checked = (value: unknown, stage: FailureStage, operation: FailureOperation) => {
    if (!bool(value) || value === 0) throw refused(stage, !bool(value) ? 2 : 3, operation, 0, value);
  };
  const query = (job: WindowsHandle, kind: number, size: number, stage: FailureStage): Buffer => {
    const bytes = Buffer.alloc(size); retained.add(bytes);
    checked(call(stage, 2, "QueryInformationJobObject", [job, kind, bytes, size, null]), stage, 2); return bytes;
  };
  const release = (bytes: Buffer) => { bytes.fill(0); retained.delete(bytes); };
  const native: WindowsCommandRootOnlyStopNative = {
    configure(job) {
      const bytes = Buffer.alloc(144); bytes.writeUInt32LE(LIMITS, 16); bytes.writeUInt32LE(1, 40); retained.add(bytes);
      checked(call(3, 1, "SetInformationJobObject", [job, 9, bytes, bytes.length]), 3, 1); release(bytes); native.assertLimits(job);
    },
    assertLimits(job) {
      const observed = query(job, 9, 144, 3), ui = query(job, 4, 4, 3);
      // PriorityClass/SchedulingClass (56..64) are ignored without their flags; exact LIMITS rejects those flags.
      // Accounting/peak usage is dynamic. Every other compared field remains exact.
      // https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information
      const expected = Buffer.alloc(56); expected.writeUInt32LE(LIMITS, 16); expected.writeUInt32LE(1, 40);
      if (!observed.subarray(0, 56).equals(expected) || observed.readBigUInt64LE(112) !== 0n || observed.readBigUInt64LE(120) !== 0n || ui.readUInt32LE(0) !== 0) {
        // Observation only, after the complete original predicate refused. No field value leaves this module.
        const first = LIMIT_SPANS.findIndex(([start, end]) => !observed.subarray(start, end).equals(expected.subarray(start, end)));
        const constraint = first >= 0 ? first + 1 : observed.readBigUInt64LE(112) !== 0n ? 12 : observed.readBigUInt64LE(120) !== 0n ? 13 : ui.readUInt32LE(0) !== 0 ? 14 : 0;
        throw refused(3, 4, 2, constraint as FailureConstraint);
      }
      release(observed); release(ui);
    },
    state(job) {
      const accounting = query(job, 1, 48, 4), list = query(job, 3, 16, 4);
      const total = accounting.readUInt32LE(36), active = accounting.readUInt32LE(40), terminated = accounting.readUInt32LE(44);
      const assigned = list.readUInt32LE(0), listed = list.readUInt32LE(4);
      if (total > 1 || active > total || terminated > total || assigned !== listed || active !== listed || listed > 1) {
        // Only already-decoded scalars are compared after the complete original predicate refused.
        const first = [total > 1, active > total, terminated > total, assigned !== listed, active !== listed, listed > 1].findIndex(Boolean);
        throw refused(4, 5, 2, (first < 0 ? 0 : first + 15) as FailureConstraint);
      }
      const pids: number[] = [];
      if (listed) { const value = list.readBigUInt64LE(8); if (value < 1n || value > 0xffffffffn) throw refused(4, 5, 2, 21); pids.push(Number(value)); }
      release(accounting); release(list); return { total, active, pids };
    },
    processId(process) { const value = call(6, 3, "GetProcessId", [process]); if (!dword(value) || value === 0) throw refused(6, 6, 3); return value; },
    threadProcessId(thread) { const value = call(6, 4, "GetProcessIdOfThread", [thread]); if (!dword(value) || value === 0) throw refused(6, 6, 4); return value; },
    member(process, job) {
      const inside: unknown[] = [0]; retained.add(inside); checked(call(6, 5, "IsProcessInJob", [process, job, inside]), 6, 5);
      if (inside[0] !== 0 && inside[0] !== 1) throw refused(6, 2, 5); retained.delete(inside); return inside[0] === 1;
    },
    wait(owner) { const value = call(12, 6, "WaitForSingleObject", [owner, 0]); if (value !== 0 && value !== 258) throw refused(12, 2, 6); return value; },
    close(owner) { checked(call(13, 7, "CloseHandle", [owner]), 13, 7); },
  };
  return native;
}
export function loadWindowsCommandRootOnlyStopNative(): WindowsCommandRootOnlyStopNative {
  if (HOST_PLATFORM !== "win32" || HOST_ARCH !== "x64") throw refused(1, 8);
  try {
    const koffi = createRequire(__filename)("koffi") as typeof Koffi;
    return bindWindowsCommandRootOnlyStopNative(koffi, name => koffi.load(name));
  } catch (error) { remember(error, observation(1, 1)); throw error; }
}
export interface WindowsCommandRootOnlyStopOwner {
  readonly scope: "root-only";
  /** Trusted native CREATE_SUSPENDED issuer supplies an owned root, never arbitrary running project code. No job is passed. */
  launch(create: () => WindowsSuspendedProcess, attest: (root: Readonly<WindowsSuspendedProcess>) => void, current: () => boolean,
    capture?: (ref: WindowsCommandRootOnlyAttestingRef) => void): Promise<number>;
  stop(timeoutMs?: number): Promise<WindowsCommandRootOnlyStoppedRef>;
  /** Optional additive capability. Observation never occupies or delays the Stop queue. Null means no natural observation. */
  observeNaturalExit?(signal: AbortSignal): Promise<WindowsCommandRootOnlyNaturalExitRef | null>;
  /** External file/ACL uncertainty retires the entire shared boundary without disposal, queries or a receipt. */
  retainStop(): void;
}
type StopApi = Pick<WindowsLpacApi, "createJob" | "assign" | "resume" | "terminateJob" | "terminateProcess">;
/** No profile is issued here. The caller's synchronous attestation owns exact image/token/fresh-profile authority. */
export function createWindowsCommandRootOnlyStopOwner(binding: object, api: StopApi,
  native: WindowsCommandRootOnlyStopNative = loadWindowsCommandRootOnlyStopNative(), clock: () => number = () => performance.now(),
  fence: WindowsCommandRootOnlyStopFence = processFence,
  exitNative: () => WindowsCommandRootOnlyExitNative = loadWindowsCommandRootOnlyExitNative): WindowsCommandRootOnlyStopOwner {
  if (!binding || typeof binding !== "object" || !api || !native || typeof clock !== "function") throw refuse();
  if (firstStopFailures.has(fence) || fence.failure) throw firstStopFailures.get(fence) ?? fence.failure;
  if (issuedBindings.has(binding)) throw refuse();
  issuedBindings.add(binding); // An inert/older receipt must never authorize a later live owner sharing a binding.
  let job: WindowsHandle | undefined, root: Readonly<WindowsSuspendedProcess> | undefined, rawRoot: unknown, knownProcess: WindowsHandle | undefined, knownThread: WindowsHandle | undefined;
  let launched = false, retired = false, closed = false, rootStop = false, jobStop = false, disposalStarted = false, history = 0;
  let stopping: Promise<WindowsCommandRootOnlyStoppedRef> | undefined;
  let resumed = false, resumeAttempted = false, creating = false, launchedCurrent: (() => boolean) | undefined;
  let observing: Promise<WindowsCommandRootOnlyNaturalExitRef | null> | undefined;
  let wakeObservation: (() => void) | undefined;
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
  const terminal = (extra?: unknown, stopPeers = false, stage: FailureStage = 11, predicate: FailurePredicate = 11): never => {
    retired = true;
    fence.failure = firstStopFailures.get(fence) ?? fence.failure;
    if (!fence.failure) {
      fence.failure = new WindowsCommandRootOnlyCleanupError();
      const source = windowsCommandRootOnlyFailure(extra);
      remember(fence.failure, source ? Object.freeze({ ...source, stage }) : observation(stage, predicate));
    }
    firstStopFailures.set(fence, fence.failure);
    for (const owner of active!) if (!owner.retained) { owner.retained = true; fence.retained.push(owner.state); }
    // The opaque thrown value is retained privately; outward errors never copy native/callback messages or causes.
    if (extra !== undefined) callbacks.push(extra);
    if (stopPeers) for (const owner of active!) owner.state.requestStop(); else requestStop();
    throw fence.failure;
  };
  const usable = () => { if (firstStopFailures.has(fence) || fence.failure) return terminal(); if (closed) throw refuse(); };
  const state = () => {
    const value = native.state(job!);
    if (!value || !dword(value.total) || value.total > 1 || !dword(value.active) || value.active > value.total || !Array.isArray(value.pids) ||
      value.pids.length !== value.active || value.pids.length > 1 || value.total < history || value.pids.some(pid => !dword(pid) || !pid || !root || pid !== root.pid) || (!root && value.total !== 0)) throw refused(4, 5);
    history = value.total;
    return value;
  };
  let initialStage: FailureStage = 2;
  try {
    const created = api.createJob(); if (!handle(created) || peerOwns(created)) return terminal(created, false, 2, 7); job = created;
    usable();
    initialStage = 3; native.configure(job); native.assertLimits(job); initialStage = 4; const initial = state(); if (initial.total !== 0 || initial.active !== 0) throw refused(4, 5);
  } catch (error) { return terminal(error, false, initialStage, 1); }
  preparingOwners.set(binding, () => !fence.failure && !retired && !closed && !launched && job !== undefined && history === 0);
  const cancellationAvailable = () => !firstStopFailures.has(fence) && !fence.failure && !closed && !disposalStarted && !resumeAttempted;
  creatingOwners.set(binding, () => cancellationAvailable() && creating && !root && !knownProcess && !knownThread && rawRoot === undefined && history === 0);
  return Object.freeze({
    scope: "root-only" as const,
    retainStop() {
      try { terminal(undefined, true, 11, 7); }
      catch (error) { if (error !== fence.failure) throw new WindowsCommandRootOnlyCleanupError(); }
    },
    async launch(create: () => WindowsSuspendedProcess, attest: (root: Readonly<WindowsSuspendedProcess>) => void, current: () => boolean,
      capture?: (ref: WindowsCommandRootOnlyAttestingRef) => void) {
      usable(); if (launched || retired || typeof create !== "function" || typeof attest !== "function" || typeof current !== "function" || capture !== undefined && typeof capture !== "function") throw refused(5, 8);
      launched = true; callbacks.push(create, attest, current);
      launchedCurrent = current;
      // Reserve admission before any callback; pre-create revocation still permits an inert closed-job receipt.
      try { const admitted = current(); usable(); if (admitted !== true || retired) throw refused(5, 8); }
      catch (error) { retired = true; if (fence.failure) return terminal(error); throw refused(5, 8); }
      let launchStage: FailureStage = 5;
      try {
        creating = true;
        try { rawRoot = create(); } finally { creating = false; }
        const value = rawRoot as WindowsSuspendedProcess;
        if (!value) throw refused(5, 7);
        const process = value.process;
        if (!handle(process) || process === job || peerOwns(process)) throw refused(5, 7);
        knownProcess = process; // Capture the known owned process before any further fallible property access.
        const thread = value.thread;
        if (!handle(thread) || process === thread || thread === job || peerOwns(thread)) throw refused(5, 7);
        knownThread = thread;
        const pid = value.pid; if (!dword(pid) || !pid) throw refused(5, 6);
        root = Object.freeze({ process, thread, pid });
        usable();
        requireNoWindowsCommandLaunchCancellation(binding);
        if (retired) throw refused(5, 8);
        launchStage = 6;
        if (native.processId(root.process) !== root.pid || native.threadProcessId(root.thread) !== root.pid || native.member(root.process, job!)) throw refused(6, 6);
        native.assertLimits(job!); if (state().total !== 0) throw refused(6, 5);
        launchStage = 7; api.assign(job!, root.process);
        if (!native.member(root.process, job!)) throw refused(7, 6);
        const assigned = state(); if (assigned.total !== 1 || assigned.active !== 1 || assigned.pids[0] !== root.pid) throw refused(7, 5);
        launchStage = 8;
        const attested = attest(root); usable();
        if (attested !== undefined || retired) throw refused(8, 8);
        if (capture !== undefined) {
          callbacks.push(capture);
          const selected = root, ref = Object.freeze({ scope: "root-only-attesting" as const }) as WindowsCommandRootOnlyAttestingRef;
          const available = () => !fence.failure && !retired && !closed && root === selected && job !== undefined;
          const value = { binding, root: selected, live: true, claimed: false, cancellation: () => cancellationAvailable() && root === selected && job !== undefined,
            owns: (candidate: WindowsHandle) => candidate === job || candidate === knownProcess || candidate === knownThread || peerOwns(candidate), current: () => {
            if (!available()) return false;
            let admitted: unknown; try { admitted = current(); } catch { return false; }
            return available() && admitted === true;
          } };
          attestations.set(ref, value);
          try {
            const captured = capture(ref); usable();
            if (captured !== undefined || retired) throw refused(8, 8);
          } finally { value.live = false; }
        }
        requireNoWindowsCommandLaunchCancellation(binding);
        launchStage = 9;
        const admitted = current(); usable();
        if (admitted !== true || retired) throw refused(9, 8);
        native.assertLimits(job!);
        if (native.processId(root.process) !== root.pid || native.threadProcessId(root.thread) !== root.pid || !native.member(root.process, job!)) throw refused(9, 6);
        const final = current(); usable();
        if (final !== true || retired) throw refused(9, 8);
        launchStage = 10; resumeAttempted = true; api.resume(root.thread); resumed = true; return root.pid;
      } catch (error) {
        const empty = launchStage === 5 && rawRoot === undefined && !root && !knownProcess && !knownThread && history === 0;
        const held = launchStage === 8 && root !== undefined && matchedOutputs.has(binding);
        if (cancellationAvailable() && (empty || held)) {
          const ref = Object.freeze({ scope: "root-only-cancellation-phase" as const }) as WindowsCommandRootOnlyCancellationPhaseRef;
          const value = { live: true, available: cancellationAvailable, binding, phase: empty ? "empty" as const : "held" as const,
            launch: empty ? undefined : matchedOutputs.get(binding) }; cancellationPhases.set(ref, value);
          try { if (consumeWindowsCommandLaunchCancellation(error, ref)) { retired = true; callbacks.push(error); throw error; } }
          catch (caught) { if (caught === error) throw caught; return terminal(caught, false, launchStage, 1); }
          finally { value.live = false; }
        }
        return terminal(error, false, launchStage, 1);
      }
    },
    observeNaturalExit(signal: AbortSignal) {
      if (firstStopFailures.has(fence) || fence.failure) { try { usable(); } catch (error) { return Promise.reject(error); } }
      if (observing) return observing;
      if (!(signal instanceof AbortSignal) || !resumed || !root || !launchedCurrent) return Promise.reject(refused(14, 8));
      const held = root, current = launchedCurrent;
      const wake = () => wakeObservation?.();
      signal.addEventListener("abort", wake, { once: true });
      const available = () => {
        if (firstStopFailures.has(fence) || fence.failure) return terminal(undefined, false, 14, 7);
        if (signal.aborted || retired || closed || disposalStarted || rootStop || jobStop || root !== held) return false;
        let admitted: unknown; try { admitted = current(); } catch { return false; }
        if (firstStopFailures.has(fence) || fence.failure) return terminal(undefined, false, 14, 7);
        return admitted === true && !signal.aborted && !retired && !closed && !disposalStarted && !rootStop && !jobStop && root === held;
      };
      observing = Promise.resolve().then(async () => {
        try {
          for (;;) {
            if (!available()) return null;
            const waited = native.wait(held.process);
            if (waited !== 0 && waited !== 258) throw refused(14, 2, 6);
            if (!available()) return null;
            if (waited === 0) {
              callbacks.push(exitNative);
              const reader = exitNative(); callbacks.push(reader);
              if (!available()) return null;
              const code = reader.exitCode(held.process);
              if (!dword(code)) throw refused(14, 2);
              if (!available()) return null;
              const ref = Object.freeze({ scope: "root-only-natural-exit" as const }) as WindowsCommandRootOnlyNaturalExitRef;
              naturalExits.set(ref, { binding, facts: Object.freeze({ exitCode: code }) }); return ref;
            }
            await new Promise<void>(resolve => {
              const timer = setTimeout(() => finish(), 10);
              const finish = () => { clearTimeout(timer); wakeObservation = undefined; resolve(); };
              wakeObservation = finish;
              if (signal.aborted || retired) finish();
            });
          }
        } catch (error) { return terminal(error, false, 14, 1); }
        finally { signal.removeEventListener("abort", wake); }
      });
      return observing;
    },
    stop(timeoutMs = MAX_STOP) {
      if (stopping) return stopping;
      if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > MAX_STOP) return Promise.reject(refused(11, 9));
      retired = true; // Revoke admission synchronously, before the first await or native request.
      wakeObservation?.();
      let previous = 0, invalidStart = false;
      try { previous = clock(); if (!Number.isFinite(previous) || previous < 0) throw refused(11, 9); }
      catch (error) { invalidStart = true; callbacks.push(error); }
      const deadline = previous + timeoutMs; // Includes time awaiting the first microtask and every later yield.
      // Defer native work so a trusted callback's synchronous Stop revocation cannot close its in-flight launch handles.
      stopping = Promise.resolve().then(async () => {
        usable();
        let stopStage: FailureStage = 11;
        try {
          if (invalidStart) throw refused(11, 9);
          const within = () => { const now = clock(); if (!Number.isFinite(now) || now < previous || now > deadline) throw refused(stopStage, 9); previous = now; };
          within(); native.assertLimits(job!); within();
          if (root) {
            const status = native.wait(root.process);
            if (status !== 0 && status !== 258) throw refused(11, 2);
            if (status === 258) { rootStop = true; api.terminateProcess(root.process); }
          }
          jobStop = true; api.terminateJob(job!); within();
          stopStage = 12;
          // Yield rather than block Electron's main thread; every poll addresses the same retained objects.
          for (;;) {
            within(); const observed = state(); within();
            if (observed.active === 0) {
              let ready = true;
              for (const owner of root ? [root.process, root.thread] : []) {
                const status = native.wait(owner); if (status !== 0 && status !== 258) throw refused(12, 2); if (status === 258) ready = false; within();
              }
              if (ready) break;
            }
            if (previous === deadline) throw refused(12, 9);
            await new Promise<void>(resolve => setImmediate(resolve));
            usable();
          }
          native.assertLimits(job!); const final = state(); if (final.active !== 0) throw refused(12, 5);
          for (const owner of root ? [root.process, root.thread] : []) if (native.wait(owner) !== 0) throw refused(12, 5);
          within();
          // No later handle is touched after any uncertain close, including by best-effort Stop.
          stopStage = 13; disposalStarted = true;
          for (const owner of root ? [root.thread, root.process, job!] : [job!]) {
            closeAttempted.add(owner); if (native.close(owner) !== undefined) throw refused(13, 10); within();
          }
          closed = true; active!.delete(record); const receipt = Object.freeze({ scope: "root-only" as const }) as WindowsCommandRootOnlyStoppedRef;
          receipts.set(receipt, binding); completionFacts.set(receipt, Object.freeze({ rootPresent: root ? 1 : 0 }));
          const output = matchedOutputs.get(binding); if (output) releaseWindowsCommandOutputPI(output, receipt);
          return receipt;
        } catch (error) { return terminal(error, false, stopStage, 1); }
      });
      return stopping;
    },
  });
}
