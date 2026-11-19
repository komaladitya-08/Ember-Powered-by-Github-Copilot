/** Diagnostic-only staging for a pinned OpenJS Node image. Does not implement a coding backend or alter LPAC APIs. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import type * as Koffi from "koffi";
import pins from "../../scripts/experimental/windows-node-lpac-pin.json";
import { ExperimentalWindowsLpacFixture, experimentalWindowsEnvironment, experimentalWindowsSddl } from "../../app/main/agent/experimental-windows-lpac";
import { ExperimentalWindowsCreateUncertain, loadExperimentalWindowsLpacApi, type WindowsHandle, type WindowsLpacApi, type WindowsSuspendedProcess, type WindowsLpacProfile } from "../../app/main/agent/experimental-windows-lpac-api";
import { loadWindowsCommandAssetReader, ordinaryWindowsCommandAssetSize } from "../../app/main/agent/isolated-windows-command-assets";
import { WINDOWS_NODE_STARTUP_ARGS, WindowsNodeHostCleanupError, WindowsNodeStartupGate, runWindowsNodeHostStartup } from "./windows-node-lpac-startup";
import type { WindowsNodeEventIdentity } from "./windows-node-lpac-events";
import { loadWindowsNodeIo, WindowsNodeIoCleanupError, type WindowsNodeIoOwner } from "./windows-node-lpac-io";

type NodePin = (typeof pins.versions)[keyof typeof pins.versions];
export type WindowsNodeProofMode = "startup" | "startup-io" | "direct" | "inprocess" | "child";
const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const stable = (before: Buffer, after: Buffer) => before.subarray(0, 12).equals(after.subarray(0, 12)) && before.subarray(20).equals(after.subarray(20));
export function windowsNodeProofPin(version: string): Readonly<NodePin> {
  if (!Object.hasOwn(pins.versions, version)) throw new Error("Select one explicitly pinned Windows Node version.");
  return Object.freeze({ ...pins.versions[version as keyof typeof pins.versions] });
}
export function windowsNodeProofCommand(program: string, args: readonly string[]): Buffer {
  const quote = (value: string) => `"${value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\+)$/, "$1$1")}"`;
  const text = [program, ...args].map(quote).join(" ");
  if (text.length >= 32767 || /\0/.test(text)) throw new Error("Invalid fixed Node proof arguments.");
  return Buffer.from(text + "\0", "utf16le");
}
/** The bootstrap remains below prepare()'s unchanged 16MiB cap and is never executed. */
export function compileWindowsNodeBootstrap(parent: string): Buffer {
  const vswhere = path.join(process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)", "Microsoft Visual Studio", "Installer", "vswhere.exe");
  const installation = execFileSync(vswhere, ["-latest", "-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-property", "installationPath"], { encoding: "utf8", timeout: 15_000 }).trim();
  const source = path.resolve("test/fixtures/experimental-windows-lpac.c"), output = path.join(parent, "bootstrap.exe"), object = path.join(parent, "bootstrap.obj");
  for (const value of [installation, source, output, object]) if (!value || /[%!^&|<>"\r\n]/.test(value)) throw new Error("The fixed native bootstrap requires an ordinary host toolchain path.");
  const command = path.join(parent, "compile-bootstrap.cmd");
  fs.writeFileSync(command, `@echo off\r\ncall "${path.join(installation, "VC", "Auxiliary", "Build", "vcvars64.bat")}" >nul\r\nif errorlevel 1 exit /b 1\r\ncl.exe /nologo /O1 /GS- /Zl /Fo"${object}" /Fe"${output}" "${source}" /link /NODEFAULTLIB /ENTRY:mainCRTStartup /SUBSYSTEM:CONSOLE kernel32.lib advapi32.lib\r\n`, { flag: "wx" });
  const built = spawnSync(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), ["/d", "/s", "/c", `""${command}""`],
    { encoding: "utf8", windowsVerbatimArguments: true, windowsHide: true, timeout: 60_000 });
  if (built.status !== 0) throw new Error("The fixed host bootstrap did not compile.");
  const bytes = fs.readFileSync(output);
  if (bytes.length < 2 || bytes.length > 16 * 1024 * 1024 || bytes.toString("ascii", 0, 2) !== "MZ") throw new Error("The fixed host bootstrap is not a bounded native PE image.");
  return bytes;
}

type NativeFunction = (...args: unknown[]) => unknown;
interface PinnedFile { file: string; bytes: number; unchanged(): void; close(): void }
function nativeChecks(api: WindowsLpacApi) {
  const koffi = createRequire(import.meta.url)("koffi") as typeof Koffi, kernel = koffi.load("kernel32.dll");
  const fn: Record<string, NativeFunction> = {};
  for (const prototype of [
    "void * __stdcall CreateFileW(const char16_t *name, uint32_t access, uint32_t share, void *security, uint32_t disposition, uint32_t flags, void *templateFile)",
    "int __stdcall GetFileInformationByHandle(void *file, void *information)", "int __stdcall CloseHandle(void *file)",
    "uint32_t __stdcall GetProcessId(void *process)",
    "int __stdcall QueryFullProcessImageNameW(void *process, uint32_t flags, void *image, _Inout_ uint32_t *size)",
    "int __stdcall CreateProcessW(const char16_t *program, void *command, void *processSecurity, void *threadSecurity, int inherit, uint32_t flags, void *environment, const char16_t *directory, void *startup, void *information)",
  ]) fn[/\b(\w+)\s*\(/.exec(prototype)![1]] = kernel.func(prototype) as NativeFunction;
  const advapi = koffi.load("advapi32.dll");
  for (const prototype of [
    "int __stdcall OpenProcessToken(void *process, uint32_t access, _Out_ void **token)",
    "int __stdcall GetTokenInformation(void *token, int kind, void *information, uint32_t size, _Out_ uint32_t *returned)",
  ]) fn[/\b(\w+)\s*\(/.exec(prototype)![1]] = advapi.func(prototype) as NativeFunction;
  return {
    createHostSuspended(program: string, command: Buffer, cwd: string, environment: Buffer): WindowsSuspendedProcess {
      const startup = Buffer.alloc(104), information = Buffer.alloc(24); startup.writeUInt32LE(104);
      // Same headless/Unicode/suspended CreateProcessW contract as LPAC, without its two security attributes.
      // dwFlags and all three std-handle fields stay zero; FALSE forbids inheriting any parent handles.
      let created: unknown;
      try { created = fn.CreateProcessW(program, command, null, null, 0, 0x08000404, environment, cwd, startup, information); }
      catch { throw new WindowsNodeHostCleanupError(); } // An FFI exception cannot prove that no process was created.
      if (!created) throw new Error("Native trusted-host Node startup creation failed.");
      return { process: information.readBigUInt64LE(0), thread: information.readBigUInt64LE(8), pid: information.readUInt32LE(16) };
    },
    verifyHost(process: WindowsHandle) {
      const tokens: unknown[] = [null];
      if (!fn.OpenProcessToken(process, 0x8, tokens)) throw new Error("The trusted-host startup token could not be inspected.");
      const token = tokens[0];
      if (typeof token !== "bigint" || token === 0n || token === 0xffffffffffffffffn) throw new WindowsNodeHostCleanupError();
      let failure: { error: unknown } | undefined;
      try {
        const value = Buffer.alloc(4), returned = [0];
        if (!fn.GetTokenInformation(token, 29, value, 4, returned) || returned[0] !== 4 || value.readUInt32LE() !== 0)
          throw new Error("The separate trusted-host startup control is not an ordinary host process.");
      } catch (error) { failure = { error }; }
      try { api.close(token); } catch { throw new WindowsNodeHostCleanupError(); }
      if (failure) throw failure.error;
    },
    pin(file: string, maximum: number): PinnedFile {
      const handle = fn.CreateFileW(file, 0x80000080, 1, null, 3, 0x00200000, null);
      if (typeof handle !== "bigint" || handle === 0n || handle === 0xffffffffffffffffn) throw new Error("The fixed Node proof asset could not be pinned.");
      const inspect = () => { const info = Buffer.alloc(52); if (!fn.GetFileInformationByHandle(handle, info)) throw new Error("The fixed Node proof asset could not be inspected."); return info; };
      try {
        const before = inspect(), bytes = ordinaryWindowsCommandAssetSize(before);
        if (bytes > maximum) throw new Error("The fixed Node proof asset exceeds its bound.");
        let open = true;
        return { file, bytes, unchanged() { if (!open || !stable(before, inspect())) throw new Error("A pinned Node proof asset changed."); },
          close() { if (!open) return; if (!fn.CloseHandle(handle)) throw new WindowsNodeProofCleanupError(); open = false; } };
      } catch (error) { if (!fn.CloseHandle(handle)) throw new WindowsNodeProofCleanupError(); throw error; }
    },
    image(process: WindowsHandle, pid: number, expected: string) {
      const buffer = Buffer.alloc(65536), size = [32768];
      if (Number(fn.GetProcessId(process)) !== pid || !fn.QueryFullProcessImageNameW(process, 0, buffer, size) || size[0] < 1 || size[0] > 32767)
        throw new Error("The suspended Node process identity could not be verified.");
      if (buffer.toString("utf16le", 0, size[0] * 2).toLowerCase() !== expected.toLowerCase()) throw new Error("The suspended process is not the exact staged Node image.");
    },
  };
}
function pinAncestors(file: string, api: WindowsLpacApi): WindowsHandle[] {
  if (!/^[A-Za-z]:\\/.test(file) || path.win32.basename(file).toLowerCase() !== "node.exe" || file.includes("/") || /[\0\r\n]/.test(file)) throw new Error("The Node proof requires explicit local NTFS assets.");
  const parsed = path.win32.parse(file);
  if (api.volumeFileSystem(parsed.root).toUpperCase() !== "NTFS") throw new Error("The Node proof requires NTFS.");
  const parts = path.win32.dirname(file).slice(parsed.root.length).split("\\").filter(Boolean), held: WindowsHandle[] = [];
  try {
    let ancestor = parsed.root; held.push(api.pinDirectory(ancestor));
    for (const part of parts) {
      if (part === "." || part === ".." || /[:<>"|?*\p{Cc}\p{Cf}]/u.test(part) || /[. ]$/.test(part)) throw new Error("The Node proof asset path is unsupported.");
      ancestor = path.win32.join(ancestor, part); held.push(api.pinDirectory(ancestor));
    }
    if (fs.realpathSync.native(file).toLowerCase() !== file.toLowerCase()) throw new Error("The Node proof asset has an alias or changed ancestry.");
    return held;
  } catch (error) {
    let closeFailed = false;
    for (const handle of held.reverse()) try { api.close(handle); } catch { closeFailed = true; }
    if (closeFailed) throw new WindowsNodeProofCleanupError();
    throw error;
  }
}
/** Hash pin and OpenJS Authenticode are separate requirements; existing Microsoft/PS trust remains untouched. */
function verifyOpenJs(file: string, pin: Readonly<NodePin>, api: WindowsLpacApi): void {
  const system = path.join(api.windowsDirectory(), "System32", "WindowsPowerShell", "v1.0"), modules = path.join(system, "Modules");
  const literal = (value: string) => `'${value.replace(/'/g, "''")}'`;
  const security = path.join(modules, "Microsoft.PowerShell.Security", "Microsoft.PowerShell.Security.psd1");
  const script = `$ErrorActionPreference='Stop'; Import-Module -Name ${literal(security)} -ErrorAction Stop; ` +
    `$signature=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath ${literal(file)}; ` +
    `if($signature.Status -ne 'Valid' -or $null -eq $signature.TimeStamperCertificate -or $signature.SignerCertificate.Subject -notmatch '(?:^|, )O=OpenJS Foundation(?:,|$)') { throw 'The pinned Node executable is not valid OpenJS-signed code.' }; ` +
    `$sha=[Security.Cryptography.SHA256]::Create(); try { $hash=[BitConverter]::ToString($sha.ComputeHash($signature.SignerCertificate.RawData)).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }; ` +
    `if($hash -ne '${pin.signerCertificateSha256}') { throw 'The pinned Node signing certificate differs.' };`;
  // This is a trusted host signature check, outside LPAC; no shell or CLR process is launched inside its private job.
  execFileSync(path.join(system, "powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], {
    env: { SystemRoot: api.windowsDirectory(), WINDIR: api.windowsDirectory(), PATH: path.join(api.windowsDirectory(), "System32"),
      TEMP: process.env.TEMP ?? system, TMP: process.env.TMP ?? system, PSModulePath: modules },
    timeout: 30_000, windowsHide: true, stdio: "pipe", maxBuffer: 16 * 1024,
  });
}
export class WindowsNodeProofCleanupError extends Error {
  constructor() { super("The Node proof could not verify complete cleanup; preserve its scratch and pinned assets."); this.name = "WindowsNodeProofCleanupError"; }
}
export interface WindowsNodeProof {
  fixture: ExperimentalWindowsLpacFixture;
  version: string;
  observations: { assigned: boolean; token: boolean; image: boolean; resumed: boolean };
  profile: { localAppData: string; temp: string };
  launch(): Promise<number>;
  /** Explicit trusted-host diagnostic only; it can never substitute for an LPAC result. Startup mode only. */
  hostStartup(): Promise<{ exitCode: number; jobStopped: true }>;
  /** Exact verified image/PID for optional diagnostics. No identity is released before root exit and job zero. */
  eventIdentity(): WindowsNodeEventIdentity;
  /** New diagnostic mode only. Root/job zero and parent-writer closure precede any output payload read. */
  readIoOutput(): Buffer;
  report(name: "direct.json" | "inprocess.json" | "child.json" | "failure.json" | "test.tap"): string | null;
  close(): Promise<void>;
}
export async function prepareWindowsNodeProof(input: { parent: string; bootstrap: Buffer; version: string; asset: string; mode: WindowsNodeProofMode; canary: string; port: number }, api = loadExperimentalWindowsLpacApi()): Promise<WindowsNodeProof> {
  if (input.canary !== path.join(input.parent, "host-only-canary.txt")) throw new Error("Use only the fixed disposable host canary for this proof.");
  if (process.platform !== "win32" || process.arch !== "x64" || !["startup", "startup-io", "direct", "inprocess", "child"].includes(input.mode) || !Number.isInteger(input.port) || input.port < 1 || input.port > 65535) throw new Error("Invalid bounded Windows Node proof configuration.");
  const withIo = input.mode === "startup-io";
  const pin = windowsNodeProofPin(input.version), reader = loadWindowsCommandAssetReader(), native = nativeChecks(api);
  const directoryPins = pinAncestors(input.asset, api), filePins: PinnedFile[] = [];
  let fixture: ExperimentalWindowsLpacFixture | undefined, profileSid = "", created: WindowsSuspendedProcess | undefined, privateJob: WindowsHandle | undefined;
  const profileCapture: { value?: WindowsLpacProfile } = {};
  let program = "", args: string[] = [], signatureVerified = false, closing: Promise<void> | undefined;
  let io: WindowsNodeIoOwner | undefined, ioUncertain = false;
  const unsafeIo = (error: unknown) => error instanceof WindowsNodeIoCleanupError || error instanceof ExperimentalWindowsCreateUncertain;
  let launchedAt: number | undefined;
  const startupGate = new WindowsNodeStartupGate();
  let expectedBootstrap = "", expectedWork = "", expectedState = "", expectedEnvironment: Buffer | undefined;
  const observations = { assigned: false, token: false, image: false, resumed: false };
  const profilePaths = { localAppData: "", temp: "" };
  const close = () => {
    startupGate.retire();
    return closing ??= (async () => {
      if (ioUncertain) throw new WindowsNodeProofCleanupError();
      // A host control has independent ownership. Unknown shutdown must retain the same staged assets and pins.
      try { await startupGate.hostCompletion; } catch (error) { if (error instanceof WindowsNodeProofCleanupError) throw error; }
      try { await fixture?.close(); } catch { throw new WindowsNodeProofCleanupError(); } // Unknown stop retains every asset pin and scratch.
      const failures: unknown[] = [];
      for (const file of filePins.slice().reverse()) try { file.close(); } catch (error) { failures.push(error); }
      for (const handle of directoryPins.slice().reverse()) try { api.close(handle); } catch (error) { failures.push(error); }
      if (failures.length) throw new WindowsNodeProofCleanupError();
    })();
  };
  const wrapped: WindowsLpacApi = { ...api,
    createProfile(name) {
      const profile = api.createProfile(name); profileSid = profile.sidText; profileCapture.value = profile; return profile;
    },
    createJob() { if (privateJob) throw new Error("One private job only."); return privateJob = api.createJob(); },
    deleteProfile(profile) {
      // Fixture disposal reaches this only after positive process/job cleanup (or before any process existed).
      // Close diagnostic IO before releasing its profile; an uncertain close retains every remaining asset pin.
      try { io?.close(); } catch { ioUncertain = true; throw new WindowsNodeProofCleanupError(); }
      api.deleteProfile(profile);
    },
    createSuspended(profile, bootstrapProgram, command, cwd, env) {
      if (!fixture || created || !signatureVerified || bootstrapProgram !== expectedBootstrap || !command.equals(windowsNodeProofCommand(expectedBootstrap, [])) || cwd !== expectedWork ||
        !expectedEnvironment || !env.equals(expectedEnvironment) || profile.sidText !== profileSid)
        throw new Error("The direct Node redirect rejected an unexpected bootstrap, argument or environment.");
      for (const file of filePins) file.unchanged();
      launchedAt = Date.now();
      try {
        created = io ? io.createLpac(profile, program, windowsNodeProofCommand(program, args), cwd, env)
          : api.createSuspended(profile, program, windowsNodeProofCommand(program, args), cwd, env);
      } catch (error) {
        if (unsafeIo(error)) { ioUncertain = true; throw new ExperimentalWindowsCreateUncertain("The separate Node IO creation is unverified; preserve its profile and assets."); }
        throw error;
      }
      return created;
    },
    assign(job, process) { if (!created || job !== privateJob || process !== created.process) throw new Error("Unexpected Node job assignment."); api.assign(job, process); observations.assigned = true; },
    verifyToken(profile, process) {
      if (!created || !observations.assigned || process !== created.process || profile.sidText !== profileSid) throw new Error("Unexpected Node token handle.");
      api.verifyToken(profile, process); observations.token = true;
      native.image(process, created.pid, program); for (const file of filePins) file.unchanged(); observations.image = true;
    },
    resume(thread) {
      if (!created || thread !== created.thread || !observations.assigned || !observations.token || !observations.image) throw new Error("Node cannot resume without exact identity, job and LPAC proofs.");
      for (const file of filePins) file.unchanged(); api.resume(thread); observations.resumed = true;
    },
  };
  try {
    const source = native.pin(input.asset, pin.executableBytes); filePins.push(source);
    const bytes = reader.read(input.asset); source.unchanged();
    if (source.bytes !== pin.executableBytes || bytes.length !== pin.executableBytes || digest(bytes) !== pin.executableSha256) throw new Error("The Windows Node executable does not match its official pin.");
    fixture = ExperimentalWindowsLpacFixture.prepare(input.parent, input.bootstrap, wrapped);
    const capturedProfile = profileCapture.value;
    if (!capturedProfile) throw new Error("The fresh Node profile identity was not captured.");
    expectedBootstrap = fixture.paths.program; expectedWork = fixture.paths.work; expectedState = fixture.paths.state;
    expectedEnvironment = experimentalWindowsEnvironment({ ...fixture.paths }, api.windowsDirectory(), api.profileLocalAppDataBase(capturedProfile));
    profilePaths.localAppData = path.join(api.profileLocalAppDataBase(capturedProfile), "Packages", capturedProfile.name, "AC");
    profilePaths.temp = path.join(profilePaths.localAppData, "Temp");
    const security = experimentalWindowsSddl(api.ownerSid(), profileSid, "read", false), writable = experimentalWindowsSddl(api.ownerSid(), profileSid, "modify", false);
    program = path.join(fixture.paths.tools, "node.exe"); api.writeNewFile(program, bytes, security); filePins.push(native.pin(program, pin.executableBytes));
    for (const name of ["windows-node-lpac-probe.cjs", "windows-node-lpac-inprocess.cjs"]) {
      const data = fs.readFileSync(path.resolve("test", "fixtures", name));
      if (!data.length || data.length > 32 * 1024) throw new Error("The fixed Node script exceeds its bound.");
      const file = path.join(fixture.paths.tools, name); api.writeNewFile(file, data, security); filePins.push(native.pin(file, 32 * 1024));
    }
    api.writeNewFile(path.join(fixture.paths.work, "copied.cjs"), Buffer.from(input.mode === "inprocess" ? "module.exports = 42;\n" : "module.exports = 41;\n"), writable);
    verifyOpenJs(program, pin, api);
    if (digest(reader.read(program)) !== pin.executableSha256) throw new Error("The staged Node image changed across its signature check.");
    signatureVerified = true;
    args = input.mode === "startup" || withIo ? [...WINDOWS_NODE_STARTUP_ARGS] : input.mode === "inprocess"
      ? ["--no-warnings", pin.isolationFlag, "--test-reporter=tap", `--test-reporter-destination=${path.join(fixture.paths.state, "test.tap")}`, "--test", path.join(fixture.paths.tools, "windows-node-lpac-inprocess.cjs")]
      : ["--no-warnings", path.join(fixture.paths.tools, "windows-node-lpac-probe.cjs"), input.mode, input.canary, String(input.port)];
    if (withIo) io = loadWindowsNodeIo(expectedState, capturedProfile, api);
    const prepared = fixture;
    return { fixture: prepared, version: pin.version, get observations() { return { ...observations }; }, profile: Object.freeze({ ...profilePaths }),
      launch: () => startupGate.launch(() => prepared.launch()),
      eventIdentity() {
        prepared.exitCode();
        if (!created || launchedAt === undefined) throw new Error("No stopped Node process identity is available.");
        return Object.freeze({ pid: created.pid, image: program, startedAt: launchedAt });
      },
      readIoOutput() {
        if (!withIo || !io || closing || ioUncertain) throw new Error("Output payload is available only in the open separate fixed IO diagnostic.");
        try { return io.readAfterStopped(() => { prepared.exitCode(); }); }
        catch (error) { if (unsafeIo(error)) { ioUncertain = true; throw new WindowsNodeProofCleanupError(); } throw error; }
      },
      hostStartup() {
        if (input.mode !== "startup" && !withIo) return Promise.reject(new Error("Use the separate trusted-host control only for the fixed startup probe before LPAC launch."));
        return startupGate.host(() => runWindowsNodeHostStartup({ program, command: windowsNodeProofCommand(program, args), cwd: expectedWork, environment: expectedEnvironment!,
          unchanged() { for (const file of filePins) file.unchanged(); } }, api, {
          create: (program, command, cwd, environment) => io ? io.createHost(program, command, cwd, environment) : native.createHostSuspended(program, command, cwd, environment),
          verify(created, expected) { native.image(created.process, created.pid, expected); native.verifyHost(created.process); },
        }).then(result => {
          if (io) { if (result.exitCode !== 0 || result.jobStopped !== true) throw new Error("The separate IO host control did not succeed."); io.acceptHostControl(); }
          return result;
        }).catch(error => {
          if (error instanceof WindowsNodeHostCleanupError || unsafeIo(error)) { ioUncertain = true; throw new WindowsNodeProofCleanupError(); }
          throw error;
        }));
      },
      report(name) {
        if (!["direct.json", "inprocess.json", "child.json", "failure.json", "test.tap"].includes(name)) throw new Error("Unknown fixed Node proof report.");
        prepared.exitCode(); // Every read requires the actual root+job-zero observation, not merely root exit.
        const file = path.join(expectedState, name);
        let reportPin: PinnedFile;
        try { reportPin = native.pin(file, name === "test.tap" ? 64 * 1024 : 16 * 1024); }
        catch (error) {
          if (error instanceof WindowsNodeProofCleanupError) throw error;
          if (!fs.existsSync(file)) return null;
          // eslint-disable-next-line preserve-caught-error -- Native diagnostics may expose private paths; retain only the typed cleanup witness above.
          throw new Error("The stopped Node report is not a bounded ordinary file.");
        }
        try { const data = reader.read(file); reportPin.unchanged(); return data.toString("utf8"); } finally { reportPin.close(); }
      }, close };
  } catch (error) { if (unsafeIo(error)) ioUncertain = true; await close(); throw error; }
}
