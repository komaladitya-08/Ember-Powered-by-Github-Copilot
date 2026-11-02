/**
 * First run's words and decisions (Home's `#welcome`, UI audit #7): one decision a step, Ember's own line as each step's
 * title, a reason beside every button that can't be pressed yet, and plain words for the setup rows that need the user,
 * their technical detail kept behind a disclosure. Pure (no DOM, no Electron), so welcome.ts only applies it and the
 * tests read it directly. The full consent text stays the page's own markup ("Before Ember starts"); the summary here
 * says the same things in fewer words and never more, so agreeing to it is agreeing to that text (CONSENT_VERSION).
 */

import { needsUser, holdsBack, type SetupRow } from "../../shared/setup-attention";

/** The steps, in order. The try step and the summary come after the consent gate; nothing before it reads or sends. */
export const WELCOME_STEPS = ["hello", "character", "consent", "sign-in", "checks", "try", "done"] as const;
export type WelcomeStep = (typeof WELCOME_STEPS)[number];

/** Where first run opens: at the start, or (terms already agreed in an earlier run that didn't finish) at sign-in. */
export function firstStep(consented: boolean): WelcomeStep {
  return consented ? "sign-in" : "hello";
}

/** "Step 3 of 7": the still step indicator's words (its segments are for the eye only). */
export function stepCount(step: WelcomeStep): string {
  return `Step ${WELCOME_STEPS.indexOf(step) + 1} of ${WELCOME_STEPS.length}`;
}

/** The step before and after `step` (null at either end). */
export function stepBefore(step: WelcomeStep): WelcomeStep | null {
  const i = WELCOME_STEPS.indexOf(step);
  return i > 0 ? WELCOME_STEPS[i - 1] : null;
}
export function stepAfter(step: WelcomeStep): WelcomeStep | null {
  const i = WELCOME_STEPS.indexOf(step);
  return i < WELCOME_STEPS.length - 1 ? WELCOME_STEPS[i + 1] : null;
}

/**
 * A step past the consent gate can't be reached without consent: going forward from the consent step needs Agree, and
 * a later step asked for without it falls back to the consent step (M8.8: first run can't skip consent).
 */
export function gated(step: WelcomeStep, consented: boolean): WelcomeStep {
  return !consented && WELCOME_STEPS.indexOf(step) > WELCOME_STEPS.indexOf("consent") ? "consent" : step;
}

/** Each step's title (Ember's line) and the sentence under it. */
export const STEP_TEXT: Readonly<Record<WelcomeStep, { title: string; lead: string }>> = {
  hello: {
    title: "Hi, I'm Ember.",
    lead: "I sit beside your cursor, answer your questions and do things in your apps while you watch. Setting me up takes about a minute.",
  },
  character: {
    title: "Who should keep you company?",
    lead: "Pick the one you like. They all work the same way.",
  },
  consent: {
    title: "What I do, and what I don't",
    lead: "Before I start, here's how I work. Nothing is read, heard or sent until you agree.",
  },
  "sign-in": {
    title: "Sign in to GitHub",
    lead: "I think with GitHub Copilot, so I need your GitHub account. Your browser opens so you can approve it there.",
  },
  checks: {
    title: "Checking this computer",
    lead: "I need a few things from your desktop to read and use your apps.",
  },
  try: {
    title: "Try me out",
    lead: "A few things worth trying now. Each is optional.",
  },
  done: {
    title: "Your Ember",
    lead: "That's everything. Here's what you chose.",
  },
};

/** A bullet of the consent summary: its symbol (the full text's own) and words. */
export interface ConsentPoint { icon: "eye" | "send" | "hand" | "lock" | "plug"; text: string }

/**
 * The consent in five lines, each a shorter form of the full text's (index.html "Before Ember starts"). `service` is
 * where requests go ("GitHub Copilot", or the organisation's), `kept` how long the record is kept ("kept 30 days"),
 * `locked` the administrator's lockdown, which sends nothing anywhere (admin-copy.ts lockdownSendLine).
 */
export function consentPoints(o: { service: string; kept: string; locked: boolean }): ConsentPoint[] {
  return [
    { icon: "eye", text: "I read the window you're working in, and for tasks I may take a screenshot of it. Never password prompts, or apps on your never-look list." },
    o.locked
      ? { icon: "send", text: "While your organisation's policy locks me down, nothing is sent to a model service, so I can't answer or act." }
      : { icon: "send", text: `When you ask something, your request and what I read go to ${o.service}. Nothing is sent before you ask.` },
    { icon: "hand", text: "I ask before acting in an app, and always before anything hard to undo. I never type passwords." },
    { icon: "lock", text: `Your settings, logs and a record of what I did stay on this computer (${o.kept}). I send no usage statistics.` },
    { icon: "plug", text: "The microphone, other computers and commands stay off until you turn them on." },
  ];
}

