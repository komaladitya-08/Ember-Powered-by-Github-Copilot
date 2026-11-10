/** The default preparation must supply a complete fixture speaker, so acoustic regressions cannot pass unexercised. */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const dir = path.resolve(process.env.EMBER_VOICE_DIR ?? ".cache/voice");
const required = process.env.EMBER_VOICE_TEST === "1";
const voices = ["amy", "ryan"];
const prepared = voices.filter(name => fs.existsSync(path.join(dir, `vits-piper-en_US-${name}-low`)));

describe.skipIf(!required && !prepared.length)("prepared speech-test voices", () => {
  it("provides a complete fixture speaker for the acoustic regressions (voice-ci-r7-1)", () => {
    expect(prepared.length, "Run node scripts/voice/prepare.mjs before the voice tests.").toBeGreaterThan(0);
    for (const name of prepared) {
      const target = `vits-piper-en_US-${name}-low`;
      expect(fs.statSync(path.join(dir, target, `en_US-${name}-low.onnx`)).size).toBeGreaterThan(0);
      expect(fs.statSync(path.join(dir, target, "tokens.txt")).size).toBeGreaterThan(0);
      expect(fs.statSync(path.join(dir, target, "espeak-ng-data")).isDirectory()).toBe(true);
    }
  });
});
