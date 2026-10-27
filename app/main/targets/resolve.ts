/**
 * Which computer the user's own words name (§2.3): pure and deterministic, run only on the user's typed or spoken words
 * (never the model's text, screen text, a file or command output). A target is named by its label, alias, hostname or
 * distro name (or the registry's short names for them) after one normalisation (NFKC, lower case, spoken numbers zero
 * to twenty as digits, nothing but letters and digits), as a run of whole words, the longest name said winning, and
 * only after a place word ("on build-01", "in Ubuntu"), as the request's first words before ":" or ",", or before
 * "'s desktop" and the like. So "Send build-01's report to Ana" names nothing, and a model that lost track can't move
 * a task by repeating a name the user never used as a place.
 */

import type { OS } from "../../shared/shortcuts";
import type { TargetId } from "../../shared/targets";

/** A target's names: its label, its alias, its hostname (SSH), its distro name (WSL); "local" has fixed words. */
export interface NamedTarget { id: TargetId; names: string[] }

/** One word of a request: its normalised text and where it sits in the folded text (for what follows it). */
interface Word { text: string; start: number; end: number }

/** "zero" to "twenty" as spoken numbers ("build zero one" names build-01). */
const NUMBER_WORDS: Readonly<Record<string, string>> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17", eighteen: "18",
  nineteen: "19", twenty: "20",
};

