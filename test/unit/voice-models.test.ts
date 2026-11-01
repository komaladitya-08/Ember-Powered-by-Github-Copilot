/**
 * ensureModels with a fake downloader: verified pins, archives unpacked in-process into the model's own folder,
 * and nothing half-done left behind; and the scripts' https downloader against a local TLS server.
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { LISTENING_MODELS, VOICE_MODELS, VOICE_MODELS_BYTES, createHttpsDownloader, ensureModels, forgetModels, missingModels, modelReady, modelsBytes, modelsReady, type Downloader, type ModelId } from "../../app/voice/models";
import { modelsDownloadLabel } from "../../app/renderer/home/copy";
import { matchNoModelText } from "../../app/renderer/home/match-copy";
import { bzip2Compress, randomBytes, tarArchive, tarEntry } from "../fixtures/voice-archive/make";

// app/main/voice.ts (for downloadHelp, the words the user sees) imports Electron, which isn't loaded here.
vi.mock("electron", () => ({ app: {}, BrowserWindow: class {}, MessageChannelMain: class {}, ipcMain: {}, net: {}, session: {}, utilityProcess: {} }));

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const tmpRoot = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "ember-models-"));
  dirs.push(d);
  return d;
};

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

/** A models folder with `ids` in place and verified (default: all of them). */
function withModels(root: string, ids: readonly ModelId[] = VOICE_MODELS.map(m => m.id)): string {
  for (const m of VOICE_MODELS) {
    if (!ids.includes(m.id)) continue;
    if (m.kind === "file") fs.writeFileSync(path.join(root, m.target), "in place"); else fs.mkdirSync(path.join(root, m.target));
    fs.writeFileSync(path.join(root, `.${m.target}.ok`), `${m.sha256}\n`);
  }
  return root;
}
const byId = (id: ModelId) => VOICE_MODELS.find(m => m.id === id)!;

describe("which models are needed", () => {
  it("listening needs only the wake word, voice activity and speech recognition", () => {
    expect(LISTENING_MODELS).toEqual(["kws", "vad", "asr"]);
    expect(modelsReady(withModels(tmpRoot(), ["kws", "vad", "asr"]))).toBe(true);
    for (const gone of LISTENING_MODELS) expect(modelsReady(withModels(tmpRoot(), LISTENING_MODELS.filter(id => id !== gone)))).toBe(false);
  });

  it("is ready to listen without Ember's voice, without Voice Match, and without both", () => {
    for (const ids of [["kws", "vad", "asr", "speaker"], ["kws", "vad", "asr", "tts"], ["kws", "vad", "asr"]] as ModelId[][]) {
      const root = withModels(tmpRoot(), ids);
      expect(modelsReady(root)).toBe(true);
      expect(missingModels([root]).map(m => m.id)).toEqual(VOICE_MODELS.map(m => m.id).filter(id => !ids.includes(id)));
    }
  });

  it("finds each model in any of the folders Ember looks in (a bundled folder without the optional ones, then the user's)", () => {
    const bundled = withModels(tmpRoot(), ["kws", "vad", "asr"]);
    const own = withModels(tmpRoot(), ["tts"]);
    expect(missingModels([bundled, own]).map(m => m.id)).toEqual(["speaker"]);
    expect(missingModels([bundled, own], ["tts"])).toEqual([]);
    expect(modelsBytes(missingModels([bundled]))).toBe(byId("tts").bytes + byId("speaker").bytes);
    expect(modelsBytes()).toBe(VOICE_MODELS_BYTES);
  });

  it("forgets only the damaged model (review #254)", () => {
    const root = withModels(tmpRoot());
    expect(forgetModels(root, ["tts"])).toBe(true);
    expect(modelReady(root, "tts")).toBe(false);
    expect(VOICE_MODELS.filter(m => modelReady(root, m.id)).map(m => m.id)).toEqual(["kws", "vad", "asr", "speaker"]);
    expect(modelsReady(root)).toBe(true); // still listens
    expect(forgetModels(root, ["asr"])).toBe(true);
    expect(modelsReady(root)).toBe(false);
    expect(modelReady(root, "speaker")).toBe(true);
    expect(forgetModels(root)).toBe(true); // all of them, by default
    expect(missingModels([root])).toHaveLength(VOICE_MODELS.length);
  });
});

