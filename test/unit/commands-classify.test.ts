/**
 * The command corpus (design §10.1's CL row, OWNER DECISION 4): every case in test/fixtures/commands/*.json classified
 * on its target and decided, its verdict, classes and rules checked, and the decision's audit `reason` free of paths
 * and of the command. Then the classifier's own promises: it never throws, text it can't parse never counts as
 * ordinary, and it takes under 5 ms per KiB.
 */

import { describe, expect, it } from "vitest";
import type { ShellId } from "../../app/main/commands/types";
import { classifyCommand, MAX_COMMAND_CHARS, mayBecomeWords, unnamedWriteFolders, unseenName, type ClassificationExtra } from "../../app/main/commands/classify";
import { pathEnv } from "../../app/main/commands/paths";
import { lexPosix } from "../../app/main/commands/lex-posix";
import { lexPowerShell } from "../../app/main/commands/lex-powershell";
import { lexCmd } from "../../app/main/commands/lex-cmd";
import { lit, type Arg } from "../../app/main/commands/words";
import { contextOf, loadCorpus, problemsOf, runCase, type Family } from "../fixtures/commands/corpus";

const FAMILIES: Family[] = ["posix", "powershell", "cmd", "wsl"];

describe("the command corpus", () => {
  const sizes: Record<string, number> = {};
  for (const family of FAMILIES) {
    it(`decides every ${family} case as the corpus says`, () => {
      const corpus = loadCorpus(family);
      sizes[family] = corpus.cases.length;
      const problems = corpus.cases.map(c => problemsOf(c, runCase(c, corpus))).filter(p => p !== "");
      expect(problems).toEqual([]);
    });
  }

  it("holds at least 800 cases, with every verdict in it", () => {
    const all = FAMILIES.flatMap(f => loadCorpus(f).cases);
    expect(all.length).toBeGreaterThanOrEqual(800);
    for (const v of ["run", "announce", "ask", "refuse"] as const) expect(all.some(c => c.verdict === v)).toBe(true);
  });
});

describe("the second pass (§3.6, §3.8.3): the target's real paths", () => {
  const withReal = (real: Record<string, string>) => ({ ...contextOf("linux"), real: new Map(Object.entries(real)) });
  const win = (real: Record<string, string>) => ({ ...contextOf("win32"), real: new Map(Object.entries(real)) });

  it("judges the real path as well as the written one, and keeps the stricter", () => {
    expect(classifyCommand("cat notes", "bash", withReal({ "/home/ana/proj/notes": "/home/ana/.ssh/id_rsa" })).findings.map(f => f.cls)).toContain("secret");
    expect(classifyCommand("rm -rf cache", "bash", withReal({ "/home/ana/proj/cache": "/home/ana/.config/ember" })).refuse?.rule).toBe("ember.path");
    expect(classifyCommand("echo x > notes", "bash", withReal({ "/home/ana/proj/notes": "/home/ana/.bashrc" })).findings.map(f => f.rule)).toContain("path.startup");
    expect(classifyCommand("cat notes", "bash", withReal({ "/home/ana/proj/notes": "/home/ana/proj/notes" })).findings).toEqual([]);
  });

  it("judges a glob under a linked folder by the folder's real path too", () => {
    expect(classifyCommand("cat k/*", "bash", contextOf("linux")).findings).toEqual([]);
    expect(classifyCommand("cat k/*", "bash", withReal({ "/home/ana/proj/k": "/home/ana/.ssh" })).findings.map(f => f.rule)).toContain("path.secret");
    expect(classifyCommand("cat k/*/settings.json", "bash", withReal({ "/home/ana/proj/k": "/home/ana/.config" })).refuse?.rule).toBe("ember.path");
  });

  it("marks a finding whose real path differs, so no intent row covers it", () => {
    const cls = classifyCommand("rm notes", "bash", withReal({ "/home/ana/proj/notes": "/home/ana/other/notes" }));
    expect(cls.findings[0].widening).toContain("real-path");
  });

  it("drops the unclear 8.3 short name once the target resolved it", () => {
    const text = "Get-Content C:\\PROGRA~1\\x\\y.txt";
    expect(classifyCommand(text, "powershell", contextOf("win32")).findings.map(f => f.rule)).toContain("unclear.short-name");
    expect(classifyCommand(text, "powershell", win({ "C:\\PROGRA~1\\x\\y.txt": "C:\\Program Files\\x\\y.txt" })).findings).toEqual([]);
  });
});

