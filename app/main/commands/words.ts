/**
 * Words of a command after quote removal and expansion (design §3.4.4), shared by the three tokenizers and the
 * classifier: the resolved argument type, a conservative option parser, how a program word becomes the name its
 * table row is looked up by (case and extensions per target), and the word normalisation the intent matcher uses on
 * the user's own words (§2.3 rule 1). Pure.
 */

import type { ClassifyContext, ShellFamily } from "./types";

/** The target's OS (the contract's own type, so this file imports nothing outside the commands package). */
type OS = ClassifyContext["os"];

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
  /**
   * A POSIX word with v null: its text as written pieces and the variables in it (`{ name }`; null for an expansion
   * that isn't a plain variable), so Ember's own refusal can be judged against values the text gives those variables.
   * `cut`: a cut or a default (`${d%x}`, `${d:-x}`) that may be other text than the values; `value`: the value the
   * scope knows (HOME, PWD) in place of the text's (commands-remote-w5-1, w5-3); `alt`: a default's text, resolved
   * (`${XDG_CONFIG_HOME:-$HOME/.config}`: commands-remote-v4-4).
   */
  parts?: readonly (string | { name: string | null; cut?: true; value?: string; alt?: string })[];
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
  /**
   * Long options that may take a value only when attached (`--color=auto`, GNU's `--backup[=CONTROL]`): written alone
   * they take none and the next word is an operand, so they never belong in longValue (commands-remote-c4-3).
   */
  longOptional?: readonly string[];
  /**
   * Short options whose value is only ever attached (`-l5`, `-i{}`, `-S<key>`): written alone they take none and the
   * next word is the command or an operand (commands-remote-c4-1).
   */
  shortOptional?: string;
  /**
   * Short options that take the next word as their value only when it is a number, a processor count's substitution,
   * an arithmetic expansion or a variable (make's `-j 4`, `-j $(nproc)` and `-j $JOBS`, as make took them before round
   * six, but `-j install`); attached, only a count (countWord) is their value (commands-a7-1).
   */
  shortNumeric?: string;
  /** Long options that take the next word as shortNumeric's do (make's `--jobs 4`). */
  longNumeric?: readonly string[];
  /** Stop at the first operand (the rest belongs to a command it runs: sudo, env, xargs, ssh). */
  stopAtOperand?: boolean;
  /**
   * The job-count options (`j`, `jobs`, `P`, `max-procs`) permitted to take an attached count (countWord). Other options
   * retain the baseline's uncertainty, including file names and load averages (commands-a7-1, commands-v7-3).
   */
  jobCounts?: readonly string[];
  /** Single-dash long options (`-name`, `-exec`: find, Java-style tools) are not split into letters. */
  singleDashLong?: boolean;
}

/** An option parsed out of a command line. */
export interface Opt {
  /** "-r" for a short option, "--recursive" for a long one (as written, possibly abbreviated). */
  name: string;
  /** Its value, when it takes one (null: unresolved). */
  value?: string | null;
  /** An unresolved value attached to it (`--arg-file="$d/x"`): its pieces, as Arg.parts (commands-remote-w5-6). */
  parts?: Arg["parts"];
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

/** A command that prints the number of processors (`nproc`, `getconf _NPROCESSORS_ONLN`, `sysctl -n hw.ncpu`). */
const CPU_COUNT = String.raw`\s*(nproc(\s+--(all|ignore=\d+))*|getconf\s+_?NPROCESSORS_ONLN|sysctl\s+-n\s+hw\.(ncpu|logicalcpu|physicalcpu|activecpu))\s*`;
/**
 * A word that is only a processor count's substitution, an arithmetic expansion or a variable, quoted or not: the word
 * make's `-j` takes apart, as it did before round six; any other substitution may print a target (`make -j
 * "$(printf deploy)"`), and the row judges whatever is not a count (commands-remote-w5-2, commands-a7-1).
 */
const COUNT_WORD = new RegExp(String.raw`^"?(\$\(${CPU_COUNT}\)|\$\(\([^()]*\)\)|` + "`" + CPU_COUNT + "`" + String.raw`|\$\{?[A-Za-z_][A-Za-z0-9_]*\}?)"?$`);
const BASELINE_CPU_COUNT_WORD = new RegExp(String.raw`^"?(\$\(${CPU_COUNT}\)|` + "`" + CPU_COUNT + "`" + String.raw`)"?$`);
/** The exact processor substitutions permitted for new job-count recognition (commands-v7-3). */
const CPU_COUNT_WORD = /^"?\$\((nproc|getconf _NPROCESSORS_ONLN|sysctl -n hw\.ncpu)\)"?$/;

/**
 * Whether a job count as written is only a count (commands-a7-1, commands-v7-3): a number, one of the three exact
 * processor substitutions or arithmetic of numbers, quoted or not. baselineApart preserves processor forms only for
 * options that already consumed the separate word on the baseline. Never follow a variable to loosen a judgement.
 */
export function countWord(raw: string, baselineApart = false): boolean {
  const v = raw.replace(/^"([^"]*)"$/, "$1");
  return /^\d+(\.\d+)?$/.test(v) || CPU_COUNT_WORD.test(v) || /^\$\(\([\d\s+\-*/%]*\)\)$/.test(v)
    || (baselineApart && BASELINE_CPU_COUNT_WORD.test(v));
}

