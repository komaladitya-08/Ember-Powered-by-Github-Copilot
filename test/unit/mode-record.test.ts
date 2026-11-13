/* eslint-disable @typescript-eslint/no-explicit-any -- fs spies need loose types */
/**
 * The record of the approval mode in force (app/main/policy/mode-record.ts, PLAN.md §2 "Approvals"): every change of
 * it is an `autonomy` audit entry, a change to a mode that asks less that can't be recorded is undone, and when the
 * audit write fails AND putting the setting back fails too (disk full, folder unwritable after a good load), Ember is
 * held below Interactive in memory (review of PR #193, when it was Work without asking's switch). Run against a real
 * SettingsStore and AuditLog.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsStore, DEFAULT_SETTINGS } from "../../app/main/settings";
import { AuditLog } from "../../app/main/policy/audit";
import { autonomyHeld, autonomyInForce, approvalInputs, approvalsState, chooseMode, modeInForce, releaseAutonomyHold, type ApprovalsSetting } from "../../app/main/policy/autonomy";
import { ModeRecord, modeIntents } from "../../app/main/policy/mode-record";
import { AdminPolicySchema, heldUntilRestart } from "../../app/main/admin";
import { modeCardVersion } from "../../app/shared/approvals";
import { PolicyEngine } from "../../app/main/policy/policy";
import { describeEntry } from "../../app/renderer/home/copy";

const main = fs.readFileSync("app/main/main.ts", "utf8");
const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); releaseAutonomyHold(); for (const d of dirs.splice(0)) { try { fs.chmodSync(d, 0o700); fs.chmodSync(path.join(d, "audit"), 0o700); } catch { /* gone */ } } });

const AT = "2026-11-12T10:00:00.000Z";
const NONE = { version: 0, at: null };
const ASKING: ApprovalsSetting = DEFAULT_SETTINGS.approvals;
const INTERACTIVE: ApprovalsSetting = { mode: "interactive", consent: { interactive: { version: modeCardVersion("interactive"), at: AT }, assisted: NONE, autopilot: NONE } };
const ASSISTED: ApprovalsSetting = { mode: "assisted", consent: { ...INTERACTIVE.consent, assisted: { version: modeCardVersion("assisted"), at: AT } } };
const base = { ...DEFAULT_SETTINGS, consent: { version: 99, at: "t" }, onboarded: true };
const quiet = { info: () => {}, warn: () => {} };

function setup(approvals: ApprovalsSetting, o: { open?: boolean } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mode-record-")); dirs.push(dir);
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ ...base, approvals }));
  const settings = new SettingsStore(file); settings.load();
  const audit = new AuditLog(path.join(dir, "audit"));
  let policy: ReturnType<typeof AdminPolicySchema.parse> | null = null;
  const record = new ModeRecord({ settings, admin: () => policy, log: quiet });
  if (o.open !== false) record.opened(audit);
  /** The `autonomy` entries written so far, oldest first, without their times. */
  const entries = () => audit.recent(100).filter(e => e.event === "autonomy").reverse().map(({ t: _t, event: _e, ...rest }) => rest);
  const inForce = () => modeInForce(settings.get().approvals, policy);
  return { dir, file, settings, audit, record, entries, inForce, setPolicy: (p: typeof policy) => { policy = p; }, policy: () => policy };
}
/** Makes the audit file unwritable, and settings.json too unless `auditOnly`. */
function breakStorage(fault: "ENOSPC" | "permissions", ctx: { dir: string; file: string; audit: AuditLog }, auditOnly = false) {
  if (fault === "permissions") {
    if (!auditOnly) fs.chmodSync(ctx.dir, 0o500);
    fs.chmodSync(path.join(ctx.dir, "audit"), 0o500);
    // A read-only folder stops a new audit file, not an append to one an earlier entry made: that file must refuse it too
    // (CI's non-root run of #212: the second change was recorded, so it stood).
    if (fs.existsSync(ctx.audit.file)) fs.chmodSync(ctx.audit.file, 0o400);
    return;
  }
  const append = fs.appendFileSync, open = fs.openSync;
  const full = () => Object.assign(new Error("disk full"), { code: "ENOSPC" });
  vi.spyOn(fs, "appendFileSync").mockImplementation(((f: any, ...a: any[]) => { if (String(f) === ctx.audit.file) throw full(); return (append as any)(f, ...a); }) as any);
  if (!auditOnly) vi.spyOn(fs, "openSync").mockImplementation(((f: any, ...a: any[]) => { if (String(f).startsWith(`${ctx.file}.tmp-`)) throw full(); return (open as any)(f, ...a); }) as any);
}
const mend = (ctx: { dir: string; audit: AuditLog }) => {
  vi.restoreAllMocks();
  try { fs.chmodSync(ctx.dir, 0o700); fs.chmodSync(path.join(ctx.dir, "audit"), 0o700); if (fs.existsSync(ctx.audit.file)) fs.chmodSync(ctx.audit.file, 0o600); } catch { /* as it was */ }
};
const engineFor = (c: { settings: SettingsStore; policy: () => any }) => new PolicyEngine({ neverLook: () => [], grants: () => ({}), autonomy: () => autonomyInForce(c.settings.get().approvals, c.policy()) });
const click = { taskId: "t", kind: "click" as const, app: "mousepad", window: "notes", element: { role: "push button", name: "Bold" } };

