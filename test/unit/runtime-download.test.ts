import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadShipped, partsArchive, planShipped, shippedCandidates } from "../../app/main/remote/parts-cache";
import { cachedOk, ensureRuntime, RuntimeError, RuntimeManifestSchema, runtimeUrl, type RuntimeFs, type RuntimeManifest } from "../../app/main/remote/runtime-download";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const BODY = Buffer.alloc(300_000, 3);
const manifest = (over: Partial<RuntimeManifest> = {}): RuntimeManifest => RuntimeManifestSchema.parse({
  minimum: "24.8.0", pinned: "24.11.1",
  targets: { "linux-x64": { xz: { file: "node-v24.11.1-linux-x64.tar.xz", sha256: sha(BODY), bytes: BODY.length } } },
  ...over,
});

const fs: RuntimeFs = {
  stat: p => fsp.stat(p),
  open: async p => { const h = await fsp.open(p, "w"); return { write: b => h.write(b), close: () => h.close() }; },
  createReadStream: p => createReadStream(p),
  rename: (a, b) => fsp.rename(a, b),
  rm: (p, o) => fsp.rm(p, o),
  mkdir: (p, o) => fsp.mkdir(p, o),
};

/** A fetch answer whose body yields `bytes` in pieces. */
const answer = (bytes: Buffer, status = 200) => ({
  ok: status === 200, status,
  body: new ReadableStream<Uint8Array>({
    start(c) { for (let i = 0; i < bytes.length; i += 65_536) c.enqueue(new Uint8Array(bytes.subarray(i, i + 65_536))); c.close(); },
  }),
});

let dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(path.join(os.tmpdir(), "ember-rt-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

const run = (dir: string, fetch: (url: string) => Promise<ReturnType<typeof answer>>, over: { mirror?: string; progress?: (d: number, t: number) => void } = {}) =>
  ensureRuntime({ manifest: manifest(), target: "linux-x64", format: "xz", dir, file: n => path.join(dir, n), fs, fetch, ...over });

describe("the Node runtime for remotes (§5.2.1)", () => {
  it("downloads the pinned file from nodejs.org, checks it, and keeps it", async () => {
    const dir = tmp();
    const fetch = vi.fn(async () => answer(BODY));
    const progress: number[] = [];
    const r = await run(dir, fetch, { progress: d => progress.push(d) });
    expect(fetch).toHaveBeenCalledWith("https://nodejs.org/dist/v24.11.1/node-v24.11.1-linux-x64.tar.xz", expect.anything());
    expect(r).toEqual({ path: path.join(dir, "node-v24.11.1-linux-x64.tar.xz"), sha256: sha(BODY), bytes: BODY.length });
    expect(progress.at(-1)).toBe(BODY.length);
    expect(readdirSync(dir)).toEqual(["node-v24.11.1-linux-x64.tar.xz"]);
    // The second time it comes from the cache.
    const again = vi.fn(async () => answer(BODY));
    await run(dir, again);
    expect(again).not.toHaveBeenCalled();
  });

  it("uses the administrator's mirror, https only", async () => {
    const fetch = vi.fn(async () => answer(BODY));
    await run(tmp(), fetch, { mirror: "https://mirror.example.com/node/" });
    expect(fetch).toHaveBeenCalledWith("https://mirror.example.com/node/v24.11.1/node-v24.11.1-linux-x64.tar.xz", expect.anything());
    expect(() => runtimeUrl("24.11.1", "f", "http://mirror.example.com")).toThrow(RuntimeError);
    expect(() => runtimeUrl("24.11.1", "f", "https://x.example.com/a b")).toThrow(RuntimeError);
  });

  it("never keeps a file that doesn't match: wrong bytes, too many, too few", async () => {
    for (const body of [Buffer.alloc(BODY.length, 4), Buffer.concat([BODY, Buffer.alloc(10)]), BODY.subarray(0, 1000)]) {
      const dir = tmp();
      const err = await run(dir, async () => answer(body)).catch(e => e);
      expect(err).toBeInstanceOf(RuntimeError);
      expect((err as RuntimeError).kind).toBe("mismatch");
      expect(readdirSync(dir)).toEqual([]);
    }
  });

  it("re-downloads over a cached file that changed", async () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "node-v24.11.1-linux-x64.tar.xz"), Buffer.alloc(BODY.length, 9));
    expect(await cachedOk(fs, path.join(dir, "node-v24.11.1-linux-x64.tar.xz"), { sha256: sha(BODY), bytes: BODY.length })).toBe(false);
    const fetch = vi.fn(async () => answer(BODY));
    await run(dir, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports a server error or no connection as a download failure", async () => {
    expect(await run(tmp(), async () => answer(Buffer.alloc(0), 404)).catch(e => [e.kind, e.reason])).toEqual(["download", "the server answered 404"]);
    expect(await run(tmp(), async () => { throw new Error("ENOTFOUND"); }).catch(e => e.kind)).toBe("download");
  });

  it("accepts only a manifest whose files are the pinned version's", () => {
    expect(() => manifest({ targets: { "linux-x64": { xz: { file: "node-v24.10.0-linux-x64.tar.xz", sha256: "a".repeat(64), bytes: 1 } } } })).toThrow();
    expect(() => manifest({ pinned: "latest" })).toThrow();
    expect(() => manifest({ targets: { "linux-x64": { xz: { file: "../../evil.tar.xz", sha256: "a".repeat(64), bytes: 1 } } } })).toThrow();
    expect(RuntimeManifestSchema.safeParse({ ...manifest(), "//": "SHASUMS256.txt checked with the release key" }).success).toBe(true);
  });
});

