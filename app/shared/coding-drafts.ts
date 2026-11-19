/** Bounded saved-draft views only; no value restores source grants, execution authority or SDK sessions. */
import type { ProjectCodingWorkspaceState } from "./project-coding";

export const CODING_DRAFT_NAME_LIMIT = 80;
export const CODING_DRAFT_FILE_LIST_LIMIT = 200;
export const CODING_DRAFT_PREVIEW_LIMIT = 64_000;

export interface CodingDraftSummary {
  id: string;
  name: string;
  savedAt: number;
  sourceLabel: string;
  historicalChecks: { ran: number; passed: number; failed: number };
}
export interface CodingDraftsState {
  canSave: boolean;
  canOpen: boolean;
  /** Erasure remains available when the keyring cannot open saved data. */
  canForget: boolean;
  drafts: CodingDraftSummary[];
  message: string;
}
export interface CodingDraftView extends CodingDraftSummary {
  /** Historical, untrusted data; these words never authorise a new task. */
  context: { request: string; summary: string };
  files: { path: string; kind: "file" | "directory" }[];
  filesTotal: number;
  preview: string | null;
  previewMessage: string;
  limitations: string[];
}
export interface CodingDraftImportResult { ok: boolean; message: string; resultId?: string }
export interface CodingDraftFolderChoice { ok: boolean; message: string; workspace?: ProjectCodingWorkspaceState }
