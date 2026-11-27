/**
 * "Show in transcript" for the panel's tabs: the transcript's row of a tool call, scrolled to and focused, so a screen
 * reader lands on it. Where the panel lies over the transcript (a window narrower than 1080 px, styles.css) it is
 * closed first, or the row would be under it. A sub-agent's own tool call is shown by the sub-agent's row, which holds it.
 */
import type { CodeApp } from "./app";

/** The transcript row's key for a tool call: its own, or the sub-agent's that ran it (null: not in the transcript). */
export function rowKeyFor(app: CodeApp, sessionId: string, toolCallId: string): string | null {
  const items = app.state.transcripts[sessionId]?.items ?? [];
  const find = (id: string) => items.find(i => i.kind === "tool" && i.toolCallId === id);
  let item = find(toolCallId);
  // Nested rows are drawn inside their sub-agent's: go up to the one at the top.
  for (let hops = 0; item?.owner && hops < 8; hops++) {
    const up = find(item.owner);
    if (!up) break;
    item = up;
  }
  return item?.key ?? null;
}

/** Scroll to and focus the transcript's row `key`; false when it isn't drawn. */
export function revealInTranscript(app: CodeApp, key: string): boolean {
  if (window.matchMedia("(max-width: 1079px)").matches) { app.setUi({ panelOpen: false }); app.draw(); }
  const row = document.querySelector<HTMLElement>(`#transcript li[data-key="${CSS.escape(key)}"]`);
  if (!row) return false;
  const target = row.querySelector<HTMLElement>(".tool, .card, .msg") ?? row;
  if (!target.hasAttribute("tabindex")) target.tabIndex = -1;
  target.scrollIntoView({ block: "center" });
  // focusVisible: the press may have been a click, and the row must still show where focus went.
  target.focus({ preventScroll: true, focusVisible: true } as FocusOptions);
  return true;
}
