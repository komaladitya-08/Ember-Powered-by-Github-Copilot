/**
 * First run in the settings window (`#welcome`): Ember introduces itself, optional character choice, the consent is
 * agreed (the gate: nothing is read, heard or sent before it, M8.8), GitHub is signed in to, the computer is checked,
 * the stop shortcut, "Hey Ember" and a first request are tried for real, and "Your Ember" sums it up before Start.
 * One decision a step, a still step indicator, Back on every step after the first, and a reason beside any button
 * that can't be pressed yet (UI audit #7). The words and decisions are in welcome-copy.ts; this module only applies
 * them. It borrows two of the page's own parts while it runs, the character canvas and the character cards, and puts
 * them back when Ember starts, so settings keeps them where they always were.
 */

import type { AgentStatus } from "../../main/agent/host";
import type { Settings, SettingsPatch } from "../../main/settings";
import { CONSENT_VERSION, consentChangesSince } from "../../shared/consent";
import type { ProviderState, Status, VoiceStatus } from "../../shared/ipc";
import { AGREE_ARM_MS, endpointHost, endpointProblem, keyNeeded, latestOnly, MODEL_ID, type ProviderType } from "../../shared/provider";
import { LEVEL_STEPS } from "../../shared/level";
import { holdsBack, needsUser } from "../../shared/setup-attention";
import { keptWords } from "./admin-copy";
import { fixButtonName, fixFailedText, ipcErrorText, retryMessage, signInLabel } from "./copy";
import { mountAboutYou } from "./about-you";
import { providerConsentText } from "./copy";
import { onProviderChoice, providerChoice } from "./provider-choice";
import {
  ACTION_LABEL, failureView, modelRows, ownProviderOffer, PROVIDER_STEP, providerCheckLine, providerInUse, providerInUseLine, taskModelChoices, type FailureAction,
} from "./first-run-copy";
import {
  CHECK_AGAIN, CHECKS_DETAIL, recheckMessage, CONSENT_AGAIN, CONSENT_TEXT, checkState, checksNext, NAV, signInText, SKIP_OWN, SKIP_SIGN_IN, START_LABEL, STEP_TEXT, SUMMARY_NOTE, TRY_TEXT, WELCOME_STEPS, checksHeadline, checksLater,
  DEFAULT_SIZE, aboutNext, askWhy, consentPoints, firstStep, gated, plainChecks, serviceSummary, signInView, stepAfter, stepBefore, stepCount, stepPosition, summaryRows, voiceTry, type WelcomeStep,
} from "./welcome-copy";

/** What the settings window lends the welcome. */
export interface WelcomeDeps {
  /** Saves a change; false when it couldn't be saved (the window's notice says why). */
  save(patch: SettingsPatch): Promise<boolean>;
  /** The character on its tile (the hero's), shown at the head of every step. */
  buddy: HTMLElement;
  /** The character cards (a radio group): the optional character choice. */
  cards: HTMLElement;
  /** Ember has landed on the first step: its character greets once (the rig's happy). */
  arrived(): void;
  /** A fix from the checks step changed the setup rows: the settings window's own setup check follows. */
  checksChanged(env: Status["environment"]): void;
}

export interface Welcome {
  /** New settings; true when they just finished first run here (Start), so the window says Ember started. */
  settings(s: Settings): boolean;
  status(st: Status): void;
  /** Something needs the consent first (signing in from elsewhere): go to that step. */
  toConsent(): void;
}

const $ = (id: string) => document.getElementById(id)!;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}) => Object.assign(document.createElement(tag), props);

