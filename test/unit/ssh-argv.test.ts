import { describe, expect, it } from "vitest";
import { hopCommand, shQuote, sshArgv, sshCheckArgv, sshEnv, SshArgvError, sshGArgv, sshGHopArgv, type SshArgvOptions } from "../../app/main/remote/ssh-argv";
import { parseSshG } from "../../app/main/remote/ssh-config";

const V80 = { major: 8, minor: 0 };
const V95 = { major: 9, minor: 5 };
const base = (over: Partial<SshArgvOptions> = {}): SshArgvOptions => ({ ssh: "/usr/bin/ssh", os: "linux", version: V80, dest: "deploy@build-01", mode: "batch", ...over });

/** The -o values of an argv, in order. */
const opts = (argv: string[]) => argv.flatMap((a, i) => (argv[i - 1] === "-o" ? [a] : []));

/** OpenSSH's percent_expand for a ProxyCommand: %h, %p, %r, %n and %% (anything else is fatal there, so here too). */
function expand(s: string, v: { h: string; p: string }): string {
  return s.replace(/%(.)/g, (_m, c: string) => {
    if (c === "%") return "%";
    if (c === "h" || c === "n") return v.h;
    if (c === "p") return v.p;
    if (c === "r") return "deploy";
    throw new Error(`unknown %-token %${c}`);
  });
}

/** /bin/sh's word splitting for what Ember writes: bare words, '…' pieces and \' (shQuote's only escape). */
function shWords(s: string): string[] {
  const out: string[] = [];
  let cur: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === " ") { if (cur !== null) out.push(cur); cur = null; continue; }
    if (c === "\\" && s[i + 1] === "'") { cur = (cur ?? "") + "'"; i++; continue; }
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new Error("unterminated quote");
      cur = (cur ?? "") + s.slice(i + 1, end);
      i = end;
      continue;
    }
    if (/[\\"$`;&|<>(){}*?]/.test(c)) throw new Error(`unquoted shell character ${c}`);
    cur = (cur ?? "") + c;
  }
  if (cur !== null) out.push(cur);
  return out;
}

