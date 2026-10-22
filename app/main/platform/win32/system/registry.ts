/**
 * Reading and writing the Windows registry through the advapi32 bindings (ffi.ts), with Win32's status codes mapped
 * to a few plain outcomes. The admin policy depends on the difference between "not there" (no policy) and every
 * other failure (locked down), so the mapping is exact and unit-tested: only ERROR_FILE_NOT_FOUND is "not-found"
 * (RegGetValueW gives it for a missing key and a missing value alike).
 * Strings are read in two calls (the size, then the data) and decoded as UTF-16LE without their trailing NUL; a
 * REG_MULTI_SZ's strings are joined with "\n". Pure over the injected API.
 */

import type { Win32SysApi } from "./ffi";
import { UNAVAILABLE } from "./ffi";

/** Predefined keys as koffi's `intptr_t` takes them: sign-extended 64-bit handles (0xFFFFFFFF80000001…). */
export const HKEY = { CURRENT_USER: -2147483647, LOCAL_MACHINE: -2147483646 } as const;

/** REG_* value types. */
export const REG = { SZ: 1, EXPAND_SZ: 2, BINARY: 3, DWORD: 4, MULTI_SZ: 7 } as const;

/** RegGetValueW flags: which types are accepted, and the 64-bit view whatever the process. */
export const RRF = { RT_REG_SZ: 0x02, RT_REG_EXPAND_SZ: 0x04, RT_REG_DWORD: 0x10, RT_REG_MULTI_SZ: 0x20, SUBKEY_WOW6464KEY: 0x10000 } as const;

const ERROR_SUCCESS = 0, ERROR_FILE_NOT_FOUND = 2, ERROR_ACCESS_DENIED = 5, ERROR_MORE_DATA = 234, ERROR_UNSUPPORTED_TYPE = 1630;

/** Why a registry call didn't give a value. */
export type RegistryFailure = "not-found" | "denied" | "wrong-type" | "too-large" | "unavailable" | "failed";

/** A value, or why there is none (with the Win32 status, 0 when Ember refused it itself). */
export type RegistryResult<T> = { ok: true; value: T } | { ok: false; error: RegistryFailure; status: number };

/**
 * A Win32 status as a failure. Only ERROR_FILE_NOT_FOUND means the key or value isn't there (RegGetValueW gives it
 * for both, §9.4). Everything else, access denied and any other path error included, is a failure the caller must
 * not read as "absent": the admin policy locks Ember down on it.
 */
export function registryFailure(status: number): RegistryFailure {
  if (status === ERROR_FILE_NOT_FOUND) return "not-found";
  if (status === ERROR_ACCESS_DENIED) return "denied";
  if (status === ERROR_UNSUPPORTED_TYPE) return "wrong-type";
  if (status === UNAVAILABLE) return "unavailable";
  return "failed";
}

/** A failure in words, for an error message ("access denied (error 5)"). */
export function describeFailure(r: { error: RegistryFailure; status: number }): string {
  const words: Record<RegistryFailure, string> = {
    "not-found": "not there", denied: "access denied", "wrong-type": "the value has the wrong type", "too-large": "the value is too large",
    unavailable: "the registry functions aren't available", failed: "the registry call failed",
  };
  return r.status > 0 ? `${words[r.error]} (error ${r.status})` : words[r.error];
}

const fail = (error: RegistryFailure, status: number): { ok: false; error: RegistryFailure; status: number } => ({ ok: false, error, status });

/**
 * A REG_SZ / REG_EXPAND_SZ / REG_MULTI_SZ value's bytes as text: UTF-16LE up to the first NUL, or for a multi-string
 * every string (empty ones dropped) joined with "\n". An odd trailing byte is ignored.
 */
export function decodeRegistryString(data: Buffer, type: number): string {
  const text = data.toString("utf16le", 0, data.length - (data.length % 2));
  if (type === REG.MULTI_SZ) return text.split("\0").filter(Boolean).join("\n");
  const nul = text.indexOf("\0");
  return nul < 0 ? text : text.slice(0, nul);
}

/**
 * A string value (REG_SZ, or what `flags` allows: REG_MULTI_SZ is joined with "\n"). `maxBytes` refuses larger
 * values before reading them ("too-large"). The size is asked first; a value that grows between the two calls is
 * asked for again (up to three times).
 */
export function readString(api: Win32SysApi, hive: number, subKey: string, value: string, o: { flags?: number; maxBytes?: number } = {}): RegistryResult<string> {
  const flags = o.flags ?? (RRF.RT_REG_SZ | RRF.SUBKEY_WOW6464KEY);
  let probe = api.regGetValue(hive, subKey, value, flags, null);
  for (let attempt = 0; attempt < 3; attempt++) {
    if (probe.status !== ERROR_SUCCESS && probe.status !== ERROR_MORE_DATA) return fail(registryFailure(probe.status), probe.status);
    if (o.maxBytes !== undefined && probe.size > o.maxBytes) return fail("too-large", 0);
    const data = Buffer.alloc(Math.max(probe.size, 2));
    const r = api.regGetValue(hive, subKey, value, flags, data);
    if (r.status === ERROR_SUCCESS) return { ok: true, value: decodeRegistryString(data.subarray(0, Math.min(r.size, data.length)), r.type) };
    if (r.status !== ERROR_MORE_DATA) return fail(registryFailure(r.status), r.status);
    probe = { status: ERROR_SUCCESS, type: r.type, size: r.size > probe.size ? r.size : probe.size * 2 };
  }
  return fail("failed", ERROR_MORE_DATA);
}

/** A REG_DWORD value. */
export function readDword(api: Win32SysApi, hive: number, subKey: string, value: string): RegistryResult<number> {
  const data = Buffer.alloc(4);
  const r = api.regGetValue(hive, subKey, value, RRF.RT_REG_DWORD | RRF.SUBKEY_WOW6464KEY, data);
  if (r.status !== ERROR_SUCCESS) return fail(registryFailure(r.status), r.status);
  return { ok: true, value: data.readUInt32LE(0) };
}

/** Writes a REG_DWORD value (the key is the user's, so no WOW64 view applies). */
export function writeDword(api: Win32SysApi, hive: number, subKey: string, value: string, n: number): RegistryResult<void> {
  const data = Buffer.alloc(4);
  data.writeUInt32LE(n >>> 0, 0);
  const status = api.regSetValue(hive, subKey, value, REG.DWORD, data);
  return status === ERROR_SUCCESS ? { ok: true, value: undefined } : fail(registryFailure(status), status);
}
