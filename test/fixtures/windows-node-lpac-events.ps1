# Test-only Application Error query for one host-selected, stopped Node process. Emits no raw event/XML/message.
param([uint32]$ExpectedProcessId, [string]$ExpectedImage, [string]$StartUtc, [string]$EndUtc)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
function Emit-Unavailable([string]$Reason) {
  [Console]::WriteLine((@{ version = 1; status = 'unavailable'; reason = $Reason } | ConvertTo-Json -Compress))
}
function Read-SafeXml([string]$Text) {
  if (!$Text -or $Text.Length -gt 32768) { throw 'event-schema' }
  $settings = New-Object System.Xml.XmlReaderSettings
  $settings.DtdProcessing = [System.Xml.DtdProcessing]::Prohibit
  $settings.XmlResolver = $null
  $settings.MaxCharactersInDocument = 32768
  $string = New-Object System.IO.StringReader($Text)
  $reader = $null
  try {
    $reader = [System.Xml.XmlReader]::Create($string, $settings)
    $xml = New-Object System.Xml.XmlDocument
    $xml.XmlResolver = $null
    $xml.Load($reader)
    return ,$xml
  } finally { if ($null -ne $reader) { $reader.Dispose() }; $string.Dispose() }
}
try {
  $start = [DateTime]::ParseExact($StartUtc, 'yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal).ToUniversalTime()
  $end = [DateTime]::ParseExact($EndUtc, 'yyyy-MM-ddTHH:mm:ss.fffZ', [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::AssumeUniversal).ToUniversalTime()
  if ($ExpectedProcessId -eq 0 -or !$ExpectedImage -or $ExpectedImage.Length -gt 4096 -or $ExpectedImage -notmatch '^[A-Za-z]:\\' -or
      [IO.Path]::GetFileName($ExpectedImage) -ine 'node.exe' -or $end -lt $start -or ($end - $start).TotalSeconds -gt 60) { Emit-Unavailable 'bounds'; exit 0 }
  $module = Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Diagnostics\Microsoft.PowerShell.Diagnostics.psd1'
  Import-Module -Name $module -ErrorAction Stop
  # Verify named fields against the runner's own provider manifest. Do not guess property positions or accept a
  # different schema. Event1000's Execution.ProcessID identifies the reporting context, not the faulted application.
  $provider = Microsoft.PowerShell.Diagnostics\Get-WinEvent -ListProvider 'Application Error' -ErrorAction Stop
  $required = @('ProcessId', 'AppPath', 'AppName', 'ExceptionCode', 'FaultingOffset', 'ModuleName')
  $templates = @($provider.Events | Where-Object { $_.Id -eq 1000 })
  if ($templates.Count -eq 0 -or $templates.Count -gt 8) { Emit-Unavailable 'event-schema'; exit 0 }
  $knownSchema = $false
  foreach ($template in $templates) {
    $xml = Read-SafeXml $template.Template
    $names = @($xml.SelectNodes("//*[local-name()='data']") | ForEach-Object { $_.GetAttribute('name') })
    if ($names.Count -le 32 -and @($required | Where-Object { $names -cnotcontains $_ }).Count -eq 0) { $knownSchema = $true }
  }
  if (!$knownSchema) { Emit-Unavailable 'event-schema'; exit 0 }
  try {
    $events = @(Microsoft.PowerShell.Diagnostics\Get-WinEvent -FilterHashtable @{ LogName = 'Application'; ProviderName = 'Application Error'; Id = 1000; StartTime = $start; EndTime = $end } -MaxEvents 33 -ErrorAction Stop)
  } catch {
    if ($_.FullyQualifiedErrorId -notmatch '^NoMatchingEventsFound,') { Emit-Unavailable 'event-api'; exit 0 }
    $events = @()
  }
  if ($events.Count -gt 32) { Emit-Unavailable 'record-limit'; exit 0 }
  $selected = New-Object System.Collections.Generic.List[object]
  foreach ($event in $events) {
    $xml = Read-SafeXml ($event.ToXml())
    if ($xml.DocumentElement.LocalName -cne 'Event' -or $xml.DocumentElement.NamespaceURI -cne 'http://schemas.microsoft.com/win/2004/08/events/event') { throw 'event-schema' }
    $system = $xml.Event.System
    if ([string]$system.Provider.Name -cne 'Application Error' -or [string]$system.Provider.Guid -ine '{a0e9b465-b939-57d7-b27d-95d8e925ff57}' -or
        [string]$system.Channel -cne 'Application' -or [string]$system.EventID -cne '1000') { continue }
    $data = @{}
    $fields = @($xml.Event.EventData.Data)
    if ($fields.Count -gt 32) { throw 'event-schema' }
    foreach ($field in $fields) {
      $name = $field.GetAttribute('Name')
      if (!$name -or $name.Length -gt 64 -or $data.ContainsKey($name) -or $field.InnerText.Length -gt 4096) { throw 'event-schema' }
      $data[$name] = [string]$field.InnerText
    }
    if (@($required | Where-Object { !$data.ContainsKey($_) }).Count -ne 0) { throw 'event-schema' }
    if ($data.ProcessId -notmatch '^0x[0-9a-fA-F]{1,8}$' -or [Convert]::ToUInt32($data.ProcessId.Substring(2), 16) -ne $ExpectedProcessId -or
        $data.AppPath -ine $ExpectedImage -or $data.AppName -ine 'node.exe') { continue }
    # Only this already-selected record's minimal fields cross the captured pipe. TypeScript rechecks selection,
    # date, provider identity, field bounds and safe basename/hex forms before printing a small fixed receipt.
    $selected.Add(@{ provider = 'Application Error'; providerGuid = [string]$system.Provider.Guid; channel = 'Application'; id = 1000;
      time = [string]$system.TimeCreated.SystemTime; pid = $data.ProcessId; image = $data.AppPath; app = $data.AppName;
      code = $data.ExceptionCode; module = $data.ModuleName; offset = $data.FaultingOffset })
  }
  $output = @{ version = 1; status = 'records'; records = @($selected.ToArray()) } | ConvertTo-Json -Depth 4 -Compress
  if ([Text.Encoding]::UTF8.GetByteCount($output) -gt 65536) { Emit-Unavailable 'bounds'; exit 0 }
  [Console]::WriteLine($output)
} catch { Emit-Unavailable 'event-api'; exit 0 }
