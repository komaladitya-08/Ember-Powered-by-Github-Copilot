/** Internal fresh-tree mechanics. Only WindowsCodingCopy may turn these operations into canonical ownership. */
import path from "node:path/win32";
import { posix } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { ScopedCodingFileError, type ScopedCodingFileLimits } from "./coding-platform";
import { CodingPrivacyScanner, assertCodingPrivacyScope, type CodingPrivacyScope } from "./coding-privacy-scanner";
import type { CodingExportEntry } from "./coding-result-export";
import type { CodingExcludedRoot } from "./coding-project-scope";
import { codingWorkspaceFilePathProblem, codingWorkspaceFileProblemAsync } from "./scoped-coding-files";
import type { WindowsCodingNative, WindowsCodingHandle, WindowsCodingInfo } from "./windows-coding-native";
import { windowsCodingExcludedRoot, windowsCodingFold, windowsCodingRelative, windowsCodingSame, windowsCodingYield } from "./windows-coding-policy";

export interface WindowsCodingCommandStage {
  handle: WindowsCodingHandle; identity?: WindowsCodingInfo;
  children: { handle: WindowsCodingHandle; closeAttempted: boolean; closed: boolean }[];
}
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const refuse = () => new ScopedCodingFileError("boundary");

/** Full snapshot validation and privacy shutdown finish before a fresh native object is created. */
export async function validateWindowsCodingCommandEntries(entries: readonly CodingExportEntry[], limits: Readonly<ScopedCodingFileLimits>,
  excluded: readonly CodingExcludedRoot[], privacy: CodingPrivacyScope, check: () => void, signal?: AbortSignal): Promise<void> {
  check(); assertCodingPrivacyScope(privacy);
  if (!Array.isArray(entries) || entries.length > limits.entries) throw new ScopedCodingFileError("limit");
  const paths = new Map<string, CodingExportEntry>(), aliases = new Set<string>(); let total = 0;
  for (const entry of entries) {
    check();
    if (!entry || windowsCodingRelative(entry.path, false) !== entry.path || entry.path.split("/").length > limits.depth ||
        windowsCodingExcludedRoot(entry.path, excluded) || aliases.has(windowsCodingFold(entry.path))) throw refuse();
    aliases.add(windowsCodingFold(entry.path)); paths.set(entry.path, entry);
    if (entry.kind !== "directory" && entry.kind !== "file") throw refuse();
    const keys = Object.keys(entry).sort().join(",");
    if (entry.kind === "directory" ? keys !== "kind,path" : keys !== "bytes,executable,kind,path" || entry.executable !== false || !Buffer.isBuffer(entry.bytes)) throw refuse();
    if (codingWorkspaceFilePathProblem(entry.path)) throw new ScopedCodingFileError("secret");
    if (entry.kind === "file" && (entry.bytes.length > limits.fileBytes || (total += entry.bytes.length) > limits.workspaceBytes)) throw new ScopedCodingFileError("limit");
  }
  for (const entry of entries) {
    const parent = posix.dirname(entry.path);
    if (parent !== "." && paths.get(parent)?.kind !== "directory") throw refuse();
  }
  const scanner = new CodingPrivacyScanner({ signal, scope: privacy }); let failure: unknown;
  try {
    for (const entry of entries) {
      check();
      if (entry.kind === "file" && await codingWorkspaceFileProblemAsync(entry.path, entry.bytes, scanner,
        { signal, current: () => { check(); return true; } })) throw new ScopedCodingFileError("secret");
      check();
    }
  } catch (error) { failure = error; }
  // Shutdown uncertainty takes precedence over an otherwise known validation refusal.
  await scanner.close(); if (failure) throw failure; check(); assertCodingPrivacyScope(privacy);
}

/** Every newly returned native handle is entered into the caller's ledger before its first metadata query. */
export async function materializeWindowsCodingCommandStage(api: WindowsCodingNative, base: WindowsCodingHandle,
  entries: readonly CodingExportEntry[], check: () => void, own: (stage: WindowsCodingCommandStage) => void): Promise<WindowsCodingCommandStage> {
  check(); const stage: WindowsCodingCommandStage = { handle: api.create(base, `ember-command-adoption-${randomUUID()}`, "directory"), children: [] };
  own(stage); stage.identity = api.info(stage.handle); api.assertPrivate(stage.handle);
  const rootInfo = stage.identity, dirs = new Map<string, WindowsCodingHandle>([["", stage.handle]]), ids = new Set([`${rootInfo.volume}:${rootInfo.id}`]);
  if (rootInfo.kind !== "directory") throw refuse();
  const guardRoot = () => {
    check(); api.assertPrivate(stage.handle);
    if (!windowsCodingSame(rootInfo, api.info(stage.handle), false)) throw refuse();
  };
  let operationFailure: unknown;
  try {
    for (const entry of [...entries].sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path))) {
      guardRoot(); const parentPath = posix.dirname(entry.path), parent = dirs.get(parentPath === "." ? "" : parentPath);
      if (parent === undefined) throw refuse();
      const handle = api.create(parent, posix.basename(entry.path), entry.kind), owned = { handle, closeAttempted: false, closed: false };
      stage.children.push(owned);
      api.assertPrivate(handle); const fresh = api.info(handle), parentInfo = api.info(parent), id = `${fresh.volume}:${fresh.id}`;
      if (fresh.kind !== entry.kind || fresh.volume !== rootInfo.volume || ids.has(id) ||
          windowsCodingFold(fresh.finalPath) !== windowsCodingFold(path.join(parentInfo.finalPath, posix.basename(entry.path))) ||
          fresh.attributes & (0x6 | 0x5640 | 0x40000 | 0x400000) || entry.kind === "file" && fresh.links !== 1) throw refuse();
      ids.add(id);
      if (entry.kind === "directory") dirs.set(entry.path, handle);
      else {
        api.write(handle, entry.bytes); api.flush(handle); const written = api.info(handle);
        if (!windowsCodingSame(fresh, written, false) || written.size !== entry.bytes.length || written.links !== 1) throw refuse();
        const body = Buffer.alloc(entry.bytes.length);
        try {
          for (let offset = 0; offset < body.length;) {
            guardRoot(); const chunk = api.read(handle, offset, Math.min(64 * 1024, body.length - offset));
            try { if (!chunk.length || chunk.length > body.length - offset) throw refuse(); chunk.copy(body, offset); offset += chunk.length; }
            finally { chunk.fill(0); }
            await windowsCodingYield(); guardRoot();
          }
          const eof = api.read(handle, body.length, 1);
          try { if (eof.length || !windowsCodingSame(written, api.info(handle)) || hash(body) !== hash(entry.bytes)) throw refuse(); }
          finally { eof.fill(0); }
        } finally { body.fill(0); }
        // Native file writers exclude a fresh read/delete opener until their positive close.
        owned.closeAttempted = true; api.close(handle); owned.closed = true;
      }
      await windowsCodingYield(); guardRoot();
    }
  } catch (error) { operationFailure = error; }
  // Keep only the private root held for full readback. Never retry a close whose native result was unknown.
  let closeFailure: unknown;
  for (const child of stage.children.slice().reverse()) if (!child.closeAttempted) {
    child.closeAttempted = true; try { api.close(child.handle); child.closed = true; } catch (error) { closeFailure ??= error; }
  }
  if (closeFailure) throw closeFailure;
  if (operationFailure) throw operationFailure;
  guardRoot(); return stage;
}
