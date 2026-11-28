import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SIBLINGS_MAX, settleCodeState, siblingDenials, type StateFs } from "../../app/main/code/state";

let dir: string, legacy: string, wanted: string;
const logged: { event: string; fields?: Record<string, unknown> }[] = [];
const log = { info: (event: string, fields?: Record<string, unknown>) => { logged.push({ event, ...(fields ? { fields } : {}) }); }, warn: (event: string, fields?: Record<string, unknown>) => { logged.push({ event, ...(fields ? { fields } : {}) }); } };

beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ember-code-state-")));
  legacy = path.join(dir, "userdata", "code", "copilot");
  wanted = path.join(dir, "state", "ember-code");
  logged.length = 0;
});
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

/** An earlier build's state: one session with its plan, and the session store. */
function earlier(): void {
  fs.mkdirSync(path.join(legacy, "session-state", "s1"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "session-state", "s1", "plan.md"), "the plan");
  fs.writeFileSync(path.join(legacy, "session-store.db"), "db");
}

/** node:fs/promises, with a rename across filesystems refused (EXDEV) and, optionally, a copy that fails. */
function acrossDisks(o: { copyFails?: boolean } = {}): StateFs {
  const fail = (code: string) => Object.assign(new Error(code), { code });
  return {
    rename: async (a, b) => { if (path.dirname(a) !== path.dirname(b)) throw fail("EXDEV"); await fsp.rename(a, b); },
    cp: async (a, b, opts) => { if (o.copyFails) { await fsp.mkdir(b, { recursive: true }); throw fail("ENOSPC"); } await fsp.cp(a, b, opts); },
    rm: (p, opts) => fsp.rm(p, opts), mkdir: (p, opts) => fsp.mkdir(p, opts), chmod: (p, m) => fsp.chmod(p, m),
    readdir: p => fsp.readdir(p), lstat: p => fsp.lstat(p),
  };
}

describe("where the coding runtime's state is settled at start (docs/CODING-APP.md §3)", () => {
  it("makes the new folder private when nothing earlier is there", async () => {
    expect(await settleCodeState({ legacy, wanted, log })).toBe(wanted);
    if (process.platform !== "win32") expect(fs.statSync(wanted).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(legacy)).toBe(false);
    expect(logged).toEqual([]);
  });

  it("moves an earlier build's sessions out of Ember's data folder by a rename on one filesystem, leaving nothing behind", async () => {
    earlier();
    expect(await settleCodeState({ legacy, wanted, log })).toBe(wanted);
    expect(fs.readFileSync(path.join(wanted, "session-state", "s1", "plan.md"), "utf8")).toBe("the plan");
    expect(fs.existsSync(legacy)).toBe(false);
    if (process.platform !== "win32") expect(fs.statSync(wanted).mode & 0o777).toBe(0o700);
    expect(logged).toEqual([{ event: "code.state_moved", fields: { how: "rename" } }]);
    // Once is enough: the next start finds it in place.
    expect(await settleCodeState({ legacy, wanted, log })).toBe(wanted);
  });

  it("copies across filesystems, and removes the original only once the copy is in place", async () => {
    earlier();
    expect(await settleCodeState({ legacy, wanted, log, fs: acrossDisks() })).toBe(wanted);
    expect(fs.readFileSync(path.join(wanted, "session-store.db"), "utf8")).toBe("db");
    expect(fs.existsSync(legacy)).toBe(false);
    expect(fs.existsSync(`${legacy}.moving`)).toBe(false);
    expect(fs.existsSync(`${wanted}.partial`)).toBe(false);
    expect(logged).toEqual([{ event: "code.state_moved", fields: { how: "copy" } }]);
  });

  it("keeps the earlier folder in use, whole, where the copy fails, and logs one line with no path", async () => {
    earlier();
    expect(await settleCodeState({ legacy, wanted, log, fs: acrossDisks({ copyFails: true }) })).toBe(legacy);
    expect(fs.readFileSync(path.join(legacy, "session-state", "s1", "plan.md"), "utf8")).toBe("the plan");
    expect(fs.existsSync(wanted)).toBe(false);
    expect(fs.existsSync(`${wanted}.partial`)).toBe(false);
    expect(fs.existsSync(`${legacy}.moving`)).toBe(false);
    expect(logged).toEqual([{ event: "code.state_not_moved", fields: { code: "ENOSPC" } }]);
    expect(JSON.stringify(logged)).not.toContain(dir);
  });

  it("keeps the earlier folder in use where the move is refused (not across filesystems)", async () => {
    earlier();
    const refused: StateFs = { ...acrossDisks(), rename: async () => { throw Object.assign(new Error("EACCES"), { code: "EACCES" }); } };
    expect(await settleCodeState({ legacy, wanted, log, fs: refused })).toBe(legacy);
    expect(fs.existsSync(path.join(legacy, "session-store.db"))).toBe(true);
    expect(logged).toEqual([{ event: "code.state_not_moved", fields: { code: "EACCES" } }]);
  });

  it("finishes a copy a crash cut short from the original put aside, or only removes the original once the copy is in place", async () => {
    earlier();
    fs.renameSync(legacy, `${legacy}.moving`);
    fs.mkdirSync(`${wanted}.partial`, { recursive: true });
    fs.writeFileSync(path.join(`${wanted}.partial`, "half"), "x");
    expect(await settleCodeState({ legacy, wanted, log, fs: acrossDisks() })).toBe(wanted);
    expect(fs.existsSync(path.join(wanted, "half"))).toBe(false);
    expect(fs.readFileSync(path.join(wanted, "session-state", "s1", "plan.md"), "utf8")).toBe("the plan");
    expect(fs.existsSync(`${legacy}.moving`)).toBe(false);
    // The copy was in place but the original's removal hadn't run.
    fs.mkdirSync(`${legacy}.moving`, { recursive: true });
    expect(await settleCodeState({ legacy, wanted, log })).toBe(wanted);
    expect(fs.existsSync(`${legacy}.moving`)).toBe(false);
  });

  it("never uses two folders: one with sessions in it stays in use and the earlier one is left as it is; an empty one gives way", async () => {
    earlier();
    fs.mkdirSync(path.join(wanted, "session-state", "s2"), { recursive: true });
    expect(await settleCodeState({ legacy, wanted, log })).toBe(wanted);
    expect(fs.existsSync(path.join(legacy, "session-state", "s1"))).toBe(true);
    expect(logged).toEqual([{ event: "code.state_both", fields: {} }]);
    fs.rmSync(wanted, { recursive: true });
    fs.mkdirSync(wanted, { recursive: true });
    expect(await settleCodeState({ legacy, wanted, log })).toBe(wanted);
    expect(fs.existsSync(path.join(wanted, "session-state", "s1", "plan.md"))).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
  });
});

