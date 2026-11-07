import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { githubMemoryAccount, MemoryEpochAccount, MemoryOwner } from "../../app/main/memory/owner";

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-memory-owner-")); });
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
const saved = (file = "memory.json") => path.join(dir, file);

it("keeps saved memory closed across restart until its verified account returns", () => {
  const first = new MemoryOwner(dir);
  first.verify(123, true);
  expect(first.ready).toBe(true);
  fs.writeFileSync(saved(), "owner data");
  expect(fs.readFileSync(saved("memory-owner"), "utf8").trim()).toMatch(/^[a-f0-9]{64}$/);

  const restarted = new MemoryOwner(dir);
  expect(restarted.state).toBe("locked");
  restarted.verify(456, true);
  expect(restarted.ready).toBe(false);
  expect(restarted.mayEraseOnSignOut).toBe(false);
  expect(fs.readFileSync(saved(), "utf8")).toBe("owner data");
  restarted.verify(123, false);
  expect(restarted.ready).toBe(true);
  restarted.pause();
  expect(restarted.ready).toBe(false);
  expect(restarted.mayEraseOnSignOut).toBe(true);
});

it.each(["memory.json", "memory.json.tmp", "memory.json.broken", "memory-vectors.json"])(
  "keeps unowned data in %s locked until explicit cleanup completes", file => {
    fs.writeFileSync(saved(file), "old memory");
    const owner = new MemoryOwner(dir);
    owner.verify(456, true);
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
  owner.verify(123, false);
  expect(owner.ready).toBe(false);
  fs.mkdirSync(saved("memory-owner"));
  owner.refresh(true);
  expect(owner.state).toBe("locked");
  fs.rmdirSync(saved("memory-owner"));
  owner.refresh(true);
  expect(owner.ready).toBe(true);
});

it("verifies the same authenticated login against GitHub and returns its stable account ID", async () => {
  const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ login: "Example", id: 123 }) }));
  expect(await githubMemoryAccount(fetch, "synthetic-token", "example")).toBe(123);
  expect(fetch).toHaveBeenCalledWith("https://api.github.com/user", expect.objectContaining({
    headers: expect.objectContaining({ Authorization: "Bearer synthetic-token" }), redirect: "error",
  }));
  expect(await githubMemoryAccount(fetch, "synthetic-token", "another-login")).toBeNull();
  fetch.mockRejectedValueOnce(new Error("unavailable"));
  expect(await githubMemoryAccount(fetch, "synthetic-token", "example")).toBeNull();
});

describe("why saved memory isn't open (memory-2, integrations-2)", () => {
  it("says Ember is checking while it connects, and names the model service or the missing answer, never another owner (memory-2)", () => {
    const first = new MemoryOwner(dir);
    first.verify(123, true);
    fs.writeFileSync(saved(), "owner data");
    const owner = new MemoryOwner(dir);
    expect([owner.state, owner.reason]).toEqual(["locked", "checking"]);
    owner.verify(null, true, "own-provider");
    expect([owner.state, owner.reason]).toEqual(["locked", "own-provider"]);
    owner.verify(null, true, "org-provider");
    expect(owner.reason).toBe("org-provider");
    owner.verify(null, true);
    expect(owner.reason).toBe("unverified");
    owner.pause("signed-out");
    expect(owner.reason).toBe("signed-out");
    owner.verify(123, true);
    expect([owner.state, owner.reason]).toEqual(["ready", null]);
    owner.pause();
    expect(owner.reason).toBe("checking");
    // Nothing saved: the same reasons, while memory waits.
    const empty = new MemoryOwner(fs.mkdtempSync(path.join(os.tmpdir(), "ember-memory-owner-empty-")));
    empty.verify(null, true, "own-provider");
    expect([empty.state, empty.reason]).toEqual(["waiting", "own-provider"]);
  });

  it("tells another account's memory apart from memory with no owner Ember can read (memory-2)", () => {
    const first = new MemoryOwner(dir);
    first.verify(123, true);
    fs.writeFileSync(saved(), "owner data");
    const other = new MemoryOwner(dir);
    other.verify(456, true);
    expect([other.state, other.reason]).toEqual(["locked", "other-account"]);
    fs.rmSync(saved("memory-owner"));
    other.refresh(true);
    expect([other.state, other.reason]).toEqual(["locked", "unowned"]);
  });
});

describe("whose memory Home shows (memory-8)", () => {
  it("keeps Home's memory epoch through a reconnect that finds the same account, and moves it on for another or none", () => {
    const account = new MemoryEpochAccount();
    // Ember starts: it checks, then finds the account (the epoch moves on to it).
    expect(account.paused()).toBe(false);
    expect(account.verified(123)).toBe(true);
    // A reconnect (a network retry, a runtime restart): checked again, the same account. A draft and focus stay.
    expect(account.paused()).toBe(false);
    expect(account.paused("checking")).toBe(false);
    expect(account.verified(123)).toBe(false);
    // A check that failed holds it too: whoever comes next decides.
    expect(account.paused("unverified")).toBe(false);
    expect(account.verified(null, "unverified")).toBe(false);
    expect(account.verified(123)).toBe(false);
    // Another account, or none: the epoch moves on, and Home lets go of what it held.
    expect(account.verified(456)).toBe(true);
    expect(account.verified(123)).toBe(true);
    expect(account.paused("signed-out")).toBe(true);
    expect(account.verified(123)).toBe(true);
    expect(account.verified(null, "own-provider")).toBe(true);
    expect(account.verified(123)).toBe(true);
    expect(account.verified(null, "org-provider")).toBe(true);
  });
});
