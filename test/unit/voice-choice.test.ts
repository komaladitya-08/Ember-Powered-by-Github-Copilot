/** Default Kitten selection and explicit optional Kokoro must not change consent or the platform boundary. */
import { expect, it } from "vitest";
import { applyNaturalVoicePreference, naturalVoiceChoices, naturalVoiceWanted } from "../../app/main/voice-choice";

it("lists the baseline first and preserves the existing optional Kokoro platform boundary", () => {
  expect(naturalVoiceChoices(true, false)).toEqual(["kitten", "kokoro"]);
  expect(naturalVoiceChoices(false, true)).toEqual(["kitten"]);
  expect(naturalVoiceChoices(false, false)).toEqual([]);
});

it("requests optional Kokoro only for its explicit enabled preference", () => {
  expect(naturalVoiceWanted({ natural: false, naturalModel: "kokoro" })).toBe(false);
  expect(naturalVoiceWanted({ natural: true, naturalModel: "kitten" })).toBe(false);
  expect(naturalVoiceWanted({ natural: true, naturalModel: "kokoro" })).toBe(true);
});

it("disables the optional override before choosing baseline, and selects Kokoro before enabling its download", () => {
  const calls: (boolean | string)[] = [];
  const service = { setNaturalVoice: (on: boolean) => { calls.push(on); }, setNaturalModel: (model: string) => { calls.push(model); } };
  applyNaturalVoicePreference(service, { natural: false, naturalModel: "kokoro" });
  expect(calls).toEqual([false, "kitten"]);
  calls.length = 0;
  applyNaturalVoicePreference(service, { natural: true, naturalModel: "kitten" });
  expect(calls).toEqual([false, "kitten"]);
  calls.length = 0;
  applyNaturalVoicePreference(service, { natural: true, naturalModel: "kokoro" });
  expect(calls).toEqual(["kokoro", true]);
});