// Real permissions need POSIX modes and a non-root user (Windows and root ignore chmod); the injected ENOSPC faults run on
// every OS and exercise the same failing writes.
const canChmod = process.platform !== "win32" && process.getuid?.() !== 0;
const FAULTS = canChmod ? (["ENOSPC", "permissions"] as const) : (["ENOSPC"] as const);

const AUTOPILOT: ApprovalsSetting = { mode: "autopilot", consent: { ...ASSISTED.consent, autopilot: { version: modeCardVersion("autopilot"), at: AT } } };

describe("Autopilot and the record (modes-D5)", () => {
  it("is recorded as every change of the mode is when Home chooses it, and when the user goes back", () => {
    const c = setup(INTERACTIVE);
    c.record.as({ via: "home", verified: false }, () => c.settings.update({ approvals: AUTOPILOT }));
    expect(c.inForce()).toBe("autopilot");
    c.record.as({ via: "home", verified: false }, () => c.settings.update({ approvals: INTERACTIVE }));
    expect(c.entries().slice(1)).toEqual([
      { mode: "autopilot", before: "interactive", via: "home", verified: false },
      { mode: "interactive", before: "autopilot", via: "home", verified: false },
    ]);
    expect(describeEntry({ t: AT, event: "autonomy", mode: "autopilot", before: "interactive", via: "home" } as never)).toMatchObject({ tag: "Setting", what: "How Ember asks: Autopilot" });
  });

  it("is never chosen by a settings.json changed outside Ember while it runs: the file is put back, and nothing is in force that wasn't", () => {
    for (const from of [ASKING, INTERACTIVE, ASSISTED]) {
      const c = setup(from);
      const before = c.inForce();
      const written = c.entries().length;
      // By hand, or by a program that edited the file: the mode and its card's agreement, both forged.
      fs.writeFileSync(c.file, JSON.stringify({ ...base, approvals: AUTOPILOT }));
      expect(c.settings.reloadIfChanged()).toBe(true);
      expect(c.inForce()).toBe(before);
      expect(c.settings.own().approvals).toEqual(from);
      expect(JSON.parse(fs.readFileSync(c.file, "utf8")).approvals).toEqual(from);
      expect(c.entries()).toHaveLength(written);
      expect(autonomyHeld()).toBe(false);
      // Home's own choice still works afterwards.
      c.record.as({ via: "home", verified: false }, () => c.settings.update({ approvals: AUTOPILOT }));
      expect(c.inForce()).toBe("autopilot");
    }
    // A file edit to a mode below it is taken as before (the file's, recorded), and one that asks more always is.
    const c = setup(ASKING);
    fs.writeFileSync(c.file, JSON.stringify({ ...base, approvals: ASSISTED }));
    c.settings.reloadIfChanged();
    expect(c.inForce()).toBe("assisted");
    const down = setup(AUTOPILOT);
    expect(down.inForce()).toBe("autopilot");
    fs.writeFileSync(down.file, JSON.stringify({ ...base, approvals: INTERACTIVE }));
    down.settings.reloadIfChanged();
    expect(down.inForce()).toBe("interactive");
    expect(down.entries().at(-1)).toEqual({ mode: "interactive", before: "autopilot", via: "file", verified: false });
  });

  it("is held below Interactive where the file can't be put back either", () => {
    const c = setup(INTERACTIVE);
    fs.writeFileSync(c.file, JSON.stringify({ ...base, approvals: AUTOPILOT }));
    breakStorage("ENOSPC", c);
    expect(c.settings.reloadIfChanged()).toBe(true);
    expect(c.inForce()).toBe("asking");
    expect(autonomyHeld()).toBe(true);
    mend(c);
  });

  it("is what the organisation's policy and the kept record let it be when Ember starts with it chosen", () => {
    const c = setup(AUTOPILOT);
    expect(c.entries()).toEqual([{ mode: "autopilot", via: "file", verified: false, atStart: true }]);
    c.setPolicy(AdminPolicySchema.parse({ approvals: { maxMode: "interactive" } }));
    c.record.changed({ via: "policy", verified: false });
    expect(c.inForce()).toBe("interactive");
    expect(c.entries().at(-1)).toEqual({ mode: "interactive", before: "autopilot", via: "policy", verified: false });
  });
});

