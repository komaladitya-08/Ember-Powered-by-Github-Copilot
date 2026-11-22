/**
 * Round seven's command findings (the audit-seven branch of 9-10 November), ported onto the commands code as it now
 * stands: Ember's own refusals and the dangers it recognises, never a question for what it merely doesn't know
 * (docs/APPROVALS.md).
 */
import { describe, expect, it } from "vitest";
import { runCase } from "../fixtures/commands/corpus";

const decide = (command: string) => runCase({ cmd: command, verdict: "run", context: "linux" }, { shell: "bash", context: "linux" }).decision;
const win = (command: string, shell: "cmd" | "powershell") => runCase({ cmd: command, shell, context: "win32", verdict: "run" }, { shell, context: "win32" }).decision.verdict;

describe("protected paths handed to opaque shell contexts", () => {
  it("refuses Ember's files named through a sh -c text's $0 and $1 (commands-remote-v4-4, v5-2)", () => {
    for (const command of [
      'sh -c \'cat "$0/settings.json"\' ~/.config/ember',
      'sh -c \'cat "$1/settings.json"\' unused ~/.config/ember',
      'd=~/.config/ember; sh -c \'cat "$1/settings.json"\' unused "$d"',
      'sh -c \'cat "$0/ember/settings.json"\' ~/.config',
    ]) expect(decide(command).verdict, command).toBe("refuse");
    expect(decide("sh -c 'echo hello' world").verdict).toBe("run");
    // Listing the home folder is no refusal: only what names Ember's files is.
    expect(decide("sh -c 'ls \"$0\"' ~").verdict).not.toBe("refuse");
    expect(decide("echo $0").verdict).toBe("run");
  });

  it("refuses visible Ember paths when a PowerShell loop or a cmd variable hides their later use (commands-remote-c3-2, i6a)", () => {
    for (const command of [
      '$d = "$env:LOCALAPPDATA\\ember"; foreach ($f in @($d)) { Remove-Item -Recurse $f }',
      'foreach ($d in @("$env:LOCALAPPDATA\\ember")) { Get-Content "$d\\settings.json" }',
      "foreach ($f in @($env:LOCALAPPDATA)) { Remove-Item -Recurse $f }",
    ]) expect(win(command, "powershell"), command).toBe("refuse");
    expect(win('set "D=%LOCALAPPDATA%\\ember" & type "%D%\\settings.json"', "cmd")).toBe("refuse");
    // The folder above Ember's, only listed, and an ordinary variable are not refused.
    expect(win("foreach ($f in Get-ChildItem $env:LOCALAPPDATA) { Write-Output $f.Name }", "powershell")).not.toBe("refuse");
    expect(win('set "D=project" & echo %D%', "cmd")).toBe("run");
    expect(win("set X=1 & dir %USERPROFILE%", "cmd")).toBe("run");
  });
});
