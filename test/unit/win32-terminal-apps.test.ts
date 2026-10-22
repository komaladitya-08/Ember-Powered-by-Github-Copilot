/**
 * A Windows Start Menu shortcut that opens a packaged app through File Explorer ("explorer.exe
 * shell:AppsFolder\<AUMID>") is judged by the app's id (hands/system.ts runsTerminal): Windows Terminal is a terminal
 * whatever the shortcut is called, Calculator isn't, and Linux reads such an argv as before.
 */

import { describe, expect, it } from "vitest";
import { isTerminalApp } from "../../app/main/hands/system";

const viaExplorer = (name: string, aumid: string) => ({ id: name, name, argv: ["C:\\Windows\\explorer.exe", `shell:AppsFolder\\${aumid}`] });

describe("a packaged app opened through File Explorer", () => {
  it("is a terminal when its id says so, whatever the shortcut is called", () => {
    expect(isTerminalApp(viaExplorer("WT", "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App"), "win32")).toBe(true);
    expect(isTerminalApp(viaExplorer("Dev box", "Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe!App"), "win32")).toBe(true);
  });

  it("is still a terminal when the id is a desktop app's (a known folder's GUID and the program's path)", () => {
    // {1AC14E77-…} is System32, {6D809377-…} Program Files: Explorer starts the program at that path.
    expect(isTerminalApp(viaExplorer("Prompt", "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\cmd.exe"), "win32")).toBe(true);
    expect(isTerminalApp(viaExplorer("Shell", "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"), "win32")).toBe(true);
    expect(isTerminalApp(viaExplorer("Seven", "{6D809377-6AF0-444B-8957-A3773F02200E}\\PowerShell\\7\\pwsh.exe"), "win32")).toBe(true);
    expect(isTerminalApp(viaExplorer("Linux", "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\wsl.exe"), "win32")).toBe(true);
    expect(isTerminalApp(viaExplorer("Notes", "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\notepad.exe"), "win32")).toBe(false);
  });

  it("isn't when its id names another app", () => {
    expect(isTerminalApp(viaExplorer("Sums", "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"), "win32")).toBe(false);
    expect(isTerminalApp({ id: "Docs", name: "Docs", argv: ["C:\\Windows\\explorer.exe", "C:\\Users\\ada\\Documents"] }, "win32")).toBe(false);
  });

  it("leaves Linux's reading of the same words as it was", () => {
    expect(isTerminalApp(viaExplorer("WT", "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App"), "linux")).toBe(false);
  });
});
