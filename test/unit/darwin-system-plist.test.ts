/**
 * The macOS app catalogue's property-list reader, on fixtures: binary lists written by Python's plistlib
 * (FMT_BINARY, including one big enough for two-byte offsets and references), XML lists (Apple's layout, a UTF-16
 * file and a hand-written one with entities, CDATA and comments), and malformed input built here, which must throw
 * rather than loop, recurse without bound or read outside the buffer.
 */

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isPlistDict, parsePlist, type PlistValue } from "../../app/main/platform/darwin/system/plist";

const DIR = join(__dirname, "../fixtures/plist");

/** Buffers and dates as the expected JSON files write them. */
function plain(v: PlistValue): unknown {
  if (Buffer.isBuffer(v)) return { $data: v.toString("base64") };
  if (v instanceof Date) return { $date: v.toISOString().replace(".000Z", "Z") };
  if (Array.isArray(v)) return v.map(plain);
  if (isPlistDict(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)]));
  return v;
}

/** A binary plist from raw object bytes: `objects[i]` is object i; refs and offsets are one byte. */
function bplist(objects: number[][], top = 0): Buffer {
  const head = Buffer.from("bplist00", "latin1");
  const offsets: number[] = [];
  let at = 8;
  for (const o of objects) {
    offsets.push(at);
    at += o.length;
  }
  const body = Buffer.from(objects.flat());
  const table = Buffer.from(offsets);
  const trailer = Buffer.alloc(32);
  trailer[6] = 1;
  trailer[7] = 1;
  trailer.writeBigUInt64BE(BigInt(objects.length), 8);
  trailer.writeBigUInt64BE(BigInt(top), 16);
  trailer.writeBigUInt64BE(BigInt(at), 24);
  return Buffer.concat([head, body, table, trailer]);
}

