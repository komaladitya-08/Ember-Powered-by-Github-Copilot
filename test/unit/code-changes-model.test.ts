/**
 * The Changes tab's logic (app/renderer/code/changes-model.ts): the SDK's diff, rewind points, preview and outcome read
 * field by field; line ranges and the review message they become; and the prompts the git buttons send.
 */
import { describe, expect, it } from "vitest";
import { diffRows } from "../../app/renderer/shared/diff-rows";
import {
  addComment, busyIn, commitPrompt, diffFrom, editComment, historyChanged, linesWords, previewFrom, pullRequestPrompt, PUSH_PROMPT, rangeOf,
  removeComment, REVIEW_MAX, reviewPrompt, rewindPointsFrom, rewindResultFrom, shownPath, wantRebuild, type ReviewComment,
} from "../../app/renderer/code/changes-model";
import { EMPTY_STATE } from "../../app/renderer/code/store";
import { EMPTY_TRANSCRIPT } from "../../app/renderer/code/transcript";

const DIFF = "--- a/src/login.ts\n+++ b/src/login.ts\n@@ -40,4 +40,5 @@ x\n   a();\n-  const r = \"/\";\n+  const n = next();\n+  const r = n;\n   b();\n";

describe("the session's diff", () => {
  it("reads each file with its status and counts, and the totals", () => {
    const v = diffFrom({ requestedMode: "session", mode: "session", isFallback: false, changes: [
      { path: "src/login.ts", changeType: "modified", diff: DIFF },
      { path: "docs/new.md", oldPath: "docs/old.md", changeType: "renamed", diff: "" },
      { path: "vendor/huge.js", changeType: "modified", diff: "", isTruncated: true },
      { path: "x", changeType: "copied", diff: "" },
      { nope: 1 },
    ] }, "session")!;
    expect(v.files.map(f => [f.path, f.status, f.added, f.removed, f.truncated])).toEqual([
      ["src/login.ts", "modified", 2, 1, false], ["docs/new.md", "renamed", 0, 0, false], ["vendor/huge.js", "modified", 0, 0, true], ["x", "other", 0, 0, false],
    ]);
    expect(v.files[1].oldPath).toBe("docs/old.md");
    expect([v.added, v.removed, v.fallback]).toEqual([2, 1, false]);
  });

  it("says when the SDK answered in another mode, and why, and the base branch", () => {
    const v = diffFrom({ requestedMode: "session", mode: "unstaged", isFallback: true, unavailableReason: "file-change-tracking-disabled", changes: [] }, "session")!;
    expect([v.requested, v.mode, v.fallback, v.unavailable]).toEqual(["session", "unstaged", true, "file-change-tracking-disabled"]);
    expect(diffFrom({ requestedMode: "branch", mode: "branch", baseBranch: "main", isFallback: false, changes: [] }, "branch")!.baseBranch).toBe("main");
    expect(diffFrom({ mode: "session", changes: [], unavailableReason: "something-new" }, "session")!.unavailable).toBe("other");
  });

  it("is nothing for a shape that isn't a diff", () => {
    expect(diffFrom(null, "session")).toBeNull();
    expect(diffFrom({ changes: "x" }, "session")).toBeNull();
  });

  it("shows a path inside the session's folder relative to it, and any other as it came", () => {
    expect(shownPath("/home/me/app/src/a.ts", "/home/me/app/")).toBe("src/a.ts");
    expect(shownPath("/home/me/apple/a.ts", "/home/me/app")).toBe("/home/me/apple/a.ts");
    expect(shownPath("C:\\work\\app\\a.ts", "C:\\work\\app")).toBe("a.ts");
    expect(shownPath("src/a.ts", undefined)).toBe("src/a.ts");
  });
});

