/** Explicit native-dialog exports of the displayed project output, without adding automatic retention. */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ProjectInputError } from "./project";

/** Stage privately, recheck the destination, then replace atomically. Never follow a link or clobber concurrent edits. */
export function exportProjectText(destination: string, text: string, privateDir: string, current: () => boolean, protectedFiles: readonly string[] = []): void {
  if (!path.isAbsolute(destination) || !text || text.length > 48_000) throw new ProjectInputError("Choose an available project output to export.");
  const parent = fs.realpathSync.native(path.dirname(destination));
  const target = path.join(parent, path.basename(destination));
  if (protectedFiles.some(file => {
    try { return path.relative(fs.realpathSync.native(file), target) === ""; }
    catch { return path.relative(path.resolve(file), target) === ""; }
  })) throw new ProjectInputError("Export to a different file. Selected project files are changed only by an approved patch.");
  const relative = path.relative(fs.realpathSync.native(privateDir), target);
  if (!relative || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) {
    throw new ProjectInputError("Export outside Ember’s data folder.");
  }
  const snapshot = () => {
    try { return fs.lstatSync(target); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return null; throw err; }
  };
  const before = snapshot();
  if (before && (!before.isFile() || before.nlink !== 1)) throw new ProjectInputError("Choose a regular file without links as the export destination.");
  const check = () => {
    if (!current()) throw new ProjectInputError("Project export cancelled.");
    const live = snapshot();
    if (before ? !live || !live.isFile() || live.nlink !== 1 || live.dev !== before.dev || live.ino !== before.ino ||
      live.size !== before.size || live.mtimeMs !== before.mtimeMs || live.ctimeMs !== before.ctimeMs : live !== null) {
      throw new ProjectInputError("The export destination changed. Export again to review the destination.");
    }
  };
  const temporary = path.join(parent, ".ember-export-" + crypto.randomUUID());
  try {
    check();
    fs.writeFileSync(temporary, text, { flag: "wx", mode: 0o600, flush: true });
    check();
    fs.renameSync(temporary, target);
  } finally {
    try { fs.unlinkSync(temporary); } catch { /* renamed or never staged */ }
  }
}
