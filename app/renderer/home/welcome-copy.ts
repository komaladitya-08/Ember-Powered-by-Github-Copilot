/**
 * First run's words and decisions (Home's `#welcome`, UI audit #7): one decision a step, Ember's own line as each step's
 * title, a reason beside every button that can't be pressed yet, and plain words for the setup rows that need the user,
 * their technical detail kept behind a disclosure. Pure (no DOM, no Electron), so welcome.ts only applies it and the
 * tests read it directly. The full consent text stays the page's own markup ("Before Ember starts"); the summary here
 * says the same things in fewer words and never more, so agreeing to it is agreeing to that text (CONSENT_VERSION).
 */

import { CONSENT_VERSION } from "../../shared/consent";
import { needsUser, holdsBack, type SetupRow } from "../../shared/setup-attention";
import { onThisComputer } from "../../shared/provider";

/** The essential first-run route; character and memory personalisation remain optional detours. */
export const WELCOME_STEPS = ["hello", "consent", "sign-in", "checks", "try", "done"] as const;
export type WelcomeStep = (typeof WELCOME_STEPS)[number] | "character" | "about" | "provider";

/**
 * Where first run opens, by the consent version agreed to (`agreed`): at the start for someone who never agreed (0), at
 * sign-in once the current one was agreed in a run that didn't finish, and at the consent itself, with what changed,
 * for someone who agreed to an earlier version (first-run-4: they have met Ember already).
 */
export function firstStep(agreed: number): WelcomeStep {
  if (agreed >= CONSENT_VERSION) return "sign-in";
  return agreed > 0 ? "consent" : "hello";
}

/**
 * The element a step's focus lands on, so it is read from the top: its title. The hello step's lead instead once the
 * consent is agreed: its title, "Hi, I'm Ember.", ends in the name, and “Hey Ember” may listen by then (Back from a
 * consent agreed again), so what a screen reader read on would be taken as a request (first-run-r6-1).
 */
export function stepLanding(step: WelcomeStep, consented: boolean): "w-title" | "w-lead" {
  return step === "hello" && consented ? "w-lead" : "w-title";
}

/** Position in the essential route; optional detours keep their originating step's indicator. */
export function stepPosition(step: WelcomeStep): number {
  return WELCOME_STEPS.indexOf(step === "character" ? "hello" : step === "about" ? "try" : step === "provider" ? "sign-in" : step);
}

/** Optional personalisation never pretends to be another mandatory setup step. */
export function stepCount(step: WelcomeStep): string {
  if (step === "character") return "Optional · Character";
  if (step === "about") return "Optional · About you";
  return `Step ${stepPosition(step) + 1} of ${WELCOME_STEPS.length}`;
}

/**
 * The step before and after `step`, including the optional detours. `own`: Ember is connected to the user's own
 * provider, so Back from the checks returns to its step, not to a Copilot sign-in that isn't in use (first-run-1).
 */
export function stepBefore(step: WelcomeStep, own = false): WelcomeStep | null {
  if (step === "character") return "hello";
  if (step === "about") return "try";
  if (step === "provider") return "sign-in";
  if (step === "checks" && own) return "provider";
  const i = stepPosition(step);
  return i > 0 ? WELCOME_STEPS[i - 1] : null;
}
export function stepAfter(step: WelcomeStep): WelcomeStep | null {
  if (step === "character") return "consent";
  if (step === "about") return "done";
  if (step === "provider") return "checks";
  const i = stepPosition(step);
  return i < WELCOME_STEPS.length - 1 ? WELCOME_STEPS[i + 1] : null;
}

/** Every route to a connected feature, including optional memory, still passes saved consent. */
export function gated(step: WelcomeStep, consented: boolean): WelcomeStep {
  return !consented && stepPosition(step) > stepPosition("consent") ? "consent" : step;
}

