/** Manual disposable-runner witness for ONE unchanged fixed C case. No collector/tool runs merely by importing it. */
import fs from "node:fs";
import path from "node:path/win32";
import { randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { ExperimentalWindowsLpacFixture } from "../../app/main/agent/experimental-windows-lpac";
import { loadExperimentalWindowsLpacApi, type WindowsHandle, type WindowsLpacProfile, type WindowsSuspendedProcess } from "../../app/main/agent/experimental-windows-lpac-api";
import { loadInheritedChildObserver, inheritedChildVisualStudioRange, inheritedChildReadout, InheritedChildCleanupError } from "./windows-lpac-inherited-child";
import { loadWindowsLpacChildAccessNative, windowsLpacChildAccessNativeReceipt, type WindowsLpacChildAccessReadPin, type WindowsLpacChildAccessTool } from "./windows-lpac-child-access-native";
import { childAccessManualGate, childAccessLocalPath, childAccessCleanEnvironment, childAccessEnvironmentBlock, childAccessCompileBatch,
  childAccessSourceCopies, childAccessPinnedProcmon, childAccessSha256, childAccessManifest, childAccessManifestCurrent,
  CHILD_ACCESS_ARCHIVE_MAX, CHILD_ACCESS_TOOL, CHILD_ACCESS_PML_MAX, CHILD_ACCESS_CSV_MAX, childAccessCommand, childAccessProcmonConfiguration,
  ChildAccessAssetError } from "./windows-lpac-child-access-assets";
import { parseWindowsLpacChildAccessCsv, WindowsLpacChildAccessParseError, type WindowsLpacChildAccessAggregate } from "./windows-lpac-child-access-parser";
import { completeChildAccessReadout, childAccessReadoutPhase, closeChildAccessOwnedStack } from "./windows-lpac-child-access-readout";
import { ChildAccessWatchdog } from "./windows-lpac-child-access-watchdog";

const retained: unknown[] = [];
type Receipt = Readonly<{ phase: number; readoutPhase: number; assetCode: number; parserCode: number; nativeStage: number; nativeOperation: number; nativeDomain: number; nativeCode: number; hostHelperLinks: number }>;
const receipts = new WeakMap<object, Receipt>();
class ChildAccessWitnessFailure extends Error {
  constructor(receipt: Receipt) { super("The manual fixed child-access witness refused incomplete evidence; private owners were retained."); this.name = "ChildAccessWitnessFailure"; receipts.set(this, Object.freeze(receipt)); }
}
export function childAccessWitnessReceipt(error: unknown): Receipt | undefined {
  if (!error || typeof error !== "object") return undefined;
  const receipt = receipts.get(error); return receipt ? { ...receipt } : undefined;
}
const fixedFailure = () => new Error("The fixed child-access witness contract was refused.");
const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
function freshDirectory(parent: string, prefix: string): string {
  childAccessLocalPath(parent); return childAccessLocalPath(fs.realpathSync.native(fs.mkdtempSync(path.join(parent, prefix))));
}
function ordinaryRead(file: string, maximum: number): Buffer {
  const before = fs.lstatSync(file);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size < 1 || before.size > maximum) throw fixedFailure();
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let bytes: Buffer | undefined, result: Buffer | undefined, failed = false;
  try {
    const opened = fs.fstatSync(descriptor);
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1) throw fixedFailure();
    bytes = Buffer.alloc(before.size + 1); let count = 0;
    while (count < bytes.length) { const amount = fs.readSync(descriptor, bytes, count, bytes.length - count, count); if (!amount) break; count += amount; }
    const after = fs.fstatSync(descriptor), named = fs.lstatSync(file);
    if (count !== before.size || after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs || named.dev !== opened.dev || named.ino !== opened.ino || named.isSymbolicLink() || named.nlink !== 1) throw fixedFailure();
    result = bytes.subarray(0, count);
  } catch { bytes?.fill(0); failed = true; }
  try { fs.closeSync(descriptor); } catch { bytes?.fill(0); retained.push({ descriptor }); throw new InheritedChildCleanupError(); }
  if (failed || !result) throw fixedFailure();
  return result;
}
async function downloadPinnedTool(): Promise<Buffer> {
  const chunks: Buffer[] = []; let count = 0;
  const response = await fetch(CHILD_ACCESS_TOOL.url, { redirect: "error", credentials: "omit", signal: AbortSignal.timeout(30_000) });
  if (!response.ok || !response.body) throw fixedFailure();
  const declared = response.headers.get("content-length");
  if (declared !== null && (!/^[1-9]\d*$/.test(declared) || Number(declared) > CHILD_ACCESS_ARCHIVE_MAX)) throw fixedFailure();
  const reader = response.body.getReader();
  try {
    for (;;) {
      const next = await reader.read(); if (next.done) break;
      count += next.value.byteLength; if (count > CHILD_ACCESS_ARCHIVE_MAX) throw fixedFailure(); chunks.push(Buffer.from(next.value));
    }
    if (!count || (declared !== null && count !== Number(declared))) throw fixedFailure();
    const archive = Buffer.concat(chunks); try { return childAccessPinnedProcmon(archive); } finally { archive.fill(0); }
  } finally { await reader.cancel().catch(() => undefined); for (const chunk of chunks) chunk.fill(0); }
}
/** Fixed trusted setup only, before any PML/CSV exists. Output is captured and never forwarded. */
function compileFixedCase(build: string, environment: NodeJS.ProcessEnv, runner: "windows-2022" | "windows-2025", copies: Map<string, Buffer>): Buffer {
  for (const [file, bytes] of copies) fs.writeFileSync(path.join(build, file), bytes, { flag: "wx" });
  const programFiles = childAccessLocalPath(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)");
  const installation = childAccessLocalPath(execFileSync(path.join(programFiles, "Microsoft Visual Studio", "Installer", "vswhere.exe"),
    ["-latest", "-version", inheritedChildVisualStudioRange(runner), "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"],
    { env: environment, encoding: "utf8", timeout: 15_000, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 32 * 1024 }).trim());
  const command = path.join(build, "compile.cmd"); fs.writeFileSync(command, childAccessCompileBatch(installation, build), { flag: "wx" });
  const result = spawnSync(environment.ComSpec!, ["/d", "/s", "/c", `""${command}""`],
    { env: environment, cwd: build, encoding: "utf8", timeout: 60_000, windowsHide: true, windowsVerbatimArguments: true, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 256 * 1024 });
  if (result.error || result.signal || result.status !== 0) throw fixedFailure();
  return ordinaryRead(path.join(build, "fixture.exe"), CHILD_ACCESS_ARCHIVE_MAX);
}

