/**
 * First run, one step at a time (Home's `#welcome`, UI audit #7): the order and the consent gate, the consent in
 * short, sign-in, the setup rows in plain words, the tries and the last step. The pure parts are called directly; the
 * page's markup and script are read as text where the behaviour is theirs (there is no DOM in these tests).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CONVERSATION_TEXT_LIMIT } from "../../app/shared/conversation";
import { CONSENT_CHANGES, CONSENT_VERSION, consentChangesSince } from "../../app/shared/consent";
import {
  CONSENT_AGAIN, CONSENT_CHANGE_SOURCES, CONSENT_SOURCES, CONSENT_TEXT, recheckMessage, STEP_TEXT, aboutNext, askWhy, TRY_TEXT, WELCOME_STEPS, checkState, signInText, checksHeadline, checksLater, checksNext, consentPoints, firstStep, fixCommand,
  gated, plainChecks, serviceSummary, signInView, SKIP_OWN, SKIP_SIGN_IN, stepAfter, stepBefore, stepCount, summaryRows, switchedLine, voiceTry,
} from "../../app/renderer/home/welcome-copy";

const read = (f: string) => readFileSync(new URL(`../../app/${f}`, import.meta.url), "utf8");
const PAGE = read("renderer/home/index.html");
const SCRIPT = read("renderer/home/welcome.ts");
const MAIN = read("main/main.ts");
const HOME = read("renderer/home/main.ts");

describe("first run's steps", () => {
  it("keeps the essential route short and offers personalisation as optional detours", () => {
    expect([...WELCOME_STEPS]).toEqual(["hello", "consent", "sign-in", "checks", "try", "done"]);
    expect(stepCount("hello")).toBe("Step 1 of 6");
    expect(stepCount("done")).toBe("Step 6 of 6");
    expect(stepBefore("hello")).toBeNull();
    expect(stepAfter("done")).toBeNull();
    expect(stepAfter("consent")).toBe("sign-in");
    expect(stepBefore("sign-in")).toBe("consent");
    expect(stepAfter("try")).toBe("done");
    expect(stepAfter("hello")).toBe("consent");
    expect(stepAfter("character")).toBe("consent");
    expect(stepBefore("character")).toBe("hello");
    expect(stepAfter("about")).toBe("done");
    expect(stepBefore("about")).toBe("try");
    expect(stepCount("character")).toBe("Optional · Character");
    expect(stepCount("about")).toBe("Optional · About you");
  });

  it("offers the about-you step as optional: its button skips until memory is on and something is answered", () => {
    expect(STEP_TEXT.about).toEqual({
      title: "Tell me about you",
      lead: "Optional. A few short answers help me get things right for you, and you can skip any of them. I keep them only once you turn memory on.",
    });
    expect(aboutNext({ ready: false, filled: true })).toBe("Skip for now");
    expect(aboutNext({ ready: true, filled: false })).toBe("Skip for now");
    expect(aboutNext({ ready: true, filled: true })).toBe("Save and continue");
    // Memory paused (a model service in force): nothing to answer, so the step just goes on (memory-c1-2).
    expect(aboutNext({ ready: false, filled: true, paused: true })).toBe("Continue");
    // Saving waits for main's answer before going on; skipping keeps nothing.
    expect(SCRIPT).toContain('if (about.ready && about.filled) void saveStep(');
  });

  it("can't pass the consent step without agreement, whichever step is asked for (M8.8)", () => {
    for (const s of ["sign-in", "checks", "try", "about", "done"] as const) expect(gated(s, false), s).toBe("consent");
    for (const s of ["hello", "character", "consent"] as const) expect(gated(s, false), s).toBe(s);
    for (const s of WELCOME_STEPS) expect(gated(s, true), s).toBe(s);
    // Agreed in an earlier run that didn't finish: it opens at sign-in, with Back to what came before.
    expect(firstStep(0)).toBe("hello");
    expect(firstStep(CONSENT_VERSION)).toBe("sign-in");
    // Agreed to an earlier version: it opens at the consent itself, never past it (first-run-4).
    expect(firstStep(CONSENT_VERSION - 1)).toBe("consent");
    expect(gated(firstStep(1), false)).toBe("consent");
  });

  it("goes forward from the consent step only once the agreement is saved", () => {
    expect(SCRIPT).toContain('void saveStep(() => deps.save({ consent: { version: CONSENT_VERSION, at: new Date().toISOString() } }), "sign-in");');
    expect(SCRIPT).toContain("step = gated(to, consented());");
  });

  it("speaks as Ember, in sentence case, never as \"we\" (Apple's writing guidance)", () => {
    const words = [...Object.values(STEP_TEXT).flatMap(t => [t.title, t.lead]), ...Object.values(CONSENT_TEXT),
      ...Object.values(TRY_TEXT).flatMap(v => (typeof v === "string" ? [v] : Object.values(v)))];
    for (const w of words) {
      expect(w, w).not.toMatch(/\bwe\b|\bus\b|\bour\b/i);
      expect(w, w).not.toMatch(/"/);
    }
    expect(STEP_TEXT.hello.title).toBe("Hi, I'm Ember.");
  });
});

describe("the consent in short", () => {
  const points = consentPoints({ service: "GitHub Copilot", kept: "kept 30 days", locked: false });

  it("says only what the full text says, each line paired with the words it shortens (review of #124)", () => {
    expect(points.map(p => p.icon)).toEqual(["eye", "send", "hand", "lock", "plug"]);
    const full = PAGE.slice(PAGE.indexOf("<details class=\"w-more\" id=\"w-full\">"), PAGE.indexOf("</details>", PAGE.indexOf("id=\"w-full\"")));
    // Every line has its sources, and every source is in the full text, which stays on the page unchanged.
    for (const p of points) {
      expect(CONSENT_SOURCES[p.icon].length, p.icon).toBeGreaterThan(0);
      for (const source of CONSENT_SOURCES[p.icon]) expect(full, `${p.icon}: ${source}`).toContain(source);
    }
    // And each line says what its sources say, in Ember's words.
    const pairs: [string, RegExp, string][] = [
      ["eye", /I read the window you're working in, and for tasks I may take a screenshot of it\./, "reads the window you're working in"],
      ["eye", /Never password prompts, or apps on your never-look list\./, "App windows on your never-look list and password prompts are never read"],
      ["send", /your request and what I read go to GitHub Copilot\. Nothing is sent before you ask\./, "Nothing is sent before you ask."],
      ["hand", /I ask before acting in an app, and always before anything hard to undo\. I never type passwords\./, "It never types passwords."],
      ["lock", /On this computer I keep your settings, logs and a record of what you asked and what I did \(kept 30 days\)\. If you save a workspace, I encrypt its paths and last request and answer\. I send no usage statistics\./, "It sends no usage statistics."],
      ["plug", /The microphone, other computers and commands stay off until you turn them on\. While one of my questions is up, anyone near the computer can answer it by voice\. If you teach me your voice, I keep a voiceprint I refine from your requests, and the words you correct \(never audio\)\./, "The microphone stays off</b> unless you turn on"],
      ["plug", /If you teach me your voice, I keep a voiceprint I refine from your requests/, "it keeps your voiceprint and keeps refining it from requests it is sure are yours (numbers, never audio), and it keeps the words you correct"],
      // Said plainly at setup (owner decision B of 2026-11-12).
      ["plug", /While one of my questions is up, anyone near the computer can answer it by voice\./, "anyone near the computer can answer it by voice"],
    ];
    for (const [icon, said, source] of pairs) {
      expect(points.find(p => p.icon === icon)!.text, icon).toMatch(said);
      expect(CONSENT_SOURCES[icon as "eye"], icon).toContain(source);
    }
  });

  it("leaves the full text's own lines to the settings window, never the short form (review of #124)", () => {
    // The short form is drawn from the status: its list starts empty, and never carries the full text's ids.
    expect(PAGE).toContain("<ul class=\"terms w-points\" id=\"w-points\" aria-label=\"What Ember does, in short\"></ul>");
    expect(PAGE.split("id=\"model-service\"").length - 1).toBe(1);
    expect(SCRIPT).not.toContain("model-service");
    // The organisation's service and the lockdown line are written into the full text only.
    expect(HOME).toContain("document.querySelector<HTMLElement>(\"#w-full li[data-icon='send']\")");
    // (and Apps & privacy's copy of it, which keeps no ids: safety-privacy-r6).
    expect(HOME).toContain("document.querySelectorAll<HTMLElement>(\"#w-full #model-service, .model-service-copy\")");
    expect(HOME).not.toMatch(/querySelector<HTMLElement>\("li\[data-icon='send'\]"\)/);
  });

  it("names the organisation's service, and says nothing is sent while locked down", () => {
    expect(consentPoints({ service: "your organisation's model service (llm.example.com)", kept: "kept 7 days", locked: false })[1].text).toContain("go to your organisation's model service (llm.example.com).");
    const locked = consentPoints({ service: "GitHub Copilot", kept: "none deleted until your organisation fixes its policy", locked: true });
    expect(locked[1].text).toBe("While your organisation's policy locks me down, nothing is sent to a model service, so I can't answer or act.");
    expect(locked[3].text).toContain("(none deleted until your organisation fixes its policy)");
  });

  it("tells someone who agreed to an earlier version what changed since, each line from the full text (first-run-4, safety-privacy-8)", () => {
    const full = PAGE.slice(PAGE.indexOf("<details class=\"w-more\" id=\"w-full\">"), PAGE.indexOf("</details>", PAGE.indexOf("id=\"w-full\"")));
    // Every bump has its line, so a bump can't ship without one, and every line is paired with the full text's words.
    for (let v = 2; v <= CONSENT_VERSION; v++) {
      expect(CONSENT_CHANGES[v], `version ${v}`).toBeTruthy();
      expect(CONSENT_CHANGE_SOURCES[v]?.length, `version ${v}`).toBeGreaterThan(0);
      for (const source of CONSENT_CHANGE_SOURCES[v]) expect(full, `${v}: ${source}`).toContain(source);
    }
    expect(Object.keys(CONSENT_CHANGES).map(Number).every(v => v >= 2 && v <= CONSENT_VERSION)).toBe(true);
    expect(consentChangesSince(6)).toEqual([CONSENT_CHANGES[7], CONSENT_CHANGES[8]]);
    expect(consentChangesSince(6)[0]).toContain("“Keep my recent conversation”");
    expect(consentChangesSince(4)).toEqual([CONSENT_CHANGES[5], CONSENT_CHANGES[6], CONSENT_CHANGES[7], CONSENT_CHANGES[8]]);
    // Setup says plainly that anyone near the computer can answer Ember by voice (owner decision B of 2026-11-12).
    expect(consentChangesSince(7)).toEqual(["While one of my questions is up, anyone near the computer can answer it by voice. With Voice Match on, only your voice can say yes."]);
    expect(consentChangesSince(0)).toEqual([]);
    expect(consentChangesSince(CONSENT_VERSION)).toEqual([]);
    for (const line of Object.values(CONSENT_CHANGES)) expect(line, line).not.toMatch(/\bwe\b|\bus\b|\bour\b|"/i);
    expect(CONSENT_AGAIN.title).toBe("What's changed since you last agreed");
    expect(CONSENT_AGAIN.lead).toContain("Nothing is read, heard or sent until you do.");
    // The same gate: the step's button saves the current version, and nothing past it opens without it.
    expect(SCRIPT).toContain("step = firstStep(settings?.consent.version ?? 0);");
  });

  it("says what Not now means: Ember stays off and asks again", () => {
    expect(CONSENT_TEXT.declined).toBe("Then I'll stay off: nothing is read, heard or sent. Agree here whenever you're ready. If you quit me now, I'll ask again the next time you open me.");
  });
});

describe("the sign-in step", () => {
  it("offers sign-in, or Skip for now, while signed out", () => {
    expect(signInView({ phase: "signed-out", signingIn: false, managedProvider: false })).toMatchObject({ primary: "sign-in", why: "", skip: true, cancel: false });
  });

  it("holds Continue with the reason beside it while the browser approval is awaited, with Cancel", () => {
    expect(signInView({ phase: "signed-out", signingIn: true, managedProvider: false }))
      .toMatchObject({ primary: "continue", why: "Waiting for you to approve the sign-in in your browser.", cancel: true, skip: false });
    expect(signInView({ phase: "starting", signingIn: false, managedProvider: false })).toMatchObject({ primary: "continue", why: "Still connecting to Copilot.", skip: true });
  });

  it("says I'll switch to Copilot once I've finished, with Continue open, while a switch waits for what I'm doing (first-run-v4-1)", () => {
    expect(signInView({ phase: "starting", signingIn: false, managedProvider: false, switching: true }))
      .toEqual({ line: "I'll switch to Copilot once I've finished what I'm doing.", tone: "", primary: "continue", why: "", cancel: false, skip: false, retry: false });
    // Main's own status wins once it is ready again or the organisation locks Ember down.
    expect(signInView({ phase: "ready", signingIn: false, managedProvider: false, switching: true }).line).toBe("Connected to Copilot.");
    expect(signInView({ phase: "starting", signingIn: false, managedProvider: false, locked: true, switching: true }).line).toBe("Your organisation's policy locks me down, so I can't connect for now.");
    // The try step's Ask waits for the switch, never for a sign-in the step doesn't offer yet.
    expect(SCRIPT).toContain("noSignIn: !!status?.admin.provider || ownInUse() || toCopilotLater");
    // Only while main leaves my own provider for Copilot: never for a switch the other way.
    expect(SCRIPT).toContain("toCopilotLater = leaving && reported?.switchPending === true;");
  });

  it("says the switch to Copilot was made once the step's Continue becomes a sign-in, by the way this build signs in (first-run-c4-1)", () => {
    expect(switchedLine("github-app")).toBe("I've switched to Copilot. Sign in with GitHub to go on, or skip for now.");
    expect(switchedLine("github-cli")).toBe("I've switched to Copilot. Connect with GitHub CLI to go on, or skip for now.");
  });

  it("offers Check again while signed out, and shows the page main offers for a GitHub CLI sign-in (review of #124)", () => {
    expect(signInView({ phase: "signed-out", signingIn: false, managedProvider: false }).retry).toBe(true);
    expect(signInView({ phase: "ready", signingIn: false, managedProvider: false }).retry).toBe(false);
    expect(SCRIPT).toContain("waitLink = p.link ?? null;");
    // Not while the user's own provider is in use: there is no GitHub sign-in to look for (first-run-1).
    expect(SCRIPT).toContain("$(\"w-check-again\").hidden = !((v.retry && agent?.signInWith === \"github-cli\" && !ownInUse()) || waitLink);");
    expect(PAGE).toContain("<button type=\"button\" class=\"btn quiet small\" id=\"w-check-again\">Check again</button>");
  });

  it("names the user's own provider once Ember uses it, never Copilot, and Back from the checks returns to it (first-run-1)", () => {
    const service = { kind: "user", host: "api.example.com" };
    const ready = signInView({ phase: "ready", signingIn: false, managedProvider: false, service });
    // A host elsewhere wasn't contacted at the start: in use, never "Connected", as Home says (integrations-r2-6).
    expect(ready).toMatchObject({ line: "Using your own provider (api.example.com).", tone: "ok", primary: "continue" });
    expect(signInView({ phase: "ready", signingIn: false, managedProvider: false, service: { kind: "user", host: "127.0.0.1:11434" } }).line).toBe("Connected to your own provider (127.0.0.1:11434).");
    expect(signInView({ phase: "starting", signingIn: false, managedProvider: false, service }).line).toBe("Connecting to your own provider (api.example.com)…");
    const text = signInText({ managed: false, own: "api.example.com" });
    expect(text.title).toBe("Your own model provider");
    expect(text.lead).toContain("api.example.com");
    for (const w of [ready.line, text.title, text.lead]) expect(w, w).not.toMatch(/Copilot|Sign in to GitHub/);
    expect(stepBefore("checks", true)).toBe("provider");
    expect(stepBefore("checks")).toBe("sign-in");
    // The summary doesn't call another service Copilot.
    const rows = summaryRows({ character: "Cinder", size: 60, signedIn: "Your own provider (api.example.com)", voice: "off", keys: null, copilot: false });
    expect(rows[1]).toEqual({ label: "Model service", value: "Your own provider (api.example.com)" });
    expect(SCRIPT).toContain("const to = stepBefore(step, ownInUse());");
  });

  it("names the user's own provider while it connects or fails too, with no GitHub, Copilot or sign-in words (first-run-1)", () => {
    const starting = signInText({ managed: false, own: "localhost:11434", ownPhase: "starting" });
    const failing = signInText({ managed: false, own: "localhost:11434", ownPhase: "error" });
    expect(starting).toEqual({ title: "Your own model provider", lead: "I'm connecting to the model provider you set up (localhost:11434). You can change it later in Settings › Models & connections." });
    expect(failing).toEqual({ title: "Your own model provider", lead: "I can't connect to the model provider you set up (localhost:11434) yet: the line below says why. You can check its details here, or later in Settings › Models & connections." });
    for (const w of [starting.title, starting.lead, failing.lead, SKIP_OWN]) expect(w, w).not.toMatch(/Copilot|GitHub|sign in|sign-in/i);
    // Ready reads as before.
    expect(signInText({ managed: false, own: "localhost:11434", ownPhase: "ready" })).toEqual(signInText({ managed: false, own: "localhost:11434" }));
    expect(SKIP_SIGN_IN).toContain("sign in later");
    expect(SKIP_OWN).toBe("You can go on for now and check it later in Settings › Models & connections. Until I'm connected, I can't answer or act.");
  });

  it("says it is using a provider elsewhere, as the line under it does, and connected only to one on this computer (first-run-r3-2)", () => {
    const service = { kind: "user", host: "api.example.com" };
    const away = signInText({ managed: false, own: "api.example.com", ownPhase: "ready" });
    expect(away.lead).toBe("I'm using the model provider you set up (api.example.com), so there's no GitHub sign-in to do. You can change it later in Settings › Models & connections.");
    expect(signInView({ phase: "ready", signingIn: false, managedProvider: false, service }).line).toBe("Using your own provider (api.example.com).");
    const near = signInText({ managed: false, own: "localhost:11434", ownPhase: "ready" });
    expect(near.lead).toBe("I'm connected to the model provider you set up (localhost:11434), so there's no GitHub sign-in to do. You can change it later in Settings › Models & connections.");
    expect(signInView({ phase: "ready", signingIn: false, managedProvider: false, service: { kind: "user", host: "localhost:11434" } }).line).toBe("Connected to your own provider (localhost:11434).");
  });

  it("never says it is connected to a server on this computer whose start check answered without a model list, as Models & connections doesn't (integrations-x8-2)", () => {
    const host = "127.0.0.1:18593";
    // Ollama's address without /v1 (a 404), a web page, or a key refused: main's status says "Using", and so does first run.
    const unlisted = signInView({ phase: "ready", signingIn: false, managedProvider: false, service: { kind: "user", host, listed: false } });
    expect(unlisted).toMatchObject({ line: "Using your own provider (127.0.0.1:18593).", tone: "ok", primary: "continue" });
    expect(signInText({ managed: false, own: host, ownListed: false, ownPhase: "ready" }).lead).toBe("I'm using the model provider you set up (127.0.0.1:18593), so there's no GitHub sign-in to do. You can change it later in Settings › Models & connections.");
    // With a model list: connected, as before.
    expect(signInView({ phase: "ready", signingIn: false, managedProvider: false, service: { kind: "user", host, listed: true } }).line).toBe("Connected to your own provider (127.0.0.1:18593).");
    expect(signInText({ managed: false, own: host, ownListed: true, ownPhase: "ready" }).lead).toBe("I'm connected to the model provider you set up (127.0.0.1:18593), so there's no GitHub sign-in to do. You can change it later in Settings › Models & connections.");
    // A host elsewhere stays "Using" whatever it says.
    expect(signInView({ phase: "ready", signingIn: false, managedProvider: false, service: { kind: "user", host: "api.example.com", listed: true } }).line).toBe("Using your own provider (api.example.com).");
  });

  it("never offers sign-in with the organisation's own service, under lockdown, or when the policy refused (review of #124)", () => {
    expect(signInText({ managed: true }).title).toBe("Connecting to your organisation's service");
    expect(signInText({ managed: false })).toBe(STEP_TEXT["sign-in"]);
    expect(signInView({ phase: "starting", signingIn: false, managedProvider: true })).toMatchObject({ primary: "continue", why: "Still connecting to your organisation's model service." });
    expect(signInView({ phase: "error", signingIn: false, managedProvider: true })).toMatchObject({ primary: "continue", why: "", retry: false });
    expect(signInView({ phase: "error", reason: "policy", signingIn: false, managedProvider: false })).toMatchObject({ primary: "continue", why: "", retry: false, skip: false });
    expect(signInView({ phase: "signed-out", signingIn: false, managedProvider: false, locked: true }))
      .toMatchObject({ primary: "continue", line: "Your organisation's policy locks me down, so I can't connect for now.", retry: false });
    // Sign in (or another way on) is the step's button only while it can help; Continue otherwise.
    expect(SCRIPT).toContain("if (step === \"sign-in\" && signInPrimary !== \"continue\") { perform(signInPrimary); return; }");
  });

  it("under the organisation's lockdown, never says a service runs or that signing in helps (first-run-v1)", () => {
    for (const held of [false, true]) {
      const t = signInText({ managed: false, locked: true, held });
      expect(t.title + t.lead, String(held)).not.toMatch(/its own model service|nothing to sign in to|Sign in/);
      expect(t.lead, String(held)).toMatch(held ? /restart me/ : /Ask your administrator/);
    }
    // Locked wins over an organisation's service.
    expect(signInText({ managed: true, locked: true }).title).toBe("Your organisation has locked me down");
    expect(askWhy({ locked: true, noSignIn: false })).toBe("While your organisation's policy locks me down, I can't answer.");
    expect(askWhy({ locked: false, noSignIn: true })).toBe("Once I'm connected, you can ask me something.");
    expect(askWhy({ locked: false, noSignIn: false })).toBe("Sign in first, then you can ask me something.");
    const row = summaryRows({ character: "Cinder", size: 60, signedIn: "Locked down by your organisation", voice: "off", keys: null, copilot: false })[1];
    expect(row).toEqual({ label: "Model service", value: "Locked down by your organisation" });
    expect(serviceSummary({ ready: false, locked: true, managed: false })).toBe("Locked down by your organisation");
    expect(serviceSummary({ ready: false, locked: true, managed: true })).toBe("Locked down by your organisation");
  });

  it("offers the user's own provider in the lead only where it is offered (first-run-7)", () => {
    expect(signInText({ managed: false }).lead).toContain("No Copilot? You can use your own model provider instead.");
    const off = signInText({ managed: false, ownOffered: false });
    expect(off.title).toBe("Sign in to GitHub");
    expect(off.lead).not.toMatch(/own model provider/);
    expect(off.lead).toBe("I think with GitHub Copilot, so I need a GitHub account that has Copilot. Your browser opens so you can approve it there.");
  });

  it("says who is signed in once connected", () => {
    expect(signInView({ phase: "ready", login: "octo", signingIn: false, managedProvider: false })).toMatchObject({ line: "Signed in as octo.", tone: "ok", primary: "continue", why: "" });
    expect(signInView({ phase: "ready", signingIn: false, managedProvider: true }).line).toBe("Connected to your organisation's model service.");
  });
});

describe("the checks step", () => {
  const LINUX = [
    { id: "platform", label: "Platform", status: "ok" as const, detail: "Linux x86-64" },
    { id: "session", label: "Desktop session", status: "ok" as const, detail: "X11 on :101" },
    { id: "glibc", label: "glibc", status: "ok" as const, detail: "2.28" },
    { id: "accessibility", label: "Screen reading", status: "warn" as const, detail: "Accessibility is off, so Ember can only see screenshots.", fix: "enable-accessibility" },
  ];

  it("shows only the rows that need the user, in plain words, never glibc or the display", () => {
    const rows = plainChecks(LINUX);
    expect(rows.map(r => r.id)).toEqual(["accessibility"]);
    expect(rows[0]).toMatchObject({ title: "I can't read your apps yet", fix: "enable-accessibility", held: true, tone: "warn" });
    expect(rows[0].text).not.toMatch(/X11|glibc|sudo/);
    expect(checksHeadline(LINUX)).toEqual({ text: "One thing to fix so I can read and use your apps.", tone: "warn" });
    expect(checksNext(LINUX)).toBe("Continue anyway");
    // Named as the sidebar names it (first-run-9).
    expect(checksLater(LINUX)).toContain("Settings › Setup & about");
  });

  it("gives a command to copy when the user runs the fix, and keeps it out of the words", () => {
    const missing = [{ id: "accessibility", label: "Screen reading", status: "warn" as const, detail: "Python accessibility bindings are missing: sudo dnf install python3-pyatspi python3-gobject" }];
    expect(plainChecks(missing)[0]).toMatchObject({ command: "sudo dnf install python3-pyatspi python3-gobject" });
    expect(plainChecks(missing)[0].text).toContain("Run the command below");
    expect(fixCommand("No SSH client found. Install OpenSSH with sudo dnf install openssh-clients, then try again.")).toBe("sudo dnf install openssh-clients");
    expect(fixCommand("Accessibility is on")).toBeUndefined();
    expect(fixCommand("Install it with sudo dnf install speech-dispatcher, then restart Ember.")).toBe("sudo dnf install speech-dispatcher");
  });

  it("marks a failing row red on the row and the headline alike, and all good in green", () => {
    const wayland = [{ id: "session", label: "Desktop session", status: "fail" as const, detail: "Wayland session." }];
    expect(plainChecks(wayland)[0].tone).toBe("fail");
    expect(checksHeadline(wayland).tone).toBe("fail");
    const ok = LINUX.map(r => ({ ...r, status: "ok" as const }));
    expect(checksHeadline(ok)).toEqual({ text: "Everything I need is ready.", tone: "ok" });
    expect(checksNext(ok)).toBe("Continue");
    expect(checksLater(ok)).toBe("");
  });

  it("keeps saying to restart apps already open after Turn on, never that everything is ready (first-run-3)", () => {
    const after = LINUX.map(r => (r.id === "accessibility" ? { id: r.id, label: r.label, status: "ok" as const, detail: "On. Restart apps that were already open, or log out and in, so Ember can read them.", next: true as const } : r));
    expect(plainChecks(after)).toEqual([{ id: "accessibility", title: "Screen reading is on", text: "Restart apps that were already open, or log out and in, so I can read them.", held: false, tone: "ok" }]);
    expect(checksHeadline(after)).toEqual({ text: "Ready, with one thing left for you to do.", tone: "ok" });
    expect(checksNext(after)).toBe("Continue");
    // Switched on before Ember started: nothing left to do.
    expect(checksHeadline(after.map(r => ({ ...r, next: undefined })))).toEqual({ text: "Everything I need is ready.", tone: "ok" });
  });

  it("says what Check again found: the rows that are ready now, or that nothing changed (first-run-6)", () => {
    const missing = [{ id: "accessibility", label: "Screen reading", status: "warn" as const }, { id: "os", label: "Operating system", status: "warn" as const }];
    const fixed = [{ id: "accessibility", label: "Screen reading", status: "ok" as const }, missing[1]];
    expect(recheckMessage(missing, fixed)).toBe("I checked again. Screen reading is ready now.");
    expect(recheckMessage(missing, missing)).toBe("I checked again. Nothing has changed yet.");
    const two = [...missing, { id: "session", label: "Desktop session", status: "fail" as const }];
    expect(recheckMessage(two, two.map(r => ({ ...r, status: "ok" as const })))).toBe("I checked again. Screen reading and Desktop session are ready now.");
    // Offered on the step while a row needs the user, through main's re-read (a throttled probe included).
    expect(SCRIPT).toContain("$(\"w-checks-again-row\").hidden = !rows.some(needsUser);");
    expect(MAIN).toContain("ipcMain.handle(IPC.recheckSetup, guard(async () => environmentNow(true)));");
    expect(HOME).toContain("$(\"checks-again-row\").hidden = !view.needing;");
  });

  it("names each row's state in words in the details", () => {
    expect(["ok", "warn", "fail"].map(s => checkState(s as "ok"))).toEqual(["Ready", "Worth a look", "Needs fixing"]);
    // A warning that holds Ember back needs fixing, as the counts say; Home's setup check uses the same words (first-run-9).
    expect(checkState("warn", true)).toBe("Needs fixing");
    expect(checkState("ok", true)).toBe("Ready");
    expect(HOME).toContain("pill.textContent = checkState(c.status, holdsBack(c));");
  });
});

describe("the step first run opens on", () => {
  it("takes keyboard focus on its title, so a screen reader starts there and not on the page (first-run-r7-3)", () => {
    // Every later step focused its title; the opening one (the hello, or the changed consent) left focus on <body>.
    const begin = /function begin\(\): void \{\n([^]*?)\n {2}\}\n/.exec(SCRIPT)?.[1] ?? "";
    expect(begin).toContain("$(stepLanding(step, consented())).focus({ preventScroll: true });");
    expect(PAGE).toContain('<h2 id="w-title" tabindex="-1">');
  });
});

describe("the try step", () => {
  it("offers “Hey Ember” only while Ember listens for it, and says where to turn it on otherwise", () => {
    expect(voiceTry({ wakeWord: false, voiceConsent: false, state: "off" })).toBe("off");
    expect(voiceTry({ wakeWord: true, voiceConsent: false, state: "off" })).toBe("off");
    expect(voiceTry({ wakeWord: true, voiceConsent: true, state: "downloading" })).toBe("waiting");
    expect(voiceTry({ wakeWord: true, voiceConsent: true, state: "starting" })).toBe("waiting");
    expect(voiceTry({ wakeWord: true, voiceConsent: true, state: "waiting" })).toBe("listening");
    expect(TRY_TEXT.voiceLater).toContain("Settings › Voice");
    // The level reaches the meter only after the wake word, so the words say to ask something.
    expect(TRY_TEXT.voice.ask).toBe("Say “Hey Ember”, then ask something and watch the meter.");
  });

  it("says the speech models need downloading when they are gone, never that it will listen soon or that “Hey Ember” is on (first-run-r7-2)", () => {
    // A returning user with listening agreed and no models was told "I'm not listening yet. Once I am, say “Hey
    // Ember”." for good, and the last step said "“Hey Ember”: On".
    expect(voiceTry({ wakeWord: true, voiceConsent: true, state: "needs-models" })).toBe("no-models");
    expect(TRY_TEXT.voiceNoModels).toBe("I can't listen for “Hey Ember” yet: my speech models aren't on this computer. Download them later in Settings › Voice.");
    const row = (voice: "listening" | "waiting" | "off" | "no-models") => summaryRows({ character: "Cinder", size: 60, signedIn: null, voice, keys: null })[2];
    expect(row("no-models")).toEqual({ label: "“Hey Ember”", value: "Not yet: its speech models need downloading" });
    expect(row("waiting").value).toBe("On");
    expect(row("off").value).toBe("Off");
    // The try isn't drawn, and its line under the tries says why.
    expect(SCRIPT).toContain('$("w-try-voice").hidden = vs === "off" || vs === "no-models";');
    expect(SCRIPT).toContain('$("w-voice-later").textContent = vs === "no-models" ? TRY_TEXT.voiceNoModels : TRY_TEXT.voiceLater;');
  });

  it("counts voice as off when the organisation turned it off, it is muted, or the microphone isn't working (review of #124)", () => {
    const on = { wakeWord: true, voiceConsent: true, state: "waiting" };
    expect(voiceTry({ ...on, allowed: false })).toBe("off");
    expect(voiceTry({ ...on, muted: true })).toBe("off");
    for (const state of ["off", "muted", "error"]) expect(voiceTry({ ...on, state }), state).toBe("off");
    expect(SCRIPT).toContain("allowed: status?.admin.features.voice !== false, muted: !!settings?.voice.muted,");
  });

  it("hears the stop shortcut and the microphone's level from main, never audio", () => {
    expect(MAIN).toContain("sendToHome(IPC.homeStopped, source);");
    expect(MAIN).toContain("ipcMain.handle(IPC.watchLevel, guard((on: unknown) => { homeWantsLevel = on === true; }));");
    expect(SCRIPT).toContain("if (!active || step !== \"try\" || tried.stop) return;");
    // The meter asks for levels only on the try step while Ember listens, stops when it leaves, and asks main only
    // when that changes; main sends nothing to a hidden or minimised window.
    expect(SCRIPT).toContain("wantLevel(step === \"try\" && voiceState() === \"listening\");");
    expect(SCRIPT).toContain("wantLevel(false);");
    expect(SCRIPT).toContain("if (levelWanted === on) return;");
    expect(MAIN).toContain("home.isVisible() && !home.isMinimized()) home.webContents.send(IPC.homeLevel, l.mic);");
  });
});

describe("the last step, “Ready to start”", () => {
  const keys = { ask: "Ctrl+Alt+Space", stop: "Ctrl+Alt+X", settings: "Ctrl+Alt+E" };

  it("sums up the character, Copilot, voice and the keys Ember holds", () => {
    expect(summaryRows({ character: "Wisp", size: 72, signedIn: "Signed in as octo", voice: "listening", keys })).toEqual([
      { label: "Character", value: "Wisp, 72 px" }, { label: "Copilot", value: "Signed in as octo" }, { label: "“Hey Ember”", value: "On" },
      { label: "Ask", value: "Ctrl+Alt+Space" }, { label: "Stop everything", value: "Ctrl+Alt+X" }, { label: "Settings", value: "Ctrl+Alt+E" },
    ]);
  });

  it("names the service Ember is connected through, and one with nothing to sign in to by name while it isn't connected (first-run-c1-3)", () => {
    const user = { kind: "user", host: "localhost:11434" };
    expect(serviceSummary({ ready: true, locked: false, managed: false, login: "octo" })).toBe("Signed in as octo");
    expect(serviceSummary({ ready: true, locked: false, managed: false })).toBe("Connected");
    expect(serviceSummary({ ready: true, locked: false, managed: true })).toBe("Your organisation's model service");
    expect(serviceSummary({ ready: true, locked: false, managed: false, service: user, login: "octo" })).toBe("Your own provider (localhost:11434)");
    // Not connected: Copilot isn't signed in yet; the user's own provider and the organisation's service have no sign-in.
    expect(serviceSummary({ ready: false, locked: false, managed: false })).toBeNull();
    expect(serviceSummary({ ready: false, locked: false, managed: false, service: user })).toBe("Your own provider (localhost:11434), not connected yet");
    expect(serviceSummary({ ready: false, locked: false, managed: true })).toBe("Your organisation's model service, not connected yet");
    expect(serviceSummary({ ready: false, locked: false, managed: false, service: { kind: "admin", host: "models.corp.example" } })).toBe("Your organisation's model service, not connected yet");
    for (const service of [user, undefined]) {
      const value = serviceSummary({ ready: false, locked: false, managed: !service, service });
      expect(summaryRows({ character: "Cinder", size: 60, signedIn: value, voice: "off", keys: null, copilot: false })[1].value).not.toMatch(/signed in/i);
    }
    expect(SCRIPT).toContain("signedIn: serviceSummary({");
  });

  it("names no shortcut another app holds, and says when Copilot isn't signed in yet", () => {
    const rows = summaryRows({ character: "Cinder", size: 60, signedIn: null, voice: "off", keys: { ...keys, ask: "" } });
    expect(rows.find(r => r.label === "Ask")).toBeUndefined();
    expect(rows.find(r => r.label === "Copilot")?.value).toBe("Not signed in yet");
  });

  it("says the default size in words, and names no keys before the status says this OS's (review of #124)", () => {
    expect(summaryRows({ character: "Cinder", size: 60, signedIn: null, voice: "off", keys })[0].value).toBe("Cinder, default size");
    expect(summaryRows({ character: "Cinder", size: 60, signedIn: null, voice: "off", keys: null }).map(r => r.label)).toEqual(["Character", "Copilot", "“Hey Ember”"]);
    expect(SCRIPT).not.toContain("SHORTCUTS.linux");
  });

  it("shows when copying failed, and draws the setup rows again only when they change (review of #124)", () => {
    expect(SCRIPT).toContain("() => { copy.textContent = \"Couldn't copy\"; }");
    // Pages have no clipboard permission: main copies bounded plain text, including retained answers, from Home only.
    expect(SCRIPT).toContain("window.ember.copyText(text)");
    expect(HOME).not.toContain("navigator.clipboard");
    expect(MAIN).toContain("ipcMain.handle(IPC.copyText, guard((text: unknown) => {");
    expect(CONVERSATION_TEXT_LIMIT).toBe(128 * 1024);
    expect(MAIN).toContain("if (typeof text !== \"string\" || !text || text.length > CONVERSATION_TEXT_LIMIT) throw new Error(\"Nothing to copy.\");");
    expect(SCRIPT).toContain("if (key === shownChecks) return checksNext(rows);");
    // Calm shows the summary at once: no stagger delay is left behind.
    expect(read("renderer/home/styles.css")).toContain("html.calm .w-card > * { transition-delay: 0s; }");
  });
});
