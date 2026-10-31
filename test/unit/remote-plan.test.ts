import { describe, expect, it } from "vitest";
import { parseAdminPolicy } from "../../app/main/admin";
import { glibcOf, planInstall, probeSession, remotePolicy, reusableRuntime, targetOf, type PlanLocal } from "../../app/main/remote/plan";

const PC = "0123456789abcdef0123456789abcdef";
const H = (c: string) => c.repeat(64);

/** A probe as the bootstrap prints it from an Ubuntu 24.04 home (values trimmed, as the reader keeps them). */
const probe = (over: Record<string, string> = {}): Record<string, string> => ({
  os: "Linux", arch: "x86_64", kernel: "6.8.0-45-generic", libc: "glibc 2.39", distro: "ubuntu 24.04", home: "/home/deploy",
  free_kb: "18702012", noexec: "0", fapolicyd: "", selinux: "", uid: "1000", user: "deploy", machine: H("a"), host: H("b"),
  wsl: "0", boot: H("c"), tools: "tar gzip xz head sha256sum script python3 loginctl busctl findmnt", rt: "", parts: "",
  fs: "ext2/ext3", tmp: "/run/user/1000", policy: "none", ...over,
});

const noPolicy = () => ({ policy: parseAdminPolicy("{}", "/etc/ember/policy.json").policy, source: null });

const local = (over: Partial<PlanLocal> = {}): PlanLocal => ({
  host: "build-01", pcId: PC, self: { os: "linux", machine: H("1"), boot: H("2"), wslBoots: [] }, allowLoopback: false,
  localAdmin: noPolicy(), models: [],
  parts: { partsId: "0.1.0-0123456789ab", targets: { "linux-x64": { bytes: 900_000, sha256: H("d") }, "linux-arm64": { bytes: 880_000, sha256: H("e") }, "darwin-arm64": { bytes: 870_000, sha256: H("f") } } },
  runtime: {
    minimum: "24.8.0", pinned: "24.11.1",
    targets: { "linux-x64": { xz: { bytes: 29_000_000, sha256: H("7") }, gz: { bytes: 46_000_000, sha256: H("8") } }, "darwin-arm64": { xz: { bytes: 28_000_000, sha256: H("9") } } },
  },
  ...over,
});

const b64chunks = (text: string) => {
  const b = Buffer.from(text).toString("base64");
  const out: Record<string, string> = {};
  for (let i = 0; i * 1000 < b.length; i++) out[`policy_b64.${i}`] = b.slice(i * 1000, (i + 1) * 1000);
  return out;
};
const withPolicy = (text: string, over: Record<string, string> = {}) => probe({ policy: "present", policy_uid: "0", policy_mode: "644", policy_size: String(Buffer.byteLength(text)), ...b64chunks(text), ...over });

