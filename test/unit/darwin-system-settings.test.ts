/**
 * Dark Mode on a Mac (design §9.3) with a scripted Run: read with `defaults read -g AppleInterfaceStyle` before and
 * after, set through System Events with exactly one osascript line, and each AppleEvent failure turned into words the
 * user can act on (Automation consent, System Events not answering). Nothing but dark_style is offered.
 */

import { describe, expect, it } from "vitest";
import { AUTOMATION_DENIED, DARWIN_SETTINGS, NO_ANSWER, darwinSettings } from "../../app/main/platform/darwin/system/settings";
import type { RunResult } from "../../app/main/platform/darwin/system/exec";
import { fakeRun, tool } from "./darwin-system-fakes";

/** A Mac whose Dark Mode stays `dark`, and whose osascript answers `script` (default: success). */
function mac(dark: boolean, script: Partial<RunResult> = { code: 0 }) {
  return fakeRun([
    { match: tool("/usr/bin/defaults", "read"), result: () => (dark ? { code: 0, stdout: "Dark\n" } : { code: 1, stderr: "The domain/default pair of (kCFPreferencesAnyApplication, AppleInterfaceStyle) does not exist\n" }) },
    { match: tool("/usr/bin/osascript"), result: script },
  ]);
}

describe("darwinSettings", () => {
  it("offers Dark Mode only", () => {
    expect(DARWIN_SETTINGS).toEqual({ dark_style: "Dark Mode" });
    expect(darwinSettings().available).toBe(DARWIN_SETTINGS);
  });

  it("reads the appearance, sets it through System Events and reads it back", async () => {
    let dark = false;
    const { run, calls } = fakeRun([
      { match: tool("/usr/bin/defaults", "read"), result: () => (dark ? { code: 0, stdout: "Dark\n" } : { code: 1 }) },
      { match: tool("/usr/bin/osascript"), result: () => { dark = true; return { code: 0 }; } },
    ]);
    expect(await darwinSettings({ run }).change("dark_style", "on")).toEqual({ before: "false", after: "true" });
    expect(calls.map(c => [c.file, ...c.args])).toEqual([
      ["/usr/bin/defaults", "read", "-g", "AppleInterfaceStyle"],
      ["/usr/bin/osascript", "-e", "tell application \"System Events\" to tell appearance preferences to set dark mode to true"],
      ["/usr/bin/defaults", "read", "-g", "AppleInterfaceStyle"],
    ]);
    expect(calls[1]!.o?.timeout).toBe(10_000);
  });

  it("turns Dark Mode off with the same grammar as Linux", async () => {
    for (const value of ["off", "false", "no", "0"]) {
      const { run, calls } = mac(true);
      await darwinSettings({ run }).change("dark_style", value);
      expect(calls[1]!.args[1]).toMatch(/set dark mode to false$/);
    }
  });

  it("says how to allow Automation when macOS refuses Ember's AppleEvent (-1743)", async () => {
    const { run } = mac(false, { code: 1, stderr: "36:120: execution error: Not authorized to send Apple events to System Events. (-1743)\n" });
    await expect(darwinSettings({ run }).change("dark_style", "on")).rejects.toThrow(AUTOMATION_DENIED);
    expect(AUTOMATION_DENIED).toMatch(/System Settings › Privacy & Security › Automation/);
  });

  it("asks to try again when System Events didn't answer", async () => {
    for (const r of [{ code: 1, stderr: "execution error: System Events got an error: Application isn't running. (-600)" },
      { code: 1, stderr: "execution error: System Events got an error: AppleEvent timed out. (-1712)" },
      { code: null, failure: "timeout" }]) {
      const { run } = mac(false, r);
      await expect(darwinSettings({ run }).change("dark_style", "on")).rejects.toThrow(NO_ANSWER);
    }
  });

  it("gives a plain error for any other osascript failure, and when the appearance can't be read", async () => {
    const { run } = mac(false, { code: 1, stderr: "something odd (-10000)" });
    await expect(darwinSettings({ run }).change("dark_style", "on")).rejects.toThrow("macOS didn't change Dark Mode.");
    const broken = fakeRun([{ match: tool("/usr/bin/defaults"), result: { code: null, failure: "ENOENT" } }]);
    await expect(darwinSettings({ run: broken.run }).change("dark_style", "on")).rejects.toThrow(/couldn't read the appearance/);
    expect(broken.calls).toHaveLength(1);
  });

  it("refuses any other setting without running anything", async () => {
    const { run, calls } = mac(false);
    await expect(darwinSettings({ run }).change("night_light", "on")).rejects.toThrow(/can't change night light on a Mac/);
    expect(calls).toHaveLength(0);
  });
});
