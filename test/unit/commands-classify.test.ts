/**
 * The command corpus (design §10.1's CL row, OWNER DECISION 4): every case in test/fixtures/commands/*.json classified
 * on its target and decided, its verdict, classes and rules checked, and the decision's audit `reason` free of paths
 * and of the command. Then the classifier's own promises: it never throws, text it can't parse never counts as
 * ordinary, and it takes under 5 ms per KiB.
 */

import { describe, expect, it } from "vitest";
import type { ShellId } from "../../app/main/commands/types";
import { classifyCommand, MAX_COMMAND_CHARS } from "../../app/main/commands/classify";
import { lexPosix } from "../../app/main/commands/lex-posix";
import { lexPowerShell } from "../../app/main/commands/lex-powershell";
import { lexCmd } from "../../app/main/commands/lex-cmd";
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
