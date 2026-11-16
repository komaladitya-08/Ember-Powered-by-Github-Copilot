/** Policy-only fixed-file pins and suspended-image checks; canonical Node verification is untouched. */
import { createRequire } from "node:module";
import type * as Koffi from "koffi";
import type { WindowsHandle } from "../../app/main/agent/experimental-windows-lpac-api";
import { ordinaryWindowsCommandAssetSize } from "../../app/main/agent/isolated-windows-command-assets";
import { WindowsNodeHostCleanupError } from "./windows-node-lpac-startup";
type Native = (...args: unknown[]) => unknown;
export interface WindowsChildPolicyChecksFence { unsafe: boolean; retained: unknown[] }
const defaultFence: WindowsChildPolicyChecksFence = { unsafe: false, retained: [] };
const stable = (a: Buffer, b: Buffer) => a.subarray(0, 12).equals(b.subarray(0, 12)) && a.subarray(20).equals(b.subarray(20));
export function bindWindowsChildPolicyChecks(koffi: Pick<typeof Koffi, "sizeof">, load: (name: string) => { func(prototype: string): unknown }, fence: WindowsChildPolicyChecksFence = defaultFence) {
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
export function loadWindowsChildPolicyChecks() {
  if (process.platform !== "win32" || process.arch !== "x64") throw new WindowsNodeHostCleanupError();
  const koffi = createRequire(import.meta.url)("koffi") as typeof Koffi;
  return bindWindowsChildPolicyChecks(koffi, name => koffi.load(name));
}
