/** Test-only admission of one suspended inherited-token child. No token, ACL, job or process policy is changed. */
import { createRequire } from "node:module";
import type * as Koffi from "koffi";
import type { WindowsHandle } from "../../app/main/agent/experimental-windows-lpac-api";

type NativeFunction = (...args: unknown[]) => unknown;
/** Closed host-side diagnostics. No native text, path, SID or arbitrary errno string is returned. */
export function inheritedChildNumericFailure(error: unknown): { domain: number; code: number } {
  const unknown = { domain: 0, code: 0 };
  try {
    if (!(error instanceof Error)) return unknown;
    const nodeCodes = ["EACCES", "EPERM", "ENOENT", "EEXIST", "ENOTDIR", "ELOOP", "ETIMEDOUT", "ENOBUFS"];
    const nodeIndex = nodeCodes.indexOf((error as NodeJS.ErrnoException).code ?? "");
    if (nodeIndex >= 0) return { domain: 1, code: nodeIndex + 1 };
    const windows = /^(?:CloseHandle|OpenProcessToken|ConvertSidToStringSidW|GetTokenInformation\(\d+\)|GetVolumeInformationW|CreateDirectoryW|CreateFileW\((?:directory|CREATE_NEW)\)|GetFileInformationByHandle|WriteFile|ConvertStringSecurityDescriptorToSecurityDescriptorW) failed \(Windows error (0|[1-9]\d{0,9})\)\.$/.exec(error.message);
    const hresult = /^(?:CreateAppContainerProfile|DeleteAppContainerProfile|GetAppContainerFolderPath) failed \(HRESULT (0|[1-9]\d{0,9})\)(?:\.|; no profile is adopted\.)$/.exec(error.message);
    const match = windows ?? hresult;
    if (match && Number(match[1]) <= 0xffffffff) return { domain: windows ? 2 : 3, code: Number(match[1]) };
  } catch { /* Unknown host/ABI error shapes remain unclassified. */ }
  return unknown;
}
export function inheritedChildCompilerFailure(text: string): { domain: number; code: number } {
  // Compiler output is inspected in memory and never included in the resulting exception or receipt.
  const match = /\b(?:fatal )?error (C\d{4}|LNK\d{4})\b/.exec(text);
  return match ? { domain: match[1].startsWith("C") ? 4 : 5, code: Number(match[1].replace(/\D/g, "")) } : { domain: 0, code: 0 };
}
export function inheritedChildVisualStudioRange(runner: string | undefined): string {
  if (runner === undefined || runner === "windows-2022") return "[17.0,18.0)";
  if (runner === "windows-2025") return "[18.0,19.0)";
  throw new Error("The inherited-child probe requires a fixed reviewed Windows compiler image.");
}
const MAX_PIDS = 8;
const failure = () => new Error("The inherited-child probe could not verify its fixed native admission contract.");
export class InheritedChildCleanupError extends Error {
  constructor() { super("The inherited-child probe could not verify handle cleanup; retain its private fixture."); this.name = "InheritedChildCleanupError"; }
}
export interface InheritedChildFence { failure?: InheritedChildCleanupError; retained: unknown[] }
const processFence: InheritedChildFence = { retained: [] };
export const INHERITED_CHILD_FUNCTIONS = [
  "uint32_t __stdcall GetLastError()",
  "void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)",
  "uint32_t __stdcall GetProcessId(void *process)",
  "int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *image, _Inout_ uint32_t *size)",
  "int __stdcall IsProcessInJob(void *process, void *job, _Out_ int *member)",
  "int __stdcall QueryInformationJobObject(void *job, int kind, void *information, uint32_t size, void *returned)",
  "int __stdcall CloseHandle(void *handle)",
] as const;
const handle = (value: unknown): value is WindowsHandle => typeof value === "bigint" && value > 0n && value < 0x8000000000000000n;
const bool = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;
const pid = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 0xffffffff;
export interface InheritedChildAdmission {
  job: WindowsHandle; rootProcess: WindowsHandle; rootPid: number; image: string;
  current(): boolean;
  /** Exact freshly created profile, package, zero-capability and own-package/AAP witness; synchronous only. */
  verifyToken(process: WindowsHandle): void;
  /** Writes only the fixed magic + this native child PID. No arbitrary commands or inherited handles. */
  grant(childPid: number): void;
}

