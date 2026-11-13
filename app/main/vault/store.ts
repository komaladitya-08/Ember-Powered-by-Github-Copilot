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
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs";
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

  constructor(private file: string, private box: SecretBox, private opts: { asyncKeyring?: boolean; now?: () => number } = {}) {}

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
    return this.remove();
  }

  private remove(): boolean {
    try { fs.rmSync(this.file, { force: true }); } catch { /* checked below */ }
    try { fs.rmSync(`${this.file}.${process.pid}.tmp`, { force: true }); } catch { /* none was being written */ }
    return !fs.existsSync(this.file);
  }

  /** The entries the file holds that are well formed; none when it is missing or unreadable. */
  private read(): FileEntry[] {
    let text: string;
    try { text = fs.readFileSync(this.file, "utf8"); } catch { return []; /* none kept yet */ }
    try {
      const v = JSON.parse(text) as unknown;
      if (!isObj(v) || v.v !== 1 || !Array.isArray(v.entries)) return [];
      return v.entries.filter(validEntry).slice(0, VAULT_MAX_ENTRIES);
    } catch {
      return []; // not one of these files
    }
  }

  private write(entries: FileEntry[]): boolean {
    if (!entries.length) return this.remove();
    const tmp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, entries }), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.file);
      return true;
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* nothing was written */ }
      return false;
    }
  }
}