describe("ensureModels for some of them", () => {
  it("fetches only the models asked for that aren't in place, and counts progress of those alone", async () => {
    const root = withModels(tmpRoot(), ["kws", "vad", "asr", "tts"]);
    const speaker = byId("speaker");
    const real = speaker.sha256;
    const content = Buffer.from("resnet");
    speaker.sha256 = crypto.createHash("sha256").update(content).digest("hex");
    try {
      fs.writeFileSync(path.join(root, `.${speaker.target}.ok`), "stale\n"); // a damaged one, forgotten
      const asked: string[] = [];
      const seen: [number, number][] = [];
      await ensureModels(root, async (url, dest, progress) => { asked.push(path.basename(url)); fs.writeFileSync(dest, content); progress(content.length); },
        (done, total) => seen.push([done, total]), ["tts", "speaker"]);
      expect(asked).toEqual([speaker.target]);
      expect(seen.at(-1)).toEqual([speaker.bytes, speaker.bytes]);
      expect(missingModels([root])).toEqual([]);
    } finally {
      speaker.sha256 = real;
    }
  });
});

describe("the download button and Voice Match's note", () => {
  it("says what's missing and its size", () => {
    const all = VOICE_MODELS.map(m => m.id);
    expect(modelsDownloadLabel(all, VOICE_MODELS_BYTES)).toBe("Download speech models (142 MB)");
    expect(modelsDownloadLabel(["asr", "tts"], byId("asr").bytes + byId("tts").bytes)).toBe("Download speech models (97 MB)");
    expect(modelsDownloadLabel(["tts"], byId("tts").bytes)).toBe("Download Ember's voice (67 MB)");
    expect(modelsDownloadLabel(["speaker"], byId("speaker").bytes)).toBe("Download Voice Match (27 MB)");
    expect(modelsDownloadLabel(["tts", "speaker"], byId("tts").bytes + byId("speaker").bytes)).toBe("Download Ember's voice and Voice Match (94 MB)");
  });

  it("explains Voice Match without its model: off for now with a voiceprint kept, or not yet teachable", () => {
    expect(matchNoModelText(true, byId("speaker").bytes)).toMatch(/^Off for now: .*Ember answers anyone.*Download it above \(27 MB\)/);
    expect(matchNoModelText(false, null)).toBe("Voice Match needs its own model, which isn't on this computer. Download it above, then teach Ember your voice.");
  });
});

