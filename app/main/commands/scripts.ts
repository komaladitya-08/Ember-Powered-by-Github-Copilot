/**
 * Reading the shell scripts a command runs before it runs (L8, the lead's ruling): each script's text is read from the
 * target and classified as a nested command, so a dangerous script asks and a refusal refuses, and so do the scripts
 * it runs in turn. Used by the PC's flow for this computer and WSL (gate 1), and by the remote agent's gate 2 for SSH,
 * which reads on its own filesystem (the PC can't see the remote's files: L8 holds for gate 1 there).
 *
 * It also closes L8's padding bypass: a script this task wrote or downloaded in an earlier command (or this same
 * command writes, a script inside it included) that can't be read in full (padded past the 64 KiB cap, unreadable,
 * not a regular file) asks, since what it says can't be known first. A script the task didn't write (a repository's
 * 500 KiB ./configure) keeps L8: it runs like a build.
 *
 * Plain Node, no Electron or koffi (the remote agent loads it). Paths follow the target's rules (node:path/posix or
 * node:path/win32 by the target's OS).
 */

import posix from "node:path/posix";
import win32 from "node:path/win32";
import { SAYS, SCRIPT_UNSURE, type ClassificationExtra, type ScriptRef } from "./classify";
import { isUnder, pathEnv, physicalForm, type PathEnv } from "./paths";
import { OTHER_SHELLS, POSIX_SHELLS } from "./tables";
import type { Classification, ClassifyContext, Finding, PathFact, RunnerFacts, ShellId } from "./types";

/** How the flow reads a script's text (L8, the lead's ruling). */
export type ScriptLanguage =
  /** Classify the text in each of these shells (`sh` is dash on some systems and bash on others: both). */
  | { kind: "shells"; shells: ShellId[] }
  /** A shell whose language Ember can't read (fish, csh…): the command asks. */
  | { kind: "unclear"; says: string }
  /** The `#!` line names an interpreter by path that may itself be a script: read that next. */
  | { kind: "follow"; path: string }
  /** Not a shell script (a program, a Python or Node script): today's behaviour (L8) unchanged. */
  | { kind: "none" };

const BOTH_SH: ShellId[] = ["sh", "bash"];

/**
 * How to read a script's text, given how the command runs it (ScriptRef.as). Run directly ("shebang"), the kernel
 * reads the `#!` line (`#!/usr/bin/env -S bash -e` names bash); a text file without one is run by the calling shell
 * (bash and zsh do that when exec says it isn't a program), and one with a NUL in its first line is a program.
 */
export function scriptLanguage(as: ScriptRef["as"], text: string): ScriptLanguage {
  switch (as) {
    case "bash": case "zsh": return { kind: "shells", shells: [as] };
    case "sh": return { kind: "shells", shells: BOTH_SH };
    case "powershell": return { kind: "shells", shells: ["powershell"] };
    case "cmd": return { kind: "shells", shells: ["cmd"] };
    case "shebang": break;
  }
  if (!text.startsWith("#!")) {
    const first = text.slice(0, 80).split("\n")[0];
    return first.includes("\0") ? { kind: "none" } : { kind: "shells", shells: BOTH_SH };
  }
  const words = text.slice(2).split("\n")[0].trim().split(/[ \t]+/);
  let prog = words[0] ?? "";
  const baseOf = (w: string): string => (w.split(/[\\/]/).pop() ?? "").toLowerCase().replace(/\.exe$/, "");
  if (baseOf(prog) === "env") {
    // env's options (-S splits the rest into words, -i, -u NAME) and NAME=value assignments come before the program.
    let k = 1;
    for (; k < words.length; k++) {
      const w = words[k];
      if (/^-[A-Za-z]*S./.test(w)) { words[k] = w.replace(/^-[A-Za-z]*S/, ""); break; }
      if (w === "-u" || w === "--unset" || w === "-C" || w === "--chdir") { k++; continue; }
      if (!w.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) break;
    }
    prog = words[k] ?? "";
  }
  const name = baseOf(prog);
  const posixShell = POSIX_SHELLS[name];
  if (posixShell) return { kind: "shells", shells: posixShell === "sh" ? BOTH_SH : [posixShell] };
  if (name === "pwsh" || name === "powershell") return { kind: "shells", shells: ["powershell"] };
  if (OTHER_SHELLS.has(name)) return { kind: "unclear", says: `It runs a ${name} script, which Ember can't read.` };
  // An interpreter by path (`#!/home/ana/i.sh`, `#!/usr/bin/env ./i.sh`) is followed: a script there runs this one; a
  // program there isn't a script and stops. A bare name env looks up (python3) is an interpreter: L8 unchanged.
  if (prog.includes("/")) return { kind: "follow", path: prog };
  return { kind: "none" };
}

