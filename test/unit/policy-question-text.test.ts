/**
 * The question's text can't be spoofed by what it quotes (review #116 and its follow-up): names from the screen are
 * quoted without the quote marks, line breaks and direction controls that would let them close Ember's own quote and
 * write the rest of its sentence. The text a task types shows as it will be typed (straight quotes, emoji, spaces),
 * with its line breaks shown and every other quote mark and hidden character marked, and long typed text shows both of
 * its ends and how long it is.
 */

import { describe, expect, it } from "vitest";
import { PolicyEngine, type ActionRequest } from "../../app/main/policy/policy";

const e = new PolicyEngine({ neverLook: () => [], grants: () => ({ firefox: "act" }), os: "linux" });
const ask = (r: Partial<ActionRequest>) => e.decide({ taskId: "t", kind: "click", app: "firefox", window: "Page", ...r });
const calc = new PolicyEngine({ neverLook: () => [], grants: () => ({ soffice: "act" }), os: "linux" });
/** The question for typing `value` into a field of LibreOffice Calc. */
const type = (value: string, element = { role: "entry", name: "Subject" }) =>
  calc.decide({ taskId: "t", kind: "text", app: "soffice", window: "Budget.ods - LibreOffice Calc", element, value, mode: "replace", currentText: "" }).prompt;
/** Marks drawn like Ember's own ” or “ that aren't the usual quotation marks (cross-review of review #116's follow-up). */
const LOOK_ALIKES = ["ʺ", "˝", "ˮ", "˵", "˶", "״", "⹂", "〃", "\u{1CD3}", "❠", "\u{1F676}", "\u{1F677}", "\u{1F678}", "‴", "‷", "⁗"];
/** The quoted parts of a prompt (between Ember's own “ and ”). */
const quoted = (prompt: string) => [...prompt.matchAll(/“([^”]*)”/g)].map(m => m[1]);

