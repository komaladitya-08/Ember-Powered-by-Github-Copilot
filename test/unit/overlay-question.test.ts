/**
 * A question's buttons stay where they first showed (live retest: Allow moved under a pointer already aimed at it,
 * because Ember flew on to a spot by the cursor and the bubble rode along).
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => {
  const display = { workArea: { x: 0, y: 0, width: 1920, height: 1200 }, bounds: { x: 0, y: 0, width: 1920, height: 1200 } };
  return {
    BrowserWindow: class {},
    screen: { getCursorScreenPoint: () => ({ x: 900, y: 600 }), getDisplayNearestPoint: () => display, getDisplayMatching: () => display },
  };
});

const { OverlayManager } = await import("../../app/main/overlay");
const { IDLE_BUBBLE } = await import("../../app/shared/overlay");
import type { Logger } from "../../app/main/logger";
import type { Settings } from "../../app/main/settings";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const question = { ...IDLE_BUBBLE, visible: true, mood: "attention" as const, title: "May I?", thought: "Type “Hi”?", actions: [{ id: "q1:once", label: "Allow", primary: true }, { id: "q1:deny", label: "Not now" }] };

describe("a question appears", () => {
  it("Ember stops where it is (no flight that would carry the buttons away)", () => {
    let cursor = { x: 200, y: 200 };
    const o = new OverlayManager(() => ({ size: 60, reduceMotion: false }) as Settings, quiet, () => cursor);
    const follower = (o as unknown as { follower: { position: { x: number; y: number }; parked: { x: number; y: number } | null } }).follower;
    const at = follower.position;
    // The pointer has moved on (to the bubble's area): Ember doesn't fly after it while the question is up.
    cursor = { x: 900, y: 600 };
    o.setState({ emotion: "curious", bubble: question });
    expect(follower.parked).toEqual(at);
    expect(o.position).toEqual(at);
    // Answered: it follows the cursor again.
    o.setState({ bubble: { ...IDLE_BUBBLE } });
    expect(follower.parked).toBeNull();
  });

  it("beside a control it works on, it stays there", () => {
    const o = new OverlayManager(() => ({ size: 60, reduceMotion: false }) as Settings, quiet, () => ({ x: 900, y: 600 }));
    const follower = (o as unknown as { follower: { parked: { x: number; y: number } | null } }).follower;
    o.setState({ focus: { x: 100, y: 100, width: 80, height: 30 } });
    const beside = follower.parked;
    o.setState({ bubble: question });
    expect(follower.parked).toEqual(beside);
  });
});
