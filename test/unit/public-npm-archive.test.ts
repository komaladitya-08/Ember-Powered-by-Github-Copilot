/** Authenticated tarball data is inspected without host extraction, shell execution or npm hooks. */
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { expect, it } from "vitest";
import { verifyPublicNpmArchive } from "../../app/main/agent/public-npm-archive";
import { PublicNpmPlan } from "../../app/main/agent/public-npm-lock";
import { PublicNpmBatch, publicNpmBatchData, publicNpmHttpsPort } from "../../app/main/agent/public-npm-fetch";
import { npmFixture, npmTar } from "../fixtures/coding/public-npm";

it("validates a bounded ordinary package and its exact identity without executing its code", async () => {
  const f = npmFixture(); expect(await verifyPublicNpmArchive(f.artifact, f.bytes)).toMatchObject({ entries: 2, compressedBytes: f.bytes.length });
  await expect(verifyPublicNpmArchive({ ...f.artifact, name: "different" }, f.bytes)).rejects.toThrow();
});
it.each(["../outside", "/absolute", "package/../../outside", "package/a\\b", "package/node_modules/x"])("refuses tar path %s after successful digest authentication", async path => {
  const f = npmFixture([{ path, body: "untrusted" }]); await expect(verifyPublicNpmArchive(f.artifact, f.bytes)).rejects.toThrow();
});
it.each(["1", "2", "3", "4", "6", "x", "g", "L"])("rejects nonordinary tar member type %s", async type => {
  const f = npmFixture([{ path: "package/other", type }]); await expect(verifyPublicNpmArchive(f.artifact, f.bytes)).rejects.toThrow();
});
it("refuses aliases, parent files, oversized members, setuid bits and wrong package metadata", async () => {
  for (const extra of [
    [{ path: "package/A.js", body: "a" }, { path: "package/a.js", body: "b" }],
    [{ path: "package/parent", body: "a" }, { path: "package/parent/child", body: "b" }],
    [{ path: "package/huge", size: 16 * 1024 * 1024 + 1 }],
    [{ path: "package/privileged", mode: 0o4755 }],
  ]) { const f = npmFixture(extra); await expect(verifyPublicNpmArchive(f.artifact, f.bytes)).rejects.toThrow(); }
  const f = npmFixture(), bytes = npmTar([{ path: "package/package.json", body: '{"name":"wrong","version":"1.0.0"}' }]);
  await expect(verifyPublicNpmArchive({ ...f.artifact, integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") }, bytes)).rejects.toThrow();
});
it("transfers only a live issued batch and wipes its owned public bytes on disposal", async () => {
  const f = npmFixture(), incoming = Buffer.from(f.bytes), batch = await PublicNpmBatch.download(PublicNpmPlan.create(f.inputs), {
    signal: new AbortController().signal, current: () => true, port: { read: async () => incoming } });
  expect(incoming.every(byte => byte === 0)).toBe(true); expect(batch.receipt).toMatchObject({ packages: 1, entries: 2 });
  expect(() => publicNpmBatchData(Reflect.construct(PublicNpmBatch, [batch.receipt]))).toThrow();
  const held = publicNpmBatchData(batch)[0].bytes; expect(held.equals(f.bytes)).toBe(true); batch.close();
  expect(held.every(byte => byte === 0)).toBe(true); expect(() => publicNpmBatchData(batch)).toThrow();
});
it("rejects stale completion without retaining received artifact bytes", async () => {
  const f = npmFixture(), incoming = Buffer.from(f.bytes); let live = true;
  await expect(PublicNpmBatch.download(PublicNpmPlan.create(f.inputs), { signal: new AbortController().signal, current: () => live,
    port: { read: async () => { live = false; return incoming; } } })).rejects.toThrow();
  expect(incoming.every(byte => byte === 0)).toBe(true);
});
it("the final HTTPS boundary independently rejects a forged nonregistry artifact", async () => {
  const f = npmFixture(); await expect(publicNpmHttpsPort.read({ ...f.artifact, resolved: "https://example.invalid/private" }, new AbortController().signal, () => undefined, 1000)).rejects.toThrow();
});
it("counts authenticated tar headers and zero padding in the expanded receipt and honors a smaller remaining budget", async () => {
  const f = npmFixture(), tar = Buffer.concat([gunzipSync(f.bytes), Buffer.alloc(256 * 1024)]), bytes = gzipSync(tar);
  const artifact = { ...f.artifact, integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") };
  expect(await verifyPublicNpmArchive(artifact, bytes)).toMatchObject({ expandedBytes: tar.length });
  await expect(verifyPublicNpmArchive(artifact, bytes, { maximumExpandedBytes: 128 * 1024 })).rejects.toThrow();
});
it("can cancel while scanning authenticated zero padding before returning a receipt", async () => {
  const f = npmFixture(), bytes = gzipSync(Buffer.concat([gunzipSync(f.bytes), Buffer.alloc(2 * 1024 * 1024)]));
  const artifact = { ...f.artifact, integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") };
  const abort = new AbortController(); let checks = 0;
  await expect(verifyPublicNpmArchive(artifact, bytes, { signal: abort.signal, current: () => { if (++checks === 6) abort.abort(); } })).rejects.toThrow();
  expect(checks).toBe(6);
});
it("enforces the original aggregate 128MiB inflation budget across many small authenticated compressed archives", async () => {
  const packages: Record<string, Record<string, unknown>> = { "": { name: "aggregate-proof", version: "1.0.0" } }, archives = new Map<string, Buffer>();
  for (let i = 0; i < 8; i++) {
    const name = `aggregate-fixture-${i}`, version = "1.0.0";
    const body = npmTar([{ path: "package/package.json", body: JSON.stringify({ name, version }) }]);
    const bytes = gzipSync(Buffer.concat([gunzipSync(body), Buffer.alloc(17 * 1024 * 1024)])); archives.set(name, bytes);
    packages[`node_modules/${name}`] = { name, version, resolved: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`, integrity: "sha512-" + createHash("sha512").update(bytes).digest("base64") };
  }
  const plan = PublicNpmPlan.create({ packageJson: Buffer.from('{"name":"aggregate-proof","version":"1.0.0"}'), packageLock: Buffer.from(JSON.stringify({ lockfileVersion: 3, packages })) });
  let reads = 0;
  await expect(PublicNpmBatch.download(plan, { signal: new AbortController().signal, current: () => true,
    port: { read: async artifact => { reads++; return Buffer.from(archives.get(artifact.name)!); } } })).rejects.toThrow();
  expect(reads).toBe(8);
}, 30_000);
