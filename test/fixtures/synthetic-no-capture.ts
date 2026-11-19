/**
 * Failure evidence for one public test-generated Ryan "No." clip only. Never microphone audio or transcript text.
 * The caller creates this only beside that literal fixture synthesis and calls failed only from its polarity assert.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { types } from "node:util";
import { spokenAnswer } from "../../app/shared/spoken-answer";

export const SYNTHETIC_NO_DIRECTORY = "ember-synthetic-no-polarity";
export const SYNTHETIC_NO_MAX_SAMPLES = 8 * 16_000;
export const SYNTHETIC_NO_MAX_INPUTS = 4;
const MAX_JSON = 16 * 1024;
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** A copy with explicit byte order, bounded before allocation; recognizer-owned buffers may be reused afterwards. */
function copy(samples: unknown): Buffer | null {
  if (types.isProxy(samples) || !types.isFloat32Array(samples)) return null;
  const values = samples as Float32Array;
  if (!values.length || values.length > SYNTHETIC_NO_MAX_SAMPLES) return null;
  const bytes = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) return null;
    bytes.writeFloatLE(values[i], i * 4);
  }
  return bytes;
}

function shape(text: unknown) {
  if (typeof text !== "string" || text.length > 4096) return null;
  const tokens = text.trim().split(/\s+/).filter(Boolean).length;
  return { polarity: spokenAnswer(text), characters: text.length, tokens: Math.min(tokens, 64) };
}

export interface SyntheticNoCapture {
  decoded(samples: unknown, purpose: unknown, text: unknown): void;
  emitted(text: unknown, cachePresent: boolean | null): void;
  /** Best effort and single-use; every observer fault preserves the original assertion error. */
  failed(): boolean;
}

export function syntheticNoCapture(mic: unknown, options: { enabled?: string; runnerTemp?: string }): SyntheticNoCapture | undefined {
  try {
    if (options.enabled !== "1" || typeof options.runnerTemp !== "string" || !path.isAbsolute(options.runnerTemp)) return undefined;
    const microphone = copy(mic);
    if (!microphone) return undefined;
    const parent = options.runnerTemp;
    const directory = path.join(parent, SYNTHETIC_NO_DIRECTORY);
    const inputs: { bytes: Buffer; shape: NonNullable<ReturnType<typeof shape>> }[] = [];
    let emitted: (NonNullable<ReturnType<typeof shape>> & { cachePresent: boolean | null }) | undefined;
    let invalid = false, attempted = false;
    return {
      decoded(samples, purpose, text) {
        try {
          // Only existing request recognitions of the fixed clip; keyword/model warm-up inputs never enter evidence.
          if (attempted || invalid || purpose !== "request") return;
          if (inputs.length >= SYNTHETIC_NO_MAX_INPUTS) { invalid = true; return; }
          const bytes = copy(samples), words = shape(text);
          if (!bytes || !words) { invalid = true; return; }
          inputs.push({ bytes, shape: words });
        } catch { invalid = true; }
      },
      emitted(text, cachePresent) {
        try {
          if (attempted || invalid) return;
          const words = shape(text);
          if (!words || cachePresent !== null && typeof cachePresent !== "boolean") { invalid = true; return; }
          emitted = { ...words, cachePresent };
        } catch { invalid = true; }
      },
      failed() {
        if (attempted) return false;
        attempted = true;
        try {
          if (invalid || !emitted || emitted.polarity === "deny" || !inputs.length) return false;
          const facts = {
            schema: 1, source: "public-piper-ryan-bare-no-test-fixture", sampleRate: 16000, sampleFormat: "float32-le",
            expectedPolarity: "deny", microphone: { file: "synthetic-no-mic.f32le", samples: microphone.length / 4, sha256: sha256(microphone) },
            decodes: inputs.map((input, index) => ({ file: `synthetic-no-asr-${index + 1}.f32le`, purpose: "request",
              samples: input.bytes.length / 4, sha256: sha256(input.bytes), ...input.shape })),
            emitted,
          };
          const json = Buffer.from(JSON.stringify(facts, null, 2) + "\n", "utf8");
          if (json.length > MAX_JSON) return false;
          const root = fs.lstatSync(parent);
          if (!root.isDirectory() || root.isSymbolicLink()) return false;
          // A fresh owned namespace only: never remove, repair, follow or overwrite an existing directory or file.
          fs.mkdirSync(directory, { mode: 0o700 });
          const write = (name: string, bytes: Buffer) => fs.writeFileSync(path.join(directory, name), bytes, { flag: "wx", mode: 0o600 });
          write("synthetic-no-mic.f32le", microphone);
          for (let i = 0; i < inputs.length; i++) write(`synthetic-no-asr-${i + 1}.f32le`, inputs[i].bytes);
          write("facts.json", json);
          return true;
        } catch { return false; }
      },
    };
  } catch { return undefined; }
}
