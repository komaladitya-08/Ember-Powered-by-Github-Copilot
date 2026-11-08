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
    // A removal is said as one (commands-remote-r1).
    ["npm uninstall lodash", "uninstall lodash", "Removing lodash, as you asked."],
    ["pip uninstall requests", "remove requests", "Removing requests, as you asked."],
    ["git reset --hard origin/main", "reset hard to origin/main", "Moving the branch to origin/main and throwing away uncommitted changes, as you asked."],
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
    // Pruning is neither: it always asks (commands-remote-r1).
    ["npm prune", "install the dependencies"],
    ["npm prune", "remove the unused packages"],
    ["npm prune", "prune the packages"],
    // Nor is cleaning files out of the installed packages (commands-remote-r1).
    ["yarn autoclean --force", "install the dependencies"],
    ["yarn autoclean -F", "clean up node_modules"],
    // Words that install don't cover a removal, nor the other way round (commands-remote-r1).
    ["npm uninstall lodash", "install lodash"],
    ["npm install lodash", "uninstall lodash"],
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

  it("never announces a step on what the words leave out or keep, however they say it (found fixing commands-remote-r2-1)", () => {
    for (const words of [
      "delete everything but build/", "delete everything other than build/", "delete everything apart from build/",
      "delete everything aside from build/", "delete everything excluding build/", "delete everything besides build/",
      "delete dist/ instead of build/", "delete dist/ rather than build/", "delete dist/ and keep build/",
      "delete dist/ but leave build/", "delete dist/, leaving build/", "delete dist/ and spare build/",
    ]) expect(announce("rm -r build", words), words).toBeNull();
    expect(announce("git push origin main", "commit instead of pushing to main")).toBeNull();
    // What they asked for, without those words, is still announced.
    expect(announce("rm -r build", "delete build/")).not.toBeNull();
    expect(announce("rm -r build", "delete build/ and dist/")).not.toBeNull();
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
    ["rm -r build", "I wanted to delete build/ yesterday"],
    ["rm -r build", "do I want to delete build/?"],
    ["rm -r build", "I want to know how to delete build/"],
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
    ["rm -r build", "I want to delete build/", "Deleting build, as you asked."],
    ["rm -r build", "I need to delete build/", "Deleting build, as you asked."],
    ["rm -r build", "I'd like to delete build/", "Deleting build, as you asked."],
    ["rm -r build", "I would like to delete the build folder", "Deleting build, as you asked."],
    [PUSH, "I want to push feature-x to origin", "Pushing feature-x to origin, as you asked."],
    ["rm -r build", "go ahead and delete build/", "Deleting build, as you asked."],
    ["rm -r build", "fix line 12 in main.ts and delete build/", "Deleting build, as you asked."],
    ["rm -r build", "list the files, then delete build/", "Deleting build, as you asked."],
    ["rm -r build", "how big is build/? delete build/", "Deleting build, as you asked."],
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
    // A time ("in 5 minutes", "in a moment") names no folder, and holds the step back (commands-remote-c4-4).
    ["rm -r build", "delete build/ in 5 minutes", null],
    ["rm -r build", "delete build/ in one go", "Deleting build, as you asked."],
    ["rm -r build", "delete build/ in bulk", "Deleting build, as you asked."],
    ["echo x > notes.txt", "overwrite notes.txt in place", "Overwriting notes.txt, as you asked."],
    ["rm -r build", "delete the build folder in this repo", "Deleting build, as you asked."],
    // The home folder is a folder too: build/ there is not the task's build/ (commands-remote-c3-1).
    ["rm -r build", "delete build/ in my home folder", null],
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
    expect(said("rm -r build", "/home/ana", "delete build/ in my home folder")).toBe("Deleting build, as you asked.");
  });

  it("takes any word after \"in\" as the folder the path is in, so a path elsewhere asks (commands-remote-c3-1)", () => {
    for (const [cmd, words] of [
      ["rm -rf build", "delete the build folder in dist"],
      ["rm -rf build", "delete the build folder inside docs"],
      ["rm -rf build", "delete the build folder that is in dist"],
      ["rm -rf cache", "delete the cache folder in src"],
      ["echo x > notes.txt", "overwrite notes.txt in docs"],
    ]) expect(announce(cmd, words), `${cmd} / ${words}`).toBeNull();
    expect(announce("rm -rf dist/build", "delete the build folder in dist")).toBe("Deleting dist/build, as you asked.");
    expect(announce("rm -rf dist/build", "delete the build folder that is in dist")).toBe("Deleting dist/build, as you asked.");
    expect(announce("rm -rf src/cache", "delete the cache folder in src")).toBe("Deleting src/cache, as you asked.");
  });
});

