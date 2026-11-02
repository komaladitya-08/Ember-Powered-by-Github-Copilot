/**
 * First run in the settings window (`#welcome`): Ember introduces itself, the character is chosen, the consent is
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
import { SHORTCUTS } from "../../shared/shortcuts";
import { keptWords } from "./admin-copy";
import { fixButtonName, fixFailedText, ipcErrorText, signInLabel } from "./copy";
import {
  CHECKS_DETAIL, CONSENT_TEXT, checkState, checksNext, NAV, SKIP_SIGN_IN, START_LABEL, STEP_TEXT, SUMMARY_NOTE, TRY_TEXT, WELCOME_STEPS, checksHeadline, checksLater,
  consentPoints, firstStep, gated, plainChecks, signInView, stepAfter, stepBefore, stepCount, summaryRows, voiceTry, type WelcomeStep,
} from "./welcome-copy";

/** What the settings window lends the welcome. */
export interface WelcomeDeps {
  /** Saves a change; false when it couldn't be saved (the window's notice says why). */
  save(patch: SettingsPatch): Promise<boolean>;
  /** The character on its tile (the hero's), shown at the head of every step. */
  buddy: HTMLElement;
  /** The character cards (a radio group): the second step's choice. */
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
  let declined = false;
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
    void window.ember.watchLevel(false).catch(() => { /* the window is going: nothing to stop */ });
    const [bp, bn] = home.buddy; bp?.insertBefore(deps.buddy, bn);
    const [cp, cn] = home.cards; cp?.insertBefore(deps.cards, cn);
    if (cardsLabel) deps.cards.setAttribute("aria-labelledby", cardsLabel);
    root.hidden = true;
  }

  /** Moves to `to` (held at the consent step without agreement), focusing its title so the step is read from the top. */
  function go(to: WelcomeStep): void {
    // The step comes in from the side it lies on (motion only; focus moves at once, as the motion starts).
    root.dataset.dir = WELCOME_STEPS.indexOf(to) < WELCOME_STEPS.indexOf(step) ? "back" : "next";
    step = gated(to, consented());
    if (step === "try") heardBefore = -1;
    render();
    window.scrollTo({ top: 0, behavior: "auto" });
    $("w-title").focus({ preventScroll: true });
  }

  // ───── Drawing the step ─────
  function render(): void {
    if (!active) return;
    root.dataset.step = step;
    const at = WELCOME_STEPS.indexOf(step);
    [...arc.children].forEach((seg, i) => seg.classList.toggle("on", i <= at));
    $("w-count").textContent = stepCount(step);
    $("w-title").textContent = STEP_TEXT[step].title;
    $("w-lead").textContent = STEP_TEXT[step].lead;
    for (const pane of root.querySelectorAll<HTMLElement>(".w-pane")) pane.hidden = pane.dataset.pane !== step;
    back.hidden = !stepBefore(step);
    back.textContent = NAV.back;
    next.className = "btn";
    alt.hidden = true;
    let label: string = NAV.next;
    let why = "";
    if (step === "hello") label = NAV.begin;
    if (step === "consent") ({ label, why } = renderConsent());
    if (step === "sign-in") ({ label, why } = renderSignIn());
    if (step === "checks") label = renderChecks();
    if (step === "try") renderTry();
    if (step === "done") { renderSummary(); label = START_LABEL; next.className = "start"; }
    void window.ember.watchLevel(step === "try" && voiceState() === "listening").catch(() => { /* no meter: the words still say it */ });
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

  function renderSignIn(): { label: string; why: string } {
    const v = signInView({ phase: agent?.phase ?? null, login: agent?.login, signingIn, managedProvider: !!status?.admin.provider });
    const line = $("w-signin-line");
    // A device code on screen is the line while it waits; otherwise the status (or what went wrong) is.
    const detail = agent?.phase === "error" && !signingIn ? agent.detail : v.line;
    if (!signingIn || !line.textContent) { line.textContent = detail; line.className = `w-status ${agent?.phase === "error" ? "error" : v.tone}`; }
    $("w-signin-later").hidden = v.primary === "continue" && !v.why;
    $("w-signin-later").textContent = SKIP_SIGN_IN;
    if (v.cancel || v.skip) {
      alt.hidden = false;
      alt.textContent = v.cancel ? "Cancel" : NAV.skip;
    }
    if (!signingIn) $("w-code").hidden = true;
    return { label: v.primary === "sign-in" ? signInLabel(agent?.signInWith) : NAV.next, why: v.why };
  }

  function renderChecks(): string {
    const rows = status?.environment.checks ?? [];
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
        const copy = el("button", { type: "button", className: "btn quiet small", textContent: "Copy" });
        copy.dataset.fix = `copy:${c.id}`;
        copy.setAttribute("aria-label", `Copy the command: ${c.command}`);
        copy.addEventListener("click", () => { void navigator.clipboard.writeText(c.command ?? "").then(() => { copy.textContent = "Copied"; }); });
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

  const voiceState = () => voiceTry({ wakeWord: !!settings?.wakeWord, voiceConsent: !!settings?.voice.consent, state: voice?.state ?? null });
  const signedIn = () => agent?.phase === "ready";

  function renderTry(): void {
    if (heardBefore < 0) void window.ember.conversation().then(c => { heardBefore = c.length; }, () => { heardBefore = 0; });
    const mark = (id: string, done: boolean, text: string) => {
      const li = $(id);
      li.classList.toggle("done", done);
      const p = li.querySelector("p")!;
      if (p.textContent !== text) p.textContent = text;
    };
    // The keys as Ember holds them on this OS; a shortcut another app holds isn't offered (nothing to rehearse).
    const keys = status?.platform?.shortcuts;
    const chord = (id: "stop" | "ask", at: string) => {
      const k = keys?.[id] ?? SHORTCUTS.linux[id];
      const held = !keys?.[id]?.taken && !!k.label;
      const box = $(at);
      box.hidden = !held;
      if (held && box.dataset.keys !== k.keys.join("+")) {
        box.dataset.keys = k.keys.join("+");
        box.replaceChildren(...k.keys.flatMap((key, i) => [...(i ? ["+"] : []), el("kbd", { textContent: key })]));
      }
      return held;
    };
    $("w-try-stop").hidden = !chord("stop", "w-stop-keys");
    chord("ask", "w-ask-keys");
    mark("w-try-stop", tried.stop, tried.stop ? TRY_TEXT.stop.done : TRY_TEXT.stop.ask);
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
      character: name, size: s?.size ?? 60, voice: voiceState(),
      signedIn: signedIn() ? (status?.admin.provider ? "Your organisation's model service" : agent?.login ? `Signed in as ${agent.login}` : "Connected") : null,
      keys: { ask: keys?.ask.label ?? "Ctrl+Alt+Space", stop: keys?.stop.label ?? "Ctrl+Alt+X", settings: keys?.settings.label ?? "Ctrl+Alt+E" },
    });
    $("w-summary").replaceChildren(...rows.flatMap(r => [el("dt", { textContent: r.label }), el("dd", { textContent: r.value })]));
    $("w-summary-note").textContent = SUMMARY_NOTE;
  }

  // ───── The buttons ─────
  next.addEventListener("click", () => {
    if (next.getAttribute("aria-disabled") === "true") return;
    if (step === "consent" && !consented()) {
      declined = false;
      void deps.save({ consent: { version: CONSENT_VERSION, at: new Date().toISOString() } }).then(ok => { if (ok) go("sign-in"); });
      return;
    }
    if (step === "sign-in" && !signedIn()) { signIn(); return; }
    // Start that couldn't be saved says why in the notice at the top (review #84).
    if (step === "done") { void deps.save({ onboarded: true }).then(ok => { if (!ok) window.scrollTo({ top: 0 }); }); return; }
    const to = stepAfter(step);
    if (to) go(to);
  });
  back.addEventListener("click", () => { const to = stepBefore(step); if (to) go(to); });
  alt.addEventListener("click", () => {
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
  $("w-ask").addEventListener("click", () => {
    if ($("w-ask").getAttribute("aria-disabled") === "true") return;
    void window.ember.openAsk();
  });

  // ───── Sign-in (GitHub's device flow, main's own) ─────
  function signIn(): void {
    signingIn = true;
    render();
    alt.focus();
    window.ember.signIn().catch(err => {
      signingIn = false;
      $("w-signin-line").textContent = ipcErrorText(err);
      $("w-signin-line").className = "w-status error";
      render();
    });
  }
  window.ember.onSignInProgress(p => {
    if (!active) return;
    if (p.state === "code") { showCode(p.userCode ?? "", p.verificationUri ?? ""); return; }
    if (p.state === "waiting") { signingIn = true; $("w-signin-line").textContent = p.message ?? ""; render(); return; }
    signingIn = false;
    $("w-code").hidden = true;
    $("w-signin-line").textContent = p.state === "error" ? p.message ?? "" : "";
    $("w-signin-line").className = `w-status ${p.state === "error" ? "error" : ""}`;
    render();
    // Signed in: Continue takes focus, so the next step is one key away.
    if (p.state === "done" && step === "sign-in") next.focus();
  });
  /** "Code ABCD-1234 [Copy] Enter it at github.com/login/device [Open]" and the wait under it. */
  function showCode(userCode: string, uri: string): void {
    const box = $("w-code");
    box.hidden = false;
    const copy = el("button", { type: "button", className: "btn quiet small", textContent: "Copy" });
    copy.setAttribute("aria-label", `Copy the code ${userCode}`);
    copy.addEventListener("click", () => { void navigator.clipboard.writeText(userCode).then(() => { copy.textContent = "Copied"; }); });
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
    $("w-signin-line").textContent = "";
  }

  // ───── What the tries hear ─────
  window.ember.onStopped(source => {
    if (!active || step !== "try" || source !== "hotkey" || tried.stop) return;
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
      if (!s.onboarded && !active) begin();
      else if (s.onboarded && active) finish();
      else if (active) render();
      return was && s.onboarded;
    },
    status(st: Status): void {
      status = st;
      if (active) render();
    },
    toConsent(): void { if (active) go("consent"); },
  };
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}
