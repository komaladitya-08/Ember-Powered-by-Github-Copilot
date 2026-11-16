/** Disabled root-only ownership prerequisite. No shell, toolchain, project admission or backend capability is issued. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { CodingExportEntry } from "./coding-result-export";
import { ScopedCodingFileError } from "./coding-platform";
import { WindowsCodingCleanupError } from "./windows-coding-native";
import type { WindowsLpacApi, WindowsSuspendedProcess } from "./experimental-windows-lpac-api";
import { createFreshWindowsCommandTree, type FreshWindowsCommandTree, type WindowsCommandCreatorGrantRef } from "./windows-command-copy-native";
import { windowsCommandCreatorProfile, type WindowsCommandCreatorProfileRef } from "./windows-command-creator-profile";
import { createWindowsCommandRootOnlyStopOwner, requireWindowsCommandRootOnlyStopped,
  requireWindowsCommandRootOnlyCompletion, requireWindowsCommandRootOnlyNaturalExit,
  matchWindowsCommandRootOnlyOutput, requireWindowsCommandRootOnlyOutputStopped,
  type WindowsCommandRootOnlyNaturalExitRef, type WindowsCommandRootOnlyStoppedRef,
  type WindowsCommandRootOnlyStopOwner } from "./windows-command-stop";
import { requireWindowsCommandOutputLaunch, activateWindowsCommandOutput, retainWindowsCommandOutput, type WindowsCommandOutputLaunchRef } from "./windows-command-output";

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
  /** Experimental opt-in, issued by the sealed fresh native profile factory; structural profile/SID claims cannot enable it. */
  creatorProfile?: WindowsCommandCreatorProfileRef;
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
const firstCopyFailures = new WeakMap<WindowsRootOnlyCommandCopyFence, WindowsRootOnlyCommandCopyCleanupError>();
declare const launchContextBrand: unique symbol;
export interface WindowsCommandRootOnlyLaunchContext { readonly scope: "root-only-launch"; readonly [launchContextBrand]: true }
const launchContexts = new WeakMap<object, { directory?: string; current?: () => boolean; retire?: () => void; live: boolean }>();
/** Host-only launch data. The capability expires when the synchronous trusted creator returns. */
export function windowsCommandRootOnlyLaunchDirectory(context: unknown): string {
  if (!context || typeof context !== "object") throw new ScopedCodingFileError("boundary");
  const value = launchContexts.get(context);
  if (!value?.live || !value.current) throw new ScopedCodingFileError("cancelled");
  if (!safe(value.current) || !value.live || !value.directory) {
    const retire = value.retire;
    value.live = false; value.current = undefined; value.directory = undefined; value.retire = undefined;
    retire?.(); throw new ScopedCodingFileError("cancelled");
  }
  return value.directory;
}
declare const runBrand: unique symbol;
export interface WindowsCommandRootOnlyRunRef { readonly scope: "root-only-run"; readonly [runBrand]: true }
declare const completedBrand: unique symbol;
export interface WindowsCommandRootOnlyCompletedRef { readonly scope: "root-only-completed"; readonly [completedBrand]: true }
export interface WindowsCommandRootOnlyCompletedFacts { readonly outcome: "natural-exit" | "cancelled" | "terminated"; readonly exitCode: number | null }
type Run = { binding: object; owner: WindowsCommandRootOnlyStopOwner; granted: boolean; creator?: WindowsCommandCreatorGrantRef;
  cancelled?: boolean; interrupted?: boolean; natural?: WindowsCommandRootOnlyNaturalExitRef; stopped?: WindowsCommandRootOnlyStoppedRef;
  revoked?: boolean; completing?: Promise<WindowsCommandRootOnlyCompletedRef>; output?: WindowsCommandOutputLaunchRef; removeOutputAbort?: () => void };
