/**
 * Disabled Windows file-only foundation. Source handles are read-only; every destination object is fresh/private.
 * This is neither a command workspace nor a production adapter. The caller must still prove real command writers
 * stopped before granting a workspace.files lease. Unrelated same-user/admin host processes are outside the boundary.
 */
import path from "node:path/win32";
import { randomUUID, createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import { ScopedCodingFileError, type ScopedCodingWorkspace, type ScopedCodingFileLimits } from "./coding-platform";
import { CodingPrivacyScanner, CodingPrivacyCleanupError, captureCodingPrivacyScope, assertCodingPrivacyScope, type CodingPrivacyScope } from "./coding-privacy-scanner";
import { codingWorkspaceFilePathProblem, codingWorkspaceFileProblemAsync } from "./scoped-coding-files";
import { loadWindowsCodingNative, retireWindowsCodingNative, WindowsCodingCleanupError, type WindowsCodingNative, type WindowsCodingHandle, type WindowsCodingInfo, type WindowsCodingPin } from "./windows-coding-native";
import { windowsCodingLimits, windowsCodingRelative, windowsCodingFold, windowsCodingSame, windowsCodingWithin, windowsCodingSafeError, windowsCodingYield } from "./windows-coding-policy";
import { WindowsCodingArtifactStore } from "./windows-coding-artifact-store";
import { CodingArtifactCleanupError, type CodingArtifactSourceRef } from "./coding-artifact-store";
import { createCodingReviewExport, type CodingExportBinding, type CodingExportEntry, type CodingExportTree } from "./coding-result-export";
import { codingProjectManifest, type CodingExcludedRoot, type CodingProjectManifest, type CodingScopeOmission } from "./coding-project-scope";
import { clearWindowsCodingTree, ownWindowsCodingReview, type WindowsCodingReviewProducer } from "./windows-coding-review";

export interface WindowsCodingCopyReviewInput {
  binding: CodingExportBinding;
  store: WindowsCodingArtifactStore;
  /** Account/project publication authority, independent of task Stop; false is latched permanently. */
  current(): boolean;
  /** Trusted host attestation after awaited controller/file-broker teardown, never a native process-stop proof. */
  controllerClosed(): boolean;
}

export interface WindowsCodingCopyInput {
  source: string; privateBase: string; protectedPaths: readonly string[];
  signal: AbortSignal; current(): boolean; limits?: Partial<ScopedCodingFileLimits>;
  /** Omissions are explicit host scope; no dependencies or commands are made available. */
  scope?: { excludeRoots: readonly CodingExcludedRoot[] };
  review?: WindowsCodingCopyReviewInput;
}
export interface WindowsCodingTreeEntry { path: string; handle: WindowsCodingHandle; info: WindowsCodingInfo }
export interface WindowsCodingTree {
  api: WindowsCodingNative; root: WindowsCodingHandle; entries: ReadonlyMap<string, WindowsCodingTreeEntry>; limits: Readonly<ScopedCodingFileLimits>;
  check(): void;
  release(handle: WindowsCodingHandle): void;
}
interface CapturedSource { handle: WindowsCodingHandle; info?: WindowsCodingInfo }
interface FileLease { epoch: number; active: boolean }
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const cleanupFailure = (error: unknown): boolean => error instanceof CodingPrivacyCleanupError || error instanceof WindowsCodingCleanupError || error instanceof CodingArtifactCleanupError;
const REVIEW_LIMITS = Object.freeze({ entries: 10_000, depth: 64, fileBytes: 4 * 1024 * 1024, workspaceBytes: 10 * 1024 * 1024 });

/** Read the entire bounded object under one non-shared-write native handle before scanning or returning a range. */
export async function readWindowsCodingFile(api: WindowsCodingNative, handle: WindowsCodingHandle, expected: WindowsCodingInfo, maximum: number, check: () => void): Promise<Buffer> {
  check(); const before = api.info(handle);
  if (!windowsCodingSame(expected, before) || before.kind !== "file" || before.links !== 1) throw new ScopedCodingFileError("conflict");
  if (before.size < 0 || before.size > maximum) throw new ScopedCodingFileError("limit");
  const bytes = Buffer.alloc(before.size);
  try {
    for (let offset = 0; offset < bytes.length;) {
      check(); const chunk = api.read(handle, offset, Math.min(64 * 1024, bytes.length - offset));
      try {
        if (!chunk.length || chunk.length > bytes.length - offset) throw new ScopedCodingFileError("conflict");
        chunk.copy(bytes, offset); offset += chunk.length;
      } finally { chunk.fill(0); }
      await windowsCodingYield(); check();
    }
    const eof = api.read(handle, bytes.length, 1);
    try { if (eof.length || !windowsCodingSame(before, api.info(handle))) throw new ScopedCodingFileError("conflict"); }
    finally { eof.fill(0); }
    check(); return bytes;
  } catch (error) { bytes.fill(0); throw error; }
}

export class WindowsCodingCopy implements ScopedCodingWorkspace {
  readonly executionRoot = "/work";
  readonly directory: string;
  readonly limits: Readonly<ScopedCodingFileLimits>;
  readonly signal: AbortSignal;
  readonly excludedRoots: readonly CodingExcludedRoot[];
  #api: WindowsCodingNative; #root: WindowsCodingHandle; #identity: WindowsCodingInfo; #base: WindowsCodingPin;
  #input: WindowsCodingCopyInput; #lifetime = new AbortController(); #lease = new AsyncLocalStorage<FileLease>();
  #tail: Promise<void> = Promise.resolve(); #retired = false; #closed = false; #epoch = 0;
  #stopping: Promise<void> | null = null; #closing: Promise<void> | null = null; #failure: unknown;
  #abort: () => void; #privacyScope: CodingPrivacyScope;
  #review?: WindowsCodingCopyReviewInput; #source: WindowsCodingInfo; #protected: WindowsCodingInfo[];
  #sourceBoundary: CodingArtifactSourceRef | null = null; #baseline?: CodingExportTree; #manifest?: CodingProjectManifest;
  #reviewRevoked = false; #reviewStarted = false; #reviewClosing = false;
  #producer?: WindowsCodingReviewProducer;

  private constructor(input: WindowsCodingCopyInput, api: WindowsCodingNative, base: WindowsCodingPin, root: WindowsCodingHandle, limits: Readonly<ScopedCodingFileLimits>, privacyScope: CodingPrivacyScope,
    source: WindowsCodingInfo, protectedInfo: WindowsCodingInfo[]) {
    this.#privacyScope = privacyScope; this.#input = { ...input, protectedPaths: [...input.protectedPaths] }; this.#api = api; this.#base = base; this.#root = root;
    this.#identity = api.info(root); this.directory = this.#identity.finalPath; this.limits = limits;
    this.#source = { ...source }; this.#protected = protectedInfo.map(info => ({ ...info })); this.#review = input.review;
    this.excludedRoots = Object.freeze([...(input.scope?.excludeRoots ?? [])]);
    this.signal = AbortSignal.any([input.signal, this.#lifetime.signal]);
    this.#abort = () => { void this.stop().catch(() => undefined); };
    input.signal.addEventListener("abort", this.#abort, { once: true });
  }
  static async create(input: WindowsCodingCopyInput): Promise<WindowsCodingCopy> {
    if (HOST_PLATFORM !== "win32" || HOST_ARCH !== "x64" || !input || !(input.signal instanceof AbortSignal) || typeof input.current !== "function" ||
        !Array.isArray(input.protectedPaths) || !input.protectedPaths.length || input.protectedPaths.length > 64) throw new ScopedCodingFileError("unavailable");
    const exclusions = [...(input.scope?.excludeRoots ?? [])];
    if (exclusions.length > 2 || new Set(exclusions).size !== exclusions.length || exclusions.some(name => name !== ".git" && name !== "node_modules")) throw new ScopedCodingFileError("path");
    const selectedReview = input.review;
    if (selectedReview && (!(selectedReview.store instanceof WindowsCodingArtifactStore) || typeof selectedReview.current !== "function" || typeof selectedReview.controllerClosed !== "function")) throw new ScopedCodingFileError("unavailable");
    const review = selectedReview ? { ...selectedReview, binding: { ...selectedReview.binding }, current: selectedReview.current.bind(selectedReview), controllerClosed: selectedReview.controllerClosed.bind(selectedReview) } : undefined;
    if (review) createCodingReviewExport({ binding: review.binding, baseline: { binding: review.binding, entries: [] }, proposed: { binding: review.binding, entries: [] } });
    input = { ...input, protectedPaths: [...input.protectedPaths], current: input.current.bind(input), scope: { excludeRoots: exclusions }, review };
    const privacyScope = captureCodingPrivacyScope(), limits = windowsCodingLimits({ ...(review ? REVIEW_LIMITS : {}), ...input.limits });
    if (review && Object.entries(REVIEW_LIMITS).some(([key, value]) => limits[key as keyof ScopedCodingFileLimits] > value)) throw new ScopedCodingFileError("limit");
    const check = () => { try { assertCodingPrivacyScope(privacyScope); if (input.signal.aborted || input.current() !== true) throw new ScopedCodingFileError("cancelled"); } catch (error) { throw windowsCodingSafeError(error); } };
    const reviewCurrent = () => {
      check();
      try { if (review && review.current() !== true) throw new ScopedCodingFileError("cancelled"); }
      catch { throw new ScopedCodingFileError("cancelled"); }
      check();
    };
    reviewCurrent();
    // Capture provenance before the copy opens. A later path cannot mint authority for a renamed original.
    const sourceBoundary = review ? await review.store.sourceBoundary(input.source, reviewCurrent) : null;
    if (review && !sourceBoundary) throw new ScopedCodingFileError("boundary");
    reviewCurrent(); const api = loadWindowsCodingNative(), pins: WindowsCodingPin[] = [], protectedFiles: WindowsCodingHandle[] = [];
    let base: WindowsCodingPin | undefined, copy: WindowsCodingCopy | undefined, root: WindowsCodingHandle | undefined, problem: unknown, failed = false;
    try {
      const source = api.pin(input.source, "read"); pins.push(source);
      if (review) {
        const fresh = await review.store.sourceBoundary(input.source, reviewCurrent);
        if (!await review.store.sameSource(sourceBoundary, fresh, reviewCurrent)) throw new ScopedCodingFileError("boundary");
      }
      base = api.pin(input.privateBase, "base");
      const sourceInfo = api.info(source.handle), baseInfo = api.info(base.handle), protectedInfo: WindowsCodingInfo[] = [];
      for (const location of input.protectedPaths) {
        check();
        try { const pin = api.pin(location, "read"); pins.push(pin); protectedInfo.push(api.info(pin.handle)); }
        catch (error) {
          if (!(error instanceof ScopedCodingFileError) || error.code === "io") throw error;
          const parent = api.pin(path.dirname(location), "read"); pins.push(parent);
          const file = api.open(parent.handle, path.basename(location), "file", "source"); protectedFiles.push(file); protectedInfo.push(api.info(file));
        }
      }
      if (windowsCodingWithin(baseInfo.finalPath, sourceInfo.finalPath) || windowsCodingWithin(sourceInfo.finalPath, baseInfo.finalPath) || protectedInfo.some(info =>
        windowsCodingWithin(sourceInfo.finalPath, info.finalPath) || windowsCodingWithin(info.finalPath, sourceInfo.finalPath))) throw new ScopedCodingFileError("boundary");
      check(); root = api.create(base.handle, `ember-windows-copy-${randomUUID()}`, "directory"); api.assertPrivate(root);
      copy = new WindowsCodingCopy(input, api, base, root, limits, privacyScope, sourceInfo, protectedInfo); base = undefined; root = undefined;
      copy.#sourceBoundary = sourceBoundary;
      const pending = copy.#capture(source.handle, sourceInfo, protectedInfo, { destination: copy.#root, retain: !!review, check: reviewCurrent, signal: copy.signal }).then(captured => {
        if (review) {
          copy!.#baseline = { binding: review.binding, entries: captured.entries };
          copy!.#manifest = codingProjectManifest({ version: 1, source: { excludedRoots: exclusions, omitted: captured.omitted, byteLimit: limits.workspaceBytes }, dependencies: null });
          createCodingReviewExport({ binding: review.binding, baseline: copy!.#baseline, proposed: copy!.#baseline, current: copy!.#baseline, scope: copy!.#manifest });
        }
      });
      copy.#tail = pending.then(() => undefined, error => { copy!.#failure = error; });
      await pending; reviewCurrent(); copy.#checkRoot();
    } catch (error) { failed = true; problem = error; }
    const cleanupErrors: unknown[] = [];
    for (const handle of protectedFiles.reverse()) { try { api.close(handle); } catch (error) { cleanupErrors.push(error); } }
    for (const pin of pins.reverse()) for (const handle of pin.handles.slice().reverse()) { try { api.close(handle); } catch (error) { cleanupErrors.push(error); } }
    if (failed || cleanupErrors.length) {
      if (copy) { try { await copy.close(); } catch (error) { cleanupErrors.push(error); } }
      else if (root !== undefined) {
        try { api.remove(root); } catch (error) { cleanupErrors.push(error); }
        try { api.close(root); } catch (error) { cleanupErrors.push(error); }
      }
      if (base) for (const handle of base.handles.slice().reverse()) { try { api.close(handle); } catch (error) { cleanupErrors.push(error); } }
      if (cleanupErrors.length) throw retireWindowsCodingNative();
      throw windowsCodingSafeError(problem);
    }
    return copy!;
  }
  admitted(): boolean {
    if (this.#closed || this.#retired || this.#failure !== undefined || this.signal.aborted) return false;
    try { assertCodingPrivacyScope(this.#privacyScope); if (this.#input.current() === true) return true; } catch (error) { if (error instanceof CodingPrivacyCleanupError || error instanceof WindowsCodingCleanupError) this.#failure = error; }
    this.#retire(); return false;
  }
  #check = (): void => { if (!this.admitted()) { if (this.#failure !== undefined) throw windowsCodingSafeError(this.#failure); throw new ScopedCodingFileError("cancelled"); } };
  assertCurrent(): void { this.#check(); }
  #retire(): void { if (!this.#retired) { this.#retired = true; this.#epoch++; this.#lifetime.abort(); } }
  #checkRoot(): void {
    this.#check(); this.#api.assertPrivate(this.#root);
    if (!windowsCodingSame(this.#identity, this.#api.info(this.#root), false)) throw new ScopedCodingFileError("boundary");
  }
  createPrivacyScanner(signal: AbortSignal): CodingPrivacyScanner { return new CodingPrivacyScanner({ signal, scope: this.#privacyScope }); }
  async #capture(source: WindowsCodingHandle, sourceInfo: WindowsCodingInfo, protectedInfo: WindowsCodingInfo[], options: {
    destination: WindowsCodingHandle | null; retain: boolean; check(): void; signal?: AbortSignal;
  }): Promise<{ entries: CodingExportEntry[]; omitted: CodingScopeOmission[] }> {
    const api = this.#api, opened: CapturedSource[] = [], aliases = new Set<string>(), ids = new Set<string>();
    const scanner = new CodingPrivacyScanner({ signal: options.signal, scope: this.#privacyScope });
    const entries: CodingExportEntry[] = [], omitted: CodingScopeOmission[] = []; let count = 0, bytes = 0, problem: unknown, failed = false;
    const checkInfo = (info: WindowsCodingInfo) => {
      options.check(); if (info.volume !== sourceInfo.volume || !windowsCodingWithin(info.finalPath, sourceInfo.finalPath) || protectedInfo.some(p =>
        (p.volume === info.volume && p.id === info.id) || windowsCodingWithin(info.finalPath, p.finalPath))) throw new ScopedCodingFileError("boundary");
    };
    const walk = async (src: WindowsCodingHandle, dest: WindowsCodingHandle | null, prefix: string, depth: number): Promise<void> => {
      options.check(); if (depth > this.limits.depth) throw new ScopedCodingFileError("limit");
      const before = api.info(src); checkInfo(before);
      for (const listed of api.list(src, this.limits.entries - count)) {
        options.check(); if (++count > this.limits.entries) throw new ScopedCodingFileError("limit");
        if (!prefix && this.excludedRoots.includes(listed.name as CodingExcludedRoot)) {
          omitted.push({ path: listed.name as CodingExcludedRoot, kind: listed.attributes & 0x400 ? "link" : listed.attributes & 0x10 ? "directory" : "file" }); continue;
        }
        const relative = prefix ? `${prefix}/${listed.name}` : listed.name;
        try { windowsCodingRelative(relative, false); } catch { throw new ScopedCodingFileError("unsupported"); }
        if (relative.split("/").length > this.limits.depth) throw new ScopedCodingFileError("limit");
        const key = windowsCodingFold(relative); if (aliases.has(key)) throw new ScopedCodingFileError("unsupported"); aliases.add(key);
        if (codingWorkspaceFilePathProblem(relative)) throw new ScopedCodingFileError("secret");
        const kind = listed.attributes & 0x10 ? "directory" : "file", file = api.open(src, listed.name, kind, "source");
        const captured: CapturedSource = { handle: file }; opened.push(captured);
        const info = api.info(file); captured.info = info; checkInfo(info);
        if (listed.id !== info.id || info.kind !== kind || ids.has(`${info.volume}:${info.id}`)) throw new ScopedCodingFileError("conflict");
        // Fresh copies deliberately do not inherit source attributes. Never erase an existing privacy marker.
        if (info.attributes & 0x6) throw new ScopedCodingFileError("privacy");
        ids.add(`${info.volume}:${info.id}`);
        if (kind === "directory") {
          if (options.retain) entries.push({ path: relative, kind: "directory" });
          const target = dest === null ? null : api.create(dest, listed.name, "directory");
          try { if (target !== null) api.assertPrivate(target); await walk(file, target, relative, depth + 1); }
          finally { if (target !== null) api.close(target); }
        } else {
          if ((bytes += info.size) > this.limits.workspaceBytes) throw new ScopedCodingFileError("limit");
          const body = await readWindowsCodingFile(api, file, info, this.limits.fileBytes, options.check);
          let retained = false;
          try {
            const why = await codingWorkspaceFileProblemAsync(relative, body, scanner, { signal: options.signal, current: () => { options.check(); return true; } }); options.check();
            if (why) throw new ScopedCodingFileError("secret");
            if (dest !== null) {
              const target = api.create(dest, listed.name, "file");
              try { api.assertPrivate(target); api.write(target, body); api.flush(target);
                const fresh = api.info(target); if (fresh.id === info.id && fresh.volume === info.volume || fresh.links !== 1 || fresh.size !== body.length) throw new ScopedCodingFileError("boundary");
                const verified = await readWindowsCodingFile(api, target, fresh, this.limits.fileBytes, options.check);
                try { if (hash(verified) !== hash(body)) throw new ScopedCodingFileError("conflict"); } finally { verified.fill(0); }
              } finally { api.close(target); }
            }
            if (options.retain) { entries.push({ path: relative, kind: "file", bytes: body, executable: false }); retained = true; }
          } finally { if (!retained) body.fill(0); }
        }
        await windowsCodingYield(); options.check();
      }
      if (!windowsCodingSame(before, api.info(src))) throw new ScopedCodingFileError("conflict");
    };
    try {
      await walk(source, options.destination, "", 0); options.check();
      for (const entry of opened) if (!entry.info || !windowsCodingSame(entry.info, api.info(entry.handle))) throw new ScopedCodingFileError("conflict");
      if (!windowsCodingSame(sourceInfo, api.info(source))) throw new ScopedCodingFileError("conflict");
    } catch (error) { failed = true; problem = error; }
    const errors: unknown[] = [];
    for (const entry of opened.reverse()) { try { api.close(entry.handle); } catch (error) { errors.push(error); } }
    try { await scanner.close(); } catch (error) { errors.push(error); }
    if (failed || errors.length) {
      clearWindowsCodingTree({ entries });
      throw errors.find(cleanupFailure) ?? problem ?? errors[0];
    }
    try { options.check(); } catch (error) {
      clearWindowsCodingTree({ entries }); throw error;
    }
    return { entries, omitted };
  }
  files<T>(operation: (root: string) => Promise<T>): Promise<T> {
    if (this.#lease.getStore() !== undefined) return Promise.reject(new ScopedCodingFileError("boundary"));
    const pending = this.#tail.then(async () => {
      this.#checkRoot(); const lease: FileLease = { epoch: this.#epoch, active: true };
      return this.#lease.run(lease, async () => {
        try { const result = await operation(this.directory); this.#checkRoot(); if (lease.epoch !== this.#epoch) throw new ScopedCodingFileError("cancelled"); return result; }
        finally { lease.active = false; }
      });
    });
    this.#tail = pending.then(() => undefined, () => undefined); return pending.catch(error => {
      if (cleanupFailure(error)) { this.#failure = error; this.#retire(); }
      throw windowsCodingSafeError(error);
    });
  }
  /** Host broker capability only. The returned handles never enter tool results and expire at lease completion. */
  async withTree<T>(operation: (tree: WindowsCodingTree) => Promise<T>): Promise<T> {
    const lease = this.#lease.getStore();
    if (lease === undefined) return this.files(() => this.withTree(operation));
    if (!lease.active || lease.epoch !== this.#epoch) throw new ScopedCodingFileError("cancelled");
    this.#checkRoot(); return this.#tree(operation, true);
  }
  async #tree<T>(operation: (tree: WindowsCodingTree) => Promise<T>, current: boolean, sealedCheck?: () => void): Promise<T> {
    const api = this.#api, entries = new Map<string, WindowsCodingTreeEntry>(), aliases = new Set<string>(), ids = new Set<string>(), opened = new Set<WindowsCodingHandle>();
    let total = 0;
    const check = () => { if (current) this.#checkRoot(); else sealedCheck?.(); };
    const release = (handle: WindowsCodingHandle) => { if (!opened.delete(handle)) throw new ScopedCodingFileError("boundary"); api.close(handle); };
    if (!windowsCodingSame(this.#identity, api.info(this.#root), false)) throw new ScopedCodingFileError("boundary");
    const walk = async (directory: WindowsCodingHandle, prefix: string, depth: number): Promise<void> => {
      check(); if (depth > this.limits.depth) throw new ScopedCodingFileError("limit");
      const before = api.info(directory); api.assertPrivate(directory);
      for (const listed of api.list(directory, this.limits.entries - entries.size)) {
        check(); if (entries.size >= this.limits.entries) throw new ScopedCodingFileError("limit");
        const relative = prefix ? `${prefix}/${listed.name}` : listed.name;
        try { windowsCodingRelative(relative, false); } catch { throw new ScopedCodingFileError("unsupported"); }
        if (relative.split("/").length > this.limits.depth) throw new ScopedCodingFileError("limit");
        if (aliases.has(windowsCodingFold(relative))) throw new ScopedCodingFileError("unsupported"); aliases.add(windowsCodingFold(relative));
        const kind = listed.attributes & 0x10 ? "directory" : "file", handle = api.open(directory, listed.name, kind, "copy"); opened.add(handle);
        const info = api.info(handle); api.assertPrivate(handle);
        if (listed.id !== info.id || info.kind !== kind || info.volume !== this.#identity.volume || !windowsCodingWithin(info.finalPath, this.#identity.finalPath) || ids.has(info.id) ||
            kind === "file" && info.links !== 1) throw new ScopedCodingFileError("unsupported");
        ids.add(info.id); if (kind === "file" && (info.size > this.limits.fileBytes || (total += info.size) > this.limits.workspaceBytes)) throw new ScopedCodingFileError("limit");
        entries.set(relative, { path: relative, handle, info }); if (kind === "directory") await walk(handle, relative, depth + 1);
        if (entries.size % 16 === 0) { await windowsCodingYield(); check(); }
      }
      if (!windowsCodingSame(before, api.info(directory))) throw new ScopedCodingFileError("conflict");
    };
    let result: T | undefined, problem: unknown, failed = false;
    try { await walk(this.#root, "", 0); check(); result = await operation({ api, root: this.#root, entries, limits: this.limits, check, release }); check(); }
    catch (error) { failed = true; problem = error; }
    const errors: unknown[] = [];
    for (const handle of [...opened].reverse()) { try { api.close(handle); } catch (error) { errors.push(error); } }
    const fatal = errors.find(cleanupFailure) ?? (cleanupFailure(problem) ? problem : undefined);
    if (errors.length || fatal) { this.#failure = fatal ?? errors[0]; this.#retire(); }
    if (failed || errors.length) throw windowsCodingSafeError(fatal ?? problem ?? errors[0]); return result!;
  }
  #reviewCheck = (): void => {
    assertCodingPrivacyScope(this.#privacyScope);
    if (this.#failure !== undefined) throw windowsCodingSafeError(this.#failure);
    if (!this.#review || this.#reviewRevoked || this.#reviewClosing || this.#closed) throw new ScopedCodingFileError("cancelled");
    try { if (this.#review.current() !== true) { this.#reviewRevoked = true; throw new ScopedCodingFileError("cancelled"); } }
    catch (error) { this.#reviewRevoked = true; throw windowsCodingSafeError(error); }
    try { if (this.#review.controllerClosed() !== true) throw new ScopedCodingFileError("boundary"); }
    catch { throw new ScopedCodingFileError("boundary"); }
    // Trusted host callbacks can synchronously retire the owner or privacy generation too.
    assertCodingPrivacyScope(this.#privacyScope);
    if (this.#failure !== undefined) throw windowsCodingSafeError(this.#failure);
    if (this.#reviewRevoked || this.#reviewClosing || this.#closed) throw new ScopedCodingFileError("cancelled");
    this.#api.assertPrivate(this.#root);
    if (!windowsCodingSame(this.#identity, this.#api.info(this.#root), false)) throw new ScopedCodingFileError("boundary");
  };
  async #proposed(): Promise<CodingExportTree> {
    const entries: CodingExportEntry[] = [], scanner = new CodingPrivacyScanner({ scope: this.#privacyScope });
    const binding = this.#review!.binding;
    try {
      await this.#tree(async tree => {
        for (const entry of tree.entries.values()) {
          this.#reviewCheck();
          if (entry.info.attributes & 0x6) throw new ScopedCodingFileError("privacy");
          if (this.excludedRoots.some(root => entry.path === root || entry.path.startsWith(root + "/"))) throw new ScopedCodingFileError("boundary");
          if (entry.info.kind === "directory") {
            if (codingWorkspaceFilePathProblem(entry.path)) throw new ScopedCodingFileError("secret");
            entries.push({ path: entry.path, kind: "directory" });
          } else {
            const bytes = await readWindowsCodingFile(tree.api, entry.handle, entry.info, this.limits.fileBytes, this.#reviewCheck);
            let retained = false;
            try {
              if (await codingWorkspaceFileProblemAsync(entry.path, bytes, scanner, { current: () => { this.#reviewCheck(); return true; } })) throw new ScopedCodingFileError("secret");
              this.#reviewCheck(); entries.push({ path: entry.path, kind: "file", bytes, executable: false }); retained = true;
            } finally { if (!retained) bytes.fill(0); }
          }
        }
      }, false, this.#reviewCheck);
      await scanner.close(); this.#reviewCheck();
      return { binding, entries };
    } catch (error) {
      clearWindowsCodingTree({ entries });
      await scanner.close();
      throw error;
    }
  }
  async #currentSource(): Promise<CodingExportTree | undefined> {
    const pins: WindowsCodingPin[] = []; let tree: CodingExportTree | undefined, problem: unknown, closeFailed = false;
    try {
      this.#reviewCheck();
      const fresh = await this.#review!.store.sourceBoundary(this.#input.source, this.#reviewCheck);
      if (await this.#review!.store.sameSource(this.#sourceBoundary, fresh, this.#reviewCheck)) {
        this.#reviewCheck(); const pin = this.#api.pin(this.#input.source, "read"); pins.push(pin);
        const info = this.#api.info(pin.handle);
        // The retained original identity pin prevents a successful comparison from racing a namespace rebound.
        if (windowsCodingSame(this.#source, info, false) && await this.#review!.store.sameSource(this.#sourceBoundary, fresh, this.#reviewCheck)) {
          this.#reviewCheck();
          const captured = await this.#capture(pin.handle, info, this.#protected, { destination: null, retain: true, check: this.#reviewCheck });
          tree = { binding: this.#review!.binding, entries: captured.entries };
          this.#reviewCheck();
          if (!windowsCodingSame(info, this.#api.info(pin.handle))) throw new ScopedCodingFileError("conflict");
        }
      }
    } catch (error) { problem = error; }
    finally {
      for (const pin of pins.reverse()) for (const handle of pin.handles.slice().reverse()) { try { this.#api.close(handle); } catch { closeFailed = true; } }
    }
    if (closeFailed) { clearWindowsCodingTree(tree); throw retireWindowsCodingNative(); }
    if (problem) {
      clearWindowsCodingTree(tree);
      if (cleanupFailure(problem)) throw problem;
      // Ordinary source disappearance, unsupported content or replacement gives an explicit unknown current tree.
      this.#reviewCheck(); return undefined;
    }
    return tree;
  }
  /** File-only sealed capture. Stop retires ordinary leases permanently; only this host path can read afterwards. */
  exportReview(store = this.#review?.store): Promise<WindowsCodingReviewProducer> {
    this.#retire();
    if (!this.#review) return Promise.reject(new ScopedCodingFileError("unavailable"));
    if (this.#reviewRevoked || this.#reviewClosing) return Promise.reject(new ScopedCodingFileError("cancelled"));
    if (this.#lease.getStore() !== undefined || store !== this.#review.store || this.#reviewStarted) return Promise.reject(new ScopedCodingFileError("boundary"));
    this.#reviewStarted = true;
    const pending = this.#tail.then(async () => {
      let proposed: CodingExportTree | undefined, current: CodingExportTree | undefined;
      let json: Buffer | undefined, patch: Buffer | undefined;
      try {
        this.#reviewCheck();
        if (!this.#baseline || !this.#sourceBoundary) throw new ScopedCodingFileError("boundary");
        proposed = await this.#proposed(); this.#reviewCheck();
        current = await this.#currentSource(); this.#reviewCheck();
        const rendered = createCodingReviewExport({ binding: this.#review!.binding, baseline: this.#baseline, proposed,
          ...(current ? { current } : {}), scope: this.#manifest });
        json = Buffer.from(rendered.json); patch = Buffer.from(rendered.review.textPatch); this.#reviewCheck();
        const artifact = await store.write({ "review.json": json, "changes.patch": patch }, this.#reviewCheck);
        // No await or fallible validation separates the store result from our exact producer ownership ledger.
        // The working copy still belongs to close(); only its awaited removal can certify complete cleanup.
        this.#producer = ownWindowsCodingReview(store, { ...artifact, review: rendered.review, cleanup: "retained" }, this.#sourceBoundary, this.#reviewCheck);
        this.#reviewCheck(); return this.#producer;
      } catch (error) {
        let failure = error;
        if (cleanupFailure(error)) { this.#failure = error; this.#retire(); }
        if (this.#producer?.owned) {
          try { await this.#producer.discard(); } catch (cleanup) { this.#failure = cleanup; throw cleanup; }
        }
        if (!cleanupFailure(error)) {
          // Store errors sanitize callbacks. Preserve the host-observed revocation without disguising cleanup uncertainty.
          try { this.#reviewCheck(); } catch (currentError) { failure = currentError; }
        }
        throw windowsCodingSafeError(failure);
      } finally {
        json?.fill(0); patch?.fill(0); clearWindowsCodingTree(this.#baseline); this.#baseline = undefined;
        clearWindowsCodingTree(proposed); clearWindowsCodingTree(current);
      }
    });
    this.#tail = pending.then(() => undefined, () => undefined); return pending;
  }
  stop(): Promise<void> {
    this.#retire(); if (this.#lease.getStore() !== undefined) return Promise.reject(new ScopedCodingFileError("boundary"));
    this.#stopping ??= this.#tail.then(() => { if (this.#failure) throw windowsCodingSafeError(this.#failure); }); return this.#stopping;
  }
  close(): Promise<void> {
    this.#reviewClosing = true;
    this.#retire(); if (this.#lease.getStore() !== undefined) return Promise.reject(new ScopedCodingFileError("boundary"));
    this.#closing ??= this.#tail.then(async () => {
      if (this.#closed) return;
      clearWindowsCodingTree(this.#baseline); this.#baseline = undefined;
      if (this.#producer?.owned) await this.#producer.discard();
      await this.#tree(async tree => {
        for (const entry of [...tree.entries.values()].sort((a, b) => b.path.split("/").length - a.path.split("/").length)) { tree.api.remove(entry.handle); tree.release(entry.handle); }
      }, false);
      this.#api.remove(this.#root); this.#api.close(this.#root);
      const errors: unknown[] = [];
      for (const handle of this.#base.handles.slice().reverse()) { try { this.#api.close(handle); } catch (error) { errors.push(error); } }
      this.#closed = true; this.#input.signal.removeEventListener("abort", this.#abort);
      if (errors.length) throw windowsCodingSafeError(errors[0]);
    }).catch(error => {
      this.#failure = cleanupFailure(error) ? error : retireWindowsCodingNative();
      throw windowsCodingSafeError(this.#failure);
    }); return this.#closing;
  }
}
