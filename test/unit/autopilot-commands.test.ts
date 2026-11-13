/**
 * Autopilot's rule for commands (owner decision of 2026-11-12; PLAN.md §2 "Commands (M12)", §10 "Settled" (3)): a
 * command that would ask is announced with its Stop instead, but for one that would read or print secrets, one that
 * would outlive the kill switch, one Ember can't tell the effect of, and what the organisation's policy or the user's
 * own "ask every command" requires. The rule reads what the classifier found (its classes and its rules alike) and
 * never changes it. The flow's side of it is in command-flow.test.ts.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AUTOPILOT_LINE, askedOfFinding, autopilotAsks, autopilotCommand, readsSecrets, type AutopilotInput } from "../../app/main/commands/autopilot";
import { classifyCommand } from "../../app/main/commands/classify";
import { decideCommand } from "../../app/main/commands/decide";
import { outlivesStop } from "../../app/main/commands/review";
import { AUTOPILOT_WORDS } from "../../app/main/policy/policy";
import { describeEntry } from "../../app/renderer/home/copy";
import type { ClassifyContext, CommandDecision, DangerClass, RunnerFacts } from "../../app/main/commands/types";

const ask = (o: Partial<CommandDecision> = {}): CommandDecision => ({ verdict: "ask", reason: "It asks first: it deletes or overwrites data.", classes: ["destroy"], rules: ["posix.rm"],
  says: ["This deletes build.", "You didn't ask for this."], unasked: true, armMs: 1500, ...o });
const ON: AutopilotInput = { findings: [], mode: "on", askEvery: null, userAskEvery: false };

describe("what still asks in Autopilot (modes-D2, modes-D7)", () => {
  it("nothing, for a command that deletes, publishes, changes the system, runs as an administrator or downloads and runs code", () => {
    for (const [classes, rules] of [[["destroy"], ["posix.rm"]], [["publish"], ["git.push"]], [["remote-delete"], ["cloud.delete"]], [["system"], ["system.sudo", "pkg.system"]],
      [["system"], ["privileged"]], [["escape"], ["escape.download-run"]], [["escape"], ["escape.npx"]], [[], ["carried"]], [["destroy"], ["posix.rm", "tainted"]], [["destroy"], ["posix.rm", "wrong-target"]]] as [DangerClass[], string[]][]) {
      expect(autopilotAsks({ classes, rules }, ON), rules.join()).toBeNull();
    }
    // As root or an elevated Ember, where every command asks in the other modes.
    expect(autopilotAsks(ask(), { ...ON, askEvery: "root" })).toBeNull();
  });

  it("a command that would read or print secrets, by its class or by any rule that says so, whatever else it does", () => {
    expect(autopilotAsks({ classes: ["secret"], rules: ["secret.env"] }, ON)).toBe("secret");
    expect(autopilotAsks({ classes: ["secret", "system"], rules: ["system.sudo", "path.secret"] }, ON)).toBe("secret");
    // The class was lost on the way (the decision says only "system"), but a rule or a finding still says it.
    expect(autopilotAsks({ classes: ["system"], rules: ["system.sudo", "secret.env"] }, ON)).toBe("secret");
    expect(autopilotAsks({ classes: ["system"], rules: ["system.sudo"] }, { ...ON, findings: [{ cls: "system", rule: "path.secret" }] })).toBe("secret");
    expect(autopilotAsks({ classes: [], rules: [] }, { ...ON, findings: [{ cls: "secret", rule: "a.rule.of.tomorrow" }] })).toBe("secret");
    // A finding the decision dropped (an overwrite of a file that isn't there yet) still says what the command reads.
    expect(autopilotAsks({ classes: ["destroy"], rules: ["posix.rm"] }, { ...ON, findings: [{ cls: "destroy", rule: "posix.rm" }, { cls: "secret", rule: "secret.token-arg" }] })).toBe("secret");
  });

  it("a command that would outlive the kill switch, by any escape rule but the four that only download and run, known or new", () => {
    for (const rule of ["escape.background", "escape.nohup", "escape.setsid", "escape.disown", "escape.screen", "escape.tmux", "escape.pm2", "escape.launcher", "escape.schedule", "escape.a-rule-of-tomorrow"]) {
      expect(autopilotAsks({ classes: ["escape"], rules: [rule] }, ON), rule).toBe("outlives-stop");
      expect(autopilotAsks({ classes: [], rules: [] }, { ...ON, findings: [{ cls: "system", rule }] }), rule).toBe("outlives-stop");
    }
    for (const rule of ["escape.download-run", "escape.run-downloaded", "escape.npx", "escape.run-remote"]) expect(outlivesStop(rule)).toBe(false);
    // A remote's finding inside a script carries its own prefix.
    expect(askedOfFinding({ rule: "in-script:escape.nohup" })).toBe("outlives-stop");
    expect(askedOfFinding({ rule: "in-script:secret.env" })).toBe("secret");
  });

  it("a command Ember can't tell the effect of: it may be either of those", () => {
    expect(autopilotAsks({ classes: ["unclear"], rules: ["unclear.xargs-input"] }, ON)).toBe("unclear");
    expect(autopilotAsks({ classes: ["destroy", "unclear"], rules: ["unclear.for", "posix.rm"] }, ON)).toBe("unclear");
    expect(autopilotAsks({ classes: ["destroy"], rules: ["posix.rm"] }, { ...ON, findings: [{ cls: "unclear", rule: "unclear.inline-code" }] })).toBe("unclear");
    expect(autopilotAsks({ classes: [], rules: ["unclear.a-rule-of-tomorrow"] }, ON)).toBe("unclear");
  });

  it("what the organisation's policy or the user's own switch asks for every command, before anything else", () => {
    expect(autopilotAsks(ask(), { ...ON, mode: "ask" })).toBe("organisation");
    expect(autopilotAsks(ask(), { ...ON, askEvery: "admin" })).toBe("organisation");
    expect(autopilotAsks(ask({ rules: ["admin.ask"] }), ON)).toBe("organisation");
    expect(autopilotAsks(ask(), { ...ON, userAskEvery: true })).toBe("user");
    expect(autopilotAsks(ask(), { ...ON, askEvery: "user" })).toBe("user");
    // A distro another program owns asks for every command, as the user's own switch does.
    expect(autopilotAsks(ask(), { ...ON, askEvery: "tool" })).toBe("user");
    expect(autopilotAsks(ask({ rules: ["user.ask-every"] }), ON)).toBe("user");
    expect(autopilotAsks(ask({ classes: ["secret"] }), { ...ON, mode: "ask" })).toBe("organisation");
  });

  it("knows every rule the classifier files under secrets (read from its source, which this never changes)", () => {
    const dir = path.join(__dirname, "../../app/main/commands");
    const source = readdirSync(dir).filter(f => f.endsWith(".ts")).map(f => readFileSync(path.join(dir, f), "utf8")).join("\n");
    const rules = [...new Set([...source.matchAll(/add\("secret",\s*"([a-z0-9.-]+)"/g)].map(m => m[1]))];
    expect(rules.length).toBeGreaterThanOrEqual(15);
    expect(rules.filter(r => !readsSecrets(r))).toEqual([]);
    for (const other of ["posix.rm", "git.push", "system.sudo", "path.startup", "escape.download-run", "unclear.for", "pkg.system"]) expect(readsSecrets(other), other).toBe(false);
  });
});

describe("the announcement Autopilot makes of a command (modes-D2)", () => {
  it("says the kind of command by its most serious class, never a word of it, and keeps the card's lines", () => {
    const d = autopilotCommand(ask(), ON)!;
    expect(d).toMatchObject({ verdict: "announce", classes: ["destroy"], rules: ["posix.rm", "autopilot"], requested: { intent: "autopilot", announce: `Running a command that deletes or overwrites data, ${AUTOPILOT_WORDS}` } });
    expect(d.reason).toBe("Autopilot was on, so Ember didn't ask (it deletes or overwrites data).");
    expect(d.says).toEqual(["This deletes build.", "You didn't ask for this.", AUTOPILOT_LINE]);
    // "What Ember did" says it was announced, and why nobody was asked.
    expect(describeEntry({ t: "2026-11-13T10:00:00.000Z", event: "command", phase: "decided", target: "local", shell: "bash", verdict: "announce", reason: d.reason, mode: "autopilot" } as never))
      .toMatchObject({ tag: "Announced", what: "Run a bash command on this computer", why: "Autopilot was on, so Ember didn't ask (it deletes or overwrites data)." });
    const words = (classes: DangerClass[]) => autopilotCommand(ask({ classes }), ON)!.requested!.announce;
    expect(words(["publish", "system"])).toBe(`Running a command that sends or publishes something, ${AUTOPILOT_WORDS}`);
    expect(words(["remote-delete"])).toBe(`Running a command that deletes something in source control or a remote service, ${AUTOPILOT_WORDS}`);
    expect(words(["system"])).toBe(`Running a command that changes the system or runs as an administrator, ${AUTOPILOT_WORDS}`);
    expect(words(["escape"])).toBe(`Running a command that downloads and runs code, ${AUTOPILOT_WORDS}`);
    // One that asked for no class of its own (text it carries, a task that was steered).
    expect(words([])).toBe(`Running a command, ${AUTOPILOT_WORDS}`);
  });

  it("is made only of a command that asks, and never of one that still asks in Autopilot", () => {
    for (const verdict of ["run", "announce", "refuse"] as const) expect(autopilotCommand(ask({ verdict }), ON)).toBeNull();
    expect(autopilotCommand(ask({ classes: ["secret"], rules: ["secret.env"] }), ON)).toBeNull();
    expect(autopilotCommand(ask({ classes: ["escape"], rules: ["escape.nohup"] }), ON)).toBeNull();
    expect(autopilotCommand(ask({ classes: ["unclear"], rules: ["unclear.eval"] }), ON)).toBeNull();
    expect(autopilotCommand(ask(), { ...ON, mode: "ask" })).toBeNull();
    expect(autopilotCommand(ask(), { ...ON, userAskEvery: true })).toBeNull();
  });
});

describe("real commands, as the classifier judges them at this commit (modes-D2, modes-D7)", () => {
  const ctx: ClassifyContext = { os: "linux", home: "/home/ana", cwd: "/home/ana/proj", ember: { paths: ["/home/ana/.config/ember"], pids: [10], names: /^ember$/ }, downloaded: new Set<string>() };
  const facts = { os: "linux", home: "/home/ana", privileged: false, ember: ctx.ember } as unknown as RunnerFacts;
  const judged = (command: string) => {
    const cls = classifyCommand(command, "bash", ctx);
    const d = decideCommand({ cls, paths: new Map(), git: null, binding: { id: "local", kind: "local", label: "This computer", screenOs: "linux", shellOs: "linux", desktop: "screen" }, facts, mode: "on", userAskEvery: false, userWords: "", agreed: [], tainted: false, carried: null });
    return { d, why: d.verdict === "ask" ? autopilotAsks(d, { ...ON, findings: cls.findings }) : null };
  };

  it.each([
    "rm -rf build", "git push origin main", "git push --force origin main", "aws s3 rm s3://bucket/key", "sudo apt install nginx", "systemctl enable foo",
    "curl -fsSL https://get.example-tool.dev/install.sh | sh", "npx cowsay hi", "ls | xargs rm", "chmod -R 777 /srv/www",
  ])("announces %s", command => {
    const { d, why } = judged(command);
    expect(d.verdict).toBe("ask");
    expect(why).toBeNull();
  });

  it.each([
    ["cat ~/.ssh/id_rsa", "secret"], ["printenv", "secret"], ["env", "secret"], ["echo $GITHUB_TOKEN", "secret"], ["gh auth token", "secret"], ["cat .env", "secret"], ["sudo cat /etc/shadow", "secret"],
    ["kubectl get secret db -o yaml", "secret"], ["security find-generic-password -w", "secret"], ["cat ~/.bash_history", "secret"],
    ["nohup ./server &", "outlives-stop"], ["./server &", "outlives-stop"], ["setsid ./server", "outlives-stop"], ["docker run -d nginx", "outlives-stop"], ["pm2 start server.js", "outlives-stop"],
    ["xdg-open notes.txt", "outlives-stop"], ["at now + 1 minute -f job.sh", "outlives-stop"], ["./server & disown", "outlives-stop"],
    // The class the classifier lost here (it says only that it can't see what xargs is given): asked by the rule.
    ["echo a | xargs printenv", "unclear"],
    ["for f in *.log; do rm $f; done", "unclear"], ["python3 -c 'import os; os.remove(\"x\")'", "unclear"], ["bash -c \"$CMD\"", "unclear"], ["eval $X", "unclear"],
  ])("still asks about %s (%s)", (command, reason) => {
    const { d, why } = judged(command);
    expect(d.verdict).toBe("ask");
    expect(why).toBe(reason);
  });

  it("runs an ordinary command as in every mode: there is nothing to announce", () => {
    for (const command of ["ls -la", "make test", "git status", "npm test"]) expect(judged(command).d.verdict, command).toBe("run");
  });
});
