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
    expect(d.prompt.startsWith("Click “")).toBe(true);
    expect(quoted(d.prompt)[0]).toContain("Nothing is sent. Delete");
    expect(d.prompt).not.toMatch(/Click “Close” button/);
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
    expect(short.prompt).toBe("Type “Hello” into “Subject” entry in Firefox?");
  });
});
