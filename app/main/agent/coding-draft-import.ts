/** Explicit fresh-folder import preparation. It creates only a stopped private review, never a model request. */
import { randomUUID } from "node:crypto";
import { CodingDraftImportConflictError } from "./coding-draft-import-data";
import type { CodingDraftOwner, CodingDraftMetadata } from "./coding-draft-format";
import { CodingDraftError } from "./coding-draft-format";
import { readOpenedCodingDraft, type OpenCodingDraft } from "./coding-draft-store";
import { checkCodingDraft } from "./coding-draft-codec";
import { issueCodingDraftImportSeed, type CodingDraftImportSeed } from "./coding-draft-import-seed";
import type { CodingArtifactSourceRef, CodingArtifactStore } from "./coding-artifact-store";
import type { CodingExportBinding, CodingExportInput } from "./coding-result-export";
import type { CodingResultSummary } from "../../shared/project-coding";
import { clearCodingContinuation } from "./coding-continuation";

export interface CodingDraftFreshCapture { document: Buffer; binding: CodingExportBinding; store: CodingArtifactStore; source: CodingArtifactSourceRef }
export type CodingDraftImportResult = { ok: false; message: string } | { ok: true; result: CodingResultSummary; context: CodingDraftMetadata["context"] };
/** Resource adapters own every temporary copy/artifact; this helper owns transient documents and the import seed. */
export async function prepareCodingDraftImport(input: {
  draft: OpenCodingDraft; owner: CodingDraftOwner; projectId: string; path: string; signal: AbortSignal; current(): boolean;
  capture(): Promise<CodingDraftFreshCapture>;
  produce(seed: CodingDraftImportSeed): Promise<CodingResultSummary>;
}): Promise<CodingDraftImportResult> {
  const check = () => { if (input.signal.aborted || input.current() !== true || input.signal.aborted) throw new CodingDraftError("stale"); };
  let document: Buffer | undefined, fresh: CodingDraftFreshCapture | undefined, data: CodingExportInput | undefined, seed: CodingDraftImportSeed | undefined;
  try {
    check(); const opened = readOpenedCodingDraft(input.draft), metadata = opened.metadata; document = opened.document;
    if (metadata.owner.library !== input.owner.library || metadata.owner.holder !== input.owner.holder) throw new CodingDraftError("holder");
    check(); fresh = await input.capture(); check();
    const freshMetadata: CodingDraftMetadata = { ...metadata, id: randomUUID(), name: "Fresh source capture", sourceLabel: "", savedAt: Date.now(),
      context: { request: "", summary: "" }, historicalChecks: { ran: 0, passed: 0, failed: 0 }, binding: fresh.binding };
    const result = await checkCodingDraft(metadata, document, check, input.signal, false, { metadata: freshMetadata, document: fresh.document });
    if (result.imported?.kind === "ready") data = result.imported.data;
    check();
    if (!result.imported) throw new CodingDraftError("invalid");
    if (result.imported.kind === "conflicts") return { ok: false,
      message: `${result.imported.count} saved changes conflict with the selected folder. No import was prepared. The saved draft is unchanged.` };
    data = result.imported.data;
    // Worker structured cloning produces Uint8Arrays; reconstitute owned byte views before the existing seed broker.
    for (const tree of [data.baseline, data.proposed, data.current]) for (const entry of tree?.entries ?? []) if (entry.kind === "file") entry.bytes = Buffer.from(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength);
    seed = issueCodingDraftImportSeed({ data, store: fresh.store, source: fresh.source, projectId: input.projectId, path: input.path, owner: input.owner.holder, current: input.current }); data = undefined;
    const review = await input.produce(seed); check(); return { ok: true, result: review, context: { ...metadata.context } };
  } catch (error) {
    if (error instanceof CodingDraftImportConflictError) return { ok: false, message: error.message };
    throw error;
  } finally { document?.fill(0); fresh?.document.fill(0); clearCodingContinuation(data); seed?.close(); }
}
