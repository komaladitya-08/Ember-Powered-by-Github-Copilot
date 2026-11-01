/**
 * The zod schema of Ember's generative UI catalog (app/shared/view.ts): what a worker's finish_task `view` may hold,
 * checked before anything reaches a card. A block outside the catalog, or past its limits, fails the call with a plain
 * message, so the model sends a smaller one. Kept in main: the renderer only draws checked blocks.
 */

import { z } from "zod";
import { VIEW_LIMITS as L, type ViewBlock } from "../../shared/view";

const line = (max: number) => z.string().trim().min(1).max(max);

export const ViewBlockSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), text: line(L.text) }),
  z.object({ kind: z.literal("list"), items: z.array(line(L.item)).min(1).max(L.items), ordered: z.boolean().optional() }),
  z.object({ kind: z.literal("facts"), rows: z.array(z.object({ label: line(L.label), value: line(L.value) })).min(1).max(L.items) }),
  z.object({
    kind: z.literal("table"),
    columns: z.array(line(L.cell)).min(1).max(L.columns),
    rows: z.array(z.array(z.string().trim().max(L.cell)).min(1).max(L.columns)).min(1).max(L.rows),
  }).refine(t => t.rows.every(r => r.length === t.columns.length), "every row needs one cell per column"),
  z.object({ kind: z.literal("file"), path: line(L.path), label: line(L.label).optional() }),
]);

/** A whole view: 1 to VIEW_LIMITS.blocks blocks. */
export const ViewSchema = z.array(ViewBlockSchema).min(1).max(L.blocks);

/** A plan as report_progress takes it: its steps, in order. */
export const PlanSchema = z.array(line(L.step)).min(1).max(L.plan);

// The schema and the catalog's type stay one: a block the schema accepts is a ViewBlock.
export type CheckedView = z.infer<typeof ViewSchema>;
const _same = (v: CheckedView): ViewBlock[] => v;
void _same;
