/**
 * The ask box's own words and the notification text (reviews #71, #234): the placeholder's example is a change Ember
 * can make on every OS, and a long notification is cut at a word with an ellipsis.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTINGS } from "../../app/main/hands/system";
import { DARWIN_SETTINGS } from "../../app/main/platform/darwin/system/settings";
import { win32Settings } from "../../app/main/platform/win32/system/settings";
import { notificationBody } from "../../app/main/notification";

const ASK_HTML = readFileSync(new URL("../../app/renderer/ask/index.html", import.meta.url), "utf8");

describe("the ask box's placeholder", () => {
  it("gives an example every OS can do: dark mode, not GNOME's Night Light", () => {
    const placeholder = /placeholder="([^"]*)"/.exec(ASK_HTML)?.[1] ?? "";
    expect(placeholder).toBe("Ask or tell Ember… e.g. “turn on dark mode”");
    expect(placeholder).not.toMatch(/night/i);
    for (const offered of [SETTINGS, DARWIN_SETTINGS, win32Settings({ api: () => null }).available]) expect(offered).toHaveProperty("dark_style");
  });
});

describe("a notification's body", () => {
  it("stays as it is when it fits", () => {
    expect(notificationBody("Ember needs your OK to press Save.")).toBe("Ember needs your OK to press Save.");
    expect(notificationBody("x".repeat(240))).toBe("x".repeat(240));
  });

  it("is cut at a word, with an ellipsis, never mid-word", () => {
    const long = `Turn the quarterly sales spreadsheet into a summary ${"with several more words ".repeat(12)}and the end`;
    const body = notificationBody(long);
    expect(body.length).toBeLessThanOrEqual(240);
    expect(body.endsWith("…")).toBe(true);
    expect(long.startsWith(body.slice(0, -1))).toBe(true);
    expect(long[body.length - 1]).toBe(" ");
  });

  it("cuts one long word where it must, with the ellipsis", () => {
    const body = notificationBody("a".repeat(300));
    expect(body).toBe(`${"a".repeat(239)}…`);
  });
});
