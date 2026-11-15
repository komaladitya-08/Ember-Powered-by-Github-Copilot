/** Owns a separate, tokenless SDK runtime for one coding task. */
import fs from "node:fs/promises";
import path from "node:path";
import { CopilotClient, type CopilotClientOptions } from "@github/copilot-sdk";
import { runtimeClientOptions } from "./runtime-env";

export interface CodingRuntimeInput {
  userData: string;
  runtimePath: string;
  env: NodeJS.ProcessEnv;
}

/** No client-level GitHub token: SDK 1.0.21 otherwise exports it to the runtime's children. */
export function codingRuntimeOptions(input: CodingRuntimeInput, baseDirectory: string): CopilotClientOptions {
  return { ...runtimeClientOptions({ ...input, token: null, provider: true }), baseDirectory };
}

type ClientFactory = (options: CopilotClientOptions) => CopilotClient;

// A previous Ember process may have crashed while its runtime or a tool was still using its directory. A PID file
// cannot prove all descendants exited. Never delete or reuse unknown entries; refuse new coding until they are handled.
const active = new Map<string, { dev: number; ino: number }>();
const uncertain = new Set<string>();
const allocators = new Map<string, Promise<void>>();

async function allocate(input: CodingRuntimeInput): Promise<string> {
  const userData = await fs.realpath(input.userData);
  const parent = path.join(userData, "coding-runtimes");
  const prior = allocators.get(parent) ?? Promise.resolve();
  let unlock!: () => void;
  const next = new Promise<void>(resolve => { unlock = resolve; });
  allocators.set(parent, next);
  await prior;
  try {
    await fs.mkdir(parent, { recursive: true, mode: 0o700 });
    const stat = await fs.lstat(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The coding runtime folder is unavailable.");
    const entries = await fs.readdir(parent);
    const paths = entries.map(name => path.join(parent, name));
    const unverified = () => new Error("A previous coding runtime could not be verified as stopped. Coding is unavailable.");
    if ([...uncertain].some(dir => path.dirname(dir) === parent) || paths.some(dir => !active.has(dir)) ||
        [...active.keys()].some(dir => path.dirname(dir) === parent && !paths.includes(dir))) throw unverified();
    for (const dir of paths) {
      const live = await fs.lstat(dir);
      const expected = active.get(dir);
      if (!live.isDirectory() || live.isSymbolicLink() || !expected || live.dev !== expected.dev || live.ino !== expected.ino) throw unverified();
    }
    const dir = await fs.mkdtemp(path.join(parent, "task-"));
    const created = await fs.lstat(dir);
    active.set(dir, { dev: created.dev, ino: created.ino });
    return dir;
  } finally {
    unlock();
    if (allocators.get(parent) === next) allocators.delete(parent);
  }
}

/** The runtime or its private state could not be fully retired. */
export class CodingRuntimeCleanupError extends Error {
  constructor() { super("The coding runtime could not be stopped and cleaned up safely."); }
}

/**
 * A runtime belongs to exactly one coding task. The caller passes GitHub credentials only in the session config,
 * never in these client options. On abort during startup, cleanup waits for startup to finish before stopping the
 * process; a blocked startup must not be reported as safely disposed to the vault-fill barrier.
 */
export class CodingRuntime {
  private closing: Promise<void> | null = null;
  private constructor(readonly client: CopilotClient, private readonly dir: string) {}

  static async start(input: CodingRuntimeInput, signal?: AbortSignal, factory: ClientFactory = options => new CopilotClient(options)): Promise<CodingRuntime> {
    signal?.throwIfAborted();
    const dir = await allocate(input);
    let owner: CodingRuntime | undefined;
    try {
      await fs.chmod(dir, 0o700);
      signal?.throwIfAborted();
      owner = new CodingRuntime(factory(codingRuntimeOptions(input, dir)), dir);
      await owner.client.start();
      signal?.throwIfAborted();
      return owner;
    } catch (err) {
      try {
        if (owner) await owner.close();
        else { await fs.rm(dir, { recursive: true, force: true }); active.delete(dir); }
      } catch { throw new CodingRuntimeCleanupError(); }
      throw err;
    }
  }

  close(): Promise<void> {
    if (!this.closing) {
      // While stop is in flight its process is not yet known to be gone; block new allocations in this root.
      uncertain.add(this.dir);
      this.closing = (async () => {
        try {
          const errors = await this.client.stop();
          if (errors.length) throw new Error("The coding runtime could not be stopped safely.");
          const expected = active.get(this.dir);
          const live = await fs.lstat(this.dir).catch(err => {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
            throw err;
          });
          if (!expected || (live && (!live.isDirectory() || live.isSymbolicLink() || live.dev !== expected.dev || live.ino !== expected.ino))) {
            throw new Error("The coding runtime directory changed before cleanup.");
          }
          await fs.rm(this.dir, { recursive: true, force: true });
          active.delete(this.dir);
          uncertain.delete(this.dir);
        } catch (err) { uncertain.add(this.dir); throw err; }
      })();
    }
    return this.closing;
  }
}