/** A small fixed-seed generator (mulberry32), so a failure can be replayed. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PIECES = [
  "rm", " ", "-rf", "'", "\"", "`", "$(", ")", "${", "}", "{", "(", "|", "&", ";", "&&", "||", ">", ">>", "<", "<<", "EOF", "\n",
  "\\", "*", "?", "[", "]", "~", "#", "=", "!", "^", "%", "@", "git", "push", "cmd", "/c", "powershell", "-enc", "wsl", "--",
  "Remove-Item", "iex", "$x", "curl", "sh", "x", "a.txt", "C:\\", "/etc/", "..", ",", "--%", "@'", "'@", "\t", "\r", "\u0007",
  "\u202e", "\u200b", "\u0430", "\uff1a", "\u00ff", "\ud800",
];

/** Random text: half fragments of shell syntax, half arbitrary characters (lone surrogates and controls included). */
function fuzzText(next: () => number): string {
  const n = 1 + Math.floor(next() * 24);
  let s = "";
  for (let k = 0; k < n; k++) {
    if (next() < 0.5) s += PIECES[Math.floor(next() * PIECES.length)];
    else s += String.fromCharCode(Math.floor(next() * 0x10000));
  }
  return s;
}

/** Whether the shell's own tokenizer gave up on the text, or found something it couldn't follow. */
function unparsable(text: string, shell: ShellId): boolean {
  if (shell === "powershell") { const p = lexPowerShell(text); return p.fatal || p.unclear.length > 0; }
  if (shell === "cmd") { const p = lexCmd(text); return p.fatal || p.unclear.length > 0; }
  const p = lexPosix(text, shell === "zsh" ? "zsh" : shell === "sh" ? "sh" : "bash");
  return p.fatal || p.unclear.length > 0;
}

describe("Ember's own refusals say what the command would do to Ember's files (D4.5, the lead's ruling)", () => {
  const READ = "Ember won't run this: it would read Ember's own safety settings, records or programs.";
  const CHANGE = "Ember won't run this: it would change Ember's own safety settings, records or programs.";
  const INPUT = "Ember won't run this: it could press keys or click in Ember's own windows.";
  const says = (text: string, shell: ShellId = "bash", where: "linux" | "win32" = "linux") => classifyCommand(text, shell, contextOf(where)).refuse?.says;

  it("says \"would read\" for a command that only reads them", () => {
    expect(says("cat ~/.config/ember/settings.json")).toBe(READ);
    expect(says("ls -la ~/.config/ember")).toBe(READ);
    expect(says("grep -r token ~/.config/ember")).toBe(READ);
    expect(says("cat ~/.config/emb*/settings.json")).toBe(READ);
    expect(says("cp ~/.config/ember/settings.json /tmp/s.json")).toBe(READ);
    expect(says("Get-Content C:\\Users\\ana\\AppData\\Local\\ember\\settings.json", "powershell", "win32")).toBe(READ);
    expect(says("Get-ItemProperty HKLM:\\SOFTWARE\\Policies\\Ember", "powershell", "win32")).toBe(READ);
    expect(says("reg query HKLM\\SOFTWARE\\Policies\\Ember", "powershell", "win32")).toBe(READ);
  });

  it("says \"would change\" for one that writes, deletes or moves them, or reads and also changes them", () => {
    expect(says("rm -rf ~/.config/ember")).toBe(CHANGE);
    expect(says("echo x > ~/.config/ember/settings.json")).toBe(CHANGE);
    expect(says("cp /tmp/s.json ~/.config/ember/settings.json")).toBe(CHANGE);
    expect(says("cat ~/.config/ember/a.json > ~/.config/ember/b.json")).toBe(CHANGE);
    expect(says("Remove-Item C:\\Users\\ana\\AppData\\Local\\ember\\settings.json", "powershell", "win32")).toBe(CHANGE);
    expect(says("Set-ItemProperty HKLM:\\SOFTWARE\\Policies\\Ember -Name x -Value 1", "powershell", "win32")).toBe(CHANGE);
    expect(says("reg add HKLM\\SOFTWARE\\Policies\\Ember /v x /d 1", "powershell", "win32")).toBe(CHANGE);
  });

  it("keeps the input refusal's words, and lets a read refusal give way to it", () => {
    expect(says("xdotool key y")).toBe(INPUT);
    expect(says("cat ~/.config/ember/settings.json; xdotool key y")).toBe(INPUT);
    expect(says("xdotool key y; cat ~/.config/ember/settings.json")).toBe(INPUT);
  });
});

