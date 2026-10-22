/**
 * The Windows vocabularies (design §9.11) against real windows: a console window is a terminal by its program and by
 * its window class, whatever it hosts; Notepad is no terminal, shell app or security window; the stored-credentials
 * dialog is a security window by its title and the Credential Backup wizard by its program, and systemDialogOpen sees
 * each (and is false again once they close); File Explorer's address box and the Run dialog's box carry the names
 * TYPING_REFUSED expects (read through Ember's own accessibility host, the names the policy is given: the address
 * band at rest, and the box that has the keyboard after Alt+D), and the window roles READ_ONLY_WINDOW tells the Run
 * dialog from a folder window by; and through a real Electron, a password
 * manager's copy is recognised by CLIPBOARD_FORMATS.win32, an image copy saves without a GDI handle format, and the
 * text Ember pastes carries ExcludeClipboardContentFromMonitorProcessing as Windows itself lists it (the G5 check).
 * Each check prints what it saw, so a name that differs on a runner is in the log.
 *
 * Skipped off Windows; with EMBER_WINSYS_TEST=1 it fails instead of skipping when Windows, the window system, Windows
 * PowerShell or Electron is missing.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildSync } from "esbuild";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Rect, ScreenLike } from "../../app/main/platform/types";
import type { Logger } from "../../app/main/logger";
import { AtspiSidecar, type AxNode } from "../../app/main/perception/sidecar";
import { hostLaunch } from "../../app/sidecar-host/launch";
import { openWin32Input, openWin32Windows, win32Error, type Win32WindowSystem } from "../../app/main/platform/win32";
import { loadWin32 } from "../../app/main/platform/win32/ffi";
import { loadWin32System } from "../../app/main/platform/win32/system/ffi";
import { win32SystemDialog, type SecurityVocabulary } from "../../app/main/platform/win32/system/system-dialog";
import { hasBuiltInShell, isSecurityClass, isSecurityWindow, isTerminalApp } from "../../app/main/platform/win32/system/interim";
import { TERMINAL_CLASSES } from "../../app/main/hands/terminals";
import { OFFICE_APP, READ_ONLY_WINDOW, SECURITY_APP, SECURITY_TITLE, TABBED_APP, TYPING_REFUSED } from "../../app/main/policy/vocabulary";
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

/** Polls an asynchronous `fn` until it gives something truthy, or fails after `ms` saying what was awaited. */
async function waitForAsync<T>(fn: () => Promise<T | null | undefined | false>, ms: number, what: string): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

const quiet = { debug() {}, info() {}, warn() {}, error() {}, child() { return quiet; } } as unknown as Logger;

/**
 * Ember's accessibility host, built from source and started as Ember starts it (hostLaunch, the UI Automation bridge
 * with a cache of its own), once its bridge has started: what it names an element is what the policy is given.
 */
