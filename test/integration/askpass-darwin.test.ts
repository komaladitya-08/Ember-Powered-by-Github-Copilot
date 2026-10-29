/**
 * SSH's askpass on a real Mac, as Ember runs it (review #177, owner decision D-177): the macOS build refuses node mode,
 * so the wrapper Ember writes (writeAskpassWrapper) starts Ember itself in its askpass mode. For the development
 * Electron (npm run build) and, with EMBER_PACKAGED_APP, the staged Ember.app: real OpenSSH (ssh-add, unlocking a new
 * passphrase-protected key into a private ssh-agent of the test's) runs the wrapper with the environment Ember gives
 * ssh (sshEnv), and the passphrase comes from Ember's real askpass server; ssh's prompt arrives unchanged; while it
 * asks, the askpass process is never a regular app to LaunchServices (lsappinfo: no Dock icon), and it is the only
 * process of its kind (no Chromium helpers start); a cancel leaves the key locked.
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

/** The processes whose command line has the askpass switch. */
const askpassPids = (): number[] => (spawnSync("/usr/bin/pgrep", ["-f", "--", "--ember-askpass"], { encoding: "utf8" }).stdout ?? "")
  .split("\n").map(Number).filter(n => Number.isInteger(n) && n > 0);

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
   * `answer`; what was asked, how ssh-add ended, what LaunchServices said of the askpass process meanwhile, and how
   * many askpass processes there were.
   */
  async function unlock(name: string, exe: string, appDir: string, answer: string | null) {
    const key = path.join(dir, `key-${name}`);
    const made = spawnSync("/usr/bin/ssh-keygen", ["-q", "-t", "ed25519", "-N", PASSPHRASE, "-C", `ember-askpass-${name}`, "-f", key], { encoding: "utf8" });
    expect(made.status, made.stderr).toBe(0);
    const asked: AskpassRequest[] = [];
    const seen: string[] = [];
    const counts: number[] = [];
    const channel = await createAskpassServer({
      bases: socketBases({ os: "darwin", userData: path.join(dir, name) }), fs: fs.promises as unknown as AskpassFs,
      handler: async req => {
        asked.push(req);
        // While the user would be typing: what the askpass process is to LaunchServices, a few times over 3 s.
        for (let i = 0; i < 10; i++) {
          const pids = askpassPids();
          counts.push(pids.length);
          for (const pid of pids) seen.push(String(launchServicesType(pid)));
          await sleep(300);
        }
        return answer;
      },
    });
    try {
      const wrapper = await writeAskpassWrapper({ fs: fs.promises as unknown as AskpassFs, os: "darwin", userData: path.join(dir, name), execPath: exe, appDir });
      const env = { ...sshEnv(process.env, { os: "darwin", mode: "interactive", askpass: { kind: "socket", program: wrapper, sock: channel.address, nonce: channel.nonce } }), SSH_AUTH_SOCK: agent!.sock };
      const t0 = Date.now();
      // Its own session, no terminal: ssh-add asks through askpass, as Ember's detached ssh does.
      const child = spawn("/usr/bin/ssh-add", [key], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
      let out = "";
      child.stdout.on("data", d => { out += d; });
      child.stderr.on("data", d => { out += d; });
      const code = await new Promise<number | null>(res => child.on("exit", c => res(c)));
      const listed = spawnSync("/usr/bin/ssh-add", ["-l"], { encoding: "utf8", env: { ...process.env, SSH_AUTH_SOCK: agent!.sock } }).stdout ?? "";
      console.log(`askpass-darwin (${name}): ssh-add exit ${String(code)} in ${Date.now() - t0} ms; asked ${JSON.stringify(asked)}; LaunchServices said ${JSON.stringify([...new Set(seen)])}; askpass processes ${JSON.stringify([...new Set(counts)])}; ssh-add said ${JSON.stringify(out.trim())}; agent holds ${JSON.stringify(listed.trim())}`);
      return { code, asked, seen, counts, listed, key };
    } finally {
      await channel.close();
    }
  }

  const check = (r: Awaited<ReturnType<typeof unlock>>, name: string) => {
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0]).toMatchObject({ mode: "secret" });
    expect(r.asked[0].prompt).toContain(`passphrase for ${r.key}`);
    expect(r.code, "ssh-add took the passphrase Ember's askpass printed").toBe(0);
    expect(r.listed).toContain(`ember-askpass-${name}`);
    // No Dock icon: never a regular (Foreground) app while it asked.
    expect(r.seen).not.toContain("Foreground");
    expect(Math.max(...r.counts), "one askpass process: nothing else of Ember (or Chromium) started").toBe(1);
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
