<#
  Ember Bench (Windows): a small WinForms window that Ember's Windows tests drive (the window system and input
  backends, and the UI Automation bridge). It logs every event as one JSON line, so a test can see what its clicks
  and keys did without reading the screen. Password text never reaches the log: only its length.

  Usage (Windows PowerShell 5.1):
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\fixtures\win_bench.ps1 -Log C:\tmp\bench.jsonl [-Seconds 600]

  Log lines (UTF-8, no BOM, one object per line):
    {"event":"ready","hwnd":N,"pid":N,"window":{...},"controls":{"Name":{"x":..,"y":..,"width":..,"height":..},...}}
    {"event":"focus","control":"Name"}
    {"event":"text","control":"Name","length":N}
    {"event":"toggle","control":"Remember me","checked":true}
    {"event":"select","control":"Theme","value":"Dark"}
    {"event":"value","control":"Volume","value":N}
    {"event":"click","control":"Save"}
    {"event":"dialog","result":"OK"}
    {"event":"exit"}
  Rectangles are screen coordinates in physical pixels (the bench is per-monitor DPI aware, like Electron).
  It exits when its window closes or when -Seconds elapse (0: never on its own).

  ASCII only: Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page.
#>
param(
  [Parameter(Mandatory = $true)][string]$Log,
  [int]$Seconds = 600
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
# Before any control exists, or the controls keep the old unthemed common controls (and their UIA shapes).
[System.Windows.Forms.Application]::EnableVisualStyles()

# Per-monitor DPI awareness before the first window, so the rectangles in the log are physical pixels (the units
# Ember uses on Windows). Windows PowerShell is not per-monitor aware by default and would report scaled ones.
Add-Type -Namespace EmberBench -Name Dpi -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr SetProcessDpiAwarenessContext(System.IntPtr value);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern System.IntPtr SetThreadDpiAwarenessContext(System.IntPtr value);
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool SetProcessDPIAware();
'@
try {
  [void][EmberBench.Dpi]::SetProcessDpiAwarenessContext([IntPtr](-4))
  [void][EmberBench.Dpi]::SetThreadDpiAwarenessContext([IntPtr](-4))
} catch {
  # Older than Windows 10 1607: system DPI awareness is the best there is.
  [void][EmberBench.Dpi]::SetProcessDPIAware()
}

$utf8 = New-Object System.Text.UTF8Encoding $false

function Write-BenchLog([System.Collections.IDictionary]$Fields) {
  try {
    $line = ConvertTo-Json -InputObject $Fields -Compress -Depth 5
    [System.IO.File]::AppendAllText($Log, $line + "`n", $utf8)
  } catch {
    # A log line that can't be written must not take the window down: the test then times out on its own.
    [Console]::Error.WriteLine("win_bench: could not write the log: " + $_.Exception.Message)
  }
}

function Get-ScreenRect($Control) {
  $r = $Control.RectangleToScreen($Control.ClientRectangle)
  return [ordered]@{ x = $r.X; y = $r.Y; width = $r.Width; height = $r.Height }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Ember Bench (Windows)'
$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::None
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Location = New-Object System.Drawing.Point(160, 120)
$form.ClientSize = New-Object System.Drawing.Size(460, 400)
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
$form.MaximizeBox = $false

$script:controls = [ordered]@{}

function Add-Row([string]$Label, $Control, [int]$Y, [int]$Height) {
  if ($Label) {
    $l = New-Object System.Windows.Forms.Label
    $l.Text = $Label
    $l.Location = New-Object System.Drawing.Point(16, ($Y + 3))
    $l.Size = New-Object System.Drawing.Size(84, 20)
    $form.Controls.Add($l)
  }
  $Control.Location = New-Object System.Drawing.Point(104, $Y)
  $Control.Size = New-Object System.Drawing.Size(330, $Height)
  $form.Controls.Add($Control)
  $script:controls[$Control.AccessibleName] = $Control
  $Control.Add_Enter({ param($s, $e) Write-BenchLog ([ordered]@{ event = 'focus'; control = $s.AccessibleName }) })
}

$name = New-Object System.Windows.Forms.TextBox
$name.AccessibleName = 'Name'
Add-Row 'Name' $name 16 24
$name.Add_TextChanged({ Write-BenchLog ([ordered]@{ event = 'text'; control = 'Name'; length = $name.Text.Length }) })

$password = New-Object System.Windows.Forms.TextBox
$password.AccessibleName = 'Password'
$password.UseSystemPasswordChar = $true
Add-Row 'Password' $password 52 24
$password.Add_TextChanged({ Write-BenchLog ([ordered]@{ event = 'text'; control = 'Password'; length = $password.Text.Length }) })

$remember = New-Object System.Windows.Forms.CheckBox
$remember.Text = 'Remember me'
$remember.AccessibleName = 'Remember me'
Add-Row '' $remember 88 24
$remember.Add_CheckedChanged({ Write-BenchLog ([ordered]@{ event = 'toggle'; control = 'Remember me'; checked = $remember.Checked }) })

$theme = New-Object System.Windows.Forms.ComboBox
$theme.AccessibleName = 'Theme'
$theme.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
[void]$theme.Items.AddRange([object[]]@('Light', 'Dark', 'System'))
Add-Row 'Theme' $theme 124 24
$theme.Add_SelectedIndexChanged({ Write-BenchLog ([ordered]@{ event = 'select'; control = 'Theme'; value = [string]$theme.SelectedItem }) })

$volume = New-Object System.Windows.Forms.TrackBar
$volume.AccessibleName = 'Volume'
$volume.Minimum = 0
$volume.Maximum = 100
$volume.TickFrequency = 10
$volume.SmallChange = 1
$volume.LargeChange = 10
Add-Row 'Volume' $volume 160 45
$volume.Add_ValueChanged({ Write-BenchLog ([ordered]@{ event = 'value'; control = 'Volume'; value = $volume.Value }) })

$fruit = New-Object System.Windows.Forms.ListBox
$fruit.AccessibleName = 'Fruit'
[void]$fruit.Items.AddRange([object[]]@('Apple', 'Banana', 'Cherry'))
Add-Row 'Fruit' $fruit 216 64
$fruit.Add_SelectedIndexChanged({ Write-BenchLog ([ordered]@{ event = 'select'; control = 'Fruit'; value = [string]$fruit.SelectedItem }) })

$save = New-Object System.Windows.Forms.Button
$save.Text = 'Save'
$save.AccessibleName = 'Save'
Add-Row '' $save 300 32
$save.Size = New-Object System.Drawing.Size(150, 32)
$save.Add_Click({ Write-BenchLog ([ordered]@{ event = 'click'; control = 'Save' }) })

$open = New-Object System.Windows.Forms.Button
$open.Text = 'Open dialog'
$open.AccessibleName = 'Open dialog'
Add-Row '' $open 300 32
$open.Location = New-Object System.Drawing.Point(284, 300)
$open.Size = New-Object System.Drawing.Size(150, 32)
$open.Add_Click({
  Write-BenchLog ([ordered]@{ event = 'click'; control = 'Open dialog' })
  $answer = [System.Windows.Forms.MessageBox]::Show($form, 'Saved?', 'Ember Bench', [System.Windows.Forms.MessageBoxButtons]::OKCancel)
  Write-BenchLog ([ordered]@{ event = 'dialog'; result = [string]$answer })
})

$form.Add_Shown({
  $form.Activate()
  $rects = [ordered]@{}
  foreach ($key in $script:controls.Keys) { $rects[$key] = Get-ScreenRect $script:controls[$key] }
  $outer = $form.Bounds
  Write-BenchLog ([ordered]@{
    event = 'ready'
    hwnd = $form.Handle.ToInt64()
    pid = $PID
    window = [ordered]@{ x = $outer.X; y = $outer.Y; width = $outer.Width; height = $outer.Height }
    controls = $rects
  })
})

if ($Seconds -gt 0) {
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = $Seconds * 1000
  $timer.Add_Tick({ $timer.Stop(); $form.Close() })
  $timer.Start()
}

[System.Windows.Forms.Application]::Run($form)
Write-BenchLog ([ordered]@{ event = 'exit' })
[Environment]::Exit(0)
