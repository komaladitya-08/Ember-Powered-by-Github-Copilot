/** Bounded PE import evidence for the fixed local-delegate control. Import names/addresses are never returned. */
import { windowsUvSpawnImageFingerprint, buildPin } from "./build-windows-uv-spawn-probe.mjs";
import { abiPin } from "./windows-uv-observer-abi-pin.mjs";
import { abiHash } from "./windows-uv-observer-abi-files.mjs";
const forbidden = new Set(["createnamedpipea", "createfilea", "connectnamedpipe", "createiocompletionport", "createprocessw"]);
const fail = () => { throw new Error("The fixed observer ABI image was refused."); };

/** Ordinary AMD64 COFF machine-code input only; anonymous/LTCG/bigobj inputs are outside this fixed control. No code or symbols are decoded. */
export function inspectWindowsUvObserverAbiObject(bytes) {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 60 || bytes.length > abiPin.maximumObjectBytes || bytes.readUInt16LE(0) !== 0x8664 || bytes.readUInt16LE(16) !== 0) fail();
    const sections = bytes.readUInt16LE(2), symbols = bytes.readUInt32LE(12), symbolTable = bytes.readUInt32LE(8);
    if (sections < 1 || sections > 96 || 20 + sections * 40 > bytes.length || symbols > 32768 || !symbolTable || symbolTable + symbols * 18 + 4 > bytes.length) fail();
    const strings = symbolTable + symbols * 18, stringBytes = bytes.readUInt32LE(strings);
    if (stringBytes < 4 || strings + stringBytes > bytes.length) fail();
    let executable = 0;
    for (let index = 0; index < sections; index++) {
      const item = 20 + index * 40, length = bytes.readUInt32LE(item + 16), offset = bytes.readUInt32LE(item + 20),
        relocations = bytes.readUInt32LE(item + 24), relocationCount = bytes.readUInt16LE(item + 32), flags = bytes.readUInt32LE(item + 36);
      if (length && (offset < 20 + sections * 40 || offset + length > bytes.length) || relocationCount === 0xffff ||
          relocationCount && (!relocations || relocations + relocationCount * 10 > bytes.length) || flags & 0x01000000) fail();
      if (flags & 0x20000000) { if (!length) fail(); executable++; }
    }
    if (!executable) fail();
    return Object.freeze({ bytes: bytes.length, sha256: abiHash(bytes) });
  } catch { fail(); }
}

export function inspectWindowsUvObserverAbiImage(bytes) {
  try {
    const fingerprint = windowsUvSpawnImageFingerprint(bytes, buildPin.maximumExecutableBytes);
    const pe = bytes.readUInt32LE(0x3c), optional = pe + 24, optionalBytes = bytes.readUInt16LE(pe + 20);
    if (optionalBytes !== 240 || bytes.readUInt32LE(optional + 108) !== 16) fail();
    const directory = index => [bytes.readUInt32LE(optional + 112 + index * 8), bytes.readUInt32LE(optional + 116 + index * 8)];
    const delayed = directory(13); if (delayed[0] || delayed[1]) fail();
    const sections = [], sectionStart = optional + optionalBytes, headers = bytes.readUInt32LE(optional + 60);
    for (let index = 0; index < bytes.readUInt16LE(pe + 6); index++) {
      const offset = sectionStart + index * 40;
      sections.push({ rva: bytes.readUInt32LE(offset + 12), length: bytes.readUInt32LE(offset + 16), offset: bytes.readUInt32LE(offset + 20) });
    }
    const at = (rva, length) => {
      if (!Number.isSafeInteger(rva) || rva < 1 || !Number.isSafeInteger(length) || length < 1 || length > bytes.length) fail();
      if (rva < headers && rva + length <= headers && rva + length <= bytes.length) return rva;
      const matches = sections.filter(section => rva >= section.rva && rva - section.rva <= section.length - length);
      if (matches.length !== 1) fail();
      const result = matches[0].offset + rva - matches[0].rva;
      if (result < headers || result + length > bytes.length) fail();
      return result;
    };
    const string = (rva, maximum) => {
      let value = "";
      for (let index = 0; index <= maximum; index++) {
        const code = bytes[at(rva + index, 1)];
        if (code === 0) { if (!index) fail(); return value; }
        if (index === maximum || code < 33 || code > 126) fail();
        value += String.fromCharCode(code);
      }
      fail();
    };
    const [imports, importBytes] = directory(1);
    if (!imports || importBytes < 20 || importBytes > 64 * 1024) fail();
    at(imports, importBytes);
    let modules = 0, symbols = 0, complete = false;
    for (let index = 0; index <= abiPin.maximumImportModules; index++) {
      if ((index + 1) * 20 > importBytes) fail();
      const offset = at(imports + index * 20, 20), fields = Array.from({ length: 5 }, (_, field) => bytes.readUInt32LE(offset + field * 4));
      if (fields.every(value => value === 0)) { complete = true; break; }
      if (index === abiPin.maximumImportModules || !fields[3] || !fields[4]) fail();
      const dll = string(fields[3], 128);
      if (!/^[A-Za-z0-9_.-]+\.dll$/i.test(dll)) fail();
      modules++;
      let ended = false;
      const thunk = fields[0] || fields[4];
      for (let item = 0; item <= abiPin.maximumImports; item++) {
        const entry = bytes.readBigUInt64LE(at(thunk + item * 8, 8));
        if (entry === 0n) { ended = true; break; }
        if (entry & 0x8000000000000000n || entry > 0xffffffffn || ++symbols > abiPin.maximumImports) fail();
        const nameRva = Number(entry); at(nameRva, 2);
        const name = string(nameRva + 2, 256);
        if (!/^[_A-Za-z][_A-Za-z0-9]*$/.test(name) || forbidden.has(name.toLowerCase()) || forbidden.has(name.toLowerCase().replace(/^__imp_/, ""))) fail();
      }
      if (!ended) fail();
    }
    if (!complete || !modules || !symbols) fail();
    return Object.freeze({ ...fingerprint, importModules: modules, namedImports: symbols, forbiddenImports: 0, ordinalImports: 0, delayImports: 0 });
  } catch { fail(); }
}
