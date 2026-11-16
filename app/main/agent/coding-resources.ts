/** Host lifetime for project folder grants, verified command copies and stopped review artifacts. No model factory. */
import fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import { ProjectCodingWorkspaces } from "./project-coding-workspaces";
import { discoverCodingToolchain } from "./coding-toolchain";
import { IsolatedCommandWorkspace, type IsolatedCommandReview } from "./isolated-command-workspace";
import { CodingResultRegistry, CodingResultRegistryError } from "./coding-result-registry";
import { CodingArtifactCleanupError, type CodingArtifactSourceRef } from "./coding-artifact-store";
import { LinuxCodingArtifactStore } from "./linux-coding-artifact-store";
import { clearCodingContinuation, type CodingContinuationRef } from "./coding-continuation";
import type { CodingExportInput } from "./coding-result-export";
import { CodingSeedCleanupError } from "./coding-seed-snapshot";
import type { CodingWorkspace } from "./coding-workspace";
import type { TaskSpec } from "./worker";
import type { ScopedCodingChecks } from "./scoped-coding-worker";
import { titleOf } from "./tasks";
import { CodingPrivacyCleanupError, captureCodingPrivacyScope, retireCodingPrivacyScanners, codingPrivacyCleanupFailure, type CodingPrivacyScope } from "./coding-privacy-scanner";
import type { CodingProjectScope, CodingExcludedRoot } from "./coding-project-scope";
import { selectCodingStorageBase, type CodingStorageBase } from "./coding-storage";

export interface ProjectCodingResourcesOptions {
  userData: string;
  protectedPaths: readonly string[];
  currentOwner(): string | null;
  projectExists(projectId: string): boolean;
  env: NodeJS.ProcessEnv;
  execPath: string;
  isElectron: boolean;
  changed?(): void;
  /** Main may create this synchronously while these filesystem resources initialize asynchronously. */
  folders?: ProjectCodingWorkspaces;
  /** Main shares this immutable selection with every desktop self-protection gate before allocation. */
  storage?: CodingStorageBase;
}
export type CodingResultsAccess = Pick<CodingResultRegistry, "state" | "review" | "export" | "reset" | "forgetProject" | "forgetResult">;
interface Pin { path: string; handle: fs.FileHandle; stat: BigIntStats; mount: string }
interface Authority {
  taskId: string; owner: string; projectId: string; source: string; title: string; ownerCurrent: () => boolean;
  publicationEpoch: number; projectRevision: number;
  sourceBoundary: CodingArtifactSourceRef | null;
  publishing?: boolean;
  retired?: boolean;
  workspace?: IsolatedCommandWorkspace;
  output?: IsolatedCommandReview;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const CLEAN_MARKER = "cleanup-complete.json";
const SOURCE_EXCLUSIONS: readonly CodingExcludedRoot[] = Object.freeze([".git", "node_modules"]);
const SOURCE_DISCLOSURE = "Source captures and review exports exclude .git and node_modules. Commands may use a separate read-only copy of existing in-project node_modules after its ordinary folder and contents are verified; external dependency-folder links are refused. No dependencies are installed or downloaded. Review exports include every captured source file, including unchanged files.";
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino;
const overlap = (a: string, b: string) => {
  const inside = (file: string, root: string) => { const relative = path.relative(root, file); return !relative || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)); };
  return inside(a, b) || inside(b, a);
};
const fixed = (text: string) => new Error(text);
const stale = () => fixed("The coding account, project or folder grant changed. Start a new request.");
const cleanupFailed = () => fixed("Private coding resources could not be closed safely. They were retained for diagnosis.");
const safeCall = (check: () => boolean) => { try { return check() === true; } catch { return false; } };
async function mount(handle: fs.FileHandle): Promise<string> {
  const value = /^mnt_id:\s*(\d+)\s*$/m.exec(await fs.readFile(`/proc/self/fdinfo/${handle.fd}`, "utf8"))?.[1];
  if (!value) throw cleanupFailed(); return value;
}

