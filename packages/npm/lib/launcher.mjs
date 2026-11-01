// The ember-copilot npm launcher: `ember` (or `ember-copilot`) downloads the Ember release matching this package's
// version from GitHub Releases on first run, checks it against the release's SHA256SUMS, unpacks it into a per-user
// cache folder and starts it detached, passing its arguments on. Node built-ins only: the package has no dependencies.
//   Windows: Ember-<v>-win-x64.zip         unpacked with tar.exe (bsdtar, Windows 10 1803+) or Expand-Archive
//   macOS:   Ember-<v>-mac-<arch>.zip      unpacked with ditto, quarantine removed, started with open(1)
//   Linux:   Ember-<v>-x86_64.AppImage     made executable
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import pathPosix from "node:path/posix";
import pathWin32 from "node:path/win32";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

/** The repository whose GitHub Releases hold Ember's packages. */
export const REPO = "komaladitya-08/Ember-Powered-by-Github-Copilot";

/** The name of the per-user cache folder (one subfolder per version). */
export const CACHE_NAME = "ember-npm";

/**
 * The release file for a platform and architecture, what kind it is, and where the program is once it is unpacked
 * (relative to the version's folder, POSIX separators). Throws for a platform Ember has no release for.
 * @param {string} platform process.platform
 * @param {string} arch process.arch
 * @param {string} version the app's version, without a leading "v"
 * @returns {{ asset: string; kind: "zip" | "appimage"; exe: string; app: string }}
 */
export function assetFor(platform, arch, version) {
  if (platform === "win32" && arch === "x64") {
    return { asset: `Ember-${version}-win-x64.zip`, kind: "zip", exe: "Ember/Ember.exe", app: "Ember" };
  }
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    return { asset: `Ember-${version}-mac-${arch}.zip`, kind: "zip", exe: "Ember.app/Contents/MacOS/Ember", app: "Ember.app" };
  }
  if (platform === "linux" && arch === "x64") {
    const asset = `Ember-${version}-x86_64.AppImage`;
    return { asset, kind: "appimage", exe: asset, app: asset };
  }
  throw new Error(`Ember ${version} has no release for ${platform}-${arch} (there are builds for win32-x64, darwin-arm64, darwin-x64 and linux-x64)`);
}

/**
 * The hashes in a SHA256SUMS file (sha256sum's "hash  name" or "hash *name" lines), by file name. Blank lines and
 * comments are skipped; any other line that isn't a SHA-256 line throws.
 * @param {string} text
 * @returns {Map<string, string>} file name → lowercase hex hash
 */
export function parseSha256Sums(text) {
  const sums = new Map();
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (!m) throw new Error(`SHA256SUMS line ${i + 1} isn't "<sha256>  <file>": ${JSON.stringify(line.slice(0, 120))}`);
    sums.set(m[2].trim(), m[1].toLowerCase());
  }
  return sums;
}

/**
 * The folder a version is unpacked into: %LOCALAPPDATA%\ember-npm\<v> on Windows, ~/Library/Caches/ember-npm/<v> on
 * macOS, $XDG_CACHE_HOME/ember-npm/<v> (default ~/.cache) elsewhere. EMBER_NPM_CACHE overrides the ember-npm folder.
 * @param {{ platform: string; env: Record<string, string | undefined>; home: string; version: string }} o
 */
export function cacheDir(o) {
  const p = o.platform === "win32" ? pathWin32 : pathPosix;
  if (o.env.EMBER_NPM_CACHE) return p.join(o.env.EMBER_NPM_CACHE, o.version);
  if (o.platform === "win32") return p.join(o.env.LOCALAPPDATA || p.join(o.home, "AppData", "Local"), CACHE_NAME, o.version);
  if (o.platform === "darwin") return p.join(o.home, "Library", "Caches", CACHE_NAME, o.version);
  const xdg = o.env.XDG_CACHE_HOME && p.isAbsolute(o.env.XDG_CACHE_HOME) ? o.env.XDG_CACHE_HOME : p.join(o.home, ".cache");
  return p.join(xdg, CACHE_NAME, o.version);
}

/**
 * Where a release file is downloaded from. EMBER_NPM_DOWNLOAD_BASE replaces "https://github.com/<repo>/releases/download"
 * (a mirror, or a local server in tests); the tag folder "v<version>" is added either way.
 * @param {string} version
 * @param {string} file
 * @param {Record<string, string | undefined>} [env]
 */