export function startWelcome(deps: WelcomeDeps): Welcome {
  const root = $("welcome");
  const next = $("w-next") as HTMLButtonElement;
  const alt = $("w-alt") as HTMLButtonElement;
  const back = $("w-back") as HTMLButtonElement;
  let step: WelcomeStep = "hello";
  let active = false;
  let settings: Settings | null = null;
  let status: Status | null = null;
  let agent: AgentStatus | null = null;
  let voice: VoiceStatus | null = null;
  let signingIn = false;
  let signInMessage: { text: string; tone: string } | null = null;
  let saving = false;
  let navigation = 0;
  /** The page main offers while it waits for a sign-in made elsewhere ("Open cli.github.com"), or null. */
  let waitLink: string | null = null;
  let declined = false;
  /**
   * When the consent's Agree and, once declined, its Quit Ember came up (performance.now()): a press sooner than
   * AGREE_ARM_MS is dropped, so a double click on Get started or Not now lands on neither (first-run-c1-1).
   */
  const shownAt = { agree: -Infinity, quit: -Infinity };
  const armed = (at: number) => performance.now() - at >= AGREE_ARM_MS;
  /** What the sign-in step's main button does: an action on the connection, or just go on. */
  let signInPrimary: FailureAction | "continue" = "continue";
  /** The user's own provider as main reports it (null until read, or when it can't be). */
  let ownState: ProviderState | null = null;
  /** The own-provider step's check: bumped by every edit and by leaving the step, so an older answer is dropped. */
  let checkEpoch = 0;
  /** The newest provider check that was started: only it may put the provider away after its step was abandoned. */
  let checkRun = 0;
  /** Setup fixes under way: their buttons stay disabled however often the rows are drawn again. */
  const fixPending = new Set<string>();
  let providerCheck: { phase: "idle" | "checking" | "ok" | "failed" | "invalid"; line: string } = { phase: "idle", line: "" };
  /**
   * The provider step's visit began with the user's own provider already in use (first-run-c1-2): it is shown as in use,
   * Back leaves it on, and only "Use GitHub Copilot instead" switches it off. `edited`: a field changed in this visit.
   */
  let visitInUse = false;
  let edited = false;
  /** The step's main button goes on (the provider answered, or is in use as it was): set as the step is drawn. */
  let providerGoesOn = false;
  /** The edit area of "Models I'll use" is open. */
  let modelsOpen = false;
  /** The buttons drawn under the sign-in line (drawn again only when they change). */
  let shownActions = "";
  /** A fix that failed, by fix id: shown in its row until it is tried again or works. */
  const fixFailures = new Map<string, string>();
  /** Whether main was last asked for the microphone's level (asked again only when that changes). */
  let levelWanted: boolean | null = null;
  /** The setup rows (and their buttons' words) as last drawn: drawn again only when they change. */
  let shownChecks = "";
  const tried = { stop: false, voice: false, ask: false };
  /** Conversation lines from before the try step: a first request counts only after it. */
  let heardBefore = -1;
  /** Where the borrowed parts live in settings, to put them back. */
  const home = { buddy: [deps.buddy.parentElement, deps.buddy.nextSibling] as const, cards: [deps.cards.parentElement, deps.cards.nextSibling] as const };
  const cardsLabel = deps.cards.getAttribute("aria-labelledby");

  // The still step indicator: one segment a step, lit up to the one you are on. For the eye only; the count says it.
  const arc = $("w-arc");
  arc.replaceChildren(...WELCOME_STEPS.map(() => el("i")));

  const consented = () => (settings?.consent.version ?? 0) >= CONSENT_VERSION;
  /** What changed since an earlier agreement, while it isn't agreed again (first-run-4); none for a first agreement. */
  const changes = () => (consented() ? [] : consentChangesSince(settings?.consent.version ?? 0));
  // "Tell me about you" (optional): memory's note inline, its answers saved by this step's main button.
  const about = mountAboutYou($("w-about"), { id: "w-ay", save: deps.save, ownSave: false, changed: () => { if (active && step === "about") render(); } });
  const memoryManaged = () => status?.admin.features.memory === false;
  const live = (text: string) => { $("w-try-live").textContent = text; };

  function begin(): void {
    active = true;
    $("w-stage").append(deps.buddy);
    $("w-cards").append(deps.cards);
    deps.cards.setAttribute("aria-labelledby", "w-title");
    step = firstStep(settings?.consent.version ?? 0);
    if (step === "consent") shownAt.agree = performance.now();
    void readOwn();
    root.hidden = false;
    render();
    // Ember lands, then greets: one happy hop (none in Calm, where the rig holds still).
    setTimeout(() => { if (active) deps.arrived(); }, 600);
  }
  function finish(): void {
    active = false;
    navigation++;
    wantLevel(false);
    const [bp, bn] = home.buddy; bp?.insertBefore(deps.buddy, bn);
    const [cp, cn] = home.cards; cp?.insertBefore(deps.cards, cn);
    if (cardsLabel) deps.cards.setAttribute("aria-labelledby", cardsLabel);
    root.hidden = true;
  }

  /** Moves to `to` (held at the consent step without agreement), focusing its title so the step is read from the top. */
  function go(to: WelcomeStep): void {
    // The step comes in from the side it lies on (motion only; focus moves at once, as the motion starts).
    root.dataset.dir = stepPosition(to) < stepPosition(step) ? "back" : "next";
    // Leaving the provider step: an older check is dropped, and going back to Copilot puts away a provider this visit
    // set up; one in use as the step opened stays on (first-run-c1-2).
    if (step === "provider" && to !== "provider") {
      checkEpoch++;
      if (to === "sign-in" && !visitInUse) { providerCheck = { phase: "idle", line: "" }; void turnOwnOff(); }
    }
    if (to === "provider" && step !== "provider") {
      visitInUse = ownInForce();
      edited = false;
      // In use: its fields show the details it uses now, not an edit left unchecked on an earlier visit.
      if (visitInUse) { providerCheck = { phase: "idle", line: "" }; prefilled.done = false; }
    }
    step = gated(to, consented());
    if (step === "consent" && !consented()) shownAt.agree = performance.now();
    navigation++;
    if (step === "try") heardBefore = -1;
    render();
    window.scrollTo({ top: 0, behavior: "auto" });
    $("w-title").focus({ preventScroll: true });
  }

  // ───── Drawing the step ─────
  function render(): void {
    if (!active) return;
    root.dataset.step = step;
    const at = stepPosition(step);
    [...arc.children].forEach((seg, i) => seg.classList.toggle("on", i <= at));
    $("w-count").textContent = stepCount(step);
    const using = step === "provider" && visitInUse ? inUseHost() : null;
    const text = step === "sign-in" ? signInText({
      managed: !!status?.admin.provider, locked: locked(), held: !!status?.admin.held,
      own: ownInUse() ? agent?.service?.host : null, ownPhase: agent?.phase === "ready" || agent?.phase === "error" ? agent.phase : "starting", ownOffered: ownOffer().offered,
    }) : step === "consent" && changes().length ? CONSENT_AGAIN : using ? providerInUse(using) : STEP_TEXT[step];
    $("w-title").textContent = text.title;
    $("w-lead").textContent = text.lead;
    for (const pane of root.querySelectorAll<HTMLElement>(".w-pane")) pane.hidden = pane.dataset.pane !== step;
    back.hidden = !stepBefore(step, ownInUse());
    back.textContent = NAV.back;
    if (saving && step === "done") {
      back.setAttribute("aria-disabled", "true");
      back.setAttribute("aria-describedby", "w-why");
    } else {
      back.removeAttribute("aria-disabled");
      back.removeAttribute("aria-describedby");
    }
    next.className = "btn";
    // The step's quiet choice ("" for none), applied once below.
    let altText = "";
    let label: string = NAV.next;
    let why = "";
    if (step === "hello") { label = NAV.begin; altText = NAV.character; }
    if (step === "consent") ({ label, why, alt: altText } = renderConsent());
    if (step === "sign-in") ({ label, why, alt: altText } = renderSignIn());
    if (step === "provider") { ({ label, why } = renderProvider()); if (visitInUse) altText = PROVIDER_STEP.back; }
    if (step === "checks") label = renderChecks();
    if (step === "try") { renderTry(); altText = NAV.about; }
    if (step === "about") label = aboutNext(about);
    if (step === "done") { renderSummary(); label = START_LABEL; next.className = "start"; }
    // Never hidden on the way to being shown again: hiding the focused button would throw its focus to the page on
    // every status that redraws the step (first-run-2, WCAG 2.4.3).
    if (alt.hidden !== !altText) alt.hidden = !altText;
    if (altText && alt.textContent !== altText) alt.textContent = altText;
    if (saving) why = "Saving…";
    wantLevel(step === "try" && voiceState() === "listening");
    next.textContent = label;
    // Can't be pressed yet: said beside it (and to screen readers through its description), never only greyed.
    if (why) next.setAttribute("aria-disabled", "true"); else next.removeAttribute("aria-disabled");
    if ($("w-why").textContent !== why) $("w-why").textContent = why;
  }

  function renderConsent(): { label: string; why: string; alt: string } {
    const a = status?.admin;
    const service = a?.provider ? `your organisation's model service (${hostOf(a.provider)})` : "GitHub Copilot";
    const points = consentPoints({ service, kept: a ? keptWords(a) : "kept 30 days", locked: !!a && a.error !== null });
    $("w-points").replaceChildren(...points.map(p => { const li = el("li", { textContent: p.text }); li.dataset.icon = p.icon; return li; }));
    // Agreed to an earlier version: what changed since, above the usual points (first-run-4).
    const changed = changes();
    $("w-changes").hidden = !changed.length;
    $("w-changes-h").textContent = CONSENT_AGAIN.changes;
    if (JSON.stringify(changed) !== JSON.stringify([...$("w-changes-list").children].map(li => li.textContent))) {
      $("w-changes-list").replaceChildren(...changed.map(text => el("li", { textContent: text })));
    }
    const note = consented() ? CONSENT_TEXT.agreed : declined ? CONSENT_TEXT.declined : "";
    if ($("w-consent-note").textContent !== note) $("w-consent-note").textContent = note;
    if (consented()) return { label: NAV.next, why: "", alt: "" };
    return { label: CONSENT_TEXT.agree, why: "", alt: declined ? CONSENT_TEXT.quit : CONSENT_TEXT.notNow };
  }

  /** Asks main for the microphone's level, or stops, only when that changes. */
  function wantLevel(on: boolean): void {
    if (levelWanted === on) return;
    levelWanted = on;
    void window.ember.watchLevel(on).catch(() => { levelWanted = null; });
  }
  /** The organisation's own model service answers, or its policy locks Ember down: nothing to sign in to. */
  const managed = () => !!status?.admin.provider || (!!status && status.admin.error !== null);
  /** The organisation's policy can't be used (or changed while Ember ran): nothing connects (first-run-v1). */
  const locked = () => !!status && status.admin.error !== null;
  /** Ember's connection is to the user's own provider (first-run-1): no Copilot sign-in is in use. */
  const ownInUse = () => agent?.service?.kind === "user";
  /** The user's own provider is what Ember uses, as the connection or main's provider state says (first-run-c1-2). */
  const ownInForce = () => ownInUse() || !!ownState?.inForce;
  const inUseHost = () => (ownInUse() ? agent?.service?.host ?? null : ownState?.inForce ? ownState.host : null);

  function renderSignIn(): { label: string; why: string; alt: string } {
    const v = signInView({
      phase: agent?.phase ?? null, reason: agent?.reason, login: agent?.login, signingIn,
      managedProvider: !!status?.admin.provider, locked: !!status && status.admin.error !== null, service: agent?.service,
    });
    const line = $("w-signin-line");
    // A device code on screen is the line while it waits; otherwise the status (or what went wrong) is.
    const detail = signInMessage?.text ?? (agent?.phase === "error" && !signingIn ? agent.detail : v.line);
    if (line.textContent !== detail) line.textContent = detail;
    line.className = `w-status ${signInMessage?.tone ?? (agent?.phase === "error" ? "error" : v.tone)}`;
    $("w-signin-later").hidden = v.primary === "continue" && !v.why;
    // The user's own provider has nothing to sign in to, later or now (first-run-1).
    $("w-signin-later").textContent = ownInUse() ? SKIP_OWN : SKIP_SIGN_IN;
    if (!signingIn) { $("w-code").replaceChildren(); waitLink = null; }
    // A sign-in made elsewhere (the GitHub CLI's): the page main offers, and Check again, which looks for it.
    const open = $("w-open-page");
    open.hidden = !waitLink;
    open.textContent = waitLink ?? "";
    // Ember's own GitHub App signs in here; Check again is for a build that signs in through the GitHub CLI.
    $("w-check-again").hidden = !((v.retry && agent?.signInWith === "github-cli" && !ownInUse()) || waitLink);
    $("w-check-again").textContent = CHECK_AGAIN;
    $("w-signin-more").hidden = open.hidden && $("w-check-again").hidden;
    $("w-signin-later").hidden = $("w-signin-later").hidden || managed();
    // What can be done about it (FE #2, #3): the way on by the failure's reason, and the user's own provider beside
    // Copilot's sign-in wherever it is offered. An entitlement failure never leads with signing in again.
    const offer = ownOffer();
    const failing = agent?.phase === "error" && !signingIn && !managed();
    const fv = failing ? failureView({ reason: agent?.reason, detail: agent?.detail, ownOffered: offer.offered, service: agent?.service?.kind }) : null;
    let extras: FailureAction[] = [];
    signInPrimary = v.primary === "sign-in" ? "sign-in" : "continue";
    if (fv) { signInPrimary = fv.primary; extras = fv.others; }
    // The user's own provider already in use, still connecting: its details, never "Use my own provider" (first-run-1).
    else if (!signingIn && v.skip && ownInUse()) extras = ["provider"];
    else if (!signingIn && v.primary !== "continue" && offer.offered) extras = ["own-provider"];
    else if (!signingIn && v.skip && offer.offered) extras = ["own-provider"];
    // A policy that forbids the user's own provider says so; Copilot's step is then the only way and the choice isn't drawn.
    const help = fv?.help || (!offer.offered && !signingIn && agent?.phase !== "ready" ? offer.why : "");
    const helpEl = $("w-signin-help");
    helpEl.hidden = !help;
    if (helpEl.textContent !== help) helpEl.textContent = help;
    renderActions(extras);
    renderModels();
    const label = signInPrimary === "continue" ? NAV.next : signInPrimary === "sign-in" ? signInLabel(agent?.signInWith) : ACTION_LABEL[signInPrimary];
    return { label, why: v.why, alt: v.cancel ? "Cancel" : v.skip ? NAV.skip : "" };
  }

  /** The user's own provider is offered on first run (and if not, why). */
  function ownOffer(): ReturnType<typeof ownProviderOffer> {
    return ownProviderOffer({
      bridge: !!window.emberProvider, managedProvider: !!status?.admin.provider, locked: !!status && status.admin.error !== null,
      userProviderOff: status?.admin.features.userProvider === false || (!!ownState && !ownState.allowed),
    });
  }

  /** The buttons under the sign-in line: drawn again only when they change, so a focused one keeps the focus. */
  function renderActions(actions: readonly FailureAction[]): void {
    const box = $("w-signin-actions");
    const key = actions.join(",");
    box.hidden = !actions.length;
    if (key === shownActions) return;
    shownActions = key;
    const hadFocus = box.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset.action : undefined;
    box.replaceChildren(...actions.map(a => {
      const b = el("button", { type: "button", className: "btn quiet small", textContent: ACTION_LABEL[a] });
      b.dataset.action = a;
      b.addEventListener("click", () => perform(a));
      return b;
    }));
    if (hadFocus) box.querySelector<HTMLElement>(`[data-action="${hadFocus}"]`)?.focus();
  }

  /** One way on from a connection that needs something. */
  function perform(a: FailureAction): void {
    if (a === "own-provider" || a === "provider") { openProvider(); return; }
    if (a === "retry") { checkAgain(); return; }
    // "Switch account" is the same GitHub sign-in: the browser page lets them choose another account.
    signIn();
  }

  // ───── Models I'll use (FE #4, #5) ─────
  function renderModels(): void {
    const box = $("w-models");
    const a = agent;
    const show = a?.phase === "ready" && !!status;
    box.hidden = !show;
    if (!show || !a) { modelsOpen = false; return; }
    const own = !!a.service;
    // Only the user's own provider has saved model names that stand in for the runtime's; Copilot's unknown model is
    // shown as Copilot's default, never as the models of a provider that isn't in use (FE #4).
    const named = a.service?.kind === "user" ? settings?.provider : undefined;
    const fixed = !!status?.admin.managed.includes("models") || a.service?.kind === "admin";
    const rows = modelRows({ models: a.models, conductor: a.conductorModel ?? named?.conductor ?? null, worker: a.workerModel ?? named?.worker ?? null, own });
    $("w-models-list").replaceChildren(...rows.flatMap(r => [el("dt", { textContent: r.label }), el("dd", { textContent: r.note ? `${r.value} (${r.note})` : r.value })]));
    const note = fixed ? "Your organisation chooses these." : own ? "These are the models you named. I use them for your first request." : "I picked these. You can change them now or later in Settings › Models & connections.";
    if ($("w-models-note").textContent !== note) $("w-models-note").textContent = note;
    const change = $("w-models-change") as HTMLButtonElement;
    // Nothing to choose from: no models listed, or the models are the provider's own fields (not drawn here).
    const editable = !fixed && !own && a.models.length > 0;
    change.hidden = !editable;
    change.setAttribute("aria-expanded", String(modelsOpen && !own));
    $("w-models-edit").hidden = !modelsOpen || !editable;
    if (modelsOpen && editable) fillModelEditor(a);
  }
  /** The editor's lists are rebuilt only when they change (an open drop-down isn't pulled from under the pointer). */
  let editorKey = "";
  function fillModelEditor(a: AgentStatus): void {
    const key = JSON.stringify([a.models, a.conductorModel, a.workerModel]);
    if (key === editorKey) return;
    editorKey = key;
    const choices = taskModelChoices(a.models, a.workerModel);
    const fill = (id: string, list: readonly { id: string; name: string }[], current: string | null) => {
      ($(id) as HTMLSelectElement).replaceChildren(...list.map(m => Object.assign(document.createElement("option"), { value: m.id, textContent: m.name, selected: m.id === current })));
    };
    fill("w-m-conductor", a.models, a.conductorModel);
    fill("w-m-worker", choices.options, a.workerModel);
    $("w-m-worker-label").textContent = choices.label;
    $("w-m-worker-note").textContent = choices.note;
    $("w-m-worker-note").hidden = !choices.note;
  }

  // ───── Your own model provider (FE #2) ─────
  const provField = (id: string) => $(id) as HTMLInputElement;
  const prefilled = { done: false };
  function openProvider(): void {
    checkEpoch++;
    providerCheck = { phase: "idle", line: "" };
    prefilled.done = false;
    go("provider");
    provField("w-p-url").focus();
  }
  function readProviderFields(): { type: ProviderType; baseUrl: string; conductor: string; worker: string; key: string } {
    return {
      type: ($("w-p-type") as unknown as HTMLSelectElement).value as ProviderType, baseUrl: provField("w-p-url").value.trim(),
      conductor: provField("w-p-conductor").value.trim(), worker: provField("w-p-worker").value.trim(), key: provField("w-p-key").value,
    };
  }
  /** Why the fields can't be checked yet, with the field to fix, or null. */
  function providerProblem(f: ReturnType<typeof readProviderFields>): { text: string; field: string } | null {
    if (!f.baseUrl) return { text: PROVIDER_STEP.needAddress, field: "w-p-url" };
    const bad = endpointProblem(f.baseUrl);
    if (bad) return { text: bad, field: "w-p-url" };
    // A model server on this computer often needs no key (first-run-v2): main sends none, and its check says if one is needed.
    if (!f.key.trim() && !ownState?.keySaved && keyNeeded(f.baseUrl)) return { text: PROVIDER_STEP.needKey, field: "w-p-key" };
    if (!f.conductor) return { text: PROVIDER_STEP.needModel, field: "w-p-conductor" };
    if (!MODEL_ID.test(f.conductor) || (f.worker && !MODEL_ID.test(f.worker))) return { text: "A model name has no spaces in it, such as gpt-4.1 or llama3.2:3b.", field: MODEL_ID.test(f.conductor) ? "w-p-worker" : "w-p-conductor" };
    return null;
  }
  /** Saves the fields, the key, the card's yes for exactly this address, then asks the service for its models. */
  const checkProvider = latestOnly<{ epoch: number; result: { ok: true; host: string; models: number | null } | { ok: false; why: string } }>(
    async () => {
      const epoch = checkEpoch;
      const mine = ++checkRun;
      const f = readProviderFields();
      const host = endpointHost(f.baseUrl);
      const api = window.emberProvider;
      if (!api || !host) return { epoch, result: { ok: false, why: PROVIDER_STEP.needAddress } };
      // Back, an edit or another check can come between any two steps. Each step that does something (the card's yes
      // turns the provider on) first looks whether this check was abandoned; one abandoned after the yes was recorded
      // puts the provider away again, unless a newer check has taken over (it owns the provider now).
      const abandoned = () => epoch !== checkEpoch;
      // Nor may it undo a provider the user chose in Home since this check began: that choice owns the provider now.
      const chosen = providerChoice();
      const dropped = async () => {
        if (mine === checkRun) await turnOwnOff(true, chosen);
        return { epoch, result: { ok: false as const, why: "" } };
      };
      const saved = await deps.save({ provider: { type: f.type, baseUrl: f.baseUrl, conductor: f.conductor, worker: f.worker || null } } as SettingsPatch);
      if (!saved) return { epoch, result: { ok: false, why: "I couldn't save these details. The notice at the top says why." } };
      if (abandoned()) return { epoch, result: { ok: false, why: "" } };
      if (f.key.trim()) {
        const k = await api.saveKey(f.key);
        if (!k.ok) return { epoch, result: { ok: false, why: k.why } };
        if (abandoned()) return { epoch, result: { ok: false, why: "" } };
      }
      const agreed = await api.agree(host);
      if (abandoned()) return dropped();
      if (!agreed.ok) return { epoch, result: { ok: false, why: agreed.why } };
      const tested = await api.test();
      if (abandoned()) return dropped();
      return { epoch, result: tested };
    },
    r => {
      // An answer to an older check, or to a step the user has left, says nothing about what they see now.
      if (!active || step !== "provider") return;
      if (!r.ok) { if (providerCheck.phase === "checking") finishCheck(false, "I couldn't check the provider. Try again."); return; }
      if (r.value.epoch !== checkEpoch) return;
      finishCheck(r.value.result.ok, providerCheckLine(r.value.result));
    },
  );
  function finishCheck(ok: boolean, line: string): void {
    providerCheck = { phase: ok ? "ok" : "failed", line };
    // Not verified: nothing stays pointed at a service that didn't answer.
    if (!ok) void turnOwnOff();
    render();
    if (!ok) provField("w-p-key").focus(); else next.focus();
  }
  /**
   * Puts the user's own provider away. `force`: also when the page's copy of the settings doesn't show it on yet (the
   * card's yes may still be on its way). `since`: the provider choice count when the check began; a deliberate choice
   * made after it means this is no longer ours to undo. A write that fails (it says false, or throws) is never passed
   * over: the provider is still on, and a notice with a retry says so.
   */
  async function turnOwnOff(force = false, since?: number): Promise<void> {
    if (!force && !settings?.provider.on) return;
    if (since !== undefined && since !== providerChoice()) return;
    let ok = false;
    try { ok = await deps.save({ provider: { on: false } } as SettingsPatch); } catch { /* counted as failed below */ }
    showOffFailure(!ok);
  }
  /** The notice above first run and Home alike (so it is seen on whichever is up): the provider is still on, with a retry. */
  function showOffFailure(failed: boolean): void {
    const note = $("provider-off");
    note.hidden = !failed;
    if (!failed) return;
    $("provider-off-text").textContent = PROVIDER_STEP.offFailed;
    $("provider-off-retry").textContent = PROVIDER_STEP.offRetry;
  }
  function startCheck(): void {
    const f = readProviderFields();
    const problem = providerProblem(f);
    if (problem) {
      providerCheck = { phase: "invalid", line: problem.text };
      render();
      provField(problem.field).focus();
      return;
    }
    providerCheck = { phase: "checking", line: PROVIDER_STEP.checking };
    render();
    void checkProvider();
  }
  $("provider-off-retry").addEventListener("click", () => {
    // The user's own click: not held back by an earlier choice. The notice stays until the write lands.
    void turnOwnOff(true);
  });
  // A deliberate choice made in Home replaces whatever was true of the old state.
  onProviderChoice(() => showOffFailure(false));
  function renderProvider(): { label: string; why: string } {
    const needs = $("w-p-needs");
    if (!needs.childElementCount) needs.replaceChildren(...PROVIDER_STEP.needs.map(t => el("li", { textContent: t })));
    // The saved details come into the fields once, the first time the step opens: what is typed is never overwritten.
    if (!prefilled.done && settings) {
      prefilled.done = true;
      ($("w-p-type") as unknown as HTMLSelectElement).value = settings.provider.type;
      provField("w-p-url").value = settings.provider.baseUrl;
      provField("w-p-conductor").value = settings.provider.conductor ?? "";
      provField("w-p-worker").value = settings.provider.worker ?? "";
      provField("w-p-key").placeholder = ownState?.keySaved ? "A key is saved. Paste a new one to replace it" : "Paste your key";
    }
    const host = endpointHost(provField("w-p-url").value.trim());
    const consent = host ? providerConsentText(host, visitInUse ? "in-use" : "first-run") : "Once you enter the address, I'll say here exactly what is sent to it.";
    if ($("w-p-consent").textContent !== consent) $("w-p-consent").textContent = consent;
    const result = $("w-p-result");
    // In use as the step opened, and nothing changed since: the connection's own state, and Continue goes on without
    // agreeing or checking again (first-run-c1-2).
    const using = visitInUse && !edited && providerCheck.phase === "idle" ? inUseHost() : null;
    providerGoesOn = !!using || providerCheck.phase === "ok";
    if (using) {
      const v = providerInUseLine({ host: using, phase: ownInUse() ? agent?.phase ?? null : "starting", detail: agent?.detail });
      if (result.textContent !== v.line) result.textContent = v.line;
      result.className = `w-status ${v.tone}`;
      return { label: NAV.next, why: "" };
    }
    if (result.textContent !== providerCheck.line) result.textContent = providerCheck.line;
    result.className = `w-status ${providerCheck.phase === "failed" || providerCheck.phase === "invalid" ? "error" : providerCheck.phase === "ok" ? "ok" : ""}`;
    // No keyring: a key can't be kept, so only a model server on this computer with no key typed can be used (first-run-v2).
    const typed = readProviderFields();
    if (ownState && ownState.keyring === false && !ownState.keySaved && (!!typed.key.trim() || (!!typed.baseUrl && keyNeeded(typed.baseUrl)))) {
      result.textContent = PROVIDER_STEP.noKeyring;
      result.className = "w-status error";
      return { label: PROVIDER_STEP.check, why: PROVIDER_STEP.noKeyring };
    }
    if (providerCheck.phase === "checking") return { label: PROVIDER_STEP.check, why: PROVIDER_STEP.checking };
    if (providerCheck.phase === "ok") {
      // The service answered; Continue waits for Ember to be connected to it, and says what went wrong if it can't.
      if (agent?.phase === "error" && agent.service?.kind === "user") return { label: NAV.next, why: agent.detail };
      return { label: NAV.next, why: agent?.phase === "ready" ? "" : `Connecting to ${host ?? "the provider"}…` };
    }
    return { label: providerCheck.phase === "failed" ? "Check again" : PROVIDER_STEP.check, why: "" };
  }

  /**
   * The checks step's live line. What Check again found is shown under it too, so a sighted user sees it looked again
   * (first-run-r2); a fix's failure is only read out, as its row shows it. Rows drawn anew take a shown result away.
   */
  function checksMsg(text: string, shown = false): void {
    const m = $("w-checks-msg");
    if (m.textContent !== text) m.textContent = text;
    m.className = shown && text ? "hint" : "sr";
  }

  function renderChecks(): string {
    const rows = status?.environment.checks ?? [];
    // Unchanged: left as it is, so a "Copied" and the focus stay where they are.
    const key = JSON.stringify([rows, status?.platform?.fixLabels ?? null, [...fixFailures]]);
    if (key === shownChecks) return checksNext(rows);
    shownChecks = key;
    if ($("w-checks-msg").className === "hint") checksMsg("");
    const head = checksHeadline(rows);
    const h = $("w-checks-head");
    if (h.textContent !== head.text) h.textContent = head.text;
    h.className = `w-status ${head.tone}`;
    const hadFix = (document.activeElement as HTMLElement | null)?.dataset.fix;
    $("w-checks").replaceChildren(...plainChecks(rows).map(c => {
      const li = el("li", { className: "w-check" });
      // The row's mark is the headline's: red only for a row that fails outright.
      li.dataset.tone = c.tone;
      const text = el("div", { className: "w-check-text" });
      text.append(el("b", { textContent: c.title }), el("p", { textContent: c.text }));
      // A fix the user runs themselves: the command, ready to copy (its full advice stays in the details).
      if (c.command) {
        const copy = copyButton(c.command, `Copy the command: ${c.command}`);
        copy.dataset.fix = `copy:${c.id}`;
        const cmd = el("p", { className: "w-cmd" });
        cmd.append(el("code", { textContent: c.command }), copy);
        text.append(cmd);
      }
      // A fix that failed says so here, in the row it belongs to (FE #6): the live line below announces it too.
      const failed = [c.fix, c.alt].map(f => (f ? fixFailures.get(f) : undefined)).find(Boolean);
      if (failed) {
        const why = el("p", { className: "w-check-fail", textContent: failed });
        why.dataset.fail = c.id;
        text.append(why);
      }
      li.append(el("i", { className: "w-sym" }), text);
      for (const fix of [c.fix, c.alt]) {
        if (!fix) continue;
        const label = status?.platform?.fixLabels[fix as keyof NonNullable<Status["platform"]>["fixLabels"]] ?? "Turn on";
        const btn = el("button", { type: "button", className: "btn quiet small", textContent: label });
        btn.dataset.fix = fix;
        btn.setAttribute("aria-label", fixButtonName(label, c.title));
        // A button drawn again while its fix runs (clearing the earlier failure does) stays disabled.
        if (fixPending.has(fix)) btn.setAttribute("aria-disabled", "true");
        btn.addEventListener("click", () => {
          if (btn.getAttribute("aria-disabled") === "true" || fixPending.has(fix)) return;
          fixPending.add(fix);
          btn.setAttribute("aria-disabled", "true");
          if (fixFailures.delete(fix)) { checksMsg(""); shownChecks = ""; render(); }
          window.ember.applyFix(fix as Parameters<typeof window.ember.applyFix>[0]).then(env => {
            fixPending.delete(fix);
            if (status) status = { ...status, environment: env };
            shownChecks = "";
            deps.checksChanged(env);
            render();
          }, err => {
            fixPending.delete(fix);
            const text = fixFailedText(c.title, ipcErrorText(err));
            fixFailures.set(fix, text);
            checksMsg(text);
            // Drawn again with the failure in the row; the retry button keeps (or gets back) the focus.
            shownChecks = "";
            render();
          });
        });
        li.append(btn);
      }
      return li;
    }));
    // A fix button that had focus keeps it when the rows are drawn again; one that went hands it to the heading.
    if (hadFix) ($("w-checks").querySelector<HTMLElement>(`[data-fix="${CSS.escape(hadFix)}"]`) ?? $("w-title")).focus();
    $("w-checks").hidden = !$("w-checks").childElementCount;
    // A fix the user makes outside Ember (a command run, a setting changed by hand): Check again reads the rows anew.
    $("w-checks-again-row").hidden = !rows.some(needsUser);
    $("w-checks-again").textContent = CHECK_AGAIN;
    $("w-checks-later").textContent = checksLater(rows);
    $("w-checks-later").hidden = !checksLater(rows);
    $("w-checks-more").querySelector("summary")!.textContent = CHECKS_DETAIL;
    // Every row, its state as a symbol and words (never a code, never colour alone), and its technical detail.
    $("w-checks-all").replaceChildren(...rows.flatMap(r => {
      const state = el("span", { className: "w-state", textContent: checkState(r.status, holdsBack(r)) });
      state.dataset.tone = r.status;
      const dd = el("dd");
      dd.append(state, el("span", { textContent: r.detail }));
      return [el("dt", { textContent: r.label }), dd];
    }));
    return checksNext(rows);
  }

  $("w-checks-again").addEventListener("click", () => {
    const btn = $("w-checks-again");
    if (btn.getAttribute("aria-disabled") === "true") return;
    btn.setAttribute("aria-disabled", "true");
    checksMsg("Checking…", true);
    const before = status?.environment.checks ?? [];
    window.ember.recheckSetup().then(env => {
      btn.removeAttribute("aria-disabled");
      if (status) status = { ...status, environment: env };
      shownChecks = "";
      deps.checksChanged(env);
      render();
      checksMsg(recheckMessage(before, env.checks), true);
      // The button stays while something still needs the user; otherwise the heading takes the focus.
      if ($("w-checks-again-row").hidden) $("w-title").focus();
    }, err => {
      btn.removeAttribute("aria-disabled");
      checksMsg(ipcErrorText(err), true);
    });
  });

  const voiceState = () => voiceTry({
    wakeWord: !!settings?.wakeWord, voiceConsent: !!settings?.voice.consent, state: voice?.state ?? null,
    allowed: status?.admin.features.voice !== false, muted: !!settings?.voice.muted,
  });
  const signedIn = () => agent?.phase === "ready";

  function renderTry(): void {
    if (heardBefore < 0) void window.ember.conversation().then(c => { heardBefore = c.length; }, () => { heardBefore = 0; });
    const mark = (id: string, done: boolean, text: string) => {
      const li = $(id);
      li.classList.toggle("done", done);
      const p = li.querySelector("p")!;
      if (p.textContent !== text) p.textContent = text;
    };
    // The keys as Ember holds them on this OS, named only once the status says which they are; a shortcut another app
    // holds isn't offered (nothing to rehearse).
    const keys = status?.platform?.shortcuts;
    const chord = (id: "stop" | "ask", at: string) => {
      const k = keys?.[id];
      const held = !!k && !k.taken && !!k.label;
      const box = $(at);
      box.hidden = !held;
      if (held && k && box.dataset.keys !== k.keys.join("+")) {
        box.dataset.keys = k.keys.join("+");
        box.replaceChildren(...k.keys.flatMap((key, i) => [...(i ? ["+"] : []), el("kbd", { textContent: key })]));
      }
      return held;
    };
    const stopHeld = chord("stop", "w-stop-keys");
    $("w-try-stop").hidden = false;
    chord("ask", "w-ask-keys");
    mark("w-try-stop", tried.stop, tried.stop ? TRY_TEXT.stop.done : stopHeld ? TRY_TEXT.stop.ask : TRY_TEXT.stop.fallback);
    const vs = voiceState();
    $("w-try-voice").hidden = vs === "off";
    $("w-voice-later").hidden = vs !== "off";
    $("w-voice-later").textContent = TRY_TEXT.voiceLater;
    mark("w-try-voice", tried.voice, tried.voice ? TRY_TEXT.voice.done : vs === "listening" ? TRY_TEXT.voice.ask : TRY_TEXT.voiceWaiting);
    $("w-meter").classList.toggle("off", vs !== "listening");
    mark("w-try-ask", tried.ask, tried.ask ? TRY_TEXT.ask.done : signedIn() ? TRY_TEXT.ask.ask : askWhy({ locked: locked(), noSignIn: !!status?.admin.provider || ownInUse() }));
    const ask = $("w-ask");
    ask.textContent = TRY_TEXT.ask.open;
    if (signedIn()) ask.removeAttribute("aria-disabled"); else ask.setAttribute("aria-disabled", "true");
  }

  function renderSummary(): void {
    const s = settings;
    const name = deps.cards.querySelector('[aria-checked="true"] b')?.textContent ?? "Cinder";
    const keys = status?.platform?.shortcuts;
    const rows = summaryRows({
      character: name, size: s?.size ?? DEFAULT_SIZE, voice: voiceState(),
      signedIn: serviceSummary({ ready: signedIn(), locked: locked(), managed: !!status?.admin.provider, service: agent?.service, login: agent?.login }),
      keys: keys ? { ask: keys.ask.label, stop: keys.stop.label, settings: keys.settings.label } : null,
      copilot: !agent?.service && !status?.admin.provider && !locked(),
    });
    $("w-summary").replaceChildren(...rows.flatMap(r => [el("dt", { textContent: r.label }), el("dd", { textContent: r.value })]));
    $("w-summary-note").textContent = SUMMARY_NOTE;
  }

  // ───── The buttons ─────
  async function saveStep(write: () => Promise<boolean>, to?: WelcomeStep): Promise<void> {
    const from = navigation;
    saving = true;
    render();
    let ok: boolean;
    try { ok = await write(); }
    catch { ok = false; }
    finally { saving = false; render(); }
    // The user may go back while a save is pending, even returning to this same step.
    if (!active || navigation !== from) return;
    if (ok && to) go(to);
    else if (!ok && step !== "about") window.scrollTo({ top: 0 });
  }

  next.addEventListener("click", () => {
    if (next.getAttribute("aria-disabled") === "true") return;
    if (step === "consent" && !consented()) {
      // Drawn just now where Get started was: a double click's second press agrees to nothing (first-run-c1-1).
      if (!armed(shownAt.agree)) return;
      declined = false;
      // Not saved: the notice at the top says why (review #84), so it is brought into view.
      void saveStep(() => deps.save({ consent: { version: CONSENT_VERSION, at: new Date().toISOString() } }), "sign-in");
      return;
    }
    // Sign in is the step's button only while signing in can help (not with the organisation's own service, nor locked).
    if (step === "sign-in" && signInPrimary !== "continue") { perform(signInPrimary); return; }
    if (step === "provider" && !providerGoesOn) { startCheck(); return; }
    // Start that couldn't be saved says why in the notice at the top (review #84).
    // What was answered is saved, then on (nothing answered, or memory left off: nothing is kept).
    if (step === "about") {
      if (about.ready && about.filled) void saveStep(async () => (await about.submit() ?? 0) > 0 && !about.filled, "done");
      else go("done");
      return;
    }
    if (step === "done") { void saveStep(() => deps.save({ onboarded: true })); return; }
    const to = stepAfter(step);
    if (to) go(to);
  });
  back.addEventListener("click", () => {
    if (back.getAttribute("aria-disabled") === "true") return;
    const to = stepBefore(step, ownInUse());
    if (to) go(to);
  });
  alt.addEventListener("click", () => {
    if (saving) return;
    if (step === "hello") { go("character"); return; }
    if (step === "try") { go("about"); return; }
    if (step === "consent") {
      if (declined) { if (armed(shownAt.quit)) void window.ember.quit(); return; }
      declined = true;
      shownAt.quit = performance.now();
      render();
      // The same button now quits, and Agree would agree: focus goes to the note that says what Not now did, so a
      // second or held Enter does neither (first-run-2, first-run-c1-1). Back, Quit Ember and Agree follow it.
      $("w-consent-note").focus();
      return;
    }
    if (step === "sign-in") {
      if (signingIn) { void window.ember.cancelSignIn(); return; }
      go("checks");
    }
    // The provider in use as its step opened: the one way back to Copilot from here, said on the button (first-run-c1-2).
    if (step === "provider" && visitInUse) { void turnOwnOff(); go("sign-in"); }
  });
  $("w-open-page").addEventListener("click", () => { void window.ember.openSignInPage(); });
  $("w-check-again").addEventListener("click", () => checkAgain());
  function checkAgain(): void {
    if (signInMessage?.text === "Checking…") return;
    const checking = { text: "Checking…", tone: "" };
    signInMessage = checking;
    render();
    const show = (text: string, tone: string) => {
      if (signInMessage !== checking) return;
      signInMessage = { text, tone };
      render();
    };
    window.ember.retrySignIn().then(r => {
      // The user's own provider reconnects too, but a GitHub sign-in found or not says nothing about it: its own
      // status line follows (first-run-1).
      if (r.provider || ownInUse()) { if (signInMessage === checking) { signInMessage = null; render(); } return; }
      show(retryMessage(r, r.found && agent?.phase === "ready"), r.found ? "" : "error");
    }, err => show(ipcErrorText(err), "error"));
  }
  $("w-stop").addEventListener("click", () => { void window.ember.stopEverything(); });
  $("w-ask").addEventListener("click", () => {
    if ($("w-ask").getAttribute("aria-disabled") === "true") return;
    void window.ember.openAsk();
  });

  // ───── Sign-in (GitHub's device flow, main's own) ─────
  function signIn(): void {
    signingIn = true;
    signInMessage = null;
    render();
    // Focus stays on the step's button, now waiting (a second Enter there does nothing), not on Cancel, which a double
    // or held Enter would press at once (first-run-r3). A button under the line that started it is gone: focus comes here.
    next.focus();
    window.ember.signIn().catch(err => {
      signingIn = false;
      signInMessage = { text: ipcErrorText(err), tone: "error" };
      render();
      leaveAlt();
    });
  }
  /** A sign-in ended without success: Cancel became Skip for now, so its focus goes to the title (first-run-r3). */
  function leaveAlt(): void {
    if (step === "sign-in" && (document.activeElement === alt || document.activeElement === document.body)) $("w-title").focus({ preventScroll: true });
  }
  window.ember.onSignInProgress(p => {
    if (!active) return;
    if (p.state === "code") { signingIn = true; showCode(p.userCode ?? "", p.verificationUri ?? ""); return; }
    if (p.state === "waiting") { signingIn = true; waitLink = p.link ?? null; signInMessage = p.message ? { text: p.message, tone: "" } : null; render(); return; }
    signingIn = false;
    waitLink = null;
    $("w-code").replaceChildren();
    signInMessage = p.message ? { text: p.message, tone: p.state === "error" || p.state === "unavailable" ? "error" : "warn" } : null;
    render();
    // Signed in: Continue takes focus, so the next step is one key away.
    if (p.state === "done" && step === "sign-in") next.focus();
    else leaveAlt();
  });
  /** "Code ABCD-1234 [Copy] Enter it at github.com/login/device [Open]" and the wait under it. */
  function showCode(userCode: string, uri: string): void {
    const box = $("w-code");
    const copy = copyButton(userCode, `Copy the code ${userCode}`);
    let where = uri;
    try { const u = new URL(uri); where = `${u.host}${u.pathname}`.replace(/\/$/, ""); } catch { /* shown as given */ }
    const open = el("button", { type: "button", className: "btn quiet small", textContent: "Open" });
    open.setAttribute("aria-label", `Open ${where} in your browser`);
    open.addEventListener("click", () => { void window.ember.openSignInPage(); });
    const code = el("p", { className: "w-code-row" });
    code.append(el("span", { textContent: "Your code" }), el("code", { textContent: userCode }), copy);
    const at = el("p", { className: "w-code-row" });
    at.append(el("span", { textContent: `Enter it at ${where}. Your browser should have opened it.` }), open);
    box.replaceChildren(code, at);
    signInMessage = { text: "", tone: "" };
    render();
  }

  // Any edit makes an earlier check (or a check in flight) say nothing about what is now typed.
  for (const id of ["w-p-type", "w-p-url", "w-p-key", "w-p-conductor", "w-p-worker"]) {
    $(id).addEventListener("input", () => {
      checkEpoch++;
      edited = true;
      if (providerCheck.phase !== "idle") { providerCheck = { phase: "idle", line: "" }; void turnOwnOff(); }
      if (active && step === "provider") render();
    });
  }
  const readOwn = latestOnly<ProviderState>(async () => { const api = window.emberProvider; if (!api) throw new Error("no bridge"); return api.state(); }, r => {
    ownState = r.ok ? r.value : null;
    if (active && (step === "sign-in" || step === "provider")) render();
  });
  // Read only while first run is on screen: a returning user's Home reads it in provider.ts alone.
  window.emberProvider?.onChanged(() => { if (active) void readOwn(); });
  $("w-models-change").addEventListener("click", () => {
    modelsOpen = !modelsOpen;
    editorKey = "";
    render();
    if (modelsOpen) $("w-m-conductor").focus();
  });
  for (const [id, key] of [["w-m-conductor", "conductor"], ["w-m-worker", "worker"]] as const) {
    $(id).addEventListener("change", e => {
      const value = (e.target as HTMLSelectElement).value;
      const current = settings?.models ?? { conductor: null, worker: null };
      void deps.save({ models: { ...current, [key]: value } });
    });
  }

  // ───── What the tries hear ─────
  window.ember.onStopped(() => {
    if (!active || step !== "try" || tried.stop) return;
    tried.stop = true;
    live(TRY_TEXT.stop.done);
    render();
  });
  const bars = [...$("w-meter").children] as HTMLElement[];
  window.ember.onLevel(level => {
    if (!active || step !== "try") return;
    // Lit up to the level (eight steps); none on silence or once the stream ends (null).
    const lit = level === null ? 0 : Math.round((level / LEVEL_STEPS) * bars.length);
    bars.forEach((b, i) => b.classList.toggle("on", i < lit));
  });
  window.ember.onConversation(c => {
    if (!active || step !== "try" || heardBefore < 0 || tried.ask) return;
    if (c.slice(heardBefore).some(e => e.who === "you")) { tried.ask = true; live(TRY_TEXT.ask.done); render(); }
  });
  const onAgent = (a: AgentStatus) => { agent = a; if (active && (step === "sign-in" || step === "provider" || step === "try" || step === "done")) render(); };
  void window.ember.agentStatus().then(onAgent, () => { /* the next status brings it */ });
  window.ember.onAgentStatus(onAgent);
  const onVoice = (v: VoiceStatus) => {
    const was = voice?.state;
    voice = v;
    if (!active || step !== "try") return;
    if (v.state === "active" && was !== "active" && !tried.voice) { tried.voice = true; live(TRY_TEXT.voice.done); }
    render();
  };
  void window.ember.voiceStatus().then(onVoice, () => { /* the next status brings it */ });
  window.ember.onVoiceStatus(onVoice);

  return {
    settings(s: Settings): boolean {
      const was = active;
      settings = s;
      about.refresh(s, memoryManaged());
      if (!s.onboarded && !active) begin();
      else if (s.onboarded && active) finish();
      else if (active) render();
      return was && s.onboarded;
    },
    status(st: Status): void {
      status = st;
      about.refresh(settings, memoryManaged());
      if (active) render();
    },
    toConsent(): void { if (active) go("consent"); },
  };
}

/** A Copy button: "Copied" once it worked, "Couldn't copy" (and the text stays on screen to select) when it didn't. */
function copyButton(text: string, label: string): HTMLButtonElement {
  const copy = el("button", { type: "button", className: "btn quiet small", textContent: "Copy" });
  copy.setAttribute("aria-label", label);
  copy.addEventListener("click", () => {
    window.ember.copyText(text).then(() => { copy.textContent = "Copied"; }, () => { copy.textContent = "Couldn't copy"; });
  });
  return copy;
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}
