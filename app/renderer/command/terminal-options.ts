/**
 * The options every run's terminal (@xterm/xterm 5.5.0) is made with, exactly as §3.10 sets them, in a module of its
 * own so renderer-command.test.ts can pin them without a DOM: no proposed API, no addons (no clipboard addon, so OSC 52
 * does nothing; no web-links or image addon), OSC 8 hyperlinks inert, every window-manipulation report off
 * (`windowOptions: {}`), no bell (the page never listens to onBell), titles ignored (it never listens to
 * onTitleChange), 5000 lines of scrollback, no newline conversion, typing off unless the run takes it, and the
 * screen reader's mirror of the output (`screenReaderMode`) on only while main says a screen reader runs (review #43:
 * without it every row is aria-hidden, so a screen reader finds no output at all).
 * Type-only import: the xterm package itself is loaded only by terminal.ts.
 */

import type { ILinkHandler, ITerminalInitOnlyOptions, ITerminalOptions } from "@xterm/xterm";

/** OSC 8 links do nothing: no confirm() prompt, no window.open (a command's output must not open anything). */
export const INERT_LINKS: ILinkHandler = Object.freeze({
  activate: () => undefined,
  allowNonHttpProtocols: false,
});

/** The terminal's colours: Ember's window surface and labels; the ANSI colours are Apple's dark system palette. */
const THEME = Object.freeze({
  background: "#121011",
  foreground: "#f5f2ef",
  cursor: "#ff9230",
  cursorAccent: "#121011",
  selectionBackground: "rgba(255, 146, 48, 0.35)",
  black: "#2b2729", red: "#ff4245", green: "#30d158", yellow: "#ffd600",
  blue: "#0091ff", magenta: "#db34f2", cyan: "#5ac8f5", white: "#e5e1de",
  brightBlack: "#8e8e93", brightRed: "#ff7a71", brightGreen: "#5be37d", brightYellow: "#ffe45c",
  brightBlue: "#5eb2ff", brightMagenta: "#eea2ff", brightCyan: "#8fdcfa", brightWhite: "#ffffff",
});

/** The fixed options (§3.10). `disableStdin` is per run: see terminalOptions. */
export const XTERM_OPTIONS: Readonly<ITerminalOptions> = Object.freeze({
  allowProposedApi: false,
  allowTransparency: false,
  windowOptions: Object.freeze({}),
  linkHandler: INERT_LINKS,
  scrollback: 5000,
  convertEol: false,
  disableStdin: true,
  cursorBlink: false,
  altClickMovesCursor: false,
  rightClickSelectsWord: false,
  screenReaderMode: false,
  drawBoldTextInBrightColors: true,
  // Every colour the output asks for stays readable on the dark surface (WCAG 1.4.3).
  minimumContrastRatio: 4.5,
  fontFamily: "ui-monospace, \"SF Mono\", \"DejaVu Sans Mono\", monospace",
  fontSize: 13,
  lineHeight: 1.2,
  logLevel: "warn",
  theme: THEME,
});

/**
 * One run's options: the fixed ones, its size (fixed for the run, §3.10), typing only when the run takes it, and the
 * screen reader's mirror only while one runs.
 */
export function terminalOptions(o: { interactive: boolean; cols: number; rows: number; screenReader?: boolean }): ITerminalOptions & ITerminalInitOnlyOptions {
  const clamp = (v: number, lo: number, hi: number, d: number) => (Number.isInteger(v) && v >= lo && v <= hi ? v : d);
  return {
    ...XTERM_OPTIONS, disableStdin: !o.interactive, cols: clamp(o.cols, 20, 500, 100), rows: clamp(o.rows, 5, 200, 30), screenReaderMode: o.screenReader === true,
  };
}
