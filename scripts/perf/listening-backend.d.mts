// Types for listening-backend.mjs (the unit tests import it).

/** What Ember's log says about listening. */
export interface ListeningSeen {
  /** "native" (sherpa-onnx's C API) or "wasm" (WebAssembly); null before the log says. */
  backend: string | null;
  /** The log line it came from: voice.ready, voice.backend or voice.native_failed. */
  from: string | null;
  /** Why, as that line says (voice.ready's detail, voice.backend's why). */
  detail: string | null;
  /** A voice process said what it runs (voice.ready), not only main's choice. */
  ready: boolean;
  /** The models a native voice process made on WebAssembly (voice.model_wasm_fallback). */
  onWasm: string[];
}

export declare function listeningSeen(text: string): ListeningSeen;
export declare function listeningWords(seen: Pick<ListeningSeen, "backend" | "onWasm">): string;
export declare function notNative(seen: ListeningSeen): string | null;
