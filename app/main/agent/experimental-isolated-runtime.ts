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
import { CopilotClient, RuntimeConnection, type CopilotSession } from "@github/copilot-sdk";
import { createCodingSnapshot, type CodingSnapshot } from "./coding-snapshot";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";

export interface ExperimentalIsolatedRuntimeInput {
  source: string;
  baseDir: string;
  protectedPaths: readonly string[];
  runtimePath: string;
  /** Only for a disposable local model test; this explicitly shares host networking with the namespace. */
  sharedNetworkForTest?: { mockModelUrl: string };
  /** Test with a real private procfs; the default exposes only a synthetic /proc/self/exe. Not an auth boundary. */
  privateProcForTest?: boolean;
}

const BWRAP = "/usr/bin/bwrap";
// This deliberately supports only one layout for the offline experiment; missing files fail closed.
// No host system directory is mounted into the namespace, and copied executables are not a usable full toolchain.
const SYSTEM_FILES: readonly [string, string][] = [
  ["/usr/bin/bash", "usr/bin/bash"], ["/usr/bin/cat", "usr/bin/cat"],
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
  private session: CopilotSession | null = null;
  private busy = false;
  private constructor(private readonly client: CopilotClient, private readonly snapshot: CodingSnapshot,
    private readonly scratch: string, private readonly modelUrl: string | null) {}

  /** Tests may inspect the disposable copy; this is never the host project directory. */
  get copyPath(): string { return this.snapshot.directory; }

  static async start(input: ExperimentalIsolatedRuntimeInput): Promise<ExperimentalIsolatedRuntime> {
    if (HOST_PLATFORM !== "linux" || HOST_ARCH !== "x64") throw new Error("The isolated runtime experiment requires Linux x64.");
    const modelUrl = input.sharedNetworkForTest ? localTestModel(input.sharedNetworkForTest.mockModelUrl) : null;
    if (!path.isAbsolute(input.runtimePath) || !path.isAbsolute(input.source)) throw new Error("Absolute paths are required.");
    const wrapper = await fs.stat(BWRAP);
    if (!wrapper.isFile() || wrapper.uid !== 0 || (wrapper.mode & 0o022) !== 0) throw new Error("A trusted system Bubblewrap is required.");
    await fs.access(BWRAP, constants.X_OK);
    const runtime = await fs.realpath(input.runtimePath);
    const roots = await Promise.all(input.protectedPaths.map(p => fs.realpath(p)));
    if (!roots.length) throw new Error("Protected paths are required.");
    const snapshot = await createCodingSnapshot(input.source, input.baseDir, roots);
    let scratch: string | undefined;
    let client: CopilotClient | undefined;
    try {
      scratch = await fs.mkdtemp(path.join(await fs.realpath(input.baseDir), "ember-isolation-state-"));
      await fs.chmod(scratch, 0o700);
      const rootfs = path.join(scratch, "rootfs"), state = path.join(scratch, "state");
      await fs.mkdir(rootfs, { mode: 0o700 }); await fs.mkdir(state, { mode: 0o700 });
      const filter = path.join(scratch, "experimental-seccomp.bpf");
      await fs.writeFile(filter, experimentalSeccomp(), { flag: "wx", mode: 0o600 });
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
      const args = ["--seccomp", "3", "--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--new-session", "--die-with-parent",
        ...(!modelUrl ? ["--unshare-net"] : []), "--clearenv", "--setenv", "HOME", "/state", "--setenv", "COPILOT_HOME", "/state",
        "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "NO_PROXY", "127.0.0.1", "--ro-bind", rootfs, "/",
        ...(input.privateProcForTest ? ["--proc", "/proc"] : []), "--dev", "/dev", "--tmpfs", "/tmp",
        "--bind", snapshot.directory, "/work", "--bind", state, "/state", "--chdir", "/work", "--", "/runtime/copilot-runtime"];
      // Supplying a connection environment prevents the SDK from inheriting process.env, and bwrap clears it again.
      // The SDK exposes only standard streams, so a fixed trusted shell opens the BPF file as fd 3 before exec.
      // All variable arguments are separate argv elements; none are interpolated into the shell program.
      client = new CopilotClient({ mode: "empty", baseDirectory: "/state", useLoggedInUser: false,
        connection: RuntimeConnection.forStdio({ path: "/usr/bin/bash", args: ["-c", 'exec 3<"$1"; shift; exec "$@"', "ember-isolation", filter, BWRAP, ...args],
          env: { HOME: "/state", PATH: "/usr/bin:/bin" } }) });
      await client.start();
      return new ExperimentalIsolatedRuntime(client, snapshot, scratch, modelUrl);
    } catch (error) {
      // Never remove files while a failed-to-stop runtime could still be using them.
      const errors = client ? await client.stop().catch(() => [new Error("stop failed")]) : [];
      if (!errors.length) { if (scratch) await fs.rm(scratch, { recursive: true, force: true }); await snapshot.dispose(); }
      throw error;
    }
  }

  /** Only a local mock and the fixed fake provider key are supported. */
  async request(prompt: string): Promise<void> {
    if (this.closing || this.busy) throw new Error("The isolation experiment is busy or closed.");
    if (!this.modelUrl) throw new Error("The isolation experiment has no model network.");
    this.busy = true;
    try {
      if (!this.session) {
        const session = await this.client.createSession({ model: "mock-model", provider: { type: "openai", baseUrl: this.modelUrl, apiKey: "test" },
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

  async close(): Promise<void> {
    if (!this.closing) this.closing = (async () => {
      let disconnectError: unknown;
      try { await this.session?.disconnect(); } catch (error) { disconnectError = error; }
      const errors = await this.client.stop();
      if (errors.length) throw new Error("The experimental runtime could not be stopped safely.");
      await fs.rm(this.scratch, { recursive: true, force: true });
      await this.snapshot.dispose();
      if (disconnectError) throw disconnectError;
    })();
    return this.closing;
  }
}
