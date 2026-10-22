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
    expect(off.why).toBe("build-01 isn't connected. Connect it from Ember's menu first.");
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

describe("the picker's choice", () => {
  it("stays on a target a task can bind to, and falls back to this computer otherwise", () => {
    const e = buildRegistry(input({ settings: settingsWith({ hosts: [host("build-01")] }) }));
    expect(activeOf(e, "ssh:build-01")).toBe("ssh:build-01");
    expect(activeOf(e, "ssh:gone")).toBe("local");
    expect(activeOf(e, "wsl:Ubuntu")).toBe("local");
    expect(summaryOf(e[1], "ssh:build-01")).toEqual({ id: "ssh:build-01", kind: "ssh", label: "build-01", login: "deploy", state: "off", can: "not connected", active: true });
  });
});
