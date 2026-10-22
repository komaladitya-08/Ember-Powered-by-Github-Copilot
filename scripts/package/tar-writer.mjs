// A deterministic tar writer (and the small reader remote-parts.mjs needs for npm's package tarballs), so the remote
// parts archives are the same bytes whichever OS stages them (design §5.2.2, critique integration-14): no system tar,
// gzip or xz. The writer sorts its entries, and gives every entry mtime 0, uid and gid 0, no user or group name and
// the mode its caller chose; gzip's header carries mtime 0 and the Unix OS byte on every OS. The reader takes only
// what npm pack writes (ustar or pax names, regular files and folders) and refuses anything that could land outside
// its folder. Plain Node, no dependencies.

import { gzipSync } from "node:zlib";

const BLOCK = 512;
/** tar's default record (20 blocks): the archive is padded to whole records, as tar itself does. */
const RECORD = 20 * BLOCK;
const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

/** An entry name tar may hold: relative, "/"-separated, no "." or ".." parts, no backslash or control character. */
function checkName(name) {
  if (typeof name !== "string" || !name || name.startsWith("/") || name.endsWith("/")) throw new Error(`not a relative entry name: ${JSON.stringify(name)}`);
  // eslint-disable-next-line no-control-regex -- control characters are exactly what's refused here
  if (/[\\\u0000-\u001f\u007f]/.test(name)) throw new Error(`an entry name holds a backslash or a control character: ${JSON.stringify(name)}`);
  if (name.split("/").some(p => p === "" || p === "." || p === "..")) throw new Error(`an entry name has an empty, "." or ".." part: ${JSON.stringify(name)}`);
}

/** `value` as `width - 1` octal digits and a NUL, written into `buf` at `at`. */
function octal(buf, at, width, value) {
  const s = value.toString(8).padStart(width - 1, "0");
  if (s.length > width - 1) throw new Error(`${value} doesn't fit a tar field of ${width} bytes`);
  buf.write(s, at, width - 1, "latin1");
  buf[at + width - 1] = 0;
}

/** The ustar name and prefix fields for `full` (a folder's with its trailing "/"). */
function splitName(full) {
  const bytes = enc.encode(full);
  if (bytes.length <= 100) return { name: bytes, prefix: new Uint8Array(0) };
  // The prefix ends at a "/" (not stored); the name after it holds at most 100 bytes, the prefix at most 155.
  for (let i = bytes.length - 1; i > 0; i--) {
    if (bytes[i] !== 0x2f) continue;
    const prefix = bytes.subarray(0, i), name = bytes.subarray(i + 1);
    if (prefix.length <= 155 && name.length <= 100 && name.length > 0) return { name, prefix };
  }
  throw new Error(`an entry name too long for ustar: ${full}`);
}

/** One entry's 512-byte ustar header. */
function header(full, mode, size, type) {
  const h = Buffer.alloc(BLOCK);
  const { name, prefix } = splitName(full);
  h.set(name, 0);
  octal(h, 100, 8, mode & 0o7777);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  octal(h, 124, 12, size);
  octal(h, 136, 12, 0);
  h.fill(0x20, 148, 156);
  h[156] = type.charCodeAt(0);
  h.write("ustar\u000000", 257, 8, "latin1");
  octal(h, 329, 8, 0);
  octal(h, 337, 8, 0);
  h.set(prefix, 345);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  h.write(`${sum.toString(8).padStart(6, "0")}\u0000 `, 148, 8, "latin1");
  return h;
}

/**
 * A tar archive (ustar) of `entries`, sorted by name: `{ path, mode, data }` for a file, `{ path, mode, dir: true }`
 * for a folder. Every folder a file sits in must be listed itself. Same entries in any order → the same bytes.
 * @param {{ path: string; mode: number; data?: Uint8Array; dir?: boolean }[]} entries
 * @returns {Buffer}
 */
