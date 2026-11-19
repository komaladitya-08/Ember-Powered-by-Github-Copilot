import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createCodingReviewExport, decodeCodingReviewExport, type CodingExportBinding, type CodingExportEntry,
  type CodingExportInput, type CodingExportTree, type CodingReviewExport } from "../../app/main/agent/coding-result-export";
import type { CodingProjectManifest } from "../../app/main/agent/coding-project-scope";

const binding: CodingExportBinding = { owner: "a".repeat(64), session: randomUUID(), snapshot: randomUUID() };
const invalid = "The complete coding review could not be decoded or verified.";
const file = (path: string, bytes: string | Buffer, executable = false): CodingExportEntry => ({ path, kind: "file", bytes: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes), executable });
const directory = (path: string): CodingExportEntry => ({ path, kind: "directory" });
const tree = (...entries: CodingExportEntry[]): CodingExportTree => ({ binding, entries });
const document = (extra: Partial<CodingExportInput> = {}) => createCodingReviewExport({ binding,
  baseline: tree(file("a", "a")), proposed: tree(file("a", "f")), current: tree(file("a", "a")), ...extra });
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const decode = (value: unknown) => decodeCodingReviewExport(bytes(value), binding);
const mutate = (change: (value: CodingReviewExport) => void): CodingReviewExport => {
  const value = structuredClone(document().review); change(value); return value;
};
const proposedFile = (value: CodingReviewExport) => {
  const entry = value.proposed[0];
  if (entry.kind !== "file") throw new Error("A file fixture is required.");
  return entry;
};

