/**
 * Linux x64 experiment only. NOT a production security boundary or coding session.
 *
 * It copies an explicitly enumerated, minimal test toolchain and two runtime files into fresh private inodes,
 * then starts the entire SDK runtime inside Bubblewrap. No host project, home, credential, executable tree, or
 * ambient environment is mounted. Default networking is disabled. Test-only shared networking is restricted by
 * this API to an offline mock provider and a literal fake key. An experimental seccomp filter denies several known
 * process-inspection syscalls, but is not a complete syscall policy. Never pass a real credential or enable production
 * coding with this experiment.
 */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CopilotClient, RuntimeConnection, type CopilotRequestHandler, type CopilotSession } from "@github/copilot-sdk";
import { createCodingSnapshot, type CodingSnapshot } from "./coding-snapshot";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import { ExperimentalNamespaceReceipt } from "./experimental-stop-receipt";
import { createCodingReviewExport, type CodingExportBinding, type CodingExportEntry, type CodingExportTree, type CodingReviewExport } from "./coding-result-export";
import { codingModelPlaceholderProvider } from "./coding-model-request-handler";
import { DEFAULT_CODING_RPC_FRAMING_LIMITS, type CodingRpcFramingLimits } from "./coding-rpc-framing";
import { encodeExperimentalCodingRpcProxySpec, EXPERIMENTAL_CODING_RPC_PROXY_FLAG } from "./coding-rpc-proxy";

export interface ExperimentalIsolatedRuntimeInput {
  source: string;
  baseDir: string;
  protectedPaths: readonly string[];
  runtimePath: string;
  /** Only for a disposable local model test; this explicitly shares host networking with the namespace. */
  sharedNetworkForTest?: { mockModelUrl: string };
  /** Test with a real private procfs; the default exposes only a synthetic /proc/self/exe. Not an auth boundary. */
  privateProcForTest?: boolean;
  /** Host-only SDK adapter; never serialised or passed through the namespace environment. No shared network. */
  requestHandler?: CopilotRequestHandler;
  /** Host-created identity/model for the adapter's fixed synthetic provider route. */
  sessionForTest?: { sessionId: string; model: string };
  /** Explicit host-only test helper, separately bundled into a private CJS file. Not a packaged product launcher. */
  proxyForTest?: { nodePath: string; helperPath: string; limits?: Partial<CodingRpcFramingLimits> };
}

const BWRAP = "/usr/bin/bwrap";
// This deliberately supports only one layout for the offline experiment; missing files fail closed.
// No host system directory is mounted into the namespace, and copied executables are not a usable full toolchain.
const SYSTEM_FILES: readonly [string, string][] = [
  ["/usr/bin/bash", "usr/bin/bash"], ["/usr/bin/cat", "usr/bin/cat"], ["/usr/bin/sleep", "usr/bin/sleep"],
  ["/lib/x86_64-linux-gnu/libc.so.6", "lib/x86_64-linux-gnu/libc.so.6"],
  ["/lib/x86_64-linux-gnu/libm.so.6", "lib/x86_64-linux-gnu/libm.so.6"],
  ["/lib/x86_64-linux-gnu/libdl.so.2", "lib/x86_64-linux-gnu/libdl.so.2"],
  ["/lib/x86_64-linux-gnu/libpthread.so.0", "lib/x86_64-linux-gnu/libpthread.so.0"],
  ["/lib/x86_64-linux-gnu/libutil.so.1", "lib/x86_64-linux-gnu/libutil.so.1"],
  ["/lib/x86_64-linux-gnu/libtinfo.so.6", "lib/x86_64-linux-gnu/libtinfo.so.6"],
  ["/lib64/ld-linux-x86-64.so.2", "lib64/ld-linux-x86-64.so.2"],
];
const MAX_ASSET = 256n * 1024n * 1024n;

/** Classic BPF seccomp program for Linux x86-64. Other architectures fail closed before this is constructed. */
function experimentalSeccomp(): Buffer {
  const instructions: Buffer[] = [];
  const add = (code: number, yes: number, no: number, value: number) => {
    const instruction = Buffer.alloc(8);
    instruction.writeUInt16LE(code, 0); instruction.writeUInt8(yes, 2); instruction.writeUInt8(no, 3); instruction.writeUInt32LE(value, 4);
    instructions.push(instruction);
  };
  const LOAD = 0x20, EQUAL = 0x15, SET = 0x45, RETURN = 0x06;
  const KILL = 0x80000000, DENY = 0x00050001, ALLOW = 0x7fff0000;
  add(LOAD, 0, 0, 4); add(EQUAL, 1, 0, 0xc000003e); add(RETURN, 0, 0, KILL); // AUDIT_ARCH_X86_64
  add(LOAD, 0, 0, 0); add(SET, 0, 1, 0x40000000); add(RETURN, 0, 0, KILL); // deny x32 ABI
  // ptrace, process_vm_readv/writev, kcmp, open_by_handle_at, perf_event_open, bpf, userfaultfd,
  // io_uring_setup, pidfd_open and pidfd_getfd. This list is not an exhaustive data-exfiltration policy.
  for (const syscall of [101, 310, 311, 312, 304, 298, 321, 323, 425, 434, 438]) {
    add(EQUAL, 0, 1, syscall); add(RETURN, 0, 0, DENY);
  }
  add(RETURN, 0, 0, ALLOW);
  return Buffer.concat(instructions);
}