describe("matchIntent: only what the asked-for verb acts on (commands-remote-c3-1)", () => {
  it.each([
    // [command, words]: the object is named, but only to say what it is, that it stays, or for another verb.
    ["rm -rf build", "Delete the old build folder in dist, build itself stays"],
    ["kill 1234", "kill 5678, 1234 is my editor"],
    ["kill 1234", "kill 5678 and 1234 is my editor"],
    ["kill 1234", "kill 5678 since 1234 is my editor"],
    ["kill 1234", "1234 is my editor; kill the stuck build"],
    ["pkill code", "kill the stuck build, code is my editor"],
    ["systemctl stop nginx", "stop apache and check nginx"],
    ["systemctl stop nginx", "stop apache, then look at nginx"],
    ["systemctl restart nginx", "restart apache, nginx is fine"],
    ["systemctl stop postgresql", "stop nginx; postgresql has to stay up"],
    ["systemctl stop postgresql", "stop nginx, postgresql must stay up"],
    ["systemctl stop apache", "restart apache and stop nginx"],
    ["git branch -D main", "delete the feature branch, main is sacred"],
    ["git branch -D main", "delete my old branches, main stays"],
    ["git branch -D main", "delete the feature branch, main's sacred"],
    ["git push origin feature-x main", "push feature-x to origin and pull main"],
    ["rm -r build dist", "delete build/ and dist/ is next"],
  ])("asks for `%s` after %j", (cmd, words) => {
    expect(announce(cmd, words, { git: FEATURE })).toBeNull();
  });

  it.each([
    // What the verb itself acts on still announces, listed after it or beside words about something else.
    ["kill 1234 5678", "kill 1234 and 5678", "Stopping 1234 and 5678, as you asked."],
    ["kill 1234", "kill 1234 which is stuck", "Stopping 1234, as you asked."],
    ["kill 1234", "kill 1234, 5678 is my editor", "Stopping 1234, as you asked."],
    ["rm -r build dist", "delete build/ and dist/", "Deleting build and dist, as you asked."],
    ["rm -r build dist", "delete build/, dist/", "Deleting build and dist, as you asked."],
    ["rm -r build dist", "delete the build folder and the dist folder", "Deleting build and dist, as you asked."],
    ["rm -r build", "delete build/ because it is huge", "Deleting build, as you asked."],
    ["rm -r build", "delete the build folder that is huge", "Deleting build, as you asked."],
    ["rm -r build", "delete build/ so I can rebuild it", "Deleting build, as you asked."],
    ["systemctl restart nginx", "restart nginx and check apache", "Restarting nginx, as you asked."],
    ["git branch -D old-ui", "delete the branch old-ui, main stays", "Deleting the branch old-ui, as you asked."],
    ["git clean -fdx", "clean untracked and ignored files", "Deleting untracked files, as you asked."],
  ])("announces `%s` after %j", (cmd, words, said) => {
    expect(announce(cmd, words, { git: FEATURE })).toBe(said);
  });
});

