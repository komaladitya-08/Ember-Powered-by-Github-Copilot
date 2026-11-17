/** Host-owned WSL workspace. The helper never receives a provider credential, original path or artifact capability. */
import { z } from "zod";
import { createHash } from "node:crypto";
import type { ShellId, RunnerFacts } from "../commands/types";
import { copyNodeArgv } from "../commands/node-invocation";
import type { CodingCommandWorkspace, CodingFileBroker, CodingPlatformAdapter, CodingReviewWorkspace, CodingWorkspaceReview } from "./coding-platform";
import { ScopedCodingFileError } from "./coding-platform";
import { CodingArtifactCleanupError, type CodingArtifactSourceRef } from "./coding-artifact-store";
import { createCodingReviewExport, type CodingExportInput, type CodingExportTree } from "./coding-result-export";
import { CodingPrivacyScanner, CodingPrivacyCleanupError, captureCodingPrivacyScope, assertCodingPrivacyScope, type CodingPrivacyScope } from "./coding-privacy-scanner";
import { WindowsCodingCleanupError } from "./windows-coding-native";
import { codingWorkspaceFileProblemAsync } from "./scoped-coding-files";
import type { ObservedCodingCommand } from "./isolated-coding-command-runner";
import { WslCodingConnection, WslCodingGuestCleanupError, requireWslStoppedReceipt, type WslStoppedReceiptRef } from "./wsl-coding-connection";
import { WslCodingFiles } from "./wsl-coding-files";
import { decodeWslCodingTree, encodeWslCodingTree } from "./wsl-coding-protocol";
import { PublicNpmPlan, PublicNpmPreparationError, PUBLIC_NPM_LIMITS, type PublicNpmPreparationAuthorize, type PublicNpmPreparationResult } from "./public-npm-lock";
import { PublicNpmBatch, publicNpmBatchData, type PublicNpmDownloadPort } from "./public-npm-fetch";
import { codingProjectManifest, type CodingProjectManifest } from "./coding-project-scope";

export interface WslCodingReviewOwner {
  readonly base: string;
  readonly sourceBoundary: CodingArtifactSourceRef;
  current(): boolean;
  /** Fresh owned native-capture buffers (consumed/wiped after write), or undefined. Never a helper claim. */
  captureCurrent(): Promise<CodingExportTree | undefined>;
  /** The actual host store mints and owns the artifact after all guest writers and private state have closed. */
  write(input: CodingExportInput): Promise<CodingWorkspaceReview>;
  discard(output: CodingWorkspaceReview): Promise<void>;
}
export interface WslCodingWorkspaceInput {
  connection: WslCodingConnection; source: CodingExportTree; baseline?: CodingExportTree; typescriptArchive: Buffer;
  signal: AbortSignal; current(): boolean; review: WslCodingReviewOwner; privacyScope?: CodingPrivacyScope;
  /** Captured host capability, never a draft/helper/model claim. Network port is a trusted fixture/host seam. */
  publicDependencies?: { current(): boolean; port?: PublicNpmDownloadPort };
  scope?: CodingProjectManifest;
}
export class WslCodingCleanupError extends CodingArtifactCleanupError {
  constructor() { super(); this.name = "WslCodingCleanupError"; }
}
const issued = new WeakSet<object>(), retained = new Set<WslCodingWorkspace>();
const resultSchema = z.object({ observed: z.literal(true), exitCode: z.number().int().min(0).max(255).nullable(),
  signal: z.enum(["SIGKILL", "SIGTERM", "SIGSEGV", "SIGABRT", "SIGINT", "SIGHUP", "SIGPIPE", "SIGBUS", "SIGILL", "SIGTRAP", "SIGFPE", "SIGQUIT", "SIGXCPU", "SIGXFSZ", "SIGSYS", "SIGALRM", "SIGUSR1", "SIGUSR2", "SIGVTALRM", "SIGPROF", "SIGPOLL", "SIGPWR", "SIGSTKFLT", "SIGIO"]).nullable(),
  stopped: z.boolean(), timedOut: z.boolean(), outputLimited: z.boolean() }).strict().refine(value => (value.exitCode === null) !== (value.signal === null));
const wipe = (tree: CodingExportTree) => { for (const e of tree.entries) if (e.kind === "file") e.bytes.fill(0); };
const cleanupUncertain = (error: unknown): boolean => error instanceof CodingArtifactCleanupError || error instanceof CodingPrivacyCleanupError || error instanceof WindowsCodingCleanupError || error instanceof WslCodingGuestCleanupError;

