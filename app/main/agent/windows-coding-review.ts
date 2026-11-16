/** Host-only sealed-review ownership. A producer is transferred synchronously before its new owner awaits publication. */
import { CodingArtifactCleanupError, CodingResultRegistryError, type CodingArtifactStore, type CodingArtifactRef, type CodingArtifactSourceRef } from "./coding-artifact-store";
import type { CodingWorkspaceReview } from "./coding-platform";
import type { CodingExportTree } from "./coding-result-export";

export type WindowsCodingReviewOutput = CodingWorkspaceReview & { artifact: CodingArtifactRef };
export interface WindowsCodingReviewProducer {
  readonly output: WindowsCodingReviewOutput;
  readonly sourceBoundary: CodingArtifactSourceRef;
  readonly owned: boolean;
  /** Record the returned exact capability in the host ledger before the next await. Consumed only once. */
  transfer(): WindowsCodingReviewOutput;
  /** Reclaim an untransferred artifact only. The store retains physical ownership until verified removal. */
  discard(): Promise<void>;
}

/** No native handles or caller-owned mutable byte trees enter the handoff receipt. */
export function ownWindowsCodingReview(store: Pick<CodingArtifactStore, "discard">, output: WindowsCodingReviewOutput,
  sourceBoundary: CodingArtifactSourceRef, check: () => void): WindowsCodingReviewProducer {
  let owned = true, disposalStarted = false, terminal: CodingArtifactCleanupError | null = null, discarding: Promise<void> | null = null;
  const freeze = (value: object): void => {
    for (const child of Object.values(value)) if (child && typeof child === "object") freeze(child);
    Object.freeze(value);
  };
  freeze(output.review);
  const receipt = Object.freeze({ ...output });
  return Object.freeze({ output: receipt, sourceBoundary,
    get owned() { return owned; },
    transfer() {
      if (!owned || disposalStarted) throw new CodingResultRegistryError("invalid");
      check();
      if (!owned || disposalStarted) throw new CodingResultRegistryError("invalid");
      owned = false; return receipt;
    },
    discard() {
      if (!owned) return Promise.resolve();
      if (terminal) return Promise.reject(terminal);
      if (!discarding) {
        disposalStarted = true;
        // Retain the exact capability before any asynchronous store operation.
        const input = { directory: receipt.directory, artifact: receipt.artifact };
        discarding = Promise.resolve().then(() => store.discard(input)).then(() => { owned = false; });
        void discarding.catch(error => { if (error instanceof CodingArtifactCleanupError) terminal = error; discarding = null; });
      }
      return discarding;
    },
  });
}

/** Clear every retained full-file buffer, including unchanged and binary files. */
export function clearWindowsCodingTree(tree?: Pick<CodingExportTree, "entries">): void {
  for (const entry of tree?.entries ?? []) if (entry.kind === "file") entry.bytes.fill(0);
}
