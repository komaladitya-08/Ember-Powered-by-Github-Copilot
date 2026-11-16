/** Disabled root-only ownership prerequisite. No shell, toolchain, project admission or backend capability is issued. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { CodingExportEntry } from "./coding-result-export";
import { ScopedCodingFileError } from "./coding-platform";
import { WindowsCodingCleanupError } from "./windows-coding-native";
import type { WindowsLpacApi, WindowsSuspendedProcess } from "./experimental-windows-lpac-api";
import { createFreshWindowsCommandTree, type FreshWindowsCommandTree } from "./windows-command-copy-native";
import { createWindowsCommandRootOnlyStopOwner, requireWindowsCommandRootOnlyStopped,
  type WindowsCommandRootOnlyStopOwner } from "./windows-command-stop";

export class WindowsRootOnlyCommandCopyCleanupError extends WindowsCodingCleanupError {
  constructor() { super(); this.name = "WindowsRootOnlyCommandCopyCleanupError"; }
}
export interface WindowsRootOnlyCommandCopyInput {
  parent: string;
  protectedPaths: readonly string[];
  /** Already host-admitted bytes. This constructor does not grant source capture or privacy authority. */
  entries: readonly CodingExportEntry[];
  /** Borrowed identity of an actually fresh host-owned profile; profile issuance/deletion is a separate obligation. */
  packageSid: string;
  current(): boolean;
  packageCurrent(): boolean;
  /** Captured publication/account/privacy authority, separate from the stopped worker's admission. */
  reviewCurrent(): boolean;
}
export interface WindowsRootOnlyCommandCopyDependencies {
  api: WindowsLpacApi;
  createTree?: typeof createFreshWindowsCommandTree;
  createStopOwner?(binding: object): WindowsCommandRootOnlyStopOwner;
  /** Injectable native/lifecycle test fence; production owners share the process fence. */
  fence?: WindowsRootOnlyCommandCopyFence;
}
export interface WindowsRootOnlyCommandCopyFence { failure?: WindowsRootOnlyCommandCopyCleanupError; retained: unknown[] }
type Run = { binding: object; owner: WindowsCommandRootOnlyStopOwner; granted: boolean };
const processFence: WindowsRootOnlyCommandCopyFence = { retained: [] };
const activeOwners = new WeakMap<WindowsRootOnlyCommandCopyFence, Set<WindowsRootOnlyCommandCopy>>();
const validPackage = (value: unknown): value is string => typeof value === "string" && /^S-1-15-2-(?:\d+-)*\d+$/.test(value) && value !== "S-1-15-2-1";
const safe = (check: () => boolean) => { try { return check() === true; } catch { return false; } };

/**
 * Owns exactly one fresh work tree. File/review callbacks receive detached bytes only after the root-only job
 * was closed and its package grants were revoked. This is not CodingCommandWorkspace and accepts no commands.
 */
export class WindowsRootOnlyCommandCopy {
  readonly scope = "root-only" as const;
  #tree!: FreshWindowsCommandTree;
  #input: Omit<WindowsRootOnlyCommandCopyInput, "entries">;
  #stopFactory: (binding: object) => WindowsCommandRootOnlyStopOwner;
  #fence: WindowsRootOnlyCommandCopyFence;
  #run: Run | undefined;
  #lease = new AsyncLocalStorage<boolean>();
  #tail: Promise<void> = Promise.resolve();
  #retired = false;
  #reviewRevoked = false;
  #closed = false;
  #unsafe: WindowsRootOnlyCommandCopyCleanupError | undefined;
  #stopping: Promise<void> | undefined;
  #closing: Promise<void> | undefined;