describe("the record of the mode in force (modes-A7)", () => {
  it("writes an entry for every change of the mode in force: the mode, the one before, how, and whether the voice was verified", () => {
    const c = setup(ASKING);
    expect(c.entries()).toEqual([]);
    c.record.as({ via: "home", verified: false }, () => c.settings.update({ approvals: INTERACTIVE }));
    expect(c.inForce()).toBe("interactive");
    c.record.as({ via: "voice", verified: true }, () => c.settings.update({ approvals: ASSISTED }));
    c.record.as({ via: "typed", verified: false }, () => c.settings.update({ approvals: ASKING }));
    // By hand, while Ember runs: the file's.
    fs.writeFileSync(c.file, JSON.stringify({ ...base, approvals: INTERACTIVE }));
    expect(c.settings.reloadIfChanged()).toBe(true);
    expect(c.entries()).toEqual([
      { mode: "interactive", before: "asking", via: "home", verified: false },
      { mode: "assisted", before: "interactive", via: "voice", verified: true },
      { mode: "asking", before: "assisted", via: "typed", verified: false },
      { mode: "interactive", before: "asking", via: "file", verified: false },
    ]);
  });

  it("writes nothing for a change that leaves the mode in force as it was, and whoever marked it takes the mark with them", () => {
    const c = setup(INTERACTIVE);
    const start = c.entries();
    expect(start).toEqual([{ mode: "interactive", via: "file", verified: false, atStart: true }]);
    c.settings.update({ size: 70 });
    // Agreed to again (the same mode, a newer agreement), and a chosen mode that isn't in force (its card not agreed to).
    c.record.as({ via: "home", verified: false }, () => c.settings.update({ approvals: { ...INTERACTIVE, consent: { ...INTERACTIVE.consent, interactive: { version: modeCardVersion("interactive"), at: "2026-11-13T09:00:00.000Z" } } } }));
    c.record.as({ via: "voice", verified: true }, () => c.settings.update({ approvals: { ...INTERACTIVE, mode: "assisted" } }));
    expect(c.entries()).toEqual(start);
    // The mark never leaks into a later change nobody marked.
    c.settings.update({ approvals: ASKING });
    expect(c.entries().at(-1)).toEqual({ mode: "asking", before: "interactive", via: "file", verified: false });
  });

  it("records the organisation's policy changing while Ember runs: held locked down, Ember is below Interactive", () => {
    const c = setup(INTERACTIVE);
    c.setPolicy(heldUntilRestart({ policy: AdminPolicySchema.parse({}), source: "/etc/ember/policy.json" }).policy);
    c.record.changed({ via: "policy", verified: false });
    expect(c.inForce()).toBe("asking");
    expect(c.entries().at(-1)).toEqual({ mode: "asking", before: "interactive", via: "policy", verified: false });
    expect(main).toContain(`modes.changed({ via: "policy", verified: false });`);
  });

  it("before the audit log is open: a mode that asks more waits for it, a mode that asks less isn't taken", () => {
    const up = setup(ASKING, { open: false });
    up.record.as({ via: "home", verified: false }, () => up.settings.update({ approvals: INTERACTIVE }));
    expect(up.settings.own().approvals).toEqual(ASKING);
    expect(up.inForce()).toBe("asking");
    up.record.opened(up.audit);
    expect(up.entries()).toEqual([]);

    const down = setup(INTERACTIVE, { open: false });
    down.record.as({ via: "typed", verified: false }, () => down.settings.update({ approvals: ASKING }));
    expect(down.inForce()).toBe("asking");
    down.record.opened(down.audit);
    expect(down.entries()).toEqual([{ mode: "asking", before: "interactive", via: "typed", verified: false }]);
  });

  it("is what main wires: one record, opened with the audit log, and every policy engine's inputs read through the mode in force", () => {
    expect(main).toContain("const modes = new ModeRecord({ settings, admin: () => policy, log });");
    expect(main).toContain("    modes.opened(audit);");
    expect(main).toContain("const approvalsNow = () => approvalInputs(modeInForce(settings.get().approvals, policy));");
    expect(main).toContain("trustAskedApps: () => approvalsNow().askedApps,");
    expect(main).toContain("autonomy: () => approvalsNow().scopes,");
    expect(main).not.toMatch(/settings\.get\(\)\.(trust|autonomy)\b/);
    const host = fs.readFileSync("app/main/agent/host.ts", "utf8");
    expect(main).toContain("assisted: () => approvalsNow().check,");
    expect(host).toContain("check: () => approvalInputs(modeInForce(this.o.settings.get().approvals, this.o.admin?.() ?? null)).check,");
    expect(host).toContain("autonomy: () => approvalInputs(modeInForce(this.o.settings.get().approvals, this.o.admin?.() ?? null)).scopes,");
    expect(fs.readFileSync("app/main/targets/runtime.ts", "utf8")).toContain("trustAskedApps: () => approvalInputs(modeInForce(settings.get().approvals, admin().policy)).askedApps,");
    expect(approvalInputs("interactive").check).toBe(false);
  });
});

