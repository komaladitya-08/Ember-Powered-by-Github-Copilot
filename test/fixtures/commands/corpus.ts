/**
 * The command corpus (test/fixtures/commands/{posix,powershell,cmd,wsl}.json, design §10.1's CL row) and the targets
 * it is judged on: a Linux and a macOS computer, a Windows computer, and a WSL distro with its Windows side, all for
 * the user "ana" in a project folder. Each case is classified on its target and decided with the plain defaults
 * (commands on, no "ask every", nothing tainted or carried, every probed path existing except the case's `missing`).
 * The targets are plain data built from fixed strings, so the corpus gives the same results on every OS.
 */

import fs from "node:fs";
import path from "node:path";
import type {
  ClassifyContext, CommandDecision, CommandMode, CommandVerdict, DangerClass, GitFacts, PathFact, RunnerFacts, ShellId, WindowsContext,
} from "../../../app/main/commands/types";
import type { TargetBinding } from "../../../app/main/targets/types";
import { ALWAYS_ASK } from "../../../app/main/commands/types";
import { emberNamesRegExp } from "../../../app/main/remote/protocol";
import { classifyCommand, type ClassificationExtra } from "../../../app/main/commands/classify";
import { decideCommand } from "../../../app/main/commands/decide";
import { resolveTargetPath } from "../../../app/main/commands/paths";

export type ContextName = "linux" | "darwin" | "win32" | "wsl" | "wsl-mnt";
export type Family = "posix" | "powershell" | "cmd" | "wsl";

/** One case: the command, where it runs, what the user said, and what must come of it. */
export interface CorpusCase {
  cmd: string;
  verdict: CommandVerdict;
  /** Classes the decision must include (an ask or an announcement). */
  classes?: DangerClass[];
  /** Rules the decision must include. */
  rules?: string[];
  /** Paths (as written, resolved on the target) the target says don't exist. */
  missing?: string[];
  /** The user's own words for the task. */
  words?: string;
  /** Paths this task downloaded earlier (absolute on the target). */
  downloaded?: string[];
  shell?: ShellId;
  context?: ContextName;
  git?: GitFacts;
  mode?: CommandMode;
  askEvery?: boolean;
  privileged?: boolean;
}

export interface Corpus {
  family: Family;
  shell: ShellId;
  context: ContextName;
  cases: CorpusCase[];
}

const DEFAULTS: Readonly<Record<Family, { shell: ShellId; context: ContextName }>> = {
  posix: { shell: "bash", context: "linux" },
  powershell: { shell: "powershell", context: "win32" },
  cmd: { shell: "cmd", context: "win32" },
  wsl: { shell: "bash", context: "wsl" },
};

/** Reads one family's cases (from the repository's fixtures). */
export function loadCorpus(family: Family): Corpus {
  const raw = JSON.parse(fs.readFileSync(path.resolve("test/fixtures/commands", `${family}.json`), "utf8")) as Partial<Corpus> & { cases: CorpusCase[] };
  return { ...DEFAULTS[family], ...raw, family };
}

/** The Windows side of the WSL distro. */
export const WINDOWS_SIDE: WindowsContext = {
  home: "C:\\Users\\ana",
  localAppData: "C:\\Users\\ana\\AppData\\Local",
  appData: "C:\\Users\\ana\\AppData\\Roaming",
  temp: "C:\\Users\\ana\\AppData\\Local\\Temp",
  systemRoot: "C:\\Windows",
  emberPaths: ["C:\\Users\\ana\\AppData\\Local\\ember", "C:\\Program Files\\Ember"],
};

const names = emberNamesRegExp(["ember", "ember-remote", "Ember.exe"]);
const pids = [4242, 4243];

/** Each target's classification context (a fresh one per call: `downloaded` is per task). */
export function contextOf(name: ContextName, downloaded: readonly string[] = []): ClassifyContext {
  const set = new Set(downloaded);
  switch (name) {
    case "linux":
      return {
        os: "linux", home: "/home/ana", cwd: "/home/ana/proj", downloaded: set,
        ember: { paths: ["/home/ana/.config/ember", "/home/ana/.local/share/ember-remote"], pids, names },
      };
    case "darwin":
      return {
        os: "darwin", home: "/Users/ana", cwd: "/Users/ana/proj", downloaded: set,
        ember: { paths: ["/Users/ana/Library/Application Support/ember", "/Applications/Ember.app"], pids, names },
      };
    case "win32":
      return { os: "win32", home: "C:\\Users\\ana", cwd: "C:\\Users\\ana\\proj", downloaded: set, ember: { paths: [...WINDOWS_SIDE.emberPaths], pids, names } };
    case "wsl":
    case "wsl-mnt":
      return {
        os: "linux", home: "/home/ana", cwd: name === "wsl" ? "/home/ana/proj" : "/mnt/c/Users/ana/proj", downloaded: set,
        ember: { paths: ["/home/ana/.local/state/ember-remote"], pids, names },
        wsl: { mountRoot: "/mnt", windows: WINDOWS_SIDE },
      };
  }
}

