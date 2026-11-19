/** Host-only snapshots of exact verified stopped review artifacts. No stopped boolean or arbitrary directory is accepted. */
import type { CodingArtifactReceipt, CodingArtifactSourceRef, CodingArtifactStore } from "./coding-artifact-store";
import { CodingDraftError, CODING_DRAFT_MAX_REVIEW_BYTES, type CodingDraftMetadata } from "./coding-draft-format";
import { checkCodingDraft } from "./coding-draft-codec";

declare const snapshotBrand: unique symbol;
export interface CodingDraftSnapshot { readonly [snapshotBrand]: true; close(): void }
export interface CodingDraftSourceWitness { store: CodingArtifactStore; source: CodingArtifactSourceRef; current(): boolean }
interface Snapshot { document: Buffer; metadata: CodingDraftMetadata; source?: CodingDraftSourceWitness; current(): void; closed: boolean }
const snapshots = new WeakMap<CodingDraftSnapshot, Snapshot>();

/** The receipt must already belong to the trusted artifact store. This function never claims a running directory. */
export async function captureCodingDraftSnapshot(input: {
  store: CodingArtifactStore; artifact: CodingArtifactReceipt; metadata: CodingDraftMetadata;
  source?: CodingArtifactSourceRef; current(): boolean; signal?: AbortSignal;
  /** Owning source/account lifetime, distinct from this save generation. Trusted store capture supplies it. */
  sourceCurrent?(): boolean;
}): Promise<CodingDraftSnapshot> {
  const store = input.store, artifact = input.artifact, metadata = structuredClone(input.metadata), source = input.source;
  const selectedCurrent = input.current.bind(input), sourceCurrent = input.sourceCurrent?.bind(input) ?? selectedCurrent, signal = input.signal;
  const current = () => {
    try { if (signal?.aborted || selectedCurrent() !== true || signal?.aborted) throw new Error(); }
    catch { throw new CodingDraftError("stale"); }
  };
  let document: Buffer | undefined;
  try {
    current(); await store.verify(artifact, current); current();
    document = await store.read(artifact, "review.json", CODING_DRAFT_MAX_REVIEW_BYTES, current); current();
    const checked = await checkCodingDraft(metadata, document, current, signal); current();
    const state: Snapshot = { document, metadata: checked.metadata, current, closed: false,
      ...(source ? { source: { store, source, current: () => { try { return !signal?.aborted && sourceCurrent() === true && !signal?.aborted; } catch { return false; } } } } : {}) };
    const token = Object.freeze({ close() {
      state.closed = true; state.document.fill(0); state.document = Buffer.alloc(0); state.source = undefined;
      state.metadata = { ...state.metadata, name: "", sourceLabel: "", context: { request: "", summary: "" } };
      state.current = () => { throw new CodingDraftError("stale"); };
    } }) as CodingDraftSnapshot;
    snapshots.set(token, state); document = undefined; return token;
  } finally { document?.fill(0); }
}

/** Internal host transfer. A forged object, even one copying the public methods, carries no snapshot. */
export function codingDraftSnapshotData(token: CodingDraftSnapshot): { document: Buffer; metadata: CodingDraftMetadata; source?: CodingDraftSourceWitness } {
  const state = snapshots.get(token);
  if (!state || state.closed) throw new CodingDraftError("invalid");
  state.current();
  return { document: Buffer.from(state.document), metadata: structuredClone(state.metadata), ...(state.source ? { source: state.source } : {}) };
}
