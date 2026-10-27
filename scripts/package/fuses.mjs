// Electron's fuses: switches compiled into the binary that turn features off for good, whatever the command line or
// the environment say. stage.mjs flips them in the staged binary (layout.mjs's fuseFile: "ember" on Linux, Ember.exe
// on Windows, the Electron Framework binary inside Ember.app on macOS); CI reads them back.
// The wire, as Electron builds it (build/fuses/fuses.json5) and @electron/fuses writes it: the sentinel below, a
// version byte (1), a length byte, then one byte per fuse: "0" off, "1" on, "r" removed. The order (version 1)
// is fixed: a new fuse is only ever appended. A universal (fat) macOS binary holds one wire per architecture; Ember
// stages one architecture per build, so it is refused rather than half flipped.
// usage: node scripts/package/fuses.mjs <electron binary>            prints every fuse
//        node scripts/package/fuses.mjs --check <electron binary>    exits 1 unless EMBER_FUSES are set
import fs from "node:fs";
import { fileURLToPath } from "node:url";

export const SENTINEL = "dL7pKGdnNz796PbbjQWNKmHXBZaB9tsX";
const SENTINEL_BYTES = Buffer.from(SENTINEL, "latin1");
export const WIRE_VERSION = 1;
/** Version 1 of the wire, in order (@electron/fuses' FuseV1Options). */
export const FUSES = [
  "RunAsNode",
  "EnableCookieEncryption",
  "EnableNodeOptionsEnvironmentVariable",
  "EnableNodeCliInspectArguments",
  "EnableEmbeddedAsarIntegrityValidation",
  "OnlyLoadAppFromAsar",
  "LoadBrowserProcessSpecificV8Snapshot",
  "GrantFileProtocolExtraPrivileges",
  "WasmTrapHandlers",
];
const OFF = 0x30, ON = 0x31, REMOVED = 0x72;

/**
 * What the installed Ember needs. No debugger and no code injected through the environment: the app ignores
 * --inspect* and NODE_OPTIONS. RunAsNode stays on: Ember runs helpers with its own binary as plain Node
 * (ELECTRON_RUN_AS_NODE): the desk helper on Linux (app/main/desk/agent.ts) and the accessibility host
 * (dist/app/ax-sidecar.cjs) on Windows and macOS. In that mode Node's own --inspect still works, which gives
 * whoever starts it nothing beyond running the binary themselves (the running Ember is unaffected).
 * (main.ts also refuses --remote-debugging-* and --inspect* in a packaged build.)
 */
export const EMBER_FUSES = {
  RunAsNode: true,
  EnableNodeOptionsEnvironmentVariable: false,
  EnableNodeCliInspectArguments: false,
};

/**
 * How many architectures a universal (fat) Mach-O binary holds; 0 for any other file. The fat header is big-endian:
 * the magic (0xcafebabe, or 0xcafebabf for 64-bit offsets), then the slice count. Java class files share the magic,
 * but their next word (the class file version, 45 or more) is far beyond any real slice count.
 */
export function fatArchCount(bin) {
  if (bin.length < 8) return 0;
  const magic = bin.readUInt32BE(0);
  if (magic !== 0xcafebabe && magic !== 0xcafebabf) return 0;
  const count = bin.readUInt32BE(4);
  return count > 0 && count < 32 ? count : 0;
}

/** Where the fuse wire is in `bin`: the position of its first fuse byte and how many there are. */
export function findWire(bin) {
  const slices = fatArchCount(bin);
  if (slices) throw new Error(`a universal binary (${slices} architectures, one fuse wire each): stage one architecture per build`);
  const at = bin.indexOf(SENTINEL_BYTES);
  if (at < 0) throw new Error("no fuse wire in this binary (is it Electron 12 or later?)");
  if (bin.indexOf(SENTINEL_BYTES, at + 1) >= 0) throw new Error("more than one fuse wire in this binary");
  const version = bin[at + SENTINEL_BYTES.length], length = bin[at + SENTINEL_BYTES.length + 1];
  if (version !== WIRE_VERSION) throw new Error(`fuse wire version ${version}; this script knows version ${WIRE_VERSION}`);
  const start = at + SENTINEL_BYTES.length + 2;
  if (start + length > bin.length) throw new Error("the fuse wire runs past the end of the binary");
  return { start, length };
}

/** Every fuse in the wire: true (on), false (off) or "removed". A fuse newer than this script is named by its index. */
export function readFuses(bin) {
  const { start, length } = findWire(bin);
  const fuses = {};
  for (let i = 0; i < length; i++) {
    const b = bin[start + i];
    fuses[FUSES[i] ?? `fuse${i}`] = b === ON ? true : b === OFF ? false : b === REMOVED ? "removed" : `unknown (0x${b.toString(16)})`;
  }
  return fuses;
}

/**
 * Sets the fuses named in `config` ({ name: boolean }) in `bin` (a Buffer, changed in place).
 * Refuses (changing nothing) an unknown name, a fuse the wire is too short for, or one that was removed.
 */
export function setFuses(bin, config) {
  const { start, length } = findWire(bin);
  const writes = Object.entries(config).map(([name, on]) => {
    const i = FUSES.indexOf(name);
    if (i < 0) throw new Error(`no fuse named ${name}`);
    if (i >= length) throw new Error(`this Electron has no ${name} fuse (its wire has ${length})`);
    if (typeof on !== "boolean") throw new Error(`${name} must be true or false`);
    const b = bin[start + i];
    if (b !== ON && b !== OFF) throw new Error(`${name} can't be set: it is ${b === REMOVED ? "removed" : `0x${b.toString(16)}`} in this binary`);
    return [start + i, on ? ON : OFF];
  });
  for (const [at, v] of writes) bin[at] = v;
  return readFuses(bin);
}

/** The fuses in `config` that `fuses` (from readFuses) doesn't match, as "name: is X, should be Y". */
export function fuseMismatches(fuses, config) {
  return Object.entries(config).filter(([name, on]) => fuses[name] !== on)
    .map(([name, on]) => `${name}: is ${fuses[name] === undefined ? "missing" : fuses[name] === true ? "on" : fuses[name] === false ? "off" : fuses[name]}, should be ${on ? "on" : "off"}`);
}

/** Flips the fuses in `config` in the binary at `file`; returns every fuse as it now is. */
export function flipFuses(file, config) {
  const bin = fs.readFileSync(file);
  const { start, length } = findWire(bin);
  const fuses = setFuses(bin, config);
  // Only the wire's bytes are written back; the file keeps its mode.
  const fd = fs.openSync(file, "r+");
  try { fs.writeSync(fd, bin, start, length, start); } finally { fs.closeSync(fd); }
  return fuses;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const file = args.find(a => !a.startsWith("--"));
  if (!file) { console.error("usage: node scripts/package/fuses.mjs [--check] <electron binary>"); process.exit(2); }
  const fuses = readFuses(fs.readFileSync(file));
  for (const [name, v] of Object.entries(fuses)) console.log(`${name.padEnd(40)} ${v === true ? "on" : v === false ? "off" : v}`);
  const wrong = check ? fuseMismatches(fuses, EMBER_FUSES) : [];
  if (wrong.length) { console.error(`${file}: fuses not as Ember ships them:\n  ${wrong.join("\n  ")}`); process.exit(1); }
}