function within(file: string, root: string): boolean {
  const relative = path.relative(root, file);
  return !relative || (relative !== ".." && !relative.startsWith("../") && !path.isAbsolute(relative));
}

function localTestModel(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.hash || url.search) {
    throw new Error("The isolation experiment requires a local test model on 127.0.0.1.");
  }
  return url.toString().replace(/\/$/, "");
}

/** Reads only a private fresh-inode copy produced by the mount-aware snapshotter, never the live project/result. */
async function snapshotBytes(snapshot: CodingSnapshot, binding: CodingExportBinding): Promise<CodingExportTree> {
  const entries: CodingExportEntry[] = snapshot.directories.map(file => ({ path: file, kind: "directory" }));
  let bytes = 0;
  for (const entry of snapshot.entries) {
    if ((bytes += entry.size) > 10 * 1024 * 1024) throw new Error("The experimental review is too large.");
    const file = await fs.open(path.join(snapshot.directory, entry.path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await file.stat({ bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.size !== BigInt(entry.size)) throw new Error("The private review snapshot changed.");
      const data = await file.readFile(), after = await file.stat({ bigint: true });
      if (data.length !== entry.size || crypto.createHash("sha256").update(data).digest("hex") !== entry.digest ||
          before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.size !== after.size ||
          before.nlink !== after.nlink || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) throw new Error("The private review snapshot changed.");
      entries.push({ path: entry.path, kind: "file", bytes: data, executable: entry.executable });
    } finally { await file.close(); }
  }
  return { binding, entries };
}

/** Copy one regular, unlinked asset through an open fd. Never mount its host directory into the namespace. */
async function copyAsset(source: string, target: string, protectedRoots: readonly string[], system: boolean): Promise<void> {
  const real = await fs.realpath(source);
  if (protectedRoots.some(p => within(real, p))) throw new Error("An isolation asset reaches protected data.");
  const input = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size < 0n || before.size > MAX_ASSET ||
        (system && (before.uid !== 0n || (before.mode & 0o022n) !== 0n))) throw new Error("An isolation asset cannot be verified.");
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const output = await fs.open(target, "wx", before.mode & 0o111n ? 0o700 : 0o600);
    try {
      const size = Number(before.size), buffer = Buffer.allocUnsafe(64 * 1024);
      for (let offset = 0; offset < size;) {
        const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, size - offset), offset);
        if (!bytesRead) throw new Error("An isolation asset changed while copying.");
        let written = 0;
        while (written < bytesRead) {
          const n = (await output.write(buffer, written, bytesRead - written)).bytesWritten;
          if (!n) throw new Error("Could not copy an isolation asset.");
          written += n;
        }
        offset += bytesRead;
      }
      const after = await input.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.nlink !== after.nlink ||
          before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) {
        throw new Error("An isolation asset changed while copying.");
      }
    } finally { await output.close(); }
  } finally { await input.close(); }
}

/** Tokenless and local-mock-only; never used by the product coding flow. */
export class ExperimentalIsolatedRuntime {
  private closing: Promise<void> | null = null;
  private cleanup: Promise<void> | null = null;
  private stopping: Promise<void> | null = null;
  private session: CopilotSession | null = null;
  private busy = false;
  private reviewOperation: Promise<{ directory: string; review: CodingReviewExport; cleanup: "complete" | "retained" }> | null = null;
  private constructor(private readonly client: CopilotClient, private readonly snapshot: CodingSnapshot,
    private readonly scratch: string, private readonly modelUrl: string | null,
    private readonly receipt: ExperimentalNamespaceReceipt, private readonly baseline: CodingExportTree,
    private readonly source: string, private readonly baseDir: string, private readonly protectedRoots: string[],
    private readonly bridge: ExperimentalIsolatedRuntimeInput["sessionForTest"]) {}

