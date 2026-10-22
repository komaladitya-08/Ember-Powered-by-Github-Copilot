/**
 * loadPlatform(): the one place that picks the OS backend, by process.platform alone (never by $DISPLAY, D1).
 * Backends load native libraries only when their window system or input is opened, so this imports on every OS.
 */

import type { Platform, PlatformDeps } from "./types";
import { linuxPlatform } from "./linux";
import { win32Platform } from "./win32/platform";
import { darwinPlatform } from "./darwin/platform";

/**
 * The platform for this process: Windows and macOS get their own, anything else Linux's (an OS with no backend then
 * fails the environment's platform check, as before the port). `os` is for tests.
 */
export function loadPlatform(deps: PlatformDeps, os: NodeJS.Platform = process.platform): Platform {
  if (os === "win32") return win32Platform(deps);
  if (os === "darwin") return darwinPlatform(deps);
  return linuxPlatform(deps);
}
