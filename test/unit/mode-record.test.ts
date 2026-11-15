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
import { ModeRecord, modeIntents, trustedAtStart } from "../../app/main/policy/mode-record";
import { ModeSeal, type ModeSealStore } from "../../app/main/policy/mode-seal";
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

function setup(approvals: ApprovalsSetting, o: { open?: boolean; seal?: ModeSealStore } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mode-record-")); dirs.push(dir);
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, JSON.stringify({ ...base, approvals }));
  const settings = new SettingsStore(file); settings.load();
  const audit = new AuditLog(path.join(dir, "audit"));
  let policy: ReturnType<typeof AdminPolicySchema.parse> | null = null;
  const record = new ModeRecord({ settings, admin: () => policy, log: quiet, ...(o.seal ? { seal: o.seal } : {}) });
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
/** Every card agreed to, Interactive chosen. */
const AUTOPILOT_AGREED_INTERACTIVE: ApprovalsSetting = { ...AUTOPILOT, mode: "interactive" };

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
    // A file edit to a mode that asks more is taken (the file's, recorded); none to a mode that asks less is (modes-x9p-5).
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


/** The keyring's seal, in memory: what Ember last sealed, and how often. */
function memorySeal(start: ApprovalsSetting | null = null) {
  let value = start;
  const writes: ApprovalsSetting[] = [];
  const store: ModeSealStore = { read: async () => value, write: async s => { value = s; writes.push(s); return true; } };
  return { store, writes, value: () => value };
}
const FORGED = (v = 99): ApprovalsSetting => ({ mode: "autopilot", consent: { interactive: { version: modeCardVersion("interactive"), at: AT }, assisted: { version: v, at: "x" }, autopilot: { version: v, at: "x" } } });