describe("parsePlist", () => {
  const fixtures = readdirSync(DIR).filter(f => /\.(bplist|plist)$/.test(f));

  it("has a fixture of each form to read", () => {
    expect(fixtures).toEqual(expect.arrayContaining(["textedit.bplist", "finder.plist", "large.bplist", "unicode-utf16.plist", "entities.plist"]));
  });

  for (const f of fixtures) {
    it(`reads ${f} exactly as plistlib wrote it`, () => {
      const expected = JSON.parse(readFileSync(join(DIR, f.replace(/\.(bplist|plist)$/, ".expected.json")), "utf8"));
      expect(plain(parsePlist(readFileSync(join(DIR, f))))).toEqual(expected);
    });
  }

  it("reads the same dictionary from its binary and its UTF-16 XML form", () => {
    expect(parsePlist(readFileSync(join(DIR, "unicode.bplist")))).toEqual(parsePlist(readFileSync(join(DIR, "unicode-utf16.plist"))));
  });

  it("keeps a \"__proto__\" key as a key, never as the object's prototype", () => {
    const d = parsePlist(readFileSync(join(DIR, "entities.plist")));
    expect(isPlistDict(d)).toBe(true);
    expect(Object.getPrototypeOf(d)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(d, "__proto__")).toBe(true);
    expect((d as Record<string, unknown>)["__proto__"]).toBe("stays a key");
  });

  it("reads a bare value without the <plist> wrapper, and an empty <plist/> as null", () => {
    expect(parsePlist(Buffer.from("<dict><key>a</key><string>b</string></dict>"))).toEqual({ a: "b" });
    expect(parsePlist(Buffer.from("<?xml version=\"1.0\"?><plist version=\"1.0\"/>"))).toBeNull();
  });

  it("decodes shared references once, so a list that reuses objects can't make the work grow", () => {
    // Object i (i < 40) is an array holding object i+1 twice: 2^40 paths, 41 objects.
    const objects: number[][] = [];
    for (let i = 0; i < 40; i++) objects.push([0xa2, i + 1, i + 1]);
    objects.push([0x51, 0x78]); // "x"
    const started = Date.now();
    let v = parsePlist(bplist(objects));
    expect(Date.now() - started).toBeLessThan(1000);
    for (let i = 0; i < 40; i++) {
      expect(Array.isArray(v) && v.length === 2 && v[0] === v[1]).toBe(true);
      v = (v as PlistValue[])[0]!;
    }
    expect(v).toBe("x");
  });

  it("reads integers of every width, signed at eight bytes, and both kinds of string", () => {
    const objects = [
      [0xa6, 1, 2, 3, 4, 5, 6],
      [0x10, 0xff],
      [0x11, 0x01, 0x00],
      [0x12, 0x00, 0x01, 0x00, 0x00],
      [0x13, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xfe],
      [0x53, 0x61, 0x62, 0x63],
      [0x62, 0x00, 0xe9, 0xd8, 0x3d],
    ];
    // The last string is two UTF-16 units: é and a lone high surrogate (decoded, not rejected).
    const v = parsePlist(bplist(objects)) as PlistValue[];
    expect(v.slice(0, 5)).toEqual([255, 256, 65536, -2, "abc"]);
    expect((v[5] as string).charCodeAt(0)).toBe(0xe9);
  });

  describe("on malformed input", () => {
    it("throws for an object that contains itself", () => {
      expect(() => parsePlist(bplist([[0xa1, 0x00]]))).toThrow(/contains itself/);
    });

    it("throws for a reference past the last object and an offset past the object area", () => {
      expect(() => parsePlist(bplist([[0xa1, 0x05]]))).toThrow(/reference/);
      const buf = bplist([[0x51, 0x61]]);
      buf[buf.length - 32 - 1] = 200; // object 0's offset points beyond the object area
      expect(() => parsePlist(buf)).toThrow(/out of bounds/);
    });

    it("throws for a string longer than the object area", () => {
      expect(() => parsePlist(bplist([[0x5f, 0x10, 0x7f, 0x61]]))).toThrow(/out of bounds/);
    });

    it("throws for a dictionary key that isn't a string, and for an unknown object type", () => {
      expect(() => parsePlist(bplist([[0xd1, 1, 2], [0x10, 1], [0x10, 2]]))).toThrow(/key/);
      expect(() => parsePlist(bplist([[0x70]]))).toThrow(/unknown object type/);
    });

    it("throws for a truncated binary list and a bad trailer", () => {
      const good = readFileSync(join(DIR, "textedit.bplist"));
      expect(() => parsePlist(good.subarray(0, good.length - 40))).toThrow();
      const bad = Buffer.from(good);
      bad.writeBigUInt64BE(BigInt(good.length * 2), bad.length - 8);
      expect(() => parsePlist(bad)).toThrow(/trailer/);
      expect(() => parsePlist(Buffer.from("bplist00"))).toThrow(/too short/);
    });

    it("throws for nesting deeper than any Info.plist has, in both forms", () => {
      const xml = "<plist>" + "<array>".repeat(100) + "</array>".repeat(100) + "</plist>";
      expect(() => parsePlist(Buffer.from(xml))).toThrow(/deeply/);
      const objects: number[][] = [];
      for (let i = 0; i < 100; i++) objects.push([0xa1, i + 1]);
      objects.push([0x08]);
      expect(() => parsePlist(bplist(objects))).toThrow(/deeply/);
    });

    it("throws for XML that isn't a property list", () => {
      for (const text of ["", "hello", "<plist><dict><key>a</key>", "<plist><dict><string>no key</string></dict></plist>",
        "<plist><integer>twelve</integer></plist>", "<plist><blink>x</blink></plist>", "<plist><date>yesterday</date></plist>",
        "<plist><string>a</plist>"]) {
        expect(() => parsePlist(Buffer.from(text)), text).toThrow(/not a property list/);
      }
    });

    it("reads a tag padded with a long run of spaces in linear time (the catalogue parses on the main thread)", () => {
      const pad = " ".repeat(200_000);
      const started = Date.now();
      expect(parsePlist(Buffer.from(`<plist${pad}version="1.0"><dict${pad}><key${pad}>a</key${pad}><true${pad}/></dict></plist>`))).toEqual({ a: true });
      expect(() => parsePlist(Buffer.from(`<plist><dict><key${pad}x></key></dict></plist>`))).toThrow(/not a property list/);
      // Quadratic backtracking takes minutes here; linear parsing a few milliseconds.
      expect(Date.now() - started).toBeLessThan(2000);
    });
  });
});
