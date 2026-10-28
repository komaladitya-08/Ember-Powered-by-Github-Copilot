/**
 * The registry of targets (§2.2, targets/registry.ts): this computer always; WSL distros only on Windows, allowed by the
 * administrator and turned on by the user, with Docker's and Rancher's hidden, Podman's commands only and a distro still
 * to be set up never usable; SSH hosts per record with their link's state; and the picker's choice falling back to this
 * computer when it names nothing usable.
 */

import { describe, expect, it } from "vitest";
import { AdminPolicySchema, type LoadedAdminPolicy } from "../../app/main/admin";
import { SettingsSchema, type Settings } from "../../app/main/settings";
import type { HostRecord } from "../../app/main/remote/types";
import type { WslDistro, WslFacts } from "../../app/main/wsl/types";
import type { TargetId } from "../../app/shared/targets";
import {
  activeOf, bindable, buildRegistry, defaultDistro, hostPart, namedTargets, summaryOf, type LinkView, type RegistryInput,
} from "../../app/main/targets/registry";
import { bindTarget } from "../../app/main/targets/resolve";

const noPolicy: LoadedAdminPolicy = { policy: AdminPolicySchema.parse({}), source: null };
const policy = (p: unknown): LoadedAdminPolicy => ({ policy: AdminPolicySchema.parse(p), source: "/etc/ember/policy.json" });
const broken: LoadedAdminPolicy = { policy: AdminPolicySchema.parse({ features: { wsl: false, ssh: false } }), source: "/etc/ember/policy.json", error: "bad" };

const host = (id: string, more: Partial<HostRecord> = {}): HostRecord => ({
  id, dest: `deploy@${id}.example.com`, resolved: { user: "deploy", hostname: `${id}.example.com`, port: 22, jump: [] },
  consent: { version: 1, at: "2026-10-22T10:00:00.000Z" }, ...more,
});
const distro = (name: string, more: Partial<WslDistro> = {}): WslDistro => ({ name, version: 2, isDefault: false, defaultUid: 1000, running: true, needsSetup: false, ...more });
const facts = (distros: WslDistro[]): WslFacts => ({ installed: true, wslExe: "C:\\Program Files\\WSL\\wsl.exe", distros, wslg: { available: true, disabledByUser: false, version: "1.0" }, wslVersion: "2.3.26.0" });

const settingsWith = (o: { wslOn?: boolean; hosts?: HostRecord[]; active?: TargetId } = {}): Settings => SettingsSchema.parse({
  targets: {
    active: o.active ?? "local", offerSsh: true, dismissedOffers: [], hosts: o.hosts ?? [], pcId: "",
    wsl: { on: o.wslOn ?? false, consent: o.wslOn ? { version: 1, at: "2026-10-22T10:00:00.000Z" } : { version: 0, at: null } },
  },
});

const input = (o: Partial<RegistryInput> = {}): RegistryInput => ({
  os: "linux", admin: noPolicy, settings: settingsWith(), localDesktop: true, commands: () => "off", wsl: null, links: new Map(), ...o,
});

describe("this computer", () => {
  it("is always there, ready, and says what Ember can do on it", () => {
    const [local] = buildRegistry(input());
    expect(local).toMatchObject({ id: "local", kind: "local", label: "This computer", state: "ready", can: "apps", usable: true, listedOnly: false });
    expect(buildRegistry(input({ commands: () => "on" }))[0].can).toBe("apps and commands");
  });

  it("without a window system is commands only, and unusable while commands are off", () => {
    const off = buildRegistry(input({ localDesktop: false }))[0];
    expect(off).toMatchObject({ usable: false, can: "nothing yet" });
    expect(off.why).toMatch(/commands are off/);
    expect(buildRegistry(input({ localDesktop: false, commands: () => "on" }))[0]).toMatchObject({ usable: true, can: "commands only" });
  });

  it("is the only target when nothing is set up (Linux, or Windows without WSL facts)", () => {
    expect(buildRegistry(input()).map(e => e.id)).toEqual(["local"]);
    expect(buildRegistry(input({ os: "win32" })).map(e => e.id)).toEqual(["local"]);
  });
});

