/**
 * The Win32 calls Windows system integration makes (registry, the token's elevation, the session, Windows' own
 * folders, known folders, packaged apps, the screen-reader flag, one settings broadcast and a window's monitor),
 * through koffi. The window system's bindings stay port/win32's (loadWin32() in ../ffi.ts); these are bound here
 * once per process, lazily and only on Windows, so this module imports cleanly on every OS (tests import it on Linux).
 *
 * Rules kept here:
 * - Native memory is copied with koffi.decode; koffi.view() would abort Electron (V8 memory cage).
 * - Structures and out-strings go in Buffers passed as `void *` (no koffi struct types, so no process-wide type names).
 * - Win32 BOOL is `int`; predefined HKEYs are passed as `intptr_t` (sign-extended: HKEY_CURRENT_USER = -2147483647).
 * - Nothing here waits on another process on Electron's main thread: the one broadcast (WM_SETTINGCHANGE to every
 *   top-level window) runs through koffi's asynchronous call, on its worker thread, and is never awaited.
 * - Every function is optional: one that isn't there makes only its own method answer "unavailable" (null, or the
 *   UNAVAILABLE status), never the whole API, so a missing shell32 export doesn't lock down the admin policy.
 */

import { createRequire } from "node:module";
import type { Rect } from "../../types";

/** What RegGetValueW answered: its status (ERROR_*, or UNAVAILABLE), the value's REG_* type and its size in bytes. */
export interface RegRaw { status: number; type: number; size: number }

/** The status a method gives when its function couldn't be bound (no Win32 error uses a negative number). */
export const UNAVAILABLE = -1;

/** The Win32 calls system integration needs, with plain values. */
export interface Win32SysApi {
  /** RegGetValueW into `data` (null: the size only). `flags` are RRF_* (types allowed, WOW64 view). */
  regGetValue(hive: number, subKey: string, value: string, flags: number, data: Buffer | null): RegRaw;
  /** RegSetKeyValueW: the status (ERROR_SUCCESS 0). */
  regSetValue(hive: number, subKey: string, value: string, type: number, data: Buffer): number;
  /**
   * SendMessageTimeoutW(HWND_BROADCAST, WM_SETTINGCHANGE, 0, area, SMTO_ABORTIFHUNG | SMTO_BLOCK, timeoutMs) through
   * koffi's asynchronous call, so a slow app never stalls Ember's main thread. False when it couldn't be started;
   * `done` hears whether it completed.
   */
  broadcastSettingChange(area: string, timeoutMs: number, done?: (ok: boolean) => void): boolean;
  /** SystemParametersInfoW(SPI_GETSCREENREADER): is a screen reader running? null when it can't be asked. */
  screenReader(): boolean | null;
  /** TokenElevation of Ember's own token; null when it can't be read. */
  elevated(): boolean | null;
  /** ProcessIdToSessionId; null when it fails. */
  sessionId(pid: number): number | null;
  /** GetSystemDirectoryW ("C:\Windows\System32"). */
  systemDirectory(): string | null;
  /** GetWindowsDirectoryW ("C:\Windows"). */
  windowsDirectory(): string | null;
  /** SHGetKnownFolderPath of a KNOWNFOLDERID ("{…}"), freed with CoTaskMemFree; null when it fails. */
  knownFolder(id: string): string | null;
  /** GetPackagesByPackageFamily: is a package of this family installed for this user? null when it can't be asked. */
  packageFamilyInstalled(family: string): boolean | null;
  /** The monitor rectangle (physical pixels) of the monitor a window is on (MonitorFromWindow + GetMonitorInfoW). */
  monitorRect(hwnd: number): Rect | null;
}

