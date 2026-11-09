/** Voice choice keeps Kitten available as the default; an optional Kokoro download requires an explicit Use action. */
import type { Settings, SettingsPatch } from "../../main/settings";
import type { NaturalVoiceStatus } from "../../shared/ipc";
import { naturalVoiceView } from "./copy";
import { effectiveVoiceModel, NATURAL_CHOICES, naturalModelHint, naturalUseLabel, type NaturalModel } from "./natural-copy";

export function mountNaturalVoice(deps: { save(patch: SettingsPatch): Promise<boolean>; live(text: string): void; managed(): boolean }) {
  const select = document.querySelector<HTMLSelectElement>("#natural-model")!;
  const use = document.querySelector<HTMLButtonElement>("#natural-use")!;
  const hint = document.querySelector<HTMLElement>("#natural-model-hint")!;
  const choiceStatus = document.querySelector<HTMLElement>("#natural-choice-status")!;
  const text = document.querySelector<HTMLElement>("#natural-text")!;
  const retry = document.querySelector<HTMLButtonElement>("#natural-retry")!;
  const downloadRow = document.querySelector<HTMLElement>("#natural-download-row")!;
  const download = document.querySelector<HTMLButtonElement>("#natural-download")!;
  let settings: Settings | null = null;
  let status: NaturalVoiceStatus | undefined;
  let draft: NaturalModel = "kitten";
  let busy = false;
  let available: readonly NaturalModel[] = [];
  let failure = "";
  let said = "";
  const allowed = (model: NaturalModel) => model === "kitten" || available.includes(model);
  function draw(): void {
    // As in force: where the organisation turns the natural voice off, Kitten Nano is the voice, also while Ember holds
    // itself locked down after a policy change and the settings still hold Kokoro (safety-privacy-v6-1). The draft stays.
    const current = deps.managed() ? "kitten" : effectiveVoiceModel(settings?.voice);
    const shown = deps.managed() ? current : draft;
    const changed = shown !== current;
    const view = naturalVoiceView(status, current);
    select.disabled = busy || deps.managed() || !settings;
    for (const option of select.options) option.disabled = !allowed(option.value as NaturalModel);
    select.value = shown;
    hint.textContent = allowed(shown) ? naturalModelHint(shown) : `${NATURAL_CHOICES[shown].name} isn't available on this computer. Choose Kitten Nano to use the default voice, with the system voice as its fallback.`;
    choiceStatus.textContent = busy ? "Saving voice choice…" : failure || (changed ? `Not saved. Current choice: ${NATURAL_CHOICES[current].name}.` : "");
    use.hidden = !changed;
    use.disabled = busy || deps.managed() || !settings || !allowed(shown);
    use.textContent = naturalUseLabel(shown);
    text.textContent = view.text;
    downloadRow.hidden = !settings || status?.model !== undefined && status.model !== current || !(status?.state === "needs-voice" || current === "kitten" && status?.state === "failed");
    download.disabled = busy || deps.managed();
    const hadRetry = document.activeElement === retry;
    retry.hidden = !view.retry || !allowed(current);
    retry.disabled = busy || deps.managed() || !allowed(current);
    if (hadRetry && retry.hidden) select.focus();
    const state = `${current}:${status?.model ?? ""}:${status?.state ?? ""}:${status?.voice ?? ""}`;
    // Only where it stands, never that it is checking (or downloading): the voice loads again at every first wake or
    // request after two quiet minutes, and "Checking Kitten Nano on this computer…" was said over the request and
    // into the idle wake microphone (voice-listening-c5-1). What it decides is said once it holds (main's heldLive).
    if (state !== said && status?.state !== "downloading" && !view.busy) deps.live(view.text);
    said = state;
  }
  async function save(): Promise<void> {
    if (!settings || busy || deps.managed() || !allowed(draft)) { draw(); return; }
    const from = document.activeElement;
    busy = true;
    failure = "";
    draw();
    try {
      const ok = await deps.save({ voice: { ...settings.voice, natural: draft !== "kitten", naturalModel: draft } });
      if (!ok) failure = "Couldn't save the voice choice. Your current voice is kept.";
    } catch { failure = "Couldn't save the voice choice. Your current voice is kept."; }
    finally {
      busy = false;
      draw();
      if ((document.activeElement === document.body || document.activeElement === from) && from === use) {
        const target = use.hidden ? select : use;
        if (!target.disabled && target.getClientRects().length) target.focus();
        else document.querySelector<HTMLSelectElement>("#speak")?.focus();
      }
    }
  }
  select.addEventListener("change", () => {
    if (select.value !== "kokoro" && select.value !== "supertonic" && select.value !== "kitten") return;
    draft = select.value;
    failure = "";
    draw();
  });
  use.addEventListener("click", () => void save());
  download.addEventListener("click", () => {
    const target = document.querySelector<HTMLButtonElement>("#voice-download");
    if (target && !target.hidden && !target.disabled) { target.scrollIntoView({ block: "center" }); target.focus(); }
  });
  retry.addEventListener("click", () => { if (!retry.disabled) void window.ember.retryNaturalVoice(); });
  return {
    settings(next: Settings): void {
      if (!settings || draft === effectiveVoiceModel(settings.voice)) draft = effectiveVoiceModel(next.voice);
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
