/**
 * What Home says about asking is true in the approval mode in force (round ten: home-r10-1, home-c10-1, home-c10-2):
 * each place that says Ember asks first words it from the mode (null: below Interactive, asking as before the modes),
 * through one pure function per place, and the page draws those words.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as cc from "../../app/renderer/home/computers-copy";
import { connectorsHint, CONNECTORS_HINT } from "../../app/renderer/home/extensions-copy";
import { grantsHint, privacyFoldWords, routinesHint } from "../../app/renderer/home/copy";
import type { Settings } from "../../app/main/settings";
import type { TargetSummary } from "../../app/shared/targets";
import type { ApprovalMode } from "../../app/shared/approvals";

const MODES: readonly (ApprovalMode | null)[] = [null, "interactive", "assisted", "autopilot"];
const page = readFileSync(new URL("../../app/renderer/home/index.html", import.meta.url), "utf8");
const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("“Ask me before every command” on a computer where commands run as root or an administrator (home-c10-1)", () => {
  const on = { on: true, askEvery: false, consent: { version: 1, at: null } };
  const local: TargetSummary = { id: "local", kind: "local", label: "This computer", state: "ready", can: "apps and commands", active: true, privileged: true };
  const settings = (askEvery: boolean) => ({ targets: { active: "local", offerSsh: true, dismissedOffers: [], hosts: [], wsl: { on: false }, pcId: "" }, commands: { local: { ...on, askEvery } } }) as unknown as Settings;
  const row = (mode: ApprovalMode | null, askEvery = false, admin: cc.TargetsAdmin = { source: null, features: {} }) =>
    cc.commandsView({ summaries: [local], settings: settings(askEvery), admin, mode }).rows[0];

  it("shows on and locked, saying every command asks, in every mode that asks about root", () => {
    for (const mode of [null, "interactive", "assisted"] as const) {
      expect(row(mode).askEvery).toMatchObject({ checked: true, disabled: true });
      expect(row(mode).managed).toBe(cc.ASK_EVERY_PRIVILEGED);
    }
  });

  it("in Autopilot, is the user's own switch, free to turn on, and says root commands run without asking unless it is on", () => {
    expect(row("autopilot").askEvery).toMatchObject({ checked: false, disabled: false, shown: true });
    expect(row("autopilot", true).askEvery).toMatchObject({ checked: true, disabled: false });
    expect(row("autopilot").managed).toBe("Commands here run as the administrator. In Autopilot each one runs without asking, after a few seconds to stop it, unless you turn this on.");
    expect(row("autopilot").managed).not.toMatch(/asks before every one/);
  });

  it("stays locked in Autopilot where the organisation asks before every command", () => {
    const v = row("autopilot", false, { source: "p", features: {}, commands: { local: "ask", wsl: "on", ssh: "on" } });
    expect(v.askEvery).toMatchObject({ checked: true, disabled: true });
    expect(v.managed).toBe(cc.ASK_EVERY_MANAGED);
  });

  it("is drawn with the mode in force (Home tells the Commands pane)", () => {
    const pane = readFileSync(new URL("../../app/renderer/home/computers.ts", import.meta.url), "utf8");
    expect(pane).toContain("commandsView({ summaries: summaries!, settings: settings!, admin, mode })");
    const main = readFileSync(new URL("../../app/renderer/home/main.ts", import.meta.url), "utf8");
    expect(main).toContain("targetsMode(view.inForce);");
  });
});

describe("Apps & privacy says what Ember asks before in the mode in force (home-r10-1)", () => {
  const hand = " in an app unless you turn on Interactive, when you agree or later in settings, and always before anything hard to undo. It never lets the AI model type or see passwords. Only in Autopilot, it can fill in a login, a card or contact details from its vault, which the AI model never sees. ";
  const fold = (mode: ApprovalMode | null) => `${privacyFoldWords("It asks before acting", { screenImages: true, autonomy: mode })}${privacyFoldWords(hand, { screenImages: true, autonomy: mode })}`;

  it("says risky steps ask in Interactive, go to the check in Assisted, and don't ask in Autopilot", () => {
    expect(fold("interactive")).toBe("It asks before acting on anything risky or hard to undo. For ordinary steps it tells you what it's doing instead (How Ember asks, below). It never lets the AI model type or see passwords. Only in Autopilot, it can fill in a login, a card or contact details from its vault, which the AI model never sees. ");
    expect(fold("assisted")).toBe("It asks before acting on anything risky or hard to undo, unless Assisted's check finds the step in what you asked: then it goes ahead and tells you. For ordinary steps it tells you what it's doing instead (How Ember asks, below). It never lets the AI model type or see passwords. Only in Autopilot, it can fill in a login, a card or contact details from its vault, which the AI model never sees. ");
    expect(fold("autopilot")).toBe("It doesn't ask before acting, even on anything risky or hard to undo: Autopilot is on, so it tells you what it's doing as it goes and asks only where How Ember asks, below, says. It never lets the AI model type or see passwords. Only in Autopilot, it can fill in a login, a card or contact details from its vault, which the AI model never sees. ");
    expect(fold(null)).toBe("It asks before acting in an app, and always before anything hard to undo. It never lets the AI model type or see passwords. Only in Autopilot, it can fill in a login, a card or contact details from its vault, which the AI model never sees. ");
  });

  it("words the hint under the apps Ember may act in for the mode in force", () => {
    const html = page.match(/<p class="hint" id="grants-hint">([^<]*)<\/p>/)?.[1];
    expect(html).toBe(grantsHint(null));
    expect(grantsHint("interactive")).toBe(grantsHint(null));
    expect(grantsHint(null)).toBe("You add an app here by choosing “Always in …” when Ember asks. Ember still asks every time before anything hard to undo.");
    expect(grantsHint("assisted")).toBe("You add an app here by choosing “Always in …” when Ember asks. Before anything hard to undo, Ember asks every time unless Assisted's check finds the step in what you asked.");
    expect(grantsHint("autopilot")).toBe("You add an app here by choosing “Always in …” when Ember asks. Autopilot doesn't ask, even before anything hard to undo, so this list changes nothing while it is on.");
  });

  it("passes the mode in force, not whether one is, to the copy of the consent", () => {
    const main = readFileSync(new URL("../../app/renderer/home/main.ts", import.meta.url), "utf8");
    expect(main).toContain("autonomy: approvalsView(approvalsNow, managed.has(\"autonomy\")).inForce,");
    expect(main).toContain("$(\"grants-hint\").textContent = grantsHint(modeNow)");
  });
});

describe("the Commands intro, the Routines hint and the Connectors hint are true in every mode (home-c10-2)", () => {
  it("says what commands ask before, per mode", () => {
    expect(text(page)).toContain(cc.commandsIntro(null));
    expect(page).toContain(`<p class="intro" id="commands-intro">${cc.commandsIntro(null)}</p>`);
    expect(cc.commandsIntro("interactive")).toBe(cc.COMMANDS_INTRO);
    expect(cc.commandsIntro("assisted")).toBe("Ember runs commands in its own command window, where you can watch and stop them. It asks first before anything that touches secrets, and before anything that deletes, publishes or changes the system unless Assisted's check finds it in what you asked.");
    expect(cc.commandsIntro("autopilot")).toBe("Ember runs commands in its own command window, where you can watch and stop them. In Autopilot it runs one that deletes, publishes or changes the system without asking, after a few seconds to stop it. It still asks before anything that touches secrets or whose effect it can't tell.");
  });

  it("says what a routine's steps ask before, per mode", () => {
    expect(page).toContain(`<p class="hint" id="routines-hint">${routinesHint(null)}</p>`);
    expect(routinesHint("interactive")).toBe(routinesHint(null));
    expect(routinesHint("assisted")).toBe("Off, reminders last until Ember closes, and no routine is saved or run. On, saying a routine's name runs its steps, and Ember still asks before anything risky unless Assisted's check finds it in the routine's steps.");
    expect(routinesHint("autopilot")).toBe("Off, reminders last until Ember closes, and no routine is saved or run. On, saying a routine's name runs its steps, and in Autopilot Ember doesn't ask first, even before anything risky: it tells you as it goes.");
  });

  it("says what an extension's tools ask before, per mode (Assisted asks: the extensions gate isn't checked)", () => {
    expect(page).toContain(`<p class="hint" id="connectors-hint">${connectorsHint(null)}</p>`);
    for (const m of [null, "interactive", "assisted"] as const) expect(connectorsHint(m)).toBe(CONNECTORS_HINT);
    expect(connectorsHint("autopilot")).toBe("To use an MCP server, add its plugin's marketplace above. Ember loads the plugin's MCP tools, and in Autopilot uses those that can change things without asking, telling you as it goes.");
  });

  it("never says Ember asks before risky things in Autopilot, in any of these places", () => {
    const said = [cc.commandsIntro("autopilot"), routinesHint("autopilot"), connectorsHint("autopilot"), grantsHint("autopilot")];
    for (const s of said) expect(s).not.toMatch(/asks (first )?before (anything (risky|that deletes)|tools that can change)|still asks every time/);
    for (const m of MODES) for (const f of [cc.commandsIntro, routinesHint, connectorsHint, grantsHint]) expect(f(m).length).toBeGreaterThan(20);
  });

  it("are drawn from the mode in force", () => {
    const main = readFileSync(new URL("../../app/renderer/home/main.ts", import.meta.url), "utf8");
    for (const s of ["$(\"routines-hint\").textContent = routinesHint(modeNow)", "$(\"connectors-hint\").textContent = connectorsHint(modeNow)"]) expect(main).toContain(s);
    const pane = readFileSync(new URL("../../app/renderer/home/computers.ts", import.meta.url), "utf8");
    expect(pane).toContain("commandsIntro(mode)");
  });
});
