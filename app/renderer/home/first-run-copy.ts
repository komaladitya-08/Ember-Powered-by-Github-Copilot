/**
 * First run's connection words and decisions beyond Copilot's sign-in (audit FE #2–#5): the choice between GitHub
 * Copilot and the user's own model provider (and why it is sometimes not offered), what each way of failing leaves the
 * user to do, and the models Ember chose, with their cost and the limits of a text-only fallback. Pure (no DOM, no
 * Electron): welcome.ts and main.ts apply it, the tests read it directly. Nothing here says a sign-in or a model is
 * valid; that is always the answer of the real check.
 */

import { onThisComputer } from "../../shared/provider";

/** The ways on from a failed connection ("provider": the user's own provider's details, when it is the one failing). */
export type FailureAction = "retry" | "switch-account" | "own-provider" | "sign-in" | "provider";

/** What the user is shown for a failed connection: help words, the prominent action and the others. */
export interface FailureView {
  help: string;
  primary: FailureAction | "continue";
  others: FailureAction[];
}

export const ACTION_LABEL: Readonly<Record<FailureAction, string>> = {
  retry: "Try again",
  "switch-account": "Try a different GitHub account",
  "own-provider": "Use my own provider",
  "sign-in": "Sign in with GitHub",
  provider: "Check my provider's details",
};

/**
 * Own provider on first run: offered unless the organisation runs its own service (`managedProvider`), turned it off
 * (`userProviderOff`), locks Ember down, or the provider bridge is missing. When it is not offered but Copilot is the
 * way in, `why` says so rather than leaving the choice unexplained.
 */
export function ownProviderOffer(o: { bridge: boolean; managedProvider: boolean; locked: boolean; userProviderOff: boolean }): { offered: true } | { offered: false; why: string } {
  if (o.locked) return { offered: false, why: "" };
  if (o.managedProvider) return { offered: false, why: "Your organisation decides which model service I use, so there is no provider to choose." };
  if (o.userProviderOff) return { offered: false, why: "Your organisation turned off using your own model provider, so GitHub Copilot is the way in." };
  if (!o.bridge) return { offered: false, why: "" };
  return { offered: true };
}

/** An organisation's rule is part of the failure's own words (the host's detail names it). */
const ORGANISATION = /organi[sz]ation|\bpolicy\b/i;

/**
 * What to do about a failed connection, by why it failed. An entitlement failure (`no-access`) is never answered with
 * signing in again as the prominent action: the account has no Copilot, and the same account signing in again changes
 * nothing. `ownOffered` is `ownProviderOffer(...).offered`. `service`: the model service that failed when it isn't
 * Copilot (the agent's status): then no GitHub account, sign-in or Copilot words are offered, and the user's own
 * provider leads with its own details (integrations-3).
 */
export function failureView(o: { reason?: string; detail?: string; ownOffered: boolean; service?: string }): FailureView {
  const own = o.ownOffered;
  const withOwn = (list: FailureAction[]): FailureAction[] => (own ? list : list.filter(a => a !== "own-provider"));
  if (o.service) {
    // The status line says what went wrong in the service's own words; the way on is its details, or trying again.
    const mine = o.service === "user";
    const fields = o.reason === "models" || o.reason === "sign-in" || o.reason === "no-access";
    if (!mine) return { help: "", primary: "retry", others: [] };
    return fields ? { help: "", primary: "provider", others: ["retry"] } : { help: "", primary: "retry", others: ["provider"] };
  }
  switch (o.reason) {
    case "no-access": {
      const org = ORGANISATION.test(o.detail ?? "");
      const help = org
        ? "Copilot is switched off for this account by an organisation. Ask its administrator to allow Copilot for you, use a different GitHub account, or use your own model provider."
        : "This GitHub account doesn't have Copilot. Get Copilot for it on GitHub (github.com/features/copilot), use a different GitHub account, or use your own model provider.";
      return own
        ? { help, primary: "own-provider", others: ["switch-account", "retry"] }
        : { help, primary: "switch-account", others: ["retry"] };
    }
    case "sign-in":
      return { help: "", primary: "sign-in", others: withOwn(["own-provider"]) };
    case "models": {
      // The administrator's list leaves none, or the account has its models turned off (the host's detail says which).
      const admin = /administrator/i.test(o.detail ?? "");
      const help = admin
        ? `None of the models your administrator allows is one I can use. Ask them to allow one${own ? ", or use your own model provider" : ""}.`
        : `Copilot lists no model this account may use. Turn one on in your Copilot settings on GitHub${own ? ", or use your own model provider" : ""}.`;
      return { help, primary: own ? "own-provider" : "retry", others: own ? ["retry", "switch-account"] : ["switch-account"] };
    }
    case "network":
      return { help: "", primary: "retry", others: withOwn(["own-provider"]) };
    default:
      return { help: "", primary: "retry", others: withOwn(["own-provider"]) };
  }
}

