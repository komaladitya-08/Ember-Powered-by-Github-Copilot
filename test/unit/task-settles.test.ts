/**
 * Every way a task can end leaves Ember at rest (the owner's report of 2026-11-03: "close Microsoft Edge" was asked,
 * allowed and done, yet the bubble kept "Working · Thanks! Carrying on.", the handle kept the task's name and the
 * presence ring kept its busy pulse). The shared bubble, the conversation's and the task's presenters, the Confirmer and
 * main's state sink are wired as main and AgentHost wire them (guardWhileAsking, the Confirmer's afterAnswer through
 * answerSettler, BubbleOwner's question hook, hidesAgainAfter); a task that does the work is cornered, as in the app. After each end
 * the bubble is empty or shows the result, the ring isn't busy, Ember's face rests and the handle's line is "Ready".
 */

import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BubbleOwner, Presenter } from "../../app/main/agent/presenter";
import { Confirmer, answerSettler, guardWhileAsking, hidesAgainAfter, type Question } from "../../app/main/agent/confirm";
import { IDLE_BUBBLE, type EmberState, type TaskCard } from "../../app/shared/overlay";
import { presenceOf } from "../../app/shared/presence";
import { handleLine, pillLine } from "../../app/renderer/handle/line";

const GOAL = "Close the Microsoft Edge browser";

/** Ember as main and the host put it together, with one task (cornered unless `corner` is false). */
function ember(o: { corner?: boolean; wired?: boolean } = {}) {
  let state: EmberState = { emotion: "neutral", talking: false, bubble: IDLE_BUBBLE, tasks: [], status: null, idle: "Ready" };
  // Main's "shown just for an answer while hidden" (main.ts showState).
  const seenBy = { hidden: false, shownForAnswer: false };
  const showState = (next: Partial<EmberState>) => {
    state = { ...state, ...next };
    if (hidesAgainAfter(seenBy.shownForAnswer, next)) { seenBy.shownForAnswer = false; seenBy.hidden = true; }
  };
  const box: { confirmer: Confirmer | null } = { confirmer: null };
  const setState = guardWhileAsking(() => box.confirmer?.waiting ?? false, showState);
  // AgentHost's dropAnnouncement: once a question is answered, the conversation's reply announcing the task is stale.
  const announced = { on: false };
  const dropAnnouncement = () => { if (announced.on && !conversation.busy && conversation.visible) conversation.drop(); };
  const owner: BubbleOwner = new BubbleOwner({ up: () => box.confirmer?.waiting ?? false, answered: () => box.confirmer!.settled().then(dropAnnouncement) });
  const confirmer = box.confirmer = new Confirmer(showState, {
    armMs: 0, gapMs: 700, timeoutMs: 120_000,
    // main.ts's own wiring (pinned below), with AgentHost.afterAnswer's owner.afterAnswer().
    ...(o.wired === false ? {} : { afterAnswer: answerSettler({ onScreen: () => state.bubble, reshow: () => owner.afterAnswer(), set: setState }) }),
  });
  const conversation = new Presenter(setState, undefined, () => "Ember", owner);
  const task = new Presenter(setState, undefined, () => GOAL, owner, undefined, false, { task: "t1", corner: o.corner !== false });
  const card = (status: TaskCard["status"]) => setState({ tasks: [{ id: "t1", title: GOAL, status, detail: "" }] });
  return {
    owner, confirmer, conversation, task, card, showState, seenBy,
    get state() { return state; },
    /** The conversation's turn that starts the task ("I'll close it."), as Copilot plays it, and the task's first step. */
    asked() {
      // A hidden Ember shows itself for the answer to what the user just asked (main.ts askEmber).
      if (seenBy.hidden) { seenBy.hidden = false; seenBy.shownForAnswer = true; }
      conversation.userPrompt("close Microsoft Edge");
      conversation.event({ type: "user.message", data: { content: "close Microsoft Edge" } });
      conversation.event({ type: "tool.execution_start", data: { toolName: "start_task" } });
      conversation.event({ type: "tool.execution_complete", data: { success: true } });
      conversation.event({ type: "assistant.message", data: { content: "I'll close Microsoft Edge." } });
      conversation.event({ type: "session.idle", data: {} });
      announced.on = true;
      card("running");
      task.taskStarted();
      task.event({ type: "tool.execution_start", data: { toolName: "click" } });
    },
    /** The task's question (policy's words), as a worker asks it; resolves with the answer. */
    ask(): Promise<string | null> {
      const q: Question = { title: "May I?", context: GOAL, prompt: "Click Close in Microsoft Edge?", task: "t1",
        options: [{ id: "once", label: "Allow", primary: true }, { id: "deny", label: "Not now" }] };
      return confirmer.ask(q);
    },
    /** TaskManager's onFinished as the host handles it: the card, then the presenter's outcome. */
    ended(status: "done" | "failed" | "cancelled", summary: string) {
      card(status === "done" ? "done" : status === "failed" ? "failed" : "stopped");
      const o = status === "done" ? { emotion: "proud", gesture: "thumbsUp", mood: "done" } as const
        : status === "cancelled" ? { emotion: "neutral", gesture: "rest", mood: "idle" } as const
        : { emotion: "sad", gesture: "facepalm", mood: "error" } as const;
      task.outcome({ title: GOAL, text: summary, ...o });
    },
  };
}
type Ember = ReturnType<typeof ember>;

