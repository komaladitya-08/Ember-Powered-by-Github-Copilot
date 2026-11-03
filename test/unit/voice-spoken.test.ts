/** What Ember says out loud for an answer: the words, not the Markdown, code or addresses. */

import { describe, expect, it } from "vitest";
import { cancelWords, endsWithQuestion, spokenText, withoutOwnPhrases } from "../../app/voice/spoken";
import { heardCutInWake } from "../../app/voice/engine";

describe("spokenText", () => {
  it.each([
    ["Run this:\n\n```bash\nsudo dnf install foo\n```\n\nThen restart.", "Run this:\n(code shown in the bubble)\nThen restart."],
    ["Still streaming:\n```\nsome code", "Still streaming:\n(code shown in the bubble)"],
    ["See [the docs](https://example.com/docs) or https://github.com/k2-fsa/sherpa-onnx/releases.", "See the docs or github.com."],
    ["Open www.redhat.com, then click **Login**.", "Open redhat.com, then click Login."],
    ["Use `ls -la` to list *all* files.", "Use ls -la to list all files."],
    ["## Steps\n- First\n- Second\n\n1. One\n2. Two", "Steps\nFirst\nSecond\n1. One\n2. Two"],
    ["| App | Size |\n|---|---|\n| Files | 2 MB |\nThat's all.", "(table shown in the bubble)\nThat's all."],
    ["> Quoted\n\n---\n\nEnd ~~old~~ new", "Quoted\nEnd old new"],
    ["snake_case_name and 2*3*4 stay", "snake_case_name and 2*3*4 stay"],
    ["Say it *softly*, **firmly** or _slowly_ (*really*).", "Say it softly, firmly or slowly (really)."],
    ["**Ember**'s answer, in ***bold italics***.", "Ember's answer, in bold italics."],
  ])("%j", (markdown, said) => expect(spokenText(markdown)).toBe(said));

  // Stars and underscores that aren't emphasis are said as they are shown: a marker with a space on its inner side is
  // none (CommonMark's flanking rule), and neither is "__" inside a file name (review #258).
  it.each([
    "Delete *.tmp and *.log from the folder.",
    "That is 6 * 7 * 1 = 42.",
    "Use __init__.py and a * b * c.",
    "2 ** 3 ** 2 is 512.",
    "Match _ or * on their own.",
  ])("%j keeps its stars and underscores (review #258)", text => expect(spokenText(text)).toBe(text));
});

describe("what Ember says where it can't tell its own voice from the user's (review #251)", () => {
  it("names the kill phrase only where speaker rejection runs; otherwise the stop shortcut, or the Stop button", () => {
    expect(cancelWords({ killPhrase: true, stopKey: "Windows key, Alt, X" })).toBe("Say 'Ember, stop' to cancel.");
    expect(cancelWords({ killPhrase: false, stopKey: "Windows key, Alt, X" })).toBe("Press Windows key, Alt, X to cancel.");
    expect(cancelWords({ killPhrase: false, stopKey: null })).toBe("Press Stop to cancel.");
  });

  it.each([
    ["Pushing feature-x, as you asked. Say 'Ember, stop' to cancel.", "Pushing feature-x, as you asked. Say the stop phrase to cancel."],
    ["You can say “Ember, stop” at any time, or “Hey Ember, stop.”", "You can say the stop phrase at any time, or the stop phrase."],
    ["Say Hey Ember, then your request.", "Say the wake phrase, then your request."],
    ["Just say \"OK Ember\" and ask.", "Just say the wake phrase and ask."],
    ["Ember stop, ember please stop.", "the stop phrase, the stop phrase."],
  ])("doesn't say the wake or stop phrase: %j", (said, safe) => expect(withoutOwnPhrases(said)).toBe(safe));

  it.each(["Ember is listening.", "I stopped the timer.", "Members stop by at noon.", "Remember to stop the build."])("leaves %j as it is", t => expect(withoutOwnPhrases(t)).toBe(t));
});

describe("endsWithQuestion", () => {
  it.each([
    "There are three of them, and one is still running a command. Should I close that one too?",
    "Want me to open it? ",
    "Should I run this?\n\n```bash\nsudo dnf update\n```",
    "Which one: **the first** or *the second*?",
    "Shall I send it to “Sarah”?”",
  ])("%j asks something", t => expect(endsWithQuestion(t)).toBe(true));
  it.each(["Done. Night Light is on.", "What? No, that's already done.", "Here it is:\n\n```\nls -la\n```", ""])("%j doesn't", t => expect(endsWithQuestion(t)).toBe(false));
});

describe("withoutOwnPhrases and the cut-in (Windows, macOS: Ember can't tell its own voice from the user's)", () => {
  // Ember's own words never make it cut in on itself (review of PR #144: S1).
  it.each([
    "Hi Emma, the meeting moved.",
    "Okay, Emma's report is ready.",
    "Okay. Ember can't open that.",
    "Okay, PMB is the box",
    "Say “Hey Ember” and then what you want.",
    "Hey, Ember here. Okay, Ember is listening.",
    "You'll pay. Ember can't buy it.",
    "hey ember, stop",
    "OK Emmer, I'll do it.",
    "Hi! Ember's settings are open.",
    "They remember. Hey Ember!",
    "Okay! Ember is on it.",
    "Hi... Ember here.",
    "OK, ember.",
  ])("Ember saying %j can't sound like a cut-in", t => expect(heardCutInWake(withoutOwnPhrases(t))).toBe(false));

  it("names the wake phrase only where the greeting and the name sit together, and drops no word where a sentence ends between them", () => {
    expect(withoutOwnPhrases("Say “Hey Ember” and then what you want.")).toBe("Say the wake phrase and then what you want.");
    expect(withoutOwnPhrases("OK, Ember.")).toBe("the wake phrase.");
    expect(withoutOwnPhrases("Okay. Ember can't open that.")).toBe("Okay. So Ember can't open that.");
    expect(withoutOwnPhrases("You'll pay. Ember can't buy it.")).toBe("You'll pay. So Ember can't buy it.");
    expect(withoutOwnPhrases("Okay! Ember is on it.")).toBe("Okay! So Ember is on it.");
  });

  it.each(["Hey Ember, what's the weather?", "…in the evening. Hey, Ember", "Okay Ember", "Pay Ember open Notepad", "Hey Emmer"])("takes %j, said by the user, as one", t => {
    expect(heardCutInWake(t)).toBe(true);
  });

  it.each(["Hi Emma, the meeting moved.", "They remember the box.", "Hey Amber, dinner.", "Okay, Ember's report is ready.", "A. M. B."])("doesn't take %j as one", t => {
    expect(heardCutInWake(t)).toBe(false);
  });
});
