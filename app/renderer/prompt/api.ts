/**
 * The prompt window's bridge (app/preload/prompt.ts exposes exactly this as `window.emberPrompt`): PROMPT_IPC's
 * channels and nothing else. Types only.
 */

import type { PromptAnswer, PromptCard } from "../../shared/remote-ui";

export interface PromptApi {
  /** The card on screen now (main may have sent it before the page listened), or null. */
  pull(): Promise<PromptCard | null>;
  /** A new card to show, or null when there is none. */
  onShow(fn: (card: PromptCard | null) => void): void;
  /** The card's answer: a secret typed (`value`, never kept by the page) or a consent card's hash of what it showed. */
  answer(a: PromptAnswer): void;
  /** The card was closed without an answer (Cancel, Not now, Close, Esc). */
  cancel(id: string): void;
}
