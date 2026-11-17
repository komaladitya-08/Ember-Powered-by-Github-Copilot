/** Host-owned Windows copies, fixed Node assets and reviews. No executable discovery or source grant. */
import path from "node:path/win32";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import { ProjectCodingWorkspaces } from "./project-coding-workspaces";
import type { ProjectCodingResourcesOptions, CodingResultsAccess } from "./coding-resources";
import type { CodingWorkspace } from "./coding-workspace";
import type { TaskSpec } from "./worker";
import type { ScopedCodingChecks } from "./scoped-coding-worker";
import type { CodingCommandWorkspace, CodingPlatformAdapter, CodingReviewWorkspace, CodingWorkspaceReview } from "./coding-platform";
import { ScopedCodingFileError } from "./coding-platform";
import { WindowsFileOnlyWorkspace, type WindowsFileOnlyWorkspaceInput } from "./windows-file-only-workspace";
import { WindowsNodeWorkspace } from "./windows-node-workspace";
import { windowsNodeCodingPlatform } from "./windows-node-coding-platform";
import { WindowsCodingArtifactStore } from "./windows-coding-artifact-store";
import { CodingResultRegistry, CodingResultRegistryError } from "./coding-result-registry";
import { CodingArtifactCleanupError, type CodingArtifactInput, type CodingArtifactSourceRef } from "./coding-artifact-store";
import { clearCodingContinuation, type CodingContinuationRef } from "./coding-continuation";
import { createCodingReviewExport, decodeCodingReviewExport, type CodingExportInput } from "./coding-result-export";
import { WslCodingWorkspace, WslCodingCleanupError, wslCodingPlatform } from "./wsl-coding-workspace";
import type { WslCodingConnection } from "./wsl-coding-connection";
import { WSL_CODING_READINESS } from "../../shared/wsl-coding-readiness";
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
  retired?: boolean; publishing?: boolean; workspace?: WindowsOwnedWorkspace; output?: CodingWorkspaceReview;
  sourceBoundary: CodingArtifactSourceRef | null;
}
interface PendingArtifact { projectId: string; input: CodingArtifactInput }
declare const commandParentBrand: unique symbol;
export interface WindowsOwnedCommandParentRef { readonly scope: "windows-owned-command-parent"; readonly [commandParentBrand]: true }
export interface WindowsOwnedCommandParentFacts {
  readonly parent: string; readonly protectedPaths: readonly string[]; readonly common: WindowsCodingInfo; readonly copies: WindowsCodingInfo;
}
const commandParents = new WeakMap<object, { verify(): Readonly<WindowsOwnedCommandParentFacts>; refresh(): Readonly<WindowsOwnedCommandParentFacts>; current(): void }>();
/** Observation of an existing private resource issuer only. No path, callback or serialized receipt can register one. */
export function requireWindowsOwnedCommandParent(ref: WindowsOwnedCommandParentRef): Readonly<WindowsOwnedCommandParentFacts> {
  const value = ref && typeof ref === "object" ? commandParents.get(ref) : undefined;
  if (!value) throw new ScopedCodingFileError("boundary"); return value.verify();
}
export function refreshWindowsOwnedCommandParent(ref: WindowsOwnedCommandParentRef): Readonly<WindowsOwnedCommandParentFacts> {
  const value = ref && typeof ref === "object" ? commandParents.get(ref) : undefined;
  if (!value) throw new ScopedCodingFileError("boundary"); return value.refresh();
}
/** Pure lifetime observation for the final no-callback native admission segment. */
export function requireWindowsOwnedCommandParentCurrent(ref: WindowsOwnedCommandParentRef): void {
  const value = ref && typeof ref === "object" ? commandParents.get(ref) : undefined;
  if (!value) throw new ScopedCodingFileError("boundary"); value.current();
}
export interface WindowsWslCodingBinding {
  /** Captured project/distro/consent/policy receipt. False permanently retires this session. */
  current(): boolean;
  /** Only a trusted installed helper and pinned tool archive may be returned here. */
  open(): Promise<{ connection: WslCodingConnection; typescriptArchive: Buffer }>;
}
type WindowsOwnedWorkspace = WindowsFileOnlyWorkspace | WindowsNodeWorkspace | WslCodingWorkspace;
type ResourceOptions = Pick<ProjectCodingResourcesOptions, "userData" | "protectedPaths" | "currentOwner" | "projectExists" | "changed" | "resourcesPath">;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DISCLOSURE = "Windows coding can edit files in a private copy and prepare a review. Commands, tests and dependency installation are unavailable. Captures exclude .git and node_modules; review exports include all captured files, including unchanged files. Continue from a review starts a fresh private copy of its proposed files. Your original project stays unchanged.";
const NODE_DISCLOSURE = "Windows coding can edit a private copy and run checks with bundled Node. Shells, npm, dependency installation, network access and child processes are unavailable. Captures exclude .git and node_modules; review exports include all captured files, including unchanged files. Continue from a review starts a fresh private copy of its proposed files. Your original project stays unchanged.";
const stale = () => new Error("The coding account, project or folder grant changed. Start a new request.");
const cleanupFailed = () => new Error("Private Windows coding resources could not be closed safely. They were retained for diagnosis.");
const copyFailed = () => new Error("The private Windows coding copy could not be created under its current project grant.");
class WindowsProjectCodingResourcesCleanupError extends WindowsCodingCleanupError {
  constructor() { super(); this.name = "WindowsProjectCodingResourcesCleanupError"; this.message = cleanupFailed().message; }
}
const safe = (check: () => boolean): boolean => { try { return check() === true; } catch { return false; } };
const nativeUncertain = (error: unknown): boolean => error instanceof WindowsCodingCleanupError || error instanceof CodingArtifactCleanupError || error instanceof CodingPrivacyCleanupError || error instanceof WslCodingCleanupError;
const sameIdentity = (a: WindowsCodingInfo, b: WindowsCodingInfo) => a.id === b.id && a.volume === b.volume && a.kind === b.kind;
const overlap = (a: string, b: string) => windowsCodingWithin(a, b) || windowsCodingWithin(b, a);
function ordinary(value: unknown): value is string {
  return typeof value === "string" && value.length > 3 && value.length <= 4096 && /^[A-Za-z]:\\/.test(value) &&
    !value.includes("/") && !/[\p{Cc}\p{Cf}]/u.test(value) && path.normalize(value) === value;
}
/** Unverifiable owned native state is retained for the rest of this process, never silently retried by a new owner. */
const retainedOwners = new Set<WindowsProjectCodingResources>();

