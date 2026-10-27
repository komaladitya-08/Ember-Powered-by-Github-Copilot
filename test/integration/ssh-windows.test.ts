/**
 * Ember's SSH transport from a Windows PC (the `wsl-windows` job of remote.yml: Ubuntu 22.04 as WSL1 with sshd on
 * port 2222 and the runner's Windows key authorised there). Win32-OpenSSH runs with Ember's hardened argv under no
 * terminal: a batch connect (probe → "Remove Ember") through the real link worker, which also shows Win32-OpenSSH
 * accepts `ControlMaster=no` and `ControlPath=none`; 4 MiB of random bytes both ways through ssh's pipes (and through
 * the mux too, once MX's createMux is merged); the same-machine refusal of this PC's own WSL on loopback; the askpass
 * helper compiled from resources/ssh/ember_askpass.cs by Windows PowerShell 5.1 and answering over Ember's named pipe
 * (when the client is 8.4 or newer, L15); and, with the remote parts built, a connect that says hello.
 *
 * Needs EMBER_SSH_TEST=1 (and EMBER_TEST_ALLOW_LOOPBACK_SSH=1): skipped without it, FAILS with it when Win32-OpenSSH,
 * the sshd in WSL or the build is missing.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminPolicySchema } from "../../app/main/admin";
import { createAskpassPipe, loadPipeApi } from "../../app/main/remote/askpass-pipe";
import { ensureAskpassHelper, powershellPath } from "../../app/main/remote/askpass-win";
import { createConnections } from "../../app/main/remote/connections";
import { createMux } from "../../app/main/remote/mux";
import { sshArgv, sshEnv } from "../../app/main/remote/ssh-argv";
import { parseSshVersion, sshClientPath, versionAtLeast } from "../../app/main/remote/ssh-config";
import type { HostRecord, PromptUi } from "../../app/main/remote/types";
import { DEFAULT_SETTINGS, type Settings, type SettingsStore } from "../../app/main/settings";

const WANTED = process.env.EMBER_SSH_TEST === "1";
const ON_WINDOWS = process.platform === "win32";
const ROOT = join(__dirname, "..", "..");
const APP = join(ROOT, "dist", "app");
const PORT = 2222;
const SSH = sshClientPath("win32", process.env.SystemRoot);

function versionText(): string {
  const r = spawnSync(SSH, ["-V"], { encoding: "utf8", windowsHide: true });
  return `${r.stderr ?? ""}${r.stdout ?? ""}`;
}

function missing(): string | null {
  if (!existsSync(SSH)) return `no ${SSH}`;
  if (!existsSync(join(APP, "remote-link.cjs"))) return "no build (run npm run build)";
  const v = parseSshVersion(versionText());
  if (!v || !versionAtLeast(v, 8, 1)) return `Win32-OpenSSH is older than 8.1 (${versionText().trim()})`;
  const r = spawnSync(SSH, ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-p", String(PORT), "127.0.0.1", "true"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  if (r.status !== 0) return `the WSL sshd on 127.0.0.1:${PORT} isn't reachable with the runner's key (${String(r.stderr).trim().slice(0, 200)})`;
  if (process.env.EMBER_TEST_ALLOW_LOOPBACK_SSH !== "1") return "EMBER_TEST_ALLOW_LOOPBACK_SSH isn't 1";
  return null;
}

const run = WANTED && ON_WINDOWS;
const why = run ? missing() : "EMBER_SSH_TEST isn't 1 (or not Windows)";

describe.skipIf(!run)("SSH transport from Windows (wsl-windows)", () => {
  let tmp = "";
  beforeAll(() => {
    if (why) throw new Error(`EMBER_SSH_TEST=1 but the SSH test facility is missing: ${why}`);
    tmp = mkdtempSync(join(tmpdir(), "ember-ssh-"));
    console.log(`client: ${versionText().trim()}`);
  });
  afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

  function connections(allowLoopback: boolean) {
    let settings: Settings = { ...DEFAULT_SETTINGS, targets: { ...DEFAULT_SETTINGS.targets, pcId: randomBytes(16).toString("hex") } };
    const store = { get: () => settings, own: () => settings, update: (p: Partial<Settings>) => { settings = { ...settings, ...p }; return settings; } } as unknown as SettingsStore;
    const prompts: PromptUi = { ask: async card => ({ id: card.id, ok: false }), dismiss: () => undefined };
    return createConnections({
      log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; }, file: "" },
      os: "win32", userData: mkdtempSync(join(tmp, "ud-")), appDir: APP, execPath: process.execPath, resourcesPath: join(ROOT, "dist"), settings: store,
      admin: () => ({ policy: AdminPolicySchema.parse({}), source: null }), prompts,
      fetch: (url, init) => fetch(url, { signal: init?.signal }) as never, allowLoopback, audit: () => null,
      pcId: () => settings.targets.pcId, wsl: () => null,
      // Step 0a's stub job host refuses every run (exit 125): ssh runs under the job host only once RUN's is built.
      jobHost: existsSync(join(APP, "job-host.cjs")) && !readFileSync(join(APP, "job-host.cjs"), "utf8").includes("job: not built") ? { execPath: process.execPath, script: join(APP, "job-host.cjs") } : null,
    });
  }

  const host = (): HostRecord => ({ id: "wsl-sshd", dest: "127.0.0.1", port: PORT, resolved: { user: "root", hostname: "127.0.0.1", port: PORT, jump: [] }, consent: { version: 1, at: new Date().toISOString() } });

  it("connects in batch mode with ControlMaster=no and ControlPath=none, and runs the bootstrap", async () => {
    const c = connections(true);
    // The login Win32-OpenSSH sends (the runner's, or the ssh config's User) is the one the record must hold.
    const r = await c.resolve("127.0.0.1", { port: PORT });
    await c.uninstall({ ...host(), resolved: { user: r.user, hostname: r.hostname, port: r.port, jump: r.jump } });
  });

  it("refuses this PC's own WSL on loopback without the test switch, before anything is uploaded", async () => {
    await expect(connections(false).connect(host(), { interactive: false })).rejects.toMatchObject({ kind: "same-machine" });
  });

  /** One ssh with Ember's argv whose remote side echoes stdin back (`exec cat` after a marker). */
  function echo(): { stdin: NodeJS.WritableStream; stdout: NodeJS.ReadableStream; ready: Promise<void>; kill(): void } {
    const argv = sshArgv({ ssh: SSH, os: "win32", version: parseSshVersion(versionText()) ?? { major: 8, minor: 1 }, dest: "127.0.0.1", port: PORT, mode: "batch" });
    const child = spawn(argv[0], argv.slice(1), { env: sshEnv(process.env, { os: "win32", mode: "batch" }), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.write("printf 'ECHO-READY\\n'; exec cat\n");
    const out = new PassThrough();
    let buf = Buffer.alloc(0);
    let seen = false;
    const ready = new Promise<void>((resolve, reject) => {
      child.stdout.on("data", (c: Buffer) => {
        if (seen) { out.write(c); return; }
        buf = Buffer.concat([buf, c]);
        const at = buf.indexOf("ECHO-READY\n");
        if (at >= 0) { seen = true; out.write(buf.subarray(at + 11)); resolve(); }
      });
      child.on("exit", code => { if (!seen) reject(new Error(`ssh exited ${code}`)); out.end(); });
    });
    return { stdin: child.stdin, stdout: out, ready, kill: () => child.kill() };
  }

  it("carries 4 MiB of random bytes both ways through Win32-OpenSSH's pipes unchanged (critique integration-30)", async () => {
    const e = echo();
    await e.ready;
    const data = randomBytes(4 * 1024 * 1024);
    const back: Buffer[] = [];
    let got = 0;
    const done = new Promise<void>(resolve => e.stdout.on("data", (c: Buffer) => { back.push(c); got += c.length; if (got >= data.length) resolve(); }));
    e.stdin.write(data);
    await done;
    e.kill();
    expect(createHash("sha256").update(Buffer.concat(back).subarray(0, data.length)).digest("hex")).toBe(createHash("sha256").update(data).digest("hex"));
  }, 120_000);

  it("carries 4 MiB both ways through the mux over two ssh channels (needs MX's createMux)", async () => {
    const stub = (() => { try { createMux({} as never); return null; } catch (err) { return err as Error; } })();
    if (stub && /isn't built/.test(stub.message)) {
      console.log("the mux isn't merged yet: the raw 4 MiB round trip above covers the pipes");
      return;
    }
    const log = { debug() {}, info() {}, warn() {}, error() {}, child() { return log; }, file: "" };
    const a = echo(), b = echo();
    await Promise.all([a.ready, b.ready]);
    // PC → ssh a → agent; agent → ssh b → PC.
    const pc = createMux({ read: b.stdout, write: a.stdin, role: "pc", partsId: "0.0.0-test", log });
    const agentSide = createMux({ read: a.stdout, write: b.stdin, role: "agent", partsId: "0.0.0-test", log });
    const data = randomBytes(4 * 1024 * 1024);
    const gotAgent: Buffer[] = [], gotPc: Buffer[] = [];
    const toAgent = new Promise<void>(r => agentSide.onBytes((_c, bytes) => { gotAgent.push(Buffer.from(bytes)); if (gotAgent.reduce((n, x) => n + x.length, 0) >= data.length) r(); }));
    const toPc = new Promise<void>(r => pc.onBytes((_c, bytes) => { gotPc.push(Buffer.from(bytes)); if (gotPc.reduce((n, x) => n + x.length, 0) >= data.length) r(); }));
    for (let i = 0; i < data.length; i += 32 * 1024) { pc.sendBytes(1, data.subarray(i, i + 32 * 1024)); agentSide.sendBytes(1, data.subarray(i, i + 32 * 1024)); }
    await Promise.all([toAgent, toPc]);
    a.kill(); b.kill();
    const h = (x: Buffer) => createHash("sha256").update(x).digest("hex");
    expect(h(Buffer.concat(gotAgent))).toBe(h(data));
    expect(h(Buffer.concat(gotPc))).toBe(h(data));
  }, 180_000);

  it("compiles the askpass helper with Windows PowerShell 5.1 and it answers over Ember's pipe (8.4+, L15)", async () => {
    const v = parseSshVersion(versionText());
    if (!v || !versionAtLeast(v, 8, 4)) {
      console.log(`Win32-OpenSSH ${v?.major}.${v?.minor} runs no askpass: keys and the ssh-agent only (L15)`);
      return;
    }
    const userData = mkdtempSync(join(tmp, "askpass-"));
    const built = await ensureAskpassHelper({
      userData, source: join(ROOT, "resources", "ssh", "ember_askpass.cs"), powershell: powershellPath(process.env.SystemRoot),
      env: Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined)),
      run: (argv, o) => new Promise(resolve => {
        const c = spawn(argv[0], argv.slice(1), { env: o.env, windowsHide: true });
        let stdout = "";
        c.stdout.on("data", d => { stdout += d; });
        c.on("exit", code => resolve({ code, stdout }));
        c.stdin.end(o.stdin);
      }),
      fs: { readFile: p => fsp.readFile(p), writeFile: (p, d) => fsp.writeFile(p, d), rename: (x, y) => fsp.rename(x, y), rm: p => fsp.rm(p, { force: true }), mkdir: p => fsp.mkdir(p, { recursive: true }) },
    });
    if ("error" in built) throw new Error(`the askpass helper didn't build: ${JSON.stringify(built)}`);
    const api = loadPipeApi();
    expect(api).not.toBeNull();
    const pipe = await createAskpassPipe({ api: api as NonNullable<typeof api>, handler: async r => `answer to ${r.prompt.slice(0, 20)}` });
    // Asynchronously: the pipe's answers run on this event loop, which spawnSync would block until the helper gave up.
    const helper = (args: string[], nonce: string) => new Promise<{ status: number | null; stdout: string }>(resolve => {
      const c = spawn(built.exe, args, { env: { ...process.env, EMBER_ASKPASS_PIPE: pipe.address, EMBER_ASKPASS_NONCE: nonce }, windowsHide: true, timeout: 30_000 });
      let stdout = "";
      c.stdout.setEncoding("utf8");
      c.stdout.on("data", d => { stdout += d; });
      c.on("close", status => resolve({ status, stdout }));
    });
    const r = await helper(["deploy@build-01's", "password:"], pipe.nonce);
    const wrong = await helper(["p"], "0".repeat(32));
    await pipe.close();
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("answer to deploy@build-01's pa\n");
    expect(wrong.status).toBe(1);
    expect(readFileSync(built.exe).length).toBeGreaterThan(0);
  }, 120_000);

  const partsBuilt = existsSync(join(ROOT, "dist", "remote-parts", "remote-parts.json"));
  it.skipIf(!partsBuilt)("connects with the test switch and says hello, or refuses a kernel older than 4.18 before installing (needs the remote parts)", async () => {
    const c = connections(true);
    const resolved = await c.resolve("127.0.0.1", { port: PORT });
    const record = { ...host(), resolved: { user: resolved.user, hostname: resolved.hostname, port: resolved.port, jump: resolved.jump } };
    // WSL1 reports an emulated 4.4 kernel, below the agent's Linux 4.18: Ember must refuse it from its probe, with
    // nothing installed. A real kernel (WSL2, a server) says hello.
    const kernel = spawnSync(SSH, ["-o", "BatchMode=yes", "-p", String(PORT), "127.0.0.1", "uname -r"], { encoding: "utf8", windowsHide: true, timeout: 30_000 }).stdout.trim();
    console.log(`remote kernel: ${kernel}`);
    const [major, minor] = kernel.split(".").map(Number);
    if (major < 4 || (major === 4 && minor < 18)) {
      await expect(c.connect(record, { interactive: false })).rejects.toMatchObject({ kind: "unsupported", message: expect.stringContaining("Linux 4.18") });
      const installed = spawnSync(SSH, ["-o", "BatchMode=yes", "-p", String(PORT), "127.0.0.1", "{ test -e ~/.local/share/ember-remote/runtime || test -e ~/.local/share/ember-remote/versions; } && echo yes || echo no"], { encoding: "utf8", windowsHide: true, timeout: 30_000 }).stdout.trim();
      expect(installed).toBe("no");
      return;
    }
    const link = await c.connect(record, { interactive: false });
    expect(link.welcome.isWsl).toBe(true);
    await c.disconnect("wsl-sshd");
  }, 300_000);
});

describe.skipIf(run)("SSH transport from Windows (skipped)", () => {
  it("is skipped without EMBER_SSH_TEST=1 on Windows", () => {
    expect(why).toBeTruthy();
  });
});
