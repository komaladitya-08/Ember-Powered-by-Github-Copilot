/** Correction authorisation is synchronous with the durable graph commit, and bound to the shown account view. */
import { MemoryCorrectionSchema } from "../../shared/memory-correction";
import type { MemoryItem } from "./service";

/** A trusted Home sender can correct an existing fact only while its own account and memory consent are in force. */
export function correctMemoryRequest(sent: unknown, context: {
  ready: boolean; inForce: boolean; epoch: number;
  correct(expected: MemoryItem, text: string): MemoryItem;
}): MemoryItem {
  if (!context.ready || !context.inForce) throw new Error("Ember couldn't save this correction. Turn on memory for your verified account, then try again.");
  const parsed = MemoryCorrectionSchema.safeParse(sent);
  if (!parsed.success || parsed.data.epoch !== context.epoch) throw new Error("This memory changed. Cancel the correction and open it again to review the current memory.");
  return context.correct(parsed.data.expected, parsed.data.text);
}
