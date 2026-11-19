import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { syntheticNoCapture, SYNTHETIC_NO_DIRECTORY, SYNTHETIC_NO_MAX_INPUTS, SYNTHETIC_NO_MAX_SAMPLES } from "../fixtures/synthetic-no-capture";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const root = () => { const value = fs.mkdtempSync(path.join(os.tmpdir(), "ember-synthetic-no-unit-")); roots.push(value); return value; };
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const mic = () => new Float32Array([0, 0.5, -0.25, 0.125]);
function setup() {
  const parent = root(), directory = path.join(parent, SYNTHETIC_NO_DIRECTORY);
  const capture = syntheticNoCapture(mic(), { enabled: "1", runnerTemp: parent })!;
  return { parent, directory, capture };
}

it("does no filesystem work without exact opt-in and an absolute runner temp directory", () => {
  const stat = vi.spyOn(fs, "lstatSync"), mkdir = vi.spyOn(fs, "mkdirSync");
  for (const enabled of [undefined, "0", "true", " 1", "1 "]) expect(syntheticNoCapture(mic(), { enabled, runnerTemp: "/fixed" })).toBeUndefined();
  for (const runnerTemp of [undefined, "", "relative"]) expect(syntheticNoCapture(mic(), { enabled: "1", runnerTemp })).toBeUndefined();
  expect(stat).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled();
});

it("writes nothing for successful denial or an unrelated assertion without a captured emitted mismatch", () => {
  for (const emitted of [undefined, "No."]) {
    const value = setup(); value.capture.decoded(mic(), "request", "No.");
    if (emitted) value.capture.emitted(emitted, true);
    expect(value.capture.failed()).toBe(false); expect(fs.existsSync(value.directory)).toBe(false);
  }
});

it("copies exact finite Float32 values as little-endian bytes and writes only closed facts on failure", () => {
  const parent = root(), directory = path.join(parent, SYNTHETIC_NO_DIRECTORY);
  const microphone = mic(), input = new Float32Array([0.75, -0.5]);
  const capture = syntheticNoCapture(microphone, { enabled: "1", runnerTemp: parent })!;
  capture.decoded(input, "request", "Yep."); capture.emitted("Yep.", true);
  microphone.fill(99); input.fill(99);
  expect(fs.existsSync(directory)).toBe(false); expect(capture.failed()).toBe(true);
  expect(fs.readdirSync(directory).sort()).toEqual(["facts.json", "synthetic-no-asr-1.f32le", "synthetic-no-mic.f32le"]);
  const micBytes = fs.readFileSync(path.join(directory, "synthetic-no-mic.f32le")), asrBytes = fs.readFileSync(path.join(directory, "synthetic-no-asr-1.f32le"));
  expect(Array.from({ length: micBytes.length / 4 }, (_, index) => micBytes.readFloatLE(index * 4))).toEqual([0, 0.5, -0.25, 0.125]);
  expect([asrBytes.readFloatLE(0), asrBytes.readFloatLE(4)]).toEqual([0.75, -0.5]);
  const text = fs.readFileSync(path.join(directory, "facts.json"), "utf8"), facts = JSON.parse(text);
  expect(facts).toEqual({ schema: 1, source: "public-piper-ryan-bare-no-test-fixture", sampleRate: 16000, sampleFormat: "float32-le", expectedPolarity: "deny",
    microphone: { file: "synthetic-no-mic.f32le", samples: 4, sha256: sha256(micBytes) },
    decodes: [{ file: "synthetic-no-asr-1.f32le", purpose: "request", samples: 2, sha256: sha256(asrBytes), polarity: "allow", characters: 4, tokens: 1 }],
    emitted: { polarity: "allow", characters: 4, tokens: 1, cachePresent: true } });
  expect(text).not.toContain("Yep"); expect(text).not.toContain(parent); expect(Buffer.byteLength(text)).toBeLessThanOrEqual(16 * 1024);
  expect(capture.failed()).toBe(false);
});

