/**
 * The daily question (memory-r9-8): Ember asks "who or what is that?" only about a name that may be someone or
 * something of the user's, never an app, a site, a setting or a place it is asked to work in, and never a second
 * time about a name it already asked about, whatever the answer was. Since r10-memory-y10-2, only a name the user
 * called their own person or project counts ("my colleague Priya"); a later mention counts where someone or a
 * project stands (`theirs`).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { IDLE_MS, MemoryLearning } from "../../app/main/memory/learning";
import { Gaps, QUESTION_EVERY_MS, askableNames, gapQuestion, namesIn } from "../../app/main/memory/questions";
import { MemoryService } from "../../app/main/memory/service";
import { nameKey } from "../../app/main/memory/text";

/** The names the user called theirs earlier this run. */
const theirs = (...names: string[]) => new Set(names.map(nameKey));

const quiet = { info: () => undefined, warn: () => undefined };
const DAY = QUESTION_EVERY_MS;

/** What Ember would ask about after these requests, each of which recall found nothing for. */
function asksAfter(requests: string[], apps: string[] = []): string | null {
  const g = new Gaps();
  for (const r of requests) g.missed(r, () => false, apps);
  return g.top();
}

function learning(apps: string[] = []) {
  let now = Date.parse("2026-11-12T10:00:00Z");
  const s = new MemoryService({ dir: fs.mkdtempSync(path.join(os.tmpdir(), "ember-memgaps-")), log: quiet });
  const said: string[] = [];
  let askedAt: string | null = null;
  const l = new MemoryLearning({
    memory: s, inForce: () => true, questionsOn: () => true, askedAt: () => askedAt, setAskedAt: at => { askedAt = at; }, idle: () => true, locked: () => false,
    say: text => { said.push(text); return true; }, apps: () => apps, log: quiet, now: () => now,
  });
  const tools = l.conductorMemory();
  const ask = async (request: string) => { await tools.forRequest(request, true); };
  /** Idle long enough for a question, the next day. */
  const idle = async () => { now += DAY + IDLE_MS + 1000; await l.tick(); await l.tick(); };
  return { l, s, said, ask, idle };
}

describe("which names Ember asks about (memory-r9-8)", () => {
  it.each([
    [["Open Firefox and search for flights to Lisbon", "Can you open Firefox again"]],
    [["Play my focus playlist on Spotify", "Pause Spotify"]],
    [["Summarise the unread mail in Outlook", "Reply to the last message in Outlook"]],
    [["Search YouTube for sourdough videos", "Open YouTube"]],
    [["What changed in the GitHub repo today", "Open the pull request on GitHub"]],
    [["Put the report in Google Docs", "Share it from Google Docs"]],
    [["Turn on Dark Mode", "Is Dark Mode on"]],
    [["Type hello in Notepad", "Close Notepad"]],
    [["Check the weather in London", "What's the time in London"]],
    [["Find flights to Lisbon", "Book the train to Lisbon"]],
    [["Is London rainy today", "Compare London and Leeds house prices"]],
    [["Start Thunderbird please", "Does Thunderbird have new mail"]],
  ])("never asks who or what an app, a site, a setting or a place is: %j (memory-r9-8)", requests => {
    expect(asksAfter(requests)).toBeNull();
  });

  it("never asks about an app installed on this computer, by its name or its first word (memory-r9-8)", () => {
    const apps = ["Krita", "Obsidian", "LibreOffice Writer", "Visual Studio Code"];
    expect(asksAfter(["Ask my friend Krita about sketches", "Message Krita about layers"])).toBe("Krita");
    expect(asksAfter(["Ask my friend Krita about sketches", "Message Krita about layers"], apps)).toBeNull();
    expect(asksAfter(["What does Writer do with footnotes", "Why is Writer slow"], apps)).toBeNull();
    expect(askableNames("Compare Obsidian and my colleague Priya's notes", apps)).toEqual(["Priya"]);
  });

  it("still asks about the people and projects the user calls theirs (memory-r9-8, r10-memory-y10-2)", () => {
    expect(asksAfter(["Ask my colleague Priya about the roadmap", "Email Priya the notes"])).toBe("Priya");
    expect(asksAfter(["Email my boss Priya", "Call Priya tomorrow"])).toBe("Priya");
    expect(asksAfter(["Draft a note to my manager Priya Shah about Atlas", "Send the Atlas update to Priya Shah"])).toBe("Priya Shah");
    expect(asksAfter(["What's the status of our Atlas project", "Summarise the Atlas notes for Bob"])).toBe("Atlas");
    // Never one the user only named (r10-memory-y10-2).
    expect(asksAfter(["Ask Priya about the roadmap", "Email Priya the notes"])).toBeNull();
    expect(asksAfter(["What's the status of Atlas", "Summarise the Atlas notes for Bob"])).toBeNull();
    expect(gapQuestion("Priya")).toBe("You've mentioned “Priya” a few times. Who or what is that? I'll remember your answer, or say “skip”.");
    // What is said is unchanged: only which names count.
    expect(namesIn("Open Firefox and search for flights to Lisbon")).toEqual(["Firefox", "Lisbon"]);
    expect(askableNames("Open Firefox and search for flights to Lisbon")).toEqual([]);
    expect(askableNames("Open the report from Priya in Firefox", [], theirs("Priya"))).toEqual(["Priya"]);
    expect(askableNames("Open the report from Priya in Firefox")).toEqual([]);
  });

  it.each([
    ["Remind me to check in on Priya tomorrow", ["Priya"]], ["I'm working on Atlas this week", ["Atlas"]], ["Any update on Atlas", ["Atlas"]],
    ["Update Priya on the launch", ["Priya"]], ["Start Priya's review", ["Priya"]], ["Book a train to Priya's place", ["Priya"]],
    ["Ask Alma about the budget", ["Alma"]], ["Message Rocky about the walk", ["Rocky"]], ["Ping Dallas about the server", ["Dallas"]],
    ["Email Mr Lock about the lease", ["Mr Lock"]], ["Draft a note to Dr Light about the scan", ["Dr Light"]],
  ])("still asks about the someone or the project in %j, after “on”, an app's verb or an everyday word, once called theirs (memory-x9-9)", (request, names) => {
    expect(askableNames(request, [], theirs(...names))).toEqual(names);
    // Never called theirs: nothing (r10-memory-y10-2).
    expect(askableNames(request)).toEqual([]);
  });

  it("never lets a later word of an installed app's name, or someone's app, silence a person (memory-x9-9)", () => {
    const apps = ["Grace Hopper Simulator", "Sam's Club", "Priya Notes"];
    const all = theirs("Sam", "Hopper", "Priya", "Atlas");
    expect(askableNames("Message Sam about lunch", apps, all)).toEqual(["Sam"]);
    expect(askableNames("Ask Hopper about payroll", apps, all)).toEqual(["Hopper"]);
    expect(askableNames("Ask Priya about payroll", apps, all)).toEqual([]);
    // Where an app, a site or a place stands, it still asks nothing.
    for (const r of ["Open Atlas", "Put a note in Atlas about the delay", "Turn on Dark Mode", "Check the weather in London", "Visit Priya on Friday", "Search YouTube for Priya"]) {
      expect(askableNames(r, [], all).filter(n => n !== "Priya")).toEqual([]);
    }
    expect(askableNames("Visit Priya on Friday", [], all)).toEqual([]);
  });
});

