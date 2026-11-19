/** Inert, versioned coding draft data. These values never grant source access, execution or SDK resumption. */
import { z } from "zod";
import { createCodingReviewExport, decodeCodingReviewExport, type CodingExportInput } from "./coding-result-export";
import { memoryRefusal } from "../memory/guard";
import { codingWorkspaceFileProblem } from "./scoped-coding-files";

export const CODING_DRAFT_MAX_REVIEW_BYTES = 32 * 1024 * 1024;
export const CODING_DRAFT_MAX_HEADER_BYTES = 16 * 1024;
export const CODING_DRAFT_MAX_FILE_BYTES = CODING_DRAFT_MAX_REVIEW_BYTES + CODING_DRAFT_MAX_HEADER_BYTES + 4096;
export const codingDraftOwner = z.object({ library: z.string().regex(/^[a-f0-9]{64}$/), holder: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const text = (maximum: number) => z.string().max(maximum).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value.replace(/[\n\r\t]/g, "")));
const checks = z.object({ ran: z.number().int().min(0).max(150), passed: z.number().int().min(0).max(150), failed: z.number().int().min(0).max(150) }).strict()
  .refine(value => value.passed + value.failed === value.ran);
export const codingDraftMetadata = z.object({
  version: z.literal(1), id: z.string().uuid().refine(value => value === value.toLowerCase()), owner: codingDraftOwner,
  name: text(80).refine(value => !!value.trim() && !/[\r\n\t]/.test(value)),
  savedAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  sourceLabel: text(4096),
  context: z.object({ request: text(2000), summary: text(2000) }).strict(),
  historicalChecks: checks,
  binding: z.object({ owner: z.string().regex(/^[a-f0-9]{64}$/), session: z.string().uuid(), snapshot: z.string().uuid() }).strict(),
}).strict().refine(value => value.binding.owner === value.owner.holder);
export type CodingDraftOwner = z.infer<typeof codingDraftOwner>;
export type CodingDraftMetadata = z.infer<typeof codingDraftMetadata>;
export type CodingDraftFailure = "invalid" | "limit" | "privacy" | "stale" | "holder" | "keyring" | "io" | "unavailable";
const messages: Record<CodingDraftFailure, string> = {
  invalid: "The saved coding draft is invalid.", limit: "The complete coding draft exceeds the storage limits.",
  privacy: "The complete coding draft was refused by the privacy check.", stale: "The coding draft request is no longer current.",
  holder: "This coding draft belongs to another account or model connection.", keyring: "A system keyring is required to keep coding drafts.",
  io: "The coding draft could not be read or saved safely.", unavailable: "Coding draft storage is not enabled in this build.",
};
export class CodingDraftError extends Error {
  constructor(readonly code: CodingDraftFailure) { super(messages[code]); this.name = "CodingDraftError"; }
}
export class CodingDraftCleanupError extends Error {
  constructor() { super("The coding draft worker could not be verified as stopped."); this.name = "CodingDraftCleanupError"; }
}

/** Trusted worker computation only: complete canonical decode and the current complete-file privacy policy. */
export interface CodingDraftPreview {
  files: { path: string; kind: "file" | "directory" }[]; filesTotal: number; preview: string | null; limitations: string[];
}
export function validateCodingDraft(metadata: unknown, document: Buffer): { metadata: CodingDraftMetadata; decoded: CodingExportInput; preview: CodingDraftPreview } {
  let parsed: CodingDraftMetadata;
  try { parsed = codingDraftMetadata.parse(metadata); }
  catch { throw new CodingDraftError("invalid"); }
  if (document.length > CODING_DRAFT_MAX_REVIEW_BYTES) throw new CodingDraftError("limit");
  if (Buffer.byteLength(JSON.stringify(parsed)) > CODING_DRAFT_MAX_HEADER_BYTES) throw new CodingDraftError("limit");
  if ([parsed.name, parsed.sourceLabel, parsed.context.request, parsed.context.summary].some(value => memoryRefusal(value))) throw new CodingDraftError("privacy");
  let decoded: CodingExportInput;
  try { decoded = decodeCodingReviewExport(document, parsed.binding, { limits: { outputBytes: CODING_DRAFT_MAX_REVIEW_BYTES } }); }
  catch { throw new CodingDraftError("invalid"); }
  try {
    for (const tree of [decoded.baseline, decoded.proposed, decoded.current]) for (const entry of tree?.entries ?? []) {
      if (codingWorkspaceFileProblem(entry.path, entry.kind === "file" ? entry.bytes : Buffer.alloc(0))) throw new CodingDraftError("privacy");
    }
    const review = createCodingReviewExport(decoded).review;
    const canonical = Buffer.from(JSON.stringify(review, null, 2));
    if (!canonical.equals(document)) throw new CodingDraftError("invalid");
    return { metadata: parsed, decoded, preview: { files: decoded.proposed.entries.slice(0, 200).map(entry => ({ path: entry.path, kind: entry.kind })),
      filesTotal: decoded.proposed.entries.length, preview: Buffer.byteLength(review.textPatch) <= 64_000 ? review.textPatch : null, limitations: [...review.limitations] } };
  } catch (error) {
    for (const tree of [decoded.baseline, decoded.proposed, decoded.current]) for (const entry of tree?.entries ?? []) if (entry.kind === "file") entry.bytes.fill(0);
    throw error;
  }
}