  /** Tests may inspect the disposable copy; this is never the host project directory. */
  get copyPath(): string { return this.snapshot.directory; }

  static async start(input: ExperimentalIsolatedRuntimeInput): Promise<ExperimentalIsolatedRuntime> {
    if (HOST_PLATFORM !== "linux" || HOST_ARCH !== "x64") throw new Error("The isolated runtime experiment requires Linux x64.");
    const modelUrl = input.sharedNetworkForTest ? localTestModel(input.sharedNetworkForTest.mockModelUrl) : null;
    if (!!input.requestHandler !== !!input.sessionForTest || (input.requestHandler && modelUrl) ||
        (input.sessionForTest && (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(input.sessionForTest.sessionId) ||
          !input.sessionForTest.model || input.sessionForTest.model.length > 200 || /[\p{Cc}\p{Cf}]/u.test(input.sessionForTest.model)))) {
      throw new Error("The host model adapter requires a fixed session and model without shared networking.");
    }
    if (!path.isAbsolute(input.runtimePath) || !path.isAbsolute(input.source)) throw new Error("Absolute paths are required.");
    if (input.proxyForTest) {
      const { nodePath, helperPath } = input.proxyForTest;
      if (!path.isAbsolute(nodePath) || !path.isAbsolute(helperPath)) throw new Error("The experimental RPC helper requires absolute paths.");
      const [node, helper, parent] = await Promise.all([fs.lstat(nodePath), fs.lstat(helperPath), fs.stat(path.dirname(helperPath))]);
      if (!node.isFile() || node.isSymbolicLink() || (node.uid !== 0 && node.uid !== process.getuid?.()) || (node.mode & 0o022) !== 0 || !helper.isFile() || helper.isSymbolicLink() || helper.nlink !== 1 ||
          helper.uid !== process.getuid?.() || (helper.mode & 0o077) !== 0 || !parent.isDirectory() || parent.uid !== process.getuid?.() || (parent.mode & 0o077) !== 0) {
        throw new Error("The experimental RPC helper must be a trusted private host file.");
      }
      await fs.access(nodePath, constants.X_OK);
    }
    const wrapper = await fs.stat(BWRAP);
    if (!wrapper.isFile() || wrapper.uid !== 0 || (wrapper.mode & 0o022) !== 0) throw new Error("A trusted system Bubblewrap is required.");
    await fs.access(BWRAP, constants.X_OK);
    const runtime = await fs.realpath(input.runtimePath);
    const roots = await Promise.all(input.protectedPaths.map(p => fs.realpath(p)));
    if (!roots.length) throw new Error("Protected paths are required.");
    const snapshot = await createCodingSnapshot(input.source, input.baseDir, roots);
    let scratch: string | undefined;
    let client: CopilotClient | undefined;
    let receipt: ExperimentalNamespaceReceipt | undefined;
    try {
      const binding = { owner: crypto.createHash("sha256").update("offline-isolation-experiment").digest("hex"), session: crypto.randomUUID(), snapshot: crypto.randomUUID() };
      // Retain independent bytes before any runtime can edit its copy. This offline binding is not an auth grant.
      const baseline = await snapshotBytes(snapshot, binding);
      createCodingReviewExport({ binding, baseline, proposed: baseline, current: baseline });
      scratch = await fs.mkdtemp(path.join(await fs.realpath(input.baseDir), "ember-isolation-state-"));
      await fs.chmod(scratch, 0o700);
      const rootfs = path.join(scratch, "rootfs"), state = path.join(scratch, "state");
      await fs.mkdir(rootfs, { mode: 0o700 }); await fs.mkdir(state, { mode: 0o700 });
      const filter = path.join(scratch, "experimental-seccomp.bpf");
      await fs.writeFile(filter, experimentalSeccomp(), { flag: "wx", mode: 0o600 });
      const receiptFile = path.join(scratch, "namespace-receipt.json");
      await fs.writeFile(receiptFile, "", { flag: "wx", mode: 0o600 });
      for (const [source, target] of SYSTEM_FILES) await copyAsset(source, path.join(rootfs, target), roots, true);
      await copyAsset(runtime, path.join(rootfs, "runtime/copilot-runtime"), roots, false);
      await copyAsset(path.join(path.dirname(runtime), "runtime.node"), path.join(rootfs, "runtime/runtime.node"), roots, false);
      await fs.symlink("usr/bin", path.join(rootfs, "bin"));
      await fs.symlink("bash", path.join(rootfs, "usr/bin/sh"));
      for (const dir of ["work", "state", "tmp", "proc", "dev"]) await fs.mkdir(path.join(rootfs, dir), { mode: 0o700 });
      // The bundled runtime locates runtime.node through /proc/self/exe. Give it a synthetic link without mounting
      // host procfs. This does not prevent same-UID ptrace or process_vm_readv; it is not an authentication boundary.
      await fs.mkdir(path.join(rootfs, "proc/self"), { mode: 0o700 });
      await fs.symlink("/runtime/copilot-runtime", path.join(rootfs, "proc/self/exe"));
      const args = ["--seccomp", "3", "--info-fd", "4", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--new-session", "--die-with-parent",
        ...(!modelUrl ? ["--unshare-net"] : []), "--clearenv", "--setenv", "HOME", "/state", "--setenv", "COPILOT_HOME", "/state",
        "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "NO_PROXY", "127.0.0.1", "--ro-bind", rootfs, "/",
        ...(input.privateProcForTest ? ["--proc", "/proc"] : []), "--dev", "/dev", "--tmpfs", "/tmp",
        "--bind", snapshot.directory, "/work", "--bind", state, "/state", "--chdir", "/work", "--", "/runtime/copilot-runtime"];
      // Supplying a connection environment prevents the SDK from inheriting process.env, and bwrap clears it again.
      // The SDK exposes only standard streams, so a fixed trusted shell opens the BPF file as fd 3 before exec.
      // All variable arguments are separate argv elements; none are interpolated into the shell program.
      const connection = input.proxyForTest ? RuntimeConnection.forStdio({
        path: input.proxyForTest.nodePath,
        args: [input.proxyForTest.helperPath, EXPERIMENTAL_CODING_RPC_PROXY_FLAG, encodeExperimentalCodingRpcProxySpec({
          version: 1, bwrapArgs: args, filterPath: filter, receiptPath: receiptFile,
          limits: { ...DEFAULT_CODING_RPC_FRAMING_LIMITS, ...input.proxyForTest.limits },
        })], env: { HOME: "/state", PATH: "/usr/bin:/bin" },
      }) : RuntimeConnection.forStdio({ path: "/usr/bin/bash", args: ["-c", 'exec 3<"$1"; exec 4>"$2"; shift 2; exec "$@"', "ember-isolation", filter, receiptFile, BWRAP, ...args],
        env: { HOME: "/state", PATH: "/usr/bin:/bin" } });
      client = new CopilotClient({ mode: "empty", baseDirectory: "/state", useLoggedInUser: false,
        ...(input.requestHandler ? { requestHandler: input.requestHandler } : {}),
        connection });
      await client.start();
      receipt = await ExperimentalNamespaceReceipt.capture(receiptFile);
      return new ExperimentalIsolatedRuntime(client, snapshot, scratch, modelUrl, receipt, baseline, await fs.realpath(input.source), await fs.realpath(input.baseDir), roots,
        input.sessionForTest ? { ...input.sessionForTest } : undefined);
    } catch (error) {
      // Never remove files while a failed-to-stop runtime could still be using them.
      const errors = client ? await client.stop().catch(() => [new Error("stop failed")]) : [];
      let confirmed = !client;
      if (!errors.length && receipt) {
        try { await receipt.requireExited(); confirmed = true; } catch { /* Unknown process state retains every copy. */ }
      }
      if (confirmed) { if (scratch) await fs.rm(scratch, { recursive: true, force: true }); await snapshot.dispose(); }
      throw error;
    }
  }

