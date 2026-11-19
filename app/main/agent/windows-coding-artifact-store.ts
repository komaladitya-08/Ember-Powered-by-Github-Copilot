/** Disabled, host-only NTFS artifact storage. No command package receives access to these roots. */
import path from "node:path/win32";
import { createHash, randomUUID } from "node:crypto";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import { ScopedCodingFileError } from "./coding-platform";
import { CODING_ARTIFACT_MAX_BYTES, CODING_ARTIFACT_MAX_TRACKED, CODING_ARTIFACT_NAMES, CODING_ARTIFACT_MESSAGES,
  CodingResultRegistryError, CodingArtifactCleanupError, type CodingArtifactStore, type CodingArtifactFiles,
  type CodingArtifactRef, type CodingArtifactSourceRef, type CodingArtifactInput, type CodingArtifactReceipt,
  type CodingArtifactName, type CodingArtifactExportResult } from "./coding-artifact-store";
import { loadWindowsCodingNative, retireWindowsCodingNative, WindowsCodingCleanupError,
  type WindowsCodingNative, type WindowsCodingHandle, type WindowsCodingInfo, type WindowsCodingPin } from "./windows-coding-native";
import { windowsCodingRelative, windowsCodingSame, windowsCodingWithin, windowsCodingYield } from "./windows-coding-policy";

export interface WindowsCodingArtifactStoreOptions { privateBase: string; protectedPaths: readonly string[] }
interface OwnedHandle { handle: WindowsCodingHandle; closed: boolean; uncertain: boolean }
interface ArtifactFile extends OwnedHandle { info?: WindowsCodingInfo; sha256: string; removed: boolean; transferPending: boolean }
interface Artifact {
  ref: CodingArtifactRef; directory: string; root: OwnedHandle; info?: WindowsCodingInfo;
  parent: WindowsCodingPin; parentInfo: WindowsCodingInfo; ownParent: boolean;
  state: "producer" | "claimed" | "failed" | "export";
  files: Partial<Record<CodingArtifactName, ArtifactFile>>; receipt?: CodingArtifactReceipt;
}
interface Source { path: string; info: WindowsCodingInfo }
interface Protected { pin: WindowsCodingPin; info: WindowsCodingInfo; file?: OwnedHandle }
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const owned = (handle: WindowsCodingHandle): OwnedHandle => ({ handle, closed: false, uncertain: false });
function drivePath(value: string): boolean {
  if (typeof value !== "string" || value.length > 4096 || Buffer.byteLength(value) > 4096 || !/^[a-z]:\\/i.test(value) || value.includes("/") || /[\p{Cc}\p{Cf}]/u.test(value) || path.normalize(value) !== value) return false;
  try { windowsCodingRelative(value.slice(3).replace(/\\/g, "/")); return true; } catch { return false; }
}

