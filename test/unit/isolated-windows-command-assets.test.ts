import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path/win32";
import { bindWindowsCommandAssetReader, measureWindowsPowerShellToolchain, ordinaryWindowsCommandAssetSize, prepareWindowsPowerShellProof } from "../../app/main/agent/isolated-windows-command-assets";
import type { WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";

const root = "C:\\Program Files\\PowerShell\\7";
const required = ["pwsh.exe", "pwsh.dll", "pwsh.deps.json", "pwsh.runtimeconfig.json", "hostfxr.dll", "hostpolicy.dll", "coreclr.dll", "System.Management.Automation.dll"];
afterEach(() => vi.restoreAllMocks());
function information(attributes = 0x20, links = 1, size = 4n) {
  const info = Buffer.alloc(52); info.writeUInt32LE(attributes); info.writeUInt32LE(links, 40);
  info.writeUInt32LE(Number(size >> 32n), 32); info.writeUInt32LE(Number(size & 0xffffffffn), 36); return info;
}
function native(failure = "") {
  const calls: { name: string; args: unknown[] }[] = [], payload = Buffer.from("MZps");
  let inspections = 0, offset = 0;
  const reader = bindWindowsCommandAssetReader(() => ({ func: prototype => {
    const name = /\b(\w+)\s*\(/.exec(prototype)![1];
    return (...args: unknown[]) => {
      calls.push({ name, args });
      if (name === "CreateFileW") return 7n;
      if (name === "GetLastError") return 5;
      if (name === "GetFileInformationByHandle") {
        const info = information(failure === "reparse" ? 0x420 : 0x20);
        if (++inspections === 2 && failure === "changed") info.writeUInt32LE(9, 44);
        info.copy(args[1] as Buffer); return 1;
      }
      if (name === "ReadFile") {
        const count = failure === "short" ? 0 : Math.min(2, Number(args[2]));
        payload.copy(args[1] as Buffer, 0, offset, offset + count); offset += count;
        (args[3] as number[])[0] = count; return 1;
      }
      return 1;
    };
  } }));
  return { reader, calls };
}
function tree() {
  const files = new Map(required.map(name => [path.join(root, name), Buffer.from("MZ" + name)]));
  const listings = new Map<string, { name: string; type: "file" | "directory" | "link" }[]>([[root, required.map(name => ({ name, type: "file" }))]]);
  vi.spyOn(fs, "opendirSync").mockImplementation((directory) => {
    const entries = listings.get(String(directory)); if (!entries) throw new Error("unknown directory");
    let index = 0;
    return { readSync: () => {
      const entry = entries[index++];
      return entry ? { name: entry.name, isFile: () => entry.type === "file", isDirectory: () => entry.type === "directory" } : null;
    }, closeSync: () => undefined } as ReturnType<typeof fs.opendirSync>;
  });
  vi.spyOn(fs.realpathSync, "native").mockReturnValue("C:\\scratch");
  let handle = 100n;
  const read = vi.fn((file: string) => { const data = files.get(file); if (!data) throw new Error("missing asset"); return data; });
  const writes: { file: string; bytes: Buffer; sddl: string }[] = [];
  const api: WindowsLpacApi = {
    createProfile: vi.fn(name => ({ name, sid: 9n, sidText: "S-1-15-2-1234" })), deleteProfile: vi.fn(),
    profileLocalAppDataBase: () => "C:\\owner\\AppData\\Local",
    ownerSid: () => "S-1-5-21-1234", windowsDirectory: () => "C:\\Windows", volumeFileSystem: () => "NTFS",
    pinDirectory: vi.fn(() => handle++), close: vi.fn(), createDirectory: vi.fn(),
    writeNewFile: (file, bytes, sddl) => { writes.push({ file, bytes, sddl }); },
    createJob: vi.fn(() => 1n), createSuspended: vi.fn(() => ({ process: 2n, thread: 3n, pid: 44 })),
    assign: vi.fn(), verifyToken: vi.fn(), resume: vi.fn(), terminateJob: vi.fn(), terminateProcess: vi.fn(),
    exited: () => true, jobState: () => ({ active: 0, listed: 0 }), exitCode: () => 0,
  };
  return { api, reader: { read }, read, files, listings, writes };
}

it("rejects native reparse/sparse/device/dir/offline/encrypted attributes, hardlinks and oversized files", () => {
  expect(ordinaryWindowsCommandAssetSize(information())).toBe(4);
  for (const attr of [0x10, 0x40, 0x200, 0x400, 0x1000, 0x4000]) expect(() => ordinaryWindowsCommandAssetSize(information(attr))).toThrow("ordinary");
  for (const links of [0, 2]) expect(() => ordinaryWindowsCommandAssetSize(information(0x20, links))).toThrow("ordinary");
  expect(() => ordinaryWindowsCommandAssetSize(information(0x20, 1, 0x100000000n))).toThrow("size bound");
});
it("opens native assets without following reparses or sharing write/delete and rechecks identity after partial reads", () => {
  const s = native(); expect(s.reader.read("C:\\trusted\\pwsh.exe").toString()).toBe("MZps");
  expect(s.calls[0]).toEqual({ name: "CreateFileW", args: ["C:\\trusted\\pwsh.exe", 0x80000080, 1, null, 3, 0x00200000, null] });
  expect(s.calls.filter(c => c.name === "GetFileInformationByHandle")).toHaveLength(2);
  expect(s.calls.at(-1)).toEqual({ name: "CloseHandle", args: [7n] });
});
for (const failure of ["reparse", "short", "changed"]) it(`fails closed and closes native asset on ${failure}`, () => {
  const s = native(failure); expect(() => s.reader.read("C:\\asset")).toThrow();
  expect(s.calls.at(-1)?.name).toBe("CloseHandle");
});
it("measures all asset bytes and path names deterministically without executing them", () => {
  const s = tree(), first = measureWindowsPowerShellToolchain(root, s.api, s.reader);
  s.listings.get(root)!.reverse();
  expect(measureWindowsPowerShellToolchain(root, s.api, s.reader)).toEqual(first);
  s.files.set(path.join(root, "pwsh.dll"), Buffer.from("different bytes"));
  expect(measureWindowsPowerShellToolchain(root, s.api, s.reader).sha256).not.toBe(first.sha256);
  expect(s.api.createProfile).not.toHaveBeenCalled(); expect(s.api.createSuspended).not.toHaveBeenCalled();
});
it("rejects reparse ancestry before reading any asset and closes earlier directory pins", () => {
  const s = tree(); vi.mocked(s.api.pinDirectory).mockImplementation(file => { if (file.endsWith("PowerShell")) throw new Error("reparse"); return 99n; });
  expect(() => measureWindowsPowerShellToolchain(root, s.api, s.reader)).toThrow("reparse");
  expect(s.read).not.toHaveBeenCalled(); expect(s.api.close).toHaveBeenCalledTimes(2);
});
for (const name of ["evil:stream", "NUL.dll", "trailing.", "fixture.exe", "PWSH.EXE"]) it(`rejects unsupported/colliding asset ${name}`, () => {
  const s = tree(); s.listings.get(root)!.push({ name, type: "file" });
  expect(() => measureWindowsPowerShellToolchain(root, s.api, s.reader)).toThrow();
});
it("rejects link entries, missing runtime assets, entry-count and depth overflow", () => {
  const s = tree(), entries = s.listings.get(root)!;
  entries.push({ name: "linked", type: "link" }); expect(() => measureWindowsPowerShellToolchain(root, s.api, s.reader)).toThrow("link or special");
  entries.pop(); entries.pop(); expect(() => measureWindowsPowerShellToolchain(root, s.api, s.reader)).toThrow("incomplete");
  entries.splice(0, entries.length, ...Array.from({ length: 4097 }, (_, i) => ({ name: `entry${i}`, type: "file" as const })));
  s.read.mockReturnValue(Buffer.alloc(0)); expect(() => measureWindowsPowerShellToolchain(root, s.api, s.reader)).toThrow("entry count");
  entries.length = 0;
  let directory = root;
  for (let i = 0; i < 18; i++) { s.listings.set(directory, [{ name: "deep", type: "directory" }]); directory = path.join(directory, "deep"); }
  expect(() => measureWindowsPowerShellToolchain(root, s.api, s.reader)).toThrow("depth");
});
it("rejects an untrusted manifest before creating any package profile or destination ACL", async () => {
  const s = tree(); await expect(prepareWindowsPowerShellProof("C:\\scratch", { assetRoot: root, manifestSha256: "0".repeat(64) }, s.api, s.reader)).rejects.toThrow("does not match");
  expect(s.api.createProfile).not.toHaveBeenCalled(); expect(s.writes).toHaveLength(0);
});
it("stages fresh RX package-SID bytes, retains source ACLs and uses the fixture LPAC/job/token launch sequence", async () => {
  const s = tree(), trust = { assetRoot: root, manifestSha256: measureWindowsPowerShellToolchain(root, s.api, s.reader).sha256 };
  const staged = await prepareWindowsPowerShellProof("C:\\scratch", trust, s.api, s.reader);
  expect(staged.manifest.files).toBe(required.length); expect(s.writes).toHaveLength(required.length + 1);
  for (const write of s.writes) {
    expect(write.file).toContain("C:\\scratch\\ember-lpac-");
    expect(write.sddl).toContain("0x1200a9;;;S-1-15-2-1234"); expect(write.sddl).not.toMatch(/;;;AC|;;;S-1-15-2-1\)/);
  }
  await staged.fixture.launch(["-NoProfile", "-NonInteractive", "-Command", "harmless"]);
  expect(s.api.createJob).toHaveBeenCalledOnce(); expect(s.api.assign).toHaveBeenCalledWith(1n, 2n);
  expect(s.api.verifyToken).toHaveBeenCalledWith(expect.objectContaining({ sidText: "S-1-15-2-1234" }), 2n);
  expect(s.api.resume).toHaveBeenCalledWith(3n);
  await staged.close(); expect(s.api.deleteProfile).toHaveBeenCalledOnce();
});
it("does not launch if a previously measured companion changes while fresh copies are staged", async () => {
  const s = tree(), trust = { assetRoot: root, manifestSha256: measureWindowsPowerShellToolchain(root, s.api, s.reader).sha256 };
  s.read.mockClear();
  const original = s.read.getMockImplementation()!;
  s.read.mockImplementation(file => s.read.mock.calls.length > required.length && file.endsWith("pwsh.dll") ? Buffer.from("changed") : original(file));
  await expect(prepareWindowsPowerShellProof("C:\\scratch", trust, s.api, s.reader)).rejects.toThrow("changed before staging");
  expect(s.api.resume).not.toHaveBeenCalled(); expect(s.api.deleteProfile).toHaveBeenCalledOnce();
});

it("shares the terminal wrapper cleanup failure across concurrent and later close callers", async () => {
  const s = tree();
  s.listings.get(root)!.push({ name: "Modules", type: "directory" });
  s.listings.set(path.join(root, "Modules"), []);
  const trust = { assetRoot: root, manifestSha256: measureWindowsPowerShellToolchain(root, s.api, s.reader).sha256 };
  const staged = await prepareWindowsPowerShellProof("C:\\scratch", trust, s.api, s.reader);
  const pins = vi.mocked(s.api.pinDirectory);
  const index = pins.mock.calls.findIndex(([directory]) => directory.startsWith("C:\\scratch\\ember-lpac-") && directory.endsWith("\\Modules"));
  const handle = pins.mock.results[index].value as bigint;
  expect(typeof handle).toBe("bigint");
  s.api.close = vi.fn(value => { if (value === handle) throw new Error("destination handle close failed"); });
  const first = staged.close(), concurrent = staged.close();
  expect(concurrent).toBe(first);
  await expect(first).rejects.toThrow("destination handle close failed");
  await expect(concurrent).rejects.toThrow("destination handle close failed");
  const later = staged.close(); expect(later).toBe(first);
  await expect(later).rejects.toThrow("destination handle close failed");
  expect(s.api.close).toHaveBeenCalledTimes(1);
  expect(s.api.deleteProfile).toHaveBeenCalledOnce();
});
