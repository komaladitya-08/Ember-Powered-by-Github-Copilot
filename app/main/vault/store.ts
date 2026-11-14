/**
 * The vault's file (owner decision of 2026-11-12, PLAN.md §2 "Approvals"): logins, cards and contact details, each
 * bound to one app or one site, in vault.json in Ember's data folder (0600, written whole: a temporary file renamed
 * over it), never in settings.json. Each entry's values are sealed with the OS keyring (safeStorage) together with
 * its id, kind and destination, so a value opens only for the entry it was saved as: an edited file that moves an
 * entry to another destination opens nothing. Nothing is kept when the keyring is `basic_text` or refuses. A Save
 * still being sealed when everything is forgotten (Sign out, Forget everything) keeps nothing either. What is in
 * the clear is only what Home lists (the kind, the destination and the date), so listing asks no keyring.
 *
 * A value is never logged, returned by list(), or kept in memory here: open() decrypts one entry for main's fill and
 * returns it to that caller only. Plain Node: the keyring (SecretBox) is injected.
 *
 * A file that is there but can't be read whole (torn by a crash or a lost write, an entry that isn't well formed, a
 * read error) is never written over (reliability-c12-1): a file read whole that parses wrong is kept aside as it is,
 * `vault.json.bad-<time>` (moved where nothing in it could be read, copied where some entries still can), Home says
 * the vault couldn't be read (`unreadable`) for as long as such a file is kept, across starts, until everything is
 * forgotten, and nothing is filled from what couldn't be read. A read that fails (EMFILE, EIO, EACCES) is tried once
 * more and then left where it is, never moved (r12-safety-x12-1): nothing is listed or kept until it reads again.
 * Where a file can't be kept aside, or can't be read now, nothing new is kept (`leftInPlace`).
 * Each write is flushed to the disk, the file and its folder, before it counts, as settings.json's is.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { SecretBox } from "../agent/auth";
import {
  VAULT_KINDS, VAULT_MAX_ENTRIES, checkValues, sameDestination, validDestination,
  type VaultDestination, type VaultKind, type VaultValues,
} from "../../shared/vault";

/** The vault's file name in Ember's data folder. */
export const VAULT_FILE = "vault.json";

/** One entry as the file keeps it in the clear: never a value. */
export interface VaultMeta { id: string; kind: VaultKind; dest: VaultDestination; savedAt: number }

/** What keeping an entry came to: its id, or why nothing was kept. */
export type VaultKept = { ok: true; id: string } | { ok: false; why: "invalid" | "keyring" | "write" | "full" };

interface FileEntry extends VaultMeta { sealed: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const ID = /^[0-9a-f-]{36}$/;

/** A file entry well formed (anything else in the file is dropped as unreadable). */
function validEntry(v: unknown): v is FileEntry {
  return isObj(v) && typeof v.id === "string" && ID.test(v.id) && VAULT_KINDS.includes(v.kind as VaultKind) && validDestination(v.dest)
    && typeof v.savedAt === "number" && Number.isFinite(v.savedAt) && typeof v.sealed === "string" && v.sealed.length > 0 && v.sealed.length < 64_000;
}

/** The vault's file. `asyncKeyring` (macOS): the keyring is asked only off the main thread, as the provider key is. */
export class VaultStore {
  /** Times everything was forgotten: a Save being sealed across one keeps nothing (Sign out, Forget everything). */
  private forgotten = 0;
  /** The file was there but couldn't be read whole in this run (reliability-c12-1): Home says so. */
  private trouble = false;
  /** It couldn't be kept aside either: nothing is written over it. */
  private stuck = false;
  /** The last read of the file failed (an error, not what it holds): it stays where it is and nothing is written. */
  private failed = false;

  /**
   * `keepAside` (tests): keeps the file Ember couldn't read at `to`, moved or copied; false when it couldn't be.
   */
  constructor(private file: string, private box: SecretBox, private opts: { asyncKeyring?: boolean; now?: () => number; keepAside?: (file: string, to: string, move: boolean) => boolean } = {}) {}

  /**
   * Was the vault's file there but unreadable, in whole or in part? True while it can't be read now, and while a file
   * that couldn't be read is kept aside (across starts, until everything is forgotten). Never written over.
   */
  unreadable(): boolean {
    this.read();
    return this.trouble || this.failed || this.keptAside();
  }

  /** Is the file that couldn't be read left where it was (it can't be read now, or couldn't be kept aside), so nothing new is kept? */
  leftInPlace(): boolean {
    this.read();
    return this.failed || this.stuck;
  }

