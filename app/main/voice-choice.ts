/** Optional natural voices supported by the selected native speech backend; availability never enables a download. */
import type { Settings } from "./settings";

export function naturalVoiceChoices(addon: boolean, nativeCapi: boolean): Settings["voice"]["naturalModel"][] {
  return addon ? ["kokoro", "kitten"] : nativeCapi ? ["kitten"] : [];
}

type Preference = Pick<Settings["voice"], "natural" | "naturalModel">;
export function naturalVoiceWanted(preference: Preference, available: readonly Preference["naturalModel"][]): boolean {
  return preference.natural && available.includes(preference.naturalModel);
}

/** Disable before changing an off choice, so a formerly enabled engine cannot start an unwanted model download. */
export function applyNaturalVoicePreference(service: {
  setNaturalVoice(on: boolean): void;
  setNaturalModel(model: Preference["naturalModel"]): void;
} | null, preference: Preference, available: readonly Preference["naturalModel"][]): void {
  const on = naturalVoiceWanted(preference, available);
  if (!on) service?.setNaturalVoice(false);
  service?.setNaturalModel(preference.naturalModel);
  if (on) service?.setNaturalVoice(true);
}
