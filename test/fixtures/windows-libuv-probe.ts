/** Separate verified-source fixed C experiment. No official Node issuer or production launcher is altered. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { z } from "zod";
import { ExperimentalWindowsLpacFixture, experimentalWindowsEnvironment } from "../../app/main/agent/experimental-windows-lpac";
import { ExperimentalWindowsCreateUncertain, type WindowsHandle, type WindowsLpacApi, type WindowsLpacProfile, type WindowsSuspendedProcess } from "../../app/main/agent/experimental-windows-lpac-api";
import { nativeChecks, windowsNodeProofCommand, WindowsNodeProofCleanupError } from "./windows-node-lpac-proof";
import { loadWindowsNodeIo, WindowsNodeIoCleanupError } from "./windows-node-lpac-io";
import { runWindowsNodeHostStartup, WindowsNodeHostCleanupError } from "./windows-node-lpac-startup";
import { inspectWindowsNodeFatalOutput } from "./windows-node-lpac-fatal";
import { parseWindowsLibuvProbeReport } from "./windows-libuv-probe-report";
import { disposeWindowsLibuvProbe } from "./windows-libuv-probe-disposal";
import { windowsLibuvBootstrapFacts } from "./windows-libuv-bootstrap";
import { loadWindowsLibuvHostIdentity, windowsLibuvHostIdentityFailure, type WindowsLibuvHostIdentity } from "./windows-libuv-host-identity";
// @ts-expect-error -- fixed trusted-host JavaScript build recipe
import { selectedWindowsLibuvBuildPin, windowsLibuvRecipe } from "../../scripts/experimental/build-windows-libuv-probe.mjs";
import sourcePin from "../../scripts/experimental/windows-libuv-source-pin.json";

const hash = z.string().regex(/^[0-9a-f]{64}$/);
const tool = z.object({ bytes: z.number().int().positive().max(64 * 1024 * 1024), sha256: hash }).strict();
const asset = (name: string) => z.object({ name: z.literal(name), bytes: z.number().int().min(2).max(16 * 1024 * 1024), sha256: hash }).strict();
const manifest = z.object({ schema: z.literal(1), issuer: z.literal("ember-experimental-libuv-fixed-probe"), sourceVersion: z.literal("22.23.5"),
  sourceArchiveSha256: z.literal(sourcePin.sourceArchive.sha256), sourceCommit: z.literal(sourcePin.provenance.commit),
  source: z.object({ stockManifestSha256: z.literal(sourcePin.stockManifestSha256), offlineManifestSha256: z.literal(sourcePin.offlineManifestSha256),
    files: z.literal(sourcePin.files.length), stockBytes: z.literal(sourcePin.files.reduce((sum, file) => sum + file.bytes, 0)),
    offlineBytes: z.literal(sourcePin.files.reduce((sum, file) => sum + file.bytes, 0) - sourcePin.patch.beforeBytes + sourcePin.patch.afterBytes),
    patchBeforeSha256: z.literal(sourcePin.patch.beforeSha256), patchAfterSha256: z.literal(sourcePin.patch.afterSha256) }).strict(),
  build: z.record(z.string(), z.unknown()), tools: z.object({ cmake: tool, compiler: tool, linker: tool }).strict(),
  recipe: z.array(z.object({ file: z.string().max(160), sha256: hash }).strict()).length(7), commit: z.string().regex(/^[0-9a-f]{40}$/),
  assets: z.object({ stock: asset("stock-probe.exe"), offline: asset("offline-probe.exe") }).strict(),
}).strict();

export function parseWindowsLibuvBuildReceipt(bytes: Buffer, commit: string, image: "windows-2022" | "windows-2025") {
  try {
    if (!Buffer.isBuffer(bytes) || bytes.length < 1 || bytes.length > 16 * 1024 || !/^[0-9a-f]{40}$/.test(commit)) throw new Error();
    const receipt = manifest.parse(JSON.parse(bytes.toString("utf8")));
    const version = receipt.build.compilerVersion;
    if (typeof version !== "string" || !/^19\.44\.[0-9]+(?:\.[0-9]+)?$/.test(version) || receipt.commit !== commit ||
      JSON.stringify(receipt.build) !== JSON.stringify({ ...selectedWindowsLibuvBuildPin(image), compilerVersion: version }) ||
      JSON.stringify(receipt.recipe) !== JSON.stringify(windowsLibuvRecipe())) throw new Error();
    return receipt;
  } catch { throw new Error("The fixed libuv build receipt failed its exact source, recipe or issuer contract."); }
}

export class WindowsLibuvProbeCleanupError extends WindowsNodeHostCleanupError {
  constructor() { super(); this.name = "WindowsLibuvProbeCleanupError"; this.message = "The fixed libuv probe could not verify cleanup; retain its scratch and asset pins."; }
}
const uncertain = (error: unknown) => error instanceof WindowsNodeHostCleanupError || error instanceof WindowsNodeIoCleanupError || error instanceof WindowsNodeProofCleanupError || error instanceof ExperimentalWindowsCreateUncertain;
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const quarantinedProbeOwners: unknown[] = [];
type FixedFailureReceipt = Readonly<{ variant: "stock" | "offline"; phase: string;
  identityFailure?: ReturnType<typeof windowsLibuvHostIdentityFailure>;
  host?: Readonly<{ exitCode: number; jobStopped: true; reportState: "not-read" | "valid" | "absent" | "refused";
    identity?: WindowsLibuvHostIdentity;
    bootstrap?: ReturnType<typeof windowsLibuvBootstrapFacts>;
    report: ReturnType<typeof parseWindowsLibuvProbeReport> | null }> }>;
const failureReceipts = new WeakMap<object, FixedFailureReceipt>();
export function windowsLibuvProbeFailureReceipt(error: unknown): FixedFailureReceipt | undefined {
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
  } catch { failure = new Error("The fixed probe input/report is not an unchanged bounded ordinary file."); }
  if (fd !== undefined) try { fs.closeSync(fd); } catch { result?.fill(0); throw new WindowsLibuvProbeCleanupError(); }
  if (failure) throw failure;
  if (!result) throw new Error("The fixed probe returned no bounded file bytes.");
  return result;
}

function pinAssetAncestors(file: string, api: WindowsLpacApi): WindowsHandle[] {
  const held: WindowsHandle[] = [];
  try {
    if (!/^[A-Za-z]:\\/.test(file) || file.includes("/") || /[\0\r\n]/.test(file) || path.win32.normalize(file) !== file) throw new Error();
    const root = path.win32.parse(file).root;
    if (api.volumeFileSystem(root).toUpperCase() !== "NTFS") throw new Error();
    let current = root; held.push(api.pinDirectory(current));
    for (const part of path.win32.dirname(file).slice(root.length).split("\\").filter(Boolean)) {
      if (part === "." || part === ".." || /[:<>"|?*\p{Cc}\p{Cf}]/u.test(part) || /[. ]$/.test(part)) throw new Error();
      current = path.win32.join(current, part); held.push(api.pinDirectory(current));
    }
    if (fs.realpathSync.native(file).toLowerCase() !== file.toLowerCase()) throw new Error();
    return held;
  } catch {
    let failed = false;
    for (const handle of held.reverse()) try { api.close(handle); } catch { failed = true; }
    if (failed) { quarantinedProbeOwners.push({ directories: held, api }); throw new WindowsLibuvProbeCleanupError(); }
    throw new Error("The fixed libuv asset requires ordinary pinned local NTFS ancestry.");
  }
}

/** One stock/offline pair. Results are emitted only after native root exit, job zero and verified fixture cleanup. */
export async function runWindowsLibuvFixedProbe(input: { parent: string; buildRoot: string; variant: "stock" | "offline"; commit: string; image: "windows-2022" | "windows-2025" }, api: WindowsLpacApi) {
  if (quarantinedProbeOwners.length) throw new WindowsLibuvProbeCleanupError();
  if (input.variant !== "stock" && input.variant !== "offline") throw new Error("Select one fixed libuv probe variant.");
  let native: ReturnType<typeof nativeChecks>;
  try { native = nativeChecks(api); } catch { throw new Error("The fixed probe native checks could not be bound."); }
  const directories: WindowsHandle[] = [], pins: ReturnType<typeof native.pin>[] = [], attemptedPins = new Set<object>();
  let fixture: ExperimentalWindowsLpacFixture | undefined, profile: WindowsLpacProfile | undefined, lpacProcess: WindowsSuspendedProcess | undefined;
  let io: ReturnType<typeof loadWindowsNodeIo> | undefined, program = "", environment: Buffer | undefined;
  let phase = "receipt";
  let stoppedHost: { exitCode: number; jobStopped: true } | undefined, hostReportFact: ReturnType<typeof parseWindowsLibuvProbeReport> | null = null;
  let hostIdentity: WindowsLibuvHostIdentity | undefined;
  let identityFailure: ReturnType<typeof windowsLibuvHostIdentityFailure>;
  let hostReportState: "not-read" | "valid" | "absent" | "refused" = "not-read";
  let unsafe = false, failure: { error: unknown } | undefined;
  let result: { issuer: string; variant: "stock" | "offline"; host: { exitCode: number; jobStopped: true; identity: WindowsLibuvHostIdentity; report: ReturnType<typeof parseWindowsLibuvProbeReport> };
    lpac: { exitCode: number; jobStopped: true; report: ReturnType<typeof parseWindowsLibuvProbeReport> | null; output: ReturnType<typeof inspectWindowsNodeFatalOutput> } } | undefined;
  const checkPins = () => { for (const pin of pins) pin.unchanged(); };
  const closePin = (pin: ReturnType<typeof native.pin>) => { if (attemptedPins.has(pin)) return; attemptedPins.add(pin); pin.close(); };
  const readReport = (token: 0 | 1) => {
    if (!fixture) throw new Error("No fixed probe fixture was created.");
    const file = path.join(fixture.paths.state, token ? "lpac-probe.bin" : "host-probe.bin");
    try { fs.lstatSync(file); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      // eslint-disable-next-line preserve-caught-error -- Filesystem errors can contain private paths; only the fixed phase leaves the fixture.
      throw new Error("The stopped fixed report could not be inspected.");
    }
    const pin = native.pin(file, 96); pins.push(pin);
    const bytes = readBounded(file, 96); pin.unchanged();
    try { return parseWindowsLibuvProbeReport(bytes, { build: input.variant === "offline" ? 1 : 0, token }); }
    finally { bytes.fill(0); }
  };
  try {
    const receiptPath = path.join(input.buildRoot, "build-receipt.json");
    directories.push(...pinAssetAncestors(receiptPath, api));
    const receiptPin = native.pin(receiptPath, 16 * 1024); pins.push(receiptPin);
    const receiptBytes = readBounded(receiptPath, 16 * 1024); receiptPin.unchanged();
    let receipt: ReturnType<typeof parseWindowsLibuvBuildReceipt>;
    try { receipt = parseWindowsLibuvBuildReceipt(receiptBytes, input.commit, input.image); } finally { receiptBytes.fill(0); }
    const record = receipt.assets[input.variant], assetPath = path.join(input.buildRoot, record.name);
    phase = "asset";
    const source = native.pin(assetPath, 16 * 1024 * 1024); pins.push(source);
    const bytes = readBounded(assetPath, 16 * 1024 * 1024); source.unchanged();
    if (bytes.length !== record.bytes || digest(bytes) !== record.sha256) throw new Error("The fixed libuv executable differs from its own build receipt.");
    phase = "prepare";
    fixture = ExperimentalWindowsLpacFixture.prepare(input.parent, bytes, { ...api,
      createProfile(name) { const value = api.createProfile(name); profile = value; return value; },
      createSuspended(requested, file, command, cwd, env) {
        if (!io || !profile || !fixture || requested.sidText !== profile.sidText || file !== program || !command.equals(windowsNodeProofCommand(program, [])) ||
          cwd !== fixture.paths.work || !environment || !env.equals(environment)) throw new Error("The fixed libuv launcher refused an unexpected input.");
        checkPins();
        try { lpacProcess = io.createLpac(requested, file, command, cwd, env); return lpacProcess; }
        catch (error) { if (uncertain(error)) unsafe = true; throw error; }
      },
      verifyToken(requested, process) {
        if (!lpacProcess || process !== lpacProcess.process || !profile || requested.sidText !== profile.sidText) throw new Error("No exact fixed-probe process identity is available.");
        api.verifyToken(requested, process); native.image(process, lpacProcess.pid, program); checkPins();
      },
      deleteProfile(requested) {
        try { io?.close(); } catch { unsafe = true; throw new WindowsLibuvProbeCleanupError(); }
        api.deleteProfile(requested);
      },
    });
    if (!profile) throw new Error("The fixed probe has no fresh package identity.");
    program = fixture.paths.program;
    const stagedPin = native.pin(program, 16 * 1024 * 1024); pins.push(stagedPin);
    const stagedBytes = readBounded(program, 16 * 1024 * 1024);
    try {
      stagedPin.unchanged();
      if (stagedBytes.length !== record.bytes || digest(stagedBytes) !== record.sha256) throw new Error("The staged fixed probe differs from its verified build asset.");
    } finally { stagedBytes.fill(0); }
    environment = experimentalWindowsEnvironment(fixture.paths, api.windowsDirectory(), api.profileLocalAppDataBase(profile));
    io = loadWindowsNodeIo(fixture.paths.state, profile, api);
    const prepared = fixture, ownedIo = io;
    phase = "host";
    // The LPAC copy is deliberately LOW-labelled. The independent ordinary-host control uses the same verified
    // bytes at their pinned original build path so that staging does not lower the control's token integrity.
    const host = await runWindowsNodeHostStartup({ program: assetPath, command: windowsNodeProofCommand(assetPath, []), cwd: prepared.paths.work, environment,
      unchanged: checkPins }, api, {
      create(...args) { phase = "host-create"; const created = ownedIo.createHost(...args); phase = "host-created"; return created; },
      verify(created, expected) {
        phase = "host-image"; native.image(created.process, created.pid, expected);
        phase = "host-token"; native.verifyHost(created.process);
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
        !hostReport || hostReport.status !== 1) throw new Error("The fixed libuv host supplied no complete ordinary-context useful-work witness.");
    phase = "host-stdio"; ownedIo.acceptHostControl();
    // The same suspended handle is checked for exact image/PID before the fixture can resume it.
    phase = "lpac";
    const createdPid = await prepared.launch();
    if (!lpacProcess || createdPid !== lpacProcess.pid) throw new Error("The fixed probe returned no exact native PID.");
    await prepared.waitRootExited(20_000);
    const lease = await prepared.waitStopped(15_000); lease.requireStopped();
    const exitCode = prepared.exitCode();
    phase = "stopped-output";
    const outputBytes = ownedIo.readAfterStopped(() => { prepared.exitCode(); });
    let output: ReturnType<typeof inspectWindowsNodeFatalOutput>;
    try { output = inspectWindowsNodeFatalOutput(outputBytes, sourcePin.version); } finally { outputBytes.fill(0); }
    const lpacReport = readReport(1);
    checkPins();
    result = { issuer: "ember-experimental-libuv-fixed-probe", variant: input.variant,
      host: { ...host, identity: hostIdentity, report: hostReport }, lpac: { exitCode, jobStopped: true, report: lpacReport, output } };
  } catch (error) {
    identityFailure = windowsLibuvHostIdentityFailure(error);
    if (uncertain(error) || phase === "prepare" && !fixture) unsafe = true;
    failure = { error: uncertain(error) ? error : new Error(`The fixed libuv probe failed during ${phase}.`) };
  }
  finally {
    unsafe = await disposeWindowsLibuvProbe({ unsafe, lpacCreated: lpacProcess !== undefined,
      async stopLpac() { if (fixture) { const lease = await fixture.stop(15_000); lease.requireStopped(); } },
      async closeFixture() { if (fixture) await fixture.close(); },
      releasePins() { for (const pin of pins.slice().reverse()) closePin(pin); for (const handle of directories.slice().reverse()) api.close(handle); },
    });
    if (unsafe) quarantinedProbeOwners.push({ fixture, profile, io, pins, directories, lpacProcess, parent: input.parent });
  }
  if (unsafe) throw new WindowsLibuvProbeCleanupError();
  if (failure) {
    if (failure.error !== null && typeof failure.error === "object") failureReceipts.set(failure.error, Object.freeze({ variant: input.variant, phase,
      ...(identityFailure ? { identityFailure } : {}),
      ...(stoppedHost ? { host: Object.freeze({ ...stoppedHost, ...(hostIdentity ? { identity: hostIdentity } : {}), bootstrap: windowsLibuvBootstrapFacts(stoppedHost.exitCode),
        reportState: hostReportState, report: hostReportFact }) } : {}) }));
    throw failure.error;
  }
  if (!result) throw new Error("The fixed libuv probe returned no stopped numeric result.");
  return result;
}
