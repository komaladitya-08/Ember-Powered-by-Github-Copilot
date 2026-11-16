import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it } from "vitest";
// @ts-expect-error -- host-only JavaScript source authority is outside the application TypeScript build
import { sourcePin, applyWindowsUvSpawnPatch, prepareWindowsUvSpawnSource, validateWindowsUvSpawnSource } from "../../scripts/experimental/windows-uv-spawn-source.mjs";

const directories: string[] = [];
const temp = () => { const directory = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), "ember-uv-spawn-unit-")); directories.push(directory); return directory; };
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });
const hash = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const execution = () => ({ pythonPath: path.resolve(temp(), "never-execute"), executionEnv: { PATH: "" }, cwd: temp() });

it("binds the signed source catalog and only the Winsock guard plus exact upstream LOCAL patch", () => {
  expect(sourcePin.issuer).toBe("ember-experimental-windows-uv-spawn-fixed-probe");
  expect(sourcePin.inventory).toEqual({ files: 155, directories: 9, stockBytes: 2_277_779, workingBytes: 2_278_938 });
  expect(sourcePin.sourceArchive).toMatchObject({ bytes: 50_529_596, sha256: "6cce7c58bf058700c643944903d60a325e8c9ceede1f5c2c088b435f2ada091a" });
  expect(sourcePin.provenance).toMatchObject({ manifestSignatureVerified: true, tagSignatureVerified: true, signingFingerprint: "5BE8A3F6C8A5C01D106C0AD820B1A390B168D356", commit: "60553651579ec33ca1aef9e1eedab2c3855f1f7e" });
  expect(sourcePin.patches.map((item: { file: string }) => item.file)).toEqual(["src/win/core.c", "src/win/pipe.c"]);
  expect(sourcePin.patches[1]).toMatchObject({ upstreamCommit: "2cadaa40167050baf7c6905ac897e6fb57afb2c6", afterSha256: "0739cb731a3e21eb23a7ee69ba2f1251542f34a06838cd115aa69e4a4bcc7b54" });
  expect(JSON.stringify(sourcePin.patches)).not.toMatch(/CNG|CryptGenRandom|BCryptGenRandom|registryRead|SafeMode/);
  expect(Object.isFrozen(sourcePin)).toBe(true); expect(sourcePin.files.every(Object.isFrozen)).toBe(true);
  type Entry = { path: string; bytes: number; sha256: string };
  const stock = sourcePin.files as Entry[];
  const working = stock.map(file => { const patch = sourcePin.patches.find((item: { file: string }) => item.file === file.path); return patch ? { ...file, bytes: patch.afterBytes, sha256: patch.afterSha256 } : file; });
  const manifest = (files: Entry[]) => hash(files.map(file => `${file.sha256} ${file.bytes} ${file.path}\n`).join(""));
  expect(manifest(stock)).toBe(sourcePin.stockManifestSha256);
  expect(manifest(working)).toBe("2539fd38c07e40601381fd3d8c72410893812a6aa6da7ce1a9b885c617423fb8");
});

it.each(["src/win/core.c", "src/win/pipe.c", "caller.c"])("refuses truncated, similar and foreign patch input for %s", file => {
  const patch = sourcePin.patches.find((item: { file: string }) => item.file === file);
  for (const bytes of [Buffer.alloc(0), Buffer.from(patch?.needle ?? "caller patch"), Buffer.alloc(patch?.beforeBytes ?? 100)]) {
    expect(() => applyWindowsUvSpawnPatch(file, bytes)).toThrow("signed archive and exact catalog contract");
  }
});

it("refuses an archive before extraction or destination creation when size or full SHA differs", async () => {
  for (const exactSize of [false, true]) {
    const root = temp(), archivePath = path.join(root, "archive.xz"), destination = path.join(root, "source");
    const fd = fs.openSync(archivePath, "wx"); fs.ftruncateSync(fd, exactSize ? sourcePin.sourceArchive.bytes : 9); fs.closeSync(fd);
    await expect(prepareWindowsUvSpawnSource({ archivePath, destination, ...execution() })).rejects.toThrow("signed archive and exact catalog contract");
    expect(fs.existsSync(destination)).toBe(false);
  }
});

it("requires an explicit absolute trusted interpreter and clean environment from its caller", async () => {
  const root = temp(), archivePath = path.join(root, "archive.xz"), destination = path.join(root, "source");
  fs.writeFileSync(archivePath, "bad");
  for (const options of [{ pythonPath: "python", executionEnv: {}, cwd: root }, { pythonPath: path.join(root, "python"), cwd: root },
    { pythonPath: path.join(root, "python"), executionEnv: {}, cwd: "relative" }]) {
    await expect(prepareWindowsUvSpawnSource({ archivePath, destination, ...options })).rejects.toThrow("signed archive and exact catalog contract");
    expect(fs.existsSync(destination)).toBe(false);
  }
});

it("rejects forged receipts, incomplete inventories and root aliases", async () => {
  const root = temp(), tree = path.join(root, "stock"), alias = path.join(root, "alias"); fs.mkdirSync(tree);
  fs.writeFileSync(path.join(tree, "source-receipt.json"), JSON.stringify({ manifestSha256: sourcePin.stockManifestSha256 }));
  await expect(validateWindowsUvSpawnSource(tree, "stock")).rejects.toThrow("signed archive and exact catalog contract");
  await expect(validateWindowsUvSpawnSource(tree, "foreign")).rejects.toThrow("signed archive and exact catalog contract");
  fs.symlinkSync(tree, alias, "junction");
  await expect(validateWindowsUvSpawnSource(alias, "stock")).rejects.toThrow("signed archive and exact catalog contract");
  expect(fs.readFileSync(path.join(tree, "source-receipt.json"), "utf8")).toContain(sourcePin.stockManifestSha256);
});
