/**
 * The distros WSL has registered for this user, read from the registry without starting anything (§4.1):
 * `HKCU\Software\Microsoft\Windows\CurrentVersion\Lxss\{GUID}` holds each distro's name, WSL version, the default uid
 * WSL was told at install (a hint only: an imported distro's /etc/wsl.conf `[user] default=` wins over it, critique
 * wsl-7), whether its first-run set-up (OOBE) is still pending, and its install state; the key itself names the
 * default distro.
 *
 * Read-only, through this module's own advapi32 bindings (RegOpenKeyExW, RegEnumKeyExW, RegQueryValueExW,
 * RegCloseKey), bound lazily through koffi on 64-bit Windows only, once per process, so the module imports cleanly on
 * every OS and never touches app/main/platform/win32/** (I-win's). Native memory is only ever copied into Buffers that
 * Node owns (never `koffi.view()`). Every failure gives null, and discovery falls back to `wsl.exe --list --verbose`.
 */

import { createRequire } from "node:module";

/** Where WSL keeps its distros (under HKEY_CURRENT_USER). */
export const LXSS_KEY = "Software\\Microsoft\\Windows\\CurrentVersion\\Lxss";

/** A distro's install state in the registry: only an installed one (1) is listed (3 installing, 4 uninstalling, …). */
export const LXSS_STATE_INSTALLED = 1;

/** One registry key, opened read-only. */
export interface RegKeyReader {
  /** The key's subkey names, or null when they can't be listed. */
  subkeys(): string[] | null;
  /** A REG_SZ or REG_EXPAND_SZ value (not expanded); null when it is absent, of another type or unreadable. */
  string(name: string): string | null;
  /** A REG_DWORD value; null when it is absent, of another type or unreadable. */
  dword(name: string): number | null;
  close(): void;
}

/** The registry as Lxss discovery reads it (koffi on Windows; a fake in tests). */
export interface RegistryReader {
  /** Opens `HKCU\<path>` for reading; null when it isn't there or can't be opened. */
  openUser(path: string): RegKeyReader | null;
}

/** One registered distro as the registry describes it. */
export interface LxssDistro {
  /** The key's name ("{0b1f…}"). */
  guid: string;
  name: string;
  version: 1 | 2;
  /** The uid WSL recorded at install (a hint for listing only, critique wsl-7); null when absent. */
  defaultUidHint: number | null;
  /** RunOOBE is 1: the first-run set-up (user creation) hasn't happened yet (critique wsl-19f). */
  needsSetup: boolean;
}

/** What the Lxss key says. */
export interface LxssListing {
  /** The default distro's GUID ("{…}"), or null when none is recorded. */
  defaultGuid: string | null;
  distros: LxssDistro[];
}

/** At most this many distros are read (a key with more is broken; discovery falls back to wsl.exe). */
const MAX_DISTROS = 256;

/**
 * The distros the Lxss key lists, or null when the key can't be read (absent: no distro was ever registered, or the
 * registry is unavailable): discovery then asks `wsl.exe --list --verbose`. A distro whose key lacks a name, has an
 * unknown WSL version or isn't in the installed state is left out (fail closed: Ember never targets it). A missing
 * `Version` is WSL 1 (WSL wrote none before WSL 2 existed); a missing `State` counts as installed.
 */
export function readLxss(reg: RegistryReader): LxssListing | null {
  const root = reg.openUser(LXSS_KEY);
  if (!root) return null;
  try {
    const guids = root.subkeys();
    if (!guids || guids.length > MAX_DISTROS) return null;
    const defaultGuid = root.string("DefaultDistribution");
    const distros: LxssDistro[] = [];
    for (const guid of guids) {
      const key = reg.openUser(`${LXSS_KEY}\\${guid}`);
      if (!key) continue;
      try {
        const name = key.string("DistributionName");
        const version = key.dword("Version") ?? 1;
        const state = key.dword("State");
        if (!name || (version !== 1 && version !== 2)) continue;
        if (state !== null && state !== LXSS_STATE_INSTALLED) continue;
        distros.push({ guid, name, version, defaultUidHint: key.dword("DefaultUid"), needsSetup: key.dword("RunOOBE") === 1 });
      } finally {
        key.close();
      }
    }
    return { defaultGuid: defaultGuid ? defaultGuid.trim() : null, distros };
  } finally {
    root.close();
  }
}

/** HKEY_CURRENT_USER as koffi's `intptr_t` takes it (sign-extended 0xFFFFFFFF80000001). */
export const HKEY_CURRENT_USER = -2147483647;
/** KEY_READ | KEY_WOW64_64KEY: read-only, the 64-bit view whatever the process. */
export const KEY_READ_64 = 0x20019 | 0x0100;
const ERROR_SUCCESS = 0, ERROR_MORE_DATA = 234, ERROR_NO_MORE_ITEMS = 259;
const REG_SZ = 1, REG_EXPAND_SZ = 2, REG_DWORD = 4;
/** A key name is at most 255 characters (plus its NUL). */
const KEY_NAME_UNITS = 256;
/** Lxss strings are names and paths: anything larger is refused rather than read. */
const MAX_VALUE_BYTES = 64 * 1024;

