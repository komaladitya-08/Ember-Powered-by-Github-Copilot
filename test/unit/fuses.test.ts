/**
 * M9: the installed Ember's fuses (scripts/package/fuses.mjs): no --inspect, no NODE_OPTIONS anywhere; node mode
 * (RunAsNode) refused on macOS (review #177) and kept on Linux and Windows, where Ember's helpers still need it.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EMBER_FUSES, FUSES, SENTINEL, emberFuses, fatArchCount, findWire, flipFuses, fuseMismatches, readFuses, setFuses } from "../../scripts/package/fuses.mjs";
import { TARGETS, layoutFor } from "../../scripts/package/layout.mjs";

/** A fake binary: junk, the fuse wire (Electron 44's defaults unless given), more junk. */
const fake = (wire = "101100011", o: { version?: number; sentinels?: number } = {}) => Buffer.concat([
  Buffer.alloc(4096, 0x90),
  ...Array.from({ length: o.sentinels ?? 1 }, () => Buffer.concat([Buffer.from(SENTINEL, "latin1"), Buffer.from([o.version ?? 1, wire.length]), Buffer.from(wire, "latin1"), Buffer.alloc(64, 0xcc)])),
  Buffer.alloc(4096, 0x90),
]);

/** Linux's and Windows' fuses: the wire tests below are about the wire, whichever OS runs them. */
const LINUX = emberFuses("linux");

describe("Ember's fuses per OS", () => {
  it("refuses node mode on macOS only, and --inspect and NODE_OPTIONS everywhere (review #177)", () => {
    expect(emberFuses("darwin")).toEqual({ RunAsNode: false, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false });
    // Linux's desk helper and Windows' job host, accessibility host, askpass and WSL launcher still run as plain Node.
    for (const os of ["linux", "win32"] as const) {
      expect(emberFuses(os)).toEqual({ RunAsNode: true, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false });
    }
    // What stage.mjs and --check use: the fuses of the OS they run on (each OS stages and checks its own build).
    expect([emberFuses("linux"), emberFuses("darwin"), emberFuses("win32")]).toContainEqual(EMBER_FUSES);
  });

  it("flips RunAsNode off in a macOS binary and says so when a binary still has it on", () => {
    const bin = fake();
    const fuses = setFuses(bin, emberFuses("darwin"));
    expect(fuses).toMatchObject({ RunAsNode: false, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false });
    expect(bin.subarray(findWire(bin).start, findWire(bin).start + 4).toString("latin1")).toBe("0000");
    expect(fuseMismatches(readFuses(fake()), emberFuses("darwin"))).toContain("RunAsNode: is on, should be off");
    expect(fuseMismatches(fuses, emberFuses("darwin"))).toEqual([]);
  });

  it("refuses an OS it doesn't know rather than guess", () => {
    expect(() => emberFuses("freebsd" as NodeJS.Platform)).toThrow(/no fuses for freebsd/);
  });
});

