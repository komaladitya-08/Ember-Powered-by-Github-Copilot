/**
 * The record of the approval mode in force (PLAN.md §2 "Approvals"; security review of #127, when it was Work without
 * asking's switch): every change of it is an `autonomy` audit entry that says the mode, the one before and how it
 * changed (Home's choice, a voice or typed intent, the file, or the organisation's policy), and a change to a mode
 * that asks less that can't be recorded isn't made: the user's setting is put back as it was, and where that can't be
 * saved either, Ember is held below Interactive in memory (autonomy.ts holdAutonomyOff; review of PR #193).
 *
 * settings.json is a file any program can write, a text editor a worker drives included, so it never raises the mode
 * on its own (modes-x9s-2, modes-x9p-5): while Ember runs, a change to it that raises the mode in force or agrees to a
 * card is put back; at start, a mode above Interactive and the agreement to Assisted's or Autopilot's card are taken
 * from it only where they match the keyring's seal of the setting as Ember last recorded it itself (mode-seal.ts),
 * and Ember is at most Interactive until that seal is read. Only Home's choice and the host's intents, which Ember
 * marks itself, change it upwards. Plain Node: the settings store, the seal and the audit log are passed in.
 */

import { APPROVAL_MODES, modeRank, type ApprovalMode, type ModeInForce, type SealNotes, type SealTrouble } from "../../shared/approvals";
import { autonomyHeld, autonomyPermitted, holdAutonomyOff, holdUntilSealed, modeAgreed, modeInForce, modeWithoutHold, releaseAutonomyHold, type ApprovalsSetting, type AutonomyAdmin } from "./autonomy";
import type { AuditEntry } from "./audit";
import type { ModeSealStore } from "./mode-seal";

type Card = ApprovalsSetting["consent"][ApprovalMode];
const sameCard = (a: Card | undefined, b: Card | undefined): boolean => !!a && !!b && a.version === b.version && a.at === b.at;
/** Does `now` hold an agreement to a card that `before` didn't hold just so? */
const newAgreement = (before: ApprovalsSetting | null, now: ApprovalsSetting): boolean =>
  APPROVAL_MODES.some(m => now.consent[m].version > 0 && !sameCard(now.consent[m], before?.consent[m]));
/** Does the file claim a mode above Interactive, or the agreement to Assisted's or Autopilot's card? Then the seal is read. */
const claimsAboveInteractive = (s: ApprovalsSetting): boolean => modeRank(s.mode) > modeRank("interactive") || s.consent.assisted.version > 0 || s.consent.autopilot.version > 0;

/**
 * What of settings.json's setting is taken at start, given the seal (null: none, or unreadable): Assisted's and
 * Autopilot's agreements only as sealed, and the mode chosen no higher than the sealed one (Interactive without a
 * seal). Interactive's own agreement is the file's, as every other card's is.
 */
export function trustedAtStart(own: ApprovalsSetting, sealed: ApprovalsSetting | null): ApprovalsSetting {
  const consent = { ...own.consent };
  for (const m of ["assisted", "autopilot"] as const) if (consent[m].version > 0 && !sameCard(consent[m], sealed?.consent[m])) consent[m] = { version: 0, at: null };
  const top: ApprovalMode = sealed?.mode ?? "interactive";
  return { mode: modeRank(own.mode) > modeRank(top) ? top : own.mode, consent };
}

/**
 * How the mode came to change: Home's choice, the host's voice or typed intent (`verified`: Voice Match verified the
 * voice), a settings.json changed outside Ember (`file`), or the organisation's policy changing while Ember ran.
 */
export interface ModeChange { via: "home" | "voice" | "typed" | "file" | "policy"; verified: boolean }

/** An `autonomy` audit entry: the mode now in force, the one before, and how. `atStart`: as found in force at start. */
interface ModeEntry { mode: ModeInForce; before?: ModeInForce; via: ModeChange["via"]; verified: boolean; atStart?: true }