export class WslCodingWorkspace implements CodingCommandWorkspace {
  readonly executionRoot = "/work";
  readonly excludedRoots = Object.freeze([".git", "node_modules"]);
  #input: WslCodingWorkspaceInput; #baseline: CodingExportTree; #privacy: CodingPrivacyScope; #files?: WslCodingFiles;
  #retired = false; #ready = false; #sealed = false; #closed = false; #failure?: WslCodingCleanupError;
  #stopping?: Promise<void>; #sealing?: Promise<void>; #closing?: Promise<void>; #exporting?: Promise<CodingWorkspaceReview>;
  #output?: CodingWorkspaceReview; #transferred = false; #guestClosed = false; #abort: () => void;
  #stopReceipt?: WslStoppedReceiptRef;
  #public?: { current(): boolean; port?: PublicNpmDownloadPort; packageJsonSha256?: string; lockSha256?: string };
  #preparing?: Promise<PublicNpmPreparationResult>; #prepareAbort?: AbortController;
  #scope?: CodingProjectManifest;
  private constructor(input: WslCodingWorkspaceInput, baseline: CodingExportTree) {
    this.#input = { ...input, current: input.current.bind(input), review: { ...input.review, current: input.review.current.bind(input.review),
      captureCurrent: input.review.captureCurrent.bind(input.review), write: input.review.write.bind(input.review), discard: input.review.discard.bind(input.review) } };
    this.#baseline = baseline; this.#privacy = input.privacyScope ?? captureCodingPrivacyScope();
    if (input.scope) {
      const { publicDependencies: _oldReceipt, executionProfile: _oldProfile, ...sourceScope } = codingProjectManifest(input.scope);
      this.#scope = codingProjectManifest({ ...sourceScope, executionProfile: input.publicDependencies ? "wsl-public-lock" : "wsl-offline" });
    }
    if (input.publicDependencies) {
      const hash = (name: string) => { const file = input.source.entries.find(e => e.kind === "file" && e.path === name); return file?.kind === "file" ? createHash("sha256").update(file.bytes).digest("hex") : undefined; };
      const port = input.publicDependencies.port;
      this.#public = { current: input.publicDependencies.current.bind(input.publicDependencies), ...(port ? { port: Object.freeze({ read: port.read.bind(port) }) } : {}),
        packageJsonSha256: hash("package.json"), lockSha256: hash("package-lock.json") };
    }
    this.#abort = () => { void this.stop().catch(() => undefined); };
    input.signal.addEventListener("abort", this.#abort, { once: true });
  }
  static async create(input: WslCodingWorkspaceInput): Promise<WslCodingWorkspace> {
    const source = encodeWslCodingTree(input.source), baseline = decodeWslCodingTree(encodeWslCodingTree(input.baseline ?? input.source));
    const owner = new WslCodingWorkspace(input, baseline); issued.add(owner);
    try {
      owner.#check();
      const hello = await input.connection.call("hello"); owner.#check();
      const uid = hello && typeof hello === "object" ? (hello as { uid?: unknown }).uid : undefined;
      if (!hello || typeof hello !== "object" || (hello as { protocol?: unknown }).protocol !== 1 || (hello as { kind?: unknown }).kind !== "linux-helper" ||
          (hello as { noNetwork?: unknown }).noNetwork !== true || (hello as { provisioned?: unknown }).provisioned !== false ||
          (hello as { opened?: unknown }).opened !== false || (hello as { retired?: unknown }).retired !== false ||
          typeof uid !== "number" || !Number.isInteger(uid) || uid <= 0) throw new ScopedCodingFileError("boundary");
      const receipt = await input.connection.call("provision", { typescript: Buffer.from(input.typescriptArchive).toString("base64"), ...(owner.#public ? { publicDependencies: true } : {}) }); owner.#check();
      if (!receipt || typeof receipt !== "object" || (receipt as { typescript?: unknown }).typescript !== "5.9.3") throw new ScopedCodingFileError("boundary");
      const opened = await input.connection.call("open", { source }); owner.#check();
      if (!opened || typeof opened !== "object" || (opened as { opened?: unknown }).opened !== true) throw new ScopedCodingFileError("boundary");
      owner.#ready = true; return owner;
    } catch (error) {
      try { await owner.close(); } catch { throw owner.#poison(); }
      throw error;
    }
  }
  get nodeAvailable(): boolean { try { return this.#ready && !this.#retired && !this.#closing && !this.#failure && this.#current(); } catch { return false; } }
  get sourceBoundary(): CodingArtifactSourceRef { if (this.#failure) throw this.#failure; return this.#input.review.sourceBoundary; }
  #current(): boolean {
    if (!issued.has(this) || this.#retired || this.#closed || this.#failure || this.#input.signal.aborted) return false;
    try { assertCodingPrivacyScope(this.#privacy); if (this.#input.current() === true && (!this.#public || this.#public.current() === true)) return true; } catch { /* A revoked scope never becomes current again. */ }
    this.#retired = true; return false;
  }
  #check(): void { if (this.#failure) throw this.#failure; if (!this.#current()) { this.#retired = true; throw new ScopedCodingFileError("cancelled"); } }
  #reviewCheck(): void {
    if (this.#failure) throw this.#failure; assertCodingPrivacyScope(this.#privacy);
    if (this.#closed || !this.#input.review.current()) throw new ScopedCodingFileError("cancelled");
  }
  #poison(): WslCodingCleanupError { this.#failure ??= new WslCodingCleanupError(); this.#retired = true; this.#ready = false; retained.add(this); return this.#failure; }
  /** No Linux path is ever handed to a Windows filesystem callback. */
  files<T>(_operation: (root: string) => Promise<T>): Promise<T> { return Promise.reject(new ScopedCodingFileError("boundary")); }
  async filesBroker(signal: AbortSignal): Promise<CodingFileBroker> {
    this.#check(); if (this.#files || signal.aborted) throw new ScopedCodingFileError("cancelled");
    this.#files = new WslCodingFiles(this.#input.connection, () => !signal.aborted && this.#current()); return this.#files;
  }
  async quiescent(): Promise<boolean> {
    this.#check(); const result = await this.#input.connection.call("quiescent"); this.#check();
    if (!result || typeof result !== "object" || Object.keys(result).join(",") !== "quiescent" || (result as { quiescent?: unknown }).quiescent !== true) throw this.#poison();
    return true;
  }
  preparePublicDependencies(authorize: PublicNpmPreparationAuthorize, signal: AbortSignal): Promise<PublicNpmPreparationResult> {
    try { this.#check(); if (!this.#public || this.#preparing || typeof authorize !== "function" || signal.aborted) throw new PublicNpmPreparationError(); }
    catch (error) { return Promise.reject(error); }
    const permission = this.#public!, authorizeSet = authorize, abort = new AbortController(); this.#prepareAbort = abort;
    const cancelled = () => { abort.abort(); void this.stop().catch(() => undefined); };
    signal.addEventListener("abort", cancelled, { once: true });
    const check = () => { abort.signal.throwIfAborted(); signal.throwIfAborted(); this.#check(); };
    const task = (async () => {
      let lease: string | undefined, batch: PublicNpmBatch | undefined;
      const cancelLease = async () => {
        if (!lease || this.#retired || this.#guestClosed) return;
        try { const result = await this.#input.connection.call("publicCancel", { lease });
          if (!result || typeof result !== "object" || Object.keys(result).join(",") !== "cancelled" || (result as { cancelled?: unknown }).cancelled !== true) throw new PublicNpmPreparationError();
        } catch { throw this.#poison(); }
      };
      try {
        check(); const raw = await this.#input.connection.call("publicBegin").then(value => {
          try { return z.object({ lease: z.string().regex(/^[0-9a-f]{32}$/), packageJson: z.string().max(Math.ceil(PUBLIC_NPM_LIMITS.packageJsonBytes / 3) * 4),
            packageLock: z.string().max(Math.ceil(PUBLIC_NPM_LIMITS.lockBytes / 3) * 4) }).strict().parse(value); }
          catch { throw this.#poison(); }
        });
        lease = raw.lease; check();
        const pkg = Buffer.from(raw.packageJson, "base64"), lock = Buffer.from(raw.packageLock, "base64"); let plan: PublicNpmPlan;
        try {
          if (pkg.toString("base64") !== raw.packageJson || lock.toString("base64") !== raw.packageLock) throw new PublicNpmPreparationError();
          plan = PublicNpmPlan.create({ packageJson: pkg, packageLock: lock });
        } finally { pkg.fill(0); lock.fill(0); }
        const request = Object.freeze({ ...plan.summary, kind: plan.summary.packageJsonSha256 === permission.packageJsonSha256 && plan.summary.lockSha256 === permission.lockSha256 ? "baseline" as const : "changed" as const });
        // Opt-in alone approves neither the baseline nor a changed concrete package set.
        if (await authorizeSet(request, abort.signal) !== true) throw new PublicNpmPreparationError(); check();
        batch = await PublicNpmBatch.download(plan, { signal: abort.signal, current: () => { check(); return true; }, ...(permission.port ? { port: permission.port } : {}) }); check();
        const archives = publicNpmBatchData(batch);
        for (let index = 0; index < archives.length; index++) for (let offset = 0; offset < archives[index].bytes.length; offset += 1024 * 1024) {
          check(); const accepted = await this.#input.connection.call("publicChunk", { lease, index, offset, base64: archives[index].bytes.subarray(offset, offset + 1024 * 1024).toString("base64") }); check();
          if (!accepted || typeof accepted !== "object" || Object.keys(accepted).join(",") !== "accepted" || (accepted as { accepted?: unknown }).accepted !== true) throw this.#poison();
        }
        check(); const result = await this.#input.connection.call("publicCommit", { lease }); check();
        if (!result || typeof result !== "object" || Object.keys(result).join(",") !== "prepared" || (result as { prepared?: unknown }).prepared !== true) throw this.#poison();
        if (this.#scope) this.#scope = codingProjectManifest({ ...this.#scope, publicDependencies: { access: "verified-offline-cache-input", registry: request.registry,
          packageJsonSha256: request.packageJsonSha256, lockSha256: request.lockSha256, ...batch.receipt } });
        lease = undefined; return Object.freeze({ prepared: true as const, packages: request.packageCount, lockSha256: request.lockSha256, setSha256: request.setSha256 });
      } catch (error) { if (cleanupUncertain(error)) throw this.#poison(); throw error; }
      finally {
        batch?.close();
        try { await cancelLease(); } finally { signal.removeEventListener("abort", cancelled); }
      }
    })();
    this.#preparing = task;
    void task.finally(() => { if (this.#preparing === task) { this.#preparing = undefined; this.#prepareAbort = undefined; } }).catch(() => undefined);
    return task;
  }
  run(command: string, cwd: string, output: (bytes: Uint8Array, stream: "stdout" | "stderr") => void, signal: AbortSignal, shell: ShellId): Promise<ObservedCodingCommand> {
    if (shell !== "bash") return Promise.reject(new ScopedCodingFileError("unsupported"));
    return this.#run("run", { command, cwd, shell }, output, signal);
  }
  runNode(argv: readonly string[], cwd: string, output: (bytes: Uint8Array, stream: "stdout" | "stderr") => void, signal: AbortSignal): Promise<ObservedCodingCommand> {
    let args: string[]; try { args = copyNodeArgv(argv); } catch { return Promise.reject(new ScopedCodingFileError("limit")); }
    return this.#run("runNode", { argv: args, cwd }, output, signal);
  }
  async #run(method: "run" | "runNode", params: Record<string, unknown>, output: (bytes: Uint8Array, stream: "stdout" | "stderr") => void, signal: AbortSignal): Promise<ObservedCodingCommand> {
    this.#check(); if (signal.aborted) throw new ScopedCodingFileError("cancelled");
    const abort = () => { void this.stop().catch(() => undefined); }; signal.addEventListener("abort", abort, { once: true });
    try { const result = resultSchema.parse(await this.#input.connection.call(method, params, { output, timeoutMs: 20 * 60_000 })); return { ...result, stopped: result.stopped || !this.#current() }; }
    catch { throw this.#poison(); }
    finally { signal.removeEventListener("abort", abort); }
  }
  stop(): Promise<void> {
    this.#retired = true; this.#ready = false; this.#prepareAbort?.abort();
    this.#stopping ??= this.#guestClosed ? Promise.resolve() : this.#input.connection.stop().then(async receipt => {
      requireWslStoppedReceipt(receipt, this.#input.connection); await Promise.allSettled(this.#preparing ? [this.#preparing] : []);
      if (this.#failure) throw this.#failure; this.#stopReceipt = receipt;
    }).catch(() => { throw this.#poison(); }); return this.#stopping;
  }
  sealForReview(): Promise<void> {
    this.#sealing ??= (async () => {
      try { await this.#files?.close(); await this.stop(); requireWslStoppedReceipt(this.#stopReceipt!, this.#input.connection); this.#sealed = true; } catch { throw this.#poison(); }
    })(); return this.#sealing;
  }
  exportReview(base: string): Promise<CodingWorkspaceReview> {
    if (!this.#sealed || base !== this.#input.review.base || this.#closed || this.#closing || this.#failure) return Promise.reject(this.#failure ?? new ScopedCodingFileError("boundary"));
    this.#exporting ??= (async () => {
      this.#reviewCheck(); const proposed = decodeWslCodingTree(await this.#input.connection.call("snapshot")); this.#reviewCheck();
      const privacy = new CodingPrivacyScanner({ scope: this.#privacy }); let failure: unknown;
      try {
        if (JSON.stringify(proposed.binding) !== JSON.stringify(this.#baseline.binding)) throw new ScopedCodingFileError("boundary");
        for (const tree of [this.#baseline, proposed]) for (const entry of tree.entries) {
          this.#reviewCheck();
          if (entry.kind === "file" && await codingWorkspaceFileProblemAsync(entry.path, entry.bytes, privacy, { current: () => { this.#reviewCheck(); return true; } })) throw new ScopedCodingFileError("secret");
          this.#reviewCheck();
        }
      } catch (error) { failure = error; }
      try { await privacy.close(); } catch { throw this.#poison(); }
      let current: CodingExportTree | undefined;
      try {
        if (failure) throw failure;
        try { await this.#input.connection.close(); this.#guestClosed = true; } catch { throw this.#poison(); }
        this.#reviewCheck();
        current = await this.#input.review.captureCurrent(); this.#reviewCheck();
        const data: CodingExportInput = { binding: this.#baseline.binding, baseline: this.#baseline, proposed, ...(current ? { current } : {}), ...(this.#scope ? { scope: codingProjectManifest(this.#scope) } : {}) };
        createCodingReviewExport(data); this.#output = await this.#input.review.write(data); this.#reviewCheck();
        return this.#output;
      } finally { wipe(proposed); if (current) wipe(current); }
    })().catch(error => { if (cleanupUncertain(error)) throw this.#poison(); throw error; }); return this.#exporting;
  }
  transferReview(output: CodingWorkspaceReview): void {
    if (this.#failure || !this.#output || output !== this.#output || this.#transferred) throw new ScopedCodingFileError("boundary"); this.#transferred = true;
  }
  close(): Promise<void> {
    this.#retired = true; this.#ready = false; this.#prepareAbort?.abort();
    this.#closing ??= (async () => {
      let failed = !!this.#failure;
      try { if (this.#preparing) { await this.stop(); await Promise.allSettled([this.#preparing]); } } catch { failed = true; }
      try { await this.#exporting; }
      catch (error) { if (cleanupUncertain(error) || this.#failure) { this.#poison(); failed = true; } }
      try { await this.#files?.close(); } catch { failed = true; }
      if (this.#output && !this.#transferred) { try { await this.#input.review.discard(this.#output); this.#output = undefined; } catch { failed = true; } }
      try { if (!this.#guestClosed) { await this.#input.connection.close(); this.#guestClosed = true; } } catch { failed = true; }
      this.#input.signal.removeEventListener("abort", this.#abort); wipe(this.#baseline);
      if (failed || this.#failure) throw this.#poison(); this.#closed = true; retained.delete(this);
    })(); return this.#closing;
  }
}

/** Only issued live workspace instances can acquire a remote broker or the guest's logical command facts. */
export const wslCodingPlatform: CodingPlatformAdapter = Object.freeze({
  facts(workspace: CodingCommandWorkspace, host: RunnerFacts): RunnerFacts {
    if (!issued.has(workspace) || !(workspace instanceof WslCodingWorkspace) || !workspace.nodeAvailable) throw new ScopedCodingFileError("boundary");
    return { os: "linux", shells: ["bash"], shellPaths: { bash: "/usr/bin/bash" }, script: null, home: "/tmp", user: "", privileged: false, pty: false,
      ember: { paths: ["/opt/ember-coding-tools"], pids: [], names: host.ember.names }, extraPath: [] };
  },
  files(workspace: CodingReviewWorkspace, signal: AbortSignal) {
    if (!issued.has(workspace) || !(workspace instanceof WslCodingWorkspace)) return Promise.reject(new ScopedCodingFileError("boundary"));
    return workspace.filesBroker(signal);
  },
});
