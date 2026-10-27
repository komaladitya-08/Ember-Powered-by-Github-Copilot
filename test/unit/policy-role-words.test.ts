/**
 * The May I? question's words for controls (review #220): the screen reader's role names ("push button", "combo box",
 * "page tab") become the plain words the activity list uses ("button", "drop-down", "tab"), from one table both share.
 */

import { describe, expect, it } from "vitest";
import { plainQuestion, type ActionRequest } from "../../app/main/policy/policy";
import { ROLE_WORDS, aRoleWord, roleWord } from "../../app/shared/role-words";
import { describeEntry } from "../../app/renderer/home/copy";

const req = (r: Partial<ActionRequest>): ActionRequest => ({ taskId: "t1", kind: "click", app: "Mousepad", window: "notes.txt", ...r });

describe("the question's words for a control", () => {
  it("names a control by its name and a plain word for what it is", () => {
    expect(plainQuestion(req({ element: { role: "push button", name: "Save" } }))).toBe("Click the “Save” button in Mousepad?");
    expect(plainQuestion(req({ kind: "toggle", app: "Settings", element: { role: "toggle button", name: "Night Light" } }))).toBe("Switch the “Night Light” switch in Settings?");
    expect(plainQuestion(req({ kind: "select", app: "Firefox", element: { role: "combo box", name: "Meal" }, value: "Vegetarian" }))).toBe("Choose “Vegetarian” in the “Meal” drop-down in Firefox?");
    expect(plainQuestion(req({ element: { role: "page tab", name: "Advanced" } }))).toBe("Click the “Advanced” tab in Mousepad?");
    expect(plainQuestion(req({ kind: "toggle", element: { role: "check box", name: "Bold" } }))).toBe("Switch the “Bold” checkbox in Mousepad?");
    expect(plainQuestion(req({ kind: "cursor_click", element: { role: "push button", name: "Send" } }))).toBe("Borrow your mouse to click the “Send” button in Mousepad?");
  });

  it("calls an unnamed control and the control it sits in by the same plain words", () => {
    expect(plainQuestion(req({ element: { role: "push button", name: "" } }))).toBe("Click the button in Mousepad?");
    expect(plainQuestion(req({ element: { role: "icon", name: "" }, place: { role: "push button", name: "Save" } }))).toBe("Click the icon on the “Save” button in Mousepad?");
  });

  it("keeps a role it has no plain word for as the screen reader says it", () => {
    expect(plainQuestion(req({ element: { role: "heading", name: "Intro" } }))).toBe("Click the “Intro” heading in Mousepad?");
  });

  it("never uses the screen reader's own role names", () => {
    for (const role of ["push button", "toggle button", "combo box", "page tab", "check box", "radio button", "spin button"]) {
      expect(plainQuestion(req({ element: { role, name: "X" } }))).not.toContain(role);
    }
  });
});

describe("the role words table, shared with the activity list", () => {
  it("gives the same word to the question and the activity list", () => {
    expect(roleWord("push button")).toBe("button");
    expect(roleWord("radio button")).toBe("option");
    expect(roleWord("heading")).toBe("heading");
    expect(aRoleWord("radio button")).toBe("an option");
    expect(aRoleWord("combo box")).toBe("a drop-down");
    expect(aRoleWord("heading")).toBe("heading");
    expect(Object.isFrozen(ROLE_WORDS)).toBe(true);
    const entry = describeEntry({ t: "2026-10-27T10:00:00Z", event: "action", kind: "toggle", app: "settings", element: { role: "toggle button", name: "" }, ok: true });
    expect(entry?.what).toBe(`Switch ${aRoleWord("toggle button")} in Settings`);
  });
});
