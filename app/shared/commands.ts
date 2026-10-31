/**
 * Messages between main and the command window ("Ember commands", §8.5): its channels and the state the renderer
 * draws. Renderer-safe: names and types only. Main accepts `answer`, `stop`, `input`, `cardSeen` and `close` only from
 * the command window's own page; what the user types there never reaches a log or the model.
 */

import type { CommandCard } from "../main/commands/types";

/** The command window's channels. */
export const COMMANDS_IPC = {
  /** Main → page: the whole CommandWindowState. */
  state: "commands:state",
  /** Page → main: the card's answer `{ n, answer: "once" | "deny", sha256 }`. */
  answer: "commands:answer",
  /** Page → main: Stop on a run's tab. */
  stop: "commands:stop",
  /** Page → main: the user's typing into a live run `{ runId, data }` (never logged). */
  input: "commands:input",
  /** Page → main: whether the card is on screen with the whole command in view (R7: the approve chord's guard). */
  cardSeen: "commands:card-seen",
  /** Page → main: Close on a finished run's tab. */
  close: "commands:close",
  /** Main → page: a run's output bytes as they come. */
  output: "commands:output",
} as const;

/** One run's tab as the command window shows it. */
export interface CommandTabView {
  runId: string;
  /** "On build-01 as deploy · bash · in ~/src/app". */
  header: string;
  /** The exact command (the page makes invisible characters visible). */
  command: string;
  /** The status line: "Running…", "Finished in 3.2 s.", … */
  status: string;
  /** The user can type into it now. */
  interactive: boolean;
  ended: boolean;
}

/** Everything the command window draws, pushed whole on every change. */
export interface CommandWindowState {
  tabs: CommandTabView[];
  /** The question shown on top (asking), with its Confirmer question number. */
  card: (CommandCard & { n: number }) | null;
  /** An announcement counting down (D4.4) until `endsAt` (ms since the epoch). */
  announce: { card: CommandCard; endsAt: number } | null;
  /** "Ctrl+Alt+Y allow · Ctrl+Alt+N not now" while the keys work, else null. */
  keyHint: string | null;
}
