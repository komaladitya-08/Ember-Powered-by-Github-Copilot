/**
 * Hand edits of settings.json in an editor that saves as the user types (review #92): Ember keeps only the last few
 * copies of versions it couldn't use (settings.json.bad-<time>), and a version it would repair (valid JSON with a value
 * out of range, "size": 800 on the way to 80) is rewritten only once the file has stayed the same for a couple of
 * seconds, not under the editor while the user is still typing. A change made in Ember meanwhile goes on top at once.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "../../app/main/settings";

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-edit-"));
  const f = path.join(dir, "settings.json");
  let now = 1_000_000;
  const store = new SettingsStore(f, null, { clock: () => now });
  store.load();
  store.update({ character: "wisp", size: 80 });
  let stamp = Date.now();
  /** The editor saves `text` (each save gets its own time stamp). */
  const save = (text: string) => {
    fs.writeFileSync(f, text);
    stamp += 5000;
    fs.utimesSync(f, new Date(stamp), new Date(stamp));
  };
  const backups = () => fs.readdirSync(dir).filter(x => x.startsWith("settings.json.bad-")).sort();
  return { f, store, save, backups, wait: (ms: number) => { now += ms; } };
}

describe("hand edits of settings.json while Ember runs (review #92)", () => {
  it("keeps at most the last three copies of versions it couldn't use", () => {
    const { f, store, save, backups } = setup();
    for (let i = 0; i < 6; i++) {
      save(`{ "character": "wisp", "size": ${i}`);
      store.reloadIfChanged();
    }
    expect(backups()).toHaveLength(3);
    // The newest are kept: they hold the last three broken versions.
    const kept = backups().map(b => fs.readFileSync(path.join(path.dirname(f), b), "utf8"));
    expect(kept.sort()).toEqual(['{ "character": "wisp", "size": 3', '{ "character": "wisp", "size": 4', '{ "character": "wisp", "size": 5']);
  });

  it("doesn't rewrite a repairable version while it is still changing, and repairs it once it has stayed the same", () => {
    const { f, store, save, wait } = setup();
    const typed = '{ "character": "wisp", "size": 800 }';
    save(typed);
    store.reloadIfChanged();
    expect(fs.readFileSync(f, "utf8")).toBe(typed);
    // The user goes on typing: the next version is valid.
    wait(1000);
    const done = '{ "character": "wisp", "size": 90 }';
    save(done);
    store.reloadIfChanged();
    expect(fs.readFileSync(f, "utf8")).toBe(done);
    expect(store.get().size).toBe(90);
    // A version left out of range is repaired once it has stayed the same for a couple of seconds.
    save(typed);
    store.reloadIfChanged();
    expect(fs.readFileSync(f, "utf8")).toBe(typed);
    wait(2500);
    store.reloadIfChanged();
    expect(JSON.parse(fs.readFileSync(f, "utf8")).size).toBe(60);
    expect(store.lastProblem).toMatch(/Some of settings\.json couldn't be used/);
  });

  it("a change made in Ember while a repairable version waits goes on top of it at once", () => {
    const { f, store, save } = setup();
    save('{ "character": "glint", "size": 800 }');
    store.reloadIfChanged();
    store.update({ speak: false });
    expect(JSON.parse(fs.readFileSync(f, "utf8"))).toMatchObject({ character: "glint", size: 60, speak: false });
  });
});

describe("a settings.json Ember can't read at all, at start", () => {
  const start = (text: string) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-unread-"));
    const f = path.join(dir, "settings.json");
    fs.writeFileSync(f, text);
    const store = new SettingsStore(f, null);
    const loaded = store.load();
    return { store, loaded, backup: path.basename(loaded.recoveredFrom ?? "") };
  };

  it("says every setting went back to its default and that Ember asks to be set up again, not that some did (reliability-r7-3)", () => {
    // Cut off mid-write: nothing can be read, so consent and the welcome go too.
    const { store, loaded, backup } = start('{ "version": 1, "onboarded": true, "character": "wi');
    expect(loaded.settings.onboarded).toBe(false);
    expect(backup).toMatch(/^settings\.json\.bad-/);
    expect(store.lastProblem).toBe(`settings.json couldn't be read, so every setting went back to its default and Ember asks you to set it up again; your version is saved as ${backup}.`);
  });

  it("says the never-look list was kept when it could be picked out of the file (reliability-r7-3)", () => {
    const { store, loaded, backup } = start('{ "privacy": { "neverLook": ["Bank"] }, "character": "wi');
    expect(loaded.settings.privacy.neverLook).toEqual(["Bank"]);
    expect(store.lastProblem).toBe(`settings.json couldn't be read, so every setting but your never-look list went back to its default and Ember asks you to set it up again; your version is saved as ${backup}.`);
  });

  it("still says only some settings went back when the rest of the file was kept", () => {
    const { store, loaded } = start('{ "character": "wisp", "size": 800 }');
    expect(loaded.settings.character).toBe("wisp");
    expect(store.lastProblem).toMatch(/^Some of settings\.json couldn't be used, so those settings went back to their defaults/);
  });
});
