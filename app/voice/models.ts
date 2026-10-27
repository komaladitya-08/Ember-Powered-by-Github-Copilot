/**
 * Speech models Ember downloads on first use (about 126 MB), each pinned to a
 * SHA-256, into the models folder of Ember's data folder (~/.config/ember/models
 * on Linux). Nothing is used until it verifies. Archives are unpacked in-process
 * (untar.ts, bzip2.ts), so no system tar, bzip2 or curl is needed on any OS, into
 * a staging folder that is moved into place whole: a half-unpacked model is never
 * where Ember looks for one.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import path from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import tls from "node:tls";
import type { ModelPaths } from "./sherpa";
import { extractTarBz2 } from "./untar";

const RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download";

export interface ModelFile {
  id: keyof ModelPaths;
  name: string;
  url: string;
  sha256: string;
  bytes: number;
  /** Archive to unpack (its top folder is the model), or a single file. */
  kind: "tar.bz2" | "file";
  /** Folder (archives) or file name once in place. */
  target: string;
  license: string;
}

export const VOICE_MODELS: ModelFile[] = [
  {
    id: "kws", name: "Wake word (keyword spotting, 3.3M zipformer)", kind: "tar.bz2", license: "Apache-2.0",
    url: `${RELEASES}/kws-models/sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01.tar.bz2`,
    sha256: "f170013b4716e41b62b9bfd809687c207cef798ef9bc6534d524e17af9b6561a", bytes: 17_626_723,
    target: "sherpa-onnx-kws-zipformer-gigaspeech-3.3M-2024-01-01",
  },
  {
    id: "vad", name: "Voice activity (Silero VAD)", kind: "file", license: "MIT",
    url: `${RELEASES}/asr-models/silero_vad.onnx`,
    sha256: "9e2449e1087496d8d4caba907f23e0bd3f78d91fa552479bb9c23ac09cbb1fd6", bytes: 643_854,
    target: "silero_vad.onnx",
  },
  {
    id: "asr", name: "Speech recognition (Moonshine tiny, English)", kind: "tar.bz2", license: "MIT",
    url: `${RELEASES}/asr-models/sherpa-onnx-moonshine-tiny-en-int8.tar.bz2`,
    sha256: "d5fe6ec4334fef36255b2a4010412cad4c007e33103fec62fb5d17cad88086f2", bytes: 107_600_538,
    target: "sherpa-onnx-moonshine-tiny-en-int8",
  },
];

export const VOICE_MODELS_BYTES = VOICE_MODELS.reduce((n, m) => n + m.bytes, 0);

/** Downloads `url` to `dest`, reporting bytes so far. */
export type Downloader = (url: string, dest: string, progress: (bytes: number) => void) => Promise<void>;

/**
 * Progress of getting the models: bytes of the whole (`total`) done so far. `phase` "unpacking": the last download is
 * in, and is being checked and unpacked.
 */
export type ModelsProgress = (done: number, total: number, phase?: "unpacking") => void;

/**
 * Of an archive's share of the progress, what its download counts for: the rest is checking and unpacking it, which
 * took longer than the download itself on a fast network (5 s for the 107 MB archive), so the bar never sits at the end
 * meanwhile (review #259).
 */
const DOWNLOAD_SHARE = 0.8;

export function modelPaths(root: string): ModelPaths {
  const p = (id: keyof ModelPaths) => path.join(root, VOICE_MODELS.find(m => m.id === id)!.target);
  return { kws: p("kws"), vad: p("vad"), asr: p("asr") };
}

const marker = (root: string, m: ModelFile) => path.join(root, `.${m.target}.ok`);

/** In place and verified against the pin it was checked with (a model whose pin changed is fetched again). */
function verified(root: string, m: ModelFile): boolean {
  try {
    return fs.readFileSync(marker(root, m), "utf8").trim() === m.sha256 && fs.existsSync(path.join(root, m.target));
  } catch {
    return false;
  }
}

export function modelsReady(root: string): boolean {
  return VOICE_MODELS.every(m => verified(root, m));
}

/**
 * The models in `root` turned out damaged (they wouldn't load): their markers go, so they count as missing and the
 * download fetches them again (review #254). False when a marker couldn't be removed (a read-only folder, such as models
 * installed with Ember).
 */
export function forgetModels(root: string): boolean {
  let all = true;
  for (const m of VOICE_MODELS) {
    try {
      fs.rmSync(marker(root, m), { force: true });
    } catch {
      // It stays (EACCES, EROFS): the caller says the models can't be replaced here.
      all = false;
    }
  }
  return all;
}

export async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** What fetchModel needs to know about a pinned download. */
export type ModelDownload = Pick<ModelFile, "name" | "url" | "sha256" | "kind" | "target">;

/** How long a rename on Windows keeps retrying while something holds the files (ms). */
const RENAME_WAIT_MS = 15_000;

