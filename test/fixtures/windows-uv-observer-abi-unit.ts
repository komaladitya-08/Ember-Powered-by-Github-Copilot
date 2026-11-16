import { createHash } from "node:crypto";
// @ts-expect-error -- exact original trusted-producer schema and source authority, no Windows build is invoked
import { buildPin, sourcePin, windowsUvSpawnRecipe } from "../../scripts/experimental/build-windows-uv-spawn-probe.mjs";
// @ts-expect-error -- separate portable build schema only
import { windowsUvObserverAbiRecipe, abiPin } from "../../scripts/experimental/build-windows-uv-observer-abi.mjs";
// @ts-expect-error -- portable image parser only
import { inspectWindowsUvObserverAbiImage } from "../../scripts/experimental/windows-uv-observer-abi-image.mjs";

export const abiUnitCommit = "b".repeat(40);
export const abiUnitHash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
export const abiUnitFingerprint = (bytes = 4) => ({ bytes, sha256: "a".repeat(64) });
export function abiUnitReport() {
  const values = [0x31494241, 1, 1, 0, 96, 96, 96, 96, 127, 0, 0, 0, 0, 0, 0, 0];
  for (let index = 0; index < 6; index++) values.push(index + 1, 16, 16, 32, 32, 32, 32, 8);
  const bytes = Buffer.alloc(256); values.forEach((value, index) => bytes.writeUInt32LE(value, index * 4)); return bytes;
}
export function abiUnitObject() {
  const bytes = Buffer.alloc(128); bytes.writeUInt16LE(0x8664); bytes.writeUInt16LE(1, 2); bytes.writeUInt32LE(104, 8); bytes.writeUInt32LE(1, 12);
  bytes.write(".text", 20); bytes.writeUInt32LE(16, 36); bytes.writeUInt32LE(60, 40); bytes.writeUInt32LE(0x60000020, 56); bytes.fill(0x90, 60, 76); bytes.writeUInt32LE(4, 122); return bytes;
}
export function abiUnitImage(name = "GetLastError", dll = "KERNEL32.dll") {
  const bytes = Buffer.alloc(2048); bytes.write("MZ"); bytes.writeUInt32LE(0x80, 0x3c); bytes.writeUInt32LE(0x4550, 0x80);
  bytes.writeUInt16LE(0x8664, 0x84); bytes.writeUInt16LE(1, 0x86); bytes.writeUInt16LE(240, 0x94); bytes.writeUInt16LE(2, 0x96);
  const optional = 0x98; bytes.writeUInt16LE(0x20b, optional); bytes.writeUInt32LE(0x1000, optional + 16); bytes.writeUInt32LE(0x3000, optional + 56);
  bytes.writeUInt32LE(512, optional + 60); bytes.writeUInt16LE(3, optional + 68); bytes.writeUInt32LE(16, optional + 108);
  bytes.writeUInt32LE(0x1100, optional + 120); bytes.writeUInt32LE(40, optional + 124);
  const section = optional + 240; bytes.writeUInt32LE(1536, section + 8); bytes.writeUInt32LE(0x1000, section + 12); bytes.writeUInt32LE(1536, section + 16);
  bytes.writeUInt32LE(512, section + 20); bytes.writeUInt32LE(0x60000020, section + 36);
  bytes.writeUInt32LE(0x11c0, 0x300); bytes.writeUInt32LE(0x1180, 0x30c); bytes.writeUInt32LE(0x11e0, 0x310);
  bytes.write(dll + "\0", 0x380); bytes.writeBigUInt64LE(0x1200n, 0x3c0); bytes.writeBigUInt64LE(0x1200n, 0x3e0); bytes.write(name + "\0", 0x402);
  return bytes;
}
export function abiUnitReceipts() {
  const object = abiUnitObject(), observerObject = { bytes: object.length, sha256: abiUnitHash(object) };
  const source = { schema: 1, issuer: sourcePin.issuer, sourceVersion: sourcePin.version, sourceArchiveSha256: sourcePin.sourceArchive.sha256,
    sourceCommit: sourcePin.provenance.commit, commit: abiUnitCommit, source: { stockManifestSha256: sourcePin.stockManifestSha256, workingManifestSha256: sourcePin.workingManifestSha256,
      ...sourcePin.inventory, patches: sourcePin.patches.map(({ file, beforeSha256, afterSha256, kind }: Record<string, unknown>) => ({ file, beforeSha256, afterSha256, kind })) },
    build: { ...buildPin, visualStudioVersion: "17.14.37906.3", compilerVersion: "19.44.35230.0", linkerVersion: "14.44.35230.0", msbuildVersion: "17.14.60.43110", pythonVersion: "3.12.10", cmakeVersion: "3.31.6",
      generatedProjects: ["uv_a", "ember_uv_spawn_probe"].map(target => ({ target, ...abiUnitFingerprint(), targetMacro: "0x0602", releaseDefinitionCount: 1 })),
      observerListing: { ...abiUnitFingerprint(), review: "not-reviewed" }, observerObject,
      observerEmission: { name: "observer-emission.json", ...abiUnitFingerprint(), schema: 2, review: "not-reviewed", status: "refused" } },
    tools: Object.fromEntries(["compiler", "linker", "msbuild", "vcvars", "vswhere", "python", "cmake"].map(key => [key, abiUnitFingerprint()])),
    recipe: windowsUvSpawnRecipe(), assets: { probe: { name: "uv-spawn-probe.exe", ...abiUnitFingerprint(1024) } } };
  const sourceBytes = Buffer.from(JSON.stringify(source)), image = abiUnitImage(), license = Buffer.from("fixed public license");
  const receipt = { schema: 1, issuer: abiPin.issuer, commit: abiUnitCommit, baseRecipeSha256: abiPin.baseRecipeSha256,
    sourceReceipt: { name: "source-build-receipt.json", bytes: sourceBytes.length, sha256: abiUnitHash(sourceBytes) }, observerObject,
    recipe: windowsUvObserverAbiRecipe(), tools: source.tools, project: { ...abiUnitFingerprint(), targetMacro: "0x0602", runtimeLibrary: "MultiThreaded", externalObjects: 1 },
    assets: { control: { name: "observer-abi-control.exe", ...inspectWindowsUvObserverAbiImage(image) }, license: { name: "LICENSE", bytes: license.length, sha256: abiUnitHash(license) } } };
  return { source, sourceBytes, receipt, receiptBytes: Buffer.from(JSON.stringify(receipt)), object, image, license };
}
