/** Fixed source-Node observation only. A child's ACK follows trusted running initialization; it is not pre-execution admission. */
import { createRequire } from "node:module";
import path from "node:path/win32";
import type * as Koffi from "koffi";
import type { WindowsHandle } from "../../app/main/agent/experimental-windows-lpac-api";
import { WindowsNodeHostCleanupError } from "./windows-node-lpac-startup";

type NativeFunction = (...args: unknown[]) => unknown;
const MAX_MEMBERS = 8;
const refusal = () => new Error("The fixed source-Node child observation contract was refused.");
export class WindowsNodeSourceChildObserverCleanupError extends WindowsNodeHostCleanupError {
  constructor() { super(); this.message = "The source-Node child observer could not verify complete ownership; retain its private owners."; this.name = "WindowsNodeSourceChildObserverCleanupError"; }
}
export interface WindowsNodeSourceChildObserverFence { failure?: WindowsNodeSourceChildObserverCleanupError; retained: unknown[] }
export interface WindowsNodeSourceChildObserverInput {
  job: WindowsHandle;
  rootProcess: WindowsHandle;
  rootPid: number;
  image: string;
  current(): boolean;
  /** Synchronous inspection of the already-running child's exact package/zero-capability/AAP or ordinary-host token. */
  verifyToken(child: WindowsHandle): void;
  /** Synchronous fixed ACK observation only; no arbitrary command or transferred handle is admitted. */
  grant(childPid: number): void;
}
export interface WindowsNodeSourceChildObserverObservation { operation: number; domain: number; code: number; tracked: number; candidates: number }
const processFence: WindowsNodeSourceChildObserverFence = { retained: [] };
export const WINDOWS_NODE_SOURCE_CHILD_FUNCTIONS = [
  "uint32_t __stdcall GetLastError()",
  "void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)",
  "uint32_t __stdcall GetProcessId(void *process)",
  "int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *image, _Inout_ uint32_t *size)",
  "int __stdcall IsProcessInJob(void *process, void *job, _Out_ int *member)",
  "int __stdcall QueryInformationJobObject(void *job, int kind, void *information, uint32_t size, void *returned)",
  "uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)",
  "int __stdcall CloseHandle(void *handle)",
] as const;
const handle = (value: unknown): value is WindowsHandle => typeof value === "bigint" && value > 0n && value < 0x8000000000000000n;
const bool = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
const pid = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0xffffffff;
const imagePath = (value: unknown): value is string => typeof value === "string" && value.length <= 32767 && /^[A-Za-z]:\\/.test(value) &&
  !/[/\p{Cc}\p{Cf}<>"|?*]/u.test(value) && path.normalize(value) === value &&
  value.slice(3).split("\\").every(part => part.length > 0 && !part.includes(":") && !/[. ]$/.test(part));
const sameSet = (left: readonly number[], right: readonly number[]) => left.length === right.length && left.every(value => right.includes(value));

/** Portable FFI seam. Native loading occurs only in the explicit Win64 loader below. */
export function bindWindowsNodeSourceChildObserver(koffi: Pick<typeof Koffi, "sizeof">, load: (name: string) => { func(prototype: string): unknown },
  fence: WindowsNodeSourceChildObserverFence = processFence, clock: () => number = () => performance.now()) {
  if (fence.failure) throw fence.failure;
  const fn: Record<string, NativeFunction> = {};
  try {
    if (koffi.sizeof("void *") !== 8) throw refusal();
    const library = load("kernel32.dll");
    for (const prototype of WINDOWS_NODE_SOURCE_CHILD_FUNCTIONS) {
      const value = library.func(prototype); if (typeof value !== "function") throw refusal();
      fn[/\b(\w+)\s*\(/.exec(prototype)![1]] = value as NativeFunction;
    }
  } catch { throw refusal(); }
  type Member = { handle: WindowsHandle; pid: number; expected: boolean; closeAttempted: boolean };
  const owned = new Map<number, Member>();
  let binding: Readonly<WindowsNodeSourceChildObserverInput> | undefined, observedChild: number | null = null, closed = false;
  let operation = 0, domain = 0, code = 0, refused: WindowsNodeSourceChildObserverObservation | undefined;
  const at = (value: number) => { operation = value; domain = 0; code = 0; };
  const snapshot = (): WindowsNodeSourceChildObserverObservation => ({ operation, domain, code, tracked: owned.size,
    candidates: [...owned.values()].filter(value => value.expected).length });
  const terminal = (extra?: unknown, observation = snapshot()): never => {
    refused ??= observation;
    if (!fence.failure) { fence.failure = new WindowsNodeSourceChildObserverCleanupError(); fence.retained.push({ owned, binding, fn, extra }); }
    throw fence.failure;
  };
  const usable = () => { if (fence.failure) throw fence.failure; if (closed) throw refusal(); };
  const requireBinding = () => { if (!binding) throw refusal(); return binding; };
  const nativeRefusal = () => {
    // Only an explicit native FALSE/NULL/WAIT_FAILED permits inspecting its immediate numeric TLS error.
    try { const value = fn.GetLastError(); if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff) { domain = 2; code = value; } }
    catch { /* Unknown ABI/error state remains domain/code zero. */ }
    return refusal();
  };
  const exited = (process: WindowsHandle): boolean => {
    at(17); const value = fn.WaitForSingleObject(process, 0);
    if (value === 0) return true; if (value === 258) return false;
    throw value === 0xffffffff ? nativeRefusal() : refusal();
  };
  const identity = (process: WindowsHandle, expectedPid: number): boolean => {
    const exact = requireBinding();
    at(8); const observedPid = fn.GetProcessId(process);
    if (observedPid !== expectedPid) throw observedPid === 0 ? nativeRefusal() : refusal();
    const image = Buffer.alloc(65536), length: unknown[] = [32768];
    try {
      at(9); const result = fn.QueryFullProcessImageNameW(process, 0, image, length);
      if (!bool(result)) throw refusal(); if (result === 0) throw nativeRefusal();
      at(10); if (!pid(length[0]) || length[0] > 32767) throw refusal();
      const text = image.toString("utf16le", 0, length[0] * 2);
      if (/[\p{Cc}\p{Cf}]/u.test(text)) throw refusal();
      at(11); const member: unknown[] = [0], contained = fn.IsProcessInJob(process, exact.job, member);
      if (!bool(contained)) throw refusal(); if (contained === 0) throw nativeRefusal();
      if (!bool(member[0]) || member[0] === 0) throw refusal();
      return text.toLowerCase() === exact.image.toLowerCase();
    } finally { image.fill(0); }
  };
  const members = (): number[] => {
    const exact = requireBinding(), bytes = Buffer.alloc(8 + MAX_MEMBERS * 8);
    try {
      at(3); const result = fn.QueryInformationJobObject(exact.job, 3, bytes, bytes.length, null);
      if (!bool(result)) throw refusal(); if (result === 0) throw nativeRefusal();
      at(4); const assigned = bytes.readUInt32LE(0), listed = bytes.readUInt32LE(4);
      if (assigned !== listed || listed > MAX_MEMBERS) throw refusal();
      at(5); const found: number[] = [];
      for (let index = 0; index < listed; index++) {
        const value = bytes.readBigUInt64LE(8 + index * 8);
        if (value === 0n || value > 0xffffffffn || found.includes(Number(value))) throw refusal();
        found.push(Number(value));
      }
      return found;
    } finally { bytes.fill(0); }
  };
  const inspect = (selected: number): Member => {
    const exact = requireBinding(); if (selected === exact.rootPid) throw refusal();
    let value = owned.get(selected);
    if (!value) {
      at(7); if (owned.size >= MAX_MEMBERS - 1) throw refusal();
      const opened = fn.OpenProcess(0x101000, 0, selected);
      if (opened === null || opened === 0n) throw nativeRefusal();
      if (!handle(opened) || opened === exact.job || opened === exact.rootProcess || [...owned.values()].some(item => item.handle === opened)) return terminal(opened);
      value = { handle: opened, pid: selected, expected: false, closeAttempted: false };
      owned.set(selected, value); // Retain every known acquired handle before its first fallible query.
    }
    if (exited(value.handle)) throw refusal(); // A signalled object is never re-opened or replaced for a PID seen again.
    value.expected = identity(value.handle, selected); return value;
  };
  const sample = () => {
    const exact = requireBinding(), found = members(); at(6);
    if (!found.includes(exact.rootPid)) throw refusal();
    for (const value of owned.values()) if (!found.includes(value.pid) && !exited(value.handle)) throw refusal();
    const selected = found.filter(value => value !== exact.rootPid).map(inspect);
    return { found, selected, candidates: selected.filter(value => value.expected) };
  };
  const rootCurrent = () => {
    const exact = requireBinding(); at(2);
    if (exact.current() !== true || exited(exact.rootProcess) || !identity(exact.rootProcess, exact.rootPid)) throw refusal();
  };
  const requireJobZero = () => {
    const exact = requireBinding(), accounting = Buffer.alloc(48);
    try {
      at(18); const result = fn.QueryInformationJobObject(exact.job, 1, accounting, accounting.length, null);
      if (!bool(result)) throw refusal(); if (result === 0) throw nativeRefusal();
      if (accounting.readUInt32LE(40) !== 0 || members().length !== 0) throw refusal();
    } finally { accounting.fill(0); }
  };
  const requireStopped = () => {
    usable();
    try {
      const exact = requireBinding(); requireJobZero();
      if (!exited(exact.rootProcess)) throw refusal();
      for (const value of owned.values()) if (!exited(value.handle)) throw refusal();
    } catch (error) { terminal(error); }
  };
  return {
    /** Bind once while the caller still holds the root suspended; no token callback or child ACK is performed here. */
    bind(input: WindowsNodeSourceChildObserverInput): void {
      usable(); if (binding) throw refusal();
      try {
        if (!input || !handle(input.job) || !handle(input.rootProcess) || input.job === input.rootProcess || !pid(input.rootPid) || !imagePath(input.image) ||
          typeof input.current !== "function" || typeof input.verifyToken !== "function" || typeof input.grant !== "function") throw refusal();
        binding = Object.freeze({ job: input.job, rootProcess: input.rootProcess, rootPid: input.rootPid, image: input.image,
          current: input.current, verifyToken: input.verifyToken, grant: input.grant });
      } catch { throw refusal(); }
      try { rootCurrent(); sample(); } catch (error) { terminal(error); }
    },
    /** Observe an already-running exact child. Token verification and stable native job snapshots precede its fixed ACK. */
    admit(): number | null {
      usable(); const exact = requireBinding(); if (observedChild !== null) throw refusal();
      try {
        rootCurrent(); const first = sample(); at(19);
        if (first.candidates.length > 1) throw refusal();
        if (first.candidates.length === 0) return null;
        const candidate = first.candidates[0];
        at(12); if (exact.verifyToken(candidate.handle) !== undefined) throw refusal();
        rootCurrent(); const second = sample();
        if (!sameSet(first.found, second.found)) return null;
        at(19); if (second.candidates.length !== 1 || second.candidates[0] !== candidate) throw refusal();
        const final = sample(); if (!sameSet(second.found, final.found)) return null;
        at(19); if (final.candidates.length !== 1 || final.candidates[0] !== candidate) throw refusal();
        rootCurrent(); if (exited(candidate.handle)) throw refusal();
        at(15); if (exact.grant(candidate.pid) !== undefined) throw refusal();
        observedChild = candidate.pid; return observedChild;
      } catch (error) { return terminal(error); }
    },
    requireStopped,
    /** Caller shares one absolute monotonic Stop deadline, including its earlier whole-job termination time. */
    waitStoppedBefore(deadline: number): void {
      usable();
      try {
        const exact = requireBinding(); let previous = clock();
        if (!Number.isFinite(previous) || previous < 0 || !Number.isFinite(deadline) || deadline < previous || deadline - previous > 15_000) throw refusal();
        const withinDeadline = () => {
          const current = clock(); if (!Number.isFinite(current) || current < previous || current > deadline) throw refusal(); previous = current; return current;
        };
        requireJobZero();
        for (const process of [exact.rootProcess, ...[...owned.values()].map(value => value.handle)]) {
          const now = withinDeadline(); at(20); const result = fn.WaitForSingleObject(process, Math.floor(deadline - now));
          if (result !== 0) { if (result === 0xffffffff) nativeRefusal(); throw refusal(); }
          withinDeadline();
        }
        requireStopped(); withinDeadline();
      } catch (error) { terminal(error); }
    },
    closeStopped(): void {
      if (closed) return; usable(); requireStopped();
      for (const value of owned.values()) {
        at(16); value.closeAttempted = true;
        let result: unknown;
        try {
          result = fn.CloseHandle(value.handle);
        } catch (error) { terminal(error); }
        if (!bool(result) || result === 0) { if (result === 0) nativeRefusal(); terminal(result); }
      }
      closed = true;
    },
    observation: (): WindowsNodeSourceChildObserverObservation => ({ ...(refused ?? snapshot()) }),
  };
}
export function loadWindowsNodeSourceChildObserver(): ReturnType<typeof bindWindowsNodeSourceChildObserver> {
  if (process.platform !== "win32" || process.arch !== "x64") throw refusal();
  if (processFence.failure) throw processFence.failure;
  try {
    const koffi = createRequire(import.meta.url)("koffi") as typeof Koffi;
    return bindWindowsNodeSourceChildObserver(koffi, name => koffi.load(name));
  } catch (error) { if (error instanceof WindowsNodeSourceChildObserverCleanupError) throw error; throw refusal(); }
}
