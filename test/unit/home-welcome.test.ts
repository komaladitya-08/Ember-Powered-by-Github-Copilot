/**
 * First run, one step at a time (Home's `#welcome`, UI audit #7): the order and the consent gate, the consent in
 * short, sign-in, the setup rows in plain words, the tries and "Your Ember". The pure parts are called directly; the
 * page's markup and script are read as text where the behaviour is theirs (there is no DOM in these tests).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CONVERSATION_TEXT_LIMIT } from "../../app/shared/conversation";
import {
  CONSENT_SOURCES, CONSENT_TEXT, STEP_TEXT, aboutNext, TRY_TEXT, WELCOME_STEPS, checkState, signInText, checksHeadline, checksLater, checksNext, consentPoints, firstStep, fixCommand,
  gated, plainChecks, signInView, stepAfter, stepBefore, stepCount, summaryRows, voiceTry,
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
    // Saving waits for main's answer before going on; skipping keeps nothing.
    expect(SCRIPT).toContain('if (about.ready && about.filled) void saveStep(');
  });

  it("can't pass the consent step without agreement, whichever step is asked for (M8.8)", () => {
    for (const s of ["sign-in", "checks", "try", "about", "done"] as const) expect(gated(s, false), s).toBe("consent");
    for (const s of ["hello", "character", "consent"] as const) expect(gated(s, false), s).toBe(s);
    for (const s of WELCOME_STEPS) expect(gated(s, true), s).toBe(s);
    // Agreed in an earlier run that didn't finish: it opens at sign-in, with Back to what came before.
    expect(firstStep(false)).toBe("hello");
    expect(firstStep(true)).toBe("sign-in");
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
      ["plug", /The microphone, other computers and commands stay off until you turn them on\. If you teach me your voice, I keep a voiceprint I refine from your requests, and the words you correct \(never audio\)\./, "The microphone stays off</b> unless you turn on"],
      ["plug", /If you teach me your voice, I keep a voiceprint I refine from your requests/, "it keeps your voiceprint and keeps refining it from requests it is sure are yours (numbers, never audio), and it keeps the words you correct"],
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
    expect(HOME).toContain("document.querySelector<HTMLElement>(\"#w-full #model-service\")");
    expect(HOME).not.toMatch(/querySelector<HTMLElement>\("li\[data-icon='send'\]"\)/);
  });

  it("names the organisation's service, and says nothing is sent while locked down", () => {
    expect(consentPoints({ service: "your organisation's model service (llm.example.com)", kept: "kept 7 days", locked: false })[1].text).toContain("go to your organisation's model service (llm.example.com).");
    const locked = consentPoints({ service: "GitHub Copilot", kept: "none deleted until your organisation fixes its policy", locked: true });
    expect(locked[1].text).toBe("While your organisation's policy locks me down, nothing is sent to a model service, so I can't answer or act.");
    expect(locked[3].text).toContain("(none deleted until your organisation fixes its policy)");
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

  it("offers Check again while signed out, and shows the page main offers for a GitHub CLI sign-in (review of #124)", () => {
    expect(signInView({ phase: "signed-out", signingIn: false, managedProvider: false }).retry).toBe(true);
    expect(signInView({ phase: "ready", signingIn: false, managedProvider: false }).retry).toBe(false);
    expect(SCRIPT).toContain("waitLink = p.link ?? null;");
    expect(SCRIPT).toContain("$(\"w-check-again\").hidden = !((v.retry && agent?.signInWith === \"github-cli\") || waitLink);");
    expect(PAGE).toContain("<button type=\"button\" class=\"btn quiet small\" id=\"w-check-again\">Check again</button>");
  });

  it("never offers sign-in with the organisation's own service, under lockdown, or when the policy refused (review of #124)", () => {
    expect(signInText(true).title).toBe("Connecting to your organisation's service");
    expect(signInText(false)).toBe(STEP_TEXT["sign-in"]);
    expect(signInView({ phase: "starting", signingIn: false, managedProvider: true })).toMatchObject({ primary: "continue", why: "Still connecting to your organisation's model service." });
    expect(signInView({ phase: "error", signingIn: false, managedProvider: true })).toMatchObject({ primary: "continue", why: "", retry: false });
    expect(signInView({ phase: "error", reason: "policy", signingIn: false, managedProvider: false })).toMatchObject({ primary: "continue", why: "", retry: false, skip: false });
    expect(signInView({ phase: "signed-out", signingIn: false, managedProvider: false, locked: true }))
      .toMatchObject({ primary: "continue", line: "Your organisation's policy locks me down, so I can't connect for now.", retry: false });
    // Sign in (or another way on) is the step's button only while it can help; Continue otherwise.
    expect(SCRIPT).toContain("if (step === \"sign-in\" && signInPrimary !== \"continue\") { perform(signInPrimary); return; }");
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
    expect(checksLater(LINUX)).toContain("Settings › Setup check");
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

  it("names each row's state in words in the details", () => {
    expect(["ok", "warn", "fail"].map(s => checkState(s as "ok"))).toEqual(["Ready", "Worth a look", "Needs fixing"]);
  });
});

describe("the try step", () => {
  it("offers “Hey Ember” only while Ember listens for it, and says where to turn it on otherwise", () => {
    expect(voiceTry({ wakeWord: false, voiceConsent: false, state: "off" })).toBe("off");
    expect(voiceTry({ wakeWord: true, voiceConsent: false, state: "off" })).toBe("off");
    expect(voiceTry({ wakeWord: true, voiceConsent: true, state: "needs-models" })).toBe("waiting");
    expect(voiceTry({ wakeWord: true, voiceConsent: true, state: "waiting" })).toBe("listening");
    expect(TRY_TEXT.voiceLater).toContain("Settings › Voice");
    // The level reaches the meter only after the wake word, so the words say to ask something.
    expect(TRY_TEXT.voice.ask).toBe("Say “Hey Ember”, then ask something and watch the meter.");
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

describe("“Your Ember”", () => {
  const keys = { ask: "Ctrl+Alt+Space", stop: "Ctrl+Alt+X", settings: "Ctrl+Alt+E" };

  it("sums up the character, Copilot, voice and the keys Ember holds", () => {
    expect(summaryRows({ character: "Wisp", size: 72, signedIn: "Signed in as octo", voice: "listening", keys })).toEqual([
      { label: "Character", value: "Wisp, 72 px" }, { label: "Copilot", value: "Signed in as octo" }, { label: "“Hey Ember”", value: "On" },
      { label: "Ask", value: "Ctrl+Alt+Space" }, { label: "Stop everything", value: "Ctrl+Alt+X" }, { label: "Settings", value: "Ctrl+Alt+E" },
    ]);
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