describe("a settings.json a program wrote (modes-x9s-2, modes-x9p-5)", () => {
  it("never raises the mode while Ember runs, to any mode: the file is put back, and nothing is recorded", () => {
    for (const [from, to] of [[ASKING, INTERACTIVE], [ASKING, ASSISTED], [INTERACTIVE, ASSISTED], [INTERACTIVE, { ...ASSISTED, consent: { ...ASSISTED.consent, assisted: { version: 99, at: "x" } } }], [ASSISTED, AUTOPILOT]] as const) {
      const c = setup(from);
      const before = c.inForce();
      const written = c.entries().length;
      fs.writeFileSync(c.file, JSON.stringify({ ...base, approvals: to }));
      expect(c.settings.reloadIfChanged()).toBe(true);
      expect(c.inForce(), to.mode).toBe(before);
      expect(JSON.parse(fs.readFileSync(c.file, "utf8")).approvals, to.mode).toEqual(from);
      expect(c.entries()).toHaveLength(written);
    }
  });

  it("never agrees to a card while Ember runs, so no switch by voice can use an agreement the file forged", () => {
    const c = setup(INTERACTIVE);
    // The mode stays Interactive; only Autopilot's card is forged.
    fs.writeFileSync(c.file, JSON.stringify({ ...base, approvals: { ...INTERACTIVE, consent: { ...INTERACTIVE.consent, autopilot: { version: modeCardVersion("autopilot"), at: AT } } } }));
    c.settings.reloadIfChanged();
    expect(c.settings.own().approvals).toEqual(INTERACTIVE);
    const intents = modeIntents({ settings: c.settings, modes: c.record, admin: c.policy, voiceMatch: () => "off" });
    expect(intents.state().agreed).toEqual(["interactive"]);
    expect(intents.set("autopilot", { via: "voice", verified: false })).toBe(false);
    expect(c.inForce()).toBe("interactive");
  });

  it("takes a mode above Interactive at start only as Ember sealed it itself: a forged Autopilot starts in Interactive, with its cards withdrawn", async () => {
    const seal = memorySeal(null);
    const c = setup(FORGED(), { seal: seal.store });
    // Until the seal is read, at most Interactive.
    expect(c.inForce()).toBe("interactive");
    await c.record.sealed;
    expect(c.inForce()).toBe("interactive");
    const kept = JSON.parse(fs.readFileSync(c.file, "utf8")).approvals;
    expect(kept).toEqual({ mode: "interactive", consent: { ...FORGED().consent, assisted: NONE, autopilot: NONE } });
    expect(c.entries()).toEqual([{ mode: "interactive", via: "file", verified: false, atStart: true }]);
    // A forged record at the card's exact version and a sealed one of another time don't match either.
    const other = setup({ ...AUTOPILOT }, { seal: memorySeal({ ...AUTOPILOT, consent: { ...AUTOPILOT.consent, autopilot: { version: modeCardVersion("autopilot"), at: "2026-01-01T00:00:00.000Z" } } }).store });
    await other.record.sealed;
    expect(other.inForce()).toBe("assisted");
  });

  it("takes what Home chose at the next start, as sealed then, and records it as found at start", async () => {
    const seal = memorySeal(null);
    const c = setup(INTERACTIVE, { seal: seal.store });
    c.record.as({ via: "home", verified: false }, () => c.settings.update({ approvals: AUTOPILOT }));
    expect(c.inForce()).toBe("autopilot");
    await Promise.resolve();
    expect(seal.value()).toEqual(AUTOPILOT);
    // The next start, with the same file and seal.
    const next = setup(AUTOPILOT, { seal: seal.store });
    expect(next.inForce()).toBe("interactive");
    await next.record.sealed;
    expect(next.inForce()).toBe("autopilot");
    expect(next.entries()).toEqual([{ mode: "interactive", via: "file", verified: false, atStart: true }, { mode: "autopilot", before: "interactive", via: "file", verified: false, atStart: true }]);
    // Going back by voice is sealed too: the file can't bring Autopilot back at the start after.
    next.record.as({ via: "voice", verified: false }, () => next.settings.update({ approvals: { ...AUTOPILOT, mode: "interactive" } }));
    await Promise.resolve();
    expect(trustedAtStart(AUTOPILOT, seal.value())).toEqual({ ...AUTOPILOT, mode: "interactive" });
  });

  it("never acts, in any mode, in an app's window that shows a file in Ember's data folder or the organisation's policy folder", () => {
    const steps = [
      { kind: "text", app: "gedit", window: "settings.json (~/.config/ember) - gedit", element: { role: "text", name: "" }, text: "{}" },
      { kind: "keys", app: "gedit", window: "*settings.json (~/.config/ember) - gedit", element: { role: "text", name: "" }, keys: "ctrl+s" },
      { kind: "click", app: "Files", window: "/home/ana/.config/ember/audit", element: { role: "push button", name: "Move to Trash" } },
      { kind: "text", app: "notepad", window: "settings.json - C:\\Users\\ana\\AppData\\Local\\ember - Notepad++", element: { role: "text", name: "" }, text: "{}" },
      { kind: "text", app: "TextEdit", window: "settings.json — ~/Library/Application Support/ember", element: { role: "text", name: "" }, text: "{}" },
      { kind: "text", app: "gedit", window: "policy.json (/etc/ember) - gedit", element: { role: "text", name: "" }, text: "{}" },
    ];
    for (const inputs of [{}, { autonomy: () => ({ apps: true, commands: true, cursor: true, crossWindow: true }), trustAskedApps: () => true }, { autonomy: () => ({ apps: true, commands: true, cursor: true, crossWindow: true }), autopilot: () => true }]) {
      const engine = new PolicyEngine({ neverLook: () => [], grants: () => ({}), ...inputs });
      for (const step of steps) {
        expect(engine.decide({ taskId: "t", ...step } as never), step.window).toMatchObject({ tier: "never", verdict: "deny" });
      }
    }
    // A file merely called settings.json elsewhere, or a folder called ember outside those, isn't one.
    const engine = new PolicyEngine({ neverLook: () => [], grants: () => ({}) });
    expect(engine.decide({ taskId: "t", kind: "click", app: "nautilus", window: "~/projects/ember", element: { role: "push button", name: "Bold" } } as never).tier).not.toBe("never");
    expect(engine.decide({ taskId: "t", kind: "text", app: "gedit", window: "settings.json (~/proj/.vscode) - gedit", element: { role: "text", name: "" }, text: "{}" } as never).tier).not.toBe("never");
  });

  it("keeps a lower mode or a withdrawn card the file says at start, whatever the seal says", () => {
    expect(trustedAtStart(INTERACTIVE, AUTOPILOT)).toEqual(INTERACTIVE);
    expect(trustedAtStart({ ...AUTOPILOT, mode: "assisted" }, AUTOPILOT)).toEqual({ ...AUTOPILOT, mode: "assisted" });
    expect(trustedAtStart(ASKING, null)).toEqual(ASKING);
    expect(trustedAtStart(INTERACTIVE, null)).toEqual(INTERACTIVE);
  });
});

