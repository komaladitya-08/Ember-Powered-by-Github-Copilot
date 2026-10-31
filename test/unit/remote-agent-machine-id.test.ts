/**
 * The agent's machine-id hash (Welcome.machineIdHash, app/remote/host-io.ts) against the bootstrap's probe (`machine`,
 * app/main/remote/bootstrap.ts): the PC compares the two, and the host record's, so they must be the same bytes hashed
 * the same way, or every reconnect would look like another computer (§7.4) and uninstall would miss the state folder.
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BOOTSTRAP_SH } from "../../app/main/remote/bootstrap";
import { probeMachineHash } from "../../app/remote/host-io";
import { hashLine } from "../../app/remote/places";

const sha = (b: string | Uint8Array) => createHash("sha256").update(b).digest("hex");
const files = (m: Record<string, string>) => (p: string) => (p in m ? Buffer.from(m[p], "latin1") : null);

describe("the agent's machine-id hash", () => {
  it("is the probe's rule: the first readable machine-id file's raw bytes, then ioreg's UUID lines", () => {
    // The probe's function, which this mirrors: if it changes, this test must change with the agent.
    expect(BOOTSTRAP_SH).toContain([
      "ember_machine() {",
      "  if [ -r /etc/machine-id ]; then ember_hash < /etc/machine-id",
      "  elif [ -r /var/lib/dbus/machine-id ]; then ember_hash < /var/lib/dbus/machine-id",
      "  elif command -v ioreg >/dev/null 2>&1; then ioreg -rd1 -c IOPlatformExpertDevice | awk -F'\"' '/IOPlatformUUID/ { print $4 }' | ember_hash",
      "  fi",
      "}",
    ].join("\n"));
  });

  it("hashes /etc/machine-id as sha256sum does: its bytes, newline or not, empty or not", () => {
    const id = "0123456789abcdef0123456789abcdef";
    expect(probeMachineHash({ readFile: files({ "/etc/machine-id": `${id}\n` }), ioreg: null })).toBe(sha(`${id}\n`));
    expect(probeMachineHash({ readFile: files({ "/etc/machine-id": `${id}\n` }), ioreg: null })).toBe(hashLine(id));
    // No trailing newline: the bytes as they are (a newline added would make every reconnect another computer).
    expect(probeMachineHash({ readFile: files({ "/etc/machine-id": id }), ioreg: null })).toBe(sha(id));
    // An empty but readable file is what the probe hashes too (a container's), not D-Bus's.
    expect(probeMachineHash({ readFile: files({ "/etc/machine-id": "", "/var/lib/dbus/machine-id": `${id}\n` }), ioreg: null })).toBe(sha(""));
    // Bytes that aren't UTF-8 are hashed as bytes.
    expect(probeMachineHash({ readFile: files({ "/etc/machine-id": "\xff\xfe\n" }), ioreg: null })).toBe(sha(Buffer.from([0xff, 0xfe, 0x0a])));
  });

  it("falls back to D-Bus's file, then the Mac's platform UUID, and says nothing when the probe would", () => {
    expect(probeMachineHash({ readFile: files({ "/var/lib/dbus/machine-id": "feed\n" }), ioreg: null })).toBe(sha("feed\n"));
    const ioreg = `+-o J314sAP  <class IOPlatformExpertDevice, id 0x100000254>\n    {\n      "IOPlatformSerialNumber" = "C02XX"\n      "IOPlatformUUID" = "5B0C3F2A-1D2E-4F50-9A6B-7C8D9E0F1A2B"\n    }\n`;
    expect(probeMachineHash({ readFile: files({}), ioreg })).toBe(sha("5B0C3F2A-1D2E-4F50-9A6B-7C8D9E0F1A2B\n"));
    expect(probeMachineHash({ readFile: files({}), ioreg })).toBe(hashLine("5B0C3F2A-1D2E-4F50-9A6B-7C8D9E0F1A2B"));
    // ioreg ran but named no UUID: awk printed nothing, and sha256sum hashed nothing.
    expect(probeMachineHash({ readFile: files({}), ioreg: "" })).toBe(sha(""));
    expect(probeMachineHash({ readFile: files({}), ioreg: null })).toBeNull();
  });
});
