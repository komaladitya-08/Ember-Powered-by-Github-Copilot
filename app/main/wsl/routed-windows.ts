/**
 * The Windows window system with identified WSLg windows renamed "wsl:<distro>:<app>" (§4.4, critique wsl-2; owned by
 * package WB). STUB from Step 0a: `wrapWindowsForWsl` returns the window system unchanged.
 */

import type { WindowSystem } from "../platform/types";
import type { WrapForWslOptions } from "./routed-sidecar";

/**
 * The Windows window system, with the program name (`wmClass`) of every RAIL window the router identified rewritten to
 * "wsl:<distro>:<app>" (critique wsl-2). Main passes the result as Perception's `x11`, to the hands' window lists and to
 * `currentWindow`/`activeWindow`. Unidentified RAIL windows keep "msrdc", so the existing `isRemoteSurface` check keeps
 * masking and refusing exactly those. A Proxy like `platform/compose.ts`'s system-dialog wrapper: every other member is
 * the backend's own (I-win's extras survive).
 */
export function wrapWindowsForWsl(ws: WindowSystem, _o: WrapForWslOptions): WindowSystem {
  return ws;
}
