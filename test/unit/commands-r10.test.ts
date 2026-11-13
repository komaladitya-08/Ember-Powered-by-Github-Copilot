/**
 * Command classes that ran unasked in round ten's re-rate (commands-remote-r10-*, -c10-*): each test is a table of
 * spellings of one class, with neighbours of each example, and the plain lines beside them that still run. Pure
 * classifier and decision; no Electron.
 */

import { describe, expect, it } from "vitest";
import { runCase, type ContextName } from "../fixtures/commands/corpus";
import type { ShellId } from "../../app/main/commands/types";

interface Opts { words?: string; shell?: ShellId; context?: ContextName; downloaded?: string[] }
const result = (cmd: string, o: Opts = {}) =>
  runCase({ cmd, verdict: "run", ...(o.words ? { words: o.words } : {}), ...(o.downloaded ? { downloaded: o.downloaded } : {}) },
    { shell: o.shell ?? "bash", context: o.context ?? "linux" });
const decide = (cmd: string, o: Opts = {}) => result(cmd, o).decision;

describe("python's own options bundled before -m (commands-remote-r10-1)", () => {
  const BUNDLES = ["-Em", "-Im", "-um", "-Bm", "-sm", "-Esm", "-OOm", "-IBm", "-qm"];

  it("lets the module's tool decide whatever short options share the word with m", () => {
    const cases: readonly (readonly [string, string])[] = [
      ["twine upload dist/*", "twine.upload"], ["keyring get github ana", "secret.program"], ["venv --clear .", "posix.rm"],
      ["pip install x", "pkg.language"], ["flask run", "unknown.program"], ["sqlite3 a.db 'drop table x'", "db.change"],
    ];
    for (const b of BUNDLES) for (const [rest, rule] of cases) {
      for (const cmd of [`python3 ${b} ${rest}`, `python3 ${b}${rest}`]) {
        const d = decide(cmd);
        expect(d.verdict, cmd).toBe("ask");
        expect(d.rules, cmd).toContain(rule);
      }
    }
    expect(decide("python3 -Im http.server").verdict).toBe("ask");
  });

  it("still runs everyday modules written the same way", () => {
    for (const cmd of ["python3 -Im pytest", "python3 -Bm pytest -q", "python3 -Im json.tool a.json", "python3 -um unittest", "python3 -Im pip list"]) {
      expect(decide(cmd).verdict, cmd).toBe("run");
    }
  });
});

describe("a short option bundled before an attached value that names a download (commands-remote-r10-2)", () => {
  const CLONE = { downloaded: ["/home/ana/proj/r"] };

  it("asks when flags share the word with an option whose attached value is a downloaded folder or file", () => {
    for (const cmd of ["make -kCr", "make -sCr all", "make -iCr", "gmake -kCr", "ninja -vCr", "make -ksCr", "make -kfr/Makefile", "mvn -qfr/pom.xml test",
      "gradle -qpr test", "just -qfr/justfile", "frobnicate -qcr/x.toml"]) {
      const d = decide(cmd, CLONE);
      expect(d.verdict, cmd).toBe("ask");
      expect(d.rules, cmd).toContain("escape.run-downloaded");
    }
  });

  it("still runs the same clusters with nothing downloaded, or with an unrelated folder", () => {
    for (const cmd of ["make -kCsrc", "make -sC src all", "ninja -vC build"]) expect(decide(cmd, CLONE).verdict, cmd).toBe("run");
    for (const cmd of ["make -kCr", "ninja -vCr"]) expect(decide(cmd).verdict, cmd).toBe("run");
  });
});
