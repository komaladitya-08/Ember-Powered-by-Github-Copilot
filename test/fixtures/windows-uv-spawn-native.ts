/** Fixed uv-spawn file pins and suspended-image checks; canonical Node authority is untouched. */
import { createRequire } from "node:module";
import type * as Koffi from "koffi";
import type { WindowsHandle } from "../../app/main/agent/experimental-windows-lpac-api";
import { ordinaryWindowsCommandAssetSize } from "../../app/main/agent/isolated-windows-command-assets";
import { WindowsNodeHostCleanupError } from "./windows-node-lpac-startup";
import { bindWindowsNodeSourceChildIo, type WindowsNodeSourceChildIoFence } from "./windows-node-source-child-io";
import { bindWindowsNodeSourceChildObserver, type WindowsNodeSourceChildObserverFence } from "./windows-node-source-child-observer";
import type { WindowsLpacProfile, WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";
type Native = (...args: unknown[]) => unknown;
export interface WindowsUvSpawnChecksFence { unsafe: boolean; retained: unknown[] }
const defaultFence: WindowsUvSpawnChecksFence = { unsafe: false, retained: [] };
const stable = (a: Buffer, b: Buffer) => a.subarray(0, 12).equals(b.subarray(0, 12)) && a.subarray(20).equals(b.subarray(20));
export function bindWindowsUvSpawnChecks(koffi: Pick<typeof Koffi, "sizeof">, load: (name: string) => { func(prototype: string): unknown }, fence: WindowsUvSpawnChecksFence = defaultFence) {
  if (fence.unsafe || koffi.sizeof("void *") !== 8) throw new WindowsNodeHostCleanupError();
  const kernel = load("kernel32.dll"), fn: Record<string, Native> = {}, held = new Set<WindowsHandle>();
  for (const signature of [
    "void * __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)",
    "int __stdcall GetFileInformationByHandle(void *file, void *information)", "int __stdcall CloseHandle(void *file)",
    "uint32_t __stdcall GetProcessId(void *process)",
    "int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *image, _Inout_ uint32_t *size)",
  ]) fn[/\b(\w+)\s*\(/.exec(signature)![1]] = kernel.func(signature) as Native;
  const valid = (value: unknown): value is WindowsHandle => typeof value === "bigint" && value > 0n && value < 0x8000000000000000n;
  const fail = (): never => { fence.unsafe = true; fence.retained.push({ held, fn }); throw new WindowsNodeHostCleanupError(); };
  const usable = () => { if (fence.unsafe) throw new WindowsNodeHostCleanupError(); };
  const invoke = (name: string, ...args: unknown[]): unknown => {
    usable(); let result: unknown;
    try { result = fn[name](...args); } catch { return fail(); }
    // A swallowed reentrant failure revokes the returned value as well as all later native calls.
    if (fence.unsafe) { fence.retained.push({ name, result }); return fail(); }
    return result;
  };
  const close = (handle: WindowsHandle) => {
    // Remove release authority before the only attempt, preserving the value in the fence on failure.
    held.delete(handle);
    try { if (invoke("CloseHandle", handle) !== 1) { fence.retained.push({ handle }); fail(); } }
    catch { fence.retained.push({ handle }); fail(); }
  };
  return {
    pin(file: string, maximum: number) {
      usable(); let handle: unknown, before: Buffer | undefined, acquired = false;
      try {
        if (!/^[A-Za-z]:\\/.test(file) || !Number.isInteger(maximum) || maximum < 1 || maximum > 16 * 1024 * 1024) fail();
        handle = invoke("CreateFileW", file, 0x80000080, 1, null, 3, 0x00200000, null);
        if (!valid(handle)) return fail();
        if (held.has(handle)) return fail();
        held.add(handle); acquired = true;
        const inspect = () => { const bytes = Buffer.alloc(52); if (invoke("GetFileInformationByHandle", handle, bytes) !== 1) throw new Error(); return bytes; };
        before = inspect(); const bytes = ordinaryWindowsCommandAssetSize(before); if (bytes > maximum) throw new Error();
        let open = true;
        return { file, bytes, unchanged() { usable(); try { if (!open || !stable(before!, inspect())) fail(); } catch { fail(); } },
          close() { usable(); if (!open) return; open = false; close(handle as WindowsHandle); } };
      } catch {
        if (acquired && valid(handle) && held.has(handle)) try { close(handle); } catch { /* Preserve failed-close ownership in the fence. */ }
        fence.retained.push({ handle, before }); return fail();
      }
    },
    image(process: WindowsHandle, pid: number, expected: string) {
      usable();
      try {
        if (!valid(process) || !Number.isInteger(pid) || pid < 1 || pid > 0xffffffff || !/^[A-Za-z]:\\/.test(expected)) fail();
        const bytes = Buffer.alloc(65536), count = [32768];
        if (invoke("GetProcessId", process) !== pid || invoke("QueryFullProcessImageNameW", process, 0, bytes, count) !== 1 || !Number.isInteger(count[0]) || count[0] < 1 || count[0] > 32767 ||
            bytes.toString("utf16le", 0, count[0] * 2).toLowerCase() !== expected.toLowerCase()) fail();
      } catch { fail(); }
    },
  };
}
export function loadWindowsUvSpawnChecks() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new WindowsNodeHostCleanupError();
  const koffi = createRequire(import.meta.url)("koffi") as typeof Koffi;
  return bindWindowsUvSpawnChecks(koffi, name => koffi.load(name));
}

type LibraryLoader = (name: string) => { func(prototype: string): unknown };
type SharedFence = { failure?: Error; retained: unknown[] };
/** Keep the existing IO/observer APIs, while fencing a callback that swallows a nested native failure. */
function guardedLibraries(load: LibraryLoader, fence: SharedFence): LibraryLoader {
  return name => { const library = load(name); return { func(prototype) {
    const native = library.func(prototype);
    if (typeof native !== "function") throw new WindowsNodeHostCleanupError();
    return (...args: unknown[]) => {
      if (fence.failure) throw fence.failure;
      let value: unknown;
      try { value = native(...args); }
      // The owning IO/observer catches this and retains its complete binding before poisoning the shared fence.
      catch { throw new WindowsNodeHostCleanupError(); }
      if (fence.failure) { fence.retained.push(value); throw fence.failure; }
      return value;
    };
  } }; };
}

/** Exactly the existing two-handle launcher: no policy, console or child flag variation. */
export function bindWindowsUvSpawnIo(koffi: Pick<typeof Koffi, "sizeof" | "address">, load: LibraryLoader, state: string,
  profile: WindowsLpacProfile, api: Pick<WindowsLpacApi, "ownerSid">, role: "host" | "lpac", fence: WindowsNodeSourceChildIoFence = { retained: [] }) {
  return bindWindowsNodeSourceChildIo(koffi, guardedLibraries(load, fence), state, profile, api, role, fence);
}

/** The ACK follows held-child token/image/job observations; it is not pre-execution admission. */
export function bindWindowsUvSpawnObserver(koffi: Pick<typeof Koffi, "sizeof">, load: LibraryLoader, fence: WindowsNodeSourceChildObserverFence = { retained: [] }) {
  return bindWindowsNodeSourceChildObserver(koffi, guardedLibraries(load, fence), fence);
}

const retainedNativeOwners: unknown[] = [];
function trustedKoffi() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new WindowsNodeHostCleanupError();
  return createRequire(import.meta.url)("koffi") as typeof Koffi;
}
export function loadWindowsUvSpawnIo(state: string, profile: WindowsLpacProfile, api: Pick<WindowsLpacApi, "ownerSid">, role: "host" | "lpac") {
  const koffi = trustedKoffi(), fence: WindowsNodeSourceChildIoFence = { retained: [] };
  retainedNativeOwners.push(fence);
  return bindWindowsUvSpawnIo(koffi, name => koffi.load(name), state, profile, api, role, fence);
}
export function loadWindowsUvSpawnObserver() {
  const koffi = trustedKoffi(), fence: WindowsNodeSourceChildObserverFence = { retained: [] };
  retainedNativeOwners.push(fence);
  return bindWindowsUvSpawnObserver(koffi, name => koffi.load(name), fence);
}