/** Each step's title (Ember's line) and the sentence under it. */
export const STEP_TEXT: Readonly<Record<WelcomeStep, { title: string; lead: string }>> = {
  hello: {
    title: "Hi, I'm Ember.",
    lead: "I sit beside your cursor, answer your questions and do things in your apps while you watch. You can personalise my character and memory later in Settings.",
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
    lead: "I think with GitHub Copilot, so I need a GitHub account that has Copilot. Your browser opens so you can approve it there. No Copilot? You can use your own model provider instead.",
  },
  provider: {
    title: "Use your own model provider",
    lead: "Use any service that speaks the OpenAI, Azure OpenAI or Anthropic API instead of GitHub Copilot. Nothing is sent to it until you agree below.",
  },
  checks: {
    title: "Checking this computer",
    lead: "I need a few things from your desktop to read and use your apps.",
  },
  try: {
    title: "Try me out",
    lead: "Learn how to stop me, then try a request. The practice activities and personalisation are optional.",
  },
  about: {
    title: "Tell me about you",
    lead: "Optional. A few short answers help me get things right for you, and you can skip any of them. I keep them only once you turn memory on.",
  },
  done: {
    // No name in a title the focus lands on, nor on Start: “Hey Ember” may listen by now (first-run-r6-1).
    title: "Ready to start",
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
    { icon: "lock", text: `On this computer I keep your settings, logs and a record of what you asked and what I did (${o.kept}). If you save a workspace, I encrypt its paths and last request and answer. I send no usage statistics.` },
    { icon: "plug", text: "The microphone, other computers and commands stay off until you turn them on. If you teach me your voice, I keep a voiceprint I refine from your requests, and the words you correct (never audio)." },
  ];
}

/** The consent step for someone who agreed to an earlier version: its title, lead and the heading over what changed (first-run-4). */
export const CONSENT_AGAIN = {
  title: "What's changed since you last agreed",
  lead: "I work a little differently now, so I need you to agree again. Nothing is read, heard or sent until you do.",
  changes: "What's new",
} as const;

/** The consent step's buttons and what "Not now" says. */
export const CONSENT_TEXT = {
  agree: "Agree and continue",
  notNow: "Not now",
  full: "Read the full text",
  agreed: "You've agreed to how I work.",
  declined: "Then I'll stay off: nothing is read, heard or sent. Agree here whenever you're ready. If you quit me now, I'll ask again the next time you open me.",
  quit: "Quit Ember",
} as const;

/**
 * Each consent line beside the full text's words it shortens (index.html "Before Ember starts"): the summary claims
 * nothing the full text doesn't (home-welcome.test.ts checks every pair against the page).
 */
export const CONSENT_SOURCES: Readonly<Record<ConsentPoint["icon"], readonly string[]>> = {
  eye: ["reads the window you're working in", "for tasks it may take a screenshot of it", "App windows on your never-look list and password prompts are never read"],
  send: ["When you ask something</b>, your request and what Ember read from the screen go to", "Nothing is sent before you ask."],
  hand: ["It asks before acting</b> in an app, and always before anything hard to undo.", "It never types passwords."],
  lock: ["On this computer</b> it keeps your settings, logs and a record of every task and action it took, including what you asked for", "Ember encrypts its selected paths and last completed request and answer", "It sends no usage statistics."],
  plug: ["The microphone stays off</b> unless you turn on", "it keeps your voiceprint and keeps refining it from requests it is sure are yours (numbers, never audio), and it keeps the words you correct", "Other computers and commands</b><span id=\"targets-note\"> are off until you turn them on"],
};

/** Each CONSENT_CHANGES line beside the full text's words it shortens (home-welcome.test.ts checks every pair against the page). */
export const CONSENT_CHANGE_SOURCES: Readonly<Record<number, readonly string[]>> = {
  2: ["it keeps your voiceprint and keeps refining it from requests it is sure are yours", "it keeps the words you correct"],
  3: ["or choose Listen once for one request"],
  4: ["In Project work, Send selected files shares your request and the contents of those files with the connected model."],
  5: ["If you save a project workspace, Ember encrypts its selected paths and last completed request and answer on this computer"],
  6: ["Once you call Ember it keeps listening through the conversation, and what it hears there goes to", "as text, without its name"],
  7: ["unless you turn on “Keep my recent conversation” under Conversation: then its latest messages stay on this computer"],
};

/**
 * The sign-in step's title and lead: an organisation's own model service (`managed`) has nothing to sign in to, and
 * neither has the user's own provider once Ember uses it (`own`, its host: first-run-1), whether it is connected,
 * still connecting or failing (`ownPhase`; ready when absent), so no GitHub, Copilot or sign-in words are said then.
 * Under the organisation's lockdown (`locked`; `held` until a restart reads a changed policy) nothing connects at all,
 * so the step says that, never that a service runs (first-run-v1). The lead offers the user's own provider only where
 * it is offered (`ownOffered`, first-run-7).
 */
