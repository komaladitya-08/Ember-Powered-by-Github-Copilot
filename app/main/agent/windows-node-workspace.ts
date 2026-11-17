/** Unregistered Windows Node coordinator. The existing platform selector remains files-only. */
import { AsyncLocalStorage, AsyncResource } from "node:async_hooks";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import type { ShellId } from "../commands/types";
import { copyNodeArgv } from "../commands/node-invocation";
import type { CodingArtifactSourceRef } from "./coding-artifact-store";
import { CodingArtifactCleanupError, CodingResultRegistryError } from "./coding-artifact-store";
import type { CodingCommandWorkspace, CodingFileBroker, CodingWorkspaceReview } from "./coding-platform";
import { ScopedCodingFileError } from "./coding-platform";
import { CodingPrivacyCleanupError } from "./coding-privacy-scanner";
import type { ObservedCodingCommand } from "./isolated-coding-command-runner";
import type { WindowsFileOnlyWorkspaceInput } from "./windows-file-only-workspace";
import { WindowsCodingCopy, type WindowsCodingCommandAdoptionRef, type WindowsCodingCommandInputRef } from "./windows-coding-copy";
import { WindowsScopedCodingFiles } from "./windows-scoped-coding-files";
import { WindowsCodingCleanupError, retireWindowsCodingNative } from "./windows-coding-native";
import { windowsCodingFold, windowsCodingSafeError } from "./windows-coding-policy";
import { WindowsRootOnlyCommandCopy, requireWindowsCommandInputProducerClosed, requireWindowsCommandRootOnlyCompletedOutput,
  type WindowsCommandRootOnlyRunRef } from "./windows-command-copy";
import { createFreshWindowsCommandCreatorProfile, windowsCommandCreatorProfile, closeWindowsCommandCreatorProfile,
  WindowsCommandCreatorProfileCleanupError, type WindowsCommandCreatorProfileRef } from "./windows-command-creator-profile";
import { requireWindowsCommandOutputLaunch, requireWindowsCommandOutputClosed, type WindowsCommandOutputLaunchRef } from "./windows-command-output";
import type { WindowsCodingReviewOutput } from "./windows-coding-review";

type Assets = Awaited<ReturnType<typeof import("./windows-node-toolchain-native").createWindowsNodeToolchainAssets>>;
export interface WindowsNodeWorkspaceInput extends WindowsFileOnlyWorkspaceInput {
  /** Trusted installed resources and fresh private asset parent; never model tool arguments. */
  resourcesPath: string; assetsParent: string;
}
export class WindowsNodeWorkspaceCleanupError extends WindowsCodingCleanupError {
  constructor() { super(); this.name = "WindowsNodeWorkspaceCleanupError"; }
}
interface ActiveNode {
  input: WindowsCodingCommandInputRef; command?: WindowsRootOnlyCommandCopy;
  run?: WindowsCommandRootOnlyRunRef; launch?: WindowsCommandOutputLaunchRef; removeAbort?: () => void;
}
const owners = new Set<WindowsNodeWorkspace>();
let terminal: WindowsNodeWorkspaceCleanupError | undefined;
const uncertain = (error: unknown) => error instanceof WindowsCodingCleanupError || error instanceof CodingPrivacyCleanupError ||
  error instanceof CodingArtifactCleanupError || error instanceof WindowsCommandCreatorProfileCleanupError;
const MAX_RUN_MS = 20 * 60_000;

export class WindowsNodeWorkspace implements CodingCommandWorkspace {
  readonly executionRoot = "/work";
  #input: WindowsNodeWorkspaceInput; #signal: AbortSignal; #lifetime = new AbortController();
  #copy?: WindowsCodingCopy; #profile?: WindowsCommandCreatorProfileRef; #assets?: Assets;
  #ready = false; #retired = false; #closed = false; #epoch = 0;
  #lease = new AsyncLocalStorage<boolean>(); #neutral = new AsyncResource("EmberWindowsNodeWorkspaceStop");
  #tail: Promise<void> = Promise.resolve(); #stopping?: Promise<void>; #active?: ActiveNode;
  #pendingAdoption?: WindowsCodingCommandAdoptionRef; #unstarted = false;
  #openingBroker?: Promise<WindowsScopedCodingFiles>; #closingBroker?: Promise<void>;
  #sealed = false; #sealing?: Promise<void>; #executionClosed = false;
  #closing?: Promise<void>; #exporting?: Promise<WindowsCodingReviewOutput>;
  #output?: WindowsCodingReviewOutput; #sourceBoundary?: CodingArtifactSourceRef;
  #transferred = false; #discardStarted = false; #failure?: WindowsNodeWorkspaceCleanupError;
  #abort: () => void;

