/**
 * "Tell Ember about you" (docs/MEMORY.md "Getting to know you"): a few short questions, each one optional, in Settings ›
 * Memory and as first run's optional step. The answers go to main (IPC memory:introduce), which checks them whole and
 * keeps them as things the user told Ember, only while memory is on with its own consent. While it isn't, the form
 * offers memory's note first, which needs an explicit yes (FEATURE_CONSENT_VERSION.memory); the organisation's
 * features.memory off hides the questions and says so. Memory that is on but can't be opened (Ember connecting, a model
 * provider in force: memory-2) hides them too, and says why (`owner`), so Save never fails with "Try again". The words
 * are in copy.ts (ABOUT_YOU), pinned by tests.
 */

import type { Settings, SettingsPatch } from "../../main/settings";
import { FEATURE_CONSENT_VERSION } from "../../shared/consent";
import { speakSettings } from "../../shared/speech";
import type { IntroField, IntroResult } from "../../main/memory/intro";
import { ABOUT_YOU, MEMORY_CONSENT_TEXT, aboutYouHint, aboutYouNotKept, aboutYouOutcome, aboutYouSaved, aboutYouSpoken, introFromForm } from "./copy";

export interface AboutYouOptions {
  /** Prefix for the element ids ("ay" in Settings, "w-ay" in first run). */
  id: string;
  save(patch: SettingsPatch): Promise<boolean>;
  /** Its own Save button (Settings); first run saves with its Next instead. */
  ownSave: boolean;
  /** Memory's note inline (first run); otherwise a button that opens the memory switch's note (`askConsent`). */
  askConsent?: () => void;
  /** The answers or the memory state changed (first run's Next label follows). */
  changed?: () => void;
  /**
   * Ember can tell the user's voice from its speakers here, so the spoken "get to know me" can keep answers and is
   * offered (memory-r9-6). Asked at every draw; absent: not offered.
   */
  spokenVersion?: () => boolean;
}

export interface AboutYou {
  /** New settings, and whether the organisation turned memory off. */
  refresh(s: Settings | null, managed: boolean): void;
  /**
   * Saved memory can't be opened now: why, in Memory's own words (null while it can). Settings gives it while memory is
   * on; first run also while a model service keeps memory paused before it is turned on (memory-c1-2).
   */
  owner(why: string | null): void;
  /** Memory is on with its consent, so answers can be kept. */
  readonly ready: boolean;
  /** Memory is paused (`owner`): no answers can be kept, and nothing is asked. */
  readonly paused: boolean;
  /** Any question is answered with something not yet refused (an answer memory didn't keep, unchanged, isn't). */
  readonly filled: boolean;
  /** An answer memory didn't keep (a secret) is still in its field, unchanged and marked (memory-r11-2). */
  readonly refused: boolean;
  /** Sends the answers; how many were kept (null: not kept). */
  submit(): Promise<number | null>;
}

// (Props typed loosely: Partial<HTMLInputElement> makes a union too complex for tsc.)
function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, string | number | boolean> = {}): HTMLElementTagNameMap[K] {
  return Object.assign(document.createElement(tag), props);
}

