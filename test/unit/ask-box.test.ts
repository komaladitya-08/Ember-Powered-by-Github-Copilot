/**
 * The ask box's own words, its field, and the notification text: the placeholder's example is a change Ember can make
 * on every OS (reviews #71, #234); the field keeps a pasted text's lines, grows to four, and says when a paste was cut
 * (review #70); the line under it says all a request carries, whole in its tooltip and to a screen reader, and where it
 * goes with that computer's state (reviews #72, #74, #53); a long notification is cut at a word (review #234).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SETTINGS } from "../../app/main/hands/system";
import { DARWIN_SETTINGS } from "../../app/main/platform/darwin/system/settings";
import { win32Settings } from "../../app/main/platform/win32/system/settings";
import { notificationBody } from "../../app/main/notification";
import { CUT_NOTE, atLimit, enterAction, fieldHeight, fieldLines, historyKey, sendKey } from "../../app/renderer/ask/field";
import { liveWords, seesView } from "../../app/renderer/ask/chips";
import { targetChip } from "../../app/renderer/handle/badge";
import { askSees } from "../../app/main/ask-sees";
import { Perception, openWindowLines, quickContextText, type Seen } from "../../app/main/perception";
import type { AxNode } from "../../app/main/perception/sidecar";
import type { TargetSummary } from "../../app/shared/targets";

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

  it("names the send key as the keyboard does: Return on a Mac (review #77)", () => {
    expect(sendKey("darwin")).toBe("Return");
    expect(sendKey("win32")).toBe("Enter");
    expect(sendKey(null)).toBe("Enter");
    expect(ASK_HTML).toMatch(/<kbd id="key-send">Enter<\/kbd> to send/);
  });

  it("says when the text reached the most that is sent", () => {
    expect(atLimit("x".repeat(1999))).toBe(false);
    expect(atLimit("x".repeat(2000))).toBe(true);
    expect(CUT_NOTE).toBe("Only the first 2000 characters will be sent.");
  });
});

describe("what the ask box says Ember will see", () => {
  const field = (over: Partial<AxNode>): AxNode => ({ id: 1, parent: null, depth: 0, role: "text", name: "Message", states: ["focused"], bounds: null, ...over });
  const seen = (nodes: AxNode[], over: Partial<Seen> = {}): Seen => ({
    window: { app: "thunderbird", pid: 42, name: "Write: Re: Q3", role: "frame", active: true, bounds: null },
    x11Window: null, nodes, blocked: false, busy: false, truncated: null, others: [], ms: 1, axScale: 1, ...over,
  });
  const open = openWindowLines([
    { app: "thunderbird", title: "Write: Re: Q3", active: true },
    { app: "firefox", title: "My bank (focused by the user)", active: false },
    { app: "gedit", title: "notes.txt", active: false, busy: true },
  ]);

  it("names the window and everything else a request carries: the selection or the field's text, other windows' titles", () => {
    const withText = askSees(quickContextText(seen([field({ text: "Dear Ana, about the numbers" })]), open));
    expect(withText).toEqual({ sees: "Thunderbird · Write: Re: Q3", carries: { selection: false, fieldText: true, windows: 2 } });
    expect(seesView(withText)).toEqual({
      text: "Thunderbird · Write: Re: Q3", extra: "+ field text, 2 window titles",
      full: "Ember will see: Thunderbird · Write: Re: Q3, with the start of the focused field's text and the titles of 2 other open windows.",
    });
    const selected = askSees(quickContextText(seen([field({ text: "Dear Ana", selection: "the numbers" })]), open.slice(0, 2)));
    expect(seesView(selected)).toMatchObject({ extra: "+ selected text, 1 window title", full: "Ember will see: Thunderbird · Write: Re: Q3, with the text you selected and the title of 1 other open window." });
    // The X selection added afterwards (an app that doesn't tell it) counts too.
    const primary = askSees(Perception.withSelection(quickContextText(seen([field({})]), []), "copied words"));
    expect(seesView(primary)).toEqual({ text: "Thunderbird · Write: Re: Q3", extra: "+ selected text", full: "Ember will see: Thunderbird · Write: Re: Q3, with the text you selected." });
    expect(seesView(askSees(quickContextText(seen([]), [])))).toEqual({ text: "Thunderbird · Write: Re: Q3", extra: "", full: "Ember will see: Thunderbird · Write: Re: Q3." });
  });

  it("says Ember won't look at a private window, and nothing when it read nothing", () => {
    const priv = askSees(quickContextText(seen([], { blocked: true }), []));
    expect(priv).toEqual({ sees: null, privateWindow: true });
    expect(seesView(priv)).toEqual({ text: "Ember won't look at this window", extra: "", full: "Ember won't look at this window." });
    expect(askSees(null)).toEqual({ sees: null });
    expect(seesView({ sees: null })).toBeNull();
    // A remote with nothing to read: no window, so nothing is claimed.
    expect(askSees({ target: {}, text: "build-01: not connected now.", targetId: "ssh:build-01" })).toEqual({ sees: null });
  });

  it("names where a request goes with that computer's state", () => {
    const t = (over: Partial<TargetSummary>): TargetSummary => ({ id: "ssh:build-01", kind: "ssh", label: "build-01", state: "ready", can: "", active: true, ...over });
    expect(targetChip(t({}))).toBe("On build-01");
    expect(targetChip(t({ state: "lost" }))).toBe("On build-01 (lost)");
    expect(targetChip(t({ state: "connecting" }))).toBe("On build-01 (connecting…)");
    expect(targetChip(t({ id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu (WSL)" }))).toBe("In Ubuntu (WSL)");
    expect(targetChip(t({ id: "local", kind: "local", label: "This computer" }))).toBeNull();
  });

  it("says what Ember will see to screen readers once, when it arrives after the field has the keyboard", () => {
    const late = { sees: "Firefox · Inbox", carries: { selection: false, fieldText: true, windows: 2 } };
    const words = "Ember will see: Firefox · Inbox, with the start of the focused field's text and the titles of 2 other open windows.";
    // An opening clears the region (the next late words are news again), whatever it already knows.
    expect(liveWords(words, { ...late, opened: true })).toBe("");
    expect(liveWords("", { sees: null, opened: true })).toBe("");
    // The late update: the whole sentence, once.
    expect(liveWords("", late)).toBe(words);
    expect(liveWords(words, late)).toBeNull();
    // Something else after all (the user switched windows meanwhile): said again.
    expect(liveWords(words, { sees: "Firefox · Bank" })).toBe("Ember will see: Firefox · Bank.");
    // Nothing to say (a remote with no window): left as it is.
    expect(liveWords("", { sees: null })).toBeNull();
    expect(liveWords("", { sees: null, privateWindow: true })).toBe("Ember won't look at this window.");
  });

  it("keeps the chip's line its full width from the start and gives the late words a live region", () => {
    expect(readFileSync(new URL("../../app/renderer/ask/styles.css", import.meta.url), "utf8")).not.toMatch(/width: fit-content/);
    expect(ASK_HTML).toMatch(/<div id="sees-live" class="sr" role="status" aria-live="polite"><\/div>/);
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
