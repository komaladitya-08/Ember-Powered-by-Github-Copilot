/**
 * The Linux composition: today's modules behind the Platform object, called with today's arguments (Phase 1 wraps,
 * it doesn't rewrite). X11 opens only with $DISPLAY and only when openWindows runs (after app ready); libX11 and libXtst
 * load then, never at import, so this module imports on every OS and in unit tests.
 */

import { WAYLAND_REASON, isWaylandSession } from "../../environment";
import { openXInput, xinputError } from "../../hands/input";
import { holdKeyboard } from "../../hands/keybuffer";
import type { Platform, PlatformDeps } from "../types";
import { linuxClipboard } from "./clipboard";
import { linuxDesk } from "./desk";
import { linuxOverlayShaper } from "./overlay-shaper";
import { linuxSystem } from "./system";
import { openLinuxWindows } from "./window-system";

/**
 * The platform for Linux (and for any OS that isn't Windows or macOS: it fails the environment's platform check, as
 * today). Building it touches nothing of Electron's `screen` and calls no `app.getPath` (PlatformDeps' rule).
 */
export function linuxPlatform(deps: PlatformDeps): Platform {
  const system = linuxSystem(deps);
  return {
    os: "linux",
    system,
    // In a Wayland session XWayland shows Ember only X11 apps: their pixels (the rest of the screen is black or stale),
    // their pointer and their keys, so the user's taking over can't be seen. There this computer's system-dialog check
    // is always on, with WAYLAND_REASON for its words: no screenshots and no borrowed mouse or keyboard (fail closed,
    // review #240); reading apps goes on. Here only: the SSH remote's desktop child opens X11 in logind's x11 session.
    openWindows: () => {
      const ws = openLinuxWindows({ screen: deps.electron.screen, env: deps.env });
      return ws && isWaylandSession(deps.env) ? { ...ws, systemDialogOpen: () => true, systemDialogReason: () => WAYLAND_REASON } : ws;
    },
    // No X11, no XTest. The doctor passes no logger: it never logged xtest.unavailable.
    openInput: (ws, log) => {
      if (!ws) return null;
      const xi = openXInput();
      if (!xi) log?.warn("xtest.unavailable", { err: xinputError });
      return xi;
    },
    // X re-reports a grabbed shortcut when its grab ends: the ask callback checks the held chord.
    shortcutsReReported: true,
    overlay: linuxOverlayShaper(),
    keyboardHold: o => holdKeyboard(o),
    clipboard: linuxClipboard(deps.env),
    // AtspiSidecar's own default: the Python AT-SPI sidecar, unchanged.
    sidecarLaunch: () => undefined,
    desk: linuxDesk,
  };
}
