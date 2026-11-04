/** Natural voice choices disclose the opt-in download and preserve the default voice on existing installations. */
import type { Settings } from "../../main/settings";

export type NaturalModel = Settings["voice"]["naturalModel"];
export const NATURAL_CHOICES: Readonly<Record<NaturalModel, { name: string; size: string }>> = {
  kokoro: { name: "Kokoro", size: "350 MB" },
  kitten: { name: "Kitten Nano", size: "63.8 MB" },
};
export function naturalModelHint(model: NaturalModel): string {
  const choice = NATURAL_CHOICES[model];
  return `${choice.name}: downloads ${choice.size} when enabled. Speech stays on this computer. Ember checks its speed and keeps its usual voice if needed.`;
}
export function naturalUseLabel(model: NaturalModel, on: boolean): string {
  const choice = NATURAL_CHOICES[model];
  return on ? `Use ${choice.name} (${choice.size} download)` : "Save voice choice";
}
