/**
 * Ember's own status answer (app/main/agent/status.ts): "Ember?", "status?" and "what are you doing?" are answered at
 * once from the tasks' state, in FRIDAY's grammar (what's under way, how far, what's next), with no Copilot turn, so they
 * work offline. Anything longer or different still goes to the conductor.
 */

import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Logger } from "../../app/main/logger";

vi.mock("@github/copilot-sdk", async importOriginal => {
  const real = await importOriginal<typeof import("@github/copilot-sdk")>();
  class FakeClient { constructor() { throw new Error("no Copilot client in this test"); } }
  return { ...real, CopilotClient: FakeClient, RuntimeConnection: { forStdio: () => ({}) } };
});

import { CATCH_UP_MS, catchUpQuestion, catchUpReply, durationWords, RECENT_MS, RESULTS_REPLY, resultsRequest, statusQuestion, statusReply } from "../../app/main/agent/status";
import type { Task } from "../../app/main/agent/tasks";
import { AgentHost } from "../../app/main/agent/host";
import { SettingsStore } from "../../app/main/settings";
import type { BubbleState, EmberState } from "../../app/shared/overlay";

const NOW = 1_800_000_000_000;
const task = (over: Partial<Task>): Task => ({
  id: "t1", goal: "Tidy the desktop", title: "Tidy the desktop", status: "running", detail: "", result: null,
  started: NOW - 95_000, finished: null, ...over,
});

describe("statusQuestion", () => {
  it("hears the name alone as a call, however it is punctuated", () => {
    for (const t of ["Ember?", "ember", "Hey Ember!", "hey, Ember…"]) expect(statusQuestion(t)).toBe("name");
  });

  it("hears the usual ways of asking how a task is going", () => {
    for (const t of [
      "status?", "Ember, status", "status update", "progress report", "What are you doing?", "what are you working on right now",
      "How's it going?", "how’s it going", "how is the task going", "are you done yet?", "Is it finished?", "what's happening",
      "ok Ember what are you up to", "how far along are you",
    ]) expect(statusQuestion(t), t).toBe("status");
  });

  it("leaves every other request to Copilot (a request that only starts like a status question is the conductor's)", () => {
    for (const t of [
      "update", "update my system", "what's the status of my order on Amazon", "what are you doing tomorrow at 3",
      "how are you", "Ember, tidy the desktop", "remember my name is Priya", "", "status ".repeat(20),
    ]) expect(statusQuestion(t), t).toBeNull();
  });
});

describe("statusReply", () => {
  it("says the step a running task is on, from its plan (FRIDAY's state-first answer)", () => {
    const plan = [{ text: "Open Files", state: "done" as const }, { text: "Move the screenshots.", state: "now" as const }, { text: "Empty the folder", state: "todo" as const }];
    expect(statusReply("status", [task({ plan })], NOW)).toBe("Working on “Tidy the desktop”: step 2 of 3, Move the screenshots.");
  });

  it("says how long a task without a plan has been at it, rather than guessing how far it has got", () => {
    expect(statusReply("name", [task({})], NOW)).toBe("Working on “Tidy the desktop”, about 2 minutes in.");
  });

  it("names a guide as showing the user, where a task runs elsewhere, and how many wait", () => {
    const tasks = [
      task({ mode: "guide", title: "Turn on dark mode" }),
      task({ id: "t2", title: "Check the logs", where: "on build-01", started: NOW - 4000 }),
      task({ id: "t3", status: "queued" }), task({ id: "t4", status: "queued" }),
    ];
    expect(statusReply("status", tasks, NOW)).toBe(
      "Showing you “Turn on dark mode”, about 2 minutes in. Working on “Check the logs” on build-01, a few seconds in. 2 more are waiting to start.",
    );
  });

  it("answers the name with an offer to help when nothing is under way, and a status question plainly", () => {
    expect(statusReply("name", [], NOW)).toBe("Yes? What can I do for you?");
    expect(statusReply("status", [], NOW)).toBe("Nothing's running right now.");
  });

  it("mentions the last task only while it is recent, and how it went in the user's words", () => {
    const done = task({ status: "done", finished: NOW - 60_000 });
    const stopped = task({ id: "t2", title: "Check the logs", status: "cancelled", finished: NOW - 30_000 });
    expect(statusReply("status", [done, stopped], NOW)).toBe("Nothing's running right now. The last thing was “Check the logs”: you stopped it.");
    expect(statusReply("status", [task({ status: "failed", finished: NOW - 1000 })], NOW)).toBe("Nothing's running right now. The last thing was “Tidy the desktop”: it didn't finish.");
    expect(statusReply("status", [task({ status: "done", finished: NOW - RECENT_MS - 1 })], NOW)).toBe("Nothing's running right now.");
  });

  it("says durations the way people do", () => {
    expect(durationWords(3000)).toBe("a few seconds");
    expect(durationWords(42_000)).toBe("42 seconds");
    expect(durationWords(70_000)).toBe("about a minute");
    expect(durationWords(600_000)).toBe("about 10 minutes");
  });
});

