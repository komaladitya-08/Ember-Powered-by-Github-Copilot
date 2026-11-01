/**
 * The Node runtime a remote runs Ember's helper on (§5.2.1): official Node, pinned by SB's remote-runtime.json
 * (`minimum`, `pinned`, and each target's .tar.xz and .tar.gz with their SHA-256 copied from the release's
 * SHASUMS256.txt). The PC downloads it once per target with Electron's net.fetch (the system proxy), from nodejs.org
 * or the administrator's `ssh.runtimeMirror` (same layout, still checked), and keeps it in <userData>/remote/runtime/.
 * Every byte is hashed before anything is sent: a file that doesn't match is deleted and never sent anywhere. A download
 * that goes RUNTIME_STALL_MS without a byte is ended (request and all): the SSH attempt waits on it, and nothing else
 * would end a server or proxy that stops sending. After a runtime is in place, the archives of Node versions Ember no
 * longer pins (and partial downloads a day old) are deleted from that folder, so updates don't pile them up.
 */

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { TargetsDeps } from "../targets/types";
import type { RemoteTarget } from "./plan";

const HEX64 = /^[0-9a-f]{64}$/;
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
/** The largest runtime archive Ember accepts (Node's are about 30-50 MB). */
export const RUNTIME_MAX_BYTES = 200 * 1024 * 1024;
/** How long the download may go without a byte from the network before Ember ends it as stalled. */
export const RUNTIME_STALL_MS = 60_000;

const RuntimeFile = z.object({
  file: z.string().regex(/^node-v\d{1,3}\.\d{1,3}\.\d{1,3}-(linux|darwin)-(x64|arm64)\.tar\.(xz|gz)$/),
  sha256: z.string().regex(HEX64),
  bytes: z.number().int().min(1).max(RUNTIME_MAX_BYTES),
}).strict();

/** remote-runtime.json (SB): which Node every remote gets (critique remote-27). Unknown top-level keys (a comment) are ignored. */
export const RuntimeManifestSchema = z.object({
  minimum: z.string().regex(VERSION),
  pinned: z.string().regex(VERSION),
  targets: z.partialRecord(z.enum(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]), z.object({ xz: RuntimeFile.optional(), gz: RuntimeFile.optional() }).strict()),
}).passthrough().refine(m => Object.values(m.targets).every(t => [t?.xz, t?.gz].every(f => !f || f.file.startsWith(`node-v${m.pinned}-`))), "every file is the pinned version's");

export type RuntimeManifest = z.infer<typeof RuntimeManifestSchema>;

/** Why a download failed: §8.7's "Node download" (with a few words), the mismatch message, or a stall (no byte in time). */
export class RuntimeError extends Error {
  constructor(readonly kind: "download" | "mismatch" | "stalled", readonly reason: string) { super(reason); }
}

/** The file system the cache uses (fs/promises in Ember; a temp folder in tests). */
export interface RuntimeFs {
  stat(p: string): Promise<{ size: number; mtimeMs?: number }>;
  open(p: string, flags: "w"): Promise<{ write(b: Uint8Array): Promise<unknown>; close(): Promise<void> }>;
  createReadStream(p: string): AsyncIterable<Uint8Array>;
  rename(from: string, to: string): Promise<void>;
  rm(p: string, o: { force: true }): Promise<void>;
  mkdir(p: string, o: { recursive: true; mode: number }): Promise<unknown>;
  /** The folder's file names; without it old archives are left (pruneRuntimes does nothing). */
  readdir?(p: string): Promise<string[]>;
}

/** SHA-256 of a file, streamed. */
export async function sha256File(fs: Pick<RuntimeFs, "createReadStream">, p: string): Promise<string> {
  const h = createHash("sha256");
  for await (const c of fs.createReadStream(p)) h.update(c);
  return h.digest("hex");
}

/** The download URL: nodejs.org's (or the mirror's) `/v<version>/<file>`. Only https. */
export function runtimeUrl(version: string, file: string, mirror?: string): string {
  const base = (mirror ?? "https://nodejs.org/dist").replace(/\/+$/, "");
  if (!/^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(base)) throw new RuntimeError("download", "the mirror isn't an https address");
  return `${base}/v${version}/${file}`;
}

