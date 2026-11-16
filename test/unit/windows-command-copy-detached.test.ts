/** Exact native adapter contract; no DLL is loaded and no native operation is executed. */
import fs from "node:fs";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { expect, it, vi } from "vitest";
import { WINDOWS_LPAC_FUNCTIONS } from "../../app/main/agent/experimental-windows-lpac-api";
import { bindWindowsRootCopyDetachedApi, windowsRootCopyDetachedLoader } from "../fixtures/windows-command-copy-detached-loader";
import { WINDOWS_ROOT_COPY_DETACHED_RUN as run } from "../fixtures/windows-command-copy-detached-variant";

const prototype = WINDOWS_LPAC_FUNCTIONS.kernel32.find(value => value.startsWith("int __stdcall CreateProcessW("))!;
const argumentsFor = (): unknown[] => ["fixed program", Buffer.alloc(4), null, null, 0, run.originalRootCreateFlags, Buffer.alloc(4), "fixed directory", Buffer.alloc(112), Buffer.alloc(24)];
function setup(...results: unknown[]) {
  const result = results.length ? results[0] : 1;
  const native = vi.fn(function (this: unknown, ..._args: unknown[]) { return result; });
  const bound = vi.fn((_prototype: string) => native), library = { func: bound }, load = vi.fn((_library: string) => library);
  return { native, bound, library, load, selected: windowsRootCopyDetachedLoader(load) };
}

it("changes only NO_WINDOW to DETACHED while preserving the same native receiver and other argument identities", () => {
  const s = setup(), args = argumentsFor(), receiver = Object.freeze({ fixed: true });
  const call = s.selected.load("kernel32.dll").func(prototype) as (...args: unknown[]) => unknown;
  s.selected.complete(); expect(Reflect.apply(call, receiver, args)).toBe(1);
  expect(s.native).toHaveBeenCalledTimes(1); expect(s.native.mock.contexts).toEqual([receiver]);
  for (let index = 0; index < args.length; index++) expect(s.native.mock.calls[0][index]).toBe(index === 5 ? run.rootCreateFlags : args[index]);
  expect(args[5]).toBe(run.originalRootCreateFlags); expect(run.originalRootCreateFlags ^ run.rootCreateFlags).toBe(0x08000008);
  expect(s.bound.mock.contexts).toEqual([s.library]); expect(s.bound).toHaveBeenCalledExactlyOnceWith(prototype);
});
it.each([undefined, null, false, true, "134743044", NaN, Infinity, 0n, 0, 8, run.rootCreateFlags, run.originalRootCreateFlags | 8,
  run.originalRootCreateFlags ^ 4, run.originalRootCreateFlags ^ 0x400, run.originalRootCreateFlags ^ 0x80000])("refuses unknown flags before a native call %#", flags => {
  const s = setup(), args = argumentsFor(), call = s.selected.load("kernel32.dll").func(prototype) as (...args: unknown[]) => unknown;
  args[5] = flags; expect(() => call(...args)).toThrow("changed native creation contract"); expect(s.native).not.toHaveBeenCalled();
});
it.each([0, 9, 11])("refuses a changed argument count %s before a native call", length => {
  const s = setup(), args = argumentsFor(), call = s.selected.load("kernel32.dll").func(prototype) as (...args: unknown[]) => unknown;
  args.length = length; expect(() => call(...args)).toThrow(); expect(s.native).not.toHaveBeenCalled();
});
it.each([0, -1, undefined, null, false, true, "1", 1n, Object.freeze({ fixed: true })])("preserves the exact returned native value without coercion %#", result => {
  const s = setup(result), call = s.selected.load("kernel32.dll").func(prototype) as (...args: unknown[]) => unknown;
  expect(call(...argumentsFor())).toBe(result); expect(s.native).toHaveBeenCalledTimes(1);
});
it("preserves a native thrown object and performs no recovery or error query", () => {
  const s = setup(), original = new Error("Fixed private synthetic native error");
  s.native.mockImplementation(() => { throw original; });
  const call = s.selected.load("kernel32.dll").func(prototype) as (...args: unknown[]) => unknown;
  let caught: unknown; try { call(...argumentsFor()); } catch (error) { caught = error; }
  expect(caught).toBe(original); expect(s.native).toHaveBeenCalledTimes(1); expect(s.bound).toHaveBeenCalledTimes(1);
});
it.each([["kernel32.dll", "uint32_t __stdcall GetLastError()"], ["kernel32.dll", prototype + " "], ["advapi32.dll", prototype]])(
  "preserves other library/prototype delegates %s", (library, signature) => {
    const s = setup(); expect(s.selected.load(library).func(signature)).toBe(s.native); expect(s.native).not.toHaveBeenCalled();
    if (library !== "kernel32.dll") expect(s.selected.load(library)).toBe(s.library);
  });
