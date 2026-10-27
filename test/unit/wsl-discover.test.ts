/**
 * WSL discovery and the WSL service (app/main/wsl/{discover,service,doctor}.ts, design §4.1, §5.1.14, §8.8): which
 * wsl.exe, which distros (the registry first, `--list --verbose` with localised headers otherwise), which run
 * (`--list --running --quiet`, a localised "none running" sentence ignored), WSL's and WSLg's versions, hidden Docker
 * and Rancher distros, Podman as a tool distro, RunOOBE, the caches, the uid from inside, the boot ids, and the doctor
 * row. Every wsl.exe here is a fake; the tests check that discovery never starts a distro (no `-d` call).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  createWslExec, envGet, guiDisabled, HIDDEN_DISTRO, jobHostArgv, LIST_TIMEOUT_MS, locateWslExe, parseListVerbose, parseRunning, parseVersion, probeEnv,
} from "../../app/main/wsl/discover";
import { createWsl, createWslWith, windowsContextOf, type WslDeps } from "../../app/main/wsl/service";
import { parseTasklist, runningXServer, shortVersion, wslDoctorRows } from "../../app/main/wsl/doctor";
import { LXSS_KEY } from "../../app/main/wsl/lxss";
import { decodeLines } from "../../app/main/wsl/decode";
import { FACTS_SCRIPT } from "../../app/main/wsl/runner";
import type { WslFacts } from "../../app/main/wsl/types";
import { answerWith, fakeLog, FakeRegistry, fakeSpawn, flush, forbiddenOptions, utf16, type SpawnCall } from "./wsl-wa-fakes";

const EXE = "C:\\Program Files\\WSL\\wsl.exe";
const INBOX = "C:\\Windows\\System32\\wsl.exe";
const JOB = { execPath: "C:\\Program Files\\Ember\\Ember.exe", script: "C:\\Program Files\\Ember\\resources\\app\\job-host.cjs" };
const ENV: NodeJS.ProcessEnv = {
  ProgramFiles: "C:\\Program Files", SystemRoot: "C:\\Windows", USERPROFILE: "C:\\Users\\ana", LOCALAPPDATA: "C:\\Users\\ana\\AppData\\Local",
  APPDATA: "C:\\Users\\ana\\AppData\\Roaming", TEMP: "C:\\Users\\ana\\AppData\\Local\\Temp", Path: "C:\\Windows\\System32",
  GH_TOKEN: "ghp_secret", EMBER_LOG_LEVEL: "debug", EMBER_TEST_THING: "1", WSLENV: "USERPROFILE/p", ELECTRON_RUN_AS_NODE: "1",
};

const LIST_EN = [
  "  NAME                      STATE           VERSION",
  "* Ubuntu-22.04              Running         2",
  "  Debian                    Stopped         1",
  "  docker-desktop            Running         2",
  "  docker-desktop-data       Stopped         2",
  "  rancher-desktop           Stopped         2",
  "  podman-machine-default    Stopped         2",
  "",
].join("\r\n");
const LIST_DE = ["  NAME            STATUS           VERSION", "* Ubuntu          Wird ausgeführt  2", "  Debian          Beendet          1", ""].join("\r\n");
const LIST_JA = ["  名前            状態            バージョン", "* Ubuntu          実行中          2", "  Debian          停止            1", ""].join("\r\n");
const VERSION_EN = [
  "WSL version: 2.3.26.0", "Kernel version: 5.15.167.4-1", "WSLg version: 1.0.65", "MSRDC version: 1.2.5620",
  "Direct3D version: 1.611.1-81528511", "DXCore version: 10.0.26100.1-240331-1435.ge-release", "Windows version: 10.0.22631.4317", "",
].join("\r\n");
const VERSION_DE = ["WSL-Version: 2.3.26.0", "Kernelversion: 5.15.167.4-1", "WSLg-Version: 1.0.65", "MSRDC-Version: 1.2.5620", ""].join("\r\n");
const USAGE = "Copyright (c) Microsoft Corporation. All rights reserved.\r\n\r\nUsage: wsl.exe [Argument] [Options...] [CommandLine]\r\n";

describe("parseListVerbose", () => {
  it("reads names, versions and the default by position, whatever the header's language", () => {
    expect(parseListVerbose(decodeLines(utf16(LIST_EN, true)))).toEqual([
      { name: "Ubuntu-22.04", version: 2, isDefault: true },
      { name: "Debian", version: 1, isDefault: false },
      { name: "docker-desktop", version: 2, isDefault: false },
      { name: "docker-desktop-data", version: 2, isDefault: false },
      { name: "rancher-desktop", version: 2, isDefault: false },
      { name: "podman-machine-default", version: 2, isDefault: false },
    ]);
    const two = [{ name: "Ubuntu", version: 2, isDefault: true }, { name: "Debian", version: 1, isDefault: false }];
    // German states hold a space ("Wird ausgeführt"): the version is the last word, the name the first.
    expect(parseListVerbose(decodeLines(utf16(LIST_DE, true)))).toEqual(two);
    expect(parseListVerbose(decodeLines(utf16(LIST_JA)))).toEqual(two);
    expect(parseListVerbose(decodeLines(Buffer.from(LIST_JA, "utf8")))).toEqual(two);
  });

  it("finds nothing in a message instead of a list", () => {
    const none = "Windows Subsystem for Linux has no installed distributions.\r\nDistributions can be installed by visiting the Microsoft Store:\r\nhttps://aka.ms/wslstore\r\n";
    expect(parseListVerbose(decodeLines(utf16(none)))).toEqual([]);
    expect(parseListVerbose(["NAME STATE VERSION", "* bad! Running 2", "x Running 3"])).toEqual([]);
  });
});

describe("parseRunning", () => {
  const known = ["Ubuntu", "Debian"];
  it("counts only lines that are exactly a known distro's name", () => {
    expect([...parseRunning(decodeLines(utf16("Ubuntu\r\ndocker-desktop\r\n")), known)]).toEqual(["Ubuntu"]);
    expect([...parseRunning(["ubuntu", "DEBIAN"], known)]).toEqual(["Ubuntu", "Debian"]);
  });

  it("ignores the localised sentence printed when nothing runs", () => {
    for (const sentence of ["There are no running distributions.", "Es werden keine Distributionen ausgeführt.", "実行中のディストリビューションはありません。", "Ubuntu is not running"]) {
      expect(parseRunning(decodeLines(utf16(`${sentence}\r\n`)), known).size).toBe(0);
    }
  });
});

describe("parseVersion", () => {
  it("reads WSL's and WSLg's versions by line order, whatever the labels' language", () => {
    expect(parseVersion(decodeLines(Buffer.from(VERSION_EN, "utf8")), 0)).toEqual({ wsl: "2.3.26.0", wslg: "1.0.65" });
    expect(parseVersion(decodeLines(utf16(VERSION_DE)), 0)).toEqual({ wsl: "2.3.26.0", wslg: "1.0.65" });
  });

  it("has no version for the inbox wsl.exe, which prints its usage and fails", () => {
    expect(parseVersion(decodeLines(utf16(USAGE)), 4294967295)).toEqual({ wsl: null, wslg: null });
    expect(parseVersion(decodeLines(utf16(USAGE)), 0)).toEqual({ wsl: null, wslg: null });
    expect(parseVersion([], 0)).toEqual({ wsl: null, wslg: null });
  });
});

describe("guiDisabled", () => {
  it("is true only for [wsl2] guiApplications=false", () => {
    expect(guiDisabled("[wsl2]\r\nmemory=4GB\r\nguiApplications=false\r\n")).toBe(true);
    expect(guiDisabled("[WSL2]\n  GuiApplications = FALSE # no WSLg\n")).toBe(true);
    expect(guiDisabled("[wsl2]\nguiApplications=true\n")).toBe(false);
    expect(guiDisabled("[experimental]\nguiApplications=false\n")).toBe(false);
    expect(guiDisabled("# [wsl2]\n# guiApplications=false\n")).toBe(false);
    expect(guiDisabled(null)).toBe(false);
  });
});

describe("locateWslExe", () => {
  it("prefers the Store/MSI wsl.exe, then the inbox one, comparing variable names without regard to case", () => {
    const env = { PROGRAMFILES: "C:\\Program Files", systemroot: "C:\\Windows" };
    expect(locateWslExe(env, p => p === EXE || p === INBOX)).toBe(EXE);
    expect(locateWslExe(env, p => p === INBOX)).toBe(INBOX);
    expect(locateWslExe({ windir: "C:\\Windows" }, p => p === INBOX)).toBe(INBOX);
    expect(locateWslExe(env, () => false)).toBeNull();
    expect(locateWslExe({}, () => true)).toBeNull();
  });
});

describe("probeEnv and the job host", () => {
  it("cleans the environment, adds WSL_UTF8, empties WSLENV and runs the job host as Node", () => {
    const env = probeEnv(ENV, { jobHost: true });
    expect(env.WSL_UTF8).toBe("1");
    expect(env.WSLENV).toBe("");
    expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.EMBER_TEST_THING).toBeUndefined();
    expect(envGet(env, "PATH")).toBe("C:\\Windows\\System32");
    expect(probeEnv(ENV, { jobHost: false }).ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it("puts the program after the job host's own arguments, never any command text", () => {
    expect(jobHostArgv(JOB, EXE, ["--list"], false)).toEqual([JOB.execPath, JOB.script, "--batch", "--", EXE, "--list"]);
    expect(jobHostArgv(JOB, EXE, ["-d", "Ubuntu"], true)[2]).toBe("--interactive");
  });
});

describe("createWslExec", () => {
  afterEach(() => vi.useRealTimers());

  it("refuses work inside a distro without the job host and spawns nothing", async () => {
    const { spawn, calls } = fakeSpawn(() => undefined);
    const exec = createWslExec({ exe: () => EXE, env: ENV, jobHost: null, spawn, log: fakeLog() });
    const r = await exec.run(["-d", "Ubuntu", "--exec", "/bin/sh", "-s"], { stdin: "exit\n", timeoutMs: 1000, inDistro: true });
    expect(r.error).toMatch(/job host/);
    expect(calls).toHaveLength(0);
  });

  it("lists without a job host by running wsl.exe itself", async () => {
    const { spawn, calls } = fakeSpawn(c => answerWith(c, { stdout: "Ubuntu\n" }));
    const exec = createWslExec({ exe: () => EXE, env: ENV, jobHost: null, spawn, log: fakeLog() });
    const r = await exec.run(["--list", "--quiet"], { timeoutMs: 1000, inDistro: false });
    expect(r.code).toBe(0);
    expect(calls[0].command).toBe(EXE);
    expect(calls[0].args).toEqual(["--list", "--quiet"]);
  });

  it("kills a probe at its time limit and keeps its stdin open until the end", async () => {
    vi.useFakeTimers();
    const { spawn, calls } = fakeSpawn(() => undefined);
    const exec = createWslExec({ exe: () => EXE, env: ENV, jobHost: JOB, spawn, log: fakeLog() });
    const p = exec.run(["-d", "Ubuntu", "--exec", "/bin/sh", "-s"], { stdin: "sleep 99\nexit\n", timeoutMs: 30_000, inDistro: true });
    expect(calls[0].mode).toBe("--interactive");
    expect(calls[0].child.stdinEnded).toBe(false);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(calls[0].child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const r = await p;
    expect(r.timedOut).toBe(true);
    expect(calls[0].child.killed).toBe(true);
    expect(calls[0].child.stdinEnded).toBe(true);
  });
});

/** A PC with WSL: the registry, wsl.exe's answers and the distros' fixed scripts, all fake. */
function pc(o: {
  registry?: FakeRegistry | null; list?: Buffer; listCode?: number; running?: string[]; version?: Buffer | null; versionCode?: number;
  uid?: Record<string, number>; bootId?: string; wslconfig?: Uint8Array | null; images?: string[] | null; exes?: string[];
} = {}) {
  let now = 1_000_000;
  const running = new Set(o.running ?? ["Ubuntu"]);
  const fake = fakeSpawn(call => answer(call));
  function answer(call: SpawnCall) {
    const a = call.wsl;
    if (a[0] === "--list" && a[1] === "--verbose") return answerWith(call, { stdout: o.list ?? utf16(LIST_EN, true), code: o.listCode ?? 0 });
    if (a[0] === "--list" && a[1] === "--running") return answerWith(call, { stdout: utf16([...running].join("\r\n") + "\r\n"), code: 0 });
    if (a[0] === "--version") return answerWith(call, { stdout: o.version === null ? utf16(USAGE) : (o.version ?? Buffer.from(VERSION_EN, "utf8")), code: o.version === null ? 4294967295 : (o.versionCode ?? 0) });
    if (a[0] === "-d") {
      const distro = a[1];
      call.child.onScript = script => {
        running.add(distro); // anything run with -d starts the distro: the tests check discovery never does
        if (script.includes(FACTS_SCRIPT.split("\n")[0])) {
          const uid = o.uid?.[distro] ?? 1000;
          answerWith(call, { stdout: `uid=${uid}\nuser=${uid ? "ana" : "root"}\nhome=${uid ? "/home/ana" : "/root"}\nshell=/bin/bash\nshell=/bin/sh\nscript=/usr/bin/script\ninterop=1\nmountc=/mnt/c/\npython3=1\nbase64=1\n` });
        } else if (script.includes("boot_id")) {
          answerWith(call, { stdout: o.bootId ?? "6f1d9e0c-3b2a-4c5d-8e7f-0a1b2c3d4e5f\n" });
        } else {
          answerWith(call, { stdout: "", code: 0 });
        }
      };
    }
  }
  const registry = o.registry === undefined ? new FakeRegistry()
    .key(LXSS_KEY, { DefaultDistribution: "{u}" })
    .key(`${LXSS_KEY}\\{u}`, { DistributionName: "Ubuntu", Version: 2, Flags: 15, DefaultUid: 0, State: 1 })
    .key(`${LXSS_KEY}\\{d}`, { DistributionName: "Debian", Version: 2, Flags: 7, State: 1 })
    .key(`${LXSS_KEY}\\{dd}`, { DistributionName: "docker-desktop", Version: 2, Flags: 15, State: 1 })
    .key(`${LXSS_KEY}\\{rd}`, { DistributionName: "rancher-desktop-data", Version: 2, Flags: 15, State: 1 })
    .key(`${LXSS_KEY}\\{p}`, { DistributionName: "podman-machine-default", Version: 2, Flags: 15, State: 1 })
    .key(`${LXSS_KEY}\\{n}`, { DistributionName: "Ubuntu-24.04", Version: 2, Flags: 15, RunOOBE: 1, State: 1 }) : o.registry;
  const exes = o.exes ?? [EXE, INBOX];
  const deps: WslDeps = {
    spawn: fake.spawn,
    exists: p => exes.includes(p),
    readFile: p => (p === "C:\\Users\\ana\\.wslconfig" ? (o.wslconfig ?? null) : null),
    registry: () => registry,
    processImages: async () => (o.images === undefined ? ["System Idle Process", "explorer.exe"] : o.images),
    now: () => now,
  };
  const log = fakeLog();
  const wsl = createWslWith({ log, env: ENV, os: "win32", ember: { winPaths: ["C:\\Users\\ana\\AppData\\Local\\ember"] }, jobHost: JOB }, deps)!;
  return { wsl, calls: fake.calls, running, log, tick: (ms: number) => { now += ms; } };
}

