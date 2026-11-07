/**
 * First run's connection words and decisions beyond Copilot's sign-in (audit FE #2–#5): the choice between GitHub
 * Copilot and the user's own model provider (and why it is sometimes not offered), what each way of failing leaves the
 * user to do, and the models Ember chose, with their cost and the limits of a text-only fallback. Pure (no DOM, no
 * Electron): welcome.ts and main.ts apply it, the tests read it directly. Nothing here says a sign-in or a model is
 * valid; that is always the answer of the real check.
 */

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

/** Which of Home's connection buttons show, which one leads, and the help words under the status line. */
export interface HomeConnectionView { help: string; show: Record<FailureAction, boolean>; primary: FailureAction | null }

/**
 * Home's Models & connections area for a Copilot that isn't connected (FE #3, the same recovery as first run's): the
 * action that leads comes from why it failed (`failureView`), so an account without Copilot is never offered
 * "Sign in with GitHub" first. "Check again" stays for every way of not being connected, as before. `waiting` (Copilot
 * stopped answering with tasks at work) and `signingIn` keep their own buttons and show nothing else.
 */
export function homeConnectionView(o: { phase: string; reason?: string; detail?: string; ownOffered: boolean; signingIn: boolean; waiting: boolean; service?: string }): HomeConnectionView {
  const none: Record<FailureAction, boolean> = { retry: false, "switch-account": false, "own-provider": false, "sign-in": false, provider: false };
  const notConnected = o.phase === "signed-out" || o.phase === "error";
  if (!notConnected || o.signingIn) return { help: "", show: none, primary: null };
  if (o.waiting) return { help: "", show: { ...none, retry: true }, primary: null };
  const v = failureView({ reason: o.phase === "signed-out" ? "sign-in" : o.reason, detail: o.detail, ownOffered: o.ownOffered, service: o.phase === "error" ? o.service : undefined });
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
  back: "Use GitHub Copilot instead",
} as const;

/**
 * The own-provider step when the provider was already in use as the step opened (first run resumed, Back from the
 * checks, or its details opened from a failing connection: first-run-c1-2): its title and lead, never a form that waits
 * for an agreement already given.
 */
export function providerInUse(host: string): { title: string; lead: string } {
  return { title: "Your own model provider's details", lead: `I'm using the model provider you set up (${host}) instead of GitHub Copilot. You can change its details here.` };
}

/** That step's status line, from the connection's (`phase`, and main's `detail` when it failed). */
export function providerInUseLine(o: { host: string; phase: string | null; detail?: string }): { line: string; tone: "" | "ok" | "error" } {
  if (o.phase === "ready") return { line: `Connected to your own provider (${o.host}).`, tone: "ok" };
  if (o.phase === "error") return { line: o.detail ?? "", tone: "error" };
  return { line: `Connecting to your own provider (${o.host})…`, tone: "" };
}

/** What the provider check found, as a status line (the real answer only; `why` is main's sentence). */
export function providerCheckLine(r: { ok: true; host: string; models: number | null } | { ok: false; why: string }): string {
  if (!r.ok) return r.why;
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
