# Disposable hosted-CI diagnostic only. No product capability/ACL changes; no raw trace is printed or uploaded.
# Microsoft CLI reference: https://learn.microsoft.com/en-us/troubleshoot/windows-client/shell-experience/troubleshoot-apps-start-failure-use-process-monitor
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or [string]::IsNullOrEmpty($env:RUNNER_TEMP) -or [string]::IsNullOrEmpty($env:GITHUB_WORKSPACE)) {
    throw 'This diagnostic requires a disposable hosted Windows CI runner.'
}
$traceRoot = [IO.Path]::Combine($env:RUNNER_TEMP, 'ember-lpac-trace-' + [guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($traceRoot) | Out-Null
$launched = [Collections.Generic.List[Diagnostics.Process]]::new()
$phase = 'setup'; $failed = $false; $cleanupFailed = $false; $testExit = 1; $toolExe = $null; $fixtureProcess = $null
$toolVerified = $false; $monitorStarted = $false

function Start-Logged([string]$program, [string[]]$commandArguments, [string]$label, [string]$workingDirectory = $traceRoot) {
    $quoted = foreach ($argument in $commandArguments) {
        if ($argument -match '["\x00-\x1f]' -or $argument.EndsWith('\')) { throw 'Unsupported diagnostic argument.' }
        '"' + $argument + '"'
    }
    $childProcess = Start-Process -FilePath $program -ArgumentList ($quoted -join ' ') -WorkingDirectory $workingDirectory -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput ([IO.Path]::Combine($traceRoot, $label + '.stdout')) `
        -RedirectStandardError ([IO.Path]::Combine($traceRoot, $label + '.stderr'))
    $launched.Add($childProcess)
    return $childProcess
}
function Wait-Bounded([Diagnostics.Process]$childProcess, [int]$milliseconds) {
    if (-not $childProcess.WaitForExit($milliseconds)) {
        $childProcess.Kill($true); $childProcess.WaitForExit(5000) | Out-Null
        throw 'A diagnostic helper exceeded its deadline.'
    }
    return $childProcess.ExitCode
}
function Own-FixtureRows {
    param([Parameter(ValueFromPipeline)]$row, [int]$expectedPid)
    process {
        if ([string]$row.PID -eq [string]$expectedPid -and [string]$row.'Process Name' -eq 'fixture.exe') { $row }
    }
}
function Safe-Path([string]$value) {
    foreach ($prefix in @($env:USERPROFILE, $env:RUNNER_TEMP, $env:GITHUB_WORKSPACE)) {
        if (-not [string]::IsNullOrEmpty($prefix)) { $value = $value.Replace($prefix, '<ci-private>', [StringComparison]::OrdinalIgnoreCase) }
    }
    $value = [regex]::Replace($value, '[\x00-\x1f\x7f]', '?')
    if ($value.Length -gt 1200) { return $value.Substring(0, 1200) + '<bounded>' }
    return $value
}

try {
    # A negative control ensures no row from another PID or image survives the publication filter.
    $control = @(
        [pscustomobject]@{ PID = '4242'; 'Process Name' = 'fixture.exe'; Path = 'owned' },
        [pscustomobject]@{ PID = '4343'; 'Process Name' = 'fixture.exe'; Path = 'unrelated' },
        [pscustomobject]@{ PID = '4242'; 'Process Name' = 'other.exe'; Path = 'unrelated' }
    )
    $filtered = @($control | Own-FixtureRows -expectedPid 4242)
    if ($filtered.Count -ne 1 -or $filtered[0].Path -ne 'owned') { throw 'The trace publication filter failed.' }
    if (@(Get-Process -Name 'Procmon*' -ErrorAction SilentlyContinue).Count -ne 0) { throw 'Another monitor is already running.' }

    $phase = 'download-and-verify'
    $pin = Get-Content -LiteralPath ([IO.Path]::Combine($PSScriptRoot, 'windows-lpac-procmon-pin.json')) -Raw | ConvertFrom-Json
    if ($pin.url -ne 'https://download.sysinternals.com/files/ProcessMonitor.zip') { throw 'Unexpected diagnostic source.' }
    $archive = [IO.Path]::Combine($traceRoot, 'procmon.zip')
    Invoke-WebRequest -Uri $pin.url -OutFile $archive -TimeoutSec 30
    if ((Get-Item -LiteralPath $archive).Length -gt 16MB -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.archiveSha256) { throw 'The monitor archive did not match its pin.' }
    Expand-Archive -LiteralPath $archive -DestinationPath ([IO.Path]::Combine($traceRoot, 'tool'))
    $toolExe = [IO.Path]::Combine($traceRoot, 'tool', 'Procmon64.exe')
    if ((Get-FileHash -LiteralPath $toolExe -Algorithm SHA256).Hash.ToLowerInvariant() -ne $pin.executableSha256) { throw 'The monitor executable did not match its pin.' }
    $signature = Get-AuthenticodeSignature -LiteralPath $toolExe
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') { throw 'The monitor is not validly Microsoft signed.' }
    $toolVerified = $true

    $phase = 'fixture-launch'
    $earlierHandshake = [Environment]::GetEnvironmentVariable('EMBER_LPAC_TRACE_HANDSHAKE', 'Process')
    [Environment]::SetEnvironmentVariable('EMBER_LPAC_TRACE_HANDSHAKE', $traceRoot, 'Process')
    try { $testProcess = Start-Logged (Get-Command node -CommandType Application).Source @('scripts/run-integration.mjs', 'test/integration/experimental-windows-lpac-native.test.ts') 'fixture' $env:GITHUB_WORKSPACE }
    finally { [Environment]::SetEnvironmentVariable('EMBER_LPAC_TRACE_HANDSHAKE', $earlierHandshake, 'Process') }
    $phase = 'fixture-handshake'
    $metadataFile = [IO.Path]::Combine($traceRoot, 'fixture.json')
    $deadline = [DateTime]::UtcNow.AddSeconds(80)
    while (-not [IO.File]::Exists($metadataFile)) {
        if ($testProcess.HasExited) { $testExit = $testProcess.ExitCode; throw 'The suspended fixture handshake was unavailable.' }
        if ([DateTime]::UtcNow -gt $deadline) { throw 'The suspended fixture handshake was unavailable.' }
        Start-Sleep -Milliseconds 50
    }
    if ((Get-Item -LiteralPath $metadataFile).Length -gt 1024) { throw 'The fixture metadata exceeded its bound.' }
    $metadata = Get-Content -LiteralPath $metadataFile -Raw | ConvertFrom-Json
    $fixturePid = [int]$metadata.pid
    if ($fixturePid -le 0 -or $metadata.image -ne 'fixture.exe') { throw 'Invalid fixture identity.' }
    $phase = 'fixture-identify'
    # Module enumeration is not valid before a suspended process initializes its loader. Query the kernel image
    # through its retained handle instead; no memory dump or unrelated process enumeration is needed.
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class EmberLpacTraceImage {
    [DllImport("kernel32.dll", ExactSpelling=true, CharSet=CharSet.Unicode, SetLastError=true)]
    [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageNameW(IntPtr process, uint flags, StringBuilder text, ref uint size);
    public static string Read(IntPtr process) {
        uint size=32768; var text=new StringBuilder((int)size);
        if (!QueryFullProcessImageNameW(process,0,text,ref size)) throw new InvalidOperationException("Cannot identify suspended fixture.");
        return text.ToString();
    }
}
'@
    $fixtureProcess = [Diagnostics.Process]::GetProcessById($fixturePid)
    $fixtureImage = [EmberLpacTraceImage]::Read($fixtureProcess.Handle)
    if ([IO.Path]::GetFileName($fixtureImage) -ne 'fixture.exe') { throw 'The fixture image does not match.' }

    $phase = 'capture'
    $pml = [IO.Path]::Combine($traceRoot, 'private.pml')
    $capture = Start-Logged $toolExe @('/AcceptEula', '/Quiet', '/Minimized', '/BackingFile', $pml, '/Runtime', '20') 'capture'
    $monitorStarted = $true
    $phase = 'capture-ready'
    $idle = Start-Logged $toolExe @('/AcceptEula', '/Quiet', '/WaitForIdle') 'idle'
    if ((Wait-Bounded $idle 15000) -ne 0) { throw 'The monitor did not become ready.' }
    [IO.File]::WriteAllText([IO.Path]::Combine($traceRoot, 'ready'), 'ready')
    $rootExited = $fixtureProcess.WaitForExit(10000)
    $fixtureProcess.Dispose(); $fixtureProcess = $null
    $phase = 'capture-stop'
    $terminate = Start-Logged $toolExe @('/AcceptEula', '/Quiet', '/Terminate') 'terminate'
    Wait-Bounded $terminate 15000 | Out-Null
    Wait-Bounded $capture 15000 | Out-Null
    $phase = 'fixture-stop'
    $testExit = Wait-Bounded $testProcess 60000
    if (-not [IO.File]::Exists($pml) -or (Get-Item -LiteralPath $pml).Length -lt 64 -or (Get-Item -LiteralPath $pml).Length -gt 256MB) { throw 'The monitor did not finalize a bounded trace.' }

    $phase = 'export-and-filter'
    $csv = [IO.Path]::Combine($traceRoot, 'private.csv')
    $export = Start-Logged $toolExe @('/AcceptEula', '/Quiet', '/Minimized', '/OpenLog', $pml, '/SaveAs', $csv) 'export'
    if ((Wait-Bounded $export 30000) -ne 0 -or -not [IO.File]::Exists($csv) -or (Get-Item -LiteralPath $csv).Length -gt 128MB) { throw 'The monitor did not export a bounded trace.' }
    $own = @(Import-Csv -LiteralPath $csv | Own-FixtureRows -expectedPid $fixturePid)
    if ($own.Count -eq 0 -or $own.Count -gt 10000) { throw 'The trace contains no bounded own-fixture control.' }
    # Raw CSV/PML and all detail/command-line/value fields remain private and are deleted. Only exact PID+image
    # rows are published, using a narrow field list; registry contents and unrelated processes never enter output.
    Write-Output ([ordered]@{ fixturePid = $fixturePid; image = 'fixture.exe'; kernel = [Environment]::OSVersion.Version.ToString(); rootExited = $rootExited; testExit = $testExit; ownEvents = $own.Count } | ConvertTo-Json -Compress)
    $denied = @($own | Where-Object { $_.Result -eq 'ACCESS DENIED' } | Select-Object -First 100)
    foreach ($row in $denied) {
        Write-Output ([ordered]@{ operation = [string]$row.Operation; result = 'ACCESS DENIED'; path = Safe-Path ([string]$row.Path) } | ConvertTo-Json -Compress)
    }
    if ($denied.Count -eq 0) { Write-Output 'No own-fixture filesystem/registry ACCESS DENIED rows were observed; this does not identify every kernel-object denial.' }
} catch {
    # Do not print a raw tool/CSV exception, which could contain unrelated capture data.
    Write-Output ('The bounded own-fixture trace failed during ' + $phase + '; no raw trace was published.')
    # These are type names and numeric source positions/codes, never exception messages, tool output or trace fields.
    $diagnostic = [ordered]@{ exceptionType = $_.Exception.GetType().Name; scriptLine = $_.InvocationInfo.ScriptLineNumber; testExit = $testExit }
    if ($_.Exception -is [ComponentModel.Win32Exception]) { $diagnostic.win32Error = $_.Exception.NativeErrorCode }
    Write-Output ($diagnostic | ConvertTo-Json -Compress)
    $failed = $true
} finally {
    if ($fixtureProcess) { try { $fixtureProcess.Dispose() } catch { $cleanupFailed = $true } }
    if ($toolVerified -and $monitorStarted -and [IO.File]::Exists($toolExe)) {
        try { $stop = Start-Logged $toolExe @('/AcceptEula', '/Quiet', '/Terminate') 'final-stop'; Wait-Bounded $stop 10000 | Out-Null } catch { $cleanupFailed = $true }
    }
    foreach ($childProcess in $launched) {
        try {
            if (-not $childProcess.HasExited) { $childProcess.Kill($true); if (-not $childProcess.WaitForExit(5000)) { $cleanupFailed = $true } }
            $childProcess.Dispose()
        } catch { $cleanupFailed = $true }
    }
    try { Remove-Item -LiteralPath $traceRoot -Recurse -Force } catch { $cleanupFailed = $true }
}
if ($cleanupFailed) { throw 'Diagnostic cleanup was incomplete; raw data was not uploaded.' }
if ($failed) { throw 'The bounded own-fixture trace did not complete.' }
if ($testExit -ne 0) { throw 'The native fixture failed; only filtered diagnostic evidence was published.' }
