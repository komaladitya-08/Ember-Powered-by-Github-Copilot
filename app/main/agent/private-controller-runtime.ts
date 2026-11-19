/** Trusted SDK control plane only. Untrusted project commands must run through a separate isolated runner. */
import fs from "node:fs/promises";
import path from "node:path";
import { CopilotClient, type CopilotClientOptions } from "@github/copilot-sdk";
import { runtimeClientOptions } from "./runtime-env";
import { redactingClient, type ModelRedactor } from "./redacting-client";
import { HOST_PLATFORM } from "../platform/os";
import { allocateWindowsControllerStorage, WindowsControllerStorageCleanupError } from "./windows-controller-storage";
import { WindowsControllerNativeCleanupError } from "./windows-controller-native";
import { WindowsCodingCleanupError } from "./windows-coding-native";
import type { PrivateControllerPaths, PrivateControllerStorage } from "./private-controller-storage";

export interface PrivateControllerRuntimeInput {
  userData: string;
  runtimePath: string;
  env: NodeJS.ProcessEnv;
  /** Normal host-side GitHub authentication. This runtime is trusted and has no native coding tools. */
  gitHubToken?: string;
  /** Host vault redactor, applied to every session prompt, tool/hook result and system message. */
  redact?: ModelRedactor;
}
/** SDK or storage disposal could not be verified. Retain the owner and never attest that its worker is safely closed. */
export class PrivateControllerCleanupError extends Error {
  readonly code = "private-controller-cleanup-unverified";
  constructor(reason: "cleanup" | "previous" = "cleanup") {
    super(reason === "previous" ? "A previous coding controller has not been verified as stopped." : "The private coding controller could not be stopped or cleaned up safely.");
    this.name = "PrivateControllerCleanupError";
  }
}
const inherited = ["PATH", "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "LANG", "LC_ALL", "LC_CTYPE",
  "HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS"];

