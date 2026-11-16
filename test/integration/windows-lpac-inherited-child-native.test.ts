/** Separate inherited-token child diagnostic. The original explicit-attribute acceptance fixture is unchanged. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { ExperimentalWindowsLpacFixture } from "../../app/main/agent/experimental-windows-lpac";
import { loadExperimentalWindowsLpacApi, type WindowsLpacProfile, type WindowsHandle, type WindowsSuspendedProcess } from "../../app/main/agent/experimental-windows-lpac-api";
import { loadInheritedChildObserver, InheritedChildCleanupError, inheritedChildNumericFailure, inheritedChildCompilerFailure, inheritedChildVisualStudioRange,
  INHERITED_CHILD_VARIANTS, inheritedChildReadout, inheritedChildVariantDefine, inheritedChildSuppliedSdDiagnostic, type InheritedChildVariant } from "../fixtures/windows-lpac-inherited-child";
import { nativeChecks, WindowsNodeProofCleanupError } from "../fixtures/windows-node-lpac-proof";
import { parseWindowsLpacChildSdDiagnostic, readWindowsLpacChildSdDiagnostic, WINDOWS_LPAC_CHILD_SD_BYTES, type WindowsLpacChildSdDiagnostic } from "../fixtures/windows-lpac-child-sd-diagnostic";

const required = process.env.EMBER_LPAC_INHERITED_CHILD_TEST === "1", supported = process.platform === "win32";
const retainedOwners: unknown[] = [];
const fixedFailure = () => new Error("The inherited-child native experiment failed; only stopped numeric facts may leave its fixture.");
const ordinary = (value: string): string => {
  if (!/^[A-Za-z]:\\/.test(value) || path.win32.normalize(value) !== value || /[%!^&|<>"\p{Cc}\p{Cf}]/u.test(value)) throw fixedFailure(); return value;
};
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function boundedRead(file: string, maximum: number): Buffer | null {
  let fd: number | undefined, result: Buffer | undefined, failed = false;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size > maximum) throw fixedFailure();
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)); const opened = fs.fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.nlink !== 1 || !opened.isFile()) throw fixedFailure();
    const bytes = Buffer.alloc(before.size + 1); let offset = 0;
    while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset); if (!count) break; offset += count; }
    const after = fs.fstatSync(fd), observed = fs.lstatSync(file);
    if (offset !== before.size || after.ino !== opened.ino || after.dev !== opened.dev || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs || observed.ino !== opened.ino || observed.dev !== opened.dev || !observed.isFile() || observed.isSymbolicLink() || observed.nlink !== 1) throw fixedFailure();
    result = bytes.subarray(0, offset);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") failed = true; }
  if (fd !== undefined) try { fs.closeSync(fd); } catch { result?.fill(0); retainedOwners.push({ descriptor: fd }); throw new InheritedChildCleanupError(); }
  if (failed) { result?.fill(0); throw fixedFailure(); } return result ?? null;
}
function reportWords(file: string, count: number): number[] | null {
  const bytes = boundedRead(file, count * 4);
  if (!bytes) return null;
  try { if (bytes.length !== count * 4) throw fixedFailure(); return Array.from({ length: count }, (_, index) => bytes.readUInt32LE(index * 4)); }
  finally { bytes.fill(0); }
}
function writeAdmission(file: string, child: number): void {
  const bytes = Buffer.alloc(8); bytes.writeUInt32LE(0x43495045); bytes.writeUInt32LE(child, 4); let fd: number | undefined, failed = false;
  const pending = file + ".pending";
  try {
    fd = fs.openSync(pending, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
    if (fs.writeSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) throw fixedFailure(); fs.fsyncSync(fd);
  } catch { failed = true; }
  if (fd !== undefined) try { fs.closeSync(fd); } catch { bytes.fill(0); retainedOwners.push({ descriptor: fd }); throw new InheritedChildCleanupError(); }
  bytes.fill(0); if (failed) throw fixedFailure();
  // Publish the closed complete control message; the child never observes a partially written acknowledgement.
  try { fs.lstatSync(file); throw fixedFailure(); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw fixedFailure(); }
  try { fs.renameSync(pending, file); } catch { throw fixedFailure(); }
}

describe.skipIf(!supported && !required)("separate LPAC inherited-token child experiment", () => {
  let root = "", safeToRemove = true;
  const executables = new Map<InheritedChildVariant, Buffer>();
  beforeAll(() => {
    expect(process.platform).toBe("win32"); expect(process.arch).toBe("x64");
    let stage = 1, variantId = 0, status: number | null = null, diagnostic = { domain: 0, code: 0 };
    try {
    const temporary = fs.realpathSync.native(os.tmpdir()), parent = path.basename(temporary).startsWith("ember-run-") ? path.dirname(temporary) : temporary;
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(parent, "ember-lpac-inherited-")));
    const build = path.join(root, "build"), profile = path.join(build, "profile"), temporaryBuild = path.join(build, "temporary");
    for (const directory of [build, profile, temporaryBuild, path.join(profile, "Local"), path.join(profile, "Roaming")]) fs.mkdirSync(directory);
    stage = 2;
    const windows = ordinary(process.env.SystemRoot ?? "C:\\Windows"), programFiles = ordinary(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)");
    const visualStudioRange = inheritedChildVisualStudioRange(process.env.EMBER_LPAC_INHERITED_CHILD_RUNNER);
    const vswhere = path.join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe");
    const env: NodeJS.ProcessEnv = { SystemRoot: windows, WINDIR: windows, ComSpec: path.join(windows, "System32", "cmd.exe"),
      ProgramFiles: process.env.ProgramFiles ?? "C:\\Program Files", "ProgramFiles(x86)": programFiles, ProgramW6432: process.env.ProgramW6432 ?? "C:\\Program Files",
      SystemDrive: path.win32.parse(windows).root.slice(0, 2), PATH: `${path.join(windows, "System32")};${windows}`, PATHEXT: ".COM;.EXE;.BAT;.CMD",
      USERPROFILE: profile, APPDATA: path.join(profile, "Roaming"), LOCALAPPDATA: path.join(profile, "Local"), TEMP: temporaryBuild, TMP: temporaryBuild,
      PROCESSOR_ARCHITECTURE: "AMD64", NUMBER_OF_PROCESSORS: "2" };
      stage = 3;
      const selected = execFileSync(vswhere, ["-latest", "-version", visualStudioRange, "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
        { encoding: "utf8", env, timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 }).trim();
      stage = 4; const installation = ordinary(selected);
      for (const variant of INHERITED_CHILD_VARIANTS) {
        variantId = INHERITED_CHILD_VARIANTS.indexOf(variant) + 1; stage = 5;
        const source = ordinary(path.resolve("test/fixtures", variant === "explicit" ? "experimental-windows-lpac.c" : "experimental-windows-lpac-inherited.c"));
        const output = ordinary(path.join(build, `${variant}.exe`)), object = ordinary(path.join(build, `${variant}.obj`)), command = path.join(build, `${variant}.cmd`);
        fs.writeFileSync(command, `@echo off\r\ncall "${path.join(installation, "VC", "Auxiliary", "Build", "vcvars64.bat")}" >nul\r\nif errorlevel 1 exit /b 1\r\ncl.exe /nologo /O1 /GS- /Zl ${inheritedChildVariantDefine(variant)} /Fo"${object}" /Fe"${output}" "${source}" /link /NODEFAULTLIB /ENTRY:mainCRTStartup /SUBSYSTEM:CONSOLE kernel32.lib advapi32.lib\r\n`, { flag: "wx" });
        stage = 6;
        const built = spawnSync(env.ComSpec!, ["/d", "/s", "/c", `""${command}""`], { env, encoding: "utf8", timeout: 60_000,
          windowsHide: true, windowsVerbatimArguments: true, maxBuffer: 256 * 1024 });
        status = Number.isInteger(built.status) ? built.status : null;
        if (built.status !== 0 || built.error || built.signal) {
          diagnostic = built.error ? inheritedChildNumericFailure(built.error) : inheritedChildCompilerFailure((built.stdout ?? "") + (built.stderr ?? ""));
          throw fixedFailure();
        }
        stage = 7;
        const bytes = boundedRead(output, 16 * 1024 * 1024);
        if (!bytes || bytes.length < 2 || bytes.toString("ascii", 0, 2) !== "MZ") throw fixedFailure(); executables.set(variant, bytes);
      }
    } catch (error) {
      safeToRemove = false; if (!diagnostic.domain) diagnostic = inheritedChildNumericFailure(error);
      console.info("Inherited-child build refusal", JSON.stringify({ stage, variant: variantId, status, ...diagnostic, launchAttempted: false }));
      // eslint-disable-next-line preserve-caught-error -- Compiler/native errors may contain private paths; only the closed numeric receipt may leave this fixture.
      throw new Error("The fixed inherited-child fixture compilation failed; synthetic build scratch retained.");
    }
  }, 330_000); // Five independent compiler children retain their existing 60s limits, plus discovery/setup.
  afterAll(() => {
    for (const bytes of executables.values()) bytes.fill(0);
    if (root && safeToRemove) try { fs.rmSync(root, { recursive: true, force: true }); }
    catch { safeToRemove = false; throw new InheritedChildCleanupError(); }
  });

  async function run(variant: InheritedChildVariant) {
    if (retainedOwners.length) throw new InheritedChildCleanupError();
    let api: ReturnType<typeof loadExperimentalWindowsLpacApi>, observer: ReturnType<typeof loadInheritedChildObserver>, native: ReturnType<typeof nativeChecks>;
    try { api = loadExperimentalWindowsLpacApi(); observer = loadInheritedChildObserver(); native = nativeChecks(api); }
    catch (error) { if (error instanceof InheritedChildCleanupError) { safeToRemove = false; throw error; } throw fixedFailure(); }
    const executable = executables.get(variant)!;
    let profile: WindowsLpacProfile | undefined, job: WindowsHandle | undefined, process: WindowsSuspendedProcess | undefined, expectedLocalAppData = "";
    let parent = "";
    let fixture: ExperimentalWindowsLpacFixture;
    let preparationFailure: { operation: number; domain: number; code: number } | undefined;
    const prepareCall = <T,>(operation: number, call: () => T): T => {
      try { return call(); } catch (error) { preparationFailure ??= { operation, ...inheritedChildNumericFailure(error) }; throw error; }
    };
    try { parent = fs.mkdtempSync(path.join(root, `${variant}-`)); fixture = ExperimentalWindowsLpacFixture.prepare(parent, executable, { ...api,
        volumeFileSystem(value) { return prepareCall(1, () => api.volumeFileSystem(value)); },
        pinDirectory(value) { return prepareCall(2, () => api.pinDirectory(value)); },
        createProfile(name) { return prepareCall(3, () => { profile = api.createProfile(name); return profile; }); },
        ownerSid() { return prepareCall(4, () => api.ownerSid()); },
        createDirectory(...args) { return prepareCall(5, () => api.createDirectory(...args)); },
        writeNewFile(...args) { return prepareCall(6, () => api.writeNewFile(...args)); },
        close(value) { return prepareCall(7, () => api.close(value)); },
        deleteProfile(value) { return prepareCall(8, () => api.deleteProfile(value)); },
        createJob() { job = api.createJob(); return job; },
        createSuspended(...args) { process = api.createSuspended(...args); return process; },
        profileLocalAppDataBase(value) { const base = api.profileLocalAppDataBase(value); expectedLocalAppData = path.join(base, "Packages", value.name, "AC"); return base; },
      });
    } catch (error) {
      safeToRemove = false; retainedOwners.push({ api, observer, parent, profile, job, process });
      console.info("Inherited-child preparation refusal", JSON.stringify({ variant: INHERITED_CHILD_VARIANTS.indexOf(variant) + 1,
        ...(preparationFailure ?? { operation: 0, ...inheritedChildNumericFailure(error) }), launchAttempted: false }));
      throw fixedFailure();
    }
    let unsafe = false, stopped = false, failed = false, child: number | null = null, descendantRemained = false, hostOperation = 0;
    let imagePin: ReturnType<ReturnType<typeof nativeChecks>["pin"]> | undefined;
    let outcome: { mode: InheritedChildVariant; rootExit: number; report: number[] | null; failure: number[] | null; sdAccess: WindowsLpacChildSdDiagnostic | null;
      sdAccessInvalid: boolean; jobStopped: true; membersStopped: true; admitted: boolean; descendantRemained: boolean; profilePaths: boolean } | undefined;
    const previous = processEnvMarker();
    try {
      hostOperation = 1;
      imagePin = native.pin(fixture.paths.program, 16 * 1024 * 1024);
      const staged = boundedRead(fixture.paths.program, 16 * 1024 * 1024); if (!staged) throw fixedFailure();
      try { if (digest(staged) !== digest(executable)) throw fixedFailure(); imagePin.unchanged(); } finally { staged.fill(0); }
      api.writeNewFile(path.join(fixture.paths.root, "all-app-packages.txt"), Buffer.from("disposable LPAC canary"),
        `D:P(A;;FA;;;${api.ownerSid()})(A;;FA;;;SY)(A;;FR;;;AC)S:(ML;;NW;;;ME)`);
      expect(fs.readFileSync(path.join(fixture.paths.root, "all-app-packages.txt"), "utf8")).toBe("disposable LPAC canary");
      hostOperation = 2;
      await fixture.launch([String(globalThis.process.pid)]);
      if (!process || !job || !profile) throw fixedFailure();
      if (variant !== "explicit") {
        const deadline = performance.now() + 10_000;
        while (child === null) {
          hostOperation = 3;
          if (api.exited(process.process)) break; // A natural C denial is returned for explicit assertions, never treated as a successful admission.
          if (performance.now() >= deadline) throw fixedFailure();
          const exactProcess = process, exactJob = job, exactProfile = profile;
          hostOperation = 4;
          child = observer.admit({ job: exactJob, rootProcess: exactProcess.process, rootPid: exactProcess.pid, image: fixture.paths.program,
            current: () => { imagePin!.unchanged(); return !api.exited(exactProcess.process); }, verifyToken: value => {
              try { api.verifyToken(exactProfile, value); } catch { unsafe = true; throw fixedFailure(); }
            },
            grant: value => writeAdmission(path.join(fixture.paths.state, "child-admit.bin"), value) });
          if (child === null) await new Promise<void>(resolve => setTimeout(resolve, 10));
        }
      }
      hostOperation = 5;
      await fixture.waitRootExited(15_000);
      if (child !== null) {
        hostOperation = 6;
        const deadline = performance.now() + 15_000;
        let observed = false;
        while (!observed) {
          imagePin.unchanged(); observed = observer.observeDescendants();
          if (!observed) {
            if (performance.now() >= deadline) throw fixedFailure();
            await new Promise<void>(resolve => setTimeout(resolve, 10));
          }
        }
        const state = api.jobState(job);
        if (state.active !== state.listed || state.active < 1 || state.active > 8) throw fixedFailure();
        await expect(fixture.waitStopped(100)).rejects.toThrow("descendants");
        imagePin.unchanged(); descendantRemained = observer.observeDescendants();
        if (!descendantRemained) throw fixedFailure();
      }
    } catch (error) { failed = true; if (error instanceof InheritedChildCleanupError || error instanceof WindowsNodeProofCleanupError) unsafe = true; }
    finally {
      restoreEnvMarker(previous);
      try { const lease = await fixture.stop(15_000); lease.requireStopped(); observer.requireStopped(); stopped = true; } catch { unsafe = true; }
      if (stopped && !unsafe) try {
        imagePin?.unchanged();
        const rootExit = fixture.exitCode();
        outcome = inheritedChildReadout(rootExit, () => {
        const report = reportWords(path.join(fixture.paths.state, "report.bin"), 12), diagnostic = reportWords(path.join(fixture.paths.state, "failure.bin"), 25);
        let sdAccess: WindowsLpacChildSdDiagnostic | null = null, sdAccessInvalid = false;
        if (inheritedChildSuppliedSdDiagnostic(variant)) try {
          sdAccess = readWindowsLpacChildSdDiagnostic(rootExit, () => {
            const sdBytes = boundedRead(path.join(fixture.paths.state, "child-sd-access.bin"), WINDOWS_LPAC_CHILD_SD_BYTES);
            if (!sdBytes) return null;
            try { return parseWindowsLpacChildSdDiagnostic(sdBytes); } finally { sdBytes.fill(0); }
          });
        } catch (error) { if (error instanceof InheritedChildCleanupError) throw error; sdAccessInvalid = true; }
        let profilePaths = false;
        if (report) {
          profilePaths = true;
          for (const [name, expected] of [["local-app-data-path.txt", expectedLocalAppData], ["temp-path.txt", path.join(expectedLocalAppData, "Temp")]]) {
            const bytes = boundedRead(path.join(fixture.paths.state, name), 16 * 1024);
            try { profilePaths &&= !!bytes && bytes.toString("utf16le").toLowerCase() === expected.toLowerCase(); } finally { bytes?.fill(0); }
          }
        }
        return { mode: variant, rootExit, report, failure: diagnostic, sdAccess, sdAccessInvalid,
          jobStopped: true as const, membersStopped: true as const, admitted: child !== null, descendantRemained, profilePaths };
        });
      } catch (error) { failed = true; if (error instanceof InheritedChildCleanupError) unsafe = true; }
      if (!unsafe) try { observer.closeStopped(); } catch { unsafe = true; }
      if (!unsafe && imagePin) try { imagePin.unchanged(); imagePin.close(); imagePin = undefined; } catch { unsafe = true; }
      if (!unsafe) try { await fixture.close(); } catch { unsafe = true; }
      if (unsafe) { safeToRemove = false; retainedOwners.push({ fixture, profile, job, process, observer, parent, imagePin, native }); }
    }
    if (unsafe) throw new InheritedChildCleanupError();
    if (!outcome) throw fixedFailure();
    const sdAccessMissing = inheritedChildSuppliedSdDiagnostic(variant) && outcome.failure?.[0] === 18 && outcome.failure?.[24] !== 0xffffffff && !outcome.sdAccess;
    if (sdAccessMissing || outcome.sdAccessInvalid) failed = true;
    if (failed || outcome.failure) {
      console.info("Stopped inherited-child refusal", JSON.stringify({ mode: variant, rootExit: outcome.rootExit, jobStopped: true, stage: outcome.failure?.[0] ?? null,
        error: outcome.failure?.[1] ?? null, childNtStatus: outcome.failure?.[24] ?? null, hostOperation, observer: observer.observation(),
        childObjectAccess: outcome.sdAccess, sdAccessMissing, sdAccessInvalid: outcome.sdAccessInvalid,
        ...(outcome.failure ? { checks: outcome.failure.slice(2, 11), childPidRecorded: outcome.failure[11] !== 0,
          workAndTemp: outcome.failure.slice(12, 14), imageExecute: outcome.failure.slice(14, 16), selfCreateProcess: outcome.failure.slice(16, 18),
          childPolicy: outcome.failure.slice(18, 20), defaultDaclAccess: outcome.failure.slice(20, 24) } : {}) }));
    }
    if (failed) throw fixedFailure();
    return outcome;
  }
  it.each(["explicit", "inherited"] as const)("preserves the separately compiled %s denial as an observed control", async variant => {
    const result = await run(variant); expect(result.rootExit).toBe(18); expect(result.report === null).toBe(true);
    expect(result.failure?.slice(0, 2)).toEqual([18, 5]); expect(result.failure?.[24]).toBe(0xc0000022);
    expect(result.failure?.slice(2, 11)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]);
    expect(result.failure?.[11] === 0).toBe(true); expect(result.failure?.slice(12, 14)).toEqual([1, 0]);
    expect(result.admitted).toBe(false); expect(result.descendantRemained).toBe(false);
  }, 45_000);
  it.each(["aap-only", "aap-null-sa", "aap-detached"] as const)("admits only a suspended exact-package %s child and observes it outlive the root before Stop", async variant => {
    const result = await run(variant); expect(result.rootExit).toBe(0); expect(result.failure === null).toBe(true);
    expect(result.report?.slice(0, 9)).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1]); expect((result.report?.[9] ?? 0) > 0).toBe(true);
    expect(result.report?.slice(10)).toEqual([1, 1]);
    expect({ admitted: result.admitted, descendantRemained: result.descendantRemained, profilePaths: result.profilePaths,
      jobStopped: result.jobStopped, membersStopped: result.membersStopped }).toEqual({ admitted: true, descendantRemained: true, profilePaths: true, jobStopped: true, membersStopped: true });
    console.info("Stopped inherited child result", JSON.stringify({ mode: variant, rootExit: 0, jobStopped: true, membersStopped: true, admitted: true, descendantRemained: true, allChecks: true, profilePaths: true }));
  }, 45_000);
});

function processEnvMarker(): string | undefined { const old = process.env.GH_TOKEN; process.env.GH_TOKEN = "synthetic-inherited-child-marker"; return old; }
function restoreEnvMarker(previous: string | undefined): void { if (previous === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previous; }
