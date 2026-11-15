/**
 * Linux command-only coding workspace. The SDK/controller stays in the trusted host; only copied project bytes and
 * a verified minimal toolchain enter each disposable no-network namespace. No operation writes the original project.
 */
import fs from "node:fs/promises";
import { constants, openSync, closeSync, type BigIntStats } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { StringDecoder } from "node:string_decoder";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import { createCodingSnapshot, type CodingSnapshot } from "./coding-snapshot";
import { createCodingReviewExport, type CodingExportBinding, type CodingExportEntry, type CodingExportTree, type CodingReviewExport } from "./coding-result-export";
import { ExperimentalNamespaceReceipt } from "./experimental-stop-receipt";
import { copyIsolatedCommandAssets } from "./isolated-command-assets";
import { codingWorkspaceFileProblem } from "./scoped-coding-files";
import { codingProjectManifest, type CodingProjectManifest, type CodingProjectScope, type CodingExcludedRoot } from "./coding-project-scope";
import { createCodingDependencySnapshot, type CodingDependencySnapshot } from "./coding-dependency-snapshot";

export interface IsolatedCommandLimits { commandBytes: number; outputBytes: number; maxMs: number; proofMs: number }
export interface IsolatedCommandWorkspaceInput {
  source: string; baseDir: string; protectedPaths: readonly string[]; binding: CodingExportBinding;
  /** Explicit host-selected trusted Node binary. Absence means Node commands are unsupported. */
  nodePath?: string;
  limits?: Partial<IsolatedCommandLimits>;
  signal?: AbortSignal;
  /** Host capability for this accepted task, checked again before each lease and native command release. */
  admit?: () => boolean;
  /** Explicit host scope; the strict complete-tree default never omits project data. */
  scope?: CodingProjectScope;
}
export interface IsolatedCommandResult {
  exitCode: number | null; signal: string | null; stopped: boolean; timedOut: boolean; outputLimited: boolean; output: string; observed: true;
}
export interface IsolatedCommandReview { directory: string; review: CodingReviewExport; cleanup: "complete" | "retained" }

const DEFAULT_LIMITS: IsolatedCommandLimits = { commandBytes: 48_000, outputBytes: 1024 * 1024, maxMs: 20 * 60_000, proofMs: 5000 };
const LIMIT_CAPS: IsolatedCommandLimits = { ...DEFAULT_LIMITS, outputBytes: 4 * 1024 * 1024 };
const BWRAP = "/usr/bin/bwrap";
const BARRIER = 'IFS= read -r gate; test "$gate" = ember-command-ready || exit 125; exec /usr/bin/bash --noprofile --norc -c "$1"';
const within = (file: string, root: string) => { const rel = path.relative(root, file); return rel === "" || (rel !== ".." && !rel.startsWith("../") && !path.isAbsolute(rel)); };
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
type RootIdentity = Pick<BigIntStats, "dev" | "ino">;
async function sameRoot(folder: string, identity: RootIdentity): Promise<boolean> {
  try { const stat = await fs.lstat(folder, { bigint: true }); return stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino; }
  catch { return false; }
}

/** Same Linux x64 defence-in-depth process-inspection filter used by the existing namespace experiment. */
function seccomp(): Buffer {
  const code: Buffer[] = [];
  const add = (op: number, yes: number, no: number, value: number) => { const b = Buffer.alloc(8); b.writeUInt16LE(op); b[2] = yes; b[3] = no; b.writeUInt32LE(value, 4); code.push(b); };
  add(0x20, 0, 0, 4); add(0x15, 1, 0, 0xc000003e); add(0x06, 0, 0, 0x80000000);
  add(0x20, 0, 0, 0); add(0x45, 0, 1, 0x40000000); add(0x06, 0, 0, 0x80000000);
  for (const syscall of [101, 310, 311, 312, 304, 298, 321, 323, 425, 434, 438]) { add(0x15, 0, 1, syscall); add(0x06, 0, 0, 0x00050001); }
  add(0x06, 0, 0, 0x7fff0000);
  return Buffer.concat(code);
}