describe("resultsRequest", () => {
  it("hears “just show me” and its kin as results on screen only (JARVIS's “leave it on the screen”)", () => {
    for (const t of ["Ember, just show me", "just show it", "Stop telling me.", "leave it on the screen", "leave them on screen", "stop reading them out", "don't read the results aloud"]) expect(resultsRequest(t), t).toBe("quiet");
  });

  it("hears the way back", () => {
    for (const t of ["read them out again", "Ember, read the results aloud", "tell me when it's done", "you can talk again"]) expect(resultsRequest(t), t).toBe("loud");
  });

  it("leaves requests that only sound alike to Copilot", () => {
    for (const t of ["show me how to change the wallpaper", "just show me the downloads folder", "read this email out", "tell me a joke", "stop"]) expect(resultsRequest(t), t).toBeNull();
  });
});

describe("catch-up", () => {
  it("hears the ways of asking what happened while the user was away", () => {
    for (const t of ["What did I miss?", "Ember, catch me up", "anything new?", "what happened while I was away", "fill me in", "what did you get done"]) expect(catchUpQuestion(t), t).toBe(true);
    for (const t of ["what did I miss in the meeting notes", "catch the bus", "status?", ""]) expect(catchUpQuestion(t), t).toBe(false);
  });

  it("names the tasks that finished lately, newest first, each in one sentence, and what is still under way", () => {
    const tasks = [
      task({ id: "a", title: "Tidy the desktop", status: "done", finished: NOW - 3_600_000, result: { success: true, summary: "Moved 3 screenshots to Pictures. Left the rest alone." } }),
      task({ id: "b", title: "Check the logs", status: "failed", finished: NOW - 600_000, result: { success: false, summary: "No log folder." } }),
      task({ id: "c", title: "Old one", status: "done", finished: NOW - CATCH_UP_MS - 1 }),
      task({ id: "d", title: "Write the report" }),
    ];
    expect(catchUpReply(tasks, NOW)).toBe("2 tasks finished. “Check the logs”: it didn't finish. “Tidy the desktop”: done. Moved 3 screenshots to Pictures. One task is still under way.");
  });

  it("counts the rest beyond three, and says plainly when nothing finished", () => {
    const many = [1, 2, 3, 4, 5].map(i => task({ id: `t${i}`, title: `Task ${i}`, status: "done", finished: NOW - i * 1000 }));
    expect(catchUpReply(many, NOW)).toBe("5 tasks finished. “Task 1”: done. “Task 2”: done. “Task 3”: done. And 2 more.");
    expect(catchUpReply([], NOW)).toBe("Nothing new: no tasks finished in the last two hours.");
  });
});

describe("AgentHost's status answer", () => {
  const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

  it("answers “Ember?” at once without Copilot (signed out, no client), speaks it and opens the follow-up", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-status-"));
    const settings = new SettingsStore(path.join(dir, "settings.json"));
    settings.load();
    const bubbles: BubbleState[] = [];
    const answers: string[] = [];
    const ends: boolean[] = [];
    const host = new AgentHost({
      userData: dir, runtimePath: "/nowhere/copilot-runtime", settings, log: quiet,
      setState: (p: Partial<EmberState>) => { if (p.bubble) bubbles.push(p.bubble); }, onStatus: () => undefined,
      onAnswer: t => answers.push(t), onTurnEnd: a => ends.push(a),
    });
    await host.ask("Ember?");
    expect(bubbles.at(-1)).toMatchObject({ visible: true, title: "Ember", thought: "Yes? What can I do for you?", streaming: false });
    expect(answers).toEqual(["Yes? What can I do for you?"]);
    expect(ends).toEqual([false]);
    expect(host.getTranscript().map(e => [e.who, e.text])).toEqual([["you", "Ember?"], ["ember", "Yes? What can I do for you?"]]);
    // Anything else still goes the usual way: signed out, it is told to connect GitHub.
    await host.ask("tidy the desktop");
    expect(bubbles.at(-1)?.thought).toMatch(/Connect your GitHub account/);
  });

  it("turns reading results aloud off and on by request, saved in settings, and says so", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-status-"));
    const settings = new SettingsStore(path.join(dir, "settings.json"));
    settings.load();
    expect(settings.get().speakResults).toBe(true);
    const answers: string[] = [];
    const host = new AgentHost({
      userData: dir, runtimePath: "/nowhere/copilot-runtime", settings, log: quiet,
      setState: () => undefined, onStatus: () => undefined, onAnswer: t => answers.push(t),
    });
    await host.ask("Ember, just show me");
    expect(settings.get().speakResults).toBe(false);
    await host.ask("read them out again");
    expect(settings.get().speakResults).toBe(true);
    expect(answers).toEqual([RESULTS_REPLY.quiet, RESULTS_REPLY.loud]);
  });
});
