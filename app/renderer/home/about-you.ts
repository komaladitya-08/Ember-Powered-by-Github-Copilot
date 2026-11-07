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
import { ABOUT_YOU, MEMORY_CONSENT_TEXT, aboutYouSaved, introFromForm } from "./copy";

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
}

export interface AboutYou {
  /** New settings, and whether the organisation turned memory off. */
  refresh(s: Settings | null, managed: boolean): void;
  /** Memory is on but its saved memory can't be opened now: why, in Memory's own words (null while it can). */
  owner(why: string | null): void;
  /** Memory is on with its consent, so answers can be kept. */
  readonly ready: boolean;
  /** Any question is answered. */
  readonly filled: boolean;
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

  const text = (key: "name" | "work" | "apps" | "hours", label: string, max: number) => {
    const row = el("div", { className: "field-row about-field" });
    const input = el("input", { id: id(key), type: "text", maxLength: max, spellcheck: false, autocomplete: "off" });
    input.addEventListener("input", () => o.changed?.());
    row.append(el("label", { htmlFor: input.id, textContent: label }), input);
    return { row, input };
  };
  const choice = (key: "length" | "spoken", label: string, options: Record<string, string>) => {
    const row = el("label", { className: "choice about-field" });
    const select = el("select", { id: id(key) });
    select.append(...Object.entries(options).map(([value, words]) => el("option", { value, textContent: words })));
    select.addEventListener("change", () => o.changed?.());
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
  const voice = el("p", { className: "hint", textContent: o.askConsent ? `${ABOUT_YOU.lead} ${ABOUT_YOU.voice}` : ABOUT_YOU.voice });
  host.replaceChildren(group, status, voice);

  const answers = () => introFromForm({
    name: name.input.value, work: work.input.value, apps: apps.input.value,
    length: length.select.value, spoken: spoken.select.value, hours: hours.input.value,
  });

  async function submit(): Promise<number | null> {
    if (saving) return null;
    if (!ready()) { status.textContent = aboutYouSaved(null); return null; }
    const a = answers();
    if (!Object.keys(a).length) { status.textContent = aboutYouSaved(0); return 0; }
    const controls = [name.input, work.input, apps.input, hours.input, length.select, spoken.select];
    const submitted = controls.map(f => f.value);
    saving = true;
    save?.setAttribute("aria-disabled", "true");
    status.textContent = "Saving…";
    let kept: number | null;
    try { kept = await window.ember.introduceMe(a); }
    catch { kept = null; }
    finally { saving = false; save?.removeAttribute("aria-disabled"); }
    const count = Object.keys(a).length;
    status.textContent = !kept ? "Couldn't save your answers. Try again."
      : kept < count ? `Saved ${kept} of ${count} answers. Your answers are still here to review.` : aboutYouSaved(kept);
    if (kept === count) controls.forEach((f, i) => { if (f.value === submitted[i]) f.value = ""; });
    o.changed?.();
    return kept;
  }

  function draw(): void {
    const keeps = ready();
    off.hidden = on() || managed;
    managedLine.hidden = !managed;
    pausedLine.textContent = paused ?? "";
    pausedLine.hidden = !on() || !paused;
    for (const f of [...fields, saveRow]) f.hidden = !keeps;
    voice.hidden = managed;
  }
  draw();

  return {
    refresh(s, m) { settings = s; managed = m; draw(); o.changed?.(); },
    owner(why) { if (why === paused) return; paused = why; draw(); o.changed?.(); },
    get ready() { return ready(); },
    get filled() { return Object.keys(answers()).length > 0; },
    submit,
  };
}
