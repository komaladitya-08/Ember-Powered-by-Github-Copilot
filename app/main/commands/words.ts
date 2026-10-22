/**
 * Words of a command after quote removal and expansion (design §3.4.4), shared by the three tokenizers and the
 * classifier: the resolved argument type, a conservative option parser, how a program word becomes the name its
 * table row is looked up by (case and extensions per target), and the word normalisation the intent matcher uses on
 * the user's own words (§2.3 rule 1). Pure.
 */

import type { OS } from "../../shared/shortcuts";
import type { ShellFamily } from "./types";

/** One argument as the classifier sees it. */
export interface Arg {
  /** The value after quote removal and expansion; null when an expansion Ember couldn't resolve stands in it. */
  v: string | null;
  /** The word as written. */
  raw: string;
  /** Unquoted wildcard characters stand in it (kept as a pattern). */
  glob: boolean;
  /** For a glob: the pattern, with quoted wildcard characters escaped by a backslash (POSIX) or as written. */
  pattern?: string;
  /** A command or process substitution in it fetched something from the network (§3.4.7). */
  fetch?: boolean;
  /** PowerShell: this token is a parameter name (`-Path`, without its dash); its value, if attached (`-Path:x`), is v. */
  param?: string;
}

/** A literal argument (tests, wrappers that build words). */
export const lit = (s: string): Arg => ({ v: s, raw: s, glob: false });

/** Whether an argument looks like an option (`-x`, `--xy`); a lone `-` is an operand (stdin). */
export const isOption = (a: Arg): boolean => a.v !== null && a.v.length > 1 && a.v.startsWith("-") && !a.param;

/** What a program's options are, for the conservative parser. */
export interface OptSpec {
  /** Short options that take a value (`"fC"`: `-f FILE`, `-C DIR`, also `-fFILE`). */
  shortValue?: string;
  /** Long options that take a value, without `--` (`--file FILE` or `--file=FILE`). */
  longValue?: readonly string[];
  /** Long options that may take a value only when attached (`--color=auto`). */
  longOptional?: readonly string[];
  /** Stop at the first operand (the rest belongs to a command it runs: sudo, env, xargs, ssh). */
  stopAtOperand?: boolean;
  /** Single-dash long options (`-name`, `-exec`: find, Java-style tools) are not split into letters. */
  singleDashLong?: boolean;
}

/** An option parsed out of a command line. */
export interface Opt {
  /** "-r" for a short option, "--recursive" for a long one (as written, possibly abbreviated). */
  name: string;
  /** Its value, when it takes one (null: unresolved). */
  value?: string | null;
  /** The index of the argument it came from. */
  at: number;
}

/** A parsed command line. */
export interface Parsed {
  opts: Opt[];
  operands: Arg[];
  /** For stopAtOperand: the index of the first operand (args.length when none). */
  restAt: number;
  /** An option value that is missing (the line ends after a value-taking option). */
  missingValue: boolean;
}

/**
 * Parses options GNU-style (clusters, attached values, `--` ends options, options after operands unless
 * stopAtOperand). Unknown options count as flags. An unresolved argument (null) is an operand.
 */
export function parseOpts(args: readonly Arg[], spec: OptSpec = {}): Parsed {
  const opts: Opt[] = [];
  const operands: Arg[] = [];
  let restAt = args.length;
  let missingValue = false;
  const shortValue = spec.shortValue ?? "";
  const longValue = new Set(spec.longValue ?? []);
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const v = a.v;
    if (v === "--") {
      for (let j = k + 1; j < args.length; j++) operands.push(args[j]);
      if (spec.stopAtOperand) restAt = k + 1;
      break;
    }
    if (v === null || !v.startsWith("-") || v === "-") {
      if (spec.stopAtOperand) {
        restAt = k;
        for (let j = k; j < args.length; j++) operands.push(args[j]);
        break;
      }
      operands.push(a);
      continue;
    }
    if (v.startsWith("--") || spec.singleDashLong) {
      const body = v.replace(/^--?/, "");
      const eq = body.indexOf("=");
      const name = `--${eq >= 0 ? body.slice(0, eq) : body}`;
      if (eq >= 0) opts.push({ name, value: body.slice(eq + 1), at: k });
      else if (longValue.has(name.slice(2))) {
        if (k + 1 < args.length) { opts.push({ name, value: args[k + 1].v, at: k }); k++; } else { opts.push({ name, value: null, at: k }); missingValue = true; }
      } else opts.push({ name, at: k });
      continue;
    }
    // A short cluster: -rf, -fFILE, -C dir.
    for (let j = 1; j < v.length; j++) {
      const c = v[j];
      if (shortValue.includes(c)) {
        const attached = v.slice(j + 1);
        if (attached) opts.push({ name: `-${c}`, value: attached, at: k });
        else if (k + 1 < args.length) { opts.push({ name: `-${c}`, value: args[k + 1].v, at: k }); k++; } else { opts.push({ name: `-${c}`, value: null, at: k }); missingValue = true; }
        break;
      }
      opts.push({ name: `-${c}`, at: k });
    }
  }
  return { opts, operands, restAt, missingValue };
}

