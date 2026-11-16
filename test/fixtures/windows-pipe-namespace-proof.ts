/** Fixed namespace prerequisite only, using the existing zero-capability launch and private-job boundary. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { ExperimentalWindowsLpacFixture, experimentalWindowsEnvironment } from "../../app/main/agent/experimental-windows-lpac";
import { ExperimentalWindowsCreateUncertain, type WindowsHandle, type WindowsLpacApi, type WindowsLpacProfile, type WindowsSuspendedProcess } from "../../app/main/agent/experimental-windows-lpac-api";
import { nativeChecks, windowsNodeProofCommand, WindowsNodeProofCleanupError } from "./windows-node-lpac-proof";
import { loadWindowsNodeIo, WindowsNodeIoCleanupError } from "./windows-node-lpac-io";
import { runWindowsNodeHostStartup, WindowsNodeHostCleanupError } from "./windows-node-lpac-startup";
import { loadWindowsLibuvHostIdentity, type WindowsLibuvHostIdentity } from "./windows-libuv-host-identity";
import { disposeWindowsLibuvProbe } from "./windows-libuv-probe-disposal";
import { WindowsPipeNamespaceOwnership } from "./windows-pipe-namespace-ownership";
import { parseWindowsPipeNamespaceReport, WINDOWS_PIPE_NAMESPACE_REPORT_BYTES } from "./windows-pipe-namespace-report";
// @ts-expect-error -- fixed trusted-host JavaScript build recipe
import { buildPin, parseWindowsPipeNamespaceBuildReceipt } from "../../scripts/experimental/build-windows-pipe-namespace.mjs";

export class WindowsPipeNamespaceCleanupError extends WindowsNodeHostCleanupError {
  constructor() { super(); this.name = "WindowsPipeNamespaceCleanupError"; this.message = "Pipe prerequisite cleanup is unverified; retain all private owners."; }
}
const retained: unknown[] = [];
const uncertain = (error: unknown) => error instanceof WindowsNodeHostCleanupError || error instanceof WindowsNodeIoCleanupError || error instanceof WindowsNodeProofCleanupError || error instanceof ExperimentalWindowsCreateUncertain;
const digest = (value: Buffer) => createHash("sha256").update(value).digest("hex");
export const WINDOWS_PIPE_NAMESPACE_CANARY = "EMBER_PIPE_NAMESPACE_CANARY\n";
export function windowsPipeNamespaceEnvironment(base: Buffer, input: { nonce: string; canary: string; parentPid: number }) {
  if (!Buffer.isBuffer(base) || base.length > 64 * 1024 || base.length % 2 || !base.subarray(-4).equals(Buffer.alloc(4)) ||
    !/^[0-9a-f]{32}$/.test(input.nonce) || !/^[A-Za-z]:\\/.test(input.canary) || /[\0\r\n]/.test(input.canary) ||
    !Number.isInteger(input.parentPid) || input.parentPid <= 0 || input.parentPid > 0xffffffff) throw new Error("The pipe prerequisite requires fixed clean launch metadata.");
  const entries = base.toString("utf16le").split("\0").filter(Boolean);
  const keys = ["SYSTEMROOT", "WINDIR", "LOCALAPPDATA", "PATH", "TEMP", "TMP", "EMBER_LPAC_WORK", "EMBER_LPAC_STATE", "EMBER_LPAC_TOOLS"];
  const observed = entries.map(entry => entry.slice(0, entry.indexOf("=")).toUpperCase());
  if (entries.some(entry => !/^[A-Za-z_][A-Za-z_0-9]*=[A-Za-z]:\\[^\0\r\n]*$/.test(entry)) ||
    observed.length !== keys.length || new Set(observed).size !== keys.length || observed.some(key => !keys.includes(key))) throw new Error("The namespace fields require the existing fixed clean environment only.");
  entries.push(`EMBER_PIPE_NAMESPACE_NONCE=${input.nonce}`, `EMBER_PIPE_NAMESPACE_CANARY=${input.canary}`, `EMBER_PIPE_NAMESPACE_PARENT=${input.parentPid}`);
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
  } catch { bytes?.fill(0); failure = new Error("The fixed pipe asset/report failed its ordinary bounded-file contract."); }
  if (fd !== undefined) try { fs.closeSync(fd); } catch { retained.push({ fd, bytes, file }); throw new WindowsPipeNamespaceCleanupError(); }
  if (failure) throw failure;
  if (!result) throw new Error("No bounded pipe prerequisite bytes were read.");
  return result;
}

export async function runWindowsPipeNamespaceProbe(input: { parent: string; buildRoot: string; commit: string; image: "windows-2022" | "windows-2025" }, api: WindowsLpacApi) {
  if (retained.length) throw new WindowsPipeNamespaceCleanupError();
  let native: ReturnType<typeof nativeChecks>;
  try { native = nativeChecks(api); } catch { throw new Error("The fixed pipe native checks could not be bound."); }
  const ownership = new WindowsPipeNamespaceOwnership();
  const pins: ReturnType<typeof native.pin>[] = [], directories: WindowsHandle[] = [], attemptedPins = new Set<object>();
  const issued = { directories: [] as WindowsHandle[], jobs: [] as WindowsHandle[], processes: [] as WindowsSuspendedProcess[], profileNames: [] as string[] };
  let unsafe = false, fixture: ExperimentalWindowsLpacFixture | undefined, profile: WindowsLpacProfile | undefined, lpacProcess: WindowsSuspendedProcess | undefined;
  let io: ReturnType<typeof loadWindowsNodeIo> | undefined, environment: Buffer | undefined, program = "", phase = "receipt";
  let hostIdentity: WindowsLibuvHostIdentity | undefined;
  const owned = <T>(operation: () => T): T => { if (unsafe) throw new WindowsPipeNamespaceCleanupError(); try { return ownership.guard(operation); } catch { unsafe = true; throw new WindowsPipeNamespaceCleanupError(); } };
  const controlled: WindowsLpacApi = { ...api,
    createProfile(name) { issued.profileNames.push(name); return owned(() => { profile = api.createProfile(name); return profile; }); },
    ownerSid: () => owned(() => api.ownerSid()), profileLocalAppDataBase: selected => owned(() => api.profileLocalAppDataBase(selected)),
    createDirectory: (file, security) => owned(() => api.createDirectory(file, security)), writeNewFile: (file, bytes, security) => owned(() => api.writeNewFile(file, bytes, security)),
    pinDirectory(file) { return owned(() => { const handle = api.pinDirectory(file); issued.directories.push(handle); return handle; }); },
    createJob() { return owned(() => { const handle = api.createJob(); issued.jobs.push(handle); return handle; }); },
    verifyToken: (selected, process) => owned(() => api.verifyToken(selected, process)), close: handle => owned(() => api.close(handle)),
    deleteProfile(selected) { owned(() => { io?.close(); }); owned(() => api.deleteProfile(selected)); },
  };
  const acquirePin = (file: string, maximum: number) => { const pin = owned(() => native.pin(file, maximum)); pins.push(pin); return pin; };
  const checkPins = () => { for (const pin of pins) owned(() => pin.unchanged()); };
  const closePin = (pin: ReturnType<typeof native.pin>) => { if (!attemptedPins.has(pin)) { attemptedPins.add(pin); owned(() => pin.close()); } };
  const pinAncestors = (file: string) => {
    if (!/^[A-Za-z]:\\/.test(file) || file.includes("/") || /[\p{Cc}\p{Cf}]/u.test(file) || path.win32.normalize(file) !== file) throw new Error("The fixed pipe asset requires ordinary local ancestry.");
    const root = path.win32.parse(file).root;
    if (api.volumeFileSystem(root).toUpperCase() !== "NTFS") throw new Error("The fixed pipe asset requires local NTFS.");
    let current = root; directories.push(controlled.pinDirectory(current));
    for (const part of path.win32.dirname(file).slice(root.length).split("\\").filter(Boolean)) {
      if (part === "." || part === ".." || /[:<>"|?*]/.test(part) || /[. ]$/.test(part)) throw new Error("The fixed pipe asset has an unsupported ancestor.");
      current = path.win32.join(current, part); directories.push(controlled.pinDirectory(current));
    }
    if (fs.realpathSync.native(file).toLowerCase() !== file.toLowerCase()) throw new Error("The fixed pipe asset changed canonical identity.");
  };
  const readReport = (role: 0 | 1) => {
    if (!fixture) throw new Error("No owned pipe prerequisite fixture is available.");
    const file = path.join(fixture.paths.state, role ? "lpac-pipe-namespace.bin" : "host-pipe-namespace.bin"), pin = acquirePin(file, WINDOWS_PIPE_NAMESPACE_REPORT_BYTES);
    const bytes = readBounded(file, WINDOWS_PIPE_NAMESPACE_REPORT_BYTES); owned(() => pin.unchanged());
    try { return parseWindowsPipeNamespaceReport(bytes, role); } finally { bytes.fill(0); }
  };
  type Report = ReturnType<typeof parseWindowsPipeNamespaceReport>;
  let result: { issuer: string; compileCommit: string; host: { exitCode: number; jobStopped: true; identity: WindowsLibuvHostIdentity; report: Report };
    lpac: { exitCode: number; jobStopped: true; report: Report }; canaryUnchanged: true; noOutput: true } | undefined;
  let failure: unknown;
  try {
    const receiptPath = path.join(input.buildRoot, "build-receipt.json"); pinAncestors(receiptPath);
    acquirePin(receiptPath, 16384); const receiptBytes = readBounded(receiptPath, 16384);
    let receipt: ReturnType<typeof parseWindowsPipeNamespaceBuildReceipt>;
    try { receipt = parseWindowsPipeNamespaceBuildReceipt(receiptBytes, input.commit, input.image); } finally { receiptBytes.fill(0); }
    checkPins(); const assetPath = path.join(input.buildRoot, receipt.asset.name); acquirePin(assetPath, buildPin.maximumExecutableBytes);
    const bytes = readBounded(assetPath, buildPin.maximumExecutableBytes);
    if (bytes.length !== receipt.asset.bytes || digest(bytes) !== receipt.asset.sha256) throw new Error("The pipe executable differs from its separate repository-source receipt.");
    phase = "prepare";
    fixture = ExperimentalWindowsLpacFixture.prepare(input.parent, bytes, { ...controlled,
      createSuspended(selected, file, command, cwd, env) {
        if (!io || !profile || !fixture || selected.sidText !== profile.sidText || file !== program || !command.equals(windowsNodeProofCommand(program, [])) ||
          cwd !== fixture.paths.work || !environment || !env.equals(experimentalWindowsEnvironment(fixture.paths, api.windowsDirectory(), controlled.profileLocalAppDataBase(profile))))
          throw new Error("The pipe prerequisite refused unexpected launch inputs.");
        checkPins(); lpacProcess = owned(() => io!.createLpac(selected, file, command, cwd, environment!)); issued.processes.push(lpacProcess); return lpacProcess;
      },
      verifyToken(selected, process) {
        if (!profile || !lpacProcess || selected.sidText !== profile.sidText || process !== lpacProcess.process) throw new Error("No exact pipe-probe process is owned.");
        controlled.verifyToken(selected, process); owned(() => native.image(process, lpacProcess!.pid, program)); checkPins();
      },
    }); bytes.fill(0);
    if (!profile) throw new Error("No fresh namespace-probe package identity was created.");
    program = fixture.paths.program; acquirePin(program, buildPin.maximumExecutableBytes);
    const staged = readBounded(program, buildPin.maximumExecutableBytes);
    try { if (staged.length !== receipt.asset.bytes || digest(staged) !== receipt.asset.sha256) throw new Error("The staged pipe image changed."); } finally { staged.fill(0); }
    const canary = path.join(input.parent, "host-only-canary.bin"), owner = controlled.ownerSid();
    controlled.writeNewFile(canary, Buffer.from(WINDOWS_PIPE_NAMESPACE_CANARY), `D:P(A;;FA;;;${owner})(A;;FA;;;SY)S:(ML;;NW;;;ME)`); acquirePin(canary, 64);
    const baseEnvironment = experimentalWindowsEnvironment(fixture.paths, api.windowsDirectory(), controlled.profileLocalAppDataBase(profile));
    environment = windowsPipeNamespaceEnvironment(baseEnvironment, { nonce: randomBytes(16).toString("hex"), canary, parentPid: process.pid });
    io = owned(() => loadWindowsNodeIo(fixture!.paths.state, profile!, controlled));
    const prepared = fixture, ownedIo = io;
    phase = "host";
    const host = await runWindowsNodeHostStartup({ program: assetPath, command: windowsNodeProofCommand(assetPath, []), cwd: prepared.paths.work, environment, unchanged: checkPins }, controlled, {
      create(...args) { const created = owned(() => ownedIo.createHost(...args)); issued.processes.push(created); return created; },
      verify(created, expected) {
        owned(() => native.image(created.process, created.pid, expected)); hostIdentity = owned(() => loadWindowsLibuvHostIdentity().inspect(created.process));
        if (hostIdentity.parent.appContainer !== 0 || hostIdentity.host.appContainer !== 0) throw new Error("The suspended pipe host control requires ordinary parent and child tokens.");
      },
    });
    phase = "host-report"; const hostReport = readReport(0);
    if (host.exitCode !== 0 || !hostIdentity?.sameUser || hostIdentity.parent.appContainer !== 0 || hostIdentity.host.appContainer !== 0 ||
      hostIdentity.parent.integrityRid !== hostIdentity.host.integrityRid || hostIdentity.parent.hasRestrictingSids !== hostIdentity.host.hasRestrictingSids ||
      hostReport.status !== 1 || hostReport.controls !== 31 || hostReport.current.outcome !== 1 || hostReport.local.outcome !== 1) throw new Error("The ordinary host supplied no complete connected-pair control.");
    owned(() => ownedIo.acceptHostControl()); phase = "lpac";
    const launched = await prepared.launch(); if (!lpacProcess || launched !== lpacProcess.pid) throw new Error("The pipe root PID differs from its exact suspended handle.");
    await prepared.waitRootExited(20_000); const lease = await prepared.waitStopped(15_000); lease.requireStopped();
    const exitCode = prepared.exitCode(); phase = "stopped-report";
    const lpacReport = readReport(1), output = ownedIo.readAfterStopped(() => { prepared.exitCode(); });
    try { if (output.length !== 0) throw new Error("The fixed pipe prerequisite emitted unexpected native output."); } finally { output.fill(0); }
    const after = readBounded(canary, 64);
    try { if (!after.equals(Buffer.from(WINDOWS_PIPE_NAMESPACE_CANARY))) throw new Error("The fixed host-only canary changed."); } finally { after.fill(0); }
    checkPins(); result = { issuer: buildPin.issuer, compileCommit: input.commit, host: { ...host, identity: hostIdentity, report: hostReport },
      lpac: { exitCode, jobStopped: true, report: lpacReport }, canaryUnchanged: true, noOutput: true };
  } catch (error) {
    if (uncertain(error) || ownership.unsafe || phase === "prepare" && !fixture) unsafe = true;
    failure = uncertain(error) ? error : new Error(`The fixed pipe prerequisite failed during ${phase}.`);
  } finally {
    unsafe = await disposeWindowsLibuvProbe({ unsafe, lpacCreated: lpacProcess !== undefined,
      async stopLpac() { if (fixture) { const lease = await fixture.stop(15_000); lease.requireStopped(); } },
      async closeFixture() { if (fixture) await fixture.close(); },
      releasePins() { for (const pin of pins.slice().reverse()) closePin(pin); for (const directory of directories.slice().reverse()) controlled.close(directory); },
    });
    if (unsafe) retained.push({ fixture, profile, lpacProcess, io, environment, issued, ownership, native, pins, directories, parent: input.parent });
  }
  if (unsafe) throw new WindowsPipeNamespaceCleanupError();
  if (failure) throw failure;
  if (!result) throw new Error("The fixed namespace prerequisite has no stopped receipt.");
  return result;
}
