/** M9: the installed Ember's fuses (scripts/package/fuses.mjs): no --inspect, no NODE_OPTIONS, plain Node kept for the desk helper. */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EMBER_FUSES, FUSES, SENTINEL, findWire, flipFuses, fuseMismatches, readFuses, setFuses } from "../../scripts/package/fuses.mjs";

/** A fake binary: junk, the fuse wire (Electron 44's defaults unless given), more junk. */
const fake = (wire = "101100011", o: { version?: number; sentinels?: number } = {}) => Buffer.concat([
  Buffer.alloc(4096, 0x90),
  ...Array.from({ length: o.sentinels ?? 1 }, () => Buffer.concat([Buffer.from(SENTINEL, "latin1"), Buffer.from([o.version ?? 1, wire.length]), Buffer.from(wire, "latin1"), Buffer.alloc(64, 0xcc)])),
  Buffer.alloc(4096, 0x90),
]);

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
    const fuses = setFuses(bin, EMBER_FUSES);
    expect(fuses).toMatchObject({ RunAsNode: true, EnableNodeOptionsEnvironmentVariable: false, EnableNodeCliInspectArguments: false, GrantFileProtocolExtraPrivileges: true });
    expect(fuseMismatches(fuses, EMBER_FUSES)).toEqual([]);
    const { start } = findWire(bin);
    const changed = [...bin.keys()].filter(i => bin[i] !== before[i]);
    expect(changed).toEqual([start + 2, start + 3]);
    expect(bin.subarray(start, start + 9).toString("latin1")).toBe("100000011");
    // Setting them again changes nothing.
    expect(setFuses(Buffer.from(bin), EMBER_FUSES)).toEqual(fuses);
  });

  it("says which fuses are wrong", () => {
    expect(fuseMismatches(readFuses(fake()), EMBER_FUSES)).toEqual([
      "EnableNodeOptionsEnvironmentVariable: is on, should be off",
      "EnableNodeCliInspectArguments: is on, should be off",
    ]);
    expect(fuseMismatches(readFuses(fake("0")), EMBER_FUSES)).toContain("EnableNodeCliInspectArguments: is missing, should be off");
  });

  it("refuses a binary it doesn't understand, changing nothing", () => {
    expect(() => readFuses(Buffer.alloc(100))).toThrow(/no fuse wire/);
    expect(() => readFuses(fake(undefined, { version: 2 }))).toThrow(/version 2/);
    expect(() => readFuses(fake(undefined, { sentinels: 2 }))).toThrow(/more than one/);
    const short = fake("10");
    expect(() => setFuses(short, EMBER_FUSES)).toThrow(/no EnableNodeOptionsEnvironmentVariable fuse/);
    expect(readFuses(short)).toEqual({ RunAsNode: true, EnableCookieEncryption: false });
    const removed = fake("1011r0011");
    expect(() => setFuses(removed, { RunAsNode: true, EnableNodeCliInspectArguments: false, EnableNodeOptionsEnvironmentVariable: false })).not.toThrow();
    const gone = fake("10r100011");
    expect(() => setFuses(gone, EMBER_FUSES)).toThrow(/EnableNodeOptionsEnvironmentVariable can't be set: it is removed/);
    expect(readFuses(gone).EnableNodeCliInspectArguments).toBe(true);
    expect(() => setFuses(fake(), { NoSuchFuse: false })).toThrow(/no fuse named NoSuchFuse/);
  });

  it("flips a file in place, keeping its mode", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-fuses-"));
    try {
      const file = path.join(dir, "ember");
      fs.writeFileSync(file, fake(), { mode: 0o755 });
      expect(fuseMismatches(flipFuses(file, EMBER_FUSES), EMBER_FUSES)).toEqual([]);
      expect(fuseMismatches(readFuses(fs.readFileSync(file)), EMBER_FUSES)).toEqual([]);
      expect(fs.statSync(file).mode & 0o777).toBe(0o755);
      expect(fs.statSync(file).size).toBe(fake().length);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("matches the Electron in node_modules (when it is downloaded)", () => {
    const electron = path.resolve("node_modules/electron/dist/electron");
    if (!fs.existsSync(electron)) return;
    const fuses = readFuses(fs.readFileSync(electron));
    // Electron's defaults: what stage.mjs turns off is on, and plain Node is there to keep.
    expect(fuses).toMatchObject({ RunAsNode: true, EnableNodeOptionsEnvironmentVariable: true, EnableNodeCliInspectArguments: true });
  });
});
