/** Exercise main's actual speech callbacks without starting Electron, a microphone or audio playback. */
import fs from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeechStream } from "../../app/voice/tts";
import { endsWithQuestion, spokenText } from "../../app/voice/spoken";
import { TurnLatency } from "../../app/main/turn-latency";
import { ACK_MS, acknowledgement, afterAck } from "../../app/main/acknowledge";

function wiring() {
  const source = fs.readFileSync("app/main/main.ts", "utf8");
  const speech = source.slice(source.indexOf("  const answerSpeech ="), source.indexOf("  // ───── Copilot brain"));
  const callbacks = source.slice(source.indexOf("      onTurnStart: turn =>"), source.indexOf("      onStatus: status =>", source.indexOf("      onTurnStart: turn =>")));
  const taskCallback = source.slice(source.indexOf("      onTaskFinished: t =>"), source.indexOf("      isOnline:", source.indexOf("      onTaskFinished: t =>")));
  expect(speech.length).toBeGreaterThan(500);
  expect(callbacks.length).toBeGreaterThan(500);
  const voice = { speak: vi.fn(), hush: vi.fn(), followUp: vi.fn(), cancelListenOnce: vi.fn(), micState: "waiting" };
  const agent = { answerOpen: false, tasks: null, pauseAnswer: vi.fn() };
  const confirmer = { waiting: false };
  const personal = { answered: vi.fn(() => null) };
  const code = ts.transpile(`
    let lastAskByVoice = false, turnAnswer = "", lastReply = "";
    const log = { info() {} }, maySpeak = () => true;
    let askedAt = 0;
    let manualCall = null;
    const syncListenOnce = () => {};
    const lastState = { bubble: { visible: false } }, showState = () => {};
    const settings = { get: () => ({ speakResults: true }) }, userAway = () => false, notify = () => {};
    ${speech}
    return {
      ${callbacks} ${taskCallback} interrupt: resetAnswerSpeech, pause: pauseAnswerSpeech,
      manualListening: on => { manualCall = on ? { source: "ask" } : null; },
    };
  `, { target: ts.ScriptTarget.ES2022 });
  const run = new Function("SpeechStream", "TurnLatency", "ACK_MS", "acknowledgement", "afterAck", "endsWithQuestion", "spokenText", "voice", "personal", "agent", "confirmer", code);
  const callbacksUnderTest = run(SpeechStream, TurnLatency, ACK_MS, acknowledgement, afterAck, endsWithQuestion, spokenText, voice, personal, agent, confirmer) as {
    onTurnStart(turn: { text: string; spoken: boolean; manual?: true }): void;
    onAnswerDelta(text: string): void;
    onAnswer(text: string): void;
    onAnswerEnd(text: string): void;
    onTurnEnd(aborted: boolean): void;
    onTaskFinished(task: { title: string; status: string; text: string; summary: string }): void;
    interrupt(): void;
    pause(): void;
    manualListening(on: boolean): void;
  };
  return { ...callbacksUnderTest, voice, personal, agent, confirmer };
}

afterEach(() => vi.useRealTimers());

