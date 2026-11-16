/** Real fixed artifact bytes; runs on Linux or Windows after the reviewed producer artifact is available. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { stageWindowsNodeToolchain, verifyWindowsNodeToolchain } from "../../scripts/package/windows-node-toolchain.mjs";

describe.skipIf(process.env.EMBER_WINDOWS_NODE_ASSET_TEST !== "1")("real pinned Windows Node assets", () => {
  let source: string, root = "", destination: string;
  beforeAll(() => {
    source = process.env.EMBER_WINDOWS_NODE_ASSET_SOURCE!;
    expect(source && path.isAbsolute(source)).toBe(true);
    expect(verifyWindowsNodeToolchain(source, "producer").files).toBe(4);
    root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-pinned-node-package-")); destination = path.join(root, "runtime");
    expect(stageWindowsNodeToolchain(source!, destination).files).toBe(3);
  });
  afterAll(() => { if (root) fs.rmSync(root, { recursive: true, force: true }); });
  it("stages only the exact Node, complete licence and producer receipt", () => {
    expect(fs.readdirSync(destination).sort()).toEqual(["LICENSE", "build-receipt.json", "node.exe"]);
    expect(verifyWindowsNodeToolchain(destination).files).toBe(3);
  });
  it("never replaces an existing destination", () => {
    expect(() => stageWindowsNodeToolchain(source!, destination)).toThrow("could not be verified");
    expect(verifyWindowsNodeToolchain(destination).files).toBe(3);
  });
  it("refuses altered licence bytes even when their size is unchanged", () => {
    const license = path.join(destination, "LICENSE"), fd = fs.openSync(license, "r+");
    try { fs.writeSync(fd, Buffer.from([0]), 0, 1, 0); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { expect(() => verifyWindowsNodeToolchain(destination)).toThrow("could not be verified"); }
    finally { fs.copyFileSync(path.join(source!, "LICENSE"), license); }
    expect(verifyWindowsNodeToolchain(destination).files).toBe(3);
  });
  it("refuses an extra file beside the executable", () => {
    const extra = path.join(destination, "unexpected.dll"); fs.writeFileSync(extra, "untrusted");
    try { expect(() => verifyWindowsNodeToolchain(destination)).toThrow("could not be verified"); }
    finally { fs.unlinkSync(extra); }
  });
  it("refuses a hardlink alias", () => {
    const alias = path.join(root, "alias"); fs.linkSync(path.join(destination, "LICENSE"), alias);
    try { expect(() => verifyWindowsNodeToolchain(destination)).toThrow("could not be verified"); }
    finally { fs.unlinkSync(alias); }
  });
  it("refuses replacement of its created root during the first write", () => {
    const replaced = path.join(root, "replaced"), displaced = path.join(root, "displaced");
    const open = fs.openSync; let swapped = false;
    const hook = vi.spyOn(fs, "openSync").mockImplementation((...args) => {
      if (!swapped && String(args[0]) === path.join(replaced, "node.exe")) {
        swapped = true; fs.renameSync(replaced, displaced); fs.mkdirSync(replaced);
      }
      return open(...args);
    });
    try { expect(() => stageWindowsNodeToolchain(source!, replaced)).toThrow("could not be verified"); expect(swapped).toBe(true); }
    finally { hook.mockRestore(); }
  });
});
