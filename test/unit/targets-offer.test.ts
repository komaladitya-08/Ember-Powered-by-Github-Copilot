/**
 * Noticing the user's own ssh (§2.7, targets/offer.ts): the process list is read only while SSH is allowed and the
 * offer switch is on, only when a terminal is in front and its title changed, at most once every 10 s (a change seen
 * meanwhile is checked once when they end, never in a loop); on Windows only for a title that looks like SSH and while
 * it may still help (critique integration-25); WSL's distros only with WSL on; each destination once per run, never a
 * dismissed or connected one, never over a question.
 */

import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../../app/main/logger";
import type { SshSeen } from "../../app/main/remote/types";
import { NOTICE_INTERVAL_MS, createNoticer, seenKey, sshLookingTitle, type NoticerDeps, type SshNotice } from "../../app/main/targets/offer";

const quiet: Logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined, child: () => quiet, file: "" };

/** A noticer over fakes; `procs` and the window are changed by the test. */
function rig(o: Partial<NoticerDeps> & { procs?: { pid: number; argv: string[]; via: SshSeen["via"] }[] | null } = {}) {
  let now = 100_000;
  let win: { app: string; title: string } | null = { app: "gnome-terminal-server", title: "ana@laptop: ~" };
  const offered: SshSeen[] = [];
  const reads: { os: string; o?: unknown }[] = [];
  const notice: SshNotice = {
    // The real parser is SA's: here the argv's last word is the destination, and "-V" means none.
    sshDestination: argv => (argv.includes("-V") ? null : { dest: argv[argv.length - 1] }),
    userSshProcesses: async (os, opt) => { reads.push({ os, o: opt }); return o.procs === undefined ? [{ pid: 1, argv: ["ssh", "build-01"], via: "local" }] : o.procs; },
  };
  const d: NoticerDeps = {
    os: "linux", log: quiet, notice, enabled: () => true, activeWindow: () => win,
    isTerminal: app => /terminal|konsole|wezterm/i.test(app), cimAllowed: () => true, wsl: () => null,
    dismissed: () => false, connected: () => false, questionUp: () => false, offer: s => offered.push(s), now: () => now,
    ...o,
  };
  const n = createNoticer(d);
  const flush = () => new Promise(r => setTimeout(r, 0));
  return {
    n, offered, reads, flush,
    window: (w: typeof win) => { win = w; },
    later: (ms: number) => { now += ms; },
  };
}

describe("when Ember looks for the user's own ssh", () => {
  it("looks when a terminal comes to the front or its title changes", async () => {
    const r = rig();
    r.n.tick();
    await r.flush();
    expect(r.reads).toHaveLength(1);
    expect(r.offered).toEqual([{ dest: "build-01", via: "local" }]);
  });

  it("doesn't look while the title stays the same, or in a window that isn't a terminal", async () => {
    const r = rig();
    r.n.tick();
    r.later(NOTICE_INTERVAL_MS + 1);
    r.n.tick();
    r.window({ app: "gedit", title: "notes.txt" });
    r.later(NOTICE_INTERVAL_MS + 1);
    r.n.tick();
    await r.flush();
    expect(r.reads).toHaveLength(1);
  });

  it("looks at most once every 10 s, then once more for a change it saw meanwhile (not in a loop)", async () => {
    const r = rig({ procs: [] });
    r.n.tick();
    await r.flush();
    r.later(2000);
    r.window({ app: "gnome-terminal-server", title: "deploy@build-01: ~" });
    r.n.tick();
    expect(r.reads).toHaveLength(1);
    r.later(NOTICE_INTERVAL_MS);
    r.n.tick();
    expect(r.reads).toHaveLength(2);
    await r.flush();
    r.later(NOTICE_INTERVAL_MS);
    r.n.tick();
    r.n.tick();
    await r.flush();
    expect(r.reads).toHaveLength(2);
  });

  it("never looks while SSH isn't allowed or the offer switch is off, or without SA's functions", async () => {
    const off = rig({ enabled: () => false });
    off.n.tick();
    const none = rig({ notice: null });
    none.n.tick();
    await off.flush();
    expect(off.reads).toHaveLength(0);
    expect(none.offered).toHaveLength(0);
  });

  it("on Windows, starts the process query only for a title that looks like SSH, and only while it may still help", async () => {
    const r = rig({ os: "win32" });
    r.window({ app: "WindowsTerminal.exe", title: "Windows PowerShell" });
    r.n.tick();
    r.later(NOTICE_INTERVAL_MS + 1);
    r.window({ app: "WindowsTerminal.exe", title: "ana@build-01: ~" });
    r.n.tick();
    await r.flush();
    expect(r.reads).toEqual([{ os: "win32", o: undefined }]);
    const done = rig({ os: "win32", cimAllowed: () => false });
    done.window({ app: "WindowsTerminal.exe", title: "ssh build-01" });
    done.n.tick();
    await done.flush();
    expect(done.reads).toHaveLength(0);
    expect(sshLookingTitle("ssh build-01")).toBe(true);
    expect(sshLookingTitle("ana@build-01: ~")).toBe(true);
    expect(sshLookingTitle("Windows PowerShell")).toBe(false);
  });

  it("reads WSL's running distros only when WSL is on", async () => {
    const off = rig();
    off.n.tick();
    const on = rig({ wsl: () => ({ exe: "C:\\Program Files\\WSL\\wsl.exe", distros: ["Ubuntu"] }) });
    on.n.tick();
    const none = rig({ wsl: () => ({ exe: "C:\\Program Files\\WSL\\wsl.exe", distros: [] }) });
    none.n.tick();
    await on.flush();
    expect(off.reads[0].o).toBeUndefined();
    expect(on.reads[0].o).toEqual({ wsl: { exe: "C:\\Program Files\\WSL\\wsl.exe", distros: ["Ubuntu"] } });
    expect(none.reads[0].o).toBeUndefined();
  });
});

