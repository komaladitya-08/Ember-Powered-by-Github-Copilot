/**
 * The shared Windows bench (test/fixtures/win_bench.ps1), which only builds and runs on Windows, checked on any OS:
 * what Windows PowerShell 5.1 and the .NET Framework's C# 5 compiler need (ASCII, nothing newer than C# 5, only the
 * referenced assemblies' namespaces); its own program, EmberBench.exe, also as a 32-bit build, that ends with the
 * PowerShell that started it; and the controls and log lines the window-system, bridge and host tests rely on, as
 * the file's header documents them.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const bytes = fs.readFileSync(path.resolve("test/fixtures/win_bench.ps1"));
const ps1 = bytes.toString("latin1");
const start = ps1.indexOf("$source = @'\n");
const end = ps1.indexOf("\n'@\n", start);
const cs = ps1.slice(start + "$source = @'\n".length, end);
const header = ps1.slice(0, ps1.indexOf("#>"));
const wrapper = ps1.slice(end);

/** The C# with comments, string and character literals blanked out, so prose can mention any feature. */
function code(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (two === "/*") {
      const close = source.indexOf("*/", i + 2);
      i = close < 0 ? source.length : close + 2;
    } else if (source[i] === "\"" || source[i] === "'") {
      const quote = source[i++];
      while (i < source.length && source[i] !== quote) i += source[i] === "\\" ? 2 : 1;
      i++;
      out += quote + quote;
    } else {
      out += source[i++];
    }
  }
  return out;
}

