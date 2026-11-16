/** Disabled root-only ownership prerequisite. No shell, toolchain, project admission or backend capability is issued. */
import { AsyncLocalStorage } from "node:async_hooks";
import type { CodingExportEntry } from "./coding-result-export";
import { ScopedCodingFileError } from "./coding-platform";
import { CodingPrivacyScanner, CodingPrivacyScanError, CodingPrivacyCleanupError, assertCodingPrivacyScope } from "./coding-privacy-scanner";
import { codingWorkspaceFilePathProblem, codingWorkspaceFileProblemAsync } from "./scoped-coding-files";
import { windowsCodingRelative, windowsCodingFold } from "./windows-coding-policy";
import { WindowsCodingCleanupError } from "./windows-coding-native";
import { loadExperimentalWindowsLpacApi, type WindowsLpacApi, type WindowsSuspendedProcess } from "./experimental-windows-lpac-api";
import { takeWindowsCodingCommandInput, requireWindowsCodingCommandReceiver, requireWindowsCodingCommandReceiverForCleanup, type WindowsCodingCommandReceiverRef, type WindowsCodingCommandInputRef, type WindowsCodingCommandInputData } from "./windows-coding-copy";
import { createFreshWindowsCommandTree, type FreshWindowsCommandTree, type WindowsCommandCreatorGrantRef } from "./windows-command-copy-native";
import { windowsCommandCreatorProfile, type WindowsCommandCreatorProfileRef } from "./windows-command-creator-profile";
import { createWindowsCommandRootOnlyStopOwner, requireWindowsCommandRootOnlyStopped,
  requireWindowsCommandRootOnlyCompletion, requireWindowsCommandRootOnlyNaturalExit,
  matchWindowsCommandRootOnlyOutput, requireWindowsCommandRootOnlyOutputStopped,
  windowsCommandRootOnlyReturnedForRoot,
  type WindowsCommandRootOnlyNaturalExitRef, type WindowsCommandRootOnlyStoppedRef,
  type WindowsCommandRootOnlyStopOwner } from "./windows-command-stop";
import { requireWindowsCommandOutputLaunch, activateWindowsCommandOutput, retainWindowsCommandOutput, requireWindowsCommandOutputClosed, type WindowsCommandOutputClosedRef, type WindowsCommandOutputLaunchRef } from "./windows-command-output";
import { attestWindowsNodeToolchainOutput } from "./windows-node-toolchain-native";
import { readConsumedWindowsCommandLaunchCancellation, probeReturnedWindowsCommandCancellation } from "./windows-command-launch-cancel";

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
declare const intakeBrand: unique symbol;
export interface WindowsCommandTransferIntakeRef { readonly scope: "canonical-command-intake"; readonly [intakeBrand]: true }
declare const snapshotBrand: unique symbol;
export interface WindowsCommandStoppedSnapshotRef { readonly scope: "stopped-command-snapshot"; readonly [snapshotBrand]: true }
export interface WindowsCommandStoppedSnapshotFacts extends WindowsCommandRootOnlyCompletedFacts {
  readonly input: WindowsCodingCommandInputRef;
  readonly outputComplete: boolean;
}
type StoppedSnapshot = { phase: "ready" | "validating" | "used"; facts: Readonly<WindowsCommandStoppedSnapshotFacts>;
  entries?: readonly CodingExportEntry[]; check(): void };