  /**
   * Can values be kept here? Only with a real keyring: never `basic_text` (the key would lie beside the file), nor a
   * backend Electron can't name (`unknown`), asked again after the keyring answered, as Linux picks its backend then.
   * Windows and macOS name none: the keyring's own answer counts. Asks the keyring, so only when it is needed. Never
   * throws.
   */
  async canPersist(): Promise<boolean> {
    const plain = () => { const b = this.box.getSelectedStorageBackend?.(); return b === "basic_text" || b === "unknown"; };
    try {
      if (this.box.getSelectedStorageBackend?.() === "basic_text") return false;
      const available = this.opts.asyncKeyring
        ? (this.box.isAsyncEncryptionAvailable ? await this.box.isAsyncEncryptionAvailable() : !!this.box.encryptStringAsync)
        : this.box.isEncryptionAvailable();
      return available === true && !plain();
    } catch {
      return false; // a keyring that can't answer keeps nothing
    }
  }

  /** The entries, newest first: kind, destination and date only. Reads no secret and asks no keyring. */
  list(): VaultMeta[] {
    return this.read().map(({ id, kind, dest, savedAt }) => ({ id, kind, dest, savedAt })).sort((a, b) => b.savedAt - a.savedAt);
  }

  /** The entry of `kind` bound to `dest`, if there is one (its metadata only). */
  find(kind: VaultKind, dest: VaultDestination): VaultMeta | null {
    return this.list().find(e => e.kind === kind && sameDestination(e.dest, dest)) ?? null;
  }

  /**
   * Checks `values` (checkValues), seals them with the entry's id, kind and destination and keeps them, in place of an
   * entry of the same kind for the same destination. Nothing is kept on a keyring that is basic_text or refuses, or a
   * file that can't be written. Never throws, and never puts a value anywhere but the sealed text.
   */
  async add(kind: VaultKind, dest: VaultDestination, raw: unknown): Promise<VaultKept> {
    if (!VAULT_KINDS.includes(kind) || !validDestination(dest)) return { ok: false, why: "invalid" };
    const before = this.forgotten;
    const checked = checkValues(kind, raw);
    if (!checked.ok) return { ok: false, why: "invalid" };
    if (!(await this.canPersist())) return { ok: false, why: "keyring" };
    const id = randomUUID();
    let sealed: Buffer;
    try {
      const text = JSON.stringify({ v: 1, id, kind, dest, values: checked.values });
      sealed = this.opts.asyncKeyring && this.box.encryptStringAsync ? await this.box.encryptStringAsync(text) : this.box.encryptString(text);
    } catch {
      return { ok: false, why: "keyring" };
    }
    // Everything was forgotten while the keyring sealed this (macOS seals off the main thread): it isn't kept either.
    if (before !== this.forgotten) return { ok: false, why: "write" };
    const entries = this.read().filter(e => !(e.kind === kind && sameDestination(e.dest, dest)));
    if (entries.length >= VAULT_MAX_ENTRIES) return { ok: false, why: "full" };
    entries.push({ id, kind, dest, savedAt: (this.opts.now ?? Date.now)(), sealed: sealed.toString("base64") });
    return this.write(entries) ? { ok: true, id } : { ok: false, why: "write" };
  }

  /**
   * One entry's values, for main's fill only, or null: no such entry, the keyring refused, or what is sealed isn't
   * that entry (another id, kind or destination: an edited file). Never throws.
   */
  async open(id: string): Promise<{ meta: VaultMeta; values: VaultValues } | null> {
    const e = this.read().find(x => x.id === id);
    if (!e) return null;
    try {
      const raw = Buffer.from(e.sealed, "base64");
      const text = this.opts.asyncKeyring && this.box.decryptStringAsync ? (await this.box.decryptStringAsync(raw)).result : this.box.decryptString(raw);
      const v = JSON.parse(text) as Record<string, unknown>;
      if (v.v !== 1 || v.id !== e.id || v.kind !== e.kind || !validDestination(v.dest) || !sameDestination(v.dest, e.dest)) return null;
      const checked = checkValues(e.kind, v.values);
      if (!checked.ok) return null;
      return { meta: { id: e.id, kind: e.kind, dest: e.dest, savedAt: e.savedAt }, values: checked.values };
    } catch {
      return null; // the keyring refused, or the text isn't one of these
    }
  }

  /** Forgets one entry; true when it was there and the file was written. */
  forget(id: string): boolean {
    const entries = this.read();
    const next = entries.filter(e => e.id !== id);
    if (next.length === entries.length) return false;
    return this.write(next);
  }

