/**
 * The agreement to the user's own model provider's card, as Ember itself recorded it (safety-privacy-c10-1, PLAN.md §2
 * "Model service"). settings.json is a file any program can write, a text editor a worker drives included, and the
 * card's yes (`provider.consent`: its version, when and for which host) decides where every later word, screen text
 * and screenshot goes. So that yes is taken from the file only as Ember recorded it: while Ember runs, a change to the
 * file that agrees to the card (for any host, at any time) is put back; at start, an agreement is taken only where it
 * matches the keyring's seal Ember wrote when the user agreed in Home (provider-seal.bin, 0600), and until the seal is
 * read no provider of the user's is in force (`held`). Without a keyring (`basic_text`) nothing is sealed: the
 * agreement then lasts until Ember quits, and Home asks again at the next start. Every change of the user's provider in
 * force (its host coming into force, moving, or going) is a `provider` audit entry; one coming into force that can't be
 * recorded isn't taken. Plain Node: the settings store, the keyring, the audit log and what is in force are passed in.
 */

import fs from "node:fs";
import { z } from "zod";
import type { SecretBox } from "./agent/auth";
import type { AuditEntry } from "./policy/audit";

/** The card's yes as settings.json holds it (SettingsSchema `provider.consent`). */
export interface ProviderConsent { version: number; at: string | null; host: string }

/** No agreement: what a forged or unsealed one is put back to, so Home asks again. */
export const NO_PROVIDER_CONSENT: ProviderConsent = { version: 0, at: null, host: "" };

const Sealed = z.object({ version: z.number().int().min(0), at: z.string().nullable(), host: z.string().max(300) }).strict();

const same = (a: ProviderConsent | null | undefined, b: ProviderConsent | null | undefined): boolean =>
  !!a && !!b && a.version === b.version && a.at === b.at && a.host === b.host;
/** Is `c` an agreement at all (a version, for a host)? */
const agrees = (c: ProviderConsent): boolean => c.version > 0 && !!c.host;

/** What the record reads and writes: the agreement Ember recorded, sealed. */
export interface ProviderSealStore {
  /** The sealed agreement; null when there is none, or it can't be opened or read (then none is taken from the file). */
  read(): Promise<ProviderConsent | null>;
  /** Seals `c`; false when it can't be kept (no keyring, a write that failed). */
  write(c: ProviderConsent): Promise<boolean>;
}

/** The file in Ember's data folder that holds the sealed agreement. */
export const PROVIDER_SEAL_FILE = "provider-seal.bin";

/** The keyring's seal of the agreement (mode-seal.ts's, for the provider's card). */
export class ProviderSeal implements ProviderSealStore {
  private saving: Promise<unknown> = Promise.resolve();

  /** `asyncKeyring` (macOS): the keyring is asked off the main process's thread. */
  constructor(private file: string, private box: SecretBox, private opts: { asyncKeyring?: boolean } = {}) {}

  private async usable(): Promise<boolean> {
    if (this.box.getSelectedStorageBackend?.() === "basic_text") return false;
    return this.opts.asyncKeyring ? ((await this.box.isAsyncEncryptionAvailable?.()) ?? true) : this.box.isEncryptionAvailable();
  }

  async read(): Promise<ProviderConsent | null> {
    try {
      if (!(await this.usable())) return null;
      const sealed = fs.readFileSync(this.file);
      const text = this.opts.asyncKeyring && this.box.decryptStringAsync ? (await this.box.decryptStringAsync(sealed)).result : this.box.decryptString(sealed);
      const parsed = Sealed.safeParse(JSON.parse(text));
      return parsed.success ? parsed.data : null;
    } catch {
      return null; // none, or one the keyring won't open: no agreement is taken from the file
    }
  }

  write(c: ProviderConsent): Promise<boolean> {
    const run = this.saving.then(async () => {
      if (!(await this.usable())) return false;
      const text = JSON.stringify(Sealed.parse(c));
      const sealed = this.opts.asyncKeyring && this.box.encryptStringAsync ? await this.box.encryptStringAsync(text) : this.box.encryptString(text);
      const tmp = `${this.file}.${process.pid}.tmp`;
      try {
        fs.writeFileSync(tmp, sealed, { mode: 0o600 });
        fs.renameSync(tmp, this.file);
        return true;
      } catch {
        try { fs.rmSync(tmp, { force: true }); } catch { /* nothing was written */ }
        return false;
      }
    }).catch(() => false);
    this.saving = run;
    return run;
  }
}

/** What the record needs from main. */
export interface ProviderRecordDeps {
  settings: {
    own(): { provider: { consent: ProviderConsent } };
    update(patch: { provider: never }): unknown;
    onChange(fn: () => void): unknown;
  };
  /** The keyring's seal (absent: none kept, as with no keyring: an agreement lasts until Ember quits). */
  seal?: ProviderSealStore;
  /** The host of the user's own provider in force now, by the settings as they stand (null: none, Copilot or the organisation's). */
  inForce: () => string | null;
  log: { info(event: string, fields?: Record<string, unknown>): void; warn(event: string, fields?: Record<string, unknown>): void };
  /** held() changed (the seal was read, the log opened): main reconnects. */
  heldChanged?: () => void;
}

