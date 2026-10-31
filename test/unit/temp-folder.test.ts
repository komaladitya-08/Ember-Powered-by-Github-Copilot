/**
 * The global setup that gives each test run a temporary folder of its own, and removes it and vitest's module cache
 * when the run ends.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import setup from "../temp-folder";

describe("temp-folder", () => {
  it("runs every test in a temporary folder of its own, not the system's", () => {
    expect(path.basename(os.tmpdir())).toMatch(/^ember-run-/);
  });

  it("removes the run's folder and vitest's module cache, and puts the environment back", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-tmpclean-"));
    const before = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    try {
      process.env.TMPDIR = root;
      process.env.TEMP = root;
      process.env.TMP = root;
      const cache = path.join(root, "AbCdEfGhIjKlMnOpQrStU");
      fs.mkdirSync(path.join(cache, "ssr"), { recursive: true });
      fs.writeFileSync(path.join(cache, "ssr", "x.js"), "export {};\n");

      const teardown = setup({ vitest: { _tmpDir: cache } });
      expect(path.dirname(os.tmpdir())).toBe(root);
      expect(path.basename(os.tmpdir())).toMatch(/^ember-run-/);
      const run = os.tmpdir();
      fs.writeFileSync(path.join(run, "a.txt"), "x\n");

      teardown();
      expect(fs.existsSync(run)).toBe(false);
      expect(fs.existsSync(cache)).toBe(false);
      expect(process.env.TMPDIR).toBe(root);
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("never removes a cache folder that isn't directly in the temp folder", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-tmpclean-"));
    const before = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
    try {
      process.env.TMPDIR = root;
      process.env.TEMP = root;
      process.env.TMP = root;
      const cache = path.join(root, "keep", "deeper");
      fs.mkdirSync(cache, { recursive: true });
      fs.writeFileSync(path.join(cache, "x.js"), "export {};\n");

      const teardown = setup({ vitest: { _tmpDir: cache } });
      teardown();
      expect(fs.existsSync(cache)).toBe(true);
    } finally {
      for (const [name, value] of Object.entries(before)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
