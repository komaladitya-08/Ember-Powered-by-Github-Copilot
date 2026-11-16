/**
 * Portable, bounded review of host-captured bytes. This module reads and writes no files and confers no apply grant.
 * It does not certify filesystem traversal, stopped processes, or immutable workspaces. A filesystem broker must
 * establish those boundaries before capturing the baseline/result; a model's assertion of completion is insufficient.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { codingProjectManifest, codingProjectScopeDisclosure, type CodingProjectManifest } from "./coding-project-scope";

export interface CodingExportBinding { owner: string; session: string; snapshot: string }
export type CodingExportEntry = { path: string; kind: "directory" } |
  { path: string; kind: "file"; bytes: Buffer; executable: boolean };
export interface CodingExportTree { binding: CodingExportBinding; entries: readonly CodingExportEntry[] }
export interface CodingExportLimits { entries: number; bytes: number; fileBytes: number; depth: number; outputBytes: number }
export interface CodingExportInput {
  binding: CodingExportBinding;
  baseline: CodingExportTree;
  proposed: CodingExportTree;
  /** A point-in-time capture of the original project, when available. Never treated as writer exclusion. */
  current?: CodingExportTree;
  limits?: Partial<CodingExportLimits>;
  signal?: AbortSignal;
  scope?: CodingProjectManifest;
}
export type ExportedCodingEntry = { path: string; kind: "directory" } |
  { path: string; kind: "file"; base64: string; sha256: string; size: number; executable: boolean };
export interface CodingExportChange {
  path: string;
  kind: "add" | "modify" | "delete" | "type-change" | "metadata";
  baseline: number | null;
  proposed: number | null;
  current: number | null;
  conflicts: string[];
  patchUnsupported: string[];
}
export interface CodingReviewExport {
  version: 1;
  purpose: "review-only";
  binding: CodingExportBinding;
  metadata: "content-and-executable-only";
  baseline: ExportedCodingEntry[];
  proposed: ExportedCodingEntry[];
  current: ExportedCodingEntry[] | null;
  changes: CodingExportChange[];
  textPatch: string;
  patchComplete: boolean;
  limitations: string[];
  scope?: CodingProjectManifest;
}

const DEFAULT_LIMITS: CodingExportLimits = { entries: 10_000, bytes: 32 * 1024 * 1024, fileBytes: 8 * 1024 * 1024, depth: 64, outputBytes: 64 * 1024 * 1024 };
const bindingSchema = z.object({ owner: z.string().regex(/^[0-9a-f]{64}$/), session: z.string().uuid(), snapshot: z.string().uuid() }).strict();
const reserved = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const equalBinding = (a: CodingExportBinding, b: CodingExportBinding) => a.owner === b.owner && a.session === b.session && a.snapshot === b.snapshot;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function exportLimits(input?: Partial<CodingExportLimits>): CodingExportLimits {
  const limits = { ...DEFAULT_LIMITS, ...input };
  if (Object.entries(limits).some(([key, value]) => !Object.hasOwn(DEFAULT_LIMITS, key) || !Number.isSafeInteger(value) || value < 1 || value > DEFAULT_LIMITS[key as keyof CodingExportLimits])) throw new Error("Invalid result export limits.");
  return limits;
}

