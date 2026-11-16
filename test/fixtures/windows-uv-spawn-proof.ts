/** Fixed libuv spawn localization only; the six existing Node assertions and their authority stay unchanged. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ExperimentalWindowsLpacFixture, experimentalWindowsEnvironment, experimentalWindowsSddl } from "../../app/main/agent/experimental-windows-lpac";
import { ExperimentalWindowsCreateUncertain, type WindowsHandle, type WindowsLpacApi, type WindowsLpacProfile, type WindowsSuspendedProcess } from "../../app/main/agent/experimental-windows-lpac-api";
import { windowsNodeProofCommand } from "./windows-node-lpac-proof";
import { WindowsNodeHostCleanupError } from "./windows-node-lpac-startup";
import { WindowsNodeSourceChildIoCleanupError } from "./windows-node-source-child-io";
import { disposeWindowsLibuvProbe } from "./windows-libuv-probe-disposal";
import { loadWindowsLibuvHostIdentity, type WindowsLibuvHostIdentity } from "./windows-libuv-host-identity";
import { loadWindowsUvSpawnChecks, loadWindowsUvSpawnIo, loadWindowsUvSpawnJob, loadWindowsUvSpawnObserver } from "./windows-uv-spawn-native";
import { WindowsUvSpawnCleanupError, WindowsUvSpawnOwnership, readWindowsUvSpawnAfterStopped } from "./windows-uv-spawn-ownership";
import { runWindowsUvSpawnHost } from "./windows-uv-spawn-host";
import { parseWindowsUvSpawnReport, WINDOWS_UV_SPAWN_REPORT_BYTES } from "./windows-uv-spawn-report";
// @ts-expect-error -- fixed trusted-host build authority, not project or model input
import { buildPin, parseWindowsUvSpawnBuildReceipt, windowsUvSpawnImageFingerprint } from "../../scripts/experimental/build-windows-uv-spawn-probe.mjs";

const retained: unknown[] = [];
const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
export const WINDOWS_UV_SPAWN_ACK = "EMBER_ACK_1\n";
export const WINDOWS_UV_SPAWN_CANARY = "EMBER_UV_SPAWN_CANARY\n";
type Report = ReturnType<typeof parseWindowsUvSpawnReport>;
const failures = new WeakMap<object, Readonly<{ phase: string }>>();
/** Only this proof's fixed phase may leave a refused run; arbitrary native errors never become metadata. */
export function windowsUvSpawnFailureReceipt(error: unknown) {
  return error !== null && typeof error === "object" ? failures.get(error) : undefined;
}

/** Append only the two fixed canary/control inputs to the canonical clean LPAC environment. */
export function windowsUvSpawnEnvironment(base: Buffer, input: { canary: string; parentPid: number }): Buffer {
  if (!Buffer.isBuffer(base) || base.length > 64 * 1024 || base.length % 2 || !base.subarray(-4).equals(Buffer.alloc(4)) ||
    !/^[A-Za-z]:\\/.test(input.canary) || /[\p{Cc}\p{Cf}]/u.test(input.canary) || !Number.isInteger(input.parentPid) || input.parentPid < 1 || input.parentPid > 0xffffffff)
    throw new Error("The fixed spawn witness requires clean host-created control inputs.");
  const entries = base.toString("utf16le").split("\0").filter(Boolean);
  const keys = ["SYSTEMROOT", "WINDIR", "LOCALAPPDATA", "PATH", "TEMP", "TMP", "EMBER_LPAC_WORK", "EMBER_LPAC_STATE", "EMBER_LPAC_TOOLS"];
  const observed = entries.map(entry => entry.slice(0, entry.indexOf("=")).toUpperCase());
  if (entries.some(entry => !/^[A-Za-z_][A-Za-z_0-9]*=[A-Za-z]:\\[^\0\r\n]*$/.test(entry)) || observed.length !== keys.length ||
    new Set(observed).size !== keys.length || observed.some(key => !keys.includes(key))) throw new Error("The fixed spawn fields require the canonical clean environment.");
  entries.push(`EMBER_UV_SPAWN_CANARY=${input.canary}`, `EMBER_UV_SPAWN_PARENT=${input.parentPid}`);
  return Buffer.from(entries.sort((a, b) => a.toUpperCase().localeCompare(b.toUpperCase(), "en")).join("\0") + "\0\0", "utf16le");
}