describe("variable names Ember can't see (name-taking built-ins, D4.3 g)", () => {
  /** An unresolved word as written. */
  const unres = (raw: string): Arg => ({ v: null, raw, glob: false });

  it("tells a word that could split into several from one that can't", () => {
    for (const raw of ["$x", "${x}", "$(cmd)", "`cmd`", "a$x", "\"$@\"", "\"${a[@]}\"", "$*", "'a'$x"]) expect(mayBecomeWords(raw), raw).toBe(true);
    for (const raw of ["\"$x\"", "\"${x}\"", "\"$(cmd)\"", "'$x'", "\\$x", "\"a $x b\"", "$'a\\tb'"]) expect(mayBecomeWords(raw), raw).toBe(false);
  });

  it("finds a name in every place each built-in takes one", () => {
    expect(unseenName("printf", [lit("-v"), unres("\"$x\""), lit("y")])).toBe(true);
    expect(unseenName("printf", [unres("\"$o\""), unres("\"$x\""), lit("y")])).toBe(true);
    expect(unseenName("printf", [unres("$x")])).toBe(true);
    expect(unseenName("read", [lit("-r"), lit("-a"), unres("\"$x\"")])).toBe(true);
    expect(unseenName("read", [unres("\"$x\"")])).toBe(true);
    expect(unseenName("mapfile", [lit("-t"), unres("\"$x\"")])).toBe(true);
    expect(unseenName("declare", [unres("\"$x\"=1")])).toBe(true);
    expect(unseenName("export", [unres("\"$x=1\"")])).toBe(true);
    expect(unseenName("test", [lit("-v"), unres("\"$x\"")])).toBe(true);
    expect(unseenName("[", [unres("\"$o\""), unres("\"$x\""), lit("]")])).toBe(true);
    expect(unseenName("[", [unres("$x"), lit("]")])).toBe(true);
    expect(unseenName("unset", [unres("\"$x\"")])).toBe(true);
    expect(unseenName("wait", [lit("-p"), unres("\"$x\"")])).toBe(true);
    expect(unseenName("getopts", [lit("ab"), unres("\"$x\"")])).toBe(true);
  });

  it("leaves values that are only text alone", () => {
    expect(unseenName("printf", [lit("%s\\n"), unres("\"$x\""), unres("$y")])).toBe(false);
    expect(unseenName("printf", [lit("-v"), lit("out"), lit("%s"), unres("\"$x\"")])).toBe(false);
    expect(unseenName("printf", [unres("\"$fmt\"")])).toBe(false);
    expect(unseenName("test", [lit("-n"), unres("\"$x\"")])).toBe(false);
    expect(unseenName("[", [unres("\"$a\""), lit("="), unres("\"$b\""), lit("]")])).toBe(false);
    expect(unseenName("[", [unres("\"$x\""), lit("]")])).toBe(false);
    expect(unseenName("read", [lit("-r"), lit("-p"), unres("\"$msg\""), lit("line")])).toBe(false);
    expect(unseenName("read", [lit("-r"), lit("-p"), unres("$msg"), lit("line")])).toBe(true);
    expect(unseenName("export", [unres("NODE_ENV=\"$mode\"")])).toBe(false);
    expect(unseenName("declare", [unres("\"greeting=hello $name\"")])).toBe(false);
  });
});

