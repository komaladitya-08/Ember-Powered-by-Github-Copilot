import { describe, expect, it, vi } from "vitest";
import { ioregPlatformUuid, isLoopback, isThisComputer, normaliseAddress, sameMachine, selfIdentity, sha256Hex } from "../../app/main/remote/same-machine";

const files: Record<string, string> = {
  "/etc/machine-id": "4f1c0e6b2a9d4b8e9a3c5d7e1f2a3b4c\n",
  "/proc/sys/kernel/random/boot_id": "d4b2f7a0-8c1e-4e5f-9a6b-7c8d9e0f1a2b\n",
};
const readFile = (p: string) => (p in files ? Buffer.from(files[p]) : null);

describe("this PC's identity (§5.1.14)", () => {
  it("hashes Linux's machine id and boot id as the bootstrap does (the file's bytes, newline included)", async () => {
    const self = await selfIdentity({ os: "linux", readFile });
    expect(self.machine).toBe(sha256Hex(files["/etc/machine-id"]));
    expect(self.boot).toBe(sha256Hex(files["/proc/sys/kernel/random/boot_id"]));
  });

  it("falls back to D-Bus's machine id, and knows nothing when neither can be read", async () => {
    const dbus = await selfIdentity({ os: "linux", readFile: p => (p === "/var/lib/dbus/machine-id" ? Buffer.from("x\n") : null) });
    expect(dbus.machine).toBe(sha256Hex("x\n"));
    expect(await selfIdentity({ os: "linux", readFile: () => null })).toEqual({ os: "linux", machine: null, boot: null, wslBoots: [] });
  });

  it("hashes a Mac's IOPlatformUUID with the newline awk prints", async () => {
    const uuid = "1A2B3C4D-5E6F-7A8B-9C0D-1E2F3A4B5C6D";
    const text = `+-o J314sAP  <class IOPlatformExpertDevice>\n    {\n      "IOPlatformUUID" = "${uuid}"\n    }\n`;
    expect(ioregPlatformUuid(text)).toBe(uuid);
    const self = await selfIdentity({ os: "darwin", readFile, ioregUuid: async () => ioregPlatformUuid(text) });
    expect(self.machine).toBe(sha256Hex(`${uuid}\n`));
  });

  it("takes the running WSL2 distros' boot ids on Windows, and nothing else", async () => {
    const h = "e".repeat(64);
    const self = await selfIdentity({ os: "win32", readFile, wslBoots: async () => [h, "not a hash"] });
    expect(self).toEqual({ os: "win32", machine: null, boot: null, wslBoots: [h] });
    expect((await selfIdentity({ os: "win32", readFile, wslBoots: async () => { throw new Error("wsl.exe failed"); } })).wslBoots).toEqual([]);
  });
});

describe("sameMachine", () => {
  const self = { os: "linux" as const, machine: "a".repeat(64), boot: "b".repeat(64), wslBoots: [] };

  it("needs both the machine id and the boot id on Linux (critique remote-22: clones share the machine id)", () => {
    expect(sameMachine({ os: "Linux", machine: "a".repeat(64), boot: "b".repeat(64) }, self)).toBe("same");
    expect(sameMachine({ os: "Linux", machine: "a".repeat(64), boot: "c".repeat(64) }, self)).toBeNull();
    expect(sameMachine({ os: "Linux", machine: "a".repeat(64) }, self)).toBeNull();
    expect(sameMachine({ os: "Darwin", machine: "a".repeat(64), boot: "b".repeat(64) }, self)).toBeNull();
  });

  it("matches a Mac by IOPlatformUUID", () => {
    expect(sameMachine({ os: "Darwin", machine: "a".repeat(64) }, { ...self, os: "darwin" })).toBe("same");
  });

  it("finds this Windows PC's own WSL by boot id", () => {
    const win = { os: "win32" as const, machine: null, boot: null, wslBoots: ["d".repeat(64)] };
    expect(sameMachine({ os: "Linux", wsl: "1", boot: "d".repeat(64) }, win)).toBe("wsl");
    expect(sameMachine({ os: "Linux", wsl: "1", boot: "e".repeat(64) }, win)).toBeNull();
    expect(sameMachine({ os: "Linux", wsl: "0", boot: "d".repeat(64) }, win)).toBeNull();
  });

  it("ignores values that aren't hashes", () => {
    expect(sameMachine({ os: "Linux", machine: "", boot: "" }, { ...self, machine: "", boot: "" })).toBeNull();
  });
});

describe("loopback and this PC's addresses", () => {
  it("knows loopback in every spelling", () => {
    for (const a of ["localhost", "LOCALHOST", "ip6-loop.localhost", "127.0.0.1", "127.8.9.10", "::1", "[::1]", "0.0.0.0", "::", "::ffff:127.0.0.1"]) expect(isLoopback(a)).toBe(true);
    for (const a of ["10.0.0.1", "build-01", "128.0.0.1", "::2"]) expect(isLoopback(a)).toBe(false);
    expect(normaliseAddress("[FE80::1%eth0]")).toBe("fe80::1");
  });

  it("refuses this PC's own addresses and names that resolve to them, within the lookup's time", async () => {
    const own = ["192.168.1.20", "fe80::abcd"];
    expect(await isThisComputer("192.168.1.20", { own, lookup: async () => [] })).toBe(true);
    expect(await isThisComputer("FE80::ABCD", { own, lookup: async () => [] })).toBe(true);
    expect(await isThisComputer("me.local", { own, lookup: async () => ["192.168.1.20"] })).toBe(true);
    expect(await isThisComputer("lo-alias", { own, lookup: async () => ["127.0.1.1"] })).toBe(true);
    expect(await isThisComputer("build-01", { own, lookup: async () => ["10.0.0.5"] })).toBe(false);
    expect(await isThisComputer("broken", { own, lookup: async () => { throw new Error("ENOTFOUND"); } })).toBe(false);
    // An address is never looked up.
    const lookup = vi.fn(async () => ["127.0.0.1"]);
    expect(await isThisComputer("10.0.0.9", { own, lookup })).toBe(false);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("goes on when the name doesn't resolve in time (the probe's identity check still runs)", async () => {
    vi.useFakeTimers();
    try {
      const p = isThisComputer("slow", { own: [], lookup: () => new Promise(() => undefined), timeoutMs: 2000 });
      await vi.advanceTimersByTimeAsync(2001);
      expect(await p).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
