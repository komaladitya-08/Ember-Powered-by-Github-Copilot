/**
 * First run's one agreement (owner decision of 2026-11-12; app/shared/first-run.ts, app/main/first-run.ts): which rows
 * are shown and offered, what pressing it records and in what order, what a failure part-way leaves, and that each
 * row's text is its own card's, from one source.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agreeFirstRun, firstRunView, registerFirstRunIpc, type FirstRunDeps } from "../../app/main/first-run";
import { SettingsStore, hasConsent, type Settings, type SettingsPatch } from "../../app/main/settings";
import { CONSENT_VERSION, FEATURE_CONSENT_VERSION } from "../../app/shared/consent";
import { FIRST_RUN_IPC, FIRST_RUN_ROWS, firstRunDefaults, firstRunPlan, firstRunRows, type FirstRunChoice, type FirstRunFacts, type FirstRunRow } from "../../app/shared/first-run";
import { firstRunRowText } from "../../app/renderer/home/welcome-copy";
import { AUTONOMY_CONSENT_TEXT, MEMORY_CONSENT_TEXT, MODE_CARD_TEXT, SCREEN_IMAGES_TEXT } from "../../app/renderer/home/copy";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

const ALL = { commands: true, memory: true, voice: true, screenshots: true, interactive: true } as const;
const facts = (more: Partial<FirstRunFacts> = {}): FirstRunFacts => ({
  returning: false, locked: false, allowed: { ...ALL }, modelsReady: true, interactiveAgreed: false, commandsCard: true, ...more,
});
/** Every combination of the five switches. */
const combos = (): FirstRunChoice[] => Array.from({ length: 32 }, (_, n) => Object.fromEntries(FIRST_RUN_ROWS.map((r, i) => [r, (n & (1 << i)) !== 0])) as FirstRunChoice);
const NOW = new Date("2026-11-13T10:00:00.000Z");
const SHA = "a".repeat(64);

