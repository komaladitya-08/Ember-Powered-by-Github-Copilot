// Records M3: Ember reads the screen. A GTK3 window is open; the user asks
// "what's on my screen?", the (offline, scripted) model calls describe_screen,
// and answers from what the accessibility tree really says. Also saves the
// set-of-marks screenshot workers will get in M4.
// usage (demo desktop, as the desktop's user so the accessibility bus is reachable):
//   scripts/demo/desktop.sh start
//   DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m3-tour.mjs <out-dir>
import { _electron as electron } from "playwright-core";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { startMockLlm } from "../mock-llm/server.mjs";

const out = path.resolve(process.argv[2] ?? "dist/demo");
mkdirSync(out, { recursive: true });
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
const display = process.env.DISPLAY ?? ":55";
const env = { ...process.env, DISPLAY: display };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const xdo = (...a) => execFileSync("xdotool", a, { env }).toString();
const shot = name => execFileSync("import", ["-window", "root", path.join(out, `${name}.png`)], { env });
const python = process.env.EMBER_PYTHON ?? "/usr/libexec/platform-python";

const lastUserText = messages => {
  const u = [...messages].reverse().find(m => m.role === "user");
  return typeof u?.content === "string" ? u.content : JSON.stringify(u?.content ?? "");
};
// Builds a short answer from the real describe_screen result.
const summarize = screen => {
  const where = /window "([^"]+)"/.exec(screen)?.[1] ?? "a window";
  const focus = /Focused element: \[\d+\] [a-z ]+ "([^"]*)"/.exec(screen)?.[1];
  const night = /"Night Light" \(label\) \(([^)]*)\)/.exec(screen)?.[1] ?? "";
  const buttons = [...screen.matchAll(/push button "([^"]+)"/g)].map(m => m[1]);
  const named = /text "Name" [^\n]*text="([^"]*)"/.exec(screen)?.[1];
  return [
    `You're in "${where}".`,
    focus ? `Your cursor is in the ${focus} box${named ? `, which says "${named}"` : ""}.` : "",
    `Night Light is ${night.includes("checked") ? "on" : "off"}, and there's a ${buttons[0] ?? "Save"} button at the top.`,
  ].filter(Boolean).join(" ");
};
const mock = await startMockLlm({
  delayMs: 60,
  respond: messages => {
    const text = lastUserText(messages).toLowerCase();
    const lastAssistant = messages.map(m => m.role).lastIndexOf("assistant");
    const tool = messages.slice(lastAssistant + 1).find(m => m.role === "tool");
    if (text.includes("screen")) {
      if (!tool) return { reasoning: "They want to know what's on screen. I'll read it with describe_screen rather than guess.", tool: { name: "describe_screen", args: {} } };
      return { reasoning: "The screen text says which window is focused and lists its controls. I'll pick out the useful bits.", text: summarize(String(tool.content)) };
    }
    return { text: "Hi!" };
  },
});

const bench = spawn(python, [path.join(root, "test/fixtures/gtk3_bench.py")], { env, stdio: "ignore" });
const userData = mkdtempSync(path.join(tmpdir(), "ember-m3-"));
writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ version: 1, character: "wisp", size: 64, speak: false, wakeWord: true, onboarded: true }));
await sleep(2500);
xdo("search", "--sync", "--name", "Ember Test Bench", "windowactivate", "--sync");

const recorder = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-video_size", "1280x800", "-framerate", "30", "-i", display,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", path.join(out, "m3-tour.mp4")], { stdio: ["pipe", "inherit", "inherit"] });

