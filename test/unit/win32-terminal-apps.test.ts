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

  it("isn't when its id names another app", () => {
    expect(isTerminalApp(viaExplorer("Sums", "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"), "win32")).toBe(false);
    expect(isTerminalApp({ id: "Docs", name: "Docs", argv: ["C:\\Windows\\explorer.exe", "C:\\Users\\ada\\Documents"] }, "win32")).toBe(false);
  });

  it("leaves Linux's reading of the same words as it was", () => {
    expect(isTerminalApp(viaExplorer("WT", "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App"), "linux")).toBe(false);
  });
});
