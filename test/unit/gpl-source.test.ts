/**
 * The source each release carries for the GPL part of Ember's voice (scripts/package/gpl-source.mjs): it stays the source
 * the licence notices name and the sherpa-onnx Ember ships, it is part of every release, and a wrong archive is refused.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GPL_SOURCES, keepVerified } from "../../scripts/package/gpl-source.mjs";
import { releaseFiles, releaseProblems } from "../../scripts/package/release.mjs";

const read = (f: string) => fs.readFileSync(path.resolve(f), "utf8");

describe("the GPL source of a release", () => {
  it("is what the licence notices name, with their checksums", () => {
    for (const notice of ["packaging/licences/sherpa-onnx.txt", "packaging/licences/sherpa-onnx-native.txt"]) {
      const text = read(notice);
      for (const s of GPL_SOURCES.filter(x => !x.file.includes("sherpa"))) {
        expect(text, s.file).toContain(s.url);
        expect(text, s.file).toContain(s.sha256);
      }
      expect(text).toContain("source-*.zip");
    }
  });
  it("follows the sherpa-onnx in package.json, so a bump can't leave it behind", () => {
    const version = (JSON.parse(read("package.json")) as { dependencies: Record<string, string> }).dependencies["sherpa-onnx"];
    expect(GPL_SOURCES.map(s => s.file)).toContain(`source-sherpa-onnx-${version}.zip`);
  });
  it("is part of every release, and a release without it is refused", () => {
    const files = releaseFiles("1.2.3");
    for (const s of GPL_SOURCES) expect(files).toContain(s.file);
    expect(releaseProblems(files.filter(f => f !== GPL_SOURCES[1].file), "1.2.3")).toEqual([`missing ${GPL_SOURCES[1].file}`]);
  });
  it("is fetched by the release job before the files are counted and checksummed", () => {
    const ci = read(".github/workflows/ci.yml");
    const fetched = ci.indexOf("node scripts/package/gpl-source.mjs dist/release");
    expect(fetched).toBeGreaterThan(0);
    expect(fetched).toBeLessThan(ci.indexOf("node scripts/package/release.mjs dist/release"));
    expect(ci).toMatch(/sha256sum [^\n]*source-\*\.zip[^\n]* > SHA256SUMS/);
  });
  it("keeps an archive only when its SHA-256 matches", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-gpl-source-"));
    try {
      const bytes = new TextEncoder().encode("source");
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      expect(() => keepVerified(dir, { file: "bad.zip", sha256: "0".repeat(64) }, bytes)).toThrow(/expected/);
      expect(fs.existsSync(path.join(dir, "bad.zip"))).toBe(false);
      keepVerified(dir, { file: "good.zip", sha256 }, bytes);
      expect(fs.readFileSync(path.join(dir, "good.zip"), "utf8")).toBe("source");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
