/** Fixed test-only root flag comparison. The canonical LPAC API and every other native argument stay unchanged. */
import { createRequire } from "node:module";
import type * as Koffi from "koffi";
import { HOST_ARCH, HOST_PLATFORM } from "../../app/main/platform/os";
import { bindExperimentalWindowsLpacApi, LPAC_CREATE_FLAGS } from "../../app/main/agent/experimental-windows-lpac-api";
import { WINDOWS_ROOT_COPY_DETACHED_RUN as run } from "./windows-command-copy-detached-variant";

const CREATE_PROCESS = "int __stdcall CreateProcessW(const char16_t *program, void *command, void *processSecurity, void *threadSecurity, int inherit, uint32_t flags, void *environment, const char16_t *directory, void *startup, void *information)";
type Load = Parameters<typeof bindExperimentalWindowsLpacApi>[1];
const refused = () => new Error("The fixed detached-copy loader refused a changed native creation contract.");

/** Binding is complete only after exactly one known entry was adapted; neither arbitrary flags nor native calls are added. */
export function windowsRootCopyDetachedLoader(load: Load) {
  let intercepted = 0;
  return Object.freeze({
    load: (library: string) => {
      const loaded = load(library);
      if (library !== "kernel32.dll") return loaded;
      return { func(prototype: string) {
        if (prototype !== CREATE_PROCESS) return loaded.func(prototype);
        if (intercepted !== 0) throw refused();
        const original = loaded.func(prototype);
        if (typeof original !== "function") throw refused();
        intercepted++;
        return function (this: unknown, ...args: unknown[]) {
          if (args.length !== 10 || args[5] !== run.originalRootCreateFlags) throw refused();
          const detached = [...args]; detached[5] = run.rootCreateFlags;
          return Reflect.apply(original, this, detached);
        };
      } };
    },
    complete: () => { if (intercepted !== 1) throw refused(); },
  });
}

export function bindWindowsRootCopyDetachedApi(koffi: Parameters<typeof bindExperimentalWindowsLpacApi>[0], load: Load) {
  if (LPAC_CREATE_FLAGS !== run.originalRootCreateFlags) throw refused();
  const selected = windowsRootCopyDetachedLoader(load);
  const api = bindExperimentalWindowsLpacApi(koffi, selected.load); selected.complete(); return api;
}

/** Same trusted Koffi/default binding as the canonical API; the closed flag comparison is selected only by this fixture. */
export function loadWindowsRootCopyDetachedApi() {
  if (HOST_PLATFORM !== "win32" || HOST_ARCH !== "x64") throw new Error("The detached-copy comparison requires Windows x64.");
  const koffi = createRequire(__filename)("koffi") as typeof Koffi;
  return bindWindowsRootCopyDetachedApi(koffi, name => koffi.load(name));
}
