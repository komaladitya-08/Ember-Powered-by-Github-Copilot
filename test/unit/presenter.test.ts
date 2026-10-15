import { describe, it, expect, vi } from "vitest";
import { Presenter } from "../../app/main/agent/presenter";
import type { EmberState } from "../../app/shared/overlay";

function setup() {
  const states: Partial<EmberState>[] = [];
  vi.useFakeTimers();
  const p = new Presenter(s => states.push(s));
  const last = () => states[states.length - 1];
  return { p, states, last };
}

describe("Presenter", () => {
  it("thinks, streams reasoning, then answers and goes quiet", () => {
    const { p, states, last } = setup();
    p.userPrompt("what's the time?");
    expect(last()).toMatchObject({ emotion: "thinking", bubble: { mood: "thinking", visible: true } });
    p.event({ type: "assistant.intent", data: { intent: "Checking the clock" } });
    expect(last().bubble?.title).toBe("Checking the clock");
    p.event({ type: "assistant.reasoning_delta", data: { deltaContent: "The user wants " } });
    p.event({ type: "assistant.reasoning_delta", data: { deltaContent: "the time." } });
    expect(last().bubble?.thought).toBe("The user wants the time.");
    p.event({ type: "assistant.message_delta", data: { deltaContent: "It's " } });
    p.event({ type: "assistant.message_delta", data: { deltaContent: "half past two." } });
    expect(last()).toMatchObject({ emotion: "happy", talking: true, bubble: { title: "Ember", thought: "It's half past two." } });
    p.event({ type: "assistant.message", data: {} });
    p.event({ type: "session.idle", data: {} });
    expect(last()).toMatchObject({ talking: false, bubble: { streaming: false } });
    vi.advanceTimersByTime(25000);
    expect(last()).toMatchObject({ emotion: "neutral", bubble: { visible: false } });
    expect(states.length).toBeGreaterThan(6);
  });

  it("starts a new thought after a tool call (no run-on reasoning)", () => {
    const { p, last } = setup();
    p.userPrompt("what's on screen?");
    p.event({ type: "assistant.reasoning_delta", data: { deltaContent: "I'll look first." } });
    p.event({ type: "tool.execution_start", data: { toolName: "describe_screen" } });
    p.event({ type: "tool.execution_complete", data: { success: true } });
    p.event({ type: "assistant.reasoning_delta", data: { deltaContent: "Now I know." } });
    expect(last().bubble?.thought).toBe("Now I know.");
  });

  it("shows a finished long answer from its start", () => {
    const { p, last } = setup();
    p.userPrompt("tell me everything");
    const long = "Start. " + "word ".repeat(200) + "End.";
    p.event({ type: "assistant.message_delta", data: { deltaContent: long } });
    expect(last().bubble?.thought.startsWith("Start.")).toBe(false);
    p.event({ type: "assistant.message", data: {} });
    expect(last().bubble?.thought.startsWith("Start.")).toBe(true);
    expect(last().bubble?.thought.endsWith("…")).toBe(true);
  });

  it("shows the current tool as a step and looks focused", () => {
    const { p, last } = setup();
    p.userPrompt("be glint");
    p.event({ type: "tool.execution_start", data: { toolName: "set_appearance" } });
    expect(last()).toMatchObject({ emotion: "focused", bubble: { mood: "acting", step: "Changing how I look" } });
    p.event({ type: "tool.execution_complete", data: { success: false } });
    expect(last()).toMatchObject({ emotion: "confused", bubble: { step: null } });
  });

  it("is sorry on errors and calm when stopped", () => {
    const { p, last } = setup();
    p.userPrompt("x");
    p.event({ type: "session.error", data: { message: "CAPIError: 429 Rate limited {\"error\":{}}" } });
    expect(last()).toMatchObject({ emotion: "sad", bubble: { mood: "error", thought: "Copilot's usage limit was reached for now. Try again a bit later." } });
    p.userPrompt("y");
    p.event({ type: "session.idle", data: { aborted: true } });
    expect(last()).toMatchObject({ emotion: "neutral", bubble: { title: "Stopped" } });
  });
});

