/**
 * Source checks for the Windows UI Automation bridge (sidecar/uia), which can only be compiled and run on Windows.
 * Windows PowerShell 5.1 reads a script or C# file without a byte-order mark in the ANSI code page and compiles C# 5
 * only, the bootstrap must never handle screen data (PowerShell's logging records what passes through cmdlets), and
 * the sidecar host is written against PROTOCOL.md, so the documented methods must be the ones the bridge dispatches.
 */

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve("sidecar/uia");
const read = (name: string) => fs.readFileSync(path.join(dir, name));
const ps1 = read("ember_uia.ps1").toString("latin1");
const cs = read("ember_uia.cs").toString("latin1");
const protocol = read("PROTOCOL.md").toString("utf8");

/** The C# with comments, string and character literals blanked out, so prose can mention any feature. */
function code(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "//") {
      while (i < source.length && source[i] !== "\n") i++;
    } else if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
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

/** The method names in the bridge's dispatch table. */
function dispatched(source: string): string[] {
  return [...source.matchAll(/new MethodSpec\("(\w+)"/g)].map(m => m[1]).sort();
}

/** The method names PROTOCOL.md documents ("### `name`" headings under "## Methods"). */
function documented(markdown: string): string[] {
  const start = markdown.indexOf("\n## Methods");
  expect(start).toBeGreaterThan(0);
  const rest = markdown.slice(start + 1);
  const next = rest.indexOf("\n## ", 1);
  const section = next < 0 ? rest : rest.slice(0, next);
  return [...section.matchAll(/^### `(\w+)`/gm)].map(m => m[1]).sort();
}

describe("the UI Automation bridge's files", () => {
  it("are plain ASCII without a byte-order mark, so Windows PowerShell 5.1 reads them the same in every locale", () => {
    for (const name of ["ember_uia.ps1", "ember_uia.cs", "PROTOCOL.md"]) {
      const bytes = read(name);
      expect(bytes.length).toBeGreaterThan(0);
      const offending = [...bytes].findIndex(b => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09));
      expect(offending, `${name} has a non-ASCII or control byte at offset ${offending}`).toBe(-1);
    }
  });

  it("put the bridge's core between markers that the transport tests build on their own", () => {
    const begins = cs.indexOf("// ---- core begins");
    const ends = cs.indexOf("// ---- core ends");
    expect(begins).toBeGreaterThan(0);
    expect(ends).toBeGreaterThan(begins);
    // Nothing in the core may need UI Automation or Win32.
    expect(code(cs.slice(begins, ends))).not.toMatch(/AutomationElement|DllImport|Native\.|Win\.|Props\./);
  });
});

describe("the bridge's bootstrap (ember_uia.ps1)", () => {
  const lines = ps1.split(/\r?\n/).map(l => l.trim()).filter(l => l && !l.startsWith("#"));

  it("is only a bootstrap: it compiles or loads the bridge and hands over to Run()", () => {
    expect(lines[0]).toBe("Set-StrictMode -Version Latest");
    expect(lines.length).toBeLessThan(90);
    expect(ps1).toContain("$env:EMBER_UIA_CACHE");
    expect(ps1).toMatch(/Add-Type -Path \$source -ReferencedAssemblies \$refs -OutputAssembly/);
    expect(ps1).toContain("[Reflection.Assembly]::Load($bytes)");
    expect(ps1).toContain("$assembly.GetType('Ember.Uia.Bridge', $true)");
    expect(ps1).toContain("$code = $bridge::Run()");
    expect(lines[lines.length - 1]).toBe("exit $code");
  });

  it("never handles screen data: no stdin, no UI Automation, no serialising or output cmdlets", () => {
    const forbidden = [
      /ConvertTo-Json/i, /ConvertFrom-Json/i, /Out-String/i, /Out-File/i, /Out-Host/i, /Write-Host/i, /Write-Information/i,
      /Write-Verbose/i, /Write-Debug/i, /Tee-Object/i, /Set-Content/i, /Add-Content/i, /Export-/i, /Format-/i, /Start-Transcript/i,
      /Read-Host/i, /\$input\b/i, /\[Console\]::In\b/i, /OpenStandardInput/i, /ReadLine/i, /ReadToEnd/i,
      /FindAll/i, /FindFirst/i, /TreeWalker/i, /CacheRequest/i, /GetCurrentPattern/i, /GetCurrentPropertyValue/i,
      /::RootElement/i, /::FromHandle/i, /::FromPoint/i, /::FocusedElement/i, /\.Current\./i,
    ];
    for (const pattern of forbidden) expect(ps1, String(pattern)).not.toMatch(pattern);
  });

  it("leaves this version's files to another bridge that may still be compiling it, and recompiles an unloadable build", () => {
    expect(ps1).toContain("$mine = $name.StartsWith('ember_uia-' + $hash + '.', [StringComparison]::Ordinal)");
    expect(ps1).toMatch(/if \(-not \$mine -or \(\$name\.Contains\('\.tmp\.'\) -and .*-lt \$stale\)\) \{ \[IO\.File\]::Delete\(\$old\) \}/);
    // A cached build that can't be read or loaded falls through to a compile instead of a fatal line.
    const hit = ps1.slice(ps1.indexOf("[IO.File]::Exists($dll)"), ps1.indexOf("if ($null -eq $assembly)"));
    expect(hit).toMatch(/try \{[\s\S]*\[Reflection\.Assembly\]::Load\(\$bytes\)[\s\S]*\} catch \{/);
    expect(ps1).toContain("[IO.Path]::GetFullPath($env:EMBER_UIA_CACHE)");
  });

  it("writes to the pipeline only the fatal line, and only when the .NET stream is blocked", () => {
    const outputs = [...ps1.matchAll(/Write-Output\b.*$/gim)].map(m => m[0].trim());
    expect(outputs).toEqual(["Write-Output $line"]);
    const fatal = ps1.slice(ps1.indexOf("function Write-Fatal"), ps1.indexOf("function Get-Sha256"));
    expect(fatal).toContain("Write-Output $line");
    expect(fatal).toContain("'{\"fatal\":\"'");
    // The message is cut to printable ASCII and escaped for JSON.
    expect(fatal).toContain("-replace '[^\\x20-\\x7E]', ' '");
  });
});

describe("the bridge's C# (ember_uia.cs)", () => {
  const plain = code(cs);

  it("uses nothing newer than C# 5, which is what Add-Type compiles with on Windows PowerShell 5.1", () => {
    const newer: [RegExp, string][] = [
      [/\$@?"|@\$"/, "string interpolation"],
      [/\?\./, "null-conditional member access"],
      [/\?\[/, "null-conditional element access"],
      [/=>/, "lambdas or expression-bodied members (use anonymous methods)"],
      [/\bnameof\s*\(/, "nameof"],
      [/\bout\s+var\b/, "out variables"],
      [/\bis\s+var\b|\bis\s+\w+\s+\w+\s*[)&|]/, "pattern matching"],
      [/\bcatch\s*\([^)]*\)\s*when\b/, "exception filters"],
      [/\{\s*get;\s*(set;\s*)?\}\s*=/, "auto-property initialisers"],
      [/\busing\s+static\b/, "using static"],
      [/\bawait\b|\basync\b/, "async (needs System.Threading.Tasks plumbing the bridge doesn't use)"],
    ];
    for (const [pattern, feature] of newer) expect(plain, feature).not.toMatch(pattern);
    expect(cs, "string interpolation").not.toMatch(/\$@?"|@\$"/);
  });

  it("imports only namespaces from the assemblies the bootstrap references (no System.Core)", () => {
    const allowed = new Set([
      "System", "System.Collections", "System.Collections.Generic", "System.Diagnostics", "System.Globalization", "System.IO",
      "System.Reflection", "System.Runtime.InteropServices", "System.Text", "System.Threading", "System.Windows",
      "System.Windows.Automation", "System.Windows.Automation.Text",
    ]);
    const usings = [...plain.matchAll(/\busing\s+([\w.]+)\s*;/g)].map(m => m[1]);
    expect(usings.length).toBeGreaterThan(0);
    for (const u of usings) expect(allowed.has(u), u).toBe(true);
    expect(plain).not.toMatch(/\bHashSet</);
  });

  it("is entered through [Ember.Uia.Bridge]::Run() and speaks protocol version 1", () => {
    expect(cs).toMatch(/namespace Ember\.Uia\b/);
    expect(cs).toMatch(/public static class Bridge\b/);
    expect(cs).toMatch(/public static int Run\(\)/);
    expect(cs).toContain("public const int Version = 1;");
    expect(protocol).toMatch(/^# The UI Automation bridge: wire protocol \(version 1\)/);
    expect(protocol).toContain("{\"ready\":true,\"version\":1,\"dpi\":\"per-monitor-v2\"}");
    expect(cs).toContain(".Add(\"ready\", true).Add(\"version\", Version).Add(\"dpi\", dpi)");
  });

  it("sets Per-Monitor-V2 DPI awareness before UI Automation, falling back to each worker thread", () => {
    const run = cs.slice(cs.indexOf("public static int Run()"));
    expect(run.indexOf("Dpi.Setup()")).toBeGreaterThan(0);
    expect(run.indexOf("Dpi.Setup()")).toBeLessThan(run.indexOf("Methods.Table()"));
    expect(cs).toContain("SetProcessDpiAwarenessContext(PerMonitorV2)");
    expect(cs).toContain("SetThreadDpiAwarenessContext(PerMonitorV2)");
    expect(cs).toContain("new Pool(64, Dpi.ThreadInit)");
  });

  it("never fetches a value in a batch, and checks for a password field before reading or setting text", () => {
    const batch = cs.slice(cs.indexOf("AutomationProperty[] All"), cs.indexOf("};", cs.indexOf("AutomationProperty[] All")));
    expect(batch).toContain("AutomationElement.IsPasswordProperty");
    expect(batch).not.toMatch(/(?<!Range)ValuePattern\.ValueProperty/);
    expect(batch).toContain("RangeValuePattern.ValueProperty");
    expect(batch).not.toMatch(/LegacyIAccessible|\bTextPattern\./);
    const setValue = cs.slice(cs.indexOf("case \"setValue\":"), cs.indexOf("case \"setRange\":"));
    expect(setValue.indexOf("Props.IsSecret(el)")).toBeGreaterThan(0);
    expect(setValue.indexOf("Props.IsSecret(el)")).toBeLessThan(setValue.indexOf(".SetValue(value)"));
    expect(setValue).toContain("new BridgeError(\"denied\"");
    const textInfo = cs.slice(cs.indexOf("private static object TextInfo(Call c)"));
    expect(textInfo.indexOf("Props.IsSecret(el)")).toBeGreaterThan(0);
    expect(textInfo.indexOf("Props.IsSecret(el)")).toBeLessThan(textInfo.indexOf("TryGetCurrentPattern"));
    // Snapshot values are read only once IsPassword said false (unknown counts as a password).
    expect(cs).toContain("if (want.Values && password == false) ReadValue(el, node, type, v);");
  });

  it("never lets one cached property's failure fail a read, and gives UIA's all-zero rectangle as no bounds", () => {
    // A cached failure is rethrown as whatever its HRESULT maps to (NotImplementedException, TimeoutException...).
    const start = cs.indexOf("internal static object Get(AutomationElement el, AutomationProperty p)");
    const get = cs.slice(start, cs.indexOf("\n    }\n", start));
    expect(get).toMatch(/catch \(Exception\) \{ return null;/);
    expect(cs).toContain("if (el == null) throw new ElementNotAvailableException();");
    const bounds = cs.slice(cs.indexOf("internal static object Bounds(Rect r)"));
    expect(bounds.slice(0, bounds.indexOf("return null;"))).toContain("(r.Width <= 0 && r.Height <= 0)");
  });

  it("answers only with the error codes PROTOCOL.md documents", () => {
    const codes = new Set([...cs.matchAll(/new BridgeError\("(\w+)"/g)].map(m => m[1]));
    codes.add("bad_request"); // Args.Bad
    expect([...codes].sort()).toEqual(["bad_request", "busy", "denied", "failed", "gone"]);
    for (const c of codes) expect(protocol).toContain("| `" + c + "` |");
    for (const m of cs.matchAll(/internal const string \w+ = "([^"]+)";/g)) expect(protocol, m[1]).toContain(m[1]);
  });
});

describe("the bridge's protocol (PROTOCOL.md)", () => {
  it("documents exactly the methods in the bridge's dispatch table", () => {
    const table = dispatched(cs);
    expect(table).toEqual([
      "children", "element", "elementsAt", "focused", "perform", "ping", "release", "snapshot", "status", "textInfo", "topWindows",
    ]);
    expect(documented(protocol)).toEqual(table);
  });

  it("documents every perform op the bridge handles", () => {
    const perform = cs.slice(cs.indexOf("private static object Perform(Call c)"), cs.indexOf("// ---- textInfo"));
    const ops = [...perform.matchAll(/case "(\w+)":/g)].map(m => m[1]).sort();
    expect(ops.length).toBe(12);
    const section = protocol.slice(protocol.indexOf("### `perform`"), protocol.indexOf("### `textInfo`"));
    const listed = [...section.matchAll(/^\| `(\w+)` \|/gm)].map(m => m[1]).sort();
    expect(listed).toEqual(ops);
  });

  it("starts the bridge with the absolute Windows PowerShell 5.1 path, hidden, without PSModulePath", () => {
    expect(protocol).toContain(
      "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <dir>\\ember_uia.ps1",
    );
    expect(protocol).toContain("windowsHide: true");
    expect(protocol).toContain("**without `PSModulePath`**");
  });
});
