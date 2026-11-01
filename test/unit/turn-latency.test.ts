/**
 * The spoken-turn timer behind `voice.latency` (docs/ASSISTANT.md phase 0): each step of answering aloud is timed from
 * the transcript, once, and the line carries times only.
 */

import { describe, expect, it } from "vitest";
import { TURN_GIVE_UP_MS, TurnLatency, type TurnTimes } from "../../app/main/turn-latency";

function timer() {
  let t = 1000;
  const lines: TurnTimes[] = [];
  const l = new TurnLatency({ now: () => t, log: x => lines.push(x) });
  return { l, lines, at: (ms: number) => { t = 1000 + ms; } };
}

describe("TurnLatency", () => {
  it("times each step of a spoken answer from its transcript, and logs once the first sound plays", () => {
    const { l, lines, at } = timer();
    l.heard(180.4);
    at(40); l.mark("sent");
    at(900); l.mark("firstToken");
    at(1300); l.mark("firstChunk");
    at(1400); l.mark("firstToken");
    expect(lines).toEqual([]);
    at(1650); l.mark("firstAudio");
    expect(lines).toEqual([{ asrMs: 180, sentMs: 40, firstTokenMs: 900, firstChunkMs: 1300, firstAudioMs: 1650 }]);
  });

  it("logs a turn that was never spoken as it stands, when the next request comes", () => {
    const { l, lines, at } = timer();
    l.heard(100);
    at(30); l.mark("sent");
    at(5000); l.heard(90);
    expect(lines).toEqual([{ asrMs: 100, sentMs: 30 }]);
  });

  it("ignores steps with no spoken request open (a typed question)", () => {
    const { l, lines } = timer();
    l.mark("firstToken");
    l.mark("firstAudio");
    l.end();
    expect(lines).toEqual([]);
  });

  it("gives up on a turn whose steps come long after it", () => {
    const { l, lines, at } = timer();
    l.heard(100);
    at(TURN_GIVE_UP_MS + 1); l.mark("firstAudio");
    expect(lines).toEqual([{ asrMs: 100 }]);
  });
});
