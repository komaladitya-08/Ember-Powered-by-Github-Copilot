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
  binding?: Partial<TargetBinding>; dirs?: string[];
}

function decide(cmd: string, o: O = {}) {
  const where = o.where ?? "linux";
  const ctx = contextOf(where);
  const cls = classifyCommand(cmd, o.shell ?? (where === "win32" ? "powershell" : "bash"), ctx);
  const paths = new Map<string, PathFact>();
  for (const p of cls.probe) paths.set(p, { exists: o.exists && p in o.exists ? o.exists[p] : true, real: p, ...(o.dirs?.includes(p) ? { dir: true } : {}) });
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

  it("3: a copy or a move into a folder that is there asks only about the file of the same name in it (commands-remote-r1)", () => {
    const docs = "/home/ana/Documents";
    for (const cmd of ["mv report.pdf ~/Documents", "cp report.pdf ~/Documents", "install -m 644 report.pdf ~/Documents"]) {
      expect(decide(cmd, { dirs: [docs], exists: { [`${docs}/report.pdf`]: false } }).verdict, cmd).toBe("run");
      const clash = decide(cmd, { dirs: [docs] });
      expect(clash.verdict, cmd).toBe("ask");
      expect(clash.says, cmd).toContain("Replaces ~/Documents/report.pdf if it exists.");
      expect(clash.says, cmd).not.toContain("Replaces ~/Documents if it exists.");
    }
    // A file there is replaced, and a target that can't say whether it is a folder (WSL) asks as before.
    expect(decide("mv report.pdf notes.pdf").says).toContain("Replaces notes.pdf if it exists.");
    expect(decide("mv report.pdf ~/Documents").says).toContain("Replaces ~/Documents if it exists.");
    expect(decide("mv report.pdf ~/Documents", { exists: { [docs]: false } }).verdict).toBe("run");
  });

  it("3: a copy that doesn't land at folder/name asks whenever the folder is there: cp --parents, and a Mac's cp -R of a folder written with a slash (commands-remote-c2-1)", () => {
    const backup = "/home/ana/backup";
    // --parents puts src/a.txt at ~/backup/src/a.txt, never ~/backup/a.txt: whatever is missing, it asks.
    for (const cmd of ["cp --parents src/a.txt ~/backup", "cp --parents src/a.txt ~/backup/", "cp -r --parents src ~/backup", "cp --parents -t ~/backup src/a.txt"]) {
      const d = decide(cmd, { dirs: [backup], exists: { [`${backup}/a.txt`]: false, [`${backup}/src`]: false } });
      expect(d.verdict, cmd).toBe("ask");
      expect(d.says, cmd).toContainEqual(expect.stringMatching(/^Replaces files in ~\/backup\/? if they exist\.$/));
    }
    // A Mac's cp copies what is in build/ straight into the folder (BSD cp), so any file there may be replaced.
    const docs = "/Users/ana/Documents";
    for (const cmd of ["cp -R build/ ~/Documents", "cp -r build/ ~/Documents", "cp -a src/ ~/Documents", "cp -R build/ ~/Documents/"]) {
      const d = decide(cmd, { where: "darwin", shell: "zsh", dirs: [docs], exists: { [`${docs}/build`]: false, [`${docs}/src`]: false } });
      expect(d.verdict, cmd).toBe("ask");
      expect(d.says, cmd).toContainEqual(expect.stringMatching(/^Replaces files in ~\/Documents\/? if they exist\.$/));
    }
    // Without the slash, or with GNU cp (here, or gcp on a Mac), the folder lands as folder/build: only that asks.
    const gone = { [`${docs}/build`]: false };
    expect(decide("cp -R build ~/Documents", { where: "darwin", shell: "zsh", dirs: [docs], exists: gone }).verdict).toBe("run");
    expect(decide("gcp -r build/ ~/Documents", { where: "darwin", shell: "zsh", dirs: [docs], exists: gone }).verdict).toBe("run");
    expect(decide("cp -r build/ ~/Documents", { dirs: ["/home/ana/Documents"], exists: { "/home/ana/Documents/build": false } }).verdict).toBe("run");
    expect(decide("cp -r build/ ~/Documents", { dirs: ["/home/ana/Documents"] }).says).toContain("Replaces ~/Documents/build if it exists.");
    // A new folder: BSD cp makes it from build's contents, replacing nothing.
    expect(decide("cp -R build/ ~/site", { where: "darwin", shell: "zsh", exists: { "/Users/ana/site": false } }).verdict).toBe("run");
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

  it("never says \"You didn't ask for this.\" to someone who asked for that kind of step; it still asks (commands-remote-v2)", () => {
    // The program and subcommand named in full: they asked for it.
    for (const [cmd, words] of [["npm ci", "run npm ci"], ["npm ci", "npm ci"], ["docker push app:1", "docker push it"]]) {
      const d = decide(cmd, { words });
      expect(d.verdict, `${cmd} / ${words}`).toBe("ask");
      expect(d.says, `${cmd} / ${words}`).not.toContain(LINES.unasked);
      expect(d.says, `${cmd} / ${words}`).not.toContain(LINES.inexact);
      expect(d.unasked).toBe(false);
    }
    // Their words ask for that kind of step, not exactly this one: the card says so instead.
    for (const [cmd, words] of [
      ["git push origin main", "push my changes"],
      ["git push origin main", "push my changes to github"],
      ["npm ci", "reinstall the dependencies"],
      ["find . -name '*.pyc' -delete", "delete all the .pyc files in this folder"],
      ["git checkout .", "discard all my uncommitted changes in this repo"],
      ["git restore .", "restore every file"],
      ["cp config.example.json config.json", "copy config.example.json to config.json"],
    ]) {
      const d = decide(cmd, { words });
      expect(d.verdict, `${cmd} / ${words}`).toBe("ask");
      expect(d.says, `${cmd} / ${words}`).not.toContain(LINES.unasked);
      expect(d.says, `${cmd} / ${words}`).toContain(LINES.inexact);
      expect(d.unasked).toBe(false);
    }
    // Words that ask for nothing of the kind still say it, also when they name the file (an injected step's usual shape).
    for (const [cmd, words] of [["git push origin main", "fix the readme"], ["rm notes.txt", "summarise notes.txt"], ["git push --force origin main", "tidy the git config"], ["npm ci", "update the docs"]]) {
      const d = decide(cmd, { words });
      expect(d.says, `${cmd} / ${words}`).not.toContain(LINES.inexact);
    }
    for (const [cmd, words] of [["git push origin main", "fix the readme"], ["rm notes.txt", "summarise notes.txt"], ["git push --force origin main", "tidy the git config"]]) {
      expect(decide(cmd, { words }).says, `${cmd} / ${words}`).toContain(LINES.unasked);
    }
    // Removing scheduled jobs is that kind of step for words that remove them (commands-remote-r1).
    expect(decide("crontab -r", { words: "remove my cron jobs" }).says).toEqual(["Deletes your scheduled jobs.", LINES.inexact]);
    // The line sits where "You didn't ask for this." would, before the Windows line.
    const wsl = decide("rm /mnt/c/Users/ana/x.txt", { where: "wsl", words: "delete the old export" });
    expect(wsl.says.slice(-2)).toEqual([LINES.inexact, LINES.windows]);
  });

  it("still says \"You didn't ask for this.\" when the user's words said not to do it (commands-remote-c1-2)", () => {
    for (const [cmd, words] of [
      ["git push origin main", "don't git push yet"],
      ["git push origin main", "whatever you do, do not push"],
      ["rm build/out.o", "don't delete anything"],
      ["rm -r build", "never delete build/"],
      ["npm publish", "don't publish it"],
      ["docker push app:1", "don't docker push"],
      ["git push --force origin main", "never force push"],
      ["npm ci", "fix the tests without reinstalling the dependencies"],
    ]) {
      const d = decide(cmd, { words });
      expect(d.verdict, `${cmd} / ${words}`).toBe("ask");
      expect(d.says, `${cmd} / ${words}`).toContain(LINES.unasked);
      expect(d.says, `${cmd} / ${words}`).not.toContain(LINES.inexact);
      expect(d.unasked, `${cmd} / ${words}`).toBe(true);
    }
    // A clause that says not to do something else leaves the rest of what they asked for as it was.
    expect(decide("git push origin main", { words: "push my changes, but don't force it" }).says).toContain(LINES.inexact);
    expect(decide("npm ci", { words: "don't touch the docs. run npm ci" }).says).not.toContain(LINES.unasked);
    // However the "not" is said, before the step it rules out or after it (commands-remote-r2-1).
    for (const [cmd, words] of [
      ["git push origin main", "I don't want you to push"],
      ["git push origin main", "push nothing yet"],
      ["git push origin main", "a push isn't needed"],
      ["git push origin main", "make sure that you don't push"],
      ["git push origin main", "commit and don't push"],
      ["git push origin main", "don't push unless I say so"],
      ["git push origin main", "commit without pushing"],
      ["rm -r build", "don't delete build if it has my notes"],
      ["npm publish", "pushing is fine, publishing isn't"],
      ["npm publish", "don't forget not to publish"],
      // What the words leave out by name wasn't asked for, whatever else they ask.
      ["rm -r build", "delete everything except build/"],
      ["rm config.json", "tidy up without touching config.json"],
      ["rm -r src", "delete build/ but not src/"],
      ["git push origin main", "push my branch, not main"],
    ]) {
      const d = decide(cmd, { words });
      expect(d.says, `${cmd} / ${words}`).toContain(LINES.unasked);
      expect(d.unasked, `${cmd} / ${words}`).toBe(true);
    }
  });

  it("still says \"You didn't ask for this.\" when the words rule out that kind of step or its force, in an aside or after a dash (commands-remote-c1-2)", () => {
    for (const [cmd, words] of [
      // What the step does beyond the request, ruled out by name: the force, the publishing.
      ["git push --force origin main", "push without force"],
      ["git push --force origin main", "push my changes without force pushing"],
      ["git push --force origin main", "push my branch (no force push)"],
      ["git push --force origin main", "push my branch — don't force it"],
      ["git push --force-with-lease origin main", "push my branch, never force"],
      ["git push --force origin main", "push the branch normally, not with force"],
      ["npm publish", "prepare the release - don't publish"],
      ["npm publish", "prepare the release (don't publish)"],
      ["git push origin main", "commit the fix (don't push)"],
      // A "not" set apart from its verb by an aside still turns it round.
      ["rm -rf build", "don't (ever) delete build"],
      ["git push origin main", "don't (I repeat) push main"],
      ["git push origin main", "don't — and I mean it — push"],
      // One step of several ruled out: the card says so whatever else the words asked.
      ["rm -r build && rm -r src", "delete build/ but not src/"],
    ]) {
      const d = decide(cmd, { words });
      expect(d.verdict, `${cmd} / ${words}`).toBe("ask");
      expect(d.says, `${cmd} / ${words}`).toContain(LINES.unasked);
      expect(d.says, `${cmd} / ${words}`).not.toContain(LINES.inexact);
      expect(d.unasked, `${cmd} / ${words}`).toBe(true);
    }
    // A "not" about something else leaves the step as asked: another folder, the force of a push that has none.
    expect(decide("rm -r build", { words: "delete build/ but don't delete src/" }).says).not.toContain(LINES.unasked);
    expect(decide("git push origin main", { words: "push my changes, but don't force it" }).says).toContain(LINES.inexact);
    expect(decide("git push origin main", { words: "push main (it's ready)" }).says).not.toContain(LINES.unasked);
  });

  it("says \"You didn't ask for this.\" on the step the words rule out by saying its verb again, and only on it (commands-remote-c1-2)", () => {
    for (const [cmd, words] of [
      ["rm -r src", "delete build/ but don't delete src/"],
      ["rm -r src", "delete build/ and don't delete the src folder"],
      ["kill 1234", "kill 5678 but don't kill 1234"],
      ["git branch -D main", "delete old branches, don't delete main"],
      ["rm -r build && rm -r src", "delete build/ but don't delete src/"],
      ["rm -r src", "delete build/ and not src/"],
      ["rm -r src", "delete build/ and don't touch src/"],
    ]) {
      const d = decide(cmd, { words });
      expect(d.verdict, `${cmd} / ${words}`).toBe("ask");
      expect(d.says, `${cmd} / ${words}`).toContain(LINES.unasked);
      expect(d.says, `${cmd} / ${words}`).not.toContain(LINES.inexact);
    }
    // The step the words asked for keeps no line about the words.
    for (const [cmd, words] of [
      ["rm -r build", "delete build/ but don't delete src/"],
      ["kill 5678", "kill 5678 but don't kill 1234"],
      ["rm -r build", "delete build/ and not src/"],
    ]) {
      const d = decide(cmd, { words });
      expect(d.says, `${cmd} / ${words}`).not.toContain(LINES.unasked);
      expect(d.says, `${cmd} / ${words}`).not.toContain(LINES.inexact);
    }
  });

  it("keeps the asked-for step's card free of \"You didn't ask for this.\" when the words add \"and don't delete anything else\" (commands-remote-r4-6)", () => {
    expect(decide("rm -rf build", { words: "delete build/ and don't delete anything else" }).says).toEqual(["Deletes build and everything in it."]);
    expect(decide("rm -rf build", { words: "delete build/ and nothing else" }).says).toEqual(["Deletes build and everything in it."]);
    expect(decide("kill 5678", { words: "kill 5678 and don't kill anything more" }).says).toEqual(["Stops programs that are running (5678)."]);
    // Anything else is what those words rule out.
    for (const [cmd, words] of [
      ["rm -rf src", "delete build/ and don't delete anything else"],
      ["rm -rf src", "delete build/ and nothing else"],
      ["kill 1234", "kill 5678 and don't kill anything more"],
    ]) {
      const d = decide(cmd, { words });
      expect(d.says, `${cmd} / ${words}`).toContain(LINES.unasked);
      expect(d.says, `${cmd} / ${words}`).not.toContain(LINES.inexact);
    }
  });

  it("says \"You didn't ask for this.\" after \"and nothing else\" on a step that does the named thing and more (commands-remote-v5-4)", () => {
    for (const [cmd, words] of [
      ["kill 1234 5678", "kill 5678 and nothing else"],
      ["rm -rf build dist", "delete build/ and don't delete anything else"],
      ["git branch -D feature-x main", "delete the feature-x branch and don't delete any other branch"],
      ["systemctl stop apache nginx", "stop apache and nothing else"],
      ["git push --force origin main", "push main and nothing else"],
      ["git clean -fdx", "clean untracked files and nothing else"],
    ]) {
      const d = decide(cmd, { words });
      expect(d.verdict, `${cmd} / ${words}`).toBe("ask");
      expect(d.says, `${cmd} / ${words}`).toContain(LINES.unasked);
      expect(d.unasked, `${cmd} / ${words}`).toBe(true);
    }
    // All of it named, the force and the remote it goes to included: no line about the words.
    expect(decide("git push origin main", { words: "push main and nothing else" }).says).not.toContain(LINES.unasked);
    expect(decide("git push --force origin main", { words: "force push main and nothing else" }).says).not.toContain(LINES.unasked);
    expect(decide("kill 1234 5678", { words: "kill 1234 and 5678 and nothing else" }).says).not.toContain(LINES.unasked);
  });

  it("says \"You didn't ask for this.\" after \"and nothing else\" on a step that names nothing of its own when the words ask only to look (commands-remote-w5-4)", () => {
    for (const [cmd, words] of [
      ["crontab -r", "show my crontab and nothing else"],
      ["git stash drop", "run git stash list and nothing else"],
      ["docker system prune -f", "list docker images and nothing else"],
    ]) {
      const d = decide(cmd, { words });
      expect(d.verdict, `${cmd} / ${words}`).toBe("ask");
      expect(d.says, `${cmd} / ${words}`).toContain(LINES.unasked);
      expect(d.unasked, `${cmd} / ${words}`).toBe(true);
    }
    // Words that ask for that kind of step, or name its program and subcommand whole, keep the line off.
    for (const [cmd, words] of [
      ["crontab -r", "remove my crontab and nothing else"],
      ["git stash drop", "drop the stash and nothing else"],
      ["npm ci", "run npm ci and nothing else"],
      ["npm publish", "publish it and nothing else"],
    ]) expect(decide(cmd, { words }).says, `${cmd} / ${words}`).not.toContain(LINES.unasked);
    expect(decide("npm publish", { words: "publish it and nothing else" }).says).toContain(LINES.inexact);
  });

  it("says the words ask for that kind of step when they schedule jobs or prune packages in plain words; it still asks (commands-remote-r3-2)", () => {
    for (const [cmd, words] of [
      ["crontab jobs.txt", "schedule the jobs in jobs.txt"],
      ["crontab jobs.txt", "install my cron jobs from jobs.txt"],
      ["npm prune", "clean up node_modules"],
      ["npm prune", "install the dependencies"],
    ]) {
      const d = decide(cmd, { words });
      expect(d.verdict, `${cmd} / ${words}`).toBe("ask");
      expect(d.says, `${cmd} / ${words}`).toContain(LINES.inexact);
      expect(d.says, `${cmd} / ${words}`).not.toContain(LINES.unasked);
    }
    expect(decide("npm prune", { words: "prune the packages" }).says).toEqual(["Removes packages the project doesn't list."]);
    // yarn autoclean --force deletes files in the packages: never "Installs packages" (commands-remote-r1).
    expect(decide("yarn autoclean --force", { words: "clean up node_modules" }).says).toEqual(["Deletes files in node_modules that .yarnclean lists.", LINES.inexact]);
    expect(decide("crontab jobs.txt", { words: "fix the readme" }).says).toContain(LINES.unasked);
    expect(decide("npm prune", { words: "fix the readme" }).says).toContain(LINES.unasked);
  });

  it("never says \"You didn't ask for this.\" for the step asked for beside a \"not\" about something else: a condition, an exception, a reminder; it still asks (commands-remote-r2-1)", () => {
    for (const [cmd, words] of [
      ["git push origin main", "Don't forget to push my changes"],
      ["git push origin main", "Push my branch without running the linter"],
      ["npm publish", "don't stop until it's published"],
      ["git push origin main", "push my changes if the tests don't fail"],
      ["npm publish", "publish the package unless the build fails"],
      ["rm -rf build/*", "delete everything in build except .gitkeep"],
      ["rm -rf node_modules", "remove node_modules since we no longer need it"],
      ["rm *.o", "delete the object files that aren't needed"],
      ["git push origin main", "push the fix — I can't do it from here"],
      ["git push origin main", "if the tests don't fail, push my changes"],
      ["rm notes.txt", "delete notes.txt once it isn't open"],
      ["rm -r build", "delete the files in build/ that I don't need"],
    ]) {
      const d = decide(cmd, { words });
      // A "not" anywhere in the words never announces: the decision stays a question.
      expect(d.verdict, `${cmd} / ${words}`).toBe("ask");
      expect(d.says, `${cmd} / ${words}`).not.toContain(LINES.unasked);
      expect(d.unasked, `${cmd} / ${words}`).toBe(false);
    }
    expect(decide("git push origin main", { words: "Don't forget to push my changes" }).says).toContain(LINES.inexact);
    // A file's name is one word, not two sentences, so the words still name it.
    expect(decide("cp config.example.json config.json", { words: "copy config.example.json to config.json if config.json isn't there" }).says).not.toContain(LINES.unasked);
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
