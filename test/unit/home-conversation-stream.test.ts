/** The answer row Home shows while Ember writes it (app/renderer/home/conversation-stream.ts), and the wiring to it. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NO_STREAM, streamEntries, streamEvent, type StreamEvent, type StreamState } from "../../app/renderer/home/conversation-stream";
import type { Said } from "../../app/renderer/home/conversation-view";

const said = (who: string, text: string, n = 0): Said => ({ t: `2026-11-06T10:0${n}:00.000Z`, who, text });
const ev = (id: number, text: string, state: StreamEvent["state"] = "streaming"): StreamEvent => ({ id, text, state });
const NOW = "2026-11-06T10:05:00.000Z";

describe("Home's streaming answer row", () => {
  it("creates one row on the first words and updates the same row as they come", () => {
    const entries = [said("you", "Hi")];
    let s: StreamState = streamEvent(NO_STREAM, ev(1, "Hel"), entries, NOW);
    const first = s.row;
    expect(first).toMatchObject({ id: 1, text: "Hel", phase: "streaming", base: 1 });
    s = streamEvent(s, ev(1, "Hello there"), entries, "later");
    expect(s.row).toMatchObject({ id: 1, text: "Hello there", t: NOW, base: 1 });
  });

  it("settles on the finished answer without keeping a second row (completion)", () => {
    const entries = [said("you", "Hi")];
    let s = streamEvent(NO_STREAM, ev(1, "Hello there"), entries, NOW);
    const after = [...entries, said("ember", "Hello there!", 1)];
    s = streamEntries(s, after);
    expect(s.row).toBeNull();
    // The "done" that follows changes nothing, and a late word of that answer is ignored.
    s = streamEvent(s, ev(1, "Hello there!", "done"), after, NOW);
    s = streamEvent(s, ev(1, "Hello there! More"), after, NOW);
    expect(s.row).toBeNull();
  });

  it("settles on done when the finished answer reached the transcript first or not at all", () => {
    const s = streamEvent(NO_STREAM, ev(1, "Hello"), [], NOW);
    expect(streamEvent(s, ev(1, "Hello", "done"), [], NOW).row).toBeNull();
  });

  it("an interrupted answer waits for the transcript's stopped entry, then is that one row", () => {
    const entries = [said("you", "Hi")];
    let s = streamEvent(NO_STREAM, ev(2, "Half an ans"), entries, NOW);
    s = streamEvent(s, ev(2, "Half an ans", "interrupted"), entries, NOW);
    expect(s.row).toMatchObject({ id: 2, text: "Half an ans", phase: "interrupted" });
    // The same transcript again changes nothing; the stopped entry settles the row, once.
    expect(streamEntries(s, [...entries]).row?.phase).toBe("interrupted");
    const committed = [...entries, { ...said("ember", "Half an ans", 1), stopped: true as const }];
    expect(streamEntries(s, committed).row).toBeNull();
    expect(Object.keys(streamEntries(s, committed))).not.toContain("kept");
  });

  it("settles when the stopped entry arrived before the interrupted event", () => {
    const entries = [said("you", "Hi"), { ...said("ember", "Half an ans", 1), stopped: true as const }];
    let s = streamEvent(NO_STREAM, ev(2, "Half an ans"), entries.slice(0, 1), NOW);
    s = streamEntries(s, entries);
    expect(s.row).toBeNull();
    expect(streamEvent(s, ev(2, "Half an ans", "interrupted"), entries, NOW).row).toBeNull();
  });

  it("a replay of a transcript holding a stopped entry makes no streaming row (one row with its note)", () => {
    const entries = [said("you", "Hi"), { ...said("ember", "Half an ans", 1), stopped: true as const }, said("problem", "Couldn’t finish", 2)];
    const s = streamEntries(NO_STREAM, entries);
    expect(s.row).toBeNull();
    expect(streamEntries(s, entries)).toEqual(s);
  });

  it("an interrupted event reaching a reopened Home after the snapshot adds no second row", () => {
    const entries = [said("you", "Hi"), { ...said("ember", "Half an ans", 1), stopped: true as const }];
    expect(streamEvent(NO_STREAM, ev(2, "Half an ans", "interrupted"), entries, NOW).row).toBeNull();
  });

  it("drops nothing but blank interrupted answers", () => {
    const s = streamEvent(NO_STREAM, ev(4, "  ", "interrupted"), [], NOW);
    expect(s.row).toBeNull();
  });

  it("clears the row when the conversation is emptied, and ignores that answer's late words", () => {
    let s = streamEvent(NO_STREAM, ev(5, "Some words"), [said("you", "Hi")], NOW);
    s = streamEntries(s, []);
    expect(s.row).toBeNull();
    s = streamEvent(s, ev(5, "Some words and more"), [], NOW);
    expect(s.row).toBeNull();
    // The next answer is a new id and shows.
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
