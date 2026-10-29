/**
 * SSH's askpass on a real Mac, as Ember runs it (review #177, owner decision D-177): the macOS build refuses node mode,
 * so the wrapper Ember writes (writeAskpassWrapper) starts Ember itself in its askpass mode. For the development
 * Electron (npm run build) and, with EMBER_PACKAGED_APP, the staged Ember.app: real OpenSSH (ssh-add, unlocking a new
 * passphrase-protected key into a private ssh-agent of the test's) runs the wrapper with the environment Ember gives
 * ssh (sshEnv), and the passphrase comes from Ember's real askpass server; ssh's prompt arrives unchanged. Sampled every
 * 50 ms from ssh-add's start to its exit (the askpass process's whole life, from before Electron's first line, not only
 * once it has connected): the askpass process is never a regular app to LaunchServices (lsappinfo: no Dock icon), there
 * is only one, and it starts no process of its own (pgrep -P: no Chromium helpers, which wouldn't carry the switch). A
 * cancel leaves the key locked.
 *
 * Skipped off macOS; with EMBER_DARWIN_TEST=1 it fails instead of skipping when the build, Electron, ssh-agent,
 * ssh-add or ssh-keygen is missing (and, with EMBER_PACKAGED_APP set, the bundle).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { createAskpassServer, socketBases, writeAskpassWrapper, type AskpassFs, type AskpassRequest } from "../../app/main/remote/askpass-server";
import { sshEnv } from "../../app/main/remote/ssh-argv";
import { ROOT, sleep } from "./darwin-support";

const required = process.env.EMBER_DARWIN_TEST === "1";
const onMac = process.platform === "darwin";
const packaged = process.env.EMBER_PACKAGED_APP ? path.resolve(ROOT, process.env.EMBER_PACKAGED_APP) : "";
const PASSPHRASE = "correct horse battery staple";
const TOOLS = ["/usr/bin/ssh-agent", "/usr/bin/ssh-add", "/usr/bin/ssh-keygen"];

/** Why the suite can't run here, or null. */
function missing(): string | null {
  for (const f of ["main.cjs", "askpass.cjs"]) if (!fs.existsSync(path.join(ROOT, "dist", "app", f))) return `no dist/app/${f} (run npm run build)`;
  for (const t of TOOLS) if (!fs.existsSync(t)) return `no ${t}`;
  if (packaged && !fs.existsSync(path.join(packaged, "Contents", "MacOS", "Ember"))) return `no ${packaged}/Contents/MacOS/Ember`;
  return null;
}

/** What LaunchServices calls the process: "Foreground" (a Dock icon), "UIElement", "BackgroundOnly"; null when it isn't one of its apps. */
function launchServicesType(pid: number): string | null | "no lsappinfo" {
  if (!fs.existsSync("/usr/bin/lsappinfo")) return "no lsappinfo";
  const out = spawnSync("/usr/bin/lsappinfo", ["list"], { encoding: "utf8", timeout: 10_000 }).stdout ?? "";
  return new RegExp(`\\bpid = ${pid} type="([^"]+)"`).exec(out)?.[1] ?? null;
}

const pids = (out: string | null | undefined): number[] => (out ?? "").split("\n").map(Number).filter(n => Number.isInteger(n) && n > 0);

/** The processes whose command line has the askpass switch. */
const askpassPids = (): number[] => pids(spawnSync("/usr/bin/pgrep", ["-f", "--", "--ember-askpass"], { encoding: "utf8" }).stdout);

/**
 * The processes `pid` started, each as "<pid> <command>". Chromium copies no unknown switch to its GPU, network or
 * utility helpers, so askpassPids() would never count one: their parent is what gives them away.
 */
