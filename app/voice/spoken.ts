/**
 * What Ember says out loud for an answer written in Markdown: the words, not the markup. Code is left to the
 * bubble (read aloud, it's noise), a link is said by its text, a bare address by its site's name.
 */

const CODE = "(code shown in the bubble)";
const TABLE = "(table shown in the bubble)";
const FENCED_CODE = /(^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?(\n[ \t]*\2[ \t]*(?=\n|$)|$)/g;

/** End of a link target, allowing balanced or escaped parentheses and quoted titles. */
function linkEnd(text: string, from: number): number {
  let depth = 1;
  let closer = text[from] === "<" ? ">" : "";
  for (let i = from; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (closer) { if (c === closer) closer = ""; continue; }
    if (depth === 1 && (c === '"' || c === "'") && /\s/.test(text[i - 1])) closer = c;
    else if (c === "(") depth++;
    else if (c === ")") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Scan the same inline boundaries for streaming cuts and for removing finished link targets. */
function inlineComplete(text: string, link?: (start: number, label: string, end: number) => void): boolean {
  let ticks = 0, brackets = 0, labelStart = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!ticks && c === "\\") { i++; continue; }
    if (c === "`") {
      const start = i;
      while (text[i + 1] === "`") i++;
      const count = i - start + 1;
      if (ticks === count) ticks = 0;
      else if (!ticks) ticks = count;
    } else if (!ticks && c === "[") {
      if (!brackets) labelStart = i;
      brackets++;
    } else if (!ticks && c === "]" && brackets) {
      brackets--;
      if (brackets || text[i + 1] !== "(") continue;
      const end = linkEnd(text, i + 2);
      if (end < 0) return false;
      link?.(text[labelStart - 1] === "!" ? labelStart - 1 : labelStart, text.slice(labelStart + 1, i), end);
      i = end - 1;
    }
  }
  return !ticks && !brackets;
}

/** A streamed prefix can be said only after its fences and inline markup close. */
export function speechMarkupOpen(markdown: string): boolean {
  const fences = (markdown.match(/(^|\n)[ \t]*(```|~~~)/g) ?? []).length;
  return fences % 2 !== 0 || !inlineComplete(markdown.replace(FENCED_CODE, "$1"));
}

function linkLabels(text: string): string {
  let words = "", from = 0;
  inlineComplete(text, (start, label, end) => { words += text.slice(from, start) + label; from = end; });
  return words + text.slice(from);
}

/**
 * A key chord as written ("Ctrl+Alt+Y", "Win + Shift + S", "Cmd+Space"): modifiers joined by "+" to a key, standing on
 * its own: never inside a word, an address or a path ("me.alt+s@example.com", "build/ctrl+c"; review of #143).
 */
const CHORD = /(?<![\w.@+/\\-])(?:(?:ctrl|control|alt|shift|win|super|cmd|command|option|opt|fn)\s*\+\s*)+(?:f\d{1,2}|[a-z0-9]|[←→↑↓]|enter|return|esc|escape|tab|space|delete|del|backspace|home|end|pgup|pgdn|up|down|left|right|period|comma|plus|minus)(?![\w@+/\\-]|\.\w)/gi;
/** How a key in a chord is said (keyLabel's names, for the ear): the rest are said as they are written. */
/** An arrow said by its name, where it is a key or a symbol ("Press the → key"): Kitten said "the → key" as "the to key". */
const ARROW: Readonly<Record<string, string>> = { "←": "left arrow", "→": "right arrow", "↑": "up arrow", "↓": "down arrow" };
const KEY_SAID: Readonly<Record<string, string>> = {
  ctrl: "Control", win: "Windows key", cmd: "Command", opt: "Option", esc: "Escape", del: "Delete", return: "Enter",
  pgup: "Page Up", pgdn: "Page Down",
};
/** Only an arrow's direction, before the word "arrow": "the ↑ arrow key" was "the up arrow arrow key" (voice-speaking-r3-1). */
const DIRECTION: Readonly<Record<string, string>> = { "←": "left", "→": "right", "↑": "up", "↓": "down" };
/** The words an arrow points the same way as, after which it is said once ("up ↑" was "up up arrow"). */
const SAME_WAY: Readonly<Record<string, readonly string[]>> = { "←": ["left", "back"], "→": ["right", "forward"], "↑": ["up"], "↓": ["down"] };
/**
 * After its own direction, a "→" before one of these, a key's word or no other word is said once ("Swipe right → to go
 * back", "turn right → at the end"); before any other word it is a step, said "to" ("the top right → Settings" was "the
 * top right Settings": voice-speaking-v4-2), and so is a name in quotes or brackets after a space ("the top right →
 * “Settings”" was "the top right “Settings”": voice-speaking-v5-3), though not an aside of those words ("→ (twice)").
 */
const ONCE_BEFORE = /^(?:[^\p{L}\p{N} \t]|[ \t]*(?:$|(?!["“‘'«[(][ \t]*\p{L})[^\p{L}\p{N} \t]|\(?[ \t]*(?:to|at|on|in|into|onto|for|from|of|by|with|and|or|then|but|so|until|till|twice|again|once|a|an|the|here|there|now|too|as|if|when|while|keys?|buttons?|arrows?)\b))/iu;
/** An arrow, a list of them ("← and →", "←/→", "↑↓"), or a spaced "->": said as arrowSaid decides. */
const ARROWS = /[←→↑↓](?:(?:[ \t]*,?[ \t]+(?:and|or)[ \t]+|[ \t]*[,/][ \t]*|[ \t]*)[←→↑↓])*|(?<=[ \t])->(?=[ \t])/gi;

/**
 * An arrow (or a list of them) said for the ear (voice-speaking-2): before the word "arrow" by its direction ("the ← and
 * → arrow keys" is "the left and right arrow keys"); one between two words as "to" ("Documents → Archive", "Back→Next"),
 * unless it names a key: after "the" or "press", before "key", or before "to" ("Click Next → to go on" was "Next to to");
 * any other by its name ("Press ← or → to move" was "left arrow or to to move").
 */
function arrowSaid(run: string, at: number, all: string): string {
  const before = all.slice(Math.max(0, at - 8), at), after = all.slice(at + run.length, at + run.length + 12);
  const each = (say: Readonly<Record<string, string>>) => run.replace("->", "→").replace(/[ \t]*\/[ \t]*/g, " or ").replace(/[←→↑↓](?=[←→↑↓])/g, "$& ").replace(/[←→↑↓]/g, a => say[a]);
  // (A lower-case "a" only: "A → B → C" names no key.)
  // (A lower-case "to" only, and never "to-do": "Microsoft 365 → To Do" names an app, not a key.)
  const key = /\b(?:the|an|press|hit|tap|use|hold)[ \t]+$/i.test(before) || /\ba[ \t]+$/.test(before) || /^[ \t]+(?:keys?|buttons?|icons?|symbols?|signs?)\b/i.test(after) || /^[ \t]+to\b(?!-)/.test(after);
  const between = /[\p{L}\p{N} \t]$/u.test(before) && /^[\p{L}\p{N} \t]/u.test(after);
  const said = /^[ \t]+arrows?\b/i.test(after) ? each(DIRECTION) : (run === "→" || run === "->") && !key && between ? "to" : each(ARROW);
  // Never joined to the word beside it ("Back→Next", "5→10").
  return `${/[\p{L}\p{N}]$/u.test(before) ? " " : ""}${said}${/^[\p{L}\p{N}]/u.test(after) ? " " : ""}`;
}

/**
 * A pictograph (an emoji, a flag) with its skin tone, variation and the ones joined to it ("👨‍👩‍👧"): read aloud, Kitten says
 * its name ("white heavy check mark", "party popper"). ©, ® and ™ are said as words, so they stay.
 */
const PICTOGRAPH = "(?:(?![©®™])\\p{Extended_Pictographic}|[\\u{1F1E6}-\\u{1F1FF}])(?:\\u{FE0E}|\\u{FE0F}|\\u{20E3}|[\\u{1F3FB}-\\u{1F3FF}]|[\\u{E0020}-\\u{E007F}])*";
const EMOJI = `${PICTOGRAPH}(?:\\u200D${PICTOGRAPH})*`;
/** An emoji between a word and a capitalised one ends a sentence there ("Done ✅ I closed…" is "Done. I closed…"). */
const EMOJI_BETWEEN = new RegExp(`([\\p{L}\\p{N}])[ \\t]*(?:${EMOJI}[ \\t]*)+[ \\t](?=\\p{Lu})`, "gu");
const EMOJI_ANY = new RegExp(`[ \\t]*(?:${EMOJI})+|\\u{FE0F}|\\u{20E3}`, "gu");
/** A smiley typed as text, standing on its own (":)", ";-)", ":D", "<3"): Kitten said ":)" as "colon". */
const EMOTICON = /(?:^|[ \t]+)(?:[:;]-?[()DPp]|<3)(?=[\s.,!?]|$)/gm;

/** How each currency's amounts are said: its unit, and its hundredth (none for the yen). */
const MONEY: Readonly<Record<string, { one: string; many: string; part?: [string, string] }>> = {
  $: { one: "dollar", many: "dollars", part: ["cent", "cents"] },
  "£": { one: "pound", many: "pounds", part: ["penny", "pence"] },
  "€": { one: "euro", many: "euros", part: ["cent", "cents"] },
  "¥": { one: "yen", many: "yen" },
};
const AMOUNT = /(?<![\w$£€¥])([$£€¥])[ \t]?(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2})(?!\d))?(?:[ \t]?(k|K|m|M|bn|B|thousand|million|billion|trillion)\b)?/g;
const SCALE: Readonly<Record<string, string>> = { k: "thousand", K: "thousand", m: "million", M: "million", bn: "billion", B: "billion" };

/** "$12.50" as "12 dollars 50", "$1.05" as "1 dollar and 5 cents", "$0.99" as "99 cents", "$2.5M" as "2.5 million dollars". */
function money(_m: string, sign: string, whole: string, part: string | undefined, scale: string | undefined): string {
  const c = MONEY[sign];
  if (scale) return `${whole}${part ? `.${part}` : ""} ${SCALE[scale] ?? scale} ${c.many}`;
  const unit = `${whole} ${whole === "1" ? c.one : c.many}`;
  const cents = part ? Number(part.padEnd(2, "0")) : 0;
  if (!cents) return unit;
  if (!c.part) return `${whole}.${part} ${c.many}`;
  if (whole === "0") return `${cents} ${cents === 1 ? c.part[0] : c.part[1]}`;
  return cents < 10 ? `${unit} and ${cents} ${cents === 1 ? c.part[0] : c.part[1]}` : `${unit} ${cents}`;
}

/**
 * A clock time ("14:00", "9:05", "3:30"): Kitten said "14:00" as "14 Zhao Zhou" and "9:05" as "nine's in five". It is
 * said "14 hundred", "10 o'clock", "9 oh 5", "3 30", and "3 pm" before am or pm. Never a ratio ("16:9"), seconds
 * ("10:00:05") or part of a longer number.
 */
const CLOCK = /(?<![\w:.,$£€¥])([01]?\d|2[0-3]):([0-5]\d)(?![\d:])(?=([ \t]?[ap]\.?m\b)?)/gi;
function clock(_m: string, h: string, mm: string, meridiem: string | undefined): string {
  const hour = Number(h), minutes = Number(mm);
  if (minutes >= 10) return `${hour} ${mm}`;
  if (minutes) return `${hour} oh ${minutes}`;
  if (meridiem) return `${hour}`;
  return hour === 0 ? "midnight" : hour > 12 ? `${hour} hundred` : `${hour} o'clock`;
}

/**
 * A file's or a folder's path ("~/Documents/report.pdf", "C:\\Users\\alex\\notes.txt", "/mnt/backup"): read out, it was
 * "tilde slash ember slash report.pdf" (and 7.9 s for a Windows one). A file is said with its folder ("report.pdf in
 * Documents"), anything else by its last part ("backup"); the bubble shows the whole path. An address, "and/or" and
 * "1/2" aren't paths. A folder or a file whose name starts with a dot is one like any other ("~/.config/ember":
 * "/home/me/.config/ember/settings.json" was "me.config/ember/settings.json", voice-speaking-r7-2).
 */
const PATH = /(?<![\w.~/\\:-])(?:~(?:\/\.?[\w@+-]+(?:\.[\w@+-]+)*)+|\/(?:\.?[\w@+-]+(?:\.[\w@+-]+)*\/)+\.?[\w@+-]+(?:\.[\w@+-]+)*|[A-Za-z]:\\(?:[\w@+$-]+(?:\.[\w@+$-]+)*\\)*[\w@+$-]+(?:\.[\w@+$-]+)*)\/?/g;
function pathSaid(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  const name = parts[parts.length - 1], folder = parts[parts.length - 2];
  if (!/\.[A-Za-z0-9]{1,6}$/.test(name) || !folder || /^[A-Za-z]:$/.test(folder)) return name;
  return `${name} in ${folder === "~" ? "your home folder" : folder}`;
}

/** A day's or a month's short name, said whole: Kitten said "on Tue." as "on two". */
const SHORT_NAME: Readonly<Record<string, string>> = {
  Mon: "Monday", Tue: "Tuesday", Tues: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Thur: "Thursday", Thurs: "Thursday",
  Fri: "Friday", Sat: "Saturday", Sun: "Sunday", Jan: "January", Feb: "February", Mar: "March", Apr: "April", Jun: "June",
  Jul: "July", Aug: "August", Sep: "September", Sept: "September", Oct: "October", Nov: "November", Dec: "December",
};
const SHORT_NAMES = new RegExp(`\\b(${Object.keys(SHORT_NAME).join("|")})\\.(?=\\s+[\\p{Ll}\\d])`, "gu");

/** A duration as written ("2h 15m", "1h30m"): Kitten read "2h" as "two h". */
const DURATION = /\b(\d+)h[ \t]?(\d+)m\b/g;
const duration = (_m: string, h: string, m: string) => `${h} ${h === "1" ? "hour" : "hours"} ${m} ${m === "1" ? "minute" : "minutes"}`;

/**
 * A range between two amounts or two clock times ("$5-$10", "10:30–11:00"), or two numbers with an en dash ("5–10"):
 * its dash is said "to" (it was "5 dollars-10 dollars"). "555-1234", "1-2" and "5-star" keep their hyphen, and so does a
 * spaced hyphen between two amounts, a sum ("$1,500 - $200 for fees" was said as a range: voice-speaking-c3-1).
 */
// (Not a run of numbers joined by en dashes, a phone number's or an ISBN's: "0800–123–456" was "0800 to 123 to 456".)
const RANGE = /([$£€¥]\d[\d,]*(?:\.\d{1,2})?)(?:-|[ \t]*–[ \t]*)(?=[$£€¥]\d)|((?<![\w:.])\d{1,2}:\d{2})[ \t]*[-–][ \t]*(?=\d{1,2}:\d{2}(?![\d:]))|(?<!\d[ \t]*–[ \t]*\d*)(\d)[ \t]*–[ \t]*(?=\d+(?!\d|[ \t]*–[ \t]*\d))/g;
/** A dash between two amounts that an equals sign follows is "minus" ("$2,000 - $1,500 = $500"). */
const MINUS = /([$£€¥]\d[\d,]*(?:\.\d{1,2})?)[ \t]*[-–−][ \t]*(?=[$£€¥]\d[\d,]*(?:\.\d{1,2})?[ \t]*=)/g;
/**
 * A spaced hyphen between two amounts of one currency that go up is a range too ("Expect to pay $50 - $100" was cut
 * there and heard as two prices: voice-speaking-c3-1); one that goes down is a sum, said as written ("$1,500 - $200"),
 * and so is a run of three ("Prices: $5 - $10 - $15").
 */
const SPACED_RANGE = /(?<!-[ \t]+)([$£€¥])(\d[\d,]*(?:\.\d{1,2})?)(?!\d)(?:[ \t]?(k|K|m|M|bn|B|thousand|million|billion|trillion)\b)?[ \t]+-[ \t]+(?=\1(\d[\d,]*(?:\.\d{1,2})?)(?!\d)(?:[ \t]?(k|K|m|M|bn|B|thousand|million|billion|trillion)\b)?(?![ \t]*[-–][ \t]*[$£€¥]?\d))/g;
/** A range with its currency only before the first amount, going up ("$5-10", "€20–30"): said with it twice. */
const RANGE_TO = /([$£€¥])(\d[\d,]*(?:\.\d{1,2})?)(?:-|[ \t]*–[ \t]*)(?=(\d[\d,]*(?:\.\d{1,2})?)(?!\d|[ \t]?(?:k|K|m|M|bn|B|thousand|million|billion|trillion)\b|[ \t]*[-–][ \t]*\d|%))/g;
/** Two times with am or pm after the second ("9am–5pm", "10-11 am", "2 - 3 p.m."): said with "to". */
const HOURS = /((?<![\w:.,$£€¥])\d{1,2}(?::[0-5]\d)?(?:[ \t]?[ap]\.?m\.?)?)[ \t]*[-–][ \t]*(?=\d{1,2}(?::[0-5]\d)?[ \t]?[ap]\.?m\b)/gi;
/** What an amount is worth, with its scale ("2.5M"), to tell a range from a sum. */
const SCALES: Readonly<Record<string, number>> = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, bn: 1e9, b: 1e9, billion: 1e9, trillion: 1e12 };
const worth = (n: string, scale?: string) => Number(n.replace(/,/g, "")) * (scale ? SCALES[scale.toLowerCase()] : 1);

/**
 * Markup that is only for the eye (voice-speaking-r7-3), outside inline code: a line break and the common inline HTML
 * tags, a footnote's mark and the commonest character entities were read out letter by letter ("less than sub greater
 * than"). Anything else in angle brackets is said as written ("<name>", "a < b").
 */
const EYE_ONLY = /(`+)(?!`)[^\n]*?(?<!`)\1(?!`)|<(br)\s*\/?>|<\/?(?:b|i|u|s|em|strong|sub|sup|kbd|span|mark|small|del|ins|p|div|font|center)(?:\s[^<>\n]*)?>|\[\^[^\]\s]{1,24}\]|&(amp|lt|gt|quot|apos|nbsp|#39);/gi;
const ENTITY: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", "#39": "'", nbsp: " " };
const withoutEyeOnly = (text: string): string =>
  text.replace(EYE_ONLY, (m: string, code: string | undefined, br: string | undefined, entity: string | undefined) => (code ? m : br ? " " : entity ? ENTITY[entity.toLowerCase()] : ""));
/** A task list's box: an open one is unsaid, a ticked one is "Done:" (it was read "x": voice-speaking-r7-3). */
const TASK_BOX = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[([ xX])\][ \t]+(?=\S)/gm;

/** What is written for the eye said for the ear (voice-speaking-2): money, clock times, paths, "~75%", "#45", "2h 15m". */
function sayable(text: string): string {
  return text
    .replace(MINUS, "$1 minus ")
    .replace(SPACED_RANGE, (m: string, _sign: string, low: string, lowScale: string | undefined, high: string, highScale: string | undefined) => (worth(low, lowScale) < worth(high, highScale) ? m.replace(/[ \t]+-[ \t]+$/, " to ") : m))
    .replace(RANGE_TO, (m: string, sign: string, low: string, high: string) => (worth(low) < worth(high) ? `${sign}${low} to ${sign}` : m))
    .replace(RANGE, (_m, amount: string | undefined, time: string | undefined, digit: string | undefined) => `${amount ?? time ?? digit} to `)
    .replace(HOURS, "$1 to ")
    .replace(PATH, pathSaid)
    .replace(AMOUNT, money)
    .replace(CLOCK, clock)
    .replace(DURATION, duration)
    .replace(SHORT_NAMES, (_m, name: string) => SHORT_NAME[name])
    .replace(/(?<![\w~])[~≈][ \t]?(?=\d)/g, "about ")
    .replace(/(?<![\w&#])#(\d+)\b/g, "number $1");
}

/**
 * A list's item (or a line an arrow starts, as a bullet: voice-speaking-r3-1) or a heading, as Markdown writes them; and
 * a line that is a rule between parts.
 */
const ITEM = /^[ \t]*(?:[-*+→]|\d{1,9}[.)])[ \t]+\S/;
/** An arrow starting a line, which ITEM takes for its bullet. */
const ARROW_BULLET = /^[ \t]*→/;
const HEADING = /^[ \t]{0,3}#{1,6}[ \t]+\S/;
const RULE = /^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/;
/** A line that ends as a sentence does already, or with a pause (a colon, a comma). */
const ENDED = /[.!?…:;,]["”’')\]*_]*$/;
/**
 * A line of a few words starting with a capital ("Firefox", "Your windows"): three or more in a row are a list written
 * without its markers. A line wrapped inside a paragraph goes on in lower case ("folder and found").
 */
const BARE_ITEM = (body: string) => body.length <= 40 && body.trim().split(/\s+/).length <= 4 && /^[ \t]*[\p{Lu}\p{N}]/u.test(body);
/**
 * A line that starts with a short label and its colon ("Step 1: Open Settings", "Option A: Keep it") or a spaced dash
 * ("Option A – keep both"): two or more in a row are a list's items, and the line before one ends, so a label is never
 * said at the end of the step before it (voice-speaking-c3-2, voice-speaking-r4-2).
 */
const LABEL = /^[ \t]*\p{Lu}[\p{L}\p{N} ]{0,24}(?::|[ \t]+[–—-])[ \t]+\S/u;

/**
 * What the lines said so far leave for the next one (spokenText's `leads`): whether the last of them ends with a colon
 * (or is a blank line after one), whether a colon line led into it, and whether it is blank.
 */
export interface Lead { ledIn: boolean; afterLed: boolean; afterBlank: boolean }

/** Whether a line of an answer, as Markdown writes it ("**Step 2:** Choose Privacy"), starts with a label (LABEL). */
export function labelLine(line: string): boolean {
  return LABEL.test(line.replace(/\*\*|__/g, ""));
}

/**
 * Each list item, heading, line leading into a list and paragraph ends with a full stop where it has no ending of its
 * own, so the voice pauses between them: "Firefox Files Terminal Mail" in one breath was heard as one name
 * (voice-speaking-3). A line wrapped inside a paragraph is left as it is, and so is what is only shown in the bubble.
 * `ledIn`: a line ending with a colon, said already, leads into the first line. `lineStart`: the start of the first
 * line, said already, so an arrow starting what is left of it is no bullet, and a label at its start still counts.
 * `afterLabel`: the line before the first, said already, starts with a label, so a label line first is the next of
 * their list. `afterLed`: the line before the first, said already, is one a colon line led into; `afterBlank`: it is a
 * blank line (`ledIn` then says the one before it ends with a colon). `leads` is told what the last whole line leaves
 * for the line after it, as those three (the same as given when there is none). `goesOn`: the last line goes on past
 * `text`, so how long it is isn't known yet. `lineEnd`: the rest of the last line, after `text` (Markdown).
 */
function endLines(text: string, ledIn = false, lineStart = "", afterLabel = false, afterLed = false, afterBlank = false, leads?: (lead: Lead) => void, goesOn = false, lineEnd = ""): string {
  const lines = text.split("\n");
  // The first line whole, its start said already (without Markdown's bold, as labelLine reads it).
  const whole = (i: number) => (i === 0 && lineStart ? lineStart.replace(/\*\*|__/g, "") + lines[0] : lines[i]);
  const item = lines.map((l, i) => ITEM.test(l) && !(i === 0 && lineStart && ARROW_BULLET.test(l)));
  // How many bare items run together through each line (voice-speaking-3: "Your windows\nFirefox\nFiles").
  // (Each line whole: the rest of one cut inside it, or the start of one said already, may make it longer than a list's;
  // as short, it may end a list: "Downloads\nDocuments\nPictures. Done." was "Downloads Documents Pictures.":
  // voice-speaking-w5-2.)
  const bare = lines.map((_l, i) => { const l = i === lines.length - 1 ? whole(i) + lineEnd.replace(/\*\*|__/g, "") : whole(i); return l.trim() && !item[i] && !HEADING.test(l) && !(goesOn && i === lines.length - 1) && BARE_ITEM(l.trimEnd()) ? 1 : 0; });
  const run: number[] = [...bare];
  for (let i = 1; i < run.length; i++) if (bare[i] && bare[i - 1]) run[i] = run[i - 1] + 1;
  for (let i = run.length - 2; i >= 0; i--) if (bare[i] && bare[i + 1]) run[i] = run[i + 1];
  // Lines of any length that a line ending with a colon leads into (perhaps after a blank line), each starting with a
  // capital: two or more are a list without its markers too ("Here is the plan:\nStep one is to open it\nStep two is…").
  // (A stream cut between such lines, before a label line or after a colon line, carries the run on: `afterLed`, `ledIn`.
  // Without it, "Here's the plan:\n…\nNote: …\nDelete…\nEmpty…" lost its run at "Note:": voice-speaking-v5-1.)
  const colon = (i: number) => (i < 0 ? ledIn : /:[ \t]*$/.test(whole(i)));
  // (Past a blank line: a second one, `afterBlank` before the first, ends the run.)
  const colonPast = (i: number) => (i < 0 ? ledIn && !afterBlank : colon(i));
  const led = lines.map(() => false);
  const ledBefore = (i: number) => (i < 0 ? afterLed : led[i]);
  for (let i = 0; i < lines.length; i++) {
    const l = whole(i);
    led[i] = !!l.trim() && !item[i] && !HEADING.test(l) && /^[ \t]*[\p{Lu}\p{N}]/u.test(l) && (ledBefore(i - 1) || colon(i - 1) || (i > 0 && !whole(i - 1).trim() && colonPast(i - 2)));
  }
  const last = lines.length - 2;
  const blank = last >= 0 && !whole(last).trim();
  leads?.(last < 0 ? { ledIn, afterLed, afterBlank } : { ledIn: blank ? colonPast(last - 1) : colon(last), afterLed: led[last], afterBlank: blank });
  const label = lines.map((l, i) => LABEL.test(i === 0 ? lineStart + l : l));
  return lines.map((line, i) => {
    const body = line.trimEnd(), next = lines[i + 1];
    if (!body.trim() || RULE.test(body) || ENDED.test(body) || body.endsWith(CODE) || body.endsWith(TABLE)) return line;
    const listed = (led[i] && (ledBefore(i - 1) || led[i + 1])) || (label[i] && ((i === 0 && afterLabel) || label[i - 1] || label[i + 1]));
    // Before a heading or a label too, as before a list's item: "Keep both copies Option B." was said in one breath.
    const alone = item[i] || HEADING.test(body) || run[i] >= 3 || listed || (next !== undefined && (!next.trim() || item[i + 1] || HEADING.test(next) || label[i + 1]));
    return alone ? `${body}.` : line;
  }).join("\n");
}

/**
 * What Ember says for `markdown`. `o.ledIn`: its first line follows a line ending with a colon that was said already, as
 * a streamed answer is cut just after "Here's what I'll do:" (voice-speaking-3). `o.lineStart`: the start of its first
 * line, said already, as a long first sentence is cut inside its line: an arrow starting the rest is no bullet ("
 * → Accessibility" is "to Accessibility": voice-speaking-v4-3), and a label at the line's start still makes it a
 * labelled step ("Step 1: Open Settings," said, then "then go to Privacy\nStep 2: …" ends the step before "Step 2":
 * voice-speaking-v4-4). `o.afterLabel`: the line before its first, said already, starts with a label ("Step 1: …"
 * said, then "Step 2: Turn off Location" ends as the step it is: voice-speaking-c4-1). `o.afterLed`: that line is one a
 * colon line led into (`o.afterBlank`: it is blank); `o.leads` is told what its own last whole line leaves for the next
 * piece (Lead); `o.goesOn`: its last line goes on after it, by more than has come; `o.lineEnd`: what has come of the
 * rest of that line. So a run of such lines cut apart ends each of them as the whole answer does (voice-speaking-v5-1,
 * voice-speaking-v5-2, voice-speaking-w5-2).
 */
export function spokenText(markdown: string, o: { ledIn?: boolean; lineStart?: string; afterLabel?: boolean; afterLed?: boolean; afterBlank?: boolean; leads?: (lead: Lead) => void; goesOn?: boolean; lineEnd?: string } = {}): string {
  const prose = markdown
    // Fenced code (an unclosed fence runs to the end, as a streamed answer can).
    .replace(FENCED_CODE, `$1${CODE}`)
    // Tables: a header row and its |---| line, and the rows after it.
    .replace(/(^|\n)[ \t]*\|.*\|[ \t]*\n[ \t]*\|?[ \t]*:?-{3,}[\s\S]*?(?=\n[ \t]*(?!\|)|$)/g, `$1${TABLE}`);
  const plain = withoutEyeOnly(linkLabels(prose))
    .replace(TASK_BOX, (_m, lead: string, box: string) => (box === " " ? lead : `${lead}Done: `))
    // A heart between words is a word ("I ❤️ Paris"): dropped with the other emoji, it was "I Paris".
    .replace(/([\p{L}\p{N}])[ \t]*[\u2764\u2665]\uFE0F?[ \t]*(?=[\p{L}\p{N}])/gu, "$1 love ")
    .replace(EMOJI_BETWEEN, "$1. ")
    // Before a word, a space stays where there was one, or goes between two words the emoji joined ("Saved✅Next").
    .replace(EMOJI_ANY, (m: string, at: number, all: string) => (at > 0 && /[\p{L}\p{N}]/u.test(all[at + m.length] ?? "") && (/^[ \t]/.test(m) || /[\p{L}\p{N}]/u.test(all[at - 1])) ? " " : ""))
    .replace(EMOTICON, "")
    // An item that was only emoji is no item.
    .replace(/^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]*$/gm, "")
    .replace(/<?\b(?:https?:\/\/|www\.)([^\s/<>()]+?)(?:[/?#][^\s<>()]*?)?>?(?=[.,;:!?)]*(?:\s|$))/gi, (_m, host: string) => host.replace(/^www\./i, ""))
    // An address written without its scheme is said by its host too ("github.com/foo/bar": voice-speaking-2).
    .replace(/(?<![\w@./~-])((?:[a-z0-9-]+\.)+(?:com|org|net|io|dev|app|ai|co|edu|gov|uk|de|fr))\/[^\s<>()]*?(?=[.,;:!?)]*(?:\s|$))/gi, "$1")
    // A line that is all bold is a heading ("**Done**"): it ends as one does (voice-speaking-3).
    .replace(/^([ \t]*)\*\*(?=[^\s*])([^*\n]*[^\s*])\*\*[ \t]*$/gm, (_m, space: string, body: string) => `${space}${body}${ENDED.test(body) ? "" : "."}`)
    .replace(/(?<![\\`])(`+)(?!`)([^\n]*?)(?<!`)\1(?!`)/g, "$2")
    // Emphasis as CommonMark sees it: no space just inside a marker ("6 * 7 * 1" and "*.tmp and *.log" are said with their
    // stars), and underscores only around whole words ("__init__.py" keeps them).
    .replace(/\*\*(?=[^\s*])([^*\n]*[^\s*])\*\*/g, "$1")
    .replace(/(^|[\s(])__(?=[^\s_])([^_\n]*[^\s_])__(?=[.,!?;:)]*(?:\s|$))/g, "$1$2")
    .replace(/(^|[\s(])([*_])(?=[^\s*_])([^*_\n]*[^\s*_])\2(?=[\s.,!?;:)]|$)/g, "$1$3")
    .replace(/~~([^~]+)~~/g, "$1")
    // A marker left alone at a word's edge, where a streamed piece was cut inside the bold or italic words it opens or
    // closes ("I have **finished … folder" | "and the archive** so…": voice-speaking-c2-1); never "6 * 7", "*.tmp",
    // "2**8", "_config.yml" or "__init__.py".
    .replace(/(^|[\s(])(?:\*\*?|_(?=\p{L}+(?:[\s,;:!?)]|$)))(?=\p{L})/gu, "$1")
    .replace(/(?<=[\p{L}\p{N}.,!?;:])(?:\*\*?|_)(?=[\s.,!?;:)]|$)/gu, "");
  const said = endLines(plain, o.ledIn, o.lineStart, o.afterLabel, o.afterLed, o.afterBlank, o.leads, o.goesOn, o.lineEnd)
    .replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, "")
    .replace(/^[ \t]*>[ \t]?/gm, "")
    .replace(/^[ \t]*[-*+→][ \t]+/gm, (m: string, at: number) => (at === 0 && o.lineStart && ARROW_BULLET.test(m) ? m : ""))
    .replace(/^[ \t]*(-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "")
    // Key chords as said ("Ctrl+Shift+T" is "Control Shift T", not "C T R L plus…"), and a path through menus or
    // settings ("Settings › Voice") as "Settings, then Voice"; an arrow as "to", an ampersand between words as "and".
    // (An arrow key too: "Win+←" is "Windows key left arrow", never "Win plus left arrow": voice-speaking-c4-3.)
    .replace(CHORD, chord => chord.split(/\s*\+\s*/).map(k => KEY_SAID[k.toLowerCase()] ?? ARROW[k] ?? k).join(" "))
    .replace(/\s*›\s*(?=\S)/g, ", then ")
    // Arrows as arrowSaid says them (voice-speaking-2), one after its own direction once ("up ↑" was "up up arrow"),
    // but not a "→" before another word ("from right → left" is "right to left", "top right → Settings" "top right to
    // Settings": voice-speaking-v4-2).
    .replace(/\b(up|down|left|right|back|forward)[ \t]*([←→↑↓])(?![←→↑↓])/gi, (m: string, word: string, a: string, at: number, all: string) => (!SAME_WAY[a].includes(word.toLowerCase()) || (a === "→" && !ONCE_BEFORE.test(all.slice(at + m.length, at + m.length + 24))) ? m : word))
    .replace(ARROWS, arrowSaid)
    // (Only a lone "&" between words: not "&&", "1 & 2" or one inside an address.)
    .replace(/(\p{L})\s+&\s+(?=\p{L})/gu, "$1 and ");
  return sayable(said).replace(/\n{2,}/g, "\n").trim();
}

/** Scripts said in one language each, as the system's voices name it: kana before Han, so Japanese isn't Chinese. */
const SCRIPTS: readonly [RegExp, string][] = [
  [/[\p{Script=Hiragana}\p{Script=Katakana}]/u, "ja"], [/\p{Script=Hangul}/u, "ko"], [/\p{Script=Han}/u, "zh"],
  [/\p{Script=Cyrillic}/u, "ru"], [/\p{Script=Greek}/u, "el"], [/\p{Script=Arabic}/u, "ar"], [/\p{Script=Hebrew}/u, "he"],
  [/\p{Script=Devanagari}/u, "hi"], [/\p{Script=Thai}/u, "th"],
];
/**
 * The commonest short words of the languages people most often write to Ember in besides English, leaving out those
 * English writes too ("as", "no", "he", "per", "come", "do", "um", "er", "bin", "hat", "son", "com" of an address, "d"
 * of "I'd", "o" of "o'clock"); and English's own, to weigh.
 */
const STOPWORDS: Readonly<Record<string, ReadonlySet<string>>> = {
  en: new Set("the a an and is are was were to of in on at by or from as do no he she it i you we they my your that this with for not have has what can will if so but all just there here".split(" ")),
  fr: new Set("le la les des du une est et je j vous nous pas que qui pour dans sur avec ce cette il elle sont ai mais ou au aux l c qu de un en ne se y moi lui leur sa ses ces ça cela à vos votre mon ma mes".split(" ")),
  de: new Set("der die das und ist nicht ich sie wir ein eine mit zu dem auf für von sich auch wie oder aber habe es sind des im nur noch dir mich mir kann wird du hast den bei aus".split(" ")),
  es: new Set("el la los las del que y en un una es por para con se está como pero muy yo de lo al eso esto hay su sus mi te le".split(" ")),
  it: new Set("il di che e è un una non sono con del della gli le mi ho anche nel ma lo si questo più alla alle nella sul dei delle la ho hai ti ci vuoi tua tuo al".split(" ")),
  pt: new Set("os que e é uma para não da em na por se eu você de dos das ao às mas isso seu sua ele ela foi um já são tem está nas quer".split(" ")),
  nl: new Set("de het een en niet ik je van dat op te met zijn voor maar ook wat om naar uit bij nog aan heb kan".split(" ")),
};

/**
 * Letters and marks one of these languages writes and the others seldom do. Only to tell two languages apart whose
 * short words a reply has as many of: Spanish and French share "la", "de", "un", "en", "se", "que" and "le", and a
 * Spanish reply went to a French voice (voice-speaking-c7-1).
 */
const OWN_LETTERS: Readonly<Record<string, RegExp>> = {
  es: /[ñáíóú¿¡]/giu, fr: /[àâçèêëîïôûùœ]/giu, de: /[äöß]/giu, it: /[ìò]/giu, pt: /[ãõ]/giu,
};
/** A short word two languages write that is far commoner in one: Spanish's "and", French's "there" ("il y a"). */
const LEANS: Readonly<Record<string, ReadonlySet<string>>> = { es: new Set(["y"]) };

/** Short lower-case words that join the parts of a name ("La Vie en Rose", "Hotel de la Paix", "Ludwig van Beethoven"). */
const NAME_JOINS = new Set("de del della di da do dos das du des la le les el en y van von der den of the".split(" "));

/**
 * The words of `text`, lower-cased, less those of names: two or more capitalised words in a row, perhaps joined by
 * NAME_JOINS ("Los Angeles", "La Vie en Rose", "Por Una Cabeza"). An English sentence naming a film, a song or a place
 * isn't in that place's language (voice-speaking-r1).
 */
function wordsBesidesNames(text: string): string[] {
  const kept: string[] = [];
  const capital = (t: string) => /^(?:[dl][’'])?\p{Lu}/u.test(t);
  for (const clause of text.split(/[.,;:!?¡¿()[\]{}"“”«»„—–\n]+/u)) {
    const tokens = clause.split(/\s+/u).filter(t => /\p{L}/u.test(t));
    for (let i = 0; i < tokens.length;) {
      let capitals = 0, end = i;
      if (capital(tokens[i])) {
        for (let j = i; j < tokens.length; j++) {
          if (capital(tokens[j])) { capitals++; end = j + 1; } else if (!NAME_JOINS.has(tokens[j].toLowerCase())) break;
        }
      }
      if (capitals >= 2) { i = end; continue; }
      kept.push(tokens[i++]);
    }
  }
  return kept.join(" ").toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
}

/**
 * The language a reply is in when it clearly isn't English, or null (English, or too little to tell): Kitten reads only
 * English, so a Chinese reply was 7 s of "Chinese letter" and a French one was gibberish (voice-speaking-11). Mostly
 * one script names its language; Latin text, less its names (wordsBesidesNames) and what it quotes, needs two different
 * short words of a language, a quarter of its words, and more than English has. Where two languages have as many, it
 * is `prefer` (the request's language) if that is one of them, else the one whose own letters it writes (OWN_LETTERS),
 * whose way a shared word leans (LEANS), or with more short words only it has (voice-speaking-c7-1). Pure and local: nothing is sent anywhere to
 * tell.
 */
export function speechLanguage(text: string, prefer: string | null = null): string | null {
  return languageOf(text, 2, prefer);
}

/**
 * speechLanguage, needing `minDifferent` different short words of a Latin-script language. What `text` quotes isn't
 * counted, unless it is all quotes: an English answer saying how to say something in French ("It's « je ne sais
 * pas ».") is English (voice-speaking-r2-1).
 */
function languageOf(quoting: string, minDifferent: number, prefer: string | null = null): string | null {
  const text = outsideQuotes(quoting);
  const letters = text.match(/\p{L}/gu) ?? [];
  if (!letters.length) return null;
  for (const [script, lang] of SCRIPTS) {
    const n = letters.filter(c => script.test(c)).length;
    // Japanese mixes kana with Han: any kana among them is Japanese.
    if (lang === "ja" ? n && letters.filter(c => /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(c)).length * 2 > letters.length : n * 2 > letters.length) return lang;
  }
  const words = wordsBesidesNames(text);
  const english = stopwords(words, "en").length;
  let best: string | null = null, most = 0, different = 0, tie = [0, 0, 0, 0];
  const others = Object.keys(STOPWORDS).filter(lang => lang !== "en");
  for (const lang of others) {
    const found = stopwords(words, lang);
    if (found.length < most || !found.length) continue;
    // As many as the best so far: the request's language, then its own letters, a word that leans its way, then the
    // words only it has.
    const rank = [
      lang === prefer ? 1 : 0, (text.match(OWN_LETTERS[lang] ?? /(?!)/gu) ?? []).length, found.filter(w => LEANS[lang]?.has(w)).length,
      found.filter(w => others.every(o => o === lang || !STOPWORDS[o].has(w))).length,
    ];
    const differs = rank.findIndex((r, i) => r !== tie[i]);
    const better = found.length > most || (differs >= 0 && rank[differs] > tie[differs]);
    if (better) { best = lang; most = found.length; different = new Set(found).size; tie = rank; }
  }
  return best && different >= minDifferent && most * 4 >= words.length && most > english ? best : null;
}

/** The words of `words` that are `lang`'s short words (none for a language written in its own script). */
const stopwords = (words: readonly string[], lang: string): string[] => words.filter(w => STOPWORDS[lang]?.has(w));

/** Words in quotes ("what does 'no sé' mean?"): quoting another language doesn't make a request or a reply that language. */
const QUOTED = /"[^"\n]*"|“[^”\n]*”|„[^“”\n]*[“”]|«[^»\n]*»|\u2018[^\u2019\n]*\u2019|(^|[\s(])'[^'\n]*'(?=[\s.,;:!?)]|$)/g;
/** `text` less what it quotes, or all of it when it is all quotes. */
function outsideQuotes(text: string): string {
  const unquoted = text.replace(QUOTED, "$1 ");
  return /\p{L}/u.test(unquoted) ? unquoted : text;
}

/**
 * The language a request was clearly typed in, or null: its words outside quotes need three different short words of
 * it, not two, and none that only English writes, since a request so often names a song, a film or a saying in lower
 * case ("play la vie en rose", "what does c'est la vie mean?") whose reply is English (voice-speaking-r2-1).
 */
export function requestLanguage(request: string): string | null {
  const lang = languageOf(request, 3);
  return lang && !wordsBesidesNames(request.replace(QUOTED, "$1 ")).some(w => ENGLISH_ONLY.has(w)) ? lang : null;
}

/** Short words that only English writes, of its commonest: not "a" or "on" (French), "is" or "we" (Dutch), "i" (Italian). */
const ENGLISH_ONLY = new Set("the and are were that this with for have has what you your they it not but can just there here my".split(" "));

/**
 * Whether `text` is clearly English: two or more different short English words, one of them only English's, and more
 * of them than any other language has. A loanword or a name with an accent ("your résumé", "a café") is then no reason
 * to wait (voice-speaking-r2-2), while "On a déjà ouvert le fichier." still is.
 */
function englishClearly(text: string): boolean {
  const words = wordsBesidesNames(text);
  const english = stopwords(words, "en");
  if (new Set(english).size < 2 || !english.some(w => ENGLISH_ONLY.has(w))) return false;
  return Object.keys(STOPWORDS).every(lang => lang === "en" || stopwords(words, lang).length < english.length);
}

/**
 * Whether `text`, a piece of an answer said in `lang`, is English and nothing else: clearly English, with none of
 * `lang`'s short words and no letter of another script (voice-speaking-x7-1).
 */
function englishOnly(text: string, lang: string): boolean {
  return englishClearly(text) && !stopwords(wordsBesidesNames(text), lang).length && !/[^\p{Script=Latin}\P{L}]/u.test(text);
}

/** An answer's language is decided from this many of its letters, or from all of a shorter one (voice-speaking-r1). */
export const DECIDE_LETTERS = 60;
/** Letters English seldom writes, outside names ("Café Nero", "São Paulo": voice-speaking-r2-2): "Bien sûr", "Natürlich". */
const ACCENTED = /[\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u024F]/u;
/** Marks English seldom writes: "¡Listo!", "« Oui »", and French's space before "!?:;". */
const FOREIGN_MARKS = /[¡¿«»]|\s[!?:;»](?=\s|$)/u;
/** A short piece that may be in another language, and isn't clearly English ("your résumé" is). */
const mayBeAnother = (text: string) => (FOREIGN_MARKS.test(text) || ACCENTED.test(wordsBesidesNames(text).join(" "))) && !englishClearly(text);

/**
 * The language each piece of a streamed answer is said in (null: English, in Ember's own voice), decided once for the
 * whole answer: piece by piece, an English list's "1. La La Land." went to a Spanish or French voice, or was dropped
 * (voice-speaking-r1), and a French reply's "Bien sûr !" was said by Kitten with English sounds (voice-speaking-11).
 * Until DECIDE_LETTERS letters have come, English-looking pieces are said at once; a piece that may be in another
 * language waits for more of the answer, as does every piece when the request was clearly typed in another language
 * (requestLanguage), unless its words outside quotes are clearly English ("Ça veut dire « I don't know what you have »"
 * isn't: voice-speaking-r3-2). A message that ends shorter is judged by itself, or by the request's
 * language when it can't be told and has fewer English words than that language's. A message before a tool call that
 * ends shorter decides nothing for the messages after it (voice-speaking-r2-1: "Sure, one moment." had fixed a whole
 * turn to the request's language). Once an answer that opened in English is in another language (it read a passage
 * out), a piece of it that is English outside what it quotes is still said in Ember's own voice (voice-speaking-c7-3);
 * an answer that opened in another language keeps that voice throughout (voice-speaking-x7-1).
 */
export class AnswerLanguage {
  private text = "";
  private held: string[] = [];
  private lang: string | null | undefined;
  /** The request's language, when it was clearly another (requestLanguage of what the user typed). */
  private asked: string | null = null;
  /** Whether the answer's first piece was clearly English (undefined: none has come). */
  private opened: boolean | undefined;

  /** A new answer, to `request` (the user's words). */
  reset(request = ""): void {
    this.text = "";
    this.held = [];
    this.lang = undefined;
    this.opened = undefined;
    this.asked = requestLanguage(request);
  }

  /**
   * The pieces to say now, each with its language: `pieces` just made, `end` when the message is complete, `more` when
   * more messages of this answer may follow it (it ended before a tool call).
   */
  take(pieces: readonly string[], end = false, more = false): { text: string; lang: string | null }[] {
    for (const p of pieces) if (p.trim()) { this.held.push(p); this.text += ` ${p}`; this.opened ??= englishClearly(p.replace(QUOTED, " ")); }
    let lang = this.lang;
    if (lang === undefined) {
      if (!this.text.trim()) return [];
      const found = speechLanguage(this.text, this.asked);
      if ((this.text.match(/\p{L}/gu) ?? []).length >= DECIDE_LETTERS) lang = this.lang = found;
      else if (end) {
        lang = found ?? this.followsRequest();
        if (!more) this.lang = lang;
      } else if (found || (this.asked && !englishClearly(outsideQuotes(this.text))) || mayBeAnother(this.text)) return [];
    }
    // An answer in another language's voice because of a passage it read out says its own clearly English pieces (its
    // closing "Shall I reply to it?") in Ember's voice: said by the passage's voice, or unsaid with none installed,
    // the question went unheard while Ember waited for its answer (voice-speaking-c7-3). What a piece quotes isn't
    // counted, so a French reply's "« I don't know »" stays with it. Only in an answer that opened in English: a
    // French, Russian or Chinese answer's own sentence naming an English title, button or error ("Il s'appelle Gone
    // with the Wind.") went to Kitten, which reads only English (voice-speaking-x7-1).
    const own = lang && this.opened ? lang : null;
    const out = this.held.map(text => ({ text, lang: own && englishOnly(text.replace(QUOTED, " "), own) ? null : lang ?? null }));
    this.held = [];
    // A message before a tool call opens nothing for the messages after it.
    if (end && more) this.opened = undefined;
    return out;
  }

  /**
   * The request's language for a reply too short to tell, unless the reply has as many English words as words of that
   * language ("It means that's life." to "what does c'est la vie mean?" is English): Kitten can say a name, and an
   * English reply left unsaid, or read by another language's voice, is worse than "Claro." said by Kitten. What the
   * reply quotes isn't counted: "Ça veut dire « I don't know »." is French, and "It's « je ne sais pas »." English
   * (voice-speaking-r3-2). A reply that quotes something follows the request only where its own words have more of that
   * language's short words than English's: "Literally, \"I don't know\".", "In English: \"thank you\"." and "Gracias
   * means \"thank you\"." have neither, and are English (voice-speaking-v4-1).
   */
  private followsRequest(): string | null {
    if (!this.asked) return null;
    const own = outsideQuotes(this.text);
    const words = wordsBesidesNames(own);
    const english = stopwords(words, "en").length, asked = stopwords(words, this.asked).length;
    // With as many of each (none, often: "Abrí "Ventas.xlsx"."), a letter or a mark of another language outside the
    // quotes follows the request ("Voilà « Ventes.xlsx ».": voice-speaking-c4-2); English's own words stay Kitten's.
    if (own !== this.text) return asked > english || (asked === english && mayBeAnother(own)) ? this.asked : null;
    return english && english >= asked ? null : this.asked;
  }
}

/**
 * Does the answer end by asking something ("…Should I close that one too?")? Its follow-up window then takes
 * "Okay." or "Fine." as the reply it is, not as the end of the conversation. What is only shown (code, a table)
 * after the question doesn't count.
 */
export function endsWithQuestion(answer: string): boolean {
  let said = spokenText(answer);
  for (let shown = [CODE, TABLE].find(p => said.endsWith(p)); shown; shown = [CODE, TABLE].find(p => said.endsWith(p))) said = said.slice(0, -shown.length).trimEnd();
  return /\?[\s"'”’)\]*_]*$/.test(said);
}

/**
 * How an announced command (D4.4) says to cancel it (owner decision V1): with the kill phrase only where Ember can tell
 * its own voice from the user's (speaker rejection runs), or hearing itself say it would pull the kill switch and stop
 * everything (review #251); elsewhere with the stop shortcut as said aloud, when Ember holds it; else the Stop button.
 */
export function cancelWords(o: { killPhrase: boolean; stopKey: string | null }): string {
  if (o.killPhrase) return "Say 'Ember, stop' to cancel.";
  return o.stopKey ? `Press ${o.stopKey} to cancel.` : "Press Stop to cancel.";
}

/** "Ember, stop" in any of its forms, with its quotes (and a full stop inside them, which is kept). */
const KILL_PHRASE = /["“‘']?\b(?:(?:hey|hi|ok|okay)[\s,]+)?embers?[\s,.!…-]*(?:please[\s,]+)?stop\b(?:([.!]?)["”’'])?/gi;
/** "Hey Ember" (or "OK Ember"), with its quotes: the greeting and the name together. */
const WAKE_PHRASE = /["“‘']?\b(?:hey|hi|ok|okay|k|hay|pay|pey)[\s,]*(?:ember|emmer)\b(?!['’]?s\b)(?:([,.!]?)["”’'])?/gi;
/**
 * The greeting ending one sentence and the name starting the next ("Okay. Ember can't open that."): the recognizer
 * writes it as engine.ts's CUT_IN_WAKE takes for a cut-in, so a word goes between them ("Okay. So Ember can't…"), and
 * none is dropped. voice-spoken.test.ts checks on a corpus that CUT_IN_WAKE never matches what Ember says.
 */
const WAKE_APART = /\b(hey|hi|ok|okay|k|hay|pay|pey)([\s,]*[.!][\s,.!]*)(ember|emmer)\b(?!['’]?s\b)/gi;

/**
 * What Ember says, without the stop and wake phrases, where it can't tell its own voice from the user's: its
 * microphone would hear it say them, and "Ember, stop" (or "Hey Ember, stop", "Hey Ember, cancel") stops everything
 * (review #251). They are named instead ("the stop phrase"); the bubble still shows them.
 */
export function withoutOwnPhrases(text: string): string {
  return text
    .replace(KILL_PHRASE, (_m, p?: string) => `the stop phrase${p ?? ""}`)
    .replace(WAKE_PHRASE, (_m, p?: string) => `the wake phrase${p ?? ""}`)
    .replace(WAKE_APART, (_m, greeting: string, between: string, name: string) => `${greeting}${between}So ${name}`);
}
