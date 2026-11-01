/**
 * The kill switch's "Stopped" bubble and the parts still winding down (review #123): pull() gives up waiting after
 * 300 ms with the parts that hadn't finished (a command in its kill ladder, a slow remote link); the bubble then names
 * them in plain words, and the computers whose commands are still stopping, instead of saying everything stopped.
 */

import { describe, expect, it } from "vitest";
import { KillSwitch, stillStoppingWords } from "../../app/main/agent/killswitch";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

describe("stillStoppingWords", () => {
  it("is null when everything stopped in time", () => {
    expect(stillStoppingWords([])).toBeNull();
    expect(stillStoppingWords(["motion"])).toBeNull();
  });

  it("names the late parts in plain words, and the computers whose commands are still stopping", () => {
    expect(stillStoppingWords(["targets"], ["build-01"])).toBe("I've told everything to stop. Still stopping: commands and build-01…");
    expect(stillStoppingWords(["agent", "targets"], ["build-01", "db-02"])).toBe("I've told everything to stop. Still stopping: tasks, commands, build-01 and db-02…");
    expect(stillStoppingWords(["speech", "borrow", "desk"])).toBe("I've told everything to stop. Still stopping: speaking, the borrowed mouse and Ember's desk…");
    expect(stillStoppingWords(["something-new"])).toBe("I've told everything to stop. Still stopping: another part of Ember…");
    expect(stillStoppingWords(["targets"])).not.toMatch(/agent|targets|borrow/);
  });
});

describe("KillSwitch.pull", () => {
  it("reports a part still stopping after 300 ms as late", async () => {
    const ks = new KillSwitch(() => [
      { name: "agent", stop: () => undefined },
      { name: "targets", stop: () => new Promise(r => setTimeout(r, 1000)) },
    ], quiet);
    const { late } = await ks.pull("hotkey");
    expect(late).toEqual(["targets"]);
    expect(stillStoppingWords(late, ["build-01"])).toMatch(/Still stopping: commands and build-01/);
  });
});
