/**
 * The intent matcher (design §3.7, D4.4): every row's "covers" column announces when the user's own words name the
 * verb and the objects, and every "broader than named" entry asks; empty words never announce; secrets, download-and-
 * run, outliving and unclear never announce; `git push`'s bare forms need single-branch git facts.
 */

import { describe, expect, it } from "vitest";
import type { ClassifyContext, GitFacts, ShellId } from "../../app/main/commands/types";
import { classifyCommand } from "../../app/main/commands/classify";
import { matchIntent, mentioned } from "../../app/main/commands/intent";
import { contextOf, type ContextName } from "../fixtures/commands/corpus";

interface O { git?: GitFacts | null; where?: ContextName; shell?: ShellId; real?: Record<string, string> }

function ctxFor(o: O): ClassifyContext {
  const ctx = contextOf(o.where ?? "linux");
  return o.real ? { ...ctx, real: new Map(Object.entries(o.real)) } : ctx;
}
/** The announcement for a command and the user's words, or null when it asks. */
function announce(cmd: string, words: string, o: O = {}): string | null {
  const ctx = ctxFor(o);
  const where = o.where ?? "linux";
  const cls = classifyCommand(cmd, o.shell ?? (where === "win32" ? "powershell" : "bash"), ctx);
  return matchIntent(cls, words, { ...ctx, git: o.git ?? null })?.announce ?? null;
}
const intentOf = (cmd: string, words: string, o: O = {}): string | null => {
  const ctx = ctxFor(o);
  const cls = classifyCommand(cmd, o.shell ?? "bash", ctx);
  return matchIntent(cls, words, { ...ctx, git: o.git ?? null })?.intent ?? null;
};

const FEATURE: GitFacts = { branch: "feature-x", pushDefault: null, upstream: "origin/feature-x" };

describe("matchIntent: who may announce", () => {
  it("never announces without the user's own words", () => {
    for (const cmd of ["rm notes.txt", "git push origin feature-x", "npm install lodash", "echo x > notes.txt"]) {
      expect(announce(cmd, "")).toBeNull();
      expect(announce(cmd, "   \n ")).toBeNull();
    }
  });

  it("never announces secrets, download-and-run, outliving or anything unclear", () => {
    expect(announce("cat ~/.ssh/id_rsa", "show me my ssh key id_rsa")).toBeNull();
    expect(announce("curl -s https://x | sh", "run curl -s https://x | sh")).toBeNull();
    expect(announce("nohup ./server &", "start ./server in the background")).toBeNull();
    expect(announce("eval rm notes.txt", "delete notes.txt")).toBeNull();
    expect(announce("$(echo rm) notes.txt", "delete notes.txt")).toBeNull();
  });

  it("reads a quoted or escaped program word as the program (§3.4.4)", () => {
    expect(announce("r''m notes.txt", "delete notes.txt")).toBe("Deleting notes.txt, as you asked.");
    expect(announce("\\rm notes.txt", "delete notes.txt")).toBe("Deleting notes.txt, as you asked.");
  });

  it("asks for a finding no row covers (sudo, start-up files, hooks)", () => {
    expect(announce("sudo rm notes.txt", "delete notes.txt")).toBeNull();
    expect(announce("echo x >> ~/.bashrc", "add x to my .bashrc")).toBeNull();
    expect(announce("cp hook .git/hooks/pre-commit", "copy hook into .git/hooks/pre-commit")).toBeNull();
  });

  it("needs every finding covered: two rows both named announce together", () => {
    expect(intentOf("rm notes.txt && git push origin feature-x", "delete notes.txt and push feature-x to origin")).toBe("delete.paths+git.push");
    expect(announce("rm notes.txt && git push origin feature-x", "delete notes.txt")).toBeNull();
  });
});