/** The parts of the settings store and the log the record uses. */
export interface ModeRecordDeps {
  settings: {
    /** The user's own settings, without the administrator's policy. */
    own(): { approvals: ApprovalsSetting };
    update(patch: { approvals: ApprovalsSetting }): unknown;
    onChange(fn: () => void): unknown;
  };
  /** The keyring's seal of the setting as Ember last recorded it (mode-seal.ts). Without one, the file is taken as it is. */
  seal?: ModeSealStore;
  /** The policy in force now (it may change while Ember runs: the held lockdown). */
  admin: () => AutonomyAdmin | null;
  /** What `notes` says changed (a seal not kept, a start that put the mode back): Home is told again. */
  onNotes?: () => void;
  log: { info(event: string, fields?: Record<string, unknown>): void; warn(event: string, fields?: Record<string, unknown>): void };
}

export class ModeRecord {
  /** The mode in force as last recorded: what a change is measured against. */
  private recorded: ModeInForce;
  /** The user's setting that gave it: what a change that can't be recorded goes back to. Null: nothing recorded to go back to. */
  private good: ApprovalsSetting | null;
  /** The setting as last looked at, to tell a new choice from any other settings change. */
  private seen: string;
  private how: ModeChange | null = null;
  private audit: { write(e: AuditEntry): void } | null = null;
  /** Changes to a mode that asks more, made before the audit log was opened: written once it is. */
  private waiting: ModeEntry[] = [];
  /** The record is putting the setting back: that change needs no entry of its own. */
  private undoing = false;
  /** The setting as Ember itself last changed it this run: newer than the seal read at start. */
  private mine: ApprovalsSetting | null = null;
  /** Settles once the seal has been read at start and the setting made to agree with it. */
  readonly sealed: Promise<void>;
  /** The last seal Ember wrote couldn't be kept, and why (reliability-r10-1). */
  private notKept: SealTrouble | null = null;
  /** This start put the mode chosen back, and why: said until a mode is chosen again (reliability-r10-1). */
  private startedLower: NonNullable<SealNotes["started"]> | null = null;

  constructor(private d: ModeRecordDeps) {
    const own = d.settings.own().approvals;
    const seal = d.seal;
    // At most Interactive until the seal says Ember recorded more itself.
    const check = !!seal && claimsAboveInteractive(own);
    if (check) holdUntilSealed(true);
    this.recorded = modeInForce(own, d.admin());
    this.good = own;
    this.seen = JSON.stringify(own);
    d.settings.onChange(() => this.changed());
    this.sealed = check && seal
      ? seal.read().catch(() => null).then(async s => this.unseal(s, s || (await seal.available?.().catch(() => false)) !== false ? "unconfirmed" : "keyring"))
      : Promise.resolve();
  }

  /**
   * What Home is told of the seal (reliability-r10-1): that a mode above Interactive lasts until Ember closes because
   * it couldn't be sealed, and that this start put the mode chosen back. The agreement is never kept less safely to
   * spare the user this: falling back is right, silently is not.
   */
  notes(): SealNotes {
    return { ...(this.notKept ? { kept: this.notKept } : {}), ...(this.startedLower ? { started: this.startedLower } : {}) };
  }

  /**
   * Runs `change` (a settings update) as `how`'s: the entry of a mode it changes says so. A change nobody marked is the
   * file's.
   */
  as<T>(how: ModeChange, change: () => T): T {
    this.how = how;
    try { return change(); } finally { this.how = null; this.sealMine(how); }
  }

  /** After a change Ember made itself, the setting as it now stands (recorded, or put back) is sealed for the next start. */
  private sealMine(how: ModeChange): void {
    if (!this.d.seal || how.via === "file" || how.via === "policy" || autonomyHeld()) return;
    const own = this.d.settings.own().approvals;
    this.mine = own;
    // A mode chosen again: what was said of the start no longer holds.
    if (this.startedLower && (how.via === "home" || how.via === "voice" || how.via === "typed")) { this.startedLower = null; this.d.onNotes?.(); }
    const seal = this.d.seal;
    void seal.write(own).then(async kept => {
      if (!kept) this.d.log.warn("autonomy.seal_not_kept", {});
      // Only the newest choice's outcome is said, and only while it holds something above Interactive to keep.
      if (this.mine !== own) return;
      const was = this.notKept;
      this.notKept = kept || !claimsAboveInteractive(own) ? null : (await seal.available?.().catch(() => false)) === false ? "keyring" : "save";
      if (this.notKept !== was) this.d.onNotes?.();
    });
  }

