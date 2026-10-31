import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { inflateSync } from "node:zlib";
import { crc32, encodePng, MAX_SIDE, remoteCapture } from "../../app/remote/png";
import { bgraToRgba, downscale, maskRect } from "../../app/remote/mask";
import type { X11Image } from "../../app/main/platform/types";

/** A pretend screen of `w`×`h` whose pixel (x, y) is BGRA (x % 256, y % 256, 7, 0), clipped like x11.capture. */
function screen(w: number, h: number, onCapture: () => void = () => undefined) {
  return {
    capture(x: number, y: number, width: number, height: number): X11Image | null {
      onCapture();
      const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(w, x + width), y1 = Math.min(h, y + height);
      if (x1 <= x0 || y1 <= y0) return null;
      const bgra = Buffer.alloc((x1 - x0) * (y1 - y0) * 4);
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const i = ((yy - y0) * (x1 - x0) + (xx - x0)) * 4;
        bgra[i] = xx % 256; bgra[i + 1] = yy % 256; bgra[i + 2] = 7; bgra[i + 3] = 0;
      }
      return { x: x0, y: y0, width: x1 - x0, height: y1 - y0, bgra };
    },
  };
}

/** The PNG's pixels as RGB, decoded by sharp (an independent decoder, as the PC uses). */
async function decode(png: Buffer): Promise<{ data: Buffer; width: number; height: number; channels: number }> {
  const { data, info } = await sharp(png, { failOn: "error" }).raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

describe("crc32", () => {
  it("gives PNG's own CRC for IEND (0xAE426082)", () => {
    expect(crc32(Buffer.from("IEND", "latin1"))).toBe(0xae426082);
  });

  it("continues across pieces as over the whole", () => {
    const all = Buffer.from("IHDR then the data", "latin1");
    expect(crc32(all.subarray(5), crc32(all.subarray(0, 5)))).toBe(crc32(all));
  });
});

describe("encodePng", () => {
  it("round-trips through an independent decoder pixel for pixel", async () => {
    const w = 37, h = 11;
    const rgba = Buffer.alloc(w * h * 4);
    for (let i = 0; i < w * h; i++) { rgba[i * 4] = i % 251; rgba[i * 4 + 1] = (i * 7) % 256; rgba[i * 4 + 2] = (i * 13) % 256; rgba[i * 4 + 3] = 255; }
    const out = await decode(encodePng(rgba, w, h));
    expect([out.width, out.height, out.channels]).toEqual([w, h, 3]);
    for (let i = 0; i < w * h; i++) expect([...out.data.subarray(i * 3, i * 3 + 3)]).toEqual([rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]);
  });

  it("writes filter 0 on every row of 8-bit RGB, deflated", () => {
    const png = encodePng(Buffer.alloc(3 * 2 * 4, 255), 3, 2);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.subarray(12, 16).toString("latin1")).toBe("IHDR");
    expect([png[24], png[25], png[26], png[27], png[28]]).toEqual([8, 2, 0, 0, 0]);
    const idatLen = png.readUInt32BE(33);
    expect(png.subarray(37, 41).toString("latin1")).toBe("IDAT");
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    expect(raw.length).toBe(2 * (1 + 3 * 3));
    expect([raw[0], raw[10]]).toEqual([0, 0]);
  });

  it("refuses pixels that don't match the size", () => {
    expect(() => encodePng(Buffer.alloc(10), 2, 2)).toThrow(/don't match/);
    expect(() => encodePng(Buffer.alloc(0), 0, 0)).toThrow(/positive size/);
  });
});

describe("mask and downscale", () => {
  it("swaps BGRA to opaque RGBA", () => {
    expect([...bgraToRgba(Buffer.from([1, 2, 3, 0]))]).toEqual([3, 2, 1, 255]);
  });

  it("blacks out a rectangle clipped to the image", () => {
    const rgba = Buffer.alloc(4 * 4 * 4, 200);
    maskRect(rgba, 4, 4, { x: 2, y: -5, width: 10, height: 6 });
    const px = (x: number, y: number) => [...rgba.subarray((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
    expect(px(2, 0)).toEqual([0, 0, 0, 255]);
    expect(px(3, 0)).toEqual([0, 0, 0, 255]);
    expect(px(1, 0)).toEqual([200, 200, 200, 200]);
    expect(px(2, 1)).toEqual([200, 200, 200, 200]);
  });

  it("averages each output pixel's box and never enlarges", () => {
    const rgba = Buffer.alloc(4 * 2 * 4);
    for (let i = 0; i < 8; i++) rgba.set([i % 2 ? 100 : 0, 50, 0, 255], i * 4);
    const out = downscale(rgba, 4, 2, 2);
    expect([out.width, out.height, out.scale]).toEqual([2, 1, 0.5]);
    expect([...out.rgba.subarray(0, 4)]).toEqual([50, 50, 0, 255]);
    expect(downscale(rgba, 4, 2, 10).rgba).toBe(rgba);
  });
});

describe("remoteCapture", () => {
  it("captures, masks before encoding, and keeps the longer side at 1280 px", async () => {
    const shot = await remoteCapture(screen(2560, 1440), { x: 0, y: 0, width: 2560, height: 1440 }, { mask: [{ x: 0, y: 0, width: 1280, height: 1440 }] });
    expect(shot).not.toBeNull();
    expect(shot!.mimeType).toBe("image/png");
    expect([shot!.width, shot!.height, shot!.scale]).toEqual([MAX_SIDE, 720, 0.5]);
    expect(shot!.rect).toEqual({ x: 0, y: 0, width: 2560, height: 1440 });
    const out = await decode(shot!.data);
    const at = (x: number, y: number) => [...out.data.subarray((y * out.width + x) * 3, (y * out.width + x) * 3 + 3)];
    // The masked left half is black to its last pixel; the right half keeps the screen's (averaged) colours.
    expect(at(0, 0)).toEqual([0, 0, 0]);
    expect(at(639, 719)).toEqual([0, 0, 0]);
    expect(at(1000, 10)[0]).toBe(7);
  });

  it("clips to the screen and reports where the image starts", async () => {
    const shot = await remoteCapture(screen(100, 80), { x: 50, y: 40, width: 200, height: 200 });
    expect(shot!.rect).toEqual({ x: 50, y: 40, width: 50, height: 40 });
    expect([shot!.width, shot!.height, shot!.scale]).toEqual([50, 40, 1]);
    const out = await decode(shot!.data);
    expect([...out.data.subarray(0, 3)]).toEqual([7, 40, 50]);
  });

  it("sends no image when the masks can't be known, or nothing could be captured (fail closed)", async () => {
    expect(await remoteCapture(screen(10, 10), { x: 0, y: 0, width: 10, height: 10 }, { maskAfter: async () => null })).toBeNull();
    expect(await remoteCapture(screen(10, 10), { x: 50, y: 50, width: 10, height: 10 })).toBeNull();
  });

  it("applies the masks known only after the pixels were taken", async () => {
    const shot = await remoteCapture(screen(20, 10), { x: 0, y: 0, width: 20, height: 10 }, { maskAfter: async () => [{ x: 10, y: 0, width: 10, height: 10 }] });
    const out = await decode(shot!.data);
    expect([...out.data.subarray((5 * 20 + 15) * 3, (5 * 20 + 15) * 3 + 3)]).toEqual([0, 0, 0]);
    expect([...out.data.subarray((5 * 20 + 2) * 3, (5 * 20 + 2) * 3 + 3)]).toEqual([7, 5, 2]);
  });

  it("shows a hidden overlay again even when the capture throws", async () => {
    const events: string[] = [];
    const hideOverlay = async () => { events.push("hide"); return () => events.push("show"); };
    await expect(remoteCapture({ capture: () => { throw new Error("gone"); } }, { x: 0, y: 0, width: 1, height: 1 }, { hideOverlay })).rejects.toThrow("gone");
    expect(events).toEqual(["hide", "show"]);
  });
});
