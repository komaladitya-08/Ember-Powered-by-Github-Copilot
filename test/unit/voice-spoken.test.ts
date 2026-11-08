/** What Ember says out loud for an answer: the words, not the Markdown, code or addresses. */

import { describe, expect, it } from "vitest";
import { AnswerLanguage, cancelWords, endsWithQuestion, speechLanguage, spokenText, withoutOwnPhrases } from "../../app/voice/spoken";
import { heardCutInWake } from "../../app/voice/engine";

describe("spokenText says keys, menu paths and symbols as people say them", () => {
  it.each([
    ["Press Ctrl+Shift+T to reopen the tab.", "Press Control Shift T to reopen the tab."],
    ["Use `Win+Shift+S` for a screenshot.", "Use Windows key Shift S for a screenshot."],
    ["Cmd + Space opens Spotlight.", "Command Space opens Spotlight."],
    ["Ctrl+Alt+Del, then Esc.", "Control Alt Delete, then Esc."],
    ["Open Settings › Privacy › Camera.", "Open Settings, then Privacy, then Camera."],
    ["Drag it from Documents → Archive.", "Drag it from Documents to Archive."],
    ["Tom & Jerry", "Tom and Jerry"],
    // Not chords, not paths: left as they are.
    ["C++ and a+b are fine, and so is 3 + 4.", "C++ and a+b are fine, and so is 3 + 4."],
    ["Rows 1 & 2, and a && b.", "Rows 1 & 2, and a && b."],
  ])("%j is said %j", (text, said) => expect(spokenText(text)).toBe(said));

  it("reads a chord only where it stands on its own, never inside a word, an address or a path (review of #143)", () => {
    for (const text of ["Write to ops.alt+s@example.com today.", "Open build/ctrl+c.log now.", "The file is shift+x.txt."]) {
      expect(spokenText(text), text).not.toMatch(/\b(?:alt s|Control c|shift x)\b/);
    }
    expect(spokenText("Then press Ctrl+S.")).toBe("Then press Control S.");
  });
});

describe("spokenText says money, times, paths and numbers as people say them, and no emoji (voice-speaking-2)", () => {
  it.each([
    ["That's $5.", "That's 5 dollars."],
    ["It costs $12.50 a month.", "It costs 12 dollars 50 a month."],
    ["It costs $1.05, or $1.", "It costs 1 dollar and 5 cents, or 1 dollar."],
    ["Only $0.99 now.", "Only 99 cents now."],
    ["It's £3.20, about €11.", "It's 3 pounds 20, about 11 euros."],
    ["That's 50p, I mean £0.50.", "That's 50p, I mean 50 pence."],
    ["They raised $2.5M and then $3 billion.", "They raised 2.5 million dollars and then 3 billion dollars."],
    ["It came to $1,234.56.", "It came to 1,234 dollars 56."],
    ["The meeting is at 14:00.", "The meeting is at 14 hundred."],
    ["Reminder at 10:00.", "Reminder at 10 o'clock."],
    ["It starts at 9:05 AM and ends at 3:30 p.m.", "It starts at 9 oh 5 AM and ends at 3 30 p.m."],
    ["At 3:00 pm, or 00:00.", "At 3 pm, or midnight."],
    ["Meeting on Tue. with Dr. Smith, from Jan. 5.", "Meeting on Tuesday with Dr. Smith, from January 5."],
    ["The answer is 42%. That's ~75% of it.", "The answer is 42%. That's about 75% of it."],
    ["See issue #45.", "See issue number 45."],
    ["The file is at `~/Documents/report.pdf`, 2.4 MB.", "The file is at report.pdf in Documents, 2.4 MB."],
    ["I saved C:\\Users\\alex\\Documents\\notes.txt for you.", "I saved notes.txt in Documents for you."],
    ["Copied 1,234 files to /mnt/backup.", "Copied 1,234 files to backup."],
    ["It's in ~/Ember/report.pdf and ~/notes.txt.", "It's in report.pdf in Ember and notes.txt in your home folder."],
    ["Done ✅ I closed 3 windows 🎉", "Done. I closed 3 windows"],
    ["Hey there! :) How are you?", "Hey there! How are you?"],
    ["Great job 👍🏽, and 👨‍👩‍👧 too.", "Great job, and too."],
    ["Saved✅next time, ✅Done.", "Saved next time, Done."],
  ])("%j is said %j", (text, said) => expect(spokenText(text)).toBe(said));

  it.each([
    ["I ❤️ it.", "I love it."],
    ["I ❤ Paris, and ♥️ jazz too.", "I love Paris, and love jazz too."],
    ["It took 2h 15m, then 1h30m more.", "It took 2 hours 15 minutes, then 1 hour 30 minutes more."],
    ["It's at github.com/foo/bar and docs.python.org/3/library.", "It's at github.com and docs.python.org."],
  ])("%j is said %j, a heart as a word, a duration and an address without its path (voice-speaking-2)", (text, said) => expect(spokenText(text)).toBe(said));

  it.each([
    ["Press the → key to go on.", "Press the right arrow key to go on."],
    ["Use the ← and → keys.", "Use the left arrow and right arrow keys."],
    ["Press ↑ twice, then ↓.", "Press up arrow twice, then down arrow."],
    ["Go Back→Next.", "Go Back to Next."],
    ["It's $5-$10 a month, or £5 – £8.", "It's 5 dollars to 10 dollars a month, or 5 pounds to 8 pounds."],
    ["Free 10:30–11:00 and 14:00 - 15:30.", "Free 10 30 to 11 o'clock and 14 hundred to 15 30."],
    ["Read pages 5–10, from 2020–2024.", "Read pages 5 to 10, from 2020 to 2024."],
  ])("%j is said %j, an arrow by its name and a range with its 'to' (voice-speaking-2)", (text, said) => expect(spokenText(text)).toBe(said));

  it("says nothing for an answer that is only emoji", () => {
    expect(spokenText("🎉🎉")).toBe("");
    expect(spokenText("- 🎉\n- ✅")).toBe("");
  });

  it.each([
    // Not money, times or paths: said as before.
    "Use $HOME and A$5 as they are.",
    "The ratio is 16:9, and John 3:16 is a verse.",
    "It ran for 10:00:05 in all.",
    "Read and/or write 1/2 of it, at github.com.",
    "Open src/main.ts and notes.txt/old, about 15m away.",
    "Install C++ and © 2026 Ember™.",
    "A 5-star hotel, rows 1-2 and a well-known 3-4 day trip.",
  ])("leaves %j as it is", text => expect(spokenText(text)).toBe(text.replace("John 3:16", "John 3 16")));
});