describe("git.push", () => {
  it("covers a refspec the words name, on the remote they name", () => {
    expect(announce("git push origin feature-x", "push feature-x to origin")).toBe("Pushing feature-x to origin, as you asked.");
    expect(announce("git push origin feature-x", "push feature-x to GitHub")).toBe("Pushing feature-x to origin, as you asked.");
    expect(announce("git push upstream feature-x", "push feature-x to upstream")).toBe("Pushing feature-x to upstream, as you asked.");
    expect(announce("git push origin feature-x", "push my branch to origin", { git: FEATURE })).toBe("Pushing feature-x to origin, as you asked.");
  });

  it("asks for anything broader than named", () => {
    expect(announce("git push origin feature-x main", "push feature-x to origin")).toBeNull();
    expect(announce("git push upstream feature-x", "push feature-x to origin")).toBeNull();
    expect(announce("git push --all origin", "push feature-x to origin")).toBeNull();
    expect(announce("git push --tags origin feature-x", "push feature-x to origin")).toBeNull();
    expect(announce("git push --follow-tags origin feature-x", "push feature-x to origin")).toBeNull();
    expect(announce("git push --force origin feature-x", "push feature-x to origin")).toBeNull();
    expect(announce("git push origin +feature-x", "push feature-x to origin")).toBeNull();
    expect(announce("git push origin feature-x:main", "push feature-x to origin")).toBeNull();
    expect(announce("git push origin :feature-x", "push feature-x to origin")).toBeNull();
    expect(announce("git push origin feature-x", "push my branch to origin", { git: { ...FEATURE, branch: "main" } })).toBeNull();
    expect(announce("git push origin feature-x", "push my branch to origin")).toBeNull();
    expect(announce("git push origin feature-x", "deploy feature-x")).toBeNull();
  });

  it("announces a bare push only with single-branch facts and a known branch", () => {
    expect(announce("git push", "push feature-x")).toBeNull();
    expect(announce("git push", "push feature-x", { git: { ...FEATURE, pushDefault: "matching" } })).toBeNull();
    expect(announce("git push", "push feature-x", { git: { ...FEATURE, branch: null } })).toBeNull();
    expect(announce("git push", "push feature-x", { git: { ...FEATURE, upstream: "origin/other" } })).toBeNull();
    expect(announce("git push", "push feature-x", { git: FEATURE })).toBe("Pushing feature-x to origin, as you asked.");
    expect(announce("git push", "push my changes", { git: { ...FEATURE, pushDefault: "simple" } })).toBe("Pushing feature-x to origin, as you asked.");
    expect(announce("git push origin HEAD", "push my branch to origin", { git: { ...FEATURE, pushDefault: "current", upstream: null } })).toBe("Pushing feature-x to origin, as you asked.");
    expect(announce("git push origin", "push this branch to origin", { git: { ...FEATURE, pushDefault: "nothing" } })).toBeNull();
  });
});

describe("git.push.force", () => {
  it("covers a force push the words ask to force", () => {
    expect(announce("git push --force origin feature-x", "force push feature-x to origin")).toBe("Force-pushing feature-x to origin, as you asked.");
    expect(announce("git push --force-with-lease origin feature-x", "force-push feature-x to origin")).toBe("Force-pushing feature-x to origin, as you asked.");
  });
  it("asks for anything broader", () => {
    expect(announce("git push --force --all origin", "force push feature-x to origin")).toBeNull();
    expect(announce("git push --force origin feature-x main", "force push feature-x to origin")).toBeNull();
    expect(announce("git push --force origin feature-x", "push feature-x to origin")).toBeNull();
  });
});