const ERROR_SUCCESS = 0, ERROR_INSUFFICIENT_BUFFER = 122;
const HWND_BROADCAST = 0xffff, WM_SETTINGCHANGE = 0x001a, SMTO_BLOCK = 0x0001, SMTO_ABORTIFHUNG = 0x0002;
const SPI_GETSCREENREADER = 0x0046, TOKEN_QUERY = 0x0008, TOKEN_ELEVATION = 20, MONITOR_DEFAULTTONEAREST = 2;
/** MONITORINFO: cbSize, rcMonitor, rcWork, dwFlags. */
const MONITORINFO_SIZE = 40;
/** Windows' folders are at most MAX_PATH long, but a longer one is asked for again with room for it. */
const PATH_UNITS = 260;

const requireCjs = createRequire(__filename);
type Koffi = typeof import("koffi");

/**
 * Every function bound here, by DLL, in koffi's prototype syntax: the one place their C types live (the design's
 * §9.1 and §9.3 signatures; out-parameters a caller keeps are Buffers passed as `void *`).
 */
export const WIN32_SYSTEM_FUNCTIONS: Readonly<Record<string, readonly string[]>> = {
  "advapi32.dll": [
    "int32_t __stdcall RegGetValueW(intptr_t hkey, const char16_t *subKey, const char16_t *value, uint32_t flags, _Out_ uint32_t *type, void *data, _Inout_ uint32_t *cbData)",
    "int32_t __stdcall RegSetKeyValueW(intptr_t hkey, const char16_t *subKey, const char16_t *value, uint32_t type, void *data, uint32_t cbData)",
    "int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)",
    "int __stdcall GetTokenInformation(void *token, int kind, void *buf, uint32_t size, _Out_ uint32_t *returned)",
  ],
  "user32.dll": [
    // lParam and the result are Buffers (not a JS string and an array): an asynchronous call reads and writes them
    // after this function has returned, so they must be memory the caller keeps alive.
    "intptr_t __stdcall SendMessageTimeoutW(intptr_t hwnd, uint32_t msg, uintptr_t wParam, void *lParam, uint32_t flags, uint32_t timeoutMs, void *result)",
    "int __stdcall SystemParametersInfoW(uint32_t action, uint32_t param, _Out_ int *pv, uint32_t winIni)",
    "void * __stdcall MonitorFromWindow(void *hwnd, uint32_t flags)",
    "int __stdcall GetMonitorInfoW(void *monitor, void *info)",
  ],
  "kernel32.dll": [
    "uint32_t __stdcall GetSystemDirectoryW(void *buf, uint32_t size)",
    "uint32_t __stdcall GetWindowsDirectoryW(void *buf, uint32_t size)",
    "void * __stdcall GetCurrentProcess()",
    "int __stdcall CloseHandle(void *handle)",
    "int __stdcall ProcessIdToSessionId(uint32_t pid, _Out_ uint32_t *session)",
    "int32_t __stdcall GetPackagesByPackageFamily(const char16_t *family, _Inout_ uint32_t *count, void *names, _Inout_ uint32_t *bufferLength, void *buffer)",
  ],
  "shell32.dll": [
    "int32_t __stdcall SHGetKnownFolderPath(void *id, uint32_t flags, void *token, _Out_ void **path)",
  ],
  "ole32.dll": [
    "void __stdcall CoTaskMemFree(void *pv)",
  ],
};

