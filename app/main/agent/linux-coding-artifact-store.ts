/** Linux descriptor/mount implementation of the host-only exact review artifact store. */
import fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path/posix";
import { HOST_PLATFORM } from "../platform/os";
import {
  CODING_ARTIFACT_MAX_BYTES as MAX_BYTES, CODING_ARTIFACT_MAX_TRACKED as MAX_TRACKED,
  CODING_ARTIFACT_NAMES as NAMES, CODING_ARTIFACT_MESSAGES as MESSAGES,
  CodingResultRegistryError, CodingArtifactCleanupError,
  type CodingArtifactStore, type CodingArtifactName, type CodingArtifactRef, type CodingArtifactSourceRef,
  type CodingArtifactInput, type CodingArtifactReceipt, type CodingArtifactFiles, type CodingArtifactExportResult,
} from "./coding-artifact-store";

const DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
interface FileReceipt { stat: BigIntStats; sha256: string }
interface Artifact {
  directory: string; parent: string; name: string; parentStat: BigIntStats; mount: string; stat: BigIntStats;
  files: Partial<Record<CodingArtifactName, FileReceipt>>; bytes: number;
  reference?: CodingArtifactRef; receipt?: CodingArtifactReceipt; ownership?: "producer" | "claiming" | "claimed";
}
interface QuarantinedDirectory { directory: string; parent: string; name: string; parentStat: BigIntStats; mount: string; stat: BigIntStats | null }
interface SourceBoundary { path: string; stat: BigIntStats; mount: string }
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const identity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const stable = (a: BigIntStats, b: BigIntStats) => identity(a, b) && a.mode === b.mode && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const within = (file: string, root: string) => file === root || file.startsWith(root + "/");
function absolute(value: string): boolean {
  return typeof value === "string" && !!value && Buffer.byteLength(value) <= 4096 && !/[\p{Cc}\p{Cf}]/u.test(value) &&
    value.startsWith("/") && !value.split("/").slice(1).some(part => !part || part === "." || part === "..");
}
async function closeFile(file?: fs.FileHandle): Promise<void> {
  if (!file) return;
  try { await file.close(); } catch { throw new CodingArtifactCleanupError(); }
}
async function closeFiles(files: readonly (fs.FileHandle | undefined)[]): Promise<void> {
  const closed = await Promise.allSettled(files.map(closeFile));
  if (closed.some(result => result.status === "rejected")) throw new CodingArtifactCleanupError();
}
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
      try { await closeFile(directory); } catch (error) { await closeFile(child); throw error; }
      directory = child;
    }
    return directory;
  } catch (error) {
    // A failed close has unknown completion and must not be attempted a second time.
    if (!(error instanceof CodingArtifactCleanupError)) await closeFile(directory);
    throw error;
  }
}
function privateDirectory(stat: BigIntStats): boolean { return stat.isDirectory() && stat.uid === BigInt(process.getuid!()) && (stat.mode & 0o7077n) === 0n; }
function ordinaryFile(stat: BigIntStats): boolean { return stat.isFile() && stat.uid === BigInt(process.getuid!()) && stat.nlink === 1n && (stat.mode & 0o7077n) === 0n; }
function safe(error: unknown): CodingResultRegistryError | CodingArtifactCleanupError {
  return error instanceof CodingArtifactCleanupError ? error : new CodingResultRegistryError(error instanceof CodingResultRegistryError ? error.code : "artifact");
}
function continuationCheck(check: () => void): () => void {
  return () => {
    if (typeof check !== "function") throw new CodingResultRegistryError("invalid");
    try { check(); } catch (error) {
      if (error instanceof CodingArtifactCleanupError) throw error;
      throw new CodingResultRegistryError("stale");
    }
  };
}

export class LinuxCodingArtifactStore implements CodingArtifactStore {
  #base: fs.FileHandle; #basePath: string; #baseStat: BigIntStats; #baseMount: string;
  #tracked = new Map<string, Artifact>();
  #quarantined = new Map<string, QuarantinedDirectory>();
  #references = new Map<CodingArtifactRef, Artifact>();
  #sources = new WeakMap<CodingArtifactSourceRef, SourceBoundary>();
  #pendingWrites = 0; #pendingBytes = 0;
  #tail: Promise<unknown> = Promise.resolve();
  #closed = false; #closing: Promise<void> | null = null; #failure: CodingArtifactCleanupError | null = null;

