/**
 * A section of the settings window that main asks for while it is still hidden (review #68, #184): Computers shows
 * only once the computers list and the status have arrived, so "Bring Ember to a computer…" and the WSL offer's "Open
 * settings" left the window at the top. The request now waits for the section, and names the control to focus.
 */

import { describe, expect, it } from "vitest";
import { PendingSection, sectionRequest } from "../../app/renderer/home/section-request";

describe("a section request from main", () => {
  it("names the section and, for Computers, the control to focus", () => {
    expect(sectionRequest("conversation")).toEqual({ section: "conversation", control: null });
    expect(sectionRequest("computers")).toEqual({ section: "computers", control: null });
    expect(sectionRequest("computers:host")).toEqual({ section: "computers", control: "host-add" });
    expect(sectionRequest("computers:wsl")).toEqual({ section: "computers", control: "wsl-on" });
    expect(sectionRequest("computers:nonsense")).toEqual({ section: "computers", control: null });
  });

  it("waits while its section is hidden, and is taken once it shows", () => {
    const p = new PendingSection();
    const shown = new Set<string>();
    p.hold("computers:host");
    expect(p.take(s => shown.has(s))).toBeNull();
    expect(p.waiting).toBe(true);
    shown.add("computers");
    expect(p.take(s => shown.has(s))).toBe("computers:host");
    expect(p.waiting).toBe(false);
    expect(p.take(s => shown.has(s))).toBeNull();
  });

  it("is dropped when the user moves on first, and the latest request wins", () => {
    const p = new PendingSection();
    p.hold("computers");
    p.drop();
    expect(p.take(() => true)).toBeNull();
    p.hold("computers");
    p.hold("commands");
    expect(p.take(s => s === "commands")).toBe("commands");
  });
});