export class ProjectCodingResources {
  readonly folders: ProjectCodingWorkspaces;
  #options: ProjectCodingResourcesOptions;
  #roots: string[] = [];
  #common: string;
  #storage: CodingStorageBase;
  #pins: Pin[] = [];
  #private: string | null = null;
  #copies = "";
  #reviews = "";
  #node: string | null = null;
  #message = "Checking the isolated coding toolchain…";
  #supported = HOST_PLATFORM === "linux" && HOST_ARCH === "x64";
  #failed = false;
  #cleanupFailed = false;
  #artifactCleanupFailed = false;
  #closed = false;
  #epoch = 0;
  #publicationEpoch = 0;
  #projectRevisions = new Map<string, number>();
  #lifetime = new AbortController();
  #discovery: Promise<void> = Promise.resolve();
  #registry: CodingResultRegistry | null = null;
  #registryOpening: Promise<CodingResultRegistry> | null = null;
  #artifactStoreOpening: Promise<LinuxCodingArtifactStore> | null = null;
  #authorities = new WeakMap<TaskSpec, Authority>();
  #tasks = new Map<string, Authority>();
  #active = new Map<IsolatedCommandWorkspace, Authority>();
  #backendClosing = new WeakMap<IsolatedCommandWorkspace, Promise<void>>();
  #invalidationPending = 0;
  #creating = new Set<Promise<IsolatedCommandWorkspace>>();
  #publishing = new Set<Promise<unknown>>();
  #unadopted = new Map<string, string>();
  #exporting = new Set<Promise<unknown>>();
  #closing: Promise<void> | null = null;
  #results: CodingResultsAccess;

