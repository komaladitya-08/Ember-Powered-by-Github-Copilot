/**
 * vitest's global setup: gives each run a temporary folder of its own and removes it when the run ends, along with
 * vitest's own module cache. About a hundred tests make `ember-*` folders in the system temp folder and leave them
 * there; vitest makes one more, named by a random id, holding its `ssr` module cache. Pointing TMPDIR, TEMP and TMP
 * at one folder for the run means the tests, and every helper they start, put their folders inside it, and the
 * teardown clears the lot.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export default function setup(project?: { vitest?: { _tmpDir?: unknown } }): () => void {
  const before = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  const base = os.tmpdir();
  const dir = fs.mkdtempSync(path.join(base, "ember-run-"));
  process.env.TMPDIR = dir;
  process.env.TEMP = dir;
  process.env.TMP = dir;

  return () => {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Best effort: a helper that still holds a file open on Windows must not fail the run.
    }
    // _tmpDir is vitest's internal, so only remove it as a direct child of the temp folder: safe if it is renamed.
    const cache = project?.vitest?._tmpDir;
    if (typeof cache === "string" && path.dirname(cache) === base) {
      try {
        fs.rmSync(cache, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // Best effort.
      }
    }
  };
}
