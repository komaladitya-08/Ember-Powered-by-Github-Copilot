/** Separate fixed in-process test pair using the unchanged source image. No official issuer or project runner. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ExperimentalWindowsLpacFixture, experimentalWindowsEnvironment, experimentalWindowsSddl } from "../../app/main/agent/experimental-windows-lpac";
import { ExperimentalWindowsCreateUncertain, type WindowsHandle, type WindowsLpacApi, type WindowsLpacProfile, type WindowsSuspendedProcess } from "../../app/main/agent/experimental-windows-lpac-api";
import { nativeChecks, windowsNodeProofCommand, WindowsNodeProofCleanupError } from "./windows-node-lpac-proof";
import { loadWindowsNodeIo, WindowsNodeIoCleanupError } from "./windows-node-lpac-io";
import { runWindowsNodeHostStartup, WindowsNodeHostCleanupError } from "./windows-node-lpac-startup";
import { parseWindowsNodeCngInprocessReport } from "./windows-node-cng-inprocess-report";
import { WindowsNodeSourceOwnership } from "./windows-node-source-ownership";
import { disposeWindowsLibuvProbe } from "./windows-libuv-probe-disposal";
import { loadWindowsLibuvHostIdentity, windowsLibuvHostIdentityFailure, type WindowsLibuvHostIdentity } from "./windows-libuv-host-identity";
// @ts-expect-error -- fixed trusted-host JavaScript build recipe
import { parseWindowsNodeSourceBuildReceipt } from "../../scripts/experimental/build-windows-node-source.mjs";
// @ts-expect-error -- fixed literal programs shared with the trusted build/run recipe
import { windowsNodeCngInprocessPrograms, windowsNodeCngInprocessProgramReceipts, WINDOWS_NODE_CNG_INPROCESS_MODULE } from "./windows-node-cng-inprocess-program.mjs";
import artifactPin from "../../scripts/experimental/windows-node-cng-artifact-pin.json";
import { classifyWindowsNodeCngInprocessOutput } from "./windows-node-cng-inprocess-output";
import { windowsNodeCngInprocessTestRoute } from "./windows-node-cng-inprocess-route";

export const WINDOWS_NODE_CNG_PRESERVE_ISSUER = "ember-experimental-source-node-cng-preserve";
/** Fixed explicit invocation; never appended to a user command or npm script. */
export const WINDOWS_NODE_CNG_PRESERVE_FLAGS = Object.freeze(["--no-warnings", "--experimental-test-isolation=none", "--preserve-symlinks", "--preserve-symlinks-main", "--test-reporter=tap"] as const);

export { parseWindowsNodeSourceBuildReceipt };

export class WindowsNodeCngPreserveCleanupError extends WindowsNodeHostCleanupError {
  constructor() { super(); this.name = "WindowsNodeCngPreserveCleanupError"; this.message = "The fixed source Node in-process probe could not verify cleanup; retain its scratch and asset pins."; }
}
const uncertain = (error: unknown) => error instanceof WindowsNodeHostCleanupError || error instanceof WindowsNodeIoCleanupError || error instanceof WindowsNodeProofCleanupError || error instanceof ExperimentalWindowsCreateUncertain;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const quarantinedProbeOwners: unknown[] = [];
type FixedFailureReceipt = Readonly<{ phase: string;
  identityFailure?: ReturnType<typeof windowsLibuvHostIdentityFailure>;
  host?: Readonly<{ exitCode: number; jobStopped: true; reportState: "not-read" | "valid" | "absent" | "refused";
    identity?: WindowsLibuvHostIdentity;
    report: ReturnType<typeof parseWindowsNodeCngInprocessReport> | null }> }>;
