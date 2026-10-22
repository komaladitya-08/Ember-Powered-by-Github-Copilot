<#
  Ember Bench (Windows): builds and runs EmberBench.exe, the small WinForms window Ember's Windows tests drive (the
  window system and input backends, the UI Automation bridge and the accessibility host). The form is C# compiled
  into a program of its own, so its windows' program is "EmberBench", never "powershell" (a terminal, which Ember
  refuses to type into), and a 32-bit build lets the tests read a 32-bit app's list and tree views. It logs every
  event as one JSON line, so a test can see what its clicks and keys did without reading the screen. Password text
  never reaches the log: only its length.

  Usage (Windows PowerShell 5.1):
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\fixtures\win_bench.ps1 -Log C:\tmp\bench.jsonl
        [-Seconds 600] [-Platform anycpu|x86] [-Layered] [-Commands C:\tmp\bench.cmd]
      builds EmberBench.exe when needed, runs it and waits for it. The bench exits when this PowerShell does (killing
      it is enough), when its window closes, or when -Seconds elapse (0: never on its own).
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File test\fixtures\win_bench.ps1 -BuildOnly [-Platform x86]
      only builds, then prints one UTF-8 line, {"exe":"<path>","platform":"anycpu"}, for a test that starts the
      program itself (its process is then the window's):
        EmberBench.exe -Log <path> [-Seconds <n>] [-ParentPid <pid>] [-Layered] [-Commands <path>]

  Builds: %TEMP%\ember-bench\<hash of the C# below>-<platform>\EmberBench.exe, compiled once per version with the
  .NET Framework's C# 5 compiler through CodeDom (what Add-Type runs; called directly so that -Platform x86 can pass
  /platform:x86) as a Windows application. Two tests may build at once: each compiles into a folder of its own and
  renames it into place. Builds of other versions are deleted when nothing runs them.

  -Layered adds a small topmost window of the bench's (no focus, no taskbar button) filled with pure red at a
  constant alpha below 255, so it is a layered window (WS_EX_LAYERED, LWA_ALPHA): the integration test captures it to
  see whether a capture holds layered windows with and without CAPTUREBLT.

  -Commands <path>: the bench checks that file every 100 ms, deletes it and runs its lines. "busy <ms>" keeps the UI
  thread from handling any message for that long, as an app working on its UI thread does (under 5 s Windows doesn't
  call it hung). Write the file elsewhere and rename it into place, so that it is read whole.

  Log lines (UTF-8 without BOM, one object per line, strings escaped to ASCII):
    {"event":"ready","hwnd":N,"pid":N,"program":"EmberBench","bits":64,"dpi":"per-monitor-v2","window":{rect},
     "controls":{"Name":{rect},...},"items":{"Files/report.txt":{rect},"Places/Documents":{rect},...},
     "layered":{rect,"hwnd":N,"alpha":252}}                  ("layered" only with -Layered)
    {"event":"focus","control":"Name"}
    {"event":"text","control":"Name","length":N}
    {"event":"toggle","control":"Remember me","checked":true}
    {"event":"select","control":"Theme","value":"Dark"}      (also Fruit, Files and Places)
    {"event":"value","control":"Volume","value":N}
    {"event":"click","control":"Save"}
    {"event":"dialog","result":"OK"}
    {"event":"open","control":"Files","value":"photo.jpg"}  (an item opened: double-click or Enter)
    {"event":"expand","control":"Places","value":"Documents","expanded":true}
    {"event":"busy","ms":N} and then {"event":"idle"}
    {"event":"error","message":"..."}                         (an exception in an event handler)
    {"event":"exit"}
  A rect is {"x":..,"y":..,"width":..,"height":..} in screen coordinates, physical pixels (the bench is per-monitor
  DPI aware, like Electron). "pid" is EmberBench.exe's, the window's process, not this PowerShell's. The ready line is
  written once the window is shown and the messages queued until then have been handled.

  Controls (AccessibleName, in tab order): Name (text box, focused first), Password (password box), Remember me
  (check box), Theme (drop-down list: Light, Dark, System), Volume (track bar 0-100, steps 1 and 10), Fruit (list
  box: Apple, Banana, Cherry), Save (button), Open dialog (button: a modal "Saved?" box titled "Ember Bench", OK and
  Cancel), Files (list view, details: report.txt, photo.jpg, notes.md, with a Size column), Places (tree view:
  Desktop, Documents with Work and Personal, Downloads; Documents starts collapsed). Name, Password, Theme, Volume and
  Fruit have a label of the same name on their left, as in most apps.

  ASCII only: Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page.
