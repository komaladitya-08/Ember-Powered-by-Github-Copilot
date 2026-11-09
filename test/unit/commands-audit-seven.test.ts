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
