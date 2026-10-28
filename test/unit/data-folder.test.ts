/**
 * The data-folder check behind the refused single-instance lock (review #80): a folder Ember can't write to is said
 * plainly at start-up (a dialog and exit code 1), never mistaken for another Ember already running.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dataFolderProblem, type DataFolderFs } from "../../app/main/data-folder";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "ember-data-"));
const errno = (code: string) => Object.assign(new Error(code), { code });
/** A folder that exists, where making a file fails with `code`. */
const refusing = (code: string): DataFolderFs => ({
  statSync: (() => ({ isDirectory: () => true })) as unknown as DataFolderFs["statSync"],
  openSync: () => { throw errno(code); },
  closeSync: () => undefined,
  rmSync: () => undefined,
});

describe("dataFolderProblem (review #80)", () => {
  it("a folder Ember can write to is fine, and the probe file is gone afterwards", () => {
    const dir = tmp();
    expect(dataFolderProblem(dir, 4242)).toBeNull();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("a folder owned by someone else (or read-only to Ember) is named, with what to do", () => {
    const why = dataFolderProblem("/home/ana/.config/ember", 1, refusing("EACCES"));
    expect(why).toBe("Ember can't write to its data folder, /home/ana/.config/ember. Make sure it belongs to you and that you can write to it (starting Ember with sudo can leave it owned by another user), then start Ember again.");
  });

  it("a full disk and a read-only disk say so", () => {
    expect(dataFolderProblem("/d", 1, refusing("ENOSPC"))).toMatch(/because the disk is full\. Free some space/);
    expect(dataFolderProblem("/d", 1, refusing("EDQUOT"))).toMatch(/because the disk is full/);
    expect(dataFolderProblem("/d", 1, refusing("EROFS"))).toMatch(/on a disk that can only be read/);
  });

  it("a file in the folder's place, or a path through a file, is a problem too", () => {
    const root = tmp();
    const file = path.join(root, "ember");
    fs.writeFileSync(file, "x");
    expect(dataFolderProblem(file)).toMatch(/something that isn't a folder is in its place/);
    expect(dataFolderProblem(path.join(file, "inside"))).toMatch(/^Ember can't write to its data folder/);
  });
});
