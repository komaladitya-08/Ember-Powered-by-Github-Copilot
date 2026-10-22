/**
 * Ember's SSH transport against real OpenSSH (the `ssh-linux` job of remote.yml: sshd on 127.0.0.1:2222 with the
 * runner's own key authorised, a second sshd on 2223 as a jump host, and `~/.ssh/config` holding the aliases
 * `ember-master` (ControlMaster auto, ControlPersist 60) and `ember-jumped` (ProxyJump 127.0.0.1:2223)).
 *
 * It runs the real link worker (dist/app/remote-link.cjs, so `npm run build` first) and the real bootstrap under the
 * runner's /bin/sh (dash on Ubuntu): ssh -G, a batch connect with Ember's hardened argv, an unknown host key taking the
 * interactive path with a fake prompt window answering, a changed host key refused without a prompt, an
 * authentication failure classified, the ProxyJump rewrite through the 2223 hop, and the user's `ControlMaster auto`
 * leaving no master behind. The connection checks use Ember's "Remove Ember" path (probe → UNINSTALL), which needs no
 * remote parts; with the parts built (dist/remote-parts, SB) and the mux merged (MX), it also connects and says hello.
 *
 * Needs EMBER_SSH_TEST=1 (and EMBER_TEST_ALLOW_LOOPBACK_SSH=1, since the "remote" is this runner): skipped without it,
 * and FAILS with it when ssh, the sshd or the build is missing.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AdminPolicySchema } from "../../app/main/admin";
import { createConnections } from "../../app/main/remote/connections";
import { ConnectError, type HostRecord, type PromptUi } from "../../app/main/remote/types";
import { DEFAULT_SETTINGS, type Settings, type SettingsStore } from "../../app/main/settings";
import type { PromptCard } from "../../app/shared/remote-ui";

const WANTED = process.env.EMBER_SSH_TEST === "1";
const ON_LINUX = process.platform === "linux";
const ROOT = join(__dirname, "..", "..");
const APP = join(ROOT, "dist", "app");
const PORT = 2222;

/** Why the suite can't run here, or null. */
function missing(): string | null {
  if (!existsSync("/usr/bin/ssh")) return "no /usr/bin/ssh";
  if (!existsSync(join(APP, "remote-link.cjs")) || !existsSync(join(APP, "askpass.cjs"))) return "no build (run npm run build)";
  const r = spawnSync("/usr/bin/ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-p", String(PORT), "127.0.0.1", "true"], { timeout: 15_000 });
  if (r.status !== 0) return `sshd on 127.0.0.1:${PORT} isn't reachable with the runner's key (${String(r.stderr).trim().slice(0, 200)})`;
  if (process.env.EMBER_TEST_ALLOW_LOOPBACK_SSH !== "1") return "EMBER_TEST_ALLOW_LOOPBACK_SSH isn't 1";
  return null;
}

const why = WANTED && ON_LINUX ? missing() : "EMBER_SSH_TEST isn't 1 (or not Linux)";
const run = WANTED && ON_LINUX;

