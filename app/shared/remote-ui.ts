/**
 * Messages between main and Ember's prompt window ("Ember", §8.6): host keys, passwords and codes for SSH, a security
 * key touch, and the first-use consent cards. Renderer-safe: names and types only. What the user types there goes
 * only to ssh (through Ember's askpass), never to a log or the model.
 */

import type { ConsentPanel } from "./consent";

/** The prompt window's channels (main accepts `answer` and `cancel` only from the prompt window's own page). */
export const PROMPT_IPC = {
  /** Main → page: the PromptCard to show. */
  show: "prompt:show",
  /** Page → main: the PromptAnswer. */
  answer: "prompt:answer",
  /** Page → main: the card was closed without an answer. */
  cancel: "prompt:cancel",
} as const;

/** One card in the prompt window. */
export type PromptCard =
  /** An unknown host key: its address and fingerprint, to accept once. */
  | { id: string; kind: "host-key"; host: string; address: string; fingerprint: string }
  /** The host's key changed: refused, with how to fix it. */
  | { id: string; kind: "host-key-changed"; host: string }
  /**
   * A password, a key's passphrase, a one-time code or another secret ssh asks for: `prompt` is ssh's own text
   * (untrusted); `via` the jump hop the prompt names when it isn't `host` ("Sign in to bastion on the way to build-01").
   */
  | { id: string; kind: "secret"; secret: "password" | "passphrase" | "code" | "other"; host: string; via?: string; login?: string; prompt: string }
  /** Touch the security key. */
  | { id: string; kind: "touch"; host: string }
  /** A first-use consent card that is a Confirmer question (number n). */
  | { id: string; kind: "consent"; n: number; consent: ConsentPanel }
  /** A first-use consent card asked directly (settings' switches), not through a question. */
  | { id: string; kind: "consent-direct"; consent: ConsentPanel };

/**
 * The page's answer to a card: `value` is the secret typed (never logged); `sha256` echoes a consent card's hash.
 * `refused` is main's own no, never the user's: the card couldn't be shown (no window, or a card it won't show).
 */
export type PromptAnswer = { id: string; ok: boolean; value?: string; sha256?: string; refused?: true };
