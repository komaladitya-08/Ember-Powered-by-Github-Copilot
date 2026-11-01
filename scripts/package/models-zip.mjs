// Zips the staged speech models (dist/package/voice-models, what stage.mjs trims and verifies) as
// Ember-voice-models-<version>.zip, for computers that can't download them (network-restricted PCs): IT unzips it
// into the folder Ember looks in before downloading anything — %ProgramData%\Ember on Windows, /Library/Application
// Support/Ember on macOS (both then hold voice-models\), or /usr/share/ember on Linux without the RPM. The archive's
// top folder is voice-models/, holding each model and its SHA-256 marker, so Ember uses it as it is.
// Plain Node (deflate from zlib), so no zip program is needed where packages are built.
//   usage: node scripts/package/models-zip.mjs <staged voice-models folder> <out.zip>
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/** Every file under `dir`, as POSIX paths relative to it, sorted (the same archive from the same files). */
function files(dir, rel = "") {
  return fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e => {
    const r = rel ? `${rel}/${e.name}` : e.name;
    return e.isDirectory() ? files(dir, r) : e.isFile() ? [r] : [];
  });
}

/** Writes a zip of `dir`'s files under `top/`; returns how many entries. Fails past zip's 4 GB and 65535-entry limits. */
export function zipFolder(dir, out, top = "voice-models") {
  const entries = files(dir);
  if (entries.length > 0xffff) throw new Error("too many files for a zip without zip64");
  const fd = fs.openSync(out, "w");
  const central = [];
  let at = 0;
  const write = b => { fs.writeSync(fd, b); at += b.length; };
  // 1980-01-01 00:00 in DOS time: the archive doesn't depend on when it was made.
  const dosTime = 0, dosDate = (0 << 9) | (1 << 5) | 1;
  try {
    for (const rel of entries) {
      const name = Buffer.from(`${top}/${rel}`, "utf8");
      const data = fs.readFileSync(path.join(dir, rel));
      const packed = zlib.deflateRawSync(data, { level: 6 });
      const stored = packed.length >= data.length;
      const body = stored ? data : packed;
      if (at + body.length > 0xffffffff || data.length > 0xffffffff) throw new Error("the models are too large for a zip without zip64");
      const crc = zlib.crc32(data) >>> 0;
      const local = Buffer.alloc(30);
      local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(stored ? 0 : 8, 8);
      local.writeUInt16LE(dosTime, 10); local.writeUInt16LE(dosDate, 12); local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26); local.writeUInt16LE(0, 28);
      const offset = at;
      write(local); write(name); write(body);
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(stored ? 0 : 8, 10);
      c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(body.length, 20); c.writeUInt32LE(data.length, 24);
      c.writeUInt16LE(name.length, 28); c.writeUInt32LE(offset, 42);
      central.push(Buffer.concat([c, name]));
    }
    const start = at;
    for (const c of central) write(c);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
    end.writeUInt32LE(at - start, 12); end.writeUInt32LE(start, 16);
    write(end);
  } finally {
    fs.closeSync(fd);
  }
  return entries.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const [dir, out] = process.argv.slice(2);
  if (!dir || !out) { console.error("usage: node scripts/package/models-zip.mjs <staged voice-models folder> <out.zip>"); process.exit(2); }
  if (!fs.readdirSync(dir).some(f => f.endsWith(".ok"))) { console.error(`${dir} holds no verified models (stage them with node scripts/voice/prepare.mjs, then stage.mjs)`); process.exit(1); }
  const n = zipFolder(dir, out);
  console.log(`${out}: ${n} files, ${(fs.statSync(out).size / 1e6).toFixed(0)} MB`);
}