describe("what one session's sandbox denies of the state folder", () => {
  it("is everything beside session-state, and every other session's folder, in each spelling of the folder", async () => {
    const root = path.join(dir, "state", "ember-code");
    for (const p of ["session-state/s1", "session-state/s2", "session-state/.session-operation-locks", "logs", "installed-plugins"]) fs.mkdirSync(path.join(root, p), { recursive: true });
    fs.writeFileSync(path.join(root, "session-store.db"), "");
    fs.writeFileSync(path.join(root, "mcp-config.json"), "{}");
    const alias = path.join(dir, "alias");
    fs.symlinkSync(root, alias, "junction");
    const denied = await siblingDenials([alias, root], "s1");
    for (const r of [alias, root]) {
      expect(denied).toEqual(expect.arrayContaining(["logs", "installed-plugins", "session-store.db", "mcp-config.json", "session-state/s2", "session-state/.session-operation-locks"].map(p => path.join(r, p))));
      expect(denied).not.toContain(path.join(r, "session-state", "s1"));
      expect(denied).not.toContain(path.join(r, "session-state"));
      expect(denied).not.toContain(r);
    }
    expect(denied).toHaveLength(12);
  });

  it("is the whole folder where it can't be read, where it holds too much to list, or for an id that isn't one (fail closed)", async () => {
    const root = path.join(dir, "missing");
    expect(await siblingDenials([root], "s1")).toEqual([root]);
    expect(await siblingDenials([root], "../s1")).toEqual([root]);
    const many: Pick<StateFs, "readdir"> = { readdir: async p => p.endsWith("session-state") ? Array.from({ length: SIBLINGS_MAX + 2 }, (_, i) => `s${i}`) : ["session-state"] };
    expect(await siblingDenials([root], "s1", many)).toEqual([root]);
    // No session-state yet (the first session): only the entries beside it.
    fs.mkdirSync(path.join(dir, "fresh", "logs"), { recursive: true });
    expect(await siblingDenials([path.join(dir, "fresh")], "s1")).toEqual([path.join(dir, "fresh", "logs")]);
  });
});
