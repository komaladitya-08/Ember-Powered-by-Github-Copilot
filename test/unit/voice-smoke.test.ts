/** The end-to-end voice assertions must fail if only speech stops or a later conversational turn is lost. */
import { describe, expect, it } from "vitest";
import { voiceConversation, voiceStop, voiceSystemSpeech, type VoiceLog } from "../smoke/voice-checks.mjs";

const turn = (window: string): VoiceLog[] => [
  { msg: "voice.utterance", window },
  { msg: "voice.self_speaking", on: true },
  { msg: "voice.audio_played", seconds: 1 },
  { msg: "voice.self_speaking", on: false },
  { msg: "voice.follow_up" },
  { msg: "voice.event", type: "listening" },
];
const windows = ["wake", "follow-up", "follow-up"];
const conversation = (): VoiceLog[] => [{ msg: "voice.wake" }, ...windows.flatMap(turn)];

describe("the voice stop smoke", () => {
  it("requires the app-wide kill switch after the spoken stop, with voice as its source", () => {
    expect(voiceStop([{ msg: "voice.stop" }, { msg: "killswitch.pulled", source: "voice" }], 0)).toBe(1);
  });
  it.each([
    [{ msg: "voice.stop" }, { msg: "voice.self_speaking", on: false }],
    [{ msg: "voice.stop" }, { msg: "killswitch.pulled", source: "hotkey" }],
    [{ msg: "killswitch.pulled", source: "voice" }, { msg: "voice.stop" }],
  ])("does not mistake a hush, another stop source or an earlier stop for this stop", (...log) => {
    expect(() => voiceStop(log, log.findIndex(e => e.msg === "voice.stop"))).toThrow(/killswitch.pulled/);
  });
});

describe("the multi-turn voice smoke", () => {
  it("requires three requests, spoken replies between them, and a reopened follow-up window after each", () => {
    expect(voiceConversation(conversation(), windows)).toHaveLength(3);
  });
  it.each(["voice.self_speaking", "voice.audio_played", "voice.follow_up", "voice.event"])("fails when the second turn has no %s", msg => {
    const log = conversation().filter((e, i) => !(i >= 7 && i < 13 && e.msg === msg));
    expect(() => voiceConversation(log, windows)).toThrow(/turn 2/);
  });
  it("does not use the third turn's reply to pass a silent second turn", () => {
    const log = conversation();
    log.splice(8, 5);
    expect(() => voiceConversation(log, windows)).toThrow(/turn 2/);
  });
  it("rejects a missing, duplicate or newly woken request", () => {
    expect(() => voiceConversation(conversation().slice(0, -6), windows)).toThrow(/heard 2/);
    expect(() => voiceConversation([...conversation(), ...turn("follow-up")], windows)).toThrow(/heard 4/);
    expect(() => voiceConversation([...conversation(), { msg: "voice.wake" }], windows)).toThrow(/another wake/);
    const log = conversation();
    log[7].window = "wake";
    expect(() => voiceConversation(log, windows)).toThrow(/expected follow-up/);
  });
  it("fails when listening reopens before the spoken reply ends", () => {
    const log = conversation();
    [log[4], log[5]] = [log[5], log[4]];
    expect(() => voiceConversation(log, windows)).toThrow(/turn 1/);
  });
});

describe("the local system-voice fallback smoke", () => {
  const system = () => conversation().filter(e => e.msg !== "voice.audio_played");
  it("requires actual start, completion and follow-up for each system-spoken turn", () => {
    expect(voiceSystemSpeech(system())).toEqual({ on: 2, off: 3 });
    expect(voiceConversation(system(), windows, true)).toHaveLength(3);
    expect(voiceConversation(system(), windows, true).every(t => t.audio === null)).toBe(true);
  });
  it("does not accept dispatch alone, missing playback completion, or hidden neural speech", () => {
    for (const log of [[], [{ msg: "voice.self_speaking", on: true }], [{ msg: "voice.self_speaking", on: false }],
      [...system(), { msg: "voice.tts_ready" }], [...system(), { msg: "voice.audio_played", seconds: 1 }]]) {
      expect(() => voiceSystemSpeech(log)).toThrow();
    }
    expect(() => voiceConversation([...system(), { msg: "voice.tts_ready" }], windows, true)).toThrow();
    expect(() => voiceConversation(system().filter((_, i) => i !== 3), windows, true)).toThrow(/turn 1/);
    expect(() => voiceConversation(system(), windows)).toThrow(/voice.audio_played/);
  });
});