/**
 * Which of Home's connection buttons show, which one leads, and the help words under the status line; `line`: the
 * status line's words instead of main's, where Home knows better why nothing is connected (integrations-c2-3).
 */
export interface HomeConnectionView { help: string; show: Record<FailureAction, boolean>; primary: FailureAction | null; line?: string }

/**
 * Home's Models & connections area for a Copilot that isn't connected (FE #3, the same recovery as first run's): the
 * action that leads comes from why it failed (`failureView`), so an account without Copilot is never offered
 * "Sign in with GitHub" first. "Check again" stays for every way of not being connected, as before. `waiting` (Copilot
 * stopped answering with tasks at work) and `signingIn` keep their own buttons and show nothing else. `own`: the user's
 * own provider's switch (`on`) and the host whose card is up under Model provider (`card`). While that card waits with
 * no GitHub sign-in, nothing is connected, but signing in isn't the way on: the line and help say what is, with no
 * button (the card's I agree is the one), and the switch that is on is never offered as a way on (integrations-c2-3).
 */
export function homeConnectionView(o: { phase: string; reason?: string; detail?: string; ownOffered: boolean; signingIn: boolean; waiting: boolean; service?: string; own?: { on: boolean; card: string | null } }): HomeConnectionView {
  const none: Record<FailureAction, boolean> = { retry: false, "switch-account": false, "own-provider": false, "sign-in": false, provider: false };
  const notConnected = o.phase === "signed-out" || o.phase === "error";
  if (!notConnected || o.signingIn) return { help: "", show: none, primary: null };
  if (o.waiting) return { help: "", show: { ...none, retry: true }, primary: null };
  if (o.phase === "signed-out" && o.own?.on && o.own.card) {
    return {
      line: `Not connected: Ember is waiting for you to agree to use ${o.own.card}.`,
      help: "Agree in the note under Model provider below, or turn off “Use my own model provider” to use GitHub Copilot instead.",
      show: none, primary: null,
    };
  }
  const v = failureView({ reason: o.phase === "signed-out" ? "sign-in" : o.reason, detail: o.detail, ownOffered: o.ownOffered && !o.own?.on, service: o.phase === "error" ? o.service : undefined });
  const show = { ...none, retry: true };
  for (const a of [v.primary, ...v.others]) if (a !== "continue") show[a] = true;
  return { help: v.help, show, primary: v.primary === "continue" ? null : v.primary };
}

