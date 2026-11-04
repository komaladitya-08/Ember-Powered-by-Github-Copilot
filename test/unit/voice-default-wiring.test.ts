/** Preparation, packaging and verification must use the same default voice, regardless of optional model caches. */
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { DEFAULT_VOICE, VOICE_MODELS } from "../../app/voice/models";

const read = (file: string) => fs.readFileSync(path.resolve(file), "utf8");
describe("default Kitten preparation and release wiring", () => {
  it("stages the single pinned default Kitten model through the production manifest, keeping test voices outside it", () => {
    expect(VOICE_MODELS.filter(model => model.id === "tts")).toEqual([DEFAULT_VOICE]);
    expect(DEFAULT_VOICE).toMatchObject({ id: "tts", target: "kitten-nano-en-v0_8-fp32", license: "Apache-2.0" });
    expect(VOICE_MODELS.some(model => /piper|kokoro/i.test(`${model.target} ${model.url}`))).toBe(false);
    const stage = read("scripts/package/stage.mjs");
    expect(stage).toContain("for (const m of VOICE_MODELS)");
    expect(stage).toContain("fs.cpSync(path.join(models, m.target)");
    expect(stage).toContain('VOICE_MODELS.map(m => `${m.name}: ${m.target}');
    const prepare = read("scripts/voice/prepare.mjs");
    expect(prepare).toContain("await ensureModels(models, httpsDownloader");
    expect(prepare).toContain('target: "vits-piper-en_US-amy-low"');
    expect(prepare).toContain('target: "vits-piper-en_US-ryan-low"');
    expect(prepare).toContain("test-only; not shipped");
    expect(prepare).not.toMatch(/COMPACT_VOICE|--kitten/);
  });
  it.each(["prepare", "bench"])("rejects the obsolete optional Kitten flag in %s before any download or synthesis", name => {
    const result = spawnSync(process.execPath, [`scripts/voice/${name}.mjs`, "--kitten"], { encoding: "utf8", timeout: 10_000 });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown option --kitten");
  });
  it("benchmarks the native default independently of optional Kokoro and never asks for neural WASM speech", () => {
    const bench = read("scripts/voice/bench.mjs"), single = read("scripts/voice/bench-case.mjs");
    expect(bench).toContain('run({ kind: "kitten", build: "native", provider: "cpu", threads: 1 })');
    expect(bench).toContain('if (withKokoro && picked === "native"');
    expect(single).toContain("m.kittenSpec(paths.tts)");
    expect(`${bench}\n${single}`).not.toMatch(/piperSpec|COMPACT_VOICE|kind: "piper"/);
    expect(bench).not.toContain('kind: "kitten", build: "wasm"');
    const smoke = read("test/smoke/voice-backends.mjs");
    expect(smoke).not.toContain("paths.natural");
    expect(smoke).toContain('m.reason !== "native"');
    expect(smoke).toContain("defaultSpeechBackend(r, r.asked ===");
    const native = read("test/integration/voice.test.ts");
    expect(native).toContain('modelReady(path.join(dir, "models"), "tts")');
    expect(native).not.toMatch(/COMPACT_VOICE|"compact"/);
  });
});