  private constructor(privateBase: string, base: fs.FileHandle, stat: BigIntStats, id: string) {
    this.#basePath = privateBase; this.#base = base; this.#baseStat = stat; this.#baseMount = id;
  }
  static async create(privateBase: string): Promise<LinuxCodingArtifactStore> {
    if (HOST_PLATFORM !== "linux") throw new CodingResultRegistryError("unsupported");
    let base: fs.FileHandle | undefined;
    try {
      base = await openDirectory(privateBase);
      const stat = await base.stat({ bigint: true });
      if (!privateDirectory(stat)) throw new CodingResultRegistryError("artifact");
      return new LinuxCodingArtifactStore(privateBase, base, stat, await mount(base));
    } catch (error) { await closeFile(base); throw safe(error); }
  }
  get size(): number { return this.#tracked.size + this.#quarantined.size; }
  validSourcePath(source: string): boolean {
    return absolute(source) && !within(this.#basePath, source) && !within(source, this.#basePath);
  }
  #open(): void {
    if (this.#failure) throw this.#failure;
    if (this.#closed) throw new CodingResultRegistryError("stale");
  }
  #guard(check: () => void): () => void {
    return () => { this.#open(); if (typeof check !== "function") throw new CodingResultRegistryError("invalid"); check(); this.#open(); };
  }
  #queue<T>(operation: () => Promise<T>): Promise<T> {
    try { this.#open(); } catch (error) { return Promise.reject(error); }
    const pending = this.#tail.then(async () => { this.#open(); return operation(); }).catch(error => {
      if (error instanceof CodingArtifactCleanupError) this.#failure ??= error;
      throw safe(error);
    });
    this.#tail = pending.catch(() => undefined); return pending;
  }
  #resolve(receipt: CodingArtifactReceipt): Artifact {
    const artifact = receipt && this.#references.get(receipt.ref);
    if (!artifact || artifact.receipt !== receipt || artifact.ownership !== "claimed" || this.#tracked.get(artifact.directory) !== artifact) throw new CodingResultRegistryError("artifact");
    return artifact;
  }
  #receipt(artifact: Artifact): CodingArtifactReceipt {
    const reference = artifact.reference ??= Object.freeze({}) as CodingArtifactRef;
    const files = Object.freeze(Object.fromEntries(NAMES.map(name => [name, Object.freeze({ bytes: Number(artifact.files[name]!.stat.size), sha256: artifact.files[name]!.sha256 })]))) as CodingArtifactReceipt["files"];
    const receipt = Object.freeze({ ref: reference, directory: artifact.directory, bytes: artifact.bytes, files });
    artifact.receipt = receipt; this.#references.set(reference, artifact); return receipt;
  }
  async #baseCurrent(): Promise<void> {
    const base = await openDirectory(this.#basePath);
    try {
      const stat = await base.stat({ bigint: true });
      if (!identity(this.#baseStat, stat) || !privateDirectory(stat) || await mount(base) !== this.#baseMount ||
          await fs.realpath(`/proc/self/fd/${this.#base.fd}`) !== this.#basePath) throw new CodingResultRegistryError("artifact");
    } finally { await closeFile(base); }
  }
  async #capture(directory: string, check: () => void, expected?: Artifact): Promise<Artifact> {
    await this.#baseCurrent(); check();
    if (!absolute(directory) || path.dirname(directory) !== this.#basePath || !/^[A-Za-z0-9._-]{1,128}$/.test(path.basename(directory))) throw new CodingResultRegistryError("artifact");
    const root = await fs.open(`/proc/self/fd/${this.#base.fd}/${path.basename(directory)}`, DIR);
    try {
      check(); const stat = await root.stat({ bigint: true }); check();
      if (!privateDirectory(stat) || stat.dev !== this.#baseStat.dev || await mount(root) !== this.#baseMount ||
          (expected && !identity(stat, expected.stat))) throw new CodingResultRegistryError("artifact");
      check(); const names = (await fs.readdir(`/proc/self/fd/${root.fd}`)).sort(); check();
      if (names.join("\0") !== NAMES.join("\0")) throw new CodingResultRegistryError("artifact");
      const artifact: Artifact = { directory, parent: this.#basePath, name: path.basename(directory), parentStat: this.#baseStat,
        mount: this.#baseMount, stat, files: {}, bytes: 0 };
      for (const name of NAMES) {
        const file = await fs.open(`/proc/self/fd/${root.fd}/${name}`, FILE);
        try {
          check(); const receipt = await this.#read(file, check, undefined, MAX_BYTES - artifact.bytes); artifact.bytes += Number(receipt.stat.size);
          if (artifact.bytes > MAX_BYTES || (expected && (!stable(receipt.stat, expected.files[name]!.stat) || receipt.sha256 !== expected.files[name]!.sha256))) throw new CodingResultRegistryError("artifact");
          artifact.files[name] = receipt;
        } finally { await closeFile(file); }
      }
      if (!stable(stat, await root.stat({ bigint: true }))) throw new CodingResultRegistryError("artifact"); check(); return artifact;
    } finally { await closeFile(root); }
  }
  async #read(file: fs.FileHandle, check: () => void, write?: (bytes: Buffer) => Promise<void>, maximum = MAX_BYTES): Promise<FileReceipt> {
    const before = await file.stat({ bigint: true }); check();
    if (!ordinaryFile(before) || before.size > BigInt(maximum) || await mount(file) !== this.#baseMount) throw new CodingResultRegistryError("artifact"); check();
    const hashing = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let length = 0;
    try {
      while (length < Number(before.size)) {
        const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, Number(before.size) - length), length); check();
        if (!bytesRead) throw new CodingResultRegistryError("artifact");
        const bytes = buffer.subarray(0, bytesRead); hashing.update(bytes);
        if (write) { await write(bytes); check(); } length += bytesRead;
      }
      if (!stable(before, await file.stat({ bigint: true }))) throw new CodingResultRegistryError("artifact"); check();
      return { stat: before, sha256: hashing.digest("hex") };
    } finally { buffer.fill(0); }
  }
  write(files: CodingArtifactFiles, check: () => void): Promise<CodingArtifactInput & { artifact: CodingArtifactRef }> {
    let captured: CodingArtifactFiles, bytes = 0, reserved = false;
    try {
      this.#open();
      if (typeof check !== "function" || !files || Object.keys(files).sort().join("\0") !== NAMES.join("\0")) throw new CodingResultRegistryError("invalid");
      const provided = { "changes.patch": files["changes.patch"], "review.json": files["review.json"] };
      if (NAMES.some(name => !Buffer.isBuffer(provided[name]) || (typeof SharedArrayBuffer !== "undefined" && provided[name].buffer instanceof SharedArrayBuffer))) throw new CodingResultRegistryError("invalid");
      bytes = NAMES.reduce((sum, name) => sum + provided[name].length, 0); this.#open();
      if (bytes > MAX_BYTES || this.#pendingWrites >= MAX_TRACKED || this.#pendingBytes + bytes > MAX_BYTES) throw new CodingResultRegistryError("limit");
      this.#pendingWrites++; this.#pendingBytes += bytes; reserved = true;
      captured = { "changes.patch": Buffer.from(provided["changes.patch"]), "review.json": Buffer.from(provided["review.json"]) };
    } catch (error) {
      if (reserved) { this.#pendingWrites--; this.#pendingBytes -= bytes; }
      return Promise.reject(safe(error));
    }
    check = this.#guard(check);
    return this.#queue(async () => {
      let output: fs.FileHandle | undefined, artifact: Artifact | undefined, quarantine: QuarantinedDirectory | undefined;
      try {
        check(); await this.#baseCurrent(); check(); if (this.size >= MAX_TRACKED) throw new CodingResultRegistryError("limit");
        const name = `ember-coding-review-${randomUUID()}`, directory = path.join(this.#basePath, name);
        await fs.mkdir(`/proc/self/fd/${this.#base.fd}/${name}`, { mode: 0o700 });
        quarantine = { directory, parent: this.#basePath, name, parentStat: this.#baseStat, mount: this.#baseMount, stat: null };
        this.#quarantined.set(directory, quarantine);
        quarantine.stat = await fs.lstat(`/proc/self/fd/${this.#base.fd}/${name}`, { bigint: true });
        output = await fs.open(`/proc/self/fd/${this.#base.fd}/${name}`, DIR);
        const stat = await output.stat({ bigint: true });
        if (!privateDirectory(stat) || !identity(stat, quarantine.stat) || await mount(output) !== this.#baseMount) throw new CodingResultRegistryError("artifact");
        artifact = { directory, parent: this.#basePath, name, parentStat: this.#baseStat, mount: this.#baseMount, stat, files: {}, bytes: 0 };
        this.#tracked.set(directory, artifact); this.#quarantined.delete(directory); quarantine = undefined; check();
        for (const name of NAMES) {
          const out = await fs.open(`/proc/self/fd/${output.fd}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          try { check(); await out.writeFile(captured[name]); check(); await out.sync(); check(); }
          finally {
            try { artifact.files[name] = { stat: await out.stat({ bigint: true }), sha256: hash(captured[name]) }; artifact.bytes += Number(artifact.files[name]!.stat.size); }
            finally { await closeFile(out); }
          }
        }
        await output.sync(); await this.#base.sync(); check();
        const verified = await this.#capture(directory, check, artifact); check();
        verified.ownership = "producer"; this.#tracked.set(directory, verified);
        const receipt = this.#receipt(verified); artifact = undefined;
        return Object.freeze({ directory, artifact: receipt.ref });
      } catch (error) {
        if (artifact) await this.#remove(artifact).catch(problem => { if (problem instanceof CodingArtifactCleanupError) this.#failure ??= problem; });
        if (quarantine?.stat) await this.#removeQuarantine(quarantine).catch(problem => { if (problem instanceof CodingArtifactCleanupError) this.#failure ??= problem; });
        throw this.#failure ?? error;
      } finally { await closeFile(output); }
    }).finally(() => { this.#pendingWrites--; this.#pendingBytes -= bytes; });
  }
  claim(input: CodingArtifactInput, check: () => void): Promise<CodingArtifactReceipt> {
    let producer: Artifact | undefined;
    try {
      this.#open(); if (!input || typeof check !== "function") throw new CodingResultRegistryError("invalid");
      input = { directory: input.directory, artifact: input.artifact }; this.#open();
      if (input.artifact !== undefined) {
        producer = this.#references.get(input.artifact);
        if (!producer || producer.directory !== input.directory || producer.ownership !== "producer") throw new CodingResultRegistryError("invalid");
        producer.ownership = "claiming"; // Consume only a valid producer, before any verification await.
      }
    } catch (error) { return Promise.reject(safe(error)); }
    check = this.#guard(check);
    const pending = this.#queue(async () => {
      if (producer) producer.ownership = "claimed";
      else if (this.size >= MAX_TRACKED) throw new CodingResultRegistryError("limit");
      const artifact = await this.#capture(input.directory, check, producer);
      check();
      if (!producer && this.#tracked.has(artifact.directory)) throw new CodingResultRegistryError("invalid");
      if (producer) { check(); return producer.receipt!; }
      artifact.ownership = "claimed"; this.#tracked.set(artifact.directory, artifact); return this.#receipt(artifact);
    });
    return pending.catch(error => { if (producer?.ownership === "claiming") producer.ownership = "claimed"; throw error; });
  }
  verify(receipt: CodingArtifactReceipt, check: () => void): Promise<void> {
    check = this.#guard(check);
    return this.#queue(async () => { const artifact = this.#resolve(receipt); await this.#capture(artifact.directory, check, artifact); check(); });
  }
  read(receipt: CodingArtifactReceipt, name: CodingArtifactName, maximumBytes: number, check: () => void): Promise<Buffer> {
    check = this.#guard(continuationCheck(check));
    return this.#queue(async () => {
      let bytes: Buffer | undefined;
      try {
        check(); const artifact = this.#resolve(receipt);
        if (!NAMES.includes(name) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > MAX_BYTES) throw new CodingResultRegistryError("invalid");
        const expected = artifact.files[name]!;
        if (expected.stat.size > BigInt(maximumBytes)) throw new CodingResultRegistryError("limit");
        await this.#capture(artifact.directory, check, artifact); check();
        let root: fs.FileHandle | undefined, file: fs.FileHandle | undefined;
        try {
          root = await fs.open(`/proc/self/fd/${this.#base.fd}/${artifact.name}`, DIR); check();
          const stat = await root.stat({ bigint: true }); check();
          if (!privateDirectory(stat) || !identity(stat, artifact.stat) || await mount(root) !== artifact.mount) throw new CodingResultRegistryError("artifact");
          check(); file = await fs.open(`/proc/self/fd/${root.fd}/${name}`, FILE); check();
          bytes = Buffer.alloc(Number(expected.stat.size)); let length = 0;
          const observed = await this.#read(file, check, async chunk => {
            if (length + chunk.length > bytes!.length) throw new CodingResultRegistryError("artifact");
            chunk.copy(bytes!, length); length += chunk.length;
          }, maximumBytes);
          if (length !== bytes.length || !stable(expected.stat, observed.stat) || observed.sha256 !== expected.sha256) throw new CodingResultRegistryError("artifact");
          const eof = Buffer.alloc(1);
          try { const extra = await file.read(eof, 0, 1, length); check(); if (extra.bytesRead) throw new CodingResultRegistryError("artifact"); }
          finally { eof.fill(0); }
        } finally { await closeFiles([file, root]); }
        check(); await this.#capture(artifact.directory, check, artifact); check();
        if (!bytes) throw new CodingResultRegistryError("artifact"); return bytes;
      } catch (error) { bytes?.fill(0); throw error; }
    });
  }
  sourceBoundary(source: string, check: () => void, expected?: CodingArtifactSourceRef | null): Promise<CodingArtifactSourceRef | null> {
    check = this.#guard(check);
    return this.#queue(async () => {
      check(); if (!this.validSourcePath(source)) throw new CodingResultRegistryError("invalid");
      if (expected !== undefined) {
        if (expected === null) return null;
        const captured = this.#sources.get(expected);
        if (!captured || captured.path !== source) throw new CodingResultRegistryError("invalid");
        check(); return expected;
      }
      let boundary: SourceBoundary | null = null;
      try {
        const handle = await openDirectory(source);
        try { check(); const stat = await handle.stat({ bigint: true }); check(); boundary = { path: source, stat, mount: await mount(handle) }; check(); }
        finally { await closeFile(handle); }
      } catch (error) { if (error instanceof CodingArtifactCleanupError) throw error; check(); }
      check(); if (!boundary) return null;
      const reference = Object.freeze({}) as CodingArtifactSourceRef; this.#sources.set(reference, boundary); return reference;
    });
  }
  sameSource(original: CodingArtifactSourceRef | null, fresh: CodingArtifactSourceRef | null, check: () => void): Promise<boolean> {
    check = this.#guard(continuationCheck(check));
    return this.#queue(async () => {
      check(); await this.#baseCurrent(); check();
      const before = original && this.#sources.get(original), after = fresh && this.#sources.get(fresh);
      if (!before || !after || before.path !== after.path || !identity(before.stat, after.stat) || before.mount !== after.mount) return false;
      // Only filesystem failures become a negative attestation; the authority callback always propagates.
      const native = async <T>(operation: () => Promise<T>): Promise<T | null> => {
        try { return await operation(); } catch (error) { if (error instanceof CodingArtifactCleanupError) throw error; return null; }
      };
      const source = await native(() => openDirectory(before.path));
      if (!source) { check(); return false; }
      try {
        check();
        for (let pass = 0; pass < 2; pass++) {
          const stat = await native(() => source.stat({ bigint: true })); check();
          const id = await native(() => mount(source)); check();
          const currentPath = await native(() => fs.realpath(`/proc/self/fd/${source.fd}`)); check();
          if (!stat || !stat.isDirectory() || !identity(before.stat, stat) || !identity(after.stat, stat) || id !== before.mount || currentPath !== before.path) return false;
        }
      } finally { await closeFile(source); }
      check(); return true;
    });
  }
  export(receipt: CodingArtifactReceipt, sourceReference: CodingArtifactSourceRef | null, destination: string, check: () => void): Promise<CodingArtifactExportResult> {
    check = this.#guard(check);
    return this.#queue(async () => {
      let parent: fs.FileHandle | undefined, output: fs.FileHandle | undefined, artifact: Artifact | undefined, quarantine: QuarantinedDirectory | undefined;
      let reply: CodingArtifactExportResult;
      try {
        const held = this.#resolve(receipt), boundary = sourceReference && this.#sources.get(sourceReference);
        check(); await this.#capture(held.directory, check, held); check();
        if (this.size >= MAX_TRACKED) throw new CodingResultRegistryError("limit");
        if (!boundary || !absolute(destination) || within(destination, this.#basePath) || within(destination, boundary.path)) throw new CodingResultRegistryError("destination");
        const source = await openDirectory(boundary.path);
        try { if (!identity(boundary.stat, await source.stat({ bigint: true })) || await mount(source) !== boundary.mount) throw new CodingResultRegistryError("destination"); }
        finally { await closeFile(source); } check();
        let ancestor = "";
        for (const part of destination.slice(1).split("/")) {
          ancestor += "/" + part; const handle = await openDirectory(ancestor);
          try { const stat = await handle.stat({ bigint: true }); check(); if (identity(stat, boundary.stat) || identity(stat, this.#baseStat)) throw new CodingResultRegistryError("destination"); }
          finally { await closeFile(handle); }
        }
        parent = await openDirectory(destination); check();
        const parentStat = await parent.stat({ bigint: true }), parentMount = await mount(parent); check();
        if (parentStat.uid !== BigInt(process.getuid!()) || (parentStat.mode & 0o022n) !== 0n ||
            (parentStat.dev === boundary.stat.dev && parentMount !== boundary.mount) ||
            (parentStat.dev === this.#baseStat.dev && parentMount !== this.#baseMount)) throw new CodingResultRegistryError("destination");
        const name = `ember-coding-review-${randomUUID()}`, directory = path.join(destination, name);
        if (within(directory, boundary.path) || within(directory, this.#basePath)) throw new CodingResultRegistryError("destination");
        await fs.mkdir(`/proc/self/fd/${parent.fd}/${name}`, { mode: 0o700 });
        quarantine = { directory, parent: destination, name, parentStat, mount: parentMount, stat: null };
        this.#quarantined.set(directory, quarantine);
        quarantine.stat = await fs.lstat(`/proc/self/fd/${parent.fd}/${name}`, { bigint: true });
        output = await fs.open(`/proc/self/fd/${parent.fd}/${name}`, DIR);
        const stat = await output.stat({ bigint: true });
        if (!privateDirectory(stat) || !identity(stat, quarantine.stat) || await mount(output) !== parentMount) throw new CodingResultRegistryError("destination");
        artifact = { directory, parent: destination, name, parentStat, mount: parentMount, stat, files: {}, bytes: 0 };
        this.#tracked.set(directory, artifact); this.#quarantined.delete(directory); quarantine = undefined; check();
        const sourceDirectory = await fs.open(`/proc/self/fd/${this.#base.fd}/${held.name}`, DIR);
        try {
          if (!identity(await sourceDirectory.stat({ bigint: true }), held.stat)) throw new CodingResultRegistryError("artifact");
          for (const name of NAMES) {
            const input = await fs.open(`/proc/self/fd/${sourceDirectory.fd}/${name}`, FILE); let out: fs.FileHandle | undefined;
            try {
              out = await fs.open(`/proc/self/fd/${output.fd}/${name}`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
              const receipt = await this.#read(input, check, async bytes => { await out!.writeFile(bytes); check(); });
              if (!stable(receipt.stat, held.files[name]!.stat) || receipt.sha256 !== held.files[name]!.sha256) throw new CodingResultRegistryError("artifact");
              await out.sync(); check();
            } finally {
              try { if (out) { artifact.files[name] = { stat: await out.stat({ bigint: true }), sha256: "" }; artifact.bytes += Number(artifact.files[name]!.stat.size); } }
              finally { await closeFiles([out, input]); }
            }
          }
        } finally { await closeFile(sourceDirectory); }
        await output.sync(); await parent.sync(); check();
        const finalParent = await openDirectory(destination);
        try {
          if (!identity(await finalParent.stat({ bigint: true }), parentStat) || await mount(finalParent) !== parentMount ||
              await fs.realpath(`/proc/self/fd/${output.fd}`) !== directory) throw new CodingResultRegistryError("destination");
        } finally { await closeFile(finalParent); } check();
        this.#tracked.delete(directory); artifact = undefined;
        reply = { ok: true, directory, message: `Exported the coding review to ${directory}. It includes all captured files, including unchanged files.` };
      } catch (error) {
        if (error instanceof CodingArtifactCleanupError) this.#failure ??= error;
        if (artifact) await this.#remove(artifact).catch(problem => { if (problem instanceof CodingArtifactCleanupError) this.#failure ??= problem; });
        if (quarantine?.stat) await this.#removeQuarantine(quarantine).catch(problem => { if (problem instanceof CodingArtifactCleanupError) this.#failure ??= problem; });
        if (this.#failure) throw this.#failure;
        reply = { ok: false, message: quarantine && this.#quarantined.has(quarantine.directory) ? MESSAGES.cleanup : safe(error).message,
          ...(artifact && this.#tracked.has(artifact.directory) ? { directory: artifact.directory } : quarantine && this.#quarantined.has(quarantine.directory) ? { directory: quarantine.directory } : {}) };
      } finally {
        // A completed explicit export remains user-owned even when closing its final handle is unverified.
        try { await closeFiles([output, parent]); } catch (error) { this.#failure ??= error as CodingArtifactCleanupError; }
      }
      if (this.#failure) throw this.#failure; return reply!;
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
        for (const name of names as CodingArtifactName[]) {
          const file = await fs.open(`/proc/self/fd/${root.fd}/${name}`, FILE);
          try { if (!stable(await file.stat({ bigint: true }), artifact.files[name]!.stat) || await mount(file) !== artifact.mount) throw new CodingResultRegistryError("cleanup"); }
          finally { await closeFile(file); }
        }
        for (const name of names) await fs.unlink(`/proc/self/fd/${root.fd}/${name}`);
      } finally { await closeFile(root); }
      await fs.rmdir(`/proc/self/fd/${parent.fd}/${artifact.name}`); this.#tracked.delete(artifact.directory);
      if (artifact.reference) this.#references.delete(artifact.reference);
    } catch (error) { if (error instanceof CodingArtifactCleanupError) throw error; throw new CodingResultRegistryError("cleanup"); }
    finally { await closeFile(parent); }
  }
  async #removeQuarantine(directory: QuarantinedDirectory): Promise<void> {
    if (!directory.stat || !privateDirectory(directory.stat)) throw new CodingResultRegistryError("cleanup");
    await this.#remove({ ...directory, stat: directory.stat, files: {}, bytes: 0 }); this.#quarantined.delete(directory.directory);
  }
  async #cleanup(retained: ReadonlySet<CodingArtifactRef>, producers: boolean): Promise<void> {
    let failed = false;
    for (const artifact of [...this.#tracked.values()]) if ((producers || artifact.ownership !== "producer" && artifact.ownership !== "claiming") && (!artifact.reference || !retained.has(artifact.reference))) {
      try { await this.#remove(artifact); } catch (error) { failed = true; if (error instanceof CodingArtifactCleanupError) this.#failure ??= error; }
    }
    for (const directory of [...this.#quarantined.values()]) {
      try { await this.#removeQuarantine(directory); } catch (error) { failed = true; if (error instanceof CodingArtifactCleanupError) this.#failure ??= error; }
    }
    if (this.#failure) throw this.#failure;
    if (failed) throw new CodingResultRegistryError("cleanup");
  }
  cleanup(retained: ReadonlySet<CodingArtifactRef>): Promise<void> {
    const captured = new Set(retained); return this.#queue(() => this.#cleanup(captured, false));
  }
  discard(input: CodingArtifactInput): Promise<void> {
    input = { ...input };
    return this.#queue(async () => {
      if (!input || !absolute(input.directory) || path.dirname(input.directory) !== this.#basePath || !/^[A-Za-z0-9._-]{1,128}$/.test(path.basename(input.directory))) throw new CodingResultRegistryError("invalid");
      let artifact = this.#tracked.get(input.directory);
      if (input.artifact !== undefined && (!artifact || this.#references.get(input.artifact) !== artifact)) throw new CodingResultRegistryError("invalid");
      await this.#baseCurrent();
      if (!artifact) {
        try { await fs.lstat(`/proc/self/fd/${this.#base.fd}/${path.basename(input.directory)}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
        if (this.size >= MAX_TRACKED) throw new CodingResultRegistryError("limit");
        artifact = await this.#capture(input.directory, () => undefined); this.#tracked.set(input.directory, artifact);
      }
      artifact.ownership = "claimed"; await this.#remove(artifact);
    });
  }
  close(): Promise<void> {
    if (!this.#closing) {
      this.#closed = true; this.#sources = new WeakMap();
      this.#closing = this.#tail.then(async () => {
        let problem: unknown;
        try { await this.#cleanup(new Set(), true); } catch (error) { problem = error; }
        try { await closeFile(this.#base); } catch (error) { this.#failure ??= error as CodingArtifactCleanupError; }
        if (this.#failure) throw this.#failure;
        if (problem) throw safe(problem);
      });
    }
    return this.#closing;
  }
}