async function treeBytes(snapshot: CodingSnapshot, binding: CodingExportBinding): Promise<CodingExportTree> {
  const entries: CodingExportEntry[] = snapshot.directories.map(file => ({ path: file, kind: "directory" }));
  let total = 0;
  for (const entry of snapshot.entries) {
    if ((total += entry.size) > 10 * 1024 * 1024) throw new Error("The coding review is too large.");
    const input = await fs.open(path.join(snapshot.directory, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await input.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(entry.size)) throw new Error("The private coding snapshot changed.");
      const bytes = await input.readFile(), after = await input.stat({ bigint: true });
      if (bytes.length !== entry.size || crypto.createHash("sha256").update(bytes).digest("hex") !== entry.digest ||
          before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.nlink !== after.nlink ||
          before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("The private coding snapshot changed.");
      entries.push({ path: entry.path, kind: "file", bytes, executable: entry.executable });
    } finally { await input.close(); }
  }
  return { binding, entries };
}

function refuseCredentialTree(tree: CodingExportTree): void {
  if (tree.entries.some(entry => codingWorkspaceFileProblem(entry.path, entry.kind === "file" ? entry.bytes : Buffer.alloc(0)))) {
    throw new Error("The selected coding tree contains credential files or secret text. Choose a project copy without credentials.");
  }
}

/** Per-workspace queue is the only capability exposed to the scoped file broker and approved command adapter. */
export class IsolatedCommandWorkspace {
  readonly executionRoot = "/work";
  private tail: Promise<void> = Promise.resolve();
  private readonly lease = new AsyncLocalStorage<boolean>();
  private epoch = 0;
  private retired = false;
  private failure: string | null = null;
  private closing: Promise<void> | null = null;
  private cleanup: Promise<void> | null = null;
  private exporting: Promise<IsolatedCommandReview> | null = null;
  private active: { cancel(): void } | null = null;
  private constructor(private readonly source: string, private readonly sourceIdentity: RootIdentity, private readonly baseDir: string, private readonly roots: string[],
    private readonly snapshot: CodingSnapshot, private readonly scratch: string, private readonly rootfs: string,
    private readonly baseline: CodingExportTree, private readonly limits: IsolatedCommandLimits, readonly nodeAvailable: boolean,
    private readonly admit?: () => boolean, readonly excludedRoots: readonly CodingExcludedRoot[] = [],
    private readonly manifest?: CodingProjectManifest, private readonly dependencies?: CodingDependencySnapshot) {}
  get scopeManifest(): CodingProjectManifest | undefined { return this.manifest ? codingProjectManifest(this.manifest) : undefined; }

  static async create(input: IsolatedCommandWorkspaceInput): Promise<IsolatedCommandWorkspace> {
    if (HOST_PLATFORM !== "linux" || HOST_ARCH !== "x64") throw new Error("Isolated command workspaces require Linux x64.");
    const signal = input.signal, hostAdmit = input.admit?.bind(input), excludedRoots = Object.freeze([...(input.scope?.excludeRoots ?? [])]);
    if (excludedRoots.length > 2 || new Set(excludedRoots).size !== excludedRoots.length || excludedRoots.some(name => name !== ".git" && name !== "node_modules")) throw new Error("Invalid explicit coding source scope.");
    const dependencyGrant = input.scope?.dependencies ? Object.freeze({ path: input.scope.dependencies.path, current: input.scope.dependencies.current.bind(input.scope.dependencies) }) : undefined;
    if (dependencyGrant && !excludedRoots.includes("node_modules")) throw new Error("Separate dependencies require excluding node_modules from the source scope.");
    const admit = hostAdmit || dependencyGrant ? () => (!hostAdmit || hostAdmit() === true) && (!dependencyGrant || dependencyGrant.current() === true) : undefined;
    const admitted = () => {
      signal?.throwIfAborted();
      let current = !admit; try { if (admit) current = admit() === true; } catch { current = false; }
      if (!current) throw new Error("The isolated coding task is no longer current.");
    };
    admitted();
    const limits = { ...DEFAULT_LIMITS, ...input.limits };
    if (Object.entries(limits).some(([key, value]) => !Number.isSafeInteger(value) || value < 1 || value > LIMIT_CAPS[key as keyof IsolatedCommandLimits])) throw new Error("Invalid isolated command limits.");
    createCodingReviewExport({ binding: input.binding, baseline: { binding: input.binding, entries: [] }, proposed: { binding: input.binding, entries: [] } });
    const wrapper = await fs.lstat(BWRAP);
    admitted();
    if (!wrapper.isFile() || wrapper.uid !== 0 || (wrapper.mode & 0o022) !== 0) throw new Error("A trusted system Bubblewrap is required.");
    await fs.access(BWRAP, constants.X_OK);
    admitted();
    if (!path.isAbsolute(input.source) || !path.isAbsolute(input.baseDir)) throw new Error("Choose absolute project and private coding paths.");
    const roots = await Promise.all(input.protectedPaths.map(p => fs.realpath(p)));
    admitted();
    const sourceHandle = await fs.open(input.source, DIRECTORY);
    let baseHandle: fs.FileHandle | undefined, snapshot: CodingSnapshot | undefined, scratch: string | undefined, workspace: IsolatedCommandWorkspace, dependencies: CodingDependencySnapshot | undefined;
    try {
      admitted();
      baseHandle = await fs.open(input.baseDir, DIRECTORY);
      admitted();
      const source = await fs.realpath(`/proc/self/fd/${sourceHandle.fd}`), base = await fs.realpath(`/proc/self/fd/${baseHandle.fd}`);
      const sourceIdentity = await sourceHandle.stat({ bigint: true }), baseIdentity = await baseHandle.stat({ bigint: true });
      admitted();
      if (within(source, base) || (sourceIdentity.dev === baseIdentity.dev && sourceIdentity.ino === baseIdentity.ino)) {
        throw new Error("The project must be outside Ember's private coding folder.");
      }
      // Bind admission and copying to the same opened source. A chooser path swap cannot select another private copy.
      snapshot = await createCodingSnapshot(`/proc/self/fd/${sourceHandle.fd}/.`, base, roots, { bytes: 10 * 1024 * 1024, fileBytes: 4 * 1024 * 1024 }, excludedRoots);
      admitted();
      if (!await sameRoot(source, sourceIdentity) || !await sameRoot(base, baseIdentity)) throw new Error("The project or private coding folder changed while copying.");
      const binding = { ...input.binding }, baseline = await treeBytes(snapshot, binding);
      admitted();
      refuseCredentialTree(baseline);
      if (dependencyGrant) dependencies = await createCodingDependencySnapshot({ source: dependencyGrant, baseDir: base, protectedPaths: roots, signal });
      admitted();
      const manifest = input.scope ? codingProjectManifest({ version: 1, source: { excludedRoots: [...excludedRoots], omitted: snapshot.excluded, byteLimit: 10 * 1024 * 1024 }, dependencies: dependencies?.manifest ?? null }) : undefined;
      createCodingReviewExport({ binding, baseline, proposed: baseline, current: baseline, ...(manifest ? { scope: manifest } : {}) });
      for (const name of excludedRoots) await fs.mkdir(path.join(snapshot.directory, name), { mode: 0o700 });
      admitted();
      scratch = await fs.mkdtemp(path.join(base, "ember-command-state-")); await fs.chmod(scratch, 0o700);
      const rootfs = path.join(scratch, "rootfs"); await fs.mkdir(rootfs, { mode: 0o700 });
      const assets = await copyIsolatedCommandAssets({ rootfs, protectedPaths: roots, ...(input.nodePath ? { nodePath: input.nodePath } : {}), signal: input.signal });
      admitted();
      for (const folder of ["work", "tmp", "proc", "dev"]) await fs.mkdir(path.join(rootfs, folder), { mode: 0o700 });
      if (excludedRoots.length) {
        await fs.mkdir(path.join(rootfs, "excluded"), { mode: 0o700 });
        for (const name of excludedRoots) await fs.mkdir(path.join(rootfs, "excluded", name), { mode: 0o700 });
      }
      await fs.symlink("usr/bin", path.join(rootfs, "bin"));
      await fs.writeFile(path.join(scratch, "seccomp.bpf"), seccomp(), { flag: "wx", mode: 0o600 });
      admitted();
      if (!await sameRoot(source, sourceIdentity) || !await sameRoot(base, baseIdentity)) throw new Error("The project or private coding folder changed while preparing commands.");
      admitted();
      workspace = new IsolatedCommandWorkspace(source, { dev: sourceIdentity.dev, ino: sourceIdentity.ino }, base, roots, snapshot, scratch, rootfs, baseline, limits, assets.node, admit, excludedRoots, manifest, dependencies);
    } catch (error) {
      if (scratch) await fs.rm(scratch, { recursive: true, force: true });
      await dependencies?.dispose();
      await snapshot?.dispose(); throw error;
    } finally { await sourceHandle.close(); await baseHandle?.close(); }
    try { admitted(); return workspace; }
    catch (error) { await workspace.close(); throw error; }
  }

  private admitted(): boolean {
    let current = !this.admit; try { if (this.admit) current = this.admit() === true; } catch { current = false; }
    if (!current) { this.retired = true; this.epoch++; this.active?.cancel(); }
    return current;
  }
  private check(): void {
    if (this.failure) throw new Error(this.failure);
    if (this.closing || this.retired || !this.admitted() || this.closing || this.retired) throw new Error("The isolated coding workspace stopped or closed.");
  }
  private queue<T>(operation: () => Promise<T>, privileged = false): Promise<T> {
    if (this.lease.getStore()) return Promise.reject(new Error("Nested isolated workspace operations are unsupported."));
    if (!privileged) { try { this.check(); } catch (error) { return Promise.reject(error); } }
    const epoch = this.epoch;
    const pending = this.tail.then(() => {
      if (this.failure) throw new Error(this.failure);
      if (!privileged) { this.check(); if (epoch !== this.epoch) throw new Error("The isolated workspace request was cancelled."); }
      return this.lease.run(true, operation);
    });
    this.tail = pending.then(() => undefined, () => undefined);
    return pending;
  }

  /** Trusted host callback only. Commands and all their descendants have stopped before this root is handed out. */
  files<T>(operation: (root: string) => Promise<T>): Promise<T> {
    return this.queue(async () => { this.check(); const value = await operation(this.snapshot.directory); this.check(); return value; });
  }

  run(command: string, cwd: string, onOutput: (bytes: Uint8Array, stream: "stdout" | "stderr") => void, signal: AbortSignal): Promise<IsolatedCommandResult> {
    if (typeof command !== "string" || !command.trim() || command.includes("\0") || Buffer.byteLength(command) > this.limits.commandBytes) return Promise.reject(new Error("The isolated command is empty, invalid or too long."));
    if (typeof cwd !== "string" || (cwd !== "/work" && !cwd.startsWith("/work/")) || cwd.length > 4096 || cwd.split("/").some(p => p === "." || p === "..") || /[\\\p{Cc}\p{Cf}]/u.test(cwd)) return Promise.reject(new Error("Choose a directory inside the isolated workspace."));
    return this.queue(() => this.execute(command, cwd, onOutput, signal));
  }

  private async execute(command: string, cwd: string, onOutput: (bytes: Uint8Array, stream: "stdout" | "stderr") => void, signal: AbortSignal): Promise<IsolatedCommandResult> {
    if (signal.aborted) return { exitCode: null, signal: "SIGKILL", stopped: true, timedOut: false, outputLimited: false, output: "", observed: true };
    // Commands may encode anything they can read. Revalidate the complete stopped tree and refuse known credentials
    // before every launch, including files produced by a preceding command. No omission silently changes the project.
    const checked = await createCodingSnapshot(this.snapshot.directory, this.baseDir, this.roots, { bytes: 10 * 1024 * 1024, fileBytes: 4 * 1024 * 1024 }, this.excludedRoots);
    try { this.check(); const tree = await treeBytes(checked, this.baseline.binding); this.check(); refuseCredentialTree(tree); } finally { await checked.dispose(); }
    this.check();
    if (signal.aborted || this.retired) return { exitCode: null, signal: "SIGKILL", stopped: true, timedOut: false, outputLimited: false, output: "", observed: true };
    // Refuse cwd aliases before handing the path to Bubblewrap. The scoped file broker performs its own fd checks.
    let folder = this.snapshot.directory;
    for (const component of cwd.slice(6).split("/").filter(Boolean)) {
      folder = path.join(folder, component); const stat = await fs.lstat(folder);
      this.check();
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The isolated command directory is unavailable.");
    }
    const receiptFile = path.join(this.scratch, `command-${crypto.randomUUID()}.json`);
    await fs.writeFile(receiptFile, "", { flag: "wx", mode: 0o600 });
    if (signal.aborted || this.retired || !this.admitted()) {
      await fs.rm(receiptFile, { force: true });
      return { exitCode: null, signal: "SIGKILL", stopped: true, timedOut: false, outputLimited: false, output: "", observed: true };
    }
    const filter = openSync(path.join(this.scratch, "seccomp.bpf"), constants.O_RDONLY | constants.O_NOFOLLOW);
    let receiptFd = -1, child: ChildProcess;
    try {
      receiptFd = openSync(receiptFile, constants.O_WRONLY | constants.O_NOFOLLOW);
      child = spawn(BWRAP, ["--seccomp", "3", "--info-fd", "4", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-net", "--new-session", "--die-with-parent", "--clearenv",
        "--setenv", "HOME", "/tmp", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "TMPDIR", "/tmp", "--setenv", "LC_ALL", "C",
        "--ro-bind", this.rootfs, "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--bind", this.snapshot.directory, "/work",
        ...this.excludedRoots.flatMap(name => ["--ro-bind", name === "node_modules" && this.dependencies ? this.dependencies.directory : path.join(this.rootfs, "excluded", name), `/work/${name}`]), "--chdir", cwd,
        "--", "/usr/bin/bash", "--noprofile", "--norc", "-c", BARRIER, "ember-command", command],
      { shell: false, env: { HOME: "/tmp", PATH: "/usr/bin:/bin", LC_ALL: "C" }, stdio: ["pipe", "pipe", "pipe", filter, receiptFd] });
    } finally { closeSync(filter); if (receiptFd >= 0) closeSync(receiptFd); }
    let closed = false, stopped = false, timedOut = false, outputLimited = false, output = "", size = 0, deliveryFailed = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined, rejectKill!: (error: Error) => void;
    const killFailure = new Promise<never>((_resolve, reject) => { rejectKill = reject; }); void killFailure.catch(() => undefined);
    const cancel = () => {
      if (closed) return;
      child.kill("SIGKILL");
      killTimer ??= setTimeout(() => rejectKill(new Error("The isolated command did not confirm shutdown.")), this.limits.proofMs);
      killTimer.unref?.();
    };
    child.stdin!.on("error", cancel);
    this.active = { cancel };
    // This signal belongs to one run (command-window Stop/timeout), rather than the whole task's workspace.
    const abort = () => { stopped = true; cancel(); };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const timer = setTimeout(() => { timedOut = true; cancel(); }, this.limits.maxMs); timer.unref?.();
    const decoders = { stdout: new StringDecoder("utf8"), stderr: new StringDecoder("utf8") };
    const receive = (bytes: Buffer, stream: "stdout" | "stderr") => {
      const kept = bytes.subarray(0, Math.max(0, this.limits.outputBytes - size)); size += kept.length;
      const text = decoders[stream].write(kept); output += text;
      if (kept.length && !deliveryFailed) { try { onOutput(kept, stream); } catch { deliveryFailed = true; cancel(); } }
      if (kept.length < bytes.length) { outputLimited = true; cancel(); }
    };
    child.stdout!.on("data", (bytes: Buffer) => receive(bytes, "stdout")); child.stderr!.on("data", (bytes: Buffer) => receive(bytes, "stderr"));
    child.stdout!.on("error", () => { deliveryFailed = true; cancel(); }); child.stderr!.on("error", () => { deliveryFailed = true; cancel(); });
    const ending = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      child.once("error", reject); child.once("close", (code, why) => { closed = true; if (killTimer) clearTimeout(killTimer); resolve({ code, signal: why }); });
    });
    void ending.catch(() => undefined);
    let receipt: ExperimentalNamespaceReceipt | undefined;
    try {
      const until = performance.now() + this.limits.proofMs;
      while (!receipt) {
        try { receipt = await ExperimentalNamespaceReceipt.capture(receiptFile); }
        catch (error) {
          if (closed || performance.now() >= until || signal.aborted) throw new Error("The isolated command namespace could not be verified.", { cause: error });
          await new Promise<void>(resolve => setTimeout(resolve, 10));
        }
      }
      // No await may separate this host authority check from releasing the trusted stdin barrier.
      const current = this.admitted();
      if (current && !signal.aborted && !this.retired && !timedOut) child.stdin!.end("ember-command-ready\n"); else { stopped = true; cancel(); }
      const result = await Promise.race([ending, killFailure]);
      await receipt.requireExited(this.limits.proofMs);
      if (deliveryFailed) throw new Error("The isolated command output could not be delivered.");
      output += decoders.stdout.end() + decoders.stderr.end();
      return { exitCode: result.code, signal: result.signal, stopped: stopped || this.retired, timedOut, outputLimited, output, observed: true };
    } catch (error) {
      cancel();
      try { await Promise.race([ending, killFailure]); if (!receipt) throw new Error("Missing namespace receipt", { cause: error }); await receipt.requireExited(this.limits.proofMs); }
      catch { this.failure = "An isolated command could not be verified as stopped. The coding workspace was retained."; }
      if (this.failure) throw new Error(this.failure, { cause: error });
      throw error;
    } finally {
      clearTimeout(timer); if (killTimer) clearTimeout(killTimer); signal.removeEventListener("abort", abort); this.active = null;
      if (!this.failure) await fs.rm(receiptFile, { force: true });
    }
  }

  /** Synchronous cancellation first; the promise waits until the exclusive operation and stop proof settle. */
  stop(): Promise<void> {
    this.retired = true; this.epoch++; this.active?.cancel();
    if (this.lease.getStore()) return Promise.reject(new Error("Stop cannot wait inside its own workspace lease."));
    return this.tail.then(() => { if (this.failure) throw new Error(this.failure); });
  }

  exportReview(exportBase: string): Promise<IsolatedCommandReview> {
    if (this.closing || this.cleanup || this.exporting) return Promise.reject(new Error("The coding workspace is closing or already exporting."));
    this.retired = true; this.epoch++; this.active?.cancel();
    const pending = this.queue(() => this.exportFiles(exportBase), true); this.exporting = pending;
    void pending.then(() => { this.exporting = null; }, () => { this.exporting = null; }); return pending;
  }

  private async exportFiles(exportBase: string): Promise<IsolatedCommandReview> {
    if (!path.isAbsolute(exportBase)) throw new Error("Choose an absolute private review folder.");
    const root = await fs.realpath(exportBase), stat = await fs.stat(root);
    if (!stat.isDirectory() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 ||
        [this.source, this.snapshot.directory, this.scratch, ...this.roots].some(folder => within(root, folder))) throw new Error("The review folder must be private and outside coding and protected files.");
    let proposed: CodingSnapshot | undefined, current: CodingSnapshot | undefined, directory: string | undefined, committed: IsolatedCommandReview | undefined;
    try {
      proposed = await createCodingSnapshot(this.snapshot.directory, this.baseDir, this.roots, { bytes: 10 * 1024 * 1024, fileBytes: 4 * 1024 * 1024 }, this.excludedRoots);
      const result = await treeBytes(proposed, this.baseline.binding); refuseCredentialTree(result); let live: CodingExportTree | undefined;
      try {
        if (!this.admitted() || !await sameRoot(this.source, this.sourceIdentity)) throw new Error("The selected source folder changed.");
        const source = await fs.open(this.source, DIRECTORY);
        try {
          const identity = await source.stat({ bigint: true });
          if (!this.admitted() || identity.dev !== this.sourceIdentity.dev || identity.ino !== this.sourceIdentity.ino) throw new Error("The selected source folder changed.");
          current = await createCodingSnapshot(`/proc/self/fd/${source.fd}/.`, this.baseDir, this.roots, { bytes: 10 * 1024 * 1024, fileBytes: 4 * 1024 * 1024 }, this.excludedRoots);
          const captured = await treeBytes(current, this.baseline.binding); refuseCredentialTree(captured);
          if (!this.admitted() || !await sameRoot(this.source, this.sourceIdentity) || !this.admitted()) throw new Error("The selected source folder changed.");
          live = captured;
        } finally { await source.close(); }
      } catch { /* Explicit unknown/conflicting current state below. */ }
      const rendered = createCodingReviewExport({ binding: this.baseline.binding, baseline: this.baseline, proposed: result, ...(live ? { current: live } : {}), ...(this.manifest ? { scope: this.manifest } : {}) });
      directory = await fs.mkdtemp(path.join(root, "ember-coding-review-")); await fs.chmod(directory, 0o700);
      for (const [name, bytes] of [["review.json", rendered.json], ["changes.patch", rendered.review.textPatch]]) {
        const out = await fs.open(path.join(directory, name), "wx", 0o600); try { await out.writeFile(bytes); await out.sync(); } finally { await out.close(); }
      }
      committed = { directory, review: rendered.review, cleanup: "complete" }; directory = undefined;
      try { await this.cleanupFiles(); } catch { committed.cleanup = "retained"; }
      return committed;
    } finally {
      for (const cleanup of [() => proposed?.dispose(), () => current?.dispose(), () => directory ? fs.rm(directory, { recursive: true, force: true }) : undefined]) {
        try { await cleanup(); } catch { if (committed) committed.cleanup = "retained"; }
      }
    }
  }

  private cleanupFiles(): Promise<void> {
    if (!this.cleanup) this.cleanup = (async () => {
      if (this.failure) throw new Error(this.failure);
      await fs.rm(this.scratch, { recursive: true, force: true }); await this.snapshot.dispose();
      await this.dependencies?.dispose();
    })(); return this.cleanup;
  }
  close(): Promise<void> {
    if (this.lease.getStore()) return Promise.reject(new Error("Close cannot wait inside its own workspace lease."));
    if (!this.closing) {
      this.retired = true; this.epoch++; this.active?.cancel(); const pending = this.tail;
      this.closing = pending.then(() => this.cleanupFiles());
    }
    return this.closing;
  }
}