export class ProviderRecord {
  /** The agreement as Ember last recorded it (or found and trusted at start): what a file's change is measured against. */
  private good: ProviderConsent;
  /** True while Ember itself writes the agreement (Home's yes) or puts one back. */
  private mine = false;
  private undoing = false;
  /** The file's agreement waits for the seal (start). */
  private sealing: boolean;
  /** The provider in force couldn't be recorded (no audit log yet, or a write that failed), or a forged agreement couldn't be put back. */
  private unrecorded = false;
  private stuck = false;
  private audit: { write(e: AuditEntry): void } | null = null;
  /** The host recorded as in force (null: none). */
  private recorded: string | null = null;
  /** Settles once the seal has been read at start and the file made to agree with it. */
  readonly sealed: Promise<void>;

  constructor(private d: ProviderRecordDeps) {
    const own = d.settings.own().provider.consent;
    this.good = own;
    this.sealing = agrees(own);
    d.settings.onChange(() => this.changed());
    this.sealed = this.sealing ? (d.seal ? d.seal.read().catch(() => null) : Promise.resolve(null)).then(s => this.unseal(s)) : Promise.resolve();
    if (!this.sealing) this.record("start");
  }

  /** No provider of the user's may be in force now: its agreement waits for the seal or for being recorded, or couldn't be put back. */
  held(): boolean {
    return this.sealing || this.unrecorded || this.stuck;
  }

  /** Runs `change` (a settings update that agrees to the card: Home's yes) as Ember's own; the agreement it leaves is sealed. */
  as<T>(change: () => T): T {
    this.mine = true;
    let out: T;
    try { out = change(); } finally { this.mine = false; }
    const now = this.d.settings.own().provider.consent;
    const was = this.good;
    this.good = now;
    // The user agreed in Home now: what the file held before the seal was read is theirs now.
    this.sealing = false;
    this.record("home");
    if (this.d.seal && agrees(now)) void this.d.seal.write(now).then(kept => { if (!kept) this.d.log.warn("provider.seal_not_kept", {}); });
    else if (agrees(was)) this.forgetSeal();
    return out;
  }

  /** The seal is read (null: none, or unreadable): an agreement in the file that doesn't match it is withdrawn. */
  private unseal(sealed: ProviderConsent | null): void {
    if (!this.sealing) return;
    const was = this.held();
    try { this.unsealNow(sealed); } finally { if (this.held() !== was) this.d.heldChanged?.(); }
  }

  private unsealNow(sealed: ProviderConsent | null): void {
    const own = this.d.settings.own().provider.consent;
    if (agrees(own) && !same(own, sealed)) {
      this.d.log.warn("provider.unsealed", {});
      this.putBack(NO_PROVIDER_CONSENT);
    }
    this.good = this.d.settings.own().provider.consent;
    this.sealing = false;
    this.record("start");
  }

  /** The audit log is open: the provider found in force at start is recorded, or else isn't in force (fail closed). */
  opened(audit: { write(e: AuditEntry): void }): void {
    const was = this.held();
    this.audit = audit;
    this.record("start");
    if (this.held() !== was) this.d.heldChanged?.();
  }

  private changed(): void {
    if (this.mine || this.undoing) return;
    const own = this.d.settings.own().provider.consent;
    // settings.json changed outside Ember never agrees to the card: put back as Ember last recorded it.
    if (!same(own, this.good) && agrees(own)) {
      this.d.log.warn("provider.agreed_by_file", {});
      this.putBack(this.good);
      // The rest of the edit stands (an address moved to another host leaves the user's provider out of force).
      this.record("settings");
      return;
    }
    // A withdrawal (or nothing about the card) stands.
    if (agrees(this.good) && !agrees(own)) this.forgetSeal();
    this.good = own;
    this.record("settings");
  }

  /** No agreement stands: the seal says so, so an old yes left in the file isn't taken at the next start (r10-safety-y10-4). */
  private forgetSeal(): void {
    if (this.d.seal) void this.d.seal.write(NO_PROVIDER_CONSENT).then(kept => { if (!kept) this.d.log.warn("provider.seal_not_kept", {}); });
  }

  /** Writes the user's agreement back to `c`; where that can't be saved, no provider of the user's is in force until Ember restarts. */
  private putBack(c: ProviderConsent): void {
    try {
      this.undoing = true;
      const p = this.d.settings.own().provider;
      try { this.d.settings.update({ provider: { ...p, consent: c } as never }); } finally { this.undoing = false; }
      if (!same(this.d.settings.own().provider.consent, c)) throw new Error("the agreement couldn't be put back");
    } catch (err) {
      this.d.log.warn("provider.put_back_failed", { err });
      this.stuck = true;
    }
  }

  /**
   * The user's provider in force now is recorded (`via` says how it came to change): a `provider` entry with its host
   * (null: none of the user's) and the one before. One coming into force that can't be recorded isn't taken (held).
   */
  private record(via: "home" | "settings" | "start"): void {
    if (this.sealing) return;
    const host = this.d.inForce();
    if (host === this.recorded) { this.unrecorded = false; return; }
    try {
      if (!this.audit) throw new Error("the audit log isn't open yet");
      this.audit.write({ event: "provider", host, before: this.recorded, via });
      this.recorded = host;
      this.unrecorded = false;
      this.d.log.info("provider.in_force", { via, user: !!host });
    } catch (err) {
      if (this.audit) this.d.log.warn("provider.audit_failed", { err });
      // Going out of force needs no record to be taken; coming in does.
      if (host) this.unrecorded = true; else { this.recorded = host; this.unrecorded = false; }
    }
  }
}
