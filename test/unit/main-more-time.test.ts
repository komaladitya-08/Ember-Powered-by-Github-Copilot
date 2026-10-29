/**
 * "More time to read and answer" (review #51) reaches every bubble main.ts times itself (cross-review X4): the screen
 * lock's notices (LOCKED_ASK, what stopped while the user was away), macOS's "I can't take screenshots", and the
 * greeting's hideIfStill all stay ten times as long with it on. (The presenters' bubbles are scaled in presenter.ts and
 * pinned in presenter.test.ts; the "Commands are off" hint in host-targets.test.ts.) main.ts can't be loaded in a unit
 * test (it is Electron's entry point), so the wiring is read from its source, as main-privacy-wiring.test.ts does.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/** main.ts without its comments, every run of white space made one space. */
const MAIN = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1").replace(/\s+/g, " ");

/** The source from `from` up to `to`. */
function between(from: string, to: string): string {
  const start = MAIN.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  const end = MAIN.indexOf(to, start + from.length);
  expect(end, to).toBeGreaterThan(-1);
  return MAIN.slice(start, end);
}

describe("main.ts's own bubbles follow More time to read and answer (cross-review X4)", () => {
  it("reads the setting once, as readTimeOf says", () => {
    expect(MAIN).toContain("const readTime = () => readTimeOf(settings.get().moreTime);");
  });

  it("holds the screen lock's notices (showNotice) for their time times the setting, and the bubble as long", () => {
    const body = between("const showNotice = ", "const askEmber = ");
    expect(body).toContain("const time = ms * readTime();");
    expect(body).toContain("claim: () => agent?.claimBubble({ ms: time })");
    expect(body).toMatch(/\}, time\);\s*\};\s*$/);
    // Every notice goes through it with its usual time: the setting scales it there, once.
    expect(MAIN).toContain("showNotice(LOCKED_ASK, 6000)");
    expect(MAIN).toContain("showNotice: n => showNotice(n, 8000)");
  });

  it("keeps macOS's \"I can't take screenshots\" up for 15 s times the setting, and the bubble held as long", () => {
    const body = between("onNoScreenAccess: () => {", "hideOverlay:");
    expect(body).toContain("const time = 15000 * readTime(); agent?.claimBubble({ ms: time });");
    expect(body).toContain("}, time);");
    expect(body).not.toMatch(/\}, 15000\);/);
  });

  it("scales the greeting's hideIfStill, as before", () => {
    expect(between("const hideIfStill = ", "const sc = ")).toContain("}, ms * readTime());");
  });
});
