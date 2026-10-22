import crypto from "node:crypto";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkRemoteImage, dropChannel, imageWaitMs, receiveImage } from "../../app/main/remote/remote-capture";
import { fakeLink } from "./remote-target-fakes";
import type { AxNode } from "../../app/main/perception/sidecar";
import type { ImageRef } from "../../app/main/remote/protocol";

/** A PNG of `width` × `height`, grey, as a remote's encoder would send it. */
const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: { r: 120, g: 120, b: 120 } } }).png().toBuffer();
const sha = (b: Uint8Array) => crypto.createHash("sha256").update(b).digest("hex");
const refOf = (bytes: Uint8Array, patch: Partial<ImageRef> = {}): ImageRef => ({
  channel: 7, bytes: bytes.length, sha256: sha(bytes), width: 200, height: 100, rect: { x: 50, y: 40, width: 200, height: 100 }, scale: 1, mime: "image/png", ...patch,
});
const button: AxNode = { id: 3, parent: 0, depth: 1, role: "push button", name: "Save", states: ["enabled"], bounds: { x: 60, y: 50, width: 60, height: 24 } };
const secret: AxNode = { id: 4, parent: 0, depth: 1, role: "password text", name: "", states: ["enabled"], bounds: { x: 60, y: 90, width: 120, height: 24 }, secret: true };

describe("checkRemoteImage (§7.2 item 5)", () => {
  it("checks a remote PNG, draws Ember's marks on it and re-encodes it as JPEG in the remote's own coordinates", async () => {
    const bytes = await png(200, 100);
    const r = await checkRemoteImage(bytes, refOf(bytes), [button, secret], "build-01");
    if (!("capture" in r)) throw new Error(r.why);
    expect(r.capture.mimeType).toBe("image/jpeg");
    expect([r.capture.width, r.capture.height, r.capture.scale]).toEqual([200, 100, 1]);
    expect(r.capture.rect).toEqual({ x: 50, y: 40, width: 200, height: 100 });
    const meta = await sharp(r.capture.data).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(["jpeg", 200, 100]);
    // The mark's orange box is where the button is (image px = (screen px - rect) × scale); none on the secret field.
    const raw = await sharp(r.capture.data).raw().toBuffer({ resolveWithObject: true });
    const at = (x: number, y: number) => { const i = (y * raw.info.width + x) * raw.info.channels; return [raw.data[i], raw.data[i + 1], raw.data[i + 2]]; };
    const [rr, gg, bb] = at(10, 20);
    expect(rr).toBeGreaterThan(200);
    expect(gg).toBeLessThan(170);
    expect(bb).toBeLessThan(100);
    expect(at(60, 62).every(v => Math.abs(v - 120) < 12)).toBe(true);
  });

  it("shrinks a picture larger than 1280 px on its longer side, as this screen's are", async () => {
    const bytes = await png(2000, 500);
    const r = await checkRemoteImage(bytes, refOf(bytes, { width: 2000, height: 500, rect: { x: 0, y: 0, width: 2000, height: 500 } }), [], "build-01");
    if (!("capture" in r)) throw new Error(r.why);
    expect([r.capture.width, r.capture.height, r.capture.scale]).toEqual([1280, 320, 0.64]);
  });

  it("refuses anything that doesn't check out: no picture, never a guess", async () => {
    const bytes = await png(200, 100);
    const why = async (b: Uint8Array, ref: ImageRef) => { const r = await checkRemoteImage(b, ref, [], "build-01"); return "why" in r ? r.why : "accepted"; };
    expect(await why(bytes, refOf(bytes, { bytes: bytes.length + 1 }))).toBe("build-01's screenshot wasn't the size it said");
    expect(await why(bytes, refOf(bytes, { sha256: "0".repeat(64) }))).toBe("build-01's screenshot didn't match its checksum");
    const jpeg = await sharp(bytes).jpeg().toBuffer();
    expect(await why(jpeg, refOf(jpeg))).toBe("build-01's screenshot wasn't a PNG");
    expect(await why(bytes, refOf(bytes, { width: 300, rect: { x: 0, y: 0, width: 300, height: 100 } }))).toBe("build-01's screenshot wasn't what it said");
    expect(await why(bytes, refOf(bytes, { rect: { x: 0, y: 0, width: 400, height: 100 } }))).toBe("build-01's screenshot didn't fit where it said it was taken");
    expect(await why(bytes, refOf(bytes, { width: 5000, rect: { x: 0, y: 0, width: 5000, height: 100 } }))).toBe("build-01's screenshot was too large");
    // Cut short (its checksum and size made to fit what is left): sharp's failOn "error" refuses it whole.
    const cut = bytes.subarray(0, bytes.length - 30);
    expect(await why(cut, refOf(cut))).toBe("build-01's screenshot couldn't be read");
  });

  it("decodes with sharp's pixel limit (4096 × 4096) and failOn: \"error\"", async () => {
    const calls: unknown[] = [];
    const fake = ((input: unknown, opts: unknown) => {
      calls.push(opts);
      return sharp(input as Buffer, opts as sharp.SharpOptions);
    }) as unknown as typeof sharp;
    const bytes = await png(20, 10);
    await checkRemoteImage(bytes, refOf(bytes, { width: 20, height: 10, rect: { x: 0, y: 0, width: 20, height: 10 } }), [], "build-01", { sharp: fake });
    expect(calls[0]).toEqual({ limitInputPixels: 4096 * 4096, failOn: "error" });
  });
});