describe("matchIntent: a name that only places, describes or does something else (commands-remote-c3-1, r3-x1)", () => {
  it.each([
    // [command, words]: the name follows in, of, for, into or by, is the subject of another verb, or isn't the head.
    ["rm -rf frontend", "delete node_modules in the frontend folder"],
    ["rm -rf frontend", "delete the node_modules folder inside frontend"],
    ["rm -rf build", "delete the logs in the build folder"],
    ["rm -rf build", "delete the old logs inside the build folder"],
    ["rm -rf build", "delete the backup of the build folder"],
    ["rm -rf src", "delete the test files for the src folder"],
    ["rm -rf dist", "delete the build folder in dist"],
    ["rm -rf dist", "remove the build folder from dist"],
    ["rm -rf build", "in dist delete the build folder"],
    ["rm -rf build", "in dist, delete the build folder"],
    ["rm -rf build", "delete the build logs"],
    ["rm build", "delete the build logs"],
    ["rm -r build", "delete the folders that build creates"],
    ["git branch -D main", "delete the branches merged into main"],
    ["git branch -D main", "delete every branch that main already has"],
    ["kill 1234", "kill the children of 1234"],
    ["kill 1234", "kill the process that 1234 started"],
    ["kill 1234", "kill the processes started by 1234"],
    ["kill 1234", "kill 5678, the child of 1234"],
    ["kill 1234", "kill 5678, 1234 = my editor"],
    ["kill 1234", "kill 5678, 1234 my editor"],
    ["kill 1234", "kill 5678, 1234 started it"],
    ["kill 1234", "kill 5678 since 1234 depends on it"],
    ["systemctl restart nginx", "restart php-fpm, nginx depends on it"],
    ["systemctl stop nginx", "stop apache, nginx serves the site"],
    ["systemctl stop nginx", "stop apache since nginx serves the site"],
    ["systemctl stop nginx", "stop apache, nginx handles the traffic now"],
    ["systemctl stop nginx", "stop apache because nginx wants port 80"],
    ["systemctl stop nginx", "stop the service nginx forwards to"],
    ["kill 1234", "kill 1234's parent"],
    ["rm -rf build", "delete what's inside build/"],
    ["rm -rf build", "delete everything in build/"],
  ])("asks for `%s` after %j", (cmd, words) => {
    expect(announce(cmd, words, { git: FEATURE })).toBeNull();
  });

  it.each([
    // What the verb itself acts on, with words that place it, say how or name where it goes.
    ["rm -rf dist/build", "delete the build folder in dist", "Deleting dist/build, as you asked."],
    ["rm -rf dist/build", "in dist delete the build folder", "Deleting dist/build, as you asked."],
    ["rm -rf dist/build", "in dist, delete the build folder", "Deleting dist/build, as you asked."],
    ["rm -rf build", "delete build/ in the repo", "Deleting build, as you asked."],
    ["rm -rf build", "get rid of build/", "Deleting build, as you asked."],
    ["rm -rf build", "delete build/ completely, for me", "Deleting build, as you asked."],
    ["rm -rf build", "delete the old build folder that nobody uses", "Deleting build, as you asked."],
    ["kill 1234", "kill the process with pid 1234", "Stopping 1234, as you asked."],
    ["kill 1234", "kill 1234 now please", "Stopping 1234, as you asked."],
    ["systemctl stop nginx", "stop the nginx service", "Stopping nginx, as you asked."],
    ["npm uninstall lodash", "remove lodash from the frontend", "Removing lodash, as you asked."],
    ["npm install lodash", "install lodash for the frontend", "Installing lodash, as you asked."],
    ["git push origin feature-x", "push feature-x for review to origin", "Pushing feature-x to origin, as you asked."],
    ["git push origin feature-x", "push my feature-x changes to origin", "Pushing feature-x to origin, as you asked."],
    ["git checkout -- src/a.ts", "discard the changes in src/a.ts", "Discarding changes to src/a.ts, as you asked."],
    ["git clean -fd build", "clean the untracked files in build/", "Deleting untracked files, as you asked."],
    ["echo x > out.txt", "save the list in out.txt", "Overwriting out.txt, as you asked."],
    ["echo x > out.txt", "write the list into out.txt", "Overwriting out.txt, as you asked."],
    ["scp report.pdf build-01:/tmp", "copy report.pdf onto the build-01 server", "Copying report.pdf to build-01, as you asked."],
    ["git branch -D feature old", "delete the feature and old branches", "Deleting the branch feature and old, as you asked."],
    ["pkill node", "kill the node process that's hogging the CPU", "Stopping node, as you asked."],
    ["rm -rf build dist", "delete build/ and dist/ both", "Deleting build and dist, as you asked."],
    ["git push origin feature-x", "push feature-x up to origin", "Pushing feature-x to origin, as you asked."],
  ])("announces `%s` after %j", (cmd, words, said) => {
    expect(announce(cmd, words, { git: FEATURE })).toBe(said);
  });
});