describe("Ember's connect argv (§5.1.4)", () => {
  it("is exactly the hardened list for a batch connect, with -- before the destination and sh -s after", () => {
    expect(sshArgv(base())).toEqual([
      "/usr/bin/ssh", "-T",
      "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "UpdateHostKeys=no",
      "-o", "ForwardAgent=no", "-o", "ForwardX11=no", "-o", "ForwardX11Trusted=no", "-o", "ClearAllForwardings=yes",
      "-o", "PermitLocalCommand=no", "-o", "RemoteCommand=none", "-o", "RequestTTY=no", "-o", "EscapeChar=none",
      "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "ConnectTimeout=15", "-o", "LogLevel=ERROR",
      "-o", "ControlMaster=no", "-o", "ControlPath=none",
      "--", "deploy@build-01", "sh", "-s",
    ]);
  });

  it("drops BatchMode for an interactive connect and asks for an unknown key only when told to", () => {
    const i = opts(sshArgv(base({ mode: "interactive" })));
    expect(i).not.toContain("BatchMode=yes");
    expect(i).toContain("StrictHostKeyChecking=yes");
    expect(opts(sshArgv(base({ mode: "interactive", acceptNewKey: true })))).toContain("StrictHostKeyChecking=ask");
    // A batch run never asks, whatever it is told.
    expect(opts(sshArgv(base({ acceptNewKey: true })))).toContain("StrictHostKeyChecking=yes");
  });

  it("never makes Ember's ssh a master: ControlMaster=no always, ControlPath=none unless riding a checked master (critique remote-3)", () => {
    // The user's config has ControlMaster auto and ControlPersist 10m: what -G says changes nothing in the argv.
    const cfg = parseSshG("user deploy\nhostname build-01\nport 22\ncontrolmaster auto\ncontrolpersist 600\ncontrolpath /home/ana/.ssh/cm-1");
    const plain = opts(sshArgv(base()));
    expect(plain).toEqual(expect.arrayContaining(["ControlMaster=no", "ControlPath=none"]));
    expect(plain.some(o => /^ControlPersist/i.test(o))).toBe(false);
    const riding = opts(sshArgv(base({ controlPath: cfg.controlPath })));
    expect(riding).toEqual(expect.arrayContaining(["ControlMaster=no", "ControlPath=/home/ana/.ssh/cm-1"]));
    expect(riding).not.toContain("ControlPath=none");
    expect(() => sshArgv(base({ controlPath: "/tmp/x\nProxyCommand=y" }))).toThrow(SshArgvError);
  });

  it("adds OpenSSH 8.7's session overrides only to clients that know them (critique remote-19)", () => {
    expect(opts(sshArgv(base({ version: V95 })))).toEqual(expect.arrayContaining(["SessionType=default", "StdinNull=no", "ForkAfterAuthentication=no"]));
    expect(opts(sshArgv(base({ version: { major: 8, minor: 6 } }))).some(o => o.startsWith("SessionType"))).toBe(false);
  });

  it("passes the port apart and carried -F, -i and allow-listed -o options, never the user's ProxyJump", () => {
    const argv = sshArgv(base({ port: 2222, extra: { configFile: "~/.ssh/work_config", identityFiles: ["~/.ssh/work_ed25519"], jump: ["bastion"], options: { HostKeyAlias: "build", ProxyJump: "bastion", IdentitiesOnly: "yes" } } }));
    expect(argv.slice(-8)).toEqual(["-o", "IdentitiesOnly=yes", "-p", "2222", "--", "deploy@build-01", "sh", "-s"]);
    expect(argv).toEqual(expect.arrayContaining(["-F", "~/.ssh/work_config", "-i", "~/.ssh/work_ed25519", "HostKeyAlias=build"]));
    expect(argv.join(" ")).not.toMatch(/ProxyJump=bastion|-J/);
  });

  it("refuses a value no validator passed (option injection, T19)", () => {
    expect(() => sshArgv(base({ dest: "-oProxyCommand=sh" }))).toThrow(SshArgvError);
    expect(() => sshArgv(base({ port: 0 }))).toThrow(SshArgvError);
    expect(() => sshArgv(base({ extra: { options: { ProxyCommand: "x" } } }))).toThrow(SshArgvError);
    expect(() => sshArgv(base({ extra: { identityFiles: ["-oX"] } }))).toThrow(SshArgvError);
    expect(() => sshArgv(base({ extra: { options: { HostName: "a b" } } }))).toThrow(SshArgvError);
  });

  it("puts the hardened ProxyCommand before ProxyJump=none (a ProxyJump first would void it in OpenSSH)", () => {
    const o = opts(sshArgv(base({ proxyCommand: "x" })));
    expect(o.indexOf("ProxyCommand=x")).toBeLessThan(o.indexOf("ProxyJump=none"));
    expect(o.indexOf("ProxyCommand=x")).toBeGreaterThan(-1);
  });

  it("runs through a WSL distro's own client when asked (L22)", () => {
    expect(sshArgv(base({ wsl: { exe: "C:\\Windows\\System32\\wsl.exe", distro: "Ubuntu" } })).slice(0, 6)).toEqual(["C:\\Windows\\System32\\wsl.exe", "-d", "Ubuntu", "--exec", "/usr/bin/ssh", "-T"]);
  });
});

describe("ssh -G, -O check", () => {
  it("resolves with the carried options, the jump as one ProxyJump", () => {
    expect(sshGArgv({ ssh: "/usr/bin/ssh", dest: "build-01", port: 2200, extra: { jump: ["a", "b"], identityFiles: ["~/.ssh/k"] } }))
      .toEqual(["/usr/bin/ssh", "-G", "-i", "~/.ssh/k", "-o", "ProxyJump=a,b", "-p", "2200", "--", "build-01"]);
    expect(sshGHopArgv({ ssh: "/usr/bin/ssh", hop: { user: "deploy", host: "bastion", port: 2200 }, configFile: "~/.ssh/cfg" }))
      .toEqual(["/usr/bin/ssh", "-G", "-F", "~/.ssh/cfg", "-p", "2200", "--", "deploy@bastion"]);
  });

  it("checks the user's master without ever starting one", () => {
    expect(sshCheckArgv({ ssh: "/usr/bin/ssh", controlPath: "/home/ana/.ssh/cm-1", dest: "build-01" }))
      .toEqual(["/usr/bin/ssh", "-O", "check", "-o", "BatchMode=yes", "-o", "ControlPath=/home/ana/.ssh/cm-1", "--", "build-01"]);
  });
});

