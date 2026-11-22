/**
 * Round seven's command findings (the audit-seven branch of 9-10 November), ported onto the commands code as it now
 * stands: Ember's own refusals and the dangers it recognises, never a question for what it merely doesn't know
 * (docs/APPROVALS.md).
 */
import { describe, expect, it } from "vitest";
import { type ClassificationExtra, classifyCommand } from "../../app/main/commands/classify";
import { contextOf, runCase } from "../fixtures/commands/corpus";

const decide = (command: string) => runCase({ cmd: command, verdict: "run", context: "linux" }, { shell: "bash", context: "linux" }).decision;
const win = (command: string, shell: "cmd" | "powershell") => runCase({ cmd: command, shell, context: "win32", verdict: "run" }, { shell, context: "win32" }).decision.verdict;

describe("protected paths handed to opaque shell contexts", () => {
  it("refuses Ember's files named through a sh -c text's $0 and $1 (commands-remote-v4-4, v5-2)", () => {
    for (const command of [
      'sh -c \'cat "$0/settings.json"\' ~/.config/ember',
      'sh -c \'cat "$1/settings.json"\' unused ~/.config/ember',
      'd=~/.config/ember; sh -c \'cat "$1/settings.json"\' unused "$d"',
      'sh -c \'cat "$0/ember/settings.json"\' ~/.config',
    ]) expect(decide(command).verdict, command).toBe("refuse");
    expect(decide("sh -c 'echo hello' world").verdict).toBe("run");
    // Listing the home folder is no refusal: only what names Ember's files is.
    expect(decide("sh -c 'ls \"$0\"' ~").verdict).not.toBe("refuse");
    expect(decide("echo $0").verdict).toBe("run");
  });

  it("refuses visible Ember paths when a PowerShell loop or a cmd variable hides their later use (commands-remote-c3-2, i6a)", () => {
    for (const command of [
      '$d = "$env:LOCALAPPDATA\\ember"; foreach ($f in @($d)) { Remove-Item -Recurse $f }',
      'foreach ($d in @("$env:LOCALAPPDATA\\ember")) { Get-Content "$d\\settings.json" }',
      "foreach ($f in @($env:LOCALAPPDATA)) { Remove-Item -Recurse $f }",
    ]) expect(win(command, "powershell"), command).toBe("refuse");
    expect(win('set "D=%LOCALAPPDATA%\\ember" & type "%D%\\settings.json"', "cmd")).toBe("refuse");
    // The folder above Ember's, only listed, and an ordinary variable are not refused.
    expect(win("foreach ($f in Get-ChildItem $env:LOCALAPPDATA) { Write-Output $f.Name }", "powershell")).not.toBe("refuse");
    expect(win('set "D=project" & echo %D%', "cmd")).toBe("run");
    expect(win("set X=1 & dir %USERPROFILE%", "cmd")).toBe("run");
  });
});

describe("database command arguments", () => {
  it("reads the Redis command after an empty options variable as the command it is (commands-q6-1, i6b)", () => {
    for (const command of [
      "O=''; redis-cli $O FLUSHALL", "O=''; redis-cli ${O} FLUSHALL", 'O=""; redis-cli "$O" FLUSHALL', "A=''; B=''; redis-cli $A $B FLUSHALL",
      "O=''; redis-cli -h x $O flushall", "O=''; redis-cli $O FLUSHDB",
    ]) {
      const d = decide(command);
      expect(d.verdict, command).toBe("ask");
      expect(d.classes, command).toContain("destroy");
    }
    expect(decide("O=''; redis-cli $O INFO").verdict).toBe("run");
    expect(decide("redis-cli INFO").verdict).toBe("run");
    expect(decide("O='--rdb /home/ana/.config/ember/settings.json'; redis-cli $O").verdict).toBe("refuse");
  });
});

describe("an archive destination held in a variable", () => {
  it("unpacks into each folder the variable names, never the current one (commands-remote-c7-2, i6b)", () => {
    for (const option of ['-C "$d"', '-C"$d"', '--directory="$d"']) {
      const d = decide(`d=~; tar ${option} -xf /tmp/x.tar`);
      expect(d.verdict, option).toBe("ask");
      expect(d.rules, option).toContain("archive.unpack");
      expect(decide(`d=~/.config/ember; tar ${option} -xf /tmp/x.tar`).verdict, option).toBe("refuse");
    }
    const context = { ...contextOf("linux"), downloaded: new Set(["/home/ana/proj/x.tar"]) };
    const unpack = classifyCommand('d=/tmp; tar -C "$d" -xf x.tar', "bash", context);
    expect(unpack.downloads).toEqual(["/tmp"]);
    const run = classifyCommand("bash /tmp/run.sh", "bash", { ...context, downloaded: new Set(unpack.downloads) });
    expect(run.findings.map(f => f.rule)).toContain("escape.run-downloaded");
    // A folder of the project's own still unpacks as before.
    expect(decide('d=sub; tar -C "$d" -xf x.tar').verdict).toBe("run");
  });
});

