/**
 * The generative UI catalog's newer blocks (app/shared/view.ts, app/main/agent/view-schema.ts, app/renderer/overlay/
 * view.ts): checklist, progress, compare, excerpt and status. Each is checked against its limits, said as text for the
 * conversation, and drawn (upgraded to the catalog's second version) with textContent only (a small fake document records
 * what the drawing does). An excerpt is refused whole when a line holds a secret or its file lives where secrets do.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ViewSchema, excerptRefusal } from "../../app/main/agent/view-schema";
import { TONE_WORD, VIEW_LIMITS, upgradeView, viewText, type ViewBlock } from "../../app/shared/view";
import { useFakeDocument, type FakeEl } from "./view-dom-fake";

const ok = (v: unknown) => ViewSchema.safeParse(v).success;

describe("the newer view blocks' schema", () => {
  it("takes each block inside its limits", () => {
    expect(ok([
      { kind: "checklist", items: [{ text: "Night Light on", done: true }, { text: "Schedule set", done: false }] },
      { kind: "progress", label: "Renamed", value: 3, total: 12 },
      { kind: "compare", columns: ["Before", "After"], rows: [{ label: "Size", a: "4.2 MB", b: "1.1 MB" }] },
      { kind: "excerpt", path: "~/notes/todo.txt", lines: ["Buy milk", "", "Call Priya"] },
      { kind: "status", tone: "warn", text: "Two files were already dated" },
    ])).toBe(true);
  });

  it.each([
    ["a checklist of more items than a card holds", [{ kind: "checklist", items: Array.from({ length: 9 }, () => ({ text: "x", done: true })) }]],
    ["a progress past its total", [{ kind: "progress", label: "Done", value: 6, total: 5 }]],
    ["a progress in fractions", [{ kind: "progress", label: "Done", value: 1.5, total: 5 }]],
    ["a progress out of nothing", [{ kind: "progress", label: "Done", value: 0, total: 0 }]],
    ["a progress past the catalog's largest number", [{ kind: "progress", label: "Done", value: 1, total: VIEW_LIMITS.total + 1 }]],
    ["a compare of three columns", [{ kind: "compare", columns: ["a", "b", "c"], rows: [{ label: "x", a: "1", b: "2" }] }]],
    ["a compare cell longer than a card's line", [{ kind: "compare", columns: ["a", "b"], rows: [{ label: "x", a: "1".repeat(VIEW_LIMITS.cell + 1), b: "2" }] }]],
    ["an excerpt of more lines than a card holds", [{ kind: "excerpt", path: "a.txt", lines: Array.from({ length: VIEW_LIMITS.lines + 1 }, () => "x") }]],
    ["an excerpt line too long", [{ kind: "excerpt", path: "a.txt", lines: ["x".repeat(VIEW_LIMITS.line + 1)] }]],
    ["a status of an unknown tone", [{ kind: "status", tone: "danger", text: "x" }]],
    ["a block outside the catalog", [{ kind: "html", html: "<b>hi</b>" }]],
    ["a link", [{ kind: "link", href: "https://example.com", text: "Open" }]],
  ])("refuses %s", (_why, view) => {
    expect(ok(view)).toBe(false);
  });
});

describe("an excerpt that would show a secret", () => {
  it("is refused whole, never shown redacted, when a line holds a password, token or card number", () => {
    expect(ok([{ kind: "excerpt", path: "~/notes.txt", lines: ["wifi", "password: hunter2"] }])).toBe(false);
    expect(ok([{ kind: "excerpt", path: "~/ci.txt", lines: ["token ghp_0123456789abcdefghijABCDEFGHIJ012345"] }])).toBe(false);
    expect(ok([{ kind: "excerpt", path: "~/pay.txt", lines: ["4111 1111 1111 1111"] }])).toBe(false);
    const r = ViewSchema.safeParse([{ kind: "excerpt", path: "~/notes.txt", lines: ["PIN: 4321"] }]);
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error?.issues)).toMatch(/the excerpt can't be shown: it holds a password, PIN or code/);
  });

  it("is refused from places where keys and passwords live, and from Ember's own data", () => {
    for (const path of ["~/.ssh/config", "/home/a/.gnupg/gpg.conf", "~/.config/ember/settings.json", "C:\\Users\\a\\AppData\\Local\\ember\\audit.jsonl",
      "~/Library/Application Support/ember/memory.json", "~/.local/share/keyrings/login.keyring", "/etc/shadow", "~/project/.env", "~/certs/server.key"]) {
      expect(excerptRefusal(path, ["hello"]), path).toMatch(/where passwords and keys are kept/);
    }
    expect(excerptRefusal("~/notes/shopping.txt", ["Milk", "Eggs"])).toBeNull();
  });
});

describe("the newer blocks as text (the conversation, speech, the corner card without a compositor)", () => {
  it("says each one in lines, as the catalog's second version upgrades it", () => {
    const view: ViewBlock[] = [
      { kind: "checklist", items: [{ text: "Night Light on", done: true }, { text: "Schedule", done: false }] },
      { kind: "progress", label: "Renamed", value: 3, total: 12 },
      { kind: "compare", columns: ["Before", "After"], rows: [{ label: "Size", a: "4 MB", b: "1 MB" }] },
      { kind: "excerpt", path: "~/todo.txt", lines: ["Milk", "Eggs"] },
      { kind: "status", tone: "fail", text: "One file couldn't be renamed" },
    ];
    expect(viewText(view)).toBe("Done: Night Light on\nTo do: Schedule\nRenamed: 3 of 12\nBefore / After\nSize: 4 MB / 1 MB\n~/todo.txt\nMilk\nEggs\nProblem: One file couldn't be renamed");
    expect(TONE_WORD).toEqual({ ok: "OK: ", warn: "Worth a look: ", fail: "Problem: " });
  });
});

describe("drawing the newer blocks", () => {
  let restore = () => {};
  beforeEach(() => { restore = useFakeDocument(); });
  afterEach(() => restore());

  it("sets every string as text, a progress bar's length as SVG geometry, and each state in words for screen readers", async () => {
    const { renderView } = await import("../../app/renderer/shared/view-dom");
    const root = renderView(upgradeView([
      { kind: "checklist", items: [{ text: "<b>on</b>", done: true }] },
      { kind: "progress", label: "Renamed", value: 3, total: 12 },
      { kind: "compare", columns: ["Before", "After"], rows: [{ label: "Size", a: "4 MB", b: "1 MB" }] },
      { kind: "excerpt", path: "~/todo.txt", lines: ["Milk", "Eggs"] },
      { kind: "status", tone: "ok", text: "All renamed" },
    ]), { profile: "card" }) as unknown as FakeEl;
    const [check, progress, compare, excerpt, status] = root.find("vw-stack")!.children;
    expect(check.textContent).toBe("Done: <b>on</b>");
    expect(progress.textContent).toBe("Renamed3 of 12");
    const bar = progress.find("vw-bar")!;
    expect(bar.attrs["aria-hidden"]).toBe("true");
    expect(bar.find("vw-fill")!.attrs.width).toBe("25");
    expect(compare.className).toContain("vw-compare");
    expect(excerpt.textContent).toBe("~/todo.txtMilk\nEggs");
    expect(status.getAttribute("data-tone")).toBe("positive");
    expect(status.textContent).toBe("OK: All renamed");
  });

  it("draws the card's activity rows with their state in words", async () => {
    const { activityItems } = await import("../../app/renderer/overlay/view");
    const [row, note] = activityItems([{ at: 12_000, state: "failed", words: "Clicked once" }, { at: 14_000, state: "done", words: "Trying the search", model: true }]) as unknown as FakeEl[];
    expect(row.textContent).toBe("Didn't work: 12sClicked once");
    expect(note.textContent).toBe("Note: 14sTrying the search");
  });
});
