// Measures Better recall (docs/MEMORY.md §2) on this computer: fetches the pinned memory model (verified, into
// .cache/memory unless a folder is given), then runs the benchmark in test/fixtures/memory-bench.json (remembered facts,
// questions in other words, in their own words, and about nothing remembered) through recall with and without the
// model's matches, and times the model on one WebAssembly thread (load, each question, each fact, memory).
// --update-fixture writes the model's matches for every question to test/fixtures/memory-bench-semantic.json, which
// test/unit/memory.test.ts scores; run it after changing the benchmark, the model or documentText.
//   usage: node scripts/memory/bench.mjs [--update-fixture] [models dir]   (default: .cache/memory)
import { build } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const args = process.argv.slice(2);
const unknown = args.filter(a => a.startsWith("--") && a !== "--update-fixture");
if (unknown.length) { console.error(`unknown option ${unknown.join(", ")}\nusage: node scripts/memory/bench.mjs [--update-fixture] [models dir]`); process.exit(2); }
const update = args.includes("--update-fixture");
const models = path.resolve(args.find(a => !a.startsWith("--")) ?? path.join(root, ".cache/memory"));
const cache = path.join(root, ".cache/memory");
fs.mkdirSync(cache, { recursive: true });

// The app's own modules, bundled into the repository's .cache (so onnxruntime-web resolves from its node_modules).
const entry = path.join(cache, "bench-entry.ts");
fs.writeFileSync(entry, [
  `export { MemoryGraph } from ${JSON.stringify(path.join(root, "app/main/memory/graph.ts"))};`,
  `export { recall, SEMANTIC_FLOOR } from ${JSON.stringify(path.join(root, "app/main/memory/recall.ts"))};`,
  `export { documentText, VectorIndex, SEMANTIC_K } from ${JSON.stringify(path.join(root, "app/main/memory/embed.ts"))};`,
  `export { loadEmbedModel } from ${JSON.stringify(path.join(root, "app/main/memory/embed-model.ts"))};`,
  `export { ensureMemoryModel, httpsDownloader, MEMORY_MODEL, MEMORY_MODEL_BYTES } from ${JSON.stringify(path.join(root, "app/voice/models.ts"))};`,
].join("\n"));
const bundle = path.join(cache, "bench.cjs");
await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: "node", format: "cjs", external: ["onnxruntime-web"], logLevel: "error" });
const m = createRequire(import.meta.url)(bundle);

const files = await m.ensureMemoryModel(models, m.httpsDownloader);
const bench = JSON.parse(fs.readFileSync(path.join(root, "test/fixtures/memory-bench.json"), "utf8"));
// The facts keep their benchmark ids (f01…), so the fixture's matches name them.
let next = 0;
let entities = 0;
const clock = { now: () => new Date("2026-10-01T00:00:00Z"), id: p => (p === "f" ? bench.facts[next++].id : `e${String(entities++).padStart(3, "0")}`) };
const graph = new m.MemoryGraph(undefined, clock);
for (const f of bench.facts) graph.add({ text: f.text, about: f.about, source: "user", ...(f.predicate ? { predicate: f.predicate } : {}) });

const rss = () => process.memoryUsage().rss;
const before = rss();
let t = performance.now();
const model = await m.loadEmbedModel(files);
const loadMs = performance.now() - t;
await model.embed(["warm up"]);
const index = new m.VectorIndex(m.MEMORY_MODEL[0].sha256);
t = performance.now();
for (const f of graph.allFacts()) index.set(f.id, "", (await model.embed([m.documentText(graph, f)]))[0]);
const factMs = (performance.now() - t) / bench.facts.length;
const lat = [];
const sims = [];
for (const q of bench.questions) {
  const s = performance.now();
  const [v] = await model.embed([q.q]);
  lat.push(performance.now() - s);
  sims.push([...index.search(v, 12, 0.15)].map(([id, c]) => [id, Math.round(c * 10_000) / 10_000]));
}
const heldMB = Math.round((rss() - before) / 1e6);
lat.sort((a, b) => a - b);

// Brute-force search over 5,000 facts (MAX_FACTS), with random unit vectors.
const big = new m.VectorIndex("x".repeat(64));
const unit = () => { const v = Float32Array.from({ length: model.dim }, () => Math.random() - 0.5); const n = Math.hypot(...v); return v.map(x => x / n); };
for (let i = 0; i < 5000; i++) big.set(`f${i}`, "", unit());
const q = unit();
t = performance.now();
for (let i = 0; i < 20; i++) big.search(q);
const searchMs = (performance.now() - t) / 20;

const now = new Date("2026-10-02T00:00:00Z");
const score = semantic => {
  const out = {};
  bench.questions.forEach((qq, i) => {
    const sem = semantic ? new Map(sims[i].filter(([, c]) => c >= m.SEMANTIC_FLOOR).slice(0, m.SEMANTIC_K)) : undefined;
    const got = m.recall(graph, qq.q, { k: 6, now, ...(sem ? { semantic: sem } : {}) }).map(r => r.fact.id);
    const r = (out[qq.kind] ??= { n: 0, at1: 0, at5: 0, none: 0, returned: 0 });
    r.n++;
    if (qq.want.includes(got[0])) r.at1++;
    if (got.slice(0, 5).some(id => qq.want.includes(id))) r.at5++;
    if (!got.length) r.none++;
    r.returned += got.length;
  });
  return out;
};
const pct = (a, n) => `${Math.round((a / n) * 100)}%`;
console.log("| recall | paraphrase @1 | paraphrase @5 | keyword @1 | keyword @5 | nothing remembered: facts given |");
console.log("|---|---|---|---|---|---|");
for (const [name, s] of [["lexical (no model)", score(false)], ["with the model", score(true)]]) {
  console.log(`| ${name} | ${pct(s.paraphrase.at1, s.paraphrase.n)} | ${pct(s.paraphrase.at5, s.paraphrase.n)} | ${pct(s.keyword.at1, s.keyword.n)} | ${pct(s.keyword.at5, s.keyword.n)} | ${(s.none.returned / s.none.n).toFixed(1)} |`);
}
console.log(JSON.stringify({
  model: m.MEMORY_MODEL[0].name, bytes: m.MEMORY_MODEL_BYTES, loadMs: Math.round(loadMs), factMs: +factMs.toFixed(1),
  questionP50: +lat[lat.length >> 1].toFixed(1), questionP95: +lat[Math.floor(lat.length * 0.95)].toFixed(1), heldMB, search5000Ms: +searchMs.toFixed(2),
}));
if (update) {
  const out = path.join(root, "test/fixtures/memory-bench-semantic.json");
  fs.writeFileSync(out, JSON.stringify({
    about: "Better recall's matches for each question in memory-bench.json, in order (fact id, cosine; the best 12 of at least 0.15), made by scripts/memory/bench.mjs --update-fixture with the pinned model.",
    model: m.MEMORY_MODEL[0].sha256,
    matches: sims,
  }) + "\n");
  console.log(`wrote ${path.relative(root, out)}`);
}
await model.release();