// ---------------------------------------------------------------------------------------------------------------------
// What a task wrote (the padding bypass).

/** What a task's earlier commands wrote on its target, kept for the task's life (like its downloads). */
export interface TaskWrites {
  /** Files and folders written, moved, deleted or unpacked into (a folder covers everything under it). */
  paths: Set<string>;
  /** Something was written where Ember can't tell, or more than it keeps: every script counts as the task's own. */
  anywhere: boolean;
}

/** At most this many paths are kept per task; past that, every script counts as written (fail closed). */
export const MAX_TASK_WRITES = 512;

/** A task's empty record. */
export const newTaskWrites = (): TaskWrites => ({ paths: new Set(), anywhere: false });

/**
 * Notes what a command that started may have written (its classification's `writes`, its scripts' included): any end,
 * a stopped or failed one too, since part of it may have run. A classification that doesn't say (a judge a test
 * passes) changes nothing.
 */
export function noteWrites(w: TaskWrites, cls: Classification): void {
  const x = cls as Partial<ClassificationExtra>;
  if (x.writesAnywhere === true) w.anywhere = true;
  for (const p of Array.isArray(x.writes) ? x.writes : []) {
    if (typeof p !== "string" || p === "") continue;
    if (w.paths.size >= MAX_TASK_WRITES && !w.paths.has(p)) { w.anywhere = true; break; }
    w.paths.add(p);
  }
}

/** The path rules for comparing a target's paths (case-insensitive on Windows, macOS and WSL's drive mounts). */
export function comparePaths(os: ClassifyContext["os"], mountRoot: string | null = null): PathEnv {
  return pathEnv({ flavour: os === "win32" ? "win32" : "posix", os, home: null, cwd: null, mountRoot });
}

/**
 * Folders only root or an administrator can change (not /usr/local, which Homebrew gives the user): a write Ember
 * couldn't place never reaches them unless the shell is root, and then every command asks anyway (D4.6). So `#!/usr/bin/python3`
 * (a program too big to read) isn't taken for the task's own after a checkout.
 */
export function rootOwned(p: string, env: PathEnv): boolean {
  if (env.flavour === "win32") return /^[a-z]:\\(windows|program files|program files \(x86\))(\\|$)/i.test(p);
  if (/^\/usr\/local(\/|$)/i.test(p)) return false;
  if (/^\/(usr|bin|sbin|lib|lib32|lib64|libx32|libexec|System)(\/|$)/i.test(p)) return true;
  const m = env.mountRoot;
  return m !== null && p.toLowerCase().startsWith(`${m.toLowerCase()}/`) && /^\/[a-z]\/(windows|program files|program files \(x86\))(\/|$)/i.test(p.slice(m.length));
}

/**
 * Whether `path` is one of the task's own: written by an earlier command (or under a folder it wrote), or downloaded;
 * or, once the task wrote where Ember couldn't tell, anywhere outside the folders only root changes.
 */
