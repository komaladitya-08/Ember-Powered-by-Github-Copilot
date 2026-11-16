/** Strict test-only pins/profile disposal for the root-only C witness. No project code or general launcher. */
import { createRequire } from "node:module";
import type * as Koffi from "koffi";
import type { WindowsLpacProfile } from "../../app/main/agent/experimental-windows-lpac-api";

type Fn = (...args: unknown[]) => unknown;
const valid = (value: unknown): value is bigint => typeof value === "bigint" && value > 0n && value < 0x8000000000000000n;
const dword = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
const boolean = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff && value !== 0;
export class WindowsCommandCopyProofCleanupError extends Error {
  constructor() { super("The root-only native witness retains unverified owners and private scratch."); this.name = "WindowsCommandCopyProofCleanupError"; }
}
export interface WindowsCommandCopyProofPin { readonly bytes: number; read(): Buffer; unchanged(): void; close(): void }
export const WINDOWS_COMMAND_COPY_PROOF_FUNCTIONS = {
  kernel32: [
    "void * __stdcall CreateFileW(const char16_t *file, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)",
    "int __stdcall GetFileInformationByHandle(void *file, void *information)", "uint32_t __stdcall GetFileType(void *file)",
    "int __stdcall GetHandleInformation(void *file, _Out_ uint32_t *flags)", "int __stdcall CloseHandle(void *handle)",
    "int __stdcall ReadFile(void *file, void *bytes, uint32_t count, _Out_ uint32_t *read, void *overlapped)",
    "int __stdcall SetFilePointerEx(void *file, int64_t offset, _Out_ int64_t *position, uint32_t method)",
    "uint32_t __stdcall GetProcessId(void *process)",
    "int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *name, _Inout_ uint32_t *characters)",
  ],
  userenv: ["int32_t __stdcall DeleteAppContainerProfile(const char16_t *name)"],
  advapi32: ["void * __stdcall FreeSid(void *sid)"],
} as const;
export interface WindowsCommandCopyProofNative {
  readonly unsafe: boolean;
  guard<T>(operation: () => T): T;
  pin(file: string, maximum: number): WindowsCommandCopyProofPin;
  image(process: bigint, pid: number, expected: string): void;
  close(handle: bigint): void;
  deleteProfile(profile: WindowsLpacProfile): void;
}
export function bindWindowsCommandCopyProofNative(load: (name: string) => { func(prototype: string): unknown }): WindowsCommandCopyProofNative {
  const fn: Record<string, Fn> = {}, handles = new Set<bigint>(), attempted = new Set<bigint>(), profiles = new Set<Readonly<WindowsLpacProfile>>(), profileSids = new Set<bigint>(), profileNames = new Set<string>(), retained: unknown[] = [];
  let unsafe = false;
  const fail = (): never => { unsafe = true; throw new WindowsCommandCopyProofCleanupError(); };
  const usable = () => { if (unsafe) fail(); };
  for (const [library, prototypes] of Object.entries(WINDOWS_COMMAND_COPY_PROOF_FUNCTIONS)) {
    const dll = load(`${library}.dll`);
    for (const prototype of prototypes) { const value = dll.func(prototype); if (typeof value !== "function") fail(); fn[/\b(\w+)\s*\(/.exec(prototype)![1]] = value as Fn; }
  }
  const call = (name: string, ...args: unknown[]): unknown => {
    usable(); const issued = { name, args, returned: undefined as unknown }; retained.push(issued);
    try { issued.returned = fn[name](...args); usable(); retained.pop(); return issued.returned; } catch { return fail(); }
  };
  const bool = (name: string, ...args: unknown[]) => { if (!boolean(call(name, ...args))) fail(); };
  const close = (handle: bigint) => {
    usable(); if (!valid(handle) || attempted.has(handle)) fail(); attempted.add(handle);
    bool("CloseHandle", handle); handles.delete(handle);
  };
  const info = (raw: bigint) => {
    const bytes = Buffer.alloc(52), inherited: unknown[] = [undefined];
    if (call("GetFileType", raw) !== 1) fail(); bool("GetHandleInformation", raw, inherited); if (inherited[0] !== 0) fail();
    bool("GetFileInformationByHandle", raw, bytes);
    if ((bytes.readUInt32LE(0) & 0x5650) !== 0 || bytes.readUInt32LE(40) !== 1) fail(); return bytes;
  };
  const stable = (a: Buffer, b: Buffer) => a.subarray(0, 12).equals(b.subarray(0, 12)) && a.subarray(20).equals(b.subarray(20));
  return {
    get unsafe() { return unsafe; },
    guard<T>(operation: () => T): T { usable(); const issued = { operation, returned: undefined as unknown }; retained.push(issued); try { issued.returned = operation(); usable(); retained.pop(); return issued.returned as T; } catch { return fail(); } }, close,
    pin(file, maximum) {
      usable(); if (!/^[A-Za-z]:\\/.test(file) || /[\p{Cc}\p{Cf}]/u.test(file) || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 16 * 1024 * 1024) fail();
      const opened = call("CreateFileW", file, 0x80000080, 1, null, 3, 0x00200000, null);
      if (!valid(opened) || handles.has(opened)) fail(); const raw = opened as bigint; handles.add(raw); attempted.delete(raw);
      const before = info(raw), size = before.readUInt32LE(32) * 0x100000000 + before.readUInt32LE(36);
      if (!Number.isSafeInteger(size) || size > maximum) fail(); let closed = false;
      const unchanged = () => { usable(); if (closed || !stable(before, info(raw))) fail(); };
      return Object.freeze({ bytes: size, unchanged,
        read() {
          unchanged(); const position: unknown[] = [undefined]; bool("SetFilePointerEx", raw, 0n, position, 0);
          if (position[0] !== 0 && position[0] !== 0n) fail();
          const bytes = Buffer.alloc(size), read: unknown[] = [undefined]; retained.push(bytes, read);
          bool("ReadFile", raw, bytes, size, read, null); if (read[0] !== size) fail(); unchanged(); retained.pop(); retained.pop(); return bytes;
        },
        close() { if (closed) return; close(raw); closed = true; },
      });
    },
    image(process, pid, expected) {
      usable(); if (!valid(process) || !dword(pid) || pid === 0 || call("GetProcessId", process) !== pid) fail();
      const bytes = Buffer.alloc(65536), count: unknown[] = [32768]; bool("QueryFullProcessImageNameW", process, 0, bytes, count);
      if (!dword(count[0]) || count[0] < 1 || count[0] > 32767 || bytes.toString("utf16le", 0, count[0] * 2).toLowerCase() !== expected.toLowerCase()) fail();
      bytes.fill(0);
    },
    deleteProfile(profile) {
      usable(); if (!profile || !valid(profile.sid) || typeof profile.name !== "string" || !profile.name || profileSids.has(profile.sid) || profileNames.has(profile.name.toLowerCase())) fail();
      const owned = Object.freeze({ name: profile.name, sid: profile.sid, sidText: profile.sidText });
      profiles.add(owned); profileSids.add(owned.sid); profileNames.add(owned.name.toLowerCase());
      if (call("DeleteAppContainerProfile", owned.name) !== 0) fail();
      const returned = call("FreeSid", owned.sid); if (returned !== null && returned !== 0n) fail();
    },
  };
}
export function loadWindowsCommandCopyProofNative(): WindowsCommandCopyProofNative {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("The root-only native witness requires Windows x64.");
  const koffi = createRequire(__filename)("koffi") as typeof Koffi;
  return bindWindowsCommandCopyProofNative(name => koffi.load(name));
}
