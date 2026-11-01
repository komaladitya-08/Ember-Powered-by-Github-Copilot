// Gives the staged Ember.exe its own identity. electron.exe, renamed, still carries Electron's version resource and
// icon, so Task Manager (its Startup apps page too), Settings › Privacy › Microphone, the volume mixer and firewall
// prompts say "Electron" and "GitHub, Inc.". This rewrites the version strings and numbers and every icon group with
// resedit (pure JavaScript, so it is tested on Linux against a synthetic executable), and leaves out Electron's
// Authenticode certificate table: any change to the file voids that signature, and an unsigned binary is honest where
// one whose signature no longer matches (HashMismatch) looks like tampering to some endpoint protection.
// stage.mjs runs it before flipping the fuses, so the fuse wire is found and checked in the bytes that ship.
import * as ResEdit from "resedit";

/** RT_GROUP_ICON's language and the string table's language and code page when the executable has none (US English, UTF-16). */
const EN_US = { lang: 1033, codepage: 1200 };

/** Electron's main icon group (IDR_MAINFRAME), used only if the executable has no icon group at all. */
const MAIN_ICON_GROUP = 1;

/**
 * The four 16-bit numbers of a version resource's fixed part, from package.json's version:
 * "1.2.3" → [1, 2, 3, 0]; a pre-release or build suffix is dropped ("1.2.3-beta.4" → [1, 2, 3, 0]).
 * @param {string} version
 * @returns {[number, number, number, number]}
 */
export function numericVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:[-+][0-9A-Za-z.+-]*)?$/.exec(String(version));
  if (!m) throw new Error(`${JSON.stringify(version)} isn't a version a Windows executable can carry (major.minor.patch)`);
  const parts = /** @type {[number, number, number, number]} */ ([m[1], m[2], m[3], m[4] ?? "0"].map(Number));
  if (parts.some(n => n > 0xffff)) throw new Error(`${version}: each part of a Windows file version is at most 65535`);
  return parts;
}

/**
 * The version resource strings Ember.exe carries. Explorer's Details tab shows them, Task Manager and the privacy
 * pages show FileDescription, and CompanyName is the publisher. Electron's LegalCopyright stays: the code is Electron's.
 * @param {{ version: string; company: string; exe?: string }} o
 * @returns {Record<string, string>}
 */
export function exeVersionStrings(o) {
  const exe = o.exe ?? "Ember.exe";
  return {
    CompanyName: o.company,
    FileDescription: "Ember",
    FileVersion: o.version,
    InternalName: exe,
    OriginalFilename: exe,
    ProductName: "Ember",
    ProductVersion: o.version,
  };
}

/**
 * Where the certificate table is, from the PE headers (the security entry of the data directory holds a file offset,
 * not an address); `{ offset: 0, size: 0 }` when the file is unsigned. Throws on a file that isn't a PE image.
 * @param {Buffer} bin
 */
export function certificateTable(bin) {
  if (bin.length < 0x40 || bin.readUInt16LE(0) !== 0x5a4d) throw new Error("not a Windows executable (no MZ header)");
  const pe = bin.readUInt32LE(0x3c);
  if (pe + 24 > bin.length || bin.readUInt32LE(pe) !== 0x00004550) throw new Error("not a Windows executable (no PE header)");
  const magic = bin.readUInt16LE(pe + 24);
  // The optional header is 96 bytes before its data directory in PE32, 112 in PE32+; the security entry is the fifth.
  const directory = pe + 24 + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : NaN);
  if (Number.isNaN(directory)) throw new Error(`unknown optional header (magic 0x${magic.toString(16)})`);
  const entry = directory + 4 * 8;
  if (entry + 8 > bin.length) throw new Error("the PE headers run past the end of the file");
  return { offset: bin.readUInt32LE(entry), size: bin.readUInt32LE(entry + 4) };
}

/**
 * Ember's identity in an Electron executable: the version strings and numbers of every version resource, every icon
 * group replaced by the icons of `ico` (an .ico file, icon.mjs's), and no certificate table. Returns the new file;
 * `bin` is not changed. Sections after the resources move when they grow (the fuse wire, in .rdata, doesn't).
 * @param {Buffer} bin the executable
 * @param {{ version: string; company: string; ico: Buffer }} o
 * @returns {Buffer}
 */