  /**
   * The seal is read (null: none, or unreadable): settings.json's setting is made to agree with it (trustedAtStart),
   * and the mode it then gives is in force, recorded as found at start.
   */
  private unseal(sealed: ApprovalsSetting | null, why: "keyring" | "unconfirmed"): void {
    const own = this.d.settings.own().approvals;
    const want = trustedAtStart(own, this.mine ?? sealed);
    if (JSON.stringify(want) !== JSON.stringify(own)) {
      this.d.log.warn("autonomy.unsealed", { chosen: own.mode, kept: want.mode });
      if (modeRank(want.mode) < modeRank(own.mode)) { this.startedLower = { chosen: own.mode, why }; this.d.onNotes?.(); }
      try {
        this.undoing = true;
        try { this.d.settings.update({ approvals: want }); } finally { this.undoing = false; }
        if (JSON.stringify(this.d.settings.own().approvals) !== JSON.stringify(want)) throw new Error("the setting couldn't be put right");
      } catch (err) {
        this.d.log.warn("autonomy.off_not_saved", { err });
        holdAutonomyOff();
      }
    }
    const now = this.d.settings.own().approvals;
    this.seen = JSON.stringify(now);
    this.good = now;
    holdUntilSealed(false);
    const mode = modeInForce(now, this.d.admin());
    const before = this.recorded;
    if (mode === before) return;
    if (!this.audit) { this.recorded = mode; return; }
    try {
      this.audit.write({ event: "autonomy", mode, before, via: "file", verified: false, atStart: true });
      this.recorded = mode;
    } catch (err) {
      this.d.log.warn("autonomy.audit_failed", { err });
      if (modeRank(mode) > modeRank(before)) { this.good = null; holdAutonomyOff(); } else this.recorded = mode;
    }
  }

  /** The audit log is open: what waited for it is written, and the mode found in force at start is recorded, or isn't in force. */
  opened(audit: { write(e: AuditEntry): void }): void {
    this.audit = audit;
    for (const e of this.waiting.splice(0)) { try { audit.write({ event: "autonomy", ...e }); } catch (err) { this.d.log.warn("autonomy.audit_failed", { err }); } }
    if (this.recorded === "asking") return;
    // As found in settings.json at start (by hand, or from the last run): recorded, or else not in force (fail closed).
    // The user's choice and cards stay in their file: choosing again records it.
    try { audit.write({ event: "autonomy", mode: this.recorded, via: "file", verified: false, atStart: true }); } catch (err) {
      this.d.log.warn("autonomy.audit_failed", { err });
      this.recorded = "asking";
      this.good = null;
      holdAutonomyOff();
    }
  }

  /**
   * The settings changed, or the policy did (`how`): the mode they give now is recorded, or, asking less and not
   * recorded, isn't taken.
   */
  changed(how?: ModeChange): void {
    if (this.undoing) return;
    // Whoever marked a change takes it with them, whether or not it changed anything (review of #127).
    const chosen = how ?? this.how;
    const by = chosen ?? { via: "file" as const, verified: false };
    this.how = null;
    const own = this.d.settings.own().approvals;
    const now = JSON.stringify(own);
    // Nobody chose anything and the setting reads as it did: some other setting changed.
    const same = !chosen && now === this.seen;
    this.seen = now;
    const mode = modeWithoutHold(own, this.d.admin());
    const before = this.recorded;
    const up = modeRank(mode) > modeRank(before);
    // settings.json changed outside Ember while it runs never raises the mode nor agrees to a card: a program that edited
    // the file, a text editor a worker drives included, could forge the agreement too (modes-x9s-2, modes-x9p-5). Put
    // back, as a change that can't be recorded is; Home's choice and the host's intents, which Ember marks itself, are how
    // it is raised.
    if (by.via === "file" && !same && (up || newAgreement(this.good, own))) {
      this.d.log.warn("autonomy.raised_by_file", { before, mode });
      this.undo();
      return;
    }
    // No higher than what is recorded: the hold has done its work, and a later move up is audited afresh.
    if (!up) releaseAutonomyHold();
    // Held, and the setting is still the one that couldn't be recorded: it stays held until the choice is made again.
    else if (autonomyHeld() && same) return;
    if (mode === before) { this.good = own; return; }
    const entry: ModeEntry = { mode, before, via: by.via, verified: by.verified };
    try {
      // No audit log yet: a mode that asks less is refused (it can't be recorded), one that asks more is kept for the log.
      if (!this.audit) { if (up) throw new Error("the audit log isn't open yet"); this.waiting.push(entry); } else this.audit.write({ event: "autonomy", ...entry });
    } catch (err) {
      this.d.log.warn("autonomy.audit_failed", { err });
      // Not recorded: a mode that asks less isn't taken (fail closed); one that asks more stands.
      if (up) this.undo(); else { this.recorded = mode; this.good = own; }
      return;
    }
    this.recorded = mode;
    this.good = own;
    releaseAutonomyHold();
    this.d.log.info("autonomy.changed", { mode, before, via: by.via });
  }