describe("the parts this install ships (§5.2.2, §5.2.4)", () => {
  const PARTS = Buffer.alloc(50_000, 5);

  function shipped() {
    const root = tmp();
    const resources = path.join(root, "resources");
    const appDir = path.join(root, "app", "dist", "app");
    const dist = path.join(root, "app", "dist", "remote-parts");
    for (const d of [resources, appDir, dist]) mkdirSync(d, { recursive: true });
    return { root, resources, appDir, dist };
  }

  it("reads the packaged manifests first, then dist/ in an unpackaged build", async () => {
    const s = shipped();
    await fsp.mkdir(s.dist, { recursive: true });
    await fsp.writeFile(path.join(s.dist, "remote-parts.json"), JSON.stringify({ partsId: "0.1.0-0123456789ab", targets: { "linux-x64": { file: "ember-remote-parts-0.1.0-0123456789ab-linux-x64.tar.gz", sha256: sha(PARTS), bytes: PARTS.length } } }));
    await fsp.writeFile(path.join(s.dist, "ember-remote-parts-0.1.0-0123456789ab-linux-x64.tar.gz"), PARTS);
    await fsp.writeFile(path.join(s.dist, "remote-runtime.json"), JSON.stringify(manifest()));
    const candidates = shippedCandidates({ resourcesPath: s.resources, appDir: s.appDir, join: path.join });
    const found = await loadShipped({ candidates, readFile: p => fsp.readFile(p, "utf8"), join: path.join });
    expect(found.parts?.dir).toBe(s.dist);
    expect(found.runtime?.pinned).toBe("24.11.1");
    expect(planShipped(found)).toEqual({
      parts: { partsId: "0.1.0-0123456789ab", targets: { "linux-x64": { bytes: PARTS.length, sha256: sha(PARTS) } } },
      runtime: { minimum: "24.8.0", pinned: "24.11.1", targets: { "linux-x64": { xz: { bytes: BODY.length, sha256: sha(BODY) } } } },
    });
    expect(await partsArchive(found, "linux-x64", { fs, join: path.join })).toMatchObject({ id: "0.1.0-0123456789ab", format: "gz", bytes: PARTS.length });
    expect(await partsArchive(found, "darwin-arm64", { fs, join: path.join })).toBeNull();
    // A changed archive is never sent.
    await fsp.writeFile(path.join(s.dist, "ember-remote-parts-0.1.0-0123456789ab-linux-x64.tar.gz"), Buffer.alloc(PARTS.length, 6));
    expect(await partsArchive(found, "linux-x64", { fs, join: path.join })).toBeNull();
  });

  it("says missing when no manifest parses", async () => {
    const s = shipped();
    await fsp.mkdir(path.join(s.resources, "remote-parts"), { recursive: true });
    await fsp.writeFile(path.join(s.resources, "remote-parts", "remote-parts.json"), "{ not json");
    const found = await loadShipped({ candidates: shippedCandidates({ resourcesPath: s.resources, appDir: s.appDir, join: path.join }), readFile: p => fsp.readFile(p, "utf8"), join: path.join });
    expect(found).toEqual({ parts: null, runtime: null });
    expect(planShipped(found)).toEqual({ parts: null, runtime: null });
  });
});
