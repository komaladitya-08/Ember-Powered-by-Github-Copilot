/**
 * The Linux clipboard bridge: what main.ts did with the X clipboard directly (hands/clipboard-handoff.ts, unchanged).
 * At quit, a clipboard Ember holds goes to the freedesktop clipboard manager (or quitting would empty it), told apart by
 * the X id of one of Ember's windows; and the X PRIMARY selection of the user's window is read for the ask box's
 * context. Only on X11: without $DISPLAY there is no owner id, so nothing is handed off (today's gate).
 */

import { handClipboardToManager, readSelection } from "../../hands/clipboard-handoff";
import type { ClipboardBridge } from "../types";
import { x11WindowId } from "./window-system";

/** The bridge for the display in `env` (read when asked, as main.ts read process.env). */
export function linuxClipboard(env: NodeJS.ProcessEnv): ClipboardBridge {
  return {
    ownerId: win => (env.DISPLAY ? x11WindowId(win) : 0),
    handOff: ourWindow => handClipboardToManager({ ourWindow }),
    readSelection: sameClientAs => readSelection({ sameClientAs }),
  };
}
