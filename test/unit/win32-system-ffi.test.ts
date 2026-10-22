/**
 * Windows system integration's bindings (win32/system/ffi.ts) on Linux: every C declaration parses with koffi's own
 * parser, nothing is loaded off Windows, and the wrappers do the right thing with what fake DLLs hand back: registry
 * out-parameters, the settings broadcast made only through koffi's asynchronous call (never synchronously on the main
 * thread), the screen-reader flag, the token's elevation (the token always closed), session ids, Windows' folders
 * (asked again with room when the buffer was too small), known folders (decoded from real native memory, then freed
 * with CoTaskMemFree whether or not the call succeeded), installed packages and a window's monitor. A missing function
 * makes only its own method answer "unavailable".
 */

import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import type { LibraryHandle } from "koffi";
import {
  bindWin32System, functionName, guidBytes, loadWin32System, UNAVAILABLE, WIN32_SYSTEM_FUNCTIONS, wideString,
} from "../../app/main/platform/win32/system/ffi";
import { FOLDERID } from "../../app/main/platform/win32/system/known-folders";

const requireCjs = createRequire(import.meta.url);
const koffi = requireCjs("koffi") as typeof import("koffi");

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- fake DLL functions take what koffi would pass
type Impl = (...args: any[]) => unknown;

/** Fake DLLs: every function returns 0 unless `impls` says otherwise; `asyncImpls` back each function's .async. */
function fakeLoad(impls: Record<string, Impl> = {}, o: { missing?: string[]; missingLibraries?: string[]; asyncImpls?: Record<string, Impl> } = {}) {
  const calls: { name: string; args: unknown[]; async: boolean }[] = [];
  const load = (library: string): Pick<LibraryHandle, "func"> => {
    if (o.missingLibraries?.includes(library)) throw new Error(`${library} not found`);
    return {
      func: ((declaration: string) => {
        const name = functionName(declaration);
        if (o.missing?.includes(name)) throw new Error(`${name} not found`);
        const fn = (...args: unknown[]) => {
          calls.push({ name, args, async: false });
          return impls[name] ? impls[name](...args) : 0;
        };
        fn.async = (...args: unknown[]) => {
          calls.push({ name, args, async: true });
          const cb = args[args.length - 1] as (err: unknown, r: unknown) => void;
          const impl = o.asyncImpls?.[name];
          if (impl) impl(...args); else cb(null, 0);
        };
        return fn;
      }) as unknown as LibraryHandle["func"],
    };
  };
  return { load, calls, called: (name: string) => calls.filter(c => c.name === name) };
}

describe("the Windows system declarations", () => {
  it("all parse with koffi's prototype parser, each function named once", () => {
    const all = Object.values(WIN32_SYSTEM_FUNCTIONS).flat();
    const tag = Math.random().toString(36).slice(2, 8);
    for (const declaration of all) {
      const name = functionName(declaration);
      // A unique name: koffi registers prototypes by name for the whole process (port/win32's tests bind some of these too).
      expect(() => koffi.proto(declaration.replace(`${name}(`, `W32Sys_${tag}_${name}(`)), declaration).not.toThrow();
    }
    const names = all.map(functionName);
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain("");
  });

  it.skipIf(process.platform === "win32")("aren't loaded off Windows, and koffi isn't touched", () => {
    const load = koffi.load;
    const loaded: unknown[] = [];
    koffi.load = ((...args: unknown[]) => { loaded.push(args[0]); return load.apply(koffi, args as Parameters<typeof load>); }) as typeof load;
    try {
      expect(loadWin32System()).toBeNull();
    } finally {
      koffi.load = load;
    }
    expect(loaded).toEqual([]);
  });
});

describe("guidBytes and wideString", () => {
  it("lays a KNOWNFOLDERID out as Windows stores a GUID (first three groups little-endian)", () => {
    expect(guidBytes(FOLDERID.Programs).toString("hex")).toBe("775d7fa72b2ec344a6a2aba601054a51");
    expect(guidBytes("{0139D44E-6AFE-49F2-8690-3DAFCAE6FFB8}").toString("hex")).toBe("4ed43901fe6af2498690" + "3dafcae6ffb8");
    expect(() => guidBytes("not-a-guid")).toThrow(/GUID/);
  });

  it("makes a NUL-terminated UTF-16 string", () => {
    expect(wideString("Hé")).toEqual(Buffer.from([0x48, 0, 0xe9, 0, 0, 0]));
  });
});

