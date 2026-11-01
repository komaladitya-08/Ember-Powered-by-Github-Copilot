/**
 * A remote's screenshot on the PC (§5.5, §7.2 item 5, L16): the agent masks and encodes a PNG on the remote (never-look
 * windows, security windows and secret fields are blacked out before a pixel leaves) and sends its bytes on a bulk
 * channel; its answer says which channel, how many bytes, their SHA-256, the image's size and where it lies on the
 * remote's screen. Here the bytes are collected, checked against all of that, decoded by sharp with a pixel limit and
 * `failOn: "error"`, given Ember's numbered marks and re-encoded as JPEG at most 1280 px on its longer side, as this
 * screen's pictures are. Anything that doesn't check out means no picture (fail closed), never a guess. The picture's
 * coordinates are the remote's own: nothing here is ever flown to or clicked on the PC. PC only (sharp is never shipped
 * to a remote).
 */

import crypto from "node:crypto";
import { createRequire } from "node:module";
import type Sharp from "sharp";
import { marksSvg } from "../perception/marks";
import { CAPS, type ImageRef } from "./protocol";
import type { Capture } from "../perception/capture";
import type { AxNode } from "../perception/sidecar";
import type { RemoteLink } from "./types";

/** The longest side of a picture a worker gets (perception/capture.ts's default). */
const MAX_SIDE = 1280;
/** JPEG quality, as this screen's pictures (perception/capture.ts). */
const JPEG_QUALITY = 78;
/** How far an image's size may be from its rectangle times its scale (rounding on the remote), in pixels. */
const SIZE_SLACK = 2;
/** The slowest link a picture is waited for at, after its answer came (bytes per second): about 0.8 Mbit/s. */
const SLOWEST_BYTES_PER_S = 100_000;
/** A picture is never waited for longer than this after its answer came. */
const MAX_WAIT_MS = 90_000;
/** The eight bytes every PNG starts with. */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// Loaded on first use: sharp's native library is large and pictures are rare (as perception/capture.ts).
const requireCjs = createRequire(__filename);
let sharpModule: typeof Sharp | null = null;
const loadSharp = (): typeof Sharp => (sharpModule ??= requireCjs("sharp") as typeof Sharp);

/** A picture ready for the worker, or why there is none (Ember's words, for "(No screenshot: <why>.)"). */
export type RemotePicture = { capture: Capture } | { why: string };

/** How long to wait for a picture's bytes after its answer: 10 s, the round trip, and its size at a slow link's speed. */
export function imageWaitMs(ref: Pick<ImageRef, "bytes">, rttMs: number): number {
  const rtt = Number.isFinite(rttMs) && rttMs > 0 ? Math.min(rttMs, 60_000) : 0;
  return Math.min(MAX_WAIT_MS, 10_000 + rtt + Math.ceil((ref.bytes / SLOWEST_BYTES_PER_S) * 1000));
}

/**
 * The picture's bytes from its bulk channel: exactly `ref.bytes` of them, or why not (more than it said, the link went,
 * or not all of them within `waitMs`). Bytes that came before this asked for them are the link's to hand over (it holds
 * a channel's bytes until someone takes them, §5.4: the bytes travel before the answer).
 */
export function receiveImage(link: Pick<RemoteLink, "onBytes" | "onState">, ref: Pick<ImageRef, "channel" | "bytes">, label: string, waitMs: number,
  timers: { setTimeout: typeof setTimeout; clearTimeout: typeof clearTimeout } = { setTimeout, clearTimeout }): Promise<Uint8Array | { why: string }> {
  return new Promise(resolve => {
    const chunks: Uint8Array[] = [];
    let got = 0;
    let settled = false;
    const cleanups: (() => void)[] = [];
    const undo = (c: () => void) => {
      try { c(); } catch { /* an unsubscribe that throws leaves nothing more to undo */ }
    };
    /** Keeps `c` to run when this ends (at once when it already has: a link may hand over held bytes while subscribing). */
    const later = (c: () => void) => (settled ? undo(c) : cleanups.push(c));
    const finish = (v: Uint8Array | { why: string }) => {
      if (settled) return;
      settled = true;
      for (const c of cleanups.splice(0)) undo(c);
      resolve(v);
    };
    if (ref.bytes <= 0) return finish({ why: `${label} sent an empty screenshot` });
    const timer = timers.setTimeout(() => finish({ why: `${label}'s screenshot didn't arrive in time` }), waitMs);
    (timer as { unref?: () => void }).unref?.();
    later(() => timers.clearTimeout(timer));
    later(link.onState(s => { if (s === "lost" || s === "closed") finish({ why: `the connection to ${label} dropped` }); }));
    later(link.onBytes(ref.channel, b => {
      if (settled) return;
      got += b.length;
      if (got > ref.bytes || got > CAPS.image.bytes) {
        finish({ why: `${label}'s screenshot was larger than it said` });
        return;
      }
      chunks.push(b.slice());
      if (got === ref.bytes) finish(concat(chunks, got));
    }));
  });
}

