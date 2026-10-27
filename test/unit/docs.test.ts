/**
 * The user and administrator docs (README.md, CHANGELOG.md, docs/*.md) against the code they describe: each case reads
 * the fact from the code or the packaging data and checks the docs say it, so a change on one side shows up here.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTERS } from "../../app/main/settings";
import { layoutFor, REMOTE_PARTS_DIR } from "../../scripts/package/layout.mjs";

const read = (file: string) => fs.readFileSync(path.resolve(file), "utf8");
/** Text with its line breaks and runs of spaces made single spaces, so a phrase can span wrapped lines. */
const flat = (s: string) => s.replace(/\s+/g, " ");
/** One section of a Markdown file: from its heading to the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const at = lines.findIndex(l => l.startsWith("#") && l.replace(/^#+\s*/, "") === heading);
  if (at < 0) throw new Error(`no section "${heading}"`);
  const level = /^#+/.exec(lines[at])![0].length;
  const end = lines.findIndex((l, i) => i > at && /^#+\s/.test(l) && /^#+/.exec(l)![0].length <= level);
  return lines.slice(at, end < 0 ? undefined : end).join("\n");
}

describe("docs/DESIGN.md", () => {
  it("names only the places where a character can really be chosen", () => {
    const main = read("app/main/main.ts");
    // The handle menu: showMenu's template, from Menu.buildFromTemplate to the end of its list.
    const start = main.indexOf("const menu = Menu.buildFromTemplate([");
    expect(start).toBeGreaterThan(0);
    const menu = main.slice(start, main.indexOf("]);", start));
    const menuPicks = CHARACTERS.some(c => new RegExp(c, "i").test(menu)) || /character/i.test(menu);
    const chosen = /chosen in ([^.]+)\./.exec(flat(read("docs/DESIGN.md")))?.[1] ?? "";
    expect(chosen).not.toBe("");
    expect(/handle menu/.test(chosen)).toBe(menuPicks);
  });
});

describe("docs/DEVELOPING.md", () => {
  it("§10.5 says what every file Ember stages beside the Windows app is", () => {
    const table = section(read("docs/DEVELOPING.md"), "10.5 Packages");
    const win = layoutFor("win32", "x64");
    // resources\sidecar\uia\ is one entry for the bridge's two files; every other staged file is named on its own.
    const named = [...new Set(win.sidecarFiles.map(f => (f.to.startsWith("sidecar/uia/") ? "sidecar/uia/" : f.to)))];
    for (const rel of [...named, `${REMOTE_PARTS_DIR}/`]) expect(table).toContain(`resources\\${rel.replace(/\//g, "\\")}`);
    for (const l of win.launchers ?? []) expect(table).toContain(l.to);
  });
});