/** Limit two processes in the outer job; libuv's own job behavior is left unchanged. */
export function bindWindowsUvSpawnJob(koffi: Pick<typeof Koffi, "sizeof">, load: LibraryLoader) {
  if (koffi.sizeof("void *") !== 8) throw new WindowsNodeHostCleanupError();
  const kernel = load("kernel32.dll"), set = kernel.func("int __stdcall SetInformationJobObject(void *job, int kind, void *information, uint32_t size)") as Native,
    query = kernel.func("int __stdcall QueryInformationJobObject(void *job, int kind, void *information, uint32_t size, void *returned)") as Native;
  let unsafe = false;
  const invoke = (operation: Native, ...args: unknown[]) => {
    if (unsafe) throw new WindowsNodeHostCleanupError();
    const value = operation(...args);
    if (unsafe) { retainedNativeOwners.push(value); throw new WindowsNodeHostCleanupError(); }
    return value;
  };
  return { setTwo(job: WindowsHandle) {
    if (unsafe) throw new WindowsNodeHostCleanupError();
    try {
      if (typeof job !== "bigint" || job <= 0n || job >= 0x8000000000000000n) throw new Error();
      const before = Buffer.alloc(144), ui = Buffer.alloc(4);
      if (invoke(query, job, 9, before, 144, null) !== 1 || invoke(query, job, 4, ui, 4, null) !== 1 || before.readUInt32LE(16) !== 0x2000 || before.readUInt32LE(40) !== 0 || ui.readUInt32LE() !== 0) throw new Error();
      const requested = Buffer.from(before); requested.writeUInt32LE(0x2008, 16); requested.writeUInt32LE(2, 40);
      if (invoke(set, job, 9, requested, 144) !== 1) throw new Error();
      const after = Buffer.alloc(144);
      if (invoke(query, job, 9, after, 144, null) !== 1 || invoke(query, job, 4, ui, 4, null) !== 1 || !after.equals(requested) || ui.readUInt32LE() !== 0) throw new Error();
    } catch { unsafe = true; retainedNativeOwners.push({ job, set, query }); throw new WindowsNodeHostCleanupError(); }
  } };
}
export function loadWindowsUvSpawnJob() {
  const koffi = trustedKoffi(); return bindWindowsUvSpawnJob(koffi, name => koffi.load(name));
}
