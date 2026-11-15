/** Explicit source omissions and separate read-only dependency receipts; neither authorizes host/source writes. */
import { z } from "zod";
import type { CodingWorkspace } from "./coding-workspace";

export type CodingExcludedRoot = ".git" | "node_modules";
export interface CodingProjectScope {
  excludeRoots: readonly CodingExcludedRoot[];
  /** Separately validated host grant. An external project symlink is never followed as an implicit grant. */
  dependencies?: CodingWorkspace;
}
export interface CodingScopeOmission { path: CodingExcludedRoot; kind: "file" | "directory" | "link" }
export interface CodingDependencyManifest {
  access: "copied-read-only";
  mount: "/work/node_modules";
  files: number;
  bytes: number;
  sha256: string;
  /** Relative link receipts only; source links are materialised into fresh ordinary files/directories. */
  materializedLinks: { path: string; target: string }[];
}
export interface CodingProjectManifest {
  version: 1;
  source: { excludedRoots: CodingExcludedRoot[]; omitted: CodingScopeOmission[]; byteLimit: number };
  dependencies: CodingDependencyManifest | null;
}
const root = z.enum([".git", "node_modules"]);
const portable = z.string().min(1).max(4096).refine(value => Buffer.byteLength(value) <= 4096 && Buffer.from(value).toString("utf8") === value && value.split("/").length <= 64 && value === value.normalize("NFC") && !/[\\:<>"|?*\p{Cc}\p{Cf}]/u.test(value) &&
  value.split("/").every(part => !!part && part !== "." && part !== ".." && !/[. ]$/.test(part) && Buffer.byteLength(part) <= 255 && !/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part)));
const schema = z.object({
  version: z.literal(1),
  source: z.object({ excludedRoots: z.array(root).max(2), omitted: z.array(z.object({ path: root, kind: z.enum(["file", "directory", "link"]) }).strict()).max(2), byteLimit: z.number().int().min(1).max(10 * 1024 * 1024) }).strict(),
  dependencies: z.object({ access: z.literal("copied-read-only"), mount: z.literal("/work/node_modules"), files: z.number().int().min(0).max(50_000),
    bytes: z.number().int().min(0).max(128 * 1024 * 1024), sha256: z.string().regex(/^[0-9a-f]{64}$/),
    materializedLinks: z.array(z.object({ path: portable, target: portable }).strict()).max(1000) }).strict().nullable(),
}).strict();

/** Clone and validate the manifest before putting any claim about omitted data into a standalone review. */
export function codingProjectManifest(input: unknown): CodingProjectManifest {
  const value = schema.parse(input);
  if (new Set(value.source.excludedRoots).size !== value.source.excludedRoots.length || new Set(value.source.omitted.map(entry => entry.path)).size !== value.source.omitted.length ||
      value.source.omitted.some(entry => !value.source.excludedRoots.includes(entry.path)) ||
      (value.dependencies !== null && !value.source.excludedRoots.includes("node_modules"))) throw new Error("Invalid coding project scope.");
  const links = value.dependencies?.materializedLinks ?? [];
  if (new Set(links.map(link => link.path)).size !== links.length) throw new Error("Invalid dependency link receipts.");
  return value;
}

/** Fixed, bounded disclosure; the host must show it before starting an explicitly scoped task. */
export function codingProjectScopeDisclosure(excludeRoots: readonly CodingExcludedRoot[], dependencies: boolean): string {
  if (!excludeRoots.length) return "The complete accepted source tree is copied; unsupported links and oversized trees are refused.";
  if (excludeRoots.length > 2 || new Set(excludeRoots).size !== excludeRoots.length || excludeRoots.some(name => name !== ".git" && name !== "node_modules")) throw new Error("Invalid coding project scope.");
  return `Excluded source roots: ${[...excludeRoots].sort().join(", ")}. Those paths are omitted from source captures and review exports. ` +
    (dependencies ? "A separate fresh dependency copy is available to commands at /work/node_modules, read-only. Dependencies are not automatically archived; copied or derived source outputs can contain dependency bytes and are included in review exports." : "No dependencies are installed or downloaded; excluded dependency contents are unavailable.");
}