/**
 * Renames, retrying on Windows while the target is busy: an antivirus scanner or the search indexer often
 * holds a file that was just written (a 100 MB model can take seconds to scan), and the rename fails with
 * EPERM, EACCES or EBUSY meanwhile (graceful-fs, which npm uses, waits up to a minute for the same reason).
 * Elsewhere those errors are real, so they fail at once.
 */
async function moveIntoPlace(from: string, to: string): Promise<void> {
  const until = Date.now() + RENAME_WAIT_MS;
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const busy = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (process.platform !== "win32" || !busy || Date.now() >= until) throw err;
      await new Promise(resolve => setTimeout(resolve, Math.min(50 * (attempt + 1), 500)));
    }
  }
}

/**
 * Unpacks a verified archive into `root`: into a staging folder first, then its top folder is moved into place.
 * `unpacked`: the share of the archive read so far (0 to 1).
 */
async function unpackArchive(archive: string, root: string, m: ModelDownload, unpacked?: (fraction: number) => void): Promise<void> {
  // A fixed name, so a staging folder left by a crash is cleared on the next try instead of piling up.
  const staging = path.join(root, `.unpack-${m.target}`);
  fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5 });
  fs.mkdirSync(staging);
  try {
    try {
      // Only the model's own folder: an entry anywhere else (another model's folder, a marker) is refused.
      const size = fs.statSync(archive).size;
      await extractTarBz2(archive, staging, { topFolder: m.target, ...(unpacked && size ? { onRead: (n: number) => unpacked(Math.min(1, n / size)) } : {}) });
      if (!fs.statSync(path.join(staging, m.target), { throwIfNoEntry: false })?.isDirectory()) throw new Error(`it has no ${m.target} folder`);
    } catch (err) {
      // "tar" in the message: the voice service tells the user the download couldn't be unpacked.
      throw new Error(`${m.name}: the downloaded tar archive couldn't be unpacked: ${(err as Error).message}`, { cause: err });
    }
    const dest = path.join(root, m.target);
    fs.rmSync(dest, { recursive: true, force: true, maxRetries: 5 });
    await moveIntoPlace(path.join(staging, m.target), dest);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true, maxRetries: 5 });
  }
}

/**
 * Downloads one pinned model into `root`, checks its SHA-256 and puts it in place (unpacked, for an
 * archive). Whatever happens, no partial download or half-unpacked model is left behind. `unpacking`: the
 * download is in and is being checked, then unpacked (the share of the archive read so far, 0 to 1).
 */
export async function fetchModel(root: string, m: ModelDownload, download: Downloader, progress: (bytes: number) => void = () => undefined, unpacking?: (fraction: number) => void): Promise<void> {
  const tmp = path.join(root, `.download-${path.basename(m.url)}`);
  try {
    await download(m.url, tmp, progress);
    unpacking?.(0);
    const got = await sha256File(tmp);
    if (got !== m.sha256) throw new Error(`${m.name}: checksum mismatch (got ${got.slice(0, 12)}…). The download was not used.`);
    if (m.kind === "file") await moveIntoPlace(tmp, path.join(root, m.target));
    else await unpackArchive(tmp, root, m, unpacking);
  } finally {
    fs.rmSync(tmp, { force: true, maxRetries: 5 });
  }
}

/**
 * Makes every model present and verified; skips ones already in place. Progress counts an archive's download as
 * DOWNLOAD_SHARE of its share, and checking and unpacking it as the rest.
 */
export async function ensureModels(root: string, download: Downloader, progress: ModelsProgress = () => undefined): Promise<ModelPaths> {
  fs.mkdirSync(root, { recursive: true });
  let done = 0;
  for (const m of VOICE_MODELS) {
    if (verified(root, m)) { done += m.bytes; progress(done, VOICE_MODELS_BYTES); continue; }
    fs.rmSync(marker(root, m), { force: true });
    const base = done, share = m.kind === "file" ? 1 : DOWNLOAD_SHARE;
    const downloaded = Math.floor(m.bytes * share);
    // (A file has nothing to unpack, and its check is quick.)
    await fetchModel(root, m, download, bytes => progress(base + Math.min(downloaded, Math.floor(bytes * share)), VOICE_MODELS_BYTES),
      m.kind === "file" ? undefined : fraction => progress(base + downloaded + Math.floor((m.bytes - downloaded) * fraction * 0.99), VOICE_MODELS_BYTES, "unpacking"));
    fs.writeFileSync(marker(root, m), `${m.sha256}\n`);
    done += m.bytes;
    progress(done, VOICE_MODELS_BYTES);
  }
  return modelPaths(root);
}

/** Retries after a transient failure (a stall, a dropped connection, HTTP 408, 429 or 5xx), as curl --retry 3 did. */
const RETRIES = 3;
const REDIRECTS = 10;

