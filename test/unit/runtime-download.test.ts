import { createHash } from "node:crypto";
import { createReadStream, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadShipped, partsArchive, planShipped, shippedCandidates } from "../../app/main/remote/parts-cache";
import { cachedOk, ensureRuntime, RUNTIME_STALL_MS, RuntimeError, RuntimeManifestSchema, runtimeUrl, type RuntimeFs, type RuntimeManifest } from "../../app/main/remote/runtime-download";

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
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; vi.useRealTimers(); });

/** An in-memory cache folder (the stall tests run on fake timers, so no real I/O waits in them). */
function memFs() {
  const files = new Map<string, Buffer>();
  const removed: string[] = [];
  const fs: RuntimeFs = {
    stat: async p => { const f = files.get(p); if (!f) throw new Error("ENOENT"); return { size: f.length }; },
    open: async p => {
      files.set(p, Buffer.alloc(0));
      return { write: async b => { files.set(p, Buffer.concat([files.get(p) ?? Buffer.alloc(0), b])); }, close: async () => undefined };
    },
    createReadStream: p => (async function* () { yield files.get(p) ?? Buffer.alloc(0); })(),
    rename: async (a, b) => { files.set(b, files.get(a) as Buffer); files.delete(a); },
    rm: async p => { removed.push(p); files.delete(p); },
    mkdir: async () => undefined,
  };
  return { fs, files, removed };
}

