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
 * The one task the card shows: the one under way whose bubble is up (its work or its question: the
 * bubble names its task, or failing that is titled with it), so the Stop under it stops what the user
 * sees; else the newest still under way (it has Stop), else the newest that has something to click (a
 * failure's Close).
 */
export function cardTask(tasks: readonly TaskCard[], bubble?: Pick<BubbleState, "title" | "task">): TaskCard | null {
  const newest = [...tasks].reverse();
  const busy = (t: TaskCard) => t.status === "running" || t.status === "queued" || t.status === "waiting";
  return (bubble?.task ? newest.find(t => busy(t) && t.id === bubble.task) : undefined)
    ?? (bubble?.title ? newest.find(t => busy(t) && t.title === bubble.title) : undefined)
    ?? newest.find(busy)
    ?? newest.find(t => (t.actions ?? []).length > 0)
    ?? null;
}

/**
 * The card shows Ember's own announcement of a step it took without asking (BubbleState.autonomous): its "Without
 * asking" tag beside Ember's name, as the bubble shows it beside its state.
 */
export function cardAutonomous(b: Pick<BubbleState, "visible" | "autonomous">): boolean {
  return b.visible && b.autonomous === true;
}

/**
 * The card shows a risky question (policy's risky, BubbleState.risky): its "Risky step" tag and a bordered Allow, as the
 * bubble shows one. Only a question on screen is one; a risky flag left on another bubble isn't.
 */
export function cardRisky(b: Pick<BubbleState, "visible" | "mood" | "risky">): boolean {
  return b.visible && b.mood === "attention" && b.risky === true;
}
