/**
 * One run's terminal in the command window: @xterm/xterm 5.5.0 with exactly terminal-options.ts's options. It writes
 * the run's raw output into its own element only, sends what the user types (and xterm's own replies to terminal
 * queries) to `onInput` only while the run takes typing, and listens to nothing else: no title changes, no bell, no
 * links, and nothing a program prints can reach the clipboard (no OSC 52). Its keys are keys.ts's: Tab moves the focus,
 * and the user's own Ctrl+V, Ctrl+C and Ctrl+Shift+C paste and copy. This is the only module that loads xterm, so the
 * page's pure modules stay testable in Node.
 */

import { Terminal } from "@xterm/xterm";
import { termKeyAction } from "./keys";
import { XTERM_OPTIONS, termFontSize, terminalOptions } from "./terminal-options";
import { inputAtGrid } from "./terminal-size";

/** A run's terminal, written to before or after it is shown. */
export interface RunTerminal {
  write(bytes: Uint8Array): void;
  /** Puts it in `host` (once, the first time its tab shows: xterm measures its font there). */
  open(host: HTMLElement): void;
  readonly opened: boolean;
  setInteractive(on: boolean): void;
  /** Mirrors its output for a screen reader (review #43), while one runs. */
  setScreenReader(on: boolean): void;
  /** Draws its type at the page's text scale (its columns and rows stay as the run started, §3.10). */
  setTextScale(scale: number): void;
  /** Puts the keyboard in it (once open), so what the user types goes to the run. */
  focus(): void;
  /** Copies everything it shows, scrollback included, to the clipboard (the Copy output button); false if it couldn't. */
  copyAll(): boolean;
  /** Redraws after its tab shows again. */
  refresh(): void;
  dispose(): void;
}

/**
 * Puts `text` on the clipboard from a user's own click or key: the browser's copy command, its data set by a one-off
 * copy listener (the page never uses the async Clipboard API, and nothing a program prints gets here). False if it couldn't.
 */
function copyText(text: string): boolean {
  if (!text) return false;
  const onCopy = (ev: ClipboardEvent): void => {
    ev.clipboardData?.setData("text/plain", text);
    ev.preventDefault();
    ev.stopImmediatePropagation();
  };
  document.addEventListener("copy", onCopy, true);
  try {
    // The one clipboard write a sandboxed page may make, on the user's own click or key.
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    document.removeEventListener("copy", onCopy, true);
  }
}

/**
 * A terminal for one run, at the run's size (fixed for the run, §3.10). `mac`: the Mac's keys (keys.ts). `scale`: the
 * page's text scale, which its type follows.
 */
export function createRunTerminal(o: { cols: number; rows: number; interactive: boolean; mac: boolean; screenReader: boolean; scale: number; onInput: (data: string) => void }): RunTerminal {
  let interactive = o.interactive;
  let screenReader = o.screenReader;
  const term = new Terminal(terminalOptions({ interactive, cols: o.cols, rows: o.rows, screenReader, scale: o.scale }));
  // Typing and xterm's answers to queries (cursor position, device attributes) go to the run, and only while it takes them.
  const sub = term.onData(data => { if (interactive) o.onInput(data); });
  // Tab and Shift+Tab move the focus, never into the run; paste and copy are the user's (keys.ts). xterm handles the rest.
  term.attachCustomKeyEventHandler(e => {
    const action = termKeyAction(e, { mac: o.mac, hasSelection: term.hasSelection() });
    if (action === "terminal") return true;
    if (action === "copy" && e.type === "keydown") {
      e.preventDefault();
      copyText(term.getSelection());
    }
    return false;
  });
  let opened = false;
  // xterm's mirror for a screen reader misses what the first render drew: a redraw shortly after output keeps it whole.
  let mirrorTimer: ReturnType<typeof setTimeout> | null = null;
  const refreshMirror = () => {
    if (!screenReader || mirrorTimer) return;
    mirrorTimer = setTimeout(() => { mirrorTimer = null; if (opened) term.refresh(0, term.rows - 1); }, 150);
  };
  // The grid xterm draws, in CSS px (its screen element, which it sizes to its columns times its cell): 0 x 0 until it opens.
  const gridSize = (): { width: number; height: number } => {
    const screen = term.element?.querySelector<HTMLElement>(".xterm-screen");
    return { width: Number.parseFloat(screen?.style.width ?? "") || 0, height: Number.parseFloat(screen?.style.height ?? "") || 0 };
  };
  // A run that can't take typing keeps its terminal's input out of the Tab order, and says it is read-only: there is
  // nothing to type there.
  const tabStop = () => {
    if (!term.textarea) return;
    term.textarea.tabIndex = interactive ? 0 : -1;
    term.textarea.setAttribute("aria-readonly", String(!interactive));
  };
  return {
    write: bytes => term.write(bytes, refreshMirror),
    open(host) {
      if (opened) return;
      opened = true;
      term.open(host);
      tabStop();
      refreshMirror();
    },
    get opened() { return opened; },
    setInteractive(on) {
      if (on === interactive) return;
      interactive = on;
      term.options.disableStdin = !on;
      tabStop();
    },
    setScreenReader(on) {
      if (on === screenReader) return;
      screenReader = on;
      term.options.screenReaderMode = on;
      refreshMirror();
    },
    setTextScale(scale) {
      const px = termFontSize(scale);
      if (term.options.fontSize === px) return;
      const before = gridSize();
      // xterm measures its cells again and redraws at the new size, at once.
      term.options.fontSize = px;
      // It moves its hidden input to the cursor's cell only when the cursor moves, so after a smaller type the input
      // stayed at the old cell's place, past the grid, and the box scrolled into empty space (for good, for a run that
      // has finished). Put it on the same cell at the new size.
      if (term.textarea) Object.assign(term.textarea.style, inputAtGrid(term.textarea.style, before, gridSize()));
    },
    focus: () => { if (opened) term.focus(); },
    copyAll() {
      const buf = term.buffer.active;
      const lines: string[] = [];
      for (let i = 0; i < buf.length; i++) {
        const line = buf.getLine(i);
        if (!line) continue;
        const text = line.translateToString(true);
        // A row that continues the one above (a long line wrapped) joins it.
        if (line.isWrapped && lines.length) lines[lines.length - 1] += text;
        else lines.push(text);
      }
      while (lines.length && lines[lines.length - 1] === "") lines.pop();
      return copyText(lines.join("\n"));
    },
    refresh: () => { if (opened) term.refresh(0, term.rows - 1); },
    dispose() {
      if (mirrorTimer) clearTimeout(mirrorTimer);
      sub.dispose();
      term.dispose();
    },
  };
}

/**
 * One character cell of the terminal's font at the page's text scale, measured with a hidden line of it in `host` (CSS
 * px), or null.
 */
export function cellSize(host: HTMLElement, scale: number): { width: number; height: number } | null {
  const probe = document.createElement("span");
  probe.textContent = "W".repeat(40);
  probe.setAttribute("aria-hidden", "true");
  Object.assign(probe.style, {
    position: "absolute", visibility: "hidden", whiteSpace: "pre", lineHeight: "normal",
    fontFamily: XTERM_OPTIONS.fontFamily ?? "monospace", fontSize: `${termFontSize(scale)}px`,
  });
  host.appendChild(probe);
  const r = probe.getBoundingClientRect();
  probe.remove();
  if (!r.width || !r.height) return null;
  return { width: r.width / 40, height: Math.ceil(r.height * (XTERM_OPTIONS.lineHeight ?? 1)) };
}