/** Words that make what follows them a place (rule 3). */
const PLACE = new Set(["on", "in", "at", "inside", "over", "via", "into", "onto"]);
/** Words that may sit between a place word and the name ("on the build box", "in my Ubuntu"). */
const DETERMINER = new Set(["the", "my", "our"]);
/** What may follow "<name>'s" for the name to be a place ("build-01's desktop"). */
const POSSESSIVE = /^['’]s\s+(?:desktop|screen|machine|server|computer|box|shell|terminal)(?![\p{L}\p{N}])/u;
/** A name shorter than this, normalised, is never matched (too easy to say by accident). */
export const MIN_NAME = 3;

/** NFKC and lower case: the form every rule reads (positions refer to it). */
function fold(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

/** The words of `folded` (letters and digits), spoken numbers as digits. */
function wordsOf(folded: string): Word[] {
  const out: Word[] = [];
  for (const m of folded.matchAll(/[\p{L}\p{N}]+/gu)) {
    const raw = m[0];
    out.push({ text: NUMBER_WORDS[raw] ?? raw, start: m.index, end: m.index + raw.length });
  }
  return out;
}

/** A name or phrase as one run of letters and digits ("Build Zero One" and "build-01" both become "build01"). */
export function normaliseName(s: string): string {
  return wordsOf(fold(String(s ?? ""))).map(w => w.text).join("");
}

/**
 * Every run of whole words whose letters and digits spell `name` exactly: [first word, last word] pairs. Names shorter
 * than `min` never match (MIN_NAME for binding; the wrong-target guard, which only makes a command ask, takes any).
 */
function runsOf(words: readonly Word[], name: string, min = MIN_NAME): [number, number][] {
  const out: [number, number][] = [];
  if (name.length < Math.max(1, min)) return out;
  for (let i = 0; i < words.length; i++) {
    if (!name.startsWith(words[i].text)) continue;
    let acc = "";
    for (let j = i; j < words.length; j++) {
      acc += words[j].text;
      if (acc === name) { out.push([i, j]); break; }
      if (acc.length >= name.length || !name.startsWith(acc)) break;
    }
  }
  return out;
}

/** A run of the request's words that spells one of a target's names: [first word, last word]. */
interface Run { id: TargetId; i: number; j: number }

/**
 * Every run of `ws` that spells a name of one of `targets` ("local" aside), except a run inside a longer run of another
 * target's name (the longest wins): "on build-01-test" names build-01-test, not also build-01, and "in Ubuntu 24.04"
 * names Ubuntu-24.04, not also another distro that answers to "Ubuntu" (a short name; reviews #179, #180).
 */
function runsNaming(ws: readonly Word[], targets: readonly NamedTarget[]): Run[] {
  const runs: Run[] = [];
  for (const t of targets) {
    if (t.id === "local") continue;
    for (const n of t.names) for (const [i, j] of runsOf(ws, normaliseName(n))) runs.push({ id: t.id, i, j });
  }
  return runs.filter(r => !runs.some(o => o.id !== r.id && o.i <= r.i && r.j <= o.j && o.j - o.i > r.j - r.i));
}

/** Rule 3: the run [i, j] stands where a place is named. */
function isPlace(folded: string, words: readonly Word[], i: number, j: number): boolean {
  const before = words[i - 1]?.text;
  if (before !== undefined && PLACE.has(before)) return true;
  if (before !== undefined && DETERMINER.has(before) && PLACE.has(words[i - 2]?.text ?? "")) return true;
  const after = folded.slice(words[j].end);
  if (i === 0 && /^\s*[:,]/.test(after)) return true;
  return POSSESSIVE.test(after);
}

/**
 * The phrases that always mean this computer (rule 4), as normalised word sequences. A bare "here" is not one ("check
 * what's taking space here" with build-01 picked means build-01, the folder or the window the user is in): it would
 * move a task off the picker's computer, and a requested delete would be announced and run on the wrong one (review).
 */
function localPhrases(os: OS): string[][] {
  const out = [
    ...["computer", "pc", "mac", "laptop", "machine"].map(w => ["this", w]),
    ...["computer", "pc", "mac", "laptop"].map(w => ["my", w]),
    ["locally"],
  ];
  if (os === "win32") out.push(["on", "windows"]);
  if (os === "darwin") out.push(["on", "my", "mac"]);
  return out;
}

/** Where the first fixed phrase for this computer starts in `words`, or -1. */
function localAt(words: readonly Word[], os: OS): number {
  const phrases = localPhrases(os);
  for (let i = 0; i < words.length; i++) {
    if (phrases.some(p => p.every((w, k) => words[i + k]?.text === w))) return i;
  }
  return -1;
}

/**
 * The targets the user's own words name for this request (deduplicated, in order of appearance). `os` is this PC's
 * (rule 4's "on windows" and "on my mac"); "local" is named by its fixed words only, whatever names it is given.
 */
export function targetsNamed(words: string, targets: readonly NamedTarget[], os: OS = "linux"): TargetId[] {
  const folded = fold(String(words ?? ""));
  const ws = wordsOf(folded);
  const found: { id: TargetId; at: number }[] = [];
  if (targets.some(t => t.id === "local")) {
    const at = localAt(ws, os);
    if (at >= 0) found.push({ id: "local", at });
  }
  for (const r of runsNaming(ws, targets)) if (isPlace(folded, ws, r.i, r.j)) found.push({ id: r.id, at: r.i });
  found.sort((a, b) => a.at - b.at);
  return [...new Set(found.map(f => f.id))];
}

/** Whether the user's words name `t` anywhere, without rule 3 (the model's `choice` must be found this way, §2.3). */
export function namedAnywhere(words: string, t: NamedTarget, os: OS = "linux"): boolean {
  const folded = fold(String(words ?? ""));
  const ws = wordsOf(folded);
  if (t.id === "local") return localAt(ws, os) >= 0;
  return t.names.some(n => runsOf(ws, normaliseName(n)).length > 0);
}

/**
 * The known targets other than `bound` that the user's words name anywhere, by any of their names and without rule 3
 * ("build-01 delete build/" names build-01 though it binds to the active computer); this computer by its fixed words
 * (a bare "here" is none: "delete it here" is where the task already is). D4.4's wrong-target guard (DOC's review):
 * a dangerous command in a task whose words also name another computer always asks, never announces. Names shorter
 * than MIN_NAME count too: binding ignores them, so "delete build/ on pi" binds to the active computer, and only
 * this guard stops it announcing there (a name said by accident only makes a command ask).
 */
export function otherTargetsNamed(words: string, targets: readonly NamedTarget[], bound: TargetId, os: OS = "linux"): TargetId[] {
  const folded = fold(String(words ?? ""));
  const ws = wordsOf(folded);
  const out: TargetId[] = [];
  for (const t of targets) {
    if (t.id === bound || out.includes(t.id)) continue;
    const named = t.id === "local" ? localAt(ws, os) >= 0 : t.names.some(n => runsOf(ws, normaliseName(n), 1).length > 0);
    if (named) out.push(t.id);
  }
  return out;
}

/**
 * The place words before a computer-looking name that make it a place the user named (the lead's ruling on it): rule 3's
 * own (on, in, at, inside, over, via, into, onto), and "from" and "ssh" ("delete the logs from prod-db", "ssh prod-db and
 * clean build/"), which name a computer as plainly.
 */
const HOST_PLACE = new Set([...PLACE, "from", "ssh"]);
/** Words that may sit between a place word (and its determiner) and the name: "on the server prod-db", "ssh to prod-db". */
const HOST_NOUN = new Set(["server", "host", "machine", "box", "computer", "pc", "vm", "node", "instance", "container", "to"]);
/** Punctuation around a word that isn't part of it ("on prod-db.", "(on prod-db)", "on 'prod-db'", "on `prod-db`"). */
const AROUND = /^[("'‘“[«‹<{`*]+|[)"'’”\]».,;:!?›>}`*]+$/gu;
/** Dashes of every kind, read as the hyphen a host name has ("prod‐db" with U+2010 is prod-db). */
const DASHES = /\p{Pd}/gu;
/** A host name or ssh alias: letters, digits, dots, hyphens and underscores, starting and ending with a letter or digit. */
const HOST_LIKE = /^[a-z0-9](?:[a-z0-9._-]{0,251}[a-z0-9])?$/i;
/** An ssh-style destination: user@host, maybe with a folder after a colon ("deploy@prod-db:/srv"). */
const USER_AT_HOST = /^[a-z0-9._-]{1,64}@([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)(?::[a-z0-9._/~-]*)?$/i;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)$/;
/**
 * Numbers, amounts, dates and ranges ("5", "2024", "1.5", "5pm", "3rd", "64gb", "10s", "2026-10-22", "10-20"), and
 * versions ("v2", "v1.2.3"): never computers.
 */
const AMOUNT = /^(?:\d+(?:[.,:/-]\d+)*[a-z]{0,3}|v\d+(?:\.\d+)*)$/i;
/** A host with a port or a folder after it ("prod-db:22", "10.0.0.5:2222", "prod-db:/srv/app"): the host is the name. */
const HOST_PORT = /^([^:@/]+):(?:\d{1,5}|[/~][\w./~-]*)$/;
/** File name endings: "in main.ts", "into notes.md" name a file, not a computer. */
const FILE_EXT = new Set([
  "c", "cc", "cfg", "cjs", "conf", "cpp", "cs", "css", "csv", "db", "deb", "doc", "docx", "env", "exe", "gif", "go", "gz", "h", "hpp", "htm",
  "html", "ini", "ipynb", "java", "jpeg", "jpg", "js", "json", "jsx", "kt", "lock", "log", "lua", "md", "mjs", "mp3", "mp4", "msi", "pdf",
  "php", "png", "ppt", "pptx", "ps1", "py", "rb", "rpm", "rs", "scss", "sh", "sql", "svg", "swift", "tar", "tgz", "toml", "ts", "tsx", "txt",
  "vue", "wav", "xls", "xlsx", "xml", "xz", "yaml", "yml", "zip",
]);
/** Everyday hyphenated words a request may put after a place word ("in the top-right corner", "in read-only mode"). */
const COMMON_HYPHENATED = /^(?:(?:top|bottom|upper|lower|far|middle)-(?:left|right|hand|most|middle|centre|center)|(?:left|right)-(?:hand|most|side|click)|(?:full|split|half)-screen|(?:read|write)-only|real-time|built-in|drop-down|pop-?ups?|e-mail|double-click)$/i;

/**
 * Whether a word after a place word looks like a computer (the lead's ruling): a name with a dot, a hyphen or a digit
 * ("prod-db", "web.example.com", "build01", "10.0.0.5") or an ssh-style user@host, and not a file name, a number or
 * amount, a version or an everyday hyphenated word. Returns the computer's name (the host of user@host), or null.
 */
function hostOfPlace(word: string): string | null {
  const at = USER_AT_HOST.exec(word);
  if (at) return at[1];
  const port = HOST_PORT.exec(word);
  if (port) return hostOfPlace(port[1]);
  if (!HOST_LIKE.test(word) || !/[.\-\d]/.test(word)) return null;
  if (IPV4.test(word)) return word;
  if (AMOUNT.test(word) || COMMON_HYPHENATED.test(word)) return null;
  const dot = word.lastIndexOf(".");
  if (dot > 0 && FILE_EXT.has(word.slice(dot + 1).toLowerCase())) return null;
  return word;
}

/**
 * The places the user's own words name that look like a computer but that none of `targets` is (the lead's ruling on
 * the wrong-target risk): "delete build/ on prod-db" names prod-db, which isn't a computer Ember knows or a host of the
 * user's ssh config, so the task binds to the active computer, and D4.4 must never announce there. A place is a place
 * word (HOST_PLACE; "the", "my" or "our" may follow it, then a word such as "server" or "host") and then a word with a
 * dot, a hyphen or a digit, or an ssh-style user@host, maybe with a port or a folder after a colon; or such a word as
 * the request's first, followed by ":" or "," ("prod-db: delete build/", rule 3). File names ("in main.ts"), numbers,
 * amounts and dates ("in 5 minutes", "at 5pm"), versions and everyday words ("on the desktop", "in my home folder", "on
 * line 12") are not. A name any of `targets` answers to (the bound one's included) is left out: otherTargetsNamed
 * speaks for the others. As the user wrote them, deduplicated, at most five, each at most 64 characters (only letters,
 * digits and `.-_@:/~` reach the card).
 */
export function placesNamed(words: string, targets: readonly NamedTarget[]): string[] {
  const known = new Set(targets.flatMap(t => t.names.map(normaliseName)).filter(n => n !== ""));
  const raw = String(words ?? "").normalize("NFKC").replace(DASHES, "-").split(/\s+/u).filter(t => t !== "");
  const tokens = raw.map(t => t.replace(AROUND, "")).filter(t => t !== "");
  const out: string[] = [];
  const consider = (token: string) => {
    // "on prod-db's desktop": the name without its possessive.
    const word = token.replace(/['’]s$/u, "");
    const host = hostOfPlace(word);
    if (host === null || word.length > 64) return;
    const n = normaliseName(host);
    if (n === "" || known.has(n) || out.some(o => o.toLowerCase() === word.toLowerCase())) return;
    out.push(word);
  };
  // Rule 3's other form: the request's first word, then ":" or "," ("prod-db: delete build/").
  if (raw.length > 1 && /[:,]$/.test(raw[0])) consider(raw[0].replace(AROUND, ""));
  for (let i = 0; i < tokens.length - 1 && out.length < 5; i++) {
    if (!HOST_PLACE.has(tokens[i].toLowerCase())) continue;
    let k = i + 1;
    if (DETERMINER.has(tokens[k].toLowerCase()) && k + 1 < tokens.length) k++;
    if (HOST_NOUN.has(tokens[k].toLowerCase()) && k + 1 < tokens.length) k++;
    consider(tokens[k]);
  }
  return out.slice(0, 5);
}

/** The target a name given by the model stands for (exactly one of its names, or this computer's fixed words), or null. */
export function targetOfChoice(choice: string, targets: readonly NamedTarget[], os: OS = "linux"): TargetId | null {
  const c = normaliseName(choice);
  if (!c) return null;
  const local = new Set([...localPhrases(os).map(p => p.join("")), "local", "thiscomputer", "thispc"]);
  if (local.has(c) && targets.some(t => t.id === "local")) return "local";
  for (const t of targets) if (t.id !== "local" && t.names.some(n => normaliseName(n) === c)) return t.id;
  return null;
}

/** What the model hears when it names a computer the user didn't (§2.3). */
export const NOT_NAMED = "The user didn't name that computer. Use the one they chose, or ask them.";
/** Two computers in one request (§2.3). */
export const TWO_NAMED = "Ember works on one computer per task. Ask the user which one.";

/**
 * Binding a task (§2.3): one target the user's words name wins (the model's `choice` is ignored); two are refused;
 * none: the model's `choice` only when the user's words name it too (anywhere) or it is the picker's own choice, else
 * the picker's choice (`active`).
 */
export function bindTarget(o: { userWords: string; choice?: string; targets: readonly NamedTarget[]; active: TargetId; os: OS }):
  { ok: true; id: TargetId } | { ok: false; why: string } {
  const named = targetsNamed(o.userWords, o.targets, o.os);
  if (named.length > 1) return { ok: false, why: TWO_NAMED };
  if (named.length === 1) return { ok: true, id: named[0] };
  const choice = typeof o.choice === "string" ? o.choice.trim() : "";
  if (!choice) return { ok: true, id: o.active };
  // A short name two computers share ("Ubuntu" for Ubuntu-22.04 and Ubuntu-24.04) picks neither: ask (review #180).
  const c = normaliseName(choice);
  if (o.targets.filter(t => t.id !== "local" && t.names.some(n => normaliseName(n) === c)).length > 1) return { ok: false, why: TWO_NAMED };
  const id = targetOfChoice(choice, o.targets, o.os);
  if (id === null) {
    // A computer the user did name, but Ember has no record of: the model may offer a connection, never make one.
    const said = normaliseName(choice).length >= MIN_NAME && runsOf(wordsOf(fold(o.userWords)), normaliseName(choice)).length > 0;
    return { ok: false, why: said ? "Ember isn't set up to work on that computer yet. If the user wants Ember there, offer to connect it (offer_connect)." : NOT_NAMED };
  }
  if (id === o.active) return { ok: true, id };
  const t = o.targets.find(x => x.id === id);
  // Named anywhere, and not only as the start of another computer's name ("build-01" in "build-01-test's report").
  const said = id === "local" ? !!t && namedAnywhere(o.userWords, t, o.os) : runsNaming(wordsOf(fold(String(o.userWords ?? ""))), o.targets).some(r => r.id === id);
  return said ? { ok: true, id } : { ok: false, why: NOT_NAMED };
}

/** The words that name WSL itself on a Windows PC (rule 5), as names subject to rule 3: "in WSL", "on the Linux side". */
export const WSL_WORDS: readonly string[] = ["WSL", "Linux", "Linux side"];
