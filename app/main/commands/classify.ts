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
import { SHELL_FAMILY } from "./types";
import { lexPosix, type PList, type PSimple, type PWord, type PRedir, type Unclear } from "./lex-posix";
import { lexPowerShell, restrictedExpression, type PsArg, type PsCommand, type PsRedir, type PsSeg, type PsStatement } from "./lex-powershell";
import { lexCmd, type CSimple, type CWord } from "./lex-cmd";
import {
  type Arg, type OptSpec, type Parsed, has, isOption, joinList, lit, nonAsciiLetters, optIs, parseOpts, programName, values,
} from "./words";
import {
  type PathEnv, type PathUse, WRITES, baseName, flavourOf, globPrefix, globReaches, globRegExp, globWriteKind, holdsEmberPath,
  holdsSecret, inWorkTree, isAbsolute, isEmberPath, isUnder, homeDotFile, opaqueWindowsPath, pathEnv, physicalForm,
  resolveTargetPath, secretCandidates, secretKind, SECRET_SAMPLE_NAMES, SHORT_NAME, toMount, windowsContextOf, writeKind, wslUncPath,
} from "./paths";
import {
  CLIPBOARD_READERS, CLOUD_CLIS, CLOUD_DELETE, CLOUD_READ, CLOUD_READ_PHRASES, DECODERS, DISK_TOOLS, FETCHERS, GIT_CODE_KEYS, GLOBAL_OPTIONS,
  GUI_PROGRAMS, INPUT_SYNTH, INTERACTIVE, INTERPRETERS, LANGUAGE_INSTALL_VERBS, LAUNCHERS, NAME_DESTROY, NAME_PUBLISH, NAME_SYSTEM,
  OTHER_SHELLS, POSIX_SHELLS, PS_ALIASES, PS_CMDLETS, PS_COMMON, PS_COMMON_ALIASES, RISKY_ASSIGNMENTS, RISKY_ASSIGNMENT_PREFIX,
  SCREENSHOTTERS, SECRET_PROGRAMS, SECRET_VAR, SUDO_LIKE, SYSTEM_PACKAGERS, WRAPPERS, type GlobalGrammar, type PsCmdletSpec,
  type PsParamKind,
} from "./tables";
import { commandLineSecret } from "./redact";
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
  scriptStream: "It runs a script from a stream, which Ember can't read first.",
  downloadsProgram: "Downloads a program and runs it.",
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
  refuseSafety: "Ember won't run this: it would change Ember's own safety settings, records or programs.",
  refuseRead: "Ember won't run this: it would read Ember's own safety settings, records or programs.",
  refuseInput: "Ember won't run this: it could press keys or click in Ember's own windows.",
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
  /** An earlier command in its pipeline fetches from the network or decodes hidden text. */
  fetchBefore: boolean;
  background: boolean;
  pipedFrom?: number;
  /** PowerShell: the parsed command (for cmdlet parameters). */
  ps?: PsCommand;
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

/** A pipeline's running state: did an earlier element fetch or decode, and what did the last one run. */
interface PipeState { fetch: boolean; program: string }

/** The classifier's state for one command text. */
class Classifier {
  findings: Finding[] = [];
  commands: ParsedCommand[] = [];
  probe: string[] = [];
  refuse: { rule: string; says: string } | null = null;
  /** Whether the refusal is only for reading Ember's own files (a later change or input refusal says more). */
  private refusedRead = false;
  downloads: string[] = [];
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

  constructor(readonly ctx: ClassifyContext, readonly topShell: ShellId) {}

  // ----------------------------------------------------------------------------------------------------------------
  // Findings.

  add(cls: DangerClass, rule: string, says: string, o: { objects?: Obj[]; widening?: string[]; ifExists?: string; program?: string } = {}): void {
    const program = o.program ?? this.program;
    // "If it exists" is asked of the file the kernel opens: `> sub/../x` overwrites the x beside sub's target.
    const ifExists = o.ifExists === undefined ? undefined : (o.objects ?? []).find(ob => ob.abs === o.ifExists && ob.phys !== undefined)?.phys ?? o.ifExists;
    if (this.findings.some(f => f.rule === rule && f.says === says && f.at === this.at && f.ifExists === ifExists)) return;
    const objects: CommandObject[] = (o.objects ?? []).map(ob => {
      const out: CommandObject = { kind: ob.kind, text: ob.text };
      if (ob.resolved !== undefined) out.resolved = ob.resolved;
      return out;
    });
    const widening = [...(o.widening ?? [])];
    if (this.globalOpts.has(this.at) && !widening.includes("global-option")) widening.push("global-option");
    if ((o.objects ?? []).some(ob => ob.realDiffers) && !widening.includes("real-path")) widening.push("real-path");
    const f: Finding = { cls, rule, says, program, objects, widening, at: this.at };
    if (ifExists !== undefined) f.ifExists = ifExists;
    this.findings.push(f);
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
   * press keys in Ember's windows ("input"). The first one stands, except that a refusal for reading gives way to one
   * for anything more.
   */
  refuseWith(rule: string, kind: "safety" | "read" | "input"): void {
    if (this.refuse && !(this.refusedRead && kind !== "read")) return;
    this.refuse = { rule, says: kind === "safety" ? SAYS.refuseSafety : kind === "read" ? SAYS.refuseRead : SAYS.refuseInput };
    this.refusedRead = kind === "read";
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
    if (text === null) return { kind: "other", text: a.raw, abs: null };
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
   * ruling). Only a resolvable path on the target's own filesystem, not one this task downloaded (already escape),
   * not a foreign scope's (another system Ember can't read). A pattern, a stream (`/dev/fd/3`, `/proc/self/fd/0`) or
   * more scripts than Ember reads (MAX_SCRIPTS) asks: what would run can't be read first.
   */
  recordScript(a: Arg, as: ScriptRef["as"], sc: Scope, candidate = false): void {
    if (a.v === null || a.v === "-" || a.v === "/dev/stdin" || sc.foreign) return;
    if (a.glob) { this.unclear("unclear.script-pattern", "It runs a script named by a pattern, which Ember can't read first."); return; }
    if (!isAbsolute(a.v, sc.path.flavour) && !a.v.startsWith("~") && !sc.cwd) return;
    if (this.isDownloaded(a, sc)) return;
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
    const ref: ScriptRef = { path: abs, as, cwd, ...(open !== null ? { open } : {}), ...(known !== undefined ? { real: known } : {}) };
    this.scripts.push(ref);
    if (candidate) this.candidates.set(ref, { written: this.written.length, unnamed: this.writesUnnamed });
  }

