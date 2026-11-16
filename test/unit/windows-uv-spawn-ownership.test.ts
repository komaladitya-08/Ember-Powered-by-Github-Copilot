import { expect, it } from "vitest";
import { WindowsUvSpawnCleanupError, WindowsUvSpawnOwnership, readWindowsUvSpawnAfterStopped, windowsUvSpawnScratchLocation } from "../fixtures/windows-uv-spawn-ownership";
import { disposeWindowsLibuvProbe } from "../fixtures/windows-libuv-probe-disposal";

it("retains a plausible acquisition returned after a swallowed nested owner failure", () => {
  const owner = new WindowsUvSpawnOwnership(), acquired = { handle: 10n };
  expect(() => owner.guard(() => { try { owner.guard(() => { throw new Error("private native failure"); }); } catch { /* The native callback swallows its nested failure. */ } return acquired; })).toThrow(WindowsUvSpawnCleanupError);
  expect(owner.retained).toEqual([acquired]); let called = false;
  expect(() => owner.guard(() => { called = true; })).toThrow(WindowsUvSpawnCleanupError); expect(called).toBe(false);
});

it("reads only after natural root, job lease, child Stop and exit0 in that order", async () => {
  const events: string[] = [];
  const value = await readWindowsUvSpawnAfterStopped({
    async waitRootExited() { events.push("natural"); }, async waitStopped() { events.push("job-zero"); return { requireStopped() { events.push("lease"); } }; },
    requireChildStopped() { events.push("children"); }, exitCode() { events.push("exit0"); return 0; }, read() { events.push("read"); return 7; },
  });
  expect(value).toEqual({ exitCode: 0, report: 7 }); expect(events).toEqual(["natural", "job-zero", "lease", "children", "exit0", "read"]);
});

it.each(["natural", "job", "lease", "child", "exit", "nonzero"])("never reads or releases after %s uncertainty, even if a later non-disposing Stop succeeds", async fault => {
  const events: string[] = []; let read = false, unsafe = false;
  try { await readWindowsUvSpawnAfterStopped({
    async waitRootExited() { if (fault === "natural") throw new Error(); }, async waitStopped() { if (fault === "job") throw new Error(); return { requireStopped() { if (fault === "lease") throw new Error(); } }; },
    requireChildStopped() { if (fault === "child") throw new Error(); }, exitCode() { if (fault === "exit") throw new Error(); return fault === "nonzero" ? 101 : 0; }, read() { read = true; },
  }); } catch (error) { unsafe = error instanceof WindowsUvSpawnCleanupError; }
  const retained = await disposeWindowsLibuvProbe({ unsafe, lpacCreated: true, async stopLpac() { events.push("non-disposing-stop"); }, async closeFixture() { events.push("close-profile"); }, releasePins() { events.push("release-pins"); } });
  expect(unsafe).toBe(true); expect(retained).toBe(true); expect(read).toBe(false); expect(events).toEqual(["non-disposing-stop"]);
});

it("does not turn malformed content into uncertain native ownership after all Stop witnesses passed", async () => {
  const contentError = new Error("fixed content refusal"); let caught: unknown;
  try { await readWindowsUvSpawnAfterStopped({ async waitRootExited() {}, async waitStopped() { return { requireStopped() {} }; }, requireChildStopped() {}, exitCode: () => 0, read() { throw contentError; } }); }
  catch (error) { caught = error; }
  expect(caught).toBe(contentError); expect(caught).not.toBeInstanceOf(WindowsUvSpawnCleanupError);
});

it("requires canonical hosted scratch outside the managed-temp tree in both directions", () => {
  expect(windowsUvSpawnScratchLocation("C:\\RunnerTemp", "C:\\RunnerTemp\\ember-run-one", "C:\\RunnerTemp\\uv-one")).toBe("C:\\RunnerTemp\\uv-one");
});
it.each([
  [undefined, "C:\\Managed", "C:\\Runner\\uv"], ["C:\\Runner", "C:\\Managed", "C:\\Elsewhere\\uv"],
  ["C:\\Runner", "C:\\Runner\\managed", "C:\\Runner\\managed\\uv"], ["C:\\Runner", "C:\\Runner\\uv\\managed", "C:\\Runner\\uv"],
  ["C:\\Runner", "C:\\Managed", "C:\\Runner"], ["C:/Runner", "C:\\Managed", "C:\\Runner\\uv"],
])("refuses missing, aliased or overlapping native scratch (%s)", (runner, managed, candidate) => expect(() => windowsUvSpawnScratchLocation(runner, managed!, candidate!)).toThrow());