describe("shell scripts to read (L8, the lead's ruling)", () => {
  const scripts = (cmd: string, shell: "bash" | "zsh" | "sh" | "powershell" | "cmd", ctx: "linux" | "win32") =>
    (classifyCommand(cmd, shell, contextOf(ctx)) as ClassificationExtra).scripts;

  it("records the shell scripts a command runs by path, with how to read each and the folder each runs in", () => {
    const P = "/home/ana/proj";
    const W = "C:\\Users\\ana\\proj";
    expect(scripts("sh t.sh", "bash", "linux")).toEqual([{ path: `${P}/t.sh`, as: "sh", cwd: P }]);
    expect(scripts("bash ./scripts/deploy.sh", "bash", "linux")).toEqual([{ path: `${P}/scripts/deploy.sh`, as: "bash", cwd: P }]);
    expect(scripts("zsh x.zsh", "zsh", "linux")).toEqual([{ path: `${P}/x.zsh`, as: "zsh", cwd: P }]);
    expect(scripts("dash x.sh", "bash", "linux")).toEqual([{ path: `${P}/x.sh`, as: "sh", cwd: P }]);
    // A sourced script runs in the shell that sources it.
    expect(scripts("source env.sh", "bash", "linux")).toEqual([{ path: `${P}/env.sh`, as: "bash", cwd: P }]);
    expect(scripts(". ./env.sh", "bash", "linux")).toEqual([{ path: `${P}/env.sh`, as: "bash", cwd: P }]);
    expect(scripts("sh -c '. ./env.sh'", "bash", "linux")).toEqual([{ path: `${P}/env.sh`, as: "sh", cwd: P }]);
    expect(scripts("./deploy.sh", "bash", "linux")).toEqual([{ path: `${P}/deploy.sh`, as: "shebang", cwd: P }]);
    // It runs in the command's folder, not beside the script (its relative paths resolve there). A `..` in its name is
    // walked by the kernel through links, so it is read by the name as written once the target says where that leads.
    const back = classifyCommand("cd sub && sh ../tools/t.sh", "bash", { ...contextOf("linux"), real: new Map([[`${P}/sub/../tools/t.sh`, `${P}/tools/t.sh`]]) });
    expect((back as ClassificationExtra).scripts).toEqual([{ path: `${P}/tools/t.sh`, as: "sh", cwd: `${P}/sub`, open: `${P}/sub/../tools/t.sh` }]);
    // Through a wrapper, and from stdin.
    for (const cmd of ["env FOO=1 ./x.sh", "exec ./x.sh", "nice ./x.sh", "timeout 5 ./x.sh", "command ./x.sh"]) {
      expect(scripts(cmd, "bash", "linux"), cmd).toEqual([{ path: `${P}/x.sh`, as: "shebang", cwd: P }]);
    }
    expect(scripts("bash < x.sh", "bash", "linux")).toEqual([{ path: `${P}/x.sh`, as: "bash", cwd: P }]);
    expect(scripts("sh -s < x.sh", "bash", "linux")).toEqual([{ path: `${P}/x.sh`, as: "sh", cwd: P }]);
    expect(scripts("powershell -File deploy.ps1", "powershell", "win32")).toEqual([{ path: `${W}\\deploy.ps1`, as: "powershell", cwd: W }]);
    expect(scripts(".\\deploy.ps1", "powershell", "win32")).toEqual([{ path: `${W}\\deploy.ps1`, as: "powershell", cwd: W }]);
    expect(scripts("& .\\deploy.ps1", "powershell", "win32")).toEqual([{ path: `${W}\\deploy.ps1`, as: "powershell", cwd: W }]);
    // PowerShell runs `.\\deploy` as deploy.ps1, else deploy.bat or deploy.cmd; cmd runs `build` as build.bat or build.cmd.
    expect(scripts(".\\deploy", "powershell", "win32")).toEqual([
      { path: `${W}\\deploy.ps1`, as: "powershell", cwd: W }, { path: `${W}\\deploy.bat`, as: "cmd", cwd: W }, { path: `${W}\\deploy.cmd`, as: "cmd", cwd: W },
    ]);
    expect(scripts("cmd /c build.bat", "powershell", "win32")).toEqual([{ path: `${W}\\build.bat`, as: "cmd", cwd: W }]);
    expect(scripts("build.bat", "cmd", "win32")).toEqual([{ path: `${W}\\build.bat`, as: "cmd", cwd: W }]);
    expect(scripts("build", "cmd", "win32")).toEqual([{ path: `${W}\\build.bat`, as: "cmd", cwd: W }, { path: `${W}\\build.cmd`, as: "cmd", cwd: W }]);
  });

  it("asks when what would run can't be read first: a pattern, a stream, a script this command writes, too many", () => {
    const rules = (cmd: string, shell: "bash" | "powershell" | "cmd" = "bash", ctx: "linux" | "win32" = "linux") =>
      classifyCommand(cmd, shell, contextOf(ctx)).findings.map(f => f.rule);
    for (const cmd of ["sh *.sh", "./t*.sh", "source t?.sh", ". ./*.sh"]) expect(rules(cmd), cmd).toContain("unclear.script-pattern");
    for (const cmd of ["sh /dev/fd/3 3<t.sh", "sh /proc/self/fd/0 < t.sh"]) expect(rules(cmd), cmd).toContain("unclear.script-stream");
    // The lead's own examples, and every way a known program writes the script before it runs.
    for (const cmd of [
      "echo 'rm -rf build' > t.sh; sh t.sh", "echo 'cat ~/.ssh/id_rsa' > t.sh; sh t.sh", "printf 'rm -rf build' > t.sh && chmod +x t.sh && ./t.sh",
      "sed -i 's/a/b/' t.sh; sh t.sh", "echo x >> t.sh; bash t.sh", "cp a.sh t.sh && sh t.sh", "mv a.sh t.sh && ./t.sh", "tee t.sh < a; sh t.sh",
      "mkfifo t.sh && sh t.sh", "cp -r tmpl/ scripts && sh scripts/t.sh", "tar xf a.tar && sh t.sh", "unzip a.zip && ./t.sh", "patch -p1 < p.diff && sh t.sh",
      "git apply p.diff && sh t.sh", "git -C . checkout other && ./t.sh", "gunzip t.sh.gz && sh t.sh", "for i in 1 2; do sh t.sh; echo 'rm -rf build' > t.sh; done",
    ]) expect(rules(cmd), cmd).toContain("unclear.script-written");
    expect(rules("git pull; .\\build", "powershell", "win32")).toContain("unclear.script-written");
    // Permissions, an empty new file, or a writer that runs before nothing it wrote don't count.
    for (const cmd of ["chmod +x t.sh && ./t.sh", "touch t.sh && sh t.sh", "sh t.sh && tar czf out.tgz dist", "git status && ./t.sh"]) {
      expect(rules(cmd), cmd).not.toContain("unclear.script-written");
    }
    expect(rules("git pull", "cmd", "win32")).toEqual([]);
    expect(rules(Array.from({ length: 17 }, (_, k) => `sh s${k}.sh`).join("; "))).toContain("unclear.scripts");
  });

  it("records no script for an interpreter, a downloaded file, `sh -c`, or stdin", () => {
    expect(scripts("node app.js", "bash", "linux")).toEqual([]);
    expect(scripts("python x.py", "bash", "linux")).toEqual([]);
    expect(scripts("deno run main.ts", "bash", "linux")).toEqual([]);
    expect(scripts("sh -c 'echo hi'", "bash", "linux")).toEqual([]);
    expect(scripts("sh", "bash", "linux")).toEqual([]);
    // A secret or Ember's own file is never read as a script (running it asks or is refused by the path's own rule).
    expect(scripts("sh ~/.ssh/id_rsa", "bash", "linux")).toEqual([]);
    expect(scripts("source .env", "bash", "linux")).toEqual([]);
    expect(scripts("sh ~/.config/ember/x.sh", "bash", "linux")).toEqual([]);
    // A bare `deploy.ps1` (no .\) does not run the local file in PowerShell.
    expect(scripts("deploy.ps1", "powershell", "win32")).toEqual([]);
    // A file this task downloaded is already escape.run-downloaded, not read.
    const dl = classifyCommand("sh get.sh", "bash", contextOf("linux", ["/home/ana/proj/get.sh"])) as ClassificationExtra;
    expect(dl.scripts).toEqual([]);
    expect(dl.findings.map(f => f.rule)).toContain("escape.run-downloaded");
  });
});

