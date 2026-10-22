/**
 * One run's terminal in the command window: @xterm/xterm 5.5.0 with exactly terminal-options.ts's options. It writes
 * the run's raw output into its own element only, sends what the user types (and xterm's own replies to terminal
 * queries) to `onInput` only while the run takes typing, and listens to nothing else: no title changes, no bell, no
 * links, no clipboard. This is the only module that loads xterm, so the page's pure modules stay testable in Node.
 */

import { Terminal } from "@xterm/xterm";
import { XTERM_OPTIONS, terminalOptions } from "./terminal-options";

/** A run's terminal, written to before or after it is shown. */
export interface RunTerminal {
  write(bytes: Uint8Array): void;
  /** Puts it in `host` (once, the first time its tab shows: xterm measures its font there). */
  open(host: HTMLElement): void;
  readonly opened: boolean;
  setInteractive(on: boolean): void;
  /** Redraws after its tab shows again. */
  refresh(): void;
  dispose(): void;
}

/** A terminal for one run, at the run's size (fixed for the run, §3.10). */
export function createRunTerminal(o: { cols: number; rows: number; interactive: boolean; onInput: (data: string) => void }): RunTerminal {
  let interactive = o.interactive;
  const term = new Terminal(terminalOptions({ interactive, cols: o.cols, rows: o.rows }));
  // Typing and xterm's answers to queries (cursor position, device attributes) go to the run, and only while it takes them.
  const sub = term.onData(data => { if (interactive) o.onInput(data); });
  let opened = false;
  return {
    write: bytes => term.write(bytes),
    open(host) {
      if (opened) return;
      opened = true;
      term.open(host);
    },
    get opened() { return opened; },
    setInteractive(on) {
      if (on === interactive) return;
      interactive = on;
      term.options.disableStdin = !on;
    },
    refresh: () => { if (opened) term.refresh(0, term.rows - 1); },
    dispose() {
      sub.dispose();
      term.dispose();
    },
  };
}

/** One character cell of the terminal's font, measured with a hidden line of it in `host` (CSS px), or null. */
export function cellSize(host: HTMLElement): { width: number; height: number } | null {
  const probe = document.createElement("span");
  probe.textContent = "W".repeat(40);
  probe.setAttribute("aria-hidden", "true");
  Object.assign(probe.style, {
    position: "absolute", visibility: "hidden", whiteSpace: "pre", lineHeight: "normal",
    fontFamily: XTERM_OPTIONS.fontFamily ?? "monospace", fontSize: `${XTERM_OPTIONS.fontSize ?? 13}px`,
  });
  host.appendChild(probe);
  const r = probe.getBoundingClientRect();
  probe.remove();
  if (!r.width || !r.height) return null;
  return { width: r.width / 40, height: Math.ceil(r.height * (XTERM_OPTIONS.lineHeight ?? 1)) };
}

/**
 * How many columns and rows fit a run's terminal in a window `width` × `height` CSS px with nothing above it but the
 * tab's own parts (what new runs start at: a card shown for the moment doesn't make them smaller). A column and a few
 * pixels are left over so the last column and row are never cut.
 */
export function fitTerminal(cell: { width: number; height: number }, width: number, height: number): { cols: number; rows: number } {
  const cols = Math.floor((width - 16) / cell.width) - 1;
  const rows = Math.floor((height - 8) / cell.height);
  return { cols: Math.max(20, Math.min(500, cols)), rows: Math.max(5, Math.min(200, rows)) };
}