const failureReceipts = new WeakMap<object, FixedFailureReceipt>();
export function windowsNodeCngPreserveFailureReceipt(error: unknown): FixedFailureReceipt | undefined {
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
  } catch { failure = new Error("The fixed source-Node in-process probe input/report is not an unchanged bounded ordinary file."); }
  if (fd !== undefined) try { fs.closeSync(fd); } catch { result?.fill(0); throw new WindowsNodeCngPreserveCleanupError(); }
  if (failure) throw failure;
  if (!result) throw new Error("The fixed source-Node in-process probe returned no bounded file bytes.");
  return result;
}

/** The inert setup image never executes; the legacy signed-stock redirect still performs its own exact verifier. */
export function readWindowsNodeCngPreserveBootstrap(buildRoot: string, buildCommit: string): Buffer {
  if (quarantinedProbeOwners.length) throw new WindowsNodeCngPreserveCleanupError();
  try {
    if (buildCommit !== artifactPin.compileCommit) throw new Error();
    const encoded = readBounded(path.join(buildRoot, "build-receipt.json"), 16 * 1024);
    let receipt: ReturnType<typeof parseWindowsNodeSourceBuildReceipt>;
    try {
      if (encoded.length !== artifactPin.verifiedFiles["build-receipt.json"].bytes || digest(encoded) !== artifactPin.verifiedFiles["build-receipt.json"].sha256) throw new Error();
      receipt = parseWindowsNodeSourceBuildReceipt(encoded, buildCommit);
    } finally { encoded.fill(0); }
    const record = receipt.assets.bootstrap, bytes = readBounded(path.join(buildRoot, record.name), 16 * 1024 * 1024);
    if (bytes.length !== record.bytes || digest(bytes) !== record.sha256 || record.bytes !== artifactPin.verifiedFiles["bootstrap.exe"].bytes ||
        record.sha256 !== artifactPin.verifiedFiles["bootstrap.exe"].sha256) throw new Error("The inert setup image differs from the immutable CNG build.");
    return bytes;
  } catch (error) {
    if (uncertain(error)) { quarantinedProbeOwners.push({ buildRoot }); throw new WindowsNodeCngPreserveCleanupError(); }
    // eslint-disable-next-line preserve-caught-error -- Filesystem/native causes can contain private scratch paths; only the fixed refusal is public.
    throw new Error("The fixed source-Node in-process setup image could not be verified.");
  }
}

function pinAssetAncestors(file: string, api: WindowsLpacApi): WindowsHandle[] {
  const held: WindowsHandle[] = [];
  let acquisitionFailed = false;
  const hold = (directory: string) => {
    try { held.push(api.pinDirectory(directory)); }
    catch { acquisitionFailed = true; throw new WindowsNodeCngPreserveCleanupError(); }
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
    if (acquisitionFailed) { quarantinedProbeOwners.push({ directories: held, api }); throw new WindowsNodeCngPreserveCleanupError(); }
    for (const handle of held.slice().reverse()) try { api.close(handle); }
    catch { quarantinedProbeOwners.push({ directories: held, api }); throw new WindowsNodeCngPreserveCleanupError(); }
    throw new Error("The fixed source Node in-process asset requires ordinary pinned local NTFS ancestry.");
  }
}