/** Is this cached file the pinned one (size and SHA-256)? */
export async function cachedOk(fs: RuntimeFs, file: string, want: { sha256: string; bytes: number }): Promise<boolean> {
  const st = await fs.stat(file).catch(() => null);
  if (!st || st.size !== want.bytes) return false;
  return (await sha256File(fs, file).catch(() => "")) === want.sha256;
}

/** A runtime archive's name in the cache, and a partial download's (ensureRuntime's `<file>.<8 hex>.part`). */
const ARCHIVE = /^node-v\d{1,3}\.\d{1,3}\.\d{1,3}-(linux|darwin)-(x64|arm64)\.tar\.(xz|gz)$/;
const PART = /^node-v\d{1,3}\.\d{1,3}\.\d{1,3}-(linux|darwin)-(x64|arm64)\.tar\.(xz|gz)\.[0-9a-f]{8}\.part$/;
/** How old a partial download must be before it is deleted: younger ones may be another connection's, still going. */
export const STALE_PART_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes from the cache folder the runtime archives the manifest doesn't name (any target's pinned archive is kept:
 * another computer may need it) and partial downloads older than STALE_PART_MS. Nothing else in the folder is
 * touched, and it never throws: an archive it can't delete is simply still there next time.
 */
export async function pruneRuntimes(o: { manifest: RuntimeManifest; dir: string; file: (name: string) => string; fs: RuntimeFs; now?: number }): Promise<void> {
  if (!o.fs.readdir) return;
  const keep = new Set(Object.values(o.manifest.targets).flatMap(t => [t?.xz?.file, t?.gz?.file]).filter((f): f is string => !!f));
  const now = o.now ?? Date.now();
  let names: string[];
  try {
    names = await o.fs.readdir(o.dir);
  } catch {
    return;
  }
  for (const name of names) {
    try {
      if (ARCHIVE.test(name) ? keep.has(name) : !PART.test(name)) continue;
      if (PART.test(name)) {
        const st = await o.fs.stat(o.file(name));
        if (st.mtimeMs === undefined || now - st.mtimeMs < STALE_PART_MS) continue;
      }
      await o.fs.rm(o.file(name), { force: true });
    } catch {
      // Gone already, or in use: harmless to leave until the next time.
    }
  }
}

/** Lets the server's connection go without waiting on it: a body that ignores its cancel can't hold the attempt. */
function release(body: { cancel(): Promise<void> } | null | undefined): void {
  try {
    body?.cancel().catch(() => undefined);
  } catch {
    // nothing more to let go
  }
}

/**
 * The pinned runtime archive for `target` in `format`, downloaded if the cache doesn't hold it (§5.2.1). `file` is the
 * cache path (`<userData>/remote/runtime/<name>`), `dir` its folder. Resolves the path of a file whose bytes match;
 * throws RuntimeError otherwise: "stalled" when the answer or the next byte doesn't come within `stallMs` (default
 * RUNTIME_STALL_MS), the request then aborted and the partial file deleted. `progress` hears bytes downloaded of the total.
 */
