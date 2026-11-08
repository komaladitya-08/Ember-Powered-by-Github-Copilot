/**
 * The npm launcher (packages/npm, published as ember-copilot): which release file each platform downloads and where
 * the program is inside it, reading SHA256SUMS, the cache folders, how Ember is started, and that the package's version
 * is the app's, which the publish workflow (.github/workflows/npm.yml) relies on.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Writable } from "node:stream";
import { assetFor, cacheDir, downloadUrl, ensureInstalled, invokedAs, launchCommand, main, noDisplay, notReleased, packageVersion, parseSha256Sums, pruneVersions, releaseSource, REPO, runMode, start, usage } from "../../packages/npm/lib/launcher.mjs";
import { releaseFiles } from "../../scripts/package/release.mjs";

const read = (f: string) => fs.readFileSync(path.resolve(f), "utf8");
const root = JSON.parse(read("package.json"));
const launcher = JSON.parse(read("packages/npm/package.json"));

describe("assetFor", () => {
  it("picks the release file and program for each supported platform", () => {
    expect(assetFor("win32", "x64", "1.2.3")).toEqual({ asset: "Ember-1.2.3-win-x64.zip", kind: "zip", exe: "Ember/Ember.exe", app: "Ember" });
    expect(assetFor("darwin", "arm64", "1.2.3")).toEqual({ asset: "Ember-1.2.3-mac-arm64.zip", kind: "zip", exe: "Ember.app/Contents/MacOS/Ember", app: "Ember.app" });
    expect(assetFor("darwin", "x64", "1.2.3").asset).toBe("Ember-1.2.3-mac-x64.zip");
    expect(assetFor("linux", "x64", "1.2.3")).toEqual({ asset: "Ember-1.2.3-x86_64.AppImage", kind: "appimage", exe: "Ember-1.2.3-x86_64.AppImage", app: "Ember-1.2.3-x86_64.AppImage" });
  });
  it("refuses platforms with no release", () => {
    for (const [p, a] of [["linux", "arm64"], ["win32", "arm64"], ["freebsd", "x64"], ["darwin", "ia32"]]) {
      expect(() => assetFor(p, a, "1.2.3"), `${p}-${a}`).toThrow(/has no release for/);
    }
  });
  it("only downloads files every release has", () => {
    const files = releaseFiles("1.2.3");
    for (const [p, a] of [["win32", "x64"], ["darwin", "arm64"], ["darwin", "x64"], ["linux", "x64"]]) expect(files).toContain(assetFor(p, a, "1.2.3").asset);
  });
});

describe("parseSha256Sums", () => {
  const h = (c: string) => c.repeat(64);
  it("reads sha256sum's text and binary lines, skipping blanks and comments", () => {
    const sums = parseSha256Sums(`# sums\n${h("A")}  Ember-1.2.3-win-x64.zip\r\n\n${h("b")} *Ember-1.2.3-x86_64.AppImage\n`);
    expect([...sums]).toEqual([["Ember-1.2.3-win-x64.zip", h("a")], ["Ember-1.2.3-x86_64.AppImage", h("b")]]);
  });
  it("throws on a line that isn't a SHA-256 line", () => {
    expect(() => parseSha256Sums(`${h("a")}  ok.zip\nnot a hash  bad.zip\n`)).toThrow(/line 2/);
    expect(() => parseSha256Sums(`${"a".repeat(40)}  sha1.zip\n`)).toThrow(/line 1/);
  });
  it("reads the release's own SHA256SUMS format (docs/DEVELOPING.md §15: hash, two spaces, name)", () => {
    const line = `${h("c")}  ${releaseFiles("0.1.0")[0]}`;
    expect(parseSha256Sums(line).get(releaseFiles("0.1.0")[0])).toBe(h("c"));
  });
});

describe("cacheDir", () => {
  it("uses each platform's per-user cache folder", () => {
    expect(cacheDir({ platform: "win32", env: { LOCALAPPDATA: "C:\\Users\\k\\AppData\\Local" }, home: "C:\\Users\\k", version: "1.2.3" })).toBe("C:\\Users\\k\\AppData\\Local\\ember-npm\\1.2.3");
    expect(cacheDir({ platform: "win32", env: {}, home: "C:\\Users\\k", version: "1.2.3" })).toBe("C:\\Users\\k\\AppData\\Local\\ember-npm\\1.2.3");
    expect(cacheDir({ platform: "darwin", env: {}, home: "/Users/k", version: "1.2.3" })).toBe("/Users/k/Library/Caches/ember-npm/1.2.3");
    expect(cacheDir({ platform: "linux", env: {}, home: "/home/k", version: "1.2.3" })).toBe("/home/k/.cache/ember-npm/1.2.3");
    expect(cacheDir({ platform: "linux", env: { XDG_CACHE_HOME: "/var/c" }, home: "/home/k", version: "1.2.3" })).toBe("/var/c/ember-npm/1.2.3");
    expect(cacheDir({ platform: "linux", env: { XDG_CACHE_HOME: "relative" }, home: "/home/k", version: "1.2.3" })).toBe("/home/k/.cache/ember-npm/1.2.3");
    expect(cacheDir({ platform: "linux", env: { EMBER_NPM_CACHE: "/tmp/e" }, home: "/home/k", version: "1.2.3" })).toBe("/tmp/e/1.2.3");
  });
});

describe("downloads and starting", () => {
  it("downloads from the version's GitHub release, or a mirror", () => {
    expect(REPO).toBe("komaladitya-08/Ember-Powered-by-Github-Copilot");
    expect(downloadUrl("1.2.3", "SHA256SUMS")).toBe(`https://github.com/${REPO}/releases/download/v1.2.3/SHA256SUMS`);
    expect(downloadUrl("1.2.3", "a b.zip", { EMBER_NPM_DOWNLOAD_BASE: "http://127.0.0.1:9/m/" })).toBe("http://127.0.0.1:9/m/v1.2.3/a%20b.zip");
  });
  it("starts Ember.app with open(1) on macOS, passing the arguments, and the program itself elsewhere", () => {
    const i = { exe: "/c/Ember.app/Contents/MacOS/Ember", app: "/c/Ember.app" };
    expect(launchCommand("darwin", i, [])).toEqual({ file: "open", args: ["-n", "/c/Ember.app"] });
    expect(launchCommand("darwin", i, ["--doctor"])).toEqual({ file: "open", args: ["-n", "/c/Ember.app", "--args", "--doctor"] });
    expect(launchCommand("linux", { exe: "/c/E.AppImage", app: "/c/E.AppImage" }, ["a", "b c"])).toEqual({ file: "/c/E.AppImage", args: ["a", "b c"] });
  });
});

/** A local server for a release's files (`files`: path under the download base → content); anything else is a 404. */
async function serve(files: Record<string, string | Buffer> = {}) {
  const server = http.createServer((req, res) => {
    const body = files[decodeURIComponent(req.url ?? "")];
    if (body === undefined) { res.statusCode = 404; res.end("Not Found"); return; }
    res.end(body);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
const scratch: string[] = [];
const tempDir = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "ember-npm-test-")); scratch.push(d); return d; };
afterEach(() => { vi.unstubAllEnvs(); for (const d of scratch.splice(0)) fs.rmSync(d, { recursive: true, force: true }); });