  private constructor(options: ProjectCodingResourcesOptions) {
    this.#options = { ...options, env: { PATH: options.env.PATH }, protectedPaths: [...options.protectedPaths] };
    this.folders = options.folders ?? new ProjectCodingWorkspaces({ currentOwner: options.currentOwner, projectExists: options.projectExists });
    this.#storage = options.storage ?? selectCodingStorageBase();
    this.#common = this.#storage.common ?? this.#storage.protectedPaths[0];
    this.#results = Object.freeze({
      state: projectId => this.#registry?.state(projectId) ?? [],
      review: id => this.#observeArtifactCleanup(this.#registry?.review(id) ?? Promise.resolve(null)),
      export: (id, destination, current) => this.#observeArtifactCleanup(this.#registry?.export(id, destination, current) ?? Promise.resolve({ ok: false, message: "No coding review is available to export." })),
      reset: () => { this.#publicationEpoch++; return this.#retryRegistryReset(); },
      forgetResult: id => {
        const pending = this.#registry ? this.#registry.forgetResult(id) : this.#registryOpening ? this.#registryOpening.then(registry => registry.forgetResult(id)) : Promise.resolve();
        return this.#registryCleanup(pending, true);
      },
      forgetProject: projectId => {
        this.#projectRevisions.set(projectId, (this.#projectRevisions.get(projectId) ?? 0) + 1);
        return this.#registryCleanup(this.#forgetRegistryProject(projectId));
      },
    });
  }

  static async create(options: ProjectCodingResourcesOptions): Promise<ProjectCodingResources> {
    const owner = new ProjectCodingResources(options);
    try {
      if (!path.isAbsolute(options.userData) || !options.protectedPaths.length || options.protectedPaths.some(value => !path.isAbsolute(value))) throw fixed("Protected coding paths could not be verified.");
      owner.#roots = [...new Set(await Promise.all([options.userData, ...options.protectedPaths].map(value => fs.realpath(value))))];
      if (!owner.#storage.common) throw fixed("Private coding storage could not be resolved.");
      if (!owner.#supported) { owner.#message = "Isolated coding commands currently require Linux x64. Folder choices are metadata only here."; return owner; }
      if (owner.#roots.some(root => overlap(owner.#common, root))) throw fixed("Private coding storage must be outside protected data.");
      try { await fs.mkdir(owner.#common, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      await owner.#pin(owner.#common);
      try { await owner.#recoverPrevious(); }
      catch { owner.#message = "Earlier private coding data has no verified cleanup receipt. It was retained and coding remains unavailable."; throw cleanupFailed(); }
      owner.#private = await fs.mkdtemp(path.join(owner.#common, `process-${process.pid}-`));
      await owner.#pin(owner.#private);
      owner.#copies = path.join(owner.#private, "copies"); owner.#reviews = path.join(owner.#private, "reviews");
      for (const directory of [owner.#copies, owner.#reviews]) { await fs.mkdir(directory, { mode: 0o700 }); await owner.#pin(directory); }
      owner.#discovery = owner.#discover();
    } catch {
      owner.#failed = true;
      if (owner.#message === "Checking the isolated coding toolchain…") owner.#message = "Ember couldn't prepare private coding storage or verify its protected paths.";
    }
    return owner;
  }

  get reviewBase(): string { return this.#reviews; }
  results(): Promise<CodingResultsAccess> { return Promise.resolve(this.#results); }
  availability(): { available: boolean; message: string; nodePath?: string } {
    const privacyFailure = codingPrivacyCleanupFailure();
    const available = !this.#closed && !this.#invalidationPending && !this.#failed && !this.#artifactCleanupFailed && !privacyFailure && this.#supported && this.#node !== null;
    return { available, message: this.#closed ? "Coding resources are closed." : this.#invalidationPending ? "Private coding work is being closed and removed." : privacyFailure ? "Earlier coding privacy work could not be verified as stopped. Further coding is unavailable." : this.#artifactCleanupFailed && !this.#failed
      ? "Private coding reviews could not be removed. Retry Forget everything; coding resumes after verified cleanup." : this.#message,
      ...(available ? { nodePath: this.#node! } : {}),
      ...(available ? { message: `${this.#message} ${SOURCE_DISCLOSURE}` } : {}) };
  }
  #changed(): void { try { this.#options.changed?.(); } catch { /* UI observation cannot authorize work or hide cleanup state. */ } }
  #owner(): string | null {
    try { const owner = this.#options.currentOwner(); return typeof owner === "string" && /^[a-f0-9]{64}$/.test(owner) ? owner : null; } catch { return null; }
  }
  #project(id: string): boolean { return uuid.test(id) && safeCall(() => this.#options.projectExists(id)); }
  async #discover(): Promise<void> {
    try {
      const result = await discoverCodingToolchain({ env: this.#options.env, execPath: this.#options.execPath,
        isElectron: this.#options.isElectron, protectedPaths: this.#roots, signal: this.#lifetime.signal });
      if (this.#closed) return;
      if (result.available === true && typeof result.nodePath === "string" && path.isAbsolute(result.nodePath)) this.#node = result.nodePath;
      this.#message = this.#node ? result.message : "Coding needs a verified system Node.js and working isolated command namespaces.";
    } catch { if (!this.#closed) this.#message = "The isolated coding toolchain could not be verified."; }
    if (!this.#closed) this.#changed();
  }
  async #pin(directory: string): Promise<void> {
    const listed = await fs.lstat(directory, { bigint: true });
    if (!listed.isDirectory() || listed.isSymbolicLink() || listed.uid !== BigInt(process.getuid!()) || (listed.mode & 0o7077n) !== 0n) throw cleanupFailed();
    const handle = await fs.open(directory, DIR);
    try {
      const stat = await handle.stat({ bigint: true });
      if (!same(listed, stat) || await fs.realpath(`/proc/self/fd/${handle.fd}`) !== directory) throw cleanupFailed();
      this.#pins.push({ path: directory, handle, stat, mount: await mount(handle) });
    } catch (error) { await handle.close(); throw error; }
  }
  async #storageCurrent(): Promise<void> {
    for (const pin of this.#pins) {
      const stat = await fs.lstat(pin.path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink() || !same(stat, pin.stat) || stat.uid !== pin.stat.uid || (stat.mode & 0o7077n) !== 0n ||
          await mount(pin.handle) !== pin.mount || await fs.realpath(`/proc/self/fd/${pin.handle.fd}`) !== pin.path) throw cleanupFailed();
    }
  }

  /** Unmarked prior runs are never reused/deleted. A committed host receipt permits only empty-role recovery. */
  async #recoverPrevious(): Promise<void> {
    const common = this.#pins[0];
    for (const name of await fs.readdir(`/proc/self/fd/${common.handle.fd}`)) {
      if (!/^process-[0-9]+-[A-Za-z0-9]{6}$/.test(name)) throw cleanupFailed();
      const directory = await fs.open(`/proc/self/fd/${common.handle.fd}/${name}`, DIR);
      try {
        const stat = await directory.stat({ bigint: true });
        if (!stat.isDirectory() || stat.uid !== common.stat.uid || (stat.mode & 0o7077n) !== 0n || await mount(directory) !== common.mount) throw cleanupFailed();
        const marker = await fs.open(`/proc/self/fd/${directory.fd}/${CLEAN_MARKER}`, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const before = await marker.stat({ bigint: true });
          if (!before.isFile() || before.nlink !== 1n || before.uid !== stat.uid || (before.mode & 0o7077n) !== 0n || before.size < 1n || before.size > 4096n) throw cleanupFailed();
          const bytes = await marker.readFile(), after = await marker.stat({ bigint: true });
          if (bytes.length !== Number(before.size) || !same(before, after) || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw cleanupFailed();
          const receipt = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
          if (Object.keys(receipt).sort().join(",") !== "directory,ino,phase,version,volume" || receipt.version !== 1 || receipt.phase !== "fully-closed" ||
              receipt.directory !== name || receipt.volume !== stat.dev.toString() || receipt.ino !== stat.ino.toString()) throw cleanupFailed();
        } finally { await marker.close(); }
        const names = await fs.readdir(`/proc/self/fd/${directory.fd}`);
        if (names.some(child => ![CLEAN_MARKER, "copies", "reviews"].includes(child))) throw cleanupFailed();
        const roles: { name: string; handle: fs.FileHandle; stat: BigIntStats }[] = [];
        try {
          for (const child of names.filter(value => value !== CLEAN_MARKER)) {
            const handle = await fs.open(`/proc/self/fd/${directory.fd}/${child}`, DIR);
            const role = { name: child, handle, stat: await handle.stat({ bigint: true }) }; roles.push(role);
            if (!role.stat.isDirectory() || role.stat.uid !== stat.uid || (role.stat.mode & 0o7077n) !== 0n ||
                await mount(handle) !== common.mount || (await fs.readdir(`/proc/self/fd/${handle.fd}`)).length) throw cleanupFailed();
          }
          for (const role of roles) {
            if (!same(await fs.lstat(`/proc/self/fd/${directory.fd}/${role.name}`, { bigint: true }), role.stat)) throw cleanupFailed();
            await fs.rmdir(`/proc/self/fd/${directory.fd}/${role.name}`);
          }
        } finally { await Promise.allSettled(roles.map(role => role.handle.close())); }
        await fs.unlink(`/proc/self/fd/${directory.fd}/${CLEAN_MARKER}`);
      } finally { await directory.close(); }
      await fs.rmdir(`/proc/self/fd/${common.handle.fd}/${name}`);
    }
  }
  async #markClosed(): Promise<void> {
    if (!this.#private) return;
    await this.#storageCurrent();
    for (const directory of [this.#copies, this.#reviews]) if ((await fs.readdir(directory)).length) throw cleanupFailed();
    const root = this.#pins.find(pin => pin.path === this.#private)!;
    if ((await fs.readdir(`/proc/self/fd/${root.handle.fd}`)).some(name => !["copies", "reviews"].includes(name))) throw cleanupFailed();
    const marker = await fs.open(`/proc/self/fd/${root.handle.fd}/${CLEAN_MARKER}`, "wx", 0o600);
    try {
      await marker.writeFile(JSON.stringify({ version: 1, phase: "fully-closed", directory: path.basename(root.path), volume: root.stat.dev.toString(), ino: root.stat.ino.toString() }));
      await marker.sync();
    } finally { await marker.close(); }
    await root.handle.sync(); await this.#pins[0].handle.sync();
  }

  /** A chooser grant can never select this process's or another process's private coding data. */
  async validateSource(folder: CodingWorkspace): Promise<CodingWorkspace> {
    const selected = folder?.path, current = folder?.current?.bind(folder);
    if (!current || !safeCall(current) || !path.isAbsolute(selected) || /[\p{Cc}\p{Cf}]/u.test(selected)) throw stale();
    let real: string;
    try { real = await fs.realpath(selected); } catch { throw stale(); }
    if (!safeCall(current) || real !== selected || !this.#roots.length || overlap(real, this.#common) || this.#roots.some(root => overlap(real, root))) {
      throw fixed("Choose a project folder outside Ember's data, application and private coding storage.");
    }
    if (this.#supported && this.#pins.length) {
      await this.#storageCurrent();
      const common = this.#pins[0], source = await fs.open(real, DIR);
      try {
        const stat = await source.stat({ bigint: true }), id = await mount(source);
        if (!stat.isDirectory() || same(stat, common.stat) || (stat.dev === common.stat.dev && id !== common.mount)) throw stale();
        let ancestor = path.parse(real).root;
        for (const part of real.slice(ancestor.length).split(path.sep).filter(Boolean)) {
          ancestor = path.join(ancestor, part);
          const child = await fs.open(ancestor, DIR);
          try { if (same(await child.stat({ bigint: true }), common.stat)) throw stale(); } finally { await child.close(); }
        }
      } finally { await source.close(); }
    }
    if (!safeCall(current)) throw stale();
    return Object.freeze({ path: real, current });
  }
  workspace(projectId: string | null): { path: string; projectId: string; current(): boolean } | null {
    if (!projectId || !this.availability().available || !this.#project(projectId)) return null;
    const folder = this.folders.capture(projectId);
    return folder ? Object.freeze({ path: folder.path, projectId, current: folder.current }) : null;
  }
  /** Only explicit Home selection may mint this context; identifiers alone are never accepted by a workspace. */
  captureContinuation(id: string, projectId: string): CodingContinuationRef | null {
    return this.availability().available ? this.#registry?.captureContinuation(id, projectId) ?? null : null;
  }
  continuationCurrent(ref: CodingContinuationRef, projectId: string): boolean {
    return this.availability().available && this.#registry?.continuationCurrent(ref, projectId) === true;
  }

  createWorkspace(spec: TaskSpec, signal: AbortSignal, admit: () => boolean): Promise<IsolatedCommandWorkspace> {
    const workspace = spec.codingWorkspace, projectId = workspace?.projectId, owner = this.#owner();
    if (!this.availability().available || !workspace || !projectId || !this.#project(projectId) || !owner || this.#tasks.has(spec.id)) return Promise.reject(stale());
    let privacyScope: CodingPrivacyScope;
    try { privacyScope = captureCodingPrivacyScope(); }
    catch (error) { if (error instanceof CodingPrivacyCleanupError) this.#failure(); return Promise.reject(error); }
    const path = workspace.path, sourceCurrent = workspace.current.bind(workspace), selected = this.folders.capture(projectId);
    const continuationRef = workspace.continuation;
    let continuationReady = false;
    const ownerCurrent = this.folders.ownerCurrent(), epoch = this.#epoch;
    const authority: Authority = { taskId: spec.id, owner, projectId, source: path,
      title: titleOf(spec.goal).replace(/[\p{Cc}\p{Cf}]/gu, value => `\\u${value.codePointAt(0)!.toString(16).padStart(4, "0")}`),
      ownerCurrent, publicationEpoch: this.#publicationEpoch, projectRevision: this.#projectRevisions.get(projectId) ?? 0, sourceBoundary: null };
    const current = () => !this.#closed && !this.#failed && this.#epoch === epoch && !signal.aborted && this.availability().available &&
      this.#owner() === owner && safeCall(ownerCurrent) && this.#project(projectId) && selected?.path === path &&
      safeCall(selected.current) && safeCall(sourceCurrent) && safeCall(admit) &&
      (!continuationRef || continuationReady || this.#registry?.continuationCurrent(continuationRef, projectId) === true);
    if (!current()) return Promise.reject(stale());
    this.#tasks.set(spec.id, authority); this.#authorities.set(spec, authority);
    const pending = (async () => {
      let continuation: CodingExportInput | undefined;
      try {
        await this.validateSource({ path, current: sourceCurrent }); if (!current()) throw stale();
        await this.#storageCurrent(); if (!current()) throw stale();
        const store = await this.#artifactStoreValue(); if (!current()) throw stale();
        authority.sourceBoundary = await store.sourceBoundary(path, () => { if (!current()) throw stale(); });
        if (!current()) throw stale();
        if (continuationRef) {
          if (!this.#registry) throw stale();
          continuation = await this.#registry.loadContinuation(continuationRef, projectId, authority.sourceBoundary, current);
          if (!current()) throw stale();
        }
        const scope = await this.#sourceScope(path, current); if (!current()) throw stale();
        const backend = await IsolatedCommandWorkspace.create({ source: path, baseDir: this.#copies, protectedPaths: this.#roots, scope, privacyScope,
          binding: { owner, session: randomUUID(), snapshot: randomUUID() }, nodePath: this.#node!, signal, admit: current,
          ...(continuation ? { continuation: { baseline: continuation.baseline, proposed: continuation.proposed, scope: continuation.scope, current } } : {}),
          reviewCurrent: () => this.#reviewCurrent(authority) });
        authority.workspace = backend; this.#active.set(backend, authority);
        if (!current()) { await backend.stop(); await this.#closeBackend(backend); throw stale(); }
        // This independent copy now owns its bytes. Forgetting the predecessor cannot revive or modify it.
        continuationReady = true;
        return this.#wrapped(backend, authority);
      } catch (error) {
        if (error instanceof CodingPrivacyCleanupError || error instanceof CodingArtifactCleanupError || error instanceof CodingSeedCleanupError || (authority.workspace && this.#active.has(authority.workspace))) this.#failure();
        if (!authority.workspace) { this.#tasks.delete(spec.id); this.#authorities.delete(spec); }
        if (error instanceof CodingPrivacyCleanupError || error instanceof CodingArtifactCleanupError || error instanceof CodingSeedCleanupError) throw error;
        throw fixed("The coding copy could not be created under its current project grant.");
      } finally { clearCodingContinuation(continuation); }
    })();
    this.#creating.add(pending); void pending.then(() => this.#creating.delete(pending), () => this.#creating.delete(pending));
    return pending;
  }
  async #sourceScope(source: string, current: () => boolean): Promise<CodingProjectScope> {
    if (!current()) throw stale();
    const dependencies = path.join(source, "node_modules");
    let stat: BigIntStats;
    try { stat = await fs.lstat(dependencies, { bigint: true }); }
    catch (error) {
      if (!current()) throw stale();
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { excludeRoots: SOURCE_EXCLUSIONS };
      throw stale();
    }
    if (!current() || !stat.isDirectory() || stat.isSymbolicLink() || await fs.realpath(dependencies) !== dependencies) throw fixed("Existing node_modules must be an ordinary in-project folder before coding can use it.");
    if (!current()) throw stale();
    return { excludeRoots: SOURCE_EXCLUSIONS, dependencies: Object.freeze({ path: dependencies, current }) };
  }

  #closeBackend(backend: IsolatedCommandWorkspace): Promise<void> {
    const existing = this.#backendClosing.get(backend); if (existing) return existing;
    const authority = this.#active.get(backend);
    let resolve!: () => void, reject!: (error: unknown) => void;
    const closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    this.#backendClosing.set(backend, closing);
    try {
      void Promise.resolve(backend.close()).then(() => {
        this.#active.delete(backend);
        if (authority) { authority.workspace = undefined; if (!authority.output) this.#tasks.delete(authority.taskId); }
        resolve();
      }, error => { this.#failure(); reject(error); });
    } catch (error) { this.#failure(); reject(error); }
    return closing;
  }
  #wrapped(backend: IsolatedCommandWorkspace, authority: Authority): IsolatedCommandWorkspace {
    const close = () => this.#closeBackend(backend);
    return new Proxy(backend, { get: (target, key) => {
      if (key === "close") return close;
      if (key === "exportReview") return (base: string) => {
        if (base !== this.#reviews) return Promise.reject(stale());
        const pending = target.exportReview(base); this.#exporting.add(pending);
        void pending.then(output => {
          authority.output = authority.retired ? undefined : output; this.#unadopted.set(output.directory, authority.projectId); this.#exporting.delete(pending);
        }, () => this.#exporting.delete(pending));
        return pending;
      };
      const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
    } });
  }
  #failure(): void { this.#failed = true; this.#cleanupFailed = true; this.#message = "Earlier coding resources could not be verified as closed. Further coding is unavailable."; this.#changed(); }
  #observeArtifactCleanup<T>(pending: Promise<T>): Promise<T> {
    return pending.catch(error => { if (error instanceof CodingArtifactCleanupError) this.#failure(); throw error; });
  }
  #artifactStoreValue(): Promise<LinuxCodingArtifactStore> {
    if (!this.#artifactStoreOpening) {
      const opening = LinuxCodingArtifactStore.create(this.#reviews).catch(error => {
        if (this.#artifactStoreOpening === opening) this.#artifactStoreOpening = null;
        if (error instanceof CodingArtifactCleanupError) this.#failure();
        throw error;
      });
      this.#artifactStoreOpening = opening;
    }
    return this.#artifactStoreOpening;
  }
  #registryValue(): Promise<CodingResultRegistry> {
    if (this.#registry) return Promise.resolve(this.#registry);
    if (!this.#registryOpening) {
      const opening: Promise<CodingResultRegistry> = this.#artifactStoreValue().then(store => CodingResultRegistry.create({ privateBase: this.#reviews, currentOwner: this.#options.currentOwner,
        projectExists: this.#options.projectExists, store })).then(registry => { this.#registry = registry; return registry; }, error => {
          if (this.#registryOpening === opening) this.#registryOpening = null;
          throw error;
        });
      this.#registryOpening = opening;
    }
    return this.#registryOpening;
  }
  #reviewCurrent(authority: Authority): boolean {
    return !this.#closed && this.#owner() === authority.owner && safeCall(authority.ownerCurrent) && this.#project(authority.projectId) &&
      this.#publicationEpoch === authority.publicationEpoch && (this.#projectRevisions.get(authority.projectId) ?? 0) === authority.projectRevision;
  }
  publish(spec: TaskSpec, output: IsolatedCommandReview, status: "done" | "failed" | "stopped", checks: ScopedCodingChecks) {
    const authority = this.#authorities.get(spec);
    if (!authority || authority.publishing || this.#tasks.get(spec.id) !== authority || authority.output !== output) return Promise.reject(stale());
    authority.publishing = true;
    const current = () => this.#reviewCurrent(authority);
    this.#unadopted.set(output.directory, authority.projectId);
    const pending = (async () => {
      try {
        const registry = await this.#registryValue();
        const summary = await registry.put({ expectedOwner: authority.owner, projectId: authority.projectId, taskId: spec.id, title: authority.title,
          sourcePath: authority.source, sourceBoundary: authority.sourceBoundary, status, checks, current, output });
        this.#unadopted.delete(output.directory); this.#changed(); return summary;
      } catch (error) {
        if (error instanceof CodingArtifactCleanupError) this.#failure();
        try {
          if (!this.#registry) throw cleanupFailed();
          await this.#registry.discard(output.directory); this.#unadopted.delete(output.directory);
        } catch { this.#artifactCleanupFailed = true; }
        this.#changed(); throw error;
      } finally {
        this.#tasks.delete(spec.id); this.#authorities.delete(spec); authority.output = undefined;
      }
    })();
    this.#publishing.add(pending); void pending.then(() => this.#publishing.delete(pending), () => this.#publishing.delete(pending)); return pending;
  }
  async #discardUnadopted(registry: CodingResultRegistry, projectId?: string): Promise<void> {
    let failed = false;
    for (const [directory, ownerProject] of [...this.#unadopted]) if (!projectId || ownerProject === projectId) {
      try { await registry.discard(directory); this.#unadopted.delete(directory); } catch { failed = true; }
    }
    if (failed) throw cleanupFailed();
  }
  async #resetRegistry(): Promise<void> {
    const registry = this.#registry ?? (this.#registryOpening ? await this.#registryOpening : this.#unadopted.size ? await this.#registryValue() : null);
    if (!registry) return;
    let failed = false;
    try { await registry.reset(); } catch { failed = true; }
    try { await this.#discardUnadopted(registry); } catch { failed = true; }
    if (failed) throw cleanupFailed();
  }
  async #forgetRegistryProject(projectId: string): Promise<void> {
    const registry = this.#registry ?? (this.#registryOpening ? await this.#registryOpening : [...this.#unadopted.values()].includes(projectId) ? await this.#registryValue() : null);
    if (!registry) return;
    await registry.forgetProject(projectId); await this.#discardUnadopted(registry, projectId);
  }
  async #registryCleanup(pending: Promise<void>, allowMissingResult = false): Promise<void> {
    try { await pending; this.#artifactCleanupFailed = this.#unadopted.size > 0; this.#changed(); }
    catch (error) {
      if (error instanceof CodingArtifactCleanupError) this.#failure();
      if (allowMissingResult && error instanceof CodingResultRegistryError && (error.code === "stale" || error.code === "invalid")) throw error;
      this.#artifactCleanupFailed = true; this.#changed(); throw cleanupFailed();
    }
  }
  #retryRegistryReset(): Promise<void> { return this.#registryCleanup(this.#resetRegistry()); }

  async #drainResults(): Promise<void> {
    for (;;) {
      const pending = [...this.#exporting, ...this.#publishing];
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
  }
  async #emptyPrivateRoles(): Promise<void> {
    if (!this.#private) return;
    await this.#storageCurrent();
    for (const directory of [this.#copies, this.#reviews]) {
      if (!directory) continue;
      try {
        if ((await fs.readdir(directory)).length && !(directory === this.#reviews && this.#artifactCleanupFailed)) throw cleanupFailed();
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }
  invalidate(): Promise<void> {
    this.#epoch++; this.#publicationEpoch++; this.folders.ownerReset(); this.#invalidationPending++;
    for (const authority of this.#tasks.values()) { authority.retired = true; authority.output = undefined; }
    const creations = [...this.#creating].map(pending => pending.then(() => undefined, () => undefined));
    const privacy = retireCodingPrivacyScanners();
    const backends = [...this.#active.keys()];
    const stops = backends.map(backend => { try { return backend.stop(); } catch { return Promise.reject(cleanupFailed()); } });
    const closes = backends.map(backend => this.#closeBackend(backend));
    const pending = (async () => {
      try {
        const results = await Promise.allSettled([...stops, ...closes, ...creations, privacy]);
        if (results.some(result => result.status === "rejected")) this.#failure();
        const remaining = await Promise.allSettled([...this.#active.keys()].map(backend => this.#closeBackend(backend)));
        if (remaining.some(result => result.status === "rejected")) this.#failure();
        await this.#drainResults();
        for (const authority of this.#tasks.values()) { authority.output = undefined; authority.workspace = undefined; }
        this.#tasks.clear(); this.#authorities = new WeakMap();
        let artifactFailure = false;
        try { await this.#retryRegistryReset(); } catch { artifactFailure = true; }
        try { await this.#emptyPrivateRoles(); } catch { this.#failure(); }
        if (this.#cleanupFailed || artifactFailure) throw cleanupFailed();
      } finally { this.#invalidationPending--; this.#changed(); }
    })();
    this.#changed(); return pending;
  }
  close(): Promise<void> {
    if (!this.#closing) {
      this.#closed = true; this.#lifetime.abort();
      const invalidated = this.invalidate();
      this.#closing = (async () => {
        let failed = false;
        try { await invalidated; } catch { failed = true; }
        await this.#discovery;
        await this.#drainResults();
        for (const backend of [...this.#active.keys()]) {
          try { await backend.stop(); await this.#closeBackend(backend); } catch { failed = true; }
        }
        try { if (this.#registryOpening) await (await this.#registryOpening).close(); } catch { failed = true; }
        // A task may capture its source without ever publishing a result or opening the registry.
        try { if (this.#artifactStoreOpening) await (await this.#artifactStoreOpening).close(); } catch { failed = true; }
        // File tools own their pure scanner too. Account/app cleanup waits for every source-holding worker heap.
        try { await retireCodingPrivacyScanners(); } catch { failed = true; }
        if (!failed && this.#private) {
          try { await this.#markClosed(); } catch { failed = true; }
        }
        if (!failed && this.#private) {
          for (const directory of [this.#reviews, this.#copies, this.#private]) {
            const pin = this.#pins.find(value => value.path === directory)!;
            try {
              const stat = await fs.lstat(directory, { bigint: true });
              if (!stat.isDirectory() || stat.isSymbolicLink() || !same(stat, pin.stat)) throw cleanupFailed();
              if (directory === this.#private) await fs.unlink(`/proc/self/fd/${pin.handle.fd}/${CLEAN_MARKER}`);
              if ((await fs.readdir(`/proc/self/fd/${pin.handle.fd}`)).length) throw cleanupFailed();
              const parent = this.#pins.find(value => value.path === path.dirname(directory))!;
              await fs.rmdir(`/proc/self/fd/${parent.handle.fd}/${path.basename(directory)}`);
            } catch { failed = true; break; }
          }
        }
        for (const pin of this.#pins.slice().reverse()) { try { await pin.handle.close(); } catch { failed = true; } }
        if (failed) { this.#failure(); throw cleanupFailed(); }
      })();
    }
    return this.#closing;
  }
}
