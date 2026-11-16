/** Host-selected per-project folders for this run only. No model path chooser, source write or persistence. */
import path from "node:path";
import { createHash } from "node:crypto";
import type { CodingWorkspace } from "./coding-workspace";

export interface ProjectCodingWorkspaceState { path: string; label: string; valid: boolean }
export interface ProjectCodingWorkspaceOptions {
  projectExists(projectId: string): boolean;
  /** Opaque host/account identity, preferably an owner/holder hash. Never a credential or provider configuration. */
  currentOwner(): string | null;
}
interface BoundFolder {
  path: string;
  label: string;
  folderCurrent(): boolean;
  owner: string;
  ownerRevision: number;
  projectRevision: number;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class ProjectCodingWorkspaces {
  #options: ProjectCodingWorkspaceOptions;
  #folders = new Map<string, BoundFolder>();
  #revisions = new Map<string, number>();
  #ownerRevision = 0;
  #seenOwner: string | null = null;
  constructor(options: ProjectCodingWorkspaceOptions) {
    this.#options = options;
    this.#seenOwner = this.#readOwner();
  }

  #readOwner(): string | null {
    try {
      const owner = this.#options.currentOwner();
      return typeof owner === "string" && owner.length > 0 && owner.length <= 256 ? createHash("sha256").update(owner).digest("hex") : null;
    }
    catch { return null; }
  }
  #owner(): string | null {
    const current = this.#readOwner();
    if (current !== this.#seenOwner) {
      this.#ownerRevision++; this.#folders.clear(); this.#revisions.clear(); this.#seenOwner = current;
    }
    return current;
  }
  #project(id: string): boolean {
    try { return typeof id === "string" && uuid.test(id) && this.#options.projectExists(id) === true; } catch { return false; }
  }
  #revision(id: string): number { return this.#revisions.get(id) ?? 0; }
  #safe(current: () => boolean): boolean { try { return current() === true; } catch { return false; } }

  /** Capture before opening an asynchronous native chooser. Optional project binding also fences a newer choice. */
  ownerCurrent(projectId?: string): () => boolean {
    const owner = this.#owner(), revision = this.#ownerRevision;
    const projectRevision = projectId === undefined ? null : this.#revision(projectId);
    return () => owner !== null && this.#owner() === owner && this.#ownerRevision === revision &&
      (projectId === undefined || (this.#project(projectId) && this.#revision(projectId) === projectRevision));
  }

  bind(projectId: string, folder: CodingWorkspace, ownerCurrent: () => boolean): void {
    const owner = this.#owner(), ownerRevision = this.#ownerRevision, projectRevision = this.#revision(projectId);
    const current = () => owner !== null && this.#owner() === owner && this.#ownerRevision === ownerRevision &&
      this.#project(projectId) && this.#revision(projectId) === projectRevision && this.#safe(ownerCurrent);
    if (!current()) throw new Error("The project or folder choice is no longer current.");
    const selectedPath = folder.path, checkFolder = folder.current.bind(folder);
    if (typeof selectedPath !== "string" || !path.isAbsolute(selectedPath) || selectedPath.length > 4096 ||
        /^[\\/]{2}|[\p{Cc}\p{Cf}]/u.test(selectedPath) || !this.#safe(checkFolder) || !current() || this.#ownerRevision !== ownerRevision || this.#revision(projectId) !== projectRevision) {
      throw new Error("The selected project folder is unavailable or its choice changed.");
    }
    const next = projectRevision + 1;
    this.#revisions.set(projectId, next);
    this.#folders.set(projectId, { path: selectedPath, label: path.basename(selectedPath) || selectedPath,
      folderCurrent: checkFolder, owner: owner!, ownerRevision, projectRevision: next });
  }

  #current(projectId: string, folder: BoundFolder): boolean {
    return this.#owner() === folder.owner && this.#ownerRevision === folder.ownerRevision && this.#project(projectId) &&
      this.#revision(projectId) === folder.projectRevision && this.#folders.get(projectId) === folder;
  }

  capture(projectId: string): CodingWorkspace | null {
    const owner = this.#owner(), folder = this.#folders.get(projectId);
    if (owner === null || !folder || !this.#current(projectId, folder) || !this.#safe(folder.folderCurrent) || !this.#current(projectId, folder)) return null;
    return Object.freeze({ path: folder.path, current: () => this.#current(projectId, folder) && this.#safe(folder.folderCurrent) && this.#current(projectId, folder) });
  }

  /** Local UI data only. A moved folder remains visible as invalid, without granting another task a capability. */
  state(projectId: string): ProjectCodingWorkspaceState | null {
    this.#owner(); const folder = this.#folders.get(projectId);
    if (!folder || !this.#current(projectId, folder)) return null;
    const valid = this.#safe(folder.folderCurrent);
    return this.#current(projectId, folder) ? { path: folder.path, label: folder.label, valid } : null;
  }

  clear(projectId: string): void {
    this.#revisions.set(projectId, this.#revision(projectId) + 1); this.#folders.delete(projectId);
  }
  clearAll(): void { this.#ownerRevision++; this.#folders.clear(); this.#revisions.clear(); }
  /** Call on every owner boundary, even if the same account/provider is later restored (ABA). */
  ownerReset(): void { this.clearAll(); this.#seenOwner = this.#readOwner(); }
}
