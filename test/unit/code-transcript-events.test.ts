/**
 * The transcript's coverage of the SDK's rarer events (docs/CODING-APP.md §8 "SDK coverage"): every event type of the
 * pinned SDK is drawn, kept as state, hidden on purpose or folded; cited sources, pictures from tool results and
 * binary assets (safe data URLs only), remedies the window can act on, a model call tried again, and the notes and
 * words for handoffs, context truncation, tasks, schedules and workflows. Shapes are the runtime's (probed on runtime
 * 1.0.97 where it emits them without an account: a view tool's image, history.truncate's rewind).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { CodeSdkEvent } from "../../app/shared/code";
import { eventNoteWords, picturesWithheld, remedyAction, remedyButton, retryingLine } from "../../app/renderer/code/copy-events";
import { noteWords } from "../../app/renderer/code/copy";
import { IMAGE_DATA_MAX, imageSrc, resultPictures } from "../../app/renderer/code/images";
import { REAL } from "../fixtures/code-window/real-shapes";
import { EMPTY_TRANSCRIPT, reduceEvent, type ImageItem, type Item, type NoteItem, type ToolItem, type Transcript } from "../../app/renderer/code/transcript";

let n = 0;
const ev = (type: string, data: unknown, extra: Partial<CodeSdkEvent> = {}): CodeSdkEvent => ({ id: `x${++n}`, timestamp: "2026-11-28T10:00:00Z", type, data, ...extra });
const play = (...events: CodeSdkEvent[]): Transcript => events.reduce(reduceEvent, EMPTY_TRANSCRIPT);
const only = <K extends Item["kind"]>(t: Transcript, kind: K) => t.items.filter((i): i is Extract<Item, { kind: K }> => i.kind === kind);

/** A 2×2 PNG, as the runtime's view tool returned one (`binaryResultsForLlm`). */
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFElEQVR4nGP4z8DAAMIM////ZwAAHu8E/KPItPcAAAAASUVORK5CYII=";

describe("pictures in a coding session", () => {
  it("draws a PNG, JPEG, GIF or WebP only from whole base64 that starts as that format does", () => {
    expect(imageSrc("image/png", PNG)).toBe(`data:image/png;base64,${PNG}`);
    expect(imageSrc("image/jpeg", PNG)).toBeNull();
    expect(imageSrc("image/svg+xml", PNG)).toBeNull();
    expect(imageSrc("image/png", `${PNG.slice(0, 40)}…`)).toBeNull();
    // The runtime's secret filter writes stars into base64 that holds a provider key's letters (probed).
    expect(imageSrc("image/png", PNG.replace("PIt", "PI******"))).toBeNull();
    expect(imageSrc("image/png", "A".repeat(IMAGE_DATA_MAX + 4))).toBeNull();
    expect(imageSrc("image/gif", btoa("GIF89a\x01\x00\x01\x00\x00\x00\x00;"))).toMatch(/^data:image\/gif;base64,/);
    expect(imageSrc("image/webp", btoa("RIFF\x10\x00\x00\x00WEBPVP8 abcd"))).toMatch(/^data:image\/webp;base64,/);
  });

  it("puts a tool result's image on its row, and says how many it couldn't show", () => {
    const result = { content: "Viewed image file successfully.", binaryResultsForLlm: [{ type: "image", data: PNG, mimeType: "image/png", description: "pic.png" }], contents: [{ type: "image", data: "bad", mimeType: "image/png" }] };
    expect(resultPictures(result)).toEqual({ shown: [{ src: `data:image/png;base64,${PNG}`, description: "pic.png" }], withheld: 1 });
    const t = play(ev("tool.execution_start", { toolCallId: "c1", toolName: "view", arguments: { path: "/w/pic.png" } }), ev("tool.execution_complete", { toolCallId: "c1", success: true, result }));
    const row = only(t, "tool")[0] as ToolItem;
    expect(row.pictures).toHaveLength(1);
    expect(row.picturesWithheld).toBe(1);
    expect(picturesWithheld(1)).toBe("One picture isn't shown: it's too large or not a kind Ember shows.");
  });

  it("shows a binary asset that is an image as a picture, and any other as a note", () => {
    const t = play(ev("session.binary_asset", { assetId: "a", byteLength: 70, data: PNG, mimeType: "image/png", type: "image", description: "A chart" }),
      ev("session.binary_asset", { assetId: "b", byteLength: 9, data: "AAAA", mimeType: "application/pdf", type: "resource", description: "report.pdf" }));
    expect((only(t, "image")[0] as ImageItem).picture).toEqual({ src: `data:image/png;base64,${PNG}`, description: "A chart" });
    expect(noteWords("asset", (only(t, "note")[0] as NoteItem).fields)).toBe("Copilot attached a file: report.pdf");
  });
});

