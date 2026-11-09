/** Round-seven regressions: uncertain shell execution must retain the baseline's question. */
import { describe, expect, it } from "vitest";
import { classifyCommand } from "../../app/main/commands/classify";
import { withoutReadFlow } from "../../app/main/commands/scripts";
import { contextOf, runCase } from "../fixtures/commands/corpus";

const classify = (command: string) => classifyCommand(command, "bash", contextOf("linux"));
const decide = (command: string) => runCase({ cmd: command, verdict: "run", context: "linux" }, { shell: "bash", context: "linux" }).decision;

describe("the baseline's shell questions", () => {
  it("keeps the question for an ordinary command-line if (commands-remote-r7-1)", () => {
    for (const command of ["if true; then ls; fi", "if [ -f package.json ]; then npm test; fi", "if git diff --quiet; then echo clean; else echo dirty; fi"]) {
      expect(withoutReadFlow(classify(command), "bash").findings.map(f => f.rule), command).toContain("unclear.if");
    }
  });

  it("keeps error-checking parameter expansions uncertain while refusing its own files (commands-remote-r7-1)", () => {
    for (const variable of ["HOME", "PWD"]) {
      for (const operator of ["?", ":?", "?missing", ":?missing"]) {
        expect(decide(`cat "\${${variable}${operator}}/notes.txt"`).verdict).toBe("ask");
      }
    }
    expect(decide('cat "${HOME:?}/.config/ember/settings.json"').verdict).toBe("refuse");
    expect(decide('cat "$HOME/notes.txt"').verdict).toBe("run");
  });
});

describe("download provenance", () => {
  it("asks and keeps provenance for an unresolved URL, an attached output, or xargs input (commands-remote-r6-1, i6a)", () => {
    for (const command of [
      'V=1; curl -LO https://example.com/tool-$V.tar.gz',
      'V=1; curl -LO "https://example.com/tool-${V}.tar.gz"',
      'xargs -n1 curl -sO < urls.txt',
      'for u in https://example.com/run.sh; do curl -sO "$u"; done',
      'f=run.sh; curl -o"$f" https://example.com/run.sh',
      'f=run.sh; wget -O"$f" https://example.com/run.sh',
    ]) {
      const result = classify(command);
      expect(result.downloads.length, command).toBeGreaterThan(0);
      expect(result.findings.map(f => f.rule), command).toContain("download.unnamed");
    }
    const data = classify('curl -LO https://example.com/data.csv');
    expect(data.downloads).toEqual(["/home/ana/proj/data.csv"]);
    expect(classifyCommand("python3 analyze.py", "bash", { ...contextOf("linux"), downloaded: new Set(data.downloads) }).findings).toEqual([]);
  });
});

describe("database command arguments", () => {
  it("asks when an empty options variable exposes a destructive Redis command (commands-q6-1, i6b)", () => {
    expect(decide("O=''; redis-cli $O FLUSHALL").verdict).toBe("ask");
    expect(decide("O=''; redis-cli ${O} FLUSHALL").verdict).toBe("ask");
    expect(decide("redis-cli INFO").verdict).toBe("run");
    expect(decide("O='--rdb /home/ana/.config/ember/settings.json'; redis-cli $O").verdict).toBe("refuse");
  });
});

describe("scripts in a folder the wrapper chooses", () => {
  it("asks before a relative script is run from an unknown folder (commands-q6-2, i6b)", () => {
    for (const command of ["env -C . sh < deploy.sh", "env --chdir=. bash < deploy.sh", "env -C . sh deploy.sh"]) {
      expect(classify(command).findings.map(f => f.rule), command).toContain("unclear.script-folder");
    }
  });
});

describe("an archive destination held in a variable", () => {
  it("asks instead of treating the unknown extraction folder as the project (commands-remote-c7-2, i6b)", () => {
    for (const option of ['-C "$d"', '-C"$d"', '--directory="$d"']) {
      expect(decide(`d=~; tar ${option} -xf /tmp/x.tar`).verdict, option).toBe("ask");
    }
    const context = { ...contextOf("linux"), downloaded: new Set(["/home/ana/proj/x.tar"]) };
    const unpack = classifyCommand('d=/tmp; tar -C "$d" -xf x.tar', "bash", context);
    const run = classifyCommand("bash /tmp/run.sh", "bash", { ...context, downloaded: new Set(unpack.downloads) });
    expect(run.findings.map(f => f.rule)).toContain("escape.run-downloaded");
    expect(decide('d=~/.config/ember; tar -C "$d" -xf /tmp/x.tar').verdict).toBe("refuse");
  });
});

describe("xargs child environments", () => {
  it("asks before process-slot-var can select a startup file or executable (commands-remote-c7-3, i6a)", () => {
    for (const name of ["BASH_ENV", "PATH", "LD_PRELOAD", "SLOT"]) {
      for (const option of [`--process-slot-var=${name}`, `--process-slot-var ${name}`]) {
        expect(decide(`xargs -P4 ${option} bash -c 'echo okay' < urls.txt`).verdict, option).toBe("ask");
      }
    }
    expect(decide("xargs -P4 --process-slot-var=$NAME echo < urls.txt").verdict).toBe("ask");
    expect(decide("xargs -n1 echo < words.txt").verdict).toBe("run");
  });
});

describe("links to folders containing Ember", () => {
  it("refuses a parent-folder link before later commands can reach its settings through it (commands-remote-c7-1, i6a)", () => {
    for (const command of [
      "ln -s ~/.config config-link; cat config-link/ember/settings.json",
      "ln -s ~ home-link; sed -i s/a/b/ home-link/.config/ember/settings.json",
      'base=~/.config; ln -s "$base" config-link; cat config-link/ember/settings.json',
    ]) expect(decide(command).verdict, command).toBe("refuse");
    expect(decide("ln -s build build-link").verdict).toBe("run");
    for (const command of ['New-Item -ItemType Junction -Path link -Value $env:LOCALAPPDATA; Get-Content link\\ember\\settings.json', '$d = $env:LOCALAPPDATA; New-Item -ItemType Junction -Path link -Value $d; Get-Content link\\ember\\settings.json']) {
      expect(runCase({ cmd: command, verdict: "run", context: "win32", shell: "powershell" }, { context: "win32", shell: "powershell" }).decision.verdict, command).toBe("refuse");
    }
  });
});
