/** The default local voice and the optional download, with no automatic switch from a saved Kokoro choice. */
import type { Settings } from "../../main/settings";

export type NaturalModel = Settings["voice"]["naturalModel"];
export const NATURAL_CHOICES: Readonly<Record<NaturalModel, { name: string; size: string }>> = {
  kitten: { name: "Kitten Nano", size: "63.8 MB" },
  kokoro: { name: "Kokoro", size: "350 MB" },
};

/** Legacy natural:false means the baseline voice, regardless of the model field an older release saved. */
export function effectiveVoiceModel(preference?: Pick<Settings["voice"], "natural" | "naturalModel"> | null): NaturalModel {
  return preference?.natural && preference.naturalModel === "kokoro" ? "kokoro" : "kitten";
}

export function naturalModelHint(model: NaturalModel): string {
  return model === "kitten"
    ? "Kitten Nano is the default voice, included in Ember's speech models. Its voice files are 63.8 MB. Speech stays on this computer; the system voice is used if Kitten cannot run fast enough."
    : "Kokoro downloads 350 MB when you choose Use Kokoro. Speech stays on this computer. If it cannot run fast enough, Ember uses Kitten Nano, or the system voice if needed.";
}

export function naturalUseLabel(model: NaturalModel): string {
  return model === "kokoro" ? "Use Kokoro (350 MB download)" : "Use Kitten Nano";
}
