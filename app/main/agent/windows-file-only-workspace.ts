/** Host-only files/review adapter. It has no command, process-launch or Node capability. */
import type { CodingFileBroker, CodingReviewWorkspace, CodingWorkspaceReview } from "./coding-platform";
import { ScopedCodingFileError } from "./coding-platform";
import { CodingArtifactCleanupError, CodingResultRegistryError, type CodingArtifactSourceRef } from "./coding-artifact-store";
import { WindowsCodingCopy, type WindowsCodingCopyInput, type WindowsCodingCopyReviewInput } from "./windows-coding-copy";
import { WindowsScopedCodingFiles } from "./windows-scoped-coding-files";
import type { WindowsCodingReviewOutput } from "./windows-coding-review";
import { WindowsCodingCleanupError } from "./windows-coding-native";
import { CodingPrivacyCleanupError } from "./coding-privacy-scanner";

export interface WindowsFileOnlyWorkspaceInput extends Omit<WindowsCodingCopyInput, "review"> {
  review: Omit<WindowsCodingCopyReviewInput, "controllerClosed">;
  reviewBase: string;
}
export class WindowsFileOnlyWorkspaceCleanupError extends CodingArtifactCleanupError {
  constructor() { super(); this.name = "WindowsFileOnlyWorkspaceCleanupError"; }
}
const uncertain = (error: unknown) => error instanceof WindowsCodingCleanupError || error instanceof CodingPrivacyCleanupError || error instanceof CodingArtifactCleanupError;

export class WindowsFileOnlyWorkspace implements CodingReviewWorkspace {
  readonly executionRoot = "/work";
  #copy!: WindowsCodingCopy;
  #input: WindowsFileOnlyWorkspaceInput;
  #sealed = false;
  #sealing: Promise<void> | null = null;
  #transferred = false;
  #discardStarted = false;
  #openingBroker: Promise<WindowsScopedCodingFiles> | null = null;
  #closingBroker: Promise<void> | null = null;
  #exporting: Promise<WindowsCodingReviewOutput> | null = null;
  #closing: Promise<void> | null = null;
  #output: WindowsCodingReviewOutput | null = null;
  #sourceBoundary: CodingArtifactSourceRef | null = null;
  #terminal: WindowsFileOnlyWorkspaceCleanupError | null = null;

  private constructor(input: WindowsFileOnlyWorkspaceInput) {
    this.#input = { ...input, current: input.current.bind(input), protectedPaths: [...input.protectedPaths],
      review: { ...input.review, binding: { ...input.review.binding }, current: input.review.current.bind(input.review) } };
  }
  static async create(input: WindowsFileOnlyWorkspaceInput): Promise<WindowsFileOnlyWorkspace> {
    if (!input?.review || typeof input.reviewBase !== "string" || !input.reviewBase) throw new ScopedCodingFileError("unavailable");
    const owner = new WindowsFileOnlyWorkspace(input);
    owner.#copy = await WindowsCodingCopy.create({ ...owner.#input, review: { ...owner.#input.review, controllerClosed: () => owner.#sealed } });
    return owner;
  }
  get excludedRoots(): readonly string[] { return this.#copy.excludedRoots; }
  get sourceBoundary(): CodingArtifactSourceRef {
    if (!this.#sourceBoundary) throw new CodingResultRegistryError("invalid");
    return this.#sourceBoundary;
  }
  files<T>(operation: (root: string) => Promise<T>): Promise<T> { return this.#copy.files(operation); }
  stop(): Promise<void> { return this.#copy.stop(); }

  /** Exactly one controller file broker belongs to this copy. Its close receipt is shared with the worker. */
  async filesBroker(signal: AbortSignal): Promise<CodingFileBroker> {
    if (this.#openingBroker || this.#sealing || this.#closing || this.#terminal) throw new ScopedCodingFileError("cancelled");
    this.#openingBroker = Promise.resolve().then(() => WindowsScopedCodingFiles.create({ copy: this.#copy, signal, workspace: this }));
    const broker = await this.#openingBroker;
    if (this.#closing || this.#sealing) { await this.#closeBroker(); throw new ScopedCodingFileError("cancelled"); }
    return new Proxy(broker, { get: (target, key) => {
      if (key === "close") return () => this.#closeBroker();
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  #closeBroker(): Promise<void> {
    this.#closingBroker ??= this.#openingBroker ? this.#openingBroker.then(broker => broker.close(), error => { if (uncertain(error)) throw error; }) : Promise.resolve();
    return this.#closingBroker;
  }
  /** Called by the worker only after awaited SDK/controller disposal; never exposed as a model tool. */
  sealForReview(): Promise<void> {
    if (this.#closing || this.#exporting || this.#terminal || this.#transferred) return Promise.reject(this.#terminal ?? new ScopedCodingFileError("cancelled"));
    this.#sealing ??= Promise.resolve().then(async () => {
      try { await this.#closeBroker(); await this.#copy.stop(); }
      catch { throw this.#terminal ??= new WindowsFileOnlyWorkspaceCleanupError(); }
      if (this.#closing || this.#terminal) throw this.#terminal ?? new ScopedCodingFileError("cancelled");
      this.#sealed = true;
    });
    return this.#sealing;
  }
  exportReview(base: string): Promise<WindowsCodingReviewOutput> {
    if (base !== this.#input.reviewBase || !this.#sealed || this.#closing || this.#terminal || this.#transferred)
      return Promise.reject(this.#terminal ?? new ScopedCodingFileError("boundary"));
    this.#exporting ??= Promise.resolve().then(async () => {
      try {
        const producer = await this.#copy.exportReview(this.#input.review.store);
        // Retain transferred ownership before the first await. A failed copy close cannot lose this artifact.
        this.#output = producer.transfer(); this.#sourceBoundary = producer.sourceBoundary;
        await this.#copy.close();
        this.#output = Object.freeze({ ...this.#output, cleanup: "complete" as const });
        return this.#output;
      } catch (error) {
        if (uncertain(error)) throw this.#terminal ??= new WindowsFileOnlyWorkspaceCleanupError();
        throw error;
      }
    });
    return this.#exporting;
  }
  /** The resources owner records output + sourceBoundary synchronously before calling this exact transfer. */
  transferReview(output: CodingWorkspaceReview): void {
    // An already pending export settles before close's await resumes. Its synchronous resources handler may
    // take the exact still-owned result; close then sees no artifact to discard. A removed result cannot transfer.
    if (this.#terminal || this.#discardStarted || !this.#output || this.#output !== output) throw this.#terminal ?? new CodingResultRegistryError("invalid");
    this.#transferred = true; this.#output = null; this.#exporting = null; this.#sourceBoundary = null;
  }
  close(): Promise<void> {
    this.#closing ??= (async () => {
      let failed = this.#terminal !== null;
      try { await this.#exporting; } catch (error) { failed ||= uncertain(error); }
      try { await this.#closeBroker(); } catch { failed = true; }
      if (this.#output) {
        this.#discardStarted = true;
        try { await this.#input.review.store.discard(this.#output); this.#output = null; } catch { failed = true; }
      }
      try { await this.#copy.close(); } catch { failed = true; }
      if (failed) throw this.#terminal ??= new WindowsFileOnlyWorkspaceCleanupError();
      this.#exporting = null; this.#sourceBoundary = null;
    })();
    return this.#closing;
  }
}
