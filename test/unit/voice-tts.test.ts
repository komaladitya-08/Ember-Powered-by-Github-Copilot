/**
 * Ember's own voice: how a reply is cut into pieces to speak (the first one short, so it starts soon), how a streamed
 * answer becomes sentences as they complete (never inside code or a table, never twice), the page's player (gapless,
 * says when it speaks and when it's done, a hush stops it), and the system voice chosen when Ember's isn't there.
 */

import { describe, expect, it, vi } from "vitest";
import { NATURAL_RECHECK_MS, REST_IN_BUBBLE, SPOKEN_MAX, SpeechStream, rememberedSlow, slowVerdict, speechChunks } from "../../app/voice/tts";
import { spokenText } from "../../app/voice/spoken";
import { Player, type PlayerAudio, type PlayerSource, playerAudio } from "../../app/renderer/mic/player";

describe("the natural voice's too-slow verdict", () => {
  it("holds for a week, then lets Kokoro be timed again", () => {
    const at = 1_800_000_000_000;
    const verdict = slowVerdict(0.598, at);
    expect(rememberedSlow(verdict, at)).toBe(0.598);
    expect(rememberedSlow(verdict, at + NATURAL_RECHECK_MS - 1)).toBe(0.598);
    expect(rememberedSlow(verdict, at + NATURAL_RECHECK_MS)).toBeNull();
  });

  it("ignores missing, damaged, fast and future-dated verdicts", () => {
    for (const value of [undefined, "cpu", "slow:abc:1", "slow:Infinity:1", `slow:${"9".repeat(400)}:1`, "slow:0.5:1", slowVerdict(0.7, 5000)]) {
      expect(rememberedSlow(value, 1000), value).toBeNull();
    }
  });
});

describe("SpeechStream with a long answer", () => {
  const sentence = (i: number) => `This is sentence number ${i} of a long answer that goes on.`;
  it("says no more than SPOKEN_MAX of it, ending at a sentence, then that the rest is in the bubble, once", () => {
    const s = new SpeechStream();
    const said = Array.from({ length: 30 }, (_, i) => s.push(`${sentence(i)} `)).flat();
    const rest = s.finish(Array.from({ length: 30 }, (_, i) => sentence(i)).join(" "));
    const all = [...said, ...rest];
    expect(all.at(-1)!.endsWith(REST_IN_BUBBLE)).toBe(true);
    expect(all.filter(x => x.includes(REST_IN_BUBBLE))).toHaveLength(1);
    expect(all.join(" ").length).toBeLessThanOrEqual(SPOKEN_MAX + REST_IN_BUBBLE.length + 2);
    expect(all.join(" ")).toContain(sentence(0));
  });

  it("cuts an answer given whole at its last sentence that fits", () => {
    const text = Array.from({ length: 30 }, (_, i) => sentence(i)).join(" ");
    const [said] = new SpeechStream().finish(text);
    expect(said).toMatch(/goes on\. The rest is in the bubble\.$/);
    expect(said.length).toBeLessThanOrEqual(SPOKEN_MAX + REST_IN_BUBBLE.length + 1);
  });

  it("still says the answer's closing question past the cap, as the follow-up window waits for its reply (review of #143)", () => {
    const body = Array.from({ length: 30 }, (_, i) => sentence(i)).join(" ");
    const s = new SpeechStream();
    const said = [...s.push(`${body} `), ...s.push("Which of them shall I open? ")];
    const all = [...said, ...s.finish(`${body} Which of them shall I open?`)];
    expect(all.at(-1)).toBe("Which of them shall I open?");
    expect(all.filter(x => x.includes(REST_IN_BUBBLE))).toHaveLength(1);
    // Given whole, too; and an answer that ends without a question says only the note at the end.
    expect(new SpeechStream().finish(`${body} Shall I go on?`).at(-1)).toBe("Shall I go on?");
    expect(new SpeechStream().finish(`${body} Is that it? That's all.`).at(-1)).toMatch(/The rest is in the bubble\.$/);
  });

  it("says a short answer whole, and starts afresh for the next answer", () => {
    const s = new SpeechStream(60);
    expect(s.finish("Night Light is on.")).toEqual(["Night Light is on."]);
    expect(s.finish("x ".repeat(20) + "and that is a very long first sentence without an end")).toEqual([expect.stringMatching(/…\s+The rest is in the bubble\.$/)]);
    expect(s.finish("Done.")).toEqual(["Done."]);
  });
});
import { bestVoice } from "../../app/renderer/mic/voices";