describe("the hardened ProxyJump chain (§5.1.3, critique remote-4)", () => {
  it("gives one hop Ember's own refusals and -W [%h]:%p", () => {
    const cmd = hopCommand({ ssh: "/usr/bin/ssh", os: "linux", hops: [{ user: "deploy", host: "bastion", port: 2200 }], mode: "batch" });
    expect(cmd).toBe("'/usr/bin/ssh' -T -o BatchMode=yes -o StrictHostKeyChecking=yes -o UpdateHostKeys=no -o ControlMaster=no -o ControlPath=none -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes -o PermitLocalCommand=no -o LogLevel=ERROR -p 2200 -W '[%h]:%p' -- deploy@bastion");
    // What the target's ssh runs after its own %-expansion: the hop dials the target.
    const words = shWords(expand(cmd, { h: "build-01.example.com", p: "22" }));
    expect(words.slice(-4)).toEqual(["-W", "[build-01.example.com]:22", "--", "deploy@bastion"]);
    expect(hopCommand({ ssh: "/usr/bin/ssh", os: "linux", hops: [{ host: "bastion" }], mode: "interactive" })).toContain("BatchMode=no");
  });

  it("nests a two-hop chain with every % of the inner level doubled, so each ssh expands only its own level", () => {
    const hops = [{ host: "outer", port: 2201 }, { user: "deploy", host: "inner" }];
    const cmd = hopCommand({ ssh: "/usr/bin/ssh", os: "linux", hops, mode: "batch", configFile: "~/.ssh/my%config" });
    // Level 1: the target's ssh expands and /bin/sh splits; the hop to "inner" dials the target.
    const l1 = shWords(expand(cmd, { h: "build-01", p: "22" }));
    expect(l1.slice(-4)).toEqual(["-W", "[build-01]:22", "--", "deploy@inner"]);
    expect(l1).toContain("~/.ssh/my%config");
    const nested = l1[l1.indexOf("-W") - 1];
    expect(nested.startsWith("ProxyCommand=")).toBe(true);
    // Level 2: inner's ssh expands its ProxyCommand: the hop to "outer" dials "inner".
    const l2 = shWords(expand(nested.slice("ProxyCommand=".length), { h: "inner", p: "22" }));
    expect(l2.slice(-6)).toEqual(["-p", "2201", "-W", "[inner]:22", "--", "outer"]);
    expect(l2).toContain("~/.ssh/my%config");
    expect(l2).toEqual(expect.arrayContaining(["StrictHostKeyChecking=yes", "ControlPath=none", "BatchMode=yes"]));
  });

  it("chains at most three hops, one on Windows, and quotes the Windows client for CreateProcess", () => {
    const h = { host: "j" };
    expect(() => hopCommand({ ssh: "/usr/bin/ssh", os: "linux", hops: [h, h, h, h], mode: "batch" })).toThrow(SshArgvError);
    expect(() => hopCommand({ ssh: "/usr/bin/ssh", os: "linux", hops: [], mode: "batch" })).toThrow(SshArgvError);
    expect(() => hopCommand({ ssh: "C:\\Windows\\System32\\OpenSSH\\ssh.exe", os: "win32", hops: [h, h], mode: "batch" })).toThrow(SshArgvError);
    const win = hopCommand({ ssh: "C:\\Windows\\System32\\OpenSSH\\ssh.exe", os: "win32", hops: [{ host: "bastion" }], mode: "batch" });
    expect(win.startsWith("\"C:\\Windows\\System32\\OpenSSH\\ssh.exe\" -T ")).toBe(true);
    expect(win.endsWith(" -W [%h]:%p -- bastion")).toBe(true);
    expect(win).not.toContain("'");
  });

  it("refuses a hop the validator refuses", () => {
    expect(() => hopCommand({ ssh: "/usr/bin/ssh", os: "linux", hops: [{ host: "a%h" }], mode: "batch" })).toThrow(SshArgvError);
    expect(() => hopCommand({ ssh: "/usr/bin/ssh", os: "linux", hops: [{ host: "-oX" }], mode: "batch" })).toThrow(SshArgvError);
  });

  it("quotes words for /bin/sh", () => {
    expect(shQuote("it's")).toBe("'it'\\''s'");
  });
});

