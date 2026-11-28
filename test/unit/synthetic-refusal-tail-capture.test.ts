/** Fixed synthetic replay diagnostics must preserve voice behavior and never retain decoded words or real input. */
import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { transformSync } from "esbuild";
import { syntheticRefusalTailCapture, SYNTHETIC_TAIL_DIRECTORY, SYNTHETIC_TAIL_MAX_INPUTS, SYNTHETIC_TAIL_MAX_SAMPLES } from "../fixtures/synthetic-refusal-tail-capture";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
const root = () => { const value = fs.mkdtempSync(path.join(os.tmpdir(), "ember-synthetic-tail-unit-")); roots.push(value); return value; };
const audio = () => new Float32Array([0, 0.5, -0.25, 0.125]);
const trial = () => ({ text: "Don't do it.", on: 0.2, window: "follow-up" as const, stop: 4.2 });
const state = () => ({ clipped: true, hearFrom: 4000, soundFrom: 3904, tailFrom: 4000, selfSpeakingUntil: 4400, fedAt: 4800, tail: [{}, {}] });
const sha256 = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
function setup() {
  const parent = root(), directory = path.join(parent, SYNTHETIC_TAIL_DIRECTORY), user = audio(), readout = audio();
  const capture = syntheticRefusalTailCapture(user, readout, trial(), { enabled: "1", backend: "wasm", runnerTemp: parent })!;
  const microphone = audio(); capture.microphone(microphone);
  return { parent, directory, user, readout, microphone, capture };
}
function bad(value: ReturnType<typeof setup>) {
  const input = audio(), engine = state(), index = value.capture.input(input, "request", engine);
  value.capture.decoded(index, "Yep."); value.capture.emitted("Yep.", engine);
  return { input, engine };
}

it("requires exact opt-in, forced WASM, an absolute output parent and one literal negative trial", () => {
  const parent = root();
  for (const options of [{}, { enabled: "true", backend: "wasm", runnerTemp: parent }, { enabled: "1", runnerTemp: parent },
    { enabled: "1", backend: "native", runnerTemp: parent }, { enabled: "1", backend: "wasm", runnerTemp: "relative" }]) {
    expect(syntheticRefusalTailCapture(audio(), audio(), trial(), options)).toBeUndefined();
  }
  for (const changed of [{ text: "No." }, { text: "microphone words" }, { text: "Don't do it" }, { on: 0.3 }, { on: NaN }, { stop: Infinity }, { stop: 21 }, { window: "manual" }]) {
    expect(syntheticRefusalTailCapture(audio(), audio(), { ...trial(), ...changed } as ReturnType<typeof trial>, { enabled: "1", backend: "wasm", runnerTemp: parent })).toBeUndefined();
  }
  expect(fs.readdirSync(parent)).toEqual([]);
});

it("writes nothing for passing denials, an unrelated failed assertion, incomplete or no recognition", () => {
  const cases = [setup(), setup(), setup(), setup()];
  for (const [i, value] of cases.entries()) {
    const index = value.capture.input(audio(), "request", state());
    if (i !== 2) value.capture.decoded(index, "No.");
    if (i === 0) value.capture.emitted("No.", state());
    if (i === 2) value.capture.emitted("Yep.", state());
    if (i === 3) continue; // No original assertion failure means failed() is never called.
    expect(value.capture.failed()).toBe(false); expect(value.capture.failed()).toBe(false);
  }
  for (const value of cases) expect(fs.readdirSync(value.parent)).toEqual([]);
});

