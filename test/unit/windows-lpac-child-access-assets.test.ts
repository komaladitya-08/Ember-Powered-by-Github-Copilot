/** Portable asset/provenance contracts. These tests never download or launch a collector, helper or driver. */
import fs from "node:fs";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CHILD_ACCESS_ISSUER, CHILD_ACCESS_BASE, CHILD_ACCESS_SOURCES, CHILD_ACCESS_RECIPE, CHILD_ACCESS_TOOL,
  CHILD_ACCESS_ARCHIVE_MAX, CHILD_ACCESS_PML_MAX, CHILD_ACCESS_CSV_MAX, ChildAccessAssetError,
  childAccessSha256, childAccessLocalPath, childAccessManualGate, childAccessCleanEnvironment, childAccessEnvironmentBlock,
  childAccessCompileBatch, childAccessSourceCopies, childAccessManifest, childAccessManifestCurrent,
  childAccessZipEntry, childAccessPinnedProcmon, childAccessCommand, childAccessProcmonConfiguration,
} from "../fixtures/windows-lpac-child-access-assets";

const COMMIT = "2".repeat(40), OTHER_COMMIT = "3".repeat(40), PE = Buffer.from("MZsynthetic-fixed-test-image"), SIGNATURE = Buffer.from([1, 0, 0, 0]);
const publicSources = () => childAccessSourceCopies(file => fs.readFileSync(new URL(`../fixtures/${file}`, import.meta.url)));
const manual = (): NodeJS.ProcessEnv => ({ GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "workflow_dispatch", GITHUB_SHA: COMMIT,
  EMBER_LPAC_CHILD_ACCESS_TEST: "1", EMBER_LPAC_CHILD_ACCESS_RUNNER: "windows-2022", RUNNER_TEMP: "D:\\private\\temporary", GITHUB_WORKSPACE: "D:\\private\\workspace" });