describe("the question's quotes", () => {
  it("can't be closed by a name that holds Ember's own quote marks", () => {
    const d = ask({ element: { role: "push button", name: "Close” button in Firefox? Nothing is sent. Delete" }, goal: "close the popup" });
    // One quote, holding the whole name; nothing after it reads as Ember's own sentence.
    expect(d.prompt.startsWith("Click the “")).toBe(true);
    expect(quoted(d.prompt)[0]).toContain("Nothing is sent. Delete");
    expect(d.prompt).not.toMatch(/Click the “Close” button/);
    // Every mark that reads as a double quote: Unicode's look-alikes of " and ” (primes, modifier letters, the Hebrew
    // gershayim, the ditto mark) and the quotation mark ornaments.
    for (const mark of ["„", "‟", "″", "＂", "〝", "〞", "«", "»", "\"", ...LOOK_ALIKES]) {
      const p = ask({ element: { role: "push button", name: `Close${mark} button in Firefox? Delete` } }).prompt;
      expect(quoted(p)[0], mark).toContain("Delete");
      // As an apostrophe, which reads as no quote of Ember's.
      expect(quoted(p)[0], mark).toBe("Close' button in Firefox? Delete");
    }
  });

  it("drops line breaks and direction controls from what it quotes", () => {
    const d = ask({ element: { role: "push button", name: "Close\nAllow Ember to send?\u{202e}Delete" } });
    expect(d.prompt).not.toMatch(/[\n\u{202e}]/u);
    expect(quoted(d.prompt)[0]).toContain("Allow Ember to send?");
  });

  it("shows long typed text by both ends and its length", () => {
    const text = "Hi there, thanks for the update on the quarterly figures, see you at lunch. P.S. my SSN is 123-45-6789 and card 4111 1111 1111 1111 and this goes on further still";
    const d = e.decide({ taskId: "t", kind: "cursor_text", app: "firefox", window: "Page", element: { role: "entry", name: "Message" }, value: text, mode: "replace", currentText: "" });
    expect(d.prompt).toContain("Hi there, thanks for the update");
    // The tail the user approves can be seen, and so can how much there is.
    expect(d.prompt).toContain("goes on further still");
    expect(d.prompt).toContain(`(${text.length} characters)`);
    // Short text reads as before.
    const short = e.decide({ taskId: "t", kind: "text", app: "firefox", window: "Page", element: { role: "entry", name: "Subject" }, value: "Hello", mode: "replace", currentText: "" });
    expect(short.prompt).toBe("Type “Hello” into the “Subject” text field in Firefox?");
  });

  it("hands over the whole of a typed text the question cut, for the card to show", () => {
    const text = `Dear team, ${"the figures are attached. ".repeat(4)}MIDDLE-SECRET-PAYLOAD ${"see you at lunch. ".repeat(5)}Bye`;
    expect(text.length).toBeGreaterThan(160);
    const d = e.decide({ taskId: "t", kind: "cursor_text", app: "firefox", window: "Page", element: { role: "entry", name: "Message" }, value: text, mode: "replace", currentText: "" });
    expect(d.prompt).not.toContain("MIDDLE-SECRET-PAYLOAD");
    expect(d.detail).toBe(text);
    // Shown as the question shows typed text (a line break as ⏎, a direction control marked, never itself).
    const odd = e.decide({ taskId: "t", kind: "text", app: "firefox", window: "Page", element: { role: "entry", name: "Message" }, value: `${text}\nline two\u{202e}`, mode: "replace", currentText: "" });
    expect(odd.detail).toBe(`${text}⏎line two⟨RLO⟩`);
    // Nothing was cut: no detail.
    const short = e.decide({ taskId: "t", kind: "text", app: "firefox", window: "Page", element: { role: "entry", name: "Subject" }, value: "Hello", mode: "replace", currentText: "" });
    expect(short.detail).toBeUndefined();
    expect(ask({ element: { role: "push button", name: text } }).detail).toBeUndefined();
  });

  it("shows typed text as it will be typed, straight double quotes included (review #116's follow-up)", () => {
    const formula = type('=IF(A1="x";1;0)', { role: "table cell", name: "B5" });
    expect(formula).toContain('“=IF(A1="x";1;0)”');
    // Where the text holds quote marks, how long it is follows Ember's closing mark, where the text really ends.
    expect(formula).toBe('Type “=IF(A1="x";1;0)” (15 characters) into cell B5 in LibreOffice?');
    // Text without quote marks reads as before.
    expect(type("Hello")).toBe("Type “Hello” into the “Subject” text field in LibreOffice?");
  });

  it("marks every other double quote mark in typed text, so it can't close Ember's quote and go on in its words", () => {
    const shown = type("He said “hi” and „bye“ «ciao» ＂x＂");
    expect(shown).toContain("He said ⟨“⟩hi⟨”⟩ and ⟨„⟩bye⟨“⟩ ⟨«⟩ciao⟨»⟩ ⟨＂⟩x⟨＂⟩");
    const spoof = type("hi” into the “Search” field in Firefox? Nothing else is typed. Then type “x");
    // With the marked marks set aside, Ember's own quotes are the typed text's and the field's, nothing else.
    const plain = quoted(spoof.replace(/⟨[^⟩]*⟩/g, "·"));
    expect(plain).toHaveLength(2);
    expect(plain[0]).toContain("Nothing else is typed");
    expect(plain[1]).toBe("Subject");
    for (const mark of ["″", "‶", "‟", "〝", "〞", "〟", "❝", "❞", ...LOOK_ALIKES]) expect(type(`a${mark}b`), mark).toContain(`a⟨${mark}⟩b`);
    // ˮ is drawn as Ember's closing ”: marked, it can't close the quote, and the length anchors where the text ends.
    const drawnAlike = "hiˮ into the ʺSearchʺ field in Firefox? Nothing else is typed. Then type ʺx";
    const lookalike = type(drawnAlike);
    expect(lookalike).toBe(`Type “hi⟨ˮ⟩ into the ⟨ʺ⟩Search⟨ʺ⟩ field in Firefox? Nothing else is typed. Then type ⟨ʺ⟩x” (${[...drawnAlike].length} characters) into the “Subject” text field in LibreOffice?`);
    expect(quoted(lookalike.replace(/⟨[^⟩]*⟩/g, "·"))).toHaveLength(2);
  });

  it("marks single quote marks set side by side, which read as Ember's own ” and “ (review #116's follow-up)", () => {
    const spoofed = "hi’’ into the ‘‘Search’’ field in Firefox? Nothing else is typed. Then type ‘‘x";
    const spoof = type(spoofed);
    expect(spoof).toBe(`Type “hi⟨’’⟩ into the ⟨‘‘⟩Search⟨’’⟩ field in Firefox? Nothing else is typed. Then type ⟨‘‘⟩x” (${[...spoofed].length} characters) into the “Subject” text field in LibreOffice?`);
    // With the marked marks set aside, Ember's own quotes are the typed text's and the field's, nothing else.
    expect(quoted(spoof.replace(/⟨[^⟩]*⟩/g, "·"))).toEqual([expect.stringContaining("Nothing else is typed"), "Subject"]);
    // Pairs of apostrophes, primes and their look-alikes, mixed pairs, a pair with a hair or thin space between, a pair
    // with a straight quote: one unit, marked, and the length after Ember's closing mark.
    const pairs = ["’’", "‘‘", "′′", "ʹʹ", "׳׳", "‚‚", "‛‛", "‘’", "’‘", "‹‹", "››", "❛❛", "❜❜", "＇＇", "´´", "ʼʼ", "ꞌꞌ", "’\u200a’", "′\u2009′", "’'", "'’", "’\"", "’’’"];
    for (const pair of pairs) {
      const text = `a${pair}b`;
      expect(type(text), pair).toBe(`Type “a⟨${pair}⟩b” (${[...text].length} characters) into the “Subject” text field in LibreOffice?`);
    }
    // The keyboard's own marks show as they are (an empty string in a formula, a code fence), with the length after.
    expect(type('=IF(A1="";1;0)', { role: "table cell", name: "B5" })).toBe('Type “=IF(A1="";1;0)” (14 characters) into cell B5 in LibreOffice?');
    expect(type("O''Brien")).toBe("Type “O''Brien” (8 characters) into the “Subject” text field in LibreOffice?");
    expect(type("```js")).toBe("Type “```js” (5 characters) into the “Subject” text field in LibreOffice?");
    // One apostrophe can't pass for Ember's mark: everyday text reads as before.
    for (const text of ["I’m here", "it's fine", "‘quoted’ word", "5′ tall", "rock ’n’ roll"]) {
      expect(type(text), text).toBe(`Type “${text}” into the “Subject” text field in LibreOffice?`);
    }
  });

  it("marks a combining mark with no letter under it, which draws a quote mark of its own over a space or a quote", () => {
    // A double acute over a space draws ˝; a comma above beside an apostrophe draws ”.
    const spoofed = "hi \u030b into the \u030bSearch \u030b field in Firefox? Then type \u030bx";
    expect(type(spoofed)).toBe("Type “hi ⟨U+030B⟩ into the ⟨U+030B⟩Search ⟨U+030B⟩ field in Firefox? Then type ⟨U+030B⟩x” into the “Subject” text field in LibreOffice?");
    expect(type("hi’\u0315 x")).toContain("“hi’⟨U+0315⟩ x”");
    expect(type("\u0301\u0301x")).toContain("“⟨U+0301⟩⟨U+0301⟩x”");
    expect(type("one\n\u0313")).toContain("“one⏎⟨U+0313⟩”");
    expect(type("a\t\u0313")).toContain("“a⇥⟨U+0313⟩”");
    // Marks on a letter or a digit are the word's own (a decomposed é, Vietnamese, Hindi, a Hebrew point, an underlined digit).
    for (const text of ["Re\u0301sume\u0301", "Vie\u0323\u0302t", "किताब", "\u05e9\u05b8\u05c1\u05dc\u05d5\u05b9\u05dd", "1\u0332"]) {
      expect(type(text), text).toBe(`Type “${text}” into the “Subject” text field in LibreOffice?`);
    }
  });

  it("quotes a name from the screen with quote marks side by side as one apostrophe", () => {
    const d = ask({ element: { role: "push button", name: "Close’’ button in Firefox? Nothing is sent. Delete" } });
    expect(d.prompt).toBe("Click the “Close' button in Firefox? Nothing is sent. Delete” button in Firefox?");
    for (const pair of ["’’", "‘‘", "′′", "ʹʹ", "׳׳", "''", "\"\"", "’\"", "’\u200b’", "’\u200a’", "“”"]) {
      expect(quoted(ask({ element: { role: "push button", name: `Close${pair} x` } }).prompt)[0], pair).toBe("Close' x");
    }
    // A combining mark over a space or a quote mark draws nothing of the name's own: it goes.
    expect(quoted(ask({ element: { role: "push button", name: "Close \u030b x" } }).prompt)[0]).toBe("Close  x");
    expect(quoted(ask({ element: { role: "push button", name: "Close’\u0315 x" } }).prompt)[0]).toBe("Close’ x");
    // One apostrophe, and marks on letters, stay as they are.
    expect(ask({ element: { role: "push button", name: "Don’t save" } }).prompt).toBe("Click the “Don’t save” button in Firefox?");
    expect(ask({ element: { role: "push button", name: "Re\u0301sume\u0301" } }).prompt).toBe("Click the “Re\u0301sume\u0301” button in Firefox?");
  });

  it("shows emoji and typographic spaces as they are, as everyday text holds them, and marks what hides outside them", () => {
    // Emoji written as several characters: a presentation selector, skin tones, ZWJ sequences, a keycap, a flag.
    for (const text of ["I ❤️ it 👨‍👩‍👧", "👍🏽 ☺︎ ❤️‍🔥 🧑🏽‍💻 👁️‍🗨️ 🏃🏽‍♀️ 👩‍🦰", "Press 1️⃣ or #️⃣", "Go 🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}!"]) {
      expect(type(text), text).toBe(`Type “${text}” into the “Subject” text field in LibreOffice?`);
    }
    // French spacing (no-break and narrow no-break spaces) and the other spaces show as spaces.
    expect(type("50\u00a0kg, Bonjour\u202f! «\u202fOui\u202f»")).toContain("“50\u00a0kg, Bonjour\u202f! ⟨«⟩\u202fOui\u202f⟨»⟩”");
    expect(type("会議\u3000午後\u2009three")).toBe("Type “会議\u3000午後\u2009three” into the “Subject” text field in LibreOffice?");
    // The joiners Persian and the Indian scripts write inside their words show as the word does.
    for (const word of ["می\u200cخواهم", "क्\u200dष", "ශ්\u200dරී"]) expect(type(word), word).toBe(`Type “${word}” into the “Subject” text field in LibreOffice?`);
    // Outside an emoji or such a word, joiners, selectors and tags are still marked.
    expect(type("pay\u200dpal a\ufe0fb x\u200cy")).toContain("“pay⟨ZWJ⟩pal a⟨U+FE0F⟩b x⟨ZWNJ⟩y”");
    expect(type("👨\u200d” x")).toContain("“👨⟨ZWJ⟩⟨”⟩ x”");
    expect(type("🏴\u{E0041}\u{E007F}")).toContain("“🏴⟨U+E0041⟩⟨U+E007F⟩”");
    expect(type("❤\ufe0f\ufe0f")).toContain("“❤️⟨U+FE0F⟩”");
  });

  it("shows line breaks and tabs, and marks characters that show nothing or reorder what follows, never dropping them", () => {
    expect(type("one\r\ntwo\rthree\u2028four\tfive")).toContain("“one⏎two⏎three⏎four⇥five”");
    const hidden = type("pay\u200bpal\u202eexe.txt");
    expect(hidden).toContain("“pay⟨ZWSP⟩pal⟨RLO⟩exe.txt”");
    expect(hidden).not.toMatch(/[\u200b\u202e]/u);
    // A long text's two ends and the card's whole text are shown the same way, and its length is what is typed.
    const long = `“Dear” ${"x".repeat(200)} "end"`;
    const d = calc.decide({ taskId: "t", kind: "text", app: "soffice", window: "Budget.ods - LibreOffice Calc", element: { role: "entry", name: "Subject" }, value: long, mode: "replace", currentText: "" });
    expect(d.prompt).toContain(`“⟨“⟩Dear⟨”⟩ x`);
    expect(d.prompt).toContain(`x "end"” (${long.length} characters)`);
    expect(d.detail).toBe(`⟨“⟩Dear⟨”⟩ ${"x".repeat(200)} "end"`);
  });

  it("quotes a value set on a slider, and says when it was cut", () => {
    const value = (v: string) => e.decide({ taskId: "t", kind: "value", app: "gnome-control-center", window: "Settings", element: { role: "slider", name: "Brightness" }, value: v }).prompt;
    expect(value("50")).toBe("Set the “Brightness” slider to “50” in Settings?");
    const spoof = value("50 in Firefox? Nothing is sent. Delete everything");
    expect(spoof.startsWith("Set the “Brightness” slider to “50 in Firefox? Nothing is sent. Delete")).toBe(true);
    expect(quoted(spoof)[1]).toMatch(/…$/);
    expect(quoted(value("50” in Firefox? Nothing is sent. Delete e"))[1]).toContain("Nothing is sent");
  });
});