describe("planInstall (§5.1.9)", () => {
  it("installs both archives on a fresh Linux home, as one INSTALL line with the PC's id", () => {
    const p = planInstall(probe(), local());
    expect(p).toMatchObject({ action: "install", target: "linux-x64", runtimeId: "v24.11.1-linux-x64", partsId: "0.1.0-0123456789ab" });
    if (p.action !== "install") throw new Error("not install");
    expect(p.line).toBe(`INSTALL ${PC} v24.11.1-linux-x64 29000000 ${H("7")} xz 0.1.0-0123456789ab 900000 ${H("d")}`);
    expect(p.runtime).toEqual({ id: "v24.11.1-linux-x64", bytes: 29_000_000, sha256: H("7"), format: "xz" });
    expect(p.remote).toMatchObject({ os: "linux", arch: "x64", uid: 1000, user: "deploy", wsl: false, tccLimited: false });
  });

  it("sends the gzip runtime to a remote without xz", () => {
    const p = planInstall(probe({ tools: "tar gzip head sha256sum" }), local());
    expect(p).toMatchObject({ action: "install", runtime: { format: "gz", bytes: 46_000_000 } });
  });

  it("keeps a verified runtime at or above the minimum and sends only the parts (critique remote-27)", () => {
    const p = planInstall(probe({ rt: "v24.9.0-linux-x64 v22.1.0-linux-x64" }), local());
    expect(p).toMatchObject({ action: "install", runtime: null, runtimeId: "v24.9.0-linux-x64" });
    if (p.action === "install") expect(p.line).toBe(`INSTALL ${PC} v24.9.0-linux-x64 0 - - 0.1.0-0123456789ab 900000 ${H("d")}`);
    expect(planInstall(probe({ rt: "v24.7.0-linux-x64" }), local())).toMatchObject({ action: "install", runtimeId: "v24.11.1-linux-x64" });
  });

  it("serves when both are there", () => {
    expect(planInstall(probe({ rt: "v24.11.1-linux-x64", parts: "0.1.0-0123456789ab 0.0.9-aaaaaaaaaaaa" }), local()))
      .toMatchObject({ action: "serve", line: `SERVE ${PC} v24.11.1-linux-x64 0.1.0-0123456789ab` });
  });

  it("refuses this same computer first, before looking at anything else (R10)", () => {
    const same = probe({ machine: H("1"), boot: H("2"), kernel: "3.10.0" });
    expect(planInstall(same, local())).toMatchObject({ action: "refuse", kind: "same-machine", message: "build-01 is this computer. Ember already works here." });
    // A clone shares the machine id but not the boot id (critique remote-22).
    expect(planInstall(probe({ machine: H("1") }), local())).toMatchObject({ action: "install" });
    // The unpackaged test switch lifts the rule.
    expect(planInstall(same, local({ allowLoopback: true }))).toMatchObject({ action: "refuse", kind: "unsupported" });
  });

  it("refuses WSL on this Windows PC", () => {
    const p = planInstall(probe({ wsl: "1", boot: H("5") }), local({ self: { os: "win32", machine: null, boot: null, wslBoots: [H("5")] } }));
    expect(p).toMatchObject({ action: "refuse", message: "build-01 is WSL on this computer: use it as WSL instead." });
  });

  it("refuses systems Ember can't run on, in order: OS, CPU, kernel, glibc, macOS", () => {
    expect(planInstall(probe({ os: "MINGW64_NT-10.0-19045" }), local())).toMatchObject({ kind: "not-posix", message: "build-01 runs Windows: Ember can't work there yet." });
    expect(planInstall(probe({ os: "FreeBSD", arch: "amd64" }), local())).toMatchObject({ kind: "unsupported", message: "Ember can't work on FreeBSD amd64 computers yet." });
    expect(planInstall(probe({ arch: "ppc64le" }), local())).toMatchObject({ kind: "unsupported" });
    expect(planInstall(probe({ kernel: "4.14.0-115.el7a" }), local())).toMatchObject({ message: "build-01's system is too old for Ember (it needs Linux 4.18 or newer)." });
    expect(planInstall(probe({ kernel: "4.18.0-305.el8.x86_64", libc: "glibc 2.28" }), local())).toMatchObject({ action: "install" });
    expect(planInstall(probe({ libc: "glibc 2.17" }), local())).toMatchObject({ message: "build-01's system is too old for Ember (it needs glibc 2.28 or newer, as in RHEL 8 or Ubuntu 20.04)." });
    expect(planInstall(probe({ libc: "musl libc (x86_64)" }), local())).toMatchObject({ action: "refuse", kind: "unsupported" });
    expect(planInstall(probe({ libc: "" }), local())).toMatchObject({ action: "refuse", kind: "unsupported" });
    const mac = { os: "Darwin", arch: "arm64", kernel: "24.0.0", libc: "", tools: "tar gzip xz head shasum" };
    expect(planInstall(probe({ ...mac, macos: "13.4.1" }), local())).toMatchObject({ message: "build-01's system is too old for Ember (it needs macOS 13.5 or newer)." });
    expect(planInstall(probe({ ...mac, macos: "14.6", tcc: "1" }), local())).toMatchObject({ action: "install", target: "darwin-arm64", remote: { tccLimited: true } });
  });

  it("parses the remote's policy before uploading anything and refuses on it (G21)", () => {
    expect(planInstall(withPolicy(JSON.stringify({ features: { ssh: false } })), local())).toMatchObject({ kind: "remote-policy", message: "build-01's administrator doesn't allow Ember there." });
    expect(planInstall(withPolicy("{ not json"), local())).toMatchObject({ message: "build-01's Ember policy is broken, so Ember won't work there." });
    expect(planInstall(withPolicy(JSON.stringify({ unknownKey: 1 })), local())).toMatchObject({ kind: "remote-policy" });
    expect(planInstall(withPolicy("{}", { policy_uid: "1000" }), local())).toMatchObject({ kind: "remote-policy" });
    expect(planInstall(withPolicy("{}", { policy_mode: "666" }), local())).toMatchObject({ kind: "remote-policy" });
    expect(planInstall(withPolicy("{}", { policy_size: "70000" }), local())).toMatchObject({ kind: "remote-policy" });
    expect(planInstall(withPolicy("{}", { policy_size: "3" }), local())).toMatchObject({ kind: "remote-policy" });
    expect(planInstall(withPolicy(JSON.stringify({ provider: { type: "openai", baseUrl: "https://llm.example.com" } })), local())).toMatchObject({ message: "build-01's administrator requires its own model service, which Ember on this computer can't use." });
    expect(planInstall(withPolicy(JSON.stringify({ models: { allowed: ["m-1"] } })), local({ models: ["m-2"] }))).toMatchObject({ kind: "remote-policy" });
    expect(planInstall(withPolicy(JSON.stringify({ models: { allowed: ["m-1"] } })), local({ localAdmin: parseAdminPolicy(JSON.stringify({ models: { allowed: ["m-3"] } }), "/etc/ember/policy.json") }))).toMatchObject({ kind: "remote-policy" });
    const ok = planInstall(withPolicy(JSON.stringify({ ssh: { desktop: false }, commands: { ssh: "ask" } })), local());
    expect(ok).toMatchObject({ action: "install", remote: { remoteAdmin: { commands: { ssh: "ask" }, ssh: { desktop: false } } } });
  });

  it("refuses a noexec home, a full disk and missing tools, but only installs need room and tools", () => {
    expect(planInstall(probe({ noexec: "1" }), local())).toMatchObject({ kind: "noexec", message: "build-01 doesn't let programs run from your home folder, so Ember can't run there." });
    expect(planInstall(probe({ free_kb: "100000" }), local())).toMatchObject({ kind: "disk", message: "build-01 doesn't have room for Ember's helper (it needs about 400 MB in your home folder)." });
    expect(planInstall(probe({ tools: "xz head" }), local())).toMatchObject({ kind: "tools" });
    expect(planInstall(probe({ free_kb: "100000", tools: "", rt: "v24.11.1-linux-x64", parts: "0.1.0-0123456789ab" }), local())).toMatchObject({ action: "serve" });
  });

  it("refuses when this install has no parts or runtime for the target", () => {
    expect(planInstall(probe(), local({ parts: null }))).toMatchObject({ kind: "parts-missing" });
    expect(planInstall(probe({ arch: "aarch64" }), local())).toMatchObject({ action: "refuse" });
    expect(planInstall(probe(), local({ runtime: null }))).toMatchObject({ kind: "parts-missing" });
    expect(planInstall(probe(), local({ pcId: "short" }))).toMatchObject({ action: "refuse" });
  });

  it("notes fapolicyd and confined SELinux users for the exec-denied wording (L24)", () => {
    expect(planInstall(probe({ fapolicyd: "active" }), local())).toMatchObject({ remote: { hardened: true } });
    expect(planInstall(probe({ selinux: "staff_u:staff_r:staff_t:s0-s0:c0.c1023" }), local())).toMatchObject({ remote: { hardened: true } });
    expect(planInstall(probe({ selinux: "unconfined_u:unconfined_r:unconfined_t:s0-s0:c0.c1023" }), local())).toMatchObject({ remote: { hardened: false } });
  });
});

