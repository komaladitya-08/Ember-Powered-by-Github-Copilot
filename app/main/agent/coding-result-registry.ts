/** Host-only shared owner/project registry. Physical filesystem authority belongs to its artifact store. */
import { createHash, randomUUID } from "node:crypto";
import type { CodingResultReview, CodingResultSummary } from "../../shared/project-coding";
import type { CodingReviewExport } from "./coding-result-export";
import { LinuxCodingArtifactStore } from "./linux-coding-artifact-store";
import { CodingArtifactCleanupError, CodingResultRegistryError, CODING_ARTIFACT_MESSAGES as MESSAGES,
  CODING_ARTIFACT_MAX_BYTES as MAX_BYTES, CODING_ARTIFACT_MAX_TRACKED as MAX_TRACKED,
  type CodingArtifactStore, type CodingArtifactInput, type CodingArtifactReceipt, type CodingArtifactSourceRef } from "./coding-artifact-store";
export { CodingResultRegistryError, CodingArtifactCleanupError } from "./coding-artifact-store";

const MAX_RECORDS = 32, MAX_PATCH = 256 * 1024, MAX_METADATA = 256 * 1024, MAX_CHANGES = 200;
export interface CodingResultRegistration {
  expectedOwner: string; projectId: string; taskId: string; title: string; sourcePath: string;
  status: "done" | "failed" | "stopped";
  checks: { ran: number; passed: number; failed: number };
  /** Original host intake receipt. Undefined preserves Linux legacy callers; null withholds all export. */
  sourceBoundary?: CodingArtifactSourceRef | null;
  /** Task-intake account/provider/project capability. A Stop alone does not revoke an inert result. */
  current(): boolean;
  /** Only a trusted stopped-writer backend supplies this host-only artifact capability. */
  output: CodingArtifactInput & { review: CodingReviewExport; cleanup: "complete" | "retained" };
}
export interface CodingResultRegistryOptions {
  privateBase: string;
  currentOwner(): string | null;
  projectExists(projectId: string): boolean;
  /** Explicit trusted-host injection only. Absence preserves the existing Linux storage boundary. */
  store?: CodingArtifactStore;
}
interface RecordEntry {
  owner: string; epoch: number; projectRevision: number; source: CodingArtifactSourceRef | null;
  summary: CodingResultSummary; review: CodingResultReview; artifact: CodingArtifactReceipt;
}
interface Context { owner: string; projectId: string; epoch: number; projectRevision: number; current: () => boolean; record?: { id: string; entry: RecordEntry } }
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const plain = (value: unknown, size: number): value is string => typeof value === "string" && !!value && Buffer.byteLength(value) <= size && !/[\p{Cc}\p{Cf}]/u.test(value);

/** Count a bounded host object before serialization. No file JSON is parsed, and no base64 enters IPC metadata. */
function serializedReview(review: CodingReviewExport): Buffer {
  let left = MAX_BYTES, nodes = 0;
  const seen = new Set<object>();
  const visit = (value: unknown, depth: number) => {
    if (++nodes > 500_000 || depth > 10) throw new CodingResultRegistryError("limit");
    if (typeof value === "string") {
      if (Buffer.byteLength(value) > left) throw new CodingResultRegistryError("limit");
      left -= Buffer.byteLength(JSON.stringify(value));
    } else if (typeof value === "boolean" || value === null || (typeof value === "number" && Number.isFinite(value))) left -= 24;
    else if (value && typeof value === "object" && !seen.has(value) && (Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype)) {
      seen.add(value); left -= 2;
      for (const [key, child] of Object.entries(value)) { left -= key.length * 6 + 8; visit(child, depth + 1); }
      seen.delete(value);
    } else throw new CodingResultRegistryError("invalid");
    if (left < 0) throw new CodingResultRegistryError("limit");
  };
  visit(review, 0);
  const bytes = Buffer.from(JSON.stringify(review, null, 2));
  if (bytes.length > MAX_BYTES) throw new CodingResultRegistryError("limit");
  return bytes;
}