/** The function name in a prototype ("int __stdcall CloseHandle(void *handle)" → "CloseHandle"). */
export function functionName(declaration: string): string {
  return /(\w+)\s*\(/.exec(declaration)?.[1] ?? "";
}

/** A KNOWNFOLDERID's 16 bytes from its "{8-4-4-4-12}" text (the first three groups little-endian, as GUIDs are stored). */
export function guidBytes(text: string): Buffer {
  const m = /^\{?([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})\}?$/i.exec(text.trim());
  if (!m) throw new Error(`not a GUID: ${text}`);
  const buf = Buffer.alloc(16);
  buf.writeUInt32LE(parseInt(m[1], 16), 0);
  buf.writeUInt16LE(parseInt(m[2], 16), 4);
  buf.writeUInt16LE(parseInt(m[3], 16), 6);
  Buffer.from(m[4] + m[5], "hex").copy(buf, 8);
  return buf;
}

/** A NUL-terminated UTF-16LE string's Buffer (what a `void *` string parameter of a W function takes). */
export function wideString(s: string): Buffer {
  return Buffer.from(`${s}\0`, "utf16le");
}

/** A bound function, or null for one that isn't there. */
type Bound = (((...args: unknown[]) => any) & { async?: (...args: unknown[]) => void }) | null; // eslint-disable-line @typescript-eslint/no-explicit-any -- koffi's results are untyped

/** Binds WIN32_SYSTEM_FUNCTIONS from the libraries `load` opens; anything missing is null. */
function bindFunctions(load: (name: string) => Pick<import("koffi").LibraryHandle, "func">): Record<string, Bound> {
  const fns: Record<string, Bound> = {};
  for (const [library, declarations] of Object.entries(WIN32_SYSTEM_FUNCTIONS)) {
    let lib: Pick<import("koffi").LibraryHandle, "func"> | null = null;
    try {
      lib = load(library);
    } catch {
      // That library's functions stay null: their methods answer "unavailable".
    }
    for (const declaration of declarations) {
      const name = functionName(declaration);
      try {
        fns[name] = lib ? (lib.func(declaration) as unknown as Bound) : null;
      } catch {
        fns[name] = null; // GetPackagesByPackageFamily is Windows 8+; anything else missing is unexpected but survivable
      }
    }
  }
  return fns;
}

/** The bound API, once per process (undefined: not tried yet; null: not available). */
let loaded: Win32SysApi | null | undefined;
/** Why the last loadWin32System() gave null (for the log and the doctor). */
export let win32SystemError: unknown = null;

/** The API, or null when not on 64-bit Windows or koffi can't be loaded. Binds on the first call only. */
export function loadWin32System(): Win32SysApi | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  if (process.platform !== "win32") {
    win32SystemError = new Error("not Windows");
    return null;
  }
  try {
    const koffi = requireCjs("koffi") as Koffi;
    loaded = bindWin32System(koffi, name => koffi.load(name));
  } catch (err) {
    win32SystemError = err;
  }
  return loaded;
}

/**
 * Binds the API with `koffi` (sizes and memory decoding) from the libraries `load` opens. Exported for tests, which
 * pass fake libraries; everything else goes through loadWin32System().
 */
