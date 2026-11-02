/**
 * The repository's own files carry no leftover merge-conflict markers. A merge that kept a conflict block in
 * .claude/rules/design-system.md reached main once (#125), where no other test reads that file.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const SKIP = new Set(["node_modules", "dist", ".git", "worktrees", "out", "release"]);
const TEXT = /\.(md|ts|mts|cts|mjs|cjs|js|css|html|json|ya?ml|py|cs|spec|sh|txt)$/;
const MARKER = /^(<{7}|>{7})( |$)/m;

function textFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) textFiles(p, out);
    else if (e.isFile() && TEXT.test(e.name)) out.push(p);
  }
  return out;
}

describe("the repository's files", () => {
  it("contain no merge-conflict markers (#125's design-system.md)", () => {
    const marked = textFiles(ROOT)
      .filter((f) => f !== __filename && MARKER.test(fs.readFileSync(f, "utf8")))
      .map((f) => path.relative(ROOT, f));
    expect(marked).toEqual([]);
  });
});
