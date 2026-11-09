// What Ember costs while it waits (docs/ASSISTANT.md phase 0): starts the built app (dist/app) with a throwaway data
// folder, consent and voice on, and silence for a microphone, lets it settle, then samples every Electron process's
// memory (PSS from /proc: shared pages counted fairly, unlike RSS or working set) and CPU, and each page's main-thread
// CPU through DevTools. Prints a table and the same as JSON, to compare a change against main on the same computer.
// Linux only (it reads /proc); run it under a display and a session bus, as CI's el8 job runs Ember:
//   dbus-run-session -- xvfb-run -a -s "-screen 0 1280x1024x24" node scripts/perf/footprint.mjs [--settle 35] [--sample 20] [--sound] [--compositor] [--native] [--max-cpu 16] [--max-pss 950]
// --sound feeds Chromium's fake microphone tone instead of silence (speech detection never rests). --max-cpu (% of one
// core) and --max-pss (MB) are the budget: past either, it says so and exits 1 (docs/DEVELOPING.md records the figures).
// Listening runs on WebAssembly in a development build; --native runs it on sherpa-onnx's C API, as the Linux packages
// do (scripts/voice/fetch-capi.mjs checks it by SHA-256, fetching it first if it isn't there), and fails unless the
// voice process ran on it, every model included, from the sample's start to its end (one that stopped or was replaced
// meanwhile is left out of the total, and fails a budget run on WebAssembly too). Either way it says which backend the
// voice process listened on (voice.ready in Ember's log, not main's choice in voice.backend: listening-backend.mjs), so
// like is compared with like.
// The sample is of Ember awake at rest (it dozes after 3 minutes with the pointer still). Needs `npm run build`
// and the speech models from `node scripts/voice/prepare.mjs`. Not counted: the Copilot runtime (no sign-in) and the
// speech process for Ember's voice (it starts with the first reply). On Xvfb there is no GPU, so the GPU process
// composites in software, and no compositor, so the overlay falls back to the handle card: --compositor starts xcompmgr
// on the display first (EPEL's xcompmgr on EL8), so the overlay that sits beside the cursor on a desktop, the biggest
// drawer at rest, is measured too, and the run fails if it didn't start. Compare like with like.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LISTENING_KIND, listeningGap, listeningSeen, listeningWords, notNative } from "./listening-backend.mjs";

if (process.platform !== "linux") { console.error("footprint.mjs reads /proc: Linux only."); process.exit(2); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt; };
const settle = opt("--settle", 35), sample = opt("--sample", 20), sound = args.includes("--sound"), composited = args.includes("--compositor");
const native = args.includes("--native");
const maxCpu = opt("--max-cpu", Infinity), maxPss = opt("--max-pss", Infinity);
const budget = Number.isFinite(maxCpu) || Number.isFinite(maxPss);
// The consent this build asks for: an older one opens the returning user's card in Home and keeps the microphone shut,
// which is not Ember at rest (it was 6 after CONSENT_VERSION went to 7, so listening wasn't measured).
const consentVersion = Number(/export const CONSENT_VERSION = (\d+);/.exec(fs.readFileSync(path.join(root, "app/shared/consent.ts"), "utf8"))?.[1]);
if (!consentVersion) { console.error("Can't read CONSENT_VERSION from app/shared/consent.ts."); process.exit(2); }
const models = path.join(root, ".cache/voice/models");
if (!fs.existsSync(path.join(root, "dist/app/main.cjs"))) { console.error("Run `npm run build` first."); process.exit(2); }
if (!fs.existsSync(models)) { console.error("Run `node scripts/voice/prepare.mjs` first (the speech models)."); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-footprint-"));
const userData = path.join(tmp, "data");
fs.mkdirSync(userData, { mode: 0o700 });
fs.symlinkSync(models, path.join(userData, "models"));
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
  version: 1, onboarded: true, consent: { version: consentVersion, at: new Date().toISOString() }, voice: { consent: true }, wakeWord: true,
}));
// Two minutes of 16 kHz silence: speech detection rests, as it does in a quiet room.
const silence = path.join(tmp, "silence.wav");
{
  const n = 16_000 * 120, h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + n * 2, 4); h.write("WAVEfmt ", 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22); h.writeUInt32LE(16_000, 24); h.writeUInt32LE(32_000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write("data", 36); h.writeUInt32LE(n * 2, 40);
  fs.writeFileSync(silence, Buffer.concat([h, Buffer.alloc(n * 2)]));
}
const port = 9300 + Math.floor(Math.random() * 500);
const electron = path.join(root, "node_modules/electron/dist/electron");
const flags = [root, `--remote-debugging-port=${port}`, "--use-fake-device-for-media-stream", ...(sound ? [] : [`--use-file-for-fake-audio-capture=${silence}`])];
if (process.getuid?.() === 0) flags.push("--no-sandbox");
const wait = ms => new Promise(r => setTimeout(r, ms));
const compositor = composited ? spawn("xcompmgr", ["-n"], { stdio: "ignore" }) : null;
if (compositor) {
  try {
    await new Promise((resolve, reject) => { compositor.once("spawn", resolve); compositor.once("error", reject); });
  } catch {
    console.error("--compositor needs xcompmgr (on EL8, EPEL's xcompmgr package).");
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(2);
  }
  // It owns the display's compositing selection before Ember looks for one at start.
  await wait(500);
}
// The C API's folder, as fetch-capi.mjs prints it once every library matches its pin; never one from the caller's own
// environment, so a run without --native measures WebAssembly.
let capi = null;
if (native) {
  const fetched = spawnSync(process.execPath, [path.join(root, "scripts/voice/fetch-capi.mjs")], { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });
  capi = fetched.status === 0 ? fetched.stdout.trim().split("\n").pop() : null;
  if (!capi) {
    console.error("--native needs sherpa-onnx's C API (node scripts/voice/fetch-capi.mjs couldn't fetch or check it).");
    compositor?.kill("SIGTERM");
    fs.rmSync(tmp, { recursive: true, force: true });
    process.exit(2);
  }
}
const env = { ...process.env, EMBER_USER_DATA: userData };
delete env.EMBER_SHERPA_CAPI;
delete env.EMBER_VOICE_BACKEND;
if (capi) env.EMBER_SHERPA_CAPI = capi;
const app = spawn(electron, flags, { env, stdio: "ignore" });

