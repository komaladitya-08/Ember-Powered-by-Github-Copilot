// Records real voices for the wake-word evaluation (eval/src/gates.ts's "real voices" gates and
// scripts/voice/tune.mjs): each speaker reads prompts aloud, each kept as a 16 kHz mono WAV with what was read and
// whether it should wake Ember. Recordings stay on this computer, in the corpus folder; nothing is uploaded.
//   usage: node scripts/voice/record.mjs <speaker-id> [corpus dir] [--seconds 4] [--only positive|negative]
//   (default corpus: .cache/voice/corpus; one folder per speaker, a manifest.json in each)
// Records with the first of parecord (Linux, PulseAudio/PipeWire), arecord (ALSA), rec (SoX) or ffmpeg it finds.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const opt = n => { const i = args.indexOf(`--${n}`); return i < 0 ? undefined : args[i + 1]; };
const plain = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1].startsWith("--")));
const speaker = plain[0];
if (!speaker || !/^[A-Za-z0-9_-]{1,40}$/.test(speaker)) {
  console.error("usage: node scripts/voice/record.mjs <speaker-id> [corpus dir] [--seconds 4] [--only positive|negative]\n(speaker-id: letters, digits, - or _; no real names needed)");
  process.exit(2);
}
const corpus = path.resolve(plain[1] ?? path.join(root, ".cache/voice/corpus"));
const seconds = Number(opt("seconds") ?? 4);
const only = opt("only");

/** What each speaker reads: requests that should wake Ember, and near-misses and ordinary talk that shouldn't. */
export const PROMPTS = {
  positive: [
    "Ember, turn on night light.", "Ember, what time is it?", "Ember, open the terminal.", "Ember, make the text bigger.",
    "Ember, set a timer for ten minutes.", "Ember?", "Hey Ember, what's on my screen?", "Hey Ember, open my calendar.",
    "Hey Ember.", "OK Ember, turn on Do Not Disturb.", "Ember, stop.", "Hey Ember, stop.",
  ],
  negative: [
    "I remember the September weather was nice.", "The embers in the fireplace were still glowing.",
    "Hey, remember to call Amber.", "Can you hand me the member list?", "December is my favourite month.",
    "Number nine is on the left.", "Let's meet at the station after lunch.", "Amber, what time is it?",
    "Tell Ember's team about the release.", "I'd like a timber floor in the chamber.",
  ],
};

const recorders = [
  ["parecord", s => ["--rate=16000", "--channels=1", "--format=s16le", "--file-format=wav", s]],
  ["arecord", s => ["-q", "-f", "S16_LE", "-r", "16000", "-c", "1", s]],
  ["rec", s => ["-q", "-r", "16000", "-c", "1", "-b", "16", s]],
  ["ffmpeg", s => ["-loglevel", "error", "-y", "-f", process.platform === "darwin" ? "avfoundation" : process.platform === "win32" ? "dshow" : "pulse", "-i", process.platform === "darwin" ? ":0" : process.platform === "win32" ? "audio=default" : "default", "-ar", "16000", "-ac", "1", s]],
];
const found = recorders.find(([cmd]) => spawnSync(cmd, [cmd === "ffmpeg" ? "-version" : "--help"], { stdio: "ignore" }).error === undefined);
if (!found) {
  console.error("No recorder found: install pulseaudio-utils (parecord), alsa-utils (arecord), sox or ffmpeg.");
  process.exit(2);
}

const dir = path.join(corpus, speaker);
fs.mkdirSync(dir, { recursive: true });
const manifestFile = path.join(dir, "manifest.json");
const manifest = fs.existsSync(manifestFile) ? JSON.parse(fs.readFileSync(manifestFile, "utf8")) : { speaker, clips: [] };
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
console.log(`Recording ${speaker} with ${found[0]} into ${dir}. Recordings stay on this computer.`);
console.log(`For each line: press Enter, wait a moment, read it as you'd talk to Ember, then stay quiet until it stops (${seconds} s). Type s to skip, q to quit.\n`);

for (const label of ["positive", "negative"]) {
  if (only && only !== label) continue;
  for (const text of PROMPTS[label]) {
    const n = manifest.clips.filter(c => c.text === text).length;
    const file = `${label}-${String(manifest.clips.length + 1).padStart(3, "0")}.wav`;
    const answer = (await rl.question(`“${text}”${n ? ` (have ${n})` : ""}  [Enter] `)).trim().toLowerCase();
    if (answer === "q") break;
    if (answer === "s") continue;
    const out = path.join(dir, file);
    const p = spawn(found[0], found[1](out), { stdio: "ignore" });
    await new Promise(r => setTimeout(r, seconds * 1000));
    p.kill("SIGINT");
    await new Promise(r => p.once("exit", r));
    if (!fs.existsSync(out) || fs.statSync(out).size < 16000) { console.log("  nothing recorded; skipped"); continue; }
    manifest.clips.push({ file, text, label, wakes: label === "positive" && !/^(hey )?ember, stop\.$/i.test(text), stops: /stop\.$/i.test(text) });
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2) + "\n");
  }
}
rl.close();
console.log(`\n${manifest.clips.length} clips for ${speaker} in ${dir}.`);
