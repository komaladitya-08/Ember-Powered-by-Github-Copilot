/** Host-owned continuation bytes become fresh private Windows inodes, never a source grant or command capability. */
import { createHash } from "node:crypto";
import type { CodingExportBinding, CodingExportTree } from "./coding-result-export";
import { createCodingReviewExport } from "./coding-result-export";
import { prepareCodingContinuation, wipeCodingTree, type CodingWorkspaceContinuation } from "./coding-seed-snapshot";
import { codingProjectManifest, type CodingExcludedRoot, type CodingProjectManifest } from "./coding-project-scope";
import { CodingPrivacyScanner, CodingPrivacyCleanupError, assertCodingPrivacyScope, type CodingPrivacyScope } from "./coding-privacy-scanner";
import { codingWorkspaceFilePathProblem, codingWorkspaceFileProblemAsync } from "./scoped-coding-files";
import { ScopedCodingFileError, type ScopedCodingFileLimits } from "./coding-platform";
import { retireWindowsCodingNative, WindowsCodingCleanupError, type WindowsCodingNative, type WindowsCodingHandle, type WindowsCodingInfo } from "./windows-coding-native";
import { windowsCodingRelative, windowsCodingFold, windowsCodingSame, windowsCodingExcludedRoot, windowsCodingSafeError, windowsCodingYield } from "./windows-coding-policy";

declare const seedBrand: unique symbol;
export interface WindowsCodingContinuationSeed {
  readonly [seedBrand]: true;
  /** Revokes unfinished materialisation and erases only the helper's copied buffers. Idempotent after transfer. */
  dispose(): void;
}
export class WindowsCodingContinuationCleanupError extends WindowsCodingCleanupError {
  constructor() { super(); this.name = "WindowsCodingContinuationCleanupError"; }
}
interface Seed {
  baseline?: CodingExportTree; proposed?: CodingExportTree; scope?: CodingProjectManifest;
  privacy: CodingPrivacyScope; signal?: AbortSignal; current?: () => boolean; check?: () => void;
  disposed: boolean; busy: boolean;
}
interface Owned {
  handle: WindowsCodingHandle; parent: WindowsCodingHandle; name: string; kind: "directory" | "file";
  info?: WindowsCodingInfo; closed: boolean; attempted: boolean;
}
const seeds = new WeakMap<WindowsCodingContinuationSeed, Seed>();
/** Failed native ownership remains retained even if callers release their seed objects. */
const retained: unknown[] = [];
const MAX_BYTES = 10 * 1024 * 1024, MAX_FILE = 4 * 1024 * 1024;
const SPECIAL = 0x5640 | 0x40000 | 0x400000;
const refused = () => new ScopedCodingFileError("unsupported");
const cancelled = () => new ScopedCodingFileError("cancelled");
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function erase(seed: Seed): void {
  seed.disposed = true;
  wipeCodingTree(seed.baseline); wipeCodingTree(seed.proposed);
  seed.baseline = undefined; seed.proposed = undefined; seed.scope = undefined;
  seed.current = undefined; seed.check = undefined; seed.signal = undefined;
}
function admitted(seed: Seed, check?: () => void): void {
  if (seed.disposed) throw cancelled();
  assertCodingPrivacyScope(seed.privacy); seed.signal?.throwIfAborted();
  if (!seed.current || seed.current() !== true) throw cancelled();
  seed.check?.(); check?.();
  // Authority callbacks can synchronously revoke this same seed.
  if (seed.disposed) throw cancelled();
  assertCodingPrivacyScope(seed.privacy); seed.signal?.throwIfAborted();
  if (!seed.current || seed.current() !== true) throw cancelled();
}

