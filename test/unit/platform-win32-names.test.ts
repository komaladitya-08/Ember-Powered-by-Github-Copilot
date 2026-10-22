/**
 * App names on Windows (pure): a window's app is its program's file name without ".exe" (what never-look, password
 * prompts and grants match on, and what the sidecar reports), and a UWP app's frame is named after the app it hosts,
 * also when Windows has moved the app's window out of a minimised frame.
 */

import { describe, expect, it } from "vitest";
import { hostedProgram, isUwpFrame, programName, sameProgram } from "../../app/main/platform/win32/names";

describe("program names", () => {
  it("keeps the file name without .exe, as the system spells it", () => {
    expect(programName("C:\\Windows\\System32\\notepad.exe")).toBe("notepad");
    expect(programName("C:\\Program Files\\Microsoft VS Code\\Code.exe")).toBe("Code");
    expect(programName("C:\\WINDOWS\\SYSTEM32\\CMD.EXE")).toBe("CMD");
    expect(programName("\\Device\\HarddiskVolume3\\Apps\\tool.Exe")).toBe("tool");
    expect(programName("C:/msys64/usr/bin/mintty.exe")).toBe("mintty");
    expect(programName("C:\\Tools\\app.exe.bak")).toBe("app.exe.bak");
    expect(programName("powershell.exe")).toBe("powershell");
    expect(programName("")).toBe("");
  });

  it("compares names without case or .exe, and never matches an empty name", () => {
    expect(sameProgram("notepad", "Notepad.exe")).toBe(true);
    expect(sameProgram("ApplicationFrameHost", "applicationframehost")).toBe(true);
    expect(sameProgram("code", "Code - Insiders")).toBe(false);
    expect(sameProgram("", "")).toBe(false);
  });
});

describe("UWP frames", () => {
  it("recognises ApplicationFrameHost's frame by its program and class", () => {
    expect(isUwpFrame("ApplicationFrameHost", "ApplicationFrameWindow")).toBe(true);
    expect(isUwpFrame("notepad", "ApplicationFrameWindow")).toBe(false);
    expect(isUwpFrame("ApplicationFrameHost", "Notepad")).toBe(false);
  });

  it("names the frame after the hosted app's window in another process", () => {
    const frame = { pid: 100, title: "Calculator" };
    expect(hostedProgram(frame, [{ pid: 100, program: "ApplicationFrameHost" }, { pid: 200, program: "CalculatorApp" }], [])).toBe("CalculatorApp");
  });

  it("finds a minimised app's window among the top-level ones by the frame's title", () => {
    const frame = { pid: 100, title: "Settings" };
    const tops = [{ pid: 300, program: "SystemSettings", title: "Settings" }, { pid: 200, program: "CalculatorApp", title: "Calculator" }];
    expect(hostedProgram(frame, [], tops)).toBe("SystemSettings");
  });

  it("gives up rather than guess: no hosted window, no title, or two windows with that title", () => {
    expect(hostedProgram({ pid: 100, title: "Settings" }, [], [])).toBeNull();
    expect(hostedProgram({ pid: 100, title: "" }, [], [{ pid: 300, program: "SystemSettings", title: "" }])).toBeNull();
    const twins = [{ pid: 300, program: "A", title: "Same" }, { pid: 301, program: "B", title: "Same" }];
    expect(hostedProgram({ pid: 100, title: "Same" }, [], twins)).toBeNull();
    // The frame's own process doesn't name it, nor does a process the system wouldn't name.
    expect(hostedProgram({ pid: 100, title: "X" }, [{ pid: 100, program: "ApplicationFrameHost" }, { pid: 5, program: "" }], [])).toBeNull();
  });
});