export function downloadUrl(version, file, env = {}) {
  const base = (env.EMBER_NPM_DOWNLOAD_BASE || `https://github.com/${REPO}/releases/download`).replace(/\/+$/, "");
  return `${base}/v${encodeURIComponent(version)}/${encodeURIComponent(file)}`;
}

/** The version of this package, which is the version of Ember it starts. */
export function packageVersion() {
  const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  return String(pkg.version);
}

const MARKER = ".ember-npm-complete";

/** @param {string} msg */
const say = msg => { if (!process.env.EMBER_NPM_QUIET) process.stderr.write(`ember-copilot: ${msg}\n`); };

/** GET `url`, throwing with the status on anything but 2xx. */
async function get(url) {
  const res = await fetch(url, { redirect: "follow", headers: { "user-agent": "ember-copilot-npm-launcher" } });
  if (!res.ok || !res.body) throw new Error(`downloading ${url} failed: HTTP ${res.status} ${res.statusText}`);
  return res;
}

/**
 * Downloads `url` to `file`, returning the SHA-256 of what was written (lowercase hex).
 * @param {string} url
 * @param {string} file
 */
async function download(url, file) {
  const res = await get(url);
  const total = Number(res.headers.get("content-length")) || 0;
  const hash = createHash("sha256");
  let seen = 0;
  let shown = -1;
  const tty = process.stderr.isTTY && !process.env.EMBER_NPM_QUIET;
  const tap = new Transform({
    transform(chunk, _enc, done) {
      hash.update(chunk);
      seen += chunk.length;
      const pct = total ? Math.floor((seen / total) * 100) : -1;
      if (tty && pct !== shown && pct % 5 === 0) { shown = pct; process.stderr.write(`\rember-copilot: ${pct}% of ${(total / 1048576).toFixed(0)} MB`); }
      done(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(/** @type {any} */ (res.body)), tap, fs.createWriteStream(file));
  if (tty) process.stderr.write("\n");
  return hash.digest("hex");
}

/**
 * Runs a command to completion, throwing with its output when it fails.
 * @param {string} file
 * @param {string[]} args
 */
function run(file, args) {
  const r = spawnSync(file, args, { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new Error(`${file} could not start: ${r.error.message}`);
  if (r.status !== 0) throw new Error(`${file} ${args.join(" ")} failed (exit ${r.status}): ${`${r.stderr}${r.stdout}`.trim().slice(-2000)}`);
}

/**
 * Unpacks a zip into `dir`: Windows's tar.exe, or PowerShell's Expand-Archive when tar.exe is missing; ditto on macOS
 * (it keeps the app's symlinks and signature).
 * @param {string} zip
 * @param {string} dir
 */
function unzip(zip, dir) {
  if (process.platform === "win32") {
    const tar = pathWin32.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
    if (fs.existsSync(tar)) return run(tar, ["-x", "-f", zip, "-C", dir]);
    const q = (/** @type {string} */ s) => `'${s.replace(/'/g, "''")}'`;
    return run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath ${q(zip)} -DestinationPath ${q(dir)} -Force`]);
  }
  if (process.platform === "darwin") return run("ditto", ["-x", "-k", zip, dir]);
  return run("unzip", ["-q", zip, "-d", dir]);
}

/**
 * Makes sure Ember `version` is unpacked in its cache folder, downloading and checking it first if it isn't, and
 * returns where it is.
 * @param {{ version: string; platform?: string; arch?: string; env?: Record<string, string | undefined>; force?: boolean }} o
 * @returns {Promise<{ dir: string; exe: string; app: string; fresh: boolean }>}
 */
export async function ensureInstalled(o) {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const target = assetFor(platform, o.arch ?? process.arch, o.version);
  const dir = cacheDir({ platform, env, home: os.homedir(), version: o.version });
  const p = platform === "win32" ? pathWin32 : pathPosix;
  const at = (/** @type {string} */ rel) => p.join(dir, ...rel.split("/"));
  if (!o.force && fs.existsSync(p.join(dir, MARKER)) && fs.existsSync(at(target.exe))) {
    return { dir, exe: at(target.exe), app: at(target.app), fresh: false };
  }

  const parent = p.dirname(dir);
  fs.mkdirSync(parent, { recursive: true });
  const work = fs.mkdtempSync(p.join(parent, `.${o.version}-`));
  try {
    say(`getting Ember ${o.version} for ${platform}-${o.arch ?? process.arch} (${target.asset}) from GitHub Releases`);
    const sumsText = await (await get(downloadUrl(o.version, "SHA256SUMS", env))).text();
    const want = parseSha256Sums(sumsText).get(target.asset);
    if (!want) throw new Error(`the v${o.version} release's SHA256SUMS has no line for ${target.asset}`);
    const file = p.join(work, target.asset);
    const got = await download(downloadUrl(o.version, target.asset, env), file);
    if (got !== want) throw new Error(`${target.asset} doesn't match SHA256SUMS (expected ${want}, got ${got}); nothing was installed`);
    say(`checked ${target.asset} against SHA256SUMS (sha256 ${got})`);

    const stage = p.join(work, "app");
    fs.mkdirSync(stage);
    if (target.kind === "zip") {
      unzip(file, stage);
      fs.rmSync(file, { force: true });
    } else {
      fs.renameSync(file, p.join(stage, target.asset));
    }
    const staged = p.join(stage, ...target.exe.split("/"));
    if (!fs.existsSync(staged)) throw new Error(`${target.asset} has no ${target.exe}`);
    if (target.kind === "appimage") fs.chmodSync(staged, 0o755);
    if (platform === "darwin") {
      // The download came through Node, which sets no quarantine flag, but a copied or re-downloaded cache can carry
      // one; Ember is ad-hoc signed, so Gatekeeper would refuse it with the flag on.
      spawnSync("xattr", ["-dr", "com.apple.quarantine", p.join(stage, target.app)], { stdio: "ignore" });
    }
    fs.writeFileSync(p.join(stage, MARKER), `${target.asset} ${got}\n`);

    fs.rmSync(dir, { recursive: true, force: true });
    try {
      fs.renameSync(stage, dir);
    } catch (err) {
      // Another launcher finished first: use its copy.
      if (!fs.existsSync(p.join(dir, MARKER))) throw err;
    }
    say(`installed Ember ${o.version} in ${dir}`);
    return { dir, exe: at(target.exe), app: at(target.app), fresh: true };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * How to start the installed app with `args`: open(1) on macOS (so Ember.app, not the terminal, is the app macOS asks
 * for permissions for), the program itself elsewhere.
 * @param {string} platform
 * @param {{ exe: string; app: string }} installed
 * @param {string[]} args
 * @returns {{ file: string; args: string[] }}
 */
export function launchCommand(platform, installed, args) {
  if (platform === "darwin") return { file: "open", args: ["-n", installed.app, ...(args.length ? ["--args", ...args] : [])] };
  return { file: installed.exe, args };
}

const HELP = `ember-copilot: starts Ember (https://github.com/${REPO}), downloading it on first run.

usage: ember [Ember's own arguments]

Launcher options (not passed to Ember):
  --npm-install-only   download and check Ember if needed, print where it is, and exit
  --npm-reinstall      download it again even if it is already in the cache
  --npm-where          print the cache folder for this version and exit
  --npm-help           this text

Environment: EMBER_NPM_CACHE (cache folder), EMBER_NPM_DOWNLOAD_BASE (mirror of the releases' download URL),
EMBER_NPM_QUIET=1 (no progress messages).`;

/**
 * The `ember` command.
 * @param {string[]} argv the arguments after the script
 * @returns {Promise<number>} the exit code
 */
export async function main(argv) {
  const own = new Set(["--npm-install-only", "--npm-reinstall", "--npm-where", "--npm-help"]);
  const flags = new Set(argv.filter(a => own.has(a)));
  const args = argv.filter(a => !own.has(a));
  const version = packageVersion();
  if (flags.has("--npm-help")) { process.stdout.write(`${HELP}\n`); return 0; }
  if (flags.has("--npm-where")) {
    process.stdout.write(`${cacheDir({ platform: process.platform, env: process.env, home: os.homedir(), version })}\n`);
    return 0;
  }
  const installed = await ensureInstalled({ version, force: flags.has("--npm-reinstall") });
  if (flags.has("--npm-install-only")) { process.stdout.write(`${installed.exe}\n`); return 0; }
  const cmd = launchCommand(process.platform, installed, args);
  await new Promise((resolve, reject) => {
    const child = spawn(cmd.file, cmd.args, { detached: true, stdio: "ignore", windowsHide: false });
    child.once("error", err => reject(new Error(`starting ${cmd.file} failed: ${err.message}`)));
    child.once("spawn", () => { child.unref(); resolve(undefined); });
  });
  say(`started Ember ${version}`);
  return 0;
}
