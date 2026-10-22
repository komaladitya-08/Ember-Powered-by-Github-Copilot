/**
 * The quick context while Ember is set to work on another computer (§2.8, targets/quick-context.ts): the remote's own
 * focused window, marked with its target, within 3 s; a context with no window (never this screen's) when the remote
 * isn't connected, has no desktop, is too slow or fails.
 */

import { describe, expect, it, vi } from "vitest";
import type { QuickContext } from "../../app/main/perception";
import type { PerceptionPort } from "../../app/main/perception/ports";
import { QUICK_CONTEXT_MS, noWindowContext, remoteQuickContext } from "../../app/main/targets/quick-context";

const port = (q: () => Promise<QuickContext | null>) => ({ quickContext: q } as unknown as PerceptionPort);
const base = { id: "ssh:build-01" as const, label: "build-01", connected: true, desktop: "screen" as const };

describe("a remote's quick context", () => {
  it("is the remote's own, marked with the target it was read on", async () => {
    const c = await remoteQuickContext({ ...base, perception: port(async () => ({ target: { pid: 9, title: "notes.txt" }, text: "gedit: notes.txt" })) });
    expect(c).toEqual({ target: { pid: 9, title: "notes.txt" }, text: "gedit: notes.txt", targetId: "ssh:build-01" });
  });

  it("overrides whatever target the remote's answer claims", async () => {
    const c = await remoteQuickContext({ ...base, perception: port(async () => ({ target: {}, text: "x", targetId: "local" })) });
    expect(c.targetId).toBe("ssh:build-01");
  });

  it("has no window when the remote isn't connected or has no desktop (never this screen's window, G17)", async () => {
    const read = vi.fn();
    expect(await remoteQuickContext({ ...base, connected: false, perception: port(read) })).toEqual(noWindowContext("ssh:build-01", "build-01", "not connected now."));
    expect(await remoteQuickContext({ ...base, desktop: "none", perception: port(read) })).toMatchObject({ target: {}, targetId: "ssh:build-01" });
    expect(read).not.toHaveBeenCalled();
  });

  it("goes on without a window after the 3 s cap, when the read fails, or when nothing is in front", async () => {
    let fire: (() => void) | null = null;
    const slow = remoteQuickContext({ ...base, perception: port(() => new Promise(() => undefined)), setTimer: (fn, ms) => { expect(ms).toBe(QUICK_CONTEXT_MS); fire = fn; return 1; }, clearTimer: () => undefined });
    fire!();
    expect(await slow).toMatchObject({ target: {}, targetId: "ssh:build-01", text: "build-01: its screen didn't answer in time." });
    expect(await remoteQuickContext({ ...base, perception: port(() => Promise.reject(new Error("gone"))) })).toMatchObject({ target: {}, text: "build-01: its screen couldn't be read." });
    expect(await remoteQuickContext({ ...base, perception: port(async () => null) })).toMatchObject({ target: {}, text: "build-01: no window in front." });
    expect(await remoteQuickContext({ ...base, perception: port(() => { throw new Error("sync"); }) })).toMatchObject({ target: {} });
  });
});
