/** Separate source-built Node fixed-literal feasibility. Never an official-issuer override or project runner. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ExperimentalWindowsLpacFixture, experimentalWindowsEnvironment, experimentalWindowsSddl } from "../../app/main/agent/experimental-windows-lpac";
import { ExperimentalWindowsCreateUncertain, type WindowsHandle, type WindowsLpacApi, type WindowsLpacProfile, type WindowsSuspendedProcess } from "../../app/main/agent/experimental-windows-lpac-api";
import { nativeChecks, windowsNodeProofCommand, WindowsNodeProofCleanupError } from "./windows-node-lpac-proof";
import { loadWindowsNodeSourceChildIo, WindowsNodeSourceChildIoCleanupError } from "./windows-node-source-child-io";
import { WindowsNodeHostCleanupError } from "./windows-node-lpac-startup";
import { inspectWindowsNodeSourceFatalOutput } from "./windows-node-source-fatal";
import { parseWindowsNodeSourceChildReport, inspectWindowsNodeSourceTestOutput, type WindowsSourceNodeChildMode } from "./windows-node-source-child-report";
import { loadWindowsNodeSourceChildObserver } from "./windows-node-source-child-observer";
import { runWindowsNodeSourceChildHost } from "./windows-node-source-child-host";
import { readStoppedWindowsNodeSourceChildFailure } from "./windows-node-source-child-failure-read";
import { WindowsNodeSourceOwnership } from "./windows-node-source-ownership";
import { disposeWindowsLibuvProbe } from "./windows-libuv-probe-disposal";
import { loadWindowsLibuvHostIdentity, windowsLibuvHostIdentityFailure, type WindowsLibuvHostIdentity } from "./windows-libuv-host-identity";
// @ts-expect-error -- fixed trusted-host JavaScript build recipe
import { parseWindowsNodeSourceBuildReceipt } from "../../scripts/experimental/build-windows-node-source.mjs";
// @ts-expect-error -- fixed literal programs shared with the trusted build/run recipe
import { windowsNodeSourceChildPrograms, windowsNodeSourceChildProgramReceipts, WINDOWS_NODE_SOURCE_CHILD_ACK } from "./windows-node-source-child-program.mjs";
import sourcePin from "../../scripts/experimental/windows-node-source-pin.json";

export { parseWindowsNodeSourceBuildReceipt };

export class WindowsNodeSourceChildProbeCleanupError extends WindowsNodeHostCleanupError {
  constructor() { super(); this.name = "WindowsNodeSourceChildProbeCleanupError"; this.message = "The fixed source Node probe could not verify cleanup; retain its scratch and asset pins."; }
}
const uncertain = (error: unknown) => error instanceof WindowsNodeHostCleanupError || error instanceof WindowsNodeSourceChildIoCleanupError || error instanceof WindowsNodeProofCleanupError || error instanceof ExperimentalWindowsCreateUncertain;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const quarantinedProbeOwners: unknown[] = [];
type FixedChildOutput = Readonly<{ accepted: boolean; tests: 0 | 1; passed: 0 | 1 }>;
type FixedFailureReceipt = Readonly<{ phase: string;
  identityFailure?: ReturnType<typeof windowsLibuvHostIdentityFailure>;
  host?: Readonly<{ exitCode: number; jobStopped: true; reportState: "not-read" | "valid" | "absent" | "refused";
    identity?: WindowsLibuvHostIdentity;
    report: ReturnType<typeof parseWindowsNodeSourceChildReport> | null }> }>;
const failureReceipts = new WeakMap<object, FixedFailureReceipt>();
export function windowsSourceNodeChildFailureReceipt(error: unknown): FixedFailureReceipt | undefined {
  return error !== null && typeof error === "object" ? failureReceipts.get(error) : undefined;
}

function readBounded(file: string, maximum: number): Buffer {
  let fd: number | undefined, result: Buffer | undefined, failure: Error | undefined;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 0 || before.size > maximum) throw new Error();
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const opened = fs.fstatSync(fd), output = Buffer.alloc(before.size + 1);
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size) throw new Error();
    let read = 0;
    while (read < output.length) { const count = fs.readSync(fd, output, read, output.length - read, read); if (!count) break; read += count; }
    const after = fs.fstatSync(fd), observed = fs.lstatSync(file);
    if (read !== before.size || after.ino !== opened.ino || after.dev !== opened.dev || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs || !observed.isFile() || observed.nlink !== 1 || observed.ino !== opened.ino || observed.dev !== opened.dev) throw new Error();
    result = output.subarray(0, read);
  } catch { failure = new Error("The fixed source-Node probe input/report is not an unchanged bounded ordinary file."); }
  if (fd !== undefined) try { fs.closeSync(fd); } catch { result?.fill(0); throw new WindowsNodeSourceChildProbeCleanupError(); }
  if (failure) throw failure;
  if (!result) throw new Error("The fixed source-Node probe returned no bounded file bytes.");
  return result;
}

/** The inert setup image never executes; the legacy signed-stock redirect still performs its own exact verifier. */
export function readWindowsNodeSourceChildBootstrap(buildRoot: string, buildCommit: string): Buffer {
  if (quarantinedProbeOwners.length) throw new WindowsNodeSourceChildProbeCleanupError();
  try {
    const encoded = readBounded(path.join(buildRoot, "build-receipt.json"), 16 * 1024);
    let receipt: ReturnType<typeof parseWindowsNodeSourceBuildReceipt>;
    try { receipt = parseWindowsNodeSourceBuildReceipt(encoded, buildCommit); } finally { encoded.fill(0); }
    const record = receipt.assets.bootstrap, bytes = readBounded(path.join(buildRoot, record.name), 16 * 1024 * 1024);
    if (bytes.length !== record.bytes || digest(bytes) !== record.sha256) throw new Error("The inert setup image differs from its own receipt.");
    return bytes;
  } catch (error) {
    if (uncertain(error)) { quarantinedProbeOwners.push({ buildRoot }); throw new WindowsNodeSourceChildProbeCleanupError(); }
    // eslint-disable-next-line preserve-caught-error -- Filesystem/native causes can contain private scratch paths; only the fixed refusal is public.
    throw new Error("The fixed source-Node setup image could not be verified.");
  }
}

