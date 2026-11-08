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

/**
 * Where the launcher gets Ember from, in what it says: GitHub Releases, or the mirror EMBER_NPM_DOWNLOAD_BASE names.
 * @param {Record<string, string | undefined>} [env]
 */
export function releaseSource(env = {}) {
  return env.EMBER_NPM_DOWNLOAD_BASE ? `the mirror at ${env.EMBER_NPM_DOWNLOAD_BASE}` : "GitHub Releases";
}

/**
 * What the launcher says when its version's release isn't there (the release's SHA256SUMS answers 404): the package
 * can reach npm before its release is published, and a mirror can lag behind GitHub.
 * @param {string} version
 * @param {Record<string, string | undefined>} [env]
 */
export function notReleased(version, env = {}) {
  return `Ember ${version} isn't on ${releaseSource(env)} yet, so there is nothing to start. Install a published version from https://github.com/${REPO}/releases instead.`;
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
  if (!res.ok || !res.body) throw Object.assign(new Error(`downloading ${url} failed: HTTP ${res.status} ${res.statusText}`), { status: res.status });
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
  // Serialise installers before downloading. Never steal a lock: its owner may still be publishing or rolling back.
  const lock = p.join(parent, `.${o.version}-install-lock`);
  try {
    fs.mkdirSync(lock);
  } catch (err) {
    if (err.code === "EEXIST") throw new Error(`another installer may be running; retry later (lock: ${lock}). If an installer was interrupted, see packages/npm/README.md for recovery; remove the lock only when no installer is running`, { cause: err });
    throw err;
  }
  let work;
  let preserveWork = false;
  let installError;
  try {
    // A first install may have completed between our initial cache check and acquiring the lock.
    if (!o.force && fs.existsSync(p.join(dir, MARKER)) && fs.existsSync(at(target.exe))) {
      return { dir, exe: at(target.exe), app: at(target.app), fresh: false };
    }
    work = fs.mkdtempSync(p.join(parent, `.${o.version}-`));
    say(`getting Ember ${o.version} for ${platform}-${o.arch ?? process.arch} (${target.asset}) from ${releaseSource(env)}`);
    const sums = await get(downloadUrl(o.version, "SHA256SUMS", env)).catch(err => {
      throw err?.status === 404 ? new Error(notReleased(o.version, env), { cause: err }) : err;
    });
    const sumsText = await sums.text();
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

    // Keep the previous installation until publication succeeds. In particular, Windows open handles can make
    // either rename fail. The version lock prevents another installer from publishing into the rollback gap.
    const previous = p.join(work, "previous");
    const hadPrevious = fs.existsSync(dir);
    if (hadPrevious) fs.renameSync(dir, previous);
    try {
      fs.renameSync(stage, dir);
    } catch (err) {
      if (hadPrevious) {
        try {
          // Never remove an unexpected destination (for example one created by an older, unlocked launcher).
          if (fs.existsSync(dir)) throw new Error("the cache destination is occupied", { cause: err });
          fs.renameSync(previous, dir);
        } catch (rollbackError) {
          preserveWork = true;
          throw new AggregateError([err, rollbackError], `installation failed and the previous installation could not be restored; it is saved at ${previous}, and the checked replacement at ${stage}`, { cause: rollbackError });
        }
      }
      throw err;
    }
    say(`installed Ember ${o.version} in ${dir}`);
    return { dir, exe: at(target.exe), app: at(target.app), fresh: true };
  } catch (err) {
    installError = err;
    throw err;
  } finally {
    // Cleanup must not hide the original failure, especially the saved-copy paths after a failed rollback.
    const cleanupErrors = [];
    try {
      if (work && !preserveWork) fs.rmSync(work, { recursive: true, force: true });
    } catch (err) {
      cleanupErrors.push(err);
    }
    try {
      fs.rmdirSync(lock);
    } catch (err) {
      cleanupErrors.push(err);
    }
    if (cleanupErrors.length) {
      const outcome = installError ? installError.message : `installation completed in ${dir}`;
      // eslint-disable-next-line no-unsafe-finally -- Intentionally report cleanup failure while retaining the primary error and recovery paths.
      throw new AggregateError(installError ? [installError, ...cleanupErrors] : cleanupErrors,
        `${outcome}; cleanup failed (work: ${work ?? "not created"}, lock: ${lock}); remove leftovers only when no installer is running`,
        { cause: installError ?? cleanupErrors[0] });
    }
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

/**
 * The command lines of the programs running now (`ps`; on Windows nothing, where a running Ember's folder can't be
 * renamed anyway). Throws when they can't be read, so nothing is removed then.
 * @returns {string}
 */
function runningCommands() {
  if (process.platform === "win32") return "";
  const r = spawnSync("ps", ["-axo", "command="], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error("ps failed");
  return r.stdout;
}

/**
 * Removes the cache's other versions once `keep` is installed, so each update doesn't leave the last one (200–600 MB)
 * behind. Only a complete install (its marker in place) is removed, never one whose installer holds its lock or whose
 * folder a running program's command line names, nor anything that isn't a version folder. Each goes by renaming it
 * aside first, which fails on Windows while Ember runs from it, and is skipped quietly on any failure; one left half
 * removed is retried next time. Its start log goes with it.
 * @param {{ parent: string; keep: string; platform?: string; running?: () => string }} o
 * @returns {string[]} the versions removed
 */
export function pruneVersions(o) {
  const p = (o.platform ?? process.platform) === "win32" ? pathWin32 : pathPosix;
  let names, running;
  try {
    names = fs.readdirSync(o.parent);
    running = (o.running ?? runningCommands)();
  } catch {
    return []; // Can't tell what is there or what runs: keep everything.
  }
  const removed = [];
  for (const name of names) {
    const leftover = /^\.trash-/.test(name);
    if (!leftover && (name === o.keep || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(name))) continue;
    const dir = p.join(o.parent, name);
    try {
      if (!leftover) {
        if (!fs.existsSync(p.join(dir, MARKER)) || fs.existsSync(p.join(o.parent, `.${name}-install-lock`)) || running.includes(dir)) continue;
        const aside = p.join(o.parent, `.trash-${name}-${process.pid}`);
        fs.renameSync(dir, aside);
        removed.push(name);
        fs.rmSync(p.join(o.parent, `.${name}-start.log`), { force: true });
        fs.rmSync(aside, { recursive: true, force: true });
      } else {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch {
      // In use, or not ours to remove: left for the next update.
    }
  }
  return removed;
}

/**
 * How the launcher runs Ember for `args`: the setup check (`doctor` or `--doctor`, passed on as `--doctor`, which the
 * AppImage's AppRun and Ember.exe both take) attached, so its report and exit code reach the terminal; anything else
 * detached, since Ember keeps running.
 * @param {string[]} args
 * @returns {{ attached: boolean; args: string[] }}
 */
export function runMode(args) {
  const doctor = args[0] === "doctor" || args.includes("--doctor");
  if (!doctor) return { attached: false, args };
  return { attached: true, args: ["--doctor", ...args.filter((a, i) => a !== "--doctor" && !(i === 0 && a === "doctor"))] };
}

/** How long a detached Ember is watched for: one that stops within this has failed to start (no display, a crash). */
const EARLY_MS = 3000;

/**
 * Starts `cmd`. Attached, it waits and passes on its output and exit code. Detached, its stderr goes to `log` and it
 * is watched for `earlyMs`: if it stops in that time with an error, what it said is printed and its exit code
 * returned; otherwise it is left running and 0 returned. (A pipe would break once the launcher exits, and Ember's
 * writes to a closed pipe would fail.)
 * @param {{ file: string; args: string[] }} cmd
 * @param {{ attached: boolean; log: string; earlyMs?: number; stdout?: NodeJS.WritableStream; stderr?: NodeJS.WritableStream }} o
 * @returns {Promise<number>}
 */
export async function start(cmd, o) {
  const stdout = o.stdout ?? process.stdout;
  const stderr = o.stderr ?? process.stderr;
  if (o.attached) {
    return await new Promise((resolve, reject) => {
      const child = spawn(cmd.file, cmd.args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: false });
      child.stdout.pipe(stdout, { end: false });
      child.stderr.pipe(stderr, { end: false });
      child.once("error", err => reject(new Error(`starting ${cmd.file} failed: ${err.message}`)));
      child.once("close", (code, signal) => resolve(code ?? (signal ? 128 + (os.constants.signals[signal] ?? 0) : 1)));
    });
  }
  const fd = fs.openSync(o.log, "w", 0o600);
  let child;
  try {
    child = await new Promise((resolve, reject) => {
      const c = spawn(cmd.file, cmd.args, { detached: true, stdio: ["ignore", "ignore", fd], windowsHide: false });
      c.once("error", err => reject(new Error(`starting ${cmd.file} failed: ${err.message}`)));
      c.once("spawn", () => resolve(c));
    });
    fs.writeSync(fd, `pid ${child.pid}\n`);
  } finally {
    fs.closeSync(fd);
  }
  const ended = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), o.earlyMs ?? EARLY_MS);
    child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  child.unref();
  if (!ended || ended.code === 0) return 0;
  const said = fs.readFileSync(o.log, "utf8").replace(/^pid \d+\n/m, "").trim();
  stderr.write(`ember-copilot: Ember stopped as it started (${ended.code === null ? `signal ${ended.signal}` : `exit ${ended.code}`})${said ? `:\n${said.slice(-4000)}` : "."}\n`);
  return ended.code ?? 1;
}

/**
 * The command the person ran, to name it in what the launcher says: `npx ember-copilot` under npx (which npm runs
 * with npm_command "exec"), otherwise `ember-copilot` or `ember` as its bin was called (npm's Windows shims run the
 * script itself, which reads as `ember`).
 * @param {string | undefined} script process.argv[1]
 * @param {Record<string, string | undefined>} env
 */
export function invokedAs(script, env) {
  if (env.npm_command === "exec") return "npx ember-copilot";
  return pathPosix.basename(String(script ?? "").replace(/\\/g, "/")) === "ember-copilot" ? "ember-copilot" : "ember";
}

/**
 * The launcher's help (`--help`, `-h`, `--npm-help`): Ember's own commands as it passes them on, then its options. It
 * answers for Ember, whose AppImage, Ember.exe and Ember.app would start rather than print usage.
 * @param {string} name what the person runs it as (invokedAs)
 */
export function usage(name) {
  const rows = [
    [name, "start Ember (it stays beside your cursor; run it again for its settings)"],
    [`${name} doctor`, "check this computer and explain anything that needs fixing"],
    [`${name} --show-settings`, "start Ember and open its settings"],
    [`${name} --ask`, "open the ask box (starting Ember if it isn't running)"],
  ];
  const width = Math.max(...rows.map(r => r[0].length)) + 2;
  return `ember-copilot starts Ember (https://github.com/${REPO}), downloading it on first run.

usage: ${name} [doctor | --show-settings | --ask]
${rows.map(([c, d]) => `  ${c.padEnd(width)}${d}`).join("\n")}
Other arguments are passed on to Ember.

Launcher options (not passed to Ember):
  --npm-install-only   download and check Ember if needed, print where it is, and exit
  --npm-reinstall      download it again even if it is already in the cache
  --npm-where          print the cache folder for this version and exit
  --npm-help           this text (also --help and -h)

Environment: EMBER_NPM_CACHE (cache folder), EMBER_NPM_DOWNLOAD_BASE (mirror of the releases' download URL),
EMBER_NPM_QUIET=1 (no progress messages).`;
}

/**
 * What to say instead of starting Ember on Linux without a display (an ssh session without -X, a text console), or
 * null. Ember would only stop as it starts, and the AppImage's own words name its file in the cache, which isn't on
 * the person's PATH; this names the command they ran.
 * @param {string} platform
 * @param {Record<string, string | undefined>} env
 * @param {string} name what the person runs it as (invokedAs)
 */
export function noDisplay(platform, env, name) {
  if (platform !== "linux" || env.DISPLAY) return null;
  return `Ember needs your desktop session (no display here). Run '${name}' from a terminal inside GNOME, or run '${name} doctor' to check this computer.`;
}

/**
 * The `ember` command.
 * @param {string[]} argv the arguments after the script
 * @param {{ platform?: string; env?: Record<string, string | undefined>; earlyMs?: number }} [o] this computer's, unless a test says otherwise
 * @returns {Promise<number>} the exit code
 */
export async function main(argv, o = {}) {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  const own = new Set(["--npm-install-only", "--npm-reinstall", "--npm-where", "--npm-help"]);
  const flags = new Set(argv.filter(a => own.has(a)));
  const args = argv.filter(a => !own.has(a));
  const version = packageVersion();
  const name = invokedAs(process.argv[1], env);
  if (flags.has("--npm-help") || args.includes("--help") || args.includes("-h")) { process.stdout.write(`${usage(name)}\n`); return 0; }
  if (flags.has("--npm-where")) {
    process.stdout.write(`${cacheDir({ platform, env, home: os.homedir(), version })}\n`);
    return 0;
  }
  const mode = runMode(args);
  // Said before any download: the setup check and an install-only run need no display, and go ahead.
  const blocked = mode.attached || flags.has("--npm-install-only") ? null : noDisplay(platform, env, name);
  if (blocked) { process.stderr.write(`ember-copilot: ${blocked}\n`); return 1; }
  const installed = await ensureInstalled({ version, platform, env, force: flags.has("--npm-reinstall") });
  if (flags.has("--npm-install-only")) { process.stdout.write(`${installed.exe}\n`); return 0; }
  const p = platform === "win32" ? pathWin32 : pathPosix;
  const log = p.join(p.dirname(installed.dir), `.${version}-start.log`);
  if (mode.attached && platform === "darwin") return await doctorMac(installed, mode.args, log);
  const code = await start(launchCommand(platform, installed, mode.args), { attached: mode.attached, log, earlyMs: o.earlyMs });
  if (!mode.attached && code === 0) {
    // Only once this version has started: Ember then points Start Ember when I log in (and Windows' Start menu
    // shortcut) at itself, which the setup check and an install-only run don't, so until then the older one stays.
    const removed = pruneVersions({ parent: p.dirname(installed.dir), keep: version, platform });
    if (removed.length) say(`removed the older ${removed.length === 1 ? "version" : "versions"} ${removed.join(", ")} from the cache`);
    say(`started Ember ${version}`);
  }
  return code;
}

/**
 * The setup check on a Mac: through open(1), so macOS judges Ember's own permissions (run directly, it would report
 * the terminal's), with its report sent to a file and printed once it finishes (README.md, Install on macOS).
 * @param {{ exe: string; app: string }} installed
 * @param {string[]} args
 * @param {string} log
 */
async function doctorMac(installed, args, log) {
  const report = `${log}.doctor`;
  fs.writeFileSync(report, "", { mode: 0o600 });
  fs.writeFileSync(log, "", { mode: 0o600 });
  const code = await start({ file: "open", args: ["-n", "-W", "--stdout", report, "--stderr", log, installed.app, "--args", ...args] }, { attached: true, log });
  process.stdout.write(fs.readFileSync(report, "utf8"));
  process.stderr.write(fs.readFileSync(log, "utf8"));
  return code;
}
