/** Memory retrieval stays bounded, and saved-row refreshes and failed Undo preserve a usable focused control. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeyedRows } from "../../app/renderer/home/keyed-rows";
import { mountLearnedUndo } from "../../app/renderer/home/learned-undo";
import { MEMORY_PAGE_SIZE, memoryPage } from "../../app/renderer/home/memory-view";
import { memoryCountText, settingsResultText } from "../../app/renderer/home/copy";
import type { MemoryView } from "../../app/shared/ipc";
import { FakeEl, type FakeNode } from "./view-dom-fake";

const focusState: { active: TestEl | null } = { active: null };
class TestEl extends FakeEl {
  private events = new Map<string, (() => void)[]>();
  contains(other: FakeNode | null): boolean { return other === this || this.all().includes(other as FakeEl); }
  focus(): void { focusState.active = this; }
  removeAttribute(name: string): void { delete this.attrs[name]; }
  addEventListener(name: string, fn: () => void): void { this.events.set(name, [...this.events.get(name) ?? [], fn]); }
  click(): void { for (const fn of this.events.get("click") ?? []) fn(); }
  override removeChild(node: FakeNode): void {
    if (node instanceof TestEl && node.contains(focusState.active)) focusState.active = null;
    super.removeChild(node);
  }
  override querySelector(selector: string): TestEl | null {
    return (this.all().find(el => el.tag === selector) as TestEl | undefined) ?? null;
  }
}
const html = (el: TestEl) => el as unknown as HTMLElement;
const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
beforeEach(() => {
  focusState.active = null;
  vi.stubGlobal("document", { createElement: (tag: string) => new TestEl(tag), get activeElement() { return focusState.active; } });
});
afterEach(() => vi.unstubAllGlobals());

describe("stable saved settings rows", () => {
  function list() {
    const ul = new TestEl("ul");
    const fallback = new TestEl("input");
    const clicked: string[] = [];
    const rows = new KeyedRows<{ id: string; text: string }>(html(ul), {
      key: item => item.id, empty: () => "Empty", fallback: () => html(fallback),
      create: read => {
        const li = new TestEl("li");
        const button = new TestEl("button");
        button.addEventListener("click", () => clicked.push(read().text));
        li.append(button);
        return html(li);
      },
      update: (el, item) => { el.querySelector("button")!.textContent = item.text; },
    });
    return { ul, fallback, rows, clicked };
  }
  it("retains the exact focused button when background facts arrive or reorder", () => {
    const { ul, rows, clicked } = list();
    rows.render([{ id: "a", text: "First" }]);
    const button = ul.querySelector("button")!;
    button.focus();
    rows.render([{ id: "b", text: "New" }, { id: "a", text: "Current" }]);
    expect(focusState.active).toBe(button);
    expect(ul.children[1].querySelector("button")).toBe(button);
    expect(button.textContent).toBe("Current");
    button.click();
    expect(clicked).toEqual(["Current"]);
  });
  it("focuses the nearest remaining row after deleting the focused one, and the fallback after the last", () => {
    const { ul, rows, fallback } = list();
    rows.render([{ id: "a", text: "First" }, { id: "b", text: "Second" }, { id: "c", text: "Third" }]);
    (ul.children[1].querySelector("button") as TestEl).focus();
    const third = ul.children[2].querySelector("button");
    rows.render([{ id: "a", text: "First" }, { id: "c", text: "Third" }]);
    expect(focusState.active).toBe(third);
    rows.render([]);
    expect(focusState.active).toBe(fallback);
  });
  it("does not steal focus from another control during a background refresh", () => {
    const { rows } = list();
    const search = new TestEl("input");
    search.focus();
    rows.render([{ id: "a", text: "First" }]);
    rows.render([]);
    expect(focusState.active).toBe(search);
  });
});

describe("learned-memory Undo", () => {
  it("waits for deletion, ignores repeat activation and keeps a rejected action retryable", async () => {
    const row = new TestEl("li");
    let reject: (err: Error) => void = () => undefined;
    const remove = vi.fn(() => new Promise<void>((_, fail) => { reject = fail; }));
    mountLearnedUndo(html(row), "Prefers tea", "fact", remove);
    const button = row.querySelector("button")!;
    button.focus();
    button.click(); button.click();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(button.textContent).toBe("Forgetting…");
    expect(focusState.active).toBe(button);
    reject(new Error("private filesystem detail"));
    await tick();
    expect(button.textContent).toBe("Undo");
    expect(button.getAttribute("aria-disabled")).toBeNull();
    expect(row.textContent).toContain("Try Undo again.");
    expect(row.textContent).not.toContain("private filesystem");
    expect(focusState.active).toBe(button);
  });
  it("reports Forgotten only after a successful deletion", async () => {
    const row = new TestEl("li");
    let resolve: () => void = () => undefined;
    mountLearnedUndo(html(row), "Prefers tea", "fact", () => new Promise<void>(done => { resolve = done; }));
    const button = row.querySelector("button")!;
    button.click();
    expect(button.textContent).not.toBe("Forgotten");
    resolve(); await tick();
    expect(button.textContent).toBe("Forgotten");
    expect(button.getAttribute("aria-disabled")).toBe("true");
  });
});

describe("memory retrieval", () => {
  const facts: MemoryView["rows"] = Array.from({ length: 5000 }, (_, i) => ({ id: `fact-${i}`, text: i % 2 ? `Café preference ${i}` : `Tea preference ${i}`, source: i % 2 ? "conversation" : "user", at: "2026-11-04" }));
  it("pages a full 5000-fact store and makes every matching fact reachable", () => {
    expect(memoryPage(facts, "", "", 0)).toEqual({ rows: facts.slice(0, MEMORY_PAGE_SIZE), total: 5000 });
    expect(memoryPage(facts, "", "", 100).rows).toHaveLength(100);
    expect(memoryPage(facts, "", "", 5000).rows).toEqual(facts);
  });
  it("matches all query words independent of case or accents, and combines the source filter", () => {
    const page = memoryPage(facts, "CAFE 4999", "conversation", 50);
    expect(page.rows.map(row => row.id)).toEqual(["fact-4999"]);
    expect(page.total).toBe(1);
    expect(memoryPage(facts, "cafe", "user", 50).total).toBe(0);
    expect(facts).toHaveLength(5000);
  });
  it("labels filtered counts and settings results with enough context to choose between them", () => {
    expect(memoryCountText(50, 5000, 5000)).toBe("50 of 5000 memories");
    expect(memoryCountText(1, 1, 5000)).toBe("1 of 1 matching memory (5000 total)");
    // An empty list counts nothing: its row says it is empty (memory-13).
    expect(memoryCountText(0, 0, 0)).toBe("");
    expect(settingsResultText("Memory", "  Better\n recall  ")).toBe("Memory: Better recall");
  });
});