/** The consent step's buttons and what "Not now" says. */
export const CONSENT_TEXT = {
  agree: "Agree and continue",
  notNow: "Not now",
  full: "Read the full text",
  agreed: "You've agreed to how I work.",
  declined: "Then I'll stay off: nothing is read, heard or sent. Agree here whenever you're ready. If you quit me now, I'll ask again the next time you open me.",
  quit: "Quit Ember",
} as const;

/** The sign-in step as the Copilot status has it: what it says, and which buttons it offers. */
export interface SignInView {
  /** The line under the buttons ("" when none). */
  line: string;
  tone: "" | "ok" | "error";
  /** The prominent button: sign in, or continue once connected. */
  primary: "sign-in" | "continue";
  /** The prominent button can't be pressed yet (still connecting): the reason shown beside it. */
  why: string;
  cancel: boolean;
  skip: boolean;
}

/**
 * `phase` and `login` from the agent's status (null while it hasn't come), `signingIn` while a device flow runs,
 * `managedProvider` when the organisation's own model service answers instead of Copilot (nothing to sign in to).
 */
export function signInView(o: { phase: string | null; login?: string; signingIn: boolean; managedProvider: boolean }): SignInView {
  if (o.phase === "ready") {
    const who = o.managedProvider ? "Connected to your organisation's model service." : o.login ? `Signed in as ${o.login}.` : "Connected to Copilot.";
    return { line: who, tone: "ok", primary: "continue", why: "", cancel: false, skip: false };
  }
  if (o.signingIn) return { line: "", tone: "", primary: "continue", why: "Waiting for you to approve the sign-in in your browser.", cancel: true, skip: false };
  if (o.phase === "starting" || o.phase === null) return { line: "Connecting to Copilot…", tone: "", primary: "continue", why: "Still connecting to Copilot.", cancel: false, skip: true };
  return { line: "", tone: "", primary: "sign-in", why: "", cancel: false, skip: true };
}

/** What "Skip for now" leaves for later, and where. */
export const SKIP_SIGN_IN = "You can sign in later in Settings › Copilot. Until then I can't answer or act.";

/**
 * A setup row in plain words: a short title, what it means for the user, how serious it is (`held`: Ember can't read,
 * see or use apps until it's fixed), its fix's buttons (from the row), and a command to copy when the fix is one the
 * user runs themselves (Linux's packages).
 */
export interface PlainCheck { id: string; title: string; text: string; held: boolean; tone: "warn" | "fail"; fix?: string; alt?: string; command?: string }

/** The command a row's detail tells the user to run ("…: sudo dnf install python3-pyatspi"), if any. */
export function fixCommand(detail: string): string | undefined {
  return /\b(sudo [^.;]+?)\s*(?:\.(?:\s|$)|$)/.exec(detail)?.[1].trim();
}

/** Plain words for the rows that hold Ember back or have a fix, by row id; others keep their own label. */
const PLAIN: Readonly<Record<string, { title: string; text: string }>> = {
  accessibility: { title: "I can't read your apps yet", text: "I read and use your apps through the desktop's accessibility. Without it I only see screenshots." },
  "screen-recording": { title: "I can't see your screen yet", text: "Allow screen recording, so I can take a screenshot of a window for a task." },
  "input-monitoring": { title: "I can't tell when you take the mouse back", text: "Allow input monitoring, so I let go the moment you move the mouse or type." },
  session: { title: "This desktop session doesn't suit me", text: "I need a GNOME on Xorg session to see and use your apps." },
  platform: { title: "This computer isn't supported", text: "I don't run on this kind of computer." },
  glibc: { title: "This Linux is too old for me", text: "Some parts of me need a newer system library." },
  microphone: { title: "I can't use the microphone", text: "Allow the microphone if you want to talk to me. Typing always works." },
  speech: { title: "I can't speak out loud", text: "This computer has no voice I can use. I'll show my answers instead." },
  location: { title: "Move me to Applications", text: "Some permissions only stick when I'm in the Applications folder." },
  elevated: { title: "I'm running as an administrator", text: "Start me as yourself, so I don't act with more rights than you." },
  "secure-input": { title: "Another app is holding the keyboard", text: "While it does, I can't type for you." },
  desktop: { title: "This desktop isn't one I know well", text: "I'm tested on GNOME. I may still work here." },
  os: { title: "This system isn't one I'm tested on", text: "I may still work here." },
};

/** The rows the checks step shows (only those that need the user), in plain words. */
export function plainChecks(rows: readonly (SetupRow & { alt?: string; detail?: string })[]): PlainCheck[] {
  return rows.filter(needsUser).map(r => {
    const p = PLAIN[r.id.split(":")[0]] ?? { title: r.label, text: "This needs a look before I can do everything." };
    // No button fixes it here: the command to run, or the details' advice.
    const command = r.fix ? undefined : fixCommand(r.detail ?? "");
    const text = r.fix ? p.text : command ? `${p.text} Run the command below, or ask your administrator to.` : `${p.text} The details below say what to do.`;
    return { id: r.id, title: p.title, text, held: holdsBack(r), tone: r.status === "fail" ? "fail" : "warn", ...(r.fix ? { fix: r.fix } : {}), ...(r.alt ? { alt: r.alt } : {}), ...(command ? { command } : {}) };
  });
}

