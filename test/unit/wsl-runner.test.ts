/**
 * Commands in a WSL distro (app/main/wsl/runner.ts, design §3.3's WSL rows, §4.2, §3.13): the facts script's output,
 * the exact argv (job host + wsl.exe + WSL_EVAL) and environment (EMBER_INNER, EMBER_CMD_B64, WSLENV replaced,
 * WSL_UTF8), the 30 s time limit for anything that may start a distro, the start marker (no marker: failed to start,
 * with wsl.exe's decoded error), fixed scripts only on stdin with data in a quoted here-document, the WSL stop ladder
 * with fake timers (Ctrl+C or an INT sweep, TERM and KILL sweeps, the job host only after the KILL sweep), inspect,
 * git facts, typing and secret prompts. wsl.exe and the job host are fakes; nothing is spawned.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NO_RC, WSL_EVAL, posixBody, posixInner } from "../../app/main/commands/run/shells";
import { OPEN_SPAN_END } from "../../app/main/commands/prompts";
import type { CommandCard, CommandService, JobHostRef, RunSpec, RunExit } from "../../app/main/commands/types";
import { runCommandTool, setCommandJudge, type CommandFlowContext } from "../../app/main/commands/flow";
import { BOOT_TIMEOUT_MS, createWslExec } from "../../app/main/wsl/discover";
import {
  createWslRunner, FACTS_SCRIPT, FACTS_TTL_MS, GIT_SCRIPT, INSPECT_SCRIPT, LADDER_MS, mountRootOf, parseFacts, parseGitFacts, PRESTART_STOP_MS, PRESTART_SWEEP_MS,
  parseInspect, parseScriptRead, READ_SCRIPT, runnerFacts, SCRIPT_MARKER, SCRIPT_READ_BYTES, SCRIPT_READ_MS, scriptInput, SWEEP_SCRIPT, toWslPath,
  windowsRunEnv, wslLaunch, type WslRunner,
} from "../../app/main/wsl/runner";
import type { WslDistro } from "../../app/main/wsl/types";
import { fakeLog, fakeSpawn, flush, forbiddenOptions, answerWith, utf16, type SpawnCall } from "./wsl-wa-fakes";

const EXE = "C:\\Program Files\\WSL\\wsl.exe";
const JOB: JobHostRef = { execPath: "C:\\Program Files\\Ember\\Ember.exe", script: "C:\\Program Files\\Ember\\resources\\app\\job-host.cjs" };
const RUN_ID = "0123456789abcdef";
const ENV: NodeJS.ProcessEnv = {
  Path: "C:\\Windows\\System32", USERPROFILE: "C:\\Users\\ana", WslEnv: "USERPROFILE/p:Path/l", GH_TOKEN: "ghp_x", COPILOT_AGENT: "1",
  NODE_OPTIONS: "--inspect", EMBER_LOG_LEVEL: "debug", NPM_TOKEN: "npm_user_own", SUDO_ASKPASS: "C:\\ask.exe", ELECTRON_NO_ATTACH_CONSOLE: "1",
};
const WINDOWS = { home: "C:\\Users\\ana", localAppData: "C:\\Users\\ana\\AppData\\Local", appData: "C:\\Users\\ana\\AppData\\Roaming", temp: "C:\\Users\\ana\\AppData\\Local\\Temp", systemRoot: "C:\\Windows", emberPaths: ["C:\\Users\\ana\\AppData\\Local\\ember"] };
const MARKER = "\x1b]777;ember-start\x07";

/** What the facts script prints in an ordinary WSL2 Ubuntu (newer WSL: WSLInterop-late, found by the glob). */
const FACTS_OUT = "uid=1000\nuser=ana\nhome=/home/ana\nshell=/bin/bash\nshell=/usr/bin/bash\nshell=/bin/sh\nscript=/usr/bin/script\ninterop=1\ninterop=1\nmount=/usr/lib/wsl/drivers\nmountc=/mnt/c/\npython3=1\nbase64=1\n";

function spec(over: Partial<RunSpec> = {}): RunSpec {
  return {
    runId: RUN_ID, taskId: "t1", shell: "bash", command: "git log --oneline | head -n 3", cwd: "/home/ana/proj", timeoutMs: 120_000, cols: 120, rows: 30,
    stamp: { taskId: "t1", sha256: "0".repeat(64), verdict: "run", classes: [], rules: [], approval: null },
    ...over,
  };
}

describe("parseFacts", () => {
  it("reads every fact the script prints", () => {
    expect(parseFacts(FACTS_OUT)).toEqual({
      uid: 1000, user: "ana", home: "/home/ana", shells: { bash: "/bin/bash", sh: "/bin/sh" }, script: "/usr/bin/script", interop: true,
      mount: "/usr/lib/wsl/drivers", mountc: "/mnt/c/", python3: true, base64: true,
    });
  });

  it("asks for interop in both of WSL's forms, util-linux's script only, and the drive root from wslpath or findmnt", () => {
    expect(FACTS_SCRIPT).toContain("for f in /proc/sys/fs/binfmt_misc/WSLInterop*;");
    expect(FACTS_SCRIPT).toContain('[ -n "$WSL_INTEROP" ] && echo interop=1');
    expect(FACTS_SCRIPT).toContain('"$s" --version 2>/dev/null | grep -q util-linux && echo "script=$s"');
    expect(FACTS_SCRIPT).toContain("findmnt -rn -t 9p,drvfs -o TARGET");
    expect(FACTS_SCRIPT).toContain("wslpath -u 'C:\\'");
    expect(FACTS_SCRIPT).not.toContain("wsl.conf");
  });

  it("refuses output without a numeric uid or an absolute home (fail closed)", () => {
    expect(parseFacts("user=ana\nhome=/home/ana\n")).toBeNull();
    expect(parseFacts("uid=abc\nhome=/home/ana\n")).toBeNull();
    expect(parseFacts("uid=1000\nhome=home/ana\n")).toBeNull();
    expect(parseFacts("")).toBeNull();
  });

  it("ignores paths Ember couldn't pass to wsl.exe, values with control characters and unknown keys", () => {
    const f = parseFacts("uid=0\r\nhome=/root\nshell=/opt/my shell/bash\nshell=/bin/sh\nscript=/usr/bin/scr\"ipt\nuser=a\x1bb\nfoo=bar\npython3=0\n")!;
    expect(f.uid).toBe(0);
    expect(f.shells).toEqual({ sh: "/bin/sh" });
    expect(f.script).toBeNull();
    expect(f.user).toBe("");
    expect(f.python3).toBe(false);
    expect(f.base64).toBe(false);
  });
});

