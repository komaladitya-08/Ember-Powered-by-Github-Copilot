/** Root-only flag comparison: original IO/ownership checks, exact CreateProcessW gate, no caller-selected flags. */
import { createRequire } from "node:module";
import type * as Koffi from "koffi";
import { bindWindowsChildProcessPolicyIo, type WindowsChildProcessPolicyIoFence, type WindowsChildProcessPolicyIoOwner } from "./windows-child-process-policy-io";
import { WINDOWS_CHILD_POLICY_DETACHED_VARIANT as variant } from "./windows-child-process-policy-detached-variant";
export { WindowsChildProcessPolicyIoCleanupError } from "./windows-child-process-policy-io";

const CREATE_PROCESS = "int __stdcall CreateProcessW(const char16_t *program, void *command, void *processSecurity, void *threadSecurity, int inherit, uint32_t flags, void *environment, const char16_t *directory, void *startup, void *information)";
type Load = Parameters<typeof bindWindowsChildProcessPolicyIo>[1];
const processFence: WindowsChildProcessPolicyIoFence = { retained: [] };

/** Wraps only the exact native entry; every other prototype and every non-flag argument keeps its original identity. */
export function windowsChildPolicyDetachedRootLoader(load: Load): Load {
  return library => {
    const loaded = load(library);
    return { func(prototype) {
      const original = loaded.func(prototype);
      if (library !== "kernel32.dll" || prototype !== CREATE_PROCESS || typeof original !== "function") return original;
      return (...args: unknown[]) => {
        if (args.length !== 10 || args[5] !== variant.originalRootCreateFlags)
          throw new Error("The detached-root comparison refused a changed native creation contract.");
        const detached = [...args]; detached[5] = variant.rootCreateFlags;
        return (original as (...values: unknown[]) => unknown)(...detached);
      };
    } };
  };
}

/** The original constructor still owns attributes, two IO handles, pins, reset windows and terminal fences. */
export function bindWindowsChildProcessPolicyDetachedIo(koffi: Parameters<typeof bindWindowsChildProcessPolicyIo>[0], load: Load,
  stateDir: Parameters<typeof bindWindowsChildProcessPolicyIo>[2], profile: Parameters<typeof bindWindowsChildProcessPolicyIo>[3],
  api: Parameters<typeof bindWindowsChildProcessPolicyIo>[4], fence: WindowsChildProcessPolicyIoFence = processFence,
  birthPolicy: 0 | 1 | 2 = 0): WindowsChildProcessPolicyIoOwner {
  return bindWindowsChildProcessPolicyIo(koffi, windowsChildPolicyDetachedRootLoader(load), stateDir, profile, api, fence, birthPolicy);
}

/** Trusted Win64 loader only; the mode is fixed by this module, never an environment value or tool argument. */
export function loadWindowsChildProcessPolicyDetachedIo(stateDir: Parameters<typeof bindWindowsChildProcessPolicyIo>[2],
  profile: Parameters<typeof bindWindowsChildProcessPolicyIo>[3], api: Parameters<typeof bindWindowsChildProcessPolicyIo>[4], birthPolicy: 0 | 1 | 2): WindowsChildProcessPolicyIoOwner {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("The detached-root comparison requires Windows x64.");
  const koffi = createRequire(import.meta.url)("koffi") as typeof Koffi;
  return bindWindowsChildProcessPolicyDetachedIo(koffi, name => koffi.load(name), stateDir, profile, api, undefined, birthPolicy);
}