export function tarArchive(entries) {
  const seen = new Set();
  const list = entries.map(e => {
    checkName(e.path);
    if (seen.has(e.path)) throw new Error(`an entry is listed twice: ${e.path}`);
    seen.add(e.path);
    if (!Number.isInteger(e.mode) || e.mode < 0 || e.mode > 0o7777) throw new Error(`not a mode: ${e.mode} (${e.path})`);
    if (!e.dir && !(e.data instanceof Uint8Array)) throw new Error(`a file entry needs its bytes: ${e.path}`);
    return e;
  });
  for (const e of list) {
    const parent = e.path.split("/").slice(0, -1).join("/");
    if (parent && !list.some(d => d.dir && d.path === parent)) throw new Error(`${e.path}'s folder isn't listed`);
  }
  // Byte order of the UTF-8 names, the same on every OS and in every locale.
  list.sort((a, b) => Buffer.compare(Buffer.from(a.path, "utf8"), Buffer.from(b.path, "utf8")));
  const parts = [];
  for (const e of list) {
    if (e.dir) {
      parts.push(header(`${e.path}/`, e.mode, 0, "5"));
      continue;
    }
    parts.push(header(e.path, e.mode, e.data.length, "0"), Buffer.from(e.data.buffer, e.data.byteOffset, e.data.length));
    const pad = (BLOCK - (e.data.length % BLOCK)) % BLOCK;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(2 * BLOCK));
  const body = Buffer.concat(parts);
  return Buffer.concat([body, Buffer.alloc((RECORD - (body.length % RECORD)) % RECORD)]);
}

/**
 * `data` gzipped at level 9 with a header that is the same on every OS: no name, mtime 0, and the OS byte "Unix" (zlib
 * writes its build's own OS code there).
 * @param {Uint8Array} data
 * @returns {Buffer}
 */
export function gzip(data) {
  const out = gzipSync(data, { level: 9 });
  out.writeUInt32LE(0, 4);
  out[9] = 3;
  return out;
}

/** A NUL-terminated field of a header as text. */
function field(h, at, width) {
  const raw = h.subarray(at, at + width);
  const end = raw.indexOf(0);
  return dec.decode(end < 0 ? raw : raw.subarray(0, end));
}

/** A numeric header field (octal, space or NUL padded). */
function number(h, at, width) {
  const s = h.subarray(at, at + width).toString("latin1").replace(/[\0 ]+$/, "").trim();
  if (!/^[0-7]+$/.test(s)) throw new Error(`a tar header has a malformed number (${JSON.stringify(s)})`);
  return parseInt(s, 8);
}

/** A pax extended header's records ("<len> key=value\n"). */
function paxRecords(data) {
  const out = new Map();
  let at = 0;
  while (at < data.length) {
    const sp = data.indexOf(0x20, at);
    if (sp < 0) throw new Error("a malformed pax header");
    const len = parseInt(data.subarray(at, sp).toString("latin1"), 10);
    if (!Number.isInteger(len) || len <= sp - at || at + len > data.length) throw new Error("a malformed pax record");
    const rec = dec.decode(data.subarray(sp + 1, at + len - 1));
    const eq = rec.indexOf("=");
    if (eq > 0) out.set(rec.slice(0, eq), rec.slice(eq + 1));
    at += len;
  }
  return out;
}

/**
 * The files and folders of an (uncompressed) tar archive as npm pack writes it: `{ path, mode, dir, data }`. Throws on
 * links, devices, absolute or ".." names, a header whose checksum is wrong, and an archive that ends early.
 * @param {Uint8Array} tar
 * @returns {{ path: string; mode: number; dir: boolean; data: Buffer }[]}
 */
export function readTar(tar) {
  const buf = Buffer.from(tar.buffer, tar.byteOffset, tar.length);
  const out = [];
  let pax = null;
  let at = 0;
  while (at + BLOCK <= buf.length) {
    const h = buf.subarray(at, at + BLOCK);
    if (h.every(b => b === 0)) return out;
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    if (sum !== number(h, 148, 8)) throw new Error("a tar header's checksum is wrong");
    const type = String.fromCharCode(h[156] || 0x30);
    const size = number(h, 124, 12);
    const start = at + BLOCK;
    if (start + size > buf.length) throw new Error("the tar archive ends early");
    const data = buf.subarray(start, start + size);
    at = start + Math.ceil(size / BLOCK) * BLOCK;
    if (type === "x") { pax = paxRecords(data); continue; }
    if (type === "g") continue;
    const prefix = field(h, 345, 155);
    let name = pax?.get("path") ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
    pax = null;
    if (type !== "0" && type !== "5") throw new Error(`a tar entry of type ${JSON.stringify(type)} (${name}): only files and folders are taken`);
    const dir = type === "5";
    name = name.replace(/\/+$/, "");
    checkName(name);
    out.push({ path: name, mode: number(h, 100, 8) & 0o7777, dir, data: dir ? Buffer.alloc(0) : Buffer.from(data) });
  }
  throw new Error("the tar archive ends without its end blocks");
}
