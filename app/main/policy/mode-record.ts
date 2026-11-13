/**
 * The record of the approval mode in force (PLAN.md §2 "Approvals"; security review of #127, when it was Work without
 * asking's switch): every change of it is an `autonomy` audit entry that says the mode, the one before and how it
 * changed (Home's choice, a voice or typed intent, the file, or the organisation's policy), and a change to a mode
 * that asks less that can't be recorded isn't made: the user's setting is put back as it was, and where that can't be
 * saved either, Ember is held below Interactive in memory (autonomy.ts holdAutonomyOff; review of PR #193). Nor is a
 * change to Autopilot that came from settings.json while Ember runs: only Ember's own windows choose it. Plain Node:
 * the settings store and the audit log are passed in.
 */

import { APPROVAL_MODES, modeRank, type ApprovalMode, type ModeInForce } from "../../shared/approvals";
import { autonomyHeld, autonomyPermitted, holdAutonomyOff, modeAgreed, modeInForce, modeWithoutHold, releaseAutonomyHold, type ApprovalsSetting, type AutonomyAdmin } from "./autonomy";
import type { AuditEntry } from "./audit";

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
  /** The policy in force now (it may change while Ember runs: the held lockdown). */
  admin: () => AutonomyAdmin | null;
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

  constructor(private d: ModeRecordDeps) {
    const own = d.settings.own().approvals;
    this.recorded = modeInForce(own, d.admin());
    this.good = own;
    this.seen = JSON.stringify(own);
    d.settings.onChange(() => this.changed());
  }

  /**
   * Runs `change` (a settings update) as `how`'s: the entry of a mode it changes says so. A change nobody marked is the
   * file's.
   */
  as<T>(how: ModeChange, change: () => T): T {
    this.how = how;
    try { return change(); } finally { this.how = null; }
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
    // No higher than what is recorded: the hold has done its work, and a later move up is audited afresh.
    if (!up) releaseAutonomyHold();
    // Held, and the setting is still the one that couldn't be recorded: it stays held until the choice is made again.
    else if (autonomyHeld() && same) return;
    if (mode === before) { this.good = own; return; }
    // Autopilot is never chosen without its card: a settings.json changed outside Ember while it runs can't put it in
    // force (a model that edited the file through an app could forge the agreement too). Put back, as a change that
    // can't be recorded is; Home's choice and the host's intents, which Ember marks itself, are how it is chosen.
    if (up && mode === "autopilot" && by.via === "file") {
      this.d.log.warn("autonomy.autopilot_by_file", { before });
      this.undo();
      return;
    }
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
