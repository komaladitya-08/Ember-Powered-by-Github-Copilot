import { describe, it, expect, vi } from "vitest";
import { BubbleOwner, LONG_ANSWER, NO_REPLY, Presenter, STILL_WAITING, answerLines, expandedBubble, forBubble, handStep, plainText, problemTitle, questionAloud, stepOf } from "../../app/main/agent/presenter";
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
    const owner = new BubbleOwner();
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
    const p = new Presenter(s => states.push(s), undefined, () => "Ember", new BubbleOwner(), t => { full = t; });
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

describe("Presenter: review round 2", () => {
  it("a restart doesn't keep a notice or an error on screen forever", () => {
    const { p, last } = setup();
    p.notice({ title: "I can't reach Copilot", text: "Ember can't reach GitHub right now." });
    vi.advanceTimersByTime(5000);
    p.reset(); // a retry restarts the brain
    vi.advanceTimersByTime(8000);
    expect(last()).toMatchObject({ bubble: { visible: false } });
  });

  it("the final answer is the message's own text, even when a second question cut the stream short", () => {
    vi.useFakeTimers();
    const said: string[] = [];
    const p = new Presenter(() => undefined, undefined, () => "Ember", new BubbleOwner(), t => said.push(t));
    p.userPrompt("first");
    p.event({ type: "assistant.message_delta", data: { deltaContent: "AAA first answer " } });
    p.event({ type: "user.message", data: {} }); // the second question, queued while the first streams
    p.event({ type: "assistant.message_delta", data: { deltaContent: "is long." } });
    p.event({ type: "assistant.message", data: { content: "AAA first answer is long." } });
    expect(said).toEqual(["AAA first answer is long."]);
    // A message that only calls tools is no answer.
    p.event({ type: "assistant.turn_start", data: {} });
    p.event({ type: "assistant.message", data: { content: "", toolRequests: [{}] } });
    expect(said).toHaveLength(1);
  });

  it("a turn ending while someone else has the bubble leaves it alone", () => {
    vi.useFakeTimers();
    const states: Partial<EmberState>[] = [];
    const owner = new BubbleOwner();
    const p = new Presenter(s => states.push(s), undefined, () => "Ember", owner);
    p.userPrompt("hi");
    owner.claim({}); // main's "Listening…"
    const n = states.length;
    p.event({ type: "session.idle", data: { aborted: true } });
    expect(states.slice(n)).toEqual([]);
    expect(p.busy).toBe(false);
  });

  it("quiet after the kill switch until the next request", () => {
    const { p, states, last } = setup();
    p.userPrompt("hi");
    p.quiet();
    const n = states.length;
    p.event({ type: "assistant.message_delta", data: { deltaContent: "late" } });
    p.event({ type: "tool.execution_complete", data: { success: false } });
    expect(states.slice(n)).toEqual([]);
    p.userPrompt("again");
    expect(last().bubble?.title).toBe("Thinking…");
  });

  it("errors from the organisation's endpoint and content filters get their own words", async () => {
    const { friendlyError } = await import("../../app/main/agent/presenter");
    const cases: [string, string | undefined, { statusCode?: number; provider?: boolean }, RegExp][] = [
      ["400 The response was filtered due to the prompt triggering Azure OpenAI's content management policy.", "query", { statusCode: 400 }, /content filter/],
      ["Authentication failed with provider at http://x/v1 (HTTP 403).", "authentication", { statusCode: 403, provider: true }, /organisation's AI endpoint refused/],
      ["Authentication failed with provider at http://x/v1 (HTTP 401).", "authentication", { statusCode: 401, provider: true }, /organisation's AI endpoint refused/],
      ["Request failed: 401 Unauthorized", undefined, {}, /sign in again/],
      ["Forbidden", undefined, { statusCode: 403 }, /organisation policy or a missing Copilot seat/],
      ["Could not connect to local model provider at http://127.0.0.1:1/v1.", "query", { provider: true }, /can't reach your organisation's AI endpoint/],
      ["Failed to get response from the AI model; retried 5 times. Last error: 429 Rate limit reached", "rate_limit", { statusCode: 429 }, /usage limit/],
      ["400 This model's maximum context length is 8192 tokens.", "query", { statusCode: 400 }, /too much/],
      ["Resource not found on provider at http://x/v1 (HTTP 404).", "query", { statusCode: 404, provider: true }, /model I'm set to use/],
    ];
    for (const [raw, type, ctx, want] of cases) expect(friendlyError(raw, type, ctx), raw).toMatch(want);
  });
});

describe("Presenter: one bubble, held while it's read (review round 3)", () => {
  /** The conversation and a task sharing one bubble, as in the host. */
  function shared(question?: { up: () => boolean; answered: () => Promise<void> }) {
    vi.useFakeTimers();
    const states: { who: string; s: Partial<EmberState> }[] = [];
    const owner = new BubbleOwner(question);
    const talk = new Presenter(s => states.push({ who: "ember", s }), undefined, () => "Ember", owner);
    const task = new Presenter(s => states.push({ who: "task", s }), undefined, () => "Tidy up", owner, undefined, false, { task: true });
    // What the bubble showed, one entry per change.
    const shown = () => states.filter(x => x.s.bubble).map(x => `${x.who}:${x.s.bubble!.visible ? x.s.bubble!.thought : "(hidden)"}`).filter((x, i, a) => x !== a[i - 1]);
    const work = (n: number) => {
      for (let i = 0; i < n; i++) {
        task.progress(`look ${i} `);
        task.event({ type: "tool.execution_start", data: { toolName: "perceive_window" } });
        task.event({ type: "tool.execution_complete", data: { success: true } });
      }
    };
    const answer = (text: string) => {
      talk.event({ type: "assistant.message_delta", data: { deltaContent: text } });
      talk.event({ type: "assistant.message", data: { content: text } });
      talk.event({ type: "session.idle", data: {} });
    };
    return { owner, talk, task, states, shown, work, answer };
  }

  it("an answer isn't replaced by a task's work while it's read; the work shows again afterwards, without a blank in between", () => {
    const { talk, task, shown, work, answer } = shared();
    task.taskStarted();
    work(1);
    talk.userPrompt("what time is it?");
    const n = shown().length;
    work(5);
    answer("It is half past three.");
    work(5);
    expect(shown().slice(n)).toEqual(["ember:It is half past three."]);
    vi.advanceTimersByTime(6000 + 22 * 50 - 10);
    expect(shown().at(-1)).toBe("ember:It is half past three.");
    vi.advanceTimersByTime(20);
    expect(shown().at(-1)).toBe("task:look 4 ");
    expect(shown().filter(s => s.endsWith("(hidden)"))).toEqual([]);
    // Nothing holds the bubble now: the task's work shows as it happens.
    work(1);
    expect(shown().at(-1)).toBe("task:look 0 ");
  });

  it("main's own bubble (\"Listening…\") holds off a task's work and the rest of a turn", () => {
    const { owner, talk, states, work } = shared();
    talk.userPrompt("tell me a story");
    owner.claim({});
    const n = states.length;
    work(3);
    talk.event({ type: "assistant.message_delta", data: { deltaContent: "Once upon a time" } });
    vi.advanceTimersByTime(60_000);
    expect(states.slice(n)).toEqual([]);
    // A new request takes the bubble back.
    talk.userPrompt("never mind");
    expect(states.at(-1)?.s.bubble?.title).toBe("Thinking…");
  });

  it("an answer that came while a question was up shows once it's answered, after its answer, for its full reading time", async () => {
    let up = true;
    let answered!: () => void;
    const { talk, shown, work, answer } = shared({ up: () => up, answered: () => new Promise<void>(r => { answered = r; }) });
    talk.userPrompt("and the weather?");
    work(2);
    answer("Sunny all day.");
    vi.advanceTimersByTime(60_000);
    expect(shown()).toEqual([]);
    up = false;
    answered();
    await vi.advanceTimersByTimeAsync(1400);
    expect(shown()).toEqual([]);
    work(2);
    await vi.advanceTimersByTimeAsync(200);
    expect(shown()).toEqual(["ember:Sunny all day."]);
    // Shown at 1.5 s; read for 6.7 s from then.
    await vi.advanceTimersByTimeAsync(6000 + 14 * 50 - 200);
    expect(shown().at(-1)).toBe("ember:Sunny all day.");
    await vi.advanceTimersByTimeAsync(200);
    expect(shown().at(-1)).toBe("task:look 1 ");
  });

  it("a guide step replaces a finished answer, but not one still coming", () => {
    const { talk, task, shown, answer } = shared();
    talk.userPrompt("show me how to save");
    talk.event({ type: "assistant.message_delta", data: { deltaContent: "Follow" } });
    task.guide("Click File", "Step 1");
    expect(shown().at(-1)).toBe("ember:Follow");
    answer(" me!");
    task.guide("Click File", "Step 1");
    expect(shown().at(-1)).toBe("task:Click File");
  });

  it("a guide step that came while the answer streamed shows a moment after the answer is done, not after its reading time (review round 6)", () => {
    const { talk, task, shown } = shared();
    talk.userPrompt("show me how to add a contact");
    talk.event({ type: "assistant.message_delta", data: { deltaContent: "Sure, I'll show you " } });
    // The guide's first step, while the answer still streams.
    task.event({ type: "tool.execution_start", data: { toolName: "point_at" } });
    task.guide("Click Add to save the contact", "Step 1");
    task.event({ type: "tool.execution_complete", data: { success: true } });
    task.event({ type: "tool.execution_start", data: { toolName: "wait_for_click" } });
    expect(shown().at(-1)).toBe("ember:Sure, I'll show you ");
    vi.advanceTimersByTime(700);
    talk.event({ type: "assistant.message_delta", data: { deltaContent: "where to click." } });
    talk.event({ type: "assistant.message", data: { content: "Sure, I'll show you where to click." } });
    talk.event({ type: "session.idle", data: {} });
    expect(shown().at(-1)).toBe("ember:Sure, I'll show you where to click.");
    vi.advanceTimersByTime(1400);
    expect(shown().at(-1)).toBe("ember:Sure, I'll show you where to click.");
    vi.advanceTimersByTime(100);
    expect(shown().at(-1)).toBe("task:Click Add to save the contact");
    // The answer's own reading time running out later doesn't take the step away.
    vi.advanceTimersByTime(30_000);
    expect(shown().at(-1)).toBe("task:Click Add to save the contact");
  });

  it("a guide step waiting behind an answer that finished under main's bubble shows a moment after the answer is back (review round 7)", () => {
    const { owner, talk, task, shown } = shared();
    talk.userPrompt("show me how to change the display");
    talk.event({ type: "assistant.message_delta", data: { deltaContent: "Sure, " } });
    task.guide("Click Display", "Step 1");
    // A wake that was another word: main's "Listening…" covers the answer while it finishes.
    const main = {};
    owner.claim(main);
    talk.event({ type: "assistant.message", data: { content: "Sure, I'll show you." } });
    talk.event({ type: "session.idle", data: {} });
    // Main lets go (as host.releaseBubble does): the answer shows again, then the step 1.5 s later.
    owner.holder = null;
    owner.uncover(() => true);
    expect(talk.reshow()).toBe(true);
    expect(shown().at(-1)).toBe("ember:Sure, I'll show you.");
    vi.advanceTimersByTime(1500);
    expect(shown().at(-1)).toBe("task:Click Display");
  });

  it("a guide step waiting behind an answer waits while the conversation is still at work after it", () => {
    const { talk, task, shown } = shared();
    talk.userPrompt("show me how to save");
    talk.event({ type: "assistant.message_delta", data: { deltaContent: "Let me look first." } });
    task.guide("Click File", "Step 1");
    talk.event({ type: "assistant.message", data: { content: "Let me look first.", toolRequests: [{ name: "describe_screen" }] } });
    // The conversation goes on working (a tool) before the moment is over: the step keeps waiting.
    talk.event({ type: "tool.execution_start", data: { toolName: "describe_screen" } });
    vi.advanceTimersByTime(2000);
    expect(shown().at(-1)).toMatch(/^ember:/);
    talk.event({ type: "tool.execution_complete", data: { success: true } });
    talk.event({ type: "assistant.message_delta", data: { deltaContent: "Done." } });
    talk.event({ type: "assistant.message", data: { content: "Done." } });
    talk.event({ type: "session.idle", data: {} });
    vi.advanceTimersByTime(1500);
    expect(shown().at(-1)).toBe("task:Click File");
  });

  it("a task's result waits for the answer being read, then shows and goes on its own", () => {
    const { talk, task, shown, answer } = shared();
    task.taskStarted();
    talk.userPrompt("hi");
    answer("Hello!");
    task.outcome({ title: "Tidy up", text: "Copilot stopped unexpectedly; the task didn't finish.", emotion: "sad", gesture: "facepalm", mood: "error" });
    expect(shown().at(-1)).toBe("ember:Hello!");
    vi.advanceTimersByTime(6000 + 6 * 50);
    expect(shown().at(-1)).toBe("task:Copilot stopped unexpectedly; the task didn't finish.");
    vi.advanceTimersByTime(15_000);
    expect(shown().at(-1)).toBe("task:(hidden)");
  });
});

describe("plainText (review round 3)", () => {
  it("keeps arithmetic and file names; emphasis only where the markers hug the words", () => {
    expect(plainText("12 * 7 * 3 = 252")).toBe("12 * 7 * 3 = 252");
    expect(plainText("5 * 2 = 10, and 3 * 4 = 12")).toBe("5 * 2 = 10, and 3 * 4 = 12");
    expect(plainText("Edit __init__.py and path/__main__.py, not my_var or 5*3*2.")).toBe("Edit __init__.py and path/__main__.py, not my_var or 5*3*2.");
    expect(plainText("**Bold** and *soft*, __strong__ and _light_.")).toBe("Bold and soft, strong and light.");
  });
});

describe("Presenter: tasks and guides sharing the bubble (review round 4)", () => {
  function shared() {
    vi.useFakeTimers();
    const states: { who: string; s: Partial<EmberState> }[] = [];
    const owner = new BubbleOwner();
    const make = (who: string, name: string, task: boolean) => new Presenter(s => states.push({ who, s }), undefined, () => name, owner, undefined, false, { task });
    const talk = make("ember", "Ember", false);
    const a = make("a", "Night light", true);
    const b = make("b", "Calculator", true);
    const shown = () => states.filter(x => x.s.bubble).map(x => `${x.who}:${x.s.bubble!.visible ? x.s.bubble!.thought : "(hidden)"}`).filter((x, i, arr) => x !== arr[i - 1]);
    const work = (p: Presenter, text: string) => {
      p.progress(text);
      p.event({ type: "tool.execution_start", data: { toolName: "perceive_window" } });
      p.event({ type: "tool.execution_complete", data: { success: true } });
    };
    return { owner, talk, a, b, states, shown, work };
  }

  it("two tasks at work: one task's work is in the bubble at a time; the other's shows once the first is done", () => {
    const { a, b, shown, work } = shared();
    a.taskStarted();
    b.taskStarted();
    for (let i = 0; i < 5; i++) { work(a, `a${i} `); work(b, `b${i} `); }
    expect(shown().every(s => s.startsWith("a:"))).toBe(true);
    a.outcome({ title: "Night light", text: "It's on.", emotion: "proud", gesture: "thumbsUp", mood: "done" });
    work(b, "b5 ");
    expect(shown().at(-1)).toBe("a:It's on.");
    vi.advanceTimersByTime(6000 + 8 * 50);
    expect(shown().at(-1)).toBe("b:b5 ");
    work(b, "b6 ");
    expect(shown().at(-1)).toBe("b:b6 ");
  });

  it("a task that goes quiet hands the bubble to one still at work", () => {
    const { a, b, shown, work } = shared();
    a.taskStarted();
    work(a, "a0 ");
    b.taskStarted();
    work(b, "b0 ");
    expect(shown().at(-1)).toBe("a:a0 ");
    vi.advanceTimersByTime(16_000);
    work(b, "b1 ");
    expect(shown().at(-1)).toBe("b:b1 ");
    work(a, "a1 ");
    expect(shown().at(-1)).toBe("b:b1 ");
  });

  it("a guide step stays up while it waits for the click: neither its own tool events nor another task's work replace it, and it comes back after an answer", () => {
    const { talk, a: guide, b: task, shown, work } = shared();
    task.taskStarted();
    work(task, "t0 ");
    guide.event({ type: "tool.execution_start", data: { toolName: "point_at" } });
    guide.guide("Click Display", "Step 1");
    guide.event({ type: "tool.execution_complete", data: { success: true } });
    guide.event({ type: "tool.execution_start", data: { toolName: "wait_for_click" } });
    for (let i = 1; i < 6; i++) work(task, `t${i} `);
    vi.advanceTimersByTime(20_000);
    for (let i = 6; i < 9; i++) work(task, `t${i} `);
    expect(shown().at(-1)).toBe("a:Click Display");
    // The user asks something meanwhile: the answer shows, then the step again (not the other task's work).
    talk.userPrompt("and the time?");
    talk.event({ type: "assistant.message_delta", data: { deltaContent: "Three." } });
    talk.event({ type: "assistant.message", data: { content: "Three." } });
    talk.event({ type: "session.idle", data: {} });
    work(task, "t9 ");
    expect(shown().at(-1)).toBe("ember:Three.");
    vi.advanceTimersByTime(6000 + 6 * 50);
    expect(shown().at(-1)).toBe("a:Click Display");
    // The guide ends: its outcome, then the other task's work.
    guide.event({ type: "tool.execution_complete", data: { success: true } });
    guide.outcome({ title: "Display", text: "You got as far as Display.", emotion: "neutral", gesture: "rest", mood: "idle" });
    work(task, "t10 ");
    expect(shown().at(-1)).toBe("a:You got as far as Display.");
    vi.advanceTimersByTime(6000 + 26 * 50);
    expect(shown().at(-1)).toMatch(/^b:.*t10 $/);
  });

  it("errors: a connection disposed under a pending request, and a server error, in plain words", async () => {
    const { friendlyError } = await import("../../app/main/agent/presenter");
    expect(friendlyError("Pending response rejected since connection got disposed")).toMatch(/can't reach Copilot/);
    expect(friendlyError("Failed to get response from the AI model; retried 5 times (total retry wait time: 54.36 seconds) Last error: 502 Bad gateway")).toBe("Copilot had a problem on its side. Try again in a moment.");
    expect(friendlyError("Last error: 503 Service Unavailable", undefined, { provider: true })).toMatch(/^Your organisation's AI endpoint had a problem/);
  });
});

describe("Presenter: a question asked while the turn before is still ending (review round 9, BLD9-1)", () => {
  it("the turn before's session.idle doesn't take the queued question's Thinking: it thinks again when its turn begins, and says when Copilot is quiet", () => {
    const { p, states, last } = setup();
    p.userPrompt("remember the word pineapple");
    p.event({ type: "user.message", data: { content: "<current_datetime>now</current_datetime>\n\nremember the word pineapple" } });
    p.event({ type: "assistant.turn_start", data: {} });
    p.event({ type: "assistant.message_delta", data: { deltaContent: "OK, pineapple." } });
    p.event({ type: "assistant.message", data: { content: "OK, pineapple." } });
    // Asked before the first turn's session.idle came.
    p.userPrompt("what time is it in Tokyo");
    p.event({ type: "assistant.turn_end", data: {} });
    p.event({ type: "session.idle", data: {} });
    // Its turn begins: thinking again, and the hide armed by the old turn's end is off.
    p.event({ type: "user.message", data: { content: "what time is it in Tokyo" } });
    p.event({ type: "assistant.turn_start", data: {} });
    expect(p.busy).toBe(true);
    expect(last()).toMatchObject({ emotion: "thinking", bubble: { visible: true, title: "Thinking…", thought: "“what time is it in Tokyo”", streaming: true } });
    p.stalled(true);
    expect(last().bubble?.title).toBe(STILL_WAITING);
    vi.advanceTimersByTime(60_000);
    expect(states.filter(s => s.bubble).at(-1)?.bubble).toMatchObject({ visible: true, title: STILL_WAITING });
    // Its answer comes and ends as usual.
    p.event({ type: "assistant.message_delta", data: { deltaContent: "Noon." } });
    p.event({ type: "assistant.message", data: { content: "Noon." } });
    p.event({ type: "session.idle", data: {} });
    expect(last().bubble).toMatchObject({ thought: "Noon.", streaming: false });
    vi.advanceTimersByTime(10_000);
    expect(states.filter(s => s.bubble).at(-1)?.bubble?.visible).toBe(false);
    vi.useRealTimers();
  });

  it("asked after the answer's words came but before its message: the late message doesn't put the old answer under the new Thinking (AC10-2)", () => {
    const { p, last } = setup();
    p.userPrompt("tell me about alpha");
    p.event({ type: "user.message", data: { content: "tell me about alpha" } });
    p.event({ type: "assistant.turn_start", data: {} });
    p.event({ type: "assistant.message_delta", data: { deltaContent: "Alpha answer with quite a few words." } });
    p.userPrompt("and beta?");
    p.event({ type: "assistant.message", data: { content: "Alpha answer with quite a few words." } });
    expect(last().bubble).toMatchObject({ title: "Thinking…", thought: "“and beta?”" });
    p.event({ type: "assistant.turn_end", data: {} });
    p.event({ type: "session.idle", data: {} });
    p.event({ type: "user.message", data: { content: "and beta?" } });
    p.event({ type: "assistant.turn_start", data: {} });
    p.event({ type: "assistant.reasoning_delta", data: { deltaContent: "Thinking about beta" } });
    expect(last().bubble?.thought ?? "").not.toContain("Alpha answer");
    p.event({ type: "assistant.message_delta", data: { deltaContent: "Beta." } });
    p.event({ type: "assistant.message", data: { content: "Beta." } });
    expect(last().bubble).toMatchObject({ thought: "Beta.", streaming: false });
    vi.useRealTimers();
  });

  it("asked while the answer's words are still coming: the rest of them streams, and its message shows it whole, with Read all (AC11-2)", () => {
    const { p, last } = setup();
    const ALPHA = "Alpha is the first letter of the Greek alphabet, and it is used all over science and mathematics. ".repeat(4).trim();
    p.userPrompt("tell me about alpha");
    p.event({ type: "user.message", data: { content: "tell me about alpha" } });
    p.event({ type: "assistant.turn_start", data: {} });
    p.event({ type: "assistant.message_delta", data: { deltaContent: ALPHA.slice(0, 40) } });
    p.userPrompt("and beta?");
    expect(last().bubble).toMatchObject({ title: "Thinking…", thought: "“and beta?”" });
    // The rest of the answer before comes after the question (its turn hasn't begun).
    p.event({ type: "assistant.message_delta", data: { deltaContent: ALPHA.slice(40) } });
    p.event({ type: "assistant.message", data: { content: ALPHA } });
    expect(last().bubble).toMatchObject({ thought: ALPHA, streaming: false, actions: [{ id: "ui:more", label: "Read all" }] });
    p.event({ type: "assistant.turn_end", data: {} });
    p.event({ type: "session.idle", data: {} });
    // The question's own turn: thinking again, then its answer.
    p.event({ type: "user.message", data: { content: "and beta?" } });
    expect(last().bubble).toMatchObject({ title: "Thinking…", thought: "“and beta?”" });
    p.event({ type: "assistant.turn_start", data: {} });
    p.event({ type: "assistant.message_delta", data: { deltaContent: "Beta." } });
    p.event({ type: "assistant.message", data: { content: "Beta." } });
    expect(last().bubble).toMatchObject({ thought: "Beta.", streaming: false });
    vi.useRealTimers();
  });

  it("a turn beginning after the question's own has begun, or after a Stop, changes nothing", () => {
    const { p, last } = setup();
    p.userPrompt("hello");
    p.event({ type: "user.message", data: { content: "hello" } });
    p.event({ type: "assistant.message_delta", data: { deltaContent: "Hi." } });
    p.event({ type: "assistant.message", data: { content: "Hi." } });
    p.event({ type: "session.idle", data: {} });
    p.event({ type: "user.message", data: { content: "(something nobody asked)" } });
    expect(last().bubble).toMatchObject({ thought: "Hi.", streaming: false });
    p.userPrompt("and again");
    p.quiet();
    p.event({ type: "session.idle", data: { aborted: true } });
    p.event({ type: "user.message", data: { content: "and again" } });
    expect(p.busy).toBe(false);
    vi.useRealTimers();
  });
});

describe("Presenter: a task's steps on Ember's desk (review round 11, AC11-4)", () => {
  it("don't say “your keyboard” or “your mouse” there; on the user's screen they do", () => {
    expect(stepOf("press_keys")).toBe("Pressing keys (your keyboard)");
    expect(stepOf("press_keys", true)).toBe("Pressing keys");
    expect(stepOf("scroll", true)).toBe("Scrolling");
    expect(stepOf("fill_cells", true)).toBe("Filling cells");
    expect(stepOf("click", true)).toBe("Clicking");
    expect(stepOf("no_such_tool", true)).toBeUndefined();
    const { p, last } = setup();
    p.taskStarted();
    p.event({ type: "tool.execution_start", data: { toolName: "scroll" } });
    expect(last().bubble?.step).toBe("Scrolling (your mouse)");
    p.onDesk = true;
    p.event({ type: "tool.execution_start", data: { toolName: "press_keys" } });
    expect(last().bubble?.step).toBe("Pressing keys");
    vi.useRealTimers();
  });
});

describe("Presenter: the first reply of the live test (an empty card that faded)", () => {
  it("a blank first delta and a message that only calls a tool show no empty answer", () => {
    const { p, last } = setup();
    p.userPrompt("What can you do?");
    p.event({ type: "assistant.message_delta", data: { deltaContent: "" } });
    p.event({ type: "assistant.message_delta", data: { deltaContent: "  " } });
    expect(last().bubble).toMatchObject({ mood: "thinking", title: "Thinking…" });
    p.event({ type: "assistant.message", data: { content: "", toolRequests: [{ name: "describe_screen" }] } });
    expect(last().bubble?.thought).not.toBe("");
    p.event({ type: "tool.execution_start", data: { toolName: "describe_screen" } });
    p.event({ type: "tool.execution_complete", data: { success: true } });
    p.event({ type: "assistant.message_delta", data: { deltaContent: "I can open apps and show you how." } });
    p.event({ type: "assistant.message", data: { content: "I can open apps and show you how." } });
    expect(last().bubble).toMatchObject({ mood: "idle", title: "Ember", thought: "I can open apps and show you how." });
  });

  it("a turn that ends with neither words nor a step says so (and the conversation keeps it)", () => {
    const problems: string[] = [];
    vi.useFakeTimers();
    const states: Partial<EmberState>[] = [];
    const p = new Presenter(s => states.push(s), undefined, undefined, undefined, undefined, false, { onProblem: t => problems.push(t) });
    p.userPrompt("What can you do?");
    p.event({ type: "user.message", data: { content: "What can you do?" } });
    p.event({ type: "assistant.reasoning_delta", data: { deltaContent: "Let me think." } });
    p.event({ type: "assistant.message", data: { content: "" } });
    p.event({ type: "session.idle", data: {} });
    expect(states.at(-1)?.bubble).toMatchObject({ visible: true, mood: "error", title: "No answer", thought: NO_REPLY });
    expect(problems).toEqual([NO_REPLY]);
    // A turn that answered, or ran a step, doesn't.
    p.userPrompt("again");
    p.event({ type: "tool.execution_start", data: { toolName: "set_appearance" } });
    p.event({ type: "session.idle", data: {} });
    expect(states.at(-1)?.bubble?.title).not.toBe("No answer");
    // Nor a task's turn (its card and outcome speak for it).
    const task = new Presenter(s => states.push(s), undefined, () => "Tidy", undefined, undefined, false, { task: "t1" });
    task.taskStarted();
    task.event({ type: "session.idle", data: {} });
    expect(states.at(-1)?.bubble?.title).not.toBe("No answer");
  });

  it("'Read all' shows the whole answer in the bubble, with a way to close it and one to settings", () => {
    const full = "word ".repeat(200).trim();
    const b = expandedBubble({ visible: true, mood: "idle", title: "Ember", thought: full.slice(0, 599) + "…", step: null, streaming: false, actions: [{ id: "ui:more", label: "Read all" }] }, full);
    expect(b).toMatchObject({ visible: true, expanded: true, thought: full, title: "Ember", streaming: false });
    expect(b.actions.map(a => a.id)).toEqual(["ui:close", "ui:conversation"]);
  });
});

describe("a task's card says what the borrowed hand does (live test: 'Clicking…' while keys went in)", () => {
  it("names the hand's own step, on Ember's desk without 'your'", () => {
    expect(handStep("keys")).toBe("Pressing keys (your keyboard)");
    expect(handStep("click")).toBe("Clicking (your mouse)");
    expect(handStep("type", true)).toBe("Typing");
  });
});

describe("a task's bubble shows its steps, never its model's thinking (live retest)", () => {
  it("reasoning, chat and intent from a task's model don't reach its bubble; its own notes and steps do", () => {
    const states: Partial<EmberState>[] = [];
    vi.useFakeTimers();
    const p = new Presenter(s => states.push(s), undefined, () => "Open Mousepad", undefined, undefined, false, { task: "t1" });
    p.taskStarted();
    p.event({ type: "assistant.reasoning_delta", data: { deltaContent: "…going to use the command to open the Mousepad app… shopping list easily!" } });
    p.event({ type: "assistant.intent", data: { intent: "Examining everything carefully" } });
    p.event({ type: "assistant.message_delta", data: { deltaContent: "good to take my time and examine everything carefully" } });
    p.event({ type: "assistant.message", data: { content: "good to take my time and examine everything carefully" } });
    const all = states.filter(s => s.bubble).map(s => `${s.bubble!.title}|${s.bubble!.thought}`).join("\n");
    expect(all).not.toMatch(/command|examin/i);
    p.event({ type: "tool.execution_start", data: { toolName: "perceive_window" } });
    expect(states.at(-1)?.bubble).toMatchObject({ title: "Open Mousepad", step: "Reading the window" });
    p.progress("Typing the list");
    expect(states.at(-1)?.bubble).toMatchObject({ title: "Open Mousepad", thought: "Typing the list" });
  });
});

describe("Presenter.post: a bubble of Ember's own in the shared bubble (review #9, #10)", () => {
  function board() {
    vi.useFakeTimers();
    const shown: string[] = [];
    const owner = new BubbleOwner();
    const push = (who: string) => (s: Partial<EmberState>) => { if (s.bubble) shown.push(`${who}:${s.bubble.visible ? s.bubble.title : "(hidden)"}`); };
    const talk = new Presenter(push("ember"), undefined, () => "Ember", owner);
    const notices = new Presenter(push("notice"), undefined, () => "Ember", owner);
    return { owner, talk, notices, shown };
  }
  const offer = { title: "Connect to build-01?", thought: "You asked for build-01.", actions: [{ id: "offer:1:connect", label: "Connect" }], mood: "attention" as const };

  it("holds the bubble until it is cleared: the conversation's answer waits behind it, then shows", () => {
    const { talk, notices, shown } = board();
    talk.userPrompt("open the logs on build-01");
    notices.post(offer);
    talk.event({ type: "assistant.message_delta", data: { deltaContent: "Click Connect." } });
    talk.event({ type: "session.idle", data: {} });
    vi.advanceTimersByTime(60_000);
    expect(shown.at(-1)).toBe("notice:Connect to build-01?");
    notices.clear();
    expect(shown.at(-1)).toBe("ember:Ember");
  });

  it("comes back after the user's next request is answered, until it is cleared", () => {
    const { talk, notices, shown } = board();
    notices.post(offer);
    talk.userPrompt("what time is it?");
    talk.event({ type: "assistant.message_delta", data: { deltaContent: "Half past three." } });
    talk.event({ type: "session.idle", data: {} });
    vi.advanceTimersByTime(30_000);
    expect(shown.at(-1)).toBe("notice:Connect to build-01?");
  });

  it("with a time, goes that long after it reaches the screen, and never hides what covered it", () => {
    const { talk, notices, shown } = board();
    notices.post({ ...offer, title: "Ember is on build-01", actions: [], mood: "idle" }, { ms: 7000 });
    vi.advanceTimersByTime(3000);
    talk.userPrompt("how many files?");
    talk.event({ type: "assistant.message_delta", data: { deltaContent: "Twelve." } });
    talk.event({ type: "session.idle", data: {} });
    vi.advanceTimersByTime(4500);
    expect(shown.at(-1)).toBe("ember:Ember");
  });

  it("says when its bubble reached the screen, starting again with each post", () => {
    const { notices } = board();
    vi.setSystemTime(1000);
    expect(notices.shownAt).toBeNull();
    notices.post(offer);
    expect(notices.shownAt).toBe(1000);
    vi.setSystemTime(5000);
    notices.post({ ...offer, title: "Connect to build-02?" });
    expect(notices.shownAt).toBe(5000);
    notices.clear();
    expect(notices.visible).toBe(false);
  });
});

describe("Read all: by the lines an answer takes, not its characters (review #12)", () => {
  const finished = (text: string) => {
    const { p, last } = setup();
    p.userPrompt("what can I do?");
    p.event({ type: "assistant.message_delta", data: { deltaContent: text } });
    p.event({ type: "assistant.message", data: { content: text } });
    return last().bubble!;
  };

  it("offers Read all for a short answer whose line breaks take more than the bubble's six lines", () => {
    const options = "You have three options:\n\n1. Move the files…\n\n2. Delete the duplicates\n\n3. Leave everything as it is\n\nWhich would you like?";
    expect(options.length).toBeLessThan(LONG_ANSWER);
    expect(answerLines(options)).toBe(9);
    expect(finished(options).actions).toEqual([{ id: "ui:more", label: "Read all" }]);
    const list = "Here:\n- one\n- two\n- three\n- four\n- five\n- six\n- seven";
    expect(finished(list).actions).toEqual([{ id: "ui:more", label: "Read all" }]);
  });

  it("offers none for an answer that fits, and counts a long line as the lines it wraps onto", () => {
    expect(finished("It's half past three.\nYour next meeting is at four.").actions).toEqual([]);
    expect(answerLines("x".repeat(80))).toBe(3);
    expect(answerLines("a\n\nb")).toBe(3);
  });
});

describe("a question said aloud and in a notification names where it comes from (review #13)", () => {
  it("says the computer when it isn't this one, with the keys that answer it", () => {
    const words = questionAloud({ prompt: "Click **Save** in gedit?", where: "on build-01" }, { keys: ["Control Alt Y to allow"], spoken: s => s.replace(/\*/g, "") });
    expect(words).toEqual({ say: "Ember asks, on build-01: Click Save in gedit? Press Control Alt Y to allow.", notify: "On build-01: Click **Save** in gedit?" });
    expect(questionAloud({ prompt: "Click Save?" })).toEqual({ say: "Ember asks: Click Save?", notify: "Click Save?" });
  });
});

describe("a problem's buttons follow what failed (review #18)", () => {
  const errorOf = (data: Record<string, unknown>) => {
    const { p, last } = setup();
    p.userPrompt("hi");
    p.event({ type: "session.error", data });
    return last().bubble!;
  };

  it("offers Open settings where settings can fix it (sign-in, model, access), never for the network or a hiccup", () => {
    expect(errorOf({ message: "401 Unauthorized", errorType: "authentication" }).actions).toEqual([{ id: "ui:settings", label: "Open settings" }]);
    expect(errorOf({ message: "model_not_supported" }).actions).toEqual([{ id: "ui:settings", label: "Open settings" }]);
    expect(errorOf({ message: "403", statusCode: 403 }).actions).toEqual([{ id: "ui:settings", label: "Open settings" }]);
    expect(errorOf({ message: "fetch failed ECONNRESET" }).actions).toEqual([]);
    expect(errorOf({ message: "503 Service Unavailable" }).actions).toEqual([]);
    expect(errorOf({ message: "429 rate limited", statusCode: 429 }).actions).toEqual([]);
  });

  it("offers nothing for a runtime that stopped and reconnects by itself", () => {
    const { p, last } = setup();
    p.fail("Copilot stopped unexpectedly. I'm reconnecting; ask me again in a moment.");
    expect(last().bubble!.actions).toEqual([]);
  });

  it("never names a settings-window button in the bubble: Open settings is the button there", () => {
    expect(forBubble("Ember's Copilot runtime stopped while connecting. Press Check again.")).toBe("Ember's Copilot runtime stopped while connecting. Open settings to try again.");
    expect(forBubble("Copilot keeps stopping. Press Check again to retry, or restart Ember.")).toBe("Copilot keeps stopping. Open settings to try again, or restart Ember.");
    expect(forBubble("It may have expired. Sign in again, or run “gh auth login” in a terminal and press Check again."))
      .toBe("It may have expired. Sign in again in settings.");
    const { p, last } = setup();
    p.notice({ title: "Copilot isn't running", text: "Ember's Copilot runtime stopped while connecting. Press Check again.", actions: [{ id: "ui:settings", label: "Open settings" }] });
    expect(last().bubble!.thought).toBe("Ember's Copilot runtime stopped while connecting. Open settings to try again.");
  });
});

describe("the bubble's header says something the chip doesn't (review #21)", () => {
  it("points with words of its own, not the guiding chip's 'Showing you'", () => {
    expect(stepOf("point_at")).toBe("Pointing at it");
  });

  it("titles a problem with what failed, not 'Something went wrong'", () => {
    const titleOf = (data: Record<string, unknown>, provider = false) => {
      const states: Partial<EmberState>[] = [];
      const p = new Presenter(s => states.push(s), undefined, () => "Ember", new BubbleOwner(), undefined, provider);
      p.userPrompt("hi");
      p.event({ type: "session.error", data });
      return states.at(-1)!.bubble!.title;
    };
    expect(titleOf({ message: "401", errorType: "authentication" })).toBe("Copilot didn't accept the sign-in");
    expect(titleOf({ message: "fetch failed ECONNRESET" })).toBe("I can't reach Copilot");
    expect(titleOf({ message: "429", statusCode: 429 })).toBe("Usage limit reached");
    expect(titleOf({ message: "model_not_supported" })).toBe("That model isn't available");
    expect(titleOf({ message: "content_filter" })).toBe("Request blocked");
    expect(titleOf({ message: "503 Service Unavailable" })).toBe("Copilot had a problem");
    expect(titleOf({ message: "something odd" }, true)).toBe("The model service had a problem");
    expect(problemTitle("Copilot stopped unexpectedly. I'm reconnecting; ask me again in a moment.")).toBe("Copilot stopped");
    expect(problemTitle("Copilot isn't answering. I'll reconnect when the tasks running are done; ask me again then.")).toBe("Copilot isn't answering");
    expect(problemTitle("Copilot can't work right now: this computer has run out of file watchers. Close a few apps, then ask me again.")).toBe("Copilot can't work right now");
  });
});