/** Clone and rebind both complete trees synchronously, before any native or asynchronous admission. */
export function prepareWindowsCodingContinuation(input: CodingWorkspaceContinuation, binding: CodingExportBinding,
  excludedRoots: readonly CodingExcludedRoot[], privacyScope: CodingPrivacyScope, signal: AbortSignal | undefined,
  check: () => void, limits?: Readonly<ScopedCodingFileLimits>): WindowsCodingContinuationSeed {
  let owned: ReturnType<typeof prepareCodingContinuation> | undefined;
  try {
    if (!input || typeof input.current !== "function" || typeof check !== "function" || !Array.isArray(excludedRoots) ||
        excludedRoots.length > 2 || new Set(excludedRoots).size !== excludedRoots.length || excludedRoots.some(root => root !== ".git" && root !== "node_modules")) throw refused();
    const fresh = { ...binding }, excluded = [...excludedRoots];
    createCodingReviewExport({ binding: fresh, baseline: { binding: fresh, entries: [] }, proposed: { binding: fresh, entries: [] } });
    const scope = input.scope === undefined ? undefined : codingProjectManifest(input.scope);
    if (scope && scope.dependencies !== null) throw refused();
    // bind retains the predecessor only during intake; erase/transfer drops this callback permanently.
    const current = input.current.bind(input);
    owned = prepareCodingContinuation({ baseline: input.baseline, proposed: input.proposed, ...(scope ? { scope } : {}), current }, fresh, excluded, signal);
    const caps = { entries: 10_000, depth: 64, fileBytes: MAX_FILE, workspaceBytes: MAX_BYTES };
    const bounds = { ...caps };
    for (const key of Object.keys(caps) as (keyof typeof caps)[]) {
      const value = limits?.[key] ?? caps[key];
      if (!Number.isSafeInteger(value) || value < 1) throw refused();
      bounds[key] = Math.min(value, caps[key]);
    }
    for (const tree of [owned.baseline, owned.proposed]) {
      if (tree.entries.length > bounds.entries) throw new ScopedCodingFileError("limit");
      let bytes = 0;
      const aliases = new Set<string>();
      for (const entry of tree.entries) {
        if (windowsCodingRelative(entry.path, false) !== entry.path || entry.path.split("/").length > bounds.depth ||
            windowsCodingExcludedRoot(entry.path, excluded) || aliases.has(windowsCodingFold(entry.path))) throw refused();
        aliases.add(windowsCodingFold(entry.path));
        if (codingWorkspaceFilePathProblem(entry.path)) throw new ScopedCodingFileError("secret");
        if (entry.kind === "file" && (entry.executable || entry.bytes.length > bounds.fileBytes || (bytes += entry.bytes.length) > bounds.workspaceBytes)) throw refused();
      }
    }
    const state: Seed = { ...owned, ...(scope ? { scope } : {}), privacy: privacyScope, signal, current, check, disposed: false, busy: false };
    admitted(state);
    const seed = Object.freeze({ dispose() { erase(state); } }) as WindowsCodingContinuationSeed;
    seeds.set(seed, state); return seed;
  } catch (error) {
    wipeCodingTree(owned?.baseline); wipeCodingTree(owned?.proposed);
    throw windowsCodingSafeError(error);
  }
}

