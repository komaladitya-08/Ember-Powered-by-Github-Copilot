/** Host-owned Windows copied-file resources. No command, toolchain discovery, source grant or product gate. */
import path from "node:path/win32";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import { ProjectCodingWorkspaces } from "./project-coding-workspaces";
import type { ProjectCodingResourcesOptions, CodingResultsAccess } from "./coding-resources";
import type { CodingWorkspace } from "./coding-workspace";
import type { TaskSpec } from "./worker";
import type { ScopedCodingChecks } from "./scoped-coding-worker";
import type { CodingReviewWorkspace, CodingWorkspaceReview } from "./coding-platform";
import { ScopedCodingFileError } from "./coding-platform";
import { WindowsFileOnlyWorkspace } from "./windows-file-only-workspace";
import { WindowsCodingArtifactStore } from "./windows-coding-artifact-store";
import { CodingResultRegistry, CodingResultRegistryError } from "./coding-result-registry";
import { CodingArtifactCleanupError, type CodingArtifactInput, type CodingArtifactSourceRef } from "./coding-artifact-store";
import { clearCodingContinuation, type CodingContinuationRef } from "./coding-continuation";
import type { CodingExportInput } from "./coding-result-export";
import { CodingPrivacyCleanupError, captureCodingPrivacyScope, assertCodingPrivacyScope, retireCodingPrivacyScanners,
  codingPrivacyCleanupFailure, type CodingPrivacyScope } from "./coding-privacy-scanner";
import { loadWindowsCodingNative, retireWindowsCodingNative, WindowsCodingCleanupError,
  type WindowsCodingHandle, type WindowsCodingInfo, type WindowsCodingNative, type WindowsCodingPin } from "./windows-coding-native";
import { windowsCodingSame, windowsCodingWithin } from "./windows-coding-policy";
import { selectCodingStorageBase } from "./coding-storage";
import { titleOf } from "./tasks";

interface OwnedHandle { handle: WindowsCodingHandle; attempted: boolean; closed: boolean }
interface Pin { value: WindowsCodingPin; info: WindowsCodingInfo; handles: OwnedHandle[]; private: boolean }
interface Role { name: string; owned: OwnedHandle; info?: WindowsCodingInfo }
interface Authority {
  taskId: string; owner: string; projectId: string; source: string; title: string;
  ownerCurrent(): boolean; publicationEpoch: number; projectRevision: number; privacy: CodingPrivacyScope; cancel: AbortController;
  retired?: boolean; publishing?: boolean; workspace?: WindowsFileOnlyWorkspace; output?: CodingWorkspaceReview;
  sourceBoundary: CodingArtifactSourceRef | null;
}
interface PendingArtifact { projectId: string; input: CodingArtifactInput }
type ResourceOptions = Pick<ProjectCodingResourcesOptions, "userData" | "protectedPaths" | "currentOwner" | "projectExists" | "changed">;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISCLOSURE = "Windows coding can edit files in a private copy and prepare a review. Commands, tests and dependency installation are unavailable. Captures exclude .git and node_modules; review exports include all captured files, including unchanged files. Continue from a review starts a fresh private copy of its proposed files. Your original project stays unchanged.";
const stale = () => new Error("The coding account, project or folder grant changed. Start a new request.");
const cleanupFailed = () => new Error("Private Windows coding resources could not be closed safely. They were retained for diagnosis.");
const copyFailed = () => new Error("The private Windows coding copy could not be created under its current project grant.");
const safe = (check: () => boolean): boolean => { try { return check() === true; } catch { return false; } };
const nativeUncertain = (error: unknown): boolean => error instanceof WindowsCodingCleanupError || error instanceof CodingArtifactCleanupError || error instanceof CodingPrivacyCleanupError;
const sameIdentity = (a: WindowsCodingInfo, b: WindowsCodingInfo) => a.id === b.id && a.volume === b.volume && a.kind === b.kind;
const overlap = (a: string, b: string) => windowsCodingWithin(a, b) || windowsCodingWithin(b, a);
function ordinary(value: unknown): value is string {
  return typeof value === "string" && value.length > 3 && value.length <= 4096 && /^[A-Za-z]:\\/.test(value) &&
    !value.includes("/") && !/[\p{Cc}\p{Cf}]/u.test(value) && path.normalize(value) === value;
}
/** Unverifiable owned native state is retained for the rest of this process, never silently retried by a new owner. */
const retainedOwners = new Set<WindowsProjectCodingResources>();

