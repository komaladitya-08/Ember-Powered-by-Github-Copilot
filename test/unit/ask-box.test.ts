/**
 * The ask box's own words, its field, and the notification text: the concise placeholder leaves room for Send;
 * the field keeps a pasted text's lines, grows to four, and says when a paste was cut
 * (review #70); the line under it says all a request carries, whole in its tooltip and to a screen reader, and where it
 * goes with that computer's state (reviews #72, #74, #53); a long notification is cut at a word (review #234).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { notificationBody } from "../../app/main/notification";
import { ASK_OVER, askCount, auxiliaryRows, boxRows, enterAction, fieldHeight, fieldLines, historyKey, overLimit, sendKey, textScaleOf } from "../../app/renderer/ask/field";
import { composerCount } from "../../app/renderer/home/copy";
import { ANSWERS_AGAIN, heldNewsLine, liveWords, seesView, unavailableLine } from "../../app/renderer/ask/chips";
import { targetChip, targetChipParts } from "../../app/renderer/handle/badge";
import { askSees } from "../../app/main/ask-sees";
import { Perception, openWindowLines, quickContextText, type Seen } from "../../app/main/perception";
import type { AxNode } from "../../app/main/perception/sidecar";
import type { TargetSummary } from "../../app/shared/targets";

const ASK_HTML = readFileSync(new URL("../../app/renderer/ask/index.html", import.meta.url), "utf8");

describe("the ask box's placeholder", () => {
  it("keeps its prompt concise beside Send and retains the full accessible label", () => {
    const placeholder = /placeholder="([^"]*)"/.exec(ASK_HTML)?.[1] ?? "";
    expect(placeholder).toBe("Ask or tell me…");
    expect(ASK_HTML).toContain('<label for="q" class="sr">Ask or tell me</label>');
  });
});

describe("the ask box when Ember can't answer a request now (companion-6)", () => {
  it("says why in the handle's word, and that a request would get no answer yet, in the first person", () => {
    expect(unavailableLine(undefined)).toBeNull();
    expect(unavailableLine("Not connected")).toBe("Not connected: I can't answer yet");
    // Back while the box is open, its live region says so (companion-6).
    expect(ANSWERS_AGAIN).toBe("I can answer again.");
    expect(unavailableLine("Offline")).toBe("Offline: I can't answer yet");
    // An ellipsis says something is under way; before the colon it reads as cut off.
    expect(unavailableLine("Reconnecting…")).toBe("Reconnecting: I can't answer yet");
  });

  it("is said at the start of the line under the field, and is part of what describes the field", () => {
    expect(ASK_HTML).toMatch(/<p class="meta"><span id="unavailable" class="unavailable" hidden><\/span>/);
    expect(ASK_HTML).toContain('aria-describedby="unavailable where cut tip hint sees"');
    const main = readFileSync(new URL("../../app/main/main.ts", import.meta.url), "utf8");
    expect(main.match(/unavailable: unansweredWord\(agent\?\.getStatus\(\)\) \?\? undefined/g)).toHaveLength(2);
  });
});

describe("the ask box's field", () => {
  it("is a growing text area that keeps lines, not a one-line input that flattens them", () => {
    expect(ASK_HTML).toMatch(/<textarea id="q" rows="1"/);
    // A paste is kept whole (no maxlength cutting its end off unseen): the count says how much to shorten it (companion-i1).
    expect(ASK_HTML).not.toContain("maxlength");
    expect(ASK_HTML).not.toMatch(/<input id="q"/);
    // On its own line under the one that says what Ember will see, never crowding it (the window grows a line for it).
    expect(ASK_HTML).toMatch(/<\/p>\s*(<!--[^>]*-->\s*)?<p id="cut" class="cut" hidden><\/p>/);
    expect(/<p class="meta">[\s\S]*?<\/p>/.exec(ASK_HTML)?.[0]).not.toContain('id="cut"');
  });

  it("grows a line at a time to four, then scrolls", () => {
    expect([46, 70, 94, 118, 142, 400, 0].map(h => fieldLines(h))).toEqual([1, 2, 3, 4, 4, 4, 1]);
    expect([1, 2, 4].map(n => fieldHeight(n))).toEqual([46, 70, 118]);
  });

  it("grows by lines of the text size, measured at it (review #57)", () => {
    // Larger (1.3): a 59.8 px field and 31.2 px lines; the page's scrollHeight is whole px.
    expect([60, 91, 122, 153, 184, 400].map(h => fieldLines(h, 1.3))).toEqual([1, 2, 3, 4, 4, 4]);
    expect([1, 2, 4].map(n => fieldHeight(n, 1.3))).toEqual([59.8, 91, 153.4].map(v => expect.closeTo(v, 5)));
    // Large (1.15): 52.9 px, then 27.6 px a line.
    expect([53, 81, 108, 136].map(h => fieldLines(h, 1.15))).toEqual([1, 2, 3, 4]);
    // The rows main grows the window by are the same lines (ask.ts grownBounds: 24 px a row times the scale).
    expect(fieldHeight(4, 1.3) - fieldHeight(1, 1.3)).toBeCloseTo(3 * 24 * 1.3, 5);
  });

  it("reads the text size from the page's --text-scale, and the default's 1 from anything else", () => {
    expect(textScaleOf("1.3")).toBe(1.3);
    expect(textScaleOf(" 1.15")).toBe(1.15);
    for (const bad of ["", "  ", "large", "-1", "0", "NaN"]) expect(textScaleOf(bad), bad).toBe(1);
  });

  it("sends with Enter, adds a line with Shift+Enter, and leaves an input method's Enter alone", () => {
    expect(enterAction({ shiftKey: false, isComposing: false })).toBe("send");
    expect(enterAction({ shiftKey: true, isComposing: false })).toBe("newline");
    expect(enterAction({ shiftKey: false, isComposing: true })).toBe("compose");
  });

  it("offers an explicit submit control and budgets every wrapped suggestion and Listen once row", () => {
    expect(ASK_HTML).toContain('<button id="send" class="send" type="submit" disabled>Send</button>');
    for (const scale of [1, 1.15, 1.3]) {
      expect(auxiliaryRows(0, scale)).toBe(0);
      expect(auxiliaryRows(28 * scale + 14, scale)).toBe(2);
      const suggestions = auxiliaryRows(112 * scale, scale);
      expect(suggestions).toBeGreaterThan(1);
      expect(suggestions * 24 * scale).toBeGreaterThanOrEqual(112 * scale + 4);
      expect(boxRows(1, false, false, suggestions, 2)).toBe(3 + suggestions);
    }
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

  it("counts a long request near the most that is sent, and says how much to shorten one over it, as Home does (companion-i1)", () => {
    expect(askCount(1799)).toBe("");
    expect(askCount(1800)).toBe("1,800 of 2,000 characters.");
    expect(askCount(2000)).toBe("2,000 of 2,000 characters.");
    expect(askCount(2423)).toBe("2,423 of 2,000 characters, 423 too many.");
    for (const n of [1799, 1800, 2000, 2001, 3263]) expect(askCount(n), String(n)).toBe(composerCount(n));
    expect(overLimit("x".repeat(2000))).toBe(false);
    expect(overLimit("x".repeat(2001))).toBe(true);
    expect(ASK_OVER).toBe("This request is longer than 2,000 characters. Shorten it to send it.");
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
      text: "Thunderbird · Write: Re: Q3", extra: "+ field text, 2 window titles", brief: "+ text, 2 titles",
      full: "I'll see: Thunderbird · Write: Re: Q3, with the start of the focused field's text and the titles of 2 other open windows.",
    });
    const selected = askSees(quickContextText(seen([field({ text: "Dear Ana", selection: "the numbers" })]), open.slice(0, 2)));
    expect(seesView(selected)).toMatchObject({ extra: "+ selected text, 1 window title", brief: "+ selection, 1 title", full: "I'll see: Thunderbird · Write: Re: Q3, with the text you selected and the title of 1 other open window." });
    // The X selection added afterwards (an app that doesn't tell it) counts too.
    const primary = askSees(Perception.withSelection(quickContextText(seen([field({})]), []), "copied words"));
    expect(seesView(primary)).toEqual({ text: "Thunderbird · Write: Re: Q3", extra: "+ selected text", brief: "+ selection", full: "I'll see: Thunderbird · Write: Re: Q3, with the text you selected." });
    expect(seesView(askSees(quickContextText(seen([]), [])))).toEqual({ text: "Thunderbird · Write: Re: Q3", extra: "", brief: "", full: "I'll see: Thunderbird · Write: Re: Q3." });
  });

  it("says Ember won't look at a private window, and nothing when it read nothing", () => {
    const priv = askSees(quickContextText(seen([], { blocked: true }), []));
    expect(priv).toEqual({ sees: null, privateWindow: true });
    expect(seesView(priv)).toEqual({ text: "I won't look at this window", extra: "", brief: "", full: "I won't look at this window." });
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
    // In two parts on the box: the name may be shortened on a crowded line, the state never is.
    expect(targetChipParts(t({ label: "deploy@build-server-01", state: "lost" }))).toEqual({ name: "On deploy@build-server-01", state: " (lost)" });
    expect(targetChipParts(t({}))).toEqual({ name: "On build-01", state: "" });
    expect(targetChipParts(null)).toBeNull();
    expect(ASK_HTML).toMatch(/<span id="where" class="where" hidden><span id="where-name" class="where-name"><\/span><span id="where-state" class="where-state"><\/span><\/span>/);
  });

  it("says what Ember will see to screen readers once, when it arrives after the field has the keyboard", () => {
    const late = { sees: "Firefox · Inbox", carries: { selection: false, fieldText: true, windows: 2 } };
    const words = "I'll see: Firefox · Inbox, with the start of the focused field's text and the titles of 2 other open windows.";
    // An opening clears the region (the next late words are news again), whatever it already knows.
    expect(liveWords(words, { ...late, opened: true })).toBe("");
    expect(liveWords("", { sees: null, opened: true })).toBe("");
    // The late update: the whole sentence, once.
    expect(liveWords("", late)).toBe(words);
    expect(liveWords(words, late)).toBeNull();
    // Something else after all (the user switched windows meanwhile): said again.
    expect(liveWords(words, { sees: "Firefox · Bank" })).toBe("I'll see: Firefox · Bank.");
    // Nothing to say (a remote with no window): left as it is.
    expect(liveWords("", { sees: null })).toBeNull();
    expect(liveWords("", { sees: null, privateWindow: true })).toBe("I won't look at this window.");
  });

  it("never says Ember's name where a screen reader saying it into the wake word's microphone wakes Ember (voice-listening-i5)", () => {
    // Each opening says what the box will see, and "Ember will see: Text Editor · notes.txt, …" woke Ember and sent the
    // window's title as a request in 20 of 20 real-model placements ("Ember won't look at this window." in 17 of 20).
    const lines = [seesView({ sees: "Text Editor · notes.txt", carries: { selection: true, fieldText: false, windows: 2 } })!, seesView({ sees: null, privateWindow: true })!]
      .flatMap(v => [v.full, v.text]);
    for (const line of lines) expect(line).not.toMatch(/\bEmber\b/);
  });

  it("says what waited for the microphone as it stands then, each kind once and as a sentence, never a line it overtook (voice-listening-v5-2)", () => {
    const sees = "I'll see: Text Editor · Notes.txt.", offline = "Offline: I can't answer yet";
    // Offline and back while it waited: only the window is news ("Offline: I can't answer yet I'll see: … I can answer
    // again." was said as one sentence, the first line long gone).
    expect(heldNewsLine({ cantFrom: "", seesFrom: "" }, { sees, cant: "", over: false }, ASK_OVER)).toBe(sees);
    // Both changed: the window first, then why it can't answer, each ending as a sentence.
    expect(heldNewsLine({ cantFrom: "", seesFrom: "" }, { sees, cant: offline, over: false }, ASK_OVER)).toBe(`${sees} ${offline}.`);
    expect(heldNewsLine({ cantFrom: offline }, { sees, cant: "", over: false }, ASK_OVER)).toBe(ANSWERS_AGAIN);
    expect(heldNewsLine({ cantFrom: "Not connected: I can't answer yet" }, { sees, cant: offline, over: false }, ASK_OVER)).toBe(`${offline}.`);
    // Changed and changed back: nothing.
    expect(heldNewsLine({ cantFrom: offline, seesFrom: sees }, { sees, cant: offline, over: false }, ASK_OVER)).toBe("");
    // Over the most that is sent: said only while the request still is.
    expect(heldNewsLine({ over: true }, { sees, cant: "", over: true }, ASK_OVER)).toBe(ASK_OVER);
    expect(heldNewsLine({ over: true }, { sees, cant: "", over: false }, ASK_OVER)).toBe("");
    expect(heldNewsLine({}, { sees, cant: offline, over: true }, ASK_OVER)).toBe("");
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
