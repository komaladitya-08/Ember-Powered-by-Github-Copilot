/**
 * Which listening backend scripts/perf/footprint.mjs says it measured, from Ember's log: CI's resting-cost budget with
 * --native counts the C API the RPM and AppImage run only when the voice process really ran on it. Main's voice.backend
 * is only its choice (the libraries are there); a library that doesn't load falls back to WebAssembly inside the voice
 * process, which says so in voice.ready (reliability-performance-v6-1).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { listeningSeen, listeningWords, notNative } from "../../scripts/perf/listening-backend.mjs";

const root = path.resolve(__dirname, "../..");
const log = (...lines: object[]) => lines.map(l => JSON.stringify(l)).join("\n") + "\n";
// The lines a run logs, as ember.log has them (a built Ember given two empty files for the C API's libraries).
const CHOSE_NATIVE = { backend: "native", why: "sherpa-onnx's C API", level: "info", msg: "voice.backend" };
const READY_WASM = { loadMs: 2751, backend: "wasm", detail: "the C API didn't load: Failed to load shared library: file too short", provider: "cpu", threads: 1, tried: [{ provider: "cpu" }], level: "info", msg: "voice.ready", scope: "voice" };
const READY_NATIVE = { loadMs: 3093, backend: "native", detail: "sherpa-onnx 1.13.8 (11afbd00, C API through koffi, layouts from 1.13.8)", provider: "cpu", threads: 2, tried: [{ provider: "cpu" }], level: "info", msg: "voice.ready", scope: "voice" };

describe("footprint.mjs's listening backend", () => {
  it("says WebAssembly, and fails --native, when the C API didn't load though main chose it (reliability-performance-v6-1)", () => {
    const seen = listeningSeen(log(CHOSE_NATIVE, READY_WASM));
    expect(seen).toMatchObject({ backend: "wasm", from: "voice.ready", ready: true });
    expect(listeningWords(seen)).toBe("WebAssembly");
    expect(notNative(seen)).toBe("listening ran on WebAssembly, as voice.ready says (the C API didn't load: Failed to load shared library: file too short)");
  });

  it("passes --native only once the voice process says it runs on the C API (reliability-performance-v6-1)", () => {
    const seen = listeningSeen(log(CHOSE_NATIVE, READY_NATIVE));
    expect(seen).toMatchObject({ backend: "native", from: "voice.ready", ready: true, onWasm: [] });
    expect(listeningWords(seen)).toBe("sherpa-onnx's C API");
    expect(notNative(seen)).toBeNull();
    // Main's choice alone is not what ran: a voice process that wasn't ready by the sample proves nothing.
    expect(notNative(listeningSeen(log(CHOSE_NATIVE)))).toBe("no voice process said what it runs (no voice.ready in Ember's log), only main's choice of sherpa-onnx's C API");
  });

  it("fails --native when a native voice process made a model on WebAssembly (reliability-performance-v6-1)", () => {
    const seen = listeningSeen(log(CHOSE_NATIVE, READY_NATIVE, { models: ["wake word model"], detail: "sherpa-onnx 1.13.8 (11afbd00, C API through koffi, layouts from 1.13.8); on WebAssembly: wake word model", level: "warn", msg: "voice.model_wasm_fallback", scope: "voice" }));
    expect(seen).toMatchObject({ backend: "native", onWasm: ["wake word model"] });
    expect(listeningWords(seen)).toBe("sherpa-onnx's C API, with the wake word model on WebAssembly");
    expect(notNative(seen)).toBe("the wake word model ran on WebAssembly (voice.model_wasm_fallback)");
  });

  it("follows the latest voice process: one that died loading natively starts again on WebAssembly (reliability-performance-v6-1)", () => {
    const failed = { code: 134, level: "warn", msg: "voice.native_failed", scope: "voice" };
    expect(listeningSeen(log(CHOSE_NATIVE, failed))).toMatchObject({ backend: "wasm", from: "voice.native_failed", ready: false });
    expect(listeningSeen(log(CHOSE_NATIVE, failed, READY_WASM))).toMatchObject({ backend: "wasm", from: "voice.ready", ready: true });
    // A process that was ready natively, then a restart that died loading: the next one listens on WebAssembly.
    expect(listeningSeen(log(CHOSE_NATIVE, READY_NATIVE, { code: 1, level: "warn", msg: "voice.exit", scope: "voice" }, failed))).toMatchObject({ backend: "wasm", ready: false });
    // A fallback warning belongs to the process before a new ready.
    expect(listeningSeen(log(CHOSE_NATIVE, READY_NATIVE, { models: ["wake word model"], msg: "voice.model_wasm_fallback" }, READY_NATIVE)).onWasm).toEqual([]);
  });

  it("knows nothing from an empty log or one cut short as Ember stopped (reliability-performance-v6-1)", () => {
    expect(listeningSeen("")).toMatchObject({ backend: null, ready: false, onWasm: [] });
    expect(listeningWords(listeningSeen(""))).toBe("an unknown backend");
    expect(listeningSeen(log(CHOSE_NATIVE) + '{"loadMs":12,"backend":"wa')).toMatchObject({ backend: "native", ready: false });
  });

  it("is what footprint.mjs reports and checks --native with (reliability-performance-v6-1)", () => {
    const script = readFileSync(path.join(root, "scripts/perf/footprint.mjs"), "utf8");
    expect(script).toContain('from "./listening-backend.mjs"');
    expect(script).toMatch(/native \? notNative\(seen\)/);
    expect(script).not.toMatch(/msg === "voice\.backend"/);
  });
});
