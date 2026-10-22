/**
 * The Lxss registry (app/main/wsl/lxss.ts, design §4.1): which distros are registered, read without starting
 * anything. Names, versions, the default distro, RunOOBE (set-up pending) and the install state come from the
 * registry; DefaultUid is kept only as a hint (critique wsl-7); a broken or absent key gives null so wsl.exe lists
 * instead. The advapi32 binding is checked over a fake koffi: read-only access, every opened key closed, sizes asked
 * before data, and Win32 statuses mapped to "absent".
 */

import { describe, expect, it } from "vitest";
import { bindLxssRegistry, HKEY_CURRENT_USER, KEY_READ_64, LXSS_FUNCTIONS, LXSS_KEY, readLxss, type KoffiLike } from "../../app/main/wsl/lxss";
import { FakeRegistry } from "./wsl-wa-fakes";

const UBUNTU = "{0b1f5c0a-0d6a-4f3e-9d8e-1c2b3a4d5e6f}";
const DEBIAN = "{1c2d3e4f-5a6b-4c7d-8e9f-a0b1c2d3e4f5}";
const FRESH = "{2d3e4f5a-6b7c-4d8e-9f0a-b1c2d3e4f5a6}";
const INSTALLING = "{3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7}";

function lxss(): FakeRegistry {
  return new FakeRegistry()
    .key(LXSS_KEY, { DefaultDistribution: UBUNTU.toUpperCase() })
    .key(`${LXSS_KEY}\\${UBUNTU}`, { DistributionName: "Ubuntu", Version: 2, DefaultUid: 1000, State: 1 })
    .key(`${LXSS_KEY}\\${DEBIAN}`, { DistributionName: "Debian", DefaultUid: 0 })
    .key(`${LXSS_KEY}\\${FRESH}`, { DistributionName: "Ubuntu-24.04", Version: 2, RunOOBE: 1, State: 1 })
    .key(`${LXSS_KEY}\\${INSTALLING}`, { DistributionName: "Fedora", Version: 2, State: 3 });
}

describe("readLxss", () => {
  it("lists each registered distro with its version, its set-up state and the uid hint, and names the default", () => {
    const reg = lxss();
    const l = readLxss(reg);
    expect(l).not.toBeNull();
    expect(l!.defaultGuid?.toLowerCase()).toBe(UBUNTU);
    expect(l!.distros).toEqual([
      { guid: UBUNTU, name: "Ubuntu", version: 2, defaultUidHint: 1000, needsSetup: false },
      // No Version value: WSL 1 (written before WSL 2 existed).
      { guid: DEBIAN, name: "Debian", version: 1, defaultUidHint: 0, needsSetup: false },
      // RunOOBE = 1: its user hasn't been created yet; Ember never starts it (critique wsl-19f).
      { guid: FRESH, name: "Ubuntu-24.04", version: 2, defaultUidHint: null, needsSetup: true },
    ]);
  });

  it("leaves out a distro that is being installed or removed, has no name, or has an unknown WSL version", () => {
    const reg = lxss()
      .key(`${LXSS_KEY}\\{nameless}`, { Version: 2 })
      .key(`${LXSS_KEY}\\{v3}`, { DistributionName: "Future", Version: 3 });
    expect(readLxss(reg)!.distros.map(d => d.name)).toEqual(["Ubuntu", "Debian", "Ubuntu-24.04"]);
  });

  it("closes every key it opened", () => {
    const reg = lxss();
    readLxss(reg);
    expect(reg.opened).toBeGreaterThan(0);
    expect(reg.closed).toBe(reg.opened);
  });

  it("gives null when the Lxss key isn't there or can't be listed, so wsl.exe lists instead", () => {
    expect(readLxss(new FakeRegistry())).toBeNull();
    const reg = lxss();
    reg.failSubkeys = true;
    expect(readLxss(reg)).toBeNull();
    expect(reg.closed).toBe(reg.opened);
  });

  it("has no default when none is recorded", () => {
    const reg = new FakeRegistry().key(`${LXSS_KEY}\\${UBUNTU}`, { DistributionName: "Ubuntu", Version: 2 });
    expect(readLxss(reg)).toEqual({ defaultGuid: null, distros: [{ guid: UBUNTU, name: "Ubuntu", version: 2, defaultUidHint: null, needsSetup: false }] });
  });
});