it("owns exact replay bytes and captures only bounded classes and cached scalar state, with fixed private files", () => {
  const value = setup(), { input, engine } = bad(value);
  value.user.fill(9); value.readout.fill(8); value.microphone.fill(7); input.fill(6); engine.clipped = false; engine.fedAt = 9999;
  const writes = vi.spyOn(fs, "writeFileSync"), mkdir = vi.spyOn(fs, "mkdirSync");
  expect(value.capture.failed()).toBe(true); expect(value.capture.failed()).toBe(false);
  const files = ["facts.json", "synthetic-tail-user.f32le", "synthetic-tail-readout.f32le", "synthetic-tail-mic.f32le", "synthetic-tail-asr-1.f32le"];
  expect(fs.readdirSync(value.directory).sort()).toEqual(files.sort());
  const bytes = fs.readFileSync(path.join(value.directory, "synthetic-tail-asr-1.f32le"));
  expect([...Array(4)].map((_, i) => bytes.readFloatLE(i * 4))).toEqual([...audio()]);
  for (const file of files.filter(file => file.endsWith("f32le"))) expect(fs.readFileSync(path.join(value.directory, file))).toEqual(bytes);
  const text = fs.readFileSync(path.join(value.directory, "facts.json"), "utf8"), facts = JSON.parse(text);
  expect(text.length).toBeLessThan(16 * 1024); expect(text).not.toContain("Yep"); expect(text).not.toContain("Don't"); expect(text).not.toContain(value.parent);
  expect(facts).toMatchObject({ source: "public-piper-ryan-refusal-tail-fixtures", backend: "wasm", fixture: "dont-do-it", onMs: 200,
    window: "follow-up", stopSamples: 67200, asksFrame: 16, stopsFrame: 131, frameSamples: 512, roomNoiseSeed: 5,
    user: { samples: 4, sha256: sha256(bytes) }, emitted: { polarity: "allow", characters: 4, tokens: 1, state: stateFacts() },
    decodes: [{ purpose: "request", samples: 4, polarity: "allow", state: stateFacts() }] });
  expect(writes).toHaveBeenCalledTimes(files.length);
  for (const call of writes.mock.calls) expect(call[2]).toEqual({ flag: "wx", mode: 0o600 });
  expect(mkdir).toHaveBeenCalledExactlyOnceWith(value.directory, { mode: 0o700 });
});
function stateFacts() { return { clipped: true, hearFrom: 4000, soundFrom: 3904, tailFrom: 4000, selfSpeakingUntil: 4400, fedAt: 4800, tailFrames: 2 }; }

it("never reads engine accessors or proxies and keeps unobserved or infinite scalar state unknown", () => {
  for (const engine of [new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("must not trap"); } }),
    Object.defineProperty({ clipped: false, hearFrom: -Infinity, fedAt: 999999 }, "tailFrom", { get() { throw new Error("must not call"); } })]) {
    const value = setup(), index = value.capture.input(audio(), "request", engine);
    value.capture.decoded(index, "Yep."); value.capture.emitted("Yep.", engine);
    expect(value.capture.failed()).toBe(true);
    const facts = JSON.parse(fs.readFileSync(path.join(value.directory, "facts.json"), "utf8"));
    expect(facts.decodes[0].state.tailFrom).toBeNull(); expect(facts.decodes[0].state.hearFrom).toBeNull(); expect(facts.decodes[0].state.fedAt).toBeNull();
  }
});

it("caps decoded inputs, rejects unsafe buffers and never writes overflow or duplicate observations", () => {
  const badAudio: unknown[] = [new Float32Array(), new Float32Array(SYNTHETIC_TAIL_MAX_SAMPLES + 1), new Float32Array([NaN]), new Float32Array([Infinity]),
    new Uint8Array([1]), new Proxy(audio(), { get() { throw new Error("must not trap"); } })];
  for (const samples of badAudio) {
    expect(syntheticRefusalTailCapture(samples, audio(), trial(), { enabled: "1", backend: "wasm", runnerTemp: root() })).toBeUndefined();
    const value = setup(); value.capture.input(samples, "request", state()); value.capture.emitted("Yep.", state()); expect(value.capture.failed()).toBe(false);
  }
  const overflow = setup();
  for (let i = 0; i <= SYNTHETIC_TAIL_MAX_INPUTS; i++) overflow.capture.decoded(overflow.capture.input(audio(), "request", state()), "Yep.");
  overflow.capture.emitted("Yep.", state()); expect(overflow.capture.failed()).toBe(false);
  const duplicate = setup(); bad(duplicate); duplicate.capture.microphone(audio()); expect(duplicate.capture.failed()).toBe(false);
  const decodedTwice = setup(); bad(decodedTwice); decodedTwice.capture.decoded(0, "Yep."); expect(decodedTwice.capture.failed()).toBe(false);
});

