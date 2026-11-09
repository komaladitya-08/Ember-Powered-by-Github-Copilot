// Types for listening-backend.mjs (the unit tests import it).

/** What Ember's log says about listening. */
export interface ListeningSeen {
  /** "native" (sherpa-onnx's C API) or "wasm" (WebAssembly); null before the log says. */
  backend: string | null;
  /** The log line it came from: voice.ready, voice.backend or voice.native_failed. */
  from: string | null;
  /** Why, as that line says (voice.ready's detail, voice.backend's why). */
  detail: string | null;
  /** A voice process said what it runs (voice.ready), not only main's choice, and hasn't stopped since. */
  ready: boolean;
  /** The first line since then that said the voice process stopped (voice.exit, voice.restart…), and why; null once one is ready again. */
  stopped: { line: string; why: string | null } | null;
  /** The models a native voice process made on WebAssembly (voice.model_wasm_fallback). */
  onWasm: string[];
}

export declare function listeningSeen(text: string): ListeningSeen;
export declare function listeningWords(seen: Pick<ListeningSeen, "backend" | "onWasm">): string;
export declare function notNative(seen: ListeningSeen): string | null;
/** footprint.mjs's name for an Electron utility process: in its run, only listening's is one. */
export declare const LISTENING_KIND: string;
/** Why footprint.mjs's sample didn't measure one voice process listening from its start to its end, from the log then and after. */
export declare function listeningGap(atStart: string, atEnd: string): string | null;