function refusal(call: () => unknown, code: number) {
  let caught: unknown;
  try { call(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(ChildAccessAssetError); expect((caught as ChildAccessAssetError).code).toBe(code);
  expect((caught as Error).message).toBe("The fixed child-access witness asset contract was refused.");
  expect(caught).not.toHaveProperty("cause"); expect(JSON.stringify(caught)).not.toMatch(/private|secret|synthetic|D:\\|C:\\/);
}
afterEach(() => { vi.unstubAllEnvs(); });

describe("manual fixed child-access witness admission", () => {
  it("admits only the declared manual x64 Server matrix", () => {
    expect(childAccessManualGate(manual(), "win32", "x64")).toBe("windows-2022");
    expect(childAccessManualGate({ ...manual(), EMBER_LPAC_CHILD_ACCESS_RUNNER: "windows-2025" }, "win32", "x64")).toBe("windows-2025");
  });
  it.each([
    ["linux", "x64"], ["darwin", "arm64"], ["win32", "arm64"], ["win32", "ia32"],
  ])("refuses a wrong host before any tool activity (%s/%s)", (platform, arch) => { refusal(() => childAccessManualGate(manual(), platform, arch), 2); });
  it.each([
    { GITHUB_ACTIONS: "false" }, { GITHUB_EVENT_NAME: "pull_request" }, { GITHUB_EVENT_NAME: "push" },
    { EMBER_LPAC_CHILD_ACCESS_TEST: "0" }, { EMBER_LPAC_CHILD_ACCESS_RUNNER: "windows-latest" },
    { GITHUB_SHA: "a".repeat(39) }, { GITHUB_SHA: "A".repeat(40) }, { GITHUB_SHA: "private commit" },
  ])("refuses unapproved event/runner/commit declarations (%#)", changed => { refusal(() => childAccessManualGate({ ...manual(), ...changed }, "win32", "x64"), 2); });
  it.each(["RUNNER_TEMP", "GITHUB_WORKSPACE"])("requires an ordinary local host path for %s", key => {
    refusal(() => childAccessManualGate({ ...manual(), [key]: "\\\\private-server\\share" }, "win32", "x64"), 1);
    refusal(() => childAccessManualGate({ ...manual(), [key]: "" }, "win32", "x64"), 1);
  });
  it.each([
    "\\\\server\\share\\file", "\\\\?\\C:\\private\\file", "C:private\\file", "C:/private/file",
    "C:\\private\\..\\file", "C:\\private\\file:stream", "C:\\private\\directory.\\file", "C:\\private\\directory \\file",
    "C:\\private\\%variable%", "C:\\private\\!variable!", "C:\\private\\a&b", "C:\\private\\a^b", "C:\\private\\a|b",
    "C:\\private\\a\nb", "C:\\private\\a\u202eb", "C:\\private\\file*", "C:\\private\\file?", "C:\\",
  ])("rejects aliases and shell-bearing host path spellings (%#)", value => { refusal(() => childAccessLocalPath(value), 1); });
  it("keeps an ordinary path with spaces as one validated spelling", () => {
    expect(childAccessLocalPath("C:\\Program Files\\Microsoft Visual Studio\\2026")).toBe("C:\\Program Files\\Microsoft Visual Studio\\2026");
  });
});

describe("fixed witness host environment and compiler recipe", () => {
  it("builds a fresh allowlist without inheriting parent credentials or compiler/runtime injection", () => {
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "NODE_OPTIONS", "NODE_PATH", "CL", "_CL_", "LINK", "MSBuildExtensionsPath", "PSModulePath", "PYTHONPATH"])
      vi.stubEnv(key, "private synthetic secret");
    const env = childAccessCleanEnvironment("C:\\Windows", "D:\\private\\profile", "D:\\private\\temp");
    expect(Object.keys(env).sort()).toEqual(["APPDATA", "ComSpec", "LOCALAPPDATA", "NUMBER_OF_PROCESSORS", "PATH", "PATHEXT", "PROCESSOR_ARCHITECTURE", "SystemDrive", "SystemRoot", "TEMP", "TMP", "USERPROFILE", "WINDIR"].sort());
    expect(env).toMatchObject({ SystemDrive: "C:", PATH: "C:\\Windows\\System32;C:\\Windows", USERPROFILE: "D:\\private\\profile",
      APPDATA: "D:\\private\\profile\\Roaming", LOCALAPPDATA: "D:\\private\\profile\\Local", TEMP: "D:\\private\\temp", TMP: "D:\\private\\temp" });
    expect(Object.values(env).join("\n")).not.toContain("synthetic secret");
    env.PATH = "changed"; expect(childAccessCleanEnvironment("C:\\Windows", "D:\\private\\profile", "D:\\private\\temp").PATH).toBe("C:\\Windows\\System32;C:\\Windows");
  });
  it("encodes sorted UTF-16 environment entries with the required double terminator", () => {
    expect(childAccessEnvironmentBlock({ ZED: "last", alpha: "first" }).toString("utf16le")).toBe("alpha=first\0ZED=last\0\0");
    expect(childAccessEnvironmentBlock(childAccessCleanEnvironment("C:\\Windows", "D:\\private\\profile", "D:\\private\\temp")).subarray(-4)).toEqual(Buffer.alloc(4));
  });
  it.each([
    {}, { "BAD=KEY": "private" }, { "BAD\nKEY": "private" }, { GOOD: "private\0value" }, { GOOD: "private\rvalue" }, { GOOD: undefined },
    { PATH: "private first", Path: "private duplicate" },
  ])("refuses malformed environment block entries (%#)", env => { refusal(() => childAccessEnvironmentBlock(env), 3); });
  it("compiles only the fixed AAP/inherited-console fixture with explicit source/output and CRT-free entry", () => {
    const batch = childAccessCompileBatch("C:\\Program Files\\VS", "D:\\private\\build");
    expect(batch).toContain('call "C:\\Program Files\\VS\\VC\\Auxiliary\\Build\\vcvars64.bat" >nul\r\nif errorlevel 1 exit /b 1\r\n');
    expect(batch).toContain('/DEMBER_LPAC_CHILD_AAP_ONLY=1 /DEMBER_LPAC_CHILD_INHERIT_CONSOLE=1');
    expect(batch).toContain('/Fo"D:\\private\\build\\fixture.obj" /Fe"D:\\private\\build\\fixture.exe" "D:\\private\\build\\experimental-windows-lpac-inherited.c"');
    expect(batch).toContain('/link /NODEFAULTLIB /ENTRY:mainCRTStartup /SUBSYSTEM:CONSOLE kernel32.lib advapi32.lib\r\n');
    expect(batch).not.toMatch(/NULL_SECURITY|CHILD_DETACHED|SECURITY_CAPABILITIES|no-sandbox|powershell|curl|https?:/i);
    expect(CHILD_ACCESS_RECIPE).toBe('/nologo /O1 /GS- /Zl /DEMBER_LPAC_CHILD_AAP_ONLY=1 /DEMBER_LPAC_CHILD_INHERIT_CONSOLE=1 /link /NODEFAULTLIB /ENTRY:mainCRTStartup /SUBSYSTEM:CONSOLE kernel32.lib advapi32.lib');
    refusal(() => childAccessCompileBatch("C:\\private\\VS&extra", "D:\\private\\build"), 1);
  });
});

