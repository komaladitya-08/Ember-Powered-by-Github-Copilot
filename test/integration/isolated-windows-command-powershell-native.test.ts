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
import { loadExperimentalWindowsLpacApi } from "../../app/main/agent/experimental-windows-lpac-api";

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
      staged = await prepareWindowsPowerShellProof(parent, { assetRoot, manifestSha256: manifest.sha256 });
      expect(staged.manifest).toEqual(manifest);
      const started = new Date().toISOString();
      const rootPid = await staged.fixture.launch(["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
      await staged.fixture.waitRootExited(60_000);
      const lease = await staged.fixture.waitStopped(15_000); lease.requireStopped();
      const exitCode = staged.fixture.exitCode();
      const runtime = boundedText(path.join(staged.fixture.paths.state, "runtime.json"));
      const command = boundedText(path.join(staged.fixture.paths.state, "command.json"));
      const failure = boundedText(path.join(staged.fixture.paths.state, "failure.txt"));
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
        throw new Error(`PowerShell is incompatible with this capability-free LPAC configuration: exit=0x${exitCode.toString(16)}, runtime=${runtime ?? "absent"}, command=${command ?? "absent"}, diagnostic=${failure ?? "absent"}, startupEvent=${startupEvent}. No ACL/capability/AppContainer fallback is permitted.`);
      }
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
