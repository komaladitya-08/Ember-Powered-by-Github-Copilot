/**
 * Home's conversation (app/renderer/home/conversation-view.ts) and main's Task activity push (app/main/push-later.ts):
 * the latest messages kept in place as main's 60-entry transcript drops its oldest, and a push at most every 500 ms
 * (review of PR #125).
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { CONVERSATION_SHOWN, conversationChange, conversationShown, earlierLabel } from "../../app/renderer/home/conversation-view";
import { pushLater } from "../../app/main/push-later";
import { askedWhere } from "../../app/renderer/home/tasks-copy";

const msg = (i: number) => ({ t: `2026-11-02T10:${String(i).padStart(2, "0")}:00.000Z`, who: i % 2 ? "ember" : "you", text: `message ${i}` });
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => msg(from + k));

describe("Home's conversation", () => {
  it("shows the latest thirty messages, or every one once asked", () => {
    expect(CONVERSATION_SHOWN).toBe(30);
    expect(conversationShown(range(0, 45), false)).toEqual(range(15, 45));
    expect(conversationShown(range(0, 45), true)).toHaveLength(45);
    expect(conversationShown(range(0, 3), false)).toHaveLength(3);
    expect(earlierLabel(0)).toBeNull();
    expect(earlierLabel(1)).toBe("Show 1 earlier message");
    expect(earlierLabel(15)).toBe("Show 15 earlier messages");
  });

  it("adds a new message in place and takes the oldest shown off the top, also once main's 60 entries are full", () => {
    // A growing conversation: nothing goes, the new one is added.
    expect(conversationChange(range(0, 10), range(0, 11))).toEqual({ drop: 0, add: [msg(10)] });
    // Past thirty shown: the oldest shown goes as a new one comes.
    expect(conversationChange(conversationShown(range(0, 30), false), conversationShown(range(0, 31), false))).toEqual({ drop: 1, add: [msg(30)] });
    // At main's cap the transcript itself drops its oldest: the rows are matched by what they are, never by index.
    const before = conversationShown(range(10, 70), false);
    const after = conversationShown(range(12, 72), false);
    expect(conversationChange(before, after)).toEqual({ drop: 2, add: [msg(70), msg(71)] });
    // Every message shown, at the cap: the two oldest go from the top.
    expect(conversationChange(range(10, 70), range(12, 72))).toEqual({ drop: 2, add: [msg(70), msg(71)] });
  });

  it("starts again when the conversation was forgotten (sign-out, another account)", () => {
    expect(conversationChange(range(0, 5), [])).toEqual({ drop: 5, add: [] });
    expect(conversationChange(range(0, 5), [{ t: "x", who: "you", text: "new" }])).toEqual({ drop: 5, add: [{ t: "x", who: "you", text: "new" }] });
  });
});

describe("main's Task activity push", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("sends at most once every interval, the latest state, however many changes come", () => {
    vi.useFakeTimers();
    let sent = 0;
    const push = pushLater(500, () => { sent++; });
    for (let i = 0; i < 20; i++) push();
    expect(sent).toBe(0);
    vi.advanceTimersByTime(499);
    expect(sent).toBe(0);
    vi.advanceTimersByTime(1);
    expect(sent).toBe(1);
    push();
    push();
    vi.advanceTimersByTime(500);
    expect(sent).toBe(2);
    vi.advanceTimersByTime(5000);
    expect(sent).toBe(2);
  });
});

describe("where a waiting question is answered", () => {
  it("is its latest waiting question's place, the bubble when not said", () => {
    expect(askedWhere([])).toBe("bubble");
    expect(askedWhere([{ kind: "question", state: "done", askedIn: "card" }, { kind: "question", state: "waiting", askedIn: "command" }])).toBe("command");
    expect(askedWhere([{ kind: "question", state: "waiting" }])).toBe("bubble");
  });
});
