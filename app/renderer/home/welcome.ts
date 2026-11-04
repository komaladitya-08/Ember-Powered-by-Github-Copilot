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
import { CONSENT_VERSION } from "../../shared/consent";
import type { Status, VoiceStatus } from "../../shared/ipc";
import { LEVEL_STEPS } from "../../shared/level";
import { keptWords } from "./admin-copy";
import { fixButtonName, fixFailedText, ipcErrorText, retryMessage, signInLabel } from "./copy";
import { mountAboutYou } from "./about-you";
import {
  CHECK_AGAIN, CHECKS_DETAIL, CONSENT_TEXT, checkState, checksNext, NAV, signInText, SKIP_SIGN_IN, START_LABEL, STEP_TEXT, SUMMARY_NOTE, TRY_TEXT, WELCOME_STEPS, checksHeadline, checksLater,
  DEFAULT_SIZE, aboutNext, consentPoints, firstStep, gated, plainChecks, signInView, stepAfter, stepBefore, stepCount, stepPosition, summaryRows, voiceTry, type WelcomeStep,
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
  /** The sign-in step's main button signs in (rather than going on). */
  let signInFirst = false;
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
  // "Tell me about you" (optional): memory's note inline, its answers saved by this step's main button.
  const about = mountAboutYou($("w-about"), { id: "w-ay", save: deps.save, ownSave: false, changed: () => { if (active && step === "about") render(); } });
  const memoryManaged = () => status?.admin.features.memory === false;
  const live = (text: string) => { $("w-try-live").textContent = text; };

  function begin(): void {
    active = true;
    $("w-stage").append(deps.buddy);
    $("w-cards").append(deps.cards);
    deps.cards.setAttribute("aria-labelledby", "w-title");
    step = firstStep(consented());
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
    step = gated(to, consented());
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
    const text = step === "sign-in" ? signInText(managed()) : STEP_TEXT[step];
    $("w-title").textContent = text.title;
    $("w-lead").textContent = text.lead;
    for (const pane of root.querySelectorAll<HTMLElement>(".w-pane")) pane.hidden = pane.dataset.pane !== step;
    back.hidden = !stepBefore(step);
    back.textContent = NAV.back;
    if (saving && step === "done") {
      back.setAttribute("aria-disabled", "true");
      back.setAttribute("aria-describedby", "w-why");
    } else {
      back.removeAttribute("aria-disabled");
      back.removeAttribute("aria-describedby");
    }
    next.className = "btn";
    alt.hidden = true;
    let label: string = NAV.next;
    let why = "";
    if (step === "hello") { label = NAV.begin; alt.hidden = false; alt.textContent = NAV.character; }
    if (step === "consent") ({ label, why } = renderConsent());
    if (step === "sign-in") ({ label, why } = renderSignIn());
    if (step === "checks") label = renderChecks();
    if (step === "try") { renderTry(); alt.hidden = false; alt.textContent = NAV.about; }
    if (step === "about") label = aboutNext(about);
    if (step === "done") { renderSummary(); label = START_LABEL; next.className = "start"; }
    if (saving) why = "Saving…";
    wantLevel(step === "try" && voiceState() === "listening");
    next.textContent = label;
    // Can't be pressed yet: said beside it (and to screen readers through its description), never only greyed.
    if (why) next.setAttribute("aria-disabled", "true"); else next.removeAttribute("aria-disabled");
    if ($("w-why").textContent !== why) $("w-why").textContent = why;
  }

  function renderConsent(): { label: string; why: string } {
    const a = status?.admin;
    const service = a?.provider ? `your organisation's model service (${hostOf(a.provider)})` : "GitHub Copilot";
    const points = consentPoints({ service, kept: a ? keptWords(a) : "kept 30 days", locked: !!a && a.error !== null });
    $("w-points").replaceChildren(...points.map(p => { const li = el("li", { textContent: p.text }); li.dataset.icon = p.icon; return li; }));
    const note = consented() ? CONSENT_TEXT.agreed : declined ? CONSENT_TEXT.declined : "";
    if ($("w-consent-note").textContent !== note) $("w-consent-note").textContent = note;
    if (consented()) return { label: NAV.next, why: "" };
    alt.hidden = false;
    alt.textContent = declined ? CONSENT_TEXT.quit : CONSENT_TEXT.notNow;
    return { label: CONSENT_TEXT.agree, why: "" };
  }

  /** Asks main for the microphone's level, or stops, only when that changes. */
  function wantLevel(on: boolean): void {
    if (levelWanted === on) return;
    levelWanted = on;
    void window.ember.watchLevel(on).catch(() => { levelWanted = null; });
  }
  /** The organisation's own model service answers, or its policy locks Ember down: nothing to sign in to. */
  const managed = () => !!status?.admin.provider || (!!status && status.admin.error !== null);

  function renderSignIn(): { label: string; why: string } {
    const v = signInView({
      phase: agent?.phase ?? null, reason: agent?.reason, login: agent?.login, signingIn,
      managedProvider: !!status?.admin.provider, locked: !!status && status.admin.error !== null,
    });
    const line = $("w-signin-line");
    // A device code on screen is the line while it waits; otherwise the status (or what went wrong) is.
    const detail = signInMessage?.text ?? (agent?.phase === "error" && !signingIn ? agent.detail : v.line);
    if (line.textContent !== detail) line.textContent = detail;
    line.className = `w-status ${signInMessage?.tone ?? (agent?.phase === "error" ? "error" : v.tone)}`;
    $("w-signin-later").hidden = v.primary === "continue" && !v.why;
    $("w-signin-later").textContent = SKIP_SIGN_IN;
    if (v.cancel || v.skip) {
      alt.hidden = false;
      alt.textContent = v.cancel ? "Cancel" : NAV.skip;
    }
    if (!signingIn) { $("w-code").hidden = true; waitLink = null; }
    // A sign-in made elsewhere (the GitHub CLI's): the page main offers, and Check again, which looks for it.
    const open = $("w-open-page");
    open.hidden = !waitLink;
    open.textContent = waitLink ?? "";
    // Ember's own GitHub App signs in here; Check again is for a build that signs in through the GitHub CLI.
    $("w-check-again").hidden = !((v.retry && agent?.signInWith === "github-cli") || waitLink);
    $("w-check-again").textContent = CHECK_AGAIN;
    $("w-signin-more").hidden = open.hidden && $("w-check-again").hidden;
    $("w-signin-later").hidden = $("w-signin-later").hidden || managed();
    signInFirst = v.primary === "sign-in";
    return { label: signInFirst ? signInLabel(agent?.signInWith) : NAV.next, why: v.why };
  }

  function renderChecks(): string {
    const rows = status?.environment.checks ?? [];
    // Unchanged: left as it is, so a "Copied" and the focus stay where they are.
    const key = JSON.stringify([rows, status?.platform?.fixLabels ?? null]);
    if (key === shownChecks) return checksNext(rows);
    shownChecks = key;
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
      li.append(el("i", { className: "w-sym" }), text);
      for (const fix of [c.fix, c.alt]) {
        if (!fix) continue;
        const label = status?.platform?.fixLabels[fix as keyof NonNullable<Status["platform"]>["fixLabels"]] ?? "Turn on";
        const btn = el("button", { type: "button", className: "btn quiet small", textContent: label });
        btn.dataset.fix = fix;
        btn.setAttribute("aria-label", fixButtonName(label, c.title));
        btn.addEventListener("click", () => {
          if (btn.getAttribute("aria-disabled") === "true") return;
          btn.setAttribute("aria-disabled", "true");
          window.ember.applyFix(fix as Parameters<typeof window.ember.applyFix>[0]).then(env => {
            if (status) status = { ...status, environment: env };
            shownChecks = "";
            deps.checksChanged(env);
            render();
          }, err => {
            btn.removeAttribute("aria-disabled");
            $("w-checks-msg").textContent = fixFailedText(c.title, ipcErrorText(err));
          });
        });
        li.append(btn);
      }
      return li;
    }));
    // A fix button that had focus keeps it when the rows are drawn again; one that went hands it to the heading.
    if (hadFix) ($("w-checks").querySelector<HTMLElement>(`[data-fix="${CSS.escape(hadFix)}"]`) ?? $("w-title")).focus();
    $("w-checks").hidden = !$("w-checks").childElementCount;
    $("w-checks-later").textContent = checksLater(rows);
    $("w-checks-later").hidden = !checksLater(rows);
    $("w-checks-more").querySelector("summary")!.textContent = CHECKS_DETAIL;
    // Every row, its state as a symbol and words (never a code, never colour alone), and its technical detail.
    $("w-checks-all").replaceChildren(...rows.flatMap(r => {
      const state = el("span", { className: "w-state", textContent: checkState(r.status) });
      state.dataset.tone = r.status;
      const dd = el("dd");
      dd.append(state, el("span", { textContent: r.detail }));
      return [el("dt", { textContent: r.label }), dd];
    }));
    return checksNext(rows);
  }

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
    mark("w-try-ask", tried.ask, tried.ask ? TRY_TEXT.ask.done : signedIn() ? TRY_TEXT.ask.ask : TRY_TEXT.askWhy);
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
      signedIn: signedIn() ? (status?.admin.provider ? "Your organisation's model service" : agent?.login ? `Signed in as ${agent.login}` : "Connected") : null,
      keys: keys ? { ask: keys.ask.label, stop: keys.stop.label, settings: keys.settings.label } : null,
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
      declined = false;
      // Not saved: the notice at the top says why (review #84), so it is brought into view.
      void saveStep(() => deps.save({ consent: { version: CONSENT_VERSION, at: new Date().toISOString() } }), "sign-in");
      return;
    }
    // Sign in is the step's button only while signing in can help (not with the organisation's own service, nor locked).
    if (step === "sign-in" && signInFirst) { signIn(); return; }
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
    const to = stepBefore(step);
    if (to) go(to);
  });
  alt.addEventListener("click", () => {
    if (saving) return;
    if (step === "hello") { go("character"); return; }
    if (step === "try") { go("about"); return; }
    if (step === "consent") {
      if (declined) { void window.ember.quit(); return; }
      declined = true;
      render();
      return;
    }
    if (step === "sign-in") {
      if (signingIn) { void window.ember.cancelSignIn(); return; }
      go("checks");
    }
  });
  $("w-open-page").addEventListener("click", () => { void window.ember.openSignInPage(); });
  $("w-check-again").addEventListener("click", () => {
    if (signInMessage?.text === "Checking…") return;
    const checking = { text: "Checking…", tone: "" };
    signInMessage = checking;
    render();
    const show = (text: string, tone: string) => {
      if (signInMessage !== checking) return;
      signInMessage = { text, tone };
      render();
    };
    window.ember.retrySignIn().then(r => show(retryMessage(r, r.found && agent?.phase === "ready"), r.found ? "" : "error"),
      err => show(ipcErrorText(err), "error"));
  });
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
    alt.focus();
    window.ember.signIn().catch(err => {
      signingIn = false;
      signInMessage = { text: ipcErrorText(err), tone: "error" };
      render();
    });
  }
  window.ember.onSignInProgress(p => {
    if (!active) return;
    if (p.state === "code") { signingIn = true; showCode(p.userCode ?? "", p.verificationUri ?? ""); return; }
    if (p.state === "waiting") { signingIn = true; waitLink = p.link ?? null; signInMessage = p.message ? { text: p.message, tone: "" } : null; render(); return; }
    signingIn = false;
    waitLink = null;
    $("w-code").hidden = true;
    signInMessage = p.message ? { text: p.message, tone: p.state === "error" || p.state === "unavailable" ? "error" : "warn" } : null;
    render();
    // Signed in: Continue takes focus, so the next step is one key away.
    if (p.state === "done" && step === "sign-in") next.focus();
  });
  /** "Code ABCD-1234 [Copy] Enter it at github.com/login/device [Open]" and the wait under it. */
  function showCode(userCode: string, uri: string): void {
    const box = $("w-code");
    box.hidden = false;
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
  const onAgent = (a: AgentStatus) => { agent = a; if (active && (step === "sign-in" || step === "try" || step === "done")) render(); };
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
