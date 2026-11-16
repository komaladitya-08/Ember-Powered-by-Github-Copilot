/** Structural host-owned coding capabilities. No SDK, native process or filesystem implementation lives here. */
import type { PathFact, RunnerFacts } from "../commands/types";
import type { CodingReviewExport } from "./coding-result-export";
import type { IsolatedCodingCommandPort } from "./isolated-coding-command-runner";
import type { CodingArtifactRef } from "./coding-artifact-store";

export type ScopedCodingFileFailure = "unavailable" | "cancelled" | "path" | "boundary" | "unsupported" | "privacy" | "binary" |
  "secret" | "limit" | "missing" | "exists" | "conflict" | "ambiguous" | "not-empty" | "io";
export const SCOPED_CODING_FILE_ERRORS: Readonly<Record<ScopedCodingFileFailure, string>> = Object.freeze({
  unavailable: "Scoped coding files are unavailable.", cancelled: "The scoped coding file session has ended.",
  path: "Use an unambiguous relative path or a path inside /work.", boundary: "The coding copy's filesystem boundary could not be verified.",
  unsupported: "The coding copy contains an unsupported file, link, alias or metadata.",
  privacy: "This file's name or location is withheld for privacy.", binary: "This operation requires a complete UTF-8 text file.",
  secret: "The file text was withheld because it appears to contain a secret.", limit: "The scoped coding file limit was exceeded; request a smaller explicit result.",
  missing: "The requested copy entry does not exist.", exists: "The requested copy entry already exists.",
  conflict: "The copy entry changed or its expected digest does not match.", ambiguous: "Replacement requires exactly one occurrence of a nonempty literal.",
  "not-empty": "Only an empty directory can be deleted by this tool.", io: "The scoped coding file operation could not be completed.",
});
export class ScopedCodingFileError extends Error {
  readonly code: ScopedCodingFileFailure;
  constructor(code: ScopedCodingFileFailure) { super(SCOPED_CODING_FILE_ERRORS[code]); this.code = code; this.name = "ScopedCodingFileError"; }
}

/** Only trusted host file brokers receive this lease; the callback never runs alongside command writers. */
export interface ScopedCodingWorkspace {
  files<T>(operation: (root: string) => Promise<T>): Promise<T>;
  readonly excludedRoots?: readonly string[];
}
export interface ScopedCodingFileLimits {
  entries: number; depth: number; fileBytes: number; workspaceBytes: number; resultBytes: number; searchMatches: number;
}
export interface ScopedCodingWithheld { hidden: number; sensitive: number; unsupported: number; binary: number; secrets: number }
export interface ScopedCodingEntry { path: string; kind: "file" | "directory"; bytes?: number }
export interface ScopedCodingListResult { path: string; scope: "direct-children"; entries: ScopedCodingEntry[]; withheld: ScopedCodingWithheld; excludedRoots?: string[] }
export interface ScopedCodingTextResult {
  path: string; text: string; sha256: string; bytes: number; totalLines: number; startLine: number; endLine: number;
}
export interface ScopedCodingWriteResult { path: string; bytes: number; sha256: string; created: boolean }
export interface ScopedCodingSearchResult {
  path: string; matches: { path: string; line: number; text: string }[]; files: number; withheld: ScopedCodingWithheld; excludedRoots?: string[];
}

/** Model tools see these bounded logical /work paths, never a native source-project handle or host file API. */
export interface CodingFileTools {
  list(path?: string): Promise<ScopedCodingListResult>;
  readText(path: string, range?: { startLine?: number; endLine?: number }): Promise<ScopedCodingTextResult>;
  writeText(path: string, text: string, options?: { createOnly?: boolean; expectedSha256?: string }): Promise<ScopedCodingWriteResult>;
  replaceText(path: string, oldText: string, newText: string, options?: { expectedSha256?: string }): Promise<ScopedCodingWriteResult & { replaced: 1 }>;
  delete(path: string): Promise<{ path: string; kind: "file" | "directory"; deleted: true }>;
  mkdir(path: string): Promise<{ path: string; created: true }>;
  searchLiteral(query: string, path?: string): Promise<ScopedCodingSearchResult>;
  close(): Promise<void>;
}
export interface CodingFileBroker extends CodingFileTools {
  /** Facts for existing command policy under the same exclusive lease; no unguarded source-path probes. */
  inspect(paths: readonly string[], cwd?: string): Promise<PathFact[]>;
}
export interface CodingWorkspaceReview {
  directory: string; review: CodingReviewExport; cleanup: "complete" | "retained";
  /** Host-only producer capability for stores which prohibit adopting arbitrary directory paths. Never IPC. */
  artifact?: CodingArtifactRef;
}
/** A copied-file lifecycle has no command authority. The seal is called only after awaited controller/file closure. */
export interface CodingReviewWorkspace extends ScopedCodingWorkspace {
  readonly executionRoot: string;
  stop(): Promise<void>;
  exportReview(exportBase: string): Promise<CodingWorkspaceReview>;
  close(): Promise<void>;
  sealForReview?(): Promise<void>;
}
/** Each command backend must additionally supply its real stopped-writer proof. */
export interface CodingCommandWorkspace extends IsolatedCodingCommandPort, CodingReviewWorkspace {
  readonly nodeAvailable: boolean;
}
/** Optional host-selected adapter; absence preserves the existing Linux implementation and facts. */
export interface CodingPlatformAdapter {
  facts(workspace: CodingCommandWorkspace, hostFacts: RunnerFacts): RunnerFacts;
  files(workspace: CodingReviewWorkspace, signal: AbortSignal): Promise<CodingFileBroker>;
}
