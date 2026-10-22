/**
 * The Node runtime a remote runs Ember's helper on (§5.2.1): official Node, pinned by SB's remote-runtime.json
 * (`minimum`, `pinned`, and each target's .tar.xz and .tar.gz with their SHA-256 copied from the release's
 * SHASUMS256.txt). The PC downloads it once per target with Electron's net.fetch (the system proxy), from nodejs.org
 * or the administrator's `ssh.runtimeMirror` (same layout, still checked), and keeps it in <userData>/remote/runtime/.
 * Every byte is hashed before anything is sent: a file that doesn't match is deleted and never sent anywhere.
 */

import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { TargetsDeps } from "../targets/types";
import type { RemoteTarget } from "./plan";

const HEX64 = /^[0-9a-f]{64}$/;
const VERSION = /^\d{1,3}\.\d{1,3}\.\d{1,3}$/;
/** The largest runtime archive Ember accepts (Node's are about 30-50 MB). */
export const RUNTIME_MAX_BYTES = 200 * 1024 * 1024;

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

/** Why a download failed: §8.7's "Node download" (with a few words) or the mismatch message. */
export class RuntimeError extends Error {
  constructor(readonly kind: "download" | "mismatch", readonly reason: string) { super(reason); }
}

/** The file system the cache uses (fs/promises in Ember; a temp folder in tests). */
export interface RuntimeFs {
  stat(p: string): Promise<{ size: number }>;
  open(p: string, flags: "w"): Promise<{ write(b: Uint8Array): Promise<unknown>; close(): Promise<void> }>;
  createReadStream(p: string): AsyncIterable<Uint8Array>;
  rename(from: string, to: string): Promise<void>;
  rm(p: string, o: { force: true }): Promise<void>;
  mkdir(p: string, o: { recursive: true; mode: number }): Promise<unknown>;
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

/**
 * The pinned runtime archive for `target` in `format`, downloaded if the cache doesn't hold it (§5.2.1). `file` is the
 * cache path (`<userData>/remote/runtime/<name>`), `dir` its folder. Resolves the path of a file whose bytes match;
 * throws RuntimeError otherwise. `progress` hears bytes downloaded of the total.
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
}): Promise<{ path: string; sha256: string; bytes: number }> {
  const entry = o.manifest.targets[o.target]?.[o.format];
  if (!entry) throw new RuntimeError("download", "no runtime for that computer");
  const dest = o.file(entry.file);
  if (await cachedOk(o.fs, dest, entry)) return { path: dest, sha256: entry.sha256, bytes: entry.bytes };
  await o.fs.mkdir(o.dir, { recursive: true, mode: 0o700 });
  const url = runtimeUrl(o.manifest.pinned, entry.file, o.mirror);
  let res: Awaited<ReturnType<TargetsDeps["fetch"]>>;
  try {
    res = await o.fetch(url, { signal: o.signal });
  } catch {
    throw new RuntimeError("download", o.signal?.aborted ? "cancelled" : "no connection");
  }
  if (!res.ok || !res.body) throw new RuntimeError("download", `the server answered ${res.status}`);
  const part = o.file(`${entry.file}.${randomBytes(4).toString("hex")}.part`);
  const out = await o.fs.open(part, "w");
  const h = createHash("sha256");
  let got = 0;
  let failed: RuntimeError | null = null;
  try {
    const reader = res.body.getReader();
    for (;;) {
      if (o.signal?.aborted) { failed = new RuntimeError("download", "cancelled"); break; }
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await reader.read();
      } catch {
        failed = new RuntimeError("download", o.signal?.aborted ? "cancelled" : "the download broke off");
        break;
      }
      if (r.done) break;
      got += r.value.length;
      if (got > entry.bytes) { failed = new RuntimeError("mismatch", "larger than expected"); await reader.cancel().catch(() => undefined); break; }
      h.update(r.value);
      await out.write(r.value);
      o.progress?.(got, entry.bytes);
    }
  } finally {
    await out.close().catch(() => undefined);
  }
  if (!failed && (got !== entry.bytes || h.digest("hex") !== entry.sha256)) failed = new RuntimeError("mismatch", "doesn't match the expected file");
  if (failed) {
    await o.fs.rm(part, { force: true }).catch(() => undefined);
    throw failed;
  }
  await o.fs.rename(part, dest);
  return { path: dest, sha256: entry.sha256, bytes: entry.bytes };
}
