/**
 * Ember's generative UI: what a task may show on its card besides words (docs/DESIGN.md "Two bodies"). A worker never
 * sends markup or code. It sends these blocks, from this fixed catalog, which Ember checks (app/main/agent/view-schema.ts)
 * and draws with its own components (app/renderer/overlay/view.ts), as plain text. That is the approach of declarative
 * agent UIs such as A2UI: anything outside the catalog isn't drawn. Every string in a block is the model's, and may carry
 * what it read on the screen, so it is untrusted: shown as text, never as a link, a button or an instruction.
 */

/** One step of a task's plan, as its card lists it. */
export interface PlanStep { text: string; state: "done" | "now" | "todo" }

/** How a task works right now: through apps' accessibility, commands or another computer; on Ember's desk; or with the user's mouse and keyboard. */
export type TaskHand = "background" | "desk" | "cursor";

export type ViewBlock =
  | { kind: "text"; text: string }
  | { kind: "list"; items: string[]; ordered?: boolean }
  | { kind: "facts"; rows: { label: string; value: string }[] }
  | { kind: "table"; columns: string[]; rows: string[][] }
  | { kind: "file"; path: string; label?: string };

/** The catalog's limits: what fits a card, and keeps one card from folding the others away. */
export const VIEW_LIMITS = {
  blocks: 6, text: 600, items: 8, item: 200, rows: 6, columns: 3, cell: 80, label: 60, value: 200, path: 400, plan: 8, step: 80,
} as const;

/** The words of a task's plan step for screen readers, before the step ("Done: ", "Now: ", "Next: "). */
export const PLAN_WORD: Record<PlanStep["state"], string> = { done: "Done: ", now: "Now: ", todo: "Next: " };

/** How a task's card names its hand (shown under its title while it works). */
export const HAND_WORDS: Record<TaskHand, string> = {
  background: "In the background",
  desk: "On my desk",
  cursor: "Using your mouse and keyboard",
};

/** A plan as its card's steps: those before `now` done, `now` under way, the rest to come (`now` past the end: all done). */
export function planSteps(steps: readonly string[], now: number): PlanStep[] {
  return steps.map((text, i) => ({ text, state: i < now ? "done" : i === now ? "now" : "todo" }));
}

/** A view as plain text (the conversation, speech, the corner card without a compositor): lines, one per row. */
export function viewText(blocks: readonly ViewBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if (b.kind === "text") out.push(b.text);
    else if (b.kind === "list") out.push(...b.items.map((t, i) => `${b.ordered ? `${i + 1}.` : "-"} ${t}`));
    else if (b.kind === "facts") out.push(...b.rows.map(r => `${r.label}: ${r.value}`));
    else if (b.kind === "table") out.push(b.columns.join(" | "), ...b.rows.map(r => r.join(" | ")));
    else out.push(b.label ? `${b.label}: ${b.path}` : b.path);
  }
  return out.join("\n");
}