describe("the fuse wire", () => {
  it("reads every fuse by name, in Electron's order", () => {
    expect(readFuses(fake())).toEqual({
      RunAsNode: true, EnableCookieEncryption: false, EnableNodeOptionsEnvironmentVariable: true, EnableNodeCliInspectArguments: true,
      EnableEmbeddedAsarIntegrityValidation: false, OnlyLoadAppFromAsar: false, LoadBrowserProcessSpecificV8Snapshot: false,
      GrantFileProtocolExtraPrivileges: true, WasmTrapHandlers: true,
    });
    expect(FUSES.slice(0, 4)).toEqual(["RunAsNode", "EnableCookieEncryption", "EnableNodeOptionsEnvironmentVariable", "EnableNodeCliInspectArguments"]);
    // A fuse newer than the script, and a removed one.
    expect(readFuses(fake("1r11000111"))).toMatchObject({ EnableCookieEncryption: "removed", fuse9: true });
  });

  it("sets Ember's fuses and touches no other byte", () => {
    const before = fake();
    const bin = Buffer.from(before);
    const fuses = setFuses(bin, LINUX);
    expect(fuses).toMatchObject({ RunAsNode: true, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false, GrantFileProtocolExtraPrivileges: true });
    expect(fuseMismatches(fuses, LINUX)).toEqual([]);
    const { start } = findWire(bin);
    const changed = [...bin.keys()].filter(i => bin[i] !== before[i]);
    expect(changed).toEqual([start + 2, start + 3]);
    expect(bin.subarray(start, start + 9).toString("latin1")).toBe("100000011");
    // Setting them again changes nothing.
    expect(setFuses(Buffer.from(bin), LINUX)).toEqual(fuses);
  });

  it("says which fuses are wrong", () => {
    expect(fuseMismatches(readFuses(fake()), LINUX)).toEqual([
      "EnableNodeOptionsEnvironmentVariable: is on, should be off",
      "EnableNodeCliInspectArguments: is on, should be off",
    ]);
    expect(fuseMismatches(readFuses(fake("0")), LINUX)).toContain("EnableNodeCliInspectArguments: is missing, should be off");
  });

  it("refuses a binary it doesn't understand, changing nothing", () => {
    expect(() => readFuses(Buffer.alloc(100))).toThrow(/no fuse wire/);
    expect(() => readFuses(fake(undefined, { version: 2 }))).toThrow(/version 2/);
    expect(() => readFuses(fake(undefined, { sentinels: 2 }))).toThrow(/more than one/);
    const short = fake("10");
    expect(() => setFuses(short, LINUX)).toThrow(/no EnableNodeOptionsEnvironmentVariable fuse/);
    expect(readFuses(short)).toEqual({ RunAsNode: true, EnableCookieEncryption: false });
    const removed = fake("1011r0011");
    expect(() => setFuses(removed, { RunAsNode: true, EnableNodeCliInspectArguments: false, EnableNodeOptionsEnvironmentVariable: false })).not.toThrow();
    const gone = fake("10r100011");
    expect(() => setFuses(gone, LINUX)).toThrow(/EnableNodeOptionsEnvironmentVariable can't be set: it is removed/);
    expect(readFuses(gone).EnableNodeCliInspectArguments).toBe(true);
    expect(() => setFuses(fake(), { NoSuchFuse: false })).toThrow(/no fuse named NoSuchFuse/);
  });

  it("refuses a universal macOS binary, which has one wire per architecture, and changes nothing", () => {
    // A fat header (big-endian magic, slice count) and two slices, each with Electron's default wire.
    const fat = (magic: number, slices: number) => {
      const header = Buffer.alloc(8);
      header.writeUInt32BE(magic, 0);
      header.writeUInt32BE(slices, 4);
      return Buffer.concat([header, ...Array.from({ length: slices }, () => fake())]);
    };
    const universal = fat(0xcafebabe, 2);
    expect(fatArchCount(universal)).toBe(2);
    expect(fatArchCount(fat(0xcafebabf, 2))).toBe(2);
    expect(() => readFuses(universal)).toThrow(/universal binary \(2 architectures/);
    expect(() => setFuses(universal, LINUX)).toThrow(/stage one architecture per build/);
    expect(universal.equals(fat(0xcafebabe, 2))).toBe(true);
    // Not fat: an ordinary binary, and a Java class file (same magic, then its version: 52 for Java 8).
    expect(fatArchCount(fake())).toBe(0);
    const javaLike = Buffer.concat([Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 52]), fake()]);
    expect(fatArchCount(javaLike)).toBe(0);
    expect(readFuses(javaLike).RunAsNode).toBe(true);
    expect(fatArchCount(Buffer.from([0xca, 0xfe]))).toBe(0);
  });

  it("flips a file in place, keeping its mode", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-fuses-"));
    try {
      const file = path.join(dir, "ember");
      fs.writeFileSync(file, fake(), { mode: 0o755 });
      expect(fuseMismatches(flipFuses(file, LINUX), LINUX)).toEqual([]);
      expect(fuseMismatches(readFuses(fs.readFileSync(file)), LINUX)).toEqual([]);
      // Windows has no POSIX modes to keep (stat reports 0o666 for any writable file).
      if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o755);
      expect(fs.statSync(file).size).toBe(fake().length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("matches the Electron in node_modules (when it is downloaded): the binary itself, or macOS's framework", () => {
    // A development machine Ember isn't staged for (linux-arm64, say) has nothing to compare.
    if (!TARGETS.includes(`${process.platform}-${process.arch}`)) return;
    const layout = layoutFor(process.platform, process.arch);
    const electron = path.resolve("node_modules/electron/dist", layout.electronFuseFile);
    if (!fs.existsSync(electron)) return;
    // Electron's path.txt names its executable as stage.mjs expects to find it (require("electron") reads it).
    expect(fs.readFileSync(path.resolve("node_modules/electron/path.txt"), "utf8").trim()).toBe(layout.electronExe);
    const fuses = readFuses(fs.readFileSync(electron));
    // Electron's defaults: what stage.mjs turns off is on (RunAsNode too: macOS's build turns it off, the others keep it).
    expect(fuses).toMatchObject({ RunAsNode: true, EnableNodeOptionsEnvironmentVariable: true, EnableNodeCliInspectArguments: true });
  });
});
