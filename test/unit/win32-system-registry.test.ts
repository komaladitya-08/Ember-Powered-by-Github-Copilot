/**
 * Registry reads and writes (win32/system/registry.ts) over a fake registry that answers as Windows does: Win32
 * statuses map to outcomes exactly (only "not there" is absence; access denied, the wrong type and a missing advapi32
 * are failures), strings are read size-then-data and decoded without their NUL, a REG_MULTI_SZ is joined with "\n",
 * a value that grows between the two calls is read again, and an oversized value is refused before it is read.
 */

import { describe, expect, it } from "vitest";
import {
  decodeRegistryString, describeFailure, HKEY, readDword, readString, registryFailure, REG, RRF, writeDword,
} from "../../app/main/platform/win32/system/registry";
import { UNAVAILABLE } from "../../app/main/platform/win32/system/ffi";
import { FakeRegistry, fakeApi, HKCU, HKLM } from "./win32-system-fakes";

const KEY = "SOFTWARE\\Policies\\Ember";

describe("registryFailure", () => {
  it("treats only ERROR_FILE_NOT_FOUND (a missing key or value) as absence", () => {
    expect(registryFailure(2)).toBe("not-found");
    expect(registryFailure(3)).toBe("failed"); // ERROR_PATH_NOT_FOUND: not what RegGetValueW says for absence
    expect(registryFailure(161)).toBe("failed"); // ERROR_BAD_PATHNAME
    expect(registryFailure(5)).toBe("denied");
    expect(registryFailure(1630)).toBe("wrong-type");
    expect(registryFailure(UNAVAILABLE)).toBe("unavailable");
    expect(registryFailure(1450)).toBe("failed"); // ERROR_NO_SYSTEM_RESOURCES
    expect(registryFailure(234)).toBe("failed");
  });

  it("describes a failure with its Win32 error number", () => {
    expect(describeFailure({ error: "denied", status: 5 })).toBe("access denied (error 5)");
    expect(describeFailure({ error: "unavailable", status: -1 })).toBe("the registry functions aren't available");
  });
});

describe("decodeRegistryString", () => {
  it("stops a REG_SZ at its NUL and joins a REG_MULTI_SZ's strings with newlines", () => {
    expect(decodeRegistryString(Buffer.from("{\"a\":1}\0junk", "utf16le"), REG.SZ)).toBe("{\"a\":1}");
    expect(decodeRegistryString(Buffer.from("{\0\"neverLook\": []\0}\0\0", "utf16le"), REG.MULTI_SZ)).toBe("{\n\"neverLook\": []\n}");
    expect(decodeRegistryString(Buffer.from("no terminator", "utf16le"), REG.SZ)).toBe("no terminator");
    expect(decodeRegistryString(Buffer.concat([Buffer.from("ab", "utf16le"), Buffer.from([0x41])]), REG.SZ)).toBe("ab");
  });
});

