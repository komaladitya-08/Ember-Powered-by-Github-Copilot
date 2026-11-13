/**
 * The approval mode by voice and typed words (app/main/agent/autonomy-intent.ts, answered in the host; PLAN.md §10
 * "Settled" (5)): naming a mode, "work without asking" and "ask me first again". A switch to a mode that asks less only
 * by voice, from anyone heard while Voice Match is off and only from the owner's verified voice while it is on, never
 * over Ember's voice, and only with that mode's card agreed to in Home; to one that asks more, from anyone. Run against
 * the pure planner, and through a real AgentHost, SettingsStore, ModeRecord and AuditLog as main wires them.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTONOMY_NOT_SAVED, modeIntent, planModeIntent, type ModeIntentHeard, type ModeIntentState } from "../../app/main/agent/autonomy-intent";
import { AgentHost } from "../../app/main/agent/host";
import { SettingsStore } from "../../app/main/settings";
import { modeInForce, type ApprovalsSetting } from "../../app/main/policy/autonomy";
import { ModeRecord, modeIntents } from "../../app/main/policy/mode-record";
import { AuditLog } from "../../app/main/policy/audit";
import { AdminPolicySchema } from "../../app/main/admin";
import { modeCardVersion, type ApprovalMode } from "../../app/shared/approvals";
import { modeCardRequested, sectionRequest } from "../../app/renderer/home/section-request";
import type { Logger } from "../../app/main/logger";

const AT = "2026-11-13T10:00:00.000Z";
const NONE = { version: 0, at: null };
const card = (m: ApprovalMode) => ({ version: modeCardVersion(m), at: AT });
const ALL_AGREED = (mode: ApprovalMode): ApprovalsSetting => ({ mode, consent: { interactive: card("interactive"), assisted: card("assisted"), autopilot: card("autopilot") } });

const state = (o: Partial<ModeIntentState> = {}): ModeIntentState => ({ inForce: "interactive", agreed: ["interactive", "assisted", "autopilot"], managed: false, cap: null, checkOff: false, voiceMatch: "off", ...o });
const VOICE: ModeIntentHeard = { spoken: true, verified: false, short: false, overEmber: false };
const TYPED: ModeIntentHeard = { ...VOICE, spoken: false };

describe("modeIntent: a mode named, whole requests only (modes-E1)", () => {
  it("hears a mode by its name, as people say it and the recognizer writes it", () => {
    const cases: [string, ApprovalMode][] = [
      ["Switch to Autopilot", "autopilot"], ["Ember, switch to autopilot mode.", "autopilot"], ["Hey Ember, go to auto pilot", "autopilot"], ["Autopilot mode, please", "autopilot"],
      ["Turn on Autopilot", "autopilot"], ["auto-pilot on", "autopilot"], ["Can you use Autopilot from now on?", "autopilot"],
      ["Assisted mode", "assisted"], ["Switch to Assisted", "assisted"], ["Ember, use assisted mode please", "assisted"],
      ["Go back to Interactive", "interactive"], ["Back to interactive mode", "interactive"], ["Ember, switch back to Interactive.", "interactive"],
    ];
    for (const [said, mode] of cases) expect(modeIntent(said), said).toEqual({ kind: "to", mode });
  });

  it("hears a mode turned off, and keeps today's “work without asking” and “ask me first again”", () => {
    for (const said of ["Turn off Autopilot", "Ember, autopilot off", "Stop Autopilot mode", "Leave autopilot", "Turn autopilot off please"]) expect(modeIntent(said), said).toEqual({ kind: "off", mode: "autopilot" });
    expect(modeIntent("Turn off Assisted")).toEqual({ kind: "off", mode: "assisted" });
    for (const on of ["Ember, work without asking", "Hey Ember, stop asking for permission", "Work without asking from now on.", "You don't need to ask me first", "Can you work without asking?"]) expect(modeIntent(on), on).toEqual({ kind: "without-asking" });
    for (const off of ["Ask me first again", "Ember, ask me first", "Stop working without asking", "Start asking for permission again", "Check with me first"]) expect(modeIntent(off), off).toEqual({ kind: "ask-first" });
  });

  it("leaves everything else to the conversation: a bare name, a question about a mode, a mode inside a longer request", () => {
    for (const other of [
      "Autopilot", "What does Autopilot do?", "Is Autopilot safe?", "Switch to Autopilot and delete my files", "Work on my report without asking Sam",
      "Open the autopilot settings in Tesla", "Ember, stop", "Assisted living near me", "Go to interactive maps", "Open Files",
    ]) expect(modeIntent(other), other).toBeNull();
  });
});

describe("planModeIntent: a mode that asks less, by the spoken-answer rule (modes-E1)", () => {
  it("switches from anyone heard while Voice Match is off, with the mode's card agreed to, and says what the mode does", () => {
    const plan = planModeIntent({ kind: "to", mode: "autopilot" }, state(), VOICE);
    expect(plan).toEqual({ set: "autopilot", reply: expect.stringMatching(/^Okay, I'm in Autopilot: I won't ask before steps, risky ones included.*such as one that would read secrets.*“Go back to Interactive”.*“Ember, stop”/) });
    expect(planModeIntent({ kind: "to", mode: "assisted" }, state(), VOICE)).toEqual({ set: "assisted", reply: expect.stringMatching(/^Okay, I'm in Assisted: .*lighter model.*It can be wrong\./) });
    expect(planModeIntent({ kind: "without-asking" }, state({ inForce: "asking" }), VOICE)).toEqual({ set: "interactive", reply: expect.stringMatching(/^Okay, I'll work without asking.*still ask before anything risky.*“Ask me first again”.*“Ember, stop”/) });
  });

  it("never switches from typed words or a suggestion: it opens the choice in Settings at the mode's row", () => {
    expect(planModeIntent({ kind: "to", mode: "autopilot" }, state(), TYPED)).toEqual({ open: { mode: "autopilot", card: false }, reply: "I switch to a mode that asks less only when you say it or choose it in Settings. I've opened it there: choose Autopilot to switch." });
    expect(planModeIntent({ kind: "without-asking" }, state({ inForce: "asking" }), TYPED).set).toBeUndefined();
  });

  it("never switches on words heard over Ember's own voice, whoever said them", () => {
    for (const voiceMatch of ["off", "on"] as const) {
      const plan = planModeIntent({ kind: "to", mode: "autopilot" }, state({ voiceMatch }), { ...VOICE, verified: true, overEmber: true });
      expect(plan).toEqual({ reply: "I was still speaking, so I didn't take that. Say it again now that I've stopped." });
    }
  });

  it("with Voice Match on, switches only for the owner's verified voice; one too short is asked for a little more; while it isn't ready, for nobody", () => {
    expect(planModeIntent({ kind: "to", mode: "autopilot" }, state({ voiceMatch: "on" }), VOICE)).toEqual({ reply: "That didn't sound like you, so I didn't switch." });
    expect(planModeIntent({ kind: "to", mode: "autopilot" }, state({ voiceMatch: "on" }), { ...VOICE, short: true })).toEqual({ reply: "Say a little more so I can be sure it's you: “Ember, please switch to Autopilot.”" });
    expect(planModeIntent({ kind: "without-asking" }, state({ inForce: "asking", voiceMatch: "on" }), { ...VOICE, short: true }).reply).toBe("Say a little more so I can be sure it's you: “Ember, please work without asking from now on.”");
    expect(planModeIntent({ kind: "to", mode: "autopilot" }, state({ voiceMatch: "on" }), { ...VOICE, verified: true }).set).toBe("autopilot");
    expect(planModeIntent({ kind: "to", mode: "autopilot" }, state({ voiceMatch: "unready" }), { ...VOICE, verified: true })).toEqual({ open: { mode: "autopilot", card: false }, reply: expect.stringMatching(/^Voice Match is on but isn't ready yet/) });
  });

  it("opens the mode's card when it isn't agreed to, whoever asks, and never chooses it", () => {
    for (const heard of [VOICE, TYPED, { ...VOICE, overEmber: true }]) {
      expect(planModeIntent({ kind: "to", mode: "autopilot" }, state({ agreed: ["interactive"] }), heard)).toEqual({ open: { mode: "autopilot", card: true }, reply: "First have a look at what Autopilot means: I've opened its card in Settings. Agree there, and I'll switch to it." });
    }
    expect(planModeIntent({ kind: "without-asking" }, state({ inForce: "asking", agreed: [] }), VOICE)).toEqual({ open: { mode: "interactive", card: true }, reply: "First have a look at what that means: I've opened it in Settings. Agree there, and I'll work without asking." });
  });

  it("holds to the organisation's limits before anything else: below Interactive, the cap, Assisted's check off", () => {
    expect(planModeIntent({ kind: "to", mode: "autopilot" }, state({ inForce: "asking", managed: true }), VOICE)).toEqual({ reply: "Your organisation doesn't allow that, so I'll keep asking first." });
    expect(planModeIntent({ kind: "to", mode: "autopilot" }, state({ cap: "assisted" }), VOICE)).toEqual({ reply: "Your organisation allows Assisted at most, so I can't switch to Autopilot." });
    expect(planModeIntent({ kind: "to", mode: "assisted" }, state({ checkOff: true }), VOICE)).toEqual({ reply: "Your organisation has turned Assisted's check off, so I can't switch to Assisted." });
  });

  it("says what is already so, and changes nothing", () => {
    expect(planModeIntent({ kind: "to", mode: "autopilot" }, state({ inForce: "autopilot" }), VOICE)).toEqual({ reply: "I'm already in Autopilot." });
    expect(planModeIntent({ kind: "without-asking" }, state(), VOICE)).toEqual({ reply: "I'm already working without asking. I still ask before anything risky, and “Ember, stop” stops me." });
    expect(planModeIntent({ kind: "without-asking" }, state({ inForce: "autopilot" }), VOICE)).toEqual({ reply: "I'm already in Autopilot, which asks even less. “Ember, stop” stops me." });
    expect(planModeIntent({ kind: "off", mode: "autopilot" }, state(), VOICE)).toEqual({ reply: "Autopilot isn't on: I'm in Interactive." });
    expect(planModeIntent({ kind: "ask-first" }, state({ inForce: "asking" }), TYPED)).toEqual({ reply: "I already ask you first." });
  });
});

describe("planModeIntent: a mode that asks more, for anyone (modes-E1)", () => {
  it("goes back to Interactive or Assisted for typed words, an unverified voice and words over Ember's voice alike", () => {
    for (const heard of [TYPED, VOICE, { ...VOICE, overEmber: true }]) {
      expect(planModeIntent({ kind: "to", mode: "interactive" }, state({ inForce: "autopilot", voiceMatch: "on" }), heard)).toEqual({ set: "interactive", reply: "Okay, I'm back in Interactive: I work without asking before ordinary steps, and I ask before anything risky." });
      expect(planModeIntent({ kind: "off", mode: "autopilot" }, state({ inForce: "autopilot", voiceMatch: "on" }), heard).set).toBe("interactive");
      expect(planModeIntent({ kind: "to", mode: "assisted" }, state({ inForce: "autopilot", voiceMatch: "unready" }), heard).set).toBe("assisted");
      expect(planModeIntent({ kind: "ask-first" }, state({ inForce: "autopilot" }), heard)).toEqual({ set: "asking", reply: "Okay, I'll ask you first again. To change it back, choose Interactive in Settings." });
      expect(planModeIntent({ kind: "off", mode: "interactive" }, state(), heard).set).toBe("asking");
    }
  });

  it("says honestly where it lands when that mode's card isn't agreed to, and opens it", () => {
    expect(planModeIntent({ kind: "to", mode: "interactive" }, state({ inForce: "autopilot", agreed: ["autopilot"] }), TYPED)).toEqual({ set: "interactive", open: { mode: "interactive", card: true }, reply: "Okay, but Interactive's card isn't agreed to yet, so until then I'll ask you before every step. I've opened it in Settings." });
    expect(planModeIntent({ kind: "to", mode: "assisted" }, state({ inForce: "autopilot", agreed: ["interactive", "autopilot"] }), TYPED).reply).toBe("Okay, but Assisted's card isn't agreed to yet, so until then I'm in Interactive. I've opened it in Settings.");
  });
});

describe("the mode by voice and typed words through the host, as main wires it (modes-E1)", () => {
  const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
  const host = (approvals: ApprovalsSetting | null, o: { voiceMatch?: "off" | "on" | "unready"; policy?: object } = {}) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-mode-intent-"));
    // As the user left it in Home last time: found so at start.
    if (approvals) fs.writeFileSync(path.join(dir, "settings.json"), JSON.stringify({ approvals }));
    const settings = new SettingsStore(path.join(dir, "settings.json"));
    settings.load();
    const policy = o.policy ? AdminPolicySchema.parse(o.policy) : null;
    const modes = new ModeRecord({ settings, admin: () => policy, log: quiet });
    const audit = new AuditLog(path.join(dir, "audit"));
    modes.opened(audit);
    const answers: string[] = [];
    const opened: [ApprovalMode, boolean][] = [];
    const h = new AgentHost({
      userData: dir, runtimePath: "/nowhere/copilot-runtime", settings, log: quiet, setState: () => undefined, onStatus: () => undefined, onAnswer: t => answers.push(t),
      autonomy: { ...modeIntents({ settings, modes, admin: () => policy, voiceMatch: () => o.voiceMatch ?? "off" }), open: (mode, card) => { opened.push([mode, card]); } },
    });
    const entries = () => audit.recent(50).filter(e => e.event === "autonomy" && !e.atStart).reverse().map(e => [e.mode, e.before, e.via, e.verified]);
    return { h, settings, answers, opened, entries, inForce: () => modeInForce(settings.get().approvals, policy) };
  };

  it("switches to Autopilot for anyone heard, records it as by voice, and the record keeps it (not taken for a hand edit)", async () => {
    const c = host(ALL_AGREED("interactive"));
    expect(await c.h.ask("Ember, switch to Autopilot", null, c.h.stopEpoch, { spoken: true })).toBe(true);
    expect(c.inForce()).toBe("autopilot");
    expect(c.answers.at(-1)).toMatch(/^Okay, I'm in Autopilot/);
    expect(c.entries()).toEqual([["autopilot", "interactive", "voice", false]]);
    // Typed words take it back, for anyone.
    await c.h.ask("go back to interactive");
    expect(c.inForce()).toBe("interactive");
    expect(c.entries().at(-1)).toEqual(["interactive", "autopilot", "typed", false]);
  });

  it("never switches to a mode that asks less from typed words, a suggestion, or words heard over Ember's voice", async () => {
    const c = host(ALL_AGREED("interactive"));
    await c.h.ask("Switch to Autopilot");
    await c.h.ask("Switch to Autopilot", null, c.h.stopEpoch, { spoken: true, suggested: true });
    await c.h.ask("Switch to Autopilot", null, c.h.stopEpoch, { spoken: true, overEmber: true });
    expect(c.inForce()).toBe("interactive");
    expect(c.entries()).toEqual([]);
    expect(c.opened).toEqual([["autopilot", false], ["autopilot", false]]);
    expect(c.answers.at(-1)).toBe("I was still speaking, so I didn't take that. Say it again now that I've stopped.");
  });

  it("with Voice Match on, switches only for the owner's verified voice, and says so in the record", async () => {
    const c = host(ALL_AGREED("interactive"), { voiceMatch: "on" });
    await c.h.ask("Assisted mode", null, c.h.stopEpoch, { spoken: true });
    expect(c.inForce()).toBe("interactive");
    await c.h.ask("Assisted mode", null, c.h.stopEpoch, { spoken: true, verified: true });
    expect(c.inForce()).toBe("assisted");
    expect(c.entries()).toEqual([["assisted", "interactive", "voice", true]]);
  });

  it("opens a mode's card instead of choosing it before it is agreed to, and agrees to nothing", async () => {
    const c = host(null);
    await c.h.ask("Switch to Autopilot", null, c.h.stopEpoch, { spoken: true });
    expect(c.inForce()).toBe("asking");
    expect(c.settings.own().approvals.consent.autopilot).toEqual(NONE);
    expect(c.opened).toEqual([["autopilot", true]]);
    expect(c.entries()).toEqual([]);
  });

  it("keeps the organisation's cap whoever asks", async () => {
    const c = host(ALL_AGREED("interactive"), { policy: { approvals: { maxMode: "assisted" } } });
    await c.h.ask("Switch to Autopilot", null, c.h.stopEpoch, { spoken: true });
    expect(c.inForce()).toBe("interactive");
    expect(c.answers.at(-1)).toBe("Your organisation allows Assisted at most, so I can't switch to Autopilot.");
  });

  it("never says it switched when the change couldn't be recorded (review of #127)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-mode-intent-"));
    const settings = new SettingsStore(path.join(dir, "settings.json"));
    settings.load();
    const answers: string[] = [];
    const h = new AgentHost({
      userData: dir, runtimePath: "/nowhere/copilot-runtime", settings, log: quiet, setState: () => undefined, onStatus: () => undefined, onAnswer: t => answers.push(t),
      autonomy: { state: () => state(), set: () => false, open: () => undefined },
    });
    await h.ask("Ember, switch to Autopilot", null, h.stopEpoch, { spoken: true });
    expect(answers).toEqual([AUTONOMY_NOT_SAVED]);
  });
});

describe("Home opens at the mode asked for (modes-E1)", () => {
  it("names each mode's row and card, so a voice request shows the card of the mode it named", () => {
    for (const [mode, name] of [["interactive", "autonomy"], ["assisted", "assisted"], ["autopilot", "autopilot"]] as const) {
      expect(sectionRequest(`privacy:${name}-on`)).toEqual({ section: "privacy", control: `mode-${mode}` });
      expect(sectionRequest(`privacy:${name}-yes`)).toEqual({ section: "privacy", control: "approvals-yes" });
      expect(modeCardRequested(`privacy:${name}-yes`)).toBe(mode);
      expect(modeCardRequested(`privacy:${name}-on`)).toBeNull();
    }
  });

  it("is what main gives the host: Voice Match's switch as a spoken yes reads it, and the request for the mode's row or card (source pin)", () => {
    const main = fs.readFileSync(path.join(__dirname, "../../app/main/main.ts"), "utf8");
    expect(main).toContain(`...modeIntents({ settings, modes, admin: () => policy, voiceMatch: () => (!settings.get().voice.match ? "off" : matchNow() ? "on" : "unready") }),`);
    expect(main).toContain("open: (mode, card) => { showHome(); sendToHome(IPC.focusSection, `privacy:${mode === \"interactive\" ? \"autonomy\" : mode}-${card ? \"yes\" : \"on\"}`); },");
  });
});