  /** Only a local mock and the fixed fake provider key are supported. */
  async request(prompt: string): Promise<void> {
    if (this.closing || this.stopping || this.reviewOperation || this.busy) throw new Error("The isolation experiment is busy or closed.");
    if (!this.modelUrl && !this.bridge) throw new Error("The isolation experiment has no model network.");
    this.busy = true;
    try {
      if (!this.session) {
        const session = await this.client.createSession({ ...(this.bridge
          ? { sessionId: this.bridge.sessionId, model: this.bridge.model, provider: codingModelPlaceholderProvider() }
          : { model: "mock-model", provider: { type: "openai" as const, baseUrl: this.modelUrl!, apiKey: "test" } }),
          workingDirectory: "/work", enableConfigDiscovery: false, availableTools: ["builtin:*"],
          onPermissionRequest: () => ({ kind: "approve-once" } as never) });
        if (this.closing) { await session.disconnect().catch(() => undefined); throw new Error("The isolation experiment is closed."); }
        this.session = session;
      }
      await this.session.sendAndWait({ prompt }, 15_000);
    } catch (error) {
      // A send timeout alone does not cancel a running runtime task.
      try { await this.session?.abort(); } catch { await this.close().catch(() => undefined); }
      throw error;
    } finally { this.busy = false; }
  }

