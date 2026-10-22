import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRemotePolicy, PolicyWatch, serveRefusal, type PolicyIo } from "../../app/remote/admin";
import { createRemoteAudit, wireEntry } from "../../app/remote/audit";
import { consentAccepted, recordConsent } from "../../app/remote/consent";
import { ADMIN_POLICY_PATHS, AdminPolicySchema, commandMode, parseAdminPolicy, type LoadedAdminPolicy } from "../../app/main/admin";
import { OP_SCHEMAS } from "../../app/main/remote/protocol";
import type { Logger } from "../../app/main/logger";

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

/** A machine whose policy file is `raw` (null: none) and whose folders are as given. */
function machine(raw: string | null, dirs: Record<string, { uid: number; mode: number; symlink?: boolean }> = {}) {
  const loads: { file: string; requireRootOwned: boolean }[] = [];
  const io: PolicyIo = {
    load(file, o) {
      loads.push({ file, requireRootOwned: o.requireRootOwned });
      return raw === null ? { policy: AdminPolicySchema.parse({}), source: null } : parseAdminPolicy(raw, file);
    },
    lstat: p => (dirs[p] ? { dir: true, symlink: !!dirs[p].symlink, uid: dirs[p].uid, mode: dirs[p].mode } : null),
  };
  return { io, loads };
}

describe("the remote's own policy (§5.3.8)", () => {
  it("is read from ADMIN_POLICY_PATHS for its OS, root-owned only", () => {
    const linux = machine('{"commands":{"ssh":"ask"}}');
    const l = loadRemotePolicy("linux", linux.io);
    expect(linux.loads).toEqual([{ file: ADMIN_POLICY_PATHS.linux, requireRootOwned: true }]);
    expect(commandMode(l, "ssh")).toBe("ask");
    const mac = machine('{"commands":{"ssh":"on"}}', { "/Library/Application Support/Ember": { uid: 0, mode: 0o40755 } });
    expect(commandMode(loadRemotePolicy("darwin", mac.io), "ssh")).toBe("on");
    expect(mac.loads[0].file).toBe(ADMIN_POLICY_PATHS.darwin);
  });

  it("locks down on a Mac whose policy folder a user could change", () => {
    for (const dir of [{ uid: 501, mode: 0o40755 }, { uid: 0, mode: 0o40777 }, { uid: 0, mode: 0o40755, symlink: true }]) {
      const mac = machine('{"commands":{"ssh":"on"}}', { "/Library/Application Support/Ember": dir });
      const loaded = loadRemotePolicy("darwin", mac.io);
      expect(loaded.error).toMatch(/must be a folder that belongs to root/);
      expect(commandMode(loaded, "ssh")).toBe("off");
      expect(mac.loads).toEqual([]);
    }
  });

  it("refuses to serve on a broken policy or one that turns SSH off, and serves without one (R5)", () => {
    const broken = loadRemotePolicy("linux", machine("{ nope").io);
    expect(serveRefusal(broken, "build-01")).toMatch(/^build-01's Ember policy is broken: \/etc\/ember\/policy\.json is not valid JSON/);
    expect(serveRefusal(loadRemotePolicy("linux", machine('{"features":{"ssh":false}}').io), "build-01")).toBe("This computer's administrator doesn't allow Ember here.");
    const none = loadRemotePolicy("linux", machine(null).io);
    expect(serveRefusal(none, "build-01")).toBeNull();
    expect(commandMode(none, "ssh")).toBe("on");
    // A policy that exists but never mentions commands turns them off (R5).
    expect(commandMode(loadRemotePolicy("linux", machine('{"neverLook":["KeePassXC"]}').io), "ssh")).toBe("off");
  });

  it("is read again and reports a change once", () => {
    let raw = '{"commands":{"ssh":"on"}}';
    const changes: string[] = [];
    const watch = new PolicyWatch(() => parseAdminPolicy(raw, "/etc/ember/policy.json"), (_l, s) => changes.push(s.commands.ssh));
    expect(watch.refresh()).toBe(false);
    raw = '{"commands":{"ssh":"off"}}';
    expect(watch.refresh()).toBe(true);
    expect(watch.refresh()).toBe(false);
    expect(changes).toEqual(["off"]);
    expect(commandMode(watch.current as LoadedAdminPolicy, "ssh")).toBe("off");
  });
});

describe("the remote's audit log", () => {
  let dir = "";
  afterEach(() => { if (dir) fs.rmSync(dir, { recursive: true, force: true }); dir = ""; });

  it("writes every entry with the PC's reported name, marked unverified, and its id", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-remote-audit-"));
    const audit = createRemoteAudit({ dir: path.join(dir, "audit"), retentionDays: 30, source: () => ({ from: "ana-laptop", pcId: "a".repeat(32) }), log: quiet });
    expect(audit.write({ event: "command", phase: "start", runId: "0123456789abcdef" })).toBe(true);
    const [entry] = audit.recent(5);
    expect(entry).toMatchObject({ event: "command", phase: "start", from: "ana-laptop", fromUnverified: true, pcId: "a".repeat(32) });
    expect(fs.readdirSync(path.join(dir, "audit"))).toHaveLength(1);
  });

  it("reports a write it couldn't make, so the step is refused (write-ahead)", () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-remote-audit-"));
    fs.writeFileSync(path.join(dir, "audit"), "a file where the folder should be");
    const audit = createRemoteAudit({ dir: path.join(dir, "audit"), retentionDays: 30, source: () => ({ from: "", pcId: "" }), log: quiet });
    expect(audit.write({ event: "action" })).toBe(false);
    expect(audit.recent(5)).toEqual([]);
  });

  it("shapes entries to audit.recent's schema however long or deep they are", () => {
    const e = wireEntry({ event: "x", long: "y".repeat(5000), deep: { a: { b: { c: 1 } } }, n: Infinity, list: [1, "two", { three: 3 }] });
    expect((e.long as string).length).toBe(4000);
    expect(e.n).toBeNull();
    const ok = OP_SCHEMAS["audit.recent"].result.safeParse({ entries: [e] });
    expect(ok.success).toBe(true);
  });
});

describe("the remote's consent record", () => {
  it("accepts the PC's per-host consent from version 1, and records it once per PC and version", () => {
    expect(consentAccepted({ version: 0 })).toBe(false);
    expect(consentAccepted({ version: 1 })).toBe(true);
    const files = new Map<string, string>();
    const io = { read: (f: string) => files.get(f) ?? null, write: (f: string, t: string) => { files.set(f, t); } };
    const rec = { version: 1, from: "ana-laptop", pcId: "a".repeat(32), at: "2026-10-22T10:00:00Z", user: "deploy" };
    expect(recordConsent("/s/consent.json", rec, io)).toBe(true);
    expect(recordConsent("/s/consent.json", { ...rec, at: "later" }, io)).toBe(false);
    expect(recordConsent("/s/consent.json", { ...rec, pcId: "b".repeat(32) }, io)).toBe(true);
    expect(JSON.parse(files.get("/s/consent.json")!)).toMatchObject({ pcId: "b".repeat(32), user: "deploy" });
  });
});
