/**
 * What Home says about asking is true in the approval mode in force (round ten: home-r10-1, home-c10-1, home-c10-2):
 * each place that says Ember asks first words it from the mode (null: below Interactive, asking as before the modes),
 * through one pure function per place, and the page draws those words.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as cc from "../../app/renderer/home/computers-copy";
import { connectorsHint, CONNECTORS_HINT } from "../../app/renderer/home/extensions-copy";
import { AUTONOMY_CONSENT_TEXT, MODE_LINE, describeEntry, grantsHint, privacyFoldWords, routinesHint } from "../../app/renderer/home/copy";
import { FEATURE_CONSENT_VERSION } from "../../app/shared/consent";
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

  it("in Autopilot, is the user's own switch, free to turn on, and says root commands run without asking unless it is on, but those Autopilot still asks about (r10-modes-copy-y10-2)", () => {
    expect(row("autopilot").askEvery).toMatchObject({ checked: false, disabled: false, shown: true });
    expect(row("autopilot", true).askEvery).toMatchObject({ checked: true, disabled: false });
    expect(row("autopilot").managed).toBe("Commands here run as the administrator. In Autopilot each one runs without asking, after a few seconds to stop it, except those Autopilot still asks about, unless you turn this on.");
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
  const hand = " in an app unless you turn on Interactive, when you agree or later in settings. It also asks before anything hard to undo, unless you asked for exactly that command (it shows it first, with a few seconds to stop it) or later choose Assisted or Autopilot in settings, which ask less. It never lets the AI model type or see passwords. Only in Autopilot, it can fill in a login, a card or contact details from its vault, which the AI model never sees. ";
  const fold = (mode: ApprovalMode | null) => `${privacyFoldWords("It asks before acting", { screenImages: true, autonomy: mode })}${privacyFoldWords(hand, { screenImages: true, autonomy: mode })}`;

  it("says risky steps ask in Interactive, go to the check in Assisted, and don't ask in Autopilot", () => {
    expect(fold("interactive")).toBe("It asks before acting on anything risky or hard to undo, except a command you asked for exactly, which it shows you first with a few seconds to stop it. For ordinary steps it tells you what it's doing instead (How Ember asks, below). It never lets the AI model type or see passwords. Only in Autopilot, it can fill in a login, a card or contact details from its vault, which the AI model never sees. ");
    expect(fold("assisted")).toBe("It asks before acting on anything risky or hard to undo, unless Assisted's check finds the step in what you asked, or it is a command you asked for exactly: then it goes ahead and tells you. For ordinary steps it tells you what it's doing instead (How Ember asks, below). It never lets the AI model type or see passwords. Only in Autopilot, it can fill in a login, a card or contact details from its vault, which the AI model never sees. ");
    expect(fold("autopilot")).toBe("It doesn't ask before acting, even on anything risky or hard to undo: Autopilot is on, so it tells you what it's doing as it goes and asks only where How Ember asks, below, says. It never lets the AI model type or see passwords. Only in Autopilot, it can fill in a login, a card or contact details from its vault, which the AI model never sees. ");
    expect(fold(null)).toBe("It asks before acting in an app, and always before anything hard to undo, except a command you asked for exactly, which it shows you first with a few seconds to stop it. It never lets the AI model type or see passwords. Only in Autopilot, it can fill in a login, a card or contact details from its vault, which the AI model never sees. ");
  });

  it("words the hint under the apps Ember may act in for the mode in force", () => {
    const html = page.match(/<p class="hint" id="grants-hint">([^<]*)<\/p>/)?.[1];
    expect(html).toBe(grantsHint(null));
    expect(grantsHint("interactive")).toBe(grantsHint(null));
    expect(grantsHint(null)).toBe("You add an app here by choosing “Always in …” when Ember asks. Ember still asks every time before anything hard to undo in an app.");
    expect(grantsHint("assisted")).toBe("You add an app here by choosing “Always in …” when Ember asks. Before anything hard to undo in an app, Ember asks every time unless Assisted's check finds the step in what you asked.");
    expect(grantsHint("autopilot")).toBe("You add an app here by choosing “Always in …” when Ember asks. Autopilot doesn't ask, even before anything hard to undo, so this list changes nothing while it is on.");
  });

  it("passes the mode in force, not whether one is, to the copy of the consent", () => {
    const main = readFileSync(new URL("../../app/renderer/home/main.ts", import.meta.url), "utf8");
    expect(main).toContain("autonomy: approvalsView(approvalsNow, managed.has(\"autonomy\")).inForce,");
    expect(main).toContain("$(\"grants-hint\").textContent = grantsHint(modeNow)");
  });
});

describe("“Ask me before every command” in a distro Podman uses (r10-modes-copy-x10-4)", () => {
  // Every command there asks in every mode (wsl-service's userAskEvery), Autopilot included; the row showed the switch
  // off and free, and as root in Autopilot said each one runs without asking unless it is turned on.
  const on = { on: true, askEvery: false, consent: { version: 1, at: null } };
  const pod = (privileged: boolean): TargetSummary => ({ id: "wsl:podman-machine-default", kind: "wsl", label: "podman-machine-default (WSL)", state: "ready", can: "commands only", active: false, toolOwned: true, ...(privileged ? { privileged: true as const } : {}) });
  const settings = { targets: { active: "local", offerSsh: true, dismissedOffers: [], hosts: [], wsl: { on: true }, pcId: "" }, commands: { "wsl:podman-machine-default": on } } as unknown as Settings;
  const row = (mode: ApprovalMode | null, privileged: boolean) => cc.commandsView({ summaries: [pod(privileged)], settings, admin: { source: null, features: {} }, mode }).rows.find(r => r.kind === "wsl")!;

  it("shows on and locked, saying Podman uses it, in every mode, as root or not", () => {
    for (const mode of MODES) for (const privileged of [false, true]) {
      const r = row(mode, privileged);
      expect(r.askEvery).toMatchObject({ checked: true, disabled: true, shown: true });
      expect(r.managed).toContain(cc.ASK_EVERY_TOOL);
      expect(r.managed).not.toMatch(/without asking/);
    }
    expect(cc.ASK_EVERY_TOOL).toBe("Podman uses this distro, so Ember asks before every command here.");
  });
});

describe("the Commands intro, the Routines hint and the Connectors hint are true in every mode (home-c10-2)", () => {
  it("says what commands ask before, per mode, Autopilot's naming a command that keeps running after Stop and one you ruled out (r10-modes-copy-y10-2)", () => {
    expect(text(page)).toContain(cc.commandsIntro(null));
    expect(page).toContain(`<p class="intro" id="commands-intro">${cc.commandsIntro(null)}</p>`);
    expect(cc.commandsIntro("interactive")).toBe(cc.COMMANDS_INTRO);
    expect(cc.commandsIntro("assisted")).toBe("Ember runs commands in its own command window, where you can watch and stop them. It asks first before anything that touches secrets, before anything that downloads and runs code unless Assisted's check finds it in what you asked, and before anything that deletes, publishes or changes the system unless you asked for exactly that command or the check finds it: then it tells you first and gives you a few seconds to stop it.");
    expect(cc.commandsIntro("autopilot")).toBe("Ember runs commands in its own command window, where you can watch and stop them. In Autopilot it runs one that deletes, publishes or changes the system without asking, after a few seconds to stop it. It still asks before anything that touches secrets, would keep running after you stop it or has an effect it can't tell, before one you ruled out, and wherever you or your organisation set commands to ask every time or the administrator of a computer it reaches over SSH doesn't allow Autopilot there.");
  });

  it("says what a routine's steps ask before, per mode, and that Assisted's check reads what you said, not the saved steps (r10-modes-copy-x10-1)", () => {
    expect(page).toContain(`<p class="hint" id="routines-hint">${routinesHint(null)}</p>`);
    expect(routinesHint("interactive")).toBe(routinesHint(null));
    // The check reads what the user said to run the routine, never its saved steps (assisted-check.test.ts pins that
    // side), so the hint doesn't say the steps clear a risky one (r10-modes-copy-x10-1).
    expect(routinesHint("assisted")).toBe("Off, reminders last until Ember closes, and no routine is saved or run. On, saying a routine's name runs its steps, and Ember still asks before anything risky unless Assisted's check finds it in what you said to run the routine, never in its saved steps.");
    expect(routinesHint("assisted")).not.toContain("finds it in the routine's steps");
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

describe("How Ember asks, for an elevated Ember in Assisted (home-c10-3: not reproduced)", () => {
  it("says every command asks, which is what Assisted does there: root keeps every command from the check", async () => {
    const { approvalsNote } = await import("../../app/renderer/home/copy");
    const { notReviewable } = await import("../../app/main/commands/review");
    const state = { chosen: "assisted", inForce: "assisted", why: null, offered: ["interactive", "assisted", "autopilot"], agreed: ["interactive", "assisted"], cap: null } as const;
    expect(approvalsNote({ ...state, offered: [...state.offered], agreed: [...state.agreed] }, false, "root")).toMatch(/Ember is running as root, so it asks before every command\./);
    const d = { verdict: "ask", classes: [], rules: ["privileged"], says: [], reason: "", armMs: 0, unasked: false } as unknown as Parameters<typeof notReviewable>[0];
    expect(notReviewable(d, { words: "update the packages", mode: "on", askEvery: "root", userAskEvery: false, command: "dnf upgrade -y" })).toBe("every command asks here");
  });
});

describe("no sentence promises a question about a dangerous command the user asked for exactly, in any mode (accessibility-c11-1)", () => {
  // decideCommand's rule 10 announces such a command in every mode, with a few seconds to stop it (CLAUDE.md "Never").
  const hand = " in an app unless you turn on Interactive, when you agree or later in settings. It also asks before anything hard to undo, unless you asked for exactly that command (it shows it first, with a few seconds to stop it) or later choose Assisted or Autopilot in settings, which ask less. ";
  const fold = (mode: ApprovalMode | null) => `${privacyFoldWords("It asks before acting", { screenImages: true, autonomy: mode })}${privacyFoldWords(hand, { screenImages: true, autonomy: mode })}`;
  const ASKS_ABOUT = /\b(asks?|ask)\b[^.]*\b(delet|dangerous|hard to undo|risky|publish)/i;
  const TRUE_OF_IT = /exactly|in an app\b/;

  it.each(MODES)("says the exception wherever it says Ember asks before deleting or anything hard to undo (mode %s)", mode => {
    if (mode === "autopilot") return;
    // (Not the Routines hint: a command a routine's step names always asks, since the step isn't what the user said
    // just now, so "still asks before anything risky" is true there.)
    const said = [cc.commandsIntro(mode), grantsHint(mode), fold(mode), ...(mode === "interactive" ? [MODE_LINE.interactive!, AUTONOMY_CONSENT_TEXT] : [])];
    for (const s of said) for (const sentence of s.split(/(?<=\.)\s+/)) {
      if (ASKS_ABOUT.test(sentence)) expect(sentence, s).toMatch(TRUE_OF_IT);
    }
  });

  it("no longer lists dangerous commands among what Interactive's card asks about every time, and its card asks again", () => {
    expect(AUTONOMY_CONSENT_TEXT).not.toMatch(/every time before anything risky[^.]*dangerous commands/);
    expect(AUTONOMY_CONSENT_TEXT).toContain("unless you asked for exactly that command");
    expect(FEATURE_CONSENT_VERSION.autonomy).toBe(4);
  });

  it("says an app's grant doesn't cover anything hard to undo, true in every mode", () => {
    expect(describeEntry({ t: "2026-11-14T10:00:00Z", event: "confirm", kind: "click", app: "gedit", element: { role: "push button", name: "Save" }, answer: "always" } as never)?.why).toBe("From now on Ember may act in gedit without asking first, but that doesn't cover anything hard to undo.");
  });
});

describe("Before Ember starts promises no question a mode doesn't put (Settled 28: first-run-r10-7, -r10-8)", () => {
  const full = page.slice(page.indexOf("<details class=\"w-more\" id=\"w-full\">"), page.indexOf("</details>", page.indexOf("id=\"w-full\"")));
  const handFull = text(full.match(/<li data-icon="hand">[\s\S]*?<\/li>/)![0]);

  it("says where it doesn't ask before something hard to undo: a command asked for exactly, and the modes that ask less", async () => {
    const { consentPoints } = await import("../../app/renderer/home/welcome-copy");
    const hand = consentPoints({ service: "GitHub Copilot", kept: "kept 30 days", locked: false }).find(p => p.icon === "hand")!.text;
    for (const s of [handFull, hand]) {
      expect(s).not.toMatch(/always before anything hard to undo/);
      expect(s).toMatch(/exactly that command/);
      expect(s).toMatch(/Assisted or Autopilot[^.]*ask less/);
    }
  });

  it("doesn't say every other computer and command asks first where commands on this computer turn on with the agreement", () => {
    expect(text(full)).not.toMatch(/Each asks you first\. Commands on this computer have their own switch here\./);
    for (const os of ["linux", "win32"] as const) expect(cc.onboardingRest(os)).toMatch(/Each asks you before it turns on, except commands on this computer, which have their own switch here\.$/);
  });

  it("is a new version of the consent, and tells someone who agreed before what changed", async () => {
    const { CONSENT_VERSION, consentChangesSince } = await import("../../app/shared/consent");
    expect(CONSENT_VERSION).toBe(11);
    expect(consentChangesSince(10)).toEqual(["I say plainly where I don't ask before something hard to undo: a command you asked for exactly, which I show you first with a few seconds to stop it, and Assisted or Autopilot if you choose them later, which ask less."]);
  });
});

describe("the commands card is true in every approval mode, as root too (Settled 28: r10-modes-copy-y10-1; owner decision of 2026-11-14)", () => {
  const facts = { kind: "local" as const, privileged: true, windows: false, podman: false };
  const PRIVILEGED = "Commands here run as the administrator, so Ember counts every one as dangerous, even one you asked for exactly.";
  const MAIN = "Most commands run straight away, ones Ember doesn't know included. A command is dangerous if it deletes or overwrites data, pushes or publishes anywhere, shows passwords or keys, changes the system, downloads and runs code or would keep running after you stop Ember, and so is code Ember can't read. In Interactive, the default, Ember asks you before a dangerous command, unless you asked for exactly that command and it touches no passwords, keys or downloaded code: then it shows it first, with a few seconds to stop it. In Assisted, it goes ahead when a check finds the command in what you asked for, and asks otherwise. In Autopilot, it asks nothing and tells you as it goes.";
  const ALWAYS = "In every mode, Ember doesn't run again a command you said no to in a task, and it asks before every command wherever your organisation, or your own “Ask me before every command” for that computer, says so.";
  const OUTPUT = "What a command prints goes to GitHub Copilot as part of the task. Ember hides passwords and keys it recognises, and never sees what you type into a command. In Autopilot, what a command that shows passwords or keys prints is kept from GitHub Copilot: only you see it, in the command window. If a command prints something that looks like instructions, Ember doesn't follow it, and in Interactive every further command in that task asks you first.";

  it("says, in one text for every mode, what asks in Interactive, what Assisted's check clears and that Autopilot asks nothing, and pins it whole", async () => {
    const { commandsConsent } = await import("../../app/main/targets/consent");
    const card = commandsConsent({ os: "linux", target: "local", targetLabel: "This computer", facts, stopKey: "Ctrl+Alt+X" });
    expect(card.body.slice(1)).toEqual([PRIVILEGED, MAIN, ALWAYS, OUTPUT]);
    for (const line of card.body) {
      expect(line).not.toMatch(/so Ember asks before every one/);
      expect(line).not.toMatch(/always before anything that touches passwords or keys/);
      expect(line).not.toMatch(/still asks about/);
    }
  });

  it("is the same text in the prompt window, and asks everyone again", async () => {
    const { commandsConsent } = await import("../../app/main/targets/consent");
    const promptCopy = await import("../../app/renderer/prompt/copy");
    const { FEATURE_CONSENT_VERSION } = await import("../../app/shared/consent");
    const card = commandsConsent({ os: "linux", target: "local", targetLabel: "This computer", facts, stopKey: "Ctrl+Alt+X" });
    const shown = promptCopy.consentText({ feature: "commands", os: "linux", target: "local", targetLabel: "This computer", stopKey: "Ctrl+Alt+X", commands: { privileged: true } });
    expect(shown.body).toEqual(card.body);
    expect(FEATURE_CONSENT_VERSION.commands).toBe(2);
  });
});