describe.skipIf(!run)("SSH transport against real OpenSSH (ssh-linux)", () => {
  let tmp = "";
  const user = (() => { try { return execFileSync("id", ["-un"], { encoding: "utf8" }).trim(); } catch { return "runner"; } })();
  const cards: PromptCard[] = [];

  beforeAll(() => {
    if (why) throw new Error(`EMBER_SSH_TEST=1 but the SSH test facility is missing: ${why}`);
    tmp = mkdtempSync(join(tmpdir(), "ember-ssh-"));
  });
  afterAll(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }); });

  /** Connections with real ssh, the real worker and a fake prompt window that answers `answer`. */
  function connections(o: { allowLoopback?: boolean; answer?: (c: PromptCard) => { ok: boolean; value?: string }; hosts?: HostRecord[] } = {}) {
    let settings: Settings = { ...DEFAULT_SETTINGS, targets: { ...DEFAULT_SETTINGS.targets, hosts: o.hosts ?? [], pcId: randomBytes(16).toString("hex") } };
    const store = { get: () => settings, own: () => settings, update: (p: Partial<Settings>) => { settings = { ...settings, ...p }; return settings; } } as unknown as SettingsStore;
    const prompts: PromptUi = { ask: async card => { cards.push(card); return { id: card.id, ...(o.answer ? o.answer(card) : { ok: false }) }; }, dismiss: () => undefined };
    const userData = mkdtempSync(join(tmp, "ud-"));
    return createConnections({
      log: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; }, file: "" },
      os: "linux", userData, appDir: APP, execPath: process.execPath, resourcesPath: join(ROOT, "dist"), settings: store,
      admin: () => ({ policy: AdminPolicySchema.parse({}), source: null }), prompts,
      fetch: (url, init) => fetch(url, { signal: init?.signal }) as never,
      allowLoopback: o.allowLoopback ?? true, audit: () => null, pcId: () => settings.targets.pcId, wsl: () => null, jobHost: null,
    });
  }

  const host = (dest: string, over: Partial<HostRecord> = {}): HostRecord => ({
    id: "local-test", dest, port: dest.includes("ember-") ? undefined : PORT,
    resolved: { user, hostname: "127.0.0.1", port: PORT, jump: [] }, consent: { version: 1, at: new Date().toISOString() }, ...over,
  });

  it("resolves with ssh -G, the carried port included", async () => {
    const c = connections();
    expect(await c.resolve("127.0.0.1", { port: PORT })).toEqual({ user, hostname: "127.0.0.1", port: PORT, jump: [], controlPath: null });
    const jumped = await c.resolve("ember-jumped");
    expect(jumped).toMatchObject({ hostname: "127.0.0.1", port: PORT, jump: ["127.0.0.1:2223"] });
  });

  it("connects in batch mode with Ember's hardened argv and runs the bootstrap under the remote's sh", async () => {
    const c = connections();
    await c.uninstall(host("127.0.0.1"));
  });

  it("refuses this same computer without the test switch, before anything runs", async () => {
    const c = connections({ allowLoopback: false });
    await expect(c.connect(host("127.0.0.1"), { interactive: false })).rejects.toMatchObject({ kind: "same-machine" });
  });

  it("asks about an unknown host key through the prompt window and accepts it only on the user's yes", async () => {
    const kh = join(tmp, "known_hosts_new");
    writeFileSync(kh, "");
    const cfg = join(tmp, "config-new");
    writeFileSync(cfg, `Host fresh\n  HostName 127.0.0.1\n  Port ${PORT}\n  UserKnownHostsFile ${kh}\n`);
    // Cancelled: nothing accepted.
    cards.length = 0;
    const no = connections();
    await expect(no.uninstall(host("fresh", { extra: { configFile: cfg } }))).rejects.toMatchObject({ kind: "cancelled" });
    expect(cards.map(c => c.kind)).toEqual(["host-key"]);
    // Trusted: connected, and the key is now known.
    cards.length = 0;
    const yes = connections({ answer: () => ({ ok: true }) });
    await yes.uninstall(host("fresh", { extra: { configFile: cfg } }));
    expect(cards).toEqual([expect.objectContaining({ kind: "host-key", fingerprint: expect.stringMatching(/^SHA256:/) })]);
    expect(spawnSync("ssh-keygen", ["-F", `[127.0.0.1]:${PORT}`, "-f", kh]).status).toBe(0);
  });

  it("refuses a changed host key without offering to accept it", async () => {
    const kh = join(tmp, "known_hosts_wrong");
    const keyFile = join(tmp, "other_key");
    execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", keyFile]);
    const pub = execFileSync("cat", [`${keyFile}.pub`], { encoding: "utf8" }).trim().split(" ").slice(0, 2).join(" ");
    writeFileSync(kh, `[127.0.0.1]:${PORT} ${pub}\n`);
    const cfg = join(tmp, "config-wrong");
    writeFileSync(cfg, `Host changed\n  HostName 127.0.0.1\n  Port ${PORT}\n  UserKnownHostsFile ${kh}\n`);
    cards.length = 0;
    const c = connections({ answer: () => ({ ok: true }) });
    const err = await c.uninstall(host("changed", { extra: { configFile: cfg } })).catch(e => e);
    expect(err).toBeInstanceOf(ConnectError);
    expect(err.kind).toBe("host-key-changed");
    expect(cards).toEqual([]);
  });

  it("classifies a refused key as an authentication failure", async () => {
    const cfg = join(tmp, "config-auth");
    writeFileSync(cfg, `Host nokey\n  HostName 127.0.0.1\n  Port ${PORT}\n  IdentityFile /dev/null\n  IdentitiesOnly yes\n  IdentityAgent none\n  PasswordAuthentication no\n  KbdInteractiveAuthentication no\n`);
    const c = connections();
    await expect(c.connect(host("nokey", { extra: { configFile: cfg } }), { interactive: false })).rejects.toMatchObject({ kind: "auth" });
  });

  it("goes through the 2223 jump host with the hop hardened as a ProxyCommand", async () => {
    const c = connections();
    await c.uninstall(host("ember-jumped", { resolved: { user, hostname: "127.0.0.1", port: PORT, jump: ["127.0.0.1:2223"] } }));
  });

  it("leaves no master behind when the user's config says ControlMaster auto (critique remote-3)", async () => {
    const before = new Set(readdirSync(join(homedir(), ".ssh")).filter(f => f.startsWith("cm-")));
    const c = connections();
    await c.uninstall(host("ember-master"));
    await new Promise(r => setTimeout(r, 500));
    const after = readdirSync(join(homedir(), ".ssh")).filter(f => f.startsWith("cm-") && !before.has(f));
    expect(after).toEqual([]);
  });

  const built = existsSync(join(ROOT, "dist", "remote-parts", "remote-parts.json"));
  it.skipIf(!built)("connects, says hello and disconnects (needs the remote parts and the mux)", async () => {
    const c = connections({ hosts: [host("127.0.0.1")] });
    const link = await c.connect(host("127.0.0.1"), { interactive: false });
    expect(link.welcome.user).toBe(user);
    await c.disconnect("local-test");
    expect(link.state).toBe("closed");
  });
});

describe.skipIf(run)("SSH transport (skipped)", () => {
  it("is skipped without EMBER_SSH_TEST=1 on Linux", () => {
    expect(why).toBeTruthy();
  });
});