#>
param(
  [string]$Log,
  [int]$Seconds = 600,
  [ValidateSet('anycpu', 'x86')][string]$Platform = 'anycpu',
  [switch]$Layered,
  [string]$Commands,
  [switch]$BuildOnly
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$source = @'
// EmberBench.exe: the WinForms window of test/fixtures/win_bench.ps1 (usage and log lines are documented there).
// C# 5, which is what the .NET Framework's compiler takes: no string interpolation, null-conditional operators,
// nameof, expression-bodied members or auto-property initialisers, and no "=>" at all (anonymous methods instead),
// so that a plain check catches the rest. Only System, System.Drawing and System.Windows.Forms are referenced.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace Ember.Bench
{
  /// <summary>One JSON object, written in insertion order, with every string escaped to ASCII.</summary>
  internal sealed class Json
  {
    private readonly StringBuilder body = new StringBuilder();

    internal Json Add(string key, string value) { return Raw(key, Quote(value)); }

    internal Json Add(string key, long value) { return Raw(key, value.ToString(CultureInfo.InvariantCulture)); }

    internal Json Add(string key, bool value) { return Raw(key, value ? "true" : "false"); }

    internal Json Add(string key, Json value) { return Raw(key, value.ToString()); }

    private Json Raw(string key, string json)
    {
      if (body.Length > 0) body.Append(',');
      body.Append(Quote(key)).Append(':').Append(json);
      return this;
    }

    public override string ToString() { return "{" + body.ToString() + "}"; }

    internal static string Quote(string text)
    {
      string s = text ?? "";
      StringBuilder b = new StringBuilder(s.Length + 2);
      b.Append('"');
      foreach (char c in s)
      {
        if (c == '"' || c == '\\') b.Append('\\').Append(c);
        else if (c < ' ' || c > '~') b.Append("\\u").Append(((int)c).ToString("x4", CultureInfo.InvariantCulture));
        else b.Append(c);
      }
      return b.Append('"').ToString();
    }
  }

  /// <summary>The JSON-lines log (UTF-8 without BOM), written from the UI thread and from the parent watch.</summary>
  internal static class Log
  {
    private static readonly object Gate = new object();
    private static readonly Encoding Utf8 = new UTF8Encoding(false);
    private static string path;

    internal static void Open(string file) { path = file; }

    internal static void Write(Json line)
    {
      lock (Gate)
      {
        try
        {
          File.AppendAllText(path, line.ToString() + "\n", Utf8);
        }
        catch (Exception e)
        {
          // A line that can't be written must not take the window down: the test then times out on its own.
          try { Console.Error.WriteLine("EmberBench: could not write the log: " + e.Message); }
          catch (Exception) { /* no standard error either: nothing more can be done */ }
        }
      }
    }
  }

  /// <summary>The command line: -Log path (required), -Seconds n, -ParentPid pid, -Commands path, -Layered.</summary>
  internal sealed class Options
  {
    internal string LogPath;
    internal int Seconds = 600;
    internal int ParentPid;
    internal string CommandsPath;
    internal bool Layered;

    internal static Options Parse(string[] args)
    {
      Options o = new Options();
      for (int i = 0; i < args.Length; i++)
      {
        string name = args[i].TrimStart('-', '/').ToLowerInvariant();
        if (name == "layered")
        {
          o.Layered = true;
          continue;
        }
        if (i + 1 >= args.Length) throw new ArgumentException(args[i] + " needs a value");
        string value = args[++i];
        switch (name)
        {
          case "log": o.LogPath = Path.GetFullPath(value); break;
          case "seconds": o.Seconds = int.Parse(value, NumberStyles.Integer, CultureInfo.InvariantCulture); break;
          case "parentpid": o.ParentPid = int.Parse(value, NumberStyles.Integer, CultureInfo.InvariantCulture); break;
          case "commands": o.CommandsPath = Path.GetFullPath(value); break;
          default: throw new ArgumentException("unknown option " + args[i - 1]);
        }
      }
      if (string.IsNullOrEmpty(o.LogPath)) throw new ArgumentException("-Log <path> is required");
      return o;
    }
  }

  /// <summary>Per-monitor DPI awareness before the first window, so that every logged rectangle is physical pixels.</summary>
  internal static class Dpi
  {
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("shcore.dll")]
    private static extern int SetProcessDpiAwareness(int value);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetProcessDPIAware();

    /// <summary>Sets the best awareness the system has and names it ("per-monitor-v2", as the bridge reports it).</summary>
    internal static string Setup()
    {
      try
      {
        if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per-monitor-v2";
      }
      catch (EntryPointNotFoundException)
      {
        // Older than Windows 10 1703: the next best.
      }
      try
      {
        if (SetProcessDpiAwareness(2) == 0) return "per-monitor";
      }
      catch (DllNotFoundException)
      {
        // Older than Windows 8.1.
      }
      catch (EntryPointNotFoundException)
      {
        // Older than Windows 8.1.
      }
      return SetProcessDPIAware() ? "system" : "unaware";
    }
  }

  /// <summary>
  /// A small topmost window filled with pure red at a constant alpha below 255, which makes it a layered window
  /// (WS_EX_LAYERED with LWA_ALPHA). It never takes the focus and has no taskbar button.
  /// </summary>
  internal sealed class Swatch : Form
  {
    internal const int Alpha = 252;

    internal Swatch()
    {
      Text = "Ember Bench swatch";
      FormBorderStyle = FormBorderStyle.None;
      ShowInTaskbar = false;
      TopMost = true;
      AutoScaleMode = AutoScaleMode.None;
      StartPosition = FormStartPosition.Manual;
      Bounds = new Rectangle(160, 600, 160, 60);
      BackColor = Color.FromArgb(255, 0, 0);
      Opacity = Alpha / 255.0;
    }

    protected override bool ShowWithoutActivation
    {
      get { return true; }
    }

    protected override CreateParams CreateParams
    {
      get
      {
        CreateParams p = base.CreateParams;
        p.ExStyle |= 0x08000000 | 0x00000080; // WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW
        return p;
      }
    }
  }

  /// <summary>The bench's window: the controls Ember's tests use, each logging what happens to it.</summary>
  internal sealed class BenchForm : Form
  {
    internal const string Title = "Ember Bench (Windows)";

    private readonly Options options;
    private readonly string dpi;
    private readonly List<Control> named = new List<Control>();
    private readonly TextBox nameBox = new TextBox();
    private readonly TextBox passwordBox = new TextBox();
    private readonly CheckBox remember = new CheckBox();
    private readonly ComboBox theme = new ComboBox();
    private readonly TrackBar volume = new TrackBar();
    private readonly ListBox fruit = new ListBox();
    private readonly Button save = new Button();
    private readonly Button openDialog = new Button();
    private readonly ListView files = new ListView();
    private readonly TreeView places = new TreeView();
    private System.Windows.Forms.Timer commandPoll;
    private System.Windows.Forms.Timer quitTimer;
    private Swatch swatch;

    internal BenchForm(Options options, string dpi)
    {
      this.options = options;
      this.dpi = dpi;
      Text = Title;
      AutoScaleMode = AutoScaleMode.None;
      StartPosition = FormStartPosition.Manual;
      Location = new Point(160, 120);
      ClientSize = new Size(760, 400);
      FormBorderStyle = FormBorderStyle.FixedDialog;
      MaximizeBox = false;

      nameBox.AccessibleName = "Name";
      AddRow("Name", nameBox, 16, 24);
      nameBox.TextChanged += delegate { Log.Write(Event("text", "Name").Add("length", nameBox.Text.Length)); };

      passwordBox.AccessibleName = "Password";
      passwordBox.UseSystemPasswordChar = true;
      AddRow("Password", passwordBox, 52, 24);
      passwordBox.TextChanged += delegate { Log.Write(Event("text", "Password").Add("length", passwordBox.TextLength)); };

      remember.Text = "Remember me";
      remember.AccessibleName = "Remember me";
      AddRow(null, remember, 88, 24);
      remember.CheckedChanged += delegate { Log.Write(Event("toggle", "Remember me").Add("checked", remember.Checked)); };

      theme.AccessibleName = "Theme";
      theme.DropDownStyle = ComboBoxStyle.DropDownList;
      theme.Items.AddRange(new object[] { "Light", "Dark", "System" });
      AddRow("Theme", theme, 124, 24);
      theme.SelectedIndexChanged += delegate { Log.Write(Event("select", "Theme").Add("value", Convert.ToString(theme.SelectedItem, CultureInfo.InvariantCulture))); };

      volume.AccessibleName = "Volume";
      volume.Minimum = 0;
      volume.Maximum = 100;
      volume.TickFrequency = 10;
      volume.SmallChange = 1;
      volume.LargeChange = 10;
      AddRow("Volume", volume, 160, 45);
      volume.ValueChanged += delegate { Log.Write(Event("value", "Volume").Add("value", volume.Value)); };

      fruit.AccessibleName = "Fruit";
      fruit.Items.AddRange(new object[] { "Apple", "Banana", "Cherry" });
      AddRow("Fruit", fruit, 216, 64);
      fruit.SelectedIndexChanged += delegate { Log.Write(Event("select", "Fruit").Add("value", Convert.ToString(fruit.SelectedItem, CultureInfo.InvariantCulture))); };

      save.Text = "Save";
      save.AccessibleName = "Save";
      Place(save, new Rectangle(104, 300, 150, 32));
      save.Click += delegate { Log.Write(Event("click", "Save")); };

      openDialog.Text = "Open dialog";
      openDialog.AccessibleName = "Open dialog";
      Place(openDialog, new Rectangle(284, 300, 150, 32));
      openDialog.Click += delegate
      {
        Log.Write(Event("click", "Open dialog"));
        DialogResult answer = MessageBox.Show(this, "Saved?", "Ember Bench", MessageBoxButtons.OKCancel);
        Log.Write(new Json().Add("event", "dialog").Add("result", answer.ToString()));
      };

      files.AccessibleName = "Files";
      files.View = View.Details;
      files.FullRowSelect = true;
      files.HideSelection = false;
      files.MultiSelect = false;
      files.Columns.Add("Name", 160);
      files.Columns.Add("Size", 90);
      files.Items.Add(new ListViewItem(new string[] { "report.txt", "12 KB" }));
      files.Items.Add(new ListViewItem(new string[] { "photo.jpg", "2.4 MB" }));
      files.Items.Add(new ListViewItem(new string[] { "notes.md", "3 KB" }));
      Place(files, new Rectangle(460, 16, 284, 150));
      // Changing the selection clears the old one first (no item selected): only the new one is logged.
      files.SelectedIndexChanged += delegate
      {
        if (files.SelectedItems.Count == 1) Log.Write(Event("select", "Files").Add("value", files.SelectedItems[0].Text));
      };
      files.ItemActivate += delegate
      {
        if (files.SelectedItems.Count > 0) Log.Write(Event("open", "Files").Add("value", files.SelectedItems[0].Text));
      };

      places.AccessibleName = "Places";
      places.HideSelection = false;
      places.Nodes.Add("Desktop");
      TreeNode documents = places.Nodes.Add("Documents");
      documents.Nodes.Add("Work");
      documents.Nodes.Add("Personal");
      places.Nodes.Add("Downloads");
      Place(places, new Rectangle(460, 182, 284, 150));
      places.AfterSelect += delegate (object sender, TreeViewEventArgs e) { Log.Write(Event("select", "Places").Add("value", e.Node.Text)); };
      places.AfterExpand += delegate (object sender, TreeViewEventArgs e) { Log.Write(Event("expand", "Places").Add("value", e.Node.Text).Add("expanded", true)); };
      places.AfterCollapse += delegate (object sender, TreeViewEventArgs e) { Log.Write(Event("expand", "Places").Add("value", e.Node.Text).Add("expanded", false)); };
    }

    private static Json Event(string kind, string control)
    {
      return new Json().Add("event", kind).Add("control", control);
    }

    private static Json Rect(Rectangle r)
    {
      return new Json().Add("x", r.X).Add("y", r.Y).Add("width", r.Width).Add("height", r.Height);
    }

    /// <summary>A control with a label of the same name on its left (null: no label), as the rows of a form.</summary>
    private void AddRow(string label, Control control, int y, int height)
    {
      if (label != null)
      {
        Label l = new Label();
        l.Text = label;
        l.Location = new Point(16, y + 3);
        l.Size = new Size(84, 20);
        Controls.Add(l);
      }
      Place(control, new Rectangle(104, y, 330, height));
    }

    /// <summary>Adds a named control (in tab order) that logs when it gets the focus.</summary>
    private void Place(Control control, Rectangle bounds)
    {
      control.Bounds = bounds;
      Controls.Add(control);
      named.Add(control);
      control.Enter += delegate (object sender, EventArgs e) { Log.Write(Event("focus", ((Control)sender).AccessibleName)); };
    }

    protected override void OnShown(EventArgs e)
    {
      base.OnShown(e);
      Activate();
      if (options.Layered)
      {
        swatch = new Swatch();
        swatch.Show();
      }
      if (options.CommandsPath != null)
      {
        commandPoll = new System.Windows.Forms.Timer();
        commandPoll.Interval = 100;
        commandPoll.Tick += delegate { RunCommands(); };
        commandPoll.Start();
      }
      if (options.Seconds > 0)
      {
        quitTimer = new System.Windows.Forms.Timer();
        quitTimer.Interval = (int)Math.Min((long)options.Seconds * 1000, int.MaxValue);
        quitTimer.Tick += delegate { Program.Quit(); };
        quitTimer.Start();
      }
      // Posted: it runs once the messages queued until now (showing and laying out the window) have been handled.
      BeginInvoke(new MethodInvoker(WriteReady));
    }

    private void WriteReady()
    {
      Json rects = new Json();
      foreach (Control c in named) rects.Add(c.AccessibleName, Rect(c.RectangleToScreen(c.ClientRectangle)));
      Json items = new Json();
      foreach (ListViewItem item in files.Items) items.Add("Files/" + item.Text, Rect(files.RectangleToScreen(item.Bounds)));
      foreach (TreeNode node in places.Nodes) items.Add("Places/" + node.Text, Rect(places.RectangleToScreen(node.Bounds)));
      Process self = Process.GetCurrentProcess();
      Json line = new Json().Add("event", "ready").Add("hwnd", Handle.ToInt64()).Add("pid", self.Id)
        .Add("program", self.ProcessName).Add("bits", IntPtr.Size * 8).Add("dpi", dpi)
        .Add("window", Rect(Bounds)).Add("controls", rects).Add("items", items);
      if (swatch != null) line.Add("layered", Rect(swatch.Bounds).Add("hwnd", swatch.Handle.ToInt64()).Add("alpha", Swatch.Alpha));
      Log.Write(line);
    }

    /// <summary>Runs the lines of the -Commands file, if there is one now, and deletes it.</summary>
    private void RunCommands()
    {
      string text;
      try
      {
        if (!File.Exists(options.CommandsPath)) return;
        text = File.ReadAllText(options.CommandsPath);
        File.Delete(options.CommandsPath);
      }
      catch (IOException)
      {
        return; // still being moved into place: the next tick reads it
      }
      catch (UnauthorizedAccessException)
      {
        return; // the same, as a sharing violation can surface
      }
      foreach (string line in text.Split('\n'))
      {
        string[] words = line.Trim().Split(' ');
        int ms;
        if (words.Length != 2 || words[0] != "busy" || !int.TryParse(words[1], NumberStyles.None, CultureInfo.InvariantCulture, out ms)) continue;
        Log.Write(new Json().Add("event", "busy").Add("ms", ms));
        // No message is handled while the UI thread sleeps: the app is busy, not hung (under 5 s).
        Thread.Sleep(ms);
        Log.Write(new Json().Add("event", "idle"));
      }
    }
  }

  internal static class Program
  {
    private static int exited;

    [STAThread]
    private static int Main(string[] args)
    {
      Options options;
      try
      {
        options = Options.Parse(args);
      }
      catch (Exception e)
      {
        Console.Error.WriteLine("EmberBench: " + e.Message + " (usage: EmberBench.exe -Log <path> [-Seconds <n>] [-ParentPid <pid>] [-Commands <path>] [-Layered])");
        return 2;
      }
      string dpi = Dpi.Setup();
      Log.Open(options.LogPath);
      if (options.ParentPid > 0) WatchParent(options.ParentPid);
      // A failing handler is logged and the bench goes on: WinForms' error dialog would stop the test instead.
      Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);
      Application.ThreadException += delegate (object sender, ThreadExceptionEventArgs e)
      {
        Log.Write(new Json().Add("event", "error").Add("message", e.Exception.GetType().Name + ": " + e.Exception.Message));
      };
      Application.EnableVisualStyles();
      Application.SetCompatibleTextRenderingDefault(false);
      Application.Run(new BenchForm(options, dpi));
      LogExit();
      return 0;
    }

    /// <summary>Ends the bench at once, also while a modal dialog runs (from any thread).</summary>
    internal static void Quit()
    {
      LogExit();
      Environment.Exit(0);
    }

    private static void LogExit()
    {
      if (Interlocked.Exchange(ref exited, 1) == 0) Log.Write(new Json().Add("event", "exit"));
    }

    /// <summary>Ends the bench when the process that started it ends, so that killing win_bench.ps1 is enough.</summary>
    private static void WatchParent(int pid)
    {
      Process parent;
      try
      {
        parent = Process.GetProcessById(pid);
      }
      catch (ArgumentException)
      {
        Quit(); // it has gone already
        return;
      }
      Thread watch = new Thread(delegate ()
      {
        try
        {
          parent.WaitForExit();
        }
        catch (Exception)
        {
          return; // it can't be waited on: -Seconds still ends the bench
        }
        Quit();
      });
      watch.IsBackground = true;
      watch.Start();
    }
  }
}
'@

