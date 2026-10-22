import { describe, expect, it } from "vitest";
import { askpassWorks, knownHostsDiscarded, minimumVersion, parseSshG, parseSshVersion, sshClientPath, sshClientRow, SshConfigError, unfixableSessionOption, versionAtLeast } from "../../app/main/remote/ssh-config";

/** `ssh -G` as OpenSSH 8.0 prints it (dump_client_config's order), trimmed to the keys around the ones Ember reads. */
const G80 = [
  "user deploy",
  "hostname build-01.example.com",
  "port 22",
  "addressfamily any",
  "batchmode no",
  "controlmaster auto",
  "forwardagent no",
  "stricthostkeychecking ask",
  "connectionattempts 1",
  "controlpath /home/ana/.ssh/cm-8f1e2d",
  "identityfile ~/.ssh/id_rsa",
  "identityfile ~/.ssh/id_ed25519",
  "globalknownhostsfile /etc/ssh/ssh_known_hosts /etc/ssh/ssh_known_hosts2",
  "userknownhostsfile ~/.ssh/known_hosts ~/.ssh/known_hosts2",
  "connecttimeout none",
  "controlpersist 600",
  "escapechar ~",
].join("\n");

describe("ssh -G's answer (§5.1.3)", () => {
  it("reads user, host name, port, control master and known-hosts files", () => {
    const c = parseSshG(G80);
    expect(c).toMatchObject({
      user: "deploy", hostname: "build-01.example.com", port: 22, proxyJump: null, proxyCommand: false,
      controlPath: "/home/ana/.ssh/cm-8f1e2d", controlMaster: "auto", controlPersist: "600",
      userKnownHostsFile: ["~/.ssh/known_hosts", "~/.ssh/known_hosts2"], identityFile: ["~/.ssh/id_rsa", "~/.ssh/id_ed25519"],
      sessionType: null,
    });
    expect(knownHostsDiscarded(c)).toBe(false);
  });

  it("reads proxyjump hops in connection order, numeric hosts bracketed as OpenSSH prints them", () => {
    const c = parseSshG(`${G80}\nproxyjump deploy@bastion:2200,[10.0.0.5]:2223`);
    expect(c.proxyJump).toEqual([{ user: "deploy", host: "bastion", port: 2200 }, { host: "10.0.0.5", port: 2223 }]);
    expect(c.proxyJumpText).toBe("deploy@bastion:2200,[10.0.0.5]:2223");
    expect(parseSshG(`${G80}\nproxyjump none`).proxyJump).toBeNull();
  });

  it("notes a user ProxyCommand (an SSO helper) without reading it", () => {
    expect(parseSshG(`${G80}\nproxycommand cloudflared access ssh --hostname %h`).proxyCommand).toBe(true);
    expect(parseSshG(`${G80}\nproxycommand none`).proxyCommand).toBe(false);
  });

  it("treats ControlPath none as no master", () => {
    expect(parseSshG(G80.replace(/controlpath .*/, "controlpath none")).controlPath).toBeNull();
  });

  it("refuses settings that throw host keys away, Windows' NUL in any case included (critique remote-19)", () => {
    for (const f of ["/dev/null", "none", "NUL", "nul", "Nul"]) {
      expect(knownHostsDiscarded(parseSshG(G80.replace(/userknownhostsfile .*/, `userknownhostsfile ${f}`)))).toBe(true);
    }
    expect(knownHostsDiscarded(parseSshG(G80.replace(/userknownhostsfile .*/, "userknownhostsfile ~/.ssh/known_hosts /dev/null")))).toBe(true);
  });

  it("throws on output without a user, host name or port, or with a hop it can't harden", () => {
    expect(() => parseSshG("hostname x\nport 22")).toThrow(SshConfigError);
    expect(() => parseSshG("user a\nhostname x\nport 0")).toThrow(SshConfigError);
    expect(() => parseSshG(`${G80}\nproxyjump ssh://bastion`)).toThrow(SshConfigError);
    expect(() => parseSshG(`${G80}\nproxyjump bas%tion`)).toThrow(SshConfigError);
  });

  it("reads OpenSSH 8.7's session keys and flags one an old client printed but can't take", () => {
    const c = parseSshG(`${G80}\nsessiontype none\nstdinnull yes\nforkafterauthentication no`);
    expect(c.sessionType).toBe("none");
    expect(unfixableSessionOption(c, { major: 9, minor: 6, windows: false, text: "" })).toBeNull();
    expect(unfixableSessionOption(c, { major: 8, minor: 6, windows: false, text: "" })).toBe("SessionType");
    expect(unfixableSessionOption(parseSshG(G80), { major: 8, minor: 0, windows: false, text: "" })).toBeNull();
  });
});

