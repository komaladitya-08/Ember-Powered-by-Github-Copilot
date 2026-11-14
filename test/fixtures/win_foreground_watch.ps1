<#
  Foreground watcher (Windows): prints every change of the foreground window, of the window that has the keyboard
  focus, and every minimise and restore, as Windows reports them (SetWinEventHook, out of context), for ember-win32's
  Ask-box timeline (cifix-x9-6). A poll every 20 ms missed what hands the foreground from the Ask box back to the app it
  opened over: these events come for every change, however brief. Each line also says whether the Windows and Alt
  keys are down then (GetAsyncKeyState), since the ask chord holds both.

  Usage (Windows PowerShell 5.1):
    powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File test\fixtures\win_foreground_watch.ps1
  It runs until its standard input closes. Lines (UTF-8, one JSON object each, strings escaped to ASCII):
    {"ready":true,"t":<ms since 1970>}
    {"t":<ms>,"event":"foreground"|"focus"|"minimize-start"|"minimize-end","hwnd":N,"root":N,"class":"...","title":"...",
     "pid":N,"image":"...","win":true|false,"alt":true|false}
  "focus" lines come only when the focus moves to another top-level window ("root"), not within one.
#>
$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public static class EmberForegroundWatch
{
  delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);

  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc proc, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
  [DllImport("user32.dll")] static extern bool PostThreadMessage(uint tid, uint msg, IntPtr w, IntPtr l);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int InternalGetWindowText(IntPtr hwnd, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder s, ref uint n);

  [StructLayout(LayoutKind.Sequential)]
  struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }

  const uint EVENT_SYSTEM_FOREGROUND = 0x0003, EVENT_SYSTEM_MINIMIZESTART = 0x0016, EVENT_SYSTEM_MINIMIZEEND = 0x0017;
  const uint EVENT_OBJECT_FOCUS = 0x8005, WINEVENT_OUTOFCONTEXT = 0x0000, GA_ROOT = 2, WM_QUIT = 0x0012;

  static WinEventProc proc = OnEvent; // held, so the collector never frees what Windows calls back
  static IntPtr lastFocusRoot = IntPtr.Zero;
  static readonly object gate = new object();

  static string Text(IntPtr h, bool cls)
  {
    StringBuilder s = new StringBuilder(512);
    if (cls) GetClassName(h, s, s.Capacity); else InternalGetWindowText(h, s, s.Capacity);
    return s.ToString();
  }

  static string Image(uint pid)
  {
    IntPtr p = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
    if (p == IntPtr.Zero) return "";
    try { StringBuilder s = new StringBuilder(1024); uint n = (uint)s.Capacity; return QueryFullProcessImageName(p, 0, s, ref n) ? s.ToString() : ""; }
    finally { CloseHandle(p); }
  }

  static string Json(string s)
  {
    StringBuilder o = new StringBuilder("\"");
    foreach (char c in s) { if (c == '"' || c == '\\') o.Append('\\').Append(c); else if (c < 0x20 || c > 0x7e) o.AppendFormat("\\u{0:x4}", (int)c); else o.Append(c); }
    return o.Append('"').ToString();
  }

  static long Now() { return (long)(DateTime.UtcNow - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).TotalMilliseconds; }

  static void Write(string line)
  {
    lock (gate) { Console.Out.Write(line + "\n"); Console.Out.Flush(); }
  }

  static void OnEvent(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time)
  {
    if (hwnd == IntPtr.Zero) return;
    IntPtr root = GetAncestor(hwnd, GA_ROOT);
    if (root == IntPtr.Zero) root = hwnd;
    if (ev == EVENT_OBJECT_FOCUS) { if (root == lastFocusRoot) return; lastFocusRoot = root; }
    string name = ev == EVENT_SYSTEM_FOREGROUND ? "foreground" : ev == EVENT_OBJECT_FOCUS ? "focus" : ev == EVENT_SYSTEM_MINIMIZESTART ? "minimize-start" : "minimize-end";
    uint pid; GetWindowThreadProcessId(root, out pid);
    bool win = (GetAsyncKeyState(0x5B) & 0x8000) != 0 || (GetAsyncKeyState(0x5C) & 0x8000) != 0;
    bool alt = (GetAsyncKeyState(0x12) & 0x8000) != 0;
    Write("{\"t\":" + Now() + ",\"event\":\"" + name + "\",\"hwnd\":" + hwnd.ToInt64() + ",\"root\":" + root.ToInt64()
      + ",\"class\":" + Json(Text(root, true)) + ",\"title\":" + Json(Text(root, false)) + ",\"pid\":" + pid
      + ",\"image\":" + Json(Image(pid)) + ",\"win\":" + (win ? "true" : "false") + ",\"alt\":" + (alt ? "true" : "false") + "}");
  }

  public static void Run()
  {
    uint tid = GetCurrentThreadId();
    IntPtr a = SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, proc, 0, 0, WINEVENT_OUTOFCONTEXT);
    IntPtr b = SetWinEventHook(EVENT_SYSTEM_MINIMIZESTART, EVENT_SYSTEM_MINIMIZEEND, IntPtr.Zero, proc, 0, 0, WINEVENT_OUTOFCONTEXT);
    IntPtr c = SetWinEventHook(EVENT_OBJECT_FOCUS, EVENT_OBJECT_FOCUS, IntPtr.Zero, proc, 0, 0, WINEVENT_OUTOFCONTEXT);
    if (a == IntPtr.Zero) { Console.Error.WriteLine("SetWinEventHook failed"); return; }
    // Its input closing (the test done, or gone) ends the message loop.
    Thread reader = new Thread(delegate () { try { while (Console.In.ReadLine() != null) { } } catch { } PostThreadMessage(tid, WM_QUIT, IntPtr.Zero, IntPtr.Zero); });
    reader.IsBackground = true;
    reader.Start();
    Write("{\"ready\":true,\"t\":" + Now() + "}");
    MSG msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
    UnhookWinEvent(a); if (b != IntPtr.Zero) UnhookWinEvent(b); if (c != IntPtr.Zero) UnhookWinEvent(c);
  }
}
'@

try {
  Add-Type -TypeDefinition $source -Language CSharp
} catch {
  [Console]::Error.WriteLine('win_foreground_watch: ' + $_.Exception.Message)
  exit 1
}
[Console]::OutputEncoding = New-Object Text.UTF8Encoding $false
[EmberForegroundWatch]::Run()