  private constructor(input: WindowsNodeWorkspaceInput) {
    const { continuation: _continuation, ...captured } = input;
    this.#input = { ...captured, protectedPaths: [...captured.protectedPaths], limits: { ...captured.limits }, current: captured.current.bind(captured),
      review: { ...captured.review, binding: { ...captured.review.binding }, current: captured.review.current.bind(captured.review) } };
    this.#signal = AbortSignal.any([input.signal, this.#lifetime.signal]);
    this.#abort = () => { void this.stop().catch(() => undefined); };
    this.#signal.addEventListener("abort", this.#abort, { once: true });
  }
  static async create(input: WindowsNodeWorkspaceInput): Promise<WindowsNodeWorkspace> {
    if (terminal) throw terminal;
    if (HOST_PLATFORM !== "win32" || HOST_ARCH !== "x64" || !input?.review || !(input.signal instanceof AbortSignal) || typeof input.current !== "function" ||
        !Array.isArray(input.protectedPaths) || typeof input.resourcesPath !== "string" || !input.resourcesPath || typeof input.assetsParent !== "string" || !input.assetsParent ||
        typeof input.reviewBase !== "string" || !input.reviewBase) throw new ScopedCodingFileError("unavailable");
    const owner = new WindowsNodeWorkspace(input); owners.add(owner);
    try {
      // Continuation bytes are cloned by the real canonical factory before its first await.
      owner.#copy = await WindowsCodingCopy.create({ ...owner.#input, ...(input.continuation ? { continuation: input.continuation } : {}),
        signal: owner.#signal, current: owner.#current, review: { ...owner.#input.review, current: owner.#reviewCurrent, controllerClosed: () => owner.#sealed } });
      owner.#check(); owner.#profile = createFreshWindowsCommandCreatorProfile(); owner.#check();
      const native = await import("./windows-node-toolchain-native"); owner.#check();
      owner.#assets = await native.createWindowsNodeToolchainAssets({ resourcesPath: owner.#input.resourcesPath, privateParent: owner.#input.assetsParent,
        profile: owner.#profile, signal: owner.#copy.signal, current: owner.#current });
      owner.#check(); owner.#ready = true; return owner;
    } catch (error) {
      if (uncertain(error)) throw owner.#poison();
      try { await owner.close(); } catch { throw owner.#poison(); }
      throw windowsCodingSafeError(error);
    }
  }
  /** Private-field access is also the adapter's genuine-instance check; no host executable fallback exists. */
  get nodeAvailable(): boolean { return this.#ready && !!this.#assets && !!this.#profile && !this.#retired && !this.#closing && !this.#failure && !terminal && !this.#copy?.signal.aborted; }
  get signal(): AbortSignal { return this.#copy?.signal ?? this.#signal; }
  get excludedRoots(): readonly string[] { return this.#copy?.excludedRoots ?? []; }
  get sourceBoundary(): CodingArtifactSourceRef {
    if (!this.#sourceBoundary || this.#failure || terminal) throw this.#failure ?? terminal ?? new CodingResultRegistryError("invalid");
    return this.#sourceBoundary;
  }
  #current = (): boolean => {
    this.#usable();
    if (this.#retired || this.#closing || this.#closed || this.#signal.aborted || this.#copy?.signal.aborted) return false;
    let admitted = false;
    try { admitted = this.#input.current() === true; }
    catch (error) { if (uncertain(error)) throw this.#poison(); /* Ordinary authority refusal revokes admission. */ }
    this.#usable();
    return admitted && !this.#retired && !this.#closing && !this.#closed && !this.#signal.aborted && !this.#copy?.signal.aborted;
  };
  #reviewCurrent = (): boolean => {
    if (terminal || this.#failure) throw this.#failure ?? terminal;
    if (this.#closed) return false;
    let current: boolean;
    try { current = this.#input.review.current() === true; }
    catch (error) { if (uncertain(error)) throw this.#poison(); return false; }
    if (terminal || this.#failure) throw this.#failure ?? terminal;
    return current && !this.#closed;
  };
  #usable(): void { if (terminal || this.#failure) throw this.#failure ?? terminal; }
  #check(): void {
    this.#usable(); if (!this.#current()) { void this.stop().catch(() => undefined); throw new ScopedCodingFileError("cancelled"); }
  }
  #poison(): WindowsNodeWorkspaceCleanupError {
    terminal ??= new WindowsNodeWorkspaceCleanupError(); retireWindowsCodingNative();
    for (const owner of owners) {
      owner.#failure = terminal; owner.#ready = false;
      if (!owner.#retired) { owner.#retired = true; owner.#epoch++; }
      owner.#lifetime.abort();
    }
    // The strong owner set retains every native/profile/asset/input/output obligation on unknown shutdown.
    return terminal;
  }
  #queue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.#lease.getStore()) return Promise.reject(new ScopedCodingFileError("boundary"));
    try { this.#check(); } catch (error) { return Promise.reject(error); }
    const epoch = this.#epoch;
    const pending = this.#tail.then(() => {
      this.#check(); if (epoch !== this.#epoch) throw new ScopedCodingFileError("cancelled");
      return this.#lease.run(true, operation);
    });
    this.#tail = pending.then(() => undefined, () => undefined); return pending;
  }
  files<T>(operation: (root: string) => Promise<T>): Promise<T> {
    return this.#queue(() => this.#copy!.files(operation));
  }
  /** This backend advertises no shell and never reinterprets command strings or npm commands. */
  run(_command: string, _cwd: string, _output: (bytes: Uint8Array, stream: "stdout" | "stderr") => void, _signal: AbortSignal, _shell: ShellId): Promise<ObservedCodingCommand> {
    return Promise.reject(new ScopedCodingFileError("unsupported"));
  }
  runNode(argv: readonly string[], cwd: string, output: (bytes: Uint8Array, stream: "stdout" | "stderr") => void, signal: AbortSignal): Promise<ObservedCodingCommand> {
    let captured: string[];
    try { captured = copyNodeArgv(argv); } catch { return Promise.reject(new ScopedCodingFileError("limit")); }
    if (!(signal instanceof AbortSignal) || typeof output !== "function" || typeof cwd !== "string" || !["/work", "\\work"].some(root => windowsCodingFold(root) === windowsCodingFold(cwd))) return Promise.reject(new ScopedCodingFileError("path"));
    const abort = () => { void this.stop().catch(() => undefined); };
    signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort();
    return this.#queue(() => this.#execute(captured, output, signal)).finally(() => signal.removeEventListener("abort", abort));
  }
  async #execute(argv: readonly string[], output: (bytes: Uint8Array, stream: "stdout" | "stderr") => void, signal: AbortSignal): Promise<ObservedCodingCommand> {
    this.#check(); if (!this.#assets || !this.#profile || !this.#copy || this.#pendingAdoption || this.#unstarted || this.#active) throw new ScopedCodingFileError("boundary");
    let active: ActiveNode | undefined;
    try {
      const input = await this.#copy.captureCommandInput(); active = { input }; this.#active = active;
      const profile = this.#profile;
      const command = await WindowsRootOnlyCommandCopy.createFromInput(input, { creatorProfile: profile,
        packageSid: windowsCommandCreatorProfile(profile).sidText, packageCurrent: () => {
          if (this.#executionClosed || this.#failure || terminal || this.#profile !== profile) return false;
          try { windowsCommandCreatorProfile(profile); return true; } catch { return false; }
        } });
      active.command = command; this.#check();
      const run = await command.launchRootOnlyWithOutput(context => {
        const launch = this.#assets!.createSuspended(context, argv, { signal: AbortSignal.any([signal, this.#copy!.signal]), timeoutMs: MAX_RUN_MS, output });
        active!.launch = launch;
        const owned = requireWindowsCommandOutputLaunch(launch), abort = () => { void this.stop().catch(() => undefined); };
        owned.signal.addEventListener("abort", abort, { once: true }); active!.removeAbort = () => owned.signal.removeEventListener("abort", abort);
        if (owned.signal.aborted) abort(); return launch;
      }, () => undefined); // Fixed asset hook performs genuine native image/token attestation before Resume.
      active.run = run;
      if (!active.launch) throw new ScopedCodingFileError("boundary");
      const completed = await command.completeRootOnly(run, requireWindowsCommandOutputLaunch(active.launch).signal);
      const closed = await this.#assets.finishOutput(completed, run, active.launch);
      const completion = requireWindowsCommandRootOnlyCompletedOutput(completed, run, active.launch), streams = requireWindowsCommandOutputClosed(closed, active.launch, run);
      const snapshot = await command.captureStoppedSnapshot(run, completed, closed);
      const adoption = this.#copy.acceptStoppedCommand(snapshot); this.#pendingAdoption = adoption;
      const complete = completion.outcome === "natural-exit" && streams.complete;
      if (complete && this.#current()) {
        try { await this.#copy.applyStoppedCommand(adoption); this.#pendingAdoption = undefined; }
        catch (error) { if (uncertain(error)) throw error; if (this.#current()) throw error; }
      } else { void this.stop().catch(() => undefined); }
      return { observed: true, exitCode: completion.exitCode, signal: null,
        stopped: !complete || !this.#current(), timedOut: streams.reason === "timeout", outputLimited: streams.reason === "overflow" };
    } catch (error) {
      this.#usable();
      if (uncertain(error)) throw this.#poison();
      if (active && !active.run && !this.#pendingAdoption) {
        // No boolean authorizes release: the canonical API later checks its private untouched/closed-no-run ledgers.
        if (active.command) try { await active.command.close(); } catch { throw this.#poison(); }
        this.#unstarted = true;
      } else if (active?.command && !this.#pendingAdoption) {
        // A known stopped/refused run may be disposed, but its issued generation cannot become a no-run release.
        try { await active.command.close(); } catch { throw this.#poison(); }
      }
      void this.stop().catch(() => undefined); throw windowsCodingSafeError(error);
    } finally { active?.removeAbort?.(); if (this.#active === active) this.#active = undefined; }
  }
  /** Request Stop outside both the outer lease and the canonical/command owners' inherited async contexts. */
  stop(): Promise<void> {
    const reentrant = this.#lease.getStore() === true;
    if (terminal || this.#failure) return Promise.reject(this.#failure ?? terminal);
    if (!this.#stopping) {
      let resolve!: () => void, reject!: (error: unknown) => void;
      this.#stopping = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); void this.#stopping.catch(() => undefined);
      this.#retired = true; this.#ready = false; this.#epoch++; this.#lifetime.abort();
      this.#neutral.runInAsyncScope(() => {
        const active = this.#active;
        const commandStop = async () => {
          if (!active?.command) return;
          try { requireWindowsCommandInputProducerClosed(active.input); return; } catch (error) { if (uncertain(error)) throw error; }
          try { await active.command.stop(); }
          catch (error) { if (uncertain(error)) throw error; requireWindowsCommandInputProducerClosed(active.input); }
        };
        void Promise.all([commandStop(), this.#copy?.stop()]).then(() => resolve(), () => reject(this.#poison()));
      });
    }
    return reentrant ? Promise.reject(new ScopedCodingFileError("boundary")) : this.#stopping;
  }
  async filesBroker(signal: AbortSignal): Promise<CodingFileBroker> {
    this.#check();
    if (this.#openingBroker || this.#sealing || this.#closing) throw new ScopedCodingFileError("cancelled");
    this.#openingBroker = Promise.resolve().then(() => WindowsScopedCodingFiles.create({ copy: this.#copy!, signal, workspace: this }));
    const broker = await this.#openingBroker;
    if (this.#closing || this.#sealing) { await this.#closeBroker(); throw new ScopedCodingFileError("cancelled"); }
    return new Proxy(broker, { get: (target, key) => {
      if (key === "close") return () => this.#closeBroker();
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  #closeBroker(): Promise<void> {
    this.#usable();
    this.#closingBroker ??= this.#openingBroker ? this.#openingBroker.then(broker => broker.close(), error => { if (uncertain(error)) throw error; }) : Promise.resolve();
    return this.#closingBroker;
  }
  async #closeExecution(): Promise<void> {
    this.#usable(); if (this.#executionClosed) return;
    try {
      if (this.#assets) await this.#assets.close();
      if (this.#profile) closeWindowsCommandCreatorProfile(this.#profile);
      this.#executionClosed = true; this.#ready = false;
    } catch { throw this.#poison(); }
  }
  /** Called only after awaited controller disposal; this flag is never a native stopped-writer proof. */
  sealForReview(): Promise<void> {
    try { this.#usable(); } catch (error) { return Promise.reject(error); }
    if (this.#lease.getStore()) return Promise.reject(new ScopedCodingFileError("boundary"));
    if (this.#sealing) return this.#sealing;
    if (this.#closing || this.#exporting || this.#transferred) return Promise.reject(new ScopedCodingFileError("boundary"));
    let resolve!: () => void, reject!: (error: unknown) => void;
    this.#sealing = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); void this.#sealing.catch(() => undefined);
    // Publish the actual proof before Stop dispatches a public abort listener which may reenter this method.
    const stopped = this.#neutral.runInAsyncScope(() => this.stop());
    void this.#neutral.runInAsyncScope(async () => {
      try {
        await stopped; await this.#tail; this.#usable(); await this.#closeBroker(); this.#usable(); this.#sealed = true;
        if (this.#pendingAdoption) { await this.#copy!.applyStoppedCommandForReview(this.#pendingAdoption); this.#pendingAdoption = undefined; }
        else if (this.#unstarted) { await this.#copy!.releaseUnstartedForReview(); this.#unstarted = false; }
        await this.#closeExecution();
      } catch (error) { if (uncertain(error)) throw this.#poison(); throw windowsCodingSafeError(error); }
    }).then(resolve, reject);
    return this.#sealing;
  }
  exportReview(base: string): Promise<WindowsCodingReviewOutput> {
    try { this.#usable(); } catch (error) { return Promise.reject(error); }
    if (base !== this.#input.reviewBase || !this.#sealed || !this.#executionClosed || this.#closing || this.#transferred) return Promise.reject(new ScopedCodingFileError("boundary"));
    this.#exporting ??= this.#neutral.runInAsyncScope(async () => {
      try {
        const producer = await this.#copy!.exportReview(this.#input.review.store);
        this.#output = producer.transfer(); this.#sourceBoundary = producer.sourceBoundary;
        await this.#copy!.close(); this.#usable(); this.#output = Object.freeze({ ...this.#output, cleanup: "complete" as const }); return this.#output;
      } catch (error) { if (uncertain(error)) throw this.#poison(); throw windowsCodingSafeError(error); }
    });
    return this.#exporting;
  }
  transferReview(output: CodingWorkspaceReview): void {
    this.#usable();
    if (this.#discardStarted || !this.#output || this.#output !== output) throw new CodingResultRegistryError("invalid");
    this.#transferred = true; this.#output = undefined; this.#exporting = undefined; this.#sourceBoundary = undefined;
  }
  close(): Promise<void> {
    if (terminal || this.#failure) return Promise.reject(this.#failure ?? terminal);
    const reentrant = this.#lease.getStore() === true;
    if (!this.#closing) {
      let resolve!: () => void, reject!: (error: unknown) => void;
      this.#closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; }); void this.#closing.catch(() => undefined);
      // The shared cleanup proof must exist before Stop can dispatch any reentrant close callback.
      const stopped = this.#neutral.runInAsyncScope(() => this.stop());
      void this.#neutral.runInAsyncScope(async () => {
        try {
          await stopped; await this.#tail; this.#usable();
          try { await this.#sealing; } catch (error) { if (uncertain(error)) throw error; }
          await this.#closeBroker(); await this.#closeExecution();
          try { await this.#exporting; } catch (error) { if (uncertain(error)) throw error; }
          if (this.#output) { this.#discardStarted = true; await this.#input.review.store.discard(this.#output); this.#output = undefined; }
          await this.#copy?.close(); this.#closed = true; this.#sourceBoundary = undefined;
          this.#signal.removeEventListener("abort", this.#abort); this.#neutral.emitDestroy(); owners.delete(this);
        } catch { throw this.#poison(); }
      }).then(resolve, reject);
    }
    return reentrant ? Promise.reject(new ScopedCodingFileError("boundary")) : this.#closing;
  }
}

// Capture the genuine private-brand ports when this class finishes initialization. The adapter asks
// for them only when used; a cyclic import must not read this class's prototype before it exists.
const trustedWindowsNodeWorkspacePorts = Object.freeze({
  available: Object.getOwnPropertyDescriptor(WindowsNodeWorkspace.prototype, "nodeAvailable")!.get!,
  filesBroker: WindowsNodeWorkspace.prototype.filesBroker,
});
export function windowsNodeWorkspacePorts() { return trustedWindowsNodeWorkspacePorts; }