/** A fetch whose answer sends `first` and then nothing, ignoring its signal (the worst case); it records the signal. */
function stallingFetch(first: Buffer | null) {
  const seen: { signal?: AbortSignal; cancelled: boolean } = { cancelled: false };
  const fetch = async (_url: string, init?: { signal?: AbortSignal }) => {
    seen.signal = init?.signal;
    if (!first) return new Promise<never>(() => { /* the server never answers */ });
    return {
      ok: true, status: 200,
      body: new ReadableStream<Uint8Array>({
        start(c) { c.enqueue(new Uint8Array(first)); },
        cancel() { seen.cancelled = true; },
      }),
    };
  };
  return { fetch, seen };
}

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

  it("ends a download that goes 60 s without a byte: the request aborted, the partial file deleted, \"stalled\"", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(RUNTIME_STALL_MS).toBe(60_000);
    const m = memFs();
    const { fetch, seen } = stallingFetch(BODY.subarray(0, 65_536));
    const progress: number[] = [];
    let settled = false;
    const p = ensureRuntime({ manifest: manifest(), target: "linux-x64", format: "xz", dir: "/c", file: n => `/c/${n}`, fs: m.fs, fetch, progress: d => progress.push(d) })
      .catch((e: unknown) => e)
      .finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(RUNTIME_STALL_MS - 1);
    expect(settled).toBe(false);
    expect(progress).toEqual([65_536]);
    expect([...m.files.keys()]).toEqual([expect.stringMatching(/^\/c\/node-v24\.11\.1-linux-x64\.tar\.xz\.[0-9a-f]{8}\.part$/)]);
    await vi.advanceTimersByTimeAsync(1);
    const err = await p;
    expect(err).toBeInstanceOf(RuntimeError);
    expect((err as RuntimeError).kind).toBe("stalled");
    expect(seen.signal?.aborted).toBe(true);
    expect(seen.cancelled).toBe(true);
    expect(m.files.size).toBe(0);
    expect(m.removed).toHaveLength(1);
  });

  it("ends a request the server never answers after the same 60 s", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const m = memFs();
    const { fetch, seen } = stallingFetch(null);
    let settled = false;
    const p = ensureRuntime({ manifest: manifest(), target: "linux-x64", format: "xz", dir: "/c", file: n => `/c/${n}`, fs: m.fs, fetch })
      .catch((e: unknown) => e)
      .finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(RUNTIME_STALL_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await p).toMatchObject({ kind: "stalled" });
    expect(seen.signal?.aborted).toBe(true);
    expect(m.files.size).toBe(0);
  });

  it("counts the limit from the last byte, so a slow download that keeps coming finishes", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const m = memFs();
    const pieces = 6;
    const size = BODY.length / pieces;
    // One piece every 50 s: five minutes in all, never 60 s without a byte.
    const fetch = async () => ({
      ok: true, status: 200,
      body: new ReadableStream<Uint8Array>({
        async start(c) {
          for (let i = 0; i < pieces; i++) {
            await new Promise(r => setTimeout(r, 50_000));
            c.enqueue(new Uint8Array(BODY.subarray(i * size, (i + 1) * size)));
          }
          c.close();
        },
      }),
    });
    const p = ensureRuntime({ manifest: manifest(), target: "linux-x64", format: "xz", dir: "/c", file: n => `/c/${n}`, fs: m.fs, fetch });
    await vi.advanceTimersByTimeAsync(pieces * 50_000);
    await expect(p).resolves.toEqual({ path: "/c/node-v24.11.1-linux-x64.tar.xz", sha256: sha(BODY), bytes: BODY.length });
    expect([...m.files.keys()]).toEqual(["/c/node-v24.11.1-linux-x64.tar.xz"]);
  });

  it("counts the limit again from the server's answer, so a slow answer and a slow first piece finish", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const m = memFs();
    // The answer after 50 s, its first (and only) piece 50 s later: never 60 s without a byte, 100 s in all.
    const fetch = async () => {
      await new Promise(r => setTimeout(r, 50_000));
      return {
        ok: true, status: 200,
        body: new ReadableStream<Uint8Array>({
          async start(c) {
            await new Promise(r => setTimeout(r, 50_000));
            c.enqueue(new Uint8Array(BODY));
            c.close();
          },
        }),
      };
    };
    const p = ensureRuntime({ manifest: manifest(), target: "linux-x64", format: "xz", dir: "/c", file: n => `/c/${n}`, fs: m.fs, fetch })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(await p).toEqual({ path: "/c/node-v24.11.1-linux-x64.tar.xz", sha256: sha(BODY), bytes: BODY.length });
  });

  it("lets go of an answer that comes after the stall, and of a refused answer's body, unread", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const m = memFs();
    const cancelled: string[] = [];
    const body = (name: string) => new ReadableStream<Uint8Array>({ cancel() { cancelled.push(name); } });
    // The server answers only after 70 s, ignoring the abort at 60 s (a wedged proxy).
    const late = async () => { await new Promise(r => setTimeout(r, 70_000)); return { ok: true, status: 200, body: body("late") }; };
    const p = ensureRuntime({ manifest: manifest(), target: "linux-x64", format: "xz", dir: "/c", file: n => `/c/${n}`, fs: m.fs, fetch: late })
      .catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(RUNTIME_STALL_MS);
    expect(await p).toMatchObject({ kind: "stalled" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(cancelled).toEqual(["late"]);
    const refused = await ensureRuntime({ manifest: manifest(), target: "linux-x64", format: "xz", dir: "/c", file: n => `/c/${n}`, fs: m.fs, fetch: async () => ({ ok: false, status: 503, body: body("refused") }) })
      .catch((e: unknown) => e);
    expect(refused).toMatchObject({ kind: "download", reason: "the server answered 503" });
    expect(cancelled).toEqual(["late", "refused"]);
    expect(m.files.size).toBe(0);
  });

  it("still says \"cancelled\" when the user cancels a download that is waiting for bytes", async () => {
    const m = memFs();
    const { fetch, seen } = stallingFetch(BODY.subarray(0, 1000));
    const ac = new AbortController();
    const p = ensureRuntime({ manifest: manifest(), target: "linux-x64", format: "xz", dir: "/c", file: n => `/c/${n}`, fs: m.fs, fetch, signal: ac.signal, progress: () => ac.abort() });
    expect(await p.catch((e: unknown) => e)).toMatchObject({ kind: "download", reason: "cancelled" });
    expect(seen.signal?.aborted).toBe(true);
    expect(m.files.size).toBe(0);
  });

  it("accepts only a manifest whose files are the pinned version's", () => {
    expect(() => manifest({ targets: { "linux-x64": { xz: { file: "node-v24.10.0-linux-x64.tar.xz", sha256: "a".repeat(64), bytes: 1 } } } })).toThrow();
    expect(() => manifest({ pinned: "latest" })).toThrow();
    expect(() => manifest({ targets: { "linux-x64": { xz: { file: "../../evil.tar.xz", sha256: "a".repeat(64), bytes: 1 } } } })).toThrow();
    expect(RuntimeManifestSchema.safeParse({ ...manifest(), "//": "SHASUMS256.txt checked with the release key" }).success).toBe(true);
  });
});

