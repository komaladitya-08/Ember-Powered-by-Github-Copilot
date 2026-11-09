/** M8: admin lockdown, consent, kill switch, task alignment, auth prompts, audit timeline. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { applyAdminPolicy, loadAdminPolicy, lockedDown, managedKeys, providerApiKey, AdminPolicySchema } from "../../app/main/admin";
import { SettingsStore, DEFAULT_SETTINGS, CONSENT_VERSION } from "../../app/main/settings";
import { PolicyEngine, alignedWithGoal, isSecurityWindow, type ActionRequest } from "../../app/main/policy/policy";
import { AuditLog } from "../../app/main/policy/audit";
import { KillSwitch } from "../../app/main/agent/killswitch";
import type { Logger } from "../../app/main/logger";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ember-safety-"));
const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const req = (r: Partial<ActionRequest>): ActionRequest => ({ taskId: "t1", kind: "click", app: "Mousepad", window: "notes.txt", ...r });
const consent = { version: CONSENT_VERSION, at: "2026-10-15T00:00:00.000Z" };

describe("admin policy file", () => {
  it("is optional: no file means no restrictions", () => {
    const r = loadAdminPolicy(path.join(tmp(), "missing.json"));
    expect(r).toMatchObject({ source: null });
    expect(r.error).toBeUndefined();
    expect(applyAdminPolicy(DEFAULT_SETTINGS, r.policy)).toEqual(DEFAULT_SETTINGS);
  });

  it("locks Ember down when the file is broken or has unknown keys (fail closed)", () => {
    const dir = tmp();
    for (const body of ["{ not json", JSON.stringify({ features: { voice: "off" } }), JSON.stringify({ allowEverything: true })]) {
      const f = path.join(dir, "policy.json");
      fs.writeFileSync(f, body);
      const r = loadAdminPolicy(f);
      expect(r.error).toBeTruthy();
      expect(r.policy.features).toMatchObject({ actions: false, voice: false, cursor: false, desk: false, screenImages: false });
      expect(r.policy.allowGrants).toBe(false);
    }
  });

  it("only makes the user's settings stricter", () => {
    const admin = AdminPolicySchema.parse({
      features: { voice: false, speak: false }, neverLook: ["Thunderbird", "keepassxc"], allowGrants: false,
      models: { allowed: ["gpt-a", "gpt-b"], conductor: "gpt-a" },
    });
    const user = { ...DEFAULT_SETTINGS, wakeWord: true, speak: true, grants: { mousepad: "act" as const }, models: { conductor: "gpt-z", worker: "gpt-z" } };
    const s = applyAdminPolicy(user, admin);
    expect(s).toMatchObject({ wakeWord: false, speak: false, grants: {}, models: { conductor: "gpt-a", worker: null } });
    expect(s.privacy.neverLook).toContain("Thunderbird");
    expect(s.privacy.neverLook.filter(x => x.toLowerCase() === "keepassxc")).toHaveLength(1);
    // Without grants nobody may let Ember work without asking either (policy/autonomy.ts).
    expect(managedKeys(admin)).toEqual(["wakeWord", "speak", "naturalVoice", "clearHearing", "models", "grants", "askedApps", "autonomy"]);
    expect(s.trust).toEqual({ askedApps: false, reviewCommands: false });
    // An admin can't turn on what the user turned off.
    expect(applyAdminPolicy({ ...DEFAULT_SETTINGS, wakeWord: false }, AdminPolicySchema.parse({ features: { voice: true } })).wakeWord).toBe(false);
  });

  it("shows Hear me more clearly as managed wherever the organisation's policy turns it off, a lockdown too (safety-privacy-v6-1)", () => {
    // Home draws the switch off and locked from this key, also while Ember holds itself locked down after a policy change
    // and the settings still hold it on; without it the switch showed on and could be pressed.
    const user = { ...DEFAULT_SETTINGS, voice: { ...DEFAULT_SETTINGS.voice, clearHearing: true } };
    for (const admin of [AdminPolicySchema.parse({ features: { voice: false } }), lockedDown("/etc/ember/policy.json", "Unexpected token").policy]) {
      expect(applyAdminPolicy(user, admin).voice.clearHearing).toBe(false);
      expect(managedKeys(admin)).toContain("clearHearing");
    }
    // Only where it is turned off: speech off alone leaves it to the person.
    for (const admin of [AdminPolicySchema.parse({}), AdminPolicySchema.parse({ features: { speak: false } })]) {
      expect(applyAdminPolicy(user, admin).voice.clearHearing).toBe(true);
      expect(managedKeys(admin)).not.toContain("clearHearing");
    }
  });

  it("turns off AI review of commands, managed, where the organisation says so (features.aiReview)", () => {
    const admin = AdminPolicySchema.parse({ features: { aiReview: false } });
    expect(applyAdminPolicy(DEFAULT_SETTINGS, admin).trust.reviewCommands).toBe(false);
    expect(managedKeys(admin)).toEqual(["reviewCommands"]);
    expect(applyAdminPolicy(DEFAULT_SETTINGS, AdminPolicySchema.parse({ features: { aiReview: true } })).trust).toEqual(DEFAULT_SETTINGS.trust);
  });

  it("overrides what the user saves, while their own file keeps their choice", () => {
    const dir = tmp();
    const file = path.join(dir, "settings.json");
    const store = new SettingsStore(file, AdminPolicySchema.parse({ features: { voice: false } }));
    store.load();
    store.update({ wakeWord: true });
    expect(store.get().wakeWord).toBe(false);
    expect(JSON.parse(fs.readFileSync(file, "utf8")).wakeWord).toBe(true);
  });

  it("reads the organisation's API key from a file", () => {
    const p = AdminPolicySchema.parse({ provider: { type: "azure", baseUrl: "https://ai.example.org/openai", apiKeyFile: "/etc/ember/key" } }).provider!;
    expect(providerApiKey(p, f => (f === "/etc/ember/key" ? "secret\n" : ""))).toBe("secret");
  });
});

describe("consent", () => {
  it("onboarding can't finish without it", () => {
    const store = new SettingsStore(path.join(tmp(), "settings.json"));
    store.load();
    expect(() => store.update({ onboarded: true })).toThrow(/consent/);
    expect(store.get().onboarded).toBe(false);
    expect(store.update({ consent, onboarded: true }).onboarded).toBe(true);
  });

  it("asks again when an older settings file has no (or older) consent", () => {
    const file = path.join(tmp(), "settings.json");
    fs.writeFileSync(file, JSON.stringify({ version: 1, onboarded: true }));
    const store = new SettingsStore(file);
    expect(store.load().settings.onboarded).toBe(false);
  });
});

describe("policy engine under an admin policy", () => {
  it("refuses every action when acting is turned off (reading still works)", () => {
    const e = new PolicyEngine({ neverLook: () => [], grants: () => ({ mousepad: "act" }), actionsAllowed: () => false });
    expect(e.decide(req({ element: { role: "push button", name: "Bold" } }))).toMatchObject({ verdict: "deny", tier: "never" });
    expect(e.decide(req({ kind: "read" })).verdict).toBe("allow");
  });

  it("asks before every action, every time, and never offers “Always”", () => {
    const e = new PolicyEngine({ neverLook: () => [], grants: () => ({ mousepad: "act" }), confirmEveryAction: () => true, allowGrants: () => false });
    const granted = e.decide(req({ element: { role: "push button", name: "Bold" } }));
    expect(granted).toMatchObject({ verdict: "confirm", everyTime: true, remember: false });
    const fresh = new PolicyEngine({ neverLook: () => [], grants: () => ({}), confirmEveryAction: () => true }).decide(req({ app: "Gedit", element: { role: "push button", name: "Bold" } }));
    expect(fresh).toMatchObject({ verdict: "confirm", everyTime: true, remember: false });
  });

  it("offers “Always in this app” only when grants are allowed", () => {
    const yes = new PolicyEngine({ neverLook: () => [], grants: () => ({}) }).decide(req({ element: { role: "push button", name: "Bold" } }));
    const no = new PolicyEngine({ neverLook: () => [], grants: () => ({}), allowGrants: () => false }).decide(req({ element: { role: "push button", name: "Bold" } }));
    expect([yes.remember, no.remember]).toEqual([true, false]);
  });
});

describe("task alignment (M8.4)", () => {
  it("matches the user's words, not the screen's", () => {
    expect(alignedWithGoal("send the report to Ana", "Send")).toBe(true);
    expect(alignedWithGoal("delete the old drafts", "Delete all")).toBe(true);
    expect(alignedWithGoal("fill in the form with my name", "Delete all")).toBe(false);
    expect(alignedWithGoal("fill in the form with my name", "Submit payment")).toBe(false);
    expect(alignedWithGoal(undefined, "Delete")).toBe(true);
  });

  it("says so in the question when a risky action wasn't asked for", () => {
    const e = new PolicyEngine({ neverLook: () => [], grants: () => ({ mousepad: "act" }) });
    const off = e.decide(req({ goal: "Fill in the form with my name", element: { role: "push button", name: "Delete all" } }));
    expect(off).toMatchObject({ verdict: "confirm", risky: true, aligned: false });
    expect(off.prompt).toMatch(/You didn't ask for this/);
    const on = e.decide(req({ goal: "Delete everything in the list", element: { role: "push button", name: "Delete all" } }));
    expect(on.aligned).toBeUndefined();
    expect(on.prompt).not.toMatch(/didn't ask/);
  });
});

describe("authentication prompts (M8.3)", () => {
  it("recognises polkit, sudo, keyring and pinentry prompts", () => {
    expect(isSecurityWindow({ app: "polkit-gnome-authentication-agent-1", title: "Authentication Required" })).toBe(true);
    expect(isSecurityWindow({ app: "gcr-prompter", title: "Unlock Keyring" })).toBe(true);
    expect(isSecurityWindow({ app: "pinentry-gtk-2", title: "" })).toBe(true);
    expect(isSecurityWindow({ title: "[sudo] password for ada" })).toBe(true);
    expect(isSecurityWindow({ app: "mousepad", title: "notes.txt - Mousepad" })).toBe(false);
  });
});

describe("kill switch (M8.9)", () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] }));
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  // Wall-clock bounds, including real audit I/O, live in integration/killswitch-deadline.test.ts.
  // Here a busy CI runner cannot turn the 300 ms deadline into a test of OS scheduling.
  it("tells every part to stop immediately and waits exactly 300 ms for a hung part", async () => {
    const order: string[] = [];
    const dir = tmp();
    const audit = new AuditLog(dir);
    const ks = new KillSwitch(() => [
      { name: "borrow", stop: () => { order.push("borrow"); } },
      { name: "agent", stop: () => new Promise(() => { order.push("agent"); }) }, // never settles
      { name: "speech", stop: () => { order.push("speech"); throw new Error("no speaker"); } },
      { name: "motion", stop: async () => { order.push("motion"); } },
    ], quiet, () => audit);
    let settled = false;
    const pulled = ks.pull("hotkey").then(r => { settled = true; return r; });
    // All stop callbacks run before pull yields, despite an earlier hang or throw.
    expect(order).toEqual(["borrow", "agent", "speech", "motion"]);
    await vi.advanceTimersByTimeAsync(299);
    expect(settled).toBe(false);
    expect(audit.recent(5)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const r = await pulled;
    expect(r).toEqual({ ms: 300, late: ["agent"] });
    expect(audit.recent(5)[0]).toMatchObject({ event: "stop", source: "hotkey" });
  });

  it("records a press in settings as settings, not as the handle's menu", async () => {
    const audit = new AuditLog(tmp());
    await new KillSwitch(() => [{ name: "a", stop: () => undefined }], quiet, () => audit).pull("settings");
    expect(audit.recent(1)[0]).toMatchObject({ event: "stop", source: "settings" });
  });

  it("returns without advancing time when everything stops promptly", async () => {
    const r = await new KillSwitch(() => [{ name: "a", stop: () => undefined }, { name: "b", stop: async () => undefined }], quiet).pull("voice");
    expect(r).toEqual({ ms: 0, late: [] });
  });

  it("waits for a part completing before the deadline rather than always waiting 300 ms", async () => {
    const pulled = new KillSwitch(() => [
      { name: "agent", stop: () => new Promise(resolve => setTimeout(resolve, 123)) },
    ], quiet).pull("menu");
    await vi.advanceTimersByTimeAsync(123);
    expect(await pulled).toEqual({ ms: 123, late: [] });
  });

  it("reports only unfinished parts at the deadline and still observes their late rejection", async () => {
    const warn = vi.fn();
    const failure = new Error("late stop failure");
    const pulled = new KillSwitch(() => [
      { name: "borrow", stop: () => new Promise(resolve => setTimeout(resolve, 299)) },
      { name: "agent", stop: () => new Promise(() => {}) },
      { name: "speech", stop: () => new Promise((_, reject) => setTimeout(() => reject(failure), 301)) },
    ], { ...quiet, warn }).pull("hotkey");
    await vi.advanceTimersByTimeAsync(300);
    const result = await pulled;
    expect(result).toEqual({ ms: 300, late: ["agent", "speech"] });
    expect(warn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(warn).toHaveBeenCalledExactlyOnceWith("killswitch.part_failed", { part: "speech", err: failure });
    // The returned snapshot is stable; a late rejection is handled rather than unhandled or discarded.
    expect(result.late).toEqual(["agent", "speech"]);
  });
});

describe("audit timeline", () => {
  it("lists the newest entries first, across months, and keeps the journal copy separate", () => {
    const dir = tmp();
    const lines: string[] = [];
    let now = new Date("2026-09-30T23:59:00Z");
    const audit = new AuditLog(dir, () => now, l => lines.push(l));
    audit.write({ event: "task", task: "1", phase: "asked" });
    now = new Date("2026-10-01T00:01:00Z");
    audit.write({ event: "action", task: "1", ok: true });
    audit.write({ event: "task", task: "1", phase: "done" });
    expect(fs.readdirSync(dir).sort()).toEqual(["audit-2026-09.jsonl", "audit-2026-10.jsonl"]);
    expect(audit.recent(10).map(e => e.event)).toEqual(["task", "action", "task"]);
    expect(audit.recent(2)).toHaveLength(2);
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[1])).toMatchObject({ event: "action", ok: true });
  });

  it("reads the files once for the timeline, then keeps new entries in memory", () => {
    const dir = tmp();
    const audit = new AuditLog(dir);
    audit.write({ event: "task", task: "1", phase: "asked" });
    expect(audit.recent(5).map(e => e.phase)).toEqual(["asked"]);
    const read = vi.spyOn(fs, "readFileSync");
    audit.write({ event: "task", task: "1", phase: "done" });
    expect(audit.recent(5).map(e => e.phase)).toEqual(["done", "asked"]);
    expect(read).not.toHaveBeenCalled();
    read.mockRestore();
  });

  it("still records when the journal copy fails", () => {
    const audit = new AuditLog(tmp(), undefined, () => { throw new Error("EPIPE"); });
    audit.write({ event: "stop", source: "menu" });
    expect(audit.recent(1)).toHaveLength(1);
  });
});
