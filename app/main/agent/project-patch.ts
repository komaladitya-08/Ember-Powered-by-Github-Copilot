/** Applies one exact, reviewed text diff to an existing selected file. No shell or model tool is involved. */
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { ProjectInputError, type ProjectSource } from "./project";
import { memoryRefusal } from "../memory/guard";

export interface ProjectPatch { source: ProjectSource; diff: string; output: string }

const RANGE = /^@@ -(\d{1,6})(?:,(\d{1,6}))? \+(\d{1,6})(?:,(\d{1,6}))? @@$/;

/** Only exact unified hunks for one selected file qualify for the Apply button. */
export function draftProjectPatch(answer: string, sources: ProjectSource[]): ProjectPatch | null {
  if (answer.length > 24_000 || /[\p{Cf}\p{Cc}]/u.test(answer.replace(/[\n\r\t]/g, ""))) return null;
  const blocks = [...answer.replace(/\r\n/g, "\n").matchAll(/(?:^|\n)\x60\x60\x60diff\n([\s\S]*?)\n\x60\x60\x60(?=\n|$)/g)];
  if (blocks.length !== 1) return null;
  const diff = blocks[0][1];
  if (diff.includes("\r")) return null;
  const [oldPath, newPath, ...hunks] = diff.split("\n");
  const source = sources.find(s => oldPath === "--- a/" + s.name && newPath === "+++ b/" + s.name);
  // shortcut: exact LF or CRLF patches only, add no-newline markers when drafts need that format.
  if (!source || !hunks.length || !source.text.endsWith("\n")) return null;
  const eol = source.text.includes("\r\n") ? "\r\n" : "\n";
  const normalized = source.text.replace(/\r\n/g, "\n");
  if (normalized.includes("\r") || (eol === "\r\n" && source.text.replace(/\r\n/g, "").includes("\n"))) return null;
  const original = normalized.slice(0, -1).split("\n");
  const result: string[] = [];
  let cursor = 0;
  for (let i = 0; i < hunks.length;) {
    const range = RANGE.exec(hunks[i++]);
    if (!range) return null;
    const oldCount = Number(range[2] ?? 1), newCount = Number(range[4] ?? 1);
    const oldStart = Number(range[1]) - (oldCount ? 1 : 0);
    const newStart = Number(range[3]) - (newCount ? 1 : 0);
    if (oldStart < cursor || oldStart > original.length || newStart !== result.length + oldStart - cursor) return null;
    result.push(...original.slice(cursor, oldStart));
    cursor = oldStart;
    let read = 0, written = 0;
    while (i < hunks.length && !hunks[i].startsWith("@@")) {
      const line = hunks[i++];
      const mark = line[0], body = line.slice(1);
      if (mark !== " " && mark !== "-" && mark !== "+") return null;
      if (mark !== "+") {
        if (original[cursor++] !== body) return null;
        read++;
      }
      if (mark !== "-") {
        result.push(body);
        written++;
      }
    }
    if (read !== oldCount || written !== newCount) return null;
  }
  result.push(...original.slice(cursor));
  const output = result.length ? result.join(eol) + eol : "";
  if (output === source.text || Buffer.byteLength(output) > 24 * 1024 || memoryRefusal(output)) return null;
  return { source, diff, output };
}

/** Rechecks the snapshot after confirmation and commits a same-directory atomic replacement. */
export function applyProjectPatch(patch: ProjectPatch, signal: AbortSignal, record: () => void): void {
  const { source, output } = patch;
  const { file, stat, digest } = source;
  const temporary = path.join(path.dirname(file), ".ember-patch-" + crypto.randomUUID());
  const check = () => {
    signal.throwIfAborted();
    const changed = () => new ProjectInputError("The selected file changed or cannot be replaced safely. Draft the patch again.");
    const same = (live: fs.Stats) => live.isFile() && live.nlink === 1 && live.mode === stat.mode && (live.mode & 0o7000) === 0 &&
      live.uid === stat.uid && live.gid === stat.gid && live.dev === stat.dev && live.ino === stat.ino &&
      live.size === stat.size && live.mtimeMs === stat.mtimeMs && live.ctimeMs === stat.ctimeMs;
    if (!same(fs.lstatSync(file)) || path.relative(file, fs.realpathSync(file)) !== "") throw changed();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    try {
      if (!same(fs.fstatSync(fd))) throw changed();
      const bytes = Buffer.alloc(stat.size + 1);
      const count = fs.readSync(fd, bytes);
      if (count !== stat.size || crypto.createHash("sha256").update(bytes.subarray(0, count)).digest("hex") !== digest ||
          !same(fs.fstatSync(fd)) || !same(fs.lstatSync(file))) throw changed();
    } finally {
      fs.closeSync(fd);
    }
  };
  check();
  // A changed file or cancelled confirmation must never leave a partial write in the target.
  const fd = fs.openSync(temporary, "wx", stat.mode & 0o777);
  try {
    fs.writeFileSync(fd, (source.bom ? "\uFEFF" : "") + output);
    const created = fs.fstatSync(fd);
    if (created.uid !== stat.uid || created.gid !== stat.gid) throw new ProjectInputError("Ember cannot preserve this file’s owner.");
    fs.fchmodSync(fd, stat.mode & 0o777);
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    throw err;
  }
  fs.closeSync(fd);
  try {
    check();
    record();
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