describe("fixed witness source and manifest provenance", () => {
  it("binds exactly the three unchanged public fixture sources to the frozen base", () => {
    expect(CHILD_ACCESS_BASE).toBe("a1f10fc515d312d8ae28970712fbc9f02064d9d2");
    expect(Object.keys(CHILD_ACCESS_SOURCES)).toEqual(["experimental-windows-lpac.c", "experimental-windows-lpac-inherited.c", "windows-lpac-child-sd-diagnostic.h"]);
    for (const [file, hash] of Object.entries(CHILD_ACCESS_SOURCES))
      expect(childAccessSha256(fs.readFileSync(new URL(`../fixtures/${file}`, import.meta.url)))).toBe(hash);
    expect(Object.isFrozen(CHILD_ACCESS_SOURCES)).toBe(true);
  });
  it("copies admitted source bytes and requests no extra source file", () => {
    const originals = new Map(Object.keys(CHILD_ACCESS_SOURCES).map(file => [file, fs.readFileSync(new URL(`../fixtures/${file}`, import.meta.url))]));
    const requested: string[] = [], sources = childAccessSourceCopies(file => { requested.push(file); return originals.get(file)!; });
    expect(requested).toEqual(Object.keys(CHILD_ACCESS_SOURCES));
    for (const [file, bytes] of sources) { expect(bytes.equals(originals.get(file)!)).toBe(true); expect(bytes).not.toBe(originals.get(file)); }
    for (const bytes of originals.values()) bytes.fill(0);
    expect(childAccessManifest(COMMIT, PE, SIGNATURE, sources).sources).toBe(CHILD_ACCESS_SOURCES);
  });
  it("refuses changed, missing, oversized or unreadable public source bytes with a fixed error", () => {
    for (const bytes of [Buffer.alloc(0), Buffer.from("private changed source"), Buffer.alloc(1024 * 1024 + 1)])
      refusal(() => childAccessSourceCopies(() => bytes), 4);
    refusal(() => childAccessSourceCopies(() => { throw new Error("C:\\private\\source unavailable"); }), 4);
  });
  it("mints one immutable issuer-bound manifest and checks exact commit and current PE bytes", () => {
    const executable = Buffer.from(PE), signature = Buffer.from(SIGNATURE), sources = publicSources();
    const manifest = childAccessManifest(COMMIT, executable, signature, sources);
    expect(manifest).toEqual({ issuer: CHILD_ACCESS_ISSUER, sourceBase: CHILD_ACCESS_BASE, sourceCommit: COMMIT, sources: CHILD_ACCESS_SOURCES,
      recipeSha256: childAccessSha256(CHILD_ACCESS_RECIPE), executableSha256: childAccessSha256(PE), toolArchiveSha256: CHILD_ACCESS_TOOL.archiveSha256,
      toolExecutableSha256: CHILD_ACCESS_TOOL.executableSha256, microsoftSignature: true });
    expect(Object.isFrozen(manifest)).toBe(true); expect(childAccessManifestCurrent(manifest, COMMIT, PE)).toBe(true);
    expect(childAccessManifestCurrent(manifest, OTHER_COMMIT, PE)).toBe(false);
    executable[2] ^= 1; expect(childAccessManifestCurrent(manifest, COMMIT, executable)).toBe(false);
    signature.fill(0); expect(childAccessManifestCurrent(manifest, COMMIT, PE)).toBe(true); // A completed receipt's bytes are not retained as mutable authority.
  });
  it("refuses copied/JSON/forged manifest identities and copied source-map identities", () => {
    const sources = publicSources(), manifest = childAccessManifest(COMMIT, PE, SIGNATURE, sources);
    for (const value of [null, {}, { ...manifest }, JSON.parse(JSON.stringify(manifest)), new Proxy(manifest, {})])
      expect(childAccessManifestCurrent(value, COMMIT, PE)).toBe(false);
    refusal(() => childAccessManifest(COMMIT, PE, SIGNATURE, new Map(sources)), 5);
  });
  it("revalidates registered source bytes and exact map membership before minting", () => {
    const changed = publicSources(); changed.values().next().value![0] ^= 1;
    refusal(() => childAccessManifest(COMMIT, PE, SIGNATURE, changed), 5);
    const extra = publicSources(); extra.set("private.txt", Buffer.from("private")); refusal(() => childAccessManifest(COMMIT, PE, SIGNATURE, extra), 5);
    const missing = publicSources(); missing.delete("experimental-windows-lpac.c"); refusal(() => childAccessManifest(COMMIT, PE, SIGNATURE, missing), 5);
    const malformed = publicSources(); malformed.set("experimental-windows-lpac.c", {} as Buffer);
    refusal(() => childAccessManifest(COMMIT, PE, SIGNATURE, malformed), 5);
  });
  it.each(["", "a".repeat(39), "A".repeat(40), "private commit"])("refuses malformed source commit declarations (%#)", commit => {
    refusal(() => childAccessManifest(commit, PE, SIGNATURE, publicSources()), 5);
  });
  it.each([Buffer.alloc(0), Buffer.from([1, 0, 0]), Buffer.alloc(4), Buffer.from([2, 0, 0, 0]), Buffer.alloc(8)])("requires exactly the completed signature DWORD receipt (%#)", signature => {
    refusal(() => childAccessManifest(COMMIT, PE, signature, publicSources()), 5);
  });
  it("refuses missing/non-PE/oversized executable artifacts", () => {
    for (const executable of [Buffer.alloc(0), Buffer.from("M"), Buffer.from("private executable"), Buffer.alloc(CHILD_ACCESS_ARCHIVE_MAX + 1)])
      refusal(() => childAccessManifest(COMMIT, executable, SIGNATURE, publicSources()), 5);
    const shared = new Uint8Array(new SharedArrayBuffer(PE.length)); shared.set(PE);
    refusal(() => childAccessManifest(COMMIT, shared, SIGNATURE, publicSources()), 5);
  });
  it("keeps the official immutable URL/hash pins and independent trace/output bounds", () => {
    expect(CHILD_ACCESS_TOOL.url).toBe("https://download.sysinternals.com/files/ProcessMonitor.zip");
    expect(CHILD_ACCESS_TOOL.archiveSha256).toMatch(/^[a-f0-9]{64}$/); expect(CHILD_ACCESS_TOOL.executableSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(CHILD_ACCESS_TOOL)).toBe(true);
    expect([CHILD_ACCESS_ARCHIVE_MAX, CHILD_ACCESS_PML_MAX, CHILD_ACCESS_CSV_MAX]).toEqual([16 * 1024 * 1024, 64 * 1024 * 1024, 32 * 1024 * 1024]);
  });
});