describe("line comments", () => {
  const rows = diffRows(DIFF).rows.filter(r => r.kind !== "file");
  // rows: hunk, ctx 40, del 41, add 41, add 42, ctx 43(44)
  it("takes a range either way round, new lines by their number and removed ones by the old", () => {
    expect(rangeOf("src/login.ts", rows, 4, 2)).toEqual({ file: "src/login.ts", newLines: [41, 42], oldLines: [41, 41], quoted: ["-  const r = \"/\";", "+  const n = next();", "+  const r = n;"] });
    expect(rangeOf("f", rows, 1, 1)).toEqual({ file: "f", newLines: [40, 40], quoted: ["   a();"] });
    expect(rangeOf("f", rows, 2, 2)).toEqual({ file: "f", oldLines: [41, 41], quoted: ["-  const r = \"/\";"] });
    expect(rangeOf("f", rows, 0, 0)).toBeNull();
  });

  it("words lines as people say them", () => {
    expect(linesWords({ newLines: [41, 43] })).toBe("lines 41–43");
    expect(linesWords({ newLines: [7, 7] })).toBe("line 7");
    expect(linesWords({ newLines: [41, 42], oldLines: [41, 41] })).toBe("lines 41–42 and removed line 41");
  });

  it("keeps a review's comments: added trimmed, edited, removed, an emptied one dropped, at most fifty", () => {
    const c = (id: string, text: string): ReviewComment => ({ id, file: "a.ts", newLines: [1, 1], quoted: ["+x"], text });
    let list = addComment([], c("1", "  Fix this. "));
    expect(list[0].text).toBe("Fix this.");
    expect(addComment(list, c("2", "   "))).toHaveLength(1);
    list = addComment(list, c("2", "And this."));
    expect(editComment(list, "1", "Better.").map(x => x.text)).toEqual(["Better.", "And this."]);
    expect(editComment(list, "1", " ").map(x => x.id)).toEqual(["2"]);
    expect(removeComment(list, "2").map(x => x.id)).toEqual(["1"]);
    const full = Array.from({ length: REVIEW_MAX }, (_, i) => c(String(i), "x"));
    expect(addComment(full, c("z", "one more"))).toHaveLength(REVIEW_MAX);
  });

  it("sends the review as one structured message: each file, its lines, the lines quoted and the comment", () => {
    const text = reviewPrompt([
      { id: "1", file: "src/login.ts", newLines: [41, 42], oldLines: [41, 41], quoted: ["-old", "+new"], text: "Keep the fallback." },
      { id: "2", file: "README.md", newLines: [3, 3], quoted: ["+```js"], text: "Close the fence." },
    ], "session");
    expect(text).toBe([
      "Please address my review comments on the changes made in this session. Each comment names a file, the lines it is about (line numbers are the new version's; removed lines use the old version's numbers) and quotes those lines from the diff. Change the code where a comment asks for it, and tell me what you changed.",
      "1. src/login.ts, lines 41–42 and removed line 41\n```diff\n-old\n+new\n```\nComment: Keep the fallback.",
      "2. README.md, line 3\n````diff\n+```js\n````\nComment: Close the fence.",
    ].join("\n\n"));
    expect(reviewPrompt([{ id: "1", file: "a", newLines: [1, 50], quoted: Array.from({ length: 50 }, () => "+x"), text: "t" }], "unstaged"))
      .toContain("uncommitted changes");
    expect(reviewPrompt([{ id: "1", file: "a", newLines: [1, 50], quoted: Array.from({ length: 50 }, () => "+x"), text: "t" }], "branch")).toContain("… 10 more lines\n```");
  });
});