export function rewriteExeResources(bin, o) {
  const [major, minor, patch, revision] = numericVersion(o.version);
  const strings = exeVersionStrings(o);
  const icons = ResEdit.Data.IconFile.from(o.ico).icons;
  if (!icons.length) throw new Error("the .ico holds no images");

  // ignoreCert: a signed executable is read without its certificate table, and generate() writes none.
  const exe = ResEdit.NtExecutable.from(bin, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);

  const infos = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (!infos.length) infos.push(ResEdit.Resource.VersionInfo.create(EN_US.lang, {}, []));
  for (const vi of infos) {
    // Set directly: setFileVersion would also write a "1.2.3.0" string, in a new table if the code page differs.
    Object.assign(vi.fixedInfo, {
      fileVersionMS: ((major << 16) | minor) >>> 0, fileVersionLS: ((patch << 16) | revision) >>> 0,
      productVersionMS: ((major << 16) | minor) >>> 0, productVersionLS: ((patch << 16) | revision) >>> 0,
    });
    const languages = vi.getAllLanguagesForStringValues();
    for (const language of languages.length ? languages : [EN_US]) vi.setStringValues(language, strings, true);
    vi.outputToResourceEntries(res.entries);
  }

  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const targets = groups.length ? groups.map(g => ({ id: g.id, lang: g.lang })) : [{ id: MAIN_ICON_GROUP, lang: EN_US.lang }];
  for (const g of targets) ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, g.id, g.lang, icons.map(i => i.data));

  res.outputResource(exe);
  return Buffer.from(exe.generate());
}

/**
 * What an executable's resources say: each version resource (its numbers and every string table) and each icon group
 * (its images' sizes), and whether it has a certificate table. For stage.mjs's read-back and the tests.
 * @param {Buffer} bin
 */
export function readExeResources(bin) {
  const signed = certificateTable(bin).size > 0;
  const exe = ResEdit.NtExecutable.from(bin, { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const four = (ms, ls) => [ms >>> 16, ms & 0xffff, ls >>> 16, ls & 0xffff];
  return {
    signed,
    versions: ResEdit.Resource.VersionInfo.fromEntries(res.entries).map(vi => ({
      lang: vi.lang,
      fileVersion: four(vi.fixedInfo.fileVersionMS, vi.fixedInfo.fileVersionLS),
      productVersion: four(vi.fixedInfo.productVersionMS, vi.fixedInfo.productVersionLS),
      strings: vi.getAllLanguagesForStringValues().map(l => ({ lang: l.lang, codepage: l.codepage, values: vi.getStringValues(l) })),
    })),
    iconGroups: ResEdit.Resource.IconGroupEntry.fromEntries(res.entries).map(g => ({
      id: g.id, lang: g.lang,
      icons: g.icons.map(i => ({ width: i.width || 256, height: i.height || 256, bitCount: i.bitCount, dataSize: i.dataSize })),
    })),
  };
}

/**
 * How `read` (readExeResources) differs from Ember's identity, one line each; empty when it matches. `ico` is the
 * icon file that was written in: every icon group must hold exactly its images.
 * @param {ReturnType<typeof readExeResources>} read
 * @param {{ version: string; company: string; ico: Buffer }} o
 * @returns {string[]}
 */
export function exeResourceMismatches(read, o) {
  const problems = [];
  if (read.signed) problems.push("it still has a certificate table (a signature the changes voided)");
  const want = exeVersionStrings(o);
  const numbers = numericVersion(o.version).join(".");
  if (!read.versions.length) problems.push("it has no version resource");
  for (const v of read.versions) {
    if (v.fileVersion.join(".") !== numbers) problems.push(`file version ${v.fileVersion.join(".")}, should be ${numbers}`);
    if (v.productVersion.join(".") !== numbers) problems.push(`product version ${v.productVersion.join(".")}, should be ${numbers}`);
    if (!v.strings.length) problems.push("its version resource has no strings");
    for (const t of v.strings) {
      for (const [key, value] of Object.entries(want)) {
        if (t.values[key] !== value) problems.push(`${key} (language ${t.lang}) is ${JSON.stringify(t.values[key] ?? null)}, should be ${JSON.stringify(value)}`);
      }
    }
  }
  const icons = ResEdit.Data.IconFile.from(o.ico).icons
    .map(i => `${i.width || 256}x${i.height || 256}/${i.bitCount}/${i.data.isIcon() ? i.data.generate().byteLength : i.data.bin.byteLength}`);
  if (!read.iconGroups.length) problems.push("it has no icon group");
  for (const g of read.iconGroups) {
    const got = g.icons.map(i => `${i.width}x${i.height}/${i.bitCount}/${i.dataSize}`);
    if (got.join(" ") !== icons.join(" ")) problems.push(`icon group ${g.id} holds ${got.join(" ") || "nothing"}, should hold ${icons.join(" ")}`);
  }
  return problems;
}
