/** Exercise main's actual speech callbacks without starting Electron, a microphone or audio playback. */
import fs from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpeechStream } from "../../app/voice/tts";
import { AnswerLanguage, endsWithQuestion, spokenText } from "../../app/voice/spoken";
import { TurnLatency } from "../../app/main/turn-latency";
import { ACK_MS, acknowledgement, afterAck } from "../../app/main/acknowledge";
import { speaksAloud, speechSilenced } from "../../app/shared/speech";
import { IPC } from "../../app/shared/ipc";
import { taskNotice } from "../../app/main/agent/tasks";

function wiring() {
  const source = fs.readFileSync("app/main/main.ts", "utf8");
  const speech = source.slice(source.indexOf("  let accountErasures ="), source.indexOf("  // ───── Copilot brain"));
  const callbacks = source.slice(source.indexOf("      onTurnStart: turn =>"), source.indexOf("      onStatus: status =>", source.indexOf("      onTurnStart: turn =>")));
  const taskCallback = source.slice(source.indexOf("      onTaskFinished: t =>"), source.indexOf("      isOnline:", source.indexOf("      onTaskFinished: t =>")));
  const transcriptCallback = source.slice(source.indexOf("      onTranscript: (entries, why) =>"), source.indexOf("      // Another account signed in:", source.indexOf("      onTranscript: (entries, why) =>")));
  const learnedForgot = source.slice(source.indexOf("    onForgotAll: () => {"), source.indexOf("    // One fact forgotten", source.indexOf("    onForgotAll: () => {")));
  const signOut = source.slice(source.indexOf("  ipcMain.handle(IPC.signOut,"), source.indexOf("  ipcMain.handle(IPC.cancelSignIn,"));
  expect(speech.length).toBeGreaterThan(500);
  expect(callbacks.length).toBeGreaterThan(500);
  const voice = { speak: vi.fn(), hush: vi.fn(), followUp: vi.fn(), cancelListenOnce: vi.fn(), warmSpeech: vi.fn(), micState: "waiting", speaking: false };
  /** The speaking choice (always, as by default here) and whether a screen reader runs. */
  const prefs = { speak: true, speakWithScreenReader: true, reader: true };
  const agent = { answerOpen: false, tasks: null, pauseAnswer: vi.fn(), interruptAnswer: vi.fn(), abortAll: vi.fn(), forgetConversation: vi.fn(async (): Promise<void> => undefined), start: vi.fn(async (): Promise<void> => undefined) };
  const broadcast = vi.fn();
  const voicePreference = { natural: true, naturalModel: "kitten" };
  const confirmer = { waiting: false };
  const personal = { answered: vi.fn(() => null) };
  const code = ts.transpile(`
    let lastAskByVoice = false, turnAnswer = "", lastReply = "";
    const log = { info() {} }, policy = { features: {} }, screenLock = null;
    const sys = { a11y: { screenReaderOn: () => prefs.reader } };
    let askedAt = 0;
    let manualCall = null;
    const syncListenOnce = () => {};
    const lastState = { bubble: { visible: false } }, showState = () => {};
    const settings = { get: () => ({ speak: prefs.speak, speakWithScreenReader: prefs.speakWithScreenReader, speakResults: true, voice: voicePreference }) }, userAway = () => false, notify = () => {};
    let signOutHandler;
    const ipcMain = { handle: (_channel, callback) => { signOutHandler = callback; } }, guard = fn => fn;
    let signOuts = 0, currentToken = null, askHistory = [], learnedLines = [];
    const signInAbort = { abort() {} }, keeper = { use() {} }, tokens = { clear() {} }, providers = { forget() {} }, refusedTokens = new Set();
    const conversationNow = (entries = []) => entries;
    const forgetProject = () => {};
    ${speech}
    ${signOut}
    return {
      ${callbacks} ${taskCallback} ${transcriptCallback} ${learnedForgot}
      interrupt: resetAnswerSpeech, pause: pauseAnswerSpeech, signOut: () => signOutHandler(), silenceIfOff, stopSpeaking,
      manualListening: on => { manualCall = on ? { source: "ask" } : null; },
    };
  `, { target: ts.ScriptTarget.ES2022 });
  const run = new Function("SpeechStream", "AnswerLanguage", "TurnLatency", "ACK_MS", "acknowledgement", "afterAck", "endsWithQuestion", "spokenText", "speaksAloud", "speechSilenced", "IPC", "broadcast", "voicePreference", "voice", "personal", "agent", "confirmer", "taskNotice", "prefs", code);
  const callbacksUnderTest = run(SpeechStream, AnswerLanguage, TurnLatency, ACK_MS, acknowledgement, afterAck, endsWithQuestion, spokenText, speaksAloud, speechSilenced, IPC, broadcast, voicePreference, voice, personal, agent, confirmer, taskNotice, prefs) as {
    onTurnStart(turn: { text: string; spoken: boolean; manual?: true }): void;
    onAnswerDelta(text: string): void;
    onAnswer(text: string): void;
    onAnswerEnd(text: string): void;
    onTurnEnd(aborted: boolean): void;
    onTaskFinished(task: { title: string; status: string; text: string; summary: string }): void;
    onTranscript(entries: unknown[], why?: "new-conversation"): void;
    onForgotAll(): void;
    signOut(): Promise<void>;
    interrupt(): void;
    pause(): void;
    silenceIfOff(): boolean;
    stopSpeaking(source: "menu"): void;
    manualListening(on: boolean): void;
  };
  return { ...callbacksUnderTest, voice, personal, agent, confirmer, broadcast, voicePreference, prefs };
}