/** Takes a channel's bytes nobody wants (a picture of a window that turned out private), so the link drops them. */
export function dropChannel(link: Pick<RemoteLink, "onBytes">, channel: number): void {
  try {
    link.onBytes(channel, () => undefined)();
  } catch {
    // nothing was held for it
  }
}

/**
 * The remote's PNG checked and made into the worker's picture: its byte count, its SHA-256, its signature, its size
 * (as decoded, and against its rectangle and scale), decoded by sharp with `limitInputPixels` and `failOn: "error"`;
 * then Ember's marks for `nodes` (secret fields get none) and JPEG at most 1280 px on its longer side.
 */
export async function checkRemoteImage(bytes: Uint8Array, ref: ImageRef, nodes: AxNode[], label: string, o: { sharp?: typeof Sharp } = {}): Promise<RemotePicture> {
  const no = (why: string): RemotePicture => ({ why });
  if (bytes.length !== ref.bytes || bytes.length > CAPS.image.bytes) return no(`${label}'s screenshot wasn't the size it said`);
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== ref.sha256) return no(`${label}'s screenshot didn't match its checksum`);
  if (ref.mime !== "image/png" || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) return no(`${label}'s screenshot wasn't a PNG`);
  const sides = [ref.width, ref.height];
  if (!sides.every(s => Number.isInteger(s) && s >= 1 && s <= CAPS.image.side)) return no(`${label}'s screenshot was too large`);
  if (!(ref.scale > 0) || Math.abs(ref.rect.width * ref.scale - ref.width) > SIZE_SLACK || Math.abs(ref.rect.height * ref.scale - ref.height) > SIZE_SLACK) {
    return no(`${label}'s screenshot didn't fit where it said it was taken`);
  }
  const sharp = o.sharp ?? loadSharp();
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const decode = () => sharp(input, { limitInputPixels: CAPS.image.side * CAPS.image.side, failOn: "error" });
  try {
    const meta = await decode().metadata();
    if (meta.format !== "png" || meta.width !== ref.width || meta.height !== ref.height) return no(`${label}'s screenshot wasn't what it said`);
    // Decoded whole once before anything is drawn: a damaged image fails here (failOn: "error"), not halfway through.
    const raw = await decode().removeAlpha().raw().toBuffer({ resolveWithObject: true });
    if (raw.info.width !== ref.width || raw.info.height !== ref.height) return no(`${label}'s screenshot wasn't what it said`);
    const k = Math.min(1, MAX_SIDE / Math.max(ref.width, ref.height));
    const width = Math.max(1, Math.round(ref.width * k)), height = Math.max(1, Math.round(ref.height * k));
    const scale = ref.scale * k;
    let pipeline = sharp(raw.data, { raw: { width: raw.info.width, height: raw.info.height, channels: raw.info.channels } }).resize(width, height);
    const svg = nodes.length ? marksSvg(nodes, ref.rect, scale, width, height) : null;
    if (svg) {
      const base = await pipeline.png().toBuffer();
      pipeline = sharp(base).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
    }
    const data = await pipeline.jpeg({ quality: JPEG_QUALITY }).toBuffer();
    return { capture: { rect: { ...ref.rect }, data, mimeType: "image/jpeg", width, height, scale } };
  } catch {
    // A damaged or hostile picture (sharp's own error is no reason to show anyone): no picture.
    return no(`${label}'s screenshot couldn't be read`);
  }
}

/** One array of `total` bytes from `chunks`. */
function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
