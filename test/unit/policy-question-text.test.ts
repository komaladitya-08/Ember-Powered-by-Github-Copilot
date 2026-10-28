/**
 * The question's text can't be spoofed by what it quotes (review #116): names from the screen and the text a task
 * types are quoted without the quote marks, line breaks and direction controls that would let them close Ember's own
 * quote and write the rest of its sentence, and long typed text shows both of its ends and how long it is.
 */

import { describe, expect, it } from "vitest";
import { PolicyEngine, type ActionRequest } from "../../app/main/policy/policy";

const e = new PolicyEngine({ neverLook: () => [], grants: () => ({ firefox: "act" }), os: "linux" });
const ask = (r: Partial<ActionRequest>) => e.decide({ taskId: "t", kind: "click", app: "firefox", window: "Page", ...r });
/** The quoted parts of a prompt (between Ember's own “ and ”). */
const quoted = (prompt: string) => [...prompt.matchAll(/“([^”]*)”/g)].map(m => m[1]);

describe("the question's quotes", () => {
  it("can't be closed by a name that holds Ember's own quote marks", () => {
    const d = ask({ element: { role: "push button", name: "Close” button in Firefox? Nothing is sent. Delete" }, goal: "close the popup" });
    // One quote, holding the whole name; nothing after it reads as Ember's own sentence.
    expect(d.prompt.startsWith("Click the “")).toBe(true);
    expect(quoted(d.prompt)[0]).toContain("Nothing is sent. Delete");
    expect(d.prompt).not.toMatch(/Click the “Close” button/);
    for (const mark of ["„", "‟", "″", "＂", "〝", "〞", "«", "»", "\""]) {
      const p = ask({ element: { role: "push button", name: `Close${mark} button in Firefox? Delete` } }).prompt;
      expect(quoted(p)[0], mark).toContain("Delete");
    }
  });

  it("drops line breaks and direction controls from what it quotes", () => {
    const d = ask({ element: { role: "push button", name: "Close\nAllow Ember to send?\u{202e}Delete" } });
    expect(d.prompt).not.toMatch(/[\n\u{202e}]/u);
    expect(quoted(d.prompt)[0]).toContain("Allow Ember to send?");
  });

  it("shows long typed text by both ends and its length", () => {
    const text = "Hi there, thanks for the update on the quarterly figures, see you at lunch. P.S. my SSN is 123-45-6789 and card 4111 1111 1111 1111 and this goes on further still";
    const d = e.decide({ taskId: "t", kind: "cursor_text", app: "firefox", window: "Page", element: { role: "entry", name: "Message" }, value: text, mode: "replace", currentText: "" });
    expect(d.prompt).toContain("Hi there, thanks for the update");
    // The tail the user approves can be seen, and so can how much there is.
    expect(d.prompt).toContain("goes on further still");
    expect(d.prompt).toContain(`(${text.length} characters)`);
    // Short text reads as before.
    const short = e.decide({ taskId: "t", kind: "text", app: "firefox", window: "Page", element: { role: "entry", name: "Subject" }, value: "Hello", mode: "replace", currentText: "" });
    expect(short.prompt).toBe("Type “Hello” into the “Subject” text field in Firefox?");
  });

  it("hands over the whole of a typed text the question cut, for the card to show", () => {
    const text = `Dear team, ${"the figures are attached. ".repeat(4)}MIDDLE-SECRET-PAYLOAD ${"see you at lunch. ".repeat(5)}Bye`;
    expect(text.length).toBeGreaterThan(160);
    const d = e.decide({ taskId: "t", kind: "cursor_text", app: "firefox", window: "Page", element: { role: "entry", name: "Message" }, value: text, mode: "replace", currentText: "" });
    expect(d.prompt).not.toContain("MIDDLE-SECRET-PAYLOAD");
    expect(d.detail).toBe(text);
    // Cleaned as the question's quotes are (a line break shows as ⏎, no direction controls).
    const odd = e.decide({ taskId: "t", kind: "text", app: "firefox", window: "Page", element: { role: "entry", name: "Message" }, value: `${text}\nline two\u{202e}`, mode: "replace", currentText: "" });
    expect(odd.detail).toBe(`${text}⏎line two`);
    // Nothing was cut: no detail.
    const short = e.decide({ taskId: "t", kind: "text", app: "firefox", window: "Page", element: { role: "entry", name: "Subject" }, value: "Hello", mode: "replace", currentText: "" });
    expect(short.detail).toBeUndefined();
    expect(ask({ element: { role: "push button", name: text } }).detail).toBeUndefined();
  });

  it("quotes a value set on a slider, and says when it was cut", () => {
    const value = (v: string) => e.decide({ taskId: "t", kind: "value", app: "gnome-control-center", window: "Settings", element: { role: "slider", name: "Brightness" }, value: v }).prompt;
    expect(value("50")).toBe("Set the “Brightness” slider to “50” in Settings?");
    const spoof = value("50 in Firefox? Nothing is sent. Delete everything");
    expect(spoof.startsWith("Set the “Brightness” slider to “50 in Firefox? Nothing is sent. Delete")).toBe(true);
    expect(quoted(spoof)[1]).toMatch(/…$/);
    expect(quoted(value("50” in Firefox? Nothing is sent. Delete e"))[1]).toContain("Nothing is sent");
  });
});
