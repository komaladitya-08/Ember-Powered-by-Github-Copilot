/**
 * Without a keyring Ember can use (safeStorage's `basic_text`, or none), an Assisted or Autopilot choice can't be kept
 * safely, so it lasts until Ember closes and the next start falls back to Interactive (reliability-r10-1). That
 * fallback is right, but it was silent: Home said "Autopilot is on" with no word that it wouldn't last, and after the
 * restart nothing said why the choice had gone. Home now says both, plainly, and the agreement is still never kept
 * less safely than the keyring's seal.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_SETTINGS, SettingsStore } from "../../app/main/settings";
import { AuditLog } from "../../app/main/policy/audit";
import { approvalsState, modeInForce, releaseAutonomyHold, type ApprovalsSetting } from "../../app/main/policy/autonomy";
import { ModeRecord } from "../../app/main/policy/mode-record";
import { ModeSeal, type ModeSealStore } from "../../app/main/policy/mode-seal";
import { modeCardVersion } from "../../app/shared/approvals";
import { approvalsNote } from "../../app/renderer/home/copy";

const dirs: string[] = [];
afterEach(() => { releaseAutonomyHold(); for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const AT = "2026-11-12T10:00:00.000Z";
const NONE = { version: 0, at: null };
const INTERACTIVE: ApprovalsSetting = { mode: "interactive", consent: { interactive: { version: modeCardVersion("interactive"), at: AT }, assisted: NONE, autopilot: NONE } };
const AUTOPILOT: ApprovalsSetting = { mode: "autopilot", consent: { ...INTERACTIVE.consent, autopilot: { version: modeCardVersion("autopilot"), at: AT } } };
const base = { ...DEFAULT_SETTINGS, consent: { version: 99, at: "t" }, onboarded: true };
const quiet = { info: () => {}, warn: () => {} };
/** Electron's safeStorage on a session with no Secret Service. */
const noKeyring = { isEncryptionAvailable: () => true, getSelectedStorageBackend: () => "basic_text", encryptString: (t: string) => Buffer.from(t), decryptString: (b: Buffer) => b.toString() };

function start(dir: string, approvals: ApprovalsSetting | null, seal: ModeSealStore) {
  const file = path.join(dir, "settings.json");
  if (approvals) fs.writeFileSync(file, JSON.stringify({ ...base, approvals }));
  const settings = new SettingsStore(file); settings.load();
  let told = 0;
  const record = new ModeRecord({ settings, admin: () => null, log: quiet, seal, onNotes: () => { told++; } });
  record.opened(new AuditLog(path.join(dir, "audit")));
  const state = () => approvalsState(settings.own().approvals, null, record.notes());
  return { settings, record, state, told: () => told };
}
const settle = () => new Promise(r => setTimeout(r, 20));

describe("an approval mode that can't be kept on this computer (reliability-r10-1)", () => {
  it("says, as Autopilot is chosen without a keyring, that it lasts until Ember closes (reliability-r10-1)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mode-notice-")); dirs.push(dir);
    const seal = new ModeSeal(path.join(dir, "approvals-seal.bin"), noKeyring);
    const c = start(dir, INTERACTIVE, seal);
    await c.record.sealed;
    c.record.as({ via: "home", verified: false }, () => c.settings.update({ approvals: AUTOPILOT }));
    await settle();
    expect(c.told()).toBeGreaterThan(0);
    const state = c.state();
    expect(state.inForce).toBe("autopilot");
    expect(state.kept).toBe("keyring");
    expect(approvalsNote(state, false)).toContain("Autopilot lasts until Ember closes: this computer has no keyring Ember can use to keep it safely, so Ember starts in Interactive next time.");
    // Back to Interactive, nothing more needs keeping: the line goes.
    c.record.as({ via: "home", verified: false }, () => c.settings.update({ approvals: INTERACTIVE }));
    await settle();
    expect(c.state().kept).toBeUndefined();
  });

  it("says once at the next start that the choice couldn't be kept, and falls back to Interactive (reliability-r10-1)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mode-notice-")); dirs.push(dir);
    const seal = new ModeSeal(path.join(dir, "approvals-seal.bin"), noKeyring);
    const c = start(dir, AUTOPILOT, seal);
    await c.record.sealed;
    const state = c.state();
    expect(modeInForce(c.settings.own().approvals, null)).toBe("interactive");
    expect(state.started).toEqual({ chosen: "autopilot", why: "keyring" });
    expect(approvalsNote(state, false)).toMatch(/^Your choice of Autopilot couldn't be kept when Ember started, because this computer has no keyring Ember can use, so Interactive is in use\. Choose Autopilot again to use it until Ember closes\. /);
    // The agreement itself is never kept less safely: its card is read again.
    expect(c.settings.own().approvals.consent.autopilot).toEqual(NONE);
    // Choosing again clears what was said about the start.
    c.record.as({ via: "home", verified: false }, () => c.settings.update({ approvals: AUTOPILOT }));
    await settle();
    expect(c.state().started).toBeUndefined();
    expect(c.state().kept).toBe("keyring");
  });

  it("says Ember couldn't confirm a choice whose seal didn't match, as a hand edit would leave (reliability-r10-1)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mode-notice-")); dirs.push(dir);
    const seal: ModeSealStore = { read: async () => INTERACTIVE, write: async () => true, available: async () => true };
    const c = start(dir, AUTOPILOT, seal);
    await c.record.sealed;
    expect(c.state().started).toEqual({ chosen: "autopilot", why: "unconfirmed" });
    expect(approvalsNote(c.state(), false)).toMatch(/^Ember couldn't confirm your choice of Autopilot when it started, so Interactive is in use\. Choose Autopilot again to use it\. /);
  });

  it("says nothing of the kind where the keyring keeps the choice (reliability-r10-1)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mode-notice-")); dirs.push(dir);
    let sealed: ApprovalsSetting | null = null;
    const seal: ModeSealStore = { read: async () => sealed, write: async s => { sealed = s; return true; }, available: async () => true };
    const c = start(dir, INTERACTIVE, seal);
    c.record.as({ via: "home", verified: false }, () => c.settings.update({ approvals: AUTOPILOT }));
    await settle();
    expect(c.state().kept).toBeUndefined();
    const next = start(dir, null, seal);
    await next.record.sealed;
    expect(next.state().inForce).toBe("autopilot");
    expect(next.state().started).toBeUndefined();
  });
});
