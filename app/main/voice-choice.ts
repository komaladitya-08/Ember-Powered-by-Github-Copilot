/** Kitten is the baseline; Kokoro is an explicit optional download. Availability never changes the saved choice. */
import type { Settings } from "./settings";

export function naturalVoiceChoices(addon: boolean, nativeCapi: boolean): Settings["voice"]["naturalModel"][] {
  return addon ? ["kitten", "kokoro"] : nativeCapi ? ["kitten"] : [];
}

type Preference = Pick<Settings["voice"], "natural" | "naturalModel">;
export function naturalVoiceWanted(preference: Preference): boolean {
  return preference.natural && preference.naturalModel === "kokoro";
}

/** Disable before changing an off choice, so a formerly enabled engine cannot start an unwanted model download. */
export function applyNaturalVoicePreference(service: {
  setNaturalVoice(on: boolean): void;
  setNaturalModel(model: Preference["naturalModel"]): void;
} | null, preference: Preference): void {
  const on = naturalVoiceWanted(preference);
  if (!on) service?.setNaturalVoice(false);
  service?.setNaturalModel(on ? "kokoro" : "kitten");
  if (on) service?.setNaturalVoice(true);
}