  /** Forgets every entry: the file goes. True when nothing is left on disk. */
  forgetAll(): boolean {
    this.forgotten++;
    // What was kept aside because it couldn't be read goes too: it holds sealed values all the same.
    let aside = true;
    try {
      const dir = path.dirname(this.file), base = `${path.basename(this.file)}.bad-`;
      for (const f of fs.readdirSync(dir)) if (f.startsWith(base)) { try { fs.rmSync(path.join(dir, f), { force: true }); } catch { aside = false; } }
    } catch { /* no folder: nothing kept aside */ }
    this.trouble = false;
    this.stuck = false;
    this.failed = false;
    return this.remove() && aside;
  }

  private remove(): boolean {
    try { fs.rmSync(this.file, { force: true }); } catch { /* checked below */ }
    try { fs.rmSync(`${this.file}.${process.pid}.tmp`, { force: true }); } catch { /* none was being written */ }
    return !fs.existsSync(this.file);
  }

  /** The entries the file holds that are well formed; none when it is missing or unreadable (then kept aside). */
  private read(): FileEntry[] {
    const text = this.readText();
    this.failed = text === false;
    if (typeof text !== "string") return [];
    let v: unknown;
    try { v = JSON.parse(text); } catch { v = undefined; }
    if (!isObj(v) || v.v !== 1 || !Array.isArray(v.entries)) {
      this.setAside(true); // torn, or not one of these files: nothing in it can be read
      return [];
    }
    const good = v.entries.filter(validEntry);
    // Some entries can't be read: the file is kept as it is, and the ones that can still be used.
    if (good.length !== v.entries.length) this.setAside(false);
    return good.slice(0, VAULT_MAX_ENTRIES);
  }

  /**
   * The file's text; null when there is none yet (ENOENT), false when it is there and reading it failed twice (EMFILE,
   * EIO, EACCES): that says nothing of what it holds, so it is left where it is, never kept aside (r12-safety-x12-1).
   */
  private readText(): string | null | false {
    for (let attempt = 0; ; attempt++) {
      try { return fs.readFileSync(this.file, "utf8"); } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        if (attempt > 0) return false;
      }
    }
  }

  /** Is a file that couldn't be read kept aside beside the vault? */
  private keptAside(): boolean {
    try {
      const base = `${path.basename(this.file)}.bad-`;
      return fs.readdirSync(path.dirname(this.file)).some(f => f.startsWith(base));
    } catch {
      return false; // no folder: nothing kept aside
    }
  }

  /**
   * Keeps the file that couldn't be read whole aside, as it is (`move`: nothing in it could be read, so vault.json
   * goes; else a copy, the entries that could be read staying in use). Once per run for a copy; where it can't be kept,
   * nothing is written over it (stuck).
   */
  private setAside(move: boolean): void {
    if (this.trouble && !move && !this.stuck) return;
    this.trouble = true;
    const to = `${this.file}.bad-${(this.opts.now ?? Date.now)()}`;
    const keep = this.opts.keepAside ?? keepAside;
    let kept: boolean;
    try { kept = keep(this.file, to, move); } catch { kept = false; /* kept nowhere: nothing is written over it */ }
    if (!kept) this.stuck = true;
    else if (move) this.stuck = false;
  }

  private write(entries: FileEntry[]): boolean {
    // Never over a file that couldn't be read and couldn't be kept aside, or can't be read now (reliability-c12-1, x12-1).
    if (this.stuck || this.failed) return false;
    if (!entries.length) return this.remove();
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      const fd = fs.openSync(tmp, "w", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ v: 1, entries })); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.file);
      syncFolder(path.dirname(this.file));
      return true;
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing was written */ }
      return false;
    }
  }
}

/** Flushes a folder's entries (a rename) to the disk where the system can (not on Windows, where opening one fails). */
function syncFolder(dir: string): void {
  let fd: number | undefined;
  try { fd = fs.openSync(dir, "r"); fs.fsyncSync(fd); } catch { /* Windows can't open a folder: its rename is already durable */ } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* closed already */ } }
  }
}

/** Keeps `file` at `to` (0600), never over anything there: moved (a hard link, then the name removed) or copied. */
function keepAside(file: string, to: string, move: boolean): boolean {
  if (fs.existsSync(to)) return false;
  if (move) {
    try { fs.linkSync(file, to); } catch { fs.copyFileSync(file, to, fs.constants.COPYFILE_EXCL); }
    fs.rmSync(file, { force: true });
  } else fs.copyFileSync(file, to, fs.constants.COPYFILE_EXCL);
  try { fs.chmodSync(to, 0o600); } catch { /* Windows keeps its own ACLs */ }
  return true;
}
