/**
 * The setup check's Screen reading row on Windows follows the shared accessibility host
 * (reliability-performance-c4-1): its status is asked again on Check again, and when reads find the helper can't work
 * while the row says it does, or work while the row says they can't, so the row the model's "see the setup check"
 * words point to says what is wrong now. macOS's row reads the Accessibility permission live, so it has no watch
 * (reliability-performance-v5-2).
 */

import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { inspectEnvironment } from "../../app/main/environment";
import { HelperWatch } from "../../app/main/helper-watch";
import { darwinEnvironment } from "../../app/main/platform/darwin/system/environment";
import type { HelperStatus } from "../../app/main/platform/types";
import { fakeDarwinWindows, fakeElectron } from "./darwin-system-fakes";

const CANT = new Error("accessibility bridge could not start (it stopped before it was ready again: exit code 3)");
const TIMEOUT = new Error("accessibility helper did not answer read_window in 5000 ms");

/** A watch whose host answers `answers` in turn (the row is what the last answer said). */
function watched(...answers: (HelperStatus | null)[]) {
  let row: HelperStatus | null | undefined;
  const ask = vi.fn(async () => { row = answers.length > 1 ? answers.shift()! : answers[0]; });
  const watch = new HelperWatch({ ask, row: () => row, waitMs: 1000 });
  return { watch, ask, row: () => row };
}