describe("`..` in a path, walked by the kernel through links (§3.6, L25)", () => {
  const P = "/home/ana/proj";
  const ctx = (real: Record<string, string> = {}, downloaded: string[] = []) => ({ ...contextOf("linux", downloaded), real: new Map(Object.entries(real)) });
  const extra = (cmd: string, real: Record<string, string> = {}, downloaded: string[] = []) => classifyCommand(cmd, "bash", ctx(real, downloaded)) as ClassificationExtra;
  const rules = (cmd: string, real: Record<string, string> = {}, downloaded: string[] = []) => extra(cmd, real, downloaded).findings.map(f => f.rule);

  it("asks which script runs until the target says where `sub/../t.sh` leads, and probes it as written", () => {
    for (const [cmd, open] of [
      ["sh sub/../t.sh", `${P}/sub/../t.sh`], ["cd link && sh ../t.sh", `${P}/link/../t.sh`], ["./sub/../t.sh", `${P}/sub/../t.sh`],
      ["bash < sub/../t.sh", `${P}/sub/../t.sh`], ["source sub/../env.sh", `${P}/sub/../env.sh`], ["env A=1 ./sub/../t.sh", `${P}/sub/../t.sh`],
    ]) {
      const c = extra(cmd);
      expect(c.scripts, cmd).toEqual([]);
      expect(c.findings.find(f => f.rule === "unclear.script-path")?.says, cmd).toBe("Ember can't tell which script this runs.");
      expect(c.probe, cmd).toContain(open);
    }
  });

  it("reads the script by the name as written and judges it by where it really is, once the target said", () => {
    const c = extra("cd link && sh ../t.sh", { [`${P}/link/../t.sh`]: "/data/t.sh" });
    expect(c.scripts).toEqual([{ path: `${P}/t.sh`, as: "sh", cwd: `${P}/link`, open: `${P}/link/../t.sh`, real: "/data/t.sh" }]);
    expect(c.findings.map(f => f.rule)).not.toContain("unclear.script-path");
    // `sh t.sh && sh sub/../t.sh` names two files, both read.
    expect(extra("sh t.sh && sh sub/../t.sh", { [`${P}/sub/../t.sh`]: "/data/t.sh" }).scripts.map(r => r.open ?? r.path)).toEqual([`${P}/t.sh`, `${P}/sub/../t.sh`]);
    // A link's own target is remembered as where the script is.
    expect(extra("sh l.sh", { [`${P}/l.sh`]: "/x/t.sh" }).scripts).toEqual([{ path: `${P}/l.sh`, as: "sh", cwd: P, real: "/x/t.sh" }]);
  });

  it("keeps the shell's own `cd ..` lexical, and PowerShell's and cmd's `..` (they remove it themselves)", () => {
    expect(extra("cd sub/.. && sh t.sh").scripts).toEqual([{ path: `${P}/t.sh`, as: "sh", cwd: P }]);
    const W = "C:\\Users\\ana\\proj";
    const ps = classifyCommand("& .\\sub\\..\\t.ps1", "powershell", contextOf("win32")) as ClassificationExtra;
    expect(ps.scripts).toEqual([{ path: `${W}\\t.ps1`, as: "powershell", cwd: W }]);
    expect(ps.findings.map(f => f.rule)).not.toContain("unclear.script-path");
    const cmd = classifyCommand("sub\\..\\build.bat", "cmd", contextOf("win32")) as ClassificationExtra;
    expect(cmd.scripts).toEqual([{ path: `${W}\\build.bat`, as: "cmd", cwd: W }]);
  });

  it("judges every path with `..` by where it really leads: a secret, Ember's own, a download", () => {
    expect(rules("cat sub/../credentials")).not.toContain("path.secret");
    expect(rules("cat sub/../credentials", { [`${P}/sub/../credentials`]: "/home/ana/.aws/credentials" })).toContain("path.secret");
    expect(extra("rm -r sub/../x", { [`${P}/sub/../x`]: "/home/ana/.config/ember/x" }).refuse?.rule).toBe("ember.path");
    expect(rules("cat sub/../*", { [`${P}/sub/..`]: "/home/ana/.ssh" })).toContain("path.secret");
    expect(rules("cat */../x")).toContain("unclear.glob-parent");
    expect(extra("cat sub/../a\\ b/emb*/settings.json", { [`${P}/sub/../a b`]: "/home/ana/.config" }).refuse?.rule).toBe("ember.path");
    // A secret reached through `..` is never read as a script; its own rule asks.
    const key = extra("sh sub/../id", { [`${P}/sub/../id`]: "/home/ana/.ssh/id_ed25519" });
    expect(key.scripts).toEqual([]);
    expect(key.findings.map(f => f.rule)).toContain("path.secret");
    // Running this task's download by another name is running the download.
    expect(rules("sh sub/../get.sh", { [`${P}/sub/../get.sh`]: "/data/get.sh" }, ["/data/get.sh"])).toContain("escape.run-downloaded");
    expect(rules("sh l.sh", { [`${P}/l.sh`]: `${P}/get.sh` }, [`${P}/get.sh`])).toContain("escape.run-downloaded");
    // Nothing more when `..` leads where the lexical form does.
    expect(extra("rm -r ../build", { [`${P}/../build`]: "/home/ana/build" }).findings.every(f => !f.widening.includes("real-path"))).toBe(true);
  });

  it("follows `cd -P` to the folder's real path, and asks about shell options that make every cd follow links", () => {
    expect(extra("cd -P link && cd .. && sh t.sh", { [`${P}/link`]: "/data/sub" }).scripts).toEqual([{ path: "/data/t.sh", as: "sh", cwd: "/data" }]);
    expect(extra("cd -P link && sh t.sh").scripts).toEqual([{ path: `${P}/link/t.sh`, as: "sh", cwd: `${P}/link` }]);
    expect(extra("cd -L -P link && sh t.sh", { [`${P}/link`]: "/data/sub" }).scripts[0]?.cwd).toBe("/data/sub");
    expect(extra("cd -P -L link && sh t.sh", { [`${P}/link`]: "/data/sub" }).scripts[0]?.cwd).toBe(`${P}/link`);
    // `..` in a `cd -P` folder Ember couldn't resolve: the folder is unknown, so what follows asks.
    expect(rules("cd -P link/.. && cat notes")).toContain("unclear.folder");
    expect(extra("cd -P link/.. && sh t.sh", { [`${P}/link/..`]: "/data" }).scripts).toEqual([{ path: "/data/t.sh", as: "sh", cwd: "/data" }]);
    expect(extra("cd -P sub").cdOnly).toBe(`${P}/sub`);
    expect(extra("cd -P link", { [`${P}/link`]: "/data/sub" }).cdOnly).toBe("/data/sub");
    for (const [cmd, shell] of [
      ["set -P && cd link && cd .. && sh t.sh", "bash"], ["set -eP", "bash"], ["set -o physical", "bash"], ["bash -P -c 'cd link; cd ..; sh t.sh'", "bash"],
      ["setopt chase_links", "zsh"], ["setopt CHASEDOTS", "zsh"], ["set -o chaselinks", "zsh"], ["zsh -o chase_dots -c 'cd ..'", "bash"],
    ] as const) expect(classifyCommand(cmd, shell, ctx()).findings.map(f => f.rule), cmd).toContain("unclear.chase-links");
    for (const cmd of ["set -euo pipefail", "set +P", "set -o errexit", "set -- -P x", "cd -L link", "setopt extendedglob"]) expect(rules(cmd), cmd).not.toContain("unclear.chase-links");
  });

  it("knows a command writes the script it runs by any of its names, and remembers a write where it lands", () => {
    expect(rules("printf 'rm -rf ~' > /data/t.sh; sh sub/../t.sh", { [`${P}/sub/../t.sh`]: "/data/t.sh" })).toContain("unclear.script-written");
    expect(rules("printf 'rm -rf ~' > /x/t.sh; sh l.sh", { [`${P}/l.sh`]: "/x/t.sh" })).toContain("unclear.script-written");
    expect(rules("printf 'rm -rf ~' > l.sh; sh /x/t.sh", { [`${P}/l.sh`]: "/x/t.sh" })).toContain("unclear.script-written");
    expect(extra("printf x > sub/../t.sh", { [`${P}/sub/../t.sh`]: "/data/t.sh" }).writes).toEqual(expect.arrayContaining([`${P}/t.sh`, "/data/t.sh"]));
  });
});