describe("probe helpers", () => {
  it("reads glibc from getconf and ldd lines", () => {
    expect(glibcOf("glibc 2.28")).toEqual([2, 28]);
    expect(glibcOf("ldd (GNU libc) 2.31")).toEqual([2, 31]);
    expect(glibcOf("ldd (Ubuntu GLIBC 2.35-0ubuntu3.1) 2.35")).toEqual([2, 35]);
    expect(glibcOf("musl libc (aarch64)")).toBe("musl");
    expect(glibcOf("")).toBeNull();
  });

  it("maps uname to targets", () => {
    expect(targetOf("Linux", "aarch64")).toMatchObject({ target: "linux-arm64" });
    expect(targetOf("Darwin", "x86_64")).toMatchObject({ target: "darwin-x64" });
    expect(targetOf("Linux", "armv7l")).toBeNull();
  });

  it("reuses only a runtime of the pinned major at or above the minimum, for this target", () => {
    expect(reusableRuntime(["v24.10.0-linux-x64", "v24.12.0-linux-x64", "v24.12.0-linux-arm64"], "linux-x64", "24.8.0", "24.11.1")).toBe("v24.12.0-linux-x64");
    expect(reusableRuntime(["v25.1.0-linux-x64", "v24.8.0-linux-arm64"], "linux-x64", "24.8.0", "24.11.1")).toBeNull();
    expect(reusableRuntime(["v24.8.0-linux-x64"], "linux-x64", "24.8.0", "24.11.1")).toBe("v24.8.0-linux-x64");
  });

  it("reads loginctl's properties by name, whatever order they came in (critique remote-2)", () => {
    expect(probeSession(probe({ "session.LockedHint": "no", "session.Type": "x11", "session.Remote": "no", "session.Active": "yes", "session.Seat": "seat0" })))
      .toEqual({ type: "x11", active: true, remote: false, seat: "seat0", locked: false });
    expect(probeSession(probe())).toBeNull();
  });

  it("locks the remote policy down when the probe's chunks don't add up", () => {
    expect(remotePolicy(probe({ policy: "present", policy_uid: "0", policy_mode: "644", policy_size: "2", "policy_b64.0": "e30=" }), "/etc/ember/policy.json")?.error).toBeUndefined();
    expect(remotePolicy(probe({ policy: "present", policy_uid: "0", policy_mode: "644", policy_size: "2", "policy_b64.0": "e30" }), "/etc/ember/policy.json")?.error).toBeTruthy();
    expect(remotePolicy(probe({ policy: "weird" }), "/etc/ember/policy.json")?.error).toBeTruthy();
    expect(remotePolicy(probe(), "/etc/ember/policy.json")).toBeNull();
  });
});