export class WindowsProjectCodingResources {
  #node: boolean;
  get mode(): "files-only" | "commands" { return this.#node ? "commands" : "files-only"; }
  readonly folders: ProjectCodingWorkspaces;
  readonly nodePlatform: CodingPlatformAdapter;
  readonly filePlatform: Pick<CodingPlatformAdapter, "files">;
  readonly wslPlatform: CodingPlatformAdapter;
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
  #copies = ""; #reviews = ""; #assets = "";
  #nodePresent = false;
  #ready = false; #failed = false; #cleanupFailed = false; #orphaned = false; #artifactCleanupFailed = false; #closed = false;
  #terminal?: WindowsCodingCleanupError;
  #message = "Checking private Windows coding storage…";
  #epoch = 0; #publicationEpoch = 0; #projectRevisions = new Map<string, number>(); #invalidationPending = 0;
  #authorities = new WeakMap<TaskSpec, Authority>(); #tasks = new Map<string, Authority>();
  #active = new Map<WindowsOwnedWorkspace, Authority>(); #backendClosing = new WeakMap<WindowsOwnedWorkspace, Promise<void>>();
  #nodeWrappers = new WeakMap<CodingReviewWorkspace, WindowsNodeWorkspace>();
  #fileWrappers = new WeakMap<CodingReviewWorkspace, WindowsFileOnlyWorkspace>();
  #wslWrappers = new WeakMap<CodingReviewWorkspace, WslCodingWorkspace>();
  #captures = new Set<WindowsFileOnlyWorkspace>();
  #connections = new Set<WslCodingConnection>();
  #creating = new Set<Promise<CodingReviewWorkspace>>(); #exporting = new Set<Promise<unknown>>(); #publishing = new Set<Promise<unknown>>();
  #unadopted = new Map<CodingWorkspaceReview, PendingArtifact>();
  #store: WindowsCodingArtifactStore | null = null; #storeOpening: Promise<WindowsCodingArtifactStore> | null = null;
  #registry: CodingResultRegistry | null = null; #registryOpening: Promise<CodingResultRegistry> | null = null;
  #closing: Promise<void> | null = null; #results: CodingResultsAccess;

  private constructor(options: ProjectCodingResourcesOptions, node = false) {
    this.#node = node;
    this.#options = { userData: options.userData, protectedPaths: [...options.protectedPaths], currentOwner: options.currentOwner.bind(options),
      projectExists: options.projectExists.bind(options), changed: options.changed?.bind(options), resourcesPath: options.resourcesPath };
    const resolve = (workspace: CodingReviewWorkspace) => {
      const owner = this.#nodeWrappers.get(workspace);
      if (!owner || !this.#node) throw new ScopedCodingFileError("boundary");
      return owner;
    };
    const nodePlatform: CodingPlatformAdapter = {
      facts: (workspace, facts) => windowsNodeCodingPlatform.facts(resolve(workspace), facts),
      files: async (workspace, signal) => windowsNodeCodingPlatform.files(resolve(workspace), signal),
    };
    this.nodePlatform = Object.freeze(nodePlatform);
    const resolveWsl = (workspace: CodingReviewWorkspace) => {
      const owner = this.#wslWrappers.get(workspace); if (!owner) throw new ScopedCodingFileError("boundary"); return owner;
    };
    this.wslPlatform = Object.freeze({ facts: (workspace: CodingCommandWorkspace, facts: Parameters<CodingPlatformAdapter["facts"]>[1]) => wslCodingPlatform.facts(resolveWsl(workspace), facts),
      files: (workspace: CodingReviewWorkspace, signal: AbortSignal) => wslCodingPlatform.files(resolveWsl(workspace), signal) });
    this.filePlatform = Object.freeze({ files: async (workspace: CodingReviewWorkspace, signal: AbortSignal) => {
      const owner = this.#fileWrappers.get(workspace); if (!owner) throw new ScopedCodingFileError("boundary");
      return WindowsFileOnlyWorkspace.prototype.filesBroker.call(owner, signal);
    } });
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
    return this.#create(options, false);
  }
  /** Fixed host selection. A failed Node capability never becomes a files-only fallback. */
  static async createNode(options: ProjectCodingResourcesOptions): Promise<WindowsProjectCodingResources> {
    return this.#create(options, true);
  }
  static async #create(options: ProjectCodingResourcesOptions, node: boolean): Promise<WindowsProjectCodingResources> {
    const owner = new WindowsProjectCodingResources(options, node);
    try {
      if (HOST_PLATFORM !== "win32" || HOST_ARCH !== "x64") {
        owner.#message = "Windows copied-file coding requires Windows x64 and verified local NTFS storage."; return owner;
      }
      if (retainedOwners.size || codingPrivacyCleanupFailure()) throw cleanupFailed();
      if (node && !ordinary(owner.#options.resourcesPath)) throw stale();
      const selected = [...new Set([owner.#options.userData, ...owner.#options.protectedPaths, ...(node ? [owner.#options.resourcesPath!] : [])])];
      if (!ordinary(owner.#common) || !selected.length || selected.length > 63 || selected.some(value => !ordinary(value))) throw stale();
      if (node) owner.#nodePresent = owner.#nodePresence();
      owner.#api = loadWindowsCodingNative();
      for (const location of selected) owner.#protected.push(owner.#protect(location));
      // API inputs retain ordinary drive paths; GUID final paths are native identity receipts only.
      owner.#roots = selected;
      if (selected.some(root => overlap(root, owner.#common))) throw stale();
      owner.#prepareStorage();
      owner.#roots = [...new Set([...owner.#roots, owner.#common])];
      owner.#storageCurrent(); owner.#ready = true; owner.#message = node ? NODE_DISCLOSURE : DISCLOSURE;
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
  availability(disclosure?: "files-only" | "commands"): { available: boolean; message: string; mode: "files-only" | "commands"; canContinue: true } {
    const privacy = codingPrivacyCleanupFailure();
    const mode = disclosure === "files-only" ? "files-only" : this.mode;
    const missing = mode === "commands" && !this.#nodePresent;
    const available = this.#ready && !this.#closed && !this.#failed && !this.#invalidationPending && !this.#artifactCleanupFailed && !privacy && !missing;
    return { available, mode, canContinue: true, message: this.#closed ? "Coding resources are closed." : this.#invalidationPending
      ? "Private coding work is being closed and removed." : privacy ? "Earlier coding privacy work could not be verified as stopped. Further coding is unavailable."
        : this.#artifactCleanupFailed && !this.#failed ? "Private coding reviews could not be removed. Retry Forget everything; coding resumes after verified cleanup."
          : missing && this.#ready && !this.#failed ? "Bundled Node is unavailable. Commands cannot run in this coding session."
          : mode === "files-only" && this.#message === NODE_DISCLOSURE ? DISCLOSURE : this.#message };
  }
  #nodePresence(): boolean {
    if (!this.#node || !ordinary(this.#options.resourcesPath)) return false;
    return ["node.exe", "LICENSE", "build-receipt.json"].every(name => {
      try {
        const info = fs.lstatSync(path.join(this.#options.resourcesPath!, "coding", "windows-node-x64", name));
        return info.isFile() && !info.isSymbolicLink() && info.nlink === 1;
      } catch { return false; }
    });
  }
  #changed(): void { try { this.#options.changed?.(); } catch { /* Observation never grants authority. */ } }
  #owner(): string | null { try { const value = this.#options.currentOwner(); return typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? value : null; } catch { return null; } }
  #project(value: string): boolean { return uuid.test(value) && safe(() => this.#options.projectExists(value)); }
  #failure(): void {
    this.#failed = true; this.#cleanupFailed = true; this.#message = "Earlier Windows coding cleanup could not be verified. Private data was retained and further coding is unavailable.";
    retireWindowsCodingNative(); this.#terminal ??= new WindowsProjectCodingResourcesCleanupError(); retainedOwners.add(this); this.#changed();
  }
  #known(): void { if (this.#terminal) throw this.#terminal; }
  #admit(check: () => boolean): boolean {
    this.#known(); let result = false;
    try { result = check() === true; }
    catch (error) { if (nativeUncertain(error)) { this.#failure(); throw this.#terminal; } }
    this.#known(); return result;
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
    if (this.#node) this.#newDirectory(processRoot.owned.handle, "assets");
    this.#copies = path.join(this.#common, processRoot.name, "copies");
    this.#reviews = path.join(this.#common, processRoot.name, "reviews");
    this.#assets = path.join(this.#common, processRoot.name, "assets");
  }
  #storageCurrent(): void {
    this.#known();
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
  #commandStorage(): Readonly<WindowsOwnedCommandParentFacts> {
    this.#known();
    try {
      this.#storageCurrent();
      if (!this.#node || !this.#commonRoot?.info || !this.#process?.info || this.#roles.length !== 3) throw cleanupFailed();
      const children = this.#api!.list(this.#process.owned.handle, 3);
      if (children.length !== 3 || children.some(child => !this.#roles.some(role => role.name === child.name && role.info?.id === child.id)) ||
          this.#roles.some(role => children.filter(child => child.name === role.name && child.id === role.info?.id).length !== 1) ||
          ["copies", "reviews", "assets"].some(name => this.#roles.filter(role => role.name === name).length !== 1)) throw cleanupFailed();
      const copies = this.#roles.find(role => role.name === "copies")!;
      if (!copies.info || windowsCodingSame(this.#commonRoot.info, copies.info, false) || !windowsCodingWithin(copies.info.finalPath, this.#commonRoot.info.finalPath)) throw cleanupFailed();
      return Object.freeze({ parent: this.#copies, protectedPaths: Object.freeze([...this.#roots]),
        common: Object.freeze({ ...this.#commonRoot.info }), copies: Object.freeze({ ...copies.info }) });
    } catch { this.#failure(); throw this.#terminal; }
  }
  #issueCommandParent(authority: Authority, current: () => boolean, signal: AbortSignal, epoch: number): WindowsOwnedCommandParentRef {
    this.#known(); if (!current()) throw stale(); this.#commandStorage(); if (!current()) throw stale();
    const ref = Object.freeze({ scope: "windows-owned-command-parent" as const }) as WindowsOwnedCommandParentRef;
    const pure = () => {
      this.#known(); assertCodingPrivacyScope(authority.privacy);
      if (this.#closed || this.#failed || this.#epoch !== epoch || this.#invalidationPending || authority.retired || signal.aborted || authority.cancel.signal.aborted ||
          this.#tasks.get(authority.taskId) !== authority || !authority.workspace || this.#active.get(authority.workspace) !== authority ||
          this.#publicationEpoch !== authority.publicationEpoch || (this.#projectRevisions.get(authority.projectId) ?? 0) !== authority.projectRevision) throw new ScopedCodingFileError("cancelled");
    };
    const refresh = () => { pure(); const facts = this.#commandStorage(); pure(); return facts; };
    commandParents.set(ref, { current: pure, refresh, verify: () => {
      this.#known();
      if (!current() || !authority.workspace || this.#active.get(authority.workspace) !== authority) throw new ScopedCodingFileError("cancelled");
      return refresh();
    } });
    return ref;
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
    if (!projectId || !this.availability("files-only").available || !this.#project(projectId)) return null;
    const folder = this.folders.capture(projectId);
    return folder ? Object.freeze({ path: folder.path, projectId, current: folder.current }) : null;
  }
  captureContinuation(id: string, projectId: string): CodingContinuationRef | null {
    return this.availability("files-only").available ? this.#registry?.captureContinuation(id, projectId) ?? null : null;
  }
  continuationCurrent(ref: CodingContinuationRef, projectId: string): boolean {
    return this.availability("files-only").available && this.#registry?.continuationCurrent(ref, projectId) === true;
  }

  createWorkspace(spec: TaskSpec, signal: AbortSignal, admit: () => boolean): Promise<CodingReviewWorkspace> {
    return this.#node ? this.createNodeWorkspace(spec, signal, admit) : this.#createWorkspace(spec, signal, admit, false);
  }
  createFileWorkspace(spec: TaskSpec, signal: AbortSignal, admit: () => boolean): Promise<CodingReviewWorkspace> {
    return this.#createWorkspace(spec, signal, admit, false);
  }
  #createWorkspace(spec: TaskSpec, signal: AbortSignal, admit: () => boolean, node: boolean, wsl?: WindowsWslCodingBinding): Promise<CodingReviewWorkspace> {
    const grant = spec.codingWorkspace, projectId = grant?.projectId, owner = this.#owner();
    if (!this.availability(node ? "commands" : "files-only").available || !grant || !projectId || !owner || !this.#project(projectId) || this.#tasks.has(spec.id)) return Promise.reject(stale());
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
      this.#known();
      try { assertCodingPrivacyScope(privacy); } catch (error) { if (nativeUncertain(error)) { this.#failure(); throw this.#terminal; } return false; }
      return !this.#closed && !this.#failed && (!wsl || WSL_CODING_READINESS.ready && this.#admit(wsl.current)) && this.#epoch === epoch && !signal.aborted && !authority.cancel.signal.aborted && this.availability(node ? "commands" : "files-only").available &&
        this.#owner() === owner && this.#admit(authority.ownerCurrent) && this.#project(projectId) && selected?.path === source && this.#admit(selected.current) && this.#admit(sourceCurrent) && this.#admit(admit) &&
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
          // A previous review describes its own execution environment, never the next task's capability.
          if (continuation.scope?.executionProfile) {
            const { executionProfile: _profile, ...scope } = continuation.scope;
            continuation = { ...continuation, scope };
          }
        }
        const input: WindowsFileOnlyWorkspaceInput = { source, privateBase: this.#copies, protectedPaths: this.#roots,
          signal: AbortSignal.any([signal, authority.cancel.signal]), current, scope: { excludeRoots: [".git", "node_modules"] }, reviewBase: this.#reviews,
          ...(continuation ? { continuation: { baseline: continuation.baseline, proposed: continuation.proposed, scope: continuation.scope, current } } : {}),
          review: { binding: { owner, session: randomUUID(), snapshot: randomUUID() }, store,
            sourceBoundary: authority.sourceBoundary ?? undefined, current: () => this.#reviewCurrent(authority) } };
        if (node) input.commandParent = this.#issueCommandParent(authority, current, signal, epoch);
        let backend: WindowsOwnedWorkspace;
        if (wsl) {
          const seed = await this.#captureWslTree(input);
          try {
            if (!current()) throw stale();
            if (!seed.scope) throw new ScopedCodingFileError("boundary");
            const scope = { ...structuredClone(seed.scope), executionProfile: "wsl-offline" as const };
            // The native seed copy and its temporary artifact are closed before any guest is launched.
            const opened = await wsl.open();
            this.#connections.add(opened.connection);
            try {
              if (!current()) throw stale();
              backend = await WslCodingWorkspace.create({ ...opened, source: seed.proposed, baseline: seed.baseline,
                signal: input.signal, current, privacyScope: privacy, review: { base: this.#reviews, sourceBoundary: authority.sourceBoundary!,
                  current: () => this.#reviewCurrent(authority),
                  captureCurrent: async () => {
                    try {
                      const captured = await this.#captureWslTree({ ...input, continuation: undefined, signal: authority.cancel.signal,
                        current: () => this.#reviewCurrent(authority), review: { ...input.review, current: () => this.#reviewCurrent(authority) } });
                      const tree = captured.proposed;
                      for (const entry of captured.baseline.entries) if (entry.kind === "file") entry.bytes.fill(0);
                      for (const entry of captured.current?.entries ?? []) if (entry.kind === "file") entry.bytes.fill(0);
                      return tree;
                    } catch (error) {
                      if (nativeUncertain(error)) throw error;
                      if (!this.#reviewCurrent(authority)) throw stale();
                      // A moved/unsupported original supplies no current bytes. Preserve work as a conflicted review.
                      if (error instanceof ScopedCodingFileError && ["boundary", "missing", "unsupported", "conflict", "limit"].includes(error.code) ||
                        error instanceof CodingResultRegistryError && error.code === "stale") return undefined;
                      throw error;
                    }
                  },
                  write: async data => {
                    if (!this.#reviewCurrent(authority)) throw stale();
                    const exported = createCodingReviewExport({ ...data, scope }), files = { "review.json": Buffer.from(exported.json), "changes.patch": Buffer.from(exported.review.textPatch) };
                    try {
                      const artifact = await store.write(files, () => { if (!this.#reviewCurrent(authority)) throw stale(); });
                      return Object.freeze({ ...artifact, review: exported.review, cleanup: "complete" as const });
                    } finally { files["review.json"].fill(0); files["changes.patch"].fill(0); }
                  },
                  discard: output => store.discard(output),
                } });
              this.#connections.delete(opened.connection); // The issued workspace now owns disposal.
            } catch (error) {
              try { await opened.connection.close(); this.#connections.delete(opened.connection); }
              catch { this.#failure(); throw new WindowsProjectCodingResourcesCleanupError(); }
              throw error;
            } finally { opened.typescriptArchive.fill(0); }
          } finally { clearCodingContinuation(seed); }
        } else backend = node
          ? await WindowsNodeWorkspace.create({ ...input, resourcesPath: this.#options.resourcesPath!, assetsParent: this.#assets })
          : await WindowsFileOnlyWorkspace.create(input);
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
  /** Native Windows custody is retained even when the execution copy lives in WSL. */
  async createWslWorkspace(spec: TaskSpec, signal: AbortSignal, admit: () => boolean, binding: WindowsWslCodingBinding): Promise<CodingCommandWorkspace> {
    if (!WSL_CODING_READINESS.ready || !this.#admit(binding.current)) throw new ScopedCodingFileError("unavailable");
    const workspace = await this.#createWorkspace(spec, signal, admit, false, binding);
    if (!this.#wslWrappers.has(workspace)) throw new ScopedCodingFileError("boundary");
    return workspace as CodingCommandWorkspace;
  }
  async #captureWslTree(input: WindowsFileOnlyWorkspaceInput): Promise<CodingExportInput> {
    const capture = await WindowsFileOnlyWorkspace.create(input); this.#captures.add(capture);
    let decoded: CodingExportInput | undefined;
    const close = async () => {
      try { await capture.close(); this.#captures.delete(capture); }
      catch { clearCodingContinuation(decoded); this.#failure(); throw new WindowsProjectCodingResourcesCleanupError(); }
    };
    try {
      await capture.sealForReview(); const output = await capture.exportReview(this.#reviews);
      const document = Buffer.from(JSON.stringify(output.review));
      try { decoded = decodeCodingReviewExport(document, input.review.binding); } finally { document.fill(0); }
    } catch (error) { await close(); throw error; }
    await close(); return decoded!;
  }
  async createNodeWorkspace(spec: TaskSpec, signal: AbortSignal, admit: () => boolean): Promise<CodingCommandWorkspace> {
    if (!this.#node) throw new ScopedCodingFileError("boundary");
    this.#known(); if (this.#closed || this.#failed) throw new ScopedCodingFileError("cancelled");
    this.#nodePresent = this.#nodePresence();
    if (!this.#nodePresent) { this.#changed(); throw new ScopedCodingFileError("unavailable"); }
    const workspace = await this.#createWorkspace(spec, signal, admit, true);
    if (!this.#nodeWrappers.has(workspace)) throw new ScopedCodingFileError("boundary");
    return workspace as CodingCommandWorkspace;
  }
  #closeBackend(backend: WindowsOwnedWorkspace): Promise<void> {
    try { this.#known(); } catch (error) { return Promise.reject(error); }
    const prior = this.#backendClosing.get(backend); if (prior) return prior;
    const authority = this.#active.get(backend);
    const closing = Promise.resolve().then(() => backend.close()).then(() => {
      this.#active.delete(backend);
      if (authority) { authority.workspace = undefined; if (!authority.output) this.#tasks.delete(authority.taskId); }
    }, error => { this.#failure(); throw error; });
    this.#backendClosing.set(backend, closing); return closing;
  }
  #wrapped(backend: WindowsOwnedWorkspace, authority: Authority): CodingReviewWorkspace {
    const wrapped = new Proxy(backend, { get: (target, key) => {
      if (key === "close") return () => this.#closeBackend(backend);
      if (key === "runNode" && target instanceof WindowsNodeWorkspace) return (...args: Parameters<WindowsNodeWorkspace["runNode"]>) => this.#observe(target.runNode(...args));
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
    if (backend instanceof WindowsNodeWorkspace) this.#nodeWrappers.set(wrapped, backend);
    else if (backend instanceof WslCodingWorkspace) this.#wslWrappers.set(wrapped, backend);
    else this.#fileWrappers.set(wrapped, backend);
    return wrapped;
  }
  #reviewCurrent(authority: Authority): boolean {
    this.#known();
    try { assertCodingPrivacyScope(authority.privacy); } catch (error) { if (nativeUncertain(error)) { this.#failure(); throw this.#terminal; } return false; }
    return !this.#closed && !this.#failed && !authority.retired && this.#owner() === authority.owner && this.#admit(authority.ownerCurrent) && this.#project(authority.projectId) &&
      this.#publicationEpoch === authority.publicationEpoch && (this.#projectRevisions.get(authority.projectId) ?? 0) === authority.projectRevision;
  }
  #storeValue(): Promise<WindowsCodingArtifactStore> {
    this.#known();
    if (this.#store) return Promise.resolve(this.#store);
    if (!this.#storeOpening) this.#storeOpening = WindowsCodingArtifactStore.create({ privateBase: this.#reviews, protectedPaths: this.#roots })
      .then(store => { this.#store = store; return store; }, error => { this.#storeOpening = null; if (nativeUncertain(error)) this.#failure(); throw error; });
    return this.#storeOpening;
  }
  #registryValue(): Promise<CodingResultRegistry> {
    this.#known();
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
    if (this.#captures.size || this.#connections.size) throw cleanupFailed();
    this.#storageCurrent();
    for (const role of this.#roles) if (this.#api!.list(role.owned.handle, 1).length) throw cleanupFailed();
    const children = this.#api!.list(this.#process.owned.handle, 3);
    if (children.length !== this.#roles.length || children.some(child => !this.#roles.some(role => role.name === child.name && role.info?.id === child.id))) throw cleanupFailed();
  }
  invalidate(): Promise<void> {
    this.#epoch++; this.#publicationEpoch++; this.folders.ownerReset(); this.#invalidationPending++;
    for (const authority of this.#tasks.values()) { authority.retired = true; authority.cancel.abort(); }
    if (this.#terminal) { this.#invalidationPending--; this.#changed(); return Promise.reject(this.#terminal); }
    const creating = [...this.#creating].map(pending => pending.then(() => undefined, () => undefined));
    const privacy = retireCodingPrivacyScanners();
    const backends = [...this.#active.keys()];
    const captures = [...this.#captures].map(async capture => { await capture.stop(); await capture.close(); this.#captures.delete(capture); });
    const connections = [...this.#connections].map(async connection => { await connection.close(); this.#connections.delete(connection); });
    const stopping = backends.map(backend => { try { return backend.stop(); } catch { return Promise.reject(cleanupFailed()); } });
    const closing = backends.map(backend => this.#closeBackend(backend));
    const pending = (async () => {
      try {
        const settled = await Promise.allSettled([...stopping, ...closing, ...creating, ...captures, ...connections, privacy]);
        if (settled.some(value => value.status === "rejected")) this.#failure();
        const remaining = await Promise.allSettled([...this.#active.keys()].map(backend => this.#closeBackend(backend)));
        if (remaining.some(value => value.status === "rejected")) this.#failure();
        this.#known();
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
        this.#known();
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
