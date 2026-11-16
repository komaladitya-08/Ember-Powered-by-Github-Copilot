/** Host-only capability for continuing a stopped review. It is never persisted, serialized or sent to the model. */
import type { CodingExportInput } from "./coding-result-export";

declare const continuationReference: unique symbol;
export interface CodingContinuationRef { readonly [continuationReference]: true }

/** The caller owns decoded buffers until the fresh workspace has copied them, including failed admission. */
export function clearCodingContinuation(input: CodingExportInput | undefined): void {
  if (!input) return;
  for (const tree of [input.baseline, input.proposed, input.current]) {
    for (const entry of tree?.entries ?? []) if (entry.kind === "file") entry.bytes.fill(0);
  }
}
