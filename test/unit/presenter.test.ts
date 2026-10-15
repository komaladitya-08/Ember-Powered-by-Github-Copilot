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

  it("separates reasoning before and after a tool call", () => {
    const { p, last } = setup();
    p.userPrompt("what's on screen?");
    p.event({ type: "assistant.reasoning_delta", data: { deltaContent: "I'll look first." } });
    p.event({ type: "tool.execution_start", data: { toolName: "describe_screen" } });
    p.event({ type: "tool.execution_complete", data: { success: true } });
    p.event({ type: "assistant.reasoning_delta", data: { deltaContent: "Now I know." } });
    expect(last().bubble?.thought).toBe("I'll look first. Now I know.");
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
    p.event({ type: "session.error", data: { message: "Rate limited" } });
    expect(last()).toMatchObject({ emotion: "sad", bubble: { mood: "error", thought: "Rate limited" } });
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
