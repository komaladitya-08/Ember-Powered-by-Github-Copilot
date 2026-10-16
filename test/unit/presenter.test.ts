import { describe, it, expect, vi } from "vitest";
import { BubbleOwner, Presenter, STILL_WAITING, plainText } from "../../app/main/agent/presenter";
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
        task.event({ type: "assistant.reasoning_delta", data: { deltaContent: `look ${i} ` } });
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
      p.event({ type: "assistant.reasoning_delta", data: { deltaContent: text } });
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
