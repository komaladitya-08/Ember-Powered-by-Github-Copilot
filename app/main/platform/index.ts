/**
 * loadPlatform(): the one place that picks the OS backend, by process.platform alone (never by $DISPLAY, D1).
 * Backends load native libraries only when their window system or input is opened, so this imports on every OS.
 */

import type { Platform, PlatformDeps } from "./types";
import { linuxPlatform } from "./linux";
// Phase 3 (I) adds: import { win32Platform } from "./win32/platform"; import { darwinPlatform } from "./darwin/platform";

/**
 * The platform for this process. Unknown OSes get the Linux object (they fail the environment's platform check, as
 * today); until Phase 3 switches them on, so do Windows and macOS. `os` is for tests.
 */
export function loadPlatform(deps: PlatformDeps, os: NodeJS.Platform = process.platform): Platform {
  // Phase 3: if (os === "win32") return win32Platform(deps); if (os === "darwin") return darwinPlatform(deps);
  void os;
  return linuxPlatform(deps);
}
