import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { copyIsolatedCommandAssets, inspectIsolatedCommandElf } from "../../app/main/agent/isolated-command-assets";
import { trustedCodingTestNodeOrSkip } from "../fixtures/coding/trusted-node";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-command-assets-")); roots.push(root);
  const rootfs = path.join(root, "rootfs"), privateDir = path.join(root, "private"), work = path.join(root, "work");
  for (const dir of [rootfs, privateDir, work]) fs.mkdirSync(dir, { mode: 0o700 });
  return { root, rootfs, privateDir, work };
}

function elf(tags: readonly [bigint, bigint][] = [[0n, 0n]]) {
  const data = Buffer.alloc(512);
  Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]).copy(data);
  data.writeUInt16LE(3, 16); data.writeUInt16LE(62, 18); data.writeBigUInt64LE(64n, 32);
  data.writeUInt16LE(64, 52); data.writeUInt16LE(56, 54); data.writeUInt16LE(2, 56);
  data.writeUInt32LE(1, 64); data.writeBigUInt64LE(0n, 72); data.writeBigUInt64LE(0x1000n, 80); data.writeBigUInt64LE(512n, 96);
  data.writeUInt32LE(2, 120); data.writeBigUInt64LE(176n, 128); data.writeBigUInt64LE(BigInt(tags.length * 16), 152);
  tags.forEach(([tag, value], i) => { data.writeBigInt64LE(tag, 176 + i * 16); data.writeBigUInt64LE(value, 184 + i * 16); });
  return data;
}

describe("bounded ELF dependency inspection", () => {
  it("parses explicit dependencies without running a program", async () => {
    const bytes = elf([[5n, 0x1180n], [10n, 32n], [1n, 1n], [0n, 0n]]);
    bytes.write("\0libc.so.6\0", 384, "ascii");
    expect(await inspectIsolatedCommandElf(bytes)).toEqual({ interpreter: null, needed: ["libc.so.6"] });
  });

  it("rejects malformed ELFs, unsafe dependency names, custom loader paths and unbounded offsets", async () => {
    for (const value of [Buffer.from("#!/bin/sh\necho bad"), Buffer.alloc(64), elf([[15n, 0n], [0n, 0n]]), elf([[29n, 0n], [0n, 0n]]), elf([[5n, 0xffffn], [10n, 32n], [1n, 1n], [0n, 0n]])]) {
      await expect(inspectIsolatedCommandElf(value)).rejects.toThrow("unsupported");
    }
    const bad = elf([[5n, 0x1180n], [10n, 32n], [1n, 1n], [0n, 0n]]);
    bad.write("\0../unsafe.so\0", 384);
    await expect(inspectIsolatedCommandElf(bad)).rejects.toThrow("unsupported");
    const otherArch = elf(); otherArch.writeUInt16LE(183, 18);
    await expect(inspectIsolatedCommandElf(otherArch)).rejects.toThrow("unsupported");
    const hugeHeaders = elf(); hugeHeaders.writeUInt16LE(65535, 56);
    await expect(inspectIsolatedCommandElf(hugeHeaders)).rejects.toThrow("unsupported");
  });
});

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")("copied isolated command assets", () => {
  it("copies fixed binaries and their libraries as new inodes without exposing host directories", async () => {
    const f = fixture();
    const result = await copyIsolatedCommandAssets({ rootfs: f.rootfs, protectedPaths: [f.privateDir] });
    expect(result.node).toBe(false); expect(result.files).toBeGreaterThan(3); expect(result.bytes).toBeGreaterThan(0);
    const copied = path.join(f.rootfs, "usr/bin/bash");
    expect(fs.statSync(copied).ino).not.toBe(fs.statSync("/usr/bin/bash").ino);
    expect(fs.lstatSync(path.join(f.rootfs, "lib64/ld-linux-x86-64.so.2")).isSymbolicLink()).toBe(false);
    expect(fs.existsSync(path.join(f.rootfs, "etc"))).toBe(false);
    expect(fs.existsSync(path.join(f.rootfs, "usr/bin/node"))).toBe(false);
  });

  it("rejects protected or unverifiable Node selections, non-empty roots and a stopped setup", async () => {
    const f = fixture();
    const fake = path.join(f.privateDir, "node"); fs.writeFileSync(fake, "not a trusted node");
    await expect(copyIsolatedCommandAssets({ rootfs: f.rootfs, protectedPaths: [f.privateDir], nodePath: fake })).rejects.toThrow("protected");
    // A failed setup can leave only copies in its disposable root; it never modifies the selected asset.
    expect(fs.readFileSync(fake, "utf8")).toBe("not a trusted node");
    await expect(copyIsolatedCommandAssets({ rootfs: f.rootfs, protectedPaths: [f.privateDir] })).rejects.toThrow("empty");
    const g = fixture(), stop = new AbortController(); stop.abort();
    await expect(copyIsolatedCommandAssets({ rootfs: g.rootfs, protectedPaths: [g.privateDir], signal: stop.signal })).rejects.toThrow();
  });

  it("runs an explicitly selected copied Node with copied libraries and no host environment", async ctx => {
    const asset = await trustedCodingTestNodeOrSkip(ctx);
    const f = fixture();
    const nodePath = asset.nodePath;
    const result = await copyIsolatedCommandAssets({ rootfs: f.rootfs, protectedPaths: [f.privateDir], nodePath });
    expect(result.node).toBe(true);
    for (const name of ["dev", "work", "tmp"]) fs.mkdirSync(path.join(f.rootfs, name));
    const canary = path.join(f.privateDir, "host.txt"); fs.writeFileSync(canary, "HOST_ONLY_CANARY");
    const script = `const fs=require('fs');fs.writeFileSync('/work/result.json',JSON.stringify({version:process.version,host:fs.existsSync(${JSON.stringify(canary)}),env:process.env.EMBER_ASSET_CANARY??null}));`;
    const run = spawnSync("/usr/bin/bwrap", ["--unshare-user", "--unshare-pid", "--unshare-net", "--clearenv", "--setenv", "PATH", "/usr/bin", "--ro-bind", f.rootfs, "/", "--dev", "/dev", "--tmpfs", "/tmp", "--bind", f.work, "/work", "--", "/usr/bin/node", "-e", script], {
      encoding: "utf8", timeout: 15_000, env: { ...process.env, EMBER_ASSET_CANARY: "must-not-inherit" },
    });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(f.work, "result.json"), "utf8"))).toEqual({ version: asset.version, host: false, env: null });
  }, 30_000);
});
