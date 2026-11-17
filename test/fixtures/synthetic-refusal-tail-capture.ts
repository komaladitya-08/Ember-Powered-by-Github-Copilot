/**
 * Failure-only replay evidence for four literal public Ryan refusal fixtures under the fixed synthetic read-out.
 * Never called for real microphones, other test speech or native listening. Decoded words are reduced to shape only.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { types } from "node:util";
import { spokenAnswer } from "../../app/shared/spoken-answer";

export const SYNTHETIC_TAIL_DIRECTORY = "ember-synthetic-refusal-tail";
export const SYNTHETIC_TAIL_MAX_SAMPLES = 24 * 16_000;
export const SYNTHETIC_TAIL_MAX_INPUTS = 4;
const MAX_JSON = 16 * 1024;
const FIXTURES = new Map([
  ["Don't do it.", "dont-do-it"], ["No, don't do it.", "no-dont-do-it"],
  ["Don't allow it.", "dont-allow-it"], ["Do not allow it.", "do-not-allow-it"],
]);
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

/** Bounded owned bytes, copied before a recognizer can reuse its input. */
function copy(samples: unknown): Buffer | null {
  if (types.isProxy(samples) || !types.isFloat32Array(samples)) return null;
  const values = samples as Float32Array;
  if (!values.length || values.length > SYNTHETIC_TAIL_MAX_SAMPLES) return null;
  const bytes = Buffer.alloc(values.length * 4);
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) return null;
    bytes.writeFloatLE(values[i], i * 4);
  }
  return bytes;
}

function shape(text: unknown) {
  if (typeof text !== "string" || text.length > 4096) return null;
  return { polarity: spokenAnswer(text), characters: text.length, tokens: Math.min(text.trim().split(/\s+/).filter(Boolean).length, 64) };
}

/** Read only existing own data, never engine getters, calls or buffer contents. Unknown timing stays unknown. */
function state(engine: unknown) {
  const own = (name: string): unknown => {
    if (!engine || typeof engine !== "object" || types.isProxy(engine)) return undefined;
    const value = Object.getOwnPropertyDescriptor(engine, name);
    return value && "value" in value ? value.value : undefined;
  };
  const ms = (name: string) => { const value = own(name); return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 120_000 ? value : null; };
  const clipped = own("clipped"), tail = own("tail");
  return {
    clipped: typeof clipped === "boolean" ? clipped : null,
    hearFrom: ms("hearFrom"), soundFrom: ms("soundFrom"), tailFrom: ms("tailFrom"),
    selfSpeakingUntil: ms("selfSpeakingUntil"), fedAt: ms("fedAt"),
    tailFrames: !types.isProxy(tail) && Array.isArray(tail) && tail.length <= 64 ? tail.length : null,
  };
}

export interface SyntheticRefusalTailCapture {
  microphone(samples: unknown): void;
  input(samples: unknown, purpose: unknown, engine: unknown): number | undefined;
  decoded(index: number | undefined, text: unknown): void;
  emitted(text: unknown, engine: unknown): void;
  /** Single-use best effort, called only from the original bulk refusal assertion's catch. */
  failed(): boolean;
}