/** The own-provider step's words. */
export const PROVIDER_STEP = {
  title: "Use your own model provider",
  lead: "Use any service that speaks the OpenAI, Azure OpenAI or Anthropic API instead of GitHub Copilot.",
  needs: [
    "The service's full address, starting with https://, or http://localhost for a model server on this computer.",
    "An API key from the service, unless it's a model server on this computer that needs none. I keep it encrypted on this computer and send it only to that address.",
    "The name of a model it offers, such as gpt-4.1. A second model for tasks is optional.",
  ],
  check: "Agree and check the models",
  checking: "Checking the service…",
  fixPrompt: "Check the details above, then try again.",
  /** The provider could not be switched off again after a check that was left: it is still on, and the way to retry. */
  offFailed: "I couldn't switch your own provider off, so it is still on. Try again, or turn it off in Settings › Models & connections.",
  offRetry: "Switch it off",
  needAddress: "Enter the service's full address first.",
  needKey: "Paste the API key first.",
  needModel: "Enter the name of a model first.",
  waiting: "Check the provider first.",
  noKeyring: "This computer has no keyring for passwords, so I can't keep an API key safely here. A model server on this computer that needs no key still works; for any other service, go back to use GitHub Copilot.",
  /** Beside the button that waits for it: the reason in short, as the line above says it whole. */
  noKeyringWhy: "I can't keep a key safely on this computer.",
  back: "Use GitHub Copilot instead",
} as const;

/**
 * The key field's placeholder. A saved key is said only for the address it was saved for (`keyHost`, main's state now:
 * main keeps it for that host alone and sends it nowhere else), so another address typed asks for its own key.
 */
export function keyPlaceholder(o: { keySaved: boolean; keyHost: string | null; host: string | null }): string {
  return o.keySaved && !!o.host && o.keyHost === o.host ? "A key is saved. Paste a new one to replace it" : "Paste your key";
}

/**
 * The own-provider step when the provider was already in use as the step opened (first run resumed, Back from the
 * checks, or its details opened from a failing connection: first-run-c1-2): its title and lead, never a form that waits
 * for an agreement already given.
 */
export function providerInUse(host: string): { title: string; lead: string } {
  return { title: "Your own model provider's details", lead: `I'm using the model provider you set up (${host}) instead of GitHub Copilot. You can change its details here.` };
}

