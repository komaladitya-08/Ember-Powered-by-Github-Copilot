/** Deterministic publication failures against the real installer, without downloads or native programs. */
import fs from "node:fs";
import pathPosix from "node:path/posix";
import pathWin32 from "node:path/win32";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

type Options = { version: string; force?: boolean };
type Installed = { dir: string; exe: string; fresh: boolean };
const dir = "/cache/1";
const exe = `${dir}/Ember.AppImage`;
const marker = ".ember-npm-complete";
const source = fs.readFileSync("packages/npm/lib/launcher.mjs", "utf8");
const body = source.slice(source.indexOf("export async function ensureInstalled"), source.indexOf("\n/**\n * How to start"));
const denied = () => Object.assign(new Error("open handle: access denied"), { code: "EACCES" });

function harness(old = true) {
  const disk = new Map<string, string>([["/cache", "dir"]]);
  if (old) { disk.set(dir, "dir"); disk.set(exe, "old"); disk.set(`${dir}/${marker}`, "old hash"); }
  let serial = 0;
  const h = {
    disk, downloads: 0, cleanupFail: (_path: string) => false, fail: (_from: string, _to: string) => false,
    beforeDownload: async () => {},
    ensure: null as unknown as (o: Options) => Promise<Installed>,
  };
  const fake = {
    existsSync: (p: string) => disk.has(p),
    mkdirSync(p: string, options?: { recursive?: boolean }) {
      if (disk.has(p) && !options?.recursive) throw Object.assign(new Error("exists"), { code: "EEXIST" });
      disk.set(p, "dir");
    },
    mkdtempSync: (prefix: string) => { const p = `${prefix}${++serial}`; disk.set(p, "dir"); return p; },
    rmSync(p: string) { if (h.cleanupFail(p)) throw new Error(`cleanup denied: ${p}`); for (const key of disk.keys()) if (key === p || key.startsWith(`${p}/`)) disk.delete(key); },
    rmdirSync(p: string) { if (h.cleanupFail(p)) throw new Error(`cleanup denied: ${p}`); disk.delete(p); },
    renameSync(from: string, to: string) {
      if (h.fail(from, to)) throw denied();
      if (!disk.has(from)) throw Object.assign(new Error("missing"), { code: "ENOENT" });
      if (disk.has(to)) throw Object.assign(new Error("destination exists"), { code: "ENOTEMPTY" });
      for (const [key, value] of [...disk]) if (key === from || key.startsWith(`${from}/`)) {
        disk.set(to + key.slice(from.length), value); disk.delete(key);
      }
    },
    chmodSync() {}, writeFileSync: (p: string, value: string) => disk.set(p, value),
  };
  const context = vm.createContext({
    fs: fake, pathPosix, pathWin32, process: { platform: "linux", arch: "x64", env: {} },
    os: { homedir: () => "/home/fake" }, MARKER: marker, say() {},
    assetFor: () => ({ asset: "Ember.AppImage", exe: "Ember.AppImage", app: "Ember.AppImage", kind: "appimage" }),
    cacheDir: () => dir, downloadUrl: () => "fake", releaseSource: () => "GitHub Releases", parseSha256Sums: () => new Map([["Ember.AppImage", "hash"]]),
    get: async () => ({ text: async () => "sums" }),
    download: async (_url: string, file: string) => { h.downloads++; await h.beforeDownload(); disk.set(file, "new"); return "hash"; },
  });
  h.ensure = vm.runInContext(`${body.replace("export async", "async")}\nensureInstalled`, context);
  return h;
}

