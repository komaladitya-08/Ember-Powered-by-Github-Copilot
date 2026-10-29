// Smoke test: the app starts, shows its window, a second launch hands over to the first instance, and a third with
// --ask (the launchers' Ask Ember: the Windows jump list, the Linux desktop entry's action) has it open its ask box.
// Linux needs an X display (in CI: xvfb-run -a npm run test:smoke). Windows and macOS need a logged-in desktop
// session (GitHub's hosted runners have one).
// By default it starts the development build (Electron with dist/app); --exe <path> (or EMBER_SMOKE_EXE) starts a
// packaged binary instead: dist/package/Ember/Ember.exe, dist/package/Ember.app/Contents/MacOS/Ember,
// /opt/ember/ember. It fails at once on "app.start_failed" or an early exit, waits up to 30 s for the window on Linux
// and 60 s on Windows and macOS (a cold start there includes antivirus scans; EMBER_SMOKE_TIMEOUT_MS overrides both),
// and cleanup never fails the test. --forbid <event> (repeatable) fails the run when the first instance logged that
// event by the time the second launch has handed over: CI's Windows job forbids "shortcut.unavailable", since the
// runner has nothing else holding Ember's shortcuts (it proves Electron registers Super as the Windows key).
// --folder <name> starts the development build from a copy of dist/app in a folder of that name (the rest of the
// repository linked beside it), and checks that the settings window's page loaded there, by its title on Chromium's
// debugging port: a % in the name made every window blank once (review #200).
// usage: node test/smoke/launch.mjs [--exe <path> | --folder <name>] [--forbid <event>]...
import { spawn, spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const argv = process.argv.slice(2);
const USAGE = "usage: node test/smoke/launch.mjs [--exe <path> | --folder <name>] [--forbid <event>]...";
const exeArg = argv.includes("--exe") ? argv[argv.indexOf("--exe") + 1] : process.env.EMBER_SMOKE_EXE;
if (argv.includes("--exe") && !exeArg) { console.error(USAGE); process.exit(2); }
const folder = argv.includes("--folder") ? argv[argv.indexOf("--folder") + 1] : null;
if (argv.includes("--folder") && (!folder || folder.startsWith("--") || exeArg)) { console.error(USAGE); process.exit(2); }
const forbidden = argv.flatMap((a, i) => (a === "--forbid" ? [argv[i + 1]] : []));
if (forbidden.some(e => !e || e.startsWith("--"))) { console.error(USAGE); process.exit(2); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const userData = mkdtempSync(path.join(tmpdir(), "ember-smoke-"));
/** --folder: <tmp>/<name>/ember holds a copy of dist/app, and links to everything else in the repository. */
const copied = folder ? path.join(mkdtempSync(path.join(tmpdir(), "ember-smoke-app-")), folder, "ember") : null;
if (copied) {
  mkdirSync(path.join(copied, "dist"), { recursive: true });
  cpSync(path.join(root, "dist", "app"), path.join(copied, "dist", "app"), { recursive: true });
  for (const name of readdirSync(root).filter(n => n !== "dist" && n !== ".git")) {
    const from = path.join(root, name);
    if (statSync(from).isDirectory()) symlinkSync(from, path.join(copied, name), "junction");
    else cpSync(from, path.join(copied, name));
  }
}
// A packaged Ember loads its own resources/app; Electron in development is given the repository (or its copy).
const [command, appArgs] = exeArg ? [path.resolve(exeArg), []] : [createRequire(import.meta.url)("electron"), [copied ?? root]];
// Chromium refuses to run as root with its sandbox, and containers often block user namespaces (Linux).
const flags = (process.platform === "linux" && process.getuid?.() === 0) || process.env.EMBER_SMOKE_NO_SANDBOX === "1" ? ["--no-sandbox"] : [];
const env = { ...process.env, EMBER_USER_DATA: userData, EMBER_LOG_STDOUT: "1" };
const windowMs = Number(process.env.EMBER_SMOKE_TIMEOUT_MS) || (process.platform === "linux" ? 30_000 : 60_000);

function launch(name, extra = []) {
  const debug = copied && name === "first" ? ["--remote-debugging-port=0"] : [];
  const child = spawn(command, [...appArgs, ...flags, ...debug, ...extra], { env, stdio: ["ignore", "pipe", "pipe"] });
  const events = [];
  /** Ask boxes opened for a launcher's --ask (ask.open from "launcher"). */
  const asked = { count: 0 };
  /** The log lines of forbidden events, as the app wrote them. */
  const forbiddenLines = [];
  const said = { stdout: "", stderr: "" };
  let failed = null;
  let buf = "";
  child.stdout.on("data", d => {
    said.stdout = (said.stdout + d).slice(-20_000);
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try {
        const entry = JSON.parse(line);
        const msg = entry.msg;
        events.push(msg);
        if (msg === "ask.open" && entry.source === "launcher") asked.count++;
        if (msg === "app.start_failed") failed ??= line.trim();
        if (forbidden.includes(msg)) forbiddenLines.push(line.trim());
      } catch { /* not a log line */ }
    }
  });
  child.stderr.on("data", d => {
    said.stderr = (said.stderr + d).slice(-20_000);
    if (process.env.EMBER_SMOKE_VERBOSE) process.stderr.write(`[${name}] ${d}`);
  });
  child.on("error", err => { failed ??= `couldn't start ${command}: ${err.message}`; });
  return { name, child, events, asked, forbiddenLines, said, failed: () => failed };
}

const exited = inst => inst.child.exitCode !== null || inst.child.signalCode !== null;
const exitText = inst => inst.child.signalCode ? `was killed (${inst.child.signalCode})` : `exited with ${inst.child.exitCode}`;

/** Waits for `pred`; fails at once if the instance reported a failed start, or exited (unless `exitOk`). */
const waitFor = (inst, pred, ms, what, { exitOk = false } = {}) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const id = setInterval(() => {
    if (pred()) { clearInterval(id); resolve(); return; }
    const why = inst.failed() ?? (!exitOk && exited(inst) ? `the ${inst.name} instance ${exitText(inst)}` : null);
    if (why) { clearInterval(id); reject(new Error(`${why} (waiting for ${what})`)); }
    else if (Date.now() - t0 > ms) { clearInterval(id); reject(new Error(`timed out after ${ms / 1000} s waiting for ${what}`)); }
  }, 100);
});