/** What the user sees of Ember: whether anything still says it works, and the handle's line. */
function seen(e: Ember) {
  const s = e.state;
  return {
    busyRing: ["acting", "thinking"].includes(presenceOf(s)),
    working: s.bubble.visible && (s.bubble.mood === "acting" || s.bubble.streaming),
    busyFace: s.emotion === "focused" || s.emotion === "thinking",
    talking: s.talking,
    line: pillLine(s, "Ember", handleLine(s)),
  };
}
const AT_REST = { busyRing: false, working: false, busyFace: false, talking: false };

/** One way a task ends, played on `e` once its first step has run. */
interface EndPath { name: string; corner?: boolean; play: (e: Ember) => Promise<void>; line?: string }

const answer = async (e: Ember, which: "once" | "deny") => {
  await vi.advanceTimersByTimeAsync(600);
  expect(e.confirmer.answer(`q1:${which}`)).toBe(true);
};
const allowed = async (e: Ember) => { const a = e.ask(); await answer(e, "once"); expect(await a).toBe("once"); };

const PATHS: EndPath[] = [
  {
    name: "allowed, then the task closes its own window and finishes",
    play: async e => { await allowed(e); await vi.advanceTimersByTimeAsync(300); e.ended("done", "Closed Microsoft Edge."); },
  },
  {
    // The report: the accessibility bridge's first start on Windows takes seconds, so the question came after the
    // conversation's "I'll close Microsoft Edge." had gone, and nothing was left to take the answer down.
    name: "allowed after the conversation's reply went, then the task closes its own window and finishes",
    play: async e => { await vi.advanceTimersByTimeAsync(10_000); await allowed(e); await vi.advanceTimersByTimeAsync(300); e.ended("done", "Closed Microsoft Edge."); },
  },
  {
    name: "denied after the conversation's reply went",
    play: async e => { await vi.advanceTimersByTimeAsync(10_000); const a = e.ask(); await answer(e, "deny"); await a; e.ended("cancelled", "You said no, so I left it."); },
  },
  {
    name: "allowed, then it finishes long after the answer went",
    play: async e => { await allowed(e); await vi.advanceTimersByTimeAsync(20_000); e.ended("done", "Closed Microsoft Edge."); },
  },
  {
    name: "allowed, then it fails",
    play: async e => { await allowed(e); await vi.advanceTimersByTimeAsync(2000); e.ended("failed", "Microsoft Edge didn't close."); },
    // (Its card stays until it is closed, and the handle says so.)
    line: "1 task failed",
  },
  {
    name: "allowed, then stopped from its card",
    play: async e => { await allowed(e); await vi.advanceTimersByTimeAsync(4000); e.ended("cancelled", "Stopped."); },
  },
  {
    name: "denied (\"Not now\")",
    play: async e => { const a = e.ask(); await answer(e, "deny"); await a; e.ended("cancelled", "You said no, so I left it."); },
  },
  {
    name: "the question expires",
    play: async e => { const a = e.ask(); await vi.advanceTimersByTimeAsync(121_000); expect(await a).toBeNull(); e.ended("cancelled", "You said no, so I left it."); },
  },
  {
    name: "the kill switch, with the question up",
    play: async e => {
      const a = e.ask();
      await vi.advanceTimersByTimeAsync(600);
      // KillSwitch.pull(), in main's order: AgentHost.abortAll (main claims the bubble, every presenter falls quiet,
      // every question goes), then main's own message, which goes after its time when it is still up (hideIfStill).
      e.owner.claim({});
      e.conversation.quiet();
      e.task.quiet();
      e.card("stopped");
      e.confirmer.cancelAll();
      const message = { ...IDLE_BUBBLE, visible: true, mood: "idle" as const, title: "Stopped", thought: "Okay, I've stopped everything." };
      e.showState({ emotion: "neutral", talking: false, bubble: message });
      expect(await a).toBeNull();
      await vi.advanceTimersByTimeAsync(3000);
      if (e.state.bubble === message) e.showState({ emotion: "neutral", bubble: IDLE_BUBBLE });
    },
  },
  {
    name: "the window closes with no question asked",
    play: async e => { await vi.advanceTimersByTimeAsync(1000); e.ended("done", "Closed Microsoft Edge."); },
  },
  {
    name: "allowed while Ember is hidden (the state goes on as when shown), then done",
    play: async e => { await allowed(e); await vi.advanceTimersByTimeAsync(5000); e.ended("done", "Closed Microsoft Edge."); },
  },
  {
    name: "a task using the user's mouse (in the foreground), allowed and done",
    play: async e => {
      e.task.foreground = true;
      e.task.event({ type: "tool.execution_start", data: { toolName: "click" } });
      await allowed(e);
      e.task.event({ type: "tool.execution_complete", data: { success: true } });
      e.task.foreground = false;
      e.ended("done", "Closed Microsoft Edge.");
    },
  },
  {
    name: "a task in the bubble (not cornered), allowed and done",
    corner: false,
    play: async e => { await allowed(e); await vi.advanceTimersByTimeAsync(1000); e.ended("done", "Closed Microsoft Edge."); },
  },
  {
    name: "a guide, allowed and done",
    corner: false,
    play: async e => {
      e.task.guide("Click Close at the top right.", "Showing you");
      await allowed(e);
      e.ended("done", "You closed Microsoft Edge.");
    },
  },
];