/** The wsl.exe calls that ran something inside a distro (and so could start it). */
const inDistro = (calls: SpawnCall[]) => calls.filter(c => c.wsl[0] === "-d");

describe("createWsl", () => {
  it("is null off Windows and when this PC has no wsl.exe", () => {
    expect(createWsl({ log: fakeLog(), env: ENV, os: "linux", ember: { winPaths: [] }, jobHost: null })).toBeNull();
    expect(createWsl({ log: fakeLog(), env: ENV, os: "darwin", ember: { winPaths: [] }, jobHost: null })).toBeNull();
    expect(pc({ exes: [] }).wsl).toBeNull();
  });
});

describe("WslService.facts", () => {
  it("lists distros from the registry without starting any, hiding Docker's and Rancher's", async () => {
    const { wsl, calls } = pc();
    const f = await wsl.facts();
    expect(f).toEqual<WslFacts>({
      installed: true,
      wslExe: EXE,
      distros: [
        { name: "Ubuntu", version: 2, isDefault: true, defaultUid: null, running: true, needsSetup: false },
        { name: "Debian", version: 1, isDefault: false, defaultUid: null, running: false, needsSetup: false },
        { name: "podman-machine-default", version: 2, isDefault: false, defaultUid: null, running: false, needsSetup: false, tool: "podman" },
        { name: "Ubuntu-24.04", version: 2, isDefault: false, defaultUid: null, running: false, needsSetup: true },
      ],
      wslg: { available: true, disabledByUser: false, version: "1.0.65" },
      wslVersion: "2.3.26.0",
    });
    expect(inDistro(calls)).toHaveLength(0);
    expect(forbiddenOptions(calls)).toEqual([]);
    expect(calls.some(c => c.wsl[1] === "--verbose")).toBe(false);
    expect(HIDDEN_DISTRO.test("docker-desktop-data") && HIDDEN_DISTRO.test("Rancher-Desktop")).toBe(true);
  });

  it("runs every probe hidden, under the job host, with the cleaned environment", async () => {
    const { wsl, calls } = pc();
    await wsl.facts();
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.command).toBe(JOB.execPath);
      expect(c.args.slice(0, 4)).toEqual([JOB.script, "--batch", "--", EXE]);
      expect(c.options).toMatchObject({ detached: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      expect(c.options.env).toMatchObject({ WSL_UTF8: "1", WSLENV: "", ELECTRON_RUN_AS_NODE: "1" });
      expect(c.options.env.GH_TOKEN).toBeUndefined();
    }
  });

  it("lists with wsl.exe --list --verbose when the registry can't be read (German output)", async () => {
    const { wsl, calls } = pc({ registry: null, list: utf16(LIST_DE, true) });
    const f = await wsl.facts();
    expect(f.distros.map(d => [d.name, d.version, d.isDefault, d.running])).toEqual([["Ubuntu", 2, true, true], ["Debian", 1, false, false]]);
    expect(calls.some(c => c.wsl[1] === "--verbose")).toBe(true);
    expect(inDistro(calls)).toHaveLength(0);
  });

  it("reads a Japanese list and knows nothing runs from the localised sentence", async () => {
    const { wsl } = pc({ registry: null, list: utf16(LIST_JA), running: [] });
    const f = await wsl.facts();
    expect(f.distros.map(d => d.name)).toEqual(["Ubuntu", "Debian"]);
    expect(f.distros.every(d => !d.running)).toBe(true);
  });

  it("has no distros when wsl --list fails naming none", async () => {
    const { wsl } = pc({ registry: null, list: utf16("Windows Subsystem for Linux has no installed distributions.\r\n"), listCode: 4294967295 });
    const f = await wsl.facts();
    expect(f.installed).toBe(true);
    expect(f.distros).toEqual([]);
    expect(f.wslg.available).toBe(false);
  });

  it("has no WSLg with the inbox WSL, with only WSL 1 distros, or when .wslconfig turns it off", async () => {
    expect((await pc({ version: null }).wsl.facts()).wslg).toEqual({ available: false, disabledByUser: false, version: null });
    const v1 = new FakeRegistry().key(LXSS_KEY).key(`${LXSS_KEY}\\{d}`, { DistributionName: "Debian", Version: 2, Flags: 7 });
    expect((await pc({ registry: v1 }).wsl.facts()).wslg.available).toBe(false);
    // PowerShell 5.1's Out-File writes UTF-16LE: still read.
    const off = await pc({ wslconfig: utf16("[wsl2]\r\nguiApplications=false\r\n", true) }).wsl.facts();
    expect(off.wslg).toEqual({ available: false, disabledByUser: true, version: "1.0.65" });
  });

  it("reuses the facts for 60 s, and reads them again when asked to refresh", async () => {
    const { wsl, calls, tick } = pc();
    await wsl.facts();
    const n = calls.length;
    tick(59_000);
    await wsl.facts();
    expect(calls.length).toBe(n);
    await wsl.facts({ refresh: true });
    expect(calls.length).toBeGreaterThan(n);
    const m = calls.length;
    tick(61_000);
    await wsl.facts();
    expect(calls.length).toBeGreaterThan(m);
  });

  it("tells listeners when the facts change, and only then", async () => {
    const { wsl, running, tick } = pc();
    const seen: WslFacts[] = [];
    wsl.onChange(f => seen.push(f));
    await wsl.facts();
    expect(seen).toHaveLength(1);
    await wsl.facts({ refresh: true });
    expect(seen).toHaveLength(1);
    running.add("Debian");
    tick(3_000);
    await wsl.runningNow();
    expect(seen).toHaveLength(2);
    expect(seen[1].distros.find(d => d.name === "Debian")!.running).toBe(true);
  });
});

