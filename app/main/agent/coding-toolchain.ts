/** Discover a real host Node and prove its verified copies can run in an empty Linux command namespace. */
import fs from "node:fs/promises";
import { constants, type BigIntStats } from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { HOST_ARCH, HOST_PLATFORM } from "../platform/os";
import { copyIsolatedCommandAssets, inspectIsolatedCommandElf } from "./isolated-command-assets";

export interface CodingToolchainInput {
  env: NodeJS.ProcessEnv;
  execPath: string;
  isElectron: boolean;
  protectedPaths: readonly string[];
  signal?: AbortSignal;
}
export interface CodingToolchain {
  nodePath: string | null;
  /** The actual Node --version line, e.g. v24.11.0. */
  version: string | null;
  available: boolean;
  message: string;
}
const PREFIXES = ["/usr", "/bin", "/opt/hostedtoolcache", "/opt/node", "/opt/codex/runtimes"];
const FIXED = ["/usr/bin/node", "/usr/local/bin/node", "/opt/node/bin/node"];
const within = (file: string, root: string) => { const r = path.relative(root, file); return !r || (r !== ".." && !r.startsWith("../") && !path.isAbsolute(r)); };
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const unsafe = () => new Error("The coding toolchain cannot be verified.");
const unavailable = (message: string): CodingToolchain => ({ nodePath: null, version: null, available: false, message });

/** Only host-selected system prefixes are searched. No project-local PATH entry is considered. */
export function codingNodeCandidates(input: Pick<CodingToolchainInput, "env" | "execPath" | "isElectron">): string[] {
  const found = new Set<string>();
  const add = (file: string) => {
    if (!path.isAbsolute(file) || Buffer.byteLength(file) > 4096 || /[\p{Cc}\p{Cf}]/u.test(file)) return;
    const normal = path.normalize(file);
    if (!/^(node|nodejs)$/i.test(path.basename(normal)) || !PREFIXES.some(p => within(normal, p))) return;
    found.add(normal);
  };
  if (!input.isElectron) add(input.execPath);
  for (const file of FIXED) add(file);
  const search = input.env.PATH ?? "";
  if (search.length <= 32_768) for (const directory of search.split(":").slice(0, 128)) {
    if (!directory || !path.isAbsolute(directory) || /[\p{Cc}\p{Cf}]/u.test(directory)) continue;
    add(path.join(directory, "node"));
  }
  return [...found];
}

async function trustedPath(file: string): Promise<string> {
  // Verify root-owned aliases too, rather than resolving a user-controlled link and trusting only its destination.
  let part = path.parse(file).root, pending = file.slice(part.length).split(path.sep).filter(Boolean), links = 0;
  const root = await fs.lstat(part);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== 0 || (root.mode & 0o022) !== 0) throw unsafe();
  while (pending.length) {
    const name = pending.shift()!;
    const next = path.join(part, name);
    const stat = await fs.lstat(next);
    if (stat.uid !== 0 || (!stat.isSymbolicLink() && (stat.mode & 0o022) !== 0)) throw unsafe();
    if (stat.isSymbolicLink()) {
      if (++links > 32) throw unsafe();
      const target = path.resolve(path.dirname(next), await fs.readlink(next));
      pending = [...target.slice(path.parse(target).root.length).split(path.sep).filter(Boolean), ...pending];
      part = path.parse(target).root;
      continue;
    }
    if (pending.length && !stat.isDirectory()) throw unsafe();
    part = next;
  }
  const real = await fs.realpath(file);
  if (real !== part) throw unsafe();
  return real;
}

async function verifiedFile(file: string, protectedRoots: readonly string[], maximum: bigint): Promise<{ real: string; handle: fs.FileHandle; stat: BigIntStats }> {
  const real = await trustedPath(file);
  if (protectedRoots.some(p => within(real, p))) throw unsafe();
  const handle = await fs.open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat({ bigint: true });
    if (!stat.isFile() || stat.uid !== 0n || stat.nlink !== 1n || (stat.mode & 0o022n) !== 0n || (stat.mode & 0o111n) === 0n || stat.size < 64n || stat.size > maximum) throw unsafe();
    const actual = await fs.realpath(`/proc/self/fd/${handle.fd}`);
    if (actual !== real || protectedRoots.some(p => within(actual, p)) || !same(stat, await fs.lstat(real, { bigint: true }))) throw unsafe();
    return { real, handle, stat };
  } catch (error) { await handle.close(); throw error; }
}

async function unchanged(file: { real: string; handle: fs.FileHandle; stat: BigIntStats }): Promise<void> {
  if (!same(file.stat, await file.handle.stat({ bigint: true })) || !same(file.stat, await fs.lstat(file.real, { bigint: true }))) throw unsafe();
}