describe("the Windows bench's script", () => {
  it("is plain ASCII without a byte-order mark, so Windows PowerShell 5.1 reads it the same in every locale", () => {
    const offending = [...bytes].findIndex(b => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09));
    expect(offending, `a non-ASCII or control byte at offset ${offending}`).toBe(-1);
  });

  it("holds the C# in one here-string, and its comment block isn't closed early", () => {
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(cs).toContain("namespace Ember.Bench");
    // "#>" anywhere in the header (such as "C#>") would end PowerShell's comment block there.
    const close = ps1.indexOf("#>");
    expect(ps1.slice(close, close + 9)).toBe("#>\nparam(");
    expect(header).toContain("ASCII only: Windows PowerShell 5.1 reads a script without a BOM");
  });

  it("compiles the form into EmberBench.exe as a Windows application, for any CPU or as a 32-bit build", () => {
    expect(wrapper).toContain("'EmberBench.exe'");
    expect(wrapper).toContain("New-Object Microsoft.CSharp.CSharpCodeProvider");
    expect(wrapper).toContain("'/target:winexe /platform:' + $Platform");
    expect(ps1).toContain("[ValidateSet('anycpu', 'x86')][string]$Platform = 'anycpu'");
    for (const ref of ["System.dll", "System.Drawing.dll", "System.Windows.Forms.dll"]) expect(wrapper).toContain(`'${ref}'`);
    // Built once per version of the C#, into a folder named after its hash and the platform.
    expect(wrapper).toContain("Get-Bench (Get-Hash $source) $Platform");
    expect(wrapper).toContain("$name = $Hash + '-' + $Platform");
    // Renamed into place in one step, so two tests building at once never run a half-written program.
    expect(wrapper).toContain("[IO.Directory]::Move($work, $dir)");
  });

  it("prints the program's path for -BuildOnly as one JSON line in UTF-8", () => {
    expect(wrapper).toMatch(/if \(\$BuildOnly\) \{[\s\S]*'\{"exe":"'[\s\S]*UTF8Encoding \$false[\s\S]*OpenStandardOutput\(\)[\s\S]*exit 0/);
  });

  it("runs the bench as its own process, which ends when the PowerShell that started it does", () => {
    expect(wrapper).toContain("'-ParentPid', [string]$PID");
    expect(wrapper).toContain("$start.UseShellExecute = $false");
    expect(wrapper).toContain("$bench.WaitForExit()");
    expect(wrapper.trimEnd().endsWith("exit $bench.ExitCode")).toBe(true);
    const main = cs.slice(cs.indexOf("private static int Main("));
    expect(main.indexOf("WatchParent(options.ParentPid)")).toBeGreaterThan(0);
    const watch = cs.slice(cs.indexOf("private static void WatchParent(int pid)"));
    expect(watch).toMatch(/parent\.WaitForExit\(\);[\s\S]*Quit\(\);/);
    expect(cs).toMatch(/internal static void Quit\(\)\s*\{\s*LogExit\(\);\s*Environment\.Exit\(0\);/);
  });
});

describe("the Windows bench's C#", () => {
  const plain = code(cs);

  it("uses nothing newer than C# 5, which is what the .NET Framework's compiler takes", () => {
    const newer: [RegExp, string][] = [
      [/\$@?"|@\$"/, "string interpolation"],
      [/\?\./, "null-conditional member access"],
      [/\?\[/, "null-conditional element access"],
      [/=>/, "lambdas or expression-bodied members (use anonymous methods)"],
      [/\bnameof\s*\(/, "nameof"],
      [/\bout\s+var\b|\bout\s+int\s+\w+\s*\)/, "out variables"],
      [/\bis\s+var\b|\bis\s+\w+\s+\w+\s*[)&|]/, "pattern matching"],
      [/\bcatch\s*\([^)]*\)\s*when\b/, "exception filters"],
      [/\{\s*get;\s*(set;\s*)?\}\s*=/, "auto-property initialisers"],
      [/\busing\s+static\b/, "using static"],
      [/\bawait\b|\basync\b/, "async"],
    ];
    for (const [pattern, feature] of newer) expect(plain, feature).not.toMatch(pattern);
    expect(cs, "string interpolation").not.toMatch(/\$@?"|@\$"/);
  });

  it("imports only namespaces of the assemblies it is compiled with (no System.Core)", () => {
    const allowed = new Set([
      "System", "System.Collections.Generic", "System.Diagnostics", "System.Drawing", "System.Globalization", "System.IO",
      "System.Runtime.InteropServices", "System.Text", "System.Threading", "System.Windows.Forms",
    ]);
    const usings = [...plain.matchAll(/\busing\s+([\w.]+)\s*;/g)].map(m => m[1]);
    expect(usings.length).toBeGreaterThan(0);
    for (const u of usings) expect(allowed.has(u), u).toBe(true);
    expect(plain).not.toMatch(/\bHashSet<|\bSystem\.Linq\b/);
  });

  it("is per-monitor DPI aware before its first window, so its rectangles are physical pixels", () => {
    const main = cs.slice(cs.indexOf("private static int Main("));
    expect(main.indexOf("Dpi.Setup()")).toBeGreaterThan(0);
    expect(main.indexOf("Dpi.Setup()")).toBeLessThan(main.indexOf("new BenchForm("));
    expect(cs).toContain("SetProcessDpiAwarenessContext(new IntPtr(-4))");
    expect(cs).toContain("return \"per-monitor-v2\";");
  });

  it("has the window and controls the tests find by name, in the documented order", () => {
    expect(cs).toContain("internal const string Title = \"Ember Bench (Windows)\";");
    const names = [...cs.matchAll(/\.AccessibleName = "([^"]+)";/g)].map(m => m[1]);
    expect(names).toEqual(["Name", "Password", "Remember me", "Theme", "Volume", "Fruit", "Save", "Open dialog", "Files", "Places"]);
    expect(header).toContain(
      "Controls (AccessibleName, in tab order): Name (text box, focused first), Password (password box), Remember me",
    );
    expect(cs).toContain("theme.Items.AddRange(new object[] { \"Light\", \"Dark\", \"System\" });");
    expect(cs).toContain("fruit.Items.AddRange(new object[] { \"Apple\", \"Banana\", \"Cherry\" });");
    expect(cs).toMatch(/volume\.Minimum = 0;\s*volume\.Maximum = 100;\s*volume\.TickFrequency = 10;\s*volume\.SmallChange = 1;\s*volume\.LargeChange = 10;/);
    expect(cs).toContain("MessageBox.Show(this, \"Saved?\", \"Ember Bench\", MessageBoxButtons.OKCancel)");
    expect(cs).toContain("files.View = View.Details;");
  });

  it("never logs the password, only its length", () => {
    expect(cs).toContain("passwordBox.UseSystemPasswordChar = true;");
    expect(plain).not.toMatch(/passwordBox\.Text\b/);
    expect(cs).toContain("Event(\"text\", \"Password\").Add(\"length\", passwordBox.TextLength)");
  });

  it("logs exactly the events its header documents", () => {
    const logged = new Set([
      ...[...cs.matchAll(/Event\("(\w+)"/g)].map(m => m[1]),
      ...[...cs.matchAll(/\.Add\("event", "(\w+)"\)/g)].map(m => m[1]),
    ]);
    const documented = new Set([...header.matchAll(/\{"event":"(\w+)"/g)].map(m => m[1]));
    expect([...logged].sort()).toEqual([...documented].sort());
    expect([...logged].sort()).toEqual([
      "busy", "click", "dialog", "error", "exit", "expand", "focus", "idle", "open", "ready", "select", "text", "toggle", "value",
    ]);
  });

  it("names its program and bitness in the ready line, and the layered window only with -Layered", () => {
    const ready = cs.slice(cs.indexOf("private void WriteReady()"), cs.indexOf("private void RunCommands()"));
    for (const key of ["hwnd", "pid", "program", "bits", "dpi", "window", "controls", "items"]) expect(ready).toContain(`.Add("${key}", `);
    expect(ready).toContain(".Add(\"program\", self.ProcessName)");
    expect(ready).toContain(".Add(\"bits\", IntPtr.Size * 8)");
    expect(ready).toMatch(/if \(swatch != null\) line\.Add\("layered", /);
    // The swatch: layered through a constant alpha below 255, pure red, never activated.
    expect(cs).toMatch(/internal const int Alpha = (\d+);/);
    expect(Number(/internal const int Alpha = (\d+);/.exec(cs)![1])).toBeLessThan(255);
    expect(cs).toContain("BackColor = Color.FromArgb(255, 0, 0);");
    expect(cs).toContain("Opacity = Alpha / 255.0;");
    expect(cs).toMatch(/ShowWithoutActivation\s*\{\s*get \{ return true; \}/);
  });

  it("keeps its UI thread busy only when told, and logs a failing handler instead of showing a dialog", () => {
    const commands = cs.slice(cs.indexOf("private void RunCommands()"));
    expect(commands).toMatch(/Log\.Write\(new Json\(\)\.Add\("event", "busy"\)[\s\S]*Thread\.Sleep\(ms\);[\s\S]*"idle"/);
    expect(cs).toMatch(/if \(options\.CommandsPath != null\)/);
    expect(cs).toContain("Application.SetUnhandledExceptionMode(UnhandledExceptionMode.CatchException);");
  });
});