it("ignores keyword and unspecified calls and caps existing request inputs at four", () => {
  const value = setup(); value.capture.decoded(mic(), "keyword", "secret words"); value.capture.decoded(mic(), undefined, "secret words");
  for (let i = 0; i < SYNTHETIC_NO_MAX_INPUTS; i++) value.capture.decoded(mic(), "request", "Yep.");
  value.capture.emitted("Yep.", null); expect(value.capture.failed()).toBe(true);
  expect(fs.readdirSync(value.directory).sort()).toEqual(["facts.json", "synthetic-no-asr-1.f32le", "synthetic-no-asr-2.f32le", "synthetic-no-asr-3.f32le", "synthetic-no-asr-4.f32le", "synthetic-no-mic.f32le"]);
  const overflow = setup(); for (let i = 0; i <= SYNTHETIC_NO_MAX_INPUTS; i++) overflow.capture.decoded(mic(), "request", "Yep.");
  overflow.capture.emitted("Yep.", false); expect(overflow.capture.failed()).toBe(false); expect(fs.existsSync(overflow.directory)).toBe(false);
});

it("bounds every audio buffer before copying and refuses nonfinite, foreign and proxy data", () => {
  const parent = root(), trapped = vi.fn(() => { throw new Error("must not read a proxy"); });
  const proxy = new Proxy(mic(), { get: trapped });
  for (const value of [new Float32Array(), new Float32Array(SYNTHETIC_NO_MAX_SAMPLES + 1), new Float32Array([NaN]), new Float32Array([Infinity]), new Uint8Array([1]), proxy]) {
    expect(syntheticNoCapture(value, { enabled: "1", runnerTemp: parent })).toBeUndefined();
  }
  expect(trapped).not.toHaveBeenCalled(); expect(fs.readdirSync(parent)).toEqual([]);
  const maximum = syntheticNoCapture(new Float32Array(SYNTHETIC_NO_MAX_SAMPLES), { enabled: "1", runnerTemp: parent })!;
  maximum.decoded(new Float32Array(SYNTHETIC_NO_MAX_SAMPLES), "request", "Yep."); maximum.emitted("Yep.", false); expect(maximum.failed()).toBe(true);
  expect(fs.statSync(path.join(parent, SYNTHETIC_NO_DIRECTORY, "synthetic-no-mic.f32le")).size).toBe(SYNTHETIC_NO_MAX_SAMPLES * 4);
});

it("contains malformed decoder evidence instead of capturing an unbounded or coerced transcript", () => {
  for (const text of ["x".repeat(4097), { toString: () => { throw new Error("private text"); } }]) {
    const value = setup(); value.capture.decoded(mic(), "request", text); value.capture.emitted("Yep.", false);
    expect(value.capture.failed()).toBe(false); expect(fs.existsSync(value.directory)).toBe(false);
  }
});

it("never follows or replaces an existing capture namespace", () => {
  const value = setup(); fs.mkdirSync(value.directory); fs.writeFileSync(path.join(value.directory, "keep"), "owned elsewhere");
  value.capture.decoded(mic(), "request", "Yep."); value.capture.emitted("Yep.", true);
  expect(value.capture.failed()).toBe(false); expect(fs.readdirSync(value.directory)).toEqual(["keep"]);
});

it("refuses a symlink runner temp or capture namespace without writing its target", () => {
  const parent = root(), target = root(), linked = path.join(parent, "linked"), kind = process.platform === "win32" ? "junction" : "dir"; fs.symlinkSync(target, linked, kind);
  const capture = syntheticNoCapture(mic(), { enabled: "1", runnerTemp: linked })!;
  capture.decoded(mic(), "request", "Yep."); capture.emitted("Yep.", true); expect(capture.failed()).toBe(false); expect(fs.readdirSync(target)).toEqual([]);
  const value = setup(); fs.symlinkSync(target, value.directory, kind); value.capture.decoded(mic(), "request", "Yep."); value.capture.emitted("Yep.", true);
  expect(value.capture.failed()).toBe(false); expect(fs.readdirSync(target)).toEqual([]);
});

it("contains filesystem observer faults and does not retry or delete partial evidence", () => {
  const value = setup(); value.capture.decoded(mic(), "request", "Yep."); value.capture.emitted("Yep.", true);
  vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("private filesystem cause"); });
  expect(value.capture.failed()).toBe(false); expect(value.capture.failed()).toBe(false); expect(fs.readdirSync(value.directory)).toEqual([]);
});

