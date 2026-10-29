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
import { SCAN_MAX, SSH_MAX, sshDestination, userSshProcessesWith, type NoticeDeps } from "../../app/main/remote/notice-ssh";
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
    // `read` comes back naming the distros the read covered (here none).
    expect(on.reads[0].o).toEqual({ wsl: { exe: "C:\\Program Files\\WSL\\wsl.exe", distros: ["Ubuntu"] }, read: new Set() });
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

  it("offers a destination again once its offer is let go unseen (R-stale-offer)", async () => {
    const r = rig();
    await r.n.check();
    r.n.release(seenKey({ dest: "build-01", via: "local" }));
    expect(r.n.offered.size).toBe(0);
    await r.n.check();
    expect(r.offered).toEqual([{ dest: "build-01", via: "local" }, { dest: "build-01", via: "local" }]);
  });

  it("says after each look which of the user's ssh run now, offered or not, so an offer for one that ended goes (R-stale-offer)", async () => {
    let procs: { pid: number; argv: string[]; via: SshSeen["via"] }[] | null = [
      { pid: 1, argv: ["ssh", "-V"], via: "local" }, { pid: 2, argv: ["ssh", "old-box"], via: "local" }, { pid: 3, argv: ["ssh", "db-02"], via: "wsl:Ubuntu" },
    ];
    const running: string[][] = [];
    const r = rig({
      notice: { sshDestination: argv => (argv.includes("-V") ? null : { dest: argv[argv.length - 1] }), userSshProcesses: async () => procs },
      dismissed: s => s.dest === "old-box", questionUp: () => true, running: keys => running.push([...keys]),
    });
    await r.n.check();
    procs = [];
    await r.n.check();
    // A list that can't be read says nothing: nobody can tell what ended.
    procs = null;
    await r.n.check();
    expect(running).toEqual([[seenKey({ dest: "old-box", via: "local" }), seenKey({ dest: "db-02", via: "wsl:Ubuntu" })], []]);
    expect(r.offered).toEqual([]);
  });

  it("says which places each look read in full: this computer's list, and only the WSL distros the read says it covered (R-stale-offer)", async () => {
    const vias: SshSeen["via"][] = [undefined, "local", "wsl:Ubuntu", "wsl:Debian", "wsl:Arch"];
    const said: boolean[][] = [];
    const running: NoticerDeps["running"] = (_keys, read) => { said.push(vias.map(v => read(v))); };
    const wsl = () => ({ exe: "C:\\Program Files\\WSL\\wsl.exe", distros: ["Ubuntu", "Debian"] });
    // Ubuntu read (or stopped); Debian's reader failed, so an ssh there may still run.
    const runtime = rig({
      wsl, running,
      notice: { sshDestination: () => null, userSshProcesses: async (_os, opt) => { opt?.read?.add("wsl:Ubuntu"); return []; } },
    });
    await runtime.n.check();
    // A reader that says nothing of WSL (SA's own) covers this computer only.
    const plain = rig({ wsl, running, notice: { sshDestination: () => null, userSshProcesses: async () => [] } });
    await plain.n.check();
    // With WSL off, there is no WSL place to read.
    const off = rig({ running, notice: { sshDestination: () => null, userSshProcesses: async () => [] } });
    await off.n.check();
    expect(said).toEqual([[true, true, true, false, false], [true, true, false, false, false], [true, true, false, false, false]]);
  });

  it("counts a place whose list came back full (the readers' cap) as not read: more ssh may run there (R-stale-offer)", async () => {
    const said: boolean[][] = [];
    const list = (n: number, via: SshSeen["via"]) => Array.from({ length: n }, (_, i) => ({ pid: i + 1, argv: ["ssh", `box-${i}`], via }));
    let procs = [...list(SSH_MAX, "local"), ...list(SSH_MAX - 1, "wsl:Ubuntu")];
    const r = rig({
      wsl: () => ({ exe: "C:\\Program Files\\WSL\\wsl.exe", distros: ["Ubuntu", "Debian"] }), running: (_keys, read) => { said.push([read("local"), read("wsl:Ubuntu"), read("wsl:Debian")]); },
      notice: { sshDestination: () => null, userSshProcesses: async (_os, opt) => { opt?.read?.add("wsl:Ubuntu"); opt?.read?.add("wsl:Debian"); return procs; } },
    });
    await r.n.check();
    procs = [...list(SSH_MAX - 1, "local"), ...list(SSH_MAX, "wsl:Debian")];
    await r.n.check();
    expect(said).toEqual([[false, true, true], [true, true, false]]);
  });

  it("takes no ssh as ended on a Linux computer with more processes than the read looks at (F-scanmax)", async () => {
    // SA's own reader over a /proc where the user's ssh to build-01 (pid 9000) comes after SCAN_MAX other processes.
    const pids = [...Array.from({ length: SCAN_MAX }, (_, i) => String(1000 + i)), "9000"];
    const proc: NoticeDeps = {
      readdir: () => ["self", ...pids],
      readFile: p => (p === "/proc/9000/comm" ? Buffer.from("ssh\n") : p === "/proc/9000/cmdline" ? Buffer.from("ssh\0build-01\0") : null),
      ownerUid: () => 1000, uid: 1000, run: async () => ({ code: 1, stdout: "" }),
    };
    const running: string[][] = [];
    const r = rig({ notice: { sshDestination, userSshProcesses: os => userSshProcessesWith(os, proc) }, running: keys => running.push([...keys]) });
    await r.n.check();
    // Not read whole: nothing is said to have ended (an offer for build-01 stays), and nothing is offered.
    expect(running).toEqual([]);
    expect(r.offered).toEqual([]);
  });

  it("keys a destination by user, host and port, the host without case", () => {
    expect(seenKey({ dest: "Deploy@Build-01" })).toBe(seenKey({ dest: "Deploy@build-01" }));
    expect(seenKey({ dest: "build-01", user: "deploy", port: 2222 })).not.toBe(seenKey({ dest: "build-01" }));
  });
});
