/**
 * Ember's acknowledgement of a spoken request Copilot is slow to answer (app/main/acknowledge.ts): one that fits the
 * request ("Let me look.", "On it."), because a generic filler is no better than silence, and none when nothing fits.
 */

import { describe, expect, it } from "vitest";
import { acknowledgement } from "../../app/main/acknowledge";
import { TurnLatency, type TurnTimes } from "../../app/main/turn-latency";

describe("acknowledgement", () => {
  it("says it is on a request to do something", () => {
    for (const t of ["Open the quarterly report", "Ember, turn on Night Light", "can you tidy my desktop", "send Priya the notes", "remind me at 3 to stand up"]) expect(acknowledgement(t), t).toBe("On it.");
  });

  it("says it will look for a question about the screen, and check for other questions", () => {
    expect(acknowledgement("what's on my screen?")).toBe("Let me look.");
    expect(acknowledgement("what does this window say")).toBe("Let me look.");
    expect(acknowledgement("what time is it in Tokyo")).toBe("Let me check.");
    expect(acknowledgement("how many tasks are running")).toBe("Let me check.");
  });

  it("offers to show for a request to be guided, and notes what to remember", () => {
    expect(acknowledgement("show me how to change the wallpaper")).toBe("Let me show you.");
    expect(acknowledgement("how do I turn on dark mode")).toBe("Let me show you.");
    expect(acknowledgement("remember that I work with Priya")).toBe("Got it.");
  });

  it("says nothing when no acknowledgement clearly fits (a generic filler helps nobody)", () => {
    for (const t of ["thanks", "Ember", "hello there Ember", "I think the meeting went well", "bonjour, ouvre les réglages", ""]) expect(acknowledgement(t), t).toBeNull();
  });
});

describe("TurnLatency with an acknowledgement", () => {
  it("logs when the acknowledgement was said", () => {
    let now = 0;
    const logged: TurnTimes[] = [];
    const l = new TurnLatency({ now: () => now, log: t => logged.push(t) });
    l.heard(120);
    now = 30; l.mark("sent");
    now = 730; l.mark("ack");
    now = 900; l.mark("firstAudio");
    expect(logged).toEqual([{ asrMs: 120, sentMs: 30, ackMs: 730, firstAudioMs: 900 }]);
  });
});
