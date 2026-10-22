/**
 * A property-list reader for the app catalogue: XML plists and binary ("bplist00") plists, the two forms an app
 * bundle's Contents/Info.plist comes in. Ember reads a few hundred of them when it lists apps, so it parses them itself
 * instead of starting one /usr/bin/plutil per bundle (about 2 s for 200 apps). Pure and bounded: the input is a file
 * any app on the machine wrote, so every offset is checked, nesting is limited, a shared or cyclic object reference
 * can't make the work grow, and a malformed list throws (the caller skips that bundle).
 */

/** A decoded property-list value. Integers and reals are numbers; `<data>` is a Buffer; `<date>` a Date. */
export type PlistValue = string | number | boolean | Buffer | Date | null | PlistValue[] | PlistDict;

/** A plist dictionary (keys are always strings). */
export interface PlistDict { [key: string]: PlistValue }

/** How deep arrays and dictionaries may nest (Info.plist files nest four or five levels). */
const MAX_DEPTH = 64;
/** Seconds between the Unix epoch and the plist epoch (2001-01-01T00:00:00Z). */
const PLIST_EPOCH = 978_307_200;

/** Sets `key` as an own property even when it is "__proto__" (a plain assignment would change the prototype). */
function put(dict: PlistDict, key: string, value: PlistValue): void {
  Object.defineProperty(dict, key, { value, enumerable: true, writable: true, configurable: true });
}

/** True for a non-null, non-array, non-Buffer, non-Date object: a plist dictionary. */
export function isPlistDict(v: PlistValue | undefined): v is PlistDict {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !Buffer.isBuffer(v) && !(v instanceof Date);
}

/** Parses a property list held in `buf` (XML in UTF-8 or UTF-16 with a BOM, or binary). Throws when it isn't one. */
export function parsePlist(buf: Buffer): PlistValue {
  if (buf.length >= 8 && buf.subarray(0, 8).toString("latin1") === "bplist00") return parseBinary(buf);
  return parseXml(decodeText(buf));
}

/** The text of an XML plist: UTF-8 (with or without a BOM) or UTF-16 with a BOM. */
function decodeText(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString("utf16le");
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString("utf16le");
  const text = buf.toString("utf8");
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ───────────── XML ─────────────

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

/** Character data with XML's five named entities and numeric references decoded. */
function unescapeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, ref: string) => {
    if (ref[0] === "#") {
      const code = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[ref] ?? whole;
  });
}

interface Tag { name: string; closing: boolean; empty: boolean }

/** A cursor over an XML plist's text: just enough XML for what plist writers produce. */
class XmlCursor {
  private i = 0;
  constructor(private readonly s: string) {}

  fail(what: string): never {
    throw new Error(`not a property list: ${what} at character ${this.i}`);
  }

  /** Skips white space, comments, processing instructions and the DOCTYPE. */
  skipMisc(): void {
    for (;;) {
      while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
      if (this.s.startsWith("<!--", this.i)) this.skipPast("-->");
      else if (this.s.startsWith("<?", this.i)) this.skipPast("?>");
      else if (this.s.startsWith("<!DOCTYPE", this.i)) this.skipDoctype();
      else return;
    }
  }

  private skipPast(end: string): void {
    const at = this.s.indexOf(end, this.i);
    if (at < 0) this.fail(`unterminated ${end}`);
    this.i = at + end.length;
  }

  /** A DOCTYPE, including an internal subset in brackets. */
  private skipDoctype(): void {
    let depth = 0;
    for (; this.i < this.s.length; this.i++) {
      const c = this.s[this.i];
      if (c === "[") depth++;
      else if (c === "]") depth--;
      else if (c === ">" && depth <= 0) {
        this.i++;
        return;
      }
    }
    this.fail("unterminated DOCTYPE");
  }

  /** The tag at the cursor (after skipMisc), consumed. */
  tag(): Tag {
    this.skipMisc();
    if (this.s[this.i] !== "<") this.fail("expected a tag");
    const end = this.s.indexOf(">", this.i);
    if (end < 0) this.fail("unterminated tag");
    const inner = this.s.slice(this.i + 1, end);
    this.i = end + 1;
    // Only the name is matched by a pattern (anchored, linear); an empty element's "/" is read off the end. A pattern
    // that also spans the rest backtracks quadratically on a long run of spaces inside one tag, and the catalogue
    // reads these files, which any app can write, on Electron's main thread.
    const m = /^(\/?)\s*([A-Za-z][\w.-]*)/.exec(inner);
    if (!m) this.fail(`bad tag <${inner.slice(0, 20)}>`);
    return { name: m[2]!, closing: m[1] === "/", empty: inner.trimEnd().endsWith("/") };
  }

