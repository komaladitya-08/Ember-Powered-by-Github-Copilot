import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { MemoryOwner } from "../../app/main/memory/owner";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-memory-owner-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const saved = (file = "memory.json") => path.join(dir, file);

it("keeps saved memory closed across restart until its verified account returns", () => {
  const first = new MemoryOwner(dir);
  first.verify("Sample-Owner", true);
  expect(first.ready).toBe(true);
  fs.writeFileSync(saved(), "owner data");
  expect(fs.readFileSync(saved("memory-owner"), "utf8")).not.toContain("Sample-Owner");

  const restarted = new MemoryOwner(dir);
  expect(restarted.state).toBe("locked");
  restarted.verify("different-account", true);
  expect(restarted.ready).toBe(false);
  expect(restarted.mayEraseOnSignOut).toBe(false);
  expect(fs.readFileSync(saved(), "utf8")).toBe("owner data");
  restarted.verify("sample-owner", false);
  expect(restarted.ready).toBe(true);
  restarted.pause();
  expect(restarted.ready).toBe(false);
  expect(restarted.mayEraseOnSignOut).toBe(true);
});

it.each(["memory.json", "memory.json.tmp", "memory.json.broken", "memory-vectors.json"])(
  "keeps unowned data in %s locked until explicit cleanup completes", file => {
    fs.writeFileSync(saved(file), "old memory");
    const owner = new MemoryOwner(dir);
    owner.verify("new-account", true);
    expect(owner.state).toBe("locked");
    expect(() => owner.clear()).toThrow("still present");
    expect(fs.existsSync(saved("memory-owner"))).toBe(false);
    expect(fs.readFileSync(saved(file), "utf8")).toBe("old memory");
    fs.rmSync(saved(file));
    owner.clear();
    owner.refresh(true);
    expect(owner.ready).toBe(true);
  },
);

it("does not claim an owner until memory is enabled and a write succeeds", () => {
  const owner = new MemoryOwner(dir);
  owner.verify("sample", false);
  expect(owner.ready).toBe(false);
  fs.mkdirSync(saved("memory-owner"));
  owner.refresh(true);
  expect(owner.state).toBe("locked");
  fs.rmdirSync(saved("memory-owner"));
  owner.refresh(true);
  expect(owner.ready).toBe(true);
});