describe("WslService running set", () => {
  it("answers isRunning from the cache and reads it again in the background at most every 2 s", async () => {
    const { wsl, calls, running, tick } = pc();
    await wsl.facts();
    const runningCalls = () => calls.filter(c => c.wsl[1] === "--running").length;
    const before = runningCalls();
    expect(wsl.isRunning("Ubuntu")).toBe(true);
    expect(runningCalls()).toBe(before);
    running.delete("Ubuntu");
    tick(2_001);
    expect(wsl.isRunning("Ubuntu")).toBe(true); // still the cached answer
    await flush();
    expect(runningCalls()).toBe(before + 1);
    expect(wsl.isRunning("Ubuntu")).toBe(false);
  });

  it("reads runningNow every time and never starts a distro", async () => {
    const { wsl, calls } = pc({ running: [] });
    expect(await wsl.runningNow()).toEqual(new Set());
    expect(await wsl.runningNow()).toEqual(new Set());
    // The first read is discovery's own (it lists the running set too); each later one reads it again.
    expect(calls.filter(c => c.wsl[1] === "--running").length).toBe(2);
    expect(await wsl.runningNow()).toEqual(new Set());
    expect(calls.filter(c => c.wsl[1] === "--running").length).toBe(3);
    expect(inDistro(calls)).toHaveLength(0);
  });
});