  /**
   * Whether a script this command runs is one it writes, moves or unpacks itself. Order doesn't matter for a script
   * named outright (a loop or a function may run it again after the write); a candidate counts only what was written
   * before it (`git pull` in cmd isn't the git.cmd it may resolve to).
   */
  protected scriptWritten(): boolean {
    return this.scripts.some(r => {
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

  /** Records a file this command downloads (§3.4.7), resolved against the scope's folder. */
  download(p: string | null, sc: Scope): void {
    if (!p || !sc.cwd) return;
    const abs = resolveTargetPath(p, { os: sc.os, home: sc.home ?? "", cwd: sc.cwd });
    // Where it really lands too (§3.6): through a link (`-o link/x`) or `..` after one (`-o sub/../x`), so running it
    // later by that name (`sh /data/x`) is running the download.
    const phys = this.physical(p, "write", sc);
    for (const n of [abs, this.ctx.real?.get(abs), phys === null ? undefined : this.ctx.real?.get(phys)]) {
      if (n !== undefined && !this.downloads.includes(n)) this.downloads.push(n);
    }
  }

  /** Whether a path is a file this task downloaded, or inside a downloaded folder. */
  isDownloaded(a: Arg, sc: Scope): boolean {
    if (a.v === null || !sc.cwd || (this.ctx.downloaded.size === 0 && this.downloads.length === 0)) return false;
    const abs = resolveTargetPath(a.v, { os: sc.os, home: sc.home ?? "", cwd: sc.cwd });
    const all = [...this.ctx.downloaded, ...this.downloads];
    // Its real path too (§3.6): a link to a download, or `..` walked through a link (`sh sub/../x`), is the download.
    const phys = this.physical(a.v, "exec", sc);
    const names = [abs, this.ctx.real?.get(abs), phys === null ? undefined : this.ctx.real?.get(phys)].filter((n): n is string => typeof n === "string");
    // Downloaded by an earlier command of this task, or earlier in this same command (`curl -o x … && sh x`).
    if (all.some(d => names.some(n => isUnder(n, d, sc.path)))) return true;
    // A Windows path in cmd or PowerShell reached from a distro: the distro recorded it under the drive mount.
    if (sc.fromWsl && /^[A-Za-z]:[\\/]/.test(abs) && this.ctx.wsl) {
      const mount = this.ctx.wsl.mountRoot;
      const env = pathEnv({ flavour: "posix", os: "linux", home: null, cwd: null, mountRoot: mount });
      const m = toMount(abs, mount);
      return all.some(d => isUnder(m, d, env));
    }
    return false;
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
    return new Engine(ctx, shell).run(text);
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

/** git verbs that change files in the work tree (a script there may not be what is on disk now). */
const GIT_TREE_WRITERS = new Set(["apply", "am", "checkout", "switch", "restore", "pull", "merge", "rebase", "cherry-pick", "revert", "stash", "reset", "clone", "worktree", "submodule", "read-tree", "checkout-index", "mv"]);
/** Other version control tools' verbs that change files. */
const VCS_TREE_WRITERS: Readonly<Record<string, ReadonlySet<string>>> = {
  svn: new Set(["update", "up", "checkout", "co", "export", "switch", "sw", "merge", "patch", "revert", "resolve"]),
  hg: new Set(["update", "up", "checkout", "co", "pull", "revert", "import", "unshelve", "merge", "rebase", "graft", "backout"]),
  p4: new Set(["sync", "unshelve", "revert", "integrate", "resolve", "copy", "merge", "undo", "clean", "reconcile"]),
};

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

/** Extra scope fields (kept off Scope so copies stay cheap). */
interface ScopeMore { pipedIn: { fetch: boolean } | null }
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
  /** The single top-level cd, for cdOnly. */
  topCd: { at: number; abs: string | null } | null = null;

  run(text: string): ClassificationExtra {
    const sc = this.topScope();
    if (text.length > MAX_COMMAND_CHARS) {
      this.unclear("unclear.too-long", "It is longer than Ember can check one by one.");
      this.fallbackScan(text, sc);
      return this.result();
    }
    this.checkCharacters(text, sc.family);
    this.classifyText(text, this.topShell, sc);
    return this.result();
  }

  private result(): ClassificationExtra {
    // A script this same command writes, moves or unpacks before it runs (`echo … > t.sh; sh t.sh`, `cp a.sh t.sh &&
    // ./t.sh`, `tar xf a.tar && sh t.sh`): what is on disk now isn't what will run (L8, the lead's ruling).
    if (this.scriptWritten()) {
      this.unclear("unclear.script-written", "It runs a script that this command writes first, so Ember can't read it beforehand.");
    }
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
  private psTextScan(text: string): void {
    if (SENDKEYS.test(text)) this.refuseWith("ember.input", "input");
    if (/(^|[^\w-])(iex|invoke-expression)([^\w-]|$)/i.test(text)
      && /download(string|data|file)|net\.webclient|invoke-webrequest|invoke-restmethod|(^|[^\w-])(iwr|irm|curl|wget|start-bitstransfer)([^\w-]|$)/i.test(text)) {
      this.add("escape", "escape.download-run", SAYS.downloadsAndRuns);
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
      this.psTextScan(text);
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
      for (let k = 0; k < item.pipes.length; k++) {
        this.cdTarget = undefined;
        const before = sc.cwd;
        const cd = this.posixPipeline(item.pipes[k], sc, item.background);
        if (cd !== undefined) {
          const next = item.ops[k];
          // A cd joined by && holds for what follows; after ; or || it may have failed: the folder is unknown.
          sc.cwd = next === "&&" ? cd : cd === before ? before : null;
        }
      }
    }
  }

  /** Classifies a pipeline; returns the folder when it is a lone `cd` (not in the background). */
  private posixPipeline(pipe: PList["items"][number]["pipes"][number], sc: Scope, background: boolean): string | null | undefined {
    this.pipe = { fetch: more(sc).pipedIn?.fetch ?? false, program: "" };
    let cd: string | null | undefined;
    let prev: number | undefined;
    pipe.cmds.forEach((c, k) => {
      const first = k === 0;
      const stdinPipe = !first || (first && more(sc).pipedIn !== null);
      if (c.kind === "simple") {
        this.cdTarget = undefined;
        this.posixSimple(c, sc, { stdinPipe, background, pipedFrom: first ? undefined : prev });
        if (pipe.cmds.length === 1 && !background && this.cdTarget !== undefined) cd = this.cdTarget;
        prev = this.at;
        return;
      }
      // A subshell or group: a subshell's (or a backgrounded or piped group's) cd doesn't leak.
      const isolated = c.kind === "subshell" || pipe.cmds.length > 1 || background;
      const inner = isolated ? child(sc, { depth: sc.depth + 1 }, { pipedIn: stdinPipe ? { fetch: this.pipe.fetch } : null }) : sc;
      const redirs = c.redirs.map(r => this.posixRedir(r, sc));
      if (redirs.some(r => r.kind !== "none") || background) {
        this.newCommand(c.kind === "subshell" ? "( … )" : "{ … }", [], sc, redirs, background, first ? undefined : prev);
        this.redirects(redirs, sc);
        if (background) this.add("escape", "escape.background", SAYS.keepsRunning);
      }
      const savedPipe = this.pipe;
      this.posixList(c.body, inner);
      this.pipe = savedPipe;
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
    this.posixList(list, child(sc, { depth: sc.depth + 1 }));
    const fetch = this.commands.slice(before).some(c => FETCHERS.has(c.program.toLowerCase()));
    this.pipe = savedPipe;
    this.at = savedAt;
    this.program = savedProg;
    this.cdTarget = savedCd;
    return fetch;
  }

  private posixSimple(c: PSimple, sc: Scope, o: { stdinPipe: boolean; background: boolean; pipedFrom?: number }): void {
    // Substitutions run first; their commands are classified as commands of their own.
    const fetchOf = new Map<PWord, boolean>();
    const allWords: PWord[] = [...c.words, ...c.assigns.map(a => a.value), ...c.redirs.flatMap(r => (r.target ? [r.target] : []))];
    for (const w of allWords) for (const sub of w.subs) if (this.subList(sub, sc)) fetchOf.set(w, true);
    for (const r of c.redirs) for (const sub of r.heredoc?.subs ?? []) this.subList(sub, sc);
    const words = c.words.map(w => this.posixWord(w, sc, fetchOf.get(w) ?? false));
    const redirs = c.redirs.map(r => this.posixRedir(r, sc));
    const stdin: Simple["stdin"] = c.redirs.some(r => r.op === "<<" || r.op === "<<-" || r.op === "<<<") ? "heredoc"
      : c.redirs.some(r => r.op === "<") ? "file" : o.stdinPipe ? "pipe" : null;
    const stdinText = stdin === "heredoc" ? this.hereText(c.redirs, sc) : undefined;
    if (c.words.length === 0) {
      this.newCommand("", [], sc, redirs, o.background, o.pipedFrom);
      this.assignments(c.assigns.map(a => ({ name: a.name, value: this.posixWord(a.value, sc, false) })), sc);
      this.redirects(redirs, sc);
      return;
    }
    this.simple({ words, redirs, stdin, stdinText, fetchBefore: this.pipe.fetch, background: o.background, pipedFrom: o.pipedFrom }, sc, () => {
      this.assignments(c.assigns.map(a => ({ name: a.name, value: this.posixWord(a.value, sc, false) })), sc);
    });
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

  /** A POSIX word's value with the scope's home and folder (`~`, `$HOME`, `$PWD`, `$(pwd)`); anything else unresolved. */
  posixWord(w: PWord, sc: Scope, fetch: boolean): Arg {
    let v = "";
    let pattern = "";
    let unquoted = "";
    let unresolved = false;
    // A word whose only substitution is a plain `$(pwd)` or `` `pwd` `` gives the folder, as `$PWD` does (review #170).
    const cwdSub = w.subs.length === 1 && w.segs.filter(seg => seg.t === "unres" && seg.why === "command substitution").length === 1 && lonePwd(w.subs[0]);
    for (const seg of w.segs) {
      if (seg.t === "lit") {
        v += seg.s;
        if (seg.q) pattern += seg.s.replace(/[*?[\]\\]/g, "\\$&");
        else { pattern += seg.s; unquoted += seg.s; }
      } else if (seg.t === "var") {
        const val = seg.name === "HOME" ? sc.home : seg.name === "PWD" ? sc.cwd : null;
        if (val === null) unresolved = true;
        else { v += val; pattern += val.replace(/[*?[\]\\]/g, "\\$&"); }
      } else if (seg.t === "unres" && seg.why === "command substitution" && cwdSub && sc.cwd) {
        v += sc.cwd;
        pattern += sc.cwd.replace(/[*?[\]\\]/g, "\\$&");
      } else if (seg.t === "tilde") {
        if (seg.user !== "") unresolved = true;
        // A home Ember doesn't know stays `~` (judged as some user's home, never probed: usePath).
        else if (!sc.home) { v += "~"; pattern += "~"; }
        else { v += sc.home; pattern += sc.home.replace(/[*?[\]\\]/g, "\\$&"); }
      } else unresolved = true;
    }
    const glob = !unresolved && (/[*?]/.test(unquoted) || /\[[^\]]*\]/.test(unquoted));
    const a: Arg = { v: unresolved ? null : v, raw: w.raw, glob };
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

  /** Assignments before a command or alone (§3.4.1): ones that change how commands are found or run are unclear. */
  private assignments(list: { name: string; value: Arg }[], sc: Scope): void {
    if (list.length) this.envChanged = true;
    for (const a of list) {
      if (RISKY_ASSIGNMENTS.has(a.name) || RISKY_ASSIGNMENT_PREFIX.test(a.name)) {
        this.unclear("unclear.assignment", "It changes how commands are found or run.");
      }
      if (a.value.v !== null && commandLineSecret(`${a.name}=${a.value.v}`)) this.add("secret", "secret.token-arg", SAYS.tokenArg);
      void sc;
    }
  }

  // ----------------------------------------------------------------------------------------------------------------
  // PowerShell.

  private psStatements(sts: PsStatement[], sc: Scope): void {
    sts.forEach((st, si) => {
      if (st.assign) {
        this.envChanged = true;
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
          if (fetch) this.pipe.fetch = true;
          this.redirects(redirs, sc);
          // A token typed into an assignment (`$env:GITHUB_TOKEN = 'ghp_…'`) is on the command line (§3.5.4).
          if (st.assign && k === 0) {
            const value = el.segs.map(seg => (seg.t === "lit" ? seg.s : "")).join("");
            if (commandLineSecret(el.raw) || (value !== "" && commandLineSecret(`${st.assign.replace(/^env:/i, "")}=${value}`))) this.add("secret", "secret.token-arg", SAYS.tokenArg);
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

  /** A PowerShell value's parts resolved: $HOME, $PWD, $env:USERPROFILE and the profile folders, $PROFILE, $null. */
  psValue(segs: PsSeg[], raw: string, sc: Scope, quoted: boolean): Arg {
    let v = "";
    let unresolved = false;
    const w = sc.windows;
    for (const seg of segs) {
      if (seg.t === "lit") { v += seg.s; continue; }
      if (seg.t === "unres") { unresolved = true; continue; }
      const n = seg.name.toLowerCase();
      const known: Record<string, string | null | undefined> = {
        home: sc.home, pwd: sc.cwd, "env:userprofile": w?.home ?? sc.home, "env:temp": w?.temp, "env:tmp": w?.temp,
        "env:localappdata": w?.localAppData, "env:appdata": w?.appData, "env:systemroot": w?.systemRoot, "env:windir": w?.systemRoot,
        null: "$null", true: "True", false: "False",
      };
      if (n === "profile" || n.startsWith("profile.")) {
        const home = w?.home ?? sc.home;
        if (home) { v += `${home}\\Documents\\WindowsPowerShell\\Microsoft.PowerShell_profile.ps1`; continue; }
      }
      const val = known[n];
      if (val === undefined || val === null) unresolved = true;
      else v += val;
    }
    void quoted;
    return { v: unresolved ? null : v, raw, glob: !unresolved && /[*?[]/.test(v) };
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
      if (t.v === null) { this.add("destroy", r.kind === "append" ? "redirect.append" : "redirect.overwrite", "Writes to a file Ember can't name."); continue; }
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
    this.noteProgram(prog);
    before?.();
    if (nonAsciiLetters(nameArg.v)) this.unclear("unclear.program-letters", "Its program name has letters from another alphabet.");
    // A program name with a line break, a tab or another control character in it names no program Ember can look up.
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is looked for here
    if (/[\x00-\x1f\x7f]/.test(nameArg.v)) this.unclear("unclear.program", "It runs a program Ember can't name.");
    this.redirects(s.redirs, sc);
    if (s.background) this.add("escape", "escape.background", SAYS.keepsRunning);
    this.dispatch({ e: this, sc, s, key, prog, nameArg, args, pn });
    this.unnamedWrites(key, args, sc);
    this.afterArgs(args);
    this.afterRun(key, args, s, sc);
    this.hiddenNames(key, args, sc);
    this.pipe.program = key;
    if (FETCHERS.has(key) || DECODERS.has(key)) this.pipe.fetch = true;
  }

  /** The program's row, after the checks every program gets. */
  dispatch(h: H): void {
    const { sc, key, nameArg, args, pn } = h;
    if (pn.isPath) {
      this.usePath(nameArg, "exec", sc);
      if (this.isDownloaded(nameArg, sc)) this.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
      else this.scriptByPath(nameArg, pn, sc);
      scriptName(h, nameArg.v ?? "");
    } else if (sc.family === "cmd" && nameArg.v !== null && !CMD_BUILTINS[key]) {
      // cmd looks in the current folder first, with each runnable extension when none is written.
      const names = pn.ext ? [nameArg.v] : [nameArg.v, ...[".exe", ".com", ".bat", ".cmd"].map(e => nameArg.v + e)];
      if (names.some(n => this.isDownloaded(lit(n), sc))) this.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
    }
    // cmd runs `x` or `.\x` as x.bat or x.cmd from the current folder when one is there: read them first (L8).
    if (sc.family === "cmd" && pn.ext === "" && nameArg.v !== null && !CMD_BUILTINS[key] && !nameArg.glob && !this.isDownloaded(nameArg, sc)) {
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
      if (!this.isDownloaded(nameArg, sc)) this.recordScript(nameArg, "cmd", sc);
      if (args.some(a => a.v === null || /[&|<>^%!]/.test(a.v))) this.unclear("unclear.batch-args", "cmd would read its arguments as commands.");
      if (sc.wsl && sc.family === "posix" && !(sc.cwd && sc.mountRoot && isUnder(sc.cwd, sc.mountRoot, sc.path))) {
        this.unclear("unclear.cmd-linux-folder", SAYS.cmdLinuxFolder);
      }
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
    const n = NATIVE[key];
    if (n) n(h);
    else generic(h);
    optionPaths(h, !n);
  }

  /** Every argument read as a possible path (an unknown program's operands): secrets and Ember's paths judged. */
  readArgs(args: Arg[], sc: Scope, o: { unresolvedUnclear?: boolean } = {}): void {
    for (const a of args) {
      if (a.param !== undefined) continue;
      if (a.v === null) {
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

  /** Checks every program's arguments get: a password or token typed on the command line (§3.5.4). */
  afterArgs(args: Arg[]): void {
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
    const savedAt = this.at;
    const savedProg = this.program;
    const savedPipe = this.pipe;
    this.pipe = { fetch: o.fetchBefore ?? false, program: "" };
    this.simple({ words, redirs: [], stdin: o.stdin ?? null, fetchBefore: o.fetchBefore ?? false, background: false }, child(sc, { wrappers: [...sc.wrappers, wrapper], depth: sc.depth + 1 }));
    this.pipe = savedPipe;
    this.at = savedAt;
    this.program = savedProg;
  }

  /** Unwraps a wrapper: the same command now runs `words`, with the wrapper recorded (sudo rm → program rm, wrappers sudo). */
  unwrap(h: H, words: Arg[], wrapper: string, o: Partial<Scope> = {}): void {
    if (words.length === 0) return;
    const pc = this.commands[this.at];
    const nameArg = words[0];
    const sc = child(h.sc, { ...o, wrappers: [...h.sc.wrappers, wrapper] }, more(h.sc));
    pc.wrappers = [...sc.wrappers];
    if (nameArg.v === null) {
      pc.program = nameArg.raw;
      pc.args = words.slice(1).map(a => a.v);
      this.unclear("unclear.program", "It runs a program Ember can't name.");
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
    if (nonAsciiLetters(nameArg.v)) this.unclear("unclear.program-letters", "Its program name has letters from another alphabet.");
    const inner: H = { e: this, sc, s: { ...h.s, ps: undefined }, key, prog, nameArg, args: words.slice(1), pn };
    // Native rows only: a wrapper runs a program, never a cmdlet or a cmd built-in.
    if (pn.isPath) {
      this.usePath(nameArg, "exec", sc);
      if (this.isDownloaded(nameArg, sc)) this.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
      else {
        // `env ./x.sh`, `exec ./x.sh`, `timeout 5 ./x.sh` run the script as `./x.sh` does (L8, the lead's ruling).
        this.scriptByPath(nameArg, pn, sc);
        if (pn.ext === ".bat" || pn.ext === ".cmd") this.recordScript(nameArg, "cmd", sc);
      }
      scriptName(inner, nameArg.v);
    }
    const n = NATIVE[key];
    if (n) n(inner);
    else generic(inner);
    optionPaths(inner, !n);
    this.unnamedWrites(key, inner.args, sc);
    this.afterArgs(inner.args);
    this.afterRun(key, inner.args, { ...h.s, redirs: [] }, sc);
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
  }

  /**
   * What every program gets after its row (§3.4.7): output a download writes to a file is a download too
   * (`curl URL > x.sh`, `curl URL | tee x.sh`), and a build tool, test runner or package manager working in a folder
   * this task downloaded runs that folder's code (a cloned repository's Makefile or package scripts).
   */
  afterRun(key: string, args: Arg[], s: Simple, sc: Scope): void {
    if (s.fetchBefore || FETCHERS.has(key)) {
      for (const r of s.redirs) if ((r.kind === "write" || r.kind === "append") && r.target?.v) this.download(r.target.v, sc);
      if (/^(tee|tee-object|out-file|set-content|add-content)$/.test(key)) {
        for (const a of args) if (a.v !== null && a.param === undefined && !isOption(a) && !NULL_SINKS.has(a.v.toLowerCase())) this.download(a.v, sc);
      }
    }
    const runner = PROJECT_RUNNERS.has(key) || ((key === "docker" || key === "podman") && /^(compose|build|buildx)$/.test(args[0]?.v ?? ""));
    if (!runner || (this.ctx.downloaded.size === 0 && this.downloads.length === 0)) return;
    const inDownloaded = this.isDownloaded(lit("."), sc) || args.some(a => {
      if (a.v === null || URL_LIKE.test(a.v)) return false;
      const v = a.v.replace(/^--?[A-Za-z][A-Za-z-]*=/, "");
      return v !== "" && !v.startsWith("-") && this.isDownloaded({ ...a, v }, sc);
    });
    if (inDownloaded) this.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
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
const objsOf = (h: H, list: Arg[], use: PathUse): Obj[] => list.map(a => h.e.usePath(a, use, h.sc));
/** Objects for the card: as written; an unresolved one by its text. */
const listOf = (objs: Obj[], fallback = "files Ember can't name"): string => (objs.length ? joinList(objs.map(o => o.text || fallback)) : fallback);
const lower = (a: Arg | undefined): string | null => (a && a.v !== null ? a.v.toLowerCase() : null);

/** The words of a script, target or package-script name (§3.5.9): split on - _ : . / \ and camel case. */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[-_:./\\\s]+/)
    .map(w => w.toLowerCase())
    .filter(w => w !== "");
}

/** §3.5.9: a script, target or package-script name that says it publishes (b), deletes (a) or installs (e). */
function nameCheck(h: H, name: string, display = name): void {
  const words = nameWords(name);
  if (words.some(w => NAME_PUBLISH.has(w))) h.e.add("publish", "script.publish", `Runs ${display}, whose name says it publishes.`, { objects: [{ kind: "other", text: display, abs: null }] });
  if (words.some(w => NAME_DESTROY.has(w))) h.e.add("destroy", "script.destroy", `Runs ${display}, whose name says it deletes things.`, { objects: [{ kind: "other", text: display, abs: null }] });
  if (words.some(w => NAME_SYSTEM.has(w))) h.e.add("system", "script.system", `Runs ${display}, whose name says it installs or sets up software.`, { objects: [{ kind: "other", text: display, abs: null }] });
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
      if (sub === undefined || sub === null || ["attach", "a", "at", "attach-session", "new", "new-session"].includes(sub)) {
        if (a.some(x => x.v === "-d" || (x.v !== null && /^-[A-Za-z]*d/.test(x.v) && !x.v.startsWith("--")))) h.e.add("escape", "escape.tmux", SAYS.keepsRunning);
        else add();
      } else if (["kill-server", "kill-session", "kill-pane", "kill-window"].includes(sub)) h.e.add("system", "kill.process", "Stops programs that are running (tmux sessions).");
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
      const w = parseOpts(a, { shortValue: "nqd", longValue: ["interval", "differences"], stopAtOperand: true });
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
  "desktop-file-install", "desktop-file-edit", "update-desktop-database", "busybox", "caddy", "miniserve", "cloudflared", "ngrok",
  "ssh-copy-id", "mount_smbfs", "mount_afp", "mount_webdav",
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

/** An unknown program: its operands read as paths; an operand naming a program may mean it runs it. */
function generic(h: H): void {
  const k = h.key;
  if (INPUT_SYNTH.has(k)) { h.e.refuseWith("ember.input", "input"); return; }
  if (GUI_PROGRAMS.has(k)) h.e.unclear("unclear.gui", SAYS.openApp);
  if (INTERACTIVE.has(k)) interactive(h);
  if (LAUNCHERS.has(k)) { launcher(h); return; }
  if (SECRET_PROGRAMS.has(k)) h.e.add("secret", "secret.program", SAYS.secrets);
  if (CLIPBOARD_READERS.has(k)) h.e.add("secret", "secret.clipboard", SAYS.clipboard);
  if (SCREENSHOTTERS.has(k)) h.e.add("secret", "secret.screen", SAYS.screen);
  if (DISK_TOOLS.has(k) || /^mkfs(\.|$)/.test(k)) h.e.add("destroy", "disk.erase", "Erases or repartitions a disk.");
  h.e.readArgs(h.args, h.sc, { unresolvedUnclear: !TEXT.has(k) });
  if (KNOWN_ORDINARY.has(k) || GUI_PROGRAMS.has(k) || INTERACTIVE.has(k) || SECRET_PROGRAMS.has(k)) return;
  const at = h.args.findIndex(a => {
    const base = (a.v ?? "").split(/[\\/]/).pop() ?? "";
    return a.v !== null && /^[A-Za-z]/.test(base) && runners().has(base.toLowerCase().replace(/\.(exe|com)$/, ""));
  });
  if (at >= 0) {
    h.e.unclear("unclear.hidden-command", `Ember can't tell how ${h.prog} runs ${h.args[at].v}.`);
    h.e.payload(h.args.slice(at), h.sc, h.prog);
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
    const name = m ? m[1].toLowerCase() : short ? "o" : null;
    if (name === null) continue;
    const output = name === "o" || OUTPUT_OPTION.test(name);
    if (!output && (!FILE_OPTION.test(name) || name.endsWith("profile"))) continue;
    if (SETTINGS_FILE_OPTION.has(name) && h.key !== "my_print_defaults" && !args.some(x => x.v === "--print-defaults")) continue;
    // `--file=x` in one word (its pattern, for a glob, is the part after `=`), or `--file x`.
    const value: Arg | undefined = m && m[2] !== undefined
      ? { ...a, v: a.v === null ? null : m[3], pattern: a.pattern === undefined ? undefined : a.pattern.slice(a.pattern.indexOf("=") + 1), param: undefined }
      : args[k + 1];
    if (value && value.v === null) { h.e.unclear("unclear.unresolved-arg", `Ember can't tell which arguments ${h.prog || "the program"} gets.`); continue; }
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

/** PowerShell's approved verbs that change things: an unknown cmdlet with one is unclear (§3.4.2's conservative rule). */
const PS_READ_VERBS = new Set(["get", "find", "search", "select", "measure", "test", "compare", "convertto", "convertfrom", "format", "resolve", "trace", "join", "split", "group", "sort", "where", "foreach", "show", "read", "out", "write", "debug", "wait", "use", "watch", "confirm", "assert", "ping", "receive", "convert", "expand", "limit"]);
function unknownCmdlet(h: H): void {
  const verb = h.key.split("-")[0];
  if (!PS_READ_VERBS.has(verb)) h.e.unclear("unclear.cmdlet", `Ember can't tell what ${h.prog} changes.`);
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
    const ops = h.args.filter(a => !(a.v !== null && /^-[LPe@]+$/.test(a.v)) && !(h.sc.family === "cmd" && a.v?.toLowerCase() === "/d"));
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
  const p = opts(h, { shortValue: h.key === "tree" ? "LPIoH" : h.key === "du" ? "BdXt" : h.key === "stat" ? "cf" : "IwT", longValue: ["ignore", "hide", "format", "time-style", "width", "tabsize", "block-size", "exclude", "max-depth", "threshold", "time", "printf", "output", "sort", "color", "indicator-style", "quoting-style", "files0-from", "exclude-from"] });
  if (h.key === "tree") for (const o of values(p, "o", "output")) if (o) h.e.usePath(lit(o), "write", h.sc);
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
    if (a.v === null) { h.e.unclear("unclear.unresolved-arg", `Ember can't tell which arguments ${h.prog} gets.`); continue; }
    const obj = h.e.usePath(a, use, h.sc);
    if (obj.abs === null) h.e.unclear("unclear.unresolved-arg", `Ember can't tell which arguments ${h.prog} gets.`);
  }
});
// grep and friends: a recursive search reads every file under its folders (secrets included unless hidden files are skipped).
reg(NATIVE, ["grep", "egrep", "fgrep", "rg", "ag", "ack", "ugrep", "git-grep"], h => {
  // git grep's and ugrep's pager value is optional and only follows `=`: written alone, the option takes the default
  // pager and the next word is the pattern or a file (review #165). ag's and ack's take the next word.
  const pagerApart = h.key === "git-grep" || h.key === "ugrep" ? [] : ["pager", "open-files-in-pager"];
  const p = opts(h, { shortValue: h.key === "rg" ? "eftgjmABCEMT" : "efmABCdD", longValue: ["regexp", "file", "max-count", "after-context", "before-context", "context", "include", "exclude", "exclude-dir", "include-dir", "directories", "devices", "label", "binary-files", "color", "colour", "glob", "iglob", "type", "type-not", "type-add", "max-depth", "threads", "encoding", "max-filesize", "sort", "sortr", "path-separator", "pre", "pre-glob", "engine", "ignore-file", "replace", ...pagerApart, "filter", "hostname-bin"] });
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
  const patternGiven = values(p, "e", "regexp", "f", "file").length > 0;
  for (const f of values(p, "f", "file")) if (f) h.e.usePath(lit(f), "read", h.sc);
  const files = patternGiven ? p.operands : p.operands.slice(1);
  const hiddenToo = h.key === "grep" || h.key === "egrep" || h.key === "fgrep" || h.key === "ack" || h.key === "ugrep" || has(p, "hidden", "u", "uu", "uuu", "unrestricted", "a", "all-types", "no-ignore");
  const recursive = h.key === "rg" || h.key === "ag" || h.key === "ack" || has(p, "r", "R", "recursive", "dereference-recursive") || values(p, "d", "directories").includes("recurse");
  const use: PathUse = recursive && hiddenToo ? "readTree" : "read";
  for (const f of files) {
    if (f.v === null) { h.e.unclear("unclear.unresolved-arg", `Ember can't tell which arguments ${h.prog} gets.`); continue; }
    const obj = h.e.usePath(f, use, h.sc);
    if (obj.abs === null) h.e.unclear("unclear.unresolved-arg", `Ember can't tell which arguments ${h.prog} gets.`);
  }
  if (recursive && hiddenToo && files.length === 0 && h.sc.cwd) h.e.usePath(lit("."), "readTree", h.sc);
});
reg(NATIVE, ["mysql", "mariadb", "mysqldump", "mysqladmin", "mysqlimport"], h => {
  if (h.args.some(a => a.v !== null && /^-p.+/.test(a.v))) h.e.add("secret", "secret.token-arg", SAYS.tokenArg);
  if (h.key === "mysql" || h.key === "mariadb") {
    interactive(h);
    databaseText(h, inlineSql(h, ["e"], ["execute"]));
    // SQL read from stdin or a here-document (`mysql <<< 'system id'`): judge the seen text, else ask (review #166).
    if (!inlineSql(h, ["e"], ["execute"]).length) sqlFromStdin(h);
  }
  if (h.key === "mysqladmin" && h.args.some(a => /^(drop|shutdown|flush-|kill|password|reload|refresh)/.test(a.v ?? ""))) h.e.add("destroy", "db.change", "Changes or deletes data in a database.");
  for (const r of h.args) if (r.v && /^--result-file=/.test(r.v)) h.e.usePath(lit(r.v.slice(14)), "write", h.sc);
});

/** Statements that change or delete what a database holds (D4.3 a: destroying data). */
const SQL_WRITE = /\b(drop|delete|truncate|update|alter|insert|replace|merge|upsert|grant|revoke|create|rename|vacuum|reindex|attach|detach|flushall|flushdb|dropdatabase|deletemany|deleteone|remove|load\s+data)\b|\binto\s+(out|dump)file\b/i;
/** Client commands that run programs, write or read files, or load code (psql's `\!`, sqlite's `.shell`, COPY … PROGRAM). */
const SQL_ESCAPE = /(^|[\s;])(\\(!|(o|g|gx|w|copy|i|ir|include|setenv|lo_export|lo_import|s)\b)|\.(shell|system|output|once|import|load|read|save|backup|restore|excel|open|cd|log|dump)\b|system\s)|\bprogram\s+'|\bcopy\b[^;]*\b(to|from)\b/i;

/** The SQL (or client commands) given on a database client's command line. */
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
 * #166). A file redirect (`psql < dump.sql`) runs as `psql -f dump.sql` does.
 */
function sqlFromStdin(h: H): void {
  if (h.s.stdin === "pipe" || h.s.stdin === "heredoc") fromStdin(h, t => databaseText(h, [t]));
}

/** A database client's own text: changing data is class a; running programs or touching files from it is unclear. */
function databaseText(h: H, texts: (string | null)[]): void {
  for (const t of texts) {
    if (t === null) { h.e.unclear("unclear.sql", "It runs database commands Ember can't see."); continue; }
    if (SQL_ESCAPE.test(t)) h.e.unclear("unclear.sql", "It runs database client commands that can run programs or write files.");
    if (SQL_WRITE.test(t)) h.e.add("destroy", "db.change", "Changes or deletes data in a database.");
  }
}

reg(NATIVE, ["psql", "sqlite3", "sqlite", "duckdb", "sqlcmd", "cqlsh", "clickhouse-client", "mongo", "mongosh", "redis-cli", "sqlplus"], h => {
  if (INTERACTIVE.has(h.key)) interactive(h);
  const k = h.key;
  if (k === "psql") {
    databaseText(h, inlineSql(h, ["c"], ["command"]));
    // SQL read from stdin or a here-document (`psql <<< '\! id'`, `psql -f - <<< …`): judge the seen text, else ask;
    // a file given as another descriptor (`-f /dev/fd/3`) can't be read first (review #166).
    const files = inlineSql(h, ["f"], ["file"]);
    if (files.some(f => f !== null && STDIN_NAME.test(f)) || (!inlineSql(h, ["c"], ["command"]).length && !files.length)) sqlFromStdin(h);
    if (files.some(f => f !== null && !STDIN_NAME.test(f) && STREAM_NAME.test(f))) h.e.unclear("unclear.script-stream", SAYS.scriptStream);
  }
  else if (k === "sqlcmd") databaseText(h, inlineSql(h, ["Q", "q"], []));
  else if (k === "cqlsh") databaseText(h, inlineSql(h, ["e"], ["execute"]));
  else if (k === "clickhouse-client") databaseText(h, inlineSql(h, ["q"], ["query"]));
  else if (k === "sqlite3" || k === "sqlite" || k === "duckdb") {
    // -cmd's and -init's values are not the database or its SQL.
    const ops = h.args.filter((a, j) => !isOption(a) && !/^--?(cmd|init)$/.test(h.args[j - 1]?.v ?? ""));
    databaseText(h, [...ops.slice(1).map(a => a.v), ...inlineSql(h, [], ["cmd"]).map(x => x), ...h.args.flatMap((a, j) => (a.v === "-cmd" ? [h.args[j + 1]?.v ?? null] : []))]);
    // -init FILE runs the file's commands first, as `.read FILE` does (review #166): stdin is judged as below, another
    // descriptor can't be read first, and any other file asks.
    const init = h.args.flatMap((a, j) => (/^--?init$/.test(a.v ?? "") ? [h.args[j + 1]?.v ?? null] : []));
    for (const f of init) {
      if (f !== null && STDIN_NAME.test(f)) sqlFromStdin(h);
      else if (f !== null && STREAM_NAME.test(f)) h.e.unclear("unclear.script-stream", SAYS.scriptStream);
      else {
        if (f) h.e.usePath(lit(f), "read", h.sc);
        h.e.unclear("unclear.sql", "It runs database client commands from a file Ember doesn't read.");
      }
    }
    // SQL read from stdin or a here-document (`sqlite3 <<< '.shell id'`): judge the seen text, else ask (review #166).
    if (ops.length < 2 && !inlineSql(h, [], ["cmd"]).length && !h.args.some(a => a.v === "-cmd") && !init.some(f => f !== null && STDIN_NAME.test(f))) sqlFromStdin(h);
    if (ops[0]) h.e.readArgs([ops[0]], h.sc);
    return;
  } else if (k === "mongo" || k === "mongosh") {
    if (inlineSql(h, [], ["eval"]).length) h.e.unclear("unclear.inline-code", "It runs code given on the command line.");
  } else if (k === "redis-cli") {
    const p = opts(h, { shortValue: "hpsanuirdc", longValue: ["user", "pass", "tls", "cacert", "cert", "key", "rdb", "functions-rdb", "eval"] });
    if (values(p, "eval").length || has(p, "eval")) h.e.unclear("unclear.inline-code", "It runs code given on the command line.");
    if (has(p, "a", "pass") || values(p, "a").length) h.e.add("secret", "secret.token-arg", SAYS.tokenArg);
    const cmd = (p.operands[0]?.v ?? "").toLowerCase();
    if (cmd && !/^(get|mget|exists|keys|scan|sscan|hscan|zscan|type|ttl|pttl|strlen|hget|hgetall|hkeys|hvals|hlen|hexists|lrange|llen|lindex|smembers|scard|sismember|zrange|zrangebyscore|zcard|zscore|info|ping|dbsize|time|echo|memory|object|client|slowlog|latency|monitor|subscribe|psubscribe|pubsub|xrange|xlen|xread|bitcount|getrange|getbit|role|lastsave|command|config)$/.test(cmd)) {
      h.e.add("destroy", "db.change", "Changes or deletes data in a database.");
    }
    if (cmd === "config" && /^(set|rewrite|resetstat)$/i.test(p.operands[1]?.v ?? "")) h.e.add("system", "system.kernel", "Changes how the system works.");
  }
  for (const f of [...inlineSql(h, ["f"], ["file"]), ...inlineSql(h, ["i"], ["input-file"])]) if (f) { h.e.usePath(lit(f), "read", h.sc); nameCheck(h, f); }
});

// a: rm and friends (§3.5.1).
reg(NATIVE, ["rm", "unlink", "shred", "srm", "wipe", "rmdir"], h => {
  const shred = h.key === "shred";
  const p = opts(h, { shortValue: shred ? "nsu" : "", longValue: shred ? ["iterations", "size", "random-source"] : [] });
  const rec = (h.key === "rm" || h.key === "srm" || h.key === "wipe") && has(p, "r", "R", "recursive");
  const objs = objsOf(h, p.operands, rec ? "deleteTree" : "delete");
  const widening: string[] = [];
  if (rec) widening.push("recursive");
  if (has(p, "no-preserve-root")) widening.push("--no-preserve-root");
  if (h.key === "rmdir" && has(p, "p", "parents")) widening.push("--parents");
  const list = listOf(objs);
  h.e.add("destroy", `posix.${h.key}`, rec ? `Deletes ${list} and everything in ${objs.length > 1 ? "them" : "it"}.` : `Deletes ${list}.`, { objects: objs, widening });
  if (objs.some(o => o.abs !== null && /\/\.local\/share\/Trash(\/|$)/.test(o.abs))) h.e.add("destroy", "trash.empty", "Empties the trash.");
});

reg(NATIVE, ["trash-empty"], h => { h.e.add("destroy", "trash.empty", "Empties the trash."); });
reg(NATIVE, ["trash", "trash-put", "gio"], h => {
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
    if (FIND_VALUE.has(v)) j++;
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
  const p = parseOpts(h.args, {
    shortValue: "adEILlnPs", longValue: ["arg-file", "delimiter", "eof", "replace", "max-lines", "max-args", "max-procs", "max-chars", "process-slot-var"],
    stopAtOperand: true,
  });
  for (const f of values(p, "a", "arg-file")) if (f) h.e.usePath(lit(f), "read", h.sc);
  const repl = values(p, "I", "replace", "i")[0];
  const ops = p.operands.length ? p.operands : [lit("echo")];
  const shell = POSIX_SHELLS[(ops[0].v ?? "").split("/").pop() ?? ""];
  let intoCode = false;
  const words = ops.map((w, k) => {
    if (!repl || w.v === null || !w.v.includes(repl)) return w;
    // The input put into shell text (`sh -c 'rm {}'`): the text is still read, the input standing as an unknown
    // word, and it is unclear (a name holding `;` or `$(…)` runs as code).
    if (shell && k > 0 && /^-[a-zA-Z]*c$/.test(ops[k - 1].v ?? "")) { intoCode = true; return { ...w, v: w.v.split(repl).join("\"$XARGS_INPUT\"") }; }
    return { v: null, raw: w.raw, glob: false };
  });
  if (intoCode) h.e.unclear("unclear.input-in-code", "It puts its input into shell text, where it can run as code.");
  // With -I the input replaces the placeholder; otherwise it is added after the words.
  h.e.payload(repl ? words : [...words, { v: null, raw: "(input)", glob: false }], h.sc, "xargs", { stdin: null });
});
reg(NATIVE, ["parallel"], h => {
  if (h.args.some(a => a.v !== null && /^:::+\+?$/.test(a.v))) { h.e.unclear("unclear.parallel", "Ember can't tell what parallel runs."); return; }
  const p = parseOpts(h.args, { shortValue: "jSaEdIX", longValue: ["jobs", "sshlogin", "arg-file", "eof", "delimiter", "joblog", "results", "tmpdir"], stopAtOperand: true });
  if (p.operands.length === 1 && (p.operands[0].v ?? " ").includes(" ")) { h.e.unclear("unclear.parallel", "Ember can't tell what parallel runs."); return; }
  if (has(p, "S", "sshlogin")) h.e.add("publish", "send.ssh", "Sends data to another computer.");
  h.e.payload([...p.operands, { v: null, raw: "(input)", glob: false }], h.sc, "parallel");
});

reg(NATIVE, ["truncate"], h => {
  const p = opts(h, { shortValue: "sr", longValue: ["size", "reference"] });
  for (const r of values(p, "r", "reference")) if (r) h.e.usePath(lit(r), "read", h.sc);
  const objs = objsOf(h, p.operands, "write");
  h.e.add("destroy", "posix.truncate", `Empties ${listOf(objs)}.`, { objects: objs });
});

reg(NATIVE, ["dd"], h => {
  for (const a of h.args) {
    const v = a.v;
    if (v === null) { h.e.unclear("unclear.unresolved-arg", "Ember can't tell which arguments dd gets."); continue; }
    const m = /^(if|of)=(.*)$/.exec(v);
    if (!m) continue;
    if (m[1] === "if") { h.e.usePath({ ...a, v: m[2] }, "read", h.sc); continue; }
    if (NULL_SINKS.has(m[2].toLowerCase())) continue;
    const obj = h.e.usePath({ ...a, v: m[2] }, "write", h.sc);
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
  const p = opts(h, {
    shortValue: kind === "install" ? "mgotSb" : kind === "ln" ? "tS" : "tS",
    longValue: ["target-directory", "suffix", "mode", "group", "owner", "strip-program", "context", "backup", "reflink", "sparse", "preserve", "no-preserve", "update"],
  });
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
  if (!dest) return;
  if (kind === "ln" && !has(p, "f", "force")) { h.e.usePath(dest, "write", h.sc); return; }
  const destObj = h.e.usePath(dest, "write", h.sc);
  if (noClobber) return;
  const rule = `posix.${kind}`;
  if (destObj.abs === null) { h.e.add("destroy", rule, "Writes to a file Ember can't name.", { objects: [destObj] }); return; }
  const intoFolder = target !== undefined || sources.length > 1 || /[\\/]$/.test(dest.v ?? "");
  if (intoFolder) {
    for (const s of sources) {
      if (s.v === null || s.glob) {
        h.e.judgeInside(destObj.abs, "write", h.sc, destObj.text);
        h.e.add("destroy", rule, `Replaces files in ${destObj.text} if they exist.`, { objects: [destObj] });
        continue;
      }
      const mod = h.sc.path.flavour === "win32" ? win32 : posix;
      const name = baseName(s.v.replace(/[\\/]+$/, ""), h.sc.path.flavour);
      const p2 = mod.join(destObj.abs, name);
      // Into a folder named with `..` (`cp a sub/../`): the file lands beside where sub leads, so that name (its `..`
      // kept, never joined lexically) is probed and is what "if it exists" asks about.
      const o2 = h.e.usePath(lit(destObj.phys !== undefined ? `${destObj.phys}/${name}` : p2), "write", h.sc);
      const obj: Obj = { kind: "path", text: p2, resolved: p2, abs: p2, ...(o2.phys !== undefined ? { phys: o2.phys } : {}), ...(o2.realDiffers ? { realDiffers: true } : {}) };
      h.e.add("destroy", rule, `Replaces ${p2} if it exists.`, { objects: [obj], ifExists: p2 });
    }
    return;
  }
  h.e.add("destroy", rule, `Replaces ${destObj.text} if it exists.`, { objects: [destObj], ifExists: destObj.abs });
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
  const p = opts(h, { shortValue: h.key === "touch" ? "dtr" : h.key === "mkdir" ? "m" : "pt", longValue: ["date", "reference", "mode", "tmpdir", "suffix", "context"] });
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
const TAR_VALUE = "fCbKNTXgLVFHIj";
reg(NATIVE, ["tar", "bsdtar", "gtar"], h => {
  const a = [...h.args];
  // Old-style bundled first argument (`tar xzf x.tgz`).
  if (a[0]?.v && !a[0].v.startsWith("-")) a[0] = { ...a[0], v: `-${a[0].v}` };
  const p = parseOpts(a, {
    shortValue: TAR_VALUE,
    longValue: ["file", "directory", "files-from", "exclude-from", "exclude", "use-compress-program", "transform", "xform", "to-command", "info-script", "new-volume-script", "newer", "after-date", "owner", "group", "mode", "mtime", "format", "label", "volno-file", "checkpoint-action", "index-file", "warning", "record-size", "blocking-factor", "tape-length", "sort"],
  });
  const extract = has(p, "x", "extract", "get");
  const create = has(p, "c", "create", "r", "append", "u", "update", "A", "catenate", "concatenate");
  const archive = values(p, "f", "file")[0];
  const dir = values(p, "C", "directory")[0];
  if (has(p, "to-command", "use-compress-program", "I", "info-script", "new-volume-script", "checkpoint-action", "rsh-command") || values(p, "checkpoint-action").length) h.e.unclear("unclear.tar-command", "It runs a command Ember can't see.");
  // The lists of names to pack or leave out are files tar reads, and its errors show their lines (review #174).
  for (const f of values(p, "T", "files-from", "X", "exclude-from")) if (f !== null && !STDIN_NAME.test(f)) h.e.usePath(lit(f), "read", h.sc);
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
    }
    return;
  }
  if (extract) {
    const into = dir ? h.e.usePath(lit(dir), "write", h.sc) : h.e.usePath(lit("."), "write", h.sc);
    const risky = has(p, "P", "absolute-names", "overwrite", "unlink-first", "U", "recursive-unlink");
    if (risky || into.abs === null || !inWorkTree(into.abs, h.sc.path)) {
      h.e.add("destroy", "archive.unpack", `Unpacks ${archive ?? "an archive"} over files in ${into.text === "." ? "this folder" : into.text}.`, { objects: [into] });
    }
    if ((archive && h.e.isDownloaded(lit(archive), h.sc)) || (archive === "-" || !archive) && h.s.fetchBefore) if (into.abs) h.e.downloads.push(into.abs);
    objsOf(h, p.operands, "write");
  }
});

reg(NATIVE, ["zip"], h => {
  const p = opts(h, { shortValue: "bnPtTZ", longValue: ["temp-path", "suffixes", "password", "unzip-command", "tt"] });
  if (has(p, "unzip-command") || h.args.some(a => /^(-TT|--unzip-command|--tt)/.test(a.v ?? ""))) h.e.unclear("unclear.zip-command", "It runs a command Ember can't see.");
  const [arc, ...inputs] = p.operands;
  if (arc) {
    const obj = h.e.usePath(arc, "write", h.sc);
    void obj;
  }
  const ins = objsOf(h, inputs, has(p, "r", "recurse-paths") ? "readTree" : "read");
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
      h.e.add("destroy", "archive.unpack", `Unpacks ${ops[0]?.v ?? "an archive"} over files in ${outDir || "this folder"}.`, { objects: [into] });
    }
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
    h.e.add("destroy", "archive.unpack", `Unpacks ${p.operands[0]?.v ?? "an archive"} over files in ${dir ?? "this folder"}.`, { objects: [into] });
  }
  if (p.operands[0] && h.e.isDownloaded(p.operands[0], h.sc) && into.abs) h.e.downloads.push(into.abs);
});

reg(NATIVE, ["cpio"], h => {
  const p = opts(h, { shortValue: "EFHIMORsD", longValue: ["file", "format", "pattern-file", "rsh-command", "owner", "directory"] });
  if (has(p, "rsh-command")) h.e.unclear("unclear.cpio-command", "It runs a command Ember can't see.");
  if (has(p, "i", "extract")) {
    // -D/--directory: the folder it unpacks into (review #169).
    const dir = values(p, "D", "directory")[0];
    const into = dir === null ? { kind: "other" as const, text: "a folder Ember can't name", abs: null } : h.e.usePath(lit(dir ?? "."), "write", h.sc);
    if (has(p, "u", "unconditional") || into.abs === null || !inWorkTree(into.abs, h.sc.path)) h.e.add("destroy", "archive.unpack", `Unpacks an archive over files in ${dir === undefined ? "this folder" : into.text}.`, { objects: [into] });
  }
  if (has(p, "p", "pass-through")) {
    const dest = p.operands[0];
    if (dest) h.e.usePath(dest, "write", h.sc);
  }
});

// Compressors replace their input with the packed (or unpacked) file unless told to keep it.
reg(NATIVE, ["gzip", "gunzip", "bzip2", "bunzip2", "xz", "unxz", "lzma", "unlzma", "lzip", "compress", "uncompress", "zstd", "unzstd", "lz4", "pigz", "unpigz", "brotli"], h => {
  const p = opts(h, { shortValue: "S", longValue: ["suffix", "rsyncable", "format", "threads", "memlimit"] });
  const keeps = has(p, "k", "keep", "c", "stdout", "to-stdout", "t", "test", "l", "list", "h", "help", "V", "version");
  const removes = ["zstd", "unzstd", "lz4", "brotli"].includes(h.key) ? has(p, "rm") : !keeps;
  const ins = objsOf(h, p.operands, "write");
  if (removes && p.operands.length && !keeps) h.e.add("destroy", "archive.in-place", `Replaces ${listOf(ins)} with a packed or unpacked copy.`, { objects: ins });
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
  if (scripts.length === 0 && scriptFiles.length === 0) { scripts = [files[0]?.v ?? null]; files = files.slice(1); }
  for (const s of scripts) if (s === null || !sedScriptOk(s)) h.e.unclear("unclear.sed-script", "Its sed script can run commands or write files Ember can't see.");
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
  const p = opts(h, { shortValue: "fFvWe", longValue: ["file", "field-separator", "assign", "source", "include", "load"] });
  const progFiles = values(p, "f", "file", "include", "load");
  for (const f of progFiles) if (f && !STDIN_NAME.test(f)) h.e.usePath(lit(f), "read", h.sc);
  // `awk -f -` / `-f /dev/stdin` reads its program from stdin: judge the seen text, else ask (review #166).
  if (progFiles.some(f => f === null || STDIN_NAME.test(f))) fromStdin(h, t => { if (!awkProgramOk(t)) h.e.unclear("unclear.awk-program", "Its awk program can run commands or write files."); });
  else if (progFiles.some(f => f !== null && STREAM_NAME.test(f))) h.e.unclear("unclear.script-stream", SAYS.scriptStream);
  let files = p.operands;
  const inline = values(p, "e", "source");
  if (progFiles.length === 0 && inline.length === 0) { inline.push(files[0]?.v ?? null); files = files.slice(1); }
  for (const prog of inline) if (prog === null || !awkProgramOk(prog)) h.e.unclear("unclear.awk-program", "Its awk program can run commands or write files.");
  h.e.readArgs(files.filter(f => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(f.v ?? "")), h.sc, { unresolvedUnclear: true });
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
    if (!posixShell) h.e.unclear("unclear.other-shell", `Ember can't read ${h.key}'s language.`);
    return;
  }
  intoInterpreter(h, readAs);
});

/**
 * A tool reading its program (a makefile, SQL, an awk or debugger script) from stdin or a here-document (review #166):
 * when Ember can see all of the text (a quoted here-document or a here-string), `judge` it; otherwise a fetch before it
 * is download-and-run, and anything else is unclear (it runs code Ember can't see). The dangerous cases ask either way.
 */
function fromStdin(h: H, judge: (text: string) => void): void {
  const t = h.s.stdinText;
  if (t !== undefined && t !== null) { judge(t); return; }
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
      else if (readAs !== undefined) h.e.recordScript(r.target, readAs, h.sc);
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
  if (h.e.isDownloaded(script, h.sc)) h.e.add("escape", "escape.run-downloaded", SAYS.runsDownloaded);
  else if (readAs !== undefined) h.e.recordScript(script, readAs, h.sc);
  nameCheck(h, script.v, script.v);
}

/** Inline code: unclear, and refused when it names Ember's own paths (§3.5.8). */
function emberText(h: H, code: string): void {
  for (const e of h.sc.path.ember) if (code.includes(e) || (h.sc.home && code.includes(e.replace(h.sc.home, "~")))) h.e.refuseWith("ember.path", "safety");
  if (/\bember:/i.test(code)) h.e.refuseWith("ember.url", "input");
  if (/keystroke|key code|\bclick\b|system events|sendkeys/i.test(code)) h.e.refuseWith("ember.input", "input");
}

reg(NATIVE, Object.keys(INTERPRETERS).filter(k => !["awk", "gawk", "mawk", "nawk"].includes(k)), h => {
  const spec = INTERPRETERS[h.key];
  const inline = new Set(spec.inline);
  const isNode = h.key === "node" || h.key === "nodejs";
  const p = parseOpts(h.args, {
    shortValue: spec.valueOpts ?? "", stopAtOperand: true,
    longValue: ["eval", "print", "require", "import", "loader", "input-type", "experimental-loader", ...(isNode ? ["run"] : [])],
  });
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
    h.e.readArgs(p.operands, h.sc);
    return;
  }
  if (isNode) {
    for (const r of values(p, "r", "require", "import", "loader", "experimental-loader")) if (r) h.e.usePath(lit(r), "read", h.sc);
    // `node --run <script>` runs a package.json script, judged by its name like `npm run`.
    const run = values(p, "run");
    if (run.length) { for (const r of run) if (r === null) h.e.unclear("unclear.script", "It runs a script Ember can't name."); else nameCheck(h, r); return; }
  }
  const script = p.operands[0];
  if (script) {
    if (/^(deno|bun)$/.test(h.key) && script.v && URL_LIKE.test(script.v)) { h.e.add("escape", "escape.npx", SAYS.downloadsProgram); return; }
    runScript(h, script);
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
  h.e.unclear(`unclear.${h.key.replace(/[^a-z]/g, "") || "keyword"}`, words[h.key] ?? SAYS.unclear);
  // A keyword in front of a command (`then rm x`, `do rm x`): the command after it is classified too.
  if (["then", "elif", "else", "do", "if", "while", "until", "!"].includes(h.key) && h.args.length) h.e.unwrap(h, h.args, h.key);
});
reg(NATIVE, ["read", "mapfile", "readarray"], h => {
  if (h.s.stdin === null && h.key === "read") h.e.unclear("unclear.interactive", SAYS.interactive);
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
  const p = parseOpts(h.args, { shortValue: "uCS", longValue: ["unset", "chdir", "split-string", "default-signal", "ignore-signal", "block-signal"], stopAtOperand: true });
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
  if (h.sc.family === "posix" && h.args.some(a => a.v === "-o" || a.v === "+o") && h.args.length === 1) h.e.add("secret", "secret.env", SAYS.env);
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
  }
});
reg(NATIVE, ["compgen"], h => { if (h.args.some(a => /^-[a-zA-Z]*[ev]/.test(a.v ?? ""))) h.e.add("secret", "secret.env", SAYS.env); });

// The clipboard and the screen (§3.5.4).
reg(NATIVE, ["xclip"], h => { if (h.args.some(a => /^-o(ut)?$/.test(a.v ?? ""))) h.e.add("secret", "secret.clipboard", SAYS.clipboard); else h.e.readArgs(h.args.filter(a => !isOption(a) && !/^(primary|secondary|clipboard|c|p|s)$/i.test(a.v ?? "")), h.sc); });
reg(NATIVE, ["xsel"], h => { if (!h.args.some(a => /^(-[a-zA-Z]*[icd]|--input|--clear|--delete|--append|-a)$/.test(a.v ?? ""))) h.e.add("secret", "secret.clipboard", SAYS.clipboard); });
reg(NATIVE, ["ffmpeg", "avconv"], h => {
  const fIdx = h.args.findIndex((a, k) => a.v === "-f" && /^(x11grab|gdigrab|avfoundation|kmsgrab|fbdev|dshow|ddagrab|lavfi)$/i.test(h.args[k + 1]?.v ?? ""));
  if (fIdx >= 0 && /grab|avfoundation|fbdev|dshow/i.test(h.args[fIdx + 1].v ?? "")) h.e.add("secret", "secret.screen", SAYS.screen);
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
  const p = parseOpts(h.args, {
    shortValue: k === "sudo" || k === "sudoedit" ? "ugpCUTrthD" : k === "doas" ? "uC" : k === "pkexec" ? "u" : "u",
    longValue: ["user", "group", "host", "prompt", "close-from", "other-user", "command-timeout", "role", "type", "chdir", "preserve-env"],
    stopAtOperand: true,
  });
  const other = values(p, "u", "user")[0];
  h.e.add("system", "system.sudo", other && !/^(root|0|#0)$/.test(other) ? `Runs as another user (${other}).` : say, { program: k });
  if (k === "sudoedit" || has(p, "e", "edit")) { objsOf(h, p.operands, "write"); h.e.unclear("unclear.interactive", SAYS.interactive); return; }
  if (has(p, "b", "background")) h.e.add("escape", "escape.background", SAYS.keepsRunning);
  if (has(p, "l", "list", "v", "validate", "k", "reset-timestamp", "K", "remove-timestamp", "V", "version") && p.operands.length === 0) return;
  if (p.operands.length === 0) { h.e.unclear("unclear.interactive", SAYS.interactive); return; }
  const dir = values(p, "D", "chdir")[0];
  h.e.unwrap(h, p.operands, k, dir === undefined ? {} : { cwd: dir === null ? null : resolveTargetPath(dir, { os: h.sc.os, home: h.sc.home ?? "", cwd: h.sc.cwd ?? "" }) });
});

// Wrappers with a known option grammar (§3.4.5).
reg(NATIVE, Object.keys(WRAPPERS), h => {
  const rule = WRAPPERS[h.key];
  if (h.key === "timeout" && (h.sc.os === "win32" || h.sc.family !== "posix")) return;
  if (rule.finding) h.e.add(rule.finding.cls, rule.finding.rule, rule.finding.says);
  if (h.key === "disown") return;
  if (rule.noCommand && h.args.some(a => a.v !== null && rule.noCommand!.test(a.v))) { h.e.readArgs([], h.sc); return; }
  const p = parseOpts(h.args, { shortValue: rule.shortValue ?? "", longValue: rule.longValue ?? [], stopAtOperand: true });
  let rest = p.operands;
  if (h.key === "nice" && h.args[0]?.v && /^-\d+$/.test(h.args[0].v)) rest = parseOpts(h.args.slice(1), { stopAtOperand: true }).operands;
  if (h.key === "time" || h.key === "strace" || h.key === "ltrace") for (const o of values(p, "o", "output")) if (o) { const obj = h.e.usePath(lit(o), "write", h.sc); if (obj.abs) h.e.add("destroy", "redirect.overwrite", `Overwrites ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs }); }
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
  const p = parseOpts(h.args, { shortValue: "cEIOBT", longValue: ["command", "echo", "log-in", "log-out", "log-io", "log-timing", "logging-format", "output-limit"] });
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
reg(NATIVE, ["start-stop-daemon", "daemon", "tsp", "pm2", "forever", "supervisord"], h => {
  const sub = lower(h.args[0]);
  if ((h.key === "pm2" || h.key === "forever") && sub && !["start", "restart", "reload", "resurrect", "startup"].includes(sub)) {
    if (["stop", "delete", "kill", "del"].includes(sub)) h.e.add("system", "kill.process", "Stops programs that are running.");
    return;
  }
  h.e.add("escape", `escape.${h.key}`, SAYS.keepsRunning);
});
reg(NATIVE, ["bg"], h => { h.e.add("escape", "escape.background", SAYS.keepsRunning); });
reg(NATIVE, ["at", "batch", "atq", "atrm"], h => {
  if (h.key === "atq") return;
  if (h.key === "atrm") { h.e.add("system", "system.schedule", "Schedules something to run later or at login."); return; }
  if (h.args.some(a => a.v === "-l" || a.v === "-c")) return;
  h.e.add("system", "system.schedule", "Schedules something to run later or at login.");
  h.e.add("escape", "escape.schedule", SAYS.keepsRunning);
});
reg(NATIVE, ["crontab"], h => {
  if (h.args.length === 1 && h.args[0].v === "-l") return;
  if (h.args.some(a => a.v === "-e")) h.e.unclear("unclear.interactive", SAYS.interactive);
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
  if (h.args.some(a => /^ext::/i.test(a.v ?? ""))) h.e.unclear("unclear.git-ext", "It runs a program named in a git address.");
  const rest = h.args.slice(g.verbAt + 1);
  const gh: H = { ...h, sc, args: rest };
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
git(["fetch", "pull", "ls-remote"], h => {
  if (h.args.some(a => /^--(upload-pack|exec)(=|$)/.test(a.v ?? ""))) h.e.unclear("unclear.git-receive-pack", "It runs a program Ember can't see.");
  h.e.readArgs(h.args.filter(a => !isOption(a)), h.sc);
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
  if (has(p, "hard")) h.e.add("destroy", "git.reset.hard", "Throws away changes that aren't committed.", { objects, program: "git reset" });
  if (has(p, "merge")) h.e.add("destroy", "git.reset.merge", "Throws away changes that aren't committed.", { objects, program: "git reset" });
  if (has(p, "keep")) h.e.add("destroy", "git.reset.keep", "Throws away changes that aren't committed.", { objects, program: "git reset" });
});

git(["checkout"], h => {
  const p = opts(h, { shortValue: "bB", longValue: ["orphan", "conflict", "pathspec-from-file", "track"] });
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
  const p = opts(h, { shortValue: "cC", longValue: ["create", "force-create", "orphan", "conflict", "track"] });
  if (has(p, "discard-changes", "f", "force") || values(p, "C", "force-create").length) h.e.add("destroy", "git.switch", "Throws away uncommitted changes.", { program: "git switch" });
});

git(["branch"], h => {
  const p = opts(h, { shortValue: "tu", longValue: ["set-upstream-to", "contains", "no-contains", "merged", "no-merged", "points-at", "sort", "format", "color", "column", "track"] });
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
  const p = opts(h, { shortValue: "umF", longValue: ["local-user", "message", "file", "sort", "format", "contains", "no-contains", "points-at", "merged", "no-merged", "color", "column", "cleanup", "create-reflog"] });
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
  const p = opts(h, { shortValue: "f", longValue: ["file", "blob", "type", "default", "comment", "value", "fixed-value"] });
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
    if (has(p, "system")) h.e.add("system", "git.config.system", "Changes settings for every user.", { program: "git config" });
    for (const f of values(p, "f", "file")) if (f) h.e.usePath(lit(f), "write", h.sc);
  } else if (key !== null && /^credential\./i.test(key)) h.e.add("secret", "secret.git-credential", SAYS.secrets, { program: "git config" });
});
git(["submodule"], h => {
  if (h.args[0]?.v !== "foreach") { h.e.readArgs(h.args.slice(1).filter(a => !isOption(a)), h.sc); return; }
  const rest = h.args.slice(1).filter(a => !/^--(recursive|quiet)$/.test(a.v ?? "") && a.v !== "-q");
  if (rest.some(a => a.v === null)) { h.e.unclear("unclear.shell-text", "It runs shell text Ember can't see."); return; }
  h.e.nested(rest.map(a => a.v).join(" "), "sh", h.sc, "git submodule foreach");
});
// `git grep` is the grep family, so its -O/--open-files-in-pager runs a program on the matches, like rg's --pre (review #165).
git(["grep"], h => { NATIVE["git-grep"]({ ...h, key: "git-grep", prog: "git grep" }); });
git(["bisect"], h => { if (h.args[0]?.v === "run") h.e.payload(h.args.slice(1), h.sc, "git bisect run"); });
git(["rebase"], h => {
  const p = opts(h, { shortValue: "xsX", longValue: ["exec", "onto", "strategy", "strategy-option", "gpg-sign", "whitespace", "empty"] });
  if (has(p, "i", "interactive", "edit-todo")) h.e.unclear("unclear.interactive", SAYS.interactive);
  for (const x of values(p, "x", "exec")) {
    if (x === null) h.e.unclear("unclear.shell-text", "It runs shell text Ember can't see.");
    else h.e.nested(x, "sh", h.sc, "git rebase --exec");
  }
});
git(["commit"], h => {
  const p = opts(h, { shortValue: "mFCcutS", longValue: ["message", "file", "reuse-message", "reedit-message", "fixup", "squash", "author", "date", "template", "cleanup", "trailer", "untracked-files", "pathspec-from-file", "gpg-sign"] });
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
  const name = dir?.v ?? (url?.v ? url.v.replace(/[\\/]+$/, "").split(/[\\/:]/).pop()?.replace(/\.git$/, "") ?? null : null);
  if (dir) h.e.usePath(dir, "write", h.sc);
  h.e.download(name, h.sc);
});
git(["archive"], h => {
  const p = opts(h, { shortValue: "o", longValue: ["output", "format", "prefix", "remote", "exec", "add-file", "add-virtual-file"] });
  if (values(p, "exec").length) h.e.unclear("unclear.git-receive-pack", "It runs a program on the other computer Ember can't see.");
  for (const o of values(p, "o", "output")) if (o) { const obj = h.e.usePath(lit(o), "write", h.sc); if (obj.abs) h.e.add("destroy", "redirect.overwrite", `Overwrites ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs }); }
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
  if (group === "release" && sub === "download") { h.e.download(".", h.sc); return; }
  if (group === "repo" && sub === "clone") { const [r, d] = rest.filter(a => !isOption(a)).slice(1); h.e.download(d?.v ?? r?.v?.split("/").pop() ?? null, h.sc); return; }
  if (group === "repo" && sub === "deploy-key" && rest.some(a => a.v === "delete")) { h.e.add("remote-delete", "gh.repo.deploy-key", "Deletes a deploy key on GitHub."); return; }
  if ((GH_DELETE[group] ?? []).includes(sub)) {
    h.e.add("remote-delete", `gh.${group}.delete`, `Deletes ${what} on GitHub.`, { program: `gh ${group} ${sub}`, objects, widening });
    return;
  }
  if ((GH_WRITE[group] ?? []).includes(sub)) {
    const p = parseOpts(rest, { shortValue: "BHRtbFTlamr", longValue: ["base", "head", "repo", "title", "body", "body-file", "label", "assignee", "milestone", "reviewer", "project", "template", "match-head-commit", "subject", "author-email"] });
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
    const p = parseOpts(rest, { shortValue: "euwd", longValue: ["env", "user", "workdir", "detach-keys", "env-file"], stopAtOperand: true });
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
function containerRun(h: H, prog: string, rest: Arg[]): void {
  const p = parseOpts(rest, {
    shortValue: "eupvwlchmaP", stopAtOperand: true,
    longValue: ["env", "user", "publish", "volume", "workdir", "label", "cpu-shares", "hostname", "memory", "attach", "name", "network", "net", "mount", "entrypoint", "env-file", "device", "cap-add", "cap-drop", "pid", "ipc", "userns", "security-opt", "platform", "restart", "runtime", "add-host", "dns", "log-driver", "log-opt", "ulimit", "tmpfs", "gpus", "pull", "cidfile", "cgroupns", "uts", "volumes-from", "group-add", "health-cmd", "stop-signal", "storage-opt", "sysctl", "isolation", "init-path", "shm-size"],
  });
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
    if (sub === "run") containerMounts(h, parseOpts(rest.slice(at + 1), { shortValue: "eluvwp", longValue: ["env", "env-from-file", "label", "user", "volume", "workdir", "publish", "name", "entrypoint", "cap-add", "cap-drop"], stopAtOperand: true }));
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
  if (verbs.includes("?")) { h.e.unclear("unclear.cloud-verb", "Ember can't tell which command this runs."); return; }
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

function languageInstall(h: H, specs: Arg[], widening: string[] = []): void {
  const objects = packageObjects(h, specs);
  h.e.add("system", "pkg.language", "Installs packages (they can run their own setup code).", { objects, widening, program: `${h.prog} ${h.args.find(a => !isOption(a))?.v ?? ""}`.trim() });
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
    else nameCheck(h, name);
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
  const global = g.opts.some(o => o.name === "-g" || o.name === "--global") || rest.some(a => a.v === "-g" || a.v === "--global" || a.v === "--location=global");
  const widening = global ? ["--global"] : [];
  if (verbArg && verb === null) { h.e.unclear("unclear.npm-verb", "Ember can't tell which command this runs."); return; }
  if (verb === null) { if (h.key === "yarn") languageInstall(h, []); return; }
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
      return;
    }
    case "exec": case "x": case "dlx": case "create": h.e.add("escape", "escape.npx", SAYS.downloadsProgram); return;
    case "init": case "innit":
      if (specs.length) h.e.add("escape", "escape.npx", SAYS.downloadsProgram);
      else if (!rest.some(a => /^(-y|--yes|-f|--force)$/.test(a.v ?? ""))) h.e.unclear("unclear.interactive", SAYS.interactive);
      return;
    case "config": case "c": case "set":
      if (/^(set|delete|edit|fix)$/.test(specs[0]?.v ?? "") || verb === "set") {
        if (global || rest.some(a => a.v === "--location=global" || a.v === "--global")) h.e.add("system", "npm.config.global", "Changes settings for every user.");
        if (specs[0]?.v === "edit") h.e.unclear("unclear.interactive", SAYS.interactive);
      }
      return;
    case "cache": if (/^(clean|clear|rm|delete|prune)$/.test(specs[0]?.v ?? "")) h.e.add("destroy", "npm.cache", "Deletes the package manager's cache."); return;
    case "workspace": if (h.key === "yarn" && specs.length >= 2) { const inner: H = { ...h, args: specs.slice(1) }; NATIVE.yarn(inner); } return;
    case "workspaces": if (h.key === "yarn" && yarnWorkspaces(h, rest)) return; break;
    case "exec-file": return;
    default: break;
  }
  const builtins = new Set(["test", "t", "tst", "start", "stop", "restart", "build", "pack", "version", "ls", "list", "outdated", "view", "info", "show", "search", "help", "doctor", "ping", "prefix", "root", "bin", "why", "explain", "fund", "audit", "diff", "query", "sbom", "completion", "edit", "explore", "repo", "docs", "bugs", "home", "shrinkwrap", "find-dupes", "pkg", "stars", "star", "unstar", "hook", "profile", "help-search", "licenses", "store", "env", "setup", "--version", "-v", "workspaces", "constraints", "dedupe"]);
  if (h.key === "npm" && !builtins.has(verb) && !/^(test|start|stop|restart)$/.test(verb)) { h.e.unclear("unclear.npm-verb", "Ember can't tell which npm command this runs."); return; }
  if (verb === "edit" || verb === "explore") { h.e.unclear("unclear.interactive", SAYS.interactive); return; }
  if (verb === "star" || verb === "unstar" || verb === "hook" || verb === "profile") { h.e.add("publish", "npm.registry", "Changes something on the registry."); return; }
  if (h.key !== "npm" && !builtins.has(verb)) nameCheck(h, verb);
  else if (/^(test|start|stop|restart)$/.test(verb)) nameCheck(h, verb);
});
reg(NATIVE, ["npx", "pnpx", "bunx", "uvx", "yarnpkg-dlx"], h => { h.e.add("escape", "escape.npx", SAYS.downloadsProgram); });

function pip(h: H): void {
  const g = globals(h, "pip");
  checkGlobals(h, "pip", g);
  const verb = h.args[g.verbAt]?.v ?? null;
  const rest = h.args.slice(g.verbAt + 1);
  if (verb === "install" || verb === "uninstall") {
    const p = parseOpts(rest, { shortValue: "rcetbi", longValue: ["requirement", "constraint", "editable", "target", "build", "index-url", "extra-index-url", "find-links", "platform", "python-version", "implementation", "abi", "root", "prefix", "src", "upgrade-strategy", "config-settings", "global-option", "install-option", "progress-bar", "report", "only-binary", "no-binary"] });
    for (const r of values(p, "r", "requirement", "c", "constraint")) if (r) h.e.usePath(lit(r), "read", h.sc);
    // The folders it installs into (review #169).
    for (const d of values(p, "t", "target", "root", "prefix", "src")) if (d) writeInto(h, d);
    const editable = values(p, "e", "editable").map(v => (v === null ? { v: null, raw: "?", glob: false } : lit(v)));
    const reqs = values(p, "r", "requirement").map(r => ({ kind: "path" as const, text: r ?? "?", abs: null }));
    const objects = [...packageObjects(h, [...p.operands, ...editable]), ...reqs];
    if (values(p, "index-url", "extra-index-url", "i", "find-links").length) h.e.add("escape", "pkg.off-registry", "Installs a package from a URL, a git repository or a file; its setup code runs.");
    h.e.add("system", "pkg.language", "Installs packages (they can run their own setup code).", { objects, widening: has(p, "user") ? [] : [], program: `pip ${verb}` });
    return;
  }
  if (verb === "config" && rest.some(a => a.v === "--global")) h.e.add("system", "pip.config.global", "Changes settings for every user.");
  if (verb === "download" || verb === "wheel") {
    // The folder it saves into (review #169).
    const p = parseOpts(rest, { shortValue: "rcdwi", longValue: ["requirement", "constraint", "dest", "wheel-dir", "index-url", "extra-index-url", "find-links", "platform", "python-version", "implementation", "abi", "src"] });
    for (const d of values(p, "d", "dest", "w", "wheel-dir")) if (d) writeInto(h, d);
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
    const p = parseOpts(rest, { shortValue: "np", longValue: ["name", "prefix", "with", "python", "directory", "project", "env", "group", "extra", "package"], stopAtOperand: true });
    if (h.key === "uv" && values(p, "with").length) h.e.add("escape", "escape.npx", SAYS.downloadsProgram);
    h.e.payload(p.operands, h.sc, `${h.key} ${verb}`);
    return;
  }
  if ((h.key === "pipx" && verb === "run") || (h.key === "uv" && verb === "tool" && specs[0]?.v === "run") || (h.key === "deno" && verb === "run" && specs.some(a => URL_LIKE.test(a.v ?? ""))) || (h.key === "rye" && verb === "tools" && specs[0]?.v === "run")) {
    h.e.add("escape", "escape.npx", SAYS.downloadsProgram);
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
  if (verb === "install" || verb === "get") { languageInstall(h, rest.filter(a => !isOption(a))); return; }
  if (verb === "run" && rest.some(a => /@/.test(a.v ?? "") && !isOption(a))) { h.e.add("escape", "escape.npx", SAYS.downloadsProgram); return; }
  if (verb === "run") { const s = rest.find(a => !isOption(a)); if (s) runScript(h, s); return; }
  if (verb === "clean" && rest.some(a => /^-(cache|modcache|testcache|fuzzcache)$/.test(a.v ?? ""))) h.e.add("destroy", "script.destroy", "Runs clean, whose name says it deletes things.");
  // build and test -c write the program where -o says, a file or a folder (review #169).
  if (verb === "build" || verb === "test") {
    for (let k = 0; k < rest.length; k++) {
      const m = /^--?o(=([\s\S]*))?$/.exec(rest[k].v ?? "");
      if (!m) continue;
      const o = m[1] !== undefined ? m[2] : rest[k + 1]?.v;
      if (o === null || o === undefined) h.e.add("destroy", "redirect.overwrite", "Writes to a file Ember can't name.");
      else if (!NULL_SINKS.has(o.toLowerCase())) h.e.usePath(lit(o), "write", h.sc);
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
/** Task runners and package scripts (§3.5.9): their targets' names say what they do. */
reg(NATIVE, ["make", "gmake", "mingw32-make", "nmake", "just", "rake", "invoke", "inv", "ant", "sbt", "lein", "gradle", "gradlew", "mvn", "mvnw", "nox", "tox", "task", "mage", "ninja"], h => {
  const valueShort: Record<string, string> = { make: "CfIjloWE", gmake: "CfIjloWE", "mingw32-make": "CfIjloWE", nmake: "fX", just: "fd", rake: "fIrRCeEp", gradle: "pbcgIxDP", gradlew: "pbcgIxDP", mvn: "fsplDPTtbgrX", mvnw: "fsplDPTtbgrX", nox: "sfeptkr", tox: "ecvrnx", task: "dt", ant: "fDl", ninja: "Cfjkldtw" };
  const p = parseOpts(h.args, { shortValue: valueShort[h.key] ?? "", longValue: ["file", "makefile", "directory", "include-dir", "jobs", "load-average", "old-file", "what-if", "justfile", "working-directory", "set", "project-dir", "build-file", "settings-file", "gradle-user-home", "init-script", "exclude-task", "projects", "resume-from", "settings", "global-settings", "session", "sessions", "keywords", "environment", "envlist", "taskfile", "dir"] });
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
  // make: `--eval` and variable overrides that name a shell or hold command text run code Ember can't see in the
  // makefile's recipes (`make SHELL='rm -rf ~' build`, `make CC='sh -c …'`).
  if (/make$/.test(h.key)) {
    if (has(p, "eval") || values(p, "E").length || h.args.some(a => /^--eval/.test(a.v ?? ""))) h.e.unclear("unclear.make-eval", "It adds make rules Ember can't see.");
    for (const a of p.operands) {
      const m = a.v === null ? null : /^([A-Za-z_.][A-Za-z0-9_.]*)\s*[:+?!]?=(.*)$/s.exec(a.v);
      if (a.v !== null && !m) continue;
      if (a.v === null || /^(\.?SHELL|\.SHELLFLAGS|MAKESHELL|MAKEFLAGS|MFLAGS|GNUMAKEFLAGS|MAKEFILES|\.RECIPEPREFIX)$/.test(m![1]) || /[$`;|&<>()\n"']/.test(m![2]) || /^\s*(sh|bash|zsh|dash|ksh|fish|python\d*(\.\d+)?|perl|ruby|node|env|eval|exec|busybox|xargs)(\s|$)/.test(m![2])) {
        h.e.unclear("unclear.make-variable", "It sets a make variable to text that could run as a command.");
      }
    }
  }
  if (h.key === "rake" && (values(p, "e", "p", "E").length || has(p, "execute", "execute-print", "execute-continue"))) h.e.unclear("unclear.inline-code", "It runs code given on the command line.");
  let targets = p.operands.filter(a => a.v === null || !/^[A-Za-z_][A-Za-z0-9_.]*=/.test(a.v));
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

/** The host of a URL or `user@host:path`. */
function hostOf(s: string): string {
  const u = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?(\[[^\]]+\]|[^/:?#]+)/i.exec(s);
  if (u) return u[1];
  const scp = /^(?:[^@/]+@)?([^:/]+):/.exec(s);
  return scp ? scp[1] : s;
}

reg(NATIVE, ["curl", "curl.exe"], h => {
  const p = opts(h, {
    shortValue: "AbcCdeEFHKmoPrtTuUwXxyYzD",
    longValue: ["data", "data-raw", "data-binary", "data-urlencode", "data-ascii", "json", "form", "form-string", "upload-file", "request", "header", "user", "output", "cookie", "cookie-jar", "config", "url", "proxy", "user-agent", "referer", "max-time", "connect-timeout", "retry", "cacert", "cert", "key", "pass", "oauth2-bearer", "aws-sigv4", "output-dir", "write-out", "dump-header", "trace", "trace-ascii", "stderr", "resolve", "interface", "limit-rate", "range", "max-filesize", "proto", "proxy-user", "netrc-file", "unix-socket", "abstract-unix-socket", "ciphers", "variable", "expand-data", "time-cond", "continue-at", "retry-delay", "retry-max-time", "speed-limit", "speed-time", "local-port", "dns-servers", "doh-url", "preproxy", "hsts", "alt-svc", "etag-save", "etag-compare", "krb", "login-options", "sasl-authzid", "service-name", "mail-from", "mail-rcpt", "mail-auth"],
  });
  const urls = [...p.operands.map(a => a.v ?? ""), ...values(p, "url").map(v => v ?? "")].filter(u => u !== "");
  const host = hostOf(urls[0] ?? "") || "another computer";
  for (const u of urls) if (/^file:/i.test(u)) h.e.usePath(lit(decodeURIComponent(u.replace(/^file:\/\/(localhost)?/i, ""))), "read", h.sc);
  if (values(p, "K", "config").length) h.e.unclear("unclear.curl-config", "It reads its options from a file Ember can't see.");
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
  const outputs = values(p, "o", "output");
  for (const o of outputs) {
    if (o === null) { h.e.add("destroy", "redirect.overwrite", "Writes to a file Ember can't name."); continue; }
    if (o === "-") continue;
    const path = outDir ? `${outDir}/${o}` : o;
    const obj = h.e.usePath(lit(path), "write", h.sc);
    if (obj.abs) h.e.add("destroy", "download.output", `Overwrites ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs });
    h.e.download(path, h.sc);
  }
  if (has(p, "O", "remote-name", "remote-name-all")) {
    for (const u of urls) {
      const name = u.replace(/[?#].*$/, "").split("/").pop();
      if (!name) continue;
      const path = outDir ? `${outDir}/${name}` : name;
      const obj = h.e.usePath(lit(path), "write", h.sc);
      if (obj.abs) h.e.add("destroy", "download.output", `Overwrites ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs });
      h.e.download(path, h.sc);
    }
  }
  for (const f of values(p, "c", "cookie-jar", "D", "dump-header", "trace", "trace-ascii", "stderr", "etag-save", "hsts", "alt-svc")) if (f && f !== "-") h.e.usePath(lit(f), "write", h.sc);
});
reg(NATIVE, ["wget", "wget2"], h => {
  const p = opts(h, {
    shortValue: "OoaPiBtTwQeUlAIRDXlY",
    longValue: ["output-document", "output-file", "append-output", "directory-prefix", "input-file", "base", "tries", "timeout", "wait", "quota", "execute", "user-agent", "level", "accept", "reject", "include-directories", "exclude-directories", "domains", "exclude-domains", "post-data", "post-file", "method", "body-data", "body-file", "header", "user", "password", "http-user", "http-password", "ftp-user", "ftp-password", "load-cookies", "save-cookies", "certificate", "private-key", "ca-certificate", "config", "referer", "limit-rate", "restrict-file-names", "default-page", "bind-address", "proxy-user", "proxy-password"],
  });
  const urls = p.operands.map(a => a.v ?? "").filter(u => u);
  const host = hostOf(urls[0] ?? "") || "another computer";
  const method = (values(p, "method")[0] ?? "").toUpperCase();
  for (const f of values(p, "post-file", "body-file", "i", "input-file", "load-cookies", "certificate", "private-key")) if (f && f !== "-") h.e.usePath(lit(f), "read", h.sc);
  if (values(p, "post-data", "post-file", "body-data", "body-file").length || /^(POST|PUT|PATCH|DELETE)$/.test(method)) h.e.add("publish", "send.http", `Sends data to ${host}.`, { objects: [{ kind: "host", text: host, abs: null }], program: "wget" });
  if (values(p, "e", "execute").length) h.e.unclear("unclear.wget-execute", "It runs settings Ember can't see.");
  if (h.args.some(a => /^--use-askpass/.test(a.v ?? ""))) h.e.unclear("unclear.wget-askpass", "It runs a program Ember can't see.");
  if (values(p, "config").length) h.e.unclear("unclear.curl-config", "It reads its options from a file Ember can't see.");
  const dir = values(p, "P", "directory-prefix")[0];
  const out = values(p, "O", "output-document")[0];
  if (out !== undefined) {
    if (out === null) h.e.add("destroy", "redirect.overwrite", "Writes to a file Ember can't name.");
    else if (out !== "-") {
      const obj = h.e.usePath(lit(out), "write", h.sc);
      if (obj.abs) h.e.add("destroy", "download.output", `Overwrites ${obj.text} if it exists.`, { objects: [obj], ifExists: obj.abs });
      h.e.download(out, h.sc);
    }
  } else {
    // The folder it saves into (-P) and each file by the name its address ends in meet §3.6's rules, Ember's own files
    // included (review #169); wget may pick another name (a redirect, -r's folders), so the folder is judged too.
    if (dir === null) h.e.add("destroy", "redirect.overwrite", "Writes to a file Ember can't name.");
    else if (dir !== undefined) writeInto(h, dir);
    for (const u of urls) {
      const name = u.replace(/[?#].*$/, "").split("/").pop() || "index.html";
      saveAs(h, dir ? `${dir}/${name}` : name);
    }
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
  const dir = h.key === "aria2c" ? values(p, "d", "dir")[0] : undefined;
  if (dir === null) h.e.add("destroy", "redirect.overwrite", "Writes to a file Ember can't name.");
  else if (dir !== undefined) writeInto(h, dir);
  const at = (name: string): string => (dir ? `${dir}/${name}` : name);
  const named = (u: Arg): string | null => (u.v ? u.v.replace(/[?#].*$/, "").split("/").pop() || "index.html" : null);
  const outs = values(p, "o", "out", "output");
  for (const o of outs) {
    if (o === null) h.e.add("destroy", "redirect.overwrite", "Writes to a file Ember can't name.");
    else if (o !== "-") saveAs(h, at(o));
  }
  if (h.key === "lwp-download" && p.operands.length >= 2) {
    const [url, to] = p.operands;
    if (to.v === null) { h.e.add("destroy", "redirect.overwrite", "Writes to a file Ember can't name."); return; }
    saveAs(h, to.v);
    // A folder gets the file by the address's name.
    const name = named(url);
    if (name) h.e.usePath(lit(`${to.v.replace(/[\\/]+$/, "")}/${name}`), "write", h.sc);
    return;
  }
  if (outs.length === 0) for (const u of p.operands) { const name = named(u); if (name) saveAs(h, at(name)); }
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
  const p = parseOpts(h.args, { shortValue: "BbcDEeFIiJLlmOoPpQRSWwM", stopAtOperand: true });
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
});
reg(NATIVE, ["rsync"], h => {
  const p = opts(h, {
    shortValue: "eBfTM",
    longValue: ["rsh", "rsync-path", "exclude", "include", "filter", "files-from", "exclude-from", "include-from", "password-file", "log-file", "log-file-format", "backup-dir", "compare-dest", "copy-dest", "link-dest", "temp-dir", "partial-dir", "chmod", "chown", "usermap", "groupmap", "timeout", "contimeout", "port", "address", "sockopts", "bwlimit", "max-size", "min-size", "max-delete", "modify-window", "suffix", "out-format", "info", "debug", "checksum-choice", "compress-choice", "skip-compress", "outbuf", "stop-after", "stop-at", "write-batch", "read-batch", "only-write-batch", "iconv", "remote-option", "block-size", "protocol", "early-input", "mkpath"],
  });
  for (const e of values(p, "e", "rsh")) if (e === null || !/^ssh(\s+-[A-Za-z]+(\s+[A-Za-z0-9._/~-]+)?)*$/.test(e)) h.e.unclear("unclear.rsync-rsh", "It runs a remote shell command Ember can't see.");
  if (values(p, "rsync-path", "remote-option", "M").length) h.e.unclear("unclear.rsync-rsh", "It runs a command on the other computer Ember can't see.");
  for (const f of values(p, "password-file", "files-from", "exclude-from", "include-from", "read-batch")) if (f) h.e.usePath(lit(f), "read", h.sc);
  for (const f of values(p, "log-file", "write-batch", "only-write-batch")) if (f) h.e.usePath(lit(f), "write", h.sc);
  const ops = p.operands;
  if (ops.length < 2) return;
  const dest = ops[ops.length - 1];
  const sources = ops.slice(0, -1);
  const remote = (a: Arg): boolean => a.v !== null && (/^rsync:\/\//i.test(a.v) || (SCP_LIKE.test(a.v) && !/^[A-Za-z]:[\\/]/.test(a.v)) || /::/.test(a.v));
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
  if (sources.some(remote)) h.e.download(dest.v, h.sc);
  const srcObjs = objsOf(h, sources.filter(s => !remote(s)), removeSrc ? "move" : "readTree");
  if (deletes) h.e.add("destroy", "posix.rsync", `Deletes files in ${destObj.text} that aren't in ${listOf(srcObjs, "the source")}.`, { objects: [destObj] });
  if (removeSrc) h.e.add("destroy", "posix.rsync", `Deletes ${listOf(srcObjs)} after copying.`, { objects: srcObjs });
  if (destObj.abs) h.e.add("destroy", "posix.rsync", `Replaces ${destObj.text} if it exists.`, { objects: [destObj], ifExists: destObj.abs });
});
reg(NATIVE, ["rclone"], h => {
  const verb = firstOperand(h.args).v ?? "";
  const ops = h.args.filter(a => !isOption(a)).slice(1).map(a => a.v ?? "");
  const remote = (s: string): boolean => /^[A-Za-z0-9_.-]+:/.test(s) && !/^[A-Za-z]:[\\/]/.test(s);
  if (/^(config|password|obscure|authorize)$/.test(verb)) { h.e.add("secret", "secret.program", SAYS.secrets); return; }
  if (/^(delete|purge|deletefile|rmdir|rmdirs|cleanup|dedupe)$/.test(verb)) { h.e.add(ops.some(remote) ? "remote-delete" : "destroy", ops.some(remote) ? "cloud.delete" : "posix.rm", "Deletes files."); return; }
  if (/^(copy|copyto|sync|move|moveto|copyurl|bisync|rcat|mkdir|touch|settier|link)$/.test(verb)) {
    if (remote(ops[ops.length - 1] ?? "")) {
      h.e.add("publish", "upload.rclone", `Sends data to ${ops[ops.length - 1].split(":")[0]}.`);
      if (verb === "sync" || verb === "bisync") h.e.add("remote-delete", "rsync.delete-remote", "Deletes files on the other side that aren't here.");
    } else if (verb === "sync") h.e.add("destroy", "posix.rsync", "Deletes files here that aren't on the other side.");
    if ((verb === "move" || verb === "moveto") && ops.slice(0, -1).some(remote)) h.e.add("remote-delete", "cloud.delete", "Deletes the files it moves from the other side.");
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
reg(NATIVE, ["busybox"], h => {
  if (lower(h.args[0]) !== "httpd") { generic(h); return; }
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
  const q = parseOpts(h.args, {
    shortValue: "ipacdtq",
    longValue: ["interfaces", "port", "auth", "auth-file", "color-scheme", "color-scheme-dark", "title", "header", "index", "route-prefix", "tls-cert", "tls-key", "qrcode"],
  });
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
  const p = opts(h, { shortValue: "aCEfFIJjKmMnNOrstVwYzZbD", longValue: [] });
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
});
reg(NATIVE, ["uniq", "guniq"], h => {
  const p = opts(h, { shortValue: "fsw", longValue: ["skip-fields", "skip-chars", "check-chars", "group", "all-repeated"] });
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
  const p = opts(h, { shortValue: "pioDdBFrVYzg", longValue: ["strip", "input", "output", "directory", "ifdef", "prefix", "fuzz", "reject-file", "version-control", "basename-prefix", "suffix", "get", "quoting-style", "merge"] });
  let sc = h.sc;
  const dir = values(p, "d", "directory")[0];
  if (dir !== undefined) sc = child(h.sc, { cwd: dir === null ? null : resolveTargetPath(dir, { os: h.sc.os, home: h.sc.home ?? "", cwd: h.sc.cwd ?? "" }) });
  const ph: H = { ...h, sc };
  for (const f of values(p, "i", "input")) if (f) h.e.usePath(lit(f), "read", sc);
  for (const f of values(p, "o", "output", "r", "reject-file")) overwrites(ph, f === null ? { v: null, raw: "?", glob: false } : lit(f));
  const [file, patchFile] = p.operands;
  // The file it changes: an edit inside the user's work, judged by §3.6's rules like `sed -i`.
  if (file) h.e.usePath(file, "write", sc);
  if (patchFile) h.e.usePath(patchFile, "read", sc);
});
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
  if (h.key === "nmcli" && a.some(x => x === "-s" || x === "--show-secrets")) h.e.add("secret", "secret.program", SAYS.secrets);
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
  const p = opts(h, { shortValue: "sgGPtuUnoFeOy", longValue: ["signal", "pgroup", "group", "parent", "terminal", "euid", "uid", "session", "ns", "nslist", "pidfile", "older-than", "younger-than", "context"] });
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
    const p = parseOpts(h.args.slice(1), { shortValue: "eopFcCtGa", stopAtOperand: true });
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
  if (src) h.e.usePath(src, flags.some(f => /^\/(move|mov)$/.test(f)) ? "move" : "readTree", h.sc);
  const destObj = dst ? h.e.usePath(dst, flags.some(f => /^\/(mir|purge)$/.test(f)) ? "deleteTree" : "write", h.sc) : null;
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
  if (srcs.length === 0 && psPaths(b, "Path", "LiteralPath").length === 0) objsOf(h, pipedListing(h), kind === "copy" ? "readTree" : "move");
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
  if (/symboliclink|junction|hardlink/.test(type)) for (const t of b.named.get("Value") ?? []) h.e.usePath(t, "read", h.sc);
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
  for (const d of b.named.get("Destination") ?? []) { h.e.usePath(d, "write", h.sc); h.e.download(d.v, h.sc); }
});
reg(CMDLETS, ["write-output", "write-host", "write-information", "write-verbose", "write-warning", "write-error", "write-debug"], h => {
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
  if (destObj.abs === null) { h.e.add("destroy", rule, "Writes to a file Ember can't name.", { objects: [destObj] }); return; }
  if (sw.has("y")) h.e.add("destroy", rule, `Replaces ${destObj.text} if it exists.`, { objects: [destObj], widening: ["/y"] });
  else h.e.add("destroy", rule, `Replaces ${destObj.text} if it exists.`, { objects: [destObj], ifExists: destObj.abs });
}
reg(CMD_BUILTINS, ["copy", "move", "ren", "rename", "xcopy"], h => cmdCopy(h));
reg(CMD_BUILTINS, ["type", "dir", "tree", "more", "find", "findstr", "fc", "comp", "sort", "attrib", "where", "vol", "cls", "ver", "title", "color", "prompt", "pushd", "popd", "exit", "rem", "echo.", "verify", "break", "endlocal", "chcp", "md", "mkdir", "mklink"], h => {
  const { sw, ops } = cmdSwitches(h);
  if (h.key === "md" || h.key === "mkdir") { objsOf(h, ops, "write"); return; }
  if (h.key === "mklink") { if (ops[0]) h.e.usePath(ops[0], "write", h.sc); if (ops[1]) h.e.usePath(ops[1], "read", h.sc); return; }
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