describe("receiveImage", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("collects exactly the bytes the answer said, held by the link if they came first", async () => {
    const link = fakeLink();
    const bytes = await png(200, 100);
    link.bytes(7, bytes.subarray(0, 100));
    const got = receiveImage(link, refOf(bytes), "build-01", 1000);
    link.bytes(7, bytes.subarray(100));
    expect(Buffer.from(await got as Uint8Array).equals(bytes)).toBe(true);
    expect(link.listening()).toBe(0);
  });

  it("finishes at once when every byte was already held, leaving no listener behind", async () => {
    const link = fakeLink();
    const bytes = new Uint8Array([1, 2, 3, 4]);
    link.bytes(9, bytes);
    expect(await receiveImage(link, { channel: 9, bytes: 4 }, "build-01", 1000)).toEqual(bytes);
    expect(link.listening()).toBe(0);
  });

  it("gives up on more bytes than it said, a link that drops, and a picture that doesn't come in time", async () => {
    const link = fakeLink();
    const more = receiveImage(link, { channel: 1, bytes: 3 }, "build-01", 1000);
    link.bytes(1, new Uint8Array(4));
    expect(await more).toEqual({ why: "build-01's screenshot was larger than it said" });
    const lost = receiveImage(link, { channel: 2, bytes: 3 }, "build-01", 1000);
    link.setState("lost");
    expect(await lost).toEqual({ why: "the connection to build-01 dropped" });
    vi.useFakeTimers();
    const late = receiveImage(fakeLink(), { channel: 3, bytes: 3 }, "build-01", 1000);
    vi.advanceTimersByTime(1000);
    expect(await late).toEqual({ why: "build-01's screenshot didn't arrive in time" });
  });

  it("waits longer for bigger pictures and slower links, within bounds", () => {
    expect(imageWaitMs({ bytes: 1_000_000 }, 40)).toBe(20_040);
    expect(imageWaitMs({ bytes: 8 * 1024 * 1024 }, 40)).toBe(90_000);
  });

  it("drops a channel's held bytes nobody wants", async () => {
    const link = fakeLink();
    link.bytes(5, new Uint8Array([1]));
    dropChannel(link, 5);
    const later = receiveImage(link, { channel: 5, bytes: 1 }, "build-01", 50);
    expect(await later).toEqual({ why: "build-01's screenshot didn't arrive in time" });
  });
});
