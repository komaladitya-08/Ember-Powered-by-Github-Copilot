/**
 * The zod schema of Ember's generative UI catalog (app/shared/view.ts): what a worker's finish_task `view` may hold,
 * checked before anything reaches a card. A block outside the catalog, or past its limits, fails the call with a plain
 * message, so the model sends a smaller one. Kept in main: the renderer only draws checked blocks.
 *
 * An excerpt (lines of a file) is the one block that quotes a file as it is, so it is refused whole, never shown
 * redacted, when a line holds a secret (memoryRefusal: a token, a key, a card number, "password: …") or its path is
 * one where secrets live (Ember's own data, SSH and GPG keys, keyrings, password stores). Fail closed, as memory does.
 */

import { z } from "zod";
import { VIEW_LIMITS as L, type ViewBlock } from "../../shared/view";
import { memoryRefusal } from "../memory/guard";

const line = (max: number) => z.string().trim().min(1).max(max);

/**
 * Folders whose files an excerpt never shows: Ember's data folder on each OS, SSH and GPG keys, keyrings and password
 * stores, and the system's password files. A path written either way round (/ or \) matches.
 */
const PRIVATE_PATH = new RegExp([
  String.raw`(^|[\\/])\.config[\\/]ember([\\/]|$)`,
  String.raw`AppData[\\/]Local[\\/]ember([\\/]|$)`,
  String.raw`Application Support[\\/]ember([\\/]|$)`,
  String.raw`(^|[\\/])\.(ssh|gnupg|password-store|aws|kube|docker)([\\/]|$)`,
  String.raw`(^|[\\/])keyrings?([\\/]|$)`,
  String.raw`(^|[\\/])Keychains([\\/]|$)`,
  String.raw`^/etc/(shadow|gshadow|sudoers)`,
  String.raw`(^|[\\/])\.(netrc|pgpass|git-credentials|npmrc|pypirc)$`,
  String.raw`(^|[\\/])\.env(\.[\w-]+)?$`,
  String.raw`\.(pem|key|p12|pfx|kdbx)$`,
].join("|"), "i");

/** Why an excerpt may not be shown, or null when it may (a secret in a line, or a private place). */
export function excerptRefusal(path: string, lines: readonly string[]): string | null {
  if (PRIVATE_PATH.test(path.trim())) return "that file is in a place where passwords and keys are kept, so Ember doesn't show it";
  for (const l of lines) {
    const why = memoryRefusal(l);
    if (why) return `${why}, so Ember doesn't show it`;
  }
  return memoryRefusal(lines.join("\n")) ? "it holds a password, token or key, so Ember doesn't show it" : null;
}

const whole = z.number().int().min(0).max(L.total);

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
  z.object({ kind: z.literal("checklist"), items: z.array(z.object({ text: line(L.item), done: z.boolean() })).min(1).max(L.items) }),
  z.object({ kind: z.literal("progress"), label: line(L.label), value: whole, total: whole.min(1) })
    .refine(p => p.value <= p.total, "value can't be more than total"),
  z.object({
    kind: z.literal("compare"),
    columns: z.tuple([line(L.cell), line(L.cell)]),
    rows: z.array(z.object({ label: line(L.label), a: z.string().trim().max(L.cell), b: z.string().trim().max(L.cell) })).min(1).max(L.rows),
  }),
  z.object({ kind: z.literal("excerpt"), path: line(L.path), lines: z.array(z.string().max(L.line)).min(1).max(L.lines) })
    .superRefine((x, ctx) => {
      const why = excerptRefusal(x.path, x.lines);
      if (why) ctx.addIssue({ code: "custom", message: `the excerpt can't be shown: ${why}. Leave it out` });
    }),
  z.object({ kind: z.literal("status"), tone: z.enum(["ok", "warn", "fail"]), text: line(L.item) }),
]);

/** A whole view: 1 to VIEW_LIMITS.blocks blocks. */
export const ViewSchema = z.array(ViewBlockSchema).min(1).max(L.blocks);

/** A plan as report_progress takes it: its steps, in order. */
export const PlanSchema = z.array(line(L.step)).min(1).max(L.plan);

// The schema and the catalog's type stay one: a block the schema accepts is a ViewBlock.
export type CheckedView = z.infer<typeof ViewSchema>;
const _same = (v: CheckedView): ViewBlock[] => v;
void _same;
