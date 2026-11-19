/** Explicit encrypted coding drafts for guarded Home actions. Keyring seals only a random key; complete source stays authenticated ciphertext. */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { setImmediate as yieldTurn } from "node:timers/promises";
import type { SecretBox } from "./auth";
import { CodingArtifactCleanupError, type CodingArtifactSourceRef, type CodingArtifactStore } from "./coding-artifact-store";
import type { CodingWorkspace } from "./coding-workspace";
import type { CodingWorkspaceContinuation } from "./coding-seed-snapshot";
import { checkCodingDraft } from "./coding-draft-codec";
import { codingDraftOwner, codingDraftMetadata, CodingDraftError, CodingDraftCleanupError,
  CODING_DRAFT_MAX_FILE_BYTES, CODING_DRAFT_MAX_HEADER_BYTES, type CodingDraftOwner, type CodingDraftMetadata, type CodingDraftPreview } from "./coding-draft-format";
import { captureCodingDraftSnapshot, codingDraftSnapshotData, type CodingDraftSnapshot, type CodingDraftSourceWitness } from "./coding-draft-snapshot";
export { CodingDraftError, CodingDraftCleanupError } from "./coding-draft-format";

const MAGIC = Buffer.from("EMBERDRAFT1\0"), CHUNK = 64 * 1024, MAX_DRAFTS = 8;
const filename = /^coding-draft-([a-f0-9]{64})-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\.bin$/;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
interface Inert { document: Buffer; metadata: CodingDraftMetadata; preview?: CodingDraftPreview; source?: CodingDraftSourceWitness; check(): void; closed: boolean }
declare const openedBrand: unique symbol;
export interface OpenCodingDraft {
  readonly [openedBrand]: true;
  /** Data only. The caller owns the returned copy; this is not model context or execution authority. */
  metadata(): CodingDraftMetadata;
  reviewBytes(): Buffer;
  close(): void;
}
interface DirectoryState {
  epoch: number; retiring: number; revisions: Map<string, number>; blocked: Set<string>;
  pending: Set<{ file: string; done: Promise<unknown> }>; opened: Map<string, Set<Inert>>; sources: Map<string, CodingDraftSourceWitness>;
  snapshots: Map<string, Set<CodingDraftSnapshot>>; reservations: Map<string, number>; failure: CodingDraftCleanupError | CodingArtifactCleanupError | null;
}
const directories = new Map<string, DirectoryState>();
const opened = new WeakMap<OpenCodingDraft, Inert>();
const sameDirectory = (a: fs.Stats, b: fs.Stats) => b.isDirectory() && !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino;
const sameFile = (a: fs.Stats, b: fs.Stats) => b.isFile() && !b.isSymbolicLink() && b.nlink === 1 && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
function uncertain(error: unknown): error is CodingDraftCleanupError | CodingArtifactCleanupError { return error instanceof CodingDraftCleanupError || error instanceof CodingArtifactCleanupError; }
function safe(error: unknown): Error { return error instanceof CodingDraftError || uncertain(error) ? error : new CodingDraftError("io"); }
function parsedOwner(value: unknown): CodingDraftOwner {
  const parsed = codingDraftOwner.safeParse(value);
  if (!parsed.success) throw new CodingDraftError("invalid");
  return parsed.data;
}
function revoke(state: Inert): void {
  state.closed = true; state.preview = undefined; state.document.fill(0); state.document = Buffer.alloc(0); state.source = undefined;
  state.metadata = { ...state.metadata, name: "", sourceLabel: "", context: { request: "", summary: "" } };
  state.check = () => { throw new CodingDraftError("stale"); };
}

