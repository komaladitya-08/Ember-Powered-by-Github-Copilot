/**
 * Tunes the bare name's keyword (sherpa.ts KEYWORDS) on real voices (scripts/voice/record.mjs's corpus): for each
 * boost and threshold, how many "Ember, …" requests wake Ember, how many "Hey Ember" ones still do, and how many
 * near-miss phrases wake it falsely, through the whole engine (spotter, transcript check, Voice Match aside).
 *   usage: node eval/tune.mjs [corpus dir] [--try ":2.0 #0.1,:2.0 #0.08,:2.5 #0.06"]
 */

import path from "node:path";
import { VoiceEngine, type VoiceEvent } from "../../app/voice/engine";
import { KEYWORDS, sherpaBackend } from "../../app/voice/sherpa";
import { modelPaths } from "../../app/voice/models";
import { corpusDir, loadCorpus } from "./corpus";

const args = process.argv.slice(2);
const at = (n: string) => { const i = args.indexOf(`--${n}`); return i < 0 ? undefined : args[i + 1]; };
const root = path.resolve(__dirname, "../..");
const voiceDir = path.resolve(process.env.EMBER_VOICE_DIR ?? path.join(root, ".cache/voice"));
const dir = args.find(a => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--try") ?? corpusDir(voiceDir);
if (!dir) { console.error("No corpus: record one with node scripts/voice/record.mjs <speaker-id>"); process.exit(2); }
const clips = loadCorpus(dir);
const tries = (at("try") ?? ":1.5 #0.2,:2.0 #0.15,:2.0 #0.1,:2.0 #0.08,:2.5 #0.06").split(",").map(s => s.trim());
const kept = (ev: VoiceEvent[]) => ev.filter(e => e.type === "wake").length > ev.filter(e => e.type === "rejected" && e.reason === "check").length;
console.log(`${clips.length} clips from ${new Set(clips.map(c => c.speaker)).size} speakers in ${dir}\n`);
console.log("bare keyword      Ember, … woke   Hey Ember woke   near-misses woke");
for (const t of tries) {
  const keywords = KEYWORDS.split("\n").map(l => (l.endsWith("@ember") ? `▁E M BER ${t} @ember` : l)).join("\n");
  const backend = sherpaBackend(modelPaths(path.join(voiceDir, "models")), { monitor: false, keywords });
  const play = (samples: Float32Array) => {
    const events: VoiceEvent[] = []; let now = 0;
    const engine = new VoiceEngine(backend, e => { if (e.type !== "speech") events.push(e); }, { now: () => now });
    const all = new Float32Array(samples.length + 32000); all.set(samples);
    for (let i = 0; i + 512 <= all.length; i += 512) { engine.feed(all.subarray(i, i + 512)); now += 32; }
    backend.resetVad();
    return events;
  };
  const count = (f: (c: (typeof clips)[number]) => boolean, ok: (ev: VoiceEvent[]) => boolean) => { const s = clips.filter(f); return `${s.filter(c => ok(play(c.samples))).length}/${s.length}`; };
  console.log(`${t.padEnd(16)}  ${count(c => c.wakes && c.bare, kept).padEnd(14)}  ${count(c => c.wakes && !c.bare, kept).padEnd(15)}  ${count(c => c.label === "negative", kept)}`);
  backend.free();
}
