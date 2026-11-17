/** Host-owned WSL workspace. The helper never receives a provider credential, original path or artifact capability. */
import { z } from "zod";
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
import { WslCodingConnection, requireWslStoppedReceipt, type WslStoppedReceiptRef } from "./wsl-coding-connection";
import { WslCodingFiles } from "./wsl-coding-files";
import { decodeWslCodingTree, encodeWslCodingTree } from "./wsl-coding-protocol";

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
}
export class WslCodingCleanupError extends CodingArtifactCleanupError {
  constructor() { super(); this.name = "WslCodingCleanupError"; }
}
const issued = new WeakSet<object>(), retained = new Set<WslCodingWorkspace>();
const resultSchema = z.object({ observed: z.literal(true), exitCode: z.number().int().min(0).max(255).nullable(),
  signal: z.enum(["SIGKILL", "SIGTERM", "SIGSEGV", "SIGABRT", "SIGINT", "SIGHUP", "SIGPIPE", "SIGBUS", "SIGILL", "SIGTRAP", "SIGFPE", "SIGQUIT", "SIGXCPU", "SIGXFSZ", "SIGSYS", "SIGALRM", "SIGUSR1", "SIGUSR2", "SIGVTALRM", "SIGPROF", "SIGPOLL", "SIGPWR", "SIGSTKFLT", "SIGIO"]).nullable(),
  stopped: z.boolean(), timedOut: z.boolean(), outputLimited: z.boolean() }).strict().refine(value => (value.exitCode === null) !== (value.signal === null));
const wipe = (tree: CodingExportTree) => { for (const e of tree.entries) if (e.kind === "file") e.bytes.fill(0); };
const cleanupUncertain = (error: unknown): boolean => error instanceof CodingArtifactCleanupError || error instanceof CodingPrivacyCleanupError || error instanceof WindowsCodingCleanupError;

export class WslCodingWorkspace implements CodingCommandWorkspace {
  readonly executionRoot = "/work";
  readonly excludedRoots = Object.freeze([".git", "node_modules"]);
  #input: WslCodingWorkspaceInput; #baseline: CodingExportTree; #privacy: CodingPrivacyScope; #files?: WslCodingFiles;
  #retired = false; #ready = false; #sealed = false; #closed = false; #failure?: WslCodingCleanupError;
  #stopping?: Promise<void>; #sealing?: Promise<void>; #closing?: Promise<void>; #exporting?: Promise<CodingWorkspaceReview>;
  #output?: CodingWorkspaceReview; #transferred = false; #guestClosed = false; #abort: () => void;
  #stopReceipt?: WslStoppedReceiptRef;
  private constructor(input: WslCodingWorkspaceInput, baseline: CodingExportTree) {
    this.#input = { ...input, current: input.current.bind(input), review: { ...input.review, current: input.review.current.bind(input.review),
      captureCurrent: input.review.captureCurrent.bind(input.review), write: input.review.write.bind(input.review), discard: input.review.discard.bind(input.review) } };
    this.#baseline = baseline; this.#privacy = input.privacyScope ?? captureCodingPrivacyScope();
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
      const receipt = await input.connection.call("provision", { typescript: Buffer.from(input.typescriptArchive).toString("base64") }); owner.#check();
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
    try { assertCodingPrivacyScope(this.#privacy); if (this.#input.current() === true) return true; } catch { /* A revoked scope never becomes current again. */ }
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
    this.#retired = true; this.#ready = false;
    this.#stopping ??= this.#guestClosed ? Promise.resolve() : this.#input.connection.stop().then(receipt => {
      requireWslStoppedReceipt(receipt, this.#input.connection); this.#stopReceipt = receipt;
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
        const data: CodingExportInput = { binding: this.#baseline.binding, baseline: this.#baseline, proposed, ...(current ? { current } : {}) };
        createCodingReviewExport(data); this.#output = await this.#input.review.write(data); this.#reviewCheck();
        return this.#output;
      } finally { wipe(proposed); if (current) wipe(current); }
    })().catch(error => { if (cleanupUncertain(error)) throw this.#poison(); throw error; }); return this.#exporting;
  }
  transferReview(output: CodingWorkspaceReview): void {
    if (this.#failure || !this.#output || output !== this.#output || this.#transferred) throw new ScopedCodingFileError("boundary"); this.#transferred = true;
  }
  close(): Promise<void> {
    this.#retired = true; this.#ready = false;
    this.#closing ??= (async () => {
      let failed = !!this.#failure;
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