  /** Is the next tag (after skipMisc) the closing tag `name`? Doesn't consume it. */
  atClosing(name: string): boolean {
    this.skipMisc();
    return new RegExp(`^</\\s*${name}\\s*>`).test(this.s.slice(this.i, this.i + name.length + 8));
  }

  /** Text up to the closing tag `name` (CDATA sections kept as they are, entities decoded), and the closing tag. */
  text(name: string): string {
    let out = "";
    for (;;) {
      if (this.s.startsWith("<![CDATA[", this.i)) {
        const end = this.s.indexOf("]]>", this.i);
        if (end < 0) this.fail("unterminated CDATA");
        out += this.s.slice(this.i + 9, end);
        this.i = end + 3;
        continue;
      }
      if (this.s.startsWith("<!--", this.i)) {
        this.skipPast("-->");
        continue;
      }
      const lt = this.s.indexOf("<", this.i);
      if (lt < 0) this.fail(`unterminated <${name}>`);
      out += unescapeXml(this.s.slice(this.i, lt));
      this.i = lt;
      if (this.s.startsWith("<![CDATA[", lt) || this.s.startsWith("<!--", lt)) continue;
      const t = this.tag();
      if (!t.closing || t.name !== name) this.fail(`expected </${name}>`);
      return out;
    }
  }
}

function parseXml(text: string): PlistValue {
  const c = new XmlCursor(text);
  const t = c.tag();
  // A bare value without the <plist> wrapper is rare, but plist readers accept it.
  if (t.name !== "plist" || t.closing) return xmlValue(c, t, 0);
  if (t.empty || c.atClosing("plist")) return null;
  const value = xmlValue(c, c.tag(), 0);
  const end = c.tag();
  if (!end.closing || end.name !== "plist") c.fail("expected </plist>");
  return value;
}

function xmlValue(c: XmlCursor, t: Tag, depth: number): PlistValue {
  if (t.closing) c.fail(`unexpected </${t.name}>`);
  if (depth > MAX_DEPTH) c.fail("nested too deeply");
  switch (t.name) {
    case "dict": {
      const dict: PlistDict = {};
      if (t.empty) return dict;
      for (;;) {
        const k = c.tag();
        if (k.closing && k.name === "dict") return dict;
        if (k.name !== "key" || k.closing) c.fail("expected <key>");
        const key = k.empty ? "" : c.text("key");
        put(dict, key, xmlValue(c, c.tag(), depth + 1));
      }
    }
    case "array": {
      const out: PlistValue[] = [];
      if (t.empty) return out;
      for (;;) {
        const v = c.tag();
        if (v.closing && v.name === "array") return out;
        out.push(xmlValue(c, v, depth + 1));
      }
    }
    case "string":
      return t.empty ? "" : c.text("string");
    case "integer":
    case "real": {
      const raw = t.empty ? "" : c.text(t.name).trim();
      const n = t.name === "integer" && /^[+-]?0x[0-9a-f]+$/i.test(raw) ? Number.parseInt(raw, 16) : Number(raw);
      if (!raw || Number.isNaN(n)) c.fail(`bad <${t.name}> ${raw.slice(0, 20)}`);
      return n;
    }
    case "true":
    case "false":
      if (!t.empty) c.text(t.name);
      return t.name === "true";
    case "date": {
      const d = new Date(t.empty ? "" : c.text("date").trim());
      if (Number.isNaN(d.getTime())) c.fail("bad <date>");
      return d;
    }
    case "data":
      return t.empty ? Buffer.alloc(0) : Buffer.from(c.text("data").replace(/\s+/g, ""), "base64");
    default:
      return c.fail(`unknown element <${t.name}>`);
  }
}

// ───────────── Binary (bplist00) ─────────────