export function mountAboutYou(host: HTMLElement, o: AboutYouOptions): AboutYou {
  const id = (s: string) => `${o.id}-${s}`;
  let settings: Settings | null = null;
  let managed = false;
  let saving = false;
  let paused: string | null = null;
  const on = () => !managed && !!settings?.memory.on && (settings?.memory.consent.version ?? 0) >= FEATURE_CONSENT_VERSION.memory;
  const ready = () => on() && !paused;

  const group = el("div", { className: "group about-you" });
  group.setAttribute("role", "group");
  group.setAttribute("aria-label", ABOUT_YOU.title);

  // Memory off: its note (first run), or a line and a button to the switch's note (Settings).
  const off = el("div", { className: "about-off" });
  if (o.askConsent) {
    const p = el("p", { className: "row-note", textContent: ABOUT_YOU.memoryOff });
    const turnOn = el("button", { type: "button", className: "btn quiet small", textContent: "Turn on memory…" });
    turnOn.addEventListener("click", () => o.askConsent?.());
    off.append(p, turnOn);
  } else {
    off.className = "consent";
    off.setAttribute("role", "group");
    off.setAttribute("aria-label", "Before Ember remembers");
    const note = el("p", { id: id("consent-text"), textContent: MEMORY_CONSENT_TEXT });
    const yes = el("button", { type: "button", className: "btn quiet", id: id("yes"), textContent: "I agree, remember" });
    yes.setAttribute("aria-describedby", note.id);
    yes.addEventListener("click", () => {
      void o.save({ memory: { ...(settings?.memory ?? { questions: true, askedAt: null }), on: true, consent: { version: FEATURE_CONSENT_VERSION.memory, at: new Date().toISOString() } } })
        .then(ok => { if (ok) (document.getElementById(id("name")) as HTMLInputElement | null)?.focus(); });
    });
    const actions = el("div", { className: "agent-actions" });
    actions.append(yes);
    off.append(note, actions);
  }
  const managedLine = el("p", { className: "row-note", textContent: ABOUT_YOU.managed });
  const pausedLine = el("p", { className: "row-note about-paused" });

  /** The answers memory didn't keep, as they were sent: unchanged, they are marked and not sent again (memory-r11-2). */
  const refusedAs = new Map<IntroField, string>();
  const unmark = (key: IntroField, control: HTMLInputElement | HTMLSelectElement) => {
    if (refusedAs.has(key) && refusedAs.get(key) !== control.value) { refusedAs.delete(key); control.removeAttribute("aria-invalid"); control.removeAttribute("aria-describedby"); }
  };
  const text = (key: "name" | "work" | "apps" | "hours", label: string, max: number) => {
    const row = el("div", { className: "field-row about-field" });
    const input = el("input", { id: id(key), type: "text", maxLength: max, spellcheck: false, autocomplete: "off" });
    input.addEventListener("input", () => { unmark(key, input); o.changed?.(); });
    row.append(el("label", { htmlFor: input.id, textContent: label }), input);
    return { row, input };
  };
  const choice = (key: "length" | "spoken", label: string, options: Record<string, string>) => {
    const row = el("label", { className: "choice about-field" });
    const select = el("select", { id: id(key) });
    select.append(...Object.entries(options).map(([value, words]) => el("option", { value, textContent: words })));
    select.addEventListener("change", () => { unmark(key, select); o.changed?.(); });
    row.append(el("span", { textContent: label }), select);
    return { row, select };
  };
  const name = text("name", ABOUT_YOU.name, 80);
  const work = text("work", ABOUT_YOU.work, 240);
  const apps = text("apps", ABOUT_YOU.apps, 240);
  const length = choice("length", ABOUT_YOU.length, ABOUT_YOU.lengthChoices);
  const spoken = choice("spoken", ABOUT_YOU.spoken, ABOUT_YOU.spokenChoices);
  const hours = text("hours", ABOUT_YOU.hours, 120);
  const fields = [name.row, work.row, apps.row, length.row, spoken.row, hours.row];

  const status = el("p", { className: "hint about-msg", id: id("msg") });
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const saveRow = el("div", { className: "agent-actions about-field" });
  const save = o.ownSave ? el("button", { type: "button", className: "btn", textContent: ABOUT_YOU.save }) : null;
  if (save) {
    save.setAttribute("aria-describedby", status.id);
    save.addEventListener("click", () => { void submit(); });
    saveRow.append(save);
  }
  group.append(off, managedLine, pausedLine, ...fields, saveRow);
  // Settings says what the card is for under it (first run's step says it in its lead).
  const voice = el("p", { className: "hint" });
  host.replaceChildren(group, status, voice);

  const all = () => introFromForm({
    name: name.input.value, work: work.input.value, apps: apps.input.value,
    length: length.select.value, spoken: spoken.select.value, hours: hours.input.value,
  });
  const controls: Record<IntroField, HTMLInputElement | HTMLSelectElement> = {
    name: name.input, work: work.input, apps: apps.input, hours: hours.input, length: length.select, spoken: spoken.select,
  };
  /** The answers to send: all but those memory didn't keep and that are unchanged since. */
  const answers = () => Object.fromEntries(Object.entries(all()).filter(([k]) => !refusedAs.has(k as IntroField))) as ReturnType<typeof all>;

  async function submit(): Promise<number | null> {
    if (saving) return null;
    if (!ready()) { status.textContent = aboutYouSaved(null); return null; }
    const a = answers();
    // Only answers memory didn't keep are left: say so again, never "Nothing to save yet".
    if (!Object.keys(a).length) { status.textContent = refusedAs.size ? aboutYouNotKept(0, [...refusedAs.keys()]) : aboutYouSaved(0); return 0; }
    const sent = Object.keys(a) as IntroField[];
    const submitted = new Map(sent.map(k => [k, controls[k].value]));
    saving = true;
    save?.setAttribute("aria-disabled", "true");
    status.textContent = "Saving…";
    let result: IntroResult | null;
    try { result = await window.ember.introduceMe(a); }
    catch { result = null; }
    finally { saving = false; save?.removeAttribute("aria-disabled"); }
    const kept = result?.kept ?? null;
    // Which answers memory didn't keep (a secret, refused whole): never "Try again", which can't work (memory-r11-2).
    const notKept = (result?.notKept ?? []).filter(k => sent.includes(k));
    // Spoken replies is Ember's real speaking choice, not only a remembered preference (memory-5).
    const spokenKept = a.spoken !== undefined && !notKept.includes("spoken");
    const spokenSet = spokenKept && kept ? await o.save(speakSettings(a.spoken ? "always" : "never")).catch(() => false) : false;
    status.textContent = aboutYouOutcome(result, sent) + (spokenSet && a.spoken !== undefined ? ` ${aboutYouSpoken(a.spoken)}` : "");
    // Memory unread: nothing was kept, so every answer stays as typed (r11-memory-x11-4).
    if (result && !result.unreadable) {
      // What was kept leaves the form; what wasn't stays, marked, until it is changed or cleared.
      for (const k of sent) {
        const control = controls[k];
        if (control.value !== submitted.get(k)) continue;
        if (notKept.includes(k)) {
          refusedAs.set(k, control.value);
          control.setAttribute("aria-invalid", "true");
          control.setAttribute("aria-describedby", status.id);
        } else control.value = "";
      }
      if (notKept.length) controls[notKept[0]!].focus();
    }
    o.changed?.();
    return kept;
  }

  function draw(): void {
    const keeps = ready();
    // Paused (a model service in force): its reason, never a note to agree to or answers that couldn't be kept.
    off.hidden = on() || managed || !!paused;
    managedLine.hidden = !managed;
    pausedLine.textContent = paused ?? "";
    pausedLine.hidden = managed || !paused;
    for (const f of [...fields, saveRow]) f.hidden = !keeps;
    // ("Get to know me" can't keep anything either while memory is paused, nor where Ember can't check the voice.)
    voice.textContent = aboutYouHint(!!o.askConsent, o.spokenVersion?.() === true);
    voice.hidden = managed || !!paused || !voice.textContent;
  }
  draw();

  return {
    refresh(s, m) { settings = s; managed = m; draw(); o.changed?.(); },
    owner(why) { if (why === paused) return; paused = why; draw(); o.changed?.(); },
    get ready() { return ready(); },
    get paused() { return !managed && !!paused; },
    get filled() { return Object.keys(answers()).length > 0; },
    get refused() { return refusedAs.size > 0; },
    submit,
  };
}
