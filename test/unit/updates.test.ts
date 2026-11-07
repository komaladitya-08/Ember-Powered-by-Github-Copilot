/**
 * Telling the user a newer Ember is out (app/main/updates.ts): nothing touches the network until it is allowed, it asks
 * GitHub with no token, each version is announced once, a bad reply stays quiet, and the link is built from the number.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECK_EVERY_MS, FIRST_CHECK_MS, isNewer, newestVersion, releasePage, RELEASES_URL, UpdateChecker, versionOf } from "../../app/main/updates";
import { applyAdminPolicy, managedKeys, parseAdminPolicy } from "../../app/main/admin";
import { updateStatusText, UPDATES_CONSENT_TEXT } from "../../app/renderer/home/copy";
import { SettingsSchema } from "../../app/main/settings";

const release = (tag_name: string, draft = false) => ({ tag_name, draft, html_url: "https://evil.example/" });
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function checker(o: { allowed?: () => boolean; told?: string | null; fetch?: ReturnType<typeof vi.fn> } = {}) {
  let told = o.told ?? null;
  const fetch = o.fetch ?? vi.fn(async () => reply([release("v0.2.0")]));
  const announce = vi.fn((v: string) => { told = v; });
  const changed = vi.fn();
  const c = new UpdateChecker({
    fetch: fetch as never, current: "0.1.1", allowed: o.allowed ?? (() => true), told: () => told, announce, changed,
    log: { warn: vi.fn() }, now: () => new Date("2026-11-05T10:00:00Z"),
  });
  return { c, fetch, announce, changed };
}

afterEach(() => { vi.useRealTimers(); });

describe("reading versions", () => {
  it("compares by number, so 0.10.0 is newer than 0.9.0", () => {
    expect(isNewer("0.10.0", "0.9.0")).toBe(true);
    expect(isNewer("0.1.1", "0.1.1")).toBe(false);
    expect(isNewer("0.1.0", "0.1.1")).toBe(false);
  });
  it("ignores tags that aren't plain versions", () => {
    expect(versionOf("v1.2.3-rc1")).toBeNull();
    expect(versionOf("nightly")).toBeNull();
    expect(isNewer("nightly", "0.1.1")).toBe(false);
  });
  it("finds the newest published release, counting prereleases and skipping drafts", () => {
    expect(newestVersion([release("v0.1.0"), release("v0.3.0", true), release("v0.2.0"), release("latest")])).toBe("0.2.0");
    expect(newestVersion([])).toBeNull();
  });
  it("builds the link from the number, never from the reply", () => {
    expect(releasePage("0.2.0")).toBe("https://github.com/komaladitya-08/Ember-Powered-by-Github-Copilot/releases/tag/v0.2.0");
    expect(releasePage("0.2.0/../../evil")).toBeNull();
  });
});

describe("the update checker", () => {
  it("touches the network not at all until it is allowed", async () => {
    vi.useFakeTimers();
    const { c, fetch } = checker({ allowed: () => false });
    c.refresh();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 2);
    expect(await c.check()).toEqual({ phase: "off", latest: null, checkedAt: null });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("looks a minute after start, then once a day, and stops when turned off", async () => {
    vi.useFakeTimers();
    let on = true;
    const { c, fetch } = checker({ allowed: () => on });
    c.refresh();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS - 1);
    expect(fetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(fetch).toHaveBeenCalledTimes(2);
    on = false;
    c.refresh();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS * 3);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("stays at once a day when announcing a version changes the settings mid-look", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => reply([release("v0.2.0")]));
    let told: string | null = null;
    const c: UpdateChecker = new UpdateChecker({
      fetch: fetch as never, current: "0.1.1", allowed: () => true, told: () => told, changed: vi.fn(), log: { warn: vi.fn() },
      // As main does: announcing saves `told`, and every settings change calls refresh().
      announce: v => { told = v; c.refresh(); },
    });
    c.refresh();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS - 1);
    expect(fetch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps to once a day across restarts: a start soon after a look asks nothing until the day is out (integrations-v3)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-05T10:00:00Z"));
    let kept: string | null = null;
    const fetch = vi.fn(async () => reply([release("v0.1.1")]));
    const start = () => {
      const c = new UpdateChecker({
        fetch: fetch as never, current: "0.1.1", allowed: () => true, told: () => null, announce: vi.fn(), changed: vi.fn(), log: { warn: vi.fn() },
        lastChecked: () => kept, checked: at => { kept = at; },
      });
      c.refresh();
      return c;
    };
    const first = start();
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(fetch).toHaveBeenCalledOnce();
    expect(kept).toBe("2026-11-05T10:01:00.000Z");
    first.stop();
    // Two hours later Ember starts again (three times): nothing is asked for the next 22 hours.
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
    const again = [start(), start(), start()];
    expect(again[0].status).toMatchObject({ phase: "idle", checkedAt: "2026-11-05T10:01:00.000Z" });
    await vi.advanceTimersByTimeAsync(22 * 60 * 60 * 1000 - 1);
    expect(fetch).toHaveBeenCalledOnce();
    again[1].stop(); again[2].stop();
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    again[0].stop();
  });

  it("counts a failed look, waits at most a day for a clock set back, and ignores a time it can't read (integrations-v3)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-05T10:00:00Z"));
    const run = async (kept: string | null, fetch = vi.fn(async () => reply([release("v0.1.1")]))) => {
      const saved: string[] = [];
      const c = new UpdateChecker({
        fetch: fetch as never, current: "0.1.1", allowed: () => true, told: () => null, announce: vi.fn(), changed: vi.fn(), log: { warn: vi.fn() },
        lastChecked: () => kept, checked: at => { saved.push(at); },
      });
      c.refresh();
      return { c, fetch, saved };
    };
    const failed = await run(null, vi.fn(async () => { throw new TypeError("offline"); }));
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(failed.saved).toEqual(["2026-11-05T10:01:00.000Z"]);
    failed.c.stop();
    const future = await run("2027-01-01T00:00:00.000Z");
    await vi.advanceTimersByTimeAsync(CHECK_EVERY_MS);
    expect(future.fetch).toHaveBeenCalledOnce();
    future.c.stop();
    const unreadable = await run("yesterday");
    await vi.advanceTimersByTimeAsync(FIRST_CHECK_MS);
    expect(unreadable.fetch).toHaveBeenCalledOnce();
    unreadable.c.stop();
  });

  it("asks GitHub alone, with no token and no version of Ember", async () => {
    const { c, fetch } = checker();
    await c.check();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(RELEASES_URL);
    expect(new URL(url).host).toBe("api.github.com");
    expect(init.redirect).toBe("error");
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization|0\.1\.1/i);
  });

  it("says a newer version is out, and announces each version once", async () => {
    const { c, announce } = checker();
    expect(await c.check()).toEqual({ phase: "available", latest: "0.2.0", checkedAt: "2026-11-05T10:00:00.000Z" });
    await c.check();
    expect(announce).toHaveBeenCalledOnce();
    expect(announce).toHaveBeenCalledWith("0.2.0");
  });

  it("announces a version it told about before no more after a restart", async () => {
    const { c, announce } = checker({ told: "0.2.0" });
    expect((await c.check()).phase).toBe("available");
    expect(announce).not.toHaveBeenCalled();
  });

  it("says up to date when nothing newer is out", async () => {
    const { c, announce } = checker({ fetch: vi.fn(async () => reply([release("v0.1.1"), release("v0.1.0")])) });
    expect((await c.check()).phase).toBe("current");
    expect(announce).not.toHaveBeenCalled();
  });

  it.each([
    ["a refused request", async () => reply({ message: "rate limited" }, 403)],
    ["no network", async () => { throw new TypeError("offline"); }],
    ["a reply of another shape", async () => reply({ tag_name: "v9.9.9" })],
    ["a reply that isn't JSON", async () => new Response("<html>")],
    ["a very long reply", async () => new Response("x".repeat(2_000_001))],
  ])("stays quiet after %s, and says so only in Home", async (_name, answer) => {
    const { c, announce } = checker({ fetch: vi.fn(answer) });
    expect((await c.check()).phase).toBe("failed");
    expect(announce).not.toHaveBeenCalled();
  });
});

describe("the setting", () => {
  it("is off by default, with no consent", () => {
    expect(SettingsSchema.parse({}).updates).toEqual({ on: false, consent: { version: 0, at: null }, told: null, checkedAt: null });
  });
  it("can be turned off by the administrator, and is off under lockdown", () => {
    const policy = parseAdminPolicy(JSON.stringify({ features: { updates: false } }), "test").policy;
    const on = { ...SettingsSchema.parse({}), updates: { on: true, consent: { version: 1, at: "x" }, told: null, checkedAt: null } };
    expect(applyAdminPolicy(on, policy).updates.on).toBe(false);
    expect(managedKeys(policy)).toContain("updates");
    expect(parseAdminPolicy("not json", "test").policy.features.updates).toBe(false);
  });
});

describe("Home's words", () => {
  it("says what is sent, and that nothing is installed", () => {
    expect(UPDATES_CONSENT_TEXT).toMatch(/GitHub/);
    expect(UPDATES_CONSENT_TEXT).toMatch(/never downloads or installs/);
  });
  it("says each state in a sentence", () => {
    expect(updateStatusText({ phase: "available", latest: "0.2.0", checkedAt: null })).toBe("Ember 0.2.0 is out.");
    expect(updateStatusText({ phase: "failed", latest: null, checkedAt: null })).toBe("Couldn't check for updates. Ember will try again tomorrow.");
    // Started again within a day of a look: no "shortly" (integrations-v3).
    expect(updateStatusText({ phase: "idle", latest: null, checkedAt: null })).toBe("Ember will check shortly.");
    expect(updateStatusText({ phase: "idle", latest: null, checkedAt: "2026-11-05T10:01:00.000Z" })).toBe("Ember checks once a day. Check now looks at once.");
    expect(updateStatusText({ phase: "checking", latest: null, checkedAt: null })).toBe("Checking…");
    expect(updateStatusText({ phase: "off", latest: null, checkedAt: null })).toBe("");
    expect(updateStatusText({ phase: "current", latest: null, checkedAt: null })).toBe("You have the latest version.");
  });
});