describe("what the runtime really sent", () => {
  it("draws the view tool's real image result, and rebuilds after history.truncate's rewind", () => {
    const t = play(ev("tool.execution_start", { toolCallId: "call_2", toolName: "view", arguments: { path: "/tmp/p/work/pic.png" } }), ev("tool.execution_complete", REAL.viewImageComplete));
    expect((only(t, "tool")[0] as ToolItem).pictures?.[0].src).toBe(`data:image/png;base64,${PNG}`);
    const cut = reduceEvent(t, ev(REAL.truncateRewind.type, REAL.truncateRewind.data));
    expect(cut.rebuild).toBe(true);
  });
});

describe("a reply's sources and a model call tried again", () => {
  it("keeps the sources a reply cites (enableCitations), by title, address or file", () => {
    const t = play(ev("assistant.message", { messageId: "m", content: "See the docs.", citations: { sources: [{ id: "1", provider: "web", title: "Docs", url: "https://example.com/d" }, { id: "2", provider: "file", path: "/w/a.ts" }, { id: "3", provider: "x" }], spans: [] } }));
    expect(only(t, "assistant")[0].sources).toEqual([{ title: "Docs", url: "https://example.com/d" }, { title: "/w/a.ts", path: "/w/a.ts" }]);
  });

  it("says the model is being tried again until the reply comes", () => {
    let t = play(ev("assistant.turn_start", { turnId: "0" }), ev("model.call_failure", { source: "main", retryAttempt: 2, model: "m" }));
    expect(t.retrying).toEqual({ attempt: 2, model: "m" });
    expect(retryingLine(2)).toBe("Copilot is trying the model again (try 2)…");
    t = reduceEvent(t, ev("assistant.message", { messageId: "r", content: "Here." }));
    expect(t.retrying).toBeUndefined();
    expect(play(ev("model.call_failure", { source: "main" })).retrying).toBeUndefined();
  });
});

describe("remedies the window can act on", () => {
  it("offers sign-in, the sandbox or rewind points for the remedy the SDK names, and nothing it can't do", () => {
    expect(["sign_in", "switch_account", "show_account", "review_sandbox_policy", "allow_sandbox_outbound", "rewind_conversation", "made_up", undefined].map(remedyAction))
      .toEqual(["sign-in", "sign-in", "sign-in", "sandbox", "sandbox", "rewind", null, null]);
    expect(remedyButton("sign-in")).toBe("Open sign-in…");
    expect(remedyButton("rewind")).toBe("Show rewind points");
  });
});

