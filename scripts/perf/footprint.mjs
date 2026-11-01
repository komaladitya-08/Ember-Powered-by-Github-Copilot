// What Ember costs while it waits (docs/ASSISTANT.md phase 0): starts the built app (dist/app) with a throwaway data
// folder, consent and voice on, and silence for a microphone, lets it settle, then samples every Electron process's
// memory (PSS from /proc: shared pages counted fairly, unlike RSS or working set) and CPU, and each page's main-thread
// CPU through DevTools. Prints a table and the same as JSON, to compare a change against main on the same computer.
// Linux only (it reads /proc); run it under a display and a session bus, as CI's el8 job runs Ember:
//   dbus-run-session -- xvfb-run -a -s "-screen 0 1280x1024x24" node scripts/perf/footprint.mjs [--settle 35] [--sample 20] [--sound]
// --sound feeds Chromium's fake microphone tone instead of silence (speech detection never rests). Needs `npm run build`
// and the speech models from `node scripts/voice/prepare.mjs`. Not counted: the Copilot runtime (no sign-in) and the
// speech process for Ember's voice (it starts with the first reply). On Xvfb there is no GPU and no compositor, so the
// GPU process composites in software and the overlay falls back to the handle card: compare like with like.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "linux") { console.error("footprint.mjs reads /proc: Linux only."); process.exit(2); }
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const opt = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? Number(args[i + 1]) : dflt; };
const settle = opt("--settle", 35), sample = opt("--sample", 20), sound = args.includes("--sound");
const models = path.join(root, ".cache/voice/models");
if (!fs.existsSync(path.join(root, "dist/app/main.cjs"))) { console.error("Run `npm run build` first."); process.exit(2); }
if (!fs.existsSync(models)) { console.error("Run `node scripts/voice/prepare.mjs` first (the speech models)."); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "ember-footprint-"));
const userData = path.join(tmp, "data");
fs.mkdirSync(userData, { mode: 0o700 });
fs.symlinkSync(models, path.join(userData, "models"));
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
  version: 1, onboarded: true, consent: { version: 1, at: new Date().toISOString() }, voice: { consent: true }, wakeWord: true,
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
const app = spawn(electron, flags, { env: { ...process.env, EMBER_USER_DATA: userData }, stdio: "ignore" });
const wait = ms => new Promise(r => setTimeout(r, ms));

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

/** Each page's main-thread CPU over `secs`, through DevTools (Performance.getMetrics TaskDuration). */
async function pages(secs) {
  const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(t => t.type === "page");
  const open = t => new Promise((resolve, reject) => {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    let id = 0;
    const pending = new Map();
    const call = (method, params = {}) => new Promise(r => { pending.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
    ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m.result); pending.delete(m.id); };
    ws.onerror = reject;
    ws.onopen = () => resolve({ ws, call });
  });
  const task = async c => (await c.call("Performance.getMetrics")).metrics.find(m => m.name === "TaskDuration").value;
  const conns = await Promise.all(list.map(open));
  await Promise.all(conns.map(c => c.call("Performance.enable")));
  const before = await Promise.all(conns.map(task));
  await wait(secs * 1000);
  const after = await Promise.all(conns.map(task));
  for (const c of conns) c.ws.close();
  return list.map((t, i) => ({ page: (/\/renderer\/([a-z-]+)\//.exec(t.url)?.[1]) ?? t.url, title: t.title, cpu: Math.round((after[i] - before[i]) / secs * 1000) / 10 }));
}

try {
  await wait(settle * 1000);
  if (app.exitCode !== null) throw new Error(`Ember exited (${app.exitCode}) before it settled`);
  const pids = tree(app.pid);
  const t0 = new Map(pids.map(p => [p, ticks(p)]));
  const [perPage] = await Promise.all([pages(Math.min(10, sample)), wait(sample * 1000)]);
  const hz = 100; // USER_HZ on every Linux Ember runs on
  const rows = pids.map(p => {
    const a = t0.get(p), b = ticks(p);
    return { pid: p, kind: kind(p), pssMb: Math.round(pssKb(p) / 102.4) / 10, cpu: a === null || b === null ? 0 : Math.round((b - a) / hz / sample * 1000) / 10 };
  }).filter(r => r.pssMb > 0).sort((x, y) => y.pssMb - x.pssMb);
  const total = { pssMb: Math.round(rows.reduce((n, r) => n + r.pssMb, 0)), cpu: Math.round(rows.reduce((n, r) => n + r.cpu, 0) * 10) / 10 };
  console.log(`Ember at rest (${sound ? "a tone" : "silence"}), over ${sample} s after ${settle} s; CPU in % of one core\n`);
  for (const r of rows) console.log(`${String(r.pssMb).padStart(7)} MB ${String(r.cpu).padStart(5)} %  ${r.kind}`);
  console.log(`${String(total.pssMb).padStart(7)} MB ${String(total.cpu).padStart(5)} %  total\n\nPages (main thread):`);
  for (const p of perPage) console.log(`${String(p.cpu).padStart(5)} %  ${p.page} (${p.title})`);
  console.log("\n" + JSON.stringify({ os: `${os.type()} ${os.release()}`, cpus: os.cpus().length, cpu: os.cpus()[0]?.model, sound, settle, sample, total, rows, pages: perPage }));
} finally {
  app.kill("SIGTERM");
  await wait(1500);
  fs.rmSync(tmp, { recursive: true, force: true });
}
