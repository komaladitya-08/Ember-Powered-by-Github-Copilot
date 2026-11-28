/**
 * The Changes and Plan tabs' words (app/renderer/code/copy-changes.ts, copy-plan.ts): pinned, in sentence case with
 * curly quotes round names, straight apostrophes, "…" on what opens something, and never the SDK's own text.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as W from "../../app/renderer/code/copy-changes";
import * as P from "../../app/renderer/code/copy-plan";

const read = (f: string) => fs.readFileSync(path.resolve(f), "utf8");

describe("the Changes tab's words", () => {
  it("names the diff's modes and counts what changed", () => {
    expect(Object.values(W.MODE_NAMES)).toEqual(["This session", "Uncommitted", "Against the branch"]);
    expect(W.changesSummary(4, 8, 2)).toBe("4 files changed: 8 lines added, 2 removed.");
    expect(W.changesSummary(1, 1, 0)).toBe("1 file changed: 1 line added, 0 removed.");
    expect(W.changesSummary(0, 0, 0)).toBe("");
    expect(W.counts(1_200, 3)).toBe("+1,200 −3");
  });

  it("says plainly when there is nothing, and why the session's own changes can't be shown", () => {
    expect(W.noChanges("session")).toBe("Copilot hasn't changed any files in this session yet.");
    expect(W.noChanges("unstaged")).toBe("There are no uncommitted changes.");
    expect(W.noChanges("branch", "main")).toBe("Nothing differs from “main”.");
    expect(W.fallbackWords("session", "unstaged", "file-change-tracking-disabled")).toBe("This session didn't track its file changes from its first turn, so its own changes and rewinding files aren't available. Showing uncommitted changes instead.");
    expect(W.fallbackWords("branch", "unstaged")).toBe("Ember couldn't compare with the branch. Showing uncommitted changes instead.");
    expect(W.readFailed("changes", "That session isn't open. Open it again first.")).toBe("Ember couldn't read the changes. That session isn't open. Open it again first.");
  });

  it("names a file and a line for a screen reader, never by colour", () => {
    expect(W.fileLabel("src/a.ts", "added", 4, 0)).toBe("src/a.ts: added, 4 lines added, 0 removed");
    expect(W.fileLabel("docs/new.md", "renamed", 0, 0, "docs/old.md")).toBe("docs/new.md: renamed, from docs/old.md, 0 lines added, 0 removed");
    expect(W.lineLabel("del", 41, "const r = 1;")).toBe("Removed, line 41: const r = 1;");
    expect(W.lineLabel("ctx", 7, "")).toBe("Unchanged, line 7: blank");
    expect(W.commentOn("lines 41–43")).toBe("Comment on lines 41–43…");
  });

  it("is honest that git actions are messages to Copilot", () => {
    expect([W.COMMIT, W.PUSH, W.PULL_REQUEST]).toEqual(["Commit…", "Push", "Open a pull request…"]);
    expect(W.GIT_HINT).toBe("These ask Copilot to do it: each sends a message, and Copilot asks before it runs anything, as for any command.");
  });

  it("warns that a rewind doesn't undo commands, and words each outcome in its own sentence", () => {
    expect(W.COMMANDS_NOT_UNDONE).toBe("Commands Copilot already ran are not undone: anything they changed outside the files it tracked, such as installed packages, a commit or a push, stays.");
    expect(Object.values(W.REWIND_MODES)).toEqual(["Conversation only", "Conversation and files"]);
    expect(W.rewindDone({ outcome: "success", restored: ["/a", "/b"], skipped: [] })).toBe("Rewound. 2 files were put back.");
    expect(W.rewindDone({ outcome: "success", restored: [], skipped: [{ path: "/c", reason: "user-modified" }] })).toBe("Rewound. 1 file was left as it is: you changed it since, or Copilot didn't keep how it was.");
    expect(W.rewindDone({ outcome: "session-busy", restored: [], skipped: [] })).toBe(W.REWIND_BUSY);
    expect(W.rewindDone({ outcome: "files-rolled-back", restored: [], skipped: [] })).toBe("Nothing was rewound: putting the files back failed, so they were left as they were, and so was the conversation.");
    expect(W.unavailableRewind("file-change-tracking-disabled")).toBe("This session didn't track its file changes from its first turn, so it can't be rewound here.");
    expect(W.pointChanges(2, 7, 1)).toBe("2 files changed from here on, +7 −1");
    expect(W.pointTime(Date.parse("2026-11-27T10:00:00"), Date.parse("2026-11-27T18:00:00"))).toBe(new Date(Date.parse("2026-11-27T10:00:00")).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
    expect(W.pointTime(Number.NaN)).toBe("");
  });
});

describe("both tabs' words", () => {
  it("use straight apostrophes, curly quotes, no tracked capitals and no raw error words", () => {
    for (const [file, mod] of [["copy-changes.ts", W], ["copy-plan.ts", P]] as const) {
      const src = read(`app/renderer/code/${file}`);
      expect(src, file).not.toMatch(/’/);
      expect(src, file).not.toMatch(/\.\.\./);
      for (const value of Object.values(mod)) {
        const strings = typeof value === "string" ? [value] : typeof value === "object" && value ? Object.values(value).filter((v): v is string => typeof v === "string") : [];
        for (const s of strings) {
          expect(s, s).not.toMatch(/"[^"]+"/);
          expect(s, s).not.toMatch(/\b[A-Z]{4,}\b/);
          expect(s, s).not.toMatch(/error|exception|undefined|null/i);
        }
      }
    }
  });
});