  private constructor(input: WindowsRootOnlyCommandCopyInput, dependencies: WindowsRootOnlyCommandCopyDependencies) {
    this.#input = { parent: input.parent, protectedPaths: [...input.protectedPaths], packageSid: input.packageSid,
      current: input.current.bind(input), packageCurrent: input.packageCurrent.bind(input), reviewCurrent: input.reviewCurrent.bind(input) };
    this.#stopFactory = dependencies.createStopOwner?.bind(dependencies) ?? (binding => createWindowsCommandRootOnlyStopOwner(binding, dependencies.api));
    this.#fence = dependencies.fence ?? processFence;
  }
  static async create(input: WindowsRootOnlyCommandCopyInput, dependencies: WindowsRootOnlyCommandCopyDependencies) {
    const fence = dependencies?.fence ?? processFence;
    if (fence.failure) throw fence.failure;
    if (!input || !validPackage(input.packageSid) || !Array.isArray(input.protectedPaths) || !Array.isArray(input.entries) ||
        typeof input.current !== "function" || typeof input.packageCurrent !== "function" || typeof input.reviewCurrent !== "function" || !dependencies?.api)
      throw new ScopedCodingFileError("boundary");
    const owner = new WindowsRootOnlyCommandCopy(input, dependencies);
    owner.#checkWork();
    let owners = activeOwners.get(owner.#fence);
    if (!owners) { owners = new Set(); activeOwners.set(owner.#fence, owners); }
    owners.add(owner);
    try {
      // The native factory validates and clones every entry before its first await; no caller buffer becomes a lease.
      const create = dependencies.createTree?.bind(dependencies) ?? createFreshWindowsCommandTree;
      owner.#tree = await create({ parent: owner.#input.parent, protectedPaths: owner.#input.protectedPaths, entries: input.entries, current: () => owner.#workCurrent() });
      owner.#checkWork(); return owner;
    } catch (error) {
      if (error instanceof WindowsCodingCleanupError || !(error instanceof ScopedCodingFileError)) throw owner.#poison();
      if (owner.#tree) {
        try { await owner.#tree.close(); } catch { throw owner.#poison(); }
      }
      owners.delete(owner);
      throw error;
    }
  }
  #poison(): WindowsRootOnlyCommandCopyCleanupError {
    this.#fence.failure ??= new WindowsRootOnlyCommandCopyCleanupError();
    for (const owner of activeOwners.get(this.#fence) ?? [this]) if (!owner.#unsafe) {
      owner.#unsafe = this.#fence.failure; owner.#retired = true; owner.#reviewRevoked = true;
      this.#fence.retained.push(owner); // Every callback/native tree/profile binding survives a shared failure.
      // Shared uncertainty removes disposal authority. Stop only the exact known unclosed root/job handles.
      if (owner.#run) try { owner.#run.owner.retainStop(); } catch { /* Every owner remains retained. */ }
    }
    return this.#fence.failure;
  }
  #usable(): void { if (this.#fence.failure) { this.#poison(); throw this.#fence.failure; } if (this.#unsafe) throw this.#unsafe; if (this.#closed) throw new ScopedCodingFileError("cancelled"); }
  #workCurrent(): boolean {
    if (this.#fence.failure) { this.#poison(); return false; }
    if (this.#unsafe || this.#closed || this.#retired) return false;
    const admitted = safe(this.#input.current) && safe(this.#input.packageCurrent);
    if (this.#fence.failure) { this.#poison(); return false; }
    return admitted && !this.#unsafe && !this.#closed && !this.#retired;
  }
  #checkWork = (): void => {
    this.#usable(); const current = this.#workCurrent(); this.#usable();
    if (!current) throw new ScopedCodingFileError("cancelled");
  };
  #checkReview = (): void => {
    this.#usable();
    if (!this.#retired || this.#reviewRevoked) throw new ScopedCodingFileError("cancelled");
    const current = safe(this.#input.reviewCurrent);
    this.#usable();
    if (!current || !this.#retired || this.#reviewRevoked) throw new ScopedCodingFileError("cancelled");
  };
  #queue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#lease.getStore()) return Promise.reject(new ScopedCodingFileError("boundary"));
    const pending = this.#tail.then(() => this.#lease.run(true, operation));
    this.#tail = pending.then(() => undefined, () => undefined); return pending;
  }
  async #native<T>(operation: () => Promise<T>): Promise<T> {
    this.#usable();
    try { return await operation(); }
    catch (error) {
      if (error instanceof ScopedCodingFileError && !(error instanceof WindowsCodingCleanupError)) throw error;
      throw this.#poison();
    }
  }
  async #quiesce(): Promise<void> {
    this.#usable(); const run = this.#run; if (!run) return;
    try {
      const proof = await run.owner.stop(15_000);
      this.#usable();
      requireWindowsCommandRootOnlyStopped(proof, run.binding);
      if (run.granted) await this.#tree.revoke(this.#input.packageSid);
      this.#usable();
      this.#run = undefined; // Only a verified closed job and complete revocation permit a later generation.
    } catch { throw this.#poison(); }
  }
  /** Trusted native creator/attester only. CREATE_SUSPENDED and exact image/token checks are caller obligations. */
  launchRootOnly(create: () => WindowsSuspendedProcess, attest: (root: Readonly<WindowsSuspendedProcess>) => void): Promise<number> {
    if (typeof create !== "function" || typeof attest !== "function") return Promise.reject(new ScopedCodingFileError("boundary"));
    const capturedCreate = create, capturedAttest = attest;
    if (!this.#workCurrent()) return Promise.reject(this.#unsafe ?? new ScopedCodingFileError("cancelled"));
    return this.#queue(async () => {
      this.#checkWork(); if (this.#run) throw new ScopedCodingFileError("boundary");
      await this.#native(() => this.#tree.assertPrivate()); this.#checkWork();
      const binding = Object.freeze({});
      try {
        const run: Run = { binding, owner: this.#stopFactory(binding), granted: false }; this.#run = run;
        // Mark before the first ACL mutation: a known partial grant still needs a closed empty-job proof and revoke.
        run.granted = true;
        await this.#native(() => this.#tree.grant(this.#input.packageSid, this.#checkWork)); this.#checkWork();
        return await run.owner.launch(capturedCreate, root => {
          this.#checkWork();
          if (capturedAttest(root) !== undefined) throw new ScopedCodingFileError("boundary");
          this.#checkWork();
        }, () => this.#workCurrent());
      } catch (error) {
        if (error instanceof WindowsCodingCleanupError || !(error instanceof ScopedCodingFileError)) throw this.#poison();
        await this.#quiesce(); throw error;
      }
    });
  }
  /** File callbacks and roots never overlap. Bytes are cleared when this exclusive host callback ends. */
  files<T>(operation: (entries: readonly CodingExportEntry[]) => Promise<T>): Promise<T> {
    if (typeof operation !== "function") return Promise.reject(new ScopedCodingFileError("boundary"));
    if (!this.#workCurrent()) return Promise.reject(this.#unsafe ?? new ScopedCodingFileError("cancelled"));
    return this.#queue(async () => {
      this.#checkWork(); await this.#quiesce(); this.#checkWork();
      const entries = await this.#native(() => this.#tree.snapshot(this.#checkWork));
      try { this.#checkWork(); const result = await operation(entries); this.#checkWork(); return result; }
      catch (error) { if (error instanceof WindowsCodingCleanupError) throw this.#poison(); throw new ScopedCodingFileError(error instanceof ScopedCodingFileError ? error.code : "io"); }
      finally { for (const entry of entries) if (entry.kind === "file") entry.bytes.fill(0); }
    });
  }
  /** Revokes starts synchronously. The separate captured review authority can still read a verified private tree. */
  stop(): Promise<void> {
    this.#retired = true;
    if (this.#lease.getStore()) return Promise.reject(new ScopedCodingFileError("boundary"));
    return this.#stopping ??= this.#queue(async () => { this.#usable(); await this.#quiesce(); });
  }
  review<T>(operation: (entries: readonly CodingExportEntry[]) => Promise<T>): Promise<T> {
    if (typeof operation !== "function") return Promise.reject(new ScopedCodingFileError("boundary"));
    try { this.#checkReview(); } catch (error) { return Promise.reject(error); }
    return this.#queue(async () => {
      this.#checkReview(); await this.#quiesce(); this.#checkReview();
      const entries = await this.#native(() => this.#tree.snapshot(this.#checkReview));
      try { this.#checkReview(); const result = await operation(entries); this.#checkReview(); return result; }
      catch (error) { if (error instanceof WindowsCodingCleanupError) throw this.#poison(); throw new ScopedCodingFileError(error instanceof ScopedCodingFileError ? error.code : "io"); }
      finally { for (const entry of entries) if (entry.kind === "file") entry.bytes.fill(0); }
    });
  }
  close(): Promise<void> {
    this.#retired = true; this.#reviewRevoked = true;
    if (this.#lease.getStore()) return Promise.reject(new ScopedCodingFileError("boundary"));
    return this.#closing ??= this.#queue(async () => {
      if (this.#closed) return; this.#usable(); await this.#quiesce();
      await this.#native(() => this.#tree.close()); this.#usable(); this.#closed = true; activeOwners.get(this.#fence)?.delete(this);
    });
  }
}
