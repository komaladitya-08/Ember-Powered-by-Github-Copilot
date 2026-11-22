/** Linux's setup checks leave the main event loop free, and distinguish a pending look from missing bindings. */
import { describe, expect, it } from "vitest";
import { accessibilityProbe, type ExecAsync } from "../../app/main/platform/linux/environment";
import { inspectEnvironment, type EnvInputs } from "../../app/main/environment";
import { linuxSystem } from "../../app/main/platform/linux/system";
import type { PlatformDeps } from "../../app/main/platform/types";
import { speaksAloud } from "../../app/shared/speech";
import { holdsBack } from "../../app/shared/setup-attention";

const base: EnvInputs = { env: { DISPLAY: ":0", XDG_SESSION_TYPE: "x11" }, platform: "linux", arch: "x64", osRelease: 'ID="rhel"\nVERSION_ID="8.4"', glibc: "2.28", versions: { node: "24" } };
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

describe("Linux's responsive screen-reading check", () => {
  it("shows missing bindings only after a failed look and makes a fresh retry awaitable (rp-1)", async () => {
    let fail = true;
    const probe = accessibilityProbe({ env: {}, run: async cmd => {
      if (cmd === "gsettings") return "false\n";
      if (fail) throw new Error("Python could not import its bindings");
      return "";
    } });
    await probe.again();
    expect(probe()).toEqual({ enabled: false, pyatspi: false });
    expect(inspectEnvironment({ ...base, accessibility: probe() }).checks.find(c => c.id === "accessibility")?.detail).toMatch(/bindings are missing/);
    fail = false;
    await probe.again();
    expect(probe()).toEqual({ enabled: false, pyatspi: true });
    const row = inspectEnvironment({ ...base, accessibility: probe() }).checks.find(c => c.id === "accessibility")!;
    expect(row.detail).toMatch(/Accessibility is off/);
    expect(holdsBack(row)).toBe(true);
  });

  it("keeps the first status and Stop responsive while Python is still being checked (rp-1)", async () => {
    const sync: string[] = [];
    const probe = accessibilityProbe({ env: {}, exec: cmd => { sync.push(cmd); return ""; }, run: () => new Promise<void>(() => undefined) });
    const state = probe();
    expect(sync).not.toContain("python3");
    expect(state.pyatspi).toBeNull();
    const row = inspectEnvironment({ ...base, accessibility: state }).checks.find(c => c.id === "accessibility")!;
    expect(row.status).toBe("warn");
    expect(row.detail).toMatch(/checking/i);
    expect(row.detail).not.toMatch(/missing|on$|available/i);
    expect(holdsBack(row)).toBe(true);
    let stopped = false;
    await new Promise<void>(resolve => setTimeout(() => { stopped = true; resolve(); }, 0));
    expect(stopped).toBe(true);
  });

  it("keeps screen-reader detection off the main thread too (reliability-c7-1)", async () => {
    const sync: string[] = [];
    const pending: ((v: string) => void)[] = [];
    let electronReader = false;
    const deps = { env: {}, electron: { app: { isAccessibilitySupportEnabled: () => electronReader } } } as unknown as PlatformDeps;
    const platform = linuxSystem(deps, { exec: cmd => { sync.push(cmd); return "true"; }, run: async (_cmd, args) => {
      if (args.includes("screen-reader-enabled")) return new Promise<string>(resolve => pending.push(resolve));
      return "true";
    }, setTimeout: () => ({}) });
    expect(platform.a11y.screenReaderOn()).toBe(false);
    expect(sync).toEqual([]);
    await flush();
    pending[0]("true");
    await flush();
    expect(platform.a11y.screenReaderOn()).toBe(true);
    electronReader = true;
    expect(platform.a11y.screenReaderOn()).toBe(true);
  });

  it("keeps a confirmed reader's streamed reply speaking while its cache refresh waits (reliability-v7-3)", async () => {
    let expire: () => void = () => undefined;
    const pending: ((v: string) => void)[] = [];
    let calls = 0;
    const platform = linuxSystem({ env: {}, electron: { app: { isAccessibilitySupportEnabled: () => false } } } as unknown as PlatformDeps, {
      run: async (_cmd, args) => {
        if (!args.includes("screen-reader-enabled")) return "true";
        return ++calls === 1 ? "true" : new Promise<string>(resolve => pending.push(resolve));
      },
      setTimeout: fn => { expire = fn; return {}; },
    });
    platform.a11y.screenReaderOn();
    await flush();
    expect(speaksAloud({ speak: false, speakWithScreenReader: true }, platform.a11y.screenReaderOn)).toBe(true);
    expire();
    expect(speaksAloud({ speak: false, speakWithScreenReader: true }, platform.a11y.screenReaderOn)).toBe(true);
    expect(platform.a11y.screenReaderState?.()).toBeNull();
    await flush();
    pending[0]("false");
    await flush();
    expect(speaksAloud({ speak: false, speakWithScreenReader: true }, platform.a11y.screenReaderOn)).toBe(false);
  });

  it("keeps unknown reader state protective for hearing and silent for reader-only speech (reliability-v7-2)", async () => {
    let malformed = false;
    let refresh: () => void = () => undefined;
    const platform = linuxSystem({ env: {}, electron: { app: { isAccessibilitySupportEnabled: () => false } } } as unknown as PlatformDeps, {
      run: async (_cmd, args) => args.includes("screen-reader-enabled") ? malformed ? "unknown" : "false" : "true",
      setTimeout: fn => { refresh = fn; return {}; },
    });
    expect(platform.a11y.screenReaderState?.()).toBeNull();
    expect(platform.a11y.screenReaderOn()).toBe(false);
    await flush();
    expect(platform.a11y.screenReaderState?.()).toBe(false);
    malformed = true;
    refresh();
    expect(platform.a11y.screenReaderState?.()).toBeNull();
    await flush();
    expect(platform.a11y.screenReaderState?.()).toBeNull();
    expect(platform.a11y.screenReaderOn()).toBe(false);
  });

  it("doesn't call screen reading ready after the GNOME switch couldn't be checked (reliability-c7-1)", async () => {
    const probe = accessibilityProbe({ env: {}, run: async cmd => {
      if (cmd === "gsettings") throw new Error("Session bus unavailable");
      return "";
    } });
    await probe.again();
    const row = inspectEnvironment({ ...base, accessibility: probe() }).checks.find(c => c.id === "accessibility")!;
    expect(row.status).toBe("warn");
    expect(row.detail).toMatch(/couldn't be checked/i);
    expect(row.detail).not.toMatch(/available|on$/);
    expect(holdsBack(row)).toBe(true);
  });

  it("never runs gsettings on the main thread, including later status reads (reliability-c7-1)", async () => {
    const sync: string[] = [];
    let t = 0;
    const asks: string[] = [];
    const settles: (() => void)[] = [];
    const run = ((cmd: string) => {
      asks.push(cmd);
      return cmd === "gsettings" ? new Promise<string>(resolve => settles.push(() => resolve("true\n"))) : Promise.resolve("");
    }) as ExecAsync;
    const probe = accessibilityProbe({ env: {}, exec: cmd => { sync.push(cmd); return "true"; }, run, now: () => t });
    await flush();
    settles[0]();
    await flush();
    expect(probe()).toMatchObject({ enabled: true, pyatspi: true });
    t = 30_001;
    probe();
    probe();
    expect(sync).toEqual([]);
    await flush();
    expect(asks.filter(c => c === "gsettings")).toHaveLength(2);
    let finished = false;
    const fresh = probe.again().then(() => { finished = true; });
    await flush();
    expect(finished).toBe(false);
    settles[1]();
    await fresh;
    expect(probe()).toMatchObject({ enabled: true, pyatspi: true });
  });
});