describe("main's answer speech ownership", () => {
  it("preserves spoken ownership through a formal question and speaks its post-approval completion", () => {
    vi.useFakeTimers();
    const w = wiring();
    w.onTurnStart({ text: "Update the event", spoken: true });
    w.onAnswerDelta("The old unfinished words");
    w.confirmer.waiting = true;
    w.pause();
    w.onAnswerDelta("Over the permission question.");
    expect(w.voice.speak).not.toHaveBeenCalled();
    w.confirmer.waiting = false;
    w.onAnswer("The event is updated.");
    w.onTurnEnd(false);
    expect(w.agent.pauseAnswer).toHaveBeenCalledOnce();
    expect(w.voice.speak).toHaveBeenCalledExactlyOnceWith("The event is updated.", { append: false });
    expect(w.voice.followUp).toHaveBeenCalledExactlyOnceWith(8000, { afterQuestion: false });
  });

  it("does not let an old permission closing restore interrupted or newer turn ownership", () => {
    vi.useFakeTimers();
    const w = wiring();
    w.onTurnStart({ text: "Old spoken request", spoken: true });
    w.confirmer.waiting = true;
    w.pause();
    w.interrupt();
    w.confirmer.waiting = false;
    w.onAnswer("Old interrupted completion.");
    w.onTurnEnd(false);
    expect(w.voice.speak).not.toHaveBeenCalled();
    expect(w.voice.followUp).not.toHaveBeenCalled();
    w.onTurnStart({ text: "Another spoken request", spoken: true });
    w.confirmer.waiting = true;
    w.pause();
    w.onTurnStart({ text: "Newer typed request", spoken: false });
    w.confirmer.waiting = false; // Closing a prior card changes no per-turn state.
    w.onAnswer("New typed completion.");
    w.onTurnEnd(false);
    expect(w.voice.speak).toHaveBeenCalledExactlyOnceWith("New typed completion.", { append: false });
    expect(w.voice.followUp).not.toHaveBeenCalled();
  });

  it("drops buffered words, late chunks, acknowledgements and follow-up after interruption", () => {
    vi.useFakeTimers();
    const w = wiring();
    w.onTurnStart({ text: "Open the document", spoken: true });
    w.onAnswerDelta("An unfinished old sentence");
    w.interrupt();
    w.onAnswerDelta(" arrives late. Another old sentence.");
    w.onAnswer("The whole old answer.");
    w.onAnswerEnd("A late pre-tool message.");
    vi.advanceTimersByTime(ACK_MS + 1);
    w.onTurnEnd(false);
    expect(w.voice.speak).not.toHaveBeenCalled();
    expect(w.voice.followUp).not.toHaveBeenCalled();
    expect(w.personal.answered).not.toHaveBeenCalled();
  });

  it("opens listening for the spoken turn and keeps a queued typed turn silent afterwards", () => {
    vi.useFakeTimers();
    const w = wiring();
    w.onTurnStart({ text: "Which report?", spoken: true });
    w.onAnswer("Would you like the first report?");
    w.onTurnEnd(false);
    expect(w.voice.followUp).toHaveBeenCalledExactlyOnceWith(8000, { afterQuestion: true });
    w.onTurnStart({ text: "Typed request", spoken: false });
    w.onAnswer("The typed request's answer.");
    w.onTurnEnd(false);
    vi.advanceTimersByTime(ACK_MS + 1);
    expect(w.voice.followUp).toHaveBeenCalledTimes(1);
    expect(w.voice.speak.mock.calls.map(c => c[0])).toEqual(["Would you like the first report?", "The typed request's answer."]);
  });

  it("cancels pending Listen once at turn start and answers a manual request without a follow-up window", () => {
    vi.useFakeTimers();
    const w = wiring();
    w.onTurnStart({ text: "Which report?", spoken: true, manual: true });
    expect(w.voice.cancelListenOnce).toHaveBeenCalledOnce();
    w.onAnswer("Would you like the first report?");
    w.onTurnEnd(false);
    expect(w.voice.speak).toHaveBeenCalledExactlyOnceWith("Would you like the first report?", { append: false });
    expect(w.voice.followUp).not.toHaveBeenCalled();
  });

  it("keeps background results on cards during a foreground request and appends them after playback", () => {
    const w = wiring();
    const task = { title: "A background task", status: "done", text: "The task is done.", summary: "Done" };
    w.agent.answerOpen = true;
    w.onTaskFinished(task);
    expect(w.voice.speak).not.toHaveBeenCalled();
    w.agent.answerOpen = false;
    w.voice.micState = "active";
    w.onTaskFinished(task);
    expect(w.voice.speak).not.toHaveBeenCalled();
    w.voice.micState = "waiting";
    w.manualListening(true); // Voice Match is still checking a manually started request.
    w.onTaskFinished(task);
    expect(w.voice.speak).not.toHaveBeenCalled();
    w.manualListening(false);
    w.onTaskFinished(task);
    expect(w.voice.speak).toHaveBeenCalledExactlyOnceWith("The task is done.", { append: true });
  });
});
