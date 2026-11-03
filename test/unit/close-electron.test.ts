/** Native integration cleanup must finish its bounded fallback before Vitest ends the hook (CI #156). */
import fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeTestElectron, ELECTRON_CLOSE_GRACE_MS, ELECTRON_CLEANUP_TIMEOUT_MS } from "../integration/close-electron";

function app(close: () => Promise<void>) {
  const proc = { exitCode: null as number | null, signalCode: null as NodeJS.Signals | null, kill: vi.fn(() => true) };
  return { close, process: () => proc, proc };
}
afterEach(() => { vi.useRealTimers(); });

describe("test-owned Electron cleanup", () => {
  it("terminates a stalled close within the grace and leaves room for the remaining hook cleanup", async () => {
    vi.useFakeTimers();
    const owned = app(() => new Promise<void>(() => { /* Simulate the unresolved Playwright close seen in CI. */ }));
    let finished = false;
    const closing = closeTestElectron(owned).then(forced => { finished = true; return forced; });
    await vi.advanceTimersByTimeAsync(ELECTRON_CLOSE_GRACE_MS - 1);
    expect(finished).toBe(false);
    expect(owned.proc.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(await closing).toBe(true);
    expect(owned.proc.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
    // Existing temp-profile cleanup permits five 200 ms retry delays. The old 10 s hook had no room for even one.
    expect(ELECTRON_CLEANUP_TIMEOUT_MS).toBeGreaterThan(ELECTRON_CLOSE_GRACE_MS + 5 * 200);
    const suite = fs.readFileSync(new URL("../integration/ember-darwin.test.ts", import.meta.url), "utf8");
    expect(suite).toContain("}, ELECTRON_CLEANUP_TIMEOUT_MS);");
    expect(suite).toContain("closeTestElectron(ember)");
  });

  it("clears the fallback timer after normal close without signalling the process", async () => {
    vi.useFakeTimers();
    const owned = app(async () => { owned.proc.exitCode = 0; });
    expect(await closeTestElectron(owned)).toBe(false);
    expect(owned.proc.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("handles a rejected close without signalling a process that already exited by signal", async () => {
    vi.useFakeTimers();
    const owned = app(async () => { owned.proc.signalCode = "SIGTERM"; throw new Error("transport closed"); });
    expect(await closeTestElectron(owned)).toBe(false);
    expect(owned.proc.kill).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("terminates only its captured process when close rejects while that process is still running", async () => {
    vi.useFakeTimers();
    const owned = app(async () => { throw new Error("transport unavailable"); });
    expect(await closeTestElectron(owned)).toBe(true);
    expect(owned.proc.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
  });
});
