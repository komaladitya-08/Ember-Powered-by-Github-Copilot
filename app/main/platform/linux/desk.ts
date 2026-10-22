/**
 * Ember's desk (tier 2): a private Xvfb display with its own session bus, Linux only (D5). The factory wraps
 * desk/desk.ts and desk/place.ts unchanged; Platform.desk is null on Windows and macOS, where DeskManager is never made.
 */

import { DeskManager } from "../../desk/desk";
import { openDeskPlace } from "../../desk/place";
import type { DeskFactory } from "../types";

/** The Linux desk factory: availability (Xvfb, xauth, dbus-daemon), the manager and the place a task works in. */
export const linuxDesk: DeskFactory = {
  available: () => DeskManager.available(),
  create: (log, o) => new DeskManager(log, o),
  openPlace: (desk, o) => openDeskPlace(desk, o),
};