export async function runWindowsLpacChildAccessWitness(): Promise<WindowsLpacChildAccessAggregate> {
  let phase = 1;
  const env = process.env, runner = childAccessManualGate(env, process.platform, process.arch);
  if (retained.length) throw new ChildAccessWitnessFailure({ phase: 0, readoutPhase: 0, assetCode: 0, parserCode: 0, nativeStage: 0, nativeOperation: 0, nativeDomain: 0, nativeCode: 0, hostHelperLinks: 0 });
  const api = loadExperimentalWindowsLpacApi(), native = loadWindowsLpacChildAccessNative(), observer = loadInheritedChildObserver();
  const tools: WindowsLpacChildAccessTool[] = [], pins: WindowsLpacChildAccessReadPin[] = [], stoppedTools = new Set<WindowsLpacChildAccessTool>();
  const directoryPins: WindowsHandle[] = [], scratch: string[] = [];
  let fixture: ExperimentalWindowsLpacFixture | undefined, profile: WindowsLpacProfile | undefined, processOwner: WindowsSuspendedProcess | undefined, job: WindowsHandle | undefined;
  let watchdog: ChildAccessWatchdog | undefined, rootStopped = false, collectorStopped = false, collector: WindowsLpacChildAccessTool | undefined;
  let executable: Buffer | undefined, sources: Map<string, Buffer> | undefined;
  let hostHelperLinks = 0;
  let rootStopAttempted = false, captureStarted = false, transactionStarted = false;
  const remember = (extra?: unknown) => { retained.push({ api, native, observer, tools, pins, directoryPins, scratch, fixture, profile, processOwner, job, watchdog, extra }); };
  try {
    phase = 2; native.requireAdministrator(); native.requireExclusiveTools([]);
    const temporary = childAccessLocalPath(fs.realpathSync.native(env.RUNNER_TEMP!)), windows = childAccessLocalPath(api.windowsDirectory());
    if (api.volumeFileSystem(path.parse(temporary).root).toUpperCase() !== "NTFS") throw fixedFailure();
    directoryPins.push(api.pinDirectory(temporary));
    const root = path.join(temporary, `child-access-witness-${randomUUID()}`), owner = api.ownerSid();
    api.createDirectory(root, `D:P(A;OICI;FA;;;${owner})(A;OICI;FA;;;SY)S:(ML;OICI;NW;;;ME)`); scratch.push(root); directoryPins.push(api.pinDirectory(root));
    const build = path.join(root, "build"), hostProfile = path.join(root, "profile"), temp = path.join(root, "temporary");
    for (const directory of [build, hostProfile, path.join(hostProfile, "Local"), path.join(hostProfile, "Roaming"), temp]) fs.mkdirSync(directory);
    const clean = childAccessCleanEnvironment(windows, hostProfile, temp), block = childAccessEnvironmentBlock(clean);
    phase = 3;
    sources = childAccessSourceCopies(file => ordinaryRead(path.resolve("test/fixtures", file), 1024 * 1024));
    executable = compileFixedCase(build, clean, runner, sources);
    if (executable[0] !== 0x4d || executable[1] !== 0x5a) throw fixedFailure();
    phase = 4;
    const toolBytes = await downloadPinnedTool(), toolPath = path.join(root, "Procmon64.exe");
    try { fs.writeFileSync(toolPath, toolBytes, { flag: "wx" }); } finally { toolBytes.fill(0); }
    const toolPin = native.pinFile(toolPath, CHILD_ACCESS_ARCHIVE_MAX); pins.push(toolPin);
    const actualTool = toolPin.read(); try { if (childAccessSha256(actualTool) !== CHILD_ACCESS_TOOL.executableSha256) throw fixedFailure(); } finally { actualTool.fill(0); }
    phase = 5;
    const helper = native.pinWindowsPowerShell(), powershell = helper.program, powershellPin = helper.pin, securityModule = helper.securityModule;
    hostHelperLinks = helper.linkCount; pins.push(powershellPin);
    const signaturePath = path.join(root, "signature.bin");
    const signatureScript = `$ErrorActionPreference='Stop';Import-Module -Name ${literal(securityModule)} -ErrorAction Stop;` +
      `$s=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath ${literal(toolPath)};` +
      `if($s.Status -ne 'Valid' -or $null -eq $s.SignerCertificate -or $s.SignerCertificate.Subject -notmatch '(?:^|,\\s*)O=Microsoft Corporation(?:,|$)'){exit 1};` +
      `$f=[IO.File]::Open(${literal(signaturePath)},[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None);try{$b=[BitConverter]::GetBytes([uint32]1);$f.Write($b,0,4);$f.Flush($true)}finally{$f.Dispose()}`;
    const signatureTool = native.launchTool({ program: powershell, pin: powershellPin, command: childAccessCommand(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", signatureScript]), cwd: root, environment: block });
    tools.push(signatureTool); if (signatureTool.waitExitedBefore(performance.now() + 15_000) !== 0) throw fixedFailure(); stoppedTools.add(signatureTool);
    const signaturePin = native.pinFile(signaturePath, 4); pins.push(signaturePin);
    const signature = signaturePin.read();
    const manifest = (() => { try { return childAccessManifest(env.GITHUB_SHA!, executable!, signature, sources!); } finally { signature.fill(0); } })();
    signaturePin.close(); pins.splice(pins.indexOf(signaturePin), 1); signatureTool.closeStopped(); tools.splice(tools.indexOf(signatureTool), 1);
    powershellPin.close(); pins.splice(pins.indexOf(powershellPin), 1);
    phase = 6;
    // Match the original probe's ordinary fixture-parent ancestry. The host-only trace directory grants no LPAC access.
    const fixtureParent = freshDirectory(temporary, "ember-lpac-inherited-"); scratch.push(fixtureParent); directoryPins.push(api.pinDirectory(fixtureParent));
    const pml = path.join(root, "private.pml"), csv = path.join(root, "private.csv"), configuration = path.join(root, "fixed.pmc");
    watchdog = new ChildAccessWatchdog(pml, csv); await watchdog.ready();
    const launch = (args: readonly string[]) => {
      watchdog!.healthy(); toolPin.unchanged();
      const tool = native.launchTool({ program: toolPath, pin: toolPin, command: childAccessCommand(toolPath, args), cwd: root, environment: block });
      tools.push(tool); watchdog!.register(tool); return tool;
    };
    fixture = ExperimentalWindowsLpacFixture.prepare(fixtureParent, executable, { ...api,
      createProfile(name) { profile = api.createProfile(name); return profile; }, createJob() { job = api.createJob(); return job; },
      createSuspended(...args) { processOwner = api.createSuspended(...args); return processOwner; },
      resume(thread) {
        phase = 8;
        if (!fixture || !processOwner || !profile || !job || !imagePin || thread !== processOwner.thread || !childAccessManifestCurrent(manifest, env.GITHUB_SHA!, executable!)) throw fixedFailure();
        native.verifyBorrowedRoot({ process: processOwner.process, pid: processOwner.pid, job, program: fixture.paths.program, pin: imagePin }); api.verifyToken(profile, processOwner.process);
        fs.writeFileSync(configuration, childAccessProcmonConfiguration(processOwner.pid), { flag: "wx" });
        native.requireExclusiveTools([]);
        collector = launch(["/AcceptEula", "/Quiet", "/Minimized", "/LoadConfig", configuration, "/BackingFile", pml, "/Runtime", "12"]); captureStarted = true;
        collector.current(); collector.sampleMembers();
        const idle = launch(["/AcceptEula", "/Quiet", "/WaitForIdle"]);
        if (idle.waitExitedBefore(performance.now() + 10_000) !== 0) throw fixedFailure(); stoppedTools.add(idle);
        native.requireExclusiveTools([collector]); collector.current(); watchdog!.healthy();
        const stat = fs.lstatSync(pml); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size < 1 || stat.size > CHILD_ACCESS_PML_MAX) throw fixedFailure();
        native.verifyBorrowedRoot({ process: processOwner.process, pid: processOwner.pid, job, program: fixture.paths.program, pin: imagePin }); api.verifyToken(profile, processOwner.process);
        phase = 9; api.resume(thread); // The original root flags, environment, arguments and LPAC attributes are unchanged.
      },
    });
    const imagePin = native.pinFile(fixture.paths.program, CHILD_ACCESS_ARCHIVE_MAX); pins.push(imagePin);
    const staged = imagePin.read(); try { if (childAccessSha256(staged) !== manifest.executableSha256) throw fixedFailure(); } finally { staged.fill(0); }
    api.writeNewFile(path.join(fixture.paths.root, "all-app-packages.txt"), Buffer.from("disposable LPAC canary"),
      `D:P(A;;FA;;;${api.ownerSid()})(A;;FA;;;SY)(A;;FR;;;AC)S:(ML;;NW;;;ME)`);
    phase = 7;
    const previousMarker = process.env.GH_TOKEN; process.env.GH_TOKEN = "ember-disposable-child-access-marker";
    try { await fixture.launch([String(process.pid)]); }
    finally { if (previousMarker === undefined) delete process.env.GH_TOKEN; else process.env.GH_TOKEN = previousMarker; }
    if (!processOwner || !job || !profile || !collector) throw fixedFailure();
    const selectedRoot = processOwner, selectedJob = job, selectedProfile = profile, selectedFixture = fixture, selectedImagePin = imagePin;
    let admitted: number | null = null;
    phase = 10;
    const admissionDeadline = performance.now() + 10_000;
    while (!api.exited(selectedRoot.process)) {
      if (performance.now() >= admissionDeadline) throw fixedFailure();
      try {
        admitted = observer.admit({ job: selectedJob, rootProcess: selectedRoot.process, rootPid: selectedRoot.pid, image: selectedFixture.paths.program,
          current: () => { selectedImagePin.unchanged(); return !api.exited(selectedRoot.process); }, verifyToken: handle => api.verifyToken(selectedProfile, handle),
          grant: () => { throw fixedFailure(); } }); // A surprising child is never resumed by this denial-only observation.
      } catch (error) {
        if (error instanceof InheritedChildCleanupError) throw error;
        break; // A natural root exit may race this snapshot. Exact C denial and full Stop remain mandatory below.
      }
      if (admitted !== null) throw fixedFailure();
      watchdog.healthy(); await new Promise<void>(resolve => setTimeout(resolve, 10));
    }
    await fixture.waitRootExited(15_000); collector.current(); watchdog.healthy();
    phase = 11; rootStopAttempted = true;
    const stopDeadline = performance.now() + 15_000, lease = await fixture.stop(15_000);
    lease.requireStopped(); observer.waitStoppedBefore(stopDeadline); rootStopped = true;
    const exit = fixture.exitCode();
    inheritedChildReadout(exit, () => { if (exit !== 18 || admitted !== null) throw fixedFailure(); });
    phase = 12;
    native.requireExclusiveTools([collector]); collector.current();
    const terminate = launch(["/AcceptEula", "/Quiet", "/Terminate"]);
    if (terminate.waitExitedBefore(performance.now() + 15_000) !== 0) throw fixedFailure(); stoppedTools.add(terminate);
    if (collector.waitExitedBefore(performance.now() + 15_000) !== 0) throw fixedFailure(); stoppedTools.add(collector); collectorStopped = true;
    native.requireExclusiveTools([]); watchdog.healthy();
    phase = 13; transactionStarted = true;
    return await completeChildAccessReadout({
      requireRootStopped() { if (!rootStopped) throw fixedFailure(); lease.requireStopped(); observer.requireStopped(); },
      requireCollectorStopped() { if (!collectorStopped || tools.some(tool => !stoppedTools.has(tool))) throw fixedFailure(); },
      pinPml() { return native.pinFile(pml, CHILD_ACCESS_PML_MAX); },
      exportPml(pin) {
        native.requireExclusiveTools([]); pin.unchanged();
        const exporter = launch(["/AcceptEula", "/Quiet", "/Minimized", "/OpenLog", pml, "/LoadConfig", configuration, "/SaveApplyFilter", "/SaveAs", csv]);
        if (exporter.waitExitedBefore(performance.now() + 15_000) !== 0) throw fixedFailure(); stoppedTools.add(exporter); pin.unchanged(); native.requireExclusiveTools([]);
      },
      pinCsv() { return native.pinFile(csv, CHILD_ACCESS_CSV_MAX); },
      stopWatchdog: () => watchdog!.stop(),
      decode(bytes) {
          // Both finalized trace pins and every native writer/worker Stop precede even this fixed C control receipt.
          selectedImagePin.unchanged(); toolPin.unchanged();
          const pin = native.pinFile(path.join(selectedFixture.paths.state, "failure.bin"), 100); pins.push(pin);
          const control = pin.read(); let values: number[] | undefined;
          try {
            if (control.length !== 100) throw fixedFailure();
            values = Array.from({ length: 25 }, (_, index) => control.readUInt32LE(index * 4));
            if (values[0] !== 18 || values[1] !== 5 || values[24] !== 0xc0000022 || values.slice(2, 11).some(value => value !== 1) || values[11] !== 0 ||
              values[12] !== 1 || values[13] !== 0 || values[14] !== 1 || values[15] !== 0 || values[16] !== 1 || values[17] !== 0 ||
              values[18] !== 0 || values[19] !== 0 || values[20] !== 1 || values[21] !== 1 || values[22] !== 0x10000000 || values[23] !== 0) throw fixedFailure();
          } finally { control.fill(0); values?.fill(0); }
          pin.close(); pins.splice(pins.indexOf(pin), 1);
          return parseWindowsLpacChildAccessCsv(bytes, { ownedPids: new Set([selectedRoot.pid]), paths: { image: selectedFixture.paths.program,
            ordinaryAAPCanary: path.join(selectedFixture.paths.root, "all-app-packages.txt"), work: selectedFixture.paths.work, state: selectedFixture.paths.state, windows } });
      },
      async closeOwners() {
        observer.closeStopped();
        for (const tool of tools) tool.closeStopped();
        closeChildAccessOwnedStack(pins, pin => pin.close());
        await selectedFixture.close();
        closeChildAccessOwnedStack(directoryPins, handle => api.close(handle));
      },
      removeKnownScratch() { for (const directory of scratch) fs.rmSync(directory, { recursive: true, force: false }); scratch.length = 0; },
      retain: remember,
    });
  } catch (error) {
    // A known LPAC process still receives one Stop attempt even if pre-resume host setup refused.
    if (fixture && processOwner && !rootStopAttempted && !transactionStarted) {
      try { const deadline = performance.now() + 15_000, lease = await fixture.stop(15_000); lease.requireStopped(); observer.waitStoppedBefore(deadline); rootStopped = true; }
      catch { /* Unverified stop never releases the owned fixture or authorizes readout. */ }
    }
    // No global vendor stop or name-based kill is issued from a failure path. Owned collector jobs/pins remain held.
    remember({ captureStarted, rootStopped, collectorStopped });
    const nativeReceipt = windowsLpacChildAccessNativeReceipt(error);
    throw new ChildAccessWitnessFailure({ phase, readoutPhase: childAccessReadoutPhase(error), assetCode: error instanceof ChildAccessAssetError ? error.code : 0,
      parserCode: error instanceof WindowsLpacChildAccessParseError ? error.code : 0,
      nativeStage: nativeReceipt?.stage ?? 0, nativeOperation: nativeReceipt?.operation ?? 0, nativeDomain: nativeReceipt?.domain ?? 0, nativeCode: nativeReceipt?.code ?? 0, hostHelperLinks });
  } finally { executable?.fill(0); if (sources) for (const bytes of sources.values()) bytes.fill(0); }
}