  /** Puts the user's setting back as it was last recorded; where that can't be done, holds Ember below Interactive. */
  private undo(): void {
    try {
      if (!this.good) throw new Error("no recorded setting to go back to");
      this.undoing = true;
      try { this.d.settings.update({ approvals: this.good }); } finally { this.undoing = false; }
      const own = this.d.settings.own().approvals;
      this.seen = JSON.stringify(own);
      if (modeRank(modeWithoutHold(own, this.d.admin())) > modeRank(this.recorded)) throw new Error("the setting put back still asks less");
    } catch (err) {
      holdAutonomyOff();
      this.d.log.warn("autonomy.off_not_saved", { err });
    }
  }
}

/** No card agreed to: what "ask me first again" leaves, so a card is read again before any mode is in force. */
const WITHDRAWN: ApprovalsSetting = { mode: "interactive", consent: { interactive: { version: 0, at: null }, assisted: { version: 0, at: null }, autopilot: { version: 0, at: null } } };

/**
 * What the host's mode intents do to the setting (agent/autonomy-intent.ts plans them, and says each reply): a mode
 * named is chosen as it is in Home, but only ever with its card already agreed to there (a switch can't agree to a
 * card); "asking" (ask me first again) takes Ember below Interactive by withdrawing every card's agreement. Built on
 * the user's own setting, never the one with the policy applied. `voiceMatch`: main's Voice Match switch, for the plan.
 */
export function modeIntents(o: { settings: ModeRecordDeps["settings"]; modes: ModeRecord; admin: () => AutonomyAdmin | null; voiceMatch: () => "off" | "on" | "unready" }): {
  state(): { inForce: ModeInForce; agreed: ApprovalMode[]; managed: boolean; cap: ApprovalMode | null; checkOff: boolean; voiceMatch: "off" | "on" | "unready" };
  /**
   * True once it is as asked and recorded: the mode asked for is in force, or, for a mode that asks more, one that asks
   * at least as much. A mode that asks less whose audit entry can't be written is undone: say so, not "Okay".
   */
  set(to: ApprovalMode | "asking", how: { via: "voice" | "typed"; verified: boolean }): boolean;
} {
  const inForce = () => modeInForce(o.settings.own().approvals, o.admin());
  return {
    state: () => {
      const own = o.settings.own().approvals;
      const admin = o.admin();
      return {
        inForce: inForce(), agreed: APPROVAL_MODES.filter(m => modeAgreed(own, m)), managed: !autonomyPermitted(admin),
        cap: admin?.approvals?.maxMode ?? null, checkOff: admin?.features.aiReview === false, voiceMatch: o.voiceMatch(),
      };
    },
    set: (to, how) => {
      const before = inForce();
      const own = o.settings.own().approvals;
      // Never a card's agreement: only the mode, so a mode whose card isn't agreed to can't come into force this way.
      o.modes.as(how, () => o.settings.update({ approvals: to === "asking" ? WITHDRAWN : { ...own, mode: to } }));
      const after = inForce();
      return to === "asking" ? after === "asking" : modeRank(to) > modeRank(before) ? after === to : modeRank(after) <= modeRank(to);
    },
  };
}