export function signInText(o: { managed: boolean; locked?: boolean; held?: boolean; own?: string | null; ownPhase?: "ready" | "starting" | "error"; ownOffered?: boolean }): { title: string; lead: string } {
  if (o.locked) {
    return o.held
      ? { title: "Restart me to use your organisation's new policy", lead: "Your organisation changed my policy while I was running, so I can't connect to a model service until you restart me." }
      : { title: "Your organisation has locked me down", lead: "Your organisation's policy for me has a problem, so I can't connect to a model service for now. Ask your administrator to fix it." };
  }
  if (o.managed) return { title: "Connecting to your organisation's service", lead: "Your organisation runs its own model service for me, so there's nothing to sign in to." };
  if (o.own) {
    const lead = o.ownPhase === "starting" ? `I'm connecting to the model provider you set up (${o.own}). You can change it later in Settings › Models & connections.`
      : o.ownPhase === "error" ? `I can't connect to the model provider you set up (${o.own}) yet: the line below says why. You can check its details here, or later in Settings › Models & connections.`
        // A host elsewhere wasn't contacted at the start: "using", as the line under it says (first-run-r3-2).
        : `I'm ${onThisComputer(o.own) ? "connected to" : "using"} the model provider you set up (${o.own}), so there's no GitHub sign-in to do. You can change it later in Settings › Models & connections.`;
    return { title: "Your own model provider", lead };
  }
  if (o.ownOffered === false) return { ...STEP_TEXT["sign-in"], lead: STEP_TEXT["sign-in"].lead.replace(OWN_OFFER, "") };
  return STEP_TEXT["sign-in"];
}

/** The sign-in lead's last sentence, which offers the user's own provider (left out where it isn't offered). */
const OWN_OFFER = " No Copilot? You can use your own model provider instead.";

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
  /** Offer "Check again" (a sign-in made elsewhere, such as the GitHub CLI's, is looked for again). */
  retry: boolean;
}

/**
 * `phase`, `reason` and `login` from the agent's status (null while it hasn't come), `signingIn` while a device flow
 * runs, `managedProvider` when the organisation's own model service answers instead of Copilot (nothing to sign in
 * to), `locked` while the organisation's policy locks Ember down (nothing connects; signing in can't help). `service`:
 * the model service the connection uses when it isn't Copilot (the agent's status), so the user's own provider is
 * never called Copilot (first-run-1). `switching`: the user's own provider was switched off while Ember was busy, and
 * Ember moves to Copilot once that is done (the agent's `switchPending`): nothing connects yet, and the way on is open
 * (first-run-v4-1).
 */
export function signInView(o: { phase: string | null; reason?: string; login?: string; signingIn: boolean; managedProvider: boolean; locked?: boolean; service?: { kind: string; host: string }; switching?: boolean }): SignInView {
  const none = { cancel: false, skip: false, retry: false };
  const own = o.service?.kind === "user" ? `your own provider (${o.service.host})` : o.service?.kind === "test" ? o.service.host : null;
  if (o.phase === "ready") {
    // The user's own provider elsewhere wasn't contacted at the start: "Using", as Home says (integrations-r2-6).
    const near = o.service?.kind !== "user" || onThisComputer(o.service.host);
    const who = o.managedProvider ? "Connected to your organisation's model service." : own ? `${near ? "Connected to" : "Using"} ${own}.` : o.login ? `Signed in as ${o.login}.` : "Connected to Copilot.";
    return { ...none, line: who, tone: "ok", primary: "continue", why: "" };
  }
  // Signing in can't help: the policy holds Ember back, so the way on is Continue (the line says why).
  if (o.locked) return { ...none, line: "Your organisation's policy locks me down, so I can't connect for now.", tone: "error", primary: "continue", why: "" };
  if (o.phase === "error" && o.reason === "policy") return { ...none, line: "", tone: "error", primary: "continue", why: "" };
  if (o.signingIn) return { ...none, line: "", tone: "", primary: "continue", why: "Waiting for you to approve the sign-in in your browser.", cancel: true };
  if (o.switching) return { ...none, line: SWITCH_WAITS, tone: "", primary: "continue", why: "" };
  const service = o.managedProvider ? "your organisation's model service" : own ?? "Copilot";
  if (o.phase === "starting" || o.phase === null) return { ...none, line: `Connecting to ${service}…`, tone: "", primary: "continue", why: `Still connecting to ${service}.`, skip: true };
  // The organisation's service didn't answer: nothing to sign in to, so Continue (settings shows it again later).
  if (o.managedProvider) return { ...none, line: "", tone: "error", primary: "continue", why: "" };
  return { ...none, line: "", tone: "", primary: "sign-in", why: "", skip: true, retry: true };
}