function readBounded(file: string, maximum: number): Buffer {
  let fd: number | undefined, allocation: Buffer | undefined, value: Buffer | undefined, failed = false;
  try {
    const named = fs.lstatSync(file);
    if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1 || named.size < 1 || named.size > maximum) throw new Error();
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const opened = fs.fstatSync(fd); allocation = Buffer.alloc(named.size + 1); let count = 0;
    if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== named.ino || opened.dev !== named.dev || opened.size !== named.size) throw new Error();
    while (count < allocation.length) { const read = fs.readSync(fd, allocation, count, allocation.length - count, count); if (!read) break; count += read; }
    const after = fs.fstatSync(fd), finalNamed = fs.lstatSync(file);
    if (count !== named.size || !after.isFile() || after.nlink !== 1 || after.ino !== opened.ino || after.dev !== opened.dev || after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || !finalNamed.isFile() || finalNamed.isSymbolicLink() || finalNamed.nlink !== 1 ||
      finalNamed.ino !== named.ino || finalNamed.dev !== named.dev || finalNamed.size !== named.size || finalNamed.mtimeMs !== named.mtimeMs || finalNamed.ctimeMs !== named.ctimeMs) throw new Error();
    value = allocation.subarray(0, count);
  } catch { failed = true; }
  if (fd !== undefined) try { fs.closeSync(fd); } catch { allocation?.fill(0); throw new WindowsUvSpawnCleanupError(); }
  if (failed || !value) { allocation?.fill(0); throw new Error("The fixed spawn input/report is not an unchanged bounded ordinary file."); }
  return value;
}

