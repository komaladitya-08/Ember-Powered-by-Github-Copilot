/**
 * The command decision (design §3.8.2, §3.8.4): rules 1-11 in order, the card's lines in their fixed order, the arm
 * times, the Windows line on WSL, the tool-owned distro's line, and an audit `reason` that never holds a path.
 */

import { describe, expect, it } from "vitest";
import type { CommandMode, DecideInput, GitFacts, PathFact, ShellId } from "../../app/main/commands/types";
import type { TargetBinding } from "../../app/main/targets/types";
import { classifyCommand } from "../../app/main/commands/classify";
import { ARM_ASK_MS, ARM_POLICY_MS, CLASS_ORDER, decideCommand, LINES } from "../../app/main/commands/decide";
import { bindingOf, contextOf, factsOf, type ContextName } from "../fixtures/commands/corpus";

interface O {
  where?: ContextName; shell?: ShellId; words?: string; mode?: CommandMode; askEvery?: boolean; tainted?: boolean;
  carried?: { from: string[] } | null; privileged?: boolean; exists?: Record<string, boolean | null>; git?: GitFacts | null;
  binding?: Partial<TargetBinding>;
}

function decide(cmd: string, o: O = {}) {
  const where = o.where ?? "linux";
  const ctx = contextOf(where);
  const cls = classifyCommand(cmd, o.shell ?? (where === "win32" ? "powershell" : "bash"), ctx);
  const paths = new Map<string, PathFact>();
  for (const p of cls.probe) paths.set(p, { exists: o.exists && p in o.exists ? o.exists[p] : true, real: p });
  const input: DecideInput = {
    cls, paths, git: o.git ?? null, binding: { ...bindingOf(where), ...o.binding }, facts: factsOf(where, { privileged: o.privileged }),
    mode: o.mode ?? "on", userAskEvery: o.askEvery ?? false, userWords: o.words ?? "", agreed: [], tainted: o.tainted ?? false, carried: o.carried ?? null,
  };
  return decideCommand(input);
}

describe("decideCommand: the rules in order", () => {
  it("1: Ember's own refusal comes first, whatever else applies", () => {
    const d = decide("kill 4242", { mode: "off", privileged: true, words: "kill 4242" });
    expect(d.verdict).toBe("refuse");
    expect(d.rules).toEqual(["ember.process"]);
    expect(d.reason).toBe("Ember won't run this: it would change Ember's own safety settings, records or programs.");
    expect(d.armMs).toBe(0);
    expect(decide("xdotool key y").reason).toBe("Ember won't run this: it could press keys or click in Ember's own windows.");
  });

  it("2: the administrator's off refuses, in words for the kind of target", () => {
    expect(decide("ls", { mode: "off" })).toMatchObject({ verdict: "refuse", rules: ["admin.off"], says: ["Your organisation has turned off commands on this computer."] });
    expect(decide("ls", { mode: "off", where: "wsl" }).says).toEqual(["Your organisation has turned off commands in WSL."]);
    expect(decide("ls", { mode: "off", binding: { kind: "ssh", id: "ssh:build-01", label: "build-01" } }).says).toEqual(["Your organisation has turned off commands on computers reached over SSH."]);
  });

  it("3: an overwrite of a path the target says doesn't exist is dropped (unknown counts as existing)", () => {
    expect(decide("echo hi > new.txt", { exists: { "/home/ana/proj/new.txt": false } }).verdict).toBe("run");
    expect(decide("echo hi > new.txt", { exists: { "/home/ana/proj/new.txt": null } }).verdict).toBe("ask");
    expect(decide("echo hi > new.txt").verdict).toBe("ask");
    // Only the overwrite is dropped: what else the command does still counts.
    expect(decide("echo hi > new.txt; rm old.txt", { exists: { "/home/ana/proj/new.txt": false } }).rules).toEqual(["posix.rm"]);
  });

  it("4: root or an elevated token asks for everything, its line first, as a system change", () => {
    const d = decide("ls", { privileged: true });
    expect(d).toMatchObject({ verdict: "ask", classes: ["system"], armMs: ARM_ASK_MS });
    expect(d.says[0]).toBe(LINES.rootPosix);
    expect(d.rules).toContain("privileged");
    expect(decide("Get-ChildItem", { privileged: true, where: "win32" }).says[0]).toBe(LINES.rootWindows);
    expect(decide("rm notes.txt", { privileged: true, words: "delete notes.txt" }).verdict).toBe("ask");
  });

  it("5: the administrator's ask asks, briefly armed for an ordinary command", () => {
    expect(decide("ls", { mode: "ask" })).toMatchObject({ verdict: "ask", says: [LINES.adminAsk], armMs: ARM_POLICY_MS, classes: [] });
    const d = decide("rm notes.txt", { mode: "ask", words: "delete notes.txt" });
    expect(d).toMatchObject({ verdict: "ask", armMs: ARM_ASK_MS });
    expect(d.says[0]).toBe(LINES.adminAsk);
  });

  it("6: the user's own ask-every asks; a tool-owned distro says why", () => {
    expect(decide("ls", { askEvery: true })).toMatchObject({ verdict: "ask", says: [LINES.userAsk], armMs: ARM_POLICY_MS });
    const podman = decide("ls", { askEvery: true, where: "wsl", binding: { id: "wsl:podman-machine-default", label: "podman-machine-default" } });
    expect(podman.says).toEqual([LINES.toolDistro]);
    expect(decide("rm notes.txt", { askEvery: true, words: "delete notes.txt" }).verdict).toBe("ask");
  });

  it("7: a tainted task asks for everything", () => {
    expect(decide("ls", { tainted: true })).toMatchObject({ verdict: "ask", says: [LINES.tainted], armMs: ARM_ASK_MS });
    expect(decide("rm notes.txt", { tainted: true, words: "delete notes.txt" }).verdict).toBe("ask");
  });

  it("8: carried text asks, even for an ordinary command", () => {
    const d = decide("ls", { carried: { from: ["Slack", "Mail"] } });
    expect(d).toMatchObject({ verdict: "ask", armMs: ARM_ASK_MS });
    expect(d.says).toEqual(["This command may carry text Ember read in Slack and Mail."]);
    expect(d.rules).toEqual(["carried"]);
  });

  it("9: an ordinary command runs", () => {
    expect(decide("ls -la")).toEqual({ verdict: "run", reason: "An ordinary command.", classes: [], rules: [], says: [], unasked: false, armMs: 0 });
  });

  it("10: the user's own words announce exactly what they named", () => {
    const d = decide("rm notes.txt", { words: "delete notes.txt" });
    expect(d).toMatchObject({ verdict: "announce", classes: ["destroy"], rules: ["posix.rm"], requested: { intent: "delete.paths", announce: "Deleting notes.txt, as you asked." }, armMs: 0 });
    expect(d.reason).toBe("The user's own words asked for this (delete.paths).");
    expect(decide("git push", { words: "push feature-x", git: { branch: "feature-x", pushDefault: "simple", upstream: "origin/feature-x" } }).verdict).toBe("announce");
    expect(decide("git push", { words: "push feature-x" }).verdict).toBe("ask");
  });

  it("11: everything else asks, saying when nothing in the user's words named it", () => {
    const none = decide("rm notes.txt");
    expect(none).toMatchObject({ verdict: "ask", unasked: true, armMs: ARM_ASK_MS, classes: ["destroy"] });
    expect(none.says[none.says.length - 1]).toBe(LINES.unasked);
    expect(decide("rm notes.txt", { words: "tidy up the docs" }).unasked).toBe(true);
    const named = decide("rm -r notes", { words: "delete notes" });
    expect(named).toMatchObject({ verdict: "ask", unasked: false });
    expect(named.says).not.toContain(LINES.unasked);
  });
});