/** Ember's log so far, which says what the voice process listened on (listening-backend.mjs). */
function logText() {
  try { return fs.readFileSync(path.join(userData, "logs", "ember.log"), "utf8"); } catch { return ""; } // no log yet: not known
}

/** Every process in the app's tree. */
function tree(pid) {
  const kids = new Map();
  for (const d of fs.readdirSync("/proc").filter(d => /^\d+$/.test(d))) {
    try {
      const ppid = Number(fs.readFileSync(`/proc/${d}/stat`, "utf8").replace(/^.*\) /, "").split(" ")[1]);
      kids.set(ppid, [...kids.get(ppid) ?? [], Number(d)]);
    } catch { /* gone meanwhile */ }
  }
  const out = [];
  const walk = p => { out.push(p); for (const k of kids.get(p) ?? []) walk(k); };
  walk(pid);
  return out;
}
const ticks = p => { try { const f = fs.readFileSync(`/proc/${p}/stat`, "utf8").replace(/^.*\) /, "").split(" "); return Number(f[11]) + Number(f[12]); } catch { return null; } };
const pssKb = p => { try { return Number(/^Pss:\s+(\d+)/m.exec(fs.readFileSync(`/proc/${p}/smaps_rollup`, "utf8"))[1]); } catch { return 0; } };
const kind = p => {
  try {
    // Chromium rewrites its children's command lines into one string (spaces, not NULs), so match on the whole of it.
    const cmd = fs.readFileSync(`/proc/${p}/cmdline`, "utf8").replace(/\0/g, " ");
    const type = /--type=([a-z-]+)/.exec(cmd)?.[1];
    const sub = /--utility-sub-type=([\w.]+)/.exec(cmd)?.[1];
    if (sub) return `utility ${sub.replace(/\.mojom\./, " ").replace(/Service$/, "")}`;
    if (type) return type;
    // A utility process whose line lost its --type: the network and audio services have no renderer-client-id.
    if (/--renderer-client-id=/.test(cmd)) return "renderer";
    if (/--gpu-preferences=/.test(cmd)) return "gpu-process";
    return /electron(\s|$)/.test(cmd.split(" --")[0]) ? "main" : "utility";
  } catch { return "?"; }
};

/**
 * Each page's main-thread CPU over `secs`, through DevTools (Performance.getMetrics TaskDuration). A page that closes
 * meanwhile (listening starting again closes the microphone's) is left out, as a process that ended is from the rows:
 * its calls answer nothing, where they left the run waiting for ever (reliability-performance-w6-1).
 */
