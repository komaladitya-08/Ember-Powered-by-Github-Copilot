/**
 * What main.ts gives the agent and the targets runtime for their bubbles. Ember's bubbles and its command window name
 * its shortcuts only while it holds them (cross-review X0, X5): main tells the agent's presenters and the targets
 * runtime (its command window, its bubbles' keyboard route) which labels work now, the way the spoken cancel words
 * already ask hasKey; what each does with null is pinned in presenter.test.ts, command-window.test.ts and
 * ui-copy.test.ts. And the runtime's offers get a board of their own (cross-review X3; targets-runtime.test.ts "offers
 * in the bubble"). main.ts can't be loaded in a unit test (it is Electron's entry point), so the wiring is read from its
 * source, as main-privacy-wiring.test.ts does.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

/** main.ts without its comments, every run of white space made one space. */
const MAIN = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1").replace(/\s+/g, " ");

/** The source from `from` up to `to`. */
function between(from: string, to: string): string {
  const start = MAIN.indexOf(from);
  expect(start, from).toBeGreaterThan(-1);
  const end = MAIN.indexOf(to, start + from.length);
  expect(end, to).toBeGreaterThan(-1);
  return MAIN.slice(start, end);
}

const SETTINGS = "settingsKey: () => (hasKey(sc.settings.accel) ? sc.settings.label : null)";
const STOP = "stopKey: () => (hasKey(sc.stop.accel) ? sc.stop.label : null)";

describe("main.ts names a shortcut only while Ember holds it (cross-review X0, X5)", () => {
  it("tells the agent's presenters the settings and stop shortcuts it holds", () => {
    const agent = between("agent = new AgentHost({", "let wasOnline = ");
    expect(agent).toContain(SETTINGS);
    expect(agent).toContain(STOP);
    // The spoken cancel words already did.
    expect(agent).toContain("stopKey: hasKey(sc.stop.accel) ? sc.stop.say : null");
  });

  it("tells the targets runtime both: its bubbles' keyboard route and its command window's announcement", () => {
    const targets = between("targets = createTargets({", "agent = new AgentHost({");
    expect(targets).toContain(SETTINGS);
    expect(targets).toContain(STOP);
  });
});

describe("main.ts gives the targets runtime's offers a board of their own (cross-review X3)", () => {
  it("passes AgentHost.offers beside AgentHost.notices", () => {
    const targets = between("targets = createTargets({", "agent = new AgentHost({");
    expect(targets).toContain("bubbles: () => agent?.notices ?? null,");
    expect(targets).toContain("offers: () => agent?.offers ?? null,");
  });
});