type Entry = { name?: string; bytes?: Buffer; method?: number; flags?: number; external?: number; checksum?: number; size?: number;
  localFlags?: number; localMethod?: number; localName?: string; localChecksum?: number; payload?: Buffer };
function zip(entries: Entry[] = [{}]): Buffer {
  const local: Buffer[] = [], directory: Buffer[] = []; let at = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name ?? "Procmon64.exe", "ascii"), bytes = entry.bytes ?? PE, method = entry.method ?? 0, flags = entry.flags ?? 0;
    const payload = entry.payload ?? (method === 8 ? deflateRawSync(bytes) : Buffer.from(bytes)), checksum = entry.checksum ?? crc32(bytes), size = entry.size ?? bytes.length;
    const localName = Buffer.from(entry.localName ?? entry.name ?? "Procmon64.exe", "ascii"), head = Buffer.alloc(30), record = Buffer.alloc(46);
    head.writeUInt32LE(0x04034b50); head.writeUInt16LE(20, 4); head.writeUInt16LE(entry.localFlags ?? flags, 6); head.writeUInt16LE(entry.localMethod ?? method, 8);
    head.writeUInt32LE(entry.localChecksum ?? (flags & 8 ? 0 : checksum), 14); head.writeUInt32LE(flags & 8 ? 0 : payload.length, 18); head.writeUInt32LE(flags & 8 ? 0 : size, 22); head.writeUInt16LE(localName.length, 26);
    const descriptor = flags & 8 ? Buffer.alloc(16) : Buffer.alloc(0);
    if (flags & 8) { descriptor.writeUInt32LE(0x08074b50); descriptor.writeUInt32LE(checksum, 4); descriptor.writeUInt32LE(payload.length, 8); descriptor.writeUInt32LE(size, 12); }
    local.push(head, localName, payload, descriptor);
    record.writeUInt32LE(0x02014b50); record.writeUInt16LE(0x0314, 4); record.writeUInt16LE(20, 6); record.writeUInt16LE(flags, 8); record.writeUInt16LE(method, 10);
    record.writeUInt32LE(checksum, 16); record.writeUInt32LE(payload.length, 20); record.writeUInt32LE(size, 24); record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE(entry.external ?? 0, 38); record.writeUInt32LE(at, 42); directory.push(record, name);
    at += head.length + localName.length + payload.length + descriptor.length;
  }
  const central = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(central.length, 12); end.writeUInt32LE(at, 16); return Buffer.concat([...local, central, end]);
}