/** The sign-in step's line while Ember finishes what it is doing before it moves to Copilot (first-run-v4-1). */
export const SWITCH_WAITS = "I'll switch to Copilot once I've finished what I'm doing.";

/**
 * The line once that switch is made and the step's Continue has become its sign-in (`signInWith` as signInLabel names
 * it): said, as the focus leaves that button, so a press meant for Continue starts nothing (first-run-c4-1).
 */
export function switchedLine(signInWith?: string): string {
  return `I've switched to Copilot. ${signInWith === "github-cli" ? "Connect with GitHub CLI" : "Sign in with GitHub"} to go on, or skip for now.`;
}

/** "Check again": looks for a sign-in made elsewhere (the GitHub CLI's) and connects with it. */
export const CHECK_AGAIN = "Check again";

/** What "Skip for now" leaves for later, and where. */
export const SKIP_SIGN_IN = "You can sign in later in Settings › Models & connections. Until then I can't answer or act.";
/** The same, while the user's own provider connects or fails: there is nothing to sign in to (first-run-1). */
export const SKIP_OWN = "You can go on for now and check it later in Settings › Models & connections. Until I'm connected, I can't answer or act.";

/**
 * A setup row in plain words: a short title, what it means for the user, how serious it is (`held`: Ember can't read,
 * see or use apps until it's fixed), its fix's buttons (from the row), and a command to copy when the fix is one the
 * user runs themselves (Linux's packages).
 */
export interface PlainCheck { id: string; title: string; text: string; held: boolean; tone: "ok" | "warn" | "fail"; fix?: string; alt?: string; command?: string }

