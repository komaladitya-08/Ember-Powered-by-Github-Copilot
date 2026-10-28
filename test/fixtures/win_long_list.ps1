<#
  A long list for the UI Automation bridge's test (test/integration/uia-bridge.test.ts): a WinForms window with a
  details ListView of -Rows rows scrolled to its end, so all but its last screenful are offscreen with real bounds, as
  a long web page scrolled down is. When it shows, it writes one UTF-8 line to -Log:
    {"event":"ready","hwnd":N,"pid":N,"rows":N}
  It closes after -Seconds, or when its window is closed (killing it is enough).

  Usage (Windows PowerShell 5.1):
    powershell.exe -NoProfile -ExecutionPolicy Bypass -Sta -File test\fixtures\win_long_list.ps1 -Log C:\tmp\list.jsonl
        [-Rows 3000] [-Seconds 300]
#>
param(
  [Parameter(Mandatory = $true)][string]$Log,
  [int]$Rows = 3000,
  [int]$Seconds = 300
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::EnableVisualStyles()

$form = New-Object System.Windows.Forms.Form
$form.Text = "Ember Long List (Windows)"
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual
$form.Left = 60
$form.Top = 60
$form.Width = 480
$form.Height = 360

$list = New-Object System.Windows.Forms.ListView
$list.View = [System.Windows.Forms.View]::Details
$list.Dock = [System.Windows.Forms.DockStyle]::Fill
$list.Name = "Rows"
[void]$list.Columns.Add("Row", 200)
[void]$list.Columns.Add("Note", 200)
$list.BeginUpdate()
for ($i = 1; $i -le $Rows; $i++) {
  $item = New-Object System.Windows.Forms.ListViewItem("Row $i")
  [void]$item.SubItems.Add("note $i")
  [void]$list.Items.Add($item)
}
$list.EndUpdate()
$form.Controls.Add($list)

$form.Add_Shown({
  $list.EnsureVisible($Rows - 1)
  $line = '{"event":"ready","hwnd":' + $form.Handle.ToInt64() + ',"pid":' + $PID + ',"rows":' + $Rows + '}'
  [IO.File]::WriteAllText($Log, $line + "`n", (New-Object System.Text.UTF8Encoding($false)))
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = [Math]::Max(1, $Seconds) * 1000
$timer.Add_Tick({ $form.Close() })
$timer.Start()
[System.Windows.Forms.Application]::Run($form)