  /** Stops and verifies the namespace, then exports review data outside the source before removing runtime copies. */
  exportReview(exportBase: string): Promise<{ directory: string; review: CodingReviewExport; cleanup: "complete" | "retained" }> {
    if (this.closing || this.cleanup || this.busy || this.reviewOperation) return Promise.reject(new Error("The isolation experiment is busy or closed."));
    if (!path.isAbsolute(exportBase)) return Promise.reject(new Error("Choose an absolute private export folder."));
    // Acquire the read/export lease before yielding. Public close waits for this whole operation, including cleanup;
    // export uses private cleanup directly so it never waits for its own public-close waiter.
    const operation = Promise.resolve().then(() => this.doExportReview(exportBase));
    this.reviewOperation = operation;
    const release = () => { if (this.reviewOperation === operation) this.reviewOperation = null; };
    void operation.then(release, release);
    return operation;
  }

  private async doExportReview(exportBase: string): Promise<{ directory: string; review: CodingReviewExport; cleanup: "complete" | "retained" }> {
    let result: CodingSnapshot | undefined, current: CodingSnapshot | undefined, directory: string | undefined;
    let completed: { directory: string; review: CodingReviewExport; cleanup: "complete" | "retained" } | undefined;
    try {
      await this.stopRuntime();
      const root = await fs.realpath(exportBase), rootStat = await fs.stat(root);
      if (!rootStat.isDirectory() || rootStat.uid !== process.getuid?.() || (rootStat.mode & 0o077) !== 0 ||
          [this.source, this.snapshot.directory, this.scratch, ...this.protectedRoots].some(folder => within(root, folder))) throw new Error("The export folder must be private and outside the project, runtime and protected data.");
      result = await createCodingSnapshot(this.snapshot.directory, this.baseDir, this.protectedRoots);
      const proposed = await snapshotBytes(result, this.baseline.binding);
      let live: CodingExportTree | undefined;
      try {
        current = await createCodingSnapshot(this.source, this.baseDir, this.protectedRoots);
        live = await snapshotBytes(current, this.baseline.binding);
      } catch { /* Explicitly represented below as unknown/conflicting current state; proposed and baseline bytes survive. */ }
      const rendered = createCodingReviewExport({ binding: this.baseline.binding, baseline: this.baseline, proposed, ...(live ? { current: live } : {}) });
      directory = await fs.mkdtemp(path.join(root, "ember-coding-review-"));
      await fs.chmod(directory, 0o700);
      for (const [name, contents] of [["review.json", rendered.json], ["changes.patch", rendered.review.textPatch]]) {
        const output = await fs.open(path.join(directory, name), "wx", 0o600);
        try { await output.writeFile(contents); await output.sync(); } finally { await output.close(); }
      }
      const committed = directory;
      directory = undefined;
      let cleanup: "complete" | "retained" = "complete";
      try { await this.cleanupRuntime(); } catch { cleanup = "retained"; }
      completed = { directory: committed, review: rendered.review, cleanup };
      return completed;
    } finally {
      let cleanupFailure: unknown;
      for (const cleanup of [() => result?.dispose(), () => current?.dispose(), () => directory ? fs.rm(directory, { recursive: true, force: true }) : undefined]) {
        try { await cleanup(); } catch (error) { cleanupFailure ??= error; }
      }
      if (cleanupFailure && completed) completed.cleanup = "retained";
      // Without a committed export, preserve the operation's original error and retain any unremoved private copy.
    }
  }

  private stopRuntime(): Promise<void> {
    if (!this.stopping) this.stopping = (async () => {
      let disconnectError: unknown;
      try { await this.session?.disconnect(); } catch (error) { disconnectError = error; }
      const errors = await this.client.stop();
      if (errors.length) throw new Error("The experimental runtime could not be stopped safely.");
      await this.receipt.requireExited();
      if (disconnectError) throw disconnectError;
    })();
    return this.stopping;
  }

  private cleanupRuntime(): Promise<void> {
    if (!this.cleanup) this.cleanup = (async () => {
      await this.stopRuntime();
      await fs.rm(this.scratch, { recursive: true, force: true });
      await this.snapshot.dispose();
    })();
    return this.cleanup;
  }

  close(): Promise<void> {
    if (!this.closing) {
      const exporting = this.reviewOperation;
      this.closing = Promise.resolve().then(async () => {
        // A requested close still discards a failed result, but only after every reader and partial-export cleanup
        // has settled. The export's own failure remains its caller's result.
        try { await exporting; } catch { /* The explicit close still retires the runtime copies. */ }
        await this.cleanupRuntime();
      });
    }
    return this.closing;
  }
}