describe("matchIntent: a pull request numbered anywhere in the words (commands-remote-v4-2)", () => {
  it.each([
    "look at pull request 45. merge the pr",
    "check pull request 45, then merge the pr",
    "review pr 45 and merge the pr",
    "pr 45 looks good. merge it",
  ])("asks for `gh pr merge` (the current branch's pull request) after %j", words => {
    expect(announce("gh pr merge", words)).toBeNull();
  });

  it("still announces a bare merge when the words number no pull request", () => {
    expect(announce("gh pr merge", "merge the pr")).toBe("Merging pull request, as you asked.");
  });
});

describe("matchIntent: the verb said again, or a list after a colon (commands-remote-v4-6)", () => {
  it.each([
    ["rm -rf build dist", "delete build/ and delete dist/", "Deleting build and dist, as you asked."],
    ["rm -rf build dist", "delete build/, then delete dist/", "Deleting build and dist, as you asked."],
    ["rm -rf build dist", "delete build/. Delete dist/ too.", "Deleting build and dist, as you asked."],
    ["rm -rf build dist", "delete these folders: build/ and dist/", "Deleting build and dist, as you asked."],
    ["kill 1234 5678", "kill 1234 and kill 5678", "Stopping 1234 and 5678, as you asked."],
    ["kill 1234 5678", "kill these processes: 1234 and 5678", "Stopping 1234 and 5678, as you asked."],
    ["npm install lodash react", "install lodash and install react", "Installing lodash and react, as you asked."],
    ["gh pr merge 45", "pr 45 looks good. merge it", "Merging pull request 45, as you asked."],
    ["gh pr merge 45", "check pr 45, then merge the pr", "Merging pull request 45, as you asked."],
    ["gh pr merge", "the pr looks good, merge it", "Merging pull request, as you asked."],
  ])("announces `%s` after %j", (cmd, words, said) => {
    expect(announce(cmd, words)).toBe(said);
  });

  it.each([
    // Each thing is still named where that very verb asks for it, and never by another verb or another pull request.
    ["systemctl restart apache", "stop apache and restart nginx"],
    ["npm install react lodash", "remove react and install lodash"],
    ["rm -rf build dist", "delete build/: dist/ stays"],
    ["kill 1234", "kill these processes: 1234 is my editor"],
    ["gh pr merge 45", "check pr 45 and pr 46, then merge the pr"],
    ["gh pr merge 45", "pr 45 is broken. merge pr 46"],
    ["gh pr merge 45", "check pr 45, then merge the other pr"],
  ])("asks for `%s` after %j", (cmd, words) => {
    expect(announce(cmd, words)).toBeNull();
  });
});