function parseBinary(buf: Buffer): PlistValue {
  if (buf.length < 8 + 32) throw new Error("not a property list: binary plist too short");
  const trailer = buf.length - 32;
  const offsetSize = buf[trailer + 6]!, refSize = buf[trailer + 7]!;
  const count = uint(buf, trailer + 8, 8), top = uint(buf, trailer + 16, 8), tableAt = uint(buf, trailer + 24, 8);
  if (offsetSize < 1 || offsetSize > 8 || refSize < 1 || refSize > 8) throw new Error("not a property list: bad trailer sizes");
  if (count < 1 || top >= count || tableAt < 8 || tableAt + count * offsetSize > trailer) throw new Error("not a property list: bad trailer");
  // Objects live between the header and the offset table; nothing may be read outside that span.
  const end = tableAt;
  const need = (at: number, n: number) => {
    if (at < 8 || n < 0 || at + n > end) throw new Error("not a property list: object out of bounds");
  };
  const offsetOf = (ref: number): number => {
    if (ref >= count) throw new Error("not a property list: bad object reference");
    return uint(buf, tableAt + ref * offsetSize, offsetSize);
  };
  const done = new Map<number, PlistValue>();
  const active = new Set<number>();

  /** A length that follows a marker whose low nibble is 0xF: an int object. */
  const lengthAt = (at: number, nibble: number): { n: number; next: number } => {
    if (nibble !== 0xf) return { n: nibble, next: at + 1 };
    need(at + 1, 1);
    const m = buf[at + 1]!;
    if (m >> 4 !== 0x1 || (m & 0xf) > 3) throw new Error("not a property list: bad length");
    const size = 1 << (m & 0xf);
    need(at + 2, size);
    return { n: uint(buf, at + 2, size), next: at + 2 + size };
  };

  const object = (ref: number, depth: number): PlistValue => {
    const cached = done.get(ref);
    if (cached !== undefined) return cached;
    if (active.has(ref)) throw new Error("not a property list: an object contains itself");
    if (depth > MAX_DEPTH) throw new Error("not a property list: nested too deeply");
    active.add(ref);
    const value = decode(offsetOf(ref), depth);
    active.delete(ref);
    done.set(ref, value);
    return value;
  };

  const refs = (at: number, n: number): number[] => {
    need(at, n * refSize);
    const out: number[] = [];
    for (let i = 0; i < n; i++) out.push(uint(buf, at + i * refSize, refSize));
    return out;
  };

  const decode = (at: number, depth: number): PlistValue => {
    need(at, 1);
    const marker = buf[at]!, kind = marker >> 4, nibble = marker & 0xf;
    switch (kind) {
      case 0x0:
        if (marker === 0x08) return false;
        if (marker === 0x09) return true;
        if (marker === 0x00 || marker === 0x0f) return null;
        break;
      case 0x1: {
        if (nibble > 4) break;
        const size = 1 << nibble;
        need(at + 1, size);
        // 8- and 16-byte integers are signed (the 16-byte form's value is in its low 8 bytes).
        if (size === 8) return Number(buf.readBigInt64BE(at + 1));
        if (size === 16) return Number(buf.readBigInt64BE(at + 9));
        return uint(buf, at + 1, size);
      }
      case 0x2:
        if (nibble === 2 || nibble === 3) {
          need(at + 1, nibble === 2 ? 4 : 8);
          return nibble === 2 ? buf.readFloatBE(at + 1) : buf.readDoubleBE(at + 1);
        }
        break;
      case 0x3:
        if (marker !== 0x33) break;
        need(at + 1, 8);
        return new Date((PLIST_EPOCH + buf.readDoubleBE(at + 1)) * 1000);
      case 0x4: {
        const { n, next } = lengthAt(at, nibble);
        need(next, n);
        return Buffer.from(buf.subarray(next, next + n));
      }
      case 0x5: {
        const { n, next } = lengthAt(at, nibble);
        need(next, n);
        return buf.toString("latin1", next, next + n);
      }
      case 0x6: {
        const { n, next } = lengthAt(at, nibble);
        need(next, n * 2);
        return Buffer.from(buf.subarray(next, next + n * 2)).swap16().toString("utf16le");
      }
      case 0x8:
        need(at + 1, nibble + 1);
        return uint(buf, at + 1, nibble + 1); // a keyed-archive UID: its number
      case 0xa:
      case 0xc: {
        const { n, next } = lengthAt(at, nibble);
        return refs(next, n).map(r => object(r, depth + 1));
      }
      case 0xd: {
        const { n, next } = lengthAt(at, nibble);
        const keys = refs(next, n), values = refs(next + n * refSize, n);
        const dict: PlistDict = {};
        for (let i = 0; i < n; i++) {
          const key = object(keys[i]!, depth + 1);
          if (typeof key !== "string") throw new Error("not a property list: a dictionary key isn't a string");
          put(dict, key, object(values[i]!, depth + 1));
        }
        return dict;
      }
    }
    throw new Error(`not a property list: unknown object type 0x${marker.toString(16)}`);
  };

  return object(top, 0);
}

/** A big-endian unsigned integer of 1–8 bytes (beyond 2^53 it loses precision, which no valid offset needs). */
function uint(buf: Buffer, at: number, size: number): number {
  if (at < 0 || at + size > buf.length) throw new Error("not a property list: read out of bounds");
  let n = 0;
  for (let i = 0; i < size; i++) n = n * 256 + buf[at + i]!;
  return n;
}