it("ignores warmup/keyword inputs and admits every fixed refusal/window/offset without extra source text", () => {
  for (const text of ["Don't do it.", "No, don't do it.", "Don't allow it.", "Do not allow it."]) for (const window of ["answer", "follow-up"] as const) for (const on of [-0.1, 0, 0.1, 0.2]) {
    const parent = root(), capture = syntheticRefusalTailCapture(audio(), audio(), { text, on, window, stop: 4 }, { enabled: "1", backend: "wasm", runnerTemp: parent })!;
    capture.microphone(audio()); expect(capture.input(new Float32Array([NaN]), "keyword", state())).toBeUndefined();
    capture.decoded(capture.input(audio(), "request", state()), "Yep."); capture.emitted("Yep.", state()); expect(capture.failed()).toBe(true);
    expect(fs.readFileSync(path.join(parent, SYNTHETIC_TAIL_DIRECTORY, "facts.json"), "utf8")).not.toContain(text);
  }
});

it("preserves existing destinations, refuses linked parents and contains filesystem faults without retry", () => {
  const value = setup(); bad(value); fs.mkdirSync(value.directory); fs.writeFileSync(path.join(value.directory, "sentinel"), "owned elsewhere");
  expect(value.capture.failed()).toBe(false); expect(fs.readFileSync(path.join(value.directory, "sentinel"), "utf8")).toBe("owned elsewhere");
  const parent = root(), linked = path.join(root(), "linked"); fs.symlinkSync(parent, linked, process.platform === "win32" ? "junction" : "dir");
  const capture = syntheticRefusalTailCapture(audio(), audio(), trial(), { enabled: "1", backend: "wasm", runnerTemp: linked })!;
  capture.microphone(audio()); capture.decoded(capture.input(audio(), "request", state()), "Yep."); capture.emitted("Yep.", state()); expect(capture.failed()).toBe(false); expect(fs.readdirSync(parent)).toEqual([]);
  const fault = setup(); bad(fault); const writes = vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("private I/O cause"); });
  expect(fault.capture.failed()).toBe(false); expect(fault.capture.failed()).toBe(false); expect(writes).toHaveBeenCalledOnce(); expect(fs.readdirSync(fault.directory)).toEqual([]);
});

const source = fs.readFileSync("test/integration/voice.test.ts", "utf8");
const target = source.slice(source.indexOf('  it.skipIf(noReader)("never takes a refusal said as Ember stops'), source.indexOf('\n  /**', source.indexOf('  it.skipIf(noReader)("never takes a refusal said as Ember stops')));
it("actual request wrapper observes before exactly one original recognition and preserves the same return/error", () => {
  const begins = target.indexOf("      backend.transcribe = (x, purpose) => {"), ends = target.indexOf("      try {\n        s.engine.questionUp", begins);
  expect(begins).toBeGreaterThan(0); expect(ends).toBeGreaterThan(begins);
  const code = transformSync(target.slice(begins, ends), { loader: "ts", format: "cjs", target: "node22" }).code;
  for (const observerFault of [false, true]) for (const failure of [false, true]) {
    const original = new Error("original recognition error"), input = audio(), written: string[] = [], backend = { transcribe: undefined as unknown as (x: Float32Array, purpose: string) => string };
    const call = vi.fn((x: Float32Array) => { x.fill(7); if (failure) throw original; return "Yep."; });
    const observed = vi.fn((x: Float32Array) => { expect([...x]).toEqual([...audio()]); if (observerFault) throw new Error("observer error"); return 0; });
    const decoded = vi.fn(() => { if (observerFault) throw new Error("observer error"); });
    runInNewContext(code, { backend, transcribe: call, written, s: { engine: state() }, capture: { input: observed, decoded } });
    if (failure) expect(() => backend.transcribe(input, "request")).toThrow(original); else expect(backend.transcribe(input, "request")).toBe("Yep.");
    expect(call).toHaveBeenCalledExactlyOnceWith(input, "request"); expect(observed).toHaveBeenCalledOnce(); expect(decoded).toHaveBeenCalledTimes(failure ? 0 : 1); expect(written).toEqual(failure ? [] : ["Yep."]);
  }
});

