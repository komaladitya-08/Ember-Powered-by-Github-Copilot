/**
 * Home's "Task activity" words (app/renderer/home/tasks-copy.ts) and the question's decision main keeps for it
 * (app/main/agent/activity.ts askedWords): one group per task, its rows with their time after it started, steps of one
 * kind folded with each still listed, questions with how they were answered (t3code_generative_ui.md §3.3).
 */

import { describe, expect, it } from "vitest";
import { ActivityLog, askedWords } from "../../app/main/agent/activity";
import { FILTER_EMPTY, NOTE_TAG, askingTask, TASKS_EMPTY, TASK_FILTER_FROM, droppedText, filterLabel, filterTasks, offersRetry, offsetText, offsetWords, stateWord, stepsLine, taskAnnouncement, taskMeta, timelineRows } from "../../app/renderer/home/tasks-copy";
import { withQuestionUp, type ActivityItem, type TaskActivity, type TaskEntry } from "../../app/shared/activity";

const step = (id: string, at: number, group: ActivityItem["group"], app: string, state: ActivityItem["state"] = "done", words = `${group} in ${app}`): ActivityItem =>
  ({ id, kind: "step", at, state, words, group, app });

describe("a task's rows in Home", () => {
  it("say when each happened after the task started, in tabular figures and in words", () => {
    expect(offsetText(3200)).toBe("0:03");
    expect(offsetText(72_000)).toBe("1:12");
    expect(offsetText(3_725_000)).toBe("1:02:05");
    expect(offsetWords(3000)).toBe("3 seconds in");
    expect(offsetWords(72_000)).toBe("1 minute 12 seconds in");
    expect(offsetWords(120_000)).toBe("2 minutes in");
    expect(offsetWords(0)).toBe("0 seconds in");
  });

  it("fold steps of one kind and outcome into one row that lists each, and keep the rest as rows of their own", () => {
    const items: ActivityItem[] = [
      step("a", 0, "open", "Files", "done", "Opened an app in Files"),
      step("b", 1000, "type", "Files", "done", "Typed text in Files"),
      step("c", 2000, "type", "Files", "done", "Typed text in Files"),
      step("d", 3000, "type", "Files", "done", "Typed text in Files"),
      { id: "q", kind: "question", at: 4000, state: "done", words: "Asked you: you allowed it", asked: "Rename 12 files in Files?" },
      { id: "n", kind: "note", at: 5000, state: "done", words: "Two left.", model: true },
      step("e", 6000, "type", "Files", "running", "Typing in Files"),
    ];
    const rows = timelineRows(items);
    expect(rows.map(r => r.words)).toEqual(["Opened an app in Files", "Typed text 3 times in Files", "Asked you: you allowed it", "Two left.", "Typing in Files"]);
    expect(rows[1].steps?.map(s => s.id)).toEqual(["b", "c", "d"]);
    expect(rows[0].steps).toBeUndefined();
    expect(rows[2]).toMatchObject({ asked: "Rename 12 files in Files?" });
    expect(rows[3]).toMatchObject({ model: true });
    // A failed step doesn't fold into the ones that worked, and says what it tried.
    const mixed = timelineRows([step("a", 0, "click", "Settings"), step("b", 1, "click", "Settings", "failed"), step("c", 2, "click", "Settings", "failed")]);
    expect(mixed.map(r => r.words)).toEqual(["click in Settings", "Tried to click 2 times in Settings"]);
  });

  it("head each task with its state, its clock and how it works", () => {
    const a = (o: Partial<TaskActivity>): TaskActivity => ({ startedAt: 0, items: [], dropped: 0, steps: 0, failedSteps: 0, counts: {}, questions: 0, approvals: 0, asking: false, retry: 0, slow: false, nearLimit: false, live: "", ...o });
    expect(taskMeta({ status: "waiting", hand: "background", activity: a({}) }, 74_000)).toBe("Waiting for you · 1:14 · In the background");
    expect(taskMeta({ status: "done", activity: a({ endedAt: 72_000 }) }, 999_999)).toBe("Done · Took 1:12");
    expect(taskMeta({ status: "running", hand: "desk", where: "on build-01", activity: a({}) }, 2000)).toBe("Working · Just started · On my desk · on build-01");
    expect(stepsLine({ activity: a({ counts: { click: 2, read: 1 }, failedSteps: 1 }) })).toBe("Clicked 2 times and read the window (1 didn't work)");
    expect(stepsLine({ activity: a({}) })).toBeNull();
  });

  it("names what isn't listed, the empty list's next step, a note's tag and the change a screen reader hears", () => {
    expect(droppedText(0)).toBeNull();
    expect(droppedText(1)).toBe("1 earlier item isn't listed");
    expect(droppedText(12)).toBe("12 earlier items aren't listed");
    expect(TASKS_EMPTY).toBe("No tasks yet. Ask Ember to do something in your apps, with Ask Ember… above, and each step shows here as it happens.");
    expect(NOTE_TAG).toBe("Note");
    expect(taskAnnouncement("Turn on Night Light", "done")).toBe("Turn on Night Light: Done");
    expect(taskAnnouncement("Turn on Night Light", "failed")).toBe("Turn on Night Light: Didn't finish");
  });

  it("gives a task still in line no clock: it hasn't begun, so never “Just started” (tasks-approvals-r3)", () => {
    const a: TaskActivity = { startedAt: 0, items: [], dropped: 0, steps: 0, failedSteps: 0, counts: {}, questions: 0, approvals: 0, asking: false, retry: 0, slow: false, nearLimit: false, live: "" };
    expect(taskMeta({ status: "queued", activity: a }, 2000)).toBe("Waiting its turn");
    expect(taskMeta({ status: "queued", where: "on build-01", activity: a }, 74_000)).toBe("Waiting its turn · on build-01");
  });

  it("gives a task stopped before it began no clock either, never “Took 3s” beside “stopped before it started” (tasks-approvals-r3-3)", () => {
    const a: TaskActivity = { startedAt: 0, endedAt: 3000, items: [], dropped: 0, steps: 0, failedSteps: 0, counts: {}, questions: 0, approvals: 0, asking: false, retry: 0, slow: false, nearLimit: false, live: "" };
    expect(taskMeta({ status: "stopped", unstarted: true, activity: a }, 9000)).toBe("Stopped");
    expect(taskMeta({ status: "failed", unstarted: true, where: "on build-01", activity: a }, 9000)).toBe("Didn't finish · on build-01");
    // One that began keeps its clock.
    expect(taskMeta({ status: "stopped", activity: a }, 9000)).toBe("Stopped · Took 3s");
  });

  it("says a task whose question went unanswered ended for that, never that it was stopped (tasks-approvals-c1-2)", () => {
    const a: TaskActivity = { startedAt: 0, endedAt: 125_000, items: [], dropped: 0, steps: 0, failedSteps: 0, counts: {}, questions: 1, approvals: 0, asking: false, retry: 0, slow: false, nearLimit: false, live: "" };
    expect(stateWord({ status: "stopped", unanswered: true })).toBe("No answer in time");
    expect(stateWord({ status: "stopped" })).toBe("Stopped");
    expect(taskMeta({ status: "stopped", unanswered: true, activity: a }, 999_999)).toBe("No answer in time · Took 2:05");
    expect(taskAnnouncement("Send the report", "stopped", true)).toBe("Send the report: No answer in time");
    expect(taskAnnouncement("Send the report", "stopped")).toBe("Send the report: Stopped");
  });

  it("offers Try again only while it can be pressed, never a greyed one nothing explains once the card has gone (tasks-approvals-r3-5)", () => {
    const can = { stop: false, retry: true, window: false }, cannot = { ...can, retry: false };
    expect(offersRetry({ status: "failed", controls: can })).toBe(true);
    // (A stopped task offers it only when its question went unanswered: main says so in its controls.)
    expect(offersRetry({ status: "stopped", controls: can })).toBe(true);
    // The card went (its time ran out, or Ember reconnected), or a guide: as for a task nobody answered, no button.
    expect(offersRetry({ status: "failed", controls: cannot })).toBe(false);
    expect(offersRetry({ status: "failed" })).toBe(false);
    expect(offersRetry({ status: "stopped", controls: cannot })).toBe(false);
    for (const status of ["done", "running", "waiting", "queued"] as const) expect(offersRetry({ status, controls: can })).toBe(false);
  });
});

