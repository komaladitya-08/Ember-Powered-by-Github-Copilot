/** Pure three-way import data. Fresh captured source is the new baseline; saved text never grants filesystem access. */
import { createCodingReviewExport, type CodingExportInput, type CodingExportTree, type CodingReviewExport } from "./coding-result-export";

export type CodingDraftImportData = { kind: "conflicts"; paths: string[]; count: number } |
  { kind: "ready"; data: CodingExportInput };
/** Runs only inside the fixed trusted draft worker after complete canonical and privacy validation of both inputs. */
export function prepareCodingDraftImportData(saved: CodingExportInput, fresh: CodingExportInput): CodingDraftImportData {
  if (!fresh.current) return { kind: "conflicts", paths: [], count: 1 };
  const binding = fresh.binding, current = fresh.current;
  const bind = (tree: CodingExportTree): CodingExportTree => ({ binding, entries: tree.entries });
  let comparison: ReturnType<typeof createCodingReviewExport>;
  try { comparison = createCodingReviewExport({ binding, baseline: bind(saved.baseline), proposed: bind(saved.proposed), current,
    ...(fresh.scope ? { scope: fresh.scope } : {}) }); }
  catch { return { kind: "conflicts", paths: [], count: 1 }; }
  const conflicts = comparison.review.changes.filter(change => change.conflicts.length > 0);
  if (conflicts.length) return { kind: "conflicts", paths: conflicts.slice(0, 200).map(change => change.path), count: conflicts.length };
  const proposal = new Map(saved.proposed.entries.map(entry => [entry.path, entry]));
  const merged = new Map(current.entries.map(entry => [entry.path, entry]));
  for (const change of comparison.review.changes) {
    const entry = proposal.get(change.path);
    if (entry) merged.set(change.path, entry); else merged.delete(change.path);
  }
  const data: CodingExportInput = { binding, baseline: current, proposed: { binding, entries: [...merged.values()] }, current,
    ...(fresh.scope ? { scope: fresh.scope } : {}) };
  // Parent, directory deletion, case aliases and portable-path constraints apply to the complete merged tree.
  try { createCodingReviewExport(data); }
  catch { return { kind: "conflicts", paths: [], count: 1 }; }
  return { kind: "ready", data };
}

/** Hash/metadata comparison only: the trusted exporter already validated each complete file. */
export function importedSourceUnchanged(review: CodingReviewExport): boolean {
  if (!review.current || review.baseline.length !== review.current.length) return false;
  const before = new Map(review.baseline.map(entry => [entry.path, entry]));
  return review.current.every(entry => {
    const old = before.get(entry.path);
    return !!old && old.kind === entry.kind && (entry.kind === "directory" || old.kind === "file" && old.sha256 === entry.sha256 && old.size === entry.size && old.executable === entry.executable);
  });
}
export class CodingDraftImportConflictError extends Error {
  constructor() { super("The selected folder changed while the import was prepared. No clean import was published. Choose the folder again."); this.name = "CodingDraftImportConflictError"; }
}