describe("the keyring's seal of the setting (mode-seal.ts; modes-x9s-2)", () => {
  const box = (backend = "gnome_libsecret") => ({
    isEncryptionAvailable: () => true, getSelectedStorageBackend: () => backend,
    encryptString: (t: string) => Buffer.from(`sealed:${Buffer.from(t).toString("base64")}`),
    decryptString: (b: Buffer) => { const t = b.toString(); if (!t.startsWith("sealed:")) throw new Error("not ours"); return Buffer.from(t.slice(7), "base64").toString(); },
  });
  const dir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "mode-seal-")); dirs.push(d); return d; };

  it("gives back what it sealed, owner-only, and nothing for a file it didn't seal", async () => {
    const file = path.join(dir(), "approvals-seal.bin");
    const s = new ModeSeal(file, box());
    expect(await s.read()).toBeNull();
    expect(await s.write(AUTOPILOT)).toBe(true);
    expect(await s.read()).toEqual(AUTOPILOT);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // Written by something else (no keyring's seal), or not a setting at all.
    fs.writeFileSync(file, JSON.stringify(AUTOPILOT));
    expect(await s.read()).toBeNull();
    fs.writeFileSync(file, box().encryptString(JSON.stringify({ mode: "autopilot" })));
    expect(await s.read()).toBeNull();
  });

  it("seals nothing without a keyring (basic_text): those agreements last until Ember quits", async () => {
    const file = path.join(dir(), "approvals-seal.bin");
    const s = new ModeSeal(file, box("basic_text"));
    expect(await s.write(AUTOPILOT)).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
    fs.writeFileSync(file, box().encryptString(JSON.stringify(AUTOPILOT)));
    expect(await s.read()).toBeNull();
  });
});

