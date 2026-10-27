/**
 * The administrator's policy on a Mac (design §9.4) with a fake lstat and loader: "not there" (folder or file) is
 * the only answer that leaves Ember unlocked without a policy; a folder that isn't a real root-owned folder writable
 * only by root, a link where the file should be, or a folder that can't be checked locks Ember down; otherwise
 * admin.ts's own loader reads the file with its root-owner check. A development override skips all of it.
 */

import { describe, expect, it, vi } from "vitest";
import { POLICY_FILE, POLICY_FOLDER, darwinAdminPolicy, type PolicyStat } from "../../app/main/platform/darwin/system/admin-policy";
import type { LoadedAdminPolicy } from "../../app/main/admin";

const enoent = () => Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
const eacces = () => Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });

function stat(o: { dir?: boolean; link?: boolean; uid?: number; mode?: number } = {}): PolicyStat {
  return {
    uid: o.uid ?? 0, mode: o.mode ?? (o.dir ? 0o40755 : 0o100644),
    isDirectory: () => !!o.dir && !o.link, isSymbolicLink: () => !!o.link, isFile: () => !o.dir && !o.link,
  };
}

const LOADED: LoadedAdminPolicy = { policy: { features: {}, neverLook: ["x"], confirmEveryAction: false, allowGrants: true, models: {} }, source: POLICY_FILE };

function source(entries: Record<string, PolicyStat | (() => never)>) {
  const lstat = vi.fn((p: string): PolicyStat => {
    const e = entries[p];
    if (!e) throw enoent();
    if (typeof e === "function") return e();
    return e;
  });
  const load = vi.fn((_file: string, _o: { requireRootOwned: boolean }) => LOADED);
  return { policy: darwinAdminPolicy({ lstat, load }), lstat, load };
}

const isLockdown = (r: LoadedAdminPolicy) => r.error !== undefined && r.policy.features.actions === false && r.policy.confirmEveryAction === true;

describe("darwinAdminPolicy", () => {
  it("lives in /Library/Application Support/Ember", () => {
    expect(darwinAdminPolicy().location).toBe("/Library/Application Support/Ember/policy.json");
    expect(POLICY_FOLDER).toBe("/Library/Application Support/Ember");
  });

  it("has no policy when the folder isn't there", () => {
    const { policy, load } = source({});
    expect(policy.load()).toEqual({ policy: expect.objectContaining({ allowGrants: true, confirmEveryAction: false }), source: null });
    expect(load).not.toHaveBeenCalled();
  });

  it("has no policy when the folder is there and the file isn't", () => {
    const { policy, load } = source({ [POLICY_FOLDER]: stat({ dir: true }) });
    expect(policy.load().source).toBeNull();
    expect(load).not.toHaveBeenCalled();
  });

  it("reads the file with admin.ts's root-owner check when folder and file are in order", () => {
    const { policy, load } = source({ [POLICY_FOLDER]: stat({ dir: true }), [POLICY_FILE]: stat() });
    expect(policy.load()).toBe(LOADED);
    expect(load).toHaveBeenCalledWith(POLICY_FILE, { requireRootOwned: true });
  });

  it("locks down for a folder that isn't root's, is writable by group or others, or is a link", () => {
    for (const folder of [stat({ dir: true, uid: 501 }), stat({ dir: true, mode: 0o40775 }), stat({ dir: true, mode: 0o40757 }), stat({ dir: true, link: true }), stat()]) {
      const { policy, load } = source({ [POLICY_FOLDER]: folder, [POLICY_FILE]: stat() });
      const r = policy.load();
      expect(isLockdown(r)).toBe(true);
      expect(r.source).toBe(POLICY_FOLDER);
      expect(r.error).toBe("/Library/Application Support/Ember must belong to root and be writable only by root");
      expect(load).not.toHaveBeenCalled();
    }
  });

  it("locks down when the folder or the file can't be checked", () => {
    let r = source({ [POLICY_FOLDER]: () => { throw eacces(); } }).policy.load();
    expect(isLockdown(r)).toBe(true);
    expect(r.error).toMatch(/can't check \/Library\/Application Support\/Ember: EACCES/);
    r = source({ [POLICY_FOLDER]: stat({ dir: true }), [POLICY_FILE]: () => { throw eacces(); } }).policy.load();
    expect(isLockdown(r)).toBe(true);
    expect(r.source).toBe(POLICY_FILE);
  });

  it("locks down for a link or a folder where the file should be", () => {
    for (const file of [stat({ link: true }), stat({ dir: true })]) {
      const { policy, load } = source({ [POLICY_FOLDER]: stat({ dir: true }), [POLICY_FILE]: file });
      const r = policy.load();
      expect(isLockdown(r)).toBe(true);
      expect(r.error).toMatch(/must be a file, not a link or a folder/);
      expect(load).not.toHaveBeenCalled();
    }
  });

  it("reads a development override without the owner checks, touching nothing else", () => {
    const { policy, load, lstat } = source({});
    expect(policy.load("/tmp/dev-policy.json")).toBe(LOADED);
    expect(load).toHaveBeenCalledWith("/tmp/dev-policy.json", { requireRootOwned: false });
    expect(lstat).not.toHaveBeenCalled();
  });

  it("reads a real policy file through admin.ts (development override)", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-policy-"));
    try {
      const file = path.join(dir, "policy.json");
      fs.writeFileSync(file, JSON.stringify({ confirmEveryAction: true }));
      const r = darwinAdminPolicy().load(file);
      expect(r.error).toBeUndefined();
      expect(r.policy.confirmEveryAction).toBe(true);
      fs.writeFileSync(file, "{ not json");
      expect(isLockdown(darwinAdminPolicy().load(file))).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads the provider key from its key file, else EMBER_PROVIDER_API_KEY", () => {
    const p = darwinAdminPolicy();
    const before = process.env.EMBER_PROVIDER_API_KEY;
    process.env.EMBER_PROVIDER_API_KEY = "from-env";
    try {
      expect(p.providerApiKey({ type: "openai", baseUrl: "https://llm.example.com/v1" })).toBe("from-env");
    } finally {
      if (before === undefined) delete process.env.EMBER_PROVIDER_API_KEY;
      else process.env.EMBER_PROVIDER_API_KEY = before;
    }
  });
});