describe("spokenText", () => {
  it.each([
    ["Run this:\n\n```bash\nsudo dnf install foo\n```\n\nThen restart.", "Run this:\n(code shown in the bubble)\nThen restart."],
    ["Still streaming:\n```\nsome code", "Still streaming:\n(code shown in the bubble)"],
    ["See [the docs](https://example.com/docs) or https://github.com/k2-fsa/sherpa-onnx/releases.", "See the docs or github.com."],
    ["See [the guide](https://example.com/a(b(c)d)e) and ![the chart](https://example.com/plot(1).svg).", "See the guide and the chart."],
    ["See [the guide](https://example.com/a\\)b).", "See the guide."],
    ['See [the guide](<https://example.com/a(b> "A (title").', "See the guide."],
    ["Type ``a`b``.", "Type a`b."],
    ["Open www.redhat.com, then click **Login**.", "Open redhat.com, then click Login."],
    ["Use `ls -la` to list *all* files.", "Use ls -la to list all files."],
    ["## Steps\n- First\n- Second\n\n1. One\n2. Two", "Steps.\nFirst.\nSecond.\n1. One.\n2. Two."],
    ["| App | Size |\n|---|---|\n| Files | 2 MB |\nThat's all.", "(table shown in the bubble)\nThat's all."],
    ["> Quoted\n\n---\n\nEnd ~~old~~ new", "Quoted.\nEnd old new"],
    ["snake_case_name and 2*3*4 stay", "snake_case_name and 2*3*4 stay"],
    ["Say it *softly*, **firmly** or _slowly_ (*really*).", "Say it softly, firmly or slowly (really)."],
    ["**Ember**'s answer, in ***bold italics***.", "Ember's answer, in bold italics."],
  ])("%j", (markdown, said) => expect(spokenText(markdown)).toBe(said));

  // A list's items, a heading, the line that leads into a list and a paragraph each end with a stop, so the voice
  // pauses between them instead of saying "Firefox Files Terminal Mail" in one breath (voice-speaking-3).
  it.each([
    ["Your apps:\n- Text Editor\n- Calendar\n- Contacts", "Your apps:\nText Editor.\nCalendar.\nContacts."],
    ["Open now\n* Firefox\n* Files", "Open now.\nFirefox.\nFiles."],
    ["# Done\n\nI closed it\n\nAnything else?", "Done.\nI closed it.\nAnything else?"],
    ["- **Done!**\n- Is it on?\n- Maybe, later;\n- See [the guide](https://example.com)", "Done!\nIs it on?\nMaybe, later;\nSee the guide."],
    ["1) Keep it\n2) Delete it", "1) Keep it.\n2) Delete it."],
    // A line wrapped inside a paragraph is one sentence still, and what is shown in the bubble keeps its words.
    ["I opened the file and\nfound three errors.", "I opened the file and\nfound three errors."],
    ["Run this:\n\n```sh\nls\n```\n\nThen restart.", "Run this:\n(code shown in the bubble)\nThen restart."],
    // Lines with no list marker, each a few words, are a list too; a line that is all bold is a heading.
    ["Your windows\nFirefox\nFiles\nTerminal", "Your windows.\nFirefox.\nFiles.\nTerminal."],
    ["**Done**\nI closed it.", "Done.\nI closed it."],
    ["**Next steps:**\nOpen the file.", "Next steps:\nOpen the file."],
    ["I looked at the\nfolder and found\nthree errors.", "I looked at the\nfolder and found\nthree errors."],
  ])("ends the lines of %j so they are said apart (voice-speaking-3)", (markdown, said) => expect(spokenText(markdown)).toBe(said));

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

describe("speechLanguage: which language a reply is in, so Kitten (English only) never reads another (voice-speaking-11)", () => {
  it.each([
    ["我已经打开了设置。", "zh"],
    ["設定を開きました。", "ja"],
    ["설정을 열었습니다.", "ko"],
    ["Я открыл настройки.", "ru"],
    ["Άνοιξα τις ρυθμίσεις.", "el"],
    ["فتحت الإعدادات.", "ar"],
    ["J'ai ouvert les paramètres.", "fr"],
    ["Ich habe die Einstellungen geöffnet und das ist gut.", "de"],
    ["He abierto la configuración y los ajustes del sistema.", "es"],
    ["Ho aperto le impostazioni e il pannello della rete.", "it"],
  ])("%j is %j", (text, lang) => expect(speechLanguage(text)).toBe(lang));

  it.each([
    "I opened Settings.",
    "Open the café menu, then the résumé.",
    "The file 设置.txt is ready in Documents.",
    "Done.",
    "",
    "(code shown in the bubble)",
    "Bonjour is French for hello, and that is what it means.",
    // English that shares short words with other languages.
    "I'd say I'd open it.",
    "No, he didn't.",
    "As soon as it's done, see github.com.",
    "Come in and see the van.",
  ])("takes %j as English (or can't tell): Kitten says it", text => expect(speechLanguage(text)).toBeNull());

  it.each([
    "Playing La Vie en Rose.",
    "Done. I played Por Una Cabeza.",
    "Los Angeles, San Diego and Las Vegas.",
    "Visit El Paso, Las Cruces or Los Alamos.",
    "1. La La Land.",
    "2. Les Misérables.",
    "Your playlist has La Bamba, La Isla Bonita and Por Una Cabeza.",
    "Leonardo da Vinci painted it.",
    "The café is on Rue de Rivoli.",
    "Meeting at 10 o'clock with Anna and Paul.",
    "Um, I think so.",
  ])("takes %j, English with a name from another language, as English (voice-speaking-r1)", text => expect(speechLanguage(text)).toBeNull());

  it.each([
    ["Il y a trois fenêtres ouvertes : Firefox, Fichiers et Terminal.", "fr"],
    ["Autre chose ? Je suis là si vous avez besoin de moi.", "fr"],
    ["No puedo hacer eso, pero puedo ayudarte a encontrar el archivo.", "es"],
    ["Es sind drei Fenster offen: Firefox, Dateien und Terminal.", "de"],
    ["Fertig! Das Meeting ist um drei Uhr mit Anna und Paul.", "de"],
    ["Non posso farlo, ma posso aiutarti a trovare il file.", "it"],
    ["Não posso fazer isso, mas posso ajudar você a encontrar o arquivo.", "pt"],
    ["Pronto! A reunião é às três com Maria e Paulo.", "pt"],
    ["Klaar! De vergadering is om drie uur met Anna en Paul.", "nl"],
  ])("still finds %j is %j, beside its names (voice-speaking-r1)", (text, lang) => expect(speechLanguage(text)).toBe(lang));

  it.each([
    "It's « je ne sais pas ». In casual speech people often say « chais pas » or just « sais pas ».",
    "You'd say \"¿Dónde está el baño?\" It means \"Where is the bathroom?\" and works anywhere.",
    "Say 'je ne sais pas' when you don't know.",
  ])("takes %j, English quoting another language, as English (voice-speaking-r2-1)", text => expect(speechLanguage(text)).toBeNull());

  it.each([
    ["Le titre est « La Vie en Rose », et le fichier est dans vos documents.", "fr"],
    ["« Merci beaucoup, je vous remercie. »", "fr"],
    ["Ich habe „Bericht.pdf“ geöffnet und die Tabelle ist fertig.", "de"],
  ])("still finds %j is %j, beside what it quotes, or all quotes (voice-speaking-r2-1)", (text, lang) => expect(speechLanguage(text)).toBe(lang));
});

describe("AnswerLanguage: an answer is said in one language, decided once from enough of it (voice-speaking-r1, voice-speaking-11)", () => {
  const said = (pieces: string[], o: { request?: string } = {}) => {
    const a = new AnswerLanguage();
    a.reset(o.request ?? "");
    const out: { text: string; lang: string | null; at: number }[] = [];
    pieces.forEach((p, i) => { for (const x of a.take([p], i === pieces.length - 1)) out.push({ ...x, at: i }); });
    return out;
  };

  it("says every piece of an English answer in Ember's voice, its films' and songs' names too", () => {
    for (const pieces of [
      ["Done.", "I played Por Una Cabeza.", "It is a tango from 1935, and it should be playing now."],
      ["Here are three films you might like:", "1. La La Land.", "2. Les Misérables.", "3. Amélie."],
      ["Playing La Vie en Rose.", "It is by Édith Piaf, from 1947.", "Shall I play more of hers?"],
      ["Los Angeles, San Diego and Las Vegas.", "All three are about four hours apart by car, and the drive is easy."],
      ["C'est la vie, as they say.", "I couldn't find the file you asked for, so I opened your Documents folder instead."],
    ]) {
      const out = said(pieces);
      expect(out.map(x => x.text), pieces[0]).toEqual(pieces);
      expect(out.every(x => x.lang === null), pieces[0]).toBe(true);
    }
  });

  it("starts an English answer at once, and holds nothing back once it knows", () => {
    const out = said(["Sure.", "I opened the report for you, and the totals are at the bottom of its first page.", "1. La La Land."]);
    expect(out.map(x => x.at)).toEqual([0, 1, 2]);
  });

  it("says the short first words of a reply in another language in that language, not in Ember's English voice", () => {
    for (const [pieces, lang] of [
      [["Bien sûr !", "Voici les trois fichiers que vous avez demandés.", "Le premier est le rapport de ventes."], "fr"],
      [["Voilà !", "La réunion est à quinze heures avec Marie et Paul."], "fr"],
      [["¡Listo!", "La reunión es a las tres con María y Pablo."], "es"],
      [["Natürlich.", "Ich habe die Datei geöffnet und zwei Fehler in der Tabelle gefunden."], "de"],
    ] as [string[], string][]) {
      const out = said(pieces);
      expect(out.map(x => x.text), pieces[0]).toEqual(pieces);
      expect(out.every(x => x.lang === lang), pieces[0]).toBe(true);
    }
  });

  it("follows a request typed in another language for a reply too short to tell", () => {
    expect(said(["Claro."], { request: "¿Puedes abrir los archivos que te pedí ayer?" })).toEqual([{ text: "Claro.", lang: "es", at: 0 }]);
    expect(said(["Fertig!", "Ich habe die Datei geöffnet und zwei Fehler in der Tabelle gefunden."], { request: "Kannst du die Datei öffnen und mir sagen, was nicht stimmt?" }).map(x => x.lang)).toEqual(["de", "de"]);
    // A long enough answer is judged by its own words.
    expect(said(["Sure.", "I opened the files you asked for, and the totals are at the bottom of the first one."], { request: "¿Puedes abrir los archivos?" }).map(x => x.lang)).toEqual([null, null]);
  });

  it.each([
    ["play la vie en rose", ["Playing La Vie en Rose."]],
    ["play por una cabeza on spotify", ["Playing Por Una Cabeza in Spotify now."]],
    ["what does c'est la vie mean?", ["It means that's life."]],
    ["Translate 'je ne sais pas' for me", ["It means I don't know."]],
    ["what does je ne sais quoi mean", ["It means an indefinable quality."]],
    ["search for la casa de papel", ["I found it on Netflix."]],
    ["put on por una cabeza", ["It's playing now."]],
  ])("says a short English reply to %j, a request that only names or quotes another language, in Ember's voice (voice-speaking-r2-1)", (request, pieces) => {
    expect(said(pieces, { request }).map(x => x.lang)).toEqual(pieces.map(() => null));
  });

  it("follows the request's language only when the request is clearly in it and the reply has no more English than that (voice-speaking-r2-1)", () => {
    // Clearly Spanish, a reply with no English: Spanish.
    expect(said(["Sí, claro."], { request: "¿Puedes abrir los archivos que te pedí ayer?" }).map(x => x.lang)).toEqual(["es"]);
    // Clearly French, but the reply is English: Ember's voice.
    expect(said(["It means I don't know."], { request: "que veut dire je ne sais pas ?" }).map(x => x.lang)).toEqual([null]);
    // Quoted words aren't the request's language.
    expect(said(["Claro."], { request: "What does \"no sé lo que es\" mean?" }).map(x => x.lang)).toEqual([null]);
  });

  /** A turn of several messages: each but the last ends before a tool call (main's onAnswerEnd). */
  const turn = (messages: string[][], request: string) => {
    const a = new AnswerLanguage();
    a.reset(request);
    return messages.flatMap((pieces, m) => pieces.flatMap((p, i) => a.take([p], i === pieces.length - 1, m < messages.length - 1)));
  };

  it("lets no message before a tool call decide the language of the messages after it (voice-speaking-r2-1)", () => {
    const english = turn([["Sure, opening Spotify."], ["Playing La Vie en Rose by Édith Piaf in Spotify now.", "It's the 1947 recording, and the volume is at half."]], "play la vie en rose on spotify");
    expect(english.map(x => x.lang)).toEqual([null, null, null]);
    const netflix = turn([["Opening Netflix."], ["I found Money Heist, the English title of La Casa de Papel.", "Shall I start the first episode?"]], "find la casa de papel on netflix");
    expect(netflix.map(x => x.lang)).toEqual([null, null, null]);
    // A short English preamble doesn't fix a French answer after it to Ember's English voice either.
    const french = turn([["One moment."], ["Voici les trois fichiers que vous avez demandés.", "Le premier est le rapport de ventes."]], "Open the files");
    expect(french.map(x => x.lang)).toEqual([null, "fr", "fr"]);
  });

  it.each([
    [["Sure, I opened Café Nero.", "The menu lists soups and salads."]],
    [["Playing Beyoncé in Spotify.", "Shall I turn it up?"]],
    [["There's a café two streets away.", "It opens at eight."]],
    [["I opened your résumé in LibreOffice.", "It is two pages long."]],
    [["São Paulo is three hours ahead.", "Shall I add it to your clocks?"]],
  ])("says the first words of %j at once, an accented name or loanword no reason to wait (voice-speaking-r2-2)", pieces => {
    const out = said(pieces);
    expect(out.map(x => x.at)).toEqual([0, 1]);
    expect(out.map(x => x.lang)).toEqual([null, null]);
  });

  it("still holds the short first words of a reply that may be in another language (voice-speaking-r2-2)", () => {
    for (const first of ["Bien sûr !", "¡Listo!", "Natürlich.", "Voilà !", "On a déjà ouvert le fichier."]) {
      const a = new AnswerLanguage();
      a.reset("");
      expect(a.take([first]), first).toEqual([]);
    }
  });

  it("decides nothing from an empty message, and starts again for the next answer", () => {
    const a = new AnswerLanguage();
    a.reset("");
    expect(a.take([], true)).toEqual([]);
    expect(a.take(["Bien sûr !", "Voici les trois fichiers que vous avez demandés."], true).map(x => x.lang)).toEqual(["fr", "fr"]);
    expect(a.take(["Et voilà le dernier."], true)).toEqual([{ text: "Et voilà le dernier.", lang: "fr" }]);
    a.reset("Open the report");
    expect(a.take(["Done.", "I opened it, and the totals are at the bottom of the first page as you wanted."], true).map(x => x.lang)).toEqual([null, null]);
  });
});
