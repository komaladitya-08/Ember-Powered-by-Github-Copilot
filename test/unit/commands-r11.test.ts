/**
 * Command classes that ran unasked in round eleven's re-rate (commands-remote-r11-*, -c11-*): each test is a table of
 * spellings of one class, with neighbours of each example, and the plain lines beside them that still run. Pure
 * classifier and decision; no Electron. What needs a file the task wrote is in command-flow.test.ts ("programs that run
 * what they are given").
 */

import { describe, expect, it } from "vitest";
import { runCase, type ContextName } from "../fixtures/commands/corpus";
import type { ShellId } from "../../app/main/commands/types";
import { optIs, parseOpts, has, values } from "../../app/main/commands/words";
import { lit } from "../../app/main/commands/words";

interface Opts { words?: string; shell?: ShellId; context?: ContextName; downloaded?: string[]; missing?: string[] }
const result = (cmd: string, o: Opts = {}) =>
  runCase({ cmd, verdict: "run", ...(o.words ? { words: o.words } : {}), ...(o.downloaded ? { downloaded: o.downloaded } : {}), ...(o.missing ? { missing: o.missing } : {}) },
    { shell: o.shell ?? "bash", context: o.context ?? "linux" });
const decide = (cmd: string, o: Opts = {}) => result(cmd, o).decision;

describe("a long option written whole that is a prefix of another (commands-remote-r11-2)", () => {
  it("reads curl's --output as the file it saves, never as --output-dir too", () => {
    for (const [cmd, file] of [
      ["curl --output a.py https://x.example/a", "/home/ana/proj/a.py"], ["curl -s https://x.example/a --output a.py", "/home/ana/proj/a.py"],
      ["curl -fsSL --output notes.txt https://x.example/n", "/home/ana/proj/notes.txt"], ["curl --output ~/.bashrc https://x.example/a", "/home/ana/.bashrc"],
      ["curl --output=report.pdf https://x.example/r", "/home/ana/proj/report.pdf"], ["curl --output-dir d --output a.py https://x.example/a", "/home/ana/proj/d/a.py"],
    ] as const) {
      const r = result(cmd);
      expect(r.cls.downloads, cmd).toEqual([file]);
      expect(r.decision.verdict, cmd).toBe("ask");
      expect(r.decision.rules, cmd).toContain("download.output");
      expect(r.decision.reason, cmd).not.toMatch(/\.py\/|\.txt\/|\.pdf\/|bashrc\//);
    }
    // A new file runs as before; running what it saved asks.
    for (const cmd of ["curl --output a.py https://x.example/a", "curl -o a.py https://x.example/a"]) expect(decide(cmd, { missing: ["/home/ana/proj/a.py"] }).verdict, cmd).toBe("run");
    for (const cmd of ["python3 a.py", "bash a.py", "./a.py"]) expect(decide(cmd, { downloaded: ["/home/ana/proj/a.py"] }).rules, cmd).toContain("escape.run-downloaded");
  });

  it("takes a name the table knows whole as that option only, and an abbreviation as any option it may be", () => {
    const p = parseOpts([lit("--output"), lit("a"), lit("--trace"), lit("t"), lit("--prox"), lit("x")], { longValue: ["output", "output-dir", "trace", "trace-ascii", "proxy", "proxy-user"] });
    expect(values(p, "output-dir")).toEqual([]);
    expect(values(p, "output")).toEqual(["a"]);
    expect(values(p, "trace-ascii")).toEqual([]);
    expect(has(p, "trace")).toBe(true);
    expect(optIs("--output", "output-dir", p.long)).toBe(false);
    // An abbreviation of no name the table knows whole still counts as each name it may stand for.
    expect(optIs("--outp", "output-dir", p.long)).toBe(true);
    expect(optIs("--outp", "output", p.long)).toBe(true);
    // Without a table, as before.
    expect(optIs("--output", "output-dir")).toBe(true);
  });

  it("still reads a proxy's password, as main read --proxy by --proxy-user's prefix", () => {
    for (const cmd of ["curl --proxy http://u:pw@proxy:3128 https://x.example", "curl --proxy-user u:pw https://x.example"]) expect(decide(cmd).rules, cmd).toContain("secret.token-arg");
  });
});