/** Portable native-binding seam; the actual Windows integration supplies only its owned root/job/profile. */
export function bindInheritedChildObserver(koffi: Pick<typeof Koffi, "sizeof">, load: (name: string) => { func(prototype: string): unknown },
  fence: InheritedChildFence = processFence) {
  if (fence.failure) throw fence.failure;
  const fn: Record<string, NativeFunction> = {};
  try {
    if (koffi.sizeof("void *") !== 8) throw failure();
    const dll = load("kernel32.dll");
    for (const prototype of INHERITED_CHILD_FUNCTIONS) {
      const value = dll.func(prototype); if (typeof value !== "function") throw failure();
      fn[/\b(\w+)\s*\(/.exec(prototype)![1]] = value as NativeFunction;
    }
  } catch { throw failure(); }
  let operation = 0, domain = 0, code = 0;
  let imageObservation: { lengthValid: boolean; lengthUint32: boolean; characters: number; shape: number; basename: number; shortComponent: boolean; exact: boolean; extendedExact: boolean } | undefined;
  const at = (value: number) => { operation = value; domain = 0; code = 0; };
  const nativeRefusal = () => {
    // Capture only an explicit native FALSE/NULL's immediate error, before any later close/query changes TLS.
    try { const value = fn.GetLastError(); if (typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff) { domain = 2; code = value; } }
    catch { /* Unknown native/ABI error metadata remains unclassified. */ }
    return failure();
  };
  const usable = () => { if (fence.failure) throw fence.failure; };
  const members = (job: WindowsHandle): number[] => {
    usable(); if (!handle(job)) throw failure();
    const bytes = Buffer.alloc(8 + MAX_PIDS * 8);
    try {
      at(3);
      const ok = fn.QueryInformationJobObject(job, 3, bytes, bytes.length, null);
      if (!bool(ok)) throw failure(); if (ok === 0) throw nativeRefusal();
      at(4);
      const assigned = bytes.readUInt32LE(0), listed = bytes.readUInt32LE(4);
      if (assigned !== listed || listed > MAX_PIDS) throw failure();
      at(5);
      const result: number[] = [];
      for (let index = 0; index < listed; index++) {
        const value = bytes.readBigUInt64LE(8 + index * 8);
        if (value === 0n || value > 0xffffffffn || result.includes(Number(value))) throw failure();
        result.push(Number(value));
      }
      return result;
    } catch { throw failure(); } finally { bytes.fill(0); }
  };
  return { members, observation: () => ({ operation, domain, code, ...(imageObservation ? { image: { ...imageObservation } } : {}) }), admit(input: InheritedChildAdmission): number | null {
    usable(); at(1); imageObservation = undefined;
    if (!input || !handle(input.job) || !handle(input.rootProcess) || input.rootProcess === input.job || !pid(input.rootPid) || typeof input.image !== "string" || !/^[A-Za-z]:\\/.test(input.image) || /[\p{Cc}\p{Cf}]/u.test(input.image) ||
      typeof input.current !== "function" || typeof input.verifyToken !== "function" || typeof input.grant !== "function") throw failure();
    let process: WindowsHandle | undefined, uncertain = false, failed = false, admitted: number | null = null;
    const buffers: Buffer[] = [];
    try {
      at(2);
      if (input.current() !== true) throw failure();
      const found = members(input.job);
      at(6);
      if (!found.includes(input.rootPid) || found.length < 1 || found.length > 2) throw failure();
      if (found.length === 1) return null;
      const child = found.find(value => value !== input.rootPid)!;
      let opened: unknown;
      at(7);
      try { opened = fn.OpenProcess(0x1000, 0, child); } catch { uncertain = true; throw failure(); }
      if (opened === null || opened === 0n) throw nativeRefusal();
      if (!handle(opened) || opened === input.job || opened === input.rootProcess) { uncertain = true; throw failure(); }
      process = opened;
      at(8); const observedPid = fn.GetProcessId(process);
      if (observedPid !== child) throw observedPid === 0 ? nativeRefusal() : failure();
      const image = Buffer.alloc(65536), length: unknown[] = [32768]; buffers.push(image);
      at(9);
      const named = fn.QueryFullProcessImageNameW(process, 0, image, length);
      if (!bool(named)) throw failure(); if (named === 0) throw nativeRefusal();
      at(10);
      const lengthValid = pid(length[0]) && length[0] <= 32767;
      const observedImage = lengthValid ? image.toString("utf16le", 0, (length[0] as number) * 2).toLowerCase() : "";
      const basename = observedImage.slice(observedImage.lastIndexOf("\\") + 1), expectedImage = input.image.toLowerCase();
      const lengthUint32 = typeof length[0] === "number" && Number.isInteger(length[0]) && length[0] >= 0 && length[0] <= 0xffffffff;
      imageObservation = { lengthValid, lengthUint32, characters: lengthUint32 ? length[0] as number : 0,
        shape: /^[a-z]:\\/.test(observedImage) ? 1 : /^\\\\\?\\[a-z]:\\/.test(observedImage) ? 2 : observedImage.startsWith("\\device\\") ? 3 : observedImage.startsWith("\\\\") ? 4 : 0,
        basename: basename === "fixture.exe" ? 1 : basename === "conhost.exe" ? 2 : 0,
        shortComponent: /(?:^|\\)[^\\]*~\d+(?:\\|$)/.test(observedImage),
        exact: observedImage === expectedImage, extendedExact: observedImage.startsWith("\\\\?\\") && observedImage.slice(4) === expectedImage };
      if (!lengthValid || !imageObservation.exact) throw failure();
      at(11);
      const member: unknown[] = [0], contained = fn.IsProcessInJob(process, input.job, member);
      if (!bool(contained)) throw failure(); if (contained === 0) throw nativeRefusal();
      if (!bool(member[0]) || member[0] === 0) throw failure();
      at(12); if (input.verifyToken(process) !== undefined) throw failure();
      at(13); if (input.current() !== true) throw failure();
      const final = members(input.job);
      at(14);
      if (final.length !== 2 || !final.includes(input.rootPid) || !final.includes(child)) throw failure();
      at(15);
      if (input.grant(child) !== undefined) throw failure();
      admitted = child;
    } catch (error) { failed = true; if (error instanceof InheritedChildCleanupError) uncertain = true; }
    finally {
      if (process !== undefined) try {
        const closed = fn.CloseHandle(process);
        if (!bool(closed) || closed === 0) { at(16); if (closed === 0) nativeRefusal(); uncertain = true; }
      } catch { at(16); uncertain = true; }
      if (uncertain) {
        fence.failure ??= new InheritedChildCleanupError(); fence.retained.push({ process, buffers, input, fn });
      } else for (const buffer of buffers) buffer.fill(0);
    }
    if (fence.failure) throw fence.failure;
    if (failed) throw failure();
    return admitted;
  } };
}
export function loadInheritedChildObserver(): ReturnType<typeof bindInheritedChildObserver> {
  if (process.platform !== "win32" || process.arch !== "x64") throw failure();
  if (processFence.failure) throw processFence.failure;
  try { const koffi = createRequire(import.meta.url)("koffi") as typeof Koffi; return bindInheritedChildObserver(koffi, name => koffi.load(name)); }
  catch (error) { if (error instanceof InheritedChildCleanupError) throw error; throw failure(); }
}