/** Each target's binding. */
export function bindingOf(name: ContextName): TargetBinding {
  if (name === "wsl" || name === "wsl-mnt") return { id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu", screenOs: "win32", shellOs: "linux", desktop: "screen" };
  const os = name === "win32" ? "win32" : name === "darwin" ? "darwin" : "linux";
  return { id: "local", kind: "local", label: "This computer", screenOs: os, shellOs: os, desktop: "screen" };
}

/** Each target's runner facts. */
export function factsOf(name: ContextName, o: { privileged?: boolean } = {}): RunnerFacts {
  const ctx = contextOf(name);
  const win = ctx.os === "win32";
  return {
    os: ctx.os,
    shells: win ? ["powershell"] : ctx.os === "darwin" ? ["zsh", "bash", "sh"] : ["bash", "sh"],
    shellPaths: win ? {} : { bash: "/bin/bash", sh: "/bin/sh" },
    script: win ? null : { path: "/usr/bin/script", kind: ctx.os === "darwin" ? "bsd" : "util-linux" },
    home: ctx.home,
    user: "ana",
    privileged: o.privileged ?? false,
    pty: !win,
    ember: ctx.ember,
    extraPath: [],
    ...(ctx.wsl ? { wsl: { mountRoot: ctx.wsl.mountRoot, interop: true, windows: ctx.wsl.windows } } : {}),
  };
}

export interface CaseResult {
  cls: ClassificationExtra;
  decision: CommandDecision;
}

/** Classifies and decides one case on its target. */
export function runCase(c: CorpusCase, corpus: Pick<Corpus, "shell" | "context">): CaseResult {
  const name = c.context ?? corpus.context;
  const ctx = contextOf(name, c.downloaded);
  const cls = classifyCommand(c.cmd, c.shell ?? corpus.shell, ctx) as ClassificationExtra;
  const missing = new Set((c.missing ?? []).map(p => resolveTargetPath(p, ctx)));
  const paths = new Map<string, PathFact>();
  for (const p of [...cls.probe, ...cls.findings.flatMap(f => (f.ifExists === undefined ? [] : [f.ifExists]))]) {
    paths.set(p, { exists: !missing.has(p), real: p });
  }
  const decision = decideCommand({
    cls, paths, git: c.git ?? null, binding: bindingOf(name), facts: factsOf(name, { privileged: c.privileged }),
    mode: c.mode ?? "on", userAskEvery: c.askEvery ?? false, userWords: c.words ?? "", agreed: [], tainted: false, carried: null,
  });
  return { cls, decision };
}

/** What is wrong with a case's result ("" when nothing). */
export function problemsOf(c: CorpusCase, r: CaseResult): string {
  const d = r.decision;
  const out: string[] = [];
  if (d.verdict !== c.verdict) out.push(`verdict ${d.verdict}, wanted ${c.verdict}`);
  for (const k of c.classes ?? []) if (!d.classes.includes(k)) out.push(`no class ${k}`);
  for (const k of c.rules ?? []) if (!d.rules.includes(k)) out.push(`no rule ${k}`);
  if (d.verdict === "run" && d.classes.length > 0) out.push("runs with classes");
  if (d.verdict === "announce" && (d.requested === undefined || d.classes.some(k => ALWAYS_ASK.has(k)))) out.push("announces what always asks");
  for (const p of r.cls.probe) if (p.length > 1 && d.reason.includes(p)) out.push(`reason holds the path ${p}`);
  if (c.cmd.length > 3 && d.reason.includes(c.cmd)) out.push("reason holds the command");
  if (out.length === 0) return "";
  const got = r.cls.refuse ? `refuse ${r.cls.refuse.rule}` : r.cls.findings.map(f => `${f.cls}:${f.rule}`).join(" ") || "ordinary";
  return `${JSON.stringify(c.cmd)} [${c.context ?? ""}${c.shell ? ` ${c.shell}` : ""}]: ${out.join("; ")} (got ${got})`;
}