/** Writes only into the caller's fresh empty COPY root; that borrowed root remains owned by the caller. */
export async function materializeWindowsCodingContinuation(seed: WindowsCodingContinuationSeed, api: WindowsCodingNative,
  root: WindowsCodingHandle, check: () => void): Promise<{ baseline: CodingExportTree; scope?: CodingProjectManifest }> {
  const state = seeds.get(seed);
  if (!state || state.disposed || state.busy || typeof check !== "function") throw cancelled();
  state.busy = true;
  const owned: Owned[] = [], directories = new Map<string, WindowsCodingHandle>([["", root]]), identities = new Map<WindowsCodingHandle, WindowsCodingInfo>();
  const tokens = new Set([root]), childrenByParent = new Map<WindowsCodingHandle, Map<string, Owned>>();
  const ids = new Set<string>();
  let scanner: CodingPrivacyScanner | undefined, rootInfo: WindowsCodingInfo | undefined;
  let closingStarted = false, uncertain = false;
  const poison = () => {
    retireWindowsCodingNative();
    return new WindowsCodingContinuationCleanupError();
  };
  const valid = (info: WindowsCodingInfo, kind: "directory" | "file") => info.kind === kind &&
    typeof info.id === "string" && !!info.id && typeof info.volume === "string" && !!info.volume && typeof info.finalPath === "string" && !!info.finalPath &&
    Number.isSafeInteger(info.attributes) &&
    (info.attributes & SPECIAL) === 0 && Number.isSafeInteger(info.size) && info.size >= 0 &&
    (kind !== "file" || info.links === 1);
  const identity = (handle: WindowsCodingHandle): WindowsCodingInfo => {
    const expected = identities.get(handle), info = api.info(handle); api.assertPrivate(handle);
    if (!expected || !windowsCodingSame(expected, info, false) || !valid(info, expected.kind)) throw new ScopedCodingFileError("boundary");
    return info;
  };
  const nativeCurrent = () => { if (!rootInfo || !windowsCodingSame(rootInfo, identity(root), false)) throw new ScopedCodingFileError("boundary"); };
  const guard = () => { admitted(state, check); nativeCurrent(); };
  const attest = (entry: Owned): WindowsCodingInfo => {
    nativeCurrent(); const parent = identity(entry.parent), info = api.info(entry.handle); api.assertPrivate(entry.handle);
    const expectedPath = `${parent.finalPath.replace(/\\+$/, "")}\\${entry.name}`;
    if (!rootInfo || !valid(info, entry.kind) || info.volume !== rootInfo.volume || windowsCodingFold(info.finalPath) !== windowsCodingFold(expectedPath) ||
        entry.info && !windowsCodingSame(entry.info, info, false)) throw new ScopedCodingFileError("boundary");
    if (!entry.info) {
      const id = `${info.volume}:${info.id}`;
      if (ids.has(id)) throw new ScopedCodingFileError("boundary");
      ids.add(id); entry.info = info; identities.set(entry.handle, info);
    }
    return info;
  };
  const closeOne = (entry: Owned) => {
    if (entry.attempted) return;
    entry.attempted = true;
    try { api.close(entry.handle); entry.closed = true; }
    catch { uncertain = true; throw poison(); }
  };
  const closeAll = () => {
    let failed = false; closingStarted = true;
    for (const entry of owned.slice().reverse()) try { closeOne(entry); } catch { failed = true; }
    if (failed) { uncertain = true; throw poison(); }
  };
  const rollback = () => {
    let failed = false;
    // A closed/uncertain native token cannot be re-opened by name as proof of authority.
    if (closingStarted) { uncertain = true; throw poison(); }
    for (const entry of owned.slice().reverse()) {
      if (failed) continue;
      try {
        attest(entry);
        if (entry.kind === "directory" && api.list(entry.handle, 1).length) throw new ScopedCodingFileError("boundary");
        api.remove(entry.handle);
        // NT delete disposition completes only when this last owned child handle closes. Keep its parent live.
        closeOne(entry);
      } catch { failed = true; }
    }
    if (!failed) try { nativeCurrent(); if (api.list(root, 1).length) failed = true; } catch { failed = true; }
    try { closeAll(); } catch { failed = true; }
    if (failed) { uncertain = true; throw poison(); }
  };
  try {
    admitted(state, check);
    scanner = new CodingPrivacyScanner({ signal: state.signal, scope: state.privacy });
    for (const tree of [state.baseline!, state.proposed!]) for (const entry of tree.entries) {
      admitted(state, check);
      if (codingWorkspaceFilePathProblem(entry.path)) throw new ScopedCodingFileError("secret");
      if (entry.kind === "file" && await codingWorkspaceFileProblemAsync(entry.path, entry.bytes, scanner, {
        signal: state.signal, current: () => { admitted(state, check); return true; },
      })) throw new ScopedCodingFileError("secret");
      admitted(state, check);
    }
    // No native child exists until the full baseline/proposed scan and scanner shutdown have succeeded.
    const closingScanner = scanner; scanner = undefined;
    await closingScanner.close(); admitted(state, check);
    rootInfo = api.info(root); api.assertPrivate(root);
    if (!valid(rootInfo, "directory") || api.list(root, 1).length) throw new ScopedCodingFileError("boundary");
    identities.set(root, rootInfo); ids.add(`${rootInfo.volume}:${rootInfo.id}`);
    guard();
    for (const entry of state.proposed!.entries) {
      guard();
      const parts = entry.path.split("/"), name = parts.pop()!, parent = directories.get(parts.join("/"));
      if (parent === undefined) throw refused();
      identity(parent);
      const handle = api.create(parent, name, entry.kind);
      if (typeof handle !== "bigint" || handle <= 0n || tokens.has(handle)) { uncertain = true; throw poison(); }
      const created: Owned = { handle, parent, name, kind: entry.kind, closed: false, attempted: false }; owned.push(created);
      tokens.add(handle);
      const children = childrenByParent.get(parent) ?? new Map<string, Owned>(); children.set(name, created); childrenByParent.set(parent, children);
      const before = attest(created); guard();
      if (entry.kind === "directory") {
        if (api.list(handle, 1).length) throw new ScopedCodingFileError("boundary");
        directories.set(entry.path, handle);
      } else {
        if (before.size !== 0) throw new ScopedCodingFileError("boundary");
        api.write(handle, entry.bytes); guard(); api.flush(handle); guard();
        const written = attest(created);
        if (written.size !== entry.bytes.length) throw new ScopedCodingFileError("conflict");
        const digest = createHash("sha256"); let offset = 0;
        while (offset < written.size) {
          guard(); const chunk = api.read(handle, offset, Math.min(64 * 1024, written.size - offset));
          try {
            if (!chunk.length || chunk.length > written.size - offset) throw new ScopedCodingFileError("conflict");
            digest.update(chunk); offset += chunk.length;
          } finally { chunk.fill(0); }
          await windowsCodingYield(); guard();
        }
        const eof = api.read(handle, written.size, 1);
        try {
          if (eof.length || !windowsCodingSame(written, attest(created)) || digest.digest("hex") !== hash(entry.bytes)) throw new ScopedCodingFileError("conflict");
        } finally { eof.fill(0); }
      }
      await windowsCodingYield(); guard();
    }
    guard(); for (const entry of owned) attest(entry);
    // A fresh seed cannot silently admit an unscanned addition, even inside an otherwise private directory.
    for (const parent of directories.values()) {
      guard(); identity(parent);
      const expected = childrenByParent.get(parent), children = api.list(parent, 10_000);
      if (children.length !== (expected?.size ?? 0) || children.some(child => {
        const entry = expected?.get(child.name);
        return !entry || child.id !== entry.info?.id || !!(child.attributes & 0x10) !== (entry.kind === "directory");
      }))
        throw new ScopedCodingFileError("boundary");
    }
    closeAll();
    const baseline = state.baseline!, scope = state.scope;
    state.baseline = undefined; erase(state); seeds.delete(seed);
    return { baseline, ...(scope ? { scope } : {}) };
  } catch (error) {
    let failure: unknown = error;
    if (scanner) try { await scanner.close(); } catch (cleanup) { failure = cleanup instanceof CodingPrivacyCleanupError ? cleanup : new CodingPrivacyCleanupError(); }
    if (owned.length) try { rollback(); } catch (cleanup) { failure = cleanup; }
    if (uncertain || error instanceof WindowsCodingCleanupError) {
      retained.push({ api, root, rootInfo, owned, identities }); failure = poison();
    }
    throw failure instanceof CodingPrivacyCleanupError || failure instanceof WindowsCodingCleanupError ? failure : windowsCodingSafeError(failure);
  } finally { erase(state); seeds.delete(seed); }
}