describe("WslService.defaultUid", () => {
  it("asks only a running distro, and takes its uid from inside over the registry's hint", async () => {
    const { wsl, calls } = pc({ running: ["Ubuntu"], uid: { Ubuntu: 1000, Debian: 0 } });
    expect(await wsl.defaultUid("Debian")).toBeNull();
    expect(inDistro(calls).filter(c => c.wsl[1] === "Debian")).toHaveLength(0);
    // The registry says 0 (setup-wsl, wsl --import); /etc/wsl.conf's default user (1000) wins (critique wsl-7).
    expect(await wsl.defaultUid("Ubuntu")).toBe(1000);
    expect((await wsl.facts()).distros.find(d => d.name === "Ubuntu")!.defaultUid).toBe(1000);
  });
});

describe("a distro whose first-run set-up is pending", () => {
  it("is never started, and is looked at again once the user may have set it up", async () => {
    const reg = new FakeRegistry()
      .key(LXSS_KEY, { DefaultDistribution: "{u}" })
      .key(`${LXSS_KEY}\\{u}`, { DistributionName: "Ubuntu", Version: 2, Flags: 15, State: 1 })
      .key(`${LXSS_KEY}\\{n}`, { DistributionName: "Ubuntu-24.04", Version: 2, Flags: 15, RunOOBE: 1, State: 1 });
    const { wsl, calls, tick } = pc({ registry: reg });
    const r = wsl.runner("Ubuntu-24.04");
    await expect(r.facts()).rejects.toThrow("Set up Ubuntu-24.04 first: open it from the Start menu once");
    expect(await r.runScript("true", { mayBoot: true })).toBeNull();
    expect(inDistro(calls)).toHaveLength(0);
    // The user opens it from the Start menu once: its set-up is done.
    reg.key(`${LXSS_KEY}\\{n}`, { RunOOBE: 0 });
    tick(5_001);
    expect((await r.facts()).privileged).toBe(false);
    expect(inDistro(calls).map(c => c.wsl[1])).toEqual(["Ubuntu-24.04"]);
  });
});

