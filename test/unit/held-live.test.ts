/**
 * Held status lines (renderer/shared/held-live.ts): what a screen reader is told of a line, never while the microphone
 * is open for a request, where it was said through the speakers into what Ember heard.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { heldLive, LIVE_SETTLE_MS } from "../../app/renderer/shared/held-live";

/** A status line as a screen reader hears it: each line written to it is said, and an emptied one says nothing. */
function statusLine(start = "") {
  const said: string[] = [];
  let now = start;
  const live = { set textContent(t: string) { now = t; if (t) said.push(t); }, get textContent() { return now; } };
  return { said, live };
}

afterEach(() => { vi.useRealTimers(); });

describe("a held status line", () => {
  it("says a line once it has held, once, and nothing for a line that changes and changes back (voice-listening-c4-1)", () => {
    vi.useFakeTimers();
    const { said, live } = statusLine();
    const line = heldLive(live);
    line.say("Starting…");
    line.say("Starting…");
    expect(said).toEqual([]);
    vi.advanceTimersByTime(LIVE_SETTLE_MS);
    expect(said).toEqual(["Starting…"]);
    // Rewritten with the same words on every voice push: said again each time, before (voice-listening-c4-1).
    for (let i = 0; i < 5; i++) { line.say("Starting…"); vi.advanceTimersByTime(LIVE_SETTLE_MS); }
    line.say("Downloading… 25%");
    line.say("Starting…");
    vi.advanceTimersByTime(LIVE_SETTLE_MS * 2);
    expect(said).toEqual(["Starting…"]);
  });

  it("says nothing while the microphone is open for a request, empties itself unsaid, and says what lasted once it closes (voice-listening-c4-1)", () => {
    vi.useFakeTimers();
    const { said, live } = statusLine();
    const line = heldLive(live);
    line.say("This computer can't run it, so the usual speech model writes what you say.");
    vi.advanceTimersByTime(LIVE_SETTLE_MS);
    line.hold(true);
    expect(live.textContent).toBe("");
    line.say("Starting…");
    line.say("On. The clearer model writes what you say.");
    vi.advanceTimersByTime(LIVE_SETTLE_MS * 20);
    expect(said).toEqual(["This computer can't run it, so the usual speech model writes what you say."]);
    line.hold(false);
    vi.advanceTimersByTime(LIVE_SETTLE_MS);
    expect(said.at(-1)).toBe("On. The clearer model writes what you say.");
    expect(said).toHaveLength(2);
  });

  it("says nothing once the microphone closes when the line is what it said before", () => {
    vi.useFakeTimers();
    const { said, live } = statusLine();
    const line = heldLive(live);
    line.say("On. The clearer model writes what you say.");
    vi.advanceTimersByTime(LIVE_SETTLE_MS);
    line.hold(true);
    line.say("Starting…");
    line.say("On. The clearer model writes what you say.");
    line.hold(false);
    vi.advanceTimersByTime(LIVE_SETTLE_MS * 2);
    expect(said).toEqual(["On. The clearer model writes what you say."]);
  });

  it("never says a line whose hold began before it had held long enough", () => {
    vi.useFakeTimers();
    const { said, live } = statusLine();
    const line = heldLive(live);
    line.say("Starting…");
    vi.advanceTimersByTime(LIVE_SETTLE_MS / 2);
    line.hold(true);
    vi.advanceTimersByTime(LIVE_SETTLE_MS * 2);
    expect(said).toEqual([]);
    line.hold(false);
    line.hold(true);
    vi.advanceTimersByTime(LIVE_SETTLE_MS * 2);
    expect(said).toEqual([]);
  });
});