describe("mountRootOf and toWslPath", () => {
  it("takes the drive mounts' root from wslpath, else from findmnt's drive folder, else /mnt/", () => {
    expect(mountRootOf("/mnt/c/", "/usr/lib/wsl/drivers")).toBe("/mnt/");
    expect(mountRootOf("/c/", null)).toBe("/");
    expect(mountRootOf("/windir/c", null)).toBe("/windir/");
    expect(mountRootOf(null, "/mnt/c")).toBe("/mnt/");
    // WSL2 mounts its GPU drivers as 9p too: not a drive.
    expect(mountRootOf(null, "/usr/lib/wsl/drivers")).toBe("/mnt/");
    expect(mountRootOf(null, null)).toBe("/mnt/");
  });

  it("translates Ember's Windows paths under the mount root and skips UNC paths", () => {
    expect(toWslPath("C:\\Users\\ana\\AppData\\Local\\ember", "/mnt/")).toBe("/mnt/c/Users/ana/AppData/Local/ember");
    expect(toWslPath("D:\\", "/mnt/")).toBe("/mnt/d");
    expect(toWslPath("e:/Tools/Ember/", "/")).toBe("/e/Tools/Ember");
    expect(toWslPath("\\\\server\\share\\ember", "/mnt/")).toBeNull();
    expect(toWslPath("relative\\x", "/mnt/")).toBeNull();
  });
});

describe("runnerFacts", () => {
  it("makes bash the default shell, sh the fallback, and root privileged (D4.6)", () => {
    const f = runnerFacts(parseFacts(FACTS_OUT)!, { winPaths: ["C:\\Users\\ana\\AppData\\Local\\ember", "\\\\nas\\x"], windows: WINDOWS });
    expect(f).toEqual({
      os: "linux", shells: ["bash", "sh"], shellPaths: { bash: "/bin/bash", sh: "/bin/sh" }, script: { path: "/usr/bin/script", kind: "util-linux" },
      home: "/home/ana", user: "ana", privileged: false, pty: true,
      ember: { paths: ["/mnt/c/Users/ana/AppData/Local/ember"], pids: [], names: f.ember.names }, extraPath: [],
      wsl: { mountRoot: "/mnt/", interop: true, windows: WINDOWS },
    });
    expect(f.ember.names.test("Ember.exe") && f.ember.names.test("ember") && !f.ember.names.test("remember")).toBe(true);
    const root = runnerFacts(parseFacts("uid=0\nhome=/root\nshell=/bin/sh\nshell=/bin/zsh\n")!, { winPaths: [], windows: null });
    expect(root.privileged).toBe(true);
    expect(root.shells).toEqual(["sh", "zsh"]);
    expect(root.pty).toBe(false);
    expect(root.script).toBeNull();
  });
});

describe("scriptInput", () => {
  it("ends a fixed script with exit (the job host's stdin stays open)", () => {
    expect(scriptInput("echo hi")).toBe("echo hi\nexit\n");
  });

  it("passes data only inside a quoted here-document with a random delimiter", () => {
    const text = scriptInput(INSPECT_SCRIPT, ["/a; rm -rf ~", "$(reboot)", "`id`"], "EMBER_DATA_abc");
    expect(text).toBe(`{\n${INSPECT_SCRIPT}\n} <<'EMBER_DATA_abc'\n/a; rm -rf ~\n$(reboot)\n\`id\`\nEMBER_DATA_abc\nexit\n`);
    const a = scriptInput("cat", ["x"]), b = scriptInput("cat", ["x"]);
    expect(/<<'(EMBER_DATA_[0-9a-f]{16})'/.exec(a)![1]).not.toBe(/<<'(EMBER_DATA_[0-9a-f]{16})'/.exec(b)![1]);
  });

  it("refuses data that could end the here-document early", () => {
    expect(() => scriptInput("cat", ["a\nexit"])).toThrow();
    expect(() => scriptInput("cat", ["a\rb"])).toThrow();
    expect(() => scriptInput("cat", ["a\0b"])).toThrow();
    expect(() => scriptInput("cat", ["EMBER_DATA_abc"], "EMBER_DATA_abc")).toThrow();
  });
});

describe("parseInspect and parseGitFacts", () => {
  it("reads one exists/real line per path, splitting at the first tab only", () => {
    expect(parseInspect("1\t/home/ana/.ssh\n0\t/home/ana/new\tname\n1\t\n", 3)).toEqual([
      { exists: true, real: "/home/ana/.ssh" }, { exists: false, real: "/home/ana/new\tname" }, { exists: true, real: null },
    ]);
    expect(parseInspect("1\t/a\n", 2)).toBeNull();
  });

  it("reads git's push facts; outside a work tree there are none", () => {
    expect(parseGitFacts("branch=feature-x\npush=simple\nupstream=origin/feature-x\n")).toEqual({ branch: "feature-x", pushDefault: "simple", upstream: "origin/feature-x" });
    expect(parseGitFacts("branch=HEAD\npush=\nupstream=\n")).toEqual({ branch: null, pushDefault: null, upstream: null });
    expect(parseGitFacts("branch=\npush=\nupstream=\n")).toBeNull();
    expect(GIT_SCRIPT).toContain("git rev-parse --abbrev-ref HEAD");
    expect(GIT_SCRIPT).toContain("git config --get push.default");
    expect(GIT_SCRIPT).toContain("git rev-parse --abbrev-ref '@{u}'");
  });
});