describe("a version whose release isn't published", () => {
  it("says the version isn't on GitHub Releases yet, instead of an HTTP error, and leaves nothing behind (install-docs-2)", async () => {
    vi.stubEnv("EMBER_NPM_QUIET", "1");
    const server = await serve();
    const cache = tempDir();
    try {
      const env = { EMBER_NPM_DOWNLOAD_BASE: server.base, EMBER_NPM_CACHE: cache };
      const err = await ensureInstalled({ version: "9.9.9", platform: "linux", arch: "x64", env }).then(() => null, (e: Error) => e);
      expect(err?.message).toBe(notReleased("9.9.9", env));
      expect(err?.message).not.toMatch(/HTTP|404|downloading/);
      // No lock or half-made folder stays in the cache.
      expect(fs.readdirSync(cache)).toEqual([]);
    } finally {
      await server.close();
    }
    expect(notReleased("9.9.9", {})).toBe(`Ember 9.9.9 isn't on GitHub Releases yet, so there is nothing to start. Install a published version from https://github.com/${REPO}/releases instead.`);
    expect(notReleased("9.9.9", { EMBER_NPM_DOWNLOAD_BASE: "http://mirror.example/r" })).toContain("isn't on the mirror at http://mirror.example/r yet");
  });
});

describe("where the launcher gets Ember from", () => {
  it("names the mirror it downloads from, not GitHub Releases, when one is set (install-docs-2)", async () => {
    vi.stubEnv("EMBER_NPM_QUIET", "");
    const server = await serve();
    const said: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { said.push(String(chunk)); return true; }) as never);
    try {
      const env = { EMBER_NPM_DOWNLOAD_BASE: server.base, EMBER_NPM_CACHE: tempDir() };
      await ensureInstalled({ version: "9.9.9", platform: "linux", arch: "x64", env }).catch(() => null);
    } finally {
      spy.mockRestore();
      await server.close();
    }
    expect(said.join("")).toContain(`ember-copilot: getting Ember 9.9.9 for linux-x64 (Ember-9.9.9-x86_64.AppImage) from the mirror at ${server.base}\n`);
    expect(said.join("")).not.toContain("GitHub Releases");
    expect(releaseSource({})).toBe("GitHub Releases");
    expect(releaseSource({ EMBER_NPM_DOWNLOAD_BASE: "http://mirror.example/r" })).toBe("the mirror at http://mirror.example/r");
  });
});