/** One fixed source-built Node pair. Output is released only after root exit, job zero and verified cleanup. */
export async function runWindowsNodeCngPreserveProbe(input: { parent: string; buildRoot: string; buildCommit: string; runCommit: string }, api: WindowsLpacApi) {
  if (quarantinedProbeOwners.length) throw new WindowsNodeCngPreserveCleanupError();
  if (input.buildCommit !== artifactPin.compileCommit || !/^[0-9a-f]{40}$/.test(input.runCommit)) throw new Error("Select the exact existing CNG build and current fixed-program commit.");
  let native: ReturnType<typeof nativeChecks>;
  try { native = nativeChecks(api); } catch { throw new Error("The fixed source-Node in-process probe native checks could not be bound."); }
  const directories: WindowsHandle[] = [], pins: ReturnType<typeof native.pin>[] = [], attemptedPins = new Set<object>();
  let fixture: ExperimentalWindowsLpacFixture | undefined, profile: WindowsLpacProfile | undefined, lpacProcess: WindowsSuspendedProcess | undefined;
  let io: ReturnType<typeof loadWindowsNodeIo> | undefined, program = "", environment: Buffer | undefined;
  let routes: Readonly<Record<"host" | "lpac", ReturnType<typeof windowsNodeCngInprocessTestRoute>>> | undefined;
  let phase = "receipt";
  let stoppedHost: { exitCode: number; jobStopped: true } | undefined, hostReportFact: ReturnType<typeof parseWindowsNodeCngInprocessReport> | null = null;
  let hostIdentity: WindowsLibuvHostIdentity | undefined;
  let identityFailure: ReturnType<typeof windowsLibuvHostIdentityFailure>;
  let hostReportState: "not-read" | "valid" | "absent" | "refused" = "not-read";
  let unsafe = false, failure: { error: unknown } | undefined;
  const ownership = new WindowsNodeSourceOwnership();
  const issued = { directories: [] as WindowsHandle[], jobs: [] as WindowsHandle[], processes: [] as WindowsSuspendedProcess[], profileNames: [] as string[] };
  const owned = <T>(operation: () => T): T => {
    if (unsafe) throw new WindowsNodeCngPreserveCleanupError();
    try { return ownership.guard(operation); }
    catch { unsafe = true; throw new WindowsNodeCngPreserveCleanupError(); }
  };
  const acquirePin = (file: string, maximum: number) => owned(() => native.pin(file, maximum));
  let result: { issuer: string; buildCommit: string; runCommit: string; programs: ReturnType<typeof windowsNodeCngInprocessProgramReceipts>; host: { exitCode: number; jobStopped: true; identity: WindowsLibuvHostIdentity; report: ReturnType<typeof parseWindowsNodeCngInprocessReport> };
    lpac: { exitCode: number; jobStopped: true; report: ReturnType<typeof parseWindowsNodeCngInprocessReport> | null; output: Readonly<{ bytes: number; empty: boolean; discovery: 0 | 1 }> } } | undefined;
  const checkPins = () => { for (const pin of pins) owned(() => pin.unchanged()); };
  const closePin = (pin: ReturnType<typeof native.pin>) => { if (attemptedPins.has(pin)) return; attemptedPins.add(pin); owned(() => pin.close()); };
  const controlled: WindowsLpacApi = { ...api,
    createProfile(name) { issued.profileNames.push(name); return owned(() => { const value = api.createProfile(name); profile = value; return value; }); },
    ownerSid: () => owned(() => api.ownerSid()),
    profileLocalAppDataBase: requested => owned(() => api.profileLocalAppDataBase(requested)),
    createDirectory: (file, security) => owned(() => api.createDirectory(file, security)),
    writeNewFile: (file, bytes, security) => owned(() => api.writeNewFile(file, bytes, security)),
    pinDirectory(file) { return owned(() => { const value = api.pinDirectory(file); issued.directories.push(value); return value; }); },
    createJob() { return owned(() => { const value = api.createJob(); issued.jobs.push(value); return value; }); },
    close: handle => owned(() => api.close(handle)),
    verifyToken: (requested, process) => owned(() => api.verifyToken(requested, process)),
    deleteProfile(requested) {
      owned(() => { io?.close(); });
      owned(() => api.deleteProfile(requested));
    },
  };
  const argumentsFor = (role: "host" | "lpac") => {
    if (!fixture || !routes) throw new Error("No fixed in-process fixture exists.");
    return [...WINDOWS_NODE_CNG_PRESERVE_FLAGS,
      `--test-reporter-destination=${path.join(fixture.paths.state, `${role}-cng-inprocess.tap`)}`, "--test",
      routes[role].pattern];
  };
  const readReport = (token: 0 | 1) => {
    if (!fixture) throw new Error("No fixed source-Node in-process probe fixture was created.");
    const file = path.join(fixture.paths.state, token ? "lpac-cng-inprocess-report.bin" : "host-cng-inprocess-report.bin");
    try { fs.lstatSync(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      // eslint-disable-next-line preserve-caught-error -- Filesystem errors can contain private paths; only the fixed phase leaves the fixture.
      throw new Error("The stopped fixed report could not be inspected.");
    }
    const pin = acquirePin(file, 64); pins.push(pin);
    const bytes = readBounded(file, 64);
    try { owned(() => pin.unchanged()); return parseWindowsNodeCngInprocessReport(bytes, token); }
    finally { bytes.fill(0); }
  };
  try {
    const receiptPath = path.join(input.buildRoot, "build-receipt.json");
    directories.push(...pinAssetAncestors(receiptPath, api));
    const receiptPin = acquirePin(receiptPath, 16 * 1024); pins.push(receiptPin);
    const receiptBytes = readBounded(receiptPath, 16 * 1024); owned(() => receiptPin.unchanged());
    let receipt: ReturnType<typeof parseWindowsNodeSourceBuildReceipt>;
    try {
      if (receiptBytes.length !== artifactPin.verifiedFiles["build-receipt.json"].bytes || digest(receiptBytes) !== artifactPin.verifiedFiles["build-receipt.json"].sha256)
        throw new Error("The source receipt differs from the immutable CNG artifact.");
      receipt = parseWindowsNodeSourceBuildReceipt(receiptBytes, input.buildCommit);
    } finally { receiptBytes.fill(0); }
    const record = receipt.assets.node, assetPath = path.join(input.buildRoot, record.name);
    const bootstrapRecord = receipt.assets.bootstrap, bootstrapPath = path.join(input.buildRoot, bootstrapRecord.name);
    const bootstrapPin = acquirePin(bootstrapPath, 16 * 1024 * 1024); pins.push(bootstrapPin);
    const bootstrapBytes = readBounded(bootstrapPath, 16 * 1024 * 1024); owned(() => bootstrapPin.unchanged());
    if (bootstrapBytes.length !== bootstrapRecord.bytes || digest(bootstrapBytes) !== bootstrapRecord.sha256 ||
        bootstrapRecord.bytes !== artifactPin.verifiedFiles["bootstrap.exe"].bytes || bootstrapRecord.sha256 !== artifactPin.verifiedFiles["bootstrap.exe"].sha256)
      throw new Error("The inert bootstrap differs from the immutable CNG build.");
    phase = "asset";
    const source = acquirePin(assetPath, 128 * 1024 * 1024); pins.push(source);
    const bytes = readBounded(assetPath, 128 * 1024 * 1024); owned(() => source.unchanged());
    if (bytes.length !== record.bytes || digest(bytes) !== record.sha256 || record.bytes !== artifactPin.verifiedFiles["source-node.exe"].bytes ||
        record.sha256 !== artifactPin.verifiedFiles["source-node.exe"].sha256) throw new Error("The source image differs from the immutable CNG build.");
    phase = "prepare";
    fixture = ExperimentalWindowsLpacFixture.prepare(input.parent, bootstrapBytes, { ...controlled,
      createSuspended(requested, file, command, cwd, env) {
        if (!io || !profile || !fixture || requested.sidText !== profile.sidText || file !== fixture.paths.program || !command.equals(windowsNodeProofCommand(fixture.paths.program, [])) ||
          cwd !== fixture.paths.work || !environment || !env.equals(environment)) throw new Error("The fixed source Node in-process launcher refused an unexpected input.");
        checkPins();
        try { lpacProcess = io.createLpac(requested, program, windowsNodeProofCommand(program, argumentsFor("lpac")), cwd, env); issued.processes.push(lpacProcess); return lpacProcess; }
        catch (error) { if (uncertain(error)) unsafe = true; throw error; }
      },
      verifyToken(requested, process) {
        if (!lpacProcess || process !== lpacProcess.process || !profile || requested.sidText !== profile.sidText) throw new Error("No exact fixed-probe process identity is available.");
        controlled.verifyToken(requested, process); native.image(process, lpacProcess.pid, program); checkPins();
      },
    });
    if (!profile) throw new Error("The fixed source-Node in-process probe has no fresh package identity.");
    routes = Object.freeze({ host: windowsNodeCngInprocessTestRoute(fixture.paths.work, fixture.paths.tools, "host"),
      lpac: windowsNodeCngInprocessTestRoute(fixture.paths.work, fixture.paths.tools, "lpac") });
    program = path.join(fixture.paths.tools, "source-node.exe");
    controlled.writeNewFile(program, bytes, experimentalWindowsSddl(controlled.ownerSid(), profile.sidText, "read", false));
    const stagedPin = acquirePin(program, 128 * 1024 * 1024); pins.push(stagedPin);
    const stagedBytes = readBounded(program, 128 * 1024 * 1024);
    try {
      owned(() => stagedPin.unchanged());
      if (stagedBytes.length !== record.bytes || digest(stagedBytes) !== record.sha256) throw new Error("The staged fixed source-Node in-process probe differs from its verified build asset.");
    } finally { stagedBytes.fill(0); }
    for (const role of ["host", "lpac"] as const) {
      const file = routes[role].file, data = Buffer.from(windowsNodeCngInprocessPrograms[role], "utf8");
      if (data.length < 1 || data.length > 16 * 1024) throw new Error("The fixed in-process test file exceeds its limit.");
      controlled.writeNewFile(file, data, experimentalWindowsSddl(controlled.ownerSid(), profile.sidText, "read", false));
      pins.push(acquirePin(file, 16 * 1024)); data.fill(0);
    }
    const copied = path.join(fixture.paths.work, "cng-inprocess-copied.cjs"), moduleBytes = Buffer.from(WINDOWS_NODE_CNG_INPROCESS_MODULE, "utf8");
    controlled.writeNewFile(copied, moduleBytes, experimentalWindowsSddl(controlled.ownerSid(), profile.sidText, "read", false));
    pins.push(acquirePin(copied, 64)); moduleBytes.fill(0);
    environment = experimentalWindowsEnvironment(fixture.paths, api.windowsDirectory(), controlled.profileLocalAppDataBase(profile));
    io = loadWindowsNodeIo(fixture.paths.state, profile, controlled);
    const prepared = fixture, ownedIo = io;
    phase = "host";
    // The LPAC copy is deliberately LOW-labelled. The independent ordinary-host control uses the same verified
    // bytes at their pinned original build path so that staging does not lower the control's token integrity.
    const host = await runWindowsNodeHostStartup({ program: assetPath, command: windowsNodeProofCommand(assetPath, argumentsFor("host")), cwd: prepared.paths.work, environment,
      unchanged: checkPins }, controlled, {
      create(...args) { phase = "host-create"; const created = ownedIo.createHost(...args); issued.processes.push(created); phase = "host-created"; return created; },
      verify(created, expected) {
        phase = "host-image"; native.image(created.process, created.pid, expected);
        phase = "host-identity"; hostIdentity = loadWindowsLibuvHostIdentity().inspect(created.process);
        if (hostIdentity.parent.appContainer !== 0 || hostIdentity.host.appContainer !== 0) throw new Error("The fixed host control requires ordinary parent and child tokens.");
        phase = "host-running";
      },
    });
    stoppedHost = host; phase = "host-report"; hostReportState = "refused";
    const hostReport = readReport(0);
    hostReportFact = hostReport; hostReportState = hostReport ? "valid" : "absent";
    phase = "host-outcome";
    if (host.exitCode !== 0 || !hostIdentity || !hostIdentity.sameUser ||
        hostIdentity.parent.integrityRid !== hostIdentity.host.integrityRid ||
        hostIdentity.parent.hasRestrictingSids !== hostIdentity.host.hasRestrictingSids ||
        !hostReport || hostReport.status !== 1) throw new Error("The fixed source Node in-process host supplied no complete ordinary-context useful-work witness.");
    phase = "host-stdio"; ownedIo.acceptHostControl();
    // The same suspended handle is checked for exact image/PID before the fixture can resume it.
    phase = "lpac";
    const createdPid = await prepared.launch();
    if (!lpacProcess || createdPid !== lpacProcess.pid) throw new Error("The fixed source-Node in-process probe returned no exact native PID.");
    await prepared.waitRootExited(20_000);
    const lease = await prepared.waitStopped(15_000); lease.requireStopped();
    const exitCode = prepared.exitCode();
    phase = "stopped-output";
    const outputBytes = ownedIo.readAfterStopped(() => { prepared.exitCode(); });
    let output: Readonly<{ bytes: number; empty: boolean; discovery: 0 | 1 }>;
    try { output = Object.freeze({ bytes: outputBytes.length, empty: outputBytes.length === 0,
      discovery: classifyWindowsNodeCngInprocessOutput(outputBytes, routes.lpac.file, routes.lpac.pattern) }); }
    finally { outputBytes.fill(0); }
    const lpacReport = readReport(1);
    checkPins();
    result = { issuer: WINDOWS_NODE_CNG_PRESERVE_ISSUER, buildCommit: input.buildCommit, runCommit: input.runCommit, programs: windowsNodeCngInprocessProgramReceipts(),
      host: { ...host, identity: hostIdentity, report: hostReport }, lpac: { exitCode, jobStopped: true, report: lpacReport, output } };
  } catch (error) {
    identityFailure = windowsLibuvHostIdentityFailure(error);
    if (uncertain(error) || phase === "prepare" && !fixture) unsafe = true;
    failure = { error: uncertain(error) ? error : new Error(`The fixed source Node in-process probe failed during ${phase}.`) };
  }
  finally {
    unsafe = await disposeWindowsLibuvProbe({ unsafe, lpacCreated: lpacProcess !== undefined,
      async stopLpac() { if (fixture) { const lease = await fixture.stop(15_000); lease.requireStopped(); } },
      async closeFixture() { if (fixture) await fixture.close(); },
      releasePins() { for (const pin of pins.slice().reverse()) closePin(pin); for (const handle of directories.slice().reverse()) api.close(handle); },
    });
    if (!unsafe && fixture) {
      try {
        // Only this fresh fixed-input tree is removed, after genuine stop and every native owner/pin has closed.
        // TAP remains private and is deleted without being read, decoded or published.
        fs.rmSync(fixture.paths.root, { recursive: true, force: false });
        unsafe ||= fs.existsSync(fixture.paths.root);
      } catch { unsafe = true; }
    }
    if (unsafe) quarantinedProbeOwners.push({ fixture, profile, io, pins, directories, lpacProcess, issued, ownership, native, parent: input.parent });
  }
  if (unsafe) throw new WindowsNodeCngPreserveCleanupError();
  if (failure) {
    if (failure.error !== null && typeof failure.error === "object") failureReceipts.set(failure.error, Object.freeze({ phase,
      ...(identityFailure ? { identityFailure } : {}),
      ...(stoppedHost ? { host: Object.freeze({ ...stoppedHost, ...(hostIdentity ? { identity: hostIdentity } : {}), reportState: hostReportState, report: hostReportFact }) } : {}) }));
    throw failure.error;
  }
  if (!result) throw new Error("The fixed source Node in-process probe returned no stopped numeric result.");
  return Object.freeze({ ...result, invocation: Object.freeze({ flags: WINDOWS_NODE_CNG_PRESERVE_FLAGS, route: "fixed-relative-sibling" as const }), cleanupComplete: true as const });
}
