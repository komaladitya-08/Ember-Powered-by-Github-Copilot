import { afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import { ExperimentalWindowsLpacFixture, ExperimentalWindowsStopLease, experimentalWindowsEnvironment, experimentalWindowsSddl } from "../../app/main/agent/experimental-windows-lpac";
import type { WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";

const executable = Buffer.from("MZfixture");
afterEach(() => vi.restoreAllMocks());
function setup(fail = "") {
  vi.spyOn(fs.realpathSync, "native").mockReturnValue("C:\\scratch");
  const calls: string[] = [];
  let rootExited = false, active = 1, next = 100n;
  const api: WindowsLpacApi = {
    createProfile: name => { calls.push("profile"); return { name, sid: 9n, sidText: "S-1-15-2-1234" }; },
    deleteProfile: () => { calls.push("delete profile"); }, ownerSid: () => "S-1-5-21-1234", windowsDirectory: () => "C:\\Windows", volumeFileSystem: () => "NTFS",
    createDirectory: (_file, sddl) => { calls.push("directory " + sddl); },
    writeNewFile: (_file, bytes, sddl) => { calls.push("copied " + sddl); expect(bytes).toBe(executable); },
    pinDirectory: () => { calls.push("pin"); return next++; }, createJob: () => { calls.push("job"); return 1n; },
    createSuspended: (_profile, _program, command, _cwd, env) => { calls.push("suspended"); expect(command.toString("utf16le")).toContain("fixture.exe"); expect(env.toString("utf16le")).not.toMatch(/GH_TOKEN|USERPROFILE|COPILOT/); return { process: 2n, thread: 3n, pid: 44 }; },
    assign: () => { calls.push("assign"); if (fail === "assign") throw new Error("assignment failed"); },
    verifyToken: () => { calls.push("token"); if (fail === "token") throw new Error("not LPAC"); },
    resume: () => { calls.push("resume"); }, terminateJob: () => { calls.push("kill job"); rootExited = true; active = 0; },
    terminateProcess: () => { calls.push("kill root"); rootExited = true; },
    exited: () => { calls.push("observe root"); return rootExited; }, jobState: () => { calls.push("observe job"); return { active, listed: active }; },
    exitCode: () => 0, close: handle => { calls.push(`close ${handle}`); },
  };
  return { api, calls, exited: () => { rootExited = true; }, empty: () => { active = 0; } };
}

it("creates only new copied fixture objects, then LPAC suspended/job/token checks precede its first instruction", async () => {
  const s = setup(), fixture = ExperimentalWindowsLpacFixture.prepare("C:\\scratch", executable, s.api);
  expect(await fixture.launch()).toBe(44);
  expect(s.calls.indexOf("suspended")).toBeGreaterThan(s.calls.indexOf("job"));
  expect(s.calls.indexOf("resume")).toBeGreaterThan(s.calls.indexOf("assign"));
  expect(s.calls.indexOf("resume")).toBeGreaterThan(s.calls.indexOf("token"));
  expect(s.calls.filter(call => call.startsWith("directory"))).toHaveLength(4);
  expect(s.calls.filter(call => call.startsWith("copied"))).toHaveLength(1);
  await expect(fixture.launch()).rejects.toThrow("cannot launch again");
  await fixture.stop(); await fixture.close();
});

for (const fail of ["assign", "token"]) it(`never resumes after failed ${fail}, and observes termination before releasing handles`, async () => {
  const s = setup(fail), fixture = ExperimentalWindowsLpacFixture.prepare("C:\\scratch", executable, s.api);
  await expect(fixture.launch()).rejects.toThrow(fail === "assign" ? "assignment" : "not LPAC");
  expect(s.calls).not.toContain("resume");
  expect(s.calls.indexOf("kill root")).toBeGreaterThan(s.calls.indexOf("suspended"));
  expect(s.calls.indexOf("close 2")).toBeGreaterThan(s.calls.indexOf("observe root"));
  expect(s.calls.indexOf("delete profile")).toBeGreaterThan(s.calls.indexOf("observe job"));
  await expect(fixture.waitStopped()).rejects.toThrow();
});

it("does not confuse root exit with descendant exit, and invalidates a stop lease on close", async () => {
  const s = setup(), fixture = ExperimentalWindowsLpacFixture.prepare("C:\\scratch", executable, s.api);
  await fixture.launch();
  await expect(fixture.waitRootExited(0)).rejects.toThrow("has not exited");
  s.exited();
  await fixture.waitRootExited(0);
  await expect(fixture.waitStopped(0)).rejects.toThrow("descendants");
  expect(s.calls).not.toContain("close 2");
  const lease = await fixture.stop(); lease.requireStopped();
  expect(fixture.exitCode()).toBe(0);
  await fixture.close();
  expect(() => lease.requireStopped()).toThrow("not stopped");
  expect(() => ExperimentalWindowsStopLease.observe(Symbol(), s.api, 1n, 2n, () => true)).toThrow("issuer");
});

it("uses clean literal paths and narrow protected package ACLs, never write-DAC/full-control package grants", () => {
  const sddl = experimentalWindowsSddl("S-1-5-21-1234", "S-1-15-2-1234", "modify", true);
  expect(sddl).toContain("D:P"); expect(sddl).toContain("0x1301bf;;;S-1-15-2-1234"); expect(sddl).toContain("ML;OICI;NW;;;LW");
  expect(sddl).not.toContain("FA;;;S-1-15-2-1234");
  expect(() => experimentalWindowsSddl("bad;SID", "S-1-15-2-1234", "read", false)).toThrow();
  const paths = { root: "C:\\scratch", tools: "C:\\scratch\\tools", work: "C:\\scratch\\work", state: "C:\\scratch\\state", program: "C:\\scratch\\tools\\fixture.exe" };
  const env = experimentalWindowsEnvironment(paths, "C:\\Windows").toString("utf16le");
  expect(env.endsWith("\0\0")).toBe(true); expect(env).not.toMatch(/TOKEN|KEY|USERPROFILE|APPDATA/);
  expect(() => experimentalWindowsEnvironment({ ...paths, state: "\\\\host\\share" }, "C:\\Windows")).toThrow();
});

it("shares concurrent Stop and close completion without double-close or early receipt release", async () => {
  const s = setup(), fixture = ExperimentalWindowsLpacFixture.prepare("C:\\scratch", executable, s.api);
  await fixture.launch();
  const firstStop = fixture.stop(), secondStop = fixture.stop();
  expect(firstStop).toBe(secondStop);
  const firstClose = fixture.close(), secondClose = fixture.close();
  expect(firstClose).toBe(secondClose);
  await Promise.all([firstStop, secondStop, firstClose, secondClose]);
  expect(s.calls.filter(c => c === "kill job")).toHaveLength(1);
  for (const handle of ["close 1", "close 2", "close 3", "delete profile"]) expect(s.calls.filter(c => c === handle)).toHaveLength(1);
});

it("rejects unsupported volumes and reparse ancestry before creating a package or granting any scratch ACL", () => {
  const s = setup(); s.api.volumeFileSystem = () => "ReFS";
  expect(() => ExperimentalWindowsLpacFixture.prepare("C:\\scratch", executable, s.api)).toThrow("NTFS");
  expect(s.calls).not.toContain("profile");
  s.api.volumeFileSystem = () => "NTFS";
  s.api.pinDirectory = () => { throw new Error("reparse directory"); };
  expect(() => ExperimentalWindowsLpacFixture.prepare("C:\\scratch", executable, s.api)).toThrow("reparse");
  expect(s.calls.some(c => c.startsWith("directory"))).toBe(false);
  expect(s.calls).not.toContain("profile");
});

it("shares a failed Stop, preserves diagnostics and blocks further experiments when termination is unverified", async () => {
  const s = setup(), fixture = ExperimentalWindowsLpacFixture.prepare("C:\\scratch", executable, s.api);
  await fixture.launch();
  s.api.terminateJob = () => { s.calls.push("kill failed"); throw new Error("termination failed"); };
  const stop = fixture.stop();
  expect(fixture.stop()).toBe(stop);
  await expect(stop).rejects.toThrow("termination failed");
  const close = fixture.close(); expect(fixture.close()).toBe(close);
  await expect(close).rejects.toThrow("shutdown is unverified");
  expect(s.calls).not.toContain("close 1"); expect(s.calls).not.toContain("close 2"); expect(s.calls).not.toContain("delete profile");
  await expect(fixture.waitStopped(0)).rejects.toThrow("No verified");
  expect(() => ExperimentalWindowsLpacFixture.prepare("C:\\scratch", executable, s.api)).toThrow("earlier fixture shutdown");
});