describe("ensureModels with an archive", () => {
  // The wake-word model's entry, pointed at a small archive built here (restored after each test).
  const kws = VOICE_MODELS.find(m => m.id === "kws")!;
  const saved = { ...kws };
  afterEach(() => Object.assign(kws, saved));

  const sha256 = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");
  /** Every other model in place and verified, so only the archive is fetched. */
  const othersInPlace = (root: string) => {
    for (const m of VOICE_MODELS) {
      if (m === kws) continue;
      if (m.kind === "file") fs.writeFileSync(path.join(root, m.target), "in place"); else fs.mkdirSync(path.join(root, m.target));
      fs.writeFileSync(path.join(root, `.${m.target}.ok`), `${m.sha256}\n`);
    }
  };
  /** Pins the wake-word entry to `packed` and returns a downloader that serves it. */
  const serve = (packed: Uint8Array): Downloader => {
    kws.target = "fake-kws";
    kws.sha256 = sha256(packed);
    return async (_url, dest, progress) => { fs.writeFileSync(dest, packed); progress(packed.length); };
  };
  const model = randomBytes(1, 40_000);
  const goodTar = tarArchive([tarEntry({ name: "fake-kws/", type: "5" }), tarEntry({ name: "fake-kws/model.onnx", data: model }), tarEntry({ name: "fake-kws/tokens.txt", data: "a 1\nb 2\n" })]);
  /** What's in root besides the models and their markers (should be nothing: no download, no staging folder). */
  const leftovers = (root: string) => fs.readdirSync(root).filter(f => !VOICE_MODELS.some(m => f === m.target || f === `.${m.target}.ok`));

  it("unpacks a verified archive into the model's folder, marks it, and leaves nothing else", async () => {
    const root = tmpRoot();
    othersInPlace(root);
    const seen: number[] = [];
    await ensureModels(root, serve(bzip2Compress(goodTar, { blockBytes: 10_000 })), done => seen.push(done));
    expect(Buffer.compare(fs.readFileSync(path.join(root, "fake-kws/model.onnx")), Buffer.from(model))).toBe(0);
    expect(fs.readFileSync(path.join(root, "fake-kws/tokens.txt"), "utf8")).toBe("a 1\nb 2\n");
    expect(fs.readFileSync(path.join(root, ".fake-kws.ok"), "utf8").trim()).toBe(kws.sha256);
    expect(leftovers(root)).toEqual([]);
    expect(modelsReady(root)).toBe(true);
    expect(seen.at(-1)).toBe(kws.bytes); // progress is of what was fetched: the others were in place
  });

  it("keeps the last part of an archive's share for checking and unpacking it, saying so, instead of sitting at 100% (review #259)", async () => {
    const root = tmpRoot();
    othersInPlace(root);
    const seen: { done: number; phase?: string; inPlace: boolean }[] = [];
    // A real download reports the archive's whole size at its last byte.
    const served = serve(bzip2Compress(goodTar, { blockBytes: 10_000 }));
    const whole: Downloader = (url, dest, progress) => served(url, dest, () => progress(kws.bytes));
    await ensureModels(root, whole, (done, _total, phase) => seen.push({ done, phase, inPlace: fs.existsSync(path.join(root, ".fake-kws.ok")) }));
    const before = seen.filter(s => !s.inPlace);
    // The archive is the first model: until it's in place, nothing says it's done, and the end says it's unpacking.
    expect(Math.max(...before.map(s => s.done))).toBeLessThan(kws.bytes);
    expect(before.filter(s => s.phase === "unpacking").length).toBeGreaterThanOrEqual(2);
    expect(before.findIndex(s => s.phase === "unpacking")).toBeGreaterThan(0); // after the download's own progress
    expect(seen.map(s => s.done)).toEqual([...seen.map(s => s.done)].sort((a, b) => a - b)); // it never goes back
    expect(seen.at(-1)?.done).toBe(kws.bytes);
  });

  it("replaces an older copy of the model whole, and clears a staging folder a crash left", async () => {
    const root = tmpRoot();
    othersInPlace(root);
    fs.mkdirSync(path.join(root, "fake-kws"));
    fs.writeFileSync(path.join(root, "fake-kws/stale.onnx"), "old");
    fs.mkdirSync(path.join(root, ".unpack-fake-kws"));
    fs.writeFileSync(path.join(root, ".unpack-fake-kws/junk"), "half");
    await ensureModels(root, serve(bzip2Compress(goodTar)));
    expect(fs.readdirSync(path.join(root, "fake-kws")).sort()).toEqual(["model.onnx", "tokens.txt"]);
    expect(leftovers(root)).toEqual([]);
  });

  const refused: [string, Uint8Array, RegExp][] = [
    ["an entry outside the model's folder", bzip2Compress(tarArchive([tarEntry({ name: "fake-kws/a", data: "x" }), tarEntry({ name: ".sherpa-onnx-moonshine-tiny-en-int8.ok", data: "forged" })])), /is outside "fake-kws"/],
    ["a path that climbs out", bzip2Compress(tarArchive([tarEntry({ name: "fake-kws/../../escape", data: "x" })])), /goes up a folder/],
    ["a link", bzip2Compress(tarArchive([tarEntry({ name: "fake-kws/l", type: "2", linkname: "/etc" })])), /links aren't allowed/],
    ["a damaged block (whose download still matches the pin)", bzip2Compress(goodTar, { blockBytes: 10_000, crcXor: b => (b === 2 ? 4 : 0) }), /bzip2 data is damaged: a block's CRC doesn't match/],
    ["an archive without the model's folder", bzip2Compress(tarArchive([])), /has no fake-kws folder/],
    ["a download that isn't bzip2", Uint8Array.from(Buffer.from("<html>captive portal</html>")), /isn't bzip2 data/],
  ];
  for (const [what, packed, reason] of refused) {
    it(`refuses ${what}, leaving nothing behind, and says it couldn't be unpacked`, async () => {
      const parent = tmpRoot();
      const root = path.join(parent, "models");
      fs.mkdirSync(root);
      othersInPlace(root);
      const before = fs.readdirSync(root).sort();
      const err = await ensureModels(root, serve(packed)).then(() => null, (e: Error) => e);
      expect(err?.message).toMatch(/^Wake word \(keyword spotting, 3\.3M zipformer\): the downloaded tar archive couldn't be unpacked: /);
      expect(err?.message).toMatch(reason);
      expect(fs.readdirSync(root).sort()).toEqual(before);
      expect(fs.readdirSync(parent)).toEqual(["models"]);
      const { downloadHelp } = await import("../../app/main/voice");
      expect(downloadHelp(err!.message)).toBe("The download couldn't be unpacked. Try again.");
    });
  }

  it("still says a full disk is a full disk when it fills during unpacking", async () => {
    const { downloadHelp } = await import("../../app/main/voice");
    expect(downloadHelp("Wake word: the downloaded tar archive couldn't be unpacked: ENOSPC: no space left on device, write")).toMatch(/enough free disk space/);
  });
});

/** A self-signed certificate for 127.0.0.1, from openssl if there is one (nothing is committed). */
const tls = (() => {
  try {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "ember-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(d, "key.pem"), "-out", path.join(d, "cert.pem"), "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1"], {
      stdio: "ignore",
      // Git for Windows' openssl would otherwise rewrite "/CN=..." as a Windows path.
      env: { ...process.env, MSYS_NO_PATHCONV: "1", MSYS2_ARG_CONV_EXCL: "*" },
    });
    const pair = { key: fs.readFileSync(path.join(d, "key.pem")), cert: fs.readFileSync(path.join(d, "cert.pem")) };
    fs.rmSync(d, { recursive: true, force: true });
    return pair;
  } catch {
    // No openssl (or one without -addext): the downloader is still covered by the real-model download.
    return null;
  }
})();

describe.skipIf(!tls)("createHttpsDownloader", () => {
  const body = randomBytes(7, 100_000);
  const hits: Record<string, number> = {};
  let server: https.Server;
  let base = "";
  beforeAll(async () => {
    server = https.createServer({ key: tls!.key, cert: tls!.cert }, (req, res) => {
      const route = req.url ?? "";
      hits[route] = (hits[route] ?? 0) + 1;
      if (route === "/model") return res.end(body);
      if (route === "/redirect") return res.writeHead(302, { location: "/hop" }).end();
      if (route === "/hop") return res.writeHead(301, { location: `${base}/model` }).end();
      if (route === "/flaky") return hits[route] < 3 ? res.writeHead(503).end() : res.end(body);
      if (route === "/to-http") return res.writeHead(302, { location: "http://127.0.0.1:9/model" }).end();
      if (route === "/stall") {
        res.writeHead(200, { "content-length": "1000" });
        res.write(Buffer.alloc(10));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    base = `https://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  });
  afterAll(() => {
    server.closeAllConnections();
    server.close();
  });
  // proxyEnv {}: the test server is local, whatever proxy this machine uses.
  const download = createHttpsDownloader({ agent: { ca: tls?.cert, proxyEnv: {} }, stallMs: 300, retryMs: 10 });
  const dest = () => path.join(tmpRoot(), "model.bin");

  it("follows redirects and writes the body, reporting progress", async () => {
    const file = dest();
    const seen: number[] = [];
    await download(`${base}/redirect`, file, b => seen.push(b));
    expect(Buffer.compare(fs.readFileSync(file), Buffer.from(body))).toBe(0);
    expect(seen.at(-1)).toBe(body.length);
  });

  it("fails on an HTTP error at once, in the words the voice service maps", async () => {
    await expect(download(`${base}/missing`, dest(), () => undefined)).rejects.toThrow("download failed: HTTP 404");
    expect(hits["/missing"]).toBe(1);
  });

  it("retries a server error and succeeds when it clears", async () => {
    const file = dest();
    await download(`${base}/flaky`, file, () => undefined);
    expect(hits["/flaky"]).toBe(3);
    expect(fs.statSync(file).size).toBe(body.length);
  });

  it("gives up on a stalled transfer after its retries", async () => {
    await expect(download(`${base}/stall`, dest(), () => undefined)).rejects.toThrow(/nothing arrived for 0\.3 seconds/);
    expect(hits["/stall"]).toBe(4);
  });

  it("says when the whole download ran out of time, rather than calling it a stall", async () => {
    const slow = createHttpsDownloader({ agent: { ca: tls?.cert, proxyEnv: {} }, stallMs: 5000, totalMs: 300, retryMs: 10 });
    await expect(slow(`${base}/stall`, dest(), () => undefined)).rejects.toThrow("download failed: it took longer than 0.3 seconds");
  });

  it("refuses a redirect away from https", async () => {
    await expect(download(`${base}/to-http`, dest(), () => undefined)).rejects.toThrow(/redirect went to http:/);
  });

  it("doesn't trust a certificate it wasn't given", async () => {
    const strict = createHttpsDownloader({ agent: { proxyEnv: {} }, retryMs: 10 });
    await expect(strict(`${base}/model`, dest(), () => undefined)).rejects.toThrow(/certificate/);
  });
});
