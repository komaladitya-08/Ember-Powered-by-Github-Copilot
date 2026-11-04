/** Keep legacy Kokoro availability and offer Kitten on Linux only with a selected native C API backend. */
import { expect, it } from "vitest";
import { applyNaturalVoicePreference, naturalVoiceChoices, naturalVoiceWanted } from "../../app/main/voice-choice";

it("keeps both choices on native-addon platforms and only Kitten on native C API", () => {
  expect(naturalVoiceChoices(true, false)).toEqual(["kokoro", "kitten"]);
  expect(naturalVoiceChoices(false, true)).toEqual(["kitten"]);
  expect(naturalVoiceChoices(false, false)).toEqual([]);
});


it("never enables an unsupported or disabled model, and switches an enabled choice explicitly", () => {
  expect(naturalVoiceWanted({ natural: true, naturalModel: "kokoro" }, ["kitten"])).toBe(false);
  expect(naturalVoiceWanted({ natural: false, naturalModel: "kitten" }, ["kitten"])).toBe(false);
  expect(naturalVoiceWanted({ natural: true, naturalModel: "kitten" }, ["kitten"])).toBe(true);
  const calls: (boolean | string)[] = [];
  const service = { setNaturalVoice: (on: boolean) => { calls.push(on); }, setNaturalModel: (model: string) => { calls.push(model); } };
  applyNaturalVoicePreference(service, { natural: false, naturalModel: "kitten" }, ["kitten"]);
  expect(calls).toEqual([false, "kitten"]);
  calls.length = 0;
  applyNaturalVoicePreference(service, { natural: true, naturalModel: "kitten" }, ["kitten"]);
  expect(calls).toEqual(["kitten", true]);
  calls.length = 0;
  applyNaturalVoicePreference(service, { natural: true, naturalModel: "kokoro" }, ["kitten"]);
  expect(calls).toEqual([false, "kokoro"]);
});