describe("scripts in a folder the wrapper chooses", () => {
  const classify = (command: string) => classifyCommand(command, "bash", contextOf("linux")) as ClassificationExtra;

  it("reads a script on stdin from the line's own folder, where the shell opens it (commands-q6-2, i6b)", () => {
    for (const command of ["env -C . sh < deploy.sh", "env --chdir=. bash < deploy.sh", "env -C /tmp -- sh -s < deploy.sh", "env -C. sh <deploy.sh"]) {
      expect(classify(command).scripts.map(s => s.path), command).toContain("/home/ana/proj/deploy.sh");
    }
  });

  it("still asks before a script by a relative name runs from a folder Ember can't tell, and runs what names none (commands-q6-2)", () => {
    for (const command of ["env -C . sh build.sh", "env -C /tmp bash build.sh"]) {
      expect(classify(command).findings.map(f => f.rule), command).toContain("unclear.folder");
      expect(decide(command).verdict, command).toBe("ask");
    }
    expect(decide("env -C . echo hi").verdict).toBe("run");
  });
});

describe("a wrapper's option value Ember can't see", () => {
  it("is read as text that may hold the command itself, as an attached one is (commands-q6-3, i6b, commands-v7-5)", () => {
    for (const command of [
      "xargs -P $(cat jobs.txt) echo", "xargs --max-procs $(cat jobs.txt) echo", "xargs -P $N echo",
      "N='1 rm -rf ~'; xargs -P $N echo", "env -C $(cat folder.txt) echo", "env --chdir $D echo", "nice -n $(cat priority.txt) echo",
      "parallel -j $(cat jobs.txt) echo", "parallel --jobs $N echo", "xargs -a $(cat input.txt) echo",
    ]) {
      const d = decide(command);
      expect(d.verdict, command).toBe("ask");
      expect(d.rules, command).toContain("unclear.program");
    }
  });

  it("still runs a count, a value quoted whole and a folder Ember sees, and refuses Ember's own files (commands-v7-5)", () => {
    for (const command of [
      "xargs -P 4 echo", "xargs -P $(nproc) echo", "xargs --max-procs $(getconf _NPROCESSORS_ONLN) echo", "parallel -j $((2+2)) echo",
      "env -C . echo", "nice -n 4 echo", 'N=4; xargs -P "$N" echo', 'd=input.txt; xargs -a "$d" echo',
    ]) expect(decide(command).verdict, command).toBe("run");
    expect(decide('d=~/.config/ember/settings.json; xargs -a "$d" echo').verdict).toBe("refuse");
    expect(decide("N=4; xargs -P $N cat ~/.config/ember/settings.json").verdict).toBe("refuse");
  });
});

describe("links to folders that hold Ember's", () => {
  const linux = (command: string) => runCase({ cmd: command, verdict: "run", context: "linux", missing: ["/home/ana/bridge"] }, { shell: "bash", context: "linux" }).decision.verdict;

  it("refuses a later part of the line that reaches Ember's settings through a link it made (commands-remote-c7-1, i6a)", () => {
    for (const command of [
      "ln -s ~/.config config-link; cat config-link/ember/settings.json",
      "ln -s ~ home-link; sed -i s/a/b/ home-link/.config/ember/settings.json",
      'base=~/.config; ln -s "$base" config-link; cat config-link/ember/settings.json',
      "ln -s ~/.config links/; cat links/.config/ember/settings.json",
    ]) expect(linux(command), command).toBe("refuse");
    for (const command of [
      "New-Item -ItemType Junction -Path link -Value $env:LOCALAPPDATA; Get-Content link\\ember\\settings.json",
      "$d = $env:LOCALAPPDATA; New-Item -ItemType Junction -Path link -Value $d; Get-Content link\\ember\\settings.json",
    ]) expect(win(command, "powershell"), command).toBe("refuse");
    expect(win("mklink /J link %LOCALAPPDATA% & type link\\ember\\settings.json", "cmd")).toBe("refuse");
  });

  it("reads a symbolic link's relative target beside the link (commands-v7-4)", () => {
    for (const command of [
      "ln -s .config /home/ana/bridge; cat /home/ana/bridge/ember/settings.json",
      "ln -s . /home/ana/bridge; cat /home/ana/bridge/.config/ember/settings.json",
      "ln -sT .config /home/ana/bridge; cat /home/ana/bridge/ember/settings.json",
      "ln --symbolic .config /home/ana/bridge; cat /home/ana/bridge/ember/settings.json",
      'd=/home/ana/bridge; ln -s .config "$d"; cat /home/ana/bridge/ember/settings.json',
    ]) expect(linux(command), command).toBe("refuse");
    expect(win('New-Item -ItemType SymbolicLink -Path "$env:LOCALAPPDATA\\bridge" -Value ember; Get-Content "$env:LOCALAPPDATA\\bridge\\settings.json"', "powershell")).toBe("refuse");
    expect(win('mklink /D "%LOCALAPPDATA%\\bridge" ember & type "%LOCALAPPDATA%\\bridge\\settings.json"', "cmd")).toBe("refuse");
  });

  it("follows the links cp makes too, by any prefix of its long options (commands-remote-c7-1, commands-v7-2)", () => {
    for (const option of ["--symbolic-link", "--sy", "-s", "-as", "--link", "--l"]) {
      expect(linux(`cp ${option} ~/.config config-link; cat config-link/ember/settings.json`), option).toBe("refuse");
    }
  });

  it("still makes ordinary links, and links to those folders, when nothing reaches Ember's files through them", () => {
    for (const command of ["ln -s build build-link", "ln -s notes.txt notes-link", "ln -s ~/.config cfg", "ln -s ~ H; cat H/notes.txt", "ln -sr .config /home/ana/bridge"]) {
      expect(linux(command), command).toBe("run");
    }
    expect(win("New-Item -ItemType Junction -Path link -Value C:\\Users\\ana\\proj; Get-Content link\\a.txt", "powershell")).toBe("run");
  });
});
