/** What the corner card (no compositor) shows: pure, so it is unit-tested. */

import type { BubbleMood } from "@ember/bubble";
import type { BubbleState, TaskCard } from "../../shared/overlay";

/** A short name for what the bubble is, when its title is just the character's name. */
const KIND: Record<BubbleMood, string> = {
  idle: "Answer",
  listening: "Listening…",
  thinking: "Thinking…",
  acting: "Working…",
  guiding: "Showing you",
  attention: "Needs you",
  error: "Problem",
  done: "Done",
};

/**
 * The card's bold line and the text under it. An answer's title is the
 * character's name, already shown above the line, so the line names what it is
 * ("Answer", "Problem") and the words go in the text area, never in the line.
 * The same goes for a title that is the task shown on the card's task row.
 */
export function cardText(b: BubbleState, name: string, status: string | null, taskTitle?: string): { line: string; thought: string } {
  if (!b.visible) return { line: status ?? "Ready", thought: "" };
  const title = b.title.trim();
  // The task's title is already on its row at the bottom of the card: the line says what Ember is doing instead.
  const said = title && title !== name && title !== taskTitle;
  const line = said ? title : b.mood === "idle" && b.streaming ? "Answering…" : KIND[b.mood];
  return { line, thought: b.thought };
}

/**
 * The one task the card shows: the newest that is still under way (it has
 * Stop), else the newest that has something to click (a failure's Close).
 */
export function cardTask(tasks: readonly TaskCard[]): TaskCard | null {
  const newest = [...tasks].reverse();
  return newest.find(t => t.status === "running" || t.status === "waiting")
    ?? newest.find(t => (t.actions ?? []).length > 0)
    ?? null;
}