describe.each(FAULTS)("a mode that asks less whose entry can't be written (%s)", fault => {
  it("is undone: the user's setting is put back as it was, and the mode in force stays (modes-A7)", () => {
    const c = setup(ASKING);
    breakStorage(fault, c, true);
    c.record.as({ via: "home", verified: false }, () => c.settings.update({ approvals: INTERACTIVE }));
    expect(c.settings.own().approvals).toEqual(ASKING);
    expect(JSON.parse(fs.readFileSync(c.file, "utf8")).approvals).toEqual(ASKING);
    expect(c.inForce()).toBe("asking");
    expect(autonomyHeld()).toBe(false);
    // From Interactive to Assisted: back to Interactive, not below it.
    mend(c);
    c.record.as({ via: "home", verified: false }, () => c.settings.update({ approvals: INTERACTIVE }));
    breakStorage(fault, c, true);
    c.record.as({ via: "home", verified: false }, () => c.settings.update({ approvals: ASSISTED }));
    expect(c.settings.own().approvals).toEqual(INTERACTIVE);
    expect(c.inForce()).toBe("interactive");
    mend(c);
    expect(c.entries()).toEqual([{ mode: "interactive", before: "asking", via: "home", verified: false }]);
  });

  it("stands when it asks more: a mode that asks more is never refused for want of a record", () => {
    const c = setup(INTERACTIVE);
    breakStorage(fault, c, true);
    c.record.as({ via: "typed", verified: false }, () => c.settings.update({ approvals: ASKING }));
    expect(c.settings.own().approvals).toEqual(ASKING);
    expect(c.inForce()).toBe("asking");
  });

  it("found in force at start: nothing is done without asking, and the user's file is left as it is (PR #193 review, startup)", () => {
    const c = setup(INTERACTIVE, { open: false });
    breakStorage(fault, c);
    c.record.opened(c.audit);
    expect(autonomyHeld()).toBe(true);
    expect(c.inForce()).toBe("asking");
    expect(engineFor(c).decide(click).autonomy).not.toBe(true);
    expect(approvalsState(c.settings.own().approvals, null)).toMatchObject({ inForce: "asking", why: "not-recorded" });
    mend(c);
    expect(JSON.parse(fs.readFileSync(c.file, "utf8")).approvals).toEqual(INTERACTIVE);
    // Some other setting saved later doesn't put it in force: the choice was never recorded.
    c.settings.update({ size: 70 });
    expect(c.inForce()).toBe("asking");
    // Choosing it again, now that the log can be written, records it and lets the hold go.
    const again = chooseMode(c.settings.own().approvals, "interactive", modeCardVersion("interactive"), null, "2026-11-13T09:00:00.000Z");
    expect(again.ok).toBe(true);
    if (again.ok) c.record.as({ via: "home", verified: false }, () => c.settings.update({ approvals: again.approvals }));
    expect(autonomyHeld()).toBe(false);
    expect(c.inForce()).toBe("interactive");
    expect(c.entries()).toEqual([{ mode: "interactive", before: "asking", via: "home", verified: false }]);
  });

  it("chosen: it isn't in force when it can be neither recorded nor put back (PR #193 review, a change)", () => {
    const c = setup(ASKING);
    breakStorage(fault, c);
    // The choice itself can't be saved either under these faults; the setting arrives as a hand edit would.
    if (fault === "permissions") { fs.chmodSync(c.dir, 0o700); fs.writeFileSync(c.file, JSON.stringify({ ...base, approvals: INTERACTIVE })); fs.chmodSync(c.dir, 0o500); }
    else fs.writeFileSync(c.file, JSON.stringify({ ...base, approvals: INTERACTIVE }));
    try { c.settings.reloadIfChanged(); } catch { /* the listener's failure is the caller's */ }
    expect(c.settings.get().approvals).toEqual(INTERACTIVE); // memory says Interactive (the file was edited) ...
    expect(autonomyHeld()).toBe(true);
    expect(c.inForce()).toBe("asking"); // ... and it is not in force
    expect(engineFor(c).decide(click).autonomy).not.toBe(true);
    // Seen below Interactive again (the file edited back): the hold has done its work, and a later choice is audited afresh.
    mend(c);
    fs.writeFileSync(c.file, JSON.stringify({ ...base, approvals: ASKING, size: 61 }));
    c.settings.reloadIfChanged();
    expect(autonomyHeld()).toBe(false);
    c.record.as({ via: "home", verified: false }, () => c.settings.update({ approvals: INTERACTIVE }));
    expect(c.inForce()).toBe("interactive");
    expect(c.entries()).toEqual([{ mode: "interactive", before: "asking", via: "home", verified: false }]);
  });
});

