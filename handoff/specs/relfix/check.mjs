import fs from "node:fs";
import { PACKAGES, WAVES } from "./packages.mjs";
const all = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const seen = new Map();
for (const [k, p] of Object.entries(PACKAGES)) for (const id of p.ids) { if (seen.has(id)) console.log("dup", id, seen.get(id), k); seen.set(id, k); }
const missing = all.filter(f => !seen.has(f.id)).map(f => f.id);
const waved = WAVES.flat(); const notWaved = Object.keys(PACKAGES).filter(k => !waved.includes(k));
console.log("assigned", seen.size, "of", all.length, "missing", missing, "not in a wave", notWaved, "unknown", [...seen.keys()].filter(i => !all.find(f => f.id === i)));
for (const [k, p] of Object.entries(PACKAGES)) {
  const fs_ = p.ids.map(i => all.find(f => f.id === i));
  fs.writeFileSync(`pkg-${k}.json`, JSON.stringify({ key: k, title: p.title, owns: p.owns, findings: fs_.map(f => ({ ...f, file: (f.file ?? "").replace(/^\/home\/user\/wt\/rv-\d+\//, "") })) }, null, 1));
  console.log(k.padEnd(11), String(p.ids.length).padStart(3), fs_.map(f => f.severity[0]).join(""));
}