/** The checks step's headline: all good, things that hold Ember back, or only things worth a look. */
export function checksHeadline(rows: readonly SetupRow[]): { text: string; tone: "ok" | "warn" | "fail" } {
  const held = rows.filter(holdsBack).length;
  const look = rows.filter(needsUser).length;
  if (!look) return { text: "Everything I need is ready.", tone: "ok" };
  // One severity on the step: red only when a row fails outright, the same mark on the headline and on the row.
  const tone = rows.some(r => r.status === "fail") ? "fail" : "warn";
  if (held) return { text: held === 1 ? "One thing to fix so I can read and use your apps." : `${held} things to fix so I can read and use your apps.`, tone };
  return { text: look === 1 ? "One thing is worth a look. I work without it." : `${look} things are worth a look. I work without them.`, tone: "warn" };
}

/** Under the checks: what happens if the user goes on without fixing them, and where to come back. */
export function checksLater(rows: readonly SetupRow[]): string {
  if (rows.some(holdsBack)) return "You can go on and fix this later in Settings › Setup check. Until then I can answer questions, but some tasks won't work.";
  return rows.some(needsUser) ? "You can fix these later in Settings › Setup check." : "";
}

/** The checks step's Continue: "Continue anyway" while something holds Ember back (it never blocks the flow). */
export function checksNext(rows: readonly SetupRow[]): string {
  return rows.some(holdsBack) ? "Continue anyway" : "Continue";
}

/** A setup row's state in the details, in words beside its symbol (never colour alone, never a code like "OK"). */
export function checkState(status: SetupRow["status"]): string {
  return status === "ok" ? "Ready" : status === "warn" ? "Worth a look" : "Needs fixing";
}

/** The disclosure with every row and its technical detail. */
export const CHECKS_DETAIL = "Show the details";

/** The try step's three tries: what each says before and after it is done. */
export const TRY_TEXT = {
  stop: { title: "Stop me", ask: "Press the stop shortcut now. It stops everything I'm doing, at once, anywhere.", done: "That's how you stop me." },
  voice: { title: "Say “Hey Ember”", ask: "Say “Hey Ember” and watch the meter. Then ask something, or say nothing.", done: "I heard you." },
  ask: { title: "Ask me something", ask: "Open the ask box and type a question, such as “What can you do?”", done: "You asked me something.", open: "Open the ask box" },
  /** The ask box can't be opened yet: why, beside its button. */
  askWhy: "Sign in first, then you can ask me something.",
  /** Voice is off (not turned on, or not agreed to): the try isn't shown, and this says where to turn it on. */
  voiceLater: "To talk to me, turn on “Hey Ember” later in Settings › Voice. Then say, for example, “Hey Ember, what's in this window?”",
  /** Voice is on but not listening yet (models still to download, or starting). */
  voiceWaiting: "I'm not listening yet. Once I am, say “Hey Ember”.",
} as const;

/** "Say “Hey Ember”" shows only while Ember listens for it: on, agreed to, and the microphone open. */
export function voiceTry(o: { wakeWord: boolean; voiceConsent: boolean; state: string | null }): "listening" | "waiting" | "off" {
  if (!o.wakeWord || !o.voiceConsent) return "off";
  return o.state === "waiting" || o.state === "active" ? "listening" : "waiting";
}

/** One row of the "Your Ember" card. */
export interface SummaryRow { label: string; value: string }

/** The "Your Ember" card's rows: who, Copilot, voice, and the keys Ember holds (a key another app holds isn't named). */
export function summaryRows(o: {
  character: string; size: number; signedIn: string | null; voice: "listening" | "waiting" | "off";
  keys: { ask: string; stop: string; settings: string };
}): SummaryRow[] {
  const rows: SummaryRow[] = [
    { label: "Character", value: `${o.character}, ${o.size} px` },
    { label: "Copilot", value: o.signedIn ?? "Not signed in yet" },
    { label: "“Hey Ember”", value: o.voice === "off" ? "Off" : "On" },
  ];
  if (o.keys.ask) rows.push({ label: "Ask", value: o.keys.ask });
  if (o.keys.stop) rows.push({ label: "Stop everything", value: o.keys.stop });
  if (o.keys.settings) rows.push({ label: "Settings", value: o.keys.settings });
  return rows;
}

/** Under the card: where to change it all later. */
export const SUMMARY_NOTE = "You can change any of this in Settings, which opens from my handle in the corner of your screen.";

/** The last button, and what a screen reader hears once it has worked. */
export const START_LABEL = "Start Ember";

/** The navigation buttons. */
export const NAV = { back: "Back", next: "Continue", begin: "Get started", skip: "Skip for now" } as const;
