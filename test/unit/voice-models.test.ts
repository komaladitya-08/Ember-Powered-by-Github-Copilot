/** ensureModels with a fake downloader: verified pins, and nothing half-done left behind. */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VOICE_MODELS, ensureModels, type Downloader } from "../../app/voice/models";

let dir: string;
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const tmpRoot = () => (dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-models-")));

describe("ensureModels", () => {
  it("removes a partial download when the connection fails", async () => {
    const root = tmpRoot();
    const failing: Downloader = async (_url, dest) => { fs.writeFileSync(dest, "half a model"); throw new Error("connection reset"); };
    await expect(ensureModels(root, failing)).rejects.toThrow(/connection reset/);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("removes a download whose checksum doesn't match, and says so", async () => {
    const root = tmpRoot();
    const wrong: Downloader = async (_url, dest) => { fs.writeFileSync(dest, "not the model"); };
    await expect(ensureModels(root, wrong)).rejects.toThrow(/checksum mismatch/);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("fetches a model again when its marker was written for another pin", async () => {
    const root = tmpRoot();
    const vad = VOICE_MODELS.find(m => m.id === "vad")!;
    const real = vad.sha256;
    const content = Buffer.from("silero");
    vad.sha256 = crypto.createHash("sha256").update(content).digest("hex"); // the new pin
    try {
      // Every model in place and verified, except the VAD, whose marker names an older pin.
      for (const m of VOICE_MODELS) {
        if (m.kind === "file") fs.writeFileSync(path.join(root, m.target), "old"); else fs.mkdirSync(path.join(root, m.target));
        fs.writeFileSync(path.join(root, `.${m.target}.ok`), `${m === vad ? real : m.sha256}\n`);
      }
      const asked: string[] = [];
      await ensureModels(root, async (url, dest) => { asked.push(path.basename(url)); fs.writeFileSync(dest, content); });
      expect(asked).toEqual(["silero_vad.onnx"]);
      expect(fs.readFileSync(path.join(root, vad.target), "utf8")).toBe("silero");
      expect(fs.readFileSync(path.join(root, `.${vad.target}.ok`), "utf8").trim()).toBe(vad.sha256);
    } finally {
      vad.sha256 = real;
    }
  });
});
