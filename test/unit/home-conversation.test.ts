/**
 * Home's conversation (app/renderer/home/conversation-view.ts) and main's Task activity push (app/main/push-later.ts):
 * the latest messages kept in place as main's 60-entry transcript drops its oldest, and a push at most every 500 ms
 * (review of PR #125).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONVERSATION_SHOWN, conversationAdded, conversationChange, conversationShown, earlierLabel, givenBackAbove, givenBackFollow, givenBackKept, givenBackOver, stillUnsent, type GivenBack } from "../../app/renderer/home/conversation-view";
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

  /** The words a Stop gave back above `request` being edited, as the field first holds them. */
  const givenAbove = (words: string[], request: string) => givenBackAbove(null, words, request ? `${words.join("\n\n")}\n\n${request}` : words.join("\n\n"));
  /** The field filled with `now` at once (selected and replaced, the caret after it). */
  const fill = (g: GivenBack, now: string) => givenBackFollow(g, now, now.length);
  /** `text` typed a key at a time over `from`–`to` (pressed Delete or Backspace for ""), the caret after each. */
  const type = (g: GivenBack, from: number, text: string, to = from) => {
    let x = givenBackFollow(g, g.field.slice(0, from) + g.field.slice(to), from);
    for (const [i, c] of [...text].entries()) x = givenBackFollow(x, x.field.slice(0, from + i) + c + x.field.slice(from + i), from + i + 1);
    return x;
  };
  const given = "Book the meeting room for Friday", edited = "Empty the trash";

  it("keeps the words a Stop gave back above my edit as I left them for Cancel edit, corrected or deleted (home-v5-1)", () => {
    const g = givenAbove([given], edited);
    expect(g).toEqual({ given: [given], ends: [given.length], field: `${given}\n\n${edited}` });
    expect(givenBackKept(g)).toEqual({ text: given, messages: 1, changed: false });
    // Corrected, Friday to Saturday, at once or a key at a time: Saturday is kept.
    expect(givenBackKept(fill(g, `Book the meeting room for Saturday\n\n${edited}`))).toEqual({ text: "Book the meeting room for Saturday", messages: 1, changed: true });
    expect(givenBackKept(type(g, 26, "Saturday", 32)).text).toBe("Book the meeting room for Saturday");
    expect(givenBackKept(type(g, 32, " at 10am")).text).toBe(`${given} at 10am`);
    expect(givenBackKept(type(g, 32, "\nand Sam")).text).toBe(`${given}\nand Sam`);
    // Deleted, as they changed their mind: nothing, with or without the blank line left behind.
    expect(givenBackKept(fill(g, edited))).toEqual({ text: "", messages: 0, changed: false });
    expect(givenBackKept(fill(g, `\n\n${edited}`)).text).toBe("");
    expect(givenBackKept(type(g, 0, "", given.length + 2)).text).toBe("");
    // Only the request changed: the words as they came, the request's changes cancelled.
    expect(givenBackKept(fill(g, `${given}\n\nEmpty the trash and the bin`))).toEqual({ text: given, messages: 1, changed: false });
    expect(givenBackKept(fill(g, given)).text).toBe(given);
    // Words that end as the request does are never cut short.
    expect(givenBackKept(givenAbove(["Say Yes"], "Yes")).text).toBe("Say Yes");
  });

  it("never keeps for Cancel edit words I typed into the request I was editing, in front of it or under an emptied one (home-w5-1)", () => {
    const g = givenAbove([given], "open Firefox");
    // In front of the request, on its own line: the request's, filled at once or typed.
    expect(givenBackKept(fill(g, `${given}\n\nPlease open Firefox`))).toEqual({ text: given, messages: 1, changed: false });
    expect(givenBackKept(type(g, given.length + 2, "Please ")).text).toBe(given);
    expect(givenBackKept(fill(givenAbove([given], edited), `${given}\n\nAlso ${edited}`)).text).toBe(given);
    // A paragraph above the request, under the blank line: the request's too.
    const lunch = givenAbove(["Order lunch"], edited);
    expect(givenBackKept(fill(lunch, `Order lunch\n\nActually, ignore that.\n\n${edited}`)).text).toBe("Order lunch");
    expect(givenBackKept(type(lunch, 11, "\n\nActually, ignore that.")).text).toBe("Order lunch");
    expect(givenBackKept(type(lunch, 13, "Actually, ignore that.\n\n")).text).toBe("Order lunch");
    // An edit emptied before the Stop, and a fresh request typed under the words: the request's.
    const emptied = givenAbove([given], "");
    expect(emptied.field).toBe(given);
    expect(givenBackKept(fill(emptied, `${given}\n\nDelete my downloads`))).toEqual({ text: given, messages: 1, changed: false });
    expect(givenBackKept(type(emptied, given.length, "\n\nDelete my downloads")).text).toBe(given);
    expect(givenBackKept(type(emptied, given.length, "\nDelete my downloads")).text).toBe(`${given}\nDelete my downloads`);
    // The words corrected as well: the correction kept, the request still not.
    expect(givenBackKept(fill(emptied, "Book the meeting room for Saturday\n\nDelete my downloads")).text).toBe("Book the meeting room for Saturday");
    expect(givenBackKept(type(emptied, given.length, " at 10am")).text).toBe(`${given} at 10am`);
  });

  it("keeps nothing of a message I deleted, however I went on editing the request, and counts only those left (home-w5-2)", () => {
    const g = givenAbove([given], "open Firefox");
    expect(givenBackKept(fill(g, "open Firefox and Files"))).toEqual({ text: "", messages: 0, changed: false });
    // A key at a time: the message and its blank line deleted, then the request changed, or a new one typed over all.
    expect(givenBackKept(type(type(g, 0, "", given.length + 2), "open Firefox".length, " and Files")).text).toBe("");
    expect(givenBackKept(type(g, 0, "Open Files", g.field.length)).text).toBe("");
    expect(givenBackKept(type(type(g, 0, "", given.length + 2), 0, "Please ")).text).toBe("");
    // Its words deleted but its line left: typed there, it is the message again.
    expect(givenBackKept(type(type(g, 0, "", given.length), 0, "Order lunch"))).toEqual({ text: "Order lunch", messages: 1, changed: true });
    // Two given back, one deleted: one is left, as it came or corrected.
    const two = givenAbove(["Order lunch", "Tell Sam I'm late"], edited);
    expect(givenBackKept(two)).toEqual({ text: "Order lunch\n\nTell Sam I'm late", messages: 2, changed: false });
    expect(givenBackKept(fill(two, `Order lunch\n\n${edited}`))).toEqual({ text: "Order lunch", messages: 1, changed: false });
    expect(givenBackKept(fill(two, `Tell Sam I'm late\n\n${edited}`))).toEqual({ text: "Tell Sam I'm late", messages: 1, changed: false });
    expect(givenBackKept(fill(two, `Order pizza\n\n${edited}`))).toEqual({ text: "Order pizza", messages: 1, changed: true });
    expect(givenBackKept(type(two, 11, "", 30))).toEqual({ text: "Order lunch", messages: 1, changed: false });
    // Given back by a second Stop, above those still there: all of them, in the field's order.
    const later = givenBackAbove(fill(two, `Order lunch\n\n${edited}`), ["Open Files"], `Open Files\n\nOrder lunch\n\n${edited}`);
    expect(givenBackKept(later)).toEqual({ text: "Open Files\n\nOrder lunch", messages: 2, changed: false });
  });

  it("keeps the words a Stop gave back above the request a second Edit puts there, as I left them and still given back (home-w5-3)", () => {
    const two = givenAbove(["Order lunch", "Tell Sam I'm late"], edited);
    const again = givenBackOver(two, "Open Files")!;
    expect(again).toEqual({ given: ["Order lunch", "Tell Sam I'm late"], ends: [11, 30], field: "Order lunch\n\nTell Sam I'm late\n\nOpen Files" });
    expect(givenBackKept(again)).toEqual({ text: "Order lunch\n\nTell Sam I'm late", messages: 2, changed: false });
    // What is typed into the new request is still its own; a change to the words, theirs.
    expect(givenBackKept(type(again, again.field.length, " and Files")).text).toBe("Order lunch\n\nTell Sam I'm late");
    expect(givenBackKept(type(again, 6, "pizza", 11))).toEqual({ text: "Order pizza\n\nTell Sam I'm late", messages: 2, changed: true });
    // One deleted before the second Edit, or both: only those left come along, and are counted.
    const one = givenBackOver(fill(two, `Tell Sam I'm late\n\n${edited}`), "Open Files")!;
    expect(one.field).toBe("Tell Sam I'm late\n\nOpen Files");
    expect(givenBackKept(one)).toEqual({ text: "Tell Sam I'm late", messages: 1, changed: false });
    expect(givenBackKept(givenBackOver(type(two, 0, "", 13), "Open Files")!)).toEqual({ text: "Tell Sam I'm late", messages: 1, changed: false });
    expect(givenBackOver(fill(two, edited), "Open Files")).toBeNull();
    // A later Stop gives more back above them: all of them, the request still under them.
    const later = givenBackAbove(again, ["Book the meeting room for Friday"], `${given}\n\n${again.field}`);
    expect(givenBackKept(later)).toEqual({ text: `${given}\n\nOrder lunch\n\nTell Sam I'm late`, messages: 3, changed: false });
    expect(later.field.slice(later.ends.at(-1)).trim()).toBe("Open Files");
  });

  it("never keeps the request I edited for Cancel edit where I changed both it and the words above it (home-w5-4)", () => {
    expect(givenBackKept(fill(givenAbove(["Order lunch"], edited), "Order lunch for two\n\nEmpty the bin"))).toEqual({ text: "Order lunch for two", messages: 1, changed: true });
    expect(givenBackKept(fill(givenAbove([given], edited), "Book it for Saturday\n\nEmpty the bin")).text).toBe("Book it for Saturday");
    const long = givenAbove(["b".repeat(1990)], edited);
    expect(givenBackKept(fill(long, `${"b".repeat(1989)}c\n\nEmpty the trash now`)).text).toBe(`${"b".repeat(1989)}c`);
    expect(givenBackKept(type(type(long, 1989, "c", 1990), long.field.length, " now")).text).toBe(`${"b".repeat(1989)}c`);
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