export class WindowsProjectCodingResources {
  readonly mode = "files-only" as const;
  readonly folders: ProjectCodingWorkspaces;
  #options: ResourceOptions;
  #api: WindowsCodingNative | null = null;
  #common: string;
  #protected: { pin: Pin; info: WindowsCodingInfo; file?: OwnedHandle }[] = [];
  #roots: string[] = [];
  #pins: Pin[] = [];
  #owned = new Set<OwnedHandle>();
  #commonPin: Pin | null = null;
  #commonRoot: Role | null = null;
  #process: Role | null = null;
  #roles: Role[] = [];
  #copies = ""; #reviews = "";
  #ready = false; #failed = false; #cleanupFailed = false; #orphaned = false; #artifactCleanupFailed = false; #closed = false;
  #message = "Checking private Windows coding storage…";
  #epoch = 0; #publicationEpoch = 0; #projectRevisions = new Map<string, number>(); #invalidationPending = 0;
  #authorities = new WeakMap<TaskSpec, Authority>(); #tasks = new Map<string, Authority>();
  #active = new Map<WindowsFileOnlyWorkspace, Authority>(); #backendClosing = new WeakMap<WindowsFileOnlyWorkspace, Promise<void>>();
  #creating = new Set<Promise<CodingReviewWorkspace>>(); #exporting = new Set<Promise<unknown>>(); #publishing = new Set<Promise<unknown>>();
  #unadopted = new Map<CodingWorkspaceReview, PendingArtifact>();
  #store: WindowsCodingArtifactStore | null = null; #storeOpening: Promise<WindowsCodingArtifactStore> | null = null;
  #registry: CodingResultRegistry | null = null; #registryOpening: Promise<CodingResultRegistry> | null = null;
  #closing: Promise<void> | null = null; #results: CodingResultsAccess;

