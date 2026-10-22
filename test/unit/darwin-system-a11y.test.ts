/**
 * VoiceOver and reduced motion on a Mac (design §9.10, finding M15) with a scripted Run: `pgrep -x VoiceOver` is the
 * test (exit 0 running, 1 not), `defaults read com.apple.universalaccess voiceOverOnOffKey` only answers when pgrep
 * couldn't run, an unanswerable probe keeps the last answer, the probe runs at creation and then every 60 s, and
 * app.isAccessibilitySupportEnabled() is never asked.
 */

import { describe, expect, it, vi } from "vitest";
import { PROBE_MS, darwinA11y, voiceOverRunning } from "../../app/main/platform/darwin/system/a11y";
import { fakeRun, tool } from "./darwin-system-fakes";

const flush = () => new Promise(r => setTimeout(r, 0));
const prefs = (reduced = false) => ({ getAnimationSettings: vi.fn(() => ({ prefersReducedMotion: reduced })) });

describe("voiceOverRunning", () => {
  it("asks pgrep for the VoiceOver process by its exact name", async () => {
    const { run, calls } = fakeRun([{ match: tool("/usr/bin/pgrep"), result: { code: 0, stdout: "512\n" } }]);
    expect(await voiceOverRunning(run)).toBe(true);
    expect(calls.map(c => [c.file, ...c.args])).toEqual([["/usr/bin/pgrep", "-x", "VoiceOver"]]);
  });

  it("answers no when pgrep finds none, without a second opinion", async () => {
    const { run, calls } = fakeRun([{ match: tool("/usr/bin/pgrep"), result: { code: 1 } }, { match: tool("/usr/bin/defaults"), result: { code: 0, stdout: "1\n" } }]);
    expect(await voiceOverRunning(run)).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("asks universalaccess's VoiceOver key only when pgrep couldn't run", async () => {
    const on = fakeRun([{ match: tool("/usr/bin/pgrep"), result: { code: null, failure: "ENOENT" } }, { match: tool("/usr/bin/defaults", "read"), result: { code: 0, stdout: "1\n" } }]);
    expect(await voiceOverRunning(on.run)).toBe(true);
    expect(on.calls[1]!.args).toEqual(["read", "com.apple.universalaccess", "voiceOverOnOffKey"]);
    const off = fakeRun([{ match: tool("/usr/bin/pgrep"), result: { code: 3 } }, { match: tool("/usr/bin/defaults"), result: { code: 0, stdout: "0\n" } }]);
    expect(await voiceOverRunning(off.run)).toBe(false);
    const neither = fakeRun([{ match: tool("/usr/bin/pgrep"), result: { code: null, failure: "timeout" } }, { match: tool("/usr/bin/defaults"), result: { code: 1 } }]);
    expect(await voiceOverRunning(neither.run)).toBeNull();
  });
});

describe("darwinA11y", () => {
  it("probes at creation and every 60 s, and answers the last result synchronously", async () => {
    let running = true;
    const { run, calls } = fakeRun([{ match: tool("/usr/bin/pgrep"), result: () => ({ code: running ? 0 : 1 }) }]);
    let tick: (() => void) | undefined;
    const every = vi.fn((fn: () => void, ms: number) => { tick = fn; expect(ms).toBe(PROBE_MS); });
    const a = darwinA11y({ systemPreferences: prefs(), run, every });
    expect(calls).toHaveLength(1);
    expect(a.screenReaderOn()).toBe(false); // not answered yet
    await flush();
    expect(a.screenReaderOn()).toBe(true);
    running = false;
    tick!();
    await flush();
    expect(a.screenReaderOn()).toBe(false);
    expect(PROBE_MS).toBe(60_000);
  });

  it("keeps the last answer when a probe can't tell", async () => {
    let answer: { code: number | null; failure?: string } = { code: 0 };
    const { run } = fakeRun([{ match: tool("/usr/bin/pgrep"), result: () => answer }]);
    let tick: (() => void) | undefined;
    const a = darwinA11y({ systemPreferences: prefs(), run, every: fn => { tick = fn; } });
    await flush();
    expect(a.screenReaderOn()).toBe(true);
    answer = { code: null, failure: "timeout" };
    tick!();
    await flush();
    expect(a.screenReaderOn()).toBe(true);
  });

  it("reads reduced motion from Electron, and says no when it can't", () => {
    const { run } = fakeRun();
    expect(darwinA11y({ systemPreferences: prefs(true), run, every: () => {} }).systemReducedMotion()).toBe(true);
    expect(darwinA11y({ systemPreferences: prefs(false), run, every: () => {} }).systemReducedMotion()).toBe(false);
    const broken = { getAnimationSettings: () => { throw new Error("no"); } };
    expect(darwinA11y({ systemPreferences: broken, run, every: () => {} }).systemReducedMotion()).toBe(false);
  });
});