/** A real settings file, and the paths the agreement goes through, each of which a test can make fail. */
function rig(o: { settings?: SettingsPatch; facts?: Partial<FirstRunFacts>; fail?: Partial<Record<FirstRunRow | "consent" | "offWrite", boolean>>; sha?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-first-run-"));
  dirs.push(dir);
  const store = new SettingsStore(path.join(dir, "settings.json"), null);
  store.load();
  if (o.settings) store.update(o.settings);
  const order: string[] = [];
  let current = facts(o.facts);
  const settings = {
    own: () => store.own(),
    update: (p: SettingsPatch) => {
      if (o.fail?.offWrite && (p.screenImages === false || p.speak === false || p.wakeWord === false)) throw new Error("disk full");
      const key = "consent" in p ? "consent" : "memory" in p ? "memory" : "voice" in p || "speak" in p ? "voice" : "screenImages" in p ? "screenshots" : "other";
      if (o.fail?.[key as FirstRunRow | "consent"]) throw new Error("disk full");
      order.push(key);
      return store.update(p);
    },
  };
  const d: FirstRunDeps = {
    facts: () => current, consented: () => hasConsent(store.own()),
    commandsCard: () => ({ title: "Let Ember run commands on this computer?", body: ["One.", "Two."], sha256: o.sha ?? SHA }),
    settings,
    agreeCommands: sha => {
      if (o.fail?.commands || sha !== (o.sha ?? SHA)) return false;
      order.push("commands");
      const own = store.own().commands;
      store.update({ commands: { ...own, local: { on: true, askEvery: false, consent: { version: FEATURE_CONSENT_VERSION.commands, at: NOW.toISOString() } } } });
      return true;
    },
    chooseInteractive: () => {
      // As main's: the card's record and the mode, and false (undone) where its audit entry couldn't be written.
      if (o.fail?.interactive) return false;
      order.push("interactive");
      store.update({ approvals: { mode: "interactive", consent: { ...store.own().approvals.consent, interactive: { version: FEATURE_CONSENT_VERSION.autonomy, at: NOW.toISOString() } } } });
      return true;
    },
    now: () => NOW,
  };
  return { d, store, order, setFacts: (f: Partial<FirstRunFacts>) => { current = facts(f); } };
}

/** What is on, with its own consent, in a settings file. */
function onWithConsent(s: Settings): Record<FirstRunRow, boolean> {
  return {
    commands: s.commands.local?.on === true && (s.commands.local.consent.version ?? 0) >= FEATURE_CONSENT_VERSION.commands,
    memory: s.memory.on && s.memory.consent.version >= FEATURE_CONSENT_VERSION.memory,
    voice: s.wakeWord && s.voice.consent && s.speak,
    screenshots: s.screenImages,
    interactive: s.approvals.consent.interactive.version >= FEATURE_CONSENT_VERSION.autonomy,
  };
}

describe("first run's rows", () => {
  it("shows all five to someone new, each offered and on by default (slice4-1)", () => {
    const rows = firstRunRows(facts());
    expect(rows.map(r => r.row)).toEqual(["commands", "memory", "voice", "screenshots", "interactive"]);
    expect(rows.every(r => r.offered && r.why === null)).toBe(true);
    expect(firstRunDefaults(rows)).toEqual(ALL);
  });

  it("shows someone who agreed before only Interactive's row while its card isn't agreed, and none once it is (slice4-2)", () => {
    expect(firstRunRows(facts({ returning: true }))).toEqual([{ row: "interactive", offered: true, why: null }]);
    expect(firstRunRows(facts({ returning: true, interactiveAgreed: true }))).toEqual([]);
  });

  it.each(FIRST_RUN_ROWS)("shows %s off and managed when the organisation turned it off, and the agreement gives it nothing (slice4-3)", row => {
    const f = facts({ allowed: { ...ALL, [row]: false } });
    const rows = firstRunRows(f);
    expect(rows.find(r => r.row === row)).toEqual({ row, offered: false, why: "organisation" });
    expect(rows.filter(r => r.row !== row).every(r => r.offered)).toBe(true);
    expect(firstRunDefaults(rows)[row]).toBe(false);
    expect(firstRunPlan(f, ALL).on).not.toContain(row);
    expect(firstRunPlan(f, ALL).off).not.toContain(row);
  });

  it("shows every row off and managed under a lockdown, and turns nothing on (slice4-4)", () => {
    const f = facts({ locked: true, allowed: { commands: false, memory: false, voice: false, screenshots: false, interactive: false } });
    expect(firstRunRows(f).every(r => !r.offered && r.why === "locked")).toBe(true);
    expect(firstRunPlan(f, ALL)).toEqual({ on: [], off: [] });
    // A lockdown wins even where a feature would read as allowed.
    expect(firstRunRows(facts({ locked: true })).every(r => r.why === "locked")).toBe(true);
  });

  it("keeps listening off without the speech models, saying they must be downloaded first (slice4-5)", () => {
    const f = facts({ modelsReady: false });
    expect(firstRunRows(f).find(r => r.row === "voice")).toEqual({ row: "voice", offered: false, why: "models" });
    expect(firstRunPlan(f, ALL).on).toEqual(["commands", "memory", "screenshots", "interactive"]);
    expect(firstRunPlan(f, ALL).off).toEqual([]);
  });

  it("offers no commands row it can't show the card for (slice4-6)", () => {
    expect(firstRunRows(facts({ commandsCard: false })).find(r => r.row === "commands")).toEqual({ row: "commands", offered: false, why: "unavailable" });
  });

  it("turns on exactly the offered rows left on, for every combination of the five switches, new or returning (slice4-7)", () => {
    for (const returning of [false, true]) {
      for (const choice of combos()) {
        const plan = firstRunPlan(facts({ returning }), choice);
        const shown = returning ? ["interactive"] : FIRST_RUN_ROWS;
        expect(plan.on).toEqual(FIRST_RUN_ROWS.filter(r => shown.includes(r) && choice[r]));
        // A new user's switched-off rows that a fresh file starts on are written off; a returning user's never.
        expect(plan.off).toEqual(returning ? [] : (["voice", "screenshots"] as const).filter(r => !choice[r]));
      }
    }
  });
});

describe("first run's agreement", () => {
  it("records the consent first, then each row left on with its own card's record, for every combination (slice4-8)", () => {
    for (const choice of combos()) {
      const r = rig();
      expect(agreeFirstRun(r.d, choice, SHA)).toEqual({ ok: true, failed: [] });
      const s = r.store.own();
      expect(s.consent).toEqual({ version: CONSENT_VERSION, at: NOW.toISOString() });
      expect(r.order[0]).toBe("consent");
      const on = onWithConsent(s);
      for (const row of FIRST_RUN_ROWS) expect([row, on[row]]).toEqual([row, choice[row]]);
      // A row turned off records nothing for it.
      if (!choice.commands) expect(s.commands.local).toBeUndefined();
      if (!choice.memory) expect(s.memory.consent).toEqual({ version: 0, at: null });
      if (!choice.voice) expect([s.voice.consent, s.wakeWord, s.speak]).toEqual([false, false, false]);
      if (!choice.interactive) expect(s.approvals.consent.interactive).toEqual({ version: 0, at: null });
      // Voice Match is never turned on here.
      expect(s.voice.match).toBe(false);
    }
  });

  it("records nothing and turns nothing on when the consent can't be saved (slice4-9)", () => {
    const r = rig({ fail: { consent: true } });
    expect(agreeFirstRun(r.d, ALL, SHA)).toEqual({ ok: false, failed: [] });
    const s = r.store.own();
    expect(s.consent.version).toBe(0);
    expect(r.order).toEqual([]);
    expect(onWithConsent(s)).toMatchObject({ commands: false, memory: false, voice: false, interactive: false });
  });

  it.each(FIRST_RUN_ROWS)("leaves %s off without its consent when its own record fails, the rest on, and says so (slice4-10)", row => {
    const r = rig({ fail: { [row]: true } });
    expect(agreeFirstRun(r.d, ALL, SHA)).toEqual({ ok: true, failed: [row] });
    const on = onWithConsent(r.store.own());
    for (const other of FIRST_RUN_ROWS) if (other !== row) expect([other, on[other]]).toEqual([other, true]);
    // Screenshots are on in a fresh file already (under the consent's own text): the failure leaves the file's value.
    if (row !== "screenshots") expect(on[row]).toBe(false);
  });

  it("never leaves a row the user switched off on when writing it off fails: the agreement isn't saved and says so (slice4-x9-1)", () => {
    const NONE = { commands: false, memory: false, voice: false, screenshots: false, interactive: false };
    const r = rig({ fail: { offWrite: true } });
    expect(agreeFirstRun(r.d, NONE, SHA)).toEqual({ ok: false, failed: [] });
    const s = r.store.own();
    // Nothing is in force without the consent, so the file's own defaults do nothing yet.
    expect(hasConsent(s)).toBe(false);
    // Written with the consent itself: a saved agreement holds them off.
    const ok = rig();
    expect(agreeFirstRun(ok.d, NONE, SHA)).toEqual({ ok: true, failed: [] });
    expect([ok.store.own().screenImages, ok.store.own().speak, ok.store.own().wakeWord]).toEqual([false, false, false]);
    expect(ok.order).toEqual(["consent"]);
  });

  it("doesn't turn commands on for a card other than the one the row showed (slice4-11)", () => {
    const r = rig();
    expect(agreeFirstRun(r.d, ALL, "b".repeat(64))).toEqual({ ok: true, failed: ["commands"] });
    expect(r.store.own().commands.local).toBeUndefined();
    const n = rig();
    expect(agreeFirstRun(n.d, ALL, null)).toEqual({ ok: true, failed: ["commands"] });
    expect(n.store.own().commands.local).toBeUndefined();
  });

  it("reads the facts again when pressed: what the policy or the models no longer allow gets nothing (slice4-12)", () => {
    const r = rig();
    r.setFacts({ modelsReady: false, allowed: { ...ALL, memory: false } });
    expect(agreeFirstRun(r.d, ALL, SHA)).toEqual({ ok: true, failed: [] });
    const s = r.store.own();
    expect([s.voice.consent, s.memory.on, s.memory.consent.version]).toEqual([false, false, 0]);
  });

  it("leaves a returning user's own settings as they are, adding only Interactive (slice4-13)", () => {
    const before: SettingsPatch = { consent: { version: CONSENT_VERSION - 1, at: "2026-11-01T00:00:00.000Z" }, speak: false, screenImages: false, wakeWord: true };
    const r = rig({ settings: before, facts: { returning: true } });
    expect(agreeFirstRun(r.d, ALL, SHA)).toEqual({ ok: true, failed: [] });
    const s = r.store.own();
    expect(r.order).toEqual(["consent", "interactive"]);
    expect([s.speak, s.screenImages, s.voice.consent, s.memory.on, s.commands.local]).toEqual([false, false, false, false, undefined]);
    expect(onWithConsent(s).interactive).toBe(true);
    // Interactive's row switched off: the consent alone.
    const off = rig({ settings: before, facts: { returning: true } });
    agreeFirstRun(off.d, { ...ALL, interactive: false }, SHA);
    expect(off.order).toEqual(["consent"]);
  });

  it("does nothing once the current consent is recorded, and shows no rows then (slice4-14)", () => {
    const r = rig({ settings: { consent: { version: CONSENT_VERSION, at: "2026-11-12T00:00:00.000Z" } } });
    expect(agreeFirstRun(r.d, ALL, SHA)).toEqual({ ok: true, failed: [] });
    expect(r.order).toEqual([]);
    expect(firstRunView(r.d)).toEqual({ rows: [], commands: null });
  });

  it("shows the commands card with its row, and none without it (slice4-15)", () => {
    const r = rig();
    expect(firstRunView(r.d).commands).toMatchObject({ title: "Let Ember run commands on this computer?", sha256: SHA });
    r.setFacts({ returning: true });
    expect(firstRunView(r.d)).toEqual({ rows: [{ row: "interactive", offered: true, why: null }], commands: null });
  });
});

describe("first run's channels", () => {
  const channels = (d: FirstRunDeps, trusted = true) => {
    const h = new Map<string, (e: { sender: unknown }, ...a: unknown[]) => unknown>();
    registerFirstRunIpc({ handle: (c, fn) => { h.set(c, fn); } }, () => trusted, d);
    return h;
  };

  it("answers only the settings window (slice4-16)", () => {
    const r = rig();
    const h = channels(r.d, false);
    expect(() => h.get(FIRST_RUN_IPC.agree)!({ sender: {} }, ALL, SHA)).toThrow(/untrusted/);
    expect(() => h.get(FIRST_RUN_IPC.view)!({ sender: {} })).toThrow(/untrusted/);
    expect(r.store.own().consent.version).toBe(0);
  });

  it("records nothing for arguments that aren't exactly the five switches and a hash (slice4-17)", () => {
    const r = rig();
    const agree = channels(r.d).get(FIRST_RUN_IPC.agree)!;
    for (const bad of [[], [ALL], [{ ...ALL, vault: true }, SHA], [{ ...ALL, memory: "yes" }, SHA], [ALL, "nothex"], ["all", null]]) {
      expect(agree({ sender: {} }, ...bad)).toEqual({ ok: false, failed: [] });
    }
    expect(r.store.own().consent.version).toBe(0);
    expect(agree({ sender: {} }, ALL, SHA)).toEqual({ ok: true, failed: [] });
  });
});

describe("each row's text", () => {
  it("is its own card's or switch's, from the one source Settings shows it from (slice4-18)", () => {
    const card = { title: "Let Ember run commands on this computer?", body: ["A.", "B."], sha256: SHA };
    expect(firstRunRowText("commands", { commands: card, voice: "" })).toEqual([card.title, ...card.body]);
    expect(firstRunRowText("memory", { commands: null, voice: "" })).toEqual([MEMORY_CONSENT_TEXT]);
    expect(firstRunRowText("voice", { commands: null, voice: "The card." })).toEqual(["The card."]);
    expect(firstRunRowText("screenshots", { commands: null, voice: "" })).toEqual([SCREEN_IMAGES_TEXT.hint]);
    expect(firstRunRowText("interactive", { commands: null, voice: "" })).toEqual([AUTONOMY_CONSENT_TEXT]);
    expect(MODE_CARD_TEXT.interactive).toBe(AUTONOMY_CONSENT_TEXT);
    // Home's own screenshots switch says the same words in its markup.
    const html = fs.readFileSync(path.join(__dirname, "../../app/renderer/home/index.html"), "utf8");
    expect(html).toContain(`<p class="row-note" id="screen-images-hint">${SCREEN_IMAGES_TEXT.hint}</p>`);
  });
});
