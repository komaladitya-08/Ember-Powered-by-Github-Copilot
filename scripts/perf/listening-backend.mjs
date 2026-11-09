// What footprint.mjs reads from Ember's log about listening: which backend the voice process ran, so that --native
// fails unless sherpa-onnx's C API really listened. Main's voice.backend is only its choice (the libraries are there and
// this processor can run them): a library that doesn't load falls back to WebAssembly inside the voice process, which
// doesn't die but says so in voice.ready (sherpaRuntime, app/voice/runtime.ts), and a native process can still make a
// model on WebAssembly (voice.model_wasm_fallback). The unit tests import it (reliability-performance-v6-1).

/**
 * The listening backend in Ember's log (ember.log's text, a JSON object a line), the latest line deciding: main's choice
 * (voice.backend) until a voice process says what it runs (voice.ready's backend), and WebAssembly once one died loading
 * natively (voice.native_failed: the next starts on WebAssembly). `ready`: a voice process said it, not only main;
 * `onWasm`: the models that process made on WebAssembly though it ran natively.
 * @param {string} text
 * @returns {{ backend: string | null; from: string | null; detail: string | null; ready: boolean; onWasm: string[] }}
 */
export function listeningSeen(text) {
  /** @type {{ backend: string | null; from: string | null; detail: string | null; ready: boolean; onWasm: string[] }} */
  let seen = { backend: null, from: null, detail: null, ready: false, onWasm: [] };
  for (const line of String(text ?? "").split("\n")) {
    let m;
    try { m = JSON.parse(line); } catch { continue; } // a blank line, or the last one cut short as Ember was stopped
    const detail = typeof m?.detail === "string" ? m.detail : typeof m?.why === "string" ? m.why : null;
    if ((m?.msg === "voice.backend" || m?.msg === "voice.ready") && typeof m.backend === "string") {
      seen = { backend: m.backend, from: m.msg, detail, ready: m.msg === "voice.ready", onWasm: [] };
    } else if (m?.msg === "voice.native_failed") {
      seen = { backend: "wasm", from: m.msg, detail: "a voice process died loading the C API", ready: false, onWasm: [] };
    } else if (m?.msg === "voice.model_wasm_fallback" && seen.ready) {
      // Each once: both of Silero's voice activity models (speech detection and the idle voice check) fall back together.
      seen = { ...seen, onWasm: Array.isArray(m.models) && m.models.length ? [...new Set(m.models.map(String))] : ["a model"] };
    }
  }
  return seen;
}

/** Names as a list: "a", "a and b", "a, b and c". */
const listed = names => names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names.join("");

/**
 * The backend in words, for footprint.mjs's first line: "sherpa-onnx's C API", "WebAssembly" or "an unknown backend",
 * naming any model a native process made on WebAssembly.
 * @param {{ backend: string | null; onWasm: string[] }} seen
 * @returns {string}
 */
export function listeningWords(seen) {
  if (seen.backend === "wasm") return "WebAssembly";
  if (seen.backend !== "native") return "an unknown backend";
  return seen.onWasm.length ? `sherpa-onnx's C API, with the ${listed(seen.onWasm)} on WebAssembly` : "sherpa-onnx's C API";
}

/**
 * Why a --native run didn't measure sherpa-onnx's C API, or null when it did: a voice process said it runs on it
 * (voice.ready), every model included.
 * @param {{ backend: string | null; from: string | null; detail: string | null; ready: boolean; onWasm: string[] }} seen
 * @returns {string | null}
 */
export function notNative(seen) {
  if (seen.backend !== "native") {
    const said = seen.from ? `, as ${seen.from} says${seen.detail ? ` (${seen.detail})` : ""}` : "";
    return `listening ran on ${listeningWords(seen)}${said}`;
  }
  if (!seen.ready) return "no voice process said what it runs (no voice.ready in Ember's log), only main's choice of sherpa-onnx's C API";
  if (seen.onWasm.length) return `the ${listed(seen.onWasm)} ran on WebAssembly (voice.model_wasm_fallback)`;
  return null;
}
