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

export interface WindowsCodingCopyInput {
  source: string; privateBase: string; protectedPaths: readonly string[];
  signal: AbortSignal; current(): boolean; limits?: Partial<ScopedCodingFileLimits>;
}
export interface WindowsCodingTreeEntry { path: string; handle: WindowsCodingHandle; info: WindowsCodingInfo }
export interface WindowsCodingTree {
  api: WindowsCodingNative; root: WindowsCodingHandle; entries: ReadonlyMap<string, WindowsCodingTreeEntry>; limits: Readonly<ScopedCodingFileLimits>;
  check(): void;
  release(handle: WindowsCodingHandle): void;
}
interface CapturedSource { handle: WindowsCodingHandle; info: WindowsCodingInfo }
interface FileLease { epoch: number; active: boolean }
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const cleanupFailure = (error: unknown): boolean => error instanceof CodingPrivacyCleanupError || error instanceof WindowsCodingCleanupError;

/** Read the entire bounded object under one non-shared-write native handle before scanning or returning a range. */
export async function readWindowsCodingFile(api: WindowsCodingNative, handle: WindowsCodingHandle, expected: WindowsCodingInfo, maximum: number, check: () => void): Promise<Buffer> {
  check(); const before = api.info(handle);
  if (!windowsCodingSame(expected, before) || before.kind !== "file" || before.links !== 1) throw new ScopedCodingFileError("conflict");
  if (before.size < 0 || before.size > maximum) throw new ScopedCodingFileError("limit");
  const bytes = Buffer.alloc(before.size);
  for (let offset = 0; offset < bytes.length;) {
    check(); const chunk = api.read(handle, offset, Math.min(64 * 1024, bytes.length - offset));
    if (!chunk.length || chunk.length > bytes.length - offset) throw new ScopedCodingFileError("conflict");
    chunk.copy(bytes, offset); offset += chunk.length;
    await windowsCodingYield(); check();
  }
  if (api.read(handle, bytes.length, 1).length || !windowsCodingSame(before, api.info(handle))) throw new ScopedCodingFileError("conflict");
  check(); return bytes;
}

export class WindowsCodingCopy implements ScopedCodingWorkspace {
  readonly executionRoot = "/work";
  readonly directory: string;
  readonly limits: Readonly<ScopedCodingFileLimits>;
  readonly signal: AbortSignal;
  readonly excludedRoots: readonly string[] = Object.freeze([]);
  #api: WindowsCodingNative; #root: WindowsCodingHandle; #identity: WindowsCodingInfo; #base: WindowsCodingPin;
  #input: WindowsCodingCopyInput; #lifetime = new AbortController(); #lease = new AsyncLocalStorage<FileLease>();
  #tail: Promise<void> = Promise.resolve(); #retired = false; #closed = false; #epoch = 0;
  #stopping: Promise<void> | null = null; #closing: Promise<void> | null = null; #failure: unknown;
  #abort: () => void; #privacyScope: CodingPrivacyScope;

