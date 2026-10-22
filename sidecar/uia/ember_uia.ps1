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

function Get-Sha256([byte[]]$Bytes) {
  $digest = [Security.Cryptography.SHA256]::Create().ComputeHash($Bytes)
  ([BitConverter]::ToString($digest) -replace '-', '').ToLowerInvariant()
}

# Puts a finished file in the cache in one step (another bridge may get there first, which is fine). PowerShell
# would pass $null to a .NET string parameter as "", which File.Replace refuses, hence [NullString]::Value.
function Set-CacheFile([string]$From, [string]$To) {
  if ([IO.File]::Exists($To)) { [IO.File]::Replace($From, $To, [NullString]::Value) } else { [IO.File]::Move($From, $To) }
}

try {
  $source = Join-Path $PSScriptRoot 'ember_uia.cs'
  $hash = Get-Sha256 ([IO.File]::ReadAllBytes($source))
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase
  $refs = @(
    [System.Windows.Automation.AutomationElement].Assembly.Location,
    [System.Windows.Automation.ControlType].Assembly.Location,
    [System.Windows.Rect].Assembly.Location
  )
  $assembly = $null
  $cache = $env:EMBER_UIA_CACHE
  if ($cache) {
    $dll = Join-Path $cache ('ember_uia-' + $hash + '.dll')
    $sum = $dll + '.sha256'
    # Loaded from bytes checked against the hash written beside them: a half-written or replaced file is compiled
    # again, and the file is never locked or refused for a Mark-of-the-Web.
    if ([IO.File]::Exists($dll) -and [IO.File]::Exists($sum)) {
      $bytes = [IO.File]::ReadAllBytes($dll)
      if ((Get-Sha256 $bytes) -eq [IO.File]::ReadAllText($sum).Trim()) { $assembly = [Reflection.Assembly]::Load($bytes) }
    }
    if ($null -eq $assembly) {
      $tmp = Join-Path $cache ('ember_uia-' + $hash + '.' + $PID + '.tmp')
      try {
        [void][IO.Directory]::CreateDirectory($cache)
        # Builds of other versions and leftovers of earlier compiles are never needed again (and nothing holds a
        # build open: they load from bytes).
        foreach ($old in [IO.Directory]::GetFiles($cache, 'ember_uia-*')) {
          $name = [IO.Path]::GetFileName($old)
          if ($name -ne [IO.Path]::GetFileName($dll) -and $name -ne [IO.Path]::GetFileName($sum)) {
            try { [IO.File]::Delete($old) } catch { <# in use or read-only: harmless to leave #> }
          }
        }
        Add-Type -Path $source -ReferencedAssemblies $refs -OutputAssembly ($tmp + '.dll') -OutputType Library -IgnoreWarnings
        $bytes = [IO.File]::ReadAllBytes($tmp + '.dll')
        $assembly = [Reflection.Assembly]::Load($bytes)
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
    $types = @(Add-Type -Path $source -ReferencedAssemblies $refs -IgnoreWarnings -PassThru)
    $assembly = $types[0].Assembly
  }
  $bridge = $assembly.GetType('Ember.Uia.Bridge', $true)
} catch {
  Write-Fatal $_.Exception.Message
  exit 1
}

try {
  $code = $bridge::Run()
} catch {
  Write-Fatal $_.Exception.Message
  exit 1
}
exit $code
