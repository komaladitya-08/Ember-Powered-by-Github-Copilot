import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ProjectWorkspaceStore } from "../../app/main/agent/project-workspaces";

const first = "1".repeat(64), other = "2".repeat(64);
const entry = {
  name: "Greeting", files: ["/project/greeting.ts"], folder: null,
  exchange: { mode: "plan" as const, question: "How should we update it?", answer: "Check its callers." },
};
const allow = () => true;
let dir: string;
const box = () => ({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "gnome_libsecret",
  encryptString: vi.fn((s: string) => Buffer.from(s, "utf8").reverse()),
  decryptString: vi.fn((b: Buffer) => Buffer.from(b).reverse().toString("utf8")),
});
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "ember-workspace-test-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

it("restores only the saved scope across instances and removes a forgotten checkpoint", async () => {
  const storage = new ProjectWorkspaceStore(dir, box(), false);
  await storage.write(first, [entry], allow);
  const restarted = new ProjectWorkspaceStore(dir, box(), false);
  expect(await restarted.list(first)).toEqual([entry]);
  expect(await restarted.list(other)).toEqual([]);
  const copy = (scope: string) => path.join(dir, "project-workspaces-" + scope + ".bin");
  await fs.copyFile(copy(first), copy(other));
  await expect(restarted.list(other)).rejects.toThrow("owner changed");
  await restarted.write(first, [], allow);
  expect(await storage.list(first)).toEqual([]);
});

it("fails closed if the keyring or the account is unavailable", async () => {
  const unavailable = { ...box(), getSelectedStorageBackend: () => "basic_text" };
  await expect(new ProjectWorkspaceStore(dir, unavailable, false).write(first, [entry], allow)).rejects.toThrow("system keyring");
  expect(unavailable.encryptString).not.toHaveBeenCalled();
  await expect(new ProjectWorkspaceStore(dir, box(), false).write(first, [entry], () => false)).rejects.toThrow("cancelled");
  expect(await fs.readdir(dir)).toEqual([]);
});

it("sets a corrupt library aside so new workspaces can be saved, and bounds how many checkpoints can be saved", async () => {
  const storage = new ProjectWorkspaceStore(dir, box(), false);
  await expect(storage.write(first, Array.from({ length: 9 }, (_, i) => ({ ...entry, name: String(i) })), allow)).rejects.toThrow("eight");
  const saved = path.join(dir, "project-workspaces-" + first + ".bin");
  await fs.writeFile(saved, "invalid");
  await expect(storage.list(first)).rejects.toThrow("set them aside");
  expect(await fs.readFile(saved + ".broken", "utf8")).toBe("invalid");
  expect(await storage.list(first)).toEqual([]);
  await storage.write(first, [entry], allow);
  expect(await storage.list(first)).toEqual([entry]);
});

it("leaves the library alone while the keyring is unavailable", async () => {
  const saved = path.join(dir, "project-workspaces-" + first + ".bin");
  await fs.writeFile(saved, "invalid");
  const unavailable = { ...box(), getSelectedStorageBackend: () => "basic_text" };
  await expect(new ProjectWorkspaceStore(dir, unavailable, false).list(first)).rejects.toThrow("system keyring");
  expect(await fs.readFile(saved, "utf8")).toBe("invalid");
});