describe("what Ember offers", () => {
  it("offers each destination once per run", async () => {
    const r = rig();
    await r.n.check();
    await r.n.check();
    expect(r.offered).toHaveLength(1);
    expect(r.n.offered.has(seenKey({ dest: "build-01", via: "local" }))).toBe(true);
  });

  it("skips dismissed and connected destinations, runs that name none, and offers the next", async () => {
    const r = rig({
      procs: [
        { pid: 1, argv: ["ssh", "-V"], via: "local" }, { pid: 2, argv: ["ssh", "old-box"], via: "local" },
        { pid: 3, argv: ["ssh", "build-01"], via: "local" }, { pid: 4, argv: ["ssh", "db-02"], via: "wsl:Ubuntu" },
      ],
      dismissed: s => s.dest === "old-box", connected: s => s.dest === "build-01",
    });
    await r.n.check();
    expect(r.offered).toEqual([{ dest: "db-02", via: "wsl:Ubuntu" }]);
  });

  it("never offers over a question: the destination comes back on the next look", async () => {
    let asking = true;
    const r = rig({ questionUp: () => asking });
    await r.n.check();
    expect(r.offered).toHaveLength(0);
    asking = false;
    await r.n.check();
    expect(r.offered).toHaveLength(1);
  });

  it("logs that it saw an ssh without its host", async () => {
    const info = vi.fn();
    const r = rig({ log: { ...quiet, info } });
    await r.n.check();
    expect(info).toHaveBeenCalledWith("remote.ssh_seen", { via: "local" });
    expect(JSON.stringify(info.mock.calls)).not.toContain("build-01");
  });

  it("survives a process list that can't be read, or a parser that throws", async () => {
    const r = rig({ procs: null });
    await r.n.check();
    const bad = rig({ notice: { sshDestination: () => { throw new Error("x"); }, userSshProcesses: async () => [{ pid: 1, argv: ["ssh"], via: "local" }] } });
    await bad.n.check();
    const failing = rig({ notice: { sshDestination: () => null, userSshProcesses: () => Promise.reject(new Error("ps")) } });
    await failing.n.check();
    expect([...r.offered, ...bad.offered, ...failing.offered]).toEqual([]);
  });

  it("keys a destination by user, host and port, the host without case", () => {
    expect(seenKey({ dest: "Deploy@Build-01" })).toBe(seenKey({ dest: "Deploy@build-01" }));
    expect(seenKey({ dest: "build-01", user: "deploy", port: 2222 })).not.toBe(seenKey({ dest: "build-01" }));
  });
});