/** Exact fixture, backend and opt-in guards are diagnostic only; they never decide a voice answer. */
export function syntheticRefusalTailCapture(user: unknown, readout: unknown,
  trial: { text: string; on: number; window: "answer" | "follow-up"; stop: number },
  options: { enabled?: string; runnerTemp?: string; backend?: string }): SyntheticRefusalTailCapture | undefined {
  try {
    if (options.enabled !== "1" || options.backend !== "wasm" || typeof options.runnerTemp !== "string" || !path.isAbsolute(options.runnerTemp)) return undefined;
    const fixture = FIXTURES.get(trial.text);
    if (!fixture || ![-0.1, 0, 0.1, 0.2].includes(trial.on) || !["answer", "follow-up"].includes(trial.window) || !Number.isFinite(trial.stop) || trial.stop < 0 || trial.stop > 20) return undefined;
    const userBytes = copy(user), readoutBytes = copy(readout);
    if (!userBytes || !readoutBytes) return undefined;
    const parent = options.runnerTemp, directory = path.join(parent, SYNTHETIC_TAIL_DIRECTORY);
    const context = { fixture, onMs: trial.on * 1000, window: trial.window, stopSamples: Math.round(trial.stop * 16_000),
      asksFrame: Math.round(0.5 * 16_000 / 512), stopsFrame: Math.round(trial.stop * 16_000 / 512) };
    const inputs: { bytes: Buffer; state: ReturnType<typeof state>; words: ReturnType<typeof shape> }[] = [];
    let microphone: Buffer | null = null, emitted: { words: NonNullable<ReturnType<typeof shape>>; state: ReturnType<typeof state> } | undefined;
    let invalid = false, attempted = false;
    return {
      microphone(samples) {
        try { if (attempted || invalid) return; if (microphone) { invalid = true; return; } microphone = copy(samples); if (!microphone) invalid = true; }
        catch { invalid = true; }
      },
      input(samples, purpose, engine) {
        try {
          if (attempted || invalid || purpose !== "request") return undefined;
          if (inputs.length >= SYNTHETIC_TAIL_MAX_INPUTS) { invalid = true; return undefined; }
          const bytes = copy(samples); if (!bytes) { invalid = true; return undefined; }
          inputs.push({ bytes, state: state(engine), words: null });
          return inputs.length - 1;
        } catch { invalid = true; return undefined; }
      },
      decoded(index, text) {
        try {
          if (attempted || invalid || index === undefined) return;
          if (!Number.isInteger(index) || index < 0 || index >= inputs.length || inputs[index].words) { invalid = true; return; }
          inputs[index].words = shape(text); if (!inputs[index].words) invalid = true;
        } catch { invalid = true; }
      },
      emitted(text, engine) {
        try {
          if (attempted || invalid) return;
          const words = shape(text); if (!words) { invalid = true; return; }
          if (words.polarity === "allow") emitted ??= { words, state: state(engine) };
        } catch { invalid = true; }
      },
      failed() {
        if (attempted) return false;
        attempted = true;
        try {
          if (invalid || !microphone || !emitted || !inputs.length || inputs.some(input => !input.words)) return false;
          const audio = (file: string, bytes: Buffer) => ({ file, samples: bytes.length / 4, sha256: sha256(bytes) });
          const facts = { schema: 1, source: "public-piper-ryan-refusal-tail-fixtures", backend: "wasm", sampleRate: 16000,
            sampleFormat: "float32-le", frameSamples: 512, roomNoiseSeed: 5, expectedPolarity: "deny", ...context,
            user: audio("synthetic-tail-user.f32le", userBytes), readout: audio("synthetic-tail-readout.f32le", readoutBytes),
            microphone: audio("synthetic-tail-mic.f32le", microphone),
            decodes: inputs.map((input, i) => ({ ...audio(`synthetic-tail-asr-${i + 1}.f32le`, input.bytes), purpose: "request", ...input.words, state: input.state })),
            emitted: { ...emitted.words, state: emitted.state } };
          const json = Buffer.from(JSON.stringify(facts, null, 2) + "\n", "utf8");
          if (json.length > MAX_JSON) return false;
          const root = fs.lstatSync(parent); if (!root.isDirectory() || root.isSymbolicLink()) return false;
          // Fresh fixed namespace only. Never overwrite, repair, delete or retry partial evidence.
          fs.mkdirSync(directory, { mode: 0o700 });
          const write = (file: string, bytes: Buffer) => fs.writeFileSync(path.join(directory, file), bytes, { flag: "wx", mode: 0o600 });
          write("synthetic-tail-user.f32le", userBytes); write("synthetic-tail-readout.f32le", readoutBytes); write("synthetic-tail-mic.f32le", microphone);
          for (let i = 0; i < inputs.length; i++) write(`synthetic-tail-asr-${i + 1}.f32le`, inputs[i].bytes);
          write("facts.json", json);
          return true;
        } catch { return false; }
      },
    };
  } catch { return undefined; }
}