/** Where a sentence or a clause starts: the text's start, after a full stop, colon or semicolon, or after "and", "so", "but". */
const CLAUSE = String.raw`(^|[.!?:;]\s+|\b(?:and|so|but)\s+)`;
/** Ember as the subject of a clause, as I (first-run-r4-2). */
const AS_ME: readonly (readonly [RegExp, string])[] = ([
  ["can't", "I can't"], ["couldn't", "I couldn't"], ["won't", "I won't"], ["didn't", "I didn't"], ["doesn't", "I don't"], ["isn't", "I'm not"],
  ["will", "I'll"], ["needs", "I need"], ["sends", "I send"], ["sent", "I sent"], ["connects", "I connect"], ["uses", "I use"], ["signs", "I sign"],
] as const).map(([verb, mine]) => [new RegExp(`${CLAUSE}Ember ${verb}\\b`, "g"), `$1${mine}`] as const);
/** Ember named inside one of main's connection sentences as the one acting or acted on, as me (first-run-r4-2). */
const AS_ME_WITHIN: readonly (readonly [RegExp, string])[] = [
  [/(^|[.!?:;]\s+)Ember's Copilot runtime\b/g, "$1My Copilot runtime"], [/\bwhich Ember's Copilot runtime\b/g, "which my Copilot runtime"],
  [/(^|[.!?:;]\s+)It will try again\b/g, "$1I'll try again"], [/\bsent Ember to\b/g, "sent me to"], [/\bsetting Ember up\b/g, "setting me up"],
  [/\brestart Ember\b/g, "restart me"], [/\bwhich model( service)? Ember uses\b/g, "which model$1 I use"], [/\bwhile Ember connected\b/g, "while I connected"],
  [/\bthe GitHub sign-in Ember found\b/g, "the GitHub sign-in I found"], [/\b(I couldn't save [^.:]+: )its data folder\b/g, "$1my data folder"],
  // What a clause said as mine names as Ember's comes along (first-run-v5-1, v5-2): the bubble's "My model connection".
  [/(^|[.!?:;]\s+)Ember's model connection\b/g, "$1My model connection"], [/\bEmber's saved sign-in\b/g, "my saved sign-in"],
  [/(^|[.!?:;]\s+)One of Ember's files\b/g, "$1One of my files"], [/(\bI\b[^.!?:;]* )one of its files\b/g, "$1one of my files"],
  [/(\bI\b[^.!?]* one )it knows\b/g, "$1I know"],
];

/**
 * Main's connection and check sentences (provider.ts's, the agent's status), written for Models & connections, which
 * speaks of Ember, as first run says them: in Ember's own voice, as every other line of first run is ("Ember can't
 * reach…" → "I can't reach…", "and Ember will connect" → "and I'll connect"), on every visit (first-run-r4-2), with
 * what it calls Ember's or its as mine ("my saved sign-in", "one of my files": first-run-v5-1). Ember named as the
 * app, its settings or its environment ("in Ember's settings", "for Ember") stays. Said once: a line already in my
 * voice is left as it is.
 */
export function inMyVoice(line: string): string {
  return [...AS_ME, ...AS_ME_WITHIN].reduce((s, [re, to]) => s.replace(re, to), line);
}

/** Main's "press Check again" (Home's button), but where it names Models & connections, whose button it is there. */
const PRESS_CHECK_AGAIN = /\b([Pp])ress Check again(?! in Models)(?: to retry)?/g;

/**
 * Main's line as a first-run step says it, naming only a button the step shows (first-run-w5-2): main's "press Check
 * again" is Home's button. The sign-in step shows it only for a sign-in made with the GitHub CLI (`"check-again"`: the
 * line stays); otherwise the step's own button for the same check is Try again (`"try-again"`). The provider step in
 * use has neither, so it says the way to it (`"go-back"`: its Back is the sign-in step, which shows Try again).
 */
export function pressOnStep(line: string, button: "check-again" | "try-again" | "go-back"): string {
  if (button === "check-again") return line;
  return line.replace(PRESS_CHECK_AGAIN, (_m, p: string) => `${button === "go-back" ? `${p === "P" ? "Go" : "go"} back and press` : `${p}ress`} ${ACTION_LABEL.retry}`);
}

/**
 * The sign-in step's line and the ways on beside its primary button (first-run-w5-2): a line that asks to check again
 * names the button the step shows for it (`checkAgain`: the GitHub CLI's Check again is shown), and when nothing on the
 * step does that check, the step shows Try again too, so the line never names a button that isn't there.
 */
export function signInWays(o: { line: string; checkAgain: boolean; primary: FailureAction | "continue"; others: readonly FailureAction[] }): { line: string; others: FailureAction[] } {
  const line = pressOnStep(o.line, o.checkAgain ? "check-again" : "try-again");
  const offer = line !== o.line && o.primary !== "retry" && !o.others.includes("retry");
  return { line, others: offer ? [...o.others, "retry"] : [...o.others] };
}

/**
 * That step's status line, from the connection's (`phase`, and main's `detail` when it failed, said as mine:
 * first-run-r4-2). Ready, a server on this computer was asked at the start and is "Connected"; a host elsewhere wasn't,
 * so it is only "Using", as Home's status says (integrations-r3, integrations-r2-6). Failed, it names the way to the
 * sign-in step's Try again for main's "press Check again", a button this step doesn't have (first-run-w5-2).
 */
export function providerInUseLine(o: { host: string; phase: string | null; detail?: string }): { line: string; tone: "" | "ok" | "error" } {
  if (o.phase === "ready") return { line: `${onThisComputer(o.host) ? "Connected to" : "Using"} your own provider (${o.host}).`, tone: "ok" };
  if (o.phase === "error") return { line: pressOnStep(inMyVoice(o.detail ?? ""), "go-back"), tone: "error" };
  return { line: `Connecting to your own provider (${o.host})…`, tone: "" };
}

/**
 * A check of new details for a provider in use that failed (first-run-r2-1): what failed, and that the details in use
 * are still the ones Ember uses, since nothing was saved before they answered. One status line in one voice, first
 * run's: main's sentence about Ember is said as Ember's own (first-run-c3-1).
 */
export function providerKeptLine(line: string, host: string): string {
  return `${inMyVoice(line)} Nothing has changed: I'm still using ${host}.`;
}

/** The way on after that failure: the details in use come back, and Continue goes on with them (first-run-c3-1). */
export function providerKeepLabel(host: string): string {
  return `Keep using ${host}`;
}

/**
 * The field a failed provider check names, to take the focus (first-run-r2-1): the address when nothing answered
 * there (`cause`) or the trouble is anything but the key, the key when the key is what failed.
 */
export function providerFailField(r: { why: string; cause?: string }): "address" | "key" {
  if (r.cause) return "address";
  return /\bkey(ring)?\b/i.test(r.why) ? "key" : "address";
}

/**
 * What the provider check found, as a status line (the real answer only; `why` is main's sentence, said as mine on
 * every visit, as after a failed edit of the provider in use: first-run-r4-2).
 */
export function providerCheckLine(r: { ok: true; host: string; models: number | null } | { ok: false; why: string }): string {
  if (!r.ok) return inMyVoice(r.why);
  if (r.models === null) return `Connected to ${r.host}.`;
  return `Connected to ${r.host}. It lists ${r.models} ${r.models === 1 ? "model" : "models"}.`;
}

/** A model's cost against Copilot's premium requests, in words; "" when Copilot didn't say. */
export function costWords(cost: number | undefined): string {
  if (typeof cost !== "number" || !Number.isFinite(cost) || cost < 0) return "";
  if (cost === 0) return "no premium requests";
  if (cost === 1) return "1 premium request a message";
  return `${Number(cost.toFixed(2))}× premium requests a message`;
}

export interface ListedModel { id: string; name: string; vision: boolean; cost?: number }

/**
 * The tasks' model selector: models that read images, or, when the catalogue lists models but none reads images,
 * every model with the fallback's limitation said (tasks then work from text). Never empty for a non-empty catalogue.
 */
export function taskModelChoices(models: readonly ListedModel[], worker: string | null): { options: ListedModel[]; textOnly: boolean; label: string; note: string } {
  const vision = models.filter(m => m.vision);
  if (vision.length || !models.length) return { options: vision, textOnly: false, label: "Model for tasks (must understand images)", note: "" };
  const using = models.find(m => m.id === worker)?.name ?? worker;
  return {
    options: [...models],
    textOnly: true,
    label: "Model for tasks (text only)",
    note: `None of the models listed can read screenshots${using ? `, so tasks use ${using}` : ""} and work from text, which can make them less reliable in apps that show little text.`,
  };
}

export interface ModelRow { label: string; value: string; note: string }

/**
 * "Models I'll use": the conversation's and the tasks' model as Ember chose them, with the cost where Copilot says it
 * and the limitation of a text-only task model. `own`: the user's own provider (no Copilot costs; a model it names, or
 * its own default).
 */
export function modelRows(o: { models: readonly ListedModel[]; conductor: string | null; worker: string | null; own: boolean }): ModelRow[] {
  const find = (id: string | null) => o.models.find(m => m.id === id);
  const name = (id: string | null) => find(id)?.name ?? id ?? (o.own ? "The provider's default" : "The default model");
  const cost = (id: string | null) => (o.own ? "" : costWords(find(id)?.cost));
  const worker = find(o.worker);
  const textOnly = o.worker !== null && !o.own && !!worker && !worker.vision;
  return [
    { label: "Conversation", value: name(o.conductor), note: cost(o.conductor) },
    { label: "Tasks", value: name(o.worker ?? o.conductor), note: [cost(o.worker ?? o.conductor), textOnly ? "text only, it can't read screenshots" : ""].filter(Boolean).join("; ") },
  ];
}