xdo("mousemove", "700", "330");
const app = await electron.launch({
  executablePath: createRequire(import.meta.url)("electron"),
  args: [root, "--no-sandbox"],
  env: { ...env, EMBER_TEST_HOOKS: "1", EMBER_USER_DATA: userData, EMBER_TEST_PROVIDER_URL: mock.baseUrl },
});
const typeAsk = async text => {
  xdo("key", "ctrl+alt+space");
  await sleep(900);
  xdo("type", "--delay", "45", text);
  await sleep(300);
  xdo("key", "Return");
};
try {
  await sleep(4000);
  for (let i = 0; i < 40; i++) {
    const phase = await app.evaluate(() => globalThis.__ember.agent()?.getStatus().phase);
    if (phase === "ready") break;
    await sleep(250);
  }
  // Use the bench like a person would: switch on Night Light, type a name.
  const seen = await app.evaluate(async () => {
    const s = await globalThis.__ember.perception().focused();
    return s.nodes.map(n => ({ role: n.role, name: n.name, bounds: n.bounds }));
  });
  const find = (role, name) => seen.find(n => n.role === role && (!name || n.name === name))?.bounds;
  const center = b => [String(Math.round(b.x + b.width / 2)), String(Math.round(b.y + b.height / 2))];
  const sw = seen.find(n => n.role === "toggle button" || n.role === "switch")?.bounds;
  if (sw) { xdo("mousemove", ...center(sw)); await sleep(500); xdo("click", "1"); await sleep(700); }
  const name = find("text", "Name");
  if (name) { xdo("mousemove", ...center(name)); await sleep(500); xdo("click", "1"); await sleep(300); xdo("type", "--delay", "70", "Ada Lovelace"); }
  await sleep(800);
  xdo("mousemove", "760", "300");
  await sleep(700);
  await typeAsk("What's on my screen?");
  await sleep(1800);
  shot("01-reading");
  await sleep(5000);
  shot("02-answer");
  await sleep(2000);

  // What a worker will see in M4: the window with numbered marks, Ember hidden.
  const marked = await app.evaluate(async () => {
    const p = await globalThis.__ember.perception().perceive({ image: true, scope: "window" });
    return { text: p.text, ms: p.ms, image: p.capture ? p.capture.data.toString("base64") : null };
  });
  if (marked.image) writeFileSync(path.join(out, "03-set-of-marks.jpg"), Buffer.from(marked.image, "base64"));
  writeFileSync(path.join(out, "03-elements.txt"), marked.text + "\n");
  // A whole-screen capture: Ember steps out of the picture while it is taken.
  shot("03b-before-capture");
  const whole = await app.evaluate(async () => {
    const p = await globalThis.__ember.perception().perceive({ image: true, scope: "screen" });
    return p.capture ? p.capture.data.toString("base64") : null;
  });
  if (whole) writeFileSync(path.join(out, "03c-screen-capture.jpg"), Buffer.from(whole, "base64"));
  console.log(`read the window in ${marked.ms} ms`);

  await app.evaluate(() => globalThis.__ember.showHome());
  await sleep(2500);
  const home = app.windows().find(w => w.url().includes("/renderer/home/"));
  await sleep(1000);
  await home?.evaluate(() => document.getElementById("checks")?.scrollIntoView({ block: "center" })).catch(() => {});
  // Fallback: wheel down over the settings window.
  xdo("mousemove", "640", "450");
  for (let i = 0; i < 25; i++) { xdo("click", "5"); await sleep(40); }
  xdo("mousemove", "1180", "200");
  await sleep(1500);
  shot("04-setup-check");
  // One click turns accessibility on (gsettings), and the check goes green.
  const geo = await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows().find(b => b.webContents.getURL().includes("/renderer/home/"));
    const b = w?.getContentBounds();
    return { X: b?.x ?? 0, Y: b?.y ?? 0 };
  });
  const btn = await home?.evaluate(() => {
    const r = document.querySelector(".check-fix")?.getBoundingClientRect();
    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  }).catch(err => { console.log("evaluate failed:", err.message); return null; });
  if (btn) {
    xdo("mousemove", String(Math.round(Number(geo.X) + btn.x)), String(Math.round(Number(geo.Y) + btn.y)));
    await sleep(500);
    xdo("click", "1");
  } else console.log("no fix button found");
  await sleep(1500);
  shot("05-setup-fixed");
} finally {
  await app.close();
  await mock.close();
  bench.kill();
  recorder.stdin.write("q");
  await new Promise(r => recorder.on("exit", r));
}
console.log(`wrote ${out}`);