describe("Task activity's filter (shown from five tasks)", () => {
  it("shows all, those that need you, those at work or those that ended, each with its count", () => {
    const list = (["waiting", "running", "queued", "done", "failed", "stopped"] as const).map(status => ({ status }));
    expect(TASK_FILTER_FROM).toBe(5);
    expect(filterTasks(list, "all")).toHaveLength(6);
    expect(filterTasks(list, "needs").map(t => t.status)).toEqual(["waiting"]);
    expect(filterTasks(list, "working").map(t => t.status)).toEqual(["running", "queued"]);
    expect(filterTasks(list, "ended").map(t => t.status)).toEqual(["done", "failed", "stopped"]);
    expect(filterLabel("all", list)).toBe("All");
    expect(filterLabel("needs", list)).toBe("Needs you (1)");
    expect(filterLabel("ended", list)).toBe("Ended (3)");
    expect(FILTER_EMPTY).toBe("No tasks here. Choose All to see every task.");
  });
});

describe("what a question asked, kept for Home (review of PR #125)", () => {
  it("is Ember's own words from the step's kind and app, never typed text or names from the screen", () => {
    expect(askedWords({ kind: "click", app: "Mail" })).toBe("Click in Mail?");
    expect(askedWords({ kind: "text", app: "Mail" })).toBe("Type text in Mail?");
    expect(askedWords({ kind: "cursor_text", app: "Text Editor" })).toBe("Type with your keyboard in Text Editor?");
    expect(askedWords({ kind: "cursor_click", app: "Files", onDesk: true })).toBe("Click in Files on my desk?");
    expect(askedWords({ kind: "cursor_text", app: "Calc", cells: 3 })).toBe("Fill 3 cells in Calc?");
    expect(askedWords({ kind: "setting" })).toBe("Change a setting?");
    expect(askedWords({ kind: "command" })).toBe("Run a command?");
    expect(askedWords({ kind: "consent" })).toBe("Agree to turn this on?");
    expect(askedWords({ kind: "something-new", app: "Mail" })).toBe("Take a step in Mail?");
  });

  it("goes on the question's row with where it is answered, and the card's rows never show it", () => {
    const l = new ActivityLog(0);
    l.add({ type: "question", asked: "Run a command?", askedIn: "command" }, 100);
    l.add({ type: "answer", answer: "declined" }, 200);
    expect(l.get().items.find(i => i.kind === "question")).toMatchObject({ words: "Asked you: you said not now", asked: "Run a command?", askedIn: "command" });
    expect(JSON.stringify(l.card())).not.toContain("Run a command");
  });
});


