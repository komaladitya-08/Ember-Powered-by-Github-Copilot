/**
 * One accessibility reader over Windows' UIA and each WSL distro's AT-SPI sidecar (§4.4; owned by package WB).
 * STUB from Step 0a: `wrapForWsl` returns the base sidecar unchanged, so every call reaches UIA exactly as before.
 */

import type { OS } from "../../shared/shortcuts";
import type { Logger } from "../logger";
import type { AtspiSidecar } from "../perception/sidecar";
import type { PerceptionSidecar, SidecarPort } from "../perception/ports";
import type { PerceptionWindows } from "../platform/types";
import type { SettingsStore } from "../settings";
import type { WslService } from "./types";

export interface WrapForWslOptions {
  os: OS;
  log: Logger;
  /** The Windows window system (its stack: HWND, pid, title, bounds, owner). */
  ws: () => PerceptionWindows | null;
  wsl: () => WslService | null;
  settings: SettingsStore;
}

/** UIA's sidecar, or one that also reads WSLg windows through each distro's sidecar. */
export function wrapForWsl(base: AtspiSidecar, _o: WrapForWslOptions): PerceptionSidecar & SidecarPort {
  return base;
}