async function startHost(): Promise<AtspiSidecar> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ember-vocab-host-"));
  const host = path.join(dir, "ax-sidecar.cjs");
  buildSync({ entryPoints: [path.join(root, "app", "sidecar-host", "main.ts")], bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron", "koffi", "sharp"], outfile: host, logLevel: "silent" });
  const launch = hostLaunch({ execPath: process.execPath, host, uiaScript: path.join(root, "sidecar", "uia", "ember_uia.ps1"), uiaCache: path.join(dir, "uia-cache"), env: process.env, platform: "win32", packaged: false });
  const s = new AtspiSidecar("unused.py", quiet, "unused-python", process.env, { ...launch, firstRequestMs: 90_000 });
  await waitForAsync(async () => {
    const st = await s.status().catch(() => null);
    if (st?.toolkitAccessibility === false) throw new Error(`the bridge didn't start: ${String(st.detail)}`);
    return st?.toolkitAccessibility === true;
  }, 120_000, "the accessibility host and its bridge");
  return s;
}

/** What a read holds, for the log: every named or editable element with its role and whether it has the keyboard. */
const summary = (nodes: AxNode[]) => nodes.filter(n => n.name || n.editable).slice(0, 80)
  .map(n => `${n.role} "${n.name}"${n.editable ? " editable" : ""}${n.states.includes("focused") ? " focused" : ""}`);

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

  it("finds File Explorer's address box and the Run dialog's box, named as Ember's host names them, under the names TYPING_REFUSED refuses programs in", async () => {
    const [addressRule, runRule] = TYPING_REFUSED.win32;
    expect(addressRule.app.test("explorer")).toBe(true);
    expect(runRule.app.test("explorer")).toBe(true);
    const host = await startHost();
    const input = openWin32Input();
    if (!input) throw new Error(`Windows input didn't open: ${String(win32Error)}`);
    const own = { ownPid: process.pid };
    const press = (...names: string[]) => {
      const keys = names.map(n => input.keysymOf(n));
      for (const k of keys) input.keysym(k, true);
      for (const k of [...keys].reverse()) input.keysym(k, false);
    };
    let explorerFrame = 0;
    try {
      // File Explorer on C:\Windows, read as Ember reads a window.
      ps(`(New-Object -ComObject Shell.Application).Open('C:\\Windows')`);
      const win = await waitForAsync(async () => (await host.listWindows(own)).windows.find(w => /^explorer$/i.test(w.app) && /\bWindows\b/.test(w.name) && !!w.path), 20_000, "a File Explorer window on C:\\Windows");
      const read = () => host.readWindow({ pid: win.pid!, path: win.path, ...own });
      // Its address band reads "Address: C:\Windows" once Explorer has built it.
      const band = await waitForAsync(async () => (await read()).nodes.find(n => addressRule.field.test(n.name.trim())), 15_000, "the address band")
        .catch(async (err: Error) => { throw new Error(`${err.message}: ${JSON.stringify(summary((await read()).nodes))}`, { cause: err }); });
      console.log(`File Explorer's address band: ${band.role} "${band.name}"`);
      // The box the user types into: Alt+D puts the keyboard in it.
      const frame = await waitFor(() => ws.clientWindows().find(w => w.pid === win.pid && /\bWindows\b/.test(w.title)), 5_000, "File Explorer's frame");
      explorerFrame = frame.id;
      input.activate(frame.id);
      await waitFor(() => ws.activeWindow()?.id === frame.id, 5_000, "File Explorer in front");
      press("Alt_L", "d");
      const box = await waitForAsync(async () => (await read()).nodes.find(n => n.editable && n.states.includes("focused")), 5_000, "the address box with the keyboard")
        .catch(async (err: Error) => { throw new Error(`${err.message}: ${JSON.stringify(summary((await read()).nodes))}`, { cause: err }); });
      console.log(`File Explorer's address box with the keyboard: ${box.role} "${box.name}"`);
      expect(addressRule.field.test(box.name.trim()), box.name).toBe(true);
      press("Escape");

      // The Run dialog (Shell.Application.FileRun opens it in explorer.exe), read the same way.
      ps(`(New-Object -ComObject Shell.Application).FileRun()`);
      const run = await waitForAsync(async () => (await host.listWindows(own)).windows.find(w => /^explorer$/i.test(w.app) && w.name === "Run" && !!w.path), 15_000, "the Run dialog");
      const readRun = () => host.readWindow({ pid: run.pid!, path: run.path, ...own });
      const nodes = await waitForAsync(async () => { const r = await readRun(); return r.nodes.some(n => n.editable || n.role === "combo box") ? r.nodes : null; }, 10_000, "the Run dialog's box")
        .catch(async (err: Error) => { throw new Error(`${err.message}: ${JSON.stringify(summary((await readRun()).nodes))}`, { cause: err }); });
      console.log(`the Run dialog as Ember's host reads it: ${JSON.stringify(summary(nodes))}`);
      const boxes = nodes.filter(n => n.editable || n.role === "combo box");
      expect(boxes.some(n => runRule.field.test(n.name.trim())), JSON.stringify(summary(boxes))).toBe(true);
      // READ_ONLY_WINDOW tells the Run dialog (Win32's dialog class) from a folder window by role: only a frame is judged as usual.
      console.log(`window roles: File Explorer's folder ${JSON.stringify(win.role)}, the Run dialog ${JSON.stringify(run.role)}`);
      const [runDialog] = READ_ONLY_WINDOW.win32;
      expect(runDialog?.otherRole?.test(win.role), win.role).toBe(true);
      expect(runDialog?.otherRole?.test(run.role), run.role).toBe(false);
      const runFrame = ws.clientWindows().find(w => w.pid === run.pid && w.title === "Run");
      if (runFrame) {
        input.activate(runFrame.id);
        await sleep(300);
        if (ws.activeWindow()?.id === runFrame.id) press("Escape");
      }
    } finally {
      host.stop();
      if (explorerFrame) ps(`(New-Object -ComObject Shell.Application).Windows() | Where-Object { $_.HWND -eq ${explorerFrame} } | ForEach-Object { $_.Quit() }`);
      input.releaseAll();
      input.close();
    }
  }, 180_000);

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
