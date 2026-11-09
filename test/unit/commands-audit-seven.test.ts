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
