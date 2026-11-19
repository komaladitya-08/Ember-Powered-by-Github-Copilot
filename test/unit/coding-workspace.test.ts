import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CodingWorkspaceStore, codingBranch } from "../../app/main/agent/coding-workspace";
import { projectCommandFolder } from "../../app/main/agent/project";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
const box = { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(s.split("").reverse().join("")), decryptString: (b: Buffer) => b.toString().split("").reverse().join("") };
const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ember-coding-workspace-")); dirs.push(root);
  const data = path.join(root, "data"), work = path.join(root, "project"); fs.mkdirSync(data); fs.mkdirSync(work);
  return { root, data, work, store: new CodingWorkspaceStore(data, box, false) };
};

describe("coding workspace grant", () => {
  it("keeps a separate encrypted grant per account and removes it on forget", async () => {
    const { data, work, store } = setup();
    const a = "a".repeat(64), b = "b".repeat(64), folder = projectCommandFolder(work, data);
    await store.save(a, folder, () => true);
    const file = path.join(data, "coding-workspaces", `project-workspaces-${a}.bin`);
    expect(fs.readFileSync(file).includes(Buffer.from(work))).toBe(false);
    expect((await store.load(a))?.path).toBe(folder.path);
    expect(await store.load(b)).toBeNull();
    await store.forget(a);
    expect(await store.load(a)).toBeNull();
  });

  it("does not persist a cancelled selection and rejects Ember's private data folder", async () => {
    const { data, work, store } = setup();
    const scope = "c".repeat(64);
    await expect(store.save(scope, projectCommandFolder(work, data), () => false)).rejects.toThrow();
    expect(await store.load(scope)).toBeNull();
    expect(() => projectCommandFolder(data, data)).toThrow();
  });

  it("forgets encrypted recovery copies for this account too", async () => {
    const { data, work, store } = setup(), scope = "e".repeat(64);
    await store.save(scope, projectCommandFolder(work, data), () => true);
    const file = path.join(data, "coding-workspaces", `project-workspaces-${scope}.bin`);
    fs.writeFileSync(file, box.encryptString("not a valid record"));
    await expect(store.load(scope)).rejects.toThrow();
    expect(fs.existsSync(file + ".broken")).toBe(true);
    await store.forget(scope);
    expect(fs.existsSync(file + ".broken")).toBe(false);
  });

  it("treats a non-Git project as having no branch", async () => {
    const { data, work } = setup();
    expect(await codingBranch(projectCommandFolder(work, data))).toBeNull();
  });

  it.skipIf(process.platform === "win32")("refuses a storage directory redirected through a symlink", async () => {
    const { data, work, store } = setup();
    fs.symlinkSync(work, path.join(data, "coding-workspaces"), "dir");
    await expect(store.load("d".repeat(64))).rejects.toThrow("Invalid coding workspace storage directory");
  });
});
