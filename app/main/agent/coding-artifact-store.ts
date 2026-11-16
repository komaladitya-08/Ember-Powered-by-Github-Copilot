/** Host-only physical storage for exact review artifacts. References are capabilities, never IPC data. */
export const CODING_ARTIFACT_MAX_BYTES = 64 * 1024 * 1024;
export const CODING_ARTIFACT_MAX_TRACKED = 64;
export const CODING_ARTIFACT_NAMES = ["changes.patch", "review.json"] as const;
export type CodingArtifactName = typeof CODING_ARTIFACT_NAMES[number];
export type CodingArtifactFiles = Readonly<Record<CodingArtifactName, Buffer>>;

declare const artifactReference: unique symbol;
declare const sourceReference: unique symbol;
export interface CodingArtifactRef { readonly [artifactReference]: true }
export interface CodingArtifactSourceRef { readonly [sourceReference]: true }
/** Intake wrappers remain mutable for legacy callers; stores snapshot both fields before admitting work. */
export interface CodingArtifactInput { directory: string; artifact?: CodingArtifactRef }
export interface CodingArtifactReceipt {
  readonly ref: CodingArtifactRef;
  readonly directory: string;
  readonly bytes: number;
  readonly files: Readonly<Record<CodingArtifactName, { readonly bytes: number; readonly sha256: string }>>;
}
export interface CodingArtifactExportResult { ok: boolean; message: string; directory?: string }
export type CodingArtifactFailure = "unsupported" | "invalid" | "stale" | "limit" | "artifact" | "destination" | "cleanup";
export const CODING_ARTIFACT_MESSAGES: Readonly<Record<CodingArtifactFailure, string>> = Object.freeze({
  unsupported: "Coding review storage is unavailable on this platform.", invalid: "The coding review registration is invalid.",
  stale: "This coding result no longer belongs to the current account and project.",
  limit: "The coding review storage limit was reached. Export or forget existing results before continuing.",
  artifact: "The private coding review changed or could not be verified.",
  destination: "Choose an ordinary local folder outside the original project and private coding review storage.",
  cleanup: "Some private coding reviews could not be removed safely; their cleanup records were retained.",
});
export class CodingResultRegistryError extends Error {
  readonly code: CodingArtifactFailure;
  constructor(code: CodingArtifactFailure) { super(CODING_ARTIFACT_MESSAGES[code]); this.code = code; this.name = "CodingResultRegistryError"; }
}
/** Terminal uncertainty is retained across registry sanitization and every subsequent cleanup caller. */
export class CodingArtifactCleanupError extends Error {
  readonly code = "coding-artifact-cleanup-unverified";
  constructor() { super(CODING_ARTIFACT_MESSAGES.cleanup); this.name = "CodingArtifactCleanupError"; }
}

export interface CodingArtifactStore {
  /** Includes retained cleanup failures and unclaimed producer artifacts. */
  readonly size: number;
  /** Platform spelling/lexical checks only; sourceBoundary supplies the native alias receipt. */
  validSourcePath(source: string): boolean;
  /** Creates fresh exact files. The producer owns the minted token until one claim or explicit discard. */
  write(files: CodingArtifactFiles, check: () => void): Promise<CodingArtifactInput & { artifact: CodingArtifactRef }>;
  /** Windows requires a minted producer token. Linux preserves its existing path-adoption boundary. */
  claim(input: CodingArtifactInput, check: () => void): Promise<CodingArtifactReceipt>;
  verify(receipt: CodingArtifactReceipt, check: () => void): Promise<void>;
  /** With expected, attest only that this exact intake capability belongs to source; never recapture a rebound path. */
  sourceBoundary(source: string, check: () => void, expected?: CodingArtifactSourceRef): Promise<CodingArtifactSourceRef | null>;
  export(receipt: CodingArtifactReceipt, source: CodingArtifactSourceRef | null, destination: string, check: () => void): Promise<CodingArtifactExportResult>;
  discard(input: CodingArtifactInput): Promise<void>;
  /** Removes unretained claimed artifacts and failed exports; live producer tokens remain producer-owned. */
  cleanup(retained: ReadonlySet<CodingArtifactRef>): Promise<void>;
  /** Revokes every producer and waits for all known physical cleanup/handle ownership. */
  close(): Promise<void>;
}
