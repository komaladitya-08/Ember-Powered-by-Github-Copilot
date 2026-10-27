/**
 * The administrator's policy while Ember runs (review #112): read again every 10 seconds, as the remote's helper does;
 * once what it says changes (two reads in a row say the same new thing, or three in a row differ from the first), Ember
 * holds itself locked down (it stops, acts in nothing, runs no command, listens to nothing and connects to no model
 * service) and asks for a restart, which reads the new policy whole. One bad read (a file caught mid-write, a registry
 * read that failed once) changes nothing.
 */

import { describe, expect, it, vi } from "vitest";
import { AdminPolicySchema, commandMode, heldUntilRestart, lockedDown, modelServiceRefusal, parseAdminPolicy, samePolicy, type LoadedAdminPolicy } from "../../app/main/admin";
import { ADMIN_WATCH_MS, watchAdminPolicy } from "../../app/main/policy/admin-watch";

const FILE = "/etc/ember/policy.json";
const none: LoadedAdminPolicy = { policy: AdminPolicySchema.parse({}), source: null };
const policy = (raw: object) => parseAdminPolicy(JSON.stringify(raw), FILE);

describe("samePolicy", () => {
  it("tells a change from the same policy read again", () => {
    const a = policy({ neverLook: ["KeePassXC"] });
    expect(samePolicy(a, policy({ neverLook: ["KeePassXC"] }))).toBe(true);
    expect(samePolicy(a, policy({ neverLook: ["KeePassXC", "Remmina"] }))).toBe(false);
    expect(samePolicy(none, policy({}))).toBe(false);
    expect(samePolicy(lockedDown(FILE, "broken"), lockedDown(FILE, "broken"))).toBe(true);
    expect(samePolicy(lockedDown(FILE, "broken"), policy({}))).toBe(false);
  });
});

describe("heldUntilRestart", () => {
  it("is the lockdown, naming where the new policy is and asking for a restart", () => {
    const held = heldUntilRestart(policy({ confirmEveryAction: true }));
    expect(held.policy).toEqual(lockedDown(FILE, "x").policy);
    expect(held.source).toBe(FILE);
    expect(held.held).toBe(true);
    expect(held.error).toMatch(/changed while Ember was running/);
    expect(heldUntilRestart(none).source).toBe("the administrator's policy");
    for (const k of ["local", "wsl", "ssh"] as const) expect(commandMode(held, k)).toBe("off");
    expect(modelServiceRefusal(held)).toMatch(/Restart Ember/);
  });
});

describe("watchAdminPolicy", () => {
  it("reads the policy every 10 s and reports a change once, with what it now says", () => {
    vi.useFakeTimers();
    try {
      let now = policy({ commands: { local: "on" } });
      const seen: LoadedAdminPolicy[] = [];
      const stop = watchAdminPolicy({ first: policy({ commands: { local: "on" } }), read: () => now, onChange: l => seen.push(l) });
      vi.advanceTimersByTime(ADMIN_WATCH_MS * 3);
      expect(seen).toEqual([]);
      // The administrator turns commands off: the next read says so again, and the change is reported.
      now = policy({ commands: { local: "off" } });
      vi.advanceTimersByTime(ADMIN_WATCH_MS);
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(ADMIN_WATCH_MS);
      expect(seen).toHaveLength(1);
      expect(seen[0].policy.commands?.local).toBe("off");
      // Reported once: a restart reads it whole; later reads change nothing more.
      now = policy({ commands: { local: "ask" } });
      vi.advanceTimersByTime(ADMIN_WATCH_MS * 3);
      expect(seen).toHaveLength(1);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a broken policy fixed (and a policy that appears or goes) as a change too", () => {
    vi.useFakeTimers();
    try {
      let now: LoadedAdminPolicy = lockedDown(FILE, "broken");
      const seen: LoadedAdminPolicy[] = [];
      const stop = watchAdminPolicy({ first: now, read: () => now, onChange: l => seen.push(l) });
      now = policy({});
      vi.advanceTimersByTime(ADMIN_WATCH_MS * 2);
      expect(seen).toHaveLength(1);
      stop();
      const gone: LoadedAdminPolicy[] = [];
      let p: LoadedAdminPolicy = policy({});
      const stop2 = watchAdminPolicy({ first: p, read: () => p, onChange: l => gone.push(l) });
      p = none;
      vi.advanceTimersByTime(ADMIN_WATCH_MS * 2);
      expect(gone).toHaveLength(1);
      stop2();
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts a read that throws as a policy that can't be used (fail closed), and stops when told", () => {
    vi.useFakeTimers();
    try {
      const seen: LoadedAdminPolicy[] = [];
      let fail = false;
      const stop = watchAdminPolicy({ first: none, read: () => { if (fail) throw new Error("registry gone"); return none; }, onChange: l => seen.push(l) });
      fail = true;
      vi.advanceTimersByTime(ADMIN_WATCH_MS);
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(ADMIN_WATCH_MS);
      expect(seen).toHaveLength(1);
      expect(seen[0].error).toMatch(/registry gone/);
      stop();
      const quiet: LoadedAdminPolicy[] = [];
      let q = none;
      const stopped = watchAdminPolicy({ first: none, read: () => q, onChange: l => quiet.push(l) });
      stopped();
      q = policy({});
      vi.advanceTimersByTime(ADMIN_WATCH_MS * 2);
      expect(quiet).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets one bad read pass: a policy caught mid-write, then read whole again, changes nothing", () => {
    vi.useFakeTimers();
    try {
      const first = policy({ neverLook: ["KeePassXC"] });
      const reads: (() => LoadedAdminPolicy)[] = [
        () => first,
        () => parseAdminPolicy('{"neverLook": ["Kee', FILE),
        () => first,
        () => { throw new Error("koffi: the registry read failed"); },
        () => first,
        () => first,
      ];
      let n = 0;
      const seen: LoadedAdminPolicy[] = [];
      const stop = watchAdminPolicy({ first, read: () => reads[Math.min(n++, reads.length - 1)](), onChange: l => seen.push(l) });
      vi.advanceTimersByTime(ADMIN_WATCH_MS * 10);
      expect(seen).toEqual([]);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("still holds when the reads keep differing from the first, though not in the same way (fail closed)", () => {
    vi.useFakeTimers();
    try {
      const first = policy({});
      let n = 0;
      const seen: LoadedAdminPolicy[] = [];
      const stop = watchAdminPolicy({ first, read: () => lockedDown(FILE, `garbled ${n++}`), onChange: l => seen.push(l) });
      vi.advanceTimersByTime(ADMIN_WATCH_MS * 2);
      expect(seen).toEqual([]);
      vi.advanceTimersByTime(ADMIN_WATCH_MS);
      expect(seen).toHaveLength(1);
      expect(seen[0].error).toBe("garbled 2");
      stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