describe("npm reinstall publication", () => {
  it("restores the working copy after publication fails, including an offline next launch", async () => {
    const h = harness();
    h.fail = (from, to) => from.endsWith("/app") && to === dir;
    await expect(h.ensure({ version: "1", force: true })).rejects.toMatchObject({ code: "EACCES" });
    expect(h.disk.get(exe)).toBe("old");
    h.beforeDownload = async () => { throw new Error("offline"); };
    await expect(h.ensure({ version: "1" })).resolves.toMatchObject({ exe, fresh: false });
    expect(h.downloads).toBe(1);
    expect([...h.disk.keys()].filter(p => p.startsWith("/cache/."))).toEqual([]);
  });

  it("leaves the old copy in place if open handles prevent moving it", async () => {
    const h = harness(); h.fail = from => from === dir;
    await expect(h.ensure({ version: "1", force: true })).rejects.toMatchObject({ code: "EACCES" });
    expect(h.disk.get(exe)).toBe("old");
  });

  it("retains the backup and verified stage if rollback also fails", async () => {
    const h = harness(); h.fail = (_from, to) => to === dir;
    await expect(h.ensure({ version: "1", force: true })).rejects.toThrow(/previous installation.*previous/);
    expect([...h.disk].some(([p, value]) => p.endsWith("/previous/Ember.AppImage") && value === "old")).toBe(true);
    expect([...h.disk].some(([p, value]) => p.endsWith("/app/Ember.AppImage") && value === "new")).toBe(true);
  });

  it.each([true, false])("refuses a concurrent publisher without touching its files (old=%s)", async old => {
    const h = harness(old);
    let release!: () => void;
    h.beforeDownload = () => h.downloads === 1 ? new Promise<void>(resolve => { release = resolve; }) : Promise.resolve();
    const first = h.ensure({ version: "1", force: true });
    for (let i = 0; i < 5; i++) await Promise.resolve();
    await expect(h.ensure({ version: "1", force: true })).rejects.toThrow(/another installer/);
    if (old) await expect(h.ensure({ version: "1" })).resolves.toMatchObject({ fresh: false });
    release(); await first;
    expect(h.disk.get(exe)).toBe("new");
    expect(h.downloads).toBe(1);
  });

  it("does not remove an unexpected installation when rollback finds the destination occupied", async () => {
    const h = harness();
    h.fail = (from, to) => {
      if (!from.endsWith("/app") || to !== dir) return false;
      h.disk.set(dir, "dir"); h.disk.set(exe, "winner"); h.disk.set(`${dir}/${marker}`, "winner hash");
      return true;
    };
    await expect(h.ensure({ version: "1", force: true })).rejects.toThrow(/previous installation/);
    expect(h.disk.get(exe)).toBe("winner");
    expect([...h.disk.values()]).toContain("old");
    await expect(h.ensure({ version: "1" })).resolves.toMatchObject({ fresh: false });
  });

  it("releases the lock after download failure and preserves the working copy", async () => {
    const h = harness(); h.beforeDownload = async () => { throw new Error("offline"); };
    await expect(h.ensure({ version: "1", force: true })).rejects.toThrow("offline");
    expect(h.disk.get(exe)).toBe("old");
    expect([...h.disk.keys()].filter(p => p.startsWith("/cache/."))).toEqual([]);
  });

  it("cleans a failed first installation and permits a later retry", async () => {
    const h = harness(false); h.fail = (_from, to) => to === dir;
    await expect(h.ensure({ version: "1" })).rejects.toMatchObject({ code: "EACCES" });
    expect([...h.disk.keys()]).toEqual(["/cache"]);
    h.fail = () => false;
    await expect(h.ensure({ version: "1" })).resolves.toMatchObject({ fresh: true });
  });

  it("reports a stale lock without stealing it and still allows an offline cached launch", async () => {
    const h = harness(); h.disk.set("/cache/.1-install-lock", "dir");
    await expect(h.ensure({ version: "1", force: true })).rejects.toThrow(/remove the lock only when no installer is running/);
    expect(h.disk.has("/cache/.1-install-lock")).toBe(true);
    await expect(h.ensure({ version: "1" })).resolves.toMatchObject({ fresh: false });
    expect(h.downloads).toBe(0);
  });

  it("keeps recovery paths and the primary failure when lock cleanup also fails", async () => {
    const h = harness(); h.fail = (_from, to) => to === dir;
    h.cleanupFail = p => p.endsWith("-install-lock");
    const error = await h.ensure({ version: "1", force: true }).catch(error => error);
    expect(error.message).toMatch(/previous installation.*previous.*checked replacement.*app.*cleanup failed/s);
    expect(error.cause.message).toMatch(/previous installation/);
    expect(error.errors).toHaveLength(2);
    expect(error.errors[0]).toBe(error.cause);
    expect(error.errors[1].message).toMatch(/cleanup denied.*install-lock/);
    expect([...h.disk.values()]).toContain("old");
    expect([...h.disk.values()]).toContain("new");
  });

  it("reports cleanup failures after successful publication without losing the new install", async () => {
    const h = harness(); h.cleanupFail = () => true;
    const error = await h.ensure({ version: "1", force: true }).catch(error => error);
    expect(error.message).toMatch(/installation completed.*cleanup failed/);
    expect(error.message).toContain("/cache/.1-install-lock");
    expect(error.errors).toHaveLength(2);
    expect(h.disk.get(exe)).toBe("new");
    await expect(h.ensure({ version: "1" })).resolves.toMatchObject({ fresh: false });
  });

  it("preserves a download error when both cleanup operations fail", async () => {
    const h = harness(); h.beforeDownload = async () => { throw new Error("offline"); };
    h.cleanupFail = () => true;
    const error = await h.ensure({ version: "1", force: true }).catch(error => error);
    expect(error.message).toMatch(/offline.*cleanup failed/);
    expect(error.cause.message).toBe("offline");
    expect(error.errors).toHaveLength(3);
    expect(h.disk.get(exe)).toBe("old");
  });

  it("publishes successfully and removes only its own backup, stage and lock", async () => {
    const h = harness(); h.disk.set("/cache/.other-install", "unrelated");
    await expect(h.ensure({ version: "1", force: true })).resolves.toMatchObject({ exe, fresh: true });
    expect(h.disk.get(exe)).toBe("new");
    expect([...h.disk.keys()].filter(p => p.startsWith("/cache/."))).toEqual(["/cache/.other-install"]);
  });
});