describe("what a command writes, for the task's memory (L8's padding bypass)", () => {
  const P = "/home/ana/proj";
  const w = (cmd: string, shell: "bash" | "powershell" = "bash", ctx: "linux" | "win32" = "linux") => {
    const c = classifyCommand(cmd, shell, contextOf(ctx)) as ClassificationExtra;
    return { writes: c.writes, anywhere: c.writesAnywhere };
  };

  it("names each file a redirection, cp, mv, tee, sed -i or dd writes, and none for reading, chmod, touch or mkdir", () => {
    expect(w("printf '%70000s' > t.sh")).toEqual({ writes: [`${P}/t.sh`], anywhere: false });
    expect(w("echo 'rm -rf ~' >> t.sh").writes).toEqual([`${P}/t.sh`]);
    expect(w("cp a.sh /tmp/t.sh").writes).toContain("/tmp/t.sh");
    expect(w("mv a.sh t.sh").writes).toEqual(expect.arrayContaining([`${P}/a.sh`, `${P}/t.sh`]));
    expect(w("echo x | tee t.sh").writes).toEqual([`${P}/t.sh`]);
    expect(w("sed -i 's/a/b/' t.sh").writes).toEqual([`${P}/t.sh`]);
    expect(w("dd if=a.sh of=t.sh").writes).toContain(`${P}/t.sh`);
    expect(w("cp -r tmpl/ scripts").writes).toContain(`${P}/scripts`);
    expect(w('Set-Content -Path t.ps1 -Value "x"', "powershell", "win32").writes).toEqual(["C:\\Users\\ana\\proj\\t.ps1"]);
    for (const cmd of ["cat t.sh", "chmod +x t.sh", "touch t.sh", "mkdir -p out", "ls > /dev/null", "git status"]) {
      expect(w(cmd), cmd).toEqual({ writes: [], anywhere: false });
    }
  });

  it("names the folder an archive unpacks into, and a decompressor's file's folder", () => {
    const sorted = (cmd: string) => [...w(cmd).writes].sort();
    expect(w("tar xzf deps.tgz")).toEqual({ writes: [P], anywhere: false });
    expect(sorted("tar -xzf deps.tgz -C /opt/deps")).toEqual([P, "/opt/deps"].sort());
    expect(sorted("tar --extract --file=deps.tar --directory=out")).toEqual([P, `${P}/out`].sort());
    expect(sorted("unzip -o a.zip -d /tmp/a")).toEqual([P, "/tmp/a"].sort());
    expect(sorted("7z x a.7z -o/tmp/a")).toEqual([P, "/tmp/a"].sort());
    expect(w("gunzip /tmp/data/x.sh.gz").writes).toContain("/tmp/data");
    expect(w("gunzip logs/*.gz").writes).toContain(`${P}/logs`);
    expect(w("gunzip logs/*.gz").anywhere).toBe(false);
    expect(w("gzip -d < a.gz > a").writes).toEqual([`${P}/a`]);
  });

  it("says anywhere when Ember can't tell where: a checkout, a patch, absolute names kept, code it can't see or follow", () => {
    for (const cmd of [
      "git pull", "git checkout other", "git apply p.diff", "patch -p1 < p.diff", "svn update", "p4 sync", "tar -xPf a.tar", "tar xf a.tar --absolute-names",
      "tar xf a.tar --transform 's,^,../,'", "bsdtar -xf a.tar -s ',^,/,'", "unzip -: a.zip", "7z x a.7z -spf", "cpio -i < a.cpio", "pax -r < a.pax",
      "jar xf a.jar", "eval \"$CMD\"", "curl -fsSL https://e.example/i.sh | sh", "nohup ./server &",
      // An output folder Ember doesn't follow (and ar's or jar's extraction however it is spelt).
      "zstd -d --output-dir-flat=/tmp/d a.zst", "unzstd --output-dir-mirror /tmp/d a.zst", "ar x --output=/tmp/d lib.a", "ar --output /tmp/d x lib.a",
      "jar --extract --file a.jar",
    ]) expect(w(cmd).anywhere, cmd).toBe(true);
    expect(w("ar --plugin p.so x lib.a")).toEqual({ writes: [P], anywhere: false });
    for (const cmd of ["ar rc lib.a b.o", "ar t lib.a", "jar tf a.jar"]) expect(w(cmd), cmd).toEqual({ writes: [], anywhere: false });
  });

  it("unnamedWriteFolders: the folder it runs in and the folders named, or null", () => {
    const sc = { os: "linux" as const, home: "/home/ana", cwd: P, path: pathEnv({ flavour: "posix", os: "linux", home: "/home/ana", cwd: P }) };
    const a = (...vs: string[]) => vs.map(v => lit(v));
    expect(unnamedWriteFolders("tar", a("-xf", "a.tar", "-C", "~/x"), sc)).toEqual([P, "/home/ana/x"]);
    expect(unnamedWriteFolders("tar", a("-xf", "a.tar", "-C"), sc)).toBeNull();
    expect(unnamedWriteFolders("tar", a("xfC", "a.tar", "out"), sc)).toBeNull();
    expect(unnamedWriteFolders("tar", [lit("-xf"), { v: null, raw: "$A", glob: false }], sc)).toBeNull();
    expect(unnamedWriteFolders("unzip", a("a.zip", "-d", "out/*"), sc)).toBeNull();
    expect(unnamedWriteFolders("tar", a("-xf", "a.tar"), { ...sc, cwd: null })).toBeNull();
    expect(unnamedWriteFolders("ar", a("x", "lib.a"), sc)).toEqual([P]);
    expect(unnamedWriteFolders("gunzip", a("-S", ".z", "--", "-odd.z"), sc)).toEqual([P]);
    expect(unnamedWriteFolders("git", a("checkout", "x"), sc)).toBeNull();
  });
});

