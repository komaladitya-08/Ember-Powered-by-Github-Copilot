/**
 * Windows copied workspace. Source handles are read-only; every destination object is fresh/private.
 * Its new host-only command transfer is unregistered and requires the genuine native owner's stopped/output-closed snapshot.
 * The existing Windows adapter remains files-only. Unrelated same-user/admin host processes are outside the boundary.
 */
import path from "node:path/win32";
import { randomUUID, createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import { ScopedCodingFileError, type ScopedCodingWorkspace, type ScopedCodingFileLimits } from "./coding-platform";
import { CodingPrivacyScanner, CodingPrivacyScanError, CodingPrivacyCleanupError, captureCodingPrivacyScope, assertCodingPrivacyScope, type CodingPrivacyScope } from "./coding-privacy-scanner";
import { codingWorkspaceFilePathProblem, codingWorkspaceFileProblemAsync } from "./scoped-coding-files";
import { loadWindowsCodingNative, retireWindowsCodingNative, WindowsCodingCleanupError, type WindowsCodingNative, type WindowsCodingHandle, type WindowsCodingInfo, type WindowsCodingPin } from "./windows-coding-native";
import { windowsCodingLimits, windowsCodingRelative, windowsCodingFold, windowsCodingSame, windowsCodingWithin, windowsCodingSafeError, windowsCodingYield, windowsCodingExcludedRoot } from "./windows-coding-policy";
import { WindowsCodingArtifactStore } from "./windows-coding-artifact-store";
import { CodingArtifactCleanupError, type CodingArtifactSourceRef } from "./coding-artifact-store";
import { createCodingReviewExport, type CodingExportBinding, type CodingExportEntry, type CodingExportTree } from "./coding-result-export";
import { codingProjectManifest, type CodingExcludedRoot, type CodingProjectManifest, type CodingScopeOmission } from "./coding-project-scope";
import { clearWindowsCodingTree, ownWindowsCodingReview, type WindowsCodingReviewProducer } from "./windows-coding-review";
import type { CodingWorkspaceContinuation } from "./coding-seed-snapshot";
import { prepareWindowsCodingContinuation, materializeWindowsCodingContinuation } from "./windows-coding-continuation-seed";
import type { WindowsCommandTransferIntakeRef, WindowsCommandStoppedSnapshotRef, WindowsCommandStoppedSnapshotFacts } from "./windows-command-copy";
import { requireWindowsOwnedCommandParent, refreshWindowsOwnedCommandParent, requireWindowsOwnedCommandParentCurrent,
  type WindowsOwnedCommandParentRef, type WindowsOwnedCommandParentFacts } from "./windows-coding-resources";

export interface WindowsCodingCopyReviewInput {
  binding: CodingExportBinding;
  store: WindowsCodingArtifactStore;
  /** Exact same-store source identity captured before a predecessor review was read. Never a new path grant. */
  sourceBoundary?: CodingArtifactSourceRef;
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
  /** Only a host-verified complete prior review may seed a fresh copy. Never a preview, path or SDK conversation. */
  continuation?: CodingWorkspaceContinuation;
  /** Resource-issued owned storage only; source/canonical protection remains the full original set. */
  commandParent?: WindowsOwnedCommandParentRef;
}
export interface WindowsCodingTreeEntry { path: string; handle: WindowsCodingHandle; info: WindowsCodingInfo }
export interface WindowsCodingTree {
  api: WindowsCodingNative; root: WindowsCodingHandle; entries: ReadonlyMap<string, WindowsCodingTreeEntry>; limits: Readonly<ScopedCodingFileLimits>;
  check(): void;
  release(handle: WindowsCodingHandle): void;
  /** Record a positively applied broker mutation before any subsequent cancellation guard can throw. */
  noteMutationApplied(): void;
}
declare const inputBrand: unique symbol;
export interface WindowsCodingCommandInputRef { readonly scope: "canonical-command-input"; readonly [inputBrand]: true }
declare const receiverBrand: unique symbol;
export interface WindowsCodingCommandReceiverRef { readonly scope: "canonical-command-receiver"; readonly [receiverBrand]: true }
export interface WindowsCodingCommandInputData {
  readonly parent: string; readonly protectedPaths: readonly string[]; readonly entries: readonly CodingExportEntry[];
  readonly limits: Readonly<ScopedCodingFileLimits>; readonly privacyScope: CodingPrivacyScope; readonly signal: AbortSignal;
  current(): boolean; reviewCurrent(): boolean;
  readonly commandParent?: WindowsCodingCommandParentRef;
}
declare const nativeParentBrand: unique symbol;
export interface WindowsCodingCommandParentRef { readonly scope: "canonical-command-parent"; readonly [nativeParentBrand]: true }
interface CommandParent {
  input: WindowsCodingCommandInputRef; phase: "ready" | "checking" | "checked" | "refreshed" | "used" | "failed";
  intake?: WindowsCommandTransferIntakeRef;
  inspect(): Readonly<WindowsOwnedCommandParentFacts>; refresh(): Readonly<WindowsOwnedCommandParentFacts>; commit(): void;
}
const nativeParents = new WeakMap<object, CommandParent>();
/** The actual native owner inspects before its protected-root loop. Caller records cannot register an exception. */
export function inspectWindowsCodingCommandParent(ref: WindowsCodingCommandParentRef, parent: string, protectedPaths: readonly string[], intake: WindowsCommandTransferIntakeRef): Readonly<WindowsOwnedCommandParentFacts> {
  const value = ref && typeof ref === "object" ? nativeParents.get(ref) : undefined;
  if (!value || value.phase !== "ready") throw new ScopedCodingFileError("boundary");
  value.phase = "checking";
  try {
    const input = commandInputs.get(value.input);
    if (!input || input.state !== "taken" || input.intake !== intake || input.data.commandParent !== ref || input.data.parent !== parent ||
        input.data.protectedPaths.length !== protectedPaths.length || input.data.protectedPaths.some((path, index) => path !== protectedPaths[index])) throw new ScopedCodingFileError("boundary");
    input.module.requireWindowsCommandInputProducerPreparing(value.input, intake); value.intake = intake;
    input.checkWork(); const facts = value.inspect(); input.checkWork(); value.phase = "checked"; return facts;
  } catch (error) { value.phase = "failed"; throw error; }
}
/** Callback-free one-use commit, immediately before the native factory's first fresh admission. */
export function consumeWindowsCodingCommandParent(ref: WindowsCodingCommandParentRef): void {
  const value = ref && typeof ref === "object" ? nativeParents.get(ref) : undefined;
  if (!value || value.phase !== "refreshed") throw new ScopedCodingFileError("boundary");
  try { value.commit(); value.phase = "used"; }
  catch (error) { value.phase = "failed"; throw error; }
}
/** After the last host admission callback, recheck owned storage without another host callback. */
export function refreshWindowsCodingCommandParent(ref: WindowsCodingCommandParentRef, intake: WindowsCommandTransferIntakeRef): Readonly<WindowsOwnedCommandParentFacts> {
  const value = ref && typeof ref === "object" ? nativeParents.get(ref) : undefined;
  if (!value || value.phase !== "checked" || value.intake !== intake) throw new ScopedCodingFileError("boundary"); value.phase = "checking";
  try { value.commit(); const facts = value.refresh(); value.commit(); value.phase = "refreshed"; return facts; }
  catch (error) { value.phase = "failed"; throw error; }
}
interface CommandInput {
  module: typeof import("./windows-command-copy"); state: "ready" | "validating" | "taken";
  owner: WindowsCodingCopy; revision: bigint; entries?: readonly CodingExportEntry[]; intake?: WindowsCommandTransferIntakeRef;
  data: Omit<WindowsCodingCommandInputData, "entries">; checkWork(): void; checkRecipient(): void;
}
const commandInputs = new WeakMap<object, CommandInput>(), commandReceivers = new WeakMap<object, WindowsCodingCopy>();
/** Only the exact initializing command-copy owner may consume a complete canonical capture. */
export function takeWindowsCodingCommandInput(ref: WindowsCodingCommandInputRef, intake: WindowsCommandTransferIntakeRef): WindowsCodingCommandInputData {
  if (!ref || typeof ref !== "object") throw new ScopedCodingFileError("boundary");
  const input = commandInputs.get(ref); if (!input || input.state !== "ready" || input.intake || !input.entries) throw new ScopedCodingFileError("boundary");
  const entries = input.entries; input.state = "validating";
  try {
    input.module.requireWindowsCommandTransferIntake(intake); input.checkWork(); input.checkRecipient();
    const data = Object.freeze({ ...input.data, entries });
    input.intake = intake; input.state = "taken"; input.entries = undefined;
    return data;
  } finally { if (input.state === "validating") input.state = "ready"; }
}
/** Cleanup authenticates only an exact private receiver; it never grants bytes or publication authority. */
export function requireWindowsCodingCommandReceiverForCleanup(ref: WindowsCodingCommandReceiverRef, inputRef: WindowsCodingCommandInputRef): void {
  if (!ref || typeof ref !== "object" || !inputRef || typeof inputRef !== "object") throw new ScopedCodingFileError("boundary");
  const input = commandInputs.get(inputRef);
  if (!input || input.state !== "taken" || !input.intake || commandReceivers.get(ref) !== input.owner) throw new ScopedCodingFileError("boundary");
}
/** A stolen/serialized snapshot cannot choose a receiver or import into a different canonical revision. */
export function requireWindowsCodingCommandReceiver(ref: WindowsCodingCommandReceiverRef, inputRef: WindowsCodingCommandInputRef): void {
  requireWindowsCodingCommandReceiverForCleanup(ref, inputRef);
  commandInputs.get(inputRef)!.checkRecipient();
}

declare const adoptionBrand: unique symbol;
export interface WindowsCodingCommandAdoptionRef { readonly scope: "canonical-command-adoption"; readonly [adoptionBrand]: true }
interface CommandAdoption {
  owner: WindowsCodingCopy; input: WindowsCodingCommandInputRef; facts: Readonly<WindowsCommandStoppedSnapshotFacts>;
  entries: readonly CodingExportEntry[]; phase: "ready" | "retiring" | "used" | "failed"; busy: boolean;
  stage?: import("./windows-coding-command-transfer").WindowsCodingCommandStage;
}
const commandAdoptions = new WeakMap<object, CommandAdoption>();
/** Unknown native ownership survives even if a caller drops its copy/reference. */
const retainedCommandTransfers: unknown[] = [];

interface CapturedSource { handle: WindowsCodingHandle; info?: WindowsCodingInfo }
interface FileLease { epoch: number; active: boolean }
interface CanonicalRoot { handle: WindowsCodingHandle; identity: WindowsCodingInfo }
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
  readonly limits: Readonly<ScopedCodingFileLimits>;
  readonly signal: AbortSignal;
  readonly excludedRoots: readonly CodingExcludedRoot[];
  #api: WindowsCodingNative; #active: CanonicalRoot; #base: WindowsCodingPin;
  #contentRevision = 0n;
  #commandInput?: WindowsCodingCommandInputRef;
  #commandReceiver: WindowsCodingCommandReceiverRef;
  #commandAdoption?: CommandAdoption;
  #claimingCommand = false;
  #releasingCommand = false;
  get directory(): string { return this.#active.identity.finalPath; }
  /** Host-only revision; opening or finishing a read lease does not change content. */
  get contentRevision(): bigint { return this.#contentRevision; }
  get #root(): WindowsCodingHandle { return this.#active.handle; }
  get #identity(): WindowsCodingInfo { return this.#active.identity; }
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
    this.#commandReceiver = Object.freeze({ scope: "canonical-command-receiver" as const }) as WindowsCodingCommandReceiverRef; commandReceivers.set(this.#commandReceiver, this);
    this.#privacyScope = privacyScope; this.#input = { ...input, protectedPaths: [...input.protectedPaths] }; this.#api = api; this.#base = base; this.#active = { handle: root, identity: api.info(root) }; this.limits = limits;
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
    const { continuation, ...capturedInput } = input;
    if (continuation && (!review || !review.sourceBoundary)) throw new ScopedCodingFileError("boundary");
    input = { ...capturedInput, protectedPaths: [...input.protectedPaths], current: capturedInput.current.bind(capturedInput), scope: { excludeRoots: exclusions }, review };
    const privacyScope = captureCodingPrivacyScope(), limits = windowsCodingLimits({ ...(review ? REVIEW_LIMITS : {}), ...input.limits });
    if (review && Object.entries(REVIEW_LIMITS).some(([key, value]) => limits[key as keyof ScopedCodingFileLimits] > value)) throw new ScopedCodingFileError("limit");
    const check = () => { try { assertCodingPrivacyScope(privacyScope); if (input.signal.aborted || input.current() !== true) throw new ScopedCodingFileError("cancelled"); } catch (error) { throw windowsCodingSafeError(error); } };
    const reviewCurrent = () => {
      check();
      try { if (review && review.current() !== true) throw new ScopedCodingFileError("cancelled"); }
      catch { throw new ScopedCodingFileError("cancelled"); }
      check();
    };
    // This function clones complete trees synchronously, before source provenance or any other work can await.
    const seed = continuation ? prepareWindowsCodingContinuation(continuation, review!.binding, exclusions, privacyScope, input.signal, reviewCurrent, limits) : undefined;
    try {
      reviewCurrent();
      // Capture provenance before the copy opens. A later path cannot mint authority for a renamed original.
      const sourceBoundary = review ? await review.store.sourceBoundary(input.source, reviewCurrent, review.sourceBoundary) : null;
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
        const pending = seed ? materializeWindowsCodingContinuation(seed, api, copy.#root, reviewCurrent).then(materialized => {
          // Retain transferred baseline ownership before any subsequent formatter validation can fail.
          copy!.#baseline = materialized.baseline; copy!.#manifest = materialized.scope;
          createCodingReviewExport({ binding: review!.binding, baseline: copy!.#baseline, proposed: copy!.#baseline, scope: copy!.#manifest });
        }) : copy.#capture(source.handle, sourceInfo, protectedInfo, { destination: copy.#root, retain: !!review, check: reviewCurrent, signal: copy.signal }).then(captured => {
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
    } finally { seed?.dispose(); }
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
        const relative = prefix ? `${prefix}/${listed.name}` : listed.name;
        try { windowsCodingRelative(relative, false); } catch { throw new ScopedCodingFileError("unsupported"); }
        if (relative.split("/").length > this.limits.depth) throw new ScopedCodingFileError("limit");
        const key = windowsCodingFold(relative); if (aliases.has(key)) throw new ScopedCodingFileError("unsupported"); aliases.add(key);
        const excluded = !prefix && windowsCodingExcludedRoot(relative, this.excludedRoots);
        if (excluded) {
          omitted.push({ path: excluded, kind: listed.attributes & 0x400 ? "link" : listed.attributes & 0x10 ? "directory" : "file" }); continue;
        }
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
      this.#checkRoot(); if (this.#commandInput) throw new ScopedCodingFileError("boundary"); const lease: FileLease = { epoch: this.#epoch, active: true };
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
  /** Captures the complete private working tree and reserves it against any overlapping broker mutation. */
  captureCommandInput(): Promise<WindowsCodingCommandInputRef> {
    if (this.#lease.getStore() !== undefined) return Promise.reject(new ScopedCodingFileError("boundary"));
    const pending = this.#tail.then(async () => {
      this.#checkRoot(); if (this.#commandInput || !this.#review || this.#reviewStarted || this.#reviewClosing) throw new ScopedCodingFileError("boundary");
      const lease: FileLease = { epoch: this.#epoch, active: true };
      return this.#lease.run(lease, async () => {
        let entries: CodingExportEntry[] | undefined;
        try {
          const module = await import("./windows-command-copy"); this.#checkRoot();
          entries = await this.#detachedEntries(this.#checkRoot.bind(this), true, this.signal); this.#checkRoot();
          if (lease.epoch !== this.#epoch) throw new ScopedCodingFileError("cancelled");
          const revision = this.#contentRevision, ref = Object.freeze({ scope: "canonical-command-input" as const }) as WindowsCodingCommandInputRef;
          const parent = this.#input.commandParent ? this.#captureCommandParent(ref, revision, this.#input.commandParent) : undefined;
          const checkRecipient = () => {
            assertCodingPrivacyScope(this.#privacyScope);
            if (this.#failure !== undefined) throw windowsCodingSafeError(this.#failure);
            if (this.#closed || this.#reviewRevoked || this.#reviewClosing || this.#reviewStarted || this.#commandInput !== ref || this.#contentRevision !== revision) throw new ScopedCodingFileError("boundary");
            this.#transferPublicationCheck();
          };
          const data: CommandInput = { module, state: "ready", owner: this, revision, entries, checkRecipient, checkWork: () => { checkRecipient(); this.#checkRoot(); },
            data: { parent: this.#input.privateBase, protectedPaths: Object.freeze([...this.#input.protectedPaths]), limits: this.limits, privacyScope: this.#privacyScope, signal: this.signal,
              ...(parent ? { commandParent: parent } : {}),
              current: () => { try { checkRecipient(); this.#checkRoot(); return true; } catch (error) { if (cleanupFailure(error)) throw error; return false; } },
              reviewCurrent: () => { try { checkRecipient(); this.#transferPublicationCheck(); return true; } catch (error) { if (cleanupFailure(error)) throw error; return false; } } } };
          commandInputs.set(ref, data); this.#commandInput = ref; entries = undefined; this.#epoch++;
          return ref;
        } finally { clearWindowsCodingTree(entries ? { entries } : undefined); lease.active = false; }
      });
    });
    this.#tail = pending.then(() => undefined, () => undefined);
    return pending.catch(error => { if (cleanupFailure(error)) { this.#failure = error; this.#retire(); } throw windowsCodingSafeError(error); });
  }
  #captureCommandParent(inputRef: WindowsCodingCommandInputRef, revision: bigint, resource: WindowsOwnedCommandParentRef): WindowsCodingCommandParentRef {
    const checkBase = (facts: Readonly<WindowsOwnedCommandParentFacts>) => {
      if (facts.parent !== this.#input.privateBase || facts.protectedPaths.length !== this.#input.protectedPaths.length ||
          facts.protectedPaths.some((path, index) => path !== this.#input.protectedPaths[index]) ||
          !windowsCodingSame(facts.copies, this.#api.info(this.#base.handle), false)) {
        this.#failure = retireWindowsCodingNative(); this.#retire(); throw this.#failure;
      }
      return facts;
    };
    const inspect = () => { this.#checkRoot(); const facts = checkBase(requireWindowsOwnedCommandParent(resource)); this.#checkRoot(); return facts; };
    inspect();
    const ref = Object.freeze({ scope: "canonical-command-parent" as const }) as WindowsCodingCommandParentRef;
    nativeParents.set(ref, { input: inputRef, phase: "ready", inspect, refresh: () => checkBase(refreshWindowsOwnedCommandParent(resource)), commit: () => {
      const input = commandInputs.get(inputRef);
      if (this.#failure !== undefined) throw this.#failure;
      if (this.#closed || this.#retired || this.signal.aborted || this.#contentRevision !== revision || this.#commandInput !== inputRef ||
          !input || input.state !== "taken" || input.owner !== this || input.data.commandParent !== ref) throw new ScopedCodingFileError("boundary");
      const parent = nativeParents.get(ref);
      if (!parent?.intake || parent.intake !== input.intake) throw new ScopedCodingFileError("boundary");
      input.module.requireWindowsCommandInputProducerPreparing(inputRef, parent.intake);
      assertCodingPrivacyScope(this.#privacyScope); requireWindowsOwnedCommandParentCurrent(resource);
    } });
    return ref;
  }
  /** Private stopped capture may continue under publication authority; it never grants execution or export. */
  #transferPublicationCheck = (): void => {
    assertCodingPrivacyScope(this.#privacyScope);
    if (this.#failure !== undefined) throw windowsCodingSafeError(this.#failure);
    if (!this.#review || this.#reviewRevoked || this.#reviewClosing || this.#reviewStarted || this.#closed) throw new ScopedCodingFileError("cancelled");
    try { if (this.#review.current() !== true) { this.#reviewRevoked = true; throw new ScopedCodingFileError("cancelled"); } }
    catch (error) { this.#reviewRevoked = true; throw windowsCodingSafeError(error); }
    assertCodingPrivacyScope(this.#privacyScope);
    if (this.#failure !== undefined) throw windowsCodingSafeError(this.#failure);
    if (this.#reviewRevoked || this.#reviewClosing || this.#reviewStarted || this.#closed) throw new ScopedCodingFileError("cancelled");
  };

  /** Review only: release an untouched capture or the genuine positively closed owner that never issued a run. */
  releaseUnstartedForReview(): Promise<void> {
    if (this.#lease.getStore() !== undefined || this.#claimingCommand || this.#releasingCommand || this.#commandAdoption) return Promise.reject(new ScopedCodingFileError("boundary"));
    this.#releasingCommand = true;
    const pending = this.#tail.then(() => {
      const ref = this.#commandInput, input = ref ? commandInputs.get(ref) : undefined;
      if (!ref || !input || input.owner !== this || this.#commandAdoption || !this.#retired) throw new ScopedCodingFileError("boundary");
      const unused = input.state === "ready" && !input.intake ? input.entries : undefined;
      if (!unused && input.state !== "taken" || commandReceivers.get(this.#commandReceiver) !== this) throw new ScopedCodingFileError("boundary");
      // A genuinely untouched capture has no producer. A taken input needs its exact positively closed no-run owner.
      // Native uncertainty must reject before any canonical root query or publication callback.
      if (!unused) input.module.requireWindowsCommandUnstartedInput(ref);
      input.checkRecipient(); this.#reviewCheck(); input.checkRecipient();
      assertCodingPrivacyScope(this.#privacyScope);
      if (this.#failure !== undefined) throw windowsCodingSafeError(this.#failure);
      if (!this.#retired || this.#closed || this.#reviewClosing || this.#reviewRevoked || this.#reviewStarted || this.#commandInput !== ref || input.revision !== this.#contentRevision) throw new ScopedCodingFileError("cancelled");
      if (unused) {
        if (input.state !== "ready" || input.intake || input.entries !== unused) throw new ScopedCodingFileError("boundary");
        clearWindowsCodingTree({ entries: unused }); input.entries = undefined; commandInputs.delete(ref);
      } else input.module.releaseWindowsCommandUnstartedInput(ref, this.#commandReceiver);
      // No callback or await follows the one-shot genuine claim. Old inputs cannot create execution later.
      this.#commandInput = undefined; this.#epoch++;
    });
    this.#tail = pending.then(() => undefined, () => undefined);
    return pending.catch(error => {
      if (cleanupFailure(error)) { this.#failure = error; this.#retire(); retainedCommandTransfers.push({ owner: this }); }
      throw windowsCodingSafeError(error);
    }).finally(() => { this.#releasingCommand = false; });
  }

  /** Synchronous one-shot claim. A snapshot chooses neither its receiver nor its content revision. */
  acceptStoppedCommand(snapshot: WindowsCommandStoppedSnapshotRef): WindowsCodingCommandAdoptionRef {
    if (this.#claimingCommand || this.#commandAdoption || !this.#commandInput || this.#lease.getStore() !== undefined) throw new ScopedCodingFileError("boundary");
    const inputRef = this.#commandInput, input = commandInputs.get(inputRef);
    if (!input || input.owner !== this || input.state !== "taken") throw new ScopedCodingFileError("boundary");
    this.#claimingCommand = true;
    try {
      input.checkRecipient(); const facts = input.module.readWindowsCommandStoppedSnapshot(snapshot);
      if (facts.input !== inputRef) throw new ScopedCodingFileError("boundary");
      input.checkRecipient();
      const ref = Object.freeze({ scope: "canonical-command-adoption" as const }) as WindowsCodingCommandAdoptionRef;
      const state: CommandAdoption = { owner: this, input: inputRef, facts, entries: [], phase: "ready", busy: false };
      const moved = input.module.takeWindowsCommandStoppedSnapshot(snapshot, this.#commandReceiver);
      // No callback or await separates the byte move from our exact ownership ledger.
      state.entries = moved.entries; this.#commandAdoption = state; commandAdoptions.set(ref, state);
      return ref;
    } finally { this.#claimingCommand = false; }
  }
  /** Natural completion can replace the private root; a nonzero exit still remains a failed check upstream. */
  applyStoppedCommand(ref: WindowsCodingCommandAdoptionRef): Promise<void> { return this.#applyCommand(ref, false); }
  /** Separate publication authority after permanent task retirement; never reopens execution or the broker. */
  applyStoppedCommandForReview(ref: WindowsCodingCommandAdoptionRef): Promise<void> { return this.#applyCommand(ref, true); }
  #fenceCommandTransfer(state: CommandAdoption): never {
    state.phase = "failed"; this.#failure = retireWindowsCodingNative(); this.#retire();
    retainedCommandTransfers.push({ owner: this, state }); throw windowsCodingSafeError(this.#failure);
  }
  #stageRoot(state: CommandAdoption): CanonicalRoot {
    if (!state.stage?.identity || state.stage.children.some(child => !child.closed)) return this.#fenceCommandTransfer(state);
    return { handle: state.stage.handle, identity: state.stage.identity };
  }
  #ownedRoot(root: CanonicalRoot): void {
    this.#api.assertPrivate(root.handle);
    if (!windowsCodingSame(root.identity, this.#api.info(root.handle), false)) throw new ScopedCodingFileError("boundary");
  }
  async #discardCommandStage(state: CommandAdoption): Promise<void> {
    if (!state.stage) return;
    const root = this.#stageRoot(state), owned = () => this.#ownedRoot(root);
    try {
      await this.#tree(async tree => {
        for (const entry of [...tree.entries.values()].sort((a, b) => b.path.split("/").length - a.path.split("/").length)) {
          owned(); tree.api.remove(entry.handle); tree.release(entry.handle);
        }
      }, false, owned, root);
      owned(); this.#api.remove(root.handle); this.#api.close(root.handle); state.stage = undefined;
    } catch { this.#fenceCommandTransfer(state); }
  }
  #applyCommand(ref: WindowsCodingCommandAdoptionRef, review: boolean): Promise<void> {
    const state = ref && typeof ref === "object" ? commandAdoptions.get(ref) : undefined;
    if (!state || state.owner !== this || state !== this.#commandAdoption || state.phase !== "ready" || state.busy || this.#lease.getStore() !== undefined) return Promise.reject(new ScopedCodingFileError("boundary"));
    state.busy = true;
    const pending = this.#tail.then(async () => {
      const input = commandInputs.get(state.input);
      const settled = () => {
        // Recheck private admission after the callbacks/queries above, without another callout.
        assertCodingPrivacyScope(this.#privacyScope);
        if (this.#failure !== undefined) throw windowsCodingSafeError(this.#failure);
        if (this.#closed || this.#reviewClosing || this.#reviewRevoked || this.#reviewStarted || this.#commandInput !== state.input ||
            !input || input.revision !== this.#contentRevision) throw new ScopedCodingFileError("cancelled");
        if (!review && (this.#retired || this.signal.aborted)) throw new ScopedCodingFileError("cancelled");
      };
      const check = () => {
        if (state.phase !== "ready" || !input || this.#commandInput !== state.input) throw new ScopedCodingFileError("boundary");
        input.checkRecipient();
        if (review) {
          if (!this.#retired) throw new ScopedCodingFileError("boundary");
          this.#reviewCheck();
        } else {
          if (state.facts.outcome !== "natural-exit" || !state.facts.outputComplete) { this.#retire(); throw new ScopedCodingFileError("cancelled"); }
          this.#checkRoot();
        }
        settled();
      };
      let admitted = false;
      try {
        // A host may settle its controller and retry known preflight refusals; uncertainty still fences.
        check(); const mechanics = await import("./windows-coding-command-transfer"); check(); admitted = true;
        await this.#discardCommandStage(state); check();
        await mechanics.validateWindowsCodingCommandEntries(state.entries, this.limits, this.excludedRoots, this.#privacyScope, check, review ? undefined : this.signal);
        await mechanics.materializeWindowsCodingCommandStage(this.#api, this.#base.handle, state.entries, check, stage => { state.stage = stage; });
        check(); const nextRoot = this.#stageRoot(state), expected = new Map(state.entries.map(entry => [entry.path, entry]));
        await this.#tree(async tree => {
          if (tree.entries.size !== expected.size) throw new ScopedCodingFileError("conflict");
          for (const entry of tree.entries.values()) {
            check(); const wanted = expected.get(entry.path);
            if (!wanted || wanted.kind !== entry.info.kind || entry.info.attributes & 0x6) throw new ScopedCodingFileError("conflict");
            if (wanted.kind === "file") {
              const bytes = await readWindowsCodingFile(tree.api, entry.handle, entry.info, this.limits.fileBytes, check);
              try { if (hash(bytes) !== hash(wanted.bytes)) throw new ScopedCodingFileError("conflict"); } finally { bytes.fill(0); }
            }
          }
        }, false, check, nextRoot);
        check(); const oldRoot = this.#active;
        const retirementCheck = () => {
          if (state.phase === "used") return;
          if (state.phase === "retiring") { this.#ownedRoot(oldRoot); this.#ownedRoot(nextRoot); }
          else check();
        };
        const beginRetirement = () => {
          if (state.phase !== "ready") return;
          check(); this.#ownedRoot(oldRoot); this.#ownedRoot(nextRoot); check();
          // The first delete follows immediately. Every preflight/callback remains cancellable until this point.
          state.phase = "retiring";
        };
        await this.#tree(async tree => {
          check();
          // From the first old deletion onward, cancellation revokes execution but cannot interrupt owned cleanup.
          for (const entry of [...tree.entries.values()].sort((a, b) => b.path.split("/").length - a.path.split("/").length)) {
            retirementCheck(); tree.api.assertPrivate(entry.handle);
            if (!windowsCodingSame(entry.info, tree.api.info(entry.handle), false)) throw new ScopedCodingFileError("boundary");
            beginRetirement(); tree.api.remove(entry.handle); tree.release(entry.handle);
          }
          retirementCheck(); beginRetirement();
          this.#api.remove(oldRoot.handle); this.#api.close(oldRoot.handle);
          // Positive old-root retirement and ownership commit are one synchronous segment, without callbacks/waits.
          this.#active = nextRoot; this.#contentRevision++; this.#epoch++; state.stage = undefined;
          state.phase = "used"; this.#commandInput = undefined; this.#commandAdoption = undefined;
        }, false, retirementCheck, oldRoot);
        clearWindowsCodingTree({ entries: state.entries }); state.entries = [];
      } catch (caught) {
        // A positively retired privacy generation is ordinary revocation, not unknown native ownership.
        const error = caught instanceof CodingPrivacyScanError && !(caught instanceof CodingPrivacyCleanupError) ? windowsCodingSafeError(caught) : caught;
        if (state.phase === "used") { if (cleanupFailure(error)) this.#fenceCommandTransfer(state); throw windowsCodingSafeError(error); }
        if (state.phase === "retiring" || cleanupFailure(error) || !(error instanceof ScopedCodingFileError)) this.#fenceCommandTransfer(state);
        if (!admitted) throw windowsCodingSafeError(error);
        if (state.stage && (error.code !== "cancelled" || !state.stage.identity || state.stage.children.some(child => !child.closed))) this.#fenceCommandTransfer(state);
        if (error.code !== "cancelled") { state.phase = "failed"; this.#retire(); }
        throw windowsCodingSafeError(error);
      }
    });
    this.#tail = pending.then(() => undefined, () => undefined);
    return pending.finally(() => { state.busy = false; });
  }

  /** Host broker capability only. The returned handles never enter tool results and expire at lease completion. */
  async withTree<T>(operation: (tree: WindowsCodingTree) => Promise<T>): Promise<T> {
    const lease = this.#lease.getStore();
    if (lease === undefined) return this.files(() => this.withTree(operation));
    if (!lease.active || lease.epoch !== this.#epoch) throw new ScopedCodingFileError("cancelled");
    this.#checkRoot(); return this.#tree(operation, true);
  }
  async #tree<T>(operation: (tree: WindowsCodingTree) => Promise<T>, current: boolean, sealedCheck?: () => void, selected: CanonicalRoot = this.#active): Promise<T> {
    const api = this.#api, root = selected.handle, identity = selected.identity, entries = new Map<string, WindowsCodingTreeEntry>(), aliases = new Set<string>(), ids = new Set<string>(), opened = new Set<WindowsCodingHandle>();
    let total = 0;
    const lease = current ? this.#lease.getStore() : undefined;
    const check = () => {
      if (current) { if (!lease?.active || lease.epoch !== this.#epoch) throw new ScopedCodingFileError("cancelled"); this.#checkRoot(); }
      else sealedCheck?.();
    };
    const noteMutationApplied = () => {
      // A positive native mutation may synchronously retire execution. Still advance its revision before returning.
      if (!current || !lease?.active) throw new ScopedCodingFileError("boundary");
      this.#contentRevision++;
    };
    const release = (handle: WindowsCodingHandle) => { if (!opened.delete(handle)) throw new ScopedCodingFileError("boundary"); api.close(handle); };
    if (!windowsCodingSame(identity, api.info(root), false)) throw new ScopedCodingFileError("boundary");
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
        if (listed.id !== info.id || info.kind !== kind || info.volume !== identity.volume || !windowsCodingWithin(info.finalPath, identity.finalPath) || ids.has(info.id) ||
            kind === "file" && info.links !== 1) throw new ScopedCodingFileError("unsupported");
        ids.add(info.id); if (kind === "file" && (info.size > this.limits.fileBytes || (total += info.size) > this.limits.workspaceBytes)) throw new ScopedCodingFileError("limit");
        entries.set(relative, { path: relative, handle, info }); if (kind === "directory") await walk(handle, relative, depth + 1);
        if (entries.size % 16 === 0) { await windowsCodingYield(); check(); }
      }
      if (!windowsCodingSame(before, api.info(directory))) throw new ScopedCodingFileError("conflict");
    };
    let result: T | undefined, problem: unknown, failed = false;
    try { await walk(root, "", 0); check(); result = await operation({ api, root: root, entries, limits: this.limits, check, release, noteMutationApplied }); check(); }
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
  async #detachedEntries(check: () => void, current: boolean, signal?: AbortSignal): Promise<CodingExportEntry[]> {
    const entries: CodingExportEntry[] = [], scanner = new CodingPrivacyScanner({ scope: this.#privacyScope, signal });
    try {
      await this.#tree(async tree => {
        for (const entry of tree.entries.values()) {
          check();
          if (entry.info.attributes & 0x6) throw new ScopedCodingFileError("privacy");
          if (windowsCodingExcludedRoot(entry.path, this.excludedRoots)) throw new ScopedCodingFileError("boundary");
          if (entry.info.kind === "directory") {
            if (codingWorkspaceFilePathProblem(entry.path)) throw new ScopedCodingFileError("secret");
            entries.push({ path: entry.path, kind: "directory" });
          } else {
            const bytes = await readWindowsCodingFile(tree.api, entry.handle, entry.info, this.limits.fileBytes, check);
            let retained = false;
            try {
              if (await codingWorkspaceFileProblemAsync(entry.path, bytes, scanner, { signal, current: () => { check(); return true; } })) throw new ScopedCodingFileError("secret");
              check(); entries.push({ path: entry.path, kind: "file", bytes, executable: false }); retained = true;
            } finally { if (!retained) bytes.fill(0); }
          }
        }
      }, current, check);
      await scanner.close(); check();
      return entries;
    } catch (error) {
      clearWindowsCodingTree({ entries });
      await scanner.close();
      throw error;
    }
  }
  async #proposed(): Promise<CodingExportTree> {
    return { binding: this.#review!.binding, entries: await this.#detachedEntries(this.#reviewCheck, false) };
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
    if (this.#lease.getStore() !== undefined || store !== this.#review.store || this.#reviewStarted || this.#commandInput || this.#claimingCommand) return Promise.reject(new ScopedCodingFileError("boundary"));
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
    this.#retire();
    if (this.#lease.getStore() !== undefined || this.#claimingCommand) return Promise.reject(new ScopedCodingFileError("boundary"));
    if (cleanupFailure(this.#failure)) return Promise.reject(windowsCodingSafeError(this.#failure));
    // A live/unknown command producer still owns bytes and native objects derived from this exact input.
    // Stop is requested above, but only its real positive producer closure permits canonical cleanup.
    if (this.#commandInput) {
      const input = commandInputs.get(this.#commandInput);
      try {
        if (!input || input.state === "validating") throw new ScopedCodingFileError("boundary");
        if (input.state === "taken") input.module.requireWindowsCommandInputProducerClosed(this.#commandInput);
      } catch (error) { return Promise.reject(windowsCodingSafeError(error)); }
    }
    this.#reviewClosing = true;
    this.#closing ??= this.#tail.then(async () => {
      if (this.#closed) return;
      if (cleanupFailure(this.#failure)) throw windowsCodingSafeError(this.#failure);
      if (this.#commandInput) {
        const input = commandInputs.get(this.#commandInput);
        if (input?.state === "taken") input.module.discardWindowsCommandInputSnapshot(this.#commandInput, this.#commandReceiver);
      }
      if (this.#commandAdoption) {
        await this.#discardCommandStage(this.#commandAdoption);
        clearWindowsCodingTree({ entries: this.#commandAdoption.entries }); this.#commandAdoption.entries = []; this.#commandAdoption.phase = "failed"; this.#commandAdoption = undefined;
      }
      if (this.#commandInput) {
        const input = commandInputs.get(this.#commandInput);
        if (input?.entries) { clearWindowsCodingTree({ entries: input.entries }); input.entries = undefined; }
        commandInputs.delete(this.#commandInput); this.#commandInput = undefined;
      }
      clearWindowsCodingTree(this.#baseline); this.#baseline = undefined;
      if (this.#producer?.owned) await this.#producer.discard();
      this.#producer = undefined;
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
      retainedCommandTransfers.push({ owner: this, state: this.#commandAdoption });
      throw windowsCodingSafeError(this.#failure);
    }); return this.#closing;
  }
}