describe("speechChunks", () => {
  it("says a reply sentence by sentence", () => {
    expect(speechChunks("Night Light is on. I also turned on Do Not Disturb! Anything else?")).toEqual(["Night Light is on.", "I also turned on Do Not Disturb!", "Anything else?"]);
  });

  it("starts a long first sentence with its first clause, so the sound comes sooner", () => {
    const [first, ...rest] = speechChunks("I opened the terminal in your project folder, ran the tests and the linter, and everything passed on the first try.");
    expect(first).toBe("I opened the terminal in your project folder,");
    expect(rest.join(" ")).toBe("ran the tests and the linter, and everything passed on the first try.");
  });

  it("cuts a first sentence of more than 48 characters at its first clause of 18 or more, where the voice takes about 18 ms a character (scripts/perf/latency.mjs)", () => {
    expect(speechChunks("I can't do that one, because it would delete files from your home folder without a way back.")[0]).toBe("I can't do that one,");
    expect(speechChunks("It's 3:40 in the afternoon, and your next meeting is at 4.")).toEqual(["It's 3:40 in the afternoon,", "and your next meeting is at 4."]);
    // Short enough to say whole, and a clause too short to say alone: as before.
    expect(speechChunks("Night Light is on now, until sunrise.")).toEqual(["Night Light is on now, until sunrise."]);
    expect(speechChunks("Sure, I've made the text bigger in Settings for you.")).toEqual(["Sure, I've made the text bigger in Settings for you."]);
  });

  it("doesn't end a sentence at an abbreviation, a decimal or a list's number", () => {
    expect(speechChunks("Use a short name, e.g. notes. Version 3.5 is out.")).toEqual(["Use a short name, e.g. notes.", "Version 3.5 is out."]);
  });

  it("says each numbered step on its own, with its number at its start, not glued to the step before (voice-speaking-v1)", () => {
    const said = (md: string) => speechChunks(spokenText(md));
    expect(said("To change it:\n1. Open Settings\n2. Choose Privacy\n3. Turn off Location")).toEqual(["To change it:", "1. Open Settings.", "2. Choose Privacy.", "3. Turn off Location."]);
    expect(said("To change it\n1. Open Settings\n2. Choose Privacy")).toEqual(["To change it.", "1. Open Settings.", "2. Choose Privacy."]);
    const options = "You have three options:\n\n1. Move the files…\n\n2. Delete the duplicates\n\n3. Leave everything as it is\n\nWhich would you like?";
    expect(said(options)).toEqual(["You have three options:", "1. Move the files…", "2. Delete the duplicates.", "3. Leave everything as it is.", "Which would you like?"]);
    expect(said("1) Keep it\n2) Delete it")).toEqual(["1) Keep it.", "2) Delete it."]);
    for (const chunk of said(options)) expect(chunk).not.toMatch(/\d[.)]$/);
    // As before: a number that starts a reply, "e.g." and "Dr." don't end a sentence.
    expect(speechChunks("1. One thing to know is this.")).toEqual(["1. One thing to know is this."]);
    expect(speechChunks("Ask Dr. Smith, e.g. by mail.")).toEqual(["Ask Dr. Smith, e.g. by mail."]);
  });

  it("says each labelled step on its own, its label never cut from it after a short line leading into it (voice-speaking-c3-2)", () => {
    const said = (md: string) => speechChunks(spokenText(md));
    expect(said("To do this:\nStep 1: Open Settings and go to the Privacy section\nStep 2: Turn off Location for every app")).toEqual(["To do this:", "Step 1: Open Settings and go to the Privacy section.", "Step 2: Turn off Location for every app."]);
    expect(said("**Step 1:** Open Settings\n**Step 2:** Choose Privacy\n**Step 3:** Turn off Location")).toEqual(["Step 1: Open Settings.", "Step 2: Choose Privacy.", "Step 3: Turn off Location."]);
    // A colon inside a line still cuts a long first sentence there.
    expect(speechChunks("Here's what I found in Documents: three reports from last week and a spreadsheet.")).toEqual(["Here's what I found in Documents:", "three reports from last week and a spreadsheet."]);
  });

  it("keeps a list's items apart, as sentences (voice-speaking-3)", () => {
    // The line leading into them is a piece of its own, as it is when the list streams (voice-speaking-c3-2).
    expect(speechChunks(spokenText("Your apps:\n- Text Editor\n- Calendar\n- Contacts\n- Firefox"))).toEqual(["Your apps:", "Text Editor.", "Calendar. Contacts.", "Firefox."]);
  });

  it("doesn't end a sentence at a.m., p.m. or a day's short name (voice-speaking-3)", () => {
    expect(speechChunks("Meeting at 3:30 p.m. on Tue. with Dr. Smith. Bring the notes.")).toEqual(["Meeting at 3:30 p.m. on Tue. with Dr. Smith.", "Bring the notes."]);
    expect(speechChunks("We sat. Then we left the room together.")).toEqual(["We sat.", "Then we left the room together."]);
  });

  const LONG = "I looked through the folder you mentioned and found the quarterly reports from last year together with the drafts that were never sent to the finance team for review.";

  it("starts a long first sentence with no comma before a joining word, not after its full stop (voice-speaking-8)", () => {
    const [first, ...rest] = speechChunks(LONG);
    expect(first).toBe("I looked through the folder you mentioned");
    expect(first.length).toBeLessThanOrEqual(90);
    expect([first, ...rest].join(" ")).toBe(LONG);
    // No joining word: at the last space that fits.
    const plain = "Supercalifragilistic expialidocious antidisestablishmentarianism floccinaucinihilipilification pneumonoultramicroscopic.";
    expect(speechChunks(plain)[0].length).toBeLessThanOrEqual(90);
    // A comma still comes first, and a sentence of up to 90 characters is said whole.
    expect(speechChunks("I can't do that one, because it would delete files from your home folder without a way back.")[0]).toBe("I can't do that one,");
    expect(speechChunks("I looked through the folder you mentioned and found nothing there at all.")).toEqual(["I looked through the folder you mentioned and found nothing there at all."]);
  });

  it("never cuts a long first sentence between a verb and its 'to', 'for', 'from' or 'with' (voice-speaking-r2)", () => {
    const going = "The update you asked about is going to take about twenty minutes because the installer downloads every language pack first.";
    expect(speechChunks(going)[0]).toBe("The update you asked about is going to take about twenty minutes");
    const next = "The printer you asked about is on the second floor next to the kitchen area where the coffee machine stands today.";
    expect(speechChunks(next)[0]).not.toMatch(/\b(?:next|to)$/);
    expect(speechChunks(next)[0].length).toBeLessThanOrEqual(90);
  });

  it.each([
    ["The update you asked about is going to take about twenty minutes to finish installing on this computer and then it will restart.", "The update you asked about is going to take about twenty minutes to finish installing"],
    ["The meeting room next to the kitchen area on the second floor is free from two until four this afternoon if you want it.", "The meeting room next to the kitchen area on the second floor is free"],
    ["Your meeting with the design team about the new onboarding flow is at 3:30 PM in the large room on the second floor today.", "Your meeting with the design team about the new onboarding flow is at 3 30 PM"],
    ["The package you ordered last week from the online shop is expected to arrive between two and four tomorrow afternoon at your door.", "The package you ordered last week from the online shop is expected to arrive"],
  ])("cuts a long first sentence with no joining word where a phrase starts, not inside one: %j (voice-speaking-r2)", (text, first) => {
    expect(speechChunks(spokenText(text))[0]).toBe(first);
    const s = new SpeechStream();
    const said: string[] = [];
    for (let i = 0; i < text.length; i += 4) said.push(...s.push(text.slice(i, i + 4)));
    said.push(...s.finish(text));
    expect(said[0]).toBe(first);
    expect(said.join(" ")).toBe(spokenText(text));
  });

  it("keeps every piece to 120 characters, so a new answer never waits long behind one being made (voice-speaking-10)", () => {
    const text = `${LONG} The largest one is the October summary, which has the revenue tables and the notes from the planning meeting that you asked me about earlier this week. I can open any of them for you.`;
    const chunks = speechChunks(text);
    for (const c of chunks) expect(c.length, c).toBeLessThanOrEqual(120);
    expect(chunks.join(" ")).toBe(text);
  });

  it("never cuts a piece at a dash between two amounts, which was heard as two prices (voice-speaking-c3-1)", () => {
    const sum = "After the discount, that's $1,500 - $200 for fees, so $1,300 is left for the rest of the trip.";
    expect(speechChunks(spokenText(sum))).toEqual(["After the discount,", "that's 1,500 dollars - 200 dollars for fees, so 1,300 dollars is left for the rest of the trip."]);
    expect(speechChunks(spokenText("That's $1,500 - $200 for fees, so $1,300 is left after it."))[0]).toBe("That's 1,500 dollars - 200 dollars for fees,");
    expect(speechChunks(spokenText("The two offers came to $3M - $2.5M in fees, so the second one is better for you."))[0]).toBe("The two offers came to 3 million dollars - 2.5 million dollars in fees,");
    // Streamed too, also when the dash is the last of what has come: the first clause is never cut at it.
    const text = "The two quotes you have come to $1,500 - $200 in fees, so the cheaper one is better for you.";
    for (const delta of [1, 2, 3, 4, 16]) {
      const s = new SpeechStream();
      const said: string[] = [];
      for (let i = 0; i < text.length; i += delta) said.push(...s.push(text.slice(i, i + delta)));
      said.push(...s.finish(text));
      expect(said[0], `${delta}`).toBe("The two quotes you have come to 1,500 dollars - 200 dollars in fees,");
      for (const piece of said.flatMap(speechChunks)) expect(piece, `${delta}`).not.toMatch(/dollars -$/);
    }
    // A dash before words is still a place to cut ("…your Downloads folder — and three of them…").
    expect(new SpeechStream().push("I found five spreadsheets in Downloads — and three of")).toEqual(["I found five spreadsheets in Downloads —"]);
  });

  it("joins a very short piece to the one before it", () => {
    expect(speechChunks("The build finished in twelve seconds. OK. Next?")).toEqual(["The build finished in twelve seconds.", "OK. Next?"]);
  });

  it("says nothing for nothing", () => {
    expect(speechChunks("  \n ")).toEqual([]);
  });
});