describe("WSL distros (§2.2)", () => {
  const all = facts([
    distro("Ubuntu", { isDefault: true }), distro("Debian", { running: false }), distro("docker-desktop"), distro("docker-desktop-data"),
    distro("rancher-desktop"), distro("podman-machine-default", { tool: "podman" }), distro("Fresh", { needsSetup: true }),
    distro("Old", { version: 1 }), distro("bad name"),
  ]);

  it("lists only on Windows, with WSL allowed, installed and turned on", () => {
    expect(buildRegistry(input({ wsl: all })).some(e => e.kind === "wsl")).toBe(false);
    expect(buildRegistry(input({ os: "win32", admin: policy({ features: { wsl: false } }), wsl: all, settings: settingsWith({ wslOn: true }) })).some(e => e.kind === "wsl")).toBe(false);
    expect(buildRegistry(input({ os: "win32", admin: broken, wsl: all, settings: settingsWith({ wslOn: true }) })).some(e => e.kind === "wsl")).toBe(false);
  });

  it("hides Docker's and Rancher's distros and names that WSL wouldn't allow", () => {
    const ids = buildRegistry(input({ os: "win32", wsl: all, settings: settingsWith({ wslOn: true }) })).map(e => e.id);
    expect(ids).toEqual(["local", "wsl:Ubuntu", "wsl:Debian", "wsl:podman-machine-default", "wsl:Fresh", "wsl:Old"]);
  });

  it("shows a running distro as ready and a stopped one as off (both usable: a command starts it)", () => {
    const e = buildRegistry(input({ os: "win32", wsl: all, settings: settingsWith({ wslOn: true }), commands: () => "on" }));
    expect(e.find(x => x.id === "wsl:Ubuntu")).toMatchObject({ state: "ready", label: "Ubuntu (WSL)", can: "Linux apps and commands", usable: true });
    expect(e.find(x => x.id === "wsl:Debian")).toMatchObject({ state: "off", usable: true });
  });

  it("never offers a distro still waiting for its first-run set-up", () => {
    const e = buildRegistry(input({ os: "win32", wsl: all, settings: settingsWith({ wslOn: true }), commands: () => "on" })).find(x => x.id === "wsl:Fresh")!;
    expect(e).toMatchObject({ state: "unavailable", usable: false, listedOnly: true });
    expect(e.why).toBe("Set up Fresh first: open it from the Start menu once.");
  });

  it("makes WSL 1 and Podman's distro commands only", () => {
    const off = buildRegistry(input({ os: "win32", wsl: all, settings: settingsWith({ wslOn: true }) }));
    expect(off.find(x => x.id === "wsl:Old")).toMatchObject({ usable: false });
    expect(off.find(x => x.id === "wsl:podman-machine-default")).toMatchObject({ usable: false });
    const on = buildRegistry(input({ os: "win32", wsl: all, settings: settingsWith({ wslOn: true }), commands: () => "on" }));
    expect(on.find(x => x.id === "wsl:Old")).toMatchObject({ can: "WSL 1: commands only", usable: true });
    expect(on.find(x => x.id === "wsl:podman-machine-default")).toMatchObject({ can: "commands only", usable: true });
  });

  it("lists the distros for settings only while WSL is off in Ember (or its card is out of date)", () => {
    const e = buildRegistry(input({ os: "win32", wsl: all })).filter(x => x.kind === "wsl");
    expect(e.length).toBeGreaterThan(0);
    expect(e.every(x => x.listedOnly && !x.usable && x.state === "unavailable")).toBe(true);
    expect(bindable(buildRegistry(input({ os: "win32", wsl: all }))).map(x => x.id)).toEqual(["local"]);
  });

  it("names the default distro with WSL's words, or the first visible one when the default is hidden", () => {
    const named = namedTargets(buildRegistry(input({ os: "win32", wsl: all, settings: settingsWith({ wslOn: true }) })));
    expect(named.find(n => n.id === "wsl:Ubuntu")!.names).toEqual(expect.arrayContaining(["WSL", "Linux"]));
    expect(named.find(n => n.id === "wsl:Debian")!.names).not.toContain("WSL");
    expect(defaultDistro(facts([distro("docker-desktop", { isDefault: true }), distro("Debian")]))?.name).toBe("Debian");
    expect(defaultDistro(facts([distro("Fresh", { isDefault: true, needsSetup: true })]))).toBeNull();
  });
});

