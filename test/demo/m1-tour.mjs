// Records a tour of M1 on the demo desktop (scripts/demo/desktop.sh start):
// onboarding picker, Ember following the cursor, the four characters, moods, the handle menu.
// usage: DISPLAY=:55 node test/demo/m1-tour.mjs <out-dir>
import { _electron as electron } from "playwright-core";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const out = path.resolve(process.argv[2] ?? "dist/demo");
mkdirSync(out, { recursive: true });
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const display = process.env.DISPLAY ?? ":55";
const sleep = ms => new Promise(r => setTimeout(r, ms));
const xdo = (...args) => execFileSync("xdotool", args, { env: { ...process.env, DISPLAY: display } }).toString();
const shot = name => execFileSync("import", ["-window", "root", path.join(out, `${name}.png`)], { env: { ...process.env, DISPLAY: display } });

function pointer() {
  const m = /x:(\d+) y:(\d+)/.exec(xdo("getmouselocation"));
  return { x: Number(m[1]), y: Number(m[2]) };
}
async function glide(x, y, ms = 700) {
  const a = pointer();
  const steps = Math.max(8, Math.round(ms / 16));
  const bend = (Math.random() - 0.5) * 120;
  for (let i = 1; i <= steps; i++) {
    const t = i / steps, e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const nx = a.x + (x - a.x) * e + Math.sin(Math.PI * t) * bend * 0.3;
    const ny = a.y + (y - a.y) * e + Math.sin(Math.PI * t) * bend * 0.2;
    xdo("mousemove", String(Math.round(nx)), String(Math.round(ny)));
    await sleep(16);
  }
}
async function wander(points, ms) { for (const [x, y] of points) await glide(x, y, ms); }

const recorder = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-video_size", "1280x800", "-framerate", "30",
  "-i", display, "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", path.join(out, "m1-tour.mp4")],
  { stdio: ["pipe", "inherit", "inherit"] });

xdo("mousemove", "640", "700");
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)("electron"),
  args: [root, "--no-sandbox"],
  env: { ...process.env, DISPLAY: display, EMBER_TEST_HOOKS: "1", EMBER_USER_DATA: mkdtempSync(path.join(tmpdir(), "ember-tour-")) },
});
const hook = (fn, arg) => app.evaluate(fn, arg);

try {
  await sleep(2500);
  // Onboarding: pick a character with the real pointer.
  let home;
  for (let i = 0; i < 100 && !home; i++) {
    home = app.windows().find(w => w.url().includes("/home/"));
    if (!home) await sleep(150);
  }
  await home.waitForSelector(".card[data-id='glint']");
  const origin = await hook(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(b => b.webContents.getURL().includes("/home/"));
    return w.getContentBounds();
  });
  const at = async sel => { const b = await home.locator(sel).boundingBox(); return [origin.x + b.x + b.width / 2, origin.y + b.y + b.height / 2]; };
  for (const id of ["glassling", "wisp", "glint"]) {
    await glide(...(await at(`.card[data-id='${id}']`)), 600);
    xdo("click", "1");
    await sleep(900);
  }
  shot("01-picker");
  await glide(...(await at(".card[data-id='cinder']")), 600);
  xdo("click", "1");
  await sleep(900);
  await glide(...(await at("#start")), 600);
  xdo("click", "1");
  await sleep(1800);
  shot("02-greeting");

  // Ember follows the cursor around the editor.
  await wander([[420, 300], [700, 240], [560, 420], [260, 380], [820, 520]], 650);
  await sleep(600);

  // Preview of how agent states will look (driven by the Copilot conductor from M2).
  await hook((_e, s) => globalThis.__ember.setState(s), {
    emotion: "thinking", talking: false, status: null,
    bubble: { visible: true, mood: "thinking", title: "Thinking (preview)", thought: "Once I'm connected to Copilot in M2, my reasoning streams here while I work.", step: null, streaming: true, actions: [] },
  });
  await wander([[600, 330], [700, 380]], 700);
  await sleep(1200);
  shot("03-thinking");
  await hook((_e, s) => globalThis.__ember.setState(s), {
    emotion: "proud", talking: true,
    bubble: { visible: true, mood: "done", title: "Done (preview)", thought: "Tasks finish with a little celebration.", step: null, streaming: false, actions: [] },
  });
  await sleep(1800);
  await hook((_e, s) => globalThis.__ember.setState(s), {
    emotion: "neutral", talking: false, bubble: { visible: false, mood: "idle", title: "", thought: "", step: null, streaming: false, actions: [] },
  });

  // Swap characters live (settings drive the overlay and handle).
  for (const [character, size] of [["glassling", 70], ["wisp", 70], ["glint", 64], ["cinder", 60]]) {
    await hook((_e, p) => globalThis.__ember.settings.update(p), { character, size });
    await wander([[360 + Math.random() * 400, 220 + Math.random() * 280]], 900);
    await sleep(700);
    shot(`04-${character}`);
  }

  // The handle in the corner opens Ember's menu.
  await glide(1150, 765, 900);
  await sleep(500);
  xdo("click", "1");
  await sleep(1200);
  shot("05-handle-menu");
  xdo("key", "Escape");
  await sleep(800);
} finally {
  await app.close();
  recorder.stdin.write("q");
  await new Promise(r => recorder.on("exit", r));
}
console.log(`wrote ${out}`);
