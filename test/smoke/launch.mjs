// Smoke test: the app starts, shows its window, and a second launch hands over
// to the first instance. Needs an X display (in CI: xvfb-run -a npm run test:smoke).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const electron = createRequire(import.meta.url)("electron");
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const userData = mkdtempSync(path.join(tmpdir(), "ember-smoke-"));
// Chromium refuses to run as root with its sandbox, and containers often block user namespaces.
const flags = process.getuid?.() === 0 || process.env.EMBER_SMOKE_NO_SANDBOX === "1" ? ["--no-sandbox"] : [];
const env = { ...process.env, EMBER_USER_DATA: userData, EMBER_LOG_STDOUT: "1" };

function launch(name) {
  const child = spawn(electron, [root, ...flags], { env, stdio: ["ignore", "pipe", "pipe"] });
  const events = [];
  let buf = "";
  child.stdout.on("data", d => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      try { events.push(JSON.parse(line).msg); } catch { /* not a log line */ }
    }
  });
  child.stderr.on("data", d => process.env.EMBER_SMOKE_VERBOSE && process.stderr.write(`[${name}] ${d}`));
  return { child, events };
}

const waitFor = (pred, ms, what) => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const id = setInterval(() => {
    if (pred()) { clearInterval(id); resolve(); }
    else if (Date.now() - t0 > ms) { clearInterval(id); reject(new Error(`timed out waiting for ${what}`)); }
  }, 100);
});

let first;
let ok = false;
try {
  first = launch("first");
  await waitFor(() => first.events.includes("window.home.shown"), 30000, "home window");
  console.log("ok   first instance showed its window");

  const second = launch("second");
  const code = await new Promise(r => second.child.on("exit", r));
  if (code !== 0) throw new Error(`second instance exited with ${code}`);
  if (!second.events.includes("instance.handover")) throw new Error("second instance did not hand over");
  await waitFor(() => first.events.includes("instance.second"), 10000, "first instance to receive second-instance");
  console.log("ok   second launch handed over and the first instance focused its window");
  ok = true;
} catch (err) {
  console.error(`FAIL ${err.message}`);
} finally {
  if (first && first.child.exitCode === null) {
    const exited = new Promise(r => first.child.once("exit", r));
    first.child.kill();
    await exited;
  }
  rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
process.exit(ok ? 0 : 1);