/** The text of an option's value attached to it as written (`-P"$N"` → `"$N"`, `--jobs=$X` → `$X`). */
function attachedRaw(raw: string, name: string): string {
  return name.startsWith("--") ? raw.slice(raw.indexOf("=") + 1) : raw.slice(raw.indexOf(name[1], 1) + 1);
}

/**
 * The option a word Ember can't see stands for when a count is attached to it (`-j$(nproc)`, `-j"$((2*4))"`,
 * `--parallel=$(nproc)`, `--max-workers=$(nproc)`): only a named jobCounts option takes a count (countWord). Its value
 * is unseen, its pieces kept (commands-remote-r5-3, commands-v7-3). A variable there is no count, so the word is an
 * operand, as it was on main (commands-a7-1).
 */
function attachedCount(a: Arg, spec: OptSpec): Omit<Opt, "at">[] | null {
  const long = /^--([A-Za-z][A-Za-z0-9-]*)=(.+)$/s.exec(a.raw);
  const parts = (a.parts ?? []).slice();
  const cut = (n: number): Arg["parts"] => {
    const first = typeof parts[0] === "string" ? parts[0].slice(n) : "";
    return [...(first ? [first] : []), ...parts.slice(typeof parts[0] === "string" ? 1 : 0)];
  };
  if (long) {
    if (!(spec.jobCounts ?? []).includes(long[1]) || !countWord(long[2])) return null;
    return [{ name: `--${long[1]}`, value: null, parts: cut(long[1].length + 3) }];
  }
  const short = /^-([A-Za-z0-9]+)(.+)$/s.exec(a.raw);
  if (!short || a.raw.startsWith("--")) return null;
  const out: Omit<Opt, "at">[] = [];
  for (let j = 0; j < short[1].length; j++) {
    const c = short[1][j];
    const numeric = (spec.shortNumeric ?? "").includes(c);
    if (numeric || (spec.shortValue ?? "").includes(c)) {
      // The count must be all that follows the letter.
      const rest = short[1].slice(j + 1) + short[2];
      return (spec.jobCounts ?? []).includes(c) && countWord(rest) ? [...out, { name: `-${c}`, value: null, parts: cut(j + 2) }] : null;
    }
    if ((spec.shortOptional ?? "").includes(c)) return null;
    out.push({ name: `-${c}` });
  }
  return null;
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
  const shortOptional = spec.shortOptional ?? "";
  const shortNumeric = spec.shortNumeric ?? "";
  const longValue = new Set(spec.longValue ?? []);
  const longNumeric = new Set(spec.longNumeric ?? []);
  // A word Ember can't see that is only a processor count's substitution or a variable (`$(nproc)`, `` `nproc` ``,
  // `"$JOBS"`) is the usual job count, as a number is; a literal word (`install`) is still a target (commands-remote-v5-4).
  const numberNext = (k: number): boolean => k + 1 < args.length && (/^\d+(\.\d+)?$/.test(args[k + 1].v ?? "") || (args[k + 1].v === null && COUNT_WORD.test(args[k + 1].raw)));
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    const v = a.v;
    if (v === "--") {
      for (let j = k + 1; j < args.length; j++) operands.push(args[j]);
      if (spec.stopAtOperand) restAt = k + 1;
      break;
    }
    // Before a command, a word Ember can't see all of that starts as an option with its value attached
    // (`--arg-file="$d/x"`, `-a"$d/x"`) is that option, its value unseen, so the command after it is still found and
    // the value judged by its pieces (commands-remote-w5-6).
    const attached = v === null && spec.stopAtOperand && !a.param ? attachedOption(a, spec) : null;
    if (attached) {
      opts.push(...attached.map(o => ({ ...o, at: k })));
      // Unless the value is only a job count (`-P$(nproc)`, `-P"$((2*4))"`), it is text Ember can't see, which the shell
      // may split into more words, the first of them the command (`X='1 rm'; xargs -n$X echo` runs rm): what runs is a
      // command Ember can't name, as on main, quoted or not, and the value is still judged by its pieces for Ember's own
      // refusal (commands-z6-4, commands-a7-1).
      const last = attached[attached.length - 1].name;
      if (!((spec.jobCounts ?? []).includes(last.replace(/^--?/, "")) && countWord(attachedRaw(a.raw, last)))) {
        restAt = k;
        for (let j = k; j < args.length; j++) operands.push(args[j]);
        break;
      }
      continue;
    }
    const counted = v === null && !a.param ? attachedCount(a, spec) : null;
    if (counted) { opts.push(...counted.map(o => ({ ...o, at: k }))); continue; }
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
      } else if (longNumeric.has(name.slice(2)) && numberNext(k)) { opts.push({ name, value: args[k + 1].v, at: k }); k++; } else opts.push({ name, at: k });
      continue;
    }
    // A short cluster: -rf, -fFILE, -C dir.
    for (let j = 1; j < v.length; j++) {
      const c = v[j];
      // GNU's optional values (`-l[N]`): the rest of the word, never the next one.
      if (shortOptional.includes(c) || shortNumeric.includes(c)) {
        const attached = v.slice(j + 1);
        if (attached) opts.push({ name: `-${c}`, value: attached, at: k });
        else if (shortNumeric.includes(c) && numberNext(k)) { opts.push({ name: `-${c}`, value: args[k + 1].v, at: k }); k++; } else opts.push({ name: `-${c}`, at: k });
        break;
      }
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

/**
 * The options a word Ember can't see all of stands for when its written start is an option whose value is attached
 * (`--arg-file="$d/x"`, `-a"$d/x"`, `-0a"$d"`), the value's pieces kept; null when it isn't one (`-$x`, `--$x`, `-r$x`).
 */
function attachedOption(a: Arg, spec: OptSpec): Omit<Opt, "at">[] | null {
  const parts = a.parts ?? [];
  let n = 0;
  let lead = "";
  for (; n < parts.length && typeof parts[n] === "string"; n++) lead += parts[n] as string;
  const rest = parts.slice(n);
  if (rest.length === 0) return null;
  const long = /^--([A-Za-z][A-Za-z0-9-]*)=/.exec(lead);
  if (long) return [{ name: `--${long[1]}`, value: null, parts: [lead.slice(long[0].length), ...rest] }];
  if (!/^-[A-Za-z0-9]/.test(lead) || lead.startsWith("--")) return null;
  const takes = `${spec.shortValue ?? ""}${spec.shortOptional ?? ""}${spec.shortNumeric ?? ""}`;
  const out: Omit<Opt, "at">[] = [];
  for (let j = 1; j < lead.length; j++) {
    const c = lead[j];
    if (takes.includes(c)) return [...out, { name: `-${c}`, value: null, parts: [lead.slice(j + 1), ...rest] }];
    out.push({ name: `-${c}` });
  }
  return null;
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

/**
 * A path as the card says it (commands-remote-v1): "." and "./" are the current folder and ".." the folder above it,
 * since "Deletes what it finds under .." reads as the folder above. Any other path is said as written.
 */
export function shownPath(text: string): string {
  if (/^\.[\\/]*$/.test(text)) return "the current folder";
  if (/^\.\.[\\/]*$/.test(text)) return "the folder above the current one";
  return text;
}

/** "a", "a and b", "a, b and c"; more than `max` items end "and N more". */
export function joinList(items: readonly string[], max = 5): string {
  const list = items.length > max ? [...items.slice(0, max), `${items.length - max} more`] : [...items];
  if (list.length <= 1) return list[0] ?? "";
  return `${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}
