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
    if (-not [IO.Path]::IsPathFullyQualified($program) -or -not [IO.File]::Exists($program)) { throw 'The host diagnostic executable is unavailable.' }
    if (-not [IO.Directory]::Exists($workingDirectory)) { throw 'The host diagnostic working directory is unavailable.' }
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
function Own-XmlEvent([Xml.XmlElement]$event, [int]$expectedPid) {
    $pidNode = $event.SelectSingleNode('PID'); $nameNode = $event.SelectSingleNode('Process_Name')
    return $null -ne $pidNode -and $null -ne $nameNode -and $pidNode.InnerText -eq [string]$expectedPid -and $nameNode.InnerText -eq 'fixture.exe'
}
function Write-OwnProcmonConfiguration([string]$file, [int]$expectedPid) {
    if ($expectedPid -le 0) { throw 'Invalid monitor configuration identity.' }
    # Performance/privacy reduction only, never the publication boundary. PMC is not a Microsoft stable API;
    # its record/rule layout is documented at github.com/eronnen/procmon-parser/blob/main/docs/PMC%20Format.md.
    # If Procmon ignores/changes this format, independent CSV/XML PID+image gates and size bounds still fail closed.
    $rulesStream = [IO.MemoryStream]::new(); $rules = [IO.BinaryWriter]::new($rulesStream)
    try {
        $rules.Write([byte]1); $rules.Write([uint32]2)
        foreach ($rule in @(@(40054, [string]$expectedPid, $expectedPid), @(40053, 'fixture.exe', 0))) {
            $value = [Text.Encoding]::Unicode.GetBytes([string]$rule[1] + [char]0)
            $rules.Write([uint32]$rule[0]); $rules.Write([uint32]0); $rules.Write([byte]1)
            $rules.Write([uint32]$value.Length); $rules.Write([byte[]]$value); $rules.Write([uint32]$rule[2]); $rules.Write([uint32]0)
        }
        $rules.Flush(); $rulesBytes = $rulesStream.ToArray()
    } finally { $rules.Dispose(); $rulesStream.Dispose() }
    $configStream = [IO.MemoryStream]::new(); $writer = [IO.BinaryWriter]::new($configStream)
    try {
        foreach ($record in @(@('FilterRules', $rulesBytes), @('DestructiveFilter', [byte[]]@(1, 0, 0, 0)))) {
            $name = [Text.Encoding]::Unicode.GetBytes([string]$record[0] + [char]0); $data = [byte[]]$record[1]
            $writer.Write([uint32](16 + $name.Length + $data.Length)); $writer.Write([uint32]16)
            $writer.Write([uint32](16 + $name.Length)); $writer.Write([uint32]$data.Length); $writer.Write([byte[]]$name); $writer.Write([byte[]]$data)
        }
        $writer.Flush(); $configuration = $configStream.ToArray()
        if ($configuration.Length -gt 2048) { throw 'The diagnostic filter exceeded its bound.' }
        [IO.File]::WriteAllBytes($file, $configuration)
    } finally { $writer.Dispose(); $configStream.Dispose() }
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
    [xml]$xmlControl = '<events><event><PID>4242</PID><Process_Name>fixture.exe</Process_Name></event><event><PID>4343</PID><Process_Name>fixture.exe</Process_Name></event><event><PID>4242</PID><Process_Name>other.exe</Process_Name></event></events>'
    $xmlFiltered = @($xmlControl.events.event | Where-Object { Own-XmlEvent $_ 4242 })
    if ($xmlFiltered.Count -ne 1) { throw 'The stack publication filter failed.' }
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
    # Windows can expose more than one application match for an extensionless command. Never coerce a collection
    # of Source paths to one space-joined executable name; select the first explicit executable chosen by PATH.
    $nodeCandidates = @(Get-Command node.exe -CommandType Application -All)
    if ($nodeCandidates.Count -lt 1 -or $nodeCandidates.Count -gt 20) { throw 'A bounded host Node executable could not be selected.' }
    $nodeProgram = [string]$nodeCandidates[0].Source
    if ([IO.Path]::GetFileName($nodeProgram) -ne 'node.exe') { throw 'The selected host runtime is not Node.' }
    Write-Output ([ordered]@{ hostNodeCandidates = $nodeCandidates.Count; hostNode = Safe-Path $nodeProgram } | ConvertTo-Json -Compress)
    $earlierHandshake = [Environment]::GetEnvironmentVariable('EMBER_LPAC_TRACE_HANDSHAKE', 'Process')
    [Environment]::SetEnvironmentVariable('EMBER_LPAC_TRACE_HANDSHAKE', $traceRoot, 'Process')
    try { $testProcess = Start-Logged $nodeProgram @('scripts/run-integration.mjs', 'test/integration/experimental-windows-lpac-native.test.ts') 'fixture' $env:GITHUB_WORKSPACE }
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

    # Compile/host setup precedes capture: tracing the compiler generated hundreds of thousands of unrelated rows
    # and exhausted bounded stack export. The verified fixture remains suspended until the monitor is ready.
    $phase = 'capture'
    $pml = [IO.Path]::Combine($traceRoot, 'private.pml')
    $configuration = [IO.Path]::Combine($traceRoot, 'own-fixture.pmc')
    Write-OwnProcmonConfiguration $configuration $fixturePid
    $capture = Start-Logged $toolExe @('/AcceptEula', '/Quiet', '/Minimized', '/LoadConfig', $configuration, '/BackingFile', $pml, '/Runtime', '20') 'capture'
    $monitorStarted = $true
    $phase = 'capture-ready'
    $idle = Start-Logged $toolExe @('/AcceptEula', '/Quiet', '/WaitForIdle') 'idle'
    if ((Wait-Bounded $idle 15000) -ne 0) { throw 'The monitor did not become ready.' }
    Start-Sleep -Milliseconds 1000
    $phase = 'fixture-resume'
    [IO.File]::WriteAllText([IO.Path]::Combine($traceRoot, 'ready'), 'ready')
    $rootExited = $fixtureProcess.WaitForExit(10000)
    $rootExitCode = if ($rootExited) { $fixtureProcess.ExitCode } else { $null }
    $fixtureProcess.Dispose(); $fixtureProcess = $null
    Start-Sleep -Milliseconds 1000
    $phase = 'capture-stop'
    $terminate = Start-Logged $toolExe @('/AcceptEula', '/Quiet', '/Terminate') 'terminate'
    Wait-Bounded $terminate 15000 | Out-Null
    Wait-Bounded $capture 15000 | Out-Null
    $phase = 'fixture-stop'
    $testExit = Wait-Bounded $testProcess 60000
    if (-not [IO.File]::Exists($pml) -or (Get-Item -LiteralPath $pml).Length -lt 64 -or (Get-Item -LiteralPath $pml).Length -gt 256MB) { throw 'The monitor did not finalize a bounded trace.' }

    $phase = 'export-and-filter'
    $csv = [IO.Path]::Combine($traceRoot, 'private.csv')
    $export = Start-Logged $toolExe @('/AcceptEula', '/Quiet', '/Minimized', '/OpenLog', $pml, '/LoadConfig', $configuration, '/SaveApplyFilter', '/SaveAs', $csv) 'export'
    if ((Wait-Bounded $export 30000) -ne 0 -or -not [IO.File]::Exists($csv) -or (Get-Item -LiteralPath $csv).Length -gt 128MB) { throw 'The monitor did not export a bounded trace.' }
    $csvRows = 0; $ownPidRows = 0; $ownImageRows = 0; $csvSchemaValid = $true
    $own = @(Import-Csv -LiteralPath $csv | ForEach-Object {
        $csvRows++
        if ($csvRows -eq 1) {
            $columns = @($_.PSObject.Properties.Name)
            foreach ($column in @('PID', 'Process Name', 'Operation', 'Result', 'Path')) {
                if ($column -notin $columns) { $csvSchemaValid = $false }
            }
        }
        if ($csvSchemaValid) {
            if ([string]$_.PID -eq [string]$fixturePid) { $ownPidRows++ }
            if ([string]$_.'Process Name' -eq 'fixture.exe') { $ownImageRows++ }
            $_
        }
    } | Own-FixtureRows -expectedPid $fixturePid)
    # Counts and expected-schema presence reveal capture/parsing failures without publishing a single rejected row.
    Write-Output ([ordered]@{ csvRows = $csvRows; csvSchemaValid = $csvSchemaValid; ownPidRows = $ownPidRows; ownImageRows = $ownImageRows; ownRows = $own.Count; rootExited = $rootExited; rootExitCode = $rootExitCode } | ConvertTo-Json -Compress)
    if ($own.Count -eq 0 -or $own.Count -gt 10000) { throw 'The trace contains no bounded own-fixture control.' }
    # Raw CSV/PML and all detail/command-line/value fields remain private and are deleted. Only exact PID+image
    # rows are published, using a narrow field list; registry contents and unrelated processes never enter output.
    Write-Output ([ordered]@{ fixturePid = $fixturePid; image = 'fixture.exe'; kernel = [Environment]::OSVersion.Version.ToString(); rootExited = $rootExited; testExit = $testExit; ownEvents = $own.Count } | ConvertTo-Json -Compress)
    $denied = @($own | Where-Object { $_.Result -eq 'ACCESS DENIED' } | Select-Object -First 100)
    foreach ($row in $denied) {
        Write-Output ([ordered]@{ operation = [string]$row.Operation; result = 'ACCESS DENIED'; path = Safe-Path ([string]$row.Path) } | ConvertTo-Json -Compress)
    }
    if ($denied.Count -eq 0) { Write-Output 'No own-fixture filesystem/registry ACCESS DENIED rows were observed; this does not identify every kernel-object denial.' }

    # /SaveAs1 includes recorded frames without requesting remote symbol resolution. Bound the XML on disk and
    # in its parser; never deserialize processlist, Detail, registry contents or rejected events into public output.
    $phase = 'stack-export'
    $xml = [IO.Path]::Combine($traceRoot, 'private.xml')
    $stackExport = Start-Logged $toolExe @('/AcceptEula', '/Quiet', '/Minimized', '/OpenLog', $pml, '/LoadConfig', $configuration, '/SaveApplyFilter', '/SaveAs1', $xml) 'stack-export'
    $stackExit = Wait-Bounded $stackExport 60000
    $stackBytes = if ([IO.File]::Exists($xml)) { (Get-Item -LiteralPath $xml).Length } else { 0 }
    Write-Output ([ordered]@{ stackExportExit = $stackExit; stackXmlBytes = $stackBytes } | ConvertTo-Json -Compress)
    if ($stackExit -ne 0 -or $stackBytes -le 0 -or $stackBytes -gt 128MB) { throw 'The monitor did not export bounded stacks.' }
    $settings = [Xml.XmlReaderSettings]::new()
    $settings.DtdProcessing = [Xml.DtdProcessing]::Prohibit; $settings.XmlResolver = $null; $settings.MaxCharactersInDocument = 128MB
    $reader = [Xml.XmlReader]::Create($xml, $settings); $ownStacks = 0
    try {
        while ($reader.Read()) {
            if ($reader.NodeType -ne [Xml.XmlNodeType]::Element -or $reader.LocalName -ne 'event') { continue }
            $subtree = $reader.ReadSubtree()
            try { $document = [Xml.XmlDocument]::new(); $document.XmlResolver = $null; $document.Load($subtree) }
            finally { $subtree.Dispose() }
            $event = $document.DocumentElement
            if (-not (Own-XmlEvent $event $fixturePid)) { continue }
            $resultNode = $event.SelectSingleNode('Result')
            if ($null -eq $resultNode -or $resultNode.InnerText -ne 'ACCESS DENIED') { continue }
            $operationNode = $event.SelectSingleNode('Operation'); $pathNode = $event.SelectSingleNode('Path')
            if ($null -eq $operationNode -or $null -eq $pathNode) { throw 'The own-event stack schema is incomplete.' }
            # Focus the bounded stack budget on observed process-creation dependencies, rather than repeated
            # early startup/localization probes which would otherwise consume all ten slots before IFEO.
            if ($pathNode.InnerText -notmatch '\\Image File Execution Options$|\\Safer\\CodeIdentifiers$|\\Session Manager\\(?:NamespaceSeparation|Memory Management)$') { continue }
            $frames = @($event.SelectNodes('stack/frame') | Select-Object -First 32 | ForEach-Object {
                $moduleNode = $_.SelectSingleNode('path'); $locationNode = $_.SelectSingleNode('location')
                [ordered]@{ module = if ($moduleNode) { Safe-Path ([IO.Path]::GetFileName($moduleNode.InnerText)) } else { '<unresolved>' }; location = if ($locationNode) { Safe-Path $locationNode.InnerText } else { '<unresolved>' } }
            })
            Write-Output ([ordered]@{ stackOperation = Safe-Path $operationNode.InnerText; path = Safe-Path $pathNode.InnerText; frames = $frames } | ConvertTo-Json -Compress -Depth 5)
            $ownStacks++
            if ($ownStacks -ge 10) { break }
        }
    } finally { $reader.Dispose() }
    Write-Output ([ordered]@{ ownDeniedStacks = $ownStacks } | ConvertTo-Json -Compress)
} catch {
    # Do not print a raw tool/CSV exception, which could contain unrelated capture data.
    Write-Output ('The bounded own-fixture trace failed during ' + $phase + '; no raw trace was published.')
    # These are type names and numeric source positions/codes, never exception messages, tool output or trace fields.
    $diagnostic = [ordered]@{ exceptionType = $_.Exception.GetType().Name; scriptLine = $_.InvocationInfo.ScriptLineNumber; testExit = $testExit }
    if ($_.Exception -is [ComponentModel.Win32Exception]) { $diagnostic.win32Error = $_.Exception.NativeErrorCode }
    if ($phase -eq 'fixture-launch' -and -not $monitorStarted) {
        # Only the fixed host Node launch can reach this branch, before a capture exists. Its masked setup error is
        # not helper output or captured process data; it cannot contain a trace row or unrelated command argument.
        $diagnostic.hostLaunchError = Safe-Path $_.Exception.Message
    }
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