  private constructor(options: ProjectCodingResourcesOptions) {
    this.#options = { userData: options.userData, protectedPaths: [...options.protectedPaths], currentOwner: options.currentOwner.bind(options),
      projectExists: options.projectExists.bind(options), changed: options.changed?.bind(options) };
    this.folders = options.folders ?? new ProjectCodingWorkspaces(this.#options);
    const selection = options.storage ?? selectCodingStorageBase(); this.#common = selection.common ?? "";
    this.#results = Object.freeze({
      state: projectId => this.#registry?.state(projectId) ?? [],
      review: id => this.#observe(this.#registry?.review(id) ?? Promise.resolve(null)),
      export: (id, destination, current) => this.#observe(this.#registry?.export(id, destination, current) ?? Promise.resolve({ ok: false, message: "No coding review is available to export." })),
      reset: () => { this.#publicationEpoch++; return this.#registryCleanup(this.#resetRegistry()); },
      forgetResult: id => this.#registryCleanup(this.#registry ? this.#registry.forgetResult(id) : this.#registryOpening
        ? this.#registryOpening.then(registry => registry.forgetResult(id)) : Promise.resolve(), true),
      forgetProject: projectId => {
        this.#projectRevisions.set(projectId, (this.#projectRevisions.get(projectId) ?? 0) + 1);
        return this.#registryCleanup(this.#forgetProject(projectId));
      },
    });
  }

  static async create(options: ProjectCodingResourcesOptions): Promise<WindowsProjectCodingResources> {
    const owner = new WindowsProjectCodingResources(options);
    try {
      if (HOST_PLATFORM !== "win32" || HOST_ARCH !== "x64") {
        owner.#message = "Windows copied-file coding requires Windows x64 and verified local NTFS storage."; return owner;
      }
      if (retainedOwners.size || codingPrivacyCleanupFailure()) throw cleanupFailed();
      const selected = [...new Set([owner.#options.userData, ...owner.#options.protectedPaths])];
      if (!ordinary(owner.#common) || !selected.length || selected.length > 63 || selected.some(value => !ordinary(value))) throw stale();
      owner.#api = loadWindowsCodingNative();
      for (const location of selected) owner.#protected.push(owner.#protect(location));
      // API inputs retain ordinary drive paths; GUID final paths are native identity receipts only.
      owner.#roots = selected;
      if (selected.some(root => overlap(root, owner.#common))) throw stale();
      owner.#prepareStorage();
      owner.#roots = [...new Set([...owner.#roots, owner.#common])];
      owner.#storageCurrent(); owner.#ready = true; owner.#message = DISCLOSURE;
    } catch (error) {
      owner.#failed = true;
      if (nativeUncertain(error)) owner.#failure();
      else if (owner.#commonRoot && !owner.#commonRoot.info) owner.#retainNamespace();
      if (!owner.#orphaned && owner.#message === "Checking private Windows coding storage…") owner.#message = "Ember couldn't verify private Windows coding storage and protected paths.";
    }
    return owner;
  }

  get reviewBase(): string { return this.#reviews; }
  results(): Promise<CodingResultsAccess> { return Promise.resolve(this.#results); }
  availability(): { available: boolean; message: string; mode: "files-only"; canContinue: true } {
    const privacy = codingPrivacyCleanupFailure();
    const available = this.#ready && !this.#closed && !this.#failed && !this.#invalidationPending && !this.#artifactCleanupFailed && !privacy;
    return { available, mode: "files-only", canContinue: true, message: this.#closed ? "Coding resources are closed." : this.#invalidationPending
      ? "Private coding work is being closed and removed." : privacy ? "Earlier coding privacy work could not be verified as stopped. Further coding is unavailable."
        : this.#artifactCleanupFailed && !this.#failed ? "Private coding reviews could not be removed. Retry Forget everything; coding resumes after verified cleanup." : this.#message };
  }
  #changed(): void { try { this.#options.changed?.(); } catch { /* Observation never grants authority. */ } }
  #owner(): string | null { try { const value = this.#options.currentOwner(); return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null; } catch { return null; } }
  #project(value: string): boolean { return uuid.test(value) && safe(() => this.#options.projectExists(value)); }
  #failure(): void {
    this.#failed = true; this.#cleanupFailed = true; this.#message = "Earlier Windows coding cleanup could not be verified. Private data was retained and further coding is unavailable.";
    retireWindowsCodingNative(); retainedOwners.add(this); this.#changed();
  }
  #retainNamespace(): Error {
    this.#failed = true; this.#orphaned = true;
    this.#message = "Private Windows coding storage no longer has a verified owned namespace. It was retained and coding remains unavailable.";
    this.#changed(); return cleanupFailed();
  }
  #own(handle: WindowsCodingHandle): OwnedHandle {
    if ([...this.#owned].some(value => value.handle === handle)) throw new WindowsCodingCleanupError();
    const value = { handle, attempted: false, closed: false }; this.#owned.add(value); return value;
  }
  #closeHandle(value: OwnedHandle): void {
    if (value.closed) return;
    if (value.attempted) throw new WindowsCodingCleanupError();
    value.attempted = true;
    try { this.#api!.close(value.handle); value.closed = true; this.#owned.delete(value); }
    catch { this.#failure(); throw new WindowsCodingCleanupError(); }
  }
  #pin(location: string, mode: "read" | "base", retained = true, privateDirectory = false): Pin {
    const value = this.#api!.pin(location, mode), handles = value.handles.map(handle => this.#own(handle));
    const pin = { value, handles, info: this.#api!.info(value.handle), private: privateDirectory };
    if (retained) this.#pins.push(pin);
    if (privateDirectory) this.#api!.assertPrivate(value.handle);
    return pin;
  }
  #closePin(pin: Pin): void { for (const handle of pin.handles.slice().reverse()) this.#closeHandle(handle); }
  #protect(location: string): { pin: Pin; info: WindowsCodingInfo; file?: OwnedHandle } {
    try { const pin = this.#pin(location, "read"); return { pin, info: pin.info }; }
    catch (error) {
      if (!(error instanceof ScopedCodingFileError) || !["missing", "unsupported"].includes(error.code)) throw error;
      const pin = this.#pin(path.dirname(location), "read"), file = this.#own(this.#api!.open(pin.value.handle, path.basename(location), "file", "source"));
      return { pin, file, info: this.#api!.info(file.handle) };
    }
  }
  #newDirectory(parent: WindowsCodingHandle, name: string, processRoot = false): Role {
    const role: Role = { name, owned: this.#own(this.#api!.create(parent, name, "directory")) };
    if (processRoot) this.#process = role; else this.#roles.push(role);
    this.#api!.assertPrivate(role.owned.handle); role.info = this.#api!.info(role.owned.handle); return role;
  }
  #prepareStorage(): void {
    try {
      this.#pin(this.#common, "read");
      // Existing names, even empty directories, have no fresh COPY capability owned by this resource.
      this.#orphaned = true;
      this.#message = "Earlier private Windows coding data has no owned cleanup receipt. It was retained and coding remains unavailable.";
      throw cleanupFailed();
    }
    catch (error) {
      if (!(error instanceof ScopedCodingFileError) || error.code !== "missing") {
        if (!nativeUncertain(error)) this.#retainNamespace();
        throw error;
      }
    }
    const parent = this.#pin(path.dirname(this.#common), "base");
    const root: Role = { name: path.basename(this.#common), owned: this.#own(this.#api!.create(parent.value.handle, path.basename(this.#common), "directory")) };
    this.#commonRoot = root;
    this.#api!.assertPrivate(root.owned.handle); root.info = this.#api!.info(root.owned.handle);
    const common: Pin = { value: { handle: root.owned.handle, handles: [root.owned.handle], path: this.#common }, handles: [root.owned], info: root.info, private: true };
    this.#commonPin = common; this.#pins.push(common);
    if (this.#protected.some(value => overlap(value.info.finalPath, common.info.finalPath))) throw stale();
    const processRoot = this.#newDirectory(common.value.handle, `process-${randomUUID()}`, true);
    this.#newDirectory(processRoot.owned.handle, "copies"); this.#newDirectory(processRoot.owned.handle, "reviews");
    this.#copies = path.join(this.#common, processRoot.name, "copies");
    this.#reviews = path.join(this.#common, processRoot.name, "reviews");
  }
  #storageCurrent(): void {
    if (!this.#api || !this.#commonPin) throw cleanupFailed();
    try {
      for (const pin of this.#pins) {
        if (!windowsCodingSame(pin.info, this.#api.info(pin.value.handle), false)) throw cleanupFailed();
        if (pin.private) this.#api.assertPrivate(pin.value.handle);
      }
      for (const value of this.#protected) if (!windowsCodingSame(value.info, this.#api.info(value.file?.handle ?? value.pin.value.handle), false)) throw cleanupFailed();
      for (const role of [this.#process, ...this.#roles]) if (role) {
        if (!role.info || role.owned.closed || !windowsCodingSame(role.info, this.#api.info(role.owned.handle), false)) throw cleanupFailed();
        this.#api.assertPrivate(role.owned.handle);
      }
      const entries = this.#api.list(this.#commonPin.value.handle, 10_000);
      if (!this.#process || entries.length !== 1 || entries[0].name !== this.#process.name || entries[0].id !== this.#process.info?.id) throw cleanupFailed();
    } catch (error) {
      if (nativeUncertain(error)) { this.#failure(); throw error; }
      throw this.#retainNamespace();
    }
  }

  async validateSource(folder: CodingWorkspace): Promise<CodingWorkspace> {
    const selected = folder?.path, current = folder?.current?.bind(folder);
    if (!this.#ready || this.#closed || this.#failed || !current || !safe(current) || !ordinary(selected)) throw stale();
    let pin: Pin | undefined;
    try {
      this.#storageCurrent(); pin = this.#pin(selected, "read", false);
      const source = pin.info;
      if (source.kind !== "directory" || overlap(source.finalPath, this.#commonPin!.info.finalPath) || this.#protected.some(value => overlap(source.finalPath, value.info.finalPath) || sameIdentity(source, value.info))) throw stale();
      for (const handle of pin.value.handles) {
        const ancestor = this.#api!.info(handle);
        if (sameIdentity(ancestor, this.#commonPin!.info) || this.#protected.some(value => sameIdentity(ancestor, value.info))) throw stale();
      }
      for (const value of [this.#commonPin!, ...this.#protected.map(value => value.pin)]) {
        if (value.value.handles.some(handle => sameIdentity(source, this.#api!.info(handle)))) throw stale();
      }
      // Native pins hold the selected namespace stable while the host spells its canonical drive path.
      const canonical = fs.realpathSync.native(selected);
      if (!ordinary(canonical) || !safe(current)) throw stale();
      return Object.freeze({ path: canonical, current });
    } catch (error) { if (nativeUncertain(error)) this.#failure(); throw nativeUncertain(error) ? error : stale(); }
    finally { if (pin) this.#closePin(pin); }
  }
  workspace(projectId: string | null): { path: string; projectId: string; current(): boolean } | null {
    if (!projectId || !this.availability().available || !this.#project(projectId)) return null;
    const folder = this.folders.capture(projectId);
    return folder ? Object.freeze({ path: folder.path, projectId, current: folder.current }) : null;
  }
  captureContinuation(id: string, projectId: string): CodingContinuationRef | null {
    return this.availability().available ? this.#registry?.captureContinuation(id, projectId) ?? null : null;
  }
  continuationCurrent(ref: CodingContinuationRef, projectId: string): boolean {
    return this.availability().available && this.#registry?.continuationCurrent(ref, projectId) === true;
  }

  createWorkspace(spec: TaskSpec, signal: AbortSignal, admit: () => boolean): Promise<CodingReviewWorkspace> {
    const grant = spec.codingWorkspace, projectId = grant?.projectId, owner = this.#owner();
    if (!this.availability().available || !grant || !projectId || !owner || !this.#project(projectId) || this.#tasks.has(spec.id)) return Promise.reject(stale());
    let privacy: CodingPrivacyScope;
    try { privacy = captureCodingPrivacyScope(); } catch (error) { if (nativeUncertain(error)) this.#failure(); return Promise.reject(error); }
    const source = grant.path, sourceCurrent = grant.current.bind(grant), selected = this.folders.capture(projectId), epoch = this.#epoch;
    const continuationRef = grant.continuation, hasContinuation = continuationRef !== undefined;
    let continuationReady = false;
    const authority: Authority = { taskId: spec.id, owner, projectId, source,
      title: titleOf(spec.goal).replace(/[\p{Cc}\p{Cf}]/gu, value => `\\u${value.codePointAt(0)!.toString(16).padStart(4, "0")}`),
      ownerCurrent: this.folders.ownerCurrent(), publicationEpoch: this.#publicationEpoch, projectRevision: this.#projectRevisions.get(projectId) ?? 0,
      privacy, cancel: new AbortController(), sourceBoundary: null };
    const current = () => {
      try { assertCodingPrivacyScope(privacy); } catch { return false; }
      return !this.#closed && !this.#failed && this.#epoch === epoch && !signal.aborted && !authority.cancel.signal.aborted && this.availability().available &&
        this.#owner() === owner && safe(authority.ownerCurrent) && this.#project(projectId) && selected?.path === source && safe(selected.current) && safe(sourceCurrent) && safe(admit) &&
        (!hasContinuation || continuationReady || this.#registry?.continuationCurrent(continuationRef!, projectId) === true);
    };
    if (!current()) return Promise.reject(stale());
    this.#tasks.set(spec.id, authority); this.#authorities.set(spec, authority);
    const pending = (async () => {
      let continuation: CodingExportInput | undefined;
      try {
        await this.validateSource({ path: source, current: sourceCurrent }); if (!current()) throw stale();
        this.#storageCurrent(); const store = await this.#storeValue(); if (!current()) throw stale();
        authority.sourceBoundary = await store.sourceBoundary(source, () => { if (!current()) throw stale(); });
        if (!authority.sourceBoundary || !current()) throw stale();
        if (hasContinuation) {
          if (!this.#registry) throw stale();
          continuation = await this.#registry.loadContinuation(continuationRef!, projectId, authority.sourceBoundary, current);
          if (!current()) throw stale();
        }
        const backend = await WindowsFileOnlyWorkspace.create({ source, privateBase: this.#copies, protectedPaths: this.#roots,
          signal: AbortSignal.any([signal, authority.cancel.signal]), current, scope: { excludeRoots: [".git", "node_modules"] }, reviewBase: this.#reviews,
          ...(continuation ? { continuation: { baseline: continuation.baseline, proposed: continuation.proposed, scope: continuation.scope, current } } : {}),
          review: { binding: { owner, session: randomUUID(), snapshot: randomUUID() }, store,
            sourceBoundary: authority.sourceBoundary ?? undefined, current: () => this.#reviewCurrent(authority) } });
        authority.workspace = backend; this.#active.set(backend, authority);
        if (!current()) { await backend.stop(); await this.#closeBackend(backend); throw stale(); }
        // The admitted copy owns its fresh bytes; predecessor Forget cannot revoke this independent session.
        continuationReady = true;
        return this.#wrapped(backend, authority);
      } catch (error) {
        if (nativeUncertain(error) || authority.workspace && this.#active.has(authority.workspace)) this.#failure();
        if (!authority.workspace) { this.#tasks.delete(spec.id); this.#authorities.delete(spec); }
        if (nativeUncertain(error)) throw error;
        // Raw filesystem errors may contain a private host path; outward errors use fixed host-owned words.
        throw copyFailed();
      } finally { clearCodingContinuation(continuation); }
    })();
    this.#creating.add(pending); void pending.then(() => this.#creating.delete(pending), () => this.#creating.delete(pending)); return pending;
  }
  #closeBackend(backend: WindowsFileOnlyWorkspace): Promise<void> {
    const prior = this.#backendClosing.get(backend); if (prior) return prior;
    const authority = this.#active.get(backend);
    const closing = Promise.resolve().then(() => backend.close()).then(() => {
      this.#active.delete(backend);
      if (authority) { authority.workspace = undefined; if (!authority.output) this.#tasks.delete(authority.taskId); }
    }, error => { this.#failure(); throw error; });
    this.#backendClosing.set(backend, closing); return closing;
  }
  #wrapped(backend: WindowsFileOnlyWorkspace, authority: Authority): CodingReviewWorkspace {
    return new Proxy(backend, { get: (target, key) => {
      if (key === "close") return () => this.#closeBackend(backend);
      if (key === "exportReview") return (base: string) => {
        if (base !== this.#reviews) return Promise.reject(stale());
        const pending = target.exportReview(base).then(output => {
          // No await or arbitrary callback separates retention of these exact capabilities from producer transfer.
          authority.output = output; authority.sourceBoundary = target.sourceBoundary;
          this.#unadopted.set(output, { projectId: authority.projectId, input: Object.freeze({ directory: output.directory, artifact: output.artifact }) });
          target.transferReview(output); return output;
        });
        this.#exporting.add(pending); void pending.then(() => this.#exporting.delete(pending), error => { this.#exporting.delete(pending); if (nativeUncertain(error)) this.#failure(); });
        return pending;
      };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  #reviewCurrent(authority: Authority): boolean {
    try { assertCodingPrivacyScope(authority.privacy); } catch { return false; }
    return !this.#closed && !this.#failed && !authority.retired && this.#owner() === authority.owner && safe(authority.ownerCurrent) && this.#project(authority.projectId) &&
      this.#publicationEpoch === authority.publicationEpoch && (this.#projectRevisions.get(authority.projectId) ?? 0) === authority.projectRevision;
  }
  #storeValue(): Promise<WindowsCodingArtifactStore> {
    if (this.#store) return Promise.resolve(this.#store);
    if (!this.#storeOpening) this.#storeOpening = WindowsCodingArtifactStore.create({ privateBase: this.#reviews, protectedPaths: this.#roots })
      .then(store => { this.#store = store; return store; }, error => { this.#storeOpening = null; if (nativeUncertain(error)) this.#failure(); throw error; });
    return this.#storeOpening;
  }
  #registryValue(): Promise<CodingResultRegistry> {
    if (this.#registry) return Promise.resolve(this.#registry);
    if (!this.#registryOpening) this.#registryOpening = this.#storeValue().then(store => CodingResultRegistry.create({ privateBase: this.#reviews,
      currentOwner: this.#options.currentOwner, projectExists: this.#options.projectExists, store })).then(registry => { this.#registry = registry; return registry; }, error => {
      this.#registryOpening = null; throw error;
    });
    return this.#registryOpening;
  }
  publish(spec: TaskSpec, output: CodingWorkspaceReview, status: "done" | "failed" | "stopped", checks: ScopedCodingChecks) {
    const authority = this.#authorities.get(spec), artifact = this.#unadopted.get(output);
    if (!authority || authority.publishing || this.#tasks.get(spec.id) !== authority || authority.output !== output || !artifact) return Promise.reject(stale());
    authority.publishing = true;
    const pending = (async () => {
      try {
        const registry = await this.#registryValue();
        const summary = await registry.put({ expectedOwner: authority.owner, projectId: authority.projectId, taskId: spec.id, title: authority.title,
          sourcePath: authority.source, sourceBoundary: authority.sourceBoundary, status, checks, current: () => this.#reviewCurrent(authority), output });
        this.#unadopted.delete(output); this.#changed(); return summary;
      } catch (error) {
        try { const registry = await this.#registryValue(); await registry.discard(artifact.input); this.#unadopted.delete(output); }
        catch (cleanup) { this.#artifactCleanupFailed = true; if (nativeUncertain(cleanup)) this.#failure(); }
        if (nativeUncertain(error)) this.#failure(); this.#changed(); throw error;
      } finally { this.#tasks.delete(spec.id); this.#authorities.delete(spec); authority.output = undefined; }
    })();
    this.#publishing.add(pending); void pending.then(() => this.#publishing.delete(pending), () => this.#publishing.delete(pending)); return pending;
  }
  async #discardUnadopted(projectId?: string): Promise<void> {
    let failed = false;
    const store = this.#store ?? (this.#storeOpening ? await this.#storeOpening : null);
    if (!store) { if (this.#unadopted.size) throw cleanupFailed(); return; }
    for (const [output, artifact] of [...this.#unadopted]) if (!projectId || artifact.projectId === projectId) {
      try { await store.discard(artifact.input); this.#unadopted.delete(output); }
      catch (error) { failed = true; if (nativeUncertain(error)) this.#failure(); }
    }
    if (failed) throw cleanupFailed();
  }
  async #resetRegistry(): Promise<void> {
    const registry = this.#registry ?? (this.#registryOpening ? await this.#registryOpening : null);
    let failed = false;
    try { if (registry) await registry.reset(); } catch (error) { failed = true; if (nativeUncertain(error)) this.#failure(); }
    try { await this.#discardUnadopted(); } catch { failed = true; }
    if (!registry && this.#store) try { await this.#store.cleanup(new Set()); } catch (error) { failed = true; if (nativeUncertain(error)) this.#failure(); }
    if (failed) throw cleanupFailed();
  }
  async #forgetProject(projectId: string): Promise<void> {
    const registry = this.#registry ?? (this.#registryOpening ? await this.#registryOpening : null);
    if (registry) await registry.forgetProject(projectId);
    await this.#discardUnadopted(projectId);
  }
  async #observe<T>(pending: Promise<T>): Promise<T> { try { return await pending; } catch (error) { if (nativeUncertain(error)) this.#failure(); throw error; } }
  async #registryCleanup(pending: Promise<void>, allowMissing = false): Promise<void> {
    try { await pending; this.#artifactCleanupFailed = this.#unadopted.size > 0; this.#changed(); }
    catch (error) {
      if (allowMissing && error instanceof CodingResultRegistryError && ["stale", "invalid"].includes(error.code)) throw error;
      this.#artifactCleanupFailed = true; if (nativeUncertain(error)) this.#failure(); this.#changed(); throw cleanupFailed();
    }
  }
  async #drainResults(): Promise<void> {
    for (;;) { const pending = [...this.#exporting, ...this.#publishing]; if (!pending.length) return; await Promise.allSettled(pending); }
  }
  #emptyRoles(): void {
    if (!this.#process) return;
    this.#storageCurrent();
    for (const role of this.#roles) if (this.#api!.list(role.owned.handle, 1).length) throw cleanupFailed();
    const children = this.#api!.list(this.#process.owned.handle, 3);
    if (children.length !== this.#roles.length || children.some(child => !this.#roles.some(role => role.name === child.name && role.info?.id === child.id))) throw cleanupFailed();
  }
  invalidate(): Promise<void> {
    this.#epoch++; this.#publicationEpoch++; this.folders.ownerReset(); this.#invalidationPending++;
    for (const authority of this.#tasks.values()) { authority.retired = true; authority.cancel.abort(); }
    const creating = [...this.#creating].map(pending => pending.then(() => undefined, () => undefined));
    const privacy = retireCodingPrivacyScanners();
    const backends = [...this.#active.keys()];
    const stopping = backends.map(backend => { try { return backend.stop(); } catch { return Promise.reject(cleanupFailed()); } });
    const closing = backends.map(backend => this.#closeBackend(backend));
    const pending = (async () => {
      try {
        const settled = await Promise.allSettled([...stopping, ...closing, ...creating, privacy]);
        if (settled.some(value => value.status === "rejected")) this.#failure();
        const remaining = await Promise.allSettled([...this.#active.keys()].map(backend => this.#closeBackend(backend)));
        if (remaining.some(value => value.status === "rejected")) this.#failure();
        await this.#drainResults();
        for (const authority of this.#tasks.values()) { authority.workspace = undefined; authority.output = undefined; }
        this.#tasks.clear(); this.#authorities = new WeakMap();
        let artifactsFailed = false;
        try { await this.#registryCleanup(this.#resetRegistry()); } catch { artifactsFailed = true; }
        try { this.#emptyRoles(); } catch { if (!artifactsFailed) this.#failure(); }
        if (this.#cleanupFailed || this.#orphaned || artifactsFailed) throw cleanupFailed();
      } finally { this.#invalidationPending--; this.#changed(); }
    })();
    this.#changed(); return pending;
  }
  close(): Promise<void> {
    if (!this.#closing) {
      this.#closed = true; const invalidated = this.invalidate();
      this.#closing = (async () => {
        let failed = false;
        try { await invalidated; } catch { failed = true; }
        await this.#drainResults();
        try {
          if (this.#registryOpening) await (await this.#registryOpening).close();
          else if (this.#storeOpening) await (await this.#storeOpening).close();
        } catch { failed = true; this.#failure(); }
        if (!failed && this.#commonRoot) {
          try {
            if (this.#process) {
              this.#emptyRoles();
              for (const role of this.#roles.slice().reverse()) { this.#api!.remove(role.owned.handle); this.#closeHandle(role.owned); }
              if (this.#api!.list(this.#process.owned.handle, 1).length) throw cleanupFailed();
              this.#api!.remove(this.#process.owned.handle); this.#closeHandle(this.#process.owned);
            }
            if (this.#api!.list(this.#commonRoot.owned.handle, 1).length) throw cleanupFailed();
            this.#api!.remove(this.#commonRoot.owned.handle); this.#closeHandle(this.#commonRoot.owned);
          } catch { failed = true; this.#failure(); }
        }
        if (!this.#cleanupFailed) {
          try { for (const value of [...this.#owned].reverse()) this.#closeHandle(value); } catch { failed = true; }
        }
        if (failed || this.#orphaned || this.#cleanupFailed) throw cleanupFailed();
      })();
    }
    return this.#closing;
  }
}