describe("Presenter gestures and guiding", () => {
  it("plays a gesture for each kind of tool", () => {
    const { p, last } = setup();
    p.event({ type: "tool.execution_start", data: { toolName: "type_text" } });
    expect(last().gesture).toBe("type");
    p.event({ type: "tool.execution_start", data: { toolName: "perceive_window" } });
    expect(last().gesture).toBe("chin");
    p.event({ type: "tool.execution_complete", data: { success: false } });
    expect(last().gesture).toBe("scratch");
  });

  it("shows a guide step with its instruction and points", () => {
    const { p, last } = setup();
    p.guide("Click Display", "Step 2");
    expect(last()).toMatchObject({ gesture: "point", talking: true, bubble: { mood: "guiding", thought: "Click Display", step: "Step 2", visible: true } });
  });
});

describe("Presenter across turns and presenters (review fixes)", () => {
  it("a queued second question starts its own answer (no glued answers)", () => {
    const { p, last } = setup();
    p.userPrompt("first");
    p.event({ type: "assistant.message_delta", data: { deltaContent: "First answer." } });
    p.event({ type: "assistant.message", data: {} });
    // The second prompt was queued while the first streamed: the runtime starts its turn without a new userPrompt().
    p.event({ type: "user.message", data: {} });
    p.event({ type: "assistant.message_delta", data: { deltaContent: "Second answer." } });
    expect(last().bubble?.thought).toBe("Second answer.");
  });

  it("the conversation's hide timer leaves a later guide step alone", () => {
    vi.useFakeTimers();
    const states: Partial<EmberState>[] = [];
    const owner = { current: null };
    const conductor = new Presenter(s => states.push(s), undefined, () => "Ember", owner);
    const guide = new Presenter(s => states.push(s), undefined, () => "Save it", owner);
    conductor.userPrompt("show me how to save");
    conductor.event({ type: "assistant.message_delta", data: { deltaContent: "Follow me!" } });
    conductor.event({ type: "assistant.message", data: {} });
    conductor.event({ type: "session.idle", data: {} });
    guide.guide("Click Save", "Step 1");
    vi.advanceTimersByTime(60_000);
    expect(states.some(s => s.bubble?.visible === false)).toBe(false);
  });

  it("long answers are plain text and offer Read all; the full text is handed over", () => {
    vi.useFakeTimers();
    const states: Partial<EmberState>[] = [];
    let full = "";
    const p = new Presenter(s => states.push(s), undefined, () => "Ember", { current: null }, t => { full = t; });
    p.userPrompt("explain");
    const long = "**Bold** start. " + "word ".repeat(80) + "`code` end.";
    p.event({ type: "assistant.message_delta", data: { deltaContent: long } });
    p.event({ type: "assistant.message", data: {} });
    const b = states[states.length - 1].bubble!;
    expect(b.thought.startsWith("Bold start.")).toBe(true);
    expect(b.actions).toEqual([{ id: "ui:more", label: "Read all" }]);
    expect(full.endsWith("code end.")).toBe(true);
  });

  it("reset() after a restart mid-turn leaves nothing stuck on Thinking", () => {
    const { p, last } = setup();
    p.userPrompt("hello");
    p.reset();
    expect(last()).toMatchObject({ emotion: "neutral", bubble: { visible: false } });
  });
});

describe("friendlyError", () => {
  it("turns SDK and HTTP errors into one plain sentence", async () => {
    const { friendlyError } = await import("../../app/main/agent/presenter");
    expect(friendlyError("CAPIError: 400 {\"error\":{\"code\":\"model_not_supported\"}}")).toMatch(/model I'm set to use/);
    expect(friendlyError("Request failed: 401 Unauthorized")).toMatch(/sign-in/);
    expect(friendlyError("Connection is disposed.")).toMatch(/can't reach Copilot/);
    expect(friendlyError("ECONNREFUSED 127.0.0.1:54013")).toMatch(/can't reach Copilot/);
    expect(friendlyError("Something odd {\"x\":1}")).toBe("Copilot reported a problem: Something odd");
  });
});
