import { describe, expect, it } from "vitest";
import fs from "node:fs";
import vm from "node:vm";
import { startupDialogText, startupProblem } from "../../app/main/data-folder";

const source = fs.readFileSync("app/main/main.ts", "utf8");
const start = source.indexOf("function startupFailed(err: unknown, said = startupProblem(err, userData, fs, platform.os)): void {");
const code = source.slice(start, source.indexOf("\n}\n", start) + 2)
  .replace("err: unknown", "err").replace("): void", ")");

/** Runs main.ts's startupFailed with `err` (and `said`, when given) against fakes; what it did, in order. */
function failWith(err: unknown, said?: string, logExists = false, os = "linux") {
  const calls: string[] = [];
  const later: (() => void)[] = [];
  const shown: string[][] = [];
  const logged: unknown[] = [];
  const context = vm.createContext({
    log: { error: (_msg: string, fields: { err: unknown }) => { calls.push("logged"); logged.push(fields.err); }, file: "/home/ana/.config/ember/logs/ember.log" },
    // Nothing in the way of the data folder is there (startupProblem looks).
    fs: { existsSync: () => logExists, statSync: () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); } },
    platform: { os },
    app: { whenReady: () => Promise.resolve(), exit: (n: number) => calls.push(`exit ${n}`) },
    sys: { lifecycle: { focusOwnApp: () => calls.push("focused") } },
    dialog: { showErrorBox: (title: string, body: string) => { calls.push("shown"); shown.push([title, body]); } },
    setImmediate: (fn: () => void) => later.push(fn),
    userData: "/home/ana/.config/ember", startupProblem, startupDialogText,
    err, said,
  });
  vm.runInContext(`${code}\nsaid === undefined ? startupFailed(err) : startupFailed(err, said);`, context);
  return { calls, later, shown, logged };
}

describe("startup failure", () => {
  it("shows the error but exits only from the next event-loop turn, never inside Electron ready (electron/electron#55011)", async () => {
    expect(start).toBeGreaterThan(-1);
    const { calls, later } = failWith(new Error("could not start"));
    await Promise.resolve();
    expect(calls).toEqual(["logged", "focused", "shown"]);
    expect(later).toHaveLength(1);
    later[0]();
    expect(calls).toEqual(["logged", "focused", "shown", "exit 1"]);
  });

  it("says a folder it couldn't make in plain words with the log's place, and keeps the raw error for the log (reliability-performance-r4-1)", async () => {
    const err = Object.assign(new Error("EEXIST: file already exists, mkdir '/home/ana/.config/ember/audit'"), { code: "EEXIST", path: "/home/ana/.config/ember/audit" });
    const { shown, logged } = failWith(err, undefined, true);
    await Promise.resolve();
    expect(shown).toEqual([["Ember couldn't start", "Ember can't use its data folder, /home/ana/.config/ember, because /home/ana/.config/ember/audit isn't a folder. Move it away, then start Ember again.\n\nThe details are in /home/ana/.config/ember/logs/ember.log."]]);
    expect(logged).toEqual([err]);
  });

  it("says a data folder it can't write to in the words of the platform's OS, never sudo on Windows (reliability-performance-c5-2)", async () => {
    const err = () => Object.assign(new Error("EPERM: operation not permitted, open '/home/ana/.config/ember'"), { code: "EPERM", path: "/home/ana/.config/ember" });
    const linux = failWith(err());
    const win = failWith(err(), undefined, false, "win32");
    await Promise.resolve();
    expect(linux.shown[0][1]).toMatch(/starting Ember with sudo can leave it owned by another user/);
    expect(win.shown).toEqual([["Ember couldn't start", "Ember can't write to its data folder, /home/ana/.config/ember. Make sure you can write to it, and that security software isn't keeping Ember out of it, then start Ember again."]]);
  });

  it("shows the data folder check's own sentence as it is, with no log to point to when none could be written (review #80)", async () => {
    const words = "Ember can't write to its data folder, /home/ana/.config/ember, because the disk is full. Free some space, then start Ember again.";
    const { shown } = failWith(new Error(words), words);
    await Promise.resolve();
    expect(shown).toEqual([["Ember couldn't start", words]]);
  });
});