describe("rewinding", () => {
  it("lists the points newest first, with what changed from each on", () => {
    const l = rewindPointsFrom({ fileChangeTrackingEnabled: true, points: [
      { eventId: "e1", userMessage: "First", timestamp: "2026-11-27T10:00:00Z", canRestoreFiles: true, fileCount: 2, turnChangedFiles: false, linesAdded: 7, linesRemoved: 1, isAutopilotContinuation: false },
      { eventId: "e9", userMessage: "Second", timestamp: "bad", canRestoreFiles: false, fileCount: 0, turnChangedFiles: false, linesAdded: 0, linesRemoved: 0, isAutopilotContinuation: true },
      { userMessage: "no id" },
    ] })!;
    expect(l.tracking).toBe(true);
    expect(l.points.map(p => [p.eventId, p.message, p.canRestoreFiles, p.fileCount, p.added, p.removed, p.autopilot])).toEqual([["e9", "Second", false, 0, 0, 0, true], ["e1", "First", true, 2, 7, 1, false]]);
    expect(Number.isNaN(l.points[0].at)).toBe(true);
    expect(rewindPointsFrom({ fileChangeTrackingEnabled: false, unavailableReason: "file-change-tracking-disabled", points: [] })).toEqual({ tracking: false, unavailable: "file-change-tracking-disabled", points: [] });
    expect(rewindPointsFrom("x")).toBeNull();
  });

  it("reads a preview's files, and why files can't be put back", () => {
    expect(previewFrom({ available: true, fileCount: 1, files: [{ path: "/a/b.ts", changeType: "created", linesAdded: 4, linesRemoved: 0 }] }))
      .toEqual({ available: true, files: [{ path: "/a/b.ts", change: "created", added: 4, removed: 0 }] });
    expect(previewFrom({ available: false, reason: "session-busy", fileCount: 0, files: [] })).toEqual({ available: false, reason: "session-busy", files: [] });
  });

  it("reads an outcome without the SDK's error text, and knows when the conversation was cut", () => {
    const r = rewindResultFrom({ outcome: "success", eventsRemoved: 4, restoredFiles: ["/a"], skippedFiles: [{ path: "/b", reason: "user-modified" }, { path: "/c", reason: "new" }], error: "internal" });
    expect(r).toEqual({ outcome: "success", restored: ["/a"], skipped: [{ path: "/b", reason: "user-modified" }, { path: "/c", reason: "other" }] });
    expect(historyChanged(r)).toBe(true);
    expect(historyChanged(rewindResultFrom({ outcome: "snapshot-prune-failed" }))).toBe(true);
    for (const o of ["session-busy", "files-rolled-back", "truncation-failed", "made-up"]) expect(historyChanged(rewindResultFrom({ outcome: o }))).toBe(false);
  });

  it("marks the transcript to be drawn again from the whole history, as the store does on a rewind's event", () => {
    const s = { ...EMPTY_STATE, transcripts: { s1: { ...EMPTY_TRANSCRIPT, lastSeq: 9 } } };
    const next = wantRebuild(s, "s1");
    expect(next.transcripts.s1).toMatchObject({ stale: true, rebuild: true, lastSeq: 9 });
    expect(next.resync).toEqual(["s1"]);
    expect(wantRebuild(next, "s1").resync).toEqual(["s1"]);
    expect(wantRebuild(s, "nope")).toBe(s);
  });

  it("knows a turn is under way from the row or the transcript", () => {
    const s = { ...EMPTY_STATE, transcripts: { s1: { ...EMPTY_TRANSCRIPT, busy: true } } };
    expect(busyIn(s, "s1")).toBe(true);
    expect(busyIn(EMPTY_STATE, "s1")).toBe(false);
  });
});

describe("git, through Copilot", () => {
  it("asks Copilot to commit with the person's message, or to write one, and never to push", () => {
    expect(commitPrompt("  Fix the redirect\n\nReads next. ")).toBe("Please commit the current changes in this repository with this commit message:\n\nFix the redirect\n\nReads next.\n\nStage what belongs in the commit first, and leave out anything that shouldn't be committed (build output, secrets). Don't push.");
    expect(commitPrompt("")).toContain("write a clear commit message");
    expect(commitPrompt("")).toContain("Don't push.");
    expect(PUSH_PROMPT).toContain("Don't force-push.");
  });

  it("asks for a pull request with the title and notes given, or for Copilot's own", () => {
    expect(pullRequestPrompt("Return to where people were", "")).toContain("Use this title: Return to where people were");
    expect(pullRequestPrompt("", "")).toContain("Write a short title");
    expect(pullRequestPrompt("", "Fixes #12")).toContain("Use these notes in its description:\n\nFixes #12");
  });
});
