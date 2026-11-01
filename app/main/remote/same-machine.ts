/**
 * Never this same computer (R10, §5.1.14): Ember refuses to treat the PC itself, or the user's own WSL on it, as a
 * remote, before anything is uploaded. Two rules: the address (loopback, an address of this PC's interfaces, or a
 * name that resolves to one) before ssh even starts, and the identity the probe reports (machine id **and** boot id,
 * since golden images and VDI clones share /etc/machine-id but a running clone has its own boot id, critique
 * remote-22; a Mac's IOPlatformUUID; on Windows, the boot ids of the running WSL2 distros). The unpackaged-only test
 * switch (EMBER_TEST_ALLOW_LOOPBACK_SSH) lifts both. Identities are SHA-256 hashes, computed exactly as the bootstrap
 * computes them (of the file's bytes, newline included).
 */

import { createHash } from "node:crypto";
import type { OS } from "../../shared/shortcuts";

/** This PC as the probe's `machine`, `boot` and `wsl` keys would describe it (hex SHA-256s; null when unknown). */
export interface SelfIdentity {
  os: OS;
  machine: string | null;
  boot: string | null;
  /** SHA-256 of each running WSL2 distro's boot id (Windows; WslService.bootIds()). */
  wslBoots: string[];
}

/** SHA-256 of bytes, hex. */
export function sha256Hex(b: Uint8Array | string): string {
  return createHash("sha256").update(b).digest("hex");
}

/**
 * This PC's identity: Linux hashes /etc/machine-id (else /var/lib/dbus/machine-id) and the kernel's boot id; macOS
 * hashes IOPlatformUUID plus a newline (what `awk '{print $4}'` prints in the probe); Windows has neither (only the WSL
 * rule applies there). `readFile` returns null for a file that can't be read; `ioregUuid` runs `ioreg` on a Mac.
 */
export async function selfIdentity(o: {
  os: OS;
  readFile: (p: string) => Uint8Array | null;
  ioregUuid?: () => Promise<string | null>;
  wslBoots?: () => Promise<string[]>;
}): Promise<SelfIdentity> {
  let machine: string | null = null;
  let boot: string | null = null;
  if (o.os === "linux") {
    const id = o.readFile("/etc/machine-id") ?? o.readFile("/var/lib/dbus/machine-id");
    machine = id && id.length ? sha256Hex(id) : null;
    const b = o.readFile("/proc/sys/kernel/random/boot_id");
    boot = b && b.length ? sha256Hex(b) : null;
  } else if (o.os === "darwin") {
    const uuid = await o.ioregUuid?.().catch(() => null);
    machine = uuid && /^[0-9A-Fa-f-]{36}$/.test(uuid) ? sha256Hex(`${uuid}\n`) : null;
  }
  let wslBoots: string[] = [];
  if (o.os === "win32" && o.wslBoots) {
    wslBoots = (await o.wslBoots().catch(() => [])).filter(h => /^[0-9a-f]{64}$/.test(h));
  }
  return { os: o.os, machine, boot, wslBoots };
}

/** IOPlatformUUID from `ioreg -rd1 -c IOPlatformExpertDevice` output, or null. */
export function ioregPlatformUuid(text: string): string | null {
  const m = /"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]{36})"/.exec(text);
  return m ? m[1] : null;
}

/**
 * The probe's identity against this PC's (§5.1.14): "same" when it is this computer (Linux: machine and boot both
 * equal; macOS: IOPlatformUUID equal), "wsl" when it is a WSL2 distro running on this Windows PC, else null.
 */
export function sameMachine(probe: Record<string, string>, self: SelfIdentity): "same" | "wsl" | null {
  const get = (k: string) => (Object.prototype.hasOwnProperty.call(probe, k) && /^[0-9a-f]{64}$/.test(probe[k]) ? probe[k] : null);
  const machine = get("machine");
  const boot = get("boot");
  const os = Object.prototype.hasOwnProperty.call(probe, "os") ? probe.os : "";
  if (self.os === "linux" && os === "Linux" && machine && boot && machine === self.machine && boot === self.boot) return "same";
  if (self.os === "darwin" && os === "Darwin" && machine && machine === self.machine) return "same";
  if (self.os === "win32" && probe.wsl === "1" && boot && self.wslBoots.includes(boot)) return "wsl";
  return null;
}

/** IPv4 dotted quad → its four numbers, or null. */
function v4(a: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return null;
  const n = m.slice(1).map(Number);
  return n.every(x => x <= 255) ? n : null;
}

/** An address as compared: lower case, without an IPv6 zone or brackets, IPv4-mapped IPv6 as IPv4. */
export function normaliseAddress(a: string): string {
  let s = a.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/%.*$/, "");
  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(s);
  if (mapped) s = mapped[1];
  return s;
}

/** Loopback or unspecified: localhost, 127.0.0.0/8, 0.0.0.0, ::1, :: (and their mapped forms). */
export function isLoopback(addr: string): boolean {
  const a = normaliseAddress(addr);
  if (a === "localhost" || a.endsWith(".localhost") || a === "::1" || a === "::" || a === "0:0:0:0:0:0:0:1" || a === "0:0:0:0:0:0:0:0") return true;
  const n = v4(a);
  return !!n && (n[0] === 127 || n.every(x => x === 0));
}

/**
 * Is `hostname` (ssh -G's resolved host name) this PC (§5.1.14)? Loopback, one of `own` (this PC's interface
 * addresses, os.networkInterfaces()), or a name that resolves to one (`lookup`, all addresses, given at most
 * `timeoutMs`; a name that doesn't resolve in time goes on: the identity check still runs on the probe).
 */
export async function isThisComputer(hostname: string, o: { own: readonly string[]; lookup: (h: string) => Promise<string[]>; timeoutMs?: number }): Promise<boolean> {
  const own = new Set(o.own.map(normaliseAddress));
  const mine = (a: string) => isLoopback(a) || own.has(normaliseAddress(a));
  if (mine(hostname)) return true;
  // An address needs no lookup.
  if (v4(normaliseAddress(hostname)) || normaliseAddress(hostname).includes(":")) return false;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<string[]>(resolve => { timer = setTimeout(() => resolve([]), o.timeoutMs ?? 2000); });
  try {
    const addrs = await Promise.race([o.lookup(hostname).catch(() => []), timeout]);
    return addrs.some(mine);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