describe("a name Ember asked about is never asked about again (memory-r9-8)", () => {
  it("asks once, takes “skip” for an answer, and never asks about that name again however often it comes up (memory-r9-8)", async () => {
    const r = learning();
    for (let day = 1; day <= 3; day++) {
      await r.ask("Ask my colleague Priya about the roadmap");
      await r.ask("Email Priya the notes");
      await r.idle();
      if (day === 1) {
        expect(r.said).toEqual([gapQuestion("Priya")]);
        expect(r.l.intent("skip", { own: true })).toBe("All right.");
      }
    }
    expect(r.said).toHaveLength(1);
    expect(r.s.list()).toEqual([]);
  });

  it("nor after a question nobody answered, and still asks about another name the next day (memory-r9-8)", async () => {
    const r = learning();
    await r.ask("Ask my colleague Priya about the roadmap");
    await r.ask("Email Priya the notes");
    await r.idle();
    expect(r.said).toEqual([gapQuestion("Priya")]);
    // No answer. The same name comes up again, and a new one twice.
    await r.ask("Call Priya");
    await r.ask("Message Priya the agenda");
    await r.ask("What's the status of our Atlas project");
    await r.ask("Summarise the Atlas notes");
    await r.idle();
    expect(r.said).toEqual([gapQuestion("Priya"), gapQuestion("Atlas")]);
  });

  it("never asks about the apps it is asked to work in, end to end (memory-r9-8)", async () => {
    const r = learning(["Firefox"]);
    for (let day = 1; day <= 2; day++) {
      await r.ask("Open Firefox and check the news");
      await r.ask("Close Firefox");
      await r.ask("Type hello in Notepad");
      await r.ask("Is Dark Mode on");
      await r.idle();
    }
    expect(r.said).toEqual([]);
  });

  it("lets go of the names asked about when everything is forgotten (memory-r9-8)", async () => {
    const r = learning();
    await r.ask("Ask my colleague Priya about the roadmap");
    await r.ask("Email Priya the notes");
    await r.idle();
    r.l.forgetAll();
    await r.ask("Ask my colleague Priya about the roadmap");
    await r.ask("Email Priya the notes");
    await r.idle();
    expect(r.said).toEqual([gapQuestion("Priya"), gapQuestion("Priya")]);
  });
});