describe("“work without asking” and “ask me first again” against the mode (modes-A8)", () => {
  const wired = (approvals: ApprovalsSetting) => { const c = setup(approvals); return { ...c, intents: modeIntents({ settings: c.settings, modes: c.record, admin: c.policy }) }; };

  it("says whether a mode is in force, whether Interactive's card is agreed to, and whether the organisation keeps Ember below it", () => {
    expect(wired(ASKING).intents.state()).toEqual({ on: false, consented: false, managed: false });
    expect(wired(INTERACTIVE).intents.state()).toEqual({ on: true, consented: true, managed: false });
    const managed = wired(INTERACTIVE);
    managed.setPolicy(AdminPolicySchema.parse({ features: { autonomy: false } }));
    expect(managed.intents.state()).toEqual({ on: false, consented: true, managed: true });
  });

  it("“ask me first again” takes Ember below Interactive for anyone, by withdrawing the cards' agreement, and says how in the record", () => {
    const c = wired(ASSISTED);
    expect(c.intents.set(false, { via: "voice", verified: false })).toBe(true);
    expect(c.inForce()).toBe("asking");
    expect(c.settings.own().approvals).toEqual(ASKING);
    expect(c.entries().at(-1)).toEqual({ mode: "asking", before: "assisted", via: "voice", verified: false });
    // The way back is the card: nothing is in force, and nothing counts as agreed to.
    expect(c.intents.state()).toEqual({ on: false, consented: false, managed: false });
  });

  it("“work without asking” changes no setting: it only records a mode that is agreed to and couldn't be recorded before", () => {
    const c = wired(INTERACTIVE);
    const before = JSON.stringify(c.settings.own().approvals);
    expect(c.intents.set(true, { via: "typed", verified: false })).toBe(true);
    expect(JSON.stringify(c.settings.own().approvals)).toBe(before);
    // Without its card agreed to it can't put a mode in force, whatever asks.
    const none = wired(ASKING);
    expect(none.intents.set(true, { via: "voice", verified: true })).toBe(false);
    expect(none.inForce()).toBe("asking");
    expect(none.settings.own().approvals).toEqual(ASKING);
    expect(none.entries()).toEqual([]);
  });

  it("is what main gives the host, with the choice opened in Settings at Interactive's row or its card", () => {
    expect(main).toContain("...modeIntents({ settings, modes, admin: () => policy }),");
    expect(main).toContain(`open: consent => { showHome(); sendToHome(IPC.focusSection, consent ? "privacy:autonomy-yes" : "privacy:autonomy-on"); },`);
  });
});

