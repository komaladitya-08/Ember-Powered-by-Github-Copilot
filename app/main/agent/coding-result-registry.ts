/**
 * Host-only, session-memory registry of stopped coding review artifacts. A minted id permits review/export only;
 * neither the id nor the files authorize execution or writes to the original project. put is never a model tool.
 * Linux descriptor/mount checks are required here. Windows needs its own verified ACL/reparse backend.
 * Successful explicit user exports outlive reset/Forget. Incomplete exports and private adopted artifacts do not.
 */
import fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path/posix";
import { HOST_PLATFORM } from "../platform/os";
import type { CodingResultReview, CodingResultSummary } from "../../shared/project-coding";
import type { CodingReviewExport } from "./coding-result-export";

const MAX_BYTES = 64 * 1024 * 1024, MAX_RECORDS = 32, MAX_TRACKED = 64;
const MAX_PATCH = 256 * 1024, MAX_METADATA = 256 * 1024, MAX_CHANGES = 200;
const NAMES = ["changes.patch", "review.json"] as const;
type FileName = typeof NAMES[number];
const DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
type Code = "unsupported" | "invalid" | "stale" | "limit" | "artifact" | "destination" | "cleanup";
const MESSAGES: Record<Code, string> = {
  unsupported: "Coding review storage is unavailable on this platform.", invalid: "The coding review registration is invalid.",
  stale: "This coding result no longer belongs to the current account and project.",
  limit: "The coding review storage limit was reached. Export or forget existing results before continuing.",
  artifact: "The private coding review changed or could not be verified.",
  destination: "Choose an ordinary local folder outside the original project and private coding review storage.",
  cleanup: "Some private coding reviews could not be removed safely; their cleanup records were retained.",
};
export class CodingResultRegistryError extends Error {
  readonly code: Code;
  constructor(code: Code) { super(MESSAGES[code]); this.code = code; this.name = "CodingResultRegistryError"; }
}
export interface CodingResultRegistration {
  expectedOwner: string; projectId: string; taskId: string; title: string; sourcePath: string;
  status: "done" | "failed" | "stopped";
  checks: { ran: number; passed: number; failed: number };
  /** Task-intake account/provider/project capability. A Stop alone must not revoke publication of an inert result. */
  current(): boolean;
  /** Only a host backend which has verified all command writers stopped may supply this output. */
  output: { directory: string; review: CodingReviewExport; cleanup: "complete" | "retained" };
}
export interface CodingResultRegistryOptions {
  /** Caller-created 0700 temporary directory outside Ember's user data, source and runtime trees. */
  privateBase: string;
  currentOwner(): string | null;
  projectExists(projectId: string): boolean;
}
interface FileReceipt { stat: BigIntStats; sha256: string }
interface Artifact {
  directory: string; parent: string; name: string; parentStat: BigIntStats; mount: string; stat: BigIntStats;
  files: Partial<Record<FileName, FileReceipt>>; bytes: number;
}
interface QuarantinedDirectory { directory: string; parent: string; name: string; parentStat: BigIntStats; mount: string; stat: BigIntStats | null }
interface RecordEntry { owner: string; epoch: number; projectRevision: number; source: string; sourceStat: BigIntStats | null; sourceMount: string | null; summary: CodingResultSummary; review: CodingResultReview; artifact: Artifact }
interface Context { owner: string; projectId: string; epoch: number; projectRevision: number; current: () => boolean }
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const identity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const stable = (a: BigIntStats, b: BigIntStats) => identity(a, b) && a.mode === b.mode && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const within = (file: string, root: string) => file === root || file.startsWith(root + "/");
const plain = (value: unknown, size: number): value is string => typeof value === "string" && !!value && Buffer.byteLength(value) <= size && !/[\p{Cc}\p{Cf}]/u.test(value);
function absolute(value: string): boolean { return plain(value, 4096) && value.startsWith("/") && !value.split("/").slice(1).some(part => !part || part === "." || part === ".."); }
async function mount(file: fs.FileHandle): Promise<string> {
  const info = await fs.readFile(`/proc/self/fdinfo/${file.fd}`, "utf8"), result = /^mnt_id:\s*(\d+)\s*$/m.exec(info)?.[1];
  if (!result) throw new CodingResultRegistryError("artifact"); return result;
}
async function openDirectory(value: string): Promise<fs.FileHandle> {
  if (!absolute(value)) throw new CodingResultRegistryError("artifact");
  let directory = await fs.open("/", DIR);
  try {
    for (const part of value.slice(1).split("/")) {
      const child = await fs.open(`/proc/self/fd/${directory.fd}/${part}`, DIR);
      await directory.close(); directory = child;
    }
    return directory;
  } catch (error) { await directory.close(); throw error; }
}
function privateDirectory(stat: BigIntStats): boolean { return stat.isDirectory() && stat.uid === BigInt(process.getuid!()) && (stat.mode & 0o7077n) === 0n; }
function ordinaryFile(stat: BigIntStats): boolean { return stat.isFile() && stat.uid === BigInt(process.getuid!()) && stat.nlink === 1n && (stat.mode & 0o7077n) === 0n; }

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
  #base: fs.FileHandle;
  #basePath: string;
  #baseStat: BigIntStats;
  #baseMount: string;
  #owner: string | null;
  #options: CodingResultRegistryOptions;
  #epoch = 0;
  #records = new Map<string, RecordEntry>();
  #tracked = new Map<string, Artifact>();
  #quarantined = new Map<string, QuarantinedDirectory>();
  #projectRevisions = new Map<string, number>();
  #pendingProjects = new Map<string, number>();
  #missingProjects = new Set<string>();
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false;
  #closing: Promise<void> | null = null;

  private constructor(options: CodingResultRegistryOptions, base: fs.FileHandle, stat: BigIntStats, id: string) {
    this.#options = { ...options }; this.#basePath = options.privateBase; this.#base = base; this.#baseStat = stat; this.#baseMount = id;
    this.#owner = this.#readOwner();
  }
  static async create(options: CodingResultRegistryOptions): Promise<CodingResultRegistry> {
    if (HOST_PLATFORM !== "linux") throw new CodingResultRegistryError("unsupported");
    if (!options || typeof options.currentOwner !== "function" || typeof options.projectExists !== "function") throw new CodingResultRegistryError("invalid");
    let base: fs.FileHandle | undefined;
    try {
      const captured = { ...options }; base = await openDirectory(captured.privateBase);
      const stat = await base.stat({ bigint: true });
      if (!privateDirectory(stat)) throw new CodingResultRegistryError("artifact");
      return new CodingResultRegistry(captured, base, stat, await mount(base));
    } catch (error) { await base?.close(); throw safe(error); }
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
        context.current() === true && this.#readOwner() === context.owner && this.#epoch === context.epoch;
    }
    catch { return false; }
  }
  #assert(context: Context): void { if (!this.#valid(context)) throw new CodingResultRegistryError("stale"); }
  #queue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#tail.then(operation); this.#tail = pending.catch(() => undefined); return pending;
  }
  async #baseCurrent(): Promise<void> {
    const base = await openDirectory(this.#basePath);
    try {
      const stat = await base.stat({ bigint: true });
      if (!identity(this.#baseStat, stat) || !privateDirectory(stat) || await mount(base) !== this.#baseMount ||
          await fs.realpath(`/proc/self/fd/${this.#base.fd}`) !== this.#basePath) throw new CodingResultRegistryError("artifact");
    } finally { await base.close(); }
  }

  async #capture(directory: string, check: () => void, expected?: Artifact): Promise<Artifact> {
    await this.#baseCurrent(); check();
    if (!absolute(directory) || path.dirname(directory) !== this.#basePath || !/^[A-Za-z0-9._-]{1,128}$/.test(path.basename(directory))) throw new CodingResultRegistryError("artifact");
    const root = await fs.open(`/proc/self/fd/${this.#base.fd}/${path.basename(directory)}`, DIR);
    try {
      check(); const stat = await root.stat({ bigint: true }); check();
      if (!privateDirectory(stat) || stat.dev !== this.#baseStat.dev || await mount(root) !== this.#baseMount ||
          (expected && !identity(stat, expected.stat))) throw new CodingResultRegistryError("artifact");
      check();
      const names = (await fs.readdir(`/proc/self/fd/${root.fd}`)).sort(); check();
      if (names.join("\0") !== NAMES.join("\0")) throw new CodingResultRegistryError("artifact");
      const artifact: Artifact = { directory, parent: this.#basePath, name: path.basename(directory), parentStat: this.#baseStat,
        mount: this.#baseMount, stat, files: {}, bytes: 0 };
      for (const name of NAMES) {
        const file = await fs.open(`/proc/self/fd/${root.fd}/${name}`, FILE);
        try {
          check(); const receipt = await this.#read(file, check, undefined, MAX_BYTES - artifact.bytes); artifact.bytes += Number(receipt.stat.size);
          if (artifact.bytes > MAX_BYTES || (expected && (!stable(receipt.stat, expected.files[name]!.stat) || receipt.sha256 !== expected.files[name]!.sha256))) throw new CodingResultRegistryError("artifact");
          artifact.files[name] = receipt;
        } finally { await file.close(); }
      }
      if (!stable(stat, await root.stat({ bigint: true }))) throw new CodingResultRegistryError("artifact"); check();
      return artifact;
    } finally { await root.close(); }
  }
  async #read(file: fs.FileHandle, check: () => void, write?: (bytes: Buffer) => Promise<void>, maximum = MAX_BYTES): Promise<FileReceipt> {
    const before = await file.stat({ bigint: true }); check();
    if (!ordinaryFile(before) || before.size > BigInt(maximum) || await mount(file) !== this.#baseMount) throw new CodingResultRegistryError("artifact"); check();
    const hashing = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let length = 0;
    while (length < Number(before.size)) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, Number(before.size) - length), length); check();
      if (!bytesRead) throw new CodingResultRegistryError("artifact");
      const bytes = buffer.subarray(0, bytesRead); hashing.update(bytes);
      if (write) { await write(bytes); check(); }
      length += bytesRead;
    }
    if (!stable(before, await file.stat({ bigint: true }))) throw new CodingResultRegistryError("artifact"); check();
    return { stat: before, sha256: hashing.digest("hex") };
  }

  put(input: CodingResultRegistration): Promise<CodingResultSummary> {
    try {
      if (this.#closed) throw new CodingResultRegistryError("stale");
      if (!input || !/^[a-f0-9]{64}$/.test(input.expectedOwner) || !plain(input.projectId, 200) || !plain(input.taskId, 200) ||
          !plain(input.title, 500) || !absolute(input.sourcePath) || !["done", "failed", "stopped"].includes(input.status) ||
          typeof input.current !== "function" || !input.checks || Object.keys(input.checks).sort().join(",") !== "failed,passed,ran" || Object.values(input.checks).some(n => !Number.isSafeInteger(n) || n < 0 || n > 10_000) ||
          input.checks.passed + input.checks.failed > input.checks.ran || !["complete", "retained"].includes(input.output?.cleanup)) throw new CodingResultRegistryError("invalid");
      const id = randomUUID(), captured = { ...input, checks: { ...input.checks }, output: { ...input.output } };
      if (within(this.#basePath, captured.sourcePath) || within(captured.sourcePath, this.#basePath)) throw new CodingResultRegistryError("invalid");
      this.#syncOwner();
      const rendered = metadata(captured, id);
      this.#pendingProjects.set(input.projectId, (this.#pendingProjects.get(input.projectId) ?? 0) + 1);
      const context: Context = { owner: input.expectedOwner, projectId: input.projectId, epoch: this.#epoch,
        projectRevision: this.#projectRevisions.get(input.projectId) ?? 0, current: input.current };
      let eligible = this.#valid(context);
      return this.#queue(async () => {
        try {
          if (this.#tracked.size + this.#quarantined.size >= MAX_TRACKED) throw new CodingResultRegistryError("limit");
          const artifact = await this.#capture(captured.output.directory, () => { eligible = this.#valid(context) && eligible; });
          if (this.#tracked.has(artifact.directory)) throw new CodingResultRegistryError("invalid");
          this.#tracked.set(artifact.directory, artifact);
          if (artifact.files["review.json"]!.sha256 !== hash(rendered.json) || artifact.files["changes.patch"]!.sha256 !== hash(rendered.patch) ||
              Number(artifact.files["review.json"]!.stat.size) !== rendered.json.length || Number(artifact.files["changes.patch"]!.stat.size) !== rendered.patch.length) throw new CodingResultRegistryError("artifact");
          if (!eligible || !this.#valid(context)) throw new CodingResultRegistryError("stale");
          if (this.#records.size >= MAX_RECORDS || [...this.#records.values()].reduce((sum, entry) => sum + entry.artifact.bytes, 0) + artifact.bytes > MAX_BYTES) throw new CodingResultRegistryError("limit");
          let sourceStat: BigIntStats | null = null, sourceMount: string | null = null;
          try {
            const source = await openDirectory(captured.sourcePath);
            try { sourceStat = await source.stat({ bigint: true }); sourceMount = await mount(source); } finally { await source.close(); }
          } catch { /* Preview survives a removed source; export then fails closed if its boundary cannot be verified. */ }
          this.#assert(context);
          this.#records.set(id, { owner: context.owner, epoch: context.epoch, projectRevision: context.projectRevision, source: captured.sourcePath, sourceStat, sourceMount,
            summary: rendered.summary, review: rendered.review, artifact });
          return structuredClone(rendered.summary);
        } catch (error) { await this.#cleanup().catch(() => undefined); throw safe(error); }
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
      projectRevision: record.projectRevision, current: () => true } };
  }
  review(id: string): Promise<CodingResultReview | null> {
    const found = this.#record(id); if (!found) return Promise.resolve(null);
    return this.#queue(async () => {
      try { this.#assert(found.context); await this.#capture(found.record.artifact.directory, () => this.#assert(found.context), found.record.artifact); return structuredClone(found.record.review); }
      catch { return null; }
    });
  }

  export(id: string, destination: string, current: () => boolean): Promise<{ ok: boolean; message: string; directory?: string }> {
    const found = this.#record(id);
    if (!found || typeof current !== "function") return Promise.resolve({ ok: false, message: MESSAGES.stale });
    found.context.current = current;
    return this.#queue(async () => {
      let parent: fs.FileHandle | undefined, output: fs.FileHandle | undefined, artifact: Artifact | undefined, quarantine: QuarantinedDirectory | undefined;
      let committed: string | undefined, reply: { ok: boolean; message: string; directory?: string };
      const check = () => this.#assert(found.context);
      try {
        check(); await this.#capture(found.record.artifact.directory, check, found.record.artifact); check();
        if (this.#tracked.size + this.#quarantined.size >= MAX_TRACKED) throw new CodingResultRegistryError("limit");
        if (!absolute(destination) || within(destination, this.#basePath) || within(destination, found.record.source) || !found.record.sourceStat || !found.record.sourceMount) throw new CodingResultRegistryError("destination");
        const source = await openDirectory(found.record.source);
        try { if (!identity(found.record.sourceStat, await source.stat({ bigint: true })) || await mount(source) !== found.record.sourceMount) throw new CodingResultRegistryError("destination"); } finally { await source.close(); }
        check();
        // Check all destination ancestors for a direct source alias and bind mounts on the source's device.
        let ancestor = "";
        for (const part of destination.slice(1).split("/")) {
          ancestor += "/" + part; const handle = await openDirectory(ancestor);
          try {
            const stat = await handle.stat({ bigint: true }); check();
            if (identity(stat, found.record.sourceStat) || identity(stat, this.#baseStat)) throw new CodingResultRegistryError("destination");
          } finally { await handle.close(); }
        }
        parent = await openDirectory(destination); check();
        const parentStat = await parent.stat({ bigint: true }), parentMount = await mount(parent); check();
        if (parentStat.uid !== BigInt(process.getuid!()) || (parentStat.mode & 0o022n) !== 0n ||
            (parentStat.dev === found.record.sourceStat.dev && parentMount !== found.record.sourceMount) ||
            (parentStat.dev === this.#baseStat.dev && parentMount !== this.#baseMount)) throw new CodingResultRegistryError("destination");
        const name = `ember-coding-review-${randomUUID()}`, directory = path.join(destination, name);
        if (within(directory, found.record.source) || within(directory, this.#basePath)) throw new CodingResultRegistryError("destination");
        await fs.mkdir(`/proc/self/fd/${parent.fd}/${name}`, { mode: 0o700 });
        quarantine = { directory, parent: destination, name, parentStat, mount: parentMount, stat: null };
        this.#quarantined.set(directory, quarantine); // No await between creation and cleanup tracking.
        quarantine.stat = await fs.lstat(`/proc/self/fd/${parent.fd}/${name}`, { bigint: true });
        output = await fs.open(`/proc/self/fd/${parent.fd}/${name}`, DIR);
        const stat = await output.stat({ bigint: true });
        if (!privateDirectory(stat) || !identity(stat, quarantine.stat) || await mount(output) !== parentMount) throw new CodingResultRegistryError("destination");
        artifact = { directory, parent: destination, name, parentStat, mount: parentMount, stat, files: {}, bytes: 0 };
        this.#tracked.set(directory, artifact); this.#quarantined.delete(directory); quarantine = undefined; check();
        const sourceDirectory = await fs.open(`/proc/self/fd/${this.#base.fd}/${found.record.artifact.name}`, DIR);
        try {
          if (!identity(await sourceDirectory.stat({ bigint: true }), found.record.artifact.stat)) throw new CodingResultRegistryError("artifact");
          for (const name of NAMES) {
            const input = await fs.open(`/proc/self/fd/${sourceDirectory.fd}/${name}`, FILE);
            let out: fs.FileHandle | undefined;
            try {
              out = await fs.open(`/proc/self/fd/${output.fd}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
              const receipt = await this.#read(input, check, async bytes => { await out!.writeFile(bytes); check(); });
              if (!stable(receipt.stat, found.record.artifact.files[name]!.stat) || receipt.sha256 !== found.record.artifact.files[name]!.sha256) throw new CodingResultRegistryError("artifact");
              await out.sync(); check();
            } finally {
              try {
                if (out) { artifact.files[name] = { stat: await out.stat({ bigint: true }), sha256: "" }; artifact.bytes += Number(artifact.files[name]!.stat.size); }
              } finally { try { await out?.close(); } finally { await input.close(); } }
            }
          }
        } finally { await sourceDirectory.close(); }
        await output.sync(); await parent.sync(); check();
        const finalParent = await openDirectory(destination);
        try {
          if (!identity(await finalParent.stat({ bigint: true }), parentStat) || await mount(finalParent) !== parentMount ||
              await fs.realpath(`/proc/self/fd/${output.fd}`) !== directory) throw new CodingResultRegistryError("destination");
        } finally { await finalParent.close(); }
        check();
        this.#tracked.delete(directory); // Explicit completed exports intentionally survive reset/Forget.
        committed = directory;
        artifact = undefined;
        reply = { ok: true, directory, message: `Exported the coding review to ${directory}. It includes all captured files, including unchanged files.` };
      } catch (error) {
        if (artifact) await this.#remove(artifact).catch(() => undefined);
        if (quarantine?.stat) await this.#removeQuarantine(quarantine).catch(() => undefined);
        reply = { ok: false, message: quarantine && this.#quarantined.has(quarantine.directory) ? MESSAGES.cleanup : safe(error).message,
          ...(artifact && this.#tracked.has(artifact.directory) ? { directory: artifact.directory } : quarantine && this.#quarantined.has(quarantine.directory) ? { directory: quarantine.directory } : {}) };
      } finally {
        const closed = await Promise.allSettled([output?.close(), parent?.close()]);
        if (closed.some(result => result.status === "rejected")) reply = { ok: false, message: MESSAGES.cleanup, ...(committed ? { directory: committed } : artifact ? { directory: artifact.directory } : {}) };
      }
      return reply!;
    });
  }

  async #remove(artifact: Artifact): Promise<void> {
    const parent = await openDirectory(artifact.parent);
    try {
      if (!identity(await parent.stat({ bigint: true }), artifact.parentStat) || await mount(parent) !== artifact.mount) throw new CodingResultRegistryError("cleanup");
      const root = await fs.open(`/proc/self/fd/${parent.fd}/${artifact.name}`, DIR);
      try {
        if (!identity(await root.stat({ bigint: true }), artifact.stat) || await mount(root) !== artifact.mount) throw new CodingResultRegistryError("cleanup");
        const names = await fs.readdir(`/proc/self/fd/${root.fd}`);
        if (names.some(name => !Object.hasOwn(artifact.files, name))) throw new CodingResultRegistryError("cleanup");
        for (const name of names as FileName[]) {
          const file = await fs.open(`/proc/self/fd/${root.fd}/${name}`, FILE);
          try { if (!stable(await file.stat({ bigint: true }), artifact.files[name]!.stat) || await mount(file) !== artifact.mount) throw new CodingResultRegistryError("cleanup"); }
          finally { await file.close(); }
        }
        for (const name of names) await fs.unlink(`/proc/self/fd/${root.fd}/${name}`);
      } finally { await root.close(); }
      await fs.rmdir(`/proc/self/fd/${parent.fd}/${artifact.name}`); this.#tracked.delete(artifact.directory);
    } catch {
      throw new CodingResultRegistryError("cleanup");
    } finally { await parent.close(); }
  }
  async #cleanup(): Promise<void> {
    const retained = new Set([...this.#records.values()].map(record => record.artifact.directory)); let failed = false;
    for (const artifact of [...this.#tracked.values()]) if (!retained.has(artifact.directory)) { try { await this.#remove(artifact); } catch { failed = true; } }
    for (const directory of [...this.#quarantined.values()]) { try { await this.#removeQuarantine(directory); } catch { failed = true; } }
    if (failed) throw new CodingResultRegistryError("cleanup");
  }
  /** Host-only recovery for a stopped artifact whose publication failed before registry adoption. Never an IPC/model path. */
  discard(directory: string): Promise<void> {
    return this.#queue(async () => {
      if (this.#closed || !absolute(directory) || path.dirname(directory) !== this.#basePath ||
          !/^[A-Za-z0-9._-]{1,128}$/.test(path.basename(directory)) ||
          [...this.#records.values()].some(record => record.artifact.directory === directory)) throw new CodingResultRegistryError("invalid");
      await this.#baseCurrent();
      if (!this.#tracked.has(directory)) {
        try { await fs.lstat(`/proc/self/fd/${this.#base.fd}/${path.basename(directory)}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw safe(error); }
        if (this.#tracked.size + this.#quarantined.size >= MAX_TRACKED) throw new CodingResultRegistryError("limit");
        const artifact = await this.#capture(directory, () => undefined);
        this.#tracked.set(directory, artifact);
      }
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
  async #removeQuarantine(directory: QuarantinedDirectory): Promise<void> {
    if (!directory.stat || !privateDirectory(directory.stat)) throw new CodingResultRegistryError("cleanup");
    const artifact: Artifact = { ...directory, stat: directory.stat, files: {}, bytes: 0 };
    await this.#remove(artifact); this.#quarantined.delete(directory.directory);
  }
  close(): Promise<void> {
    if (!this.#closing) {
      this.#closed = true;
      this.#closing = (async () => { try { await this.reset(); } finally { await this.#base.close(); } })();
    }
    return this.#closing;
  }
}

function safe(error: unknown): CodingResultRegistryError { return new CodingResultRegistryError(error instanceof CodingResultRegistryError ? error.code : "artifact"); }