export class CodingDraftStore {
  #dir: string; #state: DirectoryState; #closed = false; #closing: Promise<void> | null = null;
  constructor(private readonly privateDir: string, private readonly box: SecretBox, private readonly asyncKeyring: boolean) {
    this.#dir = path.resolve(privateDir, "coding-drafts");
    let state = directories.get(this.#dir);
    if (!state) { state = { epoch: 0, retiring: 0, revisions: new Map(), blocked: new Set(), pending: new Set(), opened: new Map(), sources: new Map(), snapshots: new Map(), reservations: new Map(), failure: null }; directories.set(this.#dir, state); }
    this.#state = state;
  }
  #file(owner: CodingDraftOwner, id: string): string {
    const parsed = parsedOwner(owner);
    if (typeof id !== "string" || !idPattern.test(id)) throw new CodingDraftError("invalid");
    return path.join(this.#dir, `coding-draft-${parsed.library}-${id.toLowerCase()}.bin`);
  }
  #prepare(): fs.Stats {
    const parent = fs.lstatSync(this.privateDir);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw new CodingDraftError("io");
    try { fs.mkdirSync(this.#dir, { mode: 0o700 }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    return this.#directory();
  }
  #directory(): fs.Stats {
    const stat = fs.lstatSync(this.#dir);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.dirname(fs.realpathSync(this.#dir)) !== fs.realpathSync(this.privateDir)) throw new CodingDraftError("io");
    return stat;
  }
  #ensure(): fs.Stats {
    try { return this.#directory(); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return this.#prepare(); }
  }
  #check(current: () => boolean): void {
    if (this.#state.failure) throw this.#state.failure;
    try { if (this.#closed || this.#state.retiring || current() !== true || this.#closed || this.#state.retiring) throw new Error(); }
    catch { throw new CodingDraftError("stale"); }
  }
  #fence(directory: fs.Stats, epoch: number, file: string, revision: number, current: () => boolean): void {
    this.#check(current);
    if (this.#state.epoch !== epoch || this.#state.blocked.has(file) || (this.#state.revisions.get(file) ?? 0) !== revision || !sameDirectory(directory, this.#directory())) throw new CodingDraftError("stale");
  }
  #track<T>(file: string, operation: () => Promise<T>): Promise<T> {
    const done = Promise.resolve().then(operation), record = { file, done };
    this.#state.pending.add(record);
    return done.catch(error => { if (uncertain(error)) this.#state.failure = error; throw safe(error); }).finally(() => this.#state.pending.delete(record));
  }
  async #keyring(operation: "encrypt" | "decrypt"): Promise<void> {
    if (this.box.getSelectedStorageBackend?.() === "basic_text" ||
      (this.asyncKeyring && typeof (operation === "encrypt" ? this.box.encryptStringAsync : this.box.decryptStringAsync) !== "function") ||
      !(this.asyncKeyring ? await this.box.isAsyncEncryptionAvailable?.() : this.box.isEncryptionAvailable())) throw new CodingDraftError("keyring");
  }
  #retireFile(file: string): void {
    this.#state.revisions.set(file, (this.#state.revisions.get(file) ?? 0) + 1);
    for (const snapshot of this.#state.snapshots.get(file) ?? []) snapshot.close();
    this.#state.snapshots.delete(file);
    for (const state of this.#state.opened.get(file) ?? []) revoke(state);
    this.#state.opened.delete(file); this.#state.sources.delete(file);
  }

  /** Capture belongs to this store's erasure generation, including the time before any ciphertext exists. */
  capture(input: Parameters<typeof captureCodingDraftSnapshot>[0]): Promise<CodingDraftSnapshot> {
    let file: string, directory: fs.Stats, captured: typeof input;
    try {
      captured = { ...input, metadata: structuredClone(input.metadata) };
      this.#check(captured.current); file = this.#file(captured.metadata.owner, captured.metadata.id); directory = this.#ensure();
    }
    catch (error) { return Promise.reject(safe(error)); }
    const epoch = this.#state.epoch, revision = this.#state.revisions.get(file) ?? 0, selected = captured.current.bind(input);
    const sourceCurrent = captured.sourceCurrent?.bind(input) ?? selected;
    const current = () => { try { this.#fence(directory, epoch, file, revision, selected); return true; } catch { return false; } };
    return this.#track(file, async () => {
      const snapshot = await captureCodingDraftSnapshot({ ...captured, current, sourceCurrent });
      if (!current()) { snapshot.close(); throw new CodingDraftError("stale"); }
      const set = this.#state.snapshots.get(file) ?? new Set<CodingDraftSnapshot>(); set.add(snapshot); this.#state.snapshots.set(file, set);
      return snapshot;
    });
  }

  /** Only explicit host Save may call this. No arbitrary JSON or model result can stand in for the branded snapshot. */
  save(owner: CodingDraftOwner, snapshot: CodingDraftSnapshot, current: () => boolean): Promise<string> {
    let data: ReturnType<typeof codingDraftSnapshotData> | undefined, file: string, directory: fs.Stats;
    try {
      owner = parsedOwner(owner);
      this.#check(current); data = codingDraftSnapshotData(snapshot);
      if (data.metadata.owner.library !== owner.library || data.metadata.owner.holder !== owner.holder) throw new CodingDraftError("holder");
      file = this.#file(owner, data.metadata.id); directory = this.#ensure();
      const names = new Set(fs.readdirSync(this.#dir).filter(name => filename.exec(name)?.[1] === owner.library));
      for (const reserved of this.#state.reservations.keys()) if (filename.exec(path.basename(reserved))?.[1] === owner.library) names.add(path.basename(reserved));
      if (!names.has(path.basename(file)) && names.size >= MAX_DRAFTS) throw new CodingDraftError("limit");
      this.#retireFile(file);
      this.#state.reservations.set(file, (this.#state.reservations.get(file) ?? 0) + 1);
    } catch (error) { data?.document.fill(0); return Promise.reject(safe(error)); }
    const captured = data;
    const epoch = this.#state.epoch, revision = this.#state.revisions.get(file)!;
    const check = () => this.#fence(directory, epoch, file, revision, current);
    return this.#track(file, async () => {
      let key: Buffer | undefined, payload: Buffer | undefined, encrypted: Buffer | undefined, primary: unknown, failed = false;
      const temporary = path.join(this.#dir, `.ember-coding-draft-${randomUUID()}`);
      try {
        // Capture certified these private immutable bytes in this process under this same loaded privacy policy.
        // Snapshot transfer returns independent copies; repeating the worker pass adds no new observation.
        check();
        const header = Buffer.from(JSON.stringify(captured.metadata)), length = Buffer.alloc(4); length.writeUInt32BE(header.length);
        payload = Buffer.concat([length, header, captured.document]); key = randomBytes(32);
        await this.#keyring("encrypt"); check();
        const keyText = key.toString("base64");
        const wrapped = this.asyncKeyring ? await this.box.encryptStringAsync!(keyText) : this.box.encryptString(keyText); check();
        if (wrapped.length > 2048 || !wrapped.length) throw new CodingDraftError("keyring");
        const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
        const wrappedLength = Buffer.alloc(4); wrappedLength.writeUInt32BE(wrapped.length);
        const prefix = Buffer.concat([MAGIC, wrappedLength, wrapped, nonce]); cipher.setAAD(prefix);
        const chunks: Buffer[] = [prefix];
        for (let at = 0; at < payload.length; at += CHUNK) { check(); chunks.push(cipher.update(payload.subarray(at, at + CHUNK))); await yieldTurn(); check(); }
        chunks.push(cipher.final(), cipher.getAuthTag()); encrypted = Buffer.concat(chunks);
        if (encrypted.length > CODING_DRAFT_MAX_FILE_BYTES) throw new CodingDraftError("limit");
        const handle = await fsp.open(temporary, "wx", 0o600);
        try {
          for (let at = 0; at < encrypted.length;) {
            check(); const written = await handle.write(encrypted, at, Math.min(CHUNK, encrypted.length - at), at); check();
            if (!written.bytesWritten) throw new CodingDraftError("io"); at += written.bytesWritten;
          }
          await handle.sync();
        }
        finally { await handle.close(); }
        check(); fs.renameSync(temporary, file);
        if (captured.source) this.#state.sources.set(file, captured.source);
      } catch (error) {
        primary = error; failed = true;
      } finally {
        captured.document.fill(0); key?.fill(0); payload?.fill(0); encrypted?.fill(0);
        try { await fsp.rm(temporary, { force: true }); }
        catch (error) { if (!uncertain(primary)) primary = error; failed = true; }
        finally {
          const reserved = (this.#state.reservations.get(file) ?? 1) - 1;
          if (reserved) this.#state.reservations.set(file, reserved); else this.#state.reservations.delete(file);
        }
      }
      if (failed) throw primary;
      return captured.metadata.id;
    });
  }

  /** Open is inert, even after a restart. It creates no SDK, task, source, artifact or continuation capability. */
  open(owner: CodingDraftOwner, id: string, current: () => boolean): Promise<OpenCodingDraft | null> {
    let file: string, directory: fs.Stats;
    try { owner = parsedOwner(owner); this.#check(current); file = this.#file(owner, id); directory = this.#ensure(); }
    catch (error) { return Promise.reject(safe(error)); }
    const epoch = this.#state.epoch, revision = this.#state.revisions.get(file) ?? 0;
    const check = () => this.#fence(directory, epoch, file, revision, current);
    return this.#track(file, async () => {
      let key: Buffer | undefined, sealed: Buffer | undefined, payload: Buffer | undefined;
      try {
        check(); let handle: fsp.FileHandle;
        try { handle = await fsp.open(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0)); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
        let before: fs.Stats;
        try {
          check(); before = await handle.stat(); check();
          if (!sameFile(before, fs.lstatSync(file)) || before.size > CODING_DRAFT_MAX_FILE_BYTES || before.size < MAGIC.length + 36) throw new CodingDraftError("invalid");
          sealed = Buffer.alloc(before.size); let at = 0;
          while (at < sealed.length) { check(); const read = await handle.read(sealed, at, Math.min(CHUNK, sealed.length - at), at); check(); if (!read.bytesRead) throw new CodingDraftError("invalid"); at += read.bytesRead; }
          if (!sameFile(before, await handle.stat())) throw new CodingDraftError("invalid"); check();
        } finally { await handle.close(); }
        if (!sealed.subarray(0, MAGIC.length).equals(MAGIC)) throw new CodingDraftError("invalid");
        const wrappedSize = sealed.readUInt32BE(MAGIC.length), prefixSize = MAGIC.length + 4 + wrappedSize + 12;
        if (!wrappedSize || wrappedSize > 2048 || prefixSize + 20 > sealed.length) throw new CodingDraftError("invalid");
        await this.#keyring("decrypt"); check();
        const wrapped = sealed.subarray(MAGIC.length + 4, prefixSize - 12);
        const keyText = this.asyncKeyring ? (await this.box.decryptStringAsync!(wrapped)).result : this.box.decryptString(wrapped); check();
        if (!/^[A-Za-z0-9+/]{43}=$/.test(keyText)) throw new CodingDraftError("invalid");
        key = Buffer.from(keyText, "base64"); if (key.length !== 32 || key.toString("base64") !== keyText) throw new CodingDraftError("invalid");
        const decipher = createDecipheriv("aes-256-gcm", key, sealed.subarray(prefixSize - 12, prefixSize));
        decipher.setAAD(sealed.subarray(0, prefixSize)); decipher.setAuthTag(sealed.subarray(-16));
        const chunks: Buffer[] = [];
        for (let at = prefixSize; at < sealed.length - 16; at += CHUNK) { check(); chunks.push(decipher.update(sealed.subarray(at, Math.min(at + CHUNK, sealed.length - 16)))); await yieldTurn(); check(); }
        chunks.push(decipher.final()); payload = Buffer.concat(chunks); check();
        const headerSize = payload.readUInt32BE(0);
        if (headerSize > CODING_DRAFT_MAX_HEADER_BYTES || headerSize + 4 >= payload.length) throw new CodingDraftError("invalid");
        const metadata = codingDraftMetadata.parse(JSON.parse(payload.subarray(4, 4 + headerSize).toString("utf8")));
        if (metadata.id !== id.toLowerCase() || metadata.owner.library !== owner.library || metadata.owner.holder !== owner.holder) throw new CodingDraftError("holder");
        const document = Buffer.from(payload.subarray(4 + headerSize));
        try {
          const verified = await checkCodingDraft(metadata, document, check); check();
          if (!sameFile(before!, fs.lstatSync(file))) throw new CodingDraftError("stale");
          const state: Inert = { document, metadata: verified.metadata, preview: verified.preview, check, closed: false, source: this.#state.sources.get(file) };
          const assert = () => { if (state.closed) throw new CodingDraftError("stale"); state.check(); };
          const directoryState = this.#state, set = directoryState.opened.get(file) ?? new Set<Inert>();
          const token = Object.freeze({ metadata() { assert(); return structuredClone(state.metadata); }, reviewBytes() { assert(); return Buffer.from(state.document); }, close() {
            revoke(state); set.delete(state);
            if (!set.size && directoryState.opened.get(file) === set) directoryState.opened.delete(file);
          } }) as OpenCodingDraft;
          opened.set(token, state);
          set.add(state); this.#state.opened.set(file, set);
          return token;
        } catch (error) { document.fill(0); throw error; }
      } finally { key?.fill(0); sealed?.fill(0); payload?.fill(0); }
    });
  }

  /** Lists only decrypted owner-matching metadata; neither names nor paths are stored as plaintext indexes. */
  async list(owner: CodingDraftOwner, current: () => boolean): Promise<CodingDraftMetadata[]> {
    owner = parsedOwner(owner); this.#check(current); this.#ensure();
    const names = fs.readdirSync(this.#dir).map(name => filename.exec(name)).filter(match => match?.[1] === owner.library);
    if (names.length > MAX_DRAFTS) throw new CodingDraftError("limit");
    const values: CodingDraftMetadata[] = [];
    for (const match of names) { const value = await this.open(owner, match![2], current); this.#check(current); if (value) try { values.push(value.metadata()); } finally { value.close(); } }
    return values;
  }

  /** Revocation is synchronous. Deletion waits every admitted read/save, without needing a working keyring. */
  async forget(owner: CodingDraftOwner, id: string, current: () => boolean): Promise<void> {
    const file = this.#file(owner, id); this.#check(current); const directory = this.#ensure();
    this.#retireFile(file); this.#state.blocked.add(file);
    try {
      await Promise.allSettled([...this.#state.pending].filter(record => record.file === file).map(record => record.done));
      this.#check(current); if (!sameDirectory(directory, this.#directory())) throw new CodingDraftError("io");
      fs.rmSync(file, { force: true });
      if (this.#state.failure) throw this.#state.failure;
    } finally { this.#state.blocked.delete(file); }
  }
  /** Includes every exact draft file and saves that have not yet produced a file, even while signed out. */
  async forgetAll(current: () => boolean): Promise<void> {
    this.#check(current); const directory = this.#ensure(); this.#state.retiring++; this.#state.epoch++;
    for (const file of new Set([...this.#state.revisions.keys(), ...this.#state.snapshots.keys(), ...[...this.#state.pending].map(record => record.file)])) this.#retireFile(file);
    try {
      await Promise.allSettled([...this.#state.pending].map(record => record.done));
      if (current() !== true || !sameDirectory(directory, this.#directory())) throw new CodingDraftError("stale");
      for (const name of fs.readdirSync(this.#dir)) if (filename.test(name)) fs.rmSync(path.join(this.#dir, name), { force: true });
      if (this.#state.failure) throw this.#state.failure;
    } finally { this.#state.retiring--; }
  }
  /** Account/quit barrier releases this instance's drafts and observes all admitted worker/data operations. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true;
    for (const values of this.#state.snapshots.values()) for (const snapshot of values) snapshot.close();
    this.#state.snapshots.clear();
    for (const states of this.#state.opened.values()) for (const state of states) revoke(state);
    this.#state.opened.clear();
    this.#state.sources.clear();
    return this.#closing = Promise.allSettled([...this.#state.pending].map(record => record.done)).then(results => {
      if (this.#state.failure) throw this.#state.failure;
      const failure = results.find(result => result.status === "rejected" && uncertain(result.reason));
      if (failure?.status === "rejected") throw failure.reason;
    });
  }
}

/** Internal owned data copy from a genuine opened token; copied methods or serialized objects confer nothing. */
export function readOpenedCodingDraft(token: OpenCodingDraft): { metadata: CodingDraftMetadata; document: Buffer } {
  const state = opened.get(token);
  if (!state || state.closed) throw new CodingDraftError("invalid");
  state.check(); return { metadata: structuredClone(state.metadata), document: Buffer.from(state.document) };
}
/** Internal bounded projection from the already verified worker result, with no second full-file decode. */
export function codingDraftPreviewData(token: OpenCodingDraft): CodingDraftPreview {
  const state = opened.get(token);
  if (!state || state.closed || !state.preview) throw new CodingDraftError("invalid");
  state.check(); return structuredClone(state.preview);
}

/**
 * A live source witness may be reattached only to a new explicit grant and a genuine fresh source receipt.
 * Restarted drafts have no native witness: they remain review-only instead of upgrading a saved path into authority.
 */
export async function reattachCodingDraft(draft: OpenCodingDraft, input: {
  store: CodingArtifactStore; source: CodingArtifactSourceRef; grant: CodingWorkspace;
  owner: CodingDraftOwner; request: string; current(): boolean;
}): Promise<{ kind: "review-only"; reason: "source-identity-unknown" | "source-changed" } | { kind: "continuation-data"; continuation: CodingWorkspaceContinuation }> {
  const state = opened.get(draft);
  if (!state || state.closed) throw new CodingDraftError("invalid");
  const selectedCurrent = input.current.bind(input), grantCurrent = input.grant.current.bind(input.grant), selectedPath = input.grant.path;
  const owner = parsedOwner(input.owner), request = input.request, store = input.store, freshSource = input.source;
  const baseCheck = () => {
    state.check();
    try {
      if (state.closed || selectedCurrent() !== true || grantCurrent() !== true || state.metadata.owner.library !== owner.library || state.metadata.owner.holder !== owner.holder) throw new Error();
    } catch { throw new CodingDraftError("stale"); }
  };
  baseCheck();
  if (typeof request !== "string" || !request.trim() || request.length > 2000) throw new CodingDraftError("invalid");
  const source = state.source;
  const sourceCurrent = () => { try { return source?.current() === true; } catch { return false; } };
  if (!source || source.store !== store || !sourceCurrent()) return { kind: "review-only", reason: "source-identity-unknown" };
  const check = () => { baseCheck(); if (!sourceCurrent()) throw new CodingDraftError("stale"); baseCheck(); };
  check();
  if (await store.sourceBoundary(selectedPath, check, freshSource) !== freshSource) return { kind: "review-only", reason: "source-changed" };
  check(); if (!await store.sameSource(source.source, freshSource, check)) return { kind: "review-only", reason: "source-changed" };
  check(); const decoded = (await checkCodingDraft(state.metadata, state.document, check, undefined, true)).decoded; check();
  if (!decoded) throw new CodingDraftError("invalid");
  for (const tree of [decoded.baseline, decoded.proposed, decoded.current]) for (const entry of tree?.entries ?? []) if (entry.kind === "file") entry.bytes = Buffer.from(entry.bytes.buffer, entry.bytes.byteOffset, entry.bytes.byteLength);
  for (const entry of decoded.current?.entries ?? []) if (entry.kind === "file") entry.bytes.fill(0);
  check();
  return { kind: "continuation-data", continuation: { baseline: decoded.baseline, proposed: decoded.proposed, ...(decoded.scope ? { scope: decoded.scope } : {}), current: () => { try { check(); return source.current() === true; } catch { return false; } } } };
}
