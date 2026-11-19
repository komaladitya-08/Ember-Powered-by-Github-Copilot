# Ember's Windows UI Automation bridge: the bootstrap (protocol: PROTOCOL.md beside this file).
#
# Ember's accessibility host starts it with
#   powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ember_uia.ps1
# It only gets ember_uia.cs compiled (or loads the cached build) and hands stdin and stdout to it. Screen data never
# passes through PowerShell: module logging, script block logging and transcription record what goes through cmdlets
# and the pipeline, so everything the bridge reads stays inside the C# code. Keep this file ASCII: Windows PowerShell
# 5.1 reads a file without a byte-order mark in the ANSI code page.

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# Optional external-harness startup milestones only; never screen data or stdout.
function Observe-Startup([int]$Stage) {
  try {
    if ($env:EMBER_UIA_STARTUP_OBSERVE -ceq '1' -and $Stage -ge 1 -and $Stage -le 30) {
      $bytes = [Text.Encoding]::ASCII.GetBytes('EMBER_UIA_STARTUP_V1:' + $Stage.ToString([Globalization.CultureInfo]::InvariantCulture) + "`n")
      $err = [Console]::OpenStandardError(); $err.Write($bytes, 0, $bytes.Length); $err.Flush()
    }
  } catch { <# Observation must not replace a bootstrap operation or its error. #> }
}

# The one line written before the bridge runs: why it couldn't start. Constrained Language Mode (AppLocker, WDAC,
# __PSLockdownPolicy) blocks Add-Type and the .NET calls below, so the pipeline is the fallback. Never screen data.
function Write-Fatal([string]$Message) {
  $text = (($Message -replace '[^\x20-\x7E]', ' ') -replace '\\', '\\') -replace '"', '\"'
  $line = '{"fatal":"' + $text + '","languageMode":"' + [string]$ExecutionContext.SessionState.LanguageMode + '"}'
  try {
    $bytes = [Text.Encoding]::ASCII.GetBytes($line + "`n")
    $out = [Console]::OpenStandardOutput()
    $out.Write($bytes, 0, $bytes.Length)
    $out.Flush()
  } catch {
    Write-Output $line
  }
}

function Get-Sha256([byte[]]$Bytes, [switch]$ObserveSource) {
  if ($ObserveSource) { Observe-Startup 27 }
  $digest = [Security.Cryptography.SHA256]::Create().ComputeHash($Bytes)
  if ($ObserveSource) { Observe-Startup 28 }
  ([BitConverter]::ToString($digest) -replace '-', '').ToLowerInvariant()
}

# Puts a finished file in the cache in one step (another bridge may get there first, which is fine). PowerShell
# would pass $null to a .NET string parameter as "", which File.Replace refuses, hence [NullString]::Value.
function Set-CacheFile([string]$From, [string]$To) {
  if ([IO.File]::Exists($To)) { [IO.File]::Replace($From, $To, [NullString]::Value) } else { [IO.File]::Move($From, $To) }
}

try {
  Observe-Startup 1
  # Compiled with -LiteralPath below: Add-Type's -Path takes [ and ] in the install folder for wildcards.
  $source = [IO.Path]::Combine($PSScriptRoot, 'ember_uia.cs')
  Observe-Startup 26
  $hash = Get-Sha256 ([IO.File]::ReadAllBytes($source)) -ObserveSource
  Observe-Startup 2
  Observe-Startup 3
  $utilityModule = [IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')
  Import-Module -Name $utilityModule -ErrorAction Stop
  Observe-Startup 29
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
  Observe-Startup 30
  $refs = @(
    [System.Windows.Automation.AutomationElement].Assembly.Location,
    [System.Windows.Automation.ControlType].Assembly.Location,
    [System.Windows.Rect].Assembly.Location
  )
  Observe-Startup 4
  $assembly = $null
  # .NET resolves a relative path against the process's directory, not PowerShell's: make it absolute first.
  $cache = $null
  if ($env:EMBER_UIA_CACHE) { try { $cache = [IO.Path]::GetFullPath($env:EMBER_UIA_CACHE) } catch { <# unusable: from memory #> } }
  Observe-Startup 5
  if ($cache) {
    $dll = [IO.Path]::Combine($cache, ('ember_uia-' + $hash + '.dll'))
    $sum = $dll + '.sha256'
    # Loaded from bytes checked against the hash written beside them: a half-written, replaced, locked or unloadable
    # file is compiled again, and the file is never locked or refused for a Mark-of-the-Web.
    if ([IO.File]::Exists($dll) -and [IO.File]::Exists($sum)) {
      try {
        Observe-Startup 6
        $bytes = [IO.File]::ReadAllBytes($dll)
        if ((Get-Sha256 $bytes) -eq [IO.File]::ReadAllText($sum).Trim()) { $assembly = [Reflection.Assembly]::Load($bytes); Observe-Startup 7 }
      } catch { $assembly = $null }
    }
    if ($null -eq $assembly) {
      $tmp = [IO.Path]::Combine($cache, ('ember_uia-' + $hash + '.' + $PID + '.tmp'))
      try {
        Observe-Startup 8
        [void][IO.Directory]::CreateDirectory($cache)
        # Builds of other versions are never needed again (nothing holds a build open: they load from bytes). Another
        # bridge may be compiling this version right now, so this version's temporary files go only when stale.
        $stale = [DateTime]::UtcNow.AddMinutes(-10)
        foreach ($old in [IO.Directory]::GetFiles($cache, 'ember_uia-*')) {
          $name = [IO.Path]::GetFileName($old)
          try {
            $mine = $name.StartsWith('ember_uia-' + $hash + '.', [StringComparison]::Ordinal)
            if (-not $mine -or ($name.Contains('.tmp.') -and [IO.File]::GetLastWriteTimeUtc($old) -lt $stale)) { [IO.File]::Delete($old) }
          } catch { <# in use, read-only or already gone: harmless to leave #> }
        }
        Observe-Startup 9
        Add-Type -LiteralPath $source -ReferencedAssemblies $refs -OutputAssembly ($tmp + '.dll') -OutputType Library -IgnoreWarnings
        Observe-Startup 10
        $bytes = [IO.File]::ReadAllBytes($tmp + '.dll')
        Observe-Startup 11
        $assembly = [Reflection.Assembly]::Load($bytes)
        Observe-Startup 12
        [IO.File]::WriteAllText($tmp + '.sha256', (Get-Sha256 $bytes))
        Set-CacheFile ($tmp + '.sha256') $sum
        [IO.File]::WriteAllBytes($tmp + '.part', $bytes)
        Set-CacheFile ($tmp + '.part') $dll
      } catch {
        # The cache can't be written (or another bridge is writing it): run from memory this time.
      } finally {
        foreach ($ext in @('.dll', '.sha256', '.part')) {
          try { [IO.File]::Delete($tmp + $ext) } catch { <# still loaded by Add-Type: removed on a later start #> }
        }
      }
    }
  }
  if ($null -eq $assembly) {
    Observe-Startup 13
    $types = @(Add-Type -LiteralPath $source -ReferencedAssemblies $refs -IgnoreWarnings -PassThru)
    $assembly = $types[0].Assembly
    Observe-Startup 14
  }
  Observe-Startup 15
  $bridge = $assembly.GetType('Ember.Uia.Bridge', $true)
  Observe-Startup 16
} catch {
  Write-Fatal $_.Exception.Message
  exit 1
}

try {
  Observe-Startup 17
  $code = $bridge::Run()
} catch {
  Write-Fatal $_.Exception.Message
  exit 1
}
exit $code