/** No ambient loader/debug/config/plugin variables; process cwd and session cwd are both private. */
export function privateControllerClientOptions(input: PrivateControllerRuntimeInput, paths: PrivateControllerPaths): CopilotClientOptions {
  const env: NodeJS.ProcessEnv = {};
  for (const key of inherited) if (input.env[key] !== undefined) env[key] = input.env[key];
  Object.assign(env, { HOME: paths.home, USERPROFILE: paths.home, APPDATA: paths.home, LOCALAPPDATA: paths.home,
    XDG_CONFIG_HOME: paths.home, XDG_DATA_HOME: paths.home, XDG_CACHE_HOME: paths.temporary,
    TMPDIR: paths.temporary, TMP: paths.temporary, TEMP: paths.temporary,
    NO_PROXY: [env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(","),
    no_proxy: [env.no_proxy, "127.0.0.1", "localhost"].filter(Boolean).join(",") });
  return { ...runtimeClientOptions({ userData: paths.root, runtimePath: input.runtimePath,
    token: input.gitHubToken ?? null, provider: false, env }), baseDirectory: paths.state, workingDirectory: paths.cwd };
}

const active = new Map<string, { dev: number; ino: number }>();
const uncertain = new Set<string>();
const allocating = new Map<string, Promise<void>>();
type Factory = (options: CopilotClientOptions) => CopilotClient;

/** Dedicated runtime; no conductor extension registrations or worker conversations can share its configuration. */
export class PrivateControllerRuntime {
  private closing: Promise<void> | null = null;
  private constructor(readonly client: CopilotClient, private readonly paths: PrivateControllerPaths, private readonly storage?: PrivateControllerStorage) {}
  get workingDirectory(): string { return this.paths.cwd; }

  static async start(input: PrivateControllerRuntimeInput, signal?: AbortSignal, factory: Factory = options => new CopilotClient(options)): Promise<PrivateControllerRuntime> {
    input = { ...input, env: { ...input.env } };
    signal?.throwIfAborted();
    if (!path.isAbsolute(input.userData) || !path.isAbsolute(input.runtimePath)) throw new Error("Private coding controller paths must be absolute.");
    if (HOST_PLATFORM === "win32") return this.startWindows(input, signal, factory);
    const userData = await fs.realpath(input.userData), parent = path.join(userData, "coding-controllers");
    const previous = allocating.get(parent) ?? Promise.resolve();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    allocating.set(parent, waiting);
    await previous;
    let paths: PrivateControllerPaths;
    try {
      signal?.throwIfAborted();
      await fs.mkdir(parent, { recursive: true, mode: 0o700 });
      const stat = await fs.lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("The private coding controller folder is unavailable.");
      const entries = (await fs.readdir(parent)).map(name => path.join(parent, name));
      if ([...uncertain].some(dir => path.dirname(dir) === parent) || entries.some(dir => !active.has(dir)) ||
          [...active.keys()].some(dir => path.dirname(dir) === parent && !entries.includes(dir))) {
        throw new Error("A previous coding controller has not been verified as stopped.");
      }
      for (const directory of entries) {
        const live = await fs.lstat(directory), expected = active.get(directory)!;
        if (!live.isDirectory() || live.isSymbolicLink() || live.dev !== expected.dev || live.ino !== expected.ino) throw new Error("The private coding controller folder changed.");
      }
      const root = await fs.mkdtemp(path.join(parent, "controller-"));
      const identity = await fs.lstat(root);
      active.set(root, { dev: identity.dev, ino: identity.ino });
      paths = { root, cwd: path.join(root, "cwd"), home: path.join(root, "home"), state: path.join(root, "state"), temporary: path.join(root, "tmp") };
    } finally {
      release();
      if (allocating.get(parent) === waiting) allocating.delete(parent);
    }
    let owner: PrivateControllerRuntime | undefined;
    try {
      for (const directory of [paths.cwd, paths.home, paths.state, paths.temporary]) await fs.mkdir(directory, { mode: 0o700 });
      signal?.throwIfAborted();
      const client = factory(privateControllerClientOptions(input, paths));
      owner = new PrivateControllerRuntime(input.redact ? redactingClient(client, input.redact) : client, paths);
      await owner.client.start();
      signal?.throwIfAborted();
      return owner;
    } catch (error) {
      if (owner) await owner.close();
      else { await fs.rm(paths.root, { recursive: true, force: true }); active.delete(paths.root); }
      throw error;
    }
  }

  private static async startWindows(input: PrivateControllerRuntimeInput, signal: AbortSignal | undefined, factory: Factory): Promise<PrivateControllerRuntime> {
    let storage: PrivateControllerStorage;
    try { storage = await allocateWindowsControllerStorage(await fs.realpath(input.userData), signal); }
    catch (error) {
      if (error instanceof WindowsControllerStorageCleanupError) throw new PrivateControllerCleanupError("previous");
      if (error instanceof WindowsControllerNativeCleanupError || error instanceof WindowsCodingCleanupError) throw new PrivateControllerCleanupError();
      throw error;
    }
    let owner: PrivateControllerRuntime | undefined;
    try {
      signal?.throwIfAborted(); await storage.verify();
      const client = factory(privateControllerClientOptions(input, storage.paths));
      owner = new PrivateControllerRuntime(input.redact ? redactingClient(client, input.redact) : client, storage.paths, storage);
      await owner.client.start(); await storage.verify(); signal?.throwIfAborted(); return owner;
    } catch (error) {
      try { if (owner) await owner.close(); else await storage.close(); }
      catch { throw new PrivateControllerCleanupError(); }
      throw error;
    }
  }

  close(): Promise<void> {
    if (!this.closing) {
      if (this.storage) {
        this.storage.retire();
        this.closing = Promise.resolve().then(async () => {
          try {
            const errors = await this.client.stop();
            if (errors.length) throw new PrivateControllerCleanupError();
            await this.storage!.close();
          } catch { throw new PrivateControllerCleanupError(); }
        });
        return this.closing;
      }
      uncertain.add(this.paths.root);
      this.closing = Promise.resolve().then(async () => {
        try {
          const errors = await this.client.stop();
          if (errors.length) throw new PrivateControllerCleanupError();
          const expected = active.get(this.paths.root), live = await fs.lstat(this.paths.root);
          if (!expected || !live.isDirectory() || live.isSymbolicLink() || live.dev !== expected.dev || live.ino !== expected.ino) throw new PrivateControllerCleanupError();
          await fs.rm(this.paths.root, { recursive: true, force: true });
          active.delete(this.paths.root); uncertain.delete(this.paths.root);
        } catch { throw new PrivateControllerCleanupError(); }
      });
    }
    return this.closing;
  }
}
