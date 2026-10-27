/**
 * The ask box's own words, its field, and the notification text: the placeholder's example is a change Ember can make
 * on every OS (reviews #71, #234); the field keeps a pasted text's lines, grows to four, and says when a paste was cut
 * (review #70); a long notification is cut at a word with an ellipsis (review #234).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTINGS } from "../../app/main/hands/system";
import { DARWIN_SETTINGS } from "../../app/main/platform/darwin/system/settings";
import { win32Settings } from "../../app/main/platform/win32/system/settings";
import { notificationBody } from "../../app/main/notification";
import { CUT_NOTE, atLimit, enterAction, fieldHeight, fieldLines, historyKey } from "../../app/renderer/ask/field";

const ASK_HTML = readFileSync(new URL("../../app/renderer/ask/index.html", import.meta.url), "utf8");

describe("the ask box's placeholder", () => {
  it("gives an example every OS can do: dark mode, not GNOME's Night Light", () => {
    const placeholder = /placeholder="([^"]*)"/.exec(ASK_HTML)?.[1] ?? "";
    expect(placeholder).toBe("Ask or tell Ember… e.g. “turn on dark mode”");
    expect(placeholder).not.toMatch(/night/i);
    for (const offered of [SETTINGS, DARWIN_SETTINGS, win32Settings({ api: () => null }).available]) expect(offered).toHaveProperty("dark_style");
  });
});

describe("the ask box's field", () => {
  it("is a growing text area that keeps lines, not a one-line input that flattens them", () => {
    expect(ASK_HTML).toMatch(/<textarea id="q" rows="1"[^>]*maxlength="2000"/);
    expect(ASK_HTML).not.toMatch(/<input id="q"/);
    expect(ASK_HTML).toMatch(/<span id="cut" class="cut" role="status" hidden><\/span>/);
  });

  it("grows a line at a time to four, then scrolls", () => {
    expect([46, 70, 94, 118, 142, 400, 0].map(fieldLines)).toEqual([1, 2, 3, 4, 4, 4, 1]);
    expect([1, 2, 4].map(fieldHeight)).toEqual([46, 70, 118]);
  });

  it("sends with Enter, adds a line with Shift+Enter, and leaves an input method's Enter alone", () => {
    expect(enterAction({ shiftKey: false, isComposing: false })).toBe("send");
    expect(enterAction({ shiftKey: true, isComposing: false })).toBe("newline");
    expect(enterAction({ shiftKey: false, isComposing: true })).toBe("compose");
  });

  it("goes through earlier questions only from the first line (↑) or the last (↓)", () => {
    const text = "line one\nline two";
    expect(historyKey(text, 3, 3, "ArrowUp")).toBe(true);
    expect(historyKey(text, 12, 12, "ArrowUp")).toBe(false);
    expect(historyKey(text, 12, 12, "ArrowDown")).toBe(true);
    expect(historyKey(text, 3, 3, "ArrowDown")).toBe(false);
    expect(historyKey("one line", 0, 4, "ArrowUp")).toBe(false);
  });

  it("says when the text reached the most that is sent", () => {
    expect(atLimit("x".repeat(1999))).toBe(false);
    expect(atLimit("x".repeat(2000))).toBe(true);
    expect(CUT_NOTE).toBe("Only the first 2000 characters will be sent.");
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
