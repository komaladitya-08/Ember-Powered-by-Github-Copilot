/**
 * Which listening backend scripts/perf/footprint.mjs says it measured, from Ember's log: CI's resting-cost budget with
 * --native counts the C API the RPM and AppImage run only when the voice process really ran on it. Main's voice.backend
 * is only its choice (the libraries are there); a library that doesn't load falls back to WebAssembly inside the voice
 * process, which says so in voice.ready (reliability-performance-v6-1). A voice process that stops is left out of the
 * sample's total, so it fails --native too, as a budget run (reliability-performance-w6-1).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { LISTENING_KIND, listeningGap, listeningSeen, listeningWords, notNative } from "../../scripts/perf/listening-backend.mjs";

const root = path.resolve(__dirname, "../..");
const log = (...lines: object[]) => lines.map(l => JSON.stringify(l)).join("\n") + "\n";
// The lines a run logs, as ember.log has them (a built Ember given two empty files for the C API's libraries).
const CHOSE_NATIVE = { backend: "native", why: "sherpa-onnx's C API", level: "info", msg: "voice.backend" };
const READY_WASM = { loadMs: 2751, backend: "wasm", detail: "the C API didn't load: Failed to load shared library: file too short", provider: "cpu", threads: 1, tried: [{ provider: "cpu" }], level: "info", msg: "voice.ready", scope: "voice" };
const READY_NATIVE = { loadMs: 3093, backend: "native", detail: "sherpa-onnx 1.13.8 (11afbd00, C API through koffi, layouts from 1.13.8)", provider: "cpu", threads: 2, tried: [{ provider: "cpu" }], level: "info", msg: "voice.ready", scope: "voice" };
// A ready voice process killed (SIGKILL: code 9), then listening started again (app/main/voice.ts restartLater).
const EXIT = { code: 9, level: "warn", msg: "voice.exit", scope: "voice" };
const restart = (why: string, inMs: number) => ({ why, inMs, attempt: 1, level: "warn", msg: "voice.restart", scope: "voice" });
const fellBack = (...models: string[]) => ({ models, detail: "sherpa-onnx 1.13.8 (11afbd00, C API through koffi, layouts from 1.13.8)", level: "warn", msg: "voice.model_wasm_fallback", scope: "voice" });

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

  it("fails --native once the native voice process stopped and none was ready again (reliability-performance-w6-1)", () => {
    // The reviewer's run: killed after its voice.ready, the next start 30 s away, across the whole sample.
    const seen = listeningSeen(log(CHOSE_NATIVE, READY_NATIVE, EXIT, restart("The voice process stopped.", 30_000)));
    expect(seen).toMatchObject({ backend: "native", ready: false, stopped: { line: "voice.exit", why: "exit code 9" }, onWasm: [] });
    expect(notNative(seen)).toBe("the voice process stopped (voice.exit: exit code 9), and none was ready again");
    // Every line that ends a voice process ends its ready.
    for (const [stop, why] of [
      [{ ms: 15_000, level: "warn", msg: "voice.unresponsive", scope: "voice" }, "nothing from it for 15000 ms"],
      [restart("No sound is arriving from the microphone.", 1000), "No sound is arriving from the microphone."],
      [{ message: "The speech models look damaged.", models: true, level: "error", msg: "voice.error", scope: "voice" }, "The speech models look damaged."],
      [{ message: "NotReadableError", level: "error", msg: "voice.mic_error", scope: "voice" }, "NotReadableError"],
    ] as const) {
      expect(notNative(listeningSeen(log(CHOSE_NATIVE, READY_NATIVE, stop)))).toBe(`the voice process stopped (${stop.msg}: ${why}), and none was ready again`);
    }
    // The latest line decides: a voice process ready again listens again, without the last one's fallbacks.
    const again = listeningSeen(log(CHOSE_NATIVE, READY_NATIVE, fellBack("wake word model"), EXIT, restart("The voice process stopped.", 1000), READY_NATIVE));
    expect(again).toMatchObject({ backend: "native", ready: true, stopped: null, onWasm: [] });
    expect(notNative(again)).toBeNull();
    // A stop before any voice process was ready is still "never ready"; one on WebAssembly is still WebAssembly first.
    expect(listeningSeen(log(CHOSE_NATIVE, restart("The microphone page stopped.", 1000)))).toMatchObject({ ready: false, stopped: null });
    expect(notNative(listeningSeen(log(CHOSE_NATIVE, restart("The microphone page stopped.", 1000))))).toBe("no voice process said what it runs (no voice.ready in Ember's log), only main's choice of sherpa-onnx's C API");
    expect(notNative(listeningSeen(log(CHOSE_NATIVE, READY_WASM, EXIT)))).toBe("listening ran on WebAssembly, as voice.ready says (the C API didn't load: Failed to load shared library: file too short)");
  });

  it("says when the sample didn't measure one voice process listening from its start to its end (reliability-performance-w6-1)", () => {
    const begun = log(CHOSE_NATIVE, READY_NATIVE);
    // Listening throughout: nothing to say.
    expect(listeningGap(begun, begun + log({ percent: 1.2, audioMs: 10_000, peak: 0, level: "info", msg: "voice.cpu", scope: "voice" }, { on: true, level: "warn", msg: "voice.silent", scope: "voice" }))).toBeNull();
    // Killed 3 s into the sample, ready again by its end: the log's end alone says native, but the total left it out.
    const restarted = begun + log(EXIT, restart("The voice process stopped.", 1000), READY_NATIVE);
    expect(notNative(listeningSeen(restarted))).toBeNull();
    expect(listeningGap(begun, restarted)).toBe("the voice process stopped during the sample (voice.exit: exit code 9)");
    // Killed before the sample, the next start 30 s away (the reviewer's run), or restarted for a quiet microphone.
    const dead = log(CHOSE_NATIVE, READY_NATIVE, EXIT, restart("The voice process stopped.", 30_000));
    expect(listeningGap(dead, dead)).toBe("the voice process had stopped when the sample began (voice.exit: exit code 9)");
    const quiet = log(CHOSE_NATIVE, READY_NATIVE, restart("No sound is arriving from the microphone.", 1000));
    expect(listeningGap(quiet, quiet + log(READY_NATIVE))).toBe("the voice process had stopped when the sample began (voice.restart: No sound is arriving from the microphone.)");
    expect(listeningGap(log(CHOSE_NATIVE), log(CHOSE_NATIVE, READY_NATIVE))).toBe("no voice process was ready when the sample began (no voice.ready in Ember's log by then)");
    // Another voice process got ready meanwhile (listening started again with no line saying the last one stopped).
    expect(listeningGap(begun, begun + log(READY_NATIVE))).toBe("another voice process got ready during the sample (voice.ready), so the one measured was replaced");
    // A line still being written as the sample began counts as written during it.
    const exit = JSON.stringify(EXIT);
    expect(listeningGap(begun + exit.slice(0, 12), begun + exit + "\n")).toBe("the voice process stopped during the sample (voice.exit: exit code 9)");
    // A log rotated meanwhile can't say what happened during the sample.
    expect(listeningGap(begun, log(READY_NATIVE))).toBe("Ember's log was rotated during the sample, so it can't say the voice process ran throughout");
  });

  it("names each model a native process made on WebAssembly once, as a list (reliability-performance-w6-2)", () => {
    // Both Silero voice activity models (speech detection and the idle voice check) fall back together.
    const vad = listeningSeen(log(CHOSE_NATIVE, READY_NATIVE, fellBack("voice activity model", "voice activity model")));
    expect(vad.onWasm).toEqual(["voice activity model"]);
    expect(listeningWords(vad)).toBe("sherpa-onnx's C API, with the voice activity model on WebAssembly");
    expect(notNative(vad)).toBe("the voice activity model ran on WebAssembly (voice.model_wasm_fallback)");
    const two = listeningSeen(log(CHOSE_NATIVE, READY_NATIVE, fellBack("wake word model", "voice activity model", "voice activity model")));
    expect(notNative(two)).toBe("the wake word model and voice activity model ran on WebAssembly (voice.model_wasm_fallback)");
    const all = listeningSeen(log(CHOSE_NATIVE, READY_NATIVE, fellBack("wake word model", "voice activity model", "voice activity model", "speech recognition model")));
    expect(listeningWords(all)).toBe("sherpa-onnx's C API, with the wake word model, voice activity model and speech recognition model on WebAssembly");
  });

  it("is what footprint.mjs reports and checks --native with (reliability-performance-v6-1, reliability-performance-w6-1)", () => {
    const script = readFileSync(path.join(root, "scripts/perf/footprint.mjs"), "utf8");
    expect(script).toContain('from "./listening-backend.mjs"');
    expect(script).toMatch(/native \? notNative\(seen\)/);
    expect(script).not.toMatch(/msg === "voice\.backend"/);
    // The log is read as the process list is taken and again after the sample, and the listening process must be in
    // the rows: --native fails without it, and so does a budget run.
    expect(script).toMatch(/const pids = tree\(app\.pid\), atStart = logText\(\);/);
    expect(script).toMatch(/gap = listeningGap\(atStart, atEnd\)/);
    expect(script).toMatch(/rows\.some\(r => r\.kind === LISTENING_KIND\)/);
    expect(script).toMatch(/native \? notNative\(seen\) \?\? unmeasured : null/);
    expect(script).toMatch(/if \(budget\) process\.exitCode = 1;/);
    expect(LISTENING_KIND).toBe("utility node Node");
    // A page that closes during the sample (listening starting again closes the microphone's) answers nothing rather
    // than leave the run waiting for ever.
    expect(script).toMatch(/ws\.onclose = \(\) => \{ for \(const r of pending\.values\(\)\) r\(undefined\); pending\.clear\(\); \};/);
  });
});
