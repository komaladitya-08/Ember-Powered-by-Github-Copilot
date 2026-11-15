import { describe, expect, it } from "vitest";
import { canariesIn } from "../fixtures/vault/leaky";
import { canariesInRuntimeFile, runtimeEventPayloads } from "../fixtures/vault/runtime-scan";

const collision = "ab8642cd-1234-4abc-8def-123456789abc";
const ordinary = "12345678-1234-4abc-8def-123456789abc";
const file = "copilot/session-state/ember-task-leak1/events.jsonl";
const event = (type = "assistant.message", data: Record<string, unknown> = {}) => ({
  type, data, id: collision, parentId: collision, timestamp: "2026-11-15T00:00:00.000Z",
});

describe("the vault's real-runtime event scan", () => {
  it("proves the short canary collides with a valid random UUID and excludes known event identities only", () => {
    const line = JSON.stringify(event("assistant.message", { messageId: collision, originatingMessageId: collision, interactionId: collision, content: "Ordinary reply" }));
    expect(canariesIn(line)).toEqual(["securityCode"]);
    expect(canariesInRuntimeFile(file, line)).toEqual([]);
    expect(runtimeEventPayloads(line)).toContain("Ordinary reply");
  });

  it("still detects the same UUID or actual code in every user, model, tool and unknown payload field", () => {
    for (const [type, data] of [
      ["user.message", { content: collision }], ["assistant.message", { content: collision }],
      ["system.message", { content: `Session folder ${collision}` }],
      ["tool.execution_start", { arguments: { id: collision, messageId: collision } }],
      ["tool.execution_complete", { result: { content: `code 8642`, id: collision } }],
      ["assistant.message", { content: "code 8642" }],
      ["assistant.message", { arbitraryId: collision }],
      ["session.start", { sessionId: collision }],
      ["session.shutdown", { accountingSnapshot: { id: collision } }],
    ] as const) expect(canariesInRuntimeFile(file, JSON.stringify(event(type, data))), type).toEqual(["securityCode"]);
  });

  it("does not exempt non-UUID identity values, unknown event types or envelope fields, or other files", () => {
    for (const value of [
      { ...event(), id: "code 8642" }, { ...event(), parentId: "8642" },
      event("assistant.message", { messageId: "8642" }), event("unknown.kind"),
      { ...event(), extra: collision }, { ...event(), timestamp: "unknown" },
      { ...event(), data: collision }, { ...event(), id: ordinary, parentId: undefined, data: { content: collision } },
    ]) expect(canariesInRuntimeFile(file, JSON.stringify(value))).toEqual(["securityCode"]);
    for (const other of ["logs/events.jsonl", "events.jsonl", "copilot/events.jsonl", "copilot/session-state/ember-task-leak1/other.json"]) {
      expect(canariesInRuntimeFile(other, JSON.stringify(event()))).toEqual(["securityCode"]);
    }
    expect(canariesInRuntimeFile(file, `not JSON ${collision}`)).toEqual(["securityCode"]);
  });
});
