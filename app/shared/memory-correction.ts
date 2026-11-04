/** A Home correction names the exact owned fact shown; it cannot create facts or change their source authority. */
import { z } from "zod";

/** Main validates the complete record and current account view before committing a local correction. */
export const MemoryCorrectionSchema = z.object({
  expected: z.object({
    id: z.string().min(1).max(40), text: z.string().min(1).max(400),
    source: z.enum(["user", "conversation", "task", "observed", "connector"]), at: z.string().min(10).max(40),
    revision: z.number().int().nonnegative().safe().optional(), correctedAt: z.string().min(10).max(40).optional(),
  }).strict(),
  epoch: z.number().int().nonnegative().safe(),
  text: z.string().trim().min(1).max(400),
}).strict();
export type MemoryCorrection = z.infer<typeof MemoryCorrectionSchema>;