function metadata(input: CodingResultRegistration, id: string): { summary: CodingResultSummary; review: CodingResultReview; json: Buffer; patch: Buffer } {
  const value = input.output.review;
  if (!value || value.version !== 1 || value.purpose !== "review-only" || value.binding?.owner !== input.expectedOwner ||
      !Array.isArray(value.changes) || value.changes.length > 10_000 || typeof value.textPatch !== "string" ||
      typeof value.patchComplete !== "boolean" || !Array.isArray(value.limitations) || value.limitations.length > 32) throw new CodingResultRegistryError("invalid");
  const json = serializedReview(value), patch = Buffer.from(value.textPatch);
  if (json.length + patch.length > MAX_BYTES) throw new CodingResultRegistryError("limit");
  const changes: CodingResultReview["changes"] = [];
  let omitted = 0, previewBytes = 2;
  for (const change of value.changes) {
    if (!plain(change.path, 4096) || change.path.startsWith("/") || change.path.split("/").some(part => !part || part === "." || part === "..") ||
        !["add", "modify", "delete", "type-change", "metadata"].includes(change.kind) || !Array.isArray(change.conflicts) || !Array.isArray(change.patchUnsupported) ||
        change.conflicts.length > 32 || change.patchUnsupported.length > 32 || [...change.conflicts, ...change.patchUnsupported].some(text => !plain(text, 2048))) throw new CodingResultRegistryError("invalid");
    const candidate = { path: change.path, kind: change.kind, conflicts: [...change.conflicts], patchUnsupported: [...change.patchUnsupported] };
    const size = Buffer.byteLength(JSON.stringify(candidate)) + 1;
    if (changes.length < MAX_CHANGES && previewBytes + size < MAX_METADATA / 2) { changes.push(candidate); previewBytes += size; }
    else omitted++;
  }
  if (value.limitations.some(text => !plain(text, 2048))) throw new CodingResultRegistryError("invalid");
  const conflicts = value.changes.filter(change => change.conflicts.length > 0).length;
  const summary: CodingResultSummary = {
    id, projectId: input.projectId, taskId: input.taskId, title: input.title, sourcePath: input.sourcePath,
    status: input.status, files: value.changes.length, conflicts,
    patchComplete: value.patchComplete && !conflicts && value.changes.every(change => !change.patchUnsupported.length),
    checks: { ...input.checks },
    message: `${input.status === "done" ? "Coding result" : "Partial coding result"} ready for review. The original folder is unchanged.${input.output.cleanup === "retained" ? " Some temporary coding files were retained." : ""}`,
  };
  const previewMessage = [
    "Export includes every captured baseline, proposed and current file, including unchanged files; review the destination before sharing.",
    ...(omitted ? [`This preview omits ${omitted} changed paths or their diagnostics; the exported JSON retains all of them.`] : []),
    ...(patch.length > MAX_PATCH ? ["The text patch is too large for a preview; export the review to read it whole."] : []),
  ].join(" ");
  const preview: CodingResultReview = { ...summary, changes, textPatch: patch.length > MAX_PATCH ? null : value.textPatch,
    limitations: [...value.limitations], previewMessage };
  return { summary, review: preview, json, patch };
}

export class CodingResultRegistry {
  #store: CodingArtifactStore;
  #owner: string | null;
  #options: CodingResultRegistryOptions;
  #epoch = 0;
  #records = new Map<string, RecordEntry>();
  #projectRevisions = new Map<string, number>();
  #pendingProjects = new Map<string, number>();
  #missingProjects = new Set<string>();
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  #closing: Promise<void> | null = null;

