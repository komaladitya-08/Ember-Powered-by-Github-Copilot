/**
 * The composer's completions (app/renderer/code/completions.ts) and the command palette's filter (palette.ts): where a
 * trigger starts a word, what accepting an item does, slash commands from `commands.list`, and the keyboard.
 */
import { describe, expect, it } from "vitest";
import { accept, completionItems, moveHighlight, slashCommands, slashItems, triggerAt } from "../../app/renderer/code/completions";
import { filterActions, primaryKey } from "../../app/renderer/code/palette";

describe("composer completions", () => {
  it("finds the trigger of the word at the caret, at a word's start only, and a slash only at the message's start", () => {
    expect(triggerAt("look at @src/lo", 15, ["@", "/"])).toEqual({ char: "@", start: 8, query: "src/lo" });
    expect(triggerAt("mail me@example", 15, ["@"])).toBeNull();
    expect(triggerAt("/pl", 3, ["/"])).toEqual({ char: "/", start: 0, query: "pl" });
    expect(triggerAt("  /pl", 5, ["/"])).toEqual({ char: "/", start: 2, query: "pl" });
    expect(triggerAt("open /etc", 9, ["/"])).toBeNull();
    expect(triggerAt("@a b", 4, ["@"])).toBeNull();
    expect(triggerAt("", 0, ["@"])).toBeNull();
  });

  it("accepts an item over its own range, else the trigger's word, with a space to type on", () => {
    const t = triggerAt("fix @lo now", 7, ["@"])!;
    expect(accept("fix @lo now", 7, t, { label: "src/login.ts", insertText: "@src/login.ts" })).toEqual({ text: "fix @src/login.ts now", caret: 17 });
    expect(accept("fix @lo", 7, t, { label: "x", insertText: "@x", rangeStart: 4, rangeEnd: 7 })).toEqual({ text: "fix @x ", caret: 7 });
    // A range outside the text is ignored.
    expect(accept("fix @lo", 7, t, { label: "x", insertText: "@x", rangeStart: 99 })).toEqual({ text: "fix @x ", caret: 7 });
  });

  it("reads completion items and slash commands, and lists the commands that match (only those allowed while a turn runs)", () => {
    expect(completionItems({ items: [{ insertText: "@a.ts", label: "a.ts", kind: "document", rangeStart: 0, rangeEnd: 2 }, { label: "empty" }] }))
      .toEqual([{ label: "a.ts", insertText: "@a.ts", kind: "document", rangeStart: 0, rangeEnd: 2 }]);
    const cmds = slashCommands({ commands: [
      { name: "plan", description: "Plan first", allowDuringAgentExecution: false },
      { name: "compact", aliases: ["shrink"], description: "Make room", allowDuringAgentExecution: true, input: { hint: "instructions" } },
      { description: "no name" },
    ] });
    expect(cmds).toEqual([
      { name: "plan", aliases: [], description: "Plan first", duringTurn: false },
      { name: "compact", aliases: ["shrink"], description: "Make room", duringTurn: true, hint: "instructions" },
    ]);
    expect(slashItems(cmds, "").map(i => i.label)).toEqual(["/compact", "/plan"]);
    expect(slashItems(cmds, "sh").map(i => i.insertText)).toEqual(["/compact "]);
    expect(slashItems(cmds, "", true).map(i => i.label)).toEqual(["/compact"]);
  });

  it("moves the highlight with the arrow keys (wrapping), Home and End", () => {
    expect([moveHighlight(0, "ArrowDown", 3), moveHighlight(2, "ArrowDown", 3), moveHighlight(0, "ArrowUp", 3), moveHighlight(1, "End", 3), moveHighlight(2, "Home", 3), moveHighlight(5, "x", 3), moveHighlight(0, "ArrowDown", 0)])
      .toEqual([1, 0, 2, 2, 0, 2, -1]);
  });
});

describe("the command palette", () => {
  it("filters actions by every word typed, in their labels or details, and names the key by the page's own platform", () => {
    const run = () => undefined;
    const acts = [{ id: "a", label: "New session…", run }, { id: "b", label: "Run /plan", detail: "Make a plan first", run }, { id: "c", label: "Stop everything", run }];
    expect(filterActions(acts, "").map(a => a.id)).toEqual(["a", "b", "c"]);
    expect(filterActions(acts, "plan first").map(a => a.id)).toEqual(["b"]);
    expect(filterActions(acts, "STOP").map(a => a.id)).toEqual(["c"]);
    expect(primaryKey("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)")).toBe("Command");
    expect(primaryKey("Mozilla/5.0 (X11; Linux x86_64)")).toBe("Ctrl");
  });
});
