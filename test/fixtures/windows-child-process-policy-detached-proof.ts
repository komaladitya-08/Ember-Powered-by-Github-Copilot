/** Detached-root run comparison; the original C, compilation identity and private-job ownership rules are unchanged. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ExperimentalWindowsLpacFixture, experimentalWindowsEnvironment } from "../../app/main/agent/experimental-windows-lpac";
import { ExperimentalWindowsCreateUncertain, type WindowsHandle, type WindowsLpacApi, type WindowsLpacProfile, type WindowsSuspendedProcess } from "../../app/main/agent/experimental-windows-lpac-api";
import { loadWindowsChildPolicyJob } from "./windows-child-process-policy-job";
import { loadWindowsChildPolicyChecks } from "./windows-child-process-policy-checks";
import { windowsNodeProofCommand, WindowsNodeProofCleanupError } from "./windows-node-lpac-proof";
import { loadWindowsChildProcessPolicyDetachedIo as loadWindowsChildProcessPolicyIo, WindowsChildProcessPolicyIoCleanupError } from "./windows-child-process-policy-detached-io";
import { WINDOWS_CHILD_POLICY_DETACHED_VARIANT as variant } from "./windows-child-process-policy-detached-variant";
import { runWindowsChildPolicyHost } from "./windows-child-process-policy-host";
import { WindowsNodeHostCleanupError } from "./windows-node-lpac-startup";
import { loadWindowsChildPolicyHostIdentity, type WindowsChildPolicyHostIdentity } from "./windows-child-process-policy-host-identity";
import { disposeWindowsChildPolicyProbe } from "./windows-child-process-policy-disposal";
import { WindowsChildProcessPolicyOwnership, readWindowsChildProcessPolicyAfterStopped, readWindowsChildProcessPolicySuccessfulExit } from "./windows-child-process-policy-ownership";
import { parseWindowsChildProcessPolicyReport, WINDOWS_CHILD_PROCESS_POLICY_REPORT_BYTES } from "./windows-child-process-policy-report";
import { brandWindowsChildPolicyFailure, preserveWindowsChildPolicyFailure } from "./windows-child-process-policy-diagnostic";
// @ts-expect-error -- fixed trusted-host JavaScript build recipe
import { buildPin, parseWindowsChildProcessPolicyBuildReceipt } from "../../scripts/experimental/build-windows-child-process-policy.mjs";

export class WindowsChildProcessPolicyCleanupError extends WindowsNodeHostCleanupError {
  constructor() { super(); this.name = "WindowsChildProcessPolicyCleanupError"; this.message = "Child-process policy prerequisite cleanup is unverified; retain all private owners."; }
}
const retained: unknown[] = [];
const uncertain = (error: unknown) => error instanceof WindowsNodeHostCleanupError || error instanceof WindowsChildProcessPolicyIoCleanupError || error instanceof WindowsNodeProofCleanupError || error instanceof ExperimentalWindowsCreateUncertain;
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
export const WINDOWS_CHILD_POLICY_CANARY = "EMBER_CHILD_POLICY_CANARY\n";
export type WindowsChildPolicyCase = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
export const windowsChildPolicyBirth = (value: WindowsChildPolicyCase): 0 | 1 | 2 => value === 0 || value === 8 ? 0 : value === 2 ? 2 : 1;
export function windowsChildProcessPolicyEnvironment(base: Buffer, input: { canary: string; parentPid: number; caseId: WindowsChildPolicyCase }) {
  if (!Buffer.isBuffer(base) || base.length > 64 * 1024 || base.length % 2 || !base.subarray(-4).equals(Buffer.alloc(4)) ||
    !/^[A-Za-z]:\\/.test(input.canary) || /[\0\r\n]/.test(input.canary) ||
    !Number.isInteger(input.caseId) || input.caseId < 0 || input.caseId > 8 || !Number.isInteger(input.parentPid) || input.parentPid <= 0 || input.parentPid > 0xffffffff) throw new Error("The child-process policy prerequisite requires fixed clean launch metadata.");
  const entries = base.toString("utf16le").split("\0").filter(Boolean);
  const keys = ["SYSTEMROOT", "WINDIR", "LOCALAPPDATA", "PATH", "TEMP", "TMP", "EMBER_LPAC_WORK", "EMBER_LPAC_STATE", "EMBER_LPAC_TOOLS"];
  const observed = entries.map(entry => entry.slice(0, entry.indexOf("=")).toUpperCase());
  if (entries.some(entry => !/^[A-Za-z_][A-Za-z_0-9]*=[A-Za-z]:\\[^\0\r\n]*$/.test(entry)) ||
    observed.length !== keys.length || new Set(observed).size !== keys.length || observed.some(key => !keys.includes(key))) throw new Error("The child-process policy fields require the existing fixed clean environment only.");
  entries.push(`EMBER_CHILD_POLICY_CANARY=${input.canary}`, `EMBER_CHILD_POLICY_PARENT=${input.parentPid}`, `EMBER_CHILD_POLICY_CASE=${input.caseId}`);
  return Buffer.from(entries.sort((a, b) => a.toUpperCase().localeCompare(b.toUpperCase(), "en")).join("\0") + "\0\0", "utf16le");
}
function readBounded(file: string, maximum: number): Buffer {
  let fd: number | undefined, bytes: Buffer | undefined, result: Buffer | undefined, failure: Error | undefined;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maximum) throw new Error();
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const start = fs.fstatSync(fd); bytes = Buffer.alloc(before.size + 1); let read = 0;
    if (!start.isFile() || start.nlink !== 1 || start.ino !== before.ino || start.dev !== before.dev || start.size !== before.size) throw new Error();
    while (read < bytes.length) { const count = fs.readSync(fd, bytes, read, bytes.length - read, read); if (!count) break; read += count; }
    const end = fs.fstatSync(fd), after = fs.lstatSync(file);
    if (read !== start.size || end.ino !== start.ino || end.dev !== start.dev || end.size !== start.size || end.mtimeMs !== start.mtimeMs || end.ctimeMs !== start.ctimeMs ||
      !after.isFile() || after.isSymbolicLink() || after.nlink !== 1 || after.ino !== start.ino || after.dev !== start.dev || after.size !== start.size) throw new Error();
    result = bytes.subarray(0, read);
  } catch { bytes?.fill(0); failure = new Error("The fixed child-process policy asset/report failed its ordinary bounded-file contract."); }
  if (fd !== undefined) try { fs.closeSync(fd); } catch { retained.push({ fd, bytes, file }); throw new WindowsChildProcessPolicyCleanupError(); }
  if (failure) throw failure;
  if (!result) throw new Error("No bounded child-process policy prerequisite bytes were read.");
  return result;
}

export async function runWindowsChildProcessPolicyDetachedProbe(input: { parent: string; buildRoot: string; commit: string; image: "windows-2022" | "windows-2025"; caseId: WindowsChildPolicyCase }, api: WindowsLpacApi) {
  if (retained.length) throw new WindowsChildProcessPolicyCleanupError();
  if (buildPin.issuer !== variant.compiledIssuer) throw new Error("The detached-root comparison requires its original compiled-source issuer.");
  let native: ReturnType<typeof loadWindowsChildPolicyChecks>;
  try { native = loadWindowsChildPolicyChecks(); } catch { throw new Error("The fixed child-process policy native checks could not be bound."); }
  const ownership = new WindowsChildProcessPolicyOwnership();
  const jobLimits = loadWindowsChildPolicyJob();
  const birth = windowsChildPolicyBirth(input.caseId), argumentsFor = input.caseId === 8 ? ["--leaf"] : [];
  let hostBirthFlags: number | undefined, lpacBirthFlags: number | undefined;
  const pins: ReturnType<typeof native.pin>[] = [], directories: WindowsHandle[] = [], attemptedPins = new Set<object>();
  const issued = { directories: [] as WindowsHandle[], jobs: [] as WindowsHandle[], processes: [] as WindowsSuspendedProcess[], profileNames: [] as string[] };
  let unsafe = false, fixture: ExperimentalWindowsLpacFixture | undefined, profile: WindowsLpacProfile | undefined, lpacProcess: WindowsSuspendedProcess | undefined;
  let io: ReturnType<typeof loadWindowsChildProcessPolicyIo> | undefined, environment: Buffer | undefined, program = "", phase = "receipt";
  let hostIdentity: WindowsChildPolicyHostIdentity | undefined;
  const phaseNumber = () => phase === "prepare" ? 1 : phase === "host" ? 2 : phase === "lpac" ? 3 : phase === "host-report" || phase === "stopped-report" ? 5 : 4;
  const owned = <T>(operation: () => T): T => { if (unsafe) throw new WindowsChildProcessPolicyCleanupError(); try { return ownership.guard(operation); } catch (error) { unsafe = true;
    throw preserveWindowsChildPolicyFailure(error, new WindowsChildProcessPolicyCleanupError()); } };
  const controlled: WindowsLpacApi = { ...api,
    createProfile(name) { issued.profileNames.push(name); return owned(() => { profile = api.createProfile(name); return profile; }); },
    ownerSid: () => owned(() => api.ownerSid()), profileLocalAppDataBase: selected => owned(() => api.profileLocalAppDataBase(selected)),
    createDirectory: (file, security) => owned(() => api.createDirectory(file, security)), writeNewFile: (file, bytes, security) => owned(() => api.writeNewFile(file, bytes, security)),
    pinDirectory(file) { return owned(() => { const handle = api.pinDirectory(file); issued.directories.push(handle); return handle; }); },
    createJob() { return owned(() => { const handle = api.createJob(); issued.jobs.push(handle); jobLimits.setTwo(handle); return handle; }); },
    verifyToken: (selected, process) => owned(() => api.verifyToken(selected, process)), close: handle => owned(() => api.close(handle)),
    deleteProfile(selected) { owned(() => { io?.close(); }); owned(() => api.deleteProfile(selected)); },
  };
  const acquirePin = (file: string, maximum: number) => { const pin = owned(() => native.pin(file, maximum)); pins.push(pin); return pin; };
  const checkPins = () => { for (const pin of pins) owned(() => pin.unchanged()); };
  const closePin = (pin: ReturnType<typeof native.pin>) => { if (!attemptedPins.has(pin)) { attemptedPins.add(pin); owned(() => pin.close()); } };
  const pinAncestors = (file: string) => {
    if (!/^[A-Za-z]:\\/.test(file) || file.includes("/") || /[\p{Cc}\p{Cf}]/u.test(file) || path.win32.normalize(file) !== file) throw new Error("The fixed child-process policy asset requires ordinary local ancestry.");
    const root = path.win32.parse(file).root;
    if (api.volumeFileSystem(root).toUpperCase() !== "NTFS") throw new Error("The fixed child-process policy asset requires local NTFS.");
    let current = root; directories.push(controlled.pinDirectory(current));
    for (const part of path.win32.dirname(file).slice(root.length).split("\\").filter(Boolean)) {
      if (part === "." || part === ".." || /[:<>"|?*]/.test(part) || /[. ]$/.test(part)) throw new Error("The fixed child-process policy asset has an unsupported ancestor.");
      current = path.win32.join(current, part); directories.push(controlled.pinDirectory(current));
    }
    if (fs.realpathSync.native(file).toLowerCase() !== file.toLowerCase()) throw new Error("The fixed child-process policy asset changed canonical identity.");
  };
  const readReport = (role: 0 | 1) => {
    if (!fixture) throw new Error("No owned child-process policy prerequisite fixture is available.");
    const file = path.join(fixture.paths.state, role ? "lpac-child-policy.bin" : "host-child-policy.bin"), pin = acquirePin(file, WINDOWS_CHILD_PROCESS_POLICY_REPORT_BYTES);
    const bytes = readBounded(file, WINDOWS_CHILD_PROCESS_POLICY_REPORT_BYTES); owned(() => pin.unchanged());
    try { return parseWindowsChildProcessPolicyReport(bytes, role, input.caseId as Exclude<WindowsChildPolicyCase, 8>); } finally { bytes.fill(0); }
  };
  type Report = ReturnType<typeof parseWindowsChildProcessPolicyReport>;
  let result: { issuer: string; compiledIssuer: string; variant: Pick<typeof variant, "kind" | "originalRootCreateFlags" | "rootCreateFlags">; compileCommit: string; host: { exitCode: number; jobStopped: true; identity: WindowsChildPolicyHostIdentity; report: Report | null; birthFlags: number };
    lpac: { exitCode: number; jobStopped: true; report: Report | null; birthFlags: number }; canaryUnchanged: true; noOutput: true } | undefined;
  let failure: unknown;
  try {
    const receiptPath = path.join(input.buildRoot, "build-receipt.json"); pinAncestors(receiptPath);
    acquirePin(receiptPath, 16384); const receiptBytes = readBounded(receiptPath, 16384);
    let receipt: ReturnType<typeof parseWindowsChildProcessPolicyBuildReceipt>;
    try { receipt = parseWindowsChildProcessPolicyBuildReceipt(receiptBytes, input.commit, input.image); } finally { receiptBytes.fill(0); }
    checkPins(); const assetPath = path.join(input.buildRoot, receipt.asset.name); acquirePin(assetPath, buildPin.maximumExecutableBytes);
    const bytes = readBounded(assetPath, buildPin.maximumExecutableBytes);
    if (bytes.length !== receipt.asset.bytes || digest(bytes) !== receipt.asset.sha256) throw new Error("The child-process policy executable differs from its separate repository-source receipt.");
    phase = "prepare";
    fixture = ExperimentalWindowsLpacFixture.prepare(input.parent, bytes, { ...controlled,
      createSuspended(selected, file, command, cwd, env) {
        if (!io || !profile || !fixture || selected.sidText !== profile.sidText || file !== program || !command.equals(windowsNodeProofCommand(program, argumentsFor)) ||
          cwd !== fixture.paths.work || !environment || !env.equals(experimentalWindowsEnvironment(fixture.paths, api.windowsDirectory(), controlled.profileLocalAppDataBase(profile))))
          throw new Error("The child-process policy prerequisite refused unexpected launch inputs.");
        checkPins(); lpacProcess = owned(() => io!.createLpac(selected, file, command, cwd, environment!)); issued.processes.push(lpacProcess); return lpacProcess;
      },
      verifyToken(selected, process) {
        if (!profile || !lpacProcess || selected.sidText !== profile.sidText || process !== lpacProcess.process) throw new Error("No exact child-process policy process is owned.");
        controlled.verifyToken(selected, process); lpacBirthFlags = owned(() => io!.processPolicy(process));
        if (birth === 1 && lpacBirthFlags !== 1) throw brandWindowsChildPolicyFailure(new Error("The suspended LPAC root lacks its exact creation-time child restriction."), { phase: 3, operation: 15, predicate: 9 });
        owned(() => native.image(process, lpacProcess!.pid, program)); checkPins();
      },
    }); bytes.fill(0);
    if (!profile) throw new Error("No fresh child-policy package identity was created.");
    program = fixture.paths.program; acquirePin(program, buildPin.maximumExecutableBytes);
    const staged = readBounded(program, buildPin.maximumExecutableBytes);
    try { if (staged.length !== receipt.asset.bytes || digest(staged) !== receipt.asset.sha256) throw new Error("The staged child-process policy image changed."); } finally { staged.fill(0); }
    const canary = path.join(input.parent, "host-only-canary.bin"), owner = controlled.ownerSid();
    controlled.writeNewFile(canary, Buffer.from(WINDOWS_CHILD_POLICY_CANARY), `D:P(A;;FA;;;${owner})(A;;FA;;;SY)S:(ML;;NW;;;ME)`); acquirePin(canary, 64);
    const baseEnvironment = experimentalWindowsEnvironment(fixture.paths, api.windowsDirectory(), controlled.profileLocalAppDataBase(profile));
    environment = windowsChildProcessPolicyEnvironment(baseEnvironment, { canary, parentPid: process.pid, caseId: input.caseId });
    io = owned(() => loadWindowsChildProcessPolicyIo(fixture!.paths.state, profile!, controlled, birth));
    const prepared = fixture, ownedIo = io;
    phase = "host";
    const host = await runWindowsChildPolicyHost({ program: assetPath, command: windowsNodeProofCommand(assetPath, argumentsFor), cwd: prepared.paths.work, environment, unchanged: checkPins }, controlled, {
      create(...args) { const created = owned(() => ownedIo.createHost(...args)); issued.processes.push(created); return created; },
      verify(created, expected) {
        owned(() => native.image(created.process, created.pid, expected)); hostBirthFlags = owned(() => ownedIo.processPolicy(created.process));
        if (birth === 1 && hostBirthFlags !== 1) throw brandWindowsChildPolicyFailure(new Error("The suspended host root lacks its exact creation-time child restriction."), { phase: 2, operation: 15, predicate: 9 });
        hostIdentity = owned(() => loadWindowsChildPolicyHostIdentity().inspect(created.process));
        if (hostIdentity.parent.appContainer !== 0 || hostIdentity.host.appContainer !== 0) throw new Error("The suspended child-process policy host control requires ordinary parent and child tokens.");
      },
    });
    phase = "host-report"; const hostReport = readWindowsChildProcessPolicySuccessfulExit(host.exitCode, () => input.caseId === 8 ? null : readReport(0));
    if (host.exitCode !== 0 || !hostIdentity?.sameUser || hostIdentity.parent.appContainer !== 0 || hostIdentity.host.appContainer !== 0 ||
      hostIdentity.parent.integrityRid !== hostIdentity.host.integrityRid || hostIdentity.parent.hasRestrictingSids !== hostIdentity.host.hasRestrictingSids ||
      hostBirthFlags === undefined || input.caseId !== 8 && (!hostReport || hostReport.status !== 1 || hostReport.controls !== 15)) throw new Error("The ordinary host supplied no complete fixed policy control.");
    if (input.caseId === 0 && (!hostReport || hostReport.plain.created !== 1 || hostReport.override.created !== 1)) throw new Error("The ordinary direct-create and attribute-route controls did not succeed.");
    owned(() => ownedIo.acceptHostControl()); phase = "lpac";
    const launched = await prepared.launch(argumentsFor); if (!lpacProcess || launched !== lpacProcess.pid || lpacBirthFlags === undefined) throw new Error("The child-process policy root PID differs from its exact suspended handle.");
    const stopped = await readWindowsChildProcessPolicyAfterStopped({
      waitRootExited: () => prepared.waitRootExited(20_000), waitStopped: () => prepared.waitStopped(15_000),
      exitCode: () => prepared.exitCode(), read() { phase = "stopped-report"; return input.caseId === 8 ? null : readReport(1); },
    });
    const exitCode = stopped.exitCode, lpacReport = stopped.report, output = ownedIo.readAfterStopped(() => { prepared.exitCode(); });
    try { if (output.length !== 0) throw new Error("The fixed child-process policy prerequisite emitted unexpected native output."); } finally { output.fill(0); }
    const after = readBounded(canary, 64);
    try { if (!after.equals(Buffer.from(WINDOWS_CHILD_POLICY_CANARY))) throw new Error("The fixed host-only canary changed."); } finally { after.fill(0); }
    checkPins(); result = { issuer: variant.issuer, compiledIssuer: buildPin.issuer, variant: { kind: variant.kind, originalRootCreateFlags: variant.originalRootCreateFlags, rootCreateFlags: variant.rootCreateFlags }, compileCommit: input.commit, host: { ...host, identity: hostIdentity, report: hostReport, birthFlags: hostBirthFlags! },
      lpac: { exitCode, jobStopped: true, report: lpacReport, birthFlags: lpacBirthFlags! }, canaryUnchanged: true, noOutput: true };
  } catch (error) {
    brandWindowsChildPolicyFailure(error, { phase: phaseNumber(), operation: 0, predicate: 10 });
    if (uncertain(error) || ownership.unsafe || phase === "prepare" && !fixture) unsafe = true;
    failure = uncertain(error) ? error : preserveWindowsChildPolicyFailure(error, new Error(`The fixed child-process policy prerequisite failed during ${phase}.`));
  } finally {
    unsafe = await disposeWindowsChildPolicyProbe({ unsafe, lpacCreated: lpacProcess !== undefined,
      async stopLpac() { if (fixture) { const lease = await fixture.stop(15_000); lease.requireStopped(); } },
      async closeFixture() { if (fixture) await fixture.close(); },
      releasePins() { for (const pin of pins.slice().reverse()) closePin(pin); for (const directory of directories.slice().reverse()) controlled.close(directory); },
    });
    if (unsafe) retained.push({ fixture, profile, lpacProcess, io, environment, issued, ownership, native, pins, directories, parent: input.parent });
  }
  if (unsafe) throw preserveWindowsChildPolicyFailure(failure, brandWindowsChildPolicyFailure(new WindowsChildProcessPolicyCleanupError(), { phase: 6, operation: 0, predicate: 11 }));
  if (failure) throw failure;
  if (!result) throw new Error("The fixed child-process policy prerequisite has no stopped receipt.");
  return result;
}
