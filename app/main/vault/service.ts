/**
 * The vault in main (owner decision of 2026-11-12, PLAN.md §2 "Approvals"): its file (store.ts), the Secure Form
 * (form.ts), Home's list with Forget, and the organisation's switch. `features.vault: false` in the admin policy, or a
 * lockdown, turns it off: no form opens and nothing is kept (what is already kept stays listed, with Forget). No form
 * opens before the consent, or while Autopilot isn't the mode in force: only Autopilot uses the vault. Sign out and
 * Forget everything forget it whole (forgetAll).
 *
 * Home's channels (VAULT_IPC.list, forget, forgetAll) answer only the settings window's own page, their arguments
 * typed `unknown` and checked; no answer ever holds a value, a value's length or anything sealed. Plain Node.
 */

import type { Logger } from "../logger";
import type { StopPart } from "../agent/killswitch";
import {
  VAULT_IPC, VAULT_KINDS, VAULT_PARTS, sameDestination, siteLabel, validDestination,
  type VaultDestination, type VaultEntryRow, type VaultHomeState, type VaultKind, type VaultPart,
} from "../../shared/vault";
import type { VaultAnswer, VaultFormController } from "./form";
import type { VaultKept, VaultMeta, VaultStore } from "./store";

/** The part of the store the service uses. */
export type VaultStoreLike = Pick<VaultStore, "list" | "find" | "forget" | "forgetAll" | "canPersist" | "add" | "open">;

/**
 * What using an entry came to: what `put` answered, or why nothing was handed to it. `off`: the vault can't be used now
 * (the organisation, the consent, the mode); `none`: no entry of that kind is bound there, or it couldn't be opened
 * (the keyring refused, the file was edited); `part`: the entry holds no such part (a login saved without a user name).
 */
export type VaultUse<R> = { ok: true; result: R } | { ok: false; why: "off" | "none" | "part" };

export interface VaultServiceOptions {
  store: VaultStoreLike;
  form: Pick<VaultFormController, "ask" | "stop">;
  /** The organisation lets the vault be used: `features.vault` isn't false and the policy isn't locked down. */
  allowed: () => boolean;
  /** The person agreed to the consent as it reads now. */
  consented: () => boolean;
  /** Autopilot is the mode in force now (approvalInputs(modeInForce(...)).autopilot). */
  autopilot: () => boolean;
  /** An app's familiar name from its key (friendlyApp). */
  appName: (key: string) => string;
  log: Logger;
  /** The list changed: Home is told (VAULT_IPC.changed). */
  changed?: () => void;
}

/**
 * Why a form wasn't shown, or how it ended: `off` (the organisation turned the vault off, no consent, or Autopilot
 * isn't in force), `kept` (an entry of that kind is already bound there: nothing is asked) or the form's own answer.
 */
export type VaultAsk = "off" | "kept" | VaultAnswer;

/** A destination as Home and the form name it: a site's host ("github.com"), an app's familiar name. */
export function destinationLabel(dest: VaultDestination, appName: (key: string) => string): string {
  return "site" in dest ? siteLabel(dest.site) : appName(dest.app) || dest.app;
}

/** An entry as Home lists it (VaultEntryRow): kind, where and when, never a value. */
export function entryRow(m: VaultMeta, appName: (key: string) => string): VaultEntryRow {
  return { id: m.id, kind: m.kind, where: destinationLabel(m.dest, appName), site: "site" in m.dest, savedAt: m.savedAt };
}

export class VaultService {
  constructor(private o: VaultServiceOptions) {}

  /** The organisation lets the vault be used. */
  allowed(): boolean {
    try { return this.o.allowed(); } catch { return false; } // a policy that can't say keeps it off
  }

  /** What Home shows: whether it may be used, and the entries (kind, where, when). */
  homeState(): VaultHomeState {
    return { allowed: this.allowed(), entries: this.o.store.list().map(m => entryRow(m, this.o.appName)) };
  }

  /**
   * Forgets one entry (Home's Forget). Allowed whatever the policy: forgetting only ever keeps less. `gone`: it is
   * no longer kept (also when it already wasn't); false when the file couldn't be written, so it is still there.
   */
  forget(id: string): boolean {
    const had = this.o.store.list().some(e => e.id === id);
    if (!had) { this.o.changed?.(); return true; }
    const gone = this.o.store.forget(id);
    this.o.log.info("vault.forgot", { all: false, ok: gone });
    this.o.changed?.();
    return gone;
  }

  /**
   * Forgets every entry (Home's Forget all, Sign out, Forget everything). An open form closes first, and a Save still
   * being sealed keeps nothing (the store's own guard). True when nothing is left on disk.
   */
  forgetAll(): boolean {
    const had = this.o.store.list().length > 0;
    try { this.o.form.stop(); } catch (err) { this.o.log.warn("vault.form_stop_failed", { err }); }
    const gone = this.o.store.forgetAll();
    if (had || !gone) this.o.log.info("vault.forgot", { all: true, ok: gone });
    this.o.changed?.();
    return gone;
  }