export function taskWrote(path: string, written: TaskWrites | null, downloaded: ReadonlySet<string>, env: PathEnv): boolean {
  if (written?.anywhere && !rootOwned(path, env)) return true;
  for (const w of written?.paths ?? []) if (isUnder(path, w, env)) return true;
  for (const d of downloaded) if (isUnder(path, d, env)) return true;
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
// Judging the scripts.

/** At most this many scripts are read for one command, nested ones included; at most this deep. More asks. */
export const MAX_SCRIPT_READS = 16;
export const MAX_SCRIPT_DEPTH = 4;
/** How long one read or one inspect of a script's paths may take. */
export const SCRIPT_PROBE_MS = 5000;

/** How scripts are read and their paths inspected on the target. */
export interface ScriptIo {
  /** The script's text; null when it can't be read in full (missing, unreadable, not a regular file, too big). */
  read(path: string, cwd: string): Promise<string | null>;
  inspect(paths: string[], cwd: string): Promise<PathFact[]>;
}

/** The classifier (CL's classifyCommand, or a test's). */
export type ScriptClassifier = (text: string, shell: ShellId, ctx: ClassifyContext) => Classification;

/** What judging a command's scripts needs to know about the target and the task. */
export interface ScriptJudgeEnv {
  os: ClassifyContext["os"];
  home: string;
  ember: ClassifyContext["ember"];
  wsl: RunnerFacts["wsl"];
  /** The task's downloads (their scripts are judged with them, and running one is escape). */
  downloaded: ReadonlySet<string>;
  /** What the task's earlier commands wrote; null: not kept (nothing counts as the task's own but its downloads). */
  written: TaskWrites | null;
  /** The command's inspected paths: each script's paths join it (an overwrite of a missing file is dropped later). */
  paths: Map<string, PathFact>;
  /** The task was stopped (Stop, the kill switch), or the check gave up: read no more. */
  isOver: () => boolean;
  /** One read's or inspect's time limit (default SCRIPT_PROBE_MS). */
  probeMs?: number;
  /** All the reading's time limit; once it is spent every script left counts as unreadable (default: none). */
  budgetMs?: number;
  now?: () => number;
}

/** `p`, or `fallback` once `ms` pass or it rejects. */
async function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<T>(resolve => { timer = setTimeout(() => resolve(fallback), Math.max(0, ms)); timer.unref?.(); });
  try {
    return await Promise.race([p.catch(() => fallback), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The classifier reads a POSIX script's if, then, else, for, while, until, do, done and `[[ … ]]` as words it can't
 * follow, though it classifies every command in them (a condition, a loop's body, a substitution in its list) and
 * leaves a variable in a file argument unresolved (which asks): inside a script, these words alone don't make it ask
 * (review #27). case, functions, traps and select still do, and so do PowerShell's and cmd's if and for, whose blocks
 * the classifier doesn't read inside.
 */
const SCRIPT_FLOW = new Set([
  "unclear.if", "unclear.then", "unclear.elif", "unclear.else", "unclear.fi", "unclear.for", "unclear.while", "unclear.until",
  "unclear.do", "unclear.done", "unclear.in", "unclear.keyword",
]);
const POSIX_SCRIPT_SHELLS: ReadonlySet<ShellId> = new Set<ShellId>(["sh", "bash", "zsh"]);

/** The widening that names the script a finding came from (`script:build.sh`): the user's words may name it (intent.ts). */
export const scriptTag = (name: string) => `script:${name}`;

/**
 * The card's line for something in a script Ember can't follow (review #27): "Ember can't read all of build.sh (it has
 * more commands than Ember can check one by one)." rather than "In build.sh: Ember can't tell exactly what this does."
 */
export function unreadPart(name: string, says: string): string {
  const why = says === SAYS.unclear ? "it uses shell syntax Ember doesn't follow" : says.replace(/[.!]+$/, "").replace(/^(It|Its) /, m => m.toLowerCase());
  return `Ember can't read all of ${name} (${why}).`;
}

/** The card's words for a script of the task's own that can't be read in full. */
export const unreadOwnScript = (name: string) => `It runs ${name}, which this task wrote or downloaded, and Ember can't read all of it first.`;
/** The card's words for a script that another part of the same command writes first (as classify's own rule says). */
export const WRITTEN_FIRST = "It runs a script that this command writes first, so Ember can't read it beforehand.";

/**
 * Reads each shell script the command runs and classifies its text as a nested command (L8, the lead's ruling): the
 * script's own refusal, findings, downloads and writes join the command's, and so do those of the scripts it runs in
 * turn. Findings are tagged "in-script" (and say which script) so the user's words for the command never announce a
 * script: every dangerous script asks. A script runs in the command's folder, so its relative paths resolve there.
 * Each script's paths are inspected as the command's are (§3.8.3 step 5: an overwrite of a file that isn't there is
 * dropped, a symbolic link is judged by where it leads), and their facts join `env.paths`.
 *
 * A script that can't be read (missing, unreadable, too big, not a regular file, too slow) or isn't a shell's keeps
 * today's behaviour (L8), unless it is the task's own (written or downloaded by an earlier command): then it asks. A
 * script one part of this command writes (another script included) while another part runs it asks too. With no `io`
 * (a runner that can't read scripts: the PC's side of an SSH target), the command's own classification stands.
 */
export async function judgeScripts(cls: Classification, io: ScriptIo | null, classify: ScriptClassifier, env: ScriptJudgeEnv): Promise<Classification> {
  const outer = cls as Partial<ClassificationExtra>;
  const refs = outer.scripts ?? [];
  if (refs.length === 0 || !io) return withRealPaths(cls, env.paths);
  const flavour = env.os === "win32" ? win32 : posix;
  const cmp = comparePaths(env.os, env.wsl?.mountRoot ?? null);
  const probeMs = env.probeMs ?? SCRIPT_PROBE_MS;
  const now = env.now ?? Date.now;
  const deadline = env.budgetMs === undefined ? Infinity : now() + env.budgetMs;
  const left = () => (deadline === Infinity ? probeMs : Math.min(probeMs, deadline - now()));
  const extra: Finding[] = [];
  const downloads: string[] = [];
  const writes = new Set<string>(outer.writes ?? []);
  let anywhere = outer.writesAnywhere === true;
  /** Each script read: its names (lexical, and real when known) and how deep it runs. */
  type Ran = { names: string[]; depth: number };
  /** What each script's own text writes, by that script: another script it runs may change under it. */
  const inner: { by: Ran; writes: string[]; anywhere: boolean }[] = [];
  const ran: Ran[] = [];
  let refuse = cls.refuse;
  const unclear = (rule: string, says: string, name?: string): void => {
    const widening = name ? ["in-script", scriptTag(name)] : ["in-script"];
    if (!extra.some(f => f.rule === rule && f.says === says)) extra.push({ cls: "unclear", rule, says, program: "", objects: [], widening, at: -1 });
  };
  /** What the target says of one path (asked once; "couldn't tell" when time is up). */
  const factOf = async (p: string, cwd: string): Promise<PathFact> => {
    const known = env.paths.get(p);
    if (known) return known;
    const unknown: PathFact = { exists: null, real: null };
    const ms = left();
    const got = ms > 0 ? (await within(io.inspect([p], cwd), ms, [unknown]))[0] ?? unknown : unknown;
    env.paths.set(p, got);
    return got;
  };
  const queue = refs.map(ref => ({ ref, depth: 1 }));
  const seen = new Set<string>();
  let reads = 0;
  while (queue.length > 0 && !env.isOver()) {
    const { ref, depth } = queue.shift()!;
    const key = `${ref.as}\0${ref.path}\0${ref.open ?? ""}\0${ref.cwd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (depth > MAX_SCRIPT_DEPTH || ++reads > MAX_SCRIPT_READS) {
      unclear("unclear.scripts", "It runs more scripts, or scripts deeper inside scripts, than Ember reads first.");
      break;
    }
    const folder = ref.cwd || flavour.dirname(ref.path);
    // A name with a `..` the kernel walks through links (an interpreter's `#!` path, or a ref the classifier made before
    // the target answered) is the file at the real path the target reports for it; without that, which file runs
    // can't be told, and it asks (L25).
    let where = ref.real ?? null;
    if (ref.open !== undefined && where === null) {
      where = (await factOf(ref.open, folder)).real;
      if (where === null) { unclear("unclear.script-path", SCRIPT_UNSURE, flavour.basename(ref.path)); continue; }
    }
    const me: Ran = { names: where !== null && where !== ref.path ? [ref.path, where] : [ref.path], depth };
    ran.push(me);
    const name = flavour.basename(ref.path);
    const ms = left();
    // Read by the name the shell opens (`open`, `..` kept), so the text is the file that runs; never by `real`, which a
    // target may report changed (`$(realpath …)` drops a name's trailing line breaks).
    const raw = ms > 0 ? await within(io.read(ref.open ?? ref.path, folder), ms, null) : null;
    if (typeof raw !== "string") {
      // Padded past the cap, a FIFO, unreadable: L8 for a script the task didn't write; its own asks, unless the target
      // says nothing is there (PowerShell's `.\t` names t.bat and t.cmd too; a file this same command makes asks anyway).
      // Its own by any of its names: a write through a link (`> l/t.sh`, l → .) is remembered where it landed too.
      const own = (p: string | null): boolean => p !== null && taskWrote(p, env.written, env.downloaded, cmp);
      if (own(ref.path) || own(where) || (env.written?.paths.size ?? 0) > 0 || env.downloaded.size > 0) {
        const fact = await factOf(ref.open ?? ref.path, folder);
        if (fact.exists !== false && (own(ref.path) || own(where) || own(fact.real))) unclear("unclear.script-unread", unreadOwnScript(name), name);
      }
      continue;
    }
    if (raw === "") continue;
    // PowerShell skips a byte order mark; a POSIX shell or cmd reads it as part of the first word (it stays, and asks).
    const text = ref.as === "powershell" ? raw.replace(/^\uFEFF/, "") : raw;
    const lang = scriptLanguage(ref.as, text);
    if (lang.kind === "none") continue;
    if (lang.kind === "unclear") { unclear("unclear.other-shell", lang.says, name); continue; }
    if (lang.kind === "follow") {
      // A relative interpreter is found from the folder the command runs in.
      if (!flavour.isAbsolute(lang.path) && !ref.cwd) { unclear("unclear.script", "It runs a script Ember can't name."); continue; }
      const path = flavour.isAbsolute(lang.path) ? lang.path : flavour.join(ref.cwd, lang.path);
      // The kernel opens the interpreter by its name as written: a `..` in it is walked through links (and a leading `~`
      // is a folder named `~`: the kernel expands nothing).
      const open = env.os === "win32" ? null : physicalForm(lang.path.startsWith("~") ? `./${lang.path}` : lang.path, { os: env.os, home: "", cwd: ref.cwd });
      queue.push({ ref: { path, as: "shebang", cwd: ref.cwd, ...(open !== null ? { open } : {}) }, depth: depth + 1 });
      continue;
    }
    const sctx: ClassifyContext = {
      os: env.os, home: env.home, cwd: ref.cwd, ember: env.ember, downloaded: env.downloaded,
      ...(env.wsl ? { wsl: { mountRoot: env.wsl.mountRoot, windows: env.wsl.windows } } : {}),
    };
    for (const shell of lang.shells) {
      let got = classify(text, shell, sctx);
      const wanted = [...new Set([...got.probe, ...got.findings.flatMap(f => (f.ifExists === undefined ? [] : [f.ifExists]))])].slice(0, 64);
      const probe = wanted.filter(p => !env.paths.has(p));
      if (probe.length) {
        const unknown = probe.map((): PathFact => ({ exists: null, real: null }));
        const found = await within(io.inspect(probe, ref.cwd || flavour.dirname(ref.path)), Math.max(0, left()), unknown);
        probe.forEach((p, i) => env.paths.set(p, found[i] ?? { exists: null, real: null }));
      }
      const real = new Map<string, string>();
      for (const p of wanted) { const r = env.paths.get(p)?.real ?? null; if (r !== null && r !== p) real.set(p, r); }
      if (real.size) got = classify(text, shell, { ...sctx, real });
      refuse ??= got.refuse;
      for (const f of got.findings) {
        if (POSIX_SCRIPT_SHELLS.has(shell) && SCRIPT_FLOW.has(f.rule)) continue;
        const says = f.cls === "unclear" ? unreadPart(name, f.says) : `In ${name}: ${f.says}`;
        if (!extra.some(g => g.rule === f.rule && g.says === says)) extra.push({ ...f, says, widening: [...f.widening, "in-script", scriptTag(name)] });
      }
      downloads.push(...got.downloads);
      const x = got as Partial<ClassificationExtra>;
      const its = { by: me, writes: (x.writes ?? []).filter(p => typeof p === "string" && p !== ""), anywhere: x.writesAnywhere === true };
      inner.push(its);
      for (const p of its.writes) writes.add(p);
      if (its.anywhere) anywhere = true;
      for (const next of x.scripts ?? []) queue.push({ ref: next, depth: depth + 1 });
    }
  }
  // A script another script of this command writes (`sh a.sh && sh b.sh` with a.sh writing b.sh), or one inside a script
  // that the command line writes: what is on disk now isn't what will run. (The command line's own writes against the
  // scripts it names are classify's rule already.)
  const outerWrites = outer.writes ?? [];
  const outerAnywhere = outer.writesAnywhere === true;
  for (const r of ran) {
    const hit = (p: string) => r.names.some(n => isUnder(n, p, cmp));
    const byScript = inner.some(w => w.by !== r && (w.anywhere || w.writes.some(hit)));
    const byLine = r.depth > 1 && (outerAnywhere || outerWrites.some(hit));
    if (byScript || byLine) { unclear("unclear.script-written", WRITTEN_FIRST); break; }
  }
  const moreWrites = writes.size !== (outer.writes ?? []).length || anywhere !== outerAnywhere;
  if (!refuse && extra.length === 0 && downloads.length === 0 && !moreWrites) return withRealPaths(cls, env.paths);
  return withRealPaths({
    ...cls, refuse, findings: [...cls.findings, ...extra], downloads: [...new Set([...cls.downloads, ...downloads])],
    writes: [...writes], writesAnywhere: anywhere,
  } as Classification, env.paths);
}

/**
 * `cls` with the real path the target reported for each file it writes or downloads added beside the written one, so
 * the task remembers a write through a link (`printf … > l/t.sh` with l → .) where it lands: a later `sh t.sh` is the
 * task's own (the padding bypass), and running the download by its other name is still running a download.
 */
export function withRealPaths(cls: Classification, paths: ReadonlyMap<string, PathFact>): Classification {
  const x = cls as Partial<ClassificationExtra>;
  const add = (list: readonly string[]): string[] => {
    const out = new Set(list);
    for (const p of list) {
      const r = paths.get(p)?.real;
      if (typeof r === "string" && r !== "") out.add(r);
    }
    return [...out];
  };
  const writes = Array.isArray(x.writes) ? add(x.writes) : null;
  const downloads = add(cls.downloads);
  if ((writes === null || writes.length === x.writes!.length) && downloads.length === cls.downloads.length) return cls;
  return { ...cls, downloads, ...(writes ? { writes } : {}) } as Classification;
}