describe("WslService.bootIds", () => {
  it("hashes the boot id of running WSL2 distros only, never starting one", async () => {
    const boot = "6f1d9e0c-3b2a-4c5d-8e7f-0a1b2c3d4e5f\n";
    const { wsl, calls } = pc({ running: ["Ubuntu", "Debian"], bootId: boot });
    expect(await wsl.bootIds()).toEqual([createHash("sha256").update(boot).digest("hex")]);
    const asked = inDistro(calls).map(c => c.wsl[1]);
    expect(asked).toEqual(["Ubuntu"]); // Debian is WSL 1; the stopped WSL2 distros aren't touched
    for (const c of inDistro(calls)) expect(c.child.stdinText()).toContain("/proc/sys/kernel/random/boot_id");
  });

  it("ignores an answer that isn't a boot id", async () => {
    expect(await pc({ bootId: "not a uuid\n" }).wsl.bootIds()).toEqual([]);
  });

  it("asks nothing when no WSL2 distro runs", async () => {
    const { wsl, calls } = pc({ running: [] });
    expect(await wsl.bootIds()).toEqual([]);
    expect(inDistro(calls)).toHaveLength(0);
  });
});

describe("what Ember never asks wsl.exe for (§4.2)", () => {
  it("never switches users or changes WSL's state, through a whole session", async () => {
    const { wsl, calls } = pc({ running: ["Ubuntu"] });
    await wsl.facts();
    await wsl.runningNow();
    await wsl.defaultUid("Ubuntu");
    await wsl.bootIds();
    const runner = wsl.runner("Ubuntu");
    await runner.inspect(["/etc"], "/home/ana");
    await runner.gitFacts("/home/ana");
    await wsl.doctorRows();
    expect(calls.length).toBeGreaterThan(5);
    expect(forbiddenOptions(calls)).toEqual([]);
  });
});

