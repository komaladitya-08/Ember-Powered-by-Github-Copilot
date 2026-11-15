/**
 * Compatibility proof, not a coding gate: a configured Windows runner must run real PS7 in zero-capability LPAC.
 * The runner's Microsoft-signed, system-installed PS7 directory is the explicit trusted asset input. No PATH,
 * user/MSIX aliases, broad ACL changes, AppContainer fallback or network/registry/COM capabilities are accepted.
 * See MS Learn: /powershell/scripting/install/install-powershell-on-windows (ZIP portability) and
 * /windows/win32/secauthz/implementing-an-appcontainer (LPAC capabilities); neither promises PS7 LPAC compatibility.
 */
import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { measureWindowsPowerShellToolchain, prepareWindowsPowerShellProof } from "../../app/main/agent/isolated-windows-command-assets";
import { loadExperimentalWindowsLpacApi, type WindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";

const script = `$ErrorActionPreference='Stop';
$state=[Environment]::GetEnvironmentVariable('EMBER_LPAC_STATE');
$version=$PSVersionTable.PSVersion.ToString();
[IO.File]::WriteAllText([IO.Path]::Combine($state,'runtime.json'),'{"ok":true,"version":"'+$version+'"}');
try {
  $items=@(Get-ChildItem -LiteralPath $env:EMBER_LPAC_WORK -Force -ErrorAction Stop);
  [IO.File]::WriteAllText([IO.Path]::Combine($state,'command.json'),'{"ok":true,"entries":'+$items.Count+'}');
  exit 0;
} catch {
  [IO.File]::WriteAllText([IO.Path]::Combine($state,'failure.txt'),$_.Exception.ToString());
  exit 41;
}`;
function boundedText(file: string): string | null {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1024) throw new Error("The PS7 proof report is not a bounded ordinary file.");
    return fs.readFileSync(file, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

describe.skipIf(process.platform !== "win32")("isolated Windows PowerShell command compatibility", () => {
  it("copies the trusted system distribution, verifies the suspended zero-capability LPAC token/private job, and executes .NET IO plus a normal cmdlet", async () => {
    if (process.arch !== "x64") throw new Error("The configured PS7 LPAC proof currently requires Windows x64.");
    const api = loadExperimentalWindowsLpacApi();
    const assetRoot = path.join(process.env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7");
    const executable = path.join(assetRoot, "pwsh.exe");
    // Test setup vouches for the preinstalled distribution from the trusted hosted-runner image. A hash measured
    // from a model-selected directory is not a trust root. This host signature check never invokes that directory.
    const systemPowerShell = path.join(api.windowsDirectory(), "System32", "WindowsPowerShell", "v1.0");
    const windowsPowerShell = path.join(systemPowerShell, "powershell.exe"), systemModules = path.join(systemPowerShell, "Modules");
    const securityModule = path.join(systemModules, "Microsoft.PowerShell.Security", "Microsoft.PowerShell.Security.psd1").replace(/'/g, "''");
    const selected = executable.replace(/'/g, "''");
    // The workflow itself runs under PS7. Its inherited PSModulePath must never direct Windows PS5 to PS7 assemblies.
    const signatureEnvironment = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PSMODULEPATH"));
    signatureEnvironment.PSModulePath = systemModules;
    execFileSync(windowsPowerShell, ["-NoProfile", "-NonInteractive", "-Command",
      `$ErrorActionPreference='Stop'; Import-Module -Name '${securityModule}' -ErrorAction Stop; $s=Microsoft.PowerShell.Security\\Get-AuthenticodeSignature -LiteralPath '${selected}'; if($s.Status -ne 'Valid' -or $s.SignerCertificate.Subject -notmatch '(?:^|, )O=Microsoft Corporation(?:,|$)') { throw 'The configured system PowerShell toolchain is not Microsoft signed.' }`],
    { timeout: 30_000, windowsHide: true, stdio: "pipe", env: signatureEnvironment });
    const manifest = measureWindowsPowerShellToolchain(assetRoot);
    console.info("Trusted PS7 distribution snapshot", JSON.stringify({ root: assetRoot, ...manifest }));
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ember-ps7-lpac-"));
    let staged: Awaited<ReturnType<typeof prepareWindowsPowerShellProof>> | undefined;
    let cleanupSafe = true, failure: unknown;
    try {
      // Compile only this checked-in fixed diagnostic, using the already-vouched system PS7 runtime so its
      // references match the target CLR. Host compilation is not a model command and consumes no project input.
      const hookSource = path.resolve("test/fixtures/isolated-windows-command-startup-hook.cs").replace(/'/g, "''");
      const hookOutput = path.join(parent, "startup-hook.dll");
      const utilityModule = path.join(assetRoot, "Modules", "Microsoft.PowerShell.Utility", "Microsoft.PowerShell.Utility.psd1").replace(/'/g, "''");
      const compilerEnvironment: NodeJS.ProcessEnv = { ...signatureEnvironment, PSModulePath: path.join(assetRoot, "Modules") };
      for (const name of Object.keys(compilerEnvironment)) if (name.toUpperCase() === "DOTNET_STARTUP_HOOKS") delete compilerEnvironment[name];
      execFileSync(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command",
        `$ErrorActionPreference='Stop'; Import-Module -Name '${utilityModule}' -ErrorAction Stop; Microsoft.PowerShell.Utility\\Add-Type -Path '${hookSource}' -OutputAssembly '${hookOutput.replace(/'/g, "''")}' -OutputType Library -ErrorAction Stop;`],
      { timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true, stdio: "pipe", env: compilerEnvironment });
      const hookStat = fs.lstatSync(hookOutput);
      if (!hookStat.isFile() || hookStat.isSymbolicLink() || hookStat.nlink !== 1 || hookStat.size > 1024 * 1024) throw new Error("The fixed startup hook was not a bounded ordinary host-built assembly.");
      const hookBytes = fs.readFileSync(hookOutput);
      if (hookBytes.toString("ascii", 0, 2) !== "MZ") throw new Error("The fixed startup hook is not a managed PE assembly.");
      let copiedReadSecurity: string | undefined;
      const diagnosticApi: WindowsLpacApi = { ...api,
        writeNewFile(file, bytes, sddl) {
          api.writeNewFile(file, bytes, sddl);
          if (file.endsWith("\\tools\\fixture.exe")) copiedReadSecurity = sddl;
        },
        createSuspended(profile, program, command, cwd, environment) {
          const text = environment.toString("utf16le");
          if (!text.endsWith("\0\0")) throw new Error("The diagnostic requires the fixture's complete clean environment.");
          const values = text.slice(0, -2).split("\0");
          if (values.some(value => value.split("=", 1)[0].toUpperCase() === "DOTNET_STARTUP_HOOKS")) throw new Error("An ambient startup hook is not permitted.");
          values.push(`DOTNET_STARTUP_HOOKS=${path.join(path.dirname(program), "ember-startup-hook.dll")}`);
          values.sort((a, b) => a.toUpperCase().localeCompare(b.toUpperCase(), "en"));
          return api.createSuspended(profile, program, command, cwd, Buffer.from(values.join("\0") + "\0\0", "utf16le"));
        },
      };
      staged = await prepareWindowsPowerShellProof(parent, { assetRoot, manifestSha256: manifest.sha256 }, diagnosticApi);
      if (!copiedReadSecurity) throw new Error("The diagnostic hook requires the fixture's exact protected package read ACL.");
      api.writeNewFile(path.join(staged.fixture.paths.tools, "ember-startup-hook.dll"), hookBytes, copiedReadSecurity);
      console.info("Fixed host-built .NET StartupHook enabled for this diagnostic launch only.");
      expect(staged.manifest).toEqual(manifest);
      const started = new Date().toISOString();
      const rootPid = await staged.fixture.launch(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
      await staged.fixture.waitRootExited(60_000);
      const lease = await staged.fixture.waitStopped(15_000); lease.requireStopped();
      const exitCode = staged.fixture.exitCode();
      const runtime = boundedText(path.join(staged.fixture.paths.state, "runtime.json"));
      const command = boundedText(path.join(staged.fixture.paths.state, "command.json"));
      const failure = boundedText(path.join(staged.fixture.paths.state, "failure.txt"));
      const hook = boundedText(path.join(staged.fixture.paths.state, "startup-hook.json"));
      const managedException = boundedText(path.join(staged.fixture.paths.state, "startup-exception.txt"));
      if (exitCode !== 0 || runtime === null || command === null) {
        // Read host diagnostics only after the real stopped-writer lease. Never print another process's events:
        // the native event PID, exact fixture image name and bounded launch/stop interval must all match.
        const stopped = new Date().toISOString(), image = path.basename(staged.fixture.paths.program).replace(/'/g, "''");
        const diagnosticsModule = path.join(systemModules, "Microsoft.PowerShell.Diagnostics", "Microsoft.PowerShell.Diagnostics.psd1").replace(/'/g, "''");
        let startupEvent = "absent (no strictly matching event or query unavailable)";
        try {
          const query = `$ErrorActionPreference='Stop'; Import-Module -Name '${diagnosticsModule}' -ErrorAction Stop;
$begin=[DateTime]::Parse('${started}').ToUniversalTime(); $end=[DateTime]::Parse('${stopped}').ToUniversalTime();
$events=Microsoft.PowerShell.Diagnostics\\Get-WinEvent -FilterHashtable @{LogName='Application';ProviderName='.NET Runtime';Id=1026;StartTime=$begin;EndTime=$end} -MaxEvents 10 -ErrorAction Stop;
foreach($event in $events) {
  $xml=[xml]$event.ToXml();
  if([string]$xml.Event.System.Execution.ProcessID -eq '${rootPid}' -and $event.TimeCreated.ToUniversalTime() -ge $begin -and $event.TimeCreated.ToUniversalTime() -le $end) {
    $text=$event.Message;
    if($text -match ('(?im)^Application:\\s*'+[regex]::Escape('${image}')+'\\s*$')) {
      if($text.Length -gt 16384) { $text=$text.Substring(0,16384)+' [event truncated]'; }
      [Console]::WriteLine($text); break;
    }
  }
}`;
          const matching = execFileSync(windowsPowerShell, ["-NoProfile", "-NonInteractive", "-Command", query],
            { timeout: 10_000, maxBuffer: 64 * 1024, encoding: "utf8", windowsHide: true, stdio: "pipe", env: signatureEnvironment }).trim();
          if (matching) startupEvent = matching;
        } catch { /* A missing event or unavailable log never establishes the startup exception's cause. */ }
        throw new Error(`PowerShell is incompatible with this capability-free LPAC configuration: exit=0x${exitCode.toString(16)}, runtime=${runtime ?? "absent"}, command=${command ?? "absent"}, diagnostic=${failure ?? "absent"}, startupHook=${hook ?? "absent"}, managedException=${managedException ?? "absent"}, startupEvent=${startupEvent}. No ACL/capability/AppContainer fallback is permitted.`);
      }
      expect(hook).not.toBeNull();
      expect(JSON.parse(hook!)).toEqual({ installed: true });
      expect(managedException).toBeNull();
      expect(JSON.parse(runtime)).toMatchObject({ ok: true, version: expect.stringMatching(/^7\./) });
      expect(JSON.parse(command)).toEqual({ ok: true, entries: 0 });
    } catch (error) { failure = error; }
    if (staged) { try { await staged.close(); } catch (error) {
      cleanupSafe = false; console.error("Unverified PS7 LPAC shutdown; scratch preserved", parent);
      failure = new AggregateError([failure, error].filter(Boolean), "PS7 LPAC proof cleanup failed.");
    } }
    if (cleanupSafe) fs.rmSync(parent, { recursive: true, force: true });
    if (failure) throw failure;
  }, 180_000);
});