export async function ensureRuntime(o: {
  manifest: RuntimeManifest;
  target: RemoteTarget;
  format: "xz" | "gz";
  dir: string;
  file: (name: string) => string;
  fs: RuntimeFs;
  fetch: TargetsDeps["fetch"];
  mirror?: string;
  signal?: AbortSignal;
  progress?: (done: number, total: number) => void;
  stallMs?: number;
  /**
   * Folders that came with Ember holding the pinned archives (resources/remote-parts/runtime): one there, of the size and
   * SHA-256 pinned, is sent as it is, and nothing is downloaded (network-restricted PCs).
   */
  bundled?: string[];
  join?: (...p: string[]) => string;
}): Promise<{ path: string; sha256: string; bytes: number }> {
  const entry = o.manifest.targets[o.target]?.[o.format];
  if (!entry) throw new RuntimeError("download", "no runtime for that computer");
  for (const dir of o.bundled ?? []) {
    const p = (o.join ?? ((...x: string[]) => x.join("/")))(dir, entry.file);
    if (await cachedOk(o.fs, p, entry)) return { path: p, sha256: entry.sha256, bytes: entry.bytes };
  }
  const dest = o.file(entry.file);
  if (await cachedOk(o.fs, dest, entry)) {
    await pruneRuntimes(o);
    return { path: dest, sha256: entry.sha256, bytes: entry.bytes };
  }
  await o.fs.mkdir(o.dir, { recursive: true, mode: 0o700 });
  const url = runtimeUrl(o.manifest.pinned, entry.file, o.mirror);
  // The request's own signal: the caller's Cancel, or no byte for stallMs. Waits race it too, so a fetch or a read that
  // doesn't honour the signal is still never waited for.
  const ac = new AbortController();
  const cancel = () => ac.abort();
  if (o.signal?.aborted) ac.abort();
  else o.signal?.addEventListener("abort", cancel, { once: true });
  const ended = new Promise<never>((_, reject) => {
    const fail = () => reject(new Error("aborted"));
    if (ac.signal.aborted) fail();
    else ac.signal.addEventListener("abort", fail, { once: true });
  });
  ended.catch(() => { /* seen by whichever wait it ends */ });
  let stalled = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** (Re)starts the stall limit: before the request, at its answer, and as each piece of the file arrives. */
  const watch = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; stalled = true; ac.abort(); }, o.stallMs ?? RUNTIME_STALL_MS);
  };
  /** Why the download ended early: a stall, the caller's Cancel, or `other`. */
  const why = (other: string) => (stalled ? new RuntimeError("stalled", "no data arrived for a while")
    : o.signal?.aborted ? new RuntimeError("download", "cancelled") : new RuntimeError("download", other));
  let part: string | null = null;
  try {
    watch();
    let res: Awaited<ReturnType<TargetsDeps["fetch"]>>;
    let request: ReturnType<TargetsDeps["fetch"]> | null = null;
    try {
      request = o.fetch(url, { signal: ac.signal });
      res = await Promise.race([request, ended]);
    } catch {
      // An answer that still comes (a fetch that ignored the abort) is let go unread.
      request?.then(late => release(late.body), () => undefined);
      throw why("no connection");
    }
    // The answer is bytes from the server too: the limit counts again from it, so it now waits for the first piece.
    watch();
    if (!res.ok || !res.body) {
      release(res.body);
      throw new RuntimeError("download", `the server answered ${res.status}`);
    }
    const reader = res.body.getReader();
    const letGo = () => release(reader);
    part = o.file(`${entry.file}.${randomBytes(4).toString("hex")}.part`);
    const out = await o.fs.open(part, "w").catch((err: unknown) => {
      letGo();
      throw err;
    });
    const h = createHash("sha256");
    let got = 0;
    let failed: RuntimeError | null = null;
    let complete = false;
    try {
      for (;;) {
        if (ac.signal.aborted) { failed = why("cancelled"); break; }
        let r: ReadableStreamReadResult<Uint8Array>;
        try {
          r = await Promise.race([reader.read(), ended]);
        } catch {
          failed = why("the download broke off");
          break;
        }
        if (r.done) { complete = true; break; }
        if (r.value.length) watch();
        got += r.value.length;
        if (got > entry.bytes) { failed = new RuntimeError("mismatch", "larger than expected"); break; }
        h.update(r.value);
        await out.write(r.value);
        o.progress?.(got, entry.bytes);
      }
    } finally {
      await out.close().catch(() => undefined);
      // Whatever ended the loop early (a stall, Cancel, too many bytes, a write that failed) lets the server go.
      if (!complete) letGo();
    }
    if (!failed && (got !== entry.bytes || h.digest("hex") !== entry.sha256)) failed = new RuntimeError("mismatch", "doesn't match the expected file");
    if (failed) throw failed;
  } catch (err) {
    if (part) await o.fs.rm(part, { force: true }).catch(() => undefined);
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    o.signal?.removeEventListener("abort", cancel);
  }
  await o.fs.rename(part as string, dest);
  await pruneRuntimes(o);
  return { path: dest, sha256: entry.sha256, bytes: entry.bytes };
}
