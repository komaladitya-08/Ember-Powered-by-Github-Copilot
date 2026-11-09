// What footprint.mjs reads from Ember's log about listening: which backend the voice process ran, so that --native
// fails unless sherpa-onnx's C API really listened. Main's voice.backend is only its choice (the libraries are there and
// this processor can run them): a library that doesn't load falls back to WebAssembly inside the voice process, which
// doesn't die but says so in voice.ready (sherpaRuntime, app/voice/runtime.ts), and a native process can still make a
// model on WebAssembly (voice.model_wasm_fallback). A voice process that stops (a crash, a restart after the microphone
// went quiet) is left out of the sample's total, so it fails --native too (listeningGap). The unit tests import it
// (reliability-performance-v6-1, reliability-performance-w6-1).

/**
 * footprint.mjs's name for an Electron utility process (node.mojom.NodeService). In its run only listening's is one:
 * Ember's voice starts with the first reply, and Better recall's only once its model is downloaded.
 */
export const LISTENING_KIND = "utility node Node";

// The lines that say a voice process stopped (app/main/voice.ts): it exited, went quiet (voice.unresponsive), failed
// (voice.error, voice.mic_error) or died loading natively, or listening starts again (voice.restart: after 1 s, 5 s, then
// every 30 s).
const STOPS = new Set(["voice.exit", "voice.unresponsive", "voice.restart", "voice.error", "voice.mic_error", "voice.native_failed"]);

/**
 * A stop line's name, and why as its fields say.
 * @param {Record<string, unknown>} m
 * @returns {{ line: string; why: string | null }}
 */
function stopOf(m) {
  const why = typeof m.why === "string" ? m.why : typeof m.message === "string" ? m.message
    : Number.isFinite(m.code) ? `exit code ${m.code}` : Number.isFinite(m.ms) ? `nothing from it for ${m.ms} ms` : null;
  return { line: String(m.msg), why };
}

/** A stop line in words: "voice.exit: exit code 9". */
const stopWords = stop => `${stop.line}${stop.why ? `: ${stop.why}` : ""}`;

/**
 * The listening backend in Ember's log (ember.log's text, a JSON object a line), the latest line deciding: main's choice
 * (voice.backend) until a voice process says what it runs (voice.ready's backend), and WebAssembly once one died loading
 * natively (voice.native_failed: the next starts on WebAssembly). `ready`: a voice process said it, not only main, and
 * hasn't stopped since; `stopped`: the first line since then that said it stopped (voice.exit, voice.restart…), until
 * the next is ready; `onWasm`: the models that process made on WebAssembly though it ran natively.
 * @param {string} text
 * @returns {{ backend: string | null; from: string | null; detail: string | null; ready: boolean; stopped: { line: string; why: string | null } | null; onWasm: string[] }}
 */
export function listeningSeen(text) {
  /** @type {{ backend: string | null; from: string | null; detail: string | null; ready: boolean; stopped: { line: string; why: string | null } | null; onWasm: string[] }} */
  let seen = { backend: null, from: null, detail: null, ready: false, stopped: null, onWasm: [] };
  for (const line of String(text ?? "").split("\n")) {
    let m;
    try { m = JSON.parse(line); } catch { continue; } // a blank line, or the last one cut short as Ember was stopped
    const detail = typeof m?.detail === "string" ? m.detail : typeof m?.why === "string" ? m.why : null;
    if ((m?.msg === "voice.backend" || m?.msg === "voice.ready") && typeof m.backend === "string") {
      seen = { backend: m.backend, from: m.msg, detail, ready: m.msg === "voice.ready", stopped: null, onWasm: [] };
    } else if (m?.msg === "voice.native_failed") {
      seen = { backend: "wasm", from: m.msg, detail: "a voice process died loading the C API", ready: false, stopped: null, onWasm: [] };
    } else if (STOPS.has(m?.msg) && seen.ready) {
      // Nothing listens until the next voice.ready: the latest line decides (voice.exit comes before its voice.restart).
      seen = { ...seen, ready: false, stopped: stopOf(m), onWasm: [] };
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
 * (voice.ready), every model included, and hasn't stopped since.
 * @param {{ backend: string | null; from: string | null; detail: string | null; ready: boolean; stopped: { line: string; why: string | null } | null; onWasm: string[] }} seen
 * @returns {string | null}
 */
export function notNative(seen) {
  if (seen.backend !== "native") {
    const said = seen.from ? `, as ${seen.from} says${seen.detail ? ` (${seen.detail})` : ""}` : "";
    return `listening ran on ${listeningWords(seen)}${said}`;
  }
  if (seen.stopped) return `the voice process stopped (${stopWords(seen.stopped)}), and none was ready again`;
  if (!seen.ready) return "no voice process said what it runs (no voice.ready in Ember's log), only main's choice of sherpa-onnx's C API";
  if (seen.onWasm.length) return `the ${listed(seen.onWasm)} ran on WebAssembly (voice.model_wasm_fallback)`;
  return null;
}

/**
 * Why footprint.mjs's sample didn't measure one voice process listening from its start to its end, or null when it did.
 * It takes the process list as the sample begins and reads each one's memory as it ends, so a voice process that wasn't
 * ready by then, stopped meanwhile or was replaced is left out of the total (reliability-performance-w6-1).
 * @param {string} atStart Ember's log (ember.log's text) as the sample began
 * @param {string} atEnd the same as it ended
 * @returns {string | null}
 */
export function listeningGap(atStart, atEnd) {
  const before = String(atStart ?? ""), after = String(atEnd ?? "");
  const begun = listeningSeen(before);
  if (begun.stopped) return `the voice process had stopped when the sample began (${stopWords(begun.stopped)})`;
  if (!begun.ready) return "no voice process was ready when the sample began (no voice.ready in Ember's log by then)";
  // What was logged during the sample: from the last whole line at its start (one still being written then counts).
  const cut = before.lastIndexOf("\n") + 1;
  if (!after.startsWith(before.slice(0, cut))) return "Ember's log was rotated during the sample, so it can't say the voice process ran throughout";
  for (const line of after.slice(cut).split("\n")) {
    let m;
    try { m = JSON.parse(line); } catch { continue; } // a blank line, or the last one cut short as Ember was stopped
    if (STOPS.has(m?.msg)) return `the voice process stopped during the sample (${stopWords(stopOf(m))})`;
    if (m?.msg === "voice.ready") return "another voice process got ready during the sample (voice.ready), so the one measured was replaced";
  }
  return null;
}