const childrenOf = (pid: number): string[] => pids(spawnSync("/usr/bin/pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout)
  .map(c => `${c} ${(spawnSync("/bin/ps", ["-o", "command=", "-p", String(c)], { encoding: "utf8" }).stdout ?? "").trim()}`);

describe.skipIf(!onMac)("SSH's askpass as Ember itself on macOS (no node mode)", () => {
  let dir = "";
  let agent: { pid: number; sock: string } | null = null;

  beforeAll(() => {
    const why = missing();
    if (why) {
      if (required) throw new Error(`EMBER_DARWIN_TEST=1 but the askpass check can't run: ${why}`);
      console.log(`not testable on this runner: SSH's askpass as Ember: ${why}`);
      return;
    }
    // Short: the agent's and the server's sockets must fit macOS's 104-byte socket paths.
    dir = fs.mkdtempSync("/tmp/ea-t-");
    const sock = path.join(dir, "agent.sock");
    const r = spawnSync("/usr/bin/ssh-agent", ["-s", "-a", sock], { encoding: "utf8", timeout: 10_000 });
    const pid = Number(/SSH_AGENT_PID=(\d+)/.exec(r.stdout ?? "")?.[1]);
    if (!pid) throw new Error(`ssh-agent didn't start: ${r.stdout}${r.stderr}`);
    agent = { pid, sock };
  });

  afterAll(() => {
    if (agent) {
      try { process.kill(agent.pid); } catch { /* gone already */ }
    }
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  /**
   * ssh-add unlocks a new key through Ember's askpass (exe and the app folder it runs from), Ember's server answering
   * `answer`; what was asked, how ssh-add ended, and, sampled every 50 ms while ssh-add ran: what LaunchServices said of
   * each askpass process, how many askpass processes there were, and the processes they started.
   */
  async function unlock(name: string, exe: string, appDir: string, answer: string | null) {
    const key = path.join(dir, `key-${name}`);
    const made = spawnSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", PASSPHRASE, "-C", `ember-askpass-${name}`, "-f", key], { encoding: "utf8" });
    expect(made.status, made.stderr).toBe(0);
    const asked: AskpassRequest[] = [];
    const seen: string[] = [];
    const counts: number[] = [];
    const children: string[] = [];
    const sample = () => {
      const now = askpassPids();
      counts.push(now.length);
      for (const pid of now) {
        seen.push(String(launchServicesType(pid)));
        for (const c of childrenOf(pid)) if (!children.includes(c)) children.push(c);
      }
    };
    const channel = await createAskpassServer({
      bases: socketBases({ os: "darwin", userData: path.join(dir, name) }), fs: fs.promises as unknown as AskpassFs,
      handler: async req => {
        asked.push(req);
        // The user takes a while to type: 3 s, sampled throughout.
        await sleep(3000);
        return answer;
      },
    });
    let sampler: ReturnType<typeof setInterval> | undefined;
    try {
      const wrapper = await writeAskpassWrapper({ fs: fs.promises as unknown as AskpassFs, os: "darwin", userData: path.join(dir, name), execPath: exe, appDir });
      const env = { ...sshEnv(process.env, { os: "darwin", mode: "interactive", askpass: { kind: "socket", program: wrapper, sock: channel.address, nonce: channel.nonce } }), SSH_AUTH_SOCK: agent!.sock };
      const t0 = Date.now();
      // Its own session, no terminal: ssh-add asks through askpass, as Ember's detached ssh does.
      const child = spawn("/usr/bin/ssh-add", [key], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      // From now until ssh-add exits: the askpass process from its start (before Electron's first line and AppKit's
      // start), not only once it has connected, which is long after main.ts asked for no Dock icon.
      sampler = setInterval(sample, 50);
      let out = "";
      child.stdout.on("data", d => { out += d; });
      child.stderr.on("data", d => { out += d; });
      const code = await new Promise<number | null>(res => child.on("exit", c => res(c)));
      clearInterval(sampler);
      const listed = spawnSync("/usr/bin/ssh-add", ["-l"], { encoding: "utf8", env: { ...process.env, SSH_AUTH_SOCK: agent!.sock } }).stdout ?? "";
      console.log(`askpass-darwin (${name}): ssh-add exit ${String(code)} in ${Date.now() - t0} ms; asked ${JSON.stringify(asked)}; LaunchServices said ${JSON.stringify([...new Set(seen)])}; askpass processes ${JSON.stringify([...new Set(counts)])} in ${counts.length} samples; started ${JSON.stringify(children)}; ssh-add said ${JSON.stringify(out.trim())}; agent holds ${JSON.stringify(listed.trim())}`);
      return { code, asked, seen, counts, children, listed, key };
    } finally {
      clearInterval(sampler);
      await channel.close();
    }
  }

  const check = (r: Awaited<ReturnType<typeof unlock>>, name: string) => {
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]).toMatchObject({ mode: "secret" });
    expect(r.asked[0].prompt).toContain(`passphrase for ${r.key}`);
    expect(r.code, "ssh-add took the passphrase Ember's askpass printed").toBe(0);
    expect(r.listed).toContain(`ember-askpass-${name}`);
    // No Dock icon: never a regular (Foreground) app, from its start to its exit.
    expect(r.seen).not.toContain("Foreground");
    expect(Math.max(...r.counts), "one askpass process").toBe(1);
    expect(r.children, "the askpass run started no helper processes").toEqual([]);
  };

  it("unlocks a key through the development Electron in its askpass mode", async () => {
    if (!dir) return;
    const electron = createRequire(import.meta.url)("electron") as unknown as string;
    check(await unlock("dev", electron, path.join(ROOT, "dist", "app"), PASSPHRASE), "dev");
  }, 90_000);

  it("leaves the key locked when the user cancels", async () => {
    if (!dir) return;
    const electron = createRequire(import.meta.url)("electron") as unknown as string;
    const r = await unlock("cancel", electron, path.join(ROOT, "dist", "app"), null);
    expect(r.asked).toHaveLength(1);
    expect(r.code).not.toBe(0);
    expect(r.listed).not.toContain("ember-askpass-cancel");
    expect(r.seen).not.toContain("Foreground");
    expect(Math.max(...r.counts), "one askpass process").toBe(1);
    expect(r.children, "the askpass run started no helper processes").toEqual([]);
  }, 90_000);

  it.runIf(!!packaged)("unlocks a key through the packaged Ember.app in its askpass mode", async () => {
    if (!dir) return;
    const exe = path.join(packaged, "Contents", "MacOS", "Ember");
    check(await unlock("packaged", exe, path.join(packaged, "Contents", "Resources", "app", "dist", "app"), PASSPHRASE), "packaged");
  }, 90_000);

  it.runIf(!packaged)("names the packaged askpass check as not run without EMBER_PACKAGED_APP", () => {
    if (required) throw new Error("EMBER_DARWIN_TEST=1 without EMBER_PACKAGED_APP: stage Ember first and name its bundle (dist/package/Ember.app)");
    console.log("not testable on this runner: the packaged askpass: no EMBER_PACKAGED_APP (stage Ember.app first)");
  });
});