describe("readString", () => {
  it("reads a REG_SZ in two calls and decodes it", () => {
    const api = fakeApi(new FakeRegistry().sz(HKLM, KEY, "PolicyJson", "{\"confirmEveryAction\":true}"));
    expect(readString(api, HKEY.LOCAL_MACHINE, KEY, "PolicyJson")).toEqual({ ok: true, value: "{\"confirmEveryAction\":true}" });
  });

  it("reads a REG_MULTI_SZ when the flags allow it", () => {
    const api = fakeApi(new FakeRegistry().multiSz(HKLM, KEY, "PolicyJson", ["{", "\"allowGrants\": false", "}"]));
    expect(readString(api, HKEY.LOCAL_MACHINE, KEY, "PolicyJson", { flags: RRF.RT_REG_SZ | RRF.RT_REG_MULTI_SZ })).toEqual({ ok: true, value: "{\n\"allowGrants\": false\n}" });
    expect(readString(api, HKEY.LOCAL_MACHINE, KEY, "PolicyJson")).toMatchObject({ ok: false, error: "wrong-type", status: 1630 });
  });

  it("says not-found, denied or wrong-type", () => {
    const registry = new FakeRegistry().dword(HKLM, KEY, "PolicyJson", 1).deny(HKCU, KEY);
    const api = fakeApi(registry);
    expect(readString(api, HKEY.LOCAL_MACHINE, KEY, "Missing")).toMatchObject({ ok: false, error: "not-found" });
    expect(readString(api, HKEY.LOCAL_MACHINE, "SOFTWARE\\Nope", "PolicyJson")).toMatchObject({ ok: false, error: "not-found" });
    expect(readString(api, HKEY.CURRENT_USER, KEY, "PolicyJson")).toMatchObject({ ok: false, error: "denied", status: 5 });
    expect(readString(api, HKEY.LOCAL_MACHINE, KEY, "PolicyJson")).toMatchObject({ ok: false, error: "wrong-type" });
  });

  it("refuses a value larger than maxBytes without reading its data", () => {
    const registry = new FakeRegistry().sz(HKLM, KEY, "PolicyJson", "x".repeat(200));
    const reads: boolean[] = [];
    registry.beforeRead = (_k, _v, withData) => reads.push(withData);
    expect(readString(fakeApi(registry), HKEY.LOCAL_MACHINE, KEY, "PolicyJson", { maxBytes: 100 })).toMatchObject({ ok: false, error: "too-large" });
    expect(reads).toEqual([false]);
  });

  it("reads again when the value grew between the size and the data call", () => {
    const registry = new FakeRegistry().sz(HKLM, KEY, "PolicyJson", "{}");
    let grown = false;
    registry.beforeRead = (_k, _v, withData) => {
      if (withData && !grown) { grown = true; registry.sz(HKLM, KEY, "PolicyJson", "{\"allowGrants\":false}"); }
    };
    expect(readString(fakeApi(registry), HKEY.LOCAL_MACHINE, KEY, "PolicyJson")).toEqual({ ok: true, value: "{\"allowGrants\":false}" });
  });

  it("is unavailable without the registry functions", () => {
    const api = fakeApi(new FakeRegistry(), { regGetValue: () => ({ status: UNAVAILABLE, type: 0, size: 0 }) });
    expect(readString(api, HKEY.LOCAL_MACHINE, KEY, "PolicyJson")).toMatchObject({ ok: false, error: "unavailable" });
  });
});

describe("readDword and writeDword", () => {
  it("reads a REG_DWORD and refuses another type", () => {
    const api = fakeApi(new FakeRegistry().dword(HKCU, "Personalize", "AppsUseLightTheme", 0).sz(HKCU, "Personalize", "Text", "1"));
    expect(readDword(api, HKEY.CURRENT_USER, "Personalize", "AppsUseLightTheme")).toEqual({ ok: true, value: 0 });
    expect(readDword(api, HKEY.CURRENT_USER, "Personalize", "Text")).toMatchObject({ ok: false, error: "wrong-type" });
    expect(readDword(api, HKEY.CURRENT_USER, "Personalize", "Nope")).toMatchObject({ ok: false, error: "not-found" });
  });

  it("writes a REG_DWORD as four little-endian bytes", () => {
    const registry = new FakeRegistry();
    const api = fakeApi(registry);
    expect(writeDword(api, HKEY.CURRENT_USER, "Personalize", "AppsUseLightTheme", 1)).toEqual({ ok: true, value: undefined });
    expect(registry.writes).toEqual([{ key: "Personalize", value: "AppsUseLightTheme", type: 4, data: Buffer.from([1, 0, 0, 0]) }]);
    registry.writeStatus = 5;
    expect(writeDword(api, HKEY.CURRENT_USER, "Personalize", "AppsUseLightTheme", 0)).toMatchObject({ ok: false, error: "denied" });
  });
});