describe("complete coding review decoding", () => {
  it("round-trips binary, empty directories, executable bits, unchanged files and a conflicting current tree", () => {
    const baseline = tree(file("binary", Buffer.from([0, 255])), directory("empty"), file("run.sh", "echo old\n"), file("same", "keep"), file("text", "before"));
    const proposed = tree(file("binary", Buffer.from([0, 254])), directory("empty"), file("run.sh", "echo old\n", true), file("same", "keep"), file("text", "proposed"));
    const current = tree(...baseline.entries.filter(entry => entry.path !== "text"), file("text", "user edit"), file("user-new", "retain"));
    const encoded = document({ baseline, proposed, current });
    const decoded = decodeCodingReviewExport(Buffer.from(encoded.json), binding);
    expect(decoded.binding).toEqual(binding);
    expect(decoded.baseline).toEqual(baseline);
    expect(decoded.proposed).toEqual(proposed);
    expect(decoded.current).toEqual({ ...current, entries: [...current.entries].sort((a, b) => a.path.localeCompare(b.path)) });
    expect(createCodingReviewExport(decoded).review).toEqual(encoded.review);
    expect(encoded.review.changes.find(change => change.path === "text")?.conflicts.length).toBeGreaterThan(0);
    expect(encoded.review.textPatch).not.toContain("+proposed");
  });

  it("keeps the original baseline through a later edit instead of replacing it with the first proposal", () => {
    const first = decodeCodingReviewExport(Buffer.from(document({ baseline: tree(file("a", "original")), proposed: tree(file("a", "first change")), current: tree(file("a", "original")) }).json), binding);
    const second = createCodingReviewExport({ ...first, proposed: tree(file("a", "second change")) });
    const decoded = decodeCodingReviewExport(Buffer.from(second.json), binding);
    expect(decoded.baseline.entries).toEqual([file("a", "original")]);
    expect(decoded.proposed.entries).toEqual([file("a", "second change")]);
    expect(second.review.textPatch).toContain("-original\n");
    expect(second.review.textPatch).toContain("+second change\n");
    expect(second.review.textPatch).not.toContain("-first change");
  });

  it("returns independent file buffers and preserves the absence of a current capture", () => {
    const input = document({ current: undefined });
    const encoded = Buffer.from(input.json);
    const first = decodeCodingReviewExport(encoded, binding);
    const second = decodeCodingReviewExport(encoded, binding);
    expect(first.current).toBeUndefined();
    const a = first.baseline.entries[0], b = first.proposed.entries[0];
    expect(a.kind).toBe("file"); expect(b.kind).toBe("file");
    if (a.kind !== "file" || b.kind !== "file") return;
    a.bytes.fill(0); b.bytes.fill(0); encoded.fill(0);
    expect(second.baseline.entries).toEqual([file("a", "a")]);
    expect(second.proposed.entries).toEqual([file("a", "f")]);
    expect(input.review.baseline[0]).toMatchObject({ base64: "YQ==" });
  });

  it.each(["owner", "session", "snapshot"] as const)("requires the exact expected %s binding", key => {
    const other = { ...binding, [key]: key === "owner" ? "b".repeat(64) : randomUUID() };
    expect(() => decodeCodingReviewExport(Buffer.from(document().json), other)).toThrow(invalid);
  });

  it.each([
    ["missing version", (value: CodingReviewExport) => { delete (value as Partial<CodingReviewExport>).version; }],
    ["extra top-level authority", (value: CodingReviewExport) => { Object.assign(value, { execute: true }); }],
    ["apply purpose", (value: CodingReviewExport) => { Object.assign(value, { purpose: "apply" }); }],
    ["metadata claim", (value: CodingReviewExport) => { value.metadata = "full-filesystem" as CodingReviewExport["metadata"]; }],
    ["removed current field", (value: CodingReviewExport) => { delete (value as Partial<CodingReviewExport>).current; }],
    ["missing proposed tree", (value: CodingReviewExport) => { delete (value as Partial<CodingReviewExport>).proposed; }],
    ["metadata scalar", (value: CodingReviewExport) => { Object.assign(value, { metadata: 42 }); }],
    ["extra tree field", (value: CodingReviewExport) => { Object.assign(value.proposed[0], { nlink: 1 }); }],
    ["wrong digest", (value: CodingReviewExport) => { proposedFile(value).sha256 = "0".repeat(64); }],
    ["wrong size", (value: CodingReviewExport) => { proposedFile(value).size++; }],
    ["negative size", (value: CodingReviewExport) => { proposedFile(value).size = -1; }],
    ["fractional size", (value: CodingReviewExport) => { proposedFile(value).size = 0.5; }],
    ["wrong bytes", (value: CodingReviewExport) => { proposedFile(value).base64 = "Zw=="; }],
    ["extra change", (value: CodingReviewExport) => { value.changes.push(structuredClone(value.changes[0])); }],
    ["missing change", (value: CodingReviewExport) => { value.changes = []; }],
    ["forged conflict status", (value: CodingReviewExport) => { value.changes[0].conflicts = ["invented"]; }],
    ["forged index", (value: CodingReviewExport) => { value.changes[0].proposed = 1; }],
    ["forged patch", (value: CodingReviewExport) => { value.textPatch += "injected"; }],
    ["forged completeness", (value: CodingReviewExport) => { value.patchComplete = false; }],
    ["missing limitation", (value: CodingReviewExport) => { value.limitations.pop(); }],
    ["extra binding field", (value: CodingReviewExport) => { Object.assign(value.binding, { credential: "private" }); }],
  ])("rejects %s with a fixed error", (_name, change) => {
    expect(() => decode(mutate(change))).toThrow(invalid);
  });

  it.each(["Zg", "Zg=", "Zg===", "Zh==", "Zg==\n", " Zg==", "Zg==!"])("refuses noncanonical base64 %j even when a permissive decoder recovers the same byte", encoded => {
    const value = mutate(review => { proposedFile(review).base64 = encoded; });
    expect(() => decode(value)).toThrow(invalid);
  });

  it("rejects nonzero low padding bits in a two-byte encoding", () => {
    const value = document({ proposed: tree(file("a", "fo")) }).review;
    const entry = proposedFile(value); expect(entry.base64).toBe("Zm8="); entry.base64 = "Zm9=";
    expect(() => decode(value)).toThrow(invalid);
  });

  it.each(["/absolute", "../escape", "a/../escape", "C:stream", "missing/child", "a\\child", "NUL"])("refuses unsupported captured path %j", path => {
    expect(() => decode(mutate(value => { value.proposed[0].path = path; value.changes[0].path = path; }))).toThrow(invalid);
  });

  it("refuses aliases inside a tree and across captures", () => {
    const duplicate = mutate(value => { value.proposed.push({ ...value.proposed[0], path: "A" }); });
    expect(() => decode(duplicate)).toThrow(invalid);
    expect(() => decode(mutate(value => { value.proposed[0].path = "A"; value.changes[0].path = "A"; }))).toThrow(invalid);
  });

  it("retains strict source omissions and separate dependency receipts", () => {
    const scope: CodingProjectManifest = { version: 1, source: { excludedRoots: [".git", "node_modules"], omitted: [{ path: ".git", kind: "link" }, { path: "node_modules", kind: "directory" }], byteLimit: 10 * 1024 * 1024 },
      dependencies: { access: "copied-read-only", mount: "/work/node_modules", files: 2, bytes: 40, sha256: "b".repeat(64), materializedLinks: [{ path: "package/alias", target: "package/value" }] } };
    const value = document({ scope }).review;
    const decoded = decode(value); expect(decoded.scope).toEqual(scope);
    const bad: ((copy: CodingReviewExport) => void)[] = [
      copy => { copy.scope!.source.excludedRoots = ["node_modules"]; },
      copy => { copy.scope!.source.omitted.push({ path: ".git", kind: "file" }); },
      copy => { copy.scope!.dependencies!.sha256 = "unverified"; },
      copy => { copy.scope!.dependencies!.materializedLinks[0].target = "../outside"; },
      copy => { Object.assign(copy.scope!.dependencies!, { access: "read-write" }); },
      copy => { Object.assign(copy.scope!.source, { autoInstall: true }); },
      copy => { copy.proposed.push({ path: "node_modules", kind: "directory" }); },
    ];
    for (const change of bad) { const copy = structuredClone(value); change(copy); expect(() => decode(copy)).toThrow(invalid); }
    value.scope!.dependencies!.materializedLinks[0].path = "changed";
    expect(decoded.scope!.dependencies!.materializedLinks[0].path).toBe("package/alias");
  });

  it("enforces byte, file, entry, depth and output limits on complete documents", () => {
    const input = document({ baseline: tree(directory("d"), file("d/a", "1234")), proposed: tree(directory("d"), file("d/a", "5678")), current: tree(directory("d"), file("d/a", "1234")) });
    const encoded = Buffer.from(input.json);
    for (const limits of [{ bytes: 11 }, { fileBytes: 3 }, { entries: 1 }, { depth: 1 }, { outputBytes: encoded.length - 1 }, { bytes: Number.MAX_SAFE_INTEGER }]) {
      expect(() => decodeCodingReviewExport(encoded, binding, { limits })).toThrow(invalid);
    }
    expect(decodeCodingReviewExport(encoded, binding, { limits: { bytes: 12, fileBytes: 4, entries: 2, depth: 2, outputBytes: encoded.length } }).proposed.entries).toHaveLength(2);
  });

  it("propagates an existing cancellation reason and rejects shared mutable input", () => {
    const stop = new AbortController(), reason = new Error("cancel this review"); stop.abort(reason);
    expect(() => decodeCodingReviewExport(Buffer.from(document().json), binding, { signal: stop.signal })).toThrow(reason);
    try { decodeCodingReviewExport(Buffer.from(document().json), binding, { signal: stop.signal }); }
    catch (error) { expect(error).toBe(reason); }
    const encoded = Buffer.from(document().json), shared = Buffer.from(new SharedArrayBuffer(encoded.length)); encoded.copy(shared);
    expect(() => decodeCodingReviewExport(shared, binding)).toThrow(invalid);
  });

  it("requires strict UTF-8, including a byte error which permissive replacement would leave semantically identical", () => {
    const encoded = Buffer.from(document({ baseline: tree(file("\ufffd", "a")), proposed: tree(file("\ufffd", "f")), current: tree(file("\ufffd", "a")) }).json);
    const index = encoded.indexOf(Buffer.from("\ufffd")); expect(index).toBeGreaterThan(-1);
    const invalidUtf8 = Buffer.concat([encoded.subarray(0, index), Buffer.from([0xff]), encoded.subarray(index + 3)]);
    expect(invalidUtf8.toString()).toBe(encoded.toString());
    expect(() => decodeCodingReviewExport(invalidUtf8, binding)).toThrow(invalid);
  });

  it.each([
    ["top-level", (json: string) => `{"version":1,${json.slice(1)}`],
    ["escaped top-level", (json: string) => `{"\\u0076ersion":1,${json.slice(1)}`],
    ["nested binding", (json: string) => json.replace('"binding":{', `"binding":{"owner":"${binding.owner}",`)],
    ["escaped entry", (json: string) => json.replace('"path":"a"', '"path":"a","\\u0070ath":"a"')],
  ])("rejects duplicate %s keys even when values agree", (_name, duplicate) => {
    expect(() => decodeCodingReviewExport(Buffer.from(duplicate(JSON.stringify(document().review))), binding)).toThrow(invalid);
  });

  it("accepts insignificant whitespace and reordered object keys while preserving array meaning", () => {
    const reverse = (value: unknown): unknown => Array.isArray(value) ? value.map(reverse) : value !== null && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).reverse().map(([key, entry]) => [key, reverse(entry)])) : value;
    const original = document();
    const decoded = decodeCodingReviewExport(Buffer.from(`\n ${JSON.stringify(reverse(original.review), null, 4)} \n`), binding);
    expect(createCodingReviewExport(decoded).review).toEqual(original.review);
  });

  it.each(["null", "[]", "{}", "{", "{} trailing", "{\"version\":1e999}"])("rejects malformed or incomplete JSON %j without echoing input", json => {
    expect(() => decodeCodingReviewExport(Buffer.from(json), binding)).toThrow(invalid);
  });
});
