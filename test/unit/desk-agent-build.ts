/** Builds Ember's desk helper (as npm run build does) for tests that start a real desk. */

import { buildSync } from "esbuild";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));

/** The helper's script, built into .cache/test (beside the repo's node_modules, which it loads koffi and sharp from). */
export function deskAgentScript(): string {
  const out = path.join(root, ".cache", "test", "desk-agent.cjs");
  const tmp = `${out}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(out), { recursive: true });
  buildSync({
    entryPoints: [path.join(root, "app/main/desk/agent-process.ts")], bundle: true, platform: "node", format: "cjs", target: "node22",
    external: ["electron", "koffi", "sharp"], outfile: tmp, logLevel: "silent",
  });
  fs.renameSync(tmp, out);
  return out;
}
