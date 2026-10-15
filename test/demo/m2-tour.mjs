// Records M2: talking to Ember through the real Copilot runtime, with an
// offline scripted model standing in for Copilot's models.
// usage: scripts/demo/desktop.sh start && DISPLAY=:55 node test/demo/m2-tour.mjs <out-dir>
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

const lastUserText = messages => {
  const u = [...messages].reverse().find(m => m.role === "user");
  return typeof u?.content === "string" ? u.content : JSON.stringify(u?.content ?? "");
};
const mock = await startMockLlm({
  delayMs: 70,
  respond: messages => {
    const text = lastUserText(messages).toLowerCase();
    const lastAssistant = messages.map(m => m.role).lastIndexOf("assistant");
    const toolDone = messages.slice(lastAssistant + 1).some(m => m.role === "tool");
    if (text.includes("glint")) {
      if (!toolDone) return { reasoning: "They want me to change my look to Glint. I can do that with set_appearance.", tool: { name: "set_appearance", args: { character: "glint" } } };
      return { text: "Ta-da! I'm Glint now. Just ask if you want Cinder back." };
    }
    return {
      reasoning: "They're asking what I can do. I should keep it short and friendly, and be honest that app control is still coming.",
      text: "I can chat, answer questions and change how I look. Soon I'll work in your apps and show you where to click.",
    };
  },
});

const userData = mkdtempSync(path.join(tmpdir(), "ember-m2-"));
writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ version: 1, character: "cinder", size: 64, speak: false, wakeWord: true, onboarded: true, consent: { version: 1, at: "2026-10-15T00:00:00.000Z" } }));
const recorder = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-video_size", "1280x800", "-framerate", "30", "-i", display,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", path.join(out, "m2-tour.mp4")], { stdio: ["pipe", "inherit", "inherit"] });

xdo("mousemove", "520", "330");
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
  await sleep(4500);
  for (let i = 0; i < 40; i++) {
    const phase = await app.evaluate(() => globalThis.__ember.agent()?.getStatus().phase);
    if (phase === "ready") break;
    await sleep(250);
  }
  xdo("mousemove", "540", "340");
  await sleep(600);
  await typeAsk("Hi Ember, what can you do?");
  await sleep(1600);
  shot("01-thinking");
  await sleep(4200);
  shot("02-answer");
  await sleep(2500);
  xdo("mousemove", "620", "300");
  await sleep(600);
  await typeAsk("Can you turn into Glint?");
  await sleep(2200);
  shot("03-tool");
  await sleep(4500);
  shot("04-glint");
  await sleep(1500);
  // The Copilot section in settings.
  await app.evaluate(() => globalThis.__ember.showHome());
  await sleep(2500);
  const home = app.windows().find(w => w.url().includes("/renderer/home/"));
  await home?.evaluate(() => document.getElementById("copilot-h")?.scrollIntoView());
  await sleep(800);
  shot("05-settings-copilot");
} finally {
  await app.close();
  await mock.close();
  recorder.stdin.write("q");
  await new Promise(r => recorder.on("exit", r));
}
console.log(`wrote ${out}`);