async function pages(secs) {
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t => t.type === "page");
  const open = t => new Promise((resolve, reject) => {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const call = (method, params = {}) => new Promise(r => {
      if (ws.readyState !== WebSocket.OPEN) { r(undefined); return; }
      pending.set(++id, r);
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m.result); pending.delete(m.id); };
    ws.onclose = () => { for (const r of pending.values()) r(undefined); pending.clear(); };
    ws.onerror = reject;
    ws.onopen = () => resolve({ ws, call });
  });
  const task = async c => (await c.call("Performance.getMetrics"))?.metrics?.find(m => m.name === "TaskDuration")?.value ?? null;
  const conns = await Promise.all(list.map(open));
  await Promise.all(conns.map(c => c.call("Performance.enable")));
  const before = await Promise.all(conns.map(task));
  await wait(secs * 1000);
  const after = await Promise.all(conns.map(task));
  for (const c of conns) c.ws.close();
  return list.map((t, i) => ({ page: (/\/renderer\/([a-z-]+)\//.exec(t.url)?.[1]) ?? t.url, title: t.title, cpu: before[i] === null || after[i] === null ? null : Math.round((after[i] - before[i]) / secs * 1000) / 10 }))
    .filter(p => p.cpu !== null);
}

try {
  await wait(settle * 1000);
  if (app.exitCode !== null) throw new Error(`Ember exited (${app.exitCode}) before it settled`);
  // The log as the process list is taken: a voice process not ready by then, or one that stops before the end, isn't in
  // the total (reliability-performance-w6-1).
  const pids = tree(app.pid), atStart = logText();
  const t0 = new Map(pids.map(p => [p, ticks(p)]));
  const [perPage] = await Promise.all([pages(Math.min(10, sample)), wait(sample * 1000)]);
  const hz = 100; // USER_HZ on every Linux Ember runs on
  const rows = pids.map(p => {
    const a = t0.get(p), b = ticks(p);
    return { pid: p, kind: kind(p), pssMb: Math.round(pssKb(p) / 102.4) / 10, cpu: a === null || b === null ? 0 : Math.round((b - a) / hz / sample * 1000) / 10 };
  }).filter(r => r.pssMb > 0).sort((x, y) => y.pssMb - x.pssMb);
  const total = { pssMb: Math.round(rows.reduce((n, r) => n + r.pssMb, 0)), cpu: Math.round(rows.reduce((n, r) => n + r.cpu, 0) * 10) / 10 };
  const atEnd = logText(), seen = listeningSeen(atEnd), backend = seen.backend, gap = listeningGap(atStart, atEnd);
  // Listening measured throughout: one voice process ready as the sample began, none stopped or started since, and its
  // memory still there to read at the end (one that ended has none).
  const unmeasured = gap ?? (rows.some(r => r.kind === LISTENING_KIND) ? null : `no listening process (${LISTENING_KIND}) is in the rows`);
  const listening = `${listeningWords(seen)}${unmeasured ? ", not throughout the sample" : ""}`;
  console.log(`Ember at rest (${sound ? "a tone" : "silence"}, listening on ${listening}), over ${sample} s after ${settle} s; CPU in % of one core\n`);
  for (const r of rows) console.log(`${String(r.pssMb).padStart(7)} MB ${String(r.cpu).padStart(5)} %  ${r.kind}`);
  console.log(`${String(total.pssMb).padStart(7)} MB ${String(total.cpu).padStart(5)} %  total\n\nPages (main thread):`);
  for (const p of perPage) console.log(`${String(p.cpu).padStart(5)} %  ${p.page} (${p.title})`);
  console.log("\n" + JSON.stringify({ os: `${os.type()} ${os.release()}`, cpus: os.cpus().length, cpu: os.cpus()[0]?.model, sound, backend, backendFrom: seen.from, ...(seen.onWasm.length ? { onWasm: seen.onWasm } : {}), ...(unmeasured ? { listeningGap: unmeasured } : {}), settle, sample, total, rows, pages: perPage }));
  const over = [...(total.cpu > maxCpu ? [`${total.cpu} % of a core, over ${maxCpu} %`] : []), ...(total.pssMb > maxPss ? [`${total.pssMb} MB, over ${maxPss} MB`] : [])];
  if (over.length) { console.error(`\nOver budget: ${over.join("; ")}.`); process.exitCode = 1; }
  // A budget meant to count the overlay never passes without it (an overlay that fell back to the handle card).
  if (compositor && !perPage.some(p => p.page === "overlay")) { console.error("\nThe overlay didn't start, so it wasn't measured: is xcompmgr running on this display?"); process.exitCode = 1; }
  // Nor one meant to measure what the packages run, on WebAssembly (a C API that didn't load, a processor it can't use,
  // a model it couldn't make), on main's choice alone (reliability-performance-v6-1), or without the voice process that
  // ran on it from the sample's start to its end (reliability-performance-w6-1). Nor does any budget pass without
  // listening measured throughout: its total left the listening process out.
  const short = native ? notNative(seen) ?? unmeasured : null;
  if (short) { console.error(`\nThe native backend wasn't measured: ${short}.`); process.exitCode = 1; }
  else if (unmeasured) { console.error(`\nListening wasn't measured throughout the sample: ${unmeasured}.`); if (budget) process.exitCode = 1; }
} finally {
  app.kill("SIGTERM");
  compositor?.kill("SIGTERM");
  await wait(1500);
  fs.rmSync(tmp, { recursive: true, force: true });
}
