/**
 * The data-folder check behind the refused single-instance lock (review #80): a folder Ember can't write to is said
 * plainly at start-up (a dialog and exit code 1), never mistaken for another Ember already running.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { dataFolderProblem, startupDialogText, startupProblem, type DataFolderFs } from "../../app/main/data-folder";
import { ISSUES_URL } from "../../app/shared/support";

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

/** The error `fn` throws (node:fs's own, with its code and path). */
const thrown = (fn: () => unknown): unknown => { try { fn(); } catch (err) { return err; } throw new Error("it didn't throw"); };

describe("startupProblem: what the start-up dialog says when Ember can't start (reliability-performance-r4-1)", () => {
  it("names the file in the place of a folder Ember makes at start, and what to do, never the raw EEXIST (reliability-performance-r4-1)", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "audit"), "x");
    const err = thrown(() => fs.mkdirSync(path.join(dir, "audit"), { recursive: true }));
    const said = startupProblem(err, dir);
    expect(said).toBe(`Ember can't use its data folder, ${dir}, because ${path.join(dir, "audit")} isn't a folder. Move it away, then start Ember again.`);
    expect(said).not.toMatch(/EEXIST|mkdir/);
  });

  it("names the file in the way of a deeper folder, not the folder it was making (reliability-performance-r4-1)", () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, "audit"), "x");
    const err = thrown(() => fs.mkdirSync(path.join(dir, "audit", "2026"), { recursive: true }));
    expect(startupProblem(err, dir)).toBe(`Ember can't use its data folder, ${dir}, because ${path.join(dir, "audit")} isn't a folder. Move it away, then start Ember again.`);
  });

  it("says a full or read-only disk, and a folder that isn't the user's, in the data folder check's words (reliability-performance-r4-1)", () => {
    const at = (code: string, p: string) => Object.assign(new Error(`${code}: oops, open '${p}'`), { code, path: p });
    const dir = "/home/ana/.config/ember";
    expect(startupProblem(at("ENOSPC", `${dir}/audit/today.jsonl`), dir)).toBe(dataFolderProblem(dir, 1, refusing("ENOSPC")));
    expect(startupProblem(at("EDQUOT", `${dir}/audit`), dir)).toBe(dataFolderProblem(dir, 1, refusing("EDQUOT")));
    expect(startupProblem(at("EROFS", `${dir}/audit`), dir)).toBe(dataFolderProblem(dir, 1, refusing("EROFS")));
    expect(startupProblem(at("EACCES", dir), dir)).toBe(dataFolderProblem(dir, 1, refusing("EACCES")));
    // A folder inside it that someone else owns (after `sudo ember`) is named.
    expect(startupProblem(at("EPERM", `${dir}/audit`), dir)).toBe(`Ember can't write to ${dir}/audit, in its data folder. Make sure it belongs to you and that you can write to it (starting Ember with sudo can leave it owned by another user), then start Ember again.`);
  });

  it("says anything else in one plain sentence, never the error's own text (reliability-performance-r4-1)", () => {
    const dir = "/home/ana/.config/ember";
    const odd = Object.assign(new Error("ELOOP: too many symbolic links encountered, mkdir '/home/ana/.config/ember/audit'"), { code: "ELOOP", path: `${dir}/audit` });
    expect(startupProblem(odd, dir)).toBe(`Ember couldn't use its data folder, ${dir}. Start Ember again.`);
    const elsewhere = Object.assign(new Error("EACCES: permission denied, open '/etc/ember/policy.json'"), { code: "EACCES", path: "/etc/ember/policy.json" });
    for (const err of [elsewhere, new TypeError("Cannot read properties of undefined (reading 'x')"), "boom", null]) {
      expect(startupProblem(err, dir)).toBe(`Something went wrong while Ember was starting. Start Ember again. If it keeps happening, reinstall Ember, or report it at ${ISSUES_URL}.`);
    }
  });

  it("says what to do next when starting again can't help: reinstall, or report it where reports go (reliability-performance-c5-2)", () => {
    // A file missing from a damaged install fails the same way at every start.
    const missing = Object.assign(new Error("ENOENT: no such file or directory, open '/opt/ember/resources/app/dist/app/x.cjs'"), { code: "ENOENT", path: "/opt/ember/resources/app/dist/app/x.cjs" });
    for (const os of ["linux", "win32", "darwin"] as const) {
      const said = startupProblem(missing, "/home/ana/.config/ember", fs, os);
      expect(said, os).toMatch(/^Something went wrong while Ember was starting\. Start Ember again\. If it keeps happening, reinstall Ember, or report it at https:\/\/github\.com\/[^ ]+\/issues\.$/);
      expect(startupDialogText(said, "/home/ana/.config/ember/logs/ember.log"), os).toMatch(/report it at \S+\.\n\nThe details are in \/home\/ana\/\.config\/ember\/logs\/ember\.log\.$/);
    }
  });

  it("tells Windows users about their folder's permissions and security software, never sudo (reliability-performance-c5-2)", () => {
    const dir = "C:\\Users\\ana\\AppData\\Local\\ember";
    const at = (code: string, p: string) => Object.assign(new Error(`${code}: operation not permitted, open '${p}'`), { code, path: p });
    const win = "Make sure you can write to it, and that security software isn't keeping Ember out of it, then start Ember again.";
    expect(dataFolderProblem(dir, 1, refusing("EPERM"), "win32")).toBe(`Ember can't write to its data folder, ${dir}. ${win}`);
    expect(dataFolderProblem(dir, 1, refusing("EACCES"), "win32")).toBe(`Ember can't write to its data folder, ${dir}. ${win}`);
    expect(startupProblem(at("EPERM", dir), dir, fs, "win32")).toBe(`Ember can't write to its data folder, ${dir}. ${win}`);
    for (const os of ["linux", "darwin"] as const) {
      expect(dataFolderProblem("/home/ana/.config/ember", 1, refusing("EACCES"), os), os).toMatch(/starting Ember with sudo can leave it owned by another user/);
    }
    // The other causes read alike everywhere.
    expect(dataFolderProblem(dir, 1, refusing("ENOSPC"), "win32")).toBe(`Ember can't write to its data folder, ${dir}, because the disk is full. Free some space, then start Ember again.`);
  });

  it("points to the log only when it could be written (reliability-performance-r4-1)", () => {
    expect(startupDialogText("Ember couldn't use its data folder, /d. Start Ember again.", "/d/logs/ember.log")).toBe("Ember couldn't use its data folder, /d. Start Ember again.\n\nThe details are in /d/logs/ember.log.");
    expect(startupDialogText("Ember couldn't use its data folder, /d. Start Ember again.", null)).toBe("Ember couldn't use its data folder, /d. Start Ember again.");
  });
});