describe("the runtime cache's old files (review #39)", () => {
  const withReaddir: RuntimeFs = { ...fs, readdir: p => fsp.readdir(p) };
  const put = (dir: string, name: string, ageMs = 0, body: Buffer = Buffer.alloc(10)) => {
    writeFileSync(path.join(dir, name), body);
    if (ageMs) { const t = (Date.now() - ageMs) / 1000; utimesSync(path.join(dir, name), t, t); }
  };
  const DAY = 24 * 60 * 60 * 1000;
  // Another target's pinned archive, which another computer may need, is kept.
  const both = () => manifest({ targets: {
    "linux-x64": { xz: { file: "node-v24.11.1-linux-x64.tar.xz", sha256: sha(BODY), bytes: BODY.length } },
    "darwin-arm64": { gz: { file: "node-v24.11.1-darwin-arm64.tar.gz", sha256: sha(BODY), bytes: BODY.length } },
  } });

  it("deletes the archives of Node versions Ember no longer pins, and partial downloads a day old, after a download", async () => {
    const dir = tmp();
    put(dir, "node-v24.10.0-linux-x64.tar.xz");
    put(dir, "node-v22.20.0-darwin-arm64.tar.gz");
    put(dir, "node-v24.11.1-darwin-arm64.tar.gz");
    put(dir, "node-v24.10.0-linux-x64.tar.xz.0a1b2c3d.part", 2 * DAY);
    // Another connection's download still in progress, and a file that isn't Ember's runtime: left alone.
    put(dir, "node-v24.11.1-darwin-arm64.tar.gz.4e5f6a7b.part");
    put(dir, "notes.txt", 30 * DAY);
    await ensureRuntime({ manifest: both(), target: "linux-x64", format: "xz", dir, file: n => path.join(dir, n), fs: withReaddir, fetch: async () => answer(BODY) });
    expect(readdirSync(dir).sort()).toEqual(["node-v24.11.1-darwin-arm64.tar.gz", "node-v24.11.1-darwin-arm64.tar.gz.4e5f6a7b.part", "node-v24.11.1-linux-x64.tar.xz", "notes.txt"]);
  });

  it("does the same when the pinned archive comes from the cache", async () => {
    const dir = tmp();
    put(dir, "node-v24.11.1-linux-x64.tar.xz", 0, BODY);
    put(dir, "node-v24.10.0-linux-x64.tar.xz");
    const fetch = vi.fn(async () => answer(BODY));
    await ensureRuntime({ manifest: manifest(), target: "linux-x64", format: "xz", dir, file: n => path.join(dir, n), fs: withReaddir, fetch });
    expect(fetch).not.toHaveBeenCalled();
    expect(readdirSync(dir)).toEqual(["node-v24.11.1-linux-x64.tar.xz"]);
  });

  it("never fails the download over the clean-up, and keeps everything when the download fails", async () => {
    const dir = tmp();
    const broken: RuntimeFs = { ...fs, readdir: async () => { throw new Error("EACCES"); } };
    expect(await ensureRuntime({ manifest: manifest(), target: "linux-x64", format: "xz", dir, file: n => path.join(dir, n), fs: broken, fetch: async () => answer(BODY) })).toMatchObject({ bytes: BODY.length });
    const other = tmp();
    put(other, "node-v24.10.0-linux-x64.tar.xz");
    await expect(ensureRuntime({ manifest: manifest(), target: "linux-x64", format: "xz", dir: other, file: n => path.join(other, n), fs: withReaddir, fetch: async () => answer(Buffer.alloc(10)) })).rejects.toMatchObject({ kind: "mismatch" });
    expect(readdirSync(other)).toEqual(["node-v24.10.0-linux-x64.tar.xz"]);
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