/** Whether a parsed line has a short option (`"r"`) or a long one (`"recursive"`, also when abbreviated to 3+ letters). */
export function has(p: Parsed, ...names: string[]): boolean {
  return p.opts.some(o => names.some(n => optIs(o.name, n)));
}

/** The values given for an option (short or long names). */
export function values(p: Parsed, ...names: string[]): (string | null)[] {
  return p.opts.filter(o => o.value !== undefined && names.some(n => optIs(o.name, n))).map(o => o.value ?? null);
}

/** Whether an option as written is `n` (a single letter: short; else long, abbreviations of 3+ letters included). */
export function optIs(written: string, n: string): boolean {
  if (n.length === 1) return written === `-${n}`;
  if (!written.startsWith("--") && !written.startsWith("-")) return false;
  const w = written.replace(/^--?/, "");
  if (w === n) return true;
  return written.startsWith("--") && w.length >= 3 && n.startsWith(w);
}

// ---------------------------------------------------------------------------------------------------------------
// Program names.

/** Where a program word is judged. */
export interface LookupEnv {
  os: OS;
  family: ShellFamily;
  /** The target is a WSL distro (interop names are matched like Windows': critique wsl-3). */
  wsl: boolean;
  /** WSL's drive mounts. */
  mountRoot: string | null;
}

/** A program word's lookup facts. */
export interface ProgramName {
  /** As written, quotes removed ("/usr/bin/rm", "CMD.EXE"). */
  written: string;
  /** The basename as written ("rm", "CMD.EXE"). */
  base: string;
  /** The table key: lower-cased where lookup is case-insensitive, extension removed where it is ("cmd"). */
  key: string;
  /** The word names a path (`./x.sh`, `/usr/bin/rm`). */
  isPath: boolean;
  /** A Windows program reached through WSL interop (critique wsl-3, wsl-5). */
  interop: boolean;
  /** The extension removed for lookup (".exe", ".bat"…), lower case; "" for none. */
  ext: string;
}

const WIN_EXT = /\.(exe|com|bat|cmd)$/i;

