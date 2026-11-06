/** The answer row Home shows while Ember writes it (app/renderer/home/conversation-stream.ts), and the wiring to it. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NO_STREAM, streamEntries, streamEvent, type StreamEvent, type StreamState } from "../../app/renderer/home/conversation-stream";
import type { Said } from "../../app/renderer/home/conversation-view";

const said = (who: string, text: string, n = 0): Said => ({ t: `2026-11-06T10:0${n}:00.000Z`, who, text });
const ev = (id: number, text: string, state: StreamEvent["state"] = "streaming"): StreamEvent => ({ id, text, state });
const NOW = "2026-11-06T10:05:00.000Z";

const mine = (id: number, who: string, text: string, n = 0, stopped = false): Said => ({ ...said(who, text, n), answerId: id, ...(stopped ? { stopped: true as const } : {}) });

describe("Home's streaming answer row", () => {
  it("creates one row on the first words and updates the same row as they come", () => {
    const entries = [said("you", "Hi")];
    let s: StreamState = streamEvent(NO_STREAM, ev(1, "Hel"), entries, NOW);
    expect(s.row).toMatchObject({ id: 1, text: "Hel", phase: "streaming" });
    s = streamEvent(s, ev(1, "Hello there"), entries, "later");
    expect(s.row).toMatchObject({ id: 1, text: "Hello there", t: NOW });
  });

  it("settles on the entry that holds this answer, then ignores its late words (completion)", () => {
    const entries = [said("you", "Hi")];
    let s = streamEvent(NO_STREAM, ev(1, "Hello there"), entries, NOW);
    const after = [...entries, mine(1, "ember", "Hello there!", 1)];
    s = streamEntries(s, after);
    expect(s.row).toBeNull();
    s = streamEvent(s, ev(1, "Hello there!", "done"), after, NOW);
    s = streamEvent(s, ev(1, "Hello there! More"), after, NOW);
    expect(s.row).toBeNull();
  });

  it("settles on done when the answer has no entry (answer-id contract)", () => {
    const s = streamEvent(NO_STREAM, ev(1, "Hello"), [], NOW);
    expect(streamEvent(s, ev(1, "Hello", "done"), [], NOW).row).toBeNull();
  });

  it("an unrelated ember entry (a reminder, a note) never settles the row, in either order (B2)", () => {
    const entries = [said("you", "Hi")];
    let s = streamEvent(NO_STREAM, ev(3, "Working on"), entries, NOW);
    const reminder = [...entries, said("ember", "Reminder: stretch", 1)];
    s = streamEntries(s, reminder);
    expect(s.row).toMatchObject({ id: 3, text: "Working on" });
    s = streamEvent(s, ev(3, "Working on it"), reminder, NOW);
    expect(s.row?.text).toBe("Working on it");
    // The reminder arriving before the first word is the same.
    const before = streamEvent(NO_STREAM, ev(3, "Working"), reminder, NOW);
    expect(streamEntries(before, reminder).row).toMatchObject({ id: 3 });
    expect(streamEntries(s, [...reminder, mine(3, "ember", "Working on it.", 2)]).row).toBeNull();
  });

  it("a delayed snapshot holding an earlier answer neither settles nor blocks this row (B2)", () => {
    const earlier = [said("you", "Before"), mine(1, "ember", "An older answer", 1)];
    // After the first word...
    let s = streamEvent(NO_STREAM, ev(2, "Fresh"), [said("you", "Before")], NOW);
    s = streamEntries(s, earlier);
    expect(s.row).toMatchObject({ id: 2, text: "Fresh" });
    expect(streamEvent(s, ev(2, "Fresh words"), earlier, NOW).row?.text).toBe("Fresh words");
    // ...and before it.
    const first = streamEvent(NO_STREAM, ev(2, "Fresh"), earlier, NOW);
    expect(first.row).toMatchObject({ id: 2 });
  });

  it("an interrupted answer waits for its stopped entry, then is that one row", () => {
    const entries = [said("you", "Hi")];
    let s = streamEvent(NO_STREAM, ev(2, "Half an ans"), entries, NOW);
    s = streamEvent(s, ev(2, "Half an ans", "interrupted"), entries, NOW);
    expect(s.row).toMatchObject({ id: 2, text: "Half an ans", phase: "interrupted" });
    expect(streamEntries(s, [...entries]).row?.phase).toBe("interrupted");
    expect(streamEntries(s, [...entries, said("ember", "Half an ans", 1)]).row?.phase).toBe("interrupted");
    expect(streamEntries(s, [...entries, mine(2, "ember", "Half an ans", 1, true)]).row).toBeNull();
  });

  it("settles when the stopped entry arrived before the interrupted event", () => {
    const entries = [said("you", "Hi"), mine(2, "ember", "Half an ans", 1, true)];
    let s = streamEvent(NO_STREAM, ev(2, "Half an ans"), entries.slice(0, 1), NOW);
    s = streamEntries(s, entries);
    expect(s.row).toBeNull();
    expect(streamEvent(s, ev(2, "Half an ans", "interrupted"), entries, NOW).row).toBeNull();
  });

  it("at the retention limit the stopped entry still settles the row, once, and a replay adds nothing (B3)", () => {
    // 59 older messages then the stopped one: 60 kept, the first of 61 trimmed; nothing about positions matters.
    const old = Array.from({ length: 59 }, (_, i) => said(i % 2 ? "ember" : "you", `m${i}`, 0));
    const full = [...old, mine(7, "ember", "Half an ans", 1, true)];
    expect(full).toHaveLength(60);
    let s = streamEvent(NO_STREAM, ev(7, "Half an ans"), old, NOW);
    s = streamEvent(s, ev(7, "Half an ans", "interrupted"), old, NOW);
    expect(s.row?.phase).toBe("interrupted");
    s = streamEntries(s, full);
    expect(s.row).toBeNull();
    expect(streamEntries(s, full)).toEqual(s);
    // The error case: the problem line trims the front again, the stopped entry is still there.
    const withProblem = [...full.slice(1), said("problem", "Couldn’t finish", 2)];
    expect(streamEntries(streamEvent(NO_STREAM, ev(7, "Half an ans", "interrupted"), withProblem, NOW), withProblem).row).toBeNull();
  });

  it("a replay of a transcript holding a stopped entry makes no streaming row", () => {
    const entries = [said("you", "Hi"), mine(2, "ember", "Half an ans", 1, true), said("problem", "Couldn’t finish", 2)];
    const s = streamEntries(NO_STREAM, entries);
    expect(s.row).toBeNull();
    expect(streamEntries(s, entries)).toEqual(s);
  });

  it("an interrupted event reaching a reopened Home after the snapshot adds no second row", () => {
    const entries = [said("you", "Hi"), mine(2, "ember", "Half an ans", 1, true)];
    expect(streamEvent(NO_STREAM, ev(2, "Half an ans", "interrupted"), entries, NOW).row).toBeNull();
  });

  it("drops nothing but blank interrupted answers", () => {
    const s = streamEvent(NO_STREAM, ev(4, "  ", "interrupted"), [], NOW);
    expect(s.row).toBeNull();
  });

  it("restored entries carry no id, so none of them settles a new stream that starts again at id 1 (history)", () => {
    // After a restart main numbers streams from 1 again; the saved lines (even a stopped one) have no answerId.
    const restored: Said[] = [
      said("you", "Before", 0), said("ember", "An older answer", 1),
      { ...said("ember", "Cut short", 2), stopped: true }, said("problem", "Couldn’t finish", 3),
    ];
    let s = streamEvent(NO_STREAM, ev(1, "Fresh"), restored, NOW);
    expect(s.row).toMatchObject({ id: 1, text: "Fresh", phase: "streaming" });
    s = streamEntries(s, restored);
    expect(s.row).toMatchObject({ id: 1 });
    // Not by an interrupted event either: the restored stopped line is no entry of this answer.
    const cut = streamEvent(s, ev(1, "Fresh words", "interrupted"), restored, NOW);
    expect(cut.row).toMatchObject({ id: 1, phase: "interrupted" });
    // It settles on its own entry only, with the restored ones still above it.
    const own = [...restored, mine(1, "ember", "Fresh words", 4)];
    expect(streamEntries(s, own).row).toBeNull();
    expect(streamEntries(cut, [...restored, mine(1, "ember", "Fresh words", 4, true)]).row).toBeNull();
  });

  it("clears the row when the conversation is emptied, and ignores that answer's late words", () => {
    let s = streamEvent(NO_STREAM, ev(5, "Some words"), [said("you", "Hi")], NOW);
    s = streamEntries(s, []);
    expect(s.row).toBeNull();
    s = streamEvent(s, ev(5, "Some words and more"), [], NOW);
    expect(s.row).toBeNull();
    expect(streamEvent(s, ev(6, "Fresh"), [], NOW).row).toMatchObject({ id: 6, text: "Fresh" });
  });

  it("is wired in: Home draws it as one aria-busy row, main broadcasts it on a channel only Home's preload exposes", () => {
    const main = readFileSync(join(__dirname, "../../app/main/main.ts"), "utf8");
    expect(main).toMatch(/onAnswerStream: e => broadcast\(IPC\.conversationStream, e\)/);
    expect(readFileSync(join(__dirname, "../../app/preload/home.ts"), "utf8")).toMatch(/IPC\.conversationStream/);
    for (const p of ["ask", "overlay", "handle", "mic", "desk", "command", "prompt"]) {
      expect(readFileSync(join(__dirname, `../../app/preload/${p}.ts`), "utf8")).not.toMatch(/conversationStream/);
    }
  });
});