describe("matchIntent: words that hold the step back (commands-remote-c4-4)", () => {
  it.each([
    // [command, words]: a condition, a later time, asking to be asked, or a how-to the verb said again escapes.
    ["rm -rf src", "delete src/ only after I confirm"],
    ["rm -rf src", "delete src/ only if I say so"],
    ["rm -rf src", "delete src/ when I tell you"],
    ["rm -rf src", "delete src/ once the tests pass"],
    ["rm -rf src", "if the build fails, delete src/"],
    ["rm -rf src", "delete src/. Only if the tests pass, though."],
    ["rm -rf src", "delete src/ as soon as the build is done"],
    ["rm -rf src", "wait until the build finishes, then delete src/"],
    ["kill 1234", "kill 1234 if it hangs again"],
    ["kill 1234", "kill 5678; whatever you do, kill 1234 only if I say so"],
    ["rm -rf build", "delete build/ if it is over 1 GB"],
    ["rm -rf src", "delete src/ tomorrow"],
    ["rm -rf src", "next week, delete src/"],
    ["rm -rf src", "delete build/; delete src/ tomorrow"],
    ["rm -rf src", "delete src/ tonight"],
    ["rm -rf src", "delete src/ in 5 minutes"],
    ["rm -rf src", "delete src/ in a moment"],
    ["rm -rf src", "delete src/ at 5pm"],
    ["rm -rf src", "delete src/ on Friday"],
    ["rm -rf src", "delete src/ but ask me first"],
    ["rm -rf src", "delete src/, check with me before you do"],
    ["rm -rf src", "delete src/ when you have my go-ahead"],
    ["rm -rf src", "delete src/ after I've had a look"],
    ["rm -rf src", "delete src/ and let me check first"],
    ["rm -rf src", "delete src/, wait for my ok"],
    ["rm -rf src", "explain how to delete build/ and delete src/"],
    ["rm -rf src", "tell me how to delete build/, then delete src/"],
    ["git push origin feature-x", "explain how to push, and push feature-x to origin"],
    ["rm -rf dist", "delete build/ after dist/ finishes"],
  ])("asks for `%s` after %j", (cmd, words) => {
    expect(announce(cmd, words, { git: FEATURE })).toBeNull();
  });

  it.each([
    // Asking for the step now, with words that only ask for something else or say why, still announces.
    ["rm -rf src", "delete src/", "Deleting src, as you asked."],
    ["rm -rf src", "can you delete src/?", "Deleting src, as you asked."],
    ["rm -rf src", "delete src/ and tell me if anything goes wrong", "Deleting src, as you asked."],
    ["rm -rf src", "delete src/ and let me know when it's done", "Deleting src, as you asked."],
    ["rm -rf src", "delete src/ if you can", "Deleting src, as you asked."],
    ["rm -rf src", "delete src/ at once", "Deleting src, as you asked."],
    ["rm -rf src", "delete src/ now", "Deleting src, as you asked."],
    ["rm -rf src", "list the files; after that, delete src/", "Deleting src, as you asked."],
    ["rm -rf src", "delete src/ and explain why it was so big", "Deleting src, as you asked."],
    ["rm -rf src", "Explain how rm works. Then delete src/.", "Deleting src, as you asked."],
    ["rm -r build", "how big is build/? delete build/", "Deleting build, as you asked."],
    ["rm -r build dist", "delete build/ and dist/ in one go", "Deleting build and dist, as you asked."],
  ])("announces `%s` after %j", (cmd, words, said) => {
    expect(announce(cmd, words, { git: FEATURE })).toBe(said);
  });
});