/** The lookup facts of a program word (§3.4.4: case and extensions per target). */
export function programName(word: string, env: LookupEnv): ProgramName {
  const winPath = env.os === "win32" || env.family !== "posix";
  const isPath = winPath ? /[\\/]/.test(word) : word.includes("/");
  const base = isPath ? word.split(winPath ? /[\\/]/ : /\//).pop() ?? word : word;
  const underMount = env.wsl && env.mountRoot !== null && word.startsWith(`${env.mountRoot}/`);
  const interop = env.wsl && env.family === "posix" && (WIN_EXT.test(base) || underMount);
  const ci = env.os === "win32" || env.os === "darwin" || env.family !== "posix" || interop;
  const extMatch = WIN_EXT.exec(base);
  const stripExt = extMatch !== null && (env.os === "win32" || env.family !== "posix" || interop);
  const ext = stripExt && extMatch ? extMatch[0].toLowerCase() : "";
  let key = stripExt ? base.slice(0, base.length - ext.length) : base;
  if (ci) key = key.toLowerCase();
  return { written: word, base, key, isPath, interop, ext };
}

/** Whether a word has letters outside ASCII, or letters from more than one script (a homoglyph program name). */
export function nonAsciiLetters(word: string): boolean {
  return /[^\x20-\x7e]/.test(word) && /\p{L}/u.test(word.replace(/[\x20-\x7e]/g, ""));
}

// ---------------------------------------------------------------------------------------------------------------
// The user's own words (§2.3 rule 1, §3.7).

const NUMBER_WORDS: Readonly<Record<string, string>> = {
  zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", ten: "10",
  eleven: "11", twelve: "12", thirteen: "13", fourteen: "14", fifteen: "15", sixteen: "16", seventeen: "17",
  eighteen: "18", nineteen: "19", twenty: "20",
};

/** A name normalised as §2.3 rule 1: NFKC, lower case, number words as digits, only letters and digits kept. */
export function normName(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .split(/(\s+)/)
    .map(w => NUMBER_WORDS[w] ?? w)
    .join("")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/** The user's words as tokens for matching: lower case, NFKC, split on whitespace with edge punctuation trimmed. */
export function userTokens(words: string): string[] {
  return words
    .normalize("NFKC")
    .toLowerCase()
    .split(/\s+/)
    .map(t => t.replace(/^[("'`“‘[{<]+|[)"'`”’\]}>.,;:!?]+$/g, ""))
    .filter(t => t !== "");
}

/** The user's words as plain words (letters and digits), for verbs and phrases. */
export function userWordList(words: string): string[] {
  return words
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map(w => NUMBER_WORDS[w] ?? w)
    .filter(w => w !== "");
}

/** The forms of a verb that count (§3.7: the word or its -ing/-ed/-s form). */
export function verbForms(v: string): string[] {
  const forms = new Set([v, `${v}s`, `${v}es`, `${v}ed`, `${v}ing`, `${v}d`]);
  if (v.endsWith("e")) { forms.add(`${v.slice(0, -1)}ing`); forms.add(`${v.slice(0, -1)}ed`); }
  if (/[^aeiou][aeiou][bdgklmnprt]$/.test(v)) { forms.add(`${v}${v.slice(-1)}ed`); forms.add(`${v}${v.slice(-1)}ing`); }
  if (v.endsWith("y")) { forms.add(`${v.slice(0, -1)}ied`); forms.add(`${v.slice(0, -1)}ies`); }
  return [...forms];
}

/** Whether the user's words hold one of these verbs (multi-word verbs as consecutive words). */
export function hasVerb(wordList: readonly string[], verbs: readonly string[]): boolean {
  for (const v of verbs) {
    const parts = v.split(" ");
    if (parts.length === 1) {
      const forms = verbForms(v);
      if (wordList.some(w => forms.includes(w))) return true;
      continue;
    }
    const first = verbForms(parts[0]);
    for (let k = 0; k + parts.length <= wordList.length; k++) {
      if (first.includes(wordList[k]) && parts.slice(1).every((p, j) => wordList[k + 1 + j] === p)) return true;
    }
  }
  return false;
}

/** Whether the user's words hold one of these words or phrases exactly (no verb forms). */
export function hasWord(wordList: readonly string[], words: readonly string[]): boolean {
  return words.some(w => {
    const parts = w.split(" ");
    for (let k = 0; k + parts.length <= wordList.length; k++) if (parts.every((p, j) => wordList[k + j] === p)) return true;
    return false;
  });
}

/**
 * Whether a name (a branch, a remote, a package, a host) is named in the user's words (§2.3 rules 1-2): its
 * normalised form is a run of whole normalised words. Names shorter than 3 characters after normalising never match.
 */
export function nameNamed(name: string, words: string): boolean {
  const target = normName(name);
  if (target.length < 3) return false;
  const list = words.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u).map(w => NUMBER_WORDS[w] ?? w).filter(w => w !== "");
  for (let k = 0; k < list.length; k++) {
    let acc = "";
    for (let j = k; j < list.length && acc.length < target.length; j++) {
      acc += list[j];
      if (acc === target) return true;
    }
  }
  return false;
}

/** "a", "a and b", "a, b and c"; more than `max` items end "and N more". */
export function joinList(items: readonly string[], max = 5): string {
  const list = items.length > max ? [...items.slice(0, max), `${items.length - max} more`] : [...items];
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}
