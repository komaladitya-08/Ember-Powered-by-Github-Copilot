/**
 * The approval modes (app/main/policy/autonomy.ts, PLAN.md §2 "Approvals", owner decision of 2026-11-12): the one mode
 * setting that replaces the three switches, how an older settings.json is read, the mode in force for every
 * administrator's switch, cap, card and hold, the inputs each state gives the policy engine, and the one call that
 * chooses a mode from Home.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALL_SCOPES, OFFERED_MODES, approvalInputs, approvalsState, autonomyInForce, chooseMode, holdAutonomyOff, modeAgreed, modeInForce, modeWithoutHold,
  releaseAutonomyHold, type ApprovalsSetting,
} from "../../app/main/policy/autonomy";
import { AdminPolicySchema, applyAdminPolicy, autonomyAllowed, loadAdminPolicy, managedKeys, parseAdminPolicy } from "../../app/main/admin";
import { darwinAdminPolicy } from "../../app/main/platform/darwin/system/admin-policy";
import { POLICY_KEY, win32AdminPolicy } from "../../app/main/platform/win32/system/admin-policy";
import { FakeRegistry, fakeApi, HKLM } from "./win32-system-fakes";
import { DEFAULT_SETTINGS, SettingsSchema, SettingsStore, migrateApprovals } from "../../app/main/settings";
import { settingsFromHome } from "../../app/main/windows";
import { APPROVAL_MODES, modeCardVersion, modeRank, type ApprovalMode, type ModeInForce } from "../../app/shared/approvals";
import { FEATURE_CONSENT_VERSION } from "../../app/shared/consent";
import { PolicyEngine, type ActionRequest } from "../../app/main/policy/policy";
import { ChooseArgs, registerApprovalsIpc, type ApprovalsIpcEvent } from "../../app/main/approvals-ipc";
import { APPROVALS_IPC, type ApprovalsDone } from "../../app/shared/approvals";

afterEach(() => releaseAutonomyHold());

const AT = "2026-11-12T10:00:00.000Z";
const NONE = { version: 0, at: null };
/** The setting with `mode` chosen and the cards of `agreed` agreed to as they read now. */
const setting = (mode: ApprovalMode, ...agreed: ApprovalMode[]): ApprovalsSetting => ({
  mode,
  consent: {
    interactive: agreed.includes("interactive") ? { version: modeCardVersion("interactive"), at: AT } : NONE,
    assisted: agreed.includes("assisted") ? { version: modeCardVersion("assisted"), at: AT } : NONE,
    autopilot: agreed.includes("autopilot") ? { version: modeCardVersion("autopilot"), at: AT } : NONE,
  },
});
const admin = (o: Record<string, unknown> = {}) => AdminPolicySchema.parse(o);
/** A policy with the mode capped at `cap`, as the mode in force reads it (the policy's own key is tested with the cap). */
const capped = (o: Record<string, unknown>, cap: ApprovalMode | undefined) => ({ ...admin(o), ...(cap ? { approvals: { maxMode: cap } } : {}) });

