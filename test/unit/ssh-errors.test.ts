import { describe, expect, it } from "vitest";
import { bootstrapFailure, classifySshFailure, cleanLine, isLanAddress } from "../../app/main/remote/ssh-errors";

const at = (stderr: string, exit: number | null = 255, over: Partial<Parameters<typeof classifySshFailure>[2]> = {}) =>
  classifySshFailure(stderr, exit, { probeBegan: false, os: "linux", host: "build-01", ...over });

describe("ssh's failures in Ember's words (§5.1.8, §8.7)", () => {
  it("tells an unknown host key from a changed one", () => {
    expect(at("No ED25519 host key is known for build-01 and you have requested strict checking.\r\nHost key verification failed.\r\n"))
      .toMatchObject({ kind: "unknown-host-key", message: "Connect once with `ssh build-01` in a terminal, check its key, then try again." });
    const changed = at("@@@@@@@@\r\n@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @\r\n…\r\nHost key verification failed.\r\n");
    expect(changed).toMatchObject({ kind: "host-key-changed", retry: false });
    expect(changed.fix).toContain("ssh-keygen -R build-01");
  });

  it("classifies authentication, too many keys and DNS", () => {
    expect(at("deploy@build-01: Permission denied (publickey,gssapi-keyex,gssapi-with-mic).")).toMatchObject({ kind: "auth", message: "build-01 didn't accept your key. Add it to the ssh-agent (`ssh-add`), then connect again." });
    expect(at("Received disconnect from 10.0.0.5 port 22:2: Too many authentication failures")).toMatchObject({ kind: "too-many-keys" });
    expect(at("ssh: Could not resolve hostname build-01: Name or service not known")).toMatchObject({ kind: "dns", message: "Ember can't find build-01. Check the name, or add it to your SSH config." });
  });

  it("names a network failure in a few words", () => {
    for (const [line, words] of [
      ["ssh: connect to host build-01 port 22: Connection refused", "the connection was refused"],
      ["ssh: connect to host build-01 port 22: No route to host", "no route to it"],
      ["ssh: connect to host build-01 port 22: Connection timed out", "the connection timed out"],
      ["ssh: connect to host build-01 port 22: Network is unreachable", "the network is unreachable"],
      ["kex_exchange_identification: read: Connection reset by peer", "it closed the connection"],
      ["Connection closed by 10.0.0.5 port 22", "it closed the connection"],
      ["Connection reset by 10.0.0.5 port 22", "the connection was reset"],
    ]) {
      expect(at(line)).toMatchObject({ kind: "network", message: `Ember can't reach build-01 (${words}). Check you're on the right network or VPN.`, retry: true });
    }
  });

  it("adds the Local Network hint only on macOS 15 or newer, for a LAN address that has no route (critique remote-29)", () => {
    const line = "ssh: connect to host 192.168.1.20 port 22: No route to host";
    expect(at(line, 255, { os: "darwin", darwinMajor: 24, lan: true }).fix).toBe("If build-01 is on your local network, allow Ember in System Settings › Privacy & Security › Local Network.");
    expect(at(line, 255, { os: "darwin", darwinMajor: 23, lan: true }).fix).toBeUndefined();
    expect(at(line, 255, { os: "darwin", darwinMajor: 24, lan: false }).fix).toBeUndefined();
    expect(at(line, 255, { os: "linux", lan: true }).fix).toBeUndefined();
  });

  it("quotes the offending configuration line, cleaned (critique remote-18c)", () => {
    const f = at("/home/ana/.ssh/config: line 7: Bad configuration option: usekeychain\n/home/ana/.ssh/config: terminating, 1 bad configuration options\n");
    expect(f).toMatchObject({ kind: "config", message: "Your SSH settings for build-01 have a line this SSH can't use: /home/ana/.ssh/config: line 7: Bad configuration option: usekeychain. Fix or remove it, then connect again." });
    expect(at("getsockname failed: Not a socket").kind).toBe("config");
    expect(at("command-line line 0: Unsupported option \"sessiontype\"").kind).toBe("config");
    expect(at("x: line 1: Bad configuration option: \u001b[31mevil\u202e").message).not.toMatch(/[\u001b\u202e]/); // eslint-disable-line no-control-regex -- the escape must be gone
  });

  it("says no-setup when the login never ran Ember's set-up (localised cmd, ForceCommand, nologin; critique remote-18)", () => {
    expect(at("'sh' is not recognized as an internal or external command", 1)).toMatchObject({ kind: "no-setup", message: "build-01 didn't run Ember's set-up (it may be Windows, or this login runs a fixed program)." });
    expect(at("Der Befehl \"sh\" ist entweder falsch geschrieben oder konnte nicht gefunden werden.", 1).kind).toBe("no-setup");
    expect(at("This account is currently not available.", 1).kind).toBe("no-setup");
    expect(at("", 0).kind).toBe("no-setup");
  });

  it("reports a failure after the probe began as the remote's own", () => {
    expect(at("", 3, { probeBegan: true }).kind).toBe("remote");
    expect(at("", null).kind).toBe("unknown");
    expect(at("something else entirely").kind).toBe("unknown");
  });
});

describe("the bootstrap's own errors", () => {
  it("maps each code to §8.7's message", () => {
    expect(bootstrapFailure("busy-install", undefined, "build-01")).toMatchObject({ kind: "busy-install", retry: true, message: "Another Ember is installing its helper on build-01. Try again in a minute." });
    expect(bootstrapFailure("exec-denied", undefined, "build-01").message).toContain("fapolicyd trust");
    expect(bootstrapFailure("integrity", "runtime", "build-01").message).toBe("Ember's helper didn't arrive intact on build-01 (runtime). Try again.");
    expect(bootstrapFailure("space", undefined, "build-01").kind).toBe("disk");
    expect(bootstrapFailure("busy", undefined, "build-01").message).toBe("Ember from another computer is already working on build-01.");
    expect(bootstrapFailure("<script>", "x y", "build-01").message).toBe("Ember's set-up on build-01 stopped (unknown).");
  });
});

describe("helpers", () => {
  it("cuts and cleans remote lines", () => {
    expect(cleanLine("a\u0000b\tc\u202ed", 200)).toBe("a b c d");
    expect(cleanLine("x".repeat(300), 10)).toBe("xxxxxxxxx…");
  });

  it("knows LAN addresses", () => {
    for (const a of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.0.1", "169.254.1.1", "fe80::1", "fd00::1"]) expect(isLanAddress(a)).toBe(true);
    for (const a of ["172.32.0.1", "8.8.8.8", "build-01", "2001:db8::1"]) expect(isLanAddress(a)).toBe(false);
  });
});