/** A failure that may not happen again on a retry. */
const retryable = (message: string): boolean => /nothing arrived for|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED|EPIPE|socket hang up|HTTP (408|429|5\d\d)/.test(message);

/** How a downloader made by createHttpsDownloader behaves (the defaults are curl's old flags). */
export interface HttpsDownloaderOptions {
  /** A transfer that sends nothing for this long has stalled (ms; default 30 s). */
  stallMs?: number;
  /** The longest a whole download may take, retries included (ms; default 20 minutes). */
  totalMs?: number;
  /** The first retry's delay, doubling after each (ms; default 1 s). */
  retryMs?: number;
  /** Extra https.Agent options (tests pass a certificate authority). */
  agent?: https.AgentOptions;
}

/**
 * The certificate authorities curl trusted: the system's store, as well as Node's own list (with
 * NODE_EXTRA_CA_CERTS). Without the system's, a network that inspects TLS with a certificate IT installed
 * there would refuse the download where curl didn't. Undefined (Node's own list alone) on Node older than
 * 22.15, or if the store can't be read.
 */
function curlTrust(): string[] | undefined {
  try {
    if (typeof tls.getCACertificates !== "function") return undefined;
    return [...new Set([...tls.getCACertificates("default"), ...tls.getCACertificates("system")])];
  } catch {
    // The system's store couldn't be read: Node's own list still applies.
    return undefined;
  }
}

/**
 * A downloader on Node's https, for scripts and CI (the app passes its own, on Chromium's network stack).
 * It honours HTTPS_PROXY and NO_PROXY as curl did (Node 22.21+ and Electron's Node; older Node connects
 * directly), trusts the system's certificate authorities as curl did, follows redirects (to https only),
 * fails on an HTTP error, and retries a stalled or dropped transfer three times.
 */
export function createHttpsDownloader(options: HttpsDownloaderOptions = {}): Downloader {
  const stallMs = options.stallMs ?? 30_000;
  const totalMs = options.totalMs ?? 20 * 60_000;
  const retryMs = options.retryMs ?? 1000;
  let trust: string[] | undefined | null = null;

  /** One attempt: follows redirects and streams the body to `dest`, reporting bytes so far. */
  const attempt = async (url: string, dest: string, progress: (bytes: number) => void, deadline: number): Promise<void> => {
    const ac = new AbortController();
    let timer: NodeJS.Timeout | undefined;
    // Whether the whole download's time ran out, rather than the transfer stalling.
    let late = false;
    const alive = () => {
      clearTimeout(timer);
      const left = Math.max(0, deadline - Date.now());
      timer = setTimeout(() => {
        late = left < stallMs;
        ac.abort();
      }, Math.min(stallMs, left));
    };
    if (trust === null && !options.agent?.ca) trust = curlTrust();
    const agent = new https.Agent({ proxyEnv: process.env, ca: trust ?? undefined, ...options.agent });
    alive();
    try {
      let at = new URL(url);
      for (let hop = 0; ; hop++) {
        if (at.protocol !== "https:") throw new Error(`download failed: a redirect went to ${at.protocol} instead of https:`);
        const res = await new Promise<IncomingMessage>((resolve, reject) => {
          https.get(at, { agent, signal: ac.signal, headers: { "user-agent": "ember-voice-models" } }, resolve).on("error", reject);
        });
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (hop >= REDIRECTS) throw new Error("download failed: too many redirects");
          at = new URL(res.headers.location, at);
          continue;
        }
        if (status !== 200) {
          res.resume();
          throw new Error(`download failed: HTTP ${status}`);
        }
        let bytes = 0;
        const count = new Transform({
          transform(chunk: Buffer, _enc, done) {
            bytes += chunk.length;
            alive();
            progress(bytes);
            done(null, chunk);
          },
        });
        await pipeline(res, count, fs.createWriteStream(dest), { signal: ac.signal });
        return;
      }
    } catch (err) {
      if (!ac.signal.aborted) throw err;
      throw new Error(late ? `download failed: it took longer than ${totalMs / 1000} seconds` : `nothing arrived for ${stallMs / 1000} seconds (check the network or proxy)`, { cause: err });
    } finally {
      clearTimeout(timer);
      agent.destroy();
    }
  };

  return async (url, dest, progress) => {
    const deadline = Date.now() + totalMs;
    for (let tries = 0; ; tries++) {
      try {
        await attempt(url, dest, progress, deadline);
        return;
      } catch (err) {
        if (tries >= RETRIES || Date.now() >= deadline || !retryable(String((err as Error).message))) throw err;
        progress(0);
        await new Promise(resolve => setTimeout(resolve, retryMs * 2 ** tries));
      }
    }
  };
}

/** The scripts' downloader: createHttpsDownloader with curl's old limits (30 s stall, 3 retries, 20 minutes). */
export const httpsDownloader: Downloader = createHttpsDownloader();
