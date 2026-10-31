import { describe, expect, it } from "vitest";
import { hopDest, hostIdFor, hostLabel, optionKey, parseHop, parseTypedDestination, validDest, validExtra, validHop, validSshFile } from "../../app/main/remote/destination";
import { HOST_ID } from "../../app/shared/targets";

describe("the destination validator (§5.1.2)", () => {
  it("accepts aliases, user@host, addresses and bracketed IPv6", () => {
    for (const s of ["build-01", "deploy@build-01.example.com", "10.0.0.5", "fe80::1%eth0", "deploy@[::1]", "a_b+c@host"]) {
      expect(validDest(s)).toBe(true);
    }
  });

  it("refuses anything ssh could read as an option or that hides words (T19)", () => {
    for (const s of ["-oProxyCommand=sh", "-J", "host name", "host\tname", "host\nname", "host;rm", "host`x`", "$(id)", "a'b", "a\"b", "", "x".repeat(256), "host\u202e", "hóst"]) {
      expect(validDest(s)).toBe(false);
    }
  });

  it("holds jump hops to the stricter rule: no % (expanded inside a ProxyCommand) and no brackets", () => {
    expect(validHop("deploy@bastion")).toBe(true);
    expect(validHop("bastion:2200")).toBe(true);
    expect(validHop("bastion%h")).toBe(false);
    expect(validHop("[10.0.0.5]")).toBe(false);
    expect(validHop("-oProxyCommand=x")).toBe(false);
    expect(validHop("ssh://bastion")).toBe(false);
  });

  it("accepts carried files only when absolute or ~/-relative, with no control characters", () => {
    expect(validSshFile("~/.ssh/work_ed25519")).toBe(true);
    expect(validSshFile("/etc/ssh/ssh_config")).toBe(true);
    expect(validSshFile("C:\\Users\\ana\\.ssh\\id")).toBe(true);
    expect(validSshFile("id_rsa")).toBe(false);
    expect(validSshFile("-oX")).toBe(false);
    expect(validSshFile("~/.ssh/id\nProxyCommand x")).toBe(false);
  });

  it("checks every carried option against its allow-list", () => {
    expect(validExtra({ jump: ["bastion"], identityFiles: ["~/.ssh/a"], configFile: "~/.ssh/cfg", options: { HostKeyAlias: "build", IdentitiesOnly: "yes" } })).toBe(true);
    expect(validExtra({ options: { ProxyCommand: "sh -c x" } })).toBe(false);
    expect(validExtra({ options: { hostname: "x" } })).toBe(false);
    expect(validExtra({ options: { HostName: "a b" } })).toBe(false);
    expect(validExtra({ options: { ProxyJump: "a,b%h" } })).toBe(false);
    expect(validExtra({ jump: ["-oX"] })).toBe(false);
    expect(optionKey("hostname")).toBe("HostName");
    expect(optionKey("LocalForward")).toBeNull();
  });
});

describe("what the user typed in settings", () => {
  it("takes the port apart from user@host:port, [v6]:port and ssh:// URIs", () => {
    expect(parseTypedDestination("build-01")).toEqual({ dest: "build-01" });
    expect(parseTypedDestination(" deploy@build-01:2222 ")).toEqual({ dest: "deploy@build-01", port: 2222 });
    expect(parseTypedDestination("ssh://deploy@build-01:2200")).toEqual({ dest: "deploy@build-01", port: 2200 });
    expect(parseTypedDestination("ssh://build-01/")).toEqual({ dest: "build-01" });
    expect(parseTypedDestination("[fe80::1]:22")).toEqual({ dest: "fe80::1", port: 22 });
    expect(parseTypedDestination("deploy@fe80::1")).toEqual({ dest: "deploy@fe80::1" });
  });

  it("refuses ambiguous or unsafe input", () => {
    for (const s of ["", "build-01:", "build-01:x", "host:70000", "-oProxyCommand=x", "a b", "ssh://h:1:2", "us er@host", "user;x@host"]) {
      expect(parseTypedDestination(s)).toBeNull();
    }
  });
});

describe("host ids and labels", () => {
  it("makes HOST_ID from the label, unique with -2, -3", () => {
    expect(hostLabel("deploy@Build-01")).toBe("Build-01");
    expect(hostIdFor("deploy@Build_01.Example.com", [])).toBe("build_01.example.com");
    expect(hostIdFor("build-01", ["build-01"])).toBe("build-01-2");
    expect(hostIdFor("build-01", ["build-01", "build-01-2"])).toBe("build-01-3");
    expect(hostIdFor("fe80::1", [])).toBe("fe80--1");
    expect(hostIdFor("--x", [])).toBe("x");
    expect(hostIdFor("::", [])).toBe("host");
    for (const id of [hostIdFor("a".repeat(200), []), hostIdFor("[::1]", [])]) expect(HOST_ID.test(id)).toBe(true);
  });
});

describe("jump hops as ssh -G prints them", () => {
  it("takes user, host and port apart, numeric hosts in brackets included", () => {
    expect(parseHop("deploy@bastion:2200")).toEqual({ user: "deploy", host: "bastion", port: 2200 });
    expect(parseHop("[127.0.0.1]:2223")).toEqual({ host: "127.0.0.1", port: 2223 });
    expect(parseHop("[fe80::1]")).toEqual({ host: "fe80::1" });
    expect(parseHop("bastion")).toEqual({ host: "bastion" });
    expect(hopDest({ user: "deploy", host: "bastion", port: 22 })).toBe("deploy@bastion");
  });

  it("refuses a hop Ember can't harden", () => {
    for (const s of ["ssh://bastion", "bas tion", "bastion%h", "-oX", "a@b@c", "host:99999", "[x y]"]) expect(parseHop(s)).toBeNull();
  });
});
