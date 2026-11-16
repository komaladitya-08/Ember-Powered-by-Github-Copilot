import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

const repository = fs.realpathSync.native(fileURLToPath(new URL("../../", import.meta.url))), expected = { image: "windows-2022", commit: "a".repeat(40) };
const scratch: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const folder of scratch.splice(0)) fs.rmSync(folder, { recursive: true, force: true }); });
async function load() { vi.resetModules(); return import("../fixtures/windows-command-output-run"); }
async function clone() {
  const run = await load(), root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-output-run-contract-")); scratch.push(root);
  for (const pin of run.WINDOWS_COMMAND_OUTPUT_SOURCE_PINS) { const file = path.join(root, pin.path); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.copyFileSync(path.join(repository, pin.path), file); }
  return { run, root };
}
it("binds the new exact C/output run issuer and every captured runtime/source recipe", async () => {
  const run = await load(), facts = run.verifyWindowsCommandOutputRun(repository, expected), paths = run.WINDOWS_COMMAND_OUTPUT_SOURCE_PINS.map(pin => pin.path);
  expect(facts).toMatchObject({ issuer: "ember-root-only-output-run-v1", compiledIssuer: "ember-root-only-output-observed-build-v1", image: 2022, compileCommit: expected.commit });
  expect(facts.cases).toEqual(["natural", "overflow", "cancel"]); expect(facts.sourceManifestSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(paths.length).toBeGreaterThanOrEqual(80); expect(new Set(paths).size).toBe(paths.length);
  for (const file of ["app/main/agent/windows-command-output.ts", "app/main/agent/windows-command-exit-native.ts", "app/main/agent/windows-command-copy-native.ts",
    "app/main/agent/windows-command-creator-profile.ts", "app/main/agent/windows-command-creator-token.ts", "test/fixtures/windows-command-output-proof.c",
    "test/fixtures/windows-command-output-proof.ts", "scripts/experimental/build-windows-command-output-proof.mjs", ".github/workflows/experimental-windows-command-output.yml"])
    expect(paths).toContain(file);
  expect(paths.some(file => file.includes("node_modules") || file.startsWith("/"))).toBe(false);
});
it.each(["app/main/agent/windows-command-output.ts", "test/fixtures/windows-command-output-proof.c", "test/fixtures/windows-command-output-proof.ts",
  "scripts/experimental/build-windows-command-output-proof.mjs", ".github/workflows/experimental-windows-command-output.yml"])("changed %s refuses before any native proof can start and cannot be restored into a retry", async file => {
  const { run, root } = await clone(), selected = path.join(root, file), original = fs.readFileSync(selected); fs.appendFileSync(selected, "\nchanged\n");
  let first: unknown; try { run.verifyWindowsCommandOutputRun(root, expected); } catch (error) { first = error; }
  expect(first).toBeInstanceOf(Error); expect(String(first)).not.toContain(root); fs.writeFileSync(selected, original);
  expect(() => run.verifyWindowsCommandOutputRun(root, expected)).toThrow(first as Error);
});
it.each([{ image: "windows-2025", commit: "bad" }, { image: "windows-2028", commit: expected.commit }, { image: undefined, commit: expected.commit }])("foreign hosted identity %# is a permanent refusal", async identity => {
  const run = await load(); expect(() => run.verifyWindowsCommandOutputRun(repository, identity)).toThrow();
  expect(() => run.verifyWindowsCommandOutputRun(repository, expected)).toThrow();
});
it("a descriptor close that consumed its handle and threw is never retried, and no later verification reads", async () => {
  const run = await load(), close = fs.closeSync, read = vi.spyOn(fs, "readSync"), calls: number[] = [];
  const closing = vi.spyOn(fs, "closeSync").mockImplementation(fd => { calls.push(fd); close(fd); throw Error("PRIVATE unknown close"); });
  let first: unknown; try { run.verifyWindowsCommandOutputRun(repository, expected); } catch (error) { first = error; }
  expect(first).toBeInstanceOf(Error); expect(String(first)).not.toContain("PRIVATE"); expect(calls).toHaveLength(1);
  const readCount = read.mock.calls.length; closing.mockRestore();
  expect(() => run.verifyWindowsCommandOutputRun(repository, expected)).toThrow(first as Error); expect(read).toHaveBeenCalledTimes(readCount); expect(calls).toHaveLength(1);
});