it("requires exactly one successfully bound entry and refuses duplicate binding before requesting another delegate", () => {
  const s = setup(); expect(s.selected.complete).toThrow();
  const library = s.selected.load("kernel32.dll"); library.func(prototype); expect(s.selected.complete).not.toThrow();
  expect(() => library.func(prototype)).toThrow(); expect(s.bound).toHaveBeenCalledTimes(1); expect(s.native).not.toHaveBeenCalled();
});
it.each([undefined, null, 0, "native"])("refuses malformed matching FFI bindings before exposing an API %#", value => {
  const selected = windowsRootCopyDetachedLoader(() => ({ func: () => value }));
  expect(() => selected.load("kernel32.dll").func(prototype)).toThrow(); expect(selected.complete).toThrow();
});
it("binds through the unchanged complete LPAC constructor without invoking a native function", () => {
  const s = setup(), libraries: string[] = [], prototypes: string[] = [];
  const koffi = { sizeof: () => 8, address: () => 1n, decode: Object.assign(() => Buffer.alloc(0), { string16: () => "" }) } as unknown as Parameters<typeof bindWindowsRootCopyDetachedApi>[0];
  const api = bindWindowsRootCopyDetachedApi(koffi, library => { libraries.push(library); return { func(signature) { prototypes.push(signature); return s.native; } }; });
  expect(typeof api.createSuspended).toBe("function"); expect(s.native).not.toHaveBeenCalled();
  expect(libraries).toEqual(Object.keys(WINDOWS_LPAC_FUNCTIONS).map(library => `${library}.dll`));
  expect(prototypes).toEqual(Object.values(WINDOWS_LPAC_FUNCTIONS).flat());
});
it.each(["win32", "linux"])("the emitted default loader roots Koffi at __filename and refuses unsupported host %s before loading", host => {
  const filename = "/trusted/fixed-detached-loader.cjs", locations: unknown[] = [], calls: string[] = [], api = Object.freeze({ fixed: true });
  const source = fs.readFileSync(new URL("../fixtures/windows-command-copy-detached-loader.ts", import.meta.url), "utf8");
  const emitted = transformSync(source, { loader: "ts", format: "cjs", platform: "node", target: "node22" }).code;
  const module = { exports: {} as { loadWindowsRootCopyDetachedApi(): unknown } };
  const koffi = { load(library: string) { calls.push(library); return { func: () => () => 1 }; } };
  const require = (name: string): unknown => {
    if (name === "node:module") return { createRequire(location: unknown) { locations.push(location); return (requested: string) => { expect(requested).toBe("koffi"); return koffi; }; } };
    if (name === "../../app/main/platform/os") return { HOST_PLATFORM: host, HOST_ARCH: "x64" };
    if (name === "./windows-command-copy-detached-variant") return { WINDOWS_ROOT_COPY_DETACHED_RUN: run };
    if (name === "../../app/main/agent/experimental-windows-lpac-api") return { LPAC_CREATE_FLAGS: run.originalRootCreateFlags,
      bindExperimentalWindowsLpacApi(actual: unknown, load: (name: string) => { func(signature: string): unknown }) {
        expect(actual).toBe(koffi); load("kernel32.dll").func(prototype); return api;
      } };
    throw new Error("The emitted fixed loader requested an unexpected dependency.");
  };
  runInNewContext(emitted, { module, exports: module.exports, require, __filename: filename, Reflect, Buffer });
  if (host === "win32") { expect(module.exports.loadWindowsRootCopyDetachedApi()).toBe(api); expect(locations).toEqual([filename]); expect(calls).toEqual(["kernel32.dll"]); }
  else { expect(() => module.exports.loadWindowsRootCopyDetachedApi()).toThrow("Windows x64"); expect(locations).toEqual([]); expect(calls).toEqual([]); }
});