describe("bounded fixed Procmon ZIP entry", () => {
  it.each([0, 8])("reads only the fixed regular PE for compression method %s without writing archive paths", method => {
    const archive = zip([{ name: "readme.txt", bytes: Buffer.from("private documentation") }, { method }]), original = Buffer.from(archive);
    const result = childAccessZipEntry(archive); expect(result.equals(PE)).toBe(true); expect(archive.equals(original)).toBe(true);
    result.fill(0); expect(childAccessZipEntry(archive).equals(PE)).toBe(true);
  });
  it.each([2, 4, 6, 0x800, 8, 0x808])("accepts only documented supported deflate options/UTF-8/data-descriptor flags (%s)", flags => {
    expect(childAccessZipEntry(zip([{ method: 8, flags }])).equals(PE)).toBe(true);
  });
  it.each([
    { flags: 1 }, { flags: 0x10 }, { flags: 0x40 }, { method: 0, flags: 2 }, { method: 99 },
    { external: 0x10 }, { external: (0xa1ff << 16) >>> 0 }, { external: (0x41ff << 16) >>> 0 }, { external: (0x61ff << 16) >>> 0 },
    { bytes: Buffer.from("private non-PE") }, { bytes: Buffer.from("M") },
    { checksum: 0 }, { localChecksum: 0 }, { localFlags: 8 }, { localMethod: 8 }, { localName: "different.exe" },
    { size: CHILD_ACCESS_ARCHIVE_MAX + 1 }, { payload: Buffer.from("private invalid deflate"), method: 8 },
  ])("refuses encryption, unsupported types/flags and inconsistent target metadata (%#)", entry => { refusal(() => childAccessZipEntry(zip([entry])), 6); });
  it.each(["../Procmon64.exe", "private/Procmon64.exe", "private\\Procmon64.exe", "C:Procmon64.exe", "Procmon64.exe:stream", "private..txt"])("refuses every unsafe archive name even for ignored entries (%#)", name => {
    refusal(() => childAccessZipEntry(zip([{ name, bytes: Buffer.from("ignored") }, {}])), 6);
  });
  it("refuses duplicate or missing target entries", () => {
    refusal(() => childAccessZipEntry(zip([{}, {}])), 6);
    refusal(() => childAccessZipEntry(zip([{ name: "Procmon.exe" }])), 6);
  });
  it("requires exact data-descriptor CRC and sizes with either public descriptor spelling", () => {
    const archive = zip([{ method: 8, flags: 8 }]), descriptor = archive.indexOf(Buffer.from([0x50, 0x4b, 0x07, 0x08]));
    expect(descriptor).toBeGreaterThan(0); expect(childAccessZipEntry(archive).equals(PE)).toBe(true);
    for (const offset of [4, 8, 12]) {
      const bad = Buffer.from(archive); bad.writeUInt32LE(0, descriptor + offset); refusal(() => childAccessZipEntry(bad), 6);
    }
    const unsigned = Buffer.concat([archive.subarray(0, descriptor), archive.subarray(descriptor + 4)]);
    const directoryAt = unsigned.readUInt32LE(unsigned.length - 6); unsigned.writeUInt32LE(directoryAt - 4, unsigned.length - 6);
    expect(childAccessZipEntry(unsigned).equals(PE)).toBe(true);
  });
  it("refuses truncated/trailing archives, multiple disks and incomplete central records", () => {
    const archive = zip(); refusal(() => childAccessZipEntry(archive.subarray(0, -1)), 6);
    refusal(() => childAccessZipEntry(Buffer.concat([archive, Buffer.from("private trailing")])), 6);
    const split = Buffer.from(archive); split.writeUInt16LE(1, split.length - 22 + 4); refusal(() => childAccessZipEntry(split), 6);
    const count = Buffer.from(archive); count.writeUInt16LE(2, count.length - 22 + 8); refusal(() => childAccessZipEntry(count), 6);
    const central = Buffer.from(archive), directoryAt = central.readUInt32LE(central.length - 6); central.writeUInt32LE(0, directoryAt); refusal(() => childAccessZipEntry(central), 6);
  });
  it("bounds source bytes, entry count and actual inflated output independently of advertised size", () => {
    refusal(() => childAccessZipEntry(Buffer.alloc(CHILD_ACCESS_ARCHIVE_MAX + 1)), 6);
    refusal(() => childAccessZipEntry(zip([{}, ...Array.from({ length: 32 }, (_, index) => ({ name: `file${index}.txt`, bytes: Buffer.from("ignored") }))])), 6);
    refusal(() => childAccessZipEntry(zip([{ method: 8, bytes: Buffer.alloc(CHILD_ACCESS_ARCHIVE_MAX + 1, 0x41), size: 2 }])), 6);
  });
  it("refuses synthetic but structurally valid ZIPs at the independent official SHA pin", () => {
    const archive = zip([{ method: 8 }]); expect(childAccessZipEntry(archive).equals(PE)).toBe(true);
    refusal(() => childAccessPinnedProcmon(archive), 7);
  });
});