/** The command a row's detail tells the user to run ("…: sudo dnf install python3-pyatspi"), if any. */
export function fixCommand(detail: string): string | undefined {
  return /\b(sudo [^.;,]+?)\s*(?:\.(?:\s|$)|,|$)/.exec(detail)?.[1].trim();
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

/**
 * A row whose fix took but leaves the user something to do (environment.ts Check `next`): what is done and what is left,
 * by row id (first-run-3).
 */
const PLAIN_NEXT: Readonly<Record<string, { title: string; text: string }>> = {
  accessibility: { title: "Screen reading is on", text: "Restart apps that were already open, or log out and in, so I can read them." },
};

/** The row's fix took, and something is left for the user to do that first run says (`next`, with words for it). */
const leftToDo = (r: SetupRow & { next?: boolean }) => r.status === "ok" && !!r.next && !!PLAIN_NEXT[r.id.split(":")[0]];

/** The rows the checks step shows (those that need the user, and those a fix left something to do for), in plain words. */
export function plainChecks(rows: readonly (SetupRow & { alt?: string; detail?: string; next?: boolean })[]): PlainCheck[] {
  return rows.filter(r => needsUser(r) || leftToDo(r)).map(r => {
    if (leftToDo(r)) return { id: r.id, ...PLAIN_NEXT[r.id.split(":")[0]], held: false, tone: "ok" as const };
    const p = PLAIN[r.id.split(":")[0]] ?? { title: r.label, text: "This needs a look before I can do everything." };
    // No button fixes it here: the command to run, or the details' advice.
    const command = r.fix ? undefined : fixCommand(r.detail ?? "");
    const text = r.fix ? p.text : command ? `${p.text} Run the command below, or ask your administrator to.` : `${p.text} The details below say what to do.`;
    return { id: r.id, title: p.title, text, held: holdsBack(r), tone: r.status === "fail" ? "fail" : "warn", ...(r.fix ? { fix: r.fix } : {}), ...(r.alt ? { alt: r.alt } : {}), ...(command ? { command } : {}) };
  });
}

/** The checks step's headline: all good, things that hold Ember back, only things worth a look, or something left to do. */
export function checksHeadline(rows: readonly (SetupRow & { next?: boolean })[]): { text: string; tone: "ok" | "warn" | "fail" } {
  const held = rows.filter(holdsBack).length;
  const look = rows.filter(needsUser).length;
  const left = rows.filter(leftToDo).length;
  // A fix that took but leaves a restart to the user is never "everything is ready" (first-run-3).
  if (!look && left) return { text: left === 1 ? "Ready, with one thing left for you to do." : `Ready, with ${left} things left for you to do.`, tone: "ok" };
  if (!look) return { text: "Everything I need is ready.", tone: "ok" };
  // One severity on the step: red only when a row fails outright, the same mark on the headline and on the row.
  const tone = rows.some(r => r.status === "fail") ? "fail" : "warn";
  if (held) return { text: held === 1 ? "One thing to fix so I can read and use your apps." : `${held} things to fix so I can read and use your apps.`, tone };
  return { text: look === 1 ? "One thing is worth a look. I work without it." : `${look} things are worth a look. I work without them.`, tone: "warn" };
}

/** Under the checks: what happens if the user goes on without fixing them, and where to come back. */
export function checksLater(rows: readonly SetupRow[]): string {
  // Named as the sidebar names it (first-run-9): the setup check is in Setup & about.
  if (rows.some(holdsBack)) return "You can go on and fix this later in Settings › Setup & about. Until then I can answer questions, but some tasks won't work.";
  return rows.some(needsUser) ? "You can fix these later in Settings › Setup & about." : "";
}

/**
 * What Check again found (first-run-6), for the live line: the rows that needed the user and no longer do, by name, or
 * that nothing has changed yet. First run and Home's setup check say it alike.
 */
export function recheckMessage(before: readonly SetupRow[], after: readonly SetupRow[]): string {
  const fixed = before.filter(needsUser).filter(r => !after.some(a => a.id === r.id && needsUser(a))).map(r => r.label);
  if (!fixed.length) return "I checked again. Nothing has changed yet.";
  const names = fixed.length === 1 ? fixed[0] : `${fixed.slice(0, -1).join(", ")} and ${fixed.at(-1)}`;
  return `I checked again. ${names} ${fixed.length === 1 ? "is" : "are"} ready now.`;
}

/** The checks step's Continue: "Continue anyway" while something holds Ember back (it never blocks the flow). */
export function checksNext(rows: readonly SetupRow[]): string {
  return rows.some(holdsBack) ? "Continue anyway" : "Continue";
}

/**
 * A setup row's state in words beside its symbol (never colour alone, never a code like "OK"), in first run's details
 * and Home's setup check alike (first-run-9). `held`: the row holds Ember back (holdsBack), so a warning about it needs
 * fixing, as the counts say (first-run-5).
 */
export function checkState(status: SetupRow["status"], held = false): string {
  return status === "ok" ? "Ready" : status === "warn" && !held ? "Worth a look" : "Needs fixing";
}

/** The disclosure with every row and its technical detail. */
export const CHECKS_DETAIL = "Show the details";

/** The try step's three tries: what each says before and after it is done. */
export const TRY_TEXT = {
  stop: { title: "Stop me", fallback: "Use Stop everything from my handle or Home whenever you need me to stop. The stop shortcut is unavailable on this computer.", ask: "Press the stop shortcut now. It stops everything I'm doing, at once, anywhere.", done: "That's how you stop me." },
  voice: { title: "Say “Hey Ember”", ask: "Say “Hey Ember”, then ask something and watch the meter.", done: "I heard you." },
  ask: { title: "Ask me something", ask: "Open the ask box and type a question, such as “What can you do?”", done: "You asked me something.", open: "Open the ask box" },
  /** The ask box can't be opened yet: why, beside its button (askWhy() picks the one that holds). */
  askWhy: "Sign in first, then you can ask me something.",
  /** Not connected yet to a service with nothing to sign in to (the organisation's, the user's own). */
  askWait: "Once I'm connected, you can ask me something.",
  /** Under the organisation's lockdown nothing connects, so signing in can't help (first-run-v1). */
  askLocked: "While your organisation's policy locks me down, I can't answer.",
  /** Voice is off (not turned on, or not agreed to): the try isn't shown, and this says where to turn it on. */
  voiceLater: "To talk to me, turn on “Hey Ember” later in Settings › Voice. Then say, for example, “Hey Ember, what's in this window?”",
  /** Voice is on and agreed to, but its speech models aren't here and nothing fetches them by itself (first-run-r7-2). */
  voiceNoModels: "I can't listen for “Hey Ember” yet: my speech models aren't on this computer. Download them later in Settings › Voice.",
  /** Voice is on but not listening yet (models downloading, or starting). */
  voiceWaiting: "I'm not listening yet. Once I am, say “Hey Ember”.",
} as const;

/** Why the try step's ask box can't be opened yet: locked down, waiting for a service with no sign-in, or not signed in. */
export function askWhy(o: { locked: boolean; noSignIn: boolean }): string {
  return o.locked ? TRY_TEXT.askLocked : o.noSignIn ? TRY_TEXT.askWait : TRY_TEXT.askWhy;
}

/**
 * "Say “Hey Ember”" shows only while Ember listens for it: on, agreed to, allowed by the organisation
 * (`features.voice`), not muted, and the microphone open. Muted, off, not working or not allowed counts as off; on
 * with its speech models missing is "no-models": it won't listen until they are downloaded, so neither "not yet,
 * once I am" nor "On" is said (first-run-r7-2).
 */
export function voiceTry(o: { wakeWord: boolean; voiceConsent: boolean; state: string | null; allowed?: boolean; muted?: boolean }): "listening" | "waiting" | "off" | "no-models" {
  if (!o.wakeWord || !o.voiceConsent || o.allowed === false || o.muted) return "off";
  if (o.state === "off" || o.state === "muted" || o.state === "error") return "off";
  if (o.state === "needs-models") return "no-models";
  return o.state === "waiting" || o.state === "active" ? "listening" : "waiting";
}

/** Ember's size until the user moves the slider (settings.ts's default). */
export const DEFAULT_SIZE = 60;

/** One row of the last step's card. */
export interface SummaryRow { label: string; value: string }

/** The last step's card's rows: who, Copilot, voice, and the keys Ember holds (a key another app holds isn't named). */
export function summaryRows(o: {
  character: string; size: number; signedIn: string | null; voice: "listening" | "waiting" | "off" | "no-models";
  /** The keys as Ember holds them ("" while another app holds one); null until the status names this OS's. */
  keys: { ask: string; stop: string; settings: string } | null;
  /** False when the model service isn't GitHub Copilot (the user's own, the organisation's): the row isn't called Copilot (first-run-1). */
  copilot?: boolean;
}): SummaryRow[] {
  const rows: SummaryRow[] = [
    // The size in pixels only once the user changed it: "Default size" says as much without a number to decode.
    { label: "Character", value: o.size === DEFAULT_SIZE ? `${o.character}, default size` : `${o.character}, ${o.size} px` },
    { label: o.copilot === false ? "Model service" : "Copilot", value: o.signedIn ?? "Not signed in yet" },
    { label: "“Hey Ember”", value: o.voice === "off" ? "Off" : o.voice === "no-models" ? "Not yet: its speech models need downloading" : "On" },
  ];
  if (o.keys?.ask) rows.push({ label: "Ask", value: o.keys.ask });
  if (o.keys?.stop) rows.push({ label: "Stop everything", value: o.keys.stop });
  if (o.keys?.settings) rows.push({ label: "Settings", value: o.keys.settings });
  return rows;
}

/**
 * The card's model service row: the service Ember is connected through; while it isn't, the user's own provider
 * (`service` kind "user") or the organisation's (`managed`, or kind "admin") by name, never "Not signed in yet" for a
 * service with nothing to sign in to (first-run-c1-3); null while Copilot isn't signed in yet.
 */
export function serviceSummary(o: { ready: boolean; locked: boolean; managed: boolean; service?: { kind: string; host: string }; login?: string }): string | null {
  const own = o.service?.kind === "user" ? `Your own provider (${o.service.host})` : null;
  if (o.ready) return own ?? (o.managed ? "Your organisation's model service" : o.login ? `Signed in as ${o.login}` : "Connected");
  if (o.locked) return "Locked down by your organisation";
  if (own) return `${own}, not connected yet`;
  return o.managed || o.service?.kind === "admin" ? "Your organisation's model service, not connected yet" : null;
}

/** Under the card: where to change it all later. */
export const SUMMARY_NOTE = "You can change any of this in Settings, which opens from my handle in the corner of your screen.";

/** The last button, and what a screen reader hears once it has worked. */
export const START_LABEL = "Start";

/** The navigation buttons. */
export const NAV = { back: "Back", next: "Continue", begin: "Get started", skip: "Skip for now", character: "Choose a character…", about: "Personalise memory…" } as const;

/**
 * The "about you" step's main button: it saves what was answered, or goes on without (nothing kept); and while memory
 * is paused, when nothing can be answered, it just goes on (memory-c1-2).
 */
export function aboutNext(o: { ready: boolean; filled: boolean; paused?: boolean }): string {
  if (o.paused) return NAV.next;
  return o.ready && o.filled ? "Save and continue" : NAV.skip;
}
