/**
 * The user and administrator docs (README.md, CHANGELOG.md, docs/*.md) against the code they describe: each case reads
 * the fact from the code or the packaging data and checks the docs say it, so a change on one side shows up here.
 */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTERS } from "../../app/main/settings";

const read = (file: string) => fs.readFileSync(path.resolve(file), "utf8");
/** Text with its line breaks and runs of spaces made single spaces, so a phrase can span wrapped lines. */
const flat = (s: string) => s.replace(/\s+/g, " ");

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
