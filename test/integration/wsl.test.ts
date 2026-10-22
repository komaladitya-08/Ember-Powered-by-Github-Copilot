/**
 * WSL on a real Windows runner (design §10.2: the `wsl-windows` job, Ubuntu 22.04 as WSL1 with the inbox UTF-16
 * wsl.exe, root by default; the `wsl2-windows` job, the Store WSL as WSL2 with systemd on and a non-root default user
 * set in /etc/wsl.conf while the registry still says 0). createWsl as main makes it, with Ember's job host built by
 * `npm run build` (dist/app/job-host.cjs, run here by this Node).
 *
 * What it checks: discovery on the real wsl.exe and registry; that listing, defaultUid and bootIds never start a stopped
 * distro (the WSL2 job stops it in its set-up); the facts (util-linux script, interop under systemd's
 * WSLInterop-late, the drive root, the uid from inside against the registry's hint, RunOOBE's value); the runner with
 * script (a PTY on WSL1 too), exit codes, a multi-line command through EMBER_CMD_B64, WSLENV replaced, a failed start
 * with wsl.exe's own message decoded; Stop (Ctrl+C, and the sweeps when the command ignores it), stragglers named; an
 * interop child ended with the job; inspect (paths as data, symlinks resolved) and git facts; boot ids; the doctor row;
 * and L22's channel check (4 MiB of random bytes through wsl.exe's stdio unchanged; the ssh half waits for SA).
 *
 * Skipped without EMBER_WSL_TEST; with EMBER_WSL_TEST=1 it fails when Windows, WSL, the distro or the built job host is
 * missing. The jobs' set-up exports EMBER_WSL_TEST_DISTRO, EMBER_WSL_EXPECT_VERSION, EMBER_WSL_EXPECT_ROOT,
 * EMBER_WSL_EXPECT_STOPPED and EMBER_WSL_EXPECT_SYSTEMD.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RunExit, RunSpec } from "../../app/main/commands/types";
import { createLogger } from "../../app/main/logger";
import { createWsl, type WslServiceImpl } from "../../app/main/wsl/service";
import { LXSS_KEY, loadLxssRegistry, readLxss } from "../../app/main/wsl/lxss";
import type { WslRunner, WslRunningCommand } from "../../app/main/wsl/runner";

const required = process.env.EMBER_WSL_TEST === "1";
const DISTRO = process.env.EMBER_WSL_TEST_DISTRO ?? "Ubuntu-22.04";
const EXPECT_VERSION = process.env.EMBER_WSL_EXPECT_VERSION;
const EXPECT_ROOT = process.env.EMBER_WSL_EXPECT_ROOT;
const EXPECT_STOPPED = process.env.EMBER_WSL_EXPECT_STOPPED === "1";
const EXPECT_SYSTEMD = process.env.EMBER_WSL_EXPECT_SYSTEMD === "1";
const root = fileURLToPath(new URL("../../", import.meta.url));
const jobHostScript = path.join(root, "dist", "app", "job-host.cjs");
const MARKER = "\x1b]777;ember-start\x07";
const LONG = 90_000;

const suite = required ? describe : describe.skip;

let n = 0;
function spec(command: string, over: Partial<RunSpec> = {}): RunSpec {
  const runId = randomBytes(8).toString("hex");
  return {
    runId, taskId: `wa-${++n}`, shell: "bash", command, cwd: "/tmp", timeoutMs: 60_000, cols: 100, rows: 30,
    stamp: { taskId: `wa-${n}`, sha256: "0".repeat(64), verdict: "run", classes: [], rules: [], approval: null },
    ...over,
  };
}

/** Runs a command to its end; its output as text. */
async function run(r: WslRunner, command: string, over: Partial<RunSpec> = {}): Promise<{ exit: RunExit; out: string; cmd: WslRunningCommand }> {
  const cmd = r.start(spec(command, over));
  const chunks: Buffer[] = [];
  cmd.onOutput(c => void chunks.push(Buffer.from(c)));
  const exit = await cmd.done;
  return { exit, out: Buffer.concat(chunks).toString("utf8"), cmd };
}