function pinAssetAncestors(file: string, api: WindowsLpacApi): WindowsHandle[] {
  const held: WindowsHandle[] = [];
  let acquisitionFailed = false;
  const hold = (directory: string) => {
    try { held.push(api.pinDirectory(directory)); }
    catch { acquisitionFailed = true; throw new WindowsNodeSourceChildProbeCleanupError(); }
  };
  try {
    if (!/^[A-Za-z]:\\/.test(file) || file.includes("/") || /[\0\r\n]/.test(file) || path.win32.normalize(file) !== file) throw new Error();
    const root = path.win32.parse(file).root;
    if (api.volumeFileSystem(root).toUpperCase() !== "NTFS") throw new Error();
    let current = root; hold(current);
    for (const part of path.win32.dirname(file).slice(root.length).split("\\").filter(Boolean)) {
      if (part === "." || part === ".." || /[:<>"|?*\p{Cc}\p{Cf}]/u.test(part) || /[. ]$/.test(part)) throw new Error();
      current = path.win32.join(current, part); hold(current);
    }
    if (fs.realpathSync.native(file).toLowerCase() !== file.toLowerCase()) throw new Error();
    return held;
  } catch {
    if (acquisitionFailed) { quarantinedProbeOwners.push({ directories: held, api }); throw new WindowsNodeSourceChildProbeCleanupError(); }
    for (const handle of held.slice().reverse()) try { api.close(handle); }
    catch { quarantinedProbeOwners.push({ directories: held, api }); throw new WindowsNodeSourceChildProbeCleanupError(); }
    throw new Error("The fixed source Node asset requires ordinary pinned local NTFS ancestry.");
  }
}

/** One fixed source-built Node pair. Output is released only after root exit, job zero and verified cleanup. */
export async function runWindowsSourceNodeChildProbe(input: { parent: string; buildRoot: string; buildCommit: string; runCommit: string; mode: WindowsSourceNodeChildMode }, api: WindowsLpacApi) {
  if (quarantinedProbeOwners.length) throw new WindowsNodeSourceChildProbeCleanupError();
  if (!/^[0-9a-f]{40}$/.test(input.buildCommit) || !/^[0-9a-f]{40}$/.test(input.runCommit) || input.mode !== "spawn" && input.mode !== "test")
    throw new Error("Select exact build, fixed-program commits and one reviewed child mode.");
  let native: ReturnType<typeof nativeChecks>;
  try { native = nativeChecks(api); } catch { throw new Error("The fixed source-Node probe native checks could not be bound."); }
  const directories: WindowsHandle[] = [], pins: ReturnType<typeof native.pin>[] = [], attemptedPins = new Set<object>();
  let fixture: ExperimentalWindowsLpacFixture | undefined, profile: WindowsLpacProfile | undefined, lpacProcess: WindowsSuspendedProcess | undefined;
  let io: ReturnType<typeof loadWindowsNodeSourceChildIo> | undefined, hostIo: ReturnType<typeof loadWindowsNodeSourceChildIo> | undefined, program = "", environment: Buffer | undefined;
  let phase = "receipt", lpacJob: WindowsHandle | undefined;
  const hostObserver = loadWindowsNodeSourceChildObserver(), lpacObserver = loadWindowsNodeSourceChildObserver();
  let hostAdmitted = false, lpacAdmitted = false;
  const grant = (role: 0 | 1) => {
    if (!fixture || !profile) throw new Error("No fixed child ACK fixture exists.");
    const file = path.join(fixture.paths.tools, `${role ? "lpac" : "host"}-source-child-${input.mode === "spawn" ? 1 : 2}-ack.bin`);
    controlled.writeNewFile(file, Buffer.from(WINDOWS_NODE_SOURCE_CHILD_ACK, "ascii"), experimentalWindowsSddl(controlled.ownerSid(), profile.sidText, "read", false));
    const pin = acquirePin(file, 64); pins.push(pin); pin.unchanged();
  };
  const argumentsFor = (role: "host" | "lpac") => input.mode === "spawn"
    ? ["--eval", windowsNodeSourceChildPrograms[role].spawn]
    : ["--test", path.join(fixture!.paths.tools, role + "-fixed-source-test.cjs")];
  let stoppedHost: { exitCode: number; jobStopped: true } | undefined, hostReportFact: ReturnType<typeof parseWindowsNodeSourceChildReport> | null = null;
  let hostIdentity: WindowsLibuvHostIdentity | undefined;
  let identityFailure: ReturnType<typeof windowsLibuvHostIdentityFailure>;
  let hostReportState: "not-read" | "valid" | "absent" | "refused" = "not-read";
  let unsafe = false, failure: { error: unknown } | undefined;
  const ownership = new WindowsNodeSourceOwnership();
  const issued = { directories: [] as WindowsHandle[], jobs: [] as WindowsHandle[], processes: [] as WindowsSuspendedProcess[], profileNames: [] as string[] };
  const owned = <T>(operation: () => T): T => {
    if (unsafe) throw new WindowsNodeSourceChildProbeCleanupError();
    try { return ownership.guard(operation); }
    catch { unsafe = true; throw new WindowsNodeSourceChildProbeCleanupError(); }
  };
  const acquirePin = (file: string, maximum: number) => owned(() => native.pin(file, maximum));
  let result: { issuer: string; buildCommit: string; runCommit: string; programs: ReturnType<typeof windowsNodeSourceChildProgramReceipts>; host: { exitCode: number; jobStopped: true; identity: WindowsLibuvHostIdentity; report: ReturnType<typeof parseWindowsNodeSourceChildReport> };
    lpac: { exitCode: number; jobStopped: true; report: ReturnType<typeof parseWindowsNodeSourceChildReport> | null; output: ReturnType<typeof inspectWindowsNodeSourceFatalOutput>; testOutput: FixedChildOutput;
      failure?: ReturnType<typeof readStoppedWindowsNodeSourceChildFailure> } } | undefined;
  const checkPins = () => { for (const pin of pins) pin.unchanged(); };
  const closePin = (pin: ReturnType<typeof native.pin>) => { if (attemptedPins.has(pin)) return; attemptedPins.add(pin); owned(() => pin.close()); };
  const controlled: WindowsLpacApi = { ...api,
    createProfile(name) { issued.profileNames.push(name); return owned(() => { const value = api.createProfile(name); profile = value; return value; }); },
    ownerSid: () => owned(() => api.ownerSid()),
    profileLocalAppDataBase: requested => owned(() => api.profileLocalAppDataBase(requested)),
    createDirectory: (file, security) => owned(() => api.createDirectory(file, security)),
    writeNewFile: (file, bytes, security) => owned(() => api.writeNewFile(file, bytes, security)),
    pinDirectory(file) { return owned(() => { const value = api.pinDirectory(file); issued.directories.push(value); return value; }); },
    createJob() { return owned(() => { const value = api.createJob(); issued.jobs.push(value); lpacJob = value; return value; }); },
    close: handle => owned(() => api.close(handle)),
    verifyToken: (requested, process) => owned(() => api.verifyToken(requested, process)),
    deleteProfile(requested) {
      owned(() => { hostIo?.close(); io?.close(); });
      owned(() => api.deleteProfile(requested));
    },
  };
  const readReport = (token: 0 | 1) => {
    if (!fixture) throw new Error("No fixed source-Node probe fixture was created.");
    const file = path.join(fixture.paths.state, `${token ? "lpac" : "host"}-source-child-${input.mode === "spawn" ? 1 : 2}-report.bin`);
    try { fs.lstatSync(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      // eslint-disable-next-line preserve-caught-error -- Filesystem errors can contain private paths; only the fixed phase leaves the fixture.
      throw new Error("The stopped fixed report could not be inspected.");
    }
    const pin = acquirePin(file, 64); pins.push(pin);
    const bytes = readBounded(file, 64); pin.unchanged();
    try { return parseWindowsNodeSourceChildReport(bytes, token, input.mode); }
    finally { bytes.fill(0); }
  };
  try {
    const receiptPath = path.join(input.buildRoot, "build-receipt.json");
    directories.push(...pinAssetAncestors(receiptPath, api));
    const receiptPin = acquirePin(receiptPath, 16 * 1024); pins.push(receiptPin);
    const receiptBytes = readBounded(receiptPath, 16 * 1024); receiptPin.unchanged();
    let receipt: ReturnType<typeof parseWindowsNodeSourceBuildReceipt>;
    try { receipt = parseWindowsNodeSourceBuildReceipt(receiptBytes, input.buildCommit); } finally { receiptBytes.fill(0); }
    const record = receipt.assets.node, assetPath = path.join(input.buildRoot, record.name);
    const bootstrapRecord = receipt.assets.bootstrap, bootstrapPath = path.join(input.buildRoot, bootstrapRecord.name);
    const bootstrapPin = acquirePin(bootstrapPath, 16 * 1024 * 1024); pins.push(bootstrapPin);
    const bootstrapBytes = readBounded(bootstrapPath, 16 * 1024 * 1024); bootstrapPin.unchanged();
    if (bootstrapBytes.length !== bootstrapRecord.bytes || digest(bootstrapBytes) !== bootstrapRecord.sha256) throw new Error("The inert bootstrap differs from its own build receipt.");
    phase = "asset";
    const source = acquirePin(assetPath, 128 * 1024 * 1024); pins.push(source);
    const bytes = readBounded(assetPath, 128 * 1024 * 1024); source.unchanged();
    if (bytes.length !== record.bytes || digest(bytes) !== record.sha256) throw new Error("The fixed source Node executable differs from its own build receipt.");
    phase = "prepare";
    fixture = ExperimentalWindowsLpacFixture.prepare(input.parent, bootstrapBytes, { ...controlled,
      createSuspended(requested, file, command, cwd, env) {
        if (!io || !profile || !fixture || requested.sidText !== profile.sidText || file !== fixture.paths.program || !command.equals(windowsNodeProofCommand(fixture.paths.program, [])) ||
          cwd !== fixture.paths.work || !environment || !env.equals(environment)) throw new Error("The fixed source Node launcher refused an unexpected input.");
        checkPins();
        try { lpacProcess = io.createLpac(requested, program, windowsNodeProofCommand(program, argumentsFor("lpac")), cwd, env); issued.processes.push(lpacProcess); return lpacProcess; }
        catch (error) { if (uncertain(error)) unsafe = true; throw error; }
      },
      verifyToken(requested, process) {
        if (!lpacProcess || process !== lpacProcess.process || !profile || requested.sidText !== profile.sidText) throw new Error("No exact fixed-probe process identity is available.");
        controlled.verifyToken(requested, process); owned(() => native.image(process, lpacProcess!.pid, program)); checkPins();
        if (!lpacJob) throw new Error("No exact private source child job is available.");
        lpacObserver.bind({ job: lpacJob, rootProcess: process, rootPid: lpacProcess.pid, image: program,
          current: () => { checkPins(); return !unsafe; }, verifyToken: child => { controlled.verifyToken(requested, child); },
          grant: () => { grant(1); lpacAdmitted = true; } });
      },
    });
    if (!profile) throw new Error("The fixed source-Node probe has no fresh package identity.");
    program = path.join(fixture.paths.tools, "source-node.exe");
    controlled.writeNewFile(program, bytes, experimentalWindowsSddl(controlled.ownerSid(), profile.sidText, "read", false));
    const stagedPin = acquirePin(program, 128 * 1024 * 1024); pins.push(stagedPin);
    const stagedBytes = readBounded(program, 128 * 1024 * 1024);
    try {
      stagedPin.unchanged();
      if (stagedBytes.length !== record.bytes || digest(stagedBytes) !== record.sha256) throw new Error("The staged fixed source-Node probe differs from its verified build asset.");
    } finally { stagedBytes.fill(0); }
    for (const role of ["host", "lpac"] as const) {
      const file = path.join(fixture.paths.tools, role + "-fixed-source-test.cjs");
      const literal = Buffer.from(windowsNodeSourceChildPrograms[role].test, "utf8");
      controlled.writeNewFile(file, literal, experimentalWindowsSddl(controlled.ownerSid(), profile.sidText, "read", false));
      const pin = acquirePin(file, 16 * 1024); pins.push(pin);
      const staged = readBounded(file, 16 * 1024);
      try { pin.unchanged(); if (!staged.equals(literal)) throw new Error("The staged fixed test literal differs."); }
      finally { staged.fill(0); literal.fill(0); }
    }
    environment = experimentalWindowsEnvironment(fixture.paths, api.windowsDirectory(), controlled.profileLocalAppDataBase(profile));
    const hostState = path.join(fixture.paths.state, "host-stdio"), lpacState = path.join(fixture.paths.state, "lpac-stdio");
    for (const directory of [hostState, lpacState]) {
      controlled.createDirectory(directory, experimentalWindowsSddl(controlled.ownerSid(), profile.sidText, "modify", true));
      directories.push(controlled.pinDirectory(directory));
    }
    hostIo = owned(() => loadWindowsNodeSourceChildIo(hostState, profile!, controlled, "host"));
    io = owned(() => loadWindowsNodeSourceChildIo(lpacState, profile!, controlled, "lpac"));
    const prepared = fixture, ownedIo = io;
    phase = "host";
    // The LPAC copy is deliberately LOW-labelled. The independent ordinary-host control uses the same verified
    // bytes at their pinned original build path so that staging does not lower the control's token integrity.
    const host = await runWindowsNodeSourceChildHost({ program: assetPath, command: windowsNodeProofCommand(assetPath, argumentsFor("host")), cwd: prepared.paths.work, environment,
      unchanged: checkPins }, controlled, {
      create(...args) { phase = "host-create"; const created = hostIo!.createHost(...args); issued.processes.push(created); phase = "host-created"; return created; },
      verify(created, expected) {
        phase = "host-image"; owned(() => native.image(created.process, created.pid, expected));
        phase = "host-identity"; hostIdentity = loadWindowsLibuvHostIdentity().inspect(created.process);
        if (hostIdentity.parent.appContainer !== 0 || hostIdentity.host.appContainer !== 0) throw new Error("The fixed host control requires ordinary parent and child tokens.");
        phase = "host-running";
      },
      bind(job, created) {
        hostObserver.bind({ job, rootProcess: created.process, rootPid: created.pid, image: assetPath,
          current: () => { checkPins(); return !unsafe; },
          verifyToken(child) {
            const identity = loadWindowsLibuvHostIdentity().inspect(child);
            if (!identity.sameUser || identity.parent.appContainer !== 0 || identity.host.appContainer !== 0 ||
                identity.parent.integrityRid !== identity.host.integrityRid || identity.parent.hasRestrictingSids !== identity.host.hasRestrictingSids)
              throw new Error("The fixed host child changed ordinary context.");
          }, grant: () => { grant(0); hostAdmitted = true; } });
      },
    }, hostObserver);
    stoppedHost = host; phase = "host-report"; hostReportState = "refused";
    const hostReport = readReport(0);
    hostReportFact = hostReport; hostReportState = hostReport ? "valid" : "absent";
    phase = "host-outcome";
    if (host.exitCode !== 0 || !hostIdentity || !hostIdentity.sameUser ||
        hostIdentity.parent.integrityRid !== hostIdentity.host.integrityRid ||
        hostIdentity.parent.hasRestrictingSids !== hostIdentity.host.hasRestrictingSids ||
        !hostReport || hostReport.complete !== true) throw new Error("The fixed source Node host supplied no complete ordinary-context useful-work witness.");
    phase = "host-stdio";
    const hostBytes = hostIo.readAfterStopped(() => { if (host.exitCode !== 0 || host.jobStopped !== true) throw new Error("No successful stopped host."); });
    let hostOutput;
    try { hostOutput = input.mode === "test" ? inspectWindowsNodeSourceTestOutput(hostBytes) : { accepted: hostBytes.length === 0, tests: 0, passed: 0 }; }
    finally { hostBytes.fill(0); }
    if (!hostOutput.accepted) throw new Error("The fixed source child host output was refused.");
    // The same suspended handle is checked for exact image/PID before the fixture can resume it.
    phase = "lpac";
    const createdPid = await prepared.launch();
    if (!lpacProcess || createdPid !== lpacProcess.pid) throw new Error("The fixed source-Node probe returned no exact native PID.");
    const until = performance.now() + 20_000;
    while (!lpacAdmitted && lpacProcess && !api.exited(lpacProcess.process)) {
      lpacObserver.admit();
      if (performance.now() > until) throw new Error("The fixed source child exceeded its observation deadline.");
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
    await prepared.waitRootExited(Math.max(1, until - performance.now()));
    const deadline = performance.now() + 15_000;
    const lease = await prepared.waitStopped(15_000); lease.requireStopped(); lpacObserver.waitStoppedBefore(deadline);
    const exitCode = prepared.exitCode();
    phase = "stopped-output";
    const outputBytes = ownedIo.readAfterStopped(() => { prepared.exitCode(); });
    let output: ReturnType<typeof inspectWindowsNodeSourceFatalOutput>, testOutput: FixedChildOutput;
    try {
      output = inspectWindowsNodeSourceFatalOutput(outputBytes);
      testOutput = exitCode === 0 && lpacAdmitted
        ? input.mode === "test" ? inspectWindowsNodeSourceTestOutput(outputBytes) : { accepted: outputBytes.length === 0, tests: 0, passed: 0 }
        : { accepted: false, tests: 0, passed: 0 };
    } finally { outputBytes.fill(0); }
    const lpacReport = exitCode === 0 && lpacAdmitted ? readReport(1) : null;
    const childFailure = exitCode !== 0 ? readStoppedWindowsNodeSourceChildFailure({ role: 1, mode: input.mode,
      requireStopped() {
        if (unsafe || ownership.unsafe) throw new WindowsNodeSourceChildProbeCleanupError();
        lease.requireStopped(); lpacObserver.requireStopped(); checkPins();
      },
      readFrame(basename, maximum) {
        const file = path.join(prepared.paths.state, basename);
        try {
          const stat = fs.lstatSync(file);
          if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== maximum) return null;
        } catch (error) {
          if (error !== null && typeof error === "object" && Object.getOwnPropertyDescriptor(error, "code")?.value === "ENOENT") return null;
          // eslint-disable-next-line preserve-caught-error -- Filesystem causes may contain private paths; only a fixed refusal may leave this diagnostic.
          throw new Error("The fixed stopped child failure file could not be inspected.");
        }
        const pin = acquirePin(file, maximum); pins.push(pin);
        const bytes = readBounded(file, maximum);
        try { owned(() => pin.unchanged()); return bytes; } catch (error) { bytes.fill(0); throw error; }
      },
    }) : undefined;
    if (!hostAdmitted) throw new Error("The fixed source child supplied no ordinary token observation.");
    checkPins();
    result = { issuer: sourcePin.issuer, buildCommit: input.buildCommit, runCommit: input.runCommit, programs: windowsNodeSourceChildProgramReceipts(),
      host: { ...host, identity: hostIdentity, report: hostReport }, lpac: { exitCode, jobStopped: true, report: lpacReport, output, testOutput,
        ...(childFailure === undefined ? {} : { failure: childFailure }) } };
  } catch (error) {
    identityFailure = windowsLibuvHostIdentityFailure(error);
    if (uncertain(error) || phase === "prepare" && !fixture) unsafe = true;
    failure = { error: uncertain(error) ? error : new Error(`The fixed source Node probe failed during ${phase}.`) };
  }
  finally {
    unsafe = await disposeWindowsLibuvProbe({ unsafe, lpacCreated: lpacProcess !== undefined,
      async stopLpac() { if (fixture && lpacProcess) {
        const deadline = performance.now() + 15_000;
        const lease = await fixture.stop(15_000); lease.requireStopped(); lpacObserver.waitStoppedBefore(deadline);
      } },
      async closeFixture() {
        if (fixture && lpacProcess) {
          const deadline = performance.now() + 15_000;
          const stopped = await fixture.stop(15_000); stopped.requireStopped(); lpacObserver.waitStoppedBefore(deadline);
          lpacObserver.closeStopped();
        }
        if (fixture) await fixture.close();
      },
      releasePins() { for (const pin of pins.slice().reverse()) closePin(pin); for (const handle of directories.slice().reverse()) owned(() => api.close(handle)); },
    });
    if (unsafe) quarantinedProbeOwners.push({ fixture, profile, io, hostIo, pins, directories, lpacProcess, issued, ownership, native, hostObserver, lpacObserver, parent: input.parent });
  }
  if (unsafe) throw new WindowsNodeSourceChildProbeCleanupError();
  if (failure) {
    if (failure.error !== null && typeof failure.error === "object") failureReceipts.set(failure.error, Object.freeze({ phase,
      ...(identityFailure ? { identityFailure } : {}),
      ...(stoppedHost ? { host: Object.freeze({ ...stoppedHost, ...(hostIdentity ? { identity: hostIdentity } : {}), reportState: hostReportState, report: hostReportFact }) } : {}) }));
    throw failure.error;
  }
  if (!result) throw new Error("The fixed source Node probe returned no stopped numeric result.");
  return result;
}