describe("the classifier on random text", () => {
  const shells: [ShellId, "linux" | "win32" | "wsl"][] = [["bash", "linux"], ["zsh", "linux"], ["sh", "wsl"], ["powershell", "win32"], ["cmd", "win32"]];
  for (const [shell, where] of shells) {
    it(`never throws, and never calls unparsable ${shell} text ordinary`, () => {
      const next = random(0x5eed + shell.length);
      for (let k = 0; k < 1500; k++) {
        const text = fuzzText(next);
        const cls = classifyCommand(text, shell, contextOf(where));
        expect(Array.isArray(cls.findings)).toBe(true);
        if (unparsable(text, shell)) {
          expect(cls.refuse !== null || cls.findings.length > 0, JSON.stringify(text)).toBe(true);
        }
      }
    });
  }

  it("calls text past the length limit unclear", () => {
    const cls = classifyCommand(`echo ${"a".repeat(MAX_COMMAND_CHARS)}`, "bash", contextOf("linux"));
    expect(cls.findings.map(f => f.cls)).toContain("unclear");
  });

  it("calls bytes that aren't text unclear", () => {
    for (const text of ["ls \u0000 x", "ls \ud800", "echo \u001b[31m", "ls\u202e"]) {
      const cls = classifyCommand(text, "bash", contextOf("linux"));
      expect(cls.findings.map(f => f.cls), JSON.stringify(text)).toContain("unclear");
    }
  });
});

