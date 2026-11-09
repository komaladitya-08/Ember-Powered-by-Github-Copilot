/** Relative symbolic links resolve beside their destination, never just beside the command (commands-v7-4). */
import { describe, expect, it } from "vitest";
import { runCase } from "../fixtures/commands/corpus";

const decide = (cmd: string) => runCase({ cmd, verdict: "run", context: "linux", missing: ["/home/ana/bridge"] }, { shell: "bash", context: "linux" }).decision;

describe("relative symbolic links", () => {
  it("refuses a destination-relative link that makes a protected parent reachable (commands-v7-4)", () => {
    for (const command of [
      "ln -s .config /home/ana/bridge; cat /home/ana/bridge/ember/settings.json",
      "ln -s . /home/ana/bridge; cat /home/ana/bridge/.config/ember/settings.json",
      "ln -sT .config /home/ana/bridge; cat /home/ana/bridge/ember/settings.json",
      "ln --symbolic .config /home/ana/bridge; cat /home/ana/bridge/ember/settings.json",
      'd=/home/ana/bridge; ln -s .config "$d"; cat /home/ana/bridge/ember/settings.json',
    ]) expect(decide(command).verdict, command).toBe("refuse");
    expect(decide("ln -s notes.txt notes-link").verdict).toBe("run");
    expect(decide("ln -s build build-link").verdict).toBe("run");
    expect(decide("ln -sr .config /home/ana/bridge").verdict).toBe("run");
    expect(decide("ln -s ../.config/ember /tmp/bridge").verdict).toBe("refuse");
    expect(decide("ln -s /home/ana/.config /home/ana/bridge").verdict).toBe("refuse");
  });

  it("checks a Windows symbolic target beside its destination too (commands-v7-4)", () => {
    for (const [cmd, shell] of [
      ['New-Item -ItemType SymbolicLink -Path "$env:LOCALAPPDATA\\bridge" -Value ember; Get-Content "$env:LOCALAPPDATA\\bridge\\settings.json"', "powershell"],
      ['mklink /D "%LOCALAPPDATA%\\bridge" ember & type "%LOCALAPPDATA%\\bridge\\settings.json"', "cmd"],
    ] as const) {
      expect(runCase({ cmd, shell, context: "win32", verdict: "run" }, { shell, context: "win32" }).decision.verdict, cmd).toBe("refuse");
    }
  });
});