export function bindWin32System(koffi: Koffi, load: (name: string) => Pick<import("koffi").LibraryHandle, "func">): Win32SysApi {
  if (koffi.sizeof("void *") !== 8) throw new Error("Windows system integration needs a 64-bit process");
  const fn = bindFunctions(load);
  const { RegGetValueW, RegSetKeyValueW, OpenProcessToken, GetTokenInformation, SendMessageTimeoutW, SystemParametersInfoW } = fn;
  const { MonitorFromWindow, GetMonitorInfoW, GetSystemDirectoryW, GetWindowsDirectoryW, GetCurrentProcess, CloseHandle } = fn;
  const { ProcessIdToSessionId, GetPackagesByPackageFamily, SHGetKnownFolderPath, CoTaskMemFree } = fn;

  /** A W function that fills a buffer of `size` UTF-16 units and answers the length (or the size it needs). */
  const folder = (call: Bound): string | null => {
    if (!call) return null;
    let units = PATH_UNITS;
    for (let attempt = 0; attempt < 3; attempt++) {
      const buf = Buffer.alloc(units * 2);
      const n = call(buf, units) as number;
      if (!n) return null;
      if (n < units) return buf.toString("utf16le", 0, n * 2);
      units = n + 1; // too small: n is the size needed, with its NUL
    }
    return null;
  };

  return {
    regGetValue(hive, subKey, value, flags, data) {
      if (!RegGetValueW) return { status: UNAVAILABLE, type: 0, size: 0 };
      const type = [0], size = [data ? data.length : 0];
      const status = RegGetValueW(hive, subKey, value, flags, type, data, size) as number;
      return { status, type: type[0], size: size[0] };
    },
    regSetValue(hive, subKey, value, type, data) {
      if (!RegSetKeyValueW) return UNAVAILABLE;
      return RegSetKeyValueW(hive, subKey, value, type, data, data.length) as number;
    },
    broadcastSettingChange(area, timeoutMs, done) {
      if (!SendMessageTimeoutW?.async) return false;
      // Kept alive by this closure until the call comes back.
      const lParam = wideString(area), result = Buffer.alloc(8);
      try {
        SendMessageTimeoutW.async(HWND_BROADCAST, WM_SETTINGCHANGE, 0, lParam, SMTO_ABORTIFHUNG | SMTO_BLOCK, timeoutMs, result, (err: unknown, r: unknown) => {
          void lParam;
          void result;
          done?.(!err && Number(r) !== 0);
        });
        return true;
      } catch {
        return false; // koffi's queue of asynchronous calls is full: the apps notice the change on their next read
      }
    },
    screenReader() {
      if (!SystemParametersInfoW) return null;
      const v = [0];
      return SystemParametersInfoW(SPI_GETSCREENREADER, 0, v, 0) ? v[0] !== 0 : null;
    },
    elevated() {
      if (!OpenProcessToken || !GetTokenInformation || !GetCurrentProcess || !CloseHandle) return null;
      const token: unknown[] = [null];
      // GetCurrentProcess() is a pseudo-handle: nothing to close.
      if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, token) || !token[0]) return null;
      try {
        const buf = Buffer.alloc(4), returned = [0];
        return GetTokenInformation(token[0], TOKEN_ELEVATION, buf, 4, returned) ? buf.readUInt32LE(0) !== 0 : null;
      } finally {
        CloseHandle(token[0]);
      }
    },
    sessionId(pid) {
      if (!ProcessIdToSessionId) return null;
      const session = [0];
      return ProcessIdToSessionId(pid, session) ? session[0] : null;
    },
    systemDirectory: () => folder(GetSystemDirectoryW),
    windowsDirectory: () => folder(GetWindowsDirectoryW),
    knownFolder(id) {
      if (!SHGetKnownFolderPath || !CoTaskMemFree) return null;
      const out: unknown[] = [null];
      const hr = SHGetKnownFolderPath(guidBytes(id), 0, null, out) as number;
      try {
        if (hr !== 0 || !out[0]) return null;
        const text = koffi.decode.string16(out[0]);
        return text || null;
      } finally {
        // Freed whether it succeeded or not (SHGetKnownFolderPath's contract).
        if (out[0]) CoTaskMemFree(out[0]);
      }
    },
    packageFamilyInstalled(family) {
      if (!GetPackagesByPackageFamily) return null;
      const count = [0], length = [0];
      const status = GetPackagesByPackageFamily(family, count, null, length, null) as number;
      // Asked with no buffers: "too small" with a count means installed; success with none means not installed.
      if (status === ERROR_INSUFFICIENT_BUFFER || status === ERROR_SUCCESS) return count[0] > 0;
      return null;
    },
    monitorRect(hwnd) {
      if (!MonitorFromWindow || !GetMonitorInfoW || !hwnd) return null;
      const monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
      if (!monitor) return null;
      const info = Buffer.alloc(MONITORINFO_SIZE);
      info.writeUInt32LE(MONITORINFO_SIZE, 0);
      if (!GetMonitorInfoW(monitor, info)) return null;
      const left = info.readInt32LE(4), top = info.readInt32LE(8), right = info.readInt32LE(12), bottom = info.readInt32LE(16);
      return { x: left, y: top, width: right - left, height: bottom - top };
    },
  };
}
