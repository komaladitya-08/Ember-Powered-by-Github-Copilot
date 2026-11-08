/**
 * Telling the user a newer Ember is out (app/main/updates.ts): nothing touches the network until it is allowed, it asks
 * GitHub with no token, each version is announced once, a bad reply stays quiet, and the link is built from the number.
 */

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECK_EVERY_MS, FIRST_CHECK_MS, installKind, isNewer, newestVersion, NPM_MARKER, releasePage, RELEASES_URL, UpdateChecker, updateNotice, versionOf } from "../../app/main/updates";
import { applyAdminPolicy, managedKeys, parseAdminPolicy } from "../../app/main/admin";
import { updateHowTo, updateStatusText, UPDATES_CONSENT_TEXT } from "../../app/renderer/home/copy";
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

  it("still says a newer version it found is out after a restart within the day, with no request (integrations-r6)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-05T12:00:00Z"));
    const fetch = vi.fn(async () => reply([release("v9.9.9")]));
    const start = (current: string, told: string | null) => {
      const c = new UpdateChecker({
        fetch: fetch as never, current, allowed: () => true, told: () => told, announce: vi.fn(), changed: vi.fn(), log: { warn: vi.fn() },
        lastChecked: () => "2026-11-05T10:00:00.000Z", checked: vi.fn(),
      });
      c.refresh();
      return c;
    };
    const again = start("0.1.1", "9.9.9");
    expect(again.status).toEqual({ phase: "available", latest: "9.9.9", checkedAt: "2026-11-05T10:00:00.000Z" });
    expect(updateStatusText(again.status)).not.toBe(updateStatusText({ phase: "idle", latest: null, checkedAt: "2026-11-05T10:00:00.000Z" }));
    expect(fetch).not.toHaveBeenCalled();
    again.stop();
    // Updated to it since: nothing newer is said until the next look.
    const updated = start("9.9.9", "9.9.9");
    expect(updated.status.phase).toBe("idle");
    updated.stop();
    // Never told of one: as before.
    const none = start("0.1.1", null);
    expect(none.status.phase).toBe("idle");
    none.stop();
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

describe("how to install a new version, for this kind of install (install-docs-11)", () => {
  const has = (...files: string[]) => (p: string) => files.includes(p);
  const kind = (os: "linux" | "win32" | "darwin", execPath: string, o: { appImage?: string; files?: string[]; packaged?: boolean } = {}) =>
    installKind({ os, packaged: o.packaged ?? true, execPath, appImage: o.appImage ?? null, exists: has(...(o.files ?? [])) });

  it("tells the RPM, the AppImage, the Windows zip, the Mac's app and the npm launcher's copy apart (install-docs-11)", () => {
    expect(kind("linux", "/opt/ember/ember")).toBe("rpm");
    expect(kind("linux", "/tmp/.mount_EmberAb/ember/ember", { appImage: "/home/k/Ember-0.1.1-x86_64.AppImage" })).toBe("appimage");
    expect(kind("win32", "C:\\Users\\k\\AppData\\Local\\Programs\\Ember\\Ember.exe")).toBe("zip");
    expect(kind("darwin", "/Applications/Ember.app/Contents/MacOS/Ember")).toBe("app");
    // The npm launcher's cache marks each complete version folder (packages/npm/lib/launcher.mjs).
    expect(fs.readFileSync(path.resolve("packages/npm/lib/launcher.mjs"), "utf8")).toContain(`const MARKER = "${NPM_MARKER}";`);
    const npmLinux = "/home/k/.cache/ember-npm/0.1.1";
    expect(kind("linux", "/tmp/.mount_EmberCd/ember/ember", { appImage: `${npmLinux}/Ember-0.1.1-x86_64.AppImage`, files: [`${npmLinux}/${NPM_MARKER}`] })).toBe("npm");
    const npmWin = "C:\\Users\\k\\AppData\\Local\\ember-npm\\0.1.1";
    expect(kind("win32", `${npmWin}\\Ember\\Ember.exe`, { files: [`${npmWin}\\${NPM_MARKER}`] })).toBe("npm");
    const npmMac = "/Users/k/Library/Caches/ember-npm/0.1.1";
    expect(kind("darwin", `${npmMac}/Ember.app/Contents/MacOS/Ember`, { files: [`${npmMac}/${NPM_MARKER}`] })).toBe("npm");
    // Development, or a Linux build run from somewhere no package puts it: nothing to say.
    expect(kind("linux", "/opt/ember/ember", { packaged: false })).toBeNull();
    expect(kind("linux", "/home/k/src/ember/release/linux-unpacked/ember")).toBeNull();
  });

  it("says how to update under “Ember X is out.”, in Home's words, while a newer version is out (install-docs-11)", () => {
    expect(updateHowTo("rpm")).toBe("To update, quit Ember, download the new RPM from See what's new… and install it with sudo dnf upgrade.");
    expect(updateHowTo("appimage")).toBe("To update, quit Ember, download the new AppImage from See what's new…, save it where this one is, make it executable and start it.");
    expect(updateHowTo("zip")).toBe("To update, quit Ember, download the new zip from See what's new… and replace the Ember folder with the one in it.");
    expect(updateHowTo("app")).toBe("To update, quit Ember, download the new dmg from See what's new… and drag Ember into Applications over this one, then allow its permissions again.");
    expect(updateHowTo("npm")).toBe("To update, quit Ember, run npm i -g ember-copilot@latest and start ember again.");
    expect(updateHowTo(null)).toBe("");
    // Home shows it only while a newer version is out, under its status line, from main's word of the install.
    const home = fs.readFileSync(path.resolve("app/renderer/home/index.html"), "utf8");
    expect(home).toContain('<p class="hint" id="updates-status" role="status"></p>\n      <p class="hint" id="updates-how" hidden></p>');
    const page = fs.readFileSync(path.resolve("app/renderer/home/main.ts"), "utf8");
    expect(page).toContain('const how = s.phase === "available" ? updateHowTo(platform?.install ?? null) : "";');
    const main = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8");
    expect(main).toContain("install: installKind({ os: platform.os, packaged: app.isPackaged, execPath: process.execPath, appImage: runningAppImage(process.env, process.execPath), exists: fs.existsSync }),");
    expect(fs.readFileSync(path.resolve("README.md"), "utf8").replace(/\s+/g, " ")).toContain("**Updates** says how for the way you installed Ember");
  });
});

describe("the notice that a new version is out", () => {
  it("opens Home's Updates section at See what's new… when clicked (install-docs-11)", () => {
    const notice = updateNotice("0.2.0");
    expect(notice).toEqual({ title: "Ember: a new version is out", body: "Ember 0.2.0 is out. Open Ember's settings to see what's new.", section: "updates:updates-open" });
    // The section's heading and the button it focuses, which shows while a version is out (home/main.ts showSection).
    const home = fs.readFileSync(path.resolve("app/renderer/home/index.html"), "utf8");
    const [section, control] = notice.section.split(":");
    expect(home).toContain(`<h2 id="${section}-h" tabindex="-1">Updates</h2>`);
    expect(home).toMatch(new RegExp(`<button type="button" id="${control}" class="btn small" hidden>See what's new…</button>`));
    // main.ts shows it with a click that opens Home there, as the handle menu's items do.
    const main = fs.readFileSync(path.resolve("app/main/main.ts"), "utf8");
    expect(main).toContain("notify(notice.title, notice.body, () => { showHome(); sendToHome(IPC.focusSection, notice.section); });");
    expect(main).toContain('n.on("click", () => { clickable.delete(n); onClick(); });');
  });
});
