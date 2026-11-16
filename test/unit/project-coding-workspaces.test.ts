import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ProjectCodingWorkspaces } from "../../app/main/agent/project-coding-workspaces";
import { projectCommandFolder } from "../../app/main/agent/project";

let root: string, privateDir: string, firstFolder: string, secondFolder: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-project-coding-"));
  [privateDir, firstFolder, secondFolder] = ["private", "first", "second"].map(name => path.join(root, name));
  for (const folder of [privateDir, firstFolder, secondFolder]) fs.mkdirSync(folder);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function fixture() {
  let owner: string | null = "owner-a";
  const first = randomUUID(), second = randomUUID(), projects = new Set<string>([first, second]);
  const workspaces = new ProjectCodingWorkspaces({ projectExists: id => projects.has(id), currentOwner: () => owner });
  return { workspaces, first, second, projects, owner: (id: string | null) => { owner = id; }, folder: (p = firstFolder) => projectCommandFolder(p, privateDir) };
}

describe("this run's project coding folders", () => {
  it("captures each project's immutable path without retargeting work when another project is selected", () => {
    const f = fixture();
    f.workspaces.bind(f.first, f.folder(), f.workspaces.ownerCurrent(f.first));
    const captured = f.workspaces.capture(f.first)!;
    f.workspaces.bind(f.second, f.folder(secondFolder), f.workspaces.ownerCurrent(f.second));
    expect(captured.path).toBe(fs.realpathSync(firstFolder)); expect(captured.current()).toBe(true);
    expect(f.workspaces.capture(f.second)?.path).toBe(fs.realpathSync(secondFolder));
    expect(f.workspaces.state(f.first)).toEqual({ path: fs.realpathSync(firstFolder), label: "first", valid: true });
    expect(Object.isFrozen(captured)).toBe(true);
    expect(fs.readdirSync(privateDir)).toEqual([]);
    expect(JSON.stringify(f.workspaces)).toBe("{}");
  });

  it("captures the canonical selected directory while accepting a native picker's noncanonical spelling", () => {
    const f = fixture(), selected = `${firstFolder}${path.sep}.`;
    f.workspaces.bind(f.first, f.folder(selected), f.workspaces.ownerCurrent(f.first));
    const captured = f.workspaces.capture(f.first)!;
    expect(captured.path).toBe(fs.realpathSync(firstFolder)); expect(captured.path).not.toBe(selected);
    expect(captured.current()).toBe(true);
  });

  it("invalidates only the rebound/forgotten project's capabilities and rejects an older chooser result", () => {
    const f = fixture();
    f.workspaces.bind(f.first, f.folder(), f.workspaces.ownerCurrent(f.first));
    f.workspaces.bind(f.second, f.folder(secondFolder), f.workspaces.ownerCurrent(f.second));
    const first = f.workspaces.capture(f.first)!, second = f.workspaces.capture(f.second)!;
    const staleChoice = f.workspaces.ownerCurrent(f.first);
    f.workspaces.bind(f.first, f.folder(secondFolder), f.workspaces.ownerCurrent(f.first));
    expect(first.current()).toBe(false); expect(second.current()).toBe(true);
    expect(() => f.workspaces.bind(f.first, f.folder(), staleChoice)).toThrow("no longer current");
    const rebound = f.workspaces.capture(f.first)!;
    f.workspaces.clear(f.first);
    expect(rebound.current()).toBe(false); expect(second.current()).toBe(true);
    expect(f.workspaces.state(f.first)).toBeNull();
    f.workspaces.bind(f.first, f.folder(), f.workspaces.ownerCurrent(f.first));
    expect(first.current()).toBe(false); expect(rebound.current()).toBe(false);
  });

  it("retains a moved folder's local display but never treats a replacement at its path as the selected folder", () => {
    const f = fixture(); f.workspaces.bind(f.first, f.folder(), f.workspaces.ownerCurrent());
    const captured = f.workspaces.capture(f.first)!;
    fs.renameSync(firstFolder, firstFolder + "-old"); fs.mkdirSync(firstFolder);
    expect(captured.current()).toBe(false); expect(f.workspaces.capture(f.first)).toBeNull();
    expect(f.workspaces.state(f.first)).toEqual({ path: fs.realpathSync(firstFolder), label: "first", valid: false });
  });

  it("rejects unknown or removed projects and stale, throwing or unavailable owners", () => {
    const f = fixture(), choice = f.workspaces.ownerCurrent();
    expect(() => f.workspaces.bind(randomUUID(), f.folder(), choice)).toThrow();
    expect(() => f.workspaces.bind("../other", f.folder(), choice)).toThrow();
    f.workspaces.bind(f.first, f.folder(), choice); const captured = f.workspaces.capture(f.first)!;
    f.projects.delete(f.first);
    expect(captured.current()).toBe(false); expect(f.workspaces.state(f.first)).toBeNull();
    expect(() => f.workspaces.bind(f.second, f.folder(), () => { throw new Error("unknown"); })).toThrow();
    f.owner(null); expect(f.workspaces.capture(f.second)).toBeNull();
    expect(() => f.workspaces.bind(f.second, f.folder(), () => true)).toThrow();
  });

  it("owner reset and clearAll permanently revoke retained chooser callbacks, including owner ABA", () => {
    const f = fixture(); f.workspaces.bind(f.first, f.folder(), f.workspaces.ownerCurrent());
    const captured = f.workspaces.capture(f.first)!, oldChooser = f.workspaces.ownerCurrent();
    f.owner("owner-b"); f.workspaces.ownerReset(); f.owner("owner-a"); f.workspaces.ownerReset();
    expect(captured.current()).toBe(false); expect(oldChooser()).toBe(false);
    expect(() => f.workspaces.bind(f.first, f.folder(), oldChooser)).toThrow();
    f.workspaces.bind(f.first, f.folder(), f.workspaces.ownerCurrent());
    const fresh = f.workspaces.capture(f.first)!, freshChooser = f.workspaces.ownerCurrent();
    f.workspaces.clearAll();
    expect(fresh.current()).toBe(false); expect(freshChooser()).toBe(false); expect(f.workspaces.state(f.first)).toBeNull();
  });

  it("rechecks project and owner revisions after host folder and capability callbacks", () => {
    const f = fixture();
    expect(() => f.workspaces.bind(f.first, { path: firstFolder, current: () => { f.workspaces.ownerReset(); return true; } }, () => true)).toThrow("choice changed");
    expect(f.workspaces.state(f.first)).toBeNull();
    expect(() => f.workspaces.bind(f.first, f.folder(), () => { f.workspaces.clear(f.first); return true; })).toThrow();
    expect(f.workspaces.state(f.first)).toBeNull();
  });
});
