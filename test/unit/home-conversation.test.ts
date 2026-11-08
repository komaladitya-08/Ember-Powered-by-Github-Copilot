/**
 * Home's conversation (app/renderer/home/conversation-view.ts) and main's Task activity push (app/main/push-later.ts):
 * the latest messages kept in place as main's 60-entry transcript drops its oldest, and a push at most every 500 ms
 * (review of PR #125).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONVERSATION_SHOWN, conversationAdded, conversationChange, conversationShown, earlierLabel, editGivenBack, stillUnsent } from "../../app/renderer/home/conversation-view";
import { pushLater } from "../../app/main/push-later";
import { askedWhere } from "../../app/renderer/home/tasks-copy";
import { CONVERSATION_LIMIT, CONVERSATION_TEXT_LIMIT, conversationRequest, retainedConversationText } from "../../app/shared/conversation";
import { CONVERSATION_RETENTION, conversationMatchesText, conversationSearchCount } from "../../app/renderer/home/copy";

const msg = (i: number) => ({ t: `2026-11-02T10:${String(i).padStart(2, "0")}:00.000Z`, who: i % 2 ? "ember" : "you", text: `message ${i}` });
const range = (from: number, to: number) => Array.from({ length: to - from }, (_, k) => msg(from + k));

describe("Home's conversation", () => {
  it("keeps full long answers within an explicit bounded session, and discloses overflow", () => {
    const answer = "A useful answer with its ending. ".repeat(300);
    expect(answer.length).toBeGreaterThan(4000);
    expect(retainedConversationText(answer)).toEqual({ text: answer });
    expect(retainedConversationText("a".repeat(CONVERSATION_TEXT_LIMIT))).toEqual({ text: "a".repeat(CONVERSATION_TEXT_LIMIT) });
    const overflow = retainedConversationText("a".repeat(CONVERSATION_TEXT_LIMIT - 1) + "😀ending");
    expect(overflow).toEqual({ text: "a".repeat(CONVERSATION_TEXT_LIMIT - 1), truncated: true });
    expect(CONVERSATION_LIMIT).toBe(60);
    expect(CONVERSATION_RETENTION).toContain("latest 60 messages");
    expect(CONVERSATION_RETENTION).toContain("Older messages are forgotten");
  });

  it("validates a fresh explicit request without coercing values or silently cutting text", () => {
    expect(conversationRequest("  Ask a follow-up\nwith details  ")).toBe("Ask a follow-up\nwith details");
    for (const bad of [null, {}, 7, " \n ", "a".repeat(2001)]) expect(conversationRequest(bad)).toBeNull();
    expect(conversationRequest("a".repeat(2000))).toHaveLength(2000);
  });

  it("finds retained text without markup interpretation, including earlier messages and multiline code", () => {
    expect(conversationMatchesText("Earlier <script>message</script>\nconst answer = 42;", " SCRIPT ")).toBe(true);
    expect(conversationMatchesText("Earlier message", "missing")).toBe(false);
    expect(conversationSearchCount(0)).toBe("0 matching messages in this conversation.");
    expect(conversationSearchCount(1)).toBe("1 matching message in this conversation.");
  });
  it("shows the latest six messages, so the composer stays within reach, or every one once asked (home-v2)", () => {
    expect(CONVERSATION_SHOWN).toBe(6);
    expect(conversationShown(range(0, 45), false)).toEqual(range(39, 45));
    expect(conversationShown(range(0, 45), true)).toHaveLength(45);
    expect(conversationShown(range(0, 3), false)).toHaveLength(3);
    expect(earlierLabel(0)).toBeNull();
    expect(earlierLabel(1)).toBe("Show 1 earlier message");
    expect(earlierLabel(39)).toBe("Show 39 earlier messages");
  });

  it("keeps showing a message that holds the keyboard focus, and those after it, as newer ones come (home-c1-2)", () => {
    // Its Copy focused on the oldest shown: two more messages come, and it stays (with every one after it).
    expect(conversationShown(range(0, 8), false, msg(2))).toEqual(range(2, 8));
    // Among the latest few anyway: the latest few, as always.
    expect(conversationShown(range(0, 8), false, msg(5))).toEqual(range(2, 8));
    expect(conversationShown(range(0, 10), false, msg(7))).toEqual(range(4, 10));
    // Gone from the conversation (main's 60 entries moved past it), or every message shown: as before.
    expect(conversationShown(range(5, 15), false, msg(1))).toEqual(range(9, 15));
    expect(conversationShown(range(0, 8), true, msg(2))).toEqual(range(0, 8));
  });

  it("adds a new message in place and takes the oldest shown off the top, also once main's 60 entries are full", () => {
    // A growing conversation: nothing goes, the new one is added.
    expect(conversationChange(range(0, 10), range(0, 11))).toEqual({ drop: 0, add: [msg(10)] });
    // Past six shown: the oldest shown goes as a new one comes.
    expect(conversationChange(conversationShown(range(0, 6), false), conversationShown(range(0, 7), false))).toEqual({ drop: 1, add: [msg(6)] });
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

  it("refreshes the disclosure if a replaced problem reaches its retention bound", () => {
    const line = { ...msg(1), who: "problem" };
    const bounded = { ...line, truncated: true };
    expect(conversationChange([line], [bounded])).toEqual({ drop: 1, add: [bounded] });
  });

  it("finds the messages that came since the last list, also once main's 60 entries drop the oldest and a Problem line is said again in place", () => {
    expect(conversationAdded(range(0, 10), range(0, 12))).toEqual([msg(10), msg(11)]);
    expect(conversationAdded(range(10, 70), range(12, 72))).toEqual([msg(70), msg(71)]);
    // The same list again (a search typed, earlier messages shown): nothing came.
    expect(conversationAdded(range(0, 10), range(0, 10))).toEqual([]);
    // The last line restated (one failure, one line): the lines after the one before it.
    const problem = { ...msg(3), who: "problem" };
    expect(conversationAdded([...range(0, 3), problem], [...range(0, 3), { ...problem, text: "said again" }, msg(4)])).toEqual([{ ...problem, text: "said again" }, msg(4)]);
    // Nothing in common (the first list, or another account's): every one.
    expect(conversationAdded([], range(0, 3))).toEqual(range(0, 3));
    expect(conversationAdded(range(0, 3), range(5, 7))).toEqual(range(5, 7));
  });

  it("keeps a composer message given back on a Stop only until its own line comes, oldest first among the same words (home-v4-1, home-v4-2)", () => {
    const you = (text: string, i = 0) => ({ t: `2026-11-08T10:0${i}:00.000Z`, who: "you", text });
    const a = { text: "status?", taken: true }, b = { text: "Book the meeting room  ", taken: true }, c = { text: "status?", taken: false };
    // Its line came (Ember answered it itself, or it went to the model): it is no longer one to give back.
    expect(stillUnsent([a, b], [you("status?"), { t: "x", who: "ember", text: "Nothing's running right now." }])).toEqual([b]);
    // Matched by its words as main keeps them (trimmed), one line for one message.
    expect(stillUnsent([a, b, c], [you("Book the meeting room", 1), you("status?", 2)])).toEqual([c]);
    // Ember's lines, and lines of yours with other words, take nothing off.
    expect(stillUnsent([a, b], [{ t: "x", who: "ember", text: "status?" }, you("And tell Sam")])).toEqual([a, b]);
  });

  it("tells the words a Stop gave back from the request being edited as the person left them, for Cancel edit (home-v5-1)", () => {
    const given = "Book the meeting room for Friday", edited = "Empty the trash";
    // As they came, and corrected: everything above the request, their correction kept.
    expect(editGivenBack(`${given}\n\n${edited}`, given, edited)).toEqual({ text: given, edited, whole: false });
    expect(editGivenBack(`Book the meeting room for Saturday\n\n${edited}`, given, edited)).toEqual({ text: "Book the meeting room for Saturday", edited, whole: false });
    expect(editGivenBack(`Book the meeting room for Saturday\n${edited}  \n`, given, edited).text).toBe("Book the meeting room for Saturday");
    // Deleted, as they changed their mind: nothing (with or without the line break left behind).
    expect(editGivenBack(edited, given, edited)).toEqual({ text: "", edited, whole: false });
    expect(editGivenBack(`\n\n${edited}`, given, edited).text).toBe("");
    // The request changed and the words as they came: those alone (the request's changes go, as Cancel edit's do).
    expect(editGivenBack(`${given}\n\nEmpty the trash and the bin`, given, edited)).toEqual({ text: given, edited: "Empty the trash and the bin", whole: false });
    expect(editGivenBack(given, given, edited)).toEqual({ text: given, edited: "", whole: false });
    // Words that end as the request does are never cut short: of the two readings, the one that keeps more.
    expect(editGivenBack("Say Yes", "Say Yes", "Yes").text).toBe("Say Yes");
    expect(editGivenBack(`${given}\n\nAnd Sam\n\n${edited}`, given, edited).text).toBe(`${given}\n\nAnd Sam`);
    // Both changed, or the request merged into them: the whole field, nothing of theirs lost.
    expect(editGivenBack(`Book it for Saturday\n\nEmpty the bin`, given, edited)).toEqual({ text: "Book it for Saturday\n\nEmpty the bin", edited: null, whole: true });
    expect(editGivenBack(`Book it${edited}`, given, edited).whole).toBe(true);
    expect(editGivenBack("Book it for Saturday", given, null)).toEqual({ text: "Book it for Saturday", edited: null, whole: true });
    // A request emptied before the Stop: everything there is theirs.
    expect(editGivenBack("Book it for Saturday", given, "")).toEqual({ text: "Book it for Saturday", edited: "", whole: false });
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

describe("Home's New conversation button (review of #184)", () => {
  // Behaviour (status, focus, a newer draft kept) is in test/integration/home-conversation-renderer.test.ts; main.ts
  // can't load under Node, so its one decision is pinned by its text: an own reset isn't broadcast as a forgetting.
  it("main doesn't broadcast conversationForgotten for the chat Home itself started over", () => {
    const src = readFileSync(join(__dirname, "../../app/main/main.ts"), "utf8") as string;
    const hook = src.slice(src.indexOf("onTranscript: (entries, why) =>"), src.indexOf("onAccountChanged:"));
    expect(hook).toMatch(/if \(why !== "new-conversation"\) broadcast\(IPC\.conversationForgotten, null\);/);
    expect(hook).toMatch(/broadcast\(IPC\.conversationChanged, conversationNow\(entries\)\);/);
  });
});