/** What the launcher writes to stdout and stderr while `fn` runs. */
async function captured<T>(fn: () => Promise<T>): Promise<{ result: T; out: string; err: string }> {
  let out = "", err = "";
  const o = vi.spyOn(process.stdout, "write").mockImplementation(((chunk: string | Uint8Array) => { out += String(chunk); return true; }) as never);
  const e = vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => { err += String(chunk); return true; }) as never);
  try {
    return { result: await fn(), out, err };
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
}

/** A stand-in Ember: a Node script run with this Node, so the cases run on every OS. */
function fakeEmber(body: string) {
  const file = path.join(tempDir(), "ember.cjs");
  fs.writeFileSync(file, body);
  return { file: process.execPath, args: [file] };
}
/** A stream that keeps what is written to it. */
function sink() {
  let text = "";
  const stream = new Writable({ write(chunk, _enc, done) { text += String(chunk); done(); } });
  return { stream, text: () => text };
}

describe("starting Ember from the launcher", () => {
  it("runs the setup check attached, so its report and exit code reach the person (install-docs-3)", async () => {
    // `ember --doctor` and `ember doctor` both mean the check-up, passed on as --doctor (AppRun and Ember.exe take it).
    expect(runMode(["--doctor"])).toEqual({ attached: true, args: ["--doctor"] });
    expect(runMode(["doctor"])).toEqual({ attached: true, args: ["--doctor"] });
    expect(runMode(["doctor", "--verbose"])).toEqual({ attached: true, args: ["--doctor", "--verbose"] });
    expect(runMode([])).toEqual({ attached: false, args: [] });
    expect(runMode(["--ask"])).toEqual({ attached: false, args: ["--ask"] });
    const out = sink(), err = sink();
    const cmd = fakeEmber('process.stdout.write("Ember 9.9.9 setup check\\n  Display  fails\\n"); process.stderr.write("a warning\\n"); process.exit(3);');
    const code = await start(cmd, { attached: true, stdout: out.stream, stderr: err.stream, log: path.join(tempDir(), "start.log") });
    expect(code).toBe(3);
    expect(out.text()).toBe("Ember 9.9.9 setup check\n  Display  fails\n");
    expect(err.text()).toBe("a warning\n");
  });

  it("says why when Ember stops as it starts, with its exit code, instead of saying it started (install-docs-3)", async () => {
    const out = sink(), err = sink();
    const cmd = fakeEmber('process.stderr.write("Ember needs your desktop session (no display here).\\n"); process.exit(1);');
    const code = await start(cmd, { attached: false, stdout: out.stream, stderr: err.stream, log: path.join(tempDir(), "start.log"), earlyMs: 10_000 });
    expect(code).toBe(1);
    expect(err.text()).toContain("Ember needs your desktop session (no display here).");
    expect(err.text()).not.toContain("started Ember");
  });

  it("leaves a running Ember to itself after a moment and returns 0 (install-docs-3)", async () => {
    const out = sink(), err = sink();
    const log = path.join(tempDir(), "start.log");
    const cmd = fakeEmber('process.stderr.write("still starting\\n"); setTimeout(() => {}, 30_000);');
    const at = Date.now();
    const code = await start(cmd, { attached: false, stdout: out.stream, stderr: err.stream, log, earlyMs: 1500 });
    expect(code).toBe(0);
    expect(Date.now() - at).toBeGreaterThanOrEqual(1400);
    // What it said went to the start log, not the terminal; the pid there is the running stand-in, stopped here.
    expect(err.text()).toBe("");
    const pid = Number(/^pid (\d+)$/m.exec(fs.readFileSync(log, "utf8"))?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).not.toThrow();
    process.kill(pid);
    expect(fs.readFileSync(log, "utf8")).toContain("still starting");
  });
});