# The first 16 hex digits of the SHA-256 of a text's UTF-8 bytes: the build's version.
function Get-Hash([string]$Text) {
  $digest = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($Text))
  ([BitConverter]::ToString($digest) -replace '-', '').Substring(0, 16).ToLowerInvariant()
}

# The bench's program for this version of the C# and this platform: compiled once into %TEMP%\ember-bench.
function Get-Bench([string]$Hash, [string]$Platform) {
  $root = Join-Path ([IO.Path]::GetTempPath()) 'ember-bench'
  $name = $Hash + '-' + $Platform
  $dir = Join-Path $root $name
  $exe = Join-Path $dir 'EmberBench.exe'
  if ([IO.File]::Exists($exe)) { return $exe }
  [void][IO.Directory]::CreateDirectory($root)
  # Other versions' builds aren't needed again, nor a build folder left behind; one in use stays, which is harmless.
  $stale = [DateTime]::UtcNow.AddMinutes(-10)
  foreach ($old in [IO.Directory]::GetDirectories($root)) {
    $leaf = [IO.Path]::GetFileName($old)
    $building = $leaf.StartsWith('tmp-', [StringComparison]::Ordinal)
    $current = $leaf.StartsWith($Hash + '-', [StringComparison]::Ordinal)
    if ((-not $building -and -not $current) -or ($building -and [IO.Directory]::GetLastWriteTimeUtc($old) -lt $stale)) {
      try { [IO.Directory]::Delete($old, $true) } catch { <# running or already gone: left for a later build #> }
    }
  }
  $work = Join-Path $root ('tmp-' + [Guid]::NewGuid().ToString('N'))
  [void][IO.Directory]::CreateDirectory($work)
  try {
    $parameters = New-Object System.CodeDom.Compiler.CompilerParameters
    $parameters.GenerateExecutable = $true
    $parameters.GenerateInMemory = $false
    $parameters.OutputAssembly = Join-Path $work 'EmberBench.exe'
    $parameters.CompilerOptions = '/target:winexe /platform:' + $Platform + ' /optimize+'
    foreach ($reference in @('System.dll', 'System.Drawing.dll', 'System.Windows.Forms.dll')) {
      [void]$parameters.ReferencedAssemblies.Add($reference)
    }
    $provider = New-Object Microsoft.CSharp.CSharpCodeProvider
    try {
      $result = $provider.CompileAssemblyFromSource($parameters, [string[]]@($source))
    } finally {
      $provider.Dispose()
    }
    try { $result.TempFiles.Delete() } catch { <# one still open: it stays in %TEMP% #> }
    $errors = @($result.Errors | Where-Object { -not $_.IsWarning } | ForEach-Object { $_.ToString() })
    if ($errors.Count -gt 0) { throw ('EmberBench.exe did not compile: ' + ($errors -join ' | ')) }
    if (-not [IO.File]::Exists($parameters.OutputAssembly)) { throw 'the compiler wrote no EmberBench.exe' }
    try {
      [IO.Directory]::Move($work, $dir)
    } catch {
      if (-not [IO.File]::Exists($exe)) { throw } # otherwise another build got there first: use that one
    }
  } finally {
    if ([IO.Directory]::Exists($work)) {
      try { [IO.Directory]::Delete($work, $true) } catch { <# removed by a later build once stale #> }
    }
  }
  return $exe
}

# One argument for a Windows command line, quoted the way CommandLineToArgvW and the C runtime read it back.
function ConvertTo-Argument([string]$Text) {
  if ($Text -and $Text -notmatch '[\s"]') { return $Text }
  '"' + (($Text -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

try {
  $exe = Get-Bench (Get-Hash $source) $Platform
} catch {
  [Console]::Error.WriteLine('win_bench: ' + $_.Exception.Message)
  exit 1
}

if ($BuildOnly) {
  # As UTF-8 bytes, whatever the console's code page: the path may hold any letter (a user name with accents).
  $line = '{"exe":"' + (($exe -replace '\\', '\\') -replace '"', '\"') + '","platform":"' + $Platform + '"}'
  $bytes = (New-Object Text.UTF8Encoding $false).GetBytes($line + "`n")
  $out = [Console]::OpenStandardOutput()
  $out.Write($bytes, 0, $bytes.Length)
  $out.Flush()
  exit 0
}

if (-not $Log) {
  [Console]::Error.WriteLine('win_bench: -Log <path> is required (or -BuildOnly)')
  exit 2
}
# Absolute paths: the program doesn't start in PowerShell's current location.
$arguments = @('-Log', $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Log), '-Seconds', [string]$Seconds, '-ParentPid', [string]$PID)
if ($Layered) { $arguments += '-Layered' }
if ($Commands) { $arguments += @('-Commands', $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Commands)) }
$start = New-Object Diagnostics.ProcessStartInfo
$start.FileName = $exe
$start.Arguments = (@($arguments | ForEach-Object { ConvertTo-Argument $_ }) -join ' ')
$start.UseShellExecute = $false
$bench = $null
for ($attempt = 1; $null -eq $bench; $attempt++) {
  try {
    $bench = [Diagnostics.Process]::Start($start)
  } catch {
    # A new build that an antivirus is still scanning can refuse to start for a moment.
    if ($attempt -ge 5) {
      [Console]::Error.WriteLine('win_bench: EmberBench.exe did not start: ' + $_.Exception.Message)
      exit 1
    }
    Start-Sleep -Milliseconds 500
  }
}
$bench.WaitForExit()
exit $bench.ExitCode
