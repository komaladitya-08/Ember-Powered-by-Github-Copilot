// Records M5: talking to Ember. A WAV file stands in for the microphone
// (Chromium's fake audio capture), so everything else is real: the mic
// window, the voice process, wake word, VAD, transcription, the conductor
// (offline scripted model), tasks, and the follow-up window where no wake
// word is needed. The audio is muxed into the video for review.
// Needs: node scripts/voice/prepare.mjs
// usage: DISPLAY=:55 scripts/demo/as-demo-user.sh env PATH="$PATH" node test/demo/m5-tour.mjs <out-dir>
import { _electron as electron } from "playwright-core";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, symlinkSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { startMockLlm } from "../mock-llm/server.mjs";

const require = createRequire(import.meta.url);
const sherpa = require("sherpa-onnx");
const out = path.resolve(process.argv[2] ?? "dist/demo");
mkdirSync(out, { recursive: true });
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const voiceDir = path.resolve(process.env.EMBER_VOICE_DIR ?? path.join(root, ".cache/voice"));
const display = process.env.DISPLAY ?? ":55";
const env = { ...process.env, DISPLAY: display };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const shot = name => execFileSync("import", ["-window", "root", path.join(out, `${name}.png`)], { env });
const gs = (...a) => execFileSync("gsettings", a, { env }).toString().trim();

// The "microphone": what the user says, with pauses.
const clip = name => sherpa.readWave(path.join(root, "test/fixtures/voice", `${name}.wav`)).samples;
const silence = s => new Float32Array(Math.round(16000 * s));
const timeline = [silence(4), clip("dnd"), silence(4.5), clip("bigger"), silence(30)];
const mic = new Float32Array(timeline.reduce((n, p) => n + p.length, 0));
let at = 0;
for (const p of timeline) { mic.set(p, at); at += p.length; }
const micWav = path.join(out, "microphone.wav");
sherpa.writeWave(micWav, { samples: mic, sampleRate: 16000 });

const text = m => (typeof m.content === "string" ? m.content : JSON.stringify(m.content));
const mock = await startMockLlm({
  delayMs: 45,
  respond: (messages, tools) => {
    const lastUser = [...messages].reverse().find(m => m.role === "user");
    const ask = text(lastUser).toLowerCase();
    const after = messages.slice(messages.lastIndexOf(lastUser) + 1);
    if (tools.includes("start_task")) {
      const bigger = ask.includes("bigger");
      if (after.some(m => m.role === "tool")) return { text: bigger ? "Making the text a bit bigger." : "Sure, turning on Do Not Disturb." };
      return { reasoning: bigger ? "They want larger text; that's a setting." : "They asked by voice to silence notifications.", tool: { name: "start_task", args: { goal: bigger ? "Make the text a bit bigger" : "Turn on Do Not Disturb" } } };
    }
    const goal = text(messages.find(m => m.role === "user")).toLowerCase();
    const step = messages.filter(m => m.role === "tool").length;
    if (goal.includes("bigger")) {
      if (step === 0) return { reasoning: "Text size is a scale factor; 1.25 is a bit bigger.", tool: { name: "change_setting", args: { setting: "text_size", value: "1.25" } } };
      if (step === 1) return { tool: { name: "finish_task", args: { success: true, summary: "Text is 25% bigger now." } } };
    } else {
      if (step === 0) return { reasoning: "There's a direct setting for Do Not Disturb.", tool: { name: "change_setting", args: { setting: "do_not_disturb", value: "on" } } };
      if (step === 1) return { tool: { name: "finish_task", args: { success: true, summary: "Do Not Disturb is on." } } };
    }
    return { text: "Done." };
  },
});

const userData = mkdtempSync(path.join(tmpdir(), "ember-m5-"));
mkdirSync(path.join(userData, "models"), { recursive: true });
for (const f of readdirSync(path.join(voiceDir, "models"), { withFileTypes: true })) {
  if (!f.name.startsWith(".download")) symlinkSync(path.join(voiceDir, "models", f.name), path.join(userData, "models", f.name));
}
writeFileSync(path.join(userData, "settings.json"), JSON.stringify({ version: 1, character: "wisp", size: 64, speak: false, wakeWord: true, onboarded: true, consent: { version: 1, at: "2026-10-15T00:00:00.000Z" }, voice: { consent: true, speakerRejection: true } }));
gs("set", "org.gnome.desktop.notifications", "show-banners", "true");
gs("set", "org.gnome.desktop.interface", "text-scaling-factor", "1.0");

const recorder = spawn("ffmpeg", ["-loglevel", "error", "-y", "-f", "x11grab", "-video_size", "1280x800", "-framerate", "30", "-i", display,
  "-c:v", "libx264", "-preset", "veryfast", "-crf", "24", "-pix_fmt", "yuv420p", path.join(out, "m5-silent.mp4")], { stdio: ["pipe", "inherit", "inherit"] });
const recStart = Date.now();
execFileSync("xdotool", ["mousemove", "760", "330"], { env });
const app = await electron.launch({
  executablePath: require("electron"),
  args: [root, "--no-sandbox", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${micWav}`],
  env: { ...env, EMBER_TEST_HOOKS: "1", EMBER_USER_DATA: userData, EMBER_TEST_PROVIDER_URL: mock.baseUrl },
});
const shots = [["01-listening", "Listening"], ["02-heard", "turn on do not disturb"], ["03-followup", "follow-up"], ["04-bigger", "Text is 25%"]];
try {
  const state = () => app.evaluate(() => {
    const s = globalThis.__ember.overlay()?.getState();
    return s ? `${s.bubble.title} ${s.bubble.thought} ${s.status ?? ""} ${s.tasks.map(t => t.detail).join(" ")}` : "";
  });
  const t0 = Date.now();
  for (const [name, needle] of shots) {
    for (; Date.now() - t0 < 40_000;) {
      if ((await state()).toLowerCase().includes(needle.toLowerCase())) break;
      await sleep(60);
    }
    shot(name);
  }
  await sleep(3000);
} finally {
  await app.close();
  await mock.close();
  recorder.stdin.write("q");
  await new Promise(r => recorder.on("exit", r));
}
// When did the microphone start, relative to the video?
const log = readFileSync(path.join(userData, "logs", "ember.log"), "utf8").split("\n").filter(Boolean).map(l => JSON.parse(l));
const micAt = log.find(l => l.msg === "voice.mic");
const offset = micAt ? (Date.parse(micAt.t) - recStart) / 1000 : 0;
execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", path.join(out, "m5-silent.mp4"), "-itsoffset", String(Math.max(0, offset)), "-i", micWav,
  "-map", "0:v", "-map", "1:a", "-c:v", "copy", "-c:a", "aac", "-shortest", path.join(out, "m5-tour.mp4")]);
for (const l of log.filter(l => /^voice\.|task\.finished|conductor\.ask/.test(l.msg))) console.log(l.t.slice(11, 23), l.msg, JSON.stringify({ ...l, t: undefined, level: undefined, msg: undefined, scope: undefined }));
console.log(`do-not-disturb banners: ${gs("get", "org.gnome.desktop.notifications", "show-banners")}, text scale: ${gs("get", "org.gnome.desktop.interface", "text-scaling-factor")}`);
gs("set", "org.gnome.desktop.notifications", "show-banners", "true");
gs("set", "org.gnome.desktop.interface", "text-scaling-factor", "1.0");
console.log(`wrote ${out}`);
