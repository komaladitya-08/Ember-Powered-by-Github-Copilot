// Keep authenticated development coding resources out of Electron's initial release copy, with or without the toolchain flag.
import fs from "node:fs";
import path from "node:path";
import { verifyWindowsNodeToolchain } from "./windows-node-toolchain.mjs";

const refused = () => new Error("The development Windows coding resources could not be separated for packaging.");
const sameDirectory = (a, b) => a && b && a.dev === b.dev && a.ino === b.ino && b.isDirectory() && !b.isSymbolicLink();
const sameClock = (a, b) => sameDirectory(a, b) && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const absolute = value => {
  if (typeof value !== "string" || !path.isAbsolute(value) || path.normalize(value) !== value || /[\p{Cc}\p{Cf}]/u.test(value)) throw refused();
  return value;
};
function directory(file) {
  let value;
  try { value = fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (!value.isDirectory() || value.isSymbolicLink()) throw refused();
  return value;
}
function exactCase(parent, name) {
  const aliases = fs.readdirSync(parent).filter(value => value.toLowerCase() === name.toLowerCase());
  if (aliases.length > 1 || aliases.some(value => value !== name)) throw refused();
}

/** Only the fixed known coding container may be omitted. This grants no authority to its development bytes. */
export function prepareWindowsNodeElectronCopyFilter(source) {
  try {
    absolute(source);
    const root = directory(source); if (!root) throw refused();
    exactCase(source, "resources");
    const resources = path.join(source, "resources"), resourceRoot = directory(resources);
    if (resourceRoot) exactCase(resources, "coding");
    const coding = path.join(resources, "coding"), codingRoot = resourceRoot && directory(coding);
    const wanted = codingRoot ? fs.readdirSync(coding).sort() : [];
    if (wanted.length > 1 || wanted.length === 1 && wanted[0] !== "windows-node-x64") throw refused();
    const payload = path.join(coding, "windows-node-x64"), payloadRoot = wanted.length && directory(payload);
    const check = () => {
      if (!sameDirectory(root, directory(source))) throw refused();
      exactCase(source, "resources");
      if (!sameDirectory(resourceRoot, directory(resources))) throw refused();
      exactCase(resources, "coding");
      const before = directory(coding);
      if (!sameClock(codingRoot, before) || JSON.stringify(fs.readdirSync(coding).sort()) !== JSON.stringify(wanted)) throw refused();
      if (wanted.length) {
        const beforePayload = directory(payload);
        if (!sameClock(payloadRoot, beforePayload)) throw refused();
        verifyWindowsNodeToolchain(payload, "package");
        if (!sameClock(beforePayload, directory(payload))) throw refused();
      }
      if (!sameClock(before, directory(coding)) || JSON.stringify(fs.readdirSync(coding).sort()) !== JSON.stringify(wanted)) throw refused();
    };
    if (codingRoot) check();
    return selected => {
      try {
        absolute(selected);
        const relative = path.relative(source, selected).split(path.sep).join("/"), folded = relative.toLowerCase();
        if (relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) throw refused();
        if (folded === "resources") {
          if (relative !== "resources" || !sameDirectory(resourceRoot, directory(resources))) throw refused();
          exactCase(resources, "coding");
        }
        if (folded === "resources/coding") {
          if (relative !== "resources/coding" || !codingRoot) throw refused();
          check();
          return false;
        }
        if (folded.startsWith("resources/coding/")) throw refused();
        return true;
      } catch { throw refused(); }
    };
  } catch { throw refused(); }
}