/** Stops an instance and everything it started. Windows: the whole process tree (GPU, renderers, utility processes). */
async function stop(inst) {
  if (exited(inst) || inst.child.pid === undefined) return;
  const gone = new Promise(r => inst.child.once("exit", r));
  if (process.platform === "win32") {
    spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/pid", String(inst.child.pid), "/T", "/F"], { stdio: "ignore" });
  } else {
    inst.child.kill();
  }
  const late = setTimeout(() => inst.child.kill("SIGKILL"), 15_000);
  await gone;
  clearTimeout(late);
}

/** Removes the temporary profile, retrying while Windows still holds its files; never fails the test. */
function cleanUp() {
  try {
    rmSync(userData, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (err) {
    console.log(`note couldn't remove ${userData}: ${err.message}`);
  }
  // --folder's copy: its links first, so nothing removes what they point to (the repository).
  if (!copied) return;
  try {
    for (const name of readdirSync(copied)) if (lstatSync(path.join(copied, name)).isSymbolicLink()) unlinkSync(path.join(copied, name));
    rmSync(path.dirname(path.dirname(copied)), { recursive: true, force: true, maxRetries: 20, retryDelay: 250 });
  } catch (err) {
    console.log(`note couldn't remove ${copied}: ${err.message}`);
  }
}

const tail = (inst, stream) => inst.said[stream].trim()
  ? `--- ${inst.name} instance's ${stream} (last lines) ---\n${inst.said[stream].trim().split("\n").slice(-40).join("\n")}\n`
  : "";

let first, second, third;
let ok = false;
try {
  first = launch("first");
  await waitFor(first, () => first.events.includes("window.home.shown"), windowMs, "home window");
  console.log("ok   first instance showed its window");
  if (copied) {
    // Chromium names the port on stderr; a page that failed to load has its URL's file name for a title.
    await waitFor(first, () => /DevTools listening on ws:\/\/[^:]+:\d+\//.test(first.said.stderr), 10_000, "Chromium's debugging port");
    const port = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(first.said.stderr)[1];
    let title = null;
    const t0 = Date.now();
    while (title !== "Ember" && Date.now() - t0 < 10_000) {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json().catch(() => []);
      title = pages.find(p => /\/renderer\/home\/index\.html/.test(p.url))?.title ?? null;
      if (title !== "Ember") await new Promise(r => setTimeout(r, 250));
    }
    if (title !== "Ember") throw new Error(`the settings window's page didn't load from a folder named "${folder}" (its title is ${JSON.stringify(title)})`);
    console.log(`ok   the settings window's page loaded from a folder named "${folder}"`);
  }

  second = launch("second");
  await waitFor(second, () => exited(second), windowMs, "the second instance to exit", { exitOk: true });
  if (second.child.exitCode !== 0) throw new Error(`second instance ${exitText(second)}`);
  if (!second.events.includes("instance.handover")) throw new Error("second instance did not hand over");
  await waitFor(first, () => first.events.includes("instance.second"), 10_000, "first instance to receive second-instance");
  console.log("ok   second launch handed over and the first instance focused its window");
  // Checked once the first instance has finished starting (it answered the second launch).
  if (forbidden.length) {
    if (first.forbiddenLines.length) throw new Error(`the first instance logged ${first.forbiddenLines.join("\n")}`);
    console.log(`ok   the first instance logged none of ${forbidden.join(", ")}`);
  }
  // Ask Ember from a launcher: Ember started again with --ask. Not set up yet (a fresh profile), the box sends the user
  // to settings, and says where it was asked for all the same.
  third = launch("third", ["--ask"]);
  await waitFor(third, () => exited(third), windowMs, "the third instance to exit", { exitOk: true });
  if (third.child.exitCode !== 0) throw new Error(`third instance ${exitText(third)}`);
  await waitFor(first, () => first.asked.count > 0, 10_000, "the first instance to open the ask box for a start with --ask");
  console.log("ok   a start with --ask handed over and the first instance opened its ask box");
  ok = true;
} catch (err) {
  console.error(`FAIL ${err.message}`);
  // What the app said, to tell why (with EMBER_SMOKE_VERBOSE its stderr was already shown as it came).
  for (const inst of [first, second, third].filter(Boolean)) {
    process.stderr.write((process.env.EMBER_SMOKE_VERBOSE ? "" : tail(inst, "stderr")) + tail(inst, "stdout"));
  }
} finally {
  for (const inst of [third, second, first].filter(Boolean)) {
    try { await stop(inst); } catch (err) { console.log(`note couldn't stop the ${inst.name} instance: ${err.message}`); }
  }
  cleanUp();
}
process.exit(ok ? 0 : 1);
