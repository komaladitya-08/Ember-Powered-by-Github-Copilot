/**
 * WSL discovery and commands (§4.1-4.2; owned by package WA). STUB from Step 0a: `createWsl` returns null, which
 * means "no WSL here" everywhere (as off Windows).
 */

import type { OS } from "../../shared/shortcuts";
import type { Logger } from "../logger";
import type { JobHostRef } from "../commands/types";
import type { WslService } from "./types";

/** WSL for Ember: null off Windows, when WSL isn't there, or (this stub) always. */
export function createWsl(_o: { log: Logger; env: NodeJS.ProcessEnv; os: OS; ember: { winPaths: string[] }; jobHost: JobHostRef | null }): WslService | null {
  return null;
}
