/**
 * The npm launcher (packages/npm, published as ember-copilot): which release file each platform downloads and where
 * the program is inside it, reading SHA256SUMS, the cache folders, how Ember is started, and that the package's version
 * is the app's, which the publish workflow (.github/workflows/npm.yml) relies on.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assetFor, cacheDir, downloadUrl, launchCommand, packageVersion, parseSha256Sums, REPO } from "../../packages/npm/lib/launcher.mjs";
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
