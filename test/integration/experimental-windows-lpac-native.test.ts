/**
 * Real Win64 LPAC/profile/ACL/job fixture. Every supported Windows runner must execute or fail, never quietly skip.
 * Requires the VS C++ x64 component installed on GitHub's windows-2022 runner. This is not a Copilot/runtime test.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { ExperimentalWindowsLpacFixture } from "../../app/main/agent/experimental-windows-lpac";
import { loadExperimentalWindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";

const windows = process.platform === "win32";
let directory = "", executable: Buffer;
let safeToRemove = true;
function compileFixture(): Buffer {
  if (process.arch !== "x64") throw new Error("This native smoke fixture currently requires a Windows x64 compiler/runner.");
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "ember-lpac-native-"));
  const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const installation = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8", timeout: 15_000 }).trim();
  if (!installation || /[\r\n"]/.test(installation)) throw new Error("The Windows LPAC native test requires Visual Studio's C++ x64 build tools.");
  const source = path.resolve("test/fixtures/experimental-windows-lpac.c"), output = path.join(directory, "fixture.exe"), object = path.join(directory, "fixture.obj");
  const script = path.join(directory, "compile.cmd");
  fs.writeFileSync(script, `@echo off\r\ncall "${path.join(installation, "VC", "Auxiliary", "Build", "vcvars64.bat")}" >nul\r\nif errorlevel 1 exit /b 1\r\ncl.exe /nologo /O1 /GS- /Zl /Fo"${object}" /Fe"${output}" "${source}" /link /NODEFAULTLIB /ENTRY:mainCRTStartup /SUBSYSTEM:CONSOLE kernel32.lib advapi32.lib\r\n`, "utf8");
  // cmd.exe parses its own quoting: /s removes the outer pair, leaving the quoted batch path intact.
  const build = spawnSync("cmd.exe", ["/d", "/s", "/c", `""${script}""`], { encoding: "utf8", windowsVerbatimArguments: true, windowsHide: true, timeout: 60_000 });
  if (build.status !== 0) throw new Error(`The LPAC fixture did not compile: ${build.stdout}\n${build.stderr}`);
  return fs.readFileSync(output);
}

async function report(file: string): Promise<number[]> {
  const deadline = performance.now() + 15_000;
  for (;;) {
    try {
      const bytes = fs.readFileSync(file);
      if (bytes.length === 48) return Array.from({ length: 12 }, (_, i) => bytes.readUInt32LE(i * 4));
    } catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
    if (performance.now() > deadline) throw new Error("The native LPAC fixture produced no complete report. No capability or ACL fallback is permitted.");
    await new Promise<void>(resolve => setTimeout(resolve, 20));
  }
}

describe.skipIf(!windows)("experimental LPAC real Windows enforcement", () => {
  beforeAll(() => { executable = compileFixture(); }, 90_000);
  afterAll(() => { if (directory && safeToRemove) fs.rmSync(directory, { recursive: true, force: true }); });

  it("runs only in capability-free LPAC, denies generic AppContainer files/host process access, and observes descendants before releasing results", async () => {
    const api = loadExperimentalWindowsLpacApi();
    let expectedLocalAppData = "";
    const fixture = ExperimentalWindowsLpacFixture.prepare(directory, executable, { ...api, profileLocalAppDataBase(profile) {
      const base = api.profileLocalAppDataBase(profile);
      expectedLocalAppData = path.join(base, "Packages", profile.name, "AC");
      return base;
    } });
    let closed = false;
    let cleanupFailure: unknown;
    const earlier = process.env.GH_TOKEN;
    process.env.GH_TOKEN = "synthetic-lpac-test-marker";
    try {
      // This canary intentionally grants ordinary AppContainers read access, but not this per-session package SID.
      api.writeNewFile(path.join(fixture.paths.root, "all-app-packages.txt"), Buffer.from("disposable LPAC canary"),
        `D:P(A;;FA;;;${api.ownerSid()})(A;;FA;;;SY)(A;;FR;;;AC)S:(ML;;NW;;;ME)`);
      expect(fs.readFileSync(path.join(fixture.paths.root, "all-app-packages.txt"), "utf8")).toBe("disposable LPAC canary");
      await fixture.launch([String(process.pid)]);
      const observed = await report(path.join(fixture.paths.state, "report.bin"));
      expect(observed.slice(0, 9)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
      expect(observed[9]).toBeGreaterThan(0);
      expect(observed[10]).toBe(1);
      expect(observed[11]).toBe(1);
      await fixture.waitRootExited(15_000); // The report is written before ExitProcess; observe the exact handle.
      await expect(fixture.waitStopped(100)).rejects.toThrow(/descendants|root process/);
      const lease = await fixture.stop();
      lease.requireStopped();
      expect(fixture.exitCode()).toBe(0);
      // Observe real Windows redirection, not merely the parent environment we supplied. The profile path was
      // obtained from GetAppContainerFolderPath for this newly created SID; no profile ancestor gets an ACL grant.
      for (const [file, expected] of [["local-app-data-path.txt", expectedLocalAppData], ["temp-path.txt", path.join(expectedLocalAppData, "Temp")]]) {
        const bytes = fs.readFileSync(path.join(fixture.paths.state, file));
        expect(bytes.length).toBeLessThan(16 * 1024);
        expect(bytes.toString("utf16le").toLowerCase()).toBe(expected.toLowerCase());
      }
      await fixture.close(); closed = true;
      expect(() => lease.requireStopped()).toThrow();
    } finally {
      if (earlier === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = earlier;
      if (!closed) {
        try { await fixture.close(); }
        catch (err) { safeToRemove = false; cleanupFailure = err; }
      }
    }
    if (cleanupFailure) throw cleanupFailure;
  }, 45_000);
});