describe("binding the Windows system API", () => {
  it("reads registry values through RegGetValueW's out-parameters", () => {
    const f = fakeLoad({
      RegGetValueW: (hive: number, sub: string, value: string, flags: number, type: number[], data: Buffer | null, size: number[]) => {
        expect([hive, sub, value, flags]).toEqual([-2147483646, "SOFTWARE\\Policies\\Ember", "PolicyJson", 0x10022]);
        type[0] = 7;
        if (data) data.write("{}\0", "utf16le");
        size[0] = 6;
        return 0;
      },
    });
    const api = bindWin32System(koffi, f.load);
    expect(api.regGetValue(-2147483646, "SOFTWARE\\Policies\\Ember", "PolicyJson", 0x10022, null)).toEqual({ status: 0, type: 7, size: 6 });
    const data = Buffer.alloc(6);
    api.regGetValue(-2147483646, "SOFTWARE\\Policies\\Ember", "PolicyJson", 0x10022, data);
    expect(data.toString("utf16le")).toBe("{}\0");
    expect(f.called("RegGetValueW")[0].args[6]).toEqual([6]); // the size starts as the buffer's (0 for a size query)
    expect(f.called("RegGetValueW")[0].args[5]).toBeNull();
  });

  it("writes a value with its byte length", () => {
    const f = fakeLoad({ RegSetKeyValueW: () => 0 });
    const api = bindWin32System(koffi, f.load);
    expect(api.regSetValue(-2147483647, "Software\\X", "V", 4, Buffer.alloc(4))).toBe(0);
    expect(f.called("RegSetKeyValueW")[0].args.slice(0, 4)).toEqual([-2147483647, "Software\\X", "V", 4]);
    expect(f.called("RegSetKeyValueW")[0].args[5]).toBe(4);
  });

  it("broadcasts WM_SETTINGCHANGE only through koffi's asynchronous call, with SMTO_ABORTIFHUNG | SMTO_BLOCK", () => {
    let finish: ((err: unknown, r: unknown) => void) | null = null;
    const f = fakeLoad({}, { asyncImpls: { SendMessageTimeoutW: (...args: unknown[]) => { finish = args[7] as typeof finish; } } });
    const api = bindWin32System(koffi, f.load);
    const results: boolean[] = [];
    expect(api.broadcastSettingChange("ImmersiveColorSet", 1000, ok => results.push(ok))).toBe(true);
    const [call] = f.called("SendMessageTimeoutW");
    expect(call.async).toBe(true);
    expect(f.calls.filter(c => c.name === "SendMessageTimeoutW" && !c.async)).toEqual([]);
    expect(call.args.slice(0, 3)).toEqual([0xffff, 0x1a, 0]);
    expect((call.args[3] as Buffer).toString("utf16le")).toBe("ImmersiveColorSet\0");
    expect(call.args.slice(4, 6)).toEqual([3, 1000]);
    expect(results).toEqual([]); // not waited for
    finish!(null, 1n);
    expect(results).toEqual([true]);
  });

  it("reports a broadcast that couldn't start, or that failed", () => {
    const full = bindWin32System(koffi, fakeLoad({}, { asyncImpls: { SendMessageTimeoutW: () => { throw new Error("queue full"); } } }).load);
    expect(full.broadcastSettingChange("ImmersiveColorSet", 1000)).toBe(false);
    const results: boolean[] = [];
    const failed = bindWin32System(koffi, fakeLoad({}, { asyncImpls: { SendMessageTimeoutW: (...a: unknown[]) => (a[7] as (e: unknown, r: unknown) => void)(null, 0) } }).load);
    failed.broadcastSettingChange("ImmersiveColorSet", 1000, ok => results.push(ok));
    expect(results).toEqual([false]);
  });

  it("asks SPI_GETSCREENREADER, null when the call fails", () => {
    let ok = 1;
    const api = bindWin32System(koffi, fakeLoad({ SystemParametersInfoW: (action: number, _p: number, v: number[]) => { expect(action).toBe(0x46); v[0] = 1; return ok; } }).load);
    expect(api.screenReader()).toBe(true);
    ok = 0;
    expect(api.screenReader()).toBeNull();
  });

  it("reads the token's elevation and always closes the token", () => {
    const token = { handle: "token" };
    let elevation = 1;
    const f = fakeLoad({
      GetCurrentProcess: () => "self",
      OpenProcessToken: (process: unknown, access: number, out: unknown[]) => { expect([process, access]).toEqual(["self", 8]); out[0] = token; return 1; },
      GetTokenInformation: (t: unknown, kind: number, buf: Buffer, size: number) => { expect([t, kind, size]).toEqual([token, 20, 4]); buf.writeUInt32LE(elevation, 0); return 1; },
      CloseHandle: () => 1,
    });
    const api = bindWin32System(koffi, f.load);
    expect(api.elevated()).toBe(true);
    elevation = 0;
    expect(api.elevated()).toBe(false);
    expect(f.called("CloseHandle").map(c => c.args[0])).toEqual([token, token]);
    const denied = bindWin32System(koffi, fakeLoad({ GetCurrentProcess: () => "self" }).load);
    expect(denied.elevated()).toBeNull();
  });

  it("reads the session id", () => {
    const api = bindWin32System(koffi, fakeLoad({ ProcessIdToSessionId: (pid: number, out: number[]) => { out[0] = pid === 7 ? 0 : 2; return 1; } }).load);
    expect(api.sessionId(7)).toBe(0);
    expect(api.sessionId(8)).toBe(2);
  });

  it("reads Windows' folders, asking again with room when the first buffer was too small", () => {
    const long = `C:\\${"x".repeat(300)}`;
    const f = fakeLoad({
      GetWindowsDirectoryW: (buf: Buffer, size: number) => { buf.write("C:\\Windows", "utf16le"); expect(size).toBe(260); return 10; },
      GetSystemDirectoryW: (buf: Buffer, size: number) => { if (size <= long.length) return long.length + 1; buf.write(long, "utf16le"); return long.length; },
    });
    const api = bindWin32System(koffi, f.load);
    expect(api.windowsDirectory()).toBe("C:\\Windows");
    expect(api.systemDirectory()).toBe(long);
    expect(f.called("GetSystemDirectoryW").map(c => c.args[1])).toEqual([260, long.length + 1]);
    expect(bindWin32System(koffi, fakeLoad().load).windowsDirectory()).toBeNull();
  });

  it("decodes a known folder from native memory and frees it with CoTaskMemFree, also when the call fails", () => {
    const text = wideString("C:\\Users\\José\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs");
    const pointer = koffi.address(text);
    let hr = 0;
    const f = fakeLoad({
      SHGetKnownFolderPath: (id: Buffer, flags: number, token: unknown, out: unknown[]) => {
        expect(id.toString("hex")).toBe(guidBytes(FOLDERID.Programs).toString("hex"));
        expect([flags, token]).toEqual([0, null]);
        out[0] = pointer;
        return hr;
      },
    });
    const api = bindWin32System(koffi, f.load);
    expect(api.knownFolder(FOLDERID.Programs)).toBe("C:\\Users\\José\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs");
    hr = -2147024894; // HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND)
    expect(api.knownFolder(FOLDERID.Programs)).toBeNull();
    expect(f.called("CoTaskMemFree").map(c => c.args[0])).toEqual([pointer, pointer]);
  });

  it("tells an installed package family from one that isn't, and can't-tell from both", () => {
    const f = fakeLoad({
      GetPackagesByPackageFamily: (family: string, count: number[], names: unknown, length: number[], buffer: unknown) => {
        expect([names, buffer, length[0]]).toEqual([null, null, 0]);
        if (family.startsWith("Microsoft.WindowsCalculator")) { count[0] = 1; return 122; }
        if (family === "bad") return 87;
        count[0] = 0;
        return 0;
      },
    });
    const api = bindWin32System(koffi, f.load);
    expect(api.packageFamilyInstalled("Microsoft.WindowsCalculator_8wekyb3d8bbwe")).toBe(true);
    expect(api.packageFamilyInstalled("Microsoft.WindowsTerminal_8wekyb3d8bbwe")).toBe(false);
    expect(api.packageFamilyInstalled("bad")).toBeNull();
  });

  it("reads the monitor a window is on", () => {
    const f = fakeLoad({
      MonitorFromWindow: (hwnd: number, flags: number) => { expect([hwnd, flags]).toEqual([0x40, 2]); return "monitor"; },
      GetMonitorInfoW: (_m: unknown, info: Buffer) => {
        expect(info.readUInt32LE(0)).toBe(40);
        [-1920, 0, 0, 1080].forEach((v, i) => info.writeInt32LE(v, 4 + i * 4));
        return 1;
      },
    });
    const api = bindWin32System(koffi, f.load);
    expect(api.monitorRect(0x40)).toEqual({ x: -1920, y: 0, width: 1920, height: 1080 });
    expect(api.monitorRect(0)).toBeNull();
  });

  it("makes only the missing function's method unavailable", () => {
    const api = bindWin32System(koffi, fakeLoad({ ProcessIdToSessionId: (_p: number, out: number[]) => { out[0] = 1; return 1; } }, {
      missing: ["GetPackagesByPackageFamily"], missingLibraries: ["advapi32.dll", "shell32.dll"],
    }).load);
    expect(api.packageFamilyInstalled("x")).toBeNull();
    expect(api.regGetValue(-2147483646, "k", "v", 2, null).status).toBe(UNAVAILABLE);
    expect(api.regSetValue(-2147483647, "k", "v", 4, Buffer.alloc(4))).toBe(UNAVAILABLE);
    expect(api.elevated()).toBeNull();
    expect(api.knownFolder(FOLDERID.Programs)).toBeNull();
    expect(api.sessionId(1)).toBe(1);
  });
});