describe("the launcher's own answers", () => {
  it("prints its usage for --help or -h, in the name it was run by, and downloads or starts nothing (install-docs-3)", async () => {
    // Through npm the AppImage, Ember.exe and Ember.app have no --help of their own: Ember would start instead.
    const text = usage("ember");
    expect(text).toMatch(/^ember-copilot starts Ember/);
    expect(text).toContain("usage: ember [doctor | --show-settings | --ask]");
    for (const w of ["  ember doctor", "  ember --show-settings", "  ember --ask", "--npm-install-only", "--npm-where", "EMBER_NPM_DOWNLOAD_BASE"]) expect(text, w).toContain(w);
    expect(invokedAs("/usr/local/bin/ember", {})).toBe("ember");
    expect(invokedAs("/usr/local/bin/ember-copilot", {})).toBe("ember-copilot");
    expect(invokedAs("C:\\Users\\k\\AppData\\Roaming\\npm\\node_modules\\ember-copilot\\bin\\ember.mjs", {})).toBe("ember");
    expect(invokedAs("/home/k/.npm/_npx/1a/node_modules/.bin/ember-copilot", { npm_command: "exec" })).toBe("npx ember-copilot");
    const cache = tempDir();
    for (const flag of ["--help", "-h", "--npm-help"]) {
      const r = await captured(() => main([flag], { env: { EMBER_NPM_CACHE: cache, EMBER_NPM_DOWNLOAD_BASE: "http://127.0.0.1:9" } }));
      expect(r.result, flag).toBe(0);
      expect(r.out, flag).toContain("usage: ");
    }
    expect(fs.readdirSync(cache)).toEqual([]);
  });

  it("says to start it inside the desktop, or to run its setup check, when Linux has no display, before downloading (install-docs-3)", async () => {
    // The AppImage's own words name its file in the cache, which an npm user can't run by that name.
    const said = "Ember needs your desktop session (no display here). Run 'ember' from a terminal inside GNOME, or run 'ember doctor' to check this computer.";
    expect(noDisplay("linux", {}, "ember")).toBe(said);
    expect(noDisplay("linux", {}, "npx ember-copilot")).toContain("or run 'npx ember-copilot doctor'");
    expect(noDisplay("linux", { DISPLAY: ":0" }, "ember")).toBeNull();
    for (const os of ["win32", "darwin"]) expect(noDisplay(os, {}, "ember"), os).toBeNull();
    const cache = tempDir();
    for (const args of [[], ["--ask"]]) {
      const r = await captured(() => main(args, { platform: "linux", env: { EMBER_NPM_CACHE: cache, EMBER_NPM_DOWNLOAD_BASE: "http://127.0.0.1:9" } }));
      expect(r.result).toBe(1);
      expect(r.err).toBe(`ember-copilot: ${said}\n`);
    }
    expect(fs.readdirSync(cache)).toEqual([]);
  });
});