describe("the rarer session events, as notes", () => {
  const note = (e: CodeSdkEvent) => { const t = play(e); const i = only(t, "note")[0] as NoteItem | undefined; return i ? noteWords(i.note, i.fields) : null; };
  it("words each in Ember's sentences", () => {
    expect(note(ev("session.handoff", { handoffTime: "t", sourceType: "cloud", repository: { owner: "acme", name: "app" }, summary: "Fixed the build." }))).toBe("Continued from a cloud session of acme/app. Fixed the build.");
    expect(note(ev("session.truncation", { messagesRemovedDuringTruncation: 4, tokensRemovedDuringTruncation: 10, performedBy: "x", postTruncationMessagesLength: 1, postTruncationTokensInMessages: 1, preTruncationMessagesLength: 5, preTruncationTokensInMessages: 11, tokenLimit: 9 })))
      .toBe("To make room, Copilot no longer sends the model the 4 earliest messages. They stay here.");
    expect(note(ev("session.context_cleared", { messagesCleared: 12 }))).toBe("Copilot cleared its context (12 messages) and started afresh.");
    expect(note(ev("session.task_complete", { success: true, summary: "Tests pass." }))).toBe("Copilot finished the task. Tests pass.");
    expect(note(ev("session.task_complete", { outcome: "blocked", reason: "It needs a key." }))).toBe("Copilot couldn't finish the task: It needs a key.");
    expect(note(ev("tool_search.activated", { strategy: "s", toolNames: ["a", "b"] }))).toBe("Copilot looked up 2 more tools it can use.");
    expect(note(ev("session.schedule_created", { id: 1, prompt: "check CI", recurring: true }))).toBe("Copilot scheduled a message to repeat: “check CI”");
    expect(note(ev("session.schedule_cancelled", { id: 1 }))).toBe("A scheduled message was cancelled.");
    expect(note(ev("session.schedule_rearmed", { id: 1, nextRunAt: 2 }))).toBeNull();
    expect(note(ev("session.session_limits_changed", { sessionLimits: { maxAiCredits: 300 } }))).toBe("This session may now use up to 300 AI credits.");
    expect(note(ev("session.session_limits_changed", { sessionLimits: null }))).toBe("This session's credit limit was removed.");
    expect(note(ev("session.mcp_server_needs_reconnect", { serverName: "docs" }))).toBe("The MCP server “docs” needs to start again. Start it in Customise › MCP servers.");
    expect(note(ev("session.model_deselected", { previousModel: "byok/m", reason: "provider_withdrawn" }))).toBe("The model byok/m isn't available any more. Choose another.");
    expect(note(ev("session.auto_tier_switch_failed", { reason: "policy_rejected", requestedAutoTier: "fast" }))).toBe("Copilot couldn't change how it picks a model. It keeps the one it had.");
    expect(eventNoteWords("nothing", {})).toBe("");
  });

  it("follows a workflow run from its start to how it settled", () => {
    const t = play(ev("workflow.run_started", { attempt: 1, runId: "r1", workflowName: "release" }), ev("workflow.run_settled", { runId: "r1", status: "failed", consumedNanoAiu: 0, consumedSubagents: 0, elapsedMs: 5 }));
    const notes = only(t, "note");
    expect(notes).toHaveLength(1);
    expect(noteWords(notes[0].note, notes[0].fields)).toBe("The workflow “release” didn't finish.");
    expect(noteWords("workflow", { name: "release", state: "running" })).toBe("Running the workflow “release”…");
  });
});

describe("every event type of the pinned SDK", () => {
  /** The `type` literals of the SDK's SessionEvent union, read from its generated types. */
  function sdkEventTypes(): string[] {
    const file = path.join(process.cwd(), "node_modules", "@github", "copilot-sdk", "dist", "generated", "session-events.d.ts");
    const text = fs.readFileSync(file, "utf8");
    return [...new Set([...text.matchAll(/^\s*type: "([a-z_]+(?:\.[a-z_]+)+)";/gm)].map(m => m[1]))];
  }
  it("is drawn, kept as state, hidden on purpose or folded, and never throws (docs/CODING-APP.md §8)", () => {
    const types = sdkEventTypes();
    expect(types.length).toBeGreaterThan(130);
    const source = fs.readFileSync(path.join(process.cwd(), "app", "renderer", "code", "transcript.ts"), "utf8");
    const named = types.filter(t => source.includes(`"${t}"`));
    // Folded on purpose: the generic row with its type and data (a custom notification is an extension's own).
    const folded = types.filter(t => !named.includes(t));
    expect(folded.filter(t => !t.startsWith("model.")).sort()).toEqual(["session.custom_notification"]);
    for (const type of types) expect(() => play(ev(type, {}), ev(type, { requestId: "q", toolCallId: "c" }))).not.toThrow();
  });
});
