import { describe, expect, it } from "vitest";
import path from "node:path/posix";
import { cleanUp, LEFTOVER_MS, runtimeIdOf, UNUSED_MS, type CleanupIo } from "../../app/remote/cleanup";
import { emberPaths, placesFor } from "../../app/remote/places";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;
const DATA = "/home/deploy/.local/share/ember-remote";
const ME = "0123456789ab4567";
const OTHER = "fedcba9876543210";
const NOW = Date.UTC(2026, 9, 22);
const DAY = 86_400_000;

/** A data folder in memory: each path's kind and time; `touch` and `remove` change it. */
function tree(entries: Record<string, { dir?: boolean; age: number }>, o: { touchFails?: boolean } = {}) {
  const t = new Map(Object.entries(entries).map(([p, e]) => [path.join(DATA, p), { dir: !!e.dir, mtimeMs: NOW - e.age }]));
  const io: CleanupIo = {
    list: dir => [...new Set([...t.keys()].filter(p => path.dirname(p) === dir).map(p => path.basename(p)))],
    stat: p => t.get(p) ?? null,
    touch: p => {
      if (o.touchFails || !t.get(path.dirname(p))?.dir) throw new Error("read-only");
      t.set(p, { dir: false, mtimeMs: NOW });
    },
    remove: async p => { for (const k of [...t.keys()]) if (k === p || k.startsWith(`${p}/`)) t.delete(k); },
  };
  return { io, has: (p: string) => t.has(path.join(DATA, p)) };
}

const run = (io: CleanupIo, runtimeId: string | null = "24.21.0-linux-x64") =>
  cleanUp({ data: DATA, machine: ME, partsId: "0.2.0-bbbbbbbbbbbb", runtimeId, now: NOW, io, log: quiet });

describe("clean-up after serving (§5.2.6)", () => {
  const base = {
    "versions": { dir: true, age: DAY },
    "versions/0.2.0-bbbbbbbbbbbb": { dir: true, age: DAY },
    "runtime": { dir: true, age: DAY },
    "runtime/24.21.0-linux-x64": { dir: true, age: 90 * DAY },
  };

  it("notes this machine's use of its parts and runtime, and never takes them", async () => {
    const t = tree(base);
    expect(await run(t.io)).toEqual([]);
    expect(t.has(`versions/0.2.0-bbbbbbbbbbbb/last-used-${ME}`)).toBe(true);
    expect(t.has(`runtime/24.21.0-linux-x64/last-used-${ME}`)).toBe(true);
    expect(t.has("runtime/24.21.0-linux-x64")).toBe(true);
  });

  it("deletes a version or runtime no machine has used for 30 days, and keeps one another machine used lately", async () => {
    const t = tree({
      ...base,
      "versions/0.1.0-aaaaaaaaaaaa": { dir: true, age: 100 * DAY },
      [`versions/0.1.0-aaaaaaaaaaaa/last-used-${ME}`]: { age: 31 * DAY },
      "versions/0.1.5-cccccccccccc": { dir: true, age: 100 * DAY },
      [`versions/0.1.5-cccccccccccc/last-used-${ME}`]: { age: 60 * DAY },
      [`versions/0.1.5-cccccccccccc/last-used-${OTHER}`]: { age: 2 * DAY },
      "runtime/24.18.1-linux-x64": { dir: true, age: 200 * DAY },
      [`runtime/24.18.1-linux-x64/last-used-${OTHER}`]: { age: UNUSED_MS + 1 },
    });
    expect((await run(t.io)).sort()).toEqual(["runtime/24.18.1-linux-x64", "versions/0.1.0-aaaaaaaaaaaa"]);
    expect(t.has("versions/0.1.5-cccccccccccc")).toBe(true);
  });

  it("judges a folder without stamps by its own time, so a fresh install is never taken", async () => {
    const t = tree({ ...base, "versions/0.3.0-dddddddddddd": { dir: true, age: DAY }, "versions/0.0.9-eeeeeeeeeeee": { dir: true, age: 40 * DAY } });
    expect(await run(t.io)).toEqual(["versions/0.0.9-eeeeeeeeeeee"]);
  });

  it("leaves runtimes alone when the one in use is unknown", async () => {
    const t = tree({ ...base, "runtime/24.18.1-linux-x64": { dir: true, age: 200 * DAY } });
    expect(await run(t.io, null)).toEqual([]);
    expect(t.has("runtime/24.18.1-linux-x64")).toBe(true);
  });

  it("deletes a dead install's staging folders and lock after a day, not before", async () => {
    const t = tree({
      ...base,
      "staging-AbC123": { dir: true, age: LEFTOVER_MS + 1 },
      "staging-XyZ789": { dir: true, age: LEFTOVER_MS - 1000 },
      "install.lock": { dir: true, age: 2 * DAY },
    });
    expect((await run(t.io)).sort()).toEqual(["install.lock", "staging-AbC123"]);
    expect(t.has("staging-XyZ789")).toBe(true);
  });

  it("deletes nothing when it can't note its own use, and nothing that isn't a folder of the bootstrap's naming", async () => {
    const old = { ...base, "versions/0.1.0-aaaaaaaaaaaa": { dir: true, age: 100 * DAY }, "versions/notes.txt": { age: 100 * DAY }, "versions/bad name": { dir: true, age: 100 * DAY } };
    expect(await run(tree(old, { touchFails: true }).io)).toEqual([]);
    const t = tree(old);
    expect(await run(t.io)).toEqual(["versions/0.1.0-aaaaaaaaaaaa"]);
    expect(t.has("versions/bad name")).toBe(true);
  });

  it("finds the runtime in use from Node's own path", () => {
    const t = tree(base);
    expect(runtimeIdOf(`${DATA}/runtime/24.21.0-linux-x64/bin/node`, DATA, t.io)).toBe("24.21.0-linux-x64");
    expect(runtimeIdOf("/usr/bin/node", DATA, t.io)).toBeNull();
    expect(runtimeIdOf(`${DATA}/runtime/24.99.0-linux-x64/bin/node`, DATA, t.io)).toBeNull();
  });
});

describe("Ember's own paths on a remote (§3.6.2, D4.5)", () => {
  it("name the agent's folders and this computer's Ember policy folder, which commands may not touch", () => {
    const linux = placesFor({ os: "linux", home: "/home/deploy", machine: ME, session: "/run/user/1000/ember-remote", sessionStable: true });
    expect(emberPaths("linux", linux)).toEqual([
      "/home/deploy/.local/share/ember-remote", "/home/deploy/.local/state/ember-remote", "/run/user/1000/ember-remote", "/etc/ember", "/var/log/ember-remote",
    ]);
    const mac = placesFor({ os: "darwin", home: "/Users/ana", machine: ME, session: "/var/folders/xy/T/ember-remote", sessionStable: true });
    expect(emberPaths("darwin", mac)).toEqual([
      "/Users/ana/Library/Application Support/Ember Remote", "/Users/ana/Library/Application Support/Ember Remote/state", "/var/folders/xy/T/ember-remote",
      "/Library/Application Support/Ember",
    ]);
  });
});
