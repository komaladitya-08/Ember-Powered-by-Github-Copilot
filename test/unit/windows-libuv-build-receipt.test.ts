import { expect, it } from "vitest";
import { parseWindowsLibuvBuildReceipt } from "../fixtures/windows-libuv-probe";
import sourcePin from "../../scripts/experimental/windows-libuv-source-pin.json";
import buildPin from "../../scripts/experimental/windows-libuv-build-pin.json";
// @ts-expect-error -- fixed trusted-host JavaScript build recipe
import { windowsLibuvRecipe } from "../../scripts/experimental/build-windows-libuv-probe.mjs";

const commit = "a".repeat(40), sha256 = "b".repeat(64);
function receipt() {
  const stockBytes = sourcePin.files.reduce((sum, file) => sum + file.bytes, 0);
  return { schema: 1, issuer: "ember-experimental-libuv-fixed-probe", sourceVersion: "22.23.5", sourceArchiveSha256: sourcePin.sourceArchive.sha256,
    sourceCommit: sourcePin.provenance.commit, source: { stockManifestSha256: sourcePin.stockManifestSha256, offlineManifestSha256: sourcePin.offlineManifestSha256,
      files: sourcePin.files.length, stockBytes, offlineBytes: stockBytes - sourcePin.patch.beforeBytes + sourcePin.patch.afterBytes,
      patchBeforeSha256: sourcePin.patch.beforeSha256, patchAfterSha256: sourcePin.patch.afterSha256 },
    build: { ...buildPin, compilerVersion: "19.44.35211.0" }, tools: { cmake: { bytes: 10, sha256 }, compiler: { bytes: 10, sha256 }, linker: { bytes: 10, sha256 } },
    recipe: windowsLibuvRecipe(), commit, assets: { stock: { name: "stock-probe.exe", bytes: 100, sha256 }, offline: { name: "offline-probe.exe", bytes: 100, sha256 } } };
}
const parse = (value: unknown) => parseWindowsLibuvBuildReceipt(Buffer.from(JSON.stringify(value)), commit);

it("requires a distinct exact-source/patch/compiler recipe issuer rather than official Node authority", () => {
  const value = receipt(), result = parse(value);
  expect(result.issuer).toBe("ember-experimental-libuv-fixed-probe"); expect(result.sourceCommit).toBe(sourcePin.provenance.commit);
  expect(result.assets.offline.name).toBe("offline-probe.exe"); expect(result.recipe).toEqual(windowsLibuvRecipe());
});

it.each(["issuer", "sourceVersion", "sourceArchiveSha256", "sourceCommit", "commit"])("refuses changed provenance field %s without exposing rejected data", field => {
  const value = { ...receipt(), [field]: "private-path-and-message" };
  expect(() => parse(value)).toThrow("exact source, recipe or issuer contract");
});

it.each(["stockManifestSha256", "offlineManifestSha256", "patchBeforeSha256", "patchAfterSha256", "files", "stockBytes", "offlineBytes"])("binds every source/patch content witness: %s", field => {
  const value = receipt(); Object.assign(value.source, { [field]: 0 });
  expect(() => parse(value)).toThrow();
});

it("refuses omitted, unknown, reordered or altered recipe inputs", () => {
  for (const mutate of [
    (value: ReturnType<typeof receipt>) => { value.recipe.pop(); },
    (value: ReturnType<typeof receipt>) => { value.recipe.reverse(); },
    (value: ReturnType<typeof receipt>) => { value.recipe[0].file = "C:\\private\\recipe.mjs"; },
    (value: ReturnType<typeof receipt>) => { value.recipe[0].sha256 = "c".repeat(64); },
  ]) { const value = receipt(); mutate(value); expect(() => parse(value)).toThrow(); }
});

it.each(["generator", "toolset", "sdk", "cmakeVersion", "runtimeLibrary", "compilerVersion"])("refuses an alternative compiler/build option: %s", field => {
  const value = receipt(); Object.assign(value.build, { [field]: "private-or-alternative" });
  expect(() => parse(value)).toThrow();
});

it("refuses unknown manifest fields, arbitrary asset paths, oversized executables and malformed compiler fingerprints", () => {
  const cases = [
    { ...receipt(), private: "private" },
    { ...receipt(), assets: { stock: { name: "C:\\private\\node.exe", bytes: 100, sha256 }, offline: receipt().assets.offline } },
    { ...receipt(), assets: { stock: { name: "stock-probe.exe", bytes: 16 * 1024 * 1024 + 1, sha256 }, offline: receipt().assets.offline } },
    { ...receipt(), tools: { ...receipt().tools, compiler: { bytes: 1, sha256: "private" } } },
  ];
  for (const value of cases) expect(() => parse(value)).toThrow("exact source, recipe or issuer contract");
});

it("bounds the manifest before decoding and refuses malformed input with a fixed error", () => {
  for (const bytes of [Buffer.alloc(0), Buffer.alloc(16 * 1024 + 1), Buffer.from("private-json")]) {
    expect(() => parseWindowsLibuvBuildReceipt(bytes, commit)).toThrow("exact source, recipe or issuer contract");
  }
  expect(() => parseWindowsLibuvBuildReceipt(Buffer.from(JSON.stringify(receipt())), "private-commit")).toThrow();
});
