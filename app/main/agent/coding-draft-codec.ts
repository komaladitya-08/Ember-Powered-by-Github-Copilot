/** One bounded trusted worker per draft operation. Missing build-time code refuses storage; no runtime path fallback. */
import { Worker } from "node:worker_threads";
import { CodingDraftCleanupError, CodingDraftError, codingDraftMetadata, CODING_DRAFT_MAX_REVIEW_BYTES, type CodingDraftMetadata, type CodingDraftPreview } from "./coding-draft-format";
import type { CodingDraftImportData } from "./coding-draft-import-data";
import type { CodingExportInput } from "./coding-result-export";
declare const __EMBER_CODING_DRAFT_WORKER_SOURCE__: string;
let active = 0;
let broken = false;
const retained = new Set<Worker>();

/** Always observes thread termination before delivering data, cancellation or validation failure. */
export async function checkCodingDraft(metadata: unknown, document: Buffer, current: () => void, signal?: AbortSignal, decode = false, fresh?: { metadata: CodingDraftMetadata; document: Buffer }): Promise<{ metadata: CodingDraftMetadata; decoded?: CodingExportInput; imported?: CodingDraftImportData; preview?: CodingDraftPreview }> {
  current(); signal?.throwIfAborted();
  if (broken) throw new CodingDraftCleanupError();
  const parsed = codingDraftMetadata.safeParse(metadata);
  if (!parsed.success) throw new CodingDraftError("invalid");
  if (document.length > CODING_DRAFT_MAX_REVIEW_BYTES || fresh && (!Buffer.isBuffer(fresh.document) || fresh.document.length > CODING_DRAFT_MAX_REVIEW_BYTES || !codingDraftMetadata.safeParse(fresh.metadata).success) || active >= 2) throw new CodingDraftError("limit");
  if (typeof __EMBER_CODING_DRAFT_WORKER_SOURCE__ !== "string" || !__EMBER_CODING_DRAFT_WORKER_SOURCE__) throw new CodingDraftError("unavailable");
  active++;
  let worker: Worker | undefined;
  let result: { metadata: CodingDraftMetadata; decoded?: CodingExportInput; imported?: CodingDraftImportData; preview?: CodingDraftPreview } | undefined, failed = false, failure: unknown;
  try {
  try {
    worker = new Worker(__EMBER_CODING_DRAFT_WORKER_SOURCE__, { eval: true, env: {}, execArgv: [], argv: [], stdout: true, stderr: true,
      resourceLimits: { maxOldGenerationSizeMb: 512, stackSizeMb: 4 } });
    worker.stdout?.resume(); worker.stderr?.resume();
    const owned = worker;
    result = await new Promise<{ metadata: CodingDraftMetadata; decoded?: CodingExportInput; imported?: CodingDraftImportData; preview?: CodingDraftPreview }>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown, value?: { metadata: CodingDraftMetadata; decoded?: CodingExportInput; imported?: CodingDraftImportData; preview?: CodingDraftPreview }) => {
        if (settled) return; settled = true; clearTimeout(deadline); clearInterval(watch); signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(value!);
      };
      const abort = () => finish(new CodingDraftError("stale"));
      const deadline = setTimeout(() => finish(new CodingDraftError("invalid")), 30_000);
      const watch = setInterval(() => { try { current(); } catch (error) { finish(error); } }, 50);
      deadline.unref(); watch.unref(); signal?.addEventListener("abort", abort, { once: true });
      owned.once("error", () => finish(new CodingDraftError("invalid")));
      owned.once("exit", () => finish(new CodingDraftError("invalid")));
      owned.once("message", (message: unknown) => {
        const value = message as { ok?: unknown; code?: unknown; metadata?: CodingDraftMetadata; decoded?: CodingExportInput; imported?: CodingDraftImportData; preview?: CodingDraftPreview } | null;
        if (value?.ok === true && value.metadata) finish(undefined, { metadata: value.metadata, ...(value.decoded ? { decoded: value.decoded } : {}), ...(value.imported ? { imported: value.imported } : {}), ...(value.preview ? { preview: value.preview } : {}) });
        else finish(new CodingDraftError(value?.code === "privacy" ? "privacy" : value?.code === "limit" ? "limit" : "invalid"));
      });
      try { current(); signal?.throwIfAborted(); owned.postMessage({ metadata: parsed.data, document, decode, ...(fresh ? { fresh } : {}) }); }
      catch (error) { finish(error); }
    });
    current(); signal?.throwIfAborted();
  } catch (error) { failed = true; failure = error; }
  try { if (worker) await worker.terminate(); }
  catch { broken = true; if (worker) retained.add(worker); throw new CodingDraftCleanupError(); }
  finally { active--; }
  current(); signal?.throwIfAborted();
  if (failed) throw failure;
  if (!result) throw new CodingDraftError("invalid");
  return result;
  } catch (error) {
    for (const data of [result?.decoded, result?.imported?.kind === "ready" ? result.imported.data : undefined])
      for (const tree of [data?.baseline, data?.proposed, data?.current]) for (const entry of tree?.entries ?? []) if (entry.kind === "file") entry.bytes.fill(0);
    throw error;
  }
}