describe("the approval mode setting (modes-A1)", () => {
  it("is Interactive by default with no card agreed to, so a new settings file is below Interactive until its card is", () => {
    expect(DEFAULT_SETTINGS.approvals).toEqual({ mode: "interactive", consent: { interactive: NONE, assisted: NONE, autopilot: NONE } });
    expect(modeInForce(DEFAULT_SETTINGS.approvals)).toBe("asking");
    expect("autonomy" in DEFAULT_SETTINGS).toBe(false);
    expect("trust" in DEFAULT_SETTINGS).toBe(false);
  });

  it("versions each mode's card on its own: Interactive's is Work without asking's, bumped to 3; Assisted's at 2 since it named all the check is sent (modes-x9p-4); Autopilot's at 1", () => {
    expect(FEATURE_CONSENT_VERSION).toMatchObject({ autonomy: 3, assisted: 2, autopilot: 1 });
    expect(APPROVAL_MODES.map(modeCardVersion)).toEqual([3, 2, 1]);
    expect(["asking", ...APPROVAL_MODES, "nonsense"].map(modeRank)).toEqual([0, 1, 2, 3, 0]);
  });

  it("refuses a mode it doesn't know, and repairs it to Interactive without losing the cards agreed to", () => {
    expect(SettingsSchema.safeParse({ approvals: { mode: "everything" } }).success).toBe(false);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-modes-"));
    try {
      fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ approvals: { mode: "everything", consent: setting("interactive", "interactive").consent } }));
      const store = new SettingsStore(path.join(dir, "settings.json"));
      store.load();
      expect(store.get().approvals).toEqual(setting("interactive", "interactive"));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("a settings.json from before the modes (modes-A2)", () => {
  const OLD_CARD = 2;
  const scopes = [undefined, { apps: true, commands: true, cursor: true, crossWindow: true }, { apps: true, commands: false, cursor: false, crossWindow: false }];
  const consents = [undefined, { version: 0, at: null }, { version: 1, at: "2026-11-02T10:00:00.000Z" }, { version: 2, at: "2026-11-03T10:00:00.000Z" }, { version: 3, at: "2026-11-04T10:00:00.000Z" }, { version: 99, at: "t" }];
  const autonomies: (Record<string, unknown> | undefined)[] = [undefined];
  for (const on of [true, false]) for (const s of scopes) for (const consent of consents) autonomies.push({ on, ...(s ? { scopes: s } : {}), ...(consent ? { consent } : {}) });
  const trusts: (Record<string, unknown> | undefined)[] = [undefined];
  for (const askedApps of [true, false]) for (const reviewCommands of [true, false]) trusts.push({ askedApps, reviewCommands });

  it("loads with every combination of the old keys, drops them, and counts none of them as agreement to a new card", () => {
    let combos = 0;
    for (const autonomy of autonomies) {
      for (const trust of trusts) {
        if (!autonomy && !trust) continue;
        combos++;
        const old = { size: 72, ...(autonomy ? { autonomy } : {}), ...(trust ? { trust } : {}) };
        const parsed = SettingsSchema.safeParse(migrateApprovals(old));
        expect(parsed.success, JSON.stringify(old)).toBe(true);
        if (!parsed.success) continue;
        const s = parsed.data;
        expect(s.size).toBe(72);
        expect("autonomy" in s || "trust" in s).toBe(false);
        // The mode is the default, never read from the old switches; Assisted's and Autopilot's cards were never shown.
        expect(s.approvals.mode).toBe("interactive");
        expect(s.approvals.consent.assisted).toEqual(NONE);
        expect(s.approvals.consent.autopilot).toEqual(NONE);
        // Work without asking's agreement is kept as what it was, at most the old card's version: below the new card.
        const was = (autonomy?.consent as { version: number; at: string | null } | undefined) ?? NONE;
        expect(s.approvals.consent.interactive).toEqual(was.version > 0 ? { version: Math.min(was.version, OLD_CARD), at: was.at } : NONE);
        expect(s.approvals.consent.interactive.version).toBeLessThan(FEATURE_CONSENT_VERSION.autonomy);
        expect(modeInForce(s.approvals), JSON.stringify(old)).toBe("asking");
        expect(approvalInputs(modeInForce(s.approvals))).toEqual({ scopes: null, askedApps: false, check: false, autopilot: false });
      }
    }
    expect(combos).toBe(autonomies.length * trusts.length - 1);
  });

  it("leaves a file that already has the new key as it is, old keys beside it or not", () => {
    const now = { approvals: setting("interactive", "interactive") };
    expect(migrateApprovals(now)).toBe(now);
    const both = { approvals: setting("interactive", "interactive"), autonomy: { on: false, consent: { version: 2, at: "t" } }, trust: { askedApps: false, reviewCommands: true } };
    expect(migrateApprovals(both)).toEqual({ approvals: setting("interactive", "interactive") });
    for (const odd of [null, undefined, 5, "autonomy", ["autonomy"]]) expect(migrateApprovals(odd)).toBe(odd);
  });

  it("reads broken old values without judging the file invalid: nothing of them is kept", () => {
    for (const autonomy of ["yes", null, 5, [], { on: "yes", scopes: { apps: "no" }, consent: { version: "one" } }, { consent: { version: -1 } }, { consent: { version: 1.5 } }, { consent: null }]) {
      const parsed = SettingsSchema.safeParse(migrateApprovals({ autonomy, trust: "all" }));
      expect(parsed.success && parsed.data.approvals, JSON.stringify(autonomy)).toEqual(DEFAULT_SETTINGS.approvals);
    }
  });

  it("is read by the store with no notice and no backup, and the old keys go with the next save", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-modes-"));
    try {
      const file = path.join(dir, "settings.json");
      fs.writeFileSync(file, JSON.stringify({ size: 72, trust: { askedApps: true, reviewCommands: true }, autonomy: { on: true, scopes: { apps: true, commands: true, cursor: true, crossWindow: true }, consent: { version: 2, at: AT } } }));
      const store = new SettingsStore(file);
      const loaded = store.load();
      expect(loaded.recoveredFrom).toBeUndefined();
      expect(store.lastProblem).toBeNull();
      expect(fs.readdirSync(dir)).toEqual(["settings.json"]);
      expect(store.get().approvals).toEqual({ mode: "interactive", consent: { interactive: { version: 2, at: AT }, assisted: NONE, autopilot: NONE } });
      expect(modeInForce(store.get().approvals)).toBe("asking");
      // Read, not rewritten: the file is the user's until Ember next saves.
      expect(JSON.parse(fs.readFileSync(file, "utf8"))).toHaveProperty("autonomy");
      store.update({ size: 80 });
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      expect("autonomy" in saved || "trust" in saved).toBe(false);
      expect(saved.approvals.consent.interactive).toEqual({ version: 2, at: AT });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe("the mode in force (modes-A3)", () => {
  const CHOSEN: ApprovalMode[] = ["interactive", "assisted", "autopilot"];
  const CARDS: ApprovalMode[][] = [[], ["interactive"], ["assisted"], ["autopilot"], ["interactive", "assisted"], ["interactive", "autopilot"], ["assisted", "autopilot"], ["interactive", "assisted", "autopilot"]];
  const CAPS: (ApprovalMode | undefined)[] = [undefined, "interactive", "assisted", "autopilot"];
  /** Each of the administrator's switches that bear on it, and whether it keeps Ember below Interactive. */
  const SWITCHES: { name: string; policy: Record<string, unknown>; below: boolean; checkOff?: true }[] = [
    { name: "no policy", policy: {}, below: false },
    { name: "features.autonomy true", policy: { features: { autonomy: true } }, below: false },
    { name: "features.autonomy false", policy: { features: { autonomy: false } }, below: true },
    { name: "allowGrants false", policy: { allowGrants: false }, below: true },
    { name: "confirmEveryAction", policy: { confirmEveryAction: true }, below: true },
    { name: "features.actions false", policy: { features: { actions: false } }, below: true },
    { name: "features.aiReview false", policy: { features: { aiReview: false } }, below: false, checkOff: true },
    { name: "features.aiReview true", policy: { features: { aiReview: true } }, below: false },
  ];
  /** Written out again here, apart from the code: the highest agreed mode at or below the choice and the cap. */
  const expected = (chosen: ApprovalMode, cards: ApprovalMode[], cap: ApprovalMode | undefined, sw: (typeof SWITCHES)[number], held: boolean): ModeInForce => {
    if (held || sw.below) return "asking";
    const order: ApprovalMode[] = ["autopilot", "assisted", "interactive"];
    for (const m of order) {
      if (modeRank(m) > modeRank(chosen) || (cap && modeRank(m) > modeRank(cap))) continue;
      if (m === "assisted" && sw.checkOff) continue;
      if (cards.includes(m)) return m;
    }
    return "asking";
  };

  it("is the highest mode at or below the choice and the cap whose own card is agreed to, and below Interactive otherwise", () => {
    let rows = 0;
    for (const chosen of CHOSEN) for (const cards of CARDS) for (const cap of CAPS) for (const sw of SWITCHES) for (const held of [false, true]) {
      const a = capped(sw.policy, cap);
      if (held) holdAutonomyOff(); else releaseAutonomyHold();
      const want = expected(chosen, cards, cap, sw, held);
      const what = `${chosen} chosen, ${cards.join("+") || "no"} cards, cap ${cap ?? "none"}, ${sw.name}${held ? ", held" : ""}`;
      expect(modeInForce(setting(chosen, ...cards), a), what).toBe(want);
      // The hold is the only difference between the two.
      expect(modeWithoutHold(setting(chosen, ...cards), a), what).toBe(expected(chosen, cards, cap, sw, false));
      // The scopes view is the same decision.
      expect(autonomyInForce(setting(chosen, ...cards), a), what).toEqual(want === "asking" ? null : ALL_SCOPES);
      rows++;
    }
    expect(rows).toBe(3 * 8 * 4 * 8 * 2);
  });

  it("is below Interactive in a lockdown, for a setting that can't be read, and for a card agreed to in an older wording", () => {
    const lockdown = parseAdminPolicy("{ nope", "/etc/ember/policy.json").policy;
    expect(lockdown.features.autonomy).toBe(false);
    expect(autonomyAllowed(lockdown)).toBe(false);
    expect(modeInForce(setting("interactive", "interactive"), lockdown)).toBe("asking");
    expect(modeInForce(undefined)).toBe("asking");
    expect(modeInForce({ mode: "interactive" } as unknown as ApprovalsSetting)).toBe("asking");
    expect(modeInForce({ ...setting("interactive"), mode: "everything" } as unknown as ApprovalsSetting)).toBe("asking");
    const older: ApprovalsSetting = { mode: "interactive", consent: { ...setting("interactive").consent, interactive: { version: FEATURE_CONSENT_VERSION.autonomy - 1, at: AT } } };
    expect(modeAgreed(older, "interactive")).toBe(false);
    expect(modeInForce(older)).toBe("asking");
    // With no administrator at all (no policy file), the user's own choice and card decide.
    expect(modeInForce(setting("interactive", "interactive"))).toBe("interactive");
    expect(modeInForce(setting("interactive", "interactive"), null)).toBe("interactive");
  });

  it("gives a mode only with its own card: Assisted with Assisted's, Autopilot with Autopilot's, each falling to the next one down that is agreed to", () => {
    expect(modeInForce(setting("assisted", "interactive"))).toBe("interactive");
    expect(modeInForce(setting("assisted", "assisted"))).toBe("assisted");
    // Autopilot is never in force on another mode's agreement (modes-D5): it needs its own card, as it reads now.
    expect(modeInForce(setting("autopilot", "interactive", "assisted"))).toBe("assisted");
    expect(modeInForce(setting("autopilot", "interactive"))).toBe("interactive");
    expect(modeInForce(setting("autopilot"))).toBe("asking");
    expect(modeInForce(setting("autopilot", "autopilot"))).toBe("autopilot");
    expect(modeInForce(setting("autopilot", "interactive", "assisted", "autopilot"))).toBe("autopilot");
    const older: ApprovalsSetting = { mode: "autopilot", consent: { ...setting("autopilot", "interactive").consent, autopilot: { version: FEATURE_CONSENT_VERSION.autopilot - 1, at: AT } } };
    expect(modeInForce(older)).toBe("interactive");
    // It is never the default, and Assisted's check being off doesn't touch it (no model decides there).
    expect(DEFAULT_SETTINGS.approvals.mode).toBe("interactive");
    expect(modeInForce(setting("autopilot", "autopilot"), admin({ features: { aiReview: false } }))).toBe("autopilot");
    // The organisation's switches and its cap hold it as they hold every mode.
    expect(modeInForce(setting("autopilot", "interactive", "autopilot"), capped({}, "interactive"))).toBe("interactive");
    expect(modeInForce(setting("autopilot", "autopilot"), capped({}, "assisted"))).toBe("asking");
    for (const policy of [{ features: { autonomy: false } }, { allowGrants: false }, { confirmEveryAction: true }, { features: { actions: false } }]) {
      expect(modeInForce(setting("autopilot", "interactive", "assisted", "autopilot"), admin(policy)), JSON.stringify(policy)).toBe("asking");
    }
    expect(approvalInputs(modeInForce(setting("autopilot", "autopilot"))).autopilot).toBe(true);
    // Home offers a row and a card for each mode that is built.
    expect(OFFERED_MODES).toEqual(["interactive", "assisted", "autopilot"]);
  });

  it("is what the settings in force say on their own too: below Interactive no card counts, and the user's own file is left alone", () => {
    const user = { ...DEFAULT_SETTINGS, approvals: setting("assisted", "interactive", "assisted") };
    expect(applyAdminPolicy(user, admin()).approvals).toEqual(user.approvals);
    for (const a of [admin({ features: { autonomy: false } }), admin({ allowGrants: false }), admin({ confirmEveryAction: true }), admin({ features: { actions: false } }), parseAdminPolicy("{ nope", "p").policy]) {
      const s = applyAdminPolicy(user, a);
      expect(modeInForce(s.approvals)).toBe("asking");
      expect(s.approvals.consent).toEqual(DEFAULT_SETTINGS.approvals.consent);
      expect(managedKeys(a)).toContain("autonomy");
    }
    // The user's own file is never what the policy made of it.
    expect(user.approvals).toEqual(setting("assisted", "interactive", "assisted"));
    expect(managedKeys(admin({ features: { autonomy: true } }))).toEqual([]);
  });
});

describe("the administrator's cap on the mode (approvals.maxMode, modes-A11)", () => {
  it("takes the cap only as one of the three modes, in a policy that is otherwise strict", () => {
    expect(AdminPolicySchema.safeParse({ approvals: { maxMode: "assisted" } }).success).toBe(true);
    expect(AdminPolicySchema.safeParse({ approvals: {} }).success).toBe(true);
    for (const bad of [{ approvals: { maxMode: "asking" } }, { approvals: { maxMode: "everything" } }, { approvals: { maxMode: 2 } }, { approvals: { mode: "interactive" } }, { approvals: "interactive" }]) {
      expect(AdminPolicySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      // A policy Ember can't read locks it down: below Interactive.
      const locked = parseAdminPolicy(JSON.stringify(bad), "/etc/ember/policy.json");
      expect(locked.error).toBeDefined();
      expect(modeInForce(setting("interactive", "interactive"), locked.policy)).toBe("asking");
    }
  });

  it("can only lower the mode: a higher choice is in force as the cap at most, and the cap chooses nothing", () => {
    const all = setting("assisted", "interactive", "assisted");
    expect(modeInForce(all, admin({ approvals: { maxMode: "interactive" } }))).toBe("interactive");
    expect(modeInForce(all, admin({ approvals: { maxMode: "assisted" } }))).toBe("assisted");
    expect(modeInForce(all, admin({ approvals: { maxMode: "autopilot" } }))).toBe("assisted");
    expect(modeInForce(setting("interactive", "interactive", "assisted"), admin({ approvals: { maxMode: "assisted" } }))).toBe("interactive");
    // Nothing agreed to: a cap puts no mode in force.
    expect(modeInForce(setting("interactive"), admin({ approvals: { maxMode: "autopilot" } }))).toBe("asking");
    // With the organisation's other switches it only tightens further.
    expect(modeInForce(all, admin({ approvals: { maxMode: "assisted" }, features: { autonomy: false } }))).toBe("asking");
    expect(modeInForce(all, admin({ approvals: { maxMode: "assisted" }, features: { aiReview: false } }))).toBe("interactive");
  });

  it("shows in the settings in force and as managed, and never reaches the user's own file", () => {
    const user = { ...DEFAULT_SETTINGS, approvals: setting("assisted", "interactive", "assisted") };
    expect(applyAdminPolicy(user, admin({ approvals: { maxMode: "interactive" } })).approvals).toEqual({ ...user.approvals, mode: "interactive" });
    expect(applyAdminPolicy(user, admin({ approvals: { maxMode: "autopilot" } })).approvals).toEqual(user.approvals);
    // The cap never raises a choice.
    expect(applyAdminPolicy({ ...user, approvals: setting("interactive", "interactive", "assisted") }, admin({ approvals: { maxMode: "assisted" } })).approvals.mode).toBe("interactive");
    expect(user.approvals.mode).toBe("assisted");
    expect(managedKeys(admin({ approvals: { maxMode: "interactive" } }))).toContain("approvals");
    expect(managedKeys(admin({ approvals: { maxMode: "assisted" } }))).toContain("approvals");
    expect(managedKeys(admin({ approvals: { maxMode: "autopilot" } }))).not.toContain("approvals");
    expect(managedKeys(admin({ approvals: {} }))).not.toContain("approvals");
  });

  it("is told to Home with the state, and refuses a choice above it", () => {
    expect(approvalsState(setting("assisted", "interactive", "assisted"), admin({ approvals: { maxMode: "interactive" } }))).toMatchObject({ chosen: "assisted", inForce: "interactive", why: "cap", cap: "interactive" });
    expect(approvalsState(setting("interactive", "interactive"), admin({ approvals: { maxMode: "interactive" } }))).toMatchObject({ inForce: "interactive", why: null, cap: "interactive" });
    expect(chooseMode(DEFAULT_SETTINGS.approvals, "interactive", modeCardVersion("interactive"), admin({ approvals: { maxMode: "interactive" } }), AT).ok).toBe(true);
  });

  it("reads the same from every policy source: the Linux and macOS file and the Windows registry value", () => {
    const raw = JSON.stringify({ approvals: { maxMode: "interactive" }, commands: { local: "on" } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-modes-"));
    try {
      const file = path.join(dir, "policy.json");
      fs.writeFileSync(file, raw);
      // The POSIX file (Linux's /etc/ember/policy.json, and macOS's through darwinAdminPolicy, which loads it the same way).
      expect(loadAdminPolicy(file, { requireRootOwned: false })).toMatchObject({ source: file, policy: { approvals: { maxMode: "interactive" } } });
      const mac = darwinAdminPolicy({ load: () => loadAdminPolicy(file, { requireRootOwned: false }), lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, isDirectory: () => true, uid: 0, mode: 0o644 }) }).load();
      expect(mac.error).toBeUndefined();
      expect(mac.policy.approvals).toEqual({ maxMode: "interactive" });
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    // The registry's PolicyJson value (platform/win32/system/admin-policy.ts), as a string and as an ADMX multi-string.
    const win = (registry: FakeRegistry) => win32AdminPolicy({ api: () => fakeApi(registry), env: {} }).load();
    for (const loaded of [win(new FakeRegistry().sz(HKLM, POLICY_KEY, "PolicyJson", raw)), win(new FakeRegistry().multiSz(HKLM, POLICY_KEY, "PolicyJson", ["{", "  \"approvals\": { \"maxMode\": \"interactive\" }", "}"]))]) {
      expect(loaded.error).toBeUndefined();
      expect(loaded.policy.approvals).toEqual({ maxMode: "interactive" });
      expect(modeInForce(setting("assisted", "interactive", "assisted"), loaded.policy)).toBe("interactive");
    }
    // A mode the registry misspells locks Ember down there too.
    expect(win(new FakeRegistry().sz(HKLM, POLICY_KEY, "PolicyJson", "{\"approvals\": {\"maxMode\": \"auto\"}}")).error).toMatch(/approvals\.maxMode/);
  });
});

describe("what each state gives the policy engine (modes-A4)", () => {
  const click: ActionRequest = { taskId: "t", kind: "click", app: "mousepad", window: "notes", element: { role: "push button", name: "Bold" } };
  const asked: ActionRequest = { ...click, askedIn: "mousepad", goal: "make the title bold" };
  const borrow: ActionRequest = { ...click, kind: "cursor_click" };
  const risky: ActionRequest = { ...click, element: { role: "push button", name: "Delete all" } };
  const verdicts = (o: { autonomy: typeof ALL_SCOPES | null; trustAskedApps: boolean }) => {
    const e = new PolicyEngine({ neverLook: () => [], grants: () => ({}), autonomy: () => (o.autonomy ? { ...o.autonomy } : null), trustAskedApps: () => o.trustAskedApps });
    return [click, asked, borrow, risky].map(r => { const d = e.decide(r); return [d.verdict, d.autonomy ?? false, d.reason]; });
  };

  it("gives Interactive exactly what Work without asking with every scope and the app switch gave, and below it what all three switches off gave", () => {
    expect(approvalInputs("asking")).toEqual({ scopes: null, askedApps: false, check: false, autopilot: false });
    expect(approvalInputs("interactive")).toEqual({ scopes: { apps: true, commands: true, cursor: true, crossWindow: true }, askedApps: true, check: false, autopilot: false });
    expect(approvalInputs("interactive").scopes).toEqual(ALL_SCOPES);
    // Decided through the engine, whose inputs keep their shape: the same decisions as the old switches' values.
    const from = (m: ModeInForce) => { const i = approvalInputs(m); return verdicts({ autonomy: i.scopes, trustAskedApps: i.askedApps }); };
    expect(from("interactive")).toEqual(verdicts({ autonomy: ALL_SCOPES, trustAskedApps: true }));
    expect(from("asking")).toEqual(verdicts({ autonomy: null, trustAskedApps: false }));
    expect(from("interactive")).not.toEqual(from("asking"));
    // And what that is: ordinary steps go ahead (announced where they are not in an app asked for), the risky one asks.
    expect(from("interactive").map(v => v[0])).toEqual(["allow", "allow", "allow", "confirm"]);
    expect(from("interactive").map(v => v[1])).toEqual([true, false, true, false]);
    expect(from("asking").map(v => v[0])).toEqual(["confirm", "confirm", "confirm", "confirm"]);
  });

  it("turns Assisted's check on only in Assisted, on top of Interactive's inputs (modes-C1)", () => {
    expect(approvalInputs("assisted")).toEqual({ ...approvalInputs("interactive"), check: true });
    // Autopilot is Interactive's inputs with its own switch: no model decides there, so never the check (modes-D1).
    expect(approvalInputs("autopilot")).toEqual({ ...approvalInputs("interactive"), autopilot: true });
    for (const m of ["asking", "interactive", "autopilot"] as const) expect(approvalInputs(m).check).toBe(false);
  });
});

describe("what Home is told of the modes (modes-A5)", () => {
  it("says the choice, what is in force and why they differ", () => {
    expect(approvalsState(DEFAULT_SETTINGS.approvals, null)).toEqual({ chosen: "interactive", inForce: "asking", why: "card", offered: ["interactive", "assisted", "autopilot"], agreed: [], cap: null });
    expect(approvalsState(setting("interactive", "interactive"), admin())).toEqual({ chosen: "interactive", inForce: "interactive", why: null, offered: ["interactive", "assisted", "autopilot"], agreed: ["interactive"], cap: null });
    // The organisation turned Assisted's check off: said whatever is chosen, so its row can say why it is locked (modes-C5).
    expect(approvalsState(setting("interactive", "interactive"), admin({ features: { aiReview: false } }))).toEqual({ chosen: "interactive", inForce: "interactive", why: null, offered: ["interactive", "assisted", "autopilot"], agreed: ["interactive"], cap: null, checkOff: true });
    expect(approvalsState(setting("assisted", "interactive", "assisted"), admin())).toMatchObject({ chosen: "assisted", inForce: "assisted", why: null });
    expect(approvalsState(setting("interactive", "interactive"), admin({ features: { autonomy: false } }))).toMatchObject({ inForce: "asking", why: "organisation", agreed: ["interactive"] });
    expect(approvalsState(setting("assisted", "interactive", "assisted"), capped({}, "interactive"))).toMatchObject({ chosen: "assisted", inForce: "interactive", why: "cap", cap: "interactive" });
    expect(approvalsState(setting("assisted", "interactive", "assisted"), admin({ features: { aiReview: false } }))).toMatchObject({ inForce: "interactive", why: "check-off" });
    expect(approvalsState(setting("assisted", "interactive"), admin())).toMatchObject({ inForce: "interactive", why: "card" });
    expect(approvalsState(setting("autopilot", "interactive", "autopilot"), admin())).toMatchObject({ chosen: "autopilot", inForce: "autopilot", why: null, agreed: ["interactive", "autopilot"] });
    expect(approvalsState(setting("autopilot", "interactive"), admin())).toMatchObject({ chosen: "autopilot", inForce: "interactive", why: "card" });
    expect(approvalsState(setting("autopilot", "interactive", "assisted", "autopilot"), capped({}, "assisted"))).toMatchObject({ chosen: "autopilot", inForce: "assisted", why: "cap", cap: "assisted" });
    holdAutonomyOff();
    expect(approvalsState(setting("interactive", "interactive"), admin())).toMatchObject({ inForce: "asking", why: "not-recorded" });
    // The organisation's reason comes first: it holds whatever else does.
    expect(approvalsState(setting("interactive", "interactive"), admin({ confirmEveryAction: true }))).toMatchObject({ inForce: "asking", why: "organisation" });
  });
});

describe("choosing a mode from Home (modes-A6)", () => {
  const own = DEFAULT_SETTINGS.approvals;
  const card = modeCardVersion("interactive");

  it("records the agreement to the card and the mode in one change, keeping the other cards as they were", () => {
    expect(chooseMode(own, "interactive", card, null, AT)).toEqual({ ok: true, approvals: { mode: "interactive", consent: { ...own.consent, interactive: { version: card, at: AT } } } });
    const was = setting("assisted", "assisted");
    const next = chooseMode(was, "interactive", card, admin(), AT);
    expect(next).toEqual({ ok: true, approvals: { mode: "interactive", consent: { ...was.consent, interactive: { version: card, at: AT } } } });
    if (next.ok) expect(modeInForce(next.approvals, admin())).toBe("interactive");
  });

  it("refuses a card that isn't the one in force now, older or newer", () => {
    for (const v of [card - 1, card + 1, 0]) expect(chooseMode(own, "interactive", v, null, AT)).toEqual({ ok: false, why: "card" });
  });

  it("refuses a mode Home doesn't offer, whatever card comes with it", () => {
    expect(chooseMode(own, "asking" as unknown as ApprovalMode, 1, null, AT)).toEqual({ ok: false, why: "unavailable" });
    expect(chooseMode(own, "everything" as unknown as ApprovalMode, 1, null, AT)).toEqual({ ok: false, why: "unavailable" });
  });

  it("chooses Autopilot only with the agreement to Autopilot's own card, and never where the organisation forbids or caps it (modes-D5)", () => {
    const v = modeCardVersion("autopilot");
    const was = setting("assisted", "interactive", "assisted");
    const next = chooseMode(was, "autopilot", v, admin(), AT);
    expect(next).toEqual({ ok: true, approvals: { mode: "autopilot", consent: { ...was.consent, autopilot: { version: v, at: AT } } } });
    if (next.ok) expect(modeInForce(next.approvals, admin())).toBe("autopilot");
    // Another card's version, an older or a newer one of its own: no card, no Autopilot.
    for (const wrong of [v - 1, v + 1, 0, modeCardVersion("interactive")].filter(x => x !== v)) expect(chooseMode(was, "autopilot", wrong, admin(), AT)).toEqual({ ok: false, why: "card" });
    expect(chooseMode(was, "autopilot", v, capped({}, "assisted"), AT)).toEqual({ ok: false, why: "cap" });
    expect(chooseMode(was, "autopilot", v, capped({}, "interactive"), AT)).toEqual({ ok: false, why: "cap" });
    for (const policy of [{ features: { autonomy: false } }, { allowGrants: false }, { confirmEveryAction: true }, { features: { actions: false } }]) {
      expect(chooseMode(was, "autopilot", v, admin(policy), AT), JSON.stringify(policy)).toEqual({ ok: false, why: "organisation" });
    }
    // Assisted's check being off is no bar to it.
    expect(chooseMode(was, "autopilot", v, admin({ features: { aiReview: false } }), AT)).toMatchObject({ ok: true });
  });

  it("chooses Assisted only with the agreement to Assisted's own card, and never where the organisation turned its check off or caps the mode below it (modes-C5)", () => {
    const v = modeCardVersion("assisted");
    const was = setting("interactive", "interactive");
    const next = chooseMode(was, "assisted", v, admin(), AT);
    expect(next).toEqual({ ok: true, approvals: { mode: "assisted", consent: { ...was.consent, assisted: { version: v, at: AT } } } });
    if (next.ok) expect(modeInForce(next.approvals, admin())).toBe("assisted");
    // Interactive's card is no agreement to Assisted's, nor an older or newer version of it.
    expect(chooseMode(was, "assisted", modeCardVersion("interactive"), admin(), AT).ok).toBe(modeCardVersion("interactive") === v);
    for (const bad of [v - 1, v + 1]) expect(chooseMode(was, "assisted", bad, admin(), AT)).toEqual({ ok: false, why: "card" });
    expect(chooseMode(was, "assisted", v, admin({ features: { aiReview: false } }), AT)).toEqual({ ok: false, why: "check-off" });
    expect(chooseMode(was, "assisted", v, capped({}, "interactive"), AT)).toEqual({ ok: false, why: "cap" });
    expect(chooseMode(was, "assisted", v, admin({ confirmEveryAction: true }), AT)).toEqual({ ok: false, why: "organisation" });
    expect(chooseMode(was, "assisted", v, capped({}, "assisted"), AT).ok).toBe(true);
  });

  it("refuses where the organisation keeps Ember below Interactive", () => {
    for (const a of [admin({ features: { autonomy: false } }), admin({ allowGrants: false }), admin({ confirmEveryAction: true }), admin({ features: { actions: false } })]) {
      expect(chooseMode(own, "interactive", card, a, AT)).toEqual({ ok: false, why: "organisation" });
    }
  });

  it("is the only way Home changes the mode or a card's record: a general settings change never carries them", () => {
    const sneaky = { size: 70, approvals: setting("autopilot", "interactive", "assisted", "autopilot") };
    expect(settingsFromHome(sneaky)).toEqual({ patch: { size: 70 }, dropped: ["approvals"] });
  });
});

describe("the one call that chooses a mode (APPROVALS_IPC.choose, modes-A6)", () => {
  const state = approvalsState(DEFAULT_SETTINGS.approvals, null);
  const wire = (o: { home?: boolean; choose?: (mode: ApprovalMode, version: number) => ApprovalsDone } = {}) => {
    const handlers = new Map<string, (event: ApprovalsIpcEvent, ...args: unknown[]) => unknown>();
    const calls: [ApprovalMode, number][] = [];
    const warned: Record<string, unknown>[] = [];
    registerApprovalsIpc({ handle: (channel, fn) => { handlers.set(channel, fn); } }, () => o.home ?? true, {
      state: () => state,
      choose: (mode, version) => { calls.push([mode, version]); return o.choose ? o.choose(mode, version) : { ok: true, state }; },
    }, { log: { warn: (_e, fields) => { warned.push(fields ?? {}); } } });
    const choose = (...args: unknown[]) => handlers.get(APPROVALS_IPC.choose)!({ sender: {} }, ...args);
    return { handlers, calls, warned, choose };
  };

  it("is the only channel Home has for the mode, and answers only the settings window", () => {
    const w = wire({ home: false });
    expect([...w.handlers.keys()]).toEqual(["approvals:choose"]);
    expect(() => w.choose("interactive", modeCardVersion("interactive"))).toThrow(/untrusted IPC sender/);
    expect(w.calls).toEqual([]);
  });

  it("takes exactly a mode's name and a card's version, and does nothing with anything else (CLAUDE.md IPC: type and size)", () => {
    const w = wire();
    const bad: unknown[][] = [
      [], ["interactive"], ["interactive", 3, "extra"], ["asking", 1], ["Interactive", 3], [3, "interactive"], ["interactive", "3"], ["interactive", 3.5], ["interactive", 0], ["interactive", -1],
      ["interactive", 10_001], ["interactive", Number.MAX_SAFE_INTEGER], ["interactive", NaN], ["interactive", null], [null, 3], [{ mode: "interactive", version: 3 }], [["interactive", 3]],
      ["interactive".repeat(10_000), 3], ["interactive", { valueOf: () => 3 }],
    ];
    for (const args of bad) {
      expect(ChooseArgs.safeParse(args).success, JSON.stringify(args).slice(0, 60)).toBe(false);
      expect(w.choose(...args)).toEqual({ ok: false, why: "unavailable", state });
    }
    expect(w.calls).toEqual([]);
    expect(w.choose("interactive", 3)).toEqual({ ok: true, state });
    expect(w.choose("autopilot", 1)).toEqual({ ok: true, state });
    expect(w.calls).toEqual([["interactive", 3], ["autopilot", 1]]);
  });

  it("answers a failure below as a choice that couldn't be recorded, with the state as it stands, and logs only the error's name", () => {
    const w = wire({ choose: () => { throw Object.assign(new Error("ENOSPC: /home/ana/.config/ember/settings.json"), { code: "ENOSPC" }); } });
    expect(w.choose("interactive", 3)).toEqual({ ok: false, why: "not-recorded", state });
    expect(w.warned).toEqual([{ err: "Error" }]);
  });

  it("is wired in main to the user's own setting, the card's current version and the record, and is in force before it says so", () => {
    const main = fs.readFileSync("app/main/main.ts", "utf8");
    expect(main).toContain("const next = chooseMode(settings.own().approvals, mode, version, policy, new Date().toISOString());");
    expect(main).toContain(`modes.as({ via: "home", verified: false }, () => settings.update({ approvals: next.approvals }));`);
    expect(main).toContain(`return state.inForce === mode ? { ok: true, state } : { ok: false, why: "not-recorded", state };`);
    // The general settings change drops the mode before it is saved.
    expect(main).toContain("const { patch, dropped } = settingsFromHome(checkHomePatch(sent));");
    expect(main).toContain("settings.update(ownNeverLook(withOwnExtensions(withOwnProvider(patch, settings.own().provider), settings.own().extensions)), { soon: sizeOnly })");
    // And no tool of the conductor's or a worker's reads or sets it: under app/main/agent only the host reads the
    // setting (for a worker's inputs), and nothing there chooses a mode but the host's own intents, through main.
    const agent = "app/main/agent";
    const sources = fs.readdirSync(agent).filter(f => f.endsWith(".ts")).map(f => [f, fs.readFileSync(path.join(agent, f), "utf8")] as const);
    expect(sources.filter(([, text]) => /\(\)\.approvals\b|approvals\s*:\s*\{|\{\s*approvals\b/.test(text)).map(([f]) => f)).toEqual(["host.ts"]);
    expect(sources.filter(([, text]) => /\bchooseMode\b|ModeRecord|modeIntents|APPROVALS_IPC|holdAutonomyOff|releaseAutonomyHold/.test(text)).map(([f]) => f)).toEqual([]);
    // The conductor and the workers load nothing of the mode's code: a worker is handed its inputs, as types only.
    for (const [f, text] of sources) if (f === "conductor.ts" || f === "worker.ts") expect(text, f).not.toMatch(/import \{[^}]*\} from "[^"]*(policy\/autonomy|policy\/mode-record|autonomy-intent|shared\/approvals)"/);
  });
});