describe("fixed tool argv and performance-only PMC metadata", () => {
  it("quotes the explicit ordinary program and every argument without invoking a shell", () => {
    expect(childAccessCommand("C:\\Program Files\\Procmon64.exe", ["/BackingFile", "D:\\private\\trace.pml", 'quote"inside', "trailing\\"]).toString("utf16le"))
      .toBe('"C:\\Program Files\\Procmon64.exe" "/BackingFile" "D:\\private\\trace.pml" "quote\\"inside" "trailing\\\\"\0');
  });
  it.each([["private\0value"], ["private\nvalue"], ["private\u202evalue"], Array.from({ length: 21 }, () => "x"), ["x".repeat(32768)]].map(args => ({ args })))("refuses malformed or excessive command arguments (%#)", ({ args }) => {
    refusal(() => childAccessCommand("D:\\private\\Procmon64.exe", args), 8);
  });
  it.each([0, -1, 1.5, NaN, Infinity, 0x100000000])("refuses invalid PID filter metadata without acquiring process authority (%s)", pid => {
    refusal(() => childAccessProcmonConfiguration(pid), 8);
  });
  it("encodes only two fixed performance filters and returns a fresh bounded PMC buffer", () => {
    const config = childAccessProcmonConfiguration(4242), records = new Map<string, Buffer>(); let cursor = 0;
    while (cursor < config.length) {
      const total = config.readUInt32LE(cursor), nameAt = config.readUInt32LE(cursor + 4), dataAt = config.readUInt32LE(cursor + 8), bytes = config.readUInt32LE(cursor + 12);
      expect(nameAt).toBe(16); expect(dataAt + bytes).toBe(total);
      records.set(config.toString("utf16le", cursor + nameAt, cursor + dataAt - 2), config.subarray(cursor + dataAt, cursor + dataAt + bytes)); cursor += total;
    }
    expect(cursor).toBe(config.length); expect(config.length).toBeLessThan(2048); expect([...records.keys()]).toEqual(["FilterRules", "DestructiveFilter"]);
    expect(records.get("DestructiveFilter")).toEqual(Buffer.from([1, 0, 0, 0]));
    const rules = records.get("FilterRules")!; expect(rules[0]).toBe(1); expect(rules.readUInt32LE(1)).toBe(2);
    let offset = 5; const decoded: { field: number; text: string; numeric: number }[] = [];
    for (let index = 0; index < 2; index++) {
      const field = rules.readUInt32LE(offset); expect(rules.readUInt32LE(offset + 4)).toBe(0); expect(rules[offset + 8]).toBe(1);
      const bytes = rules.readUInt32LE(offset + 9), text = rules.toString("utf16le", offset + 13, offset + 13 + bytes - 2);
      expect(rules.subarray(offset + 13 + bytes - 2, offset + 13 + bytes)).toEqual(Buffer.alloc(2));
      const numeric = rules.readUInt32LE(offset + 13 + bytes); expect(rules.readUInt32LE(offset + 17 + bytes)).toBe(0);
      decoded.push({ field, text, numeric }); offset += 21 + bytes;
    }
    expect(offset).toBe(rules.length); expect(decoded).toEqual([{ field: 40054, text: "4242", numeric: 4242 }, { field: 40053, text: "fixture.exe", numeric: 0 }]);
    config.fill(0); expect(childAccessProcmonConfiguration(4242).some(value => value !== 0)).toBe(true);
    expect(childAccessProcmonConfiguration(0xffffffff).length).toBeLessThan(2048);
  });
});
