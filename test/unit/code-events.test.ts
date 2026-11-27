/**
 * The coding window's events on their way out of main (app/main/code/events.ts): redacted (the vault's values, GitHub
 * tokens), bounded to CODE_LIMITS.eventData and marked when cut, and numbered per session so a window can catch up
 * from its last seq, or gets the whole history when this run no longer holds what it missed.
 */

import { describe, expect, it } from "vitest";
import { CODE_LIMITS, type CodeSdkEvent } from "../../app/shared/code";
import { EventLog, boundData, boundEvent, eventRedactor } from "../../app/main/code/events";
import type { ModelRedactor } from "../../app/main/agent/redacting-client";

const canary = "VAULTCANARY-77d1e0";
const vault: ModelRedactor = {
  active: true,
  holds: t => JSON.stringify(t ?? "").includes(canary),
  text: s => s.split(canary).join("[vault]"),
  deep: <T>(v: T) => JSON.parse(JSON.stringify(v).split(canary).join("[vault]")) as T,
};
const ev = (id: string, type = "assistant.message", data: unknown = {}, ephemeral = false): CodeSdkEvent => ({ id, timestamp: "2026-11-27T00:00:00Z", type, data, ...(ephemeral ? { ephemeral: true } : {}) });

describe("an event on its way to a coding window", () => {
  it("never carries a value the vault filled or a GitHub token, in any string or key", () => {
    const token = "gho_" + "a".repeat(36);
    const out = boundEvent({ id: "1", timestamp: "t", type: "tool.execution_complete", data: { result: { content: `pasted ${canary} and ${token}` }, [canary]: 1 } }, eventRedactor(vault));
    const text = JSON.stringify(out);
    expect(text).not.toContain(canary);
    expect(text).not.toContain(token);
    expect(text).toContain("[vault]");
    expect(out.truncated).toBeUndefined();
  });

  it("keeps the SDK's envelope (id, parent, type, agent, ephemeral) and its data as they are when they fit", () => {
    const out = boundEvent({ id: "e1", parentId: null, timestamp: "t", type: "assistant.message_delta", data: { deltaContent: "hi", n: 3, ok: true }, agentId: "sub-1", ephemeral: true }, eventRedactor());
    expect(out).toEqual({ id: "e1", parentId: null, timestamp: "t", type: "assistant.message_delta", data: { deltaContent: "hi", n: 3, ok: true }, agentId: "sub-1", ephemeral: true });
  });

  it("cuts long strings until the data fits the limit, ending each cut one with an ellipsis and marking the event", () => {
    const big = "x".repeat(CODE_LIMITS.eventData * 2);
    const out = boundEvent({ id: "1", timestamp: "t", type: "tool.execution_complete", data: { result: { content: big }, small: "kept" } }, eventRedactor());
    expect(out.truncated).toBe(true);
    const data = out.data as { result: { content: string }; small: string };
    expect(data.small).toBe("kept");
    expect(data.result.content.endsWith("…")).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(out.data))).toBeLessThanOrEqual(CODE_LIMITS.eventData);
  });

  it("drops data that can't be made to fit whole, and says it was cut", () => {
    const many = Array.from({ length: 10_000 }, (_, i) => ({ i, s: "y".repeat(300) }));
    expect(boundData(many, eventRedactor(), 4_000)).toEqual({ data: {}, truncated: true });
  });
});

describe("a session's numbered events", () => {
  it("counts up by one per event, and an event seen again (from history or a resume) keeps its seq and isn't sent twice", () => {
    const log = new EventLog("s");
    expect(log.add(ev("a"))?.seq).toBe(1);
    expect(log.add(ev("b"))?.seq).toBe(2);
    expect(log.add(ev("a"))).toBeNull();
    expect(log.seq).toBe(2);
    expect(log.seqOf("b")).toBe(2);
  });

  it("returns only what followed a window's last seq, and nothing when it has everything", () => {
    const log = new EventLog("s");
    for (const id of ["a", "b", "c", "d"]) log.add(ev(id));
    expect(log.since(2)!.map(e => e.seq)).toEqual([3, 4]);
    expect(log.since(4)).toEqual([]);
    expect(log.since(0)!.length).toBe(4);
  });

  it("says it no longer holds what a window missed once the ring has moved past it, or for a seq from another run", () => {
    const log = new EventLog("s", 3);
    for (const id of ["a", "b", "c", "d", "e"]) log.add(ev(id));
    expect(log.since(1)).toBeNull();
    expect(log.since(2)!.map(e => e.seq)).toEqual([3, 4, 5]);
    expect(log.since(9)).toBeNull();
    expect(log.since(-1)).toBeNull();
    expect(log.whole).toBe(false);
  });

  it("gives a history read from the SDK's log its numbers, numbering what it never saw and sending it, with ephemeral events in their places", () => {
    const log = new EventLog("s");
    log.add(ev("a", "user.message"));
    log.add(ev("d1", "assistant.message_delta", {}, true));
    log.add(ev("b", "assistant.message"));
    const fresh: string[] = [];
    const history = log.history([ev("a", "user.message"), ev("b", "assistant.message"), ev("c", "assistant.turn_end")], e => fresh.push(e.id));
    expect(history.map(e => [e.seq, e.event.id])).toEqual([[1, "a"], [2, "d1"], [3, "b"], [4, "c"]]);
    expect(fresh).toEqual(["c"]);
    expect(log.seq).toBe(4);
  });
});
