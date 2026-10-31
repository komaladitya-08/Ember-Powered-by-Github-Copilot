/**
 * What a key pressed in a run's terminal does (reviews #42, #261, #264, #268), as a pure function terminal.ts hands to
 * xterm's custom key handler, and when the page puts the keyboard in a run's terminal by itself. Renderer-safe: no DOM,
 * no xterm, so renderer-command.test.ts tests it in Node.
 *
 * Tab and Shift+Tab always move the focus (WCAG 2.1.2: the terminal never traps the keyboard, and a Tab pressed while
 * sudo waits for a password never lands in the password). A program that needs a tab gets one with Ctrl+I, the same
 * byte. Off macOS, Ctrl+V pastes (the browser's own paste, which xterm sends to the run as typing; never the
 * async Clipboard API), Ctrl+C copies when text is selected and is the interrupt otherwise, and Ctrl+Shift+C always
 * copies. On macOS, Command+C and Command+V are the Edit menu's, and Ctrl+C and Ctrl+V stay the terminal's.
 */

/** The fields of a KeyboardEvent the decision reads. */
export interface KeyLike { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean; metaKey: boolean }

/**
 * "terminal": xterm handles it (the run gets it while it takes typing); "browser": xterm leaves it to the page (Tab
 * moves the focus, Ctrl+V pastes, Ctrl+C with a selection copies); "copy": the page copies the selection itself and
 * nothing else happens (Ctrl+Shift+C, which the browser doesn't take as copy).
 */
export type TermKeyAction = "terminal" | "browser" | "copy";

/** What `e`, pressed in a run's terminal, does. */
export function termKeyAction(e: KeyLike, o: { mac: boolean; hasSelection: boolean }): TermKeyAction {
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  if (key === "Tab" && !e.ctrlKey && !e.altKey && !e.metaKey) return "browser";
  if (o.mac) return "terminal";
  if (e.ctrlKey && !e.altKey && !e.metaKey) {
    if (key === "v") return "browser";
    if (key === "c" && e.shiftKey) return "copy";
    if (key === "c" && o.hasSelection) return "browser";
  }
  return "terminal";
}

/**
 * The page puts the keyboard in the selected run's terminal by itself only when that run takes typing now, no question
 * card is up (its buttons come first), and nothing else on the page has the focus (the user isn't on a button or
 * another tab): then what the user types answers the prompt instead of vanishing on the page's body.
 */
export function shouldFocusTerminal(o: { interactive: boolean; ended: boolean; cardUp: boolean; focusIdle: boolean }): boolean {
  return o.interactive && !o.ended && !o.cardUp && o.focusIdle;
}