it("actual assertion observation cannot replace the original assertion or write on a pass", () => {
  const begins = target.indexOf("    try { expect(taken).toEqual([]); }"), ends = target.indexOf('    // Begun after a moment', begins);
  const code = target.slice(begins, ends), original = new Error("original refusal assert"); expect(begins).toBeGreaterThan(0);
  for (const observerFault of [false, true]) for (const fail of [false, true]) {
    const failed = vi.fn(() => { if (observerFault) throw new Error("observer error"); });
    const run = () => runInNewContext(code, { taken: [], refusalEvidence: { failed }, expect: () => ({ toEqual() { if (fail) throw original; } }) });
    if (fail) expect(run).toThrow(original); else expect(run).not.toThrow(); expect(failed).toHaveBeenCalledTimes(fail ? 1 : 0);
  }
});

it("only the negative loop passes a literal fixture; positives keep their original ASR/TTS path and budgets", () => {
  expect(target.match(/syntheticRefusalTailCapture\(/g)).toHaveLength(1);
  expect(target).toContain('fixture && speech && !refusalEvidence ? syntheticRefusalTailCapture');
  expect(target).toContain('backend: process.env.EMBER_VOICE_BACKEND');
  expect(target.match(/heard\(speech, on, window, text\)/g)).toHaveLength(1);
  expect(target).toContain('heardWritten(voiced(text, 0.1), 0.3)');
  expect(target).toContain('expect(heard(null, 0).filter');
  expect(target).toContain('}, 180_000);');
});

it("EL8 upload uses only fixed bounded replay files, only after the unchanged speech step fails", () => {
  const workflow = fs.readFileSync(".github/workflows/ci.yml", "utf8");
  expect(workflow.match(/EMBER_SYNTHETIC_TAIL_CAPTURE: "1"/g)).toHaveLength(1);
  const marker = "      - name: Preserve fixed synthetic refusal-tail failure evidence\n", at = workflow.indexOf(marker), end = workflow.indexOf("      - run: npm run build", at), block = workflow.slice(at, end);
  expect(at).toBeGreaterThan(workflow.indexOf("  el8:")); expect(at).toBeLessThan(workflow.indexOf("  package:"));
  expect(block).toContain("failure() && !cancelled() && steps.speech.outcome == 'failure'");
  expect(block).toContain("actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9"); expect(block).toContain("retention-days: 3");
  expect([...block.matchAll(/\$\{\{ runner.temp \}\}\/ember-synthetic-refusal-tail\/(\S+)/g)].map(match => match[1])).toEqual([
    "facts.json", "synthetic-tail-user.f32le", "synthetic-tail-readout.f32le", "synthetic-tail-mic.f32le", ...[1, 2, 3, 4].map(i => `synthetic-tail-asr-${i}.f32le`),
  ]);
  expect(block).not.toMatch(/\*|private|log|transcript/);
  const speech = workflow.slice(workflow.lastIndexOf("      - name: Speech on RHEL", at), at);
  expect(speech).toContain('EMBER_VOICE_BACKEND=wasm npm run test:integration -- test/integration/voice.test.ts');
  expect(speech).toContain('EMBER_KITTEN_TEST=1 EMBER_SHERPA_CAPI="$(node scripts/voice/fetch-capi.mjs)" npm run test:integration -- test/integration/voice.test.ts');
});

it("accepts the exact audio bound and rejects malformed decoded words without serialization", () => {
  const maximum = new Float32Array(SYNTHETIC_TAIL_MAX_SAMPLES), parent = root();
  const capture = syntheticRefusalTailCapture(maximum, maximum, trial(), { enabled: "1", backend: "wasm", runnerTemp: parent })!;
  capture.microphone(maximum); capture.decoded(capture.input(maximum, "request", state()), "Yep."); capture.emitted("Yep.", state()); expect(capture.failed()).toBe(true);
  expect(fs.statSync(path.join(parent, SYNTHETIC_TAIL_DIRECTORY, "synthetic-tail-asr-1.f32le")).size).toBe(SYNTHETIC_TAIL_MAX_SAMPLES * 4);
  for (const text of ["x".repeat(4097), { toString() { throw new Error("private words"); } }]) {
    const value = setup(); value.capture.decoded(value.capture.input(audio(), "request", state()), text); value.capture.emitted("Yep.", state());
    expect(value.capture.failed()).toBe(false); expect(fs.readdirSync(value.parent)).toEqual([]);
  }
});

it("removing only the declared diagnostic hooks recovers the entire original voice file and EL8 workflow", () => {
  const replacements: [string, string][] = [
    ['import { syntheticRefusalTailCapture, type SyntheticRefusalTailCapture } from "../fixtures/synthetic-refusal-tail-capture";\n', ""],
    ['    let refusalEvidence: SyntheticRefusalTailCapture | undefined;\n', ""],
    ['window: "answer" | "follow-up" = "answer", fixture?: string) => {', 'window: "answer" | "follow-up" = "answer") => {'],
    [`      const capture = fixture && speech && !refusalEvidence ? syntheticRefusalTailCapture(speech, own, { text: fixture, on, window, stop },
        { enabled: process.env.EMBER_SYNTHETIC_TAIL_CAPTURE, runnerTemp: process.env.RUNNER_TEMP, backend: process.env.EMBER_VOICE_BACKEND }) : undefined;
      const s = session({ onUtterance: (event, engine) => { capture?.emitted(event.text, engine); } });`, '      const s = session();'],
    [`      backend.transcribe = (x, purpose) => {
        let input: number | undefined;
        try { input = capture?.input(x, purpose, s.engine); } catch { /* Evidence cannot change recognition. */ }
        const w = transcribe.call(backend, x, purpose);
        if (purpose !== "keyword") written.push(w);
        try { capture?.decoded(input, w); } catch { /* Evidence cannot change recognition. */ }
        return w;
      };`, '      backend.transcribe = (x, purpose) => { const w = transcribe.call(backend, x, purpose); if (purpose !== "keyword") written.push(w); return w; };'],
    [`        const audio = inRoom(mic);
        try { capture?.microphone(audio); } catch { /* Evidence cannot change the original engine input. */ }
        s.hear(audio, { onFrame: k => {`, '        s.hear(inRoom(mic), { onFrame: k => {'],
    [`      // Keep only the first bad literal trial; successful trials and positive-answer controls never write evidence.
      if (capture && sent(s.events).some(event => spokenAnswer(event.text) === "allow")) refusalEvidence ??= capture;
`, ""],
    ['window: "answer" | "follow-up" = "answer", fixture?: string) => heardWritten(speech, on, window, fixture).events;', 'window: "answer" | "follow-up" = "answer") => heardWritten(speech, on, window).events;'],
    ['sent(heard(speech, on, window, text))', 'sent(heard(speech, on, window))'],
    [`    try { expect(taken).toEqual([]); }
    catch (error) {
      try { refusalEvidence?.failed(); } catch { /* Preserve the identical original assertion even if observation fails. */ }
      throw error;
    }`, '    expect(taken).toEqual([]);'],
  ];
  let restored = source;
  for (const [added, original] of replacements) { expect(restored.split(added)).toHaveLength(2); restored = restored.replace(added, original); }
  expect(sha256(restored)).toBe("9e178bd24b0f71dabb796111f6677b263590b2d04e6cb0f4882e9b051b98661d");
  let workflow = fs.readFileSync(".github/workflows/ci.yml", "utf8");
  const start = workflow.indexOf("      - name: Preserve fixed synthetic refusal-tail failure evidence\n"), end = workflow.indexOf("      - run: npm run build", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start); workflow = workflow.slice(0, start) + workflow.slice(end);
  const speech = "      - name: Speech on RHEL 8's glibc, on both builds (WebAssembly, then sherpa-onnx's C API, which the packages use)\n";
  workflow = workflow.replace(speech + "        id: speech\n", speech).replace('          EMBER_SYNTHETIC_TAIL_CAPTURE: "1"\n', "");
  expect(sha256(workflow)).toBe("9f2a84a7f2c0996aa65bece5522dd5e42cfdee03acd027b91355d8e2c86af0a8");
});