const source = fs.readFileSync("test/integration/voice.test.ts", "utf8");
it("the actual decoder wrapper snapshots its input before exactly one original call and contains observer faults", () => {
  const asked = source.indexOf("    const asked = (audio: Float32Array, capture?: SyntheticNoCapture) => {"),
    begins = source.indexOf("      backend.transcribe = (x, purpose) => {", asked), ends = source.indexOf("      try {", source.indexOf("      };", begins));
  expect(asked).toBeGreaterThan(0); expect(ends).toBeGreaterThan(begins);
  const code = source.slice(begins, ends).replace("let input: Float32Array | undefined;", "let input;");
  for (const observerFault of [false, true]) {
    const input = mic(), backend = { transcribe: undefined as unknown as (audio: Float32Array, purpose: string) => string }, written: string[] = [];
    const call = vi.fn((audio: Float32Array) => { audio.fill(7); return "Yep."; });
    const decoded = vi.fn((audio: Float32Array) => { expect([...audio]).toEqual([0, 0.5, -0.25, 0.125]); if (observerFault) throw new Error("observer failure"); });
    runInNewContext(code, { backend, transcribe: call, capture: { decoded }, written, SYNTHETIC_NO_MAX_SAMPLES });
    expect(backend.transcribe(input, "request")).toBe("Yep."); expect(call).toHaveBeenCalledExactlyOnceWith(input, "request");
    expect(decoded).toHaveBeenCalledOnce(); expect(written).toEqual(["Yep."]); expect([...input]).toEqual([7, 7, 7, 7]);
  }
});

it("the actual fixed-source guard creates no capture for any other original answer or room audio", () => {
  const begins = source.indexOf('        const capture = text === "No."'), ends = source.indexOf("        const { events, written }", begins);
  expect(begins).toBeGreaterThan(0); const code = source.slice(begins, ends) + " result = capture;";
  for (const [text, answer, count] of [["No.", "deny", 1], ["No.", "allow", 0], ["No", "deny", 0], ["Not now.", "deny", 0], ["Allow it.", "allow", 0], ["room talk", "deny", 0]]) {
    const factory = vi.fn(() => ({})); runInNewContext(code, { text, answer, audio: mic(), process: { env: {} }, syntheticNoCapture: factory }); expect(factory).toHaveBeenCalledTimes(count as number);
  }
});

it("the actual polarity assertion catch rethrows the identical original error even if its observer throws", () => {
  const begins = source.indexOf("        for (const e of u) {"), ends = source.indexOf("        // No conversation opens", begins);
  expect(begins).toBeGreaterThan(0); const code = source.slice(begins, ends), original = new Error("original polarity assertion");
  for (const fail of [false, true]) {
    const failed = vi.fn(() => { if (fail) throw new Error("observer failure"); });
    const run = () => runInNewContext(code, { u: [{ text: "Yep." }], text: "No.", answer: "deny", spokenAnswer: () => "allow",
      capture: { failed }, expect: () => ({ toBe: () => { throw original; } }) });
    try { run(); throw new Error("original assertion was swallowed"); } catch (error) { expect(error).toBe(original); }
    expect(failed).toHaveBeenCalledOnce();
  }
});

it("workflow upload is failure-only, pinned, and names only the six bounded fixed-fixture files", () => {
  const workflow = fs.readFileSync(".github/workflows/ci.yml", "utf8");
  const blocks = workflow.split("      - name: Preserve fixed synthetic No polarity failure evidence\n").slice(1).map(block => block.slice(0, block.indexOf("      - name:")));
  expect(blocks).toHaveLength(2);
  for (const block of blocks) {
    expect(block).toContain("failure() && !cancelled() && steps.speech.outcome == 'failure'");
    expect(block).toContain("actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9");
    const files = [...block.matchAll(/\$\{\{ runner.temp \}\}\/ember-synthetic-no-polarity\/(\S+)/g)].map(match => match[1]);
    expect(files).toEqual(["facts.json", "synthetic-no-mic.f32le", "synthetic-no-asr-1.f32le", "synthetic-no-asr-2.f32le", "synthetic-no-asr-3.f32le", "synthetic-no-asr-4.f32le"]);
  }
});