function probe(executable: string, args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    execFile(executable, args, {
      cwd: "/", env: { PATH: "/usr/bin:/bin", HOME: "/", LANG: "C", LC_ALL: "C" },
      // execFile bounds stdout and stderr separately: 2 KiB each keeps combined retained output within 4 KiB.
      encoding: "utf8", timeout: 3000, maxBuffer: 2048, killSignal: "SIGKILL", windowsHide: true,
      ...(signal ? { signal } : {}),
    }, (error, stdout) => { if (error) reject(unsafe()); else resolve(stdout); });
  });
}

/** No download, project execution, inherited NODE_OPTIONS, Electron-as-Node fallback or model argument is permitted. */
export async function discoverCodingToolchain(input: CodingToolchainInput): Promise<CodingToolchain> {
  if (HOST_PLATFORM !== "linux" || HOST_ARCH !== "x64") return unavailable("Isolated coding commands currently require Linux x64.");
  input.signal?.throwIfAborted();
  if (!input.protectedPaths.length || input.protectedPaths.some(p => !path.isAbsolute(p))) return unavailable("Ember couldn't verify its protected data paths for coding.");
  let roots: string[];
  try { roots = await Promise.all(input.protectedPaths.map(p => fs.realpath(p))); }
  catch { return unavailable("Ember couldn't verify its protected data paths for coding."); }
  let wrapper: Awaited<ReturnType<typeof verifiedFile>> | undefined;
  try {
    wrapper = await verifiedFile("/usr/bin/bwrap", roots, 4n * 1024n * 1024n);
    const image = Buffer.alloc(Number(wrapper.stat.size) + 1);
    const read = await wrapper.handle.read(image, 0, image.length, 0);
    if (read.bytesRead !== Number(wrapper.stat.size)) throw unsafe();
    await inspectIsolatedCommandElf(image.subarray(0, read.bytesRead));
    await unchanged(wrapper);
  } catch {
    await wrapper?.handle.close();
    input.signal?.throwIfAborted();
    return unavailable("A trusted Bubblewrap installation is required for isolated coding commands.");
  }
  if (!wrapper) return unavailable("A trusted Bubblewrap installation is required for isolated coding commands.");
  try {
    const seen = new Set<string>();
    for (const candidate of codingNodeCandidates(input)) {
      input.signal?.throwIfAborted();
      let node: Awaited<ReturnType<typeof verifiedFile>> | undefined, temporary: string | undefined;
      try {
        node = await verifiedFile(candidate, roots, 256n * 1024n * 1024n);
        if (seen.has(node.real)) continue;
        seen.add(node.real);
        if (!/^(node|nodejs)$/i.test(path.basename(node.real)) || !PREFIXES.some(p => within(node!.real, p))) throw unsafe();
        temporary = await fs.mkdtemp(path.join(os.tmpdir(), "ember-coding-toolchain-"));
        await fs.chmod(temporary, 0o700);
        const rootfs = path.join(temporary, "rootfs"); await fs.mkdir(rootfs, { mode: 0o700 });
        // This reuses the bounded ELF parser and validates every required tool/library without executing ldd.
        await copyIsolatedCommandAssets({ rootfs, protectedPaths: roots, nodePath: node.real, ...(input.signal ? { signal: input.signal } : {}) });
        await unchanged(node); await unchanged(wrapper);
        for (const name of ["dev", "tmp"]) await fs.mkdir(path.join(rootfs, name), { mode: 0o700 });
        const isolation = ["--unshare-user", "--unshare-pid", "--unshare-net", "--unshare-ipc", "--unshare-uts", "--new-session", "--die-with-parent",
          "--clearenv", "--setenv", "PATH", "/usr/bin:/bin", "--setenv", "HOME", "/", "--ro-bind", rootfs, "/", "--dev", "/dev", "--tmpfs", "/tmp", "--"];
        await probe(wrapper.real, [...isolation, "/usr/bin/bash", "--noprofile", "--norc", "-c", ":"], input.signal);
        const version = (await probe(wrapper.real, [...isolation, "/usr/bin/node", "--version"], input.signal)).trim();
        await unchanged(node); await unchanged(wrapper);
        const match = /^v(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(version);
        if (!match || Number(match[1]) < 22 || (Number(match[1]) === 22 && Number(match[2]) < 12)) continue;
        return { nodePath: node.real, version, available: true, message: `Node.js ${version} and isolated command namespaces are available.` };
      } catch {
        input.signal?.throwIfAborted();
      } finally {
        await node?.handle.close();
        if (temporary) await fs.rm(temporary, { recursive: true, force: true });
      }
    }
    return unavailable("Coding needs a trusted Node.js 22.12 or later and working isolated command namespaces. Install supported system tools and try again.");
  } finally { await wrapper.handle.close(); }
}