  private constructor(input: WindowsCodingCopyInput, api: WindowsCodingNative, base: WindowsCodingPin, root: WindowsCodingHandle, limits: Readonly<ScopedCodingFileLimits>, privacyScope: CodingPrivacyScope) {
    this.#privacyScope = privacyScope; this.#input = { ...input, protectedPaths: [...input.protectedPaths] }; this.#api = api; this.#base = base; this.#root = root;
    this.#identity = api.info(root); this.directory = this.#identity.finalPath; this.limits = limits;
    this.signal = AbortSignal.any([input.signal, this.#lifetime.signal]);
    this.#abort = () => { void this.stop().catch(() => undefined); };
    input.signal.addEventListener("abort", this.#abort, { once: true });
  }
  static async create(input: WindowsCodingCopyInput): Promise<WindowsCodingCopy> {
    if (HOST_PLATFORM !== "win32" || HOST_ARCH !== "x64" || !input || !(input.signal instanceof AbortSignal) || typeof input.current !== "function" ||
        !Array.isArray(input.protectedPaths) || !input.protectedPaths.length || input.protectedPaths.length > 64) throw new ScopedCodingFileError("unavailable");
    input = { ...input, protectedPaths: [...input.protectedPaths], current: input.current.bind(input) };
    const privacyScope = captureCodingPrivacyScope(), limits = windowsCodingLimits(input.limits);
    const check = () => { try { assertCodingPrivacyScope(privacyScope); if (input.signal.aborted || input.current() !== true) throw new ScopedCodingFileError("cancelled"); } catch (error) { throw windowsCodingSafeError(error); } };
    check(); const api = loadWindowsCodingNative(), pins: WindowsCodingPin[] = [], protectedFiles: WindowsCodingHandle[] = [];
    let base: WindowsCodingPin | undefined, copy: WindowsCodingCopy | undefined, root: WindowsCodingHandle | undefined, problem: unknown, failed = false;
    try {
      const source = api.pin(input.source, "read"); pins.push(source);
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
      copy = new WindowsCodingCopy(input, api, base, root, limits, privacyScope); base = undefined; root = undefined;
      const pending = copy.#capture(source.handle, sourceInfo, protectedInfo);
      copy.#tail = pending.then(() => undefined, error => { copy!.#failure = error; });
      await pending; copy.#checkRoot();
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
  async #capture(source: WindowsCodingHandle, sourceInfo: WindowsCodingInfo, protectedInfo: WindowsCodingInfo[]): Promise<void> {
    const api = this.#api, opened: CapturedSource[] = [], aliases = new Set<string>(), ids = new Set<string>();
    const scanner = this.createPrivacyScanner(this.signal); let count = 0, bytes = 0, problem: unknown, failed = false;
    const checkInfo = (info: WindowsCodingInfo) => {
      this.#check(); if (info.volume !== sourceInfo.volume || !windowsCodingWithin(info.finalPath, sourceInfo.finalPath) || protectedInfo.some(p =>
        (p.volume === info.volume && p.id === info.id) || windowsCodingWithin(info.finalPath, p.finalPath))) throw new ScopedCodingFileError("boundary");
    };
    const walk = async (src: WindowsCodingHandle, dest: WindowsCodingHandle, prefix: string, depth: number): Promise<void> => {
      this.#check(); if (depth > this.limits.depth) throw new ScopedCodingFileError("limit");
      const before = api.info(src); checkInfo(before);
      for (const listed of api.list(src, this.limits.entries - count)) {
        this.#check(); if (++count > this.limits.entries) throw new ScopedCodingFileError("limit");
        const relative = prefix ? `${prefix}/${listed.name}` : listed.name;
        try { windowsCodingRelative(relative, false); } catch { throw new ScopedCodingFileError("unsupported"); }
        if (relative.split("/").length > this.limits.depth) throw new ScopedCodingFileError("limit");
        const key = windowsCodingFold(relative); if (aliases.has(key)) throw new ScopedCodingFileError("unsupported"); aliases.add(key);
        if (codingWorkspaceFilePathProblem(relative)) throw new ScopedCodingFileError("secret");
        const kind = listed.attributes & 0x10 ? "directory" : "file", file = api.open(src, listed.name, kind, "source"), info = api.info(file);
        opened.push({ handle: file, info }); checkInfo(info);
        if (listed.id !== info.id || info.kind !== kind || ids.has(`${info.volume}:${info.id}`)) throw new ScopedCodingFileError("conflict");
        // Fresh copies deliberately do not inherit source attributes. Never erase an existing privacy marker.
        if (info.attributes & 0x6) throw new ScopedCodingFileError("privacy");
        ids.add(`${info.volume}:${info.id}`);
        if (kind === "directory") {
          const target = api.create(dest, listed.name, "directory");
          try { api.assertPrivate(target); await walk(file, target, relative, depth + 1); }
          finally { api.close(target); }
        } else {
          if ((bytes += info.size) > this.limits.workspaceBytes) throw new ScopedCodingFileError("limit");
          const body = await readWindowsCodingFile(api, file, info, this.limits.fileBytes, this.#check);
          const why = await codingWorkspaceFileProblemAsync(relative, body, scanner, { signal: this.signal, current: () => this.admitted() }); this.#check();
          if (why) throw new ScopedCodingFileError("secret");
          const target = api.create(dest, listed.name, "file");
          try { api.assertPrivate(target); api.write(target, body); api.flush(target);
            const fresh = api.info(target); if (fresh.id === info.id && fresh.volume === info.volume || fresh.links !== 1 || fresh.size !== body.length) throw new ScopedCodingFileError("boundary");
            if (hash(await readWindowsCodingFile(api, target, fresh, this.limits.fileBytes, this.#check)) !== hash(body)) throw new ScopedCodingFileError("conflict");
          } finally { api.close(target); }
        }
        await windowsCodingYield(); this.#check();
      }
      if (!windowsCodingSame(before, api.info(src))) throw new ScopedCodingFileError("conflict");
    };
    try {
      await walk(source, this.#root, "", 0); this.#check();
      for (const entry of opened) if (!windowsCodingSame(entry.info, api.info(entry.handle))) throw new ScopedCodingFileError("conflict");
      if (!windowsCodingSame(sourceInfo, api.info(source))) throw new ScopedCodingFileError("conflict");
    } catch (error) { failed = true; problem = error; }
    const errors: unknown[] = [];
    for (const entry of opened.reverse()) { try { api.close(entry.handle); } catch (error) { errors.push(error); } }
    try { await scanner.close(); } catch (error) { errors.push(error); }
    if (failed || errors.length) throw errors.find(cleanupFailure) ?? problem ?? errors[0];
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
  async #tree<T>(operation: (tree: WindowsCodingTree) => Promise<T>, current: boolean): Promise<T> {
    const api = this.#api, entries = new Map<string, WindowsCodingTreeEntry>(), aliases = new Set<string>(), ids = new Set<string>(), opened = new Set<WindowsCodingHandle>();
    let total = 0;
    const check = () => { if (current) this.#checkRoot(); };
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
  stop(): Promise<void> {
    this.#retire(); if (this.#lease.getStore() !== undefined) return Promise.reject(new ScopedCodingFileError("boundary"));
    this.#stopping ??= this.#tail.then(() => { if (this.#failure) throw windowsCodingSafeError(this.#failure); }); return this.#stopping;
  }
  close(): Promise<void> {
    this.#retire(); if (this.#lease.getStore() !== undefined) return Promise.reject(new ScopedCodingFileError("boundary"));
    this.#closing ??= this.#tail.then(async () => {
      if (this.#closed) return;
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