export class WindowsCodingArtifactStore implements CodingArtifactStore {
  #api: WindowsCodingNative; #base: WindowsCodingPin; #baseInfo: WindowsCodingInfo; #options: WindowsCodingArtifactStoreOptions;
  #protected: Protected[]; #artifacts = new Map<CodingArtifactRef, Artifact>(); #sources = new WeakMap<CodingArtifactSourceRef, Source>();
  /** Exact capability acknowledgements only, after every native disposition and handle close succeeded. */
  #removed = new WeakMap<CodingArtifactRef, string>();
  #pins = new WeakMap<WindowsCodingPin, OwnedHandle[]>(); #failedPins = new Set<WindowsCodingPin>();
  #tail: Promise<unknown> = Promise.resolve(); #closed = false; #closing: Promise<void> | null = null;
  #terminal: CodingArtifactCleanupError | null = null; #pendingWrites = 0; #pendingBytes = 0;
  private constructor(options: WindowsCodingArtifactStoreOptions, api: WindowsCodingNative, base: WindowsCodingPin, roots: Protected[]) {
    this.#options = { ...options, protectedPaths: [...options.protectedPaths] }; this.#api = api; this.#base = base;
    this.#baseInfo = api.info(base.handle); this.#protected = roots;
    for (const pin of [base, ...roots.map(root => root.pin)]) this.#pins.set(pin, pin.handles.map(owned));
  }
  static async create(options: WindowsCodingArtifactStoreOptions): Promise<WindowsCodingArtifactStore> {
    if (HOST_PLATFORM !== "win32" || HOST_ARCH !== "x64") throw new CodingResultRegistryError("unsupported");
    const selectedBase = options?.privateBase, selectedRoots = options?.protectedPaths;
    if (!drivePath(selectedBase) || !Array.isArray(selectedRoots) || !selectedRoots.length || selectedRoots.length > 64) throw new CodingResultRegistryError("invalid");
    const captured: WindowsCodingArtifactStoreOptions = { privateBase: selectedBase, protectedPaths: [...selectedRoots] };
    if (captured.protectedPaths.some(value => !drivePath(value))) throw new CodingResultRegistryError("invalid");
    let api: WindowsCodingNative;
    try { api = loadWindowsCodingNative(); } catch (error) { if (error instanceof WindowsCodingCleanupError) throw new CodingArtifactCleanupError(); throw new CodingResultRegistryError("unsupported"); }
    const roots: Protected[] = [], pins: WindowsCodingPin[] = [];
    const pin = (location: string, mode: "read" | "base") => { const value = api.pin(location, mode); pins.push(value); return value; };
    try {
      const base = pin(captured.privateBase, "base");
      for (const location of captured.protectedPaths) {
        let selected: WindowsCodingPin;
        try { selected = pin(location, "read"); }
        catch (error) {
          if (!(error instanceof ScopedCodingFileError) || !["missing", "unsupported"].includes(error.code)) throw error;
          selected = pin(path.dirname(location), "read"); const entry: Protected = { pin: selected, info: api.info(selected.handle) }; roots.push(entry);
          entry.file = owned(api.open(selected.handle, path.basename(location), "file", "source")); entry.info = api.info(entry.file.handle); continue;
        }
        roots.push({ pin: selected, info: api.info(selected.handle) });
      }
      return new WindowsCodingArtifactStore(captured, api, base, roots);
    } catch (error) {
      let failed = false;
      for (const root of roots.reverse()) {
        if (root.file) { try { api.close(root.file.handle); } catch { failed = true; } }
      }
      for (const selected of pins.reverse()) for (const handle of selected.handles.slice().reverse()) { try { api.close(handle); } catch { failed = true; } }
      if (failed || error instanceof WindowsCodingCleanupError) { retireWindowsCodingNative(); throw new CodingArtifactCleanupError(); }
      throw new CodingResultRegistryError("artifact");
    }
  }
  get size(): number { return this.#artifacts.size; }
  validSourcePath(source: string): boolean {
    return drivePath(source) && !windowsCodingWithin(source, this.#options.privateBase) && !windowsCodingWithin(this.#options.privateBase, source);
  }
  #queue<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.#tail.then(operation); this.#tail = pending.catch(() => undefined); return pending;
  }
  #poison(): CodingArtifactCleanupError { retireWindowsCodingNative(); return this.#terminal ??= new CodingArtifactCleanupError(); }
  #safe(error: unknown, code: "artifact" | "destination" | "cleanup" = "artifact"): CodingResultRegistryError | CodingArtifactCleanupError {
    if (this.#terminal || error instanceof WindowsCodingCleanupError || error instanceof CodingArtifactCleanupError) return this.#poison();
    if (error instanceof CodingResultRegistryError) return error;
    return new CodingResultRegistryError(error instanceof ScopedCodingFileError && error.code === "limit" ? "limit" : code);
  }
  #admit(check: () => void): void {
    if (this.#terminal) throw this.#terminal;
    if (this.#closed) throw new CodingResultRegistryError("stale");
    check();
    if (this.#terminal) throw this.#terminal;
    if (this.#closed) throw new CodingResultRegistryError("stale");
    this.#baseCurrent();
  }
  #baseCurrent(): void {
    if (!windowsCodingSame(this.#baseInfo, this.#api.info(this.#base.handle), false)) throw new CodingResultRegistryError("artifact");
    for (const entry of this.#protected) if (!windowsCodingSame(entry.info, this.#api.info(entry.file?.handle ?? entry.pin.handle), false)) throw new CodingResultRegistryError("artifact");
  }
  #close(handle: OwnedHandle): void {
    if (handle.closed) return;
    if (handle.uncertain) throw this.#poison();
    try { this.#api.close(handle.handle); handle.closed = true; }
    catch { handle.uncertain = true; throw this.#poison(); }
  }
  #pin(location: string, mode: "read" | "base"): WindowsCodingPin {
    const pin = this.#api.pin(location, mode); this.#pins.set(pin, pin.handles.map(owned)); return pin;
  }
  #rootCurrent(record: Artifact): void {
    this.#baseCurrent();
    if (record.root.closed || record.root.uncertain || !record.info || !windowsCodingSame(record.info, this.#api.info(record.root.handle), false) ||
        !windowsCodingSame(record.parentInfo, this.#api.info(record.parent.handle), false)) throw new CodingResultRegistryError("artifact");
    this.#api.assertPrivate(record.root.handle);
    const current = this.#api.info(record.root.handle);
    if (current.attributes !== record.info.attributes || current.created !== record.info.created) throw new CodingResultRegistryError("artifact");
  }
  #newRecord(parent: WindowsCodingPin, parentInfo: WindowsCodingInfo, ownParent: boolean, state: Artifact["state"]): Artifact {
    if (this.size >= CODING_ARTIFACT_MAX_TRACKED) throw new CodingResultRegistryError("limit");
    const name = `ember-coding-review-${randomUUID()}`, ref = Object.freeze({}) as CodingArtifactRef;
    const root = this.#api.create(parent.handle, name, "directory");
    // NtCreateFile is synchronous: retain ownership before info, callbacks, or any await.
    const record: Artifact = { ref, directory: path.join(parent.path, name), root: owned(root), parent, parentInfo, ownParent, state, files: {} };
    this.#artifacts.set(ref, record);
    return record;
  }
  #lookup(input: CodingArtifactInput): Artifact {
    const ref = input?.artifact, directory = input?.directory, record = ref && this.#artifacts.get(ref);
    if (!record || directory !== record.directory) throw new CodingResultRegistryError("invalid"); return record;
  }
  #input(input: CodingArtifactInput): CodingArtifactInput { const directory = input?.directory, artifact = input?.artifact; return { directory, artifact }; }
  #initialize(record: Artifact): void { record.info = this.#api.info(record.root.handle); this.#api.assertPrivate(record.root.handle); }
  #receiptRecord(receipt: CodingArtifactReceipt): Artifact {
    const record = receipt?.ref && this.#artifacts.get(receipt.ref);
    if (!record || record.receipt !== receipt || record.state !== "claimed") throw new CodingResultRegistryError("invalid"); return record;
  }
  async #read(record: Artifact, name: CodingArtifactName, check: () => void, cleanup = false): Promise<Buffer> {
    const entry = record.files[name]; if (!entry?.info || entry.closed || entry.uncertain) throw new CodingResultRegistryError("artifact");
    const verify = () => {
      if (cleanup) { if (this.#terminal) throw this.#terminal; } else this.#admit(check);
      this.#rootCurrent(record); this.#api.assertPrivate(entry.handle);
      if (!windowsCodingSame(entry.info!, this.#api.info(entry.handle)) || entry.info!.kind !== "file" || entry.info!.links !== 1 || entry.info!.size > CODING_ARTIFACT_MAX_BYTES) throw new CodingResultRegistryError("artifact");
    };
    verify(); const bytes = Buffer.alloc(entry.info.size);
    try {
      for (let offset = 0; offset < bytes.length;) {
        verify(); const chunk = this.#api.read(entry.handle, offset, Math.min(64 * 1024, bytes.length - offset));
        try {
          if (!chunk.length || chunk.length > bytes.length - offset) throw new CodingResultRegistryError("artifact");
          chunk.copy(bytes, offset); offset += chunk.length;
        } finally { chunk.fill(0); }
        await windowsCodingYield(); verify();
      }
      const eof = this.#api.read(entry.handle, bytes.length, 1);
      try { if (eof.length || digest(bytes) !== entry.sha256) throw new CodingResultRegistryError("artifact"); }
      finally { eof.fill(0); }
      verify(); return bytes;
    } catch (error) { bytes.fill(0); throw error; }
  }
  async #settleTransfer(record: Artifact, name: CodingArtifactName, check: () => void, cleanup = false): Promise<void> {
    const entry = record.files[name];
    if (!entry?.info || !entry.transferPending || entry.uncertain) throw new CodingResultRegistryError("artifact");
    this.#rootCurrent(record); const settling = entry.closed; let opened = false, verified = false;
    if (entry.closed) { entry.handle = this.#api.open(record.root.handle, name, "file", "copy"); entry.closed = false; opened = true; }
    try {
      this.#api.assertPrivate(entry.handle); const before = entry.info, observed = this.#api.info(entry.handle);
      // Only a still-unsealed, hash-verified creator transfer may settle Windows' own close-time timestamps.
      if (!windowsCodingSame(before, observed, false) || before.size !== observed.size || before.attributes !== observed.attributes || before.created !== observed.created || observed.links !== 1) throw new CodingResultRegistryError("artifact");
      if (!settling && !windowsCodingSame(before, observed)) throw new CodingResultRegistryError("artifact");
      verified = true; entry.info = observed;
      const bytes = await this.#read(record, name, check, cleanup); bytes.fill(0);
      entry.transferPending = false;
    } catch (error) { if (opened && !verified) this.#close(entry); throw error; }
  }
  async #verify(record: Artifact, check: () => void): Promise<void> {
    this.#admit(check); this.#rootCurrent(record);
    const before = this.#api.info(record.root.handle), listed = this.#api.list(record.root.handle, 3);
    if (listed.map(entry => entry.name).sort().join("\0") !== CODING_ARTIFACT_NAMES.join("\0")) throw new CodingResultRegistryError("artifact");
    for (const name of CODING_ARTIFACT_NAMES) {
      const entry = record.files[name]; if (!entry?.info || listed.find(item => item.name === name)?.id !== entry.info.id) throw new CodingResultRegistryError("artifact");
      const bytes = await this.#read(record, name, check); bytes.fill(0); this.#admit(check);
    }
    if (!windowsCodingSame(before, this.#api.info(record.root.handle))) throw new CodingResultRegistryError("artifact"); this.#admit(check);
  }
  async #writeFiles(record: Artifact, files: CodingArtifactFiles, check: () => void): Promise<void> {
    if (!record.info) this.#initialize(record);
    for (const name of CODING_ARTIFACT_NAMES) {
      this.#admit(check); this.#rootCurrent(record);
      const handle = this.#api.create(record.root.handle, name, "file"), entry: ArtifactFile = { ...owned(handle), sha256: digest(files[name]), removed: false, transferPending: false };
      record.files[name] = entry; let writerOpen = true;
      try {
        entry.info = this.#api.info(handle); this.#api.assertPrivate(handle); record.info = this.#api.info(record.root.handle);
        this.#api.write(handle, files[name]); entry.info = this.#api.info(handle); this.#api.flush(handle); entry.info = this.#api.info(handle);
        const bytes = await this.#read(record, name, check); bytes.fill(0); this.#admit(check);
        entry.transferPending = true; this.#close(entry); writerOpen = false;
        await this.#settleTransfer(record, name, check); this.#admit(check);
      } catch (error) {
        // A synchronous failed write can have changed our freshly minted object. Preserve that exact receipt for cleanup.
        if (writerOpen && !entry.closed && !entry.uncertain && !this.#terminal) {
          try { const info = this.#api.info(entry.handle); if (!entry.info || windowsCodingSame(entry.info, info, false)) entry.info = info; } catch { /* Unverifiable object remains quarantined. */ }
        }
        throw error;
      }
      record.info = this.#api.info(record.root.handle); this.#admit(check);
    }
    await this.#verify(record, check);
  }
  write(files: CodingArtifactFiles, check: () => void): Promise<CodingArtifactInput & { artifact: CodingArtifactRef }> {
    let captured: CodingArtifactFiles, byteCount = 0, reserved = false;
    try {
      this.#admit(check);
      if (!files || Object.keys(files).sort().join("\0") !== CODING_ARTIFACT_NAMES.join("\0")) throw new CodingResultRegistryError("invalid");
      const source = { "changes.patch": files["changes.patch"], "review.json": files["review.json"] };
      this.#admit(check); // Input getters may have synchronously revoked or closed the host session.
      if (CODING_ARTIFACT_NAMES.some(name => !Buffer.isBuffer(source[name]) || typeof SharedArrayBuffer !== "undefined" && source[name].buffer instanceof SharedArrayBuffer) ||
          (byteCount = CODING_ARTIFACT_NAMES.reduce((sum, name) => sum + source[name].length, 0)) > CODING_ARTIFACT_MAX_BYTES ||
          this.size + this.#pendingWrites >= CODING_ARTIFACT_MAX_TRACKED || this.#pendingBytes + byteCount > CODING_ARTIFACT_MAX_BYTES) throw new CodingResultRegistryError("limit");
      this.#pendingWrites++; this.#pendingBytes += byteCount; reserved = true;
      captured = { "review.json": Buffer.from(source["review.json"]), "changes.patch": Buffer.from(source["changes.patch"]) };
    } catch (error) { if (reserved) { this.#pendingWrites--; this.#pendingBytes -= byteCount; } return Promise.reject(this.#safe(error)); }
    return this.#queue(async () => {
      let record: Artifact | undefined;
      try { this.#admit(check); record = this.#newRecord(this.#base, this.#baseInfo, false, "producer"); await this.#writeFiles(record, captured, check); this.#admit(check); return Object.freeze({ directory: record.directory, artifact: record.ref }); }
      catch (error) {
        if (record) { record.state = "failed"; try { await this.#remove(record); } catch { /* Ledger retains exact ownership. */ } }
        throw this.#safe(error);
      }
    }).finally(() => { this.#pendingWrites--; this.#pendingBytes -= byteCount; for (const name of CODING_ARTIFACT_NAMES) captured[name].fill(0); });
  }
  claim(input: CodingArtifactInput, check: () => void): Promise<CodingArtifactReceipt> {
    let captured: CodingArtifactInput;
    try { captured = this.#input(input); this.#admit(check); } catch (error) { return Promise.reject(this.#safe(error)); }
    return this.#queue(async () => {
      let record: Artifact;
      try {
        this.#admit(check); record = this.#lookup(captured); this.#admit(check); if (record.state !== "producer") throw new CodingResultRegistryError("invalid");
        record.state = "claimed"; // Consume the producer before verification or its first await.
        await this.#verify(record, check); this.#admit(check);
        const files = Object.freeze(Object.fromEntries(CODING_ARTIFACT_NAMES.map(name => [name, Object.freeze({ bytes: record.files[name]!.info!.size, sha256: record.files[name]!.sha256 })])) as CodingArtifactReceipt["files"]);
        return record.receipt = Object.freeze({ ref: record.ref, directory: record.directory, bytes: CODING_ARTIFACT_NAMES.reduce((sum, name) => sum + files[name].bytes, 0), files });
      } catch (error) { throw this.#safe(error); }
    });
  }
  verify(receipt: CodingArtifactReceipt, check: () => void): Promise<void> {
    return this.#queue(async () => { try { this.#admit(check); await this.#verify(this.#receiptRecord(receipt), check); } catch (error) { throw this.#safe(error); } });
  }
  #continuationCheck(check: () => void): () => void {
    if (typeof check !== "function") throw new CodingResultRegistryError("invalid");
    return () => {
      try { check(); }
      catch (error) {
        if (error instanceof WindowsCodingCleanupError || error instanceof CodingArtifactCleanupError) throw error;
        throw new CodingResultRegistryError("stale");
      }
    };
  }
  read(receipt: CodingArtifactReceipt, name: CodingArtifactName, maximumBytes: number, check: () => void): Promise<Buffer> {
    return this.#queue(async () => {
      let bytes: Buffer | undefined;
      try {
        check = this.#continuationCheck(check); this.#admit(check);
        if (!CODING_ARTIFACT_NAMES.includes(name) || !Number.isSafeInteger(maximumBytes) || maximumBytes < 0 || maximumBytes > CODING_ARTIFACT_MAX_BYTES) throw new CodingResultRegistryError("invalid");
        const record = this.#receiptRecord(receipt);
        if (receipt.files[name].bytes > maximumBytes) throw new CodingResultRegistryError("limit");
        await this.#verify(record, check); this.#admit(check);
        bytes = await this.#read(record, name, check); this.#admit(check);
        if (bytes.length !== receipt.files[name].bytes || bytes.length > maximumBytes) throw new CodingResultRegistryError("artifact");
        await this.#verify(record, check); this.#admit(check); return bytes;
      } catch (error) { bytes?.fill(0); throw this.#safe(error); }
    });
  }
  sameSource(original: CodingArtifactSourceRef | null, fresh: CodingArtifactSourceRef | null, check: () => void): Promise<boolean> {
    return this.#queue(async () => {
      let pin: WindowsCodingPin | undefined;
      try {
        check = this.#continuationCheck(check); this.#admit(check);
        const previous = original && this.#sources.get(original), next = fresh && this.#sources.get(fresh);
        if (!previous || !next || previous.path !== next.path || !windowsCodingSame(previous.info, next.info, false)) return false;
        try { pin = this.#pin(previous.path, "read"); }
        catch (error) {
          if (error instanceof WindowsCodingCleanupError || error instanceof CodingArtifactCleanupError) throw error;
          this.#admit(check); return false;
        }
        const matches = () => {
          try {
            const current = this.#api.info(pin!.handle);
            return windowsCodingSame(previous.info, current, false) && windowsCodingSame(next.info, current, false);
          } catch (error) {
            if (error instanceof WindowsCodingCleanupError || error instanceof CodingArtifactCleanupError) throw error;
            return false;
          }
        };
        this.#admit(check); if (!matches()) return false;
        await windowsCodingYield(); this.#admit(check); if (!matches()) return false;
        // Source pins prevent namespace replacement while held. No callback or await separates this
        // final source/current check from verified release and the store's terminal/base fence.
        const released = pin; pin = undefined; this.#closePin(released);
        this.#admit(() => undefined); return true;
      } catch (error) { throw this.#safe(error); }
      finally { if (pin) this.#closePin(pin); }
    });
  }
  sourceBoundary(source: string, check: () => void, expected?: CodingArtifactSourceRef): Promise<CodingArtifactSourceRef | null> {
    return this.#queue(async () => {
      let pin: WindowsCodingPin | undefined, result: CodingArtifactSourceRef | null = null, failure: unknown;
      try {
        this.#admit(check);
        if (expected !== undefined) {
          const receipt = this.#sources.get(expected);
          if (!receipt || receipt.path !== source) throw new CodingResultRegistryError("invalid");
          return expected;
        }
        if (this.validSourcePath(source)) {
          pin = this.#pin(source, "read"); const info = this.#api.info(pin.handle);
          if (!(windowsCodingWithin(info.finalPath, this.#baseInfo.finalPath) || windowsCodingWithin(this.#baseInfo.finalPath, info.finalPath) || this.#protected.some(entry =>
            windowsCodingWithin(info.finalPath, entry.info.finalPath) || windowsCodingWithin(entry.info.finalPath, info.finalPath)))) {
            this.#admit(check); result = Object.freeze({}) as CodingArtifactSourceRef; this.#sources.set(result, { path: source, info });
          }
        }
      } catch (error) { failure = error; }
      finally { if (pin) { try { this.#closePin(pin); } catch (error) { failure = error; } } }
      if (failure instanceof WindowsCodingCleanupError || failure instanceof CodingArtifactCleanupError || this.#terminal) throw this.#poison();
      if (failure instanceof CodingResultRegistryError && ["stale", "invalid"].includes(failure.code)) throw failure;
      return failure ? null : result;
    });
  }
  #destination(parent: WindowsCodingPin, source: Source): WindowsCodingInfo {
    const info = this.#api.info(parent.handle);
    if (windowsCodingWithin(info.finalPath, source.info.finalPath) || windowsCodingWithin(info.finalPath, this.#baseInfo.finalPath) || this.#protected.some(entry => windowsCodingWithin(info.finalPath, entry.info.finalPath))) throw new CodingResultRegistryError("destination");
    for (const handle of parent.handles) {
      const ancestor = this.#api.info(handle);
      if ([source.info, this.#baseInfo, ...this.#protected.map(entry => entry.info)].some(root => root.volume === ancestor.volume && root.id === ancestor.id)) throw new CodingResultRegistryError("destination");
    }
    return info;
  }
  export(receipt: CodingArtifactReceipt, sourceRef: CodingArtifactSourceRef | null, destination: string, check: () => void): Promise<CodingArtifactExportResult> {
    return this.#queue(async () => {
      let sourcePin: WindowsCodingPin | undefined, parent: WindowsCodingPin | undefined, record: Artifact | undefined, committed: string | undefined;
      let result: CodingArtifactExportResult;
      try {
        this.#admit(check); const original = this.#receiptRecord(receipt), source = sourceRef && this.#sources.get(sourceRef);
        if (!source || !drivePath(destination)) throw new CodingResultRegistryError("destination");
        await this.#verify(original, check); this.#admit(check);
        sourcePin = this.#pin(source.path, "read"); if (!windowsCodingSame(source.info, this.#api.info(sourcePin.handle), false)) throw new CodingResultRegistryError("destination");
        parent = this.#pin(destination, "base"); const parentInfo = this.#destination(parent, source); this.#admit(check);
        record = this.#newRecord(parent, parentInfo, true, "export"); parent = undefined;
        this.#initialize(record); // Keep a creation identity before awaiting any original bytes.
        const files = { "changes.patch": await this.#read(original, "changes.patch", check), "review.json": await this.#read(original, "review.json", check) };
        this.#admit(check); await this.#writeFiles(record, files, check); this.#admit(check);
        this.#destination(record.parent, source);
        if (!windowsCodingSame(source.info, this.#api.info(sourcePin.handle), false)) throw new CodingResultRegistryError("destination");
        const releasedSource = sourcePin; sourcePin = undefined; this.#closePin(releasedSource);
        // No await/callback separates final authority check, verified handle release and publication.
        this.#admit(check); this.#rootCurrent(record); this.#closeRecord(record); this.#artifacts.delete(record.ref); committed = record.directory;
        result = { ok: true, directory: committed, message: `Exported the coding review to ${committed}. It includes all captured files, including unchanged files.` };
      } catch (error) {
        if (record) { record.state = "failed"; try { await this.#remove(record); } catch { /* Retained exact cleanup ownership. */ } }
        const safe = this.#safe(error, "destination");
        result = { ok: false, message: safe.message, ...(record && this.#artifacts.has(record.ref) ? { directory: record.directory } : {}) };
      } finally {
        let failed = false;
        for (const pin of [sourcePin, parent]) if (pin) { try { this.#closePin(pin); } catch { failed = true; } }
        if (failed) result = { ok: false, message: CODING_ARTIFACT_MESSAGES.cleanup, ...(committed ? { directory: committed } : record ? { directory: record.directory } : {}) };
      }
      if (this.#terminal) throw this.#terminal; return result!;
    });
  }
  async #remove(record: Artifact): Promise<void> {
    if (this.#terminal) throw this.#terminal;
    this.#rootCurrent(record);
    const listed = this.#api.list(record.root.handle, 3);
    const expected = Object.entries(record.files).filter(([, file]) => !file.removed).map(([name]) => name).sort();
    if (listed.map(entry => entry.name).sort().join("\0") !== expected.join("\0")) throw new CodingResultRegistryError("cleanup");
    for (const entry of listed) {
      const file = Object.hasOwn(record.files, entry.name) ? record.files[entry.name as CodingArtifactName] : undefined;
      if (!file?.info || file.uncertain || entry.id !== file.info.id) throw new CodingResultRegistryError("cleanup");
      if (file.transferPending) await this.#settleTransfer(record, entry.name as CodingArtifactName, () => undefined, true);
      if (file.closed) throw new CodingResultRegistryError("cleanup");
      if (!windowsCodingSame(file.info, this.#api.info(file.handle))) throw new CodingResultRegistryError("cleanup");
      this.#api.assertPrivate(file.handle);
    }
    // Transfer recovery can yield. Audit every name and final full receipt again before the first disposition.
    this.#rootCurrent(record); const final = this.#api.list(record.root.handle, 3);
    if (final.map(entry => entry.name).sort().join("\0") !== expected.join("\0")) throw new CodingResultRegistryError("cleanup");
    for (const entry of final) {
      const file = record.files[entry.name as CodingArtifactName]!;
      if (!file?.info || file.closed || file.uncertain || file.transferPending || entry.id !== file.info.id || !windowsCodingSame(file.info, this.#api.info(file.handle))) throw new CodingResultRegistryError("cleanup");
      this.#api.assertPrivate(file.handle);
    }
    for (const entry of final) { const file = record.files[entry.name as CodingArtifactName]!; this.#removeHandle(file.handle); file.removed = true; this.#close(file); }
    this.#removeHandle(record.root.handle); this.#close(record.root);
    if (record.ownParent) this.#closePin(record.parent);
    this.#artifacts.delete(record.ref);
    this.#removed.set(record.ref, record.directory);
  }
  #removeHandle(handle: WindowsCodingHandle): void {
    try { this.#api.remove(handle); }
    catch (error) {
      const cause = (error as { cause?: { status?: unknown } } | null)?.cause, status = cause?.status;
      if (!(error instanceof ScopedCodingFileError) || error.code === "io" && (typeof status !== "number" || !Number.isInteger(status) || status < 0 || status > 0xffffffff)) throw this.#poison();
      throw new CodingResultRegistryError("cleanup");
    }
  }
  #closePin(pin: WindowsCodingPin): void {
    const handles = this.#pins.get(pin); if (!handles) throw this.#poison();
    let failed = false; for (const handle of handles.slice().reverse()) { try { this.#close(handle); } catch { failed = true; } }
    if (failed) { this.#failedPins.add(pin); throw this.#poison(); }
  }
  #closeRecord(record: Artifact): void {
    let failed = false;
    for (const file of Object.values(record.files)) { try { this.#close(file); } catch { failed = true; } }
    try { this.#close(record.root); } catch { failed = true; }
    if (record.ownParent) { try { this.#closePin(record.parent); } catch { failed = true; } }
    if (failed) throw this.#poison();
  }
  discard(input: CodingArtifactInput): Promise<void> {
    let captured: CodingArtifactInput;
    try { captured = this.#input(input); this.#admit(() => undefined); } catch (error) { return Promise.reject(this.#safe(error)); }
    return this.#queue(async () => {
      try {
        this.#admit(() => undefined);
        // A registry may already have removed a claimed token after rejecting publication. Acknowledge only that
        // exact verified-removed capability; do not look up or delete a new object at its former directory path.
        if (captured.artifact && this.#removed.get(captured.artifact) === captured.directory) return;
        const record = this.#lookup(captured); record.state = "failed"; await this.#remove(record);
      } catch (error) { throw this.#safe(error, "cleanup"); }
    });
  }
  cleanup(retained: ReadonlySet<CodingArtifactRef>): Promise<void> {
    return this.#queue(async () => {
      let failed = false;
      for (const record of this.#artifacts.values()) if (record.state !== "producer" && !retained.has(record.ref)) { try { await this.#remove(record); } catch (error) { this.#safe(error, "cleanup"); failed = true; } }
      if (this.#terminal) throw this.#terminal; if (failed) throw new CodingResultRegistryError("cleanup");
    });
  }
  close(): Promise<void> {
    if (!this.#closing) {
      this.#closed = true;
      this.#closing = this.#queue(async () => {
        let failed = false;
        for (const record of [...this.#artifacts.values()]) {
          try { await this.#remove(record); } catch (error) { this.#safe(error, "cleanup"); failed = true; try { this.#closeRecord(record); } catch { /* Preserve terminal cause while draining other handles. */ } }
        }
        for (const root of this.#protected.slice().reverse()) {
          if (root.file) { try { this.#close(root.file); } catch { failed = true; } }
          try { this.#closePin(root.pin); } catch { failed = true; }
        }
        try { this.#closePin(this.#base); } catch { failed = true; }
        if (this.#terminal) throw this.#terminal; if (failed) throw new CodingResultRegistryError("cleanup");
      });
    }
    return this.#closing;
  }
}