  /**
   * Asks the person once, in the Secure Form, for `kind`'s details for `dest` (vault-2's fill calls this): never while
   * the vault is off, before the consent or outside Autopilot, and never again where an entry of that kind is bound
   * there already. `via`: the browser the form is asked from, for a site (the window system's name for it).
   */
  async ask(kind: VaultKind, dest: VaultDestination, via: string | null): Promise<VaultAsk> {
    if (!VAULT_KINDS.includes(kind) || !validDestination(dest)) return "off";
    if (!this.usable()) return "off";
    if (this.o.store.find(kind, dest)) return "kept";
    let keyring = false;
    try { keyring = await this.o.store.canPersist(); } catch { /* a keyring that can't answer keeps nothing: the form says so */ }
    // Checked again after the keyring answered (macOS asks it off the main thread): a Stop, a lockdown or another mode since.
    if (!this.usable()) return "off";
    return this.o.form.ask({ kind, dest, where: destinationLabel(dest, this.o.appName), via: "site" in dest ? via : null, keyring });
  }

  /**
   * Is an entry of `kind` bound to `dest` (a worker's fill asks before it opens the Secure Form)? Never while the vault
   * can't be used. Reads the list only: no keyring is asked and no value opened.
   */
  has(kind: VaultKind, dest: VaultDestination): boolean {
    return VAULT_KINDS.includes(kind) && validDestination(dest) && this.usable() && !!this.o.store.find(kind, dest);
  }

  /**
   * The fill itself: opens the entry of `kind` bound to exactly `dest` and hands `part` of it to `put`, which puts it
   * into the field (the helper's vault_fill, or keys typed under the borrow) and answers with what that came to. The
   * value exists only in that call: it is never returned, logged or kept here, and `put`'s answer must not hold it.
   * Checked at this moment, so nothing is handed over once the organisation turned the vault off, the consent went or
   * Autopilot is no longer the mode in force. The entry's own destination, as sealed with it, must be `dest`.
   */
  async use<R>(kind: VaultKind, part: VaultPart, dest: VaultDestination, put: (value: string) => Promise<R>): Promise<VaultUse<R>> {
    if (!VAULT_KINDS.includes(kind) || !validDestination(dest) || !(VAULT_PARTS[kind] as readonly string[]).includes(part)) return { ok: false, why: "none" };
    if (!this.usable()) return { ok: false, why: "off" };
    const meta = this.o.store.find(kind, dest);
    if (!meta) return { ok: false, why: "none" };
    const opened = await this.o.store.open(meta.id);
    // Checked again once the keyring answered (it may have asked the person), and what was opened is that entry.
    if (!this.usable()) return { ok: false, why: "off" };
    if (!opened || opened.meta.kind !== kind || !sameDestination(opened.meta.dest, dest)) return { ok: false, why: "none" };
    const value = opened.values[part];
    if (typeof value !== "string" || !value) return { ok: false, why: "part" };
    const result = await put(value);
    this.o.log.info("vault.used", { kind, part, site: "site" in dest });
    return { ok: true, result };
  }

  /**
   * Seals and keeps what the Secure Form's Save sent (the form's `keep`): checked again at that moment, so nothing is
   * kept once the organisation turned the vault off, the consent went or Autopilot is no longer in force (`gone`).
   */
  async keep(kind: VaultKind, dest: VaultDestination, values: unknown): Promise<VaultKept | { ok: false; why: "gone" }> {
    if (!this.usable()) return { ok: false, why: "gone" };
    const kept = await this.o.store.add(kind, dest, values);
    if (kept.ok) { this.o.log.info("vault.kept", { kind, site: "site" in dest }); this.o.changed?.(); }
    return kept;
  }

  /** May the vault take, ask for or fill anything now: allowed, consented, and Autopilot in force. A check that fails says no. */
  usable(): boolean {
    try { return this.allowed() && this.o.consented() && this.o.autopilot(); } catch { return false; }
  }

  /**
   * The mode, the consent or the policy may have changed: a form still open closes (answered `stopped`) once the vault
   * can't be used, so nobody types into a form whose Save would keep nothing.
   */
  recheck(): void {
    if (this.usable()) return;
    try { this.o.form.stop(); } catch (err) { this.o.log.warn("vault.form_stop_failed", { err }); }
  }

  /** The kill switch's part: an open form closes, and nothing more is asked in it. */
  stopPart(): StopPart {
    return { name: "vault", stop: () => this.o.form.stop() };
  }
}

/** The part of Electron's ipcMain Home's channels use. */
export interface VaultIpcMain { handle(channel: string, fn: (event: VaultIpcEvent, ...args: unknown[]) => unknown): void }
export interface VaultIpcEvent { sender: unknown; senderFrame?: { url: string } | null }

/**
 * Registers Home's channels: the list, Forget and Forget all. A sender that isn't the settings window is refused with
 * an error, before anything else. Forget's id is checked (a string of an id's shape) before use.
 */
export function registerVaultHomeIpc(ipcMain: VaultIpcMain, isHomeSender: (event: VaultIpcEvent) => boolean, service: VaultService): void {
  const guard = (channel: string, fn: (...args: unknown[]) => unknown) => {
    ipcMain.handle(channel, (event, ...args) => {
      if (!isHomeSender(event)) throw new Error(`untrusted IPC sender on ${channel}`);
      return fn(...args);
    });
  };
  guard(VAULT_IPC.list, () => service.homeState());
  guard(VAULT_IPC.forget, (id: unknown) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id) && service.forget(id));
  guard(VAULT_IPC.forgetAll, () => service.forgetAll());
}