describe("What Ember did for a change of the mode (modes-A7)", () => {
  const t = AT;
  it("says the mode now in force and how it came to change, and still reads entries from before the modes", () => {
    expect(describeEntry({ t, event: "autonomy", mode: "interactive", before: "asking", via: "home", verified: false })).toEqual({ tag: "Setting", cls: "", what: "How Ember asks: Interactive" });
    expect(describeEntry({ t, event: "autonomy", mode: "interactive", via: "file", verified: false, atStart: true })).toEqual({ tag: "Setting", cls: "", what: "How Ember asks: Interactive (as Ember started)" });
    expect(describeEntry({ t, event: "autonomy", mode: "asking", before: "interactive", via: "voice", verified: false })).toEqual({ tag: "Setting", cls: "", what: "How Ember asks: before ordinary steps, as no mode is in use (by voice)" });
    expect(describeEntry({ t, event: "autonomy", mode: "asking", before: "interactive", via: "typed", verified: false })?.what).toBe("How Ember asks: before ordinary steps, as no mode is in use (asked in words)");
    expect(describeEntry({ t, event: "autonomy", mode: "asking", before: "interactive", via: "policy", verified: false })?.what).toBe("How Ember asks: before ordinary steps, as no mode is in use (your organisation's policy changed)");
    expect(describeEntry({ t, event: "autonomy", mode: "assisted", before: "interactive", via: "voice", verified: true })?.what).toBe("How Ember asks: Assisted (by your voice, Voice Match)");
    expect(describeEntry({ t, event: "autonomy", on: true, via: "voice", verified: true })).toEqual({ tag: "Setting", cls: "", what: "Work without asking turned on (by your voice, Voice Match)" });
    expect(describeEntry({ t, event: "autonomy", on: false, via: "home", verified: false })).toEqual({ tag: "Setting", cls: "", what: "Work without asking turned off" });
  });
});

describe("SettingsStore.reloadIfChanged", () => {
  it("sees a hand edit that leaves the modified time exactly as it was (a coarse filesystem clock)", () => {
    const c = setup(ASKING);
    const T = 1_700_000_000; // seconds: the same on both sides, set explicitly so the test never depends on the clock
    fs.utimesSync(c.file, T, T);
    c.settings.reloadIfChanged(); // Ember has seen the file at T
    fs.writeFileSync(c.file, JSON.stringify({ ...base, approvals: INTERACTIVE }));
    fs.utimesSync(c.file, T, T); // the edit lands in the same tick
    expect(fs.statSync(c.file).mtimeMs).toBe(T * 1000);
    expect(c.settings.reloadIfChanged()).toBe(true);
    expect(c.settings.get().approvals.consent.interactive.version).toBe(modeCardVersion("interactive"));
  });
});