  private constructor(options: CodingResultRegistryOptions, store: CodingArtifactStore) {
    this.#options = { ...options }; this.#store = store; this.#owner = this.#readOwner();
  }
  static async create(options: CodingResultRegistryOptions): Promise<CodingResultRegistry> {
    if (!options || typeof options.currentOwner !== "function" || typeof options.projectExists !== "function") throw new CodingResultRegistryError("invalid");
    const captured = { ...options };
    try { return new CodingResultRegistry(captured, captured.store ?? await LinuxCodingArtifactStore.create(captured.privateBase)); }
    catch (error) { throw safe(error); }
  }
  #readOwner(): string | null {
    try { const value = this.#options.currentOwner(); return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null; } catch { return null; }
  }
  #syncOwner(): string | null {
    const owner = this.#readOwner();
    if (owner !== this.#owner) {
      this.#owner = owner; this.#epoch++; this.#records.clear(); this.#projectRevisions.clear(); this.#missingProjects.clear();
      void this.#queue(() => this.#cleanup()).catch(() => undefined);
    }
    return owner;
  }
  #valid(context: Context): boolean {
    try {
      return !this.#closed && this.#syncOwner() === context.owner && this.#epoch === context.epoch &&
        this.#exists(context.projectId) && (this.#projectRevisions.get(context.projectId) ?? 0) === context.projectRevision &&
        context.current() === true && this.#readOwner() === context.owner && this.#epoch === context.epoch &&
        (!context.record || this.#records.get(context.record.id) === context.record.entry);
    }
    catch { return false; }
  }
  #assert(context: Context): void { if (!this.#valid(context)) throw new CodingResultRegistryError("stale"); }
  #queue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#tail.then(operation); this.#tail = pending.catch(() => undefined); return pending;
  }
  put(input: CodingResultRegistration): Promise<CodingResultSummary> {
    try {
      if (this.#closed) throw new CodingResultRegistryError("stale");
      if (!input || !/^[a-f0-9]{64}$/.test(input.expectedOwner) || !plain(input.projectId, 200) || !plain(input.taskId, 200) ||
          !plain(input.title, 500) || !this.#store.validSourcePath(input.sourcePath) || !["done", "failed", "stopped"].includes(input.status) ||
          typeof input.current !== "function" || !input.checks || Object.keys(input.checks).sort().join(",") !== "failed,passed,ran" || Object.values(input.checks).some(n => !Number.isSafeInteger(n) || n < 0 || n > 10_000) ||
          input.checks.passed + input.checks.failed > input.checks.ran || !["complete", "retained"].includes(input.output?.cleanup)) throw new CodingResultRegistryError("invalid");
      const id = randomUUID(), captured = { ...input, checks: { ...input.checks }, output: { ...input.output } };
      this.#syncOwner();
      const rendered = metadata(captured, id);
      this.#pendingProjects.set(input.projectId, (this.#pendingProjects.get(input.projectId) ?? 0) + 1);
      const context: Context = { owner: input.expectedOwner, projectId: input.projectId, epoch: this.#epoch,
        projectRevision: this.#projectRevisions.get(input.projectId) ?? 0, current: input.current };
      let eligible = this.#valid(context);
      return this.#queue(async () => {
        try {
          const artifact = await this.#store.claim(captured.output, () => { eligible = this.#valid(context) && eligible; });
          if ([...this.#records.values()].some(record => record.artifact.ref === artifact.ref)) throw new CodingResultRegistryError("invalid");
          if (artifact.files["review.json"].sha256 !== hash(rendered.json) || artifact.files["changes.patch"].sha256 !== hash(rendered.patch) ||
              artifact.files["review.json"].bytes !== rendered.json.length || artifact.files["changes.patch"].bytes !== rendered.patch.length) throw new CodingResultRegistryError("artifact");
          if (!eligible || !this.#valid(context)) throw new CodingResultRegistryError("stale");
          if (this.#records.size >= MAX_RECORDS || [...this.#records.values()].reduce((sum, entry) => sum + entry.artifact.bytes, 0) + artifact.bytes > MAX_BYTES) throw new CodingResultRegistryError("limit");
          let source: CodingArtifactSourceRef | null = null;
          try {
            source = captured.sourceBoundary === null ? null : await this.#store.sourceBoundary(captured.sourcePath,
              () => this.#assert(context), captured.sourceBoundary);
          }
          catch (error) {
            if (error instanceof CodingArtifactCleanupError || captured.sourceBoundary !== undefined) throw error;
            // Legacy callers may retain preview when publication cannot capture a source boundary.
          }
          this.#assert(context);
          this.#records.set(id, { owner: context.owner, epoch: context.epoch, projectRevision: context.projectRevision, source,
            summary: rendered.summary, review: rendered.review, artifact });
          return structuredClone(rendered.summary);
        } catch (error) {
          try { await this.#cleanup(); } catch (cleanup) { if (cleanup instanceof CodingArtifactCleanupError) throw cleanup; }
          throw safe(error);
        }
      }).finally(() => {
        const count = (this.#pendingProjects.get(context.projectId) ?? 1) - 1;
        if (count) this.#pendingProjects.set(context.projectId, count); else this.#pendingProjects.delete(context.projectId);
      });
    } catch (error) { return Promise.reject(safe(error)); }
  }

  state(projectId: string): CodingResultSummary[] {
    const owner = this.#syncOwner();
    if (this.#closed || !owner || !this.#exists(projectId)) return [];
    return [...this.#records.values()].filter(entry => entry.owner === owner && entry.epoch === this.#epoch && entry.summary.projectId === projectId &&
      entry.projectRevision === (this.#projectRevisions.get(projectId) ?? 0)).map(entry => structuredClone(entry.summary));
  }
  #exists(projectId: string): boolean {
    let exists = false;
    try { exists = this.#options.projectExists(projectId) === true; } catch { /* Unknown project state is absent. */ }
    if (exists) this.#missingProjects.delete(projectId);
    else if (!this.#missingProjects.has(projectId) && (this.#pendingProjects.has(projectId) || [...this.#records.values()].some(record => record.summary.projectId === projectId))) {
      this.#missingProjects.add(projectId); this.#retireProject(projectId);
      void this.#queue(() => this.#cleanup()).catch(() => undefined);
    }
    return exists;
  }
  #retireProject(projectId: string): void {
    this.#projectRevisions.set(projectId, (this.#projectRevisions.get(projectId) ?? 0) + 1);
    for (const [id, record] of this.#records) if (record.summary.projectId === projectId) this.#records.delete(id);
  }
  #record(id: string): { record: RecordEntry; context: Context } | null {
    const owner = this.#syncOwner(), record = this.#records.get(id);
    if (!record || !owner || record.owner !== owner || record.epoch !== this.#epoch || !this.#exists(record.summary.projectId)) return null;
    return { record, context: { owner, projectId: record.summary.projectId, epoch: this.#epoch,
      projectRevision: record.projectRevision, current: () => true, record: { id, entry: record } } };
  }
  review(id: string): Promise<CodingResultReview | null> {
    const found = this.#record(id); if (!found) return Promise.resolve(null);
    return this.#queue(async () => {
      try {
        this.#assert(found.context);
        await this.#store.verify(found.record.artifact, () => this.#assert(found.context));
        this.#assert(found.context); return structuredClone(found.record.review);
      } catch (error) { if (error instanceof CodingArtifactCleanupError) throw error; return null; }
    });
  }
  export(id: string, destination: string, current: () => boolean): Promise<{ ok: boolean; message: string; directory?: string }> {
    const found = this.#record(id);
    if (!found || typeof current !== "function") return Promise.resolve({ ok: false, message: MESSAGES.stale });
    found.context.current = current;
    return this.#queue(async () => {
      const check = () => this.#assert(found.context);
      try {
        check(); await this.#store.verify(found.record.artifact, check); check();
        if (this.#store.size >= MAX_TRACKED) throw new CodingResultRegistryError("limit");
        return await this.#store.export(found.record.artifact, found.record.source, destination, check);
      } catch (error) { if (error instanceof CodingArtifactCleanupError) throw error; return { ok: false, message: safe(error).message }; }
    });
  }
  #cleanup(): Promise<void> { return this.#store.cleanup(new Set([...this.#records.values()].map(record => record.artifact.ref))); }
  /** Linux compatibility accepts a stopped artifact path; Windows requires its exact producer token. */
  discard(input: string | CodingArtifactInput): Promise<void> {
    const artifact = typeof input === "string" ? { directory: input } : input && { ...input };
    return this.#queue(async () => {
      if (this.#closed || !artifact || [...this.#records.values()].some(record => record.artifact.directory === artifact.directory)) throw new CodingResultRegistryError("invalid");
      await this.#store.discard(artifact);
      await this.#cleanup();
    }).catch(error => { throw safe(error); });
  }

  reset(): Promise<void> {
    this.#epoch++; this.#owner = this.#readOwner(); this.#records.clear(); this.#projectRevisions.clear(); this.#missingProjects.clear();
    return this.#queue(() => this.#cleanup());
  }
  /** Host project deletion/restore hook: invalidates this project's pending work without retiring another project. */
  forgetProject(projectId: string): Promise<void> {
    if (!plain(projectId, 200)) return Promise.reject(new CodingResultRegistryError("invalid"));
    this.#retireProject(projectId);
    return this.#queue(() => this.#cleanup());
  }
  /** Explicit Home action: revoke this minted result immediately, without stopping work or retiring its project. */
  forgetResult(id: string): Promise<void> {
    const found = this.#record(id);
    if (!found || !this.#valid(found.context)) return Promise.reject(new CodingResultRegistryError("stale"));
    this.#records.delete(id);
    // Retry every unretained artifact, preserving failed receipts and completed user exports as reset does.
    return this.#queue(() => this.#cleanup());
  }
  close(): Promise<void> {
    if (!this.#closing) {
      this.#closed = true;
      this.#closing = (async () => { try { await this.reset(); } finally { await this.#store.close(); } })();
    }
    return this.#closing;
  }
}
function safe(error: unknown): CodingResultRegistryError | CodingArtifactCleanupError {
  return error instanceof CodingArtifactCleanupError ? error : new CodingResultRegistryError(error instanceof CodingResultRegistryError ? error.code : "artifact");
}
