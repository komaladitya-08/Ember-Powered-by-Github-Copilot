/**
 * Speech models Ember downloads on first use (about 120 MB), each pinned to a
 * SHA-256, into ~/.config/ember/models. Nothing is used until it verifies.
 */

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ModelPaths } from "./sherpa";

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

export async function sha256File(file: string): Promise<string> {
  const h = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) h.update(chunk as Buffer);
  return h.digest("hex");
}

/** Makes every model present and verified; skips ones already in place. */
export async function ensureModels(root: string, download: Downloader, progress: (done: number, total: number) => void = () => undefined): Promise<ModelPaths> {
  fs.mkdirSync(root, { recursive: true });
  let done = 0;
  for (const m of VOICE_MODELS) {
    if (verified(root, m)) { done += m.bytes; progress(done, VOICE_MODELS_BYTES); continue; }
    fs.rmSync(marker(root, m), { force: true });
    const tmp = path.join(root, `.download-${path.basename(m.url)}`);
    const base = done;
    // Whatever happens, no partial download (or half-unpacked model) is left behind.
    try {
      await download(m.url, tmp, bytes => progress(base + bytes, VOICE_MODELS_BYTES));
      const got = await sha256File(tmp);
      if (got !== m.sha256) throw new Error(`${m.name}: checksum mismatch (got ${got.slice(0, 12)}…). The download was not used.`);
      if (m.kind === "file") {
        fs.renameSync(tmp, path.join(root, m.target));
      } else {
        fs.rmSync(path.join(root, m.target), { recursive: true, force: true });
        try {
          await new Promise<void>((resolve, reject) => execFile("tar", ["-xjf", tmp, "-C", root], err => (err ? reject(err) : resolve())));
        } catch (err) {
          fs.rmSync(path.join(root, m.target), { recursive: true, force: true });
          throw err;
        }
      }
    } finally {
      fs.rmSync(tmp, { force: true });
    }
    fs.writeFileSync(marker(root, m), `${m.sha256}\n`);
    done += m.bytes;
    progress(done, VOICE_MODELS_BYTES);
  }
  return modelPaths(root);
}

/** A downloader using curl (scripts and CI; honours the proxy environment). A transfer that stalls for 30 s fails. */
export const curlDownloader: Downloader = (url, dest) => new Promise((resolve, reject) => {
  execFile("curl", ["-sSfL", "--retry", "3", "--connect-timeout", "30", "--speed-limit", "1", "--speed-time", "30", "-o", dest, url], { timeout: 20 * 60_000 }, err => (err ? reject(err) : resolve()));
});