describe("Ember after a task ends, every way it can end (the owner's report of 2026-11-03)", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it.each(PATHS)("is at rest within a few seconds, and empty once everything has been read: $name", async path => {
    const e = ember({ corner: path.corner });
    e.asked();
    await path.play(e);
    // Within a few seconds: no "Working", no busy ring, no busy face (the bubble may show the result).
    await vi.advanceTimersByTimeAsync(3000);
    expect(seen(e)).toMatchObject(AT_REST);
    expect(e.state.bubble.thought).not.toBe("Thanks! Carrying on.");
    // Once every bubble has had its reading time: empty, and the handle says Ready again.
    await vi.advanceTimersByTimeAsync(40_000);
    expect(e.state.bubble.visible).toBe(false);
    expect(seen(e)).toEqual({ ...AT_REST, line: path.line ?? "Ready" });
  });

  it("kept \"Working · Thanks! Carrying on.\" for good when nothing ended the answer (the report, before this fix)", async () => {
    const e = ember({ wired: false });
    e.asked();
    await vi.advanceTimersByTimeAsync(10_000);
    await allowed(e);
    e.ended("done", "Closed Microsoft Edge.");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(e.state.bubble).toMatchObject({ visible: true, mood: "acting", title: GOAL, thought: "Thanks! Carrying on." });
    expect(presenceOf(e.state)).toBe("acting");
    expect(pillLine(e.state, "Ember", handleLine(e.state))).toBe(GOAL);
  });

  it("shows again the answer the question covered once the answer to it has had its moment", async () => {
    const e = ember();
    e.conversation.userPrompt("what's the time?");
    e.conversation.event({ type: "user.message", data: { content: "what's the time?" } });
    e.conversation.event({ type: "assistant.message", data: { content: "It's ten past three." } });
    e.conversation.event({ type: "session.idle", data: {} });
    const a = e.ask(); await answer(e, "deny"); await a;
    expect(e.state.bubble.thought).toBe("Okay, I won't.");
    await vi.advanceTimersByTimeAsync(1600);
    expect(e.state.bubble).toMatchObject({ visible: true, thought: "It's ten past three." });
  });

  it("hides again when it was hidden and showed itself for the request, once the answer has gone", async () => {
    const e = ember();
    e.seenBy.hidden = true;
    e.asked();
    expect(e.seenBy).toEqual({ hidden: false, shownForAnswer: true });
    await vi.advanceTimersByTimeAsync(10_000);
    await allowed(e);
    await vi.advanceTimersByTimeAsync(300);
    e.ended("done", "Closed Microsoft Edge.");
    await vi.advanceTimersByTimeAsync(40_000);
    expect(e.state.bubble.visible).toBe(false);
    expect(e.seenBy).toEqual({ hidden: true, shownForAnswer: false });
  });

  it("is wired in main as the test wires it (answerSettler, hidesAgainAfter)", () => {
    const main = readFileSync("app/main/main.ts", "utf8");
    expect(main).toContain("afterAnswer: answerSettler({ onScreen: () => lastState.bubble, reshow: () => agent?.afterAnswer() ?? false, set: setState }),");
    expect(main).toContain("if (hidesAgainAfter(shownForAnswer, next)) { shownForAnswer = false; keptHidden = true; overlay?.setHidden(true); }");
    const host = readFileSync("app/main/agent/host.ts", "utf8");
    expect(host).toMatch(/afterAnswer\(\): boolean \{\s*return this\.owner\.afterAnswer\(\);/);
  });

  it("never takes down the next question in place of the answer before it", async () => {
    const e = ember();
    e.asked();
    await allowed(e);
    const b = e.ask();
    await vi.advanceTimersByTimeAsync(2000);
    expect(e.state.bubble).toMatchObject({ visible: true, mood: "attention", thought: expect.stringContaining("Click Close in Microsoft Edge?") });
    expect(e.confirmer.answer("q2:deny")).toBe(true);
    await b;
  });
});