describe("the ssh child's environment (§5.1.4)", () => {
  const env = {
    HOME: "/home/ana", PATH: "/usr/bin", SSH_AUTH_SOCK: "/run/user/1000/ssh-agent", DISPLAY: ":1", SSH_ASKPASS: "/usr/libexec/openssh/gnome-ssh-askpass",
    GH_TOKEN: "ghp_x", GITHUB_TOKEN: "ghp_y", COPILOT_GITHUB_TOKEN: "ghu_z", EMBER_USER_DATA: "/tmp/e", ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--require x",
    SSH_ASKPASS_REQUIRE: "prefer", KRB5CCNAME: "FILE:/tmp/krb5cc",
  };

  it("keeps the user's agent and drops Ember's, Electron's, Node's and every GitHub sign-in variable", () => {
    const e = sshEnv(env, { os: "linux", mode: "batch" });
    expect(e).toMatchObject({ HOME: "/home/ana", PATH: "/usr/bin", SSH_AUTH_SOCK: "/run/user/1000/ssh-agent", KRB5CCNAME: "FILE:/tmp/krb5cc" });
    for (const k of ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN", "EMBER_USER_DATA", "ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"]) expect(e).not.toHaveProperty(k);
  });

  it("lets no prompt pop up in a batch run: no SSH_ASKPASS, no DISPLAY, SSH_ASKPASS_REQUIRE=never", () => {
    const e = sshEnv(env, { os: "linux", mode: "batch" });
    expect(e).not.toHaveProperty("SSH_ASKPASS");
    expect(e).not.toHaveProperty("DISPLAY");
    expect(e.SSH_ASKPASS_REQUIRE).toBe("never");
  });

  it("points an interactive run at Ember's helper, with a DISPLAY for clients older than 8.4", () => {
    const e = sshEnv(env, { os: "linux", mode: "interactive", askpass: { kind: "socket", program: "/home/ana/.config/ember/ssh/askpass", sock: "/run/user/1000/ea-x/a.sock", nonce: "ab".repeat(16) } });
    expect(e).toMatchObject({ SSH_ASKPASS: "/home/ana/.config/ember/ssh/askpass", SSH_ASKPASS_REQUIRE: "force", DISPLAY: ":1", EMBER_ASKPASS_SOCK: "/run/user/1000/ea-x/a.sock", EMBER_ASKPASS_NONCE: "ab".repeat(16) });
    expect(sshEnv({ HOME: "/Users/ana" }, { os: "darwin", mode: "interactive", askpass: { kind: "socket", program: "p", sock: "s", nonce: "n" } }).DISPLAY).toBe("ember:0");
  });

  it("compares Windows names without regard to case and hands the pipe to the compiled helper", () => {
    const e = sshEnv({ Path: "C:\\Windows", gh_token: "x", Ember_Debug: "1", display: "x" }, { os: "win32", mode: "interactive", askpass: { kind: "pipe", program: "C:\\u\\ember-askpass.exe", pipe: "\\\\.\\pipe\\ember-askpass-1", nonce: "n" } });
    expect(e).toEqual({ Path: "C:\\Windows", SSH_ASKPASS: "C:\\u\\ember-askpass.exe", SSH_ASKPASS_REQUIRE: "force", EMBER_ASKPASS_NONCE: "n", EMBER_ASKPASS_PIPE: "\\\\.\\pipe\\ember-askpass-1" });
  });
});