/** An advapi32 over an in-memory registry, answering with Win32 statuses as the real one does. */
function fakeAdvapi(o: { pointer?: number; grow?: boolean } = {}) {
  const keys = new Map<string, { values: Map<string, { type: number; data: Buffer }>; subkeys: string[] }>();
  const handles = new Map<object, string>();
  const log: { opened: { root: number; path: string; sam: number }[]; closed: number; queries: number } = { opened: [], closed: 0, queries: 0 };
  const sz = (s: string) => ({ type: 1, data: Buffer.from(`${s}\0`, "utf16le") });
  const dword = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n, 0);
    return { type: 4, data: b };
  };
  keys.set(LXSS_KEY.toLowerCase(), { values: new Map([["defaultdistribution", sz(UBUNTU)]]), subkeys: [UBUNTU, DEBIAN] });
  keys.set(`${LXSS_KEY}\\${UBUNTU}`.toLowerCase(), {
    values: new Map([["distributionname", sz("Ubuntu")], ["version", dword(2)], ["defaultuid", dword(1000)], ["runoobe", dword(0)], ["state", dword(1)]]),
    subkeys: [],
  });
  keys.set(`${LXSS_KEY}\\${DEBIAN}`.toLowerCase(), {
    // A DWORD stored as a string is the wrong type: it reads as absent.
    values: new Map([["distributionname", sz("Debian")], ["version", { type: 1, data: Buffer.from("1\0", "utf16le") }]]),
    subkeys: [],
  });
  let grown = false;
  const fns: Record<string, (...a: unknown[]) => unknown> = {
    RegOpenKeyExW: (root, path, _options, sam, out) => {
      log.opened.push({ root: root as number, path: path as string, sam: sam as number });
      const k = keys.get((path as string).toLowerCase());
      if (!k) return 2;
      const h = { path };
      handles.set(h, (path as string).toLowerCase());
      (out as unknown[])[0] = h;
      return 0;
    },
    RegEnumKeyExW: (h, index, name, units) => {
      const k = keys.get(handles.get(h as object)!)!;
      const i = index as number;
      if (i >= k.subkeys.length) return 259;
      const text = k.subkeys[i];
      (name as Buffer).write(`${text}\0`, "utf16le");
      (units as number[])[0] = text.length;
      return 0;
    },
    RegQueryValueExW: (h, valueName, _reserved, type, data, size) => {
      log.queries++;
      const k = keys.get(handles.get(h as object)!)!;
      const v = k.values.get((valueName as string).toLowerCase());
      if (!v) return 2;
      (type as number[])[0] = v.type;
      let bytes = v.data;
      // A value that grows between the size call and the read: ERROR_MORE_DATA with the new size.
      if (o.grow && data && !grown) {
        grown = true;
        bytes = Buffer.concat([v.data, Buffer.alloc(64)]);
        (size as number[])[0] = bytes.length;
        return 234;
      }
      if (!data) {
        (size as number[])[0] = bytes.length;
        return 0;
      }
      if ((data as Buffer).length < bytes.length) {
        (size as number[])[0] = bytes.length;
        return 234;
      }
      bytes.copy(data as Buffer);
      (size as number[])[0] = bytes.length;
      return 0;
    },
    RegCloseKey: h => {
      handles.delete(h as object);
      log.closed++;
      return 0;
    },
  };
  const koffi: KoffiLike = {
    sizeof: () => o.pointer ?? 8,
    load: name => {
      expect(name).toBe("advapi32.dll");
      return { func: (decl: string) => fns[/(\w+)\s*\(/.exec(decl)![1]] };
    },
  };
  return { koffi, log };
}

describe("bindLxssRegistry", () => {
  it("binds only advapi32's read functions", () => {
    expect(LXSS_FUNCTIONS.map(d => /(\w+)\s*\(/.exec(d)![1])).toEqual(["RegOpenKeyExW", "RegEnumKeyExW", "RegQueryValueExW", "RegCloseKey"]);
    expect(LXSS_FUNCTIONS.join(" ")).not.toMatch(/RegSet|RegCreate|RegDelete/);
  });

  it("reads the Lxss key read-only from HKEY_CURRENT_USER and closes every key it opened", () => {
    const { koffi, log } = fakeAdvapi();
    const l = readLxss(bindLxssRegistry(koffi));
    expect(l).toEqual({
      defaultGuid: UBUNTU,
      distros: [
        { guid: UBUNTU, name: "Ubuntu", version: 2, defaultUidHint: 1000, needsSetup: false },
        // Version of the wrong type reads as absent: WSL 1.
        { guid: DEBIAN, name: "Debian", version: 1, defaultUidHint: null, needsSetup: false },
      ],
    });
    expect(log.opened.every(o => o.root === HKEY_CURRENT_USER && o.sam === KEY_READ_64)).toBe(true);
    expect(KEY_READ_64 & 0x20019).toBe(0x20019);
    expect(KEY_READ_64 & 0x0006).toBe(0); // no KEY_SET_VALUE or KEY_CREATE_SUB_KEY
    expect(log.closed).toBe(log.opened.length);
  });

  it("reads a value again when it grew between the size call and the read", () => {
    const { koffi } = fakeAdvapi({ grow: true });
    expect(readLxss(bindLxssRegistry(koffi))!.distros[0].name).toBe("Ubuntu");
  });

  it("gives null for a key that isn't there", () => {
    const { koffi } = fakeAdvapi();
    expect(bindLxssRegistry(koffi).openUser("Software\\Nothing")).toBeNull();
  });

  it("refuses a 32-bit process (HKEY handles and pointers are 64-bit here)", () => {
    const { koffi } = fakeAdvapi({ pointer: 4 });
    expect(() => bindLxssRegistry(koffi)).toThrow(/64-bit/);
  });
});