describe("the client and its version (§5.1.1)", () => {
  it("parses ssh -V on Linux, macOS and Windows", () => {
    expect(parseSshVersion("OpenSSH_8.0p1, OpenSSL 1.1.1k  FIPS 25 Mar 2021\n")).toMatchObject({ major: 8, minor: 0, windows: false });
    expect(parseSshVersion("OpenSSH_9.8p1, LibreSSL 3.3.6")).toMatchObject({ major: 9, minor: 8, windows: false });
    expect(parseSshVersion("OpenSSH_for_Windows_8.1p1, LibreSSL 3.0.2")).toMatchObject({ major: 8, minor: 1, windows: true });
    expect(parseSshVersion("Dropbear v2022.83")).toBeNull();
  });

  it("needs 7.6, and 8.1 on Windows; askpass on Windows from 8.4 only (L15)", () => {
    expect(minimumVersion("linux")).toEqual({ major: 7, minor: 6 });
    expect(minimumVersion("win32")).toEqual({ major: 8, minor: 1 });
    expect(versionAtLeast({ major: 7, minor: 5 }, 7, 6)).toBe(false);
    expect(versionAtLeast({ major: 8, minor: 0 }, 7, 6)).toBe(true);
    const v = (major: number, minor: number) => ({ major, minor, windows: true, text: "" });
    expect(askpassWorks("win32", v(8, 1))).toBe(false);
    expect(askpassWorks("win32", v(8, 6))).toBe(true);
    expect(askpassWorks("linux", v(8, 0))).toBe(true);
  });

  it("runs the system's client by absolute path, never ssh from PATH", () => {
    expect(sshClientPath("linux")).toBe("/usr/bin/ssh");
    expect(sshClientPath("darwin")).toBe("/usr/bin/ssh");
    expect(sshClientPath("win32", "C:\\WINDOWS")).toBe("C:\\WINDOWS\\System32\\OpenSSH\\ssh.exe");
    expect(sshClientPath("win32")).toBe("C:\\Windows\\System32\\OpenSSH\\ssh.exe");
    expect(sshClientPath("win32", "relative\\dir")).toBe("C:\\Windows\\System32\\OpenSSH\\ssh.exe");
  });
});

describe("the doctor's SSH client row (§8.8)", () => {
  const v = (major: number, minor: number) => ({ major, minor, windows: false, text: "" });
  it("names the client and version, or says what's wrong", () => {
    expect(sshClientRow("linux", "/usr/bin/ssh", v(8, 0))).toEqual({ id: "ssh-client", status: "ok", label: "SSH client", detail: "OpenSSH 8.0 at /usr/bin/ssh" });
    expect(sshClientRow("win32", "C:\\Windows\\System32\\OpenSSH\\ssh.exe", v(9, 5))).toMatchObject({ status: "ok", detail: "OpenSSH 9.5 (passwords through Ember's prompt)" });
    expect(sshClientRow("win32", "x", v(8, 1))).toMatchObject({ status: "warn", detail: "Passwords can't be asked here: keys and the ssh-agent only" });
    expect(sshClientRow("win32", "x", v(9, 5), { askpass: false })).toMatchObject({ status: "warn" });
    expect(sshClientRow("win32", "x", v(7, 7))).toMatchObject({ status: "fail", detail: "OpenSSH is too old for Ember" });
    expect(sshClientRow("linux", "/usr/bin/ssh", null)).toMatchObject({ status: "fail", detail: "No SSH client found" });
  });
});
