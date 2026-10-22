/**
 * The command window's controller ("Ember commands", §3.9-§3.10, §8.5; owned by package UI). STUB from Step 0a:
 * `createCommandWindowPort` has its final signature but shows nothing and refuses everything: no card is ever ready
 * (so no command can be allowed through it), every announcement is stopped before it runs, and it owns no sender.
 */

import type { OS } from "../../shared/shortcuts";
import type { Logger } from "../logger";
import type { BrowserWindowLike, IpcLike, WebContentsLike } from "../targets/types";
import type { CommandWindowPort } from "./types";

/** The command window as the command flow drives it, plus what the targets runtime needs of it. */
export function createCommandWindowPort(_o: { create: () => BrowserWindowLike; ipc: IpcLike; log: Logger; os: OS; keyHint: () => string | null }):
  CommandWindowPort & { show(): void; owns(sender: WebContentsLike): boolean; dispose(): void } {
  return {
    showCard: () => undefined,
    hideCard: () => undefined,
    cardReady: () => false,
    announce: async () => false,
    cancelAnnounce: () => undefined,
    attach: () => undefined,
    show: () => undefined,
    owns: () => false,
    dispose: () => undefined,
  };
}
