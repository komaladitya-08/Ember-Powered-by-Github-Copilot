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
  /** Host-captured disclosure metadata only; this grants no execution authority. */
  executionProfile?: "wsl-offline" | "wsl-public-lock";
  /** Host-verified archive input provenance, never a receipt for command-mutated installed contents. */
  publicDependencies?: { access: "verified-offline-cache-input"; registry: "https://registry.npmjs.org"; packageJsonSha256: string; lockSha256: string; setSha256: string;
    packages: number; compressedBytes: number; expandedBytes: number; entries: number };
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
  executionProfile: z.enum(["wsl-offline", "wsl-public-lock"]).optional(),
  publicDependencies: z.object({ access: z.literal("verified-offline-cache-input"), registry: z.literal("https://registry.npmjs.org"),
    packageJsonSha256: z.string().regex(/^[0-9a-f]{64}$/), lockSha256: z.string().regex(/^[0-9a-f]{64}$/), setSha256: z.string().regex(/^[0-9a-f]{64}$/),
    packages: z.number().int().min(0).max(512), compressedBytes: z.number().int().min(0).max(64 * 1024 * 1024), expandedBytes: z.number().int().min(0).max(128 * 1024 * 1024), entries: z.number().int().min(0).max(50_000) }).strict().optional(),
}).strict();

/** Clone and validate the manifest before putting any claim about omitted data into a standalone review. */
export function codingProjectManifest(input: unknown): CodingProjectManifest {
  const value = schema.parse(input);
  if (new Set(value.source.excludedRoots).size !== value.source.excludedRoots.length || new Set(value.source.omitted.map(entry => entry.path)).size !== value.source.omitted.length ||
      value.source.omitted.some(entry => !value.source.excludedRoots.includes(entry.path)) ||
      (value.dependencies !== null && !value.source.excludedRoots.includes("node_modules")) ||
      (value.publicDependencies && (value.executionProfile !== "wsl-public-lock" || value.dependencies !== null || !value.source.excludedRoots.includes("node_modules")))) throw new Error("Invalid coding project scope.");
  const links = value.dependencies?.materializedLinks ?? [];
  if (new Set(links.map(link => link.path)).size !== links.length) throw new Error("Invalid dependency link receipts.");
  return value;
}

/** Fixed, bounded disclosure; the host must show it before starting an explicitly scoped task. */
export function codingProjectScopeDisclosure(excludeRoots: readonly CodingExcludedRoot[], dependencies: boolean, executionProfile?: "wsl-offline" | "wsl-public-lock"): string {
  if (executionProfile !== undefined && executionProfile !== "wsl-offline" && executionProfile !== "wsl-public-lock") throw new Error("Invalid coding execution profile.");
  const offline = executionProfile === "wsl-offline" ? " Local, offline package installation is available inside the isolated WSL copy. Network access and public package downloads are unavailable." : executionProfile === "wsl-public-lock" ?
    " Commands and package scripts stay offline. After normal approval of each exact lockfile package set, Ember may download verified public npm archives into an isolated cache for npm ci --offline. Installed dependencies and the cache are writable inside the copy and excluded from review exports; copied or derived source outputs can contain dependency bytes. Cache receipts describe verified archive inputs, not the later installed contents. Private registries are unavailable." : "";
  if (!excludeRoots.length) return "The complete accepted source tree is copied; unsupported links and oversized trees are refused." + offline;
  if (excludeRoots.length > 2 || new Set(excludeRoots).size !== excludeRoots.length || excludeRoots.some(name => name !== ".git" && name !== "node_modules")) throw new Error("Invalid coding project scope.");
  return `Excluded source roots: ${[...excludeRoots].sort().join(", ")}. Those paths are omitted from source captures and review exports. ` +
    (dependencies ? "A separate fresh dependency copy is available to commands at /work/node_modules, read-only. Dependencies are not automatically archived; copied or derived source outputs can contain dependency bytes and are included in review exports." : executionProfile ? "Excluded dependency contents from the original project are unavailable." : "No dependencies are installed or downloaded; excluded dependency contents are unavailable.") + offline;
}