describe("decideCommand: the card", () => {
  it("lists the classes most serious first, and their lines in the same order", () => {
    const d = decide("eval x; cat ~/.ssh/id_rsa; git push origin main; rm notes.txt");
    expect(d.classes).toEqual(CLASS_ORDER.filter(c => d.classes.includes(c)));
    expect(d.classes).toEqual(["destroy", "publish", "secret", "unclear"]);
    const at = (s: string): number => d.says.findIndex(x => x.startsWith(s));
    expect(at("Deletes")).toBeLessThan(at("Pushes"));
    expect(at("Pushes")).toBeLessThan(at("Reads or changes passwords"));
    expect(at("Reads or changes passwords")).toBeLessThan(d.says.indexOf(LINES.unclear));
    expect(d.says[d.says.length - 1]).toBe(LINES.unasked);
  });

  it("puts policy lines first and the carried, tainted, unasked and Windows lines last, in that order", () => {
    const d = decide("rm /mnt/c/Users/ana/x.txt", { where: "wsl", mode: "ask", askEvery: true, tainted: true, carried: { from: ["Slack"] } });
    expect(d.says).toEqual([
      LINES.adminAsk, LINES.userAsk, "Deletes /mnt/c/Users/ana/x.txt.", "This command may carry text Ember read in Slack.", LINES.tainted, LINES.unasked, LINES.windows,
    ]);
  });

  it("adds the Windows line on WSL only, when a command reaches the Windows side", () => {
    expect(decide("ls /mnt/c", { where: "wsl" })).toMatchObject({ verdict: "run", says: [LINES.windows] });
    expect(decide("cmd.exe /c dir", { where: "wsl-mnt" }).says).toContain(LINES.windows);
    expect(decide("git.exe status", { where: "wsl" }).says).toContain(LINES.windows);
    expect(decide("ls ~/proj", { where: "wsl" }).says).toEqual([]);
    expect(decide("ls /mnt/c").says).toEqual([]);
  });

  it("keeps paths and the command out of the audit reason", () => {
    for (const cmd of ["rm -rf /home/ana/proj/secret-plans", "cat /home/ana/.aws/credentials", "git push origin feature-x", "cp a.txt /etc/hosts"]) {
      const d = decide(cmd);
      expect(d.reason).not.toMatch(/\/home|\/etc|feature-x|a\.txt/);
      expect(d.reason.startsWith("It asks first: ")).toBe(true);
    }
    expect(decide("rm notes.txt", { privileged: true, mode: "ask", askEvery: true, tainted: true, carried: { from: ["Mail"] } }).reason)
      .toBe("It asks first: commands here run as an administrator; the organisation asks for every command; the user asked to check every command; it deletes or overwrites data; it may carry text Ember read elsewhere in the task; an earlier step in the task wasn't the user's.");
  });
});