describe("matchIntent: plain chains and a hung thing referred back to (commands-remote-r4-4)", () => {
  it.each([
    ["systemctl stop nginx", "stop apache, then nginx", "Stopping nginx, as you asked."],
    ["systemctl stop nginx", "stop apache and then nginx", "Stopping nginx, as you asked."],
    ["systemctl stop nginx", "stop apache. nginx too.", "Stopping nginx, as you asked."],
    ["rm -rf build dist", "delete build/, then dist/", "Deleting build and dist, as you asked."],
    ["rm -rf dist", "delete build/. dist/ as well.", "Deleting dist, as you asked."],
    ["kill 1234", "1234 is hung, kill it", "Stopping 1234, as you asked."],
    ["kill 1234", "1234 is frozen. kill it", "Stopping 1234, as you asked."],
    ["systemctl restart nginx", "nginx is stuck, restart it", "Restarting nginx, as you asked."],
    ["systemctl restart nginx", "the nginx service seems hung, please restart it", "Restarting nginx, as you asked."],
  ])("announces `%s` after %j", (cmd, words, said) => {
    expect(announce(cmd, words)).toBe(said);
  });

  it.each([
    // Another verb, something said of the thing, a question, or "it" for something that isn't hung.
    ["systemctl stop nginx", "stop apache, then look at nginx"],
    ["systemctl stop nginx", "stop apache, then nginx is fine"],
    ["systemctl stop nginx", "stop apache, then nginx restarts itself"],
    ["systemctl stop nginx", "stop apache. nginx too?"],
    ["kill 1234", "1234 is my editor, kill it"],
    ["kill 1234", "1234 is hung and 5678 is my editor, kill it"],
    ["kill 1234", "1234 is hung. 5678 is fine. kill it"],
    ["systemctl restart nginx", "nginx is fine, restart it"],
    ["kill 1234", "1234 is hung, kill 5678 and leave it"],
  ])("asks for `%s` after %j", (cmd, words) => {
    expect(announce(cmd, words)).toBeNull();
  });
});

describe("matchIntent: things kept together, and a folder named after a comma (commands-remote-v4-3)", () => {
  it.each([
    // What is said of the last thing listed is said of every thing listed with it.
    ["git branch -D main", "delete my old branches, main and develop stay"],
    ["kill 1234", "kill 5678, 1234 and 4321 are my editors"],
    ["systemctl stop nginx", "stop apache, nginx and postgres are fine"],
    // The folder the path must be in, after a comma, in brackets, after "from" or before the name.
    ["rm -rf build", "delete the build folder, which is in dist"],
    ["rm -rf build", "delete the build folder, it's in dist"],
    ["rm -rf build", "delete the build folder, it\u2019s in dist"],
    ["rm -rf build", "delete the build folder (the one in dist)"],
    ["rm -rf build", "delete the build folder from dist"],
    ["rm -rf build", "delete dist's build folder"],
  ])("asks for `%s` after %j", (cmd, words) => {
    expect(announce(cmd, words, { git: FEATURE })).toBeNull();
  });

  it.each([
    ["kill 1234", "kill 1234, 5678 and 4321 are my editors", "Stopping 1234, as you asked."],
    ["git branch -D old-ui", "delete the branch old-ui, main and develop stay", "Deleting the branch old-ui, as you asked."],
    // "they" and "both" stand for what the verb acts on, not something else.
    ["rm -rf build dist", "delete build/ and dist/, they are huge", "Deleting build and dist, as you asked."],
    ["rm -rf build dist", "delete build/ and dist/, both are huge", "Deleting build and dist, as you asked."],
    ["rm -rf dist/build", "delete the build folder, which is in dist", "Deleting dist/build, as you asked."],
    ["rm -rf dist/build", "delete the build folder (the one in dist)", "Deleting dist/build, as you asked."],
    ["rm -rf dist/build", "delete the build folder from dist", "Deleting dist/build, as you asked."],
    ["rm -rf dist/build", "delete dist's build folder", "Deleting dist/build, as you asked."],
    ["rm -rf build", "delete build/ from the repo", "Deleting build, as you asked."],
    ["rm -rf build", "delete the project's build folder", "Deleting build, as you asked."],
  ])("announces `%s` after %j", (cmd, words, said) => {
    expect(announce(cmd, words, { git: FEATURE })).toBe(said);
  });
});
