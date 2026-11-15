# Experimental source-built component only. No product gate, system installation, host ACL or logging policy changes.
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Scratch)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $IsWindows -or [Environment]::Is64BitProcess -ne $true) { throw 'This experiment requires Windows x64.' }
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'powershell-lpac-etw.json') -Raw | ConvertFrom-Json
$patch = Join-Path $PSScriptRoot 'powershell-lpac-etw.patch'
function Assert-Native { if ($LASTEXITCODE -ne 0) { throw "A pinned source build operation failed with code $LASTEXITCODE." } }
function Assert-Hash([string]$File, [string]$Expected) {
    if ((Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Expected) { throw "Pinned content hash mismatch: $File" }
}
if (Test-Path -LiteralPath $Scratch) { throw 'Use a new absent experimental build directory.' }
$null = New-Item -Path $Scratch -ItemType Directory
$Scratch = (Resolve-Path -LiteralPath $Scratch).Path
$source = Join-Path $Scratch 'source'
$build = Join-Path $Scratch 'build'
$package = Join-Path $Scratch 'package'
$archive = Join-Path $Scratch 'official.zip'
$dotnet = Join-Path $env:ProgramFiles 'dotnet\dotnet.exe'
$env:DOTNET_CLI_TELEMETRY_OPTOUT = '1'
$env:POWERSHELL_TELEMETRY_OPTOUT = '1'
Assert-Hash $patch $manifest.patchSha256
& git init --quiet $source; Assert-Native
& git -C $source config core.autocrlf false; Assert-Native
& git -C $source remote add origin https://github.com/PowerShell/PowerShell.git; Assert-Native
& git -C $source fetch --depth=1 origin $manifest.sourceCommit; Assert-Native
& git -C $source checkout --detach --quiet $manifest.sourceCommit; Assert-Native
& git -C $source fetch --depth=1 origin 'refs/tags/v7.6.10:refs/tags/v7.6.10'; Assert-Native
if ((& git -C $source rev-parse HEAD).Trim() -ne $manifest.sourceCommit) { throw 'Wrong PowerShell source commit.' }
if ((& git -C $source rev-parse refs/tags/v7.6.10).Trim() -ne $manifest.sourceTagObject) { throw 'PowerShell tag moved.' }
$sourceFile = Join-Path $source $manifest.sourceFile
Assert-Hash $sourceFile $manifest.sourceFileSha256
& git -C $source -c core.autocrlf=false apply --unidiff-zero --check $patch; Assert-Native
& git -C $source -c core.autocrlf=false apply --unidiff-zero $patch; Assert-Native
Assert-Hash $sourceFile $manifest.patchedFileSha256
$changed = @(& git -C $source diff --name-only)
if ($changed.Count -ne 1 -or $changed[0] -ne $manifest.sourceFile) { throw 'Only EventProvider.cs may differ from pinned upstream.' }
# The official archive pins every untouched runtime/module/policy assembly, rather than trusting a leaf signature.
Invoke-WebRequest -Uri $manifest.archiveUrl -OutFile $archive -TimeoutSec 120 -MaximumRedirection 5
if ((Get-Item -LiteralPath $archive).Length -gt 128MB) { throw 'The official archive exceeds its bound.' }
Assert-Hash $archive $manifest.archiveSha256
$zip = [IO.Compression.ZipFile]::OpenRead($archive)
try {
    if ($zip.Entries.Count -gt 4096) { throw 'Archive entry count exceeds the bound.' }
    [long]$total = 0
    foreach ($entry in $zip.Entries) {
        $name = $entry.FullName.Replace('\', '/')
        if ($name.StartsWith('/') -or $name.Contains(':') -or @($name.Split('/') | Where-Object { $_ -eq '..' -or $_ -eq '.' }).Count) { throw 'Unsupported archive path.' }
        $total += $entry.Length
        if ($entry.Length -gt 128MB -or $total -gt 1GB -or (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Archive contains oversized or linked assets.' }
    }
} finally { $zip.Dispose() }
Expand-Archive -LiteralPath $archive -DestinationPath $package
$null = New-Item -Path $build -ItemType Directory
Copy-Item -LiteralPath (Join-Path $source 'global.json') -Destination (Join-Path $build 'global.json')
if ((Get-Content -LiteralPath (Join-Path $build 'global.json') -Raw | ConvertFrom-Json).sdk.version -ne $manifest.sdkVersion) { throw 'Unexpected SDK source pin.' }
# Build the same pinned component sources against the pinned distribution's EventLog reference. An isolated
# project excludes upstream analyzer NuGet packages; an empty feed makes any unexpected dependency fetch fail.
$component = Join-Path $source 'src\Microsoft.PowerShell.CoreCLR.Eventing'
$key = Join-Path $source 'src\signing\visualstudiopublic.snk'
$eventLog = Join-Path $package 'System.Diagnostics.EventLog.dll'
# The normal full build generates a class for this fixed resx. Generate only the same string lookup surface;
# all localized official satellite assemblies remain untouched and the neutral resource is embedded below.
$resx = [xml](Get-Content -LiteralPath (Join-Path $component 'resources\DotNetEventingStrings.resx') -Raw)
$properties = foreach ($entry in $resx.root.data) {
    $name = [string]$entry.name
    if ($name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') { throw 'Unexpected generated resource identifier.' }
    "    internal static string $name => manager.GetString(`"$name`", System.Globalization.CultureInfo.CurrentUICulture);"
}
@"
internal static class DotNetEventingStrings {
    private static readonly System.Resources.ResourceManager manager = new System.Resources.ResourceManager("DotNetEventingStrings", typeof(DotNetEventingStrings).Assembly);
$($properties -join "`n")
}
"@ | Set-Content -LiteralPath (Join-Path $build 'DotNetEventingStrings.cs') -Encoding utf8
$project = Join-Path $build 'Microsoft.PowerShell.CoreCLR.Eventing.csproj'
@"
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <TargetFramework>net10.0</TargetFramework><AllowUnsafeBlocks>true</AllowUnsafeBlocks><DefineConstants>CORECLR</DefineConstants>
    <EnableDefaultCompileItems>false</EnableDefaultCompileItems><EnableDefaultEmbeddedResourceItems>false</EnableDefaultEmbeddedResourceItems>
    <ImplicitUsings>disable</ImplicitUsings><Nullable>disable</Nullable><NoWarn>CS1591;CA1416;SYSLIB0003</NoWarn>
    <AssemblyName>Microsoft.PowerShell.CoreCLR.Eventing</AssemblyName><RootNamespace>Microsoft.PowerShell.CoreCLR.Eventing</RootNamespace>
    <AssemblyVersion>7.6.0.500</AssemblyVersion><FileVersion>7.6.10.500</FileVersion>
    <InformationalVersion>7.6.10-ember-lpac-etw-experiment+$($manifest.sourceCommit)</InformationalVersion>
    <SignAssembly>true</SignAssembly><DelaySign>true</DelaySign><AssemblyOriginatorKeyFile>$key</AssemblyOriginatorKeyFile>
    <Deterministic>true</Deterministic><ContinuousIntegrationBuild>true</ContinuousIntegrationBuild>
  </PropertyGroup>
  <ItemGroup>
    <Compile Include="$component\**\*.cs" />
    <Compile Include="$build\DotNetEventingStrings.cs" />
    <EmbeddedResource Include="$component\resources\DotNetEventingStrings.resx"><LogicalName>DotNetEventingStrings.resources</LogicalName></EmbeddedResource>
    <Reference Include="System.Diagnostics.EventLog"><HintPath>$eventLog</HintPath><Private>false</Private></Reference>
  </ItemGroup>
</Project>
"@ | Set-Content -LiteralPath $project -Encoding utf8
'<configuration><packageSources><clear /></packageSources></configuration>' | Set-Content -LiteralPath (Join-Path $build 'NuGet.Config') -Encoding utf8
Push-Location $build
try {
    if ((& $dotnet --version).Trim() -ne $manifest.sdkVersion) { throw 'The exact pinned SDK is not installed.' }
    & $dotnet restore $project --configfile (Join-Path $build 'NuGet.Config') --packages (Join-Path $build 'empty-packages'); Assert-Native
    & $dotnet build $project --no-restore --configuration Release --output (Join-Path $build 'out'); Assert-Native
} finally { Pop-Location }
$replacement = Join-Path $build 'out\Microsoft.PowerShell.CoreCLR.Eventing.dll'
$target = Join-Path $package 'Microsoft.PowerShell.CoreCLR.Eventing.dll'
$originalHash = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant()
Copy-Item -LiteralPath $replacement -Destination $target -Force
$record = [ordered]@{ experimental = $true; productEnabled = $false; powerShellVersion = $manifest.powerShellVersion;
    sourceCommit = $manifest.sourceCommit; sourceTagObject = $manifest.sourceTagObject; sdkVersion = $manifest.sdkVersion;
    archiveSha256 = $manifest.archiveSha256; patchSha256 = $manifest.patchSha256; sourceFileSha256 = $manifest.sourceFileSha256;
    patchedFileSha256 = $manifest.patchedFileSha256; originalEventingSha256 = $originalHash;
    builtEventingSha256 = (Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash.ToLowerInvariant(); package = $package }
$record | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $Scratch 'build-provenance.json') -Encoding utf8
$record | ConvertTo-Json -Depth 5 | Write-Output
if ($env:GITHUB_ENV) { "EMBER_EXPERIMENTAL_PS7_ROOT=$package" | Out-File -LiteralPath $env:GITHUB_ENV -Encoding utf8 -Append }