describe("the classifier's speed", () => {
  const texts: [string, ShellId, "linux" | "win32"][] = [
    [Array.from({ length: 40 }, (_, k) => `grep -rn 'needle${k}' src/dir${k} | sort | uniq -c | head -n ${k + 1}`).join(" && "), "bash", "linux"],
    [Array.from({ length: 40 }, (_, k) => `Get-ChildItem -Path .\\src${k} -Recurse | Where-Object { $_.Length -gt ${k} } | Select-Object -First 3`).join("; "), "powershell", "win32"],
    [Array.from({ length: 40 }, (_, k) => `if exist build${k} (echo found ${k}) else (echo none)`).join(" & "), "cmd", "win32"],
    [`cat <<'EOF' > notes.txt\n${"plain words in a here-document, nothing more.\n".repeat(60)}EOF`, "bash", "linux"],
  ];
  for (const [text, shell, where] of texts) {
    it(`classifies ${shell} text in under 5 ms per KiB`, () => {
      const ctx = contextOf(where);
      classifyCommand(text, shell, ctx);
      let best = Infinity;
      for (let k = 0; k < 7; k++) {
        const t0 = performance.now();
        classifyCommand(text, shell, ctx);
        best = Math.min(best, performance.now() - t0);
      }
      expect(best / (text.length / 1024)).toBeLessThan(5);
    });
  }
});
