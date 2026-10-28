/**
 * main.ts's notice when macOS refuses Ember the screen (review #96): Perception calls onNoScreenAccess the first time in
 * a run (perception-platform.test.ts), and main shows "I can't take screenshots" with the button that opens System
 * Settings' Screen Recording pane. It comes mid-task, so main holds the bubble while it shows: a task's progress would
 * replace it, and its button, at once. main.ts can't be loaded in a unit test (it is Electron's entry point), so the
 * wiring is read from its source, as main-privacy-wiring.test.ts does.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/** main.ts without its comments, every run of white space made one space. */
const MAIN = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1").replace(/\s+/g, " ");

/** The body of Perception's onNoScreenAccess option in main.ts. */
function notice(): string {
  const start = MAIN.indexOf("onNoScreenAccess: () => {");
  expect(start).toBeGreaterThan(-1);
  return MAIN.slice(start, MAIN.indexOf("hideOverlay:", start));
}

describe("main.ts's Screen Recording notice (review #96)", () => {
  it("offers the Screen Recording pane, only where the OS has that fix", () => {
    const body = notice();
    expect(body).toContain('if (!sys.fixes.ids.includes("open-screen-recording-settings")) return;');
    expect(body).toContain('title: "I can\'t take screenshots"');
    expect(body).toContain('actions: [{ id: "ui:screen-recording", label: sys.fixes.label("open-screen-recording-settings") }]');
    // The button opens the pane through the setup check's own fix.
    expect(MAIN).toContain('if (id === "ui:screen-recording") { sys.fixes.apply("open-screen-recording-settings")');
  });

  it("holds the bubble while it shows, then lets the task's progress back or hides", () => {
    const body = notice();
    expect(body).toMatch(/agent\?\.claimBubble\(\); setState\(\{ bubble \}\);/);
    expect(body).toContain("if (lastState.bubble === bubble && !(agent?.releaseBubble(bubble) ?? false)) setState({ emotion: \"neutral\", bubble: IDLE_BUBBLE });");
  });
});