describe("which task Home says is asking, when two wait for an answer", () => {
  const waiting = (id: string, extra: Partial<TaskEntry> = {}): TaskEntry => ({
    id, title: id, status: "waiting",
    activity: { startedAt: 0, items: [], dropped: 0, steps: 0, failedSteps: 0, counts: {}, questions: 1, approvals: 0, asking: true, retry: 0, slow: false, nearLimit: false, live: "" },
    ...extra,
  });

  it("is the task whose question is up now, as main marks it, not the newest that waits (tasks-approvals-r9-3)", () => {
    // Main lists newest first: task 2 asked second, and the question up now is task 1's (the Confirmer's oldest first).
    const entries = withQuestionUp([waiting("2-new"), waiting("1-old")], "1-old");
    expect(entries.map(e => e.asking)).toEqual([undefined, true]);
    expect(askingTask(entries)?.id).toBe("1-old");
  });

  it("is the oldest that waits where main hasn't said, as the questions come up oldest first (tasks-approvals-r9-3)", () => {
    expect(askingTask([waiting("2-new"), waiting("1-old")])?.id).toBe("1-old");
    expect(askingTask(withQuestionUp([waiting("2-new"), waiting("1-old")], undefined))?.id).toBe("1-old");
    expect(askingTask([{ ...waiting("3"), status: "running" }])).toBeUndefined();
  });

  it("never marks a task that isn't listed, or one that has stopped waiting (tasks-approvals-r9-3)", () => {
    expect(withQuestionUp([waiting("2")], "9").map(e => e.asking)).toEqual([undefined]);
    expect(withQuestionUp([{ ...waiting("2"), status: "stopped" }], "2").map(e => e.asking)).toEqual([undefined]);
  });
});
