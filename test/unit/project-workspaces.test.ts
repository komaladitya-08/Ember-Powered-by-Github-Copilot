import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { ProjectWorkspaceStore, workspaceOwners } from "../../app/main/agent/project-workspaces";
import { userProviderConfig } from "../../app/main/provider";
import { DEFAULT_SETTINGS } from "../../app/main/settings";

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

// integrations-r9-3: the library's owner was a hash of the provider's whole config, its API key included, so replacing
// the key (or removing it, or changing the wire API) left every saved workspace in a file nothing listed or removed.
const owners = (o: { key?: string | null; baseUrl?: string; type?: "openai" | "azure" | "anthropic"; wireApi?: "completions" | "responses"; kind?: "user" | "admin" } = {}) => {
  const p = { ...DEFAULT_SETTINGS.provider, on: true, type: o.type ?? "openai" as const, baseUrl: o.baseUrl ?? "https://api.openai.com/v1", ...(o.wireApi ? { wireApi: o.wireApi } : {}) };
  const key = o.key === undefined ? "sk-old" : o.key;
  return workspaceOwners({ kind: o.kind ?? "user", config: userProviderConfig(p, key ? { host: new URL(p.baseUrl).host, key } : null) }, null)!;
};

it("keeps my own provider's saved workspaces in one library whatever its key: replaced, removed, or another wire API (integrations-r9-3)", () => {
  const was = owners();
  for (const now of [owners({ key: "sk-new" }), owners({ key: null }), owners({ wireApi: "responses" })]) {
    expect(now.library).toBe(was.library);
    // A saved answer is still that key's and those settings' alone.
    expect(now.holder).not.toBe(was.holder);
  }
  // Another address, another type or the organisation's provider is another service, with a library of its own.
  for (const other of [owners({ baseUrl: "https://gateway.example.com/v1" }), owners({ type: "anthropic", baseUrl: "https://api.openai.com/v1" }), owners({ kind: "admin" })]) {
    expect(other.library).not.toBe(was.library);
  }
  expect(JSON.stringify(was)).not.toContain("sk-old");
  // A GitHub account's library is where it was before (its file keeps its name), and no connection has none.
  const account = createHash("sha256").update("github:42").digest("hex");
  expect(workspaceOwners(null, 42)).toEqual({ library: account, holder: account });
  expect(workspaceOwners(null, null)).toBeNull();
});

it("lists a workspace saved with the old key under the new one, can forget it, and never brings back an answer the old key was given (integrations-r9-3)", async () => {
  const was = owners(), now = owners({ key: "sk-new" });
  const storage = new ProjectWorkspaceStore(dir, box(), false);
  const plain = { ...entry, name: "Plain", exchange: null };
  await storage.write(was.library, [entry, plain], allow, was.holder);
  expect(await storage.read(was.library, was.holder)).toEqual({ entries: [entry, plain], left: [] });
  // The key is replaced: both are still listed, with their files and folder; the saved answer is left out, and said so.
  expect(await storage.read(now.library, now.holder)).toEqual({ entries: [{ ...entry, exchange: null }, plain], left: ["Greeting"] });
  expect(await storage.list(now.library, now.holder)).toEqual([{ ...entry, exchange: null }, plain]);
  // The old key back before anything was saved again: its answer is there.
  expect((await storage.read(was.library, was.holder)).entries).toEqual([entry, plain]);
  // Forgetting one under the new key works, and what is saved from then on is the new key's: the old answer is gone.
  const kept = (await storage.list(now.library, now.holder)).filter(e => e.name !== "Plain");
  await storage.write(now.library, kept, allow, now.holder);
  expect(await storage.read(now.library, now.holder)).toEqual({ entries: [{ ...entry, exchange: null }], left: [] });
  expect(await storage.read(was.library, was.holder)).toEqual({ entries: [{ ...entry, exchange: null }], left: [] });
  await storage.write(now.library, [], allow, now.holder);
  expect(await fs.readdir(dir)).toEqual([]);
});

it("takes over a library saved before the service owned it, while the key it was saved with is still in force (integrations-r9-3)", async () => {
  const was = owners();
  const storage = new ProjectWorkspaceStore(dir, box(), false);
  // As earlier builds wrote it: named for, and owned by, the whole config's hash.
  await storage.write(was.holder, [entry], allow);
  expect(await fs.readdir(dir)).toEqual([`project-workspaces-${was.holder}.bin`]);
  expect(await storage.read(was.library, was.holder)).toEqual({ entries: [entry], left: [] });
  expect(await fs.readdir(dir)).toEqual([`project-workspaces-${was.library}.bin`]);
  // From there a replaced key keeps it, as above.
  const now = owners({ key: "sk-new" });
  expect(await storage.read(now.library, now.holder)).toEqual({ entries: [{ ...entry, exchange: null }], left: ["Greeting"] });
  // Another owner's file put under this library's name is still refused.
  await storage.write(other, [entry], allow);
  await fs.copyFile(path.join(dir, `project-workspaces-${other}.bin`), path.join(dir, `project-workspaces-${first}.bin`));
  await expect(storage.read(first, was.holder)).rejects.toThrow("owner changed");
});