describe("updating through npm", () => {
  it("keeps only the newest version in the cache once it is installed, leaving what it can't be sure of (install-docs-10)", async () => {
    vi.stubEnv("EMBER_NPM_QUIET", "1");
    // Two releases on a local server, each a stand-in AppImage with its SHA256SUMS.
    const files: Record<string, string> = {};
    for (const v of ["0.1.1", "0.1.2"]) {
      const asset = `Ember-${v}-x86_64.AppImage`, body = `#!/bin/sh\necho ${v}\n`;
      files[`/v${v}/${asset}`] = body;
      files[`/v${v}/SHA256SUMS`] = `${createHash("sha256").update(body).digest("hex")}  ${asset}\n`;
    }
    const server = await serve(files);
    const cache = tempDir();
    try {
      const env = { EMBER_NPM_DOWNLOAD_BASE: server.base, EMBER_NPM_CACHE: cache };
      for (const v of ["0.1.1", "0.1.2"]) await ensureInstalled({ version: v, platform: "linux", arch: "x64", env });
    } finally {
      await server.close();
    }
    fs.writeFileSync(path.join(cache, ".0.1.1-start.log"), "pid 1\n");
    // Not Ember's to remove: a folder that isn't a complete install, another version's installer at work, a version
    // still running (its folder is in a running program's command line), and anything that isn't a version.
    fs.mkdirSync(path.join(cache, "0.0.9"));
    for (const v of ["0.0.7", "0.0.8"]) { fs.mkdirSync(path.join(cache, v)); fs.writeFileSync(path.join(cache, v, ".ember-npm-complete"), "x\n"); }
    fs.mkdirSync(path.join(cache, ".0.0.7-install-lock"));
    fs.mkdirSync(path.join(cache, "notes"));
    const removed = pruneVersions({ parent: cache, keep: "0.1.2", running: () => `/bin/sh ${path.join(cache, "0.0.8", "Ember-0.0.8-x86_64.AppImage")}\n` });
    expect(removed).toEqual(["0.1.1"]);
    expect(fs.readdirSync(cache).sort()).toEqual([".0.0.7-install-lock", "0.0.7", "0.0.8", "0.0.9", "0.1.2", "notes"]);
    // The kept version is untouched, and a failure to look at what runs keeps everything.
    expect(fs.existsSync(path.join(cache, "0.1.2", "Ember-0.1.2-x86_64.AppImage"))).toBe(true);
    expect(pruneVersions({ parent: cache, keep: "0.1.2", running: () => { throw new Error("no ps"); } })).toEqual([]);
    expect(fs.existsSync(path.join(cache, "0.0.8"))).toBe(true);
  });

  // The stand-in AppImage is a shell script, which this needs to run as the launcher runs the real one.
  it.skipIf(process.platform !== "linux" || process.arch !== "x64")("removes an older version only once the new one has started, never for the setup check, so Start at login keeps working (install-docs-10)", async () => {
    vi.stubEnv("EMBER_NPM_QUIET", "1");
    const v = packageVersion(), old = "0.0.1";
    const files: Record<string, string> = {};
    for (const ver of [old, v]) {
      const asset = `Ember-${ver}-x86_64.AppImage`;
      const body = `#!/bin/sh\nif [ "$1" = --doctor ]; then echo "setup check ${ver}"; exit 0; fi\nexec sleep 30\n`;
      files[`/v${ver}/${asset}`] = body;
      files[`/v${ver}/SHA256SUMS`] = `${createHash("sha256").update(body).digest("hex")}  ${asset}\n`;
    }
    const server = await serve(files);
    const cache = tempDir();
    const env = { EMBER_NPM_DOWNLOAD_BASE: server.base, EMBER_NPM_CACHE: cache, DISPLAY: ":99" };
    try {
      await ensureInstalled({ version: old, platform: "linux", arch: "x64", env });
      // The first command after `npm i -g ember-copilot@latest` is the setup check: it installs the new version, and
      // the login entry, which only a running Ember moves, still points at the old one, so that one stays.
      const doctor = await captured(() => main(["doctor"], { platform: "linux", env }));
      expect(doctor.result).toBe(0);
      expect(doctor.out).toContain(`setup check ${v}`);
      expect(fs.existsSync(path.join(cache, v, ".ember-npm-complete"))).toBe(true);
      expect(fs.existsSync(path.join(cache, old))).toBe(true);
      expect((await captured(() => main(["--npm-install-only"], { platform: "linux", env }))).result).toBe(0);
      expect(fs.existsSync(path.join(cache, old))).toBe(true);
      // The new version started and kept running: now the old one goes.
      expect((await captured(() => main([], { platform: "linux", env, earlyMs: 300 }))).result).toBe(0);
      expect(fs.existsSync(path.join(cache, old))).toBe(false);
      expect(fs.existsSync(path.join(cache, v, `Ember-${v}-x86_64.AppImage`))).toBe(true);
    } finally {
      const log = path.join(cache, `.${v}-start.log`);
      const pid = fs.existsSync(log) ? Number(/^pid (\d+)$/m.exec(fs.readFileSync(log, "utf8"))?.[1]) : 0;
      if (pid > 0) try { process.kill(pid); } catch { /* already gone */ }
      await server.close();
    }
  });

  it("gives update steps, and uninstall steps in an order that works (install-docs-10)", () => {
    const own = read("packages/npm/README.md").replace(/\s+/g, " ");
    const update = own.split("## Update")[1]?.split("## ")[0] ?? "";
    expect(update).toContain("`npm i -g ember-copilot@latest`");
    expect(update).toMatch(/[Qq]uit Ember/);
    // Older versions go only once the new one has started (it then moves the login entry): not for the setup check.
    expect(update).toContain("once the new version has started");
    expect(update).toContain("`ember doctor` and `--npm-install-only` remove nothing");
    const uninstall = own.split("## Uninstall")[1]?.split("## ")[0] ?? "";
    // The cache folder before `npm rm -g`, which takes `ember --npm-where` with it.
    const where = uninstall.indexOf("ember --npm-where"), rm = uninstall.indexOf("npm rm -g ember-copilot");
    expect(where).toBeGreaterThan(-1);
    expect(rm).toBeGreaterThan(where);
    for (const dir of ["%LOCALAPPDATA%\\ember-npm", "~/Library/Caches/ember-npm", "~/.cache/ember-npm"]) expect(uninstall, dir).toContain(dir);
    expect(uninstall).toContain("**Start Ember when I log in**");
    for (const dir of ["~/.config/ember", "%LOCALAPPDATA%\\ember", "~/Library/Application Support/ember"]) expect(uninstall, dir).toContain(dir);
    // What a packaged Ember leaves outside both folders, as README's own uninstall steps name it: Windows' Start menu
    // shortcut (written by every packaged Ember, the npm cache's included), a Mac's permission lists, the desk's folder.
    expect(read("app/main/platform/win32/system/lifecycle.ts")).toContain('const file = path.win32.join(dir, "Ember.lnk");');
    for (const w of ["`Ember.lnk` in `%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs`", "**System Settings › Privacy & Security** list it is on", "`~/Ember`"]) expect(uninstall, w).toContain(w);
    // A Mac's setup check warns about any copy outside Applications, the cache's included (environment.ts).
    expect(read("app/main/environment.ts")).toContain("Ember isn't in the Applications folder, so its permissions and login item may not stick.");
    expect(own).toMatch(/setup check warns that Ember isn't in the Applications folder/);
  });
});

describe("packages/npm/package.json", () => {
  it("has the app's version, so it downloads the release it was published with", () => {
    expect(launcher.version).toBe(root.version);
    expect(packageVersion()).toBe(root.version);
  });
  it("is the ember-copilot package with both commands, no dependencies, and the repository provenance needs", () => {
    expect(launcher.name).toBe("ember-copilot");
    expect(launcher.bin).toEqual({ ember: "bin/ember.mjs", "ember-copilot": "bin/ember.mjs" });
    expect(launcher.dependencies).toBeUndefined();
    expect(launcher.private).toBeUndefined();
    expect(launcher.repository.url).toBe(`git+https://github.com/${REPO}.git`);
    expect(launcher.repository.directory).toBe("packages/npm");
    expect(read("packages/npm/bin/ember.mjs")).toMatch(/^#!\/usr\/bin\/env node\n/);
    // The app itself is never published to npm.
    expect(root.private).toBe(true);
  });
  it("imports only Node built-ins", () => {
    const src = read("packages/npm/lib/launcher.mjs") + read("packages/npm/bin/ember.mjs");
    const specs = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map(m => m[1]);
    expect(specs.length).toBeGreaterThan(0);
    for (const s of specs) expect(s, s).toMatch(/^(node:|\.\.\/lib\/)/);
  });
});

describe(".github/workflows/npm.yml", () => {
  const wf = read(".github/workflows/npm.yml");
  it("runs after ci on a v* tag push that passed, or by hand for an existing release", () => {
    expect(wf).toMatch(/workflow_run:\n {4}workflows: \[ci\]\n {4}types: \[completed\]/);
    expect(wf).toContain("workflow_dispatch:");
    expect(wf).toContain("github.event.workflow_run.event == 'push' && github.event.workflow_run.conclusion == 'success'");
    expect(wf).toContain("startsWith(github.event.workflow_run.head_branch, 'v')");
    expect(read(".github/workflows/ci.yml")).toMatch(/^name: ci$/m);
  });
  it("can't write to the repository, and may mint an OIDC token for trusted publishing and provenance", () => {
    expect(wf).not.toMatch(/contents: write/);
    expect(wf).toMatch(/permissions:\n {6}contents: read\n {6}id-token: write/);
    expect(wf).toMatch(/npm install -g npm@(\d+)\.(\d+)/);
    const [, major, minor] = /npm install -g npm@(\d+)\.(\d+)/.exec(wf)!.map(Number);
    expect(major * 100 + minor).toBeGreaterThanOrEqual(1105);
  });
  it("checks the version against the tag and the release's files before publishing, and skips without credentials", () => {
    const at = (s: string) => { const i = wf.indexOf(s); expect(i, s).toBeGreaterThan(0); return i; };
    expect(at("isn't the tag's") < at("gh release view") && at("gh release view") < at("npm publish --access public --provenance")).toBe(true);
    expect(wf).toContain("secrets.NPM_TOKEN");
    expect(wf).toMatch(/if \[ -z "\$NPM_TOKEN" \]; then\n\s+echo "::warning::[^\n]*"\n\s+exit 0/);
  });
});
