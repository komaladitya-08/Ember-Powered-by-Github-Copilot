/** Fixed guest cache transaction. Its engine file lease remains held across host approval/fetch/transfer. */
import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { PublicNpmPlan, publicNpmPlanData, PUBLIC_NPM_LIMITS, PublicNpmPreparationError } from "./public-npm-lock";
import { parseBoundedCodingJson } from "./coding-bounded-json";
import { WslPublicDependencyRuntime, WslPublicDependencyCleanupError } from "./wsl-public-dependency-runtime";
import type { IsolatedCommandWorkspace } from "./isolated-command-workspace";

const bad = () => new PublicNpmPreparationError();
type Transaction = { id: string; abort: AbortController; release(): void; done: Promise<void>; committing: boolean;
  plan?: PublicNpmPlan; chunks: Buffer[][]; lengths: number[]; total: number; commit: boolean };
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const retainedHandles = new Set<fs.FileHandle>();
async function closeOwned(handles: fs.FileHandle[]): Promise<void> {
  const results = await Promise.allSettled(handles.reverse().map(async handle => { try { await handle.close(); } catch { retainedHandles.add(handle); throw new WslPublicDependencyCleanupError(); } }));
  if (results.some(result => result.status === "rejected")) throw new WslPublicDependencyCleanupError();
}
async function read(root: string, relative: string, maximum: number, check: () => void): Promise<Buffer> {
  const handles: fs.FileHandle[] = []; let base = root;
  try {
    for (const component of relative.split("/").slice(0, -1)) {
      check(); const handle = await fs.open(path.join(base, component), DIRECTORY); handles.push(handle); base = `/proc/self/fd/${handle.fd}`;
    }
    check(); const handle = await fs.open(path.join(base, path.posix.basename(relative)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); handles.push(handle);
    const before = await handle.stat({ bigint: true }); check();
    if (!before.isFile() || before.nlink !== 1n || before.size < 2 || before.size > BigInt(maximum)) throw bad();
    const body = await handle.readFile(); check(); const after = await handle.stat({ bigint: true });
    if (body.length !== Number(before.size) || before.dev !== after.dev || before.ino !== after.ino || before.mode !== after.mode || before.nlink !== after.nlink ||
      before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) { body.fill(0); throw bad(); }
    return body;
  } finally { await closeOwned(handles); }
}
export class WslPublicDependencyGuest {
  #active?: Transaction; #owned = new Set<Promise<void>>(); #failure?: WslPublicDependencyCleanupError;
  constructor(readonly runtime: WslPublicDependencyRuntime, readonly workspace: Pick<IsolatedCommandWorkspace, "files">, readonly signal: AbortSignal) {}
  async begin(): Promise<{ lease: string; packageJson: string; packageLock: string }> {
    if (this.#active || this.signal.aborted || this.#failure) throw this.#failure ?? bad();
    let release!: () => void, ready!: (value: { lease: string; packageJson: string; packageLock: string }) => void, reject!: (reason: unknown) => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const response = new Promise<{ lease: string; packageJson: string; packageLock: string }>((resolve, no) => { ready = resolve; reject = no; });
    const tx: Transaction = { id: randomBytes(16).toString("hex"), abort: new AbortController(), release, done: Promise.resolve(), committing: false, chunks: [], lengths: [], total: 0, commit: false };
    this.#active = tx;
    const check = () => { this.signal.throwIfAborted(); tx.abort.signal.throwIfAborted(); if (this.#failure) throw this.#failure; };
    const abort = () => { tx.abort.abort(); tx.release(); }; this.signal.addEventListener("abort", abort, { once: true });
    tx.done = this.workspace.files(async root => {
      let pkg: Buffer | undefined, lock: Buffer | undefined;
      try {
        check(); await this.runtime.current(); check();
        pkg = await read(root, "package.json", PUBLIC_NPM_LIMITS.packageJsonBytes, check);
        lock = await read(root, "package-lock.json", PUBLIC_NPM_LIMITS.lockBytes, check);
        tx.plan = PublicNpmPlan.create({ packageJson: pkg, packageLock: lock });
        for (const workspace of publicNpmPlanData(tx.plan).workspaces) {
          const body = await read(root, workspace.path + "/package.json", PUBLIC_NPM_LIMITS.packageJsonBytes, check);
          try {
            const text = body.toString("utf8"); if (!Buffer.from(text).equals(body)) throw bad();
            const value = parseBoundedCodingJson(text, { depth: 64, containers: 128_000, keyBytes: 4096 });
            if (!value || typeof value !== "object" || Array.isArray(value) || (value as Record<string, unknown>).name !== workspace.name || (value as Record<string, unknown>).version !== workspace.version) throw bad();
          } finally { body.fill(0); }
        }
        check(); ready({ lease: tx.id, packageJson: pkg.toString("base64"), packageLock: lock.toString("base64") });
        await gate; check(); if (!tx.commit) return;
        const archives = tx.chunks.map(parts => Buffer.concat(parts));
        try { await this.runtime.importCache(tx.plan, archives, tx.abort.signal, check); check(); }
        finally { archives.forEach(body => body.fill(0)); }
      } finally { pkg?.fill(0); lock?.fill(0); }
    }).catch(error => { if (error instanceof WslPublicDependencyCleanupError) this.#failure ??= error; reject(error); throw error; }).finally(() => {
      this.signal.removeEventListener("abort", abort); tx.chunks.flat().forEach(body => body.fill(0)); tx.chunks = [];
      if (this.#active === tx) this.#active = undefined;
    });
    this.#owned.add(tx.done); void tx.done.finally(() => this.#owned.delete(tx.done)).catch(() => undefined);
    return response;
  }
  chunk(lease: string, index: number, offset: number, encoded: string): void {
    const tx = this.#active;
    if (!tx || tx.id !== lease || tx.committing || !tx.plan || this.signal.aborted || tx.abort.signal.aborted || this.#failure) throw this.#failure ?? bad();
    if (!Number.isInteger(index) || index < 0 || index >= publicNpmPlanData(tx.plan).packages.length || !Number.isInteger(offset) || offset !== (tx.lengths[index] ?? 0)) throw bad();
    const bytes = Buffer.from(encoded, "base64");
    if (!bytes.length || bytes.length > 1024 * 1024 || bytes.toString("base64") !== encoded || offset + bytes.length > PUBLIC_NPM_LIMITS.archiveBytes || tx.total + bytes.length > PUBLIC_NPM_LIMITS.compressedBytes) { bytes.fill(0); throw bad(); }
    (tx.chunks[index] ??= []).push(bytes); tx.lengths[index] = offset + bytes.length; tx.total += bytes.length;
  }
  async commit(lease: string): Promise<void> {
    const tx = this.#active;
    if (!tx || tx.id !== lease || tx.committing || !tx.plan || this.signal.aborted || tx.abort.signal.aborted || this.#failure) throw this.#failure ?? bad();
    const count = publicNpmPlanData(tx.plan).packages.length;
    if (tx.chunks.length !== count || Array.from({ length: count }, (_, i) => tx.lengths[i] ?? 0).some(n => n < 32)) throw bad();
    tx.committing = true; tx.commit = true; tx.release(); await tx.done;
  }
  async cancel(lease: string): Promise<void> {
    const tx = this.#active; if (!tx || tx.id !== lease) throw bad(); tx.abort.abort(); tx.release();
    try { await tx.done; } catch { if (this.#failure) throw this.#failure; }
  }
  abort(): void { this.#active?.abort.abort(); this.#active?.release(); }
  async drain(): Promise<void> { await Promise.allSettled([...this.#owned]); if (this.#failure) throw this.#failure; }
}
