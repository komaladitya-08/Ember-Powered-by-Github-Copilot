/** A saved choice prepares coding work; readiness and command approval are checked again for each request. */
export interface ProjectCodingExecutionChoice {
  id: string;
  label: string;
  selectable: boolean;
  ready: boolean;
  message: string;
}

export interface ProjectCodingExecutionState {
  selected: string;
  canSelect: boolean;
  choices: ProjectCodingExecutionChoice[];
  message: string;
  /** Project intent only; each exact public lockfile set still needs the task's normal approval decision. */
  publicDependencies?: { enabled: boolean; canChange: boolean; message: string };
}

export const PUBLIC_DEPENDENCY_DISCLOSURE = "Allow Ember to download this project's locked public npm packages from registry.npmjs.org. Package names and versions are sent to that public registry; project files and credentials are not sent. Each exact dependency set follows your normal approval settings. Commands stay offline, and private registries are unavailable.";

/** Local project folder grants and reviewable coding outcomes; no field grants permission to execute work. */
export interface ProjectCodingWorkspaceState {
  projectId: string;
  folder: { path: string; label: string; valid: boolean } | null;
  available: boolean;
  /** A backend may support fresh copied-file sessions before it supports seeding from prior reviews. */
  canContinue?: boolean;
  canChoose: boolean;
  message: string;
  /** Present only on computers offering an explicit command environment choice. */
  execution?: ProjectCodingExecutionState;
}

export interface CodingResultSummary {
  id: string;
  projectId: string;
  taskId: string;
  title: string;
  /** The original local folder for this result, even if the project's current folder later changes. */
  sourcePath: string;
  status: "done" | "failed" | "stopped";
  files: number;
  conflicts: number;
  patchComplete: boolean;
  checks: { ran: number; passed: number; failed: number };
  message: string;
}

export interface CodingResultReview extends CodingResultSummary {
  changes: { path: string; kind: string; conflicts: string[]; patchUnsupported: string[] }[];
  textPatch: string | null;
  limitations: string[];
  previewMessage: string;
}

/** The renderer bounds its plain-text preview even if a backend returns a larger patch. Export is a separate action. */
export const CODING_REVIEW_PATCH_LIMIT = 64_000;