const stoppedSnapshots = new WeakMap<object, StoppedSnapshot>();
function stoppedSnapshot(ref: unknown): StoppedSnapshot {
  if (!ref || typeof ref !== "object") throw new ScopedCodingFileError("boundary");
  const value = stoppedSnapshots.get(ref);
  if (!value || value.phase !== "ready" || !value.entries) throw new ScopedCodingFileError("boundary");
  return value;
}
/** Metadata alone never grants bytes or imports a tree. */
export function readWindowsCommandStoppedSnapshot(ref: WindowsCommandStoppedSnapshotRef): Readonly<WindowsCommandStoppedSnapshotFacts> {
  const value = stoppedSnapshot(ref); value.phase = "validating";
  try { value.check(); return value.facts; } finally { value.phase = "ready"; }
}
/** Exact canonical receiver and unchanged content revision, then a synchronous one-shot byte move. */
export function takeWindowsCommandStoppedSnapshot(ref: WindowsCommandStoppedSnapshotRef, receiver: WindowsCodingCommandReceiverRef):
  Readonly<WindowsCommandStoppedSnapshotFacts & { entries: readonly CodingExportEntry[] }> {
  const value = stoppedSnapshot(ref); value.phase = "validating";
  try {
    value.check(); requireWindowsCodingCommandReceiver(receiver, value.facts.input); value.check();
    const result = Object.freeze({ ...value.facts, entries: value.entries! });
    value.phase = "used"; value.entries = undefined;
    return result;
  } finally { if (value.phase === "validating") value.phase = "ready"; }
}
export interface WindowsCommandTransferHostOptions {
  packageSid: string;
  creatorProfile: WindowsCommandCreatorProfileRef;
  packageCurrent(): boolean;
}
const transferIntakes = new WeakMap<object, { active: boolean; requireOwner(): void }>();
const inputProducers = new WeakMap<object, { requireClosed(): void; discardSnapshot(): void; requireUnstarted(): void; releaseUnstarted(): void }>();
/** Only the exact synchronously initializing owner can receive a complete canonical capture. */
export function requireWindowsCommandTransferIntake(ref: unknown): void {
  if (!ref || typeof ref !== "object") throw new ScopedCodingFileError("boundary");
  const value = transferIntakes.get(ref);
  if (!value?.active) throw new ScopedCodingFileError("boundary");
  value.requireOwner();
}
/** A consumed input cannot release its canonical owner until its exact native producer closed positively. */
export function requireWindowsCommandInputProducerClosed(input: unknown): void {
  if (!input || typeof input !== "object") throw new ScopedCodingFileError("boundary");
  const value = inputProducers.get(input);
  if (!value) throw new ScopedCodingFileError("boundary");
  value.requireClosed();
}
/** Erasure only: a cancelled publication may discard detached bytes, but cannot create or adopt them. */
export function discardWindowsCommandInputSnapshot(input: WindowsCodingCommandInputRef, receiver: WindowsCodingCommandReceiverRef): void {
  if (!input || typeof input !== "object") throw new ScopedCodingFileError("boundary");
  const value = inputProducers.get(input); if (!value) throw new ScopedCodingFileError("boundary");
  value.requireClosed(); requireWindowsCodingCommandReceiverForCleanup(receiver, input); value.discardSnapshot();
}
/** Observation only: a positively closed owner that never issued a run or snapshot may release old review bytes. */
export function requireWindowsCommandUnstartedInput(input: WindowsCodingCommandInputRef): void {
  if (!input || typeof input !== "object") throw new ScopedCodingFileError("boundary");
  const value = inputProducers.get(input); if (!value) throw new ScopedCodingFileError("boundary"); value.requireUnstarted();
}
/** One-shot reservation release only. No bytes, stopped proof, imported tree or execution authority is issued. */
export function releaseWindowsCommandUnstartedInput(input: WindowsCodingCommandInputRef, receiver: WindowsCodingCommandReceiverRef): void {
  if (!input || typeof input !== "object") throw new ScopedCodingFileError("boundary");
  const value = inputProducers.get(input); if (!value) throw new ScopedCodingFileError("boundary");
  value.requireUnstarted(); requireWindowsCodingCommandReceiverForCleanup(receiver, input); value.releaseUnstarted();
}
declare const launchContextBrand: unique symbol;
export interface WindowsCommandRootOnlyLaunchContext { readonly scope: "root-only-launch"; readonly [launchContextBrand]: true }
const launchContexts = new WeakMap<object, { binding: object; profile?: WindowsCommandCreatorProfileRef; directory?: string; current?: () => boolean; retire?: () => void; live: boolean }>();
/** Provenance only, retained after expiry for cancellation cleanup; no directory or execution grant is exposed. */
export function requireWindowsCommandRootOnlyLaunchMetadata(context: WindowsCommandRootOnlyLaunchContext): Readonly<{ binding: object; profile?: WindowsCommandCreatorProfileRef; live: boolean }> {
  const value = context && typeof context === "object" ? launchContexts.get(context) : undefined;
  if (!value) throw new ScopedCodingFileError("boundary"); return Object.freeze({ binding: value.binding, profile: value.profile, live: value.live });
}
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
  #input!: Omit<WindowsRootOnlyCommandCopyInput, "entries">;
  #stopFactory: (binding: object) => WindowsCommandRootOnlyStopOwner;
  #fence: WindowsRootOnlyCommandCopyFence;
  #run: Run | undefined;
  #lastRun: Run | undefined;
  #snapshotIssued = false;
  #unstartedReleased = false;
  #snapshot?: StoppedSnapshot;
  #lease = new AsyncLocalStorage<boolean>();
  #tail: Promise<void> = Promise.resolve();
  #retired = false;
  #reviewRevoked = false;
  #closed = false;
  #unsafe: WindowsRootOnlyCommandCopyCleanupError | undefined;
  #stopping: Promise<void> | undefined;
  #closing: Promise<void> | undefined;
  #canonicalInput?: { ref: WindowsCodingCommandInputRef; data: Omit<WindowsCodingCommandInputData, "entries"> };
  #removeInputAbort?: () => void;

  private constructor(input?: WindowsRootOnlyCommandCopyInput, dependencies?: WindowsRootOnlyCommandCopyDependencies) {
    if (input) this.#initialize(input);
    this.#stopFactory = dependencies
      ? dependencies.createStopOwner?.bind(dependencies) ?? (binding => createWindowsCommandRootOnlyStopOwner(binding, dependencies.api))
      : binding => createWindowsCommandRootOnlyStopOwner(binding, loadExperimentalWindowsLpacApi());
    this.#fence = dependencies?.fence ?? processFence;
  }
  #initialize(input: WindowsRootOnlyCommandCopyInput): void {
    this.#input = { parent: input.parent, protectedPaths: [...input.protectedPaths], packageSid: input.packageSid,
      creatorProfile: input.creatorProfile,
      current: input.current.bind(input), packageCurrent: input.packageCurrent.bind(input), reviewCurrent: input.reviewCurrent.bind(input) };
  }
  #requireProducerClosed(): void {
    if (firstCopyFailures.has(this.#fence) || this.#fence.failure || this.#unsafe) throw this.#poison();
    if (!this.#closed || !this.#canonicalInput) throw new ScopedCodingFileError("boundary");
  }
  #requireUnstarted(): void {
    this.#requireProducerClosed();
    if (this.#lastRun || this.#run || this.#snapshotIssued || this.#snapshot || this.#unstartedReleased) throw new ScopedCodingFileError("boundary");
  }
  #discardSnapshot(): void {
    const value = this.#snapshot; if (!value || value.phase === "used") return;
    if (value.phase !== "ready") throw new ScopedCodingFileError("boundary");
    const entries = value.entries; value.phase = "used"; value.entries = undefined;
    for (const entry of entries ?? []) if (entry.kind === "file") entry.bytes.fill(0);
  }
  #clearInputAbort(): void { this.#removeInputAbort?.(); this.#removeInputAbort = undefined; }
  /** Fixed factories only: dependency injection and structural tree claims cannot issue canonical authority. */
  static async createFromInput(input: WindowsCodingCommandInputRef, options: WindowsCommandTransferHostOptions): Promise<WindowsRootOnlyCommandCopy> {
    let selected: WindowsCommandTransferHostOptions;
    try {
      if (!options || typeof options !== "object") throw new Error();
      const keys = Reflect.ownKeys(options), names = ["packageSid", "creatorProfile", "packageCurrent"];
      if (keys.length !== names.length || keys.some(key => typeof key !== "string" || !names.includes(key))) throw new Error();
      const properties = Object.getOwnPropertyDescriptors(options);
      if (names.some(name => !properties[name] || !Object.hasOwn(properties[name], "value"))) throw new Error();
      const packageSid = properties.packageSid.value, creatorProfile = properties.creatorProfile.value, packageCurrent = properties.packageCurrent.value;
      if (!validPackage(packageSid) || !creatorProfile || typeof packageCurrent !== "function") throw new Error();
      selected = { packageSid, creatorProfile, packageCurrent: packageCurrent.bind(options) };
    } catch { throw new ScopedCodingFileError("boundary"); }
    if (windowsCommandCreatorProfile(selected.creatorProfile).sidText !== selected.packageSid) throw new ScopedCodingFileError("boundary");
    if (firstCopyFailures.has(processFence) || processFence.failure) throw firstCopyFailures.get(processFence) ?? processFence.failure;
    const owner = new WindowsRootOnlyCommandCopy();
    const intake = Object.freeze({ scope: "canonical-command-intake" as const }) as WindowsCommandTransferIntakeRef;
    const state = { active: true, requireOwner: () => {
      if (firstCopyFailures.has(owner.#fence) || owner.#fence.failure || owner.#unsafe) throw owner.#poison();
      if (owner.#closed || owner.#retired || owner.#canonicalInput) throw new ScopedCodingFileError("boundary");
    } };
    transferIntakes.set(intake, state);
    let data: WindowsCodingCommandInputData | undefined;
    const erase = () => { for (const entry of data?.entries ?? []) if (entry.kind === "file") entry.bytes.fill(0); };
    let owners: Set<WindowsRootOnlyCommandCopy> | undefined;
    try {
      data = takeWindowsCodingCommandInput(input, intake);
      // No callback or await separates the parent's one-shot claim from the exact producer ledger.
      inputProducers.set(input, { requireClosed: () => owner.#requireProducerClosed(), discardSnapshot: () => owner.#discardSnapshot(),
        requireUnstarted: () => owner.#requireUnstarted(), releaseUnstarted: () => { owner.#requireUnstarted(); owner.#unstartedReleased = true; } });
      const { entries: _entries, ...captured } = data;
      owner.#canonicalInput = { ref: input, data: captured }; state.active = false;
      owner.#initialize({ parent: data.parent, protectedPaths: data.protectedPaths, entries: data.entries,
        packageSid: selected.packageSid, creatorProfile: selected.creatorProfile, packageCurrent: selected.packageCurrent,
        current: data.current, reviewCurrent: data.reviewCurrent });
      const abort = () => owner.#lease.exit(() => { void owner.stop().catch(() => undefined); });
      data.signal.addEventListener("abort", abort, { once: true });
      owner.#removeInputAbort = () => data!.signal.removeEventListener("abort", abort);
      if (data.signal.aborted) abort();
      owners = activeOwners.get(owner.#fence);
      if (!owners) { owners = new Set(); activeOwners.set(owner.#fence, owners); }
      owners.add(owner); owner.#checkWork();
      let creating: Promise<FreshWindowsCommandTree>;
      try {
        // The fixed native factory clones every admitted entry synchronously, before its first await.
        creating = createFreshWindowsCommandTree({ parent: owner.#input.parent, protectedPaths: owner.#input.protectedPaths,
          entries: data.entries, creatorProfile: owner.#input.creatorProfile, current: owner.#nativeCurrent });
      } finally { erase(); }
      owner.#tree = await creating;
      if ([owner.#tree.prepareCreator, owner.#tree.captureCreator, owner.#tree.revokeCreator].some(method => typeof method !== "function")) throw new ScopedCodingFileError("boundary");
      owner.#checkWork(); return owner;
    } catch (error) {
      if (!data) { owner.#closed = true; throw error; }
      if (error instanceof WindowsCodingCleanupError || !(error instanceof ScopedCodingFileError)) throw owner.#poison();
      if (owner.#tree) { try { await owner.#tree.close(); } catch { throw owner.#poison(); } }
      owner.#retired = true; owner.#closed = true; owner.#clearInputAbort(); owners?.delete(owner);
      throw error;
    } finally { state.active = false; erase(); }
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
      owner.#tree = await create({ parent: owner.#input.parent, protectedPaths: owner.#input.protectedPaths, entries: input.entries, current: owner.#nativeCurrent, creatorProfile: owner.#input.creatorProfile });
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
    const check = (predicate: () => boolean) => {
      try { return predicate() === true; }
      catch (error) { if (error instanceof WindowsCodingCleanupError) this.#poison(); return false; }
    };
    const admitted = check(this.#input.current) && check(this.#input.packageCurrent);
    if (this.#fence.failure) { this.#poison(); return false; }
    return admitted && !this.#unsafe && !this.#closed && !this.#retired;
  }
  #nativeCurrent = (): boolean => { const current = this.#workCurrent(); this.#usable(); return current; };
  #checkWork = (): void => {
    this.#usable(); const current = this.#workCurrent(); this.#usable();
    if (!current) throw new ScopedCodingFileError("cancelled");
  };
  #checkReturnedWork(root: Readonly<WindowsSuspendedProcess>, binding: object): void {
    this.#usable(); const current = this.#workCurrent(); this.#usable();
    if (!current) {
      const returned = windowsCommandRootOnlyReturnedForRoot(root, binding);
      if (returned) { const claim = probeReturnedWindowsCommandCancellation(returned); if (claim) throw claim; }
      throw new ScopedCodingFileError("cancelled");
    }
  }
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
      const value = { binding: generation!.binding, profile: this.#input.creatorProfile,
        directory: directory as string | undefined, current: (() => this.#workCurrent()) as (() => boolean) | undefined,
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
    }, output).then(() => issued!, error => {
      const cancellation = generation && readConsumedWindowsCommandLaunchCancellation(error, generation.binding);
      if (cancellation?.phase === "held" && issued && generation?.stopped && generation.revoked && generation.output === cancellation.launch) return issued;
      if (cancellation?.phase === "empty") throw new ScopedCodingFileError("cancelled");
      throw error;
    });
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
      const hadPreviousRun = this.#lastRun !== undefined;
      try {
        const run: Run = { binding, owner: this.#stopFactory(binding), granted: false }; this.#run = run; this.#lastRun = run;
        issued?.(run);
        if (this.#input.creatorProfile !== undefined) run.creator = this.#tree.prepareCreator!(binding);
        // Mark before the first ACL mutation: a known partial grant still needs a closed empty-job proof and revoke.
        run.granted = true;
        await this.#native(() => this.#tree.grant(this.#input.packageSid, this.#checkWork)); this.#checkWork();
        let verifiedRoot: Readonly<WindowsSuspendedProcess> | undefined;
        const verified = (root: Readonly<WindowsSuspendedProcess>) => {
          this.#checkReturnedWork(root, binding);
          if (capturedAttest(root) !== undefined) throw new ScopedCodingFileError("boundary");
          this.#checkReturnedWork(root, binding); verifiedRoot = root;
        };
        if (run.creator || output) return await run.owner.launch(capturedCreate, verified, this.#nativeCurrent, witness => {
          if (verifiedRoot) this.#checkReturnedWork(verifiedRoot, binding); else this.#checkWork();
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
            if (actual.signal.aborted) abort(); this.#checkReturnedWork(verifiedRoot!, binding);
            activateWindowsCommandOutput(launch, match);
            attestWindowsNodeToolchainOutput(launch, witness, binding); this.#checkReturnedWork(verifiedRoot!, binding);
          }
          if (verifiedRoot) this.#checkReturnedWork(verifiedRoot, binding); else this.#checkWork();
        });
        return await run.owner.launch(capturedCreate, verified, this.#nativeCurrent);
      } catch (error) {
        const cancellation = readConsumedWindowsCommandLaunchCancellation(error, binding), run = this.#run;
        if (cancellation && run?.binding === binding) {
          if (cancellation.phase === "held" && run.output === undefined) {
            if (!cancellation.launch || output?.() !== cancellation.launch) throw this.#poison(); run.output = cancellation.launch;
          }
          this.#retired = true; run.cancelled = true;
          await this.#quiesce();
          if (!run.stopped || !run.revoked || requireWindowsCommandRootOnlyCompletion(run.stopped, binding).rootPresent !== (cancellation.phase === "empty" ? 0 : 1) || run.output !== cancellation.launch) throw this.#poison();
          // A prior real generation must remain stale; only initial absence can be restored for no-run recovery.
          if (cancellation.phase === "empty" && !hadPreviousRun) this.#lastRun = undefined;
          throw error;
        }
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
  /** A genuine stopped generation, closed native output and a positively retired tree are all required. */
  captureStoppedSnapshot(ref: WindowsCommandRootOnlyRunRef, completed: WindowsCommandRootOnlyCompletedRef,
    closedOutput: WindowsCommandOutputClosedRef): Promise<WindowsCommandStoppedSnapshotRef> {
    const authenticate = () => {
      const selected = ref && typeof ref === "object" ? runs.get(ref) : undefined;
      if (!this.#canonicalInput || !selected || selected.owner !== this || selected.run !== this.#lastRun ||
          this.#run || !selected.run.output || this.#snapshotIssued) throw new ScopedCodingFileError("boundary");
      const completion = requireWindowsCommandRootOnlyCompletedOutput(completed, ref, selected.run.output);
      const output = requireWindowsCommandOutputClosed(closedOutput, selected.run.output, ref);
      return { completion, output };
    };
    try { this.#usable(); authenticate(); } catch (error) {
      return Promise.reject(error instanceof WindowsCodingCleanupError ? this.#poison() :
        error instanceof ScopedCodingFileError ? error : new ScopedCodingFileError("boundary"));
    }
    // No newer generation may enter while capture waits for its exclusive owner queue.
    this.#retired = true;
    return this.#queue(async () => {
      const input = this.#canonicalInput!;
      const check = () => {
        this.#usable(); assertCodingPrivacyScope(input.data.privacyScope);
        try { this.#checkReview(); } catch (error) { assertCodingPrivacyScope(input.data.privacyScope); throw error; }
        assertCodingPrivacyScope(input.data.privacyScope);
      };
      let entries: readonly CodingExportEntry[] | undefined, scanner: CodingPrivacyScanner | undefined, retained = false;
      try {
        check(); const { completion, output } = authenticate();
        entries = await this.#native(() => this.#tree.snapshot(check)); check();
        // Publication has its own captured authority. An aborted execution signal must not revive or prevent review.
        scanner = new CodingPrivacyScanner({ scope: input.data.privacyScope });
        const paths = new Set<string>(); let bytes = 0;
        if (entries.length > input.data.limits.entries) throw new ScopedCodingFileError("limit");
        for (const entry of entries) {
          check();
          const relative = windowsCodingRelative(entry.path, false), folded = windowsCodingFold(relative);
          if (paths.has(folded)) throw new ScopedCodingFileError("boundary"); paths.add(folded);
          if (relative.split("/").length > input.data.limits.depth) throw new ScopedCodingFileError("limit");
          if (codingWorkspaceFilePathProblem(relative)) throw new ScopedCodingFileError("secret");
          if (entry.kind === "file") {
            if (entry.bytes.length > input.data.limits.fileBytes || (bytes += entry.bytes.length) > input.data.limits.workspaceBytes) throw new ScopedCodingFileError("limit");
            if (await codingWorkspaceFileProblemAsync(relative, entry.bytes, scanner, { current: () => { check(); return true; } })) throw new ScopedCodingFileError("secret");
            check();
          }
        }
        await scanner.close(); scanner = undefined; check();
        // This is already the owner's exclusive queue: never recursively call public close().
        await this.#native(() => this.#tree.close()); check();
        this.#closed = true; this.#clearInputAbort(); activeOwners.get(this.#fence)?.delete(this);
        const facts = Object.freeze({ input: input.ref, ...completion, outputComplete: output.complete });
        const snapshot = Object.freeze({ scope: "stopped-command-snapshot" as const }) as WindowsCommandStoppedSnapshotRef;
        const owned = Object.freeze(entries.map(entry => Object.freeze(entry)));
        const record: StoppedSnapshot = { phase: "ready", facts, entries: owned, check: () => {
          this.#requireProducerClosed(); assertCodingPrivacyScope(input.data.privacyScope);
          if (!safe(input.data.reviewCurrent)) throw new ScopedCodingFileError("cancelled");
          this.#requireProducerClosed(); assertCodingPrivacyScope(input.data.privacyScope);
        } };
        stoppedSnapshots.set(snapshot, record); this.#snapshot = record;
        this.#snapshotIssued = true; entries = undefined; return snapshot;
      } catch (error) {
        if (scanner && !(error instanceof CodingPrivacyCleanupError)) try { await scanner.close(); scanner = undefined; } catch { retained = true; }
        if (retained || error instanceof CodingPrivacyCleanupError || error instanceof WindowsCodingCleanupError ||
            (!(error instanceof ScopedCodingFileError) && !(error instanceof CodingPrivacyScanError))) {
          this.#fence.retained.push({ owner: this, entries, scanner }); retained = true; throw this.#poison();
        }
        throw new ScopedCodingFileError(error instanceof ScopedCodingFileError ? error.code : "privacy");
      } finally { if (!retained) for (const entry of entries ?? []) if (entry.kind === "file") entry.bytes.fill(0); }
    });
  }
  close(): Promise<void> {
    this.#retired = true; this.#reviewRevoked = true;
    if (this.#run) this.#run.cancelled = true;
    if (this.#lease.getStore()) return Promise.reject(new ScopedCodingFileError("boundary"));
    return this.#closing ??= this.#queue(async () => {
      if (this.#closed) return; this.#usable(); await this.#quiesce();
      await this.#native(() => this.#tree.close()); this.#usable(); this.#closed = true; this.#clearInputAbort(); activeOwners.get(this.#fence)?.delete(this);
    });
  }
}