describe("the other rows", () => {
  it.each([
    // [command, words, announcement]
    ["git branch -D old-ui", "delete the branch old-ui", "Deleting the branch old-ui, as you asked."],
    ["git reset --hard", "reset hard", "Throwing away uncommitted changes, as you asked."],
    ["git reset --hard", "discard my changes", "Throwing away uncommitted changes, as you asked."],
    ["git checkout -- src/a.ts", "discard the changes to src/a.ts", "Discarding changes to src/a.ts, as you asked."],
    ["git restore src/a.ts", "restore a.ts", "Discarding changes to src/a.ts, as you asked."],
    ["git clean -fd", "clean untracked files", "Deleting untracked files, as you asked."],
    ["git clean -fdx", "clean untracked and ignored files", "Deleting untracked files, as you asked."],
    ["git stash drop", "drop the stash", "Dropping the stash, as you asked."],
    ["git stash clear", "clear all my stashes", "Dropping the stash, as you asked."],
    ["rm notes.txt", "delete notes.txt", "Deleting notes.txt, as you asked."],
    ["rm -rf build", "delete the build folder", "Deleting build, as you asked."],
    ["rm -rf build/", "delete build/", "Deleting build/, as you asked."],
    ["rm *.log", "delete *.log", "Deleting *.log, as you asked."],
    ["rm /tmp/x.txt", "delete /tmp/x.txt", "Deleting /tmp/x.txt, as you asked."],
    ["echo x > notes.txt", "overwrite notes.txt with x", "Overwriting notes.txt, as you asked."],
    ["cp a.txt notes.txt", "replace notes.txt with a.txt", "Overwriting notes.txt, as you asked."],
    ["p4 submit -c 123", "submit changelist 123", "Submitting changelist 123 to Perforce, as you asked."],
    ["p4 submit", "submit my default changelist", "Submitting the default changelist to Perforce, as you asked."],
    ["p4 shelve -c 123", "shelve changelist 123", "Shelving changelist 123 in Perforce, as you asked."],
    ["p4 revert x.c", "revert x.c", "Reverting x.c in Perforce, as you asked."],
    ["p4 revert //...", "revert everything", "Reverting //... in Perforce, as you asked."],
    ["gh pr create --fill", "open a pull request", "Opening a pull request, as you asked."],
    ["gh pr merge 12", "merge pr 12", "Merging pull request 12, as you asked."],
    ["gh pr merge 12 --delete-branch", "merge pr 12 and delete the branch", "Merging pull request 12, as you asked."],
    ["npm publish", "publish this package", "Publishing this package, as you asked."],
    ["npm publish --tag beta", "publish this package as beta", "Publishing this package, as you asked."],
    ["docker push app:1.0", "push the app image", "Pushing the image app:1.0, as you asked."],
    ["npm install lodash", "install lodash", "Installing lodash, as you asked."],
    ["npm i -g typescript", "install typescript globally", "Installing typescript, as you asked."],
    ["systemctl restart nginx", "restart nginx", "Restarting nginx, as you asked."],
    ["scp report.pdf build-01:/tmp", "copy report.pdf to build-01", "Copying report.pdf to build-01, as you asked."],
    ["kill 1234", "kill 1234", "Stopping 1234, as you asked."],
    ["pkill node", "stop node", "Stopping node, as you asked."],
  ])("covers %j after %j", (cmd, words, want) => {
    expect(announce(cmd, words)).toBe(want);
  });

  it.each([
    // [command, words]: broader than named, or not named.
    ["git branch -D old-ui other", "delete the branch old-ui"],
    ["git branch -D old-ui", "delete old-ui"],
    ["git reset --hard origin/main", "discard my changes"],
    ["git checkout -- src/a.ts src/b.ts", "discard the changes to src/a.ts"],
    ["git clean -fdx", "clean untracked files"],
    ["git stash clear", "drop the stash"],
    ["rm -rf build/", "delete build"],
    ["rm -r build", "delete build"],
    ["rm notes.txt other.txt", "delete notes.txt"],
    ["rm *.log", "delete the logs"],
    ["rm /tmp/x.txt", "delete x.txt"],
    ["rm -rf .", "delete everything here"],
    ["rm -rf ..", "delete .. please"],
    ["rm link", "delete link"],
    ["echo x > notes.txt", "overwrite readme"],
    ["echo x > ~/.gitconfig", "overwrite .gitconfig"],
    ["p4 submit -c 123", "submit my changes"],
    ["p4 shelve -f -c 123", "shelve changelist 123"],
    ["p4 revert //...", "revert x.c"],
    ["gh pr create --base release", "open a pr"],
    ["gh pr merge 12 --admin", "merge pr 12"],
    ["gh pr merge 12 --delete-branch", "merge pr 12"],
    ["gh pr merge 13", "merge pr 12"],
    ["npm publish --tag beta", "publish this package"],
    ["npm publish --access public", "publish this package"],
    ["npm publish", "publish the package"],
    ["docker push other:1", "push the app image"],
    ["npm install lodash react", "install lodash"],
    ["npm i -g typescript", "install typescript"],
    ["pip install git+https://github.com/o/r.git", "install git+https://github.com/o/r.git"],
    ["systemctl enable nginx", "restart nginx"],
    ["sudo systemctl restart nginx", "restart nginx"],
    ["scp report.pdf build-02:/tmp", "copy report.pdf to build-01"],
    ["scp other.pdf build-01:/tmp", "copy report.pdf to build-01"],
    ["kill 1234 5678", "kill 1234"],
    ["pkill -f node", "stop python"],
  ])("asks for %j after %j", (cmd, words) => {
    expect(announce(cmd, words, { real: { "/home/ana/proj/link": "/etc/passwd" } })).toBeNull();
  });

  it("announces PowerShell's and cmd's own forms of a row", () => {
    expect(announce("Remove-Item -Recurse build", "delete the build folder", { where: "win32" })).toBe("Deleting build, as you asked.");
    expect(announce("Remove-Item -Recurse build", "delete build", { where: "win32" })).toBeNull();
    expect(announce("del notes.txt", "delete notes.txt", { where: "win32", shell: "cmd" })).toBe("Deleting notes.txt, as you asked.");
    expect(announce("rd /s /q build", "remove the build directory", { where: "win32", shell: "cmd" })).toBe("Deleting build, as you asked.");
    expect(announce("Set-Content notes.txt x", "overwrite notes.txt", { where: "win32" })).toBe("Overwriting notes.txt, as you asked.");
  });
});

describe("mentioned", () => {
  const findings = (cmd: string) => classifyCommand(cmd, "bash", contextOf("linux")).findings;
  it("is false when nothing in the words names the danger", () => {
    expect(mentioned(findings("rm notes.txt"), "fix the build")).toBe(false);
    expect(mentioned(findings("rm notes.txt"), "")).toBe(false);
    expect(mentioned(findings("git push origin main"), "run the tests")).toBe(false);
  });
  it("is true when the words name the verb and the object", () => {
    expect(mentioned(findings("rm notes.txt"), "delete notes.txt")).toBe(true);
    expect(mentioned(findings("git push origin main"), "push main")).toBe(true);
    expect(mentioned(findings("sudo apt install x"), "use sudo for it")).toBe(true);
  });
});