describe("SSH hosts (§2.2)", () => {
  const view = (state: LinkView["state"], more: Partial<LinkView> = {}): LinkView => ({ state, ...more });
  const withHosts = (links: [string, LinkView][], o: Partial<RegistryInput> = {}) =>
    buildRegistry(input({ settings: settingsWith({ hosts: [host("build-01"), host("db-02")] }), links: new Map(links), ...o }));

  it("lists every host record while the administrator allows SSH", () => {
    expect(withHosts([]).map(e => e.id)).toEqual(["local", "ssh:build-01", "ssh:db-02"]);
    expect(withHosts([], { admin: policy({ features: { ssh: false } }) }).map(e => e.id)).toEqual(["local"]);
  });

  it("follows the link: off, connecting, ready (stalled shows as ready with a warning), lost", () => {
    const e = withHosts([["build-01", view("connecting")], ["db-02", view("lost")]]);
    expect(e.find(x => x.id === "ssh:build-01")).toMatchObject({ state: "connecting", usable: false });
    expect(e.find(x => x.id === "ssh:db-02")).toMatchObject({ state: "lost", usable: false });
    const off = withHosts([]).find(x => x.id === "ssh:build-01")!;
    expect(off).toMatchObject({ state: "off", usable: false, login: "deploy", can: "not connected" });
    // Points the model at offer_connect's Connect button, in words the user may read too, in a failed task's card (review #197).
    expect(off.why).toBe("build-01 isn't connected. Ember can show a Connect button for it.");
    expect(e.find(x => x.id === "ssh:db-02")!.why).toBe("The connection to db-02 dropped. Ember can show a Connect button for it, or it can be reconnected in Ember's settings (Computers).");
    const ready = withHosts([["build-01", view("ready", { desktop: "screen", commands: "on" })]]).find(x => x.id === "ssh:build-01")!;
    expect(ready).toMatchObject({ state: "ready", usable: true, can: "apps and commands" });
    const stalled = withHosts([["build-01", view("stalled", { desktop: "none", commands: "on" })]]).find(x => x.id === "ssh:build-01")!;
    expect(stalled).toMatchObject({ state: "ready", stalled: true, can: "isn't answering", usable: false });
  });

  it("says commands only for a headless remote, and is unusable with no desktop and commands off", () => {
    expect(withHosts([["build-01", view("ready", { desktop: "none", commands: "on" })]]).find(x => x.id === "ssh:build-01")).toMatchObject({ can: "commands only", usable: true });
    expect(withHosts([["build-01", view("ready", { desktop: "none", commands: "off" })]]).find(x => x.id === "ssh:build-01")).toMatchObject({ usable: false });
  });

  it("answers to its id, its host name and its resolved hostname", () => {
    const named = namedTargets(withHosts([]));
    expect(named.find(n => n.id === "ssh:build-01")!.names).toEqual(expect.arrayContaining(["build-01", "build-01.example.com"]));
    expect(hostPart("deploy@build-01:2222")).toBe("build-01");
    expect(hostPart("[::1]:22")).toBe("::1");
    expect(hostPart("build-01")).toBe("build-01");
  });
});

