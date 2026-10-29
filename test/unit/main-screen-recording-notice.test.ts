/**
 * main.ts's notice when macOS refuses Ember the screen (review #96): Perception calls onNoScreenAccess the first time in
 * a run (perception-platform.test.ts), and main shows "I can't take screenshots" with a button to the setup check, whose
 * Screen Recording row opens System Settings (only the settings window applies a fix: setup-check.test.ts). It comes
 * mid-task, so main holds the bubble while it shows: a task's progress would replace it, and its button, at once.
 * main.ts can't be loaded in a unit test (it is Electron's entry point), so the wiring is read from its source, as
 * main-privacy-wiring.test.ts does.
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
  it("offers the setup check, where the OS has the Screen Recording fix, and applies no fix itself", () => {
    const body = notice();
    expect(body).toContain('if (!sys.fixes.ids.includes("open-screen-recording-settings")) return;');
    expect(body).toContain('title: "I can\'t take screenshots"');
    expect(body).toContain('actions: [{ id: "ui:setup-check", label: "Open setup check" }]');
    expect(body).not.toMatch(/\.apply\(|applyFix|applySetupFix/);
    // The button opens the settings window at the setup check, and lets the bubble go.
    expect(MAIN).toContain('if (id === "ui:setup-check") { showHome(); sendToHome(IPC.focusSection, "checks"); agent?.releaseBubble(lastState.bubble); return; }');
  });

  it("holds the bubble while it shows, then lets the task's progress back or hides", () => {
    const body = notice();
    // (Held as long as it shows: ten times as long with More time to read and answer, main-more-time.test.ts.)
    expect(body).toMatch(/agent\?\.claimBubble\(\{ ms: time \}\); setState\(\{ bubble \}\);/);
    expect(body).toContain("if (lastState.bubble === bubble && !(agent?.releaseBubble(bubble) ?? false)) setState({ emotion: \"neutral\", bubble: IDLE_BUBBLE });");
  });

  it("tells Perception the OS, for its log", () => {
    expect(MAIN).toContain("isRemoteSurface: remoteSurfaceCheck(platform.os), os: platform.os,");
  });
});
