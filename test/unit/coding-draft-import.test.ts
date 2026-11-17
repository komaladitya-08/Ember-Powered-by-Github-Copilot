import { expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createCodingReviewExport, type CodingExportTree, type CodingExportBinding, type CodingExportInput } from "../../app/main/agent/coding-result-export";
import { prepareCodingDraftImportData } from "../../app/main/agent/coding-draft-import-data";
import { checkCodingDraft } from "../../app/main/agent/coding-draft-codec";
import { issueCodingDraftImportSeed, consumeCodingDraftImportSeed } from "../../app/main/agent/coding-draft-import-seed";
import type { CodingArtifactStore, CodingArtifactSourceRef } from "../../app/main/agent/coding-artifact-store";
const owner = "a".repeat(64);
const binding = (): CodingExportBinding => ({ owner, session: randomUUID(), snapshot: randomUUID() });
const tree = (b: CodingExportBinding, files: Record<string, string>): CodingExportTree => ({ binding: b,
  entries: Object.entries(files).map(([path, text]) => ({ path, kind: "file", bytes: Buffer.from(text), executable: false })) });
const data = (b: CodingExportBinding, before: Record<string, string>, after = before): CodingExportInput => ({ binding: b, baseline: tree(b, before), proposed: tree(b, after), current: tree(b, before) });
function fixture() {
  const saved = data(binding(), { "main.ts": "old", "old.ts": "removed", "readme.md": "before" }, { "main.ts": "new", "new.ts": "added", "readme.md": "before" });
  const fresh = data(binding(), { "main.ts": "old", "old.ts": "removed", "readme.md": "current unrelated edit" });
  return { saved, fresh };
}
it("rebases saved edits onto a wholly fresh baseline while preserving unrelated current files", () => {
  const { saved, fresh } = fixture(), result = prepareCodingDraftImportData(saved, fresh);
  if (result.kind !== "ready") throw new Error("Expected a clean import");
  expect(result.data.binding).toEqual(fresh.binding); expect(result.data.binding).not.toEqual(saved.binding);
  const text = Object.fromEntries(result.data.proposed.entries.map(entry => [entry.path, entry.kind === "file" ? entry.bytes.toString() : "directory"]));
  expect(text).toEqual({ "main.ts": "new", "new.ts": "added", "readme.md": "current unrelated edit" });
  expect(result.data.baseline).toBe(fresh.current); expect(saved.proposed.entries).toHaveLength(3);
});
it("refuses changed-path conflicts and case aliases without producing seeded data", () => {
  const { saved, fresh } = fixture(); fresh.current = tree(fresh.binding, { "main.ts": "conflicting edit", "old.ts": "removed", "readme.md": "before" });
  expect(prepareCodingDraftImportData(saved, fresh)).toMatchObject({ kind: "conflicts", paths: ["main.ts"], count: 1 });
  fresh.current = tree(fresh.binding, { "Main.ts": "case alias", "old.ts": "removed" });
  expect(prepareCodingDraftImportData(saved, fresh).kind).toBe("conflicts");
});
it("retains new directory children by refusing a saved deletion of their ancestor", () => {
  const b = binding(), c = binding(), saved: CodingExportInput = { binding: b,
    baseline: { binding: b, entries: [{ path: "dir", kind: "directory" }, { path: "dir/old", kind: "file", bytes: Buffer.from("old"), executable: false }] }, proposed: { binding: b, entries: [] } };
  const fresh: CodingExportInput = { binding: c, baseline: { binding: c, entries: [] }, current: { binding: c, entries: [
    { path: "dir", kind: "directory" }, { path: "dir/old", kind: "file", bytes: Buffer.from("old"), executable: false }, { path: "dir/new", kind: "file", bytes: Buffer.from("new"), executable: false }] }, proposed: { binding: c, entries: [] } };
  expect(prepareCodingDraftImportData(saved, fresh).kind).toBe("conflicts");
});
it("validates both complete documents and performs comparison inside the fixed worker", async () => {
  const { saved, fresh } = fixture();
  const metadata = (b: CodingExportBinding) => ({ version: 1 as const, id: randomUUID(), owner: { library: owner, holder: owner }, name: "Draft", savedAt: 1,
    sourceLabel: "project", context: { request: "Check parser", summary: "Old result" }, historicalChecks: { ran: 1, passed: 1, failed: 0 }, binding: b });
  const document = (value: CodingExportInput) => Buffer.from(JSON.stringify(createCodingReviewExport(value).review, null, 2));
  const result = await checkCodingDraft(metadata(saved.binding), document(saved), () => undefined, undefined, false,
    { metadata: metadata(fresh.binding), document: document(fresh) });
  expect(result.imported).toMatchObject({ kind: "ready", data: { binding: fresh.binding } });
});
it("consumes an import seed once only after exact store/source/project/current checks", async () => {
  const { fresh } = fixture(), source = {} as CodingArtifactSourceRef, next = {} as CodingArtifactSourceRef;
  const store = { sameSource: async (a: unknown, b: unknown, check: () => void) => { check(); return a === source && b === next; } } as CodingArtifactStore;
  const input = { store, source: next, projectId: "new-project", path: "/new-source", owner, current: () => true };
  const token = issueCodingDraftImportSeed({ ...input, source, data: fresh });
  await expect(consumeCodingDraftImportSeed({ close() {} } as never, input)).rejects.toThrow();
  await expect(consumeCodingDraftImportSeed(token, { ...input, path: "/other" })).rejects.toThrow();
  expect(await consumeCodingDraftImportSeed(token, input)).toBe(fresh);
  await expect(consumeCodingDraftImportSeed(token, input)).rejects.toThrow();
});

it("uses the latest positive current-source capture and refuses an unknown current tree", () => {
  const { saved, fresh } = fixture(); fresh.current = tree(fresh.binding, { "main.ts": "old", "old.ts": "removed", "readme.md": "latest fresh edit" });
  const result = prepareCodingDraftImportData(saved, fresh);
  if (result.kind !== "ready") throw new Error("Expected clean changed-unrelated import");
  expect(result.data.proposed.entries.find(entry => entry.path === "readme.md")).toMatchObject({ bytes: Buffer.from("latest fresh edit") });
  delete fresh.current; expect(prepareCodingDraftImportData(saved, fresh).kind).toBe("conflicts");
});
