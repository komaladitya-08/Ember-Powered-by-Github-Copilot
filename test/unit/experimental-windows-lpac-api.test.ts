import { expect, it } from "vitest";
import { bindExperimentalWindowsLpacApi, LPAC_ATTRIBUTES, LPAC_CREATE_FLAGS, LPAC_KILL_ON_CLOSE, WINDOWS_LPAC_FUNCTIONS } from "../../app/main/agent/experimental-windows-lpac-api";

function setup(failure = "") {
  const calls: { name: string; args: unknown[] }[] = [];
  const native = { sizeof: () => 8, address: () => 0xabcden, decode: { string16: () => "S-1-15-2-1234" } } as unknown as Parameters<typeof bindExperimentalWindowsLpacApi>[0];
  const api = bindExperimentalWindowsLpacApi(native, () => ({ func: prototype => {
    const name = /\b(\w+)\s*\(/.exec(prototype)![1];
    return (...args: unknown[]) => {
      calls.push({ name, args: name === "UpdateProcThreadAttribute" ? args.map(value => Buffer.isBuffer(value) ? Buffer.from(value) : value) : args });
      if (name === "GetLastError") return 122;
      if (name === "GetDriveTypeW") return failure === "mapped" ? 4 : 3;
      if (name === "WaitForSingleObject") return failure === "unobserved" ? 258 : 0;
      if (name === "DeleteProcThreadAttributeList" && (failure === "cleanup" || failure === "unobserved")) throw new Error("attribute cleanup failed");
      if (name === "CreateJobObjectW") return 10n;
      if (name === "SetInformationJobObject") return failure === "job" ? 0 : 1;
      if (name === "InitializeProcThreadAttributeList") { (args[3] as bigint[])[0] = 128n; return args[0] ? 1 : 0; }
      if (name === "UpdateProcThreadAttribute") return failure === "policy" && args[2] === LPAC_ATTRIBUTES.allApplicationPackagesPolicy ? 0 : 1;
      if (name === "CreateProcessW") {
        const output = args[9] as Buffer;
        output.writeBigUInt64LE(20n, 0); output.writeBigUInt64LE(30n, 8); output.writeUInt32LE(40, 16); return 1;
      }
      if (name === "CreateAppContainerProfile") return -2147024713; // HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)
      return 1;
    };
  } }));
  return { api, calls };
}

it("binds LPAC opt-out and capability-free SECURITY_CAPABILITIES, mutable UTF16 command, and zero handle inheritance", () => {
  const s = setup(), command = Buffer.from('"C:\\copy\\fixture.exe"\0', "utf16le"), env = Buffer.from("PATH=C:\\copy\0\0", "utf16le");
  const process = s.api.createSuspended({ name: "new-profile", sid: 55n, sidText: "S-1-15-2-1234" }, "C:\\copy\\fixture.exe", command, "C:\\copy", env);
  expect(process).toEqual({ process: 20n, thread: 30n, pid: 40 });
  const capabilities = s.calls.find(c => c.name === "UpdateProcThreadAttribute" && c.args[2] === LPAC_ATTRIBUTES.securityCapabilities)!;
  const policy = s.calls.find(c => c.name === "UpdateProcThreadAttribute" && c.args[2] === LPAC_ATTRIBUTES.allApplicationPackagesPolicy)!;
  expect(capabilities.args[4]).toBe(24); expect(policy.args[4]).toBe(4);
  expect((capabilities.args[3] as Buffer).readBigUInt64LE(0)).toBe(55n);
  expect((capabilities.args[3] as Buffer).readBigUInt64LE(8)).toBe(0n);
  expect((capabilities.args[3] as Buffer).readUInt32LE(16)).toBe(0);
  expect((capabilities.args[3] as Buffer).readUInt32LE(20)).toBe(0);
  expect((policy.args[3] as Buffer).readUInt32LE(0)).toBe(1);
  const create = s.calls.find(c => c.name === "CreateProcessW")!;
  expect(create.args.slice(2, 5)).toEqual([null, null, 0]);
  expect(create.args[1]).toBe(command); expect(create.args[6]).toBe(env); expect(create.args[5]).toBe(LPAC_CREATE_FLAGS);
  const startup = create.args[8] as Buffer;
  expect(startup.length).toBe(112); expect(startup.readUInt32LE(0)).toBe(112); expect(startup.readBigUInt64LE(104)).toBe(0xabcden);
  expect(s.calls.at(-1)?.name).toBe("DeleteProcThreadAttributeList");
  expect(s.calls.some(c => c.name === "UpdateProcThreadAttribute" && c.args[2] === 0x20002)).toBe(false);
});

it("refuses failed LPAC policy setup before process creation, and frees initialized attributes", () => {
  const s = setup("policy");
  expect(() => s.api.createSuspended({ name: "p", sid: 1n, sidText: "S-1-15-2-1234" }, "C:\\x.exe", Buffer.alloc(4), "C:\\copy", Buffer.alloc(4))).toThrow("LPAC");
  expect(s.calls.some(c => c.name === "CreateProcessW")).toBe(false);
  expect(s.calls.at(-1)?.name).toBe("DeleteProcThreadAttributeList");
});

it("enables kill-on-close without either breakaway flag, and closes failed job setup", () => {
  const s = setup("job"); expect(() => s.api.createJob()).toThrow("SetInformationJobObject");
  const set = s.calls.find(c => c.name === "SetInformationJobObject")!;
  expect((set.args[2] as Buffer).readUInt32LE(16)).toBe(LPAC_KILL_ON_CLOSE);
  expect(LPAC_KILL_ON_CLOSE & (0x800 | 0x1000)).toBe(0);
  expect(s.calls.at(-1)).toEqual({ name: "CloseHandle", args: [10n] });
});

it("does not adopt an existing profile or bind a derivation fallback", () => {
  const s = setup(); expect(() => s.api.createProfile("collision")).toThrow("no profile is adopted");
  expect(Object.values(WINDOWS_LPAC_FUNCTIONS).flat().join("\n")).not.toContain("DeriveAppContainerSid");
});


it("rejects mapped network drives before checking their reported filesystem type", () => {
  const s = setup("mapped"); expect(() => s.api.volumeFileSystem("P:\\")).toThrow("local fixed");
  expect(s.calls.some(c => c.name === "GetVolumeInformationW")).toBe(false);
});

it("reaps a created suspended process when post-create attribute cleanup fails", () => {
  const s = setup("cleanup");
  expect(() => s.api.createSuspended({ name: "p", sid: 1n, sidText: "S-1-15-2-1234" }, "C:\\x.exe", Buffer.alloc(4), "C:\\copy", Buffer.alloc(4))).toThrow("attribute cleanup failed");
  expect(s.calls.some(c => c.name === "TerminateProcess" && c.args[0] === 20n)).toBe(true);
  expect(s.calls.some(c => c.name === "WaitForSingleObject" && c.args[0] === 20n)).toBe(true);
  expect(s.calls.filter(c => c.name === "CloseHandle").map(c => c.args[0])).toEqual([30n, 20n]);
});

it("signals uncertain creation when a post-create anomaly cannot prove the suspended process exited", () => {
  const s = setup("unobserved");
  expect(() => s.api.createSuspended({ name: "p", sid: 1n, sidText: "S-1-15-2-1234" }, "C:\\x.exe", Buffer.alloc(4), "C:\\copy", Buffer.alloc(4))).toThrow("could not be observed terminated");
  expect(s.calls.some(c => c.name === "CloseHandle")).toBe(false);
});
