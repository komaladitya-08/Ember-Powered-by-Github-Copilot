/** Local natural-voice selection: choosing while off never enables it, and a live switch needs an explicit Use action. */
import type { Settings, SettingsPatch } from "../../main/settings";
import type { NaturalVoiceStatus } from "../../shared/ipc";
import { naturalVoiceView } from "./copy";
import { NATURAL_CHOICES, naturalModelHint, naturalUseLabel, type NaturalModel } from "./natural-copy";

export function mountNaturalVoice(deps: { save(patch: SettingsPatch): Promise<boolean>; live(text: string): void; managed(): boolean }) {
  const toggle = document.querySelector<HTMLInputElement>("#natural")!;
  const select = document.querySelector<HTMLSelectElement>("#natural-model")!;
  const use = document.querySelector<HTMLButtonElement>("#natural-use")!;
  const hint = document.querySelector<HTMLElement>("#natural-model-hint")!;
  const choiceStatus = document.querySelector<HTMLElement>("#natural-choice-status")!;
  const text = document.querySelector<HTMLElement>("#natural-text")!;
  const retry = document.querySelector<HTMLButtonElement>("#natural-retry")!;
  let settings: Settings | null = null;
  let status: NaturalVoiceStatus | undefined;
  let draft: NaturalModel = "kokoro";
  let busy = false;
  let available: readonly NaturalModel[] = ["kokoro", "kitten"];
  let failure = "";
  let said = "";
  function draw(): void {
    const on = settings?.voice.natural ?? false;
    const current = settings?.voice.naturalModel ?? "kokoro";
    const changed = draft !== current;
    const view = naturalVoiceView(on ? status : undefined, naturalModelHint(current));
    toggle.checked = on;
    toggle.disabled = busy || deps.managed() || (!on && !available.includes(draft));
    select.disabled = busy || deps.managed() || !available.length;
    for (const option of select.options) option.disabled = !available.includes(option.value as NaturalModel);
    select.value = draft;
    hint.textContent = available.includes(draft) ? naturalModelHint(draft) : `${NATURAL_CHOICES[draft].name} isn't available on this computer. Choose an available voice.`;
    choiceStatus.textContent = busy ? "Saving voice choice…" : failure || (changed ? `Not saved. Current choice: ${NATURAL_CHOICES[current].name}.` : "");
    use.hidden = !changed;
    use.disabled = busy || deps.managed() || !available.includes(draft);
    use.textContent = naturalUseLabel(draft, on);
    const name = NATURAL_CHOICES[current].name;
    const supported = available.includes(current);
    const named = view.text.startsWith(name + ":") ? view.text : `${name}: ${view.text}`;
    text.textContent = !on ? "Off. Choose a voice, then turn on Use a more natural voice to download and use it."
      : !supported ? `${name} isn't available on this computer. Ember uses its usual voice (Piper when available). Turn this off or choose an available voice.`
      : status?.state === "off" ? `${name} isn't active. Ember uses its usual voice (Piper when available). You can turn this off or choose another available voice.`
      : !status ? `${name}: Waiting for the voice status. Ember uses its usual voice until this voice is ready.` : named;
    const hadRetry = document.activeElement === retry;
    retry.hidden = !on || !supported || !view.retry;
    retry.disabled = busy || deps.managed() || !supported;
    if (hadRetry && retry.hidden) toggle.focus();
    const state = on ? `${current}:${status?.state ?? ""}:${supported}` : "";
    if (state && state !== said && (status?.state !== "downloading" || !supported)) deps.live(text.textContent);
    said = state;
  }
  async function save(on: boolean): Promise<void> {
    if (!settings || busy || deps.managed() || (on && !available.includes(draft))) { draw(); return; }
    const from = document.activeElement;
    busy = true;
    failure = "";
    draw();
    try {
      const ok = await deps.save({ voice: { ...settings.voice, natural: on, naturalModel: draft } });
      if (!ok) failure = "Couldn't save the voice choice. Your current voice is kept.";
    } catch { failure = "Couldn't save the voice choice. Your current voice is kept."; }
    finally {
      busy = false;
      draw();
      if ((document.activeElement === document.body || document.activeElement === from) && (from === use || from === toggle)) {
        const target = from === use ? use.hidden ? select : use : toggle;
        if (!target.disabled && target.getClientRects().length) target.focus();
        else document.querySelector<HTMLSelectElement>("#speak")?.focus();
      }
    }
  }
  select.addEventListener("change", () => {
    if (select.value !== "kokoro" && select.value !== "kitten") return;
    draft = select.value;
    failure = "";
    draw();
  });
  use.addEventListener("click", () => void save(settings?.voice.natural ?? false));
  toggle.addEventListener("change", () => void save(toggle.checked));
  retry.addEventListener("click", () => { if (!retry.disabled) void window.ember.retryNaturalVoice(); });
  return {
    settings(next: Settings): void {
      if (!settings || draft === settings.voice.naturalModel) draft = next.voice.naturalModel;
      settings = next;
      draw();
    },
    status(next: NaturalVoiceStatus | undefined, models?: readonly NaturalModel[]): void {
      if (models) available = models;
      status = next;
      draw();
    },
  };
}
