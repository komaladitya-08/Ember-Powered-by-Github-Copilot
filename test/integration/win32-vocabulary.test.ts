/**
 * The Windows vocabularies (design §9.11) against real windows: a console window is a terminal by its program and by
 * its window class, whatever it hosts; Notepad is no terminal, shell app or security window; the stored-credentials
 * dialog is a security window by its title and the Credential Backup wizard by its program, and systemDialogOpen sees
 * each (and is false again once they close); File Explorer's address box and the Run dialog's box carry the names
 * TYPING_REFUSED expects (read with UI Automation, as the bridge reads them); and through a real Electron, a password
 * manager's copy is recognised by CLIPBOARD_FORMATS.win32, an image copy saves without a GDI handle format, and the
 * text Ember pastes carries ExcludeClipboardContentFromMonitorProcessing as Windows itself lists it (the G5 check).
 * Each check prints what it saw, so a name that differs on a runner is in the log.
 *
 * Skipped off Windows; with EMBER_WINSYS_TEST=1 it fails instead of skipping when Windows, the window system, Windows
 * PowerShell or Electron is missing.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Rect, ScreenLike } from "../../app/main/platform/types";
import { openWin32Windows, win32Error, type Win32WindowSystem } from "../../app/main/platform/win32";
import { loadWin32 } from "../../app/main/platform/win32/ffi";
import { loadWin32System } from "../../app/main/platform/win32/system/ffi";
import { win32SystemDialog, type SecurityVocabulary } from "../../app/main/platform/win32/system/system-dialog";
import { hasBuiltInShell, isSecurityClass, isSecurityWindow, isTerminalApp } from "../../app/main/platform/win32/system/interim";
import { TERMINAL_CLASSES } from "../../app/main/hands/terminals";
import { OFFICE_APP, SECURITY_APP, SECURITY_TITLE, TABBED_APP, TYPING_REFUSED } from "../../app/main/policy/vocabulary";
import { CLIPBOARD_FORMATS } from "../../app/main/agent/clipboard-formats";
import { normalizeLabel } from "../../app/main/policy/policy";
import { friendlyApp, useAppNames } from "../../app/shared/apps";
import { runClipboardChild } from "./vocabulary-clipboard";

const required = process.env.EMBER_WINSYS_TEST === "1";
const onWindows = process.platform === "win32";
const root = fileURLToPath(new URL("../../", import.meta.url));
const powershell = path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const W = "win32" as const;
const VOCAB: SecurityVocabulary = { isSecurityWindow: w => isSecurityWindow(w, W), isSecurityClass };
const screen: ScreenLike = { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 }, scaleFactor: 1 }), getAllDisplays: () => [] };

/** Runs a Windows PowerShell script (single-threaded apartment, as the clipboard and UI Automation want; UTF-8 out). */
function ps(script: string, timeout = 60_000): string {
  return execFileSync(powershell, ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command",
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $ErrorActionPreference = 'Stop'; ${script}`], { encoding: "utf8", timeout, windowsHide: true }).trim();
}

/** Starts a program with its own window (Start-Process, so a console program gets a console of its own) and gives its pid. */
const start = (file: string, args = "") => Number(ps(`(Start-Process -FilePath ${quote(file)}${args ? ` -ArgumentList ${quote(args)}` : ""} -PassThru).Id`).split(/\r?\n/).pop()) || 0;
const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const kill = (pid: number) => { if (pid) try { execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); } catch { /* already gone */ } };

/** Polls `fn` until it gives something truthy, or fails after `ms` saying what was awaited. */
async function waitFor<T>(fn: () => T | null | undefined | false, ms: number, what: string): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

describe.skipIf(!onWindows && !required)("the Windows vocabularies against real windows", () => {
  let ws: Win32WindowSystem;
  const started: number[] = [];

  /** A top-level window whose title contains `title` (any case), from the stack, with its Win32 class. */
  const windowTitled = (title: string) => {
    const w = ws.stack().find(s => s.title.toLowerCase().includes(title.toLowerCase()));
    return w ? { ...w, className: loadWin32()?.className(w.id) ?? "" } : null;
  };
  const dialogOpen = () => {
    const sys = loadWin32System();
    return win32SystemDialog(ws, loadWin32(), sys ? (hwnd: number): Rect | null => sys.monitorRect(hwnd) : null, VOCAB);
  };

  beforeAll(() => {
    if (!onWindows) throw new Error("EMBER_WINSYS_TEST=1, but this isn't Windows");
    const opened = openWin32Windows({ screen });
    if (!opened) throw new Error(`the Windows window system didn't open: ${String(win32Error)}`);
    ws = opened;
    useAppNames(W);
  });

  afterAll(() => {
    for (const pid of started) kill(pid);
    ws?.close();
    useAppNames("linux");
  });

  it("judges a console window a terminal by its program and by its class, whatever it hosts", async () => {
    const title = `Ember vocabulary ${process.pid}`;
    const pid = start(path.win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), `/k title ${title}`);
    started.push(pid);
    const win = await waitFor(() => ws.clientWindows().find(w => w.title.includes(title)), 15_000, `a console window titled "${title}"`);
    console.log(`console window: ${JSON.stringify({ wmClass: win.wmClass, wmClassName: win.wmClassName, clientProgram: win.clientProgram, title: win.title })}`);
    expect(isTerminalApp({ id: win.wmClass, name: win.wmClass }, W)).toBe(true);
    expect(isTerminalApp({ id: "x", name: "x", windowClass: win.wmClassName }, W)).toBe(true);
    expect(TERMINAL_CLASSES.win32.map(c => c.toLowerCase())).toContain(win.wmClassName.toLowerCase());
    if (win.clientProgram) expect(isTerminalApp({ id: win.clientProgram, name: win.clientProgram }, W)).toBe(true);
    kill(pid);
  }, 60_000);

  it("doesn't take Notepad for a terminal, an app with a shell, a security window or an office suite", async () => {
    const pid = start("notepad.exe");
    started.push(pid);
    const win = await waitFor(() => ws.clientWindows().find(w => w.pid === pid || w.wmClass === "notepad"), 15_000, "Notepad's window");
    console.log(`Notepad's window: ${JSON.stringify({ wmClass: win.wmClass, wmClassName: win.wmClassName, title: win.title })}`);
    expect(win.wmClass.toLowerCase()).toBe("notepad");
    expect(isTerminalApp({ id: win.wmClass, name: win.wmClass, windowClass: win.wmClassName }, W)).toBe(false);
    expect(hasBuiltInShell({ id: win.wmClass, name: win.wmClass }, W)).toBe(false);
    expect(isSecurityWindow({ app: win.wmClass, title: win.title }, W)).toBe(false);
    expect(TABBED_APP.win32?.test(win.wmClass)).toBe(false);
    expect(OFFICE_APP.win32?.test(win.wmClass)).toBe(false);
    expect(friendlyApp(win.wmClass)).toBe("Notepad");
    kill(pid);
  }, 60_000);

  it("knows the stored-credentials dialog by its title, and systemDialogOpen sees it while it is up", async () => {
    expect(dialogOpen()).toBe(false); // at rest
    const pid = start("rundll32.exe", "keymgr.dll,KRShowKeyMgr");
    started.push(pid);
    try {
      const win = await waitFor(() => windowTitled("Stored User Names and Passwords"), 15_000, "the Stored User Names and Passwords dialog");
      console.log(`keymgr dialog: ${JSON.stringify({ wmClass: win.wmClass, className: win.className, title: win.title })}`);
      expect(SECURITY_TITLE.win32?.test(normalizeLabel(win.title))).toBe(true);
      expect(isSecurityWindow({ app: win.wmClass, title: win.title }, W)).toBe(true);
      expect(dialogOpen()).toBe(true);
    } finally {
      kill(pid);
    }
    await waitFor(() => !windowTitled("Stored User Names and Passwords"), 10_000, "the dialog to close");
    expect(dialogOpen()).toBe(false);
  }, 60_000);

  it("knows the Credential Backup wizard by its program", async () => {
    const pid = start("credwiz.exe");
    started.push(pid);
    try {
      const win = await waitFor(() => ws.stack().find(w => w.pid === pid || w.wmClass.toLowerCase() === "credwiz"), 15_000, "credwiz's window");
      console.log(`credwiz window: ${JSON.stringify({ wmClass: win.wmClass, title: win.title })}`);
      expect(SECURITY_APP.win32?.test(win.wmClass)).toBe(true);
      expect(isSecurityWindow({ app: win.wmClass }, W)).toBe(true);
      expect(dialogOpen()).toBe(true);
    } finally {
      kill(pid);
    }
  }, 60_000);

  it("finds File Explorer's address box and the Run dialog's box under the names TYPING_REFUSED refuses programs in", () => {
    // Read with UI Automation, as the bridge reads names: the address edit (AutomationId 41477) and the address band's
    // controls of a File Explorer window, and the Run dialog's combo box (Shell.Application.FileRun opens it in explorer.exe).
    const out = ps(`
      Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
      $A = [System.Windows.Automation.AutomationElement]
      $T = [System.Windows.Automation.TreeScope]
      function Where-Is($property, $value) { New-Object System.Windows.Automation.PropertyCondition($property, $value) }
      function Find-Top($class, $name) {
        $A::RootElement.FindAll($T::Children, (Where-Is ($A::ClassNameProperty) $class)) | Where-Object { $_.Current.Name -like $name } | Select-Object -First 1
      }
      function Close-Window($w) { try { $w.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern).Close() } catch { } }
      $shell = New-Object -ComObject Shell.Application
      $shell.Open('C:\\Windows')
      $win = $null
      for ($i = 0; $i -lt 100 -and -not $win; $i++) { Start-Sleep -Milliseconds 150; $win = Find-Top 'CabinetWClass' '*Windows*' }
      $address = @(); $band = @()
      if ($win) {
        $address = @($win.FindAll($T::Descendants, (Where-Is ($A::AutomationIdProperty) '41477')) | ForEach-Object { $_.Current.Name })
        $root = $win.FindFirst($T::Descendants, (Where-Is ($A::NameProperty) 'Address Band Root'))
        if ($root) { $band = @($root.FindAll($T::Descendants, [System.Windows.Automation.Condition]::TrueCondition) | ForEach-Object { $_.Current.Name } | Where-Object { $_ }) }
        Close-Window $win
      }
      $shell.FileRun()
      $run = $null
      for ($i = 0; $i -lt 100 -and -not $run; $i++) { Start-Sleep -Milliseconds 150; $run = Find-Top '#32770' 'Run' }
      $box = @(); $program = ''
      if ($run) {
        $combo = Where-Is ($A::ControlTypeProperty) ([System.Windows.Automation.ControlType]::ComboBox)
        $box = @($run.FindAll($T::Descendants, $combo) | ForEach-Object { $_.Current.Name })
        $program = (Get-Process -Id $run.Current.ProcessId).ProcessName
        Close-Window $run
      }
      [pscustomobject]@{ explorer = [bool]$win; address = $address; band = $band; run = [bool]$run; box = $box; program = $program } | ConvertTo-Json -Compress -Depth 3
    `, 90_000);
    console.log(`File Explorer and Run: ${out}`);
    const seen = JSON.parse(out.split(/\r?\n/).pop() ?? "{}") as { explorer: boolean; address: string[] | string; band: string[] | string; run: boolean; box: string[] | string; program: string };
    const list = (v: string[] | string | null | undefined) => (Array.isArray(v) ? v : v ? [v] : []);
    const [addressRule, runRule] = TYPING_REFUSED.win32;
    expect(seen.explorer, "a File Explorer window on C:\\Windows").toBe(true);
    const address = list(seen.address);
    // The edit the user (and Ember) types into, whenever UI Automation lists it; and the address band, which always shows.
    for (const name of address) expect(addressRule.field.test(name.trim()), name).toBe(true);
    expect(list(seen.band).some(name => addressRule.field.test(name.trim())), `one of ${JSON.stringify(seen.band)}`).toBe(true);
    expect(addressRule.app.test("explorer")).toBe(true);
    expect(seen.run, "the Run dialog").toBe(true);
    expect(seen.program.toLowerCase()).toBe("explorer");
    expect(runRule.app.test(seen.program)).toBe(true);
    expect(list(seen.box).some(name => runRule.field.test(name.trim())), `one of ${JSON.stringify(seen.box)}`).toBe(true);
  }, 120_000);

  describe("the clipboard, through a real Electron", () => {
    const OWN = "ExcludeClipboardContentFromMonitorProcessing";
    /** The clipboard as Windows lists it: its native formats and its text. */
    const nativeClipboard = () => JSON.parse(ps(`Add-Type -AssemblyName System.Windows.Forms
      $o = [System.Windows.Forms.Clipboard]::GetDataObject()
      [pscustomobject]@{ formats = @(if ($o) { $o.GetFormats($false) }); text = [System.Windows.Forms.Clipboard]::GetText() } | ConvertTo-Json -Compress`).split(/\r?\n/).pop() ?? "{}") as { formats: string[] | string; text: string };

    for (const marker of [OWN, "Clipboard Viewer Ignore"]) {
      it(`recognises a password manager's copy marked "${marker}", and marks Ember's own paste text for Windows`, async () => {
        ps(`Add-Type -AssemblyName System.Windows.Forms
          $d = New-Object System.Windows.Forms.DataObject
          $d.SetData([System.Windows.Forms.DataFormats]::UnicodeText, 'hunter2')
          $d.SetData(${quote(marker)}, (New-Object System.IO.MemoryStream (,[byte[]](0, 0, 0, 0))))
          [System.Windows.Forms.Clipboard]::SetDataObject($d, $true)`);
        const report = await runClipboardChild(root, `Ember paste ${process.pid}`);
        console.log(`Electron's clipboard with "${marker}": ${JSON.stringify(report)}`);
        expect(report.readError ?? report.saveError ?? report.writeError ?? report.readAfterError).toBeUndefined();
        const listed = (report.before ?? []).flat();
        expect(listed.some(t => CLIPBOARD_FORMATS.win32.passwordMarker(t)), `a password marker among ${JSON.stringify(listed)}`).toBe(true);
        expect(report.password).toBe(true);
        const after = nativeClipboard();
        console.log(`Windows' clipboard after Ember's paste text: ${JSON.stringify(after)}`);
        const formats = Array.isArray(after.formats) ? after.formats : [after.formats];
        expect(formats).toContain(OWN);
        expect(after.text).toBe(`Ember paste ${process.pid}`);
      }, 120_000);
    }

    it("saves an image copy without reading a GDI handle format", async () => {
      ps(`Add-Type -AssemblyName System.Windows.Forms, System.Drawing
        $b = New-Object System.Drawing.Bitmap 8, 8
        [System.Windows.Forms.Clipboard]::SetImage($b)`);
      const report = await runClipboardChild(root, `Ember paste ${process.pid}`);
      console.log(`Electron's clipboard with an image: ${JSON.stringify(report)}`);
      expect(report.saveError).toBeUndefined();
      expect(report.password).toBe(false);
      const read = (report.before ?? []).flat().filter(t => CLIPBOARD_FORMATS.win32.savable(t));
      for (const t of read) expect(t, t).not.toMatch(/CF_(BITMAP|ENHMETAFILE|METAFILEPICT|PALETTE|DSP)/i);
    }, 120_000);
  });
});