describe("short names (reviews #179, #180)", () => {
  const namesOf = (e: ReturnType<typeof buildRegistry>, id: string) => e.find(x => x.id === id)!.names;
  const fqdn = (id: string, more: Partial<HostRecord> = {}): HostRecord =>
    host(id, { dest: `deploy@${id}`, resolved: { user: "deploy", hostname: id, port: 22, jump: [] }, ...more });

  it("gives a host added by its full name the first part of it, when that looks like a computer's name", () => {
    const e = buildRegistry(input({ settings: settingsWith({ hosts: [fqdn("build-01.example.com"), fqdn("app.example.com"), fqdn("db.example.com")] }) }));
    expect(namesOf(e, "ssh:build-01.example.com")).toContain("build-01");
    // "in the app" or "on db" never names a computer: a first part needs a letter and a digit or a hyphen.
    expect(namesOf(e, "ssh:app.example.com")).not.toContain("app");
    expect(namesOf(e, "ssh:db.example.com")).not.toContain("db");
    // Its resolved hostname's first part too ("deploy@build-02" that ssh -G resolves to web-02.internal).
    const viaConfig = buildRegistry(input({ settings: settingsWith({ hosts: [host("build-02", { resolved: { user: "deploy", hostname: "web-02.internal", port: 22, jump: [] } })] }) }));
    expect(namesOf(viaConfig, "ssh:build-02")).toContain("web-02");
    // An address has no first part to say.
    const ip = buildRegistry(input({ settings: settingsWith({ hosts: [host("lab", { dest: "10.0.0.5", resolved: { user: "deploy", hostname: "10.0.0.5", port: 22, jump: [] } })] }) }));
    expect(namesOf(ip, "ssh:lab").filter(n => !/\./.test(n))).toEqual(["lab"]);
  });

  it("gives a short name two hosts share to both (so saying it asks which), and leaves one that is another computer's own name to it", () => {
    const shared = buildRegistry(input({ settings: settingsWith({ hosts: [fqdn("build-01.a.com"), fqdn("build-01.b.com")] }) }));
    expect(namesOf(shared, "ssh:build-01.a.com")).toContain("build-01");
    expect(namesOf(shared, "ssh:build-01.b.com")).toContain("build-01");
    const owned = buildRegistry(input({ settings: settingsWith({ hosts: [host("build-01"), fqdn("build-01.other.net")] }) }));
    expect(namesOf(owned, "ssh:build-01.other.net")).not.toContain("build-01");
  });

  it("gives a distro its first word: \"in Ubuntu\" names Ubuntu-22.04 (and the wrong-target guard hears it)", () => {
    const e = buildRegistry(input({
      os: "win32", settings: settingsWith({ wslOn: true }),
      wsl: facts([distro("Ubuntu-22.04", { isDefault: true }), distro("kali-linux"), distro("openSUSE-Leap-15.5"), distro("Debian")]),
    }));
    expect(namesOf(e, "wsl:Ubuntu-22.04")).toContain("Ubuntu");
    expect(namesOf(e, "wsl:kali-linux")).toContain("kali");
    expect(namesOf(e, "wsl:openSUSE-Leap-15.5")).toContain("openSUSE");
    expect(namesOf(e, "wsl:Debian")).toEqual(["Debian", "Debian (WSL)"]);
    // Listed for settings while WSL is off, with the same names (the guard counts them then too).
    const off = buildRegistry(input({ os: "win32", wsl: facts([distro("Ubuntu-22.04")]) }));
    expect(namesOf(off, "wsl:Ubuntu-22.04")).toContain("Ubuntu");
    // A distro called just Ubuntu keeps its name to itself.
    const both = buildRegistry(input({ os: "win32", settings: settingsWith({ wslOn: true }), wsl: facts([distro("Ubuntu"), distro("Ubuntu-22.04")]) }));
    expect(namesOf(both, "wsl:Ubuntu-22.04")).not.toContain("Ubuntu");
  });

  it("gives a first word only to a distribution's own name, so \"in build\" never names a distro called build-env", () => {
    const e = buildRegistry(input({
      os: "win32", settings: settingsWith({ wslOn: true }),
      wsl: facts([distro("Ubuntu-22.04", { isDefault: true }), distro("build-env"), distro("test-box"), distro("work-vm"), distro("dev-ubuntu"), distro("the-box"), distro("AlmaLinux-9")]),
    }));
    expect(namesOf(e, "wsl:build-env")).toEqual(["build-env", "build-env (WSL)"]);
    expect(namesOf(e, "wsl:test-box")).toEqual(["test-box", "test-box (WSL)"]);
    expect(namesOf(e, "wsl:work-vm")).toEqual(["work-vm", "work-vm (WSL)"]);
    expect(namesOf(e, "wsl:dev-ubuntu")).toEqual(["dev-ubuntu", "dev-ubuntu (WSL)"]);
    expect(namesOf(e, "wsl:the-box")).toEqual(["the-box", "the-box (WSL)"]);
    expect(namesOf(e, "wsl:AlmaLinux-9")).toContain("AlmaLinux");
    const t = namedTargets(e);
    const bound = (userWords: string) => bindTarget({ userWords, targets: t, active: "local", os: "win32" });
    for (const w of ["delete the logs in build", "save it in test mode", "clean up old files in work", "work: tidy my folder", "list the files in dev"]) {
      expect(bound(w)).toEqual({ ok: true, id: "local" });
    }
    expect(bound("in Ubuntu, list my home folder")).toEqual({ ok: true, id: "wsl:Ubuntu-22.04" });
    expect(bound("in build-env, delete the logs")).toEqual({ ok: true, id: "wsl:build-env" });
  });
});

describe("the picker's choice", () => {
  it("stays on a target a task can bind to, and falls back to this computer otherwise", () => {
    const e = buildRegistry(input({ settings: settingsWith({ hosts: [host("build-01")] }) }));
    expect(activeOf(e, "ssh:build-01")).toBe("ssh:build-01");
    expect(activeOf(e, "ssh:gone")).toBe("local");
    expect(activeOf(e, "wsl:Ubuntu")).toBe("local");
    expect(summaryOf(e[1], "ssh:build-01")).toEqual({ id: "ssh:build-01", kind: "ssh", label: "build-01", login: "deploy", state: "off", can: "not connected", active: true });
  });
});
