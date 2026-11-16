/** Lazy exit query for an already-held root. This module never opens, waits for or closes a process. */
import { createRequire } from "node:module";
import type * as Koffi from "koffi";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import type { WindowsHandle } from "./experimental-windows-lpac-api";
import { WindowsCodingCleanupError } from "./windows-coding-native";

export interface WindowsCommandRootOnlyExitNative { exitCode(process: WindowsHandle): number }
export const WINDOWS_COMMAND_ROOT_ONLY_EXIT_FUNCTION = "int __stdcall GetExitCodeProcess(void *process, _Out_ uint32_t *code)";
export class WindowsCommandRootOnlyExitCleanupError extends WindowsCodingCleanupError {
  constructor() { super(); this.name = "WindowsCommandRootOnlyExitCleanupError"; this.message = "The held Windows command root's exit could not be verified."; }
}
const retained: unknown[] = [];
const handle = (value: unknown): value is WindowsHandle => typeof value === "bigint" && value > 0n && value < 0x8000000000000000n;
const bool = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= -0x80000000 && value <= 0x7fffffff;

/** The caller must first observe this exact held process as signalled. DWORD 259 can then be its real exit code. */
export function bindWindowsCommandRootOnlyExitNative(koffi: Pick<typeof Koffi, "sizeof">,
  load: (name: string) => { func(prototype: string): unknown }): WindowsCommandRootOnlyExitNative {
  const pending = new Set<Buffer>();
  let failure: WindowsCommandRootOnlyExitCleanupError | undefined, library: unknown, query: unknown, busy = false;
  const poison = (extra?: unknown): never => {
    if (!failure) {
      failure = new WindowsCommandRootOnlyExitCleanupError();
      // An unknown native return can still refer to its output buffer or library. Retain the actual owners.
      retained.push({ koffi, load, pending, library, query, extra, failure });
    }
    throw failure;
  };
  try {
    if (koffi.sizeof("void *") !== 8 || koffi.sizeof("uint32_t") !== 4 || koffi.sizeof("int") !== 4) poison();
    const loaded = load("kernel32.dll"); library = loaded;
    query = loaded.func(WINDOWS_COMMAND_ROOT_ONLY_EXIT_FUNCTION);
    if (typeof query !== "function") poison();
  } catch (error) { poison(error); }
  return Object.freeze({ exitCode(process: WindowsHandle): number {
    if (failure) throw failure;
    if (busy) poison();
    if (!handle(process)) poison();
    const bytes = Buffer.alloc(4); pending.add(bytes);
    busy = true;
    try {
      const returned: unknown = (query as (...args: unknown[]) => unknown)(process, bytes);
      // A synchronous native/test callback cannot swallow a nested first failure and publish plausible output.
      if (failure) throw failure;
      if (!bool(returned) || returned === 0 || bytes.length !== 4 || bytes.byteLength !== 4) poison();
      const code = bytes.readUInt32LE(0);
      bytes.fill(0); pending.delete(bytes); return code;
    } catch (error) { return poison(error); }
    finally { busy = false; }
  } });
}

let loaded: WindowsCommandRootOnlyExitNative | undefined, loadFailure: WindowsCommandRootOnlyExitCleanupError | undefined;
export function loadWindowsCommandRootOnlyExitNative(): WindowsCommandRootOnlyExitNative {
  if (loadFailure) throw loadFailure;
  if (loaded) return loaded;
  if (HOST_PLATFORM !== "win32" || HOST_ARCH !== "x64") throw loadFailure = new WindowsCommandRootOnlyExitCleanupError();
  try {
    const koffi = createRequire(__filename)("koffi") as typeof Koffi;
    return loaded = bindWindowsCommandRootOnlyExitNative(koffi, name => koffi.load(name));
  } catch { throw loadFailure = new WindowsCommandRootOnlyExitCleanupError(); }
}
