import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

const repository = fs.realpathSync.native(fileURLToPath(new URL("../../", import.meta.url))), expected = { image: "windows-2022", commit: "a".repeat(40) };
const scratch: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const directory of scratch.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
async function load() { vi.resetModules(); return import("../fixtures/windows-node-asset-enforcement-run"); }
async function clone() {
  const run = await load(), root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-node-asset-run-contract-")); scratch.push(root);
  for (const pin of run.WINDOWS_NODE_ASSET_ENFORCEMENT_SOURCE_PINS) { const file = path.join(root, pin.path); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(path.join(repository, pin.path), file); }
  return { run, root };
}
function clocks(fault = "") {
  const lstat = fs.lstatSync, fstat = fs.fstatSync, paths = new Map<string, number>(), descriptors = new Map<number, number>();
  const information = (value: fs.BigIntStats, held: boolean, count: number) => {
    const changed = count > 1 && fault.startsWith(held ? "fd" : "path");
    return Object.assign(Object.create(value) as fs.BigIntStats, {
      mtimeNs: (held ? 200n : 100n) + (changed && fault.endsWith("mtime") ? 1n : 0n),
      ctimeNs: (held ? 400n : 300n) + (changed && fault.endsWith("ctime") ? 1n : 0n),
    });
  };
  vi.spyOn(fs, "lstatSync").mockImplementation(((file: fs.PathLike, options?: fs.StatSyncOptions) => {
    if (options?.bigint !== true) return lstat(file, options);
    const key = String(file), count = (paths.get(key) ?? 0) + 1; paths.set(key, count); return information(lstat(file, { bigint: true }), false, count);
  }) as typeof fs.lstatSync);
  return vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number, options?: fs.StatOptions) => {
    if (options?.bigint !== true) return fstat(fd, options);
    const count = (descriptors.get(fd) ?? 0) + 1; descriptors.set(fd, count); return information(fstat(fd, { bigint: true }), true, count);
  }) as typeof fs.fstatSync);
}
it("requires its own issuer and exact fixed producer, production graph and acquisition/build recipes", async () => {
  const run = await load(), facts = run.verifyWindowsNodeAssetEnforcementRun(repository, expected), paths = run.WINDOWS_NODE_ASSET_ENFORCEMENT_SOURCE_PINS.map(pin => pin.path);
  expect(facts).toMatchObject({ issuer: "ember-windows-node-asset-enforcement-run-v1", compiledIssuer: "ember-windows-node-asset-enforcement-build-v1", image: 2022,
    compileCommit: expected.commit, producerRun: 43858256344, producerArtifact: 14224884648, producerZipBytes: 38424638 });
  expect(facts.sourceManifestSha256).toMatch(/^[a-f0-9]{64}$/); expect(facts.cases).toEqual(["natural", "natural-default", "overflow", "cancel", "precreate", "preresume", "sharedcreate"]);
  expect(paths.length).toBeGreaterThanOrEqual(80); expect(new Set(paths).size).toBe(paths.length);
  for (const file of ["app/main/agent/windows-node-toolchain-native.ts", "app/main/agent/windows-command-launch-cancel.ts", "app/main/agent/windows-command-copy.ts", "app/main/agent/windows-command-stop.ts",
    "app/main/agent/windows-command-output.ts", "app/main/agent/windows-command-creator-profile.ts", "app/shared/windows-node-toolchain.json", "scripts/package/windows-node-toolchain.mjs",
    "scripts/package/windows-node-toolchain.d.mts", "test/fixtures/windows-node-asset-enforcement.c", "test/fixtures/windows-node-asset-enforcement-program.cjs", "test/fixtures/windows-node-asset-enforcement-native.ts",
    "test/fixtures/windows-node-asset-enforcement-proof.ts", "scripts/experimental/build-windows-node-asset-enforcement.mjs", ".github/workflows/experimental-windows-node-asset-enforcement.yml"])
    expect(paths).toContain(file);
  expect(paths.some(file => file.includes("node_modules") || file.startsWith("/"))).toBe(false);
});
it.each(["app/main/agent/windows-node-toolchain-native.ts", "app/main/agent/windows-command-launch-cancel.ts", "test/fixtures/windows-node-asset-enforcement.c",
  "test/fixtures/windows-node-asset-enforcement-program.cjs", "test/fixtures/windows-node-asset-enforcement-proof.ts", "scripts/package/windows-node-toolchain.mjs",
  ".github/workflows/experimental-windows-node-asset-enforcement.yml"])("changed %s permanently refuses before a native entry", async file => {
  const { run, root } = await clone(), selected = path.join(root, file), original = fs.readFileSync(selected); fs.appendFileSync(selected, "\nchanged\n");
  let first: unknown; try { run.verifyWindowsNodeAssetEnforcementRun(root, expected); } catch (error) { first = error; }
  expect(first).toBeInstanceOf(Error); expect(String(first)).not.toContain(root); fs.writeFileSync(selected, original);
  expect(() => run.verifyWindowsNodeAssetEnforcementRun(root, expected)).toThrow(first as Error);
});
it.each([{ image: "windows-2025", commit: "bad" }, { image: "windows-2028", commit: expected.commit }, { image: undefined, commit: expected.commit }])("foreign hosted identity %# permanently refuses", async identity => {
  const run = await load(); expect(() => run.verifyWindowsNodeAssetEnforcementRun(repository, identity)).toThrow(); expect(() => run.verifyWindowsNodeAssetEnforcementRun(repository, expected)).toThrow();
});
it("a consumed descriptor close failure is retained, never retried, and blocks all later reads", async () => {
  const run = await load(), close = fs.closeSync, read = vi.spyOn(fs, "readSync"), calls: number[] = [];
  const closing = vi.spyOn(fs, "closeSync").mockImplementation(fd => { calls.push(fd); close(fd); throw Error("PRIVATE unknown close"); });
  let first: unknown; try { run.verifyWindowsNodeAssetEnforcementRun(repository, expected); } catch (error) { first = error; }
  expect(first).toBeInstanceOf(Error); expect(String(first)).not.toContain("PRIVATE"); expect(calls).toHaveLength(1);
  const reads = read.mock.calls.length; closing.mockRestore(); expect(() => run.verifyWindowsNodeAssetEnforcementRun(repository, expected)).toThrow(first as Error);
  expect(read).toHaveBeenCalledTimes(reads); expect(calls).toHaveLength(1);
});
it("accepts stable different pathname/descriptor clocks while preserving the exact source bytes and identities", async () => {
  const run = await load(), held = clocks(); expect(run.verifyWindowsNodeAssetEnforcementRun(repository, expected).compileCommit).toBe(expected.commit);
  expect(held).toHaveBeenCalledTimes(run.WINDOWS_NODE_ASSET_ENFORCEMENT_SOURCE_PINS.length * 2);
});
it.each(["path mtime", "path ctime", "fd mtime", "fd ctime"])("rejects a %s change within its own API and permanently refuses later reads", async fault => {
  const run = await load(); clocks(fault); const read = vi.spyOn(fs, "readSync"); let first: unknown;
  try { run.verifyWindowsNodeAssetEnforcementRun(repository, expected); } catch (error) { first = error; }
  expect(first).toBeInstanceOf(Error); const reads = read.mock.calls.length;
  expect(() => run.verifyWindowsNodeAssetEnforcementRun(repository, expected)).toThrow(first as Error); expect(read).toHaveBeenCalledTimes(reads);
});
it("workflow registration cannot start native cases or replace the fixed authenticated producer", () => {
  const workflow = fs.readFileSync(path.join(repository, ".github/workflows/experimental-windows-node-asset-enforcement.yml"), "utf8");
  expect(workflow).toContain("if: github.event_name == 'workflow_dispatch' && github.ref_name == 'ember-improve/20261116-node-asset-enforcement'");
  expect(workflow).toContain("cancel-in-progress: false"); expect(workflow).toContain("image: [windows-2022, windows-2025]");
  expect(workflow).toContain("actions/artifacts/14224884648/zip"); expect(workflow).toContain("source.stat().st_size != 38424638");
  expect(workflow).toContain("97d34d7260474d71699f6ebca3a5b4a88e1d3663aa4a817a9f02c43a4ff29234");
  expect(workflow).toContain("len(entries) != 4"); expect(workflow).toContain("entry.file_size != pin['bytes']"); expect(workflow).toContain("hashlib.sha256(body).hexdigest() != pin['sha256']");
  expect(workflow).not.toMatch(/upload-artifact|continue-on-error|pull_request_target|nodejs\.org/);
});