function validPath(value: string, limits: CodingExportLimits): void {
  if (typeof value !== "string" || !value || Buffer.byteLength(value) > 4096 || Buffer.from(value).toString("utf8") !== value ||
      value !== value.normalize("NFC") || /[\\:<>"|?*\p{Cc}\p{Cf}]/u.test(value)) throw new Error("Unsupported portable result path.");
  const parts = value.split("/");
  if (parts.length > limits.depth || parts.some(p => !p || p === "." || p === ".." || /[. ]$/.test(p) || reserved.test(p) || Buffer.byteLength(p) > 255)) {
    throw new Error("Unsupported portable result path.");
  }
}

function same(a: CodingExportEntry | undefined, b: CodingExportEntry | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind) return false;
  return a.kind === "directory" || (b.kind === "file" && a.executable === b.executable && a.bytes.equals(b.bytes));
}

/** This validates an already captured manifest; it cannot determine whether an input path was originally a link. */
function capture(tree: CodingExportTree, binding: CodingExportBinding, limits: CodingExportLimits, budget: { bytes: number }, signal?: AbortSignal): CodingExportEntry[] {
  if (!equalBinding(bindingSchema.parse(tree.binding), binding)) throw new Error("The result belongs to another account, session or snapshot.");
  if (!Array.isArray(tree.entries) || tree.entries.length > limits.entries) throw new Error("Too many result files or directories.");
  const paths = new Map<string, CodingExportEntry>(), aliases = new Set<string>();
  for (const raw of tree.entries) {
    signal?.throwIfAborted();
    validPath(raw.path, limits);
    const alias = raw.path.toUpperCase().toLowerCase().normalize("NFC");
    if (aliases.has(alias)) throw new Error("Duplicate or case-aliased result paths.");
    aliases.add(alias);
    const fields = raw.kind === "directory" ? ["path", "kind"] : ["path", "kind", "bytes", "executable"];
    if (Object.keys(raw).some(key => !fields.includes(key))) throw new Error("Unsupported result metadata or file type.");
    let entry: CodingExportEntry;
    if (raw.kind === "directory") entry = { path: raw.path, kind: "directory" };
    else if (raw.kind === "file" && Buffer.isBuffer(raw.bytes) && typeof raw.executable === "boolean") {
      if (typeof SharedArrayBuffer !== "undefined" && raw.bytes.buffer instanceof SharedArrayBuffer) throw new Error("Shared mutable result bytes are unsupported.");
      if (raw.bytes.length > limits.fileBytes || (budget.bytes += raw.bytes.length) > limits.bytes) throw new Error("The result is too large to export.");
      entry = { path: raw.path, kind: "file", bytes: Buffer.from(raw.bytes), executable: raw.executable };
    } else throw new Error("Unsupported result metadata or file type.");
    paths.set(entry.path, entry);
  }
  for (const file of paths.keys()) {
    const parts = file.split("/");
    for (let i = 1; i < parts.length; i++) if (paths.get(parts.slice(0, i).join("/"))?.kind !== "directory") {
      throw new Error("A result has a missing directory or a file used as a parent.");
    }
  }
  return [...paths.values()].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function exported(entries: CodingExportEntry[]): ExportedCodingEntry[] {
  return entries.map(e => e.kind === "directory" ? e : { path: e.path, kind: "file", base64: e.bytes.toString("base64"), sha256: digest(e.bytes), size: e.bytes.length, executable: e.executable });
}

function text(entry: CodingExportEntry | undefined): string | null {
  if (!entry) return "";
  if (entry.kind !== "file") return null;
  const decoded = entry.bytes.toString("utf8");
  if (!Buffer.from(decoded).equals(entry.bytes) || /[\p{Cc}\p{Cf}]/u.test(decoded.replace(/[\t\r\n]/g, ""))) return null;
  return decoded;
}

function patchLines(value: string, marker: "-" | "+"): string {
  if (!value) return "";
  const lines = value.split("\n");
  const finalNewline = lines.at(-1) === "";
  if (finalNewline) lines.pop();
  return lines.map((line, i) => `${marker}${line}\n${!finalNewline && i === lines.length - 1 ? "\\ No newline at end of file\n" : ""}`).join("");
}

function patch(file: string, before: CodingExportEntry | undefined, after: CodingExportEntry | undefined): { value: string; unsupported: string[] } {
  const unsupported: string[] = [];
  if (before?.kind === "directory" || after?.kind === "directory") unsupported.push("Directory and file-type changes are recorded in JSON, not the text patch.");
  if (!/^[A-Za-z0-9._/-]+$/.test(file)) unsupported.push("This filename is recorded in JSON; it cannot be represented by this patch formatter.");
  const oldText = text(before), newText = text(after);
  if (oldText === null || newText === null) unsupported.push("Binary or non-printing file contents are retained as base64 in JSON.");
  if (unsupported.length) return { value: "", unsupported };
  const oldFile = before?.kind === "file" ? before : undefined, newFile = after?.kind === "file" ? after : undefined;
  const oldMode = oldFile?.executable ? "100755" : "100644", newMode = newFile?.executable ? "100755" : "100644";
  let value = `diff --git a/${file} b/${file}\n`;
  if (!oldFile) value += `new file mode ${newMode}\n`;
  else if (!newFile) value += `deleted file mode ${oldMode}\n`;
  else if (oldMode !== newMode) value += `old mode ${oldMode}\nnew mode ${newMode}\n`;
  if (oldText !== newText) {
    const lines = (s: string) => !s ? 0 : s.split("\n").length - (s.endsWith("\n") ? 1 : 0);
    const oldCount = lines(oldText!), newCount = lines(newText!);
    value += `--- ${oldFile ? `a/${file}` : "/dev/null"}\n+++ ${newFile ? `b/${file}` : "/dev/null"}\n`;
    value += `@@ -${oldCount ? 1 : 0},${oldCount} +${newCount ? 1 : 0},${newCount} @@\n`;
    value += patchLines(oldText!, "-") + patchLines(newText!, "+");
  }
  return { value, unsupported };
}

/**
 * Synchronously copies and validates supplied bytes, preserving all three trees in one standalone JSON document.
 * Pure formatting is portable; obtaining trustworthy, stopped filesystem captures is a separate host responsibility.
 */
export function createCodingReviewExport(input: CodingExportInput): { review: CodingReviewExport; json: string } {
  input.signal?.throwIfAborted();
  const binding = bindingSchema.parse(input.binding), limits = exportLimits(input.limits);
  const budget = { bytes: 0 };
  const baseline = capture(input.baseline, binding, limits, budget, input.signal), proposed = capture(input.proposed, binding, limits, budget, input.signal);
  const current = input.current ? capture(input.current, binding, limits, budget, input.signal) : null;
  const scope = input.scope === undefined ? undefined : codingProjectManifest(input.scope);
  if (scope && [...baseline, ...proposed, ...(current ?? [])].some(entry => scope.source.excludedRoots.some(root => entry.path === root || entry.path.startsWith(root + "/")))) throw new Error("An excluded source root was included in a scoped capture.");
  const aliases = new Map<string, string>();
  for (const entry of [...baseline, ...proposed, ...(current ?? [])]) {
    const alias = entry.path.toUpperCase().toLowerCase().normalize("NFC"), prior = aliases.get(alias);
    if (prior !== undefined && prior !== entry.path) throw new Error("Cross-tree case-aliased paths cannot be exported portably.");
    aliases.set(alias, entry.path);
  }
  const map = (entries: CodingExportEntry[]) => new Map(entries.map((e, index) => [e.path, { entry: e, index }]));
  const before = map(baseline), after = map(proposed), live = current ? map(current) : null;
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  const changes: CodingExportChange[] = [];
  let textPatch = "";
  for (const name of names) {
    input.signal?.throwIfAborted();
    const b = before.get(name), a = after.get(name), c = live?.get(name);
    if (same(b?.entry, a?.entry)) continue;
    const conflicts: string[] = [];
    if (!live) conflicts.push("The original project was not captured; concurrent changes are unknown.");
    else {
      if (!same(b?.entry, c?.entry)) conflicts.push("The current project differs from the baseline at this path.");
      const parts = name.split("/");
      for (let i = 1; i < parts.length; i++) {
        const parent = parts.slice(0, i).join("/");
        if (!same(before.get(parent)?.entry, live.get(parent)?.entry)) { conflicts.push("A parent directory changed in the current project."); break; }
      }
      if (b?.entry.kind === "directory" && a?.entry.kind !== "directory") {
        const children = new Set([...before.keys(), ...live.keys()].filter(p => p.startsWith(name + "/")));
        if ([...children].some(p => !same(before.get(p)?.entry, live.get(p)?.entry))) conflicts.push("The directory contains current changes; its complete current tree is retained in JSON.");
      }
    }
    const rendered = patch(name, b?.entry, a?.entry);
    const parentParts = name.split("/");
    if (parentParts.slice(0, -1).some((_, i) => {
      const parent = parentParts.slice(0, i + 1).join("/");
      return before.get(parent)?.entry.kind === "file" && after.get(parent)?.entry.kind === "directory";
    })) rendered.unsupported.push("A parent changes from file to directory; this path is retained only in JSON.");
    // A conflicting hunk must never be presented among the ready-to-review text changes.
    if (!conflicts.length && !rendered.unsupported.length) textPatch += rendered.value;
    const kind = !b ? "add" : !a ? "delete" : b.entry.kind !== a.entry.kind ? "type-change"
      : b.entry.kind === "file" && a.entry.kind === "file" && b.entry.bytes.equals(a.entry.bytes) ? "metadata" : "modify";
    changes.push({ path: name, kind, baseline: b?.index ?? null, proposed: a?.index ?? null, current: c?.index ?? null, conflicts, patchUnsupported: rendered.unsupported });
  }
  const review: CodingReviewExport = {
    version: 1, purpose: "review-only", binding, metadata: "content-and-executable-only",
    baseline: exported(baseline), proposed: exported(proposed), current: current ? exported(current) : null,
    changes, textPatch, patchComplete: current !== null && changes.every(c => !c.conflicts.length && !c.patchUnsupported.length),
    limitations: [
      "This document cannot apply changes and grants no permission to write to the original project.",
      "Captures and comparisons are point-in-time data, not a filesystem sandbox, stopped-process proof or writer exclusion.",
      "Only content, entry type, empty directories and executable bits are represented. Ownership, ACLs, other permission bits, timestamps and extended attributes are unsupported.",
      "The portable format does not certify inode or mount identity; identity-only replacement needs a separate host comparison.",
      "All retained bytes are untrusted project data; do not execute them as part of reviewing this export.",
      ...(scope ? [codingProjectScopeDisclosure(scope.source.excludedRoots, scope.dependencies !== null), "The review covers the declared source scope only. Excluded paths and dependency trees are not automatically archived; copied or derived source outputs may contain dependency bytes. A dependency digest is a receipt, not an archive."] : []),
    ],
    ...(scope ? { scope } : {}),
  };
  const json = JSON.stringify(review, null, 2);
  if (Buffer.byteLength(json, "utf8") > limits.outputBytes) throw new Error("The review export is too large.");
  input.signal?.throwIfAborted();
  return { review, json };
}

export interface CodingReviewDecodeOptions { limits?: Partial<CodingExportLimits>; signal?: AbortSignal }
const decodeFailure = () => new Error("The complete coding review could not be decoded or verified.");
function exactKeys(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...fields].sort().join("\0");
}

/** JSON.parse discards duplicate properties. Reject those, escaped aliases and excessive nesting before parsing. */
function reviewJson(text: string, limits: CodingExportLimits, signal?: AbortSignal): unknown {
  const stack: { kind: "object" | "array"; keys: Set<string>; key: boolean }[] = [];
  let containers = 0;
  for (let index = 0; index < text.length; index++) {
    if (index % 65_536 === 0) signal?.throwIfAborted();
    const char = text[index];
    if (char === '"') {
      const start = index;
      for (index++; index < text.length && text[index] !== '"'; index++) if (text[index] === "\\") index++;
      if (index >= text.length) throw decodeFailure();
      const parent = stack.at(-1);
      if (parent?.kind === "object" && parent.key) {
        if (index - start > 256) throw decodeFailure();
        const key: unknown = JSON.parse(text.slice(start, index + 1));
        if (typeof key !== "string" || parent.keys.has(key)) throw decodeFailure();
        parent.keys.add(key); parent.key = false;
      }
    } else if (char === "{" || char === "[") {
      if (stack.length >= 32 || ++containers > limits.entries * 12 + 1024) throw decodeFailure();
      stack.push({ kind: char === "{" ? "object" : "array", keys: new Set(), key: char === "{" });
    } else if (char === "}" || char === "]") {
      if (stack.pop()?.kind !== (char === "}" ? "object" : "array")) throw decodeFailure();
    } else if (char === ",") {
      const parent = stack.at(-1); if (parent?.kind === "object") parent.key = true;
    }
  }
  if (stack.length) throw decodeFailure(); signal?.throwIfAborted(); return JSON.parse(text);
}

/**
 * Decode a complete host-held review into independent captured bytes, retaining its original baseline and binding.
 * This supplies no provenance, filesystem authority, new session binding, writer exclusion or permission to execute.
 * Revalidating the regenerated review also prevents accepting a preview or metadata that disagrees with its trees.
 */
export function decodeCodingReviewExport(document: Buffer, expectedBinding: CodingExportBinding, options: CodingReviewDecodeOptions = {}): CodingExportInput {
  const signal = options.signal;
  try {
    signal?.throwIfAborted(); const limits = exportLimits(options.limits), expected = bindingSchema.parse(expectedBinding);
    if (!Buffer.isBuffer(document) || typeof SharedArrayBuffer !== "undefined" && document.buffer instanceof SharedArrayBuffer ||
        document.length < 2 || document.length > limits.outputBytes) throw decodeFailure();
    const text = document.toString("utf8");
    if (!Buffer.from(text, "utf8").equals(document)) throw decodeFailure();
    const parsed = reviewJson(text, limits, signal);
    const fields = ["version", "purpose", "binding", "metadata", "baseline", "proposed", "current", "changes", "textPatch", "patchComplete", "limitations"];
    if (parsed !== null && typeof parsed === "object" && Object.hasOwn(parsed, "scope")) fields.push("scope");
    if (!exactKeys(parsed, fields) || parsed.version !== 1 || parsed.purpose !== "review-only" || parsed.metadata !== "content-and-executable-only" ||
        !Array.isArray(parsed.changes) || parsed.changes.length > limits.entries * 2 || typeof parsed.textPatch !== "string" || typeof parsed.patchComplete !== "boolean" ||
        !Array.isArray(parsed.limitations) || parsed.limitations.length > 8 || parsed.limitations.some(value => typeof value !== "string")) throw decodeFailure();
    const binding = bindingSchema.parse(parsed.binding);
    if (!equalBinding(binding, expected)) throw decodeFailure();
    const budget = { bytes: 0 };
    const decodeTree = (entries: unknown): CodingExportTree => {
      if (!Array.isArray(entries) || entries.length > limits.entries) throw decodeFailure();
      const decoded: CodingExportEntry[] = [];
      for (const entry of entries) {
        signal?.throwIfAborted();
        const fileFields = ["path", "kind", "base64", "sha256", "size", "executable"];
        if (!exactKeys(entry, entry?.kind === "directory" ? ["path", "kind"] : fileFields) || typeof entry.path !== "string") throw decodeFailure();
        validPath(entry.path, limits);
        if (entry.kind === "directory") { decoded.push({ path: entry.path, kind: "directory" }); continue; }
        if (entry.kind !== "file" || typeof entry.base64 !== "string" || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256) ||
            typeof entry.executable !== "boolean" || typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > limits.fileBytes ||
            (budget.bytes += entry.size) > limits.bytes || entry.base64.length !== Math.ceil(entry.size / 3) * 4) throw decodeFailure();
        // The declared decoded size, aggregate budget and exact encoded length are checked before allocation.
        const bytes = Buffer.from(entry.base64, "base64");
        if (bytes.length !== entry.size || bytes.toString("base64") !== entry.base64 || digest(bytes) !== entry.sha256) throw decodeFailure();
        decoded.push({ path: entry.path, kind: "file", bytes, executable: entry.executable });
      }
      return { binding: { ...binding }, entries: decoded };
    };
    const result: CodingExportInput = { binding, baseline: decodeTree(parsed.baseline), proposed: decodeTree(parsed.proposed),
      ...(parsed.current === null ? {} : { current: decodeTree(parsed.current) }),
      ...(Object.hasOwn(parsed, "scope") ? { scope: codingProjectManifest(parsed.scope) } : {}), limits,
      ...(signal ? { signal } : {}) };
    signal?.throwIfAborted();
    if (!isDeepStrictEqual(parsed, createCodingReviewExport(result).review)) throw decodeFailure();
    signal?.throwIfAborted(); return result;
  } catch {
    signal?.throwIfAborted(); throw decodeFailure();
  }
}
