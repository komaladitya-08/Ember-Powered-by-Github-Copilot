/** Home reminder edits are exact, bounded local requests; they cannot create or run a task. */
import { z } from "zod";

/** The complete reminder shown by Home, for stale-edit protection. */
const ReminderIdentity = z.object({
  id: z.string().min(1).max(20), text: z.string().min(1).max(200),
  at: z.number().int().safe(), created: z.number().int().safe(),
}).strict();

/** A pointer/keyboard decision to cancel or revise exactly one waiting reminder. */
export const ReminderChangeSchema = z.object({
  expected: ReminderIdentity,
  replacement: z.object({ text: z.string().trim().min(1).max(200), at: z.number().int().safe() }).strict().nullable(),
}).strict();