describe("the record of the mode in force (modes-A7)", () => {
  it("writes an entry for every change of the mode in force: the mode, the one before, how, and whether the voice was verified", () => {
    const c = setup(ASKING);
    expect(c.entries()).toEqual([]);
    c.record.as({ via: "home", verified: false }, () => c.settings.update({ approvals: INTERACTIVE }));
    expect(c.inForce()).toBe("interactive");
    c.record.as({ via: "voice", verified: true }, () => c.settings.update({ approvals: ASSISTED }));
    // By hand, while Ember runs, to a mode that asks more: the file's.
    fs.writeFileSync(c.file, JSON.stringify({ ...base, approvals: INTERACTIVE }));
    expect(c.settings.reloadIfChanged()).toBe(true);
    c.record.as({ via: "typed", verified: false }, () => c.settings.update({ approvals: ASKING }));
    expect(c.entries()).toEqual([
      { mode: "interactive", before: "asking", via: "home", verified: false },
      { mode: "assisted", before: "interactive", via: "voice", verified: true },
      { mode: "interactive", before: "assisted", via: "file", verified: false },
      { mode: "asking", before: "interactive", via: "typed", verified: false },
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
    expect(main).toContain("const modes = new ModeRecord({ settings, admin: () => policy, log,");
    expect(main).toContain(`seal: new ModeSeal(path.join(userData, "approvals-seal.bin"), safeStorage, { asyncKeyring: platform.os === "darwin" }) });`);
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

describe("the mode intents against the mode (modes-A8, modes-E1)", () => {
  const wired = (approvals: ApprovalsSetting) => { const c = setup(approvals); return { ...c, intents: modeIntents({ settings: c.settings, modes: c.record, admin: c.policy, voiceMatch: () => "off" }) }; };

  it("says the mode in force, the cards agreed to, and the organisation's limits", () => {
    expect(wired(ASKING).intents.state()).toEqual({ inForce: "asking", agreed: [], managed: false, cap: null, checkOff: false, voiceMatch: "off" });
    expect(wired(INTERACTIVE).intents.state()).toMatchObject({ inForce: "interactive", agreed: ["interactive"], managed: false });
    const managed = wired(INTERACTIVE);
    managed.setPolicy(AdminPolicySchema.parse({ features: { autonomy: false, aiReview: false }, approvals: { maxMode: "assisted" } }));
    expect(managed.intents.state()).toEqual({ inForce: "asking", agreed: ["interactive"], managed: true, cap: "assisted", checkOff: true, voiceMatch: "off" });
  });

  it("“ask me first again” takes Ember below Interactive for anyone, by withdrawing the cards' agreement, and says how in the record", () => {
    const c = wired(ASSISTED);
    expect(c.intents.set("asking", { via: "voice", verified: false })).toBe(true);
    expect(c.inForce()).toBe("asking");
    expect(c.settings.own().approvals).toEqual(ASKING);
    expect(c.entries().at(-1)).toEqual({ mode: "asking", before: "assisted", via: "voice", verified: false });
    // The way back is the card: nothing is in force, and nothing counts as agreed to.
    expect(c.intents.state()).toMatchObject({ inForce: "asking", agreed: [] });
  });

  it("chooses a mode only with its card already agreed to, and never agrees to one", () => {
    const c = wired(ASSISTED);
    expect(c.intents.set("interactive", { via: "typed", verified: false })).toBe(true);
    expect(c.settings.own().approvals).toEqual({ ...ASSISTED, mode: "interactive" });
    expect(c.intents.set("assisted", { via: "voice", verified: true })).toBe(true);
    expect(c.entries().slice(-2)).toEqual([
      { mode: "interactive", before: "assisted", via: "typed", verified: false },
      { mode: "assisted", before: "interactive", via: "voice", verified: true },
    ]);
    // Autopilot's card isn't agreed to: choosing it puts nothing new in force, and says so.
    expect(c.intents.set("autopilot", { via: "voice", verified: true })).toBe(false);
    expect(c.inForce()).toBe("assisted");
    expect(c.settings.own().approvals.consent.autopilot).toEqual(NONE);
  });

  it("chooses Autopilot by voice as Home does: recorded as the voice's, never put back as a hand edit", () => {
    const c = wired(AUTOPILOT_AGREED_INTERACTIVE);
    expect(c.intents.set("autopilot", { via: "voice", verified: false })).toBe(true);
    expect(c.inForce()).toBe("autopilot");
    expect(c.entries().at(-1)).toEqual({ mode: "autopilot", before: "interactive", via: "voice", verified: false });
  });

  it("is what main gives the host, with the choice opened in Settings at the mode's row or its card", () => {
    expect(main).toContain("...modeIntents({ settings, modes, admin: () => policy, voiceMatch:");
    expect(main).toContain("open: (mode, card) => { showHome(); sendToHome(IPC.focusSection, `privacy:${mode === \"interactive\" ? \"autonomy\" : mode}-${card ? \"yes\" : \"on\"}`); },");
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
    fs.writeFileSync(c.file, JSON.stringify({ ...base, approvals: ASKING, size: 100 }));
    fs.utimesSync(c.file, T, T); // the edit lands in the same tick
    expect(fs.statSync(c.file).mtimeMs).toBe(T * 1000);
    expect(c.settings.reloadIfChanged()).toBe(true);
    expect(c.settings.get().size).toBe(100);
  });
});