afterEach(() => vi.useRealTimers());

describe("main's answer speech ownership", () => {
  it("retires queued acknowledgement and late old-account speech before asynchronous sign-out work", async () => {
    vi.useFakeTimers();
    const w = wiring();
    let finish!: () => void;
    w.agent.forgetConversation.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    w.onTurnStart({ text: "Open the document", spoken: true });
    w.onAnswerDelta("A private unfinished sentence");
    const hushes = w.voice.hush.mock.calls.length;
    const signingOut = w.signOut();
    expect(w.voice.hush).toHaveBeenCalledTimes(hushes + 1);
    expect(w.agent.forgetConversation).toHaveBeenCalledOnce();
    // Runtime/task callbacks arriving while teardown waits cannot begin new playback or another acknowledgement.
    w.onTurnStart({ text: "Another old queued request", spoken: true });
    w.onAnswerDelta("Private old words. Another private sentence.");
    w.onAnswer("The late old answer.");
    w.onTaskFinished({ title: "Old private task", status: "done", text: "Private result.", summary: "Done" });
    vi.advanceTimersByTime(ACK_MS + 1);
    expect(w.voice.speak).not.toHaveBeenCalled();
    finish();
    await signingOut;
    w.onAnswerDelta("An old delta after sign-out.");
    w.onAnswerEnd("The old final message.");
    w.onTurnEnd(false);
    vi.advanceTimersByTime(ACK_MS + 1);
    expect(w.voice.speak).not.toHaveBeenCalled();
    expect(w.voice.followUp).not.toHaveBeenCalled();
    expect(w.voicePreference).toEqual({ natural: true, naturalModel: "kitten" });
    w.onTurnStart({ text: "The new account’s own request", spoken: false });
    w.onAnswer("Only the new reply.");
    expect(w.voice.speak).toHaveBeenCalledExactlyOnceWith("Only the new reply.", { append: false, lang: null });
  });

  it("hushes authoritative account erasure, while an ordinary empty learned-fact view preserves speech", () => {
    vi.useFakeTimers();
    const w = wiring();
    w.onTurnStart({ text: "Open the document", spoken: true });
    const hushes = w.voice.hush.mock.calls.length;
    w.onForgotAll();
    expect(w.broadcast).toHaveBeenLastCalledWith(IPC.conversationChanged, []);
    expect(w.voice.hush).toHaveBeenCalledTimes(hushes);
    w.onTranscript([{ who: "you", text: "Open the document" }]);
    expect(w.voice.hush).toHaveBeenCalledTimes(hushes);
    w.onTranscript([]);
    expect(w.voice.hush).toHaveBeenCalledTimes(hushes + 1);
    expect(w.broadcast).toHaveBeenCalledWith(IPC.conversationForgotten, null);
    // Home's own New conversation hushes too, but isn't announced as a forgetting (review of #184).
    w.broadcast.mockClear();
    w.onTranscript([], "new-conversation");
    expect(w.voice.hush).toHaveBeenCalledTimes(hushes + 2);
    expect(w.broadcast).not.toHaveBeenCalledWith(IPC.conversationForgotten, null);
    expect(w.broadcast).toHaveBeenCalledWith(IPC.conversationChanged, []);
    w.onAnswer("The erased account’s answer.");
    vi.advanceTimersByTime(ACK_MS + 1);
    expect(w.voice.speak).not.toHaveBeenCalled();
    expect(w.voicePreference).toEqual({ natural: true, naturalModel: "kitten" });
  });

  it("keeps the failed sign-out’s speech retired and lets a later account’s own turn speak", async () => {
    const w = wiring();
    w.agent.forgetConversation.mockRejectedValue(new Error("Erasure failed"));
    w.onTurnStart({ text: "Old request", spoken: true });
    await expect(w.signOut()).rejects.toThrow("Erasure failed");
    w.onAnswer("The old answer after failed erasure.");
    expect(w.voice.speak).not.toHaveBeenCalled();
    w.onTurnStart({ text: "Another account’s request", spoken: false });
    w.onAnswer("The current account’s answer.");
    expect(w.voice.speak).toHaveBeenCalledExactlyOnceWith("The current account’s answer.", { append: false, lang: null });
    expect(w.voicePreference).toEqual({ natural: true, naturalModel: "kitten" });
  });
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
    expect(w.voice.speak).toHaveBeenCalledExactlyOnceWith("The event is updated.", { append: false, lang: null });
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
    expect(w.voice.speak).toHaveBeenCalledExactlyOnceWith("New typed completion.", { append: false, lang: null });
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
    expect(w.voice.speak).toHaveBeenCalledExactlyOnceWith("Would you like the first report?", { append: false, lang: null });
    expect(w.voice.followUp).not.toHaveBeenCalled();
  });

  it("loads Ember's voice as a typed request starts, so the answer isn't heard 2 s after it is shown (voice-speaking-1)", () => {
    const w = wiring();
    w.onTurnStart({ text: "What's the weather?", spoken: false });
    expect(w.voice.warmSpeech).toHaveBeenCalledOnce();
    // Speaking set to Never: nothing is loaded.
    w.prefs.speak = false; w.prefs.speakWithScreenReader = false;
    w.onTurnStart({ text: "And tomorrow?", spoken: false });
    expect(w.voice.warmSpeech).toHaveBeenCalledOnce();
    // The ask box loads it as it opens, too.
    const main = fs.readFileSync("app/main/main.ts", "utf8");
    const reveal = main.slice(main.indexOf("    onReveal: source => {"), main.indexOf("    onKeyboard: () =>"));
    expect(reveal).toContain("if (maySpeak()) voice?.warmSpeech();");
  });

  it("stops what Ember is saying at once when speaking is set to Never, not at the end of the answer (voice-speaking-4)", () => {
    const w = wiring();
    w.onTurnStart({ text: "Tell me about the reports", spoken: false });
    w.onAnswerDelta("The first sentence. The second");
    expect(w.voice.speak).toHaveBeenCalledOnce();
    w.voice.speaking = true;
    const hushes = w.voice.hush.mock.calls.length;
    // Settings › Voice › Speak: Never (main runs this on every settings change).
    w.prefs.speak = false; w.prefs.speakWithScreenReader = false;
    expect(w.silenceIfOff()).toBe(false);
    expect(w.voice.hush).toHaveBeenCalledTimes(hushes + 1);
    // Once quiet, another change hushes nothing more, and the rest of the answer isn't said.
    w.voice.speaking = false;
    w.silenceIfOff();
    w.onAnswerDelta(" sentence. The third sentence.");
    w.onAnswer("The first sentence. The second sentence. The third sentence.");
    expect(w.voice.hush).toHaveBeenCalledTimes(hushes + 1);
    expect(w.voice.speak).toHaveBeenCalledOnce();
    expect(fs.readFileSync("app/main/main.ts", "utf8")).toContain("settings.onChange(() => silenceIfOff());");
  });

  it("stops talking at the next sentence when the screen reader it spoke for has gone (voice-speaking-4)", () => {
    const w = wiring();
    w.prefs.speak = false; // "While a screen reader runs", the default.
    w.onTurnStart({ text: "Tell me about the reports", spoken: false });
    w.onAnswerDelta("The first sentence. The second");
    expect(w.voice.speak).toHaveBeenCalledOnce();
    w.voice.speaking = true;
    const hushes = w.voice.hush.mock.calls.length;
    w.prefs.reader = false;
    w.onAnswerDelta(" sentence. The third sentence.");
    expect(w.voice.hush).toHaveBeenCalledTimes(hushes + 1);
    expect(w.voice.speak).toHaveBeenCalledOnce();
  });

  it("stops Ember talking from the handle's menu without stopping its tasks or the answer's words (voice-speaking-5)", () => {
    const w = wiring();
    w.onTurnStart({ text: "Tell me about the reports", spoken: false });
    w.onAnswerDelta("The first sentence. The second");
    w.agent.answerOpen = true;
    const hushes = w.voice.hush.mock.calls.length;
    w.stopSpeaking("menu");
    expect(w.agent.interruptAnswer).not.toHaveBeenCalled();
    expect(w.voice.hush).toHaveBeenCalledTimes(hushes + 1);
    expect(w.agent.abortAll).not.toHaveBeenCalled();
    // The rest of this answer isn't said; the next request's answer is.
    w.onAnswerDelta(" sentence. The third sentence.");
    expect(w.voice.speak).toHaveBeenCalledOnce();
    w.onTurnStart({ text: "And the next one?", spoken: false });
    w.onAnswer("The next answer.");
    expect(w.voice.speak).toHaveBeenCalledTimes(2);
    // Offered only while Ember speaks, beside Stop everything.
    const main = fs.readFileSync("app/main/main.ts", "utf8");
    expect(main).toContain(`...(voice?.speaking ? [{ label: "Stop speaking", click: () => stopSpeaking("menu") }] : []),`);
  });

  it("keeps the whole answer after Stop speaking: the conductor isn't stopped, and the reply is still the last answer (voice-speaking-c1-1)", () => {
    const w = wiring();
    w.onTurnStart({ text: "Tell me about the reports", spoken: true });
    w.onAnswerDelta("The first is a list of sales. The second");
    w.agent.answerOpen = true;
    w.voice.speaking = true;
    w.stopSpeaking("menu");
    // Only the voice stops: the conductor's answer goes on reaching the bubble, Home and the transcript.
    expect(w.agent.interruptAnswer).not.toHaveBeenCalled();
    const spoken = w.voice.speak.mock.calls.length;
    w.onAnswerDelta(" is a list of costs. The third is a summary of both, with a marker word.");
    w.onAnswerEnd("The first is a list of sales. The second is a list of costs. The third is a summary of both, with a marker word.");
    w.onAnswer("The first is a list of sales. The second is a list of costs. The third is a summary of both, with a marker word.");
    expect(w.voice.speak).toHaveBeenCalledTimes(spoken);
    w.agent.answerOpen = false;
    w.onTurnEnd(false);
    // The turn ended whole: what the user might say next is worked out from the whole reply, and nothing listens on
    // after a voice the user chose to silence.
    expect(w.personal.answered).toHaveBeenCalledWith("The first is a list of sales. The second is a list of costs. The third is a summary of both, with a marker word.", expect.objectContaining({ spoken: false }));
    expect(w.voice.followUp).not.toHaveBeenCalled();
    expect(w.voice.speak).toHaveBeenCalledTimes(spoken);
    // The next request speaks again.
    w.onTurnStart({ text: "And the next one?", spoken: false });
    w.onAnswer("The next answer.");
    expect(w.voice.speak).toHaveBeenLastCalledWith("The next answer.", { append: false, lang: null });
  });

  it("still ends a turn stopped by a cut-in as stopped, after an earlier Stop speaking (voice-speaking-c1-1)", () => {
    const w = wiring();
    w.onTurnStart({ text: "Tell me about the reports", spoken: false });
    w.onAnswerDelta("The first sentence. The second");
    w.agent.answerOpen = true;
    w.stopSpeaking("menu");
    // A wake or a cut-in stops the answer itself: nothing of it counts as answered.
    w.interrupt();
    w.onAnswer("The first sentence. The second sentence.");
    w.onTurnEnd(false);
    expect(w.personal.answered).not.toHaveBeenCalled();
  });

  it("says an English answer's list of films in Ember's voice, its language decided once for the answer (voice-speaking-r1)", () => {
    const w = wiring();
    w.onTurnStart({ text: "Suggest three films", spoken: false });
    const answer = "Here are three films you might like:\n1. La La Land\n2. Les Misérables\n3. Amélie\n\nShall I find where to watch them?";
    for (let i = 0; i < answer.length; i += 4) w.onAnswerDelta(answer.slice(i, i + 4));
    w.onAnswer(answer);
    const calls = w.voice.speak.mock.calls as [string, { append: boolean; lang: string | null }][];
    expect(calls.map(c => c[0]).join(" ")).toBe("Here are three films you might like: 1. La La Land. 2. Les Misérables. 3. Amélie. Shall I find where to watch them?");
    expect(calls.map(c => c[1].lang)).toEqual(calls.map(() => null));
    // The first words weren't held back to decide.
    expect(calls[0][0]).toBe("Here are three films you might like:");
  });

  it("says the first words of an answer to a request typed in another language in that language too (voice-speaking-11)", () => {
    const w = wiring();
    w.onTurnStart({ text: "Peux-tu ouvrir les fichiers que je t'ai envoyés ?", spoken: false });
    const answer = "D'accord. Voici les trois fichiers que vous avez demandés. Le premier est le rapport de ventes.";
    for (let i = 0; i < answer.length; i += 4) w.onAnswerDelta(answer.slice(i, i + 4));
    w.onAnswer(answer);
    const calls = w.voice.speak.mock.calls as [string, { append: boolean; lang: string | null }][];
    expect(calls[0][0]).toBe("D'accord.");
    expect(calls.map(c => c[1].lang)).toEqual(calls.map(() => "fr"));
    // The next answer is judged afresh.
    w.onTurnStart({ text: "Open the report", spoken: false });
    w.onAnswer("Done. I opened Por Una Cabeza.");
    expect(w.voice.speak).toHaveBeenLastCalledWith("Done. I opened Por Una Cabeza.", { append: false, lang: null });
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
