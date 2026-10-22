import { describe, expect, it } from "vitest";
import { environHasRun, psEnvironmentPids, sweepLocal, sweepScript, type SweepDeps } from "../../app/main/commands/run/sweep";

const RUN = "0123456789abcdef";
const OTHER = "fedcba9876543210";
const env = (...entries: string[]) => Buffer.from(`${entries.join("\0")}\0`);

describe("the sweep script fed to a distro's or a remote's shell", () => {
  it("is §3.13's fixed text, run as sh -s -- <SIGNAL> <runId> with nothing on its argv", () => {
    expect(sweepScript).toBe('for p in /proc/[0-9]*; do grep -qz "^EMBER_RUN_ID=$2\\$" "$p/environ" 2>/dev/null && kill -$1 "${p#/proc/}" 2>/dev/null; done\n');
    expect(sweepScript).not.toContain(RUN);
  });
});

describe("environHasRun", () => {
  it("finds the marker as a whole entry anywhere in the block", () => {
    expect(environHasRun(env(`EMBER_RUN_ID=${RUN}`, "PATH=/usr/bin"), RUN)).toBe(true);
    expect(environHasRun(env("PATH=/usr/bin", `EMBER_RUN_ID=${RUN}`, "TERM=xterm"), RUN)).toBe(true);
    expect(environHasRun(Buffer.from(`HOME=/h\0EMBER_RUN_ID=${RUN}`), RUN)).toBe(true);
  });

  it("doesn't take another run's marker, a longer value or the text inside another variable", () => {
    expect(environHasRun(env(`EMBER_RUN_ID=${OTHER}`), RUN)).toBe(false);
    expect(environHasRun(env(`EMBER_RUN_ID=${RUN}0`), RUN)).toBe(false);
    expect(environHasRun(env(`X_EMBER_RUN_ID=${RUN}`), RUN)).toBe(false);
    expect(environHasRun(env(`CMD=echo EMBER_RUN_ID=${RUN}`), RUN)).toBe(false);
    expect(environHasRun(new Uint8Array(0), RUN)).toBe(false);
  });
});

describe("psEnvironmentPids (macOS's ps -E -ww -o pid=,command=)", () => {
  it("lists the processes whose environment carries the marker, named by their command", () => {
    const text = [
      `  501 /bin/zsh -f -c set +f; export PAGER=cat PATH=/usr/bin:/bin TERM=xterm-256color EMBER_RUN_ID=${RUN} SHELL=/bin/sh`,
      `  502 sleep 1000 PATH=/usr/bin EMBER_RUN_ID=${RUN}`,
      `  503 sleep 1000 PATH=/usr/bin EMBER_RUN_ID=${OTHER}`,
      `  504 /Applications/Ember.app/Contents/MacOS/Ember --type=renderer HOME=/Users/ana`,
      `  505 /usr/bin/python3 -c print("EMBER_RUN_ID=${RUN}x") TERM=dumb`,
      "",
    ].join("\n");
    expect(psEnvironmentPids(text, RUN)).toEqual([{ pid: 501, name: "zsh" }, { pid: 502, name: "sleep" }]);
  });
});

/** A fake /proc and process table. */
function fakeDeps(over: Partial<SweepDeps> = {}) {
  const killed: [number, NodeJS.Signals][] = [];
  const runs: [string, string[]][] = [];
  const proc: Record<string, Uint8Array | Error> = {
    "/proc/1/environ": env(`EMBER_RUN_ID=${RUN}`), // init never
    "/proc/100/environ": env("HOME=/h", `EMBER_RUN_ID=${RUN}`),
    "/proc/100/comm": Buffer.from("bash\n"),
    "/proc/101/environ": env(`EMBER_RUN_ID=${RUN}`),
    "/proc/101/comm": Buffer.from("sleep\n"),
    "/proc/102/environ": env(`EMBER_RUN_ID=${OTHER}`),
    "/proc/103/environ": Object.assign(new Error("EACCES"), { code: "EACCES" }), // another user's
    "/proc/104/environ": env(`EMBER_RUN_ID=${RUN}`), // Ember itself (never, though it can't carry it)
    "/proc/105/environ": env(`EMBER_RUN_ID=${RUN}`), // gone before its name was read
  };
  const deps: SweepDeps = {
    os: "linux",
    uid: 1000,
    self: [104],
    readdir: async () => ["1", "100", "101", "102", "103", "104", "105", "self", "sys", "acpi"],
    readFile: async file => {
      const v = proc[file];
      if (!v) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (v instanceof Error) throw v;
      return v;
    },
    run: async (file, args) => {
      runs.push([file, args]);
      return { code: 0, stdout: "" };
    },
    kill: (pid, signal) => {
      if (pid === 101 && signal === "SIGTERM") throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      killed.push([pid, signal]);
    },
    ...over,
  };
  return { deps, killed, runs };
}

describe("sweepLocal", () => {
  it("finds the run's processes in /proc on Linux and signals each, never pid 1 or Ember itself", async () => {
    const f = fakeDeps();
    await expect(sweepLocal(RUN, "SIGKILL", f.deps)).resolves.toEqual([{ pid: 100, name: "bash" }, { pid: 101, name: "sleep" }, { pid: 105, name: "105" }]);
    expect(f.killed).toEqual(expect.arrayContaining([[100, "SIGKILL"], [101, "SIGKILL"], [105, "SIGKILL"]]));
    expect(f.killed).toHaveLength(3);
  });

  it("only looks when no signal is given, and survives a process that is already gone", async () => {
    const f = fakeDeps();
    await expect(sweepLocal(RUN, null, f.deps)).resolves.toHaveLength(3);
    expect(f.killed).toEqual([]);
    const g = fakeDeps();
    await expect(sweepLocal(RUN, "SIGTERM", g.deps)).resolves.toHaveLength(3);
    expect(g.killed.map(k => k[0]).sort()).toEqual([100, 105]);
  });

  it("asks ps -E for the user's own processes on macOS", async () => {
    const f = fakeDeps({
      os: "darwin",
      uid: 501,
      run: async (file, args) => {
        f.runs.push([file, args]);
        return { code: 0, stdout: `  700 sleep 1000 TERM=dumb EMBER_RUN_ID=${RUN}\n  701 zsh EMBER_RUN_ID=${OTHER}\n` };
      },
    });
    await expect(sweepLocal(RUN, "SIGTERM", f.deps)).resolves.toEqual([{ pid: 700, name: "sleep" }]);
    expect(f.runs).toEqual([["/bin/ps", ["-E", "-ww", "-U", "501", "-o", "pid=,command="]]]);
    expect(f.killed).toEqual([[700, "SIGTERM"]]);
  });

  it("finds nothing on Windows (the job object holds the tree), for a malformed run id, or when /proc can't be listed", async () => {
    await expect(sweepLocal(RUN, "SIGKILL", fakeDeps({ os: "win32" }).deps)).resolves.toEqual([]);
    const f = fakeDeps();
    await expect(sweepLocal("abc", "SIGKILL", f.deps)).resolves.toEqual([]);
    await expect(sweepLocal(`${RUN}" ; rm -rf ~`, "SIGKILL", f.deps)).resolves.toEqual([]);
    expect(f.killed).toEqual([]);
    await expect(sweepLocal(RUN, "SIGKILL", fakeDeps({ readdir: async () => { throw new Error("no /proc"); } }).deps)).resolves.toEqual([]);
  });
});
