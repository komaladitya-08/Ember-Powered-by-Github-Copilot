import { describe, expect, it } from "vitest";
import { stampText, sweepOrphans, type OrphanIo } from "../../app/remote/orphans";
import { readTable, STALL_MS, WatchTable, watchdogCheck, type WatchdogActions } from "../../app/remote/watchdog";

const RUN_A = "0123456789abcdef";
const RUN_B = "fedcba9876543210";

/** A runs folder in memory and a process table. */
function folder(stamps: Record<string, string>, procs: Record<number, string>) {
  const files = new Map(Object.entries(stamps));
  const swept: string[] = [];
  const io: OrphanIo = {
    list: () => [...files.keys()],
    read: n => files.get(n) ?? null,
    remove: n => { files.delete(n); },
    startOf: pid => procs[pid] ?? null,
    sweep: async runId => { swept.push(runId); },
  };
  return { files, swept, io };
}

describe("the orphan sweep (critique remote-8)", () => {
  it("kills the runs of an agent that is gone and removes their stamps", async () => {
    const f = folder({ [RUN_A]: stampText(77, "111"), [RUN_B]: stampText(88, "222") }, { 88: "222" });
    expect(await sweepOrphans(f.io)).toEqual([RUN_A]);
    expect(f.swept).toEqual([RUN_A]);
    expect([...f.files.keys()]).toEqual([RUN_B]);
  });

  it("counts a pid reused by another process as gone", async () => {
    const f = folder({ [RUN_A]: stampText(77, "111") }, { 77: "999" });
    expect(await sweepOrphans(f.io)).toEqual([RUN_A]);
  });

  it("sweeps a run whose stamp can't be read, and removes names no run has without sweeping", async () => {
    const f = folder({ [RUN_A]: "garbage", "../etc": "x", "notes.txt": "x" }, {});
    expect(await sweepOrphans(f.io)).toEqual([RUN_A]);
    expect(f.swept).toEqual([RUN_A]);
    expect(f.files.size).toBe(0);
  });
});

describe("the watchdog (§3.13)", () => {
  /** A watchdog's view of `table` with recorded actions on a clock the test moves. */
  function watch(table: WatchTable, agentPid = 4000) {
    const log: string[] = [];
    let now = 0;
    const act: WatchdogActions = {
      kill: (pid, signal) => { log.push(`kill ${pid} ${signal}`); },
      killSession: sid => { log.push(`session ${sid}`); },
      sweep: runId => { log.push(`sweep ${runId}`); },
      now: () => now,
    };
    const view = new Int32Array(table.sab);
    const state = { beat: readTable(view).beat, since: 0 };
    return { log, check: (at: number) => { now = at; return watchdogCheck(view, agentPid, act, state); } };
  }

  it("keeps quiet while the main loop beats", () => {
    const table = new WatchTable();
    table.add(RUN_A, 501);
    const w = watch(table);
    for (let t = 250; t <= 10_000; t += 250) {
      table.beat();
      expect(w.check(t)).toBe(false);
    }
    expect(w.log).toEqual([]);
  });

  it("after a 2 s stall kills every run's group and session, then sweeps them, and only then the agent", () => {
    const table = new WatchTable();
    const a = table.add(RUN_A, 501)!;
    table.session(a, 502);
    table.add(RUN_B, 601);
    const w = watch(table);
    expect(w.check(STALL_MS)).toBe(false);
    expect(w.check(STALL_MS + 1)).toBe(true);
    expect(w.log).toEqual([
      "kill -501 SIGKILL", "session 502",
      "kill -601 SIGKILL",
      `sweep ${RUN_A}`, `sweep ${RUN_B}`,
      "kill 4000 SIGKILL",
    ]);
  });

  it("forgets runs that ended and refuses what isn't a run", () => {
    const table = new WatchTable();
    const a = table.add(RUN_A, 501)!;
    table.remove(a);
    expect(table.add("not-a-run-id", 5)).toBeNull();
    expect(table.add(RUN_B, 1)).toBeNull();
    const w = watch(table);
    w.check(STALL_MS + 1);
    expect(w.log).toEqual(["kill 4000 SIGKILL"]);
  });

  it("round-trips run ids with the high bit set through the shared table", () => {
    const table = new WatchTable();
    table.add("ffffffff80000001", 900);
    expect(readTable(new Int32Array(table.sab)).runs).toEqual([{ pgid: 900, sid: 0, runId: "ffffffff80000001" }]);
  });
});