/** Waits until the run's output holds `text` (or fails after `ms`). */
function waitFor(cmd: WslRunningCommand, text: string, ms = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    let seen = "";
    const timer = setTimeout(() => reject(new Error(`no "${text}" in ${JSON.stringify(seen.slice(-500))}`)), ms);
    cmd.onOutput(c => {
      seen += Buffer.from(c).toString("utf8");
      if (seen.includes(text)) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
}

/** The pids in the distro still carrying a run's marker. */
async function carrying(r: WslRunner, runId: string): Promise<string> {
  const res = await r.runScript(`for p in /proc/[0-9]*; do grep -qz "^EMBER_RUN_ID=${runId}\\$" "$p/environ" 2>/dev/null && echo "\${p#/proc/}"; done; true`);
  expect(res).not.toBeNull();
  return res!.stdout.toString("utf8").trim();
}

suite("WSL on a real Windows runner", () => {
  let wsl: WslServiceImpl;
  let runner: WslRunner;

  beforeAll(() => {
    if (process.platform !== "win32") throw new Error("EMBER_WSL_TEST=1 needs Windows with WSL");
    if (!fs.existsSync(jobHostScript)) throw new Error("dist/app/job-host.cjs is missing: run npm run build first");
    const logDir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-wsl-test-"));
    // The job host must be RUN's real one: Step 0a's stub refuses every run (exit 125, "job").
    const probe = spawnSync(process.execPath, [jobHostScript, "--batch", "--", process.execPath, "-e", "process.exit(7)"], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, input: "" });
    if (probe.status !== 7) throw new Error(`the job host doesn't run programs yet (exit ${probe.status}: ${probe.stderr.toString().trim()}); it is Step 0a's stub until RUN merges`);
    const created = createWsl({
      log: createLogger({ dir: logDir, level: "debug" }),
      // The user's own WSLENV and a variable of theirs: neither may reach the distro (X11).
      env: { ...process.env, WSLENV: "USERPROFILE/p:WA_LEAK_TEST/u", WA_LEAK_TEST: "leaked" },
      os: "win32",
      ember: { winPaths: [path.win32.join(process.env.LOCALAPPDATA ?? "C:\\Users\\runner\\AppData\\Local", "ember")] },
      jobHost: { execPath: process.execPath, script: jobHostScript },
    });
    if (!created) throw new Error("createWsl found no wsl.exe");
    wsl = created as WslServiceImpl;
    runner = wsl.runner(DISTRO);
  });

  afterAll(() => wsl?.dispose());

  it("lists the distro from the registry and wsl.exe without starting it", async () => {
    const f = await wsl.facts();
    console.log("wsl facts", JSON.stringify(f));
    expect(f.installed).toBe(true);
    expect(f.wslExe).toMatch(/wsl\.exe$/i);
    const d = f.distros.find(x => x.name === DISTRO);
    expect(d).toBeDefined();
    if (EXPECT_VERSION) expect(d!.version).toBe(Number(EXPECT_VERSION));
    expect(d!.needsSetup).toBe(false);
    if (EXPECT_VERSION === "2") expect(f.wslVersion).toMatch(/^\d+\.\d+\.\d+/);
    // The registry reader works on real Windows (State 1 = installed; RunOOBE's value recorded for the design's verify).
    const reg = loadLxssRegistry();
    expect(reg).not.toBeNull();
    const l = readLxss(reg!);
    expect(l?.distros.map(x => x.name)).toContain(DISTRO);
    const entry = l!.distros.find(x => x.name === DISTRO)!;
    const key = reg!.openUser(`${LXSS_KEY}\\${entry.guid}`)!;
    console.log("lxss", DISTRO, JSON.stringify({ State: key.dword("State"), RunOOBE: key.dword("RunOOBE"), DefaultUid: key.dword("DefaultUid"), Version: key.dword("Version"), Flags: key.dword("Flags") }));
    key.close();
    if (EXPECT_STOPPED) {
      expect(d!.running).toBe(false);
      expect((await wsl.runningNow()).has(DISTRO)).toBe(false);
      await wsl.facts({ refresh: true });
      expect(await wsl.defaultUid(DISTRO)).toBeNull();
      expect(await wsl.bootIds()).toEqual([]);
      expect(await runner.runScript("true")).toBeNull();
      // Nothing above started it (critique wsl-19: --list --running never boots it either).
      expect((await wsl.runningNow()).has(DISTRO)).toBe(false);
    }
  }, LONG);

  it("reads the distro's facts (it may start it), with the uid from inside", async () => {
    const statuses: (string | null)[] = [];
    runner.onStatus(t => void statuses.push(t));
    const f = await runner.facts();
    console.log("runner facts", JSON.stringify(f), "statuses", JSON.stringify(statuses));
    if (EXPECT_STOPPED) expect(statuses).toEqual([`Starting ${DISTRO}…`, null]);
    expect(f.os).toBe("linux");
    expect(f.shells[0]).toBe("bash");
    expect(f.script).toEqual({ path: expect.stringMatching(/\/script$/), kind: "util-linux" });
    expect(f.wsl?.mountRoot).toBe("/mnt/");
    expect(f.wsl?.interop).toBe(true);
    expect(f.ember.paths[0]).toMatch(/^\/mnt\/c\/.*\/ember$/i);
    if (EXPECT_ROOT === "1") expect(f.privileged).toBe(true);
    if (EXPECT_ROOT === "0") {
      // /etc/wsl.conf's [user] default= wins over the registry's DefaultUid (critique wsl-7).
      expect(f.privileged).toBe(false);
      expect(f.user).not.toBe("root");
    }
    // The uid the distro reported is now the listed one, whatever the registry's hint said.
    const listed = (await wsl.facts()).distros.find(x => x.name === DISTRO)!;
    expect(listed.defaultUid).not.toBeNull();
    expect(listed.defaultUid === 0).toBe(f.privileged);
    expect(await wsl.defaultUid(DISTRO)).toBe(listed.defaultUid);
    if (EXPECT_SYSTEMD) {
      const binfmt = await runner.runScript("ls /proc/sys/fs/binfmt_misc/; ps -p 1 -o comm=");
      console.log("binfmt and pid 1", binfmt?.stdout.toString());
    }
  }, LONG);

  it("runs a command in a PTY through script, with UTF-8 and the exit code", async () => {
    const { exit, out } = await run(runner, "tty; echo \"term=$TERM\"; printf 'é 日本\\n'; exit 3");
    console.log("pty run", JSON.stringify(out));
    expect(exit).toMatchObject({ ended: "exit", code: 3 });
    expect(out.startsWith(MARKER)).toBe(true);
    expect(out).toMatch(/\/dev\/pts\/\d+/);
    expect(out).toContain("term=xterm-256color");
    expect(out).toContain("é 日本");
  }, LONG);

  it("passes a multi-line command with quotes, backslashes and a here-document exactly", async () => {
    const command = [
      "x='it'\"'\"'s \\\\ \"quoted\" $HOME'",
      "printf '%s\\n' \"$x\"",
      "cat <<'EOF'",
      "line $with `no` expansion",
      "EOF",
      "[ -z \"$EMBER_CMD_B64\" ] && echo text-cleared",
    ].join("\n");
    const { exit, out } = await run(runner, command);
    expect(exit.code).toBe(0);
    expect(out).toContain("it's \\\\ \"quoted\" $HOME");
    expect(out).toContain("line $with `no` expansion");
    expect(out).toContain("text-cleared");
  }, LONG);

  it("lets only Ember's variables cross: the user's WSLENV is replaced", async () => {
    const { out } = await run(runner, "echo \"[${USERPROFILE:-none}] [${WA_LEAK_TEST:-none}] [${EMBER_RUN_ID:+marked}]\"");
    expect(out).toContain("[none] [none] [marked]");
  }, LONG);

  it("reports wsl.exe's own error, decoded, when the folder doesn't exist", async () => {
    const { exit, out } = await run(runner, "echo never", { cwd: "/nonexistent-ember-wa-folder" });
    console.log("failed start", JSON.stringify(exit));
    expect(exit.ended).toBe("failed-to-start");
    expect(exit.error).toBeTruthy();
    expect(exit.error).not.toContain("\0");
    expect(out).toBe("");
  }, LONG);

  it("stops a command with Ctrl+C, leaving nothing with its marker", async () => {
    const cmd = runner.start(spec("echo ready; sleep 1000"));
    await waitFor(cmd, "ready");
    const t0 = Date.now();
    cmd.stop("user");
    const exit = await cmd.done;
    console.log("ctrl+c", Date.now() - t0, "ms", JSON.stringify(exit));
    expect(exit.ended).toBe("stopped-user");
    expect(Date.now() - t0).toBeLessThan(6_000);
    expect(await carrying(runner, cmd.runId)).toBe("");
  }, LONG);

  it("stops a command that ignores Ctrl+C through the in-distro sweeps", async () => {
    const cmd = runner.start(spec("trap '' INT; echo ready; sleep 1000 & wait"));
    await waitFor(cmd, "ready");
    cmd.stop("user");
    const exit = await cmd.done;
    expect(exit.ended).toBe("stopped-user");
    expect(await carrying(runner, cmd.runId)).toBe("");
  }, LONG);

  it("names a program that outlives the run, and leaves it alone", async () => {
    const { exit, cmd } = await run(runner, "setsid sleep 1000 >/dev/null 2>&1 < /dev/null & echo started");
    expect(exit.code).toBe(0);
    // Known once the look a run that ended by itself gets has come back.
    expect(await cmd.stragglers).toContain("sleep");
    expect(await carrying(runner, cmd.runId)).not.toBe("");
    await runner.runScript(`for p in /proc/[0-9]*; do grep -qz "^EMBER_RUN_ID=${cmd.runId}\\$" "$p/environ" 2>/dev/null && kill -9 "\${p#/proc/}"; done; true`);
  }, LONG);

  it("ends an interop child (a Windows program) with the job when the run ends", async () => {
    const facts = await runner.facts();
    if (!facts.wsl?.interop) {
      console.log("not testable on this runner: interop is off in the distro");
      return;
    }
    const before = spawnSync("tasklist", ["/FI", "IMAGENAME eq PING.EXE", "/FO", "CSV", "/NH"], { windowsHide: true }).stdout.toString();
    expect(before).not.toMatch(/PING\.EXE/i);
    const cmd = runner.start(spec("/mnt/c/Windows/System32/PING.EXE -n 120 127.0.0.1 >/dev/null & sleep 2; echo spawned"));
    await waitFor(cmd, "spawned");
    const exit = await cmd.done;
    expect(exit.code).toBe(0);
    await new Promise(r => setTimeout(r, 1_500));
    const after = spawnSync("tasklist", ["/FI", "IMAGENAME eq PING.EXE", "/FO", "CSV", "/NH"], { windowsHide: true }).stdout.toString();
    console.log("interop child after the run", JSON.stringify(after));
    expect(after).not.toMatch(/PING\.EXE/i);
  }, LONG);

  it("inspects paths as data (never run) and resolves symlinks", async () => {
    await run(runner, "rm -f /tmp/ember-wa-pwned; ln -sfn /etc /tmp/ember-wa-link");
    const facts = await runner.inspect(["/etc/hostname", "/nonexistent/x", "/tmp/$(touch /tmp/ember-wa-pwned)", "/tmp/ember-wa-link/hostname", "/tmp/a\nb"], "/tmp");
    expect(facts[0]).toEqual({ exists: true, real: "/etc/hostname" });
    expect(facts[1]).toEqual({ exists: false, real: "/nonexistent/x" });
    expect(facts[2].exists).toBe(false);
    expect(facts[3]).toEqual({ exists: true, real: "/etc/hostname" });
    expect(facts[4]).toEqual({ exists: null, real: null });
    const pwned = await runner.runScript("[ -e /tmp/ember-wa-pwned ] && echo yes || echo no");
    expect(pwned!.stdout.toString().trim()).toBe("no");
  }, LONG);

  it("reads git's push facts in a work tree, and none outside one", async () => {
    const git = await runner.runScript("command -v git >/dev/null && echo yes || echo no");
    if (git!.stdout.toString().trim() !== "yes") {
      console.log("not testable on this runner: git isn't installed in the distro");
      return;
    }
    const made = await run(runner, "rm -rf /tmp/ember-wa-git && git init -q /tmp/ember-wa-git && cd /tmp/ember-wa-git && git checkout -q -b feature-x && git -c user.email=a@b -c user.name=a commit -q --allow-empty -m x && git config push.default simple && echo made");
    expect(made.out).toContain("made");
    expect(await runner.gitFacts("/tmp/ember-wa-git")).toEqual({ branch: "feature-x", pushDefault: "simple", upstream: null });
    expect(await runner.gitFacts("/")).toBeNull();
  }, LONG);

  it("hashes the boot id of a running WSL2 distro only", async () => {
    const ids = await wsl.bootIds();
    console.log("boot ids", JSON.stringify(ids));
    if (EXPECT_VERSION === "2") expect(ids).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/)]);
    if (EXPECT_VERSION === "1") expect(ids).toEqual([]);
  }, LONG);

  it("gives the doctor's wsl row", async () => {
    const rows = await wsl.doctorRows();
    console.log("doctor", JSON.stringify(rows));
    expect(rows[0]).toMatchObject({ id: "wsl", label: "WSL" });
  }, LONG);

  it("carries 4 MiB of random bytes through wsl.exe's stdio unchanged (L22's channel)", async () => {
    const exe = (await wsl.facts()).wslExe!;
    const data = randomBytes(4 * 1024 * 1024);
    const child = spawn(exe, ["-d", DISTRO, "--exec", "/bin/cat"], { env: { ...process.env, WSL_UTF8: "1", WSLENV: "" }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const got: Buffer[] = [];
    child.stdout.on("data", b => void got.push(b));
    const done = new Promise<number | null>(resolve => child.on("close", code => resolve(code)));
    child.stdin.end(data);
    expect(await done).toBe(0);
    const back = Buffer.concat(got);
    expect(back.length).toBe(data.length);
    expect(back.equals(data)).toBe(true);
    // The ssh half (`wsl.exe --exec /usr/bin/ssh` carrying the framed stream) is SA's ssh-windows test once it merges.
  }, LONG);
});