/** A separate C witness, never an assertion about the failure site inside the immutable Node image. */
export async function runWindowsUvSpawnProbe(input: { parent: string; buildRoot: string; commit: string }, api: WindowsLpacApi) {
  if (retained.length) throw new WindowsUvSpawnCleanupError();
  if (!/^[0-9a-f]{40}$/.test(input.commit)) throw new Error("The fixed spawn witness requires its exact compile commit.");
  const native = loadWindowsUvSpawnChecks(), limits = loadWindowsUvSpawnJob(), ownership = new WindowsUvSpawnOwnership();
  const hostObserver = loadWindowsUvSpawnObserver(), lpacObserver = loadWindowsUvSpawnObserver();
  const pins: ReturnType<typeof native.pin>[] = [], directories: WindowsHandle[] = [], closeAttempted = new Set<object>();
  const issued = { directories: [] as WindowsHandle[], jobs: [] as WindowsHandle[], processes: [] as WindowsSuspendedProcess[], profiles: [] as string[] };
  let fixture: ExperimentalWindowsLpacFixture | undefined, profile: WindowsLpacProfile | undefined, lpacProcess: WindowsSuspendedProcess | undefined, lpacJob: WindowsHandle | undefined;
  let hostIo: ReturnType<typeof loadWindowsUvSpawnIo> | undefined, io: ReturnType<typeof loadWindowsUvSpawnIo> | undefined, environment: Buffer | undefined;
  let unsafe = false, phase = "receipt", lpacAdmitted = false, hostAdmitted = false, hostIdentity: WindowsLibuvHostIdentity | undefined;
  const owned = <T>(operation: () => T): T => { if (unsafe) throw new WindowsUvSpawnCleanupError(); try { return ownership.guard(operation); } catch { unsafe = true; throw new WindowsUvSpawnCleanupError(); } };
  const controlled: WindowsLpacApi = { ...api,
    createProfile(name) { issued.profiles.push(name); return owned(() => { profile = api.createProfile(name); return profile; }); },
    ownerSid: () => owned(() => api.ownerSid()), profileLocalAppDataBase: selected => owned(() => api.profileLocalAppDataBase(selected)),
    createDirectory: (file, security) => owned(() => api.createDirectory(file, security)), writeNewFile: (file, bytes, security) => owned(() => api.writeNewFile(file, bytes, security)),
    pinDirectory(file) { return owned(() => { const handle = api.pinDirectory(file); issued.directories.push(handle); return handle; }); },
    createJob() { return owned(() => { const handle = api.createJob(); issued.jobs.push(handle); limits.setTwo(handle); return handle; }); },
    verifyToken: (selected, process) => owned(() => api.verifyToken(selected, process)), close: handle => owned(() => api.close(handle)),
    deleteProfile(selected) { owned(() => { hostIo?.close(); io?.close(); }); owned(() => api.deleteProfile(selected)); },
  };
  const pin = (file: string, maximum: number) => { const value = owned(() => native.pin(file, maximum)); pins.push(value); return value; };
  const checkPins = () => { for (const value of pins) owned(() => value.unchanged()); };
  const pinAncestors = (file: string) => {
    if (!/^[A-Za-z]:\\/.test(file) || path.win32.normalize(file) !== file || file.includes("/") || /[\p{Cc}\p{Cf}]/u.test(file)) throw new Error("The fixed spawn asset requires ordinary local ancestry.");
    const root = path.win32.parse(file).root;
    if (api.volumeFileSystem(root).toUpperCase() !== "NTFS") throw new Error("The fixed spawn asset requires NTFS.");
    let current = root; directories.push(controlled.pinDirectory(current));
    for (const part of path.win32.dirname(file).slice(root.length).split("\\").filter(Boolean)) {
      if (part === "." || part === ".." || /[:<>"|?*]/.test(part) || /[. ]$/.test(part)) throw new Error("The fixed spawn asset has an unsupported ancestor.");
      current = path.win32.join(current, part); directories.push(controlled.pinDirectory(current));
    }
    if (fs.realpathSync.native(file).toLowerCase() !== file.toLowerCase()) throw new Error("The fixed spawn asset is not canonical.");
  };
  const grant = (role: 0 | 1) => {
    if (!fixture || !profile) throw new Error("No fixed spawn ACK owner exists.");
    const file = path.join(fixture.paths.tools, `${role ? "lpac" : "host"}-uv-spawn-ack.bin`);
    controlled.writeNewFile(file, Buffer.from(WINDOWS_UV_SPAWN_ACK, "ascii"), experimentalWindowsSddl(controlled.ownerSid(), profile.sidText, "read", false));
    pin(file, 64); checkPins();
  };
  const readReport = (role: 0 | 1): Report => {
    if (!fixture) throw new Error("No owned fixed spawn fixture exists.");
    const file = path.join(fixture.paths.state, `${role ? "lpac" : "host"}-uv-spawn-report.bin`), held = pin(file, WINDOWS_UV_SPAWN_REPORT_BYTES);
    const bytes = readBounded(file, WINDOWS_UV_SPAWN_REPORT_BYTES);
    try { owned(() => held.unchanged()); return parseWindowsUvSpawnReport(bytes, role); } finally { bytes.fill(0); }
  };
  let result: { issuer: string; compileCommit: string; host: { exitCode: 0; jobStopped: true; admitted: boolean; identity: WindowsLibuvHostIdentity; report: Report };
    lpac: { exitCode: 0; jobStopped: true; admitted: boolean; report: Report }; canaryUnchanged: true; noOutput: true } | undefined, failure: unknown;
  try {
    const receiptPath = path.join(input.buildRoot, "build-receipt.json"); pinAncestors(receiptPath); pin(receiptPath, buildPin.maximumReceiptBytes);
    const encoded = readBounded(receiptPath, buildPin.maximumReceiptBytes); let receipt: ReturnType<typeof parseWindowsUvSpawnBuildReceipt>;
    try { receipt = parseWindowsUvSpawnBuildReceipt(encoded, input.commit); } finally { encoded.fill(0); }
    const asset = receipt.assets.probe, assetPath = path.join(input.buildRoot, asset.name); pin(assetPath, buildPin.maximumExecutableBytes);
    const bytes = readBounded(assetPath, buildPin.maximumExecutableBytes);
    try {
      if (bytes.length !== asset.bytes || hash(bytes) !== asset.sha256) throw new Error("The fixed spawn image differs from its separate receipt.");
      windowsUvSpawnImageFingerprint(bytes, buildPin.maximumExecutableBytes); phase = "prepare";
      fixture = ExperimentalWindowsLpacFixture.prepare(input.parent, bytes, { ...controlled,
        createSuspended(selected, file, command, cwd, env) {
          if (!fixture || !profile || !io || selected.sidText !== profile.sidText || file !== fixture.paths.program || !command.equals(windowsNodeProofCommand(file, [])) ||
            cwd !== fixture.paths.work || !environment || !env.equals(experimentalWindowsEnvironment(fixture.paths, api.windowsDirectory(), controlled.profileLocalAppDataBase(profile)))) throw new Error("The fixed spawn launcher refused unexpected inputs.");
          checkPins(); lpacProcess = owned(() => io!.createLpac(selected, file, command, cwd, environment!)); issued.processes.push(lpacProcess); return lpacProcess;
        },
        verifyToken(selected, process) {
          if (!profile || !fixture || !lpacProcess || !lpacJob || selected.sidText !== profile.sidText || process !== lpacProcess.process) throw new Error("No exact fixed spawn root is owned.");
          controlled.verifyToken(selected, process); owned(() => native.image(process, lpacProcess!.pid, fixture!.paths.program)); checkPins();
          owned(() => lpacObserver.bind({ job: lpacJob!, rootProcess: process, rootPid: lpacProcess!.pid, image: fixture!.paths.program,
            current: () => { checkPins(); return !unsafe; }, verifyToken: child => controlled.verifyToken(selected, child), grant: () => { grant(1); lpacAdmitted = true; } }));
        },
        createJob() { const job = controlled.createJob(); lpacJob = job; return job; },
      });
    } finally { bytes.fill(0); }
    if (!profile) throw new Error("No fresh fixed spawn package exists.");
    const program = fixture.paths.program; pin(program, buildPin.maximumExecutableBytes);
    const staged = readBounded(program, buildPin.maximumExecutableBytes);
    try { if (staged.length !== asset.bytes || hash(staged) !== asset.sha256) throw new Error("The readonly LPAC image changed."); windowsUvSpawnImageFingerprint(staged, buildPin.maximumExecutableBytes); } finally { staged.fill(0); }
    const canary = path.join(input.parent, "host-only-canary.bin"), owner = controlled.ownerSid();
    controlled.writeNewFile(canary, Buffer.from(WINDOWS_UV_SPAWN_CANARY), `D:P(A;;FA;;;${owner})(A;;FA;;;SY)S:(ML;;NW;;;ME)`); pin(canary, 64);
    environment = windowsUvSpawnEnvironment(experimentalWindowsEnvironment(fixture.paths, api.windowsDirectory(), controlled.profileLocalAppDataBase(profile)), { canary, parentPid: process.pid });
    const hostState = path.join(fixture.paths.state, "host-stdio"), lpacState = path.join(fixture.paths.state, "lpac-stdio");
    for (const directory of [hostState, lpacState]) { controlled.createDirectory(directory, experimentalWindowsSddl(owner, profile.sidText, "modify", true)); directories.push(controlled.pinDirectory(directory)); }
    hostIo = owned(() => loadWindowsUvSpawnIo(hostState, profile!, controlled, "host")); io = owned(() => loadWindowsUvSpawnIo(lpacState, profile!, controlled, "lpac"));
    const prepared = fixture, ownedIo = io; phase = "host";
    const host = await runWindowsUvSpawnHost({ program: assetPath, command: windowsNodeProofCommand(assetPath, []), cwd: prepared.paths.work, environment, unchanged: checkPins }, controlled, {
      create(...args) { const created = owned(() => hostIo!.createHost(...args)); issued.processes.push(created); return created; },
      verify(created, expected) {
        owned(() => native.image(created.process, created.pid, expected)); hostIdentity = owned(() => loadWindowsLibuvHostIdentity().inspect(created.process));
        if (hostIdentity.parent.appContainer !== 0 || hostIdentity.host.appContainer !== 0) throw new Error("The fixed spawn host must retain its ordinary parent context before resume.");
      },
      bind(job, created) { owned(() => hostObserver.bind({ job, rootProcess: created.process, rootPid: created.pid, image: assetPath,
        current: () => { checkPins(); return !unsafe; },
        verifyToken(child) { const identity = owned(() => loadWindowsLibuvHostIdentity().inspect(child));
          if (!identity.sameUser || identity.parent.appContainer !== 0 || identity.host.appContainer !== 0 || identity.parent.integrityRid !== identity.host.integrityRid || identity.parent.hasRestrictingSids !== identity.host.hasRestrictingSids) throw new Error("The fixed spawn host leaf changed ordinary context."); },
        grant: () => { grant(0); hostAdmitted = true; } })); },
    }, hostObserver);
    phase = "host-report"; const hostReport = readReport(0);
    if (!hostIdentity?.sameUser || hostIdentity.parent.integrityRid !== hostIdentity.host.integrityRid || hostIdentity.parent.hasRestrictingSids !== hostIdentity.host.hasRestrictingSids ||
      !host.admitted || !hostAdmitted || !hostReport.useful) throw new Error("The ordinary host supplied no useful observed three-pipe control.");
    const hostOutput = hostIo.readAfterStopped(() => { if (host.exitCode !== 0 || host.jobStopped !== true) throw new WindowsUvSpawnCleanupError(); checkPins(); });
    try { if (hostOutput.length !== 0) throw new Error("The fixed spawn host emitted unexpected output."); } finally { hostOutput.fill(0); }
    phase = "lpac"; const launched = await prepared.launch();
    if (!lpacProcess || launched !== lpacProcess.pid) throw new WindowsUvSpawnCleanupError();
    const deadline = performance.now() + 20_000;
    while (!lpacAdmitted && !owned(() => api.exited(lpacProcess!.process))) {
      owned(() => lpacObserver.admit());
      if (performance.now() > deadline) throw new WindowsUvSpawnCleanupError();
      await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
    let stopDeadline = 0;
    const stopped = await readWindowsUvSpawnAfterStopped({
      waitRootExited: () => prepared.waitRootExited(Math.max(1, deadline - performance.now())),
      waitStopped() { stopDeadline = performance.now() + 15_000; return prepared.waitStopped(15_000); },
      requireChildStopped() { owned(() => lpacObserver.waitStoppedBefore(stopDeadline)); },
      exitCode: () => prepared.exitCode(), read() { phase = "stopped-report"; return readReport(1); },
    });
    const output = ownedIo.readAfterStopped(() => { if (stopped.exitCode !== 0) throw new WindowsUvSpawnCleanupError(); owned(() => lpacObserver.requireStopped()); checkPins(); });
    try { if (output.length !== 0) throw new Error("The fixed spawn root emitted unexpected output."); } finally { output.fill(0); }
    const after = readBounded(canary, 64);
    try { if (!after.equals(Buffer.from(WINDOWS_UV_SPAWN_CANARY))) throw new Error("The protected host canary changed."); } finally { after.fill(0); }
    if (stopped.report.useful && !lpacAdmitted) throw new Error("The useful child lacks its held-handle confinement witness.");
    checkPins(); result = { issuer: buildPin.issuer, compileCommit: input.commit, host: { ...host, identity: hostIdentity, report: hostReport },
      lpac: { exitCode: 0, jobStopped: true, admitted: lpacAdmitted, report: stopped.report }, canaryUnchanged: true, noOutput: true };
  } catch (error) {
    if (error instanceof WindowsNodeHostCleanupError || error instanceof WindowsNodeSourceChildIoCleanupError || error instanceof ExperimentalWindowsCreateUncertain || ownership.unsafe || phase === "prepare" && !fixture) unsafe = true;
    failure = unsafe ? new WindowsUvSpawnCleanupError() : new Error(`The fixed spawn witness failed during ${phase}.`);
  } finally {
    unsafe = await disposeWindowsLibuvProbe({ unsafe, lpacCreated: lpacProcess !== undefined,
      async stopLpac() { if (fixture && lpacProcess) { const deadline = performance.now() + 15_000, lease = await fixture.stop(15_000); lease.requireStopped(); lpacObserver.waitStoppedBefore(deadline); } },
      async closeFixture() { if (fixture && lpacProcess) { const deadline = performance.now() + 15_000, lease = await fixture.stop(15_000); lease.requireStopped(); lpacObserver.waitStoppedBefore(deadline); lpacObserver.closeStopped(); } if (fixture) await fixture.close(); },
      releasePins() { for (const value of pins.slice().reverse()) if (!closeAttempted.has(value)) { closeAttempted.add(value); owned(() => value.close()); } for (const directory of directories.slice().reverse()) controlled.close(directory); },
    });
    if (unsafe) retained.push({ fixture, profile, io, hostIo, pins, directories, issued, ownership, native, hostObserver, lpacObserver, environment, parent: input.parent });
  }
  if (unsafe) { const error = new WindowsUvSpawnCleanupError(); failures.set(error, Object.freeze({ phase })); throw error; }
  if (failure) { if (failure !== null && typeof failure === "object") failures.set(failure, Object.freeze({ phase })); throw failure; }
  if (!result) throw new Error("The fixed spawn witness returned no stopped result.");
  return result;
}