describe("wslLaunch", () => {
  const pty = runnerFacts(parseFacts(FACTS_OUT)!, { winPaths: [], windows: WINDOWS });
  const pipes = { ...pty, script: null, pty: false };
  const o = { exe: EXE, distro: "Ubuntu", jobHost: JOB, env: ENV };

  it("runs util-linux script under env SHELL=/bin/sh, through the job host, with WSL_EVAL as the only -c text (PTY)", () => {
    const l = wslLaunch(spec(), pty, o);
    expect([l.command, ...l.args]).toEqual([
      JOB.execPath, JOB.script, "--interactive", "--", EXE, "-d", "Ubuntu", "--cd", "/home/ana/proj",
      "--exec", "/usr/bin/env", "SHELL=/bin/sh", "/usr/bin/script", "-q", "-e", "-f", "-c", WSL_EVAL, "/dev/null",
    ]);
    expect(l.env.EMBER_INNER).toBe(posixInner("bash", "/bin/bash", "b64"));
    expect(l.env.TERM).toBe("xterm-256color");
  });

  it("runs the shell itself without rc files on pipes (no script)", () => {
    const l = wslLaunch(spec(), pipes, o);
    expect([l.command, ...l.args]).toEqual([
      JOB.execPath, JOB.script, "--batch", "--", EXE, "-d", "Ubuntu", "--cd", "/home/ana/proj", "--exec", "/bin/bash", ...NO_RC.bash, "-c", WSL_EVAL,
    ]);
    expect(l.env.EMBER_INNER).toBe(posixBody({ pty: false, from: "b64" }));
    expect(l.env.TERM).toBe("dumb");
    expect(wslLaunch(spec({ shell: "sh" }), pipes, o).args.slice(-4)).toEqual(["--exec", "/bin/sh", "-c", WSL_EVAL]);
  });

  it("never puts the command text on any argv: it travels as base64 of its UTF-8 bytes", () => {
    const command = "echo 'héllo' \"$HOME\" | tee x.txt\ncat <<EOF\n日本\nEOF";
    for (const facts of [pty, pipes]) {
      const l = wslLaunch(spec({ command }), facts, o);
      const argv = [l.command, ...l.args].join("\u0001");
      expect(argv).not.toContain("héllo");
      expect(argv).not.toContain(l.env.EMBER_CMD_B64);
      expect(Buffer.from(l.env.EMBER_CMD_B64, "base64").toString("utf8")).toBe(command);
      expect(/^[A-Za-z0-9+/=]+$/.test(l.env.EMBER_CMD_B64)).toBe(true);
      // Nothing after wsl.exe's own path holds a quote or a backslash for Windows' quoting to change.
      for (const a of l.args.slice(4)) expect(a).not.toMatch(/["\\]/);
    }
  });

  it("replaces the user's WSLENV with exactly Ember's variables, and sets WSL_UTF8", () => {
    const p = wslLaunch(spec(), pty, o).env;
    expect(p.WSLENV).toBe("EMBER_INNER/u:EMBER_CMD_B64/u:EMBER_RUN_ID/u:EMBER_COLS/u:EMBER_ROWS/u:TERM/u");
    expect(Object.keys(p).filter(k => k.toUpperCase() === "WSLENV")).toEqual(["WSLENV"]);
    expect(p).toMatchObject({ WSL_UTF8: "1", EMBER_RUN_ID: RUN_ID, EMBER_COLS: "120", EMBER_ROWS: "30", ELECTRON_RUN_AS_NODE: "1" });
    // Pipes also send §3.3.1's non-interactive defaults across.
    const q = wslLaunch(spec(), pipes, o).env;
    expect(q.WSLENV).toBe("EMBER_INNER/u:EMBER_CMD_B64/u:EMBER_RUN_ID/u:EMBER_COLS/u:EMBER_ROWS/u:TERM/u:GIT_TERMINAL_PROMPT/u:DEBIAN_FRONTEND/u:SSH_ASKPASS_REQUIRE/u");
    expect(q).toMatchObject({ GIT_TERMINAL_PROMPT: "0", DEBIAN_FRONTEND: "noninteractive", SSH_ASKPASS_REQUIRE: "never" });
    expect(p.GIT_TERMINAL_PROMPT).toBeUndefined();
  });

  it("cleans the Windows side's environment as §3.3.1 says", () => {
    const e = windowsRunEnv({ ...ENV, ORIGINAL_XDG_CURRENT_DESKTOP: "GNOME", XDG_CURRENT_DESKTOP: "Unity", APPIMAGE: "/x", "BASH_FUNC_ls%%": "() { x; }", CdPath: "C:\\x" }, { pty: false, runId: RUN_ID });
    // RUN's commandEnv: its rules for every run, exported functions and CDPATH (any spelling on Windows) among them.
    for (const gone of ["GH_TOKEN", "COPILOT_AGENT", "NODE_OPTIONS", "EMBER_LOG_LEVEL", "ELECTRON_NO_ATTACH_CONSOLE", "SUDO_ASKPASS", "APPIMAGE", "ORIGINAL_XDG_CURRENT_DESKTOP", "BASH_FUNC_ls%%", "CdPath"]) {
      expect(e[gone]).toBeUndefined();
    }
    expect(e).toMatchObject({ NPM_TOKEN: "npm_user_own", XDG_CURRENT_DESKTOP: "GNOME", EMBER_RUN_ID: RUN_ID, TERM: "dumb", Path: "C:\\Windows\\System32" });
  });

  it("refuses a folder holding a quote, a backslash or a control character, or one that isn't absolute", () => {
    for (const cwd of ['/home/ana/a"b', "/home/ana/a\\b", "/home/ana/a\nb", "/home/ana/\x1b", "proj", "~/proj"]) {
      expect(() => wslLaunch(spec({ cwd }), pty, o)).toThrow("Ember can't pass that folder to WSL");
    }
    expect(wslLaunch(spec({ cwd: "/home/ana/my project (1)" }), pty, o).args).toContain("/home/ana/my project (1)");
  });

  it("refuses a shell the distro doesn't have, a NUL, a bad run id and a command too long for Windows' environment", () => {
    expect(() => wslLaunch(spec({ shell: "zsh" }), pty, o)).toThrow("zsh isn't installed on Ubuntu");
    expect(() => wslLaunch(spec({ shell: "powershell" }), pty, o)).toThrow("powershell isn't installed on Ubuntu");
    expect(() => wslLaunch(spec({ command: "a\0b" }), pty, o)).toThrow(/NUL/);
    expect(() => wslLaunch(spec({ runId: "x;y" }), pty, o)).toThrow(/id/);
    expect(() => wslLaunch(spec({ command: "日".repeat(11_000) }), pty, o)).toThrow(/too long/);
    // RUN's launcher checks the rest: a distro name wsl.exe could read as more, a character that can't pass exactly.
    expect(() => wslLaunch(spec(), pty, { ...o, distro: "Ubuntu --exec x" })).toThrow(/name/);
    expect(() => wslLaunch(spec({ command: "echo \ud800" }), pty, o)).toThrow(/exactly as shown/);
  });
});

/** The lines of a here-document in a script Ember wrote. */
function hereDoc(script: string): string[] {
  const m = /<<'(EMBER_DATA_[0-9a-f]+)'\n([\s\S]*?)\1\nexit\n$/.exec(script);
  return m ? m[2].split("\n").slice(0, -1) : [];
}

/** A distro behind a fake wsl.exe and job host. Runs (anything not a fixed script) are left for the test to drive. */
function distro(o: {
  facts?: string; listed?: WslDistro | null; running?: boolean; jobHost?: JobHostRef | null; sweepNames?: Record<string, string[]>;
  hang?: ("facts" | "boot" | "KILL" | "TERM" | "read")[]; inspect?: (lines: string[]) => string | null; git?: string;
  /** What READ_SCRIPT prints for a path (null: it fails with exit 3, as for a missing or non-regular file). */
  read?: (path: string) => Buffer | string | null;
  /** What the service's cached running set says (default: the distro's real state). */
  cachedRunning?: boolean;
  /** runningNow() answers only once this settles. */
  runningNowWait?: Promise<void>;
} = {}) {
  const runs: SpawnCall[] = [];
  const sweeps: { signal: string; call: SpawnCall; at: number }[] = [];
  const probes: SpawnCall[] = [];
  const uids: number[] = [];
  const boots: SpawnCall[] = [];
  let running = o.running ?? true;
  const fake = fakeSpawn(call => {
    const tail = call.wsl.slice(call.wsl.indexOf("--exec") + 1);
    if (tail[0] === "/bin/sh" && tail[1] === "-s") {
      probes.push(call);
      call.child.onScript = script => {
        running = true;
        if (tail[2] === "--") {
          sweeps.push({ signal: tail[3], call, at: Date.now() });
          if (o.hang?.includes(tail[3] as "KILL")) return;
          const names = o.sweepNames?.[tail[3]] ?? [];
          answerWith(call, { stdout: names.map((n, i) => `${4242 + i} ${n}\n`).join("") });
        } else if (script.includes(FACTS_SCRIPT.split("\n")[0])) {
          if (!o.hang?.includes("facts")) answerWith(call, { stdout: o.facts ?? FACTS_OUT });
        } else if (script.includes(INSPECT_SCRIPT)) {
          const out = o.inspect ? o.inspect(hereDoc(script)) : hereDoc(script).map(p => `1\t${p}\n`).join("");
          if (out === null) answerWith(call, { stderr: utf16("chdir failed\r\n"), code: 1 });
          else answerWith(call, { stdout: out });
        } else if (script === "true\nexit\n") {
          boots.push(call);
          if (!o.hang?.includes("boot")) answerWith(call, { stdout: "" });
        } else if (script.includes(READ_SCRIPT)) {
          if (o.hang?.includes("read")) return;
          const out = o.read ? o.read(hereDoc(script)[0]) : null;
          if (out === null) answerWith(call, { code: 3 });
          else answerWith(call, { stdout: Buffer.concat([SCRIPT_MARKER, Buffer.isBuffer(out) ? out : Buffer.from(out, "utf8")]) });
        } else if (script.includes("rev-parse")) {
          answerWith(call, { stdout: o.git ?? "branch=main\npush=\nupstream=origin/main\n" });
        } else {
          answerWith(call, { stdout: "" });
        }
      };
      return;
    }
    runs.push(call);
  });
  const log = fakeLog();
  const jobHost = o.jobHost === undefined ? JOB : o.jobHost;
  const listed: WslDistro | null = o.listed === undefined ? { name: "Ubuntu", version: 2, isDefault: true, defaultUid: null, running: true, needsSetup: false } : o.listed;
  const exec = createWslExec({ exe: () => EXE, env: ENV, jobHost, spawn: fake.spawn, log });
  const runner: WslRunner = createWslRunner({
    log, distro: "Ubuntu", env: ENV, jobHost, spawn: fake.spawn, exec, exe: () => EXE, listed: async () => listed,
    isRunning: () => o.cachedRunning ?? running,
    runningNow: async () => {
      if (o.runningNowWait) await o.runningNowWait;
      return new Set(running ? ["Ubuntu"] : []);
    },
    windows: () => WINDOWS,
    winPaths: WINDOWS.emberPaths, learnedUid: uid => void uids.push(uid),
  });
  return { runner, runs, sweeps, probes, boots, uids, log, calls: fake.calls, setRunning: (v: boolean) => { running = v; } };
}

/** Waits (through microtasks only) until `cond` holds. */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await flush(5);
  expect(cond()).toBe(true);
}

describe("WSL runner: starting a command", () => {
  it("reads the facts, then runs the command; output reaches the window from the start marker on", async () => {
    const w = distro();
    const run = w.runner.start(spec());
    const seen: Buffer[] = [];
    run.onOutput(c => void seen.push(Buffer.from(c)));
    await until(() => w.runs.length === 1);
    expect(w.uids).toEqual([1000]);
    const child = w.runs[0].child;
    // wsl.exe's warning before the start (UTF-16LE from an inbox wsl.exe) is shown decoded once the command started.
    child.err(utf16("wsl: Failed to translate 'X:\\gone'\r\n"));
    expect(seen).toHaveLength(0);
    child.out(`${MARKER}abc1234 First\r\n`);
    child.exit(0);
    const exit = await run.done;
    expect(exit).toMatchObject({ ended: "exit", code: 0, signal: null });
    expect(Buffer.concat(seen).toString("utf8")).toBe(`wsl: Failed to translate 'X:\\gone'\r\n${MARKER}abc1234 First\r\n`);
    // A late subscriber gets what was kept.
    const late: Buffer[] = [];
    run.onOutput(c => void late.push(Buffer.from(c)));
    expect(Buffer.concat(late).toString("utf8")).toContain("abc1234 First");
  });

  it("reports wsl.exe's own error, decoded, as failed-to-start when the marker never came (critique wsl-17)", async () => {
    const w = distro();
    const run = w.runner.start(spec());
    const seen: Uint8Array[] = [];
    run.onOutput(c => void seen.push(c));
    await until(() => w.runs.length === 1);
    w.runs[0].child.err(utf16("There is no distribution with the supplied name.\r\nError code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND\r\n"));
    w.runs[0].child.exit(4294967295);
    expect(await run.done).toMatchObject({
      ended: "failed-to-start", code: 4294967295, error: "There is no distribution with the supplied name. Error code: Wsl/Service/WSL_E_DISTRO_NOT_FOUND",
    });
    expect(seen).toHaveLength(0);
  });

  it("says the job host couldn't make its job when it exits 125", async () => {
    const w = distro();
    const run = w.runner.start(spec());
    await until(() => w.runs.length === 1);
    w.runs[0].child.err("job\n");
    w.runs[0].child.exit(125);
    expect((await run.done).error).toBe("Ember couldn't put the command in its job object, so it didn't run it");
  });

  it("finds the start marker even after a lot of output before it", async () => {
    const w = distro();
    const run = w.runner.start(spec());
    await until(() => w.runs.length === 1);
    w.runs[0].child.out(Buffer.alloc(300 * 1024, 0x2e));
    w.runs[0].child.out(`${MARKER}ok\n`);
    w.runs[0].child.exit(0);
    expect(await run.done).toMatchObject({ ended: "exit", code: 0 });
  });

  it("an exit code after the marker is the command's own", async () => {
    const w = distro();
    const run = w.runner.start(spec());
    await until(() => w.runs.length === 1);
    w.runs[0].child.out(MARKER);
    w.runs[0].child.out("fatal: not a git repository\n");
    w.runs[0].child.exit(128);
    expect(await run.done).toMatchObject({ ended: "exit", code: 128 });
  });

  it("refuses a distro whose set-up is pending, a hidden or unknown one, and runs nothing in it", async () => {
    const fresh = distro({ listed: { name: "Ubuntu", version: 2, isDefault: false, defaultUid: null, running: false, needsSetup: true } });
    expect(await fresh.runner.start(spec()).done).toMatchObject({ ended: "failed-to-start", error: "Set up Ubuntu first: open it from the Start menu once" });
    await expect(fresh.runner.facts()).rejects.toThrow("Set up Ubuntu first");
    expect(fresh.calls).toHaveLength(0);
    const hidden = distro({ listed: null });
    expect(await hidden.runner.start(spec()).done).toMatchObject({ ended: "failed-to-start", error: "Ubuntu isn't a WSL distro Ember can use" });
    expect(await hidden.runner.inspect(["/etc"], "/")).toEqual([{ exists: null, real: null }]);
    expect(hidden.calls).toHaveLength(0);
  });

  it("refuses to run without the job host (nothing could stop wsl.exe's children)", async () => {
    const w = distro({ jobHost: null });
    expect((await w.runner.start(spec()).done).error).toMatch(/job host is missing/);
    expect(w.calls).toHaveLength(0);
  });

  it("refuses a distro without base64, and a folder WSL can't be given", async () => {
    const w = distro({ facts: FACTS_OUT.replace("base64=1\n", "") });
    expect((await w.runner.start(spec()).done).error).toBe("Ember needs base64 (coreutils) in Ubuntu to pass commands to it");
    const v = distro();
    expect((await v.runner.start(spec({ cwd: '/home/ana/"x"' })).done).error).toBe("Ember can't pass that folder to WSL");
    expect(v.runs).toHaveLength(0);
  });

  it("passes fixed scripts only on stdin: wsl.exe's argv ends in /bin/sh -s (and a sweep's two words)", async () => {
    const w = distro({ sweepNames: {} });
    const run = w.runner.start(spec({ command: "echo SECRET-COMMAND-TEXT" }));
    await until(() => w.runs.length === 1);
    w.runs[0].child.out(MARKER);
    w.runs[0].child.exit(0);
    await run.done;
    await w.runner.inspect(["/home/ana/x"], "/home/ana");
    await w.runner.gitFacts("/home/ana/proj");
    await until(() => w.sweeps.length === 1); // the report-only sweep after a natural end
    expect(w.probes.length).toBeGreaterThanOrEqual(4);
    for (const p of w.probes) {
      const tail = p.wsl.slice(p.wsl.indexOf("--exec") + 1);
      expect(tail.slice(0, 2)).toEqual(["/bin/sh", "-s"]);
      expect(tail.length === 2 || (tail.length === 5 && tail[2] === "--" && /^(INT|TERM|KILL|0)$/.test(tail[3]) && tail[4] === RUN_ID)).toBe(true);
      expect(p.mode).toBe("--interactive");
      expect(p.child.stdinText().endsWith("\nexit\n")).toBe(true);
    }
    for (const c of w.calls) expect([...c.args, ...Object.values(c.options.env)].join(" ")).not.toContain("SECRET-COMMAND-TEXT");
    expect(forbiddenOptions(w.calls)).toEqual([]);
    expect(w.sweeps[0].signal).toBe("0"); // a natural end only looks for what outlived the run
    expect(w.sweeps[0].call.child.stdinText()).toBe(`${SWEEP_SCRIPT}\nexit\n`);
  });

  it("doesn't start a distro the command shut down just to look for what outlived the run", async () => {
    const w = distro({ sweepNames: {} });
    const run = w.runner.start(spec({ command: "sudo poweroff" }));
    await until(() => w.runs.length === 1);
    w.runs[0].child.out(MARKER);
    w.setRunning(false);
    w.runs[0].child.exit(0);
    expect(await run.done).toMatchObject({ ended: "exit", code: 0 });
    await flush(50);
    expect(w.sweeps).toHaveLength(0);
    expect(w.calls).toHaveLength(2); // the facts and the run: nothing after it
  });

  it("reuses the facts for 10 s, then reads them again (the default user may have changed)", async () => {
    vi.useFakeTimers();
    try {
      const w = distro();
      await w.runner.facts();
      await w.runner.facts();
      expect(w.uids).toEqual([1000]);
      expect(w.runner.lastFacts()!.privileged).toBe(false);
      vi.advanceTimersByTime(FACTS_TTL_MS);
      await w.runner.facts();
      expect(w.uids).toEqual([1000, 1000]);
      w.runner.invalidate();
      await w.runner.facts();
      expect(w.uids).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WSL runner: starting a stopped distro", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("says \"Starting Ubuntu…\" while the facts wait for it, and gives it 30 s, not 5", async () => {
    const w = distro({ running: false, hang: ["facts"] });
    const statuses: (string | null)[] = [];
    w.runner.onStatus(t => void statuses.push(t));
    const facts = w.runner.facts();
    facts.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(0);
    expect(w.runner.status()).toBe("Starting Ubuntu…");
    await vi.advanceTimersByTimeAsync(5_000);
    expect(w.probes[0].child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(BOOT_TIMEOUT_MS - 5_000);
    await expect(facts).rejects.toThrow("Ubuntu took too long to start");
    expect(w.probes[0].child.killed).toBe(true);
    expect(statuses).toEqual(["Starting Ubuntu…", null]);
  });

  it("starts a distro that stopped since its facts with a no-op first, then hands it the command", async () => {
    const w = distro();
    await w.runner.facts();
    w.setRunning(false);
    const statuses: (string | null)[] = [];
    w.runner.onStatus(t => void statuses.push(t));
    const run = w.runner.start(spec());
    await vi.advanceTimersByTimeAsync(0);
    expect(w.boots).toHaveLength(1);
    expect(w.runs).toHaveLength(1);
    expect(statuses).toEqual(["Starting Ubuntu…", null]);
    w.runs[0].child.out(MARKER);
    w.runs[0].child.exit(0);
    expect(await run.done).toMatchObject({ ended: "exit", code: 0 });
  });

  it("never hands the command to wsl.exe when Stop comes while the distro boots", async () => {
    const w = distro({ hang: ["boot"] });
    await w.runner.facts();
    w.setRunning(false);
    const run = w.runner.start(spec());
    await vi.advanceTimersByTimeAsync(0);
    expect(w.boots).toHaveLength(1);
    run.stop("user");
    expect(await run.done).toMatchObject({ ended: "stopped-user" });
    expect(w.runs).toHaveLength(0);
  });

  it("never hands the command to wsl.exe when the kill switch comes while the running set is read", async () => {
    let release!: () => void;
    const w = distro({ cachedRunning: false, runningNowWait: new Promise<void>(r => { release = r; }) });
    await w.runner.facts();
    const run = w.runner.start(spec());
    await vi.advanceTimersByTimeAsync(0);
    await w.runner.stopAll("killswitch");
    expect(await run.done).toMatchObject({ ended: "killswitch" });
    // The distro turns out to be running already: still nothing is started for a run that has ended.
    release();
    await vi.advanceTimersByTimeAsync(PRESTART_STOP_MS);
    expect(w.runs).toHaveLength(0);
    expect(w.boots).toHaveLength(0);
  });

  it("stops a run that is still waiting for the distro without ever spawning it", async () => {
    const w = distro({ running: false, hang: ["facts"] });
    const run = w.runner.start(spec());
    await vi.advanceTimersByTimeAsync(0);
    run.stop("user");
    expect(await run.done).toMatchObject({ ended: "stopped-user", code: null });
    await vi.advanceTimersByTimeAsync(BOOT_TIMEOUT_MS);
    expect(w.runs).toHaveLength(0);
  });
});

describe("WSL runner: the stop ladder (§3.13)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  async function started(o: Parameters<typeof distro>[0] = {}) {
    const w = distro(o);
    const run = w.runner.start(spec());
    await vi.advanceTimersByTimeAsync(0);
    expect(w.runs).toHaveLength(1);
    w.runs[0].child.out(MARKER);
    return { w, run, child: w.runs[0].child };
  }

  it("PTY: Ctrl+C at once, TERM at 300 ms, KILL at 1 s and only then the job host, a last KILL sweep at 1.5 s", async () => {
    // A process names itself: a terminal code or a bidi override in its name is shown as "?".
    const { w, run, child } = await started({ sweepNames: { KILL: ["sleep", "\x1b[2Jfake\u202esudo"] } });
    let exit: RunExit | null = null;
    void run.done.then(e => { exit = e; });
    run.stop("user");
    expect(Buffer.concat(child.written).toString("latin1")).toBe("\x03");
    expect(w.sweeps).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(LADDER_MS.term - 1);
    expect(w.sweeps).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.sweeps.map(s => s.signal)).toEqual(["TERM"]);
    expect(w.sweeps[0].call.wsl).toEqual(["-d", "Ubuntu", "--exec", "/bin/sh", "-s", "--", "TERM", RUN_ID]);
    await vi.advanceTimersByTimeAsync(LADDER_MS.kill - LADDER_MS.term - 1);
    expect(child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.sweeps.map(s => s.signal)).toEqual(["TERM", "KILL"]);
    // wsl.exe (through its job host) goes only after the KILL sweep has run (critique wsl-16).
    await vi.advanceTimersByTimeAsync(0);
    expect(child.killed).toBe(true);
    expect(exit).toBeNull();
    await vi.advanceTimersByTimeAsync(LADDER_MS.last - LADDER_MS.kill);
    expect(w.sweeps.map(s => s.signal)).toEqual(["TERM", "KILL", "KILL"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(exit).toMatchObject({ ended: "stopped-user" });
    // Named by RUN's rules: terminal codes and direction marks a process put in its own name are dropped.
    await expect(run.stragglers).resolves.toEqual(["sleep", "[2Jfakesudo"]);
    expect(w.log.lines.some(l => l.msg === "commands.straggler" && l.fields?.count === 2)).toBe(true);
  });

  it("settles what the run left running when wsl.exe fails while the ladder climbs (nothing is left waiting)", async () => {
    const { run, child } = await started();
    run.stop("user");
    await vi.advanceTimersByTimeAsync(LADDER_MS.term);
    child.emit("error", new Error("EPIPE"));
    expect(await run.done).toMatchObject({ ended: "failed-to-start" });
    let names: string[] | null = null;
    void run.stragglers.then(n => { names = n; });
    await vi.advanceTimersByTimeAsync(LADDER_MS.last + 1000);
    expect(names).toEqual([]);
  });

  it("terminates the job host anyway when the KILL sweep hangs", async () => {
    const { run, child } = await started({ hang: ["KILL"] });
    run.stop("task");
    await vi.advanceTimersByTimeAsync(LADDER_MS.kill + 449);
    expect(child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.killed).toBe(true);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await run.done).toMatchObject({ ended: "stopped-task" });
  });

  it("holds a Stop that comes before the command started until it starts, then climbs the ladder at once", async () => {
    const w = distro();
    const run = w.runner.start(spec());
    await vi.advanceTimersByTimeAsync(0);
    const child = w.runs[0].child;
    run.stop("user");
    // A launcher that is already in the distro is killed at once, before it reaches the command.
    expect(w.sweeps.map(s => s.signal)).toEqual(["KILL"]);
    await vi.advanceTimersByTimeAsync(PRESTART_SWEEP_MS - 1);
    // Nothing to interrupt yet, and wsl.exe isn't killed (that could orphan the launcher about to run the command).
    expect(child.written).toHaveLength(0);
    expect(w.sweeps).toHaveLength(1);
    expect(child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.sweeps.map(s => s.signal)).toEqual(["KILL", "KILL"]);
    child.out(MARKER);
    expect(Buffer.concat(child.written).toString("latin1")).toBe("\x03");
    await vi.advanceTimersByTimeAsync(LADDER_MS.last + 10);
    // Once started, no more early sweeps: the ladder's own.
    expect(w.sweeps.map(s => s.signal)).toEqual(["KILL", "KILL", "TERM", "KILL", "KILL"]);
    expect(child.killed).toBe(true);
    expect(await run.done).toMatchObject({ ended: "stopped-user" });
  });

  it("ends wsl.exe after 5 s when a stopped command never starts, and sweeps for a late launcher", async () => {
    const w = distro();
    const run = w.runner.start(spec());
    await vi.advanceTimersByTimeAsync(0);
    const child = w.runs[0].child;
    run.stop("task");
    await vi.advanceTimersByTimeAsync(PRESTART_STOP_MS - 1);
    expect(child.killed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(child.killed).toBe(true);
    expect(await run.done).toMatchObject({ ended: "stopped-task", code: null });
    await vi.advanceTimersByTimeAsync(LADDER_MS.last + 10);
    expect(w.sweeps.map(s => s.signal).every(s => s === "KILL")).toBe(true);
    expect(w.sweeps.length).toBeGreaterThanOrEqual(2);
  });

  it("ends as stopped, not as a failed start, when the early sweep killed the launcher", async () => {
    const w = distro();
    const run = w.runner.start(spec());
    await vi.advanceTimersByTimeAsync(0);
    run.stop("killswitch");
    expect(w.sweeps.map(s => s.signal)).toEqual(["KILL"]);
    w.runs[0].child.exit(137);
    expect(await run.done).toMatchObject({ ended: "killswitch", code: 137 });
    await vi.advanceTimersByTimeAsync(PRESTART_STOP_MS + LADDER_MS.last);
    // The early sweeps end with the run; one last sweep catches anything the launcher left.
    expect(w.sweeps.map(s => s.signal)).toEqual(["KILL", "KILL"]);
    expect(w.runs[0].child.killed).toBe(false);
  });

  it("ends a stopped run even if its job host somehow outlives TerminateProcess", async () => {
    const { w, run, child } = await started();
    child.kill = () => true; // reports success, ends nothing
    run.stop("user");
    await vi.advanceTimersByTimeAsync(LADDER_MS.last + 1_999);
    let ended = false;
    void run.done.then(() => { ended = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(ended).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await run.done).toMatchObject({ ended: "stopped-user", code: null });
    expect(w.log.lines.some(l => l.msg === "wsl.run_unkillable")).toBe(true);
  });

  it("pipes: the first step is the in-distro sweep with INT, sent at once", async () => {
    const { w, run, child } = await started({ facts: FACTS_OUT.replace("script=/usr/bin/script\n", "") });
    expect(w.runs[0].mode).toBe("--batch");
    run.stop("user");
    // The sweep's wsl.exe is spawned synchronously and its script reaches its stdin at once.
    expect(w.sweeps.map(s => s.signal)).toEqual(["INT"]);
    expect(w.probes.at(-1)!.wsl.slice(-3)).toEqual(["--", "INT", RUN_ID]);
    expect(child.written).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(LADDER_MS.last + 10);
    expect(w.sweeps.map(s => s.signal)).toEqual(["INT", "TERM", "KILL", "KILL"]);
  });

  it("the kill switch signals every run at once and ends them as killswitch", async () => {
    const { w, run, child } = await started();
    await w.runner.stopAll("killswitch");
    expect(Buffer.concat(child.written).toString("latin1")).toBe("\x03");
    child.exit(130);
    await vi.advanceTimersByTimeAsync(LADDER_MS.last + 10);
    expect(await run.done).toMatchObject({ ended: "killswitch", code: 130 });
    expect(w.runner.running).toBe(0);
  });

  it("stops a run at its time limit", async () => {
    const w = distro();
    const run = w.runner.start(spec({ timeoutMs: 5_000 }));
    await vi.advanceTimersByTimeAsync(0);
    w.runs[0].child.out(MARKER);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(w.runs[0].child.written).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(Buffer.concat(w.runs[0].child.written).toString("latin1")).toBe("\x03");
    await vi.advanceTimersByTimeAsync(LADDER_MS.last + 10);
    expect(await run.done).toMatchObject({ ended: "timeout" });
  });
});

describe("WSL runner: inspect and git facts", () => {
  it("sends the paths as here-document data on stdin, in the run's folder, and reads the answers", async () => {
    const w = distro({ inspect: lines => lines.map(p => (p === "/home/ana/k" ? "1\t/home/ana/.ssh\n" : `0\t${p}\n`)).join("") });
    const facts = await w.runner.inspect(["/home/ana/k", "/home/ana/a\nb", "/tmp/$(reboot)"], "/home/ana/proj");
    expect(facts).toEqual([{ exists: true, real: "/home/ana/.ssh" }, { exists: null, real: null }, { exists: false, real: "/tmp/$(reboot)" }]);
    const call = w.probes.at(-1)!;
    expect(call.wsl).toEqual(["-d", "Ubuntu", "--cd", "/home/ana/proj", "--exec", "/bin/sh", "-s"]);
    expect(hereDoc(call.child.stdinText())).toEqual(["/home/ana/k", "/tmp/$(reboot)"]);
  });

  it("answers \"couldn't tell\" for everything when the distro fails, and never throws", async () => {
    const w = distro({ inspect: () => null });
    expect(await w.runner.inspect(["/a", "/b"], "/nope")).toEqual([{ exists: null, real: null }, { exists: null, real: null }]);
    const bad = distro();
    expect(await bad.runner.inspect(["/a"], '/x"y')).toEqual([{ exists: null, real: null }]);
    expect(await bad.runner.inspect([], "/")).toEqual([]);
    const short = distro({ inspect: () => "1\t/a\n" });
    expect(await short.runner.inspect(["/a", "/b"], "/")).toEqual([{ exists: null, real: null }, { exists: null, real: null }]);
  });

  it("inspects at most 64 paths", async () => {
    const w = distro();
    const paths = Array.from({ length: 70 }, (_, i) => `/p${i}`);
    const facts = await w.runner.inspect(paths, "/");
    expect(facts.slice(0, 64).every(f => f.exists === true)).toBe(true);
    expect(facts.slice(64)).toEqual(Array(6).fill({ exists: null, real: null }));
  });

  it("reads git's push facts read-only in the folder", async () => {
    const w = distro({ git: "branch=feature-x\npush=simple\nupstream=origin/feature-x\n" });
    expect(await w.runner.gitFacts("/home/ana/proj")).toEqual({ branch: "feature-x", pushDefault: "simple", upstream: "origin/feature-x" });
    expect(w.probes.at(-1)!.wsl.slice(0, 4)).toEqual(["-d", "Ubuntu", "--cd", "/home/ana/proj"]);
    expect(w.probes.at(-1)!.child.stdinText()).toBe(`${GIT_SCRIPT}\nexit\n`);
    expect(await distro({ git: "branch=\npush=\nupstream=\n" }).runner.gitFacts("/tmp")).toBeNull();
  });

  it("runs WB's fixed scripts only in a running distro unless told it may start it", async () => {
    const w = distro({ running: false });
    expect(await w.runner.runScript("gsettings set org.gnome.desktop.interface toolkit-accessibility true")).toBeNull();
    expect(w.calls).toHaveLength(0);
    w.setRunning(true);
    const r = await w.runner.runScript("IFS= read -r p; wslpath -a -u \"$p\"", { lines: ["C:\\Program Files\\Ember\\resources\\sidecar\\atspi\\ember_atspi.py"] });
    expect(r).toMatchObject({ code: 0 });
    expect(hereDoc(w.probes.at(-1)!.child.stdinText())).toEqual(["C:\\Program Files\\Ember\\resources\\sidecar\\atspi\\ember_atspi.py"]);
  });
});

describe("WSL runner: reading a script before it runs (L8, the lead's ruling)", () => {
  it("sends the path as here-document data from /, joined to the command's folder but not normalised, and decodes the bytes", async () => {
    const seen: string[] = [];
    const w = distro({ read: p => { seen.push(p); return "rm -rf build\n"; } });
    expect(await w.runner.readScript("/home/ana/t.sh", "/srv")).toBe("rm -rf build\n");
    expect(await w.runner.readScript("sub/../t.sh", "/home/ana/proj/")).toBe("rm -rf build\n");
    // The shell opens `sub/../t.sh` through sub's real folder: so does realpath in the distro.
    expect(seen).toEqual(["/home/ana/t.sh", "/home/ana/proj/sub/../t.sh"]);
    const call = w.probes.at(-1)!;
    expect(call.wsl).toEqual(["-d", "Ubuntu", "--cd", "/", "--exec", "/bin/sh", "-s"]);
    expect(call.child.stdinText()).toContain(READ_SCRIPT);
    const sent = call.child.stdinText();
    expect(sent.indexOf("/home/ana/proj/sub/../t.sh")).toBeGreaterThan(sent.indexOf("<<'EMBER_DATA_"));
  });

  it("reads only a regular file outside /dev, /proc and /sys, by its real path too, at most one byte over the cap", () => {
    expect(READ_SCRIPT).toContain('[ -f "$p" ] || exit 3');
    expect(READ_SCRIPT).toContain('for x in "$p" "$r"; do case "$x" in /dev|/dev/*|/proc|/proc/*|/sys|/sys/*) exit 3;; esac; done');
    expect(READ_SCRIPT).toContain('case "$p" in /*) ;; *) exit 3;; esac');
    // Read by the path as written (the kernel follows the links the shell will): `$(realpath …)` drops a name's trailing
    // line breaks, so reading the resolved form of a link to `x<LF>` would read `x` (checked under dash and bash).
    expect(READ_SCRIPT).toContain(`dd if="$p" bs=${SCRIPT_READ_BYTES} count=1 2>/dev/null`);
    expect(READ_SCRIPT).not.toMatch(/if="\$r"|-f "\$r"/);
    expect(SCRIPT_READ_BYTES).toBe(65_537);
    // The path never reaches the script's text: it is data only.
    expect(READ_SCRIPT).not.toMatch(/\/home\//);
  });

  it("keeps a byte order mark, reads UTF-16 by its mark, and answers null past the cap or without the marker", () => {
    const at = (b: Buffer) => parseScriptRead(Buffer.concat([Buffer.from("wsl: a warning\n"), SCRIPT_MARKER, b]));
    expect(at(Buffer.from("\uFEFF#!/bin/sh\necho hi\n", "utf8"))).toBe("\uFEFF#!/bin/sh\necho hi\n");
    expect(at(utf16("rm -rf build\n", true))).toBe("\uFEFFrm -rf build\n");
    expect(at(Buffer.alloc(65_536, 0x61))).toHaveLength(65_536);
    expect(at(Buffer.alloc(65_537, 0x61))).toBeNull();
    expect(at(Buffer.alloc(0))).toBe("");
    expect(parseScriptRead(Buffer.from("rm -rf build\n"))).toBeNull();
  });

  it("answers null when the file can't be read whole: missing or not a regular file, too big, or a path it can't send", async () => {
    const w = distro({ read: p => (p === "/home/ana/big.sh" ? Buffer.alloc(65_537, 0x61) : null) });
    expect(await w.runner.readScript("/home/ana/fifo.sh", "/home/ana")).toBeNull();
    expect(await w.runner.readScript("big.sh", "/home/ana")).toBeNull();
    const calls = w.calls.length;
    expect(await w.runner.readScript("a\nb.sh", "/home/ana")).toBeNull();
    expect(await w.runner.readScript("t.sh", "proj")).toBeNull();
    expect(await w.runner.readScript("", "/home/ana")).toBeNull();
    expect(await w.runner.readScript(`/${"x".repeat(4100)}`, "/")).toBeNull();
    expect(w.calls).toHaveLength(calls);
  });

  it("never starts a stopped distro to read a script", async () => {
    const w = distro({ running: false, read: () => "echo hi\n" });
    const statuses: (string | null)[] = [];
    w.runner.onStatus(t => void statuses.push(t));
    expect(await w.runner.readScript("/home/ana/t.sh", "/home/ana")).toBeNull();
    expect(w.calls).toHaveLength(0);
    expect(statuses).toEqual([]);
  });

  it("is what the command flow reads: `sh t.sh` in a distro asks when t.sh deletes, and runs when it doesn't", async () => {
    setCommandJudge(null);
    const flowIn = (script: string) => {
      const w = distro({ read: p => (p === "/home/ana/t.sh" ? script : null) });
      const asked: CommandCard[] = [];
      const service: CommandService = {
        binding: { id: "wsl:Ubuntu", kind: "wsl", label: "Ubuntu (WSL)", screenOs: "win32", shellOs: "linux", desktop: "screen" },
        capability: () => ({ state: "on", askEvery: null }), shells: () => ["bash", "sh"], runner: w.runner,
        window: { showCard: () => undefined, hideCard: () => undefined, cardReady: () => false, announce: async () => false, cancelAnnounce: () => undefined, attach: () => undefined },
        consented: () => undefined, userAskEvery: () => false, mode: () => "on",
      };
      const ctx: CommandFlowContext = {
        task: { id: "t1", title: "Build", commandWords: () => "", agreed: () => [], tainted: () => false, taint: () => undefined, readFrom: () => [] },
        service,
        confirmer: { ask: async (q: { panel?: { card: CommandCard } }) => { if (q.panel) asked.push(q.panel.card); return "deny"; } } as never,
        presenter: { announce: () => undefined, endAnnouncement: () => undefined } as never,
        audit: () => undefined, log: fakeLog(), signal: new AbortController().signal, isOver: () => false,
        state: { cwd: null, downloaded: new Set(), running: false }, size: () => ({ cols: 100, rows: 30 }), emberPids: () => [],
      };
      return { w, asked, run: () => runCommandTool({ target: "Ubuntu", command: "sh t.sh", why: "to build" }, ctx) };
    };
    try {
      const del = flowIn("rm -rf build\n");
      expect((await del.run()).resultType).toBe("denied");
      expect(del.asked[0].says.some(l => /^In t\.sh: .*build/.test(l)), del.asked[0].says.join(" | ")).toBe(true);
      expect(del.w.runs).toHaveLength(0);
      const ok = flowIn("echo building\n");
      void ok.run();
      await until(() => ok.w.runs.length === 1);
      expect(ok.asked).toEqual([]);
    } finally {
      setCommandJudge(null);
    }
  });

  it("gives up after 5 s", async () => {
    vi.useFakeTimers();
    try {
      const w = distro({ hang: ["read"] });
      const got = w.runner.readScript("/home/ana/t.sh", "/home/ana");
      await vi.advanceTimersByTimeAsync(SCRIPT_READ_MS - 1);
      expect(w.probes.at(-1)!.child.killed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(await got).toBeNull();
      expect(w.probes.at(-1)!.child.killed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("WSL runner: typing and secret prompts", () => {
  it("passes the user's typing to the PTY and remembers its lines in memory only", async () => {
    const w = distro();
    const run = w.runner.start(spec());
    await until(() => w.runs.length === 1);
    const child = w.runs[0].child;
    child.out(`${MARKER}[sudo] password for ana: `);
    expect(run.interactive).toBe(true);
    run.input(Buffer.from("hunter22\r", "utf8"));
    child.out("\r\nok\r\n");
    run.input(Buffer.from("\x1b[12;1Rabc\x7fd\r", "utf8")); // a cursor report isn't typing; backspace edits
    run.input(Buffer.from("partial", "utf8"));
    expect(Buffer.concat(child.written).toString("utf8")).toContain("hunter22\r");
    expect(run.typedLines()).toEqual(["hunter22", "abd", "partial"]);
    const spans = run.secretSpans();
    expect(spans).toHaveLength(1);
    const text = `${MARKER}[sudo] password for ana: \r\nok\r\n`;
    expect(spans[0]).toEqual({ from: `${MARKER}[sudo] password for ana: `.length, to: text.indexOf("\n") });
    run.forgetTyped();
    expect(run.typedLines()).toEqual([]);
    child.exit(0);
    await run.done;
    expect(run.interactive).toBe(false);
    expect(w.log.lines.some(l => JSON.stringify(l).includes("hunter22"))).toBe(false);
  });

  it("takes no typing on a pipe run, where a password prompt stays secret to the end", async () => {
    const w = distro({ facts: FACTS_OUT.replace("script=/usr/bin/script\n", "") });
    const run = w.runner.start(spec());
    await until(() => w.runs.length === 1);
    const child = w.runs[0].child;
    child.out(`${MARKER}Password: `);
    expect(run.interactive).toBe(false);
    run.input(Buffer.from("x\r"));
    expect(child.written).toHaveLength(0);
    child.out("\nmore\n");
    // CL's tracker (the runner's default): a span nobody can answer stays open to the end of whatever is printed.
    expect(run.secretSpans()).toEqual([{ from: `${MARKER}Password: `.length, to: OPEN_SPAN_END }]);
    child.exit(1);
    await run.done;
  });
});
