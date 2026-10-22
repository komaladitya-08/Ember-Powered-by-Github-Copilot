/**
 * The prompt window's controller ("Ember", §8.6; owned by package UI): host keys, passwords, codes and consent cards.
 * STUB from Step 0a: `createPromptWindow` has its final signature but shows nothing: every card is cancelled at once
 * and no consent card is ever ready (so none can be accepted).
 */

import type { OS } from "../../shared/shortcuts";
import type { ConsentPanel } from "../../shared/consent";
import type { Logger } from "../logger";
import type { BrowserWindowLike, IpcLike } from "../targets/types";
import type { PromptUi } from "./types";

/** The prompt window, as connections and the targets runtime use it (this stub: cancels everything). */
export function createPromptWindow(_o: { create: () => BrowserWindowLike; ipc: IpcLike; log: Logger; os: OS }):
  PromptUi & { showConsent(n: number, c: ConsentPanel): void; hideConsent(n: number): void; consentReady(n: number): boolean; dispose(): void } {
  return {
    ask: async card => ({ id: card.id, ok: false }),
    dismiss: () => undefined,
    showConsent: () => undefined,
    hideConsent: () => undefined,
    consentReady: () => false,
    dispose: () => undefined,
  };
}
