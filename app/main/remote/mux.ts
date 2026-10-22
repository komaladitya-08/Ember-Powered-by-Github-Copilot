/**
 * The framed stream both ends of an SSH link speak (§5.1.10; owned by package MX). STUB from Step 0a: `createMux` has
 * its final signature and throws.
 */

import type { Logger } from "../logger";
import type { Mux } from "./types";

/** Both ends of the framed stream over `read`/`write` (the preamble included); this stub refuses. */
export function createMux(_o: { read: NodeJS.ReadableStream; write: NodeJS.WritableStream; role: "pc" | "agent"; partsId: string; log: Logger }): Mux {
  throw new Error("the remote link's framing isn't built yet");
}