describe("HelperWatch (reliability-performance-c4-1)", () => {
  it("asks again when a read finds the helper can't work while the row still says it works, and the row then says so (reliability-performance-c4-1)", async () => {
    const { watch, ask, row } = watched({ toolkitAccessibility: true }, { toolkitAccessibility: false, detail: "Windows PowerShell stopped before the bridge was ready (exit code 3)" });
    await watch.again();
    expect(row()?.toolkitAccessibility).toBe(true);
    watch.saw("read_window", CANT);
    await vi.waitFor(() => expect(row()?.toolkitAccessibility).toBe(false));
    expect(ask).toHaveBeenCalledTimes(2);
    // More reads that can't work ask nothing more: the row says so already.
    watch.saw("read_window", CANT);
    watch.saw("list_windows", CANT);
    await Promise.resolve();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("asks again once reads work while the row still says the helper didn't start (reliability-performance-c4-1)", async () => {
    const { watch, ask, row } = watched({ toolkitAccessibility: false, detail: "Windows PowerShell stopped before the bridge was ready (exit code 3)" }, { toolkitAccessibility: true });
    await watch.again();
    watch.saw("list_windows", null);
    await vi.waitFor(() => expect(row()?.toolkitAccessibility).toBe(true));
    watch.saw("read_window", null);
    await Promise.resolve();
    expect(ask).toHaveBeenCalledTimes(2);
  });

  it("asks once for what reads found, even when the host's answer still disagrees, until they find otherwise (reliability-performance-c4-1)", async () => {
    const { watch, ask } = watched({ toolkitAccessibility: true });
    await watch.again();
    watch.saw("read_window", CANT);
    await Promise.resolve();
    watch.saw("read_window", CANT);
    await Promise.resolve();
    expect(ask).toHaveBeenCalledTimes(2);
    // Reads work again, then can't: one more ask for the new finding.
    watch.saw("read_window", null);
    watch.saw("read_window", CANT);
    await Promise.resolve();
    expect(ask).toHaveBeenCalledTimes(3);
  });

  it("never asks for an error that may pass, or for the status and ping requests themselves (reliability-performance-c4-1)", async () => {
    const { watch, ask } = watched({ toolkitAccessibility: true });
    await watch.again();
    watch.saw("read_window", TIMEOUT);
    watch.saw("status", CANT);
    watch.saw("ping", CANT);
    watch.saw("remember_secrets", CANT);
    await Promise.resolve();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("asks nothing for reads before its first look after start, so start-up isn't slowed (reliability-performance-c4-1)", async () => {
    const { watch, ask } = watched({ toolkitAccessibility: true });
    watch.saw("read_window", null);
    watch.saw("read_window", CANT);
    await Promise.resolve();
    expect(ask).not.toHaveBeenCalled();
    await watch.again();
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it("Check again always asks, waits for the answer only so long, and the late answer still lands (reliability-performance-c4-1)", async () => {
    vi.useFakeTimers();
    try {
      let row: HelperStatus | null | undefined = { toolkitAccessibility: true };
      let answer!: () => void;
      const ask = vi.fn(() => new Promise<void>(r => { answer = () => { row = { toolkitAccessibility: false, detail: "x" }; r(); }; }));
      const watch = new HelperWatch({ ask, row: () => row, waitMs: 1000 });
      let done = false;
      void watch.again().then(() => { done = true; });
      await vi.advanceTimersByTimeAsync(999);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toBe(true);
      expect(row?.toolkitAccessibility).toBe(true);
      // A second Check again while the first ask is still out asks once more after it (that answer may be from before).
      void watch.again();
      expect(ask).toHaveBeenCalledTimes(1);
      answer();
      await vi.advanceTimersByTimeAsync(0);
      expect(row?.toolkitAccessibility).toBe(false);
      expect(ask).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("main.ts's use of the watch (reliability-performance-c4-1)", () => {
  const main = fs.readFileSync("app/main/main.ts", "utf8");
  it("asks the host again on Check again, and tells the watch every request's outcome (reliability-performance-c4-1)", () => {
    expect(main).toContain("if (fresh && helperWatch) await helperWatch.again();");
    expect(main).toContain("request<T>(method, params, timeoutMs).then(v => { watch.saw(method, null); return v; }, (err: unknown) => { watch.saw(method, err); throw err; });");
    expect(main).toContain("setTimeout(() => void (watch ? watch.again() : ask()), atLogin ? 60_000 : 10_000).unref();");
  });

  it("makes the watch only on Windows, so a Mac without the Accessibility permission doesn't ask the host on every read for an answer its row never shows (reliability-performance-v5-2)", () => {
    expect(main).toContain('const watch = helperWatch = platform.os === "win32" ? new HelperWatch({ ask, row: () => helper, waitMs: HELPER_RECHECK_MS }) : null;');
    // Only a watch wraps the host's requests; without one (macOS) the status is asked once after start, as before.
    const made = main.slice(main.indexOf("const watch = helperWatch ="), main.indexOf("setTimeout(() => void (watch ? watch.again() : ask())"));
    expect(made).toMatch(/if \(watch\) \{\s+const request = sidecar\.request\.bind\(sidecar\);/);
    expect(main.match(/new HelperWatch\(/g)).toHaveLength(1);
  });
});

describe("macOS's Reading and using apps row (reliability-performance-v5-2)", () => {
  it("is the same whatever the host's status said, so there is nothing for a watch to keep current there (reliability-performance-v5-2)", () => {
    const e = fakeElectron({ systemPreferences: { isTrustedAccessibilityClient: vi.fn(() => false) } });
    const d = {
      env: { HOME: "/Users/ada" }, app: e.app, systemPreferences: e.systemPreferences, desktopCapturer: e.desktopCapturer, shell: e.shell,
      windows: () => fakeDarwinWindows({ trusted: false, inputMonitoring: true }), uid: () => 501, systemVersion: () => "15.1",
    };
    // (darwinEnvironment says process.platform, which is this test machine's.)
    const row = (helper: HelperStatus | null | undefined) =>
      inspectEnvironment({ ...darwinEnvironment(d, { windows: undefined, helper }), platform: "darwin" }).checks.find(c => c.id === "accessibility");
    expect(row(undefined)).toMatchObject({ label: "Reading and using apps", status: "fail" });
    const asked = [null, { toolkitAccessibility: true }, { toolkitAccessibility: false, detail: "Ember needs the Accessibility permission" }];
    for (const h of asked) expect(row(h)).toEqual(row(undefined));
  });
});