describe("SpeechStream", () => {
  const stream = (deltas: string[], full?: string) => {
    const s = new SpeechStream();
    const said = deltas.flatMap(d => s.push(d));
    return { said, rest: s.finish(full ?? deltas.join("")) };
  };

  it("speaks each sentence as soon as it's complete, and the rest at the end", () => {
    const { said, rest } = stream(["Night Li", "ght is on", ". I also", " turned on Do Not Disturb.", " Anything", " else?"]);
    expect(said).toEqual(["Night Light is on.", "I also turned on Do Not Disturb."]);
    expect(rest).toEqual(["Anything else?"]);
  });

  it("never speaks inside a code block: it is said as shown in the bubble once it's closed", () => {
    const { said, rest } = stream(["Run this:\n\n```bash\nnpm test. And", " more.\n```\n", "Then check the output."]);
    expect(said.join(" ")).not.toMatch(/npm|more/);
    expect([...said, ...rest].join(" ")).toMatch(/^Run this:\s*\(code shown in the bubble\)\s*Then check the output\.$/);
  });

  it("says Markdown as words (no stars or link addresses)", () => {
    const { said } = stream(["**Done.** See [the guide](https://example.com/guide). ", "More soon"]);
    expect(said.join(" ")).toBe("Done. See the guide.");
  });

  it.each([
    ["Open [Build notes. ", "Read the guide](https://example.com/a(b)c). Next.", "Open Build notes. Read the guide."],
    ["Run `npm test. ", "npm run lint` first. Next.", "Run npm test. npm run lint first."],
  ])("keeps sentences inside unfinished inline markup together (%s)", (first, rest, expected) => {
    const s = new SpeechStream();
    expect(s.push(`Ready. ${first}`)).toEqual(["Ready."]);
    expect(s.push(rest)).toEqual([expected]);
    expect(s.finish()).toEqual(["Next."]);
  });

  it("keeps streaming after a closed code span with literal backslashes", () => {
    expect(new SpeechStream().push("Open `C:\\`. Next.")).toEqual(["Open C:\\."]);
  });

  it("starts speaking at the first clause of a long first sentence, before Copilot has written the rest", () => {
    const s = new SpeechStream();
    expect(s.push("I opened the quarterly report")).toEqual([]);
    expect(s.push(", checked the totals and")).toEqual(["I opened the quarterly report,"]);
    expect(s.push(" fixed two cells. Anything else?")).toEqual(["checked the totals and fixed two cells."]);
    expect(s.finish()).toEqual(["Anything else?"]);
  });

  it("starts at a first clause of 18 characters and four words, not only at 25 (“I can't do that one,”)", () => {
    expect(new SpeechStream().push("I can't do that one, because")).toEqual(["I can't do that one,"]);
    expect(new SpeechStream().push("Here's what I found: the project")).toEqual(["Here's what I found:"]);
  });

  it("starts a long first sentence with no comma before a joining word, before Copilot has written its full stop (voice-speaking-8)", () => {
    const long = "I looked through the folder you mentioned and found the quarterly reports from last year together with the drafts that were never sent to the finance team for review. Shall I open them?";
    const s = new SpeechStream();
    const said: { at: number; piece: string }[] = [];
    for (let i = 0; i < long.length; i += 3) for (const piece of s.push(long.slice(i, i + 3))) said.push({ at: i + 3, piece });
    expect(said[0].piece).toBe("I looked through the folder you mentioned");
    expect(said[0].at).toBeLessThan(long.indexOf("review."));
    expect([...said.map(x => x.piece), ...s.finish(long)].join(" ")).toBe(long);
    // A comma-less first sentence of up to 90 characters still waits for its end.
    expect(new SpeechStream().push("I looked through the folder you mentioned and found nothing there at")).toEqual([]);
  });

  it("never cuts a long first sentence inside a code span or a link's words, nor says a link's address (voice-speaking-r2)", () => {
    const pieces = (text: string) => {
      const s = new SpeechStream();
      const said: string[] = [];
      for (let i = 0; i < text.length; i += 4) said.push(...s.push(text.slice(i, i + 4)));
      return { said, all: [...said, ...s.finish(text)] };
    };
    const code = pieces("Run the command `npm install and build for production` to set it up on this computer before the meeting starts tomorrow. Then tell me.");
    for (const p of code.all) expect(p, p).not.toMatch(/`/);
    expect(code.all.join(" ")).toContain("Run the command npm install and build for production to set it up");
    expect(code.said.length).toBeGreaterThan(0);
    const link = pieces("I opened [the report that you wrote for the board last quarter](https://example.com/reports/q3) in Firefox and left it on the summary page. Anything else?");
    for (const p of link.all) expect(p, p).not.toMatch(/example|\[|\]/);
    expect(link.all.join(" ")).toContain("the report that you wrote for the board last quarter");
  });

  it.each([
    "I have **finished updating every one of the documents in your shared folder and the archive** so nothing is left to do now.",
    "I have **finished every one of the documents, and the old archive** too, so nothing is left.",
    "I have _finished updating every one of the documents in your shared folder and the old archive_ so nothing is left to do now.",
    "I have *finished every one of the documents, and the old archive* too, so nothing is left.",
    "**Done. I closed the window and saved the file.** Anything else?",
  ])("never says a bold or italic marker that a cut inside it leaves in a piece: %j (voice-speaking-c2-1)", text => {
    const s = new SpeechStream();
    const said: string[] = [];
    for (let i = 0; i < text.length; i += 4) said.push(...s.push(text.slice(i, i + 4)));
    said.push(...s.finish(text));
    for (const p of said) expect(p, p).not.toMatch(/[*_]/);
    expect(said.join(" ")).toBe(spokenText(text));
  });

  it("keeps a long answer's streaming cheap, so Ember's main process stays free while it streams (voice-speaking-r4)", () => {
    let paragraph = "";
    for (let i = 0; paragraph.length < 6000; i++) paragraph += `The ${i}th report covers sales in the north region and the totals by month for last year. `;
    const answer = `# Reports\n${paragraph.trim()}\n## Totals\n${paragraph.trim()}`;
    const s = new SpeechStream(Infinity);
    const said: string[] = [];
    const t0 = performance.now();
    for (let i = 0; i < answer.length; i += 4) said.push(...s.push(answer.slice(i, i + 4)));
    said.push(...s.finish(answer));
    const ms = performance.now() - t0;
    expect(said[0]).toBe("Reports.");
    expect(said).toContain("Totals.");
    expect(ms).toBeLessThan(200);
  });

  it("keeps a long table's or code block's streaming cheap too, and says what is after it (voice-speaking-r4)", () => {
    const row = "| Paris | France. | 2.1 million. |\n";
    const line = "const value = compute(alpha, beta); // done. Next step. Then more.\n";
    for (const answer of [
      `Here are the cities:\n\n| City | Country | People |\n|---|---|---|\n${row.repeat(Math.ceil(12_000 / row.length))}\nThat's all. Anything else?`,
      `Here is the script.\n\n\`\`\`js\n${line.repeat(Math.ceil(20_000 / line.length))}\`\`\`\n\nRun it. Then tell me.`,
    ]) {
      const s = new SpeechStream(Infinity);
      const said: string[] = [];
      const t0 = performance.now();
      for (let i = 0; i < answer.length; i += 4) said.push(...s.push(answer.slice(i, i + 4)));
      const streamed = said.length;
      said.push(...s.finish(answer));
      expect(performance.now() - t0).toBeLessThan(300);
      expect(said.join(" ")).toBe(spokenText(answer).replace(/\s+/g, " "));
      // What follows the table or the code is said as it streams, not left to the end.
      expect(streamed).toBeGreaterThan(2);
    }
  });

  it("waits for the sentence when the first clause is too short to say alone", () => {
    expect(new SpeechStream().push("Sure, I can open that for you")).toEqual([]);
  });

  it("never cuts the first clause inside a code span, a link or a list", () => {
    expect(new SpeechStream().push("Run `npm test --watch, then check the output, and")).toEqual([]);
    expect(new SpeechStream().push("Open [the guide to builds, tests and more](https://exa")).toEqual([]);
    expect(new SpeechStream().push("- Open the settings window first, then")).toEqual([]);
  });

  it("speaks only from the sentences once the first part is said", () => {
    const s = new SpeechStream();
    s.push("I opened the quarterly report, checked it");
    expect(s.push(" and more, then again")).toEqual([]);
  });

  it("says a list's items as they arrive, not all at the end (voice-speaking-3, voice-speaking-v1)", () => {
    const markdown = "Your apps:\n- Firefox\n- Files\n- Terminal\n- Mail\n\nWhich one?";
    const s = new SpeechStream();
    const pieces: string[] = [];
    for (let i = 0; i < markdown.length; i += 3) pieces.push(...s.push(markdown.slice(i, i + 3)));
    expect(pieces).toEqual(["Your apps:", "Firefox.", "Files.", "Terminal.", "Mail."]);
    expect(s.finish(markdown)).toEqual(["Which one?"]);
    // Numbered steps too, each with its number, and the pieces chunk as the whole text does.
    const steps = "To change it:\n1. Open Settings\n2. Choose Privacy\n3. Turn off Location";
    const t = new SpeechStream();
    const said: string[] = [];
    for (let i = 0; i < steps.length; i += 3) said.push(...t.push(steps.slice(i, i + 3)));
    said.push(...t.finish(steps));
    expect(said).toEqual(["To change it:", "1. Open Settings.", "2. Choose Privacy.", "3. Turn off Location."]);
    expect(said.flatMap(speechChunks)).toEqual(speechChunks(spokenText(steps)));
  });

  /** `text` streamed `delta` characters at a time: every piece said, the last ones at its end. */
  const streamed = (text: string, delta: number) => {
    const s = new SpeechStream();
    const said: string[] = [];
    for (let i = 0; i < text.length; i += delta) said.push(...s.push(text.slice(i, i + delta)));
    return [...said, ...s.finish(text)];
  };

  it.each([
    "Here's what I'll do:", "Sure, here's the plan:", "I'll do three things:", "This is what I found:",
    "I found three files in your Downloads folder:", "Here is the plan:", "Okay. Here's what I'll do:", "Steps:", "Here's what I'll do:\n",
  ])("says each line that %j leads into apart when streamed, as it does the whole answer (voice-speaking-3)", lead => {
    const answer = `${lead}\nOpen the spreadsheet you sent me this morning\nAdd up the totals for each month\nSave it as a new file in Documents`;
    for (const delta of [1, 4, 16]) {
      const said = streamed(answer, delta);
      expect(said.join("\n"), `${delta}`).toContain("this morning.\nAdd up the totals for each month.\nSave it as a new file in Documents.");
      // Each step is a piece of its own for the voice, the first perhaps after the line that leads into it.
      const chunks = said.flatMap(speechChunks);
      expect(chunks.slice(-2), `${delta}`).toEqual(["Add up the totals for each month.", "Save it as a new file in Documents."]);
      expect(chunks[chunks.length - 3], `${delta}`).toMatch(/^(?:.*: )?Open the spreadsheet you sent me this morning\.$/);
    }
  });

  it.each([
    "**Step 1:** Open Settings\n**Step 2:** Choose Privacy\n**Step 3:** Turn off Location",
    "Step 1: Open Settings\nStep 2: Choose Privacy\nStep 3: Turn off Location",
  ])("says each labelled step of %j on its own when streamed, its label at its start (voice-speaking-c3-2)", answer => {
    for (const delta of [1, 4, 16]) {
      expect(streamed(answer, delta).flatMap(speechChunks), `${delta}`).toEqual(["Step 1: Open Settings.", "Step 2: Choose Privacy.", "Step 3: Turn off Location."]);
    }
  });

  it.each([
    ["Step 1: Open Settings, then go to Privacy\nStep 2: Turn off Location", ["Step 1: Open Settings,", "then go to Privacy.", "Step 2: Turn off Location."]],
    ["Step 1: Open Settings, then go to Privacy\nStep 2: Choose Location.\nStep 3: Turn it off.", ["Step 1: Open Settings,", "then go to Privacy.", "Step 2: Choose Location.", "Step 3: Turn it off."]],
    ["Step 1: Open Settings. Then go to Privacy\nStep 2: Turn off Location", ["Step 1: Open Settings.", "Then go to Privacy.", "Step 2: Turn off Location."]],
    ["Option A: Keep the file, and rename the copy\nOption B: Delete the copy", ["Option A: Keep the file,", "and rename the copy.", "Option B: Delete the copy."]],
  ])("ends a labelled step cut at its comma or full stop before the next label when %j streams (voice-speaking-v4-4)", (answer, pieces) => {
    for (const delta of [1, 4, 16]) {
      const chunks = streamed(answer, delta).flatMap(speechChunks);
      expect(chunks, `${delta}`).toEqual(pieces);
      for (const chunk of chunks) expect(chunk, `${delta}`).not.toMatch(/\S (?:Step \d|Option [AB]):/);
    }
    // A label line with a line of other words after it is still a paragraph, streamed as said whole.
    const note = "Note: I opened the report, and the totals are at the bottom of it\nThey look right to me";
    expect(streamed(note, 4).flatMap(speechChunks).join(" ")).toBe(speechChunks(spokenText(note)).join(" "));
  });

  /** Where `text` streamed `delta` characters at a time gave its first piece: how much of it had come, and the piece. */
  const firstPiece = (text: string, delta: number) => {
    const s = new SpeechStream();
    for (let i = 0; i < text.length; i += delta) {
      const said = s.push(text.slice(i, i + delta));
      if (said.length) return { at: Math.min(i + delta, text.length), piece: said[0] };
    }
    return { at: Infinity, piece: s.finish(text)[0] };
  };

  const STEPS = "Step 1: Open the Start menu and type Sound in the search box at the bottom\nStep 2: Click Sound settings when it appears in the list of results\nStep 3: Under Output, choose the headphones you want to use from the list";

  it.each([
    [STEPS, "Step 1: Open the Start menu and type Sound in the search box at the bottom.", "Step 3"],
    [STEPS.replace(/Step (\d):/g, "**Step $1:**"), "Step 1: Open the Start menu and type Sound in the search box at the bottom.", "**Step 3"],
    [`To fix the sound:\n${STEPS}`, "To fix the sound:", "\nStep 2"],
  ])("starts saying the labelled steps of %j as they arrive, not once the whole answer is in (voice-speaking-c4-1)", (answer, first, before) => {
    for (const delta of [1, 4, 16]) {
      const { at, piece } = firstPiece(answer, delta);
      expect(piece, `${delta}`).toBe(first);
      expect(at, `${delta}`).toBeLessThan(answer.indexOf(before));
      // Each step is said whole, its label at its start, and ends as the whole answer's do, the last one too.
      const chunks = streamed(answer, delta).flatMap(speechChunks);
      expect(chunks.join(" "), `${delta}`).toBe(speechChunks(spokenText(answer)).join(" "));
      expect(chunks.filter(c => /^Step \d: /.test(c)), `${delta}`).toHaveLength(3);
      for (const chunk of chunks) expect(chunk, `${delta}`).not.toMatch(/\S (?:Step \d|To fix the sound):/);
    }
  });

  const FOUND = "I looked through your Downloads folder, and I found three spreadsheets that you changed this week, all of them from the sales team.";

  it.each([
    [`\n${FOUND}`, "I looked through your Downloads folder,"],
    [`OK\n${FOUND}`, "OK\nI looked through your Downloads folder,"],
    [`Here's what I found\n${FOUND}`, "Here's what I found\nI looked through your Downloads folder,"],
    ["Sure thing\nI've closed the three Firefox windows you weren't using, and kept the one with your email open.", "Sure thing\nI've closed the three Firefox windows you weren't using,"],
  ])("starts %j at its first clause, a short first line or a line break before it no reason to wait (voice-speaking-r4-1)", (answer, first) => {
    for (const delta of [1, 4, 16]) {
      const { at, piece } = firstPiece(answer, delta);
      expect(piece, `${delta}`).toBe(first);
      expect(at, `${delta}`).toBeLessThanOrEqual(answer.indexOf(",") + 1 + delta);
      expect(streamed(answer, delta).join(" ").replace(/\s+/g, " "), `${delta}`).toBe(spokenText(answer).replace(/\s+/g, " "));
    }
  });

  it("starts a long first sentence with no comma after a line break before a joining word, as on the first line (voice-speaking-r4-1)", () => {
    const long = "\nI looked through the folder you mentioned and found the quarterly reports from last year together with the drafts that were never sent. Shall I open them?";
    for (const delta of [1, 4, 16]) {
      const { at, piece } = firstPiece(long, delta);
      expect(piece, `${delta}`).toBe("I looked through the folder you mentioned");
      expect(at, `${delta}`).toBeLessThan(long.indexOf("sent."));
    }
  });

  it.each([
    "Your open windows\nFirefox, Files\nTerminal and Mail",
    "Step 1: Open Settings\nStep 2: Choose Privacy, then Location",
    "Note: the file is locked\nIt may take a while, so I'll wait",
    "Steps:\nOpen the spreadsheet you sent me, then add up the totals",
    "Hi\nOK\nI looked through your Downloads folder, and I found three spreadsheets.",
  ])("still says %j as its lines end, never a clause cut from a list's line or a label's (voice-speaking-c3-2)", answer => {
    for (const delta of [1, 4, 16]) {
      expect(streamed(answer, delta).flatMap(speechChunks).join(" "), `${delta}`).toBe(speechChunks(spokenText(answer)).join(" "));
      expect(firstPiece(answer, delta).piece, `${delta}`).not.toMatch(/\n.*,$/);
    }
  });

  it("says a line before a heading or a labelled option on its own when streamed, as it does the whole answer (voice-speaking-r4-2)", () => {
    for (const delta of [1, 4, 16]) {
      expect(streamed("### Option A\nKeep both copies\n### Option B\nDelete the older one", delta).flatMap(speechChunks), `${delta}`).toEqual(["Option A.", "Keep both copies.", "Option B.", "Delete the older one"]);
      expect(streamed("Option A: Keep both copies\nThis is the safest choice\nOption B: Delete the older one", delta).flatMap(speechChunks), `${delta}`).toEqual(["Option A: Keep both copies This is the safest choice.", "Option B: Delete the older one"]);
      expect(streamed("**Option A** – keep both copies\n**Option B** – delete the older one", delta).flatMap(speechChunks), `${delta}`).toEqual(["Option A – keep both copies.", "Option B – delete the older one."]);
    }
  });

  it("says a long menu path cut at a space before an arrow with that arrow's 'to', not as a bullet (voice-speaking-v4-3)", () => {
    const path = "Go to Network → Privacy & Security → Display → Additional mouse settings → System Services → Accessibility → Advanced and turn it off.";
    for (const delta of [1, 4, 16]) {
      expect(streamed(path, delta), `${delta}`).toEqual(["Go to Network to Privacy and Security to Display to Additional mouse settings to System Services", "to Accessibility to Advanced and turn it off."]);
    }
    // A long path is never cut just after an arrow, which would end a piece with "right arrow" (voice-speaking-2).
    const after = "Go to System Services → Output → General → Privacy & Security → Sound → Mission Control → General and turn it off.";
    for (const delta of [1, 4, 16]) {
      const said = streamed(after, delta);
      expect(said.join(" "), `${delta}`).toBe("Go to System Services to Output to General to Privacy and Security to Sound to Mission Control to General and turn it off.");
      for (const piece of said) expect(piece, `${delta}`).not.toMatch(/arrow/);
    }
    const names = ["Network", "Privacy & Security", "Display", "Additional mouse settings", "System Services", "Accessibility", "Advanced", "Keyboard", "Shortcuts", "Mission Control", "General", "Login Items", "Sound", "Output"];
    for (let seed = 0; seed < 200; seed++) {
      const path = Array.from({ length: 5 + (seed % 4) }, (_, i) => names[(seed * 7 + i * 5) % names.length]).join(" → ");
      for (const delta of [1, 4, 16]) for (const piece of streamed(`Go to ${path} and turn it off.`, delta)) expect(piece, `${seed} ${delta}`).not.toMatch(/arrow/);
    }
    // An arrow at the start of a line is still its bullet, streamed too.
    for (const delta of [1, 4, 16]) expect(streamed("Here is what to do:\n→ Open the file\n→ Save it", delta), `${delta}`).toEqual(["Here is what to do:", "Open the file.\nSave it."]);
  });

  it("says a whole answer that wasn't streamed", () => {
    expect(new SpeechStream().finish("Hello there.")).toEqual(["Hello there."]);
  });

  it("doesn't say again what it said, even when the final message differs from the stream", () => {
    const s = new SpeechStream();
    expect(s.push("First. Second")).toEqual(["First."]);
    expect(s.finish("Something else entirely.")).toEqual([]);
  });
});

describe("Player", () => {
  function fakeAudio() {
    const sources: (PlayerSource & { at: number; stopped: boolean })[] = [];
    const ctx: PlayerAudio & { currentTime: number } = {
      currentTime: 10, state: "running", destination: {},
      resume: () => Promise.resolve(),
      createBuffer: (_c, length, rate) => ({ copyToChannel: () => undefined, duration: length / rate }),
      createBufferSource: () => {
        const s = { buffer: null as unknown, onended: null as (() => void) | null, at: -1, stopped: false, connect: () => undefined, start(when: number) { s.at = when; }, stop() { s.stopped = true; } };
        sources.push(s);
        return s;
      },
    };
    return { ctx, sources };
  }

  it("plays a reply's chunks back to back, and says it speaks until the last has played", () => {
    const { ctx, sources } = fakeAudio();
    const speaking = vi.fn();
    const p = new Player(() => ctx, speaking);
    expect(p.chunk(1, new Float32Array(22_050), 22_050)).toBe(1);
    expect(p.chunk(1, new Float32Array(11_025), 22_050)).toBe(0.5);
    expect(sources.map(s => s.at)).toEqual([10.03, 11.03]);
    expect(speaking.mock.calls).toEqual([[true]]);
    sources[0].onended?.();
    sources[1].onended?.();
    expect(p.active).toBe(true); // more may come: the reply isn't done
    p.done(1);
    expect(speaking.mock.calls).toEqual([[true], [false]]);
  });

  it("stops at once on a hush, and drops what is still on its way for that reply", () => {
    const { ctx, sources } = fakeAudio();
    const speaking = vi.fn();
    const p = new Player(() => ctx, speaking);
    p.chunk(1, new Float32Array(100), 22_050);
    p.stop();
    expect(sources[0].stopped).toBe(true);
    expect(speaking.mock.calls).toEqual([[true], [false]]);
    expect(p.chunk(1, new Float32Array(100), 22_050)).toBe(0); // dropped
    expect(sources).toHaveLength(1);
    p.chunk(2, new Float32Array(100), 22_050);
    expect(sources).toHaveLength(2);
  });
});

describe("bestVoice", () => {
  const v = (name: string, lang = "en-US", localService = true, def = false) => ({ name, lang, localService, default: def });

  it("prefers a natural voice that runs on this computer", () => {
    const voices = [v("Microsoft David", "en-US", true, true), v("Microsoft Aria Online (Natural)", "en-US", false), v("Microsoft Jenny (Natural)"), v("Samantha (Enhanced)")];
    expect(bestVoice(voices, "en-US")?.name).toBe("Microsoft Jenny (Natural)");
  });

  it("takes macOS's Premium over Enhanced, and anything over espeak", () => {
    expect(bestVoice([v("Ava (Enhanced)"), v("Zoe (Premium)")], "en-US")?.name).toBe("Zoe (Premium)");
    expect(bestVoice([v("English (America) espeak-ng", "en-US", true, true), v("Mary")], "en-US")?.name).toBe("Mary");
  });

  it("keeps to the language, and returns no voice when none local matches", () => {
    expect(bestVoice([v("Thomas (Enhanced)", "fr-FR"), v("Alex", "en-GB")], "en-US")?.name).toBe("Alex");
    expect(bestVoice([v("Thomas", "fr-FR")], "en-US")).toBeNull();
  });
});

describe("playerAudio (how Ember's voice reaches the speakers)", () => {
  const ctx = () => {
    const dest = { stream: { id: "s" } };
    const c = {
      currentTime: 1.5, state: "running", resumed: 0,
      resume: async () => { c.resumed++; },
      createBuffer: () => ({ copyToChannel() {}, duration: 1 }),
      createBufferSource: () => ({ buffer: null, onended: null, connect() {}, start() {}, stop() {} }),
      destination: { speakers: true },
      createMediaStreamDestination: () => dest,
    };
    return { c, dest };
  };

  it("plays through the context's own output by default", () => {
    const { c } = ctx();
    expect(playerAudio(c, false)).toBe(c);
  });

  it("plays through an <audio> element fed by a media stream when asked (echo cancellation covers media elements)", async () => {
    const { c, dest } = ctx();
    const el = { srcObject: null as unknown, plays: 0, play: async () => { el.plays++; } };
    const a = playerAudio(c, true, () => el);
    expect(a.destination).toBe(dest);
    expect(el.srcObject).toBe(dest.stream);
    expect(a.currentTime).toBe(1.5);
    await a.resume();
    expect(c.resumed).toBe(1);
    expect(el.plays).toBe(2);
  });

  it("tries a refused <audio> element again with the next chunk while the context runs (it never resumes then; voice audit)", async () => {
    const { c } = ctx();
    let refuse = true;
    const el = { srcObject: null as unknown, plays: 0, play: async () => { el.plays++; if (refuse) throw new Error("NotAllowedError"); } };
    const a = playerAudio(c, true, () => el);
    await Promise.resolve(); await Promise.resolve();
    expect(el.plays).toBe(1);
    refuse = false;
    a.createBufferSource();
    await Promise.resolve(); await Promise.resolve();
    expect(el.plays).toBe(2);
    a.createBufferSource(); // playing now: not asked again
    expect(el.plays).toBe(2);
  });
});
