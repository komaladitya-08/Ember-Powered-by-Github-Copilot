/**
 * First run, one step at a time (Home's `#welcome`, UI audit #7): the order and the consent gate, the consent in
 * short, sign-in, the setup rows in plain words, the tries and "Your Ember". The pure parts are called directly; the
 * page's markup and script are read as text where the behaviour is theirs (there is no DOM in these tests).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  CONSENT_TEXT, STEP_TEXT, TRY_TEXT, WELCOME_STEPS, checkState, checksHeadline, checksLater, checksNext, consentPoints, firstStep, fixCommand,
  gated, plainChecks, signInView, stepAfter, stepBefore, stepCount, summaryRows, voiceTry,
} from "../../app/renderer/home/welcome-copy";

const read = (f: string) => readFileSync(new URL(`../../app/${f}`, import.meta.url), "utf8");
const PAGE = read("renderer/home/index.html");
const SCRIPT = read("renderer/home/welcome.ts");
const MAIN = read("main/main.ts");

describe("first run's steps", () => {
  it("go hello, character, consent, sign-in, checks, try, done, one decision each", () => {
    expect([...WELCOME_STEPS]).toEqual(["hello", "character", "consent", "sign-in", "checks", "try", "done"]);
    expect(stepCount("hello")).toBe("Step 1 of 7");
    expect(stepCount("done")).toBe("Step 7 of 7");
    expect(stepBefore("hello")).toBeNull();
    expect(stepAfter("done")).toBeNull();
    expect(stepAfter("consent")).toBe("sign-in");
    expect(stepBefore("sign-in")).toBe("consent");
  });

  it("can't pass the consent step without agreement, whichever step is asked for (M8.8)", () => {
    for (const s of ["sign-in", "checks", "try", "done"] as const) expect(gated(s, false), s).toBe("consent");
    for (const s of ["hello", "character", "consent"] as const) expect(gated(s, false), s).toBe(s);
    for (const s of WELCOME_STEPS) expect(gated(s, true), s).toBe(s);
    // Agreed in an earlier run that didn't finish: it opens at sign-in, with Back to what came before.
    expect(firstStep(false)).toBe("hello");
    expect(firstStep(true)).toBe("sign-in");
  });

  it("goes forward from the consent step only once the agreement is saved", () => {
    expect(SCRIPT).toContain("void deps.save({ consent: { version: CONSENT_VERSION, at: new Date().toISOString() } }).then(ok => { if (ok) go(\"sign-in\"); });");
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

  it("says only what the full text says, in five lines with its symbols", () => {
    expect(points.map(p => p.icon)).toEqual(["eye", "send", "hand", "lock", "plug"]);
    // Each line's claim is in the full text ("Before Ember starts"), which stays on the page unchanged.
    for (const claim of ["reads the window you're working in", "may take a screenshot of it", "password prompts are never read", "Nothing is sent before you ask",
      "asks before acting", "always before anything hard to undo", "never types passwords", "kept 30 days", "sends no usage statistics",
      "The microphone stays off", "are off until you turn them on"]) expect(PAGE, claim).toContain(claim);
    expect(points[1].text).toBe("When you ask something, your request and what I read go to GitHub Copilot. Nothing is sent before you ask.");
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
    expect(fixCommand("No SSH client found. Install OpenSSH with: sudo dnf install openssh-clients")).toBe("sudo dnf install openssh-clients");
    expect(fixCommand("Accessibility is on")).toBeUndefined();
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
  });

  it("hears the stop shortcut and the microphone's level from main, never audio", () => {
    expect(MAIN).toContain("sendToHome(IPC.homeStopped, source);");
    expect(MAIN).toContain("ipcMain.handle(IPC.watchLevel, guard((on: unknown) => { homeWantsLevel = on === true; }));");
    expect(SCRIPT).toContain("if (!active || step !== \"try\" || source !== \"hotkey\" || tried.stop) return;");
    // The meter asks for levels only on the try step while Ember listens, and stops asking when it leaves.
    expect(SCRIPT).toContain("void window.ember.watchLevel(step === \"try\" && voiceState() === \"listening\")");
    expect(SCRIPT).toContain("void window.ember.watchLevel(false)");
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
});