describe("WslService.windowsContext", () => {
  it("comes from the PC's environment (names compared without regard to case) and Ember's own paths", () => {
    expect(pc().wsl.windowsContext()).toEqual({
      home: "C:\\Users\\ana", localAppData: "C:\\Users\\ana\\AppData\\Local", appData: "C:\\Users\\ana\\AppData\\Roaming",
      temp: "C:\\Users\\ana\\AppData\\Local\\Temp", systemRoot: "C:\\Windows", emberPaths: ["C:\\Users\\ana\\AppData\\Local\\ember"],
    });
    expect(windowsContextOf({ HOMEDRIVE: "D:", HOMEPATH: "\\Users\\bo", WINDIR: "D:\\Windows" }, [])).toEqual({
      home: "D:\\Users\\bo", localAppData: "D:\\Users\\bo\\AppData\\Local", appData: "D:\\Users\\bo\\AppData\\Roaming",
      temp: "D:\\Users\\bo\\AppData\\Local\\Temp", systemRoot: "D:\\Windows", emberPaths: [],
    });
  });
});

describe("the doctor's wsl row", () => {
  const facts = (over: Partial<WslFacts> = {}): WslFacts => ({
    installed: true, wslExe: EXE, wslVersion: "2.3.26.0", wslg: { available: true, disabledByUser: false, version: "1.0.65" },
    distros: [
      { name: "Ubuntu", version: 2, isDefault: true, defaultUid: null, running: true, needsSetup: false },
      { name: "Debian", version: 1, isDefault: false, defaultUid: null, running: false, needsSetup: false },
    ],
    ...over,
  });

  it("names WSL's version, WSLg and the distros when all is well", () => {
    expect(wslDoctorRows(facts(), { xServer: null })).toEqual([{ id: "wsl", status: "ok", label: "WSL", detail: "WSL 2.3.26 with WSLg; distros: Ubuntu, Debian" }]);
    expect(wslDoctorRows(facts({ wslg: { available: false, disabledByUser: false, version: null } }), { xServer: null })[0].detail).toBe("WSL 2.3.26; distros: Ubuntu, Debian");
    expect(shortVersion("2.3.26.0")).toBe("2.3.26");
  });

  it("warns, most important first, with the fix", () => {
    expect(wslDoctorRows(facts({ distros: [] }), { xServer: null })[0]).toMatchObject({ status: "warn", detail: "No WSL distros" });
    expect(wslDoctorRows(facts({ wslVersion: null }), { xServer: null })[0]).toEqual({ id: "wsl", status: "warn", label: "WSL", detail: "WSL needs an update for Linux apps", fix: "Run `wsl --update`." });
    expect(wslDoctorRows(facts({ wslg: { available: false, disabledByUser: true, version: "1.0.65" } }), { xServer: "VcXsrv" })[0]).toEqual({
      id: "wsl", status: "warn", label: "WSL", detail: "WSL is installed but WSLg is off", fix: "Remove guiApplications=false from %USERPROFILE%\\.wslconfig.",
    });
    expect(wslDoctorRows(facts(), { xServer: "X410" })[0]).toMatchObject({ status: "warn", detail: "Linux apps shown by an X server (VcXsrv, X410…) can't be used; WSLg's can." });
  });

  it("has no row without WSL", () => {
    expect(wslDoctorRows({ installed: false, wslExe: null, distros: [], wslg: { available: false, disabledByUser: false, version: null }, wslVersion: null }, { xServer: null })).toEqual([]);
  });

  it("finds X servers among Windows' processes", async () => {
    expect(parseTasklist('"System Idle Process","0","Services","0","8 K"\r\n"vcxsrv.exe","4242","Console","1","40,000 K"\r\n')).toEqual(["System Idle Process", "vcxsrv.exe"]);
    expect(runningXServer(["explorer.exe", "VcXsrv.exe"])).toBe("VcXsrv");
    expect(runningXServer(["GWSL_service.exe"])).toBe("GWSL");
    expect(runningXServer(["explorer.exe", "msrdc.exe"])).toBeNull();
    const rows = await pc({ images: ["x410.exe"] }).wsl.doctorRows();
    expect(rows[0].detail).toMatch(/X server/);
    expect((await pc({ images: null }).wsl.doctorRows())[0].status).toBe("ok");
  });
});

describe("listing time limits", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("gives up on a listing probe after 5 s and lists nothing rather than guessing", async () => {
    const fake = fakeSpawn(() => undefined); // wsl.exe never answers
    const deps: WslDeps = {
      spawn: fake.spawn, exists: p => p === EXE, readFile: () => null, registry: () => null,
      processImages: async () => null, now: () => Date.now(),
    };
    const wsl = createWslWith({ log: fakeLog(), env: ENV, os: "win32", ember: { winPaths: [] }, jobHost: JOB }, deps)!;
    const p = wsl.facts();
    await vi.advanceTimersByTimeAsync(LIST_TIMEOUT_MS + 10);
    const f = await p;
    expect(f.distros).toEqual([]);
    expect(fake.calls.every(c => c.child.killed)).toBe(true);
  });
});