/** The advapi32 functions this module binds, in koffi's prototype syntax (HKEY handles opened here are `void *`). */
export const LXSS_FUNCTIONS: readonly string[] = [
  "int32_t __stdcall RegOpenKeyExW(intptr_t root, const char16_t *subKey, uint32_t options, uint32_t sam, _Out_ void **result)",
  "int32_t __stdcall RegEnumKeyExW(void *key, uint32_t index, void *name, _Inout_ uint32_t *nameUnits, void *reserved, void *cls, void *clsUnits, void *lastWrite)",
  "int32_t __stdcall RegQueryValueExW(void *key, const char16_t *valueName, void *reserved, _Out_ uint32_t *type, void *data, _Inout_ uint32_t *dataBytes)",
  "int32_t __stdcall RegCloseKey(void *key)",
];

/** A bound function (koffi's results are untyped). */
type Fn = (...args: unknown[]) => unknown;

/** What binding needs from koffi: the pointer size and a library's `func`. Tests pass fakes. */
export interface KoffiLike {
  sizeof(type: string): number;
  load(name: string): { func(declaration: string): unknown };
}

/** A UTF-16LE registry string's text up to its first NUL (an odd trailing byte ignored). */
function utf16z(data: Buffer, bytes: number): string {
  const n = Math.min(bytes, data.length);
  const text = data.toString("utf16le", 0, n - (n % 2));
  const nul = text.indexOf("\0");
  return nul < 0 ? text : text.slice(0, nul);
}

/**
 * A RegistryReader over advapi32 bound with `koffi` (exported for tests, which pass a fake koffi; everything else goes
 * through loadLxssRegistry()). Throws when a function can't be bound or the process isn't 64-bit.
 */
export function bindLxssRegistry(koffi: KoffiLike): RegistryReader {
  if (koffi.sizeof("void *") !== 8) throw new Error("Lxss discovery needs a 64-bit process");
  const lib = koffi.load("advapi32.dll");
  const [open, enumKey, query, close] = LXSS_FUNCTIONS.map(d => lib.func(d) as Fn);

  /** A value's type and bytes (asked size first, then read; read again if it grew in between). */
  const value = (key: unknown, name: string): { type: number; data: Buffer; bytes: number } | null => {
    const type = [0], size = [0];
    let status = query(key, name, null, type, null, size) as number;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (status !== ERROR_SUCCESS && status !== ERROR_MORE_DATA) return null;
      if (size[0] > MAX_VALUE_BYTES) return null;
      const data = Buffer.alloc(Math.max(size[0], 4));
      const got = [data.length];
      status = query(key, name, null, type, data, got) as number;
      if (status === ERROR_SUCCESS) return { type: type[0], data, bytes: got[0] };
      size[0] = Math.max(got[0], data.length * 2);
    }
    return null;
  };

  const reader = (key: unknown): RegKeyReader => {
    let isOpen = true;
    return {
      subkeys() {
        const names: string[] = [];
        for (let i = 0; i <= MAX_DISTROS; i++) {
          const buf = Buffer.alloc(KEY_NAME_UNITS * 2), units = [KEY_NAME_UNITS];
          const status = enumKey(key, i, buf, units, null, null, null, null) as number;
          if (status === ERROR_NO_MORE_ITEMS) return names;
          if (status !== ERROR_SUCCESS) return null;
          names.push(buf.toString("utf16le", 0, Math.min(units[0], KEY_NAME_UNITS) * 2));
        }
        return names; // more than MAX_DISTROS: readLxss refuses the listing
      },
      string(name) {
        const v = value(key, name);
        return v && (v.type === REG_SZ || v.type === REG_EXPAND_SZ) ? utf16z(v.data, v.bytes) : null;
      },
      dword(name) {
        const v = value(key, name);
        return v && v.type === REG_DWORD && v.bytes >= 4 ? v.data.readUInt32LE(0) : null;
      },
      close() {
        if (!isOpen) return;
        isOpen = false;
        close(key);
      },
    };
  };

  return {
    openUser(path) {
      const out: unknown[] = [null];
      const status = open(HKEY_CURRENT_USER, path, 0, KEY_READ_64, out) as number;
      return status === ERROR_SUCCESS && out[0] ? reader(out[0]) : null;
    },
  };
}

const requireCjs = createRequire(__filename);
/** The bound reader, once per process (undefined: not tried yet; null: unavailable). */
let loaded: RegistryReader | null | undefined;

/**
 * The registry reader, or null when koffi or advapi32 can't be loaded (discovery then asks wsl.exe). Only the WSL
 * service calls it, and createWsl makes that service only on Windows. koffi is required here, on the first call, never
 * at import: a macOS remote's agent ships no koffi.
 */
export function loadLxssRegistry(): RegistryReader | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  try {
    loaded = bindLxssRegistry(requireCjs("koffi") as KoffiLike);
  } catch {
    loaded = null; // no koffi, no advapi32 (not Windows) or a 32-bit process: wsl.exe --list --verbose answers instead
  }
  return loaded;
}