const runs = new WeakMap<object, { owner: WindowsRootOnlyCommandCopy; run: Run }>();
const completedRuns = new WeakMap<object, { run: WindowsCommandRootOnlyRunRef; facts: Readonly<WindowsCommandRootOnlyCompletedFacts> }>();
/** Observation only, never source, file, launch or publication authority. Serialized or foreign records cannot match. */
export function requireWindowsCommandRootOnlyCompleted(ref: unknown, run: WindowsCommandRootOnlyRunRef): Readonly<WindowsCommandRootOnlyCompletedFacts> {
  if (!ref || typeof ref !== "object") throw new ScopedCodingFileError("boundary");
  const value = completedRuns.get(ref); if (!value || value.run !== run) throw new ScopedCodingFileError("boundary"); return value.facts;
}
/** Authenticates the native factory's exact returned PI, live match and genuine completed Stop/revoke generation. */
export function requireWindowsCommandRootOnlyCompletedOutput(ref: unknown, runRef: WindowsCommandRootOnlyRunRef,
  launch: WindowsCommandOutputLaunchRef): Readonly<WindowsCommandRootOnlyCompletedFacts> {
  const facts = requireWindowsCommandRootOnlyCompleted(ref, runRef), selected = runs.get(runRef);
  if (!selected || selected.run.output !== launch || !selected.run.stopped || !selected.run.revoked) throw new ScopedCodingFileError("boundary");
  requireWindowsCommandRootOnlyOutputStopped(selected.run.stopped, selected.run.binding, launch); return facts;
}
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
      creatorProfile: input.creatorProfile,
      current: input.current.bind(input), packageCurrent: input.packageCurrent.bind(input), reviewCurrent: input.reviewCurrent.bind(input) };
    this.#stopFactory = dependencies.createStopOwner?.bind(dependencies) ?? (binding => createWindowsCommandRootOnlyStopOwner(binding, dependencies.api));
    this.#fence = dependencies.fence ?? processFence;
  }
  static async create(input: WindowsRootOnlyCommandCopyInput, dependencies: WindowsRootOnlyCommandCopyDependencies) {
    const fence = dependencies?.fence ?? processFence;
    if (firstCopyFailures.has(fence) || fence.failure) throw firstCopyFailures.get(fence) ?? fence.failure;
    if (!input || !validPackage(input.packageSid) || !Array.isArray(input.protectedPaths) || !Array.isArray(input.entries) ||
        typeof input.current !== "function" || typeof input.packageCurrent !== "function" || typeof input.reviewCurrent !== "function" || !dependencies?.api)
      throw new ScopedCodingFileError("boundary");
    const owner = new WindowsRootOnlyCommandCopy(input, dependencies);
    if (owner.#input.creatorProfile !== undefined && windowsCommandCreatorProfile(owner.#input.creatorProfile).sidText !== owner.#input.packageSid)
      throw new ScopedCodingFileError("boundary");
    owner.#checkWork();
    let owners = activeOwners.get(owner.#fence);
    if (!owners) { owners = new Set(); activeOwners.set(owner.#fence, owners); }
    owners.add(owner);
    try {
      // The native factory validates and clones every entry before its first await; no caller buffer becomes a lease.
      const create = dependencies.createTree?.bind(dependencies) ?? createFreshWindowsCommandTree;
      owner.#tree = await create({ parent: owner.#input.parent, protectedPaths: owner.#input.protectedPaths, entries: input.entries, current: () => owner.#workCurrent(), creatorProfile: owner.#input.creatorProfile });
      if (owner.#input.creatorProfile !== undefined && [owner.#tree.prepareCreator, owner.#tree.captureCreator, owner.#tree.revokeCreator].some(method => typeof method !== "function"))
        throw new ScopedCodingFileError("boundary");
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
    this.#fence.failure = firstCopyFailures.get(this.#fence) ?? this.#fence.failure;
    this.#fence.failure ??= new WindowsRootOnlyCommandCopyCleanupError();
    firstCopyFailures.set(this.#fence, this.#fence.failure);
    for (const owner of activeOwners.get(this.#fence) ?? [this]) if (!owner.#unsafe) {
      owner.#unsafe = this.#fence.failure; owner.#retired = true; owner.#reviewRevoked = true;
      this.#fence.retained.push(owner); // Every callback/native tree/profile binding survives a shared failure.
      // Shared uncertainty removes disposal authority. Stop only the exact known unclosed root/job handles.
      if (owner.#run) try { owner.#run.owner.retainStop(); } catch { /* Every owner remains retained. */ }
      if (owner.#run?.output) retainWindowsCommandOutput(owner.#run.output);
    }
    return this.#fence.failure;
  }
  #usable(): void { if (firstCopyFailures.has(this.#fence) || this.#fence.failure) { this.#poison(); throw this.#fence.failure; } if (this.#unsafe) throw this.#unsafe; if (this.#closed) throw new ScopedCodingFileError("cancelled"); }
  #workCurrent(): boolean {
    if (firstCopyFailures.has(this.#fence) || this.#fence.failure) { this.#poison(); return false; }
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
    run.interrupted ||= run.natural === undefined;
    try {
      const proof = await run.owner.stop(15_000);
      this.#usable();
      requireWindowsCommandRootOnlyStopped(proof, run.binding);
      if (run.granted) {
        if (run.creator) await this.#tree.revokeCreator!(run.creator, proof);
        else await this.#tree.revoke(this.#input.packageSid);
      }
      this.#usable();
      run.stopped = proof; run.revoked = true;
      run.removeOutputAbort?.();
      this.#run = undefined; // Only a verified closed job and complete revocation permit a later generation.
    } catch { throw this.#poison(); }
  }
  /** Trusted native creator/attester only. CREATE_SUSPENDED and exact image/token checks are caller obligations. */
  launchRootOnly(create: () => WindowsSuspendedProcess, attest: (root: Readonly<WindowsSuspendedProcess>) => void): Promise<number> {
    return this.#launchRootOnly(create, attest);
  }
  /** Additive host lifecycle; it supplies no command grammar, assets, source grant or model tool. */
  launchRootOnlyWithContext(create: (context: WindowsCommandRootOnlyLaunchContext) => WindowsSuspendedProcess,
    attest: (root: Readonly<WindowsSuspendedProcess>) => void): Promise<WindowsCommandRootOnlyRunRef> {
    return this.#launchWithContext(create, attest);
  }
  /** Only the sealed native output factory can supply the returned PI; no caller handle list is accepted. */
  launchRootOnlyWithOutput(create: (context: WindowsCommandRootOnlyLaunchContext) => WindowsCommandOutputLaunchRef,
    attest: (root: Readonly<WindowsSuspendedProcess>) => void): Promise<WindowsCommandRootOnlyRunRef> {
    if (typeof create !== "function" || !this.#input.creatorProfile) return Promise.reject(new ScopedCodingFileError("boundary"));
    let output: WindowsCommandOutputLaunchRef | undefined;
    return this.#launchWithContext(context => {
      output = create(context); const actual = requireWindowsCommandOutputLaunch(output);
      if (actual.profile !== this.#input.creatorProfile || actual.context !== context) throw new ScopedCodingFileError("boundary"); return actual.root;
    }, attest, () => output!).catch(error => { if (output) retainWindowsCommandOutput(output); throw error; });
  }
  #launchWithContext(create: (context: WindowsCommandRootOnlyLaunchContext) => WindowsSuspendedProcess,
    attest: (root: Readonly<WindowsSuspendedProcess>) => void, output?: () => WindowsCommandOutputLaunchRef): Promise<WindowsCommandRootOnlyRunRef> {
    if (typeof create !== "function" || typeof attest !== "function") return Promise.reject(new ScopedCodingFileError("boundary"));
    let issued: WindowsCommandRootOnlyRunRef | undefined, generation: Run | undefined;
    return this.#launchRootOnly(() => {
      const directory = this.#tree.directory;
      if (typeof directory !== "string" || directory.length > 4096 || !/^[A-Za-z]:\\/.test(directory) || /[\0\r\n]/.test(directory)) throw new ScopedCodingFileError("boundary");
      const context = Object.freeze({ scope: "root-only-launch" as const }) as WindowsCommandRootOnlyLaunchContext;
      const value = { directory: directory as string | undefined, current: (() => this.#workCurrent()) as (() => boolean) | undefined,
        retire: (() => {
          if (this.#run !== generation || !generation) return;
          this.#retired = true; generation.cancelled = true;
          // Retire Stop admission synchronously; its native work is deferred until the creator has returned.
          void generation.owner.stop().catch(() => undefined);
        }) as (() => void) | undefined, live: true };
      launchContexts.set(context, value);
      try { this.#checkWork(); return create(context); }
      finally { value.live = false; value.directory = undefined; value.current = undefined; value.retire = undefined; }
    }, attest, run => {
      if (typeof run.owner.observeNaturalExit !== "function") throw new ScopedCodingFileError("unavailable");
      generation = run;
      issued = Object.freeze({ scope: "root-only-run" as const }) as WindowsCommandRootOnlyRunRef;
      runs.set(issued, { owner: this, run });
    }, output).then(() => issued!);
  }
  /** Waiting is deliberately outside the native/file queue, so cancellation can always enqueue Stop immediately. */
  completeRootOnly(ref: WindowsCommandRootOnlyRunRef, signal: AbortSignal): Promise<WindowsCommandRootOnlyCompletedRef> {
    if (this.#lease.getStore()) return Promise.reject(new ScopedCodingFileError("boundary"));
    const selected = ref && typeof ref === "object" ? runs.get(ref) : undefined;
    if (!selected || selected.owner !== this || !(signal instanceof AbortSignal)) return Promise.reject(new ScopedCodingFileError("boundary"));
    if (firstCopyFailures.has(this.#fence) || this.#fence.failure || this.#unsafe) {
      try { this.#usable(); } catch (error) { return Promise.reject(error); }
    }
    const run = selected.run; if (run.completing) return run.completing;
    const usable = () => {
      if (firstCopyFailures.has(this.#fence) || this.#fence.failure || this.#unsafe) this.#usable();
      if (!this.#closed) this.#usable();
      else if (!run.stopped || !run.revoked) throw new ScopedCodingFileError("cancelled");
    };
    const cancel = () => { run.cancelled = true; if (this.#run === run) void this.stop().catch(() => undefined); };
    signal.addEventListener("abort", cancel, { once: true }); if (signal.aborted) cancel();
    run.completing = Promise.resolve().then(async () => {
      try {
        usable();
        if (!run.stopped) run.natural = await run.owner.observeNaturalExit!(signal) ?? undefined;
        return await this.#queue(async () => {
          usable();
          if (this.#run === run) await this.#quiesce();
          usable();
          if (!run.stopped || !run.revoked || requireWindowsCommandRootOnlyCompletion(run.stopped, run.binding).rootPresent !== 1) throw this.#poison();
          const natural = run.natural ? requireWindowsCommandRootOnlyNaturalExit(run.natural, run.binding) : undefined;
          const outcome = run.cancelled ? "cancelled" : natural && !run.interrupted ? "natural-exit" : "terminated";
          const completed = Object.freeze({ scope: "root-only-completed" as const }) as WindowsCommandRootOnlyCompletedRef;
          completedRuns.set(completed, { run: ref, facts: Object.freeze({ outcome, exitCode: outcome === "natural-exit" ? natural!.exitCode : null }) });
          return completed;
        });
      } catch { throw this.#poison(); }
      finally { signal.removeEventListener("abort", cancel); }
    });
    return run.completing;
  }
  #launchRootOnly(create: () => WindowsSuspendedProcess, attest: (root: Readonly<WindowsSuspendedProcess>) => void,
    issued?: (run: Run) => void, output?: () => WindowsCommandOutputLaunchRef): Promise<number> {
    if (typeof create !== "function" || typeof attest !== "function") return Promise.reject(new ScopedCodingFileError("boundary"));
    const capturedCreate = create, capturedAttest = attest;
    if (!this.#workCurrent()) return Promise.reject(this.#unsafe ?? new ScopedCodingFileError("cancelled"));
    return this.#queue(async () => {
      this.#checkWork(); if (this.#run) throw new ScopedCodingFileError("boundary");
      await this.#native(() => this.#tree.assertPrivate()); this.#checkWork();
      const binding = Object.freeze({});
      try {
        const run: Run = { binding, owner: this.#stopFactory(binding), granted: false }; this.#run = run;
        issued?.(run);
        if (this.#input.creatorProfile !== undefined) run.creator = this.#tree.prepareCreator!(binding);
        // Mark before the first ACL mutation: a known partial grant still needs a closed empty-job proof and revoke.
        run.granted = true;
        await this.#native(() => this.#tree.grant(this.#input.packageSid, this.#checkWork)); this.#checkWork();
        const verified = (root: Readonly<WindowsSuspendedProcess>) => {
          this.#checkWork();
          if (capturedAttest(root) !== undefined) throw new ScopedCodingFileError("boundary");
          this.#checkWork();
        };
        if (run.creator || output) return await run.owner.launch(capturedCreate, verified, () => this.#workCurrent(), witness => {
          this.#checkWork();
          if (run.creator && this.#tree.captureCreator!(run.creator, witness) !== undefined) throw new ScopedCodingFileError("boundary");
          if (output) {
            const launch = output(), match = matchWindowsCommandRootOnlyOutput(witness, binding, launch), actual = requireWindowsCommandOutputLaunch(launch);
            run.output = launch;
            const abort = () => { if (this.#run === run) {
              run.cancelled = true;
              // Output timers inherit the trusted launch's async context; internal Stop must escape that lease.
              this.#lease.exit(() => { void this.stop().catch(() => undefined); });
            } };
            actual.signal.addEventListener("abort", abort, { once: true }); run.removeOutputAbort = () => actual.signal.removeEventListener("abort", abort);
            if (actual.signal.aborted) abort(); this.#checkWork(); activateWindowsCommandOutput(launch, match);
          }
          this.#checkWork();
        });
        return await run.owner.launch(capturedCreate, verified, () => this.#workCurrent());
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
    if (this.#run) this.#run.cancelled = true;
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
    if (this.#run) this.#run.cancelled = true;
    if (this.#lease.getStore()) return Promise.reject(new ScopedCodingFileError("boundary"));
    return this.#closing ??= this.#queue(async () => {
      if (this.#closed) return; this.#usable(); await this.#quiesce();
      await this.#native(() => this.#tree.close()); this.#usable(); this.#closed = true; activeOwners.get(this.#fence)?.delete(this);
    });
  }
}
